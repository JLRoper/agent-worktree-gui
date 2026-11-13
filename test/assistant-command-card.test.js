// The assistant's command lines, drawn as the tool card - and the rule that says when they are NOT drawn.
//
// A reply ends with lines in the panel's own vocabulary (`QUEUE assistant-3 | ...`, `TODO ADD ...`), and the reader
// met them as prose. This proves the reading that turns one of them into a card, and - the half that matters more -
// that a line the reading cannot finish with a title is left EXACTLY as it was, so a malformed bracket can never
// change what the panel shows the line to mean, let alone what it does.
//
//   1. the emoji map: one emoji per kind, nine kinds, no kind without one;
//   2. the 80-character rule, named and exported: a title of 80 characters counts, 81 does not, and a bracket that
//      never closes or never leads is not a title at all;
//   3. the header: the kind's emoji, then the recipient, then the title - `assistant-3 | Playwright test`;
//   4. the card is the SAME component a tool's result uses (core/console-format.js's frame), with a real button for
//      its head and a body folded to two lines;
//   5. the four lines the panel asks to see still run: an unclosed bracket, an 81-character bracket, a bracket on a
//      TODO line and a line with no bracket at all, each parsed by the EXECUTING grammar into the same row as before;
//   6. the queue row is byte-for-byte what it was: the title is not stripped from what executes;
//   7. the two surfaces call the one module, the page loads it after the frame it needs, and neither surface builds
//      a second card of its own.
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseActions } from "../lib/assistant/actions.js";

// The frame the page loads first (core/console-format.js) and this module draws with. In a browser it is
// `window`; here it is the same object, because the module is a classic script and says so.
globalThis.window = globalThis;
await import("../public/core/console-format.js");
await import("../public/core/assistant-command.js");
const M = globalThis.wtAssistantCommand;
const frame = globalThis.WMApp.core.consoleFormat;

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const turns = read("../public/turns.js");
const assistant = read("../public/assistant.js");
const html = read("../public/index.html");
const css = read("../public/style.css");
const app = read("../public/app.js");

const QUEUE = "QUEUE assistant-3 | [Playwright test] corner resize";

test("one emoji per kind, and a kind with no emoji is a bug", () => {
  assert.equal(M.KINDS.length, 9);
  const glyphs = M.KINDS.map((k) => M.COMMAND_EMOJI[k]);
  assert.deepEqual(Object.keys(M.COMMAND_EMOJI).sort(), [...M.KINDS].sort());
  assert.equal(new Set(glyphs).size, glyphs.length, "two kinds share an emoji");
  for (const glyph of glyphs) assert.ok(glyph && glyph.length >= 1, "a kind has no emoji");
  // The nine the panel names, in the head's order, and TO is deliberately not one of them: it addresses a worker.
  assert.deepEqual(M.KINDS, ["QUEUE", "MESSAGE", "SPAWN", "TODO", "RULE", "NOTE", "WATCH", "CHARTER", "RESTART"]);
  assert.equal(M.parseCommandLine("TO panel-assistant: hello"), null);
});

test("the header is the emoji, then the recipient, then the title", () => {
  const parsed = M.parseCommandLine(QUEUE);
  assert.equal(parsed.kind, "QUEUE");
  assert.equal(parsed.recipient, "assistant-3");
  assert.equal(parsed.title, "Playwright test");
  assert.equal(parsed.body, "corner resize");
  assert.equal(M.headerOf(parsed), `${M.COMMAND_EMOJI.QUEUE} assistant-3 | Playwright test`);
  // A kind that addresses nobody draws the emoji and the title alone.
  const rule = M.parseCommandLine("RULE: [Never PROD] deploy to QA only");
  assert.equal(rule.recipient, "");
  assert.equal(M.headerOf(rule), `${M.COMMAND_EMOJI.RULE} Never PROD`);
});

test("the 80-character rule: 80 counts, 81 does not, and the rule is an exported number", () => {
  assert.equal(M.COMMAND_TITLE_MAX, 80);
  const at = (n) => M.parseCommandLine(`QUEUE a | [${"x".repeat(n)}] body`);
  assert.equal(at(80).title.length, 80);
  assert.equal(at(81).title, null);
  // …and the card follows the same answer: no title, no card, the line stays the plain line it was.
  assert.equal(M.cardHtml(`QUEUE a | [${"x".repeat(81)}] body`, { key: "k" }), "");
  assert.notEqual(M.cardHtml(`QUEUE a | [${"x".repeat(80)}] body`, { key: "k" }), "");
});

test("an unclosed bracket, a bracket that does not lead, and no bracket at all are not titles", () => {
  for (const line of [
    "QUEUE assistant-3 | [Playwright test corner resize",
    "QUEUE assistant-3 | see [Playwright] below",
    "QUEUE assistant-3 | corner resize",
  ]) {
    const parsed = M.parseCommandLine(line);
    assert.ok(parsed, `the line is still a QUEUE line: ${line}`);
    assert.equal(parsed.title, null);
    assert.equal(M.cardHtml(line, { key: "k" }), "", `no card for: ${line}`);
  }
  // A TODO line with a bracket is a card; an id op carries no text, so it is not.
  const todo = M.parseCommandLine("TODO ADD [Playwright test] corner resize");
  assert.equal(todo.kind, "TODO");
  assert.equal(todo.title, "Playwright test");
  assert.match(M.cardHtml("TODO ADD [Playwright test] corner resize", { key: "k" }), /✓?|☑/u);
  assert.equal(M.parseCommandLine("TODO DONE 3").title, null);
});

test("the card is the tool card's own frame, with a button head and a two-line body", () => {
  // It is drawn BY the published frame, not by a copy: a frame that answers with a marker is what comes back.
  const original = frame.box;
  let called = 0;
  frame.box = (opts) => {
    called += 1;
    return original({ ...opts, what: `MARKED ${opts.what}` });
  };
  try {
    const card = M.cardHtml(QUEUE, { key: "cmd|t1|0" });
    assert.equal(called, 1, "the card did not go through core/console-format.js's frame");
    assert.match(card, /MARKED/);
  } finally {
    frame.box = original;
  }
  const card = M.cardHtml(QUEUE, { key: "cmd|t1|0" });
  assert.match(card, /^<div class="code-box is-cmd is-clamped" data-code-clamp="2">/);
  assert.match(card, /<button type="button" class="code-head" data-code-fold="1" data-code-key="cmd\|t1\|0" aria-expanded="false"/);
  assert.match(card, /<span class="code-caret">/);
  assert.match(card, /<span class="code-what">🧾 assistant-3 \| Playwright test<\/span>/);
  assert.match(card, /click to read/);
  // Folded, the body is on the page (folded to two lines by the stylesheet), never `hidden`.
  assert.match(card, /<div class="code-body">/);
  assert.doesNotMatch(card, /code-body" hidden/);
  // The same stylesheet rule, and the number it reads: two lines at this line height.
  assert.match(css, /\.code-box\.is-cmd\.is-clamped > \.code-body \{ max-height: 3em; overflow: hidden; \}/);
  // A head that is a real button is the keyboard's own control: Tab reaches it, Enter and Space press it, and it
  // carries the state. Nothing here draws a div pretending to be a press.
  const head = /<button type="button" class="code-head"[^>]*aria-expanded="false"[^>]*>/.exec(card);
  assert.ok(head, "the head is not a button with its expanded state");
  // The press handler is the console's own, and it knows the clamped body is not a hidden one.
  assert.match(app, /const clamp = Number\(box\.dataset\.codeClamp\) \|\| 0;/);
  assert.match(app, /box\.classList\.toggle\("is-clamped", !open\)/);
});

test("the executed text is untouched: the queue row is byte-for-byte what it was", () => {
  // What the EXECUTING grammar reads. The title is a second reading of the same string: it is not stripped here.
  const rows = parseActions(QUEUE);
  assert.equal(rows.queue.length, 1);
  assert.equal(rows.queue[0].assistant, "assistant-3");
  assert.equal(rows.queue[0].text, "[Playwright test] corner resize");
  // The card's own reading must never be what runs: the line it was handed is unchanged, and so is the parse.
  const before = JSON.stringify(parseActions(QUEUE));
  M.cardHtml(QUEUE, { key: "k" });
  M.cardsHtml(`one\n${QUEUE}\ntwo`, { scope: "m" });
  assert.equal(JSON.stringify(parseActions(QUEUE)), before);
  assert.equal(parseActions(QUEUE).queue[0].text, "[Playwright test] corner resize");
});

test("the four lines still execute and still parse into the rows they did before", () => {
  // 1. an unclosed bracket: the QUEUE row is the whole payload, exactly as it was written.
  const unclosed = "QUEUE assistant-3 | [Playwright test corner resize";
  assert.deepEqual(parseActions(unclosed).queue, [{ assistant: "assistant-3", text: "[Playwright test corner resize" }]);
  // 2. an 81-character bracket: the title is not a title, and the row is still the whole payload.
  const long = `QUEUE assistant-3 | [${"x".repeat(81)}] body`;
  assert.equal(parseActions(long).queue[0].text, `[${"x".repeat(81)}] body`);
  assert.equal(M.parseCommandLine(long).title, null);
  // 3. a bracket on a TODO line: the item's text keeps the bracket, so the list reads what was written.
  const todo = parseActions("TODO ADD [Playwright test] corner resize");
  assert.equal(todo.todo.length, 1);
  assert.equal(todo.todo[0].op, "add");
  assert.equal(todo.todo[0].text, "[Playwright test] corner resize");
  // 4. a command with no bracket at all: nothing about it changes, and it is not a card.
  const plain = "QUEUE assistant-3 | corner resize";
  assert.deepEqual(parseActions(plain).queue, [{ assistant: "assistant-3", text: "corner resize" }]);
  assert.equal(M.cardHtml(plain, { key: "k" }), "");
});

test("the compact snippet of a folded turn draws the same cards, in its own text", () => {
  // `compactHtml` is public/turns.js's frozen form of a closed turn, and the reader meets the command line there
  // long after the turn ended. The file is a classic script over globals, so it is loaded as one, into a context
  // that answers the four names it reaches for - the same four the page gives it.
  const src = read("../public/turns.js");
  const sandbox = {
    state: { jobLines: new Map(), jobs: new Map(), codeBoxOpen: new Set(), pinnedTurns: new Set() },
    esc: (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    linkifyText: (v) => sandbox.esc(v),
    isBookkeeping: () => false,
    jobLines: (id) => sandbox.state.jobLines.get(id) || [],
    CSS: { escape: (v) => String(v) },
    localStorage: { getItem: () => null, setItem: () => {} },
    turnLive: () => false,
    turnStateText: () => "",
    setScroll: () => {},
    // The module the page loads as a classic script; here the very object the page would get.
    wtAssistantCommand: M,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);
  assert.equal(typeof sandbox.compactHtml, "function", "turns.js did not load as the classic script it is");
  const turn = { id: "t-compact", lines: [{ kind: "text", text: QUEUE }] };
  sandbox.state.jobLines.set(turn.id, turn.lines);
  const snippet = sandbox.compactHtml(turn);
  assert.match(snippet, /data-compact-turn="t-compact"/);
  assert.match(snippet, /<div class="tc-answer"><div class="code-box is-cmd is-clamped"/);
  assert.match(snippet, /🧾 assistant-3 \| Playwright test/);
  // The three that are not cards keep the snippet's own text, exactly as it was drawn before.
  for (const text of [
    "QUEUE assistant-3 | [Playwright test corner resize",
    `QUEUE assistant-3 | [${"x".repeat(81)}] body`,
    "QUEUE assistant-3 | corner resize",
  ]) {
    sandbox.state.jobLines.set(turn.id, [{ kind: "text", text }]);
    const plain = sandbox.compactHtml(turn);
    assert.doesNotMatch(plain, /code-box/, `a compact card was drawn for: ${text.slice(0, 40)}`);
    assert.match(plain, /<div class="tc-answer">/);
    assert.ok(plain.includes(text.replace(/&/g, "&amp;")), "the snippet does not carry the line itself");
  }
});

test("both surfaces call the one module, and the page loads it after the frame it draws with", () => {
  assert.match(turns, /wtAssistantCommand/);
  assert.match(assistant, /wtAssistantCommand/);
  // The board's tail: the peek a folded turn draws, and the compact card it freezes to.
  assert.match(turns, /function commandCardHtml/);
  assert.match(turns, /commandCardHtml\(peek\.text/);
  assert.match(turns, /commandCardsHtml\(answer/);
  // The transcript: the entry's own body.
  assert.match(assistant, /msgCommandCards\(/);
  // No second card: neither surface writes the frame's markup itself, and `box` is the only place it lives.
  for (const source of [turns, assistant]) {
    assert.doesNotMatch(source, /class="code-box/);
    assert.doesNotMatch(source, /class="code-head/);
    assert.doesNotMatch(source, /data-code-clamp/);
  }
  // Loaded after the frame, and before the two surfaces that read it.
  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  assert.ok(at("/core/console-format.js") > 0);
  assert.ok(at("/core/assistant-command.js") > at("/core/console-format.js"));
  assert.ok(at("/turns.js") > at("/core/assistant-command.js"));
  assert.ok(at("/assistant.js") > at("/core/assistant-command.js"));
});
