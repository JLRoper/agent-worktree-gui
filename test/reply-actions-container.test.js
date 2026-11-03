// A reply box narrower than its own row of buttons must wrap them under itself instead of clipping their labels.
//
// The defect: `.reply-actions` is `position: absolute` inside the box, which is right while the box is wider than
// `Steer turn · Queue reply · 1 queued · Cancel turn` (~330px). In a worktree row's card on a phone the box is
// ~330px wide INCLUDING its padding, so the row did not fit: a flex row shrinks its items before it wraps, the
// labels broke mid-word ("Steer / turn"), and the row grew out of the 34px strip the box reserves for it — over
// the placeholder and over whatever had been typed.
//
// There is no layout engine in `npm test`, so this file pins the STYLESHEET CONTRACT the fix depends on, and it
// pins the two ways that contract can silently stop working:
//   1. the container query must exist at all, and only the narrow case may leave the box (`position: static`,
//      `flex-wrap: wrap`, full-size 12px labels) — main has no `@container` anywhere, so test 1 fails there.
//   2. a `container-type` query adds NO specificity, and each labelled button already carries its own size class
//      (`.reply-actions button.btn-cancel`, `.btn-queue`, `.btn-steer`) at (0,2,1). A bare `.reply-actions button`
//      inside the query therefore loses to them and the "full-size labels" half of the fix is dead while looking
//      present — the last three tests are the ones that catch that.
// What this cannot prove is in the report: that the browser really lays the row out as two lines at 330px.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Comments are stripped so a word in prose can never satisfy an assertion about a declaration.
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

// ---- a small stylesheet model: at-blocks with their own rules, top-level rules with their source order ---------
function atBlocks(text, name) {
  const out = [];
  const re = new RegExp(`@${name}\\b[^{]*\\{`, "g");
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (!depth) break;
      }
    }
    out.push({ prelude: m[0].slice(0, -1).trim(), body: text.slice(open + 1, i), at: m.index });
  }
  return out;
}

function rules(text, from = 0) {
  const out = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (!selector || selector.startsWith("@")) continue;
    out.push({ selector, body: m[2], at: from + m.index });
  }
  return out;
}

// The stylesheet without the container blocks: what a plain rule sees on the wide path, order included.
const flat = css.replace(/@container\b[^{]*\{[\s\S]*?\n\}/g, "\n");
const topRules = rules(flat);
const decls = (list, selector) => {
  const found = list.filter((r) => r.selector.split(",").map((s) => s.trim()).includes(selector));
  assert.ok(found.length, `${selector} must have a rule in public/style.css`);
  return found.map((r) => r.body).join("\n");
};

// A declaration this stylesheet could have written with spaces or not: `padding-bottom:7px` is the same rule.
const has = (body, prop, value) =>
  new RegExp(`${prop}\\s*:\\s*${value}(\\s|;|$)`).test(body);

// The one container block, with a readable failure when the fix is not in the file at all (the case on main).
function containerBlock() {
  const blocks = atBlocks(css, "container");
  assert.equal(blocks.length, 1, "public/style.css carries exactly one @container block - main carries none");
  return blocks[0];
}

// Specificity as [classes+attrs+pseudo-classes, type selectors] — enough for the selectors on this path.
function specificity(selector) {
  const one = selector.split(/\s+/).filter((part) => !/[>+~]/.test(part)).join(" ");
  const classes = (one.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
  const types = (one.replace(/\.[\w-]+|\[[^\]]*\]|::?[\w-]+/g, " ").match(/[a-zA-Z][\w-]*/g) || []).length;
  return [classes, types];
}
const beats = (a, b) => {
  const [ac, at] = specificity(a.selector);
  const [bc, bt] = specificity(b.selector);
  if (ac !== bc) return ac > bc;
  if (at !== bt) return at > bt;
  return a.at > b.at;
};

// ---- the base rule is untouched on the wide path --------------------------------------------------------------
test("the wide box still pins its actions inside it, bottom left", () => {
  const base = decls(topRules, ".reply-actions");
  assert.match(base, /position:\s*absolute/, "the default is still an overlay inside the box");
  assert.match(base, /left:\s*7px/);
  assert.match(base, /bottom:\s*8px/);
  assert.match(base, /display:\s*flex/);
});

test("a label is never allowed to break mid-word again", () => {
  const nowrap = topRules.filter((r) => /^\.reply-actions button$/.test(r.selector));
  assert.equal(nowrap.length, 1, "the nowrap rule is unconditional: it is what makes the row wrap as whole buttons");
  assert.ok(has(nowrap[0].body, "white-space", "nowrap"), "a label stays whole inside its button");
});

// ---- the narrow case exists, and it is a container query ------------------------------------------------------
test("the reply box's width is the query's own context", () => {
  assert.match(decls(topRules, ".reply-wrap"), /container-type:\s*inline-size/,
    "the box is a size container, so the query below can read its width");
});

test("exactly one container query, at 380px, and no media query stands in for it", () => {
  const containers = atBlocks(css, "container");
  assert.equal(containers.length, 1, "one @container block is the whole of this fix");
  assert.match(containers[0].prelude, /\(max-width:\s*380px\)/, "the width the button row needs is the threshold");
  const inMedia = atBlocks(css, "media").flatMap((b) => rules(b.body, b.at))
    .filter((r) => /\.reply-(wrap|actions)\b/.test(r.selector));
  assert.equal(inMedia.length, 0,
    "the box's width comes from the card it sits in, not from the window: a media query here would be the wrong knob");
});

test("under 380px the actions leave the box and wrap as whole buttons", () => {
  const container = containerBlock();
  const inner = rules(container.body, container.at);
  const actions = inner.filter((r) => r.selector.endsWith(".reply-actions"));
  assert.ok(actions.length, "the container query carries a .reply-actions rule");
  assert.ok(actions.some((r) => has(r.body, "position", "static")), "the row is in the flow, under the box");
  assert.ok(actions.some((r) => has(r.body, "flex-wrap", "wrap")), "and it wraps instead of shrinking");
  for (const rule of actions) {
    assert.ok(beats(rule, { selector: ".reply-actions", at: -1 }),
      `${rule.selector} outranks the absolute rule it has to override`);
  }
});

test("the labels come back at full size, and the selector chosen actually wins", () => {
  const container = containerBlock();
  const inner = rules(container.body, container.at);
  const labels = inner.filter((r) => /button$/.test(r.selector.trim()));
  assert.ok(labels.length, "the container query carries a button rule");
  const sized = labels.filter((r) => has(r.body, "font-size", "12px"));
  assert.ok(sized.length, "the wrapped labels are 12px, not the 11px the row uses inside the box");

  // Every rule that sets a size on a labelled button already: the wrapped ones have to beat each of them, on
  // specificity or on order. A bare `.reply-actions button` inside the query loses to all of these.
  const competing = topRules.filter((r) =>
    /button\.btn-(reply|cancel|queue|steer)\b/.test(r.selector) && /(font-size|padding)\s*:/.test(r.body));
  assert.ok(competing.length >= 3, "the labelled buttons still carry their own size rules");
  for (const rule of competing) {
    assert.ok(sized.some((wrap) => beats(wrap, rule)),
      `${rule.selector} would keep its own size: the wrapped-button rule must outrank it`);
  }
});

test("the box stops reserving the strip the actions no longer sit in, and that too wins on order", () => {
  const container = containerBlock();
  const inner = rules(container.body, container.at);
  const pad = inner.filter((r) => /\.reply-wrap\s+\.reply-box$/.test(r.selector.trim()));
  assert.ok(pad.length, "the container query reduces the box's own bottom pad");
  assert.ok(has(pad[0].body, "padding-bottom", "7px"), "the 34px strip goes away with the overlay it held");

  // A container query adds no specificity, so this declaration only applies because it comes AFTER the 34px rule.
  const reserved = topRules.filter((r) => /\.reply-wrap\s+\.reply-box$/.test(r.selector.trim()));
  assert.equal(reserved.length, 1, "the box has one padding rule to override");
  assert.match(reserved[0].body, /padding-bottom:\s*34px/, "and it is still the one the wide layout reserves");
  for (const rule of pad) {
    assert.ok(beats(rule, reserved[0]),
      `${rule.selector} must come after the 34px rule: a container query wins nothing on specificity`);
  }
});
