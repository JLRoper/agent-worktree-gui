# Landing: the search list reads newest first, and a click away closes it (1.113.2)

PR #781 makes the assistant panel's turn search read the way a reader asks for it: the list is ordered by the clock
rather than by the cap's preference, so the newest match is 1 of N and Down walks backwards in time, and a mousedown
outside the box and the results closes the popover while the filter stays in the input.

Merge `5c0fd96`, tag `v1.113.2` at `5c0fd96`, `origin/main` at `88ec3e9` (the render), `changelog --check` reads
current with 623 releases. What a reader can open: `docs/assistant-search-keys.md`, and the run's own pictures under
`docs/assets/assistant-search-order/` - `1 of 4` on the five-minute reply, `2 of 4` after one `Down`, `4 of 4` on the
six-hour prompt, one message read top to bottom under a single `5 rows` header, the list closed by a click on the
transcript with the filter still in the box, the list reopened by one key, and a row click still selecting.

## What was wrong

Two defects, one surface.

**The order was the cap's.** The server answers a filter in the cap's own preference - your own input first, then
replies, then console lines - because that order decides which matches survive the ten-row cap. The popover drew that
answer as it arrived, so a filter whose hits spanned hours read a six-hour-old prompt on top and the reply from five
minutes ago at the bottom, and `Down` walked an order no reader wanted.

**The list would not close on a click away.** Only a key press or a click on a row closed it. A reader who clicked the
transcript, another pane of the same float or the board behind it kept a floating list over the card, still ringing a
match they had stopped looking at.

## The fix

`public/core/search-items.js` grows `order()`: one item per message, items newest first by their **newest** row's
stamp, the rows inside an item in **reading order** (the prompt, then the console lines by their own index, then the
reply), equal stamps broken by the conversation's own turn number and then by the answer's order, and a hit that
cannot name a message kept at the end so the header still divides every row the list holds. `runSearch` orders the
answer once, so the item map, the drawn rows, the walk and the footer's `displayed` all read one list; the header
`1 of N`, the footer's matched/displayed and the amber cap note cannot disagree with the order on screen.

Each item now draws its header **above** its rows (`searchItemHtml`, `.as-search-item`) and never after them. The
trailing next-item title that used to follow the last item read as one more, empty result; the last row before the
footer is now a result. The row keeps its own age, the header carries the message's place, its last activity and its
row count (`turn 5 - 26m - 5 rows`), and the cap note lost "first", which claimed an order for a list that is now the
clock's.

`public/core/search-dismiss.js` (new) is one pure predicate over the two zones a mousedown belongs to - the search
box and the results panel - and `wireSearch` listens on `mousedown` in the capture phase. A mousedown outside calls
`dismissSearch()`: the sequence moves on so a read already in flight cannot reopen what was closed, and `clearSearch()`
drops the hits, the ring, the marks and the count beside the box while the **filter stays in the input**, so the next
keystroke or one `Down` brings the same list back. A mousedown inside - a row, the list's scrollbar, its footer - is
not a dismissal, so a click still selects that row and a drag that starts inside the results never closes them.
Escape keeps its behaviour: the filter goes, the caret stays in the box.

## What was verified

- `node --test test/assistant-search-items.test.js test/assistant-search-dismiss.test.js
  test/assistant-search-count.test.js` - green, including the comparator's **tie case**, the reading order inside one
  item, the unplaceable hit, the two protected zones, the drag case, and the wiring read that `dismissSearch()` clears
  the answer without emptying the box.
- `node tools/verify-assistant-search-order.mjs` - **44/44** checks in headless Chromium at **1440x900**, on a
  synthesized store whose `harbor` hits are 6h, 5h, 2h and 5m old, one in a different field each. It prints the
  store's own order beside the popover's, so the reordering is the page's and not the API's: the answer leads with the
  six-hour prompt and the popover's LAST row is that prompt. `1 of 4` is the newest (ringed on that turn), one `Down`
  is `2 of 4` on the second newest, `4 of 4` is the oldest. One `lantern` message matching in its prompt, three
  console rows and its reply reads prompt/row1/row2/row3/reply under a single `5 rows` header. Then the clicks: a
  mousedown on the transcript closes the list, drops the ring, the marks and the row edge, leaves the filter in the box
  and leaves no stale count; one `Down` reopens it at `1 of 4`; a drag that starts on a row leaves it open and does not
  open the row; a row click still selects (`3 of 4` on that row's turn); a click on the Settings pane (another pane of
  the same float) closes it; Escape still clears and hands the caret back.
- `node tools/verify-assistant-search-keys.mjs` - **54/54** on its own store. Before this change's cap wording that
  run read 53/54, and the one red was the old sentence.
- `npm run test:changed` - every search test green.
- `npm test` - 2979 tests, 2966 pass, 13 fail. All 13 are pre-existing: the same files fail with the same names on a
  `git archive` of `origin/main` (`assistant-profile`, `child-route`, `gateway-permissions`, `header-controls`,
  `paths`, `paths-http`, `reasoning-runs`, `reply-actions-container`, `scan-roots`, `windows-hide`), and none of them
  reads the search or a file this landing touched.

## Version

`1.113.1` to `1.113.2`, a **patch** on purpose. The change adds a reader-facing affordance, which the scale calls a
minor, but the queued sibling branches already declare `1.113.3` and `1.114.0`; landing above them would force both to
re-bump for no reason. A patch above main keeps every queued number valid.

## Findings left alone

`node tools/verify-version-tags.mjs --ref origin/main` reads **FAIL - 7 findings across 623 version bumps**, and none
of them is this landing: two `backwards` entries at `1.76.13` and `1.79.0`, `wrong-commit` for `v1.76.22`, `v1.76.23`,
`v1.91.2` and `v1.92.4`, and `missing` for `v1.82.2`. `v1.113.2` is in the gate's own tagged-and-anchored count (618),
tagged at `5c0fd96`, the commit that first declared it. The 30 tags the gate reports as held on a branch belong to
sibling trees that have not landed; they are not this landing's to move.
