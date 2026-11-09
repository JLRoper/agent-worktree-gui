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

function makeScheduler(fleet = []) {
  const config = { tierDays: 7, tierBuckets: 60, tierCheckSeconds: 60, slowSeconds: 300, threads: 1 };
  const store = { rowsFor: () => [], ensureProject() {}, patchProject() {} };
  const pool = { size: 1, inFlight: 0, queue: [], submit: async () => ({}) };
  const getConfig = () => config;
  return new Scheduler({ config, store, pool, registry: { getConfig, projects: [], tiers: null }, getProjects: () => fleet });
}

const project = (name, ageDays) => ({
  name,
  path: `C:/x/${name}`,
  root: "C:/x",
  activityAt: new Date(now - ageDays * DAY).toISOString(),
});

test("countTiers records what the pass reads and what it parks", () => {
  const all = [project("fresh-a", 0), project("stale-a", 20), project("stale-b", 40), project("fresh-b", 3)];
  const s = makeScheduler(all);
  const visible = all; // a visible report of the whole board
  const read = s.countTiers(visible);
  assert.deepEqual(read.map((p) => p.name), ["fresh-a", "fresh-b"]);
  assert.equal(s.stats.tierRecent, 2);
  assert.equal(s.stats.tierOld, 2);
  assert.equal(s.stats.tierParkedNow, 2, "the live parked count is the old half of what the pass looked at");
});

test("countTiers keeps the gate's own cumulative counter alone", () => {
  const s = makeScheduler([project("fresh", 1), project("stale", 30)]);
  s.stats.tierParked = 7; // the gate refused seven passes earlier in the process
  s.countTiers([project("fresh", 1), project("stale", 30)]);
  assert.equal(s.stats.tierParked, 7, "the cumulative gate reading is not overwritten");
  assert.equal(s.stats.tierParkedNow, 1);
});

test("the counters are the fleet's split, not the visible slice's", () => {
  // A page reports the sections it can see, and those are the recent ones: counting only them says "0 parked" on a
  // board that is mostly parked. The reading has to be over every project the board knows.
  const all = [project("fresh", 1), project("stale-a", 30), project("stale-b", 60)];
  const s = makeScheduler(all);
  s.countTiers([all[0]]); // the page only reported the recent one
  assert.equal(s.stats.tierRecent, 1);
  assert.equal(s.stats.tierOld, 2, "both old projects are counted even though neither was visible");
  assert.equal(s.stats.tierParkedNow, 2);
});

test("the folder header carries the scanning count beside the project count", () => {
  // The chip builders moved to public/render-projects.js in step 7 of docs/reports/module-map-2026-11-07.html,
  // beside the folder card they draw.
  const src = readFileSync(new URL("../public/render-projects.js", import.meta.url), "utf8");
  // Cut the chip builders out of the page by their own boundaries: the folder-header section has no `end`
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
    "esc",
    `${code}; return { rootScanChip, rootChips };`,
  )(stubs, () => true, () => 7, (s) => String(s ?? ""));

  const chip = rootScanChip(17);
  assert.match(chip, /class="chip scan"/);
  assert.match(chip, /^<span class="chip scan" title="[^"]*">17 scanning<\/span>$/);
  assert.match(chip, /hourly stat gate/);
  assert.equal(rootScanChip(null), "", "no count renders nothing, not a zero");
  assert.match(rootScanChip(0), /0 scanning/);

  const chips = rootChips([{ name: "a" }, { name: "b" }], { scanning: 1 });
  assert.match(
    chips,
    /2 projects<\/span><span class="chip scan"[^>]*>1 scanning<\/span><span class="chip">0 worktrees/,
    "scanning sits immediately right of the project count",
  );
  assert.doesNotMatch(rootChips([{ name: "a" }], {}), /chip scan/, "a caller that passes no count gets no chip");

  // The count beside the folder's path is the FOLDER's count, not the visible one: the 7d view folds projects
  // away, and the header must not shrink with it. The shortfall is the toggle's to say (rootRecentButton).
  const narrowed = rootChips([{ name: "a" }], { total: 3 });
  assert.match(narrowed, /^<span class="chip">3 projects<\/span>/, "the full count, from the folder rather than the view");
  assert.doesNotMatch(narrowed, /hidden/, "the hidden count is no longer a chip at the far right of the header");

  // The folder card no longer counts liveness at all: a live agent is a row's fact, and the folder chip only
  // repeated it one layer out. A live row must therefore draw no live chip here (a project card's own chips do).
  stubs.rows.set("a::/work/trees/a", { project: "a", live: true });
  assert.doesNotMatch(rootChips([{ name: "a" }], { total: 1 }), /chip live|1 live/, "no live chip on the folder card");
});
