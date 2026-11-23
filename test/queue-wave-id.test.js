// `waveId` on a task: the one explicit link between a task and a wave (lib/assistant/queue.js `pickTask`).
//
// WHAT IS PINNED HERE, and why each half has a wrong answer that looks right:
//
//   * A VALID ID ROUND-TRIPS through the queue file, because the field is the task's and a settle that rebuilt the row
//     must not drop it. `pickTask` carries it like `pipelineRun`: a writer that normalised an id it does not read would
//     silently put the task back in no wave.
//   * AN UNKNOWN ID IS KEPT, NOT DROPPED. A task naming a wave another panel instance holds, or one the reader has
//     not written yet, must reach the window as itself; only a READER of the wave store can say it is unresolved.
//   * ABSENT MEANS NO WAVE. It does not mean the first wave, and an empty string is absent. A default membership is the
//     one thing the design forbids ("no backfill and no default wave").
//   * A SETTLE PRESERVES IT. settleTasks maps rows with a spread, but that is a property to pin, not to assume: a row
//     with no wave id must still have none after it closes, and a row with one keeps it.
//   * THE EDIT DOOR IS HOW A CARD JOINS ONE. A wave record holds no member list, so `editTask({wave})` is the only
//     write that moves a card between waves; the lane on the next read is what proves it folded there and left the
//     wave it came from. An unknown id rides through the door verbatim, and a wave's state is still folded from its
//     members - the store's bytes must not move when membership does.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TASK_WAVE_MAX, editTask, pickTask, readQueueFile, settleTasks, writeQueueFile } from "../lib/assistant/queue.js";
import { Waves, waveLane } from "../lib/waves.js";

const base = (over = {}) => ({ id: 1, title: "prove the lane", state: "queued", ...over });

test("a valid wave id round-trips through pickTask and the queue file", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-wave-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "queue.json");
  const written = writeQueueFile(file, [base({ waveId: "wave_01" })], 2);
  assert.equal(written[0].waveId, "wave_01");
  const read = readQueueFile(file);
  assert.equal(read.error, null);
  assert.equal(read.tasks[0].waveId, "wave_01");
});

test("an unknown wave id is kept as written, never dropped or defaulted", () => {
  assert.equal(pickTask(base({ waveId: "wave_not_in_any_store" })).waveId, "wave_not_in_any_store");
  // Case and punctuation are the id's, not this module's: the wave store's exact match is the only reader of it.
  assert.equal(pickTask(base({ waveId: "Wave_02.of" })).waveId, "Wave_02.of");
});

test("absent, null and empty all mean no wave", () => {
  assert.equal(pickTask(base()).waveId, null);
  assert.equal(pickTask(base({ waveId: null })).waveId, null);
  assert.equal(pickTask(base({ waveId: "" })).waveId, null);
});

test("a longer value is clipped to the field's cap rather than pasted whole", () => {
  const long = "w".repeat(TASK_WAVE_MAX + 25);
  const picked = pickTask(base({ waveId: long }));
  assert.equal(picked.waveId.length, TASK_WAVE_MAX);
});

test("a hand-edited queue file that carries a wave id reads it, and one that does not stays none", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-wave-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "queue.json");
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      nextId: 3,
      tasks: [
        { id: 1, title: "with a wave", state: "queued", waveId: "wave_03" },
        { id: 2, title: "without one", state: "queued" },
      ],
    })}\n`,
    "utf8",
  );
  const read = readQueueFile(file);
  assert.equal(read.tasks.find((x) => x.id === 1).waveId, "wave_03");
  assert.equal(read.tasks.find((x) => x.id === 2).waveId, null);
});

test("a settle preserves the wave id, and a row with none still has none after it closes", () => {
  const jobs = [{ id: "job_1", thread: "t1", status: "done", startedAt: "2026-11-21T00:00:00.000Z" }];
  const tasks = [
    base({ id: 1, state: "running", thread: "t1", runId: "job_1", waveId: "wave_01", worktree: null, attempts: 0 }),
    base({ id: 2, state: "running", thread: "t1", runId: "job_1", worktree: null, attempts: 0 }),
  ].map(pickTask); // as readQueueFile hands them over, so "no wave" is the field's null and not an absent key
  const out = settleTasks(tasks, { jobs, by: "panel" });
  assert.deepEqual(
    out.tasks.map((x) => x.state),
    ["done", "done"],
  );
  assert.equal(out.tasks.find((x) => x.id === 1).waveId, "wave_01");
  assert.equal(out.tasks.find((x) => x.id === 2).waveId, null);
});

test("an abandonment is a NAMED reason carried on the row, and a bare flag normalises to none", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-abandon-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "queue.json");
  // A reason round-trips through the file, because the wave gate reads it on a later request than the one that wrote it.
  const written = writeQueueFile(file, [base({ abandoned: { reason: "the feed was retired", by: "roper", at: "2026-11-21T10:00:00.000Z" } })], 2);
  assert.equal(written[0].abandoned.reason, "the feed was retired");
  assert.equal(written[0].abandoned.by, "roper");
  const read = readQueueFile(file);
  assert.equal(read.error, null);
  assert.equal(read.tasks[0].abandoned.reason, "the feed was retired");
  // A bare flag is a status word: it normalises to none, so no gate can close on it.
  assert.equal(pickTask(base({ abandoned: true })).abandoned, null);
  assert.equal(pickTask(base({ abandoned: { reason: "   " } })).abandoned, null);
  assert.equal(pickTask(base({ abandoned: false })).abandoned, null);
  assert.equal(pickTask(base()).abandoned, null);
  // A string is the reason, not a truthy flag.
  assert.equal(pickTask(base({ abandoned: "superseded by wave 3" })).abandoned.reason, "superseded by wave 3");
});

test("the edit door sets and clears an abandonment; an unnamed value cannot be set", () => {
  const tasks = [base({ id: 7, abandoned: null })];
  const named = editTask(tasks, 7, { abandoned: { reason: "the upstream feed was retired", by: "roper" } });
  assert.equal(named.task.abandoned.reason, "the upstream feed was retired");
  // An unnamed value clears rather than storing a half-abandonment.
  assert.equal(editTask(tasks, 7, { abandoned: true }).task.abandoned, null);
  // Absent leaves the row alone.
  assert.equal(editTask(named.tasks, 7, { reason: "still abandoned, new sentence" }).task.abandoned.reason, "the upstream feed was retired");
  // Cleared with null, and the row still exists with no abandonment.
  assert.equal(editTask(named.tasks, 7, { abandoned: null }).task.abandoned, null);
});

// ---- the edit door: how a card JOINS a wave ---------------------------------------------------------------
// A wave record holds no member list (lib/waves.js rule 1), so this edit is the ONE write that moves a card between
// waves. The lane is what proves the move: the wave it names folds it in, the wave it came from folds it out, and the
// store's own bytes do not move - a wave's state is derived on every read and never written.

const gapeless = (id, position) => ({ id, initiativeId: "init_a", position, title: `wave ${position}`, entryGate: null, exitGate: null, template: null, auto: false });
const storeOf = (file, records) => {
  writeFileSync(file, `${JSON.stringify({ version: 1, byInitiative: { init_a: records } }, null, 2)}\n`, "utf8");
  return new Waves({ file, log: () => {} });
};
const laneOf = (waves, tasks) => waveLane({ waves, initiativeId: "init_a", tasks, rowFor: () => null, evidenceFor: () => null });

test("the edit door moves a card into a wave, and the next read folds it there and out of the one it came from", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-wave-edit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const waves = storeOf(path.join(dir, "waves.json"), [gapeless("wave_01", 1), gapeless("wave_02", 2)]);
  const queueFile = path.join(dir, "queue.json");
  writeQueueFile(queueFile, [pickTask(base({ id: 1, waveId: "wave_01", state: "done" }))], 2);

  const moved = editTask(readQueueFile(queueFile).tasks, 1, { wave: "wave_02" });
  assert.equal(moved.task.waveId, "wave_02", "the patch's `wave` is the row's `waveId`");
  writeQueueFile(queueFile, moved.tasks, 2);

  // THE NEXT READ, off the file, folded by the lane the board draws: one wave lost the card and the other gained it.
  const lane = laneOf(waves, readQueueFile(queueFile).tasks);
  assert.deepEqual(lane.waves[0].members.map((m) => m.id), [], "it left the wave it came from");
  assert.deepEqual(lane.waves[1].members.map((m) => m.id), [1], "and folds into the wave it now names");
});

test("absent leaves a card in its wave, and null or empty takes it out", () => {
  const tasks = [pickTask(base({ id: 3, waveId: "wave_01" }))];
  // An ordinary edit cannot pull a card out of its wave: the field is absent and the row is untouched.
  assert.equal(editTask(tasks, 3, { title: "renamed" }).task.waveId, "wave_01", "a title edit leaves the membership alone");
  // Null and empty are the same answer - the card belongs to no wave, which is where a file written before the field reads.
  for (const cleared of [null, ""]) {
    assert.equal(editTask(tasks, 3, { wave: cleared }).task.waveId, null, `wave ${JSON.stringify(cleared)} clears to none`);
  }
});

test("an unknown wave id is written verbatim and folds into no wave, never into the first", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-wave-unknown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const waves = storeOf(path.join(dir, "waves.json"), [gapeless("wave_01", 1)]);
  const queueFile = path.join(dir, "queue.json");
  writeQueueFile(queueFile, [pickTask(base({ id: 4, waveId: "wave_01" }))], 2);

  const edited = editTask(readQueueFile(queueFile).tasks, 4, { wave: "wave_not_in_any_store" });
  assert.equal(edited.task.waveId, "wave_not_in_any_store", "the id is kept as written, not normalised away");
  writeQueueFile(queueFile, edited.tasks, 2);
  const read = readQueueFile(queueFile);
  assert.equal(read.tasks[0].waveId, "wave_not_in_any_store", "and survives the file, so the window still names it");

  // The lane folds only the waves the store holds: this card is in NO wave's member list, and above all not in the
  // first one. Dropping the id or defaulting it into wave_01 would both read as a membership nobody wrote.
  const lane = laneOf(waves, read.tasks);
  assert.deepEqual(lane.waves[0].members.map((m) => m.id), [], "the unknown id is not defaulted into wave_01");
  assert.equal(lane.waves.some((w) => w.members.some((m) => m.id === 4)), false, "and no wave claims it");
});

test("a wave's state is still folded from its members, and the edit writes no state to the store", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-wave-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wavesFile = path.join(dir, "waves.json");
  const waves = storeOf(wavesFile, [gapeless("wave_01", 1), gapeless("wave_02", 2)]);
  const queueFile = path.join(dir, "queue.json");
  writeQueueFile(queueFile, [pickTask(base({ id: 5, waveId: "wave_01", state: "done" }))], 2);

  // A gate-less wave closes on its membership, so the one done card is what makes wave_01 read done.
  const before = laneOf(waves, readQueueFile(queueFile).tasks);
  assert.equal(before.waves[0].state, "done");
  assert.equal(before.waves[1].state, "empty", "no member is not a default membership");
  const bytesBefore = readFileSync(wavesFile, "utf8");

  const moved = editTask(readQueueFile(queueFile).tasks, 5, { wave: "wave_02" });
  writeQueueFile(queueFile, moved.tasks, 2);

  // The SAME store, folded again: the states follow the members, and the file did not move a byte.
  const after = laneOf(waves, readQueueFile(queueFile).tasks);
  assert.equal(after.waves[0].state, "empty", "the wave it left folds empty from no members");
  assert.equal(after.waves[1].state, "done", "the wave it joined folds done from the member it now holds");
  assert.equal(readFileSync(wavesFile, "utf8"), bytesBefore, "the store is byte-identical: the edit wrote no state");
  const records = JSON.parse(bytesBefore).byInitiative.init_a;
  assert.equal(records.some((r) => "state" in r || "members" in r), false, "a wave record carries neither a state nor a member list");
});
