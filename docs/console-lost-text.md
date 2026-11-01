# The console's missing text: a paragraph stops where the reader left

Asked of this tree (0.47.0) with a screenshot of turn 6 of a finished run: the console shows three of the answer's
paragraphs cut to their first words — `This`, `Before it`, `Because it was a rebase mer` — while the run's own record
holds all of them in full. **Is text missing from the standard console output?**

**Yes — from the screen, not from the store.** The pacer (the word-at-a-time typewriter) held a prefix of each of
those paragraphs and never learned the rest, and every repaint afterwards drew the console from that prefix. The
line's own record (`data-ltext`, and the line in `jobs.json`) was whole the whole time, which is why a reload put the
text back and nothing else did.

## 1. What the screenshot is

| turn 6's record (`~/.wag/state/jobs.json`, job `be3b2e61`) | what the console drew |
| --- | --- |
| `This branch was added to main as version 0.47.0.` | `This` |
| `Before it landed, main was at 0.46.8 (c4a0093). PR #174 merged at 12:55 PM EST…` | `Before it` |
| `Because it was a rebase merge, the PR's first five commits show 0.46.8 in package.json…` | `Because it was a rebase mer` |
| `Your board on 7331 now reports 0.47.0 too: it restarted at 1:28 PM EST…` | whole |

Three paragraphs, three different cut points, two of them mid-word, and the last paragraph whole. That is the shape of
a typewriter that was interrupted, not of a truncation cap: a cap cuts at a fixed count, and every one of these cuts
sits at a different character.

## 2. The mechanism

A paragraph of the agent's own words is drawn through the pacer (`public/core/type-stream.js`): the wire says how the
line reads now, and the pacer hands back the prefix that may be drawn at the reader's words-a-second. Every repaint
asks the same pacer for the same prefix — `lineHtml` (`public/app.js:1233`) for a card rebuild, and the console's own
row renderer through `setShownFor` — so the console keeps typing across a rebuild instead of jumping to the wire's
whole text.

A hidden tab is where the two halves came apart (`public/app.js:8214` before this branch):

- the page drew every frame of a hidden tab WHOLE — the right answer for a reader who is not there — but it also
  returned before `P.feed(...)`, so the pacer was never told what the line now said;
- `visibilitychange` released the pacer (`public/app.js:6821`) and set it aside: every entry was "complete", holding
  the text the paragraph had when the tab went away;
- the rest of the answer arrived while the tab was hidden and was drawn whole, so the screen was right at that moment;
- when the reader came back, the next repaint drew every paragraph from the pacer — and the pacer's copy of those three
  paragraphs still ended at `This`, `Before it`, `Because it was a rebase mer`.

Nothing ever repaired it: the paragraphs were finished, so no frame would feed the pacer again, and the 5 s row pass
kept drawing the same prefix every time it rebuilt the card. The prefix is what a reader sees until a reload.

The reasoning blocks next to the prose already did this right (`paceThinkBlock`, `public/app.js:6572`: feed first, then
flush when there is no flow to show). The prose path was the one that skipped the feed.

## 3. The fix

- `typedText` (`public/app.js:6645`) feeds the pacer with every frame, hidden or not, and when the tab is hidden it
  flushes the entry so the pacer holds the whole line. The next reveal, and every repaint after it, draws the record.
- `shownFor` (`public/core/type-stream.js:196`) now takes the line the RECORD holds. It answers with a prefix only
  while that prefix really is a prefix of the record and the pacer has words left to release; a line the record has
  moved past (or rewritten) drops the entry, and the record draws whole. A prefix that can no longer grow is exactly
  the text the console loses.
- Both paint paths pass the record they are drawing from — `typedShown` (`public/app.js:6662`) for a repaint, and
  `paintTypedLines` (`public/app.js:6785`) for a tick, which reads the row's own `data-ltext`. A row with no record of
  its own (a reasoning row) asks with nothing and the pacer answers for itself, so reasoning still types.

## 4. The numbers

`node tools/verify-console-lost-text.mjs` drives the page's own live path and the page's own repaint against a sandbox
panel of the checkout (`recordJobLine`/`drawJobLine` per frame, `turnBody(turn)` to repaint), hides the tab mid-type,
lets the wire finish the answer, shows it again and compares every row with its record:

| | `git archive` of `main`'s tree before this branch | this branch |
| --- | --- | --- |
| paragraphs mid-type when the tab went away | 4 / 5 | 4 / 5 |
| rows drawn short after the repaint | **5 / 5** | **0 / 5** |
| characters missing from the console | **506** | **0** |

The same drive, at the page's own words-a-second, is what the screenshot caught by hand; the gate is the same numbers
on demand. `node tools/verify-console-lost-text.mjs --root <export>` runs it against another checkout — that is how the
left-hand column was measured, on a `git archive` of the base commit with no product file changed.

`test/console-typed-line.test.js` pins the rule without a browser: it reads `typedText`/`typedShown` out of
`public/app.js` between their markers and drives them with the page's own pacer and a hand-run clock.

## 5. What this settles, and what it does not

Settles:

- A paragraph that was mid-type when the tab was hidden comes back whole, and keeps coming back whole through every
  repaint after it. The pacer can no longer answer for a line the record has moved past.
- A rewrite (a trim that moves a line) is drawn from the record too, instead of from a prefix the line no longer
  starts with.
- Prose keeps its typewriter: the same drive shows 4 of the 5 paragraphs drawn short WHILE the reader is watching,
  which is the setting doing its job.

Does not settle:

- **A row that loses its `data-lid`.** `groupLines` reads a tool burst back as `{ kind, text }` and a re-cut group draws
  those rows without a line id, so a paced row inside it (a skill's result) cannot be painted by a tick at all. This
  branch makes the next repaint draw it whole, but the row is short until that repaint comes.
- **A hidden tab's own paint.** The frames a hidden tab draws whole are not the pacer's business; this note only makes
  the two agree. What a background tab costs in layout is not measured here.
- **The line cap.** A tool result longer than the card's head (40 lines, 400 characters) is a different fold, with its
  own note and its own click; it is not this.
