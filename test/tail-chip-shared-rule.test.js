// The tail chip is one rule, not two copies of one: the console's "jump to the newest line" and the worktree
// chart's "show the trees this chart is holding back" are the same 21px circle, and both rules used to carry the
// shape verbatim — eight declarations spelled out twice, in two places, drifting apart the first time one of them
// was touched. The shape now lives once, in `.tail-chip`, and each owner keeps only what is its own: the console
// chip's placement over its scroll box, the chart chip's place IN the legend's flow and its brighter ink.
//
// The seam-free half of `tools/verify-age-collapse.mjs`'s style digest (there is no layout engine in `npm test`).
// That harness compares the two chips' COMPUTED styles in a real browser, where this test asserts the stylesheet's
// text and the cascade order that makes the text mean what it says. Both halves are needed: the rule can be
// perfectly present in the file and still be inert — a shared rule placed AFTER `.wt-age-toggle` would win the
// cascade on order alone and repaint the chart's arrow in the console's dimmer ink, which is exactly the "it parses,
// it reads as the fix, nothing changed" trap a file-level assertion has to pin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const CHIP = ".tail-chip";
const CONSOLE_CHIP = ".out-wrap > .to-bottom";
const CHART_CHIP = ".wt-age-toggle";

// The eight declarations the two owners used to spell out verbatim, with the value that was written in both.
const SHARED = {
  width: "21px",
  height: "21px",
  "place-items": "center",
  padding: "0",
  "line-height": "1",
  "border-radius": "50%",
  cursor: "pointer",
  transition: "opacity .16s ease, color .16s ease, border-color .16s ease",
};

// Brace-matched, because this stylesheet has nested `@media`/`@container` bodies and a plain `([^{}]+)\{([^{}]*)\}`
// regex reads an at-block's inner rule and loses every prelude around it. Every rule (including the ones inside a
// nested block) comes back with its ABSOLUTE offset, which is what the cascade questions need.
function rules(source) {
  const out = [];
  const walk = (text, base, insideAt) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) return;
      const prelude = text.slice(i, open).trim();
      // Find the matching close brace of this block.
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}") depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith("@")) walk(body, base + open + 1, true);
      else if (prelude && !insideAt) out.push({ prelude, body, at: base + i });
      else if (prelude) out.push({ prelude, body, at: base + i, inAt: true });
      i = j;
    }
  };
  walk(source, 0, false);
  return out;
}

const ALL = rules(css);
// Only the top-level rules: a `@media (hover: none)` body re-declares `.wt-age-toggle`, and a lookup that took the
// first match blindly would sometimes read the conditional copy's one declaration as the rule's whole body.
const find = (selector) => ALL.filter((r) => r.prelude === selector && !r.inAt);
const decl = (body, key) => {
  const m = body.match(new RegExp(`(?:^|;)\\s*${key.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+)`, "i"));
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
};
const declarations = (body) =>
  new Map(
    body
      .split(";")
      .map((d) => d.split(":"))
      .filter((p) => p.length > 1 && p[0].trim() && !p[0].trim().startsWith("/*"))
      .map((p) => [p[0].trim().toLowerCase(), p.slice(1).join(":").trim().replace(/\s+/g, " ")]),
  );

test("the shape is written once, in .tail-chip", () => {
  const chip = find(CHIP);
  assert.equal(chip.length, 1, "one .tail-chip rule, not one per owner");
  const body = chip[0].body;
  for (const [key, value] of Object.entries(SHARED)) {
    assert.equal(decl(body, key), value, `.tail-chip carries ${key}: ${value}`);
  }
  // The rule is the SHAPE and nothing else: a placement left in here would be the console's own or the chart's own,
  // depending on which owner someone copied from, and both would then be wrong for the other.
  const own = declarations(body);
  for (const k of Object.keys(own)) assert.ok(SHARED[k], `.tail-chip holds only the shared shape, not ${k}`);
});

test("neither owner repeats a declaration the shared rule now carries", () => {
  for (const sel of [CONSOLE_CHIP, CHART_CHIP]) {
    const rule = find(sel);
    assert.equal(rule.length, 1, `exactly one ${sel} rule`);
    for (const key of Object.keys(SHARED)) {
      assert.equal(decl(rule[0].body, key), null, `${sel} no longer spells out ${key}`);
    }
  }
});

test("the shared rule sits before the chart's own, so its brighter ink still wins", () => {
  const chip = find(CHIP)[0];
  const chart = find(CHART_CHIP)[0];
  assert.ok(chip.at < chart.at, ".tail-chip is defined above .wt-age-toggle");
  // Same weight (one class each), so the later rule is the one that applies. The chart's arrow needs its own
  // placement and its brighter ink; if the shared rule moved below it, those would be silently replaced.
  for (const selector of [CHIP, CHART_CHIP]) {
    assert.equal(find(selector)[0].prelude.split(".").length - 1, 1, `${selector} is a one-class rule`);
  }
});

test("the console chip keeps its own placement, at a weight the shared rule cannot touch", () => {
  const consoleChip = find(CONSOLE_CHIP)[0];
  // Two classes (`.out-wrap` and `.to-bottom`) against the shared rule's one, so position/left/bottom/z-index win
  // whatever the source order — which is what makes it safe for the shared rule to sit above this one.
  const weight = consoleChip.prelude.split(".").length - 1;
  assert.equal(weight, 2, "the console chip's rule is two classes");
  for (const key of ["position", "left", "transform", "bottom", "z-index", "display"]) {
    assert.ok(decl(consoleChip.body, key), `${CONSOLE_CHIP} still places itself (${key})`);
  }
});

test("the chart's arrow is still deliberately its own ink and letterform", () => {
  const consoleChip = declarations(find(CONSOLE_CHIP)[0].body);
  const chartChip = declarations(find(CHART_CHIP)[0].body);
  for (const key of ["font-size", "color", "background", "border", "box-shadow"]) {
    assert.ok(chartChip.get(key), `.wt-age-toggle still decides its own ${key}`);
    assert.notEqual(chartChip.get(key), consoleChip.get(key), `and it is not the console chip's ${key}`);
  }
  // And the arrow is the only thing keeping the console chip's own ink out of its way.
  for (const key of ["font-size", "color", "background", "border", "box-shadow"]) {
    assert.ok(consoleChip.get(key), `${CONSOLE_CHIP} still decides its own ${key}`);
  }
});

test("both chips are drawn carrying the shared class, so the rule reaches them", () => {
  const toBottom = app.match(/function toBottomBtnHtml\(\) \{\s*return `([^`]+)`/);
  assert.ok(toBottom, "app.js still builds the console chip in toBottomBtnHtml()");
  assert.match(toBottom[1], /class="tail-chip to-bottom"/, "the console chip carries tail-chip and its own hook");
  // Every element that carries `wt-age-toggle` must carry `tail-chip` beside it: the chart rule no longer sets a
  // width or height of its own, so an arrow drawn without the shared class would collapse to a bare glyph.
  const chartSites = [...app.matchAll(/class="([^`]*?)wt-age-toggle/g)].map((m) => m[1]);
  assert.ok(chartSites.length >= 1, "app.js still draws the chart's arrow");
  for (const classes of chartSites) {
    assert.equal(classes, "tail-chip ", `the arrow's class list starts with tail-chip (read "${classes}")`);
  }
});
