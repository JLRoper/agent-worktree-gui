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
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TASK_WAVE_MAX, editTask, pickTask, readQueueFile, settleTasks, writeQueueFile } from "../lib/assistant/queue.js";

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
