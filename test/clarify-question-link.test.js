// A URL in a clarify question is a LINK, not text.
//
// The card is where a parked agent asks for a decision, and the decision often needs the thing the question
// names: a report, a page, a run. Copying a path out of a card and pasting it into a browser is the failure
// this pins, so the question renders through `linkifyText` (public/core/dom-format.js) - the same helper the
// console and the turn cards use - and the anchor it builds carries `data-open-url`, which the page turns
// into POST /api/open-url (the OS browser opens the page; the board does not navigate away).
//
// The page's own functions run here, not a rewrite of them: `questionPrompt` is sliced out of public/app.js
// and `esc` / `linkifyText` out of public/core/dom-format.js, with only the reader's own card state handed in.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const URL_ONE = "https://example.test/reports/clarify-card-link-2026-11-09.html";
const QUESTION = `The clarify-card URL smoke test report at ${URL_ONE} is ready - should it ship as the decided fix?`;

// The shipped question row, built from the shipped source against a parked turn. Only the page's free
// variables are supplied: the reader's picks and drafts, the question clock and the turn's liveness.
async function card(question, { choices = [], live = true, done = false } = {}) {
  const page = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const dom = await readFile(new URL("../public/core/dom-format.js", import.meta.url), "utf8");
  const source = [
    sliceBetween(dom, "const esc = (s) =>", "\n// A path as a card"),
    sliceBetween(dom, "const OUT_URL_RE", "\nfunction fmtBytes"),
    sliceBetween(page, "const RECOMMENDED_RE", "// ---- the question box's look (Settings > Display)"),
    sliceBetween(page, 'function questionPrompt(turn, copy = "")', '// "~49m left"'),
  ].join("\n");
  const build = new Function(
    "turnLive", "questionInFlight", "qLookState", "fmtLeft", "questionPicks", "questionDrafts",
    `${source}\nreturn { questionPrompt };`,
  );
  const turn = {
    id: "turn-smoke",
    thread: "wtgui-clarify-link",
    status: "running",
    questionDone: done,
    question: { question, choices, requestId: "p-smoke" },
  };
  return build(
    () => live,
    () => null,
    { typed: false },
    () => "10m",
    new Map(),
    new Map(),
  ).questionPrompt(turn);
}

const anchorFor = (url) =>
  `<a class="out-link" href="${url}" target="_blank" rel="noreferrer noopener" data-open-url="${url}" title="open in your browser">${url}</a>`;

test("a URL in the question is the panel's own anchor, inside the question row", async () => {
  const html = await card(QUESTION);
  const anchor = anchorFor(URL_ONE);
  assert.ok(html.includes(anchor), `the question's URL is a link, not text:\n${html}`);
  const row = /<div class="tq-question">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(row, "the card still draws the question row");
  assert.ok(row[1].includes(anchor), "the link is in the question row, not the note");
  assert.match(html, /<div class="tq-question">The clarify-card URL smoke test report at <a class="out-link"/,
    "the sentence reads through the link");
});

test("the sentence around the link is intact on both sides", async () => {
  const html = await card(QUESTION);
  assert.ok(html.includes("The clarify-card URL smoke test report at "), "the words before the URL stay");
  assert.ok(html.includes(" is ready - should it ship as the decided fix?"), "the words after the URL stay");
});

test("a question with no URL renders as text and grows no anchor", async () => {
  const html = await card("The smoke test is finished - should the card ship it?");
  assert.ok(html.includes('<div class="tq-question">The smoke test is finished - should the card ship it?</div>'));
  assert.equal((html.match(/<a\b/g) || []).length, 0, "no URL, no link");
});

test("markup in a question is escaped, never rendered", async () => {
  const html = await card(`Report at ${URL_ONE} <img src=x onerror=alert(1)>`);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the tag is text");
  assert.ok(!html.includes("<img"), "the tag is not markup");
  assert.equal((html.match(/<a\b/g) || []).length, 1, "the escaping did not swallow the one real link");
});

test("sentence punctuation after a URL belongs to the sentence, not the link", async () => {
  const html = await card("Read https://example.test/r.html, then answer.");
  assert.ok(html.includes("https://example.test/r.html</a>,"), `the comma is outside the anchor:\n${html}`);
  assert.ok(html.includes("answer."), "the rest of the sentence survives");
});

test("a query string stays escaped in the link's own attributes", async () => {
  const html = await card("Open https://example.test/r.html?a=1&b=2 now.");
  assert.ok(html.includes('href="https://example.test/r.html?a=1&amp;b=2"'), `ampersands are escaped once:\n${html}`);
  assert.ok(html.includes('data-open-url="https://example.test/r.html?a=1&amp;b=2"'), "the open target matches the href");
});

test("the answer rows are untouched: a URL in a choice is still the choice's text", async () => {
  const html = await card(QUESTION, { choices: [`Ship ${URL_ONE} (Recommended)`] });
  assert.ok(html.includes(`Ship ${URL_ONE}`), "the choice is drawn verbatim");
  assert.equal((html.match(/<a\b/g) || []).length, 1, "only the question's URL is a link");
});
