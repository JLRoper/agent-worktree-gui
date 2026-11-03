// A SPAWN that names a queue row writes that row at the cut — and one that names a row it cannot have cuts nothing.
//
//   node tools/verify-spawn-links-queue.mjs
//
// Before this, the link was a follow-up edit the assistant had to remember: SPAWN, then read the thread off the
// board, then `POST {action:"edit", thread, worktree}`, then `POST {action:"state", state:"running"}`. An assistant
// that forgot left the row `queued` with no thread under a live worker, the digest counted `running: 0`, and the
// row only grew a STALE flag once somebody marked it running by hand — under a worker that was not stale at all.
// The line can now carry the id, and the panel does the write itself.
//
// Driven here through the real path a turn takes — `parseActions` on the reply, then `harvest` → `applyActions` →
// `startSpawn` — over a REAL Assistant, a REAL queue file on disk, and an injected spawner that records every call
// (the way server.js injects `assistantSpawnRun`). So "refused" is not a return value alone: it means the spawner
// was never asked, and the row on disk is byte-for-byte what it was.
//
//   1. `SPAWN #1 <project> | …` cuts once and the row reads running, with the worker's thread, worktree and
//      startedAt — one write, already complete when the harvest resolves, with no follow-up edit;
//   2. a missing id, a done row and another assistant's id are each refused, name the reason, and cut nothing;
//   3. `SPAWN <project> | …` with no id cuts exactly as before and links no row at all;
//   4. a restart's replay of a line whose row is already linked settles against that run instead of cutting a
//      second tree (the `taskId` on `spawnIntents`).
//
// It is also the branch's red proof: on `main` the id is not part of the grammar, so #1 resolves `#1
// agent-worktree-gui` as a project name, starts nothing and the run fails.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { Assistant, ASSISTANT_THREAD } = await import("../lib/assistant.js");
const { readQueueFile, writeQueueFile } = await import("../lib/assistant/queue.js");

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

const T0 = Date.parse("2026-11-02T20:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const sandbox = mkdtempSync(path.join(tmpdir(), "wtgui-spawn-link-"));
const projectPath = path.join(sandbox, "agent-worktree-gui").replace(/\\/g, "/");
const treeOne = `${projectPath}/.worktrees/task-one-40a1b2`;
const threadOne = "wtgui-task-one-40a1b2";
const PROJECT = { name: "agent-worktree-gui", path: projectPath };
for (const d of [projectPath, treeOne]) mkdirSync(d, { recursive: true });

const started = [];
const board = [];
const jobs = {
  list: () => board,
  firstOfThread: (thread) => board.find((j) => j.thread === thread) || null,
  busyFor: () => ({ held: false, where: null, by: [] }),
  modelFor: () => null,
  create: async (opts) => ({ id: "job-created", ...opts }),
  answerQuestion: async () => ({ ok: true }),
  stop: async () => ({ ok: true }),
  get: () => null,
  clarify: { state: () => null },
};
const assistant = new Assistant({
  config: { jobsFile: path.join(sandbox, "jobs.json"), assistantFile: path.join(sandbox, "assistant.json"), defaultCwd: sandbox },
  jobs,
  getProjects: () => [PROJECT],
  spawner: async (spec) => {
    started.push(spec);
    return { id: `job-${started.length}`, thread: threadOne, cwd: treeOne, worktreePath: treeOne, branch: "wtgui/task-one-40a1b2" };
  },
  now: () => T0,
});
assistant.settings.spawn = "auto";

const queueFile = assistant.queuePathOf(assistant.assistantRecord("assistant-1"));
const rowOnDisk = (id, who = "assistant-1") =>
  readQueueFile(assistant.queuePathOf(assistant.assistantRecord(who))).tasks.find((t) => t.id === id) || null;
const addTask = (input = {}, who = "assistant-1") => assistant.queueMutate(who, "add", { title: "carry the task", ...input }).task;
const textLine = (text) => ({ kind: "text", text, at: T0, lid: Math.random() });
const harvestTurn = (id, line) => assistant.harvest({ id, thread: ASSISTANT_THREAD, lines: [textLine(line)] });
const journalsSince = (n) => assistant.journal.slice(n);

console.log("== 1. the cut writes the row: thread, worktree, running, startedAt ==");
const first = addTask({ title: "write the docs for the board" });
const beforeOne = assistant.journal.length;
await harvestTurn("turn-link", `SPAWN #${first.id} agent-worktree-gui | write the docs for the board`);
check("the spawner was asked once", started.length, 1);
check("the spec carries the row it serves", started[0]?.taskId, first.id);
const linked = rowOnDisk(first.id);
check("the row is running", linked?.state, "running");
check("the row names the worker's thread", linked?.thread, threadOne);
check("the row's agent list is the one run", linked?.threads, [threadOne]);
check("the row names the tree the worker runs in", linked?.worktree, treeOne);
check("startedAt is the cut's own clock", linked?.startedAt, iso(T0));
const linkLines = journalsSince(beforeOne).filter((j) => j.kind === "queue");
check("one queue journal line, not an edit plus a state change", linkLines.length, 1);
ok("and it says the SPAWN linked it", /linked to wtgui-task-one-40a1b2/.test(String(linkLines[0]?.text || "")), String(linkLines[0]?.text || "").slice(0, 120));
const intentOne = assistant.spawnIntents.find((it) => it.turnId === "turn-link");
check("the debt carries the id for a replay", intentOne?.taskId, first.id);
check("and settled as a job", intentOne?.outcome, "job");

console.log("\n== 2. a bad id is refused BEFORE anything is cut ==");
const second = addTask({ title: "already finished" });
assistant.queueMutate("assistant-1", "state", { id: second.id, state: "done" });
const reviewer = assistant.createAssistant({ name: "Reviewer" }).created;
// Reviewer's own file, under an id Assistant #1 has never handed out: ids are per file, and the collision this
// check has to see is "that number exists over there", not "it exists here too". A first id of 1 would resolve
// against #1's own row 1 and start a worker.
writeQueueFile(
  assistant.queuePathOf(assistant.assistantRecord(reviewer.id)),
  [{ id: 50, title: "reviewer's own row", state: "queued", files: [] }],
  51,
);
const foreign = rowOnDisk(50, reviewer.id);

const snapshot = (id) => JSON.stringify(rowOnDisk(id));
const refused = async (label, id, line) => {
  const calls = started.length;
  const before = assistant.journal.length;
  const was = id ? snapshot(id) : null;
  await harvestTurn(`turn-refuse-${String(line).replace(/\W+/g, "-").slice(0, 20)}`, line);
  const lines = journalsSince(before).filter((j) => j.kind === "spawn-refused");
  check(`${label}: the spawner was never asked`, started.length, calls);
  check(`${label}: one refusal is journalled`, lines.length, 1);
  ok(`${label}: the reason names the id`, new RegExp(`#\\d+`).test(String(lines[0]?.text || "")), String(lines[0]?.text || "").slice(0, 140));
  ok(`${label}: and says nothing was cut`, /nothing was cut/.test(String(lines[0]?.text || "")));
  if (id) check(`${label}: the row is byte-for-byte what it was`, snapshot(id), was);
  return String(lines[0]?.text || "");
};

const missingWhy = await refused("missing", null, "SPAWN #99 agent-worktree-gui | work that was never filed");
ok("missing: the message names Assistant #1's queue", /no task #99 in Assistant #1's queue/.test(missingWhy), missingWhy.slice(0, 160));
const doneWhy = await refused("done", second.id, `SPAWN #${second.id} agent-worktree-gui | do it again`);
ok("done: the message says it is done and to requeue it", /is done \(already finished\)/.test(doneWhy) && /requeue it first/.test(doneWhy), doneWhy.slice(0, 160));
const foreignWhy = await refused("foreign", foreign.id, `SPAWN #${foreign.id} agent-worktree-gui | work filed in the wrong queue`);
ok("foreign: the message names whose queue has it", /is in Reviewer's queue, not Assistant #1's/.test(foreignWhy), foreignWhy.slice(0, 180));
check("no card was made for any refusal", assistant.state().alerts.filter((a) => a.spawn).length, 0);
check("and every refusal settled its debt rather than leaving it owed", assistant.spawnIntents.filter((it) => /^turn-refuse-/.test(String(it.turnId)) && it.outcome === "skipped").length, 3);

console.log("\n== 3. a SPAWN with no id cuts exactly as before, and links nothing ==");
const plain = addTask({ title: "the row nobody named" });
const beforePlain = snapshot(plain.id);
const callsBefore = started.length;
const journalBefore = assistant.journal.length;
await harvestTurn("turn-plain", "SPAWN agent-worktree-gui | a brief with no row behind it");
check("the cut still happens", started.length, callsBefore + 1);
check("the spec carries no id", started.at(-1)?.taskId, null);
check("the named row is untouched", snapshot(plain.id), beforePlain);
check("no queue line was written for it", journalsSince(journalBefore).filter((j) => j.kind === "queue").length, 0);
check("and the debt carries no id", assistant.spawnIntents.find((it) => it.turnId === "turn-plain")?.taskId, null);

console.log("\n== 4. a restart's replay re-links instead of re-cutting ==");
const replayTask = addTask({ title: "cut before the crash" });
const callsBeforeReplay = started.length;
// The crash window: the cut wrote the row, and the intent that records the line was never settled.
await assistant.startSpawn({ target: "agent-worktree-gui", prompt: "the brief that already cut", taskId: replayTask.id }, { source: "assistant" });
check("the first cut happened", started.length, callsBeforeReplay + 1);
board.length = 0;
board.push({ id: "job-old", thread: threadOne, status: "running", cwd: treeOne, startedAt: iso(T0 - 60_000) });
assistant.spawnIntents = [
  {
    id: "debt0001",
    turnId: "turn-replay",
    thread: ASSISTANT_THREAD,
    at: T0 - 60_000,
    target: "agent-worktree-gui",
    existing: false,
    prompt: "the brief that already cut",
    taskId: replayTask.id,
    outcome: null,
    alertId: null,
    jobThread: null,
    reportedAt: null,
  },
];
assistant.harvested.clear();
const beforeReplay = assistant.journal.length;
await harvestTurn("turn-replay", `SPAWN #${replayTask.id} agent-worktree-gui | the brief that already cut`);
const replayRows = assistant.spawnIntents.filter((it) => it.turnId === "turn-replay");
check("nothing was cut a second time", started.length, callsBeforeReplay + 1);
check("the debt is settled as a job", replayRows[0]?.outcome, "job");
check("against the thread that exists", replayRows[0]?.jobThread, threadOne);
check("and records the tree the row already names", replayRows[0]?.tree, treeOne);
const relinked = journalsSince(beforeReplay).filter((j) => j.kind === "spawn-replay-relinked");
check("the re-link is journalled once", relinked.length, 1);
ok("and says it re-linked rather than cut", /re-linked rather than carried out again — nothing was cut/.test(String(relinked[0]?.text || "")), String(relinked[0]?.text || "").slice(0, 160));
check("the row still names the one run", rowOnDisk(replayTask.id)?.thread, threadOne);
check("and did not grow a second agent", rowOnDisk(replayTask.id)?.threads, [threadOne]);

// The row the first section linked is still on disk exactly once: one cut, one row, one write.
const fileTasks = JSON.parse(readFileSync(queueFile, "utf8")).tasks;
check("the queue file holds every row once", fileTasks.length, 4);
check("and the first one is still the linked run", fileTasks.find((t) => t.id === first.id)?.thread, threadOne);

clearTimeout(assistant.persistTimer);
if (assistant.timer) clearInterval(assistant.timer);
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* a held handle; the sandbox is under the temp dir */
}
console.log(`\n== summary ==\n${checks} checks, ${failures} failed.`);
console.log("driven through the real parse → harvest → startSpawn path over a real Assistant and a real queue file,");
console.log("with an injected spawner that records every call, so 'refused' means the spawner was never asked.");
if (failures) console.log("RESULT: SPAWN-QUEUE-LINK-FAILED");
else console.log("RESULT: SPAWN-QUEUE-LINK-OK");
process.exit(failures ? 1 : 0);
