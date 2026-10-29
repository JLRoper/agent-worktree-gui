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
import { CLARIFY_REFUSAL, createClarifyCapability } from "./clarify.js";
import { unwrapToolText } from "./tool-text.js";
import { completionPayload, outcomeFrom, readReport } from "./completion.js";
import { parseTodoLines, proposeClosed, todoBlock, todoCounts } from "./todos.js";
// The scratch line every spawn prompt carries: lib/paths.js owns the directory, so the wording and the path it
// names cannot drift apart from the one Settings offers to empty.
import { scratchLine } from "./paths.js";
// The sentence a worker gets about where its branch lands, and the branch identity a rename cannot change: the
// paragraph is keyed on the tree's PARENT branch, which is read from the cut record rather than assumed.
import { branchLandingLine } from "./branch-policy.js";
import { tagOf } from "./tree-names.js";
// The approval window's fallback, held once: lib/hermes-config.js owns the value the gateway reads, and this
// module borrows it. It used to be a copied literal, because hermes-config.js imported `hermesHome` from here.
import { APPROVAL_TIMEOUT_DEFAULT as APPROVAL_WINDOW_DEFAULT } from "./hermes-config.js";
// Where Hermes keeps its files, which key the gateway wants and what a request looks like: not the run
// supervisor's business any more, so it lives in lib/hermes-runtime.js.
import {
  apiConfig, gatewayIdentity, hermesHome, lastSeenIso, makeThreadName, normaliseAttachments, previewRequest, readKeyFromEnvFile,
 } from "./hermes-runtime.js";
import { execFile } from "node:child_process";
import { HermesTransport } from "./hermes-transport.js";
import { ClaudeTransport } from "./claude-transport.js";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const pexec = promisify(execFile);
const MAX_LINES = 600;
const TAIL = 60;
const KEEP_JOBS = 80; // persisted conversations, newest first
// A streamed paragraph is ONE line, updated in place - but not one SSE frame per token: a fast model
// writes 30-60 fragments a second, and every fragment used to be a frame to each reader and a write to
// the store. Coalesced on a short clock, flushed at once before anything else joins the console so the
// order of lines is never in question.
const TEXT_FLUSH_MS = 120;
// A dropped run stream subscribes again after this, doubling to the ceiling. The gateway keeps each
// run's events and replays from a seq, so the wait costs the delay and nothing else.
export const STREAM_RETRY_MS = 1000;
export const STREAM_RETRY_MAX_MS = 15_000;
let lineSeq = 0;

// The block the panel hands a run about its worktree's TODO list: the list WITH its ids, and the standing
// instruction to keep it current and to reconcile it against its own commits before finishing. `list` is what
// lib/todos.js holds for that tree — null when the tree has no list yet, and the block then says so rather than
// pretending there is one.
export const todoBlockText = (list, where, project) => todoBlock(list?.items || [], { where, project });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);

// The word this gateway answers for a run its own registry no longer describes. It is not a status: the run is
// neither live nor finished, and nothing about it will ever settle, so a card left `running` on that answer reads
// "running" for as long as it sits on the board (measured: 48 minutes, while every sweep was told the gateway did
// not know the run). The word alone is not a verdict — a run that is only starting can answer it once — so what
// makes it evidence is repetition: see noteUnknownAnswer().
const UNKNOWN_RUN_STATUS = "unknown";
// Two consecutive unknown answers this far apart are the same thing said twice, not a flap. The orphan sweep runs
// every 15s, so in practice this is "the next sweep said it again".
const UNKNOWN_CONFIRM_MS = 15_000;
// How many answers are kept on the card: enough to show the pair that settled it, not the sweep's whole history.
const UNKNOWN_ANSWER_CAP = 4;

// The gateway's own waiting window for a parked approval, mirrored from
// `tools/approval_context._get_approval_timeout` (`config.get("timeout", 300)`, clamped to the platform-safe
// ceiling). lib/hermes-config.js owns it as APPROVAL_TIMEOUT_DEFAULT and it is imported above; it is what is
// left when the panel has no reader wired (a bare Jobs in a test) or the file cannot be read at all.

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

// A status whose turn the panel is still holding, and the one question every "is this thread / this tree
// busy" check is really asking. Three words qualify:
//   * `running`  — the run is live in the gateway;
//   * `starting` — the panel is still getting to the POST (the worktree is being cut);
//   * `waiting`  — the gateway refused the POST with 429 (at its concurrent-run cap) and the panel is
//                  holding the turn to re-send it. It has no run id yet, but its thread, its turn and its
//                  worktree are taken exactly as a running one's are: that is what stops a retry from
//                  becoming a second run in the same tree.
// Anything OUTSIDE this set is a settled turn, and every rule about settling (one completion, one notice,
// no re-attach) is allowed to act on it.
export const LIVE_JOB_STATUS = new Set(["running", "starting", "waiting"]);
export const isLiveJobStatus = (s) => LIVE_JOB_STATUS.has(String(s || ""));

// ---- 429: the gateway's backpressure, not a failed run -----------------------------------------
// `POST /v1/runs` answers 429 with `{error:{code:"rate_limit_exceeded"}}` and a `Retry-After` header when
// its concurrent-run cap is reached (`_concurrency_limited_response` in api_server). That is a statement
// about SLOTS, not about this run: the same request is accepted the moment one frees, so the panel holds
// the turn and sends it again instead of marking it failed. These are the knobs for that hold, overridable
// from the panel config as `retry429: {attempts, baseMs, maxMs, jitter}` (a sandbox wants small ones).
//   * `attempts` counts the POST itself, so 6 means one try plus five retries;
//   * the delay is a backoff that doubles from `baseMs` and stops growing at `maxMs`, with `jitter` of the
//     delay added or subtracted at random so a fleet of panel instances does not wake up together;
//   * a `Retry-After` is a FLOOR under that backoff, never a shortening of it, and it is never capped away
//     — a gateway that says 60 s is not asked again at 30. This gateway sends `Retry-After: 1`, which the
//     backoff already covers.
export const RETRY_429_DEFAULTS = { attempts: 6, baseMs: 1500, maxMs: 30_000, jitter: 0.25 };

export function retry429Settings(config = {}) {
  const raw = config && typeof config.retry429 === "object" && config.retry429 ? config.retry429 : {};
  const num = (v, fallback, min) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    attempts: Math.max(1, Math.round(num(raw.attempts, RETRY_429_DEFAULTS.attempts, 1))),
    baseMs: num(raw.baseMs, RETRY_429_DEFAULTS.baseMs, 0),
    maxMs: num(raw.maxMs, RETRY_429_DEFAULTS.maxMs, 0),
    jitter: Math.min(1, num(raw.jitter, RETRY_429_DEFAULTS.jitter, 0)),
  };
}

// The gateway's own hint, in milliseconds: `Retry-After` is either a whole number of seconds or an
// HTTP-date. Anything that parses as neither is treated as absent (null) rather than as a zero wait.
export function retryAfterMs(headers) {
  const get = headers && typeof headers.get === "function" ? (name) => headers.get(name) : () => null;
  const raw = get("retry-after");
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  if (/^[0-9]+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// How long to hold before POST attempt `attempt` (1-based), as a number of milliseconds. Exported because
// the harness proves the shape directly: doubling, capped, jittered, and never below `Retry-After`.
export function retry429DelayMs(attempt, settings = RETRY_429_DEFAULTS, afterMs = null, random = Math.random) {
  const s = { ...RETRY_429_DEFAULTS, ...(settings || {}) };
  const grown = Math.min(s.maxMs, s.baseMs * 2 ** Math.max(0, attempt - 1));
  const wobbled = grown * (1 + (Number(random()) * 2 - 1) * s.jitter);
  const floor = Number.isFinite(afterMs) && afterMs > 0 ? afterMs : 0;
  return Math.max(0, Math.round(Math.max(floor, wobbled)));
}

// A wait, said the way a reader reads a clock: "1.5s", "47s", "2m 05s".
export function fmtWait(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 10) return `${(Math.round(s * 10) / 10).toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
}

// The gateway's process-start fingerprint as a wall clock in milliseconds, or null when it is not one.
// Hermes uses that number as a PID-reuse guard, not as a clock, and what it counts differs by platform:
// Windows records centiseconds since the epoch (179307913161 → 2026-10-27T05:32:11Z), Linux records clock
// ticks since boot. A boot-tick number lands in no epoch band and is therefore honestly "unknown" — the
// comparison that needs a clock then declines to answer instead of inventing one.
function gatewayStartMs(identity = null) {
  const n = Number(identity?.startTime);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n > 1e11 ? n * 10 : n > 1e9 ? n * 1000 : null;
  if (ms === null) return null;
  const year = new Date(ms).getUTCFullYear();
  return year >= 2000 && year <= 2200 ? ms : null;
}

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
//
// Re-exported, not defined here: `hermesHome`, `apiConfig`, `readKeyFromEnvFile`, `lastSeenIso`,
// `normaliseAttachments`, `previewRequest` and `makeThreadName` moved to lib/hermes-runtime.js, where
// lib/hermes-config.js and lib/hermes-models.js can reach `hermesHome` without importing this module.
// The exported names are unchanged on purpose: server.js and the verify harnesses read them from here.
export { apiConfig, hermesHome, makeThreadName, normaliseAttachments, previewRequest };

// The FIRST line of every brief the panel hands a worker: which kind of tree it is in, and what that means for the
// remote. A worktree the panel cuts is LOCAL ONLY by default (see lib/remote-writes.js for why), and the exception
// is the reader's — so this text is decided from the RUN's own options and never from what a brief happens to
// mention. Plain English, and the "will land" case NAMES the landing step, because a worker told to land without
// being told how invents its own.
//
// It is added to the run's INPUT, not to the stored prompt: the card keeps showing what the reader wrote, and
// lib/descriptions.js reads the opening sentences of that brief to describe a branch — a panel sentence there would
// become the branch's description. `previewRequest` is deliberately not widened to include it either: its contract
// is "the prompt and the clarify hint" (tools/verify-clarify.mjs pins that).
export function remoteWriteLine(o = {}, where = null) {
  const tree = String(where || o.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const remote = String(o.remote || "").trim();
  const base = String(o.baseBranch || o.base || "").trim();
  const landing = o.remoteWrite === "land" || o.landing === true;
  if (landing) {
    const push = remote ? `git push -u ${remote} HEAD` : "git push -u <remote> HEAD";
    const onto = base ? ` onto ${base}` : "";
    return (
      `WILL LAND: this worktree${tree ? ` (${tree})` : ""} is meant to land${onto} — commit on this branch, then push it and open a pull request: \`${push}\` and \`gh pr create --fill\`. ` +
      "The panel never pushes for you, so those two commands are yours to run. If you were told the work is local-only, stop and report instead of pushing."
    );
  }
  return (
    `LOCAL-ONLY: this worktree${tree ? ` (${tree})` : ""} is local-only — do not \`git push\`, do not create a remote branch and do not open a pull request. ` +
    "Report what you found; the reader will ask for a remote branch if this work is to land. " +
    "The panel's push guard refuses a push from a local-only tree and asks the reader for permission, so a push you attempt will park and then fail; report instead."
  );
}

// ---- line rendering, and the gateway's refusals --------------------------------------
// The one cluster in this file with no state of its own: an SSE event becomes the console lines the
// browser knows how to draw, and a refusal becomes a sentence. It lives in lib/jobs/console-lines.js
// so the translator can be read without the registry around it. `cleanPath` and `linesOf` are the
// tree-measuring half of the same cluster and are imported back; `clarifyText`, `runRefusal` and
// `toolGlyph` are exported from here as well, because lib/subagents.js and the verify harnesses have
// always read them off this module.
import { clarifyText, cleanPath, linesForEvent, linesOf, runRefusal, runResultLine, statsFromUsage, stripAnsi } from "./jobs/console-lines.js";

export { clarifyText, runRefusal, runResultLine, toolGlyph } from "./jobs/console-lines.js";

// Which tree a turn is working in, normalised the way ownership is compared everywhere else (see agentPaths).
// Two readers: the busy-thread check (a run and a reply in two threads of one tree are still two agents editing
// the same files) and the leftover sweep's holder check below. `ownerPath` first: it is the tree the panel cut
// for the thread and outlives a single turn, where `cwd` is only what this turn was handed.
const normTree = (p) => (p ? String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : null);

// The key a tree's parent record is stored under: its six-hex tag when it has one (the only part of a tree's name
// the panel's own rename keeps — lib/tree-names.js), else its normalised path. Same file for both, so a lookup can
// never be "recorded under one spelling and asked for under another".
const treeParentKey = (tree, branch) => {
  const tag = tagOf(branch) || tagOf(tree);
  if (tag) return `tag:${tag}`;
  const p = normTree(tree);
  return p ? `tree:${p}` : null;
};

// One git question, and null instead of a throw: every use here is advisory (a paragraph, a record), so a missing
// git or a directory that is not a checkout must cost the answer, not the run.
const gitOut = async (cwd, args, timeout = 20_000) => {
  try {
    const { stdout } = await pexec("git", ["-C", cwd, ...args], { timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
    return String(stdout || "").replace(/\r\n/g, "\n").trim();
  } catch {
    return null;
  }
};
export function treeOfJob(j) {
  if (!j) return null;
  return normTree(j.ownerPath || j.worktreePath || j.cwd);
}

// What a card whose run the gateway has forgotten can still point at: the tree the turn worked in, and the PR its
// branch has. Only the manual press asks for these (the boot reconcile does not look them up for every card), and
// nothing is invented here — a line is written only for what the caller actually found. The tree path is plain text
// a reader can copy; the PR is its URL, the one form of a pointer the console renders as a link.
export function runGonePointerLines(pointers) {
  if (!pointers || typeof pointers !== "object") return [];
  const branch = String(pointers.branch || "").trim();
  const worktree = String(pointers.worktree || "").trim();
  const pr = pointers.pr && pointers.pr.number ? pointers.pr : null;
  const out = [];
  if (worktree || branch) {
    const where = worktree ? `the tree this turn worked in is still there: ${worktree}` : "this turn ran in the project checkout itself";
    out.push({ kind: "result", text: `${where}${branch ? ` · branch ${branch}` : ""} — losing the run lost nothing on disk` });
  }
  if (pr) {
    const state = pr.state ? ` (${pr.state})` : "";
    const title = pr.title ? ` “${String(pr.title).slice(0, 120)}”` : "";
    out.push({ kind: "result", text: `PR #${pr.number}${state}${title}${pr.url ? ` — ${pr.url}` : ""}` });
  } else if (branch) {
    out.push({ kind: "result", text: `the panel knows no PR for ${branch} — the branch itself is where the work would be` });
  }
  return out;
}

// ---- registry ------------------------------------------------------------------------

// ---- the run's event stream -------------------------------------------------------------------------
// One SSE frame -> its payload, or null for a frame that carries none. The gateway stamps every frame
// with `id: <seq>` and repeats that number as `seq` in the JSON; the id is what a reconnecting subscriber
// hands back as `Last-Event-ID`, so a reconnect asks for exactly what it missed instead of replaying the
// run from zero. Comment frames (`: open`, `: keepalive`, `: stream closed`) are the gateway's liveness
// marks, not events, and must never reach the transcript.
export function frameEvent(frame) {
  let seq = null;
  let data = "";
  for (const raw of String(frame || "").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("id:")) {
      const n = Number(line.slice(3).trim());
      if (Number.isInteger(n) && n >= 0) seq = n;
    } else if (line.startsWith("data:")) {
      data += (data ? "\n" : "") + line.slice(5).trim();
    }
  }
  if (!data) return null;
  let evt;
  try {
    evt = JSON.parse(data);
  } catch {
    return null; // a cut frame is not an event: the next blank line carries the rest
  }
  if (!evt || typeof evt !== "object") return null;
  if (seq !== null && !Number.isInteger(evt.seq)) evt.seq = seq;
  return evt;
}

export class Jobs {  constructor({ config = {}, onEvent = () => {}, onLog = log, clarifyWindow = null, approvalWindow = null } = {}) {
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
    // Every ask the panel has made of the gateway to STOP a run it gave up on, with the answer. Kept because
    // the failure this exists for was silent: a card read interrupted while the gateway went on executing the
    // turn, and nothing anywhere said whether a stop had ever been sent.
    this.stopAttempts = [];
    this.api = apiConfig(config);
    if (!this.api.key) {
      const fromFile = readKeyFromEnvFile();
      if (fromFile) this.api.key = fromFile;
    }
    // Every backend a job can run on, keyed by `job.agent`. Per-job calls go through `transportFor(j)`.
    this.hermes = new HermesTransport({ jobs: this, onLog });
    this.claude = new ClaudeTransport({ jobs: this, onLog });
    this.transports = { hermes: this.hermes, claude: this.claude };
    // What this gateway build can do with the `clarify` tool, learned from its own events: a
    // clarify.request proves the round trip works, the tool's "not available" refusal proves it does
    // not. See lib/clarify.js for why the answer is observed rather than configured.
    this.clarify = createClarifyCapability();
    this.maxRuntimeSeconds = Number(config.jobMaxRuntimeSeconds) || 3600;
    // The registry is persisted so a restart does not lose the fact that an agent ran in a
    // worktree (the row's agent chip is derived from it) and does not empty the Agents list.
    this.storePath = config.jobsFile || null;
    // Where a run's throwaway files belong. Resolved by lib/paths.js (server.js fills it), read here because every
    // spawn prompt states it: a comparison that lands in a worktree costs a branch, a directory and a board row, and
    // the scratch directory is the one place the panel can empty without asking anyone.
    this.scratchDir = config.scratchDir || null;
    // The panel's own copy of every model's per-million price, beside the job store (server.js fills the same
    // default). The readout needs it to price a session the gateway recorded no cost for; the path is held
    // here rather than read per render, so a snapshot stays a store read and a file stat.
    this.pricingPath = config.modelPricingFile || (this.storePath ? path.join(path.dirname(this.storePath), "model-prices.json") : null);
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
    // Which branch each tree was CUT FROM, written at the cut. Beside the job store for the same reason as the
    // labels: it is the panel's own bookkeeping about a tree, not part of the tree.
    this.parentsPath = config.branchParentsFile || (this.storePath ? path.join(path.dirname(this.storePath), "branch-parents.json") : null);
    this.treeParents = this.loadParents();
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
    // `clarify` rides beside the capabilities probe: true/false once a run has proved it, null while nothing has been
    // observed. The settings surface and /api/state read this, so a reader can tell "the build cannot ask" from "no
    // question has come up yet" without reading the source.
    return { ...this.hermes.state, clarify: this.clarify?.state?.() || null };
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
        // Jobs from before the transport map have no agent: they ran on the Hermes gateway.
        j.agent = j.agent || "hermes";
        // A run lives in the gateway, not in this process, so a panel restart does not necessarily
        // mean the agent stopped — but the panel has lost its stream and cannot steer safely. Say
        // exactly that instead of claiming the run ended. A turn held on the gateway's 429 cap is the
        // same kind of loss with a worse name: this process was the only thing holding it, so it did not
        // become a run at all and must not be left on the card as if it were still queued.
        if (j.status === "running" || j.status === "starting" || j.status === "waiting") {
          const wasHeld = j.status === "waiting";
          j.status = "interrupted";
          j.error = j.error || (wasHeld
            ? "the panel restarted while this turn was held waiting for a run slot (HTTP 429 — the gateway was at its concurrent-run cap)"
            : j.agent === "claude"
              ? "the panel restarted while this was running — the claude process was this panel's child, so the turn is lost"
            : `the panel restarted while this was running${j.runId ? ` (run ${j.runId} may still be live in the gateway)` : ""}`);
          // The turn's clock has to stop where this panel last saw it work. With no end it counted from
          // `startedAt` to now on every repaint: a turn cut off at 03:09 still drew "interrupted · 79m22s" at
          // 04:17, and the number grew while the reader watched it.
          j.endedAt = j.endedAt || lastSeenIso(j);
          // What this process INHERITED as a live turn. `stopStaleRuns` asks for a stop on the ones whose run
          // belongs to a gateway that is no longer running, and it must not touch a card created here.
          j.restoredLive = true;
          restored.push(j);
        }
        j.waiting = null;
        j.cancelRequested = false;
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
            // Survives a restart like the ownership facts above: a turn that was refused a clarify call
            // is still that turn once the panel is back.
            clarifyUnavailable: Boolean(j.clarifyUnavailable),
            runId: j.runId || null,
            // The last event this panel printed. A re-attached card resumes from it instead of replaying the
            // run's whole transcript under the one the reader already has.
            lastSeq: Number.isInteger(j.lastSeq) ? j.lastSeq : null,
            // Which gateway process accepted this run, so the next boot can tell a run the current gateway still
            // has from one issued to a process that is gone. Survives a restart like the run id itself.
            gatewayPid: j.gatewayPid ?? null,
            gatewayStart: j.gatewayStart ?? null,
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
            // A 404 on this card's run survives the process that learned it: without this a reload would put the
            // re-attach chip back on a card whose run is provably gone, and every press would be a wasted question.
            runGone: Boolean(j.runGone),
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
            // How many results this turn has recorded for each tool. A fold note names its result by that count
            // (see withResultRow), so a restart that restarted the count at zero would hand the reader a note
            // pointing at another result's row.
            resultRows: j.resultRows || null,
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
        // The panel's own price cache, for the dollar figure on a session the store recorded no cost for.
        pricingPath: this.pricingPath,
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
      // A clarify call this turn made was refused by the gateway BUILD rather than by policy. The board
      // assistant journals it once (it owns the journal) and the page reads the capability from the
      // assistant's state; the card only needs to know that this turn hit it.
      clarifyUnavailable: Boolean(j.clarifyUnavailable),
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
      // While the turn is held on the gateway's 429 cap: the attempt it is on, how many there will be, how
      // long the current hold is, and what the gateway said. The card draws its "waiting for a slot" head and
      // its countdown from this, and it is null on every turn that is not holding.
      waiting: j.waiting || null,
      // The gateway has been asked about this card's run and had no record of it: there is nothing left to
      // re-attach, so the card must stop offering to. The NOT-RUNNABLE chip reads this, and it is persisted
      // because the answer outlives the process that asked for it.
      runGone: Boolean(j.runGone),
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
      live: this.liveOf(j),
      lines: j.lines.slice(-TAIL),
    };
  }

  // What the card's pulse draws while the turn is live: this panel's heartbeat on the run's stream, never a
  // claim about what the model is thinking. `events` 0 means the gateway has sent nothing at all since the run
  // started - a gateway that is not sending, not a quiet agent. `stream` says whether there is a stream to
  // judge at all ('off' = this gateway does not advertise run_events_sse; the card is polled).
  liveOf(j) {
    if (!j || !isLiveJobStatus(j.status)) return null;
    const inflight = Array.isArray(j.inflight) ? j.inflight : [];
    const last = inflight[inflight.length - 1] || null;
    return {
      events: j.eventCount || 0,
      lastEventAt: j.lastEventAt || null,
      startedAt: Date.parse(j.startedAt || "") || null,
      seq: Number.isInteger(j.lastSeq) ? j.lastSeq : null,
      stream: j.streamMode === "poll" ? "off" : j.streamOpen ? "open" : "closed",
      streaming: Boolean(j.streaming),
      tool: last ? { name: last.tool, at: last.at } : null,
    };
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map((j) => this.summary(j));
  }

  // A job as the store holds it, for callers that need a field the summary deliberately drops (the internal map is
  // not an API). The same lookup every route already does with `this.jobs.get(...)`.
  get(id) {
    return this.jobs.get(String(id || "")) || null;
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
    // The worktree's TODO list is keyed on this path (the row's own key), so it moves with the tree: without this a
    // renamed tree would come back with an empty section and the old list would be orphaned.
    this.todos?.repointPath?.(oldPath, to);
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

  // One console line, on its way to the browser. The frame carries the run's live numbers too (when it has
  // any), because the card's pulse has to advance with the output: a second `job` summary per token is what
  // the throttle exists to avoid, and a pulse that only moved when a summary happened to arrive would sit
  // at "thinking 2s" for the whole turn.
  emitLine(j, line) {
    const live = this.liveOf(j);
    this.onEvent({ type: "jobline", id: j.id, line, ...(live ? { live } : {}) });
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
        // One line, grown in place - but not one frame per token: see TEXT_FLUSH_MS.
        this.queueText(j);
        // A URL the agent says out loud ("here: http://localhost:7440") is a deliverable like a file.
        this.scanUrls(j, fragment);
        return;
      }
      j.curText = { kind: "text", lid: line.lid, text: fragment.replace(/^\s*\n+/, ""), at: line.at };
      j.lines.push(j.curText);
      if (j.lines.length > MAX_LINES) j.lines.splice(0, j.lines.length - MAX_LINES);
      this.emitLine(j, { ...j.curText, mode: "new" });
      this.scanUrls(j, fragment);
      return;
    }
    // Anything else joining the console closes the open paragraph first, so the reader's lines are in the
    // order the run produced them even though the paragraph behind them was coalesced.
    this.flushText(j);
    if (line.kind === "result" || line.kind === "init") j.curText = null;
    j.lines.push(line);
    if (j.lines.length > MAX_LINES) j.lines.splice(0, j.lines.length - MAX_LINES);
    this.emitLine(j, line);
    // A dev server announces itself in a tool's output (`Serving on http://127.0.0.1:5173`) or in the
    // command that starts it, not in the agent's prose. Those are the URLs a reader wants to click.
    if (line.kind === "tool") this.scanUrls(j, line.text, "tool");
    else if (line.kind === "tool-out") this.scanUrls(j, line.text, "tool-out");
  }

  // The open paragraph, coalesced. `j.curText` already IS the one line the reader sees; this only decides
  // how often the browser is told it grew. One timer per job, and the timer never outlives the turn.
  queueText(j) {
    if (j.textTimer) return;
    j.textTimer = setTimeout(() => {
      j.textTimer = null;
      this.flushText(j);
    }, TEXT_FLUSH_MS);
    j.textTimer.unref?.();
  }

  // Write the open paragraph out now. Called by the clock above, before anything else joins the console,
  // and when the turn settles - the last fragments of an answer must not die with the timer.
  flushText(j) {
    clearTimeout(j.textTimer);
    j.textTimer = null;
    if (!j.curText) return;
    this.emitLine(j, { kind: "text", lid: j.curText.lid, text: j.curText.text, mode: "set" });
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
      // windowsHide matters here more than anywhere else in this file: the sweep runs the moment a turn
      // settles, which is exactly while the reader is typing the next message on a card somewhere else.
      out = (await pexec("git", ["-C", j.cwd, "status", "--porcelain", "--untracked-files=normal"], {
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
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
            windowsHide: true,
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
  // The ref a new tree is cut from: the branch the project checkout is on, or the sha it is parked at. `git worktree
  // add -b <branch> <path>` with no start ref silently uses HEAD and forgets it, which is why the panel used to know
  // where a tree began only for as long as the reflog remembered. Read it here, pass it explicitly, record it.
  async startRefOf(repoDir) {
    try {
      const { stdout: cur } = await pexec("git", ["-C", repoDir, "symbolic-ref", "--short", "HEAD"], { timeout: 15_000, windowsHide: true });
      const name = String(cur || "").trim();
      if (name) {
        const { stdout: sha } = await pexec("git", ["-C", repoDir, "rev-parse", name], { timeout: 15_000, windowsHide: true });
        return { ref: name, sha: String(sha || "").trim() || null, how: name };
      }
    } catch {
      /* not a branch: fall through to the sha */
    }
    try {
      const { stdout: sha } = await pexec("git", ["-C", repoDir, "rev-parse", "HEAD"], { timeout: 15_000, windowsHide: true });
      const out = String(sha || "").trim();
      return out ? { ref: out, sha: out, how: "a detached HEAD" } : { ref: null, sha: null, how: "no HEAD yet" };
    } catch {
      return { ref: null, sha: null, how: "no HEAD yet" };
    }
  }

  async makeWorktree(repoDir, prompt, { run = null, thread = null, project = null } = {}) {
    const slug = String(prompt || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "agent";
    const tag = randomUUID().slice(0, 6);
    const branch = `wtgui/${slug}-${tag}`;
    const treePath = path.join(repoDir, ".worktrees", `${slug}-${tag}`);
    // The cut is the only moment the parent is knowable, so the ref rides the command instead of being resolved
    // afterwards (afterwards there is nothing left to resolve — `worktree add` leaves no record of its start point).
    const start = await this.startRefOf(repoDir);
    // Written down BEFORE the directory exists, so the naming ledger holds the record that THIS run cut this
    // tree — and therefore that this run, and only this run, may give it its one name. After `git worktree add`
    // a discovery pass (or a second run started at the same moment) can see the directory first; a tree the
    // scanner records before this is a tree it calls seeded, and a seeded tree's name is fixed.
    try {
      this.naming?.cut?.({ repoDir, path: treePath.replace(/\\/g, "/"), branch, tag, run, thread, project });
    } catch {
      /* the ledger is a guard, not the run: a cut it could not write is a tree nobody renames, not a failed cut */
    }
    // The start ref is passed explicitly: `git worktree add -b <branch> <path>` with no start ref silently uses
    // HEAD and forgets it, and a sha is passed too when the checkout is parked on a detached HEAD.
    const args = ["-C", repoDir, "worktree", "add", "-b", branch, treePath];
    if (start.ref && !/^[0-9a-f]{7,40}$/i.test(start.ref)) args.push(start.ref);
    try {
      await pexec("git", args, { timeout: 90_000, windowsHide: true });
    } catch (e) {
      // No tree, so no cut to record: hand the entry back rather than leaving the ledger claiming a directory
      // that was never made (a retry of the same prompt would carry a different tag anyway).
      try {
        this.naming?.release?.({ repoDir, path: treePath.replace(/\\/g, "/"), tag, run });
      } catch {
        /* nothing to do with a ledger write that failed */
      }
      throw e;
    }
    const made = { branch, path: treePath.replace(/\\/g, "/").replace(/\/+$/, ""), startRef: start.ref, startSha: start.sha };
    // Written down before the run is posted: a restart, a rename or a roll-up months later all read this record, and
    // nothing else can reconstruct it. A book that is absent (a Jobs built by a test) simply keeps no record.
    if (this.parents && typeof this.parents.record === "function") {
      try {
        made.parent = this.parents.record({ project, branch, path: made.path, startRef: start.ref, startSha: start.sha, by: `the panel (cut from ${start.how})` });
      } catch {
        /* a book that cannot be written must not stop the tree being cut */
      }
    }
    // The same fact in the tree's own book (lib/jobs.js `rememberParent`): the landing paragraph asks it without a
    // project in hand, and a Jobs built by a test has no ParentBook injected at all.
    if (start.ref && start.ref !== branch) this.rememberParent(made.path, branch, start.ref);
    return made;
  }

  loadParents() {
    if (!this.parentsPath || !existsSync(this.parentsPath)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(this.parentsPath, "utf8"));
      const out = new Map();
      for (const [key, rec] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
        if (!rec || typeof rec !== "object") continue;
        const parent = String(rec.parent ?? "").trim();
        if (!parent) continue;
        out.set(key, { parent, branch: rec.branch ? String(rec.branch) : null, tree: rec.tree ? String(rec.tree) : null, at: rec.at || null });
      }
      return out;
    } catch {
      return new Map(); // an unreadable record is not a reason to refuse to cut a tree
    }
  }

  saveParents() {
    if (!this.parentsPath) return;
    try {
      mkdirSync(path.dirname(this.parentsPath), { recursive: true });
      // Newest first and capped: this is a lookup table for live trees, not a history.
      const entries = [...this.treeParents.entries()].sort((a, b) => String(b[1].at || "").localeCompare(String(a[1].at || ""))).slice(0, 500);
      writeFileSync(this.parentsPath, `${JSON.stringify(Object.fromEntries(entries), null, 0)}\n`, "utf8");
    } catch {
      /* a record we cannot write costs one paragraph, never the run */
    }
  }

  rememberParent(tree, branch, parent) {
    const key = treeParentKey(tree, branch);
    if (!key || !parent) return;
    this.treeParents.set(key, { parent, branch: branch || null, tree: tree || null, at: new Date().toISOString() });
    this.saveParents();
  }

  // The parent of a tree, from the best answer available and in that order: what the caller knows, what the panel
  // recorded when it cut the tree, then git's own upstream of the tree's branch. null means "nobody can name it",
  // which is a real answer — lib/branch-policy.js then renders no parent paragraph at all rather than guessing main.
  async parentBranchFor({ tree, branch = null, known = null } = {}) {
    const explicit = String(known ?? "").trim();
    if (explicit) return explicit;
    const name = String(branch ?? "").trim() || (await gitOut(tree, ["rev-parse", "--abbrev-ref", "HEAD"]));
    if (!name || name === "HEAD") return null;
    const rec = this.treeParents.get(treeParentKey(tree, name));
    if (rec && rec.parent && (!rec.branch || rec.branch === name)) return rec.parent;
    // git's own claim: the branch this one tracks. Only a LOCAL branch is a parent — `refs/remotes/...` names a
    // branch on the shared remote, and a tree tracking main has main as its parent anyway.
    const upstream = await gitOut(tree, ["rev-parse", "--abbrev-ref", `${name}@{upstream}`]);
    if (!upstream) return null;
    const bare = upstream.replace(/^[^/]+\//, "");
    if (!bare || bare === name || bare === "HEAD") return null;
    const exists = await gitOut(tree, ["rev-parse", "--verify", "--quiet", `refs/heads/${bare}`]);
    return exists ? bare : null;
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
    if (isLiveJobStatus(j.status)) return null;
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
    // ---- the TODO list, on the way out ---------------------------------------------------------------------
    // A worker cannot call the panel: it writes `TODO DONE 3` on its own line in its FINAL message and the panel
    // reads it here, once the run has settled and its tree has been measured. Every line is applied and journalled
    // with who claimed it, and NOTHING is refused in silence — an id that is not in this list, or a line that cannot
    // be read at all, is said on the card.
    //
    // Then the reconcile prompt, which is the reader's stated hard part: a run that left commits while claiming
    // NOTHING is the run whose list is now a lie. The card says so, with the commits it saw, and may PROPOSE which
    // items look closed — it never marks anything done on its own, because a wrong auto-completion is worse than an
    // unfinished line.
    if (this.todos && !j.todoHarvested) {
      j.todoHarvested = true;
      const harvest = this.todos.harvest({ job: j, finalText: String(j.finalMessage || "") });
      j.todo = harvest;
      const claimed = harvest.changes.filter((c) => c.op !== "add").length;
      for (const c of harvest.changes) {
        this.push(j, { kind: "dim", text: `⇢ TODO #${c.id} ${c.op}${c.status ? ` → ${c.status}` : ""}: ${String(c.text || "").slice(0, 120)}` });
      }
      for (const r of harvest.refused) {
        const which = r.id === null || r.id === undefined ? "" : ` ${r.id}`;
        this.push(j, { kind: "raw", text: `⚠ TODO ${r.op}${which} was NOT applied — ${r.error}` });
      }
      const commitCount = Number(tree.commits) || 0;
      const subjects = Array.isArray(tree.subjects) ? tree.subjects : [];
      if (commitCount > 0 && !claimed) {
        const list = this.todos.forRow(null, tree.path || j.worktreePath || j.ownerPath || j.cwd, { journal: 0 });
        const proposes = proposeClosed(list?.items || [], subjects);
        const counts = todoCounts(list?.items || []);
        this.push(j, {
          kind: "raw",
          text: `⚠ this run left ${commitCount} commit${commitCount === 1 ? "" : "s"} (${subjects.slice(0, 4).join(" · ") || "no subjects read"}) and claimed no TODO item — the list still reads ${counts.open} open${counts.total ? ` of ${counts.total}` : ""}${proposes.length ? `; ${proposes.map((p) => `#${p.id} looks closed by “${p.because}”`).join("; ")}` : ""}. Nothing was marked done on its own: reconcile it by hand, or have the assistant write the TODO lines.`,
        });
      }
    }
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
    // A thread keeps the backend it started on: a reply goes where the conversation lives.
    const agent = opts.agent || siblings[0]?.agent || "hermes";
    if (!this.transports[agent]) throw new Error(`unknown agent "${agent}" (one of: ${Object.keys(this.transports).join(", ")})`);
    // Continuing a Claude session needs `--resume`, which is phase 2d. A fresh process would silently start a new
    // conversation under the old card, so it is refused instead.
    if (agent === "claude" && siblings.length) throw new Error("replies to a Claude job are not available yet (phase 2d)");
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
      // Which backend runs this job: the key into `this.transports`.
      agent,
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
      // A turn the gateway refused with 429 is held here rather than failed (see RETRY_429_DEFAULTS):
      // `{attempt, attempts, waitMs, since, until, retryAfterMs, reason}` while it waits, null otherwise.
      waiting: null,
      timer: null,
      poller: null,
      ctrl: null,
      // The 120 ms clock the streaming paragraph is flushed on, and what the card's pulse reads.
      textTimer: null,
      eventCount: 0,
      lastSeq: null,
      inflight: [],
      streaming: false,
    };
    this.jobs.set(j.id, j);

    let cwd = opts.cwd || this.config.defaultCwd || process.cwd();
    // The directory the run was STARTED from — the project, not the tree `-w` used to be given.
    // The board needs it to place the new worktree under its own row before a discovery pass.
    j.projectPath = cwd;

    // The branch this run's tree was cut FROM, when this run is what cut it: read inside makeWorktree, at the one
    // instant the answer exists (see there), and handed to the paragraph below. null for a run in a tree that
    // already stood — that one is answered from the cut record or from git.
    let cutParent = null;
    // …and the policy the guard for that tree was installed with (the project's, not the global), as a fallback for
    // a caller that did not hand one to `create`.
    let cutPolicy = null;
    // A run needs a directory, so a fresh agent needs its tree before the request goes out.
    if (!opts.reply && !opts.existing && opts.worktree !== false) {
      j.worktree = j.worktree || path.basename(cwd);
      try {
        const repoDir = cwd;
        const made = await this.makeWorktree(cwd, prompt, { run: j.id, thread: j.thread, project: opts.project || null });
        cwd = made.path;
        j.branch = made.branch;
        cutParent = made.parent || null;
        j.worktreePath = made.path;
        j.ownerPath = made.path;
        j.ownerPending = false;
        // The parent travels on the job too, so the card can say where this tree belongs without a second lookup.
        j.parent = made.parent?.parent || null;
        j.parentSha = made.parent?.parentSha || null;
        j.parentSource = made.parent?.parentSource || "unknown";
        this.push(j, { kind: "raw", text: `worktree created: ${made.path} (branch ${made.branch})` });
        if (j.parent) this.push(j, { kind: "dim", text: `cut from ${j.parent}${j.parentSha ? ` @ ${String(j.parentSha).slice(0, 8)}` : ""} — a roll-up goes back there` });
        else if (made.startRef) this.push(j, { kind: "dim", text: `cut from ${made.startRef} — not a local branch, so this tree has no parent to roll into` });
        // The panel's own worktree creation is the moment the LOCAL ONLY rule needs teeth: `git worktree add` cuts
        // a branch and nothing else (it never pushes and never sets an upstream — verified against git), so the
        // tree starts local, and the pre-push guard goes in HERE so a worker's `git push` meets the panel's
        // permission box instead of the remote. Injected by server.js; a Jobs instance built by a test without one
        // simply does not install anything.
        if (this.afterWorktreeCreate) {
          try {
            const out = await this.afterWorktreeCreate({ repoDir, path: made.path, branch: made.branch, landing: Boolean(opts.landing) });
            // The policy the guard was actually installed with: it is the PROJECT's (a project may override the global),
            // so it is also the one the worker's landing paragraph quotes when the caller did not pass one.
            if (out && out.ok) {
              cutPolicy = out.policy || null;
              this.push(j, { kind: "dim", text: `push guard: ${made.path} is ${out.policy === "allow" ? "allowed to push (this project's policy permits it)" : out.policy === "deny" ? "refused outright (this project's policy denies pushes)" : "local only — a push will ask the panel for permission"}` });
            }
            else if (out && out.error) this.push(j, { kind: "raw", text: `push guard NOT installed: ${out.error}` });
          } catch (e) {
            this.push(j, { kind: "raw", text: `push guard NOT installed: ${String((e && e.message) || e)}` });
          }
        }
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

    return this.transportFor(j).create(j, { prompt, opts, thread, cwd, cutParent, cutPolicy });
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

  // Subscribe to the run's event stream, and STAY subscribed. A dropped connection is not a lost run, and
  // it is not the end of the transcript either: the gateway keeps each run's events in a ring and replays
  // from any seq, so a reconnect asks for the one after the last this panel printed (`Last-Event-ID`).
  // Without that, one dropped socket reprinted 186 deltas and every tool call under the answer. The loop
  // closes when the run settles - `settle` aborts `j.ctrl` - and `poll` stays the backstop: the status
  // endpoint is the truth about whether there is anything left to hear.
  async follow(j) {
    return this.transportFor(j).follow(j);
  }

  // A tool call in flight: what the card's pulse names while the model is inside one. Keyed by the call id when
  // the gateway sends one (a parallel batch can have two of the same tool out), else by the newest call of that
  // name; `tool.completed` is the one that ends it.
  noteToolStart(j, evt) {
    j.streaming = false;
    if (!Array.isArray(j.inflight)) j.inflight = [];
    j.inflight.push({ tool: String(evt.tool || "tool"), at: Date.now(), id: evt.tool_call_id || null });
    // A stream that misses a completion must not grow this without bound: the pulse names the newest.
    if (j.inflight.length > 8) j.inflight.splice(0, j.inflight.length - 8);
  }

  noteToolDone(j, evt) {
    const list = Array.isArray(j.inflight) ? j.inflight : [];
    const id = evt.tool_call_id || null;
    const name = String(evt.tool || "");
    let at = id ? list.findIndex((t) => t.id && t.id === id) : -1;
    if (at < 0) for (let i = list.length - 1; i >= 0; i--) if (list[i].tool === name) { at = i; break; }
    if (at >= 0) list.splice(at, 1);
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

  // Which of this turn's results for that tool this one is — the row a fold note names, and the row
  // lib/tool-results.js indexes by (`LIMIT 1 OFFSET row`, over the turn's whole clock window).
  //
  // It has to be counted HERE, at the event, because nothing downstream can recover it: the store indexes a
  // tool's results over the whole turn while the console's lines are a trimmed window of it — `MAX_LINES` is
  // 600 in memory, the streamed summary carries the last 60 (`TAIL`) and `/api/jobs` the last 120 — so the note
  // on a result that arrived 20 results in sat in a burst whose cursor said 0 and the click read a different
  // result back. Kept on the job (and persisted) so a turn whose lines were trimmed, and a turn revived after
  // a restart, still counts from its first result.
  withResultRow(j, evt) {
    if (!evt || evt.event !== "tool.completed") return evt;
    const tool = String(evt.tool || "");
    if (!tool) return evt;
    j.resultRows = j.resultRows || {};
    const rowAt = Number.isInteger(j.resultRows[tool]) ? j.resultRows[tool] : 0;
    j.resultRows[tool] = rowAt + 1;
    return { ...evt, rowAt };
  }

  consume(j, evt) {
    // When this run last said anything. The restart sweep uses it to tell a quiet run from one whose
    // stream this panel no longer holds; the card's pulse counts its age from here.
    j.lastEventAt = Date.now();
    // How many events this panel has taken off the stream, and which one was the last. The count is what
    // tells the card "the gateway has sent nothing at all" apart from "it has gone quiet".
    j.eventCount = (j.eventCount || 0) + 1;
    if (Number.isInteger(evt.seq)) j.lastSeq = evt.seq;
    // What the model is doing right now, in one word: text arriving (`streaming`), a tool in flight
    // (`inflight`), or neither. Drawn by the card's pulse from summary().live.
    if (evt.event === "tool.started") this.noteToolStart(j, evt);
    if (evt.event === "tool.completed") this.noteToolDone(j, evt);
    if (evt.event === "message.delta" || evt.event === "message.interim") j.streaming = true;
    // The gateway's ring no longer holds what this panel last saw (1000 events is easy to pass on a
    // chatty run). Say how much the console skipped and step the cursor past the gap, or every reconnect
    // asks for a seq nobody has and the same notice repeats forever.
    if (evt.event === "replay.truncated") {
      const oldest = Number(evt.oldest_retained_seq);
      const asked = Number(evt.requested_seq);
      if (Number.isFinite(oldest)) j.lastSeq = Math.max(Number.isInteger(j.lastSeq) ? j.lastSeq : -1, oldest - 1);
      this.push(j, {
        kind: "dim",
        text: `the gateway no longer holds every event after seq ${Number.isFinite(asked) ? asked : "?"} - its stream keeps the last 1000, so this console skipped forward to seq ${Number.isFinite(oldest) ? oldest : "?"}`,
      });
      return;
    }
      // A produced file names itself in two places: the call (`write_file · <path>`) and the result JSON
    // ({resolved_path, bytes_written}). The result is often empty on this gateway, so both are read -
    // before the console lines are built, since those drop the JSON down to its text.
    if (evt.event === "tool.started") this.noteArtifactCall(j, evt);
    if (evt.event === "tool.completed") this.noteArtifact(j, evt);
    if (evt.event === "subagent.start" || evt.event === "subagent.complete") this.trackSubagent(j, evt);
    for (const line of linesForEvent(this.withResultRow(j, evt))) this.push(j, line);
    // A clarify call this build cannot deliver: the tool is in the schema and refuses at dispatch
    // ("Clarify tool is not available in this execution context"), which reads like a permission
    // problem and is a missing gateway feature — there is no route on the Runs API to answer the
    // prompt. Record it once, so the next turn is told to ask in prose instead of spending a call
    // that can only fail. See lib/clarify.js and docs/clarify-over-the-runs-api.md.
    if (this.clarify.observeEvent(evt) && this.clarify.unavailable()) {
      this.push(j, {
        kind: "dim",
        text: "⇢ this gateway build cannot deliver a clarify question — agents are told to ask in prose until it is upgraded (docs/clarify-over-the-runs-api.md)",
      });
      // `Jobs` owns no journal — the assistant does — so this is the panel log, and the job carries the
      // fact (summary.clarifyUnavailable) for whoever writes the journal the reader actually reads.
      this.onLog(`run ${j.id}: this gateway build cannot deliver a clarify question (${CLARIFY_REFUSAL})`);
      j.clarifyUnavailable = true;
      this.emit(j);
    }
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
    if (!isLiveJobStatus(j.status)) return;
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
    // The paragraph that was still streaming ends with the turn: flush it before the controller is
    // aborted, or the last fragments of the answer never reach the card.
    this.flushText(j);
    j.streaming = false;
    j.inflight = [];
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
  // Every card a restart left `interrupted`, asked once what the gateway now says about its run. The decision
  // itself lives in settleRestoredRun() below, so the manual re-attach chip takes the same one.
  async reconcileRestored() {
    const lost = [...this.jobs.values()].filter((j) => j.status === "interrupted" && j.runId && !j.reconciled && j.agent === "hermes");
    const done = [];
    for (const j of lost) {
      const { action } = await this.settleRestoredRun(j);
      if (action) done.push(j.id);
    }
    if (done.length) this.schedulePersist();
    return done;
  }

  // THE decision on a restored card's run. The boot reconcile walks every interrupted card through it, and the
  // NOT-RUNNABLE chip's press runs the one card the reader pointed at through the very same call — so the two can
  // never disagree about what the gateway's answer means, and there is no second implementation to drift.
  // `pointers`, when the caller looked them up, are handed to the write-off path; they never change the decision.
  async settleRestoredRun(j, { pointers = null } = {}) {
    const p = await this.runProbe(j);
    // The gateway cannot be asked at all: the interrupted verdict stands, and it is the safe one.
    if (!p.reachable) return { action: null, probe: p };
    // It kept the run and the run has ended: the run's own result decides the card.
    if (p.known === true && TERMINAL_RUN.has(String(p.run?.status))) {
      this.adoptRun(j, p.run);
      return { action: "adopted", probe: p };
    }
    // It still HAS the run: this card is not a write-off. The panel lost the stream, not the run, so re-attach
    // and let the run settle through the same path every other live turn does — the outcome is adopted when it
    // actually finishes, and until then the card is steerable again.
    if (p.known === true) return { action: this.reattachRestored(j, p.run) ? "reattached" : null, probe: p };
    // It answers, and has no record of this run any more: the promise a write-off used to make ("the gateway
    // still has run X, so it will finish on its own") is dead the moment the run leaves the gateway, and a card
    // that keeps it never resolves. Say what is known instead. markRunGone is idempotent, and its `false` (the
    // wording is already on the card) is NOT a decision — a second pass must not claim to have changed anything.
    if (p.known === false) return { action: this.markRunGone(j, { pointers }) ? "gone" : null, probe: p };
    // Anything else — a 5xx, a status nobody here recognises — leaves the verdict standing until it can be asked
    // again. A missing answer is not an answer.
    return { action: null, probe: p };
  }

  // What the NOT-RUNNABLE chip's press does: ask the gateway about this one card's run and take that same decision.
  // The answer says what happened and carries the card as it now stands; the card itself is repainted by the job
  // events the decision emits, the way the boot reconcile's cards are.
  async reattachNow(id, { pointers = null } = {}) {
    const j = this.jobs.get(String(id || ""));
    if (!j) return { ok: false, code: "unknown_job", error: "unknown job" };
    if (!j.runId) return { ok: false, code: "no_run", error: "this turn has no run id, so there is nothing to ask the gateway about" };
    if (j.status !== "interrupted") return { ok: false, code: "not_interrupted", error: `this card is not interrupted (${j.status}) — there is nothing to re-attach` };
    const { action, probe } = await this.settleRestoredRun(j, { pointers });
    if (action) return { ok: true, action, runId: j.runId, pointers: pointers || null, card: this.summary(j) };
    // The gateway answered that it has no record of this run and the card already says so (markRunGone's no-op
    // above): the press is still answered with the verdict it just confirmed, without a second line or write.
    if (probe.known === false) return { ok: true, action: "gone", already: true, runId: j.runId, pointers: pointers || null, card: this.summary(j) };
    if (!probe.reachable) {
      return { ok: false, code: "gateway_unreachable", error: `the gateway cannot be asked about run ${j.runId} right now${probe.error ? `: ${probe.error}` : ""}`, pointers: pointers || null, card: this.summary(j) };
    }
    return { ok: false, code: "gateway_unknown", error: `the gateway answered ${probe.status} for run ${j.runId} — that is not a verdict on the run, so the card is left as it is`, pointers: pointers || null, card: this.summary(j) };
  }

  // The run outlived the panel, so the card is not a write-off: this panel lost the STREAM, not the run. Put it
  // back to `running` — that is what makes it steerable again and what lets the run's own terminal event decide its
  // outcome — and subscribe to its stream once more.
  //
  // `load()` stopped the clock at the last line this panel saw, which was the right answer while the card read
  // "interrupted" and the wrong one now: a live run has a live clock, and the duration measured when it really ends
  // is then the run's own span rather than this panel's uptime. The verdicts reached while the panel could not
  // watch — the restart's error and the notice built from it — go with the interrupted status, and `finalise`
  // rebuilds them on the way out.
  reattachRestored(j, run = {}) {
    if (!j?.runId) return false;
    // The session-authority gateway fences its control calls on this number and the store does not keep it: a
    // re-attached card without it could watch the run but never steer it, which is the same lie in a new place.
    if (Number.isFinite(Number(run.execution_generation)) && Number(run.execution_generation) > 0) {
      j.executionGeneration = Number(run.execution_generation);
    }
    j.status = "running";
    j.endedAt = null;
    j.error = "";
    j.completion = null;
    j.outcome = null;
    // It is back: whatever a 404 said about this run before, the gateway has it now, so there is nothing left to
    // ask about and no gone wording for the card to carry into its next life.
    j.runGone = false;
    // Once per run: the sweep in `sweepOrphanedRuns` re-attaches a run whose stream dropped, and this flag is what
    // keeps the two paths from re-attaching each other in a loop.
    j.reattached = true;
    this.push(j, { kind: "dim", text: `⇢ the panel restarted while this was running — the gateway still has run ${j.runId}, so this card is re-attached to it and can steer it again` });
    // The backstops the process took with it: `follow()` polls the status endpoint once when a stream ends, and
    // nothing else would ask again, so a stream that drops a second time would leave the card running for good. The
    // wall-clock cap is deliberately NOT re-armed: it is a per-panel-run budget, and a run older than the cap would
    // be killed here for nothing but this panel's own downtime.
    clearInterval(j.poller);
    j.poller = setInterval(() => void this.poll(j), 15_000);
    this.onLog(`run ${j.id}: the gateway still has this run (${j.runId}) — re-attached instead of writing it off`);
    this.emit(j);
    void this.follow(j);
    return true;
  }

  // A restored card whose run the gateway no longer has. The write-off this replaces told the reader the run "will
  // finish on its own"; a 404 is that promise breaking, and the card would otherwise carry it for as long as it sits
  // on the board — the run is gone from the gateway, nobody here ever saw it end, and no later ask will do better.
  // This is the panel saying what it knows, not a verdict on the agent's work: the status stays `interrupted` and the
  // tree is still measured, so the reader can see whether the work landed.
  // `pointers` is how the manual press goes one better than the boot reconcile: the ONE answer that leaves the
  // reader with nothing to click says where the work is (the tree) and what became of it (the PR), when the caller
  // looked those up. It never changes the decision — only what the card says on top of it.
  markRunGone(j, { pointers = null } = {}) {
    if (!j || !j.runId || j.status !== "interrupted") return false;
    // The one fact a 404 settles, recorded before the wording guard below: there is no run here to re-attach to any
    // more, so the card stops offering the chip even when its wording is already the settled one.
    j.runGone = true;
    const text = `the panel restarted while this was running — the gateway no longer has run ${j.runId}, so its outcome was never seen here`;
    if (j.error === text) return false; // already said, and there is nothing to add: no second line, no second write
    j.error = text;
    // The card's outcome and notice were built from whatever this panel said at the time — the promise included.
    // Rebuild both from the wording above, rather than leaving the notice carrying the sentence a 404 just disproved.
    j.outcome = null;
    j.completion = null;
    this.push(j, { kind: "result", text: `the gateway has no record of run ${j.runId} any more — this panel never saw its outcome, so the turn stopped mid-flight` });
    for (const line of runGonePointerLines(pointers)) this.push(j, line);
    this.finalise(j);
    this.emit(j);
    this.onLog(`run ${j.id}: the gateway no longer has this run (${j.runId}) — no outcome was ever seen here`);
    return true;
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
    return [...this.jobs.values()].filter((j) => isLiveJobStatus(j.status));
  }

  // The live run whose tree this is, or null. Asked by the assistant's leftover sweep before it blames a tree
  // for the work left in it: a SPAWN IN into a just-finished tree makes that tree a live run's, and what is
  // uncommitted there is that run's work in progress, not a leftover. `runningJobs()` is the predicate — the
  // same one the busy-thread refusal uses, so a tree that would refuse a second agent is a tree that raises
  // no leftover. Standing rule 16 asks a reader to make this check by hand; this is the same check.
  runInTree(treePath) {
    const want = normTree(treePath);
    if (!want) return null;
    return this.runningJobs().find((j) => treeOfJob(j) === want) || null;
  }

  // What the gateway says about one run, and whether it says anything at all. `known: false` IS the answer
  // here: the gateway is up and has no record of this run id any more.
  async runProbe(j) {
    return this.transportFor(j).runProbe(j);
  }

  // One unknown answer, recorded on the card, and the verdict it adds up to. Deliberately not a verdict on the
  // first answer: a run that is only starting answers `unknown` once and then `completed`, and writing that card
  // off would end a turn the gateway is happily running. Two consecutive answers at least UNKNOWN_CONFIRM_MS
  // apart are the gateway saying the same thing twice with nothing in between; a single answer on a card already
  // past its wall-clock cap is a run that was going to be stopped anyway, so the panel stops claiming to watch it.
  // `now` is a parameter so the sweep's clock can be driven in a test without waiting out the gap.
  noteUnknownAnswer(j, probe, now = Date.now()) {
    const answers = Array.isArray(j.unknownAnswers) ? j.unknownAnswers.slice() : [];
    answers.push({
      at: now,
      http: Number(probe?.status) || 200,
      runStatus: String(probe?.run?.status || UNKNOWN_RUN_STATUS),
    });
    while (answers.length > UNKNOWN_ANSWER_CAP) answers.shift();
    j.unknownAnswers = answers;
    const last = answers[answers.length - 1];
    const prev = answers[answers.length - 2] || null;
    const confirmed = Boolean(prev) && last.at - prev.at >= UNKNOWN_CONFIRM_MS;
    const started = Date.parse(j.startedAt || "");
    const ageSeconds = Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : 0;
    const pastCap = ageSeconds > this.maxRuntimeSeconds;
    const cap = `a card ${Math.round(ageSeconds)}s old, past the ${this.maxRuntimeSeconds}s wall-clock cap`;
    const pair = confirmed ? `two consecutive answers ${Math.round((last.at - prev.at) / 1000)}s apart` : "";
    const why = pastCap ? (pair ? `${pair}, on ${cap}` : `one answer on ${cap}`) : pair;
    return { gone: pastCap || confirmed, confirmed, pastCap, ageSeconds, answers, why };
  }

  // The write-off, through the path a 404 takes: markInterruptedByRestart records the gateway as what ended the
  // turn, sets `runGone`, stops the clocks, finalises and emits — so the card carries the same wording a 404
  // gives it, and the re-attach chip is not offered for a run that cannot be re-attached to. What a 404 never
  // needed is the evidence: an `unknown` answer is a word the gateway chose, not a record that is missing, so the
  // journal names every answer and when it came.
  writeOffUnknownRun(j, { answers = [], why = "" } = {}) {
    const seen = answers
      .map((a) => `${a.runStatus || `HTTP ${a.http}`} at ${new Date(a.at).toISOString()}`)
      .join(" · ");
    const wrote = this.markInterruptedByRestart(j, {
      by: "gateway",
      detail: "the gateway answered unknown for this run and never described it again",
      gone: true,
    });
    if (wrote) {
      this.onLog(`run ${j.id}: the gateway answered unknown for run ${j.runId} — written off on ${why} (answers: ${seen})`);
    }
    return wrote;
  }

  // One terminal status, taken exactly once, for a run this panel can no longer watch. The restart is
  // recorded as the termination, so the notice says who ended it instead of guessing from a status word,
  // and a run that already settled is never rewritten.
  markInterruptedByRestart(j, { by = "gateway", detail = "", gone = false } = {}) {
    if (!j) return false;
    if (j.status !== "running" && j.status !== "starting") return false;
    this.terminate(j, by, { detail: detail || undefined });
    j.status = "interrupted";
    j.endedAt = j.endedAt || lastSeenIso(j);
    j.error = `the ${by} restarted while this was running${j.runId ? ` (run ${j.runId})` : ""}`;
    // `gone` is for the callers whose own probe PROVED the gateway has no record of the run (a 404 while the panel
    // was up). An interruption this panel caused itself — its own restart, or the gateway being replaced — knows no
    // such thing: the run may well still be there, so the chip stays available and the boot reconcile answers for it.
    j.runGone = Boolean(gone) || Boolean(j.runGone);
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
    // A backend that owns a process (Claude) must not leave it running under a turn that has its verdict.
    this.transportFor(j).abandon?.(j);
    this.finalise(j);
    this.emit(j);
    this.onLog(`run ${j.id} interrupted by a ${by} restart (${j.runId || "no run id"})`);
    return true;
  }

  // ---- the stop a card that is given up on still owes the gateway -------------------------------
  // A run lives in the gateway. Marking its card interrupted is a change to THIS PANEL'S store and nothing
  // else: the gateway goes on executing the turn for a client that is gone. Measured on this box — nine of
  // them, holding every concurrency slot, their `session_turn_leases` never cleared, so no new run could be
  // accepted until the gateway was restarted by hand. Every path that marks a run interrupted therefore asks
  // for a stop too, and every ask is journalled with its answer.
  //
  // 404 and 409 are SUCCESS here, not failure: a run the gateway has no record of, or one already ending, is
  // the state this is trying to reach. Nothing in here throws — an interrupt that could not reach the gateway
  // is still an interrupt, and a failed stop must never cost the reader the verdict.
  async stopRunAtGateway(j, { reason = "" } = {}) {
    const runId = j?.runId ? String(j.runId) : null;
    const entry = { at: new Date().toISOString(), jobId: j?.id ?? null, thread: j?.thread ?? null, runId, reason: String(reason || "").slice(0, 200), status: null, ok: false, already: false, error: null };
    // Nothing was ever submitted, so there is nothing under this card to stop — and nothing to journal either:
    // a line saying a stop was "sent" when no request went out would be the same kind of lie this replaces.
    if (!runId) return { ...entry, ok: true, skipped: true, error: "this turn has no run id, so there is nothing in the gateway to stop" };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      let res;
      try {
        res = await fetch(`${this.api.url}/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", headers: this.headers(), signal: ctrl.signal });
      } finally {
        clearTimeout(t);
      }
      entry.status = res.status;
      if (res.status === 404 || res.status === 409) {
        entry.ok = true;
        entry.already = true;
      } else if (res.ok) {
        entry.ok = true;
      } else {
        entry.error = `the gateway answered HTTP ${res.status} to the stop`;
      }
    } catch (e) {
      entry.error = `could not reach the gateway to stop run ${runId}: ${String((e && e.message) || e)}`;
    }
    return this.journalStop(entry);
  }

  // One line per ask, in the store's own journal and in the panel's log. Shaped like the attempts the caller
  // gets back, so a test reads the same thing the log says.
  journalStop(entry) {
    this.stopAttempts.push(entry);
    if (this.stopAttempts.length > 200) this.stopAttempts.splice(0, this.stopAttempts.length - 200);
    const how = entry.already ? `HTTP ${entry.status} — already gone` : entry.ok ? `HTTP ${entry.status}` : entry.error || "failed";
    this.onLog(`run ${entry.jobId || "?"}${entry.runId ? ` (${entry.runId})` : ""}: stop ${entry.ok ? "sent" : "FAILED"} — ${how}${entry.reason ? ` [${entry.reason}]` : ""}`);
    return entry;
  }

  // Every card in `list` gets one stop. Sequential on purpose: the point is that each run's answer is its own
  // line in the journal, not that ten stops are ten milliseconds faster.
  async stopInterruptedRuns(list = [], { reason = "" } = {}) {
    const out = [];
    for (const j of list || []) {
      if (!j) continue;
      out.push(await this.stopRunAtGateway(j, { reason }));
    }
    return out;
  }

  // Does the run this card points at belong to a gateway process that is no longer running? A run id is held
  // in one process's memory, so a card stamped with another process than the one `gateway_state.json` names
  // now is a run the current gateway cannot be executing.
  runPredatesGateway(j, identity = null) {
    if (!j?.runId) return false;
    const now = identity || gatewayIdentity();
    if (!now?.pid) return false; // nothing to compare against is not evidence of anything
    const stampedPid = Number(j.gatewayPid) || null;
    if (stampedPid) return stampedPid !== Number(now.pid) || String(j.gatewayStart ?? "") !== String(now.startTime ?? "");
    // A card from before the stamp existed. Compare the run's own start with the gateway's, and only when the
    // gateway's fingerprint IS a wall clock: Windows records centiseconds since the epoch, while Linux records
    // clock ticks since boot, which is not one — there the answer is "cannot tell", never "predates".
    const startMs = gatewayStartMs(now);
    const runMs = Date.parse(String(j.startedAt || ""));
    if (startMs === null || !Number.isFinite(runMs)) return false;
    return runMs < startMs;
  }

  // The boot sweep: the panel came back, and some of what it inherited as "going" belongs to a gateway that is
  // no longer the one answering. Those runs hold nothing the gateway will ever release for a client nobody
  // writes to any more, so ask for a stop on each — 404/409 tolerated, journalled like every other ask.
  // A card the boot reconcile RE-ATTACHED is `running` again and is never touched: it is live work.
  async stopStaleRuns({ identity = null, limit = 50 } = {}) {
    const now = identity || gatewayIdentity();
    const stale = [...this.jobs.values()]
      .filter((j) => j.restoredLive && j.runId && !isLiveJobStatus(j.status))
      .filter((j) => j.runGone === true || this.runPredatesGateway(j, now))
      .slice(0, Math.max(1, Number(limit) || 50));
    if (!stale.length) return [];
    const out = await this.stopInterruptedRuns(stale, { reason: "the panel came back and this run belongs to an earlier gateway" });
    for (const j of stale) delete j.restoredLive; // once per boot, not once per pass
    this.schedulePersist();
    return out;
  }

  // Is this thread — or the tree it works in — already busy? Every path that would POST a run into a worker asks this
  // first, because a reply is not a steer: the Runs API takes it as a NEW run on the thread and the gateway only
  // decides afterwards which one holds the session. Measured on this board: two TO lines to one thread took its
  // worktree from one live run to three, all editing the same files.
  //
  // "Busy" is a run that is going (running/starting). An `interrupted` card is NOT busy — that is a card whose stream
  // this panel lost, and picking it up is the whole point of the not-running pill. A run parked on a question or an
  // approval is not going either: answering it is how it gets to finish, so it must stay answerable.
  //
  // The answer names who holds it, so a refusal can say which run and where instead of "busy".
  busyFor(thread, { exceptId = null } = {}) {
    const t = String(thread || "");
    const live = [...this.jobs.values()].filter(
      (j) => isLiveJobStatus(j.status) && j.id !== exceptId,
    );
    const brief = (j) => ({ id: j.id, thread: j.thread, status: j.status, prompt: String(j.prompt || "").slice(0, 120) });
    const onThread = live.filter((j) => j.thread === t);
    if (onThread.length) return { held: true, where: "thread", thread: t, tree: null, by: onThread.map(brief) };
    const first = this.firstOfThread(t);
    const tree = treeOfJob(first);
    if (!tree) return { held: false, where: null, thread: t, tree: null, by: [] };
    const inTree = live.filter((j) => j.thread !== t && treeOfJob(j) === tree);
    if (inTree.length) {
      const where = first.ownerPath || first.worktreePath || first.cwd || null;
      return { held: true, where: "tree", thread: t, tree: where, by: inTree.map(brief) };
    }
    return { held: false, where: null, thread: t, tree: first.ownerPath || first.worktreePath || first.cwd || null, by: [] };
  }

  // Runs that stopped reporting while this panel is still up. Called from the server's watchdog. Returns
  // the runs it gave a terminal status to, which the caller wakes the assistant about — once.
  async sweepOrphanedRuns(now = Date.now()) {
    const watching = this.runningJobs().filter((j) => j.runId && (j.agent || "hermes") === "hermes");
    if (!watching.length) return [];
    // Only judge a run once the gateway itself answers: while it is down there is nothing to ask, and a
    // restart in flight must not be read as a lost run.
    const t = await this.probe({ fresh: true });
    if (!t.reachable) return [];
    const lost = [];
    for (const j of watching) {
      const p = await this.runProbe(j);
      if (p.known === false) {
        if (this.markInterruptedByRestart(j, { by: "gateway", detail: "the gateway restarted and no longer has this run", gone: true })) lost.push(j);
        continue;
      }
      if (p.known === true && p.run) {
        const said = String(p.run.status || "");
        if (TERMINAL_RUN.has(said)) {
          // The run's own result decides the card, and any unknown answer this probe collected was a run still
          // starting (a card that answered unknown once and then completed is a turn that finished normally).
          j.unknownAnswers = null;
          this.adoptRun(j, p.run);
          continue;
        }
        // `unknown` is the gateway declining to describe the run, not a live status: leaving it to the
        // re-attach below is what kept a card `running` for 48 minutes while every sweep was told nobody there
        // had the run. Count the answer, and write the card off once the answers are evidence.
        if (said === UNKNOWN_RUN_STATUS) {
          const verdict = this.noteUnknownAnswer(j, p, now);
          if (verdict.gone && this.writeOffUnknownRun(j, { answers: verdict.answers, why: verdict.why })) lost.push(j);
          continue;
        }
        // Anything else the gateway calls this run is live — forget the unknown answers, or one answer taken
        // while the run was starting would sit on the card and count towards a later silence.
        if (j.unknownAnswers) j.unknownAnswers = null;
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
      // The verdict is the panel's; the run is the gateway's. A card marked interrupted while the gateway still
      // executes the turn holds a concurrency slot and a `session_turn_lease` nobody is left to release — so the
      // gateway is told, once per run, before this sweep returns. A 404 here is the normal answer (the gateway
      // has no record of it) and is tolerated.
      await this.stopInterruptedRuns(lost, { reason: "the gateway restarted and this run is no longer reporting" });
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
  // The TODO block for a job's tree, as it stands RIGHT NOW — the same block a new brief is handed. A steer lands in
  // a turn that may have been running for an hour, so it carries the list as it is at this moment (with its ids)
  // rather than the one the worker was handed when it started. Empty string when this run has no tree of its own.
  todoTailFor(j) {
    if (!this.todos || !j) return "";
    const treePath = j.worktreePath || j.ownerPath || j.cwd;
    if (!treePath) return "";
    const where = String(treePath).split("\\").join("/").replace(/\/+$/, "");
    const list = this.todos.forRow(null, treePath, { journal: 0 });
    const block = todoBlockText(list, where, "");
    return block ? `\n\n---\n\n${block}` : "";
  }

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
    if (!j) return false;
    // A turn held on the gateway's 429 cap has no run to stop: the flag is what ends it, read by the hold
    // loop before every further attempt (a cancelled turn is never re-sent) and again after each wait.
    if (j.status === "waiting") {
      j.cancelRequested = true;
      this.emit(j);
      return true;
    }
    if (j.status !== "running") return false;
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
      if (isLiveJobStatus(j.status)) cur.running += 1;
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
    // A revive is a thread coming back to a tree it left: the card carries the tree's TODO list — the same block a
    // new brief is handed — so the reader sees what is still open before they reply, and the next turn is handed it
    // again by create(). The list is keyed on the ROW, so it outlives the panel, the card and the thread.
    const todoCarried = this.todoTailFor(j);
    if (todoCarried) j.lines.push({ kind: "dim", text: `⇢ the worktree's TODO list, handed to this thread:${todoCarried}` });
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
    const running = mine.filter((j) => isLiveJobStatus(j.status));
    if (running.length) return { ok: false, running: running.length, removed: 0 };
    for (const j of mine) this.jobs.delete(j.id);
    this.schedulePersist();
    return { ok: true, removed: mine.length, running: 0 };
  }
}
