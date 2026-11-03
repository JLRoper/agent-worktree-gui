// A SPAWN that names a queue row must WRITE that row at the cut. Until it did, every worker started from a task
// left the task reading `queued` with no thread: the digest counted `running: 0` beside live work, and the row only
// grew a STALE flag once somebody marked it running by hand. The link is one write made where the job is created
// (thread, worktree, running, startedAt), not an edit the assistant has to remember afterwards.
//
// The refusals are the other half: an id that names nothing, a finished task, a row in ANOTHER assistant's queue —
// each is refused before anything is cut, so a bad line cannot leave a worker behind it. And a line with no id
// still cuts exactly as it always did, linking nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant, ASSISTANT_THREAD, parseActions } from "../lib/assistant.js";
import { readQueueFile } from "../lib/assistant/queue.js";

const T0 = Date.parse("2026-11-02T20:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const textLine = (text, at = T0) => ({ kind: "text", text, at, lid: Math.random() });
const PROJECT = { name: "agent-worktree-gui", path: "C:/ProjectDevelopment/agent-worktree-gui" };
const TREE = "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/task-one-40a1b2";
const THREAD = "wtgui-task-one-40a1b2";

function harness(t, { spawn = "auto" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-spawn-link-"));
  t.after(() => {
    clearTimeout(assistant.persistTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    rmSync(dir, { recursive: true, force: true });
  });
  const started = [];
  const state = { board: [] };
  const jobs = {
    list: () => state.board,
    firstOfThread: (thread) => state.board.find((j) => j.thread === thread) || null,
    busyFor: () => ({ held: false, where: null, by: [] }),
    modelFor: () => null,
    create: async (opts) => ({ id: "job-created", ...opts }),
    answerQuestion: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    get: () => null,
    clarify: { state: () => null },
  };
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir },
    jobs,
    getProjects: () => [PROJECT],
    spawner: async (spec) => {
      started.push(spec);
      return { id: `job-${started.length}`, thread: THREAD, cwd: TREE, worktreePath: TREE, branch: "wtgui/task-one-40a1b2" };
    },
    now: () => T0,
  });
  assistant.settings.spawn = spawn;
  const task = (input = {}) => assistant.queueMutate("assistant-1", "add", { title: "carry the task", ...input }).task;
  const rowOf = (id, who = "assistant-1") => readQueueFile(assistant.queuePathOf(assistant.assistantRecord(who))).tasks.find((x) => x.id === id) || null;
  const turn = (id, line) => ({ id, thread: ASSISTANT_THREAD, lines: [textLine(line)] });
  return { assistant, started, state, dir, task, rowOf, turn };
}

// ---------------------------------------------------------------------------------------------
// parsing: the id leads either form, and a project that begins with digits is not an id
// ---------------------------------------------------------------------------------------------

test("a task id leads both SPAWN forms, and bare digits are accepted beside #", () => {
  const bare = parseActions("SPAWN #12 agent-worktree-gui | write the docs").spawn[0];
  assert.deepEqual(
    { target: bare.target, existing: bare.existing, taskId: bare.taskId },
    { target: "agent-worktree-gui", existing: false, taskId: 12 },
  );
  const inside = parseActions("SPAWN IN #4 C:/tmp/a-tree | fix the tests").spawn[0];
  assert.deepEqual(
    { target: inside.target, existing: inside.existing, taskId: inside.taskId },
    { target: "C:/tmp/a-tree", existing: true, taskId: 4 },
  );
  const ledIn = parseActions("SPAWN 9 IN C:/tmp/a-tree | fix").spawn[0];
  assert.equal(ledIn.existing, true, "the id may lead the whole target");
  assert.equal(ledIn.target, "C:/tmp/a-tree");
  assert.equal(ledIn.taskId, 9);

  // No id: the line is exactly what it always was.
  const plain = parseActions("SPAWN agent-worktree-gui | write the docs").spawn[0];
  assert.equal(plain.taskId, null);
  assert.equal(plain.target, "agent-worktree-gui");
  // A project whose own name starts with digits is not an id.
  const named = parseActions("SPAWN 3d-viewer | open the scene").spawn[0];
  assert.equal(named.taskId, null);
  assert.equal(named.target, "3d-viewer");
  // A quoted target still resolves, with the id inside the quotes read as the id.
  const quoted = parseActions('SPAWN "#7 some-project" | go').spawn[0];
  assert.deepEqual([quoted.taskId, quoted.target], [7, "some-project"]);
});

// ---------------------------------------------------------------------------------------------
// the cut writes the row: thread, worktree, running and startedAt, in one write, no follow-up edit
// ---------------------------------------------------------------------------------------------

test("a SPAWN naming a task writes that row running at the cut, with its thread and tree", async (t) => {
  const { assistant, started, task, rowOf, turn } = harness(t);
  const added = task({ title: "carry the docs task" });
  assert.equal(added.state, "queued");
  const journalledBefore = assistant.journal.length;

  await assistant.harvest(turn("turn-link", `SPAWN #${added.id} agent-worktree-gui | write the docs`));

  assert.equal(started.length, 1, "the worker was started");
  assert.equal(started[0].taskId, added.id, "the spawn spec carries the row it serves");
  const row = rowOf(added.id);
  assert.equal(row.state, "running", "the row is running, not queued");
  assert.equal(row.thread, THREAD, "the row names the worker's thread");
  assert.deepEqual(row.threads, [THREAD], "and the run is on its agent list");
  assert.equal(row.worktree, TREE, "the row names the tree the worker runs in");
  assert.equal(row.project, "agent-worktree-gui", "…and the project the SPAWN cut it in, as a name");
  assert.equal(row.startedAt, iso(T0), "startedAt is the cut's own clock");
  assert.equal(row.doneAt, null);
  assert.equal(row.reason, "");

  // It is one write, made inside the spawn: nothing follows the harvest to finish the row.
  const journal = assistant.journal.slice(journalledBefore).filter((j) => j.kind === "queue");
  assert.equal(journal.length, 1, "one queue journal line, not an edit plus a state change");
  assert.match(String(journal[0].text), new RegExp(`#${added.id} .*linked to ${THREAD}`));
  assert.equal(assistant.spawnIntents[0].taskId, added.id, "the debt carries the id for a restart replay");
  assert.equal(assistant.spawnIntents[0].outcome, "job");
});

test("a task already carried takes the new run as its current agent and keeps the old one", async (t) => {
  const { assistant, task, rowOf, turn } = harness(t);
  const added = task({ title: "second attempt" });
  assistant.queueMutate("assistant-1", "edit", { id: added.id, thread: "wtgui-first-attempt-111111" });
  await assistant.harvest(turn("turn-again", `SPAWN #${added.id} agent-worktree-gui | try again`));
  const row = rowOf(added.id);
  assert.equal(row.thread, "wtgui-first-attempt-111111", "`thread` stays the legacy FIRST agent");
  assert.deepEqual(row.threads, ["wtgui-first-attempt-111111", THREAD], "the new run is appended as the current one");
  assert.equal(row.state, "running");
});

// ---------------------------------------------------------------------------------------------
// a bad id is refused BEFORE anything is cut
// ---------------------------------------------------------------------------------------------

test("a SPAWN naming a missing task is refused and cuts nothing", async (t) => {
  const { assistant, started, task, rowOf, turn } = harness(t);
  const added = task({ title: "the only row" });
  await assistant.harvest(turn("turn-missing", "SPAWN #99 agent-worktree-gui | work that was never filed"));

  assert.equal(started.length, 0, "the gateway was never asked");
  assert.match(String(assistant.journal.find((j) => j.kind === "spawn-refused")?.text), /no task #99 in Assistant #1's queue/);
  assert.match(String(assistant.journal.find((j) => j.kind === "spawn-refused")?.text), /nothing was cut/);
  assert.equal(rowOf(added.id).state, "queued", "the row nobody named is untouched");
  assert.equal(assistant.spawnIntents[0].outcome, "skipped", "the debt is settled, not left owed for the watchdog");
  assert.equal(assistant.state().alerts.filter((a) => a.spawn).length, 0, "and no card was made for it");
});

test("a SPAWN naming a done task is refused and cuts nothing", async (t) => {
  const { assistant, started, task, rowOf, turn } = harness(t);
  const added = task({ title: "already finished" });
  assistant.queueMutate("assistant-1", "state", { id: added.id, state: "done" });
  await assistant.harvest(turn("turn-done", `SPAWN #${added.id} agent-worktree-gui | do it again`));

  assert.equal(started.length, 0);
  assert.match(String(assistant.journal.find((j) => j.kind === "spawn-refused")?.text), /is done \(already finished\)/);
  assert.match(String(assistant.journal.find((j) => j.kind === "spawn-refused")?.text), /requeue it first/);
  assert.equal(rowOf(added.id).state, "done", "a refusal does not reopen it");
  assert.equal(rowOf(added.id).thread, null);
});

test("a SPAWN naming an id that lives in another assistant's queue is refused, and says whose it is", async (t) => {
  const { assistant, started, turn } = harness(t);
  const second = assistant.createAssistant({ name: "Reviewer" }).created;
  assistant.queueMutate(second.id, "add", { title: "reviewer's own row" });

  // Assistant #1 has no row #1; the id exists in Reviewer's file. Ids are per file, so this is the mistake the
  // check has to name rather than read as a typo.
  await assistant.harvest(turn("turn-foreign", "SPAWN #1 agent-worktree-gui | work filed in the wrong queue"));

  assert.equal(started.length, 0, "nothing was cut");
  const why = String(assistant.journal.find((j) => j.kind === "spawn-refused")?.text);
  assert.match(why, /task #1 is in Reviewer's queue, not Assistant #1's/);
  const foreign = readQueueFile(assistant.queuePathOf(second)).tasks[0];
  assert.equal(foreign.state, "queued", "the other assistant's row was not touched either");
  assert.equal(foreign.thread, null);
});

test("a SPAWN naming a parked task is refused: a park is a hold, not a start", async (t) => {
  const { assistant, started, task, rowOf, turn } = harness(t);
  const added = task({ title: "waiting on something" });
  assistant.queueMutate("assistant-1", "state", { id: added.id, state: "parked", reason: "waiting on the deploy" });
  await assistant.harvest(turn("turn-parked", `SPAWN #${added.id} agent-worktree-gui | start it anyway`));
  assert.equal(started.length, 0);
  assert.match(String(assistant.journal.find((j) => j.kind === "spawn-refused")?.text), /is parked — waiting on the deploy/);
  assert.equal(rowOf(added.id).state, "parked");
});

// ---------------------------------------------------------------------------------------------
// no id: exactly today's cut
// ---------------------------------------------------------------------------------------------

test("a SPAWN with no task id still cuts, and links nothing", async (t) => {
  const { assistant, started, task, rowOf, turn } = harness(t);
  const added = task({ title: "the row nobody named" });
  const journalledBefore = assistant.journal.length;
  await assistant.harvest(turn("turn-plain", "SPAWN agent-worktree-gui | a brief with no row behind it"));

  assert.equal(started.length, 1, "the cut is unchanged");
  assert.equal(started[0].taskId, null);
  const row = rowOf(added.id);
  assert.equal(row.state, "queued");
  assert.equal(row.thread, null);
  assert.equal(row.worktree, null);
  assert.equal(row.startedAt, null);
  assert.equal(assistant.journal.slice(journalledBefore).filter((j) => j.kind === "queue").length, 0, "no queue write at all");
  assert.equal(assistant.spawnIntents[0].taskId, null);
});

// ---------------------------------------------------------------------------------------------
// ask mode: the id travels on the card, and the press is checked again
// ---------------------------------------------------------------------------------------------

test("ask mode carries the id on the card and writes the row when the reader presses Start", async (t) => {
  const { assistant, started, task, rowOf, turn } = harness(t, { spawn: "ask" });
  const added = task({ title: "press to start" });
  await assistant.harvest(turn("turn-card", `SPAWN #${added.id} agent-worktree-gui | the card's brief`));

  assert.equal(started.length, 0, "a card starts nothing");
  const card = assistant.state().alerts.find((a) => a.spawn);
  assert.equal(card.spawn.taskId, added.id, "the card carries the row");
  assert.equal(rowOf(added.id).state, "queued", "nothing is written before the cut");

  await assistant.startSpawn(assistant.pendingSpawn(card.id), { alertId: card.id });
  assert.equal(started.length, 1);
  const row = rowOf(added.id);
  assert.equal(row.state, "running");
  assert.equal(row.thread, THREAD);
  assert.equal(row.worktree, TREE);
  assert.equal(row.startedAt, iso(T0));
});

test("a card whose task finished while it waited is refused at the press, and cuts nothing", async (t) => {
  const { assistant, started, task, rowOf, turn } = harness(t, { spawn: "ask" });
  const added = task({ title: "started, then finished" });
  await assistant.harvest(turn("turn-card-done", `SPAWN #${added.id} agent-worktree-gui | a card that waits`));
  const card = assistant.state().alerts.find((a) => a.spawn);
  assistant.queueMutate("assistant-1", "state", { id: added.id, state: "done" });

  await assert.rejects(
    () => assistant.startSpawn(assistant.pendingSpawn(card.id), { alertId: card.id }),
    /is done/,
    "the press is checked again, before the spawner runs",
  );
  assert.equal(started.length, 0, "the gateway was never asked");
  assert.equal(rowOf(added.id).state, "done");
});

// ---------------------------------------------------------------------------------------------
// the restart replay re-links instead of re-cutting
// ---------------------------------------------------------------------------------------------

test("a replayed SPAWN whose row is already linked settles against that run and cuts nothing", async (t) => {
  const { assistant, started, state, task, rowOf, turn } = harness(t);
  const added = task({ title: "cut before the crash" });
  // The crash window: the cut wrote the row (thread + tree), and the intent that records the line was never
  // settled — exactly what a process killed between `linkSpawnTask` and `settleSpawnIntent` leaves behind.
  await assistant.startSpawn({ target: "agent-worktree-gui", prompt: "the brief that already cut", taskId: added.id }, { source: "assistant" });
  assert.equal(started.length, 1);
  state.board = [{ id: "job-old", thread: THREAD, status: "running", cwd: TREE, startedAt: iso(T0 - 60_000) }];
  assistant.spawnIntents = [
    {
      id: "debt0001",
      turnId: "turn-replay",
      thread: ASSISTANT_THREAD,
      at: T0 - 60_000,
      target: "agent-worktree-gui",
      existing: false,
      prompt: "the brief that already cut",
      taskId: added.id,
      outcome: null,
      alertId: null,
      jobThread: null,
      reportedAt: null,
    },
  ];
  assistant.harvested.clear();

  await assistant.harvest(turn("turn-replay", `SPAWN #${added.id} agent-worktree-gui | the brief that already cut`));

  assert.equal(started.length, 1, "nothing was cut a second time");
  assert.equal(assistant.spawnIntents[0].outcome, "job", "the debt is settled against the run that exists");
  assert.equal(assistant.spawnIntents[0].jobThread, THREAD);
  assert.equal(assistant.spawnIntents[0].tree, TREE, "the debt records the tree the row already names");
  const relinked = assistant.journal.find((j) => j.kind === "spawn-replay-relinked");
  assert.ok(relinked, "the re-link is journalled");
  assert.match(String(relinked.text), /re-linked rather than carried out again — nothing was cut/);
  assert.match(String(relinked.text), new RegExp(`#${added.id}`));
  assert.equal(rowOf(added.id).thread, THREAD, "the row still names the one run");
  assert.deepEqual(rowOf(added.id).threads, [THREAD], "and did not grow a second agent");
});

test("the task id survives a restart, so the next process can re-link instead of cutting again", async (t) => {
  const { assistant, task, turn, dir } = harness(t);
  const added = task({ title: "survives the restart" });
  await assistant.harvest(turn("turn-survive", `SPAWN #${added.id} agent-worktree-gui | the brief that survives`));
  assistant.writeNow();

  // A second instance over the same state directory is what a panel restart is to this record. The id has to
  // survive the store's own field whitelist, or the replay reads a debt that cannot say which row it served.
  const again = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir },
    jobs: { list: () => [] },
    getProjects: () => [PROJECT],
  });
  const debt = again.spawnIntents.find((it) => it.turnId === "turn-survive");
  assert.ok(debt, "the debt is on disk");
  assert.equal(debt.taskId, added.id, "and it names the row after the restart");
  assert.equal(debt.outcome, "job");
  clearTimeout(again.persistTimer);
  if (again.timer) clearInterval(again.timer);
});

test("a debt the watchdog called lost is re-linked too, when its row already names the run", async (t) => {
  const { assistant, started, state, task, turn } = harness(t);
  const added = task({ title: "lost while nobody looked" });
  await assistant.startSpawn({ target: "agent-worktree-gui", prompt: "the briefing that already ran", taskId: added.id }, { source: "assistant" });
  assert.equal(started.length, 1);
  state.board = [{ id: "job-lost", thread: THREAD, status: "running", cwd: TREE, startedAt: iso(T0) }];
  assistant.spawnIntents = [
    {
      id: "debt0002",
      turnId: "turn-lost-debt",
      thread: ASSISTANT_THREAD,
      at: T0 - 120_000,
      target: "agent-worktree-gui",
      existing: false,
      prompt: "the briefing that already ran",
      taskId: added.id,
      outcome: "lost",
      alertId: null,
      jobThread: null,
      reportedAt: iso(T0 - 60_000),
    },
  ];

  await assistant.harvest(turn("turn-lost-debt", `SPAWN #${added.id} agent-worktree-gui | the briefing that already ran`));

  assert.equal(started.length, 1, "the lost line is not cut a second time");
  assert.equal(assistant.spawnIntents[0].outcome, "job", "and the debt is settled against the run that exists");
  assert.equal(assistant.spawnIntents[0].jobThread, THREAD);
  assert.ok(assistant.journal.some((j) => j.kind === "spawn-replay-relinked"), "the re-link is journalled");
});
