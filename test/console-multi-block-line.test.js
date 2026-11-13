// One console LINE that carries SEVERAL markdown blocks is drawn whole.
//
// lib/jobs.js keeps one open console line per paragraph and grows it in place, and a gateway can hand the whole
// answer over in a single delta - so the line a turn's record holds can be one string with a dozen physical lines
// inside it: paragraphs, a list, a heading, a fence. Markdown is a property of a RUN of lines (public/core/
// console-markdown.js says so itself), and the renderer split the run on console lines, never on the newlines
// INSIDE one.
//
// The defect: consoleMdInlineLines() returns one string per PHYSICAL line, and every block renderer indexed that
// array with the index of the STORE line it came from. A paragraph of one store line took inner[0] - the first
// physical line - and dropped every row after it: the console drew the opening sentence, the card's `done` sat
// under it, and the rest of the answer was in data-ltext and nowhere on screen. Measured on job 6073fb2a (thread
// panel-assistant-5, turn 12): the stored line is 4,446 characters, the console drew 86.
//
// What this pins, on the shipped renderer in a vm (no browser needed to fail):
//   1. every block in the line is a block - paragraphs, a list and a heading, in order;
//   2. the rendered words are the stored words, marker for marker removed and nothing else;
//   3. the rows read back (data-ltext, joined with a newline) equal the stored string CHARACTER FOR CHARACTER,
//      which is what a rebuild, the raw view and the copy button all rely on.
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

// The answer as ONE stored console line, with its newlines still inside the string - the shape lib/jobs.js hands
// the console, and the shape job 6073fb2a holds.
const STORED = [
  "Here is a deliberately long answer - if the bottom is cut again, the fix did not take.",
  "",
  "**What the clipping actually was.** Not a CSS height clamp: the block loop stopped at the first physical line.",
  "",
  "- the first item, said plainly",
  "- the second item, with **its own bold run**",
  "",
  "## The last section",
  "",
  "The last words of the answer, which a reader must be able to reach.",
].join("\n");

const line = { kind: "text", text: STORED, lid: 385234 };

// The rendered words: tags dropped, the five escapes put back.
const visible = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

// Every row's own source line, in draw order: what a rebuild reads back out of the DOM.
const rowSources = (html) => [...html.matchAll(/data-ltext="([^"]*)"/g)].map((m) => m[1]);

// What the reader sees, row by row: each `div.jl` is one console row, so the rows are the lines (a block wrapper
// is not a row, and textContent alone would run every paragraph together).
const visibleRows = (html) =>
  html
    .split(/<div class="jl /)
    .slice(1)
    .map((chunk) => {
      const body = chunk.slice(chunk.indexOf(">") + 1);
      return visible(body.slice(0, body.indexOf("</div>")));
    });

test("a single stored line carrying several blocks draws every block, in order", () => {
  const blocks = M.blocks([line]);
  assert.equal(
    JSON.stringify(blocks.map((b) => b.type)),
    JSON.stringify(["para", "para", "list", "head", "para"]),
    `every block in the line is its own block: ${JSON.stringify(blocks.map((b) => b.type))}`,
  );
  const h = M.html([line]);
  assert.match(h, /class="md-block md-list"/, "the bullet run is a list");
  assert.match(h, /class="md-block md-head"/, "the heading is a heading");
  assert.ok(h.includes("<strong>What the clipping actually was.</strong>"), "the first bold run renders");
  assert.ok(h.includes("<strong>its own bold run</strong>"), "a bold run further down the line renders");
  assert.ok(!visible(h).includes("**"), "no literal marker survives");
});

test("the rendered text is the stored text, marker for marker turned into a shape", () => {
  // Written out from STORED: ** -> bold, "- " -> a bullet, "## " -> a heading, and the blank line between blocks
  // is the block spacing (no row, nothing lost).
  const expected = [
    "Here is a deliberately long answer - if the bottom is cut again, the fix did not take.",
    "What the clipping actually was. Not a CSS height clamp: the block loop stopped at the first physical line.",
    "\u2022the first item, said plainly",
    "\u2022the second item, with its own bold run",
    "The last section",
    "The last words of the answer, which a reader must be able to reach.",
  ];
  const got = visibleRows(M.html([line]));
  assert.equal(JSON.stringify(got), JSON.stringify(expected), "every physical line of the stored line reaches the reader, in order");
});

test("every non-blank source line is one row, character for character", () => {
  const h = M.html([line]);
  const stored = STORED.split("\n").filter((s) => s !== "");
  assert.equal(JSON.stringify(rowSources(h)), JSON.stringify(stored), "data-ltext, row by row, is exactly what the turn said");
  // The whole reply, character for character, as the raw view draws it (`consoleMdRawText` is what the RAW button
  // writes with textContent): no marker, no blank line and no word may be missing from it.
  assert.equal(M.rawText([line]), STORED);
});

test("the typed (live repaint) renderer draws the same blocks from the same line", () => {
  // A pacer that has released nothing yet for this line: every row is drawn empty, and no block is dropped.
  const h = M.html([line], { textOf: () => "" });
  assert.match(h, /class="md-block md-list"/);
  assert.match(h, /class="md-block md-head"/);
  assert.equal(rowSources(h).length, 6, "one row per non-blank physical line, none lost");
  // Part released: the rows the prefix reached carry their words, the rest wait empty.
  const half = STORED.slice(0, STORED.indexOf("## The last section"));
  const h2 = M.html([line], { textOf: () => half });
  const shown = visible(h2);
  assert.ok(shown.includes("the second item, with its own bold run"), "the released half is drawn");
  assert.ok(!shown.includes("The last section"), "a row the prefix has not reached is not drawn yet");
  assert.equal(rowSources(h2).length, 6, "every row still carries its own source text");
});

test("the live append plan sees a physical line at a time, not the whole block run", () => {
  // What the console hands the planner once the line is split where it enters the console (public/board/console.js,
  // consoleLinesOf): one physical line each, so a blank line really is the paragraph break it reads as.
  const parts = M.physicalLines([line]);
  assert.equal(parts.length, 10, "the store line became its ten physical lines");
  assert.equal(
    JSON.stringify(parts.map((p) => String(p.lid))),
    JSON.stringify(["385234", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `385234.${i}`)]),
    "the first row keeps the line's own id, the rest are lid.1, lid.2...",
  );
  assert.equal(M.plan(null, parts[0]).type, "para");
  assert.equal(M.plan({ type: "para" }, parts[1]).action, "break", "the blank line breaks the paragraph");
  assert.equal(M.plan(null, parts[4]).type, "list", "the bullet run starts a list");
  assert.equal(M.plan({ type: "list", ordered: false }, parts[5]).action, "item");
  assert.equal(M.plan(null, parts[7]).type, "head", "the heading starts a heading");
});
