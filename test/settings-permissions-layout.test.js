// The Permissions tab's two columns at the settings window's 340 px width.
//
// The review of the tab (PR #251) found the status pill painted over a wrapped group label, and every file:line
// wrapped to 3–5 lines so 46 rows made a 4106 px scroll. The browser half is tools/verify-settings-permissions.mjs,
// which drives a real 340 px window and measures the boxes at 1280 and 340 wide. This file pins the stylesheet and
// markup those measurements depend on, so a later edit cannot quietly put the label back under the pill or drop a
// source's title between Playwright runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const begin = src.indexOf("// ---- Permissions tab");
const end = src.indexOf("// ---- settings window", begin);
assert.ok(begin > 0 && end > begin, "the Permissions region is in public/app.js");
const region = src.slice(begin, end);

const rule = (selector) => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} must have a rule in public/style.css`);
  return css.slice(at, css.indexOf("}", at));
};

test("the group head is a two-column grid, so the pill has a column of its own", () => {
  const head = rule(".perm-head");
  assert.match(head, /display:\s*grid/, "the head lays the label and the pill out as grid items");
  assert.match(head, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/, "the label takes the free column and the pill its own");
});

test("the label wraps inside its column and the pill never shares it", () => {
  const label = rule(".perm-label");
  assert.match(label, /min-width:\s*0/, "the label may be narrower than its longest word");
  assert.match(label, /overflow-wrap:\s*anywhere/, "a long word wraps rather than painting over the pill");
  const status = rule(".perm-status");
  assert.match(status, /justify-self:\s*end/, "the pill sits at the head's right edge");
});

test("every source is one ellipsized line, not a wrapped paragraph", () => {
  for (const selector of [".perm-head .perm-source", ".perm-row .perm-source"]) {
    const source = rule(selector);
    assert.match(source, /white-space:\s*nowrap/, `${selector} stays on one line`);
    assert.match(source, /overflow:\s*hidden/, `${selector} clips what does not fit`);
    assert.match(source, /text-overflow:\s*ellipsis/, `${selector} says it was cut off`);
    assert.match(source, /min-width:\s*0/, `${selector} can shrink inside its grid column`);
  }
});

test("the head and every row carry the full path:line in the source's title", () => {
  // The two spans permissionsGroupHtml writes: the heading's `where` and a row's `src`. The title is the untruncated
  // value, which is what makes the ellipsis safe: the reader can still read the whole path on hover.
  assert.match(region, /<span class="perm-source mono" title="\$\{esc\(where\)\}">\$\{esc\(where\)\}<\/span>/,
    "the group heading's source carries its own title");
  assert.match(region, /<span class="perm-source mono" title="\$\{esc\(src\)\}">\$\{esc\(src\)\}<\/span>/,
    "a permission row's source carries its own title");
  assert.equal((region.match(/class="perm-source mono"/g) || []).length, 2, "there are exactly two source templates");
  assert.equal((region.match(/class="perm-source mono" title=/g) || []).length, 2, "and both carry a title");
});

test("the tab's markup is one grouped list, which is what the layout above is measured on", () => {
  assert.match(html, /<div id="permissions-list"><\/div>/, "the list is the mounted root");
  assert.match(region, /data-permissions-row="1"/, "each permission is a row");
  assert.match(region, /data-permissions-block="1"/, "each source is a block");
});
