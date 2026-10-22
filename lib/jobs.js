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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const pexec = promisify(execFile);
const MAX_LINES = 600;
const TAIL = 60;
const KEEP_JOBS = 80; // persisted conversations, newest first
let lineSeq = 0;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);
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
function hermesHome() {
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

// tool.completed carries the result as a preview (a JSON envelope for terminal, plain text
// otherwise). Unwrap the envelope and hand the first lines to the console so a reader sees what the
// tool actually said instead of a bare "tool · 1.2s".
function toolResultLines(tool, preview, { duration, error } = {}) {
  let body = stripAnsi(preview ?? "");
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const inner = parsed.output ?? parsed.text ?? parsed.stdout ?? parsed.result;
      if (typeof inner === "string") body = inner;
      const exit = parsed.exit_code;
      if (exit !== undefined && exit !== null && exit !== 0) body += `\n(exit ${exit})`;
      if (parsed.error) body += `\n(error: ${parsed.error})`;
    }
  } catch {
    /* not JSON: it is already the text */
  }
  const all = body.split(/\r?\n/).filter((l, i, arr) => l.trim() || (i > 0 && i < arr.length - 1));
  const shown = all.slice(0, MAX_TOOL_LINES).map((l) => l.slice(0, MAX_TOOL_LINE_CHARS));
  const meta = [duration ? `${Number(duration).toFixed(2)}s` : null, error ? "error" : null].filter(Boolean).join(" · ");
  const out = [{ kind: "tool-out", text: `  ↳ ${tool || "tool"}${meta ? ` · ${meta}` : ""}`, json: null }];
  for (const l of shown) out.push({ kind: "tool-out", text: l, json: null });
  if (all.length > shown.length) out.push({ kind: "tool-out", text: `… ${all.length - shown.length} more line(s)`, json: null });
  return out;
}

// One SSE event -> the console lines the browser already knows how to draw.
function linesForEvent(evt) {
  switch (evt.event) {
    case "tool.started": {
      const p = typeof evt.preview === "string" ? evt.preview.replace(/\s+/g, " ").trim().slice(0, 240) : "";
      return [{ kind: "tool", text: `▸ ${evt.tool || "tool"}${p ? ` · ${p}` : ""}` }];
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
    case "subagent.start":
      return [{ kind: "raw", text: `↳ subagent started${evt.preview ? `: ${String(evt.preview).slice(0, 160)}` : ""}` }];
    case "subagent.complete":
      return [{ kind: "raw", text: `↳ subagent ${evt.status || "finished"}${evt.preview ? `: ${String(evt.preview).slice(0, 160)}` : ""}` }];
    case "error":
      return [{ kind: "raw", text: `error: ${String(evt.error || evt.message || "unknown").slice(0, 300)}` }];
    default:
      return [];
  }
}

function runResultLine(status, run) {
  const tk = run?.usage || {};
  const bits = [
    `run ${status}`,
    tk.total_tokens ? `tokens ${tk.total_tokens} (in ${tk.input_tokens ?? "?"} / out ${tk.output_tokens ?? "?"})` : null,
    run?.pending_steer ? `pending steer: ${String(run.pending_steer).slice(0, 120)}` : null,
  ].filter(Boolean);
  return { kind: "result", text: bits.join(" · "), json: run || null };
}

// ---- registry ------------------------------------------------------------------------
export class Jobs {
  constructor({ config = {}, onEvent = () => {}, onLog = log } = {}) {
    this.config = config;
    this.onEvent = onEvent;
    this.onLog = onLog;
    this.jobs = new Map();
    this.api = apiConfig(config);
    if (!this.api.key) {
      const fromFile = readKeyFromEnvFile();
      if (fromFile) this.api.key = fromFile;
    }
    this.transport = { url: this.api.url, reachable: null, checkedAt: 0, capabilities: null, error: null, keyed: Boolean(this.api.key) };
    this.maxRuntimeSeconds = Number(config.jobMaxRuntimeSeconds) || 3600;
    // The registry is persisted so a restart does not lose the fact that an agent ran in a
    // worktree (the row's agent chip is derived from it) and does not empty the Agents list.
    this.storePath = config.jobsFile || null;
    // Session labels (the panel's own display names) live beside the job store: renaming must never
    // touch the Hermes thread id, which is how the thread is resumed.
    this.labelsPath = this.storePath ? path.join(path.dirname(this.storePath), "labels.json") : null;
    this.labels = this.loadLabels();
    this.persistTimer = null;
    this.load();
  }

  // ---- gateway reachability ------------------------------------------------------------
  headers(extra = {}) {
    const h = { "Content-Type": "application/json", ...extra };
    if (this.api.key) h.Authorization = `Bearer ${this.api.key}`;
    return h;
  }

  // Cheapest possible answer to "can this panel run anything right now?" — the settings surface and
  // the spawn route both ask before promising a job.
  async probe({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.transport.checkedAt && now - this.transport.checkedAt < 15_000) return this.transport;
    if (!this.api.key) {
      this.transport = { ...this.transport, reachable: false, checkedAt: now, keyed: false, error: "no API_SERVER_KEY (add it to the Hermes .env, or apiServer.key in config.json)" };
      return this.transport;
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${this.api.url}/v1/capabilities`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const caps = await res.json();
      const features = caps.features || {};
      this.transport = {
        url: this.api.url,
        reachable: true,
        checkedAt: now,
        keyed: true,
        error: null,
        capabilities: {
          runs: Boolean(features.run_submission),
          events: Boolean(features.run_events_sse),
          steer: Boolean(features.run_steer),
          stop: Boolean(features.run_stop),
          approval: Boolean(features.run_approval_response),
          // The local gateway patch adds these. A stock gateway ignores the fields silently, so the
          // panel says which of them this run will actually honour.
          runCwd: Boolean(features.run_cwd),
          runBudget: Boolean(features.run_budget),
          maxTurns: Boolean(features.max_turns),
          version: caps.version || null,
        },
      };
    } catch (e) {
      this.transport = { ...this.transport, reachable: false, checkedAt: now, keyed: true, error: String((e && e.message) || e) };
    }
    return this.transport;
  }

  transportInfo() {
    return { ...this.transport };
  }

  // ---- persistence ---------------------------------------------------------------------
  load() {
    if (!this.storePath || !existsSync(this.storePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.storePath, "utf8"));
      for (const j of saved.jobs || []) {
        // A run lives in the gateway, not in this process, so a panel restart does not necessarily
        // mean the agent stopped — but the panel has lost its stream and cannot steer safely. Say
        // exactly that instead of claiming the run ended.
        if (j.status === "running" || j.status === "starting") {
          j.status = "interrupted";
          j.error = j.error || `the panel restarted while this was running${j.runId ? ` (run ${j.runId} may still be live in the gateway)` : ""}`;
        }
        j.child = null;
        j.timer = null;
        j.poller = null;
        this.jobs.set(j.id, j);
        for (const l of j.lines || []) if (l.lid && l.lid > lineSeq) lineSeq = l.lid;
      }
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
            id: j.id, thread: j.thread, turn: j.turn, reply: j.reply, existing: j.existing,
            prompt: j.prompt, cwd: j.cwd, worktree: j.worktree, worktreePath: j.worktreePath,
            // Ownership has to survive a restart: without these, every agent came back "unattached"
            // after a reload even though it was created and is still running in a worktree.
            ownerPath: j.ownerPath || null,
            ownerPending: Boolean(j.ownerPending),
            projectPath: j.projectPath || null,
            runId: j.runId || null,
            approvalDone: j.approvalDone || null,
            sessionId: j.sessionId, status: j.status, exitCode: j.exitCode, fatal: j.fatal,
            startedAt: j.startedAt, endedAt: j.endedAt, model: j.model, yolo: j.yolo,
            budget: j.budget, maxTurns: j.maxTurns, tokens: j.tokens, error: j.error,
            durationMs: j.durationMs, lines: (j.lines || []).slice(-120),
            // The produced-files list has to survive a restart too: it is the only way back to a
            // document the agent wrote three sessions ago.
            artifacts: j.artifacts || [],
          }));
        mkdirSync(path.dirname(this.storePath), { recursive: true });
        writeFileSync(this.storePath, JSON.stringify({ savedAt: new Date().toISOString(), jobs }, null, 0));
      } catch {
        /* persistence is a convenience: never let it break a run */
      }
    }, 700);
  }

  summary(j) {
    return {
      id: j.id,
      status: j.status,
      // The card used to show a pid; a run is addressed by its run id instead.
      pid: null,
      runId: j.runId || null,
      prompt: j.prompt,
      yolo: j.yolo,
      model: j.model,
      worktree: j.worktree,
      worktreePath: j.worktreePath || null,
      ownerPath: j.ownerPath || null,
      ownerPending: Boolean(j.ownerPending),
      projectPath: j.projectPath || null,
      cwd: j.cwd || null,
      thread: j.thread,
      turn: j.turn,
      // The panel's display name for this session, if it has been renamed.
      label: this.labelFor(j.thread),
      reply: Boolean(j.reply),
      existing: Boolean(j.existing),
      replyTo: j.replyTo || null,
      maxTurns: j.maxTurns || null,
      budget: j.budget || null,
      sessionId: j.sessionId,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      exitCode: j.exitCode,
      tokens: j.tokens,
      durationMs: j.durationMs,
      transport: "runs",
      error: j.error || null,
      // Files this agent produced that a reader would open (docs, scripts, keys), oldest first.
      artifacts: j.artifacts || [],
      // Present only while the run is parked on a flagged command; the card renders its buttons
      // from `choices`, so the panel can never offer a choice the host did not allow.
      approval: j.approval || null,
      // …and once answered, one line recording what was decided (the prompt text is kept too, so
      // the collapsed line can say what it approved without a second lookup).
      approvalDone: j.approvalDone || null,
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
        return;
      }
      j.curText = { kind: "text", lid: line.lid, text: fragment.replace(/^\s*\n+/, ""), at: line.at };
      j.lines.push(j.curText);
      if (j.lines.length > MAX_LINES) j.lines.splice(0, j.lines.length - MAX_LINES);
      this.onEvent({ type: "jobline", id: j.id, line: { ...j.curText, mode: "new" } });
      return;
    }
    if (line.kind === "result" || line.kind === "init") j.curText = null;
    j.lines.push(line);
    if (j.lines.length > MAX_LINES) j.lines.splice(0, j.lines.length - MAX_LINES);
    this.onEvent({ type: "jobline", id: j.id, line });
  }

  // ---- artifacts ------------------------------------------------------------------------
  // Record one produced file, once. Paths are normalized to forward slashes so the same file
  // reported by write_file and by git is one entry, not two.
  addArtifact(j, file, bytes) {
    const p = String(file || "").replace(/\\/g, "/");
    if (!isArtifactPath(p)) return false;
    j.artifacts = j.artifacts || [];
    if (j.artifacts.some((a) => a.path.toLowerCase() === p.toLowerCase())) return false;
    j.artifacts.push({ path: p, bytes: Number(bytes) || null, at: Date.now() });
    this.schedulePersist();
    this.onEvent({ type: "job", job: this.summary(j) });
    return true;
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
    if (typeof body.resolved_path === "string") this.addArtifact(j, body.resolved_path, body.bytes_written);
  }

  // An agent that writes with a shell (`cat > x.sql`, `sqlplus @script`) leaves no tool event, but it
  // does leave an untracked file. Only UNTRACKED ones count: a tracked file it edited is a change,
  // not a deliverable.
  async sweepArtifacts(j) {
    if (!j.cwd) return;
    let out = "";
    try {
      out = (await pexec("git", ["-C", j.cwd, "status", "--porcelain", "--untracked-files=all"], { maxBuffer: 8 * 1024 * 1024 })).stdout;
    } catch {
      return; // not a git repo, or no git: the write_file path still covers it
    }
    for (const row of out.split(/\r?\n/)) {
      if (!row.startsWith("?? ")) continue;
      const rel = row.slice(3).trim().replace(/^"(.*)"$/, "$1");
      if (!rel) continue;
      this.addArtifact(j, path.join(j.cwd, rel), null);
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

  // ---- run lifecycle -------------------------------------------------------------------
  async create(opts = {}) {
    const prompt = String(opts.prompt ?? "").trim();
    if (!prompt) throw new Error("prompt is required");
    // One conversation per thread: turns share the thread name, so the gateway continues the same
    // session and the UI can group them into a single card.
    const thread = opts.thread || makeThreadName(prompt);
    const siblings = [...this.jobs.values()].filter((x) => x.thread === thread);
    const j = {
      id: randomUUID().slice(0, 8),
      thread,
      turn: siblings.length + 1,
      replyTo: siblings[0]?.id || null,
      reply: Boolean(opts.reply),
      existing: Boolean(opts.existing),
      prompt,
      yolo: Boolean(opts.yolo),
      model: opts.model || null,
      status: "starting",
      runId: null,
      lines: [],
      // Files this agent produced for the reader (docs, scripts, keys) — not code it edited.
      artifacts: [],
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
        this.emit(j);
        return this.summary(j);
      }
    }
    j.cwd = cwd;

    const body = { input: prompt, session_id: thread, cwd };
    if (opts.model) body.model = String(opts.model);
    if (opts.maxTurns) body.max_turns = Number(opts.maxTurns);
    if (opts.budget) body.run_budget = Number(opts.budget);

    this.push(j, { kind: "cmd", text: `POST ${this.api.url}/v1/runs · session ${thread} · cwd ${cwd}` });
    this.onLog(`run ${j.id}: session ${thread} cwd ${cwd}`);

    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20_000);
      res = await fetch(`${this.api.url}/v1/runs`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: ctrl.signal });
      clearTimeout(t);
    } catch (e) {
      const why = e?.name === "AbortError" ? "the gateway did not answer within 20s" : String((e && e.message) || e);
      j.status = "failed";
      j.error = `cannot reach the Hermes gateway at ${this.api.url}: ${why}`;
      j.endedAt = new Date().toISOString();
      this.push(j, { kind: "raw", text: j.error });
      this.emit(j);
      return this.summary(j);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const err = await res.json();
        detail = err?.error?.message || err?.message || JSON.stringify(err).slice(0, 300);
      } catch {
        detail = await res.text().catch(() => "");
      }
      j.status = "failed";
      j.error = `gateway refused the run (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ""}`;
      j.endedAt = new Date().toISOString();
      this.push(j, { kind: "raw", text: j.error });
      this.emit(j);
      return this.summary(j);
    }

    const accepted = await res.json().catch(() => ({}));
    j.runId = accepted.run_id || null;
    if (!j.runId) {
      j.status = "failed";
      j.error = "gateway accepted the request but returned no run_id";
      j.endedAt = new Date().toISOString();
      this.emit(j);
      return this.summary(j);
    }
    j.status = "running";
    this.push(j, { kind: "init", text: `run ${j.runId} · session ${thread} · cwd ${cwd}` });
    this.emit(j);

    // Hard wall-clock cap, same contract as before: a runaway agent does not outlive its budget by
    // much. Stopping is cooperative, so the run settles through its own terminal event.
    j.timer = setTimeout(() => {
      if (j.status === "running") {
        j.error = `killed: exceeded ${this.maxRuntimeSeconds}s panel cap`;
        void this.stop(j.id);
      }
    }, this.maxRuntimeSeconds * 1000);

    // Backstop for a silently dead stream: the status endpoint is the truth.
    j.poller = setInterval(() => void this.poll(j), 15_000);

    void this.follow(j);
    return this.summary(j);
  }

  // Subscribe to the run's event stream. A dropped stream is not a lost run: `poll` keeps asking the
  // status endpoint until the run reaches a terminal state.
  async follow(j) {
    const ctrl = new AbortController();
    j.ctrl = ctrl;
    try {
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/events`, {
        headers: { Accept: "text/event-stream", ...(this.api.key ? { Authorization: `Bearer ${this.api.key}` } : {}) },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; each frame carries `id:` and `data:` lines.
        let cut;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!data) continue;
          let evt;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          this.consume(j, evt);
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) this.onLog(`run ${j.id}: event stream ended (${String((e && e.message) || e)})`);
    }
    await this.poll(j);
  }

  consume(j, evt) {
    // A write_file result is the one place a produced file names itself, so it is recorded before
    // the console lines are built (those drop the JSON down to its text).
    if (evt.event === "tool.completed") this.noteArtifact(j, evt);
    for (const line of linesForEvent(evt)) this.push(j, line);
    if (evt.event === "run.steered") this.onEvent({ type: "job", job: this.summary(j) });
    // A run that hits a flagged command parks at ``waiting_for_approval`` and emits this once. The
    // card carries the request (redacted command + the choices the host allows) so the answer can be
    // posted back to the same run instead of going through the CLI's TTY prompt.
    if (evt.event === "approval.request") {
      j.approval = {
        requestId: typeof evt.request_id === "string" ? evt.request_id : null,
        command: String(evt.command || evt.description || ""),
        choices: Array.isArray(evt.choices) && evt.choices.length ? evt.choices : ["once", "deny"],
      };
      this.emit(j);
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
    if (TERMINAL_RUN.has(evt.event)) {
      const status = evt.event.replace("run.", "");
      this.push(j, runResultLine(status, evt));
      this.settle(j, status, evt);
    }
  }

  settle(j, runStatus, run = {}) {
    if (j.status !== "running" && j.status !== "starting") return;
    j.status = TERMINAL_STATUS[runStatus] || "failed";
    j.exitCode = runStatus === "completed" ? 0 : 1;
    if (run.usage) j.tokens = { total: run.usage.total_tokens ?? null, input: run.usage.input_tokens ?? null, output: run.usage.output_tokens ?? null };
    if (run.error) j.error = j.error || String(run.error);
    if (run.pending_steer) j.error = j.error || `steer arrived after the last tool boundary: ${String(run.pending_steer).slice(0, 160)}`;
    j.endedAt = new Date().toISOString();
    j.approval = null;
    clearTimeout(j.timer);
    clearInterval(j.poller);
    try {
      j.ctrl?.abort();
    } catch {
      /* already closed */
    }
    this.onLog(`run ${j.id} ${j.status}${j.runId ? ` (${j.runId})` : ""}`);
    this.emit(j);
    // Anything the agent wrote with a shell only shows up in git's untracked list once the turn is
    // over, so the artifacts button is filled in here as well as from write_file events.
    void this.sweepArtifacts(j);

    // A steer that arrived after the agent's last tool boundary is returned here instead of being
    // consumed. Dropping it would silently swallow an instruction the reader typed at a live agent,
    // so it becomes the next turn on the same thread — the run's own directory, model and owner.
    const pending = String(run.pending_steer || "").trim();
    if (pending) {
      this.push(j, { kind: "dim", text: "⇢ that steer arrived after the last tool boundary — sending it as the next turn" });
      setTimeout(() => {
        void this.create({
          prompt: pending,
          thread: j.thread,
          reply: true,
          cwd: j.cwd,
          model: j.model,
          yolo: j.yolo,
          ownerPath: j.ownerPath,
        }).catch((e) => this.onLog(`could not replay the pending steer for ${j.id}: ${String((e && e.message) || e)}`));
      }, 400);
    }
  }

  // Ask the status endpoint for the truth and settle on it. Covers a stream that never opened and a
  // terminal event that was missed, so a card cannot stay "running" forever.
  async poll(j) {
    if (!j.runId || (j.status !== "running" && j.status !== "starting")) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return;
      const run = await res.json();
      if (TERMINAL_RUN.has(run.status)) {
        this.push(j, runResultLine(run.status, run));
        this.settle(j, run.status, run);
      }
    } catch {
      /* the next tick tries again */
    }
  }

  // ---- steering / stopping -------------------------------------------------------------
  // The whole reason for this transport: a running turn can be corrected without starting a new one.
  async steer(id, text) {
    const j = this.jobs.get(String(id || ""));
    const clean = String(text ?? "").trim();
    if (!j) return { ok: false, error: "unknown job" };
    if (!clean) return { ok: false, error: "steer text is required" };
    if (j.status !== "running" || !j.runId) return { ok: false, error: `run is not running (${j.status})` };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/steer`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ input: clean }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 run_not_accepting_steer: the turn crossed its last tool boundary before this arrived.
        return { ok: false, error: body?.error?.message || body?.message || `HTTP ${res.status}`, code: body?.error?.code || body?.code || null };
      }
      this.push(j, { kind: "dim", text: `⇢ steer sent: ${clean.slice(0, 200)}` });
      return { ok: true, accepted: Boolean(body.accepted), runId: j.runId };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Answer the approval a parked run is waiting on. The choice must be one the host offered: the
  // panel mirrors `choices` rather than inventing its own, and the gateway re-validates it anyway.
  async approve(id, choice, requestId) {
    const j = this.jobs.get(String(id || ""));
    if (!j || !j.runId) return { ok: false, error: "unknown job" };
    const pick = String(choice || "").trim().toLowerCase();
    const offered = j.approval?.choices || [];
    if (!offered.includes(pick)) return { ok: false, error: `choice must be one of: ${offered.join(", ") || "once, deny"}` };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const body = { choice: pick };
      const rid = requestId || j.approval?.requestId;
      if (rid) body.request_id = String(rid);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/approval`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: out?.error?.message || out?.message || `HTTP ${res.status}`, code: out?.error?.code || out?.code || null };
      }
      this.push(j, { kind: "dim", text: `⇢ approval answered from the panel: ${pick}` });
      // Optimistic: the stream's approval.responded confirms it a moment later.
      j.approvalDone = { choice: pick, command: j.approval?.command || "", at: new Date().toISOString() };
      j.approval = null;
      this.emit(j);
      return { ok: true, choice: pick, resolved: out.resolved ?? null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async stop(id) {
    const j = this.jobs.get(String(id || ""));
    if (!j || !j.runId || j.status !== "running") return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      await fetch(`${this.api.url}/v1/runs/${j.runId}/stop`, { method: "POST", headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      this.push(j, { kind: "raw", text: "stop requested — the turn ends at its next safe point" });
      return true;
    } catch {
      return false;
    }
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
