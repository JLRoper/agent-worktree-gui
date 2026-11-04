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

test("the backdrop closes only a press that BEGAN on it", () => {
  assert.match(source, /state\.pressedOnBackdrop = Boolean\(host && e\.target === host\)/, "the press remembers where it started");
  assert.match(source, /if \(e\.target !== host \|\| !state\.pressedOnBackdrop\) return;/, "a drag out of the card is not a dismissal");
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

test("the page loads the renderer, then the modal, then the app that wires both", () => {
  const flowAt = html.indexOf('<script src="/pipeline-flow.js"></script>');
  const modalAt = html.indexOf('<script src="/pipeline-modal.js"></script>');
  const appAt = html.indexOf('<script src="/app.js"></script>');
  assert.ok(flowAt > 0 && modalAt > flowAt, "the modal depends on the renderer, so it loads after it");
  assert.ok(appAt > modalAt, "app.js wires the tab's press, so it loads after both");
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
