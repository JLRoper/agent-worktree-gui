// The reasoning toggle draws what arrives after it is switched, never what is already on screen.
//
// What went wrong. Switching 🧠 on while a turn was streaming made every block the store already held look NEW to the
// word pacer. With the toggle off nothing feeds the pacer, so its first frame for each block was the block's whole
// text, queued to be typed: a live turn's window holds tens of blocks and >100 kB of reasoning on this box, so the
// press re-typed the turn's reasoning from its first word instead of switching the pane on. The transcript was
// already on screen; nothing about it had changed.
//
// The rule this file pins: a block first seen on a live turn is WRITTEN only while it is the newest thought the turn
// has. Everything older is history and paints whole. The rule is READ OUT of public/board/console.js between its
// markers and driven through the page's own pacer (public/core/type-stream.js), with its clock and timer injected, so
// the test runs the one implementation the page runs and time is the thing under test.
import assert from "node:assert/strict";
import test from "node:test";

import { readSource, sliceBetween } from "../tools/panel-testkit.mjs";

await import("../public/core/type-stream.js");
const { createDrawStream } = globalThis.wtType;

const code = sliceBetween(readSource("public/board/console.js"), "// ---- reasoning first", "// ---- console row text");
// `thinkingOn`, `streamOn`, `thinkOpenFor` and `turnLive` are app.js's answers, read from inside a function body in
// the page; here they are handed in, so the toggle is a value this file can switch mid-run.
const make = new Function(
  "state",
  "document",
  "TOOL_DONE_RE",
  "consoleFoldNote",
  "loadThinkingAfter",
  "thinkingOn",
  "streamOn",
  "thinkOpenFor",
  "turnLive",
  `${code}\nreturn { paceThinkBlock, typedText, typedShown };`,
);

const words = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
// The size a real turn's blocks are (1-8 kB each, measured on this box). They have to be this long for a reason: at
// 40 words a second the pacer is still deep inside a block minutes after it arrived, which is what made "the whole
// text" and "the prefix the clock had reached" two visibly different transcripts.
const BLOCK_A = words("alpha", 400);
const BLOCK_B = words("beta", 400);
const BLOCK_C = words("gamma", 400);
const AT_A = 1_760_000_000_000;
const AT_B = AT_A + 4_000;
const AT_C = AT_A + 8_000;

// The turn's prose, already drawn whole before the toggle is touched. `typedShown` answers for these exactly as
// `lineHtml` asks it on a repaint.
const PROSE = [
  { kind: "text", text: "Reading the tree before anything else.", lid: "t1" },
  { kind: "text", text: "Nothing odd so far.", lid: "t2" },
];

function bench() {
  let t = 1_000_000;
  const timers = new Map();
  let seq = 0;
  const clock = {
    now: () => t,
    schedule: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: t + Math.max(1, ms) });
      return id;
    },
    cancel: (id) => timers.delete(id),
  };
  const painted = [];
  const pacer = createDrawStream({ ...clock, rate: 40, onPaint: (lids) => painted.push(...lids) });
  const view = { thinking: false };
  const turn = { id: "turn1", thread: "thread1", status: "running" };
  const blocks = [
    { at: AT_A, text: BLOCK_A },
    { at: AT_B, text: BLOCK_B },
    { at: AT_C, text: BLOCK_C },
  ];
  const state = {
    typeStream: pacer,
    thinkFed: new Set(),
    thinkCache: new Map([[turn.id, { blocks, at: 0 }]]),
    jobs: new Map([[turn.id, turn]]),
    jobLines: new Map([[turn.id, []]]),
    reasoningReads: new Map(),
    thinkOpen: new Set(),
    thinkClosed: new Set(),
  };
  const document = { hidden: false };
  const page = make(
    state,
    document,
    /^\s*↳\s*([^\s·]+)/,
    () => false,
    async () => {},
    () => view.thinking,
    () => true,
    () => true,
    (x) => x.status === "running",
  );
  // One paint of the turn, the way the card draws it: prose through typedShown, and - only while 🧠 is on - the
  // reasoning blocks through paceThinkBlock, which is the call that feeds the pacer.
  const render = () => {
    const out = { prose: [], blocks: [] };
    for (const l of PROSE) out.prose.push({ lid: l.lid, text: page.typedShown(l) ?? l.text });
    if (!view.thinking) return out;
    for (const b of blocks) {
      const shown = page.paceThinkBlock(turn, b);
      out.blocks.push({ at: b.at, text: shown == null ? b.text : shown });
    }
    return out;
  };
  const step = (ms) => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, x]) => x.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, x] = due;
      timers.delete(id);
      t = Math.max(t, x.at);
      x.fn();
    }
    t = target;
  };
  return { page, pacer, state, view, turn, blocks, document, render, step, painted, timers: () => timers.size };
}

test("switching thinking on mid-stream does not re-emit what is already on screen", () => {
  const b = bench();
  const before = b.render();
  assert.deepEqual(
    before.prose.map((p) => p.text),
    PROSE.map((p) => p.text),
    "the console is already showing its prose whole",
  );
  assert.deepEqual(before.blocks, [], "with the toggle off no reasoning is drawn");
  assert.equal(b.pacer.size(), 0, "and nothing reasoning-shaped has been handed to the pacer");

  // The reader presses 🧠. The card repaints: the same prose, and every block the store already held.
  b.view.thinking = true;
  const after = b.render();

  assert.deepEqual(after.prose, before.prose, "every line already on screen is drawn exactly as it was, not re-emitted");
  assert.equal(b.pacer.size(), 1, "only ONE chunk was handed to the pacer: the newest thought, not the history");
  assert.deepEqual(
    after.blocks.map((x) => x.text.length),
    [BLOCK_A.length, BLOCK_B.length, 0],
    "the turn's older thoughts paint whole at once; only the newest is written from its first word",
  );
  assert.deepEqual(
    [...b.state.thinkFed],
    [`think:${AT_C}`],
    "the pacer was told about the newest block and nothing else",
  );
});

test("the blocks painted on the press are never written afterwards: the history stays whole", () => {
  const b = bench();
  b.view.thinking = true;
  b.render();
  // Two seconds in: the newest block is part-way through its own text, and the history has not moved a character.
  b.step(2000);
  const early = b.render();
  assert.equal(early.blocks[0].text, BLOCK_A, "the oldest block reads its whole text");
  assert.equal(early.blocks[1].text, BLOCK_B, "and so does the one before the newest");
  const newest = early.blocks[2].text;
  assert.ok(newest.length > 0 && newest.length < BLOCK_C.length, "the newest block is the one being written");
  assert.equal(BLOCK_C.startsWith(newest), true, "and what it writes is its own text, in order");
  assert.equal(
    b.pacer.pendingWords(),
    globalThis.wtType.wordsIn(BLOCK_C) - globalThis.wtType.wordsIn(newest),
    "only the newest block's words are waiting; the history's 800 were never queued",
  );
  // A minute later the newest block has been written out and the history still reads exactly as it did at the press.
  b.step(60_000);
  const later = b.render();
  assert.equal(later.blocks[0].text, BLOCK_A);
  assert.equal(later.blocks[1].text, BLOCK_B);
  assert.equal(later.blocks[2].text, BLOCK_C, "the newest block ends on its whole text once the clock has run");
  assert.equal(b.pacer.pendingWords(), 0, "nothing is left waiting");
});

test("what arrives after the switch is written, and the history does not move for it", () => {
  const b = bench();
  b.view.thinking = true;
  b.render();
  b.step(4000);
  const grown = b.render();
  const newestBefore = grown.blocks[2].text;
  assert.ok(newestBefore.length > 0 && newestBefore.length < BLOCK_C.length, "the newest block is part-way");
  // The turn thinks again: the store appends a fourth block. It is the newest, so it is the one written now.
  b.blocks.push({ at: AT_C + 4_000, text: words("delta", 400) });
  const arrived = b.render();
  assert.equal(arrived.blocks[0].text, BLOCK_A, "history: whole");
  assert.equal(arrived.blocks[1].text, BLOCK_B, "history: whole");
  assert.equal(arrived.blocks[2].text, newestBefore, "the block that was being written keeps the prefix it had");
  assert.equal(arrived.blocks[3].text, "", "the new block starts writing from its first word");
  assert.equal(newestBefore.startsWith(arrived.blocks[2].text), true);
  // And it keeps writing: the block that was the live edge is not abandoned when a newer one arrives.
  b.step(2000);
  const writing = b.render();
  assert.equal(writing.blocks[2].text.startsWith(newestBefore), true, "it grew from the prefix it had");
  // One queue, one clock: the newer thought is behind the one still being written, so it takes the clock when that
  // one is whole rather than writing over it. A later segment never starts before the earlier one has finished.
  assert.equal(writing.blocks[3].text, "", "the newer thought waits for the one in front of it");
  b.step(30_000);
  const done = b.render();
  assert.equal(done.blocks[2].text, b.blocks[2].text, "the block in front is whole");
  assert.ok(done.blocks[3].text.length > 0, "and then the newer one is written");
});

test("a card opened mid-turn paints the turn's older reasoning whole and writes only the newest", () => {
  // Same rule, no toggle involved: the block list is read in one pass, so "the newest" is decided by the store's own
  // order, not by which call happened to feed first.
  const b = bench();
  b.view.thinking = true;
  const first = b.render();
  assert.deepEqual(
    first.blocks.map((x) => x.text.length),
    [BLOCK_A.length, BLOCK_B.length, 0],
    "three blocks arrive together: two are history, the last is the live edge",
  );
});
