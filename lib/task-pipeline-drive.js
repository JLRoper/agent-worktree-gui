// Driving a task THROUGH its pipeline, one stage at a time.
//
// lib/task-pipeline.js says where a task is on a pipeline; lib/task-pipeline-assign.js says how it was put there.
// Neither starts anything. Until this module, a `pipelineRun` on a queue row was a label: the window drew the stage,
// and the work never left the stage the reader chose. This is the driver — the one reader that turns the record into
// the next turn, and the only writer that moves a row forward because a stage SETTLED rather than because a person
// said so.
//
// Nine rules decide its shape:
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
//      how a row advances under a live worker. The one stage whose exit is NOT its run is the review wait: its fact
//      is the pull request, read by the timer and stamped on the tree's record, so this module asks for that read
//      (`reviewOf`) instead of trusting the run's `done` - a run that ends with nothing newer than lastSeen has not
//      crossed the exit, and a PR that reads DECLINED can never cross it (rule 9).
//   3. The pipeline's own graph decides the next stage, and the RAIL wins over a back edge. The handoffs leaving a
//      stage are taken in KIND order — `sequence`, then `return`, then `loop` — not in the document's order, because
//      a stage with two ways out is a two-outcome gate (the seed's S9: H-10 back to S8, H-11 on to S10) and an
//      un-routed gate has no value the panel may read, so it cannot choose by outcome. The first edge in the document
//      made the loop shadow the sequence: the seed's task oscillated S8↔S9 until its cap and S10-S12 were
//      unreachable, while the drawing showed them one column along and joined to S9. The sequence is the edge the
//      picture draws and the edge that lets a pipeline finish; a loop is taken when it is a stage's only way out,
//      which is the shape its cap was written for. When a stage draws no edge, the next stage in the reading order;
//      when neither exists the pipeline is over. The row is then finished by whichever rule ITS last stage earned:
//      a stage whose declared artifact is a pull request (`kind: "pr"`) is left to the settle's landing rule — the
//      PR must read MERGED — and a stage that declares any other artifact (a document, a report, a build) has no PR
//      to read at all, so the driver settles that row HERE on the stage's own verdict. A row left to the landing
//      rule with no PR would stay `running` for ever, which reads on the board as work still in flight. A stage is
//      never taken from outside the pipeline: every id here came out of the bundle's own order or handoffs.
//
//      The one exception is a gate whose decision declares `routes`: a map from an outcome to a handoff id (or to
//      null, "the pipeline ends here"). Then the document, not the kind order, says where the verdict sends the row —
//      the seat decides, the graph routes, and the panel only checks that the word is one the gate declared. A route
//      to null is how a loop ENDS: the last stage of a converging pipeline settles `done`, the verdict says the work
//      is at the bar, and there is no edge to charge and no stage to re-enter.
//
//      A gate anchored after the LAST stage is named in the answer (`closing`) and is NOT a barrier when it has no
//      edge out: there is no edge out of the last stage for it to guard and no stage for it to release the row into,
//      so a row that has settled there is finished by the settle rather than parked on a record that could not change
//      where it goes. The drawing marks that notch `closing` for the same reason — the two readers agree about the
//      object. (A last stage whose only edge out is a loop DOES have an edge: that gate is a barrier, and its verdict
//      is what ends the loop.)
//   4. A loop's cap is a count of CROSSINGS, kept on the record (`pipelineRun.crossings`) rather than in a process,
//      because a panel restart is the one thing a loop must survive. `cap: "3 rounds"` allows three crossings of that
//      edge; a fourth is refused and the row parks. The VERDICT is read before the cap: an outcome the document
//      routes nowhere ends the loop without a crossing, and the cap charges every loop that has not converged. A cap
//      that cannot be read as a whole number is not treated as "unlimited": an uncapped loop is not crossed at all,
//      the same fail-closed rule lib/pipelines.js applies to an exit check it cannot evaluate.
//   5. A gate that declares a decision record is a BARRIER, crossed only by that record. When a gate sits after the
//      settled stage and carries a `decision`, the driver looks for the decision's own file in the task's tree and
//      does nothing else: the panel never writes the record and never lets the code decide a question the studio put
//      in front of a seat. The row parks on that path, and the record's arrival is the only thing that moves it — the
//      driver releases its own park, so the crossing is the file, not a press.
//
//      The record's `outcome` is read ONLY when the gate's document declares `routes`, and then only to pick the edge
//      the document itself mapped (rule 3). An outcome the gate does not declare, a record that is not JSON, or one
//      with no `outcome` at all is `pipeline-verdict`: the panel stops rather than guessing an edge, because a guess
//      is how a verdict would end a loop the document never said was over.
//   6. A failed run parks the row for a decision. Re-starting a stage that died is how one bad turn becomes an
//      unbounded retry loop with nobody reading it; the park says which stage died and why, and a person requeues it.
//   7. Unattended starts are the READER's switch, passed in as `unattended` (the Assistant's `spawn: "auto"`), never
//      assumed here. With the switch off the row still advances and waits, and the starts list is empty — the work is
//      not lost, it is simply not started by a panel the reader told to ask first.
//   8. Nothing here writes. The queue file, the journal and the repaint belong to the Assistant's `sweepQueues`,
//      which hands the returned rows to ONE `writeQueueFile` and the returned starts to `startSpawn`. A driver that
//      wrote would be a second door into a queue whose every write is journalled exactly once.
//   9. A pull request that has ENDED ends the walk. When the stage being left draws a review exit and the panel's own
//      read says the PR is DECLINED (or CLOSED without a merge), the answer that exit waits for can never arrive:
//      `nextStageOf` refuses with `pipeline-declined`, the row parks on the read (the host's word and the check that
//      was being waited on, in its reason), no later stage is entered and nothing is dispatched. Row 67 walked
//      wait -> approve -> merge on exactly this read. A read that could NOT be made is not this case - fail-closed
//      keeps the row where it is - and a MERGED PR belongs to the landing rule, not here.
//
// The row that reaches the front of the queue is the one that starts. "Front" is the queue's own order
// (`byQueueOrder`) over the rows that can move — queued and running — so a pipeline row behind a queued row with no
//
// THIS FILE IS NOW THE DRIVER ALONE. The pipeline document - the graph, the manifest, the fingerprint, the gate's
// record and the verdict - lives in lib/task-pipeline-document.js, and the tree a stage writes in with the brief it
// is handed lives in lib/task-pipeline-tree.js. Both are re-exported below, so every import site still reads this
// path, and the run reading and the walk itself are what stayed. The ranges and the proof are in
// docs/reports/task-pipeline-drive-cut-2026-11-28.html.

import path from "node:path";

import { byQueueOrder, currentThread, setTaskState } from "./assistant/queue.js";
import { pipelineById, stageById } from "./pipeline-bundle.js";
import { aggregateBranchesOf, isolationOf } from "./pipeline-fanout.js";
import { commitOf, pinCheck, pinOf, relInTree, withStagePinReader } from "./stage-pin.js";
import { HOLD_OWNER_MS, isRunWait, waitKind } from "./pipelines.js";
import { TASK_PIPELINE_FIELD, beginStageRun, enterStage, recordStageDecision, resolveTaskPipeline, settleStageRun, stageRunFor, stageRunsOf, visitOf } from "./task-pipeline.js";
import {
  DRIVE_FAULTS,
  STARTING_AT,
  START_GRACE_MS,
  WAITING_FOR,
  artifactOf,
  artifactTreeOf,
  artifactValues,
  decisionOf,
  decisionPathOf,
  edgeOutOf,
  handedOnPinOf,
  inputManifest,
  isObject,
  isoOf,
  landsAsPr,
  nextStageOf,
  routingFingerprint,
  settledArtifactOf,
  text,
  treeFactsRecord,
} from "./task-pipeline-document.js";
import {
  assemblyPlanOf,
  claimAgainst,
  fanOutStateOf,
  filedTreeOf,
  roundLandingOf,
  roundOf,
  stagePrompt,
  stageTreeLookup,
  treeClaims,
  treeKey,
  treeLookup,
} from "./task-pipeline-tree.js";

// Every name this file published before the split, from the two modules that hold it now. A caller reads the same
// name from the same path, and the two modules' own internals stay off this surface.
export {
  ARTIFACT_HASH_MAX, DECISION_TRIGGERS, DRIVE_FAULTS, EDGE_ORDER,
  INPUTS_MAX, PR_ARTIFACT_KIND, STARTING_AT, START_GRACE_MS,
  WAITING_FOR, artifactOf, artifactPathOf, artifactValues,
  capOf, capWakeLine, decisionOf, decisionPathOf,
  declaredArtifactOf, edgeOutOf, fillHoles, gateAfter,
  handedOnPinOf, inputManifest, nextStageOf, recordedStageTree,
  renderDecision, reviewEdgeOutOf, reviewReadAt, routeFor,
  routingFingerprint, stageInputsOf, treeRecordOf, verdictOf,
  writerArtifactOf,
} from "./task-pipeline-document.js";
export {
  STAGE_TOOLS_LINE, assemblyPlanOf, fanOutStateOf, filedTreeOf,
  roundOf, stagePrompt, stageTreeLookup, treeClaims,
  treeLookup,
} from "./task-pipeline-tree.js";

const FAILED_STATUS = new Set(["failed", "error", "cancelled", "canceled", "stopped", "exited", "interrupted", "timeout"]);

// Enter a stage through the record's own transition, and drop the keys that belonged to the edge just crossed: the
// gate wait and the start marker belong to the stage being left, not to the one being entered.
function moveTo(task, step, { at, pipeline = null, tree = null }) {
  const entered = enterStage(task, {
    stage: step.stage.id,
    enteredAt: isoOf(at),
    via: step.handoff ? step.handoff.id : null,
    route: pipeline ? routingFingerprint(pipeline) : null,
  });
  const run = entered[TASK_PIPELINE_FIELD];
  if (!isObject(run)) return entered;
  const next = { ...run };
  for (const key of [WAITING_FOR, STARTING_AT]) if (Object.prototype.hasOwnProperty.call(next, key)) delete next[key];
  // `via` is the edge the row arrived by, carried on the record so the drawing and the next stage's inputs block can
  // name it without reconstructing it from the crossings.
  if (step.handoff && text(step.handoff.id)) next.via = text(step.handoff.id);
  // The row's tree is written AT THE CUT and never re-cut (§3.4). A move carries the same pointer forward; it is the
  // one fact about a later stage that the earlier visits proved.
  if (tree && text(tree.path) && !isObject(next.tree)) next.tree = tree;
  return { ...entered, [TASK_PIPELINE_FIELD]: next };
}

// The clock as milliseconds, for the one comparison that is about elapsed time rather than a stored stamp.
function msOf(at) {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(String(at ?? ""));
  return Number.isFinite(ms) ? ms : Date.now();
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

// The stage run a row is standing on when it has SETTLED and nobody has read the settle yet.
//
// A row can be left `queued` over a settled stage: the reader requeued it, a restart lost the link, a pass wrote the
// move but could not ask for the start. The settle is a fact on the row's OWN ledger, and the driver reads it there —
// starting the stage again runs the same work twice and never advances the graph, which is the one move a pipeline
// must not make at a boundary. The marker is the decision: the driver writes one on the entry the moment it reads the
// settle (§6.2), so `status: done` with no decision is precisely "settled, unread". A failed run is deliberately not
// this shape — the retry path owns it, and a park on every requeued failure would be a second reader of that rule.
function unreadSettle(task) {
  const run = isObject(task) && isObject(task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
  if (!run || !text(run.stage)) return null;
  const entry = stageRunFor(run, { stage: run.stage });
  if (!entry || text(entry.status) !== "done" || entry.decision) return null;
  return entry;
}

// Is this row's advance still the BOOK's to make?
//
// The hold lives on the tree's pipeline record (`pipelineWait.kind: "run"`), written by the cut and stamped when the run
// settles. While it is in force — same stage, same visit, inside the first-refusal window — the panel's timer reads the
// settle and moves the row; this driver pass is the FALLBACK and must not move it too. Two owners starting one stage is
// exactly the double-advance the brief names.
//
// The window matters: a hold whose owner never came back (a panel killed with its ticker) must not strand the row, so
// past `HOLD_OWNER_MS` from the settle the driver takes the row back. A hold for a DIFFERENT stage or visit is the next
// stage's cut already, and this row is not the one it is holding.
function heldByBook(task, run, { waits, at }) {
  if (typeof waits !== "function") return false;
  // The CURRENT stage's tree first: under one tree per stage the row's own `tree` is the first stage's, and the wait
  // this stage's settle stamped lives on the tree that stage ran in (lib/jobs.js `registerPipelineWait`).
  const current = stageRunFor(run, { stage: text(run && run.stage) });
  const treePath = text(current && current.tree && current.tree.path) || text(run && run.tree && run.tree.path) || text(task && task.worktree);
  if (!treePath) return false;
  const wait = waits(treePath);
  // THE BOOK OWNS A REVIEW-WAIT STAGE TOO, and with no first-refusal window. A run hold is a sentence about a run, so
  // after its window the driver reads the run itself and advances; a REVIEW wait is a sentence about a pull request
  // no run can answer, and the timer is its only reader. Advancing on the run's `done` instead is the walk row 67
  // recorded: the stage ended, nothing said the reviewer's exit fired, and the driver entered approve anyway. There is
  // no fact behind that advance to fall back on, so there is no window - the stage waits for the answer it declared.
  if (waitKind(wait) === "review") {
    if (text(wait.stage) !== text(run.stage)) return false;
    const document = text(wait.pipeline);
    if (document && text(run.pipeline) && document !== text(run.pipeline)) return false;
    return true;
  }
  if (!isRunWait(wait)) return false;
  if (text(wait.stage) !== text(run.stage)) return false;
  const visit = visitOf(run, run.stage);
  if (wait.visit != null && Number(wait.visit) !== Number(visit)) return false;
  const stamp = Date.parse(String(wait.settledAt || wait.at || ""));
  if (!Number.isFinite(stamp)) return false;
  const now = at instanceof Date ? at.getTime() : Date.parse(String(at));
  return Number.isFinite(now) ? now <= stamp + HOLD_OWNER_MS : false;
}

// Park the row on the reason the pipeline stopped, and write the DECISION on the stage run it is about. A MANUAL hold,
// because a cap and a gate are decisions: the gate's own release is the driver's, and a cap's release is the reader's
// (§6.4) — nothing the panel can test ever releases one.
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

// The artifact a stage declares, resolved against the tree the row ran in. `checked` is false when the row has no
// tree: the panel resolves against a tree, and a row in its project has nowhere to resolve (§5.3) — it records that
// it could not check rather than inventing a park.
//
// The artifact's WORKING file is what `present` and `sha256` describe (the file the stage wrote, before it committed
// anything). The PIN is what the next stage is handed: `commit` (the tree's HEAD at settle), the blob's object id, and
// the sha256 of the BLOB's own bytes. A stage that settled with an uncommitted artifact still records its commit and
// says the file is not in it — `blob: null` — rather than pinning nothing and leaving the next stage to read a branch.
function artifactCheck(stage, task, run, facts, { commit = null, tree = null, treePath = null } = {}) {
  const declared = isObject(stage && stage.artifact) ? stage.artifact : null;
  if (!declared) return { checked: false, artifact: null };
  // The tree this stage WROTE in, never the tree the row happens to be pointed at: its own record, then the workspace
  // its worker ran in, and only then the caller's answer and the row's tree. A stage that wrote its artifact in its
  // own tree is not refused on a parent checkout's behalf (§5.3, #260).
  const own = artifactTreeOf(run, stage && stage.id, [task && task.worktree, tree, run && run.tree && run.tree.path]);
  const where = text(treePath) || own.path;
  if (!where) return { checked: false, artifact: { id: text(declared.id) || null, path: text(declared.path) || null, present: null, sha256: null } };
  // The ROUND this visit is in, as a hole value: `out/{{run_id}}/r{{round}}/x.json` is r7's file on visit 7, and the
  // matcher's first-sorted fallback (r1) is what made seven visits record one hash while seven files sat on disk.
  const values = artifactValues(run, stage.id);
  // The read is pinned to the commit the record names when the working file is not there: the artifact is known to
  // exist in that commit, and a tree that has moved since must not turn the stage's own output into someone else's
  // file. A settle that measured the tree's HEAD supplies a fresher one, which wins.
  const found = artifactOf(declared, { worktree: where, values, commit: commit || own.commit });
  // The previous visit's hash, when this stage is a second entry: identical bytes are recorded `unchanged`, which is a
  // visible fact and not a park (§7.7).
  let unchanged = false;
  if (found && found.present && found.sha256) {
    const earlier = [...stageRunsOf(run)]
      .reverse()
      .find((entry) => text(entry.stage) === text(stage.id) && Number(entry.visit) < visitOf(run, stage.id) && isObject(entry.artifact) && entry.artifact.sha256 === found.sha256);
    unchanged = Boolean(earlier);
  }
  // The file the pattern resolved to, tree-relative: the pin is taken against THAT, never against the declaration,
  // because `git rev-parse <commit>:./out/{{run_id}}/r{{round}}/x.json` names no object and would record every visit
  // as uncommitted work.
  const file = found ? found.file || (found.shown ? relInTree(where, found.shown) : null) : null;
  // The PIN is taken at the commit the settle MEASURED (`commit`), never at a commit the record names: a pin is a
  // promise the next stage can `git show` it, and a record's commit is not verifiable in this tree (a fixture or a
  // tree whose HEAD moved records a sha this checkout never had). With no measured commit there is no pin.
  const pin = found && found.present ? pinOf(where, file || text(declared.path), { commit }) : null;
  return {
    checked: true,
    unchanged,
    artifact: {
      id: text(declared.id) || null,
      path: text(declared.path) || null,
      present: Boolean(found && found.present),
      sha256: found && found.sha256 ? found.sha256 : null,
      ...(file && file !== text(declared.path) ? { file } : {}),
      // The pin names the commit even when the file is not in it, because "the artifact is uncommitted work" is a
      // fact about the handoff and the next stage must be able to see it (and be refused if the branch then moves).
      ...(pin ? { commit: pin.commit } : {}),
      ...(pin && pin.blob ? { blob: pin.blob, blobSha256: pin.sha256 || null } : {}),
      ...(pin && pin.tooLarge ? { tooLarge: true } : {}),
      ...(pin && !pin.blob && pin.commit ? { uncommitted: true } : {}),
      ...(unchanged ? { unchanged: true } : {}),
      ...(found && found.tooLarge ? { tooLarge: true } : {}),
    },
  };
}

// The two releases a park needs (§6.4). Both are the READER's, because both are a decision: the panel does not quietly
// forgive a cap it just enforced, and it does not re-stamp a routing fingerprint it just proofed. Without the cap's
// reset a requeue re-parks on the very next pass — the count is compared as `used + 1 > limit`, and a requeue never
// touches it. That is the defect this function exists to name.
export function releaseCapPark(task, { at = new Date().toISOString() } = {}) {
  const run = isObject(task && task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
  const wait = run && isObject(run[WAITING_FOR]) ? run[WAITING_FOR] : null;
  if (!run || !wait || text(wait.kind) !== "cap" || !text(wait.edge)) return null;
  const was = Number(isObject(run.crossings) ? run.crossings[wait.edge] : 0) || 0;
  const crossings = { ...(isObject(run.crossings) ? run.crossings : {}) };
  crossings[wait.edge] = 0;
  const next = { ...run, crossings };
  delete next[WAITING_FOR];
  delete next[STARTING_AT];
  const released = { ...task, [TASK_PIPELINE_FIELD]: next };
  const decision = decisionOf({
    code: null,
    trigger: "cap",
    by: "reader",
    at,
    fact: { kind: "cap-release", edge: text(wait.edge), from: text(wait.from), to: text(wait.to), was },
  });
  return { task: recordStageDecision(released, decision), reason: decision.reason };
}

// The other release: acknowledge a re-exported bundle by re-stamping the fingerprint at the stage the row is in, and
// move nothing else.
export function restampRoutePark(task, { route, at = new Date().toISOString() } = {}) {
  const run = isObject(task && task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
  if (!run || !text(route)) return null;
  const from = text(run.route) || null;
  const next = { ...run, route: text(route) };
  delete next[WAITING_FOR];
  const restamped = { ...task, [TASK_PIPELINE_FIELD]: next };
  const decision = decisionOf({
    code: null,
    trigger: "changed",
    by: "reader",
    at,
    fact: { kind: "route-restamp", from, to: text(route) },
  });
  return { task: recordStageDecision(restamped, decision), reason: decision.reason };
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

// One pass over one queue. Returns NEW rows, the transitions it made, the stage starts it wants, the tree cuts it
// wants (`ensureTree`) and the notes it could not act on. The caller owns the file, the journal, the repaint, the cut
// and the spawn.
export function driveTaskPipelines(tasks, options = {}) {
  return withStagePinReader(options.pinReader, () => driveTaskPipelinesPass(tasks, options));
}

function driveTaskPipelinesPass(tasks, { bundle: source = null, jobs = [], isLive = () => false, at = new Date(), unattended = false, claims = [], treeOf = null, waitFor = null, reviewOf = null } = {}) {
  const bundle = loadedBundle(source);
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const changed = [];
  const starts = [];
  const ensureTree = [];
  // The merges a fan-out owes: the join's tree is ready and the lanes must be combined before its agent starts. Like
  // every other request this module returns, it is performed by the Assistant — the driver writes nothing and git
  // lives in lib/pipeline-aggregate.js.
  const aggregates = [];
  // The ONE branch a finished per-stage round owes (lib/pipeline-assembly.js): every stage run's commit, cherry-picked
  // in visit order onto a branch cut from the round's frozen parent. Also the Assistant's to perform - this module
  // writes nothing and git lives in the assembler.
  const assemblies = [];
  const notes = [];
  // The rows whose STAGE RUN was written this pass without the row moving: a stage that settled onto the end of the
  // pipeline (or onto a verdict that ended it) changes no state, but its ledger entry IS the record of the run. The
  // caller writes the queue file for these too — a settle that only lives in this process is lost on the next read.
  const settledIds = [];

  const resolve = (task) => resolveTaskPipeline(task, { bundle, now: at });
  const factsFor = (treePath) => (typeof treeOf === "function" && text(treePath) ? treeOf(text(treePath)) : null);
  // The evidence `treeLookup` may read for a row that has NOT started: the pipeline's isolation (a per-stage round
  // always cuts its own children) and the panel's own git read of the tree the row was filed with. `filedTreeOf`
  // answers null when either is missing, so a driver built by a test keeps the old rule and asks for the cut.
  const treeOptions = (pipeline) => ({ treeOf, isolation: isolationOf(pipeline) });
  // The wait the BOOK holds for a tree, asked only by the row that would otherwise advance. A tree path is the key: the
  // hold lives in the tree's own durable pipeline record (lib/jobs.js `pipelineRecordFor`), not on the row.
  const waits = (treePath) => (typeof waitFor === "function" && text(treePath) ? waitFor(text(treePath)) : null);
  // The panel's last READ of the pull request at a tree's stage, asked only where an advance is about to be taken. The
  // timer is the reader (lib/jobs.js `checkPipelineWait` -> `recordReviewRead`); this is the same fact, so the two
  // owners of one advance cannot disagree about whether the reviewer's exit fired - or about the host having ENDED the
  // pull request, which is what ends the walk instead of entering the stage after it.
  const reviewed = (treePath, stage, run) =>
    typeof reviewOf === "function" && text(treePath) && isObject(stage)
      ? reviewOf({ tree: text(treePath), stage, run })
      : null;
  // Every open row in this queue plus whatever the caller says the other queues hold: one map, so two rows in one tree
  // are found whichever file they live in.
  const claimsMap = treeClaims([...list, ...(Array.isArray(claims) ? claims : [])]);

  // Park with a decision: one sentence for the row, the stage run and the journal, rendered from one fact.
  //
  // `settle` is for a park whose FACT is a finished run: that run's status, the clock it was read at and the
  // thread/job that ran it go on the entry in the SAME call as the decision, so a parked row can describe the run it
  // parked on. Without it a park writes the decision and leaves `status: null`, which reads as a run that never
  // ended. A park on a gate record, a route or a cap passes no settle: there is no run of its own to describe.
  const stop = (index, { code, trigger = "stage-settled", fact, waitingFor = null, by = "panel", settle = null }) => {
    const decision = decisionOf({ code, trigger, by, at: isoOf(at), fact });
    const task = list[index];
    const parked = parkRow(list, index, { reason: decision.reason, waitingFor, at });
    if (!parked) return null;
    const run = isObject(task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
    const withDecision = settle
      ? settleStageRun(parked, {
          stage: text(run && run.stage) || null,
          thread: settle.thread ?? null,
          job: settle.job ?? null,
          status: settle.status ?? null,
          at: settle.at || isoOf(at),
          decision,
        })
      : recordStageDecision(parked, decision);
    list[index] = withDecision;
    changed.push({ id: task.id, title: task.title, thread: currentThread(task), from: String(task.state || ""), to: "parked", stage: text(task[TASK_PIPELINE_FIELD] && task[TASK_PIPELINE_FIELD].stage), why: decision.reason, code });
    return withDecision;
  };

  // The end of a pipeline whose last stage has no PR to land, and the write that settles it. The stage's own verdict IS
  // the record the row already has: its run ended done, its artifact is in the tree and the graph has no edge left — a
  // landing can add nothing, and waiting for one holds the row open for ever (the defect the gated walk found, where a
  // docs-only or sandbox stage left its row `running` with nothing saying the work was finished). `waitingFor` is
  // cleared in the same write: a row that is finished is not waiting on anything.
  const overReason = (pipeline, stage, run) =>
    `pipeline ${pipeline.id} is over at ${run.stage} — its artifact "${stage.artifact.id}" (${stage.artifact.schema}, kind ${stage.artifact.kind || "unstated"}) is not a PR to land, so the row settles on the stage's own verdict`;
  const finish = (index, { reason }) => {
    const task = list[index];
    const out = setTaskState(list, task.id, "done", { by: "panel", at, reason });
    if (!out) return false;
    list.splice(0, list.length, ...out.tasks);
    const run = isObject(out.task[TASK_PIPELINE_FIELD]) ? out.task[TASK_PIPELINE_FIELD] : null;
    list[index] = run ? { ...out.task, [TASK_PIPELINE_FIELD]: { ...run, [WAITING_FOR]: null } } : out.task;
    changed.push({ id: task.id, title: task.title, thread: currentThread(task), from: String(task.state || ""), to: "done", stage: text(run && run.stage), why: reason });
    return true;
  };

  // 1. A parked row whose gate record has arrived crosses it. This runs FIRST because the record may have landed
  //    since the last pass, and a row released into `queued` without its stage moved would start the settled stage
  //    again — the one thing a gate must not do. The gate is ASKED AGAIN on every pass: the path is re-resolved
  //    against this visit's round, so last round's record cannot release this round's park.
  for (let i = 0; i < list.length; i += 1) {
    const task = list[i];
    if (task.state !== "parked") continue;
    const run = isObject(task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
    const wait = run && isObject(run[WAITING_FOR]) ? run[WAITING_FOR] : null;
    if (!wait) continue;
    // A cap or a fingerprint park has no world-state that could release it: its release is a queue action (§6.4).
    if (text(wait.kind) && text(wait.kind) !== "gate") continue;
    const record = decisionPathOf(wait.path, { worktree: task.worktree, values: artifactValues(run, run.stage) });
    if (!record.found) continue;
    const resolved = resolve(task);
    if (!resolved.ok) {
      stop(i, { code: DRIVE_FAULTS.UNRESOLVED, trigger: "unresolved", fact: { kind: "record", reason: resolved.reason, stage: run.stage, pipeline: run.pipeline } });
      continue;
    }
    const pipeline = pipelineById(bundle, resolved.pipeline);
    const step = nextStageOf(pipeline, run, { worktree: treeLookup(task).path || task.worktree });
    if (!step.ok) {
      // A gate that is still waiting, or a record still naming an outcome nothing routes, is a state the row already
      // parks on: re-noting it every few seconds would be noise, and the repair is the record itself.
      if (step.code === DRIVE_FAULTS.GATE || step.code === DRIVE_FAULTS.VERDICT) continue;
      notes.push({ id: task.id, code: step.code, reason: step.reason });
      continue;
    }
    if (step.done) {
      // The record arrived and its verdict routes nowhere: the pipeline is over. Releasing the row into `queued`
      // would restart the stage it already finished, so it goes back to `running` with its own thread and the settle
      // finishes it on the landing rule — the same end state the un-parked path reaches.
      if (step.verdict) {
        const closed = decisionOf({
          code: null,
          trigger: "verdict",
          at: isoOf(at),
          fact: {
            kind: "verdict",
            gate: step.verdict.gate,
            path: step.verdict.path,
            outcome: step.verdict.outcome,
            handoff: step.verdict.handoff,
            edge: step.verdict.edge,
            from: step.verdict.from,
            to: step.verdict.to,
            ended: true,
            stage: run.stage,
            pipeline: run.pipeline,
          },
        });
        // The record ended the pipeline. A stage with no PR to land is FINISHED here, with the verdict as its last
        // decision, rather than released into `running` for a landing rule that can never be satisfied.
        const overStage = stageById(pipeline, run.stage);
        if (overStage && !landsAsPr(overStage)) {
          if (!finish(i, { reason: overReason(pipeline, overStage, run) })) continue;
          list[i] = recordStageDecision(list[i], closed);
          continue;
        }
        const unfastened = setTaskState(list, task.id, "running", { by: "panel", at, reason: closed.reason, hold: null });
        if (!unfastened) continue;
        list.splice(0, list.length, ...unfastened.tasks);
        list[i] = recordStageDecision(unfastened.task, closed);
        changed.push({ id: task.id, title: task.title, thread: currentThread(task), from: "parked", to: "running", stage: run.stage, why: closed.reason });
        continue;
      }
      notes.push({ id: task.id, code: DRIVE_FAULTS.UNRESOLVED, reason: `the gate record is there, but pipeline "${pipeline.id}" has nothing after ${run.stage}` });
      continue;
    }
    const crossed = decisionOf({
      code: null,
      trigger: "gate-record",
      at: isoOf(at),
      fact: { kind: "gate", gate: wait.gate, path: record.shown, present: true, stage: run.stage, pipeline: run.pipeline },
    });
    const released = setTaskState(list, task.id, "queued", { by: "panel", at, reason: `gate ${wait.gate} crossed by ${record.path}` });
    if (!released) continue;
    list.splice(0, list.length, ...released.tasks);
    const settledRun = recordStageDecision(released.task, crossed);
    list[i] = moveTo(settledRun, step, { at, pipeline });
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

  // 2. A row whose stage settled moves forward, parks, or finishes. Every branch below is a reason the row is not
  //    simply started again: the settle owns the run's end, and this pass is the one thing that reads it.
  //
  //    A `queued` row is read here too, when its ledger says the stage it stands on SETTLED and no decision has been
  //    written on that entry yet (`unreadSettle`). That row is the leftover of a boundary: whatever put it back in the
  //    queue did not clear the stage record, and step 3's start would run the stage a second time while the graph
  //    never moves — the stall that needs a hand-start at every boundary. The rest of the pass is the same code, so a
  //    cap, a gate, an artifact or a refusal still parks it.
  for (let i = 0; i < list.length; i += 1) {
    const task = list[i];
    const leftover = task.state === "queued" ? unreadSettle(task) : null;
    if (task.state !== "running" && !leftover) continue;
    const run = isObject(task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
    if (!run) continue; // rule 1: assistant-decides is not this module's row
    // 2a. THE BOOK OWNS THIS ROW WHILE IT HOLDS IT. A stage whose run was cut is held in the tree's pipeline record
    //     (`pipelineWait.kind: "run"`, lib/jobs.js `holdPipelineStageRun`), and the panel's own timer reads the settle
    //     and advances the row. This pass is the FALLBACK, not the second owner: it takes the row back only when the
    //     hold is gone, names another stage, or is older than the first-refusal window — a panel whose ticker died must
    //     not leave a settled row waiting for a clock nobody restarts.
    if (heldByBook(task, run, { waits, at })) continue;
    // The thread that carries THIS stage run: the one the link wrote on the entry when the worker was cut, because
    // that is the run whose status settles the stage. `currentThread` is the fallback for an entry that is already
    // settled, or that never had a thread written (a record from before the link stamped one). Reading the row's
    // newest thread alone is what settled 18 later stages on `loop-20` — a finished job — while their own workers ran:
    // the thread list is capped, and the cap used to drop the thread carrying the row.
    const own = stageRunFor(run, { stage: run.stage });
    const thread = (!own || text(own.status) ? "" : text(own.thread)) || currentThread(task);
    if (!thread || isLive(thread)) continue;
    const last = lastRunFor(thread, jobs);
    // A leftover already knows its settle from the ledger; the job store's card can age out of the board, and its
    // absence is not a reason to run the stage again. A `running` row without a job is still left alone: there the
    // facts do not support any move.
    if (!last && !leftover) continue;
    const status = String((last && last.status) || (leftover && leftover.status) || "").toLowerCase();
    const detail = text(last && (last.finalMessage || last.summary || last.lastLine));
    // The four facts that describe the run every park below parks on: what it ended as, the clock this pass read it
    // at, and the thread and job that carried it. They are written on the entry in the SAME call as the decision, so
    // a parked row can say which run it parked on and how that run ended. A park carrying only the decision leaves
    // the entry reading `status: null`, which reads as a run that never ended.
    const runSettle = { status, thread, job: text(last && last.id) || null, at: isoOf(at) };

    if (FAILED_STATUS.has(status)) {
      stop(i, {
        code: DRIVE_FAULTS.FAILED,
        fact: { kind: "run-status", status, detail: detail || null, stage: run.stage, pipeline: run.pipeline, thread },
        // The park is ABOUT a finished run, so the run is settled in the same call: its status, the clock this pass
        // read it at, and the thread and job that ran it. A park carrying only the decision leaves the entry reading
        // `status: null` and cannot say which run it parked on.
        settle: runSettle,
      });
      continue;
    }
    if (status !== "done") continue;

    // What settled: the record, the graph, the tree and the artifact. The artifact is checked BEFORE the graph because
    // it is the stage's own output; an absent one is the design's one new hard gate (§5.3).
    const resolved = resolve(task);
    if (!resolved.ok) {
      stop(i, {
        code: DRIVE_FAULTS.UNRESOLVED,
        trigger: "unresolved",
        fact: { kind: "record", reason: resolved.reason, stage: run.stage, pipeline: run.pipeline },
        // The record could not be read, but the RUN it names finished: the park settles that run beside the decision.
        settle: runSettle,
      });
      continue;
    }
    const pipeline = pipelineById(bundle, resolved.pipeline);
    // The stage that settled ran in ITS tree — a lane's own under `per-stage`, the row's otherwise — so the artifact,
    // the commit and the pin are all resolved there and not against whatever tree the row is pointed at afterwards.
    const plan = fanOutStateOf(pipeline, run);
    const tree = stageTreeLookup(task, pipeline, run, treeOptions(pipeline));
    if (tree.lost) {
      stop(i, {
        code: DRIVE_FAULTS.TREE_GONE,
        trigger: "tree",
        fact: { kind: "tree", code: DRIVE_FAULTS.TREE_GONE, path: tree.lost.path, lastStage: tree.lost.stage, stage: run.stage, pipeline: run.pipeline },
        // The tree is gone, but the run that used it finished: the park settles that run beside the decision.
        settle: runSettle,
      });
      continue;
    }
    const now = routingFingerprint(pipeline);
    if (text(run.route) && text(run.route) !== now) {
      stop(i, {
        code: DRIVE_FAULTS.CHANGED,
        trigger: "changed",
        fact: { kind: "route", stored: run.route, now, stage: run.stage, pipeline: run.pipeline },
        waitingFor: { kind: "route", stage: run.stage, since: isoOf(at) },
        // The routing moved under the row, but the run it was on finished: the park settles that run beside the decision.
        settle: runSettle,
      });
      continue;
    }
    const stage = stageById(pipeline, resolved.stage);
    // The tree this stage WROTE in: its own record, then the workspace its worker ran in, and only then the row's
    // tree. Resolved ONCE, because the artifact, the commit it is pinned to, the facts, the gate after it and the
    // ledger's tree record must all name the same directory — a settle that reads one tree and records another is
    // how #260's verdict and its ledger entry disagreed.
    const stageTree = artifactTreeOf(run, stage && stage.id, [task.worktree, tree.path, run.tree && run.tree.path]);
    const treePath = stageTree.path || null;
    const treeFacts = factsFor(treePath) || factsFor(task.worktree);
    // The tree's commit, read ONCE for this settle. It is the pin the handoff will carry, and the stage run records it
    // whether or not the stage declares an artifact. `facts.commit` is the assistant's own full-length reading; a
    // driver with no fact supplier asks git itself, and a tree that cannot answer records null rather than a branch.
    const commit = text(treeFacts && treeFacts.commit) || commitOf(treePath || task.worktree);
    const checked = artifactCheck(stage, task, run, treeFacts, { commit, tree: tree.path, treePath });
    const artifact = checked.artifact;
    // The run settled. The ledger keeps the fact WHATEVER the decision: the stage's status, its artifact's presence and
    // hash at this instant, and the tree facts it ran with. A park then writes its decision on the same entry, so a
    // reader afterwards sees "the run finished, and here is why the row did not move" on one record (§6.2).
    const settledDecision = decisionOf({
      code: null,
      trigger: "stage-settled",
      at: isoOf(at),
      fact: { kind: "run-status", status, detail: detail || null, stage: run.stage, pipeline: run.pipeline, thread },
    });
    let settled = settleStageRun(task, {
      stage: run.stage,
      thread,
      job: text(last.id) || null,
      status,
      at: isoOf(at),
      artifact: artifact || null,
      commit: commit || null,
      tree: treeFactsRecord(treePath || task.worktree, { branch: stageTree.branch || (tree.tree && tree.tree.branch) || (run.tree && run.tree.branch) }, treeFacts),
      decision: settledDecision,
    });
    if (artifact && artifact.unchanged) {
      settled = settleStageRun(settled, {
        stage: run.stage,
        decision: decisionOf({ code: null, trigger: "stage-settled", at: isoOf(at), fact: { kind: "artifact", ...artifact, stage: run.stage, pipeline: run.pipeline } }),
      });
    }
    list[i] = settled;
    settledIds.push(task.id);
    if (artifact && checked.checked && !artifact.present) {
      const edge = edgeOutOf(pipeline, resolved.stage);
      stop(i, {
        code: DRIVE_FAULTS.ARTIFACT,
        trigger: "artifact-missing",
        fact: { kind: "artifact", id: artifact.id, path: artifact.path, present: false, handoff: edge ? text(edge.id) : null, stage: run.stage, pipeline: run.pipeline },
      });
      continue;
    }
    // The reviewer's read travels with the settle. A stage whose exit is the reviewer's answer is not settled by its
    // run alone: the timer reads the pull request and stamps the read on the tree's record, and this pass asks for the
    // same fact so it takes the edge the read chose - and refuses to take one at all when the host ENDED the pull
    // request (row 67: a DECLINED read walked on to approve and merge because the driver never asked).
    const read = reviewed(stageTree.path || treePath || task.worktree, stage, run);
    const step = nextStageOf(pipeline, run, { worktree: treePath || task.worktree, fanout: plan, review: read ? { stamped: read } : null });
    if (!step.ok) {
      const isGate = step.code === DRIVE_FAULTS.GATE;
      const isVerdict = step.code === DRIVE_FAULTS.VERDICT;
      // The pull request ENDED: the park names the panel's own read, so the row carries the host's word and the check
      // the stage waited on rather than a sentence about a stop.
      const isDeclined = step.code === DRIVE_FAULTS.DECLINED;
      const fact = isDeclined
        ? {
            kind: "review",
            check: text(step.read && step.read.check),
            state: text(step.read && step.read.state) || "DECLINED",
            closed: text(step.read && step.read.closed) || "declined",
            why: text(step.read && step.read.why),
            seen: text(step.read && step.read.seen),
            number: step.read && step.read.number != null ? step.read.number : null,
            stage: run.stage,
            pipeline: run.pipeline,
          }
        : isGate
          ? { kind: "gate", gate: text(step.gate && step.gate.id), path: step.path, present: false, stage: run.stage, pipeline: run.pipeline }
          : isVerdict
            ? { kind: "verdict", gate: text(step.gate && step.gate.id), path: step.path, outcomes: step.outcomes || [], reason: step.reason, stage: run.stage, pipeline: run.pipeline }
            : step.code === DRIVE_FAULTS.CAP
              ? {
                  kind: "cap",
                  edge: text(step.handoff && step.handoff.id),
                  from: text(step.handoff && step.handoff.from),
                  to: text(step.handoff && step.handoff.to),
                  text: text(step.handoff && step.handoff.cap),
                  used: step.used,
                  limit: step.limit,
                  // The visits every stage has taken and the verdict the gate read on the way here: the two facts a reader
                  // otherwise has to reconstruct from the ledger before deciding what the cap park means.
                  visits: isObject(step.visits) ? { ...step.visits } : null,
                  verdict: isObject(step.verdict) ? { ...step.verdict } : null,
                  stage: run.stage,
                  pipeline: run.pipeline,
                }
              : { kind: "record", reason: step.reason, stage: run.stage, pipeline: run.pipeline };
      stop(i, {
        code: step.code,
        trigger: isDeclined ? "declined" : isGate ? "stage-settled" : isVerdict ? "verdict" : step.code === DRIVE_FAULTS.CAP ? "cap" : "unresolved",
        fact,
        // A verdict fault waits on the SAME record the gate waits on: the reader repairs the file, and the next pass
        // re-reads it and releases the row — the record is the release, exactly as it is for a missing one.
        // A declined pull request releases on nothing the panel can watch: the PR is over, and the row is a person's
        // to re-cut, so it parks with no `waitingFor` rather than pretending a re-read could release it.
        waitingFor: isGate || isVerdict
          ? { kind: "gate", gate: step.gate.id, path: step.gate.decision.path, stage: run.stage, since: isoOf(at) }
          : step.code === DRIVE_FAULTS.CAP
            ? {
                kind: "cap",
                edge: text(step.handoff && step.handoff.id),
                from: text(step.handoff && step.handoff.from),
                to: text(step.handoff && step.handoff.to),
                limit: step.limit,
                used: step.used,
                visits: isObject(step.visits) ? { ...step.visits } : null,
                verdict: isObject(step.verdict) ? { ...step.verdict } : null,
                stage: run.stage,
                since: isoOf(at),
              }
            : null,
      });
      continue;
    }

    // The pipeline is over: the row's last stage settled, or a verdict routed it nowhere. A stage that declares an
    // artifact of kind `pr` is left to the settle's landing rule (its PR must read MERGED); a stage that declares any
    // other artifact has no PR to land and is finished HERE, on its own verdict. The decision is written on the stage
    // run that settled, so a reader can see WHICH verdict ended it — and the loop is never charged a crossing for a
    // round the document did not ask for.
    if (step.done) {
      if (step.verdict) {
        list[i] = recordStageDecision(
          list[i],
          decisionOf({
            code: null,
            trigger: "verdict",
            at: isoOf(at),
            fact: {
              kind: "verdict",
              gate: step.verdict.gate,
              path: step.verdict.path,
              outcome: step.verdict.outcome,
              handoff: step.verdict.handoff,
              edge: step.verdict.edge,
              from: step.verdict.from,
              to: step.verdict.to,
              ended: true,
              stage: run.stage,
              pipeline: run.pipeline,
            },
          }),
        );
      }
      // THE ROUND IS OVER, AND EVERY STAGE COMMITTED ON ITS OWN BRANCH. Before the row is finished, or left to its
      // landing rule, the ONE branch that carries the whole round is asked for (lib/pipeline-assembly.js): the
      // landing step must have a single branch, never the first stage's tree plus siblings nothing merges. The row is
      // not finished on this pass - the next one reads the assembly record and takes the ordinary end.
      const assembled = assemblyPlanOf(list[i], pipeline, isObject(list[i][TASK_PIPELINE_FIELD]) ? list[i][TASK_PIPELINE_FIELD] : run);
      if (assembled.offered) {
        assemblies.push({
          taskId: task.id,
          pipeline: pipeline.id,
          stage: run.stage,
          title: task.title,
          project: text(task.project) || null,
          base: assembled.base,
          parent: assembled.parent,
          parentPath: assembled.parentPath || null,
          stages: assembled.stages,
        });
        notes.push({
          id: task.id,
          code: DRIVE_FAULTS.STARTING,
          reason: `the round is over and its ${assembled.stages.length} stage commits are on their own branches - the assembly is the one branch that lands`,
        });
        continue;
      }
      if (stage && !landsAsPr(stage)) finish(i, { reason: overReason(pipeline, stage, run) });
      continue; // a PR-carrying stage: the settle finishes that row on the landing rule
    }

    const why = `stage ${run.stage} settled — moved to ${step.stage.id} (${step.stage.position} of ${pipeline.stages.length}) of ${pipeline.id}`;
    const moved = setTaskState(list, task.id, "queued", { by: "panel", at, reason: why });
    if (!moved) {
      list[i] = settled;
      continue;
    }
    list.splice(0, list.length, ...moved.tasks);
    // The row's `tree` is the AGGREGATE under a fan-out: a lane's tree is recorded on its stage run, not promoted to
    // the row's (the row's branch is the one that lands, and it must be the merge's).
    list[i] = moveTo(moved.task, step, { at, pipeline, tree: plan ? null : tree.tree });
    changed.push({ id: task.id, title: task.title, thread, from: String(task.state || ""), to: "queued", stage: step.stage.id, why });
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
        const index = list.indexOf(front);
        if (starting) {
          notes.push({ id: front.id, code: DRIVE_FAULTS.STARTING, reason: `stage ${run.stage} was started ${Math.round((msOf(at) - asked) / 1000)}s ago and its run has not linked yet — a second start is not asked for` });
        } else if (!resolved.ok) {
          stop(index, { code: DRIVE_FAULTS.UNRESOLVED, trigger: "unresolved", fact: { kind: "record", reason: resolved.reason, stage: run.stage, pipeline: run.pipeline } });
        } else {
          const pipeline = pipelineById(bundle, resolved.pipeline);
          const stage = stageById(pipeline, resolved.stage);
          // WHERE this stage runs. A `shared` pipeline — and a fan-out's fork — answers the row's one tree; a lane and
          // the join answer their OWN tree, cut for that stage from the block's base (lib/pipeline-fanout.js rule 2).
          const plan = fanOutStateOf(pipeline, run);
          const tree = stageTreeLookup(front, pipeline, run, treeOptions(pipeline));
          const merge = plan && stage.id === plan.join ? (stageRunFor(run, { stage: plan.join }) || {}).merge || null : null;
          // A `pr`-kind stage of a CHAIN acts on the round's parent tree, so the branch it is about to push must be
          // the branch that lands: the round's settled stages are assembled onto it BEFORE the stage starts. Without
          // this the push stage would push the round's parent at its frozen base - a branch holding none of the
          // round's work - and the row's one pull request would have nothing in it.
          const landingRound = !plan ? roundLandingOf(run) : null;
          // One ask per row per pass: a row that just settled its LAST stage is already in `assemblies` from the
          // round-over step above, and a second identical request would have the host cherry-pick the same commits twice.
          const owedPlan = landingRound && landsAsPr(stage) ? assemblyPlanOf(front, pipeline, run) : null;
          const owed = owedPlan && owedPlan.offered && !assemblies.some((ask) => ask.taskId === front.id) ? owedPlan : null;
          const project = text(front.project);
          const now = routingFingerprint(pipeline);
          if (text(run.route) && text(run.route) !== now) {
            stop(index, {
              code: DRIVE_FAULTS.CHANGED,
              trigger: "changed",
              fact: { kind: "route", stored: run.route, now, stage: run.stage, pipeline: run.pipeline },
              waitingFor: { kind: "route", stage: run.stage, since: isoOf(at) },
            });
          } else if (tree.lost) {
            stop(index, {
              code: DRIVE_FAULTS.TREE_GONE,
              trigger: "tree",
              fact: { kind: "tree", code: DRIVE_FAULTS.TREE_GONE, path: tree.lost.path, lastStage: tree.lost.stage, stage: run.stage, pipeline: run.pipeline },
            });
          } else if (!tree.path && !project) {
            const reason = `#${front.id} is on ${pipeline.id} · ${stage.id} and names neither a tree nor a project — there is nowhere to start its stage`;
            stop(index, { code: DRIVE_FAULTS.NO_TARGET, trigger: "start-asked", fact: { kind: "claim", reason, stage: run.stage, pipeline: run.pipeline } });
            notes.push({ id: front.id, code: DRIVE_FAULTS.NO_TARGET, reason });
          } else if (owed && owed.offered) {
            // THE BRANCH IT PUSHES HAS TO HOLD THE ROUND. A `pr`-kind chain stage runs in the round's parent tree, which
            // is also `roundOwesAssembly`'s subject: until the settled stages are picked onto it, the branch is still
            // at the round's frozen base and the stage's push would publish a branch with none of the round's work on
            // it. So the assembly is asked for FIRST and the stage is not started on this pass - the same one branch a
            // finished round is handed, asked for at the stage that is about to use it.
            assemblies.push({
              taskId: front.id,
              pipeline: pipeline.id,
              stage: stage.id,
              title: front.title,
              project: text(front.project) || null,
              base: owed.base,
              parent: owed.parent,
              parentPath: owed.parentPath || null,
              stages: owed.stages,
            });
            notes.push({
              id: front.id,
              code: DRIVE_FAULTS.STARTING,
              reason: `stage ${stage.id} lands by pull request, so the round's ${owed.stages.length} settled stage${owed.stages.length === 1 ? "" : "s"} are assembled onto ${owed.parent || "its parent tree"} before the stage starts - the branch it pushes is the one that lands`,
            });
          } else if (plan && stage.id === plan.join && tree.path && !merge) {
            // The aggregate is OWED: the join's tree is cut, every lane is pinned, and the one merge has not been made
            // (the cut and the merge are two steps, and a panel that restarted between them lands here). The merge is
            // the assistant's — git lives in lib/pipeline-aggregate.js — and it runs BEFORE the aggregator's agent, so
            // the stage never reads a tree without its inputs.
            const owed = aggregateBranchesOf(run, plan, stageRunsOf);
            if (!owed.ok) {
              notes.push({ id: front.id, code: DRIVE_FAULTS.STARTING, reason: `the aggregate for ${plan.join} is owed and cannot be planned — ${owed.why}` });
            } else {
              aggregates.push({ taskId: front.id, pipeline: pipeline.id, stage: plan.join, tree: tree.path, base: plan.base, branches: owed.branches });
              notes.push({ id: front.id, code: DRIVE_FAULTS.STARTING, reason: `the aggregate for ${plan.join} is owed — the lanes are merged before its worker starts` });
            }
          } else {
            const facts = factsFor(tree.path);
            // The pin is checked BEFORE the prompt is built and before the tree claim is argued: an input whose commit
            // this tree cannot resolve is a refusal, not an invitation to read whatever the branch says now. The check
            // runs only when the writer recorded a commit — a record from before the pin is not a park (§2.4).
            //
            // A fan-out's JOIN is the exception, and deliberately: it arrived by no single edge, and its inputs are
            // every lane's commit. The recorded, verified aggregate IS that proof (lib/pipeline-aggregate.js), so
            // re-checking the last handoff's pin here would ask about one lane and ignore the rest — and before the
            // aggregate tree exists there is nothing to check the pin against, so the check would park the row on the
            // one stage the merge is meant to hand every lane to.
            const joinOf = Boolean(plan && stage.id === plan.join);
            const handedOn = joinOf ? null : handedOnPinOf(pipeline, stage, run);
            // A stage with NO tree yet is not asked to resolve a pin: its tree is cut first (at the round's frozen
            // parent) and the check belongs to the NEXT pass, against a workspace that exists. Checking here would park
            // every stage after the first `pipeline-refuse-input` for the one fact the cut exists to fix — there is no
            // tree to resolve the writer's commit in.
            const pinned = !tree.path || !handedOn ? { ok: true } : pinCheck(tree.path, { commit: handedOn.commit, path: handedOn.file, blob: handedOn.blob });
            // THE INPUT IS EVERY ARTIFACT THE DOCUMENT SAYS THIS STAGE READS, not only the one edge it arrived by. The
            // manifest is resolved here, once, and the same object is written on the stage run at the start: a stage
            // handed an entry the document declares, which no settled writer pinned and the stage's own tree does not
            // hold, is REFUSED. Two shapes reach this and both used to be handed on:
            //   - a handoff whose writer never settled (a lane the walk never entered, a stage a route skipped): `via`
            //     names the edge and there is no pin, so the old `!handedOn` check answered "nothing to check";
            //   - a declared `inputs.read[]` of an artifact nothing has produced, which `inputManifest` recorded as
            //     `present: false` and the stage then ran without.
            // A row whose TERMINAL stage refuses this way settles `refused`, not `done`: the pipeline may not report
            // work it was never handed. Entries with no declared path (an external input, an id the document gives no
            // file for) are left to `present: null`, because there is nothing to resolve them against.
            const startCommit = text(facts && facts.commit) || commitOf(tree.path);
            const startInputs = tree.path
              ? inputManifest({ pipeline, stage, run, worktree: tree.path, visit: visitOf(run, stage.id), commit: startCommit })
              : { entries: [], dropped: 0 };
            // An entry is ABSENT when NO RUN of this pipeline has settled that artifact and the stage's own tree does
            // not hold the file either. Both halves matter: a record from before pins existed says `present: true` with
            // no commit and no blob (a writer's own claim, which a tree cannot confirm but must not contradict), and a
            // declared path with no file anywhere is exactly the dropped lane. An entry with no declared path names
            // nothing a tree could be asked about, so it is never refused here.
            const absentInput = (startInputs.entries || []).find(
              (entry) => entry && text(entry.path) && entry.present !== true && !settledArtifactOf(run, entry.artifact),
            ) || null;

            const claim = tree.path ? claimAgainst(treeKey(tree.path), front, claimsMap) : null;
            if (!pinned.ok) {
              stop(index, {
                code: DRIVE_FAULTS.REFUSE_INPUT,
                trigger: "start-asked",
                fact: {
                  kind: "input",
                  artifact: handedOn.artifact,
                  path: handedOn.path,
                  commit: handedOn.commit,
                  blob: handedOn.blob,
                  handoff: handedOn.handoff,
                  reason: pinned.reason,
                  stage: run.stage,
                  pipeline: run.pipeline,
                },
                // The refusal is the stage run's OUTCOME, not a silence: the ledger reads `S223#1 refused` and the row
                // reads parked on `pipeline-refuse-input`. Without this the entry was created with `status: null`,
                // which reads as a run that never ended, and at the terminal stage the pipeline's own answer (`done
                // true`, the closing gate) was the only thing left saying what happened.
                settle: { status: "refused", at: isoOf(at) },
              });
            } else if (absentInput) {
              stop(index, {
                code: DRIVE_FAULTS.REFUSE_INPUT,
                trigger: "start-asked",
                fact: {
                  kind: "input",
                  missing: true,
                  artifact: text(absentInput.artifact) || null,
                  path: text(absentInput.path) || null,
                  via: text(absentInput.via) || null,
                  handoff: text(absentInput.edge) || null,
                  writer: text(absentInput.writer) || null,
                  // One sentence that is true in both shapes: a lane the walk never entered, and a writer that settled
                  // without committing the file, both leave the stage with nothing it can read.
                  reason: "No run of this pipeline has settled it, and this stage's tree does not hold it",
                  stage: run.stage,
                  pipeline: run.pipeline,
                },
                settle: { status: "refused", at: isoOf(at) },
              });
            } else if (claim) {
              stop(index, {
                code: DRIVE_FAULTS.TREE_CLAIMED,
                trigger: "tree",
                fact: { kind: "tree", code: DRIVE_FAULTS.TREE_CLAIMED, path: tree.path, otherId: claim.id, otherTitle: claim.title, stage: run.stage, pipeline: run.pipeline },
              });
            } else if (!tree.path) {
              // No tree and a project to cut in: the CUT is its own request, performed by the assistant and written on
              // the row before anything starts (§3.2). The next pass finds the tree and asks for the start. A lane's
              // cut carries the block's BASE, so every lane starts from the same commit (lib/pipeline-fanout.js
              // rule 3); the first cut of a pipeline-start fan-out has no base yet and SUPPLIES it.
              const prompt = stagePrompt(front, pipeline, stage, { run, fanout: plan });
              const role = plan ? (stage.id === plan.join ? "join" : stage.id === plan.fork ? "fork" : "lane") : tree.role === "stage" ? "stage" : "row";
              const lanePlan = plan ? { fork: plan.fork, lanes: plan.lanes, join: plan.join } : null;
              const round = roundOf(run);
              // A LANE and the JOIN are cut from the block's ONE base. A chain STAGE is cut from the ROUND's PARENT
              // TREE's branch: the branch cut from origin/main before the round began, whose tip is the round's frozen
              // commit, never origin/main as it stands now. The first stage of a round (`role: "row"`) has no base
              // yet: its cut is what cuts the parent tree and records the round.
              const cutBase = role === "lane" || role === "join" ? plan.base : role === "stage" ? (round && (round.parent || round.sha)) || null : null;
              // The join's cut is also its aggregate: the assistant cuts the tree at the base and merges every lane
              // into it before writing the stage's entry, so there is never a moment a worker sees an unmerged tree.
              const branches = role === "join" ? (aggregateBranchesOf(run, plan, stageRunsOf).branches || []) : null;
              ensureTree.push({
                taskId: front.id,
                pipeline: pipeline.id,
                stage: stage.id,
                prompt,
                project,
                title: front.title,
                base: cutBase,
                // The branch the round's frozen commit came from: what the worktree chart hangs this stage's tree
                // under, and never re-resolved (lib/task-pipeline-drive.js `roundOf`, lib/parents.js). With a parent
                // tree that is the round's own branch, so every stage child of one round nests under one row.
                parent: round ? round.parent : null,
                // What the name needs and only the document has: the stage's position and its title, plus the visit
                // this cut is for. `stageTreeName` is pure, so these four facts are the whole of the tree's name.
                stageName: text(stage.title) || stage.id,
                position: stage.position ?? null,
                visit: visitOf(run, stage.id),
                role,
                plans: lanePlan,
                branches,
              });
              notes.push({ id: front.id, code: DRIVE_FAULTS.STARTING, reason: `stage ${stage.id} needs ${role === "join" ? "its aggregate tree" : role === "stage" ? "its own tree" : role === "lane" ? "its own tree" : "a tree"} before it can start — the cut is the assistant's step` });
            } else {
              const prompt = stagePrompt(front, pipeline, stage, {
                run,
                // The branch is read off the tree record, not the lookup's own field: `treeLookup` answers the tree it
                // FOUND (`tree.tree`), and a filed tree's branch has to reach the worker or the brief says "(unknown)"
                // and the stage has to infer the ref it is about to push.
                tree: {
                  ...(tree.tree || {}),
                  path: tree.path,
                  branch: text(tree.tree && tree.tree.branch) || text(run.tree && run.tree.branch) || null,
                },
                facts,
                fanout: plan,
              });
              // Is this stage's branch one of the round's work branches rather than the row's landing branch? A chain
              // stage's own tree and a fan-out's lane are; a fan-out's join tree is the aggregate, which IS the row's,
              // and a `pr`-kind chain stage is answered the round's parent tree by `stageTreeLookup` (role `round`),
              // which is the row's landing branch too.
              const ownStageBranch = ["stage", "lane"].includes(text(tree.role));
              if (!prompt.trim() || !text(stage.prompt)) {
                notes.push({ id: front.id, code: DRIVE_FAULTS.UNRESOLVED, reason: `stage ${stage.id} of ${pipeline.id} has no prompt to hand a worker` });
              } else {
                starts.push({
                  taskId: front.id,
                  pipeline: pipeline.id,
                  stage: stage.id,
                  position: stage.position,
                  count: pipeline.stages.length,
                  visit: visitOf(run, stage.id),
                  title: front.title,
                  prompt,
                  target: tree.path,
                  existing: true,
                  project: project || null,
                  // Whether this stage's branch goes to the REMOTE, decided by its declared artifact (rule 3): a `pr`
                  // stage lands by pull request, so its worker is handed the parent's LANDING paragraph and pushes; a
                  // stage that writes a document, a report or a build is local-only, so `lib/jobs.js` renders the
                  // paragraph that says commit and report and never push. Without this the parent's paragraph was the
                  // same for both, and every stage opened a PR (measured: one document stage, PR #607).
                  //
                  // A stage in its OWN tree is local-only whatever its artifact says: its branch is one of the round's
                  // stage branches, and the branch that lands is the ASSEMBLY's (lib/pipeline-assembly.js rule 5, the
                  // same rule a fan-out's lanes follow). A stage that pushed here would open a PR holding one stage of
                  // the round and leave the rest unlanded.
                  //
                  // A `pr`-kind CHAIN stage is the exception, and the tree lookup is what draws it: `stageTreeLookup`
                  // answers the round's parent tree for it (role `round`, never a stage child), the assembly put the
                  // round's settled work on that branch before the stage started, and the stage's push and PR are how
                  // the row lands. `ownStageBranch` is false there, so the decision below hands it `pr`.
                  remoteWrite: landsAsPr(stage) && !ownStageBranch ? "pr" : "local",
                  // The branch the stage RUNS in: its own under `per-stage`, the round's parent branch for a `pr`-kind
                  // chain stage, the row's otherwise. A stage branch is local only (rule 5) - this names a workspace,
                  // and only a `pr`-kind stage's branch is a ref anything may push.
                  tree: { path: tree.path, branch: text(tree.tree && tree.tree.branch) || text(run.tree && run.tree.branch) || null },
                  ...(plan ? { isolation: "per-stage", role: stage.id === plan.join ? "join" : stage.id === plan.fork ? "fork" : "lane" } : {}),
                });
                // The marker and the ledger entry are written with the row, BEFORE the caller starts anything: the
                // marker is what the next pass reads, and the entry is what a restart reads to know this attempt existed.
                // The row's own `tree` is the AGGREGATE's under a fan-out — the branch that lands — never a lane's.
                const marked = { ...front, [TASK_PIPELINE_FIELD]: { ...run, [STARTING_AT]: isoOf(at), ...(tree.tree && !run.tree && !plan ? { tree: tree.tree } : {}) } };
                const withEntry = beginStageRun(marked, { stage: stage.id, at: isoOf(at), tree: tree.path });
                // The inputs this stage is handed, resolved on the same pass that built its prompt: the manifest is
                // what the stage STARTED with, so it is written with the entry rather than at settle, when the files
                // may already have moved (§5.3). It is the SAME object the refusal above read, so the record and the
                // decision cannot disagree about what the stage was handed.
                // The tree's commit is resolved HERE, at the start, so an entry with no writer pin still records the
                // commit it read the tree at; the writer's own pin wins for the handoff when it has one.
                const commit = startCommit;
                const withFacts = settleStageRun(withEntry, { stage: stage.id, commit: commit || null, tree: treeFactsRecord(tree.path, tree.tree || run.tree, facts), inputs: startInputs });
                list[index] = withFacts;
              }
            }
          }
        }
      }
    }
  }

  return { tasks: list, changed, starts, ensureTree, aggregates, assemblies, notes, settled: settledIds };
}
