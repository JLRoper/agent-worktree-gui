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
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { byQueueOrder, currentThread, setTaskState } from "./assistant/queue.js";
import { pipelineById, stageById } from "./pipeline-bundle.js";
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

// The ARTIFACT path is the same matcher, under its own name: a stage declares an artifact with a workspace-relative
// path and exactly one writer, and the panel resolves it the way it resolves a gate's decision — against the tree,
// with `{{hole}}` segments matching one segment. One matcher, so the two cannot disagree about what "the file is
// there" means.
export function artifactPathOf(rel, { worktree = null } = {}) {
  return decisionPathOf(rel, { worktree });
}

// What a stage's declared artifact is, AT THE MOMENT THE STAGE SETTLED (§5.3): its id, the path resolved against the
// tree, whether it is there, and its sha256. The hash is stored because the tree changes afterwards — a later reader
// must see the state the driver acted on, and a loop-back visit can then say "unchanged" without a second opinion.
// Files over 1 MiB record `present` only: hashing a 2 GB log in a sweep is a stall, not a check.
export const ARTIFACT_HASH_MAX = 1024 * 1024;

export function artifactOf(artifact, { worktree = null } = {}) {
  const a = isObject(artifact) ? artifact : null;
  if (!a) return null;
  const id = text(a.id) || null;
  const rel = text(a.path);
  const resolved = artifactPathOf(rel, { worktree });
  const out = { id, path: rel || null, shown: resolved.shown, present: false, sha256: null, tooLarge: false };
  if (!resolved.found) return out;
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
    case "gate": {
      const gate = text(f.gate) || "the gate";
      const where = text(f.path) || "(no path)";
      return f.present === false
        ? `gate ${gate} follows stage ${text(f.stage) || "?"} and declares a decision record at ${where} — the code does not decide it, and the record has not been written`
        : `gate ${gate} crossed by ${where}`;
    }
    case "cap": {
      const edge = text(f.edge);
      const ends = text(f.from) && text(f.to) ? ` (${text(f.from)} → ${text(f.to)})` : "";
      if (f.limit == null) return `the loop ${edge}${ends} names ${f.text ? `a cap of ${JSON.stringify(f.text)}` : "no cap"}, which is not a readable bound — the panel does not guess a limit, so the edge is not taken`;
      return `the loop ${edge}${ends} is at its cap of ${f.limit} round${f.limit === 1 ? "" : "s"} — ${f.used ?? 0} crossing${f.used === 1 ? "" : "s"} already taken, so the row stops here for a decision`;
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

// A tree path is claimed by every OPEN row whose own field or worktree normalises to it (§3.5). `claims` carries the
// other queues' rows, because a tree is a directory on the disk and not a property of one queue.
export function treeClaims(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObject(row) || !["queued", "running", "parked"].includes(String(row.state || ""))) continue;
    const run = isObject(row[TASK_PIPELINE_FIELD]) ? row[TASK_PIPELINE_FIELD] : null;
    const paths = [text(run && run.tree && run.tree.path), text(row.worktree)].filter(Boolean);
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
// panel adds no second instruction; a stage prompt the driver appended a brief to would be two briefs in one turn.
export function stagePrompt(task, pipeline, stage, { run = null, tree = null, facts = null } = {}) {
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
  const inputs = record ? inputsBlock({ task, pipeline, stage, run: record, tree, facts }) : [];
  if (inputs.length) lines.push("", "INPUTS", ...inputs);
  if (detail) lines.push("", detail);
  return lines.join("\n");
}

// The INPUTS block. Four rules decide its shape (design §5.2): the panel RESOLVES and the agent READS; a gate's
// decision is named and never read; a loop back names the earlier visit's artifact as the same file; tree facts are
// facts, not cleanups. Every line is optional, because a fact the panel does not hold is not printed as a guess.
function inputsBlock({ task, pipeline, stage, run, tree = null, facts = null }) {
  const lines = [];
  const handoffs = Array.isArray(pipeline && pipeline.handoffs) ? pipeline.handoffs : [];
  const stages = Array.isArray(pipeline && pipeline.stages) ? pipeline.stages : [];
  const artifactById = (id) => {
    const wanted = text(id);
    if (!wanted) return null;
    for (const s of stages) if (isObject(s.artifact) && text(s.artifact.id) === wanted) return { stage: s, artifact: s.artifact };
    return null;
  };
  const visit = run ? visitOf(run, stage.id) : 1;
  const worktree = text(tree && tree.path) || text(run && run.tree && run.tree.path) || text(task && task.worktree) || null;

  // The edge the row arrived by: `via` when the record carries it, otherwise the handoff INTO this stage.
  const arrived =
    handoffs.find((h) => text(h.id) === text(run && run.via)) ||
    [...handoffs].reverse().find((h) => text(h.to) === text(stage && stage.id)) ||
    null;
  if (arrived) {
    const held = artifactById(arrived.artifact);
    const resolved = held ? artifactOf(held.artifact, { worktree }) : null;
    const hash = resolved && resolved.sha256 ? `sha256 ${resolved.sha256.slice(0, 12)}…` : resolved && resolved.present === false ? "not in the tree" : "no hash";
    const cap = capOf(arrived);
    const crossings = Number(run && isObject(run.crossings) ? run.crossings[arrived.id] : 0) || 0;
    const kind = text(arrived.kind) || "sequence";
    const bound = kind === "loop" && cap.limit != null ? ` — crossing ${crossings} of a cap of ${cap.limit}` : "";
    lines.push(
      `  handed on   ${text(arrived.artifact) || "(no artifact)"}   ${resolved ? resolved.path : text(arrived.artifact)}   ${hash}${held ? `   writer ${text(held.artifact.writer) || "(unnamed)"}` : ""}`,
    );
    lines.push(`              (${text(arrived.from)} → ${text(arrived.to)}, handoff ${text(arrived.id)}, ${kind}${bound})`);
  }
  const gate = arrived ? gateAfter(pipeline, text(arrived.from)) : null;
  if (gate && gate.decision) {
    lines.push(`  came back   the row arrived by ${text(arrived.id)} from ${text(arrived.from)}; the gate ${text(gate.id)} after it declares ${text(gate.decision.path)} — read it; the panel does not read it for you`);
  }
  // The earlier visit's artifact: the one input a fresh agent cannot reconstruct, and the reason a loop back parks
  // when it is gone (§5.2 rule 3).
  if (visit > 1 && stage && isObject(stage.artifact)) {
    const previous = [...stageRunsOf(run)].reverse().find((entry) => text(entry.stage) === text(stage.id) && Number(entry.visit) < visit && entry.artifact);
    const now = artifactOf(stage.artifact, { worktree });
    const was = previous && previous.artifact ? previous.artifact : null;
    if (was) {
      const same = Boolean(was.sha256 && now && now.sha256 && was.sha256 === now.sha256);
      lines.push(
        `  earlier     ${text(stage.artifact.id)}   ${was.path || text(stage.artifact.path)}   sha256 ${text(was.sha256).slice(0, 12) || "(none)"}   (this stage, visit ${Number(previous.visit)} — ${same ? "unchanged" : "changed since"})`,
      );
    }
  }
  if (worktree) {
    lines.push(`  tree        ${worktree}   branch ${text(tree && tree.branch) || text(run && run.tree && run.tree.branch) || "(unknown)"}`);
    const head = text(facts && facts.head);
    const dirty = facts && Number.isFinite(Number(facts.dirty)) ? Number(facts.dirty) : null;
    if (head || dirty != null) {
      lines.push(`              ${head ? `HEAD ${head}` : "HEAD unknown"}   ${dirty != null ? `${dirty} uncommitted file${dirty === 1 ? "" : "s"}` : "uncommitted files unknown"}`);
    }
  }
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
function artifactCheck(stage, task, run, facts) {
  const declared = isObject(stage && stage.artifact) ? stage.artifact : null;
  if (!declared) return { checked: false, artifact: null };
  const treePath = text(run && run.tree && run.tree.path) || text(task && task.worktree) || null;
  if (!treePath) return { checked: false, artifact: { id: text(declared.id) || null, path: text(declared.path) || null, present: null, sha256: null } };
  const found = artifactOf(declared, { worktree: treePath });
  // The previous visit's hash, when this stage is a second entry: identical bytes are recorded `unchanged`, which is a
  // visible fact and not a park (§7.7).
  let unchanged = false;
  if (found && found.present && found.sha256) {
    const earlier = [...stageRunsOf(run)]
      .reverse()
      .find((entry) => text(entry.stage) === text(stage.id) && Number(entry.visit) < visitOf(run, stage.id) && isObject(entry.artifact) && entry.artifact.sha256 === found.sha256);
    unchanged = Boolean(earlier);
  }
  return {
    checked: true,
    unchanged,
    artifact: {
      id: text(declared.id) || null,
      path: text(declared.path) || null,
      present: Boolean(found && found.present),
      sha256: found && found.sha256 ? found.sha256 : null,
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
export function driveTaskPipelines(tasks, { bundle: source = null, jobs = [], isLive = () => false, at = new Date(), unattended = false, claims = [], treeOf = null } = {}) {
  const bundle = loadedBundle(source);
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const changed = [];
  const starts = [];
  const ensureTree = [];
  const notes = [];

  const resolve = (task) => resolveTaskPipeline(task, { bundle, now: at });
  const factsFor = (treePath) => (typeof treeOf === "function" && text(treePath) ? treeOf(text(treePath)) : null);
  // Every open row in this queue plus whatever the caller says the other queues hold: one map, so two rows in one tree
  // are found whichever file they live in.
  const claimsMap = treeClaims([...list, ...(Array.isArray(claims) ? claims : [])]);

  // Park with a decision: one sentence for the row, the stage run and the journal, rendered from one fact.
  const stop = (index, { code, trigger = "stage-settled", fact, waitingFor = null, by = "panel" }) => {
    const decision = decisionOf({ code, trigger, by, at: isoOf(at), fact });
    const task = list[index];
    const parked = parkRow(list, index, { reason: decision.reason, waitingFor, at });
    if (!parked) return null;
    const withDecision = recordStageDecision(parked, decision);
    list[index] = withDecision;
    changed.push({ id: task.id, title: task.title, thread: currentThread(task), from: String(task.state || ""), to: "parked", stage: text(task[TASK_PIPELINE_FIELD] && task[TASK_PIPELINE_FIELD].stage), why: decision.reason, code });
    return withDecision;
  };

  // 1. A parked row whose gate record has arrived crosses it. This runs FIRST because the record may have landed
  //    since the last pass, and a row released into `queued` without its stage moved would start the settled stage
  //    again — the one thing a gate must not do.
  for (let i = 0; i < list.length; i += 1) {
    const task = list[i];
    if (task.state !== "parked") continue;
    const run = isObject(task[TASK_PIPELINE_FIELD]) ? task[TASK_PIPELINE_FIELD] : null;
    const wait = run && isObject(run[WAITING_FOR]) ? run[WAITING_FOR] : null;
    if (!wait) continue;
    // A cap or a fingerprint park has no world-state that could release it: its release is a queue action (§6.4).
    if (text(wait.kind) && text(wait.kind) !== "gate") continue;
    const record = decisionPathOf(wait.path, { worktree: task.worktree });
    if (!record.found) continue;
    const resolved = resolve(task);
    if (!resolved.ok) {
      stop(i, { code: DRIVE_FAULTS.UNRESOLVED, trigger: "unresolved", fact: { kind: "record", reason: resolved.reason, stage: run.stage, pipeline: run.pipeline } });
      continue;
    }
    const pipeline = pipelineById(bundle, resolved.pipeline);
    const step = nextStageOf(pipeline, run, { worktree: treeLookup(task).path || task.worktree });
    if (!step.ok) {
      if (step.code === DRIVE_FAULTS.GATE) continue;
      notes.push({ id: task.id, code: step.code, reason: step.reason });
      continue;
    }
    if (step.done) {
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
    const detail = text(last.finalMessage) || text(last.summary) || text(last.lastLine);

    if (FAILED_STATUS.has(status)) {
      stop(i, {
        code: DRIVE_FAULTS.FAILED,
        fact: { kind: "run-status", status, detail: detail || null, stage: run.stage, pipeline: run.pipeline, thread },
      });
      continue;
    }
    if (status !== "done") continue;

    // What settled: the record, the graph, the tree and the artifact. The artifact is checked BEFORE the graph because
    // it is the stage's own output; an absent one is the design's one new hard gate (§5.3).
    const resolved = resolve(task);
    if (!resolved.ok) {
      stop(i, { code: DRIVE_FAULTS.UNRESOLVED, trigger: "unresolved", fact: { kind: "record", reason: resolved.reason, stage: run.stage, pipeline: run.pipeline } });
      continue;
    }
    const pipeline = pipelineById(bundle, resolved.pipeline);
    const tree = treeLookup(task);
    if (tree.lost) {
      stop(i, {
        code: DRIVE_FAULTS.TREE_GONE,
        trigger: "tree",
        fact: { kind: "tree", code: DRIVE_FAULTS.TREE_GONE, path: tree.lost.path, lastStage: tree.lost.stage, stage: run.stage, pipeline: run.pipeline },
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
      });
      continue;
    }
    const stage = stageById(pipeline, resolved.stage);
    const checked = artifactCheck(stage, task, run, factsFor(tree.path));
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
      tree: treeFactsRecord(tree.path || task.worktree, tree.tree || run.tree, factsFor(tree.path)),
      decision: settledDecision,
    });
    if (artifact && artifact.unchanged) {
      settled = settleStageRun(settled, {
        stage: run.stage,
        decision: decisionOf({ code: null, trigger: "stage-settled", at: isoOf(at), fact: { kind: "artifact", ...artifact, stage: run.stage, pipeline: run.pipeline } }),
      });
    }
    list[i] = settled;
    if (artifact && checked.checked && !artifact.present) {
      const edge = edgeOutOf(pipeline, resolved.stage);
      stop(i, {
        code: DRIVE_FAULTS.ARTIFACT,
        trigger: "artifact-missing",
        fact: { kind: "artifact", id: artifact.id, path: artifact.path, present: false, handoff: edge ? text(edge.id) : null, stage: run.stage, pipeline: run.pipeline },
      });
      continue;
    }
    const step = nextStageOf(pipeline, run, { worktree: tree.path || task.worktree });
    if (!step.ok) {
      const isGate = step.code === DRIVE_FAULTS.GATE;
      const fact = isGate
        ? { kind: "gate", gate: text(step.gate && step.gate.id), path: step.path, present: false, stage: run.stage, pipeline: run.pipeline }
        : step.code === DRIVE_FAULTS.CAP
          ? {
              kind: "cap",
              edge: text(step.handoff && step.handoff.id),
              from: text(step.handoff && step.handoff.from),
              to: text(step.handoff && step.handoff.to),
              text: text(step.handoff && step.handoff.cap),
              used: step.used,
              limit: step.limit,
              stage: run.stage,
              pipeline: run.pipeline,
            }
          : { kind: "record", reason: step.reason, stage: run.stage, pipeline: run.pipeline };
      stop(i, {
        code: step.code,
        trigger: isGate ? "stage-settled" : step.code === DRIVE_FAULTS.CAP ? "cap" : "unresolved",
        fact,
        waitingFor: isGate
          ? { kind: "gate", gate: step.gate.id, path: step.gate.decision.path, stage: run.stage, since: isoOf(at) }
          : step.code === DRIVE_FAULTS.CAP
            ? { kind: "cap", edge: text(step.handoff && step.handoff.id), from: text(step.handoff && step.handoff.from), to: text(step.handoff && step.handoff.to), limit: step.limit, used: step.used, stage: run.stage, since: isoOf(at) }
            : null,
      });
      continue;
    }

    if (step.done) continue; // the last stage: the settle finishes the row, on the landing rule it has always had

    const why = `stage ${run.stage} settled — moved to ${step.stage.id} (${step.stage.position} of ${pipeline.stages.length}) of ${pipeline.id}`;
    const moved = setTaskState(list, task.id, "queued", { by: "panel", at, reason: why });
    if (!moved) {
      list[i] = settled;
      continue;
    }
    list.splice(0, list.length, ...moved.tasks);
    list[i] = moveTo(moved.task, step, { at, pipeline, tree: tree.tree });
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
        const index = list.indexOf(front);
        if (starting) {
          notes.push({ id: front.id, code: DRIVE_FAULTS.STARTING, reason: `stage ${run.stage} was started ${Math.round((msOf(at) - asked) / 1000)}s ago and its run has not linked yet — a second start is not asked for` });
        } else if (!resolved.ok) {
          stop(index, { code: DRIVE_FAULTS.UNRESOLVED, trigger: "unresolved", fact: { kind: "record", reason: resolved.reason, stage: run.stage, pipeline: run.pipeline } });
        } else {
          const pipeline = pipelineById(bundle, resolved.pipeline);
          const stage = stageById(pipeline, resolved.stage);
          const tree = treeLookup(front);
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
          } else {
            const claim = tree.path ? claimAgainst(treeKey(tree.path), front, claimsMap) : null;
            if (claim) {
              stop(index, {
                code: DRIVE_FAULTS.TREE_CLAIMED,
                trigger: "tree",
                fact: { kind: "tree", code: DRIVE_FAULTS.TREE_CLAIMED, path: tree.path, otherId: claim.id, otherTitle: claim.title, stage: run.stage, pipeline: run.pipeline },
              });
            } else if (!tree.path) {
              // No tree and a project to cut in: the CUT is its own request, performed by the assistant and written on
              // the row before anything starts (§3.2). The next pass finds the tree and asks for the start.
              const prompt = stagePrompt(front, pipeline, stage);
              ensureTree.push({ taskId: front.id, pipeline: pipeline.id, stage: stage.id, prompt, project, title: front.title });
              notes.push({ id: front.id, code: DRIVE_FAULTS.STARTING, reason: `stage ${stage.id} needs a tree before it can start — the cut is the assistant's step` });
            } else {
              const facts = factsFor(tree.path);
              const prompt = stagePrompt(front, pipeline, stage, { run, tree: { ...(tree.tree || {}), path: tree.path, branch: tree.branch }, facts });
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
                  tree: { path: tree.path, branch: text(tree.branch) || text(run.tree && run.tree.branch) || null },
                });
                // The marker and the ledger entry are written with the row, BEFORE the caller starts anything: the
                // marker is what the next pass reads, and the entry is what a restart reads to know this attempt existed.
                const marked = { ...front, [TASK_PIPELINE_FIELD]: { ...run, [STARTING_AT]: isoOf(at), ...(tree.tree && !run.tree ? { tree: tree.tree } : {}) } };
                const withEntry = beginStageRun(marked, { stage: stage.id, at: isoOf(at) });
                const withFacts = settleStageRun(withEntry, { stage: stage.id, tree: treeFactsRecord(tree.path, tree.tree || run.tree, facts) });
                list[index] = withFacts;
              }
            }
          }
        }
      }
    }
  }

  return { tasks: list, changed, starts, ensureTree, notes };
}
