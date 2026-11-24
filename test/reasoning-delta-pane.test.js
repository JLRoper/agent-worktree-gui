// The live reasoning preview, as a row of the console.
//
// There is no thinking pane any more: a `thinkOnly` frame from lib/jobs.js grows a block under a stable `at`
// and the console record holds one preview row per block, in arrival order. The next `at` after a tool is a NEW
// thought and a NEW row; the store poll settles its text into the preview while the turn runs, and on settle the
// previews come out of the record and the store's blocks are merged by `at` - one copy of each thought.
//
// public/board/console.js is a classic script, so these drive the shipped regions against stubs the way
// text-styles.test.js / tool-call-rows.test.js do.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const consoleSrc = read("public/board/console.js");
const jobsSrc = read("public/render-jobs.js");
const renderSrc = read("public/render-jobs.js");

const sliceBetween = (src, a, b) => {
  const begin = src.indexOf(a);
  const end = src.indexOf(b, begin + a.length);
  assert.ok(begin > 0 && end > begin, `${a} .. ${b} is in the source`);
  return src.slice(begin, end);
};

// ---- the live block and its preview rows ------------------------------------------------------
function loadLiveThought() {
  const region = sliceBetween(consoleSrc, "// ---- the live thought, as a row of the console", "// ---- end the live thought");
  const state = { jobs: new Map(), jobLines: new Map(), thinkCache: new Map(), jobLineVersion: new Map() };
  const drawn = [];
  const make = new vm.Script(
    `(function(state, document, CSS, turnLive, thinkingOn, drawJobLine, trimJobLines, thinkLid){ ${region}; return { growLiveThought, endLiveThought, syncThoughtRows }; })`,
  ).runInThisContext();
  const api = make(
    state,
    { querySelector: () => null },
    { escape: (s) => String(s) },
    () => true,
    () => true,
    (evt) => drawn.push(evt.line),
    () => {},
    (at) => `think:${Number(at) || 0}`,
  );
  const turn = { id: "turn-1" };
  state.jobs.set(turn.id, turn);
  return { ...api, state, turn, drawn };
}

const frame = (at, think, thinkFrom = 0) => ({ think, thinkFrom, at, thinkOnly: true });

test("a thinkOnly frame opens a preview row of the console, marked live", () => {
  const t = loadLiveThought();
  t.growLiveThought(t.turn, frame(111, "Let me think"));
  const entry = t.state.thinkCache.get(t.turn.id);
  assert.equal(entry.blocks.length, 1, "one growing block");
  assert.equal(entry.blocks[0].text, "Let me think");
  assert.equal(entry.blocks[0].at, 111);
  assert.equal(entry.blocks[0].live, true, "the row carries the still-thinking mark");
  assert.equal(entry.blocks[0].preview, true, "marked so the settled read can take it out");
  const buf = t.state.jobLines.get(t.turn.id);
  assert.equal(buf.length, 1, "the preview is a line of the turn's own record");
  assert.equal(buf[0].kind, "think");
  assert.equal(buf[0].lid, "think:111");
  assert.equal(buf[0].text, "Let me think");
  assert.equal(buf[0].live, true);
  assert.equal(t.drawn.at(-1).mode, "new", "the first frame appends the row");
});

test("a contiguous chunk grows the same block and the same row in place", () => {
  const t = loadLiveThought();
  t.growLiveThought(t.turn, frame(111, "Let me ", 0));
  t.growLiveThought(t.turn, frame(111, "think.", 7));
  const entry = t.state.thinkCache.get(t.turn.id);
  assert.equal(entry.blocks.length, 1, "one block, not one per chunk");
  assert.equal(entry.blocks[0].text, "Let me think.");
  assert.equal(t.state.jobLines.get(t.turn.id).length, 1, "one row, not one per chunk");
  assert.equal(t.state.jobLines.get(t.turn.id)[0].text, "Let me think.");
  assert.equal(t.drawn.at(-1).mode, "set", "the later chunk updates the row it belongs to");
});

test("a tab that joined mid-block starts where it attached, then continues", () => {
  const t = loadLiveThought();
  t.growLiveThought(t.turn, frame(111, "later words", 400));
  assert.equal(t.state.thinkCache.get(t.turn.id).blocks[0].text, "later words");
  assert.equal(t.state.thinkCache.get(t.turn.id).blocks[0].base, 400, "the offset it started at is recorded");
  t.growLiveThought(t.turn, frame(111, " and more", 411));
  assert.equal(t.state.thinkCache.get(t.turn.id).blocks[0].text, "later words and more");
});

test("a gap in the offsets replaces the block rather than inventing the missing words", () => {
  const t = loadLiveThought();
  t.growLiveThought(t.turn, frame(111, "abc", 0));
  t.growLiveThought(t.turn, frame(111, "ghij", 6));
  assert.equal(t.state.thinkCache.get(t.turn.id).blocks[0].text, "ghij");
});

test("reasoning that resumes after a tool starts a NEW block and a NEW row", () => {
  const t = loadLiveThought();
  t.growLiveThought(t.turn, frame(111, "first thought"));
  // The call lands: the row keeps its words and loses the mark.
  t.endLiveThought(t.turn, 111);
  assert.equal(t.state.thinkCache.get(t.turn.id).blocks[0].live, false, "the first row stops thinking");
  // The next assistant message reasons: a new at, a new block, a new row after the call.
  t.growLiveThought(t.turn, frame(222, "second thought"));
  const blocks = t.state.thinkCache.get(t.turn.id).blocks;
  assert.equal(blocks.length, 2, "two thoughts, two rows");
  assert.equal(blocks[0].text, "first thought", "the first thought is not rewritten");
  assert.equal(blocks[1].text, "second thought");
  assert.equal(blocks[1].live, true);
  const rows = t.state.jobLines.get(t.turn.id);
  assert.deepEqual(
    rows.map((l) => `${l.lid}:${l.text}`),
    ["think:111:first thought", "think:222:second thought"],
    "the rows keep arrival order",
  );
  assert.equal(rows[0].live, false, "the old row's indicator is gone");
  assert.equal(rows[1].live, true);
});

test("a thinkEnd frame stops the mark without touching the words", () => {
  const t = loadLiveThought();
  t.growLiveThought(t.turn, frame(111, "still going"));
  t.endLiveThought(t.turn, 111);
  const row = t.state.jobLines.get(t.turn.id)[0];
  assert.equal(row.text, "still going");
  assert.equal(Boolean(row.live), false, "the mark is removed, nothing else");
});

// ---- reconcile: the store poll vs the live preview --------------------------------------------
function loadReconcile() {
  const region = sliceBetween(consoleSrc, "// ---- reconcile thinking ----", "// ---- end reconcile thinking ----");
  const make = new vm.Script(`(function(){ ${region}; return reconcileThinking; })`).runInThisContext();
  return make();
}

test("no preview: the store poll replaces wholesale", () => {
  const reconcile = loadReconcile();
  const fresh = [{ at: 999, text: "finished" }];
  assert.deepEqual(reconcile([{ at: 555, text: "old" }], fresh), fresh);
});

test("an empty or failed read keeps the preview", () => {
  const reconcile = loadReconcile();
  const prev = [{ at: 111, text: "streaming", live: true, preview: true }];
  assert.deepEqual(reconcile(prev, []), prev);
});

test("a live preview adopts the store's complete text under its own at (no re-key, no duplicate)", () => {
  const reconcile = loadReconcile();
  const prev = [{ at: 111, text: "stream", live: true, preview: true }];
  const out = reconcile(prev, [{ at: 999, text: "stream finished" }]);
  assert.equal(out.length, 1, "one row, not the preview and the block");
  assert.equal(out[0].at, 111, "the stable lid is preserved");
  assert.equal(out[0].text, "stream finished", "the recorded text is adopted");
  assert.equal(out[0].preview, true);
});

test("a settled turn takes the store's blocks and drops the previews", () => {
  const reconcile = loadReconcile();
  const prev = [
    { at: 111, text: "first", live: false, preview: true },
    { at: 222, text: "second", live: true, preview: true },
  ];
  const fresh = [{ at: 900, text: "first" }, { at: 901, text: "second" }];
  const out = reconcile(prev, fresh, true);
  assert.deepEqual(out, fresh, "the store is the transcript once the turn has settled");
});

test("previews pair with the LAST store blocks, so a late-joining tab settles into the newest thought", () => {
  const reconcile = loadReconcile();
  const prev = [{ at: 222, text: "second", live: true, preview: true }];
  const out = reconcile(prev, [{ at: 900, text: "first" }, { at: 901, text: "second" }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].at, 900, "the store block this tab never saw stays a store block");
  assert.equal(out[1].at, 222, "the preview keeps its lid");
  assert.equal(out[1].text, "second");
});

// ---- the row's markup ------------------------------------------------------------------------
function loadThinkRow() {
  const region = sliceBetween(consoleSrc, "// ---- reasoning: one row of the same stream", "// ---- end reasoning rows");
  const make = new vm.Script(
    `(function(esc, linkifyText, liveSuffix){ ${region}; return { thinkRowHtml, thinkLid, thinkOpenRows }; })`,
  ).runInThisContext();
  return make((s) => String(s), (s) => String(s), () => " · 3s");
}

test("a thinking row is dim, clipped by its own class, and addresses one lid", () => {
  const { thinkRowHtml } = loadThinkRow();
  const html = thinkRowHtml({ kind: "think", lid: "think:111", at: 111, text: "a thought" }, "jl-sep");
  assert.match(html, /class="jl jl-think think-row jl-sep"/, "the stream's own row and blank line");
  assert.match(html, /data-lid="think:111"/);
  assert.match(html, /data-think-row="1"/);
  assert.match(html, /class="think-text"/, "the clipped box");
  assert.doesNotMatch(html, /data-think-live/, "a settled thought carries no indicator");
});

test("a live row carries the still-thinking mark inside the console output", () => {
  const { thinkRowHtml } = loadThinkRow();
  const html = thinkRowHtml({ kind: "think", lid: "think:111", at: 111, text: "a thought", live: true });
  assert.match(html, /data-think-live="1"/, "the mark is part of the row, not a separate pane");
  assert.match(html, /thinking/, "it says what it means");
  assert.match(html, /data-live-from="111"/, "the age ticks from the thought's first word");
});

// ---- the hasLive rule, at the two writers that decide it --------------------------------------
test("the stream draws a turn with previews from its record, and merges the store only without them", () => {
  assert.match(
    renderSrc,
    /const previews = shown\.some\(\(l\) => l && l\.preview && l\.kind === "think"\);/,
    "streamBodyHtml asks the hasLive question",
  );
  assert.match(renderSrc, /previews\s*\?\s*shown\s*:\s*W\.merge\(/, "previews win; the store is merged only when there are none");
  assert.match(renderSrc, /hidePreviews: blocks\.length > 0/, "the old one-line dim preview is still dropped beside a whole block");
});

test("the settled read removes the preview rows from the console record", () => {
  assert.match(consoleSrc, /function dropThoughtPreviews\(turn\)/);
  assert.match(consoleSrc, /l\.preview && l\.kind === "think"/, "only preview think rows are taken out");
  assert.match(consoleSrc, /if \(adopted\) \{\n\s*if \(!live\) dropThoughtPreviews\(turn\);/, "a settled read takes them out");
});

// ---- empty console "thinking…" placeholder ----------------------------------------------------
function loadEmptyConsole(turnLive) {
  const region = sliceBetween(jobsSrc, "// ---- thinking placeholder ----", "// ---- end thinking placeholder ----");
  const make = new vm.Script(`(function(turnLive, liveSuffix){ ${region}; return emptyConsoleHtml; })`).runInThisContext();
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
