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
| `Down` | In the search box | Steps the current match to the next matching **row** - one press, one match. Marks it in the transcript and moves the list's current row with it. Wraps at the end. |
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
footer, never the number the header divides.

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

## Proving it

```
node --test test/assistant-search-count.test.js       # one count source: header total == footer displayed
node --test test/assistant-search-items.test.js       # the match-to-turn map, in isolation
node tools/verify-assistant-search-keys.mjs           # 54 checks in headless Chromium at 1440x900
```

The verify script boots this checkout's server on a free port with its own state directory and a synthesized
store: one turn whose prompt and four console rows match one filter, five turns with one matching row each, and
four turns matching in three fields (twelve rows for a ten-row list). It opens the panel with the keyboard, types,
presses, and shoots each step. Every subject is a key press - nothing in the run clicks, focuses a locator or calls
a page function that acts. The pictures committed under `docs/assets/assistant-search-count/` are that run:

| Picture | What it shows |
| --- | --- |
| `01-five-rows-in-one-turn-1-of-5-1440x900.png` | Five rows of one turn matching: the header reads `1 of 5`, the footer `5 hits matched, 5 displayed, in 1 turn`, the prompt bright. |
| `02-down-2-of-5-1440x900.png` | One `Down`: `2 of 5`, the highlight on the newest console row of that same turn, the page not scrolled. |
| `03-shift-up-back-to-1-of-5-1440x900.png` | `Shift+Up`: `1 of 5` again, the highlight back on the prompt. |
| `04-five-turns-2-of-5-1440x900.png` | The five-turn filter, one `Down`: `2 of 5` and the next message ringed. |
| `05-capped-amber-1-of-10-1440x900.png` | Twelve matches, ten rows: `1 of 10` in amber, `12 hits matched, 10 displayed, in 4 turns`. |

`assistant-search-count.json` beside them is the run's own record: the viewport, the filter and count each press
landed on, and the file names of the shots.

The script also checks that `Shift+Down` and `Shift+Enter` step backwards, that `Down` on the last row wraps, that
`Enter` opens without stepping, that `Esc` empties the filter and leaves the caret in the box, and that no page
error came out of any of it.
