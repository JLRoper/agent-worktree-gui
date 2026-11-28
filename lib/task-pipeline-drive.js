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
// THE DOCUMENT SIDE MOVED OUT FIRST. The pipeline document - the graph, the manifest, the fingerprint, the gate's
// record and the verdict - lives in lib/task-pipeline-document.js and is re-exported below, so every import site
// still reads this path. The tree a stage writes in and the stage prompt are still in this file; they move next.

import path from "node:path";

import { byQueueOrder, currentThread, setTaskState } from "./assistant/queue.js";
import { pipelineById, stageById } from "./pipeline-bundle.js";
import { aggregateBranchesOf, fanOutBaseOf, fanOutOf, ISOLATION_PER_STAGE, isolationOf, stageRoleOf } from "./pipeline-fanout.js";
import { isMainName } from "./parents.js";
import { commitOf, pinCheck, pinOf, relInTree, shortSha, withStagePinReader, workingBlobOf } from "./stage-pin.js";
import { HOLD_OWNER_MS, isRunWait, waitKind } from "./pipelines.js";
import { budgetBlock } from "./word-budget.js";
import { TASK_PIPELINE_FIELD, beginStageRun, enterStage, recordStageDecision, resolveTaskPipeline, settleStageRun, stageRunFor, stageRunsOf, visitOf } from "./task-pipeline.js";
import {
  DRIVE_FAULTS,
  STARTING_AT,
  START_GRACE_MS,
  WAITING_FOR,
  artifactOf,
  artifactTreeOf,
  artifactValues,
  capOf,
  decisionOf,
  decisionPathOf,
  declaredArtifactOf,
  edgeOutOf,
  fillHoles,
  gateAfter,
  handedOnPinOf,
  inputManifest,
  isDirectory,
  isObject,
  isoOf,
  landsAsPr,
  nextStageOf,
  routingFingerprint,
  settledArtifactOf,
  text,
  treeFactsRecord,
  verdictOf,
  writerArtifactOf,
} from "./task-pipeline-document.js";

// Every name this file published before the split, from the module that holds the document side now.
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

// ---- the tree: one per row, cut once, reused by every stage -----------------------------------------------------
const treeKey = (value) => String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Is the tree a queued row was FILED with a work branch this row may start in?
//
// Returns `{ path, branch }` when it is, and null in every other case. The caller (`treeLookup`) then answers the
// filed tree instead of the row's missing one, which is what stops a `shared` pipeline from cutting a round it does
// not want. Three facts decide it, and each one is read from the tree rather than from the filing form:
//
//   1. the row is QUEUED and has not started (no stage run, no `startingAt`). A started row is answered by the
//      panel's own writes further up, and a row with no pipeline is not on a ladder at all;
//   2. the pipeline is NOT `per-stage`. A per-stage round cuts one child tree per stage from its frozen parent, and
//      one filed tree cannot stand in for those cuts; only a `shared` pipeline reuses one tree for every stage;
//   3. the directory is real AND `treeOf` (the panel's git read) answers a branch for it that is not a trunk. Row 50
//      of the 2026-11-09 round report was a row filed with the project checkout: its branch was `main`, and the stage
//      committed into it. A trunk is refused here for good; a detached head (no branch) is refused with it.
//
// `treeOf` is the caller's fact supplier (`driveTaskPipelines` hands it the panel's `treeFactsOf`). A driver with no
// supplier cannot prove the branch, so it answers null and keeps the old rule: the cut is the panel's.
export function filedTreeOf(task, run, { treeOf = null, isolation = null } = {}) {
  const row = isObject(task) ? task : {};
  if (!isObject(run)) return null;
  if (String(row.state || "") !== "queued") return null;
  if (stageRunsOf(run).length > 0 || text(run[STARTING_AT])) return null;
  if (isolation === ISOLATION_PER_STAGE) return null;
  const filed = text(row.worktree);
  if (!filed || !isDirectory(filed)) return null;
  const facts = typeof treeOf === "function" ? treeOf(filed) : null;
  const branch = text(facts && facts.branch);
  if (!branch || isMainName(branch)) return null;
  return { path: filed, branch };
}

// The three answers, then a park (§3.3):
//   1. `pipelineRun.tree.path` — the row's own field, written at the cut;
//   2. the most recent `stageRuns[].tree.path` that still exists — the ledger wins when the two disagree;
//   3. `task.worktree` — where the row already works, once the record shows it has STARTED there (see the note below);
//   4. none of them exists → the row HAD a tree and it is gone (a park), never a second cut and never the project.
// A row that has never had a tree answers `needed`: that is the first stage, and its cut is the `ensureTree` request.
export function treeLookup(task, options = {}) {
  const row = isObject(task) ? task : {};
  const run = isObject(row[TASK_PIPELINE_FIELD]) ? row[TASK_PIPELINE_FIELD] : null;
  const runs = stageRunsOf(run);
  const ledger = [...runs]
    .reverse()
    .map((entry) => ({ path: text(entry.tree && entry.tree.path), stage: text(entry.stage) || null, tree: entry.tree }))
    .find((entry) => entry.path);
  const field = text(run && run.tree && run.tree.path)
    ? { path: text(run.tree.path), stage: text(run.stage) || null, tree: run.tree }
    : null;
  // A FILED TREE, AND THE ONE CASE WHERE A QUEUED ROW'S `worktree` IS EVIDENCE.
  //
  // `worktree` is a real field: a row the panel linked to a run, a row a reader pointed at a tree, a row that was
  // filed for one. On a row that is already working it names the tree the work is in, and the lookup must answer it.
  // On a pipeline row that has NOT started it is only where somebody filed the row - and a stage that ran there is
  // the defect this note exists to stop: row 50 of the 2026-11-09 round report was filed with the project checkout as
  // its worktree, the lookup took the field at its word, no cut was asked for, and the stage committed into the
  // checkout's main.
  //
  // A round's first cut is what MAKES the round - the parent tree, the frozen sha, every child cut from it - so a
  // pipeline row with no tree of its own answers `needed` whatever `worktree` says. The field is honoured only once
  // the record proves the row has started: a stage run entry, a start request (`startingAt`), or a state that only a
  // link writes (`running`). All three are the panel's own writes; a filing form's path is not.
  const started = !run || String(row.state || "") !== "queued" || runs.length > 0 || Boolean(text(run && run[STARTING_AT]));
  // ...WITH ONE EXCEPTION: A LANDING LADDER RUNS IN THE TREE IT WAS FILED WITH. A `shared` pipeline reuses ONE tree
  // for every stage, and a reader who files its row with a real work branch means that tree - the six-stage GitHub
  // ladder cut its round instead, so the filed tree sat unused while its stages ran in a tree nobody named. The field
  // is read here, and only here, when the tree itself answers the facts that make it safe (`filedTreeOf`).
  const filed = started ? null : filedTreeOf(row, run, options);
  const worktree =
    (started || filed) && text(row.worktree)
      ? { path: text(row.worktree), stage: null, tree: filed ? { path: filed.path, branch: filed.branch } : null }
      : null;
  const recorded = [field, ledger, worktree].filter(Boolean);
  if (!recorded.length) return { path: null, needed: true, lost: null, source: null, tree: null, disagree: false };

  const live = recorded.find((entry) => isDirectory(entry.path));
  if (live) {
    const disagree = Boolean(field && ledger && treeKey(field.path) !== treeKey(ledger.path));
    const source = disagree || (live === ledger && !field) ? "stageRuns" : live === field ? "pipelineRun.tree" : "worktree";
    return { path: live.path, needed: false, lost: null, source, tree: live.tree || null, disagree };
  }
  return { path: null, needed: false, lost: recorded[0], source: null, tree: null, disagree: false };
}

// The ROUND: one run of a pipeline, the PARENT TREE it cut, and the commit that tree started at.
//
// A round is the row's whole pipeline from its first stage to its last, and `parent` is the BRANCH its trees start
// from: the round's own parent tree, `.worktrees/<task-slug>-<tag>` on `wtgui/<task-slug>-<tag>`, cut from
// origin/main before the first stage (lib/stage-tree-name.js names it). The record carries it as
//
//   pipelineRun.round = { parentPath, parent, slug, tag, base, sha, display, at, by }
//
// `parentPath` is the directory the assembly lands in and the branch the landing step pushes; `parent` is that
// branch's name; `base` is the ref it was cut from (`origin/main` when the project has one); `sha` is the COMMIT that
// ref resolved to at the cut. Two facts follow, and both are the point:
//
//   - `sha` is a COMMIT, not a name. A stage tree cut from it cannot see a landing that happened on origin/main after
//     the round began, which is what a tree cut mid-round could see while every cut re-resolved the parent branch.
//   - it is the one fact about a round that cannot be derived from the bundle, so it is STORED rather than recomputed
//     — the same reason the fan-out's base is stored (lib/pipeline-fanout.js rule 3).
//
// `null` for a record written before rounds existed: such a row keeps the model it was cut under (one tree per row,
// reused by every stage), so a deploy does not re-cut the trees of rows already in flight.
export function roundOf(run) {
  const round = isObject(run && run.round) ? run.round : null;
  if (!round) return null;
  const parent = text(round.parent) || null;
  const sha = text(round.sha) || null;
  const parentPath = text(round.parentPath) || null;
  const slug = text(round.slug) || null;
  const tag = text(round.tag) || null;
  if (!parent && !sha && !parentPath) return null;
  return { parent, sha, parentPath, slug, tag, base: text(round.base) || null, display: text(round.display) || null, at: text(round.at) || null, by: text(round.by) || null };
}

// WHAT A FINISHED ROUND OWES: ONE branch carrying every stage's commit.
//
// A round gives every stage its own tree and its own branch (rule 2 of `docs/task-pipeline.md`, "The tree: one per
// stage"). Nothing merges those branches while the stages run - a stage must not see a sibling's files - so when the
// pipeline is over the work sits on N local branches and the row's landing branch (the FIRST stage's tree, the only
// one promoted to `pipelineRun.tree`) carries the first stage alone. The assembly closes that: every stage run's
// commit is cherry-picked, in visit order, onto ONE branch cut from the round's frozen parent
// (lib/pipeline-assembly.js), and that branch becomes the row's landing branch.
//
// The plan is a VALUE, so a test can read it without git and the Assistant performs it:
//   { offered: true, base, parent, stages: [{stage, visit, commit, branch, position}], skipped }
//   { offered: false, done: true, why }     the round is already assembled - never a second branch for one round
//   { offered: false, done: false, why }    nothing to assemble (no round, a fan-out, one stage of a round with no
//                                           parent tree, no commits)
//
// A FAN-OUT is excluded on purpose: its join tree is already the one merge (lib/pipeline-fanout.js rule 4), and a
// second assembly of its lanes would merge every lane twice.
export function assemblyPlanOf(task, pipeline, run = null) {
  const record = isObject(run) ? run : isObject(task && task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
  const answer = (why, extra = {}) => ({ offered: false, done: false, why, base: null, parent: null, parentPath: null, stages: [], skipped: [], ...extra });
  const round = roundOf(record);
  if (!round || !round.sha) {
    return answer("the row records no round - a record from before rounds existed keeps the one tree it was cut under");
  }
  if (fanOutStateOf(pipeline, record)) {
    return answer("the pipeline draws a fan-out block - its join tree is the one merge, so there is nothing to assemble", { base: round.sha, parent: round.parent, parentPath: round.parentPath });
  }
  const stages = Array.isArray(pipeline && pipeline.stages) ? pipeline.stages : [];
  const positionOf = new Map(stages.map((stage, index) => [text(stage && stage.id), Number.isInteger(Number(stage && stage.position)) ? Number(stage.position) : index + 1]));
  const runs = [...stageRunsOf(record)];
  const seen = new Set();
  const plan = [];
  const skipped = [];
  const skipOf = new Map();
  for (const entry of runs) {
    const stageId = text(entry.stage);
    const visit = Number.isInteger(Number(entry.visit)) && Number(entry.visit) > 0 ? Number(entry.visit) : 1;
    const key = `${stageId}#${visit}`;
    if (!stageId || seen.has(key)) continue;
    const commit = text(entry.commit);
    if (text(entry.status) !== "done" || !commit) {
      // A failed ATTEMPT is only a skip if the visit never lands: the same visit's next attempt may settle done, and
      // then the plan carries that commit instead of also claiming the visit was skipped. One row per visit, either way.
      if (!skipOf.has(key)) {
        const row = { stage: stageId, visit, why: text(entry.status) === "done" ? "the run recorded no commit" : `the run is ${text(entry.status) || "not settled"}` };
        skipOf.set(key, row);
        skipped.push(row);
      }
      continue;
    }
    seen.add(key);
    const stale = skipOf.get(key);
    if (stale) {
      const at = skipped.indexOf(stale);
      if (at >= 0) skipped.splice(at, 1);
      skipOf.delete(key);
    }
    plan.push({ stage: stageId, visit, commit, branch: text(entry.tree && entry.tree.branch) || null, position: positionOf.get(stageId) || 0 });
  }
  const assembly = isObject(record && record.assembly) ? record.assembly : null;
  if (assembly && text(assembly.base) === round.sha && text(assembly.commit)) {
    return {
      offered: false,
      done: true,
      why: `the round is assembled at ${shortSha(assembly.commit)} on ${text(assembly.branch) || "one branch"} - a second assembly for the same round is refused`,
      base: round.sha,
      parent: round.parent,
      parentPath: round.parentPath,
      stages: plan,
      skipped,
      assembly,
    };
  }
  // A round with a PARENT TREE owes that tree one commit even from a single stage: the parent tree is the branch that
  // lands, so the one stage's commit has to be picked onto it - its own branch is not the landing branch any more. A
  // record with no parent tree keeps the older rule, where the first stage's own tree WAS the landing branch.
  const minimum = round.parentPath ? 1 : 2;
  if (plan.length < minimum) {
    return answer(
      plan.length === 0
        ? "no stage run of the round recorded a commit - there is nothing to assemble"
        : "one stage of the round recorded a commit, and the round has no parent tree - its own branch is already the whole of it",
      { base: round.sha, parent: round.parent, parentPath: round.parentPath, stages: plan, skipped },
    );
  }
  return { offered: true, done: false, why: null, base: round.sha, parent: round.parent, parentPath: round.parentPath, stages: plan, skipped };
}

// WHERE a stage runs, once the pipeline's isolation is in play.
//
// `shared` (the default), and a `fork` stage under `per-stage`, answer exactly what `treeLookup` always answered: the
// row's one tree. A LANE and the JOIN answer their OWN tree — the one cut for that stage, recorded on the row
// (`pipelineRun.trees[stage]`) and on the stage run that used it — and never the row's: a lane that ran in another
// lane's tree could read a sibling's files mid-flight, which is the one thing the fan-out is built to prevent.
//
// The four answers are the same four `treeLookup` gives, so the caller cannot tell them apart by shape:
//   { path, needed: false }        the stage's tree, on disk
//   { needed: true }              this stage has not been cut a tree yet — the cut is `ensureTree`'s job
//   { lost: {path, stage} }       the tree was recorded and is gone (a park, never a second cut)
//
// A `pr`-KIND CHAIN STAGE IS THE FIFTH ANSWER, and it is not a stage tree at all. A stage tree is a work branch and
// stays local only (lib/pipeline-assembly.js rule 5): a stage that pushed its own branch would open a pull request
// holding one stage of the round. But a stage whose declared artifact IS the pull request (`landsAsPr`) has no work
// of its own to keep local: its work is to act on the branch that LANDS, and under a round that branch is the round's
// parent tree (lib/pipeline-assembly.js, `round.parentPath`). Answering the parent tree is what lets sefl-review-loop's
// `push` and `pr` stages push the assembled branch and open ONE pull request from it, instead of each being handed a
// stage child and the local-only paragraph that made them refuse (rows 66 and 67, jobs ffaabbf3 and 3733218c).
export function stageTreeLookup(task, pipeline, run = null, options = {}) {
  const record = isObject(run) ? run : isObject(task && task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
  // The ISOLATION first, then the graph: a `shared` pipeline that happens to draw a fork keeps one tree for every
  // stage, which is the whole point of the default. Reading the block alone would send a shared row looking for a
  // lane tree it never cut and calling the stage `needed` — a second tree for a row that already has one.
  const plan = isolationOf(pipeline) === ISOLATION_PER_STAGE ? fanOutOf(pipeline) : null;
  const role = stageRoleOf(plan, record && record.stage);
  // A NOTE ON THE TWO MODELS AT ONCE. A fan-out's LANE and JOIN answer their own tree (the block's base). Every other
  // stage answers its own tree too — cut from the ROUND's frozen parent — which is the model this replaces the row's
  // one shared tree with. A `fork` is the exception on purpose: it is the block's base and it runs in the tree the
  // row already has.
  if (plan && plan.isolate && role && role !== "fork") return ownStageTree(record, role, plan);
  // A CHAIN under a round: one tree per stage, all cut at `round.sha`. A record written BEFORE rounds existed has no
  // `round`, and keeps the model it was cut under — the row's one tree, reused by every stage — so a deploy never
  // re-cuts the trees of rows already in flight.
  if (!roundOf(record)) return treeLookup(task, options);
  // The branch that lands, for the one stage that acts on the remote. `plan` is null for a chain, and a fan-out's
  // lanes are answered above, so this is only ever a chain stage.
  const landing = !plan ? roundLandingOf(record) : null;
  if (landing && landsAsPr(stageById(pipeline, record && record.stage))) return roundLandingTree(landing, record && record.stage);
  return ownStageTree(record, role || "stage", plan);
}

// The round whose own tree is the branch that lands, or null when the record names none. A record written before the
// parent tree existed keeps the older model, where the first stage's own tree was the landing branch and every stage
// tree stayed local; a round with a parent but no path (a hand-written or half-recorded row) is not one either.
function roundLandingOf(record) {
  const round = roundOf(record);
  if (!round || !round.parentPath || !round.parent) return null;
  return round;
}

// The round's parent tree as a stage's workspace: the directory the assembly lands in, on the branch the landing step
// pushes. Answers the same shapes `ownStageTree` does, so the driver cannot tell them apart, including `lost`, which
// parks the row rather than cutting a second tree for a round whose landing branch is gone.
function roundLandingTree(round, stage = null) {
  if (!isDirectory(round.parentPath)) {
    return { path: null, needed: false, lost: { path: round.parentPath, stage: text(stage) || null }, source: null, tree: null, role: "round" };
  }
  return {
    path: round.parentPath,
    needed: false,
    lost: null,
    source: "round",
    tree: { path: round.parentPath, branch: round.parent },
    role: "round",
  };
}

// The tree a stage was cut for, from the two places the record keeps it: its own stage run's entry (written at the
// start, and the ledger that wins when the two disagree) and `pipelineRun.trees[stage]` (written at the cut). Four
// answers, the same four shapes `treeLookup` gives, so the caller cannot tell them apart:
//   { path, needed: false }        the stage's tree, on disk
//   { needed: true }               this stage has not been cut a tree yet — the cut is `ensureTree`'s job
//   { lost: {path, stage} }        the tree was recorded and is gone (a park, never a second cut)
function ownStageTree(record, role, plan = null) {
  const stageId = text(record && record.stage);
  const entry = stageRunFor(record, { stage: stageId });
  const recorded = [
    entry && isObject(entry.tree) && text(entry.tree.path) ? { path: text(entry.tree.path), tree: entry.tree, source: "stageRun", stage: stageId } : null,
    isObject(record.trees) && isObject(record.trees[stageId]) && text(record.trees[stageId].path)
      ? { path: text(record.trees[stageId].path), tree: record.trees[stageId], source: "pipelineRun.trees", stage: stageId }
      : null,
  ].filter(Boolean);
  if (!recorded.length) return { path: null, needed: true, lost: null, source: null, tree: null, role, plan, round: roundOf(record) };
  const live = recorded.find((item) => isDirectory(item.path));
  if (live) {
    return {
      path: live.path,
      needed: false,
      lost: null,
      source: live.source,
      tree: { ...(isObject(live.tree) ? live.tree : {}), path: live.path, branch: text(live.tree && live.tree.branch) || null },
      role,
      plan,
    };
  }
  return { path: null, needed: false, lost: recorded[0], source: null, tree: null, role, plan };
}

// The plan a row is being driven under, derived from the bundle every pass (a copy on the record would outlive the
// graph that owns it (design §2.3). `null` for a graph that draws no block, and for a row whose one tree per ROW is
// the model it was cut under: there the lanes would share a directory, so the block cannot be walked.
//
// THE GRAPH DECIDES THE WALK; THE FLAG DECIDES THE TREES. `isolation: "per-stage"` was the only way into a block while
// one tree per row was every pipeline's default. Under a ROUND every stage already has its own tree, and a document
// that draws a fork and says nothing else was still walked as a CHAIN: `nextStageOf` took the first edge out of the
// fork, never entered the second lane, and the join downstream was handed half its inputs with nothing refusing them
// (the four-stage POC drive: S220#1, S221#1, S223#1, no S222 entry, no S222 tree). A drawn block is walked whenever the
// row runs one tree per stage: `per-stage`, or a record carrying a round. A record written BEFORE rounds existed keeps
// the row's one tree, and there the block must not be walked; its join's missing input is REFUSED instead (the input
// manifest check at the start), so the drop is named rather than silent.
export function fanOutStateOf(pipeline, run = null) {
  const plan = fanOutOf(pipeline);
  if (!plan || !plan.isolate) return null;
  if (isolationOf(pipeline) !== ISOLATION_PER_STAGE && !roundOf(run)) return null;
  return { ...plan, base: fanOutBaseOf(run, plan, stageRunsOf) };
}

// A tree path is claimed by every OPEN row whose own field or worktree normalises to it (§3.5). `claims` carries the
// other queues' rows, because a tree is a directory on the disk and not a property of one queue. A fan-out's lane
// trees are the row's too: they are cut for it, they hold its work, and a second row starting in one would be the
// same collision as two rows in one workspace.
export function treeClaims(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObject(row) || !["queued", "running", "parked"].includes(String(row.state || ""))) continue;
    const run = isObject(row[TASK_PIPELINE_FIELD]) ? row[TASK_PIPELINE_FIELD] : null;
    const laneTrees = isObject(run && run.trees) ? Object.values(run.trees).map((tree) => text(tree && tree.path)) : [];
    const paths = [text(run && run.tree && run.tree.path), text(row.worktree), ...laneTrees].filter(Boolean);
    for (const p of paths) {
      const key = treeKey(p);
      if (!key) continue;
      // A LIST per path, not one row: the row being started is itself an open row naming the tree, so the claim has to
      // be the first OTHER row that names it — a single-value map would hold the row asking the question.
      const held = map.get(key) || [];
      held.push(row);
      map.set(key, held);
    }
  }
  return map;
}

function claimAgainst(key, task, claims) {
  const held = claims.get(key);
  if (!Array.isArray(held)) return null;
  return held.find((other) => String(other.id) !== String(task.id)) || null;
}

// The prompt a stage hands its worker: the stage's own instruction (the loader resolves it from the stage or from
// the role that owns it), then the one line that says which stage and which row this turn is, then — when the caller
// holds the facts — the INPUTS block: paths and hashes, never a summary and never the panel's opinion (§5.2). The
// panel adds no second BRIEF; a stage prompt the driver appended a brief to would be two briefs in one turn. The two
// paragraphs it does add are not briefs: the GATE block names the record the document already made this stage's to
// write, and the TOOLS line names the platform's own rules, which the stage cannot know and cannot read anywhere.
// What an unattended stage worker is told about the tools, in the prompt it is handed. The platform this panel starts
// on (api_server) has no reader at the keyboard, and its policy refuses `execute_code` with "BLOCKED: this session
// runs on an unattended platform". A worker that reaches for it first spends a turn learning that (measured on the
// critic in docs/reviews/ping-pong-round-6-2026-11-08.html, which called it before falling back to `terminal`), and a
// refusal nobody predicted costs the same turn on every stage. The names are the tools the run can actually use, and
// the one it cannot is named too, so the sentence is a rule rather than a menu it has to test.
export const STAGE_TOOLS_LINE =
  "TOOLS — this stage runs unattended: nobody is at the keyboard, and the platform refuses `execute_code` (\"BLOCKED: this session runs on an unattended platform\"). " +
  "Use `terminal` for commands and `read_file`, `write_file` and `patch` for files. A refused tool costs a turn, so do not try one to see whether it works.";

// The gate THIS stage has to answer, when the document put a decision in front of it. The counterpart of the `came
// back` line in `inputsBlock`, which tells a stage to READ the record a gate declared; this tells the stage that OWNS
// the verdict to WRITE it, because the panel never does. Without it a gate with a decision and no road to its record
// parks every row that reaches it: the seat is never told the file exists (the ping-pong's G1 could not be asked —
// docs/reviews/ping-pong-round-6-2026-11-08.html).
function gateLine(pipeline, stage, record = null) {
  const gate = gateAfter(pipeline, text(stage && stage.id));
  const decision = isObject(gate && gate.decision) ? gate.decision : null;
  if (!gate || !decision) return "";
  const outcomes = (Array.isArray(decision.outcomes) ? decision.outcomes : []).map(text).filter(Boolean);
  const shape = outcomes.length ? `{"outcome": ${outcomes.map((outcome) => JSON.stringify(outcome)).join(" | ")}}` : '{"outcome": "…"}';
  const routes = isObject(decision.routes) ? Object.entries(decision.routes) : [];
  const where = routes.map(([outcome, target]) => `${outcome} → ${target === null ? "the pipeline ends here" : `handoff ${target}`}`);
  // The record's path is shown with THIS VISIT's hole filled, because the driver reads it that way (`verdictOf` fills
  // the round): a gate that writes one record per round must not hand the seat a pattern it would have to guess.
  const values = record ? artifactValues(record, text(stage && stage.id)) : null;
  const declared = text(decision.path);
  const shown = declared ? fillHoles(declared, values) : declared;
  return (
    `  verdict     the gate ${text(gate.id)}${text(gate.name) ? ` (${text(gate.name)})` : ""} after this stage declares ${shown} — ` +
    `write it as ${shape}${where.length ? `; the document routes ${where.join(", ")}` : ""}. ` +
    "The panel reads that word and never writes the record for you, so a run that ends without it leaves the row parked on the gate."
  );
}

export function stagePrompt(task, pipeline, stage, { run = null, tree = null, facts = null, fanout = null } = {}) {
  const detail = text(task && task.detail);
  const record = isObject(run) ? run : isObject(task && task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
  const lines = [
    text(stage && stage.prompt),
    "",
    `— ${pipeline.title}: stage ${stage.position} of ${pipeline.stages.length}, ${stage.title} (${pipeline.id}/${stage.id})${
      record ? `, visit ${visitOf(record, stage.id)}` : ""
    }`,
    `Queue task #${task.id}: ${task.title}`,
  ];
  const artifact = artifactLine(stage, record);
  if (artifact) lines.push("", "ARTIFACT", artifact);
  const inputs = record ? inputsBlock({ task, pipeline, stage, run: record, tree, facts, fanout }) : [];
  if (inputs.length) lines.push("", "INPUTS", ...inputs);
  const verdict = gateLine(pipeline, stage, record);
  if (verdict) lines.push("", "GATE", verdict);
  // The brief's own word budget, when it states one: quoted back with the brief's phrasing so the stage reads one
  // number rather than the brief's prose and the panel's guess at it. A brief that states none adds no line (see
  // lib/word-budget.js), which is the decision: there is no default ceiling.
  const budget = budgetBlock(detail);
  if (budget.length) lines.push("", ...budget);
  if (detail) lines.push("", detail);
  lines.push("", STAGE_TOOLS_LINE);
  return lines.join("\n");
}

// WHERE this stage's output goes. The declared path is a PATTERN, and the visit's own holes are filled here with the
// same values the gate's record and the settle's artifact check use — `{{round}}` is this visit, so a loop's second
// round writes `draft-r2.md` and never overwrites `draft-r1.md`. That is the round-7 defect the dossier's first item
// names: all three drafts wrote one path, and the only per-round identity was the stage run's pin.
//
// The line is AUTHORITATIVE over the brief's prose, and says so. The panel checks the DECLARED artifact at settle, so
// a brief that still names `draft.md` would send the agent to a file nobody checks — and the stage would park on a
// missing artifact it had written under another name.
function artifactLine(stage, record) {
  const declared = isObject(stage && stage.artifact) ? stage.artifact : null;
  if (!declared) return "";
  const rel = fillHoles(text(declared.path), artifactValues(record, text(stage && stage.id))) || "(no path)";
  const facts = [text(declared.schema) || null, `kind ${text(declared.kind) || "unstated"}`].filter(Boolean).join(", ");
  const writer = text(declared.writer);
  return `  writes      ${text(declared.id) || "(unnamed)"}   ${rel}   (${facts})${writer ? `   writer ${writer}` : ""} — the file the panel checks when this stage settles; where the brief below names another path, this one is authoritative`;
}

// The INPUTS block. Four rules decide its shape (design §5.2): the panel RESOLVES and the agent READS; a gate's
// decision is named and never read; a loop back names the earlier visit's artifact as the same file; tree facts are
// facts, not cleanups. Every line is optional, because a fact the panel does not hold is not printed as a guess.
function inputsBlock({ task, pipeline, stage, run, tree = null, facts = null, fanout = null }) {
  const lines = [];
  const handoffs = Array.isArray(pipeline && pipeline.handoffs) ? pipeline.handoffs : [];
  // The block PRINTS what the manifest STORES (`inputManifest`): one reader of "which file is this artifact", so the
  // sentence a stage's agent reads and the record a reader checks afterwards name the same path.
  const artifactById = (id) => declaredArtifactOf(pipeline, id);
  const visit = run ? visitOf(run, stage.id) : 1;
  // The tree this stage's inputs are read in: its own record first, then the tree the caller resolved, then the
  // workspace its worker ran in, and the row's tree only as the last answer. The row's tree is the ROUND's under a
  // round, so a block resolved at it would name a parent's copy of a file this stage never wrote (#260).
  const worktree = artifactTreeOf(run, stage && stage.id, [tree && tree.path, task && task.worktree, run && run.tree && run.tree.path]).path;
  // The join of a fan-out is the ONE reader across lanes. It did not arrive by an edge — the aggregate put every
  // lane's artifact in its tree — so its block names each lane by pin and says that the checkout holds the merge.
  // Naming only the last lane's handoff (what `arrived` would find) would tell the aggregator it was handed one
  // report when it was handed all of them.
  const joinOf = Boolean(fanout && fanout.isolate && stage && stage.id === fanout.join);
  if (joinOf) {
    const laneLines = mergedLanes({ pipeline, run, fanout, worktree });
    if (laneLines.length) lines.push(...laneLines);
    lines.push(...treeLines({ worktree, tree, run, facts }));
    return lines;
  }

  // The edge the row arrived by, from the RECORD (`via`) and nothing else. The fallback this replaced — the last
  // handoff whose `to` is this stage — made visit 1 of a pipeline's first stage advertise the LOOP into it
  // (`handed on verify … not in the tree`) for a stage that had never run, naming a hand-off the sender never wrote.
  // A record with no `via` has crossed nothing, so the block names nothing.
  const arrived = handoffs.find((h) => text(h.id) === text(run && run.via)) || null;
  if (arrived) {
    const held = artifactById(arrived.artifact);
    // The PIN, from the writer's own stage run: the commit it settled at and the blob the artifact had there. A
    // branch name is deliberately not printed as the input's identity — it resolves differently tomorrow, and the
    // agent is told to read `git show <commit>:<path>`, which cannot.
    const pin = writerArtifactOf(run, arrived.artifact);
    // The writer's recorded FILE is what this stage is handed; the declaration is only a pattern, and one a round
    // hole makes ambiguous. Resolving the file first is what names `r7/…` for the visit that wrote it.
    const rel = pin ? text(pin.file) || text(pin.path) : held ? text(held.path) : null;
    const resolved = held && rel ? artifactOf({ id: held.artifact, path: rel }, { worktree, values: artifactValues(run, held.stage), commit: pin ? text(pin.commit) : null }) : null;
    const cap = capOf(arrived);
    const crossings = Number(run && isObject(run.crossings) ? run.crossings[arrived.id] : 0) || 0;
    const kind = text(arrived.kind) || "sequence";
    const bound = kind === "loop" && cap.limit != null ? ` — crossing ${crossings} of a cap of ${cap.limit}` : "";
    const writer = held && !held.external ? text(held.writer) || "(unnamed)" : "";
    const where = resolved ? resolved.file || resolved.path : null;
    // The record names the edge, and no writer has produced the artifact: say THAT, rather than printing a path and a
    // hash column that read like a file the stage was handed. The edge is real; the hand-off has not happened yet.
    if (!pin && resolved && resolved.present === false) {
      lines.push(`  handed on   ${text(arrived.artifact) || "(no artifact)"}   ${where}   nothing written yet   (${text(arrived.from)} → ${text(arrived.to)}, handoff ${text(arrived.id)}, ${kind}${bound})`);
      lines.push(`              the record names this edge and no writer has recorded the artifact${writer ? ` (${writer})` : ""} — there is nothing to read yet`);
    } else {
      const at = pin && text(pin.commit)
        ? `commit ${shortSha(pin.commit)}   ${text(pin.blob) ? `blob ${shortSha(pin.blob)}` : "blob (the file is not in the commit)"}`
        : "commit (none recorded)";
      const hash = pin && text(pin.blobSha256)
        ? `sha256 ${pin.blobSha256.slice(0, 12)}…`
        : resolved && resolved.sha256
          ? `sha256 ${resolved.sha256.slice(0, 12)}…`
          : "no hash";
      lines.push(
        `  handed on   ${text(arrived.artifact) || "(no artifact)"}   ${where || text(arrived.artifact)}   ${at}   ${hash}${writer ? `   writer ${writer}` : ""}`,
      );
      const readAt = pin && text(pin.commit) && rel ? `; read it at ${shortSha(pin.commit)}:${rel}` : "";
      lines.push(`              (${text(arrived.from)} → ${text(arrived.to)}, handoff ${text(arrived.id)}, ${kind}${bound}${readAt})`);
      // The checkout is not the pin any more. The agent is told which to read, so a moved working file cannot become a
      // silent substitution for the bytes the writer settled with.
      if (pin && text(pin.commit) && rel) {
        if (!pin.blob) {
          lines.push(`              the artifact is uncommitted work — there is no blob for it at ${shortSha(pin.commit)}`);
        } else if (resolved && resolved.at) {
          // A per-stage tree: the stage runs in its OWN workspace, cut at the round's frozen parent, so the writer's
          // file is deliberately not beside it. Saying which commit holds it is the whole handoff.
          lines.push(`              the artifact is NOT in this stage's tree — it was written in another stage's tree; read it at ${shortSha(pin.commit)}:${rel} (git show ${shortSha(pin.commit)}:${rel})`);
        } else if (resolved && resolved.present === false) {
          lines.push(`              the file is gone from the checkout; read it at the pin`);
        } else {
          const onDisk = workingBlobOf(worktree, rel);
          if (onDisk && onDisk !== text(pin.blob)) lines.push(`              the working file has moved off the pin — read the blob, not the checkout`);
        }
      }
    }
  }
  const gate = arrived ? gateAfter(pipeline, text(arrived.from)) : null;
  if (gate && gate.decision) {
    lines.push(`  came back   the row arrived by ${text(arrived.id)} from ${text(arrived.from)}; the gate ${text(gate.id)} after it declares ${text(gate.decision.path)} — read it; the panel does not read it for you`);
  }
  // The earlier visit's artifact: the one input a fresh agent cannot reconstruct, and the reason a loop back parks
  // when it is gone (§5.2 rule 3).
  if (visit > 1 && stage && isObject(stage.artifact)) {
    const previous = [...stageRunsOf(run)].reverse().find((entry) => text(entry.stage) === text(stage.id) && Number(entry.visit) < visit && entry.artifact);
    const now = artifactOf(stage.artifact, { worktree, values: artifactValues(run, stage.id) });
    const was = previous && previous.artifact ? previous.artifact : null;
    if (was) {
      // The earlier visit's OWN pin is named: the commit it settled at and the blob it wrote, which is what "the
      // same file came back" means. Compared by blob id (a checkout's bytes can differ from the blob's on Windows
      // without any content change), falling back to the working hash for a record from before the pin.
      const wasBlob = workingBlobOf(worktree, text(was.file) || text(was.path));
      const same = wasBlob && text(was.blob) ? wasBlob === text(was.blob) : Boolean(was.sha256 && now && now.sha256 && was.sha256 === now.sha256);
      const pinText = text(was.commit)
        ? `commit ${shortSha(was.commit)}   ${text(was.blob) ? `blob ${shortSha(was.blob)}` : "blob (the file is not in the commit)"}   `
        : "";
      const wasHash = text(was.blobSha256) || text(was.sha256);
      lines.push(
        `  earlier     ${text(stage.artifact.id)}   ${text(was.file) || was.path || text(stage.artifact.path)}   ${pinText}sha256 ${wasHash.slice(0, 12) || "(none)"}   (this stage, visit ${Number(previous.visit)} — ${same ? "unchanged" : "changed since"})`,
      );
    }
  }
  lines.push(...treeLines({ worktree, tree, run, facts }));
  return lines;
}

// The tree's own two lines: where the stage runs, on which branch, at which HEAD, with how many uncommitted files.
// One renderer, because the join's block returns early and a second copy of these two lines would drift.
function treeLines({ worktree, tree = null, run = null, facts = null }) {
  if (!text(worktree)) return [];
  const lines = [`  tree        ${worktree}   branch ${text(tree && tree.branch) || text(run && run.tree && run.tree.branch) || "(unknown)"}`];
  const head = text(facts && facts.head);
  const dirty = facts && Number.isFinite(Number(facts.dirty)) ? Number(facts.dirty) : null;
  if (head || dirty != null) {
    lines.push(`              ${head ? `HEAD ${head}` : "HEAD unknown"}   ${dirty != null ? `${dirty} uncommitted file${dirty === 1 ? "" : "s"}` : "uncommitted files unknown"}`);
  }
  return lines;
}

// Every lane a fan-out's join is handed, by PIN — the artifact, the path, the commit the lane settled at, the blob and
// its sha256, the writer the document names, and the branch the lane ran on. These are the facts the aggregator reads;
// a summary of them would be the panel's opinion, which §5.2 rule 1 forbids.
function mergedLanes({ pipeline, run, fanout, worktree }) {
  if (!fanout || !Array.isArray(fanout.lanes)) return [];
  const lines = [];
  const settled = (lane) => [...stageRunsOf(run)].reverse().find((entry) => text(entry.stage) === lane && text(entry.status) === "done");
  for (const lane of fanout.lanes) {
    const entry = settled(lane);
    if (!entry) continue;
    const artifact = isObject(entry.artifact) ? entry.artifact : {};
    const declared = declaredArtifactOf(pipeline, artifact.id);
    const rel = text(artifact.file) || text(artifact.path) || (declared ? text(declared.path) : null);
    const pin = text(artifact.commit) ? `commit ${shortSha(artifact.commit)}   ${text(artifact.blob) ? `blob ${shortSha(artifact.blob)}` : "blob (the file is not in the commit)"}` : "commit (none recorded)";
    const hash = text(artifact.blobSha256) ? `sha256 ${text(artifact.blobSha256).slice(0, 12)}…` : text(artifact.sha256) ? `sha256 ${text(artifact.sha256).slice(0, 12)}…` : "no hash";
    const writer = declared && text(declared.writer) ? `   writer ${text(declared.writer)}` : "";
    lines.push(`  lane        ${lane}   ${text(artifact.id) || "(no artifact)"}   ${rel || "(no path)"}   ${pin}   ${hash}${writer}   (branch ${text(entry.tree && entry.tree.branch) || "(unknown)"})`);
  }
  const merge = isObject((stageRunFor(run, { stage: fanout.join }) || {}).merge) ? (stageRunFor(run, { stage: fanout.join }) || {}).merge : null;
  if (merge && text(merge.commit)) {
    lines.push(`  aggregate   ONE merge of ${Array.isArray(merge.branches) ? merge.branches.length : lines.length} stage branches — commit ${shortSha(merge.commit)}${text(merge.base) ? ` from base ${shortSha(merge.base)}` : ""}; the checkout above holds it, and each lane is read at its own commit`);
  } else if (lines.length) {
    lines.push("  aggregate   the lanes are pinned above; the one merge has not been recorded yet");
  }
  if (worktree && lines.length) lines.push("              only this stage reads across lanes — no sibling read another's files mid-flight");
  return lines;
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
