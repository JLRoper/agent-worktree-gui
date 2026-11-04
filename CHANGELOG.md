# Changelog

Every released version of the panel, newest first: the commits each release carried over the tag before it,
grouped by what a reader gets from them. Generated from git history — `npm run changelog` rewrites this file and
`npm run changelog:check` fails when it is stale. Do not edit it by hand.

**What changed since the build I am running?** The board's config line names the build (`v1.8.0 · …`).
Pass that version here and read only what came after it:

```
npm run changelog -- --since v0.80.0
```

266 releases from v0.1.0 (2026-10-20) to v1.8.0 (2026-11-04), 941 commits between the tags. Every release is anchored by an
annotated tag at the commit that first declared its version; `npm run verify:version-tags` fails when a bump
has no tag.

## v1.8.0 — 2026-11-04 · 3 commits

`2704ce3` · the 3 commits after v1.7.3

### Added

- feat: picking a role loads its own charter, and the box asks before losing a draft (`9a2793c`)

### Docs & tests

- docs: the picker's three constraints, proved with the sandbox shots (`80f3cf1`)

### Other

- chore: 1.8.0 — the version this landing carries (`2704ce3`)

## v1.7.3 — 2026-11-04 · 2 commits

`90004ad` · the 2 commits after v1.7.2

### Docs & tests

- docs: render the changelog — 264 releases (`896e78d`)

### Other

- chore: 1.7.3 — the version this landing carries (`90004ad`)

## v1.7.2 — 2026-11-04 · 2 commits

`fd39414` · the 2 commits after v1.7.1

### Fixed

- fix: a junctioned node_modules is unlinked before any worktree removal (`a31d45f`)

### Other

- chore: 1.7.2 — the version this landing carries (`fd39414`)

## v1.7.1 — 2026-11-04 · 1 commit

`81ad614` · the 1 commit after v1.7.0

### Docs & tests

- docs: order the split into ten landable stages (#373) (`81ad614`)

## v1.7.0 — 2026-11-04 · 4 commits

`6a3de29` · the 4 commits after v1.6.1

### Added

- feat: the wave button behind a Cards switch, the pencil beside the name (`64860c5`)

### Docs & tests

- docs: render the changelog — 261 releases (`35230cc`)
- docs: render the changelog — 261 releases (`977635a`)

### Other

- chore: 1.7.0 — the version this landing carries (`6a3de29`)

## v1.6.1 — 2026-11-04 · 3 commits

`0507237` · the 3 commits after v1.6.0

### Added

- feat: every deliverable card's Open opens it, and a refusal says why (`bc2203c`)

### Docs & tests

- docs: render the changelog — 260 releases (`f0b52a3`)

### Other

- chore: 1.6.1 — the version this landing carries (`0507237`)

## v1.6.0 — 2026-11-04 · 5 commits

`eec5251` · the 5 commits after v1.5.7

### Added

- feat: the landing renders the changelog as its last step (`4ba98d6`)
- feat: the landing path runs land, and a base push with a stale changelog is refused (`0bc3cf2`)

### Fixed

- fix: the land tool names a sha-only stale file, and its tests pin the case (`edb25b3`)

### Docs & tests

- docs: the landing's render, proven at 250 releases on main's own tip (`cf922f4`)

### Other

- chore: 1.6.0 — the version this landing carries (`eec5251`)

## v1.5.7 — 2026-11-04 · 1 commit

`6be1978` · the 1 commit after v1.5.6

### Fixed

- fix: tag the commit that declared the version, never the ref's tip (#368) (`6be1978`)

## v1.5.6 — 2026-11-04 · 3 commits

`75ec220` · the 3 commits after v1.5.5

### Docs & tests

- docs: render the v1.5.5, v1.5.4 and v1.5.2 sections at this tip (`92d5fcc`)
- docs: one entry point for the three split cuts, and the map reconciled (`16ef146`)

### Other

- chore: 1.5.6 — the version this landing carries (`75ec220`)

## v1.5.5 — 2026-11-04 · 2 commits

`c7188bf` · the 2 commits after v1.5.4

### Docs & tests

- docs: the 1.4.2 usability ledger page, salvaged from PR #360 (`1e8959c`)

### Other

- chore: 1.5.5 — the version this landing carries (`c7188bf`)

## v1.5.4 — 2026-11-04 · 2 commits

`c9b8406` · the 2 commits after v1.5.2

### Docs & tests

- docs: the round's report names the version this landing carries (`8fea13c`)

### Other

- chore: 1.5.4 — the version this landing carries (`c9b8406`)

## v1.5.2 — 2026-11-04 · 4 commits

`7ffd712` · the 4 commits after v1.5.0

### Docs & tests

- docs: render the 1.5.0 section at the rebased tip (`5234a3c`)
- docs: the flow chart against the studio, thirteen stages at three widths (`86cb831`)

### Other

- tools: capture the flow chart and the studio side by side (`48a9030`)
- chore: 1.5.2 — the version this landing carries (`7ffd712`)

## v1.5.0 — 2026-11-04 · 3 commits

`4209390` · the 3 commits after v1.4.2

### Added

- feat: Settings → Updates draws the checkout's own changelog (`4209390`)

### Docs & tests

- docs: render the v1.4.2 and v1.4.1 sections against the commits the rebase merge carried (`0972094`)
- docs: record the #359 landing and what the round's ledger is (`da49821`)

## v1.4.2 — 2026-11-04 · 2 commits

`1e1c595` · the 2 commits after v1.4.1

### Docs & tests

- docs: the pipeline flow, measured as a reader reads it (`4ebc73c`)

### Other

- chore: 1.4.2 — the version this landing carries (`1e1c595`)

## v1.4.1 — 2026-11-04 · 3 commits

`6cd6426` · the 3 commits after v1.4.0

### Docs & tests

- docs: render the v1.4.0 section on main (`e2358c5`)
- docs: the module map that names a lane for every file (`29809a8`)

### Other

- chore: 1.4.1 — the version this landing carries (`6cd6426`)

## v1.4.0 — 2026-11-04 · 5 commits

`db8dc06` · the 5 commits after v1.3.0

### Added

- feat: each assistant owns its alerts, watches, messages and pad (`d8068c0`)

### Docs & tests

- test: pin the count's sentence, the fit control, and the fitted drawing (`5cd412e`)
- test: the thirteen-stage case goes green on the fitted drawing, and the count is judged in both states (`9a521e6`)
- docs: the round's report, with the four shots that decided it (`58ab40a`)

### Other

- chore: 1.4.0 — the version this landing carries (`db8dc06`)

## v1.3.0 — 2026-11-04 · 2 commits

`6ba1e85` · the 2 commits after v1.2.0

### Added

- feat: thirteen stages fit the card, and the scroller says what it hides (`6ba1e85`)

### Docs & tests

- docs: render the v1.2.0 section on main (`1b8b795`)

## v1.2.0 — 2026-11-04 · 6 commits

`a843641` · the 6 commits after v1.1.1

### Added

- feat: every wait on a person goes out over the bridge that is already running (`d4fe71a`)

### Docs & tests

- docs: render the 1.1.1 section on main (`c404950`)
- docs: the round 5B report quotes the suite at the rebased tip (`f00c0e0`)
- docs: the v1.1.0 tag moves onto the commit that declares 1.1.0 (`1a6c0a5`)
- docs: retire the two orphan tags, and prove the gate green (`be17bc6`)

### Other

- chore: 1.2.0 — the version this landing carries (`a843641`)

## v1.1.1 — 2026-11-04 · 6 commits

`5116bd2` · the 6 commits after v1.1.0

### Docs & tests

- docs: render the 1.1.0 section, cut by this landing (`0e16e54`)
- docs: render the 1.1.0 section against the commits the rebase merge carried (`4073d27`)

### Other

- The drawing fills its card, its words clear AA, and nothing hangs past the track (`a83f05c`)
- A press on the flow's backdrop stops at the dialog (`5afc1fe`)
- The visual layer's round report, with the shots that decided it (`4e31f79`)
- chore: 1.1.1 — the version this landing carries (`5116bd2`)

## v1.1.0 — 2026-11-04 · 2 commits

`d5b35eb` · the 2 commits after v1.0.4

### Added

- feat: alerts get an owner — stamped at fire time, resolved from the thread, filed under a tab (`8688a70`)

### Other

- chore: 1.1.0 — the version this landing carries (`d5b35eb`)

## v1.0.4 — 2026-11-04 · 2 commits

`4c0a52b` · the 2 commits after v1.0.3

### Other

- Make the drawing and the driver agree about which edge a stage leaves by (`0ceaa22`)
- chore: 1.0.4 — the version this landing carries (`4c0a52b`)

## v1.0.3 — 2026-11-04 · 4 commits

`5ea54e9` · the 4 commits after v1.0.1

### Changed

- style: the queue's three states read green / amber / red (`53c03ea`)

### Docs & tests

- docs: render the 1.0.1 section, cut by this landing (`0041b45`)
- docs: render the 1.0.1 section against the commits the rebase merge carried (`6566499`)

### Other

- chore: 1.0.3 — the version this landing carries (`5ea54e9`)

## v1.0.1 — 2026-11-04 · 3 commits

`0b0ff0b` · the 3 commits after v1.0.0

### Added

- feat: each assistant owns its rules and its pad, and the message board names whose message is whose (`3c8e36e`)

### Other

- wip: per-assistant split in progress (notes file, pad routing, watch owners) (`5d8e5d5`)
- chore: 1.0.1 — the version this landing carries (`0b0ff0b`)

## v1.0.0 — 2026-11-04 · 2 commits

`e9d3d70` · the 2 commits after v0.115.0

### Added

- feat!: the row's ✦ name-from-work path is gone; the ✎ leads the padlock (`e9d3d70`)

### Docs & tests

- docs: render the 0.115.0 and 0.114.1 sections, both missing at the tip (`eca3bac`)

## v0.115.0 — 2026-11-04 · 4 commits

`f108689` · the 4 commits after v0.114.1

### Added

- feat: the queue explainer is a lead and five labelled lines, and Settings ships one press away (`254ad5c`)

### Docs & tests

- docs: the plan names the base it is cut from — 0.114.0, and the flow block's last line (`fe6613a`)
- docs: the render landed once and the duplicate closed, re-checked at 0.114.0 (`49f6e4e`)

### Other

- chore: 0.115.0 — the version this landing carries (`f108689`)

## v0.114.1 — 2026-11-04 · 3 commits

`698743f` · the 3 commits after v0.114.0

### Docs & tests

- docs: render the 0.114.0 and 0.113.0 sections, the two main had not rendered (`97e6b86`)
- docs: plan the pipeline flow's integration, in the order the comparables justify (`3326190`)

### Other

- chore: 0.114.1 — the version this landing carries (`698743f`)

## v0.114.0 — 2026-11-03 · 2 commits

`cad0469` · the 2 commits after v0.113.0

### Docs & tests

- docs: render the 0.111.2 and 0.111.3 sections, both missing at once (`b64d8f0`)
- test: both routes into the pipeline flow, judged visible and clean at 1280 and 1821 (`cad0469`)

## v0.113.0 — 2026-11-03 · 3 commits

`743789d` · the 3 commits after v0.111.3

### Added

- feat: the Gateway tab starts and stops the Matrix bridge (`d75488f`)
- feat: the bridge starts with the panel, and its four settings are editable (`86c659d`)

### Other

- chore: 0.113.0 — the version this landing carries (`743789d`)

## v0.111.3 — 2026-11-03 · 2 commits

`4ebaa62` · the 2 commits after v0.111.2

### Docs & tests

- docs: the critique counts its own findings, and its two findings that need geometry (`1036d5d`)

### Other

- chore: 0.111.3 — the version this landing carries (`4ebaa62`)

## v0.111.2 — 2026-11-03 · 3 commits

`a980b30` · the 3 commits after v0.111.1

### Docs & tests

- docs: render the 0.111.1 section, after main carried d3b3954 (`19879ba`)
- docs: critique the pipeline flow's architecture — the diagnosis holds, the price does not (`34c2f54`)

### Other

- chore: 0.111.2 — the version this landing carries (`a980b30`)

## v0.111.1 — 2026-11-03 · 3 commits

`d3b3954` · the 3 commits after v0.111.0

### Docs & tests

- docs: render the 0.111.0 section, after main moved to 75e648c (`2bc4dcf`)
- docs: review the pipeline flow's technology — the drawing that carries state (`8371146`)

### Other

- chore: 0.111.1 — the version this landing carries (`d3b3954`)

## v0.111.0 — 2026-11-03 · 4 commits

`75e648c` · the 4 commits after v0.110.0

### Added

- feat: a task on a pipeline is driven stage by stage, to the pipeline's own limits (`a71453c`)

### Docs & tests

- docs: render the 0.110.0 section, after main moved to b662bce (`43d4b94`)
- docs: a render is never folded into the bump it describes (`db52ecd`)

### Other

- chore: 0.111.0 — the version this landing carries (`75e648c`)

## v0.110.0 — 2026-11-03 · 5 commits

`b662bce` · the 5 commits after v0.109.0

### Added

- feat: the DELIVERABLES list gets its backend — a store, a harvest, and two real routes (`203093e`)

### Docs & tests

- docs: render the changelog after the merge, so its links name main's commits (`65b7c01`)
- docs: the changelog is rendered after the merge, never on the branch (`1ba00e9`)
- docs: render the 0.109.0 section, after main moved to 9166869 (`b26631b`)

### Other

- chore: 0.110.0 — the version this landing carries (`b662bce`)

## v0.109.0 — 2026-11-03 · 3 commits

`9166869` · the 3 commits after v0.106.2

### Added

- feat: the queue row leads with what it is, its state and what it waits on (`48f484e`)

### Docs & tests

- docs: render the changelog through 0.106.2, where it had stopped at 0.91.0 (`7f55744`)

### Other

- chore: 0.109.0 — the version this landing carries (`9166869`)

## v0.106.2 — 2026-11-03 · 2 commits

`1641e5a` · the 2 commits after v0.106.1

### Docs & tests

- docs: the Settings strip names every tab it draws, and the count comes from that list (`728478f`)

### Other

- chore: 0.106.2 — the version this landing carries (`1641e5a`)

## v0.106.1 — 2026-11-03 · 3 commits

`47e2774` · the 3 commits after v0.106.0

### Added

- feat: the pipeline flow is a drawing, and one modal opens it from Settings and a queue row (`28433cc`)

### Docs & tests

- test: the modal's source checks read a normalised copy, so a CRLF checkout cannot fail them (`fa83696`)

### Other

- chore: 0.106.1 — the version this landing carries (`47e2774`)

## v0.106.0 — 2026-11-03 · 2 commits

`4c42a05` · the 2 commits after v0.105.0

### Added

- feat: every brief teaches the DELIVER marker, and the list says what a deliverable is (`9b4c462`)

### Other

- chore: 0.106.0 — the version this landing carries (`4c42a05`)

## v0.105.0 — 2026-11-03 · 2 commits

`0ef104a` · the 2 commits after v0.104.0

### Fixed

- fix: a restart waits only for a thread it named, and only a new version is a bounce for nothing (`ed915e9`)

### Other

- chore: 0.105.0 — the version this landing carries (`0ef104a`)

## v0.104.0 — 2026-11-03 · 2 commits

`c55f88f` · the 2 commits after v0.103.0

### Added

- feat: the DELIVERABLES hand-back button and its list (`ed97151`)

### Other

- chore: 0.104.0 — the version this landing carries (`c55f88f`)

## v0.103.0 — 2026-11-03 · 2 commits

`206d61e` · the 2 commits after v0.102.0

### Docs & tests

- docs: re-measure Appendix A at the 0.102.0 tip, after #317 moved app.js (`2f53651`)

### Other

- chore: 0.103.0 — the version this landing carries (`206d61e`)

## v0.102.0 — 2026-11-03 · 3 commits

`6a25c5b` · the 3 commits after v0.101.0

### Docs & tests

- docs: re-measure Appendix A at the 0.101.0 tip, where server.js moved (`a7be2cc`)

### Other

- Settings > Bundles: list an imported bundle's pipelines and refuse it by code (`4c68b17`)
- chore: 0.102.0 — the version this landing carries (`6a25c5b`)

## v0.101.0 — 2026-11-03 · 2 commits

`4463e0e` · the 2 commits after v0.100.0

### Added

- feat: a review wait is a timer on the tree, not a worker sleeping in a run (`27b8f64`)

### Other

- chore: 0.101.0 — the version this landing carries (`4463e0e`)

## v0.100.0 — 2026-11-03 · 2 commits

`e7beb8e` · the 2 commits after v0.99.0

### Docs & tests

- docs: re-measure architecture.md at the 0.99.0 tip, where the test counts moved (`9357baa`)

### Other

- chore: 0.100.0 — the version this landing carries (`e7beb8e`)

## v0.99.0 — 2026-11-03 · 1 commit

`e4cb244` · the 1 commit after v0.98.0

### Other

- Stop the version gate passing a branch that is merely behind main (#312) (`e4cb244`)

## v0.98.0 — 2026-11-03 · 5 commits

`fe629de` · the 5 commits after v0.95.0

### Docs & tests

- docs: plan the DELIVER handback — marker, harvest seam, store and header list (`70d7dea`)
- docs: review the DELIVER handback plan — 3 blockers, 14 must-fixes, 15 nits (`a656a55`)
- docs: revise the deliverables plan against the review — B1-B3 and M1-M14 (`2c2ac91`)
- docs: settle the two choices — image glyph, paragraph on every tree turn (`bdcc61b`)

### Other

- chore: 0.98.0 — the version this landing carries (`fe629de`)

## v0.95.0 — 2026-11-03 · 2 commits

`9669681` · the 2 commits after v0.94.0

### Docs & tests

- test: both app.js pins cut their own section, not a neighbour's closer (`f4ee22b`)

### Other

- chore: 0.95.0 — the version this landing carries (`9669681`)

## v0.94.0 — 2026-11-03 · 2 commits

`e88dc53` · the 2 commits after v0.93.1

### Added

- feat: the version bump tags itself, and a backfill repairs the ones it missed (`297b957`)

### Other

- chore: 0.94.0 — the version this landing carries (`e88dc53`)

## v0.93.1 — 2026-11-03 · 1 commit

`6db8f29` · the 1 commit after v0.93.0

### Fixed

- fix: a branch that never committed is not MERGED (`6db8f29`)

## v0.93.0 — 2026-11-03 · 2 commits

`dc5bde2` · the 2 commits after v0.92.0

### Added

- feat: a queue sweep on every settle, and a failsafe for the quiet board (`dc5bde2`)

### Docs & tests

- test: the aggressive acceptance checks the switch where it now lives (`f9f103d`)

## v0.92.0 — 2026-11-03 · 1 commit

`f55fecb` · the 1 commit after v0.91.0

### Added

- feat: the aggressive switch moves into an assistant's Settings pane (`f55fecb`)

## v0.91.0 — 2026-11-03 · 1 commit

`99e58cf` · the 1 commit after v0.90.2

### Added

- feat: the chart draws the top N worktrees, and its arrow says how many are behind it (`99e58cf`)

## v0.90.2 — 2026-11-03 · 1 commit

`c7b6912` · the 1 commit after v0.90.1

### Fixed

- fix: config.json is written atomically, so a reader never sees it torn (#304) (`c7b6912`)

## v0.90.1 — 2026-11-03 · 2 commits

`9474bf1` · the 2 commits after v0.90.0

### Fixed

- fix: size an approval card from approvals.timeout, not a copied 600 s (`4e36aa6`)

### Other

- chore: 0.90.1 — the review finding over 0.90.0 (`9474bf1`)

## v0.90.0 — 2026-11-03 · 2 commits

`b8106ed` · the 2 commits after v0.87.2

### Fixed

- fix: an approval card keeps the whole window the gateway waits, 600 s by default (`add38f3`)

### Other

- chore: 0.90.0 — the version this landing carries over 0.87.0 (`b8106ed`)

## v0.87.2 — 2026-11-03 · 2 commits

`2e444e0` · the 2 commits after v0.87.1

### Docs & tests

- docs: adjudicate the two architectural reviews into one costed seam list (`3592b1e`)
- docs: fold the four reviews into one offline page, and land both missing inputs (`2e444e0`)

## v0.87.1 — 2026-11-03 · 1 commit

`e6e11fb` · the 1 commit after v0.87.0

### Docs & tests

- docs: measure the top-down architectural review and name every seam of the split (`e6e11fb`)

## v0.87.0 — 2026-11-03 · 1 commit

`4f660d2` · the 1 commit after v0.86.0

### Added

- feat: every queue card names its project beside the files (`4f660d2`)

## v0.86.0 — 2026-11-03 · 2 commits

`489389d` · the 2 commits after v0.85.2

### Added

- feat: the HUMAN rotation includes an assistant's own question, and opens its float (`489389d`)

### Docs & tests

- docs: 0.85.2 — Assistant-2's task-queue assessment, copied verbatim (`42ccec4`)

## v0.85.2 — 2026-11-03 · 4 commits

`97b17e1` · the 4 commits after v0.85.1

### Added

- feat: tag every version bump, and render CHANGELOG.md between the tags (`956cb71`)
- feat: a gate that fails when a version bump has no tag (`129f81d`)

### Docs & tests

- docs: re-render the changelog on 0.85.0, and anchor the bump main picked up (`bf41b2f`)
- test: the two rotted harnesses are live gates again, and wired into the runner (#299) (`97b17e1`)

## v0.85.1 — 2026-11-03 · 2 commits

`163fed3` · the 2 commits after v0.85.0

### Added

- feat: Settings → Gateway saves OpenRouter profiles and restarts either process on its own press (`03b3ff0`)

### Fixed

- fix: the stale-worktree threshold commits on Enter, and the tail chip is written once (#295) (`163fed3`)

## v0.85.0 — 2026-11-03 · 1 commit

`44cb6a8` · the 1 commit after v0.84.0

### Docs & tests

- test: the minimized composer block, driven in a real browser at two window heights (`44cb6a8`)

## v0.84.0 — 2026-11-03 · 1 commit

`cc61bb9` · the 1 commit after v0.83.0

### Added

- feat: a card with every turn folded puts the composer block under its head (`cc61bb9`)

## v0.83.0 — 2026-11-03 · 2 commits

`a99883f` · the 2 commits after v0.82.0

### Added

- feat: a HUMAN button beside NOT-RUNNING cycles every open permission and clarify question (`a99883f`)

### Fixed

- fix: the pipeline window's move press reads the stage SELECT, not the first stage row (`92e8735`)

## v0.82.0 — 2026-11-03 · 1 commit

`298fa1e` · the 1 commit after v0.81.0

### Docs & tests

- test: the task pipeline window, end to end in a real browser — 47 cases, and the move press is dead (`298fa1e`)

## v0.81.0 — 2026-11-03 · 3 commits

`4102020` · the 3 commits after v0.80.0

### Added

- feat: a task can be put on a pipeline — the control, the write, and the studio's own seed (`6da7bad`)
- feat: the Pipeline tab edits the catalogue, and /api/pipelines reads and saves it (`4102020`)

### Fixed

- fix: an uncomputable time in stage is shown as unknown, not counted up from the open (`00a6703`)

## v0.80.0 — 2026-11-03 · 5 commits

`c5aa9f7` · the 5 commits after v0.79.1

### Added

- feat: the panel can read a studio pipeline bundle, and say where a task sits in it (`531115b`)
- feat: a task's pipeline reads as one window model — every stage, its gate, and time in stage (`affbd9a`)
- feat: a Queue row opens its pipeline window — stages in order, the current one marked, an unresolved record named (`56492a1`)

### Docs & tests

- test: a browser gate for the task pipeline window — 46 checks over four records, and 0/8 on the base (`e4122ec`)

### Other

- chore: 0.80.0 — the task pipeline window, and the script that proves it (`c5aa9f7`)

## v0.79.1 — 2026-11-03 · 2 commits

`3a1d164` · the 2 commits after v0.79.0

### Fixed

- fix: keep the assistant chat's last message above the composer (`3a1d164`)

### Docs & tests

- test: measure 0.78.1 against 0.75.0 on one identical 200-row board (`9a6e4c8`)

## v0.79.0 — 2026-11-03 · 1 commit

`2700cc4` · the 1 commit after v0.78.2

### Docs & tests

- test: profile the four reader-facing paths on a seeded 201-row store (`2700cc4`)

## v0.78.2 — 2026-11-03 · 1 commit

`7836d71` · the 1 commit after v0.78.1

### Docs & tests

- docs: efficiency review of the 0.75.0..0.78.1 delta (`7836d71`)

## v0.78.1 — 2026-11-03 · 3 commits

`fd36130` · the 3 commits after v0.78.0

### Fixed

- fix: a configured remote the checkout lacks falls back to origin, so every row stops reading NO BASE REF (`fd36130`)

### Docs & tests

- docs: playwright round 1 — every verdict in agent-worktree-gui reads NO BASE REF (`74395a2`)
- docs: name the contrast instance in round 1's report (`9c00028`)

## v0.78.0 — 2026-11-03 · 1 commit

`e544b43` · the 1 commit after v0.77.2

### Added

- feat: the console draws the agent's markdown, with a raw view and a focus control (`e544b43`)

## v0.77.2 — 2026-11-03 · 4 commits

`4ba624e` · the 4 commits after v0.77.1

### Fixed

- fix: a held drag scrolls the queue's pane, so a card lands where the pointer is (`a25f134`)
- fix: a refused drop keeps its reason in view while the queue is scrolled (`f285fb9`)

### Docs & tests

- test: a person-level drag gate proves the lift, the edge drop and the refusal, red on 0.77.1 (`3f5a104`)

### Other

- chore: 0.77.2 — the patch over main's 0.77.1 (`4ba624e`)

## v0.77.1 — 2026-11-03 · 2 commits

`c652f51` · the 2 commits after v0.77.0

### Fixed

- fix: a restart entry fires once, and a replay is refused by name (`c652f51`)

### Docs & tests

- docs: a read-only visual audit of the assistant queue pane (`9581cef`)

## v0.77.0 — 2026-11-03 · 3 commits

`ab2db8c` · the 3 commits after v0.76.0

### Fixed

- fix: the parked turn's card stops offering a steer the gateway refuses (`73fd0fb`)

### Docs & tests

- test: a gate proves the three steer refusals, red on 0.74.0 (`c74a1af`)

### Other

- chore: 0.77.0 — the patch over main's 0.76.0 (`ab2db8c`)

## v0.76.0 — 2026-11-03 · 5 commits

`eeec9fe` · the 5 commits after v0.75.0

### Fixed

- fix: a hold-less park whose reason names a done row says the reason is stale (`6e7f7b6`)
- fix: a sentry pass that throws cannot skip the queue sweep (`1ea2821`)

### Docs & tests

- test: a gate proves the question chip on a parked row, red on 0.73.3 (`35b3c82`)
- test: a gate proves a stale park reason and a sweep a failed pass cannot skip, red on 0.75.0 (`c66aaa8`)

### Other

- chore: 0.76.0 — the patch over main's 0.75.0 (`eeec9fe`)

## v0.75.0 — 2026-11-02 · 1 commit

`dd11c9f` · the 1 commit after v0.74.0

### Added

- feat: a row parked on a question wears a question chip (`dd11c9f`)

## v0.74.0 — 2026-11-02 · 2 commits

`88703ca` · the 2 commits after v0.73.9

### Added

- feat: the agent card draws its tree's pipeline chip (`dbccd43`)

### Docs & tests

- test: a gate proves the pipeline chip's three states, red on 0.73.3 (`88703ca`)

## v0.73.9 — 2026-11-02 · 1 commit

`f75164c` · the 1 commit after v0.73.8

### Other

- Record why a parked turn offered a steer the gateway refused (`f75164c`)

## v0.73.8 — 2026-11-02 · 1 commit

`d86ca81` · the 1 commit after v0.73.7

### Fixed

- fix: a wake walks the roster to the first assistant whose last run is not failed (`d86ca81`)

## v0.73.7 — 2026-11-02 · 1 commit

`26c3b14` · the 1 commit after v0.73.6

### Fixed

- fix: a narrow reply box wraps its action row instead of breaking its labels (#273) (`26c3b14`)

## v0.73.6 — 2026-11-02 · 1 commit

`e97291f` · the 1 commit after v0.73.5

### Other

- Stop the wait-stage paragraph claiming 1h10m fails a card at the 7200s cap (#272) (`e97291f`)

## v0.73.5 — 2026-11-02 · 1 commit

`5bd5425` · the 1 commit after v0.73.4

### Docs & tests

- docs: the panel's own pages still quote a 3600s run cap, not the landed 7200 (#271) (`5bd5425`)

## v0.73.4 — 2026-11-02 · 2 commits

`55a8e45` · the 2 commits after v0.73.3

### Fixed

- fix: raise the panel's run cap to 7200s so a long card is not killed at 60 minutes (`73a7c92`)

### Other

- chore: 0.73.4 — the patch over main's 0.73.3 (`55a8e45`)

## v0.73.3 — 2026-11-02 · 4 commits

`9c15e57` · the 4 commits after v0.73.2

### Fixed

- fix: a cancelled drag puts the card back instead of reordering (`e927cc4`)
- fix: the turn pager's count holds one line in the docked rail (`3a0bf33`)

### Docs & tests

- test: a gate pins the pager's count to one line in the rail, and fails on main (`60fa173`)

### Other

- chore: 0.73.3 — the patch over main's 0.73.2 (`9c15e57`)

## v0.73.2 — 2026-11-02 · 4 commits

`7d516d3` · the 4 commits after v0.73.1

### Added

- feat: a task carries its order, and one write reorders the queue (`6e956c0`)
- feat: the queue cards drag into the reader's order, blocked by a hold (`23a14a1`)

### Docs & tests

- test: the drag persisted, the held drop refused, and the click that still opens (`644aae1`)

### Other

- chore: 0.73.2 — the patch over main's 0.73.1 (`7d516d3`)

## v0.73.1 — 2026-11-02 · 1 commit

`dfee4ac` · the 1 commit after v0.73.0

### Added

- feat: a SPAWN that names a queue row writes it at the cut (`dfee4ac`)

## v0.73.0 — 2026-11-02 · 1 commit

`178ce9b` · the 1 commit after v0.72.5

### Added

- feat: dogfood the assistant chat pane from a headless browser on its own panel (`178ce9b`)

## v0.72.5 — 2026-11-02 · 2 commits

`64f5339` · the 2 commits after v0.72.4

### Fixed

- fix: the Permissions head gives the pill its own column, and every file:line one line (`fc749cb`)

### Other

- chore: 0.72.5 — the patch over main's 0.72.4 (`64f5339`)

## v0.72.4 — 2026-11-02 · 3 commits

`2d24432` · the 3 commits after v0.72.3

### Fixed

- fix: a TODO tail only rides a run whose directory is a tree (`edf3e67`)

### Docs & tests

- test: a state dir and a tree-less directory get no TODO tail, a real tree keeps it (`c1a2cea`)

### Other

- chore: 0.72.4 — the patch over main's 0.72.3 (`2d24432`)

## v0.72.3 — 2026-11-02 · 1 commit

`1a8efc0` · the 1 commit after v0.72.2

### Changed

- style: queue rows are cards, and "unowned" is gone (`1a8efc0`)

## v0.72.2 — 2026-11-02 · 2 commits

`2d45d6c` · the 2 commits after v0.72.1

### Fixed

- fix: a park carries a testable hold, and a lane orders rows that share a file (`c51ebbc`)

### Other

- chore: 0.72.2 — the patch over main's 0.72.1 (`2d45d6c`)

## v0.72.1 — 2026-11-02 · 2 commits

`02f15c3` · the 2 commits after v0.72.0

### Fixed

- fix: an attached file on the reader's message reaches the worker a SPAWN starts (`02f15c3`)

### Docs & tests

- test: the tiered collapse, five presses named, and five real keydowns on a page (`7a3eca7`)

## v0.72.0 — 2026-11-02 · 1 commit

`23b8b12` · the 1 commit after v0.71.2

### Fixed

- fix: Ctrl+[ folds one tier per press, from the lowest open tier up (`23b8b12`)

## v0.71.2 — 2026-11-02 · 3 commits

`8eb2bf0` · the 3 commits after v0.71.1

### Fixed

- fix: a refused wake gives the finish's claim back (`76480fb`)

### Docs & tests

- test: the refused wake, the same finish, and the claim that was unpaid (`b0b2d9e`)

### Other

- chore: 0.71.2 — the patch over main's 0.71.1 (`8eb2bf0`)

## v0.71.1 — 2026-11-02 · 1 commit

`c8087f4` · the 1 commit after v0.71.0

### Fixed

- fix: the review card's Keep is the full-width bar, above Unwind (`c8087f4`)

## v0.71.0 — 2026-11-02 · 3 commits

`c57001b` · the 3 commits after v0.70.2

### Added

- feat: a parent collapsed for N seconds minimizes every card under it (`c57001b`)

### Docs & tests

- docs: a queue row parks with a hold, and releases when the hold stops being true (`e311c79`)
- test: the collapse cascade on fake timers, and the page driven both ways (`ab9a323`)

## v0.70.2 — 2026-11-02 · 1 commit

`b959957` · the 1 commit after v0.70.1

### Fixed

- fix: the board digest stops riding every turn (`b959957`)

## v0.70.1 — 2026-11-02 · 1 commit

`01947d6` · the 1 commit after v0.70.0

### Fixed

- fix: the Permissions tab reads the config this instance booted on (`01947d6`)

## v0.70.0 — 2026-11-02 · 1 commit

`a12c737` · the 1 commit after v0.69.3

### Added

- feat: Permissions reads what is in force, and where it is written (`a12c737`)

## v0.69.3 — 2026-11-02 · 2 commits

`9b253cf` · the 2 commits after v0.69.2

### Fixed

- fix: the long tier is sent once a session, not on every turn (`d48597f`)

### Other

- tools: measure what a turn's preamble costs on a sandbox panel (`9b253cf`)

## v0.69.2 — 2026-11-02 · 1 commit

`07ae700` · the 1 commit after v0.69.1

### Other

- Make the wake budget cover sweeps and never an event (`07ae700`)

## v0.69.1 — 2026-11-02 · 1 commit

`8a2b170` · the 1 commit after v0.69.0

### Docs & tests

- docs: what a sweep is, and why an event is never one (`8a2b170`)

## v0.69.0 — 2026-11-02 · 1 commit

`c2f48aa` · the 1 commit after v0.68.10

### Fixed

- fix: the controls own the head's corner, the name owns the cwd row (`c2f48aa`)

## v0.68.10 — 2026-11-02 · 2 commits

`cee444f` · the 2 commits after v0.68.9

### Docs & tests

- docs: what the gateway spends, measured on the live board (`6616867`)
- docs: the three gateway changes, with event wakes left uncapped (`cee444f`)

## v0.68.9 — 2026-11-02 · 1 commit

`1036a38` · the 1 commit after v0.68.8

### Fixed

- fix: the Settings tab strip reads at a glance, not at 9.5px (`1036a38`)

## v0.68.8 — 2026-11-02 · 2 commits

`12f915e` · the 2 commits after v0.68.7

### Docs & tests

- docs: cost the stage-contract integration and its order (`7ccdc76`)
- docs: reconcile a second independent pass on the stage contract (`12f915e`)

## v0.68.7 — 2026-11-02 · 1 commit

`5d58d21` · the 1 commit after v0.68.6

### Docs & tests

- docs: what a stage hands its agent, and what a run actually receives (`5d58d21`)

## v0.68.6 — 2026-11-02 · 2 commits

`9d4e9b8` · the 2 commits after v0.68.5

### Docs & tests

- test: the husk, the unregistered path and the live cwd, failing-first (`1251c56`)
- docs: the stage contract against the panel's pipeline model (`9d4e9b8`)

## v0.68.5 — 2026-11-02 · 1 commit

`5f110b8` · the 1 commit after v0.68.4

### Fixed

- fix: a husk is tree gone, and a live tree is never offered for deletion (`5f110b8`)

## v0.68.4 — 2026-11-02 · 1 commit

`b4ee813` · the 1 commit after v0.68.3

### Fixed

- fix: the child cut writes its rung, and a padded hole is still a hole (`b4ee813`)

## v0.68.3 — 2026-11-02 · 1 commit

`a0ecde3` · the 1 commit after v0.68.2

### Added

- feat: draw the pipeline catalogue as one self-contained page (`a0ecde3`)

## v0.68.2 — 2026-11-02 · 1 commit

`e0ae8a4` · the 1 commit after v0.68.1

### Fixed

- fix: the four P0 findings in the pipelines audit (`e0ae8a4`)

## v0.68.1 — 2026-11-02 · 2 commits

`1cb8773` · the 2 commits after v0.68.0

### Docs & tests

- test: the skills gate drives the grouping, its counts, its folds and its filter (`55eb271`)
- docs: add the child-cut and spaced-hole P0s to the pipeline audit (`1cb8773`)

## v0.68.0 — 2026-11-02 · 1 commit

`c879e30` · the 1 commit after v0.67.6

### Added

- feat: the Skills tab groups by source then category, folds both, and filters (`c879e30`)

## v0.67.6 — 2026-11-02 · 1 commit

`d34794b` · the 1 commit after v0.67.5

### Docs & tests

- docs: audit the pipeline data model against its spec (`d34794b`)

## v0.67.5 — 2026-11-02 · 1 commit

`804ed4e` · the 1 commit after v0.67.4

### Added

- feat: the pipeline catalogue, its ladder, and the record a cut writes (#234) (`804ed4e`)

## v0.67.4 — 2026-11-02 · 1 commit

`b524da9` · the 1 commit after v0.67.3

### Docs & tests

- docs: write the per-project pipeline design down as one page (`b524da9`)

## v0.67.3 — 2026-11-02 · 1 commit

`7120159` · the 1 commit after v0.67.2

### Fixed

- fix: the card names the tree's project, and the run id rides the cwd line (`7120159`)

## v0.67.2 — 2026-11-02 · 1 commit

`b62ab17` · the 1 commit after v0.67.1

### Docs & tests

- docs: audit every local wtgui/* branch — 24 deleted, 46 kept (`b62ab17`)

## v0.67.1 — 2026-11-02 · 1 commit

`ac66a3a` · the 1 commit after v0.67.0

### Fixed

- fix: a restart for a version already served is refused, and a stale wait cannot replay (`ac66a3a`)

## v0.67.0 — 2026-11-02 · 1 commit

`68445de` · the 1 commit after v0.66.1

### Added

- feat: the approvals dock counts what is pending and reviews the writes nobody was asked about (`68445de`)

## v0.66.1 — 2026-11-02 · 1 commit

`b066acd` · the 1 commit after v0.66.0

### Fixed

- fix: a refused steer is said plainly — it never becomes a queued reply (`b066acd`)

## v0.66.0 — 2026-11-02 · 3 commits

`f7a2202` · the 3 commits after v0.65.0

### Added

- feat: Settings gains a Skills tab — every root, every SKILL.md, read only (`f7a2202`)

### Fixed

- fix: a green note is not cut short by the red bar's clock it replaces (`f1455cc`)

### Docs & tests

- test: gate the banner's clock on both sides of the pause (`b297d2d`)

## v0.65.0 — 2026-11-02 · 1 commit

`861328c` · the 1 commit after v0.64.0

### Added

- feat: a red failure banner hides itself after the Board tab's seconds (`861328c`)

## v0.64.0 — 2026-11-02 · 2 commits

`61a6403` · the 2 commits after v0.63.0

### Added

- feat: Settings is a tab strip — one tab per group, one panel at a time (`61a6403`)

### Docs & tests

- test: the new-project route and the folder's + , proved over HTTP and in Chromium (`d035989`)

## v0.63.0 — 2026-11-02 · 1 commit

`9127b8d` · the 1 commit after v0.62.3

### Added

- feat: the folder's + makes a new local git project, on main with one commit (`9127b8d`)

## v0.62.3 — 2026-11-02 · 1 commit

`b5fe7a0` · the 1 commit after v0.62.2

### Fixed

- fix: every assistant's finished turn is harvested, and COMPLETE asks stay its own (`b5fe7a0`)

## v0.62.2 — 2026-11-02 · 1 commit

`69d10e3` · the 1 commit after v0.62.1

### Fixed

- fix: a reply never starts a run in a tree that is not its own (`69d10e3`)

## v0.62.1 — 2026-11-02 · 1 commit

`4294879` · the 1 commit after v0.62.0

### Fixed

- fix: a released tree's leftover folder reports RELEASED, not the reader's dirt (`4294879`)

## v0.62.0 — 2026-11-02 · 1 commit

`8aee64a` · the 1 commit after v0.61.0

### Fixed

- fix: the intro box's Send reaches the server again, for every assistant (`8aee64a`)

## v0.61.0 — 2026-11-02 · 1 commit

`2089794` · the 1 commit after v0.60.1

### Added

- feat: the Settings panel is a window — drag its head, size it from the corner (`2089794`)

## v0.60.1 — 2026-11-02 · 3 commits

`6765944` · the 3 commits after v0.60.0

### Fixed

- fix: a boot replay does not cut a tree for a debt it already settled (`7d9b387`)

### Docs & tests

- test: the restart gate replays a debt the panel recorded, not one this file seeded (`56d8cdc`)
- docs: what the three replay debts were, and the version 0.60.1 patch (`6765944`)

## v0.60.0 — 2026-11-02 · 1 commit

`7a9959a` · the 1 commit after v0.59.0

### Added

- feat: an assistant's pane is docked or floating — its own setting, docked by default (`7a9959a`)

## v0.59.0 — 2026-11-02 · 2 commits

`df3b95d` · the 2 commits after v0.58.3

### Fixed

- fix: a boot replay settles a debt whose tree is gone, not only one whose work landed (`df3b95d`)

### Docs & tests

- docs: the collapsed row's identity line, with the before/after snapshots (`0119adb`)

## v0.58.3 — 2026-11-02 · 1 commit

`697881f` · the 1 commit after v0.58.2

### Fixed

- fix: a minimized card reads cwd, then the name, then its buttons (`697881f`)

## v0.58.2 — 2026-11-02 · 1 commit

`18b6a4f` · the 1 commit after v0.58.1

### Fixed

- fix: the banner floats under the measured topbar instead of shoving the board (`18b6a4f`)

## v0.58.1 — 2026-11-02 · 2 commits

`e14e7b7` · the 2 commits after v0.58.0

### Added

- feat: a restart needs a reason, a wait can be cancelled, and a landed brief is not replayed (`e14e7b7`)

### Docs & tests

- test: the queue gate reads the sub-rows the row actually draws, and scopes the glyphs to it (`e7e8a5a`)

## v0.58.0 — 2026-11-02 · 1 commit

`23cbac9` · the 1 commit after v0.57.1

### Added

- feat: the queue row is a console row — one sub-row per agent, glyph presses, a Move popover (`23cbac9`)

## v0.57.1 — 2026-11-02 · 1 commit

`29217b1` · the 1 commit after v0.57.0

### Added

- feat: remove the Role tab's whitelists and give each assistant its own Worktrees sub-tab (`29217b1`)

## v0.57.0 — 2026-11-02 · 1 commit

`25b3ea3` · the 1 commit after v0.56.5

### Added

- feat: two assistants run at once, each on its own thread, tree and queue (`25b3ea3`)

## v0.56.5 — 2026-11-02 · 1 commit

`1a0fb98` · the 1 commit after v0.56.4

### Fixed

- fix: a Move hands the task to the other assistant's file, and the queue has a real end-to-end gate (`1a0fb98`)

## v0.56.4 — 2026-11-02 · 2 commits

`e08f9f0` · the 2 commits after v0.56.3

### Fixed

- fix: every queue digest line carries state, thread, tree, PR and why it is not going (`4b7fd15`)
- fix: the preamble leads with the queue, and says a restart re-attaches runs (`e08f9f0`)

## v0.56.3 — 2026-11-02 · 1 commit

`e92243b` · the 1 commit after v0.56.2

### Fixed

- fix: the chart fits the board when the assistant rail opens, and the owner column is a tag (`e92243b`)

## v0.56.2 — 2026-11-02 · 2 commits

`04db63f` · the 2 commits after v0.56.1

### Docs & tests

- docs: 0.56.1 - patch: the owner record carries the row-event fix and the re-check at 0.56.0 (`1929e4d`)
- docs: 0.56.2 - patch: re-derive the app.js split plan at 0.56.1 (`04db63f`)

## v0.56.1 — 2026-11-02 · 2 commits

`f94e286` · the 2 commits after v0.56.0

### Fixed

- fix: a tree's first row event carries its owner, so the column cannot blank on its own (`f94e286`)

### Docs & tests

- docs: 0.56.0 - the per-assistant queue re-checked at 0.55.0, with the browser gate it was missing (`e379dc5`)

## v0.56.0 — 2026-11-02 · 2 commits

`c503b74` · the 2 commits after v0.55.0

### Added

- feat: a browser gate for the Queue sub-tab's four markers (`c503b74`)

### Fixed

- fix: a new assistant's queue file is seeded when it is created (`4b0f8e8`)

## v0.55.0 — 2026-11-02 · 1 commit

`75a89f4` · the 1 commit after v0.54.0

### Added

- feat: the assistant is a docked right rail, not a floating window (`75a89f4`)

## v0.54.0 — 2026-11-02 · 1 commit

`2a0a96f` · the 1 commit after v0.53.4

### Fixed

- fix: the queue pane stops re-arming its own read, and drives its own assistant (`2a0a96f`)

## v0.53.4 — 2026-11-02 · 1 commit

`71e188f` · the 1 commit after v0.53.3

### Docs & tests

- docs: 0.53.4 - patch: re-derive the app.js split plan at 0.53.2 (`71e188f`)

## v0.53.3 — 2026-11-02 · 2 commits

`28bad77` · the 2 commits after v0.53.2

### Fixed

- fix: the sub-tab gate follows the Queue tab that landed after it (`bb9b8eb`)

### Docs & tests

- docs: 0.53.3 - patch: the settings split re-checked at 0.53.2 (`28bad77`)

## v0.53.2 — 2026-11-01 · 2 commits

`622940f` · the 2 commits after v0.53.1

### Fixed

- fix: the owner column names the assistant, with its role in the tooltip (`622940f`)

### Docs & tests

- docs: 0.53.1 - patch: one console size for the console's text, re-checked at 0.53.0 (`6438642`)

## v0.53.1 — 2026-11-01 · 1 commit

`23bdd10` · the 1 commit after v0.53.0

### Fixed

- fix: Display's tooltip stops promising Thinking text a size of its own (`23bdd10`)

## v0.53.0 — 2026-11-01 · 1 commit

`935bfc4` · the 1 commit after v0.52.2

### Added

- feat: give every assistant its own task queue (`935bfc4`)

## v0.52.2 — 2026-11-01 · 1 commit

`e317798` · the 1 commit after v0.52.1

### Docs & tests

- docs: 0.52.2 - patch: the worktree owner by role label was already landed; record the re-check (`e317798`)

## v0.52.1 — 2026-11-01 · 1 commit

`3d17063` · the 1 commit after v0.52.0

### Docs & tests

- docs: 0.52.1 - patch: the assistant settings split was already landed; record the re-check (`3d17063`)

## v0.52.0 — 2026-11-01 · 1 commit

`635404b` · the 1 commit after v0.51.4

### Added

- feat: give every worktree an owning assistant, shown as a role label (`635404b`)

## v0.51.4 — 2026-11-01 · 1 commit

`fb9e6eb` · the 1 commit after v0.51.3

### Docs & tests

- docs: 0.51.4 - patch: plan the split of public/app.js into modules, ranked by blast radius (`fb9e6eb`)

## v0.51.3 — 2026-11-01 · 1 commit

`78d5cd7` · the 1 commit after v0.51.2

### Docs & tests

- test: measure a below-cap console height, and the real 30 s resync net (`78d5cd7`)

## v0.51.2 — 2026-11-01 · 1 commit

`66659c4` · the 1 commit after v0.51.1

### Docs & tests

- docs: 0.51.2 - patch: one console size for normal, reasoning and tool text was already landed; record the re-check (`66659c4`)

## v0.51.1 — 2026-11-01 · 1 commit

`14c27c3` · the 1 commit after v0.51.0

### Docs & tests

- docs: 0.51.1 - patch: the console-grab measurement was already landed; record the re-check (`14c27c3`)

## v0.51.0 — 2026-11-01 · 1 commit

`65f1e8e` · the 1 commit after v0.50.2

### Added

- feat: split the assistant's settings into a Watchdog tab and per-assistant settings (`65f1e8e`)

## v0.50.2 — 2026-11-01 · 2 commits

`2d80df0` · the 2 commits after v0.50.1

### Docs & tests

- docs: correct the record's own read time to the clock it was measured on (`cea6dfe`)
- docs: 0.50.2 - patch: the Combined output default was already landed; record the re-check (`2d80df0`)

## v0.50.1 — 2026-11-01 · 1 commit

`ae3d9c1` · the 1 commit after v0.50.0

### Docs & tests

- docs: 0.50.1 - patch: per-assistant settings, role prompt and whitelists were already landed; record the check (`ae3d9c1`)

## v0.50.0 — 2026-11-01 · 1 commit

`8237843` · the 1 commit after v0.49.3

### Added

- feat: one console size drives normal, reasoning and tool text (`8237843`)

## v0.49.3 — 2026-11-01 · 3 commits

`c063405` · the 3 commits after v0.49.2

### Docs & tests

- test: the height store keeps a dragged height above and below the cap, and forgets a turn that left (`570c3de`)
- test: gate a dragged console height through every rebuild trigger that used to lose it (`de6c384`)
- test: read the height a console grab records, and pin it per case (`c063405`)

## v0.49.2 — 2026-11-01 · 3 commits

`7d45176` · the 3 commits after v0.49.1

### Fixed

- fix: a console height the reader dragged survives the rebuild that replaces the box (`7d45176`)

### Docs & tests

- test: pin the Combined output default at build, over both per-card answers, and through a save (`3cb5d55`)
- test: gate the Combined output default across two runs and two presses, in a real browser (`29d5375`)

## v0.49.1 — 2026-11-01 · 1 commit

`e69b6be` · the 1 commit after v0.49.0

### Added

- feat: a Combined output default beside Show thinking, for the one-stream console (`e69b6be`)

## v0.49.0 — 2026-11-01 · 2 commits

`554d1cd` · the 2 commits after v0.48.4

### Added

- feat: one assistant's own settings, its own default role prompt and its two whitelists (`473161a`)

### Other

- chore: bump minor (0.49.0) for per-assistant settings, role prompts and whitelists (`554d1cd`)

## v0.48.4 — 2026-11-01 · 1 commit

`7e7879a` · the 1 commit after v0.48.3

### Docs & tests

- docs: 0.48.4 - patch: the three PRs were already landed; record the re-check, no product change (`7e7879a`)

## v0.48.3 — 2026-11-01 · 2 commits

`8e7c01e` · the 2 commits after v0.48.2

### Docs & tests

- test: measure the console grab's corner tracking on following, parked and streaming consoles (`b7d9ecb`)

### Other

- chore: 0.48.3 - patch: a measurement harness for the console grab, no product change (`8e7c01e`)

## v0.48.2 — 2026-11-01 · 8 commits

`dbcc005` · the 8 commits after v0.48.1

### Performance

- perf: a project event that carries nothing new stops before the section rebuild (`cde7b9e`)
- perf: the ranking passes read the board's children, not every node under it (`f2b3353`)
- perf: the queue clock, stale-detail sweep, question clocks and tool-store refresh read the node registry (`8d50d1a`)

### Docs & tests

- test: the jitter gate judges the gap a frame paints, not the gap before the page's own stick (`8c85fdc`)
- test: a repeated project event changes nothing, a changed one still repaints (`0b0fe35`)
- test: the ranking passes read children, and no longer search below the host (`d26b90e`)
- test: the registry answers the walk for the four new kinds as well (`6125cda`)

### Other

- chore: 0.48.2 - patch: unchanged project events stop rebuilding sections, ranking reads children, and the jitter gate reads what is painted (`dbcc005`)

## v0.48.1 — 2026-11-01 · 14 commits

`f4ebe34` · the 14 commits after v0.48.0

### Fixed

- fix: a panel refuses to start on a port something already answers on, before it touches anything (`4e008e5`)

### Performance

- perf: measure the chart's columns only when a worktree row changed, not on every console line (`cf9db2d`)
- perf: paintSubagents finds the strips once per roster poll, not once or twice per job (`45b82d7`)
- perf: refreshChips and the age arrow keep their project's nodes, and skip an unchanged strip (`e56e63b`)
- perf: an agent event finds its row through the row map, and restarts the flash without a reflow (`fdea93c`)
- perf: a pulse dot scrolled out of view stops animating until it is back (`c0fd917`)
- perf: the board's consoles are found from a registry of placed nodes, not a walk of the page (`f7b695e`)

### Docs & tests

- test: pin the console's resize handle to the pointer with a browser gate (`cfcbec3`)
- test: pin the rows-only column memo, and keep the column-fit gate's window measuring (`0f8d5aa`)
- test: pin the board's per-event lookups to the nodes they already hold, and the off-screen dot (`2fb71ce`)
- test: one panel per port - the shadowing boot is refused, a restart waits for its predecessor (`d22462e`)
- test: six browser gates import freePort, the name panel-testkit exports, and start again (`3eb89ac`)
- test: the console registry answers what a walk of the page answers, in a real browser (`0bd8f80`)

### Other

- chore: 0.48.1 - patch: the board's main thread does about half the work for the same picture, and one panel per port (`f4ebe34`)

## v0.48.0 — 2026-11-01 · 1 commit

`9808fec` · the 1 commit after v0.47.2

### Fixed

- fix: keep the console's resize corner under the pointer that grabbed it (`9808fec`)

## v0.47.2 — 2026-11-01 · 2 commits

`4d7bcf3` · the 2 commits after v0.47.1

### Fixed

- fix: a paragraph the reader left mid-type is drawn whole when they come back (`26565eb`)

### Other

- chore: bump patch (0.47.2) for the console's missing text (`4d7bcf3`)

## v0.47.1 — 2026-11-01 · 4 commits

`56aa66d` · the 4 commits after v0.47.0

### Fixed

- fix: the PR cell says `none` — the branch column already answers "gone" (`ac77d5c`)

### Docs & tests

- test: pin the PR cell's one word, in the page and on the rendered row (`f9ffb41`)
- docs: the PR column's `none` is the whole answer (`f7582ad`)

### Other

- chore: bump patch (0.47.1) for the PR cell's one word (`56aa66d`)

## v0.47.0 — 2026-11-01 · 6 commits

`e237d6e` · the 6 commits after v0.46.8

### Added

- feat: a browser gate for the chart's column measurement moving the consoles (`28559f3`)

### Fixed

- fix: measure the chart's columns on a copy, never the live table that holds the consoles (`0a96e3b`)
- fix: a scroll write that moved nothing leaves no claim on the reader's next scroll (`3b4bbcd`)

### Docs & tests

- test: pin the column measurement and the scroll flag without a browser (`6b2175f`)
- docs: why the console bounced and lost the reader's place, with the fix (html) (`93db104`)

### Other

- chore: bump minor (0.47.0) for the new console column-fit gate (`e237d6e`)

## v0.46.8 — 2026-11-01 · 1 commit

`c4a0093` · the 1 commit after v0.46.7

### Docs & tests

- docs: three open docs/harness PRs landed in order, 0.46.5 -> 0.46.7 (0.46.8) (`c4a0093`)

## v0.46.7 — 2026-11-01 · 1 commit

`b1c5bd2` · the 1 commit after v0.46.6

### Docs & tests

- docs: a read-only 60 s window on b499c61 — no arrival at 0, a park lost to the tail (`b1c5bd2`)

## v0.46.6 — 2026-11-01 · 1 commit

`4ea03f7` · the 1 commit after v0.46.5

### Other

- Report the console frames that paint at 0, with the rebuild in front of each (`4ea03f7`)

## v0.46.5 — 2026-11-01 · 1 commit

`788a7a8` · the 1 commit after v0.46.4

### Docs & tests

- test: close the typed window at --seconds, and record what the gesture did (`788a7a8`)

## v0.46.4 — 2026-11-01 · 2 commits

`21aa536` · the 2 commits after v0.46.3

### Docs & tests

- test: pin --jobs with two harnesses that must meet each other (`dac78f1`)
- docs: the canonical Runs API needs a cwd-binding gateway, not the legacy knobs patch (0.46.4) (`21aa536`)

## v0.46.3 — 2026-11-01 · 1 commit

`5293760` · the 1 commit after v0.46.2

### Docs & tests

- test: run verification harnesses in parallel with --jobs (`5293760`)

## v0.46.2 — 2026-11-01 · 1 commit

`a0b0026` · the 1 commit after v0.46.1

### Other

- console: an unread tool store is not an empty one (`a0b0026`)

## v0.46.1 — 2026-11-01 · 5 commits

`b499c61` · the 5 commits after v0.46.0

### Added

- feat: the Charter tab is the Role tab, editable per assistant (`2f16c2b`)
- feat: every assistant thread is a conversation, not a worker (`31fb558`)

### Docs & tests

- test: drive the Role tab, Assistant #2 and #2's own copy (`5d29a95`)

### Other

- tools: pin the console-write harness to a named port, and count arrivals at 0 (`324f8e2`)
- console: follow the newest line, or the reader — never a 40 px band between them (`b499c61`)

## v0.46.0 — 2026-11-01 · 6 commits

`0581afd` · the 6 commits after v0.45.0

### Added

- feat: a role is a named charter, and each assistant runs its own copy (`d6595be`)
- feat: routes for a role, its charter, and a new assistant made from one (`f746762`)
- feat: each assistant runs its own role, charter, rules and thread (`0581afd`)

### Other

- Pin a built console's place, and the order placeRow gives up its detail (`d434db7`)
- Give the frame sampler a rebuild layout that builds a card (`89816a9`)
- Record what a console a rebuild builds opens on (`493cc37`)

## v0.45.0 — 2026-11-01 · 2 commits

`29d2a0b` · the 2 commits after v0.44.1

### Other

- Keep a console the reader was handed over out of the pacer's stick (`93a7357`)
- Place a console a rebuild builds before the frame that paints it (`29d2a0b`)

## v0.44.1 — 2026-11-01 · 7 commits

`68d96e6` · the 7 commits after v0.44.0

### Other

- Stop rewriting a console row the panel has already drawn (`74226c5`)
- Reveal a growing console row by growing its text node (`83aef7a`)
- Pin the console row's tail append against a small DOM model (`8e76a0a`)
- Type a skill result's head, not all forty of its rows (`d98f392`)
- Pin the rule that bounds a paced skill result to its head (`0d3590b`)
- Address a console row through its own job, and keep a row's detail it already draws (`89d896c`)
- chore: 0.44.1 — a patch over main's 0.44.0 (`68d96e6`)

## v0.44.0 — 2026-11-01 · 3 commits

`768c5cc` · the 3 commits after v0.43.0

### Docs & tests

- test: pin the assistant's two rows, and the sub-tab that survives a reload (`feefeeb`)

### Other

- tools: measure a console for drift after the wheel stops (#159) (`e8576e8`)
- tools: soak a board at a day's event volume and count what grows (`768c5cc`)

## v0.43.0 — 2026-11-01 · 1 commit

`6d1c9c0` · the 1 commit after v0.42.0

### Added

- feat: the assistant float's two rows, and one {assistant, subTab} record (0.43.0) (`6d1c9c0`)

## v0.42.0 — 2026-11-01 · 2 commits

`6dcf1ba` · the 2 commits after v0.41.1

### Added

- feat: a fold the reader opens holds the console still, behind a switch that ships off (0.42.0) (`6dcf1ba`)

### Docs & tests

- test: pin the per-card input guard with a wheel over another card (`6714a3d`)

## v0.41.1 — 2026-11-01 · 1 commit

`d0f83e5` · the 1 commit after v0.41.0

### Fixed

- fix: keep a pinned console pinned when another card is scrolled (`d0f83e5`)

## v0.41.0 — 2026-10-31 · 1 commit

`0e391af` · the 1 commit after v0.40.1

### Added

- feat: wake the assistant when a run's card is EXITED (0.41.0) (`0e391af`)

## v0.40.1 — 2026-10-31 · 1 commit

`f4098b0` · the 1 commit after v0.40.0

### Added

- feat: measure the combined console's output routing with four agents (0.38.1) (#154) (`f4098b0`)

## v0.40.0 — 2026-10-31 · 1 commit

`df0048a` · the 1 commit after v0.39.1

### Added

- feat: measure a pinned console and a card parked 80 px up, with four agents writing (0.40.0) (`df0048a`)

## v0.39.1 — 2026-10-31 · 3 commits

`4194b3f` · the 3 commits after v0.39.0

### Docs & tests

- test: pin the one-line shape, its Settings row, and the card's signature (`456865d`)
- test: prove the one-line shape in a browser, both ways, on one card (`7f24cc9`)
- test: count cross-card console moves with three cards streaming (`4194b3f`)

## v0.39.0 — 2026-10-31 · 1 commit

`9689b51` · the 1 commit after v0.38.1

### Added

- feat: draw a tool call as ONE expandable line, behind a Settings switch (0.39.0) (`9689b51`)

## v0.38.1 — 2026-10-31 · 2 commits

`81fd805` · the 2 commits after v0.38.0

### Other

- Make three browser gates repaint the card they test before measuring it (`8c2ab29`)
- Land the flicker's approval on a parked console, and let a gate start with no tty (`81fd805`)

## v0.38.0 — 2026-10-31 · 1 commit

`2442247` · the 1 commit after v0.37.1

### Added

- feat: draw a run of tool calls as one group of rows, ruled top and bottom (0.38.0) (`2442247`)

## v0.37.1 — 2026-10-31 · 1 commit

`d48e230` · the 1 commit after v0.37.0

### Docs & tests

- test: the combined console's first line, counted as writes and frames (`d48e230`)

## v0.37.0 — 2026-10-31 · 1 commit

`84ca277` · the 1 commit after v0.36.1

### Other

- Make the Settings row say it refreshes the model list too, and date both halves (`84ca277`)

## v0.36.1 — 2026-10-31 · 1 commit

`7090c01` · the 1 commit after v0.36.0

### Other

- Stop the guard's shim from dying with the worktree that installed it (`7090c01`)

## v0.36.0 — 2026-10-31 · 1 commit

`d1aa72a` · the 1 commit after v0.35.2

### Fixed

- fix: name a tree only when its run has settled, and never after a title that promises work (0.36.0) (`d1aa72a`)

## v0.35.2 — 2026-10-31 · 1 commit

`81943df` · the 1 commit after v0.35.1

### Docs & tests

- docs: the card's cwd is a request, and it now says so (`81943df`)

## v0.35.1 — 2026-10-31 · 1 commit

`dfdf055` · the 1 commit after v0.35.0

### Fixed

- fix: a TODO line's id is the leading integer, so a trailing reason no longer refuses the line (`dfdf055`)

## v0.35.0 — 2026-10-31 · 1 commit

`ac2ea8a` · the 1 commit after v0.34.4

### Added

- feat: set every piece of the 🌊 stream apart with the reasoning block's blank line (`ac2ea8a`)

## v0.34.4 — 2026-10-31 · 1 commit

`f98a82b` · the 1 commit after v0.34.3

### Docs & tests

- docs: the expanded console's size is a DOM attribute, and every rebuild drops it (`f98a82b`)

## v0.34.3 — 2026-10-31 · 1 commit

`f56691a` · the 1 commit after v0.34.2

### Docs & tests

- docs: the stream console's relative write cannot touch a pinned console - measured (`f56691a`)

## v0.34.2 — 2026-10-31 · 2 commits

`a53aaba` · the 2 commits after v0.34.1

### Fixed

- fix: a re-install puts the version gate back into an existing worktree (`a53aaba`)

### Docs & tests

- docs: console popping in slot B — the main console hops, the reasoning box holds (`9628503`)

## v0.34.1 — 2026-10-31 · 9 commits

`31bda32` · the 9 commits after v0.34.0

### Fixed

- fix: re-ordering a row's cards no longer resets their consoles (`6ca7964`)
- fix: a subagent strip repaints for its own children, not the whole board (`fdbec2f`)
- fix: the push guard chains the repository's version gate (`31bda32`)

### Docs & tests

- test: a fifth layout for the gate - two cards of one row swapping places (`34cfbce`)
- docs: measure the console lag - the live board reproduces it, no sandbox does (`5208297`)
- test: a sixth gate layout for two sessions with open subagent consoles (`298e75b`)
- docs: record the console's pops as writes, and rank the callers (`0860d60`)
- docs: the console pops under one agent at 13 a minute, and its tail never holds a minute (`9f0007f`)

### Other

- measure: slot A of the console-popping campaign — the output console sags one frame, the reasoning box never does (`0c1a73e`)

## v0.34.0 — 2026-10-31 · 2 commits

`4ad107f` · the 2 commits after v0.33.2

### Docs & tests

- test: gate console independence in four board layouts (`ac1e119`)

### Other

- chore: 0.34.0 - a console-independence gate in four layouts is a new check (minor) (`4ad107f`)

## v0.33.2 — 2026-10-31 · 2 commits

`bb838f0` · the 2 commits after v0.33.1

### Docs & tests

- docs: map the architecture and the design elements behind it (`bb838f0`)

### Other

- Speed up test suite and consolidate Playwright/panel test harness helpers (`e0c1854`)

## v0.33.1 — 2026-10-31 · 6 commits

`918b44c` · the 6 commits after v0.33.0

### Added

- feat: Thinking text, Skill output and Console text are three settings, and a tool's output waits for the thought before it (#126) (`7cda0b3`)

### Fixed

- fix: a settle's wake is exempt from the hourly budget (#128) (`37b9181`)
- fix: a console is not reset by a re-rank that is not about it (0.33.1) (`8f2a24d`)

### Docs & tests

- test: pin the completion arm of the settle's budget exemption (#129) (`e965d65`)
- docs: record the console scroll hop's fix, and make the harness gate on it (`918b44c`)

### Other

- Add a settings toggle for auto-worktree cleanup, and a release sweep that respects it (#127) (`a2d41c1`)

## v0.33.0 — 2026-10-30 · 1 commit

`e5722e6` · the 1 commit after v0.32.7

### Other

- Each wake threshold folds under the rule that reads it (0.33.0) (#124) (`e5722e6`)

## v0.32.7 — 2026-10-30 · 2 commits

`1b79deb` · the 2 commits after v0.32.6

### Docs & tests

- docs: name the console scroll hop's trigger — reorderProjects re-appending every section on the reorder clock (#125) (`b1613a6`)
- docs: rank every shared write that can reset all consoles at once (#123) (`1b79deb`)

## v0.32.6 — 2026-10-30 · 4 commits

`e1bdb0e` · the 4 commits after v0.32.5

### Fixed

- fix: patch the thinking block, and make a jobline count as liveness (0.32.6) (#122) (`e1bdb0e`)

### Docs & tests

- docs: three architectural reviews (organization, efficiency, functional) (#119) (`8dbef46`)
- docs: reconcile the three jitter investigations, and one test that measures them (#120) (`a7cb1cc`)
- docs: land the three jitter source reports #120 cited but never shipped (#121) (`74edf80`)

## v0.32.5 — 2026-10-30 · 2 commits

`6ccf004` · the 2 commits after v0.32.4

### Other

- Previous turn on send is a three-way setting, not one fold (#114) (`b64642d`)
- Every settings group starts folded, and the panel gains a search box (0.32.5) (#118) (`6ccf004`)

## v0.32.4 — 2026-10-30 · 1 commit

`5528137` · the 1 commit after v0.32.3

### Fixed

- fix: keep the assistant float's corner under the cursor at any page zoom (#113) (`5528137`)

## v0.32.3 — 2026-10-30 · 1 commit

`60e3c5a` · the 1 commit after v0.32.2

### Other

- Stop a plain click on a resize grab from counting as a drag (#112) (`60e3c5a`)

## v0.32.2 — 2026-10-30 · 1 commit

`6b8724a` · the 1 commit after v0.32.1

### Fixed

- fix: hold the reading line in the frame that moved it (#111) (`6b8724a`)

## v0.32.1 — 2026-10-30 · 1 commit

`1cd8616` · the 1 commit after v0.32.0

### Fixed

- fix: a live call joins the burst the next repaint cuts it into (`1cd8616`)

## v0.32.0 — 2026-10-30 · 3 commits

`999706a` · the 3 commits after v0.31.0

### Added

- feat: wake the assistant when a worker's run settles, done or failed (`120a03f`)

### Other

- Give a grown assistant float's room to the open turn's console (`2f97d55`)
- Settings owns the two read-now gestures, and its groups fold (0.32.0) (`999706a`)

## v0.31.0 — 2026-10-30 · 1 commit

`f406a94` · the 1 commit after v0.30.2

### Other

- Stop the assistant float jumping the moment a grab starts (`f406a94`)

## v0.30.2 — 2026-10-30 · 1 commit

`1c4e573` · the 1 commit after v0.30.1

### Docs & tests

- docs: audit the always-loaded skill and name the split that would shrink it (#104) (`1c4e573`)

## v0.30.1 — 2026-10-30 · 1 commit

`6e074ee` · the 1 commit after v0.30.0

### Fixed

- fix: stop the one-stream console being rebuilt under the reader on every poll (`6e074ee`)

## v0.30.0 — 2026-10-30 · 1 commit

`2db77ec` · the 1 commit after v0.29.0

### Other

- Give the assistant float eight resize grabs that track the pointer (#105) (`2db77ec`)

## v0.29.0 — 2026-10-30 · 1 commit

`dad67fc` · the 1 commit after v0.28.0

### Added

- feat: measure the normal console on a real transcript, and gate the wipe (0.29.0) (`dad67fc`)

## v0.28.0 — 2026-10-29 · 3 commits

`4916b6e` · the 3 commits after v0.27.0

### Fixed

- fix: stop the reasoning block collapsing back to a prefix it typed a minute ago (#99) (`24b1ca1`)

### Docs & tests

- docs: measure the reasoning block on a live turn, and gate the empty read (`d452bf5`)

### Other

- chore: 0.28.0 — claim the level the redraw fix and its measurement never moved (#102) (`4916b6e`)

## v0.27.0 — 2026-10-29 · 1 commit

`4b7c1c1` · the 1 commit after v0.26.0

### Other

- Let the reader switch off any worktree-chart column, from config.json (`4b7c1c1`)

## v0.26.0 — 2026-10-29 · 1 commit

`b6c7c67` · the 1 commit after v0.25.0

### Other

- Add New Agent reasoning controls and remove inert YOLO (0.26.0) (`b6c7c67`)

## v0.25.0 — 2026-10-29 · 1 commit

`aea5b9b` · the 1 commit after v0.24.2

### Other

- Give a row a plus that cuts a child worktree from its branch (`aea5b9b`)

## v0.24.2 — 2026-10-29 · 1 commit

`7c3d8cc` · the 1 commit after v0.24.1

### Fixed

- fix: open complete tool output in one box (#91) (`7c3d8cc`)

## v0.24.1 — 2026-10-29 · 1 commit

`2a9e231` · the 1 commit after v0.24.0

### Fixed

- fix: Keep long TODO text inline with its status and actions (#87) (`2a9e231`)

## v0.24.0 — 2026-10-29 · 1 commit

`68864f3` · the 1 commit after v0.23.0

### Other

- Let a tree with nothing to land be released (0.24.0) (`68864f3`)

## v0.23.0 — 2026-10-29 · 1 commit

`6842c67` · the 1 commit after v0.22.0

### Other

- Give a row a ⟳ that reconciles it: its TODO against its own commits, its description against its own work (#86) (`6842c67`)

## v0.22.0 — 2026-10-29 · 2 commits

`fdc13c4` · the 2 commits after v0.21.0

### Other

- Pin the once-only tree rename with the three cases the rule names (`2f3c323`)
- Let a worker ask the panel to release its own worktree (`fdc13c4`)

## v0.21.0 — 2026-10-29 · 1 commit

`24d61aa` · the 1 commit after v0.20.0

### Other

- Fold every tool result into one collapsible box (0.21.0) (`24d61aa`)

## v0.20.0 — 2026-10-29 · 1 commit

`9fa7bb1` · the 1 commit after v0.19.1

### Other

- Give the UNMERGED chip a rebase that catches a child up to its parent (`9fa7bb1`)

## v0.19.1 — 2026-10-29 · 1 commit

`d431859` · the 1 commit after v0.19.0

### Other

- Stop tracking the brief: remove PROMPT.md and ignore it (#81) (`d431859`)

## v0.19.0 — 2026-10-29 · 1 commit

`3958b37` · the 1 commit after v0.18.0

### Other

- Close the four console-repaint gaps the flicker tree left open (#80) (`3958b37`)

## v0.18.0 — 2026-10-29 · 2 commits

`81496d9` · the 2 commits after v0.17.0

### Other

- Land local main's unpushed work: data directory, console flicker fix, lane A and B harnesses (`d63971f`)
- Ahead / Behind counts the branch against its own copy on the remote (`81496d9`)

## v0.17.0 — 2026-10-28 · 1 commit

`b396481` · the 1 commit after v0.16.0

### Other

- Draw an unverified branch in its own word, quoting the project's fetch note (#77) (`b396481`)

## v0.16.0 — 2026-10-28 · 3 commits

`7ebf077` · the 3 commits after v0.15.1

### Other

- Reasoning types out too, on the same words/s the prose uses (`c5a040f`)
- A trimmed burst stays a group, keyed by its own call line (`6fd22cf`)
- Pin the branch and PR cells, and give the harnesses one bootstrap and one runner (#76) (`7ebf077`)

## v0.15.1 — 2026-10-28 · 3 commits

`2bda568` · the 3 commits after v0.15.0

### Fixed

- fix: hold a LANDED answer until the board has re-adopted its tree (`7d888ce`)

### Docs & tests

- test: prove the sweep acts on a settled LANDED: YES card, and on nothing else (`eb3b6dc`)
- docs: enumerate every guard between a local branch and the remote (`2bda568`)

## v0.15.0 — 2026-10-28 · 1 commit

`df7513e` · the 1 commit after v0.14.0

### Other

- Let the console fill in at a reading pace: words typed out, lines walking in (`df7513e`)

## v0.14.0 — 2026-10-27 · 2 commits

`30a51bb` · the 2 commits after v0.13.0

### Added

- feat: check a row against main with an agent, and recycle the tree when it is landed (`2466ca9`)

### Other

- chore: bump to 0.14.0 for the checked landing (`30a51bb`)

## v0.13.0 — 2026-10-27 · 1 commit

`1a24139` · the 1 commit after v0.12.1

### Other

- Draw a card as ONE stream: reasoning, calls and their output in the order they happened (`1a24139`)

## v0.12.1 — 2026-10-27 · 1 commit

`c0b46d2` · the 1 commit after v0.12.0

### Fixed

- fix: draw the local chip from the remote's answer, and re-read a row whose branch moved (#72) (`c0b46d2`)

## v0.12.0 — 2026-10-27 · 1 commit

`692c362` · the 1 commit after v0.11.2

### Other

- Integration: spawn cards, the shared model picker, the command audit and the steward (`692c362`)

## v0.11.2 — 2026-10-27 · 3 commits

`d8ae753` · the 3 commits after v0.11.1

### Fixed

- fix: write off a card the gateway answers unknown for, on evidence (`3293b6c`)
- fix: key the quiet alert on the run's own silence, not on the clock (`643e39c`)

### Other

- Bump to 0.11.2 for the unknown write-off and the quiet alert — patch (`d8ae753`)

## v0.11.1 — 2026-10-26 · 2 commits

`f27a5b1` · the 2 commits after v0.11.0

### Fixed

- fix: read a RESTART line out of the prose that quotes it (`c0e5069`)

### Other

- Bump to 0.11.1 for the RESTART line the harvest dropped — patch (`f27a5b1`)

## v0.11.0 — 2026-10-26 · 1 commit

`814755b` · the 1 commit after v0.10.3

### Other

- Give the panel a spawn watchdog so a card nobody starts is named (#67) (`814755b`)

## v0.10.3 — 2026-10-26 · 2 commits

`27da6be` · the 2 commits after v0.10.2

### Other

- Stop the leftover alert firing on a tree a live run holds (`4316783`)
- Bump to 0.10.3 for the leftover alert that fired on a held tree — patch (`27da6be`)

## v0.10.2 — 2026-10-26 · 2 commits

`df5905e` · the 2 commits after v0.10.1

### Other

- Attach the fold note's button on the reload path, and name the row it fetches (`4f7e00c`)
- Bump to 0.10.2 for the fold note's clickable reload path — patch (`df5905e`)

## v0.10.1 — 2026-10-26 · 2 commits

`4410d38` · the 2 commits after v0.10.0

### Other

- Define the push guard's allow_push above its first call, so the env grant bypasses (`d18aba2`)
- Bump to 0.10.1 for the push guard's bypass — patch (`4410d38`)

## v0.10.0 — 2026-10-26 · 2 commits

`5697d08` · the 2 commits after v0.9.0

### Other

- Hide the console window on every child the panel starts (`c7170a0`)
- Bump to 0.10.0 for the child-process audit gate — minor (`5697d08`)

## v0.9.0 — 2026-10-26 · 3 commits

`999289a` · the 3 commits after v0.8.1

### Other

- Rows: stack each TODO item's facts as indented bullets under its line (#61) (`4156a1a`)
- Give the assistant float a real fullscreen mode, and a composer that cannot be clipped (`3d4203d`)
- Bump version to 0.9.0 — minor: a new reader-facing affordance (`999289a`)

## v0.8.1 — 2026-10-26 · 2 commits

`8b4b1f0` · the 2 commits after v0.8.0

### Docs & tests

- docs: SETUP prerequisites now match what the machine measures (`0d8b38d`)

### Other

- Bump to 0.8.1 for the SETUP prerequisites — patch (`8b4b1f0`)

## v0.8.0 — 2026-10-26 · 13 commits

`0c8bba6` · the 13 commits after v0.7.1

### Docs & tests

- docs: index the review's findings per phase, with one checklist each (`a14aada`)
- test: npm test runs node:test, and boots the real server to assert routes (`fff8ef6`)
- docs: mark phase 0 landed, with the counts the suite printed (`cc76cad`)
- test: give the sandbox its own discovery cache, so the real one is not swept (`321be15`)
- docs: record the running-board check and the blank-page A/B (`284ee2d`)
- docs: the harness cache leak belongs in the phase record (`8afb068`)
- test: scope npm test to test/*.test.js, so a nested worktree is not scanned (`ca15de5`)
- test: aim the auth assertions at the boundary main now draws (`7ea9e08`)

### Other

- auth: /api/refresh, /api/visible, /api/fetch and /api/reload now fail closed (`6571e44`)
- open-url: drop cmd.exe from the opener, so a query string is not a command (`5c1a80f`)
- engines: require Node 22.5 in every place that advertises a floor (`210b027`)
- errors: a fault answers 500 and is logged, and the state.db failure is named (`8d98e61`)
- Bump to 0.8.0 for the test harness and the honest error contract — minor (`0c8bba6`)

## v0.7.1 — 2026-10-26 · 2 commits

`e8acc27` · the 2 commits after v0.7.0

### Other

- Keep the space the reader typed when a repaint rewrites the box (`7a8d2a7`)
- Bump to 0.7.1 for a fix: the repaint no longer eats a typed space (`e8acc27`)

## v0.7.0 — 2026-10-26 · 2 commits

`78e2145` · the 2 commits after v0.6.0

### Other

- Give the assistant an aggressive switch that hands your settings back (`8ad8307`)
- Bump to 0.7.0 for the aggressive switch, a new capability (`78e2145`)

## v0.6.0 — 2026-10-26 · 1 commit

`8ebc0f5` · the 1 commit after v0.5.0

### Added

- feat: give every worktree a TODO list its agents keep, and show the oldest open item (`8ebc0f5`)

## v0.5.0 — 2026-10-26 · 1 commit

`4480cf2` · the 1 commit after v0.4.0

### Other

- Stream the whole tool result, and let the panel's fold open on a click (#57) (`4480cf2`)

## v0.4.0 — 2026-10-26 · 3 commits

`3470b18` · the 3 commits after v0.3.0

### Other

- Show what each session has spent, in tokens and in dollars (`6060c03`)
- Prove the counts hold at a narrow window, and derive the anchor a compaction leaves (`b06e555`)
- Link the branch column to the remote, and default every new worktree to local only (`3470b18`)

## v0.3.0 — 2026-10-26 · 68 commits

`c60805d` · the 68 commits after v0.2.0

### Added

- feat(version): advise, gate and write the version bump, and refuse a push without one (`320dd59`)

### Other

- Refuse a commit subject that names no symptom, and prune branches by PR state (#13) (`d853cdb`)
- Make the commit-msg hook executable in the index so a non-Windows clone runs it (#14) (`4c3152c`)
- Give the assistant a charter file the panel injects every turn (`41774c8`)
- Add a Charter tab beside Scratchpad that reads and edits the file (`785ef52`)
- Prove the charter's seed, injection, writers and routes (`095f3ca`)
- Leave the seeded charter room to keep taking entries (`ea68fdf`)
- Name a worktree once, and offer a name read from the work (#17) (`ca5d252`)
- Let the board bind every interface by default, so a LAN browser can reach it (`881ef2e`)
- Show what each branch was started to do above its merge state (#20) (`a93fefc`)
- Hold worktrees whose last activity is older than N days out of the chart (#21) (`ae82c3f`)
- Keep the chart's show-all choice across a reload, not only in localStorage (#22) (`8b401e3`)
- Put the chart's age collapse under a browser proof, reload included (#23) (`598de3a`)
- Open the assistant float with a bare A, and pin it open against the press that dismisses (`ae528c7`)
- Tell a run to ask in prose when the gateway build cannot deliver a clarify question (`e0b2ee0`)
- Re-attach a restored run the gateway still has instead of writing it off (#27) (`25dd9d3`)
- Give an interrupted card whose run may still be live its own re-attach chip (#28) (`154f8c4`)
- Pick a detached card up from the not-running pill, not a chip of its own (#29) (`a095251`)
- Stop the source calling the pill a NOT-RUNNABLE chip (#30) (`6f5f0f8`)
- Find a row's PR by the tree's tag when the panel renamed its branch (#31) (`01edc20`)
- Stop a branch that only tracks main being given a fork's PR (#32) (`e8c668f`)
- Refuse a reply into a worker that is already turning (#33) (`12dac86`)
- Read the gateway's own clarify flag, and name the local patch as the fix (`2b4d88f`)
- Move the board's pure format helpers out of app.js into core/dom-format.js (`3fa9811`)
- Move the attachment chips and their drop listeners out of app.js (`7f577e7`)
- Move the NOT-RUNNING rotation out of app.js into board/hot.js (`7afec91`)
- Move the panel's HTTP calls and its token out of app.js (`d6fcd08`)
- Move the SSE stream and its thirteen handlers out of app.js (`8df2b56`)
- Fold the second tool-result unwrapper into tool-text, and drop the dead dropRow (`81946cb`)
- Move the assistant's knobs, rule table and sanitisers into lib/assistant/config.js (`80ac7d2`)
- Move reading a turn into lib/assistant/read.js (`8334eef`)
- Move the three judgements that turn prose into an alert into lib/assistant/match.js (`d64d617`)
- Move the action-line grammar into lib/assistant/actions.js, written once (`36e5245`)
- Move assistant.json's file IO into lib/assistant/store-file.js (`f3bc509`)
- End the new assistant modules on one CRLF, not a stray CR (`50c6fda`)
- Move the charter file's IO into lib/assistant/charter-file.js (`e4733f4`)
- Stop the assistant's state() from pruning the wake list while it reads (`5828f43`)
- Put a model's price and coding rating beside it in the picker (`21030ac`)
- Make the description strip a bullet list, folded on expand (#38) (`a5628a8`)
- Queue a reply on Ctrl+Enter, the same press the Queue reply button makes (#39) (`61662e9`)
- Restore the merge state detail: every commit listed, file lists folded (#40) (`4597bd0`)
- Swap the reply box's gestures: Ctrl+Enter steers, Enter holds the reply (#42) (`f893497`)
- Draw a diff as a framed two-sided window and a file body as a folded code box (#43) (`26aec76`)
- Let a queued reply be taken back with a × on its own entry (`ab2b51f`)
- Edit a held reply in place, and hold it while it is being edited (`decbdbc`)
- Let a reader lift a console or thinking block with a hover copy button (`57ee79d`)
- Collapse a big paste into one inline chip the reader can quote, unfold and delete (`11552c7`)
- Prove the paste chip in a real browser, and point the two key suites at its reader (`d841d0d`)
- Read the reply box through readBox where the queued-reply cancel needs its text (`70cc7d0`)
- Read the reply box through readBox in the held-reply editor's own suite (`354b201`)
- Show COMPLETE on a finished card, and queue one ask instead of nudging it (`2d1077d`)
- Find the pre-change build by content, not by HEAD~1 (`d465542`)
- Show the assistant's message board in a tab, so what it sent and got back is readable (`5eca573`)
- Say where a tool result is cut, and what raises the cap (`ec2d993`)
- Hold a 429 turn for a run slot instead of failing it (`45d5317`)
- Say "waiting for a slot" on a held turn instead of "FAILED" (`de6dfb9`)
- Prove the 429 hold against a stand-in gateway and a real browser (`1780d51`)
- Put a console diff's real lines in its frame, new side first, and let a call fold (`bdff6db`)
- Give hermesHome its own module, so reading the config stops reaching into the run supervisor (`5f051cd`)
- Move the HTTP layer out of server.js, and hand it the two things it read by closure (`82b1e07`)
- Ask the spawn question in one place instead of three, and stop deriving the owner path twice (`fc4ff03`)
- Move the description harvest out of server.js, and give it the two stores it walks (`ca4dd7e`)
- Lift the event-to-console translator into its own module, with the tree-measuring helpers it shares (`d0c0d15`)
- Read the Hermes session store from the one home, not from a third copy of hermesHome (`6525df3`)
- Refuse an unborn-HEAD spawn through the assistant too, not only through the card (`7a47a99`)
- Rank rows, projects and agent cards by a sliding average of liveness events (`304e429`)
- Keep a row's card ranking when its cards are momentarily gone (`62cf9e0`)
- chore(version): bump to 0.3.0, a new gate that breaks nothing (`c60805d`)

## v0.2.0 — 2026-10-23 · 341 commits

`861652e` · the 341 commits after v0.1.0

### Other

- Fix the name: agent-wroktree-gui -> agent-worktree-gui (`4331c3b`)
- Add agent-executable setup: SETUP.md, setup.cmd / setup.sh (`cd45a9c`)
- Skip configured projects that are not on this machine (`fb49c2b`)
- Spawn an agent into an existing worktree, and run a second instance (`dd492eb`)
- Show the panel's own agents on the worktree rows, and jump from row to agent (`7669563`)
- Share in-flight liveness probes and stop overlapping passes (`1d2d99f`)
- Add a Docker front door and the plan for local containerisation (`5af990e`)
- Add a hermes worktree-audit discovery engine, opt-in, plus /api/cleanup (`7e93716`)
- Group projects in a folder accordion, with a sibling folder for strays (`bfb4d66`)
- Add docker/redeploy.cmd: restart the panel and recreate the front door (`e5e0489`)
- Drop projects the server no longer reports, and count the live ones (`6c0e135`)
- Folder header: collapse-all button and a clone box (`96bdc09`)
- Serve agent approval prompts in the panel (`c4df33c`)
- Life column: time since we last saw this worktree alive, plus a ring to the next read (`3ca0fd0`)
- Make the next-read ring tell the truth, and give the scheduler room to keep it (`103ded6`)
- Boot the board without fetching, and read projects in parallel (`48ca193`)
- Count the boot pass as a read, and widen the coasting cadences to fit the pool (`7d9b354`)
- Fold each agent turn to its request line, and make a running turn show up in the rows (`3d6ebb8`)
- Give the page its own zoom, paint live/agent chips violet, and order rows by what is happening (`06ab52b`)
- Front-end + scan efficiency: fewer git spawns, less DOM, gzip, and a quiet client (`70f0803`)
- Collapse the New agent and Agents cards from their title rows (`ddcd433`)
- Pull one chat out to fill the window, and stay on the newest output (`fcac95f`)
- Place Hermes sessions by what they are working on, not where they started (`f59c1a3`)
- Clear one agent session from its card (`405e962`)
- Life and its next-read ring share one line (`ba7ce34`)
- Sending a reply folds the turn you were reading (`700a73e`)
- Unfold the card you just aimed at (`466d7bb`)
- Agents belong to a worktree; the panel now says which (`d49003f`)
- Attach an unattached agent to a worktree, and colour the status words (`e019ea9`)
- Attach where the agent already is, and only ask when that is not obvious (`aa77a56`)
- Mark every agent row with the panel's ⧉ glyph (`ce668e0`)
- Keep the reader's place while an agent is running (`ead2909`)
- Paint the project's panel-agent chip violet, with the ⧉ mark (`ef73237`)
- Project panel-agent chip: violet while working, amber when everything is idle (`00bf525`)
- Stop losing live sessions that never write last_activity_at (`57571fa`)
- Collapse all: one button for the whole board, left of Pause (`c86ee6d`)
- Each folder can show all its projects, or only the ones touched this week (`44e3fd9`)
- Collapse all folds the folders too, and moves left of Refresh now (`4bf96c5`)
- Rank projects by what is happening, and only freeze the folder being read (`02e8ed5`)
- Attach agents the moment they exist, and stop losing ownership on restart (`00c7a71`)
- Fold a worktree's git/commit/diff detail into one accordion line (`ff3407d`)
- Stop the board flashing "no git repos found" for the first minute after a start (`ac93a50`)
- No control inside an agent's head row may fold the card (`2b70a87`)
- Attach unfolds a minimized card before showing its picker (`677fc0e`)
- Settings: let the panel wear a different interface font (`a76a40b`)
- Two font settings: the panel's text and the terminal's text (`413b6c8`)
- Settings is reachable three ways: gear, Ctrl+, and the title (`d41975f`)
- Spawn takes you to the agent: unfold its folder, project and row, then scroll to it (`2e55532`)
- Page a conversation's turns five at a time (`4098172`)
- Star a turn to keep it above the paged turns (`6e418ed`)
- Fold the liveness evidence, keeping its strongest line in view (`3b9d297`)
- Make the pin star half again as big (`79212bf`)
- Tab the expanded git and liveness detail under their headers (`0b9fab7`)
- Keep the pin star under the pointer when a turn is pinned (`79ce8c1`)
- Put Send reply inside the reply box, bottom left (`72b2edc`)
- Lift Send reply off the input's bottom border (`c2b3c69`)
- Rename a session from its row (`ba676a0`)
- Double every accordion chevron (`03e9dc7`)
- Give the merge-state accordion a heading of its own (`c9018b1`)
- Flash what moved when the board reorders itself (`58e44dd`)
- Re-rank the folders in real time, and check them every 5s when they are closed (`61be090`)
- Stop the periodic row repaint from wiping a reply being typed (`0f7ffaf`)
- Flash rows and projects that move during a rebuild, not just an in-place sort (`2bf7ce4`)
- Keep an open console's scroll when its project is folded and unfolded (`3b0e4f3`)
- Make the project flash visible: light the title row too (`efb72b5`)
- Freeze only the open projects, not the whole folder (`b458e5b`)
- Flash only what moves up, not what gets pushed down (`d5d1927`)
- Fill the next-read ring instead of draining it, and make it a one-row refresh (`ff98366`)
- Tell password managers to leave the panel's inputs alone (`b05458f`)
- Put the expand/exit control to the right of the rename button (`5ac6264`)
- Keep the caret in the reply box after sending (`22b51e2`)
- Enter in the New agent prompt spawns (`35863ef`)
- Shift+Enter inserts a newline in the message boxes (`fff7a3c`)
- Make Collapse all fold the New agent and Unattached agents cards (`8393e64`)
- Hold the row you clicked still while its accordion opens (`ac0c994`)
- Let a pinned turn open and close on its own (`f3809ba`)
- Make URLs in agent output clickable, opened by the panel (`79f1290`)
- Show what each tool actually did in the agent console (`89504c6`)
- Up/Down in a reply box walk the thread's previous prompts (`328ed8a`)
- Make ✕ the rightmost of the agent row's controls (`a7968de`)
- Move Cancel turn into the reply box, right of Send reply (`0955faf`)
- Stop the pin star flickering while a turn runs (`e786f2f`)
- Queue a reply while a turn is still running (`572ebb1`)
- Enter queues while a turn runs, and queued replies say what and how long (`1840e20`)
- Draw queued replies as ghost turns, and show which build is running (`af92118`)
- Record what the Runs API actually does, probed against a live gateway (`7eba1fd`)
- Run agents through the gateway's Runs API, and let a reply steer the live turn (`65cc079`)
- Answer a run's approval from its card (`74a095e`)
- Put the approval prompt under the turn's own output, and collapse it once answered (`f13049e`)
- Make steering the primary reply action while a turn runs (`ade06bd`)
- Make the run's approval reach the card, and stop dropping a late steer (`0705e5f`)
- Mark the approval-transport doc superseded, with the exact retirement commands (`cc54f34`)
- Drop the embedded repo accidentally staged with the doc commit (`9139624`)
- Record the gated-first-call cwd defect with its reproduction (`5e791ac`)
- Set the run's cwd for the agent's context too, not just for its tools (`065a3b0`)
- Describe the runs transport in the docs, and stop advertising knobs it cannot honour (`f95a0b3`)
- Walk the New-agent prompt history with Up/Down, and clear it once it spawns (`f84c904`)
- Let the prompt line fold a turn as well as unfold it (`8f1e16a`)
- Show an approval the moment it is asked, not 20 seconds later (`02712b4`)
- Put a live clock on the tool call that is still running (`1eb139b`)
- Stop printing "exit 0" for something that never exited (`1b3bb62`)
- List the files an agent produced, with a button that opens or copies them (`fe28aae`)
- Land on the agent a spawn just created, caret in its reply box (`74b3eba`)
- Draw a tool result as text, and say when the gateway cut it (`f71cbf7`)
- Drop an approval box once its turn is over (`be74b46`)
- Stop the background sweeps from making the panel feel hung (`e7235e5`)
- Make the deliverables list say what it is: name, copy, delete — files and URLs together (`ff919b0`)
- Let a worktree be removed from its row, with the files recoverable (`743b072`)
- Keep a parked approval visible when its worktree row is collapsed (`cc8df62`)
- Make the gateway's approval window a setting in the panel (`ff25387`)
- Let a row bring back a session the board has no card for (`3ee4ca2`)
- Draw the turn's usage above the reply box (`622c5d2`)
- Pick the run's model from the gateway's own list (`58a240e`)
- Make the CLI's session-list length a setting, and say what the store really holds (`3297e77`)
- Put the usage strip on the footer line, to the right of the outcome (`0410cd6`)
- Say plainly when a settings save was rejected, and keep what was typed (`aae6870`)
- Only adopt the files a turn could have written (`91def43`)
- Call a failed turn EXITED on its pill, and keep NOT-RUNNING for the rest (`823efc4`)
- Scroll the New-agent card clear of the sticky top bar (`3be1f24`)
- Lead each tool call with its emoji, the way the CLI prints one (`ffe592c`)
- Give every panel request a deadline, and recover a spawn whose reply was lost (`44bf9f4`)
- Read the usage strip out of the store, so it stops being empty (`9ef8709`)
- Draw the context meter with a partial block instead of a dotted hatch (`bb368b9`)
- Bind Ctrl+[ and Ctrl+] to collapse and expand the whole board (`1e6eb8a`)
- Show the compaction count on the usage strip (`d0848b3`)
- Paste or drop a document into a prompt and hand the agent its path (`d3af9cd`)
- Lead a session row with its revive button, in the status column (`3def20f`)
- Make the console resizable, and show pasted documents as chips (`3f01a0a`)
- Drop the sessions heading, and put the last-used time beside revive (`56298a3`)
- Flash grey when a refresh finds nothing, and sort closed rows around an open one (`c493d1f`)
- Collapse all the way down to the turns (`52c31b9`)
- Link attachments to their file, and list them with the turn they went to (`337edb5`)
- Make a revivable session row look like an agent head, one level down (`72c3bd5`)
- Stop a bookkeeping total from counting as an agent moving (`e6447ab`)
- Offer the one-click fix when a spawn refuses an unborn HEAD (`39a1165`)
- Delete a worktree's row even when its folder is already gone (`0b35ca2`)
- Make a fire-and-forget delete look like it registered, and wait for the scan (`9bb542f`)
- Stop the main row pulsing for work that happened in a worktree below it (`dc73041`)
- Scroll to the spawn card when the play button is clicked, not back to the row (`aa5b97a`)
- Hold an open project's place through a rebuild, and its folder's place too (`df75c1a`)
- Give a running turn the same stats strip as a settled one (`4b7730a`)
- Put a revivable session's last-used time next to its revive button (`1acc4b1`)
- Make the board's reorder cadence a setting (`c1fb31e`)
- Offer the one-click first commit where the reader is actually blocked (`2069658`)
- Make the project's panel-agent chip violet in both states (`afc45ca`)
- Make the panel-agent chip a lighter purple than the live chip (`ec1e676`)
- Give the purple chips one job each (`3bbce77`)
- Make a minimized turn two lines: the request, then what it is doing or concluded (`15408cd`)
- Say "hermes" on the row chip, and explain it in the tooltip (`d08fc98`)
- Give the project's panel chip the running count the row badge has (`14088ea`)
- Split the project's agent counts: light panels, dark hermes (`897ff7d`)
- Let the panels chip jump to the agent that is running (`e8bc948`)
- Only exclude sessions the panel actually ran from hermes evidence (`93dc160`)
- List the external sessions' titles under the hermes chip's tooltip (`90fda48`)
- Make the quiet panel chip a link too, to the project's top agent (`e232363`)
- Put the agents above the merge state and liveness evidence in a worktree's detail (`b3c3b75`)
- Give the board a tree rail so a worktree row reads as a child of its project (`4afc4fe`)
- Keep the run's bookkeeping out of the console (`4ee65d6`)
- Let a minimized agent card be expanded by clicking anywhere on it (`aa4586e`)
- Close the last agent card with a line instead of letting it fade out (`d8aa3c6`)
- Move the agents section rule below the list instead of above it (`c3e7e4e`)
- Stop rows reordering when a refresh found nothing (`6a16ec1`)
- Drop the "Agents n" heading and pull the cards up under their row (`c13954a`)
- Show a card's session name instead of its cwd, and move the run id to the end (`e83fce2`)
- Put the usage readout under the reply box, not above it (`1b837f2`)
- Set the card's session name like the revive row: bold, with its age beside it (`5f54622`)
- Move the New agent explanations into their tooltips (`7b25988`)
- Remove the Preview request button and its command box from New agent (`11b42cf`)
- Collapse the empty message lines at the bottom of New agent (`0ea471f`)
- Make a worktree row give up its name and branch, and nothing else (`6cf4684`)
- Invert the spawn form's worktree switch: "create workspace", ticked by default (`e733f2e`)
- Drop the duplicate running clock, and put the usage strip under the box with the model first (`0747c26`)
- Give the console its own size and weight, and stop styling what the human typed with them (`8f85c6c`)
- Put Cancel before Delete in the destructive confirmations (`8ff2455`)
- Make the worktree table fit its card, so the revive row's session id is not cut off (`89ea122`)
- Close the gap under the reply box and the usage strip (`b571661`)
- Hang the turns off a rail under the card's title (`4b4a303`)
- Put half the space back under the usage strip (`fa5bd22`)
- Lead the worktree block with merge state and liveness again, folded to two strips (`5e68d09`)
- Use a double-down arrow for the compaction count (`71f13cb`)
- Give merge state a real list, and drop the summary into it when it opens (`ca231b8`)
- Offer a retry only where retrying is honest (`5f747c0`)
- Add a Grey flash switch to Settings (`ebff2df`)
- Ctrl+wheel over a console resizes its text, like a terminal (`6cef648`)
- Keep the delete confirmation's buttons inside the card (`38fc2f0`)
- Block the page zoom while Ctrl+wheel is resizing a console (`d178362`)
- Add Hot Agent: a rotation through the agents waiting on you (`a26759a`)
- Flash the whole hot card amber, not just its reply box (`ae2d2da`)
- Keep the turn's request on its title line when the turn is open (`7f046d6`)
- Drop the open-idle chip, and make the hermes chip read like the panel one (`a9c3593`)
- Move the page-zoom control from the top bar into Settings (`c491fdd`)
- Put Spawn agent on the left of its row, and the project picker beside "start in" (`d4c1162`)
- Make Hot Agent open the path it needs after Collapse all (`d9c7261`)
- Answer a revive 409 by showing the card that already exists (`a266d7a`)
- Translate the gateway's 409 permission_denied into advice (`88e5039`)
- Add a Panel contrast slider to Settings (`c7c7149`)
- Show a run's subagents under its card (`e9fe376`)
- Give the session panel its own layer in the contrast scale (`4a7ebf1`)
- Report subagent status from the store, because the stream cannot (`38efb61`)
- Put the subagent strip under the console of the turn that spawned them (`b1d58d2`)
- Hand a missed steer back as a draft instead of starting a turn (`1a1f89d`)
- Drop the leading -- from the yolo chip (`d19c801`)
- Give the worktree chart the same buffer on the right as on the left (`ac5a6b9`)
- Put the last-used counter next to the state pill (`46b7b4f`)
- Keep RUNNING while subagents are out, and let a subagent line open its console (`fea3155`)
- Keep finished subagents on the card, greyed and collapsible (`a2f0150`)
- Let a session's name reach a card created here (`9b64a71`)
- Keep every console at its newest line unless the reader moves it (`95ce679`)
- Show what an agent thought, per session, with a default in Settings (`d09f27a`)
- Condense a run of tool calls into one row per tool (`f795057`)
- Add a reasoning button: the live reasoning, as Hermes' own show_reasoning does (`3293b8f`)
- Make a tool tally open that tool's calls, not just everything (`e5ba457`)
- Fold the live reasoning into the thinking block (`9dfca21`)
- Keep a subagent tally with the turn that delegated it (`502c2f0`)
- A worktree's play button also selects its project (`4da0c75`)
- Make sure a parent gets its subagents' results, and watch the children while they run (`bf14579`)
- Say which subagents produced a turn, and collect each turn only once (`b060b18`)
- Make the thinking block follow its own newest line (`7ae0e64`)
- Give a subagent's console the same condensing, and unwrap its tool results (`37a0e4a`)
- Let a card pick its model, and keep the console still while it runs (`686bac4`)
- Put the context window on the card, and let the reader set the ceiling it measures against (`826d7f0`)
- Say what a running subagent is doing, on its folded row (`6da1c0e`)
- Walk only the reader's own prompts up from a reply box (`092a633`)
- Keep the thinking block and an open picker where the reader put them (`fc74499`)
- Let an approval actually be clickable while its run keeps emitting events (`2876cf4`)
- Put a running subagent's clock beside its status, and float approvals bottom-right (`b21975e`)
- Keep a worktree's agents on screen when the table re-ranks (`a772d65`)
- Hold a reply for the subagents a thread still has out, and queue a steer the run refuses (`6bd2b2d`)
- Clear the reply box that is on the page after a send, not the one the send started with (`f08624a`)
- Give the worktree and branch columns the room the life column was wasting (`3d9f280`)
- Send the execution generation with an approval, so the gateway stops answering invalid_params (`e2eb6fc`)
- Count an agent parked on an approval as running (`120d270`)
- Name the pending prompt, not just the generation, when answering an approval (`34c901a`)
- Read URLs from the console, not just prose, and give files and links a button each (`15b203c`)
- Make the context size a one-click ladder (`92f735c`)
- Settings: a scrolling body, grouped rows, and the prose behind tooltips (`400da08`)
- Add the OpenRouter endpoint and key to Settings (`a83e459`)
- Keep the model picker against the label it belongs to (`c4427f0`)
- Put the working directory in the prompt, because the Runs API has no cwd field (`6e69bba`)
- Give each project folder a search box in its header (`b48fb3c`)
- Say when an agent is in the project checkout rather than a worktree (`7727263`)
- Keep one row, one detail and one card per agent — and hold the reader's place across a rebuild (`2a13dbe`)
- Hold the reader's place while cards above them grow — and a pin to choose the card (`0499bb4`)
- Stop a repaint from pulling the page back to the caret, and end the spawn follow on any scroll (`ebcee3d`)
- Make the spawn jump deliberate in both directions, once each (`f2138d5`)
- Grow the reply box with its draft, a line at a time, above the buttons (`da80b48`)
- Hold the composer still when a turn folds, and fold to a summary instead of a one-liner (`4d5ca4d`)
- Stop the board from following a promoted row - and keep the open detail on its row (`92b317b`)
- Turn token counts in three significant digits: 636816 reads 636k tok (`164aeab`)
- Make every scrollbar part of the dark surface instead of the platform's white rail (`06d459e`)
- Stop the five-minute full pass from starting every project at once (`04516e3`)
- One row, one detail: stop the duplicated MERGE STATE / LIVENESS block (`ee7785a`)
- Ctrl+click a project's title row to theme that project box (`756a3e1`)
- A reset-colours button in Settings > Display (`dd2224b`)
- Keep the usage readout copyable while it streams, and out of the buttons' highlight (`73bf6e5`)
- Rename the Hot Agent button to NOT-RUNNING (`980fff4`)
- Hold a card's selection across a board repaint (`8b904d8`)
- Let the pointer and the last touched card choose the anchor (`f822076`)
- Two anchor signals, each with its own switch and window in Settings > Board (`b577b82`)
- Make the flash time a setting (`d01ad9b`)
- Hold the reader's selection through a card rebuild, by offsets not ranges (`1fb04a2`)
- A "to the newest line" chip on the console and on the thinking body (`e25901a`)
- Show the tool output the live stream never carried (`936400e`)
- Make every flash obey the setting - and make a themed project flash at all (`a6d8e63`)
- Centre the "to the newest line" chip, and let Ctrl+wheel size the thinking text (`4fb71b8`)
- Discovery stops re-reading every repo with git (`8bd7347`)
- Anchor follows the click, and only one owner corrects a gesture (`5626dd1`)
- Whatever the click landed on becomes the anchor, at once (`7429b49`)
- The tool condenser keeps the block you opened open (`cca91ac`)
- Answer the agent's own questions on the card, not in the console (`811ad47`)
- An event about a worktree is a sign of life (`a338986`)
- Refresh everything, or only the projects on screen (`d6a2cb0`)
- List the calls behind a "+ N commands" summary (`af42366`)
- A stopped card carries a one-click "continue" (`24a5f37`)
- A project flash is its edge and its header, not the whole panel (`3d825a8`)
- The worktree ▶ probes its stopped agents; a green + bar adds one (`2e39e0e`)
- A project flashes only while it is collapsed (`6529187`)
- Tool output crosses the wire as text, not as JSON (`58d46cb`)
- Put the add-agent bar's green on a scale in Settings (`e87024a`)
- The not-running pill is the continue button (`ea0d225`)
- A minimized card says how its last turn ended (`9ceab0d`)
- The + bar becomes a field in place; Enter starts the run from there (`77be022`)
- Settings for the question box, and a centred column for it (`df048b6`)
- A subagent chip belongs to the turn that started it, not the card's first turn (`9234669`)
- Stop the board's rebuilds from clamping the reader to the top (`93d9c68`)
- Document the board page: every control, chip and gesture (`798011c`)
- Document the Refresh setting: everything, or only on screen (`0690f2a`)
- Document the controls the board gained since the guide was written (`68d345d`)
- Keep the caret through a project repaint (`fd505ba`)
- Give the question box the console's width, and make the width a setting (`4b9634f`)
- The add-agent bar's position is a setting (`0607663`)
- A countdown bar on the question box (`5943ada`)
- A re-rank must not end the sentence in the open row (`f0b8719`)
- Bracket every DOM move so a moving field keeps its caret (`d01f513`)
- Keep the delete confirmation under its own row (`c87ab50`)
- Add an assistant panel: a sentry over the board, and one thread to talk to (`e171411`)
- Let the assistant cut worktrees and start workers (`3847733`)
- Put a live countdown and a draining bar on every watch deadline (`92fa93e`)
- Wake the assistant at a watch's deadline, not just raise an alert (`d53e024`)
- Notice a finished worker's leftover tree, and a delegated child that goes quiet (`0262c6e`)
- Only uncommitted work counts as leftover work (`6b8cf3a`)
- Catch the same failure coming back turn after turn (`ba0a1f8`)
- Answer a worker's parked clarify question from the assistant panel (`d9b4a7e`)
- Resolve a SPAWN project name on the auto path (`f69df55`)
- Let the assistant card fill the float when it is resized (`65c5377`)
- Pin the assistant composer to the foot of the float (`8620e6b`)
- Supervise the sentry from the server, and resume a turn a restart cut in half (`a52fb32`)
- Add "Stabilize reordering": a list freezes while something in it is open (`1f2d511`)
- Give the assistant a working directory of its own, as a setting (`6c08e9a`)
- Let the assistant write its own standing rules (`3c0aae5`)
- Stop blaming a worker for the reader's working copy (`65b68d0`)
- Delete the folder, not only git's record of it (`84228e6`)
- Drop a row that is no longer a worktree on the first discovery pass (`d493461`)
- Name a worktree after the agent, not after the sentence that cut it (`304d7aa`)
- Stagger the next-read rings across each cadence tier (`e87e7de`)
- Delete a merged, clean worktree without asking — and keep it deleted (`384960c`)
- Adopt a worktree only when one is actually on disk (`fd5d166`)
- Alert when a thread's latest turn ended interrupted (`0f632a2`)
- Keep a running turn's thinking block on its newest line through a project rebuild (`d0f4414`)
- Key the thinking block's open state to the turn, not to the stale node (`1252c3d`)
- Judge a thread's latest turn by its clock, not its trimmed counter (`162f2c4`)
- Ask the gateway what a restart cut off, and stop a dead turn's clocks (`2f4b380`)
- Keep the project's own checkout named after its folder (`2735471`)
- Size the worktree table's columns from their cells, and let a reader drag an edge (`cd6ebbd`)
- Land a branch from the UNMERGED chip: one press starts a MERGING agent (`6d48a69`)
- A stored tool result is text in the console, and every call gets its own (`99ea317`)
- Honour the review: one row per burst, a live store that settles, and text that is not thrown away (`923f63a`)
- Wake the assistant with what the worker produced, not just that it stopped (`5ca7fd2`)
- Resolve a SPAWN IN name the panel renamed out from under it (`bd1a99b`)
- Keep the spawn-target proof out of the live gateway (#4) (`04297dc`)
- Let the board restart the gateway, or itself, and resume what that killed (`eb0efe3`)
- Let a remote browser in with a token, and refuse off-machine writes without one (`e31f949`)
- Keep the token in PANEL_TOKEN, not in a tracked config file (`08507ae`)
- Let the worktree chart scroll sideways instead of squeezing ten columns (#11) (`c9d8ac8`)
- Point the off-machine refusal at PANEL_TOKEN, not config.json (`5a0724f`)
- Stop an agent's question staying prose with no clarify box (`2a9e98e`)
- Read every action line a finished turn wrote, and carry each one out on its own (`91d0362`)
- Stop offering an approval the gateway has already decided (`a050ce0`)
- A verify script's scratch store goes with its run (`8547ac4`)
- Monitor Claude Code sessions alongside Hermes (`b16158f`)
- Bump version to 0.2.0 (`861652e`)

## v0.1.0 — 2026-10-20 · 1 commit

`0d3d3a8`

### Other

- Worktree monitor panel: worktree dashboard + Hermes agent launcher (`0d3d3a8`)
