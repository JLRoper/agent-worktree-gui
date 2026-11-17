# Driving the assistant's turn search from the keyboard

The search box in the assistant panel's head answers a filter over the assistant's own transcript: the prompt you
wrote, the reply it gave, and every line of the console. It reads the server's turn store (`GET
/api/assistant/search`), not the five turns a card holds, so a filter reaches the whole thread; `*` and `?` are
wildcards and a plain filter is a substring.

Everything below is doable without the mouse, because a search you have to reach for is a search you do not use.

## The keys

| Key | Where | What it does |
| --- | --- | --- |
| `Ctrl+Q` | Anywhere in the open assistant panel | Puts the caret in the search box and **selects what it already holds**, so the first character typed replaces the last filter. Ignored while the caret is in a textarea or in the composer. |
| `Down` | In the search box | Steps the current match to the next matching **row** - one press, one match, in the list's order (newest message first, rows in reading order inside it). Marks it in the transcript, and moves the list's current row with it, scrolling the list so that row is fully visible. Wraps at the end. |
| `Up` | In the search box | The same step backwards. Wraps at the start. |
| `Shift+Down` | In the search box | Steps **backwards** - the same move `Up` makes, for a reader who learned that Shift reverses the direction. Wraps like `Up`. |
| `Shift+Up` | In the search box | Steps backwards too. With `Shift+Down` and `Shift+Enter` it is the reverse of `Down`: all three land on the same row from the same start. |
| `Shift+Enter` | In the search box | Steps backwards, without opening anything. |
| `Enter` | In the search box | Opens the current match where the reader is standing: unfolds the turn if it was folded, scrolls it into view, marks the match and gets the list out of the way. It does not step. |
| `Esc` | In the search box | Clears the filter, the count, the list and the highlight, and leaves the caret **in the box**. The panel stays open - `Esc` on the panel itself still closes it. |

No arrow press scrolls the page: `Down` and `Up` in the box move the highlight, never the document. A press that
asks for a row outside the card's current page pages the card to it (the turn pager, not the window), which is why
the ring can appear without the page jumping under the reader.

`Ctrl+Q` is the panel's own key. A caret in a textarea or the reply composer is you writing, so the chord is left
alone there and nothing is stolen mid-sentence.

## One press is one match

A "match" is one field of one turn: the prompt, the reply, or one console line. The keyboard steps those, not the
messages they belong to:

```
one turn whose prompt and four console lines match the filter
  = 5 matches
  = 5 presses        the count reads "1 of 5" ... "5 of 5", and the highlight walks row by row
```

That is the point of the count: it names the row the reader can reach, not a grouping the highlight would then
have to skip. The old build grouped matches into turns and printed "1 of 1" for the case above while the footer
said five rows had matched - two true numbers, one broken-looking box.

The turns are still mapped, once, in `public/core/search-items.js` (loaded as a classic script by
`public/index.html` before `assistant.js`, unit-tested by `test/assistant-search-items.test.js`): the ring round
the whole message and the footer's "in N turns" both read the turn a match belongs to. The walk itself belongs to
`public/core/search-count.js`.

## The order the list reads in

The server answers in the **cap's** preference: your own input first, then replies, then console lines. That order
decides which matches survive ten rows; it is not the order a reader wants to walk. The list is ordered here, by
the clock (`public/core/search-items.js`'s `order`):

- **one item per message, newest first** - an item's place is its newest matching row, so a reply from five minutes
  ago sits above a console line from five hours ago whatever field the server preferred;
- **rows inside one message in reading order** - the prompt, then the console lines in the order they ran, then the
  reply, so a message still reads top to bottom;
- **ties broken by conversation order** - two messages whose newest rows share a timestamp keep the conversation's
  numbering, so the list does not shuffle between paints;
- **a row that cannot name a message** stays at the end of the walk rather than being dropped, because the header
  divides `displayed` and must count every row the list holds.

One header is drawn **above** each message's rows and never after them: a title with no rows under it reads as one
more, empty result. The header says the message's place in the conversation, when it last did something and how many
of its rows matched (`turn 5 - 26m - 5 rows`); each row's own age stays on the row, so a console line an hour into a
turn is not made to look an hour newer than it is.

`Down` therefore walks **backwards in time**: `1 of N` is the newest match and the oldest is last. `test/assistant-search-items.test.js`
pins the order, the reading order inside an item and the tie case.

## Clicking away closes the list

A mousedown anywhere **outside the search box and outside the results panel** closes the list and drops the
highlight; the filter stays in the box, so the next keystroke - or one `Down` - asks the same question again without
retyping it. The count beside the box goes with the list, so no stale `3 of 5` is left pointing at nothing.

- a click **inside** the results still selects that row, as before;
- a **drag that starts inside** the results never closes them: the decision is made on `mousedown`, and only a
  mousedown outside is a dismissal;
- **another pane** of the same float, the transcript below, the board behind it - all count as outside;
- `Esc` keeps its own behaviour (clear, caret stays in the box) and the panel's `Esc` still closes the panel.

The rule itself is one pure predicate in `public/core/search-dismiss.js` (`globalThis.wtSearchDismiss`), loaded by
`public/index.html` before `assistant.js` and unit-tested by `test/assistant-search-dismiss.test.js` - the two
protected zones, the drag case, and the fact that `assistant.js` clears the answer without emptying the box.

## The ends wrap

`Down` on the last match lands on the first, and `Up` on the first lands on the last. That is the rule `Enter`
already had (the old step-through-list behaviour wrapped too), so no key disagrees with another about what follows
the end. There is no clamp: the wrap is the stated behaviour.

## One count, two places that print it

`public/core/search-count.js` (`globalThis.wtSearchCount`) is the only thing that turns a result list into a
sentence. `assistant.js` hands it the rows the box steps (`searchHits`), the server's own `matched` total and its
`turns` total, and gets back:

| Surface | Text | Numbers it comes from |
| --- | --- | --- |
| beside the box | `2 of 5` | the current row of the rows the box holds (`hits.length`) |
| the list's footer | `5 hits matched, 5 displayed, in 1 turn` | `matched` as the server counted it, `displayed` = the same `hits.length`, `turns` = the distinct turns |

`displayed` is **not** a second server number: it is the length of the list the keyboard walks, so the header's
total and the footer's `displayed` cannot disagree by construction - and a page that passed a different
`displayed` into the module is ignored rather than trusted. `test/assistant-search-count.test.js` pins that with a
server answer whose `displayed` contradicts its `hits`, and with a wiring test that reads `assistant.js`'s call
site and the script order in `public/index.html`.

When the cap bites (the result list keeps your own input first, then replies, then console lines, up to ten rows)
the count turns amber rather than pretending the list is the whole answer: the header divides the ten rows on
hand, and the footer says `12 hits matched, 10 displayed, in 4 turns`. The turn count is secondary text in the
footer, never the number the header divides. The cap's note names the selection rule - `your own input is kept when
the cap bites` - and no longer claims an order for the list, which is the clock's.

## What the current match looks like

Four surfaces say the same thing at once:

- the turn itself gets a 1px amber ring and a soft halo (`.is-search-current`), drawn round the whole message - all
  of its rows - so "which message" is one read;
- the matched text inside it is the bright mark rather than the ordinary brown one (`mark.as-search-mark.is-current`),
  so "which text in it" is a second read;
- a console line the card draws as a folded tool group row (the tool's name and a chevron, with the command kept in
  the row's data rather than in visible text) gets the row's amber edge (`.is-search-current-row`) - there is no
  visible text there to mark, and an unmarked row would be a press that looks like it did nothing;
- the list's current row is marked current, so the list and the transcript agree about where the reader stands.

A press repaints the highlight and never scrolls the window. A keystroke that only narrows the filter paints the
answer's first match where it is, so the transcript does not jump under a reader who is still typing.

## The list follows the walk

The results are a popover with a fold: `placeSearchPop` caps its height at roughly the viewport's 42% and
`.as-search-pop` is its own scroller, so a filter with more rows than fit is read by scrolling the LIST, not the
card behind it. A keyboard step therefore moves the popover's scroller - never the transcript, never the page:

- after every `Down`, `Up`, `Shift+Down`, `Shift+Up` and `Shift+Enter`, the row the header counts is fully visible
  in the list. The caret stays in the box, the count and the box's own row do not move, and the popover's height
  does not change;
- the row is brought in from the nearest edge, one row per press. Once the walk is past the fold, each press moves
  the list by exactly one row, and no press is a page and none is animated (a plain `scrollTop` write, so a held key
  cannot queue a smooth scroll behind it);
- a matching row TALLER than the list's visible band keeps its **top** visible rather than its bottom: the text a
  reader searched for starts at the top of a row, and a bottom-aligned tall row would show them its foot;
- the way back is the way down. A row's offset is a function of that row's own geometry, not of the direction the
  walk arrived from, so stepping `Up` from the last result scrolls the list up by exactly the rows the `Down` walk
  scrolled down, and the first result comes back at the top where it started.

`Enter` and a click on a row are unchanged: they open the turn in the card, scroll the transcript to it and get the
list out of the way. A click on a partly visible row still selects that row.

The arithmetic is `public/core/search-scroll.js` (`wtSearchScroll.target`, `place` and `shows`), a pure function of
the row's offset, its height, the band's height and the scroller's reach, loaded as a classic script by
`public/index.html` before `assistant.js` and unit-tested by `test/assistant-search-scroll.test.js`. `assistant.js`
reads the two nodes and hands them over (`keepSearchRowVisible`).

## Proving it

```
node --test test/assistant-search-count.test.js       # one count source: header total == footer displayed
node --test test/assistant-search-items.test.js       # the match-to-turn map and the list's order, in isolation
node --test test/assistant-search-dismiss.test.js     # the outside-mousedown predicate, and the page that calls it
node --test test/assistant-search-scroll.test.js      # the scroll target: nearest edge, tall row, reverse walk
node tools/verify-assistant-search-keys.mjs           # 54 checks in headless Chromium at 1440x900
node tools/verify-assistant-search-order.mjs          # 44 checks: the order and the dismissal, at 1440x900
node tools/verify-assistant-search-scroll.mjs         # 117 checks: the list follows the walk, at 1440x900
```

The keys script boots this checkout's server on a free port with its own state directory and a synthesized
store: one turn whose prompt and four console rows match one filter, five turns with one matching row each, and
four turns matching in three fields (twelve rows for a ten-row list). It opens the panel with the keyboard, types,
presses, and shoots each step. Every subject is a key press - nothing in the run clicks, focuses a locator or calls
a page function that acts. The pictures committed under `docs/assets/assistant-search-count/` are that run:

| Picture | What it shows |
| --- | --- |
| `01-five-rows-in-one-turn-1-of-5-1440x900.png` | Five rows of one turn matching: the header reads `1 of 5`, the footer `5 hits matched, 5 displayed, in 1 turn`, the prompt bright. |
| `02-down-2-of-5-1440x900.png` | One `Down`: `2 of 5`, the highlight on the next console row of that same turn, the page not scrolled. |
| `03-shift-up-back-to-1-of-5-1440x900.png` | `Shift+Up`: `1 of 5` again, the highlight back on the prompt. |
| `04-five-turns-2-of-5-1440x900.png` | The five-turn filter, one `Down`: `2 of 5` and the next message ringed. |
| `05-capped-amber-1-of-10-1440x900.png` | Twelve matches, ten rows: `1 of 10` in amber, `12 hits matched, 10 displayed, in 4 turns`. |

`assistant-search-count.json` beside them is the run's own record: the viewport, the filter and count each press
landed on, and the file names of the shots.

The script also checks that `Shift+Down` and `Shift+Enter` step backwards, that `Down` on the last row wraps, that
`Enter` opens without stepping, that `Esc` empties the filter and leaves the caret in the box, and that no page
error came out of any of it.

The order script is the second half: a store whose `harbor` hits are six hours, five hours, two hours and five
minutes old, one in a different field each, and one `lantern` message matching in its prompt, three console rows and
its reply. It proves the store's answer leads with the six-hour prompt while the popover leads with the five-minute
reply, that `1 of 4` is the newest and `4 of 4` the oldest, that one `Down` is the second newest, that a message's
rows still read top to bottom under one header, and that the last row before the footer is a row. Then it clicks:
the transcript below closes the list with the filter still in the box and no count left behind, one `Down` reopens
it at `1 of 4`, a drag that starts on a row does not close it, a row click still selects, and a click on the Settings
pane (another pane of the same float) closes it. The pictures under `docs/assets/assistant-search-order/` are that
run, and `assistant-search-order.json` is its record.

The scroll script is the third half: twelve matching messages with bodies long enough that the transcript's own box
overflows, so the filter shows ten rows in a popover shorter than its content (six fit). It opens the panel with the
keyboard, types the filter, then walks `Down` from `1 of 10` to `10 of 10` and `Up` all the way back, asserting on
every press that the current row is fully inside the popover's band, that the popover's height, its top and the box
above it did not move, that the caret stayed in the box, that the page stayed at `scrollY` 0, and that no box whose
content did not change scrolled. It then compares the down walk's offsets with the up walk's: they are the same
numbers in reverse. The pictures under `docs/assets/assistant-search-scroll/` are that run, and
`assistant-search-scroll.json` is its record:

| Picture | What it shows |
| --- | --- |
| `01-first-result-1-of-10-1440x900.png` | `1 of 10`, the first row current at the top of the list, the transcript ringed. |
| `02-middle-result-5-of-10-1440x900.png` | Five `Down`s: `5 of 10`, the fifth row current and fully visible at the list's bottom edge. |
| `03-last-result-10-of-10-1440x900.png` | Nine `Down`s: `10 of 10`, the last row current and fully visible, the list at the end of its reach. |
| `04-back-to-the-middle-5-of-10-1440x900.png` | `Up` from the last: `5 of 10` again, the row in view on the way back. |
| `05-back-to-the-first-1-of-10-1440x900.png` | Home: `1 of 10`, the list back at the top, the same row and the same offset as the first shot. |
