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
import { CLARIFY_REFUSAL, createClarifyCapability, probeClarifyRoute } from "./clarify.js";
import { unwrapToolText } from "./tool-text.js";
import { completionPayload, outcomeFrom, readReport } from "./completion.js";
import { parseTodoLines, proposeClosed, todoBlock, todoCounts } from "./todos.js";
// The scratch line every spawn prompt carries: lib/paths.js owns the directory, so the wording and the path it
// names cannot drift apart from the one Settings offers to empty.
import { scratchLine, STATE_DIR_NAMES } from "./paths.js";
// A TODO tail belongs to a worktree, so the tail's own guard asks the cheap tree question (a `.git` of its own)
// before it hands a run a list it cannot reconcile.
import { treeOnDisk } from "./own-tree.js";
import { HttpError } from "./errors.js";
import { reasoningEffortForTurn, reasoningModelOptions } from "./reasoning.js";
// The sentence a worker gets about where its branch lands, and the branch identity a rename cannot change: the
// paragraph is keyed on the tree's PARENT branch, which is read from the cut record rather than assumed.
import { branchLandingLine } from "./branch-policy.js";
import { tagOf } from "./tree-names.js";
// Every tree is cut LOCAL (docs/pipelines.md §3). The record itself is lib/pipelines.js's schema; this module writes
// it at the one moment its `since` is honest — the cut — and carries a copy on the job for the card to draw.
import { cutPipeline as cutPipelineRecord, advanceStage, reviewWaitFor, readReviewExit, settleWait, claimWait, renderPrompt, waitIsDue, stageRunWaitFor, isRunWait } from "./pipelines.js";
// The approval window's fallback, held once: lib/hermes-config.js owns the value the gateway reads, and this
// module borrows it. It used to be a copied literal, because hermes-config.js imported `hermesHome` from here.
import { APPROVAL_TIMEOUT_DEFAULT as APPROVAL_WINDOW_DEFAULT } from "./hermes-config.js";
// Where Hermes keeps its files, which key the gateway wants and what a request looks like: not the run
// supervisor's business any more, so it lives in lib/hermes-runtime.js.
import {
  apiConfig, gatewayIdentity, hermesHome, lastSeenIso, makeThreadName, normaliseAttachments, previewRequest, readKeyFromEnvFile,
 } from "./hermes-runtime.js";
// The panel's child supervisor. Every git helper a turn starts is registered under that job's scope, so a
// settle (or a cancel that settles) kills the tree instead of leaving a hook or a scan behind. `panelChildren`
// is the default so a Jobs built without the option still supervises; a test injects its own.
import { panelChildren, scopeForJob } from "./child-tree.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
// The one answer to "may this run take a steer right now?" — the same file the page loads as a classic script
// (public/core/steerable.js, published on globalThis as `wtSteerable`), so the Steer control the card draws and
// this module's steer route can never disagree.
import "../public/core/steerable.js";

const {
  steerable: steerableOf,
  approvalOpen,
  refusalText,
  classifyRefusal,
  CODE: STEER_CODE,
  PAST_BOUNDARY,
  GONE,
} = globalThis.wtSteerable;

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
const STREAM_RETRY_MS = 1000;
const STREAM_RETRY_MAX_MS = 15_000;
let lineSeq = 0;

// The block the panel hands a run about its worktree's TODO list: the list WITH its ids, and the standing
// instruction to keep it current and to reconcile it against its own commits before finishing. `list` is what
// lib/todos.js holds for that tree — null when the tree has no list yet, and the block then says so rather than
// pretending there is one.
const todoBlockText = (list, where, project) => todoBlock(list?.items || [], { where, project });

// The paragraph that tells a worker it MAY ask for its own tree to go, and exactly how. It is handed in by server.js
// (only for a project with `releaseWorktrees` on) and it is the only place the grammar reaches a model: a worker that
// is never told about `RELEASE` can never use it. Deliberately conditional in its wording — the PR must ALREADY read
// MERGED, because the panel's gate is a fact about now, not a promise about later.
export const RELEASE_BRIEF = [
  "RELEASE — this worktree can ask the panel to remove it, because you never can: your shell is inside it and Windows keeps a busy directory.",
  "When this tree's work has LANDED (its pull request already reads MERGED) and the tree is clean, end your FINAL message with one line:",
  "  RELEASE <this worktree path> | <why it is finished>",
  "The panel decides after your turn has settled, from its own git and PR reads. A PR that is not merged yet, a changed file, or a run still holding the tree is a refusal with the reason written on the row — so do not ask early, and do not ask for a tree that is not yours.",
].join("\n");

// The paragraph that tells EVERY worker, on every turn, what a deliverable is and how to hand one back. It rides the
// same channel as the TODO block and the RELEASE paragraph — the prompt — because a marker nobody told the model
// about is a grammar nobody can use; the button and its list shipped without it, so a worker that produced a report
// and said so in prose left the reader with nothing to open.
//
// Two properties are load-bearing. NO line starts with `DELIVER`: the harvest reads lines that begin with the marker,
// so a paragraph a model echoes verbatim must not parse as a delivery (the marker is printed after `syntax:`/`example:`
// and the only target shown is a real path, never a `<…>` placeholder the parser would refuse out loud). And it is
// unconditional in a tree run — unlike RELEASE, which the project switches on — because a deliverable is what every
// finished row is judged by, whether or not that tree's list says so.
export const DELIVER_BRIEF = [
  "DELIVERABLES — a deliverable is a file or URL the reader can open, not a description of one. A sentence saying you wrote a report is not the report.",
  "When this turn produces one (a report, a page, a screenshot, a link), declare it with that one line in your FINAL message, one line per deliverable:",
  "  syntax: DELIVER <link|file|image> <target> | <title>",
  "  example: DELIVER file C:/path/to/report.html | The HTML report",
  "The target is the URL for a link, or the path for a file or an image — absolute, or relative to this worktree. The title is one short sentence: what it is, not what you did. The panel checks that the target exists, keeps the list and opens it; a line it cannot read is said on this card rather than dropped.",
  "A finished row with no deliverable is an incomplete row: if the reader has nothing to open, the work is not done, however complete the description reads.",
].join("\n");

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
// How long a route probe's verdict stands for one gateway build. Long enough that a board spawning a
// dozen workers is not a dozen extra requests, short enough that a patched-and-restarted gateway is
// re-learned within a coffee — and `noteVersion` clears it the moment the version changes anyway.
const CLARIFY_PROBE_MS = 10 * 60_000;
// How many answers are kept on the card: enough to show the pair that settled it, not the sweep's whole history.
const UNKNOWN_ANSWER_CAP = 4;
// The gateway's word for a session whose head admission it has lost. The store refuses to claim a session while any
// of its rows is `started`/`unknown` and raises this, so a run admitted on that session is ACCEPTED and never
// claimed — measured twice on this board (run_741516853a…, run_b0632b9cdae5…), each ending `unknown_execution` in
// 3-4s while GET /v1/runs/<id> answered `queued` with `execution_generation: null`. The fence is per session and
// survives the gateway's own restart (docs/research/gateway-fence-endpoints.md), so a repair that re-posts to the
// same `session_id` inherits the dead session and queues for ever. See `lostSessionOf()` for the next turn's
// repair, and `replaceLostSession()` for the answer taken at the moment the panel learns it.
const LOST_SESSION_CODE = "unknown_execution";

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

// The word a control call cannot survive. A run that has already ended has no waiter left to resume it, so an
// answer accepted against it was delivered to nobody — some gateway builds still resolve the prompt and answer
// `200 {status:"resolved"}`, so the route's own verdict is not this question's. `ctx.status` is the run's own
// status, from the read that fills the prompt id or from the control route's response; `resolved` (the clarify
// route's word for the PROMPT) is deliberately not terminal, and neither is an empty status.
const endedRunWord = (ctx = {}) => {
  const s = String((ctx && ctx.status) || "").trim();
  return TERMINAL_RUN.has(s) ? s : "";
};

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
  // The blanket rule is the DEFAULT policy's sentence, and a project may carry another (lib/remote-writes.js
  // `policyForProject`). Saying "local-only … a push will park and then fail" about a tree whose project ALLOWS pushes
  // is a false statement about the guard, and a worker believes it over the reader's own "push it" — so the caller hands
  // in the policy in force for this tree and the sentence follows it. No policy given is the default: local-only.
  const policy = String(o.branchPolicy ?? o.policy ?? "").trim().toLowerCase();
  if (policy === "allow") {
    return (
      `REMOTE WRITES ALLOWED: this project's push guard lets a push from this worktree${tree ? ` (${tree})` : ""} through without asking (remoteBranchPolicy: allow). ` +
      "Nothing pushes on its own, though: push a branch or open a pull request when the reader asks for one or when the work is meant to land, and not for a probe or a piece of research."
    );
  }
  if (policy === "deny") {
    return (
      `NO REMOTE WRITES: this project refuses a push from this worktree${tree ? ` (${tree})` : ""} outright (remoteBranchPolicy: deny) — ` +
      "do not `git push`, do not create a remote branch and do not open a pull request; report what you found instead."
    );
  }
  // The per-remote switch the reader turned on in Settings: the push is not parked on the permission box. It grants
  // "do not ask", never "push on your own", so the second sentence stays exactly what it was.
  if (o.allowPushWithoutAsking === true) {
    return (
      `REMOTE WRITES ALLOWED WITHOUT ASKING: this remote's "Allow push without asking" switch is on for this project, so a push from this worktree${tree ? ` (${tree})` : ""} goes through without a question. ` +
      "Nothing pushes on its own, though: push a branch or open a pull request when the reader asks for one or when the work is meant to land, and not for a probe or a piece of research."
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

export { clarifyText, runRefusal, toolGlyph } from "./jobs/console-lines.js";

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

// A ref that names a BRANCH, or null. A sha (a tree cut from a detached HEAD) is not a branch a tree could land on or
// merge into, and an object is not a name at all: `String(record)` is how a brief once said "cut from `[object Object]`".
const branchNameOf = (ref) => {
  const s = typeof ref === "string" ? ref.trim() : "";
  return s && !/^[0-9a-f]{7,40}$/i.test(s) ? s : null;
};

// One git question, and null instead of a throw: every use here is advisory (a paragraph, a record), so a missing
// git or a directory that is not a checkout must cost the answer, not the run.
const gitOut = async (cwd, args, timeout = 20_000) => {
  try {
    const { stdout } = await panelChildren.exec("panel", "git", ["-C", cwd, ...args], { timeout, kind: "git", maxBuffer: 1024 * 1024 });
    return String(stdout || "").replace(/\r\n/g, "\n").trim();
  } catch {
    return null;
  }
};
export function treeOfJob(j) {
  if (!j) return null;
  return normTree(j.ownerPath || j.worktreePath || j.cwd);
}

// Every LIVE job standing in one tree. The board digest already lists each live run with its thread and its
// tree; this is the same fact as a lookup, so a spawn can be refused where it would start instead of being
// found out afterwards. `cwd`, `ownerPath` and `worktreePath` are all consulted (see treeOfJob): a run that has
// not been handed a directory yet has none, and a tree cut for a run is its `ownerPath` even when its cwd is a
// subdirectory. A path key, like every other ownership comparison in this file.
export function liveJobsInTree(jobs = [], tree, { exceptId = null } = {}) {
  const want = normTree(tree);
  if (!want) return [];
  return (jobs || []).filter((j) => j && isLiveJobStatus(j.status) && j.id !== exceptId && treeOfJob(j) === want);
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

// ---- the waits that belong to a person ---------------------------------------------------------------
// A run parks for a human in exactly two shapes: the `clarify` tool's question (with the options the tool
// offered) and an approval (a flagged command, with the choices the host allows). Both live on the job
// record and both are answered by ONE control call. The panel shows them on a second surface too — the
// Matrix room the bridge already talks in — so this enumeration lives here, once, beside the label table
// and the destructive test: a room message that offered a different choice, or a different word for one,
// would be a second answer to "what does A mean".
export const APPROVAL_CHOICE_LABEL = { once: "Allow once", session: "Allow for this session", always: "Always allow", deny: "Deny" };

// The alphabet a room reply is read from. Ten is more than any prompt the tool poses and keeps a reply one
// character, which is what makes "B" unambiguous in a chat window.
export const WAIT_LETTERS = "ABCDEFGHIJ";

// The clarify tool marks its best option by suffixing the label; the card draws that as a chip. The room
// message says it in words, so an option reads the same in both places without a second label table.
const RECOMMENDED_TAIL = /^(.*?)\s*\(recommended\)\s*$/i;

// What a person should be asked TWICE about. Two vocabularies on purpose: an approval is judged by the
// command it would run, a clarify option by its own words — a question that OFFERS "delete the branch" next
// to "keep it" must not make "keep it" destructive as well.
const DESTRUCTIVE_COMMAND = [
  /\brm\s+/i,
  /\brmdir\b/i,
  /\bdel\s+\/[fsq]/i,
  /\bremove-item\b/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+push\b[^\n]*--force\b/i,
  /\bgit\s+worktree\s+remove\b[^\n]*--force\b/i,
  /\b(?:drop|truncate)\s+(?:table|database|schema)\b/i,
  /\bdelete\s+from\b/i,
  /\b(?:shutdown|reboot)\b/i,
  /\btaskkill\b/i,
  /\bkill\s+-9\b/i,
];
const DESTRUCTIVE_OPTION = /\b(delete|remove|drop|discard|overwrite|wipe|truncate|destroy|purge)\b/i;

// A heuristic, and only ever used to ASK A SECOND TIME: it can cost a confirmation it did not need, never
// an action it should have stopped.
export function isDestructiveAsk(text) {
  const t = String(text == null ? "" : text);
  if (!t.trim()) return false;
  return DESTRUCTIVE_COMMAND.some((re) => re.test(t)) || DESTRUCTIVE_OPTION.test(t);
}

// One job -> the waits on it, as the room message needs them: a stable key (so a repaint cannot send a second
// copy), the request id the control call needs, the prompt, and the lettered options. `value` is what the
// control call posts — the clarify tool's label verbatim, an approval's choice key — and `label` is what a
// person reads.
export function waitsOf(job) {
  const j = job || {};
  const id = String(j.id || "");
  const title = String(j.title || j.label || j.thread || id).trim();
  const where = String(j.branch || j.worktree || j.cwd || "").trim();
  const out = [];
  if (j.question) {
    const q = j.question || {};
    const labels = (Array.isArray(q.choices) ? q.choices : []).map((c) => String(c)).filter((c) => c.trim());
    out.push({
      // The question's own key when the job record carries one (`j.question.key`, written when the
      // prompt arrived): a re-ask updates that record in place, so the room's message — which is keyed
      // by this and never re-sent — stays ONE message for ONE question.
      key: q.key || `clarify:${id}:${q.requestId || q.at || ""}`,
      kind: "clarify",
      jobId: id,
      thread: j.thread || null,
      requestId: q.requestId || null,
      title: title || "a parked question",
      where,
      prompt: String(q.question || ""),
      multiSelect: Boolean(q.multiSelect),
      at: q.at || null,
      deadline: Number(q.deadline) || null,
      // How many times the panel has asked the reader again about this prompt (`Jobs.reaskQuestion`).
      reasks: Number(q.reasks) || 0,
      choices: labels.map((label, i) => {
        const m = RECOMMENDED_TAIL.exec(label);
        return {
          letter: WAIT_LETTERS[i] || "",
          value: label,
          label: m ? `${m[1]} — recommended` : label,
          destructive: isDestructiveAsk(label),
        };
      }),
    });
  }
  if (j.approval) {
    const a = j.approval || {};
    const keys = (Array.isArray(a.choices) && a.choices.length ? a.choices : ["once", "deny"]).map((c) => String(c));
    const harms = isDestructiveAsk(a.command);
    out.push({
      key: `approval:${id}:${a.requestId || a.at || ""}`,
      kind: "approval",
      jobId: id,
      thread: j.thread || null,
      requestId: a.requestId || null,
      title: title || "a parked approval",
      where,
      prompt: String(a.command || ""),
      multiSelect: false,
      at: a.at || null,
      deadline: Number(a.deadline) || null,
      choices: keys.map((value, i) => ({
        letter: WAIT_LETTERS[i] || "",
        value,
        label: APPROVAL_CHOICE_LABEL[value] || value,
        // Denying never runs the command, so it is never the destructive side of the box.
        destructive: harms && value !== "deny",
      })),
    });
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
function frameEvent(frame) {
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

export class Jobs {  constructor({ config = {}, onEvent = () => {}, onLog = log, clarifyWindow = null, approvalWindow = null, children = panelChildren } = {}) {
    this.config = config;
    this.onEvent = onEvent;
    this.onLog = onLog;
    // The child supervisor (lib/child-tree.js). A job owns the scope `job:<id>`: whatever a helper started
    // for that turn is killed with its tree when the turn settles, so nothing a run spawned outlives it.
    this.children = children;
    // The gateway's clarify window, as a getter: an API run's `clarify.request` carries no `timeout_s`
    // (the gateway only fills it for a local viewer), so the countdown is measured against this.
    this.clarifyWindow = clarifyWindow;
    // …and the same for the approval window, which the gateway reads from `approvals.timeout` in the config
    // file the panel already reads for the Settings screen. A parked approval has a deadline, and a card that
    // does not know it is a card that keeps offering a decision the gateway has already made.
    this.approvalWindow = approvalWindow;
    this.jobs = new Map();
    // Questions whose answer is being POSTed right now, by job id. An answer is a round trip to the
    // gateway (control context, then the clarify route), and while it is open the question still sits
    // on the record - so the sentry's hourly re-ask can land in that window and re-publish a question
    // the reader has already answered. The entry is written before the first await and removed in a
    // `finally`, so a failed answer whose question stays open can still be re-asked later.
    this.questionAnswers = new Map();
    // …and the same single flight for an approval. A permission box can be open on the board card and on the
    // pinned copy of the same turn, and the second press used to spend a second POST: the gateway answered the
    // first 200 and the second `409 approval_not_pending`, and that verdict wrote "not answered here" over the
    // decision the reader had just taken. The entry is per job and names the request it is answering, so a
    // different prompt on the same turn is not held by it.
    this.approvalAnswers = new Map();
    // Every ask the panel has made of the gateway to STOP a run it gave up on, with the answer. Kept because
    // the failure this exists for was silent: a card read interrupted while the gateway went on executing the
    // turn, and nothing anywhere said whether a stop had ever been sent.
    this.stopAttempts = [];
    this.api = apiConfig(config);
    if (!this.api.key) {
      const fromFile = readKeyFromEnvFile();
      if (fromFile) this.api.key = fromFile;
    }
    this.transport = { url: this.api.url, reachable: null, checkedAt: 0, capabilities: null, error: null, keyed: Boolean(this.api.key) };
    // What this gateway build can do with the `clarify` tool, learned from its own events: a
    // clarify.request proves the round trip works, the tool's "not available" refusal proves it does
    // not. See lib/clarify.js for why the answer is observed rather than configured.
    this.clarify = createClarifyCapability();
    // When the answer ROUTE was last probed, and the verdict it gave. Memoised because the probe is a
    // request to the gateway: once a build has answered, asking again every turn would be a request per
    // run for a fact that changes only when the build does (and `noteVersion` clears it when it does).
    this.clarifyProbeAt = 0;
    // The probe currently in flight, so a burst of runs shares it instead of asking the same question N times.
    this.clarifyProbePromise = null;
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
    // The pipeline catalogue (`Pipelines`) and the durable per-tree book (`PipelineRecords`). Both are injected by
    // server.js — a Jobs built by a test simply has no catalogue, and a settle then registers no stage timer because
    // there is no definition to read a stage's exit from. `waitsRunning` is the sweep's own "one pass at a time".
    this.pipelines = null;
    this.pipelineRecords = null;
    this.waitsRunning = false;
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
    // A window that closed is not the only way an approval stops being answerable: the gateway can resolve
    // the request on another surface, or replay an `approval.request` its buffer still holds after letting the
    // request go. Either way the card is drawn from an event, and the panel cannot tell from the event alone.
    // This reads the run's own `pending_controls` on a slow clock and marks the card answerable only when the
    // gateway still lists it; the page then draws no choices for one it cannot send.
    this.approvalReconcile = setInterval(() => {
      void this.reconcileApprovals();
    }, 5_000);
    this.approvalReconcile.unref?.();
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

  // The panel's approval record, reconciled against the run that owns it BEFORE a card is offered.
  // `sweepApprovals` above only knows this panel's clock; the gateway can let a request go without publishing
  // anything, so the card's `pending_controls` is the only answer to "do you still hold this?". A record the run
  // no longer holds is dropped here, which is what keeps a phantom box (buttons over a request that can no
  // longer be answered) off the next snapshot. The decision already recorded here is never overwritten: a
  // reconcile that finds the box gone is a fact about the BOX, not a verdict on what the reader did.
  //
  // `approval.request` is replayed from the run's buffer on every reconnect, so the event is not proof the
  // request is still there; `pending_controls` is. A card with buttons for a request the gateway has let go
  // spends a POST to be told approval_not_pending, and the transcript then reads as though the reader never
  // pressed. A failed read says nothing (the card keeps its choices); only a read that answered with no
  // approval control withdraws the card, and it does so without blaming the reader.
  async reconcileApprovals(now = Date.now(), ids = null) {
    const want = ids ? new Set([].concat(ids).filter(Boolean).map(String)) : null;
    let changed = 0;
    for (const j of this.jobs.values()) {
      if (want && !want.has(String(j.id))) continue;
      const a = j.approval;
      if (!a || a.gone || !j.runId) continue;
      if (a.checkedAt && now - a.checkedAt < 5_000) continue;
      a.checkedAt = now;
      const ctx = await this.controlContext(j);
      // The card can be answered, replaced or expired while the read was open.
      if (j.approval !== a) continue;
      // The run itself is gone: nothing on this board can answer the card any more, and keeping it is exactly
      // the phantom this pass exists to remove.
      if (ctx.gone) {
        a.gone = true;
        this.expireApproval(j, now, "withdrawn");
        changed++;
        continue;
      }
      if (!ctx.read) continue;
      const answerable = Boolean(ctx.pending);
      if (a.answerable !== answerable) {
        a.answerable = answerable;
        if (answerable) this.emit(j);
      }
      if (!answerable) {
        a.gone = true;
        this.expireApproval(j, now, "withdrawn");
        changed++;
      }
    }
    return changed;
  }

  // The one way an unanswered approval leaves the board: what happened is recorded in `approvalDone` (with an
  // empty choice, so "denied" and "nobody answered" never read as the same thing), the console keeps a line,
  // and the box goes. `reason` is `expired` when this panel's clock reached the gateway's window, and
  // `withdrawn` when the gateway itself said it no longer holds the request.
  expireApproval(j, now = Date.now(), reason = "expired", { clicked = false } = {}) {
    const a = j.approval;
    if (!a) return false;
    const waited = Math.max(0, Math.round((now - (Date.parse(a.at || "") || now)) / 1000));
    // A decision already recorded here is not the card's to overwrite. The press that loses a race (a second
    // click, or an answer another surface sent first) used to write "not answered here" over "approved once",
    // which reads as though the reader never pressed. The box goes; the decision stands.
    const decided = String(j.approvalDone?.choice || "").trim();
    j.approval = null;
    if (decided) {
      this.onLog(`run ${j.id}: approval ${reason} after ${waited}s (already decided here: ${decided})`);
      this.emit(j);
      return true;
    }
    j.approvalDone = {
      choice: "",
      command: a.command || "",
      at: new Date(now).toISOString(),
      // Nothing was decided here. The card shows this, and the assistant's `approval` rule stops seeing a job
      // parked on a person the moment the box is gone.
      expired: true,
      reason,
      // Did the reader press? A request that went away before the card was answered and one that lost the
      // race with the reader's own press are different events, and only the second may read as "answered".
      clicked: Boolean(clicked),
      waitedSeconds: waited,
    };
    this.push(j, {
      kind: "dim",
      text:
        reason === "withdrawn"
          ? clicked
            ? "⇢ the gateway no longer held that permission when the answer was sent (it expired, was answered on another surface, or was stopped) - nothing was decided here"
            : "⇢ the gateway no longer holds that approval (it expired, was answered on another surface, or was stopped) - nothing was decided here"
          : `⇢ no answer within the gateway's ${a.timeoutSeconds || APPROVAL_WINDOW_DEFAULT}s window — the gateway denied it and the agent carried on`,
    });
    this.onLog(`run ${j.id}: approval ${reason} after ${waited}s (${clicked ? "the reader's answer lost the race" : "no answer"})`);
    this.emit(j);
    return true;
  }

  // The gateway's own verdict that it no longer holds the request — `approval_not_pending` after its window
  // closed, or `approval_not_active` once the approval session is gone. Nothing was decided here either way, and
  // the same handling serves the first post and the self-heal retry. `clicked` is true on both because this is
  // only reached from a press: the record then says the reader did answer, not that nobody did.
  approvalGone(j, code, { clicked = true } = {}) {
    this.expireApproval(j, Date.now(), "withdrawn", { clicked });
    return {
      ok: false,
      gone: true,
      code,
      error: clicked
        ? `the gateway no longer held this permission when your answer was sent (${code}) - nothing was decided here`
        : `the gateway no longer holds this approval (${code}) - it had expired, was answered on another surface, or was stopped, so nothing was decided here`,
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
      // A different gateway version is a different build, so a refusal observed on the old one is
      // not evidence about this one — the record clears and is re-learned from the next run's events.
      this.clarify.noteVersion(caps.version);
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
          modelOptions: Boolean(features.model_options),
          // The local gateway patch adds these. A stock gateway ignores the fields silently, so the
          // panel says which of them this run will actually honour.
          runCwd: Boolean(features.run_cwd),
          runBudget: Boolean(features.run_budget),
          maxTurns: Boolean(features.max_turns),
          version: caps.version || null,
          // true/false only once a run has proved it either way; null means "not observed yet" and
          // the panel behaves exactly as it did before this check existed. See lib/clarify.js.
          clarify: this.clarify.state().available,
        },
      };
    } catch (e) {
      this.transport = { ...this.transport, reachable: false, checkedAt: now, keyed: true, error: String((e && e.message) || e) };
    }
    return this.transport;
  }

  transportInfo() {
    // `clarify` rides beside the capabilities probe: true/false once a run has proved it, null while
    // nothing has been observed. The settings surface and /api/state read this, so a reader can tell
    // "the build cannot ask" from "no question has come up yet" without reading the source.
    return { ...this.transport, clarify: this.clarify?.state?.() || null };
  }

  // ---- the clarify route, proved rather than assumed ----------------------------------------------
  // `probe()` above reads /v1/capabilities, and that is a HINT: a build can carry the answer route
  // without advertising it. The box this panel was measured on does exactly that — the installed build
  // answers `POST /v1/runs/{id}/clarify` with `run_not_found` for an id that does not exist, and its
  // capabilities object names no clarify feature at all (docs/clarify-over-the-runs-api.md has the
  // transcript). So the panel asks the ROUTE, once per build, with a run id it made up.
  //
  // It runs before a run's body is composed, because the verdict changes what that body SAYS: a build
  // that can deliver a question is told to call the tool and stay parked; one that cannot is told to
  // ask in prose and end the turn; an unknown build is told nothing. Memoised per gateway version —
  // a probe per turn would be a request per run for a fact only a restart changes.
  async proveClarifyRoute({ fresh = false } = {}) {
    const now = Date.now();
    const st = this.clarify?.state?.() || {};
    // The memo is the RECORD, not a separate key: a verdict this recent is the answer, and a build
    // change clears the record (`noteVersion`), which is what makes the next run probe again. Keying
    // it on the version string alone missed the first probe of a process, because the version is not
    // known until the capabilities read has happened.
    const settled = st.route === true || st.route === false;
    if (!fresh && settled && this.clarifyProbeAt && now - this.clarifyProbeAt < CLARIFY_PROBE_MS) return st;
    if (!this.api?.url || !this.api?.key) return this.clarify.state();
    // One probe in flight at a time. A burst of spawns calls create() together, and the record is only
    // written once the answer is back — without this, six workers would be six probes of a build the
    // first one is already asking about.
    if (this.clarifyProbePromise) return this.clarifyProbePromise;
    const run = (async () => {
      let out = null;
      try {
        out = await probeClarifyRoute({ url: this.api.url, headers: this.headers() });
      } catch (e) {
        out = { present: null, evidence: String((e && e.message) || e) };
      }
      this.clarifyProbeAt = now;
      if (out && (out.present === true || out.present === false)) {
        if (this.clarify.noteRoute({ present: out.present, evidence: out.evidence })) {
          this.onLog(`gateway: the clarify answer route is ${out.present ? "present" : "absent"} — ${out.evidence}`);
        }
      }
      return this.clarify.state();
    })();
    this.clarifyProbePromise = run;
    try {
      return await run;
    } finally {
      if (this.clarifyProbePromise === run) this.clarifyProbePromise = null;
    }
  }

  // ---- persistence ---------------------------------------------------------------------
  load() {
    if (!this.storePath || !existsSync(this.storePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.storePath, "utf8"));
      const restored = [];
      for (const j of saved.jobs || []) {
        // A run lives in the gateway, not in this process, so a panel restart does not necessarily
        // mean the agent stopped — and until this panel asks, it does not know. A card that was live
        // with a run id therefore comes back LIVE and PENDING: writing it `interrupted` here was the
        // panel claiming an ending nobody had reported, and one restart put that word over three runs
        // the gateway was still executing. `reconcileRestored()` asks the run's own endpoint and
        // `settleRestoredRun()` is the only thing allowed to write a terminal word for it — re-attached
        // for a run the gateway still holds, the gateway's own ending for one it has finished, and the
        // restart's verdict only when the ask itself failed.
        // A live card with NO run id is the one case that cannot be asked about: the POST never became
        // a run (or the 429 hold never sent one), so it keeps the old, immediate write-off.
        if (isLiveJobStatus(j.status) && j.runId) {
          j.restoredLive = true;
          // The pending marker the boot reconcile, the orphan sweep and the manual chip all read. It is
          // persisted, so a second death before the answer does not lose the fact that this card is owed one.
          j.awaitingGateway = true;
          // The run's own clock was never stopped, and a live card has no completion: an older store may
          // carry the wording a previous build wrote here, which is a guess the ask is about to replace.
          j.endedAt = null;
          if (/^the panel restarted while this was running/.test(String(j.error || ""))) j.error = "";
          if (j.completion?.word === "interrupted") j.completion = null;
          j.outcome = null;
        } else if (j.status === "running" || j.status === "starting" || j.status === "waiting") {
          const wasHeld = j.status === "waiting";
          j.status = "interrupted";
          j.error = j.error || (wasHeld
            ? "the panel restarted while this turn was held waiting for a run slot (HTTP 429 — the gateway was at its concurrent-run cap)"
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
            // The assistant's own turn, so the settle wake can still tell it from a worker's after a restart.
            assistant: Boolean(j.assistant),
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
            // Why this turn is in a different session from the thread it belongs to. Without it a reload turns a
            // replaced-session repair back into an ordinary turn and the card stops saying what happened.
            sessionReplaced: j.sessionReplaced || null,
            // What the run left behind: the word it ended on, the notice built from it, and the facts that
            // notice is made of. Persisted because the panel can be restarted between a worker finishing and
            // the wake that reports it.
            outcome: j.outcome || null,
            termination: j.termination || null,
            branch: j.branch || null,
            baseSha: j.baseSha || null,
            // Where this tree stood in a pipeline when the store was last written. The durable record is the tree's
            // (lib/pipelines.js), and this copy is what a card whose tree book has gone missing can still draw.
            pipeline: j.pipeline || null,
            finalMessage: j.finalMessage || null,
            // The DELIVER note is FIRED ONCE per message: a second `measureTree` over the same final message (the
            // re-read after a rename, the reconcile a restart runs) must not record its lines twice. Cheap insurance
            // rather than load-bearing — a settled job is never re-measured at boot.
            deliverHarvested: Boolean(j.deliverHarvested),
            tree: j.tree || null,
            completion: j.completion || null,
            startedAt: j.startedAt, endedAt: j.endedAt, model: j.model, reasoningEffort: j.reasoningEffort ?? null, yolo: j.yolo,
            budget: j.budget, maxTurns: j.maxTurns, tokens: j.tokens, error: j.error,
            // A 404 on this card's run survives the process that learned it: without this a reload would put
            // the re-attach chip back on a card whose run is provably gone, and every press would be a wasted question.
            runGone: Boolean(j.runGone),
            // A restored live card is owed one question to the gateway. Persisted so a second death before the
            // answer does not turn the card into a plain running one that nothing is waiting to settle.
            awaitingGateway: Boolean(j.awaitingGateway),
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
    // The SESSION's counters, not the thread's: a turn that replaced a lost session is the first turn of a new
    // session, and reading the old id would measure another conversation's totals.
    const now = this.sessionOutput(j.sessionId || j.thread);
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
      const dbStats = usageStats(j.sessionId || j.thread, {
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
      yolo: j.yolo,
      origin: j.origin || null,
      // Set once a turn's subagent results have been sent back to it, so no reload, tab or second reader collects it
      // again (localStorage is per browser; this is per job).
      collected: j.collected || null,
      model: j.model, reasoningEffort: j.reasoningEffort ?? null,
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
      // The pipeline in force for this tree: `{id, stage, since, history[]}` (docs/pipelines.md §3). Read from the
      // tree's durable record, or the copy the cut wrote onto the job; null only for a card with no tree.
      pipeline: this.pipelineForJob(j),
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
      // True for the board assistant's own turns: the one card no rule may wake it about.
      assistant: Boolean(j.assistant),
      // The assistant that started this run, so "whose turn is this" is a fact about the job store rather than an
      // inference from a tree path (lib/assistant.js `assistantIdForJob`).
      assistantId: j.assistantId || null,
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
      // Present only on a repair whose thread had lost its session: {from, to, why, runId}. The card draws its
      // `new session` chip from this, so the reader can tell a cold repair from a warm retry at a glance.
      sessionReplaced: j.sessionReplaced || null,
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
      // A live card a restart restored that has NOT been answered for yet: the card is running on the board, the
      // panel is holding no stream, and the pulse must not claim the gateway went quiet.
      restoredPending: Boolean(j.awaitingGateway),
      // Files this agent produced that a reader would open (docs, scripts, keys), oldest first.
      artifacts: j.artifacts || [],
      // Documents the reader attached to this turn: links on the card, while the gateway got the paths
      // inside the prompt text (its runs API has no attachment field).
      attachments: j.attachments || [],
      // A steer that arrived too late to land: the card offers it back as an unsent draft rather than turning it
      // into a second answer the reader did not ask for.
      pendingSteer: j.pendingSteer || null,
      // Present only while the run is parked on a flagged command; the card renders its buttons
      // from `choices`, so the panel can never offer a choice the host did not allow. `answerable` is this
      // panel's own read of whether those buttons can lead anywhere: no run, no permitted choice, a closed
      // window or a record the gateway has proved it no longer holds all draw the note instead.
      approval: j.approval ? { ...j.approval, answerable: this.approvalAnswerable(j) } : null,
      // …and once answered, one line recording what was decided (the prompt text is kept too, so
      // the collapsed line can say what it approved without a second lookup).
      approvalDone: j.approvalDone || null,
      // Whether this card may offer its Steer control right now, and why not when it may not — ONE predicate
      // (public/core/steerable.js), read by the page from this field and by the steer route from the same object, so
      // a parked run or a run the gateway no longer has never offers a control the gateway would refuse.
      steerable: this.steerable(j),
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

  // A worktree renamed on disk — its directory AND its branch, which is what the panel's naming does — takes every
  // record the panel keeps about that tree with it. `cwd`, `ownerPath` and `worktreePath` were the first three and
  // for a while the only three: measured by the panel's own dogfood run, the job that cut the tree was left with
  // `branch` and `tree.branch` spelling a branch git no longer had, and `tree.path` / `completion.worktree`
  // spelling a directory that was gone. A record that quotes a dead path is worse than no record — the card, the
  // digest the assistant reads and the completion notice all say "this is where the work is", and it is not.
  //
  // `branch`/`oldBranch` are the branch the tree's branch became and the one the records were written with; both
  // optional, because a rename whose branch half did not land moves nothing by name. Branch names are
  // case-sensitive in git, so they are compared exactly; paths keep the case-insensitive comparison every other
  // path in this file uses. `renamedFrom` is stamped on the records that moved, so a card can say the tree was
  // renamed instead of pretending the new path was always the one it had.
  repointPath(oldPath, newPath, { branch = null, oldBranch = null } = {}) {
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const clean = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const from = norm(oldPath);
    const to = clean(newPath);
    const branchFrom = String(oldBranch || "").trim() || null;
    const branchTo = String(branch || "").trim() || null;
    const branchMoved = Boolean(branchFrom && branchTo && branchFrom !== branchTo);
    // A branch-only rename passes the SAME path twice (the directory was held open and git refused to move it), and
    // that is not a move: stamping `renamedFrom` there would tell the reader a directory changed when none did.
    const pathMoved = Boolean(from && to && from !== norm(to));
    if (!pathMoved && !branchMoved) return 0;
    // The worktree's TODO list is keyed on this path (the row's own key), so it moves with the tree: without this a
    // renamed tree would come back with an empty section and the old list would be orphaned.
    if (pathMoved) this.todos?.repointPath?.(oldPath, to);
    const renamedFrom = pathMoved ? clean(oldPath) : null;
    let moved = 0;
    for (const j of this.jobs.values()) {
      let touched = false;
      if (pathMoved) {
        for (const field of ["cwd", "ownerPath", "worktreePath"]) {
          if (j[field] && norm(j[field]) === from) {
            j[field] = to;
            touched = true;
          }
        }
        // The measured tree and the completion payload are the two records that quote where the work IS; both
        // carry a path field and both were left behind by the old repoint.
        for (const holder of [j.tree, j.completion]) {
          if (!holder || typeof holder !== "object") continue;
          for (const field of ["path", "worktree", "movedTo"]) {
            if (holder[field] && norm(holder[field]) === from) {
              holder[field] = to;
              holder.renamedFrom = renamedFrom;
              if ("treeExists" in holder) holder.treeExists = existsSync(to);
              touched = true;
            }
          }
        }
      }
      if (branchMoved) {
        for (const holder of [j, j.tree, j.completion]) {
          if (!holder || typeof holder !== "object" || !holder.branch) continue;
          if (holder.branch === branchFrom) {
            holder.branch = branchTo;
            touched = true;
          }
        }
      }
      if (!touched) continue;
      moved += 1;
      this.emit(j);
    }
    return moved;
  }

  // A job record that names a directory which is no longer there, resolved through the naming ledger (whose key is
  // the six-hex tag a rename keeps) or told plainly that it cannot be placed. The rename itself repoints every
  // record it can see (above), but a record that was ALREADY stale when this process booted — a card restored over
  // a tree renamed by an earlier process, or a tree another tool moved — was written with a path nothing will ever
  // move. `resolve` answers `{ path, branch }` for one dead reference, or null; a job nothing can place keeps its
  // record and says so, because a card that quietly quotes a dead path is the bug this exists to close.
  reconcileTreeRecords({ resolve = () => null, exists = (p) => existsSync(p) } = {}) {
    let moved = 0;
    let unresolved = 0;
    for (const j of this.jobs.values()) {
      const clean = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const paths = [...new Set([j.tree?.path, j.completion?.worktree, j.worktreePath, j.ownerPath, j.cwd].map(clean).filter(Boolean))];
      const gone = paths.filter((p) => !exists(p));
      if (!gone.length) continue;
      let hit = null;
      for (const p of gone) {
        hit = resolve({ job: j, path: p, branch: j.branch || j.tree?.branch || j.completion?.branch || null, projectPath: j.projectPath || null });
        if (hit?.path) break;
      }
      if (hit?.path && exists(hit.path)) {
        for (const p of gone) this.repointPath(p, hit.path, { branch: hit.branch || null, oldBranch: j.branch || null });
        moved += 1;
        continue;
      }
      // A record that ALREADY says its tree is gone has nothing left to reconcile: its note is the measurement's own
      // reason (a `-w` run that commits nothing has its tree removed at the end), and rewriting it on every boot
      // would replace a fact with a guess. Only a record still claiming a live tree can be quoting a dead path as
      // if it were where the work is.
      if (j.tree?.exists === false || j.completion?.treeExists === false) continue;
      const note = `the recorded path no longer exists (${gone[0]}) — the tree was renamed or removed, and the panel's naming ledger has no record of its new name`;
      if (j.tree) {
        j.tree.pathGone = true;
        j.tree.note = j.tree.note || note;
      }
      if (j.completion) {
        j.completion.treeExists = false;
        j.completion.treeNote = j.completion.treeNote || note;
      }
      j.treeStale = { path: gone[0], at: new Date().toISOString(), why: "the tree was renamed or removed; the naming ledger cannot place its new name" };
      unresolved += 1;
      this.emit(j);
    }
    return { moved, unresolved };
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
      // The browser now holds this line, at this text. A `set` frame that repeats it would be a row re-parsed
      // for nothing (flushText below), so the emission is remembered per job, not per queue tick.
      j.textSent = { lid: j.curText.lid, text: j.curText.text };
      this.scanUrls(j, fragment);
      return;
    }
    // Anything else joining the console closes the open paragraph first, so the reader's lines are in the
    // order the run produced them even though the paragraph behind them was coalesced.
    this.flushText(j);
    if (line.kind === "result" || line.kind === "init") {
      j.curText = null;
      j.textSent = null;
    }
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
  //
  // A frame the browser would draw identically is not sent. Some deltas change only whitespace that push()
  // strips, and every non-text line flushes the open paragraph before it joins, so the same text was going out
  // two or three times per second and the page re-parsed the row for each one (measured: ~half of the frames on a
  // growing paragraph were byte-identical to the one before, docs/console-redraw-spam.html).
  flushText(j) {
    clearTimeout(j.textTimer);
    j.textTimer = null;
    if (!j.curText) return;
    const sent = j.textSent;
    if (sent && sent.lid === j.curText.lid && sent.text === j.curText.text) return;
    j.textSent = { lid: j.curText.lid, text: j.curText.text };
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
      // Registered under the job's scope: a sweep still running when its scope is killed dies with it.
      out = (await (this.children || panelChildren).exec(scopeForJob(j.id), "git", ["-C", j.cwd, "status", "--porcelain", "--untracked-files=normal"], {
        timeout: 15_000,
        kind: "git",
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
          listed = (await (this.children || panelChildren).exec(scopeForJob(j.id), "git", ["-C", j.cwd, "ls-files", "--others", "--exclude-standard", "--", rel], {
            timeout: 15_000,
            kind: "git",
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
  // The ref a new tree is cut from: the branch the project checkout is on, or the sha it is parked at. `git worktree
  // add -b <branch> <path>` with no start ref silently uses HEAD and forgets it, which is why the panel used to know
  // where a tree began only for as long as the reflog remembered. Read it here, pass it explicitly, record it.
  async startRefOf(repoDir) {
    try {
      const { stdout: cur } = await panelChildren.exec("panel", "git", ["-C", repoDir, "symbolic-ref", "--short", "HEAD"], { timeout: 15_000, kind: "git" });
      const name = String(cur || "").trim();
      if (name) {
        const { stdout: sha } = await panelChildren.exec("panel", "git", ["-C", repoDir, "rev-parse", name], { timeout: 15_000, kind: "git" });
        return { ref: name, sha: String(sha || "").trim() || null, how: name };
      }
    } catch {
      /* not a branch: fall through to the sha */
    }
    try {
      const { stdout: sha } = await panelChildren.exec("panel", "git", ["-C", repoDir, "rev-parse", "HEAD"], { timeout: 15_000, kind: "git" });
      const out = String(sha || "").trim();
      return out ? { ref: out, sha: out, how: "a detached HEAD" } : { ref: null, sha: null, how: "no HEAD yet" };
    } catch {
      return { ref: null, sha: null, how: "no HEAD yet" };
    }
  }

  // The pipeline a tree is cut with, written into the tree book at the one moment `since` is honest. A Jobs built by a
  // test without a book still answers with the record; a write the book REFUSED — an unreadable book, a failed write —
  // answers null, because a rung nobody can read back is not a rung. The cut that already happened does not fail over
  // it; the refusal is logged here in the cut's own words, beside the reason `PipelineRecords.set` logged.
  recordCutPipeline(tree, at = new Date().toISOString()) {
    const record = cutPipelineRecord({ at });
    if (this.pipelineRecords && typeof this.pipelineRecords.set === "function") {
      try {
        const stored = this.pipelineRecords.set(tree, record);
        if (!stored) {
          this.onLog(`pipelines: the cut of ${tree} was not recorded as local — the book refused the write, so this tree has no rung (the cut itself stands)`);
          return null;
        }
        return stored;
      } catch (e) {
        this.onLog(`pipelines: could not record ${tree} as local: ${String((e && e.message) || e)} — this tree has no rung (the cut itself stands)`);
        return null;
      }
    }
    return record;
  }

  // The pipeline in force for one card. The TREE's durable record wins (a review loop outlives the 80-job ring, and a
  // second panel reads the same file); `j.pipeline` is the copy written at the cut, which is all a test's Jobs has.
  pipelineForJob(j) {
    if (!j) return null;
    const tree = treeOfJob(j);
    if (tree && this.pipelineRecords && typeof this.pipelineRecords.get === "function") {
      try {
        const rec = this.pipelineRecords.get(tree);
        if (rec) return rec;
      } catch {
        /* an unreadable book falls back to the card's own copy */
      }
    }
    return j.pipeline || null;
  }

  // Hand a changed record to every live card in that tree. The route writes the durable file (lib/pipelines.js
  // `PipelineRecords.set`) FIRST and calls this second, so a card can never disagree with the file about the answer.
  applyPipeline(tree, pipeline) {
    const key = normTree(tree);
    if (!key || !pipeline) return { ok: false, cards: [] };
    const cards = [];
    for (const j of this.jobs.values()) {
      if (treeOfJob(j) !== key) continue;
      j.pipeline = pipeline;
      cards.push(j.id);
    }
    if (cards.length) {
      this.schedulePersist();
      this.emitJobs();
    }
    return { ok: true, cards };
  }

  // ---- the stage timer (docs/pipelines.md §6: the wait that must not be a sleeping worker) ------------------------
  // A stage whose exit is the REVIEWER's answer ends its turn and registers a timed re-check on the TREE, and the
  // panel — not the worker — waits. The record is the pipeline record's own `pipelineWait` field, so it lives in the
  // same durable book as the rung, survives the 80-job ring and a restart, and a second panel reads it. Every clock
  // here is an argument; nothing in this section sleeps or polls.
  pipelineRecordFor(tree) {
    if (!tree) return null;
    if (this.pipelineRecords && typeof this.pipelineRecords.get === "function") {
      try {
        return this.pipelineRecords.get(tree) || null;
      } catch {
        return null; // an unreadable book is no record: the caller's answer is "nothing is waiting"
      }
    }
    return null;
  }

  // Which stage a tree stands on, and whether that stage's exit is the reviewer's. One reader for the settle, the
  // sweep and the card, so three of them cannot disagree about which stage is waiting.
  reviewWaitStage(tree) {
    const record = this.pipelineRecordFor(tree);
    if (!record) return { record: null, definition: null, stage: null, wait: null };
    const definition = this.pipelines && typeof this.pipelines.get === "function" ? this.pipelines.get(record.id) : null;
    const stage = definition && Array.isArray(definition.stages) ? definition.stages.find((s) => s.id === record.stage) || null : null;
    return { record, definition, stage, wait: record.pipelineWait && typeof record.pipelineWait === "object" ? record.pipelineWait : null };
  }

  // Write a tree's whole pipeline record back to the durable book, and to every live card in that tree. Null when the
  // book refused the write — a rung or a wait nobody can read back is not one, and the caller must not report it.
  writePipelineRecord(tree, record, { log = this.onLog } = {}) {
    if (!tree || !record) return null;
    if (!this.pipelineRecords || typeof this.pipelineRecords.set !== "function") return record; // a Jobs built by a test
    let stored = null;
    try {
      stored = this.pipelineRecords.set(tree, record);
    } catch (e) {
      stored = null;
      log(`pipelines: could not write the record for ${tree}: ${String((e && e.message) || e)}`);
    }
    if (!stored) {
      log(`pipelines: the record for ${tree} was not written — the book refused it, so nothing about this stage is in force (the stage itself stands)`);
      return null;
    }
    this.applyPipeline(tree, stored);
    return stored;
  }

  // Set (or clear) the tree's timed re-check. `null` clears it: the exit matched, the PR ended, or the stage moved on.
  recordPipelineWait(tree, wait) {
    const record = this.pipelineRecordFor(tree);
    if (!record) return null;
    const next = { ...record };
    if (wait && typeof wait === "object") next.pipelineWait = wait;
    else delete next.pipelineWait;
    return this.writePipelineRecord(tree, next);
  }

  // ---- the hold: a pipeline row's live stage, in the same book ---------------------------------------------------
  // The second kind of wait (lib/pipelines.js §6). A stage's run is CUT — the row linked to the worker — and the row is
  // held on the tree's own record, keyed to that run. Nothing is started by the hold and nothing is parked by it: it is
  // the durable sentence "this row is on this stage, and that stage's run is job X", which is what lets the panel's
  // timer read the settle and advance the row without a person, and what stops a second owner starting the stage again.
  holdPipelineStageRun({ tree, pipeline = null, stage = null, visit = null, thread = null, job = null, branch = null, at = new Date().toISOString() } = {}) {
    if (!tree) return null;
    const record = this.pipelineRecordFor(tree);
    if (!record) return null;
    const wait = stageRunWaitFor(stage, { pipeline, visit, thread, job, branch, at });
    if (!wait) return null;
    const stored = this.recordPipelineWait(tree, wait);
    if (!stored) return null;
    this.onLog(`pipeline hold: ${tree} is on ${wait.pipeline ? `${wait.pipeline} · ` : ""}${wait.stage} — the run ${wait.job || wait.thread} is held in the book, so the panel advances this stage when it settles`);
    return stored.pipelineWait || null;
  }

  // The run this tree is held on ended. The stamp is the driver's fallback clock: the book keeps first refusal on the
  // advance for HOLD_OWNER_MS from here, and after that the queue's own pass may read the settle rather than waiting
  // for a ticker somebody stopped.
  stampPipelineHold(j, { now = Date.now() } = {}) {
    const tree = treeOfJob(j);
    if (!tree) return null;
    const { wait } = this.reviewWaitStage(tree);
    if (!isRunWait(wait)) return null;
    if (wait.job && String(wait.job) !== String(j?.id || "")) return null;
    if (!wait.job && wait.thread && String(wait.thread) !== String(j?.thread || "")) return null;
    return this.recordPipelineWait(tree, { ...wait, settledAt: new Date(now).toISOString() });
  }

  // Clear the hold only when it is still the one the caller read — a compare-and-set, not a delete. Between the sweep's
  // read and this call the row can have moved and the next stage's cut can have written a NEW hold; clearing that one
  // would be the advance it is trying to prevent. Returns the wait it removed, or null when somebody else's is in force.
  clearPipelineHold(tree, { job = null, stage = null, visit = null } = {}) {
    const { wait } = this.reviewWaitStage(tree);
    if (!isRunWait(wait)) return null;
    if (job != null && String(wait.job || "") !== String(job)) return null;
    if (stage != null && String(wait.stage || "") !== String(stage)) return null;
    if (visit != null && Number(wait.visit) !== Number(visit)) return null;
    const stored = this.recordPipelineWait(tree, null);
    return stored ? { cleared: true, wait } : null;
  }

  // Called at the settle of a turn. If this card's tree stands on a stage whose exit is the reviewer's answer, the
  // panel waits — registered on the TREE, with the thread the wake has to be a turn on. Idempotent within one stage:
  // a second turn in the same stage keeps the clock already running, because restarting the hour on every turn in the
  // loop is exactly how a wait never fires.
  registerPipelineWait(j, { now = Date.now() } = {}) {
    const tree = treeOfJob(j);
    if (!tree) return null;
    const { record, stage, wait } = this.reviewWaitStage(tree);
    if (!record || !stage) return null;
    const check = stage.exit && stage.exit.check;
    if (wait && wait.stage === stage.id && wait.check === check) return wait;
    // The branch rides the wait: the host read a day from now has no card left to ask for it (the job ring keeps 80
    // conversations) and the tree's own HEAD may have moved. The first turn of the thread knows it.
    const branch = j?.branch || this.firstOfThread(j?.thread)?.branch || null;
    const seeded = reviewWaitFor(stage, { at: new Date(now).toISOString(), lastSeen: record.since || null, thread: j?.thread || null, branch });
    if (!seeded) return null;
    this.onLog(`pipeline wait: ${tree} is on ${record.id} · ${stage.id}, whose exit is ${seeded.check} — the turn ends here and the panel re-checks in ${Math.round(seeded.every / 60000)} min (no run is held)`);
    // The WAIT is the answer, not the whole record: a caller asking "what is waiting here" must not have to know that
    // the wait is stored inside the rung. A book that refused the write answers null — nothing is waiting.
    const stored = this.recordPipelineWait(tree, seeded);
    return stored ? stored.pipelineWait || null : null;
  }

  // Every record that is due now, read from the book itself: a wait registered by another panel, or before a restart,
  // is due here too. The tree key is the book's (normalised), which is what `PipelineRecords` files and `set` expects.
  duePipelineWaits({ now = Date.now() } = {}) {
    const out = [];
    if (!this.pipelineRecords || typeof this.pipelineRecords.doc !== "function") return out;
    let doc = null;
    try {
      doc = this.pipelineRecords.doc({ fresh: true });
    } catch {
      return out;
    }
    for (const [tree, record] of Object.entries((doc && doc.trees) || {})) {
      const wait = record && typeof record === "object" ? record.pipelineWait : null;
      if (!wait || typeof wait !== "object") continue;
      if (!waitIsDue(wait, { now })) continue;
      out.push({ tree, record, wait });
    }
    return out;
  }

  // One tick of the stage timer: every due record, one host read each, and either an advance (a wake on the same
  // thread with the next stage's prompt) or the next check. `readReview` and `wake` are the server's two halves — the
  // host read and the turn — and `promptValues` fills the next stage's holes. Nothing here awaits a delay: a tick that
  // finds nothing is a no-op, and a tick that finds an answer spends one read and one short turn.
  async sweepPipelineWaits({ now = Date.now(), readReview = null, wake = null, promptValues = null, advance = null, log = this.onLog } = {}) {
    const result = { checked: 0, skipped: 0, wanted: 0, woke: 0, advanced: 0, rescheduled: 0, held: 0, closed: 0, refused: 0, errors: [] };
    if (typeof readReview !== "function" || typeof wake !== "function") {
      result.errors.push({ tree: null, error: "a sweep needs a host read and a wake — nothing was checked" });
      return result;
    }
    // A pass slower than the tick must not stack up behind itself (the scheduler's own `liveRunning` rule).
    if (this.waitsRunning) {
      result.skipped = 1;
      return result;
    }
    this.waitsRunning = true;
    try {
      for (const item of this.duePipelineWaits({ now })) {
        result.checked += 1;
        try {
          await this.checkPipelineWait(item, { now, readReview, wake, promptValues, advance, result, log });
        } catch (e) {
          const why = String((e && e.message) || e);
          result.errors.push({ tree: item.tree, error: why });
          log(`pipeline wait for ${item.tree}: ${why}`);
        }
      }
    } finally {
      this.waitsRunning = false;
    }
    return result;
  }

  async checkPipelineWait(item, { now, readReview, wake, promptValues, advance = null, result, log }) {
    const { tree, record, wait } = item;
    // A HOLD is the second kind of wait: the stage's own run is the answer, so there is no exit to read and no prompt to
    // render. It is checked against the job store and, once the run is no longer live, handed to the one advance seam.
    if (isRunWait(wait)) {
      await this.checkRunHold(item, { now, advance, result, log });
      return;
    }
    const definition = this.pipelines && typeof this.pipelines.get === "function" ? this.pipelines.get(record.id) : null;
    const stage = definition && Array.isArray(definition.stages) ? definition.stages.find((s) => s.id === record.stage) || null : null;
    if (!stage) {
      // The catalogue or the stage went away under a live wait (a dropped definition, an edited file). Closing it with
      // a sentence is the honest answer: a record re-checked forever against a stage that cannot be found is a loop.
      result.refused += 1;
      this.recordPipelineWait(tree, null);
      log(`pipeline wait for ${tree}: ${definition ? `pipeline "${record.id}" holds no stage "${record.stage}"` : `pipeline "${record.id}" is not in the catalogue`} — the wait is closed, nothing will wake this tree again`);
      return;
    }

    // The claim goes down BEFORE the read, so a second tick, a second panel or a restart between the read and the run
    // meets a claim instead of starting a second wake on the same thread.
    const claim = claimWait(wait, { now });
    if (!claim.ok) {
      result.wanted += 1;
      log(`pipeline wait for ${tree}: ${claim.why}`);
      return;
    }
    if (!this.recordPipelineWait(tree, claim.wait)) {
      result.refused += 1;
      return;
    }

    let observation = null;
    try {
      observation = await readReview({ tree, record, stage, wait: claim.wait });
    } catch (e) {
      observation = { ok: false, why: `the host read threw: ${String((e && e.message) || e)}` };
    }
    const outcome = readReviewExit(stage.exit, observation, { lastSeen: claim.wait.lastSeen });
    const settled = settleWait(claim.wait, { now, outcome });

    if (settled.advance) {
      const order = Array.isArray(definition.order) && definition.order.length ? definition.order : definition.stages.map((s) => s.id);
      const at = order.indexOf(stage.id);
      const next = at >= 0 && at < order.length - 1 ? definition.stages.find((s) => s.id === order[at + 1]) || null : null;
      if (!next) {
        result.closed += 1;
        this.recordPipelineWait(tree, null);
        log(`pipeline wait for ${tree}: ${outcome.why} — and "${stage.id}" is the last stage of "${record.id}", so the wait is closed`);
        return;
      }
      // The next stage's whole instruction, rendered. A hole that resolves to nothing REFUSES to start the stage
      // (§1.4), so the wait is kept rather than advancing into a prompt the worker cannot act on.
      const values = promptValues ? promptValues({ tree, record, stage, next, observation, wait: claim.wait }) : {};
      const rendered = renderPrompt(next.prompt, values || {});
      if (!rendered.ok) {
        result.refused += 1;
        this.recordPipelineWait(tree, settled.wait || claim.wait);
        log(`pipeline wait for ${tree}: ${outcome.why}, but stage "${next.id}" cannot start — ${rendered.why} (the tree stays on "${stage.id}" and is re-checked)`);
        return;
      }
      // The record moves FIRST: the wake's own turn settles in this new stage, and a settle that ran against the old
      // one would re-register the wait it just left. `pipelineWait` is dropped with the hop (the spread would carry it
      // forward otherwise, and that is a wait that wakes the same stage forever); the new stage registers its own when
      // its turn ends.
      const hopped = advanceStage(record, { kind: definition.kind, stage: next.id, at: new Date(now).toISOString(), by: "stage", why: outcome.why });
      const moved = hopped ? { ...hopped } : null;
      if (moved) delete moved.pipelineWait;
      if (!moved || !this.writePipelineRecord(tree, moved)) {
        result.refused += 1;
        return;
      }
      result.advanced += 1;
      const reason = `${record.id} · ${stage.id} exited: ${outcome.why}`;
      const text = `${reason}\n\nThe panel has moved this tree to ${record.id} · ${next.id} (${next.title || next.id}). ${rendered.text}`;
      const sent = await wake({ tree, thread: claim.wait.thread || null, record: moved, stage: next, text, displayPrompt: `${record.id} · ${next.id}: ${outcome.why}`, reason });
      if (sent && sent.ok) {
        result.woke += 1;
        log(`pipeline wait for ${tree}: ${outcome.why} — advanced to "${next.id}" and woke ${sent.job?.id || "the thread"}`);
      } else {
        result.refused += 1;
        log(`pipeline wait for ${tree}: ${outcome.why} — advanced to "${next.id}", but the wake did not start: ${(sent && (sent.error || sent.code)) || "no answer from the reply path"}`);
      }
      return;
    }

    if (!settled.ok) {
      result.refused += 1;
      log(`pipeline wait for ${tree}: ${settled.why}`);
      return;
    }
    if (!settled.wait) {
      result.closed += 1;
      this.recordPipelineWait(tree, null);
      log(`pipeline wait for ${tree}: ${settled.why}`);
      return;
    }
    if (!this.recordPipelineWait(tree, settled.wait)) {
      result.refused += 1;
      return;
    }
    result.rescheduled += 1;
    log(
      `pipeline wait for ${tree}: ${outcome.cannotTell ? "cannot tell" : "nothing yet"} — ${outcome.why || "no answer from the host"}; next check in ${Math.round(settled.wait.every / 60000)} min`,
    );
    if (settled.quiet) {
      // ONE status wake after six quiet hours, so a card that is waiting on a person does not read as dead. It does not
      // advance the stage and it does not reset the backoff: it is a sentence, not a heartbeat.
      const reason = `${record.id} · ${stage.id}: nothing from the reviewer in six hours`;
      const next = new Date(now + settled.wait.every).toISOString().slice(11, 16);
      const text = `${reason}. The panel is still re-checking this pull request; the next check is at ${next} UTC. Nothing has arrived that needs an answer, so say exactly that and end the turn — do not poll, and do not merge.`;
      const sent = await wake({ tree, thread: settled.wait.thread || null, record, stage, text, displayPrompt: reason, reason, quiet: true });
      if (sent && sent.ok) result.woke += 1;
      else log(`pipeline wait for ${tree}: the six-hour status wake did not start: ${(sent && (sent.error || sent.code)) || "no answer from the reply path"}`);
    }
  }

  // One due HOLD: the stage's run is either still working or it is not. A live card keeps the hold and nothing else
  // happens (the summary counts it as `held`); a card that ended, or one the store no longer has after a restart, has its
  // hold CLEARED first and only then handed to `advance` — the compare-and-set is what makes two panels, or two ticks of
  // one, advance a settled stage exactly once. Whatever the answer, the hold is gone: a stage whose run has ended is not
  // something to keep holding, and the driver parks a failure on its own pass.
  async checkRunHold({ tree, record, wait }, { now, advance, result, log }) {
    const card = this.get(String(wait.job || ""));
    const live = card ? isLiveJobStatus(card.status) : false;
    if (live) {
      result.held += 1;
      return;
    }
    if (typeof advance !== "function") {
      result.errors.push({ tree, error: "a run hold needs the advance seam — the stage was not advanced" });
      return;
    }
    const cleared = this.clearPipelineHold(tree, { job: wait.job || null, stage: wait.stage, visit: wait.visit ?? null });
    if (!cleared) {
      // Somebody else cleared it (or a newer stage's cut already wrote its own hold): this pass owns nothing.
      result.skipped += 1;
      return;
    }
    const where = `${wait.pipeline ? `${wait.pipeline} · ` : ""}${wait.stage}`;
    let out = null;
    try {
      out = await advance({ tree, record, stage: wait.stage, wait, now });
    } catch (e) {
      out = { ok: false, error: String((e && e.message) || e) };
    }
    if (!out || out.ok !== true) {
      result.refused += 1;
      log(`pipeline hold for ${tree}: ${where} settled, but the advance refused — ${(out && out.error) || "no answer from the advance"}`);
      return;
    }
    if (out.moved) {
      result.advanced += 1;
      log(
        `pipeline hold for ${tree}: ${where} settled — the panel moved the row ${out.from || "(none)"} → ${out.to || out.state || "(none)"}` +
          `${out.state ? ` (${out.state})` : ""}${out.started ? `, started ${out.started}` : ""}`,
      );
      return;
    }
    result.closed += 1;
    log(`pipeline hold for ${tree}: ${where} settled — the row did not move (${out.why || out.state || "no answer from the driver"})`);
  }


  // `from` is the START REF a cut is made from, and it exists for the fan-out: every lane of a pipeline's concurrent
  // part must start at the SAME commit (lib/pipeline-fanout.js rule 3), where the ordinary cut starts at whatever the
  // parent checkout is on (`startRefOf`). A sha is passed as the ref and the sha — `worktree add` leaves no record of
  // its start point, so both halves are recorded at the only moment they are knowable.
  async makeWorktree(repoDir, prompt, { run = null, thread = null, project = null, from = null } = {}) {
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
    // A fan-out's `from` wins over the parent checkout's branch: it is the block's base, and a lane cut from anything
    // else would not share the commit its siblings were cut from.
    const pinned = String(from ?? "").trim();
    const start = pinned ? { ref: pinned, sha: /^[0-9a-f]{7,64}$/i.test(pinned) ? pinned.toLowerCase() : null, how: "the fan-out base" } : await this.startRefOf(repoDir);
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
    // A ref is passed whenever there is one — a branch, or a sha (a detached HEAD, and every fan-out lane). The old
    // form dropped a sha and let `worktree add` use HEAD, which is the same commit only when HEAD IS the base; a lane
    // cut from the block's base must name it, or it silently starts wherever the checkout happens to be.
    if (start.ref) args.push(start.ref);
    try {
      await panelChildren.exec("panel", "git", args, { timeout: 90_000, kind: "git" });
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
    // Always `local` at cut (§3): a tree is cut before anybody knows whether the work is a probe or a turnover, so a
    // pipeline chosen here would be a promise about work nobody has done yet. The TREE record is the durable one; the
    // job this cut belongs to gets a copy in `create`.
    made.pipeline = this.recordCutPipeline(made.path);
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
    const startName = branchNameOf(start.ref);
    if (startName && startName !== branch) this.rememberParent(made.path, branch, startName);
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
    const explicit = branchNameOf(known);
    if (explicit) return explicit;
    const name = String(branch ?? "").trim() || (await gitOut(tree, ["rev-parse", "--abbrev-ref", "HEAD"]));
    if (!name || name === "HEAD") return null;
    const rec = this.treeParents.get(treeParentKey(tree, name));
    // The record is filed under the tree's TAG, and the panel renames a tree's branch after its first turn
    // (lib/tree-names.js changes the slug and keeps the tag) — so a record that names the OLD branch is still this
    // tree's when both names carry the same tag. Only a record with no tag to compare has to match the name exactly:
    // a different branch checked out in the same directory is not the tree the record was written for.
    const sameTree = rec && (!rec.branch || rec.branch === name || (tagOf(name) && tagOf(rec.branch) === tagOf(name)));
    const recorded = sameTree ? branchNameOf(rec.parent) : null;
    if (recorded) return recorded;
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
      const { stdout } = await panelChildren.exec("panel", "git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 20_000, kind: "git" });
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
    // A steer refusal belonged to the step that was running then: the turn is over, so the verdict goes with it (the
    // predicate's status gate answers for the card from here).
    j.steerRefused = null;
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
    // Every read this measurement makes is the job's own: registered under `job:<id>`, so a cancel or a second
    // settle kills one and the tree goes with it rather than a git read lingering on a card nobody is watching.
    const scope = scopeForJob(j.id);
    const git = (args, cwd = repo) =>
      (this.children || panelChildren)
        .exec(scope, "git", ["-C", cwd, ...args], { timeout: 20_000, kind: "git" })
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
    // ---- the release request, on the way out ----------------------------------------------------------------
    // A worker can never remove its own tree: its cwd is inside it, and on Windows an open handle keeps the directory
    // busy. So it asks instead - one `RELEASE <tree> | <why it is finished>` line in its FINAL message - and the
    // request is recorded against the tree here, beside the TODO lines. NOTHING is acted on from this run: the
    // executor (lib/worktrees.js) is swept after the turn has settled, and it refuses unless every gate passes on
    // evidence the panel measured itself.
    this.harvestRelease(j);
    // The DELIVERABLES list, on the same seam: one `DELIVER <kind> <target> | <title>` line in the FINAL message is
    // resolved, validated against the filesystem NOW, and recorded — with the tree THIS pass located, not the path
    // the job was created with (a finished tree is auto-named, and the job's copy is already stale).
    this.harvestDeliverables(j, tree);
    this.finalise(j);
    this.emit(j);
    return tree;
  }

  // One run's release request, read ONCE and only recorded. Split out of `measureTree` for two reasons: the seam is
  // testable without a panel (`finalMessage` in, a request on the tree out), and a second `measureTree` — the re-read
  // after a rename, the reconcile a restart runs — must not record the same marker twice.
  //
  // It deliberately cannot reach the executor: `releases.record` writes a request down and returns. The sweep in
  // server.js acts on it after this turn has settled, which is the whole point of the grammar — a worker asks, and
  // the panel (a process whose cwd is outside every tree) decides.
  harvestRelease(j) {
    if (!this.releases || !j || j.releaseHarvested) return null;
    j.releaseHarvested = true;
    const asked = this.releases.record({ job: j, finalText: String(j.finalMessage || "") });
    for (const line of asked.lines) this.push(j, line);
    j.releaseAsked = asked.requests.map((r) => ({ path: r.path, requestedAt: r.requestedAt, runId: r.runId }));
    return asked;
  }

  // One run's handed-back deliverables, read ONCE and only recorded. Beside `harvestRelease` and on the same rule:
  // a second `measureTree` over the same message must not record the same marker twice.
  //
  // The mark is set AFTER the store accepted the lines and ONLY when the message carried a marker:
  //   * a failed write leaves it unset, so the next pass retries (the rows it accepted are in the store's memory);
  //   * a message with NO marker leaves it unset too, because a live job restored at boot is measured once with no
  //     final message, and again when the gateway confirms it completed — marking the empty pass would swallow that
  //     job's real delivery.
  //
  // `record()` is written not to throw; the try/catch is the belt to that brace, because `measureTree` has no
  // try/catch of its own and an exception here is an unhandled rejection in the settle path.
  harvestDeliverables(j, tree = null) {
    if (!this.deliverables || !j || j.deliverHarvested) return null;
    // Who the row names: the label the reader gave the thread, then Hermes' own title, then the thread itself. Read
    // defensively, because a Jobs built as a test harness (a bare prototype with only a store and `push`) has no
    // label map — and a name that cannot be read must not refuse a delivery.
    let agent = j.thread || null;
    try {
      agent = this.labelFor?.(j.thread) || this.sessionInfoFor?.(j.thread)?.title || j.thread || null;
    } catch {
      /* an unreadable name leaves the thread's own */
    }
    let out;
    try {
      out = this.deliverables.record({
        job: j,
        tree, // {path, branch} as locate() measured it, in THIS pass
        finalText: String(j.finalMessage || ""),
        agent,
      });
    } catch (e) {
      this.push(j, { kind: "raw", text: `⚠ DELIVER was NOT read — ${String((e && e.message) || e)}` });
      return null;
    }
    for (const line of out.lines) this.push(j, line);
    if (out.saved === false) {
      this.push(j, { kind: "raw", text: `⚠ DELIVER was NOT recorded — ${out.error || "the list could not be written"}` });
      return out; // the mark stays unset: the next pass retries
    }
    if (out.parsed > 0) j.deliverHarvested = true;
    // Diagnostics only, and NOT in the persist map: the store is the record.
    j.delivered = { added: out.added, updated: out.updated, refused: out.refused };
    return out;
  }

  // ---- run lifecycle -------------------------------------------------------------------
  async create(opts = {}) {
    const prompt = String(opts.prompt ?? "").trim();
    if (!prompt) throw new Error("prompt is required");
    // One conversation per thread: turns share the thread name, so the gateway continues the same
    // session and the UI can group them into a single card.
    const thread = opts.thread || makeThreadName(prompt);
    // ONE WORKER PER TREE, enforced where the run would start. A SPAWN IN that names a tree a live run already
    // holds is refused here — before a record is written and before anything is cut — naming the thread that
    // holds it. The digest already computes this fact for the assistant (every live run is listed with its
    // thread and its tree); until now nothing enforced it at the cut, so a second worker could be started in a
    // tree the first one was mid-edit in. The tree then moved under the first worker: three runs were wasted in
    // one night, each one reporting work that a second agent had already made stale. `existing` and `reply` are
    // the two shapes that run in a tree that already stands; a fresh worktree has no tree yet to collide with,
    // and the assistant's own board-reading turn (`anchorCwd: false`) is not an agent in a tree at all.
    if (opts.anchorCwd !== false && (opts.existing || opts.reply)) {
      const tree = opts.ownerPath || opts.resumeDir || opts.cwd || "";
      const holder = liveJobsInTree([...this.jobs.values()], tree)[0] || null;
      if (holder) {
        const where = String(tree).replace(/\\/g, "/").replace(/\/+$/, "");
        const err = new HttpError(
          409,
          `the worktree ${where} already has a live run (${holder.id} on thread ${holder.thread}, ${holder.status}) — a second worker in that tree would edit the same files. Wait for it to end, steer it, or name a different tree.`,
        );
        err.code = "tree_busy";
        err.holder = { id: holder.id, thread: holder.thread, status: holder.status };
        throw err;
      }
    }
    const siblings = [...this.jobs.values()].filter((x) => x.thread === thread);
    // ---- a repair turn must not continue a session the gateway has lost --------------------------------
    // The fence that kills a turn is per SESSION and outlives the gateway process that raised it, so a repair that
    // re-posts `session_id: <thread>` is accepted and then never claimed: the card reads `queued` with
    // `execution_generation: null` for ever and the reader waits for an answer that cannot start. The thread is the
    // panel's card id; the SESSION is the gateway's, and this is the one place the two are allowed to differ.
    //
    // When the session this turn would continue is lost, the turn opens a NEW one — same tree, same prompt (the
    // caller's prompt is untouched) — and says so on the card. A turn that merely timed out, crashed, or was killed
    // by the panel cap is NOT this: its session is healthy, and its retry stays a warm continuation.
    const continuing = Boolean(opts.reply) || siblings.length > 0;
    const priorSession = this.sessionFor(siblings) || thread;
    const lost = continuing ? await this.lostSessionOf(siblings, priorSession) : null;
    const sessionId = lost ? makeThreadName(prompt) : priorSession;

    const reasoningEffort = reasoningEffortForTurn(opts, siblings);
    const modelOptions = reasoningModelOptions(reasoningEffort);
    if (modelOptions) {
      const transport = await this.probe();
      if (!transport.reachable || !transport.capabilities?.modelOptions) {
        throw new HttpError(503, "the Hermes gateway does not advertise model_options; per-agent reasoning cannot be applied");
      }
    }
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
      // The board assistant's own turn. Marked here rather than inferred from the thread name at every reader:
      // the settle wake must never answer a wake with another wake (lib/assistant.js `isOwnRun`), and this is the
      // flag that says so — durable, because it survives the store and the restart.
      assistant: Boolean(opts.assistant),
      // WHICH assistant owns this run, when one started it (lib/assistant.js `startSpawn`). Absent for a run the reader
      // or a row's own button started -- absence is Assistant #1, the same way it owns every tree nobody moved.
      assistantId: opts.assistantId ? String(opts.assistantId) : null,
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
      reasoningEffort,
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
      // The gateway session this turn posts to. Usually the thread itself; a repair on a thread whose session the
      // gateway lost opens a new one, and every turn after it continues THAT id (see `sessionFor`).
      sessionId,
      // Present only on the turn that had to replace a lost session: {from, to, why, runId}. The card draws its
      // `new session` chip from this, and it survives a restart with the rest of the card.
      sessionReplaced: lost ? { from: priorSession, to: sessionId, why: lost.why, runId: lost.runId || null } : null,
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
        // The NAME of the ref the tree was cut from — a string. `made.parent` is the parent book's whole RECORD, an
        // object whose own `parent` is null for a tree cut from main (main is not a branch to roll up into), so it is
        // neither a name nor the answer; `made.startRef` is what `git worktree add` was told, main included, and main is
        // the very parent lib/branch-policy.js needs in order to say "push it and open a pull request".
        cutParent = branchNameOf(made.startRef);
        j.worktreePath = made.path;
        j.ownerPath = made.path;
        j.ownerPending = false;
        // The card draws the pipeline from the tree's record (lib/pipelines.js `PipelineRecords`), and carries this
        // copy so a job that outlives the record file still says what its tree was cut as.
        j.pipeline = made.pipeline || null;
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

    // Repeat the directory in EVERY run's input: session history survives between turns, but a previous
    // run's tool cwd need not. Sending `cwd` is not proof that the gateway applied it to tools. Keep this
    // safeguard independent of advertised capabilities, without claiming a particular gateway bug is present.
    const where = typeof cwd === "string" && path.isAbsolute(cwd) ? cwd.split("\\").join("/").replace(/\/+$/, "") : null;
    // ---- the worktree's TODO list, on the way in -----------------------------------------------------------
    // Every run that works in a tree is handed that tree's list — WITH ITS IDS, because an agent cannot mark an item
    // done without knowing which number it is — plus the standing instruction to keep it current: add what it
    // discovers, mark what its own work closes, and RECONCILE THE LIST AGAINST ITS OWN COMMITS before it finishes.
    //
    // `opts.todoSeed` is the assistant's acceptance items for this card (a `TODO <text>` line under its SPAWN):
    // they are written to the list FIRST, so the ids the worker is handed are the ids of its own items.
    //
    // It rides AFTER the "Work in …" sentence, which is what keeps it out of the branch's description
    // (lib/descriptions.js strips that wrapper and everything under it) while still being part of the text the run
    // receives. `j.prompt` — what the card shows and what the description is derived from — stays the reader's own
    // brief.
    let todoHere = null;
    if (this.todos && where && opts.anchorCwd !== false) {
      const seed = Array.isArray(opts.todoSeed) ? opts.todoSeed.map((t) => String(t ?? "").trim()).filter(Boolean) : [];
      if (seed.length) {
        const made = this.todos.seed({ project: opts.project || null, path: cwd, texts: seed, by: "assistant", from: "spawn" });
        if (made.length) this.push(j, { kind: "dim", text: `⇢ seeded this tree's TODO list with ${made.length} item(s) from the brief (ids ${made[0].id}..${made[made.length - 1].id})` });
      }
      todoHere = this.todos.forRow(opts.project || null, cwd, { journal: 0 });
    }
    const todoText = where && opts.anchorCwd !== false ? todoBlockText(todoHere, where, opts.project || "") : "";
    // …and, when this project allows it, the paragraph that says a worker may ASK for its tree to go (lib/worktrees.js
    // decides; server.js owns this callback so lib/jobs.js never imports the executor). Same channel as the TODO
    // block — the prompt — because a marker nobody told the model about is a grammar nobody can use.
    const releaseText = where && opts.anchorCwd !== false ? this.releaseBrief?.(opts) || "" : "";
    // …and the paragraph that teaches the DELIVER marker, which rides every tree run whether or not that tree has a
    // list: it is what the reader judges a finished row by. `deliverBrief` is the hook a project would use to switch
    // a different wording on; absent, the panel's own paragraph stands. It is defined HERE, beside `releaseText`,
    // before the template that spreads it — a `deliverText` used above its own `const` is a ReferenceError at the
    // moment a tree run starts, not a missing paragraph.
    const deliverText = where && opts.anchorCwd !== false ? this.deliverBrief?.(opts) ?? DELIVER_BRIEF : "";
    // `anchorCwd: false` is for a turn that is not meant to work in a directory at all (the panel's own
    // assistant reads the board, it never runs a command there), so the sentence would be a lie in its prompt —
    // and so would a tree-kind line, since there is no tree. THAT is what keeps this paragraph off the assistant's
    // own runs, and it is structural rather than a flag somebody has to remember: the assistant is the only caller
    // that asks for a turn with no directory, and a turn with no directory has no tree to land.
    //
    // A run started to LAND keeps the landing line it already had (`WILL LAND: … push it and open a pull request`):
    // a merge agent's instruction is the merge script's, and a second paragraph about its parent would contradict it.
    // Every other worker gets the paragraph for the parent of ITS tree, which lib/branch-policy.js renders from the
    // branch the tree was cut from — read at the cut (above), from the panel's cut record, or from git's own
    // upstream. When none of those can name it, `branchLandingLine` returns "" and the blanket LOCAL-ONLY line
    // stands: the fallback is the rule we already had, never a guessed `main`.
    const landing = opts.remoteWrite === "land" || opts.landing === true;
    // No tree (the assistant), a run that is already landing, or one the caller muted: no parent is asked for at all,
    // so those turns pay no git call for a sentence they will not carry.
    const wantsParent = Boolean(where) && opts.anchorCwd !== false && opts.remoteWrite !== "none" && !landing;
    const parentBranch = wantsParent
      ? await this.parentBranchFor({ tree: cwd, branch: j.branch || null, known: opts.parentBranch || cutParent })
      : null;
    const parentLine = parentBranch
      ? branchLandingLine({ parent: parentBranch, branch: j.branch || null, policy: opts.branchPolicy || cutPolicy, remote: opts.remote, cwd: where, allowPushWithoutAsking: opts.allowPushWithoutAsking === true }, where)
      : "";
    const kindLine =
      opts.anchorCwd === false || opts.remoteWrite === "none"
        ? ""
        : landing
          ? remoteWriteLine(opts, where)
          : parentLine || remoteWriteLine({ ...opts, branchPolicy: opts.branchPolicy || cutPolicy }, where);
    // Where this run's throwaway files belong, and the habit it replaces. Tagged with the job's own id so two runs
    // never sort their comparisons into the same folder, and stated in the prompt because it is the one channel a
    // run definitely reads; supplying a run body's `cwd` alone is not proof of the tools' actual directory.
    const scratchText = where && opts.anchorCwd !== false ? scratchLine(this.scratchDir, j.id) : "";
    // The attachment block a caller has already VERIFIED and wants the run to read — the browser's own
    // convention, built by lib/attachments.js. It rides here rather than in `prompt` for two reasons:
    // `prompt` is what the card shows, what the description is derived from and what the worktree's
    // branch is named after, and a path list is none of those; and it is appended AFTER the brief, the
    // way the page appends it to a message. Empty by default, so a turn that carried nothing produces
    // the same request it produced before this option existed, byte for byte.
    const attachText = typeof opts.attachmentBlock === "string" ? opts.attachmentBlock : "";
    const anchored = where && opts.anchorCwd !== false
      ? `${kindLine}${kindLine ? "\n\n" : ""}${prompt}${attachText}\n\nWork in ${where} — run \`cd "${where}"\` before your first terminal command, and use absolute paths under it for file tools; the agent host may have started you in a different directory.${scratchText ? `\n${scratchText}` : ""}${todoText ? `\n\n${todoText}` : ""}${releaseText ? `\n\n${releaseText}` : ""}${deliverText ? `\n\n${deliverText}` : ""}`
      : prompt + attachText;
    // Context the panel supplies on the turn's behalf rides in the input, ahead of the prompt: the card must
    // show what the reader (or the sentry) said, not a copy of the scratchpad.
    const pre = opts.preamble ? `${String(opts.preamble).trim()}\n\n---\n\n` : "";
    // A run on a gateway build that cannot deliver a clarify question is told so in its own input —
    // the one channel a run definitely reads. The hint appears only after a refusal has actually been
    // observed (lib/clarify.js), so a build that works is never lectured and an unknown build keeps
    // the old behaviour. This covers the board assistant's own turn and every worker the panel starts:
    // both post through this one body.
    //
    // The route is proved FIRST, and that is what makes the sentence conditional rather than a race:
    // without it a build that works hears nothing (nobody has asked yet) and a build that does not
    // only learns from a failed call. One request per gateway build, memoised in `proveClarifyRoute`.
    await this.proveClarifyRoute();
    const clarifyHint = this.clarify?.instruction?.() || "";
    // `session_id` is the SESSION, never the thread: a repair whose thread's session was lost posts to the new one,
    // and a normal turn posts to the same id it always did.
    const body = { input: pre + anchored + (clarifyHint ? `\n\n${clarifyHint}` : ""), session_id: sessionId, cwd };
    if (opts.model) body.model = String(opts.model);
    if (modelOptions) body.model_options = modelOptions;
    if (opts.maxTurns) body.max_turns = Number(opts.maxTurns);
    if (opts.budget) body.run_budget = Number(opts.budget);
    // The request as the gateway received it, kept ON the card (memory only, never persisted) for the one thing
    // that needs it again: a session the gateway fenced after this POST got admitted and never claimed. The sweep
    // re-posts exactly this body under a new session id, so the turn that never started is not written off. A card
    // restored from the store has no body, and falls back to the write-off.
    j.requestBody = body;

    // A line the spawner wants on the card, ahead of the request: a SPAWN IN name that had to be resolved to a
    // real tree is what this exists for, and the card is where the reader judges where that run went.
    if (opts.note) this.push(j, { kind: "dim", text: String(opts.note) });
    // …and the same channel for whatever else the spawner had to decide about this run before it started. An
    // attachment the SPAWN could not inherit belongs there too: the child's input says it to the worker, and the
    // card says it to the reader, so a path that was refused is never a silence.
    for (const line of Array.isArray(opts.notes) ? opts.notes : []) {
      if (String(line || "").trim()) this.push(j, { kind: "dim", text: String(line) });
    }
    // The reader is told BEFORE the request goes out: a turn that answers in a different session from the one the
    // card started is a fact about this card, not something to discover from the transcript later.
    if (j.sessionReplaced) {
      this.push(j, {
        kind: "dim",
        text:
          `⇢ session replaced — the gateway lost ${priorSession} (${lost.why}), so this turn starts a NEW session ` +
          `${sessionId} in the same tree instead of continuing it${lost.runId ? `; run ${lost.runId} is left where it is` : ""}`,
      });
    }
    this.push(j, { kind: "cmd", text: `POST ${this.api.url}/v1/runs · session ${sessionId} · cwd ${cwd}` });
    // This is setup information, not a restart notice. Keep it on the first turn only; the actual
    // safeguard remains in every run's input, including replies and revived sessions.
    if (anchored !== prompt && !opts.reply && siblings.length === 0) {
      this.push(j, {
        kind: "dim",
        text: `⇢ workspace ${where} — included in the prompt as a tool-directory safeguard`,
      });
    }
    if (pre) this.push(j, { kind: "dim", text: "⇢ assistant context attached — scratchpad, watches and the board digest ride with this turn" });
    this.onLog(`run ${j.id}: session ${thread} cwd ${cwd}`);

    // ---- the POST, with the gateway's own backpressure absorbed ------------------------------
    // A 429 from this route is the gateway's concurrent-run cap, not a verdict on the run: it means "no
    // slot right now" (see RETRY_429_DEFAULTS). Marking the turn failed on it threw away a run the gateway
    // would have accepted a second later, so the SAME request is sent again, the turn is held as `waiting`
    // while it waits, and only an exhausted budget is reported as a failure — with the wait and the tries it
    // cost. Nothing else is retried, nothing is re-sent after the reader cancels, and this is never a second
    // turn: one job, one thread, one turn, one worktree and one POST in flight at a time.
    const retry = retry429Settings(this.config);
    const held = { attempts: 0, since: Date.now() };
    const readDetail = async (response) => {
      try {
        const err = await response.json();
        return err?.error?.message || err?.message || JSON.stringify(err).slice(0, 300);
      } catch {
        return await response.text().catch(() => "");
      }
    };
    // The reader's cancel wins over the retry, always: a turn they stopped is never sent again, and it stops
    // being held the moment they say so. (No `error` is set — a cancelled turn is a decision, not a fault,
    // and an error here would put the card's retry button on it and read as a failure.)
    const giveUpHeld = () => {
      j.waiting = null;
      j.status = "cancelled";
      this.terminate(j, "reader");
      j.endedAt = new Date().toISOString();
      this.push(j, { kind: "raw", text: `cancelled while waiting for a run slot — the gateway was at its concurrent-run cap (HTTP 429)${held.attempts > 1 ? ` and this turn was held through ${held.attempts} tries` : ""}; it was not sent again` });
      this.finalise(j);
      this.emit(j);
      return this.summary(j);
    };

    let res = null;
    let refused = null;
    for (;;) {
      held.attempts += 1;
      refused = null;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20_000);
        res = await fetch(`${this.api.url}/v1/runs`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: ctrl.signal });
        clearTimeout(t);
      } catch (e) {
        const why = e?.name === "AbortError" ? "the gateway did not answer within 20s" : String((e && e.message) || e);
        res = null;
        refused = { transport: `cannot reach the Hermes gateway at ${this.api.url}: ${why}` };
        break;
      }
      if (res.status !== 429) break;
      // The 429's own words, read now: the response body is consumed here either way, and the failure that
      // reports an exhausted hold has to carry what the gateway actually said.
      const detail = await readDetail(res);
      refused = { detail, afterMs: retryAfterMs(res.headers) };
      if (held.attempts >= retry.attempts) break;
      if (j.cancelRequested) return giveUpHeld();
      const delay = retry429DelayMs(held.attempts, retry, refused.afterMs);
      j.status = "waiting";
      j.waiting = {
        attempt: held.attempts,
        attempts: retry.attempts,
        waitMs: delay,
        since: new Date(held.since).toISOString(),
        until: new Date(Date.now() + delay).toISOString(),
        retryAfterMs: refused.afterMs,
        reason: refused.detail ? String(refused.detail).slice(0, 200) : "",
      };
      this.push(j, {
        kind: "dim",
        text: `⇢ the gateway is at its concurrent-run cap (HTTP 429${refused.detail ? `: ${String(refused.detail).slice(0, 160)}` : ""}) — holding this turn, try ${held.attempts + 1} of ${retry.attempts} in ${fmtWait(delay)}`,
      });
      this.onLog(`run ${j.id}: gateway at capacity (429) — holding ${fmtWait(delay)} before try ${held.attempts + 1}/${retry.attempts}`);
      this.emit(j);
      await new Promise((r) => setTimeout(r, delay));
      if (j.cancelRequested) return giveUpHeld();
    }
    // Past the hold: either an accepted run, or a refusal to report.
    j.waiting = null;

    if (!res) {
      j.status = "failed";
      j.error = refused.transport;
      j.endedAt = new Date().toISOString();
      this.push(j, { kind: "raw", text: j.error });
      this.finalise(j);
      this.emit(j);
      return this.summary(j);
    }

    if (!res.ok) {
      // A 429 that survived the whole hold is STILL backpressure — the gateway was busy the entire time, not
      // broken — so the failure says how long it waited and how many tries it cost. Everything else keeps the
      // sentence it had, verbatim: one POST, one verdict, no retry.
      const detail = res.status === 429
        ? String(refused?.detail || "")
        : await readDetail(res);
      j.status = "failed";
      j.error = res.status === 429
        ? `the gateway was still at its concurrent-run cap (HTTP 429) after ${held.attempts} ${held.attempts === 1 ? "try" : "tries"} over ${fmtWait(Date.now() - held.since)} of holding${detail ? `: ${String(detail).slice(0, 300)}` : ""}`
        // 409 + permission_denied is the gateway's surface rule, not a fault: session_api_turn.py refuses an API
        // turn in any session whose source is not api_server/bot_room, and a revived session came from the CLI.
        // Say what to do about it instead of repeating the code.
        : (runRefusal(res.status, detail, { thread, revived: Boolean(j.revived) }) ||
          `gateway refused the run (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ""}`);
      j.endedAt = new Date().toISOString();
      this.push(j, { kind: "raw", text: j.error });
      this.finalise(j);
      this.emit(j);
      return this.summary(j);
    }

    const accepted = await res.json().catch(() => ({}));
    if (!(await this.armAcceptedRun(j, accepted, { sessionId, cwd, continuing }))) return this.summary(j);
    return this.summary(j);
  }

  // A run the gateway ACCEPTED: stamp the id, start the clocks and subscribe. Shared by `create()` and by the
  // session replacement the sweep makes (`replaceLostSession`), so a turn that had to move to a new session is
  // watched exactly as a fresh one is — same wall-clock cap, same poller, same stream, same stats strip.
  async armAcceptedRun(j, accepted, { sessionId, cwd, continuing = true } = {}) {
    j.runId = accepted.run_id || null;
    // Which gateway PROCESS took this run. A run lives in one process's memory, so this stamp is the only way a
    // later boot can tell "the gateway still has this" from "this belongs to a gateway that is gone" without
    // guessing from clocks (see `stopStaleRuns`).
    if (j.runId) {
      const identity = gatewayIdentity();
      j.gatewayPid = identity?.pid ?? null;
      j.gatewayStart = identity?.startTime ?? null;
    }
    if (!j.runId) {
      j.status = "failed";
      j.error = "gateway accepted the request but returned no run_id";
      j.endedAt = new Date().toISOString();
      this.finalise(j);
      this.emit(j);
      return false;
    }
    j.status = "running";
    const sessionWord = !continuing ? "session" : j.sessionReplaced ? "NEW session (the last one was lost)" : "continuing session";
    this.push(j, { kind: "init", text: `run ${j.runId} · ${sessionWord} ${sessionId} · turn ${j.turn} · cwd ${cwd}` });
    // The strip reads the session's counters, which are cumulative — so remember where they stood when
    // this turn began. Everything after that point belongs to the turn being watched.
    j.baseOutput = this.sessionOutput(sessionId);
    j.statsTimer = setInterval(() => this.refreshStats(j), 4_000);
    this.refreshStats(j);
    this.emit(j);

    // Hard wall-clock cap, same contract as before: a runaway agent does not outlive its budget by
    // much. Stopping is cooperative, so the run settles through its own terminal event.
    j.timer = setTimeout(() => {
      if (j.status === "running") {
        j.error = `killed: exceeded ${this.maxRuntimeSeconds}s panel cap`;
        // The panel ending the run is a fact only the panel has: the gateway will report it cancelled, and a
        // cancellation without a reason reads as "someone stopped it", not as "it ran away".
        this.terminate(j, "cap", { seconds: this.maxRuntimeSeconds });
        void this.stop(j.id);
      }
    }, this.maxRuntimeSeconds * 1000);

    // Backstop for a silently dead stream: the status endpoint is the truth.
    j.poller = setInterval(() => void this.poll(j), 15_000);

    // Subscribe - unless this gateway says it has no event stream to subscribe to. `run_events_sse` is
    // the capability the stream needs; without it the poll above is the only path, and the card says
    // which one it is on instead of reading a quiet stream as a stalled model.
    if (this.transport.capabilities === null) await this.probe();
    if (this.transport.capabilities?.events === false) {
      j.streamMode = "poll";
      this.push(j, { kind: "dim", text: "this gateway does not advertise run_events_sse - this card is polled every 15s instead of streamed" });
      this.emit(j);
      return true;
    }
    void this.follow(j);
    return true;
  }

  // Subscribe to the run's event stream, and STAY subscribed. A dropped connection is not a lost run, and
  // it is not the end of the transcript either: the gateway keeps each run's events in a ring and replays
  // from any seq, so a reconnect asks for the one after the last this panel printed (`Last-Event-ID`).
  // Without that, one dropped socket reprinted 186 deltas and every tool call under the answer. The loop
  // closes when the run settles - `settle` aborts `j.ctrl` - and `poll` stays the backstop: the status
  // endpoint is the truth about whether there is anything left to hear.
  async follow(j) {
    // One subscriber per run. `sweepOrphanedRuns` and `reattachRestored` both put a lost card back on
    // its stream; without this guard the second call would run a second loop over the same run and every
    // event would be printed twice.
    if (j.following) return;
    j.following = true;
    const ctrl = new AbortController();
    j.ctrl = ctrl;
    // Whether this panel currently holds the run's event stream. A gateway restart drops it, and the
    // sweep in `sweepOrphanedRuns` reads this before deciding a run is alive or lost.
    j.streamOpen = true;
    let backoff = STREAM_RETRY_MS;
    try {
      while (isLiveJobStatus(j.status) && !ctrl.signal.aborted) {
        const heard = await this.streamOnce(j, ctrl);
        if (!isLiveJobStatus(j.status) || ctrl.signal.aborted) break;
        // The stream ended on its own: the run may have finished without this panel hearing the
        // terminal event, or the socket dropped. Ask the status endpoint, then subscribe again.
        await this.poll(j);
        if (!isLiveJobStatus(j.status)) break;
        if (heard > 0) backoff = STREAM_RETRY_MS;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, STREAM_RETRY_MAX_MS);
      }
    } finally {
      j.following = false;
      j.streamOpen = false;
    }
  }

  // One connection to a run's events. Returns how many frames it read, which is how `follow` tells a
  // stream that delivered and then ended from one that never came up at all.
  async streamOnce(j, runCtrl) {
    const ctrl = new AbortController();
    const halt = () => ctrl.abort();
    runCtrl.signal.addEventListener("abort", halt, { once: true });
    let heard = 0;
    try {
      const headers = { Accept: "text/event-stream", ...(this.api.key ? { Authorization: `Bearer ${this.api.key}` } : {}) };
      // Resume, do not replay: the seq of the last event this panel consumed, `-1`-safe.
      if (Number.isInteger(j.lastSeq) && j.lastSeq >= 0) headers["Last-Event-ID"] = String(j.lastSeq);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/events`, { headers, signal: ctrl.signal });
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
          const evt = frameEvent(frame);
          if (!evt) continue;
          heard += 1;
          // consume() advances `j.lastSeq`, so a drop mid-frame resumes at the event it printed.
          this.consume(j, evt);
        }
      }
    } catch (e) {
      if (!runCtrl.signal.aborted) this.onLog(`run ${j.id}: event stream ended (${String((e && e.message) || e)})`);
    } finally {
      runCtrl.signal.removeEventListener("abort", halt);
    }
    return heard;
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
      // The mirror of `clarify.request`'s `j.questionDone = null` below: a NEW request is a new park, and the
      // previous approval's record must not hide its box (approvalPrompt), make `approvalPending()` answer "nothing
      // is parked" about a run the gateway is holding, or leave the row's awaiting-approval badges dark.
      j.approvalDone = null;
      // A steer refusal belonged to the step that was running then: the run is parked again, so answering this is
      // what moves it.
      j.steerRefused = null;
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
      const promptId = [evt.prompt_id, evt.request_id, evt.id].find((v) => typeof v === "string" && v) || null;
      j.question = {
        // The question's IDENTITY, not its arrival. One key per prompt: a re-ask (see `reaskQuestion`)
        // updates this record in place, and every list that shows a wait — the room's message, the
        // alert, the HUMAN rotation — keys off this instead of inventing a second entry for the same
        // question. `requestId` is the gateway's own prompt id; only a prompt that names none falls
        // back to its arrival, and even then the field is written once and never rewritten.
        key: `clarify:${j.id}:${promptId || new Date(at).toISOString()}`,
        requestId: promptId,
        question: clarifyText(evt.question),
        choices: (Array.isArray(evt.choices) ? evt.choices : []).map(String).filter((c) => c.trim()),
        multiSelect: Boolean(evt.multi_select),
        // null when there is no known window: the card then draws no bar at all.
        timeoutSeconds: windowSeconds || null,
        deadline: windowSeconds ? at + windowSeconds * 1000 : null,
        at: new Date(at).toISOString(),
        // How many times the panel has asked the reader again about THIS prompt, and when the last
        // one went out. Zero is the first ask, which is the question itself.
        reasks: 0,
        lastAskedAt: null,
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
    // The turn is over: anything it left running dies here, before the panel writes the card. A git helper that
    // outlived its run is exactly what leaves a `land --check` (or a watcher) burning CPU after the card says
    // done. One scope, one line, and the run's own `finalise` below is not delayed by it.
    try {
      const ended = this.children?.killScope?.(scopeForJob(j.id), "the run settled") || 0;
      if (ended) this.onLog(`run ${j.id} settled: ${ended} helper process(es) killed with the turn`);
    } catch (e) {
      this.onLog(`run ${j.id} settled: child cleanup failed (${String((e && e.message) || e)})`);
    }
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
    // The stage timer (§6): a stage whose exit is the reviewer's answer does not hold THIS run open — the timed
    // re-check is registered on the tree here and the turn ends. Best-effort inside the settle: a book that refused
    // the write is a tree with no timer and a log line, never a finished run turned into a failed one.
    try {
      const review = this.registerPipelineWait(j);
      // No reviewer's answer is what this stage exits on, so the hold this run was cut under is now a SETTLED hold: the
      // stamp starts the window in which the panel's timer owns the advance (lib/pipelines.js `HOLD_OWNER_MS`), and after
      // it the queue's own pass may read the settle rather than wait for a ticker.
      if (!review) this.stampPipelineHold(j, { now: Date.now() });
    } catch (e) {
      this.onLog(`pipeline wait for ${treeOfJob(j) || j.thread}: ${String((e && e.message) || e)}`);
    }

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
    if (!j.runId || !isLiveJobStatus(j.status)) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return;
      const run = await res.json();
      // The session-authority gateway fences its control calls on this number: an approval posted without
      // it is rejected as invalid_params, not as a bad choice. Keep it for every control call.
      if (Number.isFinite(Number(run.execution_generation)) && Number(run.execution_generation) > 0) {
        j.executionGeneration = Number(run.execution_generation);
      }
      if (TERMINAL_RUN.has(run.status)) {
        this.scanTurnUrls(j);
        this.push(j, runResultLine(run.status, run));
        this.settle(j, run.status, run);
      }
    } catch {
      /* the next tick tries again */
    }
  }

  // A run lives in the gateway, not in this process, so a restart tells this panel nothing about the turn it lost:
  // `load()` no longer writes that turn off at all. Every card a restart left waiting for an answer, and every
  // `interrupted` card an older build wrote off, is asked once what the gateway now says about its run. The
  // decision itself lives in settleRestoredRun() below, so the manual re-attach chip takes the same one.
  async reconcileRestored() {
    const lost = [...this.jobs.values()].filter(
      (j) => j.runId && !j.reconciled && !j.runGone && (j.awaitingGateway || j.status === "interrupted"),
    );
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
  //
  // ONE probe per card, even when the boot listen callback and `resumePending()` both walk the list: the card holds
  // the promise while the ask is in flight, and the second pass awaits that same answer instead of printing a second
  // "re-attached" line (measured on the arch review: B.two_reconcile_passes).
  async settleRestoredRun(j, { pointers = null } = {}) {
    if (!j) return { action: null, probe: null };
    if (j.reconciling) return j.reconciling;
    const ask = this.decideRestoredRun(j, { pointers });
    j.reconciling = ask;
    try {
      return await ask;
    } finally {
      if (j.reconciling === ask) j.reconciling = null;
    }
  }

  async decideRestoredRun(j, { pointers = null } = {}) {
    const p = await this.runProbe(j);
    // It kept the run and the run has ended: the run's own result decides the card.
    if (p.reachable && p.known === true && TERMINAL_RUN.has(String(p.run?.status))) {
      this.adoptRun(j, p.run);
      return { action: "adopted", probe: p };
    }
    // It still HAS the run: this card is not a write-off. The panel lost the stream, not the run, so re-attach
    // and let the run settle through the same path every other live turn does — the outcome is adopted when it
    // actually finishes, and until then the card is steerable again.
    if (p.reachable && p.known === true) return { action: this.reattachRestored(j, p.run) ? "reattached" : null, probe: p };
    // It answers, and has no record of this run any more: the promise a write-off used to make ("the gateway
    // still has run X, so it will finish on its own") is dead the moment the run leaves the gateway, and a card
    // that keeps it never resolves. Say what is known instead. markRunGone is idempotent, and its `false` (the
    // wording is already on the card) is NOT a decision — a second pass must not claim to have changed anything.
    if (p.reachable && p.known === false) return { action: this.markRunGone(j, { pointers }) ? "gone" : null, probe: p };
    // The gateway was asked and gave no verdict: unreachable, a 5xx, a status nobody here recognises. The card
    // must not keep claiming to be live on a question nobody answered — so the restart's verdict is written NOW,
    // after the ask, never before it. It is a live card this pass is writing off, so the decision counts.
    const wrote = this.markInterruptedByRestart(j, {
      by: "panel",
      detail: "the gateway could not be asked about this run, so this panel has no line to it",
    });
    return { action: wrote ? "interrupted" : null, probe: p };
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
    j.awaitingGateway = false;
    j.reconciled = true;
    j.endedAt = null;
    j.error = "";
    j.completion = null;
    j.outcome = null;
    // It is back: whatever a 404 said about this run before, the gateway has it now, so there is nothing left to
    // ask about and no gone wording for the card to carry into its next life.
    j.runGone = false;
    // And no refusal from the run's previous step: the gateway is holding it now, so the Steer control is offered
    // again once the card draws.
    j.steerRefused = null;
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
    if (!j || !j.runId) return false;
    // A card the restart left awaiting an answer is written off here too: the gateway HAS answered, and the answer
    // was that it no longer has the run. That is the one case where `interrupted` is the gateway's own word, not
    // the panel's guess.
    const pending = j.awaitingGateway || j.status === "running" || j.status === "starting";
    if (j.status !== "interrupted" && !pending) return false;
    // The one fact a 404 settles, recorded before the wording guard below: there is no run here to re-attach to any
    // more, so the card stops offering the chip even when its wording is already the settled one.
    j.runGone = true;
    const text = `the panel restarted while this was running — the gateway no longer has run ${j.runId}, so its outcome was never seen here`;
    if (j.error === text) return false; // already said, and there is nothing to add: no second line, no second write
    j.status = "interrupted";
    j.awaitingGateway = false;
    j.reconciled = true;
    j.endedAt = j.endedAt || lastSeenIso(j);
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
  adoptRun(j, run, { why = null } = {}) {
    j.status = TERMINAL_STATUS[run.status] || "failed";
    j.awaitingGateway = false;
    j.reconciled = true;
    // A failed run's own error is the card's error; an adopted run that ended cleanly clears whatever the panel
    // said while it could not watch (a restart's promise, a steer refusal).
    j.error = run.error ? String(run.error) : "";
    if (run.usage) j.tokens = { total: run.usage.total_tokens ?? null, input: run.usage.input_tokens ?? null, output: run.usage.output_tokens ?? null };
    const finalStats = statsFromUsage(run.usage);
    if (finalStats) {
      j.gatewayStats = { ...(j.gatewayStats || {}), ...finalStats };
      j.stats = { ...(j.stats || {}), ...finalStats };
    }
    j.endedAt = j.endedAt || lastSeenIso(j);
    const at = new Date(j.endedAt).toLocaleTimeString();
    this.push(j, {
      kind: "result",
      text: `run ${run.status} in the gateway · ${why || `this panel lost the stream at a restart and last saw it at ${at}`}`,
    });
    // A question or an approval cannot outlive its turn: the run has ended, so nobody is parked on either any
    // more, and a settled card that still drew the box offered an answer to a turn that can never read it. The
    // question keeps the record that this panel never answered it, exactly as `settle()` does.
    if (j.question) j.questionDone = j.questionDone || { answer: "", at: new Date().toISOString(), closed: true };
    j.question = null;
    j.approval = null;
    const out = String(run.output || "").trim();
    if (out) {
      j.finalMessage = out;
      this.push(j, { kind: "text", text: out });
    }
    this.fillStats(j);
    // The run's own answer decides the exit status here, exactly as it does on the stream: the panel lost the
    // stream, not the fact of what happened.
    this.finalise(j, { runStatus: run.status, run });
    this.onLog(`reconciled run ${j.id} -> ${j.status} (${j.runId})${why ? ` — ${why}` : ""}`);
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
    if (!j?.runId) return { known: null, reachable: false, error: "this turn has no run id" };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 404) return { known: false, reachable: true, status: 404 };
      if (!res.ok) return { known: null, reachable: true, status: res.status };
      return { known: true, reachable: true, run: await res.json() };
    } catch (e) {
      return { known: null, reachable: false, error: String((e && e.message) || e) };
    }
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

  // One `queued` answer with no execution generation, and the verdict it adds up to. `queued` is the gateway's word
  // for admitted-but-not-claimed; a run admitted a moment ago is legitimately queued, and one queued behind a live
  // head of its own session is too, so a single answer is not a verdict. Two consecutive answers a sweep apart, or
  // one on a card already past its wall-clock cap, is the gateway never starting it — the fence's own shape.
  // The counters live in their own field (`unclaimedAnswers`) so a `queued` answer can never be mistaken for an
  // `unknown` one, or clear that record.
  noteUnclaimedRun(j, probe, now = Date.now()) {
    const answers = Array.isArray(j.unclaimedAnswers) ? j.unclaimedAnswers.slice() : [];
    answers.push({ at: now, runStatus: String(probe?.run?.status || "queued"), executionGeneration: probe?.run?.execution_generation ?? null });
    while (answers.length > UNKNOWN_ANSWER_CAP) answers.shift();
    j.unclaimedAnswers = answers;
    const last = answers[answers.length - 1];
    const prev = answers[answers.length - 2] || null;
    const confirmed = Boolean(prev) && last.at - prev.at >= UNKNOWN_CONFIRM_MS;
    const started = Date.parse(j.startedAt || "");
    const ageSeconds = Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : 0;
    const pastCap = ageSeconds > this.maxRuntimeSeconds;
    const why = confirmed
      ? `two consecutive answers ${Math.round((last.at - prev.at) / 1000)}s apart`
      : `one answer on a card ${Math.round(ageSeconds)}s old, past the ${this.maxRuntimeSeconds}s wall-clock cap`;
    return { gone: pastCap || confirmed, confirmed, pastCap, ageSeconds, why };
  }

  // The panel's answer to the gateway's `unknown_execution`: replace the session, do not end the turn.
  //
  // An admission the gateway lost pauses that session's FIFO, so a run posted to it is ACCEPTED and never
  // claimed — `queued` with `execution_generation: null`, for ever. Nothing ran, so posting the SAME request
  // again under a new session duplicates no work, and it is the repair the reader would make by hand. Doing it
  // here is what stops the next turn from walking back into the same fence: measured on this board, six turns
  // across panel-assistant, panel-assistant-3 and panel-assistant-4 failed that way between 19:18 and 19:40 on
  // 2026-11-06, each one admitted and written off, each one followed by a turn that continued the dead session.
  //
  // The card keeps its thread, its prompt and its tree; it gains `sessionReplaced` (the chip the page already
  // draws), a new session id, and a new run id from the re-post. Two cases fall back to the write-off, which
  // keeps the gateway's word on the card: a card with no `requestBody` (one the store restored after a restart),
  // and a card that has already replaced its session once — a second `unknown_execution` on a session this panel
  // opened is the gateway naming a real fault, not a fence to step around.
  async replaceLostSession(j, { why = "", runId = null } = {}) {
    if (!j || !isLiveJobStatus(j.status)) return false;
    if (j.sessionReplaced) return false;
    const body = j.requestBody;
    if (!body || !body.input) return false;
    const from = String(j.sessionId || j.thread || "");
    const to = makeThreadName(String(j.prompt || body.input || "resume"));
    const refused = async (said) => {
      this.push(j, { kind: "dim", text: `⇢ could not replace session ${from} (${said}) — this turn is written off as before` });
      this.onLog(`run ${j.id}: session ${from} could not be replaced (${said}) — writing the turn off`);
      return false;
    };
    let res = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20_000);
      res = await fetch(`${this.api.url}/v1/runs`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ...body, session_id: to }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
    } catch (e) {
      return refused(e?.name === "AbortError" ? "the gateway did not answer within 20s" : String((e && e.message) || e));
    }
    if (!res.ok) return refused(`HTTP ${res.status}`);
    const accepted = await res.json().catch(() => ({}));
    if (!accepted.run_id) return refused("the gateway returned no run id");
    // Only now is the card's own record moved: a replacement that could not be posted leaves the card exactly as
    // the sweep found it, so the write-off below still has its evidence.
    j.sessionReplaced = {
      from,
      to,
      why: String(why || `run ${runId || "(unknown)"} ended ${LOST_SESSION_CODE}`),
      runId: runId ? String(runId) : null,
      at: new Date().toISOString(),
    };
    j.sessionId = to;
    j.unknownAnswers = null;
    j.unclaimedAnswers = null;
    // The backstops the OLD run took with it: this card is about to be watched again, and a stale poller, stats
    // clock or wall-clock cap would double every read and then kill the new run on the old one's budget.
    clearTimeout(j.timer);
    clearInterval(j.poller);
    clearInterval(j.statsTimer);
    j.statsTimer = null;
    // The old run's stream is de-subscribed the way a settle does it. `reattached` is set so the sweep cannot
    // start a SECOND subscription beside the one `armAcceptedRun` opens for the new run.
    try {
      j.ctrl?.abort();
    } catch {
      /* already closed */
    }
    j.following = false;
    j.lastSeq = null;
    j.streamOpen = false;
    j.reattached = true;
    this.push(j, {
      kind: "dim",
      text:
        `⇢ session replaced — the gateway answered ${LOST_SESSION_CODE} for session ${from} (${j.sessionReplaced.why}), ` +
        `and a fenced session never claims another run; this turn continues on a NEW session ${to} instead of being written off` +
        (runId ? `; run ${runId} is left where it is` : ""),
    });
    this.onLog(`run ${j.id}: session ${from} replaced with ${to} — the gateway answered ${LOST_SESSION_CODE} for run ${runId || "(none)"}`);
    const armed = await this.armAcceptedRun(j, accepted, { sessionId: to, cwd: j.cwd, continuing: true });
    this.schedulePersist();
    return armed;
  }

  // The write-off for a run the gateway admitted and never claimed, for a card that cannot re-post its request (a
  // restored card) — `replaceLostSession()` handles every other one. The card takes the gateway's own word for it —
  // `unknown_execution` — because that is what the next repair turn keys on to open a new session, and because it
  // is what the two runs measured on this board ended on. The run is deliberately NOT stopped: it sits `queued` in
  // the gateway and holds nothing, and a stop on it is answered 409 and reads as a success it is not
  // (docs/research/assistant-session-fence.md).
  writeOffUnclaimedRun(j, { answers = [], why = "" } = {}) {
    if (!j || !isLiveJobStatus(j.status)) return false;
    const seen = answers.map((a) => `${a.runStatus} at ${new Date(a.at).toISOString()}`).join(" · ");
    this.terminate(j, "gateway", { detail: "the gateway admitted this run and never claimed it" });
    j.status = "failed";
    j.error = LOST_SESSION_CODE;
    j.endedAt = new Date().toISOString();
    j.approval = null;
    if (j.question) j.questionDone = j.questionDone || { answer: "", at: new Date().toISOString(), closed: true };
    j.question = null;
    // Nothing to hear from a run that was never started, and the re-attach chip would promise an answer that cannot
    // come: this card is settled, not stranded.
    j.unclaimedAnswers = null;
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
    this.push(j, {
      kind: "result",
      text: `the gateway admitted run ${j.runId} but never claimed it (queued with no execution generation) — this session is fenced, so the turn cannot start; a retry opens a new session`,
    });
    this.onLog(`run ${j.id}: run ${j.runId} queued with no execution generation — written off on ${why} (answers: ${seen})`);
    this.finalise(j);
    this.emit(j);
    this.schedulePersist();
    return true;
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
    // The ask is over (its answer was no answer at all), so the card is no longer waiting for one. It is NOT
    // marked reconciled: a later pass may still get an answer out of the gateway, and re-attaching is the better
    // ending for a run that turns out to be alive.
    j.awaitingGateway = false;
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

  // A proven-gone run, settled by whichever request learned it. `markRunGone` only accepts an already-interrupted
  // card, and a steer's 404 starts from `running`, so a live card goes through `markInterruptedByRestart` — the same
  // path the orphan sweep takes. ONE helper for both callers, so the sweep and the steer route cannot settle the
  // same fact two different ways.
  settleGoneRun(j, { detail = "" } = {}) {
    if (!j) return false;
    if (j.status === "interrupted") return this.markRunGone(j);
    if (j.status === "running" || j.status === "starting") {
      return this.markInterruptedByRestart(j, { by: "gateway", detail, gone: true });
    }
    return false;
  }

  // Runs that stopped reporting while this panel is still up. Called from the server's watchdog. Returns
  // the runs it gave a terminal status to, which the caller wakes the assistant about — once.
  async sweepOrphanedRuns(now = Date.now()) {
    const watching = this.runningJobs().filter((j) => j.runId);
    if (!watching.length) return [];
    // Only judge a run once the gateway itself answers: while it is down there is nothing to ask, and a
    // restart in flight must not be read as a lost run.
    const t = await this.probe({ fresh: true });
    if (!t.reachable) return [];
    const lost = [];
    // Cards settled on a `queued`-with-no-generation answer. Kept apart from `lost` because `lost` is what the caller
    // wakes the assistant about as a gateway restart, and nothing here was interrupted by a restart: the run was
    // never started at all.
    const wedged = [];
    for (const j of watching) {
      // A card a restart left waiting for an answer is settled through the boot reconcile's own decision, so a
      // gateway that was unreachable then cannot leave it claiming to be live forever: the next tick asks again.
      if (j.awaitingGateway) {
        const { action } = await this.settleRestoredRun(j);
        if (action === "interrupted" || action === "gone") lost.push(j);
        continue;
      }
      const p = await this.runProbe(j);
      if (p.known === false) {
        if (this.settleGoneRun(j, { detail: "the gateway restarted and no longer has this run" })) lost.push(j);
        continue;
      }
      if (p.known === true && p.run) {
        const said = String(p.run.status || "");
        if (TERMINAL_RUN.has(said)) {
          // The run's own result decides the card, and any unknown answer this probe collected was a run still
          // starting (a card that answered unknown once and then completed is a turn that finished normally).
          j.unknownAnswers = null;
          // A card still held `running` on a run the gateway has already ended is a zombie: it reads LIVE on the
          // board and refuses every send to its thread (`busyFor`). This sweep is the reconciliation pass — the
          // run's own status settles it here, on this tick, with the reason journalled beside the run id so it
          // cannot be read as a restart's write-off.
          const why = `the gateway had already ended it (${said}) while this panel still held the card open`;
          this.onLog(`run ${j.id}: the gateway had already ended run ${j.runId} (${said}) — settling the card on the run's own status`);
          this.adoptRun(j, p.run, { why });
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
        // `queued` with no execution generation is the fence's own shape: the gateway admitted the run and will never
        // claim it, because a session whose head admission it lost refuses to advance its FIFO. Nothing ran, so the
        // TURN IS NOT LOST: the card replaces the session and re-posts the same request once (see
        // `replaceLostSession`), which is the repair a reader would make by hand. Only a card that cannot re-post —
        // a restored card with no request, or one that already replaced its session — is written off, the way an
        // `unknown` run is, keeping the gateway's word (`unknown_execution`) for the next repair turn to key on.
        if (said === "queued" && p.run.execution_generation == null) {
          const verdict = this.noteUnclaimedRun(j, p, now);
          if (!verdict.gone) continue;
          const resumed = await this.replaceLostSession(j, {
            why: `run ${j.runId} was queued with no execution generation (${verdict.why})`,
            runId: j.runId,
          });
          if (resumed) continue;
          if (this.writeOffUnclaimedRun(j, { answers: verdict.answers, why: verdict.why })) wedged.push(j);
          continue;
        }
        // Anything else the gateway calls this run is live — forget the unknown answers, or one answer taken
        // while the run was starting would sit on the card and count towards a later silence.
        if (j.unknownAnswers) j.unknownAnswers = null;
        // Same for a card that was only queued for a moment: the run has moved on, so the fence is not there.
        if (j.unclaimedAnswers) j.unclaimedAnswers = null;
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
    // A wedged card owes the gateway NO stop — its run was never claimed, so there is nothing executing to release —
    // but it does owe the same tree measurement every other settled card gets, so the notice can say where the work
    // stands. Not returned: the caller's wake is worded for a restart, and this was not one.
    if (wedged.length) {
      await Promise.all(wedged.map((j) => this.measureTree(j).catch(() => {})));
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
  // rather than the one the worker was handed when it started. Empty string when this run has no tree of its own:
  // no path at all, a STATE directory (lib/paths.js STATE_DIR_NAMES), or a directory that holds no `.git` — see the
  // guard below, which is the same refusal `create()` makes with `anchorCwd: false`.
  todoTailFor(j) {
    if (!this.todos || !j) return "";
    const treePath = j.worktreePath || j.ownerPath || j.cwd;
    if (!treePath) return "";
    const where = String(treePath).split("\\").join("/").replace(/\/+$/, "");
    // A list belongs to a WORKTREE, and not every run's directory is one. The assistant's own turn runs in
    // `state/assistant-cwd` (lib/paths.js STATE_DIR_NAMES) — empty, no `.git`, and no branch for `git log <base>..HEAD`
    // to answer — and a released/evicted tree leaves a directory that exists with no `.git` in it. Either way the
    // block would tell the run to reconcile its list against a branch its tree does not have. The create path already
    // refuses this with `where && opts.anchorCwd !== false`; this is the same refusal for the two paths that carry the
    // block to a run already in flight (a steer, and a revived thread's card).
    //
    // The NAME is checked first because it is the fact the panel owns: a stray `.git` inside a state folder must not
    // turn it into a tree a run may be told to reconcile against.
    const leaf = (where.split("/").filter(Boolean).pop() || "").toLowerCase();
    if (STATE_DIR_NAMES.includes(leaf)) return "";
    if (!treeOnDisk(where).there) return "";
    const list = this.todos.forRow(null, treePath, { journal: 0 });
    const block = todoBlockText(list, where, "");
    return block ? `\n\n---\n\n${block}` : "";
  }

  // What the card may offer: an approval it can actually answer. A turn with no run id has no route to post to,
  // a record the host allowed no choice on has nothing to send, a window that has closed is over whatever the
  // reconcile's clock says, and a record the gateway proved it no longer holds is a phantom. Each is drawn as
  // the closed note instead of live buttons, so the reader is never invited to press what cannot be answered.
  approvalAnswerable(j) {
    const a = j?.approval;
    if (!a || !j.runId) return false;
    if (!Array.isArray(a.choices) || !a.choices.length) return false;
    if (a.answerable === false) return false;
    const deadline = Number(a.deadline);
    if (Number.isFinite(deadline) && Date.now() >= deadline) return false;
    return true;
  }

  // Is this card parked on an approval that is still open? The window is the gateway's own, so an approval whose
  // deadline has passed (the sweep has not repainted the card yet) does not block a steer the gateway would take.
  // `approvalDone` is deliberately NOT a gate: `approval.responded` and `settle` clear `j.approval`, so a park still
  // on the card is still a park — even on a turn whose earlier approval was answered.
  approvalPending(j) {
    return approvalOpen(j?.approval);
  }

  // EVERY wait on a person this board is holding, newest first: a clarify card and an approval, each with the
  // lettered options a one-character reply can name. The room the Matrix bridge talks in reads this instead of
  // walking the event shapes itself, which is what keeps "A" meaning the same option on both surfaces.
  waitingOnPerson() {
    const out = [];
    for (const j of this.list()) {
      for (const w of waitsOf(j)) out.push(w);
    }
    return out;
  }

  // The ONE answer the card draws its Steer control from and the route refuses with — the shared predicate in
  // public/core/steerable.js, so a parked run, a run past its last tool boundary and a run the gateway no longer has
  // never offer a control the gateway would refuse (docs/steer-refusal.md §1.7b).
  steerable(j) {
    const verdict = steerableOf(j);
    return { ...verdict, text: verdict.ok ? null : refusalText(verdict.why) };
  }

  async steer(id, text) {
    const j = this.jobs.get(String(id || ""));
    const clean = String(text ?? "").trim();
    if (!j) return { ok: false, error: "unknown job" };
    if (!clean) return { ok: false, error: "steer text is required" };
    if (j.status !== "running" || !j.runId) return { ok: false, error: `run is not running (${j.status})` };
    // The card's own predicate, asked before any round trip: a run parked on an approval, a run past its last tool
    // boundary or one the gateway has already proved gone answers with the same reason the page draws its control
    // from, so the button and the route cannot disagree. The text is NOT held here — a parked run is still live and
    // the same text steers fine once the approval is answered.
    const verdict = this.steerable(j);
    if (!verdict.ok) {
      return {
        ok: false,
        reason: verdict.why,
        code: STEER_CODE[verdict.why] || "steer_refused",
        error: verdict.text,
        ...(verdict.why === GONE ? { runId: j.runId, runGone: true, card: this.summary(j) } : {}),
      };
    }
    // The list rides WITH the steer: a worker told to change course is handed its tree's TODO list as it stands now,
    // and the same standing instruction (keep it current, reconcile against your own commits before you finish).
    const carried = `${clean}${this.todoTailFor(j)}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/steer`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ input: carried }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Which of the three refusals this is. The STATUS alone cannot tell them apart — `run_not_accepting_steer`
        // is a 409 for BOTH a parked run and a run with no steerable agent, and `steer_not_accepted` is a 409 for a
        // turn that crossed its last tool boundary (docs/steer-refusal.md §2.1) — so the run's own status word,
        // read once, decides. A gateway that cannot be asked leaves the refusal unclassified rather than guessed.
        const probe = await this.runProbe(j);
        const said = String(probe?.run?.status || "");
        const why = classifyRefusal({
          status: res.status,
          code: body?.error?.code || body?.code || null,
          runStatus: said,
          known: probe?.known,
          terminal: TERMINAL_RUN.has(said),
        });
        if (why === GONE) {
          // The row was steering a run the gateway does not have: settle it in the same answer, through the one
          // helper the orphan sweep uses, so the card stops offering a control nothing can answer.
          this.settleGoneRun(j, { detail: "the gateway no longer has this run" });
          return {
            ok: false,
            reason: GONE,
            code: "run_gone",
            error: refusalText(GONE),
            gatewayStatus: res.status,
            runStatus: said || null,
            runId: j.runId,
            card: this.summary(j),
          };
        }
        // The gateway said the text crossed the turn's last tool boundary: no later press can land either, so the
        // card stops drawing the control until the turn settles.
        if (why === PAST_BOUNDARY) j.steerRefused = PAST_BOUNDARY;
        // The STATUS rides back too, because a gateway may refuse without naming a code and the caller still has to
        // tell a refusal from a malformed request (`server.js` uses it for the 409/404/400 split).
        return {
          ok: false,
          reason: why || "refused",
          error: body?.error?.message || body?.message || `HTTP ${res.status}`,
          code: body?.error?.code || body?.code || null,
          gatewayStatus: res.status,
          runStatus: said || null,
          ...(why ? { card: this.summary(j) } : {}),
        };
      }
      this.push(j, { kind: "dim", text: `⇢ steer sent: ${clean.slice(0, 200)}` });
      return { ok: true, accepted: Boolean(body.accepted), runId: j.runId };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // What a control call has to carry to be read at all. The session-authority gateway answers `invalid_params`
  // for a body that is not exactly {request_id, execution_generation, choice}, and this gateway's approval.request
  // event names neither the prompt nor the generation - so both come from the run's pending_controls, matched to
  // the card by its command when the run has more than one control parked.
  async controlContext(j, kind = "approval") {
    const out = { promptId: null, generation: Number(j?.executionGeneration) || 0, status: "", pending: false, read: false, gone: false };
    if (!j?.runId) return out;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(timer);
      // 404 is the gateway's own verdict that the run is gone, which is a different answer from a read that
      // failed: the card has nothing left to post to, and the reconcile drops it rather than keeping a box over
      // a run that no longer exists.
      if (res.status === 404) {
        out.gone = true;
        return out;
      }
      if (!res.ok) return out;
      const run = await res.json();
      // The run's own status, read on the same call the prompt id comes from: a control call to a run that has
      // already ENDED can still be accepted (`200 {status:"resolved"}` on a build that resolves the prompt with
      // no live turn behind it), so the caller needs this answer before it writes delivery down.
      out.status = String(run.status || "");
      out.read = true;
      const gen = Number(run.execution_generation);
      if (Number.isFinite(gen) && gen > 0) {
        out.generation = gen;
        j.executionGeneration = gen;
      }
      const pending = Array.isArray(run.pending_controls) ? run.pending_controls : [];
      // A parked run can hold both kinds at once (a clarify from an older tool call, an approval for the
      // next command), so the control a call is about has to be picked by its own kind — an approval body
      // sent with a clarify's prompt id is `invalid_params`, not a helpful error.
      const mine = pending.filter((c) => (c.kind || "approval") === kind);
      const want = kind === "clarify" ? String(j.question?.question || "") : String(j.approval?.command || "");
      // The request id is the gateway's own identity for THIS prompt, so it outranks the text match when both
      // sides carry one: a different approval parked on the same run must not keep this card looking answerable.
      const wantId = kind === "clarify" ? String(j.question?.requestId || "") : String(j.approval?.requestId || "");
      const pick =
        (wantId && mine.find((c) => String(c.prompt_id || "") === wantId)) ||
        mine.find((c) => want && String((kind === "clarify" ? c.question : c.command) || "") === want) ||
        (wantId ? null : mine[0]);
      if (pick) {
        out.pending = true;
        if (typeof pick.prompt_id === "string" && pick.prompt_id) out.promptId = pick.prompt_id;
        const pg = Number(pick.execution_generation);
        if (Number.isFinite(pg) && pg > 0) {
          out.generation = pg;
          j.executionGeneration = pg;
        }
      }
    } catch {
      /* the control call will report what is wrong with it */
    }
    return out;
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
    // ONE answer per request, server side. The box can be open on two surfaces (the board card and the pinned
    // copy) and the same press can arrive twice: the first POST is answered 200 and the second 409, and that
    // second verdict used to overwrite the decision the first one recorded. The entry is written before the
    // first await and removed in `finally`, so a refusal that leaves the box up can still be answered again.
    const heldKey = String(j.id || id || "");
    const heldRequest = requestId || j.approval?.requestId || null;
    if (this.approvalAnswerInFlight(heldKey, heldRequest)) {
      return { ok: false, code: "answer_in_flight", error: "an answer for this approval is already on its way to the gateway" };
    }
    const flight = { requestId: heldRequest, choice: pick, at: Date.now() };
    this.approvalAnswers.set(heldKey, flight);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      let ctx = await this.controlContext(j);
      let rid = requestId || j.approval?.requestId || ctx.promptId;
      let gen = ctx.generation;
      if (rid && !j.approval?.requestId) j.approval.requestId = rid;
      const body = { choice: pick };
      if (rid) body.request_id = String(rid);
      if (gen) body.execution_generation = gen;
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/approval`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = out?.error?.code || out?.code || null;
        // The gateway does not hold this request any more: its window closed, another surface answered it, or a
        // stop withdrew it. That is a verdict, not a retryable failure — the box goes and the reader is told, or
        // they are left clicking a prompt that can never be answered (measured: four clicks at 12:08:46, 12:08:49,
        // 12:08:56 and 12:09:36, every one answered "Run has no pending approval").
        if (code === "approval_not_pending" || code === "approval_not_active") return this.approvalGone(j, code);
        // `invalid_params` (a body the authority will not read without a generation) or `stale_generation` (the
        // run moved on since the value we had): ask the run for its current generation and retry once. A card
        // left open across a generation change heals itself instead of showing a code.
        if (code === "invalid_params" || code === "stale_generation") {
          j.executionGeneration = 0;
          ctx = await this.controlContext(j);
          const later = ctx.generation;
          const laterRid = ctx.promptId || rid;
          const moved = (later && later !== gen) || (laterRid && laterRid !== rid);
          if (moved) {
            if (later) body.execution_generation = later;
            if (laterRid) {
              body.request_id = String(laterRid);
              if (j.approval) j.approval.requestId = laterRid;
            }
            const retry = await fetch(`${this.api.url}/v1/runs/${j.runId}/approval`, {
              method: "POST",
              headers: this.headers(),
              body: JSON.stringify(body),
            });
            const out2 = await retry.json().catch(() => ({}));
            if (retry.ok) {
              this.push(j, { kind: "dim", text: `⇢ approval answered from the panel: ${pick}` });
              j.approvalDone = { choice: pick, command: j.approval?.command || "", at: new Date().toISOString() };
              j.approval = null;
              this.emit(j);
              return { ok: true, choice: pick, resolved: out2.resolved ?? null };
            }
            // The row is gone as well as the generation: same verdict, same handling.
            const late = out2?.error?.code || out2?.code || null;
            if (late === "approval_not_pending" || late === "approval_not_active") return this.approvalGone(j, late);
            return { ok: false, error: out2?.error?.message || out2?.message || `HTTP ${retry.status}`, code: late };
          }
        }
        return { ok: false, error: out?.error?.message || out?.message || `HTTP ${res.status}`, code };
      }
      this.push(j, { kind: "dim", text: `⇢ approval answered from the panel: ${pick}` });
      // Optimistic: the stream's approval.responded confirms it a moment later.
      j.approvalDone = { choice: pick, command: j.approval?.command || "", at: new Date().toISOString() };
      j.approval = null;
      this.emit(j);
      return { ok: true, choice: pick, resolved: out.resolved ?? null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      // Only the flight this call owns is removed: a second press that arrived while this one was open was
      // refused above, so a `delete` here can never clear somebody else's answer.
      if (this.approvalAnswers.get(heldKey) === flight) this.approvalAnswers.delete(heldKey);
    }
  }

  // Is an answer to this job's approval on its way to the gateway right now? Read by the single-flight fence
  // above and by the page's own ledger, so two copies of one box cannot spend two POSTs for one permission.
  approvalAnswerInFlight(id, requestId = null) {
    const held = this.approvalAnswers.get(String(id || ""));
    if (!held) return false;
    if (requestId && held.requestId && String(requestId) !== String(held.requestId)) return false;
    return true;
  }

  // Is an answer to this job's question on its way to the gateway right now? Read by the sentry so an
  // hourly re-ask cannot land between the reader's press and the gateway's acknowledgement. A `requestId`
  // narrows the answer to the prompt it was asked about; a different prompt is not held by this one.
  questionAnswerInFlight(id, requestId = null) {
    const held = this.questionAnswers.get(String(id || ""));
    if (!held) return false;
    if (requestId && held.requestId && String(requestId) !== String(held.requestId)) return false;
    return true;
  }

  // ---- asking a reader again ----------------------------------------------------------------------
  // A parked question is the one state on this board nothing else will move: the run emits no events,
  // no turn ends, and the card looks exactly as it did an hour ago. The sentry re-asks on its own clock
  // (lib/assistant.js) and lands here — which bumps the count on the record the question ALREADY has.
  //
  // No POST goes to the gateway, deliberately: the run is still parked on that same prompt, and posting
  // a question again is a second question, not a reminder. What changes is the panel's own entry — the
  // card says it has been asked again, and the count rides on the record the alert, the room message and
  // the HUMAN rotation all read, so one question can never become two rows.
  //
  // Refuses (null) when the job has moved on: the question was answered, withdrawn with the turn, or a
  // different prompt is parked now. A re-ask is about ONE prompt id.
  reaskQuestion(id, requestId = null) {
    const j = this.jobs.get(String(id || ""));
    if (!j || !j.question) return null;
    if (this.questionAnswerInFlight(j.id, requestId || j.question.requestId)) return null;
    if (requestId && j.question.requestId && String(requestId) !== String(j.question.requestId)) return null;
    const now = Date.now();
    const reasks = (Number(j.question.reasks) || 0) + 1;
    const since = Date.parse(j.question.at || j.startedAt || "") || now;
    j.question = {
      ...j.question,
      reasks,
      lastAskedAt: new Date(now).toISOString(),
      // The key never moves. It is the one field that makes this a single entry everywhere.
      key: j.question.key || `clarify:${j.id}:${j.question.requestId || j.question.at || ""}`,
    };
    const waited = Math.max(0, now - since);
    this.push(j, {
      kind: "dim",
      text: `⇢ asked again — still unanswered after ${fmtWait(waited)}, the run is parked on this question${reasks > 1 ? ` (asked again ${reasks}× now)` : ""}`,
    });
    this.emit(j);
    return this.summary(j);
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
    // Single flight: the question is still on the record while the gateway is being asked, so a second press
    // (the other copy of the box, or a click that follows the pointerup) must be refused rather than spend a
    // second POST the gateway would answer 409. Written before the first await; removed in `finally` so a
    // refusal (which leaves the question open) can be answered again.
    const heldId = String(j.id || id || "");
    if (this.questionAnswerInFlight(heldId, requestId || j.question?.requestId || null)) {
      return { ok: false, code: "answer_in_flight", error: "an answer for this question is already on its way to the gateway" };
    }
    this.questionAnswers.set(heldId, { requestId: requestId || j.question?.requestId || null, at: Date.now() });
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      let ctx = await this.controlContext(j, "clarify");
      let rid = requestId || j.question?.requestId || ctx.promptId;
      let gen = ctx.generation;
      // The run's own status decides whether an answer can land AT ALL. A cancelled/failed/completed run has no
      // waiter left to resume it, and a gateway build can still resolve the prompt on that run and answer 200 —
      // so the POST's success is not delivery. Read before writing anything down, and after every re-read.
      const ended = endedRunWord(ctx);
      if (ended) {
        clearTimeout(t);
        return this.noteUndelivered(j, ended, { answer: shown });
      }
      if (rid && j.question && !j.question.requestId) j.question.requestId = rid;
      const body = { answer: text };
      if (rid) body.request_id = String(rid);
      if (gen) body.execution_generation = gen;
      const post = () =>
        fetch(`${this.api.url}/v1/runs/${j.runId}/clarify`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      const res = await post();
      clearTimeout(t);
      let out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = out?.error?.code || out?.code || null;
        if (code === "invalid_params" || code === "stale_generation") {
          j.executionGeneration = 0;
          ctx = await this.controlContext(j, "clarify");
          const movedEnded = endedRunWord(ctx);
          if (movedEnded) return this.noteUndelivered(j, movedEnded, { answer: shown });
          const later = ctx.generation;
          const laterRid = ctx.promptId || rid;
          const moved = (later && later !== gen) || (laterRid && laterRid !== rid);
          if (moved) {
            if (later) body.execution_generation = later;
            if (laterRid) {
              body.request_id = String(laterRid);
              if (j.question) j.question.requestId = laterRid;
            }
            const retry = await post();
            out = await retry.json().catch(() => ({}));
            if (!retry.ok) {
              return { ok: false, error: out?.error?.message || out?.message || `HTTP ${retry.status}`, code: out?.error?.code || out?.code || null };
            }
            return this.noteAnswered(j, shown, { status: String(out?.status || "") });
          }
        }
        return { ok: false, error: out?.error?.message || out?.message || `HTTP ${res.status}`, code };
      }
      return this.noteAnswered(j, shown, { status: String(out?.status || "") });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      this.questionAnswers.delete(heldId);
    }
  }

  // The box collapses the moment the POST is accepted; the stream's `clarify.settled` only confirms it, and
  // it must not overwrite the answer that was actually sent.
  //
  // "Accepted by the route" is not "delivered to the turn": a run that has already ENDED still accepts the
  // answer on a gateway whose clarify route resolves the prompt without a live waiter, and writing `answered`
  // there told the reader a decision had been taken by a turn that could never read it. `ctx.status` is the
  // run's own status (from the pre-POST read, or the POST's `status`); when it is terminal the answer is
  // undelivered, the question stays, and the card says so. A live or unknown status keeps the old behaviour.
  noteAnswered(j, shown, ctx = {}) {
    const ended = endedRunWord(ctx);
    if (ended) return this.noteUndelivered(j, ended, { answer: shown });
    this.push(j, { kind: "dim", text: `⇢ answered the agent's question: ${String(shown).slice(0, 240)}` });
    j.questionDone = { answer: String(shown), at: new Date().toISOString() };
    j.question = null;
    this.emit(j);
    return { ok: true, runId: j.runId, answer: shown };
  }

  // An answer that reached the gateway and not the turn. The question is left in place on purpose: the reader's
  // decision was not taken, and collapsing the box would read as though it had been. The sweep settles the job —
  // and closes the question with it — on the run's own terminal status, one tick later.
  noteUndelivered(j, runStatus, { answer = "" } = {}) {
    const word = String(runStatus || "").trim() || "ended";
    const error = `the run had already ended (${word}) — the answer was not delivered`;
    this.push(j, { kind: "dim", text: `⇢ ${error}` });
    this.onLog(`run ${j.id}: clarify answer undelivered — the gateway says run ${j.runId} is ${word}`);
    this.emit(j);
    return { ok: false, undelivered: true, code: "run_ended", runStatus: word, runId: j.runId, answer, error };
  }

  async stop(id) {
    const j = this.jobs.get(String(id || ""));
    if (!j || !j.runId || j.status !== "running") return false;
    // Who ended it, recorded before the request goes out: the run settles as `cancelled`, and the notice has
    // to be able to say that the panel asked for this rather than the turn having failed on its own.
    this.terminate(j, "reader");
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

  // The card that speaks for a thread's session: the one STARTED last. Deliberately not the highest `turn`:
  // a turn number is `siblings.length + 1` in `create()`, so it REPEATS as the store prunes a thread's older
  // cards (KEEP_JOBS), and the live board held a turn 16 from 19:01 beside the turn 13 that failed at 19:23.
  // Ordering by `turn` read the older card, `lostSessionOf` found nothing lost, and the next turn walked back
  // into the session the gateway had fenced — six turns on three assistant sessions, 19:18-19:40 on 2026-11-06.
  newestCard(list = []) {
    return (
      [...(list || [])]
        .filter(Boolean)
        .sort((a, b) => {
          const one = String(a.startedAt || "");
          const two = String(b.startedAt || "");
          return one === two ? String(a.endedAt || "").localeCompare(String(b.endedAt || "")) : one.localeCompare(two);
        })
        .pop() || null
    );
  }

  // The gateway SESSION a thread's next turn continues: the newest session this thread opened. Usually the thread
  // id itself, because the first turn posted to it. A repair that had to replace a lost session becomes the
  // thread's session for every turn after it — continuing the original id there would walk back into the fence
  // the repair just stepped out of.
  sessionFor(siblings = []) {
    const withSession = (siblings || []).filter((j) => j && j.sessionId);
    if (!withSession.length) return null;
    const newest = this.newestCard(withSession);
    return String(newest.sessionId) || null;
  }

  // Has the gateway lost the session this thread would continue? Two answers name the same wedge, and both mean
  // "open a new session", never "re-send to this one":
  //   * a settled turn on that session whose run ended on the gateway's own `unknown_execution`;
  //   * a run id the gateway still answers `queued` with no `execution_generation` — admitted behind a fence and
  //     never claimed, so nothing will ever start it.
  // A run that merely timed out, crashed, or was killed by the panel cap is NOT this: its session is healthy, and
  // the retry continues it, which is the whole point of the reply path. So is a probe that cannot answer (a 404, a
  // transport failure): no verdict is not evidence, and the turn continues as it always did.
  async lostSessionOf(siblings = [], sessionId = null) {
    const session = String(sessionId || "");
    if (!session) return null;
    const onSession = (siblings || []).filter((j) => j && String(j.sessionId || j.thread) === session);
    // A turn already running on this session is proof the gateway is claiming it: whatever an OLDER turn ended on,
    // nothing is replaced while a live one is using the session.
    if (onSession.some((j) => isLiveJobStatus(j.status))) return null;
    const settled = onSession.filter((j) => j.runId);
    if (!settled.length) return null;
    // The newest settled turn is the one that speaks for the session: an older turn's fate was already answered by
    // whatever repair followed it. "Newest" is the clock, not the turn number — see `newestCard`.
    const newest = this.newestCard(settled);
    if (String(newest.error || "").includes(LOST_SESSION_CODE)) {
      return { why: `run ${newest.runId} ended ${LOST_SESSION_CODE}`, runId: String(newest.runId) };
    }
    const probe = await this.runProbe(newest);
    const run = probe && probe.known === true ? probe.run : null;
    if (!run) return null;
    if (String(run.status || "") === "queued" && run.execution_generation == null) {
      return { why: `run ${newest.runId} is queued with no execution generation`, runId: String(newest.runId) };
    }
    return null;
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
