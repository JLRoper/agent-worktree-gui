// The console's prose is drawn as markdown, escaped first: the agent's markers become SHAPES, the agent's HTML
// stays text. public/core/console-markdown.js is a classic script in the page, so it is loaded here in a vm the
// way the page loads it — over the real dom-format.js, so `esc` is the shipped one — and driven through the two
// entry points the page uses: `consoleMdHtml` (a repaint) and `consoleMdPlan` (the live append).
//
// The browser half (a real click on raw/focus, a real fence fold, the layout) is tools/verify-console-render.mjs;
// this is the part that must never need a browser to fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ window: {}, console });
for (const file of ["public/core/dom-format.js", "public/core/console-markdown.js"]) {
  vm.runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}
const M = context.window.WMApp.core.consoleMarkdown;

const prose = (texts) => texts.map((text, i) => ({ kind: "text", text, lid: 100 + i }));
const rendered = (texts) => M.html(prose(texts));
// The rendered words, with the source attributes stripped: what a reader actually sees, as text.
const visible = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

test("bold, inline code and triple emphasis become shapes — no literal marker survives in the prose", () => {
  const h = rendered(["**PR #279 MERGED** — `origin/main` is in, and ***this*** matters."]);
  assert.match(h, /<strong>PR #279 MERGED<\/strong>/);
  assert.match(h, /<code class="md-code">origin\/main<\/code>/);
  assert.match(h, /<strong><em>this<\/em><\/strong>/);
  assert.ok(!/\*\*/.test(visible(h)), `no literal ** in what the reader sees: ${visible(h)}`);
  assert.ok(!/`/.test(visible(h)), "no literal backtick in what the reader sees");
});

test("the source line is kept whole in data-ltext, so a rebuild reads what the turn said", () => {
  const h = rendered(["a **bold** line"]);
  assert.ok(h.includes('data-ltext="a **bold** line"'));
  assert.match(h, /data-lkind="text"/);
  assert.match(h, /data-lid="100"/);
});

test("agent HTML is escaped first and never becomes markup", () => {
  const h = rendered(['<img src=x onerror="alert(1)"> and <script>bad()</script>']);
  assert.ok(!/<img|<script/i.test(h), "no tag from the agent survives");
  assert.ok(h.includes("&lt;img"), "the characters are shown, escaped");
  assert.ok(h.includes("&quot;alert(1)&quot;"));
});

test("a fence is a well with a language label and a line count, open under the fold", () => {
  const h = rendered(["```js", "const a = 1;", "const b = 2;", "```"]);
  assert.match(h, /class="md-block md-fence"/);
  assert.match(h, /data-md-lang="js"/);
  assert.match(h, /<span class="md-fence-lang">js<\/span>/);
  assert.match(h, /<span class="md-fence-n">2 lines<\/span>/);
  assert.ok(!/is-folded/.test(h), "two lines is not past the fold");
  assert.ok(!/class="md-fence-body" hidden/.test(h), "and it arrives open");
  assert.ok(h.includes("const a = 1;"), "the code is on screen");
});

test("past fifteen lines the fence arrives folded, with the button that opens it", () => {
  const body = Array.from({ length: 20 }, (_, i) => `row ${i}`);
  const h = rendered(["```sh", ...body, "```"]);
  assert.match(h, /md-fence is-folded/);
  assert.match(h, /<span class="md-fence-n">20 lines<\/span>/);
  assert.match(h, /data-md-fence="1" aria-expanded="false"/);
  assert.match(h, /show 20 lines/);
  assert.match(h, /class="md-fence-body" hidden/);
  assert.equal(M.fenceFold, 15);
});

test("a fence still arriving is drawn open — the reader watches it fill", () => {
  const h = rendered(["```js", "const a = 1;", "const b = 2;"]);
  assert.ok(!/is-folded/.test(h));
  assert.ok(!/ hidden/.test(h));
  assert.match(h, /<span class="md-fence-n">2 lines<\/span>/);
});

test("headings, bullet lists and ordered lists keep their structure", () => {
  const h = rendered(["## What changed", "- first", "- second", "", "1. one", "2. two"]);
  assert.match(h, /md-block md-head/);
  assert.match(h, /data-md-level="2"/);
  assert.match(h, /md-h2/);
  assert.ok(!/>## /.test(h), "the ## is a marker, not the sentence");
  assert.match(h, /md-block md-list/);
  assert.match(h, /<span class="md-marker" aria-hidden="true">•<\/span>/);
  assert.match(h, /data-md-ordered="1"/);
  assert.match(h, /<span class="md-marker" aria-hidden="true">1\.<\/span>/);
});

test("a paragraph is a run of lines, and a blank line starts the next block", () => {
  const blocks = M.blocks(prose(["one", "two", "", "three"]));
  // (the module runs in its own vm realm, so its arrays are compared as strings)
  assert.equal(blocks.map((b) => b.type).join(","), "para,para");
  assert.equal(blocks.map((b) => b.lines.length).join(","), "2,1");
});

test("links are the words plus the url, and a bare url stays clickable", () => {
  const h = rendered(["see [the run](https://example.test/run/1) and https://example.test/x"]);
  assert.match(h, /<a class="out-link" href="https:\/\/example.test\/run\/1"/);
  assert.match(h, />the run<\/a>/);
  assert.match(h, /<span class="md-link-url">https:\/\/example.test\/run\/1<\/span>/);
  assert.match(h, /data-open-url="https:\/\/example.test\/x"/);
});

test("an unpaired marker stays literal — a sentence mid-stream is not eaten", () => {
  assert.equal(M.inline("**still open"), "**still open");
  const h = rendered(["a `half typed"]);
  assert.equal(visible(h), "a `half typed");
});

test("only prose is markdown: a tool output's +, - and * lines are not lists", () => {
  assert.equal(M.isProse("text"), true);
  assert.equal(M.isProse("tool"), false);
  assert.equal(M.isProse("tool-out"), false);
  assert.equal(M.isProse("raw"), false);
  assert.equal(M.isProse("dim"), false);
});

test("the raw view is the turn's own bytes, one newline between lines, nothing rendered", () => {
  const lines = prose(["**PR #279 MERGED**", "```js", "const a = 1;", "```", ""]);
  assert.equal(M.rawText(lines), "**PR #279 MERGED**\n```js\nconst a = 1;\n```\n");
  assert.equal(M.rawText(lines), lines.map((l) => l.text).join("\n"));
});

test("the live append plan agrees with the repaint about where a block begins and ends", () => {
  // ...the same lines fed one at a time through the plan...
  const lines = prose(["```js", "a", "b", "```", "", "- x", "- y", "", "plain"]);
  let prev = null;
  const kinds = [];
  for (const line of lines) {
    const plan = M.plan(prev, line);
    kinds.push(plan.action === "new" ? `new:${plan.type}` : plan.action);
    if (plan.action === "new") prev = { type: plan.type, ordered: Boolean(plan.ordered), lang: plan.lang || "", open: Boolean(plan.open) };
    else if (plan.action === "close" || plan.action === "break") prev = null;
    else if (plan.action === "item" && prev) prev.type = "list";
    else if (plan.action === "line" && prev) prev.type = "para";
  }
  assert.equal(kinds.join(","), [
    "new:fence",
    "code",
    "code",
    "close",
    "break",
    "new:list",
    "item",
    "break",
    "new:para",
  ].join(","));
  // ...and the blocks the repaint derives from the same lines.
  assert.equal(M.blocks(lines).map((b) => b.type).join(","), "fence,list,para");
});

test("a numbered list's marker is its own number, and an unordered one is a bullet", () => {
  const rows = M.html(prose(["3. third", "4. fourth"]));
  assert.match(rows, /<span class="md-marker" aria-hidden="true">3\.<\/span>/);
  assert.match(rows, /<span class="md-marker" aria-hidden="true">4\.<\/span>/);
});
