// The top-count box's Enter key: the row that says how many worktrees a chart draws is a number field the reader types
// into, and Enter is how a field like that is committed. Every other number row in Settings already has the pair —
// `change` for the reader who leaves the box, `keydown`/Enter for the reader who does not — and this one was the only
// save-on-change number row in the settings panel without it, so the box could only be left by a click somewhere else.
//
// What the key press does, and why the blur is part of it: the save is async (POST /api/settings/chart-top), the field
// holds the focus until it is given up, and `paintTopSetting` deliberately leaves a FOCUSED box's text alone (a
// rejected save must not be repaired out of sight) — so a handler that only saved would leave the reader's typing
// half-committed on screen with nothing to say whether it took. The blur is what commits the gesture.
//
// The seam-free half of `tools/verify-chart-top-count.mjs`, which presses the key in a real browser over a sandbox panel
// and reads the panel's own config.json back. This test pins the wiring and its shape in the shipped source, which is
// the part a typo moves in silence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const ROW = "chart-top-count";

// The handler as the page carries it: from the `keydown` wiring for that id to its closing brace.
function handlerFor(id) {
  const start = app.indexOf(`$("${id}")?.addEventListener("keydown"`);
  if (start < 0) return null;
  const end = app.indexOf("});", start);
  assert.ok(end > start, `the ${id} keydown handler is closed`);
  return app.slice(start, end + 3);
}

test("the row is the number field the handler names", () => {
  const input = html.match(new RegExp(`<input id="${ROW}"[^>]*>`));
  assert.ok(input, `index.html still carries the #${ROW} input`);
  assert.match(input[0], /type="number"/, "it is a number field, so Enter is the natural commit");
  assert.match(input[0], /step="1"/, "whole rows");
});

test("the box saves on Enter, as every other number row in Settings does", () => {
  assert.ok(app.includes(`$("${ROW}")?.addEventListener("change"`), "the change listener is still the other way out");
  const handler = handlerFor(ROW);
  assert.ok(handler, `.${ROW} commits on Enter`);
  assert.match(handler, /if \(e\.key !== "Enter"\) return;/, "it claims Enter and nothing else");
  assert.match(handler, /e\.preventDefault\(\);/, "and swallows the key");
  assert.match(handler, /void saveTopSetting\(e\.target\.value\);/, "saving the number the reader typed");
  assert.match(handler, /e\.target\.blur\(\);/, "and giving the field up, which is what ends the gesture");
});

test("the blur comes after the save is started, not before it", () => {
  const handler = handlerFor(ROW);
  // Blurring first would fire the box's own `change` listener before this one had read the value — two saves, and
  // the second one racing the first over the same setting.
  assert.ok(handler.indexOf("saveTopSetting") < handler.indexOf(".blur()"), "the save is started before the field is given up");
});

test("every number row in Settings that saves on change pairs it with Enter the same way", () => {
  // The attributes are written in whichever order the row's author chose, so the tag is read whole and the two
  // attributes are looked for inside it rather than matched as a sequence.
  const ids = [...html.matchAll(/<input[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /type="number"/.test(tag))
    .map((tag) => (tag.match(/\bid="([^"]+)"/) || [])[1])
    .filter(Boolean);
  const paired = ids.filter(
    (id) => app.includes(`$("${id}")?.addEventListener("change"`) && app.includes(`$("${id}")?.addEventListener("keydown"`),
  );
  // The rows this invariant is about: the ones a reader types a number into and leaves. If a row drops out of this
  // list it has lost its Enter handling, which is the regression this test exists for.
  assert.ok(paired.includes(ROW), `${ROW} is in the paired list (${paired.join(", ")})`);
  assert.ok(paired.length >= 6, `the other number rows are still paired (${paired.join(", ")})`);
  for (const id of paired) {
    const handler = handlerFor(id);
    // Two shapes of the same idiom are already on main: `if (e.key !== "Enter") return;` (banner-seconds,
    // stream-words, stream-lines, rank-window) and `if (e.key === "Enter") { ... }` (reorder-every). Both claim the
    // key and swallow it, and which one a row uses is its own author's, so this pins the behaviour, not the wording.
    assert.match(handler, /"Enter"/, `${id} claims Enter`);
    assert.match(handler, /e\.preventDefault\(\)/, `${id} swallows the key`);
  }
});
