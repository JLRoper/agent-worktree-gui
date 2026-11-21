# Landing: the collision card is a summary over four closed sections (1.147.0)

This branch opens a PR against `main`. It answers one screen: the card behind a row's collision diamond asked the
reader to rule on a pair, and the two presses that rule sat below the card's own bottom edge.

## The card before

Measured at 1440x900 through a real panel against a real git fixture (two worktrees dirty on the same two files, two
queue tasks, a merge check that conflicts both ways), on `main` at 56929642, at the card's natural 560px:

- the card was 560x630 with 835px of content in a 628px client: reaching the presses meant scrolling a popup;
- the state line printed the whole stand-down sentence, names and parenthesised titles included;
- all three presses measured `visible: false` against the card's own box;
- there were no sections at all: every line of git's verdict, the stand-down prose and the task numbers was in the
  one paragraph.

## The card now

Same fixture, same window, same 560px card: 560x459, 457px of content in a 457px client, all three presses
`visible: true`, and four headers closed with their own key lines.

The summary is three compact rows: both sides (role, tree, branch chip, task number and state on one line, the
task's own title clamped to one line beneath it), the shared files as chips, and the presses. The pill is a word -
`stood down`, `superseded by <sha>`, `resolved by absence`, `no row matches`, `same tree, not a collision`,
`auto-settled: <side> goes first` - and the sentence it replaced is History's, one press away.

| section | the line its header keeps while closed |
| --- | --- |
| This row | `#477 - Assistant #1 - parked` |
| Counterpart | `#180 - Assistant #3 - done` |
| Merge check | `both directions conflict - 2 shared files` |
| History | `#477 parked - #180 done - notice #478 done - notice #181 done` |

Each header is a real `<button>` with `aria-expanded` and `aria-controls`, and each body is closed by the `hidden`
attribute rather than a class, so a closed section is out of the tab order and out of a screen reader's read. The
chevron turns from a right to a down triangle.

A repaint keeps what the reader opened: `openRowChipPop` records the open sections by their `data-collision-acc`
slug, redraws the body, reopens them, then puts the caret back on the same control. Without that, the board's own
scan would fold the section under the reader's eyes every few seconds.

## What did not change

- The diamond, the popup, the two POSTs (`data-collision-rule` / `data-collision-pick`), the armed-then-confirmed
  wording and the record written into the pair are untouched.
- No backend change: nothing under `lib/` is edited, and the record shape, the states, the rulings and the history
  lane are as they were.
- With Collisions off, the markers and the card under each row stay exactly as they are.

## What proves it

```
node tools/verify-collision-pairs.mjs
  a throwaway panel, a real git fixture with four pairs, a 1440x900 viewport
  110 checks, 0 failed
  Tab reaches a closed header, Enter opens it without closing the card,
  Space closes it again, Escape closes the card and returns the caret to the diamond
node tools/verify-row-chips.mjs
  101 checks, 0 failed
```

The same harness opens each card behind its diamond now (the card is a popup, so "drawn once per row" is only
checkable by opening one at a time), reads the four headers and their key lines, and takes the shot of the card.

## The rebase

The branch was cut from 7bf705a4 and landed on 56929642 (the kind-lift control from #821 and the own-tree guard from
#820). `git rebase origin/main` was clean: main's five added `public/style.css` lines sit at the lift question, far
from the collision block; main never touched `public/board-scaffold.js`; and this commit never touched
`package.json`, so the predicted conflicts on those three files did not arise.

## Files

`public/board-scaffold.js`, `public/style.css`, `test/row-chips.test.js`, `tools/browser.mjs`,
`tools/verify-collision-pairs.mjs`, `package.json` (1.147.0), and the five screenshots in
`docs/reports/assets/collision-card-accordion/`:

- `before-1440.png` - main 56929642, 560x630, the paragraph and the presses below the card
- `after-1440.png` - 560x459, the summary and the four closed headers
- `after-live-pair.png` - a live pair, two running tasks and both presses
- `after-stood-down.png` - one side's task done, the pill a word and History carrying the reason
- `after-history.png` - a pair a landing ended, the pill naming the commit
