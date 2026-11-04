// The two ways a queued restart used to refuse or stall the reader who asked for it.
//
//   node --test test/restart.test.js
//
// DEFECT 1 — the refusal read the reader's PROSE.
//   `request()` scanned the reason for a version number and refused with 409 when it matched the one this process
//   serves. So `RESTART panel | serve 0.67.0 to pick up the approvals dock` was refused for SAYING the running
//   version, even on a checkout whose package.json had moved on — the legitimate bounce. The fact that makes a
//   restart a bounce for nothing is the two numbers: the version the checkout's package.json names, and the version
//   the running process serves. A reason is not evidence of either.
//
// DEFECT 2 — the default wait was the assistant's own thread.
//   `thread: waitFor || ASSISTANT_THREAD`, and the loop ran while `livesOn(entry.thread)` found a live job. The
//   assistant's sweeps are jobs on that thread, so an entry that named nothing sat in `waiting` for the life of the
//   panel. The wait is OPT-IN now: only a request that passes `waitFor` holds the restart back.
//
// WHAT IS DRIVEN: the real RestartController, a fake job store (only `list`/`runningJobs`, which is all the wait
// reads) and the PANEL path with a stub replacement plus a recorded `shutdown` — so a request that runs here never
// touches a gateway and never exits this process. The version the checkout carries is injected (`packageVersion`),
// so no test depends on this repo's own package.json number.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ASSISTANT_THREAD } from "../lib/assistant.js";
import { RestartController } from "../lib/restart.js";

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-restart-gate-"));
const home = path.join(dir, "hermes");
mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, ".env"), "OPENROUTER_API_KEY=test-key\n", "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

// Only what the controller's wait and the panel path read: a list of jobs with threads and statuses.
const fakeJobs = (jobs = []) => {
  const store = { jobs, list: () => store.jobs, runningJobs: () => store.jobs.filter((j) => j.status === "running") };
  return store;
};

// A failing assertion must not leave a wait loop polling: a queued entry holds a timer of its own and node --test
// never exits while one is alive. Cancel whatever is still queued as the test ends, passed or failed.
const drain = (controller) => {
  for (const e of controller.state().queued) {
    try {
      controller.cancel(e.id);
    } catch {
      /* already running or done */
    }
  }
};

const makeController = (over = {}) => {
  const exits = [];
  const states = [];
  const controller = new RestartController({
    config: { restartFile: path.join(dir, `restart-${++seq}.json`), pythonBin: "node" },
    jobs: over.jobs || fakeJobs(),
    assistant: null,
    home,
    log: () => {},
    credentials: () => ({ url: "http://127.0.0.1:1", key: "k" }),
    // The panel path, so an entry that runs executes here: the replacement is a stub, and shutdown records the exit
    // instead of taking this process with it. Nothing here can bounce a gateway or a panel.
    spawnPanel: () => ({ command: "stub panel replacement", pid: 5150, at: new Date().toISOString() }),
    shutdown: (code) => exits.push(code),
    pollMs: 20,
    onState: (state) => states.push(state),
    ...over,
  });
  return { controller, exits, states };
};

test("a reason that names the version this panel already serves still queues", async (t) => {
  // The checkout carries 0.105.0; this process serves 0.104.0. The reason says "0.104.0" out loud, which used to be
  // the refusal — and is now the words of a request that has a real bounce to do.
  const { controller } = makeController({
    version: "0.104.0",
    packageVersion: () => "0.105.0",
    jobs: fakeJobs([{ thread: "held", status: "running" }]),
  });
  t.after(() => drain(controller));
  const rec = controller.request({ target: "panel", reason: "serve 0.104.0 to pick up the approvals dock", waitFor: "held" });
  assert.equal(rec.accepted, true, "the request is accepted");
  assert.equal(rec.reason, "serve 0.104.0 to pick up the approvals dock", "the reason is kept as written");
  assert.equal(controller.state().queued.length, 1, "and it is queued, not refused");
  assert.ok(controller.state().journal.some((j) => /panel restart queued/.test(j.text)), "the queue is journalled");
  controller.cancel(rec.id);
});

test("a request with no waitFor does not wait on the assistant thread", async (t) => {
  // Exactly the measured shape: a live job on ASSISTANT_THREAD (the assistant's own sweep) and a request that named
  // no thread. Before the fix the entry went to `waiting` and stayed there; the panel died with it still queued.
  const { controller, exits, states } = makeController({
    version: "0.104.0",
    packageVersion: () => "0.105.0",
    jobs: fakeJobs([{ thread: ASSISTANT_THREAD, status: "running" }]),
  });
  t.after(() => drain(controller));
  const rec = controller.request({ target: "panel", reason: "pick up the new build" });
  assert.equal(rec.accepted, true);
  assert.equal(rec.waitingFor, null, "nothing was named, so nothing is waited for");
  assert.equal(controller.state().queued[0].waitFor, null, "and the status says so");
  await sleep(300);
  assert.deepEqual(exits, [0], "the restart ran while the assistant's own job was still live");
  const waited = states.some((s) => (s.queued || []).some((e) => e.id === rec.id && e.state === "waiting"));
  assert.equal(waited, false, "an entry with nothing to wait for never reads 'waiting'");
});

test("the wait is opt-in: a request that names a thread still waits for it", async (t) => {
  // The other half of the rule. A caller that DOES have a turn to protect passes `waitFor`, and the hold is unchanged.
  const jobs = fakeJobs([{ thread: "held", status: "running" }]);
  const { controller, exits } = makeController({ version: "0.104.0", packageVersion: () => "0.105.0", jobs });
  t.after(() => drain(controller));
  const rec = controller.request({ target: "panel", reason: "wait for the worker's turn", waitFor: "held" });
  await sleep(150);
  assert.deepEqual(exits, [], "the restart holds while the named thread has a turn");
  assert.equal(controller.state().queued[0].state, "waiting");
  jobs.jobs[0].status = "completed";
  await sleep(300);
  assert.deepEqual(exits, [0], "and runs once that turn ends");
});

test("a restart that genuinely changes nothing is still refused, by the version the checkout names", async (t) => {
  // package.json names the version this process serves: the bounce would put the same build back, so it is refused
  // with the number that makes it pointless — never with a number the reader happened to type.
  const { controller, exits } = makeController({ version: "0.104.0", packageVersion: () => "0.104.0" });
  t.after(() => drain(controller));
  assert.throws(
    () => controller.request({ target: "panel", reason: "pick up whatever landed" }),
    (e) => e.status === 409 && /already serves/.test(e.message) && /"0\.104\.0"/.test(e.message) && /bounce it for nothing/.test(e.message),
  );
  assert.equal(controller.state().queued.length, 0, "a refused request leaves no wait behind");
  await sleep(150);
  assert.deepEqual(exits, [], "and it starts nothing");
});

test("the provider refusal still comes first, and a reason is still required", async (t) => {
  // The two refusals this change must not touch: no key in HERMES_HOME, and no reason in the request.
  const noKey = path.join(dir, "no-key");
  mkdirSync(noKey, { recursive: true });
  const { controller } = makeController({ home: noKey, version: "0.104.0", packageVersion: () => "0.105.0" });
  t.after(() => drain(controller));
  assert.throws(
    () => controller.request({ target: "panel", reason: "pick up the new build" }),
    (e) => e.status === 409 && /provider key/.test(e.message),
  );
  const keyed = makeController({ version: "0.104.0", packageVersion: () => "0.105.0" }).controller;
  assert.throws(() => keyed.request({ target: "panel" }), (e) => e.status === 400 && /reason/.test(e.message));
  assert.equal(keyed.state().queued.length, 0);
});
