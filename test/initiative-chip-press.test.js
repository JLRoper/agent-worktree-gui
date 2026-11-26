// THE CHART'S INITIATIVE CHIP, AS THE PAGE DRAWS IT AND PRESSES IT.
//
// The reader's ask: a press on the chip in the chart's initiative column opens the assistant window on that
// initiative, fully expanded, with a green-gold flash that fades. The behaviour is proved on a real page by
// tools/verify-initiatives-tab.mjs (claim 10); this file pins the three halves that make that press possible, so a
// later edit cannot quietly take the keyboard away from the chip or leave the flash class on the card:
//
//   1. the MARKUP (public/render-projects.js `initiativeCellHtml`): the chip is a role="button" with a tabindex, its
//      data attribute carries the id the opener needs, its tooltip is unchanged, and a tree with no initiative still
//      draws the dash the column's rule promises;
//   2. the PRESS (public/app.js): one delegated click and one delegated keydown, both in the CAPTURE phase (the row's
//      own press folds the row otherwise), Enter and Space answered with preventDefault, and both calling the opener
//      public/assistant.js publishes;
//   3. the OPENER (public/assistant.js): the float raised, the Initiatives pane selected, the id added to the open
//      book, the card scrolled to and flashed, and the flash class removed on animationend so it cannot stick.
//
// Read out of the page and run with no browser, like test/turnover-row-marker.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const projects = readFileSync(new URL("../public/render-projects.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The cell's own code, cut from the file that draws it: the renderer, not a copy of its string in this test.
const cellCode = sliceBetween(projects, "function initiativeCellHtml(row) {", "\nfunction rowHtml(");
const initiativeCellHtml = new Function("esc", `${cellCode}; return initiativeCellHtml;`)(esc);

const chipsOf = (html) => [...html.matchAll(/<span class="chip initiative-chip"[^>]*>/g)].map((m) => m[0]);
const attr = (tag, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};
const dashCell = (html) => /^<td class="initiative"><span class="dim" title="([^"]*)">-<\/span><\/td>$/.test(html);

test("a chip carries the id the opener needs, and the keyboard reaches it", () => {
  const html = initiativeCellHtml({ initiatives: [{ id: "init-7", title: "SSO migration" }] });
  const [tag] = chipsOf(html);
  assert.ok(tag, html);
  assert.equal(attr(tag, "data-initiative-id"), "init-7");
  assert.equal(attr(tag, "role"), "button");
  assert.equal(attr(tag, "tabindex"), "0");
  assert.equal(chipsOf(html).length, 1);
});

test("the chip's tooltip is the one it always carried", () => {
  const html = initiativeCellHtml({ initiatives: [{ id: "a", title: "Menu cutover" }] });
  const [tag] = chipsOf(html);
  // The sentence the column promised the reader: the initiative's own title, then where the whole piece of work
  // lives. A press now goes there too, but the chip's title must not change under the reader who already learned it.
  assert.equal(attr(tag, "title"), "initiative: Menu cutover - the Initiatives tab beside Role holds the whole piece of work");
  assert.match(html, />Menu cutover<\/span>/);
});

test("two initiatives on one tree draw two chips, each with its own id", () => {
  const html = initiativeCellHtml({
    initiatives: [
      { id: "one", title: "SSO migration" },
      { id: "two", title: "Gateway cutover" },
    ],
  });
  const ids = chipsOf(html).map((tag) => attr(tag, "data-initiative-id"));
  assert.deepEqual(ids, ["one", "two"]);
});

test("a tree with no initiative still draws the dash, with its reason, and no chip", () => {
  const html = initiativeCellHtml({ initiatives: [] });
  assert.equal(chipsOf(html).length, 0);
  assert.ok(dashCell(html), html);
  assert.match(html, /no initiative - the normal case/);
  // A list of records with no title is the same absence: an empty chip would be a chip a reader could press to
  // nothing, so it is drawn as the dash instead.
  assert.ok(dashCell(initiativeCellHtml({ initiatives: [{ id: "x", title: "" }] })));
});

// ---- the press, as public/app.js wires it ----------------------------------------------------------------
const pressCode = sliceBetween(app, "// THE INITIATIVE CHIP IS THE WAY INTO THE INITIATIVES MAP.", '$("projects").addEventListener("click"');

test("the press is delegated, and both listeners are in the capture phase", () => {
  assert.match(pressCode, /document\.addEventListener\(\s*"click",/);
  assert.match(pressCode, /document\.addEventListener\(\s*"keydown",/);
  assert.match(pressCode, /closest\("\.initiative-chip\[data-initiative-id\]"\)/);
  // Two listeners, two capture flags: the chip sits inside a row whose own press folds it, and a bubbling listener
  // would run after that fold had already taken the press.
  assert.equal((pressCode.match(/\btrue,\s*\);/g) || []).length, 2);
  assert.match(pressCode, /stopPropagation\(\)/);
});

test("Enter and Space make the same press a click makes, and Space cannot scroll the page", () => {
  assert.match(pressCode, /e\.key !== "Enter"/);
  assert.match(pressCode, /e\.key !== " "/);
  assert.match(pressCode, /e\.key !== "Spacebar"/);
  // preventDefault is what stops Space scrolling the window out from under the card the press opens.
  assert.match(pressCode, /e\.preventDefault\(\)/);
  assert.match(pressCode, /window\.__assistantOpenInitiative\(chip\.dataset\.initiativeId\)/);
});

test("the page publishes the opener the press calls", () => {
  assert.match(assistant, /window\.__assistantOpenInitiative = openInitiativeCard;/);
});

// ---- the opener, as public/assistant.js writes it --------------------------------------------------------
const openerCode = sliceBetween(assistant, 'let initLandId = "";', "\n  // An assistant's NAME in the card");

test("the opener raises the float, selects the Initiatives pane and unfolds that card before the paint", () => {
  assert.match(openerCode, /if \(!state\.assistantOpen\) toggleAssistant\(true\);/);
  assert.match(openerCode, /setView\(\{ assistant: "initiatives" \}\)/);
  const add = openerCode.indexOf("initOpen.add(want);");
  const paint = openerCode.indexOf("renderAssistantInitiatives(true);");
  assert.ok(add > 0 && paint > add, "the id is in the open book before the render that draws it");
});

test("the opener scrolls the pane to the card, and only the pane, then lands it after the render", () => {
  assert.match(openerCode, /#as-initiatives \[data-init-card="\$\{CSS\.escape\(String\(id\)\)\}"\]/);
  // The pane's own scrollTop, computed from the card's offset inside the pane's content: `scrollIntoView` would take
  // every scrollable ancestor with it, the board behind the float included (measured: a 173px window jump).
  assert.match(openerCode, /const pane = card\.closest\("\.as-pane"\);/);
  assert.match(openerCode, /pane\.scrollTop = Math\.max\(0, Math\.round\(delta\)\);/);
  // The landing is the render's own tail (public/assistant.js renderAssistantInitiatives), so it acts on the node that
  // paint placed and it works for a press that arrived before the tab had ever read the store.
  const renderTail = sliceBetween(assistant, "restoreInitFocus(host, focusToken);", "scheduleInitRefresh();");
  assert.match(renderTail, /if \(initLandId && \(landInitCard\(initLandId\) \|\| Date\.now\(\) - initLandAt > INIT_LAND_MS\)\) initLandId = "";/);
  assert.match(openerCode, /initLandId = want;\s*initLandAt = Date\.now\(\);/);
  // A read that takes longer than the press is worth remembering drops the landing instead of flashing a card at a
  // reader who has moved on.
  assert.match(openerCode, /const INIT_LAND_MS = 20_000;/);
});

test("the flash is a class the animation itself takes back, with a timer as the fallback", () => {
  assert.match(openerCode, /restartClassAnimation\(card, INIT_FLASH, "initcardflash"\)/);
  assert.match(openerCode, /card\.addEventListener\("animationend", onEnd\)/);
  // A child's animation bubbles through the card: the flash may not be ended by one of them.
  assert.match(openerCode, /if \(ev\.target !== card\) return;/);
  assert.match(openerCode, /card\.classList\.remove\(INIT_FLASH\)/);
  // The fallback: a card whose animation never runs (reduced motion, a background tab) still loses the class.
  assert.match(openerCode, /const INIT_FLASH_MS = 1400;/);
  assert.match(openerCode, /card\._initFlashT = setTimeout\(clear, INIT_FLASH_MS \+ 400\)/);
});

test("the sheet carries the keyframe and the class, and the keyframes match shadow for shadow", () => {
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  const block = sliceBetween(css, "@keyframes initcardflash {", "\n#as-initiatives .init-status {");
  assert.match(block, /#as-initiatives \.init-card\.is-flash \{ animation: initcardflash 1400ms ease-out; \}/);
  // A frame list of a different length is not interpolated: the browser would snap between frames instead of fading.
  const frames = [...block.matchAll(/box-shadow: ([^;]+);/g)].map((m) => m[1].split(/,(?![^(]*\))/).length);
  assert.deepEqual([...new Set(frames)], [3]);
  // The last frame is the card's own surface showing through: both the ring and the wash are at alpha 0.
  assert.match(block, /100% \{\s*box-shadow: 0 0 0 0 rgba\(198, 206, 84, 0\), 0 0 10px rgba\(126, 231, 135, 0\), inset 0 0 0 999px rgba\(154, 178, 76, 0\);/);
});
