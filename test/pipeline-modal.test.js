// The pipeline MODAL (public/pipeline-modal.js): one dialog, two modes, and the behaviour a modal owes a reader.
//
// Node has no page, so the pure key rule is driven directly (it is published on globalThis when there is no document)
// and the rest is read out of the source and the stylesheet — the things the browser proof (tools/verify-pipeline-flow.mjs)
// then exercises for real:
//
//   - Escape closes, and the handler is in the CAPTURE phase and stops the key: the Settings window closes on a
//     bubble-phase Escape, and one Esc must never close two surfaces;
//   - Tab wraps inside the card and Shift+Tab wraps back — a trap, not a suggestion;
//   - a press on the backdrop closes it, and a press that began inside the card does not, even when released outside;
//   - the dialog sits ABOVE the Settings window it is opened from (z-index 140 over 120) and locks the page behind it;
//   - it restores focus to the control that opened it;
//   - the mode is part of the element (`data-mode`), and only `edit` and `position` are accepted;
//   - reduced motion is honoured from `prefers-reduced-motion`, and the stylesheet repeats the rule for a page whose
//     script never ran.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../public/pipeline-modal.js");
const { keyIntent } = globalThis.PipelineModal;

// The file is checked out with the repo's own line endings (CRLF on Windows), so every slice and regex below reads a
// normalised copy: a source assertion must not fail because git rewrote a newline. Carriage return by code point, so
// this line carries no escape a later edit could mangle.
const dropCR = (text) => text.replaceAll(String.fromCharCode(13), "");
const source = dropCR(readFileSync(new URL("../public/pipeline-modal.js", import.meta.url), "utf8"));
const css = dropCR(readFileSync(new URL("../public/style.css", import.meta.url), "utf8"));
const html = dropCR(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"));

test("Escape is always the close intent", () => {
  assert.equal(keyIntent({ key: "Escape" }), "close");
  assert.equal(keyIntent({ key: "Escape", shift: true, activeIndex: 2, count: 3 }), "close");
});

test("Tab wraps at the last item and Shift+Tab at the first, and does nothing in the middle", () => {
  assert.equal(keyIntent({ key: "Tab", activeIndex: 3, count: 4 }), "first", "Tab on the last goes to the first");
  assert.equal(keyIntent({ key: "Tab", shift: true, activeIndex: 0, count: 4 }), "last", "Shift+Tab on the first goes to the last");
  assert.equal(keyIntent({ key: "Tab", activeIndex: 0, count: 4 }), null, "the browser's own move is the answer in the middle");
  assert.equal(keyIntent({ key: "Tab", shift: true, activeIndex: 2, count: 4 }), null);
  assert.equal(keyIntent({ key: "Tab", activeIndex: -1, count: 0 }), null, "an empty card traps nothing");
  assert.equal(keyIntent({ key: "a", activeIndex: 0, count: 4 }), null, "typing is not a key the dialog owns");
});

test("the key handler runs in the capture phase and consumes the key it owns", () => {
  const keyBlock = source.slice(source.indexOf('doc.addEventListener(\n      "keydown"'), source.indexOf('// A press that BEGINS on the backdrop'));
  assert.ok(keyBlock.length > 200, "the keydown registration is in the source");
  assert.match(keyBlock, /e\.preventDefault\?\.\(\)/);
  assert.match(keyBlock, /e\.stopPropagation\?\.\(\)/, "stopPropagation is what keeps the Settings window's Escape from firing behind it");
  assert.match(keyBlock, /if \(intent === "close"\)/, "Escape is the close intent");
  assert.match(keyBlock, /\},\s*\n?\s*true,\s*\n?\s*\);/, "registered with capture = true");
});

test("the backdrop closes only a press that BEGAN on it, and the press stops at this dialog", () => {
  assert.match(source, /state\.pressedOnBackdrop = Boolean\(host && e\.target === host\)/, "the press remembers where it started");
  assert.match(source, /if \(e\.target !== host\) return;/, "only a press on the backdrop itself is a backdrop press");
  assert.match(
    source,
    /e\.stopPropagation\?\.\(\);\s*\n\s*if \(!state\.pressedOnBackdrop\) return;/,
    "a drag out of the card is not a dismissal — and no backdrop press reaches the page's Settings outside-press handler (one press, one surface)",
  );
});

test("it is a real modal: role, aria-modal, its own focus, a scroll lock and focus restored to the opener", () => {
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby="\$\{TITLE_ID\}" tabindex="-1"/);
  assert.match(source, /doc\.getElementById\(CARD_ID\)\?\.focus\?\.\(\{ preventScroll: true \}\)/);
  assert.match(source, /classList\?\.add\("pipeline-modal-open"\)/);
  assert.match(source, /classList\?\.remove\("pipeline-modal-open"\)/);
  assert.match(source, /again\.focus\(\{ preventScroll: true \}\)|again\?\.focus\?\.\(\{ preventScroll: true \}\)/);
  assert.match(css, /body\.pipeline-modal-open \{ overflow: hidden; \}/);
});

test("the dialog is above the Settings window it is opened from", () => {
  const zOf = (selector) => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `${selector} is in the stylesheet`);
    const decl = css.slice(at, css.indexOf("}", at));
    const z = /z-index:\s*(\d+)/.exec(decl);
    return z ? Number(z[1]) : null;
  };
  const modal = zOf(".pmodal {");
  const settings = zOf(".settings {");
  assert.ok(Number.isInteger(modal) && Number.isInteger(settings), `modal ${modal}, settings ${settings}`);
  assert.ok(modal > settings, `the modal (${modal}) is above Settings (${settings})`);
});

test("only two modes exist, and the element says which one is up", () => {
  assert.match(source, /const MODES = \["edit", "position"\];/);
  assert.match(source, /host\.setAttribute\("data-mode", mode\)/);
  assert.match(source, /console\.warn\(`pipeline-modal: open\(\) needs mode/);
});

test("reduced motion is read from the reader's own preference, and the stylesheet agrees", () => {
  assert.match(source, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(source, /setAttribute\("data-motion", state\.motion \? "on" : "off"\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none;/);
  assert.match(css, /\.pflow\[data-motion="on"\] \.pflow-node\[data-mark="current"\] \.pflow-dot \{ animation:/);
});

test("the count is re-measured on scroll and resize, and a press inside the card is this dialog's press", () => {
  // The count is a measurement of the painting, not a number carried in the markup: the modal reads it from the
  // renderer's own viewCount(), re-reads it on every scroll and on a window resize, and forgets the watcher on close.
  assert.match(source, /PipelineFlow\.viewCount\(/);
  assert.match(source, /addEventListener\?\.\("scroll", onScroll, \{ passive: true \}\)/);
  assert.match(source, /addEventListener\?\.\("resize", onResize\)/);
  assert.match(source, /state\.flowWatch = \(\) => \{/);
  assert.match(source, /if \(state\.flowWatch\) \{\s*\n\s*state\.flowWatch\(\);/);
  // `fit` is the dialog's own reader-owned state, reset on open and restored across a re-render.
  assert.match(source, /state\.fit = false;/);
  assert.match(source, /flowHtml\(state\.flow, state\.position, state\.motion, state\.fit\)/);
  // A press inside the card must stop at the card: the page closes Settings for any click whose path does not include
  // it, and this dialog is opened from Settings (public/app.js, the #settings outside-press handler).
  assert.match(source, /doc\.getElementById\(CARD_ID\)\?\.addEventListener\("click", \(e\) => e\.stopPropagation\?\.\(\)\)/);
  // The fitted widths are the same grid's custom properties, and the control has a ring of its own.
  assert.match(css, /\.pflow\[data-fit="1"\] \{ --pflow-gap: 12px; --pflow-minw: 56px; \}/);
  assert.match(css, /\.pflow-fit:focus-visible \{ outline: 2px solid #4a90d9; outline-offset: 2px; \}/);
  assert.match(css, /\.pflow-status\[hidden\], \.pflow-fit\[hidden\] \{ display: none; \}/);
});

test("the page loads the renderer, then the modal, then the app that wires both", () => {
  const flowAt = html.indexOf('<script src="/pipeline-flow.js"></script>');
  const modalAt = html.indexOf('<script src="/pipeline-modal.js"></script>');
  const appAt = html.indexOf('<script src="/app.js"></script>');
  assert.ok(flowAt > 0 && modalAt > flowAt, "the modal depends on the renderer, so it loads after it");
  assert.ok(appAt > modalAt, "app.js wires the tab's press, so it loads after both");
});

test("the dialog is as wide as its drawing: one stage is a small panel, thirteen a wide one", () => {
  // The width is one policy, written in the stylesheet and fed by the modal's own stage count: a column at the
  // track's 96 px floor, the 26 px gaps between them, and the body's 16 px of padding plus the card's 2 px border.
  const width = /\.pmodal-card \{[^}]*width: ([^;]+);/.exec(css)?.[1] || "";
  assert.match(width, /--pflow-card-n/, "the card's width is a function of the drawing's stage count");
  assert.match(width, /\* 96px/, "the track's own readable floor");
  assert.match(width, /\+ 18px/, "the body's 16 px of padding and the card's 2 px border, which the track does not get");
  assert.match(width, /96vw/, "and the viewport is still the ceiling");
  assert.doesNotMatch(css, /width: min\(1120px, 96vw\)/, "the fixed 1120 px frame is gone");
  // paint() owns the number, from the flow it is holding, and close() clears it so a reuse cannot inherit a width.
  assert.match(source, /card\.style\?\.setProperty\?\.\("--pflow-card-n", String\(stageCount\(state\.flow\)\)\)/);
  assert.match(source, /function stageCount\(flow\) \{/);
  assert.match(source, /setProperty\?\.\("--pflow-card-n", "1"\)/, "close() resets it");
  // A one-stage definition and a thirteen-stage one land on the two ends the brief asked for.
  const w = (n) => Math.min(Math.max(340, n * 96 + (n - 1) * 26 + 18), 1824 * 0.96);
  assert.equal(w(1), 340, "one stage is a 340 px panel, not a 1120 px frame");
  assert.ok(w(2) < 500 && w(7) === 846 && w(13) > 1200, `2 → ${w(2)}, 7 → ${w(7)}, 13 → ${Math.round(w(13))}`);
});

test("the header names what is drawn, not an edit this dialog does not offer", () => {
  assert.doesNotMatch(source, /pipeline flow · editing/, "no EDITING over a surface with no edit control");
  assert.match(source, /pipeline flow · definition/);
  assert.match(source, /pipeline flow · position/);
  // The apology caption that explained the absence of marks is gone; the legend says the state once instead.
  const app = dropCR(readFileSync(new URL("../public/app.js", import.meta.url), "utf8"));
  assert.doesNotMatch(app, /each notch is the exit check that ends the stage before it/, "the caption is deleted");
  const at = app.indexOf("function openPipelineFlow()");
  assert.ok(at > 0, "the control's handler is in app.js");
  assert.doesNotMatch(app.slice(at, at + 1400), /\bnote:/, "the modal is opened without a note to explain the picture");
});

test("the Pipeline tab has the dropdown, the editor and the control that opens the modal", () => {
  assert.match(html, /id="pipeline-select"/, "the dropdown");
  assert.match(html, /id="pipeline-flow-open" data-pipeline-flow-open/, "the control");
  assert.match(html, /id="pipeline-editor"/, "the editor for the selected definition");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /PipelineModal\.open\(\{\s*\n?\s*mode: "edit"/, "the tab opens the modal in edit mode");
  assert.match(app, /pipeline-select"\)\?\.addEventListener\("change"/, "the dropdown is what changes the selection");
  const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
  assert.match(assistant, /data-as-qflow=/, "a queue row carries the position-mode press");
  assert.match(assistant, /mode: "position"/, "and it opens the modal in position mode");
});
