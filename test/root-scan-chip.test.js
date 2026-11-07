// The two numbers this landing adds: the folder header's "N scanning", and a parked count a reader can trust.
//
// `tierParked` is the gate's own cumulative counter - how many passes fullPassProject refused - and it reads 0 on a
// visible-mode board because an OLD project is filtered out of the sweep before the gate is ever reached. That is
// what made /api/stats show `tierRecent 0 / tierOld 0 / tierParked 0` on a board where 160 of 177 projects were
// parked: true, and useless. `countTiers` records the split the pass actually used.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Scheduler } from "../lib/scheduler.js";

const DAY = 864e5;
const now = Date.now();

function makeScheduler() {
  const config = { tierDays: 7, tierBuckets: 60, tierCheckSeconds: 60, slowSeconds: 300, threads: 1 };
  const store = { rowsFor: () => [], ensureProject() {}, patchProject() {} };
  const pool = { size: 1, inFlight: 0, queue: [], submit: async () => ({}) };
  const getConfig = () => config;
  return new Scheduler({ config, store, pool, registry: { getConfig, projects: [], tiers: null }, getProjects: () => [] });
}

const project = (name, ageDays) => ({
  name,
  path: `C:/x/${name}`,
  root: "C:/x",
  activityAt: new Date(now - ageDays * DAY).toISOString(),
});

test("countTiers records what the pass reads and what it parks", () => {
  const s = makeScheduler();
  const visible = [project("fresh-a", 0), project("stale-a", 20), project("stale-b", 40), project("fresh-b", 3)];
  const read = s.countTiers(visible);
  assert.deepEqual(read.map((p) => p.name), ["fresh-a", "fresh-b"]);
  assert.equal(s.stats.tierRecent, 2);
  assert.equal(s.stats.tierOld, 2);
  assert.equal(s.stats.tierParkedNow, 2, "the live parked count is the old half of what the pass looked at");
});

test("countTiers keeps the gate's own cumulative counter alone", () => {
  const s = makeScheduler();
  s.stats.tierParked = 7; // the gate refused seven passes earlier in the process
  s.countTiers([project("fresh", 1), project("stale", 30)]);
  assert.equal(s.stats.tierParked, 7, "the cumulative gate reading is not overwritten");
  assert.equal(s.stats.tierParkedNow, 1);
});

test("the folder header carries the scanning count beside the project count", () => {
  const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  // Cut the two chip builders out of the page by their own boundaries: the folder-header section has no `end`
  // marker, and a whole-region slice drags in a dozen functions these assertions do not need.
  const from = src.indexOf("function rootScanChip(");
  const to = src.indexOf("function rootSection(");
  assert.ok(from > 0 && to > from, "the chip builders are still where this test expects them");
  const code = src.slice(from, to);
  const stubs = { rows: new Map() };
  const { rootScanChip, rootChips } = new Function(
    "state",
    "isRowLive",
    "recentDays",
    `${code}; return { rootScanChip, rootChips };`,
  )(stubs, () => false, () => 7);

  const chip = rootScanChip(17);
  assert.match(chip, /class="chip scan"/);
  assert.match(chip, /^<span class="chip scan" title="[^"]*">17 scanning<\/span>$/);
  assert.match(chip, /hourly stat gate/);
  assert.equal(rootScanChip(null), "", "no count renders nothing, not a zero");
  assert.match(rootScanChip(0), /0 scanning/);

  const chips = rootChips([{ name: "a" }, { name: "b" }], 0, 1);
  assert.match(
    chips,
    /2 projects<\/span><span class="chip scan"[^>]*>1 scanning<\/span><span class="chip">0 worktrees/,
    "scanning sits immediately right of the project count",
  );
  const hidden = rootChips([{ name: "a" }], 3);
  assert.doesNotMatch(hidden, /chip scan/, "a caller that passes no count gets no chip");
  assert.match(hidden, /3 hidden/);
});
