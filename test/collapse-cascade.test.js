// The collapse cascade: a parent the reader collapsed, left collapsed for N seconds, writes every card under it into
// the persisted fold set — so the next expand draws them minimized.
//
// Today the fold sets are independent (wm.collapsedJobs for cards, wm.collapsedRoots for folders, wm.collapsedFixed,
// state.expanded for worktree rows, state.turnOpen for turns) and nothing relates a child's fold to its parent's. This
// drives the shipped region of public/app.js — sliced out of the file, not re-implemented — on fake timers, with the
// page-shaped facts it reads stubbed. Seven facts:
//
//   1. the clock is `collapseAfterSeconds`: 30 s by default, 0 disables it, an unreadable value falls back to 30;
//   2. a parent collapsed for 30 s writes every card under it into `wm.collapsedJobs` (and saves it);
//   3. 5 s is a no-op: the cards are untouched and the clock is still running;
//   4. the timer is per parent — one parent's clock fires for that parent and no other;
//   5. an early expand cancels that parent's clock, and nothing is written later;
//   6. a post-cascade expand leaves the children minimized: expanding a parent never takes a child out of the set;
//   7. the cards a parent owns are resolved the way the renderer files them (row, project, folder, the Agents card),
//      the assistant is never a board card, and the config.json default plus the Board tab's number field agree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import vm from "node:vm";
import { sliceBetween, sliceRegion } from "../tools/panel-testkit.mjs";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
// config.json is the reader's own file and is not tracked (config.example.json is the shipped template), so a
// fresh clone carries no config.json: the shipped example is what every clone has, and a checkout that does carry
// its own config.json is tested against that instead.
const config = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
// The settings prefix moved into routes/settings.js, so the route that writes the cascade is read from there.
const settingsSource = readFileSync(new URL("../routes/settings.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");

// ---- the shipped region, in a page-shaped context ----------------------------------------------------------------
// Everything the cascade reads from the page is a stub here; the resolution and the timer are the shipped code.
function harness({ settings = {}, rows = [], projects = [], scanRoots = [], convs = [], collapsed = [] } = {}) {
  const saves = [];
  const painted = [];
  const sandbox = {
    state: {
      settings,
      scanRoots,
      rows: new Map(rows.map((r) => [`${r.project}::${r.path}`, r])),
      projects: new Map(projects.map((p) => [p.name, p])),
      collapsedJobs: new Set(collapsed),
      collapseTimers: new Map(),
    },
    conversations: () => convs,
    assistantSessionFor: (thread) => (thread === "assistant-1" ? { id: "assistant-1", threadId: "assistant-1" } : null),
    saveCollapsedJobs: () => saves.push([...sandbox.state.collapsedJobs]),
    renderConversation: (thread) => painted.push(thread),
    // A card node exists only for the threads named here — the DOM half of "rebuild the ones still on the page".
    document: { querySelector: (sel) => (onPage.has(String(sel).match(/data-thread="([^"]+)"/)?.[1]) ? {} : null) },
    CSS: { escape: (s) => String(s) },
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
  };
  const onPage = new Set();
  const context = vm.createContext(sandbox);
  // The path helpers the cascade resolves a card's owner with, and the cascade itself — both straight out of the file.
  vm.runInContext(sliceBetween(source, "const normPath = (p) =>", "// ---- the collapse cascade"), context);
  vm.runInContext(sliceRegion(source, "the collapse cascade"), context);
  return {
    sandbox,
    onPage,
    saves,
    painted,
    run: (code) => vm.runInContext(code, context),
    cards: (kind, id) => [...vm.runInContext(`cardsUnderParent(${JSON.stringify(kind)}, ${JSON.stringify(id)})`, context)],
    collapsedNow: () => [...sandbox.state.collapsedJobs],
    timers: () => [...sandbox.state.collapseTimers.keys()],
  };
}

// ---- the fixture: one folder, two projects, three worktrees, four cards ------------------------------------------
const ROWS = [
  { project: "app", path: "C:/Proj/app/.worktrees/one" },
  { project: "app", path: "C:/Proj/app/.worktrees/two" },
  { project: "other", path: "C:/Proj/other/.worktrees/solo" },
];
const PROJECTS = [
  { name: "app", path: "C:/Proj/app" },
  { name: "other", path: "C:/Proj/other" },
];
const card = (thread, ownerPath) => ({ thread, first: { ownerPath }, latest: { ownerPath } });
const CONVS = [
  card("t-one", "C:/Proj/app/.worktrees/one"),
  card("t-two", "C:/Proj/app/.worktrees/two"),
  card("t-solo", "C:/Proj/other/.worktrees/solo"),
  card("t-homeless", "C:/Proj/app"), // the project's own checkout: no row, so it is drawn in the Agents card
  card("assistant-1", ""), // a conversation, not a board card
];
const base = (extra = {}) =>
  harness({ rows: ROWS, projects: PROJECTS, scanRoots: ["C:/Proj"], convs: CONVS, ...extra });

const withTimers = (fn) => async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await fn();
  } finally {
    mock.timers.reset();
  }
};

// ---- 1. the clock -------------------------------------------------------------------------------------------------
test("the clock is 30 s by default, 0 disables it, and an unreadable value falls back to 30", () => {
  assert.equal(base().run("collapseAfterSeconds()"), 30, "a board with no setting waits 30 s");
  assert.equal(base({ settings: { collapseAfterSeconds: 0 } }).run("collapseAfterSeconds()"), 0, "0 is off, not 30");
  assert.equal(base({ settings: { collapseAfterSeconds: 5 } }).run("collapseAfterSeconds()"), 5, "a set number is the number");
  assert.equal(base({ settings: { collapseAfterSeconds: "nonsense" } }).run("collapseAfterSeconds()"), 30, "a typo is the default");
  assert.equal(base({ settings: { collapseAfterSeconds: 99999 } }).run("collapseAfterSeconds()"), 3600, "an absurd number is clamped");
});

test("0 disables the cascade: collapsing a parent starts no clock at all", () => {
  const h = base({ settings: { collapseAfterSeconds: 0 } });
  assert.equal(h.run('scheduleCollapseCascade("project", "app", true)'), null, "no timer is armed");
  assert.deepEqual(h.timers(), [], "the page holds no clock for the parent");
});

// ---- 2. the 30 s cascade -------------------------------------------------------------------------------------------
test(
  "a parent collapsed for 30 s writes every card under it into the persisted set",
  withTimers(() => {
    const h = base({ settings: { collapseAfterSeconds: 30 } });
    h.run('scheduleCollapseCascade("project", "app", true)');
    assert.deepEqual(h.timers(), ["project:app"], "the parent holds one clock");

    mock.timers.tick(29_000);
    assert.deepEqual(h.collapsedNow(), [], "one second short of 30 s writes nothing");
    assert.deepEqual(h.timers(), ["project:app"], "…and the clock is still running");

    mock.timers.tick(1_000);
    assert.deepEqual(h.collapsedNow().sort(), ["t-one", "t-two"], "both cards in the project are minimized");
    assert.deepEqual(h.timers(), [], "the clock is spent");
    assert.deepEqual(h.saves.at(-1).sort(), ["t-one", "t-two"], "the set is persisted, not just held in memory");
  }),
);

test(
  "the rebuild covers the cards still on the page, and only those",
  withTimers(() => {
    const h = base({ settings: { collapseAfterSeconds: 30 } });
    h.onPage.add("t-one"); // the folder's section keeps its DOM through a collapse; t-two's card is not drawn
    h.run('scheduleCollapseCascade("project", "app", true)');
    mock.timers.tick(30_000);
    assert.deepEqual(h.painted, ["t-one"], "the card in the page is rebuilt from the set");
  }),
);

// ---- 3. the 5 s no-op ----------------------------------------------------------------------------------------------
test(
  "5 s is a no-op: the cards are untouched and the clock is still running",
  withTimers(() => {
    const h = base({ settings: { collapseAfterSeconds: 30 } });
    h.run('scheduleCollapseCascade("project", "app", true)');
    mock.timers.tick(5_000);
    assert.deepEqual(h.collapsedNow(), [], "nothing is written early");
    assert.deepEqual(h.saves, [], "nothing is persisted early");
    assert.deepEqual(h.painted, [], "no card is rebuilt early");
    assert.deepEqual(h.timers(), ["project:app"], "the clock still waits out its 30 s");
  }),
);

// ---- 4. per parent -------------------------------------------------------------------------------------------------
test(
  "the timer is per parent: one parent's clock fires for that parent and no other",
  withTimers(() => {
    const h = base({ settings: { collapseAfterSeconds: 30 } });
    h.run('scheduleCollapseCascade("project", "app", true)');
    mock.timers.tick(20_000);
    h.run('scheduleCollapseCascade("project", "other", true)');
    assert.deepEqual(h.timers().sort(), ["project:app", "project:other"], "two parents, two clocks");

    mock.timers.tick(10_000); // app is at 30 s, other at 10 s
    assert.deepEqual(h.collapsedNow().sort(), ["t-one", "t-two"], "app's cards only");
    assert.deepEqual(h.timers(), ["project:other"], "other's clock is untouched");

    mock.timers.tick(20_000);
    assert.deepEqual(h.collapsedNow().sort(), ["t-one", "t-solo", "t-two"], "other's cards arrive on their own clock");
  }),
);

test(
  "re-collapsing a parent restarts its clock rather than stacking a second one",
  withTimers(() => {
    const h = base({ settings: { collapseAfterSeconds: 30 } });
    h.run('scheduleCollapseCascade("project", "app", true)');
    mock.timers.tick(20_000);
    h.run('scheduleCollapseCascade("project", "app", true)');
    assert.deepEqual(h.timers(), ["project:app"], "still one clock for that parent");
    mock.timers.tick(20_000);
    assert.deepEqual(h.collapsedNow(), [], "the second collapse restarted the 30 s, so 40 s in it has not fired");
    mock.timers.tick(10_000);
    assert.deepEqual(h.collapsedNow().sort(), ["t-one", "t-two"], "…and fires 30 s after the second collapse");
  }),
);

// ---- 5. an early expand cancels it ---------------------------------------------------------------------------------
test(
  "an early expand cancels that parent's clock, and nothing is written later",
  withTimers(() => {
    const h = base({ settings: { collapseAfterSeconds: 30 } });
    h.run('scheduleCollapseCascade("project", "app", true)');
    mock.timers.tick(5_000);
    assert.equal(h.run('scheduleCollapseCascade("project", "app", false)'), null, "the expand arms nothing");
    assert.deepEqual(h.timers(), [], "the clock is gone");
    mock.timers.tick(60_000);
    assert.deepEqual(h.collapsedNow(), [], "the cards were never written");
    assert.deepEqual(h.saves, [], "and nothing was persisted");
  }),
);

test(
  "an early expand of one parent leaves another parent's clock running",
  withTimers(() => {
    const h = base({ settings: { collapseAfterSeconds: 30 } });
    h.run('scheduleCollapseCascade("project", "app", true)');
    h.run('scheduleCollapseCascade("project", "other", true)');
    h.run('scheduleCollapseCascade("project", "app", false)');
    assert.deepEqual(h.timers(), ["project:other"], "only the expanded parent's clock is cancelled");
    mock.timers.tick(30_000);
    assert.deepEqual(h.collapsedNow(), ["t-solo"], "the parent still collapsed keeps its cascade");
  }),
);

// ---- 6. the post-cascade expand ------------------------------------------------------------------------------------
test(
  "a post-cascade expand leaves the children minimized: expanding a parent never clears a child's fold",
  withTimers(() => {
    const h = base({ settings: { collapseAfterSeconds: 30 } });
    h.run('scheduleCollapseCascade("project", "app", true)');
    mock.timers.tick(30_000);
    assert.deepEqual(h.collapsedNow().sort(), ["t-one", "t-two"], "the cascade wrote both cards");

    // The reader opens the project again. The page's own renderer reads this set (`conversationHtml`), so the
    // assertion is that the expand wrote nothing — not that a stub remembered something.
    h.run('scheduleCollapseCascade("project", "app", false)');
    mock.timers.tick(60_000);
    assert.deepEqual(h.collapsedNow().sort(), ["t-one", "t-two"], "both cards are still minimized after the expand");
    assert.equal(h.saves.length, 1, "the expand saved nothing — no child was taken out of the set");
  }),
);

test(
  "a card the reader had already minimized is not written twice and does not count as the cascade's work",
  withTimers(() => {
    const h = base({ settings: { collapseAfterSeconds: 30 }, collapsed: ["t-one"] });
    h.run('scheduleCollapseCascade("project", "app", true)');
    mock.timers.tick(30_000);
    assert.deepEqual(h.collapsedNow().sort(), ["t-one", "t-two"], "the set still holds both");
    assert.equal(h.saves.length, 1, "one save, for the one card that moved");
  }),
);

// ---- 7. what a parent owns -----------------------------------------------------------------------------------------
test("a row owns the cards whose cwd is that tree, and nothing else", () => {
  const h = base();
  assert.deepEqual(h.cards("row", "app::C:/Proj/app/.worktrees/one"), ["t-one"]);
  assert.deepEqual(h.cards("row", "app::C:/Proj/app/.worktrees/two"), ["t-two"]);
  assert.deepEqual(h.cards("row", "nope::C:/nope"), [], "a row that is not on the board owns nothing");
});

test("a project owns its rows' cards; a folder owns its projects' rows' cards", () => {
  const h = base();
  assert.deepEqual(h.cards("project", "app").sort(), ["t-one", "t-two"], "the project's checkout card is not one of its rows'");
  assert.deepEqual(h.cards("project", "other"), ["t-solo"]);
  assert.deepEqual(h.cards("root", "C:/Proj").sort(), ["t-one", "t-solo", "t-two"], "every card under the folder");
  assert.deepEqual(h.cards("root", "C:/Elsewhere"), [], "a folder with no rows owns nothing");
});

test("the Agents card owns the cards no row claims, and the assistant is never a board card", () => {
  const h = base();
  assert.deepEqual(h.cards("fixed", "agents"), ["t-homeless"], "a project-checkout run lives in the Agents card");
  assert.deepEqual(h.cards("fixed", "newagent"), [], "the New agent card holds no cards");
  assert.deepEqual(h.cards("project", "app"), ["t-one", "t-two"], "the assistant is not counted anywhere");
});

// ---- the setting: config.json, the server's normaliser, and the Board tab's field ----------------------------------
test("the shipped example carries collapseAfterSeconds beside the cadences, at 30", () => {
  const keys = Object.keys(config);
  const at = keys.indexOf("collapseAfterSeconds");
  assert.ok(at > 0, "the example names the key");
  assert.equal(config.collapseAfterSeconds, 30, "the shipped default is 30 s");
  assert.ok(keys.indexOf("slowSeconds") < at, "it sits after the scan cadences");
  assert.ok(at < keys.indexOf("fetchSeconds"), "…and before the fetch cadence");
});

test("the server's normaliser: absent is 30, 0 stays 0, a typo is 30, an absurd number is clamped", () => {
  const context = vm.createContext({});
  vm.runInContext(sliceBetween(serverSource, "const COLLAPSE_AFTER_DEFAULT = 30;", "async function loadConfig"), context);
  const read = (value) => vm.runInContext(`collapseAfterSecondsFrom(${JSON.stringify(value)})`, context);
  assert.equal(read(undefined), 30, "a config with no key boots on 30");
  assert.equal(read(null), 30, "an empty key boots on 30");
  assert.equal(read(0), 0, "0 is the off switch and is kept");
  assert.equal(read("0"), 0, "a string 0 is still off");
  assert.equal(read(12), 12, "a number is the number");
  assert.equal(read("nonsense"), 30, "a typo never silently disables it");
  assert.equal(read(-5), 30, "a negative is a typo");
  assert.equal(read(99999), 3600, "an absurd number is clamped");
  assert.match(serverSource, /collapseAfterSeconds: config\.collapseAfterSeconds/, "the number travels with every snapshot");
  assert.equal(settingsSource.split('"/api/settings/collapse-after"').length - 1, 1, "one route writes it");
  assert.equal(serverSource.split('"/api/settings/collapse-after"').length - 1, 0, "and the chain no longer answers it");
});

test("the Board tab carries one number field for it, and its title says what 0 does", () => {
  assert.equal(html.split('id="collapse-after"').length - 1, 1, "#collapse-after exists exactly once in the page");
  const start = html.indexOf('data-settings-group="board"');
  const board = html.slice(start, html.indexOf('<div class="settings-group', start + 10));
  const row = board.match(/<label class="settings-row[^"]*" for="collapse-after" title="([^"]+)">([\s\S]*?)<\/label>/);
  assert.ok(row, "the field is a labelled settings row in the Board panel");
  assert.match(row[2], /id="collapse-after" type="number"/, "it is a number field");
  assert.match(row[2], /min="0"/, "0 is allowed — it is the off switch");
  assert.match(row[1], /0 turns the cascade off/, "the title says what 0 does");
  assert.match(row[1], /expanding the parent draws them minimized/, "…and what the cascade does");
});
