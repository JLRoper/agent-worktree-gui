// The docked console is the console a reader opens under a subagent row. It used to print the SOURCE of a child's
// message: the whole message arrived as one line with its newlines still inside it, the box was a <pre> of raw text,
// and markdown was never asked. These tests pin the two halves of the repair, on the real shipped files:
//
//   1. the renderer, over the shapes that failed in the row's message - a bold opening a bullet, a bold spanning a
//      line break, and a bare file:line path (a double-backtick span that left the path naked between two spans);
//   2. the dock, which must paint that surface through the renderer, in a div rather than a pre, with the colour
//      drawn from a design token and the margin read from the same saved preference the rest of the panel writes.
//
// Each case fails on the base build first. The browser half (the two controls actually cycled, the box's computed
// colour) is tools/capture-docked-console.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

const context = vm.createContext({ window: {}, console });
for (const file of ["public/core/dom-format.js", "public/core/console-markdown.js"]) {
  vm.runInContext(read(file), context, { filename: file });
}
const M = context.window.WMApp.core.consoleMarkdown;

const prose = (texts) => texts.map((text, i) => ({ kind: "text", text, lid: 100 + i }));
const rendered = (texts) => M.html(prose(texts));
// What a reader actually sees, as text: the tags and the escaped characters put back.
const visible = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

// The row's message, with the three shapes that failed in it: a bullet whose first words are bold, a double-backtick
// span around a file:line path, and a bold that OPENS on one line and CLOSES on the next.
const MESSAGE = [
  "TL;DR:",
  "- **The screenshot shows the real defect**: the docked console prints the source, not the rendered text.",
  "- **Filed with #3**, and `` `render-projects.js:690-705` `` arrives literally.",
  "- The surface is public/core/console-markdown.js:119-124, which already bolds.",
  "**The box is a pre",
  "and it never asks the renderer.**",
].join("\n");

test("plain text is unchanged: no markers, no added block shape, the same words", () => {
  const h = rendered(["a plain line of words"]);
  assert.equal(visible(h), "a plain line of words");
  assert.ok(!/<strong>|<em>|<code/.test(h), "nothing is dressed up that had no marker");
});

test("bold renders instead of printing its asterisks", () => {
  const h = rendered(["**Filed with #3**"]);
  assert.match(h, /<strong>Filed with #3<\/strong>/);
  assert.equal(visible(h), "Filed with #3");
});

test("a bold that OPENS A BULLET renders as a bullet with bold, not '- **...**'", () => {
  const h = rendered(["- **The screenshot shows the real defect**: the console prints the source."]);
  assert.match(h, /class="md-block md-list"/);
  assert.match(h, /<span class="md-marker"[^>]*>\u2022<\/span>/);
  assert.match(h, /<strong>The screenshot shows the real defect<\/strong>/);
  const shown = visible(h);
  assert.ok(!shown.includes("**"), `no literal ** in the reader's text: ${shown}`);
  assert.ok(!shown.includes("- "), `the bullet marker is a dot, not a dash: ${shown}`);
});

test("a bold SPANNING A LINE BREAK is bold on both rows and leaks no marker", () => {
  // The marker OPENS on the first row and CLOSES on the second: a marker that closes on its own row is not a span.
  const h = rendered(["**The box is a pre", "and it never asks the renderer.**"]);
  assert.match(h, /<strong>The box is a pre<\/strong>/);
  // One run across the break, re-opened per row.
  assert.match(h, /<strong>and it never asks the renderer\.<\/strong>/);
  assert.ok(!visible(h).includes("**"), "no literal ** survives a line break");
});

test("a bare file:line path renders as text, and a double-backtick span keeps it as code", () => {
  const bare = rendered(["The surface is render-projects.js:690-705 here."]);
  assert.ok(visible(bare).includes("render-projects.js:690-705"), "a bare path is shown, not eaten");
  assert.ok(bare.includes("render-projects.js:690-705"));

  // `` `x` `` is ONE span whose content is `x`, not two one-space spans with x left bare between them.
  const wrapped = rendered(["- **Filed with #3**, and `` `render-projects.js:690-705` `` arrives literally."]);
  assert.match(wrapped, /<code class="md-code">`render-projects\.js:690-705`<\/code>/);
  assert.equal((visible(wrapped).match(/render-projects\.js:690-705/g) || []).length, 1, "the path is drawn once");
  assert.ok(!visible(wrapped).includes("**"), "the bold in the same bullet still renders");
});

// The dock, loaded from the shipped public/board/console.js: the region that owns the box, over the real escaper and
// the real markdown renderer. A press is driven through the same functions the click handler calls.
const boxBody = (html) =>
  html.replace(/^[\s\S]*?<div class="sub-console mono"[^>]*>/, "").replace(/<\/div><\/div>$/, "");

function dockFor(store = new Map()) {
  const consoleJs = read("public/board/console.js");
  const at = consoleJs.indexOf("// ---- the docked console");
  assert.ok(at >= 0, "public/board/console.js has a 'the docked console' region to test");
  const end = consoleJs.indexOf("// ---- end the docked console", at);
  assert.ok(end > at, "the region is closed");
  const dock = vm.createContext({
    window: {},
    console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    // The card console's own burst bookkeeping, modelled here: a run of tool lines is one group, everything else is
    // its own row. The region under test does not own this rule.
    burstGroups: (lines) => {
      const out = [];
      let group = null;
      for (const line of lines) {
        if (line.kind === "tool" || line.kind === "tool-out") {
          if (!group) out.push({ group: (group = []) });
          group.push(line);
        } else {
          group = null;
          out.push({ group: false, line });
        }
      }
      return out;
    },
    toolGroupHtml: (lines, key) => `<div class="tgrp" data-key="${key}">${lines.length} tool lines</div>`,
    lineHtml: (line) => `<div class="jl jl-${line.kind}">${line.text}</div>`,
    toolGroupsOn: () => false,
    state: { subConsoles: new Map() },
  });
  for (const file of ["public/core/dom-format.js", "public/core/console-markdown.js"]) {
    vm.runInContext(read(file), dock, { filename: file });
  }
  vm.runInContext(consoleJs.slice(at, end), dock, { filename: "public/board/console.js#the docked console" });
  return {
    dock,
    store,
    // The console's own words, without the frame's two controls.
    boxFor(lines) {
      dock.state.subConsoles.set("child-1", { lines, running: false, loading: false });
      const html = vm.runInContext('subConsoleHtml("child-1")', dock);
      return { html, body: boxBody(html) };
    },
  };
}

test("the dock draws a plain child message as the same words, in a div rather than a pre", () => {
  const { boxFor } = dockFor();
  const { html, body } = boxFor([{ kind: "text", text: "a plain line of words" }]);
  assert.ok(!/<pre/i.test(html), "the box is no longer a pre of source");
  assert.match(html, /class="sub-console mono"/);
  assert.match(html, /data-sub-console-box="child-1"/);
  assert.equal(visible(body), "a plain line of words", "plain text is unchanged");
});

test("the dock draws a bold child message bold, not as its asterisks", () => {
  const { boxFor } = dockFor();
  const { body } = boxFor([{ kind: "text", text: "**Filed with #3**" }]);
  assert.match(body, /<strong>Filed with #3<\/strong>/);
  assert.equal(visible(body), "Filed with #3");
});

test("the docked surface is the renderer's: one message line becomes blocks, not a pre of source", () => {
  const { boxFor } = dockFor(
    new Map([
      ["wtgui.subConsoleFg", "violet"],
      ["wtgui.subConsoleMargin", "54"],
    ]),
  );
  const { html, body } = boxFor([{ kind: "text", text: MESSAGE, lid: null }]);

  assert.ok(!/<pre/i.test(html), "the box is no longer a pre of source");
  assert.match(html, /class="sub-console mono"/);
  assert.match(html, /data-sub-console-box="child-1"/);
  assert.match(body, /class="md-block md-list"/, "the bullets are a list");
  assert.match(body, /<strong>The screenshot shows the real defect<\/strong>/, "the bold is drawn");
  assert.match(body, /<strong>The box is a pre<\/strong>/, "the opening row of the span is bold");
  assert.match(body, /<strong>and it never asks the renderer\.<\/strong>/, "the bold across the break is drawn");
  const shown = visible(body);
  assert.ok(!shown.includes("**"), `no source marker in the dock: ${shown.slice(0, 240)}`);
  assert.ok(shown.includes("render-projects.js:690-705"), "the path is on screen");
});

test("the dock's colour is a design token and its margin is the saved preference", () => {
  const store = new Map([
    ["wtgui.subConsoleFg", "amber"],
    ["wtgui.subConsoleMargin", "0"],
  ]);
  const { dock, boxFor } = dockFor(store);
  const { html } = boxFor([{ kind: "text", text: "plain" }]);

  assert.match(html, /data-sub-console-color="1"/, "a colour control is offered");
  assert.match(html, /data-sub-console-margin="1"/, "a margin control is offered");
  assert.match(html, /--sub-console-fg: var\(--amber\)/, "the colour is the amber TOKEN, so contrast settings reach it");
  const style = html.match(/style="([^"]*)"/)[1];
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(style), `no hard-coded hex in the console's own style: ${style}`);
  assert.match(style, /margin-left:0px/, "the stored margin is what the box is drawn with");

  // A press cycles the closed list, saves it, and repaints only the box it was pressed in. The ORDER of the ring is
  // the panel's to choose, so this pins the contract: one press moves to another member, and one full walk of each
  // ring returns home. The colour ring has six tokens and the margin ring four steps.
  vm.runInContext("cycleSubConsoleFg(); cycleSubConsoleMargin();", dock);
  const fg = store.get("wtgui.subConsoleFg");
  const margin = store.get("wtgui.subConsoleMargin");
  assert.notEqual(fg, "amber", "the colour moved off the stored token");
  assert.ok(["text", "dim", "green", "amber", "blue", "violet"].includes(fg), `a token, not a hex: ${fg}`);
  assert.notEqual(margin, "0", "the margin moved off the stored step");
  assert.ok(["36", "18", "0", "54"].includes(margin), `a step of the ring: ${margin}`);
  vm.runInContext("for (let i = 0; i < 5; i += 1) cycleSubConsoleFg(); for (let i = 0; i < 3; i += 1) cycleSubConsoleMargin();", dock);
  assert.equal(store.get("wtgui.subConsoleFg"), "amber", "a full walk of the colour ring returns to the stored token");
  assert.equal(store.get("wtgui.subConsoleMargin"), "0", "a full walk of the margin ring returns to the stored step");
});

test("the pre-wrap behaviour is gone from the docked console's box, and the fold hides the whole frame", () => {
  const css = read("public/style.css");
  const box = css.match(/\.sub-console\s*\{([^}]*)\}/);
  assert.ok(box, ".sub-console still has a rule");
  assert.match(box[1], /white-space:\s*normal/, "the box does not preserve the source's whitespace");
  assert.ok(!/pre-wrap/.test(box[1]), "no pre-wrap on the box");
  assert.match(box[1], /color:\s*var\(--sub-console-fg,\s*var\(--text\)\)/, "the colour is the chosen token, defaulting to text");
  assert.match(css, /\.subagents\.is-collapsed \.sub-row,\s*\.subagents\.is-collapsed \.sub-console-wrap\s*\{\s*display:\s*none/, "folding hides the frame, not just the old class");
});
