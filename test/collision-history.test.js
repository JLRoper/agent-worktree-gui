// THE COLLISIONS BUTTON: the reason as a field, the waiting predicate, the durable history and its filter.
//
// WHY THESE CASES. The button exists to answer one question the panel could not: WHY is this pair settled, and is
// anything actually waiting on me? So each case is one of the promises the brief makes, proved on a real pair from
// lib/collisions.js rather than on a hand-written record:
//
//   1. a REAL pair (detectCollisions on two live rows touching lib/shared.js) reaches the history carrying its reason -
//      the rule, the two rows and trees, the relation that caused it, and what the panel would do if nobody ruled;
//   2. an AUTO-RULED pair records its rule (git's one clean direction; and the older-cut tie-break when git is clean
//      both ways) and does NOT raise the badge;
//   3. a pair git cannot order raises the badge, lists BOTH rows, and a person's ruling records who, when, the rule and
//      the line saying why, and takes the pair off the badge;
//   4. the history survives a RESTART (a second CollisionBook over the same file) and filters to ONE row by row, branch
//      or file - the three things the popup's box says it searches.
//
// The route is driven through its own handler, so the shape the page reads is the shape asserted here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CollisionBook, detectCollisions, pairKey, reasonOf, ruleOfRuling, stateOf, waitingOf } from "../lib/collisions.js";
import { sweepCollisions } from "../lib/collision-flow.js";
import { COLLISIONS_HISTORY_PATH, COLLISIONS_PATH, createCollisionsRoutes } from "../routes/collisions.js";
// The page's pure half, imported the way the shell loads it and the way lib/collisions.js imports it.
import "../public/core/collision-history.js";

const Core = globalThis.wtCollisionHistory;
const PROJECT = "collisions-button";
const TREE = (name, over = {}) => ({
  project: PROJECT,
  path: `/repos/${PROJECT}/.worktrees/${name}`,
  name,
  branch: `wtgui/${name}`,
  parent: "main",
  live: true,
  dirtyFiles: [],
  untrackedFiles: [],
  commitFiles: [],
  ...over,
});

function tempFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collisions-button-"));
  return { dir, file: path.join(dir, "collisions.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** git's two answers, in the shape lib/collision-merge.js `probePairMerge` returns them. */
const merge = ({ aFirst = true, bFirst = true, a = {}, b = {} } = {}) => ({
  ok: true,
  at: new Date().toISOString(),
  tips: { a: "a".repeat(40), b: "b".repeat(40) },
  a: { clean: aFirst, commits: 2, cutAt: "2026-11-20T10:00:00.000Z", ...a },
  b: { clean: bFirst, commits: 3, cutAt: "2026-11-20T11:00:00.000Z", ...b },
  aFirst: { clean: aFirst },
  bFirst: { clean: bFirst },
});

/** A route handler over one book, with the two dependencies the history read needs. */
function routeFor(book, { onRule = null } = {}) {
  const replies = [];
  const handle = createCollisionsRoutes({
    book,
    getConfig: () => ({ token: "t" }),
    sendJson: (res, code, body) => replies.push({ code, body }),
    readBody: async () => ({}),
    authorised: () => true,
    fileRuling: (record) => onRule?.(record),
    refresh: () => {},
    log: () => {},
  });
  return {
    replies,
    async get(url) {
      const u = new URL(url, "http://127.0.0.1");
      const req = { method: "GET", url: u.pathname + u.search, headers: {} };
      await handle(req, {}, { url: u });
      return replies[replies.length - 1];
    },
  };
}

// ---- 1. a real pair, in the history, with its reason -------------------------------------------------------------
test("a real pair from detectCollisions appears in the history with its reason as a field", () => {
  const rows = [
    TREE("worker-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    TREE("worker-two", { dirtyFiles: [{ code: "M", path: "Lib/Shared.js" }] }),
  ];
  const pairs = detectCollisions(rows);
  assert.equal(pairs.length, 1, "two live rows touching one file are one pair");
  const pair = pairs[0];
  assert.deepEqual(pair.files, ["lib/shared.js"]);

  const book = new CollisionBook({ file: null });
  book.upsertDetected(pair, Date.parse("2026-11-25T09:00:00.000Z"));
  const hist = book.history();
  assert.equal(hist.total, 1);
  const rec = hist.records[0];
  assert.equal(rec.key, pairKey(pair.a, pair.b));
  assert.deepEqual([rec.a.name, rec.b.name].sort(), ["worker-one", "worker-two"]);

  // THE REASON IS A FIELD, not prose: rule id, label, pair, relation, files, and what would happen if nobody ruled.
  const reason = rec.reason;
  assert.equal(reason.settled, false);
  assert.ok(reason.rule, "the reason names a rule even before anybody rules");
  assert.equal(reason.label, Core.ruleLabel(reason.rule));
  assert.equal(reason.relation.kind, "shared-file", "the relation that caused the pair is kept");
  assert.deepEqual(reason.relation.files, ["lib/shared.js"]);
  assert.deepEqual(reason.files, ["lib/shared.js"]);
  assert.equal(reason.pair.a.path, pair.a.path);
  assert.equal(reason.pair.b.path, pair.b.path);
  // No merge check has been run in this test, so the answer is the standing order, labelled as such.
  assert.equal(reason.would.why, "no-merge-check");
  assert.equal(reason.would.fromGit, false);
  assert.ok(["branch-name", "pair-order"].includes(reason.would.rule), `the standing order picked ${reason.would.rule}`);
  assert.match(reason.would.reason, /standing order/);

  // The store's reason and the popup's line are the same answer.
  assert.match(Core.reasonLine(rec), /if nobody rules/);
});

// ---- 2. an auto-ruled pair: its rule is recorded, the badge stays down -----------------------------------------
test("an auto-ruled pair records the rule git used and does NOT raise the badge", async () => {
  const rows = [
    TREE("worker-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    TREE("worker-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const book = new CollisionBook({ file: null });
  const report = await sweepCollisions({
    rows,
    book,
    now: Date.parse("2026-11-25T09:00:00.000Z"),
    probeMerge: () => merge({ aFirst: true, bFirst: false }),
    fileQueue: () => ({ taskId: 41 }),
    ownerOf: (side) => (side.path.includes("worker-one") ? "assistant-1" : "assistant-2"),
    nameOf: (id) => id,
    tasksFor: () => [],
  });
  assert.equal(report.settled.length, 1);
  assert.equal(report.settled[0].rule, "git-one-direction");
  const [rec] = book.history().records;
  assert.equal(rec.state, "ruled");
  assert.equal(rec.waiting, false);
  assert.equal(rec.reason.rule, "git-one-direction");
  assert.equal(rec.reason.label, "git: one merge direction is clean");
  assert.equal(rec.reason.by, "auto");
  assert.ok(rec.reason.at, "who and when are on the record");
  assert.equal(rec.settlement.rule, "git-one-direction");
  assert.equal(rec.settlement.outcome, "ruled");
  assert.equal(rec.settlement.pickName, rec[rec.settlement.pick].name);
  // NO NOTICE IS FILED FOR A SETTLED PAIR (the Ruled row is the one that carries the order), and the badge is empty.
  assert.equal(rec.filed.length, 0);
  assert.equal(book.history().waiting, 0, "an automatic ruling never raises the badge");
  assert.equal(book.state().waiting, 0);

  // The route's own read says the same number.
  const route = routeFor(book);
  const answer = await route.get(COLLISIONS_HISTORY_PATH);
  assert.equal(answer.code, 200);
  assert.equal(answer.body.waiting, 0);
  assert.equal(answer.body.records[0].reason.rule, "git-one-direction");
});

test("a tie git can merge either way is settled by the standing order, and the rule says which tie-break", async () => {
  const rows = [
    TREE("worker-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    TREE("worker-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const book = new CollisionBook({ file: null });
  const report = await sweepCollisions({
    rows,
    book,
    probeMerge: () => merge({ aFirst: true, bFirst: true, a: { cutAt: "2026-11-20T09:00:00.000Z" }, b: { cutAt: "2026-11-20T12:00:00.000Z" } }),
    ownerOf: () => null,
  });
  assert.equal(report.settled[0].rule, "older-cut");
  const rec = book.history().records[0];
  assert.equal(rec.reason.rule, "older-cut");
  assert.match(rec.reason.reason, /older cut/);
  assert.equal(book.history().waiting, 0);
});

// ---- 3. a pair that needs a person: badge up, both rows, a ruling with who and why ------------------------------
test("a pair needing a person raises the badge, lists both rows, and a ruling records who and why", async () => {
  const rows = [
    TREE("worker-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    TREE("worker-two", { dirtyFiles: [{ code: "MM", path: "lib/shared.js" }] }),
  ];
  const book = new CollisionBook({ file: null });
  const base = { rows, book, probeMerge: () => merge({ aFirst: false, bFirst: false }), ownerOf: () => null };
  await sweepCollisions({ ...base, now: Date.parse("2026-11-25T09:00:00.000Z") });
  // A second pass, at least COLLISION_PASS_MS later, with nobody standing down, is what hands it over.
  const second = await sweepCollisions({ ...base, now: Date.parse("2026-11-25T09:00:03.000Z") });
  assert.equal(second.escalated.length, 1);
  assert.equal(second.escalated[0].why, "no-stand-down");

  const before = book.history();
  assert.equal(before.waiting, 1, "the pair is waiting on a person");
  assert.equal(book.state().waiting, 1);
  const rec = before.records[0];
  assert.equal(rec.state, "reader");
  assert.equal(rec.waiting, true);
  assert.equal(rec.canRule, true);
  assert.equal(rec.reason.rule, "both-conflict");
  assert.equal(rec.reason.would.pick, null, "nothing can pick: that is why it is a card");
  assert.match(Core.reasonLine(rec), /nothing can pick/);
  assert.ok(rec.a.name && rec.b.name, "both rows are named on the record");

  const route = routeFor(book);
  const list = await route.get(COLLISIONS_HISTORY_PATH);
  assert.equal(list.body.waiting, 1);
  assert.deepEqual([list.body.records[0].a.name, list.body.records[0].b.name].sort(), ["worker-one", "worker-two"]);

  // The person's ruling: one side first, one line saying why. The route stamps who and when.
  const ruled = book.rule(rec.key, {
    pick: "a",
    by: "reader",
    note: "worker-one is the branch that has to land first: worker-two is rebased on it",
    at: Date.parse("2026-11-25T09:05:00.000Z"),
  });
  assert.equal(ruled.ok, true);
  const after = book.get(rec.key);
  assert.equal(after.settlement.rule, "reader");
  assert.equal(after.settlement.by, "reader");
  assert.equal(after.settlement.at, "2026-11-25T09:05:00.000Z");
  assert.equal(after.settlement.note, "worker-one is the branch that has to land first: worker-two is rebased on it");
  assert.equal(after.settlement.outcome, "ruled");
  assert.equal(after.settlement.pick, "a");
  assert.equal(after.settlement.pickName, after.a.name);
  assert.deepEqual(after.settlement.files, ["lib/shared.js"]);
  assert.equal(book.history().waiting, 0, "the answer clears the badge");
  const hist = book.history().records[0];
  assert.equal(hist.state, "ruled");
  assert.match(Core.reasonLine(hist), /you · .* goes first · your ruling/);
  assert.equal(Core.reasonDetail(hist).includes("you wrote:"), true);
});

// ---- 4. restart and filter ---------------------------------------------------------------------------------------
test("the history survives a restart and filters to one row by row, branch or file", () => {
  const tmp = tempFile();
  try {
    const rows = [
      TREE("worker-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }, { code: "M", path: "docs/reports/plan.html" }] }),
      TREE("worker-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
      TREE("worker-three", { dirtyFiles: [{ code: "M", path: "docs/reports/plan.html" }], commitFiles: ["docs/reports/plan.html"] }),
    ];
    const first = new CollisionBook({ file: tmp.file });
    const pairs = detectCollisions(rows);
    assert.equal(pairs.length, 2, "worker-one overlaps worker-two on one file and worker-three on another");
    for (const pair of pairs) first.upsertDetected(pair, Date.parse("2026-11-25T09:00:00.000Z"));
    // One of them is answered by a person, so the restart has a settlement to carry as well as a reason.
    const answered = first.history().records.find((rec) => (rec.files || []).includes("docs/reports/plan.html"));
    first.rule(answered.key, { pick: "a", note: "the plan is the shared file: worker-one owns it", by: "reader", at: Date.parse("2026-11-25T09:10:00.000Z") });
    assert.equal(first.save().ok, true);

    // A RESTART: a new book over the same file, which is exactly what the panel does.
    const reborn = new CollisionBook({ file: tmp.file });
    const all = reborn.history();
    assert.equal(all.total, 2, "every collision is still there after a restart");
    assert.equal(all.records.filter((rec) => rec.settlement).length, 1);
    const kept = all.records.find((rec) => rec.key === answered.key);
    assert.equal(kept.settlement.note, "the plan is the shared file: worker-one owns it");
    assert.equal(kept.reason.rule, "reader");
    assert.equal(kept.state, "ruled");

    // FILTERS: one row by the file, by a row's directory, by a branch, and by a task number when one is named.
    assert.equal(reborn.history({ q: "lib/shared.js" }).total, 1);
    assert.equal(reborn.history({ q: "worker-two" }).total, 1);
    assert.equal(reborn.history({ q: "wtgui/worker-three" }).total, 1);
    assert.equal(reborn.history({ q: "docs/reports/plan.html worker-three" }).total, 1);
    assert.equal(reborn.history({ q: "nothing-names-this" }).total, 0);
    assert.equal(reborn.history({ q: "worker", limit: 1 }).shown, 1, "limit is a render cap, not a filter");
    assert.equal(reborn.history({ q: "lib/shared.js" }).records[0].reason.relation.kind, "shared-file");
  } finally {
    tmp.done();
  }
});

// ---- the route and the page's pure half --------------------------------------------------------------------------
test("the route answers a filtered history, and the page's filter agrees with it", async () => {
  const rows = [
    TREE("worker-one", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
    TREE("worker-two", { dirtyFiles: [{ code: "M", path: "lib/shared.js" }] }),
  ];
  const book = new CollisionBook({ file: null });
  for (const pair of detectCollisions(rows)) book.upsertDetected(pair);
  const route = routeFor(book);
  const unfiltered = await route.get(`${COLLISIONS_HISTORY_PATH}?limit=1`);
  assert.equal(unfiltered.code, 200);
  assert.equal(unfiltered.body.total, 1);
  assert.equal(unfiltered.body.records.length, 1);
  const filtered = await route.get(`${COLLISIONS_HISTORY_PATH}?q=${encodeURIComponent("wtgui/worker-two")}`);
  assert.equal(filtered.body.total, 1);
  const none = await route.get(`${COLLISIONS_HISTORY_PATH}?q=nope`);
  assert.equal(none.body.total, 0);
  // The live route still answers its own shape, with the waiting count beside the reader count.
  const live = await route.get(COLLISIONS_PATH);
  assert.equal(live.code, 200);
  assert.equal(typeof live.body.waiting, "number");
  // The page's pure half, over the route's own records, narrows to the same row.
  assert.equal(Core.filterRecords(unfiltered.body.records, "worker-two").length, 1);
  assert.equal(Core.filterRecords(unfiltered.body.records, "nope").length, 0);
});

test("the page half counts only waiting records, orders them first, and words every rule", () => {
  const records = [
    { key: "k1", state: "ruled", waiting: false, ruling: { rule: "older-cut", auto: true, pick: "a" }, a: { name: "a" }, b: { name: "b" }, firstAt: "2026-11-25T09:00:00.000Z" },
    { key: "k2", state: "reader", waiting: true, a: { name: "c" }, b: { name: "d" }, firstAt: "2026-11-25T08:00:00.000Z", reason: { rule: "both-conflict", would: { pick: null, rule: "both-conflict", label: "both merge directions conflict" } } },
    { key: "k3", state: "assistants", waiting: false, a: { name: "e" }, b: { name: "f" }, firstAt: "2026-11-25T07:00:00.000Z" },
  ];
  assert.equal(Core.countWaiting(records), 1);
  assert.equal(Core.order(records)[0].key, "k2", "the pair waiting on a person comes first");
  assert.equal(Core.stateOf(records[0]), "ruled");
  assert.equal(Core.stateOf(records[1]), "waiting");
  assert.equal(Core.stateOf(records[2]), "queued");
  assert.equal(Core.ruleLabel("older-cut"), "older cut first");
  assert.equal(Core.ruleLabel("version-line"), "the version line is the land order");
  assert.match(Core.reasonLine(records[1]), /if nobody rules: nothing can pick \(both merge directions conflict\)/);
  assert.match(Core.reasonLine(records[0]), /auto · a goes first · older cut first/);
  assert.equal(Core.footText(0, 0), "no collision has been seen on this board yet");
  assert.equal(Core.footText(50, 137), "showing 50 of 137");
  assert.equal(Core.badgeText(0), "nothing is waiting on you");
  assert.equal(Core.badgeText(2), "2 collisions waiting on you");
});

test("an older ruling without the rule field still reads as the rule that settled it", () => {
  assert.equal(ruleOfRuling({ auto: true, basis: "older cut" }), "older-cut");
  assert.equal(ruleOfRuling({ auto: true, basis: "fewer commits" }), "fewer-commits");
  assert.equal(ruleOfRuling({ auto: true, basis: "branch name" }), "branch-name");
  assert.equal(ruleOfRuling({ auto: true, basis: "merge" }), "git-one-direction");
  assert.equal(ruleOfRuling({ auto: true, basis: "version" }), "version-line");
  assert.equal(ruleOfRuling({ auto: false, by: "reader" }), "reader");
  const rec = {
    a: { path: "/r/a", name: "a" },
    b: { path: "/r/b", name: "b" },
    files: ["lib/shared.js"],
    ruling: { auto: true, basis: "older cut", pick: "b", at: "2026-11-25T09:00:00.000Z" },
  };
  assert.equal(stateOf(rec), "ruled");
  assert.equal(waitingOf(rec), false);
  assert.equal(reasonOf(rec).rule, "older-cut");
  assert.equal(reasonOf(rec).pickName, "b");
});
