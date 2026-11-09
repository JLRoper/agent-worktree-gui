// The per-assistant task queue, driven directly: no server, no browser, no git. Everything the module derives — stale,
// conflict, the digest's shape — is computed from arguments a test can hand it, which is the whole reason the callers
// pass `isLive`/`rowFor` in rather than the module reaching for the job store.
//
// What this pins, in the order the brief lists it:
//   1. add: a title is the only requirement; the task starts queued with an id and a creator;
//   2. each state: queued → running stamps startedAt, done stamps doneAt/doneBy, parked keeps its reason, and a
//      transition to the state it is already in reports `changed: false` rather than pretending to work;
//   3. reassign and the Move: the owner changes and the move is recorded on the task as movedFrom, and the record
//      LEAVES the source queue file for the target's under an id of its own (`adoptTask`) — a task handed to Assistant
//      #2 that still sits in Assistant #1's file is the defect this pins;
//   4. stale: a running task whose thread has no live run reads stale, with the sentence that says why;
//   5. conflict: a queued task whose files intersect a running task's files is skipped, and the reason names the blocker;
//   6. panel-completed: a settled thread whose PR reads MERGED is marked done by "panel"; a failed settle goes back to
//      queued with attempts+1 and the reason;
//   7. the digest: the top N queued, every running task with its thread, every stale one, and nothing at all when the
//      queue is empty — and every line carrying the same five facts (state, thread, worktree, PR state, why it is not
//      going), with a live thread saying LIVE rather than leaving it to the absence of STALE;
//   8. the route's designed mechanism for a CROSS-ASSISTANT write: a body with no action is a 400 that writes nothing,
//      and a row filed with `by: "assistant-4"` into another assistant's queue lands queued, naming the filer in
//      `createdBy` and owning nobody — and neither a re-read nor a later edit hands it to the queue's own assistant.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { createQueueRoutes } from "../routes/assistant-queue.js";
import {
  addTask,
  adoptTask,
  currentThread,
  deleteTask,
  decorateTasks,
  editTask,
  intersectingFiles,
  linkTaskRun,
  pickTask,
  queueCounts,
  queueDigest,
  readQueueFile,
  reassignTask,
  setTaskState,
  settleTasks,
  writeQueueFile,
} from "../lib/assistant/queue.js";

const at = (iso) => new Date(iso);
const TREE = "C:/ProjectDevelopment/Menu/.worktrees/put-the-project-name-5efc0d";

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

// ---- project: a NAME on the card, optional and derived when absent --------------------------------------
test("a task's project is optional and is kept as the directory NAME, never the path", () => {
  const { task } = addTask([], { title: "name the project", project: "C:/ProjectDevelopment/Menu" });
  assert.equal(task.project, "Menu", "a path posted by a script is reduced to the name the card has room for");
  assert.equal(addTask([], { title: "no project" }).task.project, null, "an absent project means nothing known");
  // The file a row is read from is the same door: an old queue.json with no project reads as null, not as a guess.
  assert.equal(pickTask({ id: 9, title: "old row" }).project, null);
  assert.equal(pickTask({ id: 9, title: "old row", project: "Menu" }).project, "Menu");
  assert.equal(pickTask({ id: 9, title: "old row", project: "  " }).project, null, "whitespace is not a project");
});

test("editTask sets and clears the project, and an edit that says nothing leaves it alone", () => {
  const { tasks } = addTask([], { title: "carry it", project: "Menu" });
  const retitled = editTask(tasks, 1, { title: "carry it still" });
  assert.equal(retitled.task.project, "Menu", "a title edit cannot erase the project the cut wrote");
  const moved = editTask(tasks, 1, { project: "agent-worktree-gui" });
  assert.equal(moved.task.project, "agent-worktree-gui");
  const cleared = editTask(tasks, 1, { project: "" });
  assert.equal(cleared.task.project, null, "an empty project sends the row back to \"nothing known\"");
});

test("linkTaskRun stamps the project the cut knew, and a later link cannot erase it", () => {
  const { tasks } = addTask([], { title: "at the cut" });
  const linked = linkTaskRun(tasks, 1, { thread: "T1", worktree: TREE, project: "C:/ProjectDevelopment/Menu" });
  assert.equal(linked.task.project, "Menu");
  const again = linkTaskRun(linked.tasks, 1, { thread: "T2", worktree: TREE });
  assert.equal(again.task.project, "Menu", "a link with nothing to say keeps the project already on the row");
});

test("the decorated row carries its own project, for a card with no project of its own", () => {
  const { tasks } = addTask([], { title: "in the project checkout", worktree: "C:/ProjectDevelopment/Menu" });
  const [task] = decorateTasks(tasks, {
    rowFor: () => ({ path: "C:/ProjectDevelopment/Menu", project: "Menu", branch: "main", verdict: "ON MAIN" }),
  });
  assert.equal(task.row.project, "Menu", "the row's project is the fallback the card reads");
  const [bare] = decorateTasks(tasks, { rowFor: () => ({ path: "C:/ProjectDevelopment/Menu", branch: "main" }) });
  assert.equal(bare.row.project, null, "a row with no project says nothing rather than guessing");
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

// The round-4 defect: `linkTaskRun` unconditionally wrote `running` and cleared `hold`/`reason`, so a park written
// while the spawn was linking was erased. The row then said a run had started and the gate it was waiting on was
// gone from the record - and a park is the reader's decision, not a state the link may overrule.
test("a link fills facts and leaves a park exactly as it was", () => {
  const { tasks: added } = addTask([], { title: "the gate" }, { at: at("2024-05-01T10:00:00Z"), nextId: 11 });
  const parked = setTaskState(added, 11, "parked", { hold: { kind: "manual", value: "" }, reason: "the gate could not be read", at: at("2024-05-01T10:05:00Z") });
  const linked = linkTaskRun(parked.tasks, 11, { thread: "thread-X", runId: "run_abc123", worktree: "C:/trees/x", project: "menu", at: at("2024-05-01T10:06:00Z") });
  assert.equal(linked.task.state, "parked", "a link is not a state transition");
  assert.deepEqual(linked.task.hold, { kind: "manual", value: "", since: "2024-05-01T10:05:00.000Z" });
  assert.equal(linked.task.reason, "the gate could not be read");
  // ...and the facts it exists to record are all there.
  assert.equal(linked.task.thread, "thread-X");
  assert.equal(linked.task.runId, "run_abc123");
  assert.equal(linked.task.worktree, "C:/trees/x");
  assert.equal(linked.task.project, "menu");
  assert.equal(linked.task.startedAt, "2024-05-01T10:06:00.000Z", "the start is still a fact the link records");

  // The spawn's own path is unchanged: a queued row becomes running, with its start stamped and the hold cleared.
  const { tasks: queued } = addTask([], { title: "go" }, { at: at("2024-05-01T10:00:00Z") });
  const begun = linkTaskRun(queued, 1, { thread: "thread-Y", runId: "run_def456", at: at("2024-05-01T10:01:00Z") });
  assert.equal(begun.task.state, "running");
  assert.equal(begun.task.hold, null);
  assert.equal(begun.task.reason, "");
  assert.equal(begun.task.startedAt, "2024-05-01T10:01:00.000Z");
});

// The round-4 rows read 0 s for a 20 m 21 s job and a 14 m 00 s job, both stamped after the job had already ended:
// the done branch backfilled `startedAt` with the done clock, so a row closed by hand before it ever ran claimed a
// zero-length run. `startedAt` is the RUN's clock, written by a start and by nothing else.
test("done keeps the start it has and never backfills one", () => {
  const { tasks: handCut } = addTask([], { title: "hand cut" }, { at: at("2024-05-01T09:00:00Z") });
  const closed = setTaskState(handCut, 1, "done", { by: "reader", reason: "closed by hand", at: at("2024-05-01T09:20:00Z") });
  assert.equal(closed.task.startedAt, null, "a row that never started finishes with no start, not a zero-length run");
  assert.equal(closed.task.doneAt, "2024-05-01T09:20:00.000Z");
  assert.equal(closed.task.doneBy, "reader");

  const { tasks: ran } = addTask([], { title: "really ran" }, { at: at("2024-05-01T09:00:00Z") });
  const running = setTaskState(ran, 1, "running", { at: at("2024-05-01T09:02:00Z") });
  const finished = setTaskState(running.tasks, 1, "done", { at: at("2024-05-01T09:22:00Z") });
  assert.equal(finished.task.startedAt, "2024-05-01T09:02:00.000Z", "the run's own start survives the done");
  assert.equal(finished.task.doneAt, "2024-05-01T09:22:00.000Z");
  assert.equal(Date.parse(finished.task.doneAt) - Date.parse(finished.task.startedAt), 20 * 60_000, "20 minutes, not 0");

  // A done row with no start is drawn as unknown, never as 0 s: the read paths a card uses do not throw on it.
  const [decorated] = decorateTasks([closed.task], { isLive: () => false });
  assert.equal(decorated.state, "done");
  assert.equal(decorated.startedAt, null);
  assert.doesNotThrow(() => queueDigest([closed.task], { isLive: () => false }));
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

test("adoptTask moves the record into another queue under that queue's own next id, keeping its state", () => {
  const { tasks: added } = addTask([], { title: "hand it over", thread: "T-moved", files: ["lib/a.js"], owner: "assistant-1" }, { by: "reader", at: at("2024-05-01T10:00:00Z") });
  const running = setTaskState(added, 1, "running", { by: "assistant-1", at: at("2024-05-01T10:01:00Z") });
  const handed = reassignTask(running.tasks, 1, "assistant-2", { by: "reader", at: at("2024-05-01T10:10:00Z") });
  // The target already carries two rows, so its next id is 3 — the moved task must not collide with either of them.
  let target = addTask([], { title: "theirs one" }).tasks;
  target = addTask(target, { title: "theirs two" }, { nextId: 2 }).tasks;
  const adopted = adoptTask(target, handed.task, { nextId: 3 });
  assert.equal(adopted.fromId, 1, "the id it had in the queue it left travels back to the caller");
  assert.equal(adopted.task.id, 3, "it enters under the target's next id, not its old one");
  assert.equal(adopted.nextId, 4);
  assert.equal(adopted.task.owner, "assistant-2");
  assert.equal(adopted.task.state, "running", "a running task handed over is still running — the move is not a restart");
  assert.equal(adopted.task.thread, "T-moved");
  assert.deepEqual(adopted.task.files, ["lib/a.js"]);
  assert.deepEqual(adopted.task.movedFrom, [{ from: "assistant-1", to: "assistant-2", by: "reader", at: "2024-05-01T10:10:00.000Z" }]);
  assert.deepEqual(adopted.tasks.map((t) => t.id), [1, 2, 3], "and nothing already in the target moved");
  assert.equal(target.length, 2, "the target array the caller handed in is untouched");
  assert.equal(adoptTask(target, { title: "" }), null, "a record with no title is not a task");
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

// ---- the run a row is on ---------------------------------------------------------------------------------
//
// A row used to carry a thread and nothing else, and a thread is not one run: a re-queued task's thread can hold a
// failed attempt and its live retry at the same time. These three are the brief's own proofs, in its own order.

const THREAD = "wtgui-run-row-89de10";
const liveRun = { id: "job-live0001", runId: "run_live0001", thread: THREAD, status: "running", startedAt: "2026-11-08T10:00:00.000Z" };
const failedRun = { id: "job-fail0001", runId: "run_fail0001", thread: THREAD, status: "failed", startedAt: "2026-11-08T09:00:00.000Z", endedAt: "2026-11-08T09:10:00.000Z" };

test("a row whose thread carries a failed run and a live retry reads running through its run id", () => {
  const { tasks } = addTask([], { title: "the retry", thread: THREAD, worktree: TREE });
  const { tasks: running } = setTaskState(tasks, 1, "running");
  const linked = linkTaskRun(running, 1, { thread: THREAD, runId: liveRun.runId });
  assert.equal(linked.task.runId, liveRun.runId, "the row names the run it was handed");

  // The thread is NOT live by the old test — the store's live record is on it, but `isLive` is handed the slug alone
  // and answers false, which is exactly the case a slug cannot describe. The run id is what makes the row live.
  const [row] = decorateTasks(linked.tasks, { jobs: [failedRun, liveRun], isLive: () => false });
  assert.equal(row.stale, undefined, "the row's own run is running, so the row is running");
  assert.equal(row.runBy, "run");
  assert.equal(row.runStatus, "running");
  assert.equal(row.guessed, undefined, "an answer read from the row's run is not a guess");
});

test("a row whose run id points at a failed run reads stale even though another record shares its thread", () => {
  const { tasks } = addTask([], { title: "the dead attempt", thread: THREAD, worktree: TREE });
  const { tasks: running } = setTaskState(tasks, 1, "running");
  const linked = linkTaskRun(running, 1, { thread: THREAD, runId: failedRun.runId });

  // `isLive` says the thread is live (the retry is on it) — the old rule would call this row running. Its own run
  // failed, so it reads stale, and the sentence names the run rather than the thread.
  const [row] = decorateTasks(linked.tasks, { jobs: [failedRun, liveRun], isLive: () => true });
  assert.equal(row.stale, true, "a failed run on the row is stale work, whatever else shares the thread");
  assert.equal(row.runBy, "run");
  assert.equal(row.runStatus, "failed");
  assert.match(row.staleWhy, /run run_fail0001 ended failed/);
  assert.match(row.staleWhy, new RegExp(THREAD), "the sentence still names the thread the run was on");
});

test("a row with no run id falls back to matching the tree path, and says it is guessing", () => {
  const { tasks } = addTask([], { title: "old row", thread: "T-old", worktree: TREE });
  const { tasks: running } = setTaskState(tasks, 1, "running");
  // The row is the one a queue file written before the field existed reads as: a thread, a tree, no run id.
  assert.equal(running[0].runId, null);
  const otherRun = { id: "job-tree0001", runId: "run_tree0001", thread: "T-somebody-else", status: "running", startedAt: "2026-11-08T10:00:00.000Z", worktreePath: TREE };

  const [live] = decorateTasks(running, { jobs: [otherRun], isLive: () => false });
  assert.equal(live.stale, undefined, "a live run standing in the row's tree is the fallback the old row gets");
  assert.equal(live.runBy, "tree");
  assert.equal(live.guessed, true, "and it is marked as the guess it is");

  const [guessedThread] = decorateTasks(running, { jobs: [], isLive: (t) => t === "T-old" });
  assert.equal(guessedThread.stale, undefined);
  assert.equal(guessedThread.runBy, "thread");
  assert.equal(guessedThread.guessed, true);

  const [nothing] = decorateTasks(running, { jobs: [], isLive: () => false });
  assert.equal(nothing.stale, true);
  assert.equal(nothing.guessed, true);
  assert.match(nothing.staleWhy, /names no run id/);
});

test("a link with no run id keeps the id already on the row, and a resume replaces it", () => {
  const { tasks } = addTask([], { title: "handed on", thread: "T1" });
  const first = linkTaskRun(tasks, 1, { thread: "T1", runId: "run_first" });
  assert.equal(first.task.runId, "run_first");
  const blank = linkTaskRun(first.tasks, 1, { thread: "T1" });
  assert.equal(blank.task.runId, "run_first", "a link with nothing to say cannot erase the run the row is on");
  const resumed = linkTaskRun(first.tasks, 1, { thread: "T1", runId: "run_second" });
  assert.equal(resumed.task.runId, "run_second", "a resume hands the row the run that is actually doing it");
});

test("an edit can write the run id a filed row names, and clearing it puts the row back on its tree", () => {
  // A row FILED after the fact - a reader's add, a script, a stage - was never cut, so `linkTaskRun` never ran for it
  // and it carries no run id however plainly its title names one. Before this door the only way to attach the run was
  // to re-cut the task; the row now names it through `edit`, and every read below is the row's own decorated verdict.
  const tree = "queue-edit-fixture/filed-tree";
  const filed = addTask([], { title: "filed after the fact", thread: "T-filed", worktree: tree });
  const { tasks: running } = setTaskState(filed.tasks, 1, "running");
  const treeRun = { id: "job-tree0002", runId: "run_tree0002", thread: "T-somebody-else", status: "running", worktreePath: tree };
  const namedRun = { id: "job-named0002", runId: "run_named0002", thread: "T-filed", status: "running", startedAt: "2026-11-08T10:00:00.000Z" };

  // The row as it reads before the edit: no run id, so the live run standing in its TREE is the guess it gets.
  const [before] = decorateTasks(running, { jobs: [treeRun, namedRun], isLive: () => false });
  assert.equal(before.runId, null);
  assert.equal(before.runBy, "tree", "with no run id the row can only be read through its tree");
  assert.equal(before.guessed, true);

  // The edit writes the run the row actually names, normalised by the same trim every other read of the id uses…
  assert.equal(editTask(running, 1, { runId: "  run_padded  " }).task.runId, "run_padded", "the id is trimmed like every other read of it");
  const linked = editTask(running, 1, { runId: namedRun.runId });
  assert.equal(linked.task.runId, namedRun.runId);
  assert.equal(linked.task.state, "running", "an edit says WHICH run; starting the row stays setTaskState's decision");
  const [after] = decorateTasks(linked.tasks, { jobs: [treeRun, namedRun], isLive: () => false });
  assert.equal(after.stale, undefined, "the row's own run is running, so the row reads running");
  assert.equal(after.runBy, "run", "…from that run's status, not from the tree guess it replaced");
  assert.equal(after.guessed, undefined, "an answer read from the row's run is evidence, not a guess");

  // A title edit that says nothing about the run leaves it alone, exactly as `project` does…
  const retitled = editTask(linked.tasks, 1, { title: "filed after the fact, renamed" });
  assert.equal(retitled.task.runId, namedRun.runId, "a title edit cannot erase the run the row is on");

  // …and clearing it is how a row goes back to the fallback a file written before the field reads as.
  for (const cleared of [null, ""]) {
    const back = editTask(linked.tasks, 1, { runId: cleared });
    assert.equal(back.task.runId, null, `runId ${JSON.stringify(cleared)} clears back to "no run id"`);
    const [guess] = decorateTasks(back.tasks, { jobs: [treeRun, namedRun], isLive: () => false });
    assert.equal(guess.runBy, "tree", "a cleared run id returns the row to the tree fallback");
    assert.equal(guess.guessed, true, "and the fallback is still marked as the guess it is");
  }
});

test("the settle judges the row's own run, not its thread's newest record", () => {
  const { tasks } = addTask([], { title: "settle me", thread: THREAD });
  const { tasks: running } = setTaskState(tasks, 1, "running");
  const linked = linkTaskRun(running, 1, { thread: THREAD, runId: failedRun.runId });
  // The thread's newest record is the live retry; the row's own run failed. The settle returns it to the queue with
  // the reason, which is the write half of the same rule the stale flag reads.
  const { tasks: settled, changed } = settleTasks(linked.tasks, { jobs: [failedRun, liveRun], isLive: () => true });
  assert.equal(changed.length, 1);
  assert.equal(settled[0].state, "queued");
  assert.equal(settled[0].attempts, 1);
  assert.match(settled[0].reason, /run ended failed/);
});

// ---- a pipeline row reads its ROUND, not the thread it started on ------------------------------------------
//
// Tonight #48, #345, #260 and #264 each read as a dead run while their round was live on a later stage thread. The
// row's `runId` names the run of ONE link - usually the stage that just ended - so a reader that stops there calls the
// row dead and invites a hand to cancel work that is running. These four are the brief's proofs plus the settle's half.

const ROUND_TREE = "round-fixture/tree";
const roundTask = (over = {}) => ({
  id: 48,
  title: "the round",
  state: "running",
  files: [],
  thread: "T-stage-one",
  threads: ["T-stage-one", "T-stage-two"],
  runId: "run_stage_one",
  attempts: 0,
  worktree: ROUND_TREE,
  pipelineRun: {
    pipeline: "gui-improve",
    stage: "review",
    stageRuns: [
      { id: "gui-improve/baseline#1", stage: "baseline", visit: 1, thread: "T-stage-one", job: "job-one", status: "done", settledAt: "2026-11-09T11:00:00.000Z" },
      { id: "gui-improve/review#1", stage: "review", visit: 1, thread: "T-stage-two", job: "job-two", status: null, decision: null },
    ],
  },
  ...over,
});
const roundJobs = (stageStatus = "running") => [
  { id: "job-one", runId: "run_stage_one", thread: "T-stage-one", status: "done", startedAt: "2026-11-09T10:00:00.000Z", endedAt: "2026-11-09T11:00:00.000Z" },
  { id: "job-two", runId: "run_stage_two", thread: "T-stage-two", status: stageStatus, startedAt: "2026-11-09T11:05:00.000Z", ...(stageStatus === "done" ? { endedAt: "2026-11-09T11:47:00.000Z" } : {}) },
];

test("a pipeline row whose original thread ended reads running from its round's live stage thread", () => {
  // The run the row names has ended; the stage the round moved to is going on a later thread. Reading `runId` alone
  // called this row a dead run - the defect the brief names, on #48's shape.
  const [row] = decorateTasks([roundTask()], { jobs: roundJobs("running"), isLive: (t) => t === "T-stage-two" });
  assert.equal(row.stale, undefined, "the round's stage thread is live, so the row is running");
  assert.equal(row.runBy, "round", "the verdict came from the round's ledger, not from the dead link");
  assert.equal(row.runStatus, "running");
  assert.equal(row.runStage, "review");
  assert.equal(row.runThread, "T-stage-two");
  assert.equal(row.runJob, "run_stage_two", "the card can name the run the round is actually on");
  assert.equal(row.guessed, undefined, "a ledger entry that names its job is evidence, not a guess");
});

test("a pipeline row whose round is settled reads settled, naming the stage and never the original link", () => {
  const [row] = decorateTasks([roundTask()], { jobs: roundJobs("done"), isLive: () => false });
  assert.equal(row.stale, true, "nothing the round names is going, so the row is settled work");
  assert.equal(row.runBy, "round");
  assert.equal(row.runStatus, "done");
  assert.match(row.staleWhy, /the round is settled: stage review ended done/);
  assert.doesNotMatch(row.staleWhy, /run run_stage_one ended/, "the sentence is about the round, not the dead link");
});

test("a pipeline row whose round cut no thread falls back to its own thread exactly as before", () => {
  // A record written before the ledger, or a row put on a pipeline that has not started: the round names nothing of
  // its own, so the row's own thread is the answer, and it is still marked as the guess it is.
  const legacy = roundTask({ pipelineRun: { pipeline: "gui-improve", stage: "baseline" }, threads: ["T-stage-one"], runId: null });
  const [guessed] = decorateTasks([legacy], { jobs: [], isLive: (t) => t === "T-stage-one" });
  assert.equal(guessed.runBy, "thread");
  assert.equal(guessed.guessed, true);
  assert.equal(guessed.stale, undefined);
  // …and one of those with a named live run keeps the run's own answer.
  const named = roundTask({ pipelineRun: { pipeline: "gui-improve", stage: "baseline" }, threads: ["T-stage-one"] });
  const [byRun] = decorateTasks([named], { jobs: [{ id: "job-one", runId: "run_stage_one", thread: "T-stage-one", status: "running", startedAt: "2026-11-09T10:00:00.000Z" }], isLive: () => false });
  assert.equal(byRun.runBy, "run");
  assert.equal(byRun.stale, undefined);
});

test("a row with no pipelineRun keeps the answer it always had", () => {
  const plain = { id: 49, title: "no round", state: "running", files: [], thread: "T-plain", threads: ["T-plain"], worktree: ROUND_TREE };
  const live = { id: "job-plain", runId: "run_plain", thread: "T-plain", status: "running", startedAt: "2026-11-09T10:00:00.000Z" };
  const [running] = decorateTasks([{ ...plain, runId: "run_plain" }], { jobs: [live], isLive: () => false });
  assert.equal(running.stale, undefined);
  assert.equal(running.runBy, "run", "a row off a pipeline is still read from the run it names");
  assert.equal(running.runStage, undefined, "no round, no round fields");
  const done = { id: "job-done", runId: "run_done", thread: "T-plain", status: "done", startedAt: "2026-11-09T09:00:00.000Z", endedAt: "2026-11-09T09:30:00.000Z" };
  const [settled] = decorateTasks([{ ...plain, runId: "run_done" }], { jobs: [done], isLive: () => true });
  assert.equal(settled.stale, true);
  assert.equal(settled.runBy, "run");
  assert.match(settled.staleWhy, /run run_done ended done/, "the old sentence is untouched for a row with no round");
});

test("the settle leaves a pipeline row alone while its round is live, even though the named link failed", () => {
  const task = roundTask({ runId: "run_stage_one" });
  const jobs = [
    { id: "job-one", runId: "run_stage_one", thread: "T-stage-one", status: "failed", startedAt: "2026-11-09T10:00:00.000Z", endedAt: "2026-11-09T11:00:00.000Z" },
    roundJobs("running")[1],
  ];
  const { tasks: after, changed } = settleTasks([task], { jobs, isLive: () => true });
  assert.equal(changed.length, 0, "the round is still going, so nothing is settled");
  assert.equal(after[0].state, "running");
  assert.equal(after[0].attempts, 0);
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

test("every digest line carries state, thread, worktree, PR state and its skip reason", () => {
  // The clashing task is filed FIRST so it is inside the top N: a skip reason on a line the digest does not print
  // proves nothing about the lines it does.
  let q = addTask([], { title: "clashing", files: ["a.js"] }).tasks;
  for (let i = 2; i <= 8; i += 1) q = addTask(q, { title: `queued ${i}` }, { nextId: i }).tasks;
  q = addTask(q, { title: "running", thread: "T1", worktree: "C:/wt", files: ["a.js"] }, { nextId: 9 }).tasks;
  q = setTaskState(q, 9, "running").tasks;
  q = addTask(q, { title: "parked", reason: "waiting", worktree: "C:/wt2" }, { nextId: 10 }).tasks;
  q = setTaskState(q, 10, "parked", { reason: "waiting on review" }).tasks;
  const rowFor = (t) => (t.worktree === "C:/wt" ? { path: "C:/wt", verdict: "OPEN", pr: { number: 3, state: "OPEN" } } : null);
  const lines = queueDigest(q, { size: 3, isLive: () => false, rowFor });
  const text = lines.join("\n");
  assert.match(lines[0], /8 queued · 1 running, 1 stale · 1 parked · 0 done/);
  // A queued task: state, thread, worktree and PR are all said, even when there is nothing to say.
  assert.match(text, /- ○ #2 queued · queued 2 · thread \(none\) · tree \(none\) · PR none/);
  // …and the skip reason rides on the line of the task that is being skipped.
  assert.match(text, /- ○ #1 queued · clashing · thread \(none\) · tree \(none\) · PR none · files a\.js · SKIP: files in use by #9 \(stale\)/);
  // A running task: the same facts, plus the PR's number and the verdict on its thread.
  assert.match(text, /- ● #9 running · running · thread T1 · tree C:\/wt · PR OPEN #3 · files a\.js · STALE: that thread has no live run/);
  // A parked task: the same facts, plus why it is parked. The park carries no hold, so it reads `parked (manual)` — the
  // release condition slot says out loud that there is nothing the panel can test (see test/queue-holds.test.js).
  assert.match(text, /- ⏸ #10 parked \(manual\) · parked · thread \(none\) · tree C:\/wt2 · PR none · PARKED: waiting on review/);
  assert.ok(!text.includes("queued 5"), "only the top N queued are listed");
  assert.match(text, /and 5 more queued/);
});

test("a task whose thread is live reads LIVE, never STALE", () => {
  let q = addTask([], { title: "live one", thread: "T1", worktree: "C:/wt" }).tasks;
  q = setTaskState(q, 1, "running").tasks;
  const rowFor = () => ({ path: "C:/wt", verdict: "MERGED", pr: { number: 7, state: "MERGED" } });
  const lines = queueDigest(q, { isLive: (t) => t === "T1", rowFor });
  const text = lines.join("\n");
  assert.match(text, /- ● #1 running · live one · thread T1 · tree C:\/wt · PR MERGED #7 · LIVE$/m);
  assert.ok(!/STALE/.test(text), "a live thread is never called stale");
  assert.match(lines[0], /0 queued · 1 running · 0 parked · 0 done/, "and the header counts no stale task");
});

test("a row whose only PR is CLOSED reads PR none, never a merged claim", () => {
  let q = addTask([], { title: "the dead PR", thread: "T1", worktree: "C:/wt" }).tasks;
  q = setTaskState(q, 1, "running").tasks;
  // The shape the board held for row 268: the scan still remembered the branch as MERGED (its commits were on
  // main), and the PR attached to the branch was CLOSED with mergedAt null. The digest read "PR MERGED (3
  // commits) #607" - a merged claim about a PR that never merged.
  const rowFor = () => ({ path: "C:/wt", verdict: "MERGED (3 commits)", pr: { number: 607, state: "CLOSED" } });
  const text = queueDigest(q, { isLive: (t) => t === "T1", rowFor }).join("\n");
  assert.match(text, / · PR none · /);
  assert.doesNotMatch(text, /#607/, "the dead PR's number is not on the row");
  assert.doesNotMatch(text, /PR MERGED/, "and the row does not claim a merge the PR never made");
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

// ---- a Move writes BOTH files ------------------------------------------------------------------------------
test("the Move action takes the task out of one assistant's file and puts it in the other's", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-queue-move-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    onLog: () => {},
  });
  const second = assistant.createAssistant({ name: "Reviewer" }).created;
  assistant.queueMutate("assistant-1", "add", { title: "stay here", owner: "assistant-1" }, { by: "reader" });
  assistant.queueMutate("assistant-1", "add", { title: "hand this over", owner: "assistant-1", thread: "T-move", files: ["public/x.js"] }, { by: "reader" });

  const moved = assistant.queueMutate("assistant-1", "reassign", { id: 2, owner: second.id }, { by: "reader" });
  assert.equal(moved.ok, true);
  assert.equal(moved.task.id, 1, "the target's first id");
  assert.deepEqual(moved.task.movedFrom.map((m) => [m.from, m.to, m.by]), [["assistant-1", second.id, "reader"]]);
  assert.deepEqual(moved.queue.tasks.map((t) => t.title), ["stay here"], "it left Assistant #1's queue");
  assert.deepEqual(moved.movedTo.tasks.map((t) => t.title), ["hand this over"], "and arrived in Assistant #2's");
  assert.equal(moved.movedTo.assistantId, second.id);

  // …and the FILES agree, not just the answer: a restart reads these two documents and nothing else.
  const oneFile = path.join(dir, "assistants", "assistant-1", "queue.json");
  const twoFile = path.join(dir, "assistants", second.id, "queue.json");
  const one = JSON.parse(readFileSync(oneFile, "utf8"));
  const two = JSON.parse(readFileSync(twoFile, "utf8"));
  assert.deepEqual(one.tasks.map((x) => x.id), [1]);
  assert.deepEqual(two.tasks.map((x) => [x.id, x.title]), [[1, "hand this over"]]);
  assert.equal(two.tasks[0].thread, "T-move", "the thread that carries it travels with the task");
  assert.equal(assistant.queueView("assistant-1").counts.total, 1);
  assert.equal(assistant.queueView(second.id).counts.total, 1, "the target's own read sees it, with no restart");

  // Both journals say what happened: the assistant that lost the work and the one that gained it.
  const lines = assistant.journal.map((j) => j.text).filter((x) => /moved to Reviewer|arrived from/.test(x));
  assert.equal(lines.length, 2, JSON.stringify(assistant.journal.map((j) => j.text)));
  assert.match(lines.join("\n"), /moved to Reviewer as #1/);
  assert.match(lines.join("\n"), /arrived from Assistant #1/);

  // A Move to the assistant that already carries it is refused, and so is one to an assistant that does not exist.
  const same = assistant.queueMutate("assistant-1", "reassign", { id: 1, owner: "assistant-1" }, { by: "reader" });
  assert.equal(same.ok, false);
  assert.match(same.error, /already carries #1/);
  const ghost = assistant.queueMutate("assistant-1", "reassign", { id: 1, owner: "assistant-9" }, { by: "reader" });
  assert.equal(ghost.ok, false);
  assert.match(ghost.error, /no such assistant/);
  assert.deepEqual(assistant.queueView("assistant-1").tasks.map((t) => t.id), [1], "neither refusal moved anything");
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

// ---- threads[]: one record, one agent per thread, `thread` still the legacy first field -------------------
// The queue row draws one sub-row per agent, so a task that has been carried twice has to REMEMBER both runs. The
// compatibility rule is the other half: `thread` stays the first entry and the first field written, so a queue file
// from before this change (and any reader that only knows that field) keeps reading the same thread it always did.

test("a task records its first agent in both `thread` and `threads`, with `thread` written first", () => {
  const { task } = addTask([], { title: "one run", thread: "T1" });
  assert.equal(task.thread, "T1", "the legacy field still names the thread");
  assert.deepEqual(task.threads, ["T1"], "and the list says the same thing");
  const keys = Object.keys(task);
  assert.ok(keys.indexOf("thread") < keys.indexOf("threads"), "`thread` is serialised before `threads`");
  assert.equal(currentThread(task), "T1", "the current agent is the last one");
});

test("an old queue file that knows only `thread` reads as a one-agent record", () => {
  const old = pickTask({ id: 1, title: "from before threads[]", state: "running", thread: "T-old" });
  assert.deepEqual(old.threads, ["T-old"]);
  assert.equal(old.thread, "T-old");
  // …and the other direction: a hand-edited file with a list and no legacy field still yields both.
  const hand = pickTask({ id: 2, title: "list only", threads: ["T-a", "T-b"] });
  assert.equal(hand.thread, "T-a");
  assert.deepEqual(hand.threads, ["T-a", "T-b"]);
});

test("a second run APPENDS its thread: the first agent stays on the record, and duplicates never stack", () => {
  const { tasks } = addTask([], { title: "carried twice", thread: "T1" });
  const second = editTask(tasks, 1, { thread: "T2" });
  assert.deepEqual(second.task.threads, ["T1", "T2"], "both agents are on the record");
  assert.equal(second.task.thread, "T1", "the legacy field keeps the FIRST agent");
  assert.equal(currentThread(second.task), "T2", "the current run is the newest agent");
  const again = editTask(second.tasks, 1, { thread: "T2" });
  assert.deepEqual(again.task.threads, ["T1", "T2"], "re-setting the same thread does not grow the list");
  const blank = editTask(again.tasks, 1, { thread: "  " });
  assert.deepEqual(blank.task.threads, ["T1", "T2"], "an empty edit cannot un-happen a run");
});

// The cap is a cap on HISTORY, never on the run carrying the row. A 24-stage pipeline starts 24 workers on one row,
// and the row keeps the newest twenty: `currentThread` must be the 24th, not the 20th. The defect this pins is the
// 24-stage run's third: the cap refused every thread after the twentieth, so `currentThread` froze on `loop-20` for
// the rest of the row's life and 19 stage runs settled against a job that had already finished.
test("the threads cap keeps the newest run: `currentThread` is the last agent, never the twentieth", () => {
  const many = Array.from({ length: 24 }, (_, i) => `loop-${i + 1}`);
  const task = pickTask({ id: 1, title: "24 stages", state: "running", thread: many[0], threads: many });
  assert.equal(task.threads.length, 20, "the list is still capped");
  assert.equal(task.thread, "loop-1", "the legacy first entry stays first");
  assert.equal(currentThread(task), "loop-24", "the run carrying the row is the LAST one recorded");
  assert.equal(task.threads.at(-1), "loop-24");
  assert.equal(task.threads.includes("loop-2"), false, "the oldest of the later entries is the one the cap drops");
  // A row already at the cap still takes the next run, and keeps naming it.
  const linked = linkTaskRun([task], 1, { thread: "loop-25" });
  assert.equal(currentThread(linked.task), "loop-25");
  assert.equal(linked.task.threads.length, 20);
  assert.equal(linked.task.thread, "loop-1", "the legacy field never moves");
});

test("a task with two agents is live while its CURRENT run is, even with the first one long gone", () => {
  const { tasks } = addTask([], { title: "second try", thread: "T-old" });
  const { tasks: two } = editTask(tasks, 1, { thread: "T-new" });
  const { tasks: running } = setTaskState(two, 1, "running");
  const isLive = (th) => th === "T-new";
  const [task] = decorateTasks(running, { isLive });
  assert.equal(task.stale, undefined, "the live SECOND run is what decides staleness");
  // The same task with only the dead first run recorded IS stale — the rule still bites.
  const [onlyOld] = decorateTasks(setTaskState(tasks, 1, "running").tasks, { isLive });
  assert.equal(onlyOld.stale, true);
  assert.match(onlyOld.staleWhy, /that thread has no live run/);
});

test("the settle follows the current agent, not the first one", () => {
  const { tasks } = addTask([], { title: "settle me", thread: "T-old" });
  const { tasks: two } = editTask(tasks, 1, { thread: "T-new" });
  const { tasks: running } = setTaskState(two, 1, "running");
  const jobs = [
    { thread: "T-old", status: "done", startedAt: "2024-05-01T09:00:00.000Z" },
    { thread: "T-new", status: "failed", startedAt: "2024-05-01T10:00:00.000Z", finalMessage: "tests red" },
  ];
  const settled = settleTasks(running, { jobs, isLive: () => false });
  assert.equal(settled.tasks[0].state, "queued", "the SECOND run's failure is the one that settles the task");
  assert.equal(settled.tasks[0].attempts, 1);
  assert.match(settled.tasks[0].reason, /ended failed/);
  assert.deepEqual(settled.tasks[0].threads, ["T-old", "T-new"], "the history survives the settle");
  // A live current run is left alone whatever the earlier one ended as.
  const kept = settleTasks(running, { jobs, isLive: (th) => th === "T-new" });
  assert.equal(kept.changed.length, 0);
});

test("the digest names the current agent and counts the ones before it", () => {
  const { tasks } = addTask([], { title: "digest me", thread: "T1", worktree: "C:/wt" });
  const { tasks: two } = editTask(tasks, 1, { thread: "T2" });
  const lines = queueDigest(two, { isLive: () => false });
  const line = lines.find((l) => l.includes("digest me"));
  assert.match(line, /thread T2 \(\+1 earlier\)/, line);
  const single = queueDigest(tasks, { isLive: () => false }).find((l) => l.includes("digest me"));
  assert.match(single, /thread T1 ·/, "one agent reads as it always did");
});

test("a Move carries every agent across to the target queue", () => {
  const { tasks } = addTask([], { title: "moved twice", thread: "T1", owner: "assistant-1" });
  const { tasks: two } = editTask(tasks, 1, { thread: "T2" });
  const adopted = adoptTask([], two[0]);
  assert.deepEqual(adopted.task.threads, ["T1", "T2"], "the whole run history travels with the record");
  assert.equal(adopted.task.thread, "T1");
});

// ---- the resume write half: a new run on a thread a row already names --------------------------------

test("a resume writes the new run id on the row it retries, and not on a row that is still live", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-queue-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const board = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => board, firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    onLog: () => {},
  });
  const file = assistant.queuePathOf();
  const seeded = writeQueueFile(
    file,
    [
      pickTask({ id: 1, title: "the dead attempt", thread: "T1", state: "running", runId: "run_fail" }),
      pickTask({ id: 2, title: "somebody else's live row", thread: "T1", state: "running", runId: "run_other" }),
      pickTask({ id: 3, title: "old row, no run id", thread: "T2", state: "running" }),
    ],
    4,
  );
  assert.equal(seeded.length, 3);
  board.push(
    { id: "job-fail", runId: "run_fail", thread: "T1", status: "failed" },
    { id: "job-other", runId: "run_other", thread: "T1", status: "running" },
    { id: "job-new", runId: "run_new", thread: "T1", status: "running" },
  );

  const wrote = assistant.linkResumedRun("T1", { id: "job-new", runId: "run_new" });
  assert.deepEqual(wrote, { assistantId: "assistant-1", id: 1, runId: "run_new" }, "the row whose own run was over takes the retry's id");
  const after = readQueueFile(file).tasks;
  assert.equal(after.find((x) => x.id === 1).runId, "run_new", "the retried row names the run actually doing it");
  assert.equal(after.find((x) => x.id === 2).runId, "run_other", "a row whose own run is still live is not claimed by the resume");
  assert.equal(after.find((x) => x.id === 3).runId, null, "a row on another thread is not touched");

  // A row with no run id on the resumed thread IS the row this write is evidence for.
  board.push({ id: "job-third", runId: "run_third", thread: "T2", status: "running" });
  const second = assistant.linkResumedRun("T2", { id: "job-third", runId: "run_third" });
  assert.equal(second?.id, 3);
  assert.equal(readQueueFile(file).tasks.find((x) => x.id === 3).runId, "run_third");

  // Nothing left to write: the only open row on T1 with no live run already names this one.
  assert.equal(assistant.linkResumedRun("T1", { id: "job-new", runId: "run_new" }), null);
});

// ---- a row filed by ANOTHER assistant: the route's designed mechanism ---------------------------------------
// POST /api/assistant/queue takes the target from `payload.assistantId` and the filer from `payload.by`, and nothing
// verifies the caller. That is the design, not a gap: naming the filer in `by` is how a cross-assistant write says who
// it is, and the row has to keep saying so AFTER the target reads it. What this section pins is the four facts a live
// write proved (a row in another assistant's queue, createdBy naming the filer, owner null) plus the two ways the
// behaviour could rot without anyone noticing: a body with no action being accepted, and a read or a later edit
// quietly handing the row to the assistant whose queue holds it.

// The route's transport, handed in exactly as the server hands it in, so this drives the real handler with no socket:
// `sendJson` records what would have gone on the wire, `readBody` parses the body a test put on the request, and
// `authorised` compares the panel token the way the server's own does.
function queueTransport(assistant) {
  const sent = [];
  const routes = createQueueRoutes({
    assistant,
    config: { token: "queue-token" },
    sendJson: (res, status, payload) => sent.push({ status, payload }),
    readBody: async (req) => JSON.parse(req.bodyText ?? "{}"),
    authorised: (req, token) => req.headers?.["x-panel-token"] === token,
  });
  const call = async ({ method = "GET", body = null, query = "", token = "queue-token" } = {}) => {
    const url = new URL(`http://127.0.0.1/api/assistant/queue${query}`);
    const req = {
      method,
      url: `${url.pathname}${url.search}`,
      headers: token ? { "x-panel-token": token } : {},
      bodyText: body === null ? null : JSON.stringify(body),
    };
    assert.equal(await routes(req, {}, "/api/assistant/queue", url), true, `${method} is the queue route's own`);
    return sent.at(-1);
  };
  return { call, sent };
}

// One Assistant over a temp state directory, with the two collaborators a read needs: the job records it may judge a
// row against, and no board.
async function panelAssistant(t, prefix, { jobs = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => jobs, firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    onLog: () => {},
  });
  return { dir, assistant };
}

test("a row filed by another assistant lands queued in the target's queue, naming the filer and owning nobody", async (t) => {
  const { dir, assistant } = await panelAssistant(t, "wtgui-queue-cross-");
  // Three creations after #1 give #2, #3 and #4, so the filer is a REAL assistant and not a string a test invented.
  for (const name of ["Reviewer", "Builder", "Auditor"]) assistant.createAssistant({ name });
  assert.deepEqual(assistant.assistants.map((a) => a.id), ["assistant-1", "assistant-2", "assistant-3", "assistant-4"]);
  const route = queueTransport(assistant);

  const filed = await route.call({
    method: "POST",
    body: {
      assistantId: "assistant-1",
      action: "add",
      title: "read the other queue's PR",
      detail: "the row Assistant #4 filed",
      files: "lib/assistant/queue.js, public/assistant.js",
      by: "assistant-4",
    },
  });
  assert.equal(filed.status, 200, JSON.stringify(filed.payload));
  const task = filed.payload.task;
  assert.equal(task.id, 1);
  assert.equal(task.state, "queued", "a filed row starts queued: starting it is the target's decision");
  assert.equal(task.createdBy, "assistant-4", "the filer is named by the `by` the body carried");
  assert.equal(task.owner, null, "filing is not assigning, so nobody owns the row");
  assert.deepEqual(task.files, ["lib/assistant/queue.js", "public/assistant.js"], "the comma list is normalised on the way in");

  // It is in the TARGET's file and in no other assistant's, which is what "another assistant's queue" means.
  const file = path.join(dir, "assistants", "assistant-1", "queue.json");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(
    onDisk.tasks.map((x) => [x.id, x.title, x.state, x.createdBy, x.owner]),
    [[1, "read the other queue's PR", "queued", "assistant-4", null]],
  );
  assert.deepEqual(assistant.queueView("assistant-4").tasks, [], "it did not land in the filer's own queue");

  // The target's own read sees it, and the digest counts it: one queued row, drawn under the header that says so.
  const view = assistant.queueView("assistant-1");
  assert.deepEqual(view.tasks.map((x) => [x.id, x.state, x.createdBy, x.owner]), [[1, "queued", "assistant-4", null]]);
  assert.deepEqual([view.counts.queued, view.counts.running, view.counts.parked, view.counts.done, view.counts.total], [1, 0, 0, 0, 1]);
  assert.equal(view.digest[0], "Your task queue (1 queued · 0 running · 0 parked · 0 done):");
  const line = view.digest.find((l) => l.includes("#1 queued"));
  assert.match(line, /read the other queue's PR/);
  assert.match(line, /files lib\/assistant\/queue\.js, public\/assistant\.js/);

  // …and the GET route, which is the read the tab and the preamble both make, answers the same row the same way.
  const read = await route.call({ method: "GET", query: "?assistantId=assistant-1" });
  assert.equal(read.status, 200);
  assert.deepEqual(read.payload.queue.tasks.map((x) => [x.createdBy, x.owner]), [["assistant-4", null]]);
});

test("a body with no action is refused 400, and the refusal writes nothing", async (t) => {
  const { dir, assistant } = await panelAssistant(t, "wtgui-queue-noaction-");
  const route = queueTransport(assistant);
  const file = path.join(dir, "assistants", "assistant-1", "queue.json");
  const bytes = readFileSync(file, "utf8");

  // An absent action and a whitespace one are the same refusal: the route trims before it decides, so "   " is not a
  // caller naming an action no branch knows, it is a caller who named none.
  for (const body of [
    { assistantId: "assistant-1", title: "filed with no action" },
    { assistantId: "assistant-1", action: "   ", title: "blank action" },
  ]) {
    const refused = await route.call({ method: "POST", body });
    assert.equal(refused.status, 400, JSON.stringify(refused.payload));
    assert.match(refused.payload.error, /an action is required/);
  }
  assert.equal(readFileSync(file, "utf8"), bytes, "a refused body leaves the queue file byte-identical");
});

test("a row filed by another assistant is not re-owned by the queue that holds it", async (t) => {
  const { dir, assistant } = await panelAssistant(t, "wtgui-queue-reown-");
  const route = queueTransport(assistant);
  // `assistant-2` is named whether or not this panel created one: nothing verifies the caller, and that is the
  // mechanism this route is built on rather than a check that went missing.
  const filed = await route.call({ method: "POST", body: { assistantId: "assistant-1", action: "add", title: "filed from outside", by: "assistant-2" } });
  assert.equal(filed.status, 200, JSON.stringify(filed.payload));
  const file = path.join(dir, "assistants", "assistant-1", "queue.json");
  const bytes = readFileSync(file, "utf8");

  // Reading is not adopting: the reads leave the file untouched and the row exactly as it was filed.
  for (let i = 0; i < 3; i += 1) assistant.queueView("assistant-1");
  const once = assistant.queueView("assistant-1").tasks[0];
  assert.equal(once.createdBy, "assistant-2");
  assert.equal(once.owner, null, "the queue's own assistant is not the row's owner");
  assert.equal(readFileSync(file, "utf8"), bytes, "a read writes nothing, so it cannot re-own anything");

  // …and a WRITE that follows the read does not adopt it either: the reader's edit changes the words, not the filer,
  // and nothing hands the row to the assistant whose queue it sits in.
  const edited = assistant.queueMutate("assistant-1", "edit", { id: 1, title: "filed from outside, edited" }, { by: "reader" });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const after = assistant.queueView("assistant-1").tasks[0];
  assert.equal(after.title, "filed from outside, edited");
  assert.equal(after.createdBy, "assistant-2", "an edit by the reader does not rewrite who filed it");
  assert.equal(after.owner, null, "and does not give the row to the assistant whose queue holds it");
});

// The row that was filed rather than cut (#338 is the real one): POST `edit` now carries `runId`, so the row can name
// the run doing the work instead of being read through whatever live run happens to stand in its tree. This drives
// the ROUTE, not `editTask`, because the defect these three facts guard is a field dropped between the POST and the
// file - the row's JSON has to hold the id, and the queue's own answer has to be read from it.
test("an edit through the queue route writes the run id, and the row then reads the run it names", async (t) => {
  const tree = "queue-edit-runid/filed-tree";
  const thread = "T-edited-run";
  const run = { id: "job-edit0001", runId: "run-edit0001", thread, status: "running", startedAt: "2026-11-08T10:00:00.000Z" };
  // A different live record sitting in the same tree: it is what the row guesses at while it has no run id, and it is
  // what the row must stop naming once the edit does.
  const treeRun = { id: "job-tree0009", runId: "run_tree0009", thread: "T-elsewhere", status: "running", worktreePath: tree };
  const { dir, assistant } = await panelAssistant(t, "wtgui-queue-edit-run-", { jobs: [treeRun, run] });
  const route = queueTransport(assistant);
  const file = path.join(dir, "assistants", "assistant-1", "queue.json");

  const filed = await route.call({ method: "POST", body: { assistantId: "assistant-1", action: "add", title: "filed after the fact", thread, worktree: tree } });
  assert.equal(filed.status, 200, JSON.stringify(filed.payload));
  assert.equal(filed.payload.task.runId, null, "a filed row is on no run yet");
  const started = await route.call({ method: "POST", body: { assistantId: "assistant-1", action: "state", id: 1, state: "running" } });
  assert.equal(started.status, 200, JSON.stringify(started.payload));

  // Before the edit: running, but with no run id, so the tree run is the guess.
  const guessed = (await route.call({ method: "GET", query: "?assistantId=assistant-1" })).payload.queue.tasks[0];
  assert.equal(guessed.runBy, "tree", "a running row with no run id still falls back to its tree");
  assert.equal(guessed.guessed, true);

  // The edit writes the run this row actually names, and the FILE carries it - not only the route's answer.
  const edited = await route.call({ method: "POST", body: { assistantId: "assistant-1", action: "edit", id: 1, runId: run.runId } });
  assert.equal(edited.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.task.runId, run.runId);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks[0].runId, run.runId, "the run id reached the queue file");

  const live = (await route.call({ method: "GET", query: "?assistantId=assistant-1" })).payload.queue.tasks[0];
  assert.equal(live.stale, undefined, "the row reads running against the run it names");
  assert.equal(live.runBy, "run");
  assert.equal(live.runStatus, "running");
  assert.equal(live.guessed, undefined, "evidence from that run, not a tree guess");
  assert.equal(live.worktree, tree, "every other field the edit did not name is untouched");

  // Clearing it is the way back: the row returns to the fallback the tree guess is, and the file says so.
  const cleared = await route.call({ method: "POST", body: { assistantId: "assistant-1", action: "edit", id: 1, runId: "" } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.payload));
  assert.equal(cleared.payload.task.runId, null);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks[0].runId, null, "a cleared run id is written as null, not left behind");
  const back = (await route.call({ method: "GET", query: "?assistantId=assistant-1" })).payload.queue.tasks[0];
  assert.equal(back.runBy, "tree", "a cleared run id returns the row to the tree fallback");
  assert.equal(back.guessed, true);
});
