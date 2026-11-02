// Three kinds of console text — the agent's reasoning, what a skill prints, and the rest of the console — each with
// its own colour in Settings > Display, ONE size shared by the reasoning, the console's own words and a tool's output,
// and an empty line before every reasoning section.
//
// The mechanism is the page's, so this drives the page's own region (`// ---- text styles` … `// ---- end text
// styles` in public/app.js) against a stub root element and a stub localStorage, and reads the shipped markup and
// stylesheet for the rest. The browser half — the computed colours and sizes on a real console, and what Ctrl+wheel
// does to them — is tools/verify-text-styles.mjs and tools/verify-console-zoom.mjs.
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
  for (const id of ["skill-size-select"]) control(id);
  for (const id of ["think-color-state", "skill-color-state", "console-color-state"]) control(id);
  const termCalls = [];
  const api = new vm.Script(`(function (document, localStorage, $, TERM_SIZES, applyTermStyle) { ${region}; return { TEXT_STYLES, applyTextStyle, resetTextStyle, retireTextStyleSize, textStyleColor, textStyleSize }; })`)
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

// The last `font-size` a selector's own rule asks for, which is the one the cascade gives it among these
// single-class rules. The stylesheet is shipped text, so this reads it rather than trusting a second copy.
function fontSizeOf(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g");
  let decl = null;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const d = /font-size:\s*([^;}]+)/.exec(m[1]);
    if (d) decl = d[1].trim();
  }
  return decl;
}

// What a declaration computes to, given the custom properties in force. `var(--x, fallback)` resolves to the
// property when it is set and to the fallback when it is not — the same rule the browser applies.
function computedSize(decl, vars) {
  const m = /^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/.exec(decl || "");
  if (!m) return decl;
  if (Object.hasOwn(vars, m[1])) return vars[m[1]];
  return m[2] ? m[2].trim() : null;
}

const CONSOLE_TEXT = ["normal output", ".job-out"];
const REASONING_TEXT = ["reasoning", ".jl-think"];
const REASONING_BLOCK = ["reasoning (the 🧠 block, which carries .mono)", ".think-block.mono"];
const REASONING_BLOCK_BARE = ["the 🧠 block's own rule", ".think-block"];
const TOOL_OUTPUT = ["a tool's output", ".jl-tool-out"];
const THREE = [CONSOLE_TEXT, REASONING_TEXT, TOOL_OUTPUT];

test("Settings has one size picker for the console, and it is the one reasoning and tool output read too", () => {
  for (const id of ["think-color", "skill-color", "console-color"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} exists once`);
    assert.match(html, new RegExp(`<input id="${id}" type="color"`), `#${id} is a colour picker`);
  }
  // ONE size knob: the console's. The Thinking text row used to carry a second one, and it is gone rather than
  // hidden, so nothing can set the reasoning to a size the console's output does not follow.
  assert.doesNotMatch(html, /think-size-select/, "reasoning has no size picker of its own");
  for (const id of ["skill-size-select", "term-size-select"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} exists once`);
    assert.match(html, new RegExp(`<select id="${id}"[^>]*>`), `#${id} is a size picker`);
  }
  assert.doesNotMatch(html, /<span>Console size <span/, "no second, stand-alone Console size row");
  const row = html.match(/<div class="settings-row settings-gap" title="Console text[^"]*">([\s\S]*?)<\/div>/);
  assert.ok(row, "a Console text row");
  assert.match(row[1], /id="console-color"/);
  assert.match(row[1], /id="term-size-select"/, "the console's size sits beside its colour, under the id the page always used");
  assert.match(row[0], /title="Console text[^"]*Console size/, "and a search for Console size still finds it");
  // ...and it SAYS it sizes the reasoning, so the removed picker is not a mystery.
  const think = html.match(/<div class="settings-row settings-gap" title="Thinking text[^"]*">/);
  assert.ok(think, "a Thinking text row");
  assert.match(think[0], /Its SIZE is the console's own/, "the row points at the one size");
  for (const kind of ["think", "skill", "console"]) {
    assert.match(html, new RegExp(`data-text-reset="${kind}"`), `${kind} has a use-defaults button`);
    assert.match(html, new RegExp(`id="${kind}-preview"`), `${kind} has a preview drawn from its own variables`);
  }
});

test("the stylesheet reads each style's colour with a fallback, and one size for all three kinds of text", () => {
  assert.match(css, /\.jl-think\s*\{[^}]*color:\s*var\(--think-color,\s*#b3a8cc\)/, "the 🌊 stream's reasoning keeps its lavender");
  assert.match(css, /\.think-block\s*\{[^}]*color:\s*var\(--think-color,\s*var\(--dim\)\)/, "the 🧠 block keeps its dim");
  assert.match(css, /\.jl-text\s*\{\s*color:\s*var\(--con-color,\s*#e6e9ef\)/);
  assert.match(css, /\.jl-tool-out\s*\{[^}]*color:\s*var\(--con-color,\s*var\(--dim\)\)/);
  assert.match(css, /\.jl-store\s*\{[^}]*color:\s*var\(--con-color,\s*var\(--dim\)\)/);
  // The skill box: its own colour, then the console's, then what the line was — and never a diff window's rows.
  assert.match(css, /\.code-box\.is-skill\s*>\s*\.code-body\s*>\s*\.jl\s*\{[^}]*color:\s*var\(--skill-color,\s*var\(--con-color,\s*var\(--dim\)\)\)/);
  assert.match(css, /\.code-box\.is-skill\s*>\s*\.code-body\s*\{[^}]*font-size:\s*var\(--skill-font-size,\s*inherit\)/);
  // None of the colour variables has a value in :root: unset is the default, and "use defaults" is removing it.
  const rootBlock = css.match(/:root\s*\{([^}]*)\}/)[1];
  for (const v of ["--think-color", "--skill-color", "--skill-font-size", "--con-color", "--think-font-size"]) {
    assert.doesNotMatch(rootBlock, new RegExp(`${v}\\s*:`), `${v} is not given a value in :root`);
  }
  // There is no second console size left anywhere in the sheet: no per-kind var, no per-kind fallback.
  assert.doesNotMatch(css, /--out-size|--think-size\b|--think-font-size/, "one size variable, and no retired ones");
});

test("the three kinds of console text compute the SAME font-size, at the default and at a card's zoom", () => {
  const decls = Object.fromEntries([...THREE, REASONING_BLOCK_BARE, REASONING_BLOCK].map(([, sel]) => [sel, fontSizeOf(sel)]));
  for (const [what, sel] of [...THREE, REASONING_BLOCK_BARE, REASONING_BLOCK]) {
    assert.equal(decls[sel], "var(--term-size)", `${what} (${sel}) asks for the console's one size`);
  }
  // "compute", not "name": resolve the shipped declarations the way the browser does, over the two values in force
  // — the default, and what a card's Ctrl+wheel writes on the card.
  for (const inForce of ["11.5px", "14px"]) {
    const sizes = THREE.map(([what, sel]) => [what, computedSize(decls[sel], { "--term-size": inForce })]);
    assert.deepEqual(new Set(sizes.map(([, px]) => px)), new Set([inForce]), `all three compute ${inForce}: ${JSON.stringify(sizes)}`);
  }
  // A card's zoom is the SAME variable, not a parallel one that happens to agree today.
  assert.match(src, /card\.style\.setProperty\("--term-size"/, "Ctrl+wheel writes the one size on the card");
});

test("a reasoning colour sets a variable on the root, shows in its control and is remembered; defaults remove it", () => {
  const p = page();
  p.applyTextStyle("think", { save: true, color: "#ff8800" });
  assert.equal(p.vars.get("--think-color"), "#ff8800");
  assert.equal(p.controls.get("think-color").value, "#ff8800");
  assert.equal(p.controls.get("think-color-state").textContent, "#ff8800", "the row names the colour in force");
  assert.equal(p.store.get("wtgui.thinkColor"), "#ff8800");
  assert.equal(p.vars.has("--think-font-size"), false, "reasoning never writes a size: it is the console's");
  assert.equal(p.store.has("wtgui.thinkSize"), false, "and keeps no size of its own");
  // The other two are untouched: three styles, three sets of keys.
  assert.equal(p.vars.has("--skill-color"), false);
  assert.equal(p.vars.has("--con-color"), false);

  p.resetTextStyle("think");
  assert.equal(p.vars.has("--think-color"), false, "defaults is the property removed, not the old value written back");
  assert.equal(p.store.has("wtgui.thinkColor"), false);
  assert.equal(p.controls.get("think-color-state").textContent, "default");
  assert.equal(p.controls.get("think-color").value, "#b3a8cc", "the picker shows the colour the default really is");
});

test("the three colours are independent, and a saved choice comes back on the next load", () => {
  const first = page();
  first.applyTextStyle("skill", { save: true, color: "#33cc99", size: 13 });
  first.applyTextStyle("console", { save: true, color: "#ffffff" });
  const second = page(Object.fromEntries(first.store));
  for (const kind of Object.keys(second.TEXT_STYLES)) second.applyTextStyle(kind);
  assert.equal(second.vars.get("--skill-color"), "#33cc99");
  assert.equal(second.vars.get("--skill-font-size"), "13px", "a skill box keeps its own size and colour");
  assert.equal(second.vars.get("--con-color"), "#ffffff");
  assert.equal(second.vars.has("--think-color"), false, "reasoning was never touched");
  assert.equal(second.vars.has("--think-font-size"), false);
});

test("only a value the panel offers is applied or kept", () => {
  const p = page({ "wtgui.thinkColor": "red; background: url(x)", "wtgui.thinkSize": "999", "wtgui.skillColor": "#ABCDEF" });
  p.applyTextStyle("think");
  p.applyTextStyle("skill");
  assert.equal(p.vars.has("--think-color"), false, "a hand-edited colour is not written into a stylesheet");
  assert.equal(p.vars.has("--think-font-size"), false, "nor a size nothing reads");
  assert.equal(p.vars.get("--skill-color"), "#abcdef", "a valid colour is accepted and lower-cased");
  p.applyTextStyle("think", { save: true, color: "javascript:alert(1)", size: 7 });
  assert.equal(p.vars.has("--think-color"), false);
  assert.equal(p.store.has("wtgui.thinkColor"), false, "and refused input is not stored either");
});

test("reasoning and the console have no size of their own here: Console size is the size, and defaults puts it back", () => {
  const p = page();
  assert.equal(p.TEXT_STYLES.console.sizeKey, undefined);
  assert.equal(p.TEXT_STYLES.think.sizeKey, undefined, "reasoning reads the console size, so it has no size key");
  assert.equal(p.TEXT_STYLES.think.size, undefined, "and no picker to write one with");
  p.applyTextStyle("think", { save: true, color: "#ff8800", size: 18 });
  p.applyTextStyle("console", { save: true, color: "#00ff00", size: 18 });
  assert.equal(p.vars.has("--term-size"), false, "this region never writes the console size: applyTermStyle owns it");
  assert.equal(p.vars.has("--console-font-size"), false);
  p.resetTextStyle("console");
  assert.equal(p.vars.has("--con-color"), false);
  assert.deepEqual(p.termCalls, [{ save: true, size: 11.5 }], "defaults puts the console size back to the 11.5px it always had");
});

test("a stored Thinking size from the retired row is dropped, not left pretending to apply", () => {
  const p = page({ "wtgui.thinkSize": "15", "wtgui.skillSize": "13" });
  p.retireTextStyleSize("think");
  assert.equal(p.store.has("wtgui.thinkSize"), false, "the reasoning size key is gone");
  p.retireTextStyleSize("skill");
  assert.equal(p.store.get("wtgui.skillSize"), "13", "a kind that still owns a size keeps it");
});

test("Ctrl+wheel writes that one variable on the card, and the card re-emits it on every repaint", () => {
  assert.match(src, /getComputedStyle\(card\)\.getPropertyValue\("--term-size"\)/, "the step starts from the one size in force");
  assert.match(src, /card\.style\.setProperty\("--term-size", `\$\{next\}px`\)/);
  assert.match(src, /const zoom = state\.consoleZoom\.get\(thread\);\s*\n\s*const sizeVars = zoom \? `--term-size:\$\{zoom\}px` : ""/, "a rebuilt card carries its zoom back");
  // One step per gesture, wherever in the card the wheel was: normal output, a tool's output and the 🧠 block all
  // resolve to the same selector list and the same write.
  assert.match(src, /const zone = target \? target\.closest\("\.job-out, \.think-body"\) : null;/);
  assert.equal(src.split("zoomConsole(zone, e.deltaY < 0 ? 1 : -1);").length - 1, 1, "one size change per wheel event");
  assert.doesNotMatch(src, /--out-size|--think-size\b|thinkZoom|THINK_ZOOM/, "and no second knob survives in the page either");
});

test("the page wires every control, fills the pickers at start-up and retires the size that is gone", () => {
  assert.match(src, /for \(const \[kind, set\] of Object\.entries\(TEXT_STYLES\)\)/);
  assert.match(src, /addEventListener\("input", \(e\) => applyTextStyle\(kind, \{ color: e\.target\.value \}\)\)/, "the colour follows the picker while it is dragged");
  assert.match(src, /addEventListener\("change", \(e\) => applyTextStyle\(kind, \{ save: true, color: e\.target\.value \}\)\)/, "and is saved when it settles");
  assert.match(src, /\[data-text-reset\]/);
  const init = src.slice(src.indexOf("function initFonts()"), src.indexOf("// Paint the saved question-box look"));
  assert.match(init, /<option value="">Default<\/option>/, "the skill size still offers Default");
  assert.match(init, /retireTextStyleSize\(kind\)/, "the retired reasoning size is cleared on start-up");
  assert.match(init, /applyTextStyle\(kind\)/, "the saved look is painted before the first card is drawn");
});

test("an empty line stands before every reasoning section, in the stream and in the block", () => {
  // In the stream the reasoning row is a piece like any other: the blank line above it is the stream's own `jl-sep`
  // rule, which every piece wears — one rule, so a reasoning row, a tool group and a chunk of prose cannot drift into
  // three different gaps. The reasoning line's own rule is its VOICE only.
  const sep = css.match(/\.job-out\s*>\s*\.jl-sep\s*\{([^}]*)\}/)[1];
  assert.match(sep, /margin-top:\s*1\.5em/, "one console line (line-height 1.5) above every piece of the stream");
  assert.doesNotMatch(css.match(/\n\.jl-think\s*\{([^}]*)\}/)[1], /margin-top/, "the reasoning row adds no second gap of its own");
  assert.match(css, /\.job-out\s*>\s*\.jl-sep:first-child\s*\{\s*margin-top:\s*0/, "but not above the very first piece of a console");
  assert.match(css, /\.think-block\s*\+\s*\.think-block\s*\{\s*margin-top:\s*1\.5em/, "between the blocks of the 🧠 block");
  const block = css.match(/\n\.think\s*\{([^}]*)\}/)[1];
  assert.match(block, /margin:\s*18px 0 8px/, "and above the 🧠 block itself, where the old gap was 6px");
  // The rule has to win over a flat piece's own `margin: 0`, or a tool group would get no blank line above it at all.
  const flatAt = css.indexOf(".tgrp.tgrp-flat {");
  const sepAt = css.indexOf(".job-out > .jl-sep {");
  assert.ok(flatAt >= 0 && sepAt > flatAt, "the stream's blank line is declared after the flat piece's margin: 0");
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
