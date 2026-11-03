// A steer carries its tree's TODO list — a worker told to change course is handed the list as it stands, with its
// ids, plus the standing instruction to reconcile it against its own commits. That is only true for a run whose
// directory is a TREE. `todoTailFor` resolved the tree as `worktreePath || ownerPath || cwd` and appended the block
// whenever `todoBlockText` could produce one, so the assistant's OWN thread was handed a worktree's list for
// `state/assistant-cwd` (lib/paths.js STATE_DIR_NAMES): empty, no `.git`, and no branch for `git log <base>..HEAD`
// to exist on. A released or evicted tree leaves the same shape — a directory that still exists with no `.git` in
// it — and got the same paragraph.
//
// The answers: a state directory by NAME gets no tail, a directory that is not a tree gets no tail, and a real tree
// still gets the block with its ids — the seed-needed form included when its list is empty. The last test drives
// `steer()` itself, because the steer body the gateway receives is where the bug was read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { TodoLists } from "../lib/todos.js";
import { git } from "../tools/panel-testkit.mjs";

const slash = (p) => String(p || "").replace(/\\/g, "/");

// A real tree, cut the way the panel cuts one: a `.git` of its own.
function makeTree(root, rel) {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  return dir;
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "wag-todo-tail-"));
  // The assistant's own working directory: the shape lib/paths.js names as STATE, not a worktree.
  const stateDir = path.join(root, "state", "assistant-cwd");
  mkdirSync(stateDir, { recursive: true });
  // What a released/evicted tree leaves behind: the folder is still there, holds files, has no `.git`.
  const husk = path.join(root, "repo", ".worktrees", "gone-cccccc");
  mkdirSync(husk, { recursive: true });
  writeFileSync(path.join(husk, "README.md"), "what a released tree leaves behind\n");
  // …and one that is a tree.
  const tree = makeTree(root, "repo/.worktrees/proof-bbbbbb");
  const lists = new TodoLists({
    file: path.join(root, "todos.json"),
    trees: () => [{ project: "p", path: tree, branch: "wtgui/proof-bbbbbb" }],
  });
  const jobs = new Jobs({ config: { jobsFile: path.join(root, "jobs.json") }, onLog: () => {} });
  jobs.todos = lists;
  return { root, stateDir, husk, tree, lists, jobs, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a run whose cwd is a state directory by name gets no TODO tail", (t) => {
  const f = fixture();
  t.after(f.done);
  const run = { id: "assistant", cwd: f.stateDir, worktreePath: null, ownerPath: null };
  assert.equal(f.jobs.todoTailFor(run), "", "the assistant's own directory is not a worktree");
  // The NAME decides, before any disk question: a state folder that happens to hold a `.git` is still not a tree a
  // run may be told to reconcile against.
  mkdirSync(path.join(f.stateDir, ".git"), { recursive: true });
  assert.equal(f.jobs.todoTailFor(run), "", "a stray .git does not turn a state directory into a worktree");
});

test("a run whose tree has no .git gets no TODO tail", (t) => {
  const f = fixture();
  t.after(f.done);
  assert.equal(f.jobs.todoTailFor({ id: "husk", cwd: f.husk }), "", "a released tree is a directory, not a worktree");
  assert.equal(f.jobs.todoTailFor({ id: "gone", cwd: path.join(f.root, "nowhere") }), "", "a directory that is gone has no list either");
});

test("a run in a real worktree still gets the block with its todo ids", (t) => {
  const f = fixture();
  t.after(f.done);
  const made = f.lists.seed({ project: "p", path: f.tree, texts: ["read the brief", "land the change"], by: "assistant" });
  assert.deepEqual(made.map((i) => i.id), [1, 2]);
  const tail = f.jobs.todoTailFor({ id: "worker", worktreePath: f.tree, ownerPath: f.tree, cwd: f.tree });
  assert.ok(
    tail.startsWith(`\n\n---\n\nTODO — the list for this worktree (${slash(f.tree)})`),
    `the block rides under the steer's own rule, naming the tree:\n${tail}`,
  );
  assert.match(tail, /1\. \[todo\s*\] read the brief/, "the list is handed over WITH the ids an agent marks done");
  assert.match(tail, /2\. \[todo\s*\] land the change/);
  assert.match(tail, /TODO DONE <id>/);
});

test("a real tree with an empty list still gets the seed-needed form", (t) => {
  const f = fixture();
  t.after(f.done);
  const tail = f.jobs.todoTailFor({ id: "fresh", cwd: f.tree });
  assert.notEqual(tail, "", "a tree with nothing written down still has to be told so");
  assert.match(tail, /nothing has been written down for this tree yet/);
  assert.match(tail, /TODO ADD <text>/);
  assert.match(tail, /reconcile this list against what you actually committed/i);
});

// The reported symptom at the transport: the steer body the gateway receives.
function steerStub() {
  const steers = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      if (/^\/v1\/runs\/[^/]+\/steer$/.test(new URL(req.url, "http://127.0.0.1").pathname)) steers.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "hermes.run.steer", accepted: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        steers,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      }),
    );
  });
}

test("a steer into a state directory is the typed text alone, and one into a tree still carries the list", async (t) => {
  const f = fixture();
  const stub = await steerStub();
  const jobs = new Jobs({
    config: { jobsFile: path.join(f.root, "steer-jobs.json"), apiServer: { url: stub.url, key: "sandbox-key" } },
    onLog: () => {},
  });
  jobs.todos = f.lists;
  t.after(async () => {
    await stub.close();
    f.done();
  });
  const seed = (id, over) => jobs.jobs.set(id, { id, thread: `th-${id}`, turn: 1, status: "running", lines: [], ...over });
  seed("assistant", { runId: "run_assistant", cwd: f.stateDir });
  seed("worker", { runId: "run_worker", cwd: f.tree, worktreePath: f.tree, ownerPath: f.tree });
  f.lists.seed({ project: "p", path: f.tree, texts: ["keep it current"], by: "assistant" });

  assert.equal((await jobs.steer("assistant", "carry on")).ok, true);
  assert.equal(stub.steers.at(-1).input, "carry on", "no TODO block rides a steer into a state directory");

  assert.equal((await jobs.steer("worker", "keep going")).ok, true);
  const carried = stub.steers.at(-1).input;
  assert.ok(carried.startsWith("keep going\n\n---\n\nTODO — the list for this worktree"), carried);
  assert.match(carried, /1\. \[todo\s*\] keep it current/);
});
