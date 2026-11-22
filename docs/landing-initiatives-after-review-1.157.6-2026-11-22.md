# Landing: the Initiatives tab's after-review round (1.157.6)

The after-review report (`docs/reports/initiatives-redesign-review-2026-11-22.html`, section 06, landed as PR 853)
found one blocker and five should-fix on the same three files. This row fixes all six together, because they touch
`public/style.css`, `public/assistant.js` and `tools/`, and because the blocker is a gate that the round's own list
had left out - so the fixes and the gates that can see them belong in one landing.

The two folded paragraphs the review asked for are in the report's F2 and F3; the numbers below are measured on this
tree, after the change, by the gates named beside them.

The version is 1.157.6 because 1.157.5 was taken by another landing (`6645ac28`) while this branch was open. The branch
was rebased onto `eb7b889e` and every gate below was re-run after the rebase; the three commits it gained touch
`CHANGELOG.md`, `package.json`'s version line and the Route report's HTML, none of which any gate or test here loads.

## The blocker: the gate that could not be green

`node tools/verify-initiatives-scroll.mjs` answered 31/33 at the shipped tree (`d0df8ca`) and 33/33 on the archived
parent (`c2692598`). The two failures were `:324` and `:334`, both of which demanded the WHOLE box of the last card
inside the pane: `last 133..880 in 173..900`. The scroll was correct - 8612 of 8612 at the foot, before and after the
tab's own re-read. The card is 747px tall with its fills open, inside a 727px pane, so its top and bottom cannot be on
screen at the same time and the assertion was false at every scroll position: the gate's defect, not the tab's.

The repair, in `tools/verify-initiatives-scroll.mjs`:

- `geometry()` now reports `lastHeight`, `lastBottomInPane` and `lastTallerThanPane` beside the old `lastInPane`
  (`:211-216`).
- `:340` asserts the last card's REACHABLE BOTTOM is inside the pane at maximum scroll, and `:341` still asserts the
  whole box whenever the card fits - the old claim survives in the case where it is meaningful, and the failure line
  says which card height made it impossible.
- `:351-352` do the same after the five-second re-read.
- The header (`:20-33`) states the reason and the two commits, so the next reader does not re-learn it.

The gate now answers 35/35, and it is in the round's gate list: `docs/reports/initiatives-redesign/gates-1.157.6.json`
names the four gates, the command that runs each, and the rule that the round is green only when every one of them is.

## The folded preview's ink

`public/style.css:5211` restored `--tab-ink-2` on `.init-card.is-titlecard .init-desc` (the folded preview and its
hover reading are measured at 8.53:1 and 7.86:1 by the redesign gate; it was 4.90:1 rest and 4.50:1 hover under
`--tab-ink-3`).

Counts and provenance keep `--tab-ink-3` at rest. On the row's hover fill the same ink measured 4.50 - the AA floor,
two steps below the preview beside it - so `:5251-5254` steps the counts, the provenance and the dot between the chips
to `--tab-ink-2` while the row is hovered. The 10px lane project tag is untouched: 4.51:1 on `--tab-raised` is the pair
round B named as its floor, and the sample reports it as the worst run rather than hiding it.

## The 37px edge

The route row paid 45px of padding and every other row paid 8, so a title with a route started 37px right of the rest
(measured 977 x3 against 1014 at 1440 dock, and the same 37 at 768 and 480). `public/style.css:5082` now reserves the
45px gutter on EVERY folded row - 10px in, 27px of dots, 8px to the title - and the dots paint in it only when a route
exists. The folded title lefts measured after the change are 1014 x4 at 1440, 474 x4 at 768 and 294 x4 at 480.

## The toolbar

`public/assistant.js:4052-4055` orders the four actions New initiative, Refresh, About, Compact rows - the primary
action first, and the same order in the keyboard path.

The row does not wrap (`public/style.css:5031-5050`): `.init-actions` is `nowrap`, the buttons do not shrink and their
labels do not wrap, and the words shorten instead. Under 430px of pane the density control says "Density"; under 320px
it says "Aa" and the primary says "New". Both keep their full names in `aria-label`, so the short form is what the eye
reads and not what a screen reader hears.

Measured by the tab gate's section 9: one row at a 768 window (347px pane) reading New initiative, Refresh, About,
Density, widest right 690 of 768; one row at a 480 window (239px pane) reading New, Refresh, About, Aa, widest right
439 of 480; every control 30px tall at both widths.

## The gates that could not see any of it

The review's gate table called `tools/initiatives-measure.mjs` blind, and it was right: the contrast sample read the
first `.init-desc` by class - in the open card - and the sample list held no lane selector at all.

- **The sample enters the folded row and the lane.** `tools/initiatives-measure.mjs:207` adds
  `.init-card.is-titlecard .init-desc` as its own sample, `:208` the provenance, and `:214-221` the lane's gate word,
  its automation word and the 10px project tag. A new `contrast-sample` check (`:508-509`) FAILS when any of the three
  places is not read, so a fixture without waves cannot pass on a sample that never entered the lane.
- **The hover fill is read with the pointer on it.** `foldedHoverFn` (`:280`) reads the preview, the count and the
  provenance from inside the folded row while it is hovered, and `measureInteractions` picks the first folded row that
  has all three. That is the reading that sees 4.50 on `--tab-hover`; a rest sample cannot.
- **The lane needs a store to be in the DOM.** `tools/initiatives-fixture.mjs:242-266` seeds three waves on Menu SSO,
  one of them with two named lanes and a member from each project, so every capture and every gate that opens the tab
  draws a real lane. The redesign gate opens that card before measuring (`verify-initiatives-redesign.mjs:106-116`,
  `:212`, `:258`); the fixture's first card is Kafka and carries no waves, so opening the first card was exactly the
  sampling mistake being fixed.
- **An empty sample is not a pass.** `chips-fit` (`:525`) now requires at least one chip before it can be green.
- **The folded list's one edge is a check.** `foldedLefts` (`:255`) reads every folded title, and `folded-alignment`
  (`:537`) holds the spread to the old rubric's 16px.
- **The open card draws a real caret.** The open plate used to draw no disclosure mark at all, so the tab gate could
  only assert "the head does not end with the folded ▸". `public/assistant.js:3879` now draws `▾` in
  `.init-caret.is-open` at the head's right edge (`public/style.css:5199`), and `verify-initiatives-tab.mjs:447,473`
  asserts the glyph, its class and its 11px on both the folded and the open head.

## Proof

The round's four gates, run on this tree with the changes in:

- `node tools/verify-initiatives-tab.mjs` - 102/102 checks (section 9 adds the twelve narrow-dock checks; the caret
  assertions replace the old "does not end with ▸" absence test).
- `node tools/verify-waves-lane.mjs` - 40/40.
- `node tools/verify-initiatives-redesign.mjs` - GATE GREEN 11/11; docked score 18/18 against the recorded 4/16
  baseline; wide 17/18 with only the deliberate second-column `alignment` miss. Contrast: worst 4.51:1 at
  `.wave-member-project` over 16 runs, with the folded preview, its hover fill and the lane all read.
- `node tools/verify-initiatives-scroll.mjs` - 35/35, including the reachable bottom at 8612 of 8612 and after the
  re-read.

The captures are in `docs/assets/initiatives-redesign/after-review-2026-11-22/`: `01-1440-dock-folded.png`,
`02-768-dock-folded.png`, `03-480-dock-folded.png` and `04-1440-dock-open-lane.png`.

The focused unit tests named by the touched modules: `test/initiative-fold.test.js`, `test/initiative-tasks.test.js`,
`test/waves-lane.test.js`, `test/text-styles.test.js`, `test/tail-chip-shared-rule.test.js` - 86 tests, 86 pass.

The full sweep, `npm test` (`node --test --test-concurrency=4` over the whole tree): **3,589 tests, 3,584 pass, 5
fail, 0 skipped**, in 8.5 minutes. The five are all outside the Initiatives tab and in modules this diff does not
touch: `gateway-permissions`, the junctioned-node_modules worktree removal, the scratch-over-HTTP route, the
`*File`/`*Dir`/`*Log` path derivation, and "main moving on changes the count against main". The review's run of the
same 3,589-test suite at the shipped tree answered 3,582 pass and **7** fail, so this is the pre-existing set rather
than five new ones - two of the seven passed on this run.

## What this row does not do

- **It does not move the open plate's left edge.** The folded ledger is the edge the review measured and the one the
  new check holds; the open plate keeps its own 16px padding and its internal alignment (986 x6, spread 6px).
- **It does not touch the 10px project tag's 4.51:1.** That is the floor round B named; the gate now reports it as the
  worst run instead of claiming a 5:1 headline the tab does not hold.
- **It does not re-render the review report or its captures.** The report stays the record of the shipped tree; this
  row's evidence is its own directory and this note.
- **It does not land.** See the PR body: the tree this branch was cut in held pre-existing unlanded work from another
  row (a 1.153.2 double-chip branch), which was left untouched on its own ref.
