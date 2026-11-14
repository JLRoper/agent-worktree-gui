// The assistant's command lines, drawn as the tool card - every readable one, titled or not.
//
// A reply ends with lines in the panel's own vocabulary (`QUEUE assistant-3 | ...`, `TODO ADD ...`), and the reader
// met them as prose. This proves the reading that turns one of them into a card, on all three surfaces a reader
// meets it: the board's tail, the Messages pane, and the agent card's own transcript. The title is a display nicety
// on top of that card: a malformed bracket is not a title, and it never changes what the line is or what the panel
// does with it.
//
//   1. the emoji map: one emoji per kind, nine kinds, no kind without one;
//   2. the 80-character rule, named and exported: a title of 80 characters counts, 81 does not - and the line is a
//      card either way, because the rule decides the TITLE and never whether a readable line is drawn;
//   3. the header: the kind's emoji, then the recipient, then the title when one parses;
//   4. a card for ANY readable line: untitled QUEUE, MESSAGE and SPAWN, and a titled one alongside them;
//   5. the card is the SAME component a tool's result uses (core/console-format.js's frame), with a real button for
//      its head and a body folded to two lines;
//   6. the agent card's transcript reaches that card through the one prose renderer, and holds no builder of its own;
//   7. the four lines the panel asks to see still run: an unclosed bracket, an 81-character bracket, a bracket on a
//      TODO line and a line with no bracket at all, each parsed by the EXECUTING grammar into the same row as before;
//   8. the queue row is byte-for-byte what it was: the title is not stripped from what executes;
//   9. the panes call the one module, the page loads it after the frame it needs, and no surface builds a second card.
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
const jobs = read("../public/render-jobs.js");
const markdown = read("../public/core/console-markdown.js");
const board = read("../public/board/console.js");
const html = read("../public/index.html");
const css = read("../public/style.css");
const app = read("../public/app.js");

const QUEUE = "QUEUE assistant-3 | [Playwright test] corner resize";
const PLAIN_QUEUE = "QUEUE assistant-3 | corner resize";
const PLAIN_MESSAGE = "MESSAGE assistant-3 | the deploy moved";
const PLAIN_SPAWN = "SPAWN IN #12 agent-worktree-gui | card it";
const UNCLOSED = "QUEUE assistant-3 | [Playwright test corner resize";
const TOO_LONG = `QUEUE assistant-3 | [${"x".repeat(81)}] body`;
const INNER = "QUEUE assistant-3 | see [Playwright] below";

const EM = M.COMMAND_EMOJI;
const head = (what) => `<span class="code-what">${what}</span>`;

test("one emoji per kind, and a kind with no emoji is a bug", () => {
  assert.equal(M.KINDS.length, 9);
  const glyphs = M.KINDS.map((k) => M.COMMAND_EMOJI[k]);
  assert.deepEqual(Object.keys(M.COMMAND_EMOJI).sort(), [...M.KINDS].sort());
  assert.equal(new Set(glyphs).size, glyphs.length, "two kinds share an emoji");
  for (const glyph of glyphs) assert.ok(glyph && glyph.length >= 1, "a kind has no emoji");
  // The nine the panel names, in the head's order, and TO is deliberately not one of them: it addresses a worker.
  assert.deepEqual(M.KINDS, ["QUEUE", "MESSAGE", "SPAWN", "TODO", "RULE", "NOTE", "WATCH", "CHARTER", "RESTART"]);
  assert.equal(M.parseCommandLine("TO panel-assistant: hello"), null);
  // …and a line that is not of the vocabulary is not a card at all.
  assert.equal(M.cardHtml("TO panel-assistant: hello", { key: "k" }), "");
  assert.equal(M.cardHtml("just a sentence about QUEUEing work", { key: "k" }), "");
});

test("the header is the emoji, then the recipient, then the title when one parses", () => {
  const parsed = M.parseCommandLine(QUEUE);
  assert.equal(parsed.kind, "QUEUE");
  assert.equal(parsed.recipient, "assistant-3");
  assert.equal(parsed.title, "Playwright test");
  assert.equal(parsed.body, "corner resize");
  assert.equal(M.headerOf(parsed), `${EM.QUEUE} assistant-3 | Playwright test`);
  // A kind that addresses nobody draws the emoji and the title alone.
  const rule = M.parseCommandLine("RULE: [Never PROD] deploy to QA only");
  assert.equal(rule.recipient, "");
  assert.equal(M.headerOf(rule), `${EM.RULE} Never PROD`);
  // Without a title the head is the emoji and the recipient - which is all the line itself names.
  assert.equal(M.headerOf(M.parseCommandLine(PLAIN_MESSAGE)), `${EM.MESSAGE} assistant-3`);
  assert.equal(M.headerOf(M.parseCommandLine(PLAIN_SPAWN)), `${EM.SPAWN} IN #12 agent-worktree-gui`);
  // A kind that addresses nobody and carries no title says its own kind, so a head is never a bare glyph.
  assert.equal(M.headerOf(M.parseCommandLine("RULE: deploy to QA only")), `${EM.RULE} RULE`);
});

test("the 80-character rule: 80 is a title, 81 is not, and the line is a card either way", () => {
  assert.equal(M.COMMAND_TITLE_MAX, 80);
  const at = (n) => M.parseCommandLine(`QUEUE a | [${"x".repeat(n)}] body`);
  assert.equal(at(80).title.length, 80);
  assert.equal(at(81).title, null);
  // The rule decides the TITLE, never whether a readable line is drawn: both are cards, one just has no title.
  const eighty = M.cardHtml(`QUEUE a | [${"x".repeat(80)}] body`, { key: "k" });
  const eightyOne = M.cardHtml(`QUEUE a | [${"x".repeat(81)}] body`, { key: "k" });
  assert.notEqual(eighty, "");
  assert.notEqual(eightyOne, "");
  assert.ok(eighty.includes(head(`${EM.QUEUE} a | ${"x".repeat(80)}`)), "80 characters is a title");
  assert.ok(eightyOne.includes(head(`${EM.QUEUE} a`)), "81 characters is not a title, and the head says so");
  // …and the bracket that is not a title stays in the body, as the payload it is.
  assert.ok(eightyOne.includes(`[${"x".repeat(81)}] body`), "the payload keeps its bracket");
});

test("a bracket that never closes, one that does not lead, and no bracket at all are cards without a title", () => {
  for (const line of [UNCLOSED, INNER, PLAIN_QUEUE]) {
    const parsed = M.parseCommandLine(line);
    assert.ok(parsed, `the line is still a QUEUE line: ${line}`);
    assert.equal(parsed.title, null);
    const card = M.cardHtml(line, { key: "k" });
    assert.notEqual(card, "", `a readable line is a card: ${line}`);
    assert.ok(card.includes(head(`${EM.QUEUE} assistant-3`)), `the head is the kind and the recipient: ${line}`);
    assert.ok(card.includes(parsed.body), "the body is the payload, as written");
  }
  // A TODO line with a bracket is a card with its title; an id op carries no text, so there is no body to show.
  const todo = M.parseCommandLine("TODO ADD [Playwright test] corner resize");
  assert.equal(todo.kind, "TODO");
  assert.equal(todo.title, "Playwright test");
  assert.match(M.cardHtml("TODO ADD [Playwright test] corner resize", { key: "k" }), /✓?|☑/u);
  assert.equal(M.parseCommandLine("TODO DONE 3").title, null);
  assert.equal(M.cardHtml("TODO DONE 3", { key: "k" }), "", "nothing but the command: the prose line is the whole command");
});

test("untitled MESSAGE, QUEUE and SPAWN lines are cards, and a titled one keeps its title", () => {
  const cases = [
    { line: PLAIN_QUEUE, what: `${EM.QUEUE} assistant-3`, body: "corner resize" },
    { line: PLAIN_MESSAGE, what: `${EM.MESSAGE} assistant-3`, body: "the deploy moved" },
    { line: PLAIN_SPAWN, what: `${EM.SPAWN} IN #12 agent-worktree-gui`, body: "card it" },
    { line: QUEUE, what: `${EM.QUEUE} assistant-3 | Playwright test`, body: "corner resize" },
  ];
  for (const c of cases) {
    const card = M.cardHtml(c.line, { key: `k|${c.what}` });
    assert.notEqual(card, "", `no card for: ${c.line}`);
    assert.ok(card.includes(head(c.what)), `the head of ${c.line} is wrong`);
    assert.ok(card.includes(`<div class="jl jl-text">${c.body}</div>`), `the body of ${c.line} is wrong`);
    assert.match(card, /data-code-clamp="2"/, "folded to two lines");
  }
  // A block of the four: every one of them a card, and the prose around them still prose.
  const block = M.cardsHtml(["here is what is queued.", ...cases.map((c) => c.line)].join("\n"), { scope: "msg|1", open: new Set() });
  assert.equal((block.match(/class="code-box is-cmd/g) || []).length, 4, "four cards, one per line");
  assert.ok(block.includes(`<div class="jl jl-text">here is what is queued.</div>`), "the prose line is not a card");
  // The four keys are the lines' own places in the message, so a repaint keeps each card's fold apart.
  for (let i = 1; i <= 4; i += 1) assert.match(block, new RegExp(`data-code-key="cmd\\|msg\\|1\\|${i}"`));
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
  assert.match(card, /^<div class="code-box is-cmd is-clamped" data-ltext="QUEUE assistant-3 \| \[Playwright test\] corner resize"/);
  assert.match(card, /<button type="button" class="code-head" data-code-fold="1" data-code-key="cmd\|t1\|0" aria-expanded="false"/);
  assert.match(card, /<span class="code-caret">/);
  assert.ok(card.includes(head(`${EM.QUEUE} assistant-3 | Playwright test`)));
  assert.match(card, /click to read/);
  // Folded, the body is on the page (folded to two lines by the stylesheet), never `hidden`.
  assert.match(card, /<div class="code-body">/);
  assert.doesNotMatch(card, /code-body" hidden/);
  // The same stylesheet rule, and the number it reads: two lines at this line height.
  assert.match(css, /\.code-box\.is-cmd\.is-clamped > \.code-body \{ max-height: 3em; overflow: hidden; \}/);
  // A head that is a real button is the keyboard's own control: Tab reaches it, Enter and Space press it, and it
  // carries the state. Nothing here draws a div pretending to be a press.
  const press = /<button type="button" class="code-head"[^>]*aria-expanded="false"[^>]*>/.exec(card);
  assert.ok(press, "the head is not a button with its expanded state");
  // The press handler is the console's own, and it knows the clamped body is not a hidden one.
  assert.match(app, /const clamp = Number\(box\.dataset\.codeClamp\) \|\| 0;/);
  assert.match(app, /box\.classList\.toggle\("is-clamped", !open\)/);
});

test("the agent card's transcript draws the same card, through the one prose renderer and no builder of its own", () => {
  // public/render-jobs.js draws a turn's prose with core/console-markdown.js, which is the one renderer both the
  // console and the transcript use. Loaded the way the page loads it: classic scripts, window === globalThis.
  const ctx = vm.createContext({ console });
  vm.runInContext("globalThis.window = globalThis;", ctx);
  for (const file of [
    "../public/core/dom-format.js",
    "../public/core/console-format.js",
    "../public/core/assistant-command.js",
    "../public/core/console-markdown.js",
  ]) {
    vm.runInContext(read(file), ctx, { filename: file });
  }
  const md = ctx.window.WMApp.core.consoleMarkdown;
  const lines = [PLAIN_MESSAGE, PLAIN_QUEUE, PLAIN_SPAWN, QUEUE].map((text, i) => ({ kind: "text", text, lid: 200 + i }));
  // A caller that did not ask keeps the rows it always drew: the console's own live path is untouched.
  assert.doesNotMatch(md.html(lines), /code-box/);
  const drawn = md.html(lines, { cards: { scope: "turn-7", open: new Set() } });
  assert.equal((drawn.match(/class="code-box is-cmd is-clamped"/g) || []).length, 4, "all four are cards in a transcript");
  assert.ok(drawn.includes(head(`${EM.MESSAGE} assistant-3`)));
  assert.ok(drawn.includes(head(`${EM.SPAWN} IN #12 agent-worktree-gui`)));
  assert.ok(drawn.includes(head(`${EM.QUEUE} assistant-3 | Playwright test`)));
  // Each card carries the line itself, keyed by the line's own id, so a repaint keeps the reader's fold and the
  // console's copy lifts the line rather than the card's chrome.
  assert.match(drawn, /class="code-box is-cmd is-clamped" data-ltext="MESSAGE assistant-3 \| the deploy moved" data-lkind="text" data-lid="200"/);
  assert.match(drawn, /data-code-key="cmd\|turn-7\|200"/);
  // The renderer this page hands a turn's prose to, and the scope it hands over: one line per call site, no builder.
  assert.match(jobs, /mdRunHtml\(mdRun\.lines, mdRun\.sep, \{ scope: turn\.id, open: state\.codeBoxOpen \}\)/);
  assert.match(jobs, /mdRunHtml\(run, "", \{ scope: turn\.id, open: state\.codeBoxOpen \}\)/);
  for (const source of [jobs, markdown]) {
    assert.doesNotMatch(source, /class="code-box/, "a second card builder in the transcript's own files");
    assert.doesNotMatch(source, /class="code-head/);
    assert.doesNotMatch(source, /data-code-clamp/);
  }
  // One seam: the prose renderer asks console-format, which asks the one module. The copy walker lifts the line.
  assert.match(markdown, /cf\.commandLine\(/);
  assert.match(markdown, /cf\.commandCard\(/);
  assert.match(board, /\.code-box\[data-ltext\]/);
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
  M.cardHtml(PLAIN_QUEUE, { key: "k" });
  M.cardsHtml(`one\n${QUEUE}\ntwo\n${PLAIN_MESSAGE}`, { scope: "m" });
  assert.equal(JSON.stringify(parseActions(QUEUE)), before);
  assert.equal(parseActions(QUEUE).queue[0].text, "[Playwright test] corner resize");
});

test("the four lines still execute and still parse into the rows they did before", () => {
  // 1. an unclosed bracket: the QUEUE row is the whole payload, exactly as it was written.
  assert.deepEqual(parseActions(UNCLOSED).queue, [{ assistant: "assistant-3", text: "[Playwright test corner resize" }]);
  // 2. an 81-character bracket: the title is not a title, and the row is still the whole payload.
  assert.equal(parseActions(TOO_LONG).queue[0].text, `[${"x".repeat(81)}] body`);
  assert.equal(M.parseCommandLine(TOO_LONG).title, null);
  // 3. a bracket on a TODO line: the item's text keeps the bracket, so the list reads what was written.
  const todo = parseActions("TODO ADD [Playwright test] corner resize");
  assert.equal(todo.todo.length, 1);
  assert.equal(todo.todo[0].op, "add");
  assert.equal(todo.todo[0].text, "[Playwright test] corner resize");
  // 4. a command with no bracket at all: nothing about it changes, and it is a card like any other readable line.
  assert.deepEqual(parseActions(PLAIN_QUEUE).queue, [{ assistant: "assistant-3", text: "corner resize" }]);
  assert.notEqual(M.cardHtml(PLAIN_QUEUE, { key: "k" }), "");
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
  assert.ok(snippet.includes(head(`${EM.QUEUE} assistant-3 | Playwright test`)));
  // The three that carry no title are still cards - the line the reader meets is a command either way - and each
  // one is drawn with its emoji, its recipient and its own payload.
  for (const text of [UNCLOSED, TOO_LONG, PLAIN_QUEUE]) {
    sandbox.state.jobLines.set(turn.id, [{ kind: "text", text }]);
    const card = sandbox.compactHtml(turn);
    assert.match(card, /code-box is-cmd/, `a compact card was not drawn for: ${text.slice(0, 40)}`);
    assert.ok(card.includes(head(`${EM.QUEUE} assistant-3`)), "the compact card's head is the kind and the recipient");
    assert.ok(card.includes(text.replace(/&/g, "&amp;")), "the card carries the line itself");
  }
  // The one line that is nothing but its own command keeps the snippet's plain text.
  sandbox.state.jobLines.set(turn.id, [{ kind: "text", text: "TODO DONE 3" }]);
  const plain = sandbox.compactHtml(turn);
  assert.doesNotMatch(plain, /code-box/);
  assert.match(plain, /<div class="tc-answer">/);
  assert.ok(plain.includes("TODO DONE 3"));
});

test("every pane calls the one module, and the page loads it after the frame it draws with", () => {
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
  // Loaded after the frame, and before the two surfaces that read it. console-markdown comes after the module it
  // asks for a card, because the transcript's route runs through it.
  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  assert.ok(at("/core/console-format.js") > 0);
  assert.ok(at("/core/assistant-command.js") > at("/core/console-format.js"));
  assert.ok(at("/core/console-markdown.js") > at("/core/assistant-command.js"));
  assert.ok(at("/turns.js") > at("/core/assistant-command.js"));
  assert.ok(at("/assistant.js") > at("/core/assistant-command.js"));
});

// ---- a SPAWN's TODOs, as its own card's bullets ------------------------------------------------------
// A TODO written under a SPAWN belongs to the tree that SPAWN names (the grammar's own words), so it is one bullet of
// the SPAWN's card instead of a card of its own. The bullet reads `<category> - <todo>`, the category being the TODO's
// leading `[Title]`, and the rows sit BETWEEN the head and the body - outside the clamp - so a folded card still
// shows every item. A TODO with no SPAWN above it keeps its card.

const SWEEP = [
  "SPAWN IN #398 sales-citdev-POC-build-1 | [Tight sweep] inventory, salvage, squash, land, delete - local only",
  "TODO [Inventory first] Write docs/reports/worktree-cleanup.md naming every tree",
  "TODO [Salvage] Cut one branch from 88d1538 and take the four trees' commits",
  "TODO ADD [Squash and prove] Squash to one commit and prove the tree hash",
];

test("a SPAWN's TODOs are its card's bullets, and stop being cards of their own", () => {
  const plan = M.foldSpawnTodos(SWEEP.map((text, i) => ({ text, i })));
  assert.equal(plan[0].todos.length, 3, "the SPAWN owns the three TODOs below it");
  for (const at of [1, 2, 3]) assert.equal(plan[at].folded, true, `the TODO on line ${at} is folded into the card`);
  // The bullet's own reading, in the one place that names it.
  assert.deepEqual(
    plan[0].todos.map(M.bulletLabel),
    [
      "Inventory first - Write docs/reports/worktree-cleanup.md naming every tree",
      "Salvage - Cut one branch from 88d1538 and take the four trees' commits",
      "Squash and prove - Squash to one commit and prove the tree hash",
    ],
  );
  const block = M.cardsHtml(SWEEP.join("\n"), { scope: "msg|398", open: new Set() });
  assert.equal((block.match(/class="code-box/g) || []).length, 1, "one card, not four: the TODOs drew none of their own");
  assert.equal((block.match(/class="code-bullet"/g) || []).length, 3, "three bullet rows inside it");
  assert.ok(!block.includes(`<span class="code-what">${EM.TODO}`), "no TODO card is drawn");
  // Each bullet reads: the checkbox glyph, the category, then the item - and carries the TODO it came from.
  for (const [i, todo] of plan[0].todos.entries()) {
    assert.ok(block.includes(`<span class="code-bullet-glyph" aria-hidden="true">${EM.TODO}</span>`), "a bullet carries the TODO glyph");
    assert.ok(block.includes(`<span class="code-bullet-text">${todo.category} - ${todo.text}</span>`), `bullet ${i + 1} reads category - item`);
    assert.ok(block.includes(`title="${SWEEP[i + 1]}"`), `bullet ${i + 1} carries its TODO line`);
  }
  // The head shows the count, and the card is still the same frame with the same line on it.
  assert.ok(block.includes(`<span class="code-n">3 todos</span>`), "the head counts the bullets");
  assert.ok(block.includes('data-cmd-bullets="3"'), "the card says how many it carries");
  assert.ok(block.includes(`data-ltext="${SWEEP[0]}"`), "the box still carries the SPAWN line itself");
  // BULLETS STAY VISIBLE WHEN THE BODY IS FOLDED. They are rows BETWEEN the head and the body, and the clamp is on
  // the body, so the folded card is two lines of payload with the whole list above it.
  const head = block.indexOf("</button>");
  const bulletsAt = block.indexOf('<div class="code-bullets"');
  const bodyAt = block.indexOf('<div class="code-body"');
  assert.ok(head > 0 && bulletsAt > head && bodyAt > bulletsAt, "the bullets sit between the head and the body");
  assert.match(block, /class="code-box is-cmd is-clamped"/, "the body is folded to two lines");
  const bodyOnly = block.slice(bodyAt, block.indexOf("</div>", block.lastIndexOf("</div>")));
  assert.ok(!bodyOnly.includes("code-bullet"), "and no bullet is inside the clamped body");
  // The stylesheet keeps the count on a bullets-bearing card, and the fold is the same two lines.
  assert.match(css, /\.code-box\.is-cmd\[data-cmd-bullets\] > \.code-head \.code-n \{ display: inline; \}/);
  assert.match(css, /\.code-box\.is-cmd > \.code-bullets \{/);
});

test("a TODO with no SPAWN above it keeps its card, and the nearest SPAWN owns the rest", () => {
  const solo = M.cardsHtml("TODO ADD [Solo] no spawn above this", { scope: "msg|2", open: new Set() });
  assert.equal((solo.match(/class="code-box/g) || []).length, 1, "a TODO with no SPAWN above it is still a card");
  assert.ok(solo.includes(`<span class="code-what">${EM.TODO} Solo</span>`), "with its own head");
  assert.ok(!solo.includes("code-bullets"), "and no bullets, because it owns no tree");
  // Two SPAWNs: each TODO goes to the nearest one above it, and neither card steals the other's work.
  const two = ["SPAWN IN a | first", "TODO [A] one", "SPAWN IN b | second", "TODO [B] two"];
  const pair = M.cardsHtml(two.join("\n"), { scope: "msg|3", open: new Set() });
  assert.equal((pair.match(/class="code-box/g) || []).length, 2, "two SPAWN cards");
  assert.equal((pair.match(/class="code-bullet"/g) || []).length, 2, "one bullet each");
  assert.ok(pair.includes("<span class=\"code-bullet-text\">A - one</span>") && pair.includes("<span class=\"code-bullet-text\">B - two</span>"));
  assert.equal((pair.match(/<span class="code-n">1 todo<\/span>/g) || []).length, 2, "each head says one todo");
  // An id op carries no text: it is not a bullet, and it keeps the prose line it always was.
  const idOp = M.cardsHtml("SPAWN IN a | first\nTODO DONE 3", { scope: "msg|4", open: new Set() });
  assert.ok(!idOp.includes("code-bullet"), "an id op is not folded into the card");
  assert.ok(idOp.includes("TODO DONE 3"), "and it is still drawn, as the line it always was");
  // A TODO with no bracket is still the SPAWN's bullet: the glyph and the item, with no invented category.
  const bare = M.cardsHtml("SPAWN IN a | first\nTODO ADD no bracket here", { scope: "msg|5", open: new Set() });
  assert.ok(bare.includes("<span class=\"code-bullet-text\">no bracket here</span>"), "no bracket, no category, the item as written");
  // A SPAWN with no TODOs is untouched: no bullet row, no count, the card it always was.
  const plain = M.cardHtml(PLAIN_SPAWN, { key: "k" });
  assert.ok(!plain.includes("code-bullets") && !plain.includes("data-cmd-bullets"), "a SPAWN with no TODOs draws no bullets");
});

test("the fold is display-only: the executing grammar still reads every TODO row, bracket and all", () => {
  const rows = parseActions(SWEEP.join("\n"));
  assert.equal(rows.todo.length, 3, "three TODO rows, exactly as before the card drew them");
  assert.deepEqual(
    rows.todo.map((t) => t.text),
    [
      "[Inventory first] Write docs/reports/worktree-cleanup.md naming every tree",
      "[Salvage] Cut one branch from 88d1538 and take the four trees' commits",
      "[Squash and prove] Squash to one commit and prove the tree hash",
    ],
    "the category is NOT stripped from what runs",
  );
  assert.deepEqual(rows.todo.map((t) => t.op), ["add", "add", "add"]);
  // Drawing the card changes neither the parse nor the line: the bullets are a second reading of the same strings.
  const before = JSON.stringify(parseActions(SWEEP.join("\n")));
  M.cardsHtml(SWEEP.join("\n"), { scope: "msg|398", open: new Set() });
  assert.equal(JSON.stringify(parseActions(SWEEP.join("\n"))), before);
  // And the executing modules this card must never reach for are named here, so a later change cannot quietly move
  // the reading into them: the parser is the grammar's, the list is lib/todos.js's, and neither is imported here.
  const source = read("../public/core/assistant-command.js");
  assert.doesNotMatch(source, /(?:import|require)\s*\(?\s*["'][^"']*(?:assistant\/actions|todos)\.js/, "the card imports neither executor");
});

test("the agent card's transcript folds the same TODOs into the same card, through the same module", () => {
  const ctx = vm.createContext({ console });
  vm.runInContext("globalThis.window = globalThis;", ctx);
  for (const file of [
    "../public/core/dom-format.js",
    "../public/core/console-format.js",
    "../public/core/assistant-command.js",
    "../public/core/console-markdown.js",
  ]) {
    vm.runInContext(read(file), ctx, { filename: file });
  }
  const md = ctx.window.WMApp.core.consoleMarkdown;
  const lines = ["nothing else to report.", ...SWEEP].map((text, i) => ({ kind: "text", text, lid: 300 + i }));
  // A caller that did not ask for cards keeps every row it always drew - the console's own live path.
  const plain = md.html(lines);
  assert.doesNotMatch(plain, /code-box/);
  assert.equal((plain.match(/class="jl /g) || []).length, 5, "five rows, the TODOs included");
  // Asked for cards, the transcript draws ONE SPAWN card with three bullets, and no TODO card at all.
  const drawn = md.html(lines, { cards: { scope: "turn-9", open: new Set() } });
  assert.equal((drawn.match(/class="code-box is-cmd is-clamped"/g) || []).length, 1, "one card in the transcript");
  assert.equal((drawn.match(/class="code-bullet"/g) || []).length, 3, "carrying the three bullets");
  assert.ok(!drawn.includes("code-what\">" + EM.TODO), "and no TODO card");
  for (const line of SWEEP.slice(1)) {
    assert.ok(!drawn.includes(`data-ltext="${line}"`), "a folded TODO line is not drawn as a row of its own");
  }
  assert.ok(drawn.includes(`<span class="code-n">3 todos</span>`), "the head counts them here too");
  assert.match(drawn, /data-code-key="cmd\|turn-9\|301"/, "keyed by the SPAWN line's own id");
  // The seam, in one place: the transcript asks the frame for the fold, and the frame asks the one module.
  assert.match(markdown, /cf\.commandFold\(/);
  assert.match(read("../public/core/console-format.js"), /commandFold: cfCommandFold/);
});
