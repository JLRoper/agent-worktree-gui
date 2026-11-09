// One assistant's own task queue: the work THAT assistant is carrying, and the place another assistant (or the
// reader) can put work, change who owns it, or take it away.
//
// The queue is a NEW store for every assistant, #1 included: state/assistants/<id>/queue.json. There is no legacy
// layer, because there never was a queue — #1's queue is not a key in assistant.json and never was, so there is
// nothing to migrate and no second place for the same list. A single assistant's queue is a small JSON document
// beside its charter and its settings, and a reader who opens the directory sees everything that assistant
// remembers in one place.
//
// A task is {id, title, detail, state, owner, createdBy, createdAt, startedAt, doneAt, doneBy, thread, threads[],
// project, worktree, files[], lane, order, attempts, reason, hold, movedFrom[], runId}. `thread` is the FIRST agent that carried it and the legacy field
// every older queue file already speaks; `threads` is every agent that has carried it, first first, so a re-queued
// task keeps the console rows of the run that went before. `runId` is the RUN the row is on NOW - the gateway's run
// id, or the panel's job id when the gateway gave none - and the running/stale verdict is derived from that run's
// status, because one thread can hold a dead attempt and a live retry at once (see the run section below). `state` is one of queued | running | parked | done. Everything else —
// stale, conflict — is DERIVED at read time from the job store and the scanned rows and is never written to the
// file: a running task whose thread stopped is still "running" on disk until the panel or the assistant decides
// what to do with it, and a queued task that touches a running task's files is still queued, just shown as skipped
// with the reason. Writing those flags would make a snapshot of the job store into state, and the next read would
// believe it after the run was gone.
//
// Two fields are new in this pass and both are about ORDER rather than autonomy. `hold` is the machine-readable half
// of a park ({kind, value, since}, see the hold section), and `lane` names the file two rows share so the digest can
// say which of them goes first. The panel renders that order; it never starts anything because of it.
//
// `order` is the READER's half of the same question: the place a card was dragged to, stored per task and applied as
// the tiebreak inside a state bucket (a bucket is the pane's running/queued/parked/done grouping, and it always wins
// over `order` — a dragged card cannot leave its section). It is optional, because every queue file written before
// the drag existed carries none: a row without one falls back to its id, which is the order the pane drew before.
//
// The cap is applied on the way IN and on the way OUT, exactly as ./store-file.js does for assistant.json: a cap
// that moves from one side to the other changes how much history a restart remembers, silently, in the one
// direction nobody notices until a restart reads less than the running process had. The rule here keeps the active
// work: when the file is over the cap the oldest DONE tasks go first, and only then the oldest active ones.
//
// This module owns the schema, the caps and the transitions. The Assistant owns the file path (resolved from its
// charter's directory) and the read-modify-write that journals and repaints; the route module owns HTTP. Nothing
// here touches the job store or git — the callers pass `isLive(thread)` and `rowFor(task)` in.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { reasonOf } from "./read.js";
import { jobTreePath } from "../job-trees.js";
import { tagOf } from "../tree-names.js";

export const QUEUE_VERSION = 1;
// What a task's marker means: ○ queued, ● running, ⏸ parked, ✓ done. `stale` and `conflict` are not states — they
// are what a reader is told about a task that is still in one of these four.
export const TASK_STATES = ["queued", "running", "parked", "done"];
export const TASK_OPEN = ["queued", "running", "parked"];
export const TASK_CAP = 200;
export const TASK_TITLE_MAX = 200;
export const TASK_DETAIL_MAX = 4000;
export const TASK_REASON_MAX = 600;
export const TASK_FILE_MAX = 300;
export const TASK_FILES_MAX = 40;
export const TASK_THREAD_MAX = 120;
export const TASK_THREADS_MAX = 20;
// The id of the RUN a row is on, not only the thread it is on. A gateway run id is `run_` and eight hex digits, and
// a store row the gateway never gave one carries the panel's own job id (eight hex) instead; the cap is generous so a
// hand-written file cannot paste a paragraph here, and short enough that the field stays an identifier.
export const TASK_RUN_MAX = 120;
export const MOVED_MAX = 20;
// A park's machine-readable half (see the hold section below) and the name of the lane a row shares with its peers.
export const TASK_HOLD_KINDS = ["thread", "job", "task", "path", "manual"];
export const TASK_HOLD_VALUE_MAX = 300;
export const TASK_LANE_MAX = 200;
// A task's project is a NAME, not a path — the card's meta line has room for one short word beside the files, and a
// path there is what would push them off it. Long enough for a real directory name, short enough to never wrap alone.
export const TASK_PROJECT_MAX = 60;
// The key of the turn line that filed a row: `<turn id>|<kind>|<index>`, which is a uuid8, a word and a small
// number — about forty characters. The cap is generous only so a hand-written file cannot paste a paragraph here.
export const TASK_CARRIED_KEY_MAX = 120;
// The digest's own default, and the ceiling a hand-edited file cannot exceed. Both are assistant settings too
// (config.js's DEFAULTS), so the page and a preamble read the same numbers.
export const DIGEST_SIZE_DEFAULT = 5;
export const DIGEST_SIZE_MAX = 20;
export const SWEEP_EVERY_DEFAULT = 1;
export const SWEEP_EVERY_MAX = 20;

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) : t;
};
const nowIso = (at) => new Date(at || Date.now()).toISOString();

/** Where one assistant's queue lives, relative to the state directory (beside its charter and settings). */
export const queueRelFor = (id) => path.join("assistants", String(id || ""), "queue.json");
/** The absolute file for one assistant's queue. */
export const queuePathOf = (stateDir, id) => path.join(String(stateDir || ""), queueRelFor(id));

// One comparable form for a file a task claims. Separators to `/`, no leading `./`, no trailing slash, and the same
// case folding the rest of the panel uses for paths. A path is what the reader typed; it is not resolved against a
// tree here, because a task may be queued for a tree that does not exist yet.
export const normQueueFile = (f) =>
  String(f ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
const normQueueFiles = (list) => {
  const src = Array.isArray(list) ? list : String(list ?? "").split(/[,\n\r]+/);
  const out = [];
  const seen = new Set();
  for (const raw of src) {
    const file = normQueueFile(raw);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(clip(file, TASK_FILE_MAX));
    if (out.length >= TASK_FILES_MAX) break;
  }
  return out;
};

// Two claimed paths intersect when they name the same file or one names a directory the other lives in. Exact
// equality alone would let `lib/assistant.js` and `lib/assistant` pass as disjoint when they are the same file and its
// directory; substring matching would call `lib/a.js` and `lib/ab.js` a clash. A boundary match is the honest middle.
export function filesIntersect(a, b) {
  const x = normQueueFile(a);
  const y = normQueueFile(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
export function intersectingFiles(filesA, filesB) {
  const out = [];
  for (const a of Array.isArray(filesA) ? filesA : []) {
    for (const b of Array.isArray(filesB) ? filesB : []) {
      if (filesIntersect(a, b) && !out.some((f) => normQueueFile(f) === normQueueFile(a))) out.push(a);
    }
  }
  return out;
}

// The threads that have carried one task, FIRST one first. `thread` is the legacy field every older reader and every
// queue file written before `threads` existed still speaks, so it is always the first entry of the list — and a record
// with no `threads` at all reads as the one-element list its `thread` names. The CURRENT run is the LAST entry: a
// re-queued task picks up a second agent, and the one that went before stays on the record as the console row it was.
// Duplicates are dropped, because a task whose thread was re-edited must not grow a sub-row for the same agent twice.
const normThreads = (legacy, list) => {
  const out = [];
  const add = (v) => {
    const s = clip(String(v ?? "").trim(), TASK_THREAD_MAX);
    if (!s || out.includes(s)) return;
    out.push(s);
    // The cap keeps the NEWEST entry, never the first twenty. The last thread is the run carrying the task NOW
    // (`currentThread`), so a cap that refused it froze `currentThread` on the 20th for the rest of the row's life:
    // the 24-stage run recorded 24 threads on a row capped at 20, and 19 stage runs settled on `loop-20` — a job
    // that had already finished — while the worker those stages actually had was still running. The legacy FIRST
    // entry stays first (older readers speak it), so the entry dropped is the oldest of the LATER ones.
    if (out.length > TASK_THREADS_MAX) out.splice(1, 1);
  };
  add(legacy);
  for (const v of Array.isArray(list) ? list : []) add(v);
  return out;
};

/** Every agent that has carried one task, first first; the LAST entry is the run carrying it now. */
export const taskThreads = (t) => normThreads(t?.thread, t?.threads);
/** The thread whose run carries the task NOW — the newest agent on the record, or null for a task nobody has run. */
export const currentThread = (t) => taskThreads(t).at(-1) || null;

// ---- the run a row is on ---------------------------------------------------------------------------------
//
// A row used to carry a THREAD and nothing else, and a thread is not one run. A re-queued task's thread can hold a
// failed attempt and a live retry at the same time, so a liveness test that reads the slug cannot tell which of the
// two is going: it calls the row live while its own run is dead, and dead while a retry on that same thread is
// working. That is how four rows were once counted as in flight from their names rather than from evidence.
//
// So the row names the RUN: `runId`, written at the cut (`linkTaskRun`) and again at every resume, and its running and
// stale state is derived from THAT run's status in the job store. Two rows sharing a thread no longer share a verdict.
//
// A row with no run id - every queue file written before this field, a run the gateway refused before it had an id -
// keeps the old answer, but it is a GUESS and is marked as one (`by` is "tree" or "thread", never "run"): a live run
// standing in the row's own tree first, then a live run on its thread. The card prints the guess rather than passing
// it off as evidence, which is the whole difference between a name and a fact.
export const normRunId = (raw) => {
  const s = String(raw ?? "").trim();
  return s ? clip(s, TASK_RUN_MAX) : null;
};

/** The id a job is named by on a queue row: the gateway's run id, or the panel's job id when the gateway gave none. */
export const runIdOfJob = (job) => normRunId(job?.runId || job?.id);

// A job status whose turn is still going. The same list the page's own chip reads (public/queue-cards.js's
// QUEUE_LIVE), kept here because this module owns the verdict and the two must not drift.
const LIVE_RUN_STATUS = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);
const liveRunStatus = (status) => LIVE_RUN_STATUS.has(String(status || "").toLowerCase());
// The tree a run stands in, with the same precedence lib/jobs.js's `treeOfJob` uses: the tree that OWNS the agent
// first, because a run that has not been handed a directory yet still has an owner.
const normRunTree = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
const runTreeOf = (j) => normRunTree(jobTreePath(j));

/** The run one row names, found in the job store by gateway run id, or by the panel's job id when that is what the
 * row was given. null for a row that names no run, and for one whose run the store no longer holds. */
export function runOfTask(t, jobs) {
  const id = normRunId(t?.runId);
  if (!id) return null;
  const list = Array.isArray(jobs) ? jobs : [];
  return list.find((j) => j && (String(j.runId || "") === id || String(j.id || "") === id)) || null;
}

/**
 * What a running row's run is doing — the one derivation the tab, the digest and the page's card share.
 *
 * `by` says where the answer came from, and it is the distinction this function exists for:
 *
 *   "run"    the row names a run and the store answered for it. `live` is that run's status and nothing else.
 *   "tree"   a live run stands in the row's tree path — a guess, marked `guessed`.
 *   "thread" no live run in the tree; the old answer, a live run on the row's thread — a guess as well.
 *   null     nothing to guess from (no run id the store can answer for, no thread, no tree), so nothing is claimed.
 *
 * A caller that hands no store at all cannot resolve a named run, so it gets the guessing answer and says so; every
 * caller in the panel passes `jobs`, which is what makes the run id evidence rather than decoration.
 *
 * @returns {{by: string|null, live: boolean|null, run: object|null, status: string|null, why: string, guessed: boolean}}
 */
export function runLiveness(t, { jobs = null, isLive = () => false } = {}) {
  const list = Array.isArray(jobs) ? jobs : null;
  const id = normRunId(t?.runId);
  if (id && list) {
    const run = runOfTask(t, list);
    if (!run) {
      return {
        by: "run",
        live: false,
        run: null,
        status: null,
        why: `run ${id} is not in the run store — it ended and was trimmed, or this panel never held it`,
        guessed: false,
      };
    }
    const status = String(run.status || "").toLowerCase() || null;
    if (liveRunStatus(status)) return { by: "run", live: true, run, status, why: `run ${id} is ${status}`, guessed: false };
    const ended = hhmm(run.endedAt || run.startedAt);
    return {
      by: "run",
      live: false,
      run,
      status,
      why: `run ${id} ended ${status || "without a status"}${ended ? ` ${ended}` : ""} on thread ${run.thread || currentThread(t) || "(none)"}`,
      guessed: false,
    };
  }
  // No run id (or no store to read it against): the old answer, said as the guess it is.
  if (list && t?.worktree) {
    const want = normRunTree(t.worktree);
    const inTree = want ? list.find((j) => j && liveRunStatus(j.status) && runTreeOf(j) === want) || null : null;
    if (inTree) {
      return {
        by: "tree",
        live: true,
        run: inTree,
        status: String(inTree.status || "").toLowerCase() || null,
        why: `no run id on the row — guessed from its tree: run ${inTree.runId || inTree.id} on ${inTree.thread} is live there`,
        guessed: true,
      };
    }
  }
  const thread = currentThread(t);
  if (thread && safeIsLive(isLive, thread)) {
    return {
      by: "thread",
      live: true,
      run: null,
      status: null,
      why: `no run id on the row — guessed from its thread: ${thread} has a live run`,
      guessed: true,
    };
  }
  return {
    by: id ? null : thread ? "thread" : null,
    live: false,
    run: null,
    status: null,
    // The old sentence is kept for the old case, because a reader knows it; what is new is that the row says it is
    // GUESSING. A row that names a run never reaches here unless the caller had no store to read it against.
    why: id
      ? `run ${id} is named on the row, but there is no run store to read it against`
      : !thread
        ? "no thread recorded — nothing is running this task"
        : `that thread has no live run — and the row names no run id, so this is the old guess; the work stopped without being finished or re-queued`,
    guessed: Boolean(id) || Boolean(thread),
  };
}

// ---- holds: what a park is waiting on, in a form the panel can test --------------------------------------
//
// A park used to be a sentence. `reason` is written once, clipped to 100 characters in the digest, and nothing ever
// read it again: `settleTasks` returned early for every state that was not `running`, so a parked row could only
// leave `parked` by a hand. The sentence was usually a release condition — "the live resume run (…-396ea9) is
// working in the event-multi checkout, starts when it settles" — and the half that the clip ate was the thread name,
// which is the half a reader could act on. Three rows on the reader's board were parked for hours on conditions that
// had already stopped being true.
//
// `hold` is the testable half of the park: {kind, value, since}. `kind` says what to look at, `value` names it, and
// `since` is when the park was written (the digest says it out loud). The five kinds:
//
//   thread  a run on that thread (matched by full name, or by the six-hex tag a rename keeps) — true while it is live
//   job     one job id in the job store — true while that job is live
//   task    another row in the SAME queue (#60) — true until that row reads done
//   path    a file or directory — true while it exists (the panel never guesses where it went)
//   manual  nothing to test. "Needs a decision" is not a condition that becomes false, so a manual park is NEVER
//           released by the panel — not after a thousand sweeps. Only a hand moves it.
//
// No hold at all is a legitimate, permanent value and reads exactly like `manual`. The panel never invents a hold out
// of `reason`: the ten rows already on disk name threads, row ids and paths in prose, ambiguously, and a hold guessed
// wrong releases work somebody is still holding.
export function normHold(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind ?? "").trim().toLowerCase();
  if (!TASK_HOLD_KINDS.includes(kind)) return null;
  const value = clip(String(raw.value ?? "").trim(), TASK_HOLD_VALUE_MAX);
  // `manual` is the one kind that needs no value; every other kind names something, and a hold that names nothing
  // can never be tested — which is the defect, wearing a field.
  if (kind !== "manual" && !value) return null;
  const since = raw.since && Number.isFinite(Date.parse(String(raw.since))) ? new Date(String(raw.since)).toISOString() : null;
  return { kind, value, since };
}

/**
 * Whether a hold names something the panel can TEST, and so can end on its own.
 *
 * `manual` is the one kind with nothing to test (`holdState` answers `held: null`), and a park with NO hold is
 * the same decision in a shorter coat: nothing about either becomes false, so nothing ever releases the row and
 * no sweep can act on it. Every other kind names a thread, a job, a row or a path, and each of those can read
 * over. One definition, because `holdState` and the queue's open-row count must not drift apart.
 */
export const holdIsTestable = (hold) => {
  const h = normHold(hold);
  return Boolean(h && h.kind !== "manual");
};

/** The row id a `task` hold names, from `#60`, `60` or `60 ` — null when the value is not an id at all. */
export const holdTaskId = (value) => {
  const m = /^\s*#?\s*(\d+)\s*$/.exec(String(value ?? ""));
  return m ? Number(m[1]) : null;
};

const normLane = (raw) => {
  const s = String(raw ?? "").trim();
  return s ? clip(normQueueFile(s) || s.toLowerCase(), TASK_LANE_MAX) : null;
};

// A task's project, kept as the DIRECTORY NAME it names rather than the path a caller happened to have: the panel
// writes `agent-worktree-gui` at a cut, a script may post `C:/ProjectDevelopment/agent-worktree-gui`, and the card has
// room for the first. Both separators are split, because a Windows caller writes either; an empty value is null, which
// is exactly what a queue file written before this field reads as, so no file has to be migrated.
export const normProject = (raw) => {
  const leaf =
    String(raw ?? "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .pop() || "";
  return leaf ? clip(leaf, TASK_PROJECT_MAX) : null;
};

// The key of the turn line that filed a row (`<turn id>|queue|<index>`). It is an IDENTITY, not prose: trimmed and
// clipped, never derived from the title, because the title is the reader's to edit and a key that changed with it
// would let the same line file again. An absent key reads as null — "no key" — which is what every row filed by a
// reader or by a build before this field reads as, and a missing key is never a match for another missing key.
export const normCarriedKey = (raw) => {
  const s = String(raw ?? "").trim();
  return s ? clip(s, TASK_CARRIED_KEY_MAX) : null;
};

// ---- order: the reader's place for a row ----------------------------------------------------------------
// The pane already groups rows by state — running, then queued, then parked, then done — and that grouping is the
// first half of the sort, always. `order` is the second half, and it is the READER's: the place a card was dragged
// to. Both halves are needed, because a drag may only move a card inside its own group.
export const TASK_BUCKET = { running: 0, queued: 1, parked: 2, done: 3 };
// A stored order is a positive whole number. Anything else (a hand-edited string, a zero, a negative) reads as "no
// order", which is the same as a file written before the drag existed.
const normOrder = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};
/** The number a row is sorted by: its own `order`, or its id when it has none — the order the pane always drew. */
export const orderOf = (t) => {
  const n = Number(t?.order);
  return Number.isFinite(n) && n > 0 ? n : Number(t?.id) || 0;
};
/** The one comparator: `order` first, id as the final tiebreak so two rows with the same order never shuffle. */
export const byQueueOrder = (a, b) => orderOf(a) - orderOf(b) || Number(a?.id) - Number(b?.id);

// A job status whose turn the panel is still holding. Kept local rather than imported from lib/jobs.js: this module
// is the queue's own schema and has never reached into the job store — the caller hands `jobs` in.
const HOLD_LIVE_STATUS = new Set(["running", "starting", "waiting"]);
const holdIsLiveStatus = (status) => HOLD_LIVE_STATUS.has(String(status || "").toLowerCase());
const hhmm = (at) => {
  const ms = Date.parse(String(at || ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : null;
};
const safeIsLive = (isLive, thread) => {
  try {
    return Boolean(isLive(thread));
  } catch {
    return false;
  }
};
// A relative path hold is resolved against the task's own tree, because that is the directory the reader was looking
// at when they wrote it; an absolute one is taken as written.
const resolveHoldPath = (value, worktree) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return raw.replace(/\\/g, "/");
  const base = String(worktree || "").trim();
  return base ? path.resolve(base, raw) : path.resolve(raw);
};

/**
 * Whether one hold still holds, judged from the facts the caller already has in hand.
 *
 * `held` is three-valued on purpose: true (still waiting), false (the thing it waits on is over — release the row),
 * and null (this caller cannot tell). A digest rendered from a read with no job store gets null for a thread or job
 * hold and says so instead of guessing; a settle always has `jobs` and `isLive`, so it always gets an answer.
 *
 * @returns {{kind: string, value: string, held: boolean|null, why: string, short: string}}
 */
export function holdState(hold, { isLive = () => false, jobs = null, tasks = [], task = null } = {}) {
  const h = normHold(hold);
  const list = Array.isArray(jobs) ? jobs : null;
  const queue = Array.isArray(tasks) ? tasks : [];
  if (!holdIsTestable(h)) {
    return { kind: "manual", value: "", held: null, why: "nothing the panel can test", short: "(manual)" };
  }
  const value = h.value;
  const since = hhmm(h.since);
  if (h.kind === "task") {
    const target = holdTaskId(value);
    const row = target ? queue.find((x) => Number(x?.id) === target) : null;
    if (!row) {
      return {
        kind: "task",
        value,
        held: false,
        why: `${target ? `#${target}` : value} is not in this queue`,
        short: `held by ${target ? `#${target}` : value} (not in this queue)`,
      };
    }
    const done = row.state === "done";
    return {
      kind: "task",
      value,
      held: !done,
      why: done ? `#${target} is done` : `#${target} is ${row.state}`,
      // The brief's own words: "parked held by #60 since 21:36".
      short: `held by #${target}${since ? ` since ${since}` : ""}${done ? " (done)" : ""}`,
    };
  }
  if (h.kind === "path") {
    const resolved = resolveHoldPath(value, task?.worktree);
    const there = Boolean(resolved) && existsSync(resolved);
    return {
      kind: "path",
      value,
      held: there,
      why: there ? `${value} exists` : `${value} is gone`,
      short: `on path ${clip(value, 120)} (${there ? "exists" : "gone"})`,
    };
  }
  if (h.kind === "job") {
    if (!list) return { kind: "job", value, held: null, why: "no job list to read", short: `on job ${clip(value, 60)} (unchecked)` };
    const job = list.find((j) => String(j?.id || "") === value || String(j?.runId || "") === value);
    if (!job) {
      return { kind: "job", value, held: false, why: `job ${value} is not in the job store`, short: `on job ${clip(value, 60)} (no such job)` };
    }
    if (holdIsLiveStatus(job.status)) return { kind: "job", value, held: true, why: `job ${value} is ${job.status}`, short: `on job ${clip(value, 60)} (live)` };
    const ended = hhmm(job.endedAt);
    return {
      kind: "job",
      value,
      held: false,
      why: `job ${value} ended ${String(job.status || "?")}${ended ? ` ${ended}` : ""}`,
      short: `on job ${clip(value, 60)} (ended${ended ? ` ${ended}` : ""})`,
    };
  }
  // thread — the name as the job store spells it, matched by full name first and then by the tag a rename keeps, so a
  // tree renamed by the panel does not release a hold on work that is still running.
  const tag = tagOf(value);
  const matches = (j) => {
    const name = String(j?.thread || "");
    if (name === value) return true;
    return Boolean(tag) && tagOf(name) === tag;
  };
  const short = tag || clip(value, 60);
  if (safeIsLive(isLive, value) || (list && list.some((j) => matches(j) && holdIsLiveStatus(j.status) && safeIsLive(isLive, j.thread)))) {
    return { kind: "thread", value, held: true, why: "is live", short: `on thread ${short} (live)` };
  }
  if (!list) return { kind: "thread", value, held: null, why: "no job list to read", short: `on thread ${short} (no live run)` };
  const runs = list.filter(matches).sort((a, b) => String(a?.startedAt || "").localeCompare(String(b?.startedAt || "")));
  const last = runs[runs.length - 1];
  if (!last) return { kind: "thread", value, held: null, why: `no run on record for ${value}`, short: `on thread ${short} (no run on record)` };
  const status = String(last.status || "?");
  // A run the store still calls live is live, whatever `isLive` said — the two answers disagree only while a card is
  // being reconciled, and the wrong one here parks a row on a run that is not there.
  if (holdIsLiveStatus(status)) return { kind: "thread", value, held: true, why: "is live", short: `on thread ${short} (live)` };
  const ended = hhmm(last.endedAt || last.startedAt);
  return {
    kind: "thread",
    value,
    held: false,
    why: `ended ${status}${ended ? ` ${ended}` : ""}`,
    short: `on thread ${short} (ended${ended ? ` ${ended}` : ""})`,
  };
}

/**
 * The stale half of a park the panel cannot test.
 *
 * A `manual` hold — or no hold at all — is never released by the panel, because "needs a decision" is not a condition
 * that becomes false. Its `reason` can still have become false: the prose usually names the row it waits for
 * ("blocked on #38 landing as PR #276"), and #38 reading done is exactly the fact that ended the wait. Nothing here
 * writes anything — a hold guessed out of prose is the defect this field replaced — but the digest can SAY the
 * sentence has gone stale, so a later turn does not wait on a fact the board already read.
 *
 * Only the FIRST id the sentence names is judged, and only when it is a row in THIS queue: "#38 (see PR #276)" must
 * not read stale because some task #276 happens to be done, and an id with no row in the queue says nothing about
 * the park.
 *
 * @returns {{task: number, state: string, why: string}|null}
 */
export function staleReason(task, tasks = []) {
  const t = task && typeof task === "object" ? task : null;
  if (!t || t.state !== "parked") return null;
  const hold = normHold(t.hold);
  if (hold && hold.kind !== "manual") return null;
  const m = /#\s*(\d+)/.exec(String(t.reason || ""));
  const id = m ? Number(m[1]) : null;
  if (!id) return null;
  const row = (Array.isArray(tasks) ? tasks : []).find((x) => Number(x?.id) === id);
  if (!row || row.state !== "done") return null;
  return { task: id, state: "done", why: `#${id} is done` };
}

/**
 * One task, normalised. A record without an id or a title is dropped rather than trusted: the file is hand-editable,
 * and a task nobody can name is a task nobody can act on. An unknown state falls back to `queued` — the only state
 * that asks for a decision.
 */
export function pickTask(raw) {
  const t = raw && typeof raw === "object" ? raw : null;
  if (!t) return null;
  const title = clip(String(t.title ?? "").trim(), TASK_TITLE_MAX);
  if (!title) return null;
  const id = Number.isFinite(Number(t.id)) && Number(t.id) > 0 ? Number(t.id) : null;
  if (!id) return null;
  const state = TASK_STATES.includes(String(t.state || "")) ? String(t.state) : "queued";
  const movedFrom = Array.isArray(t.movedFrom)
    ? t.movedFrom
        .filter((m) => m && typeof m === "object" && String(m.to || "").trim())
        .map((m) => ({
          from: String(m.from || "").trim() || null,
          to: String(m.to || "").trim(),
          by: String(m.by || "").trim() || null,
          at: m.at || null,
        }))
        .slice(-MOVED_MAX)
    : [];
  // One list, one legacy field: the record is written with `thread` FIRST (every older reader reads it) and the whole
  // run history behind it in `threads`. A hand-edited file that carries only one of the two still reads as both.
  const threads = normThreads(t.thread, t.threads);
  return {
    id,
    title,
    detail: clip(String(t.detail ?? ""), TASK_DETAIL_MAX),
    state,
    owner: String(t.owner || "").trim() || null,
    createdBy: String(t.createdBy || "").trim() || null,
    createdAt: t.createdAt || null,
    // The turn line that filed this row, when an assistant's QUEUE line did: `<turn id>|queue|<index>`. It is
    // written at file time and asked for by every later read of that line (see `addTask`), because the panel's
    // mark of which turns it has harvested is a 50-id window that ages out — and this does not. Absent on every
    // row a reader filed, and on every row written before the field existed, so no file has to be migrated.
    carriedKey: normCarriedKey(t.carriedKey),
    startedAt: t.startedAt || null,
    doneAt: t.doneAt || null,
    doneBy: String(t.doneBy || "").trim() || null,
    thread: threads[0] || null,
    threads,
    // The RUN this row was last handed, written at the cut and at every resume (see the run section above). Absent on
    // every file written before the field existed, which reads as "no run id" - the guessing fallback, never a guess
    // passed off as evidence. A link with no id to give leaves whatever is here alone.
    runId: normRunId(t.runId),
    worktree: String(t.worktree || "").trim() || null,
    // The project the row is about, as a NAME. Absent on every file written before this field existed, which is why
    // the card DERIVES one from the worktree when it is missing and draws nothing when even that says nothing.
    project: normProject(t.project),
    files: normQueueFiles(t.files),
    // A lane is a NAME two rows share by claiming the same file (see `laneInfo`): a stored one is taken as written,
    // and an absent one is derived from the files at read time, so a queue file written before lanes existed still
    // orders correctly.
    lane: normLane(t.lane),
    // Where the reader dragged it. Absent on every file written before the pane had a drag; `orderOf` falls back to
    // the id for those, so an old queue keeps the order it always had.
    order: normOrder(t.order),
    attempts: Number.isFinite(Number(t.attempts)) ? Math.max(0, Number(t.attempts)) : 0,
    reason: clip(String(t.reason || ""), TASK_REASON_MAX),
    // The park's testable half. Absent (or `manual`) means the park is the reader's own and the panel never releases
    // it — that is a decision, not a missing value, so nothing here infers one from the reason.
    hold: normHold(t.hold),
    movedFrom,
    // The task's PIPELINE assignment (lib/task-pipeline.js): `{pipeline, stage, enteredAt}`, or null for "the assistant
    // decides". Carried VERBATIM, because this file is not the pipeline's reader: a record naming a pipeline the bundle
    // no longer holds has to reach the window as `unresolved`, and normalising a broken one to null here would silently
    // put the task back on the default path — the one fallback the contract forbids.
    pipelineRun: t.pipelineRun ?? null,
  };
}

// The cap, applied identically on the way in and on the way out. Done work goes before live work: a queue's history
// is worth less than the task somebody is waiting on.
function capTasks(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length <= TASK_CAP) return list;
  const drop = new Set();
  const excess = list.length - TASK_CAP;
  for (const t of list) {
    if (drop.size >= excess) break;
    if (t.state === "done") drop.add(t.id);
  }
  for (const t of list) {
    if (drop.size >= excess) break;
    drop.add(t.id);
  }
  return list.filter((t) => !drop.has(t.id));
}

/**
 * Read one queue file into a snapshot. A missing file is a first boot, not an error. The nextId is DERIVED on load
 * rather than trusted: a hand-edited file must never be able to hand the same id out twice, which is the one property
 * the whole scheme rests on.
 * @returns {{found: boolean, error: string|null, tasks: object[], nextId: number}}
 */
export function readQueueFile(file) {
  try {
    if (!file || !existsSync(file)) return { found: false, error: null, tasks: [], nextId: 1 };
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.tasks) ? raw.tasks : [];
    const seen = new Set();
    const tasks = [];
    for (const r of list) {
      const t = pickTask(r);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      tasks.push(t);
    }
    const capped = capTasks(tasks);
    const nextId = Math.max(
      Number(raw?.nextId) || 1,
      capped.reduce((n, t) => Math.max(n, Number(t.id) || 0), 0) + 1,
    );
    return { found: true, error: null, tasks: capped, nextId };
  } catch (err) {
    return { found: false, error: reasonOf(err), tasks: [], nextId: 1 };
  }
}

/**
 * Write one queue file. Atomic — tmp + rename — like every other store in this panel: a crash mid-write leaves the
 * previous queue intact rather than a half-written one. The cap is applied here as well as on read.
 * @returns {object[]} the tasks actually written
 */
export function writeQueueFile(file, tasks = [], nextId = null) {
  const list = capTasks((Array.isArray(tasks) ? tasks : []).map(pickTask).filter(Boolean));
  const doc = {
    version: QUEUE_VERSION,
    nextId: Math.max(Number(nextId) || 1, list.reduce((n, t) => Math.max(n, Number(t.id) || 0), 0) + 1),
    tasks: list,
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 1)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    const e = new Error(`could not write ${file}: ${reasonOf(err)}`);
    e.code = "queue-write-failed";
    throw e;
  }
  return list;
}

/** Read one assistant's queue straight from its state directory. */
export function readQueueFor(stateDir, id) {
  return readQueueFile(queuePathOf(stateDir, id));
}

/** Write one assistant's queue straight to its state directory. */
export function writeQueueFor(stateDir, id, tasks, nextId = null) {
  return writeQueueFile(queuePathOf(stateDir, id), tasks, nextId);
}

// ---- the operations a caller may ask for --------------------------------------------------------------

/**
 * Add one task. The title is the only required field; everything else defaults to "nothing known yet" — `project` and
 * `files` included, so a caller that knows only the work is still a valid caller. The task starts
 * `queued` whatever the caller says: work that is already running is set to running by `setTaskState`, through the
 * same door as everything else, so the startedAt stamp is never a caller's guess.
 *
 * `carriedKey` is the turn line this row stands for (`<turn id>|queue|<index>`), and a row that already carries it is
 * returned instead of a second one being pushed: a turn re-read after the panel's 50-id harvest mark aged out must
 * not file its line again. The key comes from the CALLER's argument and never from `input`, because the page posts
 * `input` and must not be able to claim a line this panel never carried.
 * @returns {{task: object, tasks: object[], nextId: number, duplicate?: boolean}}
 */
export function addTask(tasks, input = {}, { by = "reader", at = new Date(), nextId = null, carriedKey = null } = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const title = clip(String(input.title ?? "").trim(), TASK_TITLE_MAX);
  if (!title) {
    const e = new Error("a task needs a title");
    e.code = "queue-title";
    throw e;
  }
  const base = Math.max(Number(nextId) || 1, list.reduce((n, t) => Math.max(n, Number(t.id) || 0), 0) + 1);
  const key = normCarriedKey(carriedKey);
  if (key) {
    const already = list.find((t) => t && normCarriedKey(t.carriedKey) === key);
    if (already) return { task: already, tasks: list, nextId: base, duplicate: true };
  }
  const task = pickTask({
    ...input,
    id: base,
    title,
    // Overwrites whatever `input` carried: the key is the caller's to give (see above), never the payload's.
    carriedKey: key,
    state: "queued",
    createdBy: by,
    createdAt: nowIso(at),
    startedAt: null,
    doneAt: null,
    doneBy: null,
    // A new row is on no run yet, and the id is evidence rather than a field a caller may claim: the cut and the
    // resume write it (`linkTaskRun`), never a payload from the page.
    runId: null,
    attempts: 0,
    reason: "",
  });
  list.push(task);
  return { task, tasks: capTasks(list), nextId: base + 1 };
}

/**
 * Change the words or the claims of one task. Owner and state are NOT here: they are the two facts with a history
 * (`reassignTask` records movedFrom, `setTaskState` stamps startedAt/doneAt), and a patch that could set them would be
 * a second door with none of the bookkeeping.
 * @returns {{task: object, tasks: object[]}|null} null when no task has that id
 */
export function editTask(tasks, id, patch = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const i = list.findIndex((t) => Number(t.id) === Number(id));
  if (i < 0) return null;
  const t = list[i];
  const next = { ...t };
  if (patch.title !== undefined) {
    const title = clip(String(patch.title ?? "").trim(), TASK_TITLE_MAX);
    if (!title) {
      const e = new Error("a task needs a title");
      e.code = "queue-title";
      throw e;
    }
    next.title = title;
  }
  if (patch.detail !== undefined) next.detail = clip(String(patch.detail ?? ""), TASK_DETAIL_MAX);
  if (patch.files !== undefined) next.files = normQueueFiles(patch.files);
  // Set or CLEARED: an edit that names no project is how a row whose project was a guess goes back to "nothing known",
  // which is the same state a file written before the field reads. Absent from the patch leaves the row alone, so an
  // ordinary title edit cannot erase the project the cut wrote.
  if (patch.project !== undefined) next.project = normProject(patch.project);
  // `runId` is the RUN the row is on, and an edit is the door a row FILED after the fact takes to name it: a SPAWN's
  // cut writes the id through `linkTaskRun`, but a row filed by a reader, a script or a stage carries no run at all,
  // so without this branch the only way to attach one was to re-cut the task - and until then the row could only be
  // read through the tree/thread guess, never through the run it actually names. Normalised by the SAME `normRunId`
  // the schema uses, so a script's value is clipped exactly like one from the store. Set or CLEARED, like `project`:
  // `null` or `""` returns the row to the guessing fallback a file written before the field reads as, and `undefined`
  // leaves it alone so a title edit cannot erase the run the cut wrote. The state is NOT touched here - starting a
  // row stays `setTaskState`'s decision, and this field only says WHICH run a running row is.
  if (patch.runId !== undefined) next.runId = normRunId(patch.runId);
  if (patch.lane !== undefined) next.lane = normLane(patch.lane);
  // `order` is here so a hand-written or scripted edit can place a row without sending a whole list; the pane itself
  // goes through `reorderTasks`, which is the one door that checks the list as a whole.
  if (patch.order !== undefined) next.order = normOrder(patch.order);
  if (patch.hold !== undefined) {
    // The hold travels on the row's own fields because the only other door into a task (`setTaskState`) is handed
    // `state` and `reason` and nothing else by the route and by the Assistant's `queueMutate`. So a caller that wants a
    // typed park writes the hold here and then asks for `parked`; `setTaskState` CLAIMS it: it refuses one that is
    // already false at that moment and stamps its `since`. Setting it on a row that is not parked is inert by design —
    // nothing reads a hold on a queued or running row, and the park is what makes it mean something.
    if (patch.hold === null || patch.hold === "") {
      next.hold = null;
    } else {
      const hold = normHold(patch.hold);
      if (!hold) {
        const e = new Error(`a hold needs a kind (${TASK_HOLD_KINDS.join(", ")}) and a value — got ${JSON.stringify(patch.hold)}`);
        e.code = "queue-hold";
        throw e;
      }
      next.hold = hold;
    }
  }
  if (patch.thread !== undefined) {
    // A new thread is APPENDED to the task's agents, never a replacement: the pane draws one sub-row per agent, and the
    // run that had it first is the record of how the work got here. `thread` stays the legacy FIRST entry, so an older
    // reader that knows only that field keeps seeing the same thread it always did. An empty value is ignored — a
    // thread is a fact about a run that happened, and an edit cannot un-happen it.
    next.threads = normThreads(t.thread, [...(t.threads || []), patch.thread]);
    next.thread = next.threads[0] || null;
  }
  if (patch.worktree !== undefined) next.worktree = String(patch.worktree || "").trim() || null;
  list[i] = next;
  return { task: next, tasks: list };
}

/**
 * Move one task to another state, stamping the timestamps the state owns. A transition to the state it is already in
 * changes nothing and is reported as such: a press that did nothing must not look like a press that did.
 *
 * A PARK is the one transition that carries a claim about the world, so it is the one that can be refused before it is
 * written. The hold comes from `hold` when the caller has one, and otherwise from the row itself (a hold set through
 * `editTask`, which is the only door a route has). A hold that is already false — the target row is done, the thread
 * has no live run and its run has ended, the job is over, the path is gone — is refused with the sentence naming the
 * part that is false: parking on it would write a row that can only release on the next sweep, which is the same as
 * not parking at all. A `manual` park (and no hold) is always allowed and never released by the panel.
 *
 * Re-parking a row that is already parked is allowed when the hold changes (that is how one of the six prose parks on
 * disk becomes a typed one); with the same hold it changes nothing.
 * @returns {{task: object, tasks: object[], changed: boolean}}
 */
export function setTaskState(tasks, id, next, { by = "reader", reason = "", at = new Date(), hold, isLive, jobs } = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const i = list.findIndex((t) => Number(t.id) === Number(id));
  if (i < 0) return null;
  const want = String(next || "").trim();
  if (!TASK_STATES.includes(want)) {
    const e = new Error(`unknown task state: ${want || "(none)"} — use ${TASK_STATES.join(", ")}`);
    e.code = "queue-state";
    throw e;
  }
  const t = list[i];
  // An explicit hold wins; otherwise the row's own is what the park is claiming. `undefined` and `null` both mean
  // "whatever the row already carries", which is what makes the two-step park work without a second call site.
  const explicit = hold === undefined ? t.hold : hold;
  const claimed = normHold(explicit);
  if (explicit != null && explicit !== "" && !claimed) {
    const e = new Error(`#${t.id} cannot be parked on that hold: it needs a kind (${TASK_HOLD_KINDS.join(", ")}) and a value`);
    e.code = "queue-hold";
    throw e;
  }
  const judged =
    want === "parked" && claimed && claimed.kind !== "manual"
      ? holdState(claimed, { isLive: typeof isLive === "function" ? isLive : () => false, jobs: jobs ?? null, tasks: list, task: t })
      : null;
  if (t.state === want) {
    // Already there. For every state but `parked` this is a no-op; for a park, a DIFFERENT hold is a re-park and is
    // applied (and validated) like any other, because "parked on the wrong thing" is the defect this replaces.
    if (want !== "parked") return { task: t, tasks: list, changed: false };
    const same = (claimed?.kind || null) === (t.hold?.kind || null) && (claimed?.value || "") === (t.hold?.value || "");
    if (same) return { task: t, tasks: list, changed: false };
  }
  if (want === "parked" && judged && judged.held === false) {
    const e = new Error(
      `cannot park #${t.id} on ${claimed.kind} ${claimed.value}: ${judged.why} — that hold is already false, so the row could only release on the next sweep`,
    );
    e.code = "queue-hold";
    throw e;
  }
  const atIso = nowIso(at);
  const updated = { ...t, state: want };
  if (want === "running") {
    updated.startedAt = t.startedAt || atIso;
    updated.doneAt = null;
    updated.doneBy = null;
    updated.reason = "";
    updated.hold = null;
  } else if (want === "done") {
    updated.startedAt = t.startedAt || atIso;
    updated.doneAt = atIso;
    updated.doneBy = String(by || "reader");
    updated.reason = clip(String(reason || t.reason || ""), TASK_REASON_MAX);
    updated.hold = null;
  } else if (want === "parked") {
    updated.doneAt = null;
    updated.doneBy = null;
    updated.reason = clip(String(reason || t.reason || ""), TASK_REASON_MAX);
    // The park stamps `since`; everything else about the hold is what the caller claimed.
    updated.hold = claimed ? { kind: claimed.kind, value: claimed.value, since: atIso } : null;
  } else {
    // queued: a re-queued task starts clean. attempts is history and survives; the stamps belong to the last try, and
    // a hold belongs to the park it was written for — leaving it behind would make the next park inherit a stale one.
    updated.startedAt = null;
    updated.doneAt = null;
    updated.doneBy = null;
    updated.reason = clip(String(reason || ""), TASK_REASON_MAX);
    updated.hold = null;
  }
  list[i] = updated;
  return { task: updated, tasks: list, changed: true };
}

/**
 * Link one task to the run a SPAWN just cut for it: the worker's thread, the worktree it runs in, `running` and the
 * startedAt stamp, written as ONE record. This is the write a SPAWN owes the queue row it named, and it is here
 * rather than in the caller because the two halves `editTask` (thread, worktree) and `setTaskState` (running) would
 * otherwise be two writes with a crash window between them — the row would name the thread while still reading
 * `queued`, which is the state the next digest has to guess about. One transform, one write, nothing left to edit.
 *
 * The thread is APPENDED to the task's agents, exactly as `editTask` does, so a re-run keeps the run that went
 * before; `thread` stays the legacy FIRST entry and the new one is the current agent. A task with no agent yet
 * takes it as both. `project` travels with the cut for the same reason `worktree` does — this is where the panel
 * learns it — and `startedAt` is the first start, like `setTaskState`'s running transition, with the hold of a
 * park this run releases cleared with the state.
 *
 * `runId` is the RUN this row is handed, and it is the half that makes the row's verdict evidence rather than a name:
 * two records can share one thread, and `runLiveness` reads THIS id's status. The cut and the resume both come
 * through here, so a row that was handed a live retry stops reading the dead attempt it named before.
 * @returns {{task: object, tasks: object[], changed: boolean}|null} null when no task has that id
 */
export function linkTaskRun(tasks, id, { thread = null, worktree = null, project = null, runId = null, at = new Date() } = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const i = list.findIndex((t) => Number(t.id) === Number(id));
  if (i < 0) return null;
  const t = list[i];
  const thr = clip(String(thread ?? "").trim(), TASK_THREAD_MAX);
  const tree = String(worktree ?? "").trim();
  const name = normProject(project);
  const run = normRunId(runId);
  const next = { ...t, state: "running" };
  if (thr) {
    next.threads = normThreads(t.thread, [...(t.threads || []), thr]);
    next.thread = next.threads[0] || null;
  }
  // The RUN, not only the thread: a thread can hold a failed attempt and a live retry at once, and the row's stale
  // verdict is derived from this id's status (see `runLiveness`). A caller with no id to give - a store row the
  // gateway never admitted - leaves the old one in place rather than erasing it, exactly as `project` does.
  if (run) next.runId = run;
  if (tree) next.worktree = tree;
  // The cut is the ONE moment the panel knows which project this work is in, so the row is stamped here rather than
  // left to be derived from a tree path later. A caller with nothing to say leaves the field as it was.
  if (name) next.project = name;
  next.startedAt = t.startedAt || nowIso(at);
  next.doneAt = null;
  next.doneBy = null;
  next.reason = "";
  next.hold = null;
  list[i] = next;
  return { task: next, tasks: list, changed: true };
}

/**
 * Hand one task to another owner. The move is recorded on the task (movedFrom) as well as in the journal: an assistant
 * reading its queue after a restart has to be able to see that the work came to it from somewhere, or it will treat
 * another assistant's half-done task as its own idea.
 *
 * This is the RECORD half of a Move. The record half alone was the whole of it once, and that was the defect: a task
 * handed to Assistant #2 kept sitting in Assistant #1's file with a new `owner` field, so the assistant it was moved to
 * never saw it and the one it left still carried it. The file half is `adoptTask` below — the caller records the move
 * here and then moves the record across, so the two cannot disagree about where the task lives.
 * @returns {{task: object, tasks: object[], changed: boolean}|null}
 */
export function reassignTask(tasks, id, owner, { by = "reader", at = new Date(), from = null } = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const i = list.findIndex((t) => Number(t.id) === Number(id));
  if (i < 0) return null;
  const want = String(owner || "").trim();
  if (!want) {
    const e = new Error("reassigning a task needs an owner");
    e.code = "queue-owner";
    throw e;
  }
  const t = list[i];
  if (String(t.owner || "") === want) return { task: t, tasks: list, changed: false };
  const updated = {
    ...t,
    owner: want,
    // `from` is the queue the task was read out of, named by the caller that owns the file: a task added before it
    // carried an `owner` would otherwise record `from: null`, and a hand-over whose audit line cannot say where the
    // work came from is not a record of the move.
    movedFrom: [...t.movedFrom, { from: String(from || t.owner || "").trim() || null, to: want, by: String(by || "reader"), at: nowIso(at) }].slice(-MOVED_MAX),
  };
  list[i] = updated;
  return { task: updated, tasks: list, changed: true };
}

/**
 * Adopt a task into ANOTHER assistant's queue — the file half of a Move. The record comes in exactly as the owner's own
 * queue held it (state, thread, files, attempts and the `movedFrom` entry `reassignTask` just wrote all travel), with
 * one thing new: its id. Ids are per file and the target has never handed this one out, so the task enters under the
 * target's own `nextId` rather than colliding with a row that is already there.
 *
 * The task keeps its state on purpose: a running task handed over is still running, and a parked one is still blocked
 * for the reason it recorded. The move is about whose queue carries it, not about restarting it.
 * @returns {{task: object, tasks: object[], nextId: number, fromId: number}|null}
 */
export function adoptTask(tasks, task, { nextId = null } = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const src = task && typeof task === "object" ? task : null;
  if (!src) return null;
  const base = Math.max(Number(nextId) || 1, list.reduce((n, t) => Math.max(n, Number(t.id) || 0), 0) + 1);
  // A `task` hold names a ROW in the queue it was written in, and ids are per file: #60 in Assistant #1's queue is not
  // #60 in #2's, so carrying the hold across would park the moved row on a stranger. Thread, job and path holds name
  // things outside the file and travel intact.
  const hold = src.hold && src.hold.kind === "task" ? null : src.hold;
  const copied = pickTask({ ...src, id: base, hold });
  // A record with no title is not a task (pickTask drops it), and filing one would put a nameless row in a queue whose
  // whole job is "what am I carrying".
  if (!copied) return null;
  list.push(copied);
  return { task: copied, tasks: capTasks(list), nextId: base + 1, fromId: Number(src.id) || null };
}

/** Remove one task. Deleting is a real delete: a removed task leaves no ghost in the digest. */
export function deleteTask(tasks, id) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const i = list.findIndex((t) => Number(t.id) === Number(id));
  if (i < 0) return null;
  const [task] = list.splice(i, 1);
  return { task, tasks: list };
}

/**
 * Put the queue in the READER's order — the whole visible id list, applied in one pass.
 *
 * This is the write half of the pane's drag, and it is deliberately one call over one list rather than "move task N
 * after task M": two single moves leave a moment where the queue is neither order, and a repaint in that moment
 * shows a list the reader never arranged. Every listed row gets `order` = its position (1-based); a row the caller
 * did not list keeps whatever it carried.
 *
 * Three refusals, each because the list describes something the pane cannot draw or the queue cannot honour:
 *
 *   - an id that is not in this queue, or the same id twice — the list is the queue, so it has to be that queue;
 *   - a list that crosses a state BUCKET (a queued row above a running one, a done row anywhere but last) — the pane
 *     groups by state first and the drag only moves a card inside its own group, so such a list is a caller's bug,
 *     not an order;
 *   - a queued row dragged above a row it HOLDS for (`hold.kind === "task"`, the target still open) — the blocked
 *     rule. A hold whose target is gone or done no longer holds, so it blocks nothing.
 *
 * The caller writes the returned array once (`writeQueueFile`), which is what makes the reorder atomic on disk.
 * @returns {{tasks: object[], order: number[], changed: boolean}}
 */
export function reorderTasks(tasks, ids) {
  const list = Array.isArray(tasks) ? tasks : [];
  const wanted = (Array.isArray(ids) ? ids : []).map((v) => Number(v));
  const refuse = (msg) => Object.assign(new Error(msg), { code: "queue-order" });
  if (!wanted.length) throw refuse("a reorder needs the full ordered id list");
  if (wanted.some((n) => !Number.isInteger(n) || n <= 0)) throw refuse(`a reorder names task ids — got ${JSON.stringify(ids)}`);
  if (new Set(wanted).size !== wanted.length) throw refuse("a reorder lists a task twice");
  const byId = new Map(list.map((t) => [Number(t.id), t]));
  for (const id of wanted) if (!byId.has(id)) throw refuse(`no task #${id} in this queue`);
  let bucket = -1;
  let prev = null;
  for (const id of wanted) {
    const t = byId.get(id);
    const b = TASK_BUCKET[t.state] ?? 9;
    if (b < bucket) throw refuse(`#${id} is ${t.state} — it cannot be listed after #${prev.id} (${prev.state})`);
    bucket = b;
    prev = t;
  }
  const pos = new Map(wanted.map((id, i) => [id, i]));
  for (const id of wanted) {
    const t = byId.get(id);
    if (t.state !== "queued" || t.hold?.kind !== "task") continue;
    const target = holdTaskId(t.hold.value);
    const held = target ? byId.get(target) : null;
    if (!held || held.state === "done") continue;
    if (pos.get(id) < pos.get(target)) throw refuse(`#${id} is held by #${target} — it cannot go above it`);
  }
  let changed = false;
  const next = list.map((t) => {
    const at = pos.has(Number(t.id)) ? pos.get(Number(t.id)) + 1 : t.order;
    if (!at || at === t.order) return t;
    changed = true;
    return { ...t, order: at };
  });
  return { tasks: next, order: wanted, changed };
}

// ---- what a reader (and a preamble) is shown ----------------------------------------------------------

/**
 * The tasks with their DERIVED flags, without touching the file. Two rules:
 *
 *   stale    a task marked running whose thread has no live run in the job store. The run is gone; the task is not
 *            running any more, whatever the file says. A task with no thread at all is stale too — nothing is running
 *            it and nothing ever will until somebody gives it one.
 *   conflict a queued task whose files touch a running task's files. It is skipped with the reason, in the digest and
 *            on the tab: starting it would put two workers in one file. The blocker's own title and id travel with the
 *            reason, so the assistant can decide which one waits.
 *
 * A parked row also carries its hold's verdict (`holdState`), and the open rows carry their lane (see `laneInfo`).
 * Both are computed here rather than in the digest so the tab, the preamble and a script read the same answer.
 *
 * `rowFor(task)` returns the scanned row for the task's worktree (or null), so a running task can carry its PR verdict
 * without a second git read. A task with no worktree carries no row. `jobs` is optional: the route's read hands in
 * `isLive` and `rowFor` and no job list, and a hold whose verdict needs the store then reads `null` (honest) rather
 * than a guess. The settle always has the store, and that is the pass that acts.
 */
export function decorateTasks(tasks, { isLive = () => false, rowFor = () => null, jobs = null } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  // Two passes on purpose: the stale flag belongs to a running task, and a queued task's conflict report names the
  // blockers' staleness. Computing both in one map would need the map's own half-built output as input — so the
  // running tasks are decorated FIRST and the queued ones judge against those decorated records. A stale blocker is
  // named as stale in the skip reason, because "files in use by #4" and "files in use by #4 (stale)" ask a reader for
  // two different decisions: wait, or take the work over.
  const running = list.filter((t) => t.state === "running").map((t) => runningFlag(t, { isLive, rowFor, jobs }));
  const out = list.map((t) => {
    if (t.state === "running") return running.find((r) => r.id === t.id) || runningFlag(t, { isLive, rowFor, jobs });
    const o = { ...t, files: [...t.files] };
    const row = t.worktree ? rowFor(t) : null;
    if (row) {
      o.row = {
        path: row.path || t.worktree,
        branch: row.branch || null,
        // The row's own project, which is the fallback a card uses when the task itself does not name one: a task with
        // no worktree (queued, never cut) is still about a project when its row knows.
        project: String(row.project || "").trim() || null,
        verdict: row.verdict || null,
        ahead: Number.isFinite(Number(row.ahead)) ? Number(row.ahead) : null,
        pr: row.pr && typeof row.pr === "object" ? { number: row.pr.number || null, state: row.pr.state || null } : null,
      };
    }
    if (t.state === "queued" && t.files.length) {
      const blockers = running.filter((r) => r.id !== t.id && intersectingFiles(t.files, r.files).length);
      if (blockers.length) {
        const clash = blockers.flatMap((r) => intersectingFiles(t.files, r.files));
        o.conflict = {
          with: blockers.map((r) => ({ id: r.id, title: r.title, thread: currentThread(r), stale: Boolean(r.stale) })),
          files: [...new Set(clash.map(normQueueFile))],
        };
        o.skipped = `files in use by ${blockers.map((r) => `#${r.id}${r.stale ? " (stale)" : ""}`).join(", ")} — starting it would put two workers in ${o.conflict.files.join(", ")}`;
      }
    }
    return o;
  });
  for (const t of out) {
    // A hold is judged on every row that CARRIES one, not only on a park: a queued row's `task` hold is the rule the
    // pane's drag obeys ("cannot go above the row it holds for"), and the tab reads the same verdict the digest does.
    if (t.hold) t.holdState = holdState(t.hold, { isLive, jobs, tasks: list, task: t });
    // …and a park the panel cannot TEST is judged one step further, so the digest can say its prose has gone stale.
    // This is a DERIVED field only: `settleTasks` still refuses to touch such a row, and nothing here writes.
    const stale = staleReason(t, list);
    if (stale) t.staleReason = stale;
  }
  return laneInfo(out);
}

/**
 * Order the rows that share a file, without starting anything.
 *
 * Two rows that claim the same file are in one LANE, named by that file: `lib/assistant.js`. A lane is ordered by id,
 * and its first row is the lane head — the one that goes first when somebody starts work. A row behind a head that is
 * LIVE reads "waiting on #N": starting it now would put two workers in that file, which is the same rule the conflict
 * flag already states, said as an order rather than as a warning.
 *
 * Only a QUEUED or RUNNING row takes part. A parked row is not a candidate to go first — it is waiting for somebody to
 * release it — so it neither heads a lane nor is ordered behind one; saying "after #2" about a row that will not start
 * until a reader acts is a worse answer than saying nothing.
 *
 * The lane is derived, not stored, unless a row carries its own (`lane` on the file): a queue file written before
 * lanes existed still orders correctly, and there is one fewer fact to keep in step. Nothing here changes a state or
 * an id — the panel renders the order and the assistant decides what to start.
 */
function laneInfo(rows) {
  const open = rows
    .filter((t) => t.state === "queued" || t.state === "running")
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (open.length < 2) return rows;
  const named = new Map();
  for (const t of open) {
    if (t.lane) {
      named.set(t.id, t.lane);
      continue;
    }
    // The lowest-id peer it shares a file with names the lane, so every member of a group agrees on the name without a
    // second pass: A shares x with B and B shares x with A, so both say x.
    let best = null;
    for (const o of open) {
      if (o.id === t.id) continue;
      const shared = intersectingFiles(t.files, o.files).map(normQueueFile).sort();
      if (!shared.length) continue;
      if (!best || Number(o.id) < best.id || (Number(o.id) === best.id && shared[0] < best.file)) best = { id: Number(o.id), file: shared[0] };
    }
    named.set(t.id, best ? best.file : null);
  }
  const groups = new Map();
  for (const t of open) {
    const lane = named.get(t.id);
    if (!lane) continue;
    if (!groups.has(lane)) groups.set(lane, []);
    groups.get(lane).push(t);
  }
  for (const [lane, members] of groups) {
    // One row alone in a lane has nothing to be ordered against, so it is left exactly as it was.
    if (members.length < 2) continue;
    members.sort((a, b) => Number(a.id) - Number(b.id));
    const head = members[0];
    for (const t of members) {
      t.lane = lane;
      t.laneHead = t.id === head.id;
      t.laneHeadId = head.id;
      if (t.id === head.id) continue;
      if (head.state === "running" && !head.stale) t.waitingOn = { id: head.id, lane };
    }
  }
  return rows;
}

/** One running task with its run's liveness and its row's PR verdict — the half a queued task's conflict names. */
function runningFlag(t, { isLive = () => false, rowFor = () => null, jobs = null } = {}) {
  const out = { ...t, files: [...t.files] };
  const row = t.worktree ? rowFor(t) : null;
  if (row) {
    out.row = {
      path: row.path || t.worktree,
      branch: row.branch || null,
      verdict: row.verdict || null,
      ahead: Number.isFinite(Number(row.ahead)) ? Number(row.ahead) : null,
      pr: row.pr && typeof row.pr === "object" ? { number: row.pr.number || null, state: row.pr.state || null } : null,
    };
  }
  // The RUN the row names decides: a thread can hold a dead attempt and a live retry at once, and judging the row by
  // the slug is how a row whose own run failed read "running" because a second record on that thread was going.
  // With no run id the old answer stands, but it is marked as the guess it is (`runBy` "tree"/"thread", `guessed`),
  // so the card can say where the verdict came from instead of passing a guess off as evidence.
  const liveness = runLiveness(t, { jobs, isLive });
  out.runBy = liveness.by;
  out.runStatus = liveness.status;
  if (liveness.guessed) out.guessed = true;
  if (liveness.live !== true) {
    out.stale = true;
    out.staleWhy = liveness.why;
  }
  return out;
}

/** Counts by state, plus the derived halves a header line wants. */
export function queueCounts(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  const out = { total: list.length, queued: 0, running: 0, parked: 0, done: 0, stale: 0, conflict: 0 };
  for (const t of list) {
    if (out[t.state] !== undefined) out[t.state] += 1;
    if (t.stale) out.stale += 1;
    if (t.conflict) out.conflict += 1;
  }
  return out;
}

const markerOf = (t) => (t.state === "done" ? "✓" : t.state === "parked" ? "⏸" : t.state === "running" ? "●" : "○");

// Every digest line carries the same five facts, in the same order, so a turn can compare two tasks without
// re-reading the sentence: the state, the thread that runs it, the worktree it works in, what its PR reads, and
// the reason it is not going. A line that leaves one out is a line the model guesses at, and the guess it makes
// is "nothing is running this" — which is how a second worker lands on the same files.
function taskFacts(t) {
  const now = currentThread(t);
  const earlier = taskThreads(t).length - (now ? 1 : 0);
  // The current agent is the one the next turn has to look at (its console, its `TO`), so it is the one named; the
  // count says the task has been carried before, without spending five lines on agents that already ended.
  const thread = now ? `${now}${earlier ? ` (+${earlier} earlier)` : ""}` : "(none)";
  // The RUN the row is on, beside the thread it is on: the id is what a turn quotes to /api/jobs when it wants the
  // evidence for a row rather than the name it happens to carry. Absent rows say nothing rather than "(guessing)",
  // which the row's own LIVE/STALE half already says.
  const run = t.state === "running" && normRunId(t?.runId) ? ` · run ${clip(normRunId(t.runId), 60)}` : "";
  const tree = t.worktree ? String(t.worktree).replace(/\\/g, "/") : "(none)";
  const verdict = String(t.row?.verdict || "").trim();
  const number = t.row?.pr?.number;
  const pr = verdict ? `PR ${clip(verdict, 60)}${number ? ` #${number}` : ""}` : "PR none";
  return ` · thread ${thread}${run} · tree ${clip(tree, 120)} · ${pr}`;
}

/**
 * The compact digest the preamble carries. Exactly the brief's list: the top `size` queued tasks, every running task
 * with its thread, and every stale one — which is every running task whose thread is gone, already in that list and
 * marked there. Parked work is listed too, because a parked task is blocked and the one thing worth saying about it is
 * why; done work is a count in the header only. An empty queue returns [] — a preamble that says "you have no queue"
 * on every turn is a preamble nobody reads.
 *
 * Every line carries the same five facts — state, thread, worktree, PR state, and the reason it is not going — so a
 * turn can compare two tasks without re-reading the sentence, and a live thread says LIVE rather than leaving the
 * reader to infer it from the absence of STALE.
 *
 * Two additions, each placed where a clip cannot take what matters:
 *
 *   the HOLD  `- ⏸ #45 parked on thread 396ea9 (ended 22:43) · …` — FIRST, ahead of the title and the free-text reason,
 *             both of which are clipped (90 and 100 characters). The old line put the reason last, so the half that got
 *             cut was the thread name — the only part anybody could act on. A park with no hold says
 *             `parked (manual)`: it is a decision, and it never releases by itself.
 *   the LANE  on a queued row that shares a file with another open row: ` · lane lib/x.js (head)` for the one that goes
 *             first, ` · waiting on #12 (lane lib/x.js)` behind a live head. Appended last on the line, after the skip
 *             reason, so the facts that were already there keep their order.
 */
export function queueDigest(tasks, { size = DIGEST_SIZE_DEFAULT, isLive = () => false, rowFor = () => null, jobs = null, label = "Your task queue" } = {}) {
  const list = decorateTasks(tasks, { isLive, rowFor, jobs });
  if (!list.length) return [];
  const n = Math.max(1, Math.min(DIGEST_SIZE_MAX, Number(size) || DIGEST_SIZE_DEFAULT));
  const c = queueCounts(list);
  const lines = [
    `${label} (${c.queued} queued · ${c.running} running${c.stale ? `, ${c.stale} stale` : ""} · ${c.parked} parked · ${c.done} done):`,
  ];
  const queued = list.filter((t) => t.state === "queued").sort(byQueueOrder);
  for (const t of queued.slice(0, n)) {
    const who = t.owner ? ` · owner ${t.owner}` : "";
    const files = t.files.length ? ` · files ${t.files.slice(0, 4).join(", ")}${t.files.length > 4 ? "…" : ""}` : "";
    const skip = t.conflict ? ` · SKIP: ${t.skipped}` : "";
    lines.push(`- ○ #${t.id} queued · ${clip(t.title, 90)}${taskFacts(t)}${who}${files}${skip}${laneNote(t)}`);
  }
  if (queued.length > n) lines.push(`- … and ${queued.length - n} more queued — open the Queue tab to see them`);
  for (const t of list.filter((x) => x.state === "running").sort(byQueueOrder)) {
    // LIVE is said out loud rather than left to the absence of STALE: a turn that has to infer liveness from a
    // missing word reads a live thread as one it may start again.
    const live = t.stale ? ` · STALE: ${t.staleWhy}` : " · LIVE";
    const files = t.files.length ? ` · files ${t.files.slice(0, 4).join(", ")}${t.files.length > 4 ? "…" : ""}` : "";
    lines.push(`- ● #${t.id} running · ${clip(t.title, 90)}${taskFacts(t)}${files}${live}${laneNote(t)}`);
  }
  for (const t of list.filter((x) => x.state === "parked").sort(byQueueOrder)) {
    lines.push(`- ⏸ #${t.id} parked${holdNote(t)} · ${clip(t.title, 90)}${taskFacts(t)} · PARKED: ${t.reason ? clip(t.reason, 100) : "no reason recorded"}`);
  }
  return lines;
}

/** The hold, said first, before the title and the reason can be clipped. A manual park says so; a manual park whose
 * prose names a row that is already done says the reason is stale instead, because nothing will ever release it for
 * that row. */
function holdNote(t) {
  const testable = t.holdState && t.holdState.kind !== "manual";
  if (!testable && t.staleReason) return ` (manual, stale reason: ${t.staleReason.why})`;
  return ` ${t.holdState?.short || (t.hold ? holdState(t.hold).short : "(manual)")}`;
}

/** The lane, said last: the head goes first, and a queued row behind a live head is waiting on it. */
function laneNote(t) {
  if (!t.lane) return "";
  if (t.laneHead) return ` · lane ${t.lane} (head)`;
  if (t.waitingOn) return ` · waiting on #${t.waitingOn.id} (lane ${t.lane})`;
  // A running or parked row behind the head is already where it is; only a queued one is being asked to wait.
  if (t.state !== "queued") return "";
  return ` · lane ${t.lane} after #${t.laneHeadId}`;
}

const FAILED_STATUS = new Set(["failed", "error", "exited", "interrupted", "stopped"]);

/**
 * Eager completion, on the panel's own clock. A running task whose thread has no live run is settled by the facts the
 * board already holds, without asking the assistant:
 *
 *   - the thread's last run ended `done` AND the task's tree reads MERGED (or it has no tree to land) — the work is
 *     finished and landed. Mark it done, doneBy "panel", and leave it in place greyed: the row is the record that the
 *     panel saw it land, not a task that vanished.
 *   - the thread's last run ended failed (or interrupted/stopped) — the attempt did not land. Put it back in the
 *     queue with attempts+1 and the reason, so the next turn knows what went wrong and how many times.
 *   - the thread's last run ended done but its PR does NOT read MERGED — leave it running and STALE. That is the
 *     assistant's judgement to make: land it, fix it, or re-queue it. The panel does not guess, and it does not hide
 *     the phantom either.
 *
 * A PARKED row is settled the same way, by its HOLD, which is the half of the park the panel can test: a hold on a
 * thread or job that is no longer live and whose run has ended, on a row that reads done, or on a path that is gone, is
 * over — the row goes back to `queued` with `hold ended: <kind> <value> — <evidence>` as its reason, so the next turn
 * reads why it is back and starts it. A park with no hold (or `manual`) is never touched: "needs a decision" is not a
 * condition that becomes false, and inventing a TTL for it would release work somebody is still holding. Nothing here
 * wakes anybody — a settle already does, and the row is in the digest either way.
 *
 * A task with no thread, or a thread the job store no longer holds at all, is left alone and reads stale. Nothing here
 * invents a completion from silence.
 * @returns {{tasks: object[], changed: object[]}}
 */
export function settleTasks(tasks, { jobs = [], rowFor = () => null, isLive = () => false, at = new Date(), by = "panel" } = {}) {
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const changed = [];
  const next = list.map((t) => {
    if (t.state === "parked") {
      if (!t.hold || t.hold.kind === "manual") return t;
      const judged = holdState(t.hold, { isLive, jobs, tasks: list, task: t });
      if (judged.held !== false) return t;
      const target = t.hold.kind === "task" ? `#${holdTaskId(t.hold.value) ?? t.hold.value}` : t.hold.value;
      const why = `hold ended: ${t.hold.kind} ${target} — ${judged.why}`;
      changed.push({ id: t.id, title: t.title, thread: t.thread, from: "parked", to: "queued", why });
      return { ...t, state: "queued", hold: null, startedAt: null, doneAt: null, doneBy: null, reason: clip(why, TASK_REASON_MAX) };
    }
    // The settle is about the run carrying the task NOW. When the row NAMES its run, that run is the one whose ending
    // settles it — a live retry on the same thread must not keep a row alive whose own run has failed, and a failed
    // attempt on that thread must not settle a row whose retry is the one going. The thread's last run is the fallback
    // only for a row that names no run (or whose run the store has trimmed, where the thread is all the evidence left).
    if (t.state !== "running") return t;
    const thread = currentThread(t);
    const named = runOfTask(t, jobs);
    const runs = thread ? jobs.filter((j) => String(j.thread || "") === thread).sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || ""))) : [];
    const last = named || runs[runs.length - 1];
    if (!last) return t;
    if (liveRunStatus(last.status)) return t;
    // …and the thread's own liveness is asked only when the thread is what the row was judged by: with a named run,
    // another record's live turn says nothing about whether THIS row's run ended.
    if (!named && thread && isLive(thread)) return t;
    const status = String(last.status || "").toLowerCase();
    if (status === "done") {
      const row = t.worktree ? rowFor(t) : null;
      const verdict = String(row?.verdict || "");
      const merged = !t.worktree || /^MERGED/i.test(verdict);
      if (!merged) return t;
      const why = t.worktree ? `PR reads ${clip(verdict, 80)}` : "the thread settled done with no tree to land";
      changed.push({ id: t.id, title: t.title, thread: t.thread, from: "running", to: "done", why });
      return { ...t, state: "done", doneAt: nowIso(at), doneBy: String(by || "panel"), reason: clip(why, TASK_REASON_MAX) };
    }
    if (FAILED_STATUS.has(status)) {
      const detail = clip(String(last.finalMessage || last.summary || last.lastLine || ""), 220);
      const why = `the run ended ${status}${detail ? `: ${detail}` : " with no final message"}`;
      changed.push({ id: t.id, title: t.title, thread: t.thread, from: "running", to: "queued", why });
      return { ...t, state: "queued", startedAt: null, doneAt: null, doneBy: null, attempts: t.attempts + 1, reason: clip(why, TASK_REASON_MAX) };
    }
    return t;
  });
  return { tasks: next, changed };
}


// ---- the HTTP surface ---------------------------------------------------------------------------------
//
// The routes for this prefix live in routes/assistant-queue.js now (step 8 of docs/reports/module-map-2026-11-07.html:
// one route prefix per file, mounted from a table in server.js). The handler was lifted verbatim and still takes the
// transport helpers from the composition root, so the split costs this module nothing: the schema, the transitions and
// the file all stay here, and a test drives the adapter with stubs exactly as it drove it from this file.
