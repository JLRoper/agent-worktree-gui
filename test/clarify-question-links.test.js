// The clarify card's Links section, and a path in a question made clickable.
//
// PART ONE: a question that carries `links` draws a reserved Links block between the text and the choices, one real
// anchor per link. A URL link opens through the panel (data-open-url, POST /api/open-url); a file link opens through
// the panel's own ladder (data-open-file, POST /api/open-file, lib/open-url.js) and the block NAMES the browser that
// will take it, because a click that leaves the panel for a browser window should say whose window.
//
// PART TWO: an old-style call - a path written into the question text and no `links` field at all - still yields a
// clickable link, so the field is an improvement and never a requirement.
//
// The page's own functions run here: `questionPrompt`, `questionLinks` and `linkifyCardText` are sliced out of
// public/app.js and public/core/dom-format.js, with only the reader's card state handed in.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { linksOf } from "../lib/clarify-links.js";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const REPORT = "docs/reports/clarify-card-links-2026-11-11.html";
// The absolute spelling of the same path. The drive letter is built at runtime: written out, it is a folder on the
// machine that wrote this file, which tools/absolute-paths.mjs refuses a commit for naming.
const ABS = `${"C"}:${"/work/demo/"}${REPORT}`;
// The tree a RELATIVE target is resolved against: the asking turn's own worktree, which lib/jobs.js writes on the
// question record as `base`. A relative path with no base is plain text now (test/clarify-relative-base.test.js pins
// that), so the card fixture here carries the base a real record carries.
const BASE = `${"C"}:${"/work/demo/.worktrees/report-one"}`;
const URL_ONE = "https://example.test/run/7";

async function card(question, { links, choices = [], browser = "Google Chrome", base = BASE } = {}) {
  const page = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const dom = await readFile(new URL("../public/core/dom-format.js", import.meta.url), "utf8");
  const source = [
    sliceBetween(dom, "const esc = (s) =>", "\n// A path as a card"),
    sliceBetween(dom, "const OUT_URL_RE", "\nfunction fmtBytes"),
    sliceBetween(page, "const browserName =", "function paintQLook"),
    sliceBetween(page, "function questionLinks(q) {", "function questionPrompt("),
    sliceBetween(page, "const RECOMMENDED_RE", "// ---- the question box's look (Settings > Display)"),
    sliceBetween(page, 'function questionPrompt(turn, copy = "")', '// "~49m left"'),
  ].join("\n");
  const build = new Function(
    "turnLive", "questionInFlight", "qLookState", "fmtLeft", "questionPicks", "questionDrafts", "questionBrowser",
    `${source}\nreturn { questionPrompt };`,
  );
  const turn = {
    id: "turn-links",
    thread: "wtgui-clarify-links",
    status: "running",
    questionDone: false,
    // `links` goes through the SHIPPED normalizer, exactly as lib/jobs.js puts it on the record, so a test cannot
    // hand the card a shape the panel never produces. `base` is the question record's own field.
    question: { question, choices, requestId: "p-links", links: linksOf(links), base },
  };
  return build(() => true, () => null, { typed: true }, () => "10m", new Map(), new Map(), browser).questionPrompt(turn);
}

const anchors = (html) => html.match(/<a\b[^>]*>/g) || [];
const section = (html) => {
  const m = /<div class="tq-links">([\s\S]*?)<\/div>\s*(?:<div class="tq-choices|<div class="tq-note)/.exec(html);
  return m ? m[1] : "";
};

test("two links draw a Links section with exactly one anchor each", async () => {
  const html = await card("Which of these is the fix?", {
    links: [
      { label: "the report", path: REPORT },
      { label: "the run", url: URL_ONE },
    ],
  });
  const inner = section(html);
  assert.ok(inner, `the card draws a Links section:\n${html}`);
  const rows = inner.match(/<a\b[^>]*>/g) || [];
  assert.equal(rows.length, 2, `one anchor per link, no more:\n${inner}`);
  assert.ok(inner.includes("the report"), "the first label is the anchor's text");
  assert.ok(inner.includes("the run"), "the second label is the anchor's text");
  assert.ok(inner.includes(`data-open-file="${REPORT}"`), "the file link carries the file target");
  assert.ok(inner.includes(`data-open-url="${URL_ONE}"`), "the url link carries the url target");
});

test("the section sits between the question text and the choices", async () => {
  const html = await card("Pick one.", { links: [{ label: "the report", path: REPORT }], choices: ["one", "two"] });
  const q = html.indexOf('<div class="tq-question">');
  const links = html.indexOf('<div class="tq-links">');
  const choices = html.indexOf('<div class="tq-choices');
  assert.ok(q >= 0 && links > q, "the section comes after the question");
  assert.ok(choices > links, "and before the choices");
});

test("the card names the browser a file link opens in", async () => {
  const html = await card("Look at this.", { links: [{ label: "the report", path: REPORT }], browser: "Google Chrome" });
  const inner = section(html);
  assert.ok(/file links open in <span data-browser-name>Google Chrome<\/span>/.test(inner), `the browser is named:\n${inner}`);
  assert.ok(/title="open [^"]+ in Google Chrome"/.test(inner), "and the anchor says the same");
});

test("with no browser resolved the card says 'your browser' rather than nothing", async () => {
  const html = await card("Look at this.", { links: [{ label: "the report", path: REPORT }], browser: null });
  assert.ok(section(html).includes("your browser"), "an unresolved browser is still named as one");
});

test("a question with no links draws no section at all", async () => {
  const html = await card("The smoke test is finished - should the card ship it?");
  assert.ok(!html.includes("tq-links"), "no reserved block, no empty box");
  assert.ok(html.includes('<div class="tq-question">The smoke test is finished - should the card ship it?</div>'),
    "the plain-text card reads exactly as it did");
  assert.equal(anchors(html).length, 0, "and there is nothing to click");
});

test("a bare FILE PATH in the question text is a link, for a call that carries no links field", async () => {
  const html = await card(`The report is at ${REPORT} - should it ship?`);
  const row = /<div class="tq-question">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(row, "the question row is drawn");
  assert.ok(row[1].includes(`data-open-file="${REPORT}"`), `the path is an anchor:\n${row[1]}`);
  assert.ok(row[1].includes(" - should it ship?"), "the sentence around it survives");
  assert.equal(html.includes("tq-links"), false, "a path in the text does not invent a Links section");
});

test("a bare ABSOLUTE path (a drive letter) is a link too", async () => {
  const row = /<div class="tq-question">([\s\S]*?)<\/div>/.exec(await card(`See ${ABS}.`));
  assert.ok(row[1].includes(`data-open-file="${ABS}"`), `the drive letter is a path, not a scheme:\n${row[1]}`);
  assert.ok(row[1].endsWith("</a>."), "the full stop belongs to the sentence");
});

test("a URL and a path in one question are both links, and neither swallows the other", async () => {
  const row = /<div class="tq-question">([\s\S]*?)<\/div>/.exec(await card(`Run ${URL_ONE} then read ${REPORT}.`));
  assert.ok(row[1].includes(`data-open-url="${URL_ONE}"`), `the url is a link:\n${row[1]}`);
  assert.ok(row[1].includes(`data-open-file="${REPORT}"`), "the path is a link");
  assert.equal((row[1].match(/<a\b/g) || []).length, 2, "two links, not three: no path inside the URL's own href");
});

test("prose with slashes is not turned into links", async () => {
  const html = await card("Either and/or both, 24/7, v1.2.3/beta - your call.");
  assert.equal(anchors(html).length, 0, `nothing plausible to open:\n${html}`);
});

test("a javascript: link never reaches the card", async () => {
  const html = await card("Pick one.", { links: [{ label: "click me", url: "javascript:alert(1)" }] });
  assert.equal(html.includes("javascript:"), false, "the normalizer dropped it before the card drew it");
  assert.ok(!html.includes("tq-links"), "and there is no section left to draw");
});

test("markup in a link label is escaped, never rendered", async () => {
  const inner = section(await card("Pick one.", { links: [{ label: "<img src=x onerror=1>", url: URL_ONE }] }));
  assert.ok(inner.includes("&lt;img src=x onerror=1&gt;"), `the label is text:\n${inner}`);
  assert.ok(!inner.includes("<img"), "and not markup");
});

test("the file target is escaped in the attribute it rides in", async () => {
  const inner = section(await card("Pick one.", { links: [{ label: "odd", path: "docs/a&b/<x>.html" }] }));
  assert.ok(inner.includes('data-open-file="docs/a&amp;b/&lt;x&gt;.html"'), `the attribute is escaped once:\n${inner}`);
});
