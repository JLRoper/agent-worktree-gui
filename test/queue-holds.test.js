// A park that can be TESTED, and a lane that orders two rows claiming one file.
//
// The defect this pins, in the reader's own words: a parked row was prose written once into a field the digest clips
// to 100 characters and that `settleTasks` never re-examined (it returned early for every state that was not
// `running`). The assistant is stateless between turns, so the digest IS its memory of the queue: a park whose release
// condition cannot be read cannot be tested, and a park that cannot be tested cannot release. Three rows sat parked
// for hours on conditions that had already stopped being true.
//
// So the hold is a field, {kind, value, since}, and the panel acts on it:
//   thread  a live run on that thread (by name, or by the six-hex tag a rename keeps)
//   job     one job id in the job store
//   task    another row in this queue, by id
//   path    a file or directory that still exists
//   manual  nothing testable — and NOTHING HERE MAY RELEASE IT, ever. That is a reader decision, not a missing TTL.
//
// What this file drives, without a server and without git:
//   1. the field round-trips, and a hold that names nothing is refused rather than stored;
//   2. a dead thread releases the row to queued, ONCE, with `hold ended: …` as the reason; a live thread does not;
//   3. a task hold releases when its target reads done; a path hold when the path is gone;
//   4. a manual park survives a thousand sweeps with every job terminal;
//   5. a park whose hold is ALREADY false is refused at write time, naming the part that is false;
//   6. the digest puts the hold FIRST, so a 200-character title and reason cannot clip it, and a park with no hold
//      reads `parked (manual)`;
//   7. the lane: rows sharing a file are ordered by id, the head is named, and a queued row behind a LIVE head reads
//      `waiting on #N (lane <file>)` — and nothing is started by any of it;
//   8. the stale reason: a manual park (or one with no hold at all) whose prose names a row that is already done is
//      NEVER released, but the digest says the reason is stale — and a throwing rule on the sentry's tick cannot
//      stop the sweep putting a released hold back.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import {
  addTask,
  adoptTask,
  decorateTasks,
  deleteTask,
  editTask,
  holdState,
  holdTaskId,
  normHold,
  pickTask,
  queueDigest,
  readQueueFile,
  setTaskState,
  settleTasks,
  staleReason,
  writeQueueFile,
} from "../lib/assistant/queue.js";

const at = (iso) => new Date(iso);
const T1 = "wtgui-the-turnover-branch-abc123";

// One job of one thread, in the shape the job store hands over: `status` plus the stamps the digest quotes.
const job = (thread, status, { id = "df09538b", startedAt = "2024-05-01T09:00:00.000Z", endedAt = null } = {}) => ({
  id,
  thread,
  status,
  startedAt,
  endedAt: endedAt || (status === "running" || status === "starting" || status === "waiting" ? null : "2024-05-01T22:43:01.664Z"),
});
// The one live-ness rule the Assistant hands in: a thread is live while some job on it is live.
const liveIn = (jobs) => (thread) => jobs.some((j) => j.thread === thread && ["running", "starting", "waiting"].includes(j.status));

const park = (tasks, id, hold, extra = {}) =>
  setTaskState(tasks, id, "parked", { reason: "waiting on the thing", hold, at: at("2024-05-01T21:36:00Z"), ...extra });

// ---- 1. the field -----------------------------------------------------------------------------------------

test("a park stores {kind, value, since}: `since` is the park's own clock, not the caller's claim", () => {
  const { tasks } = addTask([], { title: "held" });
  const { task, changed } = park(tasks, 1, { kind: "thread", value: T1, since: "1999-01-01T00:00:00Z" });
  assert.equal(changed, true);
  assert.deepEqual(task.hold, { kind: "thread", value: T1, since: "2024-05-01T21:36:00.000Z" }, "the park stamps since");
  assert.equal(task.state, "parked");
});

test("a hold survives a read and is cleared by every transition out of parked", () => {
  const { tasks } = addTask([], { title: "held" });
  const parked = park(tasks, 1, { kind: "thread", value: T1 }).tasks;
  // Through the FILE shape: pickTask normalises whatever a hand-edited queue.json holds.
  assert.deepEqual(pickTask(parked[0]).hold, { kind: "thread", value: T1, since: "2024-05-01T21:36:00.000Z" });
  for (const next of ["queued", "running", "done"]) {
    const { task } = setTaskState(parked, 1, next, { by: "reader" });
    assert.equal(task.hold, null, `${next} clears the hold it no longer waits on`);
  }
});

test("a hold has to name something: an unknown kind or an empty value is refused, not silently kept", () => {
  assert.equal(normHold({ kind: "moon", value: "x" }), null);
  assert.equal(normHold({ kind: "thread", value: "  " }), null);
  assert.deepEqual(normHold({ kind: "manual" }), { kind: "manual", value: "", since: null }, "manual needs no value");
  assert.equal(normHold(null), null);
  // A pickTask over a hand-edited file DROPS a bad hold — the row is still a row, it just has nothing to wait on.
  assert.equal(pickTask({ id: 1, title: "x", state: "parked", hold: { kind: "moon", value: "x" } }).hold, null);
  // …but an explicit write of one is refused, because a park on nothing is the defect wearing a field.
  const { tasks } = addTask([], { title: "held" });
  assert.throws(() => park(tasks, 1, { kind: "moon", value: "x" }), (e) => e.code === "queue-hold");
  assert.throws(() => editTask(tasks, 1, { hold: { kind: "thread", value: "" } }), (e) => e.code === "queue-hold");
  assert.equal(tasks[0].state, "queued", "and nothing was parked on the way out");
});

test("holdTaskId reads `#60`, `60` and nothing else", () => {
  assert.equal(holdTaskId("#60"), 60);
  assert.equal(holdTaskId(" 60 "), 60);
  assert.equal(holdTaskId("the pipeline row"), null);
});

// ---- 2. the release ---------------------------------------------------------------------------------------

test("a live thread holds the row; the same hold releases it once the run has ended — once", () => {
  const { tasks } = addTask([], { title: "resume the turnover branch" });
  const parked = park(tasks, 1, { kind: "thread", value: T1 }).tasks;

  const liveJobs = [job(T1, "running")];
  const held = settleTasks(parked, { jobs: liveJobs, isLive: liveIn(liveJobs), by: "panel", at: at("2024-05-01T22:00:00Z") });
  assert.equal(held.changed.length, 0, "a live run is exactly what the park is waiting for");
  assert.equal(held.tasks[0].state, "parked");
  assert.deepEqual(held.tasks[0].hold, parked[0].hold, "and the hold is untouched");

  const deadJobs = [job(T1, "done")];
  const released = settleTasks(parked, { jobs: deadJobs, isLive: liveIn(deadJobs), by: "panel", at: at("2024-05-01T23:00:00Z") });
  assert.equal(released.changed.length, 1);
  assert.equal(released.tasks[0].state, "queued", "a hold that stopped being true puts the row back in the queue");
  assert.equal(released.tasks[0].hold, null, "and the hold goes with the park it belonged to");
  assert.equal(
    released.tasks[0].reason,
    `hold ended: thread ${T1} — ended done 22:43`,
    "the reason says which hold ended, and when — the half the old 100-character clip used to eat",
  );
  assert.equal(released.tasks[0].startedAt, null, "a released row starts clean, like any other re-queue");
  assert.deepEqual(
    released.changed.map((c) => [c.id, c.from, c.to]),
    [[1, "parked", "queued"]],
  );

  // A transition, not a loop: the row left `parked`, so the next sweep has nothing to say.
  const again = settleTasks(released.tasks, { jobs: deadJobs, isLive: liveIn(deadJobs), by: "panel" });
  assert.equal(again.changed.length, 0);
});

test("a thread hold follows the tag through a rename, and a live twin keeps the park", () => {
  const { tasks } = addTask([], { title: "held on a thread that may be renamed" });
  // The hold names the OLD slug; the tree was renamed, so the job store spells it differently and keeps only the tag.
  const parked = park(tasks, 1, { kind: "thread", value: "wtgui-old-name-abc123" }).tasks;
  const renamed = [job("wtgui/turnover-branch-abc123", "running")];
  const out = settleTasks(parked, { jobs: renamed, isLive: liveIn(renamed), by: "panel" });
  assert.equal(out.changed.length, 0, "the tag is the identity a rename keeps");
  assert.equal(out.tasks[0].state, "parked");
});

test("a task hold releases when its target reads done, and a missing target cannot hold a row forever", () => {
  let q = addTask([], { title: "the blocker" }).tasks;
  q = addTask(q, { title: "the blocked row" }, { nextId: 2 }).tasks;
  q = park(q, 2, { kind: "task", value: "#1" }).tasks;

  const stillOpen = settleTasks(q, { jobs: [], isLive: () => false, by: "panel" });
  assert.equal(stillOpen.changed.length, 0, "an open target is still a hold");

  const done = settleTasks(setTaskState(q, 1, "done", { by: "reader" }).tasks, { jobs: [], isLive: () => false, by: "panel" });
  assert.equal(done.changed.length, 1);
  assert.equal(done.tasks.find((t) => t.id === 2).state, "queued");
  assert.equal(done.tasks.find((t) => t.id === 2).reason, "hold ended: task #1 — #1 is done");

  // The target DELETED rather than finished: a hold on a row that is not there can never end, so the row comes back
  // with the fact stated instead of sitting parked on a ghost. (The write-time refusal makes this unreachable by a
  // fresh park — you cannot park on #99 — so the row is parked on a real target first and the target is removed after.)
  const orphaned = deleteTask(q, 1).tasks;
  assert.equal(orphaned.find((t) => t.id === 2).state, "parked", "the park outlives the row it was waiting on");
  const gone = settleTasks(orphaned, { jobs: [], isLive: () => false, by: "panel" });
  assert.equal(gone.changed.length, 1);
  assert.match(gone.changed[0].why, /#1 is not in this queue/);
});

test("a path hold holds while the path is there and releases when it is gone", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-queue-hold-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "held.txt");
  await writeFile(file, "here\n", "utf8");

  const { tasks } = addTask([], { title: "waiting on a file" });
  const parked = park(tasks, 1, { kind: "path", value: file }).tasks;
  assert.equal(settleTasks(parked, { jobs: [], isLive: () => false }).changed.length, 0, "the path is there");

  await rm(file, { force: true });
  const out = settleTasks(parked, { jobs: [], isLive: () => false, by: "panel" });
  assert.equal(out.changed.length, 1);
  assert.equal(out.tasks[0].state, "queued");
  assert.match(out.tasks[0].reason, /^hold ended: path .*held\.txt — .* is gone$/);
});

// ---- 3. the manual park -----------------------------------------------------------------------------------

test("a park with no hold is manual and NEVER releases — a thousand sweeps with every job terminal", () => {
  const { tasks } = addTask([], { title: "needs a decision" });
  const parked = setTaskState(tasks, 1, "parked", { reason: "needs a decision plus an offline gradle run" }).tasks;
  assert.equal(parked[0].hold, null, "no hold at all");

  const jobs = [job(T1, "done"), job("wtgui-other-def456", "failed")];
  let q = parked;
  for (let i = 0; i < 1000; i += 1) {
    const out = settleTasks(q, { jobs, isLive: () => false, by: "panel" });
    assert.equal(out.changed.length, 0, `sweep ${i + 1} touched a manual park`);
    q = out.tasks;
  }
  assert.equal(q[0].state, "parked");
  assert.equal(q[0].reason, "needs a decision plus an offline gradle run", "and its reason is the reader's, untouched");

  // `manual` written out loud behaves the same, so a caller can be explicit rather than merely absent.
  const explicit = park(addTask([], { title: "x" }).tasks, 1, { kind: "manual", value: "" }).tasks;
  assert.equal(settleTasks(explicit, { jobs, isLive: () => false }).changed.length, 0);
});

// ---- 4. the write-time refusal ----------------------------------------------------------------------------

test("a park whose hold is already false is refused at write time, naming the part that is false", () => {
  let q = addTask([], { title: "the finished target" }).tasks;
  q = addTask(q, { title: "the row that wants to wait" }, { nextId: 2 }).tasks;
  q = setTaskState(q, 1, "done", { by: "reader" }).tasks;

  assert.throws(
    () => park(q, 2, { kind: "task", value: "#1" }),
    (e) => e.code === "queue-hold" && /cannot park #2 on task #1: #1 is done/.test(e.message),
    "a hold on finished work would release on the next sweep — the park is refused, not written",
  );
  assert.equal(q[1].state, "queued", "and the row is untouched");

  // A thread whose run has ended, judged with the job store in hand (the shape a sweep/route with jobs uses).
  const dead = [job(T1, "done")];
  assert.throws(
    () => setTaskState(q, 2, "parked", { hold: { kind: "thread", value: T1 }, isLive: liveIn(dead), jobs: dead }),
    /cannot park #2 on thread .*abc123: ended done 22:43/,
  );
  // A path that is not there.
  assert.throws(
    () => park(q, 2, { kind: "path", value: path.join(os.tmpdir(), "wtgui-nothing-here-9f8e7d.txt") }),
    /is gone/,
  );
  // …and the same holds DO park when they are true, so the refusal is about the fact, not about the kind.
  const live = [job(T1, "running")];
  const ok = setTaskState(q, 2, "parked", { hold: { kind: "thread", value: T1 }, isLive: liveIn(live), jobs: live });
  assert.equal(ok.task.state, "parked");
  assert.equal(ok.task.hold.kind, "thread");
});

test("a hold can be carried on the row first and claimed by the park — the two-step the route uses", () => {
  // `setTaskState` is handed state and reason by the queue route and by the Assistant's own mutate, and nothing else.
  // A hold therefore travels on the row's own fields (editTask) and the park CLAIMS it: validated, then stamped.
  const { tasks } = addTask([], { title: "two step" });
  const edited = editTask(tasks, 1, { hold: { kind: "thread", value: T1 } });
  assert.equal(edited.task.hold.kind, "thread", "the field is on the row");
  assert.equal(edited.task.hold.since, null, "with no `since` until the park stamps it");
  assert.equal(edited.task.state, "queued", "and it is inert on a row that is not parked");

  const parked = setTaskState(edited.tasks, 1, "parked", { reason: "waiting", at: at("2024-05-01T21:36:00Z") });
  assert.equal(parked.task.hold.since, "2024-05-01T21:36:00.000Z");
  assert.equal(parked.task.state, "parked");
});

test("a Move drops a task hold (ids are per queue) and keeps a thread hold", () => {
  let q = addTask([], { title: "the blocker" }).tasks;
  q = addTask(q, { title: "moved while parked", thread: T1 }, { nextId: 2 }).tasks;
  const onTask = park(q, 2, { kind: "task", value: "#1" }).tasks;
  assert.equal(adoptTask([], onTask[1]).task.hold, null, "#1 means a different row in the target's queue");
  const onThread = park(q, 2, { kind: "thread", value: T1 }).tasks;
  assert.deepEqual(adoptTask([], onThread[1]).task.hold, onThread[1].hold, "a thread name is the same fact everywhere");
});

// ---- 5. what the digest says ------------------------------------------------------------------------------

test("the digest puts the hold FIRST, so a 200-character title and reason cannot clip it", () => {
  const title = `T${"t".repeat(199)}`;
  const reason = `R${"r".repeat(199)} hold on ${T1} until it settles`;
  const { tasks } = addTask([], { title });
  const parked = setTaskState(tasks, 1, "parked", {
    reason,
    hold: { kind: "thread", value: T1 },
    at: at("2024-05-01T21:36:00Z"),
  }).tasks;
  const live = [job(T1, "running")];
  const line = queueDigest(parked, { jobs: live, isLive: liveIn(live) }).at(-1);

  assert.match(line, /^- ⏸ #1 parked on thread abc123 \(live\) · Tt{1,}/, "the hold is the first thing on the line");
  assert.ok(line.indexOf("parked on thread abc123") < line.indexOf("Ttt"), "…ahead of the title");
  assert.match(line, /· PARKED: Rr+/, "and the reason is still last, as it always was");
  const parkedPart = line.slice(line.indexOf("PARKED: ") + 8);
  assert.ok(parkedPart.length <= 100, `the reason is clipped to its 100 characters (got ${parkedPart.length})`);
  // The whole phrase the brief quotes, intact, however long the prose is.
  assert.ok(line.includes("parked on thread abc123 (live)"));
});

test("the digest says `parked (manual)` for a park nothing can test, and `held by #N since HH:MM` for a task hold", () => {
  let q = addTask([], { title: "manual one" }).tasks;
  q = setTaskState(q, 1, "parked", { reason: "needs a decision" }).tasks;
  q = addTask(q, { title: "the blocker" }, { nextId: 2 }).tasks;
  q = addTask(q, { title: "behind it" }, { nextId: 3 }).tasks;
  q = park(q, 3, { kind: "task", value: "2" }).tasks;
  const lines = queueDigest(q, { isLive: () => false });
  assert.ok(lines.some((l) => /^- ⏸ #1 parked \(manual\) · manual one · /.test(l)), lines.find((l) => l.includes("#1")));
  assert.ok(
    lines.some((l) => /^- ⏸ #3 parked held by #2 since 21:36 · behind it · /.test(l)),
    lines.find((l) => l.includes("#3")),
  );
});

test("a hold whose verdict needs the job store reads honestly when the read has none", () => {
  // `queueView` (the tab, the preamble) hands `isLive` and `rowFor` and no job list. The digest must not claim
  // "ended 22:43" it cannot know: it says what it does know, and the sweep is what acts.
  const { tasks } = addTask([], { title: "held" });
  const parked = park(tasks, 1, { kind: "thread", value: T1 }).tasks;
  const line = queueDigest(parked, { isLive: () => false }).at(-1);
  assert.match(line, /parked on thread abc123 \(no live run\)/);
  const judged = holdState(parked[0].hold, { isLive: () => false, jobs: null });
  assert.equal(judged.held, null, "three-valued on purpose: this caller cannot tell");
});

// ---- 6. the lane ------------------------------------------------------------------------------------------

test("rows that share a file are one lane, ordered by id, and the head is named", () => {
  let q = addTask([], { title: "first in the lane", files: ["lib/assistant/queue.js"] }).tasks;
  q = addTask(q, { title: "second in the lane", files: ["lib/assistant/queue.js", "test/x.test.js"] }, { nextId: 2 }).tasks;
  q = addTask(q, { title: "somewhere else", files: ["public/app.js"] }, { nextId: 3 }).tasks;

  const rows = decorateTasks(q, { isLive: () => false });
  const [first, second, other] = rows;
  assert.equal(first.lane, "lib/assistant/queue.js");
  assert.equal(first.laneHead, true, "the lowest id goes first");
  assert.equal(second.lane, "lib/assistant/queue.js", "a shared file names one lane for both");
  assert.equal(second.laneHead, false);
  assert.equal(second.laneHeadId, 1);
  assert.equal(other.lane, null, "a row that shares nothing is in no lane at all");

  const lines = queueDigest(q, { isLive: () => false });
  assert.ok(lines.some((l) => /· lane lib\/assistant\/queue\.js \(head\)$/.test(l)), lines.find((l) => l.includes("#1")));
  assert.ok(lines.some((l) => /· lane lib\/assistant\/queue\.js after #1$/.test(l)), lines.find((l) => l.includes("#2")));
});

test("a queued row behind a LIVE lane head says so — the order, not a second warning", () => {
  // #1 is running and live on the shared file; #2 is queued behind it.
  let q = addTask([], { title: "already in the file", thread: "wtgui-lane-live-111111", files: ["lib/a.js"] }).tasks;
  q = setTaskState(q, 1, "running").tasks;
  q = addTask(q, { title: "wants the same file", files: ["lib/a.js"] }, { nextId: 2 }).tasks;
  const live = [job("wtgui-lane-live-111111", "running")];
  const lines = queueDigest(q, { jobs: live, isLive: liveIn(live) });
  const head = lines.find((l) => /^- ● #1 /.test(l));
  const behind = lines.find((l) => /^- ○ #2 /.test(l));
  assert.match(head, /· lane lib\/a\.js \(head\)$/);
  assert.match(behind, /· waiting on #1 \(lane lib\/a\.js\)$/, behind);
  assert.match(behind, /· SKIP: files in use by #1/, "the conflict sentence is still there, with the order beside it");
});

test("a lane orders rows and starts nothing: no state, no id, no thread is touched", () => {
  let q = addTask([], { title: "one", files: ["lib/a.js"] }).tasks;
  q = addTask(q, { title: "two", files: ["lib/a.js"] }, { nextId: 2 }).tasks;
  const before = q.map((t) => [t.id, t.state, t.thread, t.attempts]);
  queueDigest(q, { isLive: () => false });
  assert.deepEqual(
    q.map((t) => [t.id, t.state, t.thread, t.attempts]),
    before,
    "the digest is a read: the panel renders the order, the assistant decides what to start",
  );
});

// ---- 7. the stale reason -----------------------------------------------------------------------------------
//
// The row that started this: parked on `#38` in prose, no hold at all, and still parked twenty minutes after #38
// landed. Nothing may release it — "needs a decision" is the reader's, and a hold guessed out of a sentence is the
// defect the field replaced — but the digest can say the sentence has stopped being true, so the next turn does not
// wait on a row the board already finished.

test("a manual park whose reason names a DONE row reads stale — and is still never released", () => {
  let q = addTask([], { title: "the blocker" }).tasks;
  q = addTask(q, { title: "parked on it in prose" }, { nextId: 2 }).tasks;
  q = setTaskState(q, 1, "done", { by: "reader" }).tasks;
  q = setTaskState(q, 2, "parked", { reason: "blocked on #1 landing as PR #276" }).tasks;
  assert.equal(q[1].hold, null, "no hold at all — a prose park, like the ten already on disk");

  assert.deepEqual(staleReason(q[1], q), { task: 1, state: "done", why: "#1 is done" });
  const line = queueDigest(q, { isLive: () => false }).find((l) => l.includes("#2")) || "";
  assert.match(line, /^- ⏸ #2 parked \(manual, stale reason: #1 is done\) · parked on it in prose/, line);
  assert.match(line, /· PARKED: blocked on #1 landing as PR #276$/, "and the reader's own sentence is still last");

  // The marker is a READ: a thousand sweeps with every job terminal leave the row exactly where it is.
  let after = q;
  for (let i = 0; i < 1000; i += 1) {
    const out = settleTasks(after, { jobs: [job(T1, "done")], isLive: () => false, by: "panel" });
    assert.equal(out.changed.length, 0, `sweep ${i + 1} touched a park the panel cannot test`);
    after = out.tasks;
  }
  assert.equal(after[1].state, "parked");
  assert.equal(after[1].reason, "blocked on #1 landing as PR #276", "the reason is the reader's, untouched");
  // …and a `manual` hold written out loud is the same park, so it reads the same marker.
  const explicit = setTaskState(q, 2, "parked", { hold: { kind: "manual", value: "" }, reason: "blocked on #1" }).tasks;
  assert.deepEqual(staleReason(explicit[1], explicit), { task: 1, state: "done", why: "#1 is done" });
});

test("the stale marker is only for the FIRST id the sentence names, and only when it is a row in this queue", () => {
  let q = addTask([], { title: "the open blocker" }).tasks;
  q = addTask(q, { title: "behind an open row" }, { nextId: 2 }).tasks;
  q = addTask(q, { title: "behind a done row" }, { nextId: 3 }).tasks;
  q = setTaskState(q, 3, "done", { by: "reader" }).tasks;

  // An open target is not a stale reason, however the sentence is worded.
  assert.equal(staleReason({ state: "parked", hold: null, reason: "waiting on #1" }, q), null);
  // The first id is the one judged: "#1 (see PR #276)" must not read stale because #276 happens to be a task.
  assert.equal(staleReason({ state: "parked", hold: null, reason: "waiting on #1 (see #3)" }, q), null);
  // An id with no row in the queue says nothing about the park — and a sentence with no id says nothing either.
  assert.equal(staleReason({ state: "parked", hold: null, reason: "waiting on PR #276" }, q), null);
  assert.equal(staleReason({ state: "parked", hold: null, reason: "needs a decision" }, q), null);
  // A row that is not parked carries no park to be stale.
  assert.equal(staleReason(q[0], q), null);
  // A TYPED hold is judged by `holdState`, not by its prose: the sweep releases it, so the marker would be a second,
  // weaker answer to a question the hold already answers.
  const typed = { state: "parked", hold: { kind: "task", value: "#3", since: null }, reason: "blocked on #3" };
  assert.equal(staleReason(typed, q), null);

  // The digest keeps the plain `(manual)` for every one of those.
  const plain = setTaskState(q, 2, "parked", { reason: "waiting on PR #276" }).tasks;
  const line = queueDigest(plain, { isLive: () => false }).find((l) => l.includes("#2")) || "";
  assert.match(line, /^- ⏸ #2 parked \(manual\) · /, line);
});

test("the sentry's tick still sweeps when an earlier pass throws — the sweep has its own try", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-queue-sweep-rule-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  // `enabled: false` keeps the reader's rules out of the pass, so nothing can wake or spawn; the pass this test makes
  // throw is the one the tick runs for every assistant either way.
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: { enabled: false }, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const jobs = [job(T1, "done")];
  const logged = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => jobs, firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    onLog: (line) => logged.push(line),
  });
  const file = assistant.queuePathOf(assistant.assistantRecord());
  writeQueueFile(
    file,
    [
      { id: 1, title: "held on a run that ended", state: "parked", hold: { kind: "thread", value: T1, since: "2024-05-01T21:36:00.000Z" }, reason: "the resume run is still going" },
      { id: 2, title: "manual", state: "parked", hold: null, reason: "needs a decision" },
    ],
    3,
  );

  // The passes before the sweep are the board's own read of the world. One that throws must cost its own pass only.
  assistant.checkSpawnWatches = () => {
    throw new Error("a pass that throws");
  };
  assistant.tick();

  const rows = readQueueFile(file).tasks;
  assert.equal(rows.find((r) => r.id === 1).state, "queued", "the hold that ended was put back anyway");
  assert.match(rows.find((r) => r.id === 1).reason, /^hold ended: thread .* ended done 22:43$/);
  assert.equal(rows.find((r) => r.id === 2).state, "parked", "and the manual park is still the reader's");
  assert.ok(
    logged.some((l) => /tick failed: a pass that throws/.test(l)),
    `the failed pass is still logged: ${JSON.stringify(logged)}`,
  );
  assert.ok(
    assistant.journal.some((j) => /#1 held on a run that ended — back in the queue by the panel: hold ended: thread/.test(j.text)),
    "and the release is journalled with the hold kind and the value that ended it",
  );
  // Idempotent: the next tick has nothing left to do, so the row cannot thrash between queued and parked.
  writeQueueFile(file, readQueueFile(file).tasks, 3);
  assistant.tick();
  const again = readQueueFile(file).tasks;
  assert.deepEqual(again.map((r) => [r.id, r.state]), [[1, "queued"], [2, "parked"]]);
});
