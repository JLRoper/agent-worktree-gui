// The per-assistant task queue, driven directly: no server, no browser, no git. Everything the module derives — stale,
// conflict, the digest's shape — is computed from arguments a test can hand it, which is the whole reason the callers
// pass `isLive`/`rowFor` in rather than the module reaching for the job store.
//
// What this pins, in the order the brief lists it:
//   1. add: a title is the only requirement; the task starts queued with an id and a creator;
//   2. each state: queued → running stamps startedAt, done stamps doneAt/doneBy, parked keeps its reason, and a
//      transition to the state it is already in reports `changed: false` rather than pretending to work;
//   3. reassign: the owner changes and the move is recorded on the task as movedFrom;
//   4. stale: a running task whose thread has no live run reads stale, with the sentence that says why;
//   5. conflict: a queued task whose files intersect a running task's files is skipped, and the reason names the blocker;
//   6. panel-completed: a settled thread whose PR reads MERGED is marked done by "panel"; a failed settle goes back to
//      queued with attempts+1 and the reason;
//   7. the digest: the top N queued, every running task with its thread, every stale one, and nothing at all when the
//      queue is empty.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import {
  addTask,
  deleteTask,
  decorateTasks,
  intersectingFiles,
  pickTask,
  queueCounts,
  queueDigest,
  reassignTask,
  setTaskState,
  settleTasks,
} from "../lib/assistant/queue.js";

const at = (iso) => new Date(iso);

// ---- add -------------------------------------------------------------------------------------------------

test("addTask starts a task queued, with an id and the creator recorded", () => {
  const { task, tasks, nextId } = addTask([], { title: "  land the queue tab  ", detail: "and its tests" }, { by: "reader", at: at("2024-05-01T10:00:00Z") });
  assert.equal(task.id, 1);
  assert.equal(task.title, "land the queue tab");
  assert.equal(task.detail, "and its tests");
  assert.equal(task.state, "queued");
  assert.equal(task.createdBy, "reader");
  assert.equal(task.createdAt, "2024-05-01T10:00:00.000Z");
  assert.equal(task.startedAt, null);
  assert.equal(task.doneAt, null);
  assert.equal(task.doneBy, null);
  assert.equal(task.attempts, 0);
  assert.deepEqual(task.files, []);
  assert.equal(tasks.length, 1);
  assert.equal(nextId, 2);
});

test("addTask defaults the fields a caller did not give, and refuses a task with no title", () => {
  const { task } = addTask([], { title: "x" });
  assert.equal(task.owner, null);
  assert.equal(task.thread, null);
  assert.equal(task.worktree, null);
  assert.equal(task.createdBy, "reader");
  assert.throws(
    () => addTask([], { title: "   " }),
    (err) => err.code === "queue-title" && /needs a title/.test(err.message),
  );
});

test("addTask's files are normalised, de-duplicated and capped", () => {
  const { task } = addTask([], { title: "t", files: ["lib/assistant.js", "./lib/assistant.js", "LIB\\Assistant.JS", "public/assistant.js"] });
  assert.deepEqual(task.files, ["lib/assistant.js", "public/assistant.js"]);
});

// ---- each state ------------------------------------------------------------------------------------------

test("setTaskState stamps the timestamps each state owns", () => {
  const { tasks: added } = addTask([], { title: "carry it" }, { at: at("2024-05-01T10:00:00Z") });
  const running = setTaskState(added, 1, "running", { by: "assistant-1", at: at("2024-05-01T10:05:00Z") });
  assert.equal(running.changed, true);
  assert.equal(running.task.state, "running");
  assert.equal(running.task.startedAt, "2024-05-01T10:05:00.000Z");
  assert.equal(running.task.doneAt, null);

  const done = setTaskState(running.tasks, 1, "done", { by: "reader", reason: "landed", at: at("2024-05-01T11:00:00Z") });
  assert.equal(done.task.state, "done");
  assert.equal(done.task.doneAt, "2024-05-01T11:00:00.000Z");
  assert.equal(done.task.doneBy, "reader");
  assert.equal(done.task.reason, "landed");

  const parked = setTaskState(done.tasks, 1, "parked", { reason: "waiting on the PR review", at: at("2024-05-01T12:00:00Z") });
  assert.equal(parked.task.state, "parked");
  assert.equal(parked.task.doneAt, null);
  assert.equal(parked.task.doneBy, null);
  assert.equal(parked.task.reason, "waiting on the PR review");

  const requeued = setTaskState(parked.tasks, 1, "queued", { at: at("2024-05-01T13:00:00Z") });
  assert.equal(requeued.task.state, "queued");
  assert.equal(requeued.task.startedAt, null, "a re-queued task starts clean");
  assert.equal(requeued.task.doneAt, null);
  assert.equal(requeued.task.doneBy, null);
});

test("setTaskState reports no change for the state it is already in, and refuses an unknown one", () => {
  const { tasks: added } = addTask([], { title: "t" });
  const same = setTaskState(added, 1, "queued");
  assert.equal(same.changed, false, "a press that did nothing must not look like a press that did");
  assert.throws(
    () => setTaskState(added, 1, "nonsense"),
    (err) => err.code === "queue-state" && /unknown task state/.test(err.message),
  );
  assert.equal(setTaskState(added, 99, "running"), null, "an unknown id is null, not a throw");
});

// ---- reassign --------------------------------------------------------------------------------------------

test("reassignTask records the move on the task and refuses a move to nobody", () => {
  const { tasks: added } = addTask([], { title: "hand it over", owner: "assistant-1" }, { by: "reader", at: at("2024-05-01T10:00:00Z") });
  const moved = reassignTask(added, 1, "assistant-2", { by: "reader", at: at("2024-05-01T10:10:00Z") });
  assert.equal(moved.changed, true);
  assert.equal(moved.task.owner, "assistant-2");
  assert.deepEqual(moved.task.movedFrom, [
    { from: "assistant-1", to: "assistant-2", by: "reader", at: "2024-05-01T10:10:00.000Z" },
  ]);
  const same = reassignTask(moved.tasks, 1, "assistant-2");
  assert.equal(same.changed, false, "reassigning to the current owner changes nothing");
  assert.throws(
    () => reassignTask(moved.tasks, 1, "  "),
    (err) => err.code === "queue-owner" && /needs an owner/.test(err.message),
  );
});

// ---- delete ----------------------------------------------------------------------------------------------

test("deleteTask removes the row and leaves its neighbours alone", () => {
  const a = addTask([], { title: "one" });
  const b = addTask(a.tasks, { title: "two" }, { nextId: a.nextId });
  const c = addTask(b.tasks, { title: "three" }, { nextId: b.nextId });
  const out = deleteTask(c.tasks, 2);
  assert.equal(out.task.title, "two");
  assert.deepEqual(out.tasks.map((t) => t.title), ["one", "three"]);
  assert.equal(deleteTask(c.tasks, 99), null);
});

// ---- stale -----------------------------------------------------------------------------------------------

test("a running task whose thread has no live run reads stale, and says why", () => {
  const { tasks: added } = addTask([], { title: "phantom work", thread: "T-live" });
  const { tasks: running } = setTaskState(added, 1, "running");
  const decorated = decorateTasks(running, { isLive: () => false });
  assert.equal(decorated[0].stale, true);
  assert.match(decorated[0].staleWhy, /no live run/);

  const live = decorateTasks(running, { isLive: (t) => t === "T-live" });
  assert.equal(live[0].stale, undefined, "a live thread is not stale");

  const { tasks: noThread } = setTaskState(addTask([], { title: "no thread" }).tasks, 1, "running");
  const d2 = decorateTasks(noThread, { isLive: () => true });
  assert.equal(d2[0].stale, true);
  assert.match(d2[0].staleWhy, /no thread recorded/);
});

test("staleness never touches a queued or done task", () => {
  const { tasks: added } = addTask([], { title: "still queued" });
  const d = decorateTasks(added, { isLive: () => false });
  assert.equal(d[0].stale, undefined);
  const { tasks: done } = setTaskState(added, 1, "done");
  const d2 = decorateTasks(done, { isLive: () => false });
  assert.equal(d2[0].stale, undefined);
});

// ---- conflict --------------------------------------------------------------------------------------------

test("a queued task whose files touch a running task's files is skipped with the blocker named", () => {
  const a = addTask([], { title: "running one", thread: "T1", files: ["lib/assistant.js", "public/style.css"] });
  const b = addTask(a.tasks, { title: "queued one", files: ["lib/assistant.js", "test/x.test.js"] }, { nextId: a.nextId });
  const running = setTaskState(b.tasks, 1, "running", { by: "assistant-1" });
  const decorated = decorateTasks(running.tasks, { isLive: (t) => t === "T1" });
  const queued = decorated.find((t) => t.id === 2);
  assert.equal(queued.conflict.with[0].id, 1);
  assert.deepEqual(queued.conflict.files, ["lib/assistant.js"]);
  assert.match(queued.skipped, /files in use by #1/);
  assert.equal(decorated.find((t) => t.id === 1).conflict, undefined, "a running task is not skipped by itself");
});

test("a queued task with disjoint files is not a conflict, and a directory clash is", () => {
  const a = addTask([], { title: "a", thread: "T1", files: ["lib/assistant.js"] });
  const b = addTask(a.tasks, { title: "b", files: ["public/style.css"] }, { nextId: a.nextId });
  const running = setTaskState(b.tasks, 1, "running");
  const clean = decorateTasks(running.tasks, { isLive: (t) => t === "T1" }).find((t) => t.id === 2);
  assert.equal(clean.conflict, undefined);

  // A directory clashes with a file inside it: "lib" claims everything under it, so a queued task that names the
  // directory cannot start while a running task holds a file in it. The boundary matters — "lib/a.js" and "lib/ab.js"
  // are two files, not a clash (the next test pins that).
  const c = addTask(running.tasks, { title: "c", files: ["lib"] }, { nextId: a.nextId });
  const clash = decorateTasks(c.tasks, { isLive: (t) => t === "T1" }).find((t) => t.id === 3);
  assert.equal(clash.conflict.with[0].id, 1);
  assert.deepEqual(clash.conflict.files, ["lib"]);
});

test("intersectingFiles matches the same file and a parent directory, not a substring", () => {
  assert.deepEqual(intersectingFiles(["lib/a.js"], ["lib/a.js"]), ["lib/a.js"]);
  assert.deepEqual(intersectingFiles(["lib/a.js"], ["lib"]), ["lib/a.js"]);
  assert.deepEqual(intersectingFiles(["lib"], ["lib/a.js"]), ["lib"]);
  assert.deepEqual(intersectingFiles(["lib/a.js"], ["lib/ab.js"]), []);
});

test("a stale running task still blocks a queued one, and the reason says it is stale", () => {
  const a = addTask([], { title: "dead run", thread: "T1", files: ["lib/x.js"] });
  const b = addTask(a.tasks, { title: "next", files: ["lib/x.js"] }, { nextId: a.nextId });
  const running = setTaskState(b.tasks, 1, "running");
  const decorated = decorateTasks(running.tasks, { isLive: () => false });
  const queued = decorated.find((t) => t.id === 2);
  assert.match(queued.skipped, /#1 \(stale\)/);
});

// ---- panel-completed -------------------------------------------------------------------------------------

const jobsFor = (status, thread = "T1", startedAt = "2024-05-01T10:00:00.000Z") => [{ thread, status, startedAt }];

test("a settled thread whose PR reads MERGED is marked done by the panel, and stays in place", () => {
  const { tasks: added } = addTask([], { title: "land it", thread: "T1", worktree: "C:/wt" });
  const { tasks: running } = setTaskState(added, 1, "running", { by: "assistant-1" });
  const rowFor = () => ({ path: "C:/wt", branch: "wtgui/x", verdict: "MERGED", pr: { number: 12, state: "MERGED" } });
  const out = settleTasks(running, { jobs: jobsFor("done"), rowFor, isLive: () => false, by: "panel" });
  assert.equal(out.changed.length, 1);
  assert.equal(out.tasks[0].state, "done");
  assert.equal(out.tasks[0].doneBy, "panel");
  assert.ok(out.tasks[0].doneAt, "doneAt is stamped");
  assert.equal(out.tasks.length, 1, "the row stays in place — it is the record, not a ghost");
});

test("a failed settle goes back to queued with attempts+1 and the reason", () => {
  const { tasks: added } = addTask([], { title: "broke", thread: "T1" });
  const { tasks: running } = setTaskState(added, 1, "running");
  const out = settleTasks(running, { jobs: jobsFor("failed"), isLive: () => false, by: "panel" });
  assert.equal(out.tasks[0].state, "queued");
  assert.equal(out.tasks[0].attempts, 1);
  assert.match(out.tasks[0].reason, /failed/);
  assert.equal(out.tasks[0].startedAt, null, "a re-queued task starts clean");
});

test("a done thread whose PR is not MERGED stays running and stale — the panel does not guess", () => {
  const { tasks: added } = addTask([], { title: "not landed", thread: "T1", worktree: "C:/wt" });
  const { tasks: running } = setTaskState(added, 1, "running");
  const rowFor = () => ({ path: "C:/wt", verdict: "OPEN", pr: { number: 12, state: "OPEN" } });
  const out = settleTasks(running, { jobs: jobsFor("done"), rowFor, isLive: () => false });
  assert.equal(out.changed.length, 0);
  assert.equal(out.tasks[0].state, "running");
  const d = decorateTasks(out.tasks, { isLive: () => false, rowFor });
  assert.equal(d[0].stale, true, "the phantom is shown, not hidden");
});

test("settleTasks leaves a live thread, a thread-less task and a parked task alone", () => {
  const a = addTask([], { title: "live", thread: "T1" });
  const { tasks: running } = setTaskState(a.tasks, 1, "running");
  assert.equal(settleTasks(running, { jobs: jobsFor("failed"), isLive: (t) => t === "T1" }).changed.length, 0);

  const b = setTaskState(addTask([], { title: "no thread" }).tasks, 1, "running");
  assert.equal(settleTasks(b.tasks, { jobs: jobsFor("failed"), isLive: () => false }).changed.length, 0);

  const c = setTaskState(addTask([], { title: "parked", thread: "T1" }).tasks, 1, "parked");
  assert.equal(settleTasks(c.tasks, { jobs: jobsFor("failed"), isLive: () => false }).changed.length, 0);
});

// ---- counts and the digest -------------------------------------------------------------------------------

test("queueCounts counts each state and both derived flags", () => {
  let q = addTask([], { title: "q1" }).tasks;
  q = addTask(q, { title: "r1", thread: "T1", files: ["a.js"] }, { nextId: 2 }).tasks;
  q = setTaskState(q, 2, "running").tasks;
  q = addTask(q, { title: "p1" }, { nextId: 3 }).tasks;
  q = setTaskState(q, 3, "parked", { reason: "blocked" }).tasks;
  q = addTask(q, { title: "d1" }, { nextId: 4 }).tasks;
  q = setTaskState(q, 4, "done", { by: "reader" }).tasks;
  q = addTask(q, { title: "c1", files: ["a.js"] }, { nextId: 5 }).tasks;
  const d = decorateTasks(q, { isLive: () => false });
  const c = queueCounts(d);
  assert.equal(c.total, 5);
  assert.equal(c.queued, 2);
  assert.equal(c.running, 1);
  assert.equal(c.parked, 1);
  assert.equal(c.done, 1);
  assert.equal(c.stale, 1, "the running task's thread is not live");
  assert.equal(c.conflict, 1, "c1's file clashes with the running task's");
});

test("the digest carries the top N queued, every running task with its thread, every stale one and every parked one", () => {
  let q = [];
  for (let i = 1; i <= 7; i += 1) q = addTask(q, { title: `queued ${i}` }, { nextId: i }).tasks;
  q = addTask(q, { title: "running", thread: "T1", worktree: "C:/wt" }, { nextId: 8 }).tasks;
  q = setTaskState(q, 8, "running").tasks;
  q = addTask(q, { title: "parked", reason: "waiting" }, { nextId: 9 }).tasks;
  q = setTaskState(q, 9, "parked", { reason: "waiting on review" }).tasks;
  const rowFor = () => ({ path: "C:/wt", verdict: "OPEN", pr: { number: 3, state: "OPEN" } });
  const lines = queueDigest(q, { size: 3, isLive: () => false, rowFor });
  const text = lines.join("\n");
  assert.match(lines[0], /7 queued · 1 running, 1 stale · 1 parked · 0 done/);
  assert.match(text, /- ○ #1 queued 1/);
  assert.match(text, /- ○ #3 queued 3/);
  assert.ok(!text.includes("queued 4"), "only the top N queued are listed");
  assert.match(text, /and 4 more queued/);
  assert.match(text, /- ● #8 running · thread T1 · PR OPEN/);
  assert.match(text, /STALE: that thread has no live run/);
  assert.match(text, /- ⏸ #9 parked · waiting on review/);
});

test("the digest is empty for an empty queue, and clamps a silly size", () => {
  assert.deepEqual(queueDigest([]), []);
  let q = [];
  for (let i = 1; i <= 25; i += 1) q = addTask(q, { title: `t${i}` }, { nextId: i }).tasks;
  const lines = queueDigest(q, { size: 999 });
  // 25 queued + the header + the "more" line; the ceiling is 20 queued plus the two summary lines.
  assert.equal(lines.filter((l) => l.startsWith("- ○")).length, 20);
});

test("pickTask drops a row with no id or no title, and falls an unknown state back to queued", () => {
  assert.equal(pickTask({ title: "no id" }), null);
  assert.equal(pickTask({ id: 1 }), null);
  assert.equal(pickTask({ id: 1, title: "x", state: "bogus" }).state, "queued");
});

// ---- the store every assistant has, including one created while the panel is running ----------------------
test("a queue file is seeded for Assistant #1 at boot and for a new assistant at creation", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-queue-seed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    onLog: () => {},
  });

  // Boot seeded #1: the file is on disk before anything has ever been added, and the route reads it as FOUND.
  const first = path.join(dir, "assistants", "assistant-1", "queue.json");
  assert.ok(existsSync(first), "Assistant #1's queue exists at boot");
  assert.deepEqual(JSON.parse(readFileSync(first, "utf8")).tasks, []);
  assert.equal(assistant.queueView("assistant-1").found, true);

  // …and a second assistant gets its own at the moment it is created, not at its first write: `state/assistants/<id>/
  // queue.json`, the same shape and the same path rule, so "every assistant has a store" is true while the panel runs.
  const second = assistant.createAssistant({ name: "Reviewer" }).created;
  const file = path.join(dir, "assistants", second.id, "queue.json");
  assert.ok(existsSync(file), `${second.id}'s queue exists at creation`);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, nextId: 1, tasks: [] });
  const view = assistant.queueView(second.id);
  assert.equal(view.found, true);
  assert.equal(view.assistantId, second.id);
  assert.equal(view.counts.total, 0);
});
