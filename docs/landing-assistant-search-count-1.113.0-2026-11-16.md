# Landing: the assistant search counts one thing, and the keys walk it (1.113.0)

PR #778 makes the assistant panel's turn search answer with one number. While a filter is typed the count beside the
box reads the current match of the match total (`2 of 5`), the footer's `displayed` is that same total, and the turn
count is footer text only - so no view can print two numbers that disagree. `Down` steps matches from the box
without `Enter`, `Shift+Down`, `Shift+Up` and `Shift+Enter` step backwards, `Enter` keeps its jump into the results,
`Escape` keeps returning the caret to the box, and no arrow press scrolls the window.

Merge `76dec4d`, tag `v1.113.0` at `76dec4d`, `origin/main` at `1e471b3` (the render), `changelog --check` reads
current - 621 releases. What a reader can open: `docs/assistant-search-keys.md`, and the run's own pictures under
`docs/assets/assistant-search-count/` - `1 of 5`, `2 of 5` after one `Down`, `1 of 5` again after `Shift+Up`, the
five-turn case, and the capped list.

## What was wrong

The header counted turns and the footer counted rows. A filter that hit five rows of ONE message - a prompt and four
console lines - read `1 of 1` beside `5 hits matched, 5 displayed, in 1 turn`: two true numbers, one box that looked
broken, and a keyboard that could not reach four of the five rows the footer named. The old step also grouped
matches into turns, so `Down` moved a message at a time while the count divided something else.

## The fix

`public/core/search-count.js` (new) is the one count source: `readout()` takes the rows the box steps, the server's
`matched` and `turns`, and answers the header text, the footer text and the title. `displayed` is the length of that
row list, never a second server number - a page that passes a different one is ignored. `step()` lives there too:
one press, one match, wrapping at both ends.

`public/assistant.js` holds the wiring: `searchReadout()` delegates to the module; `revealSearchHit()` marks the
exact row a hit names (`hitScopeIn()` reads the prompt span or the console row's `lid`); a press that arrives while
a new filter is still being read answers THAT filter and lands on its first row, instead of stepping the previous
answer; Shift is the reverse direction for `Down`, `Up` and `Enter`.

`lib/assistant/search.js` gives console hits their row's `lid`, so a mark lands on the line that matched rather than
on the first matching text in the message.

`public/style.css` adds `.is-search-current-row`: a console tool CALL is drawn as a folded group row (tool name and
chevron, the command in the row's data), so a hit on that line has no visible text to mark and the amber row edge is
what says where the walk is standing.

The capped-list amber warning and the footer's `hits matched` wording are unchanged.

## Proof

`node tools/verify-assistant-search-keys.mjs`: 54 checks, keyboard only, headless Chromium at 1440x900, against a
synthesized store - a filter matching five rows inside one turn, five turns matching one row each, and twelve rows
for a ten-row list. Every subject is a key press; nothing clicks, focuses a locator or calls a page function that
acts. The five pictures are committed.

`test/assistant-search-count.test.js` pins the count source: the header total equals the footer's `displayed`, a
server `displayed` that contradicts its own `hits` cannot reach the footer, the cap keeps its amber, and the page's
call site and script order are read from `assistant.js` and `public/index.html`.

`npm test`: 2960 tests, 2947 pass, 13 fail - the same 13 titles fail on `origin/main`'s tree (paths, scan roots,
gateway permissions, header controls, reply actions, child route, profile, windows-hide, and a reasoning-runs test
that flips on timing in both trees).

## How it landed

`npm run land:pr -- 778` was refused twice by GitHub's GraphQL merge mutation (`Something went wrong while executing
your query`), with nothing merged; `gh pr merge 778 --rebase --admin` merged at 04:22:39Z, and `tools/land.mjs` then
did the landing's own last step - render at the merged tip, push, and move `v1.113.0` onto `76dec4d`.
