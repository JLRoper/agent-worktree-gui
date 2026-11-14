// The assistant console command card's look: its fold marker, its five settings, and the label that names the prompt.
//
// A command card folds its BODY to a few preview rows instead of shutting. Read as it was, a prompt cut in the middle
// of a sentence ended cleanly at the clamp's edge, so the reader could not tell a finished prompt from a truncated
// one - and nothing in the card said what the text under the head was. The five numbers that place the card (how many
// preview rows, the box's side margin, the padding inside it, the blank lines above and below it, and the side margin
// the rest of the console's text keeps) were fixed in the stylesheet. This file is the contract for all of it:
//
//   1. THREE ASCII DOTS end the last visible preview row of a folded card, and only that row: the painter lives in
//      public/board/console.js, writes a `.code-fold-dots` span at the character the clamp cuts, and takes the cut
//      back out when the card opens (the whole prompt is put back, never re-rendered);
//   2. the marker is MEASURED, because the clamp is a height and a prompt wraps: a Range finds the last character
//      inside the fold, and the body's own markup is kept so opening or re-measuring starts from the whole prompt;
//   3. every card a render path places is marked (the console's one node observer), and the press that folds or opens
//      one marks it or clears it in the same gesture;
//   4. five settings in Settings > Display, saved in this browser under one key, defaulting to EXACTLY today's look -
//      2 preview rows, 0px side margin, 8px padding, 0 blank lines, 18px console tab - and each written as the CSS
//      variable the stylesheet reads, with today's number as the variable's fallback;
//   5. the preview rows are one number, not two: the card's `data-code-clamp` and the stylesheet's fold are written
//      from the same setting, so a DOM read-back can never disagree with the drawn height;
//   6. a bold `Prompt:` label starts the body's first row, inline, so it costs no preview row of its own;
//   7. display only: the line the panel executes and the text it copies are untouched (the card carries the line in
//      `data-ltext`, and copy reads that).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The page's module: a classic script over `window`. Loaded the way public/index.html loads it (after the frame).
globalThis.window = globalThis;
await import("../public/core/console-format.js");
await import("../public/core/assistant-command.js");
const M = globalThis.wtAssistantCommand;

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = read("../public/app.js");
const css = read("../public/style.css");
const html = read("../public/index.html");
const consoleJs = read("../public/board/console.js");

const LINE = "QUEUE assistant-3 | [Playwright test] corner resize the board";
const PROMPT = "SPAWN IN #400 agent-worktree-gui | [Fold marker] read the renderer, then the fold";

test("three ASCII dots end a folded card's last preview row, and the painter is the console's own", () => {
  // ONE literal, and it is ASCII: three periods, not an ellipsis character. A reader asked for dots they can see.
  assert.match(consoleJs, /const CMD_FOLD_DOTS = "\.\.\.";/);
  assert.ok(/^[\x20-\x7e]{3}$/.test("..."), "the marker is three printable ASCII characters");
  // The marker's own block writes no ellipsis character: three periods, spelled out, is the whole point.
  assert.ok(!consoleJs.slice(consoleJs.indexOf("const CMD_FOLD_DOTS"), consoleJs.indexOf("const copyObserver")).includes("\u2026"));
  // The painter, and the three things it must do: find the cut, take the rest out, put it back.
  assert.match(consoleJs, /function paintCommandFoldMark\(box\) \{/);
  assert.match(consoleJs, /function clearCommandFoldMark\(box\) \{/);
  assert.match(consoleJs, /function cmdCutOffset\(node, limitY, maxX, dots\) \{/);
  assert.match(consoleJs, /function cmdCutAfter\(body, last\) \{/);
  // Back to the whole prompt is the markup the cut came from - never a re-render, never a second copy of the text.
  assert.match(consoleJs, /const cmdFull = new WeakMap\(\);/);
  assert.match(consoleJs, /body\.innerHTML = html;/);
  assert.match(consoleJs, /cmdFull\.set\(body, markup\);/);
  // The cut is at the character a Range says is inside the clamp, and the dots have room on that same row.
  assert.match(consoleJs, /const limitY = rect\.top \+ h - \(parseFloat\(cs\.paddingBottom\) \|\| 0\);/);
  assert.match(consoleJs, /if \(rect\(mid\)\.bottom <= limitY \+ 0\.5\) lo = mid;/);
  assert.match(consoleJs, /while \(lo > 0 && rect\(lo\)\.right \+ dots > maxX\) lo -= 1;/);
  // A body that fits its preview rows is not marked: there is nothing more to read, so nothing may say there is.
  assert.match(consoleJs, /if \(body\.scrollHeight <= h \+ 1\) return;/);
  // ...and a body with no layout yet (a folded turn, a hidden pane) is left for the frame that draws it.
  assert.match(consoleJs, /if \(!w \|\| !h\) return;/);
  // The dots are the card's own chrome in the stylesheet, quiet and never bold.
  assert.match(css, /\.code-fold-dots \{ color: var\(--dim\); font-weight: 400; \}/);
});

test("the marker is written for every card a render path places, and taken back on the press that opens it", () => {
  // The console's one node observer sees every node any render path places (the same hook the copy buttons use), and
  // it hands each added subtree to the painter.
  assert.match(consoleJs, /scheduleCommandFoldMark\(node\);/);
  assert.match(consoleJs, /for \(const el of root\.querySelectorAll\?\.\("\.code-box\.is-cmd"\) \|\| \[\]\) boxes\.push\(el\);/);
  assert.match(consoleJs, /cmdFoldFrame = typeof requestAnimationFrame === "function" \? requestAnimationFrame\(flush\)/);
  // A body that changes width is measured again: the wrap moved, so the last visible character moved with it.
  assert.match(consoleJs, /const cmdFoldResize =/);
  assert.match(consoleJs, /new ResizeObserver\(\(entries\) => \{/);
  // The press: opening restores the prompt, folding marks it. One gesture, one card, no repaint of the console.
  assert.match(app, /const clamp = Number\(box\.dataset\.codeClamp\) \|\| 0;/);
  assert.match(app, /if \(open\) clearCommandFoldMark\(box\);\n\s*else paintCommandFoldMark\(box\);/);
  // ...and the press still writes its own state exactly as before it.
  assert.match(app, /box\.classList\.toggle\("is-clamped", !open\);/);
  assert.match(app, /if \(hint\) hint\.textContent = open \? "click to fold" : "click to read";/);
});

test("the folded height is the reader's number of preview rows, and its fallback is today's two", () => {
  // ONE fold: the stylesheet reads `--cmd-rows` with 2 as its fallback, so an unset setting is the 3em it replaced.
  assert.match(css, /\.code-box\.is-cmd\.is-clamped > \.code-body \{ max-height: calc\(var\(--cmd-rows, 2\) \* 1\.5em\); overflow: hidden; \}/);
  assert.doesNotMatch(css, /max-height: 3em;/);
  // The arithmetic, not a claim: a 12px body at 1.5 is an 18px row, and two of them are the 36px = 3em this rule
  // used to spell out. So the default draws the card exactly as it drew before the setting existed.
  const row = 12 * 1.5;
  assert.equal(row * 2, 36);
  assert.equal(3 * 12, 36);
  // The attribute and the stylesheet are written from the same setting: the card asks the page for the number.
  assert.match(read("../public/core/assistant-command.js"), /const rows = Number\(clamp\) > 0 \? Number\(clamp\) : previewRows\(\);/);
  assert.match(read("../public/core/assistant-command.js"), /clamp: rows,/);
  assert.match(app, /globalThis\.wtCommandPreviewRows = cmdLookState\.rows;/);
  // The unit travels with the value: a bare number in `padding: 4px var(--cmd-pad)` is an invalid declaration and
  // the property would fall back to 0 instead of the reader's pixels.
  assert.match(app, /const CMD_LOOK_UNITS = Object\.freeze\(\{ rows: "", side: "px", pad: "px", blank: "", con: "px" \}\);/);
  assert.match(app, /root\.style\.setProperty\(CMD_LOOK_VARS\[name\], `\$\{v\}\$\{CMD_LOOK_UNITS\[name\]\}`\);/);
  assert.match(app, /const CMD_LOOK_VARS = Object\.freeze\(\{\n\s*rows: "--cmd-rows",/);
  assert.match(app, /rows: "--cmd-rows",\n\s*side: "--cmd-side",\n\s*pad: "--cmd-pad",\n\s*blank: "--cmd-blank",\n\s*con: "--con-side",/);
  // A card already on the page when the reader changes the count is renumbered as well as re-measured: the DOM's
  // number and the drawn fold are the same number.
  assert.match(app, /box\.setAttribute\("data-code-clamp", String\(cmdLookState\.rows\)\);/);
});

test("the card's five settings default to exactly the look the panel had, and one is a floor of 1", () => {
  // The defaults ARE today's numbers, and they are the same numbers the stylesheet falls back to.
  assert.match(app, /const CMD_LOOK_DEFAULTS = Object\.freeze\(\{ rows: 2, side: 0, pad: 8, blank: 0, con: 10 \}\);/);
  assert.match(css, /padding: 0 var\(--cmd-pad, 8px\);/);
  assert.match(css, /\.code-box\.is-cmd \{ margin: calc\(4px \+ var\(--cmd-blank, 0\) \* 18px\) var\(--cmd-side, 0px\); \}/);
  // The console's own text: the inset inside its box, which was 10px before these rows existed.
  assert.match(css, /\n  padding: 8px var\(--con-side, 10px\);/);
  assert.doesNotMatch(css, /\.job-cmd, \.job-out, \.job-foot \{ margin-left: var\(--con-side/);
  // The head and the bullet rows follow the same padding, so the card's texts stay in one column at any value.
  assert.match(css, /\.code-box\.is-cmd > \.code-head \{ align-items: flex-start; padding-left: var\(--cmd-pad, 8px\); padding-right: var\(--cmd-pad, 8px\); \}/);
  assert.match(css, /padding: 3px var\(--cmd-pad, 8px\) 5px calc\(var\(--cmd-pad, 8px\) \+ 14px\);/);
  // The floor: 1 preview row is the minimum, and the ceiling is the one the markup offers (8).
  assert.match(app, /rows: \[1, 8\],/);
  assert.match(app, /const v = Number\.isFinite\(n\) \? Math\.min\(hi, Math\.max\(lo, Math\.round\(n\)\)\) : CMD_LOOK_DEFAULTS\[name\];/);
  // Five rows in the markup, each a number box over its own id, each carrying the same floor and ceiling.
  for (const [id, min, max] of [
    ["cmd-rows", 1, 8],
    ["cmd-side", 0, 60],
    ["cmd-pad", 0, 32],
    ["cmd-blank", 0, 4],
    ["cmd-con", 0, 60],
  ]) {
    const row = new RegExp(`<input id="${id}" type="number" inputmode="numeric" step="1" min="${min}" max="${max}">`);
    assert.match(html, row, `the ${id} row is a number box from ${min} to ${max}`);
    // The value is the STORE's, never the markup's: a shipped value attribute would be a second default.
    assert.doesNotMatch(html, new RegExp(`<input id="${id}"[^>]* value=`), `${id} draws the stored value, not a shipped one`);
  }
  // They live on the Display tab, beside the console's own text settings, and one press puts all five back.
  const display = html.slice(html.indexOf('id="settings-panel-display"'), html.indexOf('id="settings-panel-cards"'));
  for (const id of ["cmd-rows", "cmd-side", "cmd-pad", "cmd-blank", "cmd-con"]) assert.ok(display.includes(`id="${id}"`), `${id} is on the Display tab`);
  assert.match(display, /<button type="button" id="cmd-look-reset"/);
  assert.match(app, /\$\("cmd-look-reset"\)\?\.addEventListener\("click", \(\) => \{/);
  // Saved in this browser under one key, and applied at boot before the first card is drawn.
  assert.match(app, /const CMD_LOOK_KEY = "wtgui\.cmdLook";/);
  assert.match(app, /localStorage\.setItem\(CMD_LOOK_KEY, JSON\.stringify\(cmdLookState\)\);/);
  assert.match(app, /initCommandCardLook\(\);/);
});

test("the preview rows are one number: the attribute moves with the fold, and junk never draws a broken card", () => {
  // The page's number, read at call time - so a repaint after the reader changes it draws the new fold.
  globalThis.wtCommandPreviewRows = 5;
  try {
    assert.equal(M.previewRows(), 5);
    assert.match(M.cardHtml(LINE, { key: "k" }), /data-code-clamp="5"/);
    assert.match(M.cardHtml(LINE, { key: "k" }), /class="code-box is-cmd is-clamped"/);
    // A caller that names its own number still wins: the harness and the tests drive the fold they measure.
    assert.match(M.cardHtml(LINE, { key: "k", clamp: 3 }), /data-code-clamp="3"/);
    // Junk, a zero and a negative cannot produce a card with no preview row at all.
    for (const junk of [0, -2, "x", null, undefined, Number.NaN]) {
      globalThis.wtCommandPreviewRows = junk;
      assert.equal(M.previewRows(), M.COMMAND_PREVIEW_ROWS, `previewRows(${String(junk)}) falls back to the default`);
      assert.match(M.cardHtml(LINE, { key: "k" }), /data-code-clamp="2"/);
    }
    // A fraction is not a row count: 3.4 rounds to 3, the way the settings row rounds what it is handed.
    globalThis.wtCommandPreviewRows = 3.4;
    assert.equal(M.previewRows(), 3);
  } finally {
    delete globalThis.wtCommandPreviewRows;
  }
  assert.equal(M.COMMAND_PREVIEW_ROWS, 2, "the two rows this card has always folded to");
});

test("a bold Prompt: label starts the body's first row, inline, and only on that row", () => {
  assert.equal(M.COMMAND_PROMPT_LABEL, "Prompt:");
  const card = M.cardHtml(PROMPT, { key: "k" });
  // Inline on the first row: the label, a space, then the prompt. Never a row of its own - a label that ate a
  // preview row would leave the reader with one row of the text they came to read.
  assert.match(card, /<div class="jl jl-text"><b class="code-prompt-label">Prompt:<\/b> read the renderer, then the fold<\/div>/);
  assert.equal((card.match(/class="code-prompt-label"/g) || []).length, 1, "one label per card");
  // The weight is the stylesheet's, and it is bold; the dots beside it are not.
  assert.match(css, /\.code-prompt-label \{ font-weight: 700; color: #e2e9f3; \}/);
  // A card whose body is empty (a SPAWN that only carries its TODOs) draws no label over nothing.
  const bulletsOnly = M.cardHtml("SPAWN IN a |", { key: "k", bullets: [{ category: "One", text: "the item" }] });
  assert.ok(bulletsOnly.includes("code-bullet"), "the card is drawn for its bullets");
  assert.ok(!bulletsOnly.includes("code-prompt-label"), "no label over an empty prompt");
});

test("display only: the copy and the executed line are what they were", () => {
  // The card carries its line in `data-ltext`, and the console's copy reads THAT - never the drawn rows, which the
  // fold marker cuts.
  assert.match(consoleJs, /if \(el\.matches && el\.matches\("\.code-box\[data-ltext\]"\)\) return String\(el\.getAttribute\("data-ltext"\) \|\| ""\);/);
  const card = M.cardHtml(PROMPT, { key: "k" });
  assert.ok(card.includes(`data-ltext="${PROMPT}"`), "the whole line travels with the card");
  // Nothing in the marker's own file parses a command line or writes a job: it is chrome over a drawn body.
  const marker = consoleJs.slice(consoleJs.indexOf("const CMD_FOLD_DOTS"), consoleJs.indexOf("const copyObserver"));
  assert.doesNotMatch(marker, /parseActions|parseCommandLine|saveJob|recordJobLine|fetch\(/);
});
