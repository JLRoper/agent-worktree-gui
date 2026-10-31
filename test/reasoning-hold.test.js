// Reasoning first: a tool's lines are not written into a console before the thought in front of them has been.
//
// public/core/type-stream.js is a classic script in the page and a plain module to node, so this drives the ONE
// implementation the page runs. The hold is page-agnostic — the page says which frames wait (`wants`), what they wait
// for (`busy`) and what to do when a hold begins (`start`) — so the page's own answers are stood in for here with the
// real pacer and a hand-driven clock. Time is the thing under test.
//
//   1. a call that arrives while its thought is still being typed waits for the last word, then goes out;
//   2. everything behind it waits too, in order, and only an already-drawn line growing is let past;
//   3. only the thoughts that belong in front of the call hold it — a backlog of older ones does not;
//   4. `start` runs before `busy` is asked, so a read begun for the call is a reason to wait for it, and the hold
//      then waits for what that read handed the pacer;
//   5. nothing is ever stranded: drain, the ceiling and the end of the word rate all let the queue go, in order;
//   6. the page wires it where lines join a console, and lets it go before the line that says the turn ended.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../public/core/type-stream.js");
const { createPacer, createReasoningHold, MAX_HOLD_MS } = globalThis.wtType;

function bench({ words = 10, hold: holdOpts = {} } = {}) {
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
  const step = (ms) => {
    const target = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, x] = due;
      timers.delete(id);
      t = Math.max(t, x.at);
      x.fn();
    }
    t = target;
  };
  const drawn = [];
  const calls = [];
  const pacer = createPacer({ ...clock, rate: words });
  const { floor = 0, ...rest } = typeof holdOpts === "function" ? holdOpts({ pacer, calls }) : holdOpts;
  const hold = createReasoningHold({
    ...clock,
    wants: (evt) => evt.line.kind === "tool" || evt.line.kind === "tool-out",
    busy: (job) => pacer.pendingFor(job, (lid) => lid.startsWith("think:") && Number(lid.slice(6)) > floor),
    start: (job, evt) => calls.push(`start:${evt.line.text}`),
    release: (evt) => drawn.push(evt.line.text),
    ...rest,
  });
  // The page's append: the hold first; whatever it lets past is drawn at once.
  const arrive = (job, kind, text, extra = {}) => {
    const evt = { id: job, line: { kind, text, lid: `${kind}:${text}`, ...extra } };
    if (!hold.push(evt)) drawn.push(evt.line.text);
    return evt;
  };
  return { pacer, hold, drawn, calls, step, arrive, at: () => t, timers: () => timers.size };
}

const THOUGHT = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" "); // 20 words: two seconds at 10 words/s

test("a call that arrives while its thought is being typed waits for the last word", () => {
  const b = bench({ words: 10 });
  b.pacer.feed("think:2000", "job", THOUGHT);
  b.step(500);
  assert.ok(b.pacer.pendingFor("job"), "the thought is part-way");
  b.arrive("job", "tool", "▸ read_file");
  b.arrive("job", "tool-out", "↳ read_file · 0.1s");
  b.step(500);
  assert.deepEqual(b.drawn, [], "a second in, the thought has 10 of its 20 words and the call has not been drawn");
  assert.equal(b.hold.queued("job"), 2);
  b.step(1700);
  assert.equal(b.pacer.pendingFor("job"), false, "the thought is written");
  assert.deepEqual(b.drawn, ["▸ read_file", "↳ read_file · 0.1s"], "both leave together, in order, once it is");
  assert.equal(b.hold.queued(), 0);
  assert.equal(b.timers(), 0, "and no clock is left running for a hold that has ended");
});

test("a call with no thought in front of it is not delayed at all", () => {
  const b = bench({ words: 10 });
  b.arrive("job", "tool", "▸ terminal");
  assert.deepEqual(b.drawn, ["▸ terminal"], "drawn the moment it arrives");
  assert.equal(b.hold.isHolding("job"), false);
  assert.deepEqual(b.calls, ["start:▸ terminal"], "the page was still told a call arrived, so it can look for the thought");
});

test("everything behind a held call waits in order; only a line already on screen may grow past it", () => {
  const b = bench({ words: 10 });
  b.pacer.feed("think:2000", "job", THOUGHT);
  b.step(100);
  b.arrive("job", "tool", "call A");
  b.arrive("job", "text", "prose after the call", { mode: "new" });
  b.arrive("job", "tool-out", "result A");
  // A paragraph that was already drawn before the hold began keeps growing in place: not a new line, never held.
  const grow = b.arrive("job", "text", "an earlier paragraph, longer", { mode: "set", lid: "text:earlier" });
  assert.equal(b.hold.held("job").includes(grow), false);
  assert.deepEqual(b.drawn, ["an earlier paragraph, longer"], "only the growth went through");
  b.step(2500);
  assert.deepEqual(b.drawn.slice(1), ["call A", "prose after the call", "result A"], "the rest left in the order it arrived");
});

test("a growth frame for a held line updates the held copy instead of queueing a second one", () => {
  const b = bench({ words: 10 });
  b.pacer.feed("think:2000", "job", THOUGHT);
  b.arrive("job", "tool", "call A");
  b.arrive("job", "text", "half a sentence", { mode: "new", lid: "p1" });
  b.arrive("job", "text", "half a sentence, finished", { mode: "set", lid: "p1" });
  assert.equal(b.hold.queued("job"), 2, "one frame for the call, one for the paragraph");
  b.step(2500);
  assert.deepEqual(b.drawn, ["call A", "half a sentence, finished"], "the paragraph left as the wire last wrote it");
});

test("only thoughts newer than the floor hold a call: an old backlog typing in parallel does not", () => {
  const b = bench({ words: 10, hold: { floor: 5000 } });
  // A card opened mid-turn: every earlier thought is fed at once and types in parallel. None of it precedes this call.
  for (const at of [1000, 2000, 3000]) b.pacer.feed(`think:${at}`, "job", THOUGHT);
  b.arrive("job", "tool", "call A");
  assert.deepEqual(b.drawn, ["call A"], "the backlog is not a reason to wait");
  // The thought written since the last result is.
  b.pacer.feed("think:6000", "job", THOUGHT);
  b.arrive("job", "tool", "call B");
  assert.deepEqual(b.drawn, ["call A"], "the thought in front of call B holds it");
  b.step(2500);
  assert.deepEqual(b.drawn, ["call A", "call B"]);
});

test("another job's thought does not hold this job's call", () => {
  const b = bench({ words: 10 });
  b.pacer.feed("think:2000", "other", THOUGHT);
  b.arrive("job", "tool", "call A");
  assert.deepEqual(b.drawn, ["call A"]);
  b.arrive("other", "tool", "call B");
  assert.deepEqual(b.drawn, ["call A"], "its own thought holds the other job's");
  assert.equal(b.hold.isHolding("other"), true);
  assert.equal(b.hold.isHolding("job"), false);
});

test("start runs before busy: a read begun for the call holds it, then the hold waits out what the read found", () => {
  // The page's two reasons to wait, in the order they happen: a read of the store is out, then the thought it found
  // is being typed.
  const read = { out: false, begun: 0 };
  const b = bench({
    words: 10,
    hold: ({ pacer }) => ({
      start: () => {
        read.out = true;
        read.begun += 1;
      },
      busy: (job) => read.out || pacer.pendingFor(job, (lid) => lid.startsWith("think:")),
    }),
  });
  b.arrive("job", "tool", "call A");
  assert.equal(read.begun, 1, "start ran for the frame, before busy was asked");
  assert.deepEqual(b.drawn, [], "nothing is being typed yet, but a read is out: the call waits for it");
  b.step(300);
  assert.deepEqual(b.drawn, [], "and keeps waiting while the read is out");
  // The read lands: the store held the thought, the page painted it (the pacer was handed it) and the flag cleared.
  b.pacer.feed("think:2000", "job", THOUGHT);
  read.out = false;
  b.step(100);
  assert.deepEqual(b.drawn, [], "the thought is being typed: still waiting");
  b.step(2200);
  assert.deepEqual(b.drawn, ["call A"], "written, then the call");
});

test("a read that finds nothing lets the call through on the next beat", () => {
  let reading = true;
  const b = bench({
    words: 10,
    hold: { busy: () => reading },
  });
  b.arrive("job", "tool", "call A");
  assert.equal(b.hold.isHolding("job"), true);
  reading = false;
  b.step(80);
  assert.deepEqual(b.drawn, ["call A"], "no thought arrived: the call is no more than one beat late");
});

test("drain lets a job's queue go in order and leaves the other job holding", () => {
  const b = bench({ words: 10 });
  b.pacer.feed("think:2000", "a", THOUGHT);
  b.pacer.feed("think:2001", "b", THOUGHT);
  b.arrive("a", "tool", "a1");
  b.arrive("a", "tool-out", "a2");
  b.arrive("b", "tool", "b1");
  assert.equal(b.hold.drain("a"), 2);
  assert.deepEqual(b.drawn, ["a1", "a2"]);
  assert.equal(b.hold.isHolding("b"), true, "the other card keeps waiting for its own thought");
  assert.equal(b.hold.drain(), 1);
  assert.deepEqual(b.drawn, ["a1", "a2", "b1"]);
  b.pacer.releaseAll(); // the pacer's own clock is not the hold's: take it out of the count
  assert.equal(b.timers(), 0, "a drained hold leaves no clock behind");
});

test("a hold has a ceiling: a thought that never finishes cannot strand a console", () => {
  const b = bench({ words: 10, hold: { busy: () => true, maxWaitMs: 5000 } });
  b.arrive("job", "tool", "call A");
  b.step(4900);
  assert.deepEqual(b.drawn, []);
  b.step(200);
  assert.deepEqual(b.drawn, ["call A"], "released at the ceiling");
  assert.ok(MAX_HOLD_MS >= 60_000, "and the default ceiling is far past any thought a reader would sit through");
});

test("a frame the page does not want held is never held, thought or no thought", () => {
  const b = bench({ words: 10, hold: { wants: () => false } });
  b.pacer.feed("think:2000", "job", THOUGHT);
  b.arrive("job", "tool", "call A");
  assert.deepEqual(b.drawn, ["call A"], "wants() is the page's switch: the words/s setting, a hidden tab, a folded block");
  assert.deepEqual(b.calls, [], "and start is not asked either");
});

// ---- the page's wiring ---------------------------------------------------------------------------------------
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("the page holds frames before the line gate, and lets the queue go before the turn's last line", () => {
  const append = app.slice(app.indexOf("function appendJobLine(evt)"), app.indexOf("function recordJobLine(evt)"));
  assert.ok(append.length > 200, "found appendJobLine");
  const hold = append.indexOf("state.typeHold?.push(evt)");
  const gate = append.indexOf("state.typeGate?.push(evt)");
  assert.ok(hold > 0 && gate > hold, "the reasoning hold sees a frame first; what it lets past still meets the line gate");
  assert.match(append, /!document\.hidden[^\n]*typeHold\?\.push/, "a tab nobody is looking at holds nothing");
  assert.match(append, /!isBookkeeping\(line\)[^\n]*typeHold\?\.push/, "bookkeeping (the line that ends the turn) never waits");
  const drain = append.indexOf('state.typeHold?.drain(evt.id)');
  const record = append.indexOf("recordJobLine(evt);", gate);
  assert.ok(drain > gate && drain < record, "the held lines go into the console BEFORE the result line is recorded");

  const flush = app.slice(app.indexOf("function flushTypeStream(job)"), app.indexOf("// A background tab has no flow"));
  assert.match(flush, /typeHold\?\.drain/, "a settled turn releases whatever the hold kept");
  const vis = app.slice(app.indexOf('document.addEventListener("visibilitychange"'), app.indexOf("function paintStreamSpeed"));
  assert.match(vis, /typeHold\?\.drain\(\)/, "a hidden tab releases it too");
});

test("the page holds only what a reader is watching: words/s on, turn live, reasoning on screen", () => {
  const wants = app.slice(app.indexOf("function reasoningWants(evt)"), app.indexOf("// The moment of the last tool result"));
  assert.match(wants, /typePacer\.rate\(\)/, "words/s 0 keeps the console exactly as the run sent it");
  assert.match(wants, /turnLive\(turn\)/);
  assert.match(wants, /reasoningShown\(turn\)/);
  const shown = app.slice(app.indexOf("function reasoningShown(turn)"), app.indexOf("function reasoningWants(evt)"));
  assert.match(shown, /thinkingOn\(thread\)/, "reasoning switched off is not drawn, so it is not waited for");
  assert.match(shown, /thinkOpenFor\(turn/, "a folded 🧠 block is typing into nothing: it holds nothing either");
});
