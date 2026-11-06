// The pipeline MAP from inside the panel: two doors, one page, and neither of them a dead click target.
//
// `public/pipeline-map.html` draws every pipeline the panel can put a tree on — the catalogue's definitions and the
// bundle file's pipelines — and until this landing the panel named it exactly nowhere: the page shipped, a reader
// could not reach it. This file pins the two controls, and the three things that make them honest rather than
// decorative:
//
//   WHERE     the flow dialog's header bar (both modes) and one row in Settings > Pipeline — the two surfaces a
//             reader is looking at a pipeline on. Asserted by slicing: exactly one settings panel carries the one
//             anchor in the shell, `cardHtml()` builds the dialog's into its bar, and no other module links it.
//   TARGET    the href resolves to a file under public/, and that file's own title is the sentence the browser
//             proof follows the control to. A link to a 404 is the failure this file is written against.
//   NEW TAB   both carry target="_blank" and rel="noopener": the map is a second view of the same library, so
//             following it must not take the panel's own tab away or hand it a window.opener.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
// Checked out with the repo's line endings (CRLF on Windows), so every read is normalised: a source assertion must
// not fail because git rewrote a newline.
const dropCR = (text) => text.replaceAll(String.fromCharCode(13), "");
const read = (rel) => dropCR(readFileSync(path.join(PUBLIC, rel), "utf8"));

const HREF = "/pipeline-map.html";
const TITLE = "Every pipeline the panel can put a tree on";
const html = read("index.html");
const modal = read("pipeline-modal.js");
const LINK = `href="${HREF}"`;

// The anchors that point at the page — the control is a link, so a comment naming the file is not one.
const anchorsTo = (text) => [...text.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes(LINK));

// One settings panel's own block, cut at the NEXT group rather than at a guessed closing tag: a slice that runs to
// the end of the shell still holds the panel, while one cut on a sibling id is empty the day the block moves.
function settingsPanel(name) {
  const start = html.indexOf(`id="settings-panel-${name}"`);
  assert.ok(start > 0, `the ${name} settings panel is in the shell`);
  const next = html.indexOf('<div class="settings-group"', start + 10);
  return html.slice(start, next === -1 ? undefined : next);
}

const PANELS = [...html.matchAll(/<div class="settings-group" id="settings-panel-([a-z-]+)"/g)].map((m) => m[1]);

test("the Pipeline settings tab offers the map, and no other tab does", () => {
  assert.ok(PANELS.includes("pipeline"), `the Pipeline tab's panel is in the shell (found ${PANELS.join(", ")})`);
  const carriers = PANELS.filter((name) => anchorsTo(settingsPanel(name)).length > 0);
  assert.deepEqual(carriers, ["pipeline"], "exactly one settings panel carries the link — the tab that owns the catalogue");
  assert.equal(anchorsTo(html).length, 1, "and the shell carries it once, not once per tab");
  const [tag] = anchorsTo(settingsPanel("pipeline"));
  assert.match(tag, /id="pipeline-map-open"/, "with an id a harness (and a reader's devtools) can find");
  assert.match(tag, /target="_blank"/, "it opens its own tab");
  assert.match(tag, /rel="noopener"/, "and cannot reach back through window.opener");
  assert.match(tag, /open the map/i, "the words on the control name what it does");
});

test("the flow dialog's header bar carries the map, and the drawing does not", () => {
  const cardHtml = modal.slice(modal.indexOf("function cardHtml("), modal.indexOf("function paint("));
  assert.ok(cardHtml.length > 400, "cardHtml() is the one place the dialog's markup is built");
  const [tag] = anchorsTo(cardHtml);
  assert.ok(tag, "the dialog builds an anchor to the map");
  assert.match(tag, /data-pm-map/, "marked so a harness can find it beside the close control");
  assert.match(tag, /target="_blank"/, "it opens its own tab");
  assert.match(tag, /rel="noopener"/);
  const bar = cardHtml.slice(cardHtml.indexOf('class="pmodal-bar"'), cardHtml.indexOf('class="pmodal-body"'));
  assert.ok(bar.includes(tag), "the anchor sits in the bar, not under the drawing");
  // Scoped: the drawing and the board keep no link of their own.
  assert.equal(anchorsTo(read("pipeline-flow.js")).length, 0, "the renderer draws stages, not doors");
  assert.equal(anchorsTo(read("app.js")).length, 0, "the board links no pipeline page");
  assert.equal(anchorsTo(read("assistant.js")).length, 0, "and neither does the assistant pane");
});

test("the link is a page the panel serves, not a 404", () => {
  const file = path.join(PUBLIC, HREF.replace(/^\/+/, ""));
  assert.ok(existsSync(file), `${HREF} is a file under public/ — the target a reader's click lands on`);
  const page = dropCR(readFileSync(file, "utf8"));
  assert.match(page, new RegExp(`<title>${TITLE}`), "the page's own title is the sentence the control promises");
  assert.match(page, /<h1>/, "and it is a drawn page, not a placeholder");
  // One page, two doors: a third anchor would be a second idea of where the map lives.
  assert.equal(anchorsTo(html).length + anchorsTo(modal).length, 2, "two controls, one href, nothing else");
});
