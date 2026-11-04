// The assistant's settings, split in two: the WATCHDOG tab (the panel's one sentry) and a SESSION's Settings tab
// (one assistant's own knobs).
//
// Ten number inputs and seven behaviour rows used to sit in ONE pane, so nothing on the page said which of them
// belonged to the panel and which to the assistant in front of you — and a second assistant drew the panel-wide
// ones again, as if they were its own. This drives the page's own `renderWatchdog` and `renderAssistantSettings`
// (the settings region is sliced out of public/assistant.js and run against stub hosts, the way
// settings-groups.test.js runs the panel's fold region) and pins:
//
//   1. every knob with an owner renders exactly once, in the pane that owner names, and NO key renders in both;
//   2. each bar the PASS owns sits inside the <details> of the rule that reads it, the two quiet windows (which are
//      an assistant's) carry no disclosure there and are named as that assistant's instead;
//   3. the session's pane draws its own knobs only — model, autonomy, spawn, cwd, the wake budget, the quiet
//      windows — plus the escalation list, rendered EMPTY rather than missing;
//   4. every input keeps its exact key, its min/max and the aggressive-mode disabled/title handling, in whichever
//      pane draws it;
//   5. the disclosures ship closed, and the one localStorage key holds the ids the reader left open;
//   6. a re-render repaints the pane that owns the key only, so the delegated [data-as-set] handler still applies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";
import { ASSISTANT_KEYS, DEFAULTS, RULE_DEFS, SETTINGS_SCOPE, WATCHDOG_KEYS } from "../lib/assistant/config.js";

const src = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");

const begin = src.indexOf("// ---- settings ---");
const end = src.indexOf("// ---- talking to the server");
assert.ok(begin > 0 && end > begin, "the settings region is in public/assistant.js");
const settings = src.slice(begin, end);
// Both paints resolve their host per pane (`as$("as-watchdog")`, `hostFor(id, "settings")`), and those helpers live
// in the tab region above it. Both regions are sliced — in the page's own order — so the lookup under test is the
// page's, not a copy of it. The painters come along unused; nothing here calls one.
const region = `${sliceRegion(src, "the float's two rows")}\n${settings}`;

// The contract, written out here rather than read back off the page: a test that takes the page's own table as its
// expectation proves only that the table agrees with itself.
const PASS_THRESHOLD = {
  loop: "repeatLimit",
  approval: "approvalSeconds",
  exited: "exitedSeconds",
  context: "contextPercent",
  repeat: "repeatTurns",
  leftover: "leftoverMinutes",
};
// The two bars that are an ASSISTANT's quiet windows, not the pass's: they are drawn in the session's pane, and the
// rule row in the watchdog pane names where they went instead of drawing a second control for them.
const ASSISTANT_THRESHOLD = { quiet: "quietSeconds", child: "childQuietSeconds" };
// The rules that are judgement calls with nothing to tune — no disclosure, and no number input either.
const NO_THRESHOLD = ["question", "noevidence", "collision", "interrupted", "settle", "watch", "spawnidle", "spawnlost", "errorloop"];
// What each input must carry after the move, so a key cannot keep its name and lose its bound.
const BOUNDS = {
  seconds: [2, 120],
  repeatLimit: [2, 12],
  quietSeconds: [30, 3600],
  approvalSeconds: [15, 3600],
  exitedSeconds: [0, 3600],
  contextPercent: [50, 100],
  leftoverMinutes: [1, 240],
  childQuietSeconds: [60, 3600],
  repeatTurns: [2, 10],
  maxWakesPerHour: [0, 60],
};
// The wording each summary carries, matched against the mid-dot format the page draws.
const PHRASE = {
  loop: (v) => `same call × ${v}`,
  approval: (v) => `approval waiting ${v} s`,
  exited: (v) => `exited for ${v} s`,
  context: (v) => `context over ${v} %`,
  repeat: (v) => `same failure × ${v}`,
  leftover: (v) => `leftover work ${v} min`,
};
// The keys each pane draws, written out: a control that quietly stops rendering is a failure too. `rearmSeconds` is a
// knob with no control (it has always been one), which is why it is in the table and not in this list.
const WATCHDOG_DRAWN = ["approvalSeconds", "commandAudit", "contextPercent", "enabled", "exitedSeconds", "leftoverMinutes", "repeatLimit", "repeatTurns", "seconds", "spawnAutoStart"];
const ASSISTANT_DRAWN = ["autonomy", "childQuietSeconds", "cwd", "maxWakesPerHour", "model", "quietSeconds", "spawn"];

const esc = (v) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page({ settings: own = {}, aggressive = null, open = null, second = false, escalate = [], assistants = null } = {}) {
  const store = new Map();
  if (open !== null) store.set("wtgui.assistantThresholdsOpen", JSON.stringify(open));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  const hosts = new Map();
  // The settings pane is also where the aggressive switch is inserted (one node, moved into whichever pane is
  // showing), so the stub host takes an insertion and reports no first child. The painters themselves are handed
  // in below; this test asserts the settings markup, not the switch.
  const host = (id) => ({ innerHTML: "", firstElementChild: null, insertBefore() {}, querySelector: () => null, querySelectorAll: () => [] });
  for (const id of ["as-settings", "as-settings-2", "as-watchdog"]) hosts.set(id, host(id));
  const document = { getElementById: (id) => hosts.get(id) || null, activeElement: null };
  const records = assistants || [
    { id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant", rules: [] },
    ...(second ? [{ id: "assistant-2", name: "Assistant #2", threadId: "panel-assistant-2", rules: [], profile: { path: "assistants/assistant-2/settings.json" } }] : []),
  ];
  const base = { ...DEFAULTS, rules: { ...DEFAULTS.rules }, ...own };
  const state = {
    assistant: {
      settings: base,
      // A second assistant's knobs, resolved by the server out of its own file. Distinct on purpose: a pane that
      // borrowed #1's would pass a test that fed it the same numbers.
      assistantSettings: second ? { "assistant-2": { ...DEFAULTS, rules: { ...DEFAULTS.rules }, autonomy: "auto", model: "some/other-model", maxWakesPerHour: 3 } } : {},
      settingScope: SETTINGS_SCOPE,
      escalateTo: { "assistant-1": escalate, ...(second ? { "assistant-2": [] } : {}) },
      ruleDefs: RULE_DEFS,
      escalations: ["log", "alert", "wake", "act"],
      autonomy: ["draft", "auto-safe", "auto"],
      spawnModes: ["off", "ask", "auto"],
      commandAuditModes: ["off", "report", "enforce"],
      health: {},
      aggressive: aggressive || { on: false, restore: null, holds: { settings: [], rules: [] } },
      sweeps: { lastHour: 0, limit: DEFAULTS.maxWakesPerHour },
      wakePending: 0,
      assistants: records,
    },
  };
  // `as$` is the float's own lookup, declared above the region in public/assistant.js — handed in rather than
  // copied, so the paint under test is the page's function and not a paraphrase of it.
  const api = new Function(
    "document",
    "localStorage",
    "state",
    "esc",
    "typingInside",
    "sentryState",
    "ModelMenu",
    "as$",
    "aggressiveBlock",
    "paintAggressive",
    `${region}; return { renderAssistantSettings, renderWatchdog, FIRST_ASSISTANT, RULE_THRESHOLDS, THRESHOLDS_OPEN_KEY, thresholdsOpen, saveThresholdsOpen, rememberThresholdOpen, thresholdSummary, ownsWatchdog, scopeOfKey };`,
  )(document, localStorage, state, esc, () => false, () => null, { attach() {} }, (id) => document.getElementById(id), () => ({ nodeType: 1 }), () => {});
  return { ...api, hosts, host, store, state };
}

// Both panes in one pass: the watchdog's HTML and Assistant #1's (or #2's) settings HTML.
const render = (opts = {}, id = "assistant-1") => {
  const p = page(opts);
  p.renderWatchdog(true);
  p.renderAssistantSettings(id, true);
  return { ...p, html: p.hosts.get("as-watchdog").innerHTML, own: p.hosts.get(id === "assistant-1" ? "as-settings" : `as-settings-${id.replace(/^assistant-/, "")}`).innerHTML };
};

const count = (html, needle) => html.split(needle).length - 1;
const inputTag = (html, key) => (html.match(new RegExp(`<input[^>]*data-as-set="${key}"[^>]*>`)) || [])[0];
const setKeys = (html) => [...html.matchAll(/data-as-set="([^"]+)"/g)].map((m) => m[1]);

function detailsBlocks(html) {
  const out = new Map();
  for (const m of html.matchAll(/<details class="as-rule-thresholds" data-as-rule-thresholds="([^"]+)"([^>]*)>([\s\S]*?)<\/details>/g)) {
    out.set(m[1], { attrs: m[2], body: m[3], at: m.index });
  }
  return out;
}

function group(html, heading) {
  const at = html.indexOf(`<h4>${heading}</h4>`);
  assert.ok(at > 0, `the HTML carries a ${heading} group`);
  const next = html.indexOf('<div class="as-group">', at + 10);
  return html.slice(at, next > at ? next : html.length);
}

test("the ownership table is a partition: every knob has exactly one pane, and the two panes' keys never overlap", () => {
  // The server's table is the authority the page reads, so the partition is asserted on it...
  const overlapping = WATCHDOG_KEYS.filter((k) => ASSISTANT_KEYS.includes(k));
  assert.deepEqual(overlapping, [], "no key is owned by both panes");
  assert.deepEqual([...WATCHDOG_KEYS, ...ASSISTANT_KEYS].sort(), Object.keys(SETTINGS_SCOPE).sort(), "every declared key appears once");
  assert.deepEqual(Object.keys(DEFAULTS).sort(), [...WATCHDOG_KEYS, ...ASSISTANT_KEYS].filter((k) => k in DEFAULTS).sort(), "every knob in DEFAULTS has an owner");
  // ...and on what the two paints actually draw.
  const { html, own, ownsWatchdog } = render();
  const warned = setKeys(html);
  const mine = setKeys(own);
  assert.deepEqual(warned.filter((k) => mine.includes(k)), [], "no key is rendered in both tabs");
  assert.equal(new Set(warned).size, warned.length, `the watchdog pane draws each key once: ${warned.join(", ")}`);
  assert.equal(new Set(mine).size, mine.length, `the session pane draws each key once: ${mine.join(", ")}`);
  for (const key of [...warned, ...mine]) {
    assert.equal(ownsWatchdog(key), warned.includes(key), `${key} is drawn by the pane that owns it`);
    assert.ok(Object.hasOwn(SETTINGS_SCOPE, key), `${key} is declared in the ownership table`);
  }
  assert.deepEqual(warned.sort(), WATCHDOG_DRAWN, "the watchdog tab draws exactly the pass's knobs");
  assert.deepEqual(mine.sort(), ASSISTANT_DRAWN, "the session tab draws exactly that assistant's knobs");
  // The keys that are profile fields rather than knobs are that assistant's, and the session's pane does not draw a
  // second control for the Role tab's prompt.
  for (const key of ["prompt", "escalateTo"]) assert.equal(SETTINGS_SCOPE[key], "assistant");
  assert.ok(!mine.includes("prompt"), "the prompt stays in the Role tab");
});

test("each bar the pass owns sits inside the details of the rule that consumes it", () => {
  const { html, RULE_THRESHOLDS } = render();
  const blocks = detailsBlocks(html);
  assert.deepEqual([...blocks.keys()].sort(), Object.keys(PASS_THRESHOLD).sort(), "exactly the pass's rules carry a disclosure");

  for (const [id, key] of Object.entries(PASS_THRESHOLD)) {
    const block = blocks.get(id);
    assert.equal(count(block.body, `data-as-set="${key}"`), 1, `${key} renders once inside ${id}'s details`);
    // The page's own table agrees with the contract above, and the owner is the pass's.
    assert.deepEqual(RULE_THRESHOLDS[id].map((t) => t.key), [key], `${id} owns ${key} in the page's table`);
    assert.equal(SETTINGS_SCOPE[key], "watchdog", `${key} is a watchdog key`);
    // ...and the disclosure is the one directly under the ${id} rule's row, not another rule's.
    const before = [...html.slice(0, block.at).matchAll(/data-as-rule="([^"]+)"/g)];
    assert.equal(before.at(-1)[1], id, `${id}'s disclosure follows the ${id} rule row`);
  }

  // The two quiet windows are drawn in the SESSION's pane instead, and their rule rows say so rather than growing a
  // second control for a value that lives in an assistant's file.
  for (const [id, key] of Object.entries(ASSISTANT_THRESHOLD)) {
    assert.ok(!blocks.has(id), `${id} has no threshold disclosure in the watchdog pane`);
    assert.ok(!html.includes(`data-as-rule-thresholds="${id}"`), `${id} carries no threshold markup there`);
    assert.equal(SETTINGS_SCOPE[key], "assistant", `${key} is an assistant key`);
    assert.match(html, new RegExp(`data-as-rule="${id}"`), `${id} still has its escalation row`);
  }
  assert.equal(count(html, "is a quiet window of an assistant's, set in that assistant's"), 2, "quiet and child each name where their bar lives");

  for (const id of NO_THRESHOLD) {
    assert.ok(!blocks.has(id), `${id} has nothing to tune, so it has no disclosure`);
    assert.ok(!html.includes(`data-as-rule-thresholds="${id}"`), `${id} carries no threshold markup`);
  }
});

test("the summary names the count and the value in force, closed, and the long-build note moved with its bar", () => {
  const { html, own } = render();
  const blocks = detailsBlocks(html);
  for (const [id, key] of Object.entries(PASS_THRESHOLD)) {
    const summary = (blocks.get(id).body.match(/<summary[^>]*>([^<]*)<\/summary>/) || [])[1];
    assert.ok(summary, `${id} has a plain-text summary`);
    assert.equal(summary, `1 threshold · ${PHRASE[id](DEFAULTS[key])}`, `${id}'s summary states its bar`);
    assert.doesNotMatch(blocks.get(id).attrs, /\bopen\b/, `${id} ships closed`);
  }
  // The quiet rule's own explanation follows its bar, which is in the session's pane now.
  assert.equal(count(html, "A long build is silent too"), 0, "the watchdog pane no longer explains a bar it does not draw");
  assert.equal(count(own, "A long build is silent too"), 1, "the long-build note renders once, with the quiet window");
  assert.match(group(own, "Its wake budget and quiet windows"), /A long build is silent too/, "inside the group that owns it");
});

test("the session's pane draws its own knobs, and the watchdog's draws the panel's", () => {
  const { html, own } = render();
  // The session's pane keeps the heading the gate and the reader look for, and carries no panel-wide control.
  assert.ok(own.includes("<h4>How it behaves</h4>"), "Assistant #1's pane keeps its behaviour group");
  for (const key of WATCHDOG_DRAWN) assert.ok(!own.includes(`data-as-set="${key}"`), `${key} is not in the session's pane`);
  // The pass clock and the rule table are the watchdog's, and the session's pane says where they went.
  assert.match(html, /data-as-set="seconds"/);
  assert.match(html, /<h4>Per-rule escalation<\/h4>/);
  assert.match(own, /in the <b>Watchdog<\/b> tab/);
  assert.match(own, /in the <b>Role<\/b> tab/);
  // ...and the empty escalation list is RENDERED, not omitted: an assistant with nobody to hand to says so.
  const grp = group(own, "Escalate to — the assistants this one would hand a subject to");
  assert.match(grp, /\(empty — this assistant hands nothing to another one\)/);
  assert.match(grp, /data-as-escadd="assistant-1"/);
  assert.match(grp, /Nothing acts on it yet/, "the pane says the list is stored and inert");
});

test("the escalation list renders in the order it is stored, and never names its own assistant", () => {
  const { own } = render({ second: true, escalate: ["assistant-2"] }, "assistant-2");
  // #2's own list is empty (the server sends it), so its pane shows the empty state even though #1 has one.
  assert.match(own, /\(empty — this assistant hands nothing to another one\)/);
  const first = render({ second: true, escalate: ["assistant-2"] }, "assistant-1");
  const grp = group(first.own, "Escalate to — the assistants this one would hand a subject to");
  assert.match(grp, /1\. Assistant #2/, "the stored order is the drawn order");
  assert.match(grp, /data-as-escid="assistant-2"/);
  assert.equal(count(grp, "data-as-escdel="), 1, "one remove per entry");
  // A list that somehow carries the assistant itself drops it rather than drawing a self-hand-over.
  const self = render({ second: true, escalate: ["assistant-1", "assistant-2"] }, "assistant-1");
  assert.doesNotMatch(group(self.own, "Escalate to — the assistants this one would hand a subject to"), /data-as-escid="assistant-1"/);
});

test("every input keeps its key, its min and max, and the aggressive-mode disabled handling", () => {
  const { html, own } = render();
  const both = new Map([...setKeys(html).map((k) => [k, html]), ...setKeys(own).map((k) => [k, own])]);
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const tag = inputTag(both.get(key) || "", key);
    assert.ok(tag, `${key} has a number input`);
    assert.match(tag, new RegExp(`min="${min}"`), `${key} keeps min ${min}`);
    assert.match(tag, new RegExp(`max="${max}"`), `${key} keeps max ${max}`);
    assert.doesNotMatch(tag, /\bdisabled\b/, `${key} is editable with aggressive mode off`);
  }

  // Aggressive mode holds keys on BOTH sides: each pane disables and explains its own.
  const held = ["seconds", "repeatLimit", "quietSeconds", "maxWakesPerHour"];
  const aggressive = { on: true, restore: null, holds: { settings: held, rules: Object.keys(RULE_DEFS) } };
  const a = render({ aggressive });
  for (const key of ["seconds", "repeatLimit"]) {
    const tag = inputTag(a.html, key);
    assert.match(tag, /\bdisabled\b/, `${key} is disabled while aggressive mode holds it`);
    assert.match(tag, /title="aggressive mode holds this setting/, `${key} says why it cannot be changed`);
  }
  for (const key of ["quietSeconds", "maxWakesPerHour"]) {
    const tag = inputTag(a.own, key);
    assert.match(tag, /\bdisabled\b/, `${key} is disabled in the session's pane too`);
    assert.match(tag, /title="aggressive mode holds this setting/);
  }
  // The banner is on both panes, and the switch-off button exists exactly once — on the watchdog's.
  assert.match(a.html, /⚡ Aggressive mode is holding these/);
  assert.equal(count(a.html, 'id="btn-as-aggressive-off"'), 1, "one switch-off button, in the panel-wide tab");
  assert.equal(count(a.own, 'id="btn-as-aggressive-off"'), 0, "the session's pane points at it instead of repeating it");
  assert.match(a.own, /⚡ Aggressive mode is holding these/);
  // A pane with none of the held keys keeps quiet rather than showing a banner about somebody else's knobs.
  const onlyRules = render({ aggressive: { on: true, restore: null, holds: { settings: [], rules: Object.keys(RULE_DEFS) } } });
  assert.equal(count(onlyRules.own, "⚡ Aggressive mode is holding these"), 0, "nothing of the session's is held");
});

test("the open disclosures are remembered per browser under one key, and ship closed", () => {
  const fresh = render();
  assert.deepEqual([...detailsBlocks(fresh.html).values()].filter((b) => /\bopen\b/.test(b.attrs)), [], "a browser that never opened one shows none open");
  assert.equal(fresh.store.size, 0, "a first paint writes nothing");

  const remembered = render({ open: ["loop", "approval"] });
  const blocks = detailsBlocks(remembered.html);
  assert.match(blocks.get("loop").attrs, /\bopen\b/, "loop reopens from storage");
  assert.match(blocks.get("approval").attrs, /\bopen\b/, "approval reopens from storage");
  assert.doesNotMatch(blocks.get("exited").attrs, /\bopen\b/, "a disclosure the reader never opened stays closed");

  const p = page();
  assert.equal(p.THRESHOLDS_OPEN_KEY, "wtgui.assistantThresholdsOpen", "one key, named like the panel's other folds");
  p.rememberThresholdOpen({ dataset: { asRuleThresholds: "approval" }, open: true });
  assert.deepEqual([...p.store.keys()], ["wtgui.assistantThresholdsOpen"], "opening writes the one key and nothing else");
  assert.deepEqual(JSON.parse(p.store.get("wtgui.assistantThresholdsOpen")), ["approval"]);
  p.rememberThresholdOpen({ dataset: { asRuleThresholds: "loop" }, open: true });
  assert.deepEqual(JSON.parse(p.store.get("wtgui.assistantThresholdsOpen")), ["approval", "loop"], "a second opening joins the list");
  p.rememberThresholdOpen({ dataset: { asRuleThresholds: "approval" }, open: false });
  assert.deepEqual(JSON.parse(p.store.get("wtgui.assistantThresholdsOpen")), ["loop"], "closing takes the id back out");
  p.store.set("wtgui.assistantThresholdsOpen", "{not json");
  assert.deepEqual([...p.thresholdsOpen()], [], "unreadable storage falls back to all closed");
});

test("a re-render repaints the pane that owns the key, so the delegated change handler still applies", () => {
  const p = page({ settings: { quietSeconds: 999 } });
  p.renderAssistantSettings(p.FIRST_ASSISTANT, true);
  const settingsHtml = () => p.hosts.get("as-settings").innerHTML;
  assert.equal(count(settingsHtml(), 'data-as-set="quietSeconds"'), 1, "one control after the first paint");
  assert.match(inputTag(settingsHtml(), "quietSeconds"), /value="999"/, "the painted value is the current one");

  p.state.assistant.settings.quietSeconds = 1200;
  p.renderAssistantSettings(p.FIRST_ASSISTANT, true);
  assert.equal(count(settingsHtml(), 'data-as-set="quietSeconds"'), 1, "a re-render does not duplicate the control");
  assert.match(inputTag(settingsHtml(), "quietSeconds"), /value="1200"/, "and carries the new value");

  // The handler is delegated from the float root and dispatches on the key's owner, so one listener serves both
  // panes and each repaint touches only the host it owns.
  assert.match(
    src,
    /as\$\("assistant"\)\?\.addEventListener\("change", async \(e\) => \{\s*const el = e\.target;[\s\S]*?if \(el\.dataset\.asSet\) \{/,
    "the [data-as-set] change handler is delegated from the float root",
  );
  assert.match(src, /if \(ownsWatchdog\(key\)\) renderWatchdog\(true\);/, "the watchdog's keys repaint the watchdog");
  assert.match(src, /else renderAssistantSettings\(forId \|\| FIRST_ASSISTANT, true\);/, "and an assistant's repaint its own pane");
  assert.match(settings, /const host = hostFor\(id, "settings"\)/, "the session paint's host is that assistant's pane");
  assert.match(settings, /const host = as\$\("as-watchdog"\)/, "the watchdog paint's host is its own");
});

test("a second assistant's pane draws ITS values, never Assistant #1's", () => {
  const { own } = render({ second: true }, "assistant-2");
  assert.match(own, /its own, not Assistant #1's/i, "the pane says whose settings these are");
  assert.match(inputTag(own, "maxWakesPerHour"), /value="3"/, "#2's wake budget, out of its own file");
  assert.match(own, /data-as-for="assistant-2"/, "every control posts to its own assistant");
  assert.match(own, /assistants\/assistant-2\/settings.json/, "and names the file it writes");
  assert.match(own, /Its wake budget and quiet windows/);
  assert.match(own, /<h4>Assistant #2's rules — its own, not Assistant #1's<\/h4>/, "its standing rules stay in its own pane");
  // Assistant #1's pane posts with no assistantId at all — the legacy path, unchanged.
  const first = render();
  assert.doesNotMatch(first.own, /data-as-for=/, "#1's controls carry no assistantId");
});
