// Promotions are serialised, and the page no longer promotes on boot.
//
// A promotion is a full discovery probe plus a full read of one repo's rows. Two things used to start them in
// parallel: every reader click, and - until this change - the boot loop in public/app.js, which reported every
// project the reader had ever left expanded. Fifteen tabs restoring a boardful of sections therefore read the whole
// old fleet at once; /api/state answered in seconds or timed out while the pool drained. These tests pin the two
// halves of the fix: one promotion at a time with a bounded queue, and no promotion from the boot path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Scheduler } from "../lib/scheduler.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeScheduler() {
  const config = { tierDays: 7, tierBuckets: 60, tierCheckSeconds: 60, slowSeconds: 300, threads: 1 };
  const store = { rowsFor: () => [], ensureProject() {}, patchProject() {} };
  const pool = { size: 1, inFlight: 0, queue: [], submit: async () => ({}) };
  const getConfig = () => config;
  return new Scheduler({ config, store, pool, registry: { getConfig, projects: [], tiers: null }, getProjects: () => [] });
}

test("promotions run one at a time, in arrival order", async () => {
  const s = makeScheduler();
  let running = 0;
  let mostAtOnce = 0;
  const order = [];
  s.promoteNow = async (project) => {
    running += 1;
    mostAtOnce = Math.max(mostAtOnce, running);
    order.push(project.name);
    await sleep(20);
    running -= 1;
    return true;
  };

  const names = ["a", "b", "c", "d"];
  const results = await Promise.all(names.map((name) => s.promoteProject({ name }, "test")));
  assert.deepEqual(results, [true, true, true, true]);
  assert.equal(mostAtOnce, 1, "no two promotions may overlap");
  assert.deepEqual(order, names, "the queue is arrival-ordered");
});

test("the waiting queue is bounded, and a declined promotion is not an error", async () => {
  const s = makeScheduler();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  s.promoteNow = async () => {
    await gate;
    return true;
  };

  const calls = Array.from({ length: 12 }, (_, i) => s.promoteProject({ name: `p${i}` }, "test"));
  const waiting = s.promotingQueued.size;
  release();
  const results = await Promise.all(calls);
  const accepted = results.filter(Boolean).length;
  const declined = results.filter((r) => r === false).length;

  assert.equal(waiting, 8, "the queue holds at most PROMOTION_QUEUE_MAX (8)");
  assert.equal(accepted, 8);
  assert.equal(declined, 4, "the overflow is declined so the stat gate owns those repos");
});

test("a promotion that throws does not cancel the ones queued behind it", async () => {
  const s = makeScheduler();
  const ran = [];
  s.promoteNow = async (project) => {
    ran.push(project.name);
    if (project.name === "boom") throw new Error("probe failed");
    return true;
  };
  const [first, second] = await Promise.all([
    s.promoteProject({ name: "boom" }, "test").catch(() => "threw"),
    s.promoteProject({ name: "after" }, "test"),
  ]);
  assert.equal(first, "threw");
  assert.equal(second, true);
  assert.deepEqual(ran, ["boom", "after"]);
});

test("the page does not promote anything on boot; a click still reports the section", () => {
  const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    !/for \(const name of state\.expandedProjects\)\s*\n?\s*noteProjectOpen\(name\)/.test(src),
    "the boot block must not open every restored section",
  );
  // The click path: expanding a project records the open and reports it once.
  const expand = /state\.expandedProjects\.add\(name\);[\s\S]{0,400}?noteProjectOpen\(name\);/;
  assert.ok(expand.test(src), "toggleProject still reports the section the reader unfolds");
});
