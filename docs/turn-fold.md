# The pager is the collapse gesture

A turn is an accordion, and a long thread is paged five turns at a time. Before this change the arrows moved the
window and nothing else: a reader who walked a thirty-turn thread with `▲` and came back with `▼` still had the whole
newest page open under them, because nothing had ever said the page they were leaving was a page they had finished
with. The turn they had just read was the one the card still opened on.

Now the gesture and the fold are one thing: **every turn on the page you just left folds.** Going up and back down is
how you close a thread behind you, and it is the only gesture that does it.

## What the rule covers, and what it deliberately does not

- **Both directions.** Up folds the page being read (including the turn the card had opened on); coming down folds
  the page that was only passed through. An arrow pressed at its own end moved nothing, so nothing folds.
- **A starred turn's pinned copy is not touched.** The pinned block sits above the page on *every* page, so it is not
  "the page I left". It is also the one copy the reader opened on purpose — and a pinned copy starts folded, exactly
  as it always has, because a pin is a reference to a turn and one that arrived expanded would push the page it is
  pinned above down. Its own copy *in* the page folds with the page like any other.
- **Nothing else moves.** Folding a page is one write per turn in the fold book: it does not change the frozen
  (snippet) form, the page offset, the scroll position or the card's other strips.

## The fold book lives in one place

The three books — which copies are open (`turnOpen`), which are frozen to a snippet (`turnCompact`), and which page a
card shows (`turnPage`) — are written by **`public/core/turn-fold.js`** and nowhere else.

That is the point of the module. The rules were previously answered in two files: `public/app.js`'s renderer decided
"open" from the book and spelled the pager arithmetic three times (the page's slice, the count beside the arrows, and
the click that moved it), while `public/assistant.js` reached into `turnOpen` / `turnPage` itself to unfold the newest
turn for a queue row. The assistant's copy of the rule could not page to the turn it was opening — a reader who had
walked back to an older page landed on a card whose console was not on the page — and the page arithmetic its formula
used (`pages − floor(index / page size)`) is only correct when the thread divides evenly into pages: seven turns of
five put turn 3 on the newest page, and that formula answered page 1.

What the module owns, one answer each:

| The rule | The module | Was |
| --- | --- | --- |
| The key a turn copy is stored under (`<id>`, `pin:<id>`) | `key`, `idOf`, `isPinCopy` | spelled in `app.js` and parsed again in `assistant.js` |
| Is this copy open (newest-of-a-card default; a pin folded) | `isOpen`, `setOpen`, `toggle` | `app.js` decided it, `assistant.js` wrote the map |
| Page count, the page's slice, the offset, the arrow press | `pages`, `range`, `offset`, `stepPage`, `pageForIndex`, `gotoPageForIndex` | three copies of the same sums in `app.js` |
| The gesture (the page just left), every turn, both copies | `foldPage`, `foldAll` | the page's fold did not exist; `foldAll` was a loop in two places |
| Put one turn in front of the reader (open, un-frozen, paged in) | `reveal` | three separate writes in two jump paths, a fourth in the assistant — one of them without the page |

`app.js` keeps its two render-side names (`turnKey`, `turnIsOpen`) as one-line delegations, so every call site in the
renderer reads as it did. `assistant.js` has no access to the books at all: its queue row's "open this turn" is
`wtTurnFold.reveal`. `test/turn-fold.test.js` asserts both: no `state.turnOpen` / `turnCompact` / `turnPage` write
outside the module, no read of them in `assistant.js`, no second spelling of the page size in `app.js`, and the module
loaded before `app.js` in `public/index.html`.

## The proof

`tools/verify-turn-fold.mjs` drives a throwaway panel with a dead gateway and seven settled turns in one thread, opens
the rail the way the panel remembers it, and clicks the real arrows and turn heads. It asserts the drawn card:
the newest page with its newest turn open; up landing on `1–2 / 7` and folding turns 3–7; down landing back with
**every** turn folded; starring turn 7 adding a folded pin and opening nothing; the pin opening on a click and staying
open through both directions while the pages it passes fold; and a second click closing it.

```
node tools/verify-turn-fold.mjs --shots <dir>                    # this checkout: RESULT: ALL PASS (23 checks)
node tools/verify-turn-fold.mjs --root <archive of origin/main>  # the base: RESULT: 4/23 FAILED
```

The base fails on exactly the rule this adds: after up-and-back-down the newest turn is still open (`open: tkfold7`),
starring opens nothing on the page because nothing was ever closed, and the open pin has an open copy under it.

The unit side is `test/turn-fold.test.js` (11 cases: the keys, the defaults, the arithmetic, both directions of the
gesture, the pin's exemption, `reveal`, `foldAll`, `prune`, and the one-owner source gates).
