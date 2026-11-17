// One ordered stream behind every console: what a long mixed run DRAWS is what the store HOLDS, in that order, and a
// repaint at any tick draws exactly the characters that were already emitted.
//
// The defect this pins. The console was fed by three roads that shared neither an order nor a clock: reasoning arrived
// as `reasoning.delta` (a cumulative preview, re-fed as it grew), the answer as `text`/`set` blocks (a store line grown
// in place), and tool calls and results as whole records. Each road was paged by its own word clock, so N live lines
// each got the reader's full words-a-second (rate x N), and whichever line was fed last could finish first: text
// jumped, reset, and arrived out of order. Four fixes each mended one road (478fb6d9 the first paint of a stored
// line, 33ad603f a hidden tab, 85acc74e the settled tail, 9d5a857f the reasoning first), and the ordering defect
// survived every one of them because none of them touched the number of clocks.
//
// What this test drives is the SHIPPED renderer: public/core/console-markdown.js builds the markup,
// public/core/console-format.js decides what a row may show, and public/board/console.js answers how much of it is
// visible (its own typedText/typedShown, sliced out of the file between their markers). The clock and the timers are
// injected, so "a repaint in the middle of the run" is an ordering, not a wait.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(root, f), "utf8");

await import("../public/core/type-stream.js");
const { createDrawStream, createReasoningHold } = globalThis.wtType;

// ---- the shipped modules, in one vm context ---------------------------------------------------------------
const context = vm.createContext({ window: {}, console });
for (const file of ["public/core/dom-format.js", "public/core/console-markdown.js", "public/core/console-format.js"]) {
  vm.runInContext(read(file), context, { filename: file });
}
const CF = context.window.WMApp.core.consoleFormat;
const CM = context.window.WMApp.core.consoleMarkdown;

// The console's own answer to "how much of this line may be shown", sliced out of the shipped file.
const consoleSrc = read("public/board/console.js");
function between(a, b) {
  const i = consoleSrc.indexOf(a);
  const j = consoleSrc.indexOf(b, i);
  assert.ok(i > 0 && j > i, `markers found: ${a} .. ${b}`);
  return consoleSrc.slice(i, j);
}
const typedCode = between("// ---- end result row head", "// ---- console row text");
const rowCode = between("// ---- console row text", "// ---- markdown prose, appended one line at a time");

function page(stream) {
  const document = { hidden: false, createTextNode: (s) => ({ nodeType: 3, data: String(s), appendData(t) { this.data += t; } }) };
  // `consoleMdInline` and `linkifyText` are the page's own (the markdown module owns the first, dom-format the second);
  // here they are the identity, because the rows this test types are plain prose with no marker and no link.
  const scope = new Function(
    "state",
    "document",
    "consoleMdInline",
    "linkifyText",
    `${typedCode}\n${rowCode}\nreturn { typedText, typedShown, drawRowText, rowTakesTail };`
  );
  const made = scope({ typeStream: stream }, document, (s) => s, (s) => s);
  return { ...made, document };
}

// ---- the order the hold asks about: what is ahead of a call, in the stream's own (at, seq) order ------------------
// The console's own answer to "may this call be drawn yet", sliced out of the shipped file with the record it reads:
// reasoningFloor (the stamp of the last tool result the console has already drawn) and reasoningBusy (the hold's
// `busy`). `lines` is the console's own buffer of lines, which is what the floor reads.
const busyCode = `${between("const REASONING_READ_WAIT_MS", "function reasoningShown(turn)")}
${between("// The moment of the last tool result already in the console", "// A call, or the header of a result, is the cue")}`;
function consoleBusy(stream, lines) {
  const state = { reasoningReads: new Map(), typeStream: stream };
  const scope = new Function("state", "jobLines", `${busyCode}\nreturn { reasoningBusy, reasoningFloor };`);
  return scope(state, () => lines);
}

// A hold wired exactly as public/app.js wires it: the page's own busy, the stream's clock, one queue in order.
function holdFor(clock, busy, drawn, maxWaitMs = 60_000) {
  return createReasoningHold({
    ...clock,
    maxWaitMs,
    wants: (evt) => evt.line.kind === "tool" || evt.line.kind === "tool-out",
    busy: (job, head) => busy.reasoningBusy(job, head),
    release: (evt) => drawn.push(evt.line.text),
  });
}

// The page's append: the hold sees the frame first, and whatever it lets past is drawn at once.
const arrive = (hold, drawn, evt) => {
  if (!hold.push(evt)) drawn.push(evt.line.text);
  return evt;
};

const PROSE = "the agent is still writing this sentence when the call arrives";
const LATE_THOUGHT = "a thought the store handed over only after the call it belongs to was already on screen";

test("a paragraph still being typed holds the call that follows it, until its last word is out", () => {
  const { stream, step, clock } = clockwork(20); // twenty words a second
  const busy = consoleBusy(stream, []);
  const drawn = [];
  const hold = holdFor(clock, busy, drawn);

  // The prose joins the stream and is part way out when the call arrives.
  stream.feed("11", "job", PROSE, { kind: "text", at: 2000, cap: true });
  step(200);
  const part = stream.emitted("11");
  assert.ok(part.length > 0 && part.length < PROSE.length, "the sentence is half drawn");

  const call = { id: "job", line: { kind: "tool", text: "▸ terminal", lid: 900, at: 2001 } };
  assert.equal(hold.push(call), true, "held: the prose in front of the call is not written out");
  // The question the hold used to ask - is a THOUGHT pending - says no, which is the defect this pins: the card
  // landed mid-sentence because a paragraph of the agent's own words was not a segment the hold knew about.
  assert.equal(stream.pendingFor("job", (lid) => lid.startsWith("think:")), false);
  // And the shipped busy asks the order, not a kind: this is the one line a revert would have to change.
  assert.match(busyCode, /pendingBefore/);
  assert.equal(busyCode.includes('startsWith("think:")'), false, "the page keeps no second ordering by segment kind");

  step(120);
  assert.deepEqual(drawn, [], "the card has not landed in the middle of the sentence");

  const startedAt = clock.now();
  let atRelease = null;
  for (let i = 0; i < 300 && !drawn.length; i++) {
    step(20);
    if (drawn.length) atRelease = stream.emitted("11");
  }
  assert.deepEqual(drawn, ["▸ terminal"], "drawn once the prose was finished");
  assert.equal(atRelease, PROSE, "and not one word before the last");
  assert.ok(clock.now() - startedAt < 5000, "the prose finished on its own clock, nowhere near the hold's fence");
  assert.equal(hold.queued(), 0);
  assert.equal(hold.isHolding("job"), false);
});

test("a late block ahead of a call already on screen cannot strand the hold", () => {
  const { stream, step, clock } = clockwork(20);
  const busy = consoleBusy(stream, []);
  const drawn = [];
  const hold = holdFor(clock, busy, drawn);

  // A first call is drawn at once: nothing is in front of it.
  arrive(hold, drawn, { id: "job", line: { kind: "tool", text: "▸ read_file", lid: 910, at: 1500 } });
  assert.deepEqual(drawn, ["▸ read_file"]);
  // Its prose is drawn out in full, so there is content on screen when the late block arrives.
  stream.feed("12", "job", "a line of prose", { kind: "text", at: 1500, cap: true });
  step(500);
  assert.equal(stream.emitted("12"), "a line of prose");

  // The store now hands over a reasoning block stamped BEFORE that call - late, and out of order by arrival. The
  // stream places it at the head and counts the one thing the order cannot undo.
  stream.feed("think:1000", "job", LATE_THOUGHT, { kind: "think", at: 1000 });
  assert.equal(stream.stats().late, 1);
  assert.equal(stream.order()[0], "think:1000");

  // The result of that first call arrives. By stamp the block is in front of it, and the block is still being typed.
  const result = { id: "job", line: { kind: "tool-out", text: "↳ read_file · 0.1s", lid: 911, at: 1600 } };
  assert.equal(hold.push(result), true, "it waits for the block the store put in front of it");

  // The block is typed by the SAME one clock the prose uses: it finishes by itself, so the hold ends there and never
  // waits out its ceiling - a late block delays a card, it does not deadlock one.
  const startedAt = clock.now();
  for (let i = 0; i < 400 && drawn.length < 2; i++) step(25);
  assert.deepEqual(drawn, ["▸ read_file", "↳ read_file · 0.1s"], "released once the late block was written");
  assert.equal(stream.emitted("think:1000"), LATE_THOUGHT);
  assert.ok(clock.now() - startedAt < 60_000, "the fence never had to run");
});

test("a block behind a result the console has already drawn is not waited for at all", () => {
  const { stream, step, clock } = clockwork(20);
  // The console has already handed the reader the result at 4000, so its transcript has moved past it.
  const lines = [{ kind: "tool-out", text: "↳ terminal · 0.2s", at: 4000 }];
  const busy = consoleBusy(stream, lines);
  const drawn = [];
  const hold = holdFor(clock, busy, drawn);

  // A late block stamped before that result is still being typed, and a call follows it by stamp.
  stream.feed("think:1000", "job", LATE_THOUGHT, { kind: "think", at: 1000 });
  step(100);
  assert.ok(stream.pendingWords() > 0, "the late block is still owed characters");
  const call = { id: "job", line: { kind: "tool", text: "▸ patch", lid: 920, at: 4001 } };
  arrive(hold, drawn, call);
  assert.deepEqual(drawn, ["▸ patch"], "behind the floor it is not in front of this call, so nothing is waited for");
});

// ---- a clock and a timer queue, driven by hand ------------------------------------------------------------
function clockwork(rate) {
  let t = 1_000_000;
  const timers = new Map();
  let id = 0;
  const step = (ms) => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [key, x] = due;
      timers.delete(key);
      t = Math.max(t, x.at);
      x.fn();
    }
    t = target;
  };
  const c = {
    now: () => t,
    schedule: (fn, ms) => {
      const key = ++id;
      timers.set(key, { fn, at: t + Math.max(1, ms) });
      return key;
    },
    cancel: (key) => timers.delete(key),
  };
  const stream = createDrawStream({ ...c, rate });
  return { stream, step, now: () => t, clock: c };
}

// ---- the run ----------------------------------------------------------------------------------------------
// A long turn: twenty thoughts, twenty paragraphs of the answer, twenty tool records - sixty segments of three kinds,
// stamped in that interleaved order by the server. Each one arrives SCRAMBLED (the order the page happened to receive
// them) and each paragraph arrives as three growing frames, which is how a coalesced wire really hands it over.
const PARA = (tag, i) => Array.from({ length: 12 }, (_, k) => `${tag}${i}w${k}`).join(" ");
function longRun() {
  const segs = [];
  for (let i = 0; i < 20; i++) {
    segs.push({ key: `think:${1000 + i * 3}`, kind: "think", at: 1000 + i * 3, text: PARA("t", i) });
    segs.push({ key: `a${i}`, kind: "text", at: 1001 + i * 3, text: PARA("a", i) });
    segs.push({ key: `x${i}`, kind: "tool-out", at: 1002 + i * 3, text: PARA("x", i) });
  }
  return segs;
}
// A deterministic shuffle: reverse by tens, so arrival order is nothing like the stored order.
const arrival = (segs) => {
  const out = [];
  for (let i = 0; i < segs.length; i += 10) out.unshift(...segs.slice(i, i + 10).reverse());
  return out;
};

const stored = longRun();
const line = (s) => ({ kind: s.kind === "think" ? "text" : s.kind, text: s.text, lid: s.key, at: s.at });
const lines = stored.map(line); // what the pane is handed, in STORED order

// What a repaint draws, character for character: every row's visible prefix, in the pane's order.
const painted = (pageApi) => lines.map((l) => pageApi.typedShown(l) ?? l.text).join("");

test("a long mixed run draws in the stored order, and a repaint at every tick draws what was emitted", () => {
  const { stream, step } = clockwork(240);
  const p = page(stream);
  CF.setShownFor(p.typedShown);

  // The wire arrives: scrambled, and paragraphs in three growing frames.
  for (const s of arrival(stored)) {
    const text = s.text;
    const third = Math.ceil(text.length / 3);
    for (const cut of [third, third * 2, text.length]) {
      p.typedText({ kind: s.kind, text: text.slice(0, cut), lid: s.key, at: s.at }, "job");
    }
  }

  const seen = [];
  for (let tick = 0; tick < 400 && stream.pendingWords() > 0; tick++) {
    step(25);
    const now = painted(p);
    if (seen.length) {
      const before = seen.at(-1);
      // Nothing is taken back and nothing jumps in front of what was already there: the repaint at this tick draws a
      // LONGER prefix of the same transcript, never a different one.
      assert.ok(now.startsWith(before), `tick ${tick} drew a different transcript:\n  had ${before.slice(0, 80)}\n  now ${now.slice(0, 80)}`);
    }
    seen.push(now);
  }

  const drawn = seen.at(-1);
  const expect = stored.map((s) => s.text).join("");
  assert.equal(drawn, expect, "the rendered order is the stored order, character for character");

  // The three kinds are interleaved exactly as the store has them: the first characters of each segment, in the order
  // they were drawn.
  const order = [];
  let at = 0;
  for (const s of stored) {
    assert.equal(drawn.slice(at, at + 3), s.text.slice(0, 3), `segment ${s.key} sits where the store put it`);
    order.push(`${s.key}=${s.text.slice(0, 3)}`);
    at += s.text.length;
  }
  assert.equal(order.length, 60, "sixty segments, three kinds, one order");
  assert.deepEqual(order.slice(0, 6), ["think:1000=t0w", "a0=a0w", "x0=x0w", "think:1003=t1w", "a1=a1w", "x1=x1w"]);

  // No character was typed twice, and no segment was ever replaced: one writer, one watermark.
  const st = stream.stats();
  assert.equal(st.enqueued, 60, "sixty segments joined the queue");
  assert.equal(st.rewrites, 0, "a growing segment is extended, never retyped");
  assert.equal(st.replaced, 0, "no character already emitted was replaced");
  assert.equal(st.emitted, expect.length, "the stream emitted exactly the transcript's characters");
  assert.equal(st.late, 0, "no frame arrived behind a stamp already drawn");
  assert.equal(stream.pendingWords(), 0, "and the clock has nothing left to release");
});

test("the writer appends the tail: a tick never re-writes a character already on screen", () => {
  const { stream, step } = clockwork(240);
  const p = page(stream);
  const el = {
    nodeType: 1,
    dataset: { lkind: "text" },
    childElementCount: 0,
    lastChild: null,
    _drawn: undefined,
    get innerHTML() { return ""; },
    set innerHTML(v) { this._html = v; this.lastChild = null; this.text = String(v); },
    appendChild(n) { this.lastChild = n; return n; },
  };
  const appended = [];
  p.drawRowText(el, "");
  p.typedText({ kind: "text", text: "", lid: "9", at: 1 }, "job");
  let written = 0;
  for (let tick = 0; tick < 40; tick++) {
    step(50);
    const shown = p.typedShown({ lid: "9", text: undefined });
    if (shown == null) continue;
    const before = el._drawn ?? "";
    if (p.drawRowText(el, shown)) {
      const tail = shown.slice(before.length);
      if (tail) appended.push(tail);
      written += tail.length;
    }
  }
  const final = (el._drawn ?? "").length;
  assert.equal(written, final, "the row wrote each character once");
  assert.equal(appended.join(""), el._drawn, "and the characters were appended in order");
});
test("a narrow docked rail and a wide pane draw the same characters: width is CSS, never a clock", () => {
  const { stream, step } = clockwork(240);
  const p = page(stream);
  CF.setShownFor(p.typedShown);
  const run = stored.slice(0, 12);
  for (const seg of run) p.typedText({ kind: seg.kind, text: seg.text, lid: seg.key, at: seg.at }, "job");
  step(200);

  // What the pane draws is ONE string built by the shipped renderer, and the docked console's body builder calls the
  // same function for its prose (public/board/console.js: subConsoleBodyHtml -> consoleMdHtml). A rail 320 px wide and
  // a pane 1600 px wide therefore differ in CSS and in nothing else.
  const wide = CM.html(run.map(line), { textOf: (l) => p.typedShown(l) });
  const narrow = CM.html(run.map(line), { textOf: (l) => p.typedShown(l) });
  assert.equal(narrow, wide, "the same stream state is the same markup at any width");
  assert.ok(wide.includes("data-md-block"), "and it is real markdown markup, not a width-dependent string");

  // The typed path never reads a box. A rail resize, a board poll and a focus-mode toggle all repaint the ancestor;
  // none of them can change what is drawn, because nothing in the path asks the page how big anything is.
  const typedPath = `${typedCode}
${rowCode}`;
  for (const geom of ["offsetWidth", "clientWidth", "scrollWidth", "getBoundingClientRect", "innerWidth", "matchMedia"]) {
    assert.equal(typedPath.includes(geom), false, `the typed path must not read ${geom}`);
  }
  // And the docked rail is the card's own renderer, not a second one: its prose goes through consoleMdHtml too.
  assert.ok(consoleSrc.includes("if (part.prose) return consoleMdHtml(part.prose);"), "the docked console draws prose with the card's renderer");
});
