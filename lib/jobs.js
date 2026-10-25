// Agent supervision over the Hermes HTTP Runs API.
//
// The panel used to spawn `hermes chat -q --format stream-json` and read its stdout. That gave
// fire-and-forget plus a transcript, but no handle on a LIVE turn: nothing could course-correct an
// agent that had already started, and every run died with the panel. The Runs API on the gateway's
// api_server replaces the child process with something addressable:
//
//   POST /v1/runs                 -> {run_id} at once; the run outlives this request
//   GET  /v1/runs/{id}/events     -> SSE: tool.started(tool,preview) / tool.completed(tool,duration,
//                                    error,preview) / message.delta(delta) / message.interim(text,
//                                    already_streamed) / approval.request / subagent.* / run.*
//   POST /v1/runs/{id}/steer      -> {"input": "..."} injected at the next tool boundary
//   POST /v1/runs/{id}/stop       -> cooperative interrupt
//   GET  /v1/runs/{id}            -> status, output, usage, pending_steer
//
// Verified live before this was written; see docs/runs-api-phase0.md for the probe, and
// docs/hermes-runs-api-patch.md for the five per-run knobs the stock API does not carry (cwd,
// max_turns, run_budget are sent below; a gateway without the patch ignores them).
//
// Two jobs the CLI used to do and the panel now owns:
//   * the worktree. `hermes -w` made one; here the panel runs `git worktree add` and hands the path
//     to the run as `cwd`.
//   * the thread. `-c <name>` resumed a named session; the Runs API continues on `session_id`, so a
//     panel thread name is now the session id, unchanged.
import { usageStats, sessionUsage, sessionIndex, toolSecondsFromLines } from "./session-usage.js";
import { unwrapToolText } from "./tool-text.js";
import { completionPayload, outcomeFrom, readReport } from "./completion.js";
import { HermesTransport } from "./hermes-transport.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const pexec = promisify(execFile);
const MAX_LINES = 600;
const TAIL = 60;
const KEEP_JOBS = 80; // persisted conversations, newest first
let lineSeq = 0;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);

// The gateway's own waiting window for a parked approval, mirrored from
// `tools/approval_context._get_approval_timeout` (`config.get("timeout", 300)`, clamped to the platform-safe
// ceiling). lib/hermes-config.js reads the configured value as APPROVAL_TIMEOUT_DEFAULT; this copy is what is
// left when the panel has no reader wired (a bare Jobs in a test) or the file cannot be read at all — and it is
// duplicated rather than imported because hermes-config.js imports THIS module.
const APPROVAL_WINDOW_DEFAULT = 300;

// A URL is a deliverable like a file, and a busy run can announce a lot of them (a dev server, its HMR
// socket, the docs it printed). Enough to be useful, few enough that the popup stays a list.
const MAX_URL_ARTIFACTS = 24;

// Hosts that are a service on this box or this network, never a page someone merely linked.
const LOCAL_HOST = /^(localhost|0\.0\.0\.0|\[::1\]|::1|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9][a-z0-9.\-]*\.(?:local|internal|test|localhost))$/i;

// A URL that names a port, a loopback/private host or a `.local` name is an endpoint. Tool output is full of
// documentation links, so it is held to this test; the agent's own prose is not.
function isEndpointLike(raw) {
  try {
    const u = new URL(String(raw));
    if (u.port) return true;
    return LOCAL_HOST.test(u.hostname);
  } catch {
    return false;
  }
}
const TERMINAL_STATUS = { completed: "done", failed: "failed", cancelled: "cancelled", interrupted: "interrupted" };

// ---- the files an agent produced for the reader ---------------------------------------
// The card offers a "N files" button for things the reader is about to OPEN — a markdown doc, a SQL
// script, a key — not for the source an agent edits in place. Two sources feed it:
//   1. a `write_file` result, which reports {resolved_path, bytes_written};
//   2. at the end of a turn, the untracked files git reports in the run's directory, because an agent
//      that writes with `cat > x.sql` or `sqlplus @script` emits no write_file event at all.
// Extensions decide what counts: a .ts file an agent created is code, a .md/.sql/.key is a deliverable.
const ARTIFACT_EXT = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc",
  ".sql", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".ini", ".conf", ".properties",
  ".key", ".pem", ".crt", ".cer", ".pub", ".p12", ".env",
  ".sh", ".ps1", ".bat", ".cmd", ".log", ".diff", ".patch",
]);

function isArtifactPath(file) {
  const p = String(file || "").replace(/\\/g, "/");
  if (!p) return false;
  if (/\/(node_modules|\.git)\//i.test(p)) return false;
  return ARTIFACT_EXT.has(path.extname(p).toLowerCase());
}

// ---- the gateway this panel talks to -------------------------------------------------
// api_server is a Hermes gateway platform: it must be running, and it holds the provider
// credentials. Nothing here spawns an agent, so a stopped gateway is a clear failure at submit
// rather than a half-started child that dies silently.
// A turn's attachments, trimmed to what the card needs to draw a link: the path is the identity, the
// name is what is shown, and the type/size exist only for the tooltip.
export function normaliseAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.path === "string" && a.path.trim())
    .slice(0, 12)
    .map((a) => ({
      path: String(a.path).trim(),
      name: String(a.name || path.basename(String(a.path).trim())).slice(0, 160),
      type: typeof a.type === "string" ? a.type.slice(0, 80) : "",
      bytes: Number(a.bytes) || 0,
    }));
}

export function hermesHome() {
  const env = process.env.HERMES_HOME;
  if (env && !env.startsWith("/")) return env; // an MSYS-shaped home is a mistake, not a path
  const local = process.env.LOCALAPPDATA || process.env.HOME || "";
  return path.join(local, "hermes");
}

function readKeyFromEnvFile() {
  try {
    const envPath = path.join(hermesHome(), ".env");
    if (!existsSync(envPath)) return null;
    const m = /^\s*API_SERVER_KEY\s*=\s*(.+?)\s*$/m.exec(readFileSync(envPath, "utf8"));
    if (!m) return null;
    return m[1].trim().replace(/^["']|["']$/g, "") || null;
  } catch {
    return null;
  }
}

export function apiConfig(config = {}) {
  const api = config.apiServer || {};
  const url = String(api.url || process.env.API_SERVER_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
  return { url, key: api.key || process.env.API_SERVER_KEY || null };
}

// The last moment a turn was seen working: the newest line the store kept, or its start when it printed nothing.
// This is where an interrupted turn's clock stops — the panel never saw more than this.
function lastSeenIso(j) {
  const last = (j.lines || []).reduce((a, l) => Math.max(a, Number(l?.at) || 0), 0);
  return new Date(last || Date.parse(j.startedAt || "") || Date.now()).toISOString();
}

// ---- preview ------------------------------------------------------------------------
// There is no command line any more, so a preview shows the request that will be sent.
export function previewRequest(o = {}) {
  const body = { input: String(o.prompt ?? "") };
  if (o.thread) body.session_id = String(o.thread);
  if (o.cwd) body.cwd = String(o.cwd);
  if (o.model) body.model = String(o.model);
  if (o.maxTurns) body.max_turns = Number(o.maxTurns);
  if (o.budget) body.run_budget = Number(o.budget);
  return { method: "POST", path: "/v1/runs", body };
}

export function makeThreadName(prompt) {
  const slug = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/, "");
  return `wtgui-${slug || "agent"}-${randomUUID().slice(0, 6)}`;
}

// ---- line rendering -----------------------------------------------------------------
// Panels render plain text; a model can still emit ANSI colour inside tool output.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s) => String(s ?? "").replace(ANSI_RE, "");

const MAX_TOOL_LINES = 40;
const MAX_TOOL_LINE_CHARS = 400;

// The backslash, and the lines of a block of text, both built from character codes rather than written as
// escape sequences: an escape that lands wrong in a regex literal here is a `SyntaxError` for the whole
// panel, and the tree measurement below parses `git worktree list --porcelain` by hand.
const BS = String.fromCharCode(92);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const cleanPath = (s) => String(s || "").split(BS).join("/").replace(/[/]+$/, "");
const linesOf = (text) => String(text || "").split(LF).map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l));

// tool.completed carries the result as a preview (a JSON envelope for terminal, a diff for patch, plain
// text otherwise). Unwrap the envelope and hand the first lines to the console so a reader sees what the
// tool actually said instead of a bare "tool · 1.2s" — the envelope itself is never drawn: the gateway
// caps it (~500 chars, "..." appended), so it is usually cut mid-string, and braces plus literal \n in a
// console are bytes nobody reads. The unwrapping is shared with the session-store path (lib/tool-text.js)
// so a live preview and a stored result read the same way.
function toolResultLines(tool, preview, { duration, error } = {}) {
  const unwrapped = unwrapToolText(preview);
  let body = [unwrapped.text, unwrapped.notes.length ? `(${unwrapped.notes.join(" · ")})` : ""].filter(Boolean).join("\n");
  const all = body.split(String.fromCharCode(10)).filter((l, idx, arr) => l.trim() || (idx > 0 && idx < arr.length - 1));
  const shown = all.slice(0, MAX_TOOL_LINES).map((l) => l.slice(0, MAX_TOOL_LINE_CHARS));
  const meta = [duration ? `${Number(duration).toFixed(2)}s` : null, error ? "error" : null].filter(Boolean).join(" · ");
  const out = [{ kind: "tool-out", text: `  ↳ ${tool || "tool"}${meta ? ` · ${meta}` : ""}` }];
  for (const l of shown) out.push({ kind: "tool-out", text: l });
  if (all.length > shown.length) out.push({ kind: "tool-out", text: `… ${all.length - shown.length} more line(s)` });
  // Say it out loud rather than letting a cut payload look like the whole answer.
  if (unwrapped.truncated) out.push({ kind: "tool-out", text: "… result truncated by the gateway — the live stream carries a preview of a tool result, not all of it" });
  return out;
}

// One glyph per tool, taken from the Hermes registry so a tool looks the same in the CLI and here
// (read_file 📖, terminal 💻, patch 🔧). Unknown tools fall back by family — a glyph that is wrong is
// worse than a generic one — and then to the CLI's own default, ⚡.
const TOOL_GLYPHS = {
  read_file: "📖", write_file: "✍️", patch: "🔧", search_files: "🔎",
  terminal: "💻", read_terminal: "🖥️", close_terminal: "🖥️", execute_code: "🐍",
  browser_exec: "🌐", browser_cdp: "🧪", browser_dialog: "💬", browser_vault: "🔐",
  web_search: "🔍", web_extract: "📄", session_search: "🔍",
  delegate_task: "🔀", todo_list: "📋", process_manage: "⚙️", memory: "🧠",
  skill_view: "📚", skills_list: "📚", skill_manage: "📝", clarify: "❓",
  cronjob_manage: "⏰", manage_connections: "🔗", manage_catalog: "🧩",
  text_to_speech: "🔊", vision_analyze: "👁️", video_analyze: "🎬", video_generate: "🎬",
  image_generate: "🎨", computer_use: "🖱️", tool_search: "🧰", tool_describe: "🧰", tool_call: "🧰",
  annotate_preview: "🔖", desktop_preview: "🖼️", documents: "📄",
};

const TOOL_GLYPH_FAMILIES = [
  [/^mcp__/, "🧩"],
  [/^browser/, "🌐"],
  [/^skill/, "📚"],
  [/^(web_|.*_search$)/, "🔍"],
  [/^tool_/, "🧰"],
];

export function toolGlyph(tool) {
  const name = String(tool || "").toLowerCase();
  if (!name) return "⚡";
  const known = TOOL_GLYPHS[name] || TOOL_GLYPHS[name.replace(/^mcp__.*?__/, "")];
  if (known) return known;
  for (const [re, glyph] of TOOL_GLYPH_FAMILIES) if (re.test(name)) return glyph;
  return "⚡";
}

// The gateway appends a messaging-surface hint to a clarify question ("Reply \"skip\" to skip this
// question.") because the API server counts as a chat platform. The panel's box has its own controls and
// its own note, so the hint is noise — in the question box AND in the console line that records it.
const CLARIFY_HINT = /\n?\s*Reply\s+["']?skip["']?\s+to skip this question\.?\s*$/i;
export function clarifyText(text) {
  return String(text ?? "").replace(CLARIFY_HINT, "").trim();
}

// One SSE event -> the console lines the browser already knows how to draw.
function linesForEvent(evt) {
  switch (evt.event) {
    case "tool.started": {
      const p = typeof evt.preview === "string" ? evt.preview.replace(/\s+/g, " ").trim().slice(0, 240) : "";
      // The glyph leads the line, the way the CLI prints a call; the arrow is kept only in history
      // written before glyphs, which the browser still parses.
      return [{ kind: "tool", text: `${toolGlyph(evt.tool)} ${evt.tool || "tool"}${p ? ` · ${p}` : ""}` }];
    }
    case "tool.completed":
      return toolResultLines(evt.tool, evt.preview, { duration: evt.duration, error: evt.error });
    case "message.delta":
      // The wire field is `delta` (not `text`): the run stream carries fragments.
      return evt.delta ? [{ kind: "text", text: String(evt.delta) }] : [];
    case "message.interim":
      // Commentary the model writes beside its tool calls. When it was also streamed as a delta,
      // printing it again would duplicate the line.
      return evt.text && !evt.already_streamed ? [{ kind: "text", text: String(evt.text) }] : [];
    case "run.steered":
      return [{ kind: "raw", text: "⇢ steer delivered to the live turn" }];
    case "approval.request":
      return [{ kind: "raw", text: `⚠ approval requested: ${String(evt.command || evt.description || "").slice(0, 200)}` }];
    case "approval.responded":
      return [{ kind: "dim", text: `⇢ approval answered: ${String(evt.choice || "")}` }];
    case "clarify.request":
      // The question itself is the card's prompt box; this line is the transcript's record that the
      // agent stopped to ask, at the point in its output where it stopped.
      return [{ kind: "raw", text: `❓ question asked: ${clarifyText(evt.question).replace(/\s+/g, " ").slice(0, 200)}` }];
    case "subagent.start":
      return [{ kind: "raw", text: `↳ subagent started${evt.preview ? `: ${String(evt.preview).slice(0, 160)}` : ""}` }];
    case "subagent.complete":
      return [{ kind: "raw", text: `↳ subagent ${evt.status || "finished"}${evt.preview ? `: ${String(evt.preview).slice(0, 160)}` : ""}` }];
    case "error":
      // A run-level error ends the turn's usefulness: whatever approval it was parked on is moot, and
      // leaving the object behind made the card keep offering buttons for a dead turn.
      return [{ kind: "raw", text: `error: ${String(evt.error || evt.message || "unknown").slice(0, 300)}` }];
    default:
      return [];
  }
}

// The stats row above the reply box (context occupancy, prompt-cache hit rate, mean latency and
// throughput) is a display readout, not billing: keep only values that are really numbers, so a
// field the gateway omitted renders as "no data" instead of a fabricated 0%.
const STAT_NUM_KEYS = ["context_used", "context_max", "context_percent", "cache_hit_pct",
  "avg_latency_s", "avg_tps", "compressions"];

function statsFromUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const out = {};
  for (const key of STAT_NUM_KEYS) {
    const v = usage[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  if (typeof usage.context_estimated === "boolean") out.context_estimated = usage.context_estimated;
  return Object.keys(out).length ? out : null;
}

// A line is a line: kind + text. The gateway's whole run object used to ride along as `json` on every result line -
// straight to the browser and into jobs.json - for a reader that never looked at it. The numbers a card needs are
// already read from the run by settle(); what is left here is the sentence.
export function runResultLine(status, run) {
  const tk = run?.usage || {};
  const bits = [
    `run ${status}`,
    tk.total_tokens ? `tokens ${tk.total_tokens} (in ${tk.input_tokens ?? "?"} / out ${tk.output_tokens ?? "?"})` : null,
    run?.pending_steer ? `pending steer: ${String(run.pending_steer).slice(0, 120)}` : null,
  ].filter(Boolean);
  return { kind: "result", text: bits.join(" · ") };
}

// ---- registry ------------------------------------------------------------------------
// Turns a gateway refusal into something a reader can act on. Only the cases we understand are translated;
// everything else keeps the gateway's own words.
export function runRefusal(status, detail, { thread, revived } = {}) {
  const text = String(detail || "");
  if (Number(status) !== 409 || !/permission_denied/.test(text)) return null;
  if (revived) {
    return `this session is the CLI's, not the panel's — the gateway will not take a panel turn in it (409 permission_denied). Continue it in a terminal: hermes --resume ${thread}`;
  }
  return `the gateway refused the turn (409 permission_denied): it will not write into a session owned by another surface. Continue that session where it lives, or start a new panel session.`;
}

export class Jobs {
  constructor({ config = {}, onEvent = () => {}, onLog = log, clarifyWindow = null, approvalWindow = null } = {}) {
    this.config = config;
    this.onEvent = onEvent;
    this.onLog = onLog;
    // The gateway's clarify window, as a getter: an API run's `clarify.request` carries no `timeout_s`
    // (the gateway only fills it for a local viewer), so the countdown is measured against this.
    this.clarifyWindow = clarifyWindow;
    // …and the same for the approval window, which the gateway reads from `approvals.timeout` in the config
    // file the panel already reads for the Settings screen. A parked approval has a deadline, and a card that
    // does not know it is a card that keeps offering a decision the gateway has already made.
    this.approvalWindow = approvalWindow;
    this.jobs = new Map();
    this.api = apiConfig(config);
    if (!this.api.key) {
      const fromFile = readKeyFromEnvFile();
      if (fromFile) this.api.key = fromFile;
    }
    // Every backend a job can run on, keyed by `job.agent`. Per-job calls go through `transportFor(j)`.
    this.hermes = new HermesTransport({ jobs: this, onLog });
    this.transports = { hermes: this.hermes };
    this.maxRuntimeSeconds = Number(config.jobMaxRuntimeSeconds) || 3600;
    // The registry is persisted so a restart does not lose the fact that an agent ran in a
    // worktree (the row's agent chip is derived from it) and does not empty the Agents list.
    this.storePath = config.jobsFile || null;
    // Session labels (the panel's own display names) live beside the job store: renaming must never
    // touch the Hermes thread id, which is how the thread is resumed.
    this.labelsPath = this.storePath ? path.join(path.dirname(this.storePath), "labels.json") : null;
    this.labels = this.loadLabels();
    // The model a thread should run with next, chosen from the card. Beside the labels: a per-session preference that
    // is not part of the conversation's own record.
    this.modelsPath = this.storePath ? path.join(path.dirname(this.storePath), "thread-models.json") : null;
    this.threadModels = this.loadThreadModels();
    // The ceiling a card measures its context against. The model's own window is the real limit; this is the
    // reader saying "show me when this session passes 200K", so the gauge answers the question they asked.
    this.contextPath = this.storePath ? path.join(path.dirname(this.storePath), "thread-context.json") : null;
    this.threadContext = this.loadThreadContexts();
    this.persistTimer = null;
    this.load();
    // A run's last event can arrive before Hermes has named its session, and a finished card gets no more events.
    // Sweep the cards that still have no name and repaint the ones a name has landed on.
    this.titleSweep = setInterval(() => this.sweepTitles(), 10_000);
    this.titleSweep.unref?.();
    // An approval's window closes on the gateway's clock, and the gateway tells nobody: it evicts the request
    // and the tool goes on with a denial. Sweeping here is what stops the panel advertising an answer nobody
    // can give any more; the click path carried the rest of it (see `answerGone`).
    this.approvalSweep = setInterval(() => this.sweepApprovals(), 5_000);
    this.approvalSweep.unref?.();
  }

  // How long the gateway will wait for an approval answer, in seconds. The window is the gateway's
  // (`approvals.timeout`, read from the same config file the Settings screen edits and shown there), and it is
  // read per request, not once at boot, so a reader who changes it is answered with the new number.
  approvalWindowSeconds() {
    if (typeof this.approvalWindow === "function") {
      try {
        const raw = this.approvalWindow();
        const n = Number(raw && typeof raw === "object" ? raw.seconds : raw);
        if (Number.isFinite(n) && n >= 0) return n;
      } catch {
        /* an unreadable config is not a reason to offer a prompt with no deadline */
      }
    }
    return APPROVAL_WINDOW_DEFAULT;
  }

  // Every approval whose window has closed, off the board. This mirrors the gateway's own fail-closed rule:
  // `tools/approval_gateway_wait._poll_event` gives up at `approvals.timeout` and the command is denied with
  // "timed out without user response" — but that verdict is published to NOBODY, because `approval.responded`
  // is emitted only by `POST /v1/runs/{id}/approval` (api_server_runs.py). Measured on run_32e739f2: the 300 s
  // window closed at 12:00:48, the run status still read `waiting_for_approval` with the request attached nine
  // minutes later, and the reader's clicks were answered "Run has no pending approval" four times in a row.
  sweepApprovals(now = Date.now()) {
    let changed = 0;
    for (const j of this.jobs.values()) {
      const a = j.approval;
      const deadline = Number(a?.deadline);
      if (!a || !Number.isFinite(deadline) || now < deadline) continue;
      this.expireApproval(j, now, "expired");
      changed++;
    }
    return changed;
  }

  // The one way an unanswered approval leaves the board: what happened is recorded in `approvalDone` (with an
  // empty choice, so "denied" and "nobody answered" never read as the same thing), the console keeps a line,
  // and the box goes. `reason` is `expired` when this panel's clock reached the gateway's window, and
  // `withdrawn` when the gateway itself said it no longer holds the request.
  expireApproval(j, now = Date.now(), reason = "expired") {
    const a = j.approval;
    if (!a) return false;
    const waited = Math.max(0, Math.round((now - (Date.parse(a.at || "") || now)) / 1000));
    j.approval = null;
    j.approvalDone = {
      choice: "",
      command: a.command || "",
      at: new Date(now).toISOString(),
      // Nothing was decided here. The card shows this, and the assistant's `approval` rule stops seeing a job
      // parked on a person the moment the box is gone.
      expired: true,
      reason,
      waitedSeconds: waited,
    };
    this.push(j, {
      kind: "dim",
      text:
        reason === "withdrawn"
          ? "⇢ the gateway no longer holds that approval (it expired, was answered on another surface, or was stopped) — nothing was decided here"
          : `⇢ no answer within the gateway's ${a.timeoutSeconds || APPROVAL_WINDOW_DEFAULT}s window — the gateway denied it and the agent carried on`,
    });
    this.onLog(`run ${j.id}: approval ${reason} after ${waited}s (no answer)`);
    this.emit(j);
    return true;
  }

  // The gateway's own verdict that it no longer holds the request — `approval_not_pending` after its window
  // closed, or `approval_not_active` once the approval session is gone. Nothing was decided here either way, and
  // the same handling serves the first post and the self-heal retry.
  approvalGone(j, code) {
    this.expireApproval(j, Date.now(), "withdrawn");
    return {
      ok: false,
      gone: true,
      code,
      error: `the gateway no longer holds this approval (${code}) — it had expired, was answered on another surface, or was stopped, so nothing was decided here`,
    };
  }

  // The session's own name, as Hermes writes it, can land after the run's last event. Anything still showing a
  // nameless card is asked again here; `summary()` reads the name from the store on every emit.
  sweepTitles() {
    for (const j of this.jobs.values()) {
      if (j.named) continue;
      const info = this.sessionInfoFor(j.thread);
      if (info.title) {
        j.named = true;
        this.emit(j);
      }
    }
  }

  // ---- gateway reachability ------------------------------------------------------------
  // The Hermes gateway is the panel's default transport, so these keep answering for it.
  headers(extra = {}) {
    return this.hermes.headers(extra);
  }

  // Cheapest possible answer to "can this panel run anything right now?" — the settings surface and
  // the spawn route both ask before promising a job.
  async probe({ fresh = false } = {}) {
    return this.hermes.probe({ fresh });
  }

  transportInfo() {
    return { ...this.hermes.state };
  }

  // The backend a job runs on. Jobs from before `agent` existed are Hermes jobs.
  transportFor(j) {
    const agent = (j && j.agent) || "hermes";
    const t = this.transports[agent];
    if (!t) throw new Error(`no transport for agent "${agent}"`);
    return t;
  }

  // ---- persistence ---------------------------------------------------------------------
  load() {
    if (!this.storePath || !existsSync(this.storePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.storePath, "utf8"));
      const restored = [];
      for (const j of saved.jobs || []) {
        // A run lives in the gateway, not in this process, so a panel restart does not necessarily
        // mean the agent stopped — but the panel has lost its stream and cannot steer safely. Say
        // exactly that instead of claiming the run ended.
        if (j.status === "running" || j.status === "starting") {
          j.status = "interrupted";
          j.error = j.error || `the panel restarted while this was running${j.runId ? ` (run ${j.runId} may still be live in the gateway)` : ""}`;
          // The turn's clock has to stop where this panel last saw it work. With no end it counted from
          // `startedAt` to now on every repaint: a turn cut off at 03:09 still drew "interrupted · 79m22s" at
          // 04:17, and the number grew while the reader watched it.
          j.endedAt = j.endedAt || lastSeenIso(j);
          restored.push(j);
        }
        // Jobs from before the transport map have no agent: they ran on the Hermes gateway.
        j.agent = j.agent || "hermes";
        j.child = null;
        j.timer = null;
        j.poller = null;
        // Older store files carry the run object on result lines as `json`. Nothing reads it, and it was the only
        // JSON that reached the browser inside the console, so drop it on the way in.
        for (const l of j.lines || []) if (l && "json" in l) delete l.json;
        this.jobs.set(j.id, j);
        this.fillStats(j); // a card from before the strip existed still has its numbers in the store
        for (const l of j.lines || []) if (l.lid && l.lid > lineSeq) lineSeq = l.lid;
      }
      // A turn a restart cut off still has to be able to say what it left behind: its completion is built
      // from what the panel last saw, and rebuilt if the run turns out to have finished on its own.
      for (const j of restored) void this.measureTree(j);
      this.onLog(`restored ${this.jobs.size} job(s) from ${this.storePath}`);
    } catch (e) {
      this.onLog(`could not read ${this.storePath}: ${String((e && e.message) || e)}`);
    }
  }

  schedulePersist() {
    if (!this.storePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const jobs = [...this.jobs.values()]
          .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
          .slice(0, KEEP_JOBS)
          .map((j) => ({
            id: j.id, thread: j.thread, turn: j.turn, reply: j.reply, existing: j.existing, revived: Boolean(j.revived),
            prompt: j.prompt, cwd: j.cwd, worktree: j.worktree, worktreePath: j.worktreePath,
            // Ownership has to survive a restart: without these, every agent came back "unattached"
            // after a reload even though it was created and is still running in a worktree.
            ownerPath: j.ownerPath || null,
            ownerPending: Boolean(j.ownerPending),
            projectPath: j.projectPath || null,
            runId: j.runId || null,
            approvalDone: j.approvalDone || null,
            questionDone: j.questionDone || null,
            sessionId: j.sessionId, status: j.status, exitCode: j.exitCode, fatal: j.fatal,
            // What the run left behind: the word it ended on, the notice built from it, and the facts that
            // notice is made of. Persisted because the panel can be restarted between a worker finishing and
            // the wake that reports it.
            outcome: j.outcome || null,
            termination: j.termination || null,
            branch: j.branch || null,
            baseSha: j.baseSha || null,
            finalMessage: j.finalMessage || null,
            tree: j.tree || null,
            completion: j.completion || null,
            agent: j.agent || "hermes",
            startedAt: j.startedAt, endedAt: j.endedAt, model: j.model, yolo: j.yolo,
            budget: j.budget, maxTurns: j.maxTurns, tokens: j.tokens, error: j.error,
            // The stats row survives a restart: it is the only record of where the context stood.
            stats: j.stats || null,
            durationMs: j.durationMs, lines: (j.lines || []).slice(-120),
            // The produced-files list has to survive a restart too: it is the only way back to a
            // document the agent wrote three sessions ago.
            artifacts: j.artifacts || [],
            // What the reader attached to this turn: links on the card, while the gateway got the paths
            // inside the prompt text.
            attachments: j.attachments || [],
            // What caused this turn (a subagent delivery) and whether its results were already delivered back. Both
            // have to survive a restart: without them the chip disappears and the offer comes back.
            origin: j.origin || null,
            collected: j.collected || null,
          }));
        mkdirSync(path.dirname(this.storePath), { recursive: true });
        writeFileSync(this.storePath, JSON.stringify({ savedAt: new Date().toISOString(), jobs }, null, 0));
      } catch {
        /* persistence is a convenience: never let it break a run */
      }
    }, 700);
  }

  // The session row's cumulative output tokens, or null when the store cannot be read. Used to turn a
  // running turn's share into a throughput estimate.
  sessionOutput(thread) {
    try {
      const s = sessionUsage(thread, { dbPath: path.join(hermesHome(), "state.db") });
      return s && Number.isFinite(s.output_tokens) ? s.output_tokens : null;
    } catch {
      return null;
    }
  }

  // How many tokens this turn has produced so far: the session counter minus where it stood at the
  // moment the turn began.
  liveTurnOutput(j) {
    const now = this.sessionOutput(j.thread);
    if (now === null || j.baseOutput === null || j.baseOutput === undefined) return null;
    const output = now - j.baseOutput;
    return output > 0 ? { output } : null;
  }

  // A running turn has no `run.usage` yet, so the strip used to stay blank until the turn finished —
  // which read as "this agent has no stats" while every settled sibling had them. Reading the store
  // while the run is still going gives live numbers; the turn's own share is the delta since it began.
  refreshStats(j) {
    if (!j || j.status !== "running") {
      clearInterval(j?.statsTimer);
      if (j) j.statsTimer = null;
      return;
    }
    const before = j.stats ? JSON.stringify(j.stats) : "";
    this.fillStats(j);
    if (j.stats && JSON.stringify(j.stats) !== before) this.emit(j);
  }

  // The strip's numbers come from the store rather than from the run stream: on a gateway that runs
  // turns through its admission path no `run.usage` event is ever pushed, so these used to be blank.
  // Called while a run is going, when it settles, and once when the store is loaded — so old cards fill
  // in too.
  fillStats(j) {
    if (!j || !j.thread) return;
    try {
      // Date.parse(0) is the YEAR 2000, not "unset" — with that feeding `ended`, the elapsed time was
      // always negative and clamped to 0, so throughput and latency never appeared on a turn that had
      // just settled. Parse only a real stamp; otherwise fall back explicitly.
      const startedRaw = Date.parse(j.startedAt || "");
      const endedRaw = Date.parse(j.endedAt || "");
      const started = Number.isFinite(startedRaw) ? startedRaw : null;
      const ended = Number.isFinite(endedRaw) ? endedRaw : Date.now();
      const seconds = started ? Math.max(0, (ended - started) / 1000) : null;
      const liveOutput =
        j.tokens || j.baseOutput === null || j.baseOutput === undefined ? null : this.liveTurnOutput(j);
      const dbStats = usageStats(j.thread, {
        turn: j.tokens || liveOutput,
        seconds,
        toolSeconds: toolSecondsFromLines(j.lines, { now: ended }),
        dbPath: path.join(hermesHome(), "state.db"),
        catalogPath: path.join(hermesHome(), "cache", "openrouter_model_metadata.json"),
        // The moment a turn settles is exactly when its final numbers land in the store, so that read
        // must not be served from a cache filled a second earlier.
        maxAgeMs: j.status === "running" ? 3000 : 0,
      });
      if (!dbStats) return;
      // A figure the gateway pushed itself is the measured one and wins; the rest are recomputed every
      // few seconds while a turn runs, so they must not be frozen by their own previous value.
      const merged = { ...dbStats, ...(j.gatewayStats || {}) };
      if (JSON.stringify(merged) !== JSON.stringify(j.stats || {})) j.stats = merged;
    } catch {
      /* the strip is a readout: never let it break a card */
    }
  }

  // Documents that arrived with a steer: they belong to the turn that was running when they landed.
  addAttachments(jobId, list) {
    const j = this.jobs.get(jobId);
    if (!j) return;
    const extra = normaliseAttachments(list);
    if (!extra.length) return;
    const have = new Set((j.attachments || []).map((a) => a.path));
    j.attachments = [...(j.attachments || []), ...extra.filter((a) => !have.has(a.path))];
    this.emit(j);
  }

  summary(j) {
    const info = this.sessionInfoFor(j.thread);
    return {
      id: j.id,
      status: j.status,
      // The card used to show a pid; a run is addressed by its run id instead.
      pid: null,
      runId: j.runId || null,
      prompt: j.prompt,
      agent: j.agent || "hermes",
      yolo: j.yolo,
      origin: j.origin || null,
      // Set once a turn's subagent results have been sent back to it, so no reload, tab or second reader collects it
      // again (localStorage is per browser; this is per job).
      collected: j.collected || null,
      model: j.model,
      // What the thread is set to run with next: a pick on the card wins over what the last turn used.
      effectiveModel: this.modelFor(j.thread) || j.model || null,
      // The context ceiling the card measures itself against; null means the model's own window.
      contextLimit: this.contextLimitFor(j.thread),
      worktree: j.worktree,
      worktreePath: j.worktreePath || null,
      // The branch the panel cut for this run, and — once it has ended — what it left behind: the word it
      // ended on and the payload the board assistant is woken with. `tree` is measured at the end of the turn,
      // so it can also say that the worktree is gone.
      branch: j.branch || null,
      outcome: j.outcome || null,
      tree: j.tree || null,
      completion: j.completion || null,
      ownerPath: j.ownerPath || null,
      ownerPending: Boolean(j.ownerPending),
      projectPath: j.projectPath || null,
      cwd: j.cwd || null,
      thread: j.thread,
      turn: j.turn,
      // The panel's display name for this session, if it has been renamed.
      label: this.labelFor(j.thread),
      // The session's own name, as Hermes titled it — the same name the revive list offers. The card shows
      // this instead of its cwd, which was long, identical for every card in a tree and said nothing.
      title: info.title,
      // When that session was last used, so the card can say how stale the thread is the way the revive row
      // does. Null for a job whose thread has no session row yet.
      lastActiveAt: info.at,
      reply: Boolean(j.reply),
      existing: Boolean(j.existing),
      baseCheckout: Boolean(j.baseCheckout),
      // Rebuilt from the gateway's session store rather than from a run this panel watched.
      revived: Boolean(j.revived),
      replyTo: j.replyTo || null,
      maxTurns: j.maxTurns || null,
      budget: j.budget || null,
      sessionId: j.sessionId,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      exitCode: j.exitCode,
      tokens: j.tokens,
      // Context / cache / latency readout the card draws above the reply box.
      stats: j.stats || null,
      durationMs: j.durationMs,
      transport: "runs",
      error: j.error || null,
      // Files this agent produced that a reader would open (docs, scripts, keys), oldest first.
      artifacts: j.artifacts || [],
      // Documents the reader attached to this turn: links on the card, while the gateway got the paths
      // inside the prompt text (its runs API has no attachment field).
      attachments: j.attachments || [],
      // A steer that arrived too late to land: the card offers it back as an unsent draft rather than turning it
      // into a second answer the reader did not ask for.
      pendingSteer: j.pendingSteer || null,
      // Present only while the run is parked on a flagged command; the card renders its buttons
      // from `choices`, so the panel can never offer a choice the host did not allow.
      approval: j.approval || null,
      // …and once answered, one line recording what was decided (the prompt text is kept too, so
      // the collapsed line can say what it approved without a second lookup).
      approvalDone: j.approvalDone || null,
      // The agent's `clarify` question while the turn is parked on it; `questionDone` is the one line
      // left behind once it is answered (or withdrawn with the turn).
      question: j.question || null,
      questionDone: j.questionDone || null,
      // Children this turn delegated, in the order they started. Only the gateway's lifecycle events feed
      // this: a child's own tool calls never reach the parent's stream.
      subagents: (j.subagents || []).map((s) => ({
        id: s.sessionId || s.ids[0] || null,
        goal: s.goal,
        index: s.index,
        running: s.running,
        status: s.status,
        duration: s.duration,
      })),
      lines: j.lines.slice(-TAIL),
    };
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map((j) => this.summary(j));
  }

  emit(j) {
    this.onEvent({ type: "job", job: this.summary(j) });
    this.schedulePersist();
  }

  // Ownership decides WHICH container a card lives in (the unattached list or a worktree's agents
  // block), so a change has to reach every client as a list event, not just a job tick.
  emitJobs() {
    this.onEvent({ type: "jobs", jobs: this.list() });
  }

  loadLabels() {
    if (!this.labelsPath || !existsSync(this.labelsPath)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(this.labelsPath, "utf8"));
      return new Map(Object.entries(raw || {}).filter(([k, v]) => typeof k === "string" && typeof v === "string"));
    } catch {
      return new Map();
    }
  }

  saveLabels() {
    if (!this.labelsPath) return;
    try {
      mkdirSync(path.dirname(this.labelsPath), { recursive: true });
      writeFileSync(this.labelsPath, JSON.stringify(Object.fromEntries(this.labels), null, 0));
    } catch {
      /* a label we cannot persist is not worth failing a rename over */
    }
  }

  loadThreadModels() {
    if (!this.modelsPath || !existsSync(this.modelsPath)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(this.modelsPath, "utf8"));
      return new Map(Object.entries(raw || {}).filter(([k, v]) => typeof k === "string" && typeof v === "string" && v));
    } catch {
      return new Map();
    }
  }

  saveThreadModels() {
    if (!this.modelsPath) return;
    try {
      mkdirSync(path.dirname(this.modelsPath), { recursive: true });
      writeFileSync(this.modelsPath, JSON.stringify(Object.fromEntries(this.threadModels), null, 0));
    } catch {
      /* a preference we cannot persist is not worth failing a pick over */
    }
  }

  loadThreadContexts() {
    if (!this.contextPath || !existsSync(this.contextPath)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(this.contextPath, "utf8"));
      return new Map(
        Object.entries(raw || {}).filter(([k, v]) => typeof k === "string" && Number.isFinite(Number(v)) && Number(v) > 0),
      );
    } catch {
      return new Map();
    }
  }

  saveThreadContexts() {
    if (!this.contextPath) return;
    try {
      mkdirSync(path.dirname(this.contextPath), { recursive: true });
      writeFileSync(this.contextPath, JSON.stringify(Object.fromEntries(this.threadContext), null, 0));
    } catch {
      /* a ceiling we cannot persist is not worth failing a pick over */
    }
  }

  contextLimitFor(thread) {
    const n = Number(this.threadContext.get(thread));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  // 0 / empty clears it, which puts the card back on the model's own window.
  setThreadContext(thread, limit) {
    if (!thread) return { ok: false, error: "thread is required" };
    const n = Math.round(Number(limit) || 0);
    if (n > 0) this.threadContext.set(thread, n);
    else this.threadContext.delete(thread);
    this.saveThreadContexts();
    this.emitJobs();
    return { ok: true, thread, limit: n > 0 ? n : null };
  }

  modelFor(thread) {
    return this.threadModels.get(thread) || null;
  }

  // Empty clears the preference, so the thread goes back to whatever its runs were created with.
  setThreadModel(thread, model) {
    if (!thread) return { ok: false, error: "thread is required" };
    const clean = String(model ?? "").trim().slice(0, 200);
    if (clean) this.threadModels.set(thread, clean);
    else this.threadModels.delete(thread);
    this.saveThreadModels();
    this.emitJobs();
    return { ok: true, thread, model: clean || null };
  }

  labelFor(thread) {
    return this.labels.get(thread) || null;
  }

  // Rename a session for the panel only: whitespace collapsed, capped, empty clears the label.
  setLabel(thread, label) {
    if (!thread) return { ok: false, error: "thread is required", label: null };
    const clean = String(label ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (clean) this.labels.set(thread, clean);
    else this.labels.delete(thread);
    this.saveLabels();
    this.emitJobs();
    return { ok: true, label: clean || null };
  }

  // A worktree renamed on disk: every job that ran there points at the old path until told otherwise, and a run's
  // body carries its cwd - so the next turn would be aimed at a directory that no longer exists. Follow the move.
  repointPath(oldPath, newPath) {
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const from = norm(oldPath);
    const to = String(newPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!from || !to) return 0;
    let moved = 0;
    for (const j of this.jobs.values()) {
      let touched = false;
      for (const field of ["cwd", "ownerPath", "worktreePath"]) {
        if (j[field] && norm(j[field]) === from) {
          j[field] = to;
          touched = true;
        }
      }
      if (!touched) continue;
      moved += 1;
      this.emit(j);
    }
    return moved;
  }

  push(j, line) {
    line.lid = ++lineSeq;
    // When the line was written. The browser draws a live "running 42s" clock on an in-flight tool
    // call, and it has to survive a reload — so the stamp is the server's, not the tab's.
    if (!line.at) line.at = Date.now();
    // Assistant prose arrives as deltas interleaved with tool events, so keep one open line per
    // PARAGRAPH and grow it in place no matter what lands in between. Some phases resend everything
    // so far instead of a delta; detect that and replace rather than append.
    if (line.kind === "text") {
      const fragment = stripAnsi(line.text ?? "");
      if (j.curText && !/^\s*\r?\n\s*\r?\n/.test(fragment)) {
        const prev = j.curText.text;
        const cumulative = fragment.length >= prev.length && fragment.trimStart().startsWith(prev.trimStart());
        j.curText.text = cumulative ? fragment.replace(/^\s*\n+/, "") : prev + fragment;
        this.onEvent({ type: "jobline", id: j.id, line: { kind: "text", lid: j.curText.lid, text: j.curText.text, mode: "set" } });
        // A URL the agent says out loud ("here: http://localhost:7440") is a deliverable like a file.
        this.scanUrls(j, fragment);
        return;
      }
      j.curText = { kind: "text", lid: line.lid, text: fragment.replace(/^\s*\n+/, ""), at: line.at };
      j.lines.push(j.curText);
      if (j.lines.length > MAX_LINES) j.lines.splice(0, j.lines.length - MAX_LINES);
      this.onEvent({ type: "jobline", id: j.id, line: { ...j.curText, mode: "new" } });
      this.scanUrls(j, fragment);
      return;
    }
    if (line.kind === "result" || line.kind === "init") j.curText = null;
    j.lines.push(line);
    if (j.lines.length > MAX_LINES) j.lines.splice(0, j.lines.length - MAX_LINES);
    this.onEvent({ type: "jobline", id: j.id, line });
    // A dev server announces itself in a tool's output (`Serving on http://127.0.0.1:5173`) or in the
    // command that starts it, not in the agent's prose. Those are the URLs a reader wants to click.
    if (line.kind === "tool") this.scanUrls(j, line.text, "tool");
    else if (line.kind === "tool-out") this.scanUrls(j, line.text, "tool-out");
  }

  // ---- artifacts ------------------------------------------------------------------------
  // A deliverable is something the reader acts on: a file an agent wrote, or a URL it handed over (a
  // dev server it started, a page it built). One ordered list, because the card shows one list.
  addArtifact(j, item) {
    j.artifacts = j.artifacts || [];
    const key = String(item.path || item.url || "").toLowerCase();
    if (!key) return false;
    if (j.artifacts.some((a) => String(a.path || a.url || "").toLowerCase() === key)) return false;
    j.artifacts.push({ ...item, at: item.at || Date.now() });
    this.schedulePersist();
    this.onEvent({ type: "job", job: this.summary(j) });
    return true;
  }

  addFileArtifact(j, file, bytes) {
    const p = String(file || "").split("\\").join("/");
    if (!isArtifactPath(p)) return false;
    return this.addArtifact(j, { kind: "file", path: p, bytes: Number(bytes) || null });
  }

  // A URL the agent presents - in its own words or in what a tool printed. The cap stops a chatty agent
  // from turning the list into a link dump.
  addUrlArtifact(j, url) {
    const raw = String(url || "").trim().replace(/[),.;:]+$/, "");
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if ((j.artifacts || []).filter((a) => a.kind === "url").length >= MAX_URL_ARTIFACTS) return false;
    return this.addArtifact(j, { kind: "url", url: parsed.toString() });
  }

  // `127.0.0.1:7473`, `localhost:3000`, `0.0.0.0:8080`, `[::1]:5173` - the way a dev server is usually
  // announced, and not something `new URL()` accepts without a scheme. Local and private hosts only:
  // `ratio:30` or `note:8080` in prose must not become a link.
  endpointUrl(token) {
    const text = String(token || "").trim();
    const m = /^([a-z0-9][a-z0-9.\-]*|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})/i.exec(text);
    if (!m) return null;
    const host = m[1].toLowerCase();
    const port = Number(m[2]);
    if (!(port > 0 && port < 65536)) return null;
    if (!LOCAL_HOST.test(host)) return null;
    const slash = text.indexOf("/");
    return `http://${host}:${port}${slash >= 0 ? text.slice(slash) : ""}`;
  }

  // Every place a URL can show up in the console: the agent's prose, the command it ran, and the lines its
  // tools printed. Prose is taken as written; tool text only when it looks like a service endpoint, because
  // a `read_file` of a README or a `web_extract` page is full of links that are not deliverables.
  scanUrls(j, text, mode = "prose") {
    const body = String(text || "");
    // Only prose is streamed, and a fragment can end mid-address ("http://127.0.0."), which WHATWG URL
    // reads as 127.0.0.0. A match that runs to the end of a fragment is taken only when the fragment ends
    // on whitespace; otherwise the next fragment completes it and the settle pass reads the whole turn.
    const settled = (endAt) => mode !== "prose" || /\s$/.test(body) || endAt < body.length;
    const urlRe = /https?:\/\/[^\s<>"'`\]}]+/gi;
    let m;
    while ((m = urlRe.exec(body))) {
      if (!settled(m.index + m[0].length)) continue;
      const clean = m[0].replace(/[),.;:]+$/, "");
      if (mode !== "prose" && !isEndpointLike(clean)) continue;
      this.addUrlArtifact(j, clean);
    }
    if (mode === "tool-out") return; // a bare host:port in tool output is too often a build counter
    const bareRe = /(?<![\w.\-/@])(?:localhost|0\.0\.0\.0|127\.0\.0\.1|\[::1\]|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}(?:\/[^\s<>"'`]*)?/gi;
    while ((m = bareRe.exec(body))) {
      if (!settled(m.index + m[0].length)) continue;
      const url = this.endpointUrl(m[0]);
      if (url) this.addUrlArtifact(j, url);
    }
  }

  // The whole turn's prose, once it cannot change any more: the one place a URL split across two streamed
  // fragments is guaranteed to be whole.
  scanTurnUrls(j) {
    const text = (j.lines || [])
      .filter((l) => l.kind === "text")
      .map((l) => l.text)
      .join("\n");
    if (text) this.scanUrls(j, text, "final");
  }

  removeArtifact(j, key) {
    const k = String(key || "").toLowerCase();
    const before = (j.artifacts || []).length;
    j.artifacts = (j.artifacts || []).filter((a) => String(a.path || a.url || "").toLowerCase() !== k);
    if (j.artifacts.length === before) return false;
    this.schedulePersist();
    this.onEvent({ type: "job", job: this.summary(j) });
    return true;
  }

  findArtifact(key) {
    const k = String(key || "").toLowerCase();
    for (const j of this.jobs.values()) {
      const hit = (j.artifacts || []).find((a) => String(a.path || a.url || "").toLowerCase() === k);
      if (hit) return { job: j, artifact: hit };
    }
    return null;
  }

  // The write_file CALL names the target ("✍️ write_file · C:\\dir\\x.md"). Recorded too, because the
  // gateway's tool.completed preview for write_file is frequently empty, and a deliverable the agent
  // named and wrote should never be missing from the list for want of a result payload.
  noteArtifactCall(j, evt) {
    if (String(evt.tool || "") !== "write_file") return;
    let raw = String(evt.preview || "").trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        raw = String(parsed.path || parsed.file_path || parsed.resolved_path || "").trim();
      }
    } catch {
      /* plain text: the path itself */
    }
    const first = raw.split(/\r?\n/)[0].trim().replace(/^["']|["']$/g, "");
    if (!first) return;
    const abs = path.isAbsolute(first) ? first : path.resolve(j.cwd || process.cwd(), first);
    this.addFileArtifact(j, abs, null);
  }

  // `write_file` answers {resolved_path, bytes_written}: the file it wrote, by name.
  noteArtifact(j, evt) {
    if (String(evt.tool || "") !== "write_file") return;
    let body;
    try {
      body = JSON.parse(stripAnsi(evt.preview ?? ""));
    } catch {
      return; // not JSON: an error string, or prose from a tool that is not write_file
    }
    if (!body || typeof body !== "object") return;
    if (typeof body.resolved_path === "string") this.addFileArtifact(j, body.resolved_path, body.bytes_written);
  }

  // An agent that writes with a shell (`cat > x.sql`, `sqlplus @script`) leaves no tool event, but it
  // does leave an untracked file. Only UNTRACKED ones count: a tracked file it edited is a change,
  // not a deliverable.
  //
  // Only files this turn could have written. The directory is not private to the run: a run started in
  // a project ROOT rather than its own worktree shares that root with every other agent, so sweeping
  // it blindly adopts whatever stray deliverable was already lying there and files it under the wrong
  // agent — measured: a handoff doc and a code review that another row's agent wrote weeks earlier
  // appeared on an unrelated card. A file written during the turn has an mtime at or after its start.
  async sweepArtifacts(j) {
    if (!j.cwd) return;
    const since = Date.parse(j.startedAt || "") || 0;
    const grace = 2_000; // filesystem timestamp granularity, and the moment between create and start
    let out = "";
    try {
      out = (await pexec("git", ["-C", j.cwd, "status", "--porcelain", "--untracked-files=normal"], {
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      })).stdout;
    } catch {
      return; // not a git repo, or no git: the write_file path still covers it
    }
    const mtimeOf = (target) => {
      try {
        return statSync(target).mtimeMs;
      } catch {
        return null; // vanished between git and stat
      }
    };
    const ours = (mtime) => !since || (mtime !== null && mtime >= since - grace);
    for (const row of out.split(/\r?\n/)) {
      if (!row.startsWith("?? ")) continue;
      const rel = row.slice(3).trim().replace(/^"(.*)"$/, "$1");
      if (!rel) continue;
      const full = path.join(j.cwd, rel);
      if (rel.endsWith("/")) {
        // `--untracked-files=normal` collapses a wholly-untracked directory into one line, so a
        // deliverable written into a NEW folder (`docs/plans/x.md`) never named itself and never
        // appeared. If the directory is itself this turn's, the files inside it are too: enumerate
        // that one directory rather than the tree.
        if (!ours(mtimeOf(full))) continue;
        let listed = "";
        try {
          listed = (await pexec("git", ["-C", j.cwd, "ls-files", "--others", "--exclude-standard", "--", rel], {
            timeout: 15_000,
            maxBuffer: 4 * 1024 * 1024,
          })).stdout;
        } catch {
          continue;
        }
        for (const inner of listed.split(/\r?\n/).slice(0, 200)) {
          const f = inner.trim();
          if (!f || !isArtifactPath(f)) continue;
          const innerFull = path.join(j.cwd, f);
          if (!ours(mtimeOf(innerFull))) continue;
          this.addFileArtifact(j, innerFull, null);
        }
        continue;
      }
      if (!ours(mtimeOf(full))) continue; // older than this turn: someone else's file
      this.addFileArtifact(j, full, null);
    }
  }

  // ---- worktree ------------------------------------------------------------------------
  // `hermes -w` used to branch and create the tree. The panel does it now, because the run body
  // carries a directory, not a flag. The branch is the panel's to name and the tree is the user's
  // to keep: nothing here deletes it.
  async makeWorktree(repoDir, prompt) {
    const slug = String(prompt || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "agent";
    const tag = randomUUID().slice(0, 6);
    const branch = `wtgui/${slug}-${tag}`;
    const treePath = path.join(repoDir, ".worktrees", `${slug}-${tag}`);
    await pexec("git", ["-C", repoDir, "worktree", "add", "-b", branch, treePath], { timeout: 90_000, windowsHide: true });
    return { branch, path: treePath.replace(/\\/g, "/").replace(/\/+$/, "") };
  }

  // ---- what a finished turn left behind -------------------------------------------------
  // The commit a turn starts from. "Did this run leave anything behind" is only answerable against a starting
  // point, and one read of the run's own directory covers both shapes: a new tree branched from the project's
  // head the moment it was cut, an existing one is wherever it stood. Taken before the run is posted.
  async headSha(dir) {
    if (!dir) return null;
    try {
      const { stdout } = await pexec("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 20_000, windowsHide: true });
      return String(stdout || "").trim() || null;
    } catch {
      return null; // not a checkout, or an unborn HEAD: then there is nothing to count against
    }
  }

  // What the panel did to this run, when the panel is what ended it. First record wins: the wall-clock cap
  // that asked for the stop is the reason, not the stop request that followed it.
  terminate(j, by, extra = {}) {
    if (!j) return null;
    if (!j.termination) j.termination = { by, at: new Date().toISOString(), ...extra };
    return j.termination;
  }

  // The facts of a finished turn, in one place: the exit status (read from the run's terminal result plus
  // whatever this panel did to it), how long it took, and the notice payload built from those and the tree.
  // Every path that ends a turn calls this — the run's terminal event, the polled status, a reconciled
  // restart, and the failures that never reached the gateway.
  //
  // A live turn has no completion, however quiet: there is nothing to announce until the run says it ended.
  finalise(j, { runStatus = null, run = null } = {}) {
    if (!j) return null;
    if (j.status === "running" || j.status === "starting") return null;
    // `done`/`cancelled` are the card's words; the run's own are `completed`/`cancelled`.
    const status = runStatus || (j.status === "done" ? "completed" : j.status);
    // Read the exit status only when there is something to read it from, or when nothing has yet: the tree
    // measurement lands after the turn settles and calls this again, and re-deriving the outcome from the
    // card's status word there would throw away what the run's own result said (measured: a run whose result
    // carried `exit_code: 3` came back "not published" a second later, because the status word was all the
    // second reading had).
    if (!j.outcome || run || runStatus) {
      j.outcome = outcomeFrom({ runStatus: status, run: run || (j.error ? { error: j.error } : {}), termination: j.termination || null });
    }
    j.exitCode = j.outcome.exitCode;
    const started = Date.parse(j.startedAt || "");
    const ended = Date.parse(j.endedAt || "");
    if (Number.isFinite(started) && Number.isFinite(ended)) j.durationMs = Math.max(0, ended - started);
    j.completion = completionPayload({ ...j, report: readReport(j) });
    return j.completion;
  }

  // The tree the run worked in, measured now rather than trusted from a scanned row: a row is for a worktree
  // the panel is watching and it ages out, while a run's tree can be removed the moment its turn ends — which
  // is exactly the case a notice has to be able to tell apart from a run that committed and finished.
  async measureTree(j) {
    if (!j) return null;
    // `pending` says the tree facts have not landed yet. The notice is not filed until they have (the sentry
    // skips a finish whose measurement is in flight and files it on its next pass): measured on a live turn,
    // an alert fired in the same second as the settle read "commits not measured" and the reader had to reopen
    // the card to find out whether there was anything to merge.
    const tree = { at: Date.now(), pending: true, exists: false, path: null, branch: null, base: null, commits: null, subjects: [], dirty: null, untracked: null, note: "" };
    j.tree = tree;
    // A turn that was a reply has no tree of its own; the thread's first turn does, and the tree is the same.
    const owner = this.firstOfThread(j.thread);
    const guesses = [j.worktreePath, j.ownerPath, owner?.worktreePath, owner?.ownerPath, j.cwd]
      .map(cleanPath)
      .filter((p, i, all) => p && all.indexOf(p) === i);
    const base = j.baseSha || null;
    tree.base = base ? base.slice(0, 8) : null;
    if (!guesses.length || !(j.worktreePath || j.ownerPath || j.existing)) {
      // A turn that was never meant to work in a project tree (the panel's own assistant reads the board):
      // saying so is the honest answer, and there is nothing to measure.
      tree.note = "this run had no tree of its own";
      tree.pending = false;
      this.finalise(j);
      this.emit(j);
      return tree;
    }
    const repo = cleanPath(j.projectPath || j.cwd || "") || null;
    const git = (args, cwd = repo) =>
      pexec("git", ["-C", cwd, ...args], { timeout: 20_000, windowsHide: true })
        .then((r) => String(r.stdout || "").trim())
        .catch(() => null);
    // Where the tree is NOW. A finished tree is auto-named after its agent — the panel moves the directory and
    // renames its branch — and a measurement that lands inside that move reads a path that is already gone.
    // Measured live: a run the wall-clock cap killed was written up as "worktree gone, commits not measured"
    // while the tree sat one directory name over, with nothing committed in it. The recorded paths are the
    // first guess; `git worktree list --porcelain` is the authority, because it names every worktree WITH its
    // branch and follows a move that the panel's own records have not caught up with yet.
    const locate = async () => {
      for (const p of guesses) if (existsSync(p)) return p;
      const listed = await git(["worktree", "list", "--porcelain"]);
      if (!listed) return guesses[0];
      let block = null;
      for (const line of linesOf(listed)) {
        if (line.startsWith("worktree ")) block = { path: cleanPath(line.slice(9)) };
        else if (line.startsWith("branch ") && block) block.branch = cleanPath(line.slice(7)).replace("refs/heads/", "");
        else if (block && !line.trim()) {
          const samePlace = guesses.some((p) => p.toLowerCase() === block.path.toLowerCase());
          const sameBranch = Boolean(j.branch && block.branch) && j.branch.toLowerCase() === block.branch.toLowerCase();
          if ((samePlace || sameBranch) && existsSync(block.path)) {
            if (samePlace && !sameBranch) tree.movedTo = block.path;
            return block.path;
          }
          block = null;
        }
      }
      return guesses[0];
    };
    // One read of the tree, as its own function so it can be run twice: the panel renames a worktree AND its
    // branch the moment the agent's own title lands — which is right after a turn ends — and a git call that
    // lands inside that window fails. Measured live: a run that committed 329cfd3 read back "could not count
    // 44a6a57c..HEAD" at the settle, and the commit was there a second later under its new branch name.
    const readTree = async () => {
      const dir = await locate();
      tree.path = dir || null;
      tree.exists = Boolean(dir) && existsSync(dir);
      tree.subjects = [];
      if (tree.exists) {
        tree.branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)) || j.branch || null;
        const status = await git(["status", "--porcelain"], dir);
        if (status !== null) {
          const rows = status.split(/[\r\n]+/).filter((l) => l.trim());
          tree.untracked = rows.filter((l) => l.startsWith("??")).length;
          tree.dirty = rows.length - tree.untracked;
        }
        if (base) {
          const count = await git(["rev-list", "--count", `${base}..HEAD`], dir);
          tree.commits = count !== null && /^\d+$/.test(count) ? Number(count) : null;
          if (tree.commits) tree.subjects = ((await git(["log", "--format=%h %s", `-${Math.min(tree.commits, 8)}`, `${base}..HEAD`], dir)) || "").split(/[\r\n]+/).filter(Boolean);
          else if (tree.commits === null) tree.note = `git could not count ${tree.base}..HEAD in ${tree.path}`;
        } else {
          tree.note = "the commit this turn started from was never read (its directory is not a checkout)";
        }
      } else if (base && j.branch) {
        // The tree is gone (a `-w` run that commits nothing has its tree removed at the end). Its branch may
        // still have a ref in the repo it was cut from, and that is what tells the two cases apart.
        const count = await git(["rev-list", "--count", `${base}..${j.branch}`], repo);
        tree.commits = count !== null && /^\d+$/.test(count) ? Number(count) : null;
        if (tree.commits) {
          tree.subjects = ((await git(["log", "--format=%h %s", `-${Math.min(tree.commits, 8)}`, `${base}..${j.branch}`], repo)) || "").split(/[\r\n]+/).filter(Boolean);
        } else {
          tree.note = `the worktree is gone and ${j.branch} has no ref left to count against ${tree.base}`;
        }
      } else {
        tree.note = "the run's worktree is gone and it recorded no branch of its own";
      }
    };
    await readTree();
    // One more try when the tree could not be found or counted: both are what a rename in flight looks like,
    // and the second read asks git again rather than trusting the path the first read was given.
    if (base && (!tree.exists || tree.commits === null)) {
      tree.attempts = 2;
      await new Promise((r) => setTimeout(r, 1200));
      await readTree();
    }
    tree.pending = false;
    this.finalise(j);
    this.emit(j);
    return tree;
  }

  // ---- run lifecycle -------------------------------------------------------------------
  async create(opts = {}) {
    const prompt = String(opts.prompt ?? "").trim();
    if (!prompt) throw new Error("prompt is required");
    // One conversation per thread: turns share the thread name, so the gateway continues the same
    // session and the UI can group them into a single card.
    const thread = opts.thread || makeThreadName(prompt);
    const siblings = [...this.jobs.values()].filter((x) => x.thread === thread);
    // Sending the drafted steer (or any reply) answers it: the offer to send it is gone once it has been sent.
    for (const s of siblings) {
      if (!s.pendingSteer) continue;
      s.pendingSteer = null;
      this.emit(s);
    }
    const j = {
      id: randomUUID().slice(0, 8),
      thread,
      turn: siblings.length + 1,
      replyTo: siblings[0]?.id || null,
      reply: Boolean(opts.reply),
      existing: Boolean(opts.existing),
      // True when "existing" means the project's own checkout rather than a worktree: the same directory the
      // reader has open, with no branch of its own.
      baseCheckout: Boolean(opts.baseCheckout),
      // What the card shows. Normally the prompt itself; a wake started by a rule shows the one-line reason
      // while the run's input carries the digest and the instruction (see `opts.prompt` for both).
      prompt: opts.displayPrompt ? String(opts.displayPrompt) : prompt,
      yolo: Boolean(opts.yolo),
      // What caused this turn, when it was not the reader: a subagent delivery the panel collected, say. Shown on the
      // turn head so a turn that answers children is not mistaken for the reader's own instruction.
      origin: opts.origin && typeof opts.origin === "object" ? opts.origin : null,
      model: opts.model || this.modelFor(thread) || null,
      status: "starting",
      runId: null,
      lines: [],
      // Files this agent produced for the reader (docs, scripts, keys) — not code it edited.
      artifacts: [],
      // Documents the reader attached to THIS turn. The gateway never sees a list: an attachment's
      // path rides inside the prompt text, because its runs API has no field for one. This is for the
      // card, so the turn can say what it was handed.
      attachments: normaliseAttachments(opts.attachments),
      worktree: opts.worktreeName || null,
      cwd: null,
      sessionId: thread,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      fatal: null,
      worktreePath: null,
      // The worktree that OWNS this agent: the tree it was started in ("existing") or the tree this
      // panel just made for it. null means homeless: it runs somewhere that is not one of our
      // worktrees, so it lives in the Agents panel instead of under a row.
      ownerPath: opts.ownerPath ? String(opts.ownerPath).replace(/\\/g, "/").replace(/\/+$/, "") : null,
      ownerPending: Boolean(opts.ownerPending),
      maxTurns: opts.maxTurns || null,
      budget: opts.budget || null,
      tokens: null,
      // Context / cache / latency readout; filled in from the gateway's `run.usage` events.
      stats: null,
      durationMs: null,
      error: null,
      timer: null,
      poller: null,
      ctrl: null,
    };
    this.jobs.set(j.id, j);

    let cwd = opts.cwd || this.config.defaultCwd || process.cwd();
    // The directory the run was STARTED from — the project, not the tree `-w` used to be given.
    // The board needs it to place the new worktree under its own row before a discovery pass.
    j.projectPath = cwd;

    // A run needs a directory, so a fresh agent needs its tree before the request goes out.
    if (!opts.reply && !opts.existing && opts.worktree !== false) {
      j.worktree = j.worktree || path.basename(cwd);
      try {
        const made = await this.makeWorktree(cwd, prompt);
        cwd = made.path;
        j.branch = made.branch;
        j.worktreePath = made.path;
        j.ownerPath = made.path;
        j.ownerPending = false;
        this.push(j, { kind: "raw", text: `worktree created: ${made.path} (branch ${made.branch})` });
        this.emit(j);
        this.emitJobs();
      } catch (e) {
        j.status = "failed";
        j.error = `could not create a worktree in ${cwd}: ${String((e && e.message) || e)}`;
        j.endedAt = new Date().toISOString();
        this.push(j, { kind: "raw", text: j.error });
        // A spawn that never reached the gateway still finishes: a notice has to be able to say that the run
        // failed before it started, not leave the thread looking like one that never ended.
        this.finalise(j);
        this.emit(j);
        return this.summary(j);
      }
    }
    j.cwd = cwd;

    // The commit this turn starts from: what "left commits" is counted against once it ends. Only the panel
    // can record it — by the time a notice is built the tree may hold new commits, or be gone.
    j.baseSha = await this.headSha(cwd);

    return this.transportFor(j).create(j, { prompt, opts, thread, cwd });
  }

  // Hard wall-clock cap, same contract as before: a runaway agent does not outlive its budget by
  // much. Stopping is cooperative, so the run settles through its own terminal event.
  armRuntimeCap(j) {
    j.timer = setTimeout(() => {
      if (j.status === "running") {
        j.error = `killed: exceeded ${this.maxRuntimeSeconds}s panel cap`;
        // The panel ending the run is a fact only the panel has: the gateway will report it cancelled, and a
        // cancellation without a reason reads as "someone stopped it", not as "it ran away".
        this.terminate(j, "cap", { seconds: this.maxRuntimeSeconds });
        void this.stop(j.id);
      }
    }, this.maxRuntimeSeconds * 1000);
  }

  // Subscribe to the run's event stream. A dropped stream is not a lost run: the transport keeps asking
  // for the run's status until it reaches a terminal state.
  async follow(j) {
    return this.transportFor(j).follow(j);
  }

  // The gateway relays each delegated child's lifecycle onto the parent's own stream: `subagent.start` when a
  // child is kicked off, `subagent.complete` with its status and duration. Nothing else about a child arrives -
  // its tools run on its own session - but that is enough to say how many are out and whether they still are.
  trackSubagent(j, evt) {
    const ids = [evt.subagent_id, evt.child_session_id, evt.delegation_id].filter(Boolean).map(String);
    const index = Number.isFinite(Number(evt.task_index)) ? Number(evt.task_index) : null;
    const running = evt.event === "subagent.start";
    if (!j.subagents) j.subagents = [];
    // A start and its complete can carry different identity fields (the child's session id is only known once
    // it exists), so match on any id, or on the task index while that entry is still open.
    let entry = j.subagents.find(
      (s) => ids.some((id) => s.ids.includes(id)) || (index !== null && s.index === index && s.running),
    );
    if (!entry) {
      entry = { ids: [], sessionId: null, index, goal: "", running, status: "running", at: Date.now(), duration: null };
      j.subagents.push(entry);
    }
    entry.ids = [...new Set([...entry.ids, ...ids])];
    // The child's session is what its console can be read by; the other ids are not session names.
    if (evt.child_session_id) entry.sessionId = String(evt.child_session_id);
    if (entry.index === null && index !== null) entry.index = index;
    entry.goal = String(evt.goal || evt.preview || entry.goal || "").replace(/\s+/g, " ").trim().slice(0, 200);
    entry.running = running;
    entry.status = running ? "running" : String(evt.status || "done");
    entry.at = Date.now();
    if (!running) entry.duration = Number(evt.duration_seconds) || entry.duration || null;
    this.emit(j);
  }

  consume(j, evt) {
    // When this run last said anything. The restart sweep uses it to tell a quiet run from one whose
    // stream this panel no longer holds.
    j.lastEventAt = Date.now();
      // A produced file names itself in two places: the call (`write_file · <path>`) and the result JSON
    // ({resolved_path, bytes_written}). The result is often empty on this gateway, so both are read -
    // before the console lines are built, since those drop the JSON down to its text.
    if (evt.event === "tool.started") this.noteArtifactCall(j, evt);
    if (evt.event === "tool.completed") this.noteArtifact(j, evt);
    if (evt.event === "subagent.start" || evt.event === "subagent.complete") this.trackSubagent(j, evt);
    for (const line of linesForEvent(evt)) this.push(j, line);
    if (evt.event === "run.usage") {
      // Live snapshot pushed at each tool boundary (context / cache / latency / throughput). Merge, so
      // a field this snapshot does not carry keeps the previous real value instead of blanking.
      const stats = statsFromUsage(evt.usage);
      if (stats) {
        j.stats = { ...(j.stats || {}), ...stats };
        this.emit(j);
      }
    }
    if (evt.event === "run.steered") this.onEvent({ type: "job", job: this.summary(j) });
    // A run that hits a flagged command parks at ``waiting_for_approval`` and emits this once. The
    // card carries the request (redacted command + the choices the host allows) so the answer can be
    // posted back to the same run instead of going through the CLI's TTY prompt.
    if (evt.event === "approval.request") {
      // How long the reader has. Unlike `clarify.request` (which names `timeout_s` when the gateway registered
      // the prompt for a local viewer) an approval request carries no window, so it comes from the same
      // `approvals.timeout` the gateway reads — and the deadline is measured from the EVENT's own clock, not
      // from arrival: every `_run_event` carries `timestamp`, and a request replayed out of the run's buffer
      // arrives late, so a deadline counted from arrival would quietly extend a window the gateway has closed.
      const arrival = Date.now();
      const fromEvent = Number(evt.timeout_seconds ?? evt.timeoutSeconds ?? evt.timeout_s);
      const seconds = Number.isFinite(fromEvent) && fromEvent > 0 ? fromEvent : this.approvalWindowSeconds();
      const stamped = Number(evt.timestamp) * 1000;
      const started = Number.isFinite(stamped) && stamped > 0 && stamped <= arrival ? stamped : arrival;
      j.approval = {
        // The SSE payload does not always name the prompt (this gateway's approval.request carries no
        // request_id), so keep whatever identifier it does offer and resolve the rest from the run's
        // pending_controls before answering.
        requestId: [evt.request_id, evt.requestId, evt.prompt_id, evt.promptId, evt.id].find((v) => typeof v === "string" && v) || null,
        command: String(evt.command || evt.description || ""),
        choices: Array.isArray(evt.choices) && evt.choices.length ? evt.choices : ["once", "deny"],
        // When the gateway started waiting and when it will stop: the card draws a countdown from these, and
        // the sweep in `sweepApprovals` takes the box away at `deadline` instead of leaving a prompt up that
        // can only answer `approval_not_pending`.
        timeoutSeconds: seconds,
        at: new Date(started).toISOString(),
        deadline: started + seconds * 1000,
      };
      this.emit(j);
    }
    // The agent's `clarify` tool parks the run on a question the same way a flagged command parks it
    // on an approval. The gateway publishes the prompt as `clarify.request` with its own prompt id, so
    // the card can carry it and answer through `/v1/runs/{id}/clarify`. Choices arrive already carrying
    // the tool's "(Recommended)" suffix; the panel renders them verbatim, so a label can never drift
    // from what the tool offered.
    if (evt.event === "clarify.request") {
      // How long the reader has. The event carries `timeout_s` only when the gateway registered the prompt
      // for a local viewer; an API run's does not, so fall back to the window the gateway is configured
      // with (0/negative there = it waits indefinitely, which gets no countdown). The deadline is measured
      // from arrival, so it is a second or two optimistic — the card says "~".
      const fromEvent = Number(evt.timeout_s);
      let windowSeconds = Number.isFinite(fromEvent) && fromEvent > 0 ? fromEvent : 0;
      if (!windowSeconds && typeof this.clarifyWindow === "function") {
        try {
          const win = this.clarifyWindow();
          if (win && !win.unlimited && Number(win.seconds) > 0) windowSeconds = Number(win.seconds);
        } catch {
          /* no countdown is better than a wrong one */
        }
      }
      const at = Date.now();
      j.question = {
        requestId: [evt.prompt_id, evt.request_id, evt.id].find((v) => typeof v === "string" && v) || null,
        question: clarifyText(evt.question),
        choices: (Array.isArray(evt.choices) ? evt.choices : []).map(String).filter((c) => c.trim()),
        multiSelect: Boolean(evt.multi_select),
        // null when there is no known window: the card then draws no bar at all.
        timeoutSeconds: windowSeconds || null,
        deadline: windowSeconds ? at + windowSeconds * 1000 : null,
        at: new Date(at).toISOString(),
      };
      j.questionDone = null;
      this.emit(j);
    }
    // `clarify.settled` is published when the prompt leaves the run's pending controls: answered here,
    // answered on another surface, withdrawn by a stop, or timed out. Either way the box must go, and a
    // box that was never answered here says so instead of looking like a decision the reader made.
    if (evt.event === "clarify.settled") {
      const id = String(evt.prompt_id || evt.request_id || "");
      if (j.question && (!id || !j.question.requestId || id === j.question.requestId)) {
        if (!j.questionDone) j.questionDone = { answer: "", at: new Date().toISOString(), closed: true };
        j.question = null;
        this.emit(j);
      }
    }
    if (evt.event === "approval.responded") {
      // Keep ONE line of what was decided, under the turn it belonged to — the prompt itself is
      // gone the moment it is answered.
      j.approvalDone = {
        choice: String(evt.choice || ""),
        // The prompt is cleared the moment the answer is accepted, so keep whichever copy still
        // remembers what was approved — otherwise the collapsed line loses the command when the
        // panel was the surface that answered.
        command: j.approval?.command || j.approvalDone?.command || "",
        at: new Date().toISOString(),
      };
      j.approval = null;
      this.emit(j);
    }
    // The gateway names its terminal events `run.completed` / `run.failed` / `run.cancelled` / `run.interrupted`
    // — the same fact `hermes chat --format stream-json` ended every turn with as `{"type":"result",
    // "exit_code":n}`. The prefix has to come off before the match: without it the ONE event that ends a turn
    // is the one branch that never fires, every run settles on the 15s poll instead, and an exit code carried
    // by the result event alone is never read. (Measured on a stub gateway: every turn settled on the poll
    // clock, one tick late; the real gateway hid it by closing the stream, which makes `follow()` poll at once.)
    const terminal = String(evt.event || "").startsWith("run.") ? String(evt.event).slice(4) : "";
    if (TERMINAL_RUN.has(terminal)) {
      const status = terminal;
      // A run the gateway ended on its own — a shutdown, or a stop from another surface. Recorded as the
      // process's own termination so the notice says who ended it instead of guessing from a status word.
      if (status === "interrupted") this.terminate(j, "gateway", { detail: evt.error || "" });
      this.scanTurnUrls(j);
      this.push(j, runResultLine(status, evt));
      this.settle(j, status, evt);
    }
    // A run-level error can arrive without one of the terminal events (a stream that dies mid-turn),
    // and it leaves the turn unusable: drop the question so no reload resurrects a dead approval.
    if (evt.event === "error" && j.approval) {
      j.approval = null;
      this.emit(j);
    }
    // Same for a question: a dead turn cannot take the answer, and a box left offering one is worse
    // than no box. `questionDone` keeps the record that it was never answered.
    if (evt.event === "error" && j.question) {
      j.questionDone = { answer: "", at: new Date().toISOString(), closed: true };
      j.question = null;
      this.emit(j);
    }
  }

  settle(j, runStatus, run = {}) {
    if (j.status !== "running" && j.status !== "starting") return;
    j.status = TERMINAL_STATUS[runStatus] || "failed";
    // The run's own last word, when its terminal result carried one. It is NOT the same as the transcript:
    // the gateway publishes the finished answer on the terminal event, and a turn can end with prose that
    // never arrived as a delta.
    const said = String(run.output ?? "").trim();
    if (said) j.finalMessage = said;
    if (run.usage) j.tokens = { total: run.usage.total_tokens ?? null, input: run.usage.input_tokens ?? null, output: run.usage.output_tokens ?? null };
    const finalStats = statsFromUsage(run.usage);
    if (finalStats) {
      j.gatewayStats = { ...(j.gatewayStats || {}), ...finalStats };
      j.stats = { ...(j.stats || {}), ...finalStats };
    }
    // Throughput needs the finished turn's output tokens and wall clock, both only true here.
    this.fillStats(j);
    if (run.error) j.error = j.error || String(run.error);
    if (run.pending_steer) j.error = j.error || `steer arrived after the last tool boundary: ${String(run.pending_steer).slice(0, 160)}`;
    j.endedAt = new Date().toISOString();
    j.approval = null;
    // A question cannot outlive its turn either: the clarify waiter is gone once the turn returns.
    if (j.question) j.questionDone = j.questionDone || { answer: "", at: new Date().toISOString(), closed: true };
    j.question = null;
    clearTimeout(j.timer);
    clearInterval(j.poller);
    clearInterval(j.statsTimer);
    j.statsTimer = null;
    try {
      j.ctrl?.abort();
    } catch {
      /* already closed */
    }
    this.onLog(`run ${j.id} ${j.status}${j.runId ? ` (${j.runId})` : ""}`);
    // The exit status, the duration and the notice payload, from the run's terminal result and whatever this
    // panel did to it. The tree is measured after it: git is the slow part and the card does not wait for it.
    this.finalise(j, { runStatus, run });
    this.emit(j);
    // Anything the agent wrote with a shell only shows up in git's untracked list once the turn is
    // over, so the artifacts button is filled in here as well as from write_file events.
    void this.sweepArtifacts(j);
    void this.measureTree(j);

    // A steer that arrived after the agent's last tool boundary is handed back instead of consumed. It used to be
    // replayed as a new turn on the spot, which started a second answer while the reader believed they were
    // correcting the first - and, with a subagent still out, before its result could even exist. It now comes back
    // to the reply box as a draft, so sending it is a decision rather than a surprise.
    const pending = String(run.pending_steer || "").trim();
    if (pending) {
      j.pendingSteer = { text: pending, at: Date.now() };
      this.push(j, { kind: "dim", text: "⇢ that steer missed the turn's last tool boundary — it is back in the reply box, unsent" });
    }
  }

  // Ask the status endpoint for the truth and settle on it. Covers a stream that never opened and a
  // terminal event that was missed, so a card cannot stay "running" forever.
  async poll(j) {
    return this.transportFor(j).poll(j);
  }

  // A run lives in the gateway, not in this process, so a restart tells this panel nothing about the turn it lost:
  // `load()` calls that turn interrupted because the panel can no longer steer it, not because the agent stopped.
  // Ask the run's own endpoint before that verdict stands. Measured live on 7473: a deploy turn the panel gave up on
  // at its 03:11 restart finished at 03:18 and printed its answer, and at 04:17 the card still read "interrupted …
  // may still be live", its clock counting 79 minutes, while the gateway had said `completed` all along.
  async reconcileRestored() {
    const lost = [...this.jobs.values()].filter((j) => j.status === "interrupted" && j.runId && !j.reconciled);
    const done = [];
    for (const j of lost) {
      const run = await this.runStatus(j);
      if (!run) continue; // gateway down: the interrupted verdict stands, and it is the safe one
      if (TERMINAL_RUN.has(run.status)) {
        this.adoptRun(j, run);
        done.push(j.id);
      } else {
        // Still live, and this card still cannot reach it. Say exactly that, rather than implying it died.
        j.error = `the panel restarted while this was running — the gateway still has run ${j.runId}, so it will finish on its own, but this card cannot steer it`;
        j.liveElsewhere = true;
        this.finalise(j);
        this.onLog(`run ${j.id} is still live in the gateway (${j.runId})`);
        this.emit(j);
        done.push(j.id);
      }
    }
    if (done.length) this.schedulePersist();
    return done;
  }

  // The run's own answer to "what happened to it", or null when the gateway cannot be asked.
  async runStatus(j) {
    return this.transportFor(j).runStatus(j);
  }

  // A turn this panel was not watching when it ended. The status is the gateway's; the duration is the last moment
  // this panel saw it work, because nobody here saw the end; and the answer the gateway kept is put back on the
  // console, or a finished turn would show a tail that stops at a tool call and reads as if it died there.
  adoptRun(j, run) {
    j.status = TERMINAL_STATUS[run.status] || "failed";
    j.reconciled = true;
    j.error = "";
    if (run.usage) j.tokens = { total: run.usage.total_tokens ?? null, input: run.usage.input_tokens ?? null, output: run.usage.output_tokens ?? null };
    const finalStats = statsFromUsage(run.usage);
    if (finalStats) {
      j.gatewayStats = { ...(j.gatewayStats || {}), ...finalStats };
      j.stats = { ...(j.stats || {}), ...finalStats };
    }
    j.endedAt = j.endedAt || lastSeenIso(j);
    this.push(j, {
      kind: "result",
      text: `run ${run.status} in the gateway · this panel lost the stream at a restart and last saw it at ${new Date(j.endedAt).toLocaleTimeString()}`,
    });
    const out = String(run.output || "").trim();
    if (out) {
      j.finalMessage = out;
      this.push(j, { kind: "text", text: out });
    }
    this.fillStats(j);
    // The run's own answer decides the exit status here, exactly as it does on the stream: the panel lost the
    // stream, not the fact of what happened.
    this.finalise(j, { runStatus: run.status, run });
    this.onLog(`reconciled run ${j.id} -> ${j.status} (${j.runId})`);
    this.emit(j);
    void this.measureTree(j);
  }

  // ---- a gateway restart this panel did not ask for --------------------------------------------
  // A run lives in the gateway. When the gateway is replaced its in-memory runs are gone: the panel's
  // event stream drops and the run's own endpoint answers 404 while /v1/capabilities answers fine. A run
  // that stops reporting is therefore either finished (take the gateway's verdict) or lost (interrupt it)
  // — and a card may never be left with neither. Nothing here touches a run without a run id: there would
  // be nothing to ask about.

  // Every run this panel believes is going, as the store's own objects (a summary drops the fields the
  // control calls need).
  runningJobs() {
    return [...this.jobs.values()].filter((j) => j.status === "running" || j.status === "starting");
  }

  // What the gateway says about one run, and whether it says anything at all. `known: false` IS the answer
  // here: the gateway is up and has no record of this run id any more.
  async runProbe(j) {
    return this.transportFor(j).runProbe(j);
  }

  // One terminal status, taken exactly once, for a run this panel can no longer watch. The restart is
  // recorded as the termination, so the notice says who ended it instead of guessing from a status word,
  // and a run that already settled is never rewritten.
  markInterruptedByRestart(j, { by = "gateway", detail = "" } = {}) {
    if (!j) return false;
    if (j.status !== "running" && j.status !== "starting") return false;
    this.terminate(j, by, { detail: detail || undefined });
    j.status = "interrupted";
    j.endedAt = j.endedAt || lastSeenIso(j);
    j.error = `the ${by} restarted while this was running${j.runId ? ` (run ${j.runId})` : ""}`;
    this.push(j, { kind: "result", text: `${j.error} — this panel has no stream for it any more` });
    clearTimeout(j.timer);
    clearInterval(j.poller);
    clearInterval(j.statsTimer);
    j.statsTimer = null;
    try {
      j.ctrl?.abort();
    } catch {
      /* already closed */
    }
    this.finalise(j);
    this.emit(j);
    this.onLog(`run ${j.id} interrupted by a ${by} restart (${j.runId || "no run id"})`);
    return true;
  }

  // Runs that stopped reporting while this panel is still up. Called from the server's watchdog. Returns
  // the runs it gave a terminal status to, which the caller wakes the assistant about — once.
  async sweepOrphanedRuns() {
    const watching = this.runningJobs().filter((j) => j.runId);
    if (!watching.length) return [];
    // Only judge a run once the gateway itself answers: while it is down there is nothing to ask, and a
    // restart in flight must not be read as a lost run.
    const t = await this.probe({ fresh: true });
    if (!t.reachable) return [];
    const lost = [];
    for (const j of watching) {
      const p = await this.runProbe(j);
      if (p.known === false) {
        if (this.markInterruptedByRestart(j, { by: "gateway", detail: "the gateway restarted and no longer has this run" })) lost.push(j);
        continue;
      }
      if (p.known === true && p.run) {
        if (TERMINAL_RUN.has(String(p.run.status))) {
          this.adoptRun(j, p.run);
          continue;
        }
        // Still running in the gateway, but this panel lost the stream: re-attach rather than writing the
        // turn off, once.
        if (j.streamOpen === false && !j.reattached) {
          j.reattached = true;
          this.onLog(`run ${j.id}: the gateway still has this run and the stream was lost — re-attaching`);
          void this.follow(j);
        }
      }
    }
    if (lost.length) {
      await Promise.all(lost.map((j) => this.measureTree(j).catch(() => {})));
      this.schedulePersist();
    }
    return lost;
  }

  // A turn's results were delivered back to it (by the panel's collect). Persisted with the job so the
  // offer does not come back on the next reload.
  markCollected(turnId, collectedBy) {
    const j = this.jobs.get(String(turnId || ""));
    if (!j) return false;
    j.collected = { at: new Date().toISOString(), by: collectedBy || null };
    this.emit(j);
    this.schedulePersist();
    return true;
  }

  // ---- steering / stopping -------------------------------------------------------------
  // The whole reason for this transport: a running turn can be corrected without starting a new one.
  async steer(id, text) {
    const j = this.jobs.get(String(id || ""));
    const clean = String(text ?? "").trim();
    if (!j) return { ok: false, error: "unknown job" };
    if (!clean) return { ok: false, error: "steer text is required" };
    if (j.status !== "running" || !j.runId) return { ok: false, error: `run is not running (${j.status})` };
    return this.transportFor(j).steer(j, clean);
  }

  // What a control call has to carry to be read at all: the prompt id and execution generation the backend
  // fences its control calls on.
  async controlContext(j, kind = "approval") {
    return this.transportFor(j).controlContext(j, kind);
  }

  // The generation alone, for callers that only need it.
  async executionGeneration(j) {
    return (await this.controlContext(j)).generation;
  }

  // Answer the approval a parked run is waiting on. The choice must be one the host offered: the
  // panel mirrors `choices` rather than inventing its own, and the gateway re-validates it anyway.
  async approve(id, choice, requestId) {
    const j = this.jobs.get(String(id || ""));
    if (!j || !j.runId) return { ok: false, error: "unknown job" };
    const pick = String(choice || "").trim().toLowerCase();
    const offered = j.approval?.choices || [];
    // Nothing parked on this turn at all: it was answered, it expired, or the turn moved on. A stale page or a
    // second client pressing a button the panel has already taken away deserves the honest answer, not a lecture
    // about choice names.
    if (!offered.length) {
      return {
        ok: false,
        gone: true,
        code: "approval_expired",
        error: "that approval is already settled — there is nothing left to answer here",
      };
    }
    if (!offered.includes(pick)) return { ok: false, error: `choice must be one of: ${offered.join(", ")}` };
    // The window may have closed since the box was drawn — the sweep runs on its own clock and the page can be a
    // repaint behind. Answering now would spend a round trip to be told the request is gone, and the reader would
    // still be looking at a dead prompt, so the panel says it here and takes the box away.
    const deadline = Number(j.approval?.deadline);
    if (Number.isFinite(deadline) && Date.now() >= deadline) {
      const seconds = j.approval?.timeoutSeconds || APPROVAL_WINDOW_DEFAULT;
      this.expireApproval(j, Date.now(), "expired");
      return {
        ok: false,
        gone: true,
        code: "approval_expired",
        error: `the gateway's ${seconds}s window for this approval had already closed — it denied the command and the agent carried on without it`,
      };
    }
    return this.transportFor(j).approve(j, pick, requestId);
  }

  // Answer a question the agent's `clarify` tool is blocked on. The gateway's body is exactly
  // {request_id, execution_generation, answer} on `/v1/runs/{id}/clarify`; `answer` is a string even for a
  // multi-select question (the tool decodes a JSON array), and the gateway refuses anything over 16 KB.
  // Same fence and same self-heal as an approval: a card left open across a generation change re-reads and
  // retries once instead of showing the reader a protocol code.
  async answerQuestion(id, answer, requestId) {
    const j = this.jobs.get(String(id || ""));
    if (!j || !j.runId) return { ok: false, error: "unknown job" };
    const multi = Array.isArray(answer);
    const text = (multi ? JSON.stringify(answer.map((a) => String(a))) : String(answer ?? "")).trim();
    if (!text) return { ok: false, error: "an answer is required" };
    if (text.length > 16384) return { ok: false, error: "that answer is longer than the gateway accepts (16384 characters)" };
    const shown = multi ? JSON.parse(text).join(" · ") : text;
    return this.transportFor(j).clarify(j, text, shown, requestId);
  }

  // The box collapses the moment the POST is accepted; the stream's `clarify.settled` only confirms it, and
  // it must not overwrite the answer that was actually sent.
  noteAnswered(j, shown) {
    this.push(j, { kind: "dim", text: `⇢ answered the agent's question: ${String(shown).slice(0, 240)}` });
    j.questionDone = { answer: String(shown), at: new Date().toISOString() };
    j.question = null;
    this.emit(j);
    return { ok: true, runId: j.runId, answer: shown };
  }

  async stop(id) {
    const j = this.jobs.get(String(id || ""));
    if (!j || !j.runId || j.status !== "running") return false;
    // Who ended it, recorded before the request goes out: the run settles as `cancelled`, and the notice has
    // to be able to say that the panel asked for this rather than the turn having failed on its own.
    this.terminate(j, "reader");
    return this.transportFor(j).stop(j);
  }

  cancel(id) {
    const j = this.jobs.get(String(id || ""));
    if (!j || j.status !== "running") return false;
    void this.stop(j.id);
    return true;
  }

  // ---- conversation plumbing -----------------------------------------------------------
  // The first turn of a conversation (its cwd, model are the defaults for replies).
  firstOfThread(thread) {
    if (!thread) return null;
    return [...this.jobs.values()].filter((j) => j.thread === thread).sort((a, b) => (a.turn || 1) - (b.turn || 1))[0] || null;
  }

  // Where each agent is actually working, for the panel's own row <-> agent mapping.
  // Hermes' own title and last-use time for a thread, both null when the session has no row.
  sessionInfoFor(thread) {
    if (!thread) return { title: null, at: null };
    try {
      const dbPath = path.join(hermesHome(), "state.db");
      const hit = sessionIndex({ dbPath }).get(thread) || null;
      if (hit?.title) return hit;
      // Hermes names a session a moment after its first turn starts. A 60s index cache is long enough for a card
      // created here to spend its whole life titleless, so ask again on a short cache while the answer is "".
      return sessionIndex({ dbPath, maxAgeMs: 3000 }).get(thread) || { title: null, at: null };
    } catch {
      return { title: null, at: null };
    }
  }

  // Threads the panel actually executed a turn in. A card that merely owns a session the panel did NOT
  // start — one it revived or adopted — does not make that session panel-owned: it is still an external
  // Hermes session, and the row has to keep reporting it as `⧉ hermes`/`n hermes`.
  panelRunThreads() {
    const out = new Set();
    for (const j of this.jobs.values()) if (j.runId && j.thread) out.add(j.thread);
    return out;
  }

  agentPaths() {
    const map = new Map();
    const add = (p, j) => {
      if (!p) return;
      const key = String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const cur = map.get(key) || { running: 0, total: 0, threads: [], ids: [] };
      if (cur.ids.includes(j.id)) return; // ownerPath and worktreePath are usually the same tree
      cur.ids.push(j.id);
      cur.total += 1;
      if (j.status === "running" || j.status === "starting") cur.running += 1;
      if (!cur.threads.includes(j.thread)) cur.threads.push(j.thread);
      map.set(key, cur);
    };
    for (const j of this.jobs.values()) {
      // Ownership first: an agent belongs to the tree it was made for even if it later reads or
      // writes somewhere else. cwd is only the fallback for jobs created before ownership existed.
      if (j.ownerPath) add(j.ownerPath, j);
      else if (j.existing || j.reply) add(j.cwd, j);
      if (j.worktreePath) add(j.worktreePath, j);
    }
    return map;
  }

  // Move an agent (every turn of its thread) under a worktree, or back to unattached with null.
  setOwner(thread, ownerPath) {
    const mine = [...this.jobs.values()].filter((j) => j.thread === thread);
    if (!mine.length) return { ok: false, error: "unknown thread", turns: 0 };
    const norm = ownerPath ? String(ownerPath).replace(/\\/g, "/").replace(/\/+$/, "") : null;
    for (const j of mine) {
      j.ownerPath = norm;
      j.ownerPending = false;
    }
    this.schedulePersist();
    this.emit(mine[mine.length - 1]);
    return { ok: true, ownerPath: norm, turns: mine.length };
  }

  // Bring a Hermes session back onto the board after the panel lost its record — a reset store, a
  // `✕`, a fresh clone. The session itself never needed reviving: it lives in the gateway, and what
  // the panel lost was the card pointing at it. One record carrying the thread is enough for the
  // reply path (`firstOfThread`) to continue the real conversation, so this deliberately does NOT
  // import a transcript: the tail is shown as history, everything older stays in the gateway.
  revive({ thread, ownerPath, projectPath, cwd, title, prompt, tail, at } = {}) {
    const id = String(thread || "").trim();
    if (!id) return { ok: false, code: "no_session", error: "a session id is required" };
    if (this.firstOfThread(id)) return { ok: false, code: "already", error: "that session is already on the board" };
    const when = at && Number.isFinite(Number(at)) ? new Date(Number(at)).toISOString() : new Date().toISOString();
    const dir = cwd ? String(cwd).replace(/\\/g, "/").replace(/\/+$/, "") : null;
    const said = (role) => [...(tail || [])].reverse().find((m) => m.role === role && m.text)?.text || null;
    const j = {
      id: randomUUID().slice(0, 8),
      thread: id,
      turn: 1,
      replyTo: null,
      reply: false,
      existing: true,
      // The question it was asked, so the card is recognisable at a glance rather than an empty shell.
      prompt: String(prompt || said("user") || title || `revived session ${id.slice(0, 14)}`).slice(0, 2000),
      yolo: false,
      model: null,
      status: "done",
      runId: null,
      lines: [
        {
          kind: "dim",
          text: `revived from the Hermes session store — the conversation itself is in the gateway, so a reply continues it where it stopped${title ? ` · ${title}` : ""}`,
        },
      ],
      artifacts: [],
      worktree: null,
      cwd: dir,
      sessionId: id,
      startedAt: when,
      endedAt: when,
      exitCode: null,
      fatal: null,
      worktreePath: dir,
      ownerPath: ownerPath ? String(ownerPath).replace(/\\/g, "/").replace(/\/+$/, "") : null,
      ownerPending: false,
      projectPath: projectPath || null,
      maxTurns: null,
      budget: null,
      tokens: null,
      durationMs: null,
      error: null,
      timer: null,
      revived: true,
    };
    const last = said("assistant");
    if (last) j.lines.push({ kind: "text", text: last });
    for (const l of j.lines) {
      l.lid = ++lineSeq;
      l.at = when;
    }
    this.jobs.set(j.id, j);
    if (title) this.labels.set(id, String(title).replace(/\s+/g, " ").trim().slice(0, 80));
    this.saveLabels();
    // A thread nobody has a card for means renderConversation() has no element to update, so it
    // falls back to a full render — which is what puts this card under the row that owns it.
    this.emit(j);
    this.emitJobs();
    return { ok: true, job: this.summary(j) };
  }

  clearFinished() {
    for (const [id, j] of [...this.jobs]) if (j.status !== "running") this.jobs.delete(id);
    this.schedulePersist();
  }

  // Forget ONE conversation: every turn of its thread, provided none of them is still running.
  // This drops the panel's record (and the transcript it persisted); the worktree and branch the
  // agent made are untouched — they are git's business, not the panel's.
  clearThread(thread) {
    const mine = [...this.jobs.values()].filter((j) => j.thread === thread);
    const running = mine.filter((j) => j.status === "running" || j.status === "starting");
    if (running.length) return { ok: false, running: running.length, removed: 0 };
    for (const j of mine) this.jobs.delete(j.id);
    this.schedulePersist();
    return { ok: true, removed: mine.length, running: 0 };
  }
}
