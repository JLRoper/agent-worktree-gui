// The console's corner grip: one arithmetic, one owner for the height, one release clamp, and the guards that keep
// the box still while the pointer is down.
//
// The gesture itself is a page-level thing (a trusted pointer on a real box in public/app.js), and its gate is
// `tools/verify-console-slow-drag.mjs` for the slow drag the reader reported and `tools/verify-console-resize.mjs`
// for the settled card. What this file carries is the half a layout-free test can hold down:
//
//   the ARITHMETIC   outGripStep (the pointer expressed from the TOP edge the press froze) and outGripRelease (the one
//                    clamp), driven out of `public/core/console-grip.js` in a VM just as console-height-store.test.js
//                    drives the
//                    height store. The old arithmetic - the drawn height plus this move's travel - is what let a
//                    second loop cancel a drag while looking correct in the height alone.
//   the SHAPE        the markup puts the grip in a `.out-box` with the console, the sheet has no `resize` handle left
//                    on `.job-out`, its height resolves through `--out-h`, the grip is a `touch-action: none` 18px
//                    nwse band, and the clamp is called ONCE, on the release
//   the ONE OWNER    every path that sets a console's height calls setOutHeight; nothing writes `style.height` on a
//                    `.job-out`; the transcript's tail pin (JS and the browser's scroll anchor) stands down for the
//                    length of a gesture, by name, in one place each
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { readStyleSheets } from "./style-sheets.js";
import { consoleSource } from "../tools/panel-testkit.mjs";

const page = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const appSrc = page("public/app.js");
const gripSrc = page("public/core/console-grip.js");
const jobsSrc = page("public/render-jobs.js");
const consoleSrc = consoleSource(); // public/board/console.js and its four cuts, in page order
const projectsSrc = page("public/render-projects.js");
const css = readStyleSheets();

// The grip's three top-level functions, taken by name from the module that owns them (public/core/console-grip.js).
// The first cut of this file sliced them out of app.js; the cluster is one file now, so the slice is a plain region
// between two neighbouring declarations and the VM runs the SAME source the page loads.
function gripRegion(from, to) {
  const start = gripSrc.indexOf(from);
  assert.ok(start >= 0, `the module carries ${from}`);
  const end = gripSrc.indexOf(to, start);
  assert.ok(end > start, `${from} is still followed by ${to}`);
  return gripSrc.slice(start, end);
}

// A top-level function of a classic script (public/board/console.js and public/app.js still declare these at column 0).
function grab(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the page still carries ${name}()`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is still a top-level function`);
  return src.slice(start, end + 3);
}

// The module's four regions, by the declaration that opens each and the one that follows it.
const PRESS = gripRegion("function press(e)", "function move(e)");
const MOVE = gripRegion("function move(e)", "function watch(d)");
const END = gripRegion("function end(e)", 'document.addEventListener("pointerdown", press, true)');

const context = { Math, Number, globalThis: undefined };
vm.createContext(context);
context.globalThis = context;
vm.runInContext(gripSrc, context);
const grip = context.wtConsoleGrip;
const { step: outGripStep, limit: outGripLimit, release: outGripRelease } = grip;

// ---- the arithmetic of one move -------------------------------------------------------------------------------
test("a step is the pointer expressed from the top edge the press froze", () => {
  assert.equal(outGripStep(100, 2, 122), 24, "the pointer 22px down a box whose top is at 100, 2px inside the grip");
  assert.equal(outGripStep(100, 2, 102), 4, "still at the press: the same height the box had");
  assert.equal(outGripStep(100, 2, 82), 0, "20px up from a box that was 2px tall is not a height");
  assert.equal(outGripStep("100", "2", "122"), 24, "strings from a rect are still numbers");
  assert.equal(outGripStep(100, 0.5, 130.5), 31, "sub-pixel travel is kept, not rounded away mid-gesture");
});

test("a step never asks for a negative height", () => {
  // A pointer dragged above the box's own top edge asks for less than nothing. That is not a height, and writing it
  // would be ignored by the browser - the box would then stop tracking while the pointer kept going. So it lands on 0
  // and the next move asks again from the same frozen edge.
  assert.equal(outGripStep(200, 0, 190), 0);
  assert.equal(outGripStep(0, 0, 0), 0);
  assert.equal(outGripStep(NaN, 2, 120), 0, "an unmeasurable edge is not a height either");
});

// ---- the one clamp -------------------------------------------------------------------------------------------
test("the release keeps the height the reader reached, inside the sheet's floor and the room", () => {
  assert.equal(outGripRelease(420, 34, 700), 420, "a height inside the band is kept to the pixel");
  assert.equal(outGripRelease(420.6, 34, 700), 421, "and rounded, because it becomes an inline pixel height");
  assert.equal(outGripRelease(500, 34, 400), 400, "a drag past the room stops on the room");
  assert.equal(outGripRelease(10, 34, 700), 34, "a drag past the floor stops on the sheet's min-height");
});

test("a floor with no room above it is the floor", () => {
  assert.equal(outGripRelease(200, 34, 20), 34, "a window smaller than the floor still draws a usable console");
  assert.equal(outGripRelease(200, 34, NaN), 34, "an unreadable room is not licence to draw any height");
  assert.equal(outGripRelease(NaN, 34, 700), 34, "and neither is an unreadable height");
  assert.equal(outGripRelease(200, NaN, 700), 200, "a sheet with no floor of its own clamps only at the top");
});

// ---- the shape the page ships --------------------------------------------------------------------------------
test("the console carries the grip in a box of its own, under the <pre>", () => {
  const at = jobsSrc.indexOf("${outGripHtml()}");
  assert.ok(at > jobsSrc.indexOf("</pre>"), "the grip is drawn after the console closes");
  const between = jobsSrc.slice(jobsSrc.lastIndexOf("`<div class=\"out-wrap", at), at);
  assert.ok(between.includes('<div class="out-box">'), "inside a box that holds exactly the console");
  const afterGrip = jobsSrc.slice(at, jobsSrc.indexOf("${marchRowHtml(turn)}"));
  assert.ok(afterGrip.includes("</div>"), "the box closes after the grip, so that row cannot move the corner");
  assert.match(jobsSrc, /\$\{marchRowHtml\(turn\)\}/, "the marching tail is still drawn by the same one place");
  const tail = jobsSrc.indexOf("${marchRowHtml(turn)}");
  assert.ok(tail > at, "and it is a SIBLING of the box, in the text flow, not pinned over the console");
});

test("the grip is a touch-action: none nwse band, and the console has no native resize left", () => {
  assert.match(consoleSrc, /data-out-grip="1"/, "the markup the gesture is delegated to");
  const rule = css.match(/\.out-box > \.out-grip \{[^}]*\}/);
  assert.ok(rule, "the sheet still draws the grip");
  for (const want of ["touch-action: none", "cursor: nwse-resize", "width: 18px", "height: 18px"]) {
    assert.ok(rule[0].includes(want), `the grip carries ${want}`);
  }
  const consoleRule = css.match(/\n\.job-out \{[^}]*\}/);
  assert.ok(consoleRule, "the console's own rule is still there");
  assert.equal(consoleRule[0].includes("resize:"), false, "and it no longer asks the browser for a resize handle");
});

test("the limit is ONE function, applied by every move and again by the release", () => {
  // The bounce this ended: the move ran free and the release clamped to the room, so a past-room drag drew a height
  // the pointerup took back (120px). Now the move holds the box to the same band, so the release's call returns the
  // height already on the box. A second arithmetic is how the two came to disagree; a clamp that never ran on a move
  // is how the corner came to show a size it would lose. The module is the only copy: one `limit` definition, one
  // `release` that delegates to it, and one move that holds the box to it.
  assert.equal(gripSrc.split("function limit(").length - 1, 1, "one clamp definition, in the module");
  assert.equal(gripSrc.split("function release(").length - 1, 1, "one release, and it is the same arithmetic");
  assert.ok(gripRegion("function release(", "function capOf(").includes("limit(h, min, room)"), "the release IS the limit, not a second arithmetic");
  assert.ok(MOVE.includes("limit(want, d.min, d.room)"), "the move stops the box on the floor and the room under the frozen top");
  assert.ok(MOVE.includes("d.want = want"), "and keeps the pointer's own request for the gates to judge the corner by");
  assert.equal(gripSrc.split("function step(").length - 1, 1, "a step is written in one place too");
  assert.equal(gripSrc.split("step(d.top, d.grab, e.clientY / d.z)").length - 1, 1, "and called once, from the move");
  // app.js keeps only the wiring: one install() and the four predicates the rest of the page asks by name.
  assert.equal(appSrc.split("wtConsoleGrip.install(").length - 1, 1, "the page installs the module once");
  for (const name of ["outDragging", "outGripHoldsCard", "outGripLive", "outGripDefer"]) {
    assert.ok(grab(appSrc, name).includes("consoleGrip."), `${name} delegates to the module`);
  }
});

// ---- the one band: the fix this landing carries ---------------------------------------------------------------
test("the band divides the pane and the viewport by the same zoom", () => {
  // The defect, in one assertion. The old room was `innerHeight - top / zoom - 8`: the viewport's height was taken
  // VISUAL and the top edge LAYOUT, so a box whose frozen top was at 300 visual px stopped at
  //   100%: 900 - 300 - 8            = 592  (the edge, by luck)
  //    90%: 900 - 300/0.9 - 8        = 558.6 visual  - 10% of the screen short of the 892px pane bottom
  //   110%: 900 - 300/1.1 - 8        = 619.3 layout - 89px past the bottom
  // The band takes both edges in visual px and divides both by the same scale.
  const at = (z) => grip.band({ top: 300 / z, z, floor: 18, paneBottom: 892, viewport: 900 });
  for (const z of [1, 0.9, 1.1]) {
    const b = at(z);
    const visualBottom = (300 / z + b.room) * z;
    assert.ok(Math.abs(visualBottom - (892 - 8 * z)) < 0.001, `the box's bottom lands on the pane edge minus the gap at ${z * 100}%`);
    assert.equal(b.edge, "pane", `the pane is the nearer edge at ${z * 100}%`);
  }
  // The two old numbers, now the two edges the band keeps beside the answer: at 90% the pane room is 10% larger than
  // the old subtraction, and at 110% it is 10% smaller - the asymmetry the reader felt as a stop that "just stops".
  assert.equal(at(0.9).room, at(0.9).paneRoom, "the room is the nearer edge");
  assert.ok(at(0.9).paneRoom < at(0.9).viewRoom, "the pane is nearer than the viewport at 90%");
  assert.ok(at(0.9).room > 558.6, "90% gets its tenth back");
  assert.ok(at(1.1).room < 619.3, "110% no longer draws past the bottom");
  // No pane (a card on the board) leaves the viewport as the only edge; the floor is always the floor.
  const board = grip.band({ top: 300, z: 1, floor: 34, paneBottom: null, viewport: 900 });
  assert.equal(board.edge, "viewport");
  assert.equal(board.room, 592);
  assert.equal(grip.band({ top: 880, z: 1, floor: 34, paneBottom: null, viewport: 900 }).room, 34, "a top below the floor's room is the floor");
  assert.equal(grip.band({ top: 300, z: 1, floor: 34, paneBottom: null, viewport: NaN }).room, 34, "an unreadable viewport is not licence to draw any height");
});

test("a limit clamped on a move is the height the release would keep", () => {
  // The band, driven as the page drives it: the same height, floor and room answer the same number whether the move
  // asks or the release does - including the rounding, because the writer rounds to an inline pixel.
  for (const [h, min, max] of [
    [892, 18, 772],
    [772, 18, 772],
    [420.6, 18, 772],
    [4, 18, 772],
    [900, 18, 0],
  ]) {
    assert.equal(outGripLimit(h, min, max), outGripRelease(h, min, max), `${h}px inside [${min}, ${max}]`);
  }
  assert.equal(outGripLimit(892, 18, 772), 772, "a past-room move stops on the room");
  assert.equal(outGripLimit(420.6, 18, 772), 421, "and a height inside the band is kept, rounded once");
});

test("the height is written through the one owner, and a move is the pointer from the frozen top", () => {
  assert.ok(MOVE.includes("step(d.top, d.grab, e.clientY / d.z)"), "the press's top edge, not the drawn box, with the pointer in layout px");
  assert.equal(MOVE.includes("getBoundingClientRect().height"), false, "no second measurement of the height per move");
  assert.ok(MOVE.includes("hooks.setHeight(d.out, h)"), "written through the one writer of --out-h, handed in by app.js");
  assert.ok(appSrc.includes("setHeight: (out, px) => setOutHeight(out, px)"), "and that writer is setOutHeight");
  assert.equal(/\.out\.style\.height\s*=/.test(appSrc) || /\.out\.style\.height\s*=/.test(gripSrc), false, "never through style.height on the console");
  assert.ok(MOVE.includes('style.maxHeight = "none"'), "with the sheet's cap lifted off it");
});

test("the sheet resolves the console's height from the variable, and the gesture owns the transcript's offset", () => {
  const rule = css.match(/\n\.job-out \{[^}]*\}/);
  assert.ok(rule, "the console's own rule");
  assert.ok(rule[0].includes("height: var(--out-h, auto)"), "the height is the variable, with the sheet's auto as the fallback");
  // The anchor used to be left ON for a gesture, for the place it holds when a row lands above. Measured on the live
  // panel it is the SECOND writer of the frozen edge: at the foot its compensation for a taller box is a scrollTop
  // write of exactly the height the drag added (slow@1600/140 wrote 60 and moved the corner 0; the same shape at 820
  // followed, because the anchor had picked a node above the box). So the press stands it down on the transcript it is
  // dragging, and the release puts it back - and the offset is re-asserted, which also carries a drag that dips below
  // the transcript's floor back to the edge the press froze.
  assert.equal(
    /body\.is-out-gripping[^{]*\{[^}]*overflow-anchor/.test(css),
    false,
    "no overflow-anchor: none for the whole page - only the transcript the gesture is dragging loses it",
  );
  assert.ok(PRESS.includes('setProperty("overflow-anchor", "none"'), "the press stands the anchor down on the transcript it drags");
  assert.ok(PRESS.includes("bodyTop: scrollport ? scrollport.scrollTop : null"), "and records the offset it must hold");
  assert.ok(MOVE.includes("hooks.setScroll(d.body, d.bodyTop)"), "every move re-asserts the frozen offset");
  assert.ok(END.includes('removeProperty("overflow-anchor")'), "the release gives the anchor back");
  // The release does NOT put a following transcript back on its foot: that write is a scroll of exactly the drag's
  // travel, and it is what undid every drag that ever worked.
  assert.equal(/hooks\.setScroll\(d\.body/.test(END), false, "the release writes no foot");
  assert.ok(
    END.includes("hooks.noteScroll(d.body, 0)"),
    "it records where the drag left the transcript, with no 8px tail band: the gap is the drag's own, and the band let the release's repaint scroll it away",
  );
});

test("the chat pane's own pin and in-place paints defer to the gesture", () => {
  const assistant = page("public/assistant.js");
  // pinChatToBottom is a function of the float's own closure, not a page-level one, so it is sliced from its opening
  // line to the frame it schedules.
  const pinAt = assistant.indexOf("function pinChatToBottom(");
  assert.ok(pinAt > 0, "the pane's pin is still there");
  const pin = assistant.slice(pinAt, assistant.indexOf("function toggleAssistant(", pinAt));
  assert.ok(pin.includes("cardBodyHeld(body)"), "the pane's pin asks the gesture");
  assert.ok(pin.includes("body._atBottom === false"), "and respects a transcript a resize left off its foot");
  assert.ok(assistant.includes("globalThis.outGripHoldsCard?.(host)"), "the chat rebuild holds off a card under the hand");
  assert.ok(jobsSrc.includes('outGripHoldsCard?.(el)'), "so does the in-place head paint");
});

test("a console the reader has sized is drawn at its number, not grown into the pane's spare room", () => {
  // `.turn.is-slack`'s `flex: 1 1 auto` grew a console into whatever room the pane had left: a 20px height in a short
  // transcript drew 105.41px, and a drag to the floor stopped 105px above it.
  const rule = css.match(/\.job-out\[style\*="--out-h"\] \{[^}]*\}/);
  assert.ok(rule, "the sized console has its own flex rule");
  assert.ok(rule[0].includes("flex: 0 0 auto"), "and it does not grow into the slack");
});

test("one writer: no path sets a console's height except setOutHeight", () => {
  // setOutHeight is the only place that writes the variable, and the three callers are the three paths that own the
  // number: the gesture, the remembered height a rebuild restores, and the float's slack console drag. The gesture's
  // two calls are `hooks.setHeight`, handed in once by app.js's install().
  assert.ok(grab(consoleSrc, "setOutHeight").includes('setProperty("--out-h"'), "the writer, in one place");
  assert.ok(grab(consoleSrc, "applyStoredHeight").includes("setOutHeight(o, h)"), "a rebuilt console restores through it");
  assert.ok(PRESS.includes("hooks.setHeight(out, r.height / z)") && END.includes("hooks.setHeight(d.out, h)"), "the press (in layout px) and the release");
  assert.ok(appSrc.includes("setHeight: (out, px) => setOutHeight(out, px)"), "and the hook is the same writer");
  assert.equal(/cons\.style\.height\s*=/.test(page("public/assistant.js")), false, "the float's console drag goes through it too");
});

// ---- the guards ----------------------------------------------------------------------------------------------
test("the writers that would move a console ask the gesture first", () => {
  assert.ok(grab(consoleSrc, "applyStoredHeight").includes("globalThis.consoleHeld?.(o)"), "a stored height is not written over a live drag");
  assert.ok(grab(consoleSrc, "syncStreamConsole").includes("globalThis.consoleHeld?.(out)"), "and the text is not rebuilt under it");
  assert.ok(grab(consoleSrc, "paintStreamConsole").includes("globalThis.consoleHeld?.(out)"), "not even its markup built");
  assert.ok(grab(consoleSrc, "drawJobLine").includes("!globalThis.consoleHeld?.(out)"), "nor is it re-pinned by a line arriving");
  assert.ok(
    /if \(outDragging\(pre\)\) continue;|if \(!outDragging\(pre\)\) stickConsole\(pre\);/.test(appSrc),
    "the 400ms sweep leaves the box to the pointer",
  );
});

test("the rebuild paths that would replace the node defer to the release", () => {
  assert.ok(grab(appSrc, "renderAll").includes("outGripLive()"), "the board-wide rebuild");
  assert.ok(grab(jobsSrc, "renderJobs").includes("globalThis.outGripLive?.()"), "the unattached list's wholesale rebuild");
  assert.ok(grab(jobsSrc, "renderConversation").includes("globalThis.outGripHoldsCard?.(el)"), "and the one card a console lives in");
  assert.ok(grab(projectsSrc, "renderProjectRows").includes("outGripLive()"), "and a project's rows");
  assert.ok(END.includes("if (d.deferred)"), "the release is what draws them");
});

// ---- the cap the second drag needs, and the fold flush under the pointer -------------------------------------
// Report 4.3, second half: the press read `parseFloat(cs.maxHeight)`, and one drag past the cap leaves
// `max-height: none` inline - which parses to NaN. Every later press then took the release's "no cap" branch, so the
// sheet's cap was never re-applied to that node, even after the reader dragged back under it. The gate drags once per
// case, so it cannot see this; this is the two-drag case it never had.
function gripCapPage() {
  const context = vm.createContext({
    Math,
    Number,
    // The browser's own rule: an inline max-height wins over the sheet's.
    getComputedStyle: (el) => ({ maxHeight: el.style.maxHeight || el.sheetCap || "" }),
  });
  context.globalThis = context;
  vm.runInContext(gripSrc, context);
  const api = context.wtConsoleGrip;
  return {
    outGripCap: api.capOf,
    outGripCapStyle: api.capStyle,
    outGripRelease: api.release,
    getComputedStyle: context.getComputedStyle,
  };
}

test("a second drag on a box the first one took past the cap still knows the sheet's cap", () => {
  const page = gripCapPage();
  const box = { sheetCap: "320px", style: { maxHeight: "" } };
  const press = () => page.outGripCap(box, page.getComputedStyle(box));

  const first = press();
  assert.equal(first, 320, "the first press reads the pane's cap off the sheet");
  box.style.maxHeight = "none"; // what the press writes before the pointer moves
  const one = page.outGripRelease(420, 18, Math.max(first, 700));
  box.style.maxHeight = page.outGripCapStyle(first, one);
  assert.equal(one, 420, "the first drag keeps the height it reached, past the cap");
  assert.equal(box.style.maxHeight, "none", "with the cap lifted off it");

  const second = press();
  assert.equal(second, 320, "the second press still knows the sheet's cap: 'none' inline is not a cap of NaN");
  const two = page.outGripRelease(260, 18, Math.max(second, 700));
  box.style.maxHeight = page.outGripCapStyle(second, two);
  assert.equal(two, 260, "the second drag keeps the height it chose");
  assert.equal(box.style.maxHeight, "", "and the sheet's cap is back on the box, because 260 is under it");
  assert.equal(page.outGripCapStyle(NaN, 300), "none", "a pane with no cap of its own (the docked chat) still lifts it");
});

// Report 4.4: cmdFoldResize watches every console (wireConsole observes each one), so EVERY height write of the corner
// gesture fires the observer, whose flush rewrites the text nodes of every command card inside the box being dragged.
// That is the "text rebuilt under the pointer" the gesture forbids, in the frame after the write - and the flush asked
// nobody whether a gesture was live. The gate counted 0 childList mutations in every case because it drags a console
// with no command card in it, so there was nothing there to prove.
function foldFlush(pending, heldOut) {
  const painted = [];
  const context = vm.createContext({
    consoleHeld: (out) => out === heldOut,
    paintCommandFoldMark: (box) => painted.push(box.name),
    requestAnimationFrame: () => 7,
  });
  context.cmdFoldPending = new Set(pending);
  context.cmdFoldFrame = 0;
  vm.runInContext([grab(consoleSrc, "flushCommandFoldMarks"), grab(consoleSrc, "armCommandFoldFrame")].join("\n"), context);
  vm.runInContext("flushCommandFoldMarks()", context);
  return { painted, context };
}

test("a command-card fold flush under the pointer waits for the release instead of rewriting the card", () => {
  const heldOut = { name: "the console being dragged" };
  const held = { name: "held", isConnected: true, closest: (sel) => (sel === "pre.job-out" ? heldOut : null) };
  const free = { name: "free", isConnected: true, closest: () => null };

  const { painted, context } = foldFlush([free, held], heldOut);

  assert.deepEqual(painted, ["free"], "the card outside the dragged console is marked; the one inside it is not rewritten");
  assert.equal(vm.runInContext("[...cmdFoldPending].length", context), 1, "the held card is still pending");
  assert.equal(vm.runInContext("[...cmdFoldPending][0]", context), held, "exactly the card the gesture holds");
  assert.equal(vm.runInContext("cmdFoldFrame", context), 7, "and it is re-armed for the next frame, not dropped");
  assert.ok(grab(consoleSrc, "armCommandFoldFrame").includes("flushCommandFoldMarks"), "the observer's frame runs the gated flush");
  assert.ok(grab(consoleSrc, "scheduleCommandFoldMark").includes("armCommandFoldFrame()"), "and the observer schedules through it");
  assert.ok(grab(consoleSrc, "paintCommandFoldMark").includes("consoleHeld"), "and the painter asks the gesture itself, so no call site can slip past");
});

test("the gesture hands its own pointer the whole way", () => {
  assert.ok(PRESS.includes("setPointerCapture(e.pointerId)"), "captured, so a release outside the card still ends it");
  assert.ok(PRESS.includes("e.button !== 0"), "and only the primary button starts a resize");
  assert.ok(PRESS.includes("top: r.top / z"), "the press freezes the box's top edge, in layout px");
  assert.ok(PRESS.includes("grab: (r.bottom - e.clientY) / z"), "and where inside the grip the hand landed, in layout px");
  assert.ok(PRESS.includes("hooks.setHeight(out, r.height / z)"), "the press pins the height it found, in layout px, through the one writer");
  assert.ok(END.includes("d.hadVar"), "which a press that never moved puts back");
});

// ---- the units: a press on a zoomed page is a press, not a resize ------------------------------------------------
test("every length the gesture keeps is a layout length, and the pointer is divided where it enters", () => {
  // The reader's press-only report: a pointerdown with NO movement moved the corner about 50px. The gesture froze the
  // drawn height (a VISUAL rect) and wrote it straight into `--out-h` (a LAYOUT length), so on a page at 90% the box
  // came back at 90% of itself - a resize nobody asked for. The scale is read once and every number is converted at
  // the boundary: the press, the move's pointer, the edge watch's drift, and the release's room.
  assert.ok(gripSrc.includes("getComputedStyle(document.documentElement).zoom"), "the page's own zoom is the scale");
  assert.ok(PRESS.includes("const z = zoom()"), "read once, at the press");
  assert.ok(PRESS.includes("z,") && PRESS.includes("from: r.height / z"), "and kept on the gesture record");
  assert.ok(MOVE.includes("e.clientY / d.z"), "the move's pointer is divided by it");
  assert.ok(gripRegion("function watch(d)", "function end(e)").includes("getBoundingClientRect().top / d.z"), "so is the edge watch's drift");
  // THE ROOM'S UNIT MIX, the defect this landing is for: `innerHeight - r.top / z` took a VISUAL viewport height and a
  // LAYOUT top edge, so at 90% the box stopped a tenth of the viewport short and at 110% it drew past the screen. The
  // band divides BOTH the pane's bottom and the viewport by the same scale, and the one arithmetic is asserted here
  // rather than the shape of a subtraction.
  assert.ok(PRESS.includes("paneBottom: scrollport ? scrollport.getBoundingClientRect().bottom : null"), "the pane's own bottom is read at the press");
  assert.ok(PRESS.includes("viewport: window.innerHeight"), "beside the viewport's");
  assert.ok(gripSrc.includes("paneBottom") && gripSrc.includes("/ z - top - gap"), "and both are divided by the zoom in the one band");
  assert.ok(PRESS.includes("edge: bounds.edge"), "the edge that stopped it is named on the record");
  assert.ok(END.includes("one(d.h, d.min, d.room)"), "which the release clamps to, not a fresh read");
  assert.equal(
    /setOutHeight\(out, r\.height\)/.test(appSrc) || /setOutHeight\(out, r\.height\)/.test(gripSrc),
    false,
    "nothing writes the visual rect back as a layout height",
  );
});
