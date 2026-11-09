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
//
// The row that reaches the front of the queue is the one that starts. "Front" is the queue's own order
// (`byQueueOrder`) over the rows that can move — queued and running — so a pipeline row behind a queued row with no
// pipeline waits its turn instead of jumping the queue it was filed in.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { byQueueOrder, currentThread, setTaskState } from "./assistant/queue.js";
import { pipelineById, stageById } from "./pipeline-bundle.js";
import { aggregateBranchesOf, fanOutBaseOf, fanOutOf, ISOLATION_PER_STAGE, isolationOf, stageRoleOf } from "./pipeline-fanout.js";
import { commitOf, pinCheck, pinOf, relInTree, shortSha, workingBlobOf } from "./stage-pin.js";
import { HOLD_OWNER_MS, isRunWait } from "./pipelines.js";
import { budgetBlock } from "./word-budget.js";
import {
  TASK_PIPELINE_FIELD,
  beginStageRun,
  enterStage,
  recordStageDecision,
  resolveTaskPipeline,
  settleStageRun,
  stageRunFor,
  stageRunsOf,
  visitOf,
  visitsOf,
} from "./task-pipeline.js";

// The named reasons a stage can stop for. A journal line and a test both name one of these rather than matching a
// sentence, and the sentence is free to improve without the name moving.
export const DRIVE_FAULTS = Object.freeze({
  CAP: "pipeline-cap", // a loop edge at (or past) the crossings its cap allows
  GATE: "pipeline-gate", // a gate whose decision record has not been written
  FAILED: "pipeline-run-failed", // the stage's run ended in failure
  UNRESOLVED: "pipeline-unresolved", // the record names a pipeline or stage the bundle does not hold
  NO_TARGET: "pipeline-no-target", // nowhere to start: no tree and no project on the row
  STARTING: "pipeline-starting", // a start for this stage is already in flight
  // The four this design adds (§6.1). Each one is a fact the panel can test and the row's decision record names, so a
  // reader afterwards can ask "why did it stop" without parsing the sentence.
  ARTIFACT: "pipeline-artifact", // the stage settled, and the artifact it declares is not in the tree
  TREE_GONE: "pipeline-tree-gone", // the row had a tree, and the directory it named is no longer there
  TREE_CLAIMED: "pipeline-tree-claimed", // another open row's tree normalises to the same directory
  CHANGED: "pipeline-changed", // the routing fingerprint moved since the row entered this stage
  START_REFUSED: "pipeline-start-refused", // the spawner (or the cut) refused; nothing was started
  REFUSE_INPUT: "pipeline-refuse-input", // the input's pinned commit is not this tree: refuse, never read a different one
  // The gate's decision record is THERE but names no outcome, or one its `routes` map does not hold. The panel obeys a
  // route the document declared and refuses to guess one: a verdict it cannot route parks rather than ending a loop
  // the document did not say was over.
  VERDICT: "pipeline-verdict",
  // A fan-out's lanes could not be combined: `git merge-tree --write-tree` named the paths they both wrote, and the
  // aggregate merge was never started. The row parks here rather than in a half-merged tree (lib/pipeline-aggregate.js).
  CONFLICT: "pipeline-conflict",
  // A per-stage round could not be assembled: two stages changed the same lines of one path, or git could not pick a
  // stage's commit. The row parks rather than landing a branch that is missing a stage (lib/pipeline-assembly.js).
  ASSEMBLY: "pipeline-assembly",
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

// The ONE artifact kind this module acts on. A stage whose artifact is the pull request that carries its work is
// finished by the settle's landing rule (`lib/assistant/queue.js` `settleTasks`: the row's tree must read MERGED). Any
// other kind — a document, a report, a build, or the null every bundle written before this field carries — is a stage
// with no PR to land, and a row left to that rule would stay `running` for ever. So the driver finishes it itself.
export const PR_ARTIFACT_KIND = "pr";

const FAILED_STATUS = new Set(["failed", "error", "cancelled", "canceled", "stopped", "exited", "interrupted", "timeout"]);

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Does this stage's work land as a pull request? The document says so with one artifact kind; everything else is a
// stage whose output is a file in the tree, and the landing rule has no PR to read for it.
const landsAsPr = (stage) => text(stage && stage.artifact && stage.artifact.kind).toLowerCase() === PR_ARTIFACT_KIND;

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

// A `{{hole}}` the caller can FILL is a literal, not a match. `{{round}}` is the round this visit is in — the file is
// `r3/round-brief.json`, never "the first `r*` that sorts" — and `values` maps each hole name the caller knows to its
// value. A hole with no value is left for `segmentRegex`, which is what a gate's per-finding record needs.
export function fillHoles(rel, values = null) {
  const source = String(rel ?? "");
  if (!isObject(values)) return source;
  return source.replace(/\{\{([^}]*)\}\}/g, (whole, name) => {
    const key = String(name).trim();
    const value = values[key];
    if (value === undefined || value === null) return whole;
    const filled = String(value).trim();
    return filled || whole;
  });
}

// Resolve a decision path against the task's tree. Answers a path only when it is THERE: a path this function
// invented for a file nobody wrote is the "record exists" lie the barrier exists to prevent.
//
// `shown` is the path as DECLARED (a hole the caller could not fill stays `{{...}}`, which is what a reader sees);
// `file` is the path the walk actually resolved, tree-relative, so a pin can be taken against the file that exists
// rather than against a pattern git cannot look up.
export function decisionPathOf(rel, { worktree = null, values = null } = {}) {
  const clean = fillHoles(rel, values).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean) return { found: false, path: null, shown: null, file: null, reason: "the gate names no decision path" };
  const base = text(worktree);
  // An absolute path (POSIX, or a Windows drive) is rooted where it says and the tree is not consulted: the studio
  // writes workspace-relative paths, and a reader may pin one outside the tree.
  const absolute = /^(?:[a-zA-Z]:)?\//.test(clean);
  if (!absolute && !base) return { found: false, path: null, shown: clean, file: null, reason: "the task has no tree, and the decision record is read from the tree" };
  const segments = clean.split("/").filter((s) => s && s !== "." && s !== "..");
  const shown = absolute ? path.normalize(clean) : path.join(base, ...segments);
  // The segments as they RESOLVE, so the caller can pin the file rather than the pattern it was declared with.
  const walked = [];
  let dir;
  if (!absolute) dir = base;
  else if (/^[a-zA-Z]:$/.test(segments[0] || "")) dir = `${segments.shift()}/`;
  else dir = path.parse(path.resolve("/")).root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (!segment.includes("{{")) {
      dir = path.join(dir, segment);
      walked.push(segment);
      if (last) return existsSync(dir) ? { found: true, path: dir, shown, file: absolute ? null : walked.join("/"), reason: null } : { found: false, path: null, shown, file: null, reason: null };
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return { found: false, path: null, shown, file: null, reason: null };
      continue;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { found: false, path: null, shown, file: null, reason: null };
    const re = segmentRegex(segment);
    // The first match in sort order is the matcher's fallback, and it is right for a gate that writes one record per
    // finding: the barrier only asks whether the record is there. An ARTIFACT is different, and it is why `values`
    // exists — a stage's file for a round must be that round's own file, never r1 because r1 sorts first.
    const match = readdirSync(dir).filter((name) => re.test(name)).sort()[0];
    if (!match) return { found: false, path: null, shown, file: null, reason: null };
    dir = path.join(dir, match);
    walked.push(match);
  }
  const there = existsSync(dir);
  return there
    ? { found: true, path: dir, shown, file: absolute ? null : walked.join("/"), reason: null }
    : { found: false, path: null, shown, file: null, reason: null };
}

// The ARTIFACT path is the same matcher, under its own name: a stage declares an artifact with a workspace-relative
// path and exactly one writer, and the panel resolves it the way it resolves a gate's decision — against the tree,
// with `{{hole}}` segments matching one segment. One matcher, so the two cannot disagree about what "the file is
// there" means.
//
// `values` is the difference a ROUND makes: a stage whose path carries `{{round}}` wrote `r7/…` on its seventh
// visit, and resolving the pattern to the first `r*` that sorts records r1's bytes against visit 7's settle. The
// caller passes the holes it knows; a hole with no value keeps the one-segment match.
export function artifactPathOf(rel, { worktree = null, values = null } = {}) {
  return decisionPathOf(rel, { worktree, values });
}

// What a stage's declared artifact is, AT THE MOMENT THE STAGE SETTLED (§5.3): its id, the path resolved against the
// tree, whether it is there, and its sha256. The hash is stored because the tree changes afterwards — a later reader
// must see the state the driver acted on, and a loop-back visit can then say "unchanged" without a second opinion.
// Files over 1 MiB record `present` only: hashing a 2 GB log in a sweep is a stall, not a check.
//
// `commit` is the HANDOFF half: a stage tree is cut at the round's frozen parent, so the draft a critique stage was
// handed is not in its own workspace at all. The writer's pin names the commit it settled at, and git can read the
// blob from there — worktrees of one repository share an object store — so the artifact is `present: true`, hashed
// from the BLOB, and `at` says which commit it was read at. Without it a per-stage tree would report every handoff
// `present: false` and the input would read as missing when it is exactly where the document said it would be.
export const ARTIFACT_HASH_MAX = 1024 * 1024;

export function artifactOf(artifact, { worktree = null, values = null, commit = null } = {}) {
  const a = isObject(artifact) ? artifact : null;
  if (!a) return null;
  const id = text(a.id) || null;
  const rel = text(a.path);
  const resolved = artifactPathOf(rel, { worktree, values });
  // `file` is what the pattern resolved to, tree-relative. `path` stays the declaration, because that is what the
  // document says and what a reader compares a bundle against; `file` is the one a pin or a `git show` can name.
  const out = { id, path: rel || null, shown: resolved.shown, file: resolved.file || null, present: false, sha256: null, tooLarge: false };
  if (!resolved.found) {
    const at = text(commit);
    if (!at || !rel || !text(worktree)) return out;
    const pinned = pinOf(worktree, rel, { commit: at });
    if (!pinned.blob) return out;
    return {
      ...out,
      present: true,
      at,
      blob: pinned.blob,
      sha256: pinned.sha256,
      ...(Number.isFinite(Number(pinned.bytes)) ? { bytes: pinned.bytes } : {}),
      ...(pinned.tooLarge ? { tooLarge: true } : {}),
    };
  }
  out.present = true;
  try {
    const info = statSync(resolved.path);
    out.bytes = info.size;
    if (!info.isFile()) return out;
    if (info.size > ARTIFACT_HASH_MAX) {
      out.tooLarge = true;
      return out;
    }
    out.sha256 = createHash("sha256").update(readFileSync(resolved.path)).digest("hex");
  } catch {
    // A file that vanished between the resolve and the read is not an artifact: `present` stays false rather than the
    // settle reporting a hash of nothing.
    out.present = false;
    out.sha256 = null;
  }
  return out;
}

// ---- the input manifest --------------------------------------------------------------------------------------------
// What a stage is HANDED, resolved once and STORED on the stage run (§5.3): every artifact instance the document says
// this stage reads — the handoff it arrived by, the artifact an earlier visit produced, and each `inputs.read[]` — with
// its path, the sha256 it had when the stage was handed it, whether it was there, the writer the document names, and
// the edge it arrived by.
//
// The INPUTS block is these facts PRINTED; the manifest is the same facts STORED, so a reader can answer "what did this
// stage start with" after the run is gone and after the tree has changed. `present` is resolved from the TREE, never
// from the document (a document cannot say whether a file is there), and an id the document gives no path for — an
// external input, a read of an artifact nothing declares — is recorded with `present: null`, never as an empty file.
export const INPUTS_MAX = 24;

// The artifact a document declares for an id: the stage that writes it, or the document's own `external_inputs` entry.
// One reader, so the block that PRINTS a stage's inputs and the manifest that STORES them cannot disagree about which
// file an id names.
export function declaredArtifactOf(pipeline, id) {
  const wanted = text(id);
  if (!wanted || !isObject(pipeline)) return null;
  for (const stage of Array.isArray(pipeline.stages) ? pipeline.stages : []) {
    if (isObject(stage.artifact) && text(stage.artifact.id) === wanted) {
      return { artifact: wanted, path: text(stage.artifact.path) || null, writer: text(stage.artifact.writer) || null, stage: text(stage.id) || null, external: false };
    }
  }
  for (const entry of Array.isArray(pipeline.externalInputs) ? pipeline.externalInputs : []) {
    if (text(entry && entry.artifact) === wanted) {
      return { artifact: wanted, path: null, writer: null, stage: null, external: true, source: text(entry.source) || null };
    }
  }
  return null;
}

// The hole values the driver can FILL into a declared artifact path, and the only ones it knows: the ROUND is the
// visit the stage is in, because a loop body's visit IS its round (the stage writes `r{{round}}`, and a second visit
// that wrote r1 again would be the loop doing nothing). A path with a hole the driver cannot fill keeps the matcher's
// one-segment rule, and a writer's own recorded `file` is what a later stage resolves a handoff against.
export function artifactValues(run, stageId) {
  const visit = Number(visitOf(run, stageId));
  return Number.isInteger(visit) && visit > 0 ? { round: visit } : null;
}

// The artifact the stage that WROTE `id` settled with, as it left it on its stage run — the pin: `{commit, blob,
// blobSha256, path, file}`. This is the record a handoff is read from, and the reason a later stage cannot be handed
// whatever the branch says today: the writer's own settle is the only commit the artifact is known to exist in.
export function writerArtifactOf(run, id) {
  const wanted = text(id);
  if (!wanted) return null;
  const entries = stageRunsOf(run).filter(
    (entry) => isObject(entry && entry.artifact) && text(entry.artifact.id) === wanted && text(entry.artifact.commit),
  );
  return entries.length ? entries[entries.length - 1].artifact : null;
}

// The tree a stage WROTE IN, from the record alone: the tree its stage run carries (written when the start was asked
// for), else the tree the round cut for that stage (`pipelineRun.trees[stage]`). `commit` is the HEAD the record
// names, and it is the read basis when the working file is not there.
//
// `pipelineRun.tree` is deliberately NOT a candidate. Under a round it is the tree the ROUND began in
// (lib/assistant.js `cutPipelineTree`: a stage's or a lane's tree is never promoted to it), so reading it for a
// stage's artifact reads a parent's checkout. That is the false verdict of #260: its implement stage settled
// `present: false` for a change-set committed in its OWN tree at 49278bee, and the row parked on handoff H-02.
export function recordedStageTree(run, stageId) {
  const id = text(stageId);
  if (!id) return { path: null, commit: null, branch: null, source: null };
  const entry = stageRunFor(run, { stage: id });
  const own = isObject(entry && entry.tree) ? entry.tree : null;
  const cut = isObject(run && run.trees) && isObject(run.trees[id]) ? run.trees[id] : null;
  const path = text(own && own.path) || text(cut && cut.path) || null;
  return {
    path,
    commit: text(own && own.commit) || text(entry && entry.commit) || null,
    branch: text(own && own.branch) || text(cut && cut.branch) || null,
    source: path ? (text(own && own.path) ? "stageRun" : "pipelineRun.trees") : null,
  };
}

// The tree an ARTIFACT READ resolves against: the stage's own record first, then the caller's candidates in the order
// that caller knows. Every caller lists the trees the stage could have written in, and the row's tree is the LAST of
// them: a read that starts at the row is how a round's parent checkout answered for a stage that never wrote there.
function artifactTreeOf(run, stageId, candidates = []) {
  const own = recordedStageTree(run, stageId);
  return { ...own, path: own.path || candidates.map((value) => text(value)).find(Boolean) || null };
}

// The handoff a stage being STARTED arrives by, and the pin the stage that wrote it recorded. The edge is the one
// the RECORD holds (`run.via`), never one guessed from the graph: a first visit has crossed nothing, and the old
// fallback — "the last handoff whose `to` is this stage" — announced the loop into a pipeline's first stage on visit 1
// (`handed on verify … not in the tree`), naming a hand-off the sender had never produced.
export function handedOnPinOf(pipeline, stage, run) {
  const handoffs = Array.isArray(pipeline && pipeline.handoffs) ? pipeline.handoffs : [];
  const arrived = handoffs.find((handoff) => text(handoff.id) === text(run && run.via)) || null;
  if (!arrived) return null;
  const artifact = writerArtifactOf(run, arrived.artifact);
  if (!artifact || !text(artifact.commit)) return null;
  return {
    handoff: text(arrived.id) || null,
    artifact: text(arrived.artifact) || null,
    path: text(artifact.path) || null,
    file: text(artifact.file) || text(artifact.path) || null,
    commit: text(artifact.commit),
    blob: text(artifact.blob) || null,
  };
}

// One instance, resolved against the tree. `via` says how it got here: `handoff` (the edge the row crossed),
// `earlier` (this stage's own earlier visit) or `read` (the stage's `inputs.read[]`).
//
// `pin` is the writer's recorded artifact when the document's id names one the record already knows, and it WINS over
// a fresh reading of the file: the stage is handed the commit and blob the writer settled with, not the bytes that
// happen to be checked out now. With no recorded pin the entry is resolved at `commit` (the tree's HEAD when the
// start was asked for) — and an entry that resolves no commit says so by carrying none, rather than naming a branch.
function manifestEntry({ artifact, declared, worktree, values = null, edge = null, via = "read", sha256 = null, present = undefined, pin = null, commit = null }) {
  const id = text(artifact);
  if (!id) return null;
  // A writer's own record names the FILE it settled with; a declaration is a pattern. The file wins, so a handoff is
  // resolved at the round the writer actually wrote rather than at the first `r*` that sorts.
  const pinnedRel = pin ? text(pin.file) || text(pin.path) : null;
  const rel = pinnedRel || (declared ? text(declared.path) || null : null);
  const recorded = isObject(pin) && text(pin.commit) ? pin : null;
  // The working copy first, then the WRITER'S COMMIT: a per-stage tree does not hold the previous stage's files, and
  // the pin is exactly the answer to "where is it then" (see artifactOf).
  const found = rel && text(worktree) ? artifactOf({ id, path: rel }, { worktree, values, commit: recorded ? text(recorded.commit) : null }) : null;
  const file = found ? found.file || (found.shown ? relInTree(worktree, found.shown) : null) : null;
  const fresh = recorded || !rel ? null : pinOf(worktree, file || rel, { commit: text(commit) || null });
  const source = recorded || fresh;
  const blobSha256 = recorded ? text(recorded.blobSha256) || null : fresh ? text(fresh.sha256) || null : null;
  return {
    artifact: id,
    path: rel,
    // The tree-relative path the commit names, when a `{{hole}}` in the declaration resolved to a real file: the pin
    // is against the file that was written, and the document's pattern is not a path git can look up.
    ...(file && file !== rel ? { file } : {}),
    // The hash the stage was handed. An earlier visit's entry knows its own; a fresh resolve hashes the file now. A
    // file that is not there has no hash — null, never the digest of nothing.
    sha256: present === false ? null : found && found.present ? found.sha256 : sha256 || null,
    present: present !== undefined ? present : found ? Boolean(found.present) : null,
    writer: declared ? declared.writer || null : null,
    edge: text(edge) || null,
    via,
    // The pin: the commit the input is read at, the blob's object id, and the sha256 of the BLOB's bytes (not of the
    // checkout — with autocrlf on, identical content hashes differently on disk than in the object store).
    ...(source && text(source.commit) ? { commit: text(source.commit) } : {}),
    ...(source && text(source.blob) ? { blob: text(source.blob), blobSha256 } : {}),
    // Where it was actually read when it was not in this stage's own tree: the file a critique stage was handed and
    // can only see at the writer's commit.
    ...(found && found.at && found.present ? { readAt: found.at } : {}),
  };
}

// Every input instance the stage is handed, at the moment the start is asked for. Returns `{ entries, dropped }` — the
// overflow is COUNTED rather than silently cut, because a manifest that quietly loses an input is worse than none.
export function inputManifest({ pipeline, stage, run = null, worktree = null, visit = null, commit = null } = {}) {
  const p = isObject(pipeline) ? pipeline : {};
  const s = isObject(stage) ? stage : null;
  if (!s) return { entries: [], dropped: 0 };
  // The tree this stage is handed its inputs in: its own record first, then the tree the caller resolved for it, and
  // only then where the row is pointed. Resolving at the row's tree is what a round's parent checkout would answer
  // from, and an input read there is a different file wearing the same path (#260).
  const where = artifactTreeOf(run, s.id, [worktree, run && run.tree && run.tree.path]).path;
  const handoffs = Array.isArray(p.handoffs) ? p.handoffs : [];
  // The edge the row arrived by, from the RECORD only (`via`). Deriving it from the graph — "the last handoff whose
  // `to` is this stage" — is how visit 1's manifest used to carry the loop's artifact before the loop had ever been
  // crossed: a hand-off nobody had produced, recorded as an input the stage was handed.
  const arrived = handoffs.find((handoff) => text(handoff.id) === text(run && run.via)) || null;
  const entries = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry) return;
    // One instance per artifact: a stage that reads the artifact a handoff already carried it is handed that
    // artifact once, and the thicker edge (the handoff) is the one recorded. The earlier visit's own artifact is a
    // different instance, but it is only ever added for an id nothing else named — a loop back that also reads its
    // own output is still one file.
    if (seen.has(entry.artifact)) return;
    seen.add(entry.artifact);
    entries.push(entry);
  };

  // 1. The edge the row arrived by. Its artifact is the one fact the previous stage proved — and the previous stage's
  //    settled run carries the PIN (commit and blob), so the entry is recorded at that commit even when the branch
  //    has moved since. The writer's artifact wins over a fresh reading of the file.
  if (arrived) {
    const declared = declaredArtifactOf(p, arrived.artifact);
    add(
      manifestEntry({
        artifact: arrived.artifact,
        declared,
        worktree: where,
        values: artifactValues(run, declared && declared.stage),
        edge: arrived.id,
        via: "handoff",
        pin: writerArtifactOf(run, arrived.artifact),
        commit,
      }),
    );
  }
  // 2. Every artifact the stage declares it reads.
  for (const read of Array.isArray(s.reads) ? s.reads : []) {
    const declared = declaredArtifactOf(p, read.artifact);
    add(
      manifestEntry({
        artifact: read.artifact,
        declared,
        worktree: where,
        values: artifactValues(run, declared && declared.stage),
        via: "read",
        pin: writerArtifactOf(run, read.artifact),
        commit,
      }),
    );
  }
  // 3. The earlier visit's own artifact, when this is a second entry: the one input a fresh agent cannot reconstruct,
  // and the reason a loop back parks when it is gone (§5.2 rule 3). Its HASH is the earlier visit's record, not a new
  // reading of the file — the point of naming it is that it is the same file that came back.
  const visitNo = Number(visit);
  if (Number.isInteger(visitNo) && visitNo > 1 && isObject(s.artifact)) {
    const earlier = [...stageRunsOf(run)]
      .reverse()
      .find((entry) => text(entry.stage) === text(s.id) && Number(entry.visit) < visitNo && isObject(entry.artifact));
    if (earlier) {
      add(
        manifestEntry({
          artifact: s.artifact.id,
          declared: declaredArtifactOf(p, s.artifact.id) || { path: text(earlier.artifact.path) || null, writer: text(s.artifact.writer) || null },
          worktree: where,
          values: { round: Number(earlier.visit) },
          via: "earlier",
          pin: earlier.artifact,
          sha256: text(earlier.artifact.sha256) || null,
          present: true,
        }),
      );
    }
  }
  return { entries: entries.slice(0, INPUTS_MAX), dropped: Math.max(0, entries.length - INPUTS_MAX) };
}

// Reading a stage run's manifest back. The STORED hash is what the stage was handed and stays; `present` is re-resolved
// against the tree, because "is it there now" is a fact about the filesystem and a stored `true` would outlive the file.
// A run with no manifest (one started before this record existed) answers `entries: []` and says so — never "the stage
// read nothing".
export function stageInputsOf(task, { stage = null, visit = null, worktree = null } = {}) {
  const run = isObject(task && task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
  if (!run) return null;
  const entry = stageRunFor(run, { stage, visit });
  if (!entry) return null;
  const tree = text(worktree) || text(run.tree && run.tree.path) || text(task.worktree) || null;
  const list = Array.isArray(entry.inputs) ? entry.inputs : [];
  const entries = list.map((item) => {
    const stored = isObject(item) ? item : {};
    // The FILE the entry recorded beats the pattern it was declared with. A legacy entry that carries only a
    // `{{round}}` pattern is re-resolved by the matcher's own rule, because the round it was handed is not on the
    // entry — the alternative, guessing this visit's round, would report a different file as "the input".
    const rel = text(stored.file) || text(stored.path);
    const found = rel && tree ? artifactPathOf(rel, { worktree: tree }) : null;
    return {
      ...stored,
      // With a tree the live answer wins; without one the stored answer is all there is, and it is not re-guessed.
      present: found ? Boolean(found.found) : stored.present === undefined ? null : stored.present,
    };
  });
  return {
    stageRun: text(entry.id) || null,
    stage: text(entry.stage) || null,
    visit: Number(entry.visit) || null,
    resolvedAt: text(entry.settledAt) || text(entry.at) || null,
    entries,
    missing: entries.filter((item) => item.present === false).map((item) => item.artifact),
    dropped: Number(entry.inputsDropped) > 0 ? Number(entry.inputsDropped) : 0,
  };
}

// The pointer to a stage's tree, for the inputs block and the ledger: the path and branch the row is working in, plus
// the HEAD and dirty count the ASSISTANT measured (the driver is pure and cannot read git, §7.3).
export function treeRecordOf(run, facts = null) {
  const tree = isObject(run && run.tree) ? run.tree : null;
  if (!tree || !text(tree.path)) return null;
  return treeFactsRecord(tree.path, tree, facts);
}

// The same record from a path the driver resolved itself (the row's `worktree`, a ledger entry): the ledger must name
// the tree a stage actually ran in even when the row never carried a `pipelineRun.tree`.
function treeFactsRecord(treePath, tree = null, facts = null) {
  const where = text(treePath);
  if (!where) return null;
  const out = { path: where, branch: text(tree && tree.branch) || null };
  if (isObject(facts)) {
    if (text(facts.head)) out.head = text(facts.head);
    // The full sha, when the reader has it: the short one is for the block's line, the full one is what a pin and a
    // later `git show` need.
    if (text(facts.commit)) out.commit = text(facts.commit);
    if (Number.isFinite(Number(facts.dirty))) out.dirty = Number(facts.dirty);
  }
  return out;
}

// ---- the routing fingerprint -----------------------------------------------------------------------------------
// A stored sha256 over the fields that decide ROUTING — the stage ids in order, each handoff's ends/kind/cap, each
// gate's anchor/artifact/kind — normalised so prose and document position do not move it (§7.5). A stage's prompt and
// an artifact's schema are deliberately absent: the next stage simply gets the better brief.
export function routingFingerprint(pipeline) {
  const p = isObject(pipeline) ? pipeline : {};
  const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
  const doc = {
    id: clean(p.id),
    // Isolation decides WHERE a stage runs (one tree per row, or one per lane plus an aggregate), so a bundle that
    // flips it under a live row is the same class of change as a moved edge: the row parks on `pipeline-changed`
    // rather than being driven against a workspace model it did not enter under.
    isolation: isolationOf(p),
    stages: (Array.isArray(p.stages) ? p.stages : []).map((stage) => clean(stage && stage.id)).filter(Boolean),
    handoffs: (Array.isArray(p.handoffs) ? p.handoffs : [])
      .map((handoff) => ({
        id: clean(handoff && handoff.id),
        from: clean(handoff && handoff.from),
        to: clean(handoff && handoff.to),
        kind: clean(handoff && handoff.kind) || "sequence",
        cap: clean(handoff && handoff.cap),
      }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    gates: (Array.isArray(p.gates) ? p.gates : [])
      .map((gate) => ({
        id: clean(gate && gate.id),
        after: clean(gate && gate.after),
        artifact: clean(gate && gate.artifact),
        kind: isObject(gate && gate.decision) ? "decision" : "pause",
        // A route moves where a verdict sends a row, so it is a ROUTING fact like an edge's ends: a re-export that
        // re-points an outcome under a live row parks it (`pipeline-changed`) instead of silently obeying a new map.
        routes: isObject(gate && gate.decision && gate.decision.routes)
          ? Object.keys(gate.decision.routes)
              .sort()
              .map((outcome) => [outcome, gate.decision.routes[outcome]])
          : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const digest = createHash("sha256").update(JSON.stringify(doc)).digest("hex");
  return `sha256:${digest}`;
}

// ---- the decision record ---------------------------------------------------------------------------------------
// One renderer for every sentence a stage decision produces, so the row's reason, the journal line and the window
// cannot drift apart (§6.2). The fact is structured and small; the sentence is a RENDERING of it, never the record.
export const DECISION_TRIGGERS = Object.freeze([
  "stage-settled",
  "gate-record",
  "verdict",
  "cap",
  "artifact-missing",
  "start-asked",
  "start-refused",
  "tree",
  "unresolved",
  "changed",
  "reader",
  "assistant",
]);

// The visits a loop has taken, in the order the record keeps them: `draft 4, critique 3`. Empty when the record has
// no counter (a row written before the visits existed), because a sentence that invented "0" would be a second fact.
function visitsText(visits) {
  const pairs = Object.entries(isObject(visits) ? visits : {}).filter(([, n]) => Number(n) > 0);
  return pairs.map(([stage, n]) => `${stage} ${Number(n)}`).join(", ");
}

// The last verdict the gate read, as a clause: `the last verdict was revise at ledger/ping-pong/verdict-r3.json`.
function verdictText(verdict) {
  const v = isObject(verdict) ? verdict : null;
  const outcome = text(v && v.outcome);
  if (!outcome) return "";
  const at = text(v.path);
  return `the last verdict was ${outcome}${at ? ` at ${at}` : ""}`;
}

// ONE line to the reader when a cap parks a row: the cap, the visits, and the last verdict.
//
// The reader's decision on round 7's fifth item: a cap park is the one wait in a row with no automatic exit, and
// waiting for a person to send `pipeline-release {release: "cap"}` meant nobody heard about it. The row still parks
// (the loop is still not converged, and the panel does not quietly extend a bound it just enforced), but the reader's
// assistant is woken with this line, so the decision the park is asking for is asked.
export function capWakeLine({ id = null, title = null, pipeline = null, stage = null, edge = null, limit = null, used = 0, visits = null, verdict = null } = {}) {
  const head = [id != null ? `#${id}` : "", text(title)].filter(Boolean).join(" ");
  const where = [text(pipeline), text(stage)].filter(Boolean).join(" · ");
  const cap = limit == null ? "a cap the panel cannot read" : `a cap of ${limit} round${limit === 1 ? "" : "s"}`;
  const seen = visitsText(visits);
  const last = verdictText(verdict);
  const facts = [`${used} crossing${Number(used) === 1 ? "" : "s"} taken`, seen ? `visits ${seen}` : "", last].filter(Boolean).join("; ");
  return `${head ? `${head} — ` : ""}${where || "the row"} stopped at ${edge ? `loop ${edge}` : "its loop"}: ${cap}, ${facts}. The row is parked — a pipeline-release {release: "cap"} is the panel's answer if the loop should go on.`;
}

export function renderDecision(fact) {
  const f = isObject(fact) ? fact : {};
  const stageName = [text(f.pipeline), text(f.stage)].filter(Boolean).join(" · ");
  switch (text(f.kind)) {
    case "run-status": {
      const where = stageName || "the stage";
      const detail = text(f.detail);
      if (text(f.status).toLowerCase() === "done") return `${where} settled — the run finished`;
      return `${where} ended ${text(f.status) || "unknown"}${detail ? `: ${detail}` : " with no final message"} — the pipeline waits for a decision rather than re-running the stage`;
    }
    case "artifact": {
      const id = text(f.id) || "its artifact";
      const at = text(f.path) ? ` (${text(f.path)})` : "";
      if (f.present === false) {
        return `stage ${text(f.stage) || stageName} settled — its artifact ${id}${at} is not in the tree, so ${text(f.handoff) ? `handoff ${text(f.handoff)} has` : "the next stage has"} nothing to pass`;
      }
      if (f.unchanged === true) return `stage ${text(f.stage) || stageName} settled — its artifact ${id}${at} is unchanged from the visit that produced it`;
      return `stage ${text(f.stage) || stageName} settled — its artifact ${id}${at} is present${text(f.sha256) ? ` (sha256 ${text(f.sha256).slice(0, 8)}…)` : ""}`;
    }
    case "input": {
      // The pin refused. The sentence names the artifact, the commit it is pinned to and the fact the tree gave back,
      // so a reader can see whether the branch moved, was rewritten, or the tree is not the one the stage produced.
      const id = text(f.artifact) || "the handed-on artifact";
      const at = text(f.path) ? ` (${text(f.path)})` : "";
      const commit = text(f.commit) ? shortSha(f.commit) : "(none recorded)";
      return `stage ${text(f.stage) || stageName} is handed ${id}${at} pinned to commit ${commit}, and ${text(f.reason) || "this tree cannot resolve it"} — the row refuses the input rather than reading a different tree`;
    }
    case "gate": {
      const gate = text(f.gate) || "the gate";
      const where = text(f.path) || "(no path)";
      return f.present === false
        ? `gate ${gate} follows stage ${text(f.stage) || "?"} and declares a decision record at ${where} — the code does not decide it, and the record has not been written`
        : `gate ${gate} crossed by ${where}`;
    }
    case "verdict": {
      const gate = text(f.gate) || "the gate";
      const where = text(f.path) || "(no path)";
      const outcome = text(f.outcome);
      // The refusal: the record is there, and the word in it is not one the document routes. The panel stops rather
      // than taking the loop it cannot justify.
      if (f.ended !== true && f.routed !== true) {
        return `gate ${gate} cannot route its own record at ${where} — ${text(f.reason) || "it names no outcome"} — and the panel does not guess an edge for a verdict the document does not hold`;
      }
      const edge = text(f.edge);
      const ends = text(f.from) && text(f.to) ? ` (${text(f.from)} → ${text(f.to)})` : "";
      if (f.ended === true) {
        return `gate ${gate} placed its verdict at ${where}: ${JSON.stringify(outcome)} — ${edge ? `that outcome ends the loop ${edge}${ends}` : "that outcome routes to no further stage"}, so the pipeline is over and the settle finishes the row`;
      }
      return `gate ${gate} placed its verdict at ${where}: ${JSON.stringify(outcome)} — the row takes ${edge}${ends}`;
    }
    case "cap": {
      const edge = text(f.edge);
      const ends = text(f.from) && text(f.to) ? ` (${text(f.from)} → ${text(f.to)})` : "";
      // The visits and the last verdict travel with the sentence: a cap park is the one stop with no world-state that
      // could release it, so the record has to carry what a person would otherwise reconstruct from the ledger.
      const seen = visitsText(f.visits);
      const last = verdictText(f.verdict);
      const detail = [seen ? `visits ${seen}` : "", last].filter(Boolean).join("; ");
      if (f.limit == null) return `the loop ${edge}${ends} names ${f.text ? `a cap of ${JSON.stringify(f.text)}` : "no cap"}, which is not a readable bound — the panel does not guess a limit, so the edge is not taken${detail ? ` (${detail})` : ""}`;
      return `the loop ${edge}${ends} is at its cap of ${f.limit} round${f.limit === 1 ? "" : "s"} — ${f.used ?? 0} crossing${f.used === 1 ? "" : "s"} already taken${detail ? ` (${detail})` : ""}, so the row stops here for a decision`;
    }
    case "cap-release": {
      return `the cap on ${text(f.edge) || "the loop edge"} was released by the reader — ${f.was ?? 0} crossing${f.was === 1 ? "" : "s"} were counted, and the count is now zero`;
    }
    case "tree": {
      if (text(f.code) === DRIVE_FAULTS.TREE_CLAIMED) {
        return `the tree ${text(f.path) || "(no path)"} is claimed by open row #${text(String(f.otherId ?? "")) || "?"}${text(f.otherTitle) ? ` ${JSON.stringify(text(f.otherTitle))}` : ""} — two stages must not start in one tree`;
      }
      return `the tree ${text(f.path) || "(no path)"} this row ran in is gone${f.lastStage ? ` (last used by stage ${text(f.lastStage)})` : ""} — point the row at another tree, or clear its pipeline and start over`;
    }
    case "record": {
      return text(f.reason) || "the row's pipeline record cannot be resolved — this is not the default path";
    }
    case "bundle": {
      return text(f.reason) || "the bundle cannot be read, so the row's pipeline cannot be resolved";
    }
    case "route": {
      return `the pipeline's routing changed since this stage was entered — stored ${text(f.stored) || "(none)"}, now ${text(f.now) || "(none)"} — re-export acknowledged, or release the park to accept the new graph`;
    }
    case "aggregate": {
      // A fan-out's merge: the ONE commit that combined the lanes, or the refusal that named the paths two lanes both
      // wrote. The paths are the sentence — a reader's next act is to choose which lane is right.
      const lanes = (Array.isArray(f.branches) ? f.branches : []).map((branch) => text(branch && branch.stage)).filter(Boolean).join(", ");
      const paths = (Array.isArray(f.conflicts) ? f.conflicts : []).map(text).filter(Boolean);
      const stage = text(f.stage) || stageName;
      if (paths.length) {
        return `the aggregate for ${stage} was refused before it started — lanes ${lanes || "(unknown)"} both changed the ${paths.length === 1 ? "path" : "paths"} ${paths.join(", ")}; the row parks so a person can choose which lane is right`;
      }
      if (text(f.reason)) return `the aggregate for ${stage} could not be merged — ${text(f.reason)}`;
      return `the aggregate for ${stage} is recorded — one merge of ${lanes || "the lanes"}${text(f.commit) ? ` at ${shortSha(f.commit)}` : ""}`;
    }
    case "assembly": {
      // A per-stage round's ONE branch: the commit every stage was picked onto, or the refusal that named the paths
      // two stages changed on the same lines. The paths are the sentence - a person's next act is to choose a stage.
      const stages = (Array.isArray(f.stages) ? f.stages : []).map((entry) => text(entry && entry.stage)).filter(Boolean).join(", ");
      const paths = (Array.isArray(f.conflicts) ? f.conflicts : []).map(text).filter(Boolean);
      const where = text(f.stage) || stageName;
      if (paths.length) {
        return `the assembly of ${where} was refused - stage ${text(f.conflictStage) || "?"} changed the ${paths.length === 1 ? "path" : "paths"} ${paths.join(", ")}, and so did a stage before it (${stages || "none picked"}) on the same lines; the row parks so a person can choose which stage is right`;
      }
      if (text(f.reason)) return `the assembly of ${where} could not be built - ${text(f.reason)}`;
      return `the assembly of ${where} is recorded - ${stages || "the stages"} on one branch${text(f.branch) ? ` (${text(f.branch)})` : ""}${text(f.commit) ? ` at ${shortSha(f.commit)}` : ""}`;
    }
    case "route-restamp": {
      return `the routing fingerprint was re-stamped by the reader — ${text(f.from) || "(none)"} → ${text(f.to) || "(none)"}`;
    }
    case "claim":
    default:
      return text(f.reason) || "the panel made a decision about this stage";
  }
}

// A decision is a fact plus the metadata that makes it legitimate. `reason` is RENDERED here, once, and both the row
// and the stage run receive the same sentence.
export function decisionOf({ code = null, trigger = "stage-settled", at = new Date().toISOString(), fact = null, by = "panel" } = {}) {
  const f = isObject(fact) ? fact : {};
  return { by, trigger, code: code || null, at, fact: f, reason: renderDecision(f) };
}
// The gate that must be crossed on the way out of a stage: one anchored `after` it that DECLARES a decision. A gate
// with no decision is the studio's PAUSE — nothing can wait on it and no record can release it — and treating it as
// a barrier would park every row behind a gate the panel has no way to read.
export function gateAfter(pipeline, stageId) {
  const after = text(stageId);
  if (!pipeline || !after) return null;
  return (pipeline.gates || []).find((gate) => text(gate.after) === after && isObject(gate.decision)) || null;
}

// ---- the verdict: the gate's record, read for the ONE word the document routes ----------------------------------
// A gate's decision record is the panel's one machine-readable file: a seat writes it, the driver waits for it, and
// when the document maps an outcome to an edge (`decision.routes`) the driver OBEYS that mapping. It still judges
// nothing — the outcome is the seat's and the edge is the document's; the panel only checks that the word is one the
// gate declared and that the graph has an answer for it. This is the middle path the design left open (§6.1, Q11),
// and it is what lets a converged loop end instead of spending its cap.
//
// `values` is what makes the gate a question asked AGAIN on every round: a document that declares one record per round
// (`ledger/gates/G51-{{run_id}}-r{{round}}.json`) writes r1's file once, and without the round filled in the matcher's
// first-sorted fallback finds r1's answer in every later round — G51 was crossed 11 times on round 1's decision in the
// 24-stage run. The round this visit is in is a hole the caller KNOWS, so it is filled rather than matched.
export function verdictOf(gate, { worktree = null, values = null } = {}) {
  const decision = isObject(gate && gate.decision) ? gate.decision : null;
  const resolved = decisionPathOf(text(decision && decision.path), { worktree, values });
  if (!resolved.found) return { found: false, path: resolved.shown, outcome: null, reason: resolved.reason || "the record has not been written" };
  let doc;
  try {
    doc = JSON.parse(readFileSync(resolved.path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    return { found: true, path: resolved.shown, outcome: null, reason: `the record is not JSON (${String((error && error.message) || error)})` };
  }
  // One field, `outcome`, and it is the word the gate's `outcomes` list declares. A record without it is a verdict the
  // panel cannot route — never an empty string quietly treated as "not converged".
  const outcome = text(isObject(doc) ? doc.outcome : "");
  if (!outcome) return { found: true, path: resolved.shown, outcome: null, reason: "the record names no outcome" };
  return { found: true, path: resolved.shown, outcome, reason: null };
}

// The edge the document routes an outcome to. `null` is a REAL answer — the pipeline ends here — and `routed: false`
// is the refusal: an outcome the map does not hold is not guessed at, because guessing is how a verdict ends a loop
// the document never said was over.
export function routeFor(decision, outcome) {
  const routes = isObject(decision && decision.routes) ? decision.routes : null;
  if (!routes) return { routed: false };
  const key = text(outcome).toLowerCase();
  const hits = Object.keys(routes).filter((candidate) => text(candidate).toLowerCase() === key);
  if (hits.length !== 1) return { routed: false };
  const target = routes[hits[0]];
  return { routed: true, outcome: hits[0], handoff: target === null ? null : text(target) || null };
}

// What the pipeline says comes after `run`'s stage. Three answers, and each one is a value:
//
//   { ok: true, done: false, stage, handoff }   enter `stage`, counting the handoff if there is one
//   { ok: true, done: true }                    the pipeline is over (and `closing` names the gate after the last stage, or null — the run ends ON it, the driver does not wait on it); the settle finishes the row
//   { ok: false, code, reason, ... }            it stops here, and the row parks on the reason
export function nextStageOf(pipeline, run, { worktree = null, fanout = null } = {}) {
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

  // A fan-out is walked by ITS OWN order, and it comes before the edge table because the block is a set of siblings:
  // the fork enters the first lane, a settled lane hands over to the next lane that has not settled, and the last
  // lane enters the join. No edge is crossed between two lanes — a lane switch is not a handoff, and counting it as
  // one would spend a cap nobody wrote. The join is entered by the aggregate, so `aggregate: true` travels with it.
  if (fanout && fanout.isolate && Array.isArray(fanout.lanes)) {
    const settled = (lane) => stageRunsOf(run).some((entry) => text(entry.stage) === lane && text(entry.status) === "done");
    const atFork = Boolean(fanout.fork) && stageId === fanout.fork;
    const onLane = fanout.lanes.includes(stageId);
    if (atFork || onLane) {
      const nextLane = fanout.lanes.find((lane) => lane !== stageId && !settled(lane));
      if (nextLane) {
        const edge = (Array.isArray(pipeline.handoffs) ? pipeline.handoffs : []).find(
          (handoff) => text(handoff.from) === stageId && text(handoff.to) === nextLane && (text(handoff.kind) || "sequence") !== "loop",
        );
        return { ok: true, done: false, stage: stageById(pipeline, nextLane), handoff: edge || null, lane: true };
      }
      const join = stageById(pipeline, fanout.join);
      if (join) return { ok: true, done: false, stage: join, handoff: null, aggregate: true };
    }
  }

  // The edge the studio drew out of this stage, taken in KIND order (see EDGE_ORDER) rather than in the document's
  // order: the rail first, so a stage that can both advance and loop back advances — the picture draws it that way.
  let leaving = edgeOutOf(pipeline, stageId);
  const order = Array.isArray(pipeline.order) ? pipeline.order : [];
  const at = order.indexOf(stageId);
  // The stage an edge enters, or the reading order's next one when the stage draws no edge at all. A function because
  // a routed verdict can REPLACE `leaving` further down, and the target must be the routed edge's, never the one the
  // kind order would have taken.
  const nextOf = (edge) => stageById(pipeline, edge ? edge.to : at >= 0 ? order[at + 1] : null);
  // No next stage: the pipeline is over, and a gate anchored here guards no edge the driver would take. It is named in
  // the answer rather than acted on, so a caller (and the drawing, which marks that notch `closing`) can say what the
  // run ends on; the row itself is finished by the settle, where a run with no pipeline has always ended.
  if (!nextOf(leaving)) return { ok: true, done: true, closing: gateAfter(pipeline, stageId) };

  // A gate on the edge out: it sits after the stage, and an edge the studio put a decision in front of is not the
  // driver's to take. Checked before the cap because the gate is the outer question — the loop is only reached once
  // the decision has been made.
  const gate = gateAfter(pipeline, stageId);
  // The holes this visit can fill. `{{round}}` is the visit the stage is in, so a gate that declares one record per
  // round is asked for THIS round's file; a hole the driver cannot fill (`{{run_id}}`, `{{finding}}`) stays a
  // one-segment match, which is the per-finding record the studio writes.
  const gateValues = artifactValues(run, stageId);
  let verdict = null;
  if (gate) {
    const record = decisionPathOf(gate.decision && gate.decision.path, { worktree, values: gateValues });
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
    // A gate whose document maps outcomes to edges is ROUTED by the record's own word. Read here, before the cap: a
    // verdict that routes nowhere ends the pipeline, and charging it a crossing on the way out is the defect this
    // ordering exists to stop. A loop that is NOT converged still routes back into itself, and its cap still applies.
    if (isObject(gate.decision && gate.decision.routes)) {
      const read = verdictOf(gate, { worktree, values: gateValues });
      const route = read.outcome ? routeFor(gate.decision, read.outcome) : { routed: false };
      if (!route.routed) {
        return {
          ok: false,
          done: false,
          code: DRIVE_FAULTS.VERDICT,
          gate,
          path: read.path,
          outcomes: Array.isArray(gate.decision.outcomes) ? gate.decision.outcomes : [],
          reason: `gate ${gate.id} (${gate.name}) follows ${stageId} and its record at ${read.path || "(no path)"} ${read.reason || `names ${JSON.stringify(read.outcome)}`} — the decision declares ${(gate.decision.outcomes || []).join(", ")}, and the panel does not route a verdict the gate does not hold`,
        };
      }
      const ends = route.handoff === null;
      const routed = ends ? null : (pipeline.handoffs || []).find((handoff) => text(handoff.id) === route.handoff) || null;
      if (!ends && !routed) {
        return {
          ok: false,
          done: false,
          code: DRIVE_FAULTS.VERDICT,
          gate,
          path: read.path,
          reason: `gate ${gate.id} (${gate.name}) routes ${JSON.stringify(read.outcome)} to handoff ${route.handoff}, which pipeline "${pipeline.id}" does not hold — the verdict names an edge the graph cannot take`,
        };
      }
      verdict = {
        gate: gate.id,
        path: read.path,
        outcome: route.outcome || read.outcome,
        handoff: ends ? null : routed.id,
        edge: ends ? text(leaving && leaving.id) || null : routed.id,
        from: ends ? text(leaving && leaving.from) || null : routed.from,
        to: ends ? text(leaving && leaving.to) || null : routed.to,
        ended: ends,
      };
      // The verdict routed nowhere: the pipeline is over. There is no edge to charge and no stage to enter, and the
      // settle finishes the row on the landing rule it has always had.
      if (ends) return { ok: true, done: true, closing: null, verdict };
      leaving = routed;
    }
  }

  // The target of the edge actually being taken — the routed one when a verdict chose it, the kind-order one otherwise.
  const next = nextOf(leaving);
  if (!next) return { ok: true, done: true, closing: null, verdict };

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
        // What the reader is told when the row parks: the visits every stage has taken, and the verdict the gate read
        // before the cap was examined. A cap park is the ONE stop with no world-state behind it, so its sentence has
        // to carry everything a person would otherwise have to reconstruct from the ledger.
        visits: { ...visitsOf(run) },
        verdict: verdict || null,
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
        visits: { ...visitsOf(run) },
        verdict: verdict || null,
        stage: next,
        reason: `the loop ${leaving.id} (${leaving.from} → ${leaving.to}) is at its cap of ${cap.limit} round${cap.limit === 1 ? "" : "s"} — ${used} crossing${used === 1 ? "" : "s"} already taken, so the row stops here for a decision`,
      };
    }
  }

  return { ok: true, done: false, stage: next, handoff: leaving, ...(verdict ? { verdict } : {}) };
}

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

// Is there a directory at this path? `existsSync` alone accepts a FILE with the tree's name, and every git command in
// that "tree" would then fail in the stage's turn.
function isDirectory(target) {
  try {
    return Boolean(text(target)) && existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// The three answers, then a park (§3.3):
//   1. `pipelineRun.tree.path` — the row's own field, written at the cut;
//   2. the most recent `stageRuns[].tree.path` that still exists — the ledger wins when the two disagree;
//   3. `task.worktree` — where the row is already pointed;
//   4. none of them exists → the row HAD a tree and it is gone (a park), never a second cut and never the project.
// A row that has never had a tree answers `needed`: that is the first stage, and its cut is the `ensureTree` request.
export function treeLookup(task) {
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
  const worktree = text(row.worktree) ? { path: text(row.worktree), stage: null, tree: null } : null;
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
  for (const entry of runs) {
    const stageId = text(entry.stage);
    const visit = Number.isInteger(Number(entry.visit)) && Number(entry.visit) > 0 ? Number(entry.visit) : 1;
    const key = `${stageId}#${visit}`;
    if (!stageId || seen.has(key)) continue;
    const commit = text(entry.commit);
    if (text(entry.status) !== "done" || !commit) {
      skipped.push({ stage: stageId, visit, why: text(entry.status) === "done" ? "the run recorded no commit" : `the run is ${text(entry.status) || "not settled"}` });
      continue;
    }
    seen.add(key);
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
export function stageTreeLookup(task, pipeline, run = null) {
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
  if (!roundOf(record)) return treeLookup(task);
  return ownStageTree(record, role || "stage", plan);
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
// graph that owns it — design §2.3). `null` for a `shared` pipeline and for a `per-stage` one whose graph draws no
// block: both run today's one tree per row, and the difference is only whether a reader is told why.
export function fanOutStateOf(pipeline, run = null) {
  const plan = fanOutOf(pipeline);
  if (!plan || !plan.isolate || isolationOf(pipeline) !== "per-stage") return null;
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
export function driveTaskPipelines(tasks, { bundle: source = null, jobs = [], isLive = () => false, at = new Date(), unattended = false, claims = [], treeOf = null, waitFor = null } = {}) {
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
  // The wait the BOOK holds for a tree, asked only by the row that would otherwise advance. A tree path is the key: the
  // hold lives in the tree's own durable pipeline record (lib/jobs.js `pipelineRecordFor`), not on the row.
  const waits = (treePath) => (typeof waitFor === "function" && text(treePath) ? waitFor(text(treePath)) : null);
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
    const tree = stageTreeLookup(task, pipeline, run);
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
    const step = nextStageOf(pipeline, run, { worktree: treePath || task.worktree, fanout: plan });
    if (!step.ok) {
      const isGate = step.code === DRIVE_FAULTS.GATE;
      const isVerdict = step.code === DRIVE_FAULTS.VERDICT;
      const fact = isGate
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
        trigger: isGate ? "stage-settled" : isVerdict ? "verdict" : step.code === DRIVE_FAULTS.CAP ? "cap" : "unresolved",
        fact,
        // A verdict fault waits on the SAME record the gate waits on: the reader repairs the file, and the next pass
        // re-reads it and releases the row — the record is the release, exactly as it is for a missing one.
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
          const tree = stageTreeLookup(front, pipeline, run);
          const merge = plan && stage.id === plan.join ? (stageRunFor(run, { stage: plan.join }) || {}).merge || null : null;
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
              const prompt = stagePrompt(front, pipeline, stage, { run, tree: { ...(tree.tree || {}), path: tree.path, branch: tree.branch }, facts, fanout: plan });
              // Is this stage's branch one of the round's work branches rather than the row's landing branch? A chain
              // stage's own tree and a fan-out's lane are; a fan-out's join tree is the aggregate, which IS the row's.
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
                  remoteWrite: landsAsPr(stage) && !ownStageBranch ? "pr" : "local",
                  // The branch the stage RUNS in: its own under `per-stage`, the row's otherwise. A stage branch is
                  // local only (rule 5) — this names a workspace, never a ref anything may push.
                  tree: { path: tree.path, branch: text(tree.tree && tree.tree.branch) || text(run.tree && run.tree.branch) || null },
                  ...(plan ? { isolation: "per-stage", role: stage.id === plan.join ? "join" : stage.id === plan.fork ? "fork" : "lane" } : {}),
                });
                // The marker and the ledger entry are written with the row, BEFORE the caller starts anything: the
                // marker is what the next pass reads, and the entry is what a restart reads to know this attempt existed.
                // The row's own `tree` is the AGGREGATE's under a fan-out — the branch that lands — never a lane's.
                const marked = { ...front, [TASK_PIPELINE_FIELD]: { ...run, [STARTING_AT]: isoOf(at), ...(tree.tree && !run.tree && !plan ? { tree: tree.tree } : {}) } };
                const withEntry = beginStageRun(marked, { stage: stage.id, at: isoOf(at) });
                // The inputs this stage is handed, resolved on the same pass that built its prompt: the manifest is
                // what the stage STARTED with, so it is written with the entry rather than at settle, when the files
                // may already have moved (§5.3).
                // The tree's commit is resolved HERE, at the start, so an entry with no writer pin still records the
                // commit it read the tree at; the writer's own pin wins for the handoff when it has one.
                const commit = text(facts && facts.commit) || commitOf(tree.path);
                const manifest = inputManifest({ pipeline, stage, run, worktree: tree.path, visit: visitOf(run, stage.id), commit });
                const withFacts = settleStageRun(withEntry, { stage: stage.id, commit: commit || null, tree: treeFactsRecord(tree.path, tree.tree || run.tree, facts), inputs: manifest });
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
