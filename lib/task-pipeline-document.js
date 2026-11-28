// The pipeline document: the graph a task walks, the artifacts a stage is handed, the gate's record and the verdict.
//
// Cut 1 of the two in lib/task-pipeline-drive.js's split (row #534 of the module-separation work). Lines
// 109-1,158, 1,162-1,187 and 1,220-1,228 of lib/task-pipeline-drive.js at b0ce9aa6, moved verbatim: the named
// reasons a stage can stop, the record keys, the graph edges, the input manifest, the routing fingerprint, the
// decision record, the gate and the verdict. Nothing was renamed and no body was rewritten.
//
// isDirectory travels with the manifest because decisionPathOf resolves a declared path with it; the code that reads a
// tree imports it from here. The names a sibling reads that lib/task-pipeline-drive.js never published - text,
// isObject, isoOf, landsAsPr, isDirectory, settledArtifactOf, artifactTreeOf, treeFactsRecord - are exported in one
// statement at the foot of this file. The parent re-exports every PUBLIC name it lost, so no caller changes.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { stageById } from "./pipeline-bundle.js";
import { isolationOf } from "./pipeline-fanout.js";
import { pinOf, relInTree, shortSha } from "./stage-pin.js";
import { readReviewExit, reviewExitOf, reviewGateFor } from "./pipelines.js";
import { TASK_PIPELINE_FIELD, stageRunFor, stageRunsOf, visitOf, visitsOf } from "./task-pipeline.js";

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
  // The pull request a review-exit stage exists for has been DECLINED or CLOSED: the answer the stage waits on can
  // never arrive, so no edge is taken, no later stage is entered and nothing is dispatched. The row parks on the read
  // (the panel's own, stamped on the tree's record) rather than on anyone's sentence about it.
  DECLINED: "pipeline-declined",
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

export function edgeOutOf(pipeline, stageId, { review = null } = {}) {
  const edges = (pipeline && Array.isArray(pipeline.handoffs) ? pipeline.handoffs : []).filter((handoff) => text(handoff.from) === text(stageId));
  if (!edges.length) return null;
  // The review's answer outranks the kind order. A wait stage draws TWO ways out - the answer as a capped `loop` and
  // the approval as a `sequence` - so the rail would take the approval and the answer stage would never be entered.
  // When the stage's own gate names the comment check and the PR carries a comment newer than the wait's lastSeen,
  // the loop edge (the answer stage) is the one to take.
  const reviewed = reviewEdgeOutOf(pipeline, stageId, { review });
  if (reviewed) return reviewed;
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

// Which edge a REVIEW-WAIT stage leaves by, or null when the rail's own order stands. The fact is the reviewer's,
// not the document's: `readReviewExit` answers "a comment newer than lastSeen" from the wait's own clock, and
// `pr-comments` is the only check that routes BACKWARDS - an approval is the rail's forward edge already, and the
// reviewer set is a barrier, not an answer. A gate the document ROUTES is the document's own two-outcome decision,
// so it is left to `nextStageOf`'s verdict block; a caller with no host read passes no `review` and gets the same
// edge it always did.
export function reviewEdgeOutOf(pipeline, stageId, { review = null } = {}) {
  const at = text(stageId);
  if (!at || !isObject(review)) return null;
  if (!isObject(review.observation) && !isObject(review.stamped)) return null;
  const gates = pipeline && Array.isArray(pipeline.gates) ? pipeline.gates : [];
  const gate = gates.find((candidate) => text(candidate && candidate.after) === at && text(candidate.verifiedBy || candidate.verified_by) === "pr-comments") || null;
  if (!gate) return null;
  if (isObject(gate.decision) && isObject(gate.decision.routes)) return null;
  // Two shapes, one answer. The timer passes the observation it has just read; the driver passes the read the book
  // stamped (lib/jobs.js `recordReviewRead`) under `stamped`, because a driver has no reader of its own and a stage
  // whose exit is the reviewer's must leave the way the read said, not the way the rail's kind order would.
  const stamped = isObject(review.stamped) ? review.stamped : null;
  const read = stamped
    ? { advanced: stamped.advanced === true && !text(stamped.closed), closed: text(stamped.closed) || null }
    : readReviewExit({ check: "pr-comments", who: [] }, review.observation, { lastSeen: review.lastSeen ?? null });
  if (!read || read.advanced !== true) return null;
  const edges = (Array.isArray(pipeline.handoffs) ? pipeline.handoffs : []).filter((handoff) => text(handoff.from) === at);
  // The answer stage is the loop's target; a stage that draws no loop has no answer stage, and a loop whose cap is
  // spent is refused by `nextStageOf` with the same crossing count every other loop pays.
  return edges.find((handoff) => (text(handoff.kind) || "sequence") === "loop") || null;
}

// The reviewer's read of the stage being LEFT, or null when that stage draws no review exit. Two shapes again: the
// observation the timer has just read, or the read the book stamped. This is the one question both owners of an
// advance ask, so a pull request that has ENDED ends the walk whichever owner is asking.
export function reviewReadAt(pipeline, stage, review) {
  if (!isObject(stage) || !isObject(review)) return null;
  const exit = reviewExitOf(stage, reviewGateFor(pipeline, stage.id));
  if (!exit) return null;
  const stamped = isObject(review.stamped) ? review.stamped : null;
  const read = stamped
    ? {
        ok: true,
        advanced: stamped.advanced === true && !text(stamped.closed),
        closed: text(stamped.closed) || null,
        cannotTell: Boolean(stamped.cannotTell),
        seen: text(stamped.seen) || null,
        why: text(stamped.why) || null,
        state: text(stamped.state) || null,
        at: text(stamped.at) || null,
      }
    : isObject(review.observation)
      ? {
          ...readReviewExit(exit, review.observation, { lastSeen: review.lastSeen ?? null }),
          // The host's own word travels with the read, as it does on the stamped shape: the sentence a reader sees
          // must say CLOSED when the PR was closed, not borrow DECLINED from the closed family's name.
          state: text(isObject(review.observation) && isObject(review.observation.pr) ? review.observation.pr.state : "").toUpperCase() || null,
        }
      : null;
  if (!read) return null;
  return { ...read, check: text(exit.check), stage: text(stage.id) };
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

// The artifact a SETTLED run recorded for this id, whether or not the record carries a pin. A record written before
// pins existed says `present: true` and nothing else; that is the writer's claim about its own tree, and an input the
// ledger says a stage produced is not one a later stage may be refused for. `null` means no run of this pipeline has
// settled that artifact at all, which is the only fact a start refuses on.
function settledArtifactOf(run, id) {
  const wanted = text(id);
  if (!wanted) return null;
  const entries = stageRunsOf(run).filter(
    (entry) => isObject(entry && entry.artifact) && text(entry.artifact.id) === wanted && text(entry.status) === "done",
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
      // No pin at all: nothing in the ledger produced the artifact and the stage's own tree does not hold it. That is
      // the shape a dropped lane leaves behind, and the row settles `refused` rather than reporting work it was never
      // handed.
      if (f.missing === true) {
        const by = text(f.handoff) ? ` by edge ${text(f.handoff)}` : "";
        return `stage ${text(f.stage) || stageName} cannot start: it is handed ${id}${at}${by}. ${text(f.reason) || "No run of this pipeline has settled it, and this stage's tree does not hold it"}, so the row refuses the input and settles refused, not done`;
      }
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
    case "review": {
      // The pull request ENDED under a stage whose exit is the reviewer's answer. The sentence carries the check the
      // stage was waiting on and the host's own word for the state, because "the walk stopped" without the read is a
      // stop a reader cannot check.
      const check = text(f.check) || "the reviewer's answer";
      const state = text(f.state) || "DECLINED";
      const where = stageName || "the stage";
      return `${where} exits on ${check}, and the pull request is ${state} - a reviewer's answer cannot arrive on it, so the walk ends here: no later stage is entered and nothing is dispatched`;
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
export function nextStageOf(pipeline, run, { worktree = null, fanout = null, review = null } = {}) {
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

  // THE PULL REQUEST ENDED, so there is no edge. A stage whose exit is the reviewer's answer has nothing left to wait
  // for once the pull request it is about reads DECLINED or CLOSED: the answer can never arrive, so entering `approve`
  // (or `merge`) would run a stage whose own exit refuses to fire. That is the walk row 67 recorded - a DECLINED read
  // became approve, then merge, and only a steer stopped the merge run writing to SEFL. A read that could NOT be made
  // is not a close: only the host's own ended state ends the walk here, and `cannotTell` keeps the row where it is.
  const ended = reviewReadAt(pipeline, current, review);
  if (ended && ended.closed === "declined") {
    return {
      ok: false,
      done: false,
      code: DRIVE_FAULTS.DECLINED,
      stage: current,
      read: ended,
      reason: `${text(pipeline && pipeline.id)} - ${stageId} exits on ${ended.check}, and the pull request is ${ended.state || "DECLINED"}: a reviewer's answer cannot arrive on it, so the walk ends here and no later stage is entered`,
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
  // The one exception is a review wait whose PR carries a comment newer than the wait's lastSeen: `review` is that
  // fact, and it makes the loop (the answer stage) the edge due, ahead of the approval.
  let leaving = edgeOutOf(pipeline, stageId, { review });
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

// Is there a directory at this path? `existsSync` alone accepts a FILE with the tree's name, and every git command in
// that "tree" would then fail in the stage's turn.
function isDirectory(target) {
  try {
    return Boolean(text(target)) && existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// The internals a sibling cut reads: the two path readers, the stamp reader, the artifact resolver and the three
// names the manifest builds a stage's inputs with. They stay off the parent's surface, which is unchanged.
export { text, isObject, isoOf, landsAsPr, isDirectory, settledArtifactOf, artifactTreeOf, treeFactsRecord };
