// The SPAWN pre-flight: what the cut would refuse, and what would fix it, asked BEFORE the line is written.
//
// The route exists because the panel's refusals all arrived at the cut and none of them arrived before it: on
// 2026-11-21 a SPAWN naming parked row 184 was refused with "task #184 is parked" after the manager had already told
// the reader the run had started, and two SPAWNs went into trees that still held unlanded commits. Every one of
// those was knowable one call earlier.
//
// What this file pins:
//
//   1. the ok case, and the exact shape of the answer ({ok, reason, remedy, checks});
//   2. one case per refusal - a parked row, a row whose run is live, a tree a live run holds - each naming the FIX
//      and not only the obstacle;
//   3. the tree that holds unlanded work: reported with its branch and commit count, and NOT a refusal, because the
//      cut allows it (and may reuse that tree);
//   4. the route cannot drift from the cut: the tree_busy sentence the route reports IS the message `jobs.create`
//      throws for the same tree, compared byte for byte;
//   5. read only: no job is created, the queue file and the job store are byte-identical after the call, and
//      nothing on disk changes.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { Assistant } from "../lib/assistant.js";
import { SPAWN_CHECK_PATH, createSpawnCheckRoutes } from "../routes/assistant-spawn-check.js";
import { readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";

const slash = (p) => String(p).replace(/\\/g, "/");

// A project whose one worktree is a real directory: the route's resolver checks that it EXISTS (a path is taken as
// written), so a fake string would answer "does not exist" before any check ran.
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-spawn-check-"));
  const checkout = slash(path.join(dir, "checkout"));
  const held = slash(path.join(dir, "checkout", ".worktrees", "held-tree"));
  const free = slash(path.join(dir, "checkout", ".worktrees", "free-tree"));
  for (const at of [checkout, held, free]) mkdirSync(at, { recursive: true });
  writeFileSync(path.join(held, "README.md"), "held\n");
  writeFileSync(path.join(free, "README.md"), "free\n");
  const project = { name: "proj", path: checkout, mainBranch: "main" };
  const config = { jobsFile: path.join(dir, "jobs.json"), defaultCwd: dir };
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  const rows = [];
  const assistant = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "assistant.json") },
    jobs,
    getProjects: () => [project],
    getRows: () => rows,
    getChildren: () => ({}),
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(() => {
    for (const timer of ["wakeTimer", "settleTimer", "timer", "persistTimer"]) if (assistant[timer]) clearTimeout(assistant[timer]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { dir, project, jobs, assistant, rows, held, free, checkout };
}

async function ask(p, { task = "", tree = "", project = "proj", assistantId = "", token = "secret", method = "GET" } = {}) {
  const out = { status: null, body: null, handled: false };
  const send = (res, status, body) => {
    out.status = status;
    out.body = body;
  };
  const handler = createSpawnCheckRoutes({
    assistant: p.assistant,
    getProjects: () => [p.project],
    config: { token: "secret" },
    sendJson: send,
    authorised: (req, t) => req.headers["x-panel-token"] === t,
  });
  const query = new URLSearchParams();
  if (task) query.set("task", String(task));
  if (tree) query.set("tree", tree);
  if (project) query.set("project", project);
  if (assistantId) query.set("assistantId", assistantId);
  const url = new URL(`http://localhost${SPAWN_CHECK_PATH}${query.toString() ? `?${query}` : ""}`);
  out.handled = await handler({ method, headers: { "x-panel-token": token } }, {}, SPAWN_CHECK_PATH, url);
  return out;
}

// A live run standing in a tree, as the store holds one. The route reads the same record `jobs.create` refuses on,
// so this is the one place a job has to be minted without a gateway.
function standRun(p, { id, thread, tree }) {
  p.jobs.jobs.set(id, {
    id,
    thread,
    status: "running",
    cwd: tree,
    prompt: "a run standing in the tree",
    lines: [],
    origin: { kind: "assistant-spawn" },
  });
  return { id, thread, status: "running", cwd: tree };
}

test("a SPAWN with nothing against it answers ok, and nothing else", async (t) => {
  const p = fixture(t);
  const row = p.assistant.queueMutate("assistant-1", "add", { title: "write the docs" }).task;
  const out = await ask(p, { task: row.id, tree: p.free });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.reason, null);
  assert.equal(out.body.remedy, null);
  assert.deepEqual(out.body.checks, [], "an accepted SPAWN has no check to report");
  assert.equal(out.body.tree, p.free, "the answer echoes the tree the cut would use");
  assert.equal(out.body.project, "proj");
});

test("a parked row is refused before the line, and the remedy is the queue action that unparks it", async (t) => {
  const p = fixture(t);
  const row = p.assistant.queueMutate("assistant-1", "add", { title: "carry the deploy" }).task;
  p.assistant.queueMutate("assistant-1", "state", { id: row.id, state: "parked", reason: "waiting on the deploy" });
  const out = await ask(p, { task: row.id });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.checks[0].code, "task-parked");
  assert.match(out.body.reason, /task #\d+ is parked \(waiting on the deploy\)/);
  assert.match(out.body.remedy, /queue action state queued with a reason/, "the fix is named");
  // The cut says the same thing: the route's reason and remedy are one sentence of the refusal it throws.
  assert.equal(`${out.body.reason}. ${out.body.remedy}.`, p.assistant.spawnTaskRefusal("assistant-1", row.id));
});

test("a row whose run is still live is refused, and the remedy names the job and thread to wait for", async (t) => {
  const p = fixture(t);
  const row = p.assistant.queueMutate("assistant-1", "add", { title: "carry the docs", thread: "t-docs" }).task;
  p.assistant.queueMutate("assistant-1", "state", { id: row.id, state: "running" });
  standRun(p, { id: "job-4242", thread: "t-docs", tree: p.held });
  const out = await ask(p, { task: row.id });
  assert.equal(out.body.ok, false);
  assert.equal(out.body.checks[0].code, "task-live");
  assert.match(out.body.reason, /already has a live run \(job job-4242 on thread t-docs, running\)/);
  assert.match(out.body.remedy, /wait for job job-4242 on thread t-docs to end, or steer it/);
});

test("a tree a live run holds is refused, naming the holder and the free tree", async (t) => {
  const p = fixture(t);
  standRun(p, { id: "job-5962", thread: "t-hold", tree: p.held });
  const out = await ask(p, { tree: p.held });
  assert.equal(out.body.ok, false);
  assert.equal(out.body.checks[0].code, "tree_busy");
  assert.match(out.body.reason, /already has a live run \(job-5962 on thread t-hold, running\)/);
  assert.match(out.body.remedy, /wait for job job-5962 on thread t-hold to end, steer it, or name a free tree/);
  // The SAME words the cut refuses with: lib/jobs.js builds its 409 from this module, so this comparison is the
  // proof that the route cannot answer differently from the cut.
  await assert.rejects(
    () => p.jobs.create({ prompt: "a second worker in a held tree", thread: "t-second", existing: true, cwd: p.held }),
    (err) => {
      assert.equal(err.code, "tree_busy");
      assert.equal(err.message, `${out.body.reason}. ${out.body.remedy}.`);
      return true;
    },
  );
});

test("a tree that still holds unlanded commits is reported, with the branch and the count, and is not a refusal", async (t) => {
  const p = fixture(t);
  // The scanned row the board would hold for a tree whose branch carries two commits main does not have.
  p.rows.push({ path: p.held, branch: "wtgui/land-the-review-chip-lane-58597e", ahead: 2, dirty: 0, untracked: 0, project: "proj", verdict: "UNMERGED (2 commits)" });
  const out = await ask(p, { tree: p.held });
  assert.equal(out.body.ok, true, "the cut allows a SPAWN into a tree with unlanded work - the reuse rule may even pick it");
  assert.equal(out.body.checks[0].code, "tree-unlanded");
  assert.match(out.body.reason, /still holds work of its own: its branch wtgui\/land-the-review-chip-lane-58597e carries 2 unlanded commits that main does not have/);
  assert.match(out.body.remedy, /land wtgui\/land-the-review-chip-lane-58597e first, or name a free tree/);
});

test("a tree the board reads MERGED is not reported as holding work, but is warned by name as a landed tree", async (t) => {
  const p = fixture(t);
  p.rows.push({ path: p.held, branch: "wtgui/landed", ahead: 3, dirty: 0, untracked: 0, project: "proj", verdict: "MERGED (3 commits)" });
  const out = await ask(p, { tree: p.held });
  assert.equal(out.body.ok, true, "no queue row is carried, so this is a warning rather than a refusal");
  const codes = out.body.checks.map((c) => c.code);
  assert.equal(codes.includes("tree-unlanded"), false, "a landed branch is a tree to sweep, not a tree holding work");
  assert.deepEqual(codes, ["tree_landed"], "and it is warned by name: an unrelated new row must not be cut here");
  assert.match(out.body.reason, /is already finished \(MERGED \(3 commits\), branch wtgui\/landed, 3 commits ahead of main\)/);
  assert.match(out.body.reason, /inherit that tree's initiative attachment, which it never earned/);
});

test("a done row and a row in another assistant's queue are refused with their own fix", async (t) => {
  const p = fixture(t);
  const done = p.assistant.queueMutate("assistant-1", "add", { title: "the finished one" }).task;
  p.assistant.queueMutate("assistant-1", "state", { id: done.id, state: "done", by: "assistant" });
  const first = await ask(p, { task: done.id });
  assert.equal(first.body.checks[0].code, "task-done");
  assert.match(first.body.remedy, /requeue it first \(queue action state queued with a reason\)/);

  const other = { id: "assistant-2", name: "Assistant 2" };
  p.assistant.assistants.push(other);
  writeQueueFile(p.assistant.queuePathOf(other), [{ id: 613, title: "assistant 2's own row", state: "queued", files: [] }]);
  const foreign = await ask(p, { task: 613 });
  assert.equal(foreign.body.ok, false, "ids are per queue: #613 is not Assistant #1's row");
  assert.equal(foreign.body.checks[0].code, "task-foreign");
  assert.match(foreign.body.reason, /task #613 is in Assistant 2's queue, not Assistant #1's/);
  assert.match(foreign.body.remedy, /write the SPAWN on Assistant 2's thread/);
});

test("the route is read only: it writes nothing, starts nothing and changes no state", async (t) => {
  const p = fixture(t);
  const row = p.assistant.queueMutate("assistant-1", "add", { title: "carry the docs" }).task;
  p.assistant.queueMutate("assistant-1", "state", { id: row.id, state: "parked", reason: "waiting" });
  standRun(p, { id: "job-1", thread: "t-1", tree: p.held });
  const file = p.assistant.queuePathOf(p.assistant.assistantRecord("assistant-1"));
  const before = readFileSync(file, "utf8");
  const jobsBefore = [...p.jobs.jobs.keys()].sort();
  const out = await ask(p, { task: row.id, tree: p.held });
  assert.equal(out.body.ok, false);
  assert.equal(readFileSync(file, "utf8"), before, "the queue file is byte-identical");
  assert.deepEqual([...p.jobs.jobs.keys()].sort(), jobsBefore, "no job was created");
  assert.equal([...p.jobs.jobs.values()].filter((j) => String(j.origin?.kind || "").includes("spawn-check")).length, 0);
  assert.equal(readQueueFile(file).tasks.find((x) => x.id === row.id).state, "parked", "the row is still parked");
});

test("the wire refuses a call that names neither a row nor a tree, and a task that is not a number", async (t) => {
  const p = fixture(t);
  const bare = await ask(p, {});
  assert.equal(bare.status, 400);
  assert.equal(bare.body.ok, false);
  assert.match(bare.body.error, /pass task=<id>, tree=<path>, or both/);
  const bad = await ask(p, { task: "row-184" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /task is a queue row id \(a whole number/);
  const denied = await ask(p, { task: "1", token: "wrong" });
  assert.equal(denied.status, 403);
});

test("a project or a tree the cut would not resolve is answered as a refusal with a fix", async (t) => {
  const p = fixture(t);
  const unknown = await ask(p, { task: "1", project: "no-such-project" });
  assert.equal(unknown.body.ok, false);
  assert.match(unknown.body.reason, /unknown project: no-such-project/);
  assert.match(unknown.body.remedy, /name a project the panel has/);
  const gone = await ask(p, { tree: path.join(p.dir, "deleted-tree"), project: "proj" });
  assert.equal(gone.body.ok, false);
  assert.match(gone.body.reason, /does not exist or is not a directory/);
  assert.match(gone.body.remedy, /write SPAWN without IN to cut a new tree/);
});
