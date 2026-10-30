// A tool group's identity, the window that keeps it, and the head row a trimmed burst is still allowed to have.
//
// The code under test is READ OUT of public/app.js between its markers, not copied here (the way branch-cell.test.js
// reads the branch cell): these answers are about the page's own rule, so a rule that goes back to counting raw
// lines - or to keying a group from whatever line the window left on top of it - fails here.
//
// What went wrong, and what each test holds down:
//
//  * turnBody drew the last 300 lines of a turn (`all.slice(-300)`). A terminal call with long output pushed its own
//    call line out of the window while the output stayed, and toolBurstRows only makes a row from a line of kind
//    `tool`, so it found nothing to tally. toolGroupHtml then returned the bare lines: no head row, no .tgrp-body,
//    no data-gstate - the block was not a group any more, so there was nothing to open and nowhere for the reader's
//    open state to land.
//  * The state key is `${turnId}|${anchor}` and the anchor was re-derived from the burst's FIRST LINE on every full
//    render. A repaint that began the burst one line lower looked up a key nobody had ever set, the lookup missed,
//    and the condensed default (`hidden`) came back: an open group flipped shut with no click behind it.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const between = (begin, end) => {
  const a = src.indexOf(begin);
  const b = src.indexOf(end);
  assert.ok(a >= 0 && b > a, `public/app.js carries the ${begin} markers this test reads`);
  return src.slice(src.indexOf("\n", a) + 1, b);
};
const keyCode = between("// ---- tool group key", "// ---- end tool group key");
const trimmedCode = between("// ---- trimmed group head", "// ---- end trimmed group head");

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The console's own result-header pattern ("  ↳ terminal"), so the names in a trimmed head row come from the same
// regex the grouped path reads.
const TOOL_DONE_RE = eval(/const TOOL_DONE_RE = (\/.*?\/);/.exec(src)[1]);
// The burst renderer is not what these answers are about: stubbed to a marker, so a test can only be asserting on
// the wrapper - which attributes the group carries and whether its body came out hidden.
const trimmedBurstHtml = (lines) => `<div class="jl-body">${lines.length}</div>`;
const state = { toolGroupOpen: new Map(), codeBoxOpen: new Set() };

const { toolGroupAnchor, windowLines, toolGroupStateKey, toolGroupDropsState, rememberToolGroup, trimmedGroupHtml, TURN_WINDOW } =
  new Function(
    "esc",
    "TOOL_DONE_RE",
    "trimmedBurstHtml",
    "state",
    `${keyCode}\n${trimmedCode}\nreturn { toolGroupAnchor, windowLines, toolGroupStateKey, toolGroupDropsState, rememberToolGroup, trimmedGroupHtml, TURN_WINDOW };`,
  )(esc, TOOL_DONE_RE, trimmedBurstHtml, state);

// Lines as lib/jobs.js stamps them: every one carries a monotonic `lid` and the clock it was written at.
let seq = 0;
const line = (kind, text) => ({ kind, text, lid: ++seq, at: 1_790_000_000_000 + seq });
const call = (text = "💻 terminal · npm test") => line("tool", text);
const result = (tool = "terminal") => line("tool-out", `  ↳ ${tool}`);
const out = (n) => line("tool-out", `  line ${n} of output`);

const body = (html) => (/<div class="tgrp-body"([^>]*)>/.exec(html) || [])[1] ?? null;
const hidden = (html) => /\shidden/.test(body(html) || "");

// ---- the window: cut on a burst boundary, not a line count ----------------------------------

test("a window that would cut into a burst keeps the call line that produced it", () => {
  const said = line("text", "running the suite");
  const first = call();
  const all = [said, first, result(), ...Array.from({ length: 420 }, (_, i) => out(i))];
  const win = windowLines(all);
  assert.equal(win[0], first, "the window starts at the burst's own call line, not 120 lines into its output");
  assert.equal(win.includes(said), false, "and the prose above it is still outside the window");
  assert.deepEqual(win, all.slice(1), "the kept burst is contiguous: no hole between the call and its output");
  assert.ok(win.length <= TURN_WINDOW * 2, "a kept burst stays within a second window");
});

test("a burst too long to keep whole still keeps its call line, and only the window under it", () => {
  const first = call();
  const all = [first, ...Array.from({ length: 900 }, (_, i) => out(i))];
  const win = windowLines(all);
  assert.equal(win[0], first, "the call line survives, so the burst is still a group");
  assert.equal(win.length, TURN_WINDOW + 1, "and the window itself is not widened to swallow 900 lines");
  assert.deepEqual(win.slice(1), all.slice(-TURN_WINDOW), "what is under it is the ordinary window");
});

test("a window that already starts on a call line or on prose is left alone", () => {
  // 10 lines, the call on top: nothing is cut in half, so the window is the plain tail.
  const atCall = [call(), result(), ...Array.from({ length: 8 }, (_, i) => out(i))];
  assert.deepEqual(windowLines(atCall, 10), atCall, "a window that begins at a burst's call adds nothing");
  const atProse = [call(), result(), out(0), out(1), line("text", "then it finished"), ...Array.from({ length: 20 }, (_, i) => line("text", `more ${i}`))];
  const win = windowLines(atProse, 10);
  assert.equal(win[0].kind, "text", "a burst that ended above the window is not walked back into");
  assert.deepEqual(win, atProse.slice(-10));
});

test("a burst whose own call line is gone from the buffer is drawn as the window found it", () => {
  const headless = Array.from({ length: 40 }, (_, i) => out(i));
  assert.deepEqual(windowLines(headless, 10), headless.slice(-10), "there is no call line to put back");
  assert.equal(windowLines(headless, 10).length, 10);
});

test("a turn shorter than the window is returned whole, as the same array", () => {
  const all = [call(), result(), out(0)];
  assert.equal(windowLines(all), all, "nothing to slice: the buffer IS the window");
  assert.deepEqual(windowLines(null), [], "no buffer is an empty window, not an exception");
});

// ---- the key: a burst is remembered by its first CALL ---------------------------------------

test("a group is keyed by the burst's first call, not by a result line above it", () => {
  // A burst the buffer trimmed of its call, immediately followed by a call: the old anchor took the result line (6)
  // and re-keyed the group the moment that line slid out; the call (7) is what identifies the run.
  const lines = [result(), call(), result(), out(0)];
  assert.equal(toolGroupAnchor(lines), String(lines[1].lid));
  assert.equal(toolGroupStateKey("job1#3", lines), `job1|${lines[1].lid}`);
});

test("the key the reader's click was stored under is the one the next render derives", () => {
  const first = call();
  const burst = [first, result(), ...Array.from({ length: 60 }, (_, i) => out(i))];
  const keyBefore = toolGroupStateKey("job1#3", burst);
  // The turn grows by 260 output lines of the same burst: the 300-line window now opens inside it.
  const grown = [...burst, ...Array.from({ length: 260 }, (_, i) => out(100 + i))];
  const win = windowLines(grown);
  assert.equal(win[0], first, "the window was cut at the burst's call, not inside its output");
  assert.equal(toolGroupStateKey("job1#3", win), keyBefore, "the anchor did not move with the window");

  // And the pathological one: a burst too long to keep whole is reduced to its call line plus the window, and the
  // key still has to be the one the reader opened.
  const huge = [first, result(), ...Array.from({ length: 900 }, (_, i) => out(i))];
  const trimmedWin = windowLines(huge);
  assert.equal(trimmedWin.length, TURN_WINDOW + 1);
  assert.equal(toolGroupStateKey("job1#3", trimmedWin), keyBefore, "a burst cut down to its call line keeps its identity");
});

test("an open burst stays open after the window slides under it, and stays findable", () => {
  const first = call();
  const burst = [first, result(), ...Array.from({ length: 60 }, (_, i) => out(i))];
  const gkey = toolGroupStateKey("job1#3", burst);
  state.toolGroupOpen.set(gkey, { open: true, filter: "" });
  const grown = [...burst, ...Array.from({ length: 260 }, (_, i) => out(100 + i))];
  const html = trimmedGroupHtml(windowLines(grown), "job1#3");
  assert.match(html, new RegExp(`data-gstate="job1\\|${first.lid}"`), "the node carries the key the reader's open state lives under");
  assert.equal(hidden(html), false, "and the body is open, not back on the condensed default");
  assert.match(html, new RegExp(`data-gat="${first.lid}"`), "a rebuild reads the same identity back off the node");
});

// ---- the trimmed burst: still a group, with a head row and a fold ---------------------------

test("a burst with no call line is still a group, with a head row that says what it is", () => {
  const lines = [result("terminal"), out(0), out(1), result("terminal"), out(2)];
  const html = trimmedGroupHtml(lines, "job1#3");
  assert.match(html, /^<div class="tgrp" data-copy /, "it is a .tgrp, not bare console lines");
  assert.match(html, /data-gstate="job1\|/, "with the state key the reader's choice is remembered under");
  assert.match(html, /data-gat="/, "and the anchor a rebuild and the 3s sweep aim at");
  assert.match(html, /class="tgrp-head"/, "a head row, which bare lines never had");
  assert.match(html, /data-tgrp-more="job1#3"/, "and a button that folds it");
  assert.match(html, /<span class="tgrp-name">terminal<\/span>/, "the head names the tool the results came from");
  assert.match(html, /class="tgrp-n">trimmed</, "and says the block is a fragment, not the whole run");
  assert.equal(hidden(html), false, "drawn open: what the window dropped is the call, not the output");
});

test("shutting a trimmed burst is remembered, because open is its default", () => {
  const lines = [result(), out(0), out(1)];
  const gkey = toolGroupStateKey("job1#3", lines);
  assert.equal(toolGroupDropsState(false, "", true), false, "a closed group whose default is open is worth remembering");
  assert.equal(toolGroupDropsState(false, "", false), true, "a closed condensed group is the default: nothing to keep");
  assert.equal(toolGroupDropsState(true, "", false), false, "an open one always is");
  assert.equal(toolGroupDropsState(false, "terminal", true), false, "so is a shut one the reader filtered");

  state.toolGroupOpen.set(gkey, { open: false, filter: "" });
  const html = trimmedGroupHtml(lines, "job1#3");
  assert.equal(hidden(html), true, "the next render puts the reader's shut back");
  assert.doesNotMatch(html, /tgrp-more is-open/, "and the button is not drawn as the open one");

  // The reader shutting it is written back through the same rule: still worth keeping, so the delete never runs.
  state.toolGroupOpen.clear();
  const node = { dataset: { gstate: gkey, gdefault: "open" }, querySelector: () => ({ hidden: true }) };
  rememberToolGroup(node);
  assert.deepEqual(state.toolGroupOpen.get(gkey), { open: false, filter: "" }, "a shut trimmed burst stays shut across repaints");
});

test("a flat trimmed piece keeps no head row and no fold", () => {
  const lines = [result(), out(0)];
  const html = trimmedGroupHtml(lines, "job1#f2", "", true);
  assert.match(html, /class="tgrp tgrp-flat"/, "a stream piece is still a piece, so a rebuild can find it");
  assert.doesNotMatch(html, /tgrp-head/, "but nothing is folded in a stream");
  assert.doesNotMatch(html, /data-tgrp-more/, "so there is no button to fold it with");
  assert.equal(hidden(html), false, "and its body is always open");
});
