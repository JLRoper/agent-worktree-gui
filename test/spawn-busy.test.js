// One row, one worker; one tree, one worker — refused at the cut, and said out loud.
//
// Measured on this board: a SPAWN naming a row whose worker was still going cut a second tree for it, and a
// SPAWN IN naming a tree a live run already held started a second agent in it. Both times nothing said so: the
// digest lists live runs, but the cut never consulted that fact, so the only evidence afterwards was a tree that
// had moved under the first worker (three wasted runs in one night). The panel now refuses at the cut:
//
//   1. a SPAWN carrying a task id whose row already has a live job is refused, naming the holding thread;
//   2. a SPAWN into a tree that already holds a live job is refused, naming the holder;
//   3. both refusals are journalled once, and the digest the assistant reads carries them — so a turn can see
//      its own duplicate instead of inferring it from a board that did not move;
//   4. the single-dispatch path is unchanged: one spawn, one job, one row linked, no refusal.
//
// Driven against the REAL spawner (lib/features/spawn.js `assistantSpawnRun` -> `jobs.create`), the REAL job
// store and a stub gateway that counts what it was asked to start — so "refused" means the gateway was never
// asked, not merely that an error was thrown.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { Assistant, ASSISTANT_THREAD } from "../lib/assistant.js";
import { createSpawn } from "../lib/features/spawn.js";
import { readQueueFile } from "../lib/assistant/queue.js";

const slash = (p) => String(p).replace(/\\/g, "/");
const turn = (id, line) => ({ id, thread: ASSISTANT_THREAD, lines: [{ kind: "text", text: line, at: Date.now(), lid: Math.random() }] });

// ---- a stub gateway: it records every run it is asked to start, and never finishes one -------------------
// A live run is what these refusals are about, so the stub holds every run open until the test tears it down.
async function stubGateway() {
  const posts = [];
  const server = createServer((req, res) => {
    const url = String(req.url || "");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
      const json = (code, out) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      if (req.method === "GET" && url === "/v1/capabilities") {
        return json(200, {
          version: "stub",
          features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true },
        });
      }
      if (req.method === "POST" && url === "/v1/runs") {
        posts.push(body);
        return json(200, { run_id: `run_${posts.length}`, session_id: String(body.session_id || "") });
      }
      if (req.method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url)) {
        // A stream that opens and stays open: the run is live for as long as the test needs it to be.
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": open\n\n");
        req.on("close", () => res.end());
        return;
      }
      if (req.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(url)) return json(200, { status: "running", output: "" });
      if (req.method === "POST") return json(200, {});
      json(404, { error: { message: "no such route" } });
    });
  });
  await new Promise((open) => server.listen(0, "127.0.0.1", open));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    posts,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(done);
      }),
  };
}

function repo(dir, name) {
  const tree = slash(path.join(dir, name));
  mkdirSync(tree, { recursive: true });
  const email = ["tester", "example.invalid"].join(String.fromCharCode(64));
  const git = (...args) =>
    execFileSync("git", ["-C", tree, "-c", "user.name=Test", "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(tree, "README.md"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return tree;
}

// ---- the panel: a real store, a real assistant, the real spawner ---------------------------------------
async function panel(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-spawn-busy-"));
  const gw = await stubGateway();
  const tree = repo(dir, "busy-tree");
  const other = repo(dir, "free-tree");

  const assistant = { current: null };
  const config = { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: gw.url, key: "stub" }, defaultCwd: dir };
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  const spawn = createSpawn({ getConfig: () => config, getProjects: () => [], jobs });
  const a = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "assistant.json") },
    jobs,
    getProjects: () => [],
    getRows: () => [],
    getChildren: () => ({}),
    spawner: spawn.assistantSpawnRun,
    onEvent: () => {},
    onLog: () => {},
  });
  a.settings.spawn = "auto";
  a.settings.autonomy = "auto";
  assistant.current = a;

  t.after(async () => {
    // The runs are deliberately never settled, so every clock a live card owns has to be stopped by hand: the
    // follow loop's abort, the 15s poll interval, and the turn's own timers. Left alone, the stub's live run keeps
    // the file's process alive long after its last assertion.
    for (const j of jobs.jobs.values()) {
      j.ctrl?.abort();
      for (const timer of [j.timer, j.poller, j.textTimer, j.statsTimer]) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    }
    for (const timer of ["wakeTimer", "settleTimer", "timer", "persistTimer"]) if (a[timer]) clearTimeout(a[timer]);
    await gw.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const task = (title) => a.queueMutate("assistant-1", "add", { title }).task;
  const rowOf = (id) => readQueueFile(a.queuePathOf(a.assistantRecord("assistant-1"))).tasks.find((x) => x.id === id) || null;
  // The stub never finishes a run, but `create` returns before the first event; a card still `starting` is
  // live already. Pin it to `running` so "live" is not a race in the assertion below.
  const hold = (job) => {
    const rec = jobs.jobs.get(job.id);
    if (rec) rec.status = "running";
    return rec;
  };
  return { dir, gw, tree, other, jobs, assistant: a, task, rowOf, hold };
}

const spawns = (jobs) => [...jobs.jobs.values()].filter((j) => j.origin?.kind === "assistant-spawn");

test("a SPAWN naming a row whose worker is still live is refused, naming the holding thread", async (t) => {
  const p = await panel(t);
  const row = p.task("carry the docs task");

  const first = await p.assistant.startSpawn({ existing: true, target: p.tree, prompt: "write the docs", taskId: row.id }, { source: "assistant" });
  assert.ok(first?.id, "the first dispatch started a worker");
  p.hold(first);
  assert.equal(p.rowOf(row.id).state, "running", "the row was linked at the cut");
  assert.equal(p.rowOf(row.id).thread, first.thread);
  const asked = p.gw.posts.length;

  await assert.rejects(
    () => p.assistant.startSpawn({ existing: true, target: p.tree, prompt: "write the docs again", taskId: row.id }, { source: "assistant" }),
    (e) => {
      assert.equal(e.code, "spawn-task");
      assert.match(e.message, /already has a live run/);
      assert.ok(e.message.includes(first.thread), `the refusal names the holding thread: ${e.message}`);
      assert.match(e.message, new RegExp(`task #${row.id}`));
      return true;
    },
  );

  assert.equal(p.gw.posts.length, asked, "the gateway was never asked for a second run");
  assert.equal(spawns(p.jobs).length, 1, "one row, one job");
  assert.equal(p.rowOf(row.id).thread, first.thread, "the row still names the thread that holds it");

  const refused = p.assistant.journal.filter((e) => e.kind === "spawn-refused");
  assert.equal(refused.length, 1, "the refusal is journaled once");
  assert.ok(refused[0].text.includes(first.thread), `…naming the holder: ${refused[0].text}`);
  assert.match(p.assistant.digest(), /SPAWN LINES THE PANEL REFUSED/);
});

test("a SPAWN into a tree that already holds a live job is refused, naming the holder", async (t) => {
  const p = await panel(t);
  const first = await p.assistant.startSpawn({ existing: true, target: p.tree, prompt: "hold this tree" }, { source: "assistant" });
  assert.ok(first?.id);
  p.hold(first);
  const asked = p.gw.posts.length;

  await assert.rejects(
    () => p.assistant.startSpawn({ existing: true, target: p.tree, prompt: "a second worker in the same tree" }, { source: "assistant" }),
    (e) => {
      assert.equal(e.code, "tree_busy");
      assert.match(e.message, /already has a live run/);
      assert.ok(e.message.includes(first.thread), `the refusal names the holding thread: ${e.message}`);
      assert.ok(e.message.includes(slash(p.tree)), "…and the tree");
      return true;
    },
  );

  assert.equal(p.gw.posts.length, asked, "nothing was posted for the refused spawn");
  assert.equal(spawns(p.jobs).length, 1, "one tree, one job");

  const refused = p.assistant.journal.filter((e) => e.kind === "spawn-refused");
  assert.equal(refused.length, 1, "one refusal, one journal line");
  assert.equal(refused[0].thread, first.thread, "…attributed to the thread that holds the tree");
  assert.match(refused[0].text, /nothing was cut/);
  assert.match(p.assistant.digest(), /the row or the tree is still held/);
});

test("the same refusal through the harvest is one line, not a refusal plus a generic failure", async (t) => {
  const p = await panel(t);
  const first = await p.assistant.startSpawn({ existing: true, target: p.tree, prompt: "hold this tree" }, { source: "assistant" });
  p.hold(first);

  await p.assistant.harvest(turn("turn-duplicate", `SPAWN IN ${p.tree} | start a second worker here`));

  assert.equal(spawns(p.jobs).length, 1, "the line was not carried out");
  const refused = p.assistant.journal.filter((e) => e.kind === "spawn-refused");
  const failed = p.assistant.journal.filter((e) => e.kind === "spawn-failed");
  assert.equal(refused.length, 1, "the refusal is written once");
  assert.equal(failed.length, 0, "and not repeated as a generic spawn failure");
  assert.ok(refused[0].text.includes(first.thread), `naming the holder: ${refused[0].text}`);
});

test("the single-dispatch path is unchanged, and a different tree is still free", async (t) => {
  const p = await panel(t);
  const row = p.task("one row, one worker");
  const job = await p.assistant.startSpawn({ existing: true, target: p.tree, prompt: "do the one job", taskId: row.id }, { source: "assistant" });
  p.hold(job);

  assert.equal(spawns(p.jobs).length, 1, "one dispatch, one job");
  assert.equal(p.gw.posts.length, 1, "one POST");
  const linked = p.rowOf(row.id);
  assert.equal(linked.state, "running");
  assert.equal(linked.thread, job.thread);
  assert.equal(linked.worktree, slash(p.tree));
  assert.equal(p.assistant.journal.filter((e) => e.kind === "spawn-refused").length, 0, "nothing was refused");

  // A tree of its own is not held by the job in another: the guard is a tree question, not a fleet-wide one.
  const second = await p.assistant.startSpawn({ existing: true, target: p.other, prompt: "work in the other tree" }, { source: "assistant" });
  p.hold(second);
  assert.equal(p.gw.posts.length, 2);
  assert.equal(spawns(p.jobs).length, 2);
});
