// The seam-free half of `tools/verify-console-fonts.mjs` (npm test has no layout engine and no browser): the two font
// lists as the page ships them, and the row-spacing setting's store, clamp and save rules, read out of public/app.js
// and driven over a small page.
//
// Why it exists. Both lists were written as STACKS from memory of what a developer machine might have, so an entry
// could name a face the box has never had and quietly draw the next one: sixteen console entries drew five pictures,
// nine of them Consolas under another name. Nothing in the suite noticed, because a name in an array looks fine. This
// test asserts the properties that make a list honest without a browser - one id per entry, no entry without a stack,
// every retired id pointing at a live one, and a picker label that says which face an entry RESOLVES to - and the
// browser half (`node tools/verify-console-fonts.mjs`) is what proves each name against a real paint.
//
// The row spacing is one multiplier, `--con-row-space`, on the console's line-height, with 1.5 as its fallback: the
// number this console has always used. The suite pins the store key, the range, the "save on change, not on drag" rule
// and "use defaults", so the setting cannot move the console's default look without a test saying so.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const page = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = page("public/style.css");
const html = page("public/index.html");
const src = page("public/app.js");

// The fonts block runs from its own heading to the text styles that follow it: the lists, the retired ids, the picker
// label, the sets, the store read, and then the row-spacing setting. One region, because they share `termSize()`.
const REGION = (() => {
  const from = src.indexOf("// ---- fonts: two settings, not one");
  const to = src.indexOf("// ---- text styles:");
  assert.ok(from > 0, "public/app.js still carries the fonts block");
  assert.ok(to > from, "the fonts block still ends where the text styles begin");
  return src.slice(from, to);
})();

// A page small enough to drive: the store, the two elements the spacing row repaints, and the root's style.
// `const` declarations do not land on a vm context the way function declarations do, so the region ends by handing
// its own names out; from this side they read as `page.UI_FONTS`, `page.applyConRowSpace(...)` and so on.
const EXPORTS = `
;globalThis.__page = { UI_FONTS, TERM_FONTS, FONT_RETIRED, FONT_SETS, conRowSpace, clampConRow, applyConRowSpace,
  resetConRowSpace, initConRowSpace, paintConRowSpace, currentFontId, fontOptionLabel, withEmojiFallback };
`;
function makePage({ stored = {} } = {}) {
  const vars = new Map();
  const writes = [];
  const store = { ...stored };
  const els = {
    "con-row-space": { id: "con-row-space", value: "", tagName: "INPUT" },
    "con-row-space-px": { id: "con-row-space-px", textContent: "" },
  };
  const ctx = vm.createContext({
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? String(store[k]) : null),
      setItem: (k, v) => {
        writes.push({ key: k, value: String(v) });
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
    document: {
      documentElement: { style: { setProperty: (k, v) => vars.set(String(k), String(v)) } },
      activeElement: null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    $: (id) => els[id] || null,
    console,
  });
  vm.runInContext(REGION + EXPORTS, ctx);
  return { ctx: ctx.__page, vars, writes, store, els };
}

// ---- the two lists --------------------------------------------------------------------------------------------
test("no two entries in a list share an id, and every entry carries a label and a stack", () => {
  const { ctx } = makePage();
  for (const kind of ["UI_FONTS", "TERM_FONTS"]) {
    const list = ctx[kind];
    assert.ok(Array.isArray(list) && list.length >= 2, `${kind} is a list of entries`);
    const ids = list.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, `${kind} has one id per entry: ${ids.join(", ")}`);
    for (const f of list) {
      assert.ok(String(f.label || "").trim(), `${kind}/${f.id} has a label`);
      assert.ok(String(f.stack || "").trim(), `${kind}/${f.id} has a stack`);
      // A stack either names a family or defers to another setting's variable. Nothing else is acceptable: an empty
      // first term is how "JetBrains Mono" used to sit in the list drawing Consolas.
      const first = String(f.stack).split(",")[0].trim();
      assert.ok(/^["']?[\w .-]+["']?$/.test(first) || /^var\(--[\w-]+\)$/.test(first), `${kind}/${f.id} starts with a family or a variable: "${first}"`);
    }
  }
});

test("every face the list used to promise and the box did not have is gone, and its id falls forward", () => {
  const { ctx } = makePage();
  const termIds = ctx.TERM_FONTS.map((f) => f.id);
  // These nine all painted Consolas: they were one picture under nine names.
  for (const gone of ["jetbrains", "fira", "source-code", "ibm-plex", "inconsolata", "victor", "hack", "menlo", "consolas"]) {
    assert.ok(!termIds.includes(gone), `TERM_FONTS no longer offers "${gone}" - it drew Consolas, which "default" already draws`);
  }
  assert.ok(!ctx.UI_FONTS.some((f) => f.id === "segoe"), 'UI_FONTS no longer offers "segoe" - it drew the same face as "default"');
  assert.ok(!ctx.UI_FONTS.some((f) => f.id === "jetbrains"), 'UI_FONTS no longer offers "jetbrains" - it drew Consolas, which "consolas" already offers');
  // A reader whose stored choice was one of them keeps the picture they had: the retired table names a live entry.
  for (const kind of ["ui", "term"]) {
    const live = (kind === "ui" ? ctx.UI_FONTS : ctx.TERM_FONTS).map((f) => f.id);
    for (const [retired, to] of Object.entries(ctx.FONT_RETIRED[kind])) {
      assert.ok(live.includes(to), `FONT_RETIRED.${kind}.${retired} points at a live entry ("${to}")`);
      assert.ok(!live.includes(retired), `FONT_RETIRED.${kind} only lists ids that are gone ("${retired}" is still offered)`);
    }
  }
});

test("a stored retired id is read as the entry that draws what it drew, and an unknown id as the default", () => {
  for (const [kind, retired, want, key] of [
    ["term", "fira", "default", "wtgui.termFont"],
    ["term", "consolas", "default", "wtgui.termFont"],
    ["ui", "segoe", "default", "wtgui.font"],
    ["ui", "jetbrains", "consolas", "wtgui.font"],
  ]) {
    const { ctx } = makePage({ stored: { [key]: retired } });
    assert.equal(ctx.currentFontId(kind), want, `${kind}: stored "${retired}" reads as "${want}"`);
  }
  const { ctx } = makePage({ stored: { "wtgui.termFont": "no-such-face" } });
  assert.equal(ctx.currentFontId("term"), "default", "an id that is in neither list falls back to the default");
});

test("the picker names the face an entry resolves to, and stays quiet when the label already does", () => {
  const { ctx } = makePage();
  const byId = (list, id) => list.find((f) => f.id === id);
  assert.equal(ctx.fontOptionLabel(byId(ctx.UI_FONTS, "default")), "Default (system UI) -> Segoe UI");
  assert.equal(ctx.fontOptionLabel(byId(ctx.TERM_FONTS, "default")), "Default (system monospace) -> Consolas");
  // A label that IS the family gets no arrow, and the console's "same as the panel font" gets none either: it names
  // no face of its own, it follows the other setting.
  assert.equal(ctx.fontOptionLabel(byId(ctx.UI_FONTS, "consolas")), "Consolas (monospace)");
  assert.equal(ctx.fontOptionLabel(byId(ctx.TERM_FONTS, "cascadia-mono")), "Cascadia Mono");
  assert.equal(ctx.fontOptionLabel(byId(ctx.TERM_FONTS, "panel")), "Same as the panel font");
  // Every entry that promises a face promises a real one, and the two lists' options are all distinct strings.
  const seen = new Set();
  for (const list of [ctx.UI_FONTS, ctx.TERM_FONTS]) {
    for (const f of list) {
      const text = ctx.fontOptionLabel(f);
      if (text.includes(" -> ")) assert.ok(String(f.resolves).trim(), `${f.id}: an arrow always carries a face`);
      assert.ok(!seen.has(`${list === ctx.UI_FONTS ? "ui" : "term"}:${text}`), `${f.id}: one option text per entry`);
    }
  }
});

test("the emoji fallback is still appended, and the console's panel-font stack is followed rather than copied", () => {
  const { ctx } = makePage();
  const mono = ctx.withEmojiFallback('"Cascadia Code", Consolas, monospace');
  assert.match(mono, /"Cascadia Code", Consolas, "Segoe UI Emoji"/, "a monospace stack keeps its generic keyword after the emoji fallback");
  assert.match(mono, /monospace$/, "and still ends on the generic keyword");
  const panel = ctx.withEmojiFallback("var(--ui)");
  assert.ok(panel.startsWith("var(--ui)"), "the panel-font entry is still a variable, not a copied family");
});

// ---- the row spacing -------------------------------------------------------------------------------------------
test("with no key stored the console draws the 1.5 it has always drawn, and nothing is written", () => {
  const { ctx, vars, writes, els } = makePage();
  ctx.initConRowSpace();
  assert.equal(vars.get("--con-row-space"), "1.5", "an unset key draws the console's own line-height");
  assert.equal(writes.length, 0, "opening the page does not create the key");
  assert.equal(els["con-row-space-px"].textContent, "17.3px", "the readout is that multiplier in the console's own pixels (11.5 x 1.5)");
});

test("the value is clamped to the range the slider offers, and garbage falls back to the default", () => {
  const { ctx, vars } = makePage();
  assert.equal(ctx.applyConRowSpace(0.2), 1.2, "below the minimum");
  assert.equal(vars.get("--con-row-space"), "1.2");
  assert.equal(ctx.applyConRowSpace(9), 2.4, "above the maximum");
  assert.equal(vars.get("--con-row-space"), "2.4");
  assert.equal(ctx.applyConRowSpace("nonsense"), 1.5, "not a number");
  assert.equal(ctx.applyConRowSpace(null), 1.5, "no argument reads the (empty) store");
  assert.equal(ctx.applyConRowSpace("1.732"), 1.73, "a dragged value is rounded to two places, not stored as a float tail");
});

test("a drag previews without writing, and the change writes one key", () => {
  const { ctx, writes, store } = makePage();
  ctx.applyConRowSpace(1.8);
  ctx.applyConRowSpace(1.85);
  ctx.applyConRowSpace(1.9);
  assert.equal(writes.length, 0, "the input event writes nothing");
  assert.equal(ctx.applyConRowSpace(1.9, { save: true }), 1.9);
  assert.deepEqual(writes, [{ key: "wtgui.conRowSpace", value: "1.9" }], "one key per gesture, under the wtgui.* prefix");
  assert.equal(store["wtgui.conRowSpace"], "1.9");
});

test("a stored value is honoured on the next load, clamped on the way in", () => {
  assert.equal(makePage({ stored: { "wtgui.conRowSpace": "1.9" } }).ctx.conRowSpace(), 1.9, "a value in range is kept");
  assert.equal(makePage({ stored: { "wtgui.conRowSpace": "3.1" } }).ctx.conRowSpace(), 2.4, "a hand-edited high value is clamped");
  assert.equal(makePage({ stored: { "wtgui.conRowSpace": "0" } }).ctx.conRowSpace(), 1.2, "a hand-edited 0 cannot flatten the console");
  const { ctx, vars } = makePage({ stored: { "wtgui.conRowSpace": "1.9" } });
  ctx.initConRowSpace();
  assert.equal(vars.get("--con-row-space"), "1.9", "the saved spacing is painted before the first console is drawn");
});

test("`use defaults` puts the console's own 1.5 back, in the variable and in the store", () => {
  const { ctx, vars, store } = makePage({ stored: { "wtgui.conRowSpace": "2.2" } });
  ctx.resetConRowSpace();
  assert.equal(vars.get("--con-row-space"), "1.5");
  assert.equal(store["wtgui.conRowSpace"], "1.5", "the reset is saved, so the slider and the next load agree");
});

test("one variable carries the spacing to every console row, and the prompt box is not in it", () => {
  // The console's own rule: the block that sets --term and --term-size also sets the line-height, so one setting moves
  // what the other two already move.
  let consoleBlock = null;
  for (let from = 0; ; ) {
    const at = css.indexOf("font-family: var(--term)", from);
    if (at < 0) break;
    const open = css.lastIndexOf("{", at);
    const close = css.indexOf("}", at);
    const body = css.slice(open, close);
    if (/font-size: var\(--term-size\)/.test(body)) {
      consoleBlock = body;
      break;
    }
    from = at + 1;
  }
  assert.ok(consoleBlock, "public/style.css still has the console's font rule");
  assert.match(consoleBlock, /line-height: var\(--con-row-space, 1\.5\)/, "the console's line-height is the one variable, with 1.5 as its fallback");
  assert.match(css, /\.think-block \{[^}]*line-height: var\(--con-row-space, 1\.5\)/, "the reasoning block above a console follows the same variable");
  assert.match(css, /\.settings-preview\.sample-rows \{[^}]*var\(--con-row-space, 1\.5\)/, "the row's own preview is that same line box, not a drawing of it");
  // The prompt box keeps its own padding: the variable appears nowhere in a reply-box rule.
  for (const m of css.matchAll(/[^{}]*\.reply-box[^{}]*\{[^}]*\}/g)) {
    assert.ok(!/--con-row-space/.test(m[0]), "the prompt box's padding is not moved by the row spacing");
  }
});

test("the Display row is a slider over that range, with a preview and a reset", () => {
  const row = html.slice(html.indexOf('id="con-row-space"') - 400, html.indexOf('id="con-row-space"') + 400);
  assert.match(row, /type="range"/, "the control is a slider");
  assert.match(row, /min="1\.2"/, "the minimum is in the markup");
  assert.match(row, /max="2\.4"/, "the maximum is in the markup");
  assert.match(row, /step="0\.05"/, "and it moves in hundredths");
  assert.match(row, /value="1\.5"/, "a page that has not booted yet shows the console's own 1.5, not the minimum");
  assert.match(html, /id="con-row-preview"[^>]*class="settings-preview sample-console sample-rows"|class="settings-preview sample-console sample-rows"[^>]*id="con-row-preview"/, "the live preview is beside the slider");
  assert.match(html, /id="con-row-reset"/, "and `use defaults` is its own control");
  assert.match(src, /\$\("con-row-space"\)\?\.addEventListener\("change", \(e\) => applyConRowSpace\(e\.target\.value, \{ save: true \}\)\)/, "the change event is what saves");
  assert.match(src, /\$\("con-row-space"\)\?\.addEventListener\("input", \(e\) => applyConRowSpace\(e\.target\.value\)\)/, "the input event only previews");
  assert.match(src, /initConRowSpace\(\);/, "the saved spacing is painted at boot");
});
