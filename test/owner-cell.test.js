// The owner cell and the detail bullet: the assistant's NAME in the cell, its numbered role label in the tooltip, and
// "Controlled by: Assistant #1 — Manager" as its own bullet in the row's detail.
//
// The cell used to draw the role label the server resolved ("Manager 1"), which names a seat on a role rather than
// the assistant that owns the tree, and the detail's bullet drew the same label. Both surfaces now read the name; the
// label is still resolved at read time (so a role rename renames it without a write) but belongs in the tooltip beside
// the display-only sentence, because a cell is one word wide. A row the server could not name still reads Assistant
// #1 — the default owner — and never a dash: a column of dashes hides the fact that nothing there is unowned.
//
// The functions are READ OUT of public/app.js between their markers, not copied here: a change to the page's own rule
// changes these answers, and a rule that moves back to `row.assistant.label` fails in this file.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const code = sliceRegion(src, "owner cell", "owner cell");

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const { ownerNameOf, ownerCellHtml, ownerDetailHtml } = new Function(
  "esc",
  `${code}; return { ownerNameOf, ownerCellHtml, ownerDetailHtml };`,
)(esc);

const text = (html) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const title = (html) => (/title="([^"]*)"/.exec(html) || [])[1] || "";
// What the server's `ownerFields` sends for a tree nobody moved, and for one reassigned to the second assistant.
const owner = (over = {}) => ({ id: "assistant-1", name: "Assistant #1", label: "Manager 1", role: "Manager", ...over });
const goneFallback =
  "assistant-2 is not on the board any more, so Assistant #1 controls this worktree until you set an owner again";

test("a row with no stored owner draws the default assistant's NAME", () => {
  const html = ownerCellHtml({ assistant: owner() });
  assert.equal(text(html), "Assistant #1");
  assert.doesNotMatch(text(html), /Manager/, "the role label is not the cell's text");
});

test("a row with no owner object at all still names Assistant #1 — never a dash", () => {
  for (const row of [{}, { assistant: null }, { assistant: { name: "" } }]) {
    const html = ownerCellHtml(row);
    assert.equal(text(html), "Assistant #1", JSON.stringify(row));
    assert.notEqual(text(html), "—");
    assert.doesNotMatch(text(html), /^[—–-]+$/, "a dash must never render in this column");
  }
});

test("a reassigned row draws its own assistant's name, and the tooltip carries that role's label", () => {
  const html = ownerCellHtml({ assistant: owner({ id: "assistant-2", name: "Assistant #2", label: "Manager 2" }) });
  assert.equal(text(html), "Assistant #2", "the cell names the assistant the reader gave the tree to");
  assert.match(title(html), /^Assistant #2 \(Manager 2\) owns this worktree\./);
  assert.match(title(html), /Display only: it does not change who wakes or runs\./);
  assert.doesNotMatch(title(html), /Manager 1/, "the tooltip names the owner's own seat, not the default's");
});

test("a row whose stored owner is gone keeps the fallback sentence beside the role label", () => {
  const html = ownerCellHtml({ assistant: owner({ stored: "assistant-2", fallback: goneFallback }) });
  assert.equal(text(html), "Assistant #1", "the cell names who actually owns it now");
  assert.match(title(html), /\(Manager 1\) owns this worktree — assistant-2 is not on the board any more/);
});

test("the detail bullet reads the name, then the role without its number", () => {
  const html = ownerDetailHtml({ assistant: owner({ id: "assistant-2", name: "Assistant #2", label: "Manager 2" }) });
  assert.equal(text(html), "Controlled by: Assistant #2 — Manager");
  assert.doesNotMatch(text(html), /Manager 2/, "the bullet names the role, not the numbered label");
  assert.match(html, /class="git-owner"/, "it sits in the merge state's own list");
});

test("the detail bullet keeps the fallback sentence in its own span", () => {
  const html = ownerDetailHtml({ assistant: owner({ stored: "assistant-2", fallback: goneFallback }) });
  assert.equal(text(html), `Controlled by: Assistant #1 — Manager — ${goneFallback}`);
  assert.match(html, /<span class="owner-fallback">/);
});

test("a payload with no role name still names the owner, with no dangling dash", () => {
  assert.equal(text(ownerDetailHtml({ assistant: owner({ role: "" }) })), "Controlled by: Assistant #1");
  assert.equal(ownerNameOf({}), "Assistant #1");
});
