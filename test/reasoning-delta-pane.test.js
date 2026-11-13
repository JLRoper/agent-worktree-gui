// Browser half of the live-reasoning fix: appendJobLine() must treat a `thinkOnly` frame as a
// 🧠 preview (seed the thinking pane, no console line), the empty console must show an active
// "🧠 thinking…" placeholder while a turn is genuinely running, and reconcileThinking() must stop
// the store poll's finished block from re-keying the live preview (which retyped it from word 0).
// These are classic scripts, so the test drives the shipped regions against stubs the way
// text-styles.test.js / tool-call-rows.test.js do.
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

test("a thinkOnly frame marks the block live so the store poll cannot re-key it", () => {
  const { append, state, turn } = loadAppend();
  append({ id: "turn-1", line: { think: "abc", at: 111, thinkOnly: true } });
  assert.equal(state.thinkCache.get(turn.id).blocks[0].live, true, "block is flagged live");
});

test("a finished reasoning.available is ignored once a live block exists (no second copy)", () => {
  const { append, state, turn } = loadAppend();
  append({ id: "turn-1", line: { think: "streaming", at: 111, thinkOnly: true } });
  // The old completion-time push: the SAME reasoning under a different at.
  append({ id: "turn-1", line: { kind: "dim", text: "🧠 reasoning · streaming", think: "streaming", at: 999 } });
  const entry = state.thinkCache.get(turn.id);
  assert.equal(entry.blocks.length, 1, "still exactly one 🧠 block, not two copies");
  assert.equal(entry.blocks[0].at, 111, "the live block keeps its stable pacer lid");
});

test("a thinkOnly frame clears a stale store block (one growing preview)", () => {
  const { append, state, turn } = loadAppend();
  // A store block that landed before the deltas started (finished, non-live, other at).
  append({ id: "turn-1", line: { kind: "dim", think: "old", at: 999 } });
  append({ id: "turn-1", line: { think: "new", at: 111, thinkOnly: true } });
  const entry = state.thinkCache.get(turn.id);
  assert.equal(entry.blocks.length, 1, "the stale store block is dropped");
  assert.equal(entry.blocks[0].at, 111);
  assert.equal(entry.blocks[0].text, "new");
});

test("a finished reasoning.available line (no thinkOnly) still draws its console line", () => {
  const { append, state, turn, calls } = loadAppend();
  append({ id: "turn-1", line: { kind: "dim", text: "🧠 reasoning · x", think: "x", at: 222 } });
  assert.equal(state.thinkCache.get(turn.id).blocks.length, 1, "the pane is still seeded");
  assert.equal(calls.recordJobLine, 1, "but the dim preview line still joins the console");
  assert.equal(calls.drawJobLine, 1);
});

// ---- reconcileThinking (store poll vs live preview) -------------------------------------------
function loadReconcile() {
  const begin = consoleSrc.indexOf("// ---- reconcile thinking ----");
  const end = consoleSrc.indexOf("// ---- end reconcile thinking ----");
  assert.ok(begin > 0 && end > begin, "the reconcileThinking region is in board/console.js");
  const region = consoleSrc.slice(begin, end);
  const make = new vm.Script(`(function(){ ${region}; return reconcileThinking; })`).runInThisContext();
  return make();
}

test("no live preview: the store poll still replaces wholesale (old behaviour)", () => {
  const reconcile = loadReconcile();
  const fresh = [{ at: 999, text: "finished" }];
  assert.deepEqual(reconcile([{ at: 555, text: "old" }], fresh), fresh);
});

test("live preview + empty store read: keep the growing preview", () => {
  const reconcile = loadReconcile();
  const prev = [{ at: 111, text: "streaming", live: true }];
  assert.deepEqual(reconcile(prev, []), prev);
});

test("live preview + finished store block: keep the live at, adopt the complete text (no re-key)", () => {
  const reconcile = loadReconcile();
  const prev = [{ at: 111, text: "stream", live: true }];
  const fresh = [{ at: 999, text: "stream finished" }];
  const out = reconcile(prev, fresh);
  assert.equal(out.length, 1, "still one 🧠 block, not a duplicate");
  assert.equal(out[0].at, 111, "the stable pacer lid is preserved (no retype from word 0)");
  assert.equal(out[0].text, "stream finished", "the store's complete text is adopted");
  assert.equal(out[0].live, true, "still flagged live");
});

test("live preview + several store blocks: fold into one live block, keep the lid", () => {
  const reconcile = loadReconcile();
  const prev = [{ at: 111, text: "a", live: true }];
  const fresh = [{ at: 900, text: "a b" }, { at: 901, text: "c" }];
  const out = reconcile(prev, fresh);
  assert.equal(out.length, 1);
  assert.equal(out[0].at, 111);
  assert.equal(out[0].text, "a b\n\nc");
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
