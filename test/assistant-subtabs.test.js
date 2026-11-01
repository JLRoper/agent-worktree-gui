// The assistant float's two tab rows: the sessions on the top row, a session's own Chat and Settings on the quiet
// row under them, and one {assistant, subTab} record behind both.
//
// The mechanism is the page's, not a node module, so this drives the page's own region the way
// settings-groups.test.js does — sliced out of public/assistant.js and run against a stub document and a stub
// localStorage. What it pins:
//
//   1. the top row is the assistant plus its lists — "Assistant #1" where "Chat" was, no Settings tab beside it, and
//      a Role tab where the Charter tab was — and the session's row is the very next row in the markup, carrying
//      Chat then Settings;
//   2. the markup and the code agree on every name: LISTS is the lists' ids in the row's order, SUBTABS are the
//      second row's, and the SESSIONS are not a constant at all — they are the records the server sends;
//   3. both of a session's panes are inside the session's own pane, so Settings moved down a level rather than
//      becoming a second float;
//   4. one record, {assistant, subTab}: a press writes it, a reload reads it back — the same two fields, the same
//      names, no second copy of "which tab" anywhere in the file;
//   5. the second row belongs to the session: it is hidden while a list is showing and comes back with the sub-tab
//      the reader left on it;
//   6. the old single-tab record is read once and never rewritten (a reader who left the float on Settings stays
//      on Settings, but under Assistant #1; the old "charter" name lands on Role), and a name this build no longer
//      knows reads as the default;
//   7. a SECOND assistant is one more RECORD and one more pane — the button and the pane are created from the record
//      itself, with no new branch and no edit to any list, which is what "shows it in the top tab row" has to mean.
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
// The lists the row carries in its markup. The sessions are NOT in here: the painter builds their buttons from the
// assistant records, so the markup names only the lists and Assistant #1.
const listKeys = topRow.filter((t) => !t.key.startsWith("assistant-")).map((t) => t.key);

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
// The region owns the record, the two painters and the per-session id scheme; everything else is a stub of what the
// page hands it.
const region = sliceRegion(assistant, "the float's two rows");

const build = (src) =>
  new Function(
    "state",
    "localStorage",
    "document",
    "as$",
    "renderAssistant",
    `${src}
return { readView, writeView, legacyView, setView, syncSessionTabs, paintAssistantTabs, isAssistant,
  sessionRecords, sessionById, assistantIds, tabsNow, activeSessionId, paneIdFor, hostFor,
  LISTS, SUBTABS, FIRST_ASSISTANT, DEFAULT_VIEW, VIEW_KEY, TAB_KEY };`,
  );

// A DOM node: the few properties `syncSessionTabs` and `paintAssistantTabs` touch, plus the row's own two lookups.
const el = ({ dataset = {}, cls = [], id = "", text = "" } = {}) => {
  const set = new Set(cls);
  const node = {
    dataset,
    id,
    textContent: text,
    className: "",
    hidden: false,
    children: [],
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
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      const i = ref ? node.children.indexOf(ref) : -1;
      if (i < 0) node.children.push(child);
      else node.children.splice(i, 0, child);
      return child;
    },
    querySelectorAll: (sel) => (sel === "[data-as-tab]" ? node.children.filter((c) => c.dataset.asTab) : []),
    get firstElementChild() {
      return node.children[0] || null;
    },
  };
  return node;
};

// One page: a store, the records the server would have sent, a DOM built from the markup's ids, and the view the
// boot would have read. `rows` lets a test start from a DOM that does NOT yet carry a record — that is how the
// painter's own creation path is driven.
const page = ({
  seed = null,
  legacy = null,
  src = region,
  records = [{ id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant" }],
  rows = null,
} = {}) => {
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
  const tabsRow = el({ id: "as-tabs" });
  const body = el({ id: "as-body" });
  const subbarbar = el({ id: "as-subtabs" });
  const subtabs = subRow.map((r) => el({ dataset: { asSubtab: r.key }, cls: r.key === "chat" ? ["is-on"] : [] }));
  const document = {
    querySelectorAll: (sel) =>
      sel === "#as-tabs [data-as-tab]" ? tabsRow.children
        : sel === "#as-subtabs [data-as-subtab]" ? subtabs
          : sel === "#assistant .as-pane" ? body.children
            : sel === "#assistant .as-subpane" ? body.children.flatMap((p) => [...p.children])
              : [],
    querySelector: (sel) => {
      if (sel === "#as-tabs") return tabsRow;
      if (sel === "#assistant .as-body") return body;
      const m = /^#as-tabs \[data-as-tab="([^"]+)"\]$/.exec(sel);
      return m ? tabsRow.children.find((t) => t.dataset.asTab === m[1]) || null : null;
    },
    getElementById: (id) => {
      if (id === "as-subtabs") return subbarbar;
      if (id === "as-tabs") return tabsRow;
      const walk = (nodes) => {
        for (const n of nodes) {
          if (n.id === id) return n;
          const hit = walk(n.children);
          if (hit) return hit;
        }
        return null;
      };
      return walk(body.children);
    },
    createElement: (tag) => {
      const n = el();
      n.tag = tag;
      return n;
    },
    activeElement: null,
  };
  const state = { assistantView: null, assistant: { assistants: records } };
  let renders = 0;
  // setView repaints through renderAssistant, so the stub repaints the way the page does: one painter, driven from
  // the record. The counter proves the press actually asked for a repaint rather than painting inline.
  let repaint = () => {};
  const api = build(src)(state, localStorage, document, (id) => document.getElementById(id), () => {
    renders += 1;
    repaint();
  });

  // The DOM the served markup describes: one button per row key, one pane per key, a session's two sub-panes inside
  // its own pane. Ids come from the page's own `paneIdFor`, so a second assistant's ids are the page's, not a copy.
  const rowKeys = rows || [...records.map((r) => r.id), ...listKeys];
  for (const key of rowKeys) {
    tabsRow.appendChild(el({ dataset: { asTab: key }, cls: key === "assistant-1" ? ["is-on"] : [], text: records.find((r) => r.id === key)?.name || "" }));
  }
  for (const key of rowKeys) {
    const pane = el({ dataset: { pane: key }, cls: key === "assistant-1" ? [] : ["hidden"], id: `as-${key}` });
    if (key.startsWith("assistant-")) {
      for (const s of subRow) pane.appendChild(el({ dataset: { subpane: s.key }, cls: s.key === "chat" ? [] : ["hidden"], id: api.paneIdFor(key, s.key) }));
    }
    body.appendChild(pane);
  }

  state.assistantView = api.readView();
  repaint = api.paintAssistantTabs;
  api.paintAssistantTabs();
  return {
    api,
    state,
    store,
    writes,
    records,
    renders: () => renders,
    tabs: () => tabsRow.children,
    body,
    subbarbar,
    on: () => tabsRow.children.filter((t) => t.classList.contains("is-on")).map((t) => t.dataset.asTab),
    subOn: () => subtabs.filter((t) => t.classList.contains("is-on")).map((t) => t.dataset.asSubtab),
    visiblePanes: () => body.children.filter((p) => !p.classList.contains("hidden")).map((p) => p.dataset.pane),
    visibleSubs: () => {
      const pane = body.children.find((p) => !p.classList.contains("hidden"));
      return pane ? pane.children.filter((s) => !s.classList.contains("hidden")).map((s) => s.dataset.subpane) : [];
    },
    /** A press on a button in either row, exactly as the handlers call it. */
    pressTab: (key) => api.setView({ assistant: key }),
    pressSub: (key) => api.setView({ subTab: key }),
    /** What a reload does: the same store, a page built from scratch, the record read back. */
    reload: () => page({ seed: api.readView(), src, records, rows: null }),
  };
};

test("the top row is the assistant and its lists, and the session's row is the very next row", () => {
  assert.deepEqual(
    topRow.map((t) => t.key),
    ["assistant-1", "alerts", "watches", "messages", "pad", "role"],
    "the float's own row",
  );
  assert.equal(topRow[0].label, "Assistant #1", "the tab that was Chat is titled Assistant #1");
  assert.ok(
    !topRow.some((t) => t.key === "chat" || t.key === "settings"),
    "Chat and Settings are no longer tabs of the float's own row",
  );
  assert.ok(!topRow.some((t) => t.key === "charter"), "the Charter tab is gone from the row");
  assert.match(topRow[5].label, /^Role$/, "and the tab that replaced it is the Role tab");
  assert.match(float, /data-as-tab="role" title="the role this assistant runs/, "whose tooltip says what it edits");
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
    ["assistant-1", "alerts", "watches", "messages", "pad", "role"],
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
  assert.deepEqual(api.LISTS, listKeys, "LISTS is the lists' ids, in the row's order");
  assert.deepEqual(api.SUBTABS, subRow.map((t) => t.key), "SUBTABS is the second row, in its order");
  assert.deepEqual(api.tabsNow(), topRow.map((t) => t.key), "tabsNow() is the whole row, in its order");
  assert.deepEqual(api.sessionRecords().map((r) => r.id), ["assistant-1"], "the sessions are the records");
  assert.deepEqual(api.DEFAULT_VIEW, { assistant: "assistant-1", subTab: "chat" }, "the float opens on the thread");
  assert.ok(api.isAssistant("assistant-1") && !api.isAssistant("alerts"), "a list is not a session");
  // The session list is data now: a constant here is a second source of truth for which assistants exist.
  assert.doesNotMatch(assistant, /const ASSISTANTS\b/, "there is no hard-coded assistant list left in the file");
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
  assert.deepEqual(page({ legacy: "charter" }).state.assistantView, { assistant: "role", subTab: "chat" },
    "and the tab that was Charter lands on the Role tab that replaced it");
  assert.deepEqual(page({ legacy: "nonsense" }).state.assistantView, { assistant: "assistant-1", subTab: "chat" });
  // Migrating is a read: it does not write the old key, and the first press writes only the new one.
  const p = page({ legacy: "settings" });
  assert.deepEqual(p.writes.filter((k) => k === "wm.assistantTab"), [], "the legacy key is never written");
  p.pressSub("chat");
  assert.equal(p.store.get("wm.assistantTab"), "settings", "and its old value is left alone");
  assert.deepEqual(p.store.get("wm.assistantView"), '{"assistant":"assistant-1","subTab":"chat"}');
});

test("a second assistant is one more record and one more pane — no new branch", () => {
  const records = [
    { id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant" },
    { id: "assistant-2", name: "Assistant #2", threadId: "panel-assistant-2" },
  ];
  // The DOM as the served markup stands: Assistant #1's button and pane, no second session anywhere.
  const p = page({ records, rows: ["assistant-1", ...listKeys] });
  assert.deepEqual(p.api.tabsNow(), ["assistant-1", "assistant-2", ...listKeys], "the row follows the records");
  assert.equal(p.api.sessionById("assistant-2").threadId, "panel-assistant-2");
  assert.equal(p.api.paneIdFor("assistant-2", "chat"), "as-chat-2", "the second session's pane id is derived");
  assert.equal(p.api.hostFor("assistant-2", "chat").id, "as-chat-2", "and resolves to it");

  // The painter creates the button and the pane from the record — unprompted, since the markup does not carry them.
  assert.ok(p.tabs().some((t) => t.dataset.asTab === "assistant-2"), "its tab was added to the row");
  assert.deepEqual(p.tabs().map((t) => t.dataset.asTab).slice(0, 2), ["assistant-1", "assistant-2"], "at the head, beside #1");
  const pane = p.body.children.find((x) => x.dataset.pane === "assistant-2");
  assert.ok(pane, "and its own pane");
  assert.deepEqual(pane.children.map((s) => s.dataset.subpane), ["chat", "settings"], "with its own two sub-panes");

  p.pressSub("settings");
  p.pressTab("assistant-2");
  assert.deepEqual(p.state.assistantView, { assistant: "assistant-2", subTab: "settings" });
  assert.deepEqual(p.on(), ["assistant-2"], "the second session lights its own tab");
  assert.deepEqual(p.visiblePanes(), ["assistant-2"], "and only its own pane shows");
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
  // The chat card still claims the float: EVERY session's pane and its chat pane are pass-through boxes, so a second
  // assistant gets the same layout from the same rules rather than a rule of its own.
  assert.match(css, /\.as-pane\[data-pane\^="assistant-"\]\s*\{[^}]*padding:\s*0/, "a session pane has no padding of its own");
  assert.match(css, /\.as-pane\[data-pane\^="assistant-"\]:not\(\.hidden\)\s*\{[^}]*display:\s*flex[^}]*min-height:\s*0/);
  assert.match(css, /\.as-subpane\[data-subpane="chat"\]:not\(\.hidden\)\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*min-height:\s*0/);
  assert.match(rule(".as-subpane.hidden"), /display:\s*none/, "a sub-pane that is not showing takes no room");
});
