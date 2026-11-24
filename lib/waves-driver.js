// THE WAVE DRIVER: one advance per settle, and no clock of its own.
//
// A wave is an ordered group of task cards (lib/waves.js). The fold derives its state on every read, and the auto
// switch opens the NEXT wave on a read - but a read has never started anything, so a wave whose cards were all done sat
// `ready` until a person pressed the next card by hand. That is the reader's report this module answers.
//
// THE PRECEDENT IS `advancePipelineTree` (lib/assistant.js): the panel's settle path is the ONLY clock, one advance
// answers ONE settle, and the decision is written on the record that was read, so a replayed settle, a restart or a
// second pass over the same record starts nothing twice. There is no scheduler, no ticker and no second poller here.
// The job store (lib/jobs.js) fires `onTurnSettled` from its one `settle`, server.js hands the settle to this module,
// and this module is done until the next settle.
//
// THE THREE CASES, and the one rule behind all of them (the wave's own cards are the evidence):
//
//   1. CLOSING ON MEMBERSHIP. A wave that names no exit gate closes when every member is closed - done, or abandoned
//      for a named reason (lib/waves.js deriveWaveState). A gate nobody authored is never required.
//   2. THE WAVE PROGRESSING. A wave that is already open (a switch opened it, or a member has left `queued`) and still
//      holds a queued member starts that member once nothing of the wave is running. This is the WAVE PROGRESSING, not
//      the auto switch, so it does not depend on `auto` at all.
//   3. CROSSING INTO THE NEXT WAVE is the auto switch's decision, and only when the wave reads done. Auto on opens the
//      next wave and starts its first queued member; auto off writes the sentence a person acts on ("W1 done, W2 ready
//      - press to open") and starts nothing; a next wave with no cards is said plainly ("W2 has no members - file its
//      tasks") and is never skipped silently or invented.
//
// WHAT IS NEVER STARTED: a member whose row is not `queued`, a member carrying a failed attempt (a person retries a
// failed card; an unattended driver does not), a member whose pipeline the pipeline driver owns, a card that names no
// tree, and a tree a live run holds. A refused start is written on the card with its reason, not swallowed.
//
// THE RECORD IS THE CARD THE SETTLE NAMED. Its `waveAdvance` (lib/assistant/queue.js) holds the settle's own key, so
// the replay test is an exact match on that key and nothing else. The stamp is evidence, never state: the wave's state
// is still derived on every read, and no read believes the stamp.
import { currentThread, normRunId, readQueueFile, waveAdvanceOf } from "./assistant/queue.js";
import { liveJobsInTree } from "./jobs.js";
import { waveFileExistsPaths, waveLane } from "./waves.js";

// A settle whose run ended badly. The row's own write is the authority (a failed run requeues it with `attempts + 1`),
// and this set is only the second reading of the same fact for a job store that answers a status before the sweep has
// folded the row.
const SETTLE_FAILED = new Set(["failed", "error", "cancelled", "canceled", "stopped", "exited", "interrupted", "timeout"]);

/** The key a stamp is compared on: the run the settle names, its job id, or (last) its thread. Clipped like the field. */
export function settleKey(settle = {}) {
  const key = normRunId(settle?.runId) || normRunId(settle?.job) || String(settle?.thread || "").trim();
  return key ? String(key).slice(0, 120) : null;
}

/**
 * The card a settle names: the row whose `runId` is the settled run, else the row whose CURRENT thread is the settled
 * thread. An older thread in `threads` is not a match - a row that has moved on belongs to its new run, and a late
 * settle of the attempt it left must not drive it.
 * @returns {{assistantId: string, task: object}|null}
 */
export function settleCard(rows = [], settle = {}) {
  const run = normRunId(settle?.runId) || normRunId(settle?.job);
  const thread = String(settle?.thread || "").trim();
  const list = Array.isArray(rows) ? rows : [];
  if (run) {
    const hit = list.find((r) => normRunId(r?.task?.runId) === run);
    if (hit) return hit;
  }
  if (thread) {
    const hit = list.find((r) => currentThread(r?.task) === thread);
    if (hit) return hit;
  }
  return null;
}

const labelOf = (view) => {
  const position = Number(view && view.position);
  if (Number.isFinite(position) && position > 0) return `W${position}`;
  return String((view && view.id) || "") || "this wave";
};

const memberId = (member) => (Number(member?.id) > 0 ? Number(member.id) : null);

/**
 * Can this member be started by the driver? The refusals are the ones the panel already makes, in the order a reader
 * would meet them, and every one of them is a sentence the card keeps.
 * @returns {{ok: true}|{ok: false, why: string}}
 */
function startable(row, { liveFor = () => null } = {}) {
  const task = row?.task || null;
  if (!task) return { ok: false, why: "the card could not be read from its queue" };
  if (task.state !== "queued") return { ok: false, why: `#${task.id} reads ${task.state}, not queued` };
  if (Number(task.attempts) > 0) {
    return { ok: false, why: `#${task.id} names ${Number(task.attempts)} failed attempt${Number(task.attempts) === 1 ? "" : "s"}: a failed card is a person's retry, not the driver's` };
  }
  const pipeline = String(task.pipelineRun?.pipeline || "").trim();
  if (pipeline) {
    const stage = String(task.pipelineRun?.stage || "").trim();
    return { ok: false, why: `#${task.id} carries pipeline ${pipeline}${stage ? ` at ${stage}` : ""}: the pipeline driver starts it, not this one` };
  }
  const tree = String(task.worktree || "").trim();
  if (!tree) return { ok: false, why: `#${task.id} names no tree, so there is nowhere to start it` };
  const held = liveFor(tree);
  if (held) {
    const holder = String(held.thread || held.id || "").trim();
    return { ok: false, why: `#${task.id}'s tree ${tree} is held by ${holder || "a live run"} - nothing is started in a tree a live run holds` };
  }
  return { ok: true };
}

/** The first queued member, in the order the wave's own member list arrived (the queue's order). */
function firstQueued(wave) {
  return (wave?.members || []).find((m) => m.state === "queued") || null;
}

/**
 * Decide one settle, purely. No store, no clock, no start: a plan a caller can assert on and then perform.
 *
 * @param {object} args
 * @param {object} args.lane        one initiative's fold (lib/waves.js `waveLane`), evidence included
 * @param {Array}  args.rows        [{assistantId, task}] every assistant's queued cards, in queue order
 * @param {object} args.settle      {job, runId, thread, tree, status} - what the job store saw end
 * @param {number} args.now         milliseconds; the stamp's clock
 * @param {function} args.liveFor   (tree) => the live job in it, or null
 * @param {string} args.by          who the stamp names
 * @returns {{at: string, key: string|null, card: object|null, waveId: string|null, action: string|null,
 *            stamp: object|null, start: {assistantId: string, task: object}|null, notes: Array<{code: string, why: string}>}}
 */
export function planWaveAdvance({ lane, rows = [], settle = {}, now = Date.now(), liveFor = () => null, by = "panel" } = {}) {
  const at = new Date(Number(now) || Date.now()).toISOString();
  const key = settleKey(settle);
  const notes = [];
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.task) byKey.set(`${Number(row.task.id)}@${String(row.task.worktree || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}`, row);
  }
  const plan = (extra = {}) => ({ at, key, card: null, waveId: null, action: null, stamp: null, start: null, notes, ...extra });
  const card = settleCard(rows, settle);
  if (!card) {
    notes.push({ code: "no-card", why: `no queue row names the settle ${key || "(no key)"}: no wave is driven` });
    return plan();
  }
  const cardRef = { assistantId: card.assistantId, id: Number(card.task.id) };
  const waveId = String(card.task.waveId || "").trim() || null;
  if (!waveId) {
    notes.push({ code: "no-wave", why: `#${card.task.id} names no wave: the settle drives nothing` });
    return plan({ card: cardRef });
  }
  const waves = Array.isArray(lane?.waves) ? lane.waves : [];
  const index = waves.findIndex((w) => String(w.id) === waveId);
  const wave = index >= 0 ? waves[index] : null;
  if (!wave) {
    notes.push({ code: "wave-missing", why: `#${card.task.id} names wave ${waveId}, which the initiative no longer holds: nothing is driven` });
    return plan({ card: cardRef, waveId });
  }
  // A decided settle's record. `onWave` is the wave the decision LANDED on: the settled card's own wave for a start
  // that kept this wave moving, and the NEXT wave for an open, a surface or an empty hand-off. A stamp that named the
  // previous wave beside a task in the next one would read as a card in the wrong wave.
  const stamp = (action, task, why, onWave = waveId) => ({ at, by, wave: onWave, job: key, action, task: task ?? null, why });
  // THE REPLAY TEST. The card keeps the settle it answered; an exact match on the key is an answered settle, and an
  // answered settle starts nothing - not the member it started, and not the one after it.
  const prior = waveAdvanceOf(card.task);
  if (prior && key && prior.job === key) {
    notes.push({ code: "replay", why: `this settle was already answered on #${card.task.id} (${prior.action}): nothing is started twice` });
    return plan({ card: cardRef, waveId });
  }
  const failed = SETTLE_FAILED.has(String(settle?.status || "").toLowerCase()) || (card.task.state === "queued" && Number(card.task.attempts) > 0);
  if (failed) {
    const why = `the run for #${card.task.id} ended ${String(settle?.status || "without a landing")}, so the card reads ${card.task.state} with ${Number(card.task.attempts) || 0} attempt${Number(card.task.attempts) === 1 ? "" : "s"}: nothing is started from a failed settle`;
    notes.push({ code: "settle-failed", why });
    return plan({ card: cardRef, waveId, action: "refused", stamp: stamp("refused", null, why) });
  }
  const members = Array.isArray(wave.members) ? wave.members : [];
  const running = members.filter((m) => m.state === "running");
  const rowForMember = (member) => {
    const tree = String(member?.worktree || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return byKey.get(`${Number(member?.id)}@${tree}`) || null;
  };

  // CASE 1 AND CASE 3: the wave reads done. How it got there (membership or a met gate) is the fold's answer; what
  // happens next is the switch's.
  if (wave.state === "done") {
    const baseWhy = String(wave.stateWhy || `${labelOf(wave)} reads done`);
    const next = waves[index + 1] || null;
    if (!next) {
      return plan({ card: cardRef, waveId, action: "done", stamp: stamp("done", null, `${baseWhy}; it is the last wave in the initiative`) });
    }
    const here = labelOf(wave);
    const there = labelOf(next);
    if (next.state === "empty") {
      const why = `${here} done, ${there} has no members - file its tasks`;
      notes.push({ code: "next-empty", why });
      return plan({ card: cardRef, waveId: next.id, action: "empty", stamp: stamp("empty", null, why, next.id) });
    }
    if (next.state === "running" || next.state === "done" || next.state === "abandoned") {
      return plan({ card: cardRef, waveId, action: "done", stamp: stamp("done", null, `${baseWhy}; ${there} already reads ${next.state}`) });
    }
    if (wave.auto !== true) {
      // AUTO OFF: the same derived state, the sentence a person acts on, and nothing started. The surface is the fold's
      // own words for this read (lib/waves.js waveAutoOpens), so it cannot disagree with the state drawn beside it.
      const why = String(next.autoOpen?.surface || `${here} done, ${there} ${next.state} - press to open`);
      notes.push({ code: "next-waiting", why });
      return plan({ card: cardRef, waveId: next.id, action: "surfaced", stamp: stamp("surfaced", null, why, next.id) });
    }
    // AUTO ON. The switch opened the next wave on this read (the fold said so); a wave that is not `ready` has its own
    // entry gate in the way, and a gate that has not opened is never stepped over by a start.
    if (next.autoOpen && next.autoOpen.open !== true) {
      const why = String(next.autoOpen.why || `${there} was not opened by ${here}'s switch`);
      notes.push({ code: "next-shut", why });
      return plan({ card: cardRef, waveId, action: "refused", stamp: stamp("refused", null, why) });
    }
    if (next.state !== "ready") {
      const why = `${here} done, but ${there} reads ${next.state}: ${next.stateWhy || "no reason was given"} - nothing is started under a gate that has not opened`;
      notes.push({ code: "next-unready", why });
      return plan({ card: cardRef, waveId, action: "refused", stamp: stamp("refused", null, why) });
    }
    const member = firstQueued(next);
    if (!member) {
      const why = `${here} done and ${there} is open, but it holds no queued member to start`;
      notes.push({ code: "next-no-queued", why });
      return plan({ card: cardRef, waveId: next.id, action: "opened", stamp: stamp("opened", null, why, next.id) });
    }
    const row = rowForMember(member);
    const ok = startable(row, { liveFor });
    if (!ok.ok) {
      notes.push({ code: "start-refused", why: ok.why });
      return plan({ card: cardRef, waveId: next.id, action: "refused", stamp: stamp("refused", memberId(member), ok.why, next.id) });
    }
    const why = `${here} reads done (${baseWhy}); its auto switch is on, so ${there} opened and #${member.id} is its first queued member - started by this settle`;
    return plan({ card: cardRef, waveId: next.id, action: "opened", stamp: stamp("opened", memberId(member), why, next.id), start: { assistantId: row.assistantId, task: row.task } });
  }

  // CASE 2: the wave is open and progressing. Open means a switch opened it or some member has left `queued`; a wave
  // nobody has touched holds every card queued and waits for a person, whatever its own switch says.
  const opened = wave.autoOpen?.open === true || members.some((m) => m.state !== "queued");
  if (!opened) {
    notes.push({ code: "unopened", why: `${labelOf(wave)} reads ${wave.state} and nothing of it has been started: a person opens it` });
    return plan({ card: cardRef, waveId });
  }
  if (running.length) {
    notes.push({ code: "wave-running", why: `${labelOf(wave)} still holds ${running.map((m) => `#${m.id}`).join(", ")} running: nothing starts beside it` });
    return plan({ card: cardRef, waveId });
  }
  if (wave.state !== "ready") {
    notes.push({ code: "wave-blocked", why: `${labelOf(wave)} reads ${wave.state}: ${wave.stateWhy || "no reason was given"} - nothing starts inside it` });
    return plan({ card: cardRef, waveId });
  }
  const member = firstQueued(wave);
  if (!member) {
    notes.push({ code: "no-queued", why: `${labelOf(wave)} holds no queued member: nothing to start` });
    return plan({ card: cardRef, waveId });
  }
  const row = rowForMember(member);
  const ok = startable(row, { liveFor });
  if (!ok.ok) {
    notes.push({ code: "start-refused", why: ok.why });
    return plan({ card: cardRef, waveId, action: "refused", stamp: stamp("refused", memberId(member), ok.why) });
  }
  const why = `${labelOf(wave)} is open and #${member.id} is its next queued member, with nothing of the wave running: started by this settle, whatever the auto switch says`;
  return plan({ card: cardRef, waveId, action: "start", stamp: stamp("start", memberId(member), why), start: { assistantId: row.assistantId, task: row.task } });
}

/**
 * The prompt a wave member is started with. The card is the brief (its detail is the worker's own words), and this
 * adds only what the driver knows: which wave it is in, that the panel closes the member on its pull request, and
 * that a failed attempt is not retried by the panel.
 */
export function memberPrompt({ wave = null, initiativeId = "", position = null, count = null, task = null } = {}) {
  const title = String(task?.title || "").trim() || "(no title)";
  const waveTitle = String(wave?.title || "").trim();
  const where = wave
    ? `Wave ${Number(wave.position) || position || "?"}${count ? ` of ${count}` : ""}${waveTitle ? `: "${waveTitle}"` : ""} (${wave.id}) in initiative ${initiativeId || wave.initiativeId || "(no initiative id)"}.`
    : `Initiative ${initiativeId || "(no initiative id)"}.`;
  const lines = [
    `Queue task #${task?.id}: ${title}`,
    "",
    where,
    "This card is part of a wave: the card before it settled, so the panel started this one. Do the card, and only the card.",
    "The panel closes this member when its pull request reads MERGED; do not close the queue row yourself. If the card cannot be done, say so plainly in your final message, because a failed run returns the card to the queue and nothing is retried automatically.",
    "",
    String(task?.detail || "").trim() || "The card carries no detail; the title is the brief.",
  ];
  const files = Array.isArray(task?.files) ? task.files.filter(Boolean) : [];
  if (files.length) lines.push("", `Files this card claims: ${files.join(", ")}`);
  const tree = String(task?.worktree || "").trim();
  if (tree) lines.push("", `Work in ${tree}${task?.project ? ` (project ${task.project})` : ""}. Report the pull request URL and the branch you landed on.`);
  return lines.join("\n");
}

/**
 * The composer: the settle door the job store calls, the store reads, the one write, and the start.
 *
 * Everything heavy is a dependency of the composition root (server.js), never a module-level singleton, so a test can
 * build one of these over a temp state dir and a stub spawner and prove the same decisions.
 */
export function createWaveDriver({
  waves = null,
  assistant = null,
  jobs = null,
  rowFor = () => null,
  templateExists = null,
  waveEvidence = null,
  log = () => {},
  now = () => Date.now(),
  liveInTree = null,
} = {}) {
  if (!waves || typeof waves.waveById !== "function") throw new Error("createWaveDriver needs the Waves store");
  if (!assistant) throw new Error("createWaveDriver needs the Assistant (its queues and its one start path)");
  let chain = Promise.resolve();

  const queueRows = () => {
    const rows = [];
    for (const rec of Array.isArray(assistant.assistants) ? assistant.assistants : []) {
      let view = null;
      try {
        view = assistant.queueView(rec.id);
      } catch {
        continue; // its own pane reports the error; a wave advance must not fail because one queue cannot be read
      }
      for (const task of Array.isArray(view?.tasks) ? view.tasks : []) rows.push({ assistantId: String(rec.id), task });
    }
    return rows;
  };

  const liveFor = (tree) => {
    if (typeof liveInTree === "function") return liveInTree(tree) || null;
    const list = typeof jobs?.list === "function" ? jobs.list() : typeof assistant.jobs?.list === "function" ? assistant.jobs.list() : [];
    // THE PANEL'S OWN REFUSAL, not a copy of it: `liveJobsInTree` is the lookup `jobs.create` refuses the second cut
    // on, so "a live agent stands in that tree" has one meaning in one place.
    return liveJobsInTree(list, tree)[0] || null;
  };

  const writeStamp = (card, stamp) => {
    const rec = assistant.assistantRecord(card.assistantId);
    if (!rec) return false;
    const file = assistant.queuePathOf(rec);
    const out = readQueueFile(file);
    const at = out.tasks.findIndex((t) => Number(t.id) === Number(card.task.id));
    if (at < 0) return false;
    out.tasks[at] = { ...out.tasks[at], waveAdvance: stamp };
    assistant.writeQueue(file, out.tasks, out.nextId);
    return true;
  };

  const advance = async (settle) => {
    if (!settle || typeof settle !== "object") return null;
    const key = settleKey(settle);
    if (!key) return null;
    // THE CHEAP GATE: read the queues first, and leave without a sweep when the settle names no card in a wave. Most
    // settles are not wave members, and a sweep per settle would make this driver the busiest thing on the box.
    let rows = queueRows();
    const first = settleCard(rows, settle);
    if (!first || !String(first.task.waveId || "").trim()) return null;
    const wave = waves.waveById(String(first.task.waveId));
    if (!wave) return null;
    // The row still reads `running` until the queue sweep folds the settled run into it (lib/assistant/queue.js
    // `settleTasks`), so the sweep runs before the decision - the same order `advancePipelineTree` uses.
    try {
      await assistant.sweepQueues();
    } catch (err) {
      log(`waves: the queue sweep before a wave advance failed: ${String((err && err.message) || err)}`);
    }
    rows = queueRows();
    let evidence = null;
    if (typeof waveEvidence === "function") {
      try {
        // A settle is the read that must see the merge that just happened. It does: a landing answer is keyed on the
        // ref's tip, so a main that moved is re-read rather than served from a memo. The artefact paths are the ones
        // the lane it is about to fold names, or a file-exists gate would answer cannot tell here and hold a wave the
        // panel itself is deciding to advance.
        const map = await waveEvidence({
          tasks: rows.map((r) => r.task),
          rowFor,
          paths: typeof waves.wavesFor === "function" ? waveFileExistsPaths(waves.wavesFor(wave.initiativeId)) : [],
        });
        evidence = map instanceof Map ? map : null;
      } catch (err) {
        log(`waves: the evidence read before a wave advance failed: ${String((err && err.message) || err)}`);
      }
    }
    const tasks = rows.map((r) => r.task);
    const lane = waveLane({ waves, initiativeId: wave.initiativeId, tasks, rowFor, templateExists, evidenceFor: (m) => (evidence ? evidence.get(m.key) || null : null) });
    const plan = planWaveAdvance({ lane, rows, settle, now: now(), liveFor, by: "panel" });
    const card = settleCard(rows, settle);
    if (!card) return plan;
    for (const note of plan.notes) log(`waves: #${card.task.id} ${note.code}: ${note.why}`);
    let stamp = plan.stamp;
    if (plan.start) {
      // THE PROMPT NAMES THE WAVE THE STARTED CARD IS IN, not the wave whose settle made the decision: an auto open
      // starts a card in the NEXT wave, and a card told it is in wave 1 would be briefed wrong.
      const startWave = waves.waveById(String(plan.start.task.waveId || "")) || wave;
      const spec = {
        target: String(plan.start.task.worktree || ""),
        existing: true,
        project: plan.start.task.project || null,
        taskId: Number(plan.start.task.id),
        assistantId: plan.start.assistantId,
        prompt: memberPrompt({ wave: startWave, initiativeId: startWave.initiativeId || wave.initiativeId, task: plan.start.task }),
      };
      const boardRow = rowFor(String(spec.project || ""), spec.target);
      if (boardRow && boardRow.branch) spec.branch = String(boardRow.branch);
      try {
        const job = await assistant.startSpawn(spec, { source: "wave", assistantId: plan.start.assistantId });
        if (!job || !job.id) throw new Error("the spawner started nothing");
        log(`waves: #${card.task.id} started #${plan.start.task.id} (${job.thread || job.id}) after its settle`);
      } catch (err) {
        // A start that cannot be made is a decision, not a retry: the refusal is written on the card, so a replay of
        // this settle does not try again and a person reads what happened.
        const why = `#${plan.start.task.id} could not be started: ${String((err && err.message) || err)}`;
        log(`waves: ${why}`);
        stamp = { ...plan.stamp, action: "refused", task: plan.start.task.id, why };
      }
    }
    if (stamp) {
      const written = writeStamp(card, stamp);
      if (written) assistant.journalAdd("wave", currentThread(card.task), `#${card.task.id} ${stamp.wave || wave.id}: ${stamp.action}${stamp.task ? ` #${stamp.task}` : ""} - ${stamp.why}`);
    }
    return { ...plan, stamp };
  };

  return {
    /** One settle in, one advance out. Serialised: two settles in the same tick read each other's writes. */
    advanceSettle(settle = {}) {
      const next = chain.then(
        () => advance(settle).catch((err) => log(`waves: the advance for a settle failed: ${String((err && err.message) || err)}`)),
        () => advance(settle).catch((err) => log(`waves: the advance for a settle failed: ${String((err && err.message) || err)}`)),
      );
      chain = next;
      return next;
    },
  };
}
