// The assistant's title row owns its box: one `.as-bar` in the stylesheet, and it is the header's.
//
// THE DEFECT this file pins out of existence. `public/assistant.js` drew a watch deadline's draining bar as
// `<span class="as-bar">`, the same class as the assistant's title row — and the deadline bar's rule (`width: 78px;
// height: 4px; overflow: hidden`) came later in `public/style.css`, so it became the HEADER's box too. The row was
// 78×15 with 478 px of content in it, and `#assistant { overflow: hidden }` cut `as-name` and its mode chip off at
// the float's top edge. A browser gate measures the painted result (`tools/verify-assistant-float-header.mjs`);
// this file pins the SOURCE facts that make the result hold:
//
//   1. ONE `.as-bar`, and every rule that styles it is scoped to `#assistant` — no bare `.as-bar` rule is left for
//      another bar to inherit, and none of the header's rules sets the box a progress bar would set.
//   2. THE DEADLINE BAR HAS ITS OWN NAME (`.as-watchbar`), scoped under `.as-watch-timer`, and the markup that
//      draws it carries that name — so the rename cannot drift back.
//   3. THE HEADER'S LAYOUT IS THE FIX: the name keeps one line (`nowrap` + `ellipsis`) and the row wraps instead,
//      so a narrow float moves the chips down rather than squeezing the name into a 57 px box.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const here = (p) => new URL(p, import.meta.url);
const css = (await readFile(here("../public/style.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\r/g, "");
const html = (await readFile(here("../public/index.html"), "utf8")).replace(/\r/g, "");
const js = (await readFile(here("../public/assistant.js"), "utf8")).replace(/\r/g, "");

// Every rule of the sheet as {selector, body} — top level and inside @media alike.
function rules(sheet) {
  const out = [];
  const walk = (text) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open === -1) break;
      const selector = text.slice(i, open).trim().split("\n").pop().trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}") depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, j - 1);
      if (selector.startsWith("@")) walk(body);
      else out.push({ selector, body });
      i = j;
    }
  };
  walk(sheet);
  return out;
}

const sheet = rules(css);
const barRules = sheet.filter((r) => /(^|[\s,>])\.as-bar(?![-\w])/.test(r.selector));
const watchRules = sheet.filter((r) => /\.as-watchbar(?![\w-])/.test(r.selector));

test("every .as-bar rule is scoped to the assistant's own title row", () => {
  assert.ok(barRules.length >= 3, `expected the title row's rules, found ${barRules.length}`);
  const unscoped = barRules.filter((r) => !r.selector.includes("#assistant"));
  assert.deepEqual(
    unscoped.map((r) => r.selector),
    [],
    "a bare `.as-bar` rule is a box another bar can inherit — this is exactly how the deadline bar took the header's box",
  );
});

test("the title row itself sets no fixed box — a row is not a progress bar", () => {
  const rows = barRules.filter((r) => /\.as-bar\s*$/.test(r.selector));
  assert.ok(rows.length >= 1, "no rule styles the title row itself");
  for (const r of rows) {
    assert.doesNotMatch(r.body, /(^|[;\s])width:\s*\d/, `${r.selector} sets a width`);
    assert.doesNotMatch(r.body, /(^|[;\s])height:\s*\d/, `${r.selector} sets a height`);
    assert.doesNotMatch(r.body, /overflow:\s*hidden/, `${r.selector} clips its own content`);
  }
});

test("the title row spans whatever frame it is drawn in", () => {
  const row = barRules.find((r) => r.selector === "#assistant > .as-bar");
  assert.ok(row, "no `#assistant > .as-bar` rule — the title row is not scoped to the header");
  assert.match(row.body, /display:\s*flex/);
  assert.match(row.body, /flex-wrap:\s*wrap/, "the row wraps rather than squeezing the name");
});

test("the name keeps one line, and the mode chip cannot break mid-word", () => {
  const name = sheet.find((r) => r.selector === "#assistant > .as-bar > strong");
  assert.ok(name, "no rule for the title row's own <strong> (as-name)");
  assert.match(name.body, /white-space:\s*nowrap/);
  assert.match(name.body, /text-overflow:\s*ellipsis/);
  assert.match(name.body, /min-width:\s*0/, "without min-width:0 a flex item refuses to shrink, so the name cannot ellipsize");
  const mode = sheet.find((r) => r.selector === ".as-mode");
  assert.ok(mode, "no .as-mode rule");
  assert.match(mode.body, /white-space:\s*nowrap/);
  assert.match(mode.body, /flex:\s*0 0 auto/, "the status chip is not the thing that gives way");
});

test("the watch deadline's bar is its own class, scoped under its own row", () => {
  assert.ok(watchRules.length >= 2, `expected the deadline bar's rules, found ${watchRules.length}`);
  for (const r of watchRules) {
    assert.match(r.selector, /\.as-watch-timer/, `${r.selector} is not scoped to the watch row`);
  }
  const box = watchRules.find((r) => /width:\s*78px/.test(r.body));
  assert.ok(box, "no 78 px deadline bar");
  assert.match(box.body, /height:\s*4px/);
  assert.match(box.body, /overflow:\s*hidden/);
});

test("the markup that draws a watch deadline uses .as-watchbar, never .as-bar", () => {
  assert.match(js, /class="as-watchbar"><i data-watch-bar/, "the watch row does not draw `.as-watchbar`");
  assert.doesNotMatch(js, /class="as-bar"/, "a script draws `.as-bar` — only index.html's title row may carry that class");
  assert.match(html, /<div class="as-bar">\s*<span class="as-glyph">/, "the header's title row is not the `.as-bar` in the page's markup");
});

test("the header's title row is the one that carries as-name and its mode chip", () => {
  const start = html.indexOf('<div class="as-bar">');
  const end = html.indexOf('<div class="as-tabs"', start);
  assert.ok(start !== -1 && end > start, "the title row's markup moved");
  const row = html.slice(start, end);
  assert.match(row, /id="as-name"/);
  assert.match(row, /id="as-mode"/);
});
