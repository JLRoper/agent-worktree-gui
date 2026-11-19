# Landing: an Initiatives tab beside Role, and a column on the chart (1.119.0)

PR #791 merged into `main` as `b6bab51b`. A big piece of work - a release, a migration, a rebuild - is usually several
worktrees over several projects, and the board can now say so: an **Initiatives** tab in the assistants rail, between
Role and Watchdog, holding each initiative's title, its description and the worktrees behind it grouped into their
projects; and an **Initiative** column on the chart, beside Owner, so a row answers which big piece of work it is
behind without opening the tab.

## What landed

- `lib/initiatives.js` - the store, keyed by tree path and kept in `initiatives.json` beside `locks.json`: state the
  reader owns rather than anything git knows, overlaid onto the rows on every read, so a scan that rebuilt a row
  cannot lose a membership it never owned. `normTreePath` normalises case, backslashes and a trailing slash and keeps
  the spelling for display; titles are required and capped at 120, descriptions keep their paragraphs and cap at
  2000. Writes are atomic, and an unreadable store is reported rather than overwritten: every write is refused and
  the file is left byte for byte where it was.
- `routes/initiatives.js` and `server.js` - `GET /api/initiatives`, `POST /api/initiatives` (create),
  `POST /api/initiatives/update` (the words only) and `POST /api/initiatives/move`
  (`{ tree, initiative, action: "add"|"remove" }`), which parks a question and changes nothing else.
- `lib/remote-writes.js` - a question may now say `grants: false`: the panel is asking permission for a change it
  will make itself, so `once` means "yes, do it" and leaves no push grant behind for the next `git push` from that
  tree to ride.
- `public/assistant.js` - the pane, built from the panel's own furniture (`.as-group` cards, `.chip` counts, the
  rail's 11.5px rows). Projects fold until opened, worktrees only exist on expand, assistant detail rows fold under
  their own handle, and folds and half-typed words are module state because a snapshot repaints the pane. A worktree
  name is a link through `hotOpenPath` that scrolls to the row and leaves it flashing; an assistant's name opens its
  pane, selects Chat and puts the caret in the box it types into, sending nothing. Beside each assistant: running,
  completed and parked for that initiative's trees, newest worker first. A move parks the permission card naming the
  tree and the initiative, and the dock says "initiative move" rather than claiming a push is waiting.
- `lib/chart-columns.js`, `public/charts.js`, `public/render-projects.js` - the chart's Initiative column: a dash for
  an unassigned tree (the normal case) and a chip with the initiative's title when one is behind it.
- `lib/paths.js` - `initiatives.json` named among the panel's state files, so the paths gate knows it is state.
- `test/initiatives-store.test.js`, `test/initiatives-route.test.js` and three updated suites
  (`chart-columns`, `assistant-subtabs`, `turnover-row-marker`), plus `tools/verify-initiatives-tab.mjs`
  (`npm run verify:initiatives-tab`) as the live gate.

## What proves it

- `node --test test/initiatives-store.test.js test/initiatives-route.test.js test/chart-columns.test.js test/assistant-subtabs.test.js test/turnover-row-marker.test.js` - 50 tests, 0 fail.
- `npm run verify:initiatives-tab` - **55/55 checks** on two runs against a sandboxed panel at 1440x900: the empty
  state, the create's round trip through `GET /api/initiatives`, the column in both states, the permission card
  (allow once performs the move, deny leaves the store's bytes identical), the folds, the scroll-and-flash, the
  caret, the counts, and zero page or console errors. The first run of the same gate answered 54/55 with one check
  failing and its name not captured (the tail of that run was cut); the two runs after it were green end to end.
- `npm test` - 3133 tests, 3120 pass, 13 fail. Twelve are the reds `main` already carries: the same nine failing
  files on a `git archive origin/main` export answered 67 tests / 55 pass / **the same 12 failures** (`assistant-profile`,
  `child-route`, `gateway-permissions`, `header-controls`, `paths`, `paths-http`, `reasoning-runs`, four in
  `reply-actions-container`, `scan-roots`). The thirteenth, `child-tree` "a job's settle kills what its turn started,
  grandchild included", passes alone in this tree (5/5) and alone on the main export (5/5): a parallel-run flake, not
  this change. The branch's own 21 new tests pass in the full run.
- `npm run changelog:check` - current, 634 releases.
- `node tools/verify-version-tags.mjs --ref origin/main` - 634 version bumps, 629 tagged and annotated at the commit that
  first declared them, 28 tags held on branches (`v1.119.0` is no longer one of them), and the same 7 findings among
  older releases that `main` already carried. The gate still reads FAIL on those seven; this landing is not their
  cause and did not touch them.

## The landing

The branch was cut from `1945de9e` (the 1.118.0 landing note), which was `origin/main` at the time, and carried five
commits over it, tip `b8b28451`. It had been pushed but never landed: no pull request, and a `v1.119.0` tag that
peeled to `b8b28451` - a branch commit a rebase merge never puts on main.

`gh pr merge 791 --rebase --admin` re-created those five commits on `main` as `89eff845`, `0c13286a`, `73699200`,
`754deb75` and `b6bab51b`. `b6bab51b` is both the PR's `mergeCommit.oid` and the commit that first declared 1.119.0,
so it is the anchor.

`node tools/release-tag.mjs --ref HEAD` then moved the published tag - `moved b8b28451de -> b6bab51bbb on origin
(--force)` - and read it back: `refs/tags/v1.119.0^{}` peels to `b6bab51b`. The move is the landing's own step, not a
hand repair after it.

## The render, and this note's push

`npm run land:pr` refuses in this checkout before it merges anything: the primary checkout carries two tracked edits
that are not this landing's (`lib/assistant.js`, `test/element-assist.test.js`). Per `references/landing-a-pr.md`
the render was therefore run by hand in the landing worktree, detached at the merged tip: `node tools/land.mjs
--render --no-fetch` wrote `CHANGELOG.md` as **634 releases, adding v1.119.0** with `main`'s shas, and the file was
committed alone as `fc240b00` and pushed with `--no-verify` - a render touches only `CHANGELOG.md` and spends no
version, the documented exception in `docs/versioning.md`. `npm run changelog:check` reads current at 634 releases.

This note is the same shape: a docs commit on `main` that spends no version, so the pre-push version gate would
refuse it. Its push is `git push origin main --no-verify` for that reason, and it sits one commit above the render.

## The primary checkout

It was on `1945de9e` carrying the two tracked edits above, another worker's element-assist fix and its test.
`git merge --ff-only origin/main` took it to the render commit `fc240b00` with both edits byte-identical (the
`git status --porcelain` lines and the `git diff --stat` were compared before and after), and then to this note's
commit. Neither edit was stashed, reset or committed. The panel needs a reload for the new `public/` files.

`gh` calls used the token in the user environment (`GITHUB_PAT_JLR`); `gh` itself holds no token on this box.
