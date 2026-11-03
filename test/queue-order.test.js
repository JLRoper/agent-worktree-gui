// The reader's order: an `order` per task, and the one write that applies a whole dragged list.
//
// The pane could always DRAW a queue — it grouped by state and then by id — but it could not REMEMBER one: nothing a
// reader dragged survived a repaint, because the order was derived from the file's id sequence and nothing wrote it.
// This file pins the model half of that:
//
//   1. `order` is optional and positive; a row without one sorts by its id, which is the order every queue file
//      written before the drag already drew (`orderOf`);
//   2. `reorderTasks` applies the WHOLE list in one pass — every listed row gets its 1-based position — and is a
//      no-op (changed: false) when the list already matches;
//   3. it refuses a list that is not this queue (an id it does not hold, the same id twice, an empty list), a list
//      that crosses a state bucket, and a queued row dragged above a row it HOLDS for — the blocked rule;
//   4. a hold whose target is done or gone no longer holds, so it blocks nothing;
//   5. `Assistant.queueMutate("reorder")` is the one write: one document, all positions, and a REFUSED reorder leaves
//      queue.json byte-identical (nothing half-applied on disk);
//   6. the digest reads the reader's order too, so the assistant starts work in the sequence the reader arranged.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addTask,
  byQueueOrder,
  orderOf,
  pickTask,
  queueDigest,
  reorderTasks,
  setTaskState,
  writeQueueFile,
} from "../lib/assistant/queue.js";
import { Assistant } from "../lib/assistant.js";

const at = (iso) => new Date(iso);
const since = "2024-05-01T21:36:00.000Z";

// A queue of five rows in the shape the pane draws: one running head, three queued behind it, one done last.
const seed = () => {
  const rows = [
    { id: 1, title: "the run carrying it", state: "running", files: [] },
    { id: 2, title: "first queued", state: "queued", files: [] },
    { id: 3, title: "second queued", state: "queued", files: [] },
    { id: 4, title: "third queued", state: "queued", files: [] },
    { id: 5, title: "finished", state: "done", files: [] },
  ];
  return rows.map((r) => pickTask(r));
};
const ids = (list) => list.map((t) => Number(t.id));
const orderOfId = (list, id) => list.find((t) => Number(t.id) === Number(id))?.order ?? null;

// ---- 1. the field -------------------------------------------------------------------------------------------------

test("order is a positive whole number, and a row without one sorts by its id", () => {
  assert.equal(pickTask({ id: 7, title: "x", order: 3 }).order, 3);
  assert.equal(pickTask({ id: 7, title: "x", order: "3" }).order, 3, "a hand-edited string is read as the number it is");
  assert.equal(pickTask({ id: 7, title: "x", order: 3.9 }).order, 3, "positions are whole");
  assert.equal(pickTask({ id: 7, title: "x", order: 0 }).order, null, "zero is not a position");
  assert.equal(pickTask({ id: 7, title: "x", order: -2 }).order, null);
  assert.equal(pickTask({ id: 7, title: "x", order: "soon" }).order, null);
  assert.equal(pickTask({ id: 7, title: "x" }).order, null, "every file written before the drag carries none");

  assert.equal(orderOf({ id: 7, order: null }), 7, "the fallback is the id — the order the pane always drew");
  assert.equal(orderOf({ id: 7, order: 2 }), 2);
  assert.equal(orderOf({ id: 7, order: 0 }), 7);
  assert.equal(orderOf({ id: 7, order: "x" }), 7);
});

test("the comparator is order first and id as the final tiebreak", () => {
  const sorted = [{ id: 9, order: 2 }, { id: 3, order: 2 }, { id: 5, order: 1 }].sort(byQueueOrder);
  assert.deepEqual(sorted.map((t) => t.id), [5, 3, 9], "two rows with one order never shuffle between reads");
});

// ---- 2. the whole list, one pass ----------------------------------------------------------------------------------

test("reorderTasks writes every listed position, and a second identical call is a no-op", () => {
  const tasks = seed();
  const out = reorderTasks(tasks, [1, 4, 2, 3, 5]);
  assert.equal(out.changed, true);
  assert.deepEqual(ids(out.tasks), [1, 2, 3, 4, 5], "the array itself is not reordered — `order` is what sorts it");
  assert.deepEqual(
    out.tasks.map((t) => [t.id, t.order]),
    [
      [1, 1],
      [2, 3],
      [3, 4],
      [4, 2],
      [5, 5],
    ],
  );
  assert.deepEqual(out.tasks.slice().sort(byQueueOrder).map((t) => t.id), [1, 4, 2, 3, 5], "and the queue reads in the list's order");

  const again = reorderTasks(out.tasks, [1, 4, 2, 3, 5]);
  assert.equal(again.changed, false, "the same list changes nothing");
  assert.deepEqual(again.tasks.map((t) => t.order), out.tasks.map((t) => t.order));

  // A row the caller did not list keeps the order it carried — the list is what the reader arranged, not the file's
  // whole contents (a task added by another writer between the read and the write must not be invented into it).
  const partial = reorderTasks(out.tasks, [1, 4, 2, 3]);
  assert.equal(orderOfId(partial.tasks, 5), 5, "the unlisted done row kept its place");
});

test("a reorder is refused when the list is not this queue", () => {
  const tasks = seed();
  assert.throws(() => reorderTasks(tasks, []), /full ordered id list/);
  assert.throws(() => reorderTasks(tasks, [1, 2, 99]), /no task #99 in this queue/);
  assert.throws(() => reorderTasks(tasks, [1, 2, 2]), /lists a task twice/);
  assert.throws(() => reorderTasks(tasks, [1, "two"]), /names task ids/);
  let code = null;
  try {
    reorderTasks(tasks, []);
  } catch (e) {
    code = e.code;
  }
  assert.equal(code, "queue-order", "the route maps this code to a 400, like every other refusal");
});

test("a reorder may not move a row out of its state bucket", () => {
  const tasks = seed();
  // The bucketed order is running, queued, parked, done. A queued row above the running one describes a pane the page
  // cannot draw, and so does a done row anywhere but last.
  assert.throws(() => reorderTasks(tasks, [2, 1, 3, 4, 5]), /#1 is running — it cannot be listed after #2 \(queued\)/);
  assert.throws(() => reorderTasks(tasks, [1, 2, 3, 5, 4]), /#4 is queued — it cannot be listed after #5 \(done\)/);
});

// ---- 3. the blocked rule ------------------------------------------------------------------------------------------

test("a queued row cannot be dragged above the row it holds for", () => {
  // #3 holds for #2: it is waiting on the first queued row, so it may never be drawn above it.
  const tasks = seed();
  tasks[2] = { ...tasks[2], hold: { kind: "task", value: "2", since } };

  assert.throws(() => reorderTasks(tasks, [1, 3, 2, 4, 5]), /#3 is held by #2 — it cannot go above it/);

  // Directly behind it is exactly where it belongs, and any move that keeps that relation is allowed.
  const ok = reorderTasks(tasks, [1, 2, 4, 3, 5]);
  assert.equal(ok.changed, true);
  assert.deepEqual(ok.tasks.slice().sort(byQueueOrder).map((t) => t.id), [1, 2, 4, 3, 5]);
});

test("a hold whose target is done, gone, or not a task no longer blocks", () => {
  const base = seed();
  // #3 holds for #2, but #2 reads DONE: the thing it waits on has happened, so the relation no longer orders anything.
  // The done row must sit last (bucket rule), which puts #3 above it — allowed only because the hold has ended.
  const doneTarget = base.map((t) => (Number(t.id) === 2 ? { ...t, state: "done" } : t));
  doneTarget[2] = { ...doneTarget[2], hold: { kind: "task", value: "2", since } };
  const moved = reorderTasks(doneTarget, [1, 3, 4, 2, 5]);
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.tasks.slice().sort(byQueueOrder).map((t) => t.id), [1, 3, 4, 2, 5]);

  const goneTarget = base.map((t) => (Number(t.id) === 3 ? { ...t, hold: { kind: "task", value: "42", since } } : t));
  assert.equal(reorderTasks(goneTarget, [1, 3, 2, 4, 5]).changed, true, "a target that is not in the queue blocks nothing");

  const threadHold = base.map((t) => (Number(t.id) === 3 ? { ...t, hold: { kind: "thread", value: "wtgui-x-abc123", since } } : t));
  assert.equal(reorderTasks(threadHold, [1, 3, 2, 4, 5]).changed, true, "a thread hold names no row here, so it orders nothing");

  const parkedHold = base.map((t) => (Number(t.id) === 4 ? { ...t, state: "parked", hold: { kind: "task", value: "2", since } } : t));
  assert.equal(reorderTasks(parkedHold, [1, 3, 2, 4, 5]).changed, true, "a parked row's hold is not a queued drag's rule");
});

test("a park still stamps its hold, and the release path clears it", () => {
  // Nothing about `order` may disturb the hold's own contract: a reorder of a parked queue leaves the hold intact.
  const tasks = seed();
  const parked = setTaskState(tasks, 4, "parked", { hold: { kind: "task", value: "2" }, at: at(since) });
  const out = reorderTasks(parked.tasks, [1, 3, 2, 4, 5]);
  const row = out.tasks.find((t) => Number(t.id) === 4);
  assert.deepEqual(row.hold, { kind: "task", value: "2", since });
});

// ---- 4. one write, and a refusal writes nothing -------------------------------------------------------------------

const assistantOver = async (t, rows) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-queue-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    onLog: () => {},
  });
  const file = assistant.queueView("assistant-1").file;
  writeQueueFile(file, rows, 6);
  return { assistant, file, dir };
};

test("the queue action applies the whole list in one write to queue.json", async (t) => {
  const { assistant, file } = await assistantOver(t, seed());
  const before = await readFile(file, "utf8");
  assert.equal(JSON.parse(before).tasks.every((x) => x.order == null), true, "the seed carries no order");

  const out = assistant.queueMutate("assistant-1", "reorder", { ids: [1, 4, 2, 3, 5] }, { by: "reader" });
  assert.equal(out.ok, true);
  assert.equal(out.action, "reorder");
  assert.equal(out.task, null, "a reorder is about the list, not one row");

  const doc = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(
    doc.tasks.map((x) => [x.id, x.order]),
    [
      [1, 1],
      [2, 3],
      [3, 4],
      [4, 2],
      [5, 5],
    ],
    "one document, every position, no second file",
  );
  // The answer the pane caches carries the same order the file does.
  assert.deepEqual(out.queue.tasks.slice().sort(byQueueOrder).map((x) => x.id), [1, 4, 2, 3, 5]);
  assert.match((assistant.journal || []).map((j) => j.text).join("\n"), /reordered 5 rows/);
});

test("a refused reorder leaves queue.json byte-identical", async (t) => {
  const { assistant, file } = await assistantOver(t, seed());
  assistant.queueMutate("assistant-1", "reorder", { ids: [1, 4, 2, 3, 5] }, { by: "reader" });
  const applied = await readFile(file, "utf8");

  // Put #4 (queued) above #2 with a hold that forbids it: the write must not happen at all.
  const doc = JSON.parse(applied);
  doc.tasks.find((x) => x.id === 4).hold = { kind: "task", value: "2", since };
  await writeFile(file, `${JSON.stringify(doc, null, 1)}\n`, "utf8");
  const held = await readFile(file, "utf8");

  assert.throws(
    () => assistant.queueMutate("assistant-1", "reorder", { ids: [1, 4, 2, 3, 5] }, { by: "reader" }),
    /#4 is held by #2/,
  );
  assert.equal(await readFile(file, "utf8"), held, "nothing was half-written: the file is exactly what it was");

  const unknown = () => assistant.queueMutate("assistant-1", "reorder", { ids: [1, 99] }, { by: "reader" });
  assert.throws(unknown, /no task #99/);
  assert.equal(await readFile(file, "utf8"), held, "and a bad id is refused the same way");
});

// ---- 5. the digest reads the reader's order -----------------------------------------------------------------------

test("the digest lists queued work in the reader's order, not the file's id order", () => {
  const tasks = seed().slice(0, 4);
  const out = reorderTasks(tasks, [1, 3, 2, 4]);
  const lines = queueDigest(out.tasks, { isLive: () => false });
  const queued = lines.filter((l) => l.startsWith("- ○ ")).map((l) => Number(/#(\d+)/.exec(l)[1]));
  assert.deepEqual(queued, [3, 2, 4], "the assistant starts work in the order the reader dragged");
  assert.equal(orderOf(out.tasks.find((x) => x.id === 3)), 2);
});
