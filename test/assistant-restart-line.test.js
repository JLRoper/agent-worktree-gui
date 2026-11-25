// A RESTART panel line queues with nothing to wait for.
//
//   node --test test/assistant-restart-line.test.js
//
// The line is written by a turn on the assistant's own thread, and the value handed to the controller used to be
// `waitFor: job.thread` - the assistant's thread, which never goes quiet because its sweeps are jobs on it. The
// entry went to `waiting` and stayed there for the life of the panel, so a RESTART the assistant asked for simply
// never happened. The turn end is the boundary: the harvest runs after the reply is read, so the entry starts
// then. A live job on that very thread is planted below, and the entry still runs - which is the proof that the
// wait is gone rather than merely unused.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { RestartController } from "../lib/restart.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a RESTART panel line from a turn queues with thread null and runs as the turn ends", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-restart-line-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "hermes");
  mkdirSync(home, { recursive: true });
  // The provider preflight wants a key NAME with a value; the value is a placeholder on purpose.
  writeFileSync(path.join(home, ".env"), "OPENROUTER_API_KEY=sandbox-placeholder-not-a-real-key\n", "utf8");

  const thread = "panel-assistant";
  // The assistant's own thread has a live job on it: before this change that job is what the entry waited for,
  // and it is the reason the restart never ran.
  const jobs = {
    jobs: [{ id: "sweep-1", thread, status: "running" }],
    list() {
      return this.jobs;
    },
    runningJobs() {
      return this.jobs.filter((j) => j.status === "running");
    },
    firstOfThread: () => null,
    create: async () => ({ id: "unused" }),
  };

  const exits = [];
  const states = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json"), defaultCwd: dir },
    jobs,
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  t.after(() => {
    for (const timer of [assistant.persistTimer, assistant.wakeTimer, assistant.timer, assistant.settleTimer]) clearTimeout(timer);
  });

  const controller = new RestartController({
    config: { restartFile: path.join(dir, "restart.json"), pythonBin: "node" },
    jobs,
    assistant: null,
    home,
    log: () => {},
    credentials: () => ({ url: "http://127.0.0.1:1", key: "k" }),
    // The panel path with a stub replacement: nothing here bounces the gateway or exits this process.
    spawnPanel: () => ({ command: "stub panel replacement", pid: 5150, at: new Date().toISOString() }),
    shutdown: (code) => exits.push(code),
    pollMs: 20,
    version: "1.0.0",
    packageVersion: () => "1.0.1",
    onState: (state) => states.push(state),
  });

  const seen = [];
  const records = [];
  assistant.onRestart = (spec) => {
    seen.push(spec);
    const rec = controller.request(spec);
    records.push(rec);
    return rec;
  };

  const reason = "the port edge is in this tree and the panel in front of the reader is the old one";
  await assistant.harvest({
    id: "turn-restart",
    thread,
    assistantId: "assistant-1",
    status: "done",
    prompt: "",
    startedAt: new Date().toISOString(),
    lines: [{ kind: "text", text: `RESTART panel | ${reason}` }],
  });

  assert.equal(seen.length, 1, "the RESTART line was read and carried");
  assert.equal("waitFor" in seen[0], false, "no thread is handed to the controller - the turn end is the boundary");
  assert.equal(records[0]?.waitingFor, null, "so the entry has nothing to wait for");
  assert.equal(records[0]?.reason, reason, "and the reason the turn wrote rides into the queue");
  assert.ok(assistant.journal.some((j) => j.kind === "restart-queued"), "the queue is journalled on the turn");

  await sleep(300);
  assert.deepEqual(exits, [0], "the restart ran while a job on the assistant's own thread was still live");
  const waited = states.some((s) => (s.queued || []).some((e) => e.id === records[0].id && e.state === "waiting"));
  assert.equal(waited, false, "an entry the assistant asked for never reads 'waiting'");
});
