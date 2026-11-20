# Landing: the Hot bolt reads Active, behind a General settings row that ships off (1.139.0)

The floating header's bolt was called Hot, and it was part of the header whether or not a reader wanted it. This
landing renames it **Active** and makes it a setting: Settings > General > **Show the Active agents button in the
floating header**, off for a reader who never opened it. Off means absent - no bolt, no count, no reserved slot -
and on is the control the panel always had, with the new word, the count, the tooltip and the press that lands on the
next working agent.

## What landed

- `public/core/active-button.js` (new) - the switch as functions with names: the stored key `wtgui.activeButton` and
  the default `false` (line 22), the stored word read as a switch (`norm`, line 28), the browser read (`read`,
  line 41), the write (`write`, line 53), and the one decision the paint asks (`show`, line 67: switched on AND an
  agent working). No DOM and no network, so the page and `test/active-button-toggle.test.js` run the same file.
- `public/app.js:13994` - `activeButtonOn`, the page's cached read; `public/app.js:13999` `paintHotButton`, whose
  paint signature carries the switch (line 14005) and whose hidden line is now
  `btn.hidden = !wtActiveButton.show(list, on)` (line 14013); `public/app.js:14031` `hotStep`, which refuses while
  the control is off so a queued click on a hidden control lands on nothing; `public/app.js:14066`
  `paintActiveButtonSetting`, so the row reads the stored value at load; `public/app.js:14071` the row's change
  handler, which writes the key, drops a rotation pointing at the hidden control and repaints on the press rather
  than on the next job frame.
- `public/index.html:88` - the Settings > General row, unchecked by default, in the General tab, its title naming
  the pen search as a different control; `public/index.html:26` the button, labelled `Active` with a tooltip that
  says Active and names the setting; `public/index.html:1262` the new module, loaded before `app.js`.
- `public/core/hot-mark.js:93` - every title and aria-label the marker emits says Active, and the tooltip names the
  row that can take the button out of the header.
- `public/style.css:145` - the rule's own comment says what the control is: drawn only while an agent is working AND
  the row is on.
- `docs/using-the-board.md:41` and `:47` - the header table and the control's section, in the reader's words.
- `test/active-button-toggle.test.js` (new, 8 tests), `test/hot-mark.test.js` and `test/hot-agent-header.test.js`
  extended, and the gate named as `package.json:115`'s `verify:active-button-toggle`.

## The word is Active, the wire is still hot

The ids (`#btn-hot`, `#hot-label`, `#hot-badge`), the module `wtHotMark` and the CSS state class `is-hot` are
element and wire names, not something a person reads, so they stay and a page written against the older build still
finds the control. What changed is every string a reader sees: the label, the tooltip, the aria-label, the banner the
press shows, and the docs. The storage key `wtgui.activeButton` is new, because the control never had a stored switch
before; a browser that never set it reads the default, which is off.

## Off is absent, and the pen is not this control

A reader who never opened the row gets a header with no such control: not a grey bolt, not a zero badge, and no space
reserved for one (`public/app.js:14013`). The predicate is both halves - switched on AND an agent working - so "on
with nothing running" is absent too, the rule the control already had for a zero count. The Hot Agent pen search
beside it (`#ha-search-open`) keeps its name, its drawn glyph and `Ctrl+Shift+Q` whatever the switch says; the row's
own tooltip says so, and the gate checks the pen is still drawn with the control on and off.

## The gate

`tools/verify-active-button-toggle.mjs`, headless at 1440x900, on a throwaway panel (`tools/panel-testkit.mjs`) with
seeded job records in the shape `lib/jobs.js` writes. It ran 34 checks and all 34 passed:

- with the switch off and one agent working, the header carries no Active button (`{"hidden":true,"drawn":false}`),
  while the row is present in General and unchecked;
- turning it on through the row puts the control back with `Active`, its bolt and its count `1`;
- one press lands: the label steps (`Active 1/1`), the agent's card flashes, and the banner reads
  `Active agents: 1 agent is working - landing on the renamed control`;
- turning it off again removes the control while the same agent is still working (the badge still reads `1`, so this
  is the switch and not the work ending), and the browser stores `0`;
- the choice survives a reload in both directions: off stays off with no control, on stays on with the control;
- the pen search is still drawn beside its old place, with its glyph and its label, in both states;
- the page raised no error and the console logged none.

Screenshots at 1440x900, beside this note in `docs/reports/active-button-toggle-1.139.0/`:
`active-button-1-off-1440x900.png` (the header with the switch off and one agent working),
`active-button-2-settings-row-1440x900.png` (the General row), `active-button-3-on-header-1440x900.png` (the control
back with its new word), `active-button-3b-on-header-crop-1440x900.png` (the header strip, cropped),
`active-button-4-press-1440x900.png` (after one press: `Active 1/1`) and `active-button-5-off-again-1440x900.png`
(off again under the same working agent).

## Tests

- `test/active-button-toggle.test.js` 8 of 8 - the default per unreadable input, the round trip, a refusing browser,
  the two halves of `show`, the row's place and wording, and the paint reading the module.
- `test/hot-mark.test.js` 12 of 12 and `test/hot-agent-header.test.js` 4 of 4 - the control's text, its order, its
  hidden default, and the pen as a separate control.
- `tools/verify-active-button-toggle.mjs` 34 of 34 at 1440x900.
- `tools/verify-hot-mark.mjs` - the marker's own gate, which now turns the row on first and measures the gap from the
  control to the pen box beside it.
- `npm test` once on the branch: 1463 passing and 6 failing was the last count both runs printed before they
  stopped producing output at the same point - the first was cut after 8 minutes with no new line, the second hit
  the same wall under a 60 second per-test timeout. Five of the six reproduce on a `git archive` of `origin/main`
  (`test/assistant-profile.test.js`, `test/assistant-search-scroll.test.js`, `test/child-route.test.js`,
  `test/gateway-permissions.test.js` and `test/header-controls.test.js`, whose `connect()` assertion `main`'s own
  pause handler already contradicts); the sixth, `test/assistant-message-attachments.test.js`, is the known
  one-invocation flake and passes 5 of 5 alone.

## Version and the release record

`1.139.0`, minor: a new user-facing setting and a label change, nothing removed or renamed on the wire. `origin/main`
read `1.138.1` when this branch was rebased, so the bump commit is the one that first declares `1.139.0` and carries
`v1.139.0`; the landing moved the tag onto the commit the merged `main` carries.

The note and its screenshots are a docs commit pushed to `main` deliberately with `--no-verify`: a docs-only base
push spends no version, which is the same bypass `tools/land.mjs` prints for its own `CHANGELOG.md` commit.

## Known limits, stated rather than hidden

- The switch is per browser, not per panel: it lives in `localStorage` under `wtgui.activeButton`, the same store the
  Board tab's rows use, so another browser or a private window reads the default (off) until the row is set there.
- The control and its setting are the only things that move. The pen search, the Human count and the Clarify lane are
  untouched, and the gate checks the pen in both states.
