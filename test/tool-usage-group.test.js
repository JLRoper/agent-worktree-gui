// Drive the shipped renderer, not a copy of its behavior: one row per tool call inside two rules.
// The real page is exercised as well (tools/verify-tool-usage-group.mjs); this is the seam-free half that runs in
// `npm test`, where there is no layout engine — so the two rules are asserted where they are declared (style.css).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const part = (a, b) => {
  const start = source.indexOf(a);
  const end = source.indexOf(b, start);
  assert.ok(start >= 0 && end > start, `app.js still carries ${a}`);
  return source.slice(start, end);
};
const count = (html, re) => (html.match(re) || []).length;

// The five calls of a burst, in the shape the gateway records them: a start line carrying the glyph, the tool and the
// argument the call was given, then the result header the panel has always drawn under it ("  ↳ tool · 0.31s").
const CALLS = [
  { tool: "💻 terminal", arg: "wc -l docs/a.md", secs: "0.31" },
  { tool: "📖 read_file", arg: "docs/a.md L1-40", secs: "0.22" },
  { tool: "📖 read_file", arg: "docs/b.md L5-60", secs: "0.41" },
  { tool: "🔧 patch", arg: "public/app.js", secs: "1.20" },
  { tool: "🔎 search_files", arg: "tgrp in public/app.js", secs: "0.90" },
];

function burstLines() {
  const lines = [];
  let lid = 1;
  CALLS.forEach((c, i) => {
    lines.push({ kind: "tool", text: `${c.tool} · ${c.arg}`, lid: lid++, at: 1_000_000 + i * 2000 });
    // The result's own header line — the "↳ tool" row the reader no longer wants repeated under the call.
    lines.push({ kind: "tool-out", text: `  ↳ ${c.tool.split(" ")[1]} · ${c.secs}s`, lid: lid++, at: 1_000_000 + i * 2000 + Number(c.secs) * 1000 });
    lines.push({ kind: "tool-out", text: `result ${i + 1} line A`, lid: lid++, at: 1_000_000 + i * 2000 + Number(c.secs) * 1000 + 1 });
    lines.push({ kind: "tool-out", text: `result ${i + 1} line B`, lid: lid++, at: 1_000_000 + i * 2000 + Number(c.secs) * 1000 + 2 });
  });
  return lines;
}

function render({ lines = burstLines(), sep = true, open = new Set() } = {}) {
  const state = {
    projects: new Map(),
    jobs: new Map([["turn", { id: "turn", thread: "fixture-thread", status: "done", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z" }]]),
    toolStore: new Map(), toolGroupOpen: new Map(), codeBoxOpen: new Set(), codeBoxShut: new Set(),
    callFolded: new Set(), callOpen: open, foldRows: new Map(), foldPending: new Map(), batchCalls: new Map(),
  };
  const context = vm.createContext({
    window: {}, console, state, URLSearchParams,
    document: { getElementById: () => null },
    normPath: (p) => String(p ?? "").split("\\").join("/"),
    turnLive: () => false,
    repaintToolGroup: () => {},
    apiFetch: async () => ({ ok: true, json: async () => ({ results: [] }) }),
    input: lines, sep,
  });
  for (const file of ["public/core/dom-format.js", "public/core/console-format.js"]) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  for (const code of [
    part("const TOOL_START_RE =", "// Index of the started tool call"),
    part("function toolBurstRows(", "function groupLines("),
    part("function groupLines(", "function storeOffsetsBefore("),
    part("const READ_CODE_OPEN =", "// A block the reader has open keeps"),
    part("// ---- tool group key", "// ---- end tool group key"),
    part("const BATCH_TAIL_RE =", "function toBottomBtnHtml("),
  ]) vm.runInContext(code, context);
  const html = vm.runInContext('toolGroupHtml(input, "turn#0", "", true, "anchor", null, {flat: true, sep})', context);
  return { html, state, context };
}

// Every row of the group's row list: one node per call, and nothing else in it at rest.
const rows = (html) => [...html.matchAll(/<div class="jl jl-tool tgrp-row"[^>]*data-tgrp-call="([^"]*)"[^>]*>([\s\S]*?)<\/div>/g)];
const rowText = (inner) =>
  inner
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("a run of five calls is drawn as five rows, each carrying its glyph, tool, target and time", () => {
  const { html } = render();
  const r = rows(html);
  assert.equal(r.length, CALLS.length, `one row per call, got ${r.length}`);
  CALLS.forEach((c, i) => {
    const [name, glyph] = c.tool.split(" ").reverse();
    const text = rowText(r[i][2]);
    assert.match(text, new RegExp(glyph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `row ${i + 1} glyph`);
    assert.match(text, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `row ${i + 1} tool name`);
    assert.ok(text.includes(c.arg), `row ${i + 1} target: ${text}`);
    assert.ok(text.includes(`${c.secs}s`), `row ${i + 1} time: ${text}`);
  });
});

test("no row carries the ↳ result line, and each result's text sits only in its own row's box", () => {
  const { html } = render();
  const r = rows(html);
  CALLS.forEach((c, i) => {
    const text = rowText(r[i][2]);
    assert.doesNotMatch(text, /↳/, `row ${i + 1} repeats the result header`);
    assert.doesNotMatch(text, /result \d line [AB]/, `row ${i + 1} carries a result's text as a line`);
  });
  // Each row owns exactly one box. A call block runs to the next row, so "row i's text" is what precedes its own box.
  const blocks = html.split('<div class="tgrp-call"').slice(1);
  assert.equal(blocks.length, CALLS.length, `one block per row, got ${blocks.length}`);
  blocks.forEach((block, i) => {
    const rowOnly = rowText(block.slice(0, block.indexOf('<div class="tgrp-out"')));
    assert.doesNotMatch(rowOnly, /result \d line [AB]|↳/, `row ${i + 1} draws a result's text beside it`);
    assert.match(block, new RegExp(`result ${i + 1} line A`), `row ${i + 1}'s box lost its result`);
    CALLS.forEach((_, j) => {
      if (j === i) return;
      assert.doesNotMatch(block, new RegExp(`result ${j + 1} line A`), `row ${i + 1} shows result ${j + 1}`);
    });
  });
});

test("the group's edges are the two rules: .tgrp-flat declares a top and a bottom border, one per edge", () => {
  const start = css.indexOf(".tgrp.tgrp-flat {");
  assert.ok(start >= 0, "style.css still carries the flat group's rule");
  const end = css.indexOf("}", start);
  const rule = css.slice(start, end);
  assert.match(rule, /border-top:\s*1px solid var\(--line\)/, "a rule above the group");
  assert.match(rule, /border-bottom:\s*1px solid var\(--line\)/, "a rule below the group");
  // Per-row borders would read as five rules, not two: the rows themselves carry none.
  const rowStart = css.indexOf(".tgrp-flat .tgrp-row");
  const rowEnd = css.indexOf("}", rowStart);
  if (rowStart >= 0) assert.doesNotMatch(css.slice(rowStart, rowEnd), /border/, "a row draws its own rule");
});

test("the group is the stream's own piece: it wears jl-sep, and only when something is above it", () => {
  assert.match(render({ sep: true }).html, /class="tgrp tgrp-flat jl-sep"/);
  assert.match(render({ sep: false }).html, /class="tgrp tgrp-flat"/);
  assert.doesNotMatch(render({ sep: false }).html, /jl-sep/);
});

test("every row's box starts shut and opens from the row's own key", () => {
  const shut = render();
  const shutBoxes = [...shut.html.matchAll(/<div class="tgrp-out"([^>]*)>/g)];
  assert.equal(shutBoxes.length, CALLS.length);
  for (const [attrs] of shutBoxes) assert.match(attrs, /\bhidden\b/, "a row's box starts open");
  const keys = rows(shut.html).map((m) => m[1]);
  assert.deepEqual(new Set(keys).size, CALLS.length, "each row's key is its own");
  // The reader's open set is consulted on the rebuild, so the box survives a repaint.
  const open = render({ open: new Set([keys[2]]) });
  const openBoxes = [...open.html.matchAll(/<div class="tgrp-out"([^>]*)>/g)];
  assert.doesNotMatch(openBoxes[2][1], /\bhidden\b/, "the row the reader opened stays open");
  assert.match(openBoxes[0][1], /\bhidden\b/, "the rows they did not open stay shut");
  assert.match(open.html, /aria-expanded="true"/);
});

test("both halves of the record travel on the row, so a rebuild keeps the time and the pairing", () => {
  const { html } = render();
  const r = rows(html);
  for (const [key, , attrs] of r.map((m) => [m[1], m[2], m[0]])) void key;
  // The row node itself carries the call's console line and the result header the panel used to draw under it.
  const rowAttrs = [...html.matchAll(/<div class="jl jl-tool tgrp-row"([^>]*)>/g)].map((m) => m[1]);
  assert.equal(rowAttrs.length, CALLS.length);
  CALLS.forEach((c, i) => {
    assert.match(rowAttrs[i], /data-ltext="/, `row ${i + 1} keeps its console line`);
    assert.match(rowAttrs[i], /data-lresult="\s*↳/, `row ${i + 1} keeps the result header it replaced`);
    assert.match(rowAttrs[i], /data-lrat="\d+"/, `row ${i + 1} keeps the result's timestamp`);
    assert.match(rowAttrs[i], /role="button"/, `row ${i + 1} is a control`);
    assert.match(rowAttrs[i], /tabindex="0"/, `row ${i + 1} is reachable by keyboard`);
  });
});

test("the condensed group is untouched: it still opens with a head row and no per-call rows", () => {
  const lines = burstLines();
  const state = {
    projects: new Map(), jobs: new Map(), toolStore: new Map(), toolGroupOpen: new Map(),
    codeBoxOpen: new Set(), codeBoxShut: new Set(), callFolded: new Set(), callOpen: new Set(),
    foldRows: new Map(), foldPending: new Map(), batchCalls: new Map(),
  };
  const context = vm.createContext({
    window: {}, console, state, URLSearchParams, document: { getElementById: () => null },
    normPath: (p) => String(p ?? "").split("\\").join("/"), turnLive: () => false,
    repaintToolGroup: () => {}, apiFetch: async () => ({ ok: true, json: async () => ({ results: [] }) }),
    input: lines,
  });
  for (const file of ["public/core/dom-format.js", "public/core/console-format.js"]) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  for (const code of [
    part("const TOOL_START_RE =", "// Index of the started tool call"),
    part("function toolBurstRows(", "function groupLines("),
    part("function groupLines(", "function storeOffsetsBefore("),
    part("const READ_CODE_OPEN =", "// A block the reader has open keeps"),
    part("// ---- tool group key", "// ---- end tool group key"),
    part("const BATCH_TAIL_RE =", "function toBottomBtnHtml("),
  ]) vm.runInContext(code, context);
  const html = vm.runInContext('toolGroupHtml(input, "turn#0", "", false, "anchor", null, {})', context);
  assert.match(html, /<div class="tgrp-head"/, "the condensed group lost its head row");
  assert.doesNotMatch(html, /tgrp-flat/, "the condensed group is not a flat piece");
  assert.equal(count(html, /data-tgrp-call=/g), 0, "the condensed group draws no per-call row");
});
