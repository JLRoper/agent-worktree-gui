// A call row with nothing drawn under it means one of THREE things, and the console must say which.
//
// The reader's report: a finished card's expanded tool call read "no output recorded for this call" while the run's
// output was in the session store the whole time - it had simply not been read yet (the read happens when the group
// is opened). On a card whose store was unreadable the same words then read as "this run produced nothing", which is
// how a three-minute agent run with 68 stored tool results looked like a lost transcript.
//
// So the fallback is a three-way answer, and this file pins all three by driving the shipped expression:
//
//   1. the store has not been read for this turn+tool      -> "stored, one click away"
//   2. it WAS read and has no row for this call            -> "no output recorded for this call"  (finished turn)
//                                                             "no output in the session store yet" (a live turn, where
//                                                             the row may still be written)
//   3. it has the row                                      -> the row is drawn, and this note is not reached
//
// The expression is READ OUT of `public/app.js` (the note is a nested template inside the group renderer, so there is
// no function to call), and evaluated against a store in each state - a change to the rule changes these answers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// The note is the one template that fills the empty-result fallback box.
const OPEN = '<div class="jl jl-dim jl-note">  ${';
const start = src.indexOf(OPEN);
assert.ok(start > 0, "public/app.js still draws the empty-result note");
const end = src.indexOf("}</div>`", start);
assert.ok(end > start, "the note's expression still ends where a template ends");
const expr = src.slice(start + OPEN.length, end);

const answer = ({ read, liveTurn, turnId = "turn-1", tool = "terminal" }) => {
  const context = {
    state: { toolStore: new Map() },
    turnId,
    seg: { tool },
    liveTurn,
  };
  if (read) context.state.toolStore.set(`${turnId}|${tool}`, { at: Date.now(), live: liveTurn, results: [] });
  vm.createContext(context);
  return vm.runInContext(`(${expr})`, context);
};

test("a call whose store has not been read yet says the output is stored, one click away", () => {
  assert.equal(answer({ read: false, liveTurn: false }), "stored, one click away");
  assert.equal(answer({ read: false, liveTurn: true }), "stored, one click away", "unread is unread, live or not");
});

test("a call the store was read for and has nothing for still says so", () => {
  assert.equal(answer({ read: true, liveTurn: false }), "no output recorded for this call");
  assert.equal(answer({ read: true, liveTurn: true }), "no output in the session store yet", "a live turn may still write it");
});

test("the note is reached only when the paired store row is missing, and the gate is the store's own key", () => {
  // `out += got ? storedHtml(got, …) : <this note>` - a row that was paired is drawn, never described.
  const before = src.slice(Math.max(0, start - 260), start);
  assert.match(before, /out \+= got\s*\n\s*\? storedHtml\(got, seg\.tool, arg, boxKey, rowAt\)\s*\n\s*:\s*`?$/,
    "the note is the fallback of the paired-row draw");
  // One wording, one place: the reader must never see two different sentences for the same state.
  assert.equal(src.split("stored, one click away").length - 1, 1, "the new wording appears exactly once");
  // The gate asks the SAME key `ensureToolStore` writes, or it would answer "unread" forever.
  assert.ok(src.includes("const cacheKey = `${turnId}|${tool}`;"), "the store is keyed by turn and tool");
  assert.ok(src.includes("state.toolStore.set(cacheKey, { at: Date.now(), live, results })"), "and `has` is asked about that key");
});
