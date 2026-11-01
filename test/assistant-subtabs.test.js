// The assistant float's two tab rows: the sessions on the top row, a session's own Chat and Settings on the quiet
// row under them, and one {assistant, subTab} record behind both.
//
// The mechanism is the page's, not a node module, so this drives the page's own region the way
// settings-groups.test.js does — sliced out of public/assistant.js and run against a stub document and a stub
// localStorage. What it pins:
//
//   1. the top row is the assistant plus its lists — "Assistant #1" where "Chat" was, and no Settings tab beside it —
//      and the session's row is the very next row in the markup, carrying Chat then Settings;
//   2. the markup and the code agree on every name: TABS is the top row's ids, ASSISTANTS are the sessions,
//      SUBTABS are the second row's, so neither can be edited without the other going red;
//   3. both of a session's panes are inside the session's own pane, so Settings moved down a level rather than
//      becoming a second float;
//   4. one record, {assistant, subTab}: a press writes it, a reload reads it back — the same two fields, the same
//      names, no second copy of "which tab" anywhere in the file;
//   5. the second row belongs to the session: it is hidden while a list is showing and comes back with the sub-tab
//      the reader left on it;
//   6. the old single-tab record is read once and never rewritten (a reader who left the float on Settings stays
//      on Settings, but under Assistant #1), and a name this build no longer knows reads as the default;
//   7. a SECOND assistant is an entry in the list and a pane in the page — the same source, with one more id in
//      ASSISTANTS, switches rows and panes with no new branch, which is what "without a rewrite" has to mean.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");

// ---- the markup ----------------------------------------------------------------------------------------
const float = html.slice(html.indexOf('<aside id="assistant"'), html.indexOf('<div id="settings"'));
assert.ok(float.length > 1000, "index.html must carry the assistant float");

const rowOf = (id, attr) => {
  const start = float.indexOf(`id="${id}"`);
  assert.ok(start > 0, `the float must carry #${id}`);
  const open = float.lastIndexOf("<div", start);
  const body = float.slice(open, float.indexOf("</div>", start));
  return [...body.matchAll(new RegExp(`<button[^>]*data-${attr}="([^"]+)"[^>]*>([\\s\\S]*?)</button>`, "g"))].map(
    ([, key, label]) => ({ key, label: label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() }),
  );
};
const topRow = rowOf("as-tabs", "as-tab");
const subRow = rowOf("as-subtabs", "as-subtab");

const paneOf = (id) => {
  const at = float.indexOf(`id="${id}"`);
  assert.ok(at > 0, `the float must carry #${id}`);
  const open = float.lastIndexOf("<section", at);
  return float.slice(open, at + 200);
};
const panes = [...float.matchAll(/<section class="as-pane[^"]*" data-pane="([^"]+)" id="([^"]+)">/g)].map(
  ([, key, id]) => ({ key, id }),
);

// ---- the code, sliced and driven ---------------------------------------------------------------------
// The region owns the record and the painter; everything else here is a stub of what the page hands it.
const region = sliceRegion(assistant, "the float's two rows");

const build = (src) =>
  new Function(
    "state",
    "localStorage",
    "document",
    "as$",
    "renderAssistant",
    `${src}
return { readView, writeView, legacyView, setView, paintAssistantTabs, isAssistant,
  ASSISTANTS, SUBTABS, TABS, DEFAULT_VIEW, VIEW_KEY, TAB_KEY };`,
  );

const el = (dataset, cls = []) => {
  const set = new Set(cls);
  return {
    dataset,
    hidden: false,
    classList: {
      toggle(name, on) {
        if (on) set.add(name);
        else set.delete(name);
      },
      contains: (name) => set.has(name),
      get on() {
        return [...set];
      },
    },
  };
};

// One page: a store, a DOM built from the ids the markup carries, and the view the boot would have read.
const page = ({ seed = null, legacy = null, src = region, rows = topRow, subs = subRow } = {}) => {
  const store = new Map();
  const writes = [];
  if (seed !== null) store.set("wm.assistantView", JSON.stringify(seed));
  if (legacy !== null) store.set("wm.assistantTab", legacy);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      writes.push(k);
      store.set(k, String(v));
    },
  };
  const tabs = rows.map((r) => el({ asTab: r.key }, r.key === "assistant-1" ? ["is-on"] : []));
  const subtabs = subs.map((r) => el({ asSubtab: r.key }, r.key === "chat" ? ["is-on"] : []));
  const paneKeys = [
    ...new Set([
      ...rows.filter((r) => r.key.startsWith("assistant-")).map((r) => r.key),
      "alerts",
      "watches",
      "messages",
      "pad",
      "charter",
    ]),
  ];
  const panesEl = paneKeys.map((key) => el({ pane: key }, key === "assistant-1" ? [] : ["hidden"]));
  const subpanes = subtabs.map((b) => el({ subpane: b.dataset.asSubtab }, b.dataset.asSubtab === "chat" ? [] : ["hidden"]));
  const subbarbar = el({}, []);
  const document = {
    querySelectorAll: (sel) =>
      sel === "#as-tabs [data-as-tab]" ? tabs : sel === "#as-subtabs [data-as-subtab]" ? subtabs
        : sel === "#assistant .as-pane" ? panesEl : sel === "#assistant .as-subpane" ? subpanes : [],
    getElementById: (id) => (id === "as-subtabs" ? subbarbar : null),
  };
  const state = { assistantView: null };
  let renders = 0;
  // setView repaints through renderAssistant, so the stub repaints the way the page does: one painter, driven from
  // the record. The counter proves the press actually asked for a repaint rather than painting inline.
  let repaint = () => {};
  const api = build(src)(state, localStorage, document, (id) => (id === "as-subtabs" ? subbarbar : null), () => {
    renders += 1;
    repaint();
  });
  state.assistantView = api.readView();
  repaint = api.paintAssistantTabs;
  api.paintAssistantTabs();
  return {
    api,
    state,
    store,
    writes,
    renders: () => renders,
    tabs,
    subtabs,
    panesEl,
    subpanes,
    subbarbar,
    on: () => tabs.filter((t) => t.classList.contains("is-on")).map((t) => t.dataset.asTab),
    subOn: () => subtabs.filter((t) => t.classList.contains("is-on")).map((t) => t.dataset.asSubtab),
    visiblePanes: () => panesEl.filter((p) => !p.classList.contains("hidden")).map((p) => p.dataset.pane),
    visibleSubs: () => subpanes.filter((p) => !p.classList.contains("hidden")).map((p) => p.dataset.subpane),
    /** A press on a button in either row, exactly as the handlers call it. */
    pressTab: (key) => api.setView({ assistant: key }),
    pressSub: (key) => api.setView({ subTab: key }),
    /** What a reload does: the same store, a page built from scratch, the record read back. */
    reload: () => {
      const again = page({ seed: api.readView(), src, rows, subs });
      return again;
    },
  };
};

test("the top row is the assistant and its lists, and the session's row is the very next row", () => {
  assert.deepEqual(
    topRow.map((t) => t.key),
    ["assistant-1", "alerts", "watches", "messages", "pad", "charter"],
    "the float's own row",
  );
  assert.equal(topRow[0].label, "Assistant #1", "the tab that was Chat is titled Assistant #1");
  assert.ok(
    !topRow.some((t) => t.key === "chat" || t.key === "settings"),
    "Chat and Settings are no longer tabs of the float's own row",
  );
  assert.deepEqual(subRow.map((t) => t.key), ["chat", "settings"], "the session's row holds both");
  assert.deepEqual(subRow.map((t) => t.label), ["Chat", "Settings"]);
  // Beneath it in the document, with nothing but a comment in between: the row is the session's, not a second strip
  // somewhere else in the panel.
  assert.match(
    float,
    /id="as-tabs">[\s\S]*?<\/div>\s*<!--[\s\S]*?-->\s*<div class="as-subtabs" id="as-subtabs">/,
    "the sub-tab row sits immediately under the float's tabs",
  );
  // The Settings tab's own tooltip said what it is for; the sub-tab keeps the sentence rather than becoming a label.
  assert.match(subRow[1].label, /^Settings$/);
  assert.match(float, /data-as-subtab="settings" title="how aggressive it is, per rule"/);
});

test("both of a session's panes are inside the session's pane, so Settings moved down a level", () => {
  assert.deepEqual(
    panes.map((p) => p.key),
    ["assistant-1", "alerts", "watches", "messages", "pad", "charter"],
    "the float's top-level panes",
  );
  assert.ok(!panes.some((p) => p.key === "chat" || p.key === "settings"), "neither sub-tab is a top-level pane");
  const session = paneOf("as-assistant-1");
  assert.match(session, /class="as-subpane" data-subpane="chat" id="as-chat"/, "Chat is inside the session's pane");
  assert.match(session, /class="as-subpane hidden" data-subpane="settings" id="as-settings"/, "and so is Settings");
  // The ids the rest of the code and the harnesses drive are unchanged: only their place moved.
  assert.match(float, /id="as-chat"/);
  assert.match(float, /id="as-settings"/);
  assert.ok(!/data-pane="chat"/.test(html) && !/data-pane="settings"/.test(html), "the old flat panes are gone");
});

test("the markup and the code agree on every name in both rows", () => {
  const api = page().api;
  assert.deepEqual(api.TABS, topRow.map((t) => t.key), "TABS is the top row, in its order");
  assert.deepEqual(api.SUBTABS, subRow.map((t) => t.key), "SUBTABS is the second row, in its order");
  assert.deepEqual(api.ASSISTANTS, topRow.filter((t) => t.key.startsWith("assistant-")).map((t) => t.key), "the sessions");
  assert.deepEqual(api.DEFAULT_VIEW, { assistant: "assistant-1", subTab: "chat" }, "the float opens on the thread");
  assert.ok(api.isAssistant("assistant-1") && !api.isAssistant("alerts"), "a list is not a session");
  // Nothing else in the file holds a second opinion about which tab is on.
  assert.doesNotMatch(assistant, /state\.assistantTab/, "the single-tab state is gone, not shadowed");
});

test("a fresh page opens on Assistant #1's Chat, and a press writes {assistant, subTab}", () => {
  const p = page();
  assert.deepEqual(p.state.assistantView, { assistant: "assistant-1", subTab: "chat" });
  assert.deepEqual(p.visiblePanes(), ["assistant-1"]);
  assert.deepEqual(p.visibleSubs(), ["chat"]);
  assert.equal(p.subbarbar.hidden, false, "the session's row is up with the session");

  p.pressSub("settings");
  assert.deepEqual(p.state.assistantView, { assistant: "assistant-1", subTab: "settings" });
  assert.deepEqual(p.store.get("wm.assistantView"), '{"assistant":"assistant-1","subTab":"settings"}');
  assert.deepEqual(p.writes, ["wm.assistantView"], "one key is written — no second copy of the tab");
  assert.deepEqual(p.visibleSubs(), ["settings"], "Settings is the one showing");
  assert.deepEqual(p.subOn(), ["settings"]);
  assert.deepEqual(p.on(), ["assistant-1"], "and the session above it is still the tab on screen");
});

test("the sub-tabs switch and survive a reload — for the session and for a list", () => {
  const p = page();
  p.pressSub("settings");
  const reloaded = p.reload();
  assert.deepEqual(reloaded.state.assistantView, { assistant: "assistant-1", subTab: "settings" }, "read back as written");
  assert.deepEqual(reloaded.on(), ["assistant-1"]);
  assert.deepEqual(reloaded.subOn(), ["settings"]);
  assert.deepEqual(reloaded.visiblePanes(), ["assistant-1"]);
  assert.deepEqual(reloaded.visibleSubs(), ["settings"]);
  assert.equal(reloaded.subbarbar.hidden, false);

  // A list is a different tab, so the session's row goes away with it — and comes back where it was left.
  reloaded.pressTab("alerts");
  assert.deepEqual(reloaded.state.assistantView, { assistant: "alerts", subTab: "settings" }, "the sub-tab is kept");
  assert.equal(reloaded.subbarbar.hidden, true, "no session on screen, no session row");
  assert.deepEqual(reloaded.visiblePanes(), ["alerts"]);
  const again = reloaded.reload();
  assert.deepEqual(again.on(), ["alerts"]);
  assert.equal(again.subbarbar.hidden, true);
  again.pressTab("assistant-1");
  assert.deepEqual(again.subOn(), ["settings"], "the session opens on the sub-tab it was left on");
  assert.deepEqual(again.visibleSubs(), ["settings"]);
});

test("the old single-tab record is read once, and never rewritten", () => {
  assert.deepEqual(page({ legacy: "settings" }).state.assistantView, { assistant: "assistant-1", subTab: "settings" },
    "a reader parked on the old Settings tab lands on Assistant #1's Settings");
  assert.deepEqual(page({ legacy: "chat" }).state.assistantView, { assistant: "assistant-1", subTab: "chat" });
  assert.deepEqual(page({ legacy: "alerts" }).state.assistantView, { assistant: "alerts", subTab: "chat" });
  assert.deepEqual(page({ legacy: "nonsense" }).state.assistantView, { assistant: "assistant-1", subTab: "chat" });
  // Migrating is a read: it does not write the old key, and the first press writes only the new one.
  const p = page({ legacy: "settings" });
  assert.deepEqual(p.writes.filter((k) => k === "wm.assistantTab"), [], "the legacy key is never written");
  p.pressSub("chat");
  assert.equal(p.store.get("wm.assistantTab"), "settings", "and its old value is left alone");
  assert.deepEqual(p.store.get("wm.assistantView"), '{"assistant":"assistant-1","subTab":"chat"}');
});

test("a second assistant is one more id and one more pane — no new branch", () => {
  const src = region.replace('const ASSISTANTS = ["assistant-1"];', 'const ASSISTANTS = ["assistant-1", "assistant-2"];');
  assert.notEqual(src, region, "the fixture must actually add the second assistant to the list");
  const rows = [...topRow.slice(0, 1), { key: "assistant-2", label: "Assistant #2" }, ...topRow.slice(1)];
  const p = page({ src, rows });
  assert.deepEqual(p.api.ASSISTANTS, ["assistant-1", "assistant-2"]);
  assert.deepEqual(p.api.TABS, rows.map((r) => r.key), "the top row follows the list");
  p.pressSub("settings");
  p.pressTab("assistant-2");
  assert.deepEqual(p.state.assistantView, { assistant: "assistant-2", subTab: "settings" });
  assert.deepEqual(p.on(), ["assistant-2"], "the second session lights its own tab");
  assert.deepEqual(p.visiblePanes().filter((k) => k.startsWith("assistant-")), ["assistant-2"], "and its own pane");
  assert.equal(p.subbarbar.hidden, false, "the one row of sub-tabs serves whichever session is showing");
  assert.deepEqual(p.subOn(), ["settings"], "and follows the record it was left on");
  const reloaded = p.reload();
  assert.deepEqual(reloaded.on(), ["assistant-2"], "which survives a reload with no other change");
});

test("the stylesheet gives the second row a row, and lets it go away", () => {
  const rule = (sel) => {
    const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, s]) => s.split(",").map((x) => x.trim()).includes(sel));
    return m ? m[2] : "";
  };
  assert.match(rule(".as-subtabs"), /display:\s*flex/, "the row is a row");
  assert.match(rule(".as-subtabs"), /border-bottom:/, "and reads as one under the tabs above it");
  assert.match(rule(".as-subtabs[hidden]"), /display:\s*none/, "a hidden row must not paint");
  assert.match(rule(".as-subtabs button.is-on"), /color:/, "the one showing is marked");
  // The chat card still claims the float: the session pane and the chat pane are both pass-through boxes.
  assert.match(css, /\.as-pane\[data-pane="assistant-1"\]\s*\{[^}]*padding:\s*0/, "the session pane has no padding of its own");
  assert.match(css, /\.as-pane\[data-pane="assistant-1"\]:not\(\.hidden\)\s*\{[^}]*display:\s*flex[^}]*min-height:\s*0/);
  assert.match(css, /#as-chat:not\(\.hidden\)\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*min-height:\s*0/);
  assert.match(rule(".as-subpane.hidden"), /display:\s*none/, "a sub-pane that is not showing takes no room");
});
