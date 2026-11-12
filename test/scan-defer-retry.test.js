// A worktree whose BOOT read the scan queue refused must be retried on its backoff, not left branchless
// and "…" until its next staggered cadence.
//
// The live board showed it: GET /api/state for oauth2-multi served 33 worktrees, 17 of them with verdict
// "…", verdictStale true and sync "this tree is not on a branch right now (a detached HEAD, or it could not
// be read)", every one stamped at the boot second (16:00:29.562Z), while `git worktree list --porcelain`
// read 33 trees and 0 detached. Those 17 were read by hand through the panel's own /api/refresh/row in one
// call. So nothing was wrong with git or with the pool: the sweep simply kept skipping them.
//
// The shape the boot pass creates: `fullPassProject` asks for EVERY row at once (`Promise.all`), the bounded
// scan queue admits only `maxPerProject` per project and refuses the rest with SCAN_QUEUE_DEFERRED, and the
// refusal is turned into a 5 s backoff (`deferRow`). But `enqueueDue` had already stamped the row's claim
// (`lastFast = now`) before the pool answered, and its cadence check reads that stamp first: the 5 s backoff
// was ignored for a whole `midSeconds` cadence (90 s on the live panel), and because `dueAfter` staggers
// never-read rows from their own creation second, the batch then came due again in lockstep - two admitted
// per wave, the rest refused and pushed another cadence. 33 trees took the best part of an hour to stop
// reading as branchless, and a turnover tree looked dropped off the chart in the meantime.
//
// WHAT IS DRIVEN: the real Store, the real Scheduler (its constructor, enqueueDue, deferRow, dueAfter,
// scanRow's refusal path) and a pool that copies the live admission rules - 2 workers, `maxPerProject` 2.
// No git, no worker threads: `scanOne` is the seam, and it resolves the way a real scan does by writing the
// row it read. Nothing here touches a repository, a port or a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../lib/store.js";
import { Scheduler } from "../lib/scheduler.js";

const PROJECT = { name: "proj", path: "sandbox/x", mainBranch: "main", remote: "", tier: "recent" };
const TREES = 6;
const MAX_PER_PROJECT = 2;
const SETTLE_MS = 5;

function harness() {
  const store = new Store();
  store.ensureProject(PROJECT);
  const paths = Array.from({ length: TREES }, (_, i) => `sandbox/x/.worktrees/tree-${i}`);
  // What reconcile writes for a tree git lists and the store does not know: path, name, verdict "…".
  for (const p of paths) store.putRow(PROJECT.name, { path: p, name: p.split("/").pop(), verdict: "…" }, "fast", { force: true });

  const refused = [];
  const pool = {
    pending: 0,
    active: new Set(),
    isBusy(p) {
      return this.active.has(p);
    },
    canEnqueue() {
      return this.pending < MAX_PER_PROJECT;
    },
    roomFor() {
      return Math.max(0, MAX_PER_PROJECT - this.pending);
    },
    async run(task) {
      if (this.pending >= MAX_PER_PROJECT) {
        refused.push(task.wtPath);
        const e = new Error("scan deferred (project-coalesced) — the row is re-read on the next pass");
        e.code = "SCAN_QUEUE_DEFERRED";
        throw e;
      }
      this.pending += 1;
      this.active.add(task.wtPath);
      try {
        await new Promise((r) => setTimeout(r, 0));
        return { path: task.wtPath };
      } finally {
        this.pending -= 1;
        this.active.delete(task.wtPath);
      }
    },
  };

  const s = new Scheduler({ config: { projects: [PROJECT] }, store, pool, getProjects: () => [PROJECT] });
  Object.assign(s.cfg, { midSeconds: 90, worktreeSeconds: 30, dormantSeconds: 180, scanDeferRetryMs: 5000 });
  let clock = Date.now();
  const reads = [];
  s.scanOne = async (proj, rowPath, depth) => {
    await pool.run({ wtPath: rowPath, depth, project: proj.name, priority: 1 });
    reads.push({ path: rowPath, depth, at: clock });
    // The shape a real read leaves: a branch, a head and a verdict. putRow in "fast" keeps the last full
    // verdict only when the count has not moved, so a fast read of a never-classified row is stale and
    // scanRow's own escalation (`if (merged.verdictStale) await this.fullScan`) asks for the full read.
    return store.putRow(
      proj.name,
      {
        path: rowPath,
        name: rowPath.split("/").pop(),
        branch: `b/${rowPath.split("/").pop()}`,
        head: "1234567",
        ahead: 1,
        behind: 0,
        dirty: 0,
        untracked: 0,
        verdict: "UNMERGED (1 commit)",
      },
      depth,
    );
  };
  s.fullScan = async (proj, rowPath) => s.scanOne(proj, rowPath, "full");

  // The boot read exactly as fullPassProject runs it (lib/scheduler.js:1012-1034): every row at once, a
  // refused scan turned into the row's backoff, then the stagger.
  const boot = async () => {
    await Promise.all(
      store.rowsFor(PROJECT.name).map(async (r) => {
        try {
          await s.scanOne(PROJECT, r.path, "full");
        } catch (e) {
          if (e && e.code === "SCAN_QUEUE_DEFERRED") s.deferRow(PROJECT.name, r.path, clock);
          else throw e;
        }
      }),
    );
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    s.dueAfter(PROJECT.name, store.rowsFor(PROJECT.name), clock);
  };

  const tick = async () => {
    clock += 1000;
    s.enqueueDue(PROJECT, clock);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  };

  const branchless = () => store.rowsFor(PROJECT.name).filter((r) => !r.branch);
  return { s, store, pool, refused, reads, boot, tick, branchless, clockAt: () => clock };
}

test("a tree whose boot read was refused is retried and recovers, instead of staying branchless and stale", async () => {
  const { reads, boot, tick, branchless, store, clockAt } = harness();
  await boot();

  assert.equal(reads.length, MAX_PER_PROJECT, "the queue admits only its per-project share at boot");
  assert.equal(branchless().length, TREES - MAX_PER_PROJECT, "the rest are left as the live board read them");
  for (const row of branchless()) {
    assert.equal(row.verdict, "…", "a refused row still carries discovery's unknown verdict");
    assert.equal(row.verdictStale, true);
    assert.equal(
      row.nextReadAt,
      new Date(clockAt() + 5000).toISOString(),
      `${row.name} must ring to its retry, not to a cadence nothing read`,
    );
  }

  // The backoff is a real hold, not a licence to hammer the queue: four one-second ticks are not enough.
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(branchless().length, TREES - MAX_PER_PROJECT, "nothing is re-requested before the 5 s backoff expires");

  // The 5 s backoff, then a handful of one-second ticks: every tree must be read well inside one cadence.
  for (let i = 0; i < 11; i++) await tick();

  const left = branchless();
  assert.deepEqual(
    left.map((r) => r.name),
    [],
    `every tree is read within seconds of its boot refusal; still branchless after 15 ticks: ${left.map((r) => r.name).join(", ")}`,
  );
  for (const row of store.rowsFor(PROJECT.name)) {
    assert.equal(row.verdictStale, false, `${row.name} must not stay stale`);
    assert.match(String(row.verdict), /UNMERGED/, `${row.name} must carry the verdict its read found`);
  }
});

test("the retry claims only the project's free queue slots, so it cannot re-flood the queue and refuse itself", async () => {
  const { s, boot, tick, refused, branchless } = harness();
  await boot();
  const afterBoot = refused.length;

  // A full pass reads a project's rows in one go, so the next sweep sees them due together - the shape that
  // used to claim every row in the same tick and have all but two refused again.
  for (const row of branchless()) {
    s.lastFast.set(`${PROJECT.name}::${row.path}`, 0);
    s.deferUntil.set(`${PROJECT.name}::${row.path}`, 0);
  }

  for (let i = 0; i < 15; i++) await tick();

  assert.equal(refused.length, afterBoot, "a retry must be admitted, never refused and re-parked");
  assert.deepEqual(branchless().map((r) => r.name), [], "the batch still drains, a few rows per tick");
});
