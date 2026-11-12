// The composer's Up/Down walk: one session's entries, newest first, merged with the browser's own list by time.
//
// THE FOUR DEFECTS THIS FILE PINS, in the order they were seen in
// (public/app.js `turnPrompts` / `recallReply`):
//   1. the browser's sent list was APPENDED after every turn prompt instead of being merged by time, so a steer the
//      reader typed BETWEEN two turns came back on the first Up as if it were the newest thing the session had;
//   2. that append also lost the de-duplication the wrong way: a typed entry repeating an older prompt was dropped
//      in favour of the older one, so Up read a STALE prompt instead of the words the reader had just typed;
//   3. `(a.turn || 0)` sorted a turn with no number in FRONT of the session's history, so a record the store had
//      written without one landed out of order and could not be reached as the newest;
//   4. `(j.thread || j.id) === thread` named a record with no thread by its own id, so that record could be walked in
//      a box that happened to carry the same string: another session's text in this session's history.
//
// Each test drives the page's OWN functions (extracted from public/app.js, never re-implemented) over a small model
// of the box and the store, and writes the browser's history through the page's own `rememberReply`, so the fixture
// is in whatever format the build under test writes. The tests that fail on the build before this change are the
// merge (#1), the repeat (#2) and its rememberReply unit, the missing turn (#3) and the id fallback (#4); the
// interleaved and no-history tests pin the isolation that build already met, so the new key and merge cannot take it
// away.
//
// RED-FIRST, against another checkout without touching this tree:
//   WTGUI_APP_SRC=<that checkout's public/app.js> node --test test/reply-history-order.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const APP_SRC = process.env.WTGUI_APP_SRC || new URL("../public/app.js", import.meta.url);
const app = readFileSync(APP_SRC, "utf8").replace(/\r\n/g, "\n");
const STORE_KEY = "wtgui.replyHistory";

// One top-level `const X = ...;` from the page, so the test reads the same regex and the same storage key it does.
function constLine(name) {
  const m = new RegExp(`^const ${name} = .*;$`, "m").exec(app);
  assert.ok(m, `the page carries ${name}`);
  return m[0];
}

// One top-level function from a classic script, by name. `async` is part of some of them, so the prefix is optional.
function grab(src, name) {
  const m = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(src);
  assert.ok(m, `the page carries ${name}()`);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is a top-level function`);
  return src.slice(start, end + 3);
}

// Only on the build that has it: an older app.js must still LOAD here, so the failure is an assertion about the walk
// rather than "the page does not carry this helper".
function maybeGrab(src, name) {
  try {
    return grab(src, name);
  } catch {
    return "";
  }
}

const source = [
  constLine("PANEL_PROMPT"),
  constLine("REPLY_HISTORY_KEY"),
  constLine("REPLY_HISTORY_MAX"),
  grab(app, "replyHistoryStore"),
  maybeGrab(app, "replyHistoryEntries"),
  grab(app, "rememberReply"),
  maybeGrab(app, "promptClock"),
  grab(app, "turnPrompts"),
  grab(app, "recallReply"),
].join("\n");

assert.ok(constLine("REPLY_HISTORY_KEY").includes(STORE_KEY), `the page's history key is ${STORE_KEY}`);

// A fixed clock: the ISO stamps a turn carries and the epoch the browser writes must line up, and a real `new Date()`
// would put the reader's "typed here" entries after every fixture turn by accident.
const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
const at = (ms) => T0 + ms;
const iso = (ms) => new Date(at(ms)).toISOString();
const job = (o) => ({ origin: null, ...o });
// A vm array carries the vm's Array prototype, which deepStrictEqual refuses to match against a host array.
const rows = (list) => Array.from(list || []);

// ---- the page's world, small enough to see -------------------------------------------------------------------------
// `history` is `{ thread: [[text, whenMs], ...] }`, written through the page's own rememberReply so each build holds
// its own format: this test never decides how the browser stores what it sent.
function harness({ jobs = [], history = {} } = {}) {
  const stored = new Map();
  const localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  };
  const ctx = {
    localStorage,
    JSON,
    Map,
    Set,
    String,
    Number,
    Boolean,
    Array,
    Date,
    Math,
    RegExp,
    state: { jobs: new Map(jobs.map((j) => [j.id, j])), replyNav: new Map(), replyDrafts: {} },
    readBox: (box) => String(box.value),
    writeBox: (box, text) => {
      box.value = String(text == null ? "" : text);
    },
    clearBoxDraft: () => {},
    setCaretOffset: (box, offset) => {
      box.caret = offset;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  for (const [thread, entries] of Object.entries(history)) {
    for (const [text, when] of entries) ctx.rememberReply(thread, text, when);
  }
  // A composer for `thread`, standing where its box stands in the card.
  const boxFor = (thread, value = "") => ({ dataset: { reply: thread }, value, caret: value.length });
  const walk = (box, steps) => steps.map((n) => (ctx.recallReply(box, n), box.value));
  return { ctx, boxFor, walk, stored };
}

const ALPHA = "wtgui-alpha-1111";
const BETA = "wtgui-beta-2222";

// ---- 1. two sessions, interleaved: neither walk ever shows the other's words --------------------------------------
test("two interleaved sessions: each composer walks only its own entries, newest first", () => {
  const h = harness({
    jobs: [
      job({ id: "a1", thread: ALPHA, turn: 1, prompt: "alpha one", startedAt: iso(0) }),
      job({ id: "b1", thread: BETA, turn: 1, prompt: "beta one", startedAt: iso(1000) }),
      job({ id: "a2", thread: ALPHA, turn: 2, prompt: "alpha two", startedAt: iso(2000) }),
      job({ id: "b2", thread: BETA, turn: 2, prompt: "beta two", startedAt: iso(3000) }),
    ],
    history: {
      [ALPHA]: [["alpha one", at(0)], ["alpha two", at(2000)], ["alpha typed here", at(4000)]],
      [BETA]: [["beta one", at(1000)], ["beta two", at(3000)], ["beta typed here", at(5000)]],
    },
  });
  assert.deepEqual(rows(h.ctx.turnPrompts(ALPHA)), ["alpha one", "alpha two", "alpha typed here"]);
  assert.deepEqual(rows(h.ctx.turnPrompts(BETA)), ["beta one", "beta two", "beta typed here"]);

  const alpha = h.boxFor(ALPHA);
  assert.deepEqual(h.walk(alpha, [1, 1, 1, -1, -1, -1]), [
    "alpha typed here",
    "alpha two",
    "alpha one",
    // Up at the oldest stays there; Down comes back toward the newest, then to the empty draft the walk started from.
    "alpha two",
    "alpha typed here",
    "",
  ]);
  const beta = h.boxFor(BETA);
  assert.deepEqual(h.walk(beta, [1, 1, 1]), ["beta typed here", "beta two", "beta one"]);
  // Every step of both walks, named: nothing from the other session's text is reachable in this one.
  for (const text of h.walk(h.boxFor(ALPHA), [1, 1, 1])) assert.ok(!/beta/.test(text), `alpha recalled ${JSON.stringify(text)}`);
  for (const text of h.walk(h.boxFor(BETA), [1, 1, 1])) assert.ok(!/alpha/.test(text), `beta recalled ${JSON.stringify(text)}`);
});

// ---- 2. the merge: what the reader typed between two turns is not the newest thing in the session ---------------
test("a steer typed between two turns keeps its place in time instead of landing on top", () => {
  const h = harness({
    jobs: [
      job({ id: "a1", thread: ALPHA, turn: 1, prompt: "first turn", startedAt: iso(1000) }),
      job({ id: "a2", thread: ALPHA, turn: 2, prompt: "second turn", startedAt: iso(3000) }),
    ],
    // The steer never became a turn of its own: the browser's list is its only record.
    history: { [ALPHA]: [["first turn", at(1000)], ["a steer, typed between the turns", at(2000)], ["second turn", at(3000)]] },
  });
  assert.deepEqual(
    rows(h.ctx.turnPrompts(ALPHA)),
    ["first turn", "a steer, typed between the turns", "second turn"],
    "one timeline, ordered by when each entry was said",
  );
  assert.deepEqual(h.walk(h.boxFor(ALPHA), [1, 1, 1]), ["second turn", "a steer, typed between the turns", "first turn"]);
});

// ---- 3. the newest entry was typed in this box, and it repeats an older prompt -------------------------------------
test("the newest entry typed here keeps the newest place even when it repeats an older prompt", () => {
  const h = harness({
    jobs: [
      job({ id: "a1", thread: ALPHA, turn: 1, prompt: "run the tests", startedAt: iso(0) }),
      job({ id: "a2", thread: ALPHA, turn: 2, prompt: "now the docs", startedAt: iso(1000) }),
    ],
    // Sent "run the tests" as turn 1, then "now the docs" as turn 2, then typed "run the tests" again.
    history: { [ALPHA]: [["run the tests", at(0)], ["now the docs", at(1000)], ["run the tests", at(2000)]] },
  });
  assert.deepEqual(rows(h.ctx.turnPrompts(ALPHA)), ["now the docs", "run the tests"], "the repeat is the newest step, not its turn-1 echo");
  assert.deepEqual(h.walk(h.boxFor(ALPHA), [1]), ["run the tests"], "Up reads what the reader typed last, not the stale prompt");
});

test("rememberReply moves a repeated entry to the newest place instead of keeping the old one", () => {
  const h = harness();
  h.ctx.rememberReply(ALPHA, "one", at(0));
  h.ctx.rememberReply(ALPHA, "two", at(1000));
  h.ctx.rememberReply(ALPHA, "one", at(2000));
  // One entry per text, holding when it was last said: "one" is the newest step even though it was said first.
  assert.deepEqual(rows(h.ctx.turnPrompts(ALPHA)), ["two", "one"]);
});

// ---- 4. a turn with no turn number ---------------------------------------------------------------------------------
test("a turn with no number sorts by its clock and is still reachable as the newest", () => {
  const h = harness({
    jobs: [
      job({ id: "a1", thread: ALPHA, turn: 1, prompt: "first prompt", startedAt: iso(0) }),
      // The number was never written for this one: not turn 0, just absent.
      job({ id: "a2", thread: ALPHA, prompt: "third prompt, no turn", startedAt: iso(2000) }),
      job({ id: "a3", thread: ALPHA, turn: 2, prompt: "second prompt", startedAt: iso(1000) }),
    ],
  });
  assert.deepEqual(rows(h.ctx.turnPrompts(ALPHA)), ["first prompt", "second prompt", "third prompt, no turn"]);
  assert.deepEqual(h.walk(h.boxFor(ALPHA), [1, 1, 1]), ["third prompt, no turn", "second prompt", "first prompt"]);
});

test("a turn with a number but no stamp borrows the clock of the turn it follows", () => {
  const h = harness({
    jobs: [
      job({ id: "a1", thread: ALPHA, turn: 1, prompt: "first prompt", startedAt: iso(0) }),
      job({ id: "a2", thread: ALPHA, turn: 2, prompt: "second prompt, no stamp" }),
      job({ id: "a3", thread: ALPHA, turn: 3, prompt: "third prompt", startedAt: iso(5000) }),
    ],
  });
  assert.deepEqual(rows(h.ctx.turnPrompts(ALPHA)), ["first prompt", "second prompt, no stamp", "third prompt"]);
});

// ---- 5. a session with no history at all ---------------------------------------------------------------------------
test("a session with no history recalls nothing, leaves the box alone and starts no walk", () => {
  const h = harness({
    jobs: [job({ id: "a1", thread: ALPHA, turn: 1, prompt: "alpha one", startedAt: iso(0) })],
    history: { [ALPHA]: [["alpha one", at(0)]] },
  });
  assert.deepEqual(rows(h.ctx.turnPrompts(BETA)), [], "no turns, no typed entries, nothing to walk");
  const empty = h.boxFor(BETA, "half a draft");
  assert.deepEqual(h.walk(empty, [1, 1, -1]), ["half a draft", "half a draft", "half a draft"]);
  assert.equal(h.ctx.state.replyNav.has(BETA), false, "no walk was started for a session with nothing to walk");
  // And a box the reader has typed into is never overwritten by another session's text.
  assert.ok(!/alpha/.test(empty.value));
});

// ---- 6. keyed by the composer's own thread, never by a job id ------------------------------------------------------
test("a record with no thread is never recalled through its own id", () => {
  const h = harness({
    jobs: [
      // A record the store carries without a thread: `(j.thread || j.id)` used to name it by its id, which put its
      // prompt in the box of any composer whose thread read the same.
      job({ id: ALPHA, thread: null, turn: 1, prompt: "another session's prompt", startedAt: iso(0) }),
      job({ id: "a1", thread: ALPHA, turn: 1, prompt: "alpha one", startedAt: iso(1000) }),
    ],
  });
  assert.deepEqual(rows(h.ctx.turnPrompts(ALPHA)), ["alpha one"], "the threadless record belongs to no composer");
  assert.ok(!h.walk(h.boxFor(ALPHA), [1, 1, 1]).some((t) => t.includes("another session")), "and never reaches the box");
});

// ---- 7. what the panel itself wrote is not the reader's history ------------------------------------------------------
test("a collected subagent delivery is not on the walk, whatever its shape", () => {
  const h = harness({
    jobs: [
      job({ id: "a1", thread: ALPHA, turn: 1, prompt: "alpha one", startedAt: iso(0) }),
      job({ id: "a2", thread: ALPHA, turn: 2, prompt: "The 2 subagents you delegated have finished. Aggregate their results", origin: { kind: "collect" }, startedAt: iso(1000) }),
      job({ id: "a3", thread: ALPHA, turn: 3, prompt: "The 1 subagent you delegated has finished. Aggregate its result", startedAt: iso(2000) }),
    ],
  });
  assert.deepEqual(rows(h.ctx.turnPrompts(ALPHA)), ["alpha one"], "the panel's own paragraphs never move through the box");
});
