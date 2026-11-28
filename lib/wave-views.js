// THE WAVE VIEWS: one member and one wave, as the lane draws them. This is the half of lib/waves.js that folds a
// record and its members into the shape the lane draws - the member, the wave, the initiative's lane and the current
// wave - and lib/waves.js imports it and re-exports every name it published before the cut (row 510, the cut after
// row 509's lanes), so no import site moved and the module's surface is unchanged.
//
// WHAT IT IS MADE OF. `waveMember` is one task row as a member: its id, its tree, its state, the abandonment a person
// recorded and the lane it names. `waveView` is one wave with its members, its derived state, its two gate answers and
// the lanes the fold read. `waveLane` is one initiative's whole lane: its waves in position order, the auto switch's
// answer riding on each view, and the current wave derived from the states.
//
// NOTHING IS STORED AND NOTHING IS READ TWICE. The members and the gate reads are arguments, so a test can answer
// every state without a server, a queue file or a clock. `waveView` reads the lane set ONCE and hands it to
// `deriveWaveState`, so the lanes drawn beside a state are the lanes that state was folded from, and the auto switch
// judges the exit answers those views already carry rather than going back for a second opinion.
//
// IT IS A VIEW, SO IT OWNS NO RULE. The state fold (`deriveWaveState`), the auto switch (`waveAutoOpens`), the gate
// read (`readWaveGate`) and the caps stay in lib/waves.js and are imported here; this file only composes them into the
// record a lane draws. `isObject` and `noneGate` travel with the views because `taskWithOwner` and `waveView` ask
// them, and lib/waves.js imports them back - the same direction row 509 used for `clip` and `namedAbandon`. The two
// modules therefore import each other. That is inert: neither reads the other's bindings while a module is being
// evaluated, only inside a function a caller has already loaded both for, and both import orders were run rather than
// assumed (docs/reports/wave-views-cut-2026-11-28.html).
import { TASK_FILES_MAX, TASK_STATES } from "./assistant/queue.js";
import { clip, waveLaneNamed, waveLanes } from "./wave-lanes.js";
import { timeSync } from "./read-profile.js";
import { WAVE_MEMBERS_MAX, WAVES_MAX, WAVE_STATE_WORDS, WAVE_TITLE_MAX, deriveWaveState, readWaveGate, waveAutoOpens } from "./waves.js";

// The object test the record and the views both ask; lib/waves.js imports it back rather than keeping a second copy
// of the rule.
export const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// `check` is kept when the gate NAMES one but has nothing to read it against. The state is still `none` - there is no
// answer - but "no gate" and "a gate with no member yet" are different facts, and a wave authored from the tab is the
// first case where the difference is visible: a just-created wave has its gates and no member to check them against.
export const noneGate = (why, check = null) => ({ check: check || null, state: "none", met: false, cannotTell: false, closed: false, why });

// ---- one member, as the lane draws it ------------------------------------------------------------------------------
// A member is a TASK, so every field here is the row's own: its state, the project and tree it names, the thread it
// is on, the pipeline it carries, and the abandonment a person recorded. The board row is the display beside it
// (dirty count, commits ahead, verdict, PR); `hasRow` is what makes "cannot tell" possible for a gate that needs
// one. The stored PR word is passed through so the lane can draw it - the GATE never reads it (readWaveGate takes
// the live evidence from lib/wave-evidence.js instead).
//
// `key` is how the caller's evidence map finds this member: the task id plus its tree, normalised the same way on
// both sides (lib/wave-evidence.js `collectWaveEvidence` uses this function, never its own copy of the rule).
export function waveMemberKey(task) {
  const id = Number(task?.id);
  const tree = String(task?.worktree || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return `${Number.isFinite(id) && id > 0 ? id : "?"}@${tree}`;
}

function abandonedOf(task) {
  const raw = task?.abandoned;
  const reason = typeof raw === "string" ? raw : String(raw && raw.reason ? raw.reason : "");
  const cleaned = reason.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return { reason: clip(cleaned, 600), at: raw && typeof raw === "object" ? raw.at || null : null, by: raw && typeof raw === "object" ? raw.by || null : null };
}

/**
 * Stamp the assistant a queue row came from onto the row itself.
 *
 * EVERY ASSISTANT NUMBERS ITS OWN QUEUE FROM ONE, so a task id alone cannot name the list it lives in - `#309` is a
 * different piece of work in Assistant #1's file and in Assistant #3's. The queue file is per assistant (the directory
 * names the owner), so the owner is only known where the queues are flattened for a wave read; this stamps it before
 * the fold, and `waveMember` carries it on. Three fields, because the lane needs to name the owner (chip), open its
 * queue (the id) and draw the same tag the worktree column draws (the role label).
 *
 * Pure and idempotent: a row that already names its owner is kept as it is, so a caller that hands the view rows it
 * has already stamped (`boardTasks`) cannot rewrite them with a second opinion.
 */
export function taskWithOwner(task, rec, label = "") {
  if (!isObject(task)) return task;
  const id = String(rec?.id || "").trim();
  if (!id || String(task.assistantId || "").trim()) return task;
  return {
    ...task,
    assistantId: id,
    assistantName: String(rec?.name || id).trim(),
    assistantLabel: String(label || "").replace(/\s+/g, " ").trim(),
  };
}

export function waveMember(task, row = null) {
  const taskRow = isObject(task?.row) ? task.row : null;
  const pr = isObject(taskRow?.pr) ? taskRow.pr : isObject(row?.pr) ? row.pr : null;
  const state = String(task?.state || "");
  return {
    id: Number.isFinite(Number(task?.id)) && Number(task.id) > 0 ? Number(task.id) : null,
    key: waveMemberKey(task),
    title: clip(String(task?.title ?? "").replace(/\s+/g, " ").trim(), WAVE_TITLE_MAX),
    // WHO OWNS THE ROW, carried from the queue it was read out of (taskWithOwner above). A member whose row names no
    // owner still draws - the bar keeps its title and its state - it just cannot open a queue it cannot name.
    assistantId: String(task?.assistantId || "").trim() || null,
    assistantName: clip(String(task?.assistantName || "").replace(/\s+/g, " ").trim(), 80) || null,
    assistantLabel: clip(String(task?.assistantLabel || "").replace(/\s+/g, " ").trim(), 80) || null,
    state: TASK_STATES.includes(state) ? state : "queued",
    // A NAMED abandonment is a decision, not one of the queue's four states: the lane draws it in place of the state
    // word (the state the row happens to be in no longer describes the work), and the exit gate closes as abandoned.
    abandoned: abandonedOf(task),
    project: String(task?.project || row?.project || "").trim() || null,
    worktree: String(task?.worktree || "").trim() || null,
    thread: String(task?.thread || "").trim() || null,
    // THE LANE IS THE MEMBER'S OWN WORD, when it has one: a wave never stores a lane list, so the only place a lane can
    // be named is the row that runs in it. A member that names none is grouped by the files it claims (waveLanes), and
    // `files` is carried here because that grouping and the stage pin both read it.
    lane: waveLaneNamed(task),
    files: (Array.isArray(task?.files) ? task.files : []).map((f) => String(f).trim()).filter(Boolean).slice(0, TASK_FILES_MAX),
    // The pipeline the TASK names, if any. A wave template is inherited only when this is null; see waveView.
    pipeline: String(task?.pipelineRun?.pipeline || "").trim() || null,
    pr: pr
      ? {
          number: Number(pr.number) > 0 ? Number(pr.number) : null,
          state: String(pr.state || "").trim() || null,
        }
      : null,
    hasRow: Boolean(row),
    dirty: Number.isFinite(Number(row?.dirty)) ? Number(row.dirty) : null,
    ahead: Number.isFinite(Number(row?.ahead)) ? Number(row.ahead) : null,
    verdict: row?.verdict ? String(row.verdict) : null,
  };
}

// ---- one wave, as the lane draws it --------------------------------------------------------------------------------
/**
 * Fold one wave with its members. Pure: the members and the gate read are arguments, so a test can answer every state
 * without a server, a queue file or a clock.
 */
export function waveView({ wave, members = [], readGate = readWaveGate, evidenceFor = null, templateExists = null } = {}) {
  const record = wave && typeof wave === "object" ? wave : null;
  if (!record) return null;
  const list = (Array.isArray(members) ? members : []).slice(0, WAVE_MEMBERS_MAX);
  // A task that names no pipeline of its own INHERITS the wave's template. A task that names one keeps it: the
  // reader's first decision is that a wave names a template its tasks inherit and a task may name its own.
  const withTemplate = list.map((m) => ({
    ...m,
    pipeline: m.pipeline || record.template || null,
    pipelineFrom: m.pipeline ? "task" : record.template ? "wave" : null,
  }));
  // The lane set is read ONCE here and handed to the fold, so the lanes drawn beside a state are the lanes that state
  // was folded from. A wave record never carries this: it is derived from the members on every read.
  const lanes = timeSync("wave.lanes", () => waveLanes(withTemplate));
  const derived = timeSync("wave.state", () => deriveWaveState({ wave: record, members: withTemplate, readGate, evidenceFor, lanes }));
  // Both chips read the SAME evidence a gate decision reads: the entry chip and the fold cannot disagree about a
  // gate, because they are one call to the same reader with the same argument.
  const entry = record.entryGate ? readGate(record.entryGate, withTemplate, evidenceFor) : noneGate("no entry gate - this wave opens by hand");
  const exit = record.exitGate ? readGate(record.exitGate, withTemplate, evidenceFor) : noneGate("no exit gate - this wave closes when every member is closed");
  return {
    id: record.id,
    initiativeId: record.initiativeId,
    position: record.position,
    title: record.title,
    template: record.template,
    // A name the bundle no longer holds reads unresolved, never null. A caller that has no bundle read to give
    // passes no templateExists and the lane says it could not check, rather than claiming either answer.
    templateResolved: record.template
      ? timeSync("wave.template", () => (typeof templateExists === "function" ? Boolean(templateExists(record.template)) : null))
      : null,
    auto: record.auto === true,
    entryGate: record.entryGate ? { ...record.entryGate } : null,
    exitGate: record.exitGate ? { ...record.exitGate } : null,
    gates: { entry, exit },
    state: derived.state,
    stateWord: WAVE_STATE_WORDS[derived.state] || derived.state,
    stateWhy: derived.why,
    // The lanes, derived: `implicit` is the one lane a wave with no lane of its own holds (today's wave), `joinOwed`
    // says a close is a join, and `laneRefused` is the sentence when two lanes hold one tree.
    lanes: lanes.lanes,
    laneCount: lanes.count,
    laneImplicit: lanes.implicit,
    laneJoinOwed: lanes.joinOwed,
    laneIsolation: lanes.isolation,
    laneRefused: lanes.refused ? lanes.refused.why : null,
    members: withTemplate,
  };
}

// Which wave is CURRENT is derived too - the lowest-position running wave, else the lowest-position ready one, else
// the lowest-position unentered one. A display rule with a stated order, not a field anybody can forget to update.
export function currentWaveId(waves = []) {
  const list = Array.isArray(waves) ? waves : [];
  for (const state of ["running", "ready", "unentered"]) {
    const found = list
      .filter((w) => w && w.state === state)
      .sort((a, b) => Number(a.position) - Number(b.position) || String(a.id).localeCompare(String(b.id)))[0];
    if (found) return found.id;
  }
  return null;
}

/**
 * One initiative's lane: its waves in position order, each with its members, its derived state and its gate reads.
 * `tasks` is every assistant's queue rows, not only the ones on this initiative's trees: membership is the task's
 * own waveId, and that is exactly what lets a wave span projects. A task with no waveId is in no wave at all - it is
 * never defaulted into the first one.
 *
 * The AUTO SWITCH is evaluated here and nowhere else (see `waveAutoOpens` above): every wave carries `autoOpen` for
 * this read, which names the predecessor whose exit gate was read and says whether a switch opened it. An auto-opened
 * wave keeps the switch its own record carries - absent is false - so nothing cascades.
 */
export function waveLane({ waves, initiativeId, tasks = [], rowFor = () => null, templateExists = null, evidenceFor = null } = {}) {
  const id = String(initiativeId || "");
  if (!waves || typeof waves.wavesFor !== "function") return { waves: [], skipped: [], currentId: null };
  const buckets = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const waveId = String(task?.waveId ?? "");
    if (!waveId) continue;
    const bucket = buckets.get(waveId) || [];
    if (bucket.length >= WAVE_MEMBERS_MAX) continue;
    const row = task?.worktree ? rowFor(String(task.project || ""), task.worktree) : null;
    bucket.push(waveMember(task, row));
    buckets.set(waveId, bucket);
  }
  const list = waves
    .wavesFor(id)
    .slice(0, WAVES_MAX)
    .map((wave) => waveView({ wave, members: buckets.get(wave.id) || [], templateExists, evidenceFor }))
    .filter(Boolean);
  // THE ONE PLACE THE AUTO SWITCH IS EVALUATED. Each view already carries its own exit gate answer, made above
  // against the live evidence for this read, so the predecessor's answer is judged here rather than read again. No
  // store write, no timer, no advance: these are the two routes' answers for this request, and the next request asks
  // again. See the section above for the four rules and for what happens when nobody reads.
  const opens = waveAutoOpens(list);
  const drawn = list.map((view, index) => ({ ...view, autoOpen: opens[index] }));
  return {
    waves: drawn,
    skipped: typeof waves.skippedFor === "function" ? waves.skippedFor(id) : [],
    currentId: currentWaveId(drawn),
  };
}
