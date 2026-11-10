// The three pipeline-ledger defects, driven against this checkout's modules. Run: node tools/probe-pipeline-ledger.mjs
//
// It prints one block per defect and writes nothing. The point is the SAME probe answering before and after the fix:
//   git archive HEAD lib | tar -x -C <old tree>   (the base)
//   node tools/probe-pipeline-ledger.mjs           (the branch)
// so the PR can quote an old and a new block that differ only by the code under them.
import { beginStageRun, settleStageRun, stageRunsOf } from "../lib/task-pipeline.js";
import { addTask, linkTaskRun, setTaskState } from "../lib/assistant/queue.js";

const at = (s) => new Date(s);
const brief = (entry) => ({ id: entry.id, thread: entry.thread || null, status: entry.status || null });
const lines = [];
const say = (s) => lines.push(s);

// ---- defect 1: two starts in one visit share p/s1#1, and a settle stamps the wrong thread ------------------------
const base = { id: "row-1", pipelineRun: { pipeline: "p", stage: "s1", enteredAt: "2026-11-09T10:00:00.000Z" } };
const first = beginStageRun(base, { stage: "s1", thread: "thread-A", at: "2026-11-09T10:01:00.000Z" });
const second = beginStageRun(first, { stage: "s1", thread: "thread-B", at: "2026-11-09T10:02:00.000Z" });
const started = stageRunsOf(second.pipelineRun);
say("defect 1 - two starts in one visit, different threads");
say(`  entries after the two starts: ${started.length}`);
for (const entry of started) say(`  ${JSON.stringify(brief(entry))}`);
const ids = started.map((entry) => entry.id);
say(`  distinct ids: ${new Set(ids).size} of ${ids.length}`);

const settled = settleStageRun(second, { stage: "s1", visit: 1, thread: "thread-A", status: "done", at: "2026-11-09T10:30:00.000Z" });
const after = stageRunsOf(settled.pipelineRun);
say("  after settleStageRun(thread: thread-A, status: done):");
for (const entry of after) say(`  ${JSON.stringify(brief(entry))}`);
say(`  thread-A entries: ${after.filter((entry) => entry.thread === "thread-A").length}, thread-B entries: ${after.filter((entry) => entry.thread === "thread-B").length}`);

// ---- defect 2: a park written while the spawn links is erased by the link ----------------------------------------
const { tasks: seeded } = addTask([], { title: "the gate" }, { at: at("2026-11-09T10:00:00Z"), nextId: 11 });
const parked = setTaskState(seeded, 11, "parked", { hold: { kind: "manual", value: "" }, reason: "the gate could not be read", at: at("2026-11-09T10:05:00Z") });
say("defect 2 - park #11 on a manual hold, then link the spawn");
say(`  parked: ${JSON.stringify({ state: parked.task.state, hold: parked.task.hold, reason: parked.task.reason })}`);
const linked = linkTaskRun(parked.tasks, 11, { thread: "thread-X", runId: "run_abc123", worktree: "C:/trees/x", project: "menu", at: at("2026-11-09T10:06:00Z") });
say(`  linked: ${JSON.stringify({ state: linked.task.state, hold: linked.task.hold, reason: linked.task.reason, thread: linked.task.thread, runId: linked.task.runId })}`);

// ---- defect 3: startedAt backfilled at done, so a hand-cut row claims a zero-length run --------------------------
const { tasks: handCut } = addTask([], { title: "hand cut" }, { at: at("2026-11-09T09:00:00Z") });
const closed = setTaskState(handCut, 1, "done", { by: "reader", reason: "closed by hand", at: at("2026-11-09T09:20:00Z") });
const span = (t) => (t.startedAt && t.doneAt ? Date.parse(t.doneAt) - Date.parse(t.startedAt) : null);
say("defect 3 - queued -> done, never started");
say(`  startedAt=${closed.task.startedAt} doneAt=${closed.task.doneAt} runMs=${span(closed.task)}`);

const { tasks: reallyRan } = addTask([], { title: "really ran" }, { at: at("2026-11-09T09:00:00Z") });
const running = setTaskState(reallyRan, 1, "running", { by: "assistant-1", at: at("2026-11-09T09:02:00Z") });
const finished = setTaskState(running.tasks, 1, "done", { by: "assistant-1", at: at("2026-11-09T09:22:00Z") });
say(`  started -> done: startedAt=${finished.task.startedAt} doneAt=${finished.task.doneAt} runMs=${span(finished.task)}`);

// ---- row 79: one visit, two TREES - two runs, two ids, and each keeps its own tree -------------------------------
const treeBase = { id: "row-79", pipelineRun: { pipeline: "p", stage: "s1", enteredAt: "2026-11-09T10:00:00.000Z" } };
const treeOne = settleStageRun(beginStageRun(treeBase, { stage: "s1", at: "2026-11-09T10:01:00.000Z" }), {
  stage: "s1",
  tree: { path: "trees/one", branch: "stage/one" },
  commit: "1".repeat(40),
});
const treeTwo = settleStageRun(beginStageRun(treeOne, { stage: "s1", at: "2026-11-09T10:05:00.000Z" }), {
  stage: "s1",
  tree: { path: "trees/two", branch: "stage/two" },
  commit: "2".repeat(40),
});
const twoTrees = stageRunsOf(treeTwo.pipelineRun);
say("row 79 - two starts of one visit in two trees, no thread named yet");
for (const entry of twoTrees) say(`  ${JSON.stringify({ id: entry.id, tree: entry.tree ? entry.tree.path : null, status: entry.status || null })}`);
say(`  distinct ids: ${new Set(twoTrees.map((entry) => entry.id)).size} of ${twoTrees.length}`);

// ---- row 79: a settle that has to CREATE the entry does not invent the start -------------------------------------
const invented = stageRunsOf(settleStageRun(treeBase, { stage: "s1", thread: "thread-Z", status: "interrupted", at: "2026-11-09T13:00:00.000Z" }).pipelineRun)[0];
say("row 79 - a settle for a run nothing recorded starting");
say(`  at=${invented.at} settledAt=${invented.settledAt}`);
const handed = stageRunsOf(
  settleStageRun(treeBase, { stage: "s1", thread: "thread-Y", status: "interrupted", startedAt: "2026-11-09T10:40:00.000Z", at: "2026-11-09T13:00:00.000Z" }).pipelineRun,
)[0];
say(`  handed a start: at=${handed.at} settledAt=${handed.settledAt} runMs=${Date.parse(handed.settledAt) - Date.parse(handed.at)}`);

console.log(lines.join("\n"));
