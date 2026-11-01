// The assistant's Settings tab: every threshold belongs to the rule it feeds.
//
// Ten number inputs used to sit in one flat "Thresholds" block above the rules, so nothing on the page said
// which bar belonged to which rule — and the two knobs no rule owns (the sentry's cadence and its hourly wake
// budget) looked like the eight that do. This drives the page's own `renderAssistantSettings` (the settings
// region is sliced out of public/assistant.js and run against a stub host, the way settings-groups.test.js runs
// the panel's fold region) and pins six facts:
//
//   1. every threshold key renders exactly once, and no data-as-set key renders twice anywhere in the HTML;
//   2. each of the eight sits inside the <details> of the rule that reads it, and the nine rules with no
//      threshold carry no disclosure at all;
//   3. the two ruleless knobs live in one Global group, above Per-rule escalation, and the flat block is gone;
//   4. every input keeps its exact key, its min/max and the aggressive-mode disabled/title handling;
//   5. the disclosures ship closed, and the one localStorage key holds the ids the reader left open;
//   6. a re-render repaints the settings host only, so the delegated [data-as-set] change handler still applies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULTS, RULE_DEFS } from "../lib/assistant/config.js";

const src = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");

const begin = src.indexOf("// ---- settings ---");
const end = src.indexOf("// ---- talking to the server");
assert.ok(begin > 0 && end > begin, "the settings region is in public/assistant.js");
const region = src.slice(begin, end);

// The contract, written out here rather than read back off the page: a test that takes the page's own table as
// its expectation proves only that the table agrees with itself.
const OWNER = {
  loop: "repeatLimit",
  quiet: "quietSeconds",
  approval: "approvalSeconds",
  exited: "exitedSeconds",
  context: "contextPercent",
  repeat: "repeatTurns",
  leftover: "leftoverMinutes",
  child: "childQuietSeconds",
};
const GLOBAL_KNOBS = ["seconds", "maxWakesPerHour"];
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
  quiet: (v) => `silent for ${v} s`,
  approval: (v) => `approval waiting ${v} s`,
  exited: (v) => `exited for ${v} s`,
  context: (v) => `context over ${v} %`,
  repeat: (v) => `same failure × ${v}`,
  leftover: (v) => `leftover work ${v} min`,
  child: (v) => `child silent ${v} s`,
};

const esc = (v) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page({ settings = {}, aggressive = null, open = null } = {}) {
  const store = new Map();
  if (open !== null) store.set("wtgui.assistantThresholdsOpen", JSON.stringify(open));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  const host = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
  const document = { getElementById: (id) => (id === "as-settings" ? host : null), activeElement: null };
  const state = {
    assistant: {
      settings: { ...DEFAULTS, rules: { ...DEFAULTS.rules }, ...settings },
      ruleDefs: RULE_DEFS,
      escalations: ["log", "alert", "wake", "act"],
      autonomy: ["draft", "auto-safe", "auto"],
      spawnModes: ["off", "ask", "auto"],
      commandAuditModes: ["off", "report", "enforce"],
      health: {},
      aggressive: aggressive || { on: false, restore: null, holds: { settings: [], rules: [] } },
      wakes: { lastHour: 0, limit: DEFAULTS.maxWakesPerHour },
      wakePending: 0,
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
    `${region}; return { renderAssistantSettings, RULE_THRESHOLDS, THRESHOLDS_OPEN_KEY, thresholdsOpen, saveThresholdsOpen, rememberThresholdOpen, thresholdSummary };`,
  )(document, localStorage, state, esc, () => false, () => null, { attach() {} }, (id) => document.getElementById(id));
  return { ...api, host, store, state };
}

const render = (opts) => {
  const p = page(opts);
  p.renderAssistantSettings(true);
  return { ...p, html: p.host.innerHTML };
};

const count = (html, needle) => html.split(needle).length - 1;
const inputTag = (html, key) => (html.match(new RegExp(`<input[^>]*data-as-set="${key}"[^>]*>`)) || [])[0];

function detailsBlocks(html) {
  const out = new Map();
  for (const m of html.matchAll(/<details class="as-rule-thresholds" data-as-rule-thresholds="([^"]+)"([^>]*)>([\s\S]*?)<\/details>/g)) {
    out.set(m[1], { attrs: m[2], body: m[3], at: m.index });
  }
  return out;
}

function group(html, heading) {
  const at = html.indexOf(`<h4>${heading}</h4>`);
  assert.ok(at > 0, `the settings HTML carries a ${heading} group`);
  const next = html.indexOf('<div class="as-group">', at);
  return html.slice(at, next > at ? next : html.length);
}

test("every threshold key in the defaults renders exactly once, and no key renders twice", () => {
  const { html } = render();
  for (const key of Object.keys(OWNER).map((id) => OWNER[id]).concat(GLOBAL_KNOBS)) {
    assert.ok(Object.hasOwn(DEFAULTS, key), `${key} is a knob in lib/assistant/config.js`);
    assert.equal(count(html, `data-as-set="${key}"`), 1, `${key} renders exactly once`);
  }
  // The whole page, not just the ten: a control drawn in two groups is the duplicate this move was asked to
  // remove, and a second copy is exactly how it would come back.
  const keys = [...html.matchAll(/data-as-set="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(keys).size, keys.length, `no data-as-set key renders twice: ${keys.join(", ")}`);
  for (const key of keys) assert.equal(count(html, `data-as-set="${key}"`), 1, `${key} is drawn once`);
  // The seven behaviour rows (enabled, autonomy, spawn, spawnAutoStart, commandAudit, model, cwd) plus the ten
  // numbers: the whole tab, written out so a control that quietly stops rendering is a failure too.
  assert.deepEqual(keys.sort(), ["approvalSeconds", "autonomy", "childQuietSeconds", "commandAudit", "contextPercent", "cwd", "enabled", "exitedSeconds", "leftoverMinutes", "maxWakesPerHour", "model", "quietSeconds", "repeatLimit", "repeatTurns", "seconds", "spawn", "spawnAutoStart"], "the settings tab draws each knob it owns, once");
});

test("the EXITED rule is a row in the per-turn list, with its own bar beside it", () => {
  assert.equal(RULE_DEFS.exited?.default, "wake", "the rule ships awake: a failed run with no watch is the board's news");
  const { html } = render();
  assert.match(html, /<b>Run exited<\/b>/, "the rule has a labelled row");
  assert.match(html, /data-as-rule="exited"/, "and an escalation select of its own");
  const block = detailsBlocks(html).get("exited");
  assert.ok(block, "its threshold is a disclosure under the row");
  assert.match(block.body, /data-as-set="exitedSeconds"/, "the bar it owns is inside that disclosure");
  assert.match(block.body, /exited for 30 s/, "the summary states the default in force");
});

test("each of the eight thresholds sits inside the details of the rule that consumes it", () => {
  const { html, RULE_THRESHOLDS } = render();
  const blocks = detailsBlocks(html);
  assert.deepEqual([...blocks.keys()].sort(), Object.keys(OWNER).sort(), "exactly the eight rules with a threshold carry a disclosure");

  for (const [id, key] of Object.entries(OWNER)) {
    const block = blocks.get(id);
    assert.ok(block, `${id} has a thresholds disclosure`);
    assert.equal(count(block.body, `data-as-set="${key}"`), 1, `${key} renders once inside ${id}'s details`);

    // The page's own table agrees with the contract above...
    assert.deepEqual(RULE_THRESHOLDS[id].map((t) => t.key), [key], `${id} owns ${key} in the page's table`);

    // ...and the disclosure is the one directly under the ${id} rule's row, not another rule's.
    const before = [...html.slice(0, block.at).matchAll(/data-as-rule="([^"]+)"/g)];
    assert.equal(before.at(-1)[1], id, `${id}'s disclosure follows the ${id} rule row`);
  }

  for (const id of NO_THRESHOLD) {
    assert.ok(!blocks.has(id), `${id} has nothing to tune, so it has no disclosure`);
    assert.ok(!html.includes(`data-as-rule-thresholds="${id}"`), `${id} carries no threshold markup`);
  }
});

test("the summary names the count and the value in force, closed, and quiet keeps its long-build note", () => {
  const { html } = render();
  const blocks = detailsBlocks(html);
  for (const [id, key] of Object.entries(OWNER)) {
    const block = blocks.get(id);
    const summary = (block.body.match(/<summary[^>]*>([^<]*)<\/summary>/) || [])[1];
    assert.ok(summary, `${id} has a plain-text summary`);
    assert.equal(summary, `1 threshold · ${PHRASE[id](DEFAULTS[key])}`, `${id}'s summary states its bar`);
    assert.doesNotMatch(block.attrs, /\bopen\b/, `${id} ships closed`);
  }
  // The one help line that explains the quiet rule's own default lives with the quiet rule's bar.
  assert.equal(count(html, "A long build is silent too"), 1, "the long-build note renders once");
  assert.match(blocks.get("quiet").body, /A long build is silent too/, "and it is inside quiet's disclosure");
  assert.doesNotMatch(group(html, "Global"), /A long build is silent too/, "not in the Global group");
});

test("the two ruleless knobs live in one Global group above Per-rule escalation, and the flat block is gone", () => {
  const { html } = render();
  const glob = group(html, "Global");
  for (const key of GLOBAL_KNOBS) assert.equal(count(glob, `data-as-set="${key}"`), 1, `${key} is in the Global group`);
  const escalation = html.indexOf("<h4>Per-rule escalation</h4>");
  assert.ok(html.indexOf("<h4>Global</h4>") < escalation, "Global sits above Per-rule escalation");
  assert.doesNotMatch(html, /<h4>Thresholds<\/h4>/, "the flat Thresholds block is deleted");
  assert.doesNotMatch(group(html, "Global"), /repeatLimit|quietSeconds|approvalSeconds|contextPercent|repeatTurns|leftoverMinutes|childQuietSeconds/, "no rule's own bar is repeated in Global");
  for (const key of Object.values(OWNER)) assert.ok(!glob.includes(`data-as-set="${key}"`), `${key} is not in Global`);
});

test("every input keeps its key, its min and max, and the aggressive-mode disabled handling", () => {
  const { html } = render();
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const tag = inputTag(html, key);
    assert.ok(tag, `${key} has a number input`);
    assert.match(tag, new RegExp(`min="${min}"`), `${key} keeps min ${min}`);
    assert.match(tag, new RegExp(`max="${max}"`), `${key} keeps max ${max}`);
    assert.doesNotMatch(tag, /\bdisabled\b/, `${key} is editable with aggressive mode off`);
  }

  // Aggressive mode holds every one of them: disabled, marked, and explained in the control's own title.
  const held = [...Object.keys(BOUNDS)];
  const { html: aggressiveHtml } = render({
    aggressive: { on: true, restore: null, holds: { settings: held, rules: Object.keys(RULE_DEFS) } },
  });
  for (const key of held) {
    const tag = inputTag(aggressiveHtml, key);
    assert.match(tag, /\bdisabled\b/, `${key} is disabled while aggressive mode holds it`);
    assert.match(tag, /title="aggressive mode holds this setting/, `${key} says why it cannot be changed`);
  }
});

test("the open disclosures are remembered per browser under one key, and ship closed", () => {
  const fresh = render();
  assert.deepEqual([...detailsBlocks(fresh.html).values()].filter((b) => /\bopen\b/.test(b.attrs)), [], "a browser that never opened one shows none open");
  assert.equal(fresh.store.size, 0, "a first paint writes nothing");

  const remembered = render({ open: ["quiet", "child"] });
  const blocks = detailsBlocks(remembered.html);
  assert.match(blocks.get("quiet").attrs, /\bopen\b/, "quiet reopens from storage");
  assert.match(blocks.get("child").attrs, /\bopen\b/, "child reopens from storage");
  assert.doesNotMatch(blocks.get("loop").attrs, /\bopen\b/, "a disclosure the reader never opened stays closed");

  const p = page();
  assert.equal(p.THRESHOLDS_OPEN_KEY, "wtgui.assistantThresholdsOpen", "one key, named like the panel's other folds");
  p.rememberThresholdOpen({ dataset: { asRuleThresholds: "approval" }, open: true });
  assert.deepEqual([...p.store.keys()], ["wtgui.assistantThresholdsOpen"], "opening writes the one key and nothing else");
  assert.deepEqual(JSON.parse(p.store.get("wtgui.assistantThresholdsOpen")), ["approval"]);
  p.rememberThresholdOpen({ dataset: { asRuleThresholds: "loop" }, open: true });
  assert.deepEqual(JSON.parse(p.store.get("wtgui.assistantThresholdsOpen")), ["approval", "loop"], "a second opening joins the list");
  p.rememberThresholdOpen({ dataset: { asRuleThresholds: "approval" }, open: false });
  assert.deepEqual(JSON.parse(p.store.get("wtgui.assistantThresholdsOpen")), ["loop"], "closing takes the id back out");
  // A record that no longer parses is a closed panel, not a broken tab.
  p.store.set("wtgui.assistantThresholdsOpen", "{not json");
  assert.deepEqual([...p.thresholdsOpen()], [], "unreadable storage falls back to all closed");
});

test("a re-render repaints the settings host only, so the delegated change handler still applies", () => {
  const p = page({ settings: { quietSeconds: 999 } });
  p.renderAssistantSettings(true);
  assert.equal(count(p.host.innerHTML, 'data-as-set="quietSeconds"'), 1, "one control after the first paint");
  assert.match(inputTag(p.host.innerHTML, "quietSeconds"), /value="999"/, "the painted value is the current one");

  p.state.assistant.settings.quietSeconds = 1200;
  p.renderAssistantSettings(true);
  assert.equal(count(p.host.innerHTML, 'data-as-set="quietSeconds"'), 1, "a re-render does not duplicate the control");
  assert.match(inputTag(p.host.innerHTML, "quietSeconds"), /value="1200"/, "and carries the new value");

  // The handler is delegated from the float root, reads `el.dataset.asSet`, and this paint touches only the
  // settings host — which is why the rebuilt inputs answer their change events without a second binding.
  assert.match(
    src,
    /as\$\("assistant"\)\?\.addEventListener\("change", async \(e\) => \{\s*const el = e\.target;\s*if \(el\.dataset\.asSet\) \{/,
    "the [data-as-set] change handler is delegated from the float root",
  );
  assert.match(region, /const host = as\$\("as-settings"\)/, "the paint's host is the settings pane");
  assert.match(region, /host\.innerHTML = `/, "and innerHTML on that host is the whole of it");
});
