# gui-improve baseline - the Board's Unattached agents section

Stage 1 of `gui-improve` (visit 1). This is the before state: no file under `public/`, `lib/` or `server.js` was
edited to make it. The only writes are this directory and a throwaway sandbox outside the tree.

## Round and tree

| item | value |
|---|---|
| branch | `wtgui/run-gui-improve-again-this-time-on-the-5ab4e1` |
| base | `99f2bd777a2a24d1aedd903e9c4b24a4d9520c36` = `origin/main` at capture time |
| commits from other rounds | none |
| this stage's commit | one commit on `99f2bd7`, carrying only this directory |

The tree was **not** clean when this stage started: the branch carried `44b4278`, a Settings -> Board baseline cut
at `f0b80c7`, left by an earlier round. That commit was preserved under the ref
`preserve/gui-improve-settings-board-baseline-44b4278` and removed from the branch with a reset to `origin/main`
(`99f2bd7`), so the code these shots were taken of is `origin/main` alone. The check the last round's failure asks
for is a command, not a claim:

```bash
cd "$(git rev-parse --show-toplevel)" && git log --oneline origin/main..HEAD && git rev-parse HEAD
```

That prints this stage's one commit above `99f2bd7`, nothing else. `git rev-parse HEAD` is the commit that carries
this directory.

## The surface

The board's `Unattached agents` section: `#agents` (its `.project-head` bar plus `#jobs` with every card). This is
the main board, not the Settings window. The section sits under the New agent card and above `#projects`.

The target recorded for the implement stage: **an unattached card must say where its directory actually is (the
project and the tree, in visible text), and its attach action must offer the tree that directory belongs to.**
Today a card whose cwd is a worktree the board has not read says `no worktree` in its head, puts the directory
only on a 10.5 px path tail (full path in the title attribute), and its picker selects a disabled placeholder that
names the tree by its last path segment while the Attach press is disabled. The picker never lists the card's own
tree.

## The fixture, and why it exists

The unattached section only exists when a card has no owner that resolves to a row, so the state has to be built.
`capture.mjs` boots its own sandbox of this tree and builds a small git fixture:

| fixture path | role |
|---|---|
| `<sandbox>/fixture/alpha` | scanned project; owns the worktree `.worktrees/feat-one` |
| `<sandbox>/fixture/gamma` | scanned project, no worktree |
| `<sandbox>/fixture/outside/beta` | NOT under the scan root; owns the worktree `.worktrees/feat-long-tree-name` |

The board reads three rows from it: `alpha` main, `alpha` `feat-one`, `gamma` main. Two cards are seeded in the
sandbox's job store, both with no owner path:

| card | cwd | what it is |
|---|---|---|
| `fixture-tree-worker` | `.../outside/beta/.worktrees/feat-long-tree-name` | a worker whose cwd is a worktree the board has no row for. Tonight's shape. |
| `fixture-row-worker` | `.../alpha/.worktrees/feat-one` | a worker whose cwd is a worktree the board HAS read, left unattached by its owner. The contrast. |

The first card is the one the `expanded` state presses, because it is the one that opens the picker instead of
attaching straight away. The second card is there so the section holds both shapes and the head's wording can be
compared across them.

Paths under the sandbox are written `<sandbox>/...` in the manifest and the inventories. The sandbox is the
throwaway folder the script rebuilds (`$WAG_SCRATCH/wag-unattached-baseline`), and a committed record should not
carry a drive letter a reader cannot open. Only the prefix of a path string is rewritten; every box, font size and
option wording beside it is the page's own.

## Protocol

Headless Playwright Chromium, device scale factor 1, a fresh browser context (no localStorage, so the section is
open and every card is unfolded). One viewport: **1440 x 900**. Three states:

| state | steps |
|---|---|
| `open` | fresh context at 1440x900; goto the panel; wait for `#agents` and for `#jobs` to hold two `.job[data-thread]` cards; wait for two consecutive reads of the card set to agree and then 2.5 s for the first socket snapshot; assert the section is not `.fixed-collapsed`, `#jobs` is painted, no `.attach-row` is visible, and both cards draw a `.job-cwd` line; two animation frames and 300 ms. |
| `expanded` | reach `open`; click `[data-attach-toggle="fixture-tree-worker"]`; re-press if a repaint replaced the card; wait for that card's `.attach-row` to lose `[hidden]` and its select to hold options; assert the row is painted; two animation frames and 300 ms. |
| `collapsed` | reach `expanded`; click `.project-head[data-toggle-fixed="agents"]` (the bar, not one of its buttons); wait for `#agents.fixed-collapsed` and for `#jobs` to report `display: none` with no painted box; assert the bar is still painted; two animation frames and 300 ms. |

Every state is asserted before its shot; the run fails rather than recording an empty section. The full steps are
also written into `capture.json` per state.

The section is rebuilt wholesale by the board, so the script waits for two consecutive reads of the card set to
agree before the first press, and re-presses the attach toggle when a repaint throws the row away. A capture that
lost the row three times fails instead of writing a shot of a closed picker.

## Files

| file | what it is |
|---|---|
| `capture.json` | the manifest: this round and its base, the fixture, the environment, the three states with their steps, every shot's path/sha256/pixels, the measurements, the target's numbers, the inventories, `incomplete: []` |
| `dom.json` | DOM inventory per state: every painted element in `#agents` with tag, id/class, role, accessible name, text, box, font size, hidden/disabled/value; plus each card's head, meta text, cwd line (text, title, box, client vs scroll width, truncation), attach toggle and attach row (hidden, selected option, every option, Attach's disabled state); plus section geometry and overflow |
| `css.json` | CSS inventory: the three stylesheets and all 2,132 style rules, the at-rules, the `:root` custom properties, and for every painted element its 75 computed properties, matched-rule indices and `::before`/`::after` styles |
| `style.css` | the served `public/style.css` this baseline was measured against (byte-identical to `public/style.css`, sha256 `02523ef4...`) |
| `shots/1440x900-<state>.png` | full-page shot of the whole board |
| `shots/1440x900-<state>-surface.png` | the `#agents` section alone: the stable pair to diff |
| `capture.mjs` | the capture script; boots its own sandbox and fixture, rerunnable from any checkout of this build |

`pipeline-bundle.json`, `verdict.json` and `shots/*-pipeline*.png` in this directory are an earlier round's
(pipeline window baseline, committed at `6479816`). This round replaces only `capture.json`, because the pipeline
fixes that path as its baseline artifact. Those three sets are not this stage's measurements.

## Environment

| item | value |
|---|---|
| panel | this tree, version 1.76.1, build `5627cfbe3d6c` |
| server | `http://127.0.0.1:50375/` (this run's free port), a throwaway instance of this tree |
| sandbox store | the two seeded cards, asserted in `#jobs` before every shot; the reader's own panel was not touched |
| served `public/app.js` | sha256 `0dc40e49...`, byte-identical to this tree |
| served `public/style.css` | sha256 `02523ef4...`, byte-identical to this tree |
| served `public/index.html` | differs from the tree only by the panel's cache-busting stamp (`?v=5627cfbe3d6c`, `<meta name="panel-build">`) |

`matchesTree: true` on `app.js` and `style.css` is the proof the shots are of this tree's bytes.

## What the baseline measures (1440x900, `open`)

| metric | value |
|---|---|
| section | 1408 x 580.34 at x 16, y 319.69 (bottom 900.03, the viewport's bottom edge) |
| head bar | 1406 x 47; label `Unattached agents` at 14 px; hint at 12 px, 686.16 wide |
| `#jobs` | 1406 x 531.34, scrollHeight 531 |
| cards | 2, `complete` pill each |
| painted elements in the section | 85 |
| smallest painted font | 10 px |
| stylesheet rules | 2,132 style rules flattened from 3 sheets (top-level blocks per sheet: 1,894 / 177 / 51) |

### The tree card, as numbers

| part | value |
|---|---|
| card | 1406 x 266.17; head 1378 x 27.75 |
| head meta | `no worktree · (default model)` at 12 px, 191.34 wide |
| cwd line | 1352 x 17.39, 10.5 px, one line (`white-space: nowrap`, `overflow: hidden`) |
| cwd path text | `.../beta/.worktrees/feat-long-tree-name`, 244.13 wide, **not** truncated (client 244 = scroll 244) |
| cwd path font | 12 px (the line's own box is 10.5 px) |
| full path | only in the line's `title`: `working directory: <sandbox>/fixture/outside/beta/.worktrees/feat-long-tree-name` |
| row chip | none (`row ...` is drawn only when the cwd and the owner differ) |
| attach button | 66.08 x 20.3 at x 1213.33, `11 px` |
| head meta on the contrast card | the same `no worktree · (default model)`, though its cwd is a tree the board HAS read |

The section head's own hint says these agents have no worktree of their own, which is the same claim the meta
makes card by card.

### The attach action, as numbers (`expanded`)

| part | value |
|---|---|
| attach row | 1360 x 24 at x 49, y 398.83; the open row adds 29 px to the section (580.34 -> 609.34) |
| select | 325 x 24, `11.5 px` |
| options | 4: `alpha · alpha (main)`, `alpha · feat-one (feat-one)`, `gamma · gamma (main)`, and the disabled placeholder |
| selected | index 3, the placeholder `the row for feat-long-tree-name is missing` (value `""`) |
| card's own tree offered | **no**: no option's value names `feat-long-tree-name` |
| Attach press | 49.45 x 21, **disabled** |
| message behind it | `the row for <sandbox>/fixture/outside/beta/.worktrees/feat-long-tree-name is missing ... press attach on the row once it appears, or reload the board` |

The placeholder carries only the last path segment (`feat-long-tree-name`), not the project (`beta`), and the
sentence behind it tells the reader to press attach on a row that does not exist and will not appear while `beta`
is outside every scan root.

### Collapsed, as numbers

| part | value |
|---|---|
| section | 1408 x 48 (the head bar alone), at y 347.69 |
| `#jobs` | `display: none`, no painted box, 2 children still in the DOM |
| painted elements | 10 |
| bar still says | `Unattached agents`, hint, `2 unattached`, `Minimize all`, `Clear finished` |

The two cards keep their state: collapsing hides `#jobs`; it does not rebuild the section.

## What the next stage works against

1. The head's meta line and the section hint describe the card as having no worktree while its cwd is one. The
   visible tree fact is a 10.5 px dim tail whose full path lives only in the `title` attribute.
2. The picker lists three rows of other trees and one disabled placeholder; the card's own tree is not among its
   options, and the Attach press is disabled. The only instruction it gives is to press attach on a row that the
   board will not draw.
3. A fix should move the two numbers that carry the reader's answer: a visible statement of the project and tree on
   the card (not only the path tail and the title), and a picker option that is the card's own tree, or a sentence
   that says what would make one and where.

`capture.json` carries the same list under `target`, with the numbers beside each claim.

## Reproducing

```bash
cd "$(git rev-parse --show-toplevel)" && PLAYWRIGHT_BROWSERS_PATH="$LOCALAPPDATA/ms-playwright" NODE_PATH="$APPDATA/npm/node_modules" WAG_SCRATCH="$TEMP" node ledger/gui-improve/baseline/capture.mjs
```

The script rebuilds `<WAG_SCRATCH>/wag-unattached-baseline`, boots the panel from the checkout it sits in (no
`PANEL_BASE`), and stops the listener before it exits. `PANEL_BASE=http://127.0.0.1:<port>/` shoots an instance
that is already running instead; the manifest's `matchesTree` then says whether that instance is this tree.

The surface pair (`shots/1440x900-<state>-surface.png`) depends only on the fixture and the public files, so it
repeats across runs of the same build: the three surface sha256 values here were identical across the runs this
stage was measured with. The
full-page shots are of a live board and changed height between those runs (1383 and 1418 px tall at `open`); diff
the surface pair, or crop the full-page shot at the recorded section rect.
