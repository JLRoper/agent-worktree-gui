// test/legend-disclosure.test.js - the chart's legend as a disclosure, pinned without a browser.
//
// The legend used to be one dense paragraph under every chart. It is a disclosure now: a single-line strip of
// symbols and short words plus one labelled control, and a popover of short lines under three headings. The
// browser half - the one line at the live width, the keyboard, the geometry, the shots - is
// tools/verify-legend.mjs. This half pins the MARKUP and the CASCADE RULES, which no browser is needed to read:
//
//   * the collapsed strip carries every symbol with its short word and ONE control, whose aria-expanded and
//     aria-controls say what it will do and what it opens;
//   * the popover starts hidden and carries every clause of the block it replaced - the info-loss question;
//   * the open state marks the control expanded and reveals the popover, and the id it controls is unique per
//     project name (two names that sanitise alike must not share one popover);
//   * the sheet keeps the strip on one line (`flex-wrap: nowrap`) and takes the popover out of the flow
//     (`position: absolute`) under the strip - the two declarations the geometry rests on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sliceRegion } from "../tools/panel-testkit.mjs";
import { readStyleSheets } from "./style-sheets.js";

const lf = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const projects = lf("../public/render-projects.js");
const css = readStyleSheets();

const code = sliceRegion(projects, "the legend");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const api = new Function("esc", "document", `${code}; return { legendHtml, legendId, setOpen: (n) => { legendOpenFor = n; } };`)(esc, {
  addEventListener() {},
});

const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

test("collapsed: one line of symbols and short words, and one control that says what it is", () => {
  const html = api.legendHtml("kind-repo");
  const strip = text((/<div class="legend-line">([\s\S]*?)<\/div>/.exec(html) || [])[1] || "");
  assert.deepEqual(strip.replace(/\s*\?\s*what these mean$/, "").trim().split(/\s*\|\s*/), ["⧉ hermes ⧉ claude ● board :port ✎ files T R I ▾ fold"]);
  for (const word of ["hermes", "claude", "board", ":port", "files", "T", "R", "I", "fold"]) assert.ok(strip.includes(word), `the strip keeps ${word}`);
  assert.match(html, /<button type="button" class="legend-toggle" data-legend-toggle="kind-repo" aria-expanded="false" aria-controls="legend-pop-kind-repo"><span class="legend-q" aria-hidden="true">\?<\/span> what these mean<\/button>/);
  assert.ok(strip.endsWith("what these mean"), "the control's visible label is on the one line");
  assert.match(html, /<div class="legend-pop" id="legend-pop-kind-repo" data-legend-pop="kind-repo" role="group" aria-label="what the chart's marks mean" hidden>/);
});

test("expanded: the same words as the block, as short lines under three headings", () => {
  const html = api.legendHtml("kind-repo");
  const pop = (/<div class="legend-pop"[\s\S]*?\n      <\/div>\n    <\/div>/.exec(html) || [])[0] || "";
  assert.ok(pop, "the popover is in the markup");
  const popText = text(pop);
  const clauses = [
    "liveness evidence",
    "session active",
    "Claude Code session active",
    "live board PID",
    "dev server listening",
    "edited recently",
    "a row is live only if one of these fired",
    "the number is time since that last happened, the ring fills up to green as the row becomes due for its next read",
    "the kind column",
    "turnover tree (the feature container - research and implementation trees are cut from it, and an implementation tree's work merges back into it locally)",
    "research tree (local only - press the R to lift it)",
    "implementation tree (local only - press the I to lift it; a lifted tree keeps its letter with a tick)",
    "folding",
    "a tree cut from another one hangs under it, one indent in, and the ▾ on its parent folds the group out of sight",
    "a fold only hides, every chip and open panel stays as it was",
  ];
  for (const clause of clauses) assert.ok(popText.includes(clause), `the popover keeps the clause: ${clause.slice(0, 60)}`);
  assert.equal((pop.match(/<h4>/g) || []).length, 3, "three topic headings");
  assert.ok((pop.match(/<p[ >]/g) || []).length >= 12, "short lines, not one paragraph");
});

test("the open state marks the control expanded and reveals the popover", () => {
  api.setOpen("kind-repo");
  const html = api.legendHtml("kind-repo");
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="what the chart's marks mean">\n/);
  assert.doesNotMatch(html, /aria-label="what the chart's marks mean" hidden>/);
  api.setOpen(null);
});

test("the popover's id is unique even for names that sanitise alike", () => {
  assert.equal(api.legendId("kind-repo"), "legend-pop-kind-repo");
  assert.notEqual(api.legendId("a.b"), api.legendId("a-b"));
  assert.notEqual(api.legendId("a b"), api.legendId("a_b"));
});

test("the section draws the helper, not a paragraph of its own", () => {
  assert.match(projects, /\$\{legendHtml\(name\)\}/);
  assert.doesNotMatch(projects, /liveness evidence: <span class="sig sig-hermes">/);
});

test("the sheet keeps the strip on one line and the popover out of the page's flow", () => {
  const rule = (selector) => (new RegExp(`(^|\\n)${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`).exec(css) || [])[2] || "";
  const line = rule(".legend-line");
  assert.match(line, /flex-wrap:\s*nowrap/, "the strip cannot wrap");
  assert.match(line, /white-space:\s*nowrap/);
  const keys = rule(".legend-keys");
  assert.match(keys, /overflow:\s*hidden/, "the keys clip instead of pushing the control onto a second row");
  const pop = rule(".legend-pop");
  assert.match(pop, /position:\s*absolute/, "the popover does not take layout space");
  assert.match(pop, /top:\s*calc\(100% - 4px\)/, "it hangs under the strip");
  assert.match(css, /\.legend-pop\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.legend-toggle:focus-visible \{ outline:/, "the focus ring is drawn");
});
