// The Hot Agent search's opener: a control in the FLOATING header, and the order it is read in.
//
// It used to be a 20px pill in the assistant's title row, beside the assistant's own turn search. The 1.117.0 landing
// note said it had moved to the header; nothing had, so the button sat in the rail and the note described a page that
// did not exist. These two tests pin the page: the copy that moved, and the glyph it now wears.
//
// 1. THE ORDER. The header reads assistant search, then this one, then Clarify, then Human - and it is the same order in the DOM and
//    on screen. The DOM half is pinned here; the screen half is the browser gate's (tools/verify-hot-agent-header.mjs),
//    because "with nothing visible between them" needs layout. Between the assistant's entry and this control sits one
//    element, #btn-hot, which ships hidden and is drawn only while an agent is working - so the three are adjacent
//    whenever that marker is absent, and Clarify is always immediately before Human.
// 2. THE GLYPH. A hand holding a pen, drawn inline as SVG in currentColor rather than typed as an emoji, at its
//    neighbours' size (15px in a 16-unit viewBox), with the tooltip and the aria-label that name the chord and say
//    what the corpus is. A glyph swapped back to a character, or a label that drops Ctrl+Shift+Q, changes these lines.
//
// What the move must NOT have changed is pinned here too: the assistant's own search box is still in its bar, the
// popover still hangs in the assistant's aside, and the stylesheet no longer carries the rail-scoped pill.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

const headerBlock = () => {
  const found = html.match(/<header class="topbar">[\s\S]*?<\/header>/);
  assert.ok(found, "the header is still in index.html");
  return found[0];
};
// The controls row is the header's own bar; the opener is a child of it, not of anything deeper.
const controlsRow = () => {
  const found = headerBlock().match(/<div class="controls">([\s\S]*?)<\/div>/);
  assert.ok(found, "the header's controls row is still there");
  return found[1];
};
const opener = () => {
  const found = html.match(/<button type="button" class="ha-search-open" id="ha-search-open"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(found, "no #ha-search-open button with its class and type");
  return { tag: found[0], inner: found[1] };
};

test("the header reads assistant search, then the Hot Agent search, Clarify, then Human - in that order", () => {
  const row = controlsRow();
  const ids = [...row.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  const at = (id) => ids.indexOf(id);
  assert.ok(at("btn-assistant") >= 0, "the assistant's entry is in the header's controls row");
  assert.ok(at("ha-search-open") >= 0, "the Hot Agent search's opener is in the header's controls row");
  assert.ok(at("btn-clarify") >= 0, "Clarify is in the header's controls row");
  assert.ok(at("btn-human") >= 0, "Human is in the header's controls row");

  assert.ok(at("btn-assistant") < at("ha-search-open"), "the assistant's entry comes before the Hot Agent search");
  assert.ok(at("ha-search-open") < at("btn-clarify"), "the Hot Agent search comes before Clarify");
  assert.ok(at("btn-clarify") < at("btn-human"), "Clarify comes before Human");
  // One element between the assistant and the search opener, and it is the conditional Hot marker - nothing else may be
  // inserted there without this line changing. The same is true of Clarify, which takes its place between the search
  // opener and Human: it is the fourth control, and it may not drift to either side of them.
  assert.deepEqual(
    ids.slice(at("btn-assistant"), at("ha-search-open") + 1),
    ["btn-assistant", "btn-hot", "ha-search-open"],
    "the only control between the assistant and this one is the Hot marker, which ships hidden",
  );
  assert.deepEqual(
    ids.slice(at("ha-search-open"), at("btn-human") + 1),
    ["ha-search-open", "btn-clarify", "btn-human"],
    "Clarify sits between the search opener and Human, with nothing else between the three",
  );

  // The marker really is conditional, or "adjacent" would be a claim about a page nobody sees.
  assert.match(html, /<button id="btn-hot" type="button" hidden /, "Hot ships hidden, so the three are adjacent");

  // Purple is the whole point of a fourth control rather than a second Human: the control's own rule names the violet,
  // and it is not Human's own colour borrowed.
  const rule = css.slice(css.indexOf(".topbar #btn-clarify {"), css.indexOf(".topbar #btn-clarify {") + 400);
  assert.ok(css.includes(".topbar #btn-clarify {"), "the Clarify control has its own rule in the topbar");
  assert.match(rule, /color:\s*var\(--violet\)/, "it is drawn in the header's violet");
});

test("the opener is a hand holding a pen, drawn inline, naming the chord and the corpus", () => {
  const { tag, inner } = opener();
  // Drawn, not typed: the button holds one SVG and no text at all.
  assert.match(inner, /^<svg /, "the glyph is an inline SVG, the button's only child");
  assert.doesNotMatch(inner.replace(/<svg[\s\S]*<\/svg>/, "").trim(), /\S/, "no emoji, no character, no label text");
  assert.match(inner, /viewBox="0 0 16 16"/, "a 16-unit grid, the panel's inline-icon convention");
  assert.match(inner, /width="16" height="16"/, "drawn at 16px: exactly the line box the emoji labels beside it render at");
  assert.match(inner, /fill="currentColor"/, "the glyph takes the button's colour and its dim/hover/open states");
  // A hand and a pen, not one shape: four fingers and a palm, the pen stroke, and the nib.
  assert.ok((inner.match(/<rect /g) || []).length >= 4, "three fingers and a palm");
  assert.ok((inner.match(/<path /g) || []).length >= 3, "a thumb, the pen's shaft and its nib");
  assert.doesNotMatch(inner, /\p{Extended_Pictographic}/u, "no emoji in the drawn glyph");

  // The tooltip and the label say the same two things: the chord, and what is searched.
  const title = tag.match(/title="([^"]*)"/)?.[1] || "";
  const label = tag.match(/aria-label="([^"]*)"/)?.[1] || "";
  assert.match(title, /Ctrl\+Shift\+Q/, "the tooltip names the chord");
  assert.match(label, /Ctrl\+Shift\+Q/, "the aria-label names the chord");
  assert.match(title, /turns you wrote to worker agents/i, "the tooltip names the corpus");
  assert.match(label, /Hot Agent search/i, "the aria-label names the control");

  // The dialog contract the popover is opened under, and the id it points at.
  assert.match(tag, /aria-haspopup="dialog"/, "it opens a dialog");
  assert.match(tag, /aria-controls="ha-search-pop"/, "and names the popover it opens");
  assert.match(tag, /aria-expanded="false"/, "it ships closed");
});

test("the assistant's bar keeps its own search, and this button is no longer in it", () => {
  // Comments are prose, not markup: a comment in the bar is allowed to name the id it explains.
  const markup = (slice) => slice.replace(/<!--[\s\S]*?-->/g, "");
  const bar = markup(html.slice(html.indexOf('<span class="as-search" id="as-search">'), html.indexOf('id="as-search-pop"')));
  assert.ok(bar.length > 500, "the assistant's search bar is still in the page");
  assert.match(bar, /id="as-search-q"/, "its own box is untouched");
  assert.match(bar, /id="as-search-scope"/, "its scope toggle is untouched");
  assert.doesNotMatch(bar, /<button[^>]*ha-search-open/, "the Hot Agent opener is out of the assistant's bar");

  // ...and out of the assistant's subtree altogether, which is what makes it a header control.
  const aside = markup(html.slice(html.indexOf('id="assistant"'), html.indexOf('id="as-search-pop"')));
  assert.doesNotMatch(aside, /<button[^>]*id="ha-search-open"/, "the opener is not inside the assistant");

  // The popover it opens did not move: it is still the assistant's, under the same ids.
  const pop = html.match(/<div class="ha-search-pop" id="ha-search-pop"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(pop, "the popover is still in the assistant's aside");
  for (const id of ["ha-search-q", "ha-search-n", "ha-search-list", "ha-search-more"]) {
    assert.match(pop[0], new RegExp(`id="${id}"`), `the popover still carries #${id}`);
  }
});

test("the pill in the rail is gone from the stylesheet, and the header's own rule replaced it", () => {
  assert.doesNotMatch(css, /#assistant > \.as-bar \.ha-search-open/, "no rule still scopes the opener to the rail");
  assert.match(css, /\.topbar \.ha-search-open \{/, "the opener has a rule in the header's own scope");
  assert.match(css, /\.topbar \.ha-search-open \.ha-search-glyph \{ display: block; \}/, "the SVG is a block, so it centres");
  assert.match(css, /\.topbar \.ha-search-open\[aria-expanded="true"\]/, "the open state is styled");
});
