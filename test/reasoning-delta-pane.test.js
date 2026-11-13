// Browser half of the live-reasoning fix: appendJobLine() must treat a `thinkOnly` frame as a
// 🧠 preview (seed the thinking pane, no console line), and the empty console must show an active
// "🧠 thinking…" placeholder while a turn is genuinely running. These are classic scripts, so the
// test drives the shipped regions against stubs the way text-styles.test.js / tool-call-rows.test.js do.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const consoleSrc = read("public/board/console.js");
const jobsSrc = read("public/render-jobs.js");

// ---- appendJobLine thinkOnly -----------------------------------------------------------------
function loadAppend() {
  const begin = consoleSrc.indexOf("function appendJobLine(evt) {");
  assert.ok(begin > 0, "appendJobLine is in board/console.js");
  const end = consoleSrc.indexOf("\n}\n", begin) + 2;
  const region = consoleSrc.slice(begin, end);
  const calls = { paintThink: 0, recordJobLine: 0, drawJobLine: 0, flushTypeStream: 0 };
  const state = { jobs: new Map(), thinkCache: new Map(), typeHold: null, typeGate: null };
  const turn = { id: "turn-1" };
  state.jobs.set(turn.id, turn);
  const make = new vm.Script(`(function(state, paintThink, recordJobLine, drawJobLine, flushTypeStream, isBookkeeping, document){ ${region}; return appendJobLine; })`)
    .runInThisContext();
  const append = make(
    state,
    () => { calls.paintThink += 1; },
    () => { calls.recordJobLine += 1; },
    () => { calls.drawJobLine += 1; },
    () => { calls.flushTypeStream += 1; },
    () => false,
    { hidden: false },
  );
  return { append, state, turn, calls };
}

test("a thinkOnly frame paints the 🧠 pane and never becomes a console line", () => {
  const { append, state, turn, calls } = loadAppend();
  append({ id: "turn-1", line: { kind: "dim", think: "Let me think", at: 111, thinkOnly: true } });

  const entry = state.thinkCache.get(turn.id);
  assert.equal(entry.blocks.length, 1, "one 🧠 block seeded");
  assert.equal(entry.blocks[0].text, "Let me think");
  assert.equal(entry.blocks[0].at, 111);
  assert.equal(calls.paintThink, 1, "the pane is repainted from the push");
  assert.equal(calls.recordJobLine, 0, "no console line recorded");
  assert.equal(calls.drawJobLine, 0, "no console line drawn");
});

test("a stable at keeps one growing block across coalesced thinkOnly frames", () => {
  const { append, state, turn } = loadAppend();
  append({ id: "turn-1", line: { think: "abc", at: 111, thinkOnly: true } });
  append({ id: "turn-1", line: { think: "abcdef", at: 111, thinkOnly: true } });
  const entry = state.thinkCache.get(turn.id);
  assert.equal(entry.blocks.length, 1, "the same at replaces, not appends");
  assert.equal(entry.blocks[0].text, "abcdef", "the pane shows the cumulative text");
});

test("a finished reasoning.available line (no thinkOnly) still draws its console line", () => {
  const { append, state, turn, calls } = loadAppend();
  append({ id: "turn-1", line: { kind: "dim", text: "🧠 reasoning · x", think: "x", at: 222 } });
  assert.equal(state.thinkCache.get(turn.id).blocks.length, 1, "the pane is still seeded");
  assert.equal(calls.recordJobLine, 1, "but the dim preview line still joins the console");
  assert.equal(calls.drawJobLine, 1);
});

// ---- empty console "thinking…" placeholder ----------------------------------------------------
function loadEmptyConsole(turnLive) {
  const begin = jobsSrc.indexOf("// ---- thinking placeholder ----");
  const end = jobsSrc.indexOf("// ---- end thinking placeholder ----");
  assert.ok(begin > 0 && end > begin, "the thinking placeholder region is in render-jobs.js");
  const region = jobsSrc.slice(begin, end);
  const make = new vm.Script(`(function(turnLive, liveSuffix){ ${region}; return emptyConsoleHtml; })`)
    .runInThisContext();
  return make(turnLive, () => "0s");
}
// turnLive mirrors board-scaffold.js LIVE_STATUS for these tests.
const liveStatus = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);
const turnLive = (t) => liveStatus.has(String(t?.status || ""));

test("a running turn shows the active, ticking thinking placeholder", () => {
  const html = loadEmptyConsole(turnLive)({ status: "running", startedAt: new Date().toISOString() });
  assert.match(html, /🧠 thinking…/, "active wording, not a passive stall");
  assert.match(html, /data-wait="1"/, "the first real line still removes it");
  assert.match(html, /data-live-from=/, "a clock that ticks without a repaint");
  assert.match(html, /jl-live/, "the ticking clock span");
});

test("a starting turn also shows the active placeholder from submit", () => {
  const html = loadEmptyConsole(turnLive)({ status: "starting", startedAt: new Date().toISOString() });
  assert.match(html, /🧠 thinking…/);
});

test("held, queued and settled turns keep the honest waiting wording", () => {
  const empty = loadEmptyConsole(turnLive);
  for (const status of ["waiting", "queued", "waiting_for_approval", "done", "failed"]) {
    const html = empty({ status, startedAt: new Date().toISOString() });
    assert.match(html, /waiting for output…/, `${status} must not claim the model is thinking`);
    assert.doesNotMatch(html, /data-live-from/, `${status} gets no clock`);
  }
});
