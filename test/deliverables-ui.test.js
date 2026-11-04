// The DELIVERABLES hand-back list — the page's half.
//
// The plan (docs/plan/deliverables-handback.md) puts the harvest and the store in lib/, behind two routes, and the
// reader's list in the page. This file pins the page against the plan's five DECIDED choices and the two review
// findings that are reader-facing:
//
//   * the button's word is DELIVERABLES, one control in the header, between HUMAN and Collapse all (§5.1);
//   * one row per target, updated in place — the page must not paint a second row for a repeat (§4.3, Q2);
//   * a malformed DELIVER is a console line on the card, so this list never invents a row for one (§2.3, Q3);
//   * an `image` is a glyph and the OS viewer: no new route, no thumbnail (§2.2, Q4 — the DECIDED choice);
//   * the paragraph rides every tree turn; that is the backend's, and this file only asserts the page documents
//     the grammar in its empty state so a reader can tell an agent by hand (§3.3, Q5).
//
// Two blockers the review found are pinned here because a regression in either is invisible until a reader clicks:
// the row opens the agent by JOB ID, never by the `turn` counter (M7), and a target that is gone is said as `gone`
// rather than silently failing (B2/M6's reader-facing consequence).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const cssRaw = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
// The stylesheet's comments argue the rules; a keyword in prose is not a rule.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
const block = () => sliceRegion(app, "deliverables");

test("the header carries one DELIVERABLES button, between HUMAN and Collapse all", () => {
  const button = html.match(/<button id="btn-deliver"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(button, "no #btn-deliver in the header");
  const tag = button[0];
  assert.match(tag, /type="button"/, "a header control is a plain button");
  // The plan's word, and no count: this is an archive, not a queue (§5.1, "No badge").
  assert.match(tag, />\s*DELIVERABLES\s*</, "the label is DELIVERABLES");
  assert.doesNotMatch(tag, /deliver-badge|dl-badge/, "no badge — a permanent count reads as work outstanding");
  // The title has to say what the click does and that D is the key, because that sentence is the only
  // documentation a reader gets before the popover exists.
  assert.match(tag, /title="[^"]*every deliverable[^"]*"/i, "the title says what the list is");
  assert.match(tag, /title="[^"]*\bD\b[^"]*"/, "the title names the D key");

  const at = html.indexOf('id="btn-deliver"');
  const human = html.indexOf('id="btn-human"');
  const collapse = html.indexOf('id="btn-collapse-all"');
  assert.ok(human >= 0 && collapse >= 0, "the two neighbours this button sits between are still in the header");
  assert.ok(human < at && at < collapse, "#btn-deliver sits after #btn-human and before #btn-collapse-all");
  assert.equal(html.split('id="btn-deliver"').length - 1, 1, "exactly one DELIVERABLES button");
});

test("D opens and closes the list, and a d typed into a field stays in the field", () => {
  const src = block();
  // The HUMAN precedent, both halves: the bare letter and the two guards (M13, N10).
  assert.match(src, /humanTextEntry\(document\.activeElement\)/, "a caret in any field owns the keystroke");
  assert.match(src, /e\.repeat/, "holding the key must not race the toggle");
  assert.match(src, /if \(e\.key !== "d" && e\.key !== "D"\) return;/, "bare d/D only");
  assert.match(src, /toggleDeliverPop\(\)/, "the key toggles the list");
  // The button itself toggles too, and says whether it is open to AT.
  assert.match(src, /aria-expanded/, "the button carries aria-expanded");
});

test("a row shows every deliverable with its age, its agent and its project", () => {
  const src = block();
  assert.match(src, /fmtAgo\(/, "the age is fmtAgo — '3m ago' means the same thing here as on every card");
  // Newest first is the panel's own order; the page must not sort by anything else.
  assert.match(src, /entries/, "the page paints the store's entries");
  assert.doesNotMatch(src, /\.sort\(/, "the store writes itself newest-first; the page does not re-order it");
  assert.match(src, /dl-name/, "the title is the row's link");
  assert.match(src, /open agent/, "the row offers the agent as a keyboard/AT button");
  // Day separators, so a 200-row scroll has landmarks (§5.5).
  assert.match(src, /TODAY/, "day separators are landmarks in a long list");
  assert.match(src, /YESTERDAY/);
});

test("the row opens the agent by JOB ID, never by the turn counter (M7)", () => {
  const src = block();
  // humanShow looks a turn up as `t.id === q.turnId`; each turn's id IS the job id. `turn` is
  // `siblings.length + 1` and moves backwards when old jobs are trimmed, so it cannot address a turn.
  assert.match(src, /t\.id === .*jobId/, "the turn is found by job id");
  assert.doesNotMatch(src, /turnOpen\.set\(\s*(?:entry|e|it)\.turn\b/, "never page a turn in by the counter");
  assert.doesNotMatch(src, /t\.turn === /, "never match a turn by the counter");
  // The three fallbacks are said, not swallowed (§6.2).
  assert.match(src, /no longer on the board/, "a trimmed turn is reported");
  assert.match(src, /opened its worktree/, "a gone thread falls back to its worktree");
});

test("an image is a glyph and the OS viewer — no new route, no thumbnail (Q4, DECIDED)", () => {
  const src = block();
  assert.match(src, /🖼/, "an image gets its own glyph");
  assert.match(src, /🔗/, "a link gets its glyph");
  assert.match(src, /📄/, "a file gets its glyph");
  // One route opens all three; the kind decides which program. A thumbnail route is the thing the decision
  // deferred, so neither the page nor the stylesheet may grow one.
  assert.match(src, /\/api\/deliverables\/open/, "the open goes through the recorded entry's route");
  assert.doesNotMatch(app, /deliverables\/thumbnail/, "no thumbnail route on the page half");
  assert.doesNotMatch(html, /deliverables\/thumbnail/);
  assert.doesNotMatch(src, /<img\b/, "no image bytes are painted");
  // The target is what the store recorded; the page never sends a path back.
  assert.match(src, /JSON\.stringify\(\{\s*seq/, "the page sends only a seq");
});

test("a gone target says gone, and the click still tries", () => {
  const src = block();
  assert.match(src, /missingAt/, "the row reads the store's missingAt");
  assert.match(src, /gone/, "the chip says what the reader sees");
  assert.match(src, />\s*gone\s*</i, "the chip is text, not only a colour");
  // A click must not be disabled: the file may have been restored.
  assert.doesNotMatch(src, /data-dl-open="[^"]*"[^>]*disabled/, "a gone row still tries the click");
});

test("the popover is the artifacts-pop idiom: fixed, above the board, scrolling", () => {
  const rule = css.match(/\.deliver-pop \{([^}]*)\}/);
  assert.ok(rule, "no .deliver-pop rule");
  assert.match(rule[1], /position:\s*fixed/, "it hangs off a header button, so it is fixed");
  assert.match(rule[1], /z-index:\s*60/, "above the board, the same layer the artifacts pop uses");
  assert.match(rule[1], /max-height:\s*min\(70vh, 640px\)/, "bounded height, so 200 rows scroll");
  assert.match(rule[1], /width:\s*min\(560px, 92vw\)/, "the plan's width, still readable on a narrow window");
  assert.match(css, /\.deliver-pop \.dl-body \{[^}]*overflow-y:\s*auto/, "the rows scroll, the head and footer stay");
  assert.match(css, /#btn-deliver/, "the button has its own rule");
});

test("the empty state documents the grammar; a failed read says so and offers retry", () => {
  const src = block();
  assert.match(src, /Nothing has been delivered yet/, "an empty list says nothing has been delivered");
  assert.match(src, /DELIVER file C:\/path\/to\/report\.html \| The report/, "one valid example, in a code line");
  assert.match(src, /could not read the list/i, "a failed read is not an empty list");
  assert.match(src, /retry/i, "and it offers the retry");
});

test("the list is bounded by the store's cap, and the cap line appears only at the cap", () => {
  const src = block();
  assert.match(src, /older rows are forgotten/, "the footer says what the cap does to the list");
  assert.match(src, /files stay on disk/, "and that pruning never deletes a file");
  // The footer only shows at the cap: a number below the cap has nothing to explain.
  assert.match(src, /cap/, "the page reads the store's cap");
  assert.match(src, /kept\s*>=\s*.*cap|cap\s*<=\s*.*kept/, "the cap line is gated on being at the cap");
});
