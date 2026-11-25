// The console's corner grip: one arithmetic, one owner for the height, one release clamp, and the guards that keep
// the box still while the pointer is down.
//
// The gesture itself is a page-level thing (a trusted pointer on a real box in public/app.js), and its gate is
// `tools/verify-console-slow-drag.mjs` for the slow drag the reader reported and `tools/verify-console-resize.mjs`
// for the settled card. What this file carries is the half a layout-free test can hold down:
//
//   the ARITHMETIC   outGripStep (the pointer expressed from the TOP edge the press froze) and outGripRelease (the one
//                    clamp), driven out of `public/app.js` in a VM just as console-height-store.test.js drives the
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

const page = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const appSrc = page("public/app.js");
const jobsSrc = page("public/render-jobs.js");
const consoleSrc = page("public/board/console.js");
const projectsSrc = page("public/render-projects.js");
const css = page("public/style.css");

function grab(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the page still carries ${name}()`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is still a top-level function`);
  return src.slice(start, end + 3);
}

const context = { Math, Number };
vm.createContext(context);
vm.runInContext([grab(appSrc, "outGripStep"), grab(appSrc, "outGripRelease")].join("\n"), context);
const { outGripStep, outGripRelease } = context;

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

test("the clamp is called once, at the release - never on a move", () => {
  assert.equal(
    appSrc.split("outGripRelease(").length - 1,
    2,
    "one definition and one call: a clamp in the move handler is the box stopping while the pointer travels",
  );
  assert.ok(grab(appSrc, "endOutGrip").includes("outGripRelease("), "and the call is the release's");
  assert.equal(appSrc.split("outGripStep(").length - 1, 2, "a step is written in one place too");
});

test("the height is written through the one owner, and a move is the pointer from the frozen top", () => {
  const start = appSrc.indexOf('"pointermove"');
  assert.ok(start > 0, "the move handler is still there");
  const handler = appSrc.slice(start, appSrc.indexOf("function endOutGrip(", start));
  assert.ok(handler.includes("outGripStep(d.top, d.grab, e.clientY / d.z)"), "the press's top edge, not the drawn box, with the pointer in layout px");
  assert.equal(handler.includes("getBoundingClientRect().height"), false, "no second measurement of the height per move");
  assert.ok(handler.includes("setOutHeight(d.out, h)"), "written through the one writer of --out-h");
  assert.equal(/\.out\.style\.height\s*=/.test(appSrc), false, "and never through style.height on the console");
  assert.ok(handler.includes('style.maxHeight = "none"'), "with the sheet's cap lifted off it");
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
  const pressAt = appSrc.indexOf("// The grip's own press.");
  const press = appSrc.slice(pressAt, appSrc.indexOf('"pointermove",', pressAt));
  assert.ok(press.includes('setProperty("overflow-anchor", "none"'), "the press stands the anchor down on the transcript it drags");
  assert.ok(press.includes("bodyTop: scrollport ? scrollport.scrollTop : null"), "and records the offset it must hold");
  const handler = appSrc.slice(appSrc.indexOf('"pointermove"'), appSrc.indexOf("function endOutGrip("));
  assert.ok(handler.includes("setScroll(d.body, d.bodyTop)"), "every move re-asserts the frozen offset");
  assert.ok(grab(appSrc, "endOutGrip").includes('removeProperty("overflow-anchor")'), "the release gives the anchor back");
  // The release does NOT put a following transcript back on its foot: that write is a scroll of exactly the drag's
  // travel, and it is what undid every drag that ever worked.
  const release = grab(appSrc, "endOutGrip");
  assert.equal(/setScroll\(d\.body/.test(release), false, "the release writes no foot");
  assert.ok(release.includes("noteCardBodyScroll(d.body)"), "it records where the drag left the transcript instead");
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
  // number: the gesture, the remembered height a rebuild restores, and the float's slack console drag.
  assert.ok(grab(consoleSrc, "setOutHeight").includes('setProperty("--out-h"'), "the writer, in one place");
  assert.ok(grab(consoleSrc, "applyStoredHeight").includes("setOutHeight(o, h)"), "a rebuilt console restores through it");
  assert.ok(appSrc.includes("setOutHeight(out, r.height / z)") && appSrc.includes("setOutHeight(d.out, h)"), "the press (in layout px) and the release");
  assert.ok(grab(appSrc, "endOutGrip").includes("setOutHeight(d.out, h)"), "the release clamps into the same variable");
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
  assert.ok(grab(appSrc, "endOutGrip").includes("if (d.deferred)"), "the release is what draws them");
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
  vm.runInContext(
    [grab(appSrc, "outGripCap"), grab(appSrc, "outGripCapStyle"), grab(appSrc, "outGripRelease")].join("\n"),
    context,
  );
  return context;
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
  const pressAt = appSrc.indexOf("// The grip's own press.");
  assert.ok(pressAt > 0, "the press handler is still there");
  const press = appSrc.slice(pressAt, appSrc.indexOf('"pointermove",', pressAt));
  assert.ok(press.includes("setPointerCapture(e.pointerId)"), "captured, so a release outside the card still ends it");
  assert.ok(press.includes("e.button !== 0"), "and only the primary button starts a resize");
  assert.ok(press.includes("top: r.top / z"), "the press freezes the box's top edge, in layout px");
  assert.ok(press.includes("grab: (r.bottom - e.clientY) / z"), "and where inside the grip the hand landed, in layout px");
  assert.ok(press.includes("setOutHeight(out, r.height / z)"), "the press pins the height it found, in layout px, through the one writer");
  assert.ok(grab(appSrc, "endOutGrip").includes("d.hadVar"), "which a press that never moved puts back");
});

// ---- the units: a press on a zoomed page is a press, not a resize ------------------------------------------------
test("every length the gesture keeps is a layout length, and the pointer is divided where it enters", () => {
  // The reader's press-only report: a pointerdown with NO movement moved the corner about 50px. The gesture froze the
  // drawn height (a VISUAL rect) and wrote it straight into `--out-h` (a LAYOUT length), so on a page at 90% the box
  // came back at 90% of itself - a resize nobody asked for. The scale is read once and every number is converted at
  // the boundary: the press, the move's pointer, the edge watch's drift, and the release's room.
  assert.ok(grab(appSrc, "outGripZoom").includes("getComputedStyle(document.documentElement).zoom"), "the page's own zoom is the scale");
  const pressAt = appSrc.indexOf("// The grip's own press.");
  const press = appSrc.slice(pressAt, appSrc.indexOf('"pointermove",', pressAt));
  assert.ok(press.includes("const z = outGripZoom()"), "read once, at the press");
  assert.ok(press.includes("z,") && press.includes("from: r.height / z"), "and kept on the gesture record");
  const move = appSrc.slice(appSrc.indexOf('"pointermove"'), appSrc.indexOf("function endOutGrip("));
  assert.ok(move.includes("e.clientY / d.z"), "the move's pointer is divided by it");
  assert.ok(grab(appSrc, "outGripEdgeWatch").includes("getBoundingClientRect().top / d.z"), "so is the edge watch's drift");
  assert.ok(grab(appSrc, "endOutGrip").includes("r.top / d.z"), "and the room the release clamps to");
  assert.equal(
    /setOutHeight\(out, r\.height\)/.test(appSrc),
    false,
    "nothing writes the visual rect back as a layout height",
  );
});
