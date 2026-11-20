# Landing: the Initiatives pane scrolls inside the float (1.136.0)

The reader's report, fixed in one rule with a browser gate behind it: on the assistant float's Initiatives tab an expanded
list of initiatives ran past the bottom of the window with no scroll bar, so the cards below the fold could not be
reached. The cause was in the sheet, not the painter. Three other panel-level tabs (Role, Watchdog, Bridge) hung below
the float the same way; one rule fixes all four and leaves the session panes alone.

## What landed

- `public/style.css:4448` - one rule, and the padding rule above it is untouched:

      .as-pane:not([data-pane^="assistant-"]) { flex: 1; min-height: 0; overflow-y: auto; }

  `flex: 1` and `min-height: 0` size a panel-level pane to the float's body instead of to its content, and
  `overflow-y: auto` gives it a scroll bar only while something is below the fold. The session pane
  (`[data-pane^="assistant-"]`) is excluded on purpose: it is a pass-through box whose inner Chat/Settings/Queue
  sub-panes own their scrollers, and a second one around the pinned composer is how the reply box gets scrolled away.
- `tools/verify-initiatives-scroll.mjs` - the live gate. It boots a panel of its own, seeds twelve initiatives through
  `POST /api/initiatives`, opens the float on Initiatives, expands every card and every description, then measures the
  pane at 1440x900.
- `package.json` - the `verify:initiatives-scroll` script, which is what the `// HARNESS: LIVE GATE` header is held to
  by `test/harness.test.js`.

## The cause, measured

The float's body is a clipping flex column while a session's Chat sub-pane exists
(`.as-body:has(.as-subpane[data-subpane="chat"]:not(.hidden))`, `public/style.css:5064`), and the only rule that makes
a pane a pass-through box is scoped to the session panes
(`.as-pane[data-pane^="assistant-"]:not(.hidden)`, `public/style.css:5067`). The Initiatives pane is
`data-pane="initiatives"` (`public/index.html:1149`) and `.as-pane` carried padding and nothing else
(`public/style.css:4438`), so the pane grew to its content - 6093px of expanded cards - and the part past the body's
727px was painted nowhere: no wheel, no bar, no way down.

Before, on `603e8391`, measured by the gate's own probes:

    pane:  6093px client, 6093px content, overflow-y visible, bottom 1294 vs body 900
    wheel over the pane: pane scrollTop 0, the document scrolled 159 instead
    role:      878px client,  878px content, bottom 1051 vs body 900
    watchdog: 1800px client, 1800px content, bottom 1972 vs body 900
    bridge:   1574px client, 1574px content, bottom 1747 vs body 900

After:

    pane:  727px client, 6093px content, overflow-y auto, bottom 900 vs body 900
    wheel over the pane: pane scrollTop 5366 of 5366, body scrollTop 0, document scrollTop 0
    role:      727px client,  878px content, bottom 900
    watchdog: 727px client, 1800px content, bottom 900
    bridge:   727px client, 1574px content, bottom 900

## The scope: every panel-level pane, not this one

The rule is general to the panes that belong to the PANEL, and excludes only the session panes. The alternative - a
`[data-pane="initiatives"]` selector - would have fixed the tab the reader named and left the identical defect in Role,
Watchdog and Bridge, which the gate measured hanging 151px, 1072px and 847px below the float. The exclusion is the
narrow half on purpose: the session pane is the one pane whose height is already decided by a three-level chain
(`.as-body` -> session pane -> chat sub-pane -> `.job`), and a scroll container at the top of it would take the pinned
composer out of the scrollport it is pinned to.

A tab whose content fits is unchanged: with two folded initiatives the pane reads `727px client, 727px content,
scrollTop 0` - a scroll container with nothing to scroll draws no bar.

## What proves it

- The gate, against a `git archive` of the base commit (`603e8391`) with only the gate copied in: **18/33 checks
  passed**, the failures naming the pane's `overflow-y: visible`, its box ending at 1294 against a body at 900, the
  wheel moving the document instead of the pane, and the same overflow on Role, Watchdog and Bridge.
- The same gate on this branch: **33/33 checks passed**. The FAIL-to-PASS pair is quoted in the commit body.
- `npm run test:changed` - 40 files, 471 tests, 0 failures, 16.8s (the tests that name `public/style.css`, plus the
  ones whose imports reach it).
- `npm test` - 3302 tests, 3290 pass, **12 fail**, 23.8 minutes on a host carrying several other agents' suites. None
  of the twelve names a pane, a tab or `public/style.css`, and the two re-run against a `git archive` of the base
  (`603e8391`, this change absent) fail identically there: `test/assistant-profile.test.js` 8/9 with the same
  `dock` key the profile payload now carries and its test does not expect, `test/assistant-search-scroll.test.js`
  10/11 with the same keyboard-step assertion. The rest are the host's own timing and scratch paths
  (`child-route` 10s, `scan-roots` 12.8s, `spawn-watch` `ENOTEMPTY` on a Temp folder, `worktree-release` 128s).

## The version

1.136.0, a minor: the branch adds a new gate (`tools/verify-initiatives-scroll.mjs`) that can now fail a landing, which
`docs/versioning.md` files under minor. The fix itself would be a patch; the gate is what spends the minor. `main` was at
`1.133.0` (`603e8391`) and this branch was cut from it. `node tools/version.mjs apply minor` skipped `1.134.0` and
`1.135.0` because both are already anchored by tags on `origin` (sibling branches that have not merged), and took
`1.136.0`; the tag `v1.136.0` is anchored at the bump commit this branch carries.
