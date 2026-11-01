// Drive the shipped renderer and full-result reader, not a copy of their behavior.
// The DOM/HTTP seams are recorded here; Chromium harnesses exercise the real page and SQLite route as well.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { linesForEvent } from "../lib/jobs/console-lines.js";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const part = (a, b) => {
  const start = source.indexOf(a);
  const end = source.indexOf(b, start);
  assert.ok(start >= 0 && end > start, `app.js still carries ${a}`);
  return source.slice(start, end);
};
const count = (html, re) => (html.match(re) || []).length;
const boxCount = (html) => count(html, /<div class="code-box /g);

function fixture({ flat = false, trimmed = false, response = null } = {}) {
  const full = Array.from({ length: 60 }, (_, i) => `result line ${i + 1}`);
  const input = [
    ...linesForEvent({ event: "tool.started", tool: "terminal", preview: "fixture command" }),
    ...linesForEvent({ event: "tool.completed", tool: "terminal", preview: JSON.stringify({ output: full.join("\n") }), rowAt: 0 }),
  ].map((l, i) => ({ ...l, lid: i + 1 }));
  const lines = trimmed ? input.slice(4) : input;
  const state = {
    projects: new Map(),
    jobs: new Map([["turn", { id: "turn", thread: "fixture-thread", status: "done", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z" }]]),
    toolStore: new Map(), toolGroupOpen: new Map(), codeBoxOpen: new Set(), codeBoxShut: new Set(),
    callFolded: new Set(), callOpen: new Set(), foldRows: new Map(), foldPending: new Map(), batchCalls: new Map(),
    // The console's own scroll book. A fold press hands the console over (Settings > Agent cards, off by default);
    // the button below is inside no `pre.job-out`, so the hold answers null here and nothing is written.
    outPinned: {}, outScrolls: {},
  };
  const requests = [];
  let repaints = 0;
  const context = vm.createContext({
    window: {}, console, state, URLSearchParams,
    document: { getElementById: () => null },
    normPath: (p) => String(p ?? "").split("\\").join("/"),
    turnLive: () => false,
    repaintToolGroup: () => { repaints++; },
    // The console hold's setting, read once per press. This fixture's control lives in no console, so the hold never
    // reaches it — the answer here is only what the shipped code would read from a browser that never set the switch.
    foldFollowsConsole: () => false,
    apiFetch: async (url) => {
      requests.push(url);
      return response ? response() : { ok: true, json: async () => ({ results: [{ text: full.join("\n"), truncated: false }] }) };
    },
    input: lines, flat,
  });
  for (const file of ["public/core/dom-format.js", "public/core/console-format.js"]) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  for (const code of [
    part("const TOOL_START_RE =", "// Index of the started tool call"),
    part("function toolBurstRows(", "function groupLines("),
    part("function groupLines(", "function storeOffsetsBefore("),
    // The hold a fold press takes on its console: the shipped function, with this fixture's control inside none.
    part("function holdConsoleFor(", "\n// Every scroll the panel performs goes through here."),
    part("const READ_CODE_OPEN =", "// A block the reader has open keeps"),
    part("// ---- tool group key", "// ---- end tool group key"),
    part("const BATCH_TAIL_RE =", "function toBottomBtnHtml("),
  ]) vm.runInContext(code, context);
  const render = () => vm.runInContext('toolGroupHtml(input, "turn#0", "", true, "anchor", null, {flat})', context);
  const hint = { textContent: "click to read" };
  const attributes = new Map();
  const grp = { dataset: { tgrp: "turn#0" } };
  const button = {
    dataset: { foldTurn: "turn", foldTool: "terminal", foldRow: "0", codeKey: "result|turn|terminal|0" },
    textContent: "terminal output 40 of 60 lines click to read",
    disabled: false,
    closest: (selector) => selector === ".tgrp" ? grp : null,
    querySelector: (selector) => selector === ".code-hint" ? hint : null,
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
  };
  context.button = button;
  const open = () => vm.runInContext("expandToolFold(button)", context);
  return { full, lines, state, render, open, requests, button, hint, attributes, context, repaints: () => repaints };
}

test("one click upgrades the existing result in condensed, stream and trimmed render paths", async () => {
  for (const opts of [{}, { flat: true }, { trimmed: true }, { flat: true, trimmed: true }]) {
    const f = fixture(opts);
    const before = f.render();
    assert.equal(boxCount(before), 1);
    assert.match(before, /class="code-head"[^>]*data-tool-fold="1"/, JSON.stringify(opts));
    assert.doesNotMatch(before, /fold-read|jl-fold/);
    const snapshot = JSON.stringify(f.lines);
    await f.open();
    const after = f.render();
    assert.equal(boxCount(after), 1, JSON.stringify(opts));
    assert.match(after, /class="code-body">/);
    assert.match(after, /class="code-n">60 lines</);
    assert.equal(count(after, /data-ltext="result line 1"/g), 1);
    assert.equal(count(after, /data-lkind="store"/g), f.full.length);
    assert.doesNotMatch(after, /data-tool-fold=|data-code-inverted|fold-read|jl-fold/);
    assert.match(f.requests[0], /row=0&full=1&n=1/);
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.stringify(f.lines), snapshot, "fetching must not grow the input console buffer");
    assert.equal(f.repaints(), 1);
  }
});

test("legacy results advance their own row cursor before any store read has arrived", () => {
  const f = fixture();
  const one = f.lines.map(({ fold, ...line }) => line);
  f.lines.splice(0, f.lines.length, ...one, ...one, ...one);
  const rows = [...f.render().matchAll(/data-fold-row="([0-9]+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(rows, [0, 1, 2]);
});

test("a trimmed preview does not subtract missing head lines from the result total", () => {
  const f = fixture({ trimmed: true });
  assert.match(f.render(), /class="code-n">38 of 60 lines</, "the wire note counts lines beyond the original 40-line head");
});

test("a loaded box reads back only its capped wire source, including the original result identity", async () => {
  const f = fixture();
  await f.open();
  const html = f.render();
  const encoded = /data-code-source="([^"]+)"/.exec(html)?.[1];
  assert.ok(encoded);
  const sourceJson = encoded.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const codeBox = { dataset: { codeSource: sourceJson }, classList: { contains: () => false } };
  codeBox.closest = () => codeBox;
  const stored = f.full.map((text) => ({
    dataset: { ltext: text, lkind: "store" }, classList: { contains: (name) => name === "jl-store" }, closest: () => codeBox,
  }));
  f.context.group = { querySelectorAll: (selector) => selector.includes(".code-box") ? [codeBox, ...stored] : stored };
  const read = vm.runInContext("groupLines(group)", f.context);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), f.lines.slice(2), "full output must never be mistaken for new console lines");
});

test("a failed full-result read preserves the header, reports the failure and can be retried", async () => {
  let attempt = 0;
  const f = fixture({ response: () => ++attempt === 1
    ? { ok: false, status: 503 }
    : { ok: true, json: async () => ({ results: [{ text: f.full.join("\n"), truncated: false }] }) } });
  const label = f.button.textContent;
  await f.open();
  assert.equal(f.button.textContent, label, "a status must not replace the header and its child controls");
  assert.match(f.hint.textContent, /could not be read.*retry/);
  assert.equal(f.button.disabled, false);
  assert.equal(f.attributes.has("aria-busy"), false);
  assert.equal(f.state.foldRows.size, 0);
  assert.equal(f.state.codeBoxOpen.size, 0);
  await f.open();
  assert.equal(f.requests.length, 2);
  assert.equal(boxCount(f.render()), 1);
  assert.match(f.render(), /class="code-n">60 lines</);
});

test("an empty stored row never replaces the readable preview with an empty box", async () => {
  const f = fixture({ response: () => ({ ok: true, json: async () => ({ results: [{ text: "", truncated: false }] }) }) });
  await f.open();
  assert.equal(f.state.foldRows.size, 0);
  assert.equal(boxCount(f.render()), 1);
  assert.match(f.hint.textContent, /no text.*retry/);
  assert.equal(f.button.disabled, false);
});

test("an empty live preview still loads a character-capped stored result through its single header", async () => {
  const wide = `wide result: ${"x".repeat(9000)}`;
  const f = fixture({ response: () => ({ ok: true, json: async () => ({ results: [{ text: wide, truncated: false }] }) }) });
  f.lines.splice(2);
  f.state.toolStore.set("turn|terminal", { results: [{ text: `${wide.slice(0, 6000)}\n… ${wide.length - 6000} characters not shown`, truncated: true }] });
  const before = f.render();
  assert.match(before, /class="code-head"[^>]*data-tool-fold="1"/, "a character cap needs the full-result reader even with fewer than 40 lines");
  assert.doesNotMatch(before, /class="code-n">[0-9]+ of [0-9]+ lines</, "the capped store read does not know the full line count");
  await f.open();
  const after = f.render();
  assert.equal(boxCount(after), 1);
  assert.match(after, /class="code-n">1 line</);
  assert.ok(after.includes(`data-ltext="${wide}"`));
  assert.match(after, /data-code-source="\[\]"/, "stored display rows must not be reabsorbed as wire output");
  assert.equal(f.lines.length, 2);
});

test("opening another large result never evicts the full text of an already-open box", async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) {
    const key = `older|terminal|${i}`;
    f.state.foldRows.set(key, { text: `still reading ${i}`, truncated: false });
    f.state.codeBoxOpen.add(`result|${key}`);
  }
  await f.open();
  assert.equal(f.state.foldRows.has("older|terminal|0"), true);
  assert.equal(f.state.foldRows.size, 13, "the cache cap may evict closed rows, not shrink an open result to its preview");
});

test("two copies of one opening share the pending fetch and keep header status separate", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ response: async () => {
    await gate;
    return { ok: true, json: async () => ({ results: [{ text: f.full.join("\n"), truncated: false }] }) };
  } });
  const label = f.button.textContent;
  const first = f.open();
  const second = f.open();
  const whilePending = f.requests.length;
  assert.equal(f.button.textContent, label);
  assert.match(f.hint.textContent, /reading/);
  assert.equal(f.attributes.get("aria-busy"), "true");
  assert.equal(f.button.disabled, true);
  release();
  await Promise.all([first, second]);
  assert.equal(whilePending, 1, "a repaint or pinned copy must not buy a second full read");
  assert.equal(f.state.foldPending.size, 0);
  assert.equal(f.button.disabled, false);
  assert.equal(f.attributes.has("aria-busy"), false);
});
