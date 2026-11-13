// The console's corner grip: one arithmetic, one release clamp, and the guards that keep the box still while the
// pointer is down.
//
// The gesture itself is a page-level thing (a trusted pointer on a real box in public/app.js), and its gate is
// `tools/verify-console-resize.mjs`: ten 20px moves each way with the grip's box held to the cursor. What this file
// carries is the half a layout-free test can hold down:
//
//   the ARITHMETIC   outGripStep (the live rect plus the pointer's travel) and outGripRelease (the one clamp), driven
//                    out of `public/app.js` in a VM just as console-height-store.test.js drives the height store
//   the SHAPE        the markup puts the grip in a `.out-box` with the console, the sheet has no `resize` handle left
//                    on `.job-out`, the grip is a `touch-action: none` 18px nwse band, and the clamp is called ONCE,
//                    on the release - a clamp on every move is the box stopping while the pointer keeps going
//   the GUARDS       every path that could rebuild, re-pin or re-measure the console while the gesture runs asks the
//                    gesture first, by name. Deleting one of these is a box that jumps under the reader's hand, and it
//                    has to be a red test rather than a walk through the page.
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
test("a step is the box the sheet drew plus the pointer's own travel", () => {
  assert.equal(outGripStep(230, -20), 210, "20px up from a 230px box");
  assert.equal(outGripStep(210, -20), 190, "and again, from the box that is now on the page");
  assert.equal(outGripStep(230, 20), 250, "20px down is 20px more console");
  assert.equal(outGripStep("320", -20), 300, "a measured rect given as a string is still a number");
  assert.equal(outGripStep(27.5, 0.5), 28, "sub-pixel travel is kept, not rounded away mid-gesture");
});

test("a step never asks for a negative height", () => {
  // A pointer dragged above the box's own top edge asks for less than nothing. That is not a height, and writing it
  // would be ignored by the browser - the box would then stop tracking while the pointer kept going. So it lands on 0
  // and the next move measures the drawn box again.
  assert.equal(outGripStep(12, -40), 0);
  assert.equal(outGripStep(0, 0), 0);
  assert.equal(outGripStep(NaN, -20), 0, "an unmeasurable box is not a height either");
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

test("every move measures the box that is on the page", () => {
  const start = appSrc.indexOf('"pointermove"');
  assert.ok(start > 0, "the move handler is still there");
  const handler = appSrc.slice(start, appSrc.indexOf("function endOutGrip(", start));
  assert.ok(handler.includes("getBoundingClientRect().height"), "the live rect, not a number remembered from the press");
  assert.ok(handler.includes("outGripStep(drawn, e.clientY - d.y)"), "and the pointer's own travel against it");
  assert.ok(handler.includes('style.height = `${h}px`'), "an explicit pixel height");
  assert.ok(handler.includes('style.maxHeight = "none"'), "with the sheet's cap lifted off it");
});

// ---- the guards ----------------------------------------------------------------------------------------------
test("the writers that would move a console ask the gesture first", () => {
  assert.ok(grab(consoleSrc, "applyStoredHeight").includes("globalThis.consoleHeld?.(o)"), "a stored height is not written over a live drag");
  assert.ok(grab(consoleSrc, "syncStreamConsole").includes("globalThis.consoleHeld?.(out)"), "and the text is not rebuilt under it");
  assert.ok(grab(consoleSrc, "paintStreamConsole").includes("globalThis.consoleHeld?.(out)"), "not even its markup built");
  assert.ok(grab(consoleSrc, "drawJobLine").includes("!globalThis.consoleHeld?.(out)"), "nor is it re-pinned by a line arriving");
  assert.ok(appSrc.includes("if (!outDragging(pre)) stickConsole(pre);"), "the 400ms sweep leaves the box to the pointer");
});

test("the rebuild paths that would replace the node defer to the release", () => {
  assert.ok(grab(appSrc, "renderAll").includes("outGripLive()"), "the board-wide rebuild");
  assert.ok(grab(jobsSrc, "renderJobs").includes("globalThis.outGripLive?.()"), "the unattached list's wholesale rebuild");
  assert.ok(grab(jobsSrc, "renderConversation").includes("globalThis.outGripHoldsCard?.(el)"), "and the one card a console lives in");
  assert.ok(grab(projectsSrc, "renderProjectRows").includes("outGripLive()"), "and a project's rows");
  assert.ok(grab(appSrc, "endOutGrip").includes("if (d.deferred) renderAll();"), "the release is what draws them");
});

test("the gesture hands its own pointer the whole way", () => {
  const pressAt = appSrc.indexOf("// The grip's own press.");
  assert.ok(pressAt > 0, "the press handler is still there");
  const press = appSrc.slice(pressAt, appSrc.indexOf('"pointermove",', pressAt));
  assert.ok(press.includes("setPointerCapture(e.pointerId)"), "captured, so a release outside the card still ends it");
  assert.ok(press.includes("e.button !== 0"), "and only the primary button starts a resize");
  assert.ok(press.includes('style.height = `${r.height}px`'), "the press pins the height it found");
  assert.ok(grab(appSrc, "endOutGrip").includes("d.styleHeight"), "which a press that never moved puts back");
});
