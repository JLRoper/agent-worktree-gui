// The panel's child supervisor: a helper is tracked from the moment it starts, carries a hard ceiling for its
// kind, and dies WITH ITS TREE at the deadline, when its scope settles, and on shutdown.
//
// The leak this pins is not hypothetical. `execFile`'s own timeout kills the process it holds and nothing else,
// so a `git push` whose pre-push hook runs `node tools/land.mjs --check` (minutes of rendering) left that node
// running after the push was abandoned: 50 minutes of one core, no owner, nothing in the panel that named it.
// A worker thread is worse: terminating the thread stops its JS and leaves the git it spawned alive.
//
// So every test here spawns a REAL sleeper through the registry and asks the OS whether it is still there. The
// sleeper starts a child of its own and writes that pid to a file, which is what makes "the TREE died" a fact
// rather than "the process I killed exited".
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ChildTree, HELPER_LIMITS, killTree, kindOf, pidAlive, scopeForJob } from "../lib/child-tree.js";
import { Jobs } from "../lib/jobs.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A sleeper that also starts a child of its own. It writes the GRANDCHILD's pid to `pidFile` and then does
// nothing for ten minutes, which is the shape of the leaked checks: alive, idle, unowned.
const SLEEPER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const kid = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", windowsHide: true });
fs.writeFileSync(process.argv[1], String(kid.pid));
setTimeout(() => {}, 600000);
`;

async function waitFor(fn, { timeoutMs = 10_000, stepMs = 100, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(stepMs);
  }
}

// One tracked sleeper, and the pids that prove the tree (not only the process we hold).
function sleeper(tree, scope, dir, opts = {}) {
  const pidFile = path.join(dir, `kid-${Math.random().toString(16).slice(2)}.pid`);
  const started = tree.exec(scope, process.execPath, ["-e", SLEEPER, pidFile], { kind: "helper", timeoutMs: 60_000, ...opts });
  // A rejection is expected in the kill tests; keep it from becoming an unhandled rejection before it is read.
  started.catch(() => {});
  return { pidFile, started };
}

async function pidsOf(pidFile) {
  await waitFor(() => existsSync(pidFile), { what: `the sleeper to write ${path.basename(pidFile)}` });
  const kid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(kid) && kid > 0, `the sleeper wrote a pid, got ${JSON.stringify(readFileSync(pidFile, "utf8"))}`);
  return kid;
}

const gone = (pid) => waitFor(() => !pidAlive(pid), { timeoutMs: 10_000, what: `pid ${pid} to be gone` });

test("the kind decides the ceiling, and a git push is the hook kind even through -C", () => {
  assert.equal(kindOf("git", ["-C", "tree", "push", "origin", "HEAD"]), "hook");
  assert.equal(kindOf("git", ["-C", "tree", "status", "--porcelain"]), "git");
  assert.equal(kindOf("git", ["--no-pager", "-C", "tree", "rev-parse", "HEAD"]), "git");
  assert.equal(kindOf("gh", ["pr", "view", "12"]), "gh");
  assert.equal(kindOf(process.execPath, ["-e", "1"]), "helper");
  // A caller may ask for LESS than its kind allows and never for more: that is what "hard" means.
  const tree = new ChildTree();
  assert.equal(tree.limitFor("git", 5_000), 5_000);
  assert.equal(tree.limitFor("git", 10 * 60_000), HELPER_LIMITS.git);
  assert.equal(tree.limitFor("hook", 10 * 60_000), HELPER_LIMITS.hook);
});

test("a helper that outlives its deadline is killed with its tree, and the call rejects", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-child-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = new ChildTree({ log: () => {} });
  const { pidFile, started } = sleeper(tree, scopeForJob("j-timeout"), dir, { timeoutMs: 2_500 });

  const kid = await pidsOf(pidFile);
  const [entry] = tree.list();
  assert.ok(entry, "the registry holds the helper while it runs");
  assert.ok(pidAlive(entry.pid), "the helper is a real process");
  assert.ok(pidAlive(kid), "and so is the child it started");

  const err = await started.then(
    () => assert.fail("a helper past its deadline must not resolve"),
    (e) => e,
  );
  assert.equal(err.timedOut, true, "the rejection says it was the deadline");
  assert.equal(err.killedTree, true, "and that the tree, not only the pid, was killed");
  assert.match(err.message, /timed out after \d+s/);
  await gone(entry.pid);
  await gone(kid);
  assert.equal(tree.size, 0, "the deadline releases its entry: a killed pid is not kept for a later signal");
  assert.equal(tree.stats().timedOut, 1);
});

test("a job's settle kills what its turn started, grandchild included", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-child-settle-"));
  const tree = new ChildTree({ log: () => {} });
  const jobs = new Jobs({
    config: { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: "http://127.0.0.1:9" } },
    children: tree,
    onLog: () => {},
  });
  t.after(() => {
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    clearInterval(jobs.approvalReconcile);
    clearTimeout(jobs.persistTimer);
    rmSync(dir, { recursive: true, force: true });
  });

  // A live card, as the settle path finds it, and the helper its turn left running.
  const j = {
    id: "j-settle",
    thread: "t-settle",
    status: "running",
    startedAt: new Date().toISOString(),
    cwd: null,
    lines: [],
  };
  jobs.jobs.set(j.id, j);
  const { pidFile, started } = sleeper(tree, scopeForJob(j.id), dir);
  const kid = await pidsOf(pidFile);
  const [entry] = tree.list();
  assert.ok(pidAlive(entry.pid) && pidAlive(kid), "the helper and its child are both alive before the settle");

  jobs.settle(j, "completed", { output: "done" });

  assert.equal(j.status, "done", "the card settled");
  await gone(entry.pid);
  await gone(kid);
  assert.equal(tree.size, 0, "the settle left no tracked helper behind");
  const err = await started.then(
    () => assert.fail("a killed helper's call must reject"),
    (e) => e,
  );
  assert.ok(err instanceof Error, "the call rejects when its tree is killed");
  assert.ok(!pidAlive(entry.pid) && !pidAlive(kid), "neither the helper nor its child survived the settle");
});

test("shutdown kills every scope, grandchild and adopted pid alike", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-child-shutdown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = new ChildTree({ log: () => {} });

  const a = sleeper(tree, scopeForJob("j-a"), dir);
  const kidA = await pidsOf(a.pidFile);
  const b = sleeper(tree, "scan:1", dir);
  const kidB = await pidsOf(b.pidFile);
  const entries = tree.list();
  assert.equal(entries.length, 2, "two scopes, two helpers");

  // A worker thread reports a pid it started and this thread never held a handle for. `adopt` is what puts
  // such a number on the panel's kill list.
  const adoptedFile = path.join(dir, "adopted.pid");
  const adoptedChild = (await import("node:child_process")).spawn(process.execPath, ["-e", SLEEPER, adoptedFile], { stdio: "ignore", windowsHide: true });
  const adoptedPid = adoptedChild.pid;
  await waitFor(() => existsSync(adoptedFile), { what: "the adopted sleeper to announce its child" });
  const adoptedKid = Number(readFileSync(adoptedFile, "utf8").trim());
  assert.ok(tree.adopt("scan:2", adoptedPid, { kind: "git", label: "the worker's git" }), "a pid reported by a worker is adopted");

  assert.ok(pidAlive(kidA) && pidAlive(kidB) && pidAlive(adoptedPid), "every process is real before the shutdown");
  const killed = await tree.killAll("test shutdown");

  assert.equal(killed, 3, "every live entry is killed");
  await gone(entries[0].pid);
  await gone(entries[1].pid);
  await gone(kidA);
  await gone(kidB);
  await gone(adoptedPid);
  await gone(adoptedKid);
  assert.equal(tree.size, 0, "the shutdown emptied the registry");

  // A child started after the close is killed rather than left running for a killAll that already happened.
  let latePid = null;
  const late = tree.exec(scopeForJob("j-late"), process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    kind: "helper",
    onSpawn: (pid) => {
      latePid = pid;
    },
  });
  late.catch(() => {});
  await waitFor(() => latePid !== null, { what: "the late child to be started" });
  await gone(latePid);
  assert.equal(tree.size, 0, "a child asked to start after the close is never registered");
});

// The kill path answers a pid that is already gone WITHOUT spawning anything. The "(already gone)" case was
// most of the kill traffic, and on this machine every spawn costs a filtered `CreateProcess` (~0.5-1.3 s)
// that used to block the panel's loop — so "cheap enough" is the property, and the how-string is the proof:
// a taskkill that ran and failed would answer "taskkill (already gone)", a skip answers "gone before the kill".
test("a pid that is already gone is answered without spawning a kill", async () => {
  const out = await killTree(999_999_999);
  assert.equal(out.ok, true);
  assert.equal(out.how, "gone before the kill");
});
