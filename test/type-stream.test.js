// How fast a run's output reaches the reader's eyes: the word pacer and the line gate.
//
// public/core/type-stream.js is a classic script in the page and a plain module to node (it publishes itself on
// globalThis), so this drives the ONE implementation the page runs rather than a copy of it. Both mechanisms run
// on their own clock, so the clock and the timers are injected here: time is the thing under test.
import assert from "node:assert/strict";
import test from "node:test";

await import("../public/core/type-stream.js");
const { createPacer, createLineGate, wordsIn, advance, MAX_WORDS, MAX_LINES } = globalThis.wtType;

// A clock, a timer queue and a paint log, all driven by hand. `step(ms)` runs every timer that comes due inside
// that window in order, exactly as the browser's event loop would.
function bench({ words = 0, lines = 0 } = {}) {
  let t = 1_000_000;
  const timers = new Map();
  let seq = 0;
  let paints = 0;
  const clock = {
    now: () => t,
    schedule: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: t + Math.max(1, ms) });
      return id;
    },
    cancel: (id) => timers.delete(id),
  };
  const pacer = createPacer({ ...clock, rate: words, onPaint: () => paints++ });
  const released = [];
  const gate = createLineGate({ ...clock, rate: lines, release: (evt) => released.push(evt.line.text) });
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
  return { pacer, gate, released, step, paints: () => paints, timers: () => timers.size, at: () => t };
}

const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const SENTENCE = words.join(" ");

test("a line is revealed a word at a time, and every prefix ends on a word", () => {
  const b = bench({ words: 10 }); // ten words a second: one every 100 ms
  assert.equal(b.pacer.feed("1", "job", SENTENCE), "", "nothing is drawn before the first word is due");

  const seen = [];
  for (let i = 0; i < 120; i++) {
    b.step(20);
    const s = b.pacer.shownFor("1");
    if (seen.at(-1) !== s) seen.push(s);
  }

  assert.equal(seen.at(-1), SENTENCE, "the last word does reach the screen");
  for (const s of seen) assert.ok(SENTENCE.startsWith(s), `"${s}" must be a prefix of the line the wire sent`);
  // Every prefix boundary is a whole number of words, in order, and never more than one word per 20 ms step.
  const counts = seen.map((s) => (s ? s.split(" ").length : 0));
  assert.deepEqual(counts, [...Array(words.length + 1).keys()], "one word per step, none skipped, none repeated");
});

test("the words keep coming with no further frame: nothing is left sitting in the buffer", () => {
  const b = bench({ words: 20 });
  b.pacer.feed("7", "job", SENTENCE);
  b.pacer.feed("7", "job", SENTENCE);
  // Never fed again — the run's last frame was the one above.
  b.step(3000);
  assert.equal(b.pacer.shownFor("7"), SENTENCE, "a settled line finishes typing on the pacer's own clock");
  assert.equal(b.pacer.pending(), false);
  assert.equal(b.timers(), 0, "and the clock stops when there is nothing left to release");
});

test("growth extends the queue; the words already shown are not typed again", () => {
  const b = bench({ words: 10 });
  b.pacer.feed("1", "job", "alpha beta");
  b.step(250); // two words out at 10/s
  const before = b.pacer.shownFor("1");
  assert.equal(before, "alpha beta");

  b.pacer.feed("1", "job", "alpha beta gamma delta");
  assert.equal(b.pacer.shownFor("1"), "alpha beta", "the sentence so far stays exactly as it was on screen");
  b.step(250);
  assert.equal(b.pacer.shownFor("1"), "alpha beta gamma delta", "and the new words follow it");
});

test("a frame that rewrites the line snaps to it instead of typing out the old text", () => {
  const b = bench({ words: 1 });
  b.pacer.feed("1", "job", "this paragraph is long enough to be mid-reveal for a while");
  b.step(200);
  assert.notEqual(b.pacer.shownFor("1"), "replaced");
  // Not an extension of what arrived before: the wire rewrote the line (a trimmed window, a replayed frame).
  assert.equal(b.pacer.feed("1", "job", "replaced"), "replaced");
  assert.equal(b.pacer.shownFor("1"), "replaced", "a replacement is drawn whole, at once");
});

test("rate 0 is off: every frame is drawn whole and nothing is held", () => {
  const b = bench({ words: 0 });
  assert.equal(b.pacer.feed("1", "job", SENTENCE), SENTENCE);
  assert.equal(b.pacer.shownFor("1"), null, "an unpaced line is drawn by its own text, not by a prefix");
  assert.equal(b.pacer.pending(), false);
  assert.equal(b.timers(), 0);
});

test("flush releases the rest of a line at once and stops its clock", () => {
  const b = bench({ words: 2 });
  b.pacer.feed("1", "job", SENTENCE);
  b.step(150);
  const partial = b.pacer.shownFor("1");
  assert.ok(partial.length < SENTENCE.length, "still typing");
  assert.equal(b.pacer.flush("1"), SENTENCE);
  assert.equal(b.pacer.shownFor("1"), SENTENCE);
  assert.equal(b.pacer.pending(), false);
});

test("a settled job is released together, and another job keeps typing", () => {
  const b = bench({ words: 2 });
  b.pacer.feed("a", "job-a", "aaaa bbbb cccc dddd");
  b.pacer.feed("b", "job-b", "eeee ffff gggg hhhh");
  b.step(120);
  const painted = b.pacer.flushJob("job-a");
  assert.deepEqual(painted, ["a"]);
  assert.equal(b.pacer.shownFor("a"), "aaaa bbbb cccc dddd");
  assert.ok(b.pacer.shownFor("b").length < "eeee ffff gggg hhhh".length, "the other card is untouched");
  assert.equal(b.pacer.pending(), true);
  b.step(3000);
  assert.equal(b.pacer.shownFor("b"), "eeee ffff gggg hhhh", "and it still finishes on its own");
});

test("an idle line banks no credit: a late frame cannot arrive as a dump", () => {
  const b = bench({ words: 10 });
  b.pacer.feed("1", "job", "alpha");
  b.step(2000); // revealed, then the line sits quiet for a long time
  assert.equal(b.pacer.shownFor("1"), "alpha");
  b.step(60_000);
  b.pacer.feed("1", "job", "alpha beta gamma delta");
  const first = b.pacer.shownFor("1");
  assert.equal(first, "alpha", "the new words still start one at a time, not all at once");
  b.step(100);
  assert.equal(b.pacer.shownFor("1"), "alpha beta");
});

test("two lines pace independently, each at the setting's rate", () => {
  const b = bench({ words: 10 });
  b.pacer.feed("1", "job", "one two three");
  b.pacer.feed("2", "job", "four five six");
  b.step(100);
  assert.equal(b.pacer.shownFor("1"), "one");
  assert.equal(b.pacer.shownFor("2"), "four");
  b.step(200);
  assert.equal(b.pacer.shownFor("1"), "one two three");
  assert.equal(b.pacer.shownFor("2"), "four five six");
});

test("the setting is clamped to what the row offers", () => {
  const b = bench({ words: 10 });
  assert.equal(b.pacer.setRate(10_000), MAX_WORDS);
  assert.equal(b.pacer.setRate(-5), 0, "a negative rate is off, never a negative clock");
  assert.equal(b.pacer.setRate("nonsense"), 0);
  assert.equal(b.pacer.setRate(1.6), 2, "rounded: a word rate is a whole number of words");
  assert.equal(b.gate.setRate(10_000), MAX_LINES);
});

test("turning the word rate off releases what was held instead of freezing it", () => {
  const b = bench({ words: 2 });
  b.pacer.feed("1", "job", SENTENCE);
  b.step(120);
  assert.ok(b.pacer.shownFor("1").length < SENTENCE.length);
  // The reader moves the setting to 0: the held words must appear, not wait for a clock that is now off.
  const shown = b.pacer.releaseAll();
  assert.deepEqual(shown, ["1"]);
  b.pacer.setRate(0);
  assert.equal(b.pacer.shownFor("1"), null);
  assert.equal(b.pacer.size(), 0);
});

// ---- the words themselves ---------------------------------------------------------------------

test("wordsIn and advance agree about where a word ends", () => {
  assert.equal(wordsIn("one two three"), 3);
  assert.equal(wordsIn("  one  two  "), 2);
  assert.equal(wordsIn(""), 0);
  assert.equal(wordsIn("one two three", 4), 2, "counting from inside a line counts only what is left");
  assert.equal(advance("one two three", 0, 1), 3);
  assert.equal(advance("one two three", 0, 2), 7);
  assert.equal(advance("one two three", 0, 99), 13, "asking for more than there is lands at the end");
  assert.equal(advance("one\ntwo\t three", 0, 3), 14, "any run of whitespace separates words");
  assert.equal(advance("hello", 0, 0), 0);
});

// ---- the line gate ----------------------------------------------------------------------------

const frame = (id, text, extra = {}) => ({ id, line: { kind: "tool", lid: extra.lid, text, ...extra } });

test("whole lines walk into the console one at a time at the line rate", () => {
  const b = bench({ lines: 5 }); // five lines a second: one every 200 ms
  const evts = [1, 2, 3, 4, 5].map((n) => frame("job", `line ${n}`, { lid: n }));
  for (const e of evts) assert.equal(b.gate.push(e), true, "held, not drawn");
  assert.deepEqual(b.released, []);
  b.step(200);
  assert.deepEqual(b.released, ["line 1"]);
  b.step(200);
  assert.deepEqual(b.released, ["line 1", "line 2"]);
  b.step(1000);
  assert.deepEqual(b.released, ["line 1", "line 2", "line 3", "line 4", "line 5"], "in the order they arrived");
  assert.equal(b.gate.queued(), 0);
  assert.equal(b.timers(), 0);
});

test("a growth frame for a held line updates it, and does not jump the queue", () => {
  const b = bench({ lines: 1 });
  b.gate.push(frame("job", "first", { lid: 1, kind: "text", mode: "new" }));
  b.gate.push(frame("job", "second", { lid: 2, kind: "text", mode: "new" }));
  assert.equal(b.gate.queued(), 2);
  const grown = frame("job", "second and more", { lid: 2, kind: "text", mode: "set" });
  assert.equal(b.gate.push(grown), true, "the paragraph is still waiting, so its new text waits with it");
  assert.equal(b.gate.queued(), 2, "and it did not become a second line");
  b.step(2100);
  assert.deepEqual(b.released, ["first", "second and more"], "the held line went out with the text it had grown to");
});

test("a line already on screen growing is never held", () => {
  const b = bench({ lines: 1 });
  assert.equal(b.gate.push(frame("job", "drawn already", { lid: 9, mode: "set" })), false);
  assert.equal(b.gate.queued(), 0, "an existing line's next frame is the same line, not a new one");
});

test("drain releases one job's held lines, in order, and leaves the other card alone", () => {
  const b = bench({ lines: 1 });
  b.gate.push(frame("a", "a1", { lid: 1 }));
  b.gate.push(frame("b", "b1", { lid: 2 }));
  b.gate.push(frame("a", "a2", { lid: 3 }));
  assert.deepEqual(b.released, []);
  assert.equal(b.gate.drain("a"), 2);
  assert.deepEqual(b.released, ["a1", "a2"], "a settled turn's lines join its console at once, in order");
  assert.equal(b.gate.queued(), 1, "the other card keeps its own queue");
  b.step(2000);
  assert.deepEqual(b.released, ["a1", "a2", "b1"]);
});

test("line rate 0 is off, and turning it off drains what was held", () => {
  const b = bench({ lines: 0 });
  assert.equal(b.gate.push(frame("job", "straight through", { lid: 1 })), false);
  assert.equal(b.gate.queued(), 0);

  b.gate.setRate(1);
  b.gate.push(frame("job", "held", { lid: 2 }));
  b.gate.push(frame("job", "held too", { lid: 3 }));
  assert.deepEqual(b.released, []);
  b.gate.setRate(0);
  assert.deepEqual(b.released, ["held", "held too"], "off means nothing waits: the backlog goes out at once");
  assert.equal(b.timers(), 0);
});

test("a flood of lines cannot turn into a stall", () => {
  const b = bench({ lines: 1 });
  for (let i = 0; i < 620; i++) b.gate.push(frame("job", `line ${i}`, { lid: i + 1 }));
  // Past the cap the oldest lines leave immediately, so the console keeps moving while the queue is bounded.
  assert.ok(b.gate.queued() <= 600, `queue is bounded, saw ${b.gate.queued()}`);
  assert.ok(b.released.length >= 20, `the overflow went out, saw ${b.released.length}`);
  assert.equal(b.released[0], "line 0", "and it went out oldest first");
});
