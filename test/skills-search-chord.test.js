// Ctrl+Shift+S opens the general Skills tab and leaves the caret in its own bar. This is the STATIC half of that
// proof, and it is a test rather than a paragraph because the claim decays: a later feature can bind the chord, a
// repaint can drop the bar out of the panel's chrome, or a second filter can grow beside the first and disagree
// with it, and nothing else would notice.
//
// WHAT IS PINNED
//
//   * ONE chord, in public/assistant.js's single window keydown listener: !e.repeat, ctrlKey && shiftKey,
//     !altKey && !metaKey, matched on the key AND the code, and the default refused - so the browser's Save-As never
//     opens on top of the panel.
//   * the chord is INERT while the caret is in an input, textarea or contenteditable: the guard runs before the call,
//     so a capital S in a composer can never tab-jump.
//   * the bar is the Skills PANEL's own chrome (inside #settings-panel-skills, marked data-skills-chrome), its
//     placeholder names the two fields the filter reads first, and a no-hit line ships with it.
//   * there is ONE filter: the bar writes into #settings-search and calls the same paintSettingsSearch with the
//     skills scope. The tab that paints the no-hit sentence is the Skills tab's own, because the search region is
//     pinned to class-only work by test/settings-tabs.test.js.
//
// The other half is a real press in a real page: tools/verify-skills-search-chord.mjs drives the chord from a board
// row, a run's console and the assistant's queue, and reads document.activeElement and the rendered rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
const assistant = read("public/assistant.js");
const app = read("public/app.js");
const html = read("public/index.html");
const css = read("public/style.css");

// The branch, from its own condition through the `return;` that ends it - the same shape the hot-agent binding test
// reads, widened to the whole block so the guard and the call are both inside the window that is judged.
function chordBranch() {
  const at = assistant.indexOf('if (!e.repeat && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "s"');
  assert.ok(at > 0, "public/assistant.js declares the Ctrl+Shift+S chord");
  const end = assistant.indexOf("\n    }\n", at);
  assert.ok(end > at, "the branch has its own closing brace, so it is one block in the handler");
  return { at, end, text: assistant.slice(at, end) };
}

test("exactly one place in the page binds Ctrl+Shift+S", () => {
  const owners = [];
  for (const rel of ["public/app.js", "public/assistant.js", "public/settings.js", "public/render-jobs.js", "public/render-projects.js"]) {
    if (new RegExp(`KeyS|["']s["']|["']S["']`).test(read(rel).split("\n").filter((line) => /ctrlKey/.test(line) && !line.trim().startsWith("//")).join("\n"))) {
      owners.push(rel);
    }
  }
  assert.deepEqual(owners, ["public/assistant.js"], "one owner, so one press cannot be answered twice");
});

test("the chord is a full chord: no repeat, ctrl+shift, no alt/meta, key and code", () => {
  const { text } = chordBranch();
  assert.match(text, /!e\.repeat/);
  assert.match(text, /e\.ctrlKey && e\.shiftKey && !e\.altKey && !e\.metaKey/);
  assert.match(text, /e\.key === "s" \|\| e\.key === "S"/);
  assert.match(text, /e\.code === "KeyS"/);
  assert.ok(text.indexOf("preventDefault();") >= 0, "the default is refused, so Save-As never opens over the panel");
});

test("the chord does nothing while the caret is in a field, and the guard runs before the call", () => {
  const { text } = chordBranch();
  const guard = text.indexOf("inTextField(e.target) || inTextField(document.activeElement)");
  const call = text.indexOf("window.__openSkillsSearch");
  assert.ok(guard > 0, "an input, textarea or contenteditable disqualifies the chord");
  assert.ok(call > guard, "the field guard is read before anything opens");
  // inTextField is the panel's definition of "the reader is typing": contenteditable plus the three tags a caret
  // can live in. A guard that only knew textarea would tab-jump out of a composer.
  assert.match(assistant, /function inTextField\(node\) \{[\s\S]{0,600}?isContentEditable/);
  assert.match(assistant, /function inTextField\(node\) \{[\s\S]{0,600}?\^\(INPUT\|TEXTAREA\|SELECT\)\$/);
});

test("the chord lives in the one window keydown listener, and the app answers it by name", () => {
  const listener = assistant.indexOf('window.addEventListener("keydown"');
  const { at } = chordBranch();
  assert.ok(listener > 0 && at > listener, "the chord is inside the page's one key listener");
  assert.match(app, /window\.__openSkillsSearch = focusSkillsSearch;/, "app.js publishes the opener the chord calls");
  assert.match(assistant, /typeof open === "function"/, "the chord refuses to throw when the opener is absent");
});

test("the opener lands on Settings, selects Skills and puts the caret in the bar", () => {
  const at = app.indexOf("function focusSkillsSearch()");
  assert.ok(at > 0, "app.js defines focusSkillsSearch");
  const body = app.slice(at, app.indexOf("\n}\n", at));
  assert.match(body, /toggleSettings\(true\)/, "a closed window is opened");
  assert.match(body, /selectSettingsTab\("skills"\)/, "a window on another tab is switched to Skills");
  assert.match(body, /bar\.focus\(\)/, "the caret lands in the bar");
});

test("the bar is the Skills panel's own chrome, not a row the filter can hide", () => {
  const panelAt = html.indexOf('<div class="settings-group" id="settings-panel-skills"');
  assert.ok(panelAt > 0, "the Skills panel is static markup");
  const panel = html.slice(panelAt, html.indexOf('<div class="settings-group"', panelAt + 10));
  assert.match(panel, /id="skills-search"/, "the bar ships inside the Skills panel");
  assert.match(panel, /data-skills-chrome="1"/, "the bar is chrome the filter walks past");
  assert.match(panel, /id="skills-no-hits"[^>]*data-skills-chrome="1"[^>]*hidden/, "the no-hit line ships hidden, as chrome");
  const bar = panel.slice(panel.indexOf('id="skills-search"'), panel.indexOf('id="btn-skills-search-clear"'));
  assert.match(bar, /placeholder="filter skills by name or description"/, "the placeholder names what it searches");
  const placeholder = bar.match(/placeholder="([^"]+)"/)[1];
  assert.match(placeholder, /name/);
  assert.match(placeholder, /description/);
  assert.match(panel, /id="btn-skills-search-clear"/, "one control clears it beside the bar");
});

test("one filter, one query: the bar writes the window search's box and runs the same painter", () => {
  const at = app.indexOf("function initSkillsSearch()");
  assert.ok(at > 0, "app.js wires the bar once");
  const body = app.slice(at, app.indexOf("\n}\n", at));
  assert.match(body, /bar\.addEventListener\("input", repaint\)/);
  assert.match(body, /box\.value = bar\.value/, "typing in the bar writes the ONE query into #settings-search");
  assert.match(body, /paintSettingsSearch\(\{ scope: "skills" \}\)/, "and repaints through the window's one painter");
  assert.match(body, /e\.stopPropagation\(\)/, "Esc with text in the bar does not also close Settings");
  // The painter itself takes the skills scope and keeps the reader on the tab they typed on.
  const paintAt = app.indexOf("function paintSettingsSearch({ scope = \"window\" } = {})");
  assert.ok(paintAt > 0, "paintSettingsSearch takes a scope");
  assert.match(app.slice(paintAt, paintAt + 4200), /scope !== "skills" && first/, "a skills query never jumps the reader to another tab");
  // The no-hit sentence is the Skills tab's own: the search region is class-only work (test/settings-tabs).
  assert.match(app.slice(paintAt, paintAt + 4200), /paintSkillsSearchState\(query, counts\.get\("skills"\) \|\| 0\)/, "the bar is kept in step on every search paint");
  assert.match(app, /function paintSkillsNoHits\(query, hits\) \{[\s\S]{0,700}?no skill matches/);
});

test("the styles the bar and the no-hit line need are in style.css", () => {
  assert.match(css, /\.skills-search-row \{/);
  assert.match(css, /\.skills-search-row input\[type="search"\]/);
  assert.match(css, /\.skills-search-row #btn-skills-search-clear\[hidden\]/);
  assert.match(css, /\.skills-nohits \{[^}]*border:[^}]*\}/);
});
