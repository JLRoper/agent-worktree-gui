// Driving a task THROUGH its pipeline, one stage at a time.
//
// lib/task-pipeline.js says where a task is on a pipeline; lib/task-pipeline-assign.js says how it was put there.
// Neither starts anything. Until this module, a `pipelineRun` on a queue row was a label: the window drew the stage,
// and the work never left the stage the reader chose. This is the driver — the one reader that turns the record into
// the next turn, and the only writer that moves a row forward because a stage SETTLED rather than because a person
// said so.
//
// Eight rules decide its shape:
//
//   1. Only a row that NAMES a pipeline is driven. `pipelineRun: null` is assistant-decides — the panel's default
//      path — and a row on it comes back untouched: no stage is invented for it, no turn is started for it, and the
//      settle that finishes it is the one it had before this module existed. A record naming a pipeline or a stage
//      the bundle does not hold is `unresolved` (lib/task-pipeline.js rule 1) and is left to read unresolved: the
//      panel must not guess a stage from a typo.
//   2. A stage is settled by its RUN, not by a sentence. The run's own status is the fact: a row whose current
//      thread is live has not settled, a `done` run settles the stage, and a row the job store cannot account for is
//      left alone to read stale — exactly the three answers lib/assistant/queue.js `settleTasks` already gives. This
//      module reads them the same way on purpose: two readers of the same thread that disagree about "settled" is
//      how a row advances under a live worker.
//   3. The pipeline's own graph decides the next stage, and the RAIL wins over a back edge. The handoffs leaving a
//      stage are taken in KIND order — `sequence`, then `return`, then `loop` — not in the document's order, because
//      a stage with two ways out is a two-outcome gate (the seed's S9: H-10 back to S8, H-11 on to S10) and the panel
//      does not read a decision's value (rule 5), so it cannot choose by outcome. The first edge in the document made
//      the loop shadow the sequence: the seed's task oscillated S8↔S9 until its cap and S10-S12 were unreachable,
//      while the drawing showed them one column along and joined to S9. The sequence is the edge the picture draws and
//      the edge that lets a pipeline finish; a loop is taken when it is a stage's only way out, which is the shape its
//      cap was written for. When a stage draws no edge, the next stage in the reading order; when neither exists the
//      pipeline is over and the row is finished by the settle, whose landing rule — a tree's PR reads MERGED — is
//      unchanged. A stage is never taken from outside the pipeline: every id here came out of the bundle's own order
//      or handoffs.
//
//      A gate anchored after the LAST stage is named in the answer (`closing`) and is NOT a barrier: there is no edge
//      out of the last stage for it to guard and no stage for it to release the row into, so a row that has settled
//      there is finished by the settle rather than parked on a record that could not change where it goes. The
//      drawing marks that notch `closing` for the same reason — the two readers agree about the object.
//   4. A loop's cap is a count of CROSSINGS, kept on the record (`pipelineRun.crossings`) rather than in a process,
//      because a panel restart is the one thing a loop must survive. `cap: "3 rounds"` allows three crossings of that
//      edge; a fourth is refused and the row parks. A cap that cannot be read as a whole number is not treated as
//      "unlimited": an uncapped loop is not crossed at all, the same fail-closed rule lib/pipelines.js applies to an
//      exit check it cannot evaluate.
//   5. A gate that declares a decision record is a BARRIER, crossed only by that record. When a gate sits after the
//      settled stage and carries a `decision`, the driver looks for the decision's own file in the task's tree and
//      does nothing else: the panel never writes the record, never reads its value, and never lets the code decide a
//      question the studio put in front of a seat. The row parks on that path, and the record's arrival is the only
//      thing that moves it — the driver releases its own park, so the crossing is the file, not a press.
//   6. A failed run parks the row for a decision. Re-starting a stage that died is how one bad turn becomes an
//      unbounded retry loop with nobody reading it; the park says which stage died and why, and a person requeues it.
//   7. Unattended starts are the READER's switch, passed in as `unattended` (the Assistant's `spawn: "auto"`), never
//      assumed here. With the switch off the row still advances and waits, and the starts list is empty — the work is
//      not lost, it is simply not started by a panel the reader told to ask first.
//   8. Nothing here writes. The queue file, the journal and the repaint belong to the Assistant's `sweepQueues`,
//      which hands the returned rows to ONE `writeQueueFile` and the returned starts to `startSpawn`. A driver that
//      wrote would be a second door into a queue whose every write is journalled exactly once.
//
// The row that reaches the front of the queue is the one that starts. "Front" is the queue's own order
// (`byQueueOrder`) over the rows that can move — queued and running — so a pipeline row behind a queued row with no
// pipeline waits its turn instead of jumping the queue it was filed in.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { byQueueOrder, currentThread, setTaskState } from "./assistant/queue.js";
import { pipelineById, stageById } from "./pipeline-bundle.js";
import { TASK_PIPELINE_FIELD, enterStage, resolveTaskPipeline } from "./task-pipeline.js";

// The named reasons a stage can stop for. A journal line and a test both name one of these rather than matching a
// sentence, and the sentence is free to improve without the name moving.
export const DRIVE_FAULTS = Object.freeze({
  CAP: "pipeline-cap", // a loop edge at (or past) the crossings its cap allows
  GATE: "pipeline-gate", // a gate whose decision record has not been written
  FAILED: "pipeline-run-failed", // the stage's run ended in failure
  UNRESOLVED: "pipeline-unresolved", // the record names a pipeline or stage the bundle does not hold
  NO_TARGET: "pipeline-no-target", // nowhere to start: no tree and no project on the row
  STARTING: "pipeline-starting", // a start for this stage is already in flight
});

// The one extra key this module keeps on the record. It is written when a gate stops a row and removed when the
// record arrives: a restart between the two must be able to find the gate it stopped at, and the queue file is the
// only durable place that answer can live.
export const WAITING_FOR = "waitingFor";

// The second key: the moment this row's stage start was ASKED for. `sweepQueues` runs every few seconds and the
// spawner takes longer than that (a gateway probe, a `git worktree add`, an HTTP start), so without this a second
// pass would start a second worker for the same stage before the first one had linked its thread. It is cleared when
// the row moves, and a start still unlinked after this long is tried again.
export const STARTING_AT = "startingAt";
export const START_GRACE_MS = 3 * 60 * 1000;

const FAILED_STATUS = new Set(["failed", "error", "cancelled", "canceled", "stopped", "exited", "interrupted", "timeout"]);

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The record's stamps are UTC instants (lib/task-pipeline.js rule 3). One reader, so every caller's clock is
// interpreted the same way — a Date, a number, or the string a route already parsed.
function isoOf(at) {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(String(at ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

// ---- the graph: what leaves a stage ----------------------------------------------------------------------------
// `cap` is a sentence in the studio's own words ("3 rounds"). The panel reads the WHOLE NUMBER THAT OPENS IT and
// nothing else: what a "round" counts is the studio's word for the edge, and the panel's own unit is one crossing.
//
// Reading the first digit run in the sentence (what this did until now) was wrong in both directions: "P-50, 3 rounds"
// read as a cap of FIFTY, and "2 of 3 rounds" — the progress label the drawing is asked to print — as a cap of TWO,
// so a label would have bounded the loop it was describing. A `n of m` statement is refused outright for that reason:
// it reports on a loop, it does not bound one. A cap this cannot read is not "unlimited" — rule 4 fails closed.
export function capOf(handoff) {
  const raw = text(handoff && handoff.cap);
  if (!raw) return { text: null, limit: null };
  if (/^\d+\s+of\s+\d+/i.test(raw)) return { text: raw, limit: null, why: "progress" };
  const m = /^(\d+)(?=\s|$)/.exec(raw);
  if (!m) return { text: raw, limit: null, why: "unreadable" };
  const limit = Number(m[1]);
  return { text: raw, limit: Number.isInteger(limit) && limit > 0 ? limit : null, why: limit > 0 ? null : "unreadable" };
}

// The edges leaving a stage, in the order the driver will take them. `sequence` is the rail — the edge the drawing
// shows between two adjacent columns, and the one that lets the pipeline finish. `return` is a repair path that
// rejoins the rail behind the stage. `loop` is the capped back edge, taken when it is the only way out. A kind no
// bundle holds is taken last rather than refused: the loader has already judged the shape (lib/pipeline-bundle.js
// HANDOFF_KINDS), and a driver that dropped an edge it did not know would route a task over a graph it misread.
export const EDGE_ORDER = Object.freeze(["sequence", "return", "loop"]);

export function edgeOutOf(pipeline, stageId) {
  const edges = (pipeline && Array.isArray(pipeline.handoffs) ? pipeline.handoffs : []).filter((handoff) => text(handoff.from) === text(stageId));
  if (!edges.length) return null;
  const rank = (handoff) => {
    const at = EDGE_ORDER.indexOf(text(handoff.kind) || "sequence");
    return at < 0 ? EDGE_ORDER.length : at;
  };
  // The document's own order still decides between two edges of the same kind, so a hand-authored bundle keeps the
  // choice its author's first line implies.
  return edges
    .map((handoff, index) => ({ handoff, index, rank: rank(handoff) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)[0].handoff;
}

// A segment of a decision path with a `{{hole}}` in it is a MATCH, not a literal: the studio writes one record per
// finding (`G60-{{finding_id}}.json`), so the panel looks for the file the run wrote rather than inventing a name.
function segmentRegex(segment) {
  const parts = String(segment).split(/(\{\{[^}]*\}\})/);
  const source = parts
    .map((part) => (/^\{\{[^}]*\}\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`);
}

// Resolve a decision path against the task's tree. Answers a path only when it is THERE: a path this function
// invented for a file nobody wrote is the "record exists" lie the barrier exists to prevent.
export function decisionPathOf(rel, { worktree = null } = {}) {
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean) return { found: false, path: null, shown: null, reason: "the gate names no decision path" };
  const base = text(worktree);
  // An absolute path (POSIX, or a Windows drive) is rooted where it says and the tree is not consulted: the studio
  // writes workspace-relative paths, and a reader may pin one outside the tree.
  const absolute = /^(?:[a-zA-Z]:)?\//.test(clean);
  if (!absolute && !base) return { found: false, path: null, shown: clean, reason: "the task has no tree, and the decision record is read from the tree" };
  const segments = clean.split("/").filter((s) => s && s !== "." && s !== "..");
  const shown = absolute ? path.normalize(clean) : path.join(base, ...segments);
  let dir;
  if (!absolute) dir = base;
  else if (/^[a-zA-Z]:$/.test(segments[0] || "")) dir = `${segments.shift()}/`;
  else dir = path.parse(path.resolve("/")).root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (!segment.includes("{{")) {
      dir = path.join(dir, segment);
      if (last) return existsSync(dir) ? { found: true, path: dir, shown, reason: null } : { found: false, path: null, shown, reason: null };
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return { found: false, path: null, shown, reason: null };
      continue;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { found: false, path: null, shown, reason: null };
    const re = segmentRegex(segment);
    const match = readdirSync(dir).filter((name) => re.test(name)).sort()[0];
    if (!match) return { found: false, path: null, shown, reason: null };
    dir = path.join(dir, match);
  }
  return existsSync(dir) ? { found: true, path: dir, shown, reason: null } : { found: false, path: null, shown, reason: null };
}

// The gate that must be crossed on the way out of a stage: one anchored `after` it that DECLARES a decision. A gate
// with no decision is the studio's PAUSE — nothing can wait on it and no record can release it — and treating it as
// a barrier would park every row behind a gate the panel has no way to read.
export function gateAfter(pipeline, stageId) {
  const after = text(stageId);
  if (!pipeline || !after) return null;
  return (pipeline.gates || []).find((gate) => text(gate.after) === after && isObject(gate.decision)) || null;
}

// What the pipeline says comes after `run`'s stage. Three answers, and each one is a value:
//
//   { ok: true, done: false, stage, handoff }   enter `stage`, counting the handoff if there is one
//   { ok: true, done: true }                    the pipeline is over (and `closing` names the gate after the last stage, or null — the run ends ON it, the driver does not wait on it); the settle finishes the row
//   { ok: false, code, reason, ... }            it stops here, and the row parks on the reason
export function nextStageOf(pipeline, run, { worktree = null } = {}) {
  const stageId = text(run && run.stage);
  const current = stageById(pipeline, stageId);
  if (!current) {
    return {
      ok: false,
      done: false,
      code: DRIVE_FAULTS.UNRESOLVED,
      reason: `pipeline "${text(pipeline && pipeline.id)}" holds no stage "${stageId}", so there is no edge out of it to take`,
    };
  }

  // The edge the studio drew out of this stage, taken in KIND order (see EDGE_ORDER) rather than in the document's
  // order: the rail first, so a stage that can both advance and loop back advances — the picture draws it that way.
  const leaving = edgeOutOf(pipeline, stageId);
  const order = Array.isArray(pipeline.order) ? pipeline.order : [];
  const at = order.indexOf(stageId);
  const next = stageById(pipeline, leaving ? leaving.to : at >= 0 ? order[at + 1] : null);
  // No next stage: the pipeline is over, and a gate anchored here guards no edge the driver would take. It is named in
  // the answer rather than acted on, so a caller (and the drawing, which marks that notch `closing`) can say what the
  // run ends on; the row itself is finished by the settle, where a run with no pipeline has always ended.
  if (!next) return { ok: true, done: true, closing: gateAfter(pipeline, stageId) };

  // A gate on the edge out: it sits after the stage, and an edge the studio put a decision in front of is not the
  // driver's to take. Checked before the cap because the gate is the outer question — the loop is only reached once
  // the decision has been made.
  const gate = gateAfter(pipeline, stageId);
  if (gate) {
    const record = decisionPathOf(gate.decision && gate.decision.path, { worktree });
    if (!record.found) {
      return {
        ok: false,
        done: false,
        code: DRIVE_FAULTS.GATE,
        gate,
        path: record.shown,
        reason: `gate ${gate.id} (${gate.name}) follows ${stageId} and declares a decision record at ${record.shown || "(no path)"} — the code does not decide it, and the record ${record.reason || "has not been written"}`,
      };
    }
  }

  if (leaving && text(leaving.kind) === "loop") {
    const cap = capOf(leaving);
    const used = Number(run && isObject(run.crossings) ? run.crossings[leaving.id] : 0) || 0;
    if (cap.limit == null) {
      return {
        ok: false,
        done: false,
        code: DRIVE_FAULTS.CAP,
        handoff: leaving,
        used,
        limit: null,
        stage: next,
        reason: `the loop ${leaving.id} (${leaving.from} → ${leaving.to}) names ${cap.text ? `a cap of ${JSON.stringify(cap.text)}` : "no cap"}, ${
          cap.why === "progress"
            ? "which reports progress (n of m) rather than naming a bound — a label is not a limit, and reading one back is how the drawing would bound the loop it describes"
            : "which does not open with a whole number of rounds — the panel does not guess a limit"
        }, so the edge is not taken`,
      };
    }
    if (used + 1 > cap.limit) {
      return {
        ok: false,
        done: false,
        code: DRIVE_FAULTS.CAP,
        handoff: leaving,
        used,
        limit: cap.limit,
        stage: next,
        reason: `the loop ${leaving.id} (${leaving.from} → ${leaving.to}) is at its cap of ${cap.limit} round${cap.limit === 1 ? "" : "s"} — ${used} crossing${used === 1 ? "" : "s"} already taken, so the row stops here for a decision`,
      };
    }
  }

  return { ok: true, done: false, stage: next, handoff: leaving };
}

// The prompt a stage hands its worker: the stage's own instruction (the loader resolves it from the stage or from
// the role that owns it), then the one line that says which stage and which row this turn is. The panel adds no
// second instruction — a stage prompt that the driver appended to would be two briefs in one turn.
export function stagePrompt(task, pipeline, stage) {
  const detail = text(task && task.detail);
  return [
    text(stage && stage.prompt),
    "",
    `— ${pipeline.title}: stage ${stage.position} of ${pipeline.stages.length}, ${stage.title} (${pipeline.id}/${stage.id})`,
    `Queue task #${task.id}: ${task.title}`,
    ...(detail ? ["", detail] : []),
  ].join("\n");
}

// ---- reading the run --------------------------------------------------------------------------------------------
// The last run on a thread, the same way `settleTasks` reads it: so the driver and the settle can never disagree
// about which attempt they are judging.
function lastRunFor(thread, jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const runs = list
    .filter((job) => String(job && job.thread ? job.thread : "") === thread)
    .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  return runs[runs.length - 1] || null;
}

// Enter a stage through the record's own transition, and drop the keys that belonged to the edge just crossed: the
// gate wait and the start marker belong to the stage being left, not to the one being entered.
function moveTo(task, step, { at }) {
  const entered = enterStage(task, { stage: step.stage.id, enteredAt: isoOf(at), via: step.handoff ? step.handoff.id : null });
  const run = entered[TASK_PIPELINE_FIELD];
  if (!isObject(run)) return entered;
  const stale = [WAITING_FOR, STARTING_AT].filter((key) => Object.prototype.hasOwnProperty.call(run, key));
  if (!stale.length) return entered;
  const next = { ...run };
  for (const key of stale) delete next[key];
  return { ...entered, [TASK_PIPELINE_FIELD]: next };
}

// The clock as milliseconds, for the one comparison that is about elapsed time rather than a stored stamp.
function msOf(at) {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(String(at ?? ""));
  return Number.isFinite(ms) ? ms : Date.now();
}

// Park the row on the reason the pipeline stopped. A MANUAL hold, because a cap and a gate are decisions: the
// gate's own release is the driver's (below), and a cap has no world-state that could ever release it.
function parkRow(list, index, { reason, waitingFor = null, at }) {
  const task = list[index];
  const parked = setTaskState(list, task.id, "parked", { by: "panel", reason, at, hold: { kind: "manual" } });
  if (!parked) return null;
  list.splice(0, list.length, ...parked.tasks);
  let out = parked.task;
  const run = out[TASK_PIPELINE_FIELD];
  if (waitingFor && isObject(run)) out = { ...out, [TASK_PIPELINE_FIELD]: { ...run, [WAITING_FOR]: waitingFor } };
  list[index] = out;
  return out;
}

// ---- the driver -------------------------------------------------------------------------------------------------
// The bundle arrives in one of the two shapes the loader hands around: the loaded object (`readBundle(...).bundle`,
// which is what lib/task-pipeline.js resolves against) or the loader's own result (`{ok, bundle}`), which is what
// `queueMutate` and the catalogue route already pass each other. One reader for both, so a caller cannot hand the
// driver a wrapper by mistake and get "the bundle holds none" on a bundle that is fine.
export function loadedBundle(source) {
  if (isObject(source) && isObject(source.bundle) && source.ok === true) return source.bundle;
  if (isObject(source) && Array.isArray(source.pipelines)) return source;
  return null;
}

// One pass over one queue. Returns NEW rows, the transitions it made, the stage starts it wants and the notes it
// could not act on. The caller owns the file, the journal, the repaint and the spawn.
export function driveTaskPipelines(tasks, { bundle: source = null, jobs = [], isLive = () => false, at = new Date(), unattended = false } = {}) {
  const bundle = loadedBundle(source);
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const changed = [];
  const starts = [];
  const notes = [];

  const resolve = (task) => resolveTaskPipeline(task, { bundle, now: at });

  // 1. A parked row whose gate record has arrived crosses it. This runs FIRST because the record may have landed
  //    since the last pass, and a row released into `queued` without its stage moved would start the settled stage
  //    again — the one thing a gate must not do.
  for (let i = 0; i < list.length; i += 1) {
    const task = list[i];
    if (task.state !== "parked") continue;
    const run = isObject(task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
    const wait = run && isObject(run[WAITING_FOR]) ? run[WAITING_FOR] : null;
    if (!wait) continue;
    const record = decisionPathOf(wait.path, { worktree: task.worktree });
    if (!record.found) continue;
    const resolved = resolve(task);
    if (!resolved.ok) {
      notes.push({ id: task.id, code: DRIVE_FAULTS.UNRESOLVED, reason: resolved.reason });
      continue;
    }
    const pipeline = pipelineById(bundle, resolved.pipeline);
    const step = nextStageOf(pipeline, run, { worktree: task.worktree });
    if (!step.ok) {
      notes.push({ id: task.id, code: step.code, reason: step.reason });
      continue;
    }
    if (step.done) {
      notes.push({ id: task.id, code: DRIVE_FAULTS.UNRESOLVED, reason: `the gate record is there, but pipeline "${pipeline.id}" has nothing after ${run.stage}` });
      continue;
    }
    const released = setTaskState(list, task.id, "queued", { by: "panel", at, reason: `gate ${wait.gate} crossed by ${record.path}` });
    if (!released) continue;
    list.splice(0, list.length, ...released.tasks);
    list[i] = moveTo(released.task, step, { at });
    changed.push({
      id: task.id,
      title: task.title,
      thread: currentThread(task),
      from: "parked",
      to: "queued",
      stage: step.stage.id,
      why: `gate ${wait.gate} crossed by ${record.path} — the row moved to ${step.stage.id}`,
    });
  }

  // 2. A running row whose stage settled moves forward, parks, or finishes. Every branch below is a reason the row
  //    is not simply started again: the settle owns the run's end, and this pass is the one thing that reads it.
  for (let i = 0; i < list.length; i += 1) {
    const task = list[i];
    if (task.state !== "running") continue;
    const run = isObject(task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
    if (!run) continue; // rule 1: assistant-decides is not this module's row
    const thread = currentThread(task);
    if (!thread || isLive(thread)) continue;
    const last = lastRunFor(thread, jobs);
    if (!last) continue; // the job store cannot account for it: it reads stale, and nothing is invented
    const status = String(last.status || "").toLowerCase();

    if (FAILED_STATUS.has(status)) {
      const detail = text(last.finalMessage) || text(last.summary) || text(last.lastLine);
      const why = `stage ${run.stage} of ${run.pipeline} ended ${status}${detail ? `: ${detail}` : " with no final message"} — the pipeline waits for a decision rather than re-running the stage`;
      const parked = parkRow(list, i, { reason: why, at });
      if (parked) changed.push({ id: task.id, title: task.title, thread, from: "running", to: "parked", stage: run.stage, why });
      continue;
    }
    if (status !== "done") continue;

    const resolved = resolve(task);
    if (!resolved.ok) {
      notes.push({ id: task.id, code: DRIVE_FAULTS.UNRESOLVED, reason: resolved.reason });
      continue;
    }
    const pipeline = pipelineById(bundle, resolved.pipeline);
    const step = nextStageOf(pipeline, run, { worktree: task.worktree });
    if (!step.ok) {
      const parked = parkRow(list, i, {
        reason: step.reason,
        at,
        waitingFor: step.code === DRIVE_FAULTS.GATE ? { gate: step.gate.id, path: step.gate.decision.path, stage: run.stage, since: isoOf(at) } : null,
      });
      if (parked) changed.push({ id: task.id, title: task.title, thread, from: "running", to: "parked", stage: run.stage, why: step.reason });
      continue;
    }
    if (step.done) continue; // the last stage: the settle finishes the row, on the landing rule it has always had

    const why = `stage ${run.stage} settled — moved to ${step.stage.id} (${step.stage.position} of ${pipeline.stages.length}) of ${pipeline.id}`;
    const moved = setTaskState(list, task.id, "queued", { by: "panel", at, reason: why });
    if (!moved) continue;
    list.splice(0, list.length, ...moved.tasks);
    list[i] = moveTo(moved.task, step, { at });
    changed.push({ id: task.id, title: task.title, thread, from: "running", to: "queued", stage: step.stage.id, why });
  }

  // 3. The front of the queue, if it carries a pipeline and the reader allows unattended starts. A row with no
  //    pipeline is not started here and has no stage invented for it: that row is the assistant's to start, as it
  //    has always been.
  if (unattended) {
    const front = list.filter((task) => task.state === "queued" || task.state === "running").sort(byQueueOrder)[0] || null;
    if (front && front.state === "queued") {
      const run = isObject(front[TASK_PIPELINE_FIELD]) ? front[TASK_PIPELINE_FIELD] : null;
      if (run) {
        const asked = Date.parse(text(run[STARTING_AT]));
        const starting = Number.isFinite(asked) && msOf(at) - asked < START_GRACE_MS;
        const resolved = resolve(front);
        if (starting) {
          notes.push({ id: front.id, code: DRIVE_FAULTS.STARTING, reason: `stage ${run.stage} was started ${Math.round((msOf(at) - asked) / 1000)}s ago and its run has not linked yet — a second start is not asked for` });
        } else if (!resolved.ok) {
          notes.push({ id: front.id, code: DRIVE_FAULTS.UNRESOLVED, reason: resolved.reason });
        } else {
          const pipeline = pipelineById(bundle, resolved.pipeline);
          const stage = stageById(pipeline, resolved.stage);
          const tree = text(front.worktree);
          const project = text(front.project);
          const prompt = stagePrompt(front, pipeline, stage);
          if (!prompt.trim() || !text(stage.prompt)) {
            notes.push({ id: front.id, code: DRIVE_FAULTS.UNRESOLVED, reason: `stage ${stage.id} of ${pipeline.id} has no prompt to hand a worker` });
          } else if (!tree && !project) {
            const reason = `#${front.id} is on ${pipeline.id} · ${stage.id} and names neither a tree nor a project — there is nowhere to start its stage`;
            const parked = parkRow(list, list.indexOf(front), { reason, at });
            if (parked) {
              changed.push({ id: front.id, title: front.title, thread: currentThread(front), from: "queued", to: "parked", stage: stage.id, why: reason });
              notes.push({ id: front.id, code: DRIVE_FAULTS.NO_TARGET, reason });
            }
          } else {
            starts.push({
              taskId: front.id,
              pipeline: pipeline.id,
              stage: stage.id,
              position: stage.position,
              count: pipeline.stages.length,
              title: front.title,
              prompt,
              target: tree || project,
              existing: Boolean(tree),
              project: project || null,
            });
            // The marker is written with the row, BEFORE the caller starts anything: it is what the next pass reads to
            // know this stage already has a start in flight.
            list[list.indexOf(front)] = { ...front, [TASK_PIPELINE_FIELD]: { ...run, [STARTING_AT]: isoOf(at) } };
          }
        }
      }
    }
  }

  return { tasks: list, changed, starts, notes };
}
