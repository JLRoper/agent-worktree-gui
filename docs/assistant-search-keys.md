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
| `Up` / `Down` | In the search box | Steps the current match to the previous / next matching **item** - one press, one whole turn. Scrolls it into view and marks it as the current match. Wraps at both ends. |
| `Enter` | In the search box | Opens the current match where the reader is standing: unfolds the turn if it was folded and marks the match inside it. It does not step to the next item. |
| `Esc` | In the search box | Clears the filter, the count and the highlight, and hands the caret back to whatever held it before `Ctrl+Q`. The panel stays open - `Esc` on the panel itself still closes it. |

`Ctrl+Q` is the panel's own key. A caret in a textarea or the reply composer is you writing, so the chord is left
alone there and nothing is stolen mid-sentence.

## One press is one item, not one row

A "hit" is one field of one turn. One filter can hit several fields of the same turn - the prompt, the reply and
two console lines, say - and stepping those one at a time would mean four presses to leave a single message. So the
hits are grouped into **items** before a press is counted:

```
4 turns, each matching in its prompt, its reply and one console line
  = 12 hits
  = 4 items      the count reads "1 of 4" ... "4 of 4", never "5 of 12"
```

An item is one turn, keyed by its thread and its turn id, and the walk follows the order the first hit of each item
appears in the list - so the count, the rows and the transcript order agree. The mapping lives in
`public/core/search-items.js`, loaded as a classic script and unit-tested by `test/assistant-search-items.test.js`.

## The ends wrap

Down on the last item lands on the first, and Up on the first lands on the last. That is the rule `Enter` already
had (the old step-through-list behaviour wrapped too), so no key disagrees with another about what follows the end.
There is no clamp: the wrap is the stated behaviour.

## The count, and what it refuses to hide

While a filter is live, the count beside the box reads `n of N` - the item you are standing on, of the matching
items - and its tooltip says how many hits matched and how many are on hand. When the cap bites (the result list
keeps your own input first, then replies, then console lines, up to ten rows) the count turns amber rather than
pretending the list is the whole answer: `12 hits matched, 10 displayed, 4 items to step through`.

The item count comes from the server's distinct-turn total, so it stays right even when the row list is cut short.

## What the current match looks like

Three surfaces say the same thing at once:

- the turn itself gets a 1px amber ring and a soft halo (`.is-search-current`), drawn round the whole message - all
  of its rows - so "which item" is one read;
- the matched text inside it is the bright mark rather than the ordinary brown one (`mark.as-search-mark.is-current`),
  so "which text in it" is a second read;
- the result rows of that item are marked current in the list, so the list and the transcript agree.

A press repaints, scrolls the item into view and rings it. A keystroke that only narrows the filter does not scroll:
the transcript must not jump under a reader who is still typing, so the answer's first item is highlighted where it
is and scrolled only when a press asks for it.

## Proving it

```
node test/assistant-search-items.test.js            # the match-to-item mapping, in isolation
node tools/verify-assistant-search-keys.mjs         # 47 checks in headless Chromium at 1440x900
```

The verify script boots this checkout's server with its own state directory and a synthesized store: four turns
whose prompt, reply and console line all match one filter. It opens the panel with the keyboard, walks the whole
flow above, and shoots each step. The pictures committed under `docs/assets/assistant-search-keys/` are that run:

| Picture | What it shows |
| --- | --- |
| `01-the-caret-on-a-panel-control-1440x900.png` | The run starts where a reader starts: the caret on a control in the panel. |
| `02-ctrl-q-lands-in-the-box-1440x900.png` | `Ctrl+Q` pressed: the caret is in the box and the box is empty, so nothing is selected yet. |
| `03-filter-1-of-4-1440x900.png` | The filter typed: `1 of 4` beside the box, the result list carrying every item, the first turn ringed. |
| `04-ctrl-q-selects-the-filter-1440x900.png` | A second `Ctrl+Q`: the whole filter is selected, so the next character typed replaces it. |
| `05-down-2-of-4-1440x900.png` | One `Down`: `2 of 4`, the second turn ringed and scrolled into view, its match bright. |
| `06-down-3-of-4-1440x900.png` | One more `Down`: `3 of 4`. One press moved one message, not one of its rows. |
| `07-down-4-of-4-1440x900.png` | One more `Down`: `4 of 4`, the last turn. |
| `08-wrap-at-both-ends-1440x900.png` | `Down` on the last item wrapped to `1 of 4`; `Up` from the first wrapped to `4 of 4`. |
| `09-folded-before-enter-1440x900.png` | The current turn folded, the filter intact. |
| `10-enter-opens-the-item-1440x900.png` | `Enter` unfolded it, marked the match and left the count at `4 of 4`. |
| `11-escape-cleared-and-caret-back-1440x900.png` | `Esc` cleared the filter, the count and the ring, and put the caret back on the control it took. |
| `12-ignored-in-a-textarea-1440x900.png` | `Ctrl+Q` in the Pad pane's textarea: the caret stays in the textarea. |

`assistant-search-keys.json` beside them is the run's own record: the filter, the viewport, the four turn ids and
the step each press landed on.

The script also checks the two hosts the chord must not touch (the composer and a textarea), and that no page error
came out of any of it.
