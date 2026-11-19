# Driving the Hot Agent search from the keyboard

The **Hot Agent search** is a control in the panel's floating header, the icon-only hand-and-pen button between
`✧ Assistant` and `🙋 Human` (it used to sit in the assistant panel's head, beside its turn search). Where the turn
search (`Ctrl+Q`) asks about *one assistant's own transcript*, this one asks about the **turns you wrote to worker
agents** - every run the panel started in a project tree, across every tree it has run one in. It reads
`GET /api/hot-agent/search` (`routes/hot-agent-search.js` over `lib/hot-agent/search.js`), so it reaches the whole
store rather than the five turns a card holds. `*` and `?` are wildcards and a plain filter is a substring, the same
rule as the turn search beside it (`public/core/turn-search.js`).

## What a row is, and what it is not

A row is one turn **you** wrote to a worker agent - a job in the panel's store whose prompt is your instruction. The
list never holds:

- an **assistant manager turn** - the panel's own sentry talking, or a wake it started for itself (`assistant: true`);
- a **turn the assistant wrote to a worker** - a steer or a follow-up it sent on your behalf (`origin.kind`
  `assistant-message` / `assistant-reply`);
- an **agent reply** - the completion the agent wrote back. The reply is not indexed at all: the search reads the
  prompt field, not `finalMessage` and not the console.

A reply **you** typed into a worker's card is still your turn and is in the list: the rule is about who wrote the
text, not about which box it was typed in.

## The keys

| Key | Where | What it does |
| --- | --- | --- |
| `Ctrl+Shift+Q` | Anywhere in the panel, open or closed | Opens the panel if it was closed, opens the list and puts the caret in the box with its text **selected**, so the first character typed replaces the last filter. Unlike `Ctrl+Q` it is honoured from a reply box too: the chord is explicit and the list never touches your text. |
| `Down` | In the box | Steps the highlight to the next turn, newest first, and scrolls the list so that row is fully visible. Wraps at the end. |
| `Up` | In the box | The same step backwards. Wraps at the start. |
| `Shift+Down` / `Shift+Up` / `Shift+Enter` | In the box | All three step **backwards** - the reverse of `Down`, without opening anything. |
| `Enter` | In the box | Opens the highlighted turn: the board is scrolled to the agent's card, the card flashes, and the turn itself gets the amber ring. The list closes. |
| `Esc` | In the box | Clears the filter, closes the list and puts focus back on the **button** in the header - `Esc` again closes the panel. |

No arrow press scrolls the page: the list's own scroller moves, one row per press, and the head and the footer never
scroll away. A mousedown outside the box and the list closes the list and **keeps** the filter, so the next open (or a
`Down`) asks the same question again.

## An empty box is a list, not a failure

The list opens on the most recent turns with nothing typed - the browsing gesture as well as the search. How many is
the Settings > Board row **Hot agent list**: 20 by default, 1 to 100, saved in this browser
(`public/core/hot-agent-list.js`, the same default and clamp `lib/hot-agent/search.js` falls back to). The count in
the popover's head reads `20 turns` while the list is standing on its first row - the size of the list, which is the
right answer once - and `2 of 20` from the first press that moves it; the footer says how many the
store holds when it holds more (`20 of 34 turns, newest first, every tree`) and goes amber when a filter matched more
than the list can show.

## The order

Newest first, by the clock the store wrote (`startedAt`), then by the turn's own counter, then by the job id - so two
turns that share a timestamp keep a fixed order between reads. The page does not re-sort: `Down` walks down the clock.

## The one component both bars use

The popover, the keyboard's meaning, the count's DOM, which row is current and the scroller follow are
**`public/core/search-popover.js`**, mounted once per bar. The follow is `public/core/search-scroll.js` - nearest edge
in, one row per press, the same number from either direction - which is the fix the turn search's popover got in
1.114.3 (#427); the Hot Agent list is built on that component rather than on a second copy of it. `test/search-popover.test.js`
pins the key meanings and the placement arithmetic; `test/hot-agent-search.test.js` pins the row's eligibility, the
order, the tie and the setting's default; `tools/verify-assistant-search*.mjs` still pin the turn search's own
behaviour beside it.
