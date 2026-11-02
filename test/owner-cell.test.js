// The owner cell and the detail bullet: the compact TAG in the cell ("M1"), the assistant's own name and its numbered
// role label in the tooltip, and "Controlled by: Assistant #1 — Manager" as its own bullet in the row's detail.
//
// The cell used to draw the role label the server resolved ("Manager 1"), which names a seat on a role rather than
// the assistant that owns the tree; it then drew the assistant's NAME ("Assistant #1"), which is right but costs a
// whole wide column to say the same two characters on every row of a board that has one assistant. It now draws the
// tag, with the name and the label in the tooltip. The label is still resolved at read time (so a role rename renames
// both the tag and the tooltip without a write). A row the server could not name still draws a tag — A1 — and never a
// dash: a column of dashes hides the fact that nothing there is unowned.
//
// The cell's class is `owner`, not `assistant`: `.assistant` is the docked rail's own rule (a sticky flex column
// 480px wide), and `<td class="assistant">` inherited all of it. That is asserted here rather than trusted.
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
const { ownerNameOf, ownerTagOf, ownerCellHtml, ownerDetailHtml } = new Function(
  "esc",
  `${code}; return { ownerNameOf, ownerTagOf, ownerCellHtml, ownerDetailHtml };`,
)(esc);

const text = (html) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const title = (html) => (/title="([^"]*)"/.exec(html) || [])[1] || "";
// What the server's `ownerFields` sends for a tree nobody moved, and for one reassigned to the second assistant.
const owner = (over = {}) => ({ id: "assistant-1", name: "Assistant #1", label: "Manager 1", role: "Manager", ...over });
const goneFallback =
  "assistant-2 is not on the board any more, so Assistant #1 controls this worktree until you set an owner again";

test("the default owner draws the compact tag M1, not its name and not the role label", () => {
  const html = ownerCellHtml({ assistant: owner() });
  assert.equal(text(html), "M1", "Manager 1 compresses to M1");
  assert.doesNotMatch(text(html), /Assistant|Manager/, "neither the name nor the label is the cell's text");
  assert.match(html, /class="owner-tag"/, "the tag is its own chip, so the cell can ellipsize it");
});

test("a row with no owner object at all still draws a tag — never a dash", () => {
  for (const row of [{}, { assistant: null }, { assistant: { name: "" } }]) {
    const html = ownerCellHtml(row);
    assert.equal(text(html), "A1", JSON.stringify(row));
    assert.notEqual(text(html), "—");
    assert.doesNotMatch(text(html), /^[—–-]+$/, "a dash must never render in this column");
  }
});

test("the tag is the numbered role label's initials and number", () => {
  assert.equal(ownerTagOf({ assistant: owner() }), "M1");
  assert.equal(ownerTagOf({ assistant: owner({ id: "assistant-2", name: "Assistant #2", label: "Manager 2" }) }), "M2");
  assert.equal(ownerTagOf({ assistant: owner({ label: "Code Reviewer 2", role: "Code Reviewer" }) }), "CR2");
  // No label from the server (a board with no records, or a row built by hand): the NAME still ends in the number.
  assert.equal(ownerTagOf({ assistant: { name: "Assistant #3" } }), "A3");
  assert.equal(ownerTagOf({}), "A1");
});

test("a reassigned row draws its own assistant's tag, and the tooltip carries its name and role label", () => {
  const html = ownerCellHtml({ assistant: owner({ id: "assistant-2", name: "Assistant #2", label: "Manager 2" }) });
  assert.equal(text(html), "M2", "the tag names the assistant the reader gave the tree to");
  assert.match(title(html), /^M2 — Assistant #2 \(Manager 2\) owns this worktree\./);
  assert.match(title(html), /Display only: it does not change who wakes or runs\./);
  assert.doesNotMatch(title(html), /Manager 1/, "the tooltip names the owner's own seat, not the default's");
  assert.match(html, /aria-label="Assistant #2"/, "the tag keeps the full name for a screen reader");
});

test("a row whose stored owner is gone keeps the fallback sentence beside the role label", () => {
  const html = ownerCellHtml({ assistant: owner({ stored: "assistant-2", fallback: goneFallback }) });
  assert.equal(text(html), "M1", "the tag names who actually owns it now");
  assert.match(title(html), /\(Manager 1\) owns this worktree — assistant-2 is not on the board any more/);
});

test("the cell does not carry the rail's own class, and its tag is not `.assistant` either", () => {
  const html = ownerCellHtml({ assistant: owner() });
  assert.match(html, /^<td class="owner nowrap"/, "the cell's class is `owner`");
  assert.doesNotMatch(html, /class="[^"]*\bassistant\b/, "no ancestor of the tag may inherit the rail's .assistant rule");
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /#assistant \{[^}]*position: sticky/, "the rail's rule is scoped to #assistant");
  assert.doesNotMatch(css, /^\.assistant \{/m, "an unscoped `.assistant` rule would catch the cell again");
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
