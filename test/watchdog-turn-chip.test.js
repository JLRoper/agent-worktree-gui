// What the page says about a turn the panel's watchdog started.
//
// The watchdog does not ask a question: it POSTs its own announcement as the turn's prompt, so the prompt literally
// begins "Watchdog: LONG RUN …". Drawn as-is, the head spends its one line on the sentry's own name, and the reader
// has to work out from the words whether the turn is a reply in the conversation or the panel reporting a run. The
// chip names the watchdog, the tooltip says which watchdog it is, and the inline prompt drops the opener so the
// request itself is what the head shows. The assistant's own purple chips are untouched: this is a different actor.
//
// Read out of the page and run with no browser, like test/session-replaced-ui.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const region = sliceRegion(src, "turn origin");
// Name the anchor inside the region before asserting on it: a failure then says the code left its section rather
// than that a class vanished.
assert.match(region, /function watchdogHtml\(turn\) \{/, "watchdogHtml is not in the turn origin section");
assert.match(region, /function originHtml\(turn\) \{/, "originHtml is not in the turn origin section");

const { originHtml, isWatchdogTurn, watchdogPromptText, WATCHDOG_TITLE } = new Function(
  "esc",
  `${region}; return { originHtml, isWatchdogTurn, watchdogPromptText, WATCHDOG_TITLE };`,
)(esc);

// The store's own shape: a real watchdog job from ~/.wag/state/jobs.json.
const WATCHDOG = {
  id: "612bcbae",
  thread: "panel-assistant",
  prompt: "Watchdog: LONG RUN 71641c06 - Move board and charter markers out of system briefing has been running 71 min",
  origin: null,
};

test("a watchdog turn wears a dark lowercase chip, not the prompt's own words", () => {
  const html = originHtml(WATCHDOG);
  assert.match(html, /class="turn-origin is-watchdog mono"/, "the chip carries the dark variant's class");
  assert.equal(html.replace(/<[^>]*>/g, "").trim(), "watchdog", "the chip reads lowercase watchdog and nothing else");
  // The prompt is not drawn on the chip: the words live in the inline prompt, once.
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ""), /LONG RUN/);
});

test("the tooltip names the panel's watchdog", () => {
  const title = /title="([^"]*)"/.exec(originHtml(WATCHDOG))[1];
  assert.equal(title, WATCHDOG_TITLE);
  assert.match(title, /the panel's watchdog/);
});

test("the inline prompt drops the sentry's opener, so the head is not saying it twice", () => {
  assert.equal(
    watchdogPromptText(WATCHDOG.prompt),
    "LONG RUN 71641c06 - Move board and charter markers out of system briefing has been running 71 min",
  );
  // Only at the START: a prompt that mentions the watchdog mid-sentence keeps its words.
  assert.equal(watchdogPromptText("why did Watchdog: fire"), "why did Watchdog: fire");
  // The prefix is the word AND the space; a bare "Watchdog:" is a different string and stays as it is.
  assert.equal(watchdogPromptText("Watchdog:"), "Watchdog:");
  assert.equal(watchdogPromptText(""), "");
  assert.equal(watchdogPromptText(null), "");
});

test("isWatchdogTurn is the prefix test, and nothing else", () => {
  assert.equal(isWatchdogTurn(WATCHDOG), true);
  assert.equal(isWatchdogTurn({ prompt: "Watchdog: FAILED 0359dfb2 - a run" }), true);
  assert.equal(isWatchdogTurn({ prompt: "watchdog: lower case is not the sentry" }), false);
  assert.equal(isWatchdogTurn({ prompt: "Watchdog" }), false);
  assert.equal(isWatchdogTurn({ prompt: "" }), false);
  assert.equal(isWatchdogTurn({}), false);
  assert.equal(isWatchdogTurn(null), false);
});

test("an ordinary turn draws nothing - the chip is not a badge on every head", () => {
  assert.equal(originHtml({ prompt: "fix the turn head" }), "");
  assert.equal(originHtml({}), "");
  assert.equal(originHtml(null), "");
});

test("the assistant's purple chips are untouched, and a watchdog turn draws its chip first", () => {
  // Every origin kind the page already drew, unchanged: the same words, the same single class, no dark variant.
  const kinds = [
    { origin: { kind: "assistant-reply", by: "assistant" }, words: "from the assistant" },
    { origin: { kind: "assistant-wake", reason: "a queue crossed its bar" }, words: "assistant woke itself" },
    { origin: { kind: "assistant-spawn", project: "agent-worktree-gui" }, words: "started by the assistant" },
    { origin: { kind: "row-refresh", evidence: ["the branch moved"] }, words: "from the row's" },
    { origin: { kind: "subagent-delivery", subagents: [{ index: 2, title: "the map" }] }, words: "from subagent #2" },
  ];
  for (const k of kinds) {
    const html = originHtml({ prompt: "an ordinary request", ...k });
    assert.match(html, /class="turn-origin mono"/, `${k.origin.kind} keeps its own chip`);
    assert.doesNotMatch(html, /is-watchdog/, `${k.origin.kind} is not the watchdog's chip`);
    assert.match(html.replace(/<[^>]*>/g, ""), new RegExp(k.words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // A watchdog turn that also carries an origin (a reply the sentry's announcement caused) draws both, chip first.
  const both = originHtml({ ...WATCHDOG, origin: { kind: "assistant-reply", by: "assistant" } });
  assert.ok(both.indexOf("is-watchdog") < both.indexOf("\u21b3"), "the watchdog chip comes before the attribution");
  assert.match(both.replace(/<[^>]*>/g, ""), /watchdog/);
  assert.match(both.replace(/<[^>]*>/g, ""), /from the assistant/);
});

test("nothing from the job store is trusted as markup", () => {
  const html = originHtml({ prompt: 'Watchdog: <script>alert(1)</script> "quoted"' });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\(1\)/);
  assert.match(html, /title="[^"]*the panel&#39;s watchdog|title="[^"]*the panel's watchdog/);
});

test("the dark variant is a grey box beside .turn-origin, and the purple chip keeps its colours", () => {
  const base = /\.turn-origin \{([^}]*)\}/.exec(css);
  assert.ok(base, ".turn-origin rule is in the stylesheet");
  assert.match(base[1], /background: #241d33/, "the assistant's chip is still the purple one");
  assert.match(base[1], /color: #c8a6ff/);
  const dark = /\.turn-origin\.is-watchdog \{([^}]*)\}/.exec(css);
  assert.ok(dark, "the dark variant sits beside .turn-origin");
  const body = dark[1];
  assert.match(body, /background: #14171b/, "near-black background");
  assert.match(body, /border-color: #333a44/, "grey border");
  assert.match(body, /color: #b6bec9/, "light grey text");
  // The box is inherited from .turn-origin, so size and radius are the same rule: nothing here resizes it.
  assert.doesNotMatch(body, /font-size|border-radius|padding/, "size and radius come from .turn-origin");
  assert.doesNotMatch(body, /#c8a6ff|#241d33|#3d3350/, "no purple in the watchdog chip");
});
