// Replacing the scan pool must not kill the panel.
//
// The first version of Settings → General called `pool.close()` when `threads` moved. On a live board that pool held
// 112 queued scans and three workers mid-scan, and the panel process died on the first save with no stack trace: the
// close terminated the workers, then walked each worker's reported children and signalled them by number through
// `taskkill /T /F` — including entries the registry had already released, which is a number the OS is free to hand
// to any process. One of those numbers was the panel's own.
//
// So this file pins the two halves of the fix:
//
//   1. a pid the registry no longer owns is NEVER signalled — the pool skips it and says so in its counter;
//   2. `retire()` refuses the queue, lets the scans in flight finish, and only then lets its threads go, while
//      `run()` on a retired pool rejects instead of queueing a promise nothing will ever settle.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { panelChildren, scopeForScan } from "../lib/child-tree.js";
import { Pool } from "../lib/pool.js";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a pid the registry no longer owns is never signalled", async (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  });
  const pid = child.pid;
  const scope = scopeForScan("retire-test");
  assert.ok(panelChildren.adopt(scope, pid, { kind: "helper", label: "retire-test" }), "the registry adopts it");
  assert.ok(panelChildren.release(pid), "and this is what a finished child does: the entry goes");

  const pool = new Pool(1);
  t.after(() => pool.close());
  const fakeWorker = { children: new Set([pid]), busy: false, pending: null };
  const killed = pool.killWorkerChildren(fakeWorker, "the pool retired");

  assert.equal(killed, 0, "nothing was killed: the registry no longer owns that number");
  assert.equal(pool.skipped, 1, "and the skip is counted rather than silent");
  assert.equal(fakeWorker.children.size, 0, "the stale entry is dropped from the worker's set");
  assert.ok(alive(pid), "the process behind the number is untouched");
});

test("retire refuses the queue, lets the running scan settle, then lets its threads go", async (t) => {
  const pool = new Pool(1);
  t.after(() => pool.close());
  assert.equal(pool.workers.length, 1, "one worker to start with");

  // A job queued behind nothing still gets a worker immediately, so the queue is primed with a second one.
  const first = pool.run({ wtPath: "C:/retire/a", depth: "fast" });
  const queued = pool.run({ wtPath: "C:/retire/b", depth: "fast" });
  await new Promise((r) => setTimeout(r, 50));

  pool.retire();
  assert.equal(pool.queued, 0, "the queue is refused, not silently kept (the next pass re-requests those rows)");
  await assert.rejects(pool.run({ wtPath: "C:/retire/c", depth: "fast" }), /retired/, "and no new work is accepted");
  // The two scans already handed to the pool settle one way or the other — a missing worktree is a row with an error
  // in it, not a rejection, so this asserts that neither promise is left hanging.
  await Promise.allSettled([first, queued]);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(pool.workers.length, 0, "the threads are gone once nothing is running");
  assert.equal(pool.closed, true);
});
