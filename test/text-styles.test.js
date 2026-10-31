// Three kinds of console text — the agent's reasoning, what a skill prints, and the rest of the console — each with
// its own colour and size in Settings > Display, and an empty line before every reasoning section.
//
// The mechanism is the page's, so this drives the page's own region (`// ---- text styles` … `// ---- end text
// styles` in public/app.js) against a stub root element and a stub localStorage, and reads the shipped markup and
// stylesheet for the rest. The browser half — the computed colours and sizes on a real console — is
// tools/verify-text-styles.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const src = read("public/app.js");
const html = read("public/index.html");
const css = read("public/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

const begin = src.indexOf("// ---- text styles");
const end = src.indexOf("// ---- end text styles");
assert.ok(begin > 0 && end > begin, "the text-style region is in public/app.js");
const region = src.slice(begin, end);

// A page just big enough for the region: the root element's style, the controls by id, a localStorage.
function page(seed = {}) {
  const store = new Map(Object.entries(seed));
  const vars = new Map();
  const controls = new Map();
  const control = (id, value = "") => {
    const c = { id, value, textContent: "" };
    controls.set(id, c);
    return c;
  };
  for (const id of ["think-color", "skill-color", "console-color"]) control(id);
  for (const id of ["think-size-select", "skill-size-select"]) control(id);
  for (const id of ["think-color-state", "skill-color-state", "console-color-state"]) control(id);
  const termCalls = [];
  const api = new vm.Script(`(function (document, localStorage, $, TERM_SIZES, applyTermStyle) { ${region}; return { TEXT_STYLES, applyTextStyle, resetTextStyle, textStyleColor, textStyleSize }; })`)
    .runInThisContext()(
      { documentElement: { style: { setProperty: (k, v) => vars.set(k, v), removeProperty: (k) => vars.delete(k) } } },
      {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => void store.set(k, String(v)),
        removeItem: (k) => void store.delete(k),
      },
      (id) => controls.get(id) || null,
      [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 18],
      (o) => termCalls.push(o),
    );
  return { ...api, store, vars, controls, termCalls };
}

test("Settings has one colour and one size for each of the three, and the console's size is the one it always had", () => {
  for (const id of ["think-color", "skill-color", "console-color"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} exists once`);
    assert.match(html, new RegExp(`<input id="${id}" type="color"`), `#${id} is a colour picker`);
  }
  for (const id of ["think-size-select", "skill-size-select", "term-size-select"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} exists once`);
    assert.match(html, new RegExp(`<select id="${id}"[^>]*>`), `#${id} is a size picker`);
  }
  // Console size moved INTO the Console text row: the old stand-alone row is gone, not duplicated.
  assert.doesNotMatch(html, /<span>Console size <span/, "no second, stand-alone Console size row");
  const row = html.match(/<div class="settings-row settings-gap" title="Console text[^"]*">([\s\S]*?)<\/div>/);
  assert.ok(row, "a Console text row");
  assert.match(row[1], /id="console-color"/);
  assert.match(row[1], /id="term-size-select"/, "the console's size sits beside its colour, under the id the page always used");
  assert.match(row[0], /title="Console text[^"]*Console size/, "and a search for Console size still finds it");
  for (const kind of ["think", "skill", "console"]) {
    assert.match(html, new RegExp(`data-text-reset="${kind}"`), `${kind} has a use-defaults button`);
    assert.match(html, new RegExp(`id="${kind}-preview"`), `${kind} has a preview drawn from its own variables`);
  }
});

test("the stylesheet reads each style with a fallback to the look the console already had", () => {
  assert.match(css, /\.jl-think\s*\{[^}]*color:\s*var\(--think-color,\s*#b3a8cc\)/, "the 🌊 stream's reasoning keeps its lavender");
  assert.match(css, /\.think-block\s*\{[^}]*color:\s*var\(--think-color,\s*var\(--dim\)\)/, "the 🧠 block keeps its dim");
  assert.match(css, /\.jl-think\s*\{[^}]*font-size:\s*var\(--think-font-size,\s*inherit\)/);
  assert.match(css, /\.think-block\s*\{[^}]*font-size:\s*var\(--think-size,\s*var\(--think-font-size,\s*12px\)\)/, "a card's own zoom still wins");
  assert.match(css, /\.jl-text\s*\{\s*color:\s*var\(--con-color,\s*#e6e9ef\)/);
  assert.match(css, /\.jl-tool-out\s*\{[^}]*color:\s*var\(--con-color,\s*var\(--dim\)\)/);
  assert.match(css, /\.jl-store\s*\{[^}]*color:\s*var\(--con-color,\s*var\(--dim\)\)/);
  // The skill box: its own colour, then the console's, then what the line was — and never a diff window's rows.
  assert.match(css, /\.code-box\.is-skill\s*>\s*\.code-body\s*>\s*\.jl\s*\{[^}]*color:\s*var\(--skill-color,\s*var\(--con-color,\s*var\(--dim\)\)\)/);
  assert.match(css, /\.code-box\.is-skill\s*>\s*\.code-body\s*\{[^}]*font-size:\s*var\(--skill-font-size,\s*inherit\)/);
  // None of the three variables has a value in :root: unset is the default, and "use defaults" is removing the property.
  const rootBlock = css.match(/:root\s*\{([^}]*)\}/)[1];
  for (const v of ["--think-color", "--think-font-size", "--skill-color", "--skill-font-size", "--con-color"]) {
    assert.doesNotMatch(rootBlock, new RegExp(`${v}\\s*:`), `${v} is not given a value in :root`);
  }
});

test("an empty line stands before every reasoning section, in the stream and in the block", () => {
  const stream = css.match(/\.jl-think\s*\{([^}]*)\}/)[1];
  assert.match(stream, /margin-top:\s*1\.5em/, "one console line (line-height 1.5) above each reasoning line of the stream");
  assert.match(css, /\.job-out\s*>\s*\.jl-think:first-child\s*\{\s*margin-top:\s*0/, "but not above the very first line of a console");
  assert.match(css, /\.think-block\s*\+\s*\.think-block\s*\{\s*margin-top:\s*1\.5em/, "between the blocks of the 🧠 block");
  const block = css.match(/\n\.think\s*\{([^}]*)\}/)[1];
  assert.match(block, /margin:\s*18px 0 8px/, "and above the 🧠 block itself, where the old gap was 6px");
});

test("a skill's box says it is a skill's, and only a skill's does", async () => {
  const context = vm.createContext({
    window: {},
    console,
    document: { getElementById: () => null },
    state: { projects: new Map() },
    normPath: (p) => String(p ?? "").split("\\").join("/").replace(/\/+$/, ""),
  });
  for (const file of ["public/core/dom-format.js", "public/core/console-format.js"]) vm.runInContext(read(file), context, { filename: file });
  const CF = context.window.WMApp.core.consoleFormat;
  const lines = ["# pdf", "Create, read and merge PDF files"].map((text, i) => ({ kind: "tool-out", text, lid: 1 + i }));
  for (const tool of ["skill_view", "skills_list", "skill_manage"]) {
    assert.match(CF.bodyHtml(lines, { tool }), /<div class="code-box is-out is-skill"/, `${tool} output is a skill box`);
  }
  for (const tool of ["terminal", "read_file", "memory", ""]) {
    assert.doesNotMatch(CF.bodyHtml(lines, { tool }), /is-skill/, `${tool || "(unknown)"} output is not`);
  }
  // The pacer's predicate is the one source of truth when the page has it: widening it widens the box.
  vm.runInContext('globalThis.wtType = { isPacedTool: (t) => t === "my_tool" };', context);
  assert.match(CF.bodyHtml(lines, { tool: "my_tool" }), /is-skill/);
  assert.doesNotMatch(CF.bodyHtml(lines, { tool: "skill_view" }), /is-skill/);
});

test("a choice sets a variable on the root, shows in its control and is remembered; defaults remove it", () => {
  const p = page();
  p.applyTextStyle("think", { save: true, color: "#ff8800", size: 14 });
  assert.equal(p.vars.get("--think-color"), "#ff8800");
  assert.equal(p.vars.get("--think-font-size"), "14px");
  assert.equal(p.controls.get("think-color").value, "#ff8800");
  assert.equal(p.controls.get("think-color-state").textContent, "#ff8800", "the row names the colour in force");
  assert.equal(p.controls.get("think-size-select").value, "14");
  assert.equal(p.store.get("wtgui.thinkColor"), "#ff8800");
  assert.equal(p.store.get("wtgui.thinkSize"), "14");
  // The other two are untouched: three styles, three sets of keys.
  assert.equal(p.vars.has("--skill-color"), false);
  assert.equal(p.vars.has("--con-color"), false);

  p.resetTextStyle("think");
  assert.equal(p.vars.has("--think-color"), false, "defaults is the property removed, not the old value written back");
  assert.equal(p.vars.has("--think-font-size"), false);
  assert.equal(p.store.has("wtgui.thinkColor"), false);
  assert.equal(p.store.has("wtgui.thinkSize"), false);
  assert.equal(p.controls.get("think-color-state").textContent, "default");
  assert.equal(p.controls.get("think-color").value, "#b3a8cc", "the picker shows the colour the default really is");
  assert.equal(p.controls.get("think-size-select").value, "", "and the size says Default");
});

test("the three are independent, and a saved choice comes back on the next load", () => {
  const first = page();
  first.applyTextStyle("skill", { save: true, color: "#33cc99", size: 13 });
  first.applyTextStyle("console", { save: true, color: "#ffffff" });
  const second = page(Object.fromEntries(first.store));
  for (const kind of Object.keys(second.TEXT_STYLES)) second.applyTextStyle(kind);
  assert.equal(second.vars.get("--skill-color"), "#33cc99");
  assert.equal(second.vars.get("--skill-font-size"), "13px");
  assert.equal(second.vars.get("--con-color"), "#ffffff");
  assert.equal(second.vars.has("--think-color"), false, "reasoning was never touched");
});

test("only a value the panel offers is applied or kept", () => {
  const p = page({ "wtgui.thinkColor": "red; background: url(x)", "wtgui.thinkSize": "999", "wtgui.skillColor": "#ABCDEF" });
  p.applyTextStyle("think");
  p.applyTextStyle("skill");
  assert.equal(p.vars.has("--think-color"), false, "a hand-edited colour is not written into a stylesheet");
  assert.equal(p.vars.has("--think-font-size"), false, "nor a size the picker does not have");
  assert.equal(p.vars.get("--skill-color"), "#abcdef", "a valid colour is accepted and lower-cased");
  p.applyTextStyle("think", { save: true, color: "javascript:alert(1)", size: 7 });
  assert.equal(p.vars.has("--think-color"), false);
  assert.equal(p.store.has("wtgui.thinkColor"), false, "and refused input is not stored either");
});

test("the console's colour has no size of its own here: its size is Console size, and defaults puts both back", () => {
  const p = page();
  assert.equal(p.TEXT_STYLES.console.sizeKey, undefined);
  p.applyTextStyle("console", { save: true, color: "#00ff00", size: 18 });
  assert.equal(p.vars.has("--term-size"), false, "this region never writes the console size: applyTermStyle owns it");
  assert.equal(p.vars.has("--console-font-size"), false);
  p.resetTextStyle("console");
  assert.equal(p.vars.has("--con-color"), false);
  assert.deepEqual(p.termCalls, [{ save: true, size: 11.5 }], "defaults puts the console size back to the 11.5px it always had");
});

test("the page wires every control, and the pickers are filled at start-up", () => {
  assert.match(src, /for \(const \[kind, set\] of Object\.entries\(TEXT_STYLES\)\)/);
  assert.match(src, /addEventListener\("input", \(e\) => applyTextStyle\(kind, \{ color: e\.target\.value \}\)\)/, "the colour follows the picker while it is dragged");
  assert.match(src, /addEventListener\("change", \(e\) => applyTextStyle\(kind, \{ save: true, color: e\.target\.value \}\)\)/, "and is saved when it settles");
  assert.match(src, /\[data-text-reset\]/);
  const init = src.slice(src.indexOf("function initFonts()"), src.indexOf("// Paint the saved question-box look"));
  assert.match(init, /<option value="">Default<\/option>/, "the reasoning and skill sizes offer Default");
  assert.match(init, /applyTextStyle\(kind\)/, "the saved look is painted before the first card is drawn");
});
