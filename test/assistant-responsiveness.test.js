import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { writeQueueFile } from "../lib/assistant/queue.js";
import { panelChildren, SCOPE_PANEL } from "../lib/child-tree.js";
import { RoundNameIndex } from "../lib/round-name-index.js";
import { roundTreeKey } from "../lib/round-tree-names.js";
import { TreeFactsWorkers } from "../lib/tree-facts-workers.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const task = (id, title, tree = "C:/work/round") => ({
  id, title, state: "queued", pipelineRun: { round: { parentPath: tree }, trees: { S1: { path: `${tree}/stage`, position: 1, stageName: "Probe" } } },
});

test("real tree facts use supervised workers and leave timers runnable", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tree-facts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim();
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "test");
  const commit = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  writeFileSync(path.join(dir, "untracked.txt"), "test\n");
  const started = panelChildren.started;
  let fired = false;
  setTimeout(() => { fired = true; }, 0);
  const facts = await Assistant.prototype.treeFactsOf(dir);
  assert.equal(fired, true);
  assert.deepEqual(facts, { head: commit.slice(0, facts.head.length), commit, branch, dirty: 1 });
  assert.equal(panelChildren.started - started, 4, "each worker child was adopted by the panel supervisor");
  assert.equal(await Assistant.prototype.treeFactsOf(path.join(dir, "missing")), null);
});

test("timed-out workers keep their slot until exit and queued work is bounded", async () => {
  class StuckWorker extends EventEmitter {
    postMessage(message) { this.messages.push(message); }
    unref() {}
    constructor() { super(); this.messages = []; }
  }
  const workers = [];
  const pool = new TreeFactsWorkers({ concurrency: 1, queueMax: 1, timeoutMs: 20, createWorker: () => { const worker = new StuckWorker(); workers.push(worker); return worker; } });
  const first = pool.run("one").catch((error) => error.message);
  const second = pool.run("two").catch((error) => error.message);
  await assert.rejects(pool.run("three"), /queue full/);
  await delay(40);
  assert.match(await first, /timed out/);
  assert.match(await second, /timed out/);
  assert.deepEqual(workers[0].messages, [{ type: "cancel" }]);
  assert.equal(pool.active.size, 1);
  assert.equal(workers.length, 1);
  workers[0].emit("exit", 0);
  await delay(0);
  assert.equal(pool.active.size, 0);
  pool.close();
});

test("refused assembly cleanup is supervised, sequential and never deletes a branch after a failed removal", async (t) => {
  const original = panelChildren.exec;
  t.after(() => { panelChildren.exec = original; });
  const calls = [];
  const logs = [];
  let fail = false;
  panelChildren.exec = async (scope, bin, args, opts) => {
    calls.push({ scope, args, opts });
    await delay(40);
    if (fail) throw new Error("refused");
    return { stdout: "" };
  };
  let fired = false;
  setTimeout(() => { fired = true; }, 10);
  await Assistant.prototype.discardAssemblyTree.call({ onLog: (line) => logs.push(line) }, "C:/repo", { path: "C:/tree", branch: "wtgui/a" });
  assert.equal(fired, true);
  assert.deepEqual(calls.map((call) => call.args.slice(2)), [["worktree", "remove", "--force", "C:/tree"], ["branch", "-D", "wtgui/a"]]);
  assert.ok(calls.every((call) => call.scope === SCOPE_PANEL && call.opts.timeout === 60_000));
  calls.length = 0;
  fail = true;
  await Assistant.prototype.discardAssemblyTree.call({ onLog: (line) => logs.push(line) }, "C:/repo", { path: "C:/tree", branch: "wtgui/a" });
  assert.equal(calls.length, 1);
  assert.match(logs.at(-1), /could not be removed/);
});

test("round index primes, merges, invalidates writes and observes external edits without blocking timers", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "round-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, "a.json");
  const b = path.join(dir, "b.json");
  writeQueueFile(a, [task(1, "first")]);
  writeQueueFile(b, [task(2, "newest")]);
  let files = [a, b];
  let notifications = 0;
  const index = new RoundNameIndex({ files: () => files, onChange: () => { notifications += 1; } });
  let fired = false;
  setTimeout(() => { fired = true; }, 0);
  await index.refresh();
  assert.equal(fired, true);
  assert.equal(index.names().get(roundTreeKey("C:/work/round")).display, "newest");
  assert.equal(index.names().get(roundTreeKey("C:/work/round/stage")).display, "Stage 1: Probe");
  assert.ok(notifications > 0);

  // A stale read in flight cannot overwrite a local write, even when the worker captured old bytes.
  const pending = index.refresh();
  const written = writeQueueFile(b, [task(3, "local")]);
  index.write(b, written);
  assert.equal(index.names().get(roundTreeKey("C:/work/round")).display, "local");
  await pending;
  assert.equal(index.names().get(roundTreeKey("C:/work/round")).display, "local");

  writeQueueFile(b, [task(4, "external", "C:/work/other")]);
  await index.refresh();
  assert.equal(index.names().get(roundTreeKey("C:/work/round")).display, "first");
  assert.equal(index.names().get(roundTreeKey("C:/work/other")).display, "external");
  files = [a];
  index.syncRoster();
  assert.equal(index.names().has(roundTreeKey("C:/work/other")), false, "roster changes invalidate immediately");
  files = [a, b];
  index.syncRoster();
  rmSync(b);
  await index.refresh();
  assert.equal(index.names().has(roundTreeKey("C:/work/other")), false);
});
