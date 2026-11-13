// The three pipeline-ledger defects this row carried out of the 2026-11-09 rounds, one test each, written from the
// shortest path a caller can take. They were fixed together on 2026-11-09 in c067c25c; the point of this file is that
// each of these three tests FAILS on that commit's parent and passes here, so "already fixed" is a measured verdict
// and not a reading of the fix's own commit message. The red run is recorded in
// docs/reports/pipeline-ledger-three-defects-2026-11-13.html.
//
//   1. a stage-run id collision: two starts of one visit shared `<pipeline>/<stage>#<visit>`, and a settle that
//      matched stage and visit alone stamped the newest entry whatever thread it ran on.
//   2. a park erased by the link: `linkTaskRun` wrote `running` and cleared `hold` and `reason`, so a park written
//      while the spawn was linking was gone from the record.
//   3. startedAt backfilled at done: a row closed by hand before it ever ran finished with startedAt == doneAt and
//      read as a zero-length run.
import assert from "node:assert/strict";
import test from "node:test";
import { beginStageRun, settleStageRun, stageRunsOf } from "../lib/task-pipeline.js";
import { addTask, linkTaskRun, setTaskState } from "../lib/assistant/queue.js";

const at = (s) => new Date(s);
const onPipeline = (extra = {}) => ({
  id: "row-1",
  pipelineRun: { pipeline: "p", stage: "s1", enteredAt: "2026-11-09T10:00:00.000Z" },
  ...extra,
});
const span = (task) =>
  task.startedAt && task.doneAt ? Date.parse(task.doneAt) - Date.parse(task.startedAt) : null;

test("defect 1: two starts of one visit are two stage runs, two ids, and a settle stamps only its own", () => {
  const first = beginStageRun(onPipeline(), { stage: "s1", thread: "thread-A", at: "2026-11-09T10:01:00.000Z" });
  const second = beginStageRun(first, { stage: "s1", thread: "thread-B", at: "2026-11-09T10:02:00.000Z" });
  const runs = stageRunsOf(second.pipelineRun);

  assert.equal(runs.length, 2, "a second start on another thread is a second run, not a retry of the first");
  assert.deepEqual(
    runs.map((entry) => entry.id),
    ["p/s1#1", "p/s1#1.2"],
    "the first attempt keeps the bare id and the next one is suffixed",
  );
  assert.equal(new Set(runs.map((entry) => entry.id)).size, runs.length, "no two entries of one ledger share an id");

  const settled = settleStageRun(second, {
    stage: "s1",
    visit: 1,
    thread: "thread-A",
    status: "done",
    at: "2026-11-09T10:30:00.000Z",
  });
  const after = stageRunsOf(settled.pipelineRun);
  assert.equal(after.find((entry) => entry.thread === "thread-A").status, "done");
  assert.equal(
    after.find((entry) => entry.thread === "thread-B").status,
    null,
    "thread A's settle does not stamp thread B's run",
  );
});

test("defect 2: a link fills facts and leaves a park exactly as it was", () => {
  const { tasks } = addTask([], { title: "the gate" }, { at: at("2026-11-09T10:00:00Z"), nextId: 11 });
  const parked = setTaskState(tasks, 11, "parked", {
    hold: { kind: "manual", value: "" },
    reason: "the gate could not be read",
    at: at("2026-11-09T10:05:00Z"),
  });
  const linked = linkTaskRun(parked.tasks, 11, {
    thread: "thread-X",
    runId: "run_abc123",
    worktree: "trees/x",
    project: "menu",
    at: at("2026-11-09T10:06:00Z"),
  });

  assert.equal(linked.task.state, "parked", "a link is not a state transition");
  assert.deepEqual(linked.task.hold, { kind: "manual", value: "", since: "2026-11-09T10:05:00.000Z" });
  assert.equal(linked.task.reason, "the gate could not be read");
  assert.equal(linked.task.thread, "thread-X", "and the facts the link exists to record are all there");
  assert.equal(linked.task.runId, "run_abc123");
  assert.equal(linked.task.worktree, "trees/x");
  assert.equal(linked.task.project, "menu");
});

test("defect 3: done keeps a real start and never invents one", () => {
  const { tasks: handCut } = addTask([], { title: "hand cut" }, { at: at("2026-11-09T09:00:00Z") });
  const closed = setTaskState(handCut, 1, "done", {
    by: "reader",
    reason: "closed by hand",
    at: at("2026-11-09T09:20:00Z"),
  });
  assert.equal(closed.task.startedAt, null, "a row that never started finishes with no start, not a zero-length run");
  assert.equal(closed.task.doneAt, "2026-11-09T09:20:00.000Z");
  assert.equal(span(closed.task), null, "and there is no run to measure");

  const { tasks: reallyRan } = addTask([], { title: "really ran" }, { at: at("2026-11-09T09:00:00Z") });
  const running = setTaskState(reallyRan, 1, "running", { by: "assistant-1", at: at("2026-11-09T09:02:00Z") });
  const finished = setTaskState(running.tasks, 1, "done", { by: "assistant-1", at: at("2026-11-09T09:22:00Z") });
  assert.equal(finished.task.startedAt, "2026-11-09T09:02:00.000Z", "the run's own start survives the done");
  assert.equal(span(finished.task), 20 * 60_000, "20 minutes, not 0");
});
