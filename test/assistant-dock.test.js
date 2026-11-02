import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const cssRaw = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, ""); // the prose explains the rules the dock no longer needs
const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const code = assistant.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// The assistant is a docked column, not a floating window: it takes layout width beside the board, so there is no
// overlay left to cover anything with. These guard the three properties that makes true — the frame, the chrome
// that went with the window, and the one number it remembers — plus the clamp, which is the only arithmetic in it.

test("the assistant is a docked column, not a floating window", () => {
  const rule = css.match(/\n\.assistant \{([^}]*)\}/);
  assert.ok(rule, "no .assistant rule");
  assert.doesNotMatch(rule[1], /position:\s*fixed/, "a fixed rail covers the board — the whole point of the dock");
  assert.match(rule[1], /position:\s*sticky/, "the rail stays put while the board scrolls under it");
  assert.match(rule[1], /flex:\s*0 0 auto/, "the rail must take layout width, not overlay the board");
  assert.doesNotMatch(rule[1], /min-width|max-width/,
    "a CSS cap smaller than the JS clamp makes the rail stop while the pointer keeps moving — the measured bug");
  // The board is laid out BESIDE it, in one row, and the row wraps so the footer can be its last line.
  assert.match(css, /\.shell \{ display: flex; flex-wrap: wrap; align-items: flex-start; \}/);
  assert.match(css, /\.shell > main \{ flex: 1 1 0; min-width: 0; \}/,
    "a basis of `auto` makes the wrap decision on the board's content width and pushes the rail onto its own line");
  assert.match(css, /\.shell > \.foot \{ flex: 1 0 100%; \}/,
    "the footer is the row's last line, and it is what makes the rail's sticky box reach the bottom of the page");
  // The rail is in the row, not before it.
  const shell = html.slice(html.indexOf('<div class="shell">'), html.indexOf("</footer>"));
  assert.ok(shell.includes('<main>') && shell.includes('<aside id="assistant"'), "main and the rail share the row");
  assert.ok(shell.indexOf("<main>") < shell.indexOf('<aside id="assistant"'), "the board comes first, the rail after it");
});

test("the window chrome is gone: no drag head, no grips, no maximize, no pin", () => {
  assert.doesNotMatch(html, /id="as-drag"/, "the drag head is gone");
  assert.doesNotMatch(html, /as-grips|data-dir=/, "the eight grabs are gone");
  assert.doesNotMatch(html, /btn-as-max|btn-as-pin/, "maximize and pin are gone");
  assert.doesNotMatch(css, /\.as-grip|\.as-full|\.is-pinned|#btn-as-max|#btn-as-pin/);
  assert.doesNotMatch(code, /assistantRect|RECT_KEY|assistantFull|assistantPinned|setAssistantFull|onOutsidePress/,
    "the saved rect, the fullscreen mode, the pin and the outside-press close are all gone");
  // One grab is left, and it is the edge the rail shares with the board.
  assert.equal((html.match(/id="as-split"/g) || []).length, 1);
  assert.match(css, /\.as-split \{[^}]*cursor: ew-resize/, "the rail's edge is the one thing that resizes it");
  assert.match(css, /\.as-split \{[^}]*touch-action: none/, "a touch drag on the edge must resize, not scroll the board");
});

test("one close toggle, and the topbar button is the other way in", () => {
  assert.equal((html.match(/id="btn-as-close"/g) || []).length, 1, "exactly one close toggle");
  assert.match(html, /id="btn-assistant"/, "the topbar's Assistant button is still the way in");
  assert.match(code, /as\$\("btn-as-close"\)\?\.addEventListener\("click", \(\) => toggleAssistant\(false\)\)/);
  assert.match(code, /as\$\("btn-assistant"\)\?\.classList\.toggle\("is-on"/);
});

test("the width is remembered, not a rect", () => {
  assert.match(code, /const DOCK_KEY = "wm\.assistantWidth"/);
  assert.match(code, /localStorage\.setItem\(DOCK_KEY, String\(Math\.round\(w\)\)\)/);
  assert.match(code, /state\.assistantWidth = state\.assistantWidth \?\? readDockWidth\(\)/);
  assert.doesNotMatch(code, /JSON\.parse\(localStorage\.getItem\(DOCK_KEY/,
    "a width is one number, not a rect to parse");
});

test("the width is clamped to 340-640px and to 60% of the window", () => {
  // The band is read out of the source rather than restated here, so a change to it has to change this test.
  const band = Object.fromEntries(
    [...assistant.matchAll(/const (DOCK_(?:MIN|MAX|SHARE|DEFAULT)) = ([0-9.]+);/g)].map((m) => [m[1], Number(m[2])]),
  );
  assert.deepEqual(band, { DOCK_MIN: 340, DOCK_MAX: 640, DOCK_SHARE: 0.6, DOCK_DEFAULT: 480 });
  const clamp = new Function(
    "DOCK_MIN", "DOCK_MAX", "DOCK_SHARE", "DOCK_DEFAULT",
    `${sliceRegion(assistant, "dock width", "dock width")}; return clampDockWidth;`,
  )(band.DOCK_MIN, band.DOCK_MAX, band.DOCK_SHARE, band.DOCK_DEFAULT);
  // The ordinary case: the reader's number, inside the band.
  assert.equal(clamp(480, 1247, 1), 480);
  assert.equal(clamp(340, 1247, 1), 340);
  assert.equal(clamp(640, 1247, 1), 640);
  // Past either end of the band.
  assert.equal(clamp(200, 1247, 1), 340, "a narrower width than the floor is the floor");
  assert.equal(clamp(900, 1247, 1), 640, "a wider width than the cap is the cap");
  // 60% of the window, when that is the smaller limit: 800 * 0.6 = 480.
  assert.equal(clamp(900, 800, 1), 480);
  // A window too narrow for the floor: the cap wins, because the board keeping the majority of the row is the rule
  // the floor serves.
  assert.equal(clamp(900, 500, 1), 300);
  // The cap is measured in the layout px the width is stored in, so a zoomed page cannot hand the rail more of the
  // window than it would at 100%: 1247 client px at 1.3 zoom is 959 layout px, 60% of which is 575.
  assert.equal(clamp(900, 1247, 1.3), 575);
  // Nothing remembered, or nonsense remembered: the default, clamped.
  assert.equal(clamp(null, 1247, 1), 480);
  assert.equal(clamp("nonsense", 1247, 1), 480);
  assert.equal(clamp(0, 1247, 1), 480);
});

test("the rail is measured against the window, and the topbar is measured rather than assumed", () => {
  assert.match(code, /function viewportBox\(\)/, "the rail's height must read the viewport itself");
  assert.match(code, /clientWidth[\s\S]{0,80}clientHeight/, "and read the LAYOUT viewport");
  assert.doesNotMatch(code, /visualViewport/,
    "visualViewport excludes the classic scrollbar, so a rail sized against it is narrower than its row");
  assert.match(code, /document\.querySelector\("\.topbar"\)\?\.getBoundingClientRect\(\)\.height/,
    "the topbar wraps to a second row on a narrow window: its height is measured, not assumed");
  assert.match(code, /new ResizeObserver\(/, "and followed when it changes");
  assert.match(code, /shell\.style\.minHeight = cssPx\(h, z\)/,
    "the row must be at least as tall as the rail, or sticky runs out of containing block at the end of a short board");
});

test("room the rail gains goes into the open turn's console, not into blank panel", () => {
  assert.match(code, /classList\.toggle\("is-slack"/, "assistant.js must mark the turn that takes the room");
  assert.match(code, /openNewestTurn\(\)/, "a resize with every turn folded must open the newest");
  // The two rules have equal specificity with the `flex: 0 0 auto` set, so order is the whole mechanism.
  const zeroIndex = css.lastIndexOf("> .turn:not(.folded) .job-out { max-height: none; flex: 0 0 auto;");
  const slackIndex = css.lastIndexOf("> .turn.is-slack { flex: 1 1 auto; }");
  assert.ok(zeroIndex > 0 && slackIndex > zeroIndex, "the .is-slack flex rules must come AFTER the flex: 0 0 auto set");
  assert.match(css, /\.job-body:has\(> \.turn\.is-slack\)::before \{ content: none; \}/,
    "the spacer above the turns must stand down when a turn can take the room");
});
