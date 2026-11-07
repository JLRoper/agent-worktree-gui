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

test("the card is a window: its bar drags it and its corner grip resizes it", () => {
  // The grip is part of the card's own markup and lives inside the clipped box, so it cannot be a control drawn off
  // the card's edge. It takes no Tab stop and no accessible name (it is a pointer affordance, `aria-hidden`).
  assert.match(source, /class="pmodal-resize" data-pm-resize aria-hidden="true"/, "the card carries its corner grip");
  assert.match(css, /\.pmodal-resize \{ position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize;/, "anchored to the corner, with the corner's cursor");
  // The bar is the only drag handle, and a press on one of its controls is that control: the close button and the map
  // link must still be presses, not the start of a gesture.
  assert.match(source, /const bar = e\.target\?\.closest\?\.\("\.pmodal-bar"\);/);
  assert.match(source, /closest\?\.\("button, a, select, input, textarea, label"\)/, "a control inside the bar is not a handle");
  assert.match(source, /addEventListener\?\.\("pointermove", \(e\) => gestureMove\(e, doc\)\)/);
  assert.match(source, /addEventListener\?\.\("pointerup", \(e\) => gestureEnd\(e, doc\)\)/);
  assert.match(source, /addEventListener\?\.\("pointercancel", \(e\) => gestureEnd\(e, doc\)\)/);
  // A press that barely moves is a press on the bar, not a drag of the card.
  assert.match(source, /const PM_SLOP = \d+;/, "a slop threshold, so a click is not a drag");
});

test("the gesture is VISUAL px in and LAYOUT px out, clamped to the window and reset per open", () => {
  // Settings > Display's page zoom is the factor between a pointer's visual px and a style's layout px; writing one in
  // the other's unit is how a dragged panel lands somewhere the reader did not aim.
  assert.match(source, /getComputedStyle\?\.\(doc\.documentElement\)\?\.zoom/, "the page zoom is read, not assumed");
  assert.match(source, /g\.x \/ z/, "a written x is divided by it");
  assert.match(source, /function clampCard\(/, "one clamp serves both gestures");
  assert.match(source, /const PM_MARGIN = \d+;/, "the card keeps a margin from every edge");
  assert.match(source, /const PM_MIN_W = \d+;/, "and a floor the resize cannot go under");
  assert.match(source, /addEventListener\?\.\("resize", \(\) => rehomeCard\(doc\)\)/, "a window that shrinks re-homes it");
  // The place belongs to the drawing it was chosen for: close() and open() both reset it.
  assert.ok((source.match(/resetCard\(doc\);/g) || []).length >= 2, "open() and close() both reset the card's geometry");
});

test("a card too narrow for a readable row wraps the drawing instead of clipping stages", () => {
  // The rule: when the compact row would give a column less than its own 56 px floor, no single row can be read, so
  // the track wraps into rows of the readable 96 px columns. The wrap has its own stylesheet shape, and the connector
  // stub on the last tile of a row is dropped (there is no next column to join).
  assert.match(source, /function wrapRows\(flowEl, shape\)/);
  assert.match(source, /const PFLOW_COMPACT = 56;/, "the compact column is the threshold");
  assert.match(source, /flowEl\.dataset\.wrap = said;/, "the shape is a data attribute, so the stylesheet owns it");
  assert.match(css, /\.pflow\[data-wrap="1"\] \.pflow-track \{ grid-template-columns: repeat\(auto-fit, minmax\(96px, 1fr\)\);/, "the wrapped track keeps the readable column");
  assert.match(css, /\.pflow\[data-wrap="1"\] \.pflow-node\[data-row-end="1"\] \.pflow-link \{ display: none; \}/, "a row's last tile keeps no connector");
  assert.match(css, /\.pflow\[data-wrap="1"\] \.pflow-arcs,/, "the horizontal arc lane is put away with the row");
});

// ---- the card's frame: three defects a 3285x472 capture reported --------------------------------------------------
// All three are GEOMETRY, so each one is pinned here as the rule it now follows and exercised for real in
// tools/verify-pipeline-flow.mjs (640x480 and a wide short window).

test("the card's height follows its content, and a resize sets the ceiling the body may grow into", () => {
  // The card used to be PINNED to the rectangle a resize left: a six-stage drawing 177 px tall sat in a card 329 px
  // tall, and the 152 px between the legend and the card's own bottom edge was an empty grey field, because nothing
  // paints the room a drawing did not ask for. `height` is cleared now and the gesture's number is `max-height`, so
  // the card is exactly as tall as its content and the reader's drag says how far it may grow before it scrolls.
  const paint = source.slice(source.indexOf("function paintCard("), source.indexOf("// Back to the stylesheet's own card"));
  assert.ok(paint.length > 200, "paintCard is in the source");
  assert.match(paint, /card\.style\.height = ""/, "the card is as tall as its content");
  assert.match(paint, /card\.style\.maxHeight = `\$\{Math\.round\(g\.h \/ z\)\}px`/, "and the drag's height is the ceiling it may grow into");
  assert.doesNotMatch(paint, /card\.style\.height = `/, "no pinned height");
  // The body takes the room the ceiling leaves and scrolls inside it, rather than the card growing past it.
  assert.match(css, /\.pmodal-body \{[^}]*overflow: auto;[^}]*min-height: 0; \}/, "the body scrolls inside the card");
  assert.match(/\.pmodal-card \{[^}]*max-height: 86vh;/.exec(css)?.[0] || "", /86vh/, "and the stylesheet's own card is still capped by the window");
  // A fresh open (and a double-press on the bar) drops the ceiling with the place and the width.
  assert.match(source, /for \(const prop of \["position", "margin", "left", "top", "width", "height", "maxHeight"\]\) card\.style\[prop\] = "";/, "resetCard clears the ceiling too");
});

test("the tile row keeps headroom above the tiles, so no mark and no top border is cut by the scroller", () => {
  // The marks sit 5 px above a tile's top edge and the scroller clips its own top (`overflow-y: hidden`), so a track
  // that began at the scroller's edge had the top of every dot, each tile's 1 px top border and its rounded corners
  // sliced flat - the row of half-circles above the tiles in the 3285x472 capture. The canvas owns 8 px of band.
  assert.match(css, /--pflow-head: 8px/, "one number, a real style length");
  assert.match(css, /\.pflow-canvas \{ position: relative; padding-top: calc\(var\(--pflow-pad, 0px\) \+ var\(--pflow-head\)\);/, "the track starts below it, and below the loop lanes when there are any");
  assert.match(css, /\.pflow\[data-wrap="1"\] \.pflow-canvas \{ padding-top: var\(--pflow-head\); \}/, "the wrapped rows keep it too");
  assert.match(css, /\.pflow-arcs \{[^}]*top: var\(--pflow-head\);/, "the loop lanes move down with the track they join");
  assert.match(css, /\.pflow-dot \{ position: absolute; top: -5px;/, "the mark still overhangs the tile's top edge - which is why the band exists");
});

test("a gate's notch is drawn inside the tile it belongs to, so no window shape can cut it", () => {
  // `wrapRows` used to re-aim every notch on every read: the middle of the connector gap for a row, the tile's own
  // right edge at a row end. A gap belongs to no element - it is the band between two tiles - so a scroller that
  // clipped the flow's top, or a card narrower than the last column, sliced the notch that hung there. The sheet owns
  // the position now, inside the tile's box, and the script re-aims nothing.
  const wrap = source.slice(source.indexOf("function wrapRows("), source.indexOf("function readView("));
  assert.ok(wrap.length > 100, "wrapRows is in the source");
  assert.doesNotMatch(wrap, /notch\.style/, "no notch is re-aimed at runtime");
  assert.match(wrap, /nodes\[i\]\.dataset\.rowEnd = "1"/, "a row's last tile is still marked, so its connector stub is dropped");
  const rule = /\.pflow-notch \{ ([^}]*)\}/.exec(css)?.[1] || "";
  assert.match(rule, /left: 100%;/, "the notch starts at the column's own trailing edge");
  assert.match(rule, /margin-left: -3px;/, "pulled back by its own width: inside the tile's box, not in the gap");
  assert.doesNotMatch(rule, /left: calc\(100% \+/, "and never out in the gap");
  assert.match(rule, /top: 11\.5px; width: 3px; height: 15px;/, "a 3x15 bar straddling the connector's line instead of hanging below it");
  assert.match(css, /\.pflow-link \{ position: absolute; top: 19px;/, "the connector's hairline is at 19 px, which the notch centres on");
});

// ---- the VIEW: the map page's chart, beside the drawing this dialog has always held -------------------------------
// The mode pair above is unchanged (the surface that opened the dialog); a VIEW is how the definition is drawn. The
// two are separate on purpose: a position-mode dialog has a record and a preview control, not a definition, so it
// never grows a switch.

test("a view is not a mode: only preview and edit exist, and the element says which is up", () => {
  assert.match(source, /const VIEWS = \["preview", "edit"\];/);
  assert.match(source, /function previewAvailable\(\) \{/);
  assert.match(source, /state\.mode === "edit" && Boolean\(state\.definition\)/);
  // The default is the preview, decided at open() from the definition the caller handed over.
  assert.match(source, /state\.view = previewAvailable\(\) && \(options\.view == null \|\| options\.view === "preview"\) \? "preview" : "edit";/);
});

test("the switch is two named buttons in the bar, pressed state on the one that is up", () => {
  assert.match(source, /data-pm-view="preview" aria-pressed="\$\{pressed\("preview"\)\}"/);
  assert.match(source, /data-pm-view="edit" aria-pressed="\$\{pressed\("edit"\)\}"/);
  assert.match(source, /class="pmodal-views" role="group" aria-label="how this definition is drawn"/);
  assert.match(source, /state\.view === "preview" \? `<span class="pmodal-views-note">read-only<\/span>`/);
  // It sits in the header bar, after the subtitle — not in the drawing and not in the body.
  const bar = source.slice(source.indexOf("return `<div class=\"pmodal-bar\">"), source.indexOf("<div class=\"pmodal-body\">"));
  assert.match(bar, /\$\{viewsHtml\(\)\}/, "the switch is in the bar's first row");
  assert.match(css, /\.pmodal-views button\[aria-pressed="true"\] \{ background: var\(--surface\); color: var\(--text\); \}/);
});

test("the preview draws the shared card, and only from a definition the caller supplied", () => {
  assert.match(source, /const M = global\.PipelineMermaid;/);
  assert.match(source, /item = M\.fromDefinition\(state\.definition\)/);
  assert.match(source, /M\.card\(item, \{ layout: "row", head: false, builtin: true \}\)/);
  assert.match(source, /await M\.paint\(\{ item, el \}, \{ layout: "row", ns: "pmodal", live \}\)/);
  // A render whose dialog moved on (switched view, closed) cannot paint: the generation is the guard.
  assert.match(source, /const live = \(\) => state\.open && state\.view === "preview" && seq === state\.chartSeq;/);
  assert.match(source, /chartSeq: state\.chartSeq \+ 1,/);
  // The chart's host is its own element, and a failure is a sentence in it rather than a blank body.
  assert.match(source, /data-pm-chart-view="preview"><div class="pm-host" data-pm-chart>/);
  assert.match(source, /the chart could not be drawn: \$\{esc\(said\)\}/);
  // The definition travels from the Settings tab as the DRAFT, beside the flow the edit view draws.
  const app = dropCR(readFileSync(new URL("../public/app.js", import.meta.url), "utf8"));
  const at = app.indexOf("function openPipelineFlow()");
  assert.ok(at > 0, "the tab's handler is in app.js");
  assert.match(app.slice(at, at + 1200), /definition: def,/, "the modal is handed the definition itself, not only the flow");
});

test("the chart is as wide as its drawing, and the stylesheet's width returns for the flow drawing", () => {
  assert.match(source, /card\.style\.width = `\$\{Math\.min\(Math\.max\(340, Math\.ceil\(draw\.scrollWidth \+ 32\)\), Math\.round\(vw \* 0\.96\)\)\}px`/);
  // A width the reader dragged/resized belongs to both views and is never overwritten.
  assert.ok(source.includes("if (!state.rect) {"), "the reader's frame wins over the fitted width");
  // The switch back to the flow drawing clears the chart's width so `.pmodal-card`'s own rule sizes it again.
  const setView = source.slice(source.indexOf("function setView("), source.indexOf("function focusables("));
  assert.match(setView, /if \(!state\.rect\) \{/);
  assert.match(setView, /card\.style\.width = "";/);
});
