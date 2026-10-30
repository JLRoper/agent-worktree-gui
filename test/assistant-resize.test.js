import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const cssRaw = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, ""); // the prose explains the rule the drag no longer needs
const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");

// The float is resized by pointer drags, so the mechanism lives in the page, not in a node module. These guard the
// three properties the drag depends on; the numbers (each edge tracking the pointer to within a pixel, the 8px
// viewport edge, no dead band on the way back) were measured on the running page.

const rulesFor = (dir) =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.includes(`.as-grip[data-dir="${dir}"]`))
    .map(([, , body]) => body)
    .join("\n");

test("the assistant offers a grab on every edge and corner", () => {
  const block = html.match(/<div class="as-grips" id="as-grips">([\s\S]*?)<\/aside>/);
  assert.ok(block, "index.html must carry the grab container");
  assert.deepEqual(
    [...block[1].matchAll(/data-dir="([a-z]{1,2})"/g)].map((m) => m[1]).sort(),
    ["e", "n", "ne", "nw", "s", "se", "sw", "w"],
  );
  assert.ok(!/id="as-resize"/.test(html), "the single corner grip is replaced by the eight grabs");
});

test("each grab carries the cursor its edge means, and does not let a finger scroll the panel", () => {
  const cursors = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" };
  for (const [dir, cursor] of Object.entries(cursors)) {
    const body = rulesFor(dir);
    assert.ok(body, `no rule for the ${dir} grab`);
    assert.match(body, new RegExp(`cursor:\\s*${cursor}`), `the ${dir} grab must show ${cursor}`);
  }
  assert.match(css, /\.as-grip \{[^}]*touch-action:\s*none/, "a touch drag on a grab must resize, not scroll");
});

test("the float has one size authority: the drag clamp, not a smaller cap in the stylesheet", () => {
  const rule = css.match(/\n\.assistant \{([^}]*)\}/);
  assert.ok(rule, "no .assistant rule");
  assert.doesNotMatch(rule[1], /max-width|max-height/,
    "a CSS cap smaller than the JS clamp makes the frame stop while the pointer keeps moving — the measured bug");
  assert.match(assistant, /const viewport = \(\) =>/, "the resize clamp must read the viewport itself");
  assert.match(assistant, /visualViewport/, "the clamp must honour a zoomed or keyboard-shrunk viewport");
});
