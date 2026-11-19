# Landing: the initiative folds, the title card and the queued chip (1.120.0)

PR #792 merged into `main` as `079fdde8`. The Initiatives tab is now something a reader can open one card at a
time: every initiative arrives as a **title card** - its title, the first two lines of its description and its
counts - and a press on the title unfolds the rest. The description folds on its own header, so reading the card
does not mean losing the text inside it, and the per-assistant strip counts **queued** work first, because a task
that has been filed and not started is the state before running.

## What landed

- `public/core/initiative-fold.js` - the tab's three small rules as pure functions with a test beside them, loaded
  as a classic script before `assistant.js` and published on `globalThis` as `wtInitiativeFold`:
  - **what a press inside an initiative card means**. The description's header answers first and folds only the
    description. The title card is itself a button, so it is answered next, before the generic rule - otherwise the
    head would swallow every press on the title and the card would never fold. Then anything that acts on itself: a
    project fold, a worktree link, an assistant's name, an `input`, an element marked `data-init-act`. Then the card's
    own dead space, which unfolds a folded card and does nothing on an open one - folding an initiative out from
    under a reader who was reading it is worse than a press that does nothing.
  - **where a folded description stops**. The offset is measured from the element (a `Range` over its own text node,
    so the break follows the rail's width, zoom and font); the cut is backed up to the whitespace before the partial
    word, a cut already on a word boundary keeps the whole word, and a description that fits its two lines comes back
    whole with no dots. Paragraph breaks are never flattened, and the three dots sit after the text they end.
  - **the four per-assistant chips**. `queued`, `running`, `completed`, `parked`, in that order, all four drawn
    always, zeros dimmed in the panel's existing tones - no fourth colour for the state before running.
- `public/assistant.js` - the pane paints every card through those rules, and keeps two books per initiative while
  the tab is open (`initOpen`, `initDescClosed`), so the card and its description fold separately and reopening a
  card remembers its description's fold. A width observer re-cuts a standing preview from the text the pass
  remembers; a repaint always rebuilds a folded body from the store, so no restore machinery exists.
- `public/index.html`, `public/style.css` - the module's `<script>` before `assistant.js`; the title card as one
  button with its own chevron and `aria-expanded`, the description's header as the panel's project-fold row, and
  the dots in the quiet grey the panel already uses for "there is more". No new colours.
- `routes/initiatives.js` - `counts` grows `queued`, counted by the same pass that counts the other three off the
  same queue read, so the strip's first chip cannot come from a second read that disagrees with the rest of it.
- `test/initiative-fold.test.js` (19 cases), `test/initiatives-route.test.js` (a queued task seeded and all four
  counts asserted), and `tools/verify-initiatives-tab.mjs` - the live gate grows the title card, the description
  fold, the keyboard toggles and the strip, and waits for the row's flash and the chart's chip instead of sampling
  a fixed tick.

## What proves it

- `node --test test/initiative-fold.test.js test/initiatives-route.test.js` - 28 tests, 28 pass, 0 fail.
- `npm run verify:initiatives-tab` - **86/86 checks passed**, 0 fail, 0 page errors, 0 console errors, 17 screenshots
  at 1440x900. The gate walks the folds end to end: a new card arrives as its title card (`aria-expanded=false`, no
  body, no description header), one press on the title unfolds it with the store's description whole, the
  description's header folds it back to two lines while the card stays open, Enter unfolds and Space folds again from
  the keyboard, a worktree link opens its row with the card left open, a short description is drawn whole with no
  dots while the long one beside it still ends on `...`, and the strip reads `1 queued, 1 running, 2 completed,
  1 parked` for one assistant and `0 queued, 0 running, 1 completed, 0 parked` for the next, zeros drawn and dimmed.
- `npm test` - 3152 tests, 3140 pass, 12 fail. The twelve are the reds `main` already carries, and they were proven
  so rather than assumed: a `git archive origin/main` export answered **67 tests / 55 pass / the same 12 failures**
  across `assistant-profile`, `child-route`, `gateway-permissions`, `header-controls`, `paths`, `paths-http`,
  `reasoning-runs`, four in `reply-actions-container` and `scan-roots`. The branch's own 28 tests pass in the full
  run.
- `npm run changelog:check` - current, 635 releases.
- `node tools/verify-version-tags.mjs --ref origin/main` - 635 version bumps, 630 tagged and annotated at the commit
  that first declared them, 28 tags held on branches (`v1.120.0` is not one of them), and the same 7 findings among
  older releases that `main` already carried. The gate still reads FAIL on those seven; this landing is not their
  cause and did not touch them.

## The landing

The branch was cut from `1dcbb646` (the 1.119.0 landing note), which was `origin/main` at the time, and carried five
commits over it, tip `7102cdcc`. It had been pushed but never landed: no pull request existed, and the `v1.120.0`
tag that had been pushed peeled to `ff349051` - a branch commit a rebase merge never puts on `main`.

`gh pr create --fill` opened **PR #792** against `main` with those five commits and `mergeable: MERGEABLE`, and
`npm run land:pr` (`gh pr merge 792 --rebase --admin`) re-created them on `main`:

| branch | on `main` | commit |
| --- | --- | --- |
| `707a6f0c` | `b9ba1c97` | Fold the initiative description and the title card, and count queued |
| `8ca1d97d` | `14dfa1d5` | Wait for the row's flash and the chart's chip instead of sampling a fixed tick |
| `c456131d` | `c6dc9469` | Give a title card no description header: there is nothing inside it to fold |
| `ff349051` | `dc3ffcd7` | chore: 1.120.0 - the version this landing carries |
| `7102cdcc` | `079fdde8` | Pin the press rule's real precedence: a control in a folded card still acts on itself |

`079fdde8` is the PR's `mergeCommit.oid`. The release anchor is `dc3ffcd7`, the re-created bump commit: a rebase
merge re-creates the branch's commits, and the rule in `docs/versioning.md` anchors `v<version>` at the commit that
FIRST DECLARED the number, not at the tip that followed it. `tools/release-tag.mjs` moved the published tag and read
it back: `moved ff34905154 -> dc3ffcd7d6 on origin (--force)`, and `refs/tags/v1.120.0^{}` peels to
`dc3ffcd7d6bb23b7f79ec656b6f52a3051c6c8fa` - a commit `main` carries. `verify-version-tags` agrees and does not list
1.120.0 among its findings.

## The render, and this note's push

The landing was one command because the primary checkout could be made landable: `npm run land:pr` refuses a
checkout carrying tracked changes, and this one carried two edits that are not this landing's (`lib/assistant.js`,
`test/element-assist.test.js`, another worker's element-assist shorthand). They were stashed as `stash@{0}` before
the command and restored after this note, so the landing's own steps ran in the order they are designed to run: the
merge, the fast-forward, the tag move, the render.

`tools/land.mjs` committed the render as `5ef14309` - `docs: render the changelog - 635 releases`, `CHANGELOG.md`
alone - and pushed `main` with `--no-verify`, the documented exception: a render touches only `CHANGELOG.md` and
spends no version. `npm run changelog:check` reads current at 635 releases at the tip.

This note is the same shape: a docs commit on `main` that spends no version, so the pre-push version gate would
refuse it, and its push is `git push origin main --no-verify` for that reason. It sits one commit above the render.
