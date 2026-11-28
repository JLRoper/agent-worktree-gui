// The tree a stage writes in, and the brief it is handed.
//
// Cut 2 of the two in lib/task-pipeline-drive.js's split (row #534 of the module-separation work). Lines
// 1,217-1,218 and 1,230-1,816 of lib/task-pipeline-drive.js at b0ce9aa6, moved verbatim: the tree key, the filed
// tree, the three-answer tree lookup, the round, the assembly plan, the stage tree, the fan-out state, the tree
// claims and the stage prompt with the blocks it prints. Nothing was renamed and no body was rewritten.
//
// It reads the document side from lib/task-pipeline-document.js: the graph, the manifest, the gate and the verdict,
// plus text, isObject, landsAsPr and isDirectory. treeKey, roundLandingOf and claimAgainst are exported for the
// driver's own pass, not for a caller of lib/task-pipeline-drive.js.

import path from "node:path";

import { stageById } from "./pipeline-bundle.js";
import { fanOutBaseOf, fanOutOf, ISOLATION_PER_STAGE, isolationOf, stageRoleOf } from "./pipeline-fanout.js";
import { isMainName } from "./parents.js";
import { shortSha, workingBlobOf } from "./stage-pin.js";
import { budgetBlock } from "./word-budget.js";
import { TASK_PIPELINE_FIELD, stageRunFor, stageRunsOf, visitOf } from "./task-pipeline.js";
import {
  artifactOf,
  artifactTreeOf,
  artifactValues,
  capOf,
  declaredArtifactOf,
  fillHoles,
  gateAfter,
  inputManifest,
  isDirectory,
  isObject,
  landsAsPr,
  nextStageOf,
  STARTING_AT,
  text,
  verdictOf,
  writerArtifactOf,
} from "./task-pipeline-document.js";

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

// Read by the driver's own pass, not by a caller: the tree key, the landing tree of a round and the claim test.
export { treeKey, roundLandingOf, claimAgainst };
