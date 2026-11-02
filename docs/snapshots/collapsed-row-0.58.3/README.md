# A minimized card's identity line — 0.58.3

The reader's report: in a minimized (collapsed) session row the thread name is right-justified on the cwd line, so
it runs into the row's buttons and the tail of the name is unreadable.

It was. The name was the last flex item in the head, after `<span class="spacer">`, so the spacer pushed it to the
card's right edge — hard against the card's own buttons — and `.thread-name`'s fixed `max-width: 320px` cut the tail
off there. At 1954px the name ended 8px before `📌` and read `a deliberately long thread name that has to tru…`; at
1280px with the rail open the head wrapped, and the name slid to a line of its own under the buttons, so even the
320px cap did not keep the reading order.

## What changed

The collapsed card's cwd line is now the row's identity line, and it reads left to right: `cwd`, the path, the
session's name, then the card's buttons (`📌 🧠 🌊 ✎ ⤢ ✕`) — one nowrap flex row.

- The name is the only item that gives up width: `flex: 1 1 auto` with a 30% floor, `text-overflow: ellipsis`, and
  the whole name plus the thread id in its `title`. It grows into the room a wide card has (no 320px cap) and
  truncates at the end when the card is narrow.
- The path keeps a 96px floor, so it is never squeezed to nothing, and the buttons are `flex: none`, so no hit area
  shrinks.
- The name and the buttons are built once (`threadNameHtml` / `cardActionsHtml`) and stay in the head on an expanded
  card — and on a collapsed card with no cwd line, which has nowhere else to put them.

## The snapshots

All four are Chromium screenshots of `tools/verify-collapsed-row.mjs`'s own sandbox panel (its own port, config, job
store and `HERMES_HOME`, a dead `apiServer`), with an 83-character session name on the card.

| file | what it shows |
| --- | --- |
| `1954-before.png` | 1954px, before: the name right-justified at the card's edge, cut at 320px, immediately before the buttons |
| `1954-after.png` | 1954px, after: `cwd …/task-9-in-a-minimized-co-some-long-worktree-name` then the whole name, then the buttons |
| `1280-rail-open-before.png` | 1280px, rail open, before: the head wrapped and the name sits on a line of its own under the buttons |
| `1280-rail-open-after.png` | 1280px, rail open, after: path 225px, name 248px of 581px of text with an ellipsis, buttons clear of it |

## What proves it

`node tools/verify-collapsed-row.mjs --shots <dir>` → **11 checks, 0 failed** (`COLLAPSED-ROW-OK`). Every number is
read from the DOM at that moment: the cwd line's child order, the name's right edge against the first button's left
edge, the name's height and `scrollWidth`/`clientWidth`, the path's width, a rect-intersection test against every
button, and `elementFromPoint` at each button's centre.

- 1954px: name 1099px, ends 8px before `btn-pin`, one line (17px), not truncated; path 528px of 528px.
- 1280px, rail open: name 248px of 581px of text (ellipsized), ends 8px before `btn-pin`; path 225px.
- Every button 17-18px tall and the topmost element at its own centre, at both widths.
- A collapsed card with no cwd line keeps the name and all 8 buttons in its head; expanding puts them back there.
- The same gate run against the pre-fix tree (`git archive HEAD`) fails 4 of 11: the name is still in the head, still
  capped at 320px.
- `npm test`: 830 tests, 830 pass, 0 fail.
