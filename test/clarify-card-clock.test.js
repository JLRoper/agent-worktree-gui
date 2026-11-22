// The card's countdown is the gateway's window, drawn from the record and never from a number of its own.
//
// The defect this pins was read off the board on 2026-11-21: six clarify cards closed at 89 to 93 s while the
// countdown drew an hour, because `clarifyWindowSeconds()` answered 3600 when config.yaml named neither timeout and
// the gateway was waiting 90. The record now carries the gateway's window (`timeoutSeconds`, `deadline`, written by
// lib/jobs.js from the gateway's own `timeout_s` or the one resolution of its config), and the card may only draw
// what is on the record:
//
//   1. `data-q-deadline` IS the record's deadline and `data-q-window` IS the record's window, so the bar spans the
//      wait the gateway is enforcing;
//   2. a record with no deadline draws no clock at all - an invented bar is what the old default was;
//   3. a record whose deadline has passed draws "time is up" and offers no answer, the same state the page's tick
//      puts it in, because a press there could only come back refused.
//
// The page's own `questionPrompt` and `clockLabel` run here, sliced out of public/app.js with only the reader's own
// card state handed in - no rewrite of the function under test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sliceBetween } from "../tools/panel-testkit.mjs";

async function card(question, { typed = false } = {}) {
  const page = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const dom = await readFile(new URL("../public/core/dom-format.js", import.meta.url), "utf8");
  const source = [
    sliceBetween(dom, "const esc = (s) =>", "\n// A path as a card"),
    sliceBetween(dom, "const OUT_URL_RE", "\nfunction fmtBytes"),
    sliceBetween(page, "const browserName =", "function paintQLook"),
    sliceBetween(page, "function questionLinks(q) {", "function questionPrompt("),
    sliceBetween(page, "const RECOMMENDED_RE", "// ---- the question box's look (Settings > Display)"),
    sliceBetween(page, 'function questionPrompt(turn, copy = "")', '// "~49m left"'),
    // The page's own time formatter, and the one wording both halves of the countdown read.
    sliceBetween(page, "function fmtLeft(ms) {", "\n// One clock for the page"),
  ].join("\n");
  const build = new Function(
    "turnLive", "questionInFlight", "qLookState", "questionPicks", "questionDrafts", "questionBrowser",
    `${source}\nreturn { questionPrompt, clockLabel };`,
  );
  const turn = {
    id: "turn-clock",
    thread: "wtgui-clarify-clock",
    status: "running",
    questionDone: null,
    question: { requestId: "p-clock", question: "Which side first?", choices: ["QA", "prod"], ...question },
  };
  return build(() => true, () => null, { typed }, new Map(), new Map(), null).questionPrompt(turn);
}

const attr = (html, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(html);
  return m ? m[1] : null;
};

test("the card draws the record's own deadline and window, and says how much of it is left", async () => {
  const deadline = Date.now() + 45_000;
  const html = await card({ timeoutSeconds: 90, deadline });
  assert.equal(Number(attr(html, "data-q-deadline")), deadline, "the clock is the deadline the gateway's window produced");
  assert.equal(Number(attr(html, "data-q-window")), 90_000, "the bar spans the window the gateway is enforcing, 90 s and not an hour");
  assert.match(html, /~45s left/, "the first paint says what the tick will say a second later");
  const width = Number(/<span style="width:([\d.]+)%">/.exec(html)?.[1]);
  assert.ok(width > 45 && width < 55, `the bar is about half spent, because half the 90 s window is left (drew ${width}%)`);
});

test("a record with no window draws no clock: nothing is invented", async () => {
  const html = await card({});
  assert.equal(attr(html, "data-q-deadline"), null);
  assert.equal(attr(html, "data-q-window"), null);
  assert.doesNotMatch(html, /tq-foot/, "no bar, no label - the panel does not guess a window the gateway waits forever on");
});

test("once the deadline has passed the card says time is up and offers no answer", async () => {
  const html = await card({ timeoutSeconds: 90, deadline: Date.now() - 1_000 }, { typed: true });
  assert.match(html, /time is up/);
  assert.match(html, /tq-foot is-over/, "the foot is red, as the tick paints it");
  assert.match(html, /this answer can no longer be delivered/);
  // Every control that would send an answer is disabled: a choice button, the typed box and Send.
  const choices = html.match(/<button type="button" class="tq-choice"[^>]*>/g) || [];
  assert.equal(choices.length, 2);
  for (const btn of choices) assert.match(btn, / disabled/, `a spent window still offered: ${btn}`);
  assert.match(html, /<textarea class="tq-other"[^>]* disabled>/);
  assert.match(html, /<button type="button" class="tq-send"[^>]* disabled>Send answer<\/button>/);
});

test("the one label function is what both the card and the tick read", async () => {
  const page = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const label = sliceBetween(page, "function clockLabel(leftMs) {", "\n// \"~49m left\"");
  const build = new Function("fmtLeft", `${label}\nreturn clockLabel;`);
  const clockLabel = build((ms) => (ms >= 90_000 ? "1m" : `${Math.max(0, Math.round(ms / 1000))}s`));
  assert.equal(clockLabel(45_000), "~45s left");
  assert.equal(clockLabel(0), "time is up", "zero is already past: the gateway has stopped waiting");
  assert.equal(clockLabel(-5_000), "time is up");
  // And the tick really calls it rather than rewording the moment itself.
  const tick = sliceBetween(page, "function tickQuestionClocks() {", "\n// Once answered the box becomes one line");
  assert.match(tick, /label\.textContent = clockLabel\(left\)/);
});
