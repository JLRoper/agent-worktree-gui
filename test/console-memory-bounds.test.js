// The tab's console buffers are bounded in three places, and this file holds each one down.
//
// What went wrong. `state.jobLines` holds one array per turn, the array a card's console is drawn from. Every
// turn that ever streamed left its array behind for the life of the page: the per-turn trim (1,000 lines) bounded
// one turn and nothing bounded the tab, and the snapshot loop only ever ADDED to the map. Measured on a real page
// (docs/console-memory-growth.md): 121 driven turns left 240 buffers holding 19,982 lines; the reader's own
// "Clear finished" emptied the board and left all 19 buffers and all 752 lines; a fresh panel with an empty store
// did the same. The record's 60-line tail was also retained twice for every turn - once in the record `/api/state`
// delivers, once in a copied array nothing ever shrank - and the page's per-turn cap (1,000) was longer than the
// panel's own ring (600), so it held lines the server had already dropped and never learned they were gone.
//
// The three changes, in the order the document recommends them:
//   1. `applyJobSnapshot()` releases a buffer for a turn the server no longer lists (a live turn is kept).
//   2. `trimJobLines()` caps how many turn buffers the tab holds at all, newest first.
//   3. no snapshot or `job` frame seeds a buffer from the record's tail: `jobLines()` draws that tail from the
//      record, and `recordJobLine()` seeds only a running turn's first buffer. The per-turn cap is the server's
//      number, not a longer one.
//
// Everything here runs the shipped functions, read out of public/app.js and public/board/console.js between their
// markers, against a state of plain Maps. The numbers in the fixtures are the document's measured ones.

import assert from "node:assert/strict";
import test from "node:test";

import { readSource, sliceBetween } from "../tools/panel-testkit.mjs";

const app = readSource("public/app.js");
const consoleJs = readSource("public/board/console.js");

// turnLive() and its status set are app.js's answers, so a fixture cannot invent a liveness rule of its own.
const liveCode = sliceBetween(app, 'const LIVE_STATUS = new Set([', "// An approval is only a question while the gateway");
// jobLines(), the ceiling and its trim sit together under the agents heading.
const buffersCode = sliceBetween(app, "// ---------------- agents ----------------", "// ---- minimize / expand a card");
// The snapshot's job half, extracted so the sweep can be driven without a DOM.
const snapshotCode = sliceBetween(app, "function applyJobSnapshot(", "function applySnapshot(");
// The console's only buffer writer, and the per-turn cap it trims to.
const recordCode = sliceBetween(consoleJs, "const JOB_LINES_PER_TURN", "// One line into every pane showing this turn.");

const patched = new Function(
  "state",
  "refreshTurnPeek",
  `${liveCode}\n${buffersCode}\n${snapshotCode}\n${recordCode}
   return { jobLines, trimJobLines, applyJobSnapshot, recordJobLine, MAX_TURN_BUFFERS, JOB_LINES_PER_TURN };`,
);

function bench() {
  const state = { jobs: new Map(), jobLines: new Map() };
  const peeked = [];
  const page = patched(state, (job) => peeked.push(job && job.id));
  return { state, page, peeked };
}

const line = (i) => ({ kind: "tool-out", text: `line ${i}`, lid: i, at: 1_000 + i });
const tail = (n, from = 0) => Array.from({ length: n }, (_, i) => line(from + i));

// A record the way `/api/jobs` carries it: the last 60 lines of the turn, not the turn's whole buffer.
function record(id, { status = "done", thread = "t1", lines = tail(60) } = {}) {
  return { id, thread, status, turn: 1, lines, live: status === "running" ? { events: 1 } : null };
}

// The measured board before "Clear finished": 19 records, 19 buffers, 752 lines in them.
function measuredBoard(page, state) {
  const ids = Array.from({ length: 19 }, (_, i) => `turn-${i}`);
  for (const id of ids) state.jobs.set(id, record(id));
  // 752 lines over 19 buffers: eleven of 40, eight of 39.
  ids.forEach((id, i) => state.jobLines.set(id, tail(i < 11 ? 40 : 39, i * 100)));
  return ids;
}

const lineCount = (state) => [...state.jobLines.values()].reduce((n, b) => n + b.length, 0);

test("a turn the server no longer lists loses its console buffer", () => {
  const { state, page, peeked } = bench();
  measuredBoard(page, state);
  assert.equal(state.jobLines.size, 19);
  assert.equal(lineCount(state), 752, "the document's measured shape before the press");

  // The reader presses "Clear finished": the next snapshot lists nothing the board was holding.
  page.applyJobSnapshot([]);

  assert.equal(state.jobs.size, 0, "the job map emptied, as it always did");
  assert.equal(state.jobLines.size, 0, "and every buffer went with the record it belonged to");
  assert.equal(lineCount(state), 0, "752 lines released, not 752 lines still held");
  assert.deepEqual(peeked, [], "no card was repainted: there is nothing left to draw");
});

test("a buffer survives the snapshot that still lists its job", () => {
  const { state, page } = bench();
  measuredBoard(page, state);
  const listed = [...state.jobs.values()].map((j) => ({ ...j }));
  page.applyJobSnapshot(listed);
  assert.equal(state.jobLines.size, 19, "a turn the panel still holds keeps its console");
  assert.equal(lineCount(state), 752);
});

test("a turn that was running when the snapshot landed is not mistaken for a forgotten one", () => {
  const { state, page } = bench();
  const running = record("turn-live", { status: "running" });
  const done = record("turn-done");
  state.jobs.set(running.id, running);
  state.jobs.set(done.id, done);
  state.jobLines.set(running.id, tail(20));
  state.jobLines.set(done.id, tail(20));

  // A snapshot that has not caught up with the running turn yet: it lists neither, and the run is still writing.
  page.applyJobSnapshot([]);

  assert.equal(state.jobLines.has("turn-live"), true, "a live turn's buffer is where its frames are going");
  assert.equal(state.jobLines.has("turn-done"), false, "a settled turn nobody lists is released");
});

test("a turn parked on an open approval counts as live", () => {
  const { state, page } = bench();
  const parked = { ...record("turn-parked", { status: "waiting_for_approval" }), approval: { id: "a1" } };
  const settled = { ...record("turn-settled", { status: "done" }), approval: { id: "a2" }, approvalDone: { choice: "allow" } };
  state.jobs.set(parked.id, parked);
  state.jobs.set(settled.id, settled);
  state.jobLines.set(parked.id, tail(5));
  state.jobLines.set(settled.id, tail(5));

  page.applyJobSnapshot([]);

  assert.equal(state.jobLines.has("turn-parked"), true, "an unanswered question still has a card to come back to");
  assert.equal(state.jobLines.has("turn-settled"), false, "an answered one does not");
});

test("the tab holds at most MAX_TURN_BUFFERS turn buffers, and keeps the newest", () => {
  const { state, page } = bench();
  const turns = 200;
  for (let i = 0; i < turns; i += 1) {
    const id = `turn-${String(i).padStart(3, "0")}`;
    state.jobs.set(id, record(id));
    page.recordJobLine({ id, line: line(i) });
  }

  assert.equal(state.jobLines.size, page.MAX_TURN_BUFFERS, "one array per turn had no ceiling; this is the ceiling");
  assert.equal(state.jobLines.has(`turn-${String(turns - 1).padStart(3, "0")}`), true, "the newest turn is kept");
  assert.equal(state.jobLines.has("turn-001"), false, "the oldest is released");
  // A released buffer is not a lost console: the record still carries the tail the card draws from.
  assert.equal(page.jobLines("turn-001").length, 60, "an evicted turn still draws its record's tail");
});

test("a live turn keeps its buffer while the ceiling trims the settled ones", () => {
  const { state, page } = bench();
  state.jobs.set("turn-live", record("turn-live", { status: "running" }));
  page.recordJobLine({ id: "turn-live", line: line(0) });
  for (let i = 0; i < page.MAX_TURN_BUFFERS + 9; i += 1) {
    const id = `turn-${String(i).padStart(3, "0")}`;
    state.jobs.set(id, record(id));
    page.recordJobLine({ id, line: line(i) });
  }

  assert.equal(state.jobLines.size, page.MAX_TURN_BUFFERS);
  assert.equal(state.jobLines.has("turn-live"), true, "the running turn was first in the map and still kept its buffer");
  assert.equal(state.jobLines.has("turn-000"), false, "the oldest settled turn paid for it");
});

test("the per-turn cap is the panel's own number, not a longer one of its own", () => {
  const serverCap = Number(/const MAX_LINES = (\d+);/.exec(readSource("lib/jobs.js"))[1]);
  const { state, page } = bench();
  assert.equal(page.JOB_LINES_PER_TURN, serverCap, "the client and the server trim a turn to the same ring");

  // The cap probe's turn: 1,290 lines streamed into one turn.
  state.jobs.set("turn-cap", record("turn-cap", { status: "running", lines: [] }));
  for (let i = 0; i < 1_290; i += 1) page.recordJobLine({ id: "turn-cap", line: line(i) });

  const buf = state.jobLines.get("turn-cap");
  assert.equal(buf.length, serverCap, "the buffer stops at the panel's ring");
  assert.equal(buf[buf.length - 1].lid, 1_289, "and what it keeps is the newest line");
  assert.equal(buf.some((l) => l.lid < 1_290 - serverCap), false, "the oldest lines are the ones dropped");
});

test("a settled turn draws the record's 60-line tail without copying it into a second array", () => {
  const { state, page } = bench();
  state.jobs.set("turn-settled", record("turn-settled"));

  // A snapshot of a board full of settled turns: every record keeps its tail, none opens a buffer.
  page.applyJobSnapshot([...state.jobs.values()]);

  assert.equal(state.jobLines.size, 0, "no buffer was seeded from the record's tail");
  assert.equal(page.jobLines("turn-settled").length, 60, "the card reads that tail from the record");
  assert.equal(page.jobLines("turn-settled"), state.jobs.get("turn-settled").lines, "the same array, not a copy");
});

test("a running turn's first frame starts from the tail its card is already showing", () => {
  const { state, page } = bench();
  const running = record("turn-running", { status: "running", lines: tail(12, 0) });
  state.jobs.set(running.id, running);

  page.recordJobLine({ id: "turn-running", line: line(12) });

  const buf = state.jobLines.get("turn-running");
  assert.equal(buf.length, 13, "the 12 lines the card had, plus the one that just arrived");
  assert.equal(buf[0].lid, 0, "the buffer starts where the record's tail starts");
  assert.equal(buf[12].lid, 12, "and ends on the new line");
  assert.notEqual(buf, running.lines, "a buffer of its own, so the record is never mutated by a frame");
});

test("a settled turn's buffer is not seeded: late frames only append what arrived", () => {
  const { state, page } = bench();
  state.jobs.set("turn-settled", record("turn-settled"));
  page.recordJobLine({ id: "turn-settled", line: line(99) });
  assert.deepEqual(
    state.jobLines.get("turn-settled").map((l) => l.lid),
    [99],
    "nothing was copied in front of the line that arrived",
  );
});
