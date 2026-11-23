// THE WAVE DRIVER (lib/waves-driver.js): one advance per settle, the decision on the record it read, and the three
// cases the reader's report names.
//
// This file pins the decisions a settle makes, against a real wave store and a real lane fold:
//   1. a gate-less wave closes on its MEMBERSHIP (done, or abandoned for a named reason), and a bare abandonment does not;
//   2. an open wave whose next card is still queued starts that card - the WAVE PROGRESSING, whatever `auto` says;
//   3. crossing into the next wave is the switch's: on starts its first queued card, off writes the press sentence and
//      starts nothing, and a next wave with no cards is named plainly;
//   4. a replay of the settle starts nothing twice, a held tree is refused, and a failed/pipeline/no-tree card is
//      refused with its own sentence.
// The composer's write is proven too, over a stub assistant record and a stub spawner: the stamp lands on the card the
// settle named, and the spawned spec names the member's own tree and row.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { Waves, waveLane } from "../lib/waves.js";
import { createWaveDriver, memberPrompt, planWaveAdvance, settleCard, settleKey } from "../lib/waves-driver.js";
import { pickTask, readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";

const dir = mkdtempSync(path.join(tmpdir(), "wag-waves-drive-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const gapeless = (id, position, auto = false) => ({ id, initiativeId: "init_a", position, title: `wave ${position}`, entryGate: null, exitGate: null, template: null, auto });
const task = (id, waveId, state, over = {}) => ({
  id,
  title: `task ${id}`,
  state,
  waveId,
  project: "proj",
  worktree: `/work/proj/.worktrees/t${id}`,
  // The run the row was handed, so a settle in these tests names this card and no other: `settleOf(id)` builds the
  // matching run id and thread, which is the same pair the job store passes.
  runId: `run-${id}`,
  thread: `thread-${id}`,
  files: [],
  detail: "",
  attempts: 0,
  ...over,
});
const storeOf = (name, records) => {
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify({ version: 1, byInitiative: { init_a: records } }, null, 2)}\n`, "utf8");
  return new Waves({ file, log: () => {} });
};
const laneOf = (waves, tasks) => waveLane({ waves, initiativeId: "init_a", tasks, rowFor: () => null, evidenceFor: () => null });
const rowsOf = (tasks, assistantId = "assistant-1") => tasks.map((t) => ({ assistantId, task: t }));
const settleOf = (id, over = {}) => ({ job: `job-${id}`, runId: `run-${id}`, thread: `thread-${id}`, status: "done", ...over });

test("a gate-less wave with every member closed reads done, and the settle records it", () => {
  const waves = storeOf("closed", [gapeless("wave_01", 1), gapeless("wave_02", 2)]);
  const tasks = [task(1, "wave_01", "done"), task(2, "wave_01", "done"), task(3, "wave_02", "queued")];
  const lane = laneOf(waves, tasks);
  assert.equal(lane.waves[0].state, "done", "two done cards and no gate is a closed wave");
  const plan = planWaveAdvance({ lane, rows: rowsOf(tasks), settle: settleOf(2), now: 1_700_000_000_000 });
  assert.equal(plan.action, "surfaced", "auto is off on wave_01, so the next wave is surfaced and nothing starts");
  assert.match(plan.stamp.why, /W1 done, W2 ready - press to open/);
  assert.equal(plan.start, null);
  assert.equal(plan.stamp.job, settleKey(settleOf(2)), "the stamp is keyed by the settle it answered");
});

test("a named abandonment closes a member; a bare one does not", () => {
  const waves = storeOf("abandon", [gapeless("wave_01", 1), gapeless("wave_02", 2)]);
  const named = laneOf(waves, [
    task(1, "wave_01", "done"),
    task(2, "wave_01", "queued", { abandoned: { reason: "the upstream feed was retired", by: "roper" } }),
  ]);
  assert.equal(named.waves[0].state, "done");
  const bare = laneOf(waves, [task(1, "wave_01", "done"), task(2, "wave_01", "queued", { abandoned: true })]);
  assert.equal(bare.waves[0].state, "ready", "a bare abandonment is a status word, not a decision");
});

test("an open wave starts its next queued card whatever the auto switch says, and nothing when a member runs", () => {
  const waves = storeOf("progress", [gapeless("wave_01", 1, false), gapeless("wave_02", 2)]);
  const opened = [task(1, "wave_01", "done"), task(2, "wave_01", "queued")];
  const plan = planWaveAdvance({ lane: laneOf(waves, opened), rows: rowsOf(opened), settle: settleOf(1), now: 1_700_000_000_000 });
  assert.equal(plan.action, "start");
  assert.equal(plan.start.task.id, 2, "the next queued card is the wave progressing");
  assert.match(plan.stamp.why, /whatever the auto switch says/);

  // A member still running is a wave that must not start beside it.
  const running = planWaveAdvance({
    lane: laneOf(waves, [task(1, "wave_01", "done"), task(2, "wave_01", "running"), task(3, "wave_01", "queued")]),
    rows: rowsOf([task(1, "wave_01", "done"), task(3, "wave_01", "queued")]),
    settle: settleOf(1),
  });
  assert.equal(running.start, null);
  assert.equal(running.notes[0].code, "wave-running");

  // A wave nobody opened holds every card queued: a person opens it, the driver does not.
  const unopened = planWaveAdvance({ lane: laneOf(waves, [task(1, "wave_01", "queued"), task(2, "wave_01", "queued")]), rows: rowsOf([task(1, "wave_01", "queued"), task(2, "wave_01", "queued")]), settle: settleOf(1) });
  assert.equal(unopened.start, null);
  assert.equal(unopened.notes[0].code, "unopened");
});

test("auto on opens the next wave and starts its first queued card; auto off surfaces it and starts nothing", () => {
  const on = storeOf("auto-on", [gapeless("wave_01", 1, true), gapeless("wave_02", 2)]);
  const tasks = [task(1, "wave_01", "done"), task(2, "wave_01", "done"), task(3, "wave_02", "queued"), task(4, "wave_02", "queued")];
  const opened = planWaveAdvance({ lane: laneOf(on, tasks), rows: rowsOf(tasks), settle: settleOf(2), now: 1_700_000_000_000 });
  assert.equal(opened.action, "opened");
  assert.equal(opened.start.task.id, 3, "the next wave's FIRST queued card starts, not its second");
  assert.match(opened.stamp.why, /closes on its membership/);

  const off = storeOf("auto-off", [gapeless("wave_01", 1, false), gapeless("wave_02", 2)]);
  const waiting = planWaveAdvance({ lane: laneOf(off, tasks), rows: rowsOf(tasks), settle: settleOf(2), now: 1_700_000_000_000 });
  assert.equal(waiting.action, "surfaced");
  assert.equal(waiting.start, null, "auto off starts nothing, and the same state is computed either way");
  assert.equal(waiting.stamp.why, "W1 done, W2 ready - press to open");
});

test("a next wave with no cards is said plainly, and is never invented", () => {
  const waves = storeOf("empty-next", [gapeless("wave_01", 1, true), gapeless("wave_02", 2)]);
  const tasks = [task(1, "wave_01", "done")];
  const plan = planWaveAdvance({ lane: laneOf(waves, tasks), rows: rowsOf(tasks), settle: settleOf(1), now: 1_700_000_000_000 });
  assert.equal(plan.action, "empty");
  assert.equal(plan.stamp.why, "W1 done, W2 has no members - file its tasks");
  assert.equal(plan.start, null);
});

test("a replayed settle starts nothing twice, and the stamp on the card is the test", () => {
  const waves = storeOf("replay", [gapeless("wave_01", 1), gapeless("wave_02", 2)]);
  const prior = { at: "2026-11-23T00:00:00.000Z", by: "panel", wave: "wave_01", job: settleKey(settleOf(1)), action: "start", task: 2, why: "already answered" };
  const tasks = [task(1, "wave_01", "done", { waveAdvance: prior }), task(2, "wave_01", "queued")];
  const plan = planWaveAdvance({ lane: laneOf(waves, tasks), rows: rowsOf(tasks), settle: settleOf(1), now: 1_700_000_000_000 });
  assert.equal(plan.stamp, null, "nothing is written again");
  assert.equal(plan.start, null, "and nothing is started again");
  assert.equal(plan.notes[0].code, "replay");
  // A DIFFERENT run on the same card is not a replay: a row handed a new attempt may be advanced by that run.
  const handed = [task(1, "wave_01", "done", { runId: "run-9", thread: "thread-9", waveAdvance: prior }), task(2, "wave_01", "queued")];
  const later = planWaveAdvance({ lane: laneOf(waves, handed), rows: rowsOf(handed), settle: settleOf(9), now: 1_700_000_000_000 });
  assert.equal(later.action, "start", "a new settle is a new advance");
});

test("a held tree, a failed attempt, a pipeline card and no tree are refused with their own sentence", () => {
  const waves = storeOf("refusals", [gapeless("wave_01", 1), gapeless("wave_02", 2)]);
  const base = [task(1, "wave_01", "done"), task(2, "wave_01", "queued")];
  const held = planWaveAdvance({
    lane: laneOf(waves, base),
    rows: rowsOf(base),
    settle: settleOf(1),
    now: 1_700_000_000_000,
    liveFor: (tree) => (String(tree).endsWith("t2") ? { id: "job-9", thread: "held-thread", status: "running" } : null),
  });
  assert.equal(held.action, "refused");
  assert.equal(held.start, null);
  assert.match(held.stamp.why, /is held by held-thread/);

  const failedCard = [task(1, "wave_01", "done"), task(2, "wave_01", "queued", { attempts: 2 })];
  const retry = planWaveAdvance({ lane: laneOf(waves, failedCard), rows: rowsOf(failedCard), settle: settleOf(1), now: 1_700_000_000_000 });
  assert.equal(retry.action, "refused");
  assert.match(retry.stamp.why, /a failed card is a person's retry/);

  const piped = [task(1, "wave_01", "done"), task(2, "wave_01", "queued", { pipelineRun: { pipeline: "poc", stage: "build" } })];
  const pipeline = planWaveAdvance({ lane: laneOf(waves, piped), rows: rowsOf(piped), settle: settleOf(1), now: 1_700_000_000_000 });
  assert.equal(pipeline.action, "refused");
  assert.match(pipeline.stamp.why, /the pipeline driver starts it/);

  const treeless = [task(1, "wave_01", "done"), task(2, "wave_01", "queued", { worktree: null })];
  const nowhere = planWaveAdvance({ lane: laneOf(waves, treeless), rows: rowsOf(treeless), settle: settleOf(1), now: 1_700_000_000_000 });
  assert.equal(nowhere.action, "refused");
  assert.match(nowhere.stamp.why, /names no tree/);

  // A failed settle starts nothing, whatever the wave's state: the row it left is a person's decision.
  const failedRun = planWaveAdvance({ lane: laneOf(waves, base), rows: rowsOf([task(1, "wave_01", "queued", { attempts: 1 }), task(2, "wave_01", "queued")]), settle: settleOf(1, { status: "failed" }), now: 1_700_000_000_000 });
  assert.equal(failedRun.action, "refused");
  assert.equal(failedRun.start, null);
  assert.match(failedRun.stamp.why, /nothing is started from a failed settle/);
});

test("the card a settle names is its run id first, its current thread second, never an older thread", () => {
  const rows = rowsOf([task(1, "wave_01", "running", { runId: "run-7", thread: "t-old", threads: ["t-old", "t-new"] }), task(2, "wave_01", "queued")]);
  assert.equal(settleCard(rows, { runId: "run-7" }).task.id, 1);
  assert.equal(settleCard(rows, { thread: "t-new" }).task.id, 1, "the current thread is the row's own");
  assert.equal(settleCard(rows, { thread: "t-old" }), null, "an older attempt that settled late does not drive the row that moved on");
});

// ---- the composer: one write on the card, one start, and a replay that does neither ---------------------------------
function stubAssistant({ file, tasks }) {
  const rec = { id: "assistant-1", name: "Assistant #1" };
  const state = { tasks, spawned: [], swum: 0, journal: [] };
  writeQueueFile(file, tasks, 10);
  const assistant = {
    assistants: [rec],
    jobs: { list: () => [] },
    assistantRecord: () => rec,
    queuePathOf: () => file,
    queueView: () => ({ tasks: readQueueFile(file).tasks }),
    writeQueue: (target, list, nextId) => writeQueueFile(target, list, nextId),
    sweepQueues: async () => {
      state.swum += 1;
    },
    journalAdd: (_kind, _thread, text) => state.journal.push(text),
    startSpawn: async (spec) => {
      state.spawned.push(spec);
      return { id: `job-${state.spawned.length}`, thread: `spawned-${state.spawned.length}`, runId: `spawned-run-${state.spawned.length}` };
    },
  };
  return { assistant, state };
}

test("the composer writes its decision on the settled card and starts the next member once", async () => {
  const file = path.join(dir, "queue-composer.json");
  const tasks = [task(1, "wave_01", "done", { runId: "run-1", thread: "thread-1" }), task(2, "wave_01", "queued"), task(3, "wave_02", "queued")];
  const { assistant, state } = stubAssistant({ file, tasks });
  const waves = storeOf("composer", [gapeless("wave_01", 1, false), gapeless("wave_02", 2)]);
  const driver = createWaveDriver({ waves, assistant, rowFor: () => null, now: () => 1_700_000_000_000 });
  const out = await driver.advanceSettle(settleOf(1));
  assert.equal(out.action, "start");
  assert.equal(state.swum, 1, "the queue is swept before the decision, so the row it reads is the settled one");
  assert.equal(state.spawned.length, 1);
  assert.equal(state.spawned[0].taskId, 2);
  assert.equal(state.spawned[0].target, "/work/proj/.worktrees/t2");
  assert.equal(state.spawned[0].existing, true);
  assert.match(state.spawned[0].prompt, /Queue task #2: task 2/);
  assert.match(state.spawned[0].prompt, /Wave 1: "wave 1" \(wave_01\)/);
  const written = readQueueFile(file).tasks.find((t) => t.id === 1);
  assert.equal(written.waveAdvance.action, "start");
  assert.equal(written.waveAdvance.task, 2);
  assert.equal(written.waveAdvance.job, settleKey(settleOf(1)));
  assert.equal(written.state, "done", "the settled card is not rewritten as running");

  // THE REPLAY: the same settle again starts nothing and writes nothing new.
  const again = await driver.advanceSettle(settleOf(1));
  assert.equal(again.notes[0].code, "replay");
  assert.equal(state.spawned.length, 1, "one start, not two");
  assert.deepEqual(readQueueFile(file).tasks.find((t) => t.id === 1).waveAdvance, written.waveAdvance);
});

test("the prompt is the card plus the wave it is in, and says who closes it", () => {
  const wave = { id: "wave_01", position: 1, title: "the read path", initiativeId: "init_a" };
  const said = memberPrompt({ wave, initiativeId: "init_a", task: task(2, "wave_01", "queued", { detail: "Do the thing.", files: ["lib/a.js"] }) });
  assert.match(said, /Queue task #2: task 2/);
  assert.match(said, /Wave 1: "the read path" \(wave_01\) in initiative init_a/);
  assert.match(said, /Do the thing\./);
  assert.match(said, /Files this card claims: lib\/a\.js/);
  assert.match(said, /closes this member when its pull request reads MERGED/);
});

test("a task row keeps its wave stamp across a read and a write", () => {
  const stamp = { at: "2026-11-23T00:00:00.000Z", by: "panel", wave: "wave_01", job: "run-1", action: "start", task: 2, why: "started by the settle" };
  const picked = pickTask({ id: 1, title: "one", state: "done", waveId: "wave_01", waveAdvance: stamp });
  assert.deepEqual(picked.waveAdvance, stamp);
  // A hand-written stamp with an unknown action or no clock is not a decision, and reads as none.
  assert.equal(pickTask({ id: 1, title: "one", waveAdvance: { action: "maybe", at: "2026-11-23T00:00:00.000Z" } }).waveAdvance, null);
  assert.equal(pickTask({ id: 1, title: "one", waveAdvance: { action: "start" } }).waveAdvance, null);
});
