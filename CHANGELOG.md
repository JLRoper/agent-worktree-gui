# Changelog

Every released version of the panel, newest first: the commits each release carried over the tag before it,
grouped by what a reader gets from them. Generated from git history — `npm run changelog` rewrites this file and
`npm run changelog:check` fails when it is stale. Do not edit it by hand.

**What changed since the build I am running?** The board's config line names the build (`v1.8.6 · …`).
Pass that version here and read only what came after it:

```
npm run changelog -- --since v0.80.0
```

271 releases from v0.1.0 (2026-10-20) to v1.8.6 (2026-11-04), 956 commits between the tags. Every release is anchored by an
annotated tag at the commit that first declared its version; `npm run verify:version-tags` fails when a bump
has no tag.

## v1.8.6 — 2026-11-04 · 5 commits

[`49b1176`](https://github.com/JLRoper/agent-worktree-gui/commit/49b117610258c33c6ed8e67c3b9e7fcae3efc1f5) · [compare v1.8.5...v1.8.6](https://github.com/JLRoper/agent-worktree-gui/compare/v1.8.5...v1.8.6)

### Fixed

- fix: the flow's type sizes and its scroller's padding ([`8639e40`](https://github.com/JLRoper/agent-worktree-gui/commit/8639e401ad92d6302acdf7cbd45d08bf893418a9))
- fix: the pipeline dialog is as wide as its drawing ([`2700930`](https://github.com/JLRoper/agent-worktree-gui/commit/270093040de12c7df87c5499de3d49221aeec3bb))

### Docs & tests

- docs: render the changelog — 270 releases ([`ec77f35`](https://github.com/JLRoper/agent-worktree-gui/commit/ec77f353b92c2c5cb972994288199a51c4d1aa9c))
- docs: the pipeline-dialog shape round, with the 1/2/7/13 shots at 1280 and 1824 ([`bb8c32a`](https://github.com/JLRoper/agent-worktree-gui/commit/bb8c32a3b0e837b88e3a295546631753ab11e0c7))

### Other

- chore: 1.8.6 — the version this branch lands on ([`49b1176`](https://github.com/JLRoper/agent-worktree-gui/commit/49b117610258c33c6ed8e67c3b9e7fcae3efc1f5))

## v1.8.5 — 2026-11-04 · 3 commits

[`3569b94`](https://github.com/JLRoper/agent-worktree-gui/commit/3569b9448af77fdaa56946d9cb9e5a3e39fc61e9) · [compare v1.8.4...v1.8.5](https://github.com/JLRoper/agent-worktree-gui/compare/v1.8.4...v1.8.5)

### Docs & tests

- docs: render the changelog — 269 releases ([`4f6c6c3`](https://github.com/JLRoper/agent-worktree-gui/commit/4f6c6c36ccce8ed804a2f9a912e21d900ed6c6eb))
- docs: PictureViewer + picture-manager-web dev deploy evidence and login walk (DMR-39015) ([`6f31b5c`](https://github.com/JLRoper/agent-worktree-gui/commit/6f31b5c147778535263bd89a30c8acdce6a6f17b))

### Other

- chore: 1.8.5 — the version this landing carries ([`3569b94`](https://github.com/JLRoper/agent-worktree-gui/commit/3569b9448af77fdaa56946d9cb9e5a3e39fc61e9))

## v1.8.4 — 2026-11-04 · 2 commits

[`fb8b63a`](https://github.com/JLRoper/agent-worktree-gui/commit/fb8b63a80170239254aac45c036963856b8b144b) · [compare v1.8.2...v1.8.4](https://github.com/JLRoper/agent-worktree-gui/compare/v1.8.2...v1.8.4)

### Fixed

- fix: the usability ledger names its tree relatively, not by one machine's path ([`7c17048`](https://github.com/JLRoper/agent-worktree-gui/commit/7c170485c1c9a67d74d1016bf5a177a33e608b5e))

### Other

- chore: 1.8.4 — the version this landing carries ([`fb8b63a`](https://github.com/JLRoper/agent-worktree-gui/commit/fb8b63a80170239254aac45c036963856b8b144b))

## v1.8.2 — 2026-11-04 · 2 commits

[`45e2bf0`](https://github.com/JLRoper/agent-worktree-gui/commit/45e2bf082de93bfd5fd7cc0977e09c0eae672720) · [compare v1.8.1...v1.8.2](https://github.com/JLRoper/agent-worktree-gui/compare/v1.8.1...v1.8.2)

### Docs & tests

- docs: restore the changelog's 1,477 links, lost by a render with no GitHub remote ([`9f16745`](https://github.com/JLRoper/agent-worktree-gui/commit/9f16745adc5d509164ac3c71f98d3c0f8b91c9e1))

### Other

- chore: 1.8.2 — the version this landing carries ([`45e2bf0`](https://github.com/JLRoper/agent-worktree-gui/commit/45e2bf082de93bfd5fd7cc0977e09c0eae672720))

## v1.8.1 — 2026-11-04 · 3 commits

[`f3c9c81`](https://github.com/JLRoper/agent-worktree-gui/commit/f3c9c81eec9332af9a99e005bc8af8b0a5ff6b20) · [compare v1.8.0...v1.8.1](https://github.com/JLRoper/agent-worktree-gui/compare/v1.8.0...v1.8.1)

### Fixed

- fix: the changelog resolves its links from any GitHub remote, and refuses a link-less render ([`7c11656`](https://github.com/JLRoper/agent-worktree-gui/commit/7c11656d701cf7e2d3f13017fc3d1173e8d9bd1d))

### Docs & tests

- docs: render the changelog — 266 releases ([`cb5f505`](https://github.com/JLRoper/agent-worktree-gui/commit/cb5f505bd9ebdb55784782b50b7fd9fb1ce42ed1))

### Other

- chore: 1.8.1 — the version this landing carries ([`f3c9c81`](https://github.com/JLRoper/agent-worktree-gui/commit/f3c9c81eec9332af9a99e005bc8af8b0a5ff6b20))

## v1.8.0 — 2026-11-04 · 3 commits

[`2704ce3`](https://github.com/JLRoper/agent-worktree-gui/commit/2704ce37753d2fae836e14f09bd6ae004deec878) · [compare v1.7.3...v1.8.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.7.3...v1.8.0)

### Added

- feat: picking a role loads its own charter, and the box asks before losing a draft ([`9a2793c`](https://github.com/JLRoper/agent-worktree-gui/commit/9a2793c2ba5d8f68169ee79dc39f24232d73ea32))

### Docs & tests

- docs: the picker's three constraints, proved with the sandbox shots ([`80f3cf1`](https://github.com/JLRoper/agent-worktree-gui/commit/80f3cf1850d50dc26b9781dd388dfbb6027ae3d5))

### Other

- chore: 1.8.0 — the version this landing carries ([`2704ce3`](https://github.com/JLRoper/agent-worktree-gui/commit/2704ce37753d2fae836e14f09bd6ae004deec878))

## v1.7.3 — 2026-11-04 · 2 commits

[`90004ad`](https://github.com/JLRoper/agent-worktree-gui/commit/90004addb8557b01e8fccfb61c7a95e9f966336b) · [compare v1.7.2...v1.7.3](https://github.com/JLRoper/agent-worktree-gui/compare/v1.7.2...v1.7.3)

### Docs & tests

- docs: render the changelog — 264 releases ([`896e78d`](https://github.com/JLRoper/agent-worktree-gui/commit/896e78dc01e78585d5c5c38924ca762113920380))

### Other

- chore: 1.7.3 — the version this landing carries ([`90004ad`](https://github.com/JLRoper/agent-worktree-gui/commit/90004addb8557b01e8fccfb61c7a95e9f966336b))

## v1.7.2 — 2026-11-04 · 2 commits

[`fd39414`](https://github.com/JLRoper/agent-worktree-gui/commit/fd394140fdc917375ea99c3fc7fb3f149c6034e7) · [compare v1.7.1...v1.7.2](https://github.com/JLRoper/agent-worktree-gui/compare/v1.7.1...v1.7.2)

### Fixed

- fix: a junctioned node_modules is unlinked before any worktree removal ([`a31d45f`](https://github.com/JLRoper/agent-worktree-gui/commit/a31d45fbc0ac0ff3f5298ae362d21834b44b063a))

### Other

- chore: 1.7.2 — the version this landing carries ([`fd39414`](https://github.com/JLRoper/agent-worktree-gui/commit/fd394140fdc917375ea99c3fc7fb3f149c6034e7))

## v1.7.1 — 2026-11-04 · 1 commit

[`81ad614`](https://github.com/JLRoper/agent-worktree-gui/commit/81ad61457751a849c86378dcdf4609ce7af61644) · [compare v1.7.0...v1.7.1](https://github.com/JLRoper/agent-worktree-gui/compare/v1.7.0...v1.7.1)

### Docs & tests

- docs: order the split into ten landable stages (#373) ([`81ad614`](https://github.com/JLRoper/agent-worktree-gui/commit/81ad61457751a849c86378dcdf4609ce7af61644))

## v1.7.0 — 2026-11-04 · 4 commits

[`6a3de29`](https://github.com/JLRoper/agent-worktree-gui/commit/6a3de29353607264c7fb41f95c8f75bd2e068659) · [compare v1.6.1...v1.7.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.6.1...v1.7.0)

### Added

- feat: the wave button behind a Cards switch, the pencil beside the name ([`64860c5`](https://github.com/JLRoper/agent-worktree-gui/commit/64860c5e265e8ea0acbf8502b5dc2e6511156a74))

### Docs & tests

- docs: render the changelog — 261 releases ([`35230cc`](https://github.com/JLRoper/agent-worktree-gui/commit/35230cce9291039e99dae0df612bb0048929aba3))
- docs: render the changelog — 261 releases ([`977635a`](https://github.com/JLRoper/agent-worktree-gui/commit/977635a60671b141e528f6de47b4c8eb0088631f))

### Other

- chore: 1.7.0 — the version this landing carries ([`6a3de29`](https://github.com/JLRoper/agent-worktree-gui/commit/6a3de29353607264c7fb41f95c8f75bd2e068659))

## v1.6.1 — 2026-11-04 · 3 commits

[`0507237`](https://github.com/JLRoper/agent-worktree-gui/commit/0507237f79e7c2bf74aa819ce1a5d9f1bda166d7) · [compare v1.6.0...v1.6.1](https://github.com/JLRoper/agent-worktree-gui/compare/v1.6.0...v1.6.1)

### Added

- feat: every deliverable card's Open opens it, and a refusal says why ([`bc2203c`](https://github.com/JLRoper/agent-worktree-gui/commit/bc2203cd9cdde5f0879ec5d3a5ee3948f719fe83))

### Docs & tests

- docs: render the changelog — 260 releases ([`f0b52a3`](https://github.com/JLRoper/agent-worktree-gui/commit/f0b52a3ba02ec4f717e2f1eb618dc745ee793979))

### Other

- chore: 1.6.1 — the version this landing carries ([`0507237`](https://github.com/JLRoper/agent-worktree-gui/commit/0507237f79e7c2bf74aa819ce1a5d9f1bda166d7))

## v1.6.0 — 2026-11-04 · 5 commits

[`eec5251`](https://github.com/JLRoper/agent-worktree-gui/commit/eec525149a485597863c5f8025574edd94ec75d0) · [compare v1.5.7...v1.6.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.5.7...v1.6.0)

### Added

- feat: the landing renders the changelog as its last step ([`4ba98d6`](https://github.com/JLRoper/agent-worktree-gui/commit/4ba98d6172284bd17a9c7501461317fd72082978))
- feat: the landing path runs land, and a base push with a stale changelog is refused ([`0bc3cf2`](https://github.com/JLRoper/agent-worktree-gui/commit/0bc3cf2273e8ce2db382ad031882826dad0c6e6f))

### Fixed

- fix: the land tool names a sha-only stale file, and its tests pin the case ([`edb25b3`](https://github.com/JLRoper/agent-worktree-gui/commit/edb25b30740dbc0eeb98a71934cbbbf5d2173332))

### Docs & tests

- docs: the landing's render, proven at 250 releases on main's own tip ([`cf922f4`](https://github.com/JLRoper/agent-worktree-gui/commit/cf922f4615a571e714bf0ab3440afa20294e7fd4))

### Other

- chore: 1.6.0 — the version this landing carries ([`eec5251`](https://github.com/JLRoper/agent-worktree-gui/commit/eec525149a485597863c5f8025574edd94ec75d0))

## v1.5.7 — 2026-11-04 · 1 commit

[`6be1978`](https://github.com/JLRoper/agent-worktree-gui/commit/6be197804cdd7d4a9d243d3c652ff1019cce3ebe) · [compare v1.5.6...v1.5.7](https://github.com/JLRoper/agent-worktree-gui/compare/v1.5.6...v1.5.7)

### Fixed

- fix: tag the commit that declared the version, never the ref's tip (#368) ([`6be1978`](https://github.com/JLRoper/agent-worktree-gui/commit/6be197804cdd7d4a9d243d3c652ff1019cce3ebe))

## v1.5.6 — 2026-11-04 · 3 commits

[`75ec220`](https://github.com/JLRoper/agent-worktree-gui/commit/75ec220506001ff79ad43e33f3ce064f5e9f0d2d) · [compare v1.5.5...v1.5.6](https://github.com/JLRoper/agent-worktree-gui/compare/v1.5.5...v1.5.6)

### Docs & tests

- docs: render the v1.5.5, v1.5.4 and v1.5.2 sections at this tip ([`92d5fcc`](https://github.com/JLRoper/agent-worktree-gui/commit/92d5fcc6e6c7f352262537932f9c605785d40c8a))
- docs: one entry point for the three split cuts, and the map reconciled ([`16ef146`](https://github.com/JLRoper/agent-worktree-gui/commit/16ef1462fc612a8a7de8f7a0e04d5fdad2d2d2ee))

### Other

- chore: 1.5.6 — the version this landing carries ([`75ec220`](https://github.com/JLRoper/agent-worktree-gui/commit/75ec220506001ff79ad43e33f3ce064f5e9f0d2d))

## v1.5.5 — 2026-11-04 · 2 commits

[`c7188bf`](https://github.com/JLRoper/agent-worktree-gui/commit/c7188bf20afd8bf7675841e40076794ea1c6bb07) · [compare v1.5.4...v1.5.5](https://github.com/JLRoper/agent-worktree-gui/compare/v1.5.4...v1.5.5)

### Docs & tests

- docs: the 1.4.2 usability ledger page, salvaged from PR #360 ([`1e8959c`](https://github.com/JLRoper/agent-worktree-gui/commit/1e8959cd21f8b69d5710a2dc4b986c17cb2eea31))

### Other

- chore: 1.5.5 — the version this landing carries ([`c7188bf`](https://github.com/JLRoper/agent-worktree-gui/commit/c7188bf20afd8bf7675841e40076794ea1c6bb07))

## v1.5.4 — 2026-11-04 · 2 commits

[`c9b8406`](https://github.com/JLRoper/agent-worktree-gui/commit/c9b8406f3f7a60886ec01ff93af5a27b7f522cdf) · [compare v1.5.2...v1.5.4](https://github.com/JLRoper/agent-worktree-gui/compare/v1.5.2...v1.5.4)

### Docs & tests

- docs: the round's report names the version this landing carries ([`8fea13c`](https://github.com/JLRoper/agent-worktree-gui/commit/8fea13c15e133bba8ce6051fb85720b0acbd3dd5))

### Other

- chore: 1.5.4 — the version this landing carries ([`c9b8406`](https://github.com/JLRoper/agent-worktree-gui/commit/c9b8406f3f7a60886ec01ff93af5a27b7f522cdf))

## v1.5.2 — 2026-11-04 · 4 commits

[`7ffd712`](https://github.com/JLRoper/agent-worktree-gui/commit/7ffd7125126464ae35d7b07b5b4cf05b3e2e876a) · [compare v1.5.0...v1.5.2](https://github.com/JLRoper/agent-worktree-gui/compare/v1.5.0...v1.5.2)

### Docs & tests

- docs: render the 1.5.0 section at the rebased tip ([`5234a3c`](https://github.com/JLRoper/agent-worktree-gui/commit/5234a3c90dcb50e015307db61e51dbe85503331c))
- docs: the flow chart against the studio, thirteen stages at three widths ([`86cb831`](https://github.com/JLRoper/agent-worktree-gui/commit/86cb831486761ab26f9e280debbd0006ca587c93))

### Other

- tools: capture the flow chart and the studio side by side ([`48a9030`](https://github.com/JLRoper/agent-worktree-gui/commit/48a90303ee558ff398547f41226ab6a86d34edd6))
- chore: 1.5.2 — the version this landing carries ([`7ffd712`](https://github.com/JLRoper/agent-worktree-gui/commit/7ffd7125126464ae35d7b07b5b4cf05b3e2e876a))

## v1.5.0 — 2026-11-04 · 3 commits

[`4209390`](https://github.com/JLRoper/agent-worktree-gui/commit/4209390f30e3101d88c8f073d7912a147528d576) · [compare v1.4.2...v1.5.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.4.2...v1.5.0)

### Added

- feat: Settings → Updates draws the checkout's own changelog ([`4209390`](https://github.com/JLRoper/agent-worktree-gui/commit/4209390f30e3101d88c8f073d7912a147528d576))

### Docs & tests

- docs: render the v1.4.2 and v1.4.1 sections against the commits the rebase merge carried ([`0972094`](https://github.com/JLRoper/agent-worktree-gui/commit/0972094ce18d23c5c168f0ac764609796ead1fe1))
- docs: record the #359 landing and what the round's ledger is ([`da49821`](https://github.com/JLRoper/agent-worktree-gui/commit/da4982116195908b141ca68e463fbc4d8bb1a7a5))

## v1.4.2 — 2026-11-04 · 2 commits

[`1e1c595`](https://github.com/JLRoper/agent-worktree-gui/commit/1e1c595b8ca75d6c039dbc277f309be86b357a5d) · [compare v1.4.1...v1.4.2](https://github.com/JLRoper/agent-worktree-gui/compare/v1.4.1...v1.4.2)

### Docs & tests

- docs: the pipeline flow, measured as a reader reads it ([`4ebc73c`](https://github.com/JLRoper/agent-worktree-gui/commit/4ebc73c8473d8e50e9879add382aaa4d50661e7c))

### Other

- chore: 1.4.2 — the version this landing carries ([`1e1c595`](https://github.com/JLRoper/agent-worktree-gui/commit/1e1c595b8ca75d6c039dbc277f309be86b357a5d))

## v1.4.1 — 2026-11-04 · 3 commits

[`6cd6426`](https://github.com/JLRoper/agent-worktree-gui/commit/6cd6426fe534a12e9a77e7e33b5d7c79103337f0) · [compare v1.4.0...v1.4.1](https://github.com/JLRoper/agent-worktree-gui/compare/v1.4.0...v1.4.1)

### Docs & tests

- docs: render the v1.4.0 section on main ([`e2358c5`](https://github.com/JLRoper/agent-worktree-gui/commit/e2358c5b28d6eacd163f0af88eed672a46dea0f3))
- docs: the module map that names a lane for every file ([`29809a8`](https://github.com/JLRoper/agent-worktree-gui/commit/29809a88523f6bcd2f778bf13af6420340bec0e3))

### Other

- chore: 1.4.1 — the version this landing carries ([`6cd6426`](https://github.com/JLRoper/agent-worktree-gui/commit/6cd6426fe534a12e9a77e7e33b5d7c79103337f0))

## v1.4.0 — 2026-11-04 · 5 commits

[`db8dc06`](https://github.com/JLRoper/agent-worktree-gui/commit/db8dc06328bc95252543e45f30f382e465424c78) · [compare v1.3.0...v1.4.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.3.0...v1.4.0)

### Added

- feat: each assistant owns its alerts, watches, messages and pad ([`d8068c0`](https://github.com/JLRoper/agent-worktree-gui/commit/d8068c046d8418bf75b05827a200d3c3a2d85318))

### Docs & tests

- test: pin the count's sentence, the fit control, and the fitted drawing ([`5cd412e`](https://github.com/JLRoper/agent-worktree-gui/commit/5cd412efbe0ecbe82ae765d3daadd3ca85c94771))
- test: the thirteen-stage case goes green on the fitted drawing, and the count is judged in both states ([`9a521e6`](https://github.com/JLRoper/agent-worktree-gui/commit/9a521e612787e0dd42abb690b37d058e04db8559))
- docs: the round's report, with the four shots that decided it ([`58ab40a`](https://github.com/JLRoper/agent-worktree-gui/commit/58ab40a5550218552b2de771e58aad01189174b8))

### Other

- chore: 1.4.0 — the version this landing carries ([`db8dc06`](https://github.com/JLRoper/agent-worktree-gui/commit/db8dc06328bc95252543e45f30f382e465424c78))

## v1.3.0 — 2026-11-04 · 2 commits

[`6ba1e85`](https://github.com/JLRoper/agent-worktree-gui/commit/6ba1e8571a0990a44d3fa414bf438c5595a6f494) · [compare v1.2.0...v1.3.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.2.0...v1.3.0)

### Added

- feat: thirteen stages fit the card, and the scroller says what it hides ([`6ba1e85`](https://github.com/JLRoper/agent-worktree-gui/commit/6ba1e8571a0990a44d3fa414bf438c5595a6f494))

### Docs & tests

- docs: render the v1.2.0 section on main ([`1b8b795`](https://github.com/JLRoper/agent-worktree-gui/commit/1b8b795682253956e029936956e3e63c0b452456))

## v1.2.0 — 2026-11-04 · 6 commits

[`a843641`](https://github.com/JLRoper/agent-worktree-gui/commit/a8436412c1db0f3017441fe1c3703cd02b19c326) · [compare v1.1.1...v1.2.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.1.1...v1.2.0)

### Added

- feat: every wait on a person goes out over the bridge that is already running ([`d4fe71a`](https://github.com/JLRoper/agent-worktree-gui/commit/d4fe71aa6726519fc7f58263aee7553bacb676c8))

### Docs & tests

- docs: render the 1.1.1 section on main ([`c404950`](https://github.com/JLRoper/agent-worktree-gui/commit/c404950c69dbcf660e5e512e01a193cd4b672f7c))
- docs: the round 5B report quotes the suite at the rebased tip ([`f00c0e0`](https://github.com/JLRoper/agent-worktree-gui/commit/f00c0e0cba5570eab1bbaec6505ba9df69aa25ff))
- docs: the v1.1.0 tag moves onto the commit that declares 1.1.0 ([`1a6c0a5`](https://github.com/JLRoper/agent-worktree-gui/commit/1a6c0a5e799d1961e65286115b3be5fac717c798))
- docs: retire the two orphan tags, and prove the gate green ([`be17bc6`](https://github.com/JLRoper/agent-worktree-gui/commit/be17bc6fcea7c1fa85c3f2a6d62d94bc40b4a55f))

### Other

- chore: 1.2.0 — the version this landing carries ([`a843641`](https://github.com/JLRoper/agent-worktree-gui/commit/a8436412c1db0f3017441fe1c3703cd02b19c326))

## v1.1.1 — 2026-11-04 · 6 commits

[`5116bd2`](https://github.com/JLRoper/agent-worktree-gui/commit/5116bd20e19b22683b8c9052380ae590559e6225) · [compare v1.1.0...v1.1.1](https://github.com/JLRoper/agent-worktree-gui/compare/v1.1.0...v1.1.1)

### Docs & tests

- docs: render the 1.1.0 section, cut by this landing ([`0e16e54`](https://github.com/JLRoper/agent-worktree-gui/commit/0e16e541e3972824f6bf9c67f0180afb3b984420))
- docs: render the 1.1.0 section against the commits the rebase merge carried ([`4073d27`](https://github.com/JLRoper/agent-worktree-gui/commit/4073d27170cf830c56a8050225f734b85f900fdf))

### Other

- The drawing fills its card, its words clear AA, and nothing hangs past the track ([`a83f05c`](https://github.com/JLRoper/agent-worktree-gui/commit/a83f05c81269c7e8fc90931707c3bf259ee106b3))
- A press on the flow's backdrop stops at the dialog ([`5afc1fe`](https://github.com/JLRoper/agent-worktree-gui/commit/5afc1fecda5dde8195e0579c80ba4fac882a6e08))
- The visual layer's round report, with the shots that decided it ([`4e31f79`](https://github.com/JLRoper/agent-worktree-gui/commit/4e31f7919e41264a84072674dce0f2ed93c9c619))
- chore: 1.1.1 — the version this landing carries ([`5116bd2`](https://github.com/JLRoper/agent-worktree-gui/commit/5116bd20e19b22683b8c9052380ae590559e6225))

## v1.1.0 — 2026-11-04 · 2 commits

[`d5b35eb`](https://github.com/JLRoper/agent-worktree-gui/commit/d5b35ebdcce609b3dc94064539f3f7d056681313) · [compare v1.0.4...v1.1.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.0.4...v1.1.0)

### Added

- feat: alerts get an owner — stamped at fire time, resolved from the thread, filed under a tab ([`8688a70`](https://github.com/JLRoper/agent-worktree-gui/commit/8688a707dfd4588e9627be28f9f7fae9c941ebe9))

### Other

- chore: 1.1.0 — the version this landing carries ([`d5b35eb`](https://github.com/JLRoper/agent-worktree-gui/commit/d5b35ebdcce609b3dc94064539f3f7d056681313))

## v1.0.4 — 2026-11-04 · 2 commits

[`4c0a52b`](https://github.com/JLRoper/agent-worktree-gui/commit/4c0a52b34fa2c9b1b8e851794b63f15d0536add4) · [compare v1.0.3...v1.0.4](https://github.com/JLRoper/agent-worktree-gui/compare/v1.0.3...v1.0.4)

### Other

- Make the drawing and the driver agree about which edge a stage leaves by ([`0ceaa22`](https://github.com/JLRoper/agent-worktree-gui/commit/0ceaa229ea5235a0f61bb3b2305ebd4dd3b7c388))
- chore: 1.0.4 — the version this landing carries ([`4c0a52b`](https://github.com/JLRoper/agent-worktree-gui/commit/4c0a52b34fa2c9b1b8e851794b63f15d0536add4))

## v1.0.3 — 2026-11-04 · 4 commits

[`5ea54e9`](https://github.com/JLRoper/agent-worktree-gui/commit/5ea54e9e088bfc349dfba1c513724b0a24d4bf97) · [compare v1.0.1...v1.0.3](https://github.com/JLRoper/agent-worktree-gui/compare/v1.0.1...v1.0.3)

### Changed

- style: the queue's three states read green / amber / red ([`53c03ea`](https://github.com/JLRoper/agent-worktree-gui/commit/53c03ea09fa2634c88af04d22331fa7fd6ad66a8))

### Docs & tests

- docs: render the 1.0.1 section, cut by this landing ([`0041b45`](https://github.com/JLRoper/agent-worktree-gui/commit/0041b452163d63d4267117e2f6dcce638e88fc34))
- docs: render the 1.0.1 section against the commits the rebase merge carried ([`6566499`](https://github.com/JLRoper/agent-worktree-gui/commit/656649968f526ce624b877d25793dad80cac53b0))

### Other

- chore: 1.0.3 — the version this landing carries ([`5ea54e9`](https://github.com/JLRoper/agent-worktree-gui/commit/5ea54e9e088bfc349dfba1c513724b0a24d4bf97))

## v1.0.1 — 2026-11-04 · 3 commits

[`0b0ff0b`](https://github.com/JLRoper/agent-worktree-gui/commit/0b0ff0b3446580dfee06eafdfa3e5c42a41a4c1d) · [compare v1.0.0...v1.0.1](https://github.com/JLRoper/agent-worktree-gui/compare/v1.0.0...v1.0.1)

### Added

- feat: each assistant owns its rules and its pad, and the message board names whose message is whose ([`3c8e36e`](https://github.com/JLRoper/agent-worktree-gui/commit/3c8e36e1d1932501411550a4d51d26bd2bb7e9ab))

### Other

- wip: per-assistant split in progress (notes file, pad routing, watch owners) ([`5d8e5d5`](https://github.com/JLRoper/agent-worktree-gui/commit/5d8e5d5cb3e1141da852aa7592a2e48c98da0ef8))
- chore: 1.0.1 — the version this landing carries ([`0b0ff0b`](https://github.com/JLRoper/agent-worktree-gui/commit/0b0ff0b3446580dfee06eafdfa3e5c42a41a4c1d))

## v1.0.0 — 2026-11-04 · 2 commits

[`e9d3d70`](https://github.com/JLRoper/agent-worktree-gui/commit/e9d3d7064bf91f530520c2f07c41481cafeb2f35) · [compare v0.115.0...v1.0.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.115.0...v1.0.0)

### Added

- feat!: the row's ✦ name-from-work path is gone; the ✎ leads the padlock ([`e9d3d70`](https://github.com/JLRoper/agent-worktree-gui/commit/e9d3d7064bf91f530520c2f07c41481cafeb2f35))

### Docs & tests

- docs: render the 0.115.0 and 0.114.1 sections, both missing at the tip ([`eca3bac`](https://github.com/JLRoper/agent-worktree-gui/commit/eca3bacf225f772160d221b3030a3d715f93eb13))

## v0.115.0 — 2026-11-04 · 4 commits

[`f108689`](https://github.com/JLRoper/agent-worktree-gui/commit/f108689aa6f7ea3d8ada8b80accf71c0625360de) · [compare v0.114.1...v0.115.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.114.1...v0.115.0)

### Added

- feat: the queue explainer is a lead and five labelled lines, and Settings ships one press away ([`254ad5c`](https://github.com/JLRoper/agent-worktree-gui/commit/254ad5c188313171716940118b7298e5111ecd68))

### Docs & tests

- docs: the plan names the base it is cut from — 0.114.0, and the flow block's last line ([`fe6613a`](https://github.com/JLRoper/agent-worktree-gui/commit/fe6613a20095a6ba25df78ca9cd594e6a222c8e5))
- docs: the render landed once and the duplicate closed, re-checked at 0.114.0 ([`49f6e4e`](https://github.com/JLRoper/agent-worktree-gui/commit/49f6e4e42203e57e9f767cad930b9f1d2138b42c))

### Other

- chore: 0.115.0 — the version this landing carries ([`f108689`](https://github.com/JLRoper/agent-worktree-gui/commit/f108689aa6f7ea3d8ada8b80accf71c0625360de))

## v0.114.1 — 2026-11-04 · 3 commits

[`698743f`](https://github.com/JLRoper/agent-worktree-gui/commit/698743f96fa9cd83a0a533c7e828f8d6e8759e0d) · [compare v0.114.0...v0.114.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.114.0...v0.114.1)

### Docs & tests

- docs: render the 0.114.0 and 0.113.0 sections, the two main had not rendered ([`97e6b86`](https://github.com/JLRoper/agent-worktree-gui/commit/97e6b86f166af7231a46f90b7a336484103a2d27))
- docs: plan the pipeline flow's integration, in the order the comparables justify ([`3326190`](https://github.com/JLRoper/agent-worktree-gui/commit/3326190f1f3703e66b574040ab64c6041d159717))

### Other

- chore: 0.114.1 — the version this landing carries ([`698743f`](https://github.com/JLRoper/agent-worktree-gui/commit/698743f96fa9cd83a0a533c7e828f8d6e8759e0d))

## v0.114.0 — 2026-11-03 · 2 commits

[`cad0469`](https://github.com/JLRoper/agent-worktree-gui/commit/cad046900e7cee47060a7c467e72196ed3fb8331) · [compare v0.113.0...v0.114.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.113.0...v0.114.0)

### Docs & tests

- docs: render the 0.111.2 and 0.111.3 sections, both missing at once ([`b64d8f0`](https://github.com/JLRoper/agent-worktree-gui/commit/b64d8f0b2f186fdd2a007d24ca1d37c4241daafe))
- test: both routes into the pipeline flow, judged visible and clean at 1280 and 1821 ([`cad0469`](https://github.com/JLRoper/agent-worktree-gui/commit/cad046900e7cee47060a7c467e72196ed3fb8331))

## v0.113.0 — 2026-11-03 · 3 commits

[`743789d`](https://github.com/JLRoper/agent-worktree-gui/commit/743789d4c3bff71d5f65c33a4b125a0d41d659a6) · [compare v0.111.3...v0.113.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.111.3...v0.113.0)

### Added

- feat: the Gateway tab starts and stops the Matrix bridge ([`d75488f`](https://github.com/JLRoper/agent-worktree-gui/commit/d75488fcd99f3bb8a741f46de207f703c963fd58))
- feat: the bridge starts with the panel, and its four settings are editable ([`86c659d`](https://github.com/JLRoper/agent-worktree-gui/commit/86c659d927c0eba82cbea30f110d9894a5d8a78d))

### Other

- chore: 0.113.0 — the version this landing carries ([`743789d`](https://github.com/JLRoper/agent-worktree-gui/commit/743789d4c3bff71d5f65c33a4b125a0d41d659a6))

## v0.111.3 — 2026-11-03 · 2 commits

[`4ebaa62`](https://github.com/JLRoper/agent-worktree-gui/commit/4ebaa6261b80a5a0fd563c9355e07027771271d4) · [compare v0.111.2...v0.111.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.111.2...v0.111.3)

### Docs & tests

- docs: the critique counts its own findings, and its two findings that need geometry ([`1036d5d`](https://github.com/JLRoper/agent-worktree-gui/commit/1036d5d641f83640c188333f6fab1f4f59bafcc6))

### Other

- chore: 0.111.3 — the version this landing carries ([`4ebaa62`](https://github.com/JLRoper/agent-worktree-gui/commit/4ebaa6261b80a5a0fd563c9355e07027771271d4))

## v0.111.2 — 2026-11-03 · 3 commits

[`a980b30`](https://github.com/JLRoper/agent-worktree-gui/commit/a980b30988c29e0006a0bfec8b80237e355ed925) · [compare v0.111.1...v0.111.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.111.1...v0.111.2)

### Docs & tests

- docs: render the 0.111.1 section, after main carried d3b3954 ([`19879ba`](https://github.com/JLRoper/agent-worktree-gui/commit/19879ba5a920540636f6b1e01f6b08e5ab48f0cc))
- docs: critique the pipeline flow's architecture — the diagnosis holds, the price does not ([`34c2f54`](https://github.com/JLRoper/agent-worktree-gui/commit/34c2f5475f8c2e60a68b1db66baa6cbdeaaf6ec4))

### Other

- chore: 0.111.2 — the version this landing carries ([`a980b30`](https://github.com/JLRoper/agent-worktree-gui/commit/a980b30988c29e0006a0bfec8b80237e355ed925))

## v0.111.1 — 2026-11-03 · 3 commits

[`d3b3954`](https://github.com/JLRoper/agent-worktree-gui/commit/d3b3954afb1e19c5a71be88ea8832723ee7c2567) · [compare v0.111.0...v0.111.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.111.0...v0.111.1)

### Docs & tests

- docs: render the 0.111.0 section, after main moved to 75e648c ([`2bc4dcf`](https://github.com/JLRoper/agent-worktree-gui/commit/2bc4dcf240e02220686e352a975035af8ab3e12b))
- docs: review the pipeline flow's technology — the drawing that carries state ([`8371146`](https://github.com/JLRoper/agent-worktree-gui/commit/83711460884b68b4c49ed12a3d99fdfbb9492f82))

### Other

- chore: 0.111.1 — the version this landing carries ([`d3b3954`](https://github.com/JLRoper/agent-worktree-gui/commit/d3b3954afb1e19c5a71be88ea8832723ee7c2567))

## v0.111.0 — 2026-11-03 · 4 commits

[`75e648c`](https://github.com/JLRoper/agent-worktree-gui/commit/75e648c3708b9fa5f1d222226b4396e5593f8b1b) · [compare v0.110.0...v0.111.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.110.0...v0.111.0)

### Added

- feat: a task on a pipeline is driven stage by stage, to the pipeline's own limits ([`a71453c`](https://github.com/JLRoper/agent-worktree-gui/commit/a71453c104355b20bbb2277a9d044d0a948c90e8))

### Docs & tests

- docs: render the 0.110.0 section, after main moved to b662bce ([`43d4b94`](https://github.com/JLRoper/agent-worktree-gui/commit/43d4b948502021f3c3b514c91443995c244b1617))
- docs: a render is never folded into the bump it describes ([`db52ecd`](https://github.com/JLRoper/agent-worktree-gui/commit/db52ecd4511f8ea88acac42958e7c540af03f5bf))

### Other

- chore: 0.111.0 — the version this landing carries ([`75e648c`](https://github.com/JLRoper/agent-worktree-gui/commit/75e648c3708b9fa5f1d222226b4396e5593f8b1b))

## v0.110.0 — 2026-11-03 · 5 commits

[`b662bce`](https://github.com/JLRoper/agent-worktree-gui/commit/b662bce1b2f09815853d0434471539ec629dc71f) · [compare v0.109.0...v0.110.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.109.0...v0.110.0)

### Added

- feat: the DELIVERABLES list gets its backend — a store, a harvest, and two real routes ([`203093e`](https://github.com/JLRoper/agent-worktree-gui/commit/203093e5b7cbf47107df1dcda193bde88f5bab1a))

### Docs & tests

- docs: render the changelog after the merge, so its links name main's commits ([`65b7c01`](https://github.com/JLRoper/agent-worktree-gui/commit/65b7c016e1611e54690130a892ccec86087cc86e))
- docs: the changelog is rendered after the merge, never on the branch ([`1ba00e9`](https://github.com/JLRoper/agent-worktree-gui/commit/1ba00e9f9bd5d44bf631763f1202b2eeada20fbc))
- docs: render the 0.109.0 section, after main moved to 9166869 ([`b26631b`](https://github.com/JLRoper/agent-worktree-gui/commit/b26631b4ee31304be3e71373eb8995aa4ae740fb))

### Other

- chore: 0.110.0 — the version this landing carries ([`b662bce`](https://github.com/JLRoper/agent-worktree-gui/commit/b662bce1b2f09815853d0434471539ec629dc71f))

## v0.109.0 — 2026-11-03 · 3 commits

[`9166869`](https://github.com/JLRoper/agent-worktree-gui/commit/9166869b5fde0c0883a54a099ff2c6ed57eb2d46) · [compare v0.106.2...v0.109.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.106.2...v0.109.0)

### Added

- feat: the queue row leads with what it is, its state and what it waits on ([`48f484e`](https://github.com/JLRoper/agent-worktree-gui/commit/48f484e443cb21ece9c93fbcd076fc026357f7ad))

### Docs & tests

- docs: render the changelog through 0.106.2, where it had stopped at 0.91.0 ([`7f55744`](https://github.com/JLRoper/agent-worktree-gui/commit/7f55744092c0774c9b7391438d6c3ee051fca167))

### Other

- chore: 0.109.0 — the version this landing carries ([`9166869`](https://github.com/JLRoper/agent-worktree-gui/commit/9166869b5fde0c0883a54a099ff2c6ed57eb2d46))

## v0.106.2 — 2026-11-03 · 2 commits

[`1641e5a`](https://github.com/JLRoper/agent-worktree-gui/commit/1641e5a71bb9ac83369a5e6d0aadf6fc999a7e7e) · [compare v0.106.1...v0.106.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.106.1...v0.106.2)

### Docs & tests

- docs: the Settings strip names every tab it draws, and the count comes from that list ([`728478f`](https://github.com/JLRoper/agent-worktree-gui/commit/728478f40efbf8d5827b0acd69b4528606c4b65f))

### Other

- chore: 0.106.2 — the version this landing carries ([`1641e5a`](https://github.com/JLRoper/agent-worktree-gui/commit/1641e5a71bb9ac83369a5e6d0aadf6fc999a7e7e))

## v0.106.1 — 2026-11-03 · 3 commits

[`47e2774`](https://github.com/JLRoper/agent-worktree-gui/commit/47e277478268237eb519ef54e0d396e08808dc65) · [compare v0.106.0...v0.106.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.106.0...v0.106.1)

### Added

- feat: the pipeline flow is a drawing, and one modal opens it from Settings and a queue row ([`28433cc`](https://github.com/JLRoper/agent-worktree-gui/commit/28433ccec2dfd77520d094d8249bbae1078032bd))

### Docs & tests

- test: the modal's source checks read a normalised copy, so a CRLF checkout cannot fail them ([`fa83696`](https://github.com/JLRoper/agent-worktree-gui/commit/fa8369627c0e17cd7076f7732571e618aeb33e77))

### Other

- chore: 0.106.1 — the version this landing carries ([`47e2774`](https://github.com/JLRoper/agent-worktree-gui/commit/47e277478268237eb519ef54e0d396e08808dc65))

## v0.106.0 — 2026-11-03 · 2 commits

[`4c42a05`](https://github.com/JLRoper/agent-worktree-gui/commit/4c42a05c297647f686adb7ee7291a322f02b8bd8) · [compare v0.105.0...v0.106.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.105.0...v0.106.0)

### Added

- feat: every brief teaches the DELIVER marker, and the list says what a deliverable is ([`9b4c462`](https://github.com/JLRoper/agent-worktree-gui/commit/9b4c4623394ce417ddfc3f404c8f2aaeea02f112))

### Other

- chore: 0.106.0 — the version this landing carries ([`4c42a05`](https://github.com/JLRoper/agent-worktree-gui/commit/4c42a05c297647f686adb7ee7291a322f02b8bd8))

## v0.105.0 — 2026-11-03 · 2 commits

[`0ef104a`](https://github.com/JLRoper/agent-worktree-gui/commit/0ef104a5497607e602903a83507c5b9e1cbb2140) · [compare v0.104.0...v0.105.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.104.0...v0.105.0)

### Fixed

- fix: a restart waits only for a thread it named, and only a new version is a bounce for nothing ([`ed915e9`](https://github.com/JLRoper/agent-worktree-gui/commit/ed915e923becbaf9fc01d43d76918e026a29efa8))

### Other

- chore: 0.105.0 — the version this landing carries ([`0ef104a`](https://github.com/JLRoper/agent-worktree-gui/commit/0ef104a5497607e602903a83507c5b9e1cbb2140))

## v0.104.0 — 2026-11-03 · 2 commits

[`c55f88f`](https://github.com/JLRoper/agent-worktree-gui/commit/c55f88f54672082b078d3ba7319a65cb91919505) · [compare v0.103.0...v0.104.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.103.0...v0.104.0)

### Added

- feat: the DELIVERABLES hand-back button and its list ([`ed97151`](https://github.com/JLRoper/agent-worktree-gui/commit/ed971511bb6010ef239a45544c6f430c854f4d7e))

### Other

- chore: 0.104.0 — the version this landing carries ([`c55f88f`](https://github.com/JLRoper/agent-worktree-gui/commit/c55f88f54672082b078d3ba7319a65cb91919505))

## v0.103.0 — 2026-11-03 · 2 commits

[`206d61e`](https://github.com/JLRoper/agent-worktree-gui/commit/206d61eaa78b15893285793456ac27b82dff52eb) · [compare v0.102.0...v0.103.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.102.0...v0.103.0)

### Docs & tests

- docs: re-measure Appendix A at the 0.102.0 tip, after #317 moved app.js ([`2f53651`](https://github.com/JLRoper/agent-worktree-gui/commit/2f53651de97c16f8b1aec277e169aceddb5609e6))

### Other

- chore: 0.103.0 — the version this landing carries ([`206d61e`](https://github.com/JLRoper/agent-worktree-gui/commit/206d61eaa78b15893285793456ac27b82dff52eb))

## v0.102.0 — 2026-11-03 · 3 commits

[`6a25c5b`](https://github.com/JLRoper/agent-worktree-gui/commit/6a25c5b73b7991a76dd9272b424e684584cbdd5f) · [compare v0.101.0...v0.102.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.101.0...v0.102.0)

### Docs & tests

- docs: re-measure Appendix A at the 0.101.0 tip, where server.js moved ([`a7be2cc`](https://github.com/JLRoper/agent-worktree-gui/commit/a7be2cc470add79b189899521f1431dd0e37db5b))

### Other

- Settings > Bundles: list an imported bundle's pipelines and refuse it by code ([`4c68b17`](https://github.com/JLRoper/agent-worktree-gui/commit/4c68b17986779f28b2047c6f9c122b471a7ecb59))
- chore: 0.102.0 — the version this landing carries ([`6a25c5b`](https://github.com/JLRoper/agent-worktree-gui/commit/6a25c5b73b7991a76dd9272b424e684584cbdd5f))

## v0.101.0 — 2026-11-03 · 2 commits

[`4463e0e`](https://github.com/JLRoper/agent-worktree-gui/commit/4463e0e0fc7332f8c263da99c572fcdf211ed720) · [compare v0.100.0...v0.101.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.100.0...v0.101.0)

### Added

- feat: a review wait is a timer on the tree, not a worker sleeping in a run ([`27b8f64`](https://github.com/JLRoper/agent-worktree-gui/commit/27b8f646f7f13b907e9192ff6bcefcf58cb89093))

### Other

- chore: 0.101.0 — the version this landing carries ([`4463e0e`](https://github.com/JLRoper/agent-worktree-gui/commit/4463e0e0fc7332f8c263da99c572fcdf211ed720))

## v0.100.0 — 2026-11-03 · 2 commits

[`e7beb8e`](https://github.com/JLRoper/agent-worktree-gui/commit/e7beb8e19118dca8bb6c8a3052923d98778b0c7c) · [compare v0.99.0...v0.100.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.99.0...v0.100.0)

### Docs & tests

- docs: re-measure architecture.md at the 0.99.0 tip, where the test counts moved ([`9357baa`](https://github.com/JLRoper/agent-worktree-gui/commit/9357baa648b7795ab3f0f3db2dd6bfff9c71ee6f))

### Other

- chore: 0.100.0 — the version this landing carries ([`e7beb8e`](https://github.com/JLRoper/agent-worktree-gui/commit/e7beb8e19118dca8bb6c8a3052923d98778b0c7c))

## v0.99.0 — 2026-11-03 · 1 commit

[`e4cb244`](https://github.com/JLRoper/agent-worktree-gui/commit/e4cb244e032333aeaf7e0cd8ac65b03759ed6b57) · [compare v0.98.0...v0.99.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.98.0...v0.99.0)

### Other

- Stop the version gate passing a branch that is merely behind main (#312) ([`e4cb244`](https://github.com/JLRoper/agent-worktree-gui/commit/e4cb244e032333aeaf7e0cd8ac65b03759ed6b57))

## v0.98.0 — 2026-11-03 · 5 commits

[`fe629de`](https://github.com/JLRoper/agent-worktree-gui/commit/fe629de57a2e76e5d917d1176961fdc42e57c113) · [compare v0.95.0...v0.98.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.95.0...v0.98.0)

### Docs & tests

- docs: plan the DELIVER handback — marker, harvest seam, store and header list ([`70d7dea`](https://github.com/JLRoper/agent-worktree-gui/commit/70d7dea0bcd6f11964397c90732782b0c5079ddc))
- docs: review the DELIVER handback plan — 3 blockers, 14 must-fixes, 15 nits ([`a656a55`](https://github.com/JLRoper/agent-worktree-gui/commit/a656a55fb6a06e092a33a4e1555b0de514f9f78a))
- docs: revise the deliverables plan against the review — B1-B3 and M1-M14 ([`2c2ac91`](https://github.com/JLRoper/agent-worktree-gui/commit/2c2ac91be7d53479f9b4e2bee39ef6ef771d4dc4))
- docs: settle the two choices — image glyph, paragraph on every tree turn ([`bdcc61b`](https://github.com/JLRoper/agent-worktree-gui/commit/bdcc61bece263d4ad9cc9fbee4b5fa1f81040174))

### Other

- chore: 0.98.0 — the version this landing carries ([`fe629de`](https://github.com/JLRoper/agent-worktree-gui/commit/fe629de57a2e76e5d917d1176961fdc42e57c113))

## v0.95.0 — 2026-11-03 · 2 commits

[`9669681`](https://github.com/JLRoper/agent-worktree-gui/commit/9669681c62feb6e24c312459ca69c60cd931c0db) · [compare v0.94.0...v0.95.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.94.0...v0.95.0)

### Docs & tests

- test: both app.js pins cut their own section, not a neighbour's closer ([`f4ee22b`](https://github.com/JLRoper/agent-worktree-gui/commit/f4ee22bba7d4f1e8b274830d60c01b0d182109f0))

### Other

- chore: 0.95.0 — the version this landing carries ([`9669681`](https://github.com/JLRoper/agent-worktree-gui/commit/9669681c62feb6e24c312459ca69c60cd931c0db))

## v0.94.0 — 2026-11-03 · 2 commits

[`e88dc53`](https://github.com/JLRoper/agent-worktree-gui/commit/e88dc53d5ecc746da8ace48bb2e0cbfaca6594e8) · [compare v0.93.1...v0.94.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.93.1...v0.94.0)

### Added

- feat: the version bump tags itself, and a backfill repairs the ones it missed ([`297b957`](https://github.com/JLRoper/agent-worktree-gui/commit/297b957d9d192ff301995e4dbd2a48f14b600584))

### Other

- chore: 0.94.0 — the version this landing carries ([`e88dc53`](https://github.com/JLRoper/agent-worktree-gui/commit/e88dc53d5ecc746da8ace48bb2e0cbfaca6594e8))

## v0.93.1 — 2026-11-03 · 1 commit

[`6db8f29`](https://github.com/JLRoper/agent-worktree-gui/commit/6db8f29c44553ad6a8b9e8cb3a1428d4261c1d91) · [compare v0.93.0...v0.93.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.93.0...v0.93.1)

### Fixed

- fix: a branch that never committed is not MERGED ([`6db8f29`](https://github.com/JLRoper/agent-worktree-gui/commit/6db8f29c44553ad6a8b9e8cb3a1428d4261c1d91))

## v0.93.0 — 2026-11-03 · 2 commits

[`dc5bde2`](https://github.com/JLRoper/agent-worktree-gui/commit/dc5bde23d6d5af4e77775780f5a29e4b27a7a57b) · [compare v0.92.0...v0.93.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.92.0...v0.93.0)

### Added

- feat: a queue sweep on every settle, and a failsafe for the quiet board ([`dc5bde2`](https://github.com/JLRoper/agent-worktree-gui/commit/dc5bde23d6d5af4e77775780f5a29e4b27a7a57b))

### Docs & tests

- test: the aggressive acceptance checks the switch where it now lives ([`f9f103d`](https://github.com/JLRoper/agent-worktree-gui/commit/f9f103d5735eb2ef86185ebb9c3d843cccce31e7))

## v0.92.0 — 2026-11-03 · 1 commit

[`f55fecb`](https://github.com/JLRoper/agent-worktree-gui/commit/f55fecb257a688918bec20bab34efc3dcfef441b) · [compare v0.91.0...v0.92.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.91.0...v0.92.0)

### Added

- feat: the aggressive switch moves into an assistant's Settings pane ([`f55fecb`](https://github.com/JLRoper/agent-worktree-gui/commit/f55fecb257a688918bec20bab34efc3dcfef441b))

## v0.91.0 — 2026-11-03 · 1 commit

[`99e58cf`](https://github.com/JLRoper/agent-worktree-gui/commit/99e58cf34ace8b8c7f738c44925b26a04ee3fd19) · [compare v0.90.2...v0.91.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.90.2...v0.91.0)

### Added

- feat: the chart draws the top N worktrees, and its arrow says how many are behind it ([`99e58cf`](https://github.com/JLRoper/agent-worktree-gui/commit/99e58cf34ace8b8c7f738c44925b26a04ee3fd19))

## v0.90.2 — 2026-11-03 · 1 commit

[`c7b6912`](https://github.com/JLRoper/agent-worktree-gui/commit/c7b6912c0b3158c5ce0d55427470d2aa0d38f53c) · [compare v0.90.1...v0.90.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.90.1...v0.90.2)

### Fixed

- fix: config.json is written atomically, so a reader never sees it torn (#304) ([`c7b6912`](https://github.com/JLRoper/agent-worktree-gui/commit/c7b6912c0b3158c5ce0d55427470d2aa0d38f53c))

## v0.90.1 — 2026-11-03 · 2 commits

[`9474bf1`](https://github.com/JLRoper/agent-worktree-gui/commit/9474bf15c3aa45cd1b7e3a916905a5d08a3bc30a) · [compare v0.90.0...v0.90.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.90.0...v0.90.1)

### Fixed

- fix: size an approval card from approvals.timeout, not a copied 600 s ([`4e36aa6`](https://github.com/JLRoper/agent-worktree-gui/commit/4e36aa66efe7973ba5425ef54515f656283b4716))

### Other

- chore: 0.90.1 — the review finding over 0.90.0 ([`9474bf1`](https://github.com/JLRoper/agent-worktree-gui/commit/9474bf15c3aa45cd1b7e3a916905a5d08a3bc30a))

## v0.90.0 — 2026-11-03 · 2 commits

[`b8106ed`](https://github.com/JLRoper/agent-worktree-gui/commit/b8106ed5a284707c2a5030b30efd2505d7004e6b) · [compare v0.87.2...v0.90.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.87.2...v0.90.0)

### Fixed

- fix: an approval card keeps the whole window the gateway waits, 600 s by default ([`add38f3`](https://github.com/JLRoper/agent-worktree-gui/commit/add38f3137a1ae3316b187761d280938baae3472))

### Other

- chore: 0.90.0 — the version this landing carries over 0.87.0 ([`b8106ed`](https://github.com/JLRoper/agent-worktree-gui/commit/b8106ed5a284707c2a5030b30efd2505d7004e6b))

## v0.87.2 — 2026-11-03 · 2 commits

[`2e444e0`](https://github.com/JLRoper/agent-worktree-gui/commit/2e444e0ca4abeb17cabeac2e298d486a09947c46) · [compare v0.87.1...v0.87.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.87.1...v0.87.2)

### Docs & tests

- docs: adjudicate the two architectural reviews into one costed seam list ([`3592b1e`](https://github.com/JLRoper/agent-worktree-gui/commit/3592b1e7a623891906817ee790dfe1aec8d842de))
- docs: fold the four reviews into one offline page, and land both missing inputs ([`2e444e0`](https://github.com/JLRoper/agent-worktree-gui/commit/2e444e0ca4abeb17cabeac2e298d486a09947c46))

## v0.87.1 — 2026-11-03 · 1 commit

[`e6e11fb`](https://github.com/JLRoper/agent-worktree-gui/commit/e6e11fbaa5bb1f3ebff204a61e507cfe5616ccaf) · [compare v0.87.0...v0.87.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.87.0...v0.87.1)

### Docs & tests

- docs: measure the top-down architectural review and name every seam of the split ([`e6e11fb`](https://github.com/JLRoper/agent-worktree-gui/commit/e6e11fbaa5bb1f3ebff204a61e507cfe5616ccaf))

## v0.87.0 — 2026-11-03 · 1 commit

[`4f660d2`](https://github.com/JLRoper/agent-worktree-gui/commit/4f660d2ca84278fc4e1bf648d4218a4ab055ea5c) · [compare v0.86.0...v0.87.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.86.0...v0.87.0)

### Added

- feat: every queue card names its project beside the files ([`4f660d2`](https://github.com/JLRoper/agent-worktree-gui/commit/4f660d2ca84278fc4e1bf648d4218a4ab055ea5c))

## v0.86.0 — 2026-11-03 · 2 commits

[`489389d`](https://github.com/JLRoper/agent-worktree-gui/commit/489389d9094e350030acce89d13cce2fe61bf3a9) · [compare v0.85.2...v0.86.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.85.2...v0.86.0)

### Added

- feat: the HUMAN rotation includes an assistant's own question, and opens its float ([`489389d`](https://github.com/JLRoper/agent-worktree-gui/commit/489389d9094e350030acce89d13cce2fe61bf3a9))

### Docs & tests

- docs: 0.85.2 — Assistant-2's task-queue assessment, copied verbatim ([`42ccec4`](https://github.com/JLRoper/agent-worktree-gui/commit/42ccec4c210a7694e7c6f99674d42df2815a40b9))

## v0.85.2 — 2026-11-03 · 4 commits

[`97b17e1`](https://github.com/JLRoper/agent-worktree-gui/commit/97b17e13907664779c35ecbf453e7916593df309) · [compare v0.85.1...v0.85.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.85.1...v0.85.2)

### Added

- feat: tag every version bump, and render CHANGELOG.md between the tags ([`956cb71`](https://github.com/JLRoper/agent-worktree-gui/commit/956cb71e2b70573786ab01300fff35787bdd8049))
- feat: a gate that fails when a version bump has no tag ([`129f81d`](https://github.com/JLRoper/agent-worktree-gui/commit/129f81d981e70736b7b0087431ee935a5cb48ff0))

### Docs & tests

- docs: re-render the changelog on 0.85.0, and anchor the bump main picked up ([`bf41b2f`](https://github.com/JLRoper/agent-worktree-gui/commit/bf41b2f67c000ccb4a8437ee1ce13c627963ed07))
- test: the two rotted harnesses are live gates again, and wired into the runner (#299) ([`97b17e1`](https://github.com/JLRoper/agent-worktree-gui/commit/97b17e13907664779c35ecbf453e7916593df309))

## v0.85.1 — 2026-11-03 · 2 commits

[`163fed3`](https://github.com/JLRoper/agent-worktree-gui/commit/163fed33db6966505c086bc1f134aae56e4a78be) · [compare v0.85.0...v0.85.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.85.0...v0.85.1)

### Added

- feat: Settings → Gateway saves OpenRouter profiles and restarts either process on its own press ([`03b3ff0`](https://github.com/JLRoper/agent-worktree-gui/commit/03b3ff0b07674fe9c401c94a7e2250aa0006238d))

### Fixed

- fix: the stale-worktree threshold commits on Enter, and the tail chip is written once (#295) ([`163fed3`](https://github.com/JLRoper/agent-worktree-gui/commit/163fed33db6966505c086bc1f134aae56e4a78be))

## v0.85.0 — 2026-11-03 · 1 commit

[`44cb6a8`](https://github.com/JLRoper/agent-worktree-gui/commit/44cb6a8d31dd6a5b0eadaa2143b537022e06cdb5) · [compare v0.84.0...v0.85.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.84.0...v0.85.0)

### Docs & tests

- test: the minimized composer block, driven in a real browser at two window heights ([`44cb6a8`](https://github.com/JLRoper/agent-worktree-gui/commit/44cb6a8d31dd6a5b0eadaa2143b537022e06cdb5))

## v0.84.0 — 2026-11-03 · 1 commit

[`cc61bb9`](https://github.com/JLRoper/agent-worktree-gui/commit/cc61bb9e76b961222adcb8243df3828e967f9342) · [compare v0.83.0...v0.84.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.83.0...v0.84.0)

### Added

- feat: a card with every turn folded puts the composer block under its head ([`cc61bb9`](https://github.com/JLRoper/agent-worktree-gui/commit/cc61bb9e76b961222adcb8243df3828e967f9342))

## v0.83.0 — 2026-11-03 · 2 commits

[`a99883f`](https://github.com/JLRoper/agent-worktree-gui/commit/a99883f7a0825fabd81a4bb5e75a48242d3282ce) · [compare v0.82.0...v0.83.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.82.0...v0.83.0)

### Added

- feat: a HUMAN button beside NOT-RUNNING cycles every open permission and clarify question ([`a99883f`](https://github.com/JLRoper/agent-worktree-gui/commit/a99883f7a0825fabd81a4bb5e75a48242d3282ce))

### Fixed

- fix: the pipeline window's move press reads the stage SELECT, not the first stage row ([`92e8735`](https://github.com/JLRoper/agent-worktree-gui/commit/92e8735a8a73fc32afe3ebda353c26aa3348a5eb))

## v0.82.0 — 2026-11-03 · 1 commit

[`298fa1e`](https://github.com/JLRoper/agent-worktree-gui/commit/298fa1e46a2ddb8177a18460bb57c7a8086e4277) · [compare v0.81.0...v0.82.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.81.0...v0.82.0)

### Docs & tests

- test: the task pipeline window, end to end in a real browser — 47 cases, and the move press is dead ([`298fa1e`](https://github.com/JLRoper/agent-worktree-gui/commit/298fa1e46a2ddb8177a18460bb57c7a8086e4277))

## v0.81.0 — 2026-11-03 · 3 commits

[`4102020`](https://github.com/JLRoper/agent-worktree-gui/commit/4102020c8c837f14c4767e5326145202035e1f73) · [compare v0.80.0...v0.81.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.80.0...v0.81.0)

### Added

- feat: a task can be put on a pipeline — the control, the write, and the studio's own seed ([`6da7bad`](https://github.com/JLRoper/agent-worktree-gui/commit/6da7badb88175fa69b6ca39d22ae841b1d4788dc))
- feat: the Pipeline tab edits the catalogue, and /api/pipelines reads and saves it ([`4102020`](https://github.com/JLRoper/agent-worktree-gui/commit/4102020c8c837f14c4767e5326145202035e1f73))

### Fixed

- fix: an uncomputable time in stage is shown as unknown, not counted up from the open ([`00a6703`](https://github.com/JLRoper/agent-worktree-gui/commit/00a67035ef2a27bb27eae86cbd49396db7e0e591))

## v0.80.0 — 2026-11-03 · 5 commits

[`c5aa9f7`](https://github.com/JLRoper/agent-worktree-gui/commit/c5aa9f7effd637956aaea6eddfe6489e3fb62889) · [compare v0.79.1...v0.80.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.79.1...v0.80.0)

### Added

- feat: the panel can read a studio pipeline bundle, and say where a task sits in it ([`531115b`](https://github.com/JLRoper/agent-worktree-gui/commit/531115b5e19eb835fc9625a46d6162d8f64e81a9))
- feat: a task's pipeline reads as one window model — every stage, its gate, and time in stage ([`affbd9a`](https://github.com/JLRoper/agent-worktree-gui/commit/affbd9a0b42efe47f740b046fdf5aab4e350cf7d))
- feat: a Queue row opens its pipeline window — stages in order, the current one marked, an unresolved record named ([`56492a1`](https://github.com/JLRoper/agent-worktree-gui/commit/56492a145bb63e32ab1c19e28b353f61f3c95705))

### Docs & tests

- test: a browser gate for the task pipeline window — 46 checks over four records, and 0/8 on the base ([`e4122ec`](https://github.com/JLRoper/agent-worktree-gui/commit/e4122ecd66b116990a687a5837523e0ff41ec968))

### Other

- chore: 0.80.0 — the task pipeline window, and the script that proves it ([`c5aa9f7`](https://github.com/JLRoper/agent-worktree-gui/commit/c5aa9f7effd637956aaea6eddfe6489e3fb62889))

## v0.79.1 — 2026-11-03 · 2 commits

[`3a1d164`](https://github.com/JLRoper/agent-worktree-gui/commit/3a1d1649ca7f97ea41d57d429602c3c670c8d11a) · [compare v0.79.0...v0.79.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.79.0...v0.79.1)

### Fixed

- fix: keep the assistant chat's last message above the composer ([`3a1d164`](https://github.com/JLRoper/agent-worktree-gui/commit/3a1d1649ca7f97ea41d57d429602c3c670c8d11a))

### Docs & tests

- test: measure 0.78.1 against 0.75.0 on one identical 200-row board ([`9a6e4c8`](https://github.com/JLRoper/agent-worktree-gui/commit/9a6e4c8ae9b4ef736e937b582eaa5cac3b7549ae))

## v0.79.0 — 2026-11-03 · 1 commit

[`2700cc4`](https://github.com/JLRoper/agent-worktree-gui/commit/2700cc4de418ef35ffc93476a1dbcc7f1d4330ae) · [compare v0.78.2...v0.79.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.78.2...v0.79.0)

### Docs & tests

- test: profile the four reader-facing paths on a seeded 201-row store ([`2700cc4`](https://github.com/JLRoper/agent-worktree-gui/commit/2700cc4de418ef35ffc93476a1dbcc7f1d4330ae))

## v0.78.2 — 2026-11-03 · 1 commit

[`7836d71`](https://github.com/JLRoper/agent-worktree-gui/commit/7836d7107d5be70102d14522eb71b0fb423bfb37) · [compare v0.78.1...v0.78.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.78.1...v0.78.2)

### Docs & tests

- docs: efficiency review of the 0.75.0..0.78.1 delta ([`7836d71`](https://github.com/JLRoper/agent-worktree-gui/commit/7836d7107d5be70102d14522eb71b0fb423bfb37))

## v0.78.1 — 2026-11-03 · 3 commits

[`fd36130`](https://github.com/JLRoper/agent-worktree-gui/commit/fd36130900d116dd1833984f11f6077ea64643b9) · [compare v0.78.0...v0.78.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.78.0...v0.78.1)

### Fixed

- fix: a configured remote the checkout lacks falls back to origin, so every row stops reading NO BASE REF ([`fd36130`](https://github.com/JLRoper/agent-worktree-gui/commit/fd36130900d116dd1833984f11f6077ea64643b9))

### Docs & tests

- docs: playwright round 1 — every verdict in agent-worktree-gui reads NO BASE REF ([`74395a2`](https://github.com/JLRoper/agent-worktree-gui/commit/74395a2f534072b3850d2afbcaaa8ae046626af3))
- docs: name the contrast instance in round 1's report ([`9c00028`](https://github.com/JLRoper/agent-worktree-gui/commit/9c00028f0284a95e39bbe2f8848c81f15c51929d))

## v0.78.0 — 2026-11-03 · 1 commit

[`e544b43`](https://github.com/JLRoper/agent-worktree-gui/commit/e544b436c37955fa955c378ce342417e4d6a76f7) · [compare v0.77.2...v0.78.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.77.2...v0.78.0)

### Added

- feat: the console draws the agent's markdown, with a raw view and a focus control ([`e544b43`](https://github.com/JLRoper/agent-worktree-gui/commit/e544b436c37955fa955c378ce342417e4d6a76f7))

## v0.77.2 — 2026-11-03 · 4 commits

[`4ba624e`](https://github.com/JLRoper/agent-worktree-gui/commit/4ba624e47192545b375e872db90f4a719bd640a4) · [compare v0.77.1...v0.77.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.77.1...v0.77.2)

### Fixed

- fix: a held drag scrolls the queue's pane, so a card lands where the pointer is ([`a25f134`](https://github.com/JLRoper/agent-worktree-gui/commit/a25f134ed7ed03773f4f8535df7fac315ed9516d))
- fix: a refused drop keeps its reason in view while the queue is scrolled ([`f285fb9`](https://github.com/JLRoper/agent-worktree-gui/commit/f285fb90088669ba7d91c3cdc687ccd0999948b9))

### Docs & tests

- test: a person-level drag gate proves the lift, the edge drop and the refusal, red on 0.77.1 ([`3f5a104`](https://github.com/JLRoper/agent-worktree-gui/commit/3f5a10404e5099638700124aee3502f958679834))

### Other

- chore: 0.77.2 — the patch over main's 0.77.1 ([`4ba624e`](https://github.com/JLRoper/agent-worktree-gui/commit/4ba624e47192545b375e872db90f4a719bd640a4))

## v0.77.1 — 2026-11-03 · 2 commits

[`c652f51`](https://github.com/JLRoper/agent-worktree-gui/commit/c652f51efed9ea2ba52ce15459e8e304aaf5eb0d) · [compare v0.77.0...v0.77.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.77.0...v0.77.1)

### Fixed

- fix: a restart entry fires once, and a replay is refused by name ([`c652f51`](https://github.com/JLRoper/agent-worktree-gui/commit/c652f51efed9ea2ba52ce15459e8e304aaf5eb0d))

### Docs & tests

- docs: a read-only visual audit of the assistant queue pane ([`9581cef`](https://github.com/JLRoper/agent-worktree-gui/commit/9581cef862fa482cd965558c47eeea01cb592890))

## v0.77.0 — 2026-11-03 · 3 commits

[`ab2db8c`](https://github.com/JLRoper/agent-worktree-gui/commit/ab2db8c4a1024f364854ed9b58ecb5f552e1f3b2) · [compare v0.76.0...v0.77.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.76.0...v0.77.0)

### Fixed

- fix: the parked turn's card stops offering a steer the gateway refuses ([`73fd0fb`](https://github.com/JLRoper/agent-worktree-gui/commit/73fd0fb5b6dcc4041d23d5480f97e4fd946b8947))

### Docs & tests

- test: a gate proves the three steer refusals, red on 0.74.0 ([`c74a1af`](https://github.com/JLRoper/agent-worktree-gui/commit/c74a1af0cbea54260453899bf20b2b6c1852bca3))

### Other

- chore: 0.77.0 — the patch over main's 0.76.0 ([`ab2db8c`](https://github.com/JLRoper/agent-worktree-gui/commit/ab2db8c4a1024f364854ed9b58ecb5f552e1f3b2))

## v0.76.0 — 2026-11-03 · 5 commits

[`eeec9fe`](https://github.com/JLRoper/agent-worktree-gui/commit/eeec9febce07223d40bd6aca2557d42adadfa9ee) · [compare v0.75.0...v0.76.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.75.0...v0.76.0)

### Fixed

- fix: a hold-less park whose reason names a done row says the reason is stale ([`6e7f7b6`](https://github.com/JLRoper/agent-worktree-gui/commit/6e7f7b695b897cdadbe370ed7c0289d270119bf7))
- fix: a sentry pass that throws cannot skip the queue sweep ([`1ea2821`](https://github.com/JLRoper/agent-worktree-gui/commit/1ea282129c40396e1201e0041f77c869f035f198))

### Docs & tests

- test: a gate proves the question chip on a parked row, red on 0.73.3 ([`35b3c82`](https://github.com/JLRoper/agent-worktree-gui/commit/35b3c825488618737f77ef97d9dd36ab9248b307))
- test: a gate proves a stale park reason and a sweep a failed pass cannot skip, red on 0.75.0 ([`c66aaa8`](https://github.com/JLRoper/agent-worktree-gui/commit/c66aaa8aea89456df852df111b618d8b61f6e091))

### Other

- chore: 0.76.0 — the patch over main's 0.75.0 ([`eeec9fe`](https://github.com/JLRoper/agent-worktree-gui/commit/eeec9febce07223d40bd6aca2557d42adadfa9ee))

## v0.75.0 — 2026-11-02 · 1 commit

[`dd11c9f`](https://github.com/JLRoper/agent-worktree-gui/commit/dd11c9f9aa2dc7d52043b15bf05ae8e16ac082d5) · [compare v0.74.0...v0.75.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.74.0...v0.75.0)

### Added

- feat: a row parked on a question wears a question chip ([`dd11c9f`](https://github.com/JLRoper/agent-worktree-gui/commit/dd11c9f9aa2dc7d52043b15bf05ae8e16ac082d5))

## v0.74.0 — 2026-11-02 · 2 commits

[`88703ca`](https://github.com/JLRoper/agent-worktree-gui/commit/88703ca229897bf1a892b5d8e8b2f89908df27fd) · [compare v0.73.9...v0.74.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.9...v0.74.0)

### Added

- feat: the agent card draws its tree's pipeline chip ([`dbccd43`](https://github.com/JLRoper/agent-worktree-gui/commit/dbccd433dc1a84be4e19dc88042e21cb78206556))

### Docs & tests

- test: a gate proves the pipeline chip's three states, red on 0.73.3 ([`88703ca`](https://github.com/JLRoper/agent-worktree-gui/commit/88703ca229897bf1a892b5d8e8b2f89908df27fd))

## v0.73.9 — 2026-11-02 · 1 commit

[`f75164c`](https://github.com/JLRoper/agent-worktree-gui/commit/f75164c0e8e6b5ca06d56dd256ac85867d7d6339) · [compare v0.73.8...v0.73.9](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.8...v0.73.9)

### Other

- Record why a parked turn offered a steer the gateway refused ([`f75164c`](https://github.com/JLRoper/agent-worktree-gui/commit/f75164c0e8e6b5ca06d56dd256ac85867d7d6339))

## v0.73.8 — 2026-11-02 · 1 commit

[`d86ca81`](https://github.com/JLRoper/agent-worktree-gui/commit/d86ca819ebdcf10c6abe8432c6474a2cf0acb82c) · [compare v0.73.7...v0.73.8](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.7...v0.73.8)

### Fixed

- fix: a wake walks the roster to the first assistant whose last run is not failed ([`d86ca81`](https://github.com/JLRoper/agent-worktree-gui/commit/d86ca819ebdcf10c6abe8432c6474a2cf0acb82c))

## v0.73.7 — 2026-11-02 · 1 commit

[`26c3b14`](https://github.com/JLRoper/agent-worktree-gui/commit/26c3b1407c0f8fd31bf93a119d6444257efcc05a) · [compare v0.73.6...v0.73.7](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.6...v0.73.7)

### Fixed

- fix: a narrow reply box wraps its action row instead of breaking its labels (#273) ([`26c3b14`](https://github.com/JLRoper/agent-worktree-gui/commit/26c3b1407c0f8fd31bf93a119d6444257efcc05a))

## v0.73.6 — 2026-11-02 · 1 commit

[`e97291f`](https://github.com/JLRoper/agent-worktree-gui/commit/e97291f71221b1ee526585eeaeb10b31982c3c90) · [compare v0.73.5...v0.73.6](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.5...v0.73.6)

### Other

- Stop the wait-stage paragraph claiming 1h10m fails a card at the 7200s cap (#272) ([`e97291f`](https://github.com/JLRoper/agent-worktree-gui/commit/e97291f71221b1ee526585eeaeb10b31982c3c90))

## v0.73.5 — 2026-11-02 · 1 commit

[`5bd5425`](https://github.com/JLRoper/agent-worktree-gui/commit/5bd5425b2de4093c0d1a5e1e086b624f34ab8afc) · [compare v0.73.4...v0.73.5](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.4...v0.73.5)

### Docs & tests

- docs: the panel's own pages still quote a 3600s run cap, not the landed 7200 (#271) ([`5bd5425`](https://github.com/JLRoper/agent-worktree-gui/commit/5bd5425b2de4093c0d1a5e1e086b624f34ab8afc))

## v0.73.4 — 2026-11-02 · 2 commits

[`55a8e45`](https://github.com/JLRoper/agent-worktree-gui/commit/55a8e456b6928e1d4be7400edb757a1e0012f5ab) · [compare v0.73.3...v0.73.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.3...v0.73.4)

### Fixed

- fix: raise the panel's run cap to 7200s so a long card is not killed at 60 minutes ([`73a7c92`](https://github.com/JLRoper/agent-worktree-gui/commit/73a7c92da20c1e6d82ef8e1448bb1725e6b119f5))

### Other

- chore: 0.73.4 — the patch over main's 0.73.3 ([`55a8e45`](https://github.com/JLRoper/agent-worktree-gui/commit/55a8e456b6928e1d4be7400edb757a1e0012f5ab))

## v0.73.3 — 2026-11-02 · 4 commits

[`9c15e57`](https://github.com/JLRoper/agent-worktree-gui/commit/9c15e576dc7ea1428ec0f7797dfc0f18c6956a52) · [compare v0.73.2...v0.73.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.2...v0.73.3)

### Fixed

- fix: a cancelled drag puts the card back instead of reordering ([`e927cc4`](https://github.com/JLRoper/agent-worktree-gui/commit/e927cc48fd840c7adfdbc733934ce66849b2b004))
- fix: the turn pager's count holds one line in the docked rail ([`3a0bf33`](https://github.com/JLRoper/agent-worktree-gui/commit/3a0bf3323525a0831aa7c8c611658acf2de10e8d))

### Docs & tests

- test: a gate pins the pager's count to one line in the rail, and fails on main ([`60fa173`](https://github.com/JLRoper/agent-worktree-gui/commit/60fa173015c901c083741e59b860ae4341e34913))

### Other

- chore: 0.73.3 — the patch over main's 0.73.2 ([`9c15e57`](https://github.com/JLRoper/agent-worktree-gui/commit/9c15e576dc7ea1428ec0f7797dfc0f18c6956a52))

## v0.73.2 — 2026-11-02 · 4 commits

[`7d516d3`](https://github.com/JLRoper/agent-worktree-gui/commit/7d516d3bf223a8da7d6a836a6af55ad9cafb2dfc) · [compare v0.73.1...v0.73.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.1...v0.73.2)

### Added

- feat: a task carries its order, and one write reorders the queue ([`6e956c0`](https://github.com/JLRoper/agent-worktree-gui/commit/6e956c0d680953f1a0ed57946ce4e4bbdfeb978a))
- feat: the queue cards drag into the reader's order, blocked by a hold ([`23a14a1`](https://github.com/JLRoper/agent-worktree-gui/commit/23a14a12c27f2eb032169fed04854bbbcc1a0cd8))

### Docs & tests

- test: the drag persisted, the held drop refused, and the click that still opens ([`644aae1`](https://github.com/JLRoper/agent-worktree-gui/commit/644aae13cc117ed5f02bd92223f0676cc1f861f5))

### Other

- chore: 0.73.2 — the patch over main's 0.73.1 ([`7d516d3`](https://github.com/JLRoper/agent-worktree-gui/commit/7d516d3bf223a8da7d6a836a6af55ad9cafb2dfc))

## v0.73.1 — 2026-11-02 · 1 commit

[`dfee4ac`](https://github.com/JLRoper/agent-worktree-gui/commit/dfee4acb2a5c8c7cdb395d096fd8ecf745c30838) · [compare v0.73.0...v0.73.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.73.0...v0.73.1)

### Added

- feat: a SPAWN that names a queue row writes it at the cut ([`dfee4ac`](https://github.com/JLRoper/agent-worktree-gui/commit/dfee4acb2a5c8c7cdb395d096fd8ecf745c30838))

## v0.73.0 — 2026-11-02 · 1 commit

[`178ce9b`](https://github.com/JLRoper/agent-worktree-gui/commit/178ce9b4b896b2e6fa23c718bf52bb85de3b413c) · [compare v0.72.5...v0.73.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.72.5...v0.73.0)

### Added

- feat: dogfood the assistant chat pane from a headless browser on its own panel ([`178ce9b`](https://github.com/JLRoper/agent-worktree-gui/commit/178ce9b4b896b2e6fa23c718bf52bb85de3b413c))

## v0.72.5 — 2026-11-02 · 2 commits

[`64f5339`](https://github.com/JLRoper/agent-worktree-gui/commit/64f5339c4be30d3cf4b2fc56a2c8339fcda1e58f) · [compare v0.72.4...v0.72.5](https://github.com/JLRoper/agent-worktree-gui/compare/v0.72.4...v0.72.5)

### Fixed

- fix: the Permissions head gives the pill its own column, and every file:line one line ([`fc749cb`](https://github.com/JLRoper/agent-worktree-gui/commit/fc749cb8404e40eab1f05ce48da040fbae43748d))

### Other

- chore: 0.72.5 — the patch over main's 0.72.4 ([`64f5339`](https://github.com/JLRoper/agent-worktree-gui/commit/64f5339c4be30d3cf4b2fc56a2c8339fcda1e58f))

## v0.72.4 — 2026-11-02 · 3 commits

[`2d24432`](https://github.com/JLRoper/agent-worktree-gui/commit/2d24432d3a3f5c8bfaf3e1395851b5a208ba19af) · [compare v0.72.3...v0.72.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.72.3...v0.72.4)

### Fixed

- fix: a TODO tail only rides a run whose directory is a tree ([`edf3e67`](https://github.com/JLRoper/agent-worktree-gui/commit/edf3e6769aed0e2c528b3c9277c37f4d8ea797e9))

### Docs & tests

- test: a state dir and a tree-less directory get no TODO tail, a real tree keeps it ([`c1a2cea`](https://github.com/JLRoper/agent-worktree-gui/commit/c1a2ceae5450c224f0f9af3c245fe36dffc3fec4))

### Other

- chore: 0.72.4 — the patch over main's 0.72.3 ([`2d24432`](https://github.com/JLRoper/agent-worktree-gui/commit/2d24432d3a3f5c8bfaf3e1395851b5a208ba19af))

## v0.72.3 — 2026-11-02 · 1 commit

[`1a8efc0`](https://github.com/JLRoper/agent-worktree-gui/commit/1a8efc05af045b178e9c76d0c2c031aa7b2b2775) · [compare v0.72.2...v0.72.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.72.2...v0.72.3)

### Changed

- style: queue rows are cards, and "unowned" is gone ([`1a8efc0`](https://github.com/JLRoper/agent-worktree-gui/commit/1a8efc05af045b178e9c76d0c2c031aa7b2b2775))

## v0.72.2 — 2026-11-02 · 2 commits

[`2d45d6c`](https://github.com/JLRoper/agent-worktree-gui/commit/2d45d6cdb432c5794efcf130e3ac8327b93439e8) · [compare v0.72.1...v0.72.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.72.1...v0.72.2)

### Fixed

- fix: a park carries a testable hold, and a lane orders rows that share a file ([`c51ebbc`](https://github.com/JLRoper/agent-worktree-gui/commit/c51ebbc0bd31c9d9d0c485ebe3e18abb66c9bb2c))

### Other

- chore: 0.72.2 — the patch over main's 0.72.1 ([`2d45d6c`](https://github.com/JLRoper/agent-worktree-gui/commit/2d45d6cdb432c5794efcf130e3ac8327b93439e8))

## v0.72.1 — 2026-11-02 · 2 commits

[`02f15c3`](https://github.com/JLRoper/agent-worktree-gui/commit/02f15c33e0b01005d330060853ee6cc4895a1934) · [compare v0.72.0...v0.72.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.72.0...v0.72.1)

### Fixed

- fix: an attached file on the reader's message reaches the worker a SPAWN starts ([`02f15c3`](https://github.com/JLRoper/agent-worktree-gui/commit/02f15c33e0b01005d330060853ee6cc4895a1934))

### Docs & tests

- test: the tiered collapse, five presses named, and five real keydowns on a page ([`7a3eca7`](https://github.com/JLRoper/agent-worktree-gui/commit/7a3eca7006859dd277cd35e0f3a1e77f7292e43b))

## v0.72.0 — 2026-11-02 · 1 commit

[`23b8b12`](https://github.com/JLRoper/agent-worktree-gui/commit/23b8b126aee2704a1e92ae687cb8cd8c40c86e3d) · [compare v0.71.2...v0.72.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.71.2...v0.72.0)

### Fixed

- fix: Ctrl+[ folds one tier per press, from the lowest open tier up ([`23b8b12`](https://github.com/JLRoper/agent-worktree-gui/commit/23b8b126aee2704a1e92ae687cb8cd8c40c86e3d))

## v0.71.2 — 2026-11-02 · 3 commits

[`8eb2bf0`](https://github.com/JLRoper/agent-worktree-gui/commit/8eb2bf0f55ab0f84e7e4d24d1814eda65870809a) · [compare v0.71.1...v0.71.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.71.1...v0.71.2)

### Fixed

- fix: a refused wake gives the finish's claim back ([`76480fb`](https://github.com/JLRoper/agent-worktree-gui/commit/76480fb4eb4ee2498e4e6fdfd802f2525cf35f75))

### Docs & tests

- test: the refused wake, the same finish, and the claim that was unpaid ([`b0b2d9e`](https://github.com/JLRoper/agent-worktree-gui/commit/b0b2d9ee1e68502373809f80478aa0479abd1e62))

### Other

- chore: 0.71.2 — the patch over main's 0.71.1 ([`8eb2bf0`](https://github.com/JLRoper/agent-worktree-gui/commit/8eb2bf0f55ab0f84e7e4d24d1814eda65870809a))

## v0.71.1 — 2026-11-02 · 1 commit

[`c8087f4`](https://github.com/JLRoper/agent-worktree-gui/commit/c8087f4fcd43cd41af387bde26833410607fd71a) · [compare v0.71.0...v0.71.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.71.0...v0.71.1)

### Fixed

- fix: the review card's Keep is the full-width bar, above Unwind ([`c8087f4`](https://github.com/JLRoper/agent-worktree-gui/commit/c8087f4fcd43cd41af387bde26833410607fd71a))

## v0.71.0 — 2026-11-02 · 3 commits

[`c57001b`](https://github.com/JLRoper/agent-worktree-gui/commit/c57001b832cad18d68963e26d090d3ab3881c376) · [compare v0.70.2...v0.71.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.70.2...v0.71.0)

### Added

- feat: a parent collapsed for N seconds minimizes every card under it ([`c57001b`](https://github.com/JLRoper/agent-worktree-gui/commit/c57001b832cad18d68963e26d090d3ab3881c376))

### Docs & tests

- docs: a queue row parks with a hold, and releases when the hold stops being true ([`e311c79`](https://github.com/JLRoper/agent-worktree-gui/commit/e311c79e27554232910b28900aee53a999f1c92f))
- test: the collapse cascade on fake timers, and the page driven both ways ([`ab9a323`](https://github.com/JLRoper/agent-worktree-gui/commit/ab9a323486ba5cd7e1ce5816d4e139940a945ef4))

## v0.70.2 — 2026-11-02 · 1 commit

[`b959957`](https://github.com/JLRoper/agent-worktree-gui/commit/b95995701ba6bdc855680f4bd9ebfe753036d3e4) · [compare v0.70.1...v0.70.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.70.1...v0.70.2)

### Fixed

- fix: the board digest stops riding every turn ([`b959957`](https://github.com/JLRoper/agent-worktree-gui/commit/b95995701ba6bdc855680f4bd9ebfe753036d3e4))

## v0.70.1 — 2026-11-02 · 1 commit

[`01947d6`](https://github.com/JLRoper/agent-worktree-gui/commit/01947d65cbe97eae3d86b883bdfedf8c279e4e44) · [compare v0.70.0...v0.70.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.70.0...v0.70.1)

### Fixed

- fix: the Permissions tab reads the config this instance booted on ([`01947d6`](https://github.com/JLRoper/agent-worktree-gui/commit/01947d65cbe97eae3d86b883bdfedf8c279e4e44))

## v0.70.0 — 2026-11-02 · 1 commit

[`a12c737`](https://github.com/JLRoper/agent-worktree-gui/commit/a12c7375fdce5c0bec0508275f68bd000c50c807) · [compare v0.69.3...v0.70.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.69.3...v0.70.0)

### Added

- feat: Permissions reads what is in force, and where it is written ([`a12c737`](https://github.com/JLRoper/agent-worktree-gui/commit/a12c7375fdce5c0bec0508275f68bd000c50c807))

## v0.69.3 — 2026-11-02 · 2 commits

[`9b253cf`](https://github.com/JLRoper/agent-worktree-gui/commit/9b253cfa3923057cb44f7ef897b60b331904604a) · [compare v0.69.2...v0.69.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.69.2...v0.69.3)

### Fixed

- fix: the long tier is sent once a session, not on every turn ([`d48597f`](https://github.com/JLRoper/agent-worktree-gui/commit/d48597f101e6451ed0a48ab72bf0742a2c683956))

### Other

- tools: measure what a turn's preamble costs on a sandbox panel ([`9b253cf`](https://github.com/JLRoper/agent-worktree-gui/commit/9b253cfa3923057cb44f7ef897b60b331904604a))

## v0.69.2 — 2026-11-02 · 1 commit

[`07ae700`](https://github.com/JLRoper/agent-worktree-gui/commit/07ae700e82c2b65374a629acae5349a58a253d1d) · [compare v0.69.1...v0.69.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.69.1...v0.69.2)

### Other

- Make the wake budget cover sweeps and never an event ([`07ae700`](https://github.com/JLRoper/agent-worktree-gui/commit/07ae700e82c2b65374a629acae5349a58a253d1d))

## v0.69.1 — 2026-11-02 · 1 commit

[`8a2b170`](https://github.com/JLRoper/agent-worktree-gui/commit/8a2b170000f6ab4be80de1f152a6b7420185ee5b) · [compare v0.69.0...v0.69.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.69.0...v0.69.1)

### Docs & tests

- docs: what a sweep is, and why an event is never one ([`8a2b170`](https://github.com/JLRoper/agent-worktree-gui/commit/8a2b170000f6ab4be80de1f152a6b7420185ee5b))

## v0.69.0 — 2026-11-02 · 1 commit

[`c2f48aa`](https://github.com/JLRoper/agent-worktree-gui/commit/c2f48aaa2e97061979ff1d9a49c5c8ddef82b145) · [compare v0.68.10...v0.69.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.10...v0.69.0)

### Fixed

- fix: the controls own the head's corner, the name owns the cwd row ([`c2f48aa`](https://github.com/JLRoper/agent-worktree-gui/commit/c2f48aaa2e97061979ff1d9a49c5c8ddef82b145))

## v0.68.10 — 2026-11-02 · 2 commits

[`cee444f`](https://github.com/JLRoper/agent-worktree-gui/commit/cee444f4b4e10a3f784bca1822e0189c62153dba) · [compare v0.68.9...v0.68.10](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.9...v0.68.10)

### Docs & tests

- docs: what the gateway spends, measured on the live board ([`6616867`](https://github.com/JLRoper/agent-worktree-gui/commit/661686746629c6165db703577d87b8d60842df71))
- docs: the three gateway changes, with event wakes left uncapped ([`cee444f`](https://github.com/JLRoper/agent-worktree-gui/commit/cee444f4b4e10a3f784bca1822e0189c62153dba))

## v0.68.9 — 2026-11-02 · 1 commit

[`1036a38`](https://github.com/JLRoper/agent-worktree-gui/commit/1036a381e8a1abb5918804e446d10b27ed9df903) · [compare v0.68.8...v0.68.9](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.8...v0.68.9)

### Fixed

- fix: the Settings tab strip reads at a glance, not at 9.5px ([`1036a38`](https://github.com/JLRoper/agent-worktree-gui/commit/1036a381e8a1abb5918804e446d10b27ed9df903))

## v0.68.8 — 2026-11-02 · 2 commits

[`12f915e`](https://github.com/JLRoper/agent-worktree-gui/commit/12f915e5f6d8f1c84f6c1bc3d73f73c7b01a16bf) · [compare v0.68.7...v0.68.8](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.7...v0.68.8)

### Docs & tests

- docs: cost the stage-contract integration and its order ([`7ccdc76`](https://github.com/JLRoper/agent-worktree-gui/commit/7ccdc7649de8270addf78a25fbb016399620fbad))
- docs: reconcile a second independent pass on the stage contract ([`12f915e`](https://github.com/JLRoper/agent-worktree-gui/commit/12f915e5f6d8f1c84f6c1bc3d73f73c7b01a16bf))

## v0.68.7 — 2026-11-02 · 1 commit

[`5d58d21`](https://github.com/JLRoper/agent-worktree-gui/commit/5d58d213cc1e803781a94d2e47889a3223ab5587) · [compare v0.68.6...v0.68.7](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.6...v0.68.7)

### Docs & tests

- docs: what a stage hands its agent, and what a run actually receives ([`5d58d21`](https://github.com/JLRoper/agent-worktree-gui/commit/5d58d213cc1e803781a94d2e47889a3223ab5587))

## v0.68.6 — 2026-11-02 · 2 commits

[`9d4e9b8`](https://github.com/JLRoper/agent-worktree-gui/commit/9d4e9b823f7cca1f3a60a6078bb3c64e7c447b61) · [compare v0.68.5...v0.68.6](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.5...v0.68.6)

### Docs & tests

- test: the husk, the unregistered path and the live cwd, failing-first ([`1251c56`](https://github.com/JLRoper/agent-worktree-gui/commit/1251c567749ed0e40c41b4bb01ff94f5df09ca3a))
- docs: the stage contract against the panel's pipeline model ([`9d4e9b8`](https://github.com/JLRoper/agent-worktree-gui/commit/9d4e9b823f7cca1f3a60a6078bb3c64e7c447b61))

## v0.68.5 — 2026-11-02 · 1 commit

[`5f110b8`](https://github.com/JLRoper/agent-worktree-gui/commit/5f110b8f9f4e731bc14516487a967b6ac7e8fd2d) · [compare v0.68.4...v0.68.5](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.4...v0.68.5)

### Fixed

- fix: a husk is tree gone, and a live tree is never offered for deletion ([`5f110b8`](https://github.com/JLRoper/agent-worktree-gui/commit/5f110b8f9f4e731bc14516487a967b6ac7e8fd2d))

## v0.68.4 — 2026-11-02 · 1 commit

[`b4ee813`](https://github.com/JLRoper/agent-worktree-gui/commit/b4ee8132f0a65209b4eabc30e5de652c7134909f) · [compare v0.68.3...v0.68.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.3...v0.68.4)

### Fixed

- fix: the child cut writes its rung, and a padded hole is still a hole ([`b4ee813`](https://github.com/JLRoper/agent-worktree-gui/commit/b4ee8132f0a65209b4eabc30e5de652c7134909f))

## v0.68.3 — 2026-11-02 · 1 commit

[`a0ecde3`](https://github.com/JLRoper/agent-worktree-gui/commit/a0ecde3ca06942e6f0d29f036f183414450fcd8b) · [compare v0.68.2...v0.68.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.2...v0.68.3)

### Added

- feat: draw the pipeline catalogue as one self-contained page ([`a0ecde3`](https://github.com/JLRoper/agent-worktree-gui/commit/a0ecde3ca06942e6f0d29f036f183414450fcd8b))

## v0.68.2 — 2026-11-02 · 1 commit

[`e0ae8a4`](https://github.com/JLRoper/agent-worktree-gui/commit/e0ae8a42c87958b022c92a0b90f7c8d017d17081) · [compare v0.68.1...v0.68.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.1...v0.68.2)

### Fixed

- fix: the four P0 findings in the pipelines audit ([`e0ae8a4`](https://github.com/JLRoper/agent-worktree-gui/commit/e0ae8a42c87958b022c92a0b90f7c8d017d17081))

## v0.68.1 — 2026-11-02 · 2 commits

[`1cb8773`](https://github.com/JLRoper/agent-worktree-gui/commit/1cb87731dddcfdfff1b954540aca2534c4f7844c) · [compare v0.68.0...v0.68.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.68.0...v0.68.1)

### Docs & tests

- test: the skills gate drives the grouping, its counts, its folds and its filter ([`55eb271`](https://github.com/JLRoper/agent-worktree-gui/commit/55eb2713c753928e445b5617e53865f9a2dcebd0))
- docs: add the child-cut and spaced-hole P0s to the pipeline audit ([`1cb8773`](https://github.com/JLRoper/agent-worktree-gui/commit/1cb87731dddcfdfff1b954540aca2534c4f7844c))

## v0.68.0 — 2026-11-02 · 1 commit

[`c879e30`](https://github.com/JLRoper/agent-worktree-gui/commit/c879e303e8e4e1cd41f6a63b7763c07798689fbc) · [compare v0.67.6...v0.68.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.67.6...v0.68.0)

### Added

- feat: the Skills tab groups by source then category, folds both, and filters ([`c879e30`](https://github.com/JLRoper/agent-worktree-gui/commit/c879e303e8e4e1cd41f6a63b7763c07798689fbc))

## v0.67.6 — 2026-11-02 · 1 commit

[`d34794b`](https://github.com/JLRoper/agent-worktree-gui/commit/d34794b5baf2f0795d085476411c35b101b3200e) · [compare v0.67.5...v0.67.6](https://github.com/JLRoper/agent-worktree-gui/compare/v0.67.5...v0.67.6)

### Docs & tests

- docs: audit the pipeline data model against its spec ([`d34794b`](https://github.com/JLRoper/agent-worktree-gui/commit/d34794b5baf2f0795d085476411c35b101b3200e))

## v0.67.5 — 2026-11-02 · 1 commit

[`804ed4e`](https://github.com/JLRoper/agent-worktree-gui/commit/804ed4e3bcef19ee7836235a935b85a2e8fe7822) · [compare v0.67.4...v0.67.5](https://github.com/JLRoper/agent-worktree-gui/compare/v0.67.4...v0.67.5)

### Added

- feat: the pipeline catalogue, its ladder, and the record a cut writes (#234) ([`804ed4e`](https://github.com/JLRoper/agent-worktree-gui/commit/804ed4e3bcef19ee7836235a935b85a2e8fe7822))

## v0.67.4 — 2026-11-02 · 1 commit

[`b524da9`](https://github.com/JLRoper/agent-worktree-gui/commit/b524da971b6027ff4e07aef687b14198c10bc5a4) · [compare v0.67.3...v0.67.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.67.3...v0.67.4)

### Docs & tests

- docs: write the per-project pipeline design down as one page ([`b524da9`](https://github.com/JLRoper/agent-worktree-gui/commit/b524da971b6027ff4e07aef687b14198c10bc5a4))

## v0.67.3 — 2026-11-02 · 1 commit

[`7120159`](https://github.com/JLRoper/agent-worktree-gui/commit/71201595d35031cffa908acdb869e43bac003f31) · [compare v0.67.2...v0.67.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.67.2...v0.67.3)

### Fixed

- fix: the card names the tree's project, and the run id rides the cwd line ([`7120159`](https://github.com/JLRoper/agent-worktree-gui/commit/71201595d35031cffa908acdb869e43bac003f31))

## v0.67.2 — 2026-11-02 · 1 commit

[`b62ab17`](https://github.com/JLRoper/agent-worktree-gui/commit/b62ab179885b4b8f8ef8645c01ebf83b11252664) · [compare v0.67.1...v0.67.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.67.1...v0.67.2)

### Docs & tests

- docs: audit every local wtgui/* branch — 24 deleted, 46 kept ([`b62ab17`](https://github.com/JLRoper/agent-worktree-gui/commit/b62ab179885b4b8f8ef8645c01ebf83b11252664))

## v0.67.1 — 2026-11-02 · 1 commit

[`ac66a3a`](https://github.com/JLRoper/agent-worktree-gui/commit/ac66a3a648b1ba62829842188035a6b0470e3e5f) · [compare v0.67.0...v0.67.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.67.0...v0.67.1)

### Fixed

- fix: a restart for a version already served is refused, and a stale wait cannot replay ([`ac66a3a`](https://github.com/JLRoper/agent-worktree-gui/commit/ac66a3a648b1ba62829842188035a6b0470e3e5f))

## v0.67.0 — 2026-11-02 · 1 commit

[`68445de`](https://github.com/JLRoper/agent-worktree-gui/commit/68445de77f06c3648a02cddf96b220136e54b981) · [compare v0.66.1...v0.67.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.66.1...v0.67.0)

### Added

- feat: the approvals dock counts what is pending and reviews the writes nobody was asked about ([`68445de`](https://github.com/JLRoper/agent-worktree-gui/commit/68445de77f06c3648a02cddf96b220136e54b981))

## v0.66.1 — 2026-11-02 · 1 commit

[`b066acd`](https://github.com/JLRoper/agent-worktree-gui/commit/b066acd9f80ca98253c28ce390b2fff5e8080a26) · [compare v0.66.0...v0.66.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.66.0...v0.66.1)

### Fixed

- fix: a refused steer is said plainly — it never becomes a queued reply ([`b066acd`](https://github.com/JLRoper/agent-worktree-gui/commit/b066acd9f80ca98253c28ce390b2fff5e8080a26))

## v0.66.0 — 2026-11-02 · 3 commits

[`f7a2202`](https://github.com/JLRoper/agent-worktree-gui/commit/f7a2202af77bf9d14657acbcb82771a1db95c697) · [compare v0.65.0...v0.66.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.65.0...v0.66.0)

### Added

- feat: Settings gains a Skills tab — every root, every SKILL.md, read only ([`f7a2202`](https://github.com/JLRoper/agent-worktree-gui/commit/f7a2202af77bf9d14657acbcb82771a1db95c697))

### Fixed

- fix: a green note is not cut short by the red bar's clock it replaces ([`f1455cc`](https://github.com/JLRoper/agent-worktree-gui/commit/f1455cc51cc2c319cb57f0423dd6ad00f7d6e65a))

### Docs & tests

- test: gate the banner's clock on both sides of the pause ([`b297d2d`](https://github.com/JLRoper/agent-worktree-gui/commit/b297d2d37f5dde5198b59067ab013f140eaee27d))

## v0.65.0 — 2026-11-02 · 1 commit

[`861328c`](https://github.com/JLRoper/agent-worktree-gui/commit/861328ccba1c009789104d52dc07609414d1a39e) · [compare v0.64.0...v0.65.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.64.0...v0.65.0)

### Added

- feat: a red failure banner hides itself after the Board tab's seconds ([`861328c`](https://github.com/JLRoper/agent-worktree-gui/commit/861328ccba1c009789104d52dc07609414d1a39e))

## v0.64.0 — 2026-11-02 · 2 commits

[`61a6403`](https://github.com/JLRoper/agent-worktree-gui/commit/61a6403ac3aef39dc35a87bc1cc1c0d7e3f5b1a3) · [compare v0.63.0...v0.64.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.63.0...v0.64.0)

### Added

- feat: Settings is a tab strip — one tab per group, one panel at a time ([`61a6403`](https://github.com/JLRoper/agent-worktree-gui/commit/61a6403ac3aef39dc35a87bc1cc1c0d7e3f5b1a3))

### Docs & tests

- test: the new-project route and the folder's + , proved over HTTP and in Chromium ([`d035989`](https://github.com/JLRoper/agent-worktree-gui/commit/d035989cc1a90be514fc2d26015758d1573b5dbc))

## v0.63.0 — 2026-11-02 · 1 commit

[`9127b8d`](https://github.com/JLRoper/agent-worktree-gui/commit/9127b8ddbc2548efd7da0d0290caee7775d55415) · [compare v0.62.3...v0.63.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.62.3...v0.63.0)

### Added

- feat: the folder's + makes a new local git project, on main with one commit ([`9127b8d`](https://github.com/JLRoper/agent-worktree-gui/commit/9127b8ddbc2548efd7da0d0290caee7775d55415))

## v0.62.3 — 2026-11-02 · 1 commit

[`b5fe7a0`](https://github.com/JLRoper/agent-worktree-gui/commit/b5fe7a0d06cf1e1bc7d3b4f9079168c0ed857b50) · [compare v0.62.2...v0.62.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.62.2...v0.62.3)

### Fixed

- fix: every assistant's finished turn is harvested, and COMPLETE asks stay its own ([`b5fe7a0`](https://github.com/JLRoper/agent-worktree-gui/commit/b5fe7a0d06cf1e1bc7d3b4f9079168c0ed857b50))

## v0.62.2 — 2026-11-02 · 1 commit

[`69d10e3`](https://github.com/JLRoper/agent-worktree-gui/commit/69d10e3c53ffed31fbc1d499de337bc9842ed227) · [compare v0.62.1...v0.62.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.62.1...v0.62.2)

### Fixed

- fix: a reply never starts a run in a tree that is not its own ([`69d10e3`](https://github.com/JLRoper/agent-worktree-gui/commit/69d10e3c53ffed31fbc1d499de337bc9842ed227))

## v0.62.1 — 2026-11-02 · 1 commit

[`4294879`](https://github.com/JLRoper/agent-worktree-gui/commit/4294879ee752f4b6c35364dfa1c791b126993bcf) · [compare v0.62.0...v0.62.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.62.0...v0.62.1)

### Fixed

- fix: a released tree's leftover folder reports RELEASED, not the reader's dirt ([`4294879`](https://github.com/JLRoper/agent-worktree-gui/commit/4294879ee752f4b6c35364dfa1c791b126993bcf))

## v0.62.0 — 2026-11-02 · 1 commit

[`8aee64a`](https://github.com/JLRoper/agent-worktree-gui/commit/8aee64a53848985b1713e8f8c402a205a1d688cc) · [compare v0.61.0...v0.62.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.61.0...v0.62.0)

### Fixed

- fix: the intro box's Send reaches the server again, for every assistant ([`8aee64a`](https://github.com/JLRoper/agent-worktree-gui/commit/8aee64a53848985b1713e8f8c402a205a1d688cc))

## v0.61.0 — 2026-11-02 · 1 commit

[`2089794`](https://github.com/JLRoper/agent-worktree-gui/commit/20897941526343600955c0ac6cc6ca2a981dee89) · [compare v0.60.1...v0.61.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.60.1...v0.61.0)

### Added

- feat: the Settings panel is a window — drag its head, size it from the corner ([`2089794`](https://github.com/JLRoper/agent-worktree-gui/commit/20897941526343600955c0ac6cc6ca2a981dee89))

## v0.60.1 — 2026-11-02 · 3 commits

[`6765944`](https://github.com/JLRoper/agent-worktree-gui/commit/67659448166b84eaac431f3adaf0e069286461a9) · [compare v0.60.0...v0.60.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.60.0...v0.60.1)

### Fixed

- fix: a boot replay does not cut a tree for a debt it already settled ([`7d9b387`](https://github.com/JLRoper/agent-worktree-gui/commit/7d9b387ecf34b8aadb2ab232e7c1ff0e4444f301))

### Docs & tests

- test: the restart gate replays a debt the panel recorded, not one this file seeded ([`56d8cdc`](https://github.com/JLRoper/agent-worktree-gui/commit/56d8cdc6d5b446a190199a1a10244060fd4da1d4))
- docs: what the three replay debts were, and the version 0.60.1 patch ([`6765944`](https://github.com/JLRoper/agent-worktree-gui/commit/67659448166b84eaac431f3adaf0e069286461a9))

## v0.60.0 — 2026-11-02 · 1 commit

[`7a9959a`](https://github.com/JLRoper/agent-worktree-gui/commit/7a9959afa87635df45edebccf4bd26a072a8f7ca) · [compare v0.59.0...v0.60.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.59.0...v0.60.0)

### Added

- feat: an assistant's pane is docked or floating — its own setting, docked by default ([`7a9959a`](https://github.com/JLRoper/agent-worktree-gui/commit/7a9959afa87635df45edebccf4bd26a072a8f7ca))

## v0.59.0 — 2026-11-02 · 2 commits

[`df3b95d`](https://github.com/JLRoper/agent-worktree-gui/commit/df3b95dbd611c333f4691c4ff5c28ae525580b82) · [compare v0.58.3...v0.59.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.58.3...v0.59.0)

### Fixed

- fix: a boot replay settles a debt whose tree is gone, not only one whose work landed ([`df3b95d`](https://github.com/JLRoper/agent-worktree-gui/commit/df3b95dbd611c333f4691c4ff5c28ae525580b82))

### Docs & tests

- docs: the collapsed row's identity line, with the before/after snapshots ([`0119adb`](https://github.com/JLRoper/agent-worktree-gui/commit/0119adbed4742c2518baa2aecc3bf133fa8b683d))

## v0.58.3 — 2026-11-02 · 1 commit

[`697881f`](https://github.com/JLRoper/agent-worktree-gui/commit/697881f042dc91e8b53318a7fee5d47e068acd96) · [compare v0.58.2...v0.58.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.58.2...v0.58.3)

### Fixed

- fix: a minimized card reads cwd, then the name, then its buttons ([`697881f`](https://github.com/JLRoper/agent-worktree-gui/commit/697881f042dc91e8b53318a7fee5d47e068acd96))

## v0.58.2 — 2026-11-02 · 1 commit

[`18b6a4f`](https://github.com/JLRoper/agent-worktree-gui/commit/18b6a4f9696c3946f99c34bacf932925a40872da) · [compare v0.58.1...v0.58.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.58.1...v0.58.2)

### Fixed

- fix: the banner floats under the measured topbar instead of shoving the board ([`18b6a4f`](https://github.com/JLRoper/agent-worktree-gui/commit/18b6a4f9696c3946f99c34bacf932925a40872da))

## v0.58.1 — 2026-11-02 · 2 commits

[`e14e7b7`](https://github.com/JLRoper/agent-worktree-gui/commit/e14e7b7b8e0ea5cfd17973ca5328b4f1f7fae8de) · [compare v0.58.0...v0.58.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.58.0...v0.58.1)

### Added

- feat: a restart needs a reason, a wait can be cancelled, and a landed brief is not replayed ([`e14e7b7`](https://github.com/JLRoper/agent-worktree-gui/commit/e14e7b7b8e0ea5cfd17973ca5328b4f1f7fae8de))

### Docs & tests

- test: the queue gate reads the sub-rows the row actually draws, and scopes the glyphs to it ([`e7e8a5a`](https://github.com/JLRoper/agent-worktree-gui/commit/e7e8a5ae820a0d1e790744a07f249b5294c4a022))

## v0.58.0 — 2026-11-02 · 1 commit

[`23cbac9`](https://github.com/JLRoper/agent-worktree-gui/commit/23cbac9b921b4d11158ee911e6240a7cef0ea003) · [compare v0.57.1...v0.58.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.57.1...v0.58.0)

### Added

- feat: the queue row is a console row — one sub-row per agent, glyph presses, a Move popover ([`23cbac9`](https://github.com/JLRoper/agent-worktree-gui/commit/23cbac9b921b4d11158ee911e6240a7cef0ea003))

## v0.57.1 — 2026-11-02 · 1 commit

[`29217b1`](https://github.com/JLRoper/agent-worktree-gui/commit/29217b1e5ca50b57c07381f46654ad9fbe500aff) · [compare v0.57.0...v0.57.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.57.0...v0.57.1)

### Added

- feat: remove the Role tab's whitelists and give each assistant its own Worktrees sub-tab ([`29217b1`](https://github.com/JLRoper/agent-worktree-gui/commit/29217b1e5ca50b57c07381f46654ad9fbe500aff))

## v0.57.0 — 2026-11-02 · 1 commit

[`25b3ea3`](https://github.com/JLRoper/agent-worktree-gui/commit/25b3ea39ce061494dfb2a4ec3930db3b1f7a874f) · [compare v0.56.5...v0.57.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.56.5...v0.57.0)

### Added

- feat: two assistants run at once, each on its own thread, tree and queue ([`25b3ea3`](https://github.com/JLRoper/agent-worktree-gui/commit/25b3ea39ce061494dfb2a4ec3930db3b1f7a874f))

## v0.56.5 — 2026-11-02 · 1 commit

[`1a0fb98`](https://github.com/JLRoper/agent-worktree-gui/commit/1a0fb98d937be6024661c313aa8b72d6df76278e) · [compare v0.56.4...v0.56.5](https://github.com/JLRoper/agent-worktree-gui/compare/v0.56.4...v0.56.5)

### Fixed

- fix: a Move hands the task to the other assistant's file, and the queue has a real end-to-end gate ([`1a0fb98`](https://github.com/JLRoper/agent-worktree-gui/commit/1a0fb98d937be6024661c313aa8b72d6df76278e))

## v0.56.4 — 2026-11-02 · 2 commits

[`e08f9f0`](https://github.com/JLRoper/agent-worktree-gui/commit/e08f9f01145d5f5981f12141e33a3e9c906d3f03) · [compare v0.56.3...v0.56.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.56.3...v0.56.4)

### Fixed

- fix: every queue digest line carries state, thread, tree, PR and why it is not going ([`4b7fd15`](https://github.com/JLRoper/agent-worktree-gui/commit/4b7fd15a954a41f7a29eb1ff48f0bff6726f5e8f))
- fix: the preamble leads with the queue, and says a restart re-attaches runs ([`e08f9f0`](https://github.com/JLRoper/agent-worktree-gui/commit/e08f9f01145d5f5981f12141e33a3e9c906d3f03))

## v0.56.3 — 2026-11-02 · 1 commit

[`e92243b`](https://github.com/JLRoper/agent-worktree-gui/commit/e92243b9ffddbe556a31111f55124c6f83c61816) · [compare v0.56.2...v0.56.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.56.2...v0.56.3)

### Fixed

- fix: the chart fits the board when the assistant rail opens, and the owner column is a tag ([`e92243b`](https://github.com/JLRoper/agent-worktree-gui/commit/e92243b9ffddbe556a31111f55124c6f83c61816))

## v0.56.2 — 2026-11-02 · 2 commits

[`04db63f`](https://github.com/JLRoper/agent-worktree-gui/commit/04db63ff2d8e913ee13b393ea9daf88fbaae5592) · [compare v0.56.1...v0.56.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.56.1...v0.56.2)

### Docs & tests

- docs: 0.56.1 - patch: the owner record carries the row-event fix and the re-check at 0.56.0 ([`1929e4d`](https://github.com/JLRoper/agent-worktree-gui/commit/1929e4d1f278d832153d028c5eeaa398a49117de))
- docs: 0.56.2 - patch: re-derive the app.js split plan at 0.56.1 ([`04db63f`](https://github.com/JLRoper/agent-worktree-gui/commit/04db63ff2d8e913ee13b393ea9daf88fbaae5592))

## v0.56.1 — 2026-11-02 · 2 commits

[`f94e286`](https://github.com/JLRoper/agent-worktree-gui/commit/f94e286dfc19f7e9d96cb73fcc2f8409da12998e) · [compare v0.56.0...v0.56.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.56.0...v0.56.1)

### Fixed

- fix: a tree's first row event carries its owner, so the column cannot blank on its own ([`f94e286`](https://github.com/JLRoper/agent-worktree-gui/commit/f94e286dfc19f7e9d96cb73fcc2f8409da12998e))

### Docs & tests

- docs: 0.56.0 - the per-assistant queue re-checked at 0.55.0, with the browser gate it was missing ([`e379dc5`](https://github.com/JLRoper/agent-worktree-gui/commit/e379dc5acfb5ef65738a3b50021685bb2c89f5e3))

## v0.56.0 — 2026-11-02 · 2 commits

[`c503b74`](https://github.com/JLRoper/agent-worktree-gui/commit/c503b74de302a51ea7f5a79352c155c4305e15da) · [compare v0.55.0...v0.56.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.55.0...v0.56.0)

### Added

- feat: a browser gate for the Queue sub-tab's four markers ([`c503b74`](https://github.com/JLRoper/agent-worktree-gui/commit/c503b74de302a51ea7f5a79352c155c4305e15da))

### Fixed

- fix: a new assistant's queue file is seeded when it is created ([`4b0f8e8`](https://github.com/JLRoper/agent-worktree-gui/commit/4b0f8e8234092fc3a12d578ef88a5dfa414b5641))

## v0.55.0 — 2026-11-02 · 1 commit

[`75a89f4`](https://github.com/JLRoper/agent-worktree-gui/commit/75a89f466496caae6611990b3aad6d755f023c89) · [compare v0.54.0...v0.55.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.54.0...v0.55.0)

### Added

- feat: the assistant is a docked right rail, not a floating window ([`75a89f4`](https://github.com/JLRoper/agent-worktree-gui/commit/75a89f466496caae6611990b3aad6d755f023c89))

## v0.54.0 — 2026-11-02 · 1 commit

[`2a0a96f`](https://github.com/JLRoper/agent-worktree-gui/commit/2a0a96ff20841d7bad900b466885682360fe3ffe) · [compare v0.53.4...v0.54.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.53.4...v0.54.0)

### Fixed

- fix: the queue pane stops re-arming its own read, and drives its own assistant ([`2a0a96f`](https://github.com/JLRoper/agent-worktree-gui/commit/2a0a96ff20841d7bad900b466885682360fe3ffe))

## v0.53.4 — 2026-11-02 · 1 commit

[`71e188f`](https://github.com/JLRoper/agent-worktree-gui/commit/71e188fcc73655b31acd615aa7ce732e5faf0ae8) · [compare v0.53.3...v0.53.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.53.3...v0.53.4)

### Docs & tests

- docs: 0.53.4 - patch: re-derive the app.js split plan at 0.53.2 ([`71e188f`](https://github.com/JLRoper/agent-worktree-gui/commit/71e188fcc73655b31acd615aa7ce732e5faf0ae8))

## v0.53.3 — 2026-11-02 · 2 commits

[`28bad77`](https://github.com/JLRoper/agent-worktree-gui/commit/28bad77b9cf46d98b34ea3519588111a810faa19) · [compare v0.53.2...v0.53.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.53.2...v0.53.3)

### Fixed

- fix: the sub-tab gate follows the Queue tab that landed after it ([`bb9b8eb`](https://github.com/JLRoper/agent-worktree-gui/commit/bb9b8eb1e7c251fdca2a688e697b7cb5d8502f7a))

### Docs & tests

- docs: 0.53.3 - patch: the settings split re-checked at 0.53.2 ([`28bad77`](https://github.com/JLRoper/agent-worktree-gui/commit/28bad77b9cf46d98b34ea3519588111a810faa19))

## v0.53.2 — 2026-11-01 · 2 commits

[`622940f`](https://github.com/JLRoper/agent-worktree-gui/commit/622940f1ff17d2c34a3bbb9e5ec3b00c474a9811) · [compare v0.53.1...v0.53.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.53.1...v0.53.2)

### Fixed

- fix: the owner column names the assistant, with its role in the tooltip ([`622940f`](https://github.com/JLRoper/agent-worktree-gui/commit/622940f1ff17d2c34a3bbb9e5ec3b00c474a9811))

### Docs & tests

- docs: 0.53.1 - patch: one console size for the console's text, re-checked at 0.53.0 ([`6438642`](https://github.com/JLRoper/agent-worktree-gui/commit/6438642de3a7d722fa87503e031142c7fd90eb17))

## v0.53.1 — 2026-11-01 · 1 commit

[`23bdd10`](https://github.com/JLRoper/agent-worktree-gui/commit/23bdd104e7b88ababe15c95e88ac27cc3bf38218) · [compare v0.53.0...v0.53.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.53.0...v0.53.1)

### Fixed

- fix: Display's tooltip stops promising Thinking text a size of its own ([`23bdd10`](https://github.com/JLRoper/agent-worktree-gui/commit/23bdd104e7b88ababe15c95e88ac27cc3bf38218))

## v0.53.0 — 2026-11-01 · 1 commit

[`935bfc4`](https://github.com/JLRoper/agent-worktree-gui/commit/935bfc42b6f14e1088c0a550a824bbfa88ff221b) · [compare v0.52.2...v0.53.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.52.2...v0.53.0)

### Added

- feat: give every assistant its own task queue ([`935bfc4`](https://github.com/JLRoper/agent-worktree-gui/commit/935bfc42b6f14e1088c0a550a824bbfa88ff221b))

## v0.52.2 — 2026-11-01 · 1 commit

[`e317798`](https://github.com/JLRoper/agent-worktree-gui/commit/e3177989e535130489a16a835a1ca75dae6f5be8) · [compare v0.52.1...v0.52.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.52.1...v0.52.2)

### Docs & tests

- docs: 0.52.2 - patch: the worktree owner by role label was already landed; record the re-check ([`e317798`](https://github.com/JLRoper/agent-worktree-gui/commit/e3177989e535130489a16a835a1ca75dae6f5be8))

## v0.52.1 — 2026-11-01 · 1 commit

[`3d17063`](https://github.com/JLRoper/agent-worktree-gui/commit/3d1706392b0407e732421b1aa4309a633bc3b256) · [compare v0.52.0...v0.52.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.52.0...v0.52.1)

### Docs & tests

- docs: 0.52.1 - patch: the assistant settings split was already landed; record the re-check ([`3d17063`](https://github.com/JLRoper/agent-worktree-gui/commit/3d1706392b0407e732421b1aa4309a633bc3b256))

## v0.52.0 — 2026-11-01 · 1 commit

[`635404b`](https://github.com/JLRoper/agent-worktree-gui/commit/635404b1dd215ff6b25b2f463d39275aaa411ec2) · [compare v0.51.4...v0.52.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.51.4...v0.52.0)

### Added

- feat: give every worktree an owning assistant, shown as a role label ([`635404b`](https://github.com/JLRoper/agent-worktree-gui/commit/635404b1dd215ff6b25b2f463d39275aaa411ec2))

## v0.51.4 — 2026-11-01 · 1 commit

[`fb9e6eb`](https://github.com/JLRoper/agent-worktree-gui/commit/fb9e6ebd2d4b8f3731ec2dde5113d9c4e636f768) · [compare v0.51.3...v0.51.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.51.3...v0.51.4)

### Docs & tests

- docs: 0.51.4 - patch: plan the split of public/app.js into modules, ranked by blast radius ([`fb9e6eb`](https://github.com/JLRoper/agent-worktree-gui/commit/fb9e6ebd2d4b8f3731ec2dde5113d9c4e636f768))

## v0.51.3 — 2026-11-01 · 1 commit

[`78d5cd7`](https://github.com/JLRoper/agent-worktree-gui/commit/78d5cd7d326f39456c84f4b263a03e44c5f35031) · [compare v0.51.2...v0.51.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.51.2...v0.51.3)

### Docs & tests

- test: measure a below-cap console height, and the real 30 s resync net ([`78d5cd7`](https://github.com/JLRoper/agent-worktree-gui/commit/78d5cd7d326f39456c84f4b263a03e44c5f35031))

## v0.51.2 — 2026-11-01 · 1 commit

[`66659c4`](https://github.com/JLRoper/agent-worktree-gui/commit/66659c4be6796f3c42dfc70ba644e1433b30dcde) · [compare v0.51.1...v0.51.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.51.1...v0.51.2)

### Docs & tests

- docs: 0.51.2 - patch: one console size for normal, reasoning and tool text was already landed; record the re-check ([`66659c4`](https://github.com/JLRoper/agent-worktree-gui/commit/66659c4be6796f3c42dfc70ba644e1433b30dcde))

## v0.51.1 — 2026-11-01 · 1 commit

[`14c27c3`](https://github.com/JLRoper/agent-worktree-gui/commit/14c27c38a00a3a32ca3aa32796c4184d4d7975d4) · [compare v0.51.0...v0.51.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.51.0...v0.51.1)

### Docs & tests

- docs: 0.51.1 - patch: the console-grab measurement was already landed; record the re-check ([`14c27c3`](https://github.com/JLRoper/agent-worktree-gui/commit/14c27c38a00a3a32ca3aa32796c4184d4d7975d4))

## v0.51.0 — 2026-11-01 · 1 commit

[`65f1e8e`](https://github.com/JLRoper/agent-worktree-gui/commit/65f1e8e050a242aeee7028c7b7faa0c8a8d0c8c4) · [compare v0.50.2...v0.51.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.50.2...v0.51.0)

### Added

- feat: split the assistant's settings into a Watchdog tab and per-assistant settings ([`65f1e8e`](https://github.com/JLRoper/agent-worktree-gui/commit/65f1e8e050a242aeee7028c7b7faa0c8a8d0c8c4))

## v0.50.2 — 2026-11-01 · 2 commits

[`2d80df0`](https://github.com/JLRoper/agent-worktree-gui/commit/2d80df080c79a53119cd8d86e345bcecf30ad3f1) · [compare v0.50.1...v0.50.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.50.1...v0.50.2)

### Docs & tests

- docs: correct the record's own read time to the clock it was measured on ([`cea6dfe`](https://github.com/JLRoper/agent-worktree-gui/commit/cea6dfe0cce77435b90b4f762b6f1a519986c54e))
- docs: 0.50.2 - patch: the Combined output default was already landed; record the re-check ([`2d80df0`](https://github.com/JLRoper/agent-worktree-gui/commit/2d80df080c79a53119cd8d86e345bcecf30ad3f1))

## v0.50.1 — 2026-11-01 · 1 commit

[`ae3d9c1`](https://github.com/JLRoper/agent-worktree-gui/commit/ae3d9c148f2c006e57465b184c1e7892f0ddba71) · [compare v0.50.0...v0.50.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.50.0...v0.50.1)

### Docs & tests

- docs: 0.50.1 - patch: per-assistant settings, role prompt and whitelists were already landed; record the check ([`ae3d9c1`](https://github.com/JLRoper/agent-worktree-gui/commit/ae3d9c148f2c006e57465b184c1e7892f0ddba71))

## v0.50.0 — 2026-11-01 · 1 commit

[`8237843`](https://github.com/JLRoper/agent-worktree-gui/commit/8237843e9fc8847c4fe44f3ff5561b9046173d1a) · [compare v0.49.3...v0.50.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.49.3...v0.50.0)

### Added

- feat: one console size drives normal, reasoning and tool text ([`8237843`](https://github.com/JLRoper/agent-worktree-gui/commit/8237843e9fc8847c4fe44f3ff5561b9046173d1a))

## v0.49.3 — 2026-11-01 · 3 commits

[`c063405`](https://github.com/JLRoper/agent-worktree-gui/commit/c063405f94820367cf4761d37f678ae6a367960f) · [compare v0.49.2...v0.49.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.49.2...v0.49.3)

### Docs & tests

- test: the height store keeps a dragged height above and below the cap, and forgets a turn that left ([`570c3de`](https://github.com/JLRoper/agent-worktree-gui/commit/570c3deaca52ec98bfc4dc85a50ab1a0568d95a7))
- test: gate a dragged console height through every rebuild trigger that used to lose it ([`de6c384`](https://github.com/JLRoper/agent-worktree-gui/commit/de6c3842bb0b44c6bf372351c594d96c0073e865))
- test: read the height a console grab records, and pin it per case ([`c063405`](https://github.com/JLRoper/agent-worktree-gui/commit/c063405f94820367cf4761d37f678ae6a367960f))

## v0.49.2 — 2026-11-01 · 3 commits

[`7d45176`](https://github.com/JLRoper/agent-worktree-gui/commit/7d451764f35e7b26881b08ce9d9920153c248a74) · [compare v0.49.1...v0.49.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.49.1...v0.49.2)

### Fixed

- fix: a console height the reader dragged survives the rebuild that replaces the box ([`7d45176`](https://github.com/JLRoper/agent-worktree-gui/commit/7d451764f35e7b26881b08ce9d9920153c248a74))

### Docs & tests

- test: pin the Combined output default at build, over both per-card answers, and through a save ([`3cb5d55`](https://github.com/JLRoper/agent-worktree-gui/commit/3cb5d55e0a43ae53cf4700d7be164169b507dba4))
- test: gate the Combined output default across two runs and two presses, in a real browser ([`29d5375`](https://github.com/JLRoper/agent-worktree-gui/commit/29d53758884595cbbc35c463a54de50a0c69c6d6))

## v0.49.1 — 2026-11-01 · 1 commit

[`e69b6be`](https://github.com/JLRoper/agent-worktree-gui/commit/e69b6be68876ab5dd6247d88df4290f07aa449ab) · [compare v0.49.0...v0.49.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.49.0...v0.49.1)

### Added

- feat: a Combined output default beside Show thinking, for the one-stream console ([`e69b6be`](https://github.com/JLRoper/agent-worktree-gui/commit/e69b6be68876ab5dd6247d88df4290f07aa449ab))

## v0.49.0 — 2026-11-01 · 2 commits

[`554d1cd`](https://github.com/JLRoper/agent-worktree-gui/commit/554d1cd6164e5a8f61a83ef78cf46500be9477de) · [compare v0.48.4...v0.49.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.48.4...v0.49.0)

### Added

- feat: one assistant's own settings, its own default role prompt and its two whitelists ([`473161a`](https://github.com/JLRoper/agent-worktree-gui/commit/473161ab13d5fb153d96690cda1444bc386aa392))

### Other

- chore: bump minor (0.49.0) for per-assistant settings, role prompts and whitelists ([`554d1cd`](https://github.com/JLRoper/agent-worktree-gui/commit/554d1cd6164e5a8f61a83ef78cf46500be9477de))

## v0.48.4 — 2026-11-01 · 1 commit

[`7e7879a`](https://github.com/JLRoper/agent-worktree-gui/commit/7e7879a8bb3c84b0bf8f61cebb1d985d5837bc13) · [compare v0.48.3...v0.48.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.48.3...v0.48.4)

### Docs & tests

- docs: 0.48.4 - patch: the three PRs were already landed; record the re-check, no product change ([`7e7879a`](https://github.com/JLRoper/agent-worktree-gui/commit/7e7879a8bb3c84b0bf8f61cebb1d985d5837bc13))

## v0.48.3 — 2026-11-01 · 2 commits

[`8e7c01e`](https://github.com/JLRoper/agent-worktree-gui/commit/8e7c01e9b6018aecf707029c189fcc2c9ba98392) · [compare v0.48.2...v0.48.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.48.2...v0.48.3)

### Docs & tests

- test: measure the console grab's corner tracking on following, parked and streaming consoles ([`b7d9ecb`](https://github.com/JLRoper/agent-worktree-gui/commit/b7d9ecb5ac62d16dad643d08cb3ed0a5b7e64da1))

### Other

- chore: 0.48.3 - patch: a measurement harness for the console grab, no product change ([`8e7c01e`](https://github.com/JLRoper/agent-worktree-gui/commit/8e7c01e9b6018aecf707029c189fcc2c9ba98392))

## v0.48.2 — 2026-11-01 · 8 commits

[`dbcc005`](https://github.com/JLRoper/agent-worktree-gui/commit/dbcc0058338e8f0502bdd346061f1b1bfd7cad63) · [compare v0.48.1...v0.48.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.48.1...v0.48.2)

### Performance

- perf: a project event that carries nothing new stops before the section rebuild ([`cde7b9e`](https://github.com/JLRoper/agent-worktree-gui/commit/cde7b9eddc205bf56dedb01773815af36a611d9c))
- perf: the ranking passes read the board's children, not every node under it ([`f2b3353`](https://github.com/JLRoper/agent-worktree-gui/commit/f2b33535c956bf6c49a2ad10cb70b9d65eb63750))
- perf: the queue clock, stale-detail sweep, question clocks and tool-store refresh read the node registry ([`8d50d1a`](https://github.com/JLRoper/agent-worktree-gui/commit/8d50d1a8d3bf8bf77c011add025dd70c100e77d1))

### Docs & tests

- test: the jitter gate judges the gap a frame paints, not the gap before the page's own stick ([`8c85fdc`](https://github.com/JLRoper/agent-worktree-gui/commit/8c85fdc0b9b4e58a54a05dfd8fa48d3f1f22f864))
- test: a repeated project event changes nothing, a changed one still repaints ([`0b0fe35`](https://github.com/JLRoper/agent-worktree-gui/commit/0b0fe35d689eb7b0c25c52f7051edf9eba274924))
- test: the ranking passes read children, and no longer search below the host ([`d26b90e`](https://github.com/JLRoper/agent-worktree-gui/commit/d26b90e020acdc5133eb79691b647cddd82727ea))
- test: the registry answers the walk for the four new kinds as well ([`6125cda`](https://github.com/JLRoper/agent-worktree-gui/commit/6125cda6acb127bd1aeb851a7e26312f70c31429))

### Other

- chore: 0.48.2 - patch: unchanged project events stop rebuilding sections, ranking reads children, and the jitter gate reads what is painted ([`dbcc005`](https://github.com/JLRoper/agent-worktree-gui/commit/dbcc0058338e8f0502bdd346061f1b1bfd7cad63))

## v0.48.1 — 2026-11-01 · 14 commits

[`f4ebe34`](https://github.com/JLRoper/agent-worktree-gui/commit/f4ebe34781dcfaa6266965a77f7af73b2d5cdb0b) · [compare v0.48.0...v0.48.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.48.0...v0.48.1)

### Fixed

- fix: a panel refuses to start on a port something already answers on, before it touches anything ([`4e008e5`](https://github.com/JLRoper/agent-worktree-gui/commit/4e008e59dcee97bbfff075ad8ee6012254142950))

### Performance

- perf: measure the chart's columns only when a worktree row changed, not on every console line ([`cf9db2d`](https://github.com/JLRoper/agent-worktree-gui/commit/cf9db2dbaadfc2235558f5f1ae0c37ee51788200))
- perf: paintSubagents finds the strips once per roster poll, not once or twice per job ([`45b82d7`](https://github.com/JLRoper/agent-worktree-gui/commit/45b82d7b5ae3c734a9ebd1fd098e4f2622e5bd75))
- perf: refreshChips and the age arrow keep their project's nodes, and skip an unchanged strip ([`e56e63b`](https://github.com/JLRoper/agent-worktree-gui/commit/e56e63b40d517e138adbfc3bde25e1d6ae78f5ee))
- perf: an agent event finds its row through the row map, and restarts the flash without a reflow ([`fdea93c`](https://github.com/JLRoper/agent-worktree-gui/commit/fdea93c7a9c8717a55c05e49368f68ff35c0518d))
- perf: a pulse dot scrolled out of view stops animating until it is back ([`c0fd917`](https://github.com/JLRoper/agent-worktree-gui/commit/c0fd917d8bc46e39605016e4ba6fa3a32fec6249))
- perf: the board's consoles are found from a registry of placed nodes, not a walk of the page ([`f7b695e`](https://github.com/JLRoper/agent-worktree-gui/commit/f7b695e8a50d6a9190396c631b6001c8bc3a8720))

### Docs & tests

- test: pin the console's resize handle to the pointer with a browser gate ([`cfcbec3`](https://github.com/JLRoper/agent-worktree-gui/commit/cfcbec3b3dbf96c4818f91ee5775e9de7aaea4c0))
- test: pin the rows-only column memo, and keep the column-fit gate's window measuring ([`0f8d5aa`](https://github.com/JLRoper/agent-worktree-gui/commit/0f8d5aa493e9126a3831b4036f76ec3cd47bcdc8))
- test: pin the board's per-event lookups to the nodes they already hold, and the off-screen dot ([`2fb71ce`](https://github.com/JLRoper/agent-worktree-gui/commit/2fb71ce3b8555d8fd9530d824180a291e2893004))
- test: one panel per port - the shadowing boot is refused, a restart waits for its predecessor ([`d22462e`](https://github.com/JLRoper/agent-worktree-gui/commit/d22462ef9b47224536c8cd7f1c74d9e7943bbe9b))
- test: six browser gates import freePort, the name panel-testkit exports, and start again ([`3eb89ac`](https://github.com/JLRoper/agent-worktree-gui/commit/3eb89acba4603d90c6daaf2fef789cba0d7457c4))
- test: the console registry answers what a walk of the page answers, in a real browser ([`0bd8f80`](https://github.com/JLRoper/agent-worktree-gui/commit/0bd8f805ff75d84c10adf91b8166b9b9646910c0))

### Other

- chore: 0.48.1 - patch: the board's main thread does about half the work for the same picture, and one panel per port ([`f4ebe34`](https://github.com/JLRoper/agent-worktree-gui/commit/f4ebe34781dcfaa6266965a77f7af73b2d5cdb0b))

## v0.48.0 — 2026-11-01 · 1 commit

[`9808fec`](https://github.com/JLRoper/agent-worktree-gui/commit/9808fec2e5c2ef4ae32ef3c047391576e4f854a0) · [compare v0.47.2...v0.48.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.47.2...v0.48.0)

### Fixed

- fix: keep the console's resize corner under the pointer that grabbed it ([`9808fec`](https://github.com/JLRoper/agent-worktree-gui/commit/9808fec2e5c2ef4ae32ef3c047391576e4f854a0))

## v0.47.2 — 2026-11-01 · 2 commits

[`4d7bcf3`](https://github.com/JLRoper/agent-worktree-gui/commit/4d7bcf37401d3355d9441bd6eb0df54ee96d7fe1) · [compare v0.47.1...v0.47.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.47.1...v0.47.2)

### Fixed

- fix: a paragraph the reader left mid-type is drawn whole when they come back ([`26565eb`](https://github.com/JLRoper/agent-worktree-gui/commit/26565eb3c6ea405e1db0002199baffab6e8bc638))

### Other

- chore: bump patch (0.47.2) for the console's missing text ([`4d7bcf3`](https://github.com/JLRoper/agent-worktree-gui/commit/4d7bcf37401d3355d9441bd6eb0df54ee96d7fe1))

## v0.47.1 — 2026-11-01 · 4 commits

[`56aa66d`](https://github.com/JLRoper/agent-worktree-gui/commit/56aa66d194d38274cf4be56060ddd83196263874) · [compare v0.47.0...v0.47.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.47.0...v0.47.1)

### Fixed

- fix: the PR cell says `none` — the branch column already answers "gone" ([`ac77d5c`](https://github.com/JLRoper/agent-worktree-gui/commit/ac77d5c54e6055080e7bd739da5a07f3db2bff22))

### Docs & tests

- test: pin the PR cell's one word, in the page and on the rendered row ([`f9ffb41`](https://github.com/JLRoper/agent-worktree-gui/commit/f9ffb4187c97bba1f95c604b54c745c08ce5cce9))
- docs: the PR column's `none` is the whole answer ([`f7582ad`](https://github.com/JLRoper/agent-worktree-gui/commit/f7582adceba6f83c4534dd5760bb7aef6863019d))

### Other

- chore: bump patch (0.47.1) for the PR cell's one word ([`56aa66d`](https://github.com/JLRoper/agent-worktree-gui/commit/56aa66d194d38274cf4be56060ddd83196263874))

## v0.47.0 — 2026-11-01 · 6 commits

[`e237d6e`](https://github.com/JLRoper/agent-worktree-gui/commit/e237d6e8c739c6637359fca828ce82fd18f2fa24) · [compare v0.46.8...v0.47.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.46.8...v0.47.0)

### Added

- feat: a browser gate for the chart's column measurement moving the consoles ([`28559f3`](https://github.com/JLRoper/agent-worktree-gui/commit/28559f34851f2eb5dd2a0152aa81274bc909dbdf))

### Fixed

- fix: measure the chart's columns on a copy, never the live table that holds the consoles ([`0a96e3b`](https://github.com/JLRoper/agent-worktree-gui/commit/0a96e3b6839d977b856a13acdcb4dc877550724f))
- fix: a scroll write that moved nothing leaves no claim on the reader's next scroll ([`3b4bbcd`](https://github.com/JLRoper/agent-worktree-gui/commit/3b4bbcde96550d5d6212fef616def8cf74ceb74f))

### Docs & tests

- test: pin the column measurement and the scroll flag without a browser ([`6b2175f`](https://github.com/JLRoper/agent-worktree-gui/commit/6b2175fe06739380fb9f9955b9699e9df21c7040))
- docs: why the console bounced and lost the reader's place, with the fix (html) ([`93db104`](https://github.com/JLRoper/agent-worktree-gui/commit/93db1044bd4858428f07a6fa80b6c7f783f142fd))

### Other

- chore: bump minor (0.47.0) for the new console column-fit gate ([`e237d6e`](https://github.com/JLRoper/agent-worktree-gui/commit/e237d6e8c739c6637359fca828ce82fd18f2fa24))

## v0.46.8 — 2026-11-01 · 1 commit

[`c4a0093`](https://github.com/JLRoper/agent-worktree-gui/commit/c4a009358959d96b2f5e09be546d79f2016a387e) · [compare v0.46.7...v0.46.8](https://github.com/JLRoper/agent-worktree-gui/compare/v0.46.7...v0.46.8)

### Docs & tests

- docs: three open docs/harness PRs landed in order, 0.46.5 -> 0.46.7 (0.46.8) ([`c4a0093`](https://github.com/JLRoper/agent-worktree-gui/commit/c4a009358959d96b2f5e09be546d79f2016a387e))

## v0.46.7 — 2026-11-01 · 1 commit

[`b1c5bd2`](https://github.com/JLRoper/agent-worktree-gui/commit/b1c5bd294a6a804a540722ae31dd345d76805175) · [compare v0.46.6...v0.46.7](https://github.com/JLRoper/agent-worktree-gui/compare/v0.46.6...v0.46.7)

### Docs & tests

- docs: a read-only 60 s window on b499c61 — no arrival at 0, a park lost to the tail ([`b1c5bd2`](https://github.com/JLRoper/agent-worktree-gui/commit/b1c5bd294a6a804a540722ae31dd345d76805175))

## v0.46.6 — 2026-11-01 · 1 commit

[`4ea03f7`](https://github.com/JLRoper/agent-worktree-gui/commit/4ea03f7d617b40ffb72576169b0ff576c6f6e399) · [compare v0.46.5...v0.46.6](https://github.com/JLRoper/agent-worktree-gui/compare/v0.46.5...v0.46.6)

### Other

- Report the console frames that paint at 0, with the rebuild in front of each ([`4ea03f7`](https://github.com/JLRoper/agent-worktree-gui/commit/4ea03f7d617b40ffb72576169b0ff576c6f6e399))

## v0.46.5 — 2026-11-01 · 1 commit

[`788a7a8`](https://github.com/JLRoper/agent-worktree-gui/commit/788a7a8f72cd40c7849334e5a881b3cbc41a7e9f) · [compare v0.46.4...v0.46.5](https://github.com/JLRoper/agent-worktree-gui/compare/v0.46.4...v0.46.5)

### Docs & tests

- test: close the typed window at --seconds, and record what the gesture did ([`788a7a8`](https://github.com/JLRoper/agent-worktree-gui/commit/788a7a8f72cd40c7849334e5a881b3cbc41a7e9f))

## v0.46.4 — 2026-11-01 · 2 commits

[`21aa536`](https://github.com/JLRoper/agent-worktree-gui/commit/21aa5361e343bdf94e17e5816624b373ec4d55ea) · [compare v0.46.3...v0.46.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.46.3...v0.46.4)

### Docs & tests

- test: pin --jobs with two harnesses that must meet each other ([`dac78f1`](https://github.com/JLRoper/agent-worktree-gui/commit/dac78f14cd60ec8f077f5026e477bbe2948c8db8))
- docs: the canonical Runs API needs a cwd-binding gateway, not the legacy knobs patch (0.46.4) ([`21aa536`](https://github.com/JLRoper/agent-worktree-gui/commit/21aa5361e343bdf94e17e5816624b373ec4d55ea))

## v0.46.3 — 2026-11-01 · 1 commit

[`5293760`](https://github.com/JLRoper/agent-worktree-gui/commit/52937608ca29190077bb2831d2057babb3d530a7) · [compare v0.46.2...v0.46.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.46.2...v0.46.3)

### Docs & tests

- test: run verification harnesses in parallel with --jobs ([`5293760`](https://github.com/JLRoper/agent-worktree-gui/commit/52937608ca29190077bb2831d2057babb3d530a7))

## v0.46.2 — 2026-11-01 · 1 commit

[`a0b0026`](https://github.com/JLRoper/agent-worktree-gui/commit/a0b0026e90966f2376473061ce2392a2616d56ef) · [compare v0.46.1...v0.46.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.46.1...v0.46.2)

### Other

- console: an unread tool store is not an empty one ([`a0b0026`](https://github.com/JLRoper/agent-worktree-gui/commit/a0b0026e90966f2376473061ce2392a2616d56ef))

## v0.46.1 — 2026-11-01 · 5 commits

[`b499c61`](https://github.com/JLRoper/agent-worktree-gui/commit/b499c61a598f9baaa9a32d3ce0c043ae8ea8f458) · [compare v0.46.0...v0.46.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.46.0...v0.46.1)

### Added

- feat: the Charter tab is the Role tab, editable per assistant ([`2f16c2b`](https://github.com/JLRoper/agent-worktree-gui/commit/2f16c2b376805f8cf85cc685c1d003fe1f20f4e4))
- feat: every assistant thread is a conversation, not a worker ([`31fb558`](https://github.com/JLRoper/agent-worktree-gui/commit/31fb5583ca8be39c322b903efe358593dbdbaa33))

### Docs & tests

- test: drive the Role tab, Assistant #2 and #2's own copy ([`5d29a95`](https://github.com/JLRoper/agent-worktree-gui/commit/5d29a950850d3787bb90a52922fc09cffb0ca244))

### Other

- tools: pin the console-write harness to a named port, and count arrivals at 0 ([`324f8e2`](https://github.com/JLRoper/agent-worktree-gui/commit/324f8e2072abde37a6befd46d46c883080976d98))
- console: follow the newest line, or the reader — never a 40 px band between them ([`b499c61`](https://github.com/JLRoper/agent-worktree-gui/commit/b499c61a598f9baaa9a32d3ce0c043ae8ea8f458))

## v0.46.0 — 2026-11-01 · 6 commits

[`0581afd`](https://github.com/JLRoper/agent-worktree-gui/commit/0581afdd5dfe2f093f1bf01095f55da19d9cc30b) · [compare v0.45.0...v0.46.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.45.0...v0.46.0)

### Added

- feat: a role is a named charter, and each assistant runs its own copy ([`d6595be`](https://github.com/JLRoper/agent-worktree-gui/commit/d6595be093a5d0a6081af7b9d2fa057ba96c8a7a))
- feat: routes for a role, its charter, and a new assistant made from one ([`f746762`](https://github.com/JLRoper/agent-worktree-gui/commit/f746762ae271cbb672a9cdd208caeac50a0a08cd))
- feat: each assistant runs its own role, charter, rules and thread ([`0581afd`](https://github.com/JLRoper/agent-worktree-gui/commit/0581afdd5dfe2f093f1bf01095f55da19d9cc30b))

### Other

- Pin a built console's place, and the order placeRow gives up its detail ([`d434db7`](https://github.com/JLRoper/agent-worktree-gui/commit/d434db7c326ea165a63ede8d0abef20053ee58ea))
- Give the frame sampler a rebuild layout that builds a card ([`89816a9`](https://github.com/JLRoper/agent-worktree-gui/commit/89816a9e3821bfde2cdd17ffbbbc1fa79bc8c187))
- Record what a console a rebuild builds opens on ([`493cc37`](https://github.com/JLRoper/agent-worktree-gui/commit/493cc371aa6cecbeb8e6edbd2d3182fdbee4b00c))

## v0.45.0 — 2026-11-01 · 2 commits

[`29d2a0b`](https://github.com/JLRoper/agent-worktree-gui/commit/29d2a0b874b820cad0bae95a71f3e6d4a15ac44e) · [compare v0.44.1...v0.45.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.44.1...v0.45.0)

### Other

- Keep a console the reader was handed over out of the pacer's stick ([`93a7357`](https://github.com/JLRoper/agent-worktree-gui/commit/93a7357610bcb75b92f30da90b7a4d2c30b706ef))
- Place a console a rebuild builds before the frame that paints it ([`29d2a0b`](https://github.com/JLRoper/agent-worktree-gui/commit/29d2a0b874b820cad0bae95a71f3e6d4a15ac44e))

## v0.44.1 — 2026-11-01 · 7 commits

[`68d96e6`](https://github.com/JLRoper/agent-worktree-gui/commit/68d96e6d248b0a9a473b39634ba2d984f59acd53) · [compare v0.44.0...v0.44.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.44.0...v0.44.1)

### Other

- Stop rewriting a console row the panel has already drawn ([`74226c5`](https://github.com/JLRoper/agent-worktree-gui/commit/74226c51157f7258568ad4a1a64dc264471f488f))
- Reveal a growing console row by growing its text node ([`83aef7a`](https://github.com/JLRoper/agent-worktree-gui/commit/83aef7ab508bdccbcda36128d7bc0fcf6c5e66b1))
- Pin the console row's tail append against a small DOM model ([`8e76a0a`](https://github.com/JLRoper/agent-worktree-gui/commit/8e76a0ad14b02d1721b905556f4866c85b102618))
- Type a skill result's head, not all forty of its rows ([`d98f392`](https://github.com/JLRoper/agent-worktree-gui/commit/d98f392bf57d75a191346b816c055b405ab76365))
- Pin the rule that bounds a paced skill result to its head ([`0d3590b`](https://github.com/JLRoper/agent-worktree-gui/commit/0d3590be91c14cbddbf0e4594be9a94647589412))
- Address a console row through its own job, and keep a row's detail it already draws ([`89d896c`](https://github.com/JLRoper/agent-worktree-gui/commit/89d896c2b60c2e4558afac05a17f79fd3441c0b5))
- chore: 0.44.1 — a patch over main's 0.44.0 ([`68d96e6`](https://github.com/JLRoper/agent-worktree-gui/commit/68d96e6d248b0a9a473b39634ba2d984f59acd53))

## v0.44.0 — 2026-11-01 · 3 commits

[`768c5cc`](https://github.com/JLRoper/agent-worktree-gui/commit/768c5cc93a1b0ab009f4923d3db2f1ec194afabb) · [compare v0.43.0...v0.44.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.43.0...v0.44.0)

### Docs & tests

- test: pin the assistant's two rows, and the sub-tab that survives a reload ([`feefeeb`](https://github.com/JLRoper/agent-worktree-gui/commit/feefeebcd4bd5363cc47e19c53b6f0e4c1ab7ef8))

### Other

- tools: measure a console for drift after the wheel stops (#159) ([`e8576e8`](https://github.com/JLRoper/agent-worktree-gui/commit/e8576e8209fda9c6bd1f8cdc8e03f8e3b5847476))
- tools: soak a board at a day's event volume and count what grows ([`768c5cc`](https://github.com/JLRoper/agent-worktree-gui/commit/768c5cc93a1b0ab009f4923d3db2f1ec194afabb))

## v0.43.0 — 2026-11-01 · 1 commit

[`6d1c9c0`](https://github.com/JLRoper/agent-worktree-gui/commit/6d1c9c02734a9568a948299eb43fe8c4fa77e646) · [compare v0.42.0...v0.43.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.42.0...v0.43.0)

### Added

- feat: the assistant float's two rows, and one {assistant, subTab} record (0.43.0) ([`6d1c9c0`](https://github.com/JLRoper/agent-worktree-gui/commit/6d1c9c02734a9568a948299eb43fe8c4fa77e646))

## v0.42.0 — 2026-11-01 · 2 commits

[`6dcf1ba`](https://github.com/JLRoper/agent-worktree-gui/commit/6dcf1baebdddbadb78ee9960334da721c42cc89b) · [compare v0.41.1...v0.42.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.41.1...v0.42.0)

### Added

- feat: a fold the reader opens holds the console still, behind a switch that ships off (0.42.0) ([`6dcf1ba`](https://github.com/JLRoper/agent-worktree-gui/commit/6dcf1baebdddbadb78ee9960334da721c42cc89b))

### Docs & tests

- test: pin the per-card input guard with a wheel over another card ([`6714a3d`](https://github.com/JLRoper/agent-worktree-gui/commit/6714a3d0cfb3e3199f49515e12fb8fecec1e47ee))

## v0.41.1 — 2026-11-01 · 1 commit

[`d0f83e5`](https://github.com/JLRoper/agent-worktree-gui/commit/d0f83e585ae01e1881b0f77b80c5b2c68545d2c3) · [compare v0.41.0...v0.41.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.41.0...v0.41.1)

### Fixed

- fix: keep a pinned console pinned when another card is scrolled ([`d0f83e5`](https://github.com/JLRoper/agent-worktree-gui/commit/d0f83e585ae01e1881b0f77b80c5b2c68545d2c3))

## v0.41.0 — 2026-10-31 · 1 commit

[`0e391af`](https://github.com/JLRoper/agent-worktree-gui/commit/0e391af5acb3567cccff783f21c885cabcf82fce) · [compare v0.40.1...v0.41.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.40.1...v0.41.0)

### Added

- feat: wake the assistant when a run's card is EXITED (0.41.0) ([`0e391af`](https://github.com/JLRoper/agent-worktree-gui/commit/0e391af5acb3567cccff783f21c885cabcf82fce))

## v0.40.1 — 2026-10-31 · 1 commit

[`f4098b0`](https://github.com/JLRoper/agent-worktree-gui/commit/f4098b0934a5906c39b3ce3deaeb894e7a2cc0c1) · [compare v0.40.0...v0.40.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.40.0...v0.40.1)

### Added

- feat: measure the combined console's output routing with four agents (0.38.1) (#154) ([`f4098b0`](https://github.com/JLRoper/agent-worktree-gui/commit/f4098b0934a5906c39b3ce3deaeb894e7a2cc0c1))

## v0.40.0 — 2026-10-31 · 1 commit

[`df0048a`](https://github.com/JLRoper/agent-worktree-gui/commit/df0048a97b841d8eff12a93dedd9ea9c9b6851ae) · [compare v0.39.1...v0.40.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.39.1...v0.40.0)

### Added

- feat: measure a pinned console and a card parked 80 px up, with four agents writing (0.40.0) ([`df0048a`](https://github.com/JLRoper/agent-worktree-gui/commit/df0048a97b841d8eff12a93dedd9ea9c9b6851ae))

## v0.39.1 — 2026-10-31 · 3 commits

[`4194b3f`](https://github.com/JLRoper/agent-worktree-gui/commit/4194b3f851fd166c3b51952c49cc9d609c9ca699) · [compare v0.39.0...v0.39.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.39.0...v0.39.1)

### Docs & tests

- test: pin the one-line shape, its Settings row, and the card's signature ([`456865d`](https://github.com/JLRoper/agent-worktree-gui/commit/456865dc2f80612347f10f73a8afc2f380012384))
- test: prove the one-line shape in a browser, both ways, on one card ([`7f24cc9`](https://github.com/JLRoper/agent-worktree-gui/commit/7f24cc92be1ce1782f46c7c8c4aab0adcf8ffc44))
- test: count cross-card console moves with three cards streaming ([`4194b3f`](https://github.com/JLRoper/agent-worktree-gui/commit/4194b3f851fd166c3b51952c49cc9d609c9ca699))

## v0.39.0 — 2026-10-31 · 1 commit

[`9689b51`](https://github.com/JLRoper/agent-worktree-gui/commit/9689b51e55d17e1bab6be1c50fccd157805eff39) · [compare v0.38.1...v0.39.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.38.1...v0.39.0)

### Added

- feat: draw a tool call as ONE expandable line, behind a Settings switch (0.39.0) ([`9689b51`](https://github.com/JLRoper/agent-worktree-gui/commit/9689b51e55d17e1bab6be1c50fccd157805eff39))

## v0.38.1 — 2026-10-31 · 2 commits

[`81fd805`](https://github.com/JLRoper/agent-worktree-gui/commit/81fd8053f79110f95eb570f6507457b6c13b83ae) · [compare v0.38.0...v0.38.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.38.0...v0.38.1)

### Other

- Make three browser gates repaint the card they test before measuring it ([`8c2ab29`](https://github.com/JLRoper/agent-worktree-gui/commit/8c2ab296310dd331df8d772f883b5dc4fb821dbc))
- Land the flicker's approval on a parked console, and let a gate start with no tty ([`81fd805`](https://github.com/JLRoper/agent-worktree-gui/commit/81fd8053f79110f95eb570f6507457b6c13b83ae))

## v0.38.0 — 2026-10-31 · 1 commit

[`2442247`](https://github.com/JLRoper/agent-worktree-gui/commit/244224713da4413b7340e3e68ba8ce8df4cce2a1) · [compare v0.37.1...v0.38.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.37.1...v0.38.0)

### Added

- feat: draw a run of tool calls as one group of rows, ruled top and bottom (0.38.0) ([`2442247`](https://github.com/JLRoper/agent-worktree-gui/commit/244224713da4413b7340e3e68ba8ce8df4cce2a1))

## v0.37.1 — 2026-10-31 · 1 commit

[`d48e230`](https://github.com/JLRoper/agent-worktree-gui/commit/d48e23076c3c2959f6d424c83739ad653e2070a2) · [compare v0.37.0...v0.37.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.37.0...v0.37.1)

### Docs & tests

- test: the combined console's first line, counted as writes and frames ([`d48e230`](https://github.com/JLRoper/agent-worktree-gui/commit/d48e23076c3c2959f6d424c83739ad653e2070a2))

## v0.37.0 — 2026-10-31 · 1 commit

[`84ca277`](https://github.com/JLRoper/agent-worktree-gui/commit/84ca277c051ca78acb2082d30554cb2a6a32a843) · [compare v0.36.1...v0.37.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.36.1...v0.37.0)

### Other

- Make the Settings row say it refreshes the model list too, and date both halves ([`84ca277`](https://github.com/JLRoper/agent-worktree-gui/commit/84ca277c051ca78acb2082d30554cb2a6a32a843))

## v0.36.1 — 2026-10-31 · 1 commit

[`7090c01`](https://github.com/JLRoper/agent-worktree-gui/commit/7090c01c405fd6f9456cb323d396a3bf2d3e68d3) · [compare v0.36.0...v0.36.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.36.0...v0.36.1)

### Other

- Stop the guard's shim from dying with the worktree that installed it ([`7090c01`](https://github.com/JLRoper/agent-worktree-gui/commit/7090c01c405fd6f9456cb323d396a3bf2d3e68d3))

## v0.36.0 — 2026-10-31 · 1 commit

[`d1aa72a`](https://github.com/JLRoper/agent-worktree-gui/commit/d1aa72a21f7c32d817ec5b772ef2fcf8ff82997f) · [compare v0.35.2...v0.36.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.35.2...v0.36.0)

### Fixed

- fix: name a tree only when its run has settled, and never after a title that promises work (0.36.0) ([`d1aa72a`](https://github.com/JLRoper/agent-worktree-gui/commit/d1aa72a21f7c32d817ec5b772ef2fcf8ff82997f))

## v0.35.2 — 2026-10-31 · 1 commit

[`81943df`](https://github.com/JLRoper/agent-worktree-gui/commit/81943dff0b1cfd8b83a3274d2f2e0c1abce173fc) · [compare v0.35.1...v0.35.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.35.1...v0.35.2)

### Docs & tests

- docs: the card's cwd is a request, and it now says so ([`81943df`](https://github.com/JLRoper/agent-worktree-gui/commit/81943dff0b1cfd8b83a3274d2f2e0c1abce173fc))

## v0.35.1 — 2026-10-31 · 1 commit

[`dfdf055`](https://github.com/JLRoper/agent-worktree-gui/commit/dfdf0550722dd9262bccde3ccab2acef39db1c5b) · [compare v0.35.0...v0.35.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.35.0...v0.35.1)

### Fixed

- fix: a TODO line's id is the leading integer, so a trailing reason no longer refuses the line ([`dfdf055`](https://github.com/JLRoper/agent-worktree-gui/commit/dfdf0550722dd9262bccde3ccab2acef39db1c5b))

## v0.35.0 — 2026-10-31 · 1 commit

[`ac2ea8a`](https://github.com/JLRoper/agent-worktree-gui/commit/ac2ea8a9e53a95b0dc37d72a633b9f6a19e7695d) · [compare v0.34.4...v0.35.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.34.4...v0.35.0)

### Added

- feat: set every piece of the 🌊 stream apart with the reasoning block's blank line ([`ac2ea8a`](https://github.com/JLRoper/agent-worktree-gui/commit/ac2ea8a9e53a95b0dc37d72a633b9f6a19e7695d))

## v0.34.4 — 2026-10-31 · 1 commit

[`f98a82b`](https://github.com/JLRoper/agent-worktree-gui/commit/f98a82b0527d488b7cdcac3b255379df287b2a57) · [compare v0.34.3...v0.34.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.34.3...v0.34.4)

### Docs & tests

- docs: the expanded console's size is a DOM attribute, and every rebuild drops it ([`f98a82b`](https://github.com/JLRoper/agent-worktree-gui/commit/f98a82b0527d488b7cdcac3b255379df287b2a57))

## v0.34.3 — 2026-10-31 · 1 commit

[`f56691a`](https://github.com/JLRoper/agent-worktree-gui/commit/f56691ad96a33ee5a0c62610cdad42339bce23f1) · [compare v0.34.2...v0.34.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.34.2...v0.34.3)

### Docs & tests

- docs: the stream console's relative write cannot touch a pinned console - measured ([`f56691a`](https://github.com/JLRoper/agent-worktree-gui/commit/f56691ad96a33ee5a0c62610cdad42339bce23f1))

## v0.34.2 — 2026-10-31 · 2 commits

[`a53aaba`](https://github.com/JLRoper/agent-worktree-gui/commit/a53aabad71632b8d6a554740bf906827a4ae2f3d) · [compare v0.34.1...v0.34.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.34.1...v0.34.2)

### Fixed

- fix: a re-install puts the version gate back into an existing worktree ([`a53aaba`](https://github.com/JLRoper/agent-worktree-gui/commit/a53aabad71632b8d6a554740bf906827a4ae2f3d))

### Docs & tests

- docs: console popping in slot B — the main console hops, the reasoning box holds ([`9628503`](https://github.com/JLRoper/agent-worktree-gui/commit/9628503ee8335a4a9f608e3ce2ab3cb0b97b9893))

## v0.34.1 — 2026-10-31 · 9 commits

[`31bda32`](https://github.com/JLRoper/agent-worktree-gui/commit/31bda32927d59bb0567a27d4ce235e1f2587128e) · [compare v0.34.0...v0.34.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.34.0...v0.34.1)

### Fixed

- fix: re-ordering a row's cards no longer resets their consoles ([`6ca7964`](https://github.com/JLRoper/agent-worktree-gui/commit/6ca79644b7cfe3d59ad1b0bcd546f305d7738b1d))
- fix: a subagent strip repaints for its own children, not the whole board ([`fdbec2f`](https://github.com/JLRoper/agent-worktree-gui/commit/fdbec2f40eb786968473cd0a1f11f58dae59f12f))
- fix: the push guard chains the repository's version gate ([`31bda32`](https://github.com/JLRoper/agent-worktree-gui/commit/31bda32927d59bb0567a27d4ce235e1f2587128e))

### Docs & tests

- test: a fifth layout for the gate - two cards of one row swapping places ([`34cfbce`](https://github.com/JLRoper/agent-worktree-gui/commit/34cfbcefad44cf03d2ff74b3c31803812ed9ca75))
- docs: measure the console lag - the live board reproduces it, no sandbox does ([`5208297`](https://github.com/JLRoper/agent-worktree-gui/commit/52082977e6f8c959399069d3acf2d8ac39ed70a2))
- test: a sixth gate layout for two sessions with open subagent consoles ([`298e75b`](https://github.com/JLRoper/agent-worktree-gui/commit/298e75bd7befef7db42e29ac9d41b176c024e9ed))
- docs: record the console's pops as writes, and rank the callers ([`0860d60`](https://github.com/JLRoper/agent-worktree-gui/commit/0860d60763bcc69c369e9846244dbfd7b7855cc1))
- docs: the console pops under one agent at 13 a minute, and its tail never holds a minute ([`9f0007f`](https://github.com/JLRoper/agent-worktree-gui/commit/9f0007f5c92fc49aa3f51387cd061479af60a1f5))

### Other

- measure: slot A of the console-popping campaign — the output console sags one frame, the reasoning box never does ([`0c1a73e`](https://github.com/JLRoper/agent-worktree-gui/commit/0c1a73eab01ef0b179b521c10e20baaeee45314f))

## v0.34.0 — 2026-10-31 · 2 commits

[`4ad107f`](https://github.com/JLRoper/agent-worktree-gui/commit/4ad107f2c0701623c6cf497676c1efc9815f2268) · [compare v0.33.2...v0.34.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.33.2...v0.34.0)

### Docs & tests

- test: gate console independence in four board layouts ([`ac1e119`](https://github.com/JLRoper/agent-worktree-gui/commit/ac1e1196500b097d596baeb5d3e67afa519a8e62))

### Other

- chore: 0.34.0 - a console-independence gate in four layouts is a new check (minor) ([`4ad107f`](https://github.com/JLRoper/agent-worktree-gui/commit/4ad107f2c0701623c6cf497676c1efc9815f2268))

## v0.33.2 — 2026-10-31 · 2 commits

[`bb838f0`](https://github.com/JLRoper/agent-worktree-gui/commit/bb838f0405a3d0d6e9cabfbf969d3b325c76f6b5) · [compare v0.33.1...v0.33.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.33.1...v0.33.2)

### Docs & tests

- docs: map the architecture and the design elements behind it ([`bb838f0`](https://github.com/JLRoper/agent-worktree-gui/commit/bb838f0405a3d0d6e9cabfbf969d3b325c76f6b5))

### Other

- Speed up test suite and consolidate Playwright/panel test harness helpers ([`e0c1854`](https://github.com/JLRoper/agent-worktree-gui/commit/e0c1854dc4641db53719b19ce53a44e81cff091c))

## v0.33.1 — 2026-10-31 · 6 commits

[`918b44c`](https://github.com/JLRoper/agent-worktree-gui/commit/918b44c69de554d509f325778a5cecb96766d8b4) · [compare v0.33.0...v0.33.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.33.0...v0.33.1)

### Added

- feat: Thinking text, Skill output and Console text are three settings, and a tool's output waits for the thought before it (#126) ([`7cda0b3`](https://github.com/JLRoper/agent-worktree-gui/commit/7cda0b3934f1cdb856f589fa66210d54c008af0f))

### Fixed

- fix: a settle's wake is exempt from the hourly budget (#128) ([`37b9181`](https://github.com/JLRoper/agent-worktree-gui/commit/37b91814324e2abff9d22d9a599fcb29733328a3))
- fix: a console is not reset by a re-rank that is not about it (0.33.1) ([`8f2a24d`](https://github.com/JLRoper/agent-worktree-gui/commit/8f2a24dbadecde8f1bf2d049ea186769fc477c74))

### Docs & tests

- test: pin the completion arm of the settle's budget exemption (#129) ([`e965d65`](https://github.com/JLRoper/agent-worktree-gui/commit/e965d65e015cce52b148280b9c060c61b0b61e0c))
- docs: record the console scroll hop's fix, and make the harness gate on it ([`918b44c`](https://github.com/JLRoper/agent-worktree-gui/commit/918b44c69de554d509f325778a5cecb96766d8b4))

### Other

- Add a settings toggle for auto-worktree cleanup, and a release sweep that respects it (#127) ([`a2d41c1`](https://github.com/JLRoper/agent-worktree-gui/commit/a2d41c119d279995bdf492a4c1a79c67fe8df6a4))

## v0.33.0 — 2026-10-30 · 1 commit

[`e5722e6`](https://github.com/JLRoper/agent-worktree-gui/commit/e5722e6f91c03a33fd1a108a320c98aa2420f920) · [compare v0.32.7...v0.33.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.32.7...v0.33.0)

### Other

- Each wake threshold folds under the rule that reads it (0.33.0) (#124) ([`e5722e6`](https://github.com/JLRoper/agent-worktree-gui/commit/e5722e6f91c03a33fd1a108a320c98aa2420f920))

## v0.32.7 — 2026-10-30 · 2 commits

[`1b79deb`](https://github.com/JLRoper/agent-worktree-gui/commit/1b79deba8c2531142df67e8f142449e6b43040a0) · [compare v0.32.6...v0.32.7](https://github.com/JLRoper/agent-worktree-gui/compare/v0.32.6...v0.32.7)

### Docs & tests

- docs: name the console scroll hop's trigger — reorderProjects re-appending every section on the reorder clock (#125) ([`b1613a6`](https://github.com/JLRoper/agent-worktree-gui/commit/b1613a6013f48dc8e8ce21c58bd7c005c827956e))
- docs: rank every shared write that can reset all consoles at once (#123) ([`1b79deb`](https://github.com/JLRoper/agent-worktree-gui/commit/1b79deba8c2531142df67e8f142449e6b43040a0))

## v0.32.6 — 2026-10-30 · 4 commits

[`e1bdb0e`](https://github.com/JLRoper/agent-worktree-gui/commit/e1bdb0e32f2401336b184023c9c3e09c76bcba24) · [compare v0.32.5...v0.32.6](https://github.com/JLRoper/agent-worktree-gui/compare/v0.32.5...v0.32.6)

### Fixed

- fix: patch the thinking block, and make a jobline count as liveness (0.32.6) (#122) ([`e1bdb0e`](https://github.com/JLRoper/agent-worktree-gui/commit/e1bdb0e32f2401336b184023c9c3e09c76bcba24))

### Docs & tests

- docs: three architectural reviews (organization, efficiency, functional) (#119) ([`8dbef46`](https://github.com/JLRoper/agent-worktree-gui/commit/8dbef46431295a271531822397990052db3d3873))
- docs: reconcile the three jitter investigations, and one test that measures them (#120) ([`a7cb1cc`](https://github.com/JLRoper/agent-worktree-gui/commit/a7cb1cc57de43b0b3a6db1e3941e222450412267))
- docs: land the three jitter source reports #120 cited but never shipped (#121) ([`74edf80`](https://github.com/JLRoper/agent-worktree-gui/commit/74edf809deb73e2fde5b58a958216dbc761a8e06))

## v0.32.5 — 2026-10-30 · 2 commits

[`6ccf004`](https://github.com/JLRoper/agent-worktree-gui/commit/6ccf004aaf2cf4f3ebd33ac8712c4857826e47e1) · [compare v0.32.4...v0.32.5](https://github.com/JLRoper/agent-worktree-gui/compare/v0.32.4...v0.32.5)

### Other

- Previous turn on send is a three-way setting, not one fold (#114) ([`b64642d`](https://github.com/JLRoper/agent-worktree-gui/commit/b64642d7c3f6396923707f2121ee51b4e95bdf7d))
- Every settings group starts folded, and the panel gains a search box (0.32.5) (#118) ([`6ccf004`](https://github.com/JLRoper/agent-worktree-gui/commit/6ccf004aaf2cf4f3ebd33ac8712c4857826e47e1))

## v0.32.4 — 2026-10-30 · 1 commit

[`5528137`](https://github.com/JLRoper/agent-worktree-gui/commit/5528137f3bbdc2dcdf03dc60cc19a095758d2f35) · [compare v0.32.3...v0.32.4](https://github.com/JLRoper/agent-worktree-gui/compare/v0.32.3...v0.32.4)

### Fixed

- fix: keep the assistant float's corner under the cursor at any page zoom (#113) ([`5528137`](https://github.com/JLRoper/agent-worktree-gui/commit/5528137f3bbdc2dcdf03dc60cc19a095758d2f35))

## v0.32.3 — 2026-10-30 · 1 commit

[`60e3c5a`](https://github.com/JLRoper/agent-worktree-gui/commit/60e3c5aced3170be77eea0c95ae946c9f0ae8e09) · [compare v0.32.2...v0.32.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.32.2...v0.32.3)

### Other

- Stop a plain click on a resize grab from counting as a drag (#112) ([`60e3c5a`](https://github.com/JLRoper/agent-worktree-gui/commit/60e3c5aced3170be77eea0c95ae946c9f0ae8e09))

## v0.32.2 — 2026-10-30 · 1 commit

[`6b8724a`](https://github.com/JLRoper/agent-worktree-gui/commit/6b8724a530392d77be2e69f54ee9b282a3b39733) · [compare v0.32.1...v0.32.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.32.1...v0.32.2)

### Fixed

- fix: hold the reading line in the frame that moved it (#111) ([`6b8724a`](https://github.com/JLRoper/agent-worktree-gui/commit/6b8724a530392d77be2e69f54ee9b282a3b39733))

## v0.32.1 — 2026-10-30 · 1 commit

[`1cd8616`](https://github.com/JLRoper/agent-worktree-gui/commit/1cd8616a07b9a8011983abd66f6dc37ce49da6a9) · [compare v0.32.0...v0.32.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.32.0...v0.32.1)

### Fixed

- fix: a live call joins the burst the next repaint cuts it into ([`1cd8616`](https://github.com/JLRoper/agent-worktree-gui/commit/1cd8616a07b9a8011983abd66f6dc37ce49da6a9))

## v0.32.0 — 2026-10-30 · 3 commits

[`999706a`](https://github.com/JLRoper/agent-worktree-gui/commit/999706a223a2e41e8b75444d0f6433f600cd7e01) · [compare v0.31.0...v0.32.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.31.0...v0.32.0)

### Added

- feat: wake the assistant when a worker's run settles, done or failed ([`120a03f`](https://github.com/JLRoper/agent-worktree-gui/commit/120a03fddcd138f17d3eac75214233e9575b223d))

### Other

- Give a grown assistant float's room to the open turn's console ([`2f97d55`](https://github.com/JLRoper/agent-worktree-gui/commit/2f97d554e7903e62597645a5ade49895fb27fb2b))
- Settings owns the two read-now gestures, and its groups fold (0.32.0) ([`999706a`](https://github.com/JLRoper/agent-worktree-gui/commit/999706a223a2e41e8b75444d0f6433f600cd7e01))

## v0.31.0 — 2026-10-30 · 1 commit

[`f406a94`](https://github.com/JLRoper/agent-worktree-gui/commit/f406a942270c47f894c580a06fd203c34a567dfd) · [compare v0.30.2...v0.31.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.30.2...v0.31.0)

### Other

- Stop the assistant float jumping the moment a grab starts ([`f406a94`](https://github.com/JLRoper/agent-worktree-gui/commit/f406a942270c47f894c580a06fd203c34a567dfd))

## v0.30.2 — 2026-10-30 · 1 commit

[`1c4e573`](https://github.com/JLRoper/agent-worktree-gui/commit/1c4e5732b14ee343354ca6ccb0dbef841ee04174) · [compare v0.30.1...v0.30.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.30.1...v0.30.2)

### Docs & tests

- docs: audit the always-loaded skill and name the split that would shrink it (#104) ([`1c4e573`](https://github.com/JLRoper/agent-worktree-gui/commit/1c4e5732b14ee343354ca6ccb0dbef841ee04174))

## v0.30.1 — 2026-10-30 · 1 commit

[`6e074ee`](https://github.com/JLRoper/agent-worktree-gui/commit/6e074ee4c3f01531228742583e32bfe36e15907a) · [compare v0.30.0...v0.30.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.30.0...v0.30.1)

### Fixed

- fix: stop the one-stream console being rebuilt under the reader on every poll ([`6e074ee`](https://github.com/JLRoper/agent-worktree-gui/commit/6e074ee4c3f01531228742583e32bfe36e15907a))

## v0.30.0 — 2026-10-30 · 1 commit

[`2db77ec`](https://github.com/JLRoper/agent-worktree-gui/commit/2db77ec3ef1a4598a35035bf2660c9a42f4dbfaf) · [compare v0.29.0...v0.30.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.29.0...v0.30.0)

### Other

- Give the assistant float eight resize grabs that track the pointer (#105) ([`2db77ec`](https://github.com/JLRoper/agent-worktree-gui/commit/2db77ec3ef1a4598a35035bf2660c9a42f4dbfaf))

## v0.29.0 — 2026-10-30 · 1 commit

[`dad67fc`](https://github.com/JLRoper/agent-worktree-gui/commit/dad67fc7cd1663f36dc1673407a9b14e0a20bca6) · [compare v0.28.0...v0.29.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.28.0...v0.29.0)

### Added

- feat: measure the normal console on a real transcript, and gate the wipe (0.29.0) ([`dad67fc`](https://github.com/JLRoper/agent-worktree-gui/commit/dad67fc7cd1663f36dc1673407a9b14e0a20bca6))

## v0.28.0 — 2026-10-29 · 3 commits

[`4916b6e`](https://github.com/JLRoper/agent-worktree-gui/commit/4916b6e8cd7692f1fd01f2b1c3ba93a9830f6d67) · [compare v0.27.0...v0.28.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.27.0...v0.28.0)

### Fixed

- fix: stop the reasoning block collapsing back to a prefix it typed a minute ago (#99) ([`24b1ca1`](https://github.com/JLRoper/agent-worktree-gui/commit/24b1ca1566e2a225290c56f75ebfbcedf4a02e98))

### Docs & tests

- docs: measure the reasoning block on a live turn, and gate the empty read ([`d452bf5`](https://github.com/JLRoper/agent-worktree-gui/commit/d452bf5dcc6d6a332c5a546c9101c2668cc9cfba))

### Other

- chore: 0.28.0 — claim the level the redraw fix and its measurement never moved (#102) ([`4916b6e`](https://github.com/JLRoper/agent-worktree-gui/commit/4916b6e8cd7692f1fd01f2b1c3ba93a9830f6d67))

## v0.27.0 — 2026-10-29 · 1 commit

[`4b7c1c1`](https://github.com/JLRoper/agent-worktree-gui/commit/4b7c1c1ef5871bb234d7ac62a32614873be2b4e0) · [compare v0.26.0...v0.27.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.26.0...v0.27.0)

### Other

- Let the reader switch off any worktree-chart column, from config.json ([`4b7c1c1`](https://github.com/JLRoper/agent-worktree-gui/commit/4b7c1c1ef5871bb234d7ac62a32614873be2b4e0))

## v0.26.0 — 2026-10-29 · 1 commit

[`b6c7c67`](https://github.com/JLRoper/agent-worktree-gui/commit/b6c7c677f4a7dc936a5aad762a16ac7c72b533ca) · [compare v0.25.0...v0.26.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.25.0...v0.26.0)

### Other

- Add New Agent reasoning controls and remove inert YOLO (0.26.0) ([`b6c7c67`](https://github.com/JLRoper/agent-worktree-gui/commit/b6c7c677f4a7dc936a5aad762a16ac7c72b533ca))

## v0.25.0 — 2026-10-29 · 1 commit

[`aea5b9b`](https://github.com/JLRoper/agent-worktree-gui/commit/aea5b9bee77af270ac23fe5810c2e92feaa0e247) · [compare v0.24.2...v0.25.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.24.2...v0.25.0)

### Other

- Give a row a plus that cuts a child worktree from its branch ([`aea5b9b`](https://github.com/JLRoper/agent-worktree-gui/commit/aea5b9bee77af270ac23fe5810c2e92feaa0e247))

## v0.24.2 — 2026-10-29 · 1 commit

[`7c3d8cc`](https://github.com/JLRoper/agent-worktree-gui/commit/7c3d8cce2400a7deb6c4d92caeb8ddd2741c59b5) · [compare v0.24.1...v0.24.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.24.1...v0.24.2)

### Fixed

- fix: open complete tool output in one box (#91) ([`7c3d8cc`](https://github.com/JLRoper/agent-worktree-gui/commit/7c3d8cce2400a7deb6c4d92caeb8ddd2741c59b5))

## v0.24.1 — 2026-10-29 · 1 commit

[`2a9e231`](https://github.com/JLRoper/agent-worktree-gui/commit/2a9e231d2b4dc610c7c929da91ac8baf48e3c4af) · [compare v0.24.0...v0.24.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.24.0...v0.24.1)

### Fixed

- fix: Keep long TODO text inline with its status and actions (#87) ([`2a9e231`](https://github.com/JLRoper/agent-worktree-gui/commit/2a9e231d2b4dc610c7c929da91ac8baf48e3c4af))

## v0.24.0 — 2026-10-29 · 1 commit

[`68864f3`](https://github.com/JLRoper/agent-worktree-gui/commit/68864f3a55319b0b610b814a3172831e5d187f61) · [compare v0.23.0...v0.24.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.23.0...v0.24.0)

### Other

- Let a tree with nothing to land be released (0.24.0) ([`68864f3`](https://github.com/JLRoper/agent-worktree-gui/commit/68864f3a55319b0b610b814a3172831e5d187f61))

## v0.23.0 — 2026-10-29 · 1 commit

[`6842c67`](https://github.com/JLRoper/agent-worktree-gui/commit/6842c67c5d8b64e3778b48d5df9e15c1d902cf7a) · [compare v0.22.0...v0.23.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.22.0...v0.23.0)

### Other

- Give a row a ⟳ that reconciles it: its TODO against its own commits, its description against its own work (#86) ([`6842c67`](https://github.com/JLRoper/agent-worktree-gui/commit/6842c67c5d8b64e3778b48d5df9e15c1d902cf7a))

## v0.22.0 — 2026-10-29 · 2 commits

[`fdc13c4`](https://github.com/JLRoper/agent-worktree-gui/commit/fdc13c40b413c8ed918f4a309775b939677d0eac) · [compare v0.21.0...v0.22.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.21.0...v0.22.0)

### Other

- Pin the once-only tree rename with the three cases the rule names ([`2f3c323`](https://github.com/JLRoper/agent-worktree-gui/commit/2f3c32359460cd937ec558fa426fa1f241c5b2a1))
- Let a worker ask the panel to release its own worktree ([`fdc13c4`](https://github.com/JLRoper/agent-worktree-gui/commit/fdc13c40b413c8ed918f4a309775b939677d0eac))

## v0.21.0 — 2026-10-29 · 1 commit

[`24d61aa`](https://github.com/JLRoper/agent-worktree-gui/commit/24d61aa9e95ea586031ffd055c7cdbc1e6a3820a) · [compare v0.20.0...v0.21.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.20.0...v0.21.0)

### Other

- Fold every tool result into one collapsible box (0.21.0) ([`24d61aa`](https://github.com/JLRoper/agent-worktree-gui/commit/24d61aa9e95ea586031ffd055c7cdbc1e6a3820a))

## v0.20.0 — 2026-10-29 · 1 commit

[`9fa7bb1`](https://github.com/JLRoper/agent-worktree-gui/commit/9fa7bb1d1db9b3486e245f73f23eca1e9a37bd17) · [compare v0.19.1...v0.20.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.19.1...v0.20.0)

### Other

- Give the UNMERGED chip a rebase that catches a child up to its parent ([`9fa7bb1`](https://github.com/JLRoper/agent-worktree-gui/commit/9fa7bb1d1db9b3486e245f73f23eca1e9a37bd17))

## v0.19.1 — 2026-10-29 · 1 commit

[`d431859`](https://github.com/JLRoper/agent-worktree-gui/commit/d4318598ae6f0f2f662cccec9f01ec32dab93657) · [compare v0.19.0...v0.19.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.19.0...v0.19.1)

### Other

- Stop tracking the brief: remove PROMPT.md and ignore it (#81) ([`d431859`](https://github.com/JLRoper/agent-worktree-gui/commit/d4318598ae6f0f2f662cccec9f01ec32dab93657))

## v0.19.0 — 2026-10-29 · 1 commit

[`3958b37`](https://github.com/JLRoper/agent-worktree-gui/commit/3958b373fbefe5eb0ab0d20abc7aa0574a5c4770) · [compare v0.18.0...v0.19.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.18.0...v0.19.0)

### Other

- Close the four console-repaint gaps the flicker tree left open (#80) ([`3958b37`](https://github.com/JLRoper/agent-worktree-gui/commit/3958b373fbefe5eb0ab0d20abc7aa0574a5c4770))

## v0.18.0 — 2026-10-29 · 2 commits

[`81496d9`](https://github.com/JLRoper/agent-worktree-gui/commit/81496d9162913c7af0761b00e9c3d578129e6f30) · [compare v0.17.0...v0.18.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.17.0...v0.18.0)

### Other

- Land local main's unpushed work: data directory, console flicker fix, lane A and B harnesses ([`d63971f`](https://github.com/JLRoper/agent-worktree-gui/commit/d63971f92aaba25358b0f2d44623975d08302c60))
- Ahead / Behind counts the branch against its own copy on the remote ([`81496d9`](https://github.com/JLRoper/agent-worktree-gui/commit/81496d9162913c7af0761b00e9c3d578129e6f30))

## v0.17.0 — 2026-10-28 · 1 commit

[`b396481`](https://github.com/JLRoper/agent-worktree-gui/commit/b3964811fbef03979094a01f9d67a592371258f3) · [compare v0.16.0...v0.17.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.16.0...v0.17.0)

### Other

- Draw an unverified branch in its own word, quoting the project's fetch note (#77) ([`b396481`](https://github.com/JLRoper/agent-worktree-gui/commit/b3964811fbef03979094a01f9d67a592371258f3))

## v0.16.0 — 2026-10-28 · 3 commits

[`7ebf077`](https://github.com/JLRoper/agent-worktree-gui/commit/7ebf0774ca340863c826892a0ca2277cac5a196b) · [compare v0.15.1...v0.16.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.15.1...v0.16.0)

### Other

- Reasoning types out too, on the same words/s the prose uses ([`c5a040f`](https://github.com/JLRoper/agent-worktree-gui/commit/c5a040f5ec90f6b6295c3cd37fb7d314557546da))
- A trimmed burst stays a group, keyed by its own call line ([`6fd22cf`](https://github.com/JLRoper/agent-worktree-gui/commit/6fd22cfcf433042a1559b1d92b4045c41088efdf))
- Pin the branch and PR cells, and give the harnesses one bootstrap and one runner (#76) ([`7ebf077`](https://github.com/JLRoper/agent-worktree-gui/commit/7ebf0774ca340863c826892a0ca2277cac5a196b))

## v0.15.1 — 2026-10-28 · 3 commits

[`2bda568`](https://github.com/JLRoper/agent-worktree-gui/commit/2bda56854d437bd26e8438995df802e0cb3f887b) · [compare v0.15.0...v0.15.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.15.0...v0.15.1)

### Fixed

- fix: hold a LANDED answer until the board has re-adopted its tree ([`7d888ce`](https://github.com/JLRoper/agent-worktree-gui/commit/7d888cea870b4d8519cc86493b194990e944c327))

### Docs & tests

- test: prove the sweep acts on a settled LANDED: YES card, and on nothing else ([`eb3b6dc`](https://github.com/JLRoper/agent-worktree-gui/commit/eb3b6dc70a081dc39ec95dc60195e7c02e35309a))
- docs: enumerate every guard between a local branch and the remote ([`2bda568`](https://github.com/JLRoper/agent-worktree-gui/commit/2bda56854d437bd26e8438995df802e0cb3f887b))

## v0.15.0 — 2026-10-28 · 1 commit

[`df7513e`](https://github.com/JLRoper/agent-worktree-gui/commit/df7513e2c8d27febca61fef8c1c956ed7b816755) · [compare v0.14.0...v0.15.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.14.0...v0.15.0)

### Other

- Let the console fill in at a reading pace: words typed out, lines walking in ([`df7513e`](https://github.com/JLRoper/agent-worktree-gui/commit/df7513e2c8d27febca61fef8c1c956ed7b816755))

## v0.14.0 — 2026-10-27 · 2 commits

[`30a51bb`](https://github.com/JLRoper/agent-worktree-gui/commit/30a51bb94da2b50949ca40f32648fa1aaab56a29) · [compare v0.13.0...v0.14.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.13.0...v0.14.0)

### Added

- feat: check a row against main with an agent, and recycle the tree when it is landed ([`2466ca9`](https://github.com/JLRoper/agent-worktree-gui/commit/2466ca9236801cfbec86a7d7035a77591d0d9031))

### Other

- chore: bump to 0.14.0 for the checked landing ([`30a51bb`](https://github.com/JLRoper/agent-worktree-gui/commit/30a51bb94da2b50949ca40f32648fa1aaab56a29))

## v0.13.0 — 2026-10-27 · 1 commit

[`1a24139`](https://github.com/JLRoper/agent-worktree-gui/commit/1a24139c10684bceb75117da04612ea9bc5b3a33) · [compare v0.12.1...v0.13.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.12.1...v0.13.0)

### Other

- Draw a card as ONE stream: reasoning, calls and their output in the order they happened ([`1a24139`](https://github.com/JLRoper/agent-worktree-gui/commit/1a24139c10684bceb75117da04612ea9bc5b3a33))

## v0.12.1 — 2026-10-27 · 1 commit

[`c0b46d2`](https://github.com/JLRoper/agent-worktree-gui/commit/c0b46d22068c1f555b5ddda3fedfaed70c563d39) · [compare v0.12.0...v0.12.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.12.0...v0.12.1)

### Fixed

- fix: draw the local chip from the remote's answer, and re-read a row whose branch moved (#72) ([`c0b46d2`](https://github.com/JLRoper/agent-worktree-gui/commit/c0b46d22068c1f555b5ddda3fedfaed70c563d39))

## v0.12.0 — 2026-10-27 · 1 commit

[`692c362`](https://github.com/JLRoper/agent-worktree-gui/commit/692c36295a2b3c307d3c61e017d748c12b707dc2) · [compare v0.11.2...v0.12.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.11.2...v0.12.0)

### Other

- Integration: spawn cards, the shared model picker, the command audit and the steward ([`692c362`](https://github.com/JLRoper/agent-worktree-gui/commit/692c36295a2b3c307d3c61e017d748c12b707dc2))

## v0.11.2 — 2026-10-27 · 3 commits

[`d8ae753`](https://github.com/JLRoper/agent-worktree-gui/commit/d8ae7539e3a088c4dcfdf197a2e5bbbc1a179319) · [compare v0.11.1...v0.11.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.11.1...v0.11.2)

### Fixed

- fix: write off a card the gateway answers unknown for, on evidence ([`3293b6c`](https://github.com/JLRoper/agent-worktree-gui/commit/3293b6ce2b470931a27104f62c0a52b0b9d5c713))
- fix: key the quiet alert on the run's own silence, not on the clock ([`643e39c`](https://github.com/JLRoper/agent-worktree-gui/commit/643e39ccd2acb6c194cfabfdfc816f3e4e4ba8e7))

### Other

- Bump to 0.11.2 for the unknown write-off and the quiet alert — patch ([`d8ae753`](https://github.com/JLRoper/agent-worktree-gui/commit/d8ae7539e3a088c4dcfdf197a2e5bbbc1a179319))

## v0.11.1 — 2026-10-26 · 2 commits

[`f27a5b1`](https://github.com/JLRoper/agent-worktree-gui/commit/f27a5b1dbb5b0d2de76bd3224f26b429303b4f16) · [compare v0.11.0...v0.11.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.11.0...v0.11.1)

### Fixed

- fix: read a RESTART line out of the prose that quotes it ([`c0e5069`](https://github.com/JLRoper/agent-worktree-gui/commit/c0e5069b3009e9acd53b4d1670ca194c9ed851b7))

### Other

- Bump to 0.11.1 for the RESTART line the harvest dropped — patch ([`f27a5b1`](https://github.com/JLRoper/agent-worktree-gui/commit/f27a5b1dbb5b0d2de76bd3224f26b429303b4f16))

## v0.11.0 — 2026-10-26 · 1 commit

[`814755b`](https://github.com/JLRoper/agent-worktree-gui/commit/814755b3fba9b17bcd36c176908659b92970faab) · [compare v0.10.3...v0.11.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.10.3...v0.11.0)

### Other

- Give the panel a spawn watchdog so a card nobody starts is named (#67) ([`814755b`](https://github.com/JLRoper/agent-worktree-gui/commit/814755b3fba9b17bcd36c176908659b92970faab))

## v0.10.3 — 2026-10-26 · 2 commits

[`27da6be`](https://github.com/JLRoper/agent-worktree-gui/commit/27da6be27e3ef36db305b63326920a8ae010e8da) · [compare v0.10.2...v0.10.3](https://github.com/JLRoper/agent-worktree-gui/compare/v0.10.2...v0.10.3)

### Other

- Stop the leftover alert firing on a tree a live run holds ([`4316783`](https://github.com/JLRoper/agent-worktree-gui/commit/431678336b88f36bb8bcf3408a244a0d4a794e1f))
- Bump to 0.10.3 for the leftover alert that fired on a held tree — patch ([`27da6be`](https://github.com/JLRoper/agent-worktree-gui/commit/27da6be27e3ef36db305b63326920a8ae010e8da))

## v0.10.2 — 2026-10-26 · 2 commits

[`df5905e`](https://github.com/JLRoper/agent-worktree-gui/commit/df5905e89614c0e316cc5624243b431efc03396c) · [compare v0.10.1...v0.10.2](https://github.com/JLRoper/agent-worktree-gui/compare/v0.10.1...v0.10.2)

### Other

- Attach the fold note's button on the reload path, and name the row it fetches ([`4f7e00c`](https://github.com/JLRoper/agent-worktree-gui/commit/4f7e00c25435f435e8b3ad0f808e27923e0e3a96))
- Bump to 0.10.2 for the fold note's clickable reload path — patch ([`df5905e`](https://github.com/JLRoper/agent-worktree-gui/commit/df5905e89614c0e316cc5624243b431efc03396c))

## v0.10.1 — 2026-10-26 · 2 commits

[`4410d38`](https://github.com/JLRoper/agent-worktree-gui/commit/4410d38a8e53ddb9b94b5d0f7be0760f0059bef3) · [compare v0.10.0...v0.10.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.10.0...v0.10.1)

### Other

- Define the push guard's allow_push above its first call, so the env grant bypasses ([`d18aba2`](https://github.com/JLRoper/agent-worktree-gui/commit/d18aba258a8e5a6078ca3cb2b1e3b7b6a2967a48))
- Bump to 0.10.1 for the push guard's bypass — patch ([`4410d38`](https://github.com/JLRoper/agent-worktree-gui/commit/4410d38a8e53ddb9b94b5d0f7be0760f0059bef3))

## v0.10.0 — 2026-10-26 · 2 commits

[`5697d08`](https://github.com/JLRoper/agent-worktree-gui/commit/5697d083c38ae0cb06c7ce728d26db7523b933ed) · [compare v0.9.0...v0.10.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.9.0...v0.10.0)

### Other

- Hide the console window on every child the panel starts ([`c7170a0`](https://github.com/JLRoper/agent-worktree-gui/commit/c7170a007e8da4a6e4e378cee6628015933f618d))
- Bump to 0.10.0 for the child-process audit gate — minor ([`5697d08`](https://github.com/JLRoper/agent-worktree-gui/commit/5697d083c38ae0cb06c7ce728d26db7523b933ed))

## v0.9.0 — 2026-10-26 · 3 commits

[`999289a`](https://github.com/JLRoper/agent-worktree-gui/commit/999289ad76bee39cfa458e15a279acb7d868d9f4) · [compare v0.8.1...v0.9.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.8.1...v0.9.0)

### Other

- Rows: stack each TODO item's facts as indented bullets under its line (#61) ([`4156a1a`](https://github.com/JLRoper/agent-worktree-gui/commit/4156a1aa4dff38f57c4facf1ab743754fcb0bfff))
- Give the assistant float a real fullscreen mode, and a composer that cannot be clipped ([`3d4203d`](https://github.com/JLRoper/agent-worktree-gui/commit/3d4203de47aa8ec37c5353928b1b625839c1bd65))
- Bump version to 0.9.0 — minor: a new reader-facing affordance ([`999289a`](https://github.com/JLRoper/agent-worktree-gui/commit/999289ad76bee39cfa458e15a279acb7d868d9f4))

## v0.8.1 — 2026-10-26 · 2 commits

[`8b4b1f0`](https://github.com/JLRoper/agent-worktree-gui/commit/8b4b1f027787c7f4b5ed107947ea2602ea95e7a3) · [compare v0.8.0...v0.8.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.8.0...v0.8.1)

### Docs & tests

- docs: SETUP prerequisites now match what the machine measures ([`0d8b38d`](https://github.com/JLRoper/agent-worktree-gui/commit/0d8b38dba84b09f47af4d39aff4dfa48b6285920))

### Other

- Bump to 0.8.1 for the SETUP prerequisites — patch ([`8b4b1f0`](https://github.com/JLRoper/agent-worktree-gui/commit/8b4b1f027787c7f4b5ed107947ea2602ea95e7a3))

## v0.8.0 — 2026-10-26 · 13 commits

[`0c8bba6`](https://github.com/JLRoper/agent-worktree-gui/commit/0c8bba6e9851c30c7561e334efa424c7cfbfde6c) · [compare v0.7.1...v0.8.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.7.1...v0.8.0)

### Docs & tests

- docs: index the review's findings per phase, with one checklist each ([`a14aada`](https://github.com/JLRoper/agent-worktree-gui/commit/a14aada75b66d669b17b4f99a7a44c58ff1243e6))
- test: npm test runs node:test, and boots the real server to assert routes ([`fff8ef6`](https://github.com/JLRoper/agent-worktree-gui/commit/fff8ef64a0ce3ea962d88fe66e4b4eced5ce264d))
- docs: mark phase 0 landed, with the counts the suite printed ([`cc76cad`](https://github.com/JLRoper/agent-worktree-gui/commit/cc76cad147b3019243dae38c768879d742237b84))
- test: give the sandbox its own discovery cache, so the real one is not swept ([`321be15`](https://github.com/JLRoper/agent-worktree-gui/commit/321be15eb1a943fe1108afc1c199ef5a9fb87b12))
- docs: record the running-board check and the blank-page A/B ([`284ee2d`](https://github.com/JLRoper/agent-worktree-gui/commit/284ee2d408a982ac92e80f0d41544174f22b8694))
- docs: the harness cache leak belongs in the phase record ([`8afb068`](https://github.com/JLRoper/agent-worktree-gui/commit/8afb068569ea5d7836a5fdcde5ae68424e5b42ab))
- test: scope npm test to test/*.test.js, so a nested worktree is not scanned ([`ca15de5`](https://github.com/JLRoper/agent-worktree-gui/commit/ca15de56ce72533dc56112b60e7852fd3cc438df))
- test: aim the auth assertions at the boundary main now draws ([`7ea9e08`](https://github.com/JLRoper/agent-worktree-gui/commit/7ea9e08b7e144f3335ad570c564df63cbdbadd8a))

### Other

- auth: /api/refresh, /api/visible, /api/fetch and /api/reload now fail closed ([`6571e44`](https://github.com/JLRoper/agent-worktree-gui/commit/6571e44eb17e0467240b64cd931e9ef5b34f31f8))
- open-url: drop cmd.exe from the opener, so a query string is not a command ([`5c1a80f`](https://github.com/JLRoper/agent-worktree-gui/commit/5c1a80fa5c4e00c5b9375001de14dddbfd2d7570))
- engines: require Node 22.5 in every place that advertises a floor ([`210b027`](https://github.com/JLRoper/agent-worktree-gui/commit/210b027aefb262e1a8f6ac9cd67c6bc1fe144606))
- errors: a fault answers 500 and is logged, and the state.db failure is named ([`8d98e61`](https://github.com/JLRoper/agent-worktree-gui/commit/8d98e61a30f07a2accc44201d652abede406ee86))
- Bump to 0.8.0 for the test harness and the honest error contract — minor ([`0c8bba6`](https://github.com/JLRoper/agent-worktree-gui/commit/0c8bba6e9851c30c7561e334efa424c7cfbfde6c))

## v0.7.1 — 2026-10-26 · 2 commits

[`e8acc27`](https://github.com/JLRoper/agent-worktree-gui/commit/e8acc27257593d8205170668517afd6206756a2b) · [compare v0.7.0...v0.7.1](https://github.com/JLRoper/agent-worktree-gui/compare/v0.7.0...v0.7.1)

### Other

- Keep the space the reader typed when a repaint rewrites the box ([`7a8d2a7`](https://github.com/JLRoper/agent-worktree-gui/commit/7a8d2a7bdea3bcf623286c5a5b7f570ebb427071))
- Bump to 0.7.1 for a fix: the repaint no longer eats a typed space ([`e8acc27`](https://github.com/JLRoper/agent-worktree-gui/commit/e8acc27257593d8205170668517afd6206756a2b))

## v0.7.0 — 2026-10-26 · 2 commits

[`78e2145`](https://github.com/JLRoper/agent-worktree-gui/commit/78e2145aabd04f388ffae9f02114b4cc91c7e129) · [compare v0.6.0...v0.7.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.6.0...v0.7.0)

### Other

- Give the assistant an aggressive switch that hands your settings back ([`8ad8307`](https://github.com/JLRoper/agent-worktree-gui/commit/8ad8307bf6c3d7cd7a664a091fe0d8a71ee66d8a))
- Bump to 0.7.0 for the aggressive switch, a new capability ([`78e2145`](https://github.com/JLRoper/agent-worktree-gui/commit/78e2145aabd04f388ffae9f02114b4cc91c7e129))

## v0.6.0 — 2026-10-26 · 1 commit

[`8ebc0f5`](https://github.com/JLRoper/agent-worktree-gui/commit/8ebc0f5d7bba8cc6bc3b4f919ed692315df08f79) · [compare v0.5.0...v0.6.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.5.0...v0.6.0)

### Added

- feat: give every worktree a TODO list its agents keep, and show the oldest open item ([`8ebc0f5`](https://github.com/JLRoper/agent-worktree-gui/commit/8ebc0f5d7bba8cc6bc3b4f919ed692315df08f79))

## v0.5.0 — 2026-10-26 · 1 commit

[`4480cf2`](https://github.com/JLRoper/agent-worktree-gui/commit/4480cf2c0a11190bf754addd41a1b180773f9b07) · [compare v0.4.0...v0.5.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.4.0...v0.5.0)

### Other

- Stream the whole tool result, and let the panel's fold open on a click (#57) ([`4480cf2`](https://github.com/JLRoper/agent-worktree-gui/commit/4480cf2c0a11190bf754addd41a1b180773f9b07))

## v0.4.0 — 2026-10-26 · 3 commits

[`3470b18`](https://github.com/JLRoper/agent-worktree-gui/commit/3470b18b48f2b64bc9c5bd8ba38bcab178c1d147) · [compare v0.3.0...v0.4.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.3.0...v0.4.0)

### Other

- Show what each session has spent, in tokens and in dollars ([`6060c03`](https://github.com/JLRoper/agent-worktree-gui/commit/6060c03a26de443d1105b3f612f878fcdaf7b05a))
- Prove the counts hold at a narrow window, and derive the anchor a compaction leaves ([`b06e555`](https://github.com/JLRoper/agent-worktree-gui/commit/b06e5555a04e6204bd2ab5891bb7cd61c97e1d07))
- Link the branch column to the remote, and default every new worktree to local only ([`3470b18`](https://github.com/JLRoper/agent-worktree-gui/commit/3470b18b48f2b64bc9c5bd8ba38bcab178c1d147))

## v0.3.0 — 2026-10-26 · 68 commits

[`c60805d`](https://github.com/JLRoper/agent-worktree-gui/commit/c60805d9d8c6badf78dd6649839ec51859091ecd) · [compare v0.2.0...v0.3.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.2.0...v0.3.0)

### Added

- feat(version): advise, gate and write the version bump, and refuse a push without one ([`320dd59`](https://github.com/JLRoper/agent-worktree-gui/commit/320dd59440b2f31c9a3067c03c892f8c841e0ee5))

### Other

- Refuse a commit subject that names no symptom, and prune branches by PR state (#13) ([`d853cdb`](https://github.com/JLRoper/agent-worktree-gui/commit/d853cdb65517e7c1141732524c3b40093021d3d3))
- Make the commit-msg hook executable in the index so a non-Windows clone runs it (#14) ([`4c3152c`](https://github.com/JLRoper/agent-worktree-gui/commit/4c3152ca969919e2601156d48357d286d5660af3))
- Give the assistant a charter file the panel injects every turn ([`41774c8`](https://github.com/JLRoper/agent-worktree-gui/commit/41774c877ecf2dd871f97b9fa6a82d6752f043b7))
- Add a Charter tab beside Scratchpad that reads and edits the file ([`785ef52`](https://github.com/JLRoper/agent-worktree-gui/commit/785ef5207d9fce4d627c54c095ff1501ce75155f))
- Prove the charter's seed, injection, writers and routes ([`095f3ca`](https://github.com/JLRoper/agent-worktree-gui/commit/095f3caf7443424d15e9ca35fe75a3f4c7e269cc))
- Leave the seeded charter room to keep taking entries ([`ea68fdf`](https://github.com/JLRoper/agent-worktree-gui/commit/ea68fdfeafaa23464db9ad257a496cfa6c58e466))
- Name a worktree once, and offer a name read from the work (#17) ([`ca5d252`](https://github.com/JLRoper/agent-worktree-gui/commit/ca5d252d807d69c17985ef995094c78a157ff4d7))
- Let the board bind every interface by default, so a LAN browser can reach it ([`881ef2e`](https://github.com/JLRoper/agent-worktree-gui/commit/881ef2ed935c9690a1df0f92e0ae59a8faac50fe))
- Show what each branch was started to do above its merge state (#20) ([`a93fefc`](https://github.com/JLRoper/agent-worktree-gui/commit/a93fefca7653cd23cd53ec5b7de44eb298988829))
- Hold worktrees whose last activity is older than N days out of the chart (#21) ([`ae82c3f`](https://github.com/JLRoper/agent-worktree-gui/commit/ae82c3fc48b8677be187699087b5bf4e70925a62))
- Keep the chart's show-all choice across a reload, not only in localStorage (#22) ([`8b401e3`](https://github.com/JLRoper/agent-worktree-gui/commit/8b401e305cf202f82cc9091f7b0a2f99d39db33d))
- Put the chart's age collapse under a browser proof, reload included (#23) ([`598de3a`](https://github.com/JLRoper/agent-worktree-gui/commit/598de3a13c6ac0e15c1ecd4eab986d692fef631e))
- Open the assistant float with a bare A, and pin it open against the press that dismisses ([`ae528c7`](https://github.com/JLRoper/agent-worktree-gui/commit/ae528c71df3c5692d5676de645ad9732e97b9145))
- Tell a run to ask in prose when the gateway build cannot deliver a clarify question ([`e0b2ee0`](https://github.com/JLRoper/agent-worktree-gui/commit/e0b2ee0930f0182c54f5ff7c00fe5a29f4588101))
- Re-attach a restored run the gateway still has instead of writing it off (#27) ([`25dd9d3`](https://github.com/JLRoper/agent-worktree-gui/commit/25dd9d3b47fbfd1d2c59f59a78b2be992c752cd8))
- Give an interrupted card whose run may still be live its own re-attach chip (#28) ([`154f8c4`](https://github.com/JLRoper/agent-worktree-gui/commit/154f8c474d7607e25d496cc5c1169efd3b5ac145))
- Pick a detached card up from the not-running pill, not a chip of its own (#29) ([`a095251`](https://github.com/JLRoper/agent-worktree-gui/commit/a095251b7c1bab81f26e6a482f25ff4f6f615d44))
- Stop the source calling the pill a NOT-RUNNABLE chip (#30) ([`6f5f0f8`](https://github.com/JLRoper/agent-worktree-gui/commit/6f5f0f8d2a08315c9d5ac63439fdc753ad10cd82))
- Find a row's PR by the tree's tag when the panel renamed its branch (#31) ([`01edc20`](https://github.com/JLRoper/agent-worktree-gui/commit/01edc208d8418a28bcf0c67acac5c75d3df0bf22))
- Stop a branch that only tracks main being given a fork's PR (#32) ([`e8c668f`](https://github.com/JLRoper/agent-worktree-gui/commit/e8c668f883edfcfe9d45ec59dca4522161a7135f))
- Refuse a reply into a worker that is already turning (#33) ([`12dac86`](https://github.com/JLRoper/agent-worktree-gui/commit/12dac864c953aa5e65e83447d106696d06cd12f4))
- Read the gateway's own clarify flag, and name the local patch as the fix ([`2b4d88f`](https://github.com/JLRoper/agent-worktree-gui/commit/2b4d88f7e782e84ed33a3c28424dfbbb08bc5d19))
- Move the board's pure format helpers out of app.js into core/dom-format.js ([`3fa9811`](https://github.com/JLRoper/agent-worktree-gui/commit/3fa981103d908fb560c3164ab0f1aa1aeb86b4f7))
- Move the attachment chips and their drop listeners out of app.js ([`7f577e7`](https://github.com/JLRoper/agent-worktree-gui/commit/7f577e760cf991b522c3e387cbe4a0242bc8102f))
- Move the NOT-RUNNING rotation out of app.js into board/hot.js ([`7afec91`](https://github.com/JLRoper/agent-worktree-gui/commit/7afec91bf83e3ffd8139ffb517c6c52af89190fd))
- Move the panel's HTTP calls and its token out of app.js ([`d6fcd08`](https://github.com/JLRoper/agent-worktree-gui/commit/d6fcd08f502dd855344ed6b76e6daed83d7e8ae7))
- Move the SSE stream and its thirteen handlers out of app.js ([`8df2b56`](https://github.com/JLRoper/agent-worktree-gui/commit/8df2b561f289ec6eab98c2f41b6475afe7cc82c1))
- Fold the second tool-result unwrapper into tool-text, and drop the dead dropRow ([`81946cb`](https://github.com/JLRoper/agent-worktree-gui/commit/81946cb31fbf3d2ceff15879968810852eaad341))
- Move the assistant's knobs, rule table and sanitisers into lib/assistant/config.js ([`80ac7d2`](https://github.com/JLRoper/agent-worktree-gui/commit/80ac7d22417e93c9eebc35110a1ac31e27aa14d5))
- Move reading a turn into lib/assistant/read.js ([`8334eef`](https://github.com/JLRoper/agent-worktree-gui/commit/8334eefcea1acd53110fd0060d13b9316b25dd26))
- Move the three judgements that turn prose into an alert into lib/assistant/match.js ([`d64d617`](https://github.com/JLRoper/agent-worktree-gui/commit/d64d617f2f35e0cc972c8a28a215c871d2cc4b54))
- Move the action-line grammar into lib/assistant/actions.js, written once ([`36e5245`](https://github.com/JLRoper/agent-worktree-gui/commit/36e524508ccf8968a2d1b2d7fdcce6b6125400a7))
- Move assistant.json's file IO into lib/assistant/store-file.js ([`f3bc509`](https://github.com/JLRoper/agent-worktree-gui/commit/f3bc509611cbec1c1696464a9a35ae23fb4bae13))
- End the new assistant modules on one CRLF, not a stray CR ([`50c6fda`](https://github.com/JLRoper/agent-worktree-gui/commit/50c6fdaf986621c734018e11a1e270336f20ec3e))
- Move the charter file's IO into lib/assistant/charter-file.js ([`e4733f4`](https://github.com/JLRoper/agent-worktree-gui/commit/e4733f4555dad600d2169201b671e231c8f14295))
- Stop the assistant's state() from pruning the wake list while it reads ([`5828f43`](https://github.com/JLRoper/agent-worktree-gui/commit/5828f439e9a450ffb30c4e2bb7c6327c65195f54))
- Put a model's price and coding rating beside it in the picker ([`21030ac`](https://github.com/JLRoper/agent-worktree-gui/commit/21030ac7220bf1d0e8bce6a30d631b1b94fc089a))
- Make the description strip a bullet list, folded on expand (#38) ([`a5628a8`](https://github.com/JLRoper/agent-worktree-gui/commit/a5628a80fa464f3dde0981963f50d4832d67da0a))
- Queue a reply on Ctrl+Enter, the same press the Queue reply button makes (#39) ([`61662e9`](https://github.com/JLRoper/agent-worktree-gui/commit/61662e9d8c34a265c5d3afac98cb0d160ba80c5c))
- Restore the merge state detail: every commit listed, file lists folded (#40) ([`4597bd0`](https://github.com/JLRoper/agent-worktree-gui/commit/4597bd0f1aad2e43af1e06d5fc3363ea9ae582e3))
- Swap the reply box's gestures: Ctrl+Enter steers, Enter holds the reply (#42) ([`f893497`](https://github.com/JLRoper/agent-worktree-gui/commit/f8934972c13b5ef0cb75c2acc2d21363cd8222f2))
- Draw a diff as a framed two-sided window and a file body as a folded code box (#43) ([`26aec76`](https://github.com/JLRoper/agent-worktree-gui/commit/26aec7645a865c4855feef6861bee70a019b1a5f))
- Let a queued reply be taken back with a × on its own entry ([`ab2b51f`](https://github.com/JLRoper/agent-worktree-gui/commit/ab2b51f32acd658c15f73d366cb859908740a7bf))
- Edit a held reply in place, and hold it while it is being edited ([`decbdbc`](https://github.com/JLRoper/agent-worktree-gui/commit/decbdbc456af221bd45ccd837bce64f2df334737))
- Let a reader lift a console or thinking block with a hover copy button ([`57ee79d`](https://github.com/JLRoper/agent-worktree-gui/commit/57ee79d2dafd2a0f3dd323b851e7cc0fb15bfe90))
- Collapse a big paste into one inline chip the reader can quote, unfold and delete ([`11552c7`](https://github.com/JLRoper/agent-worktree-gui/commit/11552c7c0b9ae2914920b454c6c10ef76c5dc4a3))
- Prove the paste chip in a real browser, and point the two key suites at its reader ([`d841d0d`](https://github.com/JLRoper/agent-worktree-gui/commit/d841d0dce86abe19d4473b79e86862d5132b43fe))
- Read the reply box through readBox where the queued-reply cancel needs its text ([`70cc7d0`](https://github.com/JLRoper/agent-worktree-gui/commit/70cc7d0b5345682c1c4148a9f634d7cc817a709a))
- Read the reply box through readBox in the held-reply editor's own suite ([`354b201`](https://github.com/JLRoper/agent-worktree-gui/commit/354b2011c5b78b303c2ba85d9fad63a2fef60739))
- Show COMPLETE on a finished card, and queue one ask instead of nudging it ([`2d1077d`](https://github.com/JLRoper/agent-worktree-gui/commit/2d1077d6d3d19148cd95ccc3c7a046c45a37f4ae))
- Find the pre-change build by content, not by HEAD~1 ([`d465542`](https://github.com/JLRoper/agent-worktree-gui/commit/d4655424d9dd3dddd3c29a708f8c3280634da8ba))
- Show the assistant's message board in a tab, so what it sent and got back is readable ([`5eca573`](https://github.com/JLRoper/agent-worktree-gui/commit/5eca5734e62083dfdcbbf6316721fb0da84f3208))
- Say where a tool result is cut, and what raises the cap ([`ec2d993`](https://github.com/JLRoper/agent-worktree-gui/commit/ec2d993894d1c37932e6287c22c73e4f08f319d7))
- Hold a 429 turn for a run slot instead of failing it ([`45d5317`](https://github.com/JLRoper/agent-worktree-gui/commit/45d53171e87e15e1dcfb0f1d9daee613095dd10f))
- Say "waiting for a slot" on a held turn instead of "FAILED" ([`de6dfb9`](https://github.com/JLRoper/agent-worktree-gui/commit/de6dfb990ffc85e364457c0e78bcfa48cc08faa2))
- Prove the 429 hold against a stand-in gateway and a real browser ([`1780d51`](https://github.com/JLRoper/agent-worktree-gui/commit/1780d512fe44dbd8ae19c9f4e01dae7c727ad4bd))
- Put a console diff's real lines in its frame, new side first, and let a call fold ([`bdff6db`](https://github.com/JLRoper/agent-worktree-gui/commit/bdff6db0a473cc64de4acf814dce35a22ba7724e))
- Give hermesHome its own module, so reading the config stops reaching into the run supervisor ([`5f051cd`](https://github.com/JLRoper/agent-worktree-gui/commit/5f051cdc8239fab9be711bacb1691fd341325e91))
- Move the HTTP layer out of server.js, and hand it the two things it read by closure ([`82b1e07`](https://github.com/JLRoper/agent-worktree-gui/commit/82b1e07a2617817bf0f5edf5e66278df9a239608))
- Ask the spawn question in one place instead of three, and stop deriving the owner path twice ([`fc4ff03`](https://github.com/JLRoper/agent-worktree-gui/commit/fc4ff0353aacb5eea764cf5680c68f4304801676))
- Move the description harvest out of server.js, and give it the two stores it walks ([`ca4dd7e`](https://github.com/JLRoper/agent-worktree-gui/commit/ca4dd7e1cc6d602886ac5f567e51eb1499631fa5))
- Lift the event-to-console translator into its own module, with the tree-measuring helpers it shares ([`d0c0d15`](https://github.com/JLRoper/agent-worktree-gui/commit/d0c0d15af0e24041acccea9686c7577864f0c585))
- Read the Hermes session store from the one home, not from a third copy of hermesHome ([`6525df3`](https://github.com/JLRoper/agent-worktree-gui/commit/6525df332fb179249204eced7372773e1df83003))
- Refuse an unborn-HEAD spawn through the assistant too, not only through the card ([`7a47a99`](https://github.com/JLRoper/agent-worktree-gui/commit/7a47a99696c86869b8ffedf612dbe3b49ba4c805))
- Rank rows, projects and agent cards by a sliding average of liveness events ([`304e429`](https://github.com/JLRoper/agent-worktree-gui/commit/304e4297c8b404105e905107c7b383e144d522a7))
- Keep a row's card ranking when its cards are momentarily gone ([`62cf9e0`](https://github.com/JLRoper/agent-worktree-gui/commit/62cf9e0ae49c36ccaaf93c6cdacfa880370d590d))
- chore(version): bump to 0.3.0, a new gate that breaks nothing ([`c60805d`](https://github.com/JLRoper/agent-worktree-gui/commit/c60805d9d8c6badf78dd6649839ec51859091ecd))

## v0.2.0 — 2026-10-23 · 341 commits

[`861652e`](https://github.com/JLRoper/agent-worktree-gui/commit/861652ed00589c5133500d902ab0ff75f195f034) · [compare v0.1.0...v0.2.0](https://github.com/JLRoper/agent-worktree-gui/compare/v0.1.0...v0.2.0)

### Other

- Fix the name: agent-wroktree-gui -> agent-worktree-gui ([`4331c3b`](https://github.com/JLRoper/agent-worktree-gui/commit/4331c3beaf46086f629f74a8158a38a3fccb7404))
- Add agent-executable setup: SETUP.md, setup.cmd / setup.sh ([`cd45a9c`](https://github.com/JLRoper/agent-worktree-gui/commit/cd45a9ca45f824eac541450b6d1d4bae438208cb))
- Skip configured projects that are not on this machine ([`fb49c2b`](https://github.com/JLRoper/agent-worktree-gui/commit/fb49c2be5792cbabc84f49187783b29a47fc646c))
- Spawn an agent into an existing worktree, and run a second instance ([`dd492eb`](https://github.com/JLRoper/agent-worktree-gui/commit/dd492eb3e68040a9126e672852cf38bf75fa71a0))
- Show the panel's own agents on the worktree rows, and jump from row to agent ([`7669563`](https://github.com/JLRoper/agent-worktree-gui/commit/7669563f6911dc7550537f431cc59c3b65738b7b))
- Share in-flight liveness probes and stop overlapping passes ([`1d2d99f`](https://github.com/JLRoper/agent-worktree-gui/commit/1d2d99f263086d441283d434b2fe4fdcb461cf17))
- Add a Docker front door and the plan for local containerisation ([`5af990e`](https://github.com/JLRoper/agent-worktree-gui/commit/5af990efb0f902b948720d1f71a62fa736b519b0))
- Add a hermes worktree-audit discovery engine, opt-in, plus /api/cleanup ([`7e93716`](https://github.com/JLRoper/agent-worktree-gui/commit/7e93716e470b2731a030687c2b2076a0d12e140c))
- Group projects in a folder accordion, with a sibling folder for strays ([`bfb4d66`](https://github.com/JLRoper/agent-worktree-gui/commit/bfb4d6606f9ef38de94e79e82f41f63dd6a8f650))
- Add docker/redeploy.cmd: restart the panel and recreate the front door ([`e5e0489`](https://github.com/JLRoper/agent-worktree-gui/commit/e5e0489cde47444f31d60d7bdbb3f09ae511c37d))
- Drop projects the server no longer reports, and count the live ones ([`6c0e135`](https://github.com/JLRoper/agent-worktree-gui/commit/6c0e135a0693204af57c472377b5bdd4bf261139))
- Folder header: collapse-all button and a clone box ([`96bdc09`](https://github.com/JLRoper/agent-worktree-gui/commit/96bdc095fcc0e6356967b3574566e48103c3d355))
- Serve agent approval prompts in the panel ([`c4df33c`](https://github.com/JLRoper/agent-worktree-gui/commit/c4df33cfd54b58d1141bc1d639c2d41a841a5334))
- Life column: time since we last saw this worktree alive, plus a ring to the next read ([`3ca0fd0`](https://github.com/JLRoper/agent-worktree-gui/commit/3ca0fd0cd88ea00852d0551d247be3572dd9f6dc))
- Make the next-read ring tell the truth, and give the scheduler room to keep it ([`103ded6`](https://github.com/JLRoper/agent-worktree-gui/commit/103ded6e6041063cea283d2c86eb20fc0f21efc2))
- Boot the board without fetching, and read projects in parallel ([`48ca193`](https://github.com/JLRoper/agent-worktree-gui/commit/48ca19337f5c695a4344597996a1b395bb7b787c))
- Count the boot pass as a read, and widen the coasting cadences to fit the pool ([`7d9b354`](https://github.com/JLRoper/agent-worktree-gui/commit/7d9b3540fc25e745cad3fde99200f4717ab2dbfd))
- Fold each agent turn to its request line, and make a running turn show up in the rows ([`3d6ebb8`](https://github.com/JLRoper/agent-worktree-gui/commit/3d6ebb8577c9f1a37fd9fdf7868e117b13728670))
- Give the page its own zoom, paint live/agent chips violet, and order rows by what is happening ([`06ab52b`](https://github.com/JLRoper/agent-worktree-gui/commit/06ab52b4f8ea2dc76edf38824d9fd24d4a508536))
- Front-end + scan efficiency: fewer git spawns, less DOM, gzip, and a quiet client ([`70f0803`](https://github.com/JLRoper/agent-worktree-gui/commit/70f080314b1ea81852efd73f4beabd44a4f492b8))
- Collapse the New agent and Agents cards from their title rows ([`ddcd433`](https://github.com/JLRoper/agent-worktree-gui/commit/ddcd4336330c52a2883bf1348965e7a515abddf7))
- Pull one chat out to fill the window, and stay on the newest output ([`fcac95f`](https://github.com/JLRoper/agent-worktree-gui/commit/fcac95f4d91c423a367371affc4b189a2ac56783))
- Place Hermes sessions by what they are working on, not where they started ([`f59c1a3`](https://github.com/JLRoper/agent-worktree-gui/commit/f59c1a39d5a713eedddd73da134ba055e12d9f1e))
- Clear one agent session from its card ([`405e962`](https://github.com/JLRoper/agent-worktree-gui/commit/405e962aab3e3a043ea54abcdeae886abec9a61a))
- Life and its next-read ring share one line ([`ba7ce34`](https://github.com/JLRoper/agent-worktree-gui/commit/ba7ce34c595a2a21800d9fef2bf15811b9c944e4))
- Sending a reply folds the turn you were reading ([`700a73e`](https://github.com/JLRoper/agent-worktree-gui/commit/700a73edecbdb851d2f7c72b09d12d51cd15c5ec))
- Unfold the card you just aimed at ([`466d7bb`](https://github.com/JLRoper/agent-worktree-gui/commit/466d7bb9d32baa34a5e08f86a50e1f879a9c0742))
- Agents belong to a worktree; the panel now says which ([`d49003f`](https://github.com/JLRoper/agent-worktree-gui/commit/d49003f7b0975b6b61669629b7c8c1af15c00ca2))
- Attach an unattached agent to a worktree, and colour the status words ([`e019ea9`](https://github.com/JLRoper/agent-worktree-gui/commit/e019ea94ca17d4ca1585a09ecb05b47c01c3c222))
- Attach where the agent already is, and only ask when that is not obvious ([`aa77a56`](https://github.com/JLRoper/agent-worktree-gui/commit/aa77a56d96f9be910420e76f239df39866e5304d))
- Mark every agent row with the panel's ⧉ glyph ([`ce668e0`](https://github.com/JLRoper/agent-worktree-gui/commit/ce668e06a2a1e21e1deb3fd8f06d54714f246620))
- Keep the reader's place while an agent is running ([`ead2909`](https://github.com/JLRoper/agent-worktree-gui/commit/ead290943e5af178d3bc500c75607dceebcda872))
- Paint the project's panel-agent chip violet, with the ⧉ mark ([`ef73237`](https://github.com/JLRoper/agent-worktree-gui/commit/ef73237746dd053b5b12f31f84096bab00259294))
- Project panel-agent chip: violet while working, amber when everything is idle ([`00bf525`](https://github.com/JLRoper/agent-worktree-gui/commit/00bf5254a66ce16ac5409bc5d1b7d2055859a103))
- Stop losing live sessions that never write last_activity_at ([`57571fa`](https://github.com/JLRoper/agent-worktree-gui/commit/57571fa5bcfd47120a44c5a64631b017efa6a082))
- Collapse all: one button for the whole board, left of Pause ([`c86ee6d`](https://github.com/JLRoper/agent-worktree-gui/commit/c86ee6d1a8c213ee19fe96296d7182f9f2f4190f))
- Each folder can show all its projects, or only the ones touched this week ([`44e3fd9`](https://github.com/JLRoper/agent-worktree-gui/commit/44e3fd9de778c89cb2840d5059a79d954cd8f595))
- Collapse all folds the folders too, and moves left of Refresh now ([`4bf96c5`](https://github.com/JLRoper/agent-worktree-gui/commit/4bf96c5623bb62a565a546d08ba3406576a7a4a9))
- Rank projects by what is happening, and only freeze the folder being read ([`02e8ed5`](https://github.com/JLRoper/agent-worktree-gui/commit/02e8ed5c779844ef866537ad4ab82e4da741846f))
- Attach agents the moment they exist, and stop losing ownership on restart ([`00c7a71`](https://github.com/JLRoper/agent-worktree-gui/commit/00c7a71ed1cc12763b1f2600474b0a0f3366754e))
- Fold a worktree's git/commit/diff detail into one accordion line ([`ff3407d`](https://github.com/JLRoper/agent-worktree-gui/commit/ff3407d788396297bd7b632a0cec5b3c672ee9cb))
- Stop the board flashing "no git repos found" for the first minute after a start ([`ac93a50`](https://github.com/JLRoper/agent-worktree-gui/commit/ac93a5000fd8026c3445b1a856e985ddf1a1a671))
- No control inside an agent's head row may fold the card ([`2b70a87`](https://github.com/JLRoper/agent-worktree-gui/commit/2b70a8781d49e2446fc875c18f7185717862c7ca))
- Attach unfolds a minimized card before showing its picker ([`677fc0e`](https://github.com/JLRoper/agent-worktree-gui/commit/677fc0e0a1c4f83e7359e216895f12743db800f7))
- Settings: let the panel wear a different interface font ([`a76a40b`](https://github.com/JLRoper/agent-worktree-gui/commit/a76a40ba70440fde8534b32651ed91267aa7e9fc))
- Two font settings: the panel's text and the terminal's text ([`413b6c8`](https://github.com/JLRoper/agent-worktree-gui/commit/413b6c8ec3dab0714bdd80754fd703a055736f60))
- Settings is reachable three ways: gear, Ctrl+, and the title ([`d41975f`](https://github.com/JLRoper/agent-worktree-gui/commit/d41975f701a146cdd074ee4f16fddbafdb783daa))
- Spawn takes you to the agent: unfold its folder, project and row, then scroll to it ([`2e55532`](https://github.com/JLRoper/agent-worktree-gui/commit/2e55532bc6b17df1da426dbf4a6cf3118fb53ff6))
- Page a conversation's turns five at a time ([`4098172`](https://github.com/JLRoper/agent-worktree-gui/commit/4098172e64fc8c81fd2b79f5e83c8b8a83bf8e94))
- Star a turn to keep it above the paged turns ([`6e418ed`](https://github.com/JLRoper/agent-worktree-gui/commit/6e418edac75550f17218dd3816f5f111ab94a2a9))
- Fold the liveness evidence, keeping its strongest line in view ([`3b9d297`](https://github.com/JLRoper/agent-worktree-gui/commit/3b9d297062182e203f70f6dc1f8c62c18ac0eaf8))
- Make the pin star half again as big ([`79212bf`](https://github.com/JLRoper/agent-worktree-gui/commit/79212bf20f2a919c9d2707a1b28d44e12e4dcd7d))
- Tab the expanded git and liveness detail under their headers ([`0b9fab7`](https://github.com/JLRoper/agent-worktree-gui/commit/0b9fab7ed8112c9b4b50e8568effa3b64ec31969))
- Keep the pin star under the pointer when a turn is pinned ([`79ce8c1`](https://github.com/JLRoper/agent-worktree-gui/commit/79ce8c19e9dac70b05ebaa4ecf1b7ea433819994))
- Put Send reply inside the reply box, bottom left ([`72b2edc`](https://github.com/JLRoper/agent-worktree-gui/commit/72b2edcf273bd04a6abd66bcf43a88c3addbe785))
- Lift Send reply off the input's bottom border ([`c2b3c69`](https://github.com/JLRoper/agent-worktree-gui/commit/c2b3c6964359bc5d9a26196221deee4ade9b36c2))
- Rename a session from its row ([`ba676a0`](https://github.com/JLRoper/agent-worktree-gui/commit/ba676a0023fee71bcb7a7a623ad64dd6353b5737))
- Double every accordion chevron ([`03e9dc7`](https://github.com/JLRoper/agent-worktree-gui/commit/03e9dc76f3e7da931ad64d4ee36ba2d59fcb7f20))
- Give the merge-state accordion a heading of its own ([`c9018b1`](https://github.com/JLRoper/agent-worktree-gui/commit/c9018b189ac6a86257c61ac1a2823a086c3370d6))
- Flash what moved when the board reorders itself ([`58e44dd`](https://github.com/JLRoper/agent-worktree-gui/commit/58e44dd3a45ff834863b789d756f94569d3ab44e))
- Re-rank the folders in real time, and check them every 5s when they are closed ([`61be090`](https://github.com/JLRoper/agent-worktree-gui/commit/61be09079aca8b4b6a772a3b603ec63538e92689))
- Stop the periodic row repaint from wiping a reply being typed ([`0f7ffaf`](https://github.com/JLRoper/agent-worktree-gui/commit/0f7ffaf4f78a20cf62343b450d26451e813522a1))
- Flash rows and projects that move during a rebuild, not just an in-place sort ([`2bf7ce4`](https://github.com/JLRoper/agent-worktree-gui/commit/2bf7ce4418f1c7bad9748c4afadd4552188c66a4))
- Keep an open console's scroll when its project is folded and unfolded ([`3b0e4f3`](https://github.com/JLRoper/agent-worktree-gui/commit/3b0e4f36463b117a42850daef480cee3e892c059))
- Make the project flash visible: light the title row too ([`efb72b5`](https://github.com/JLRoper/agent-worktree-gui/commit/efb72b55e7cbf1e47e2a556aa4fdbe047feca2a2))
- Freeze only the open projects, not the whole folder ([`b458e5b`](https://github.com/JLRoper/agent-worktree-gui/commit/b458e5b219795add514ae7ed5c8723f67e0acee4))
- Flash only what moves up, not what gets pushed down ([`d5d1927`](https://github.com/JLRoper/agent-worktree-gui/commit/d5d192753c657c0bbb2ce1dac11a7aaf62fc3a0b))
- Fill the next-read ring instead of draining it, and make it a one-row refresh ([`ff98366`](https://github.com/JLRoper/agent-worktree-gui/commit/ff983664c6780412581d49b2f459c8d342581b0e))
- Tell password managers to leave the panel's inputs alone ([`b05458f`](https://github.com/JLRoper/agent-worktree-gui/commit/b05458f764a0ccabcd90d92df0e995bae1b69c5d))
- Put the expand/exit control to the right of the rename button ([`5ac6264`](https://github.com/JLRoper/agent-worktree-gui/commit/5ac626498fe044871561392b562c8a442ba97645))
- Keep the caret in the reply box after sending ([`22b51e2`](https://github.com/JLRoper/agent-worktree-gui/commit/22b51e27aa5151d4f9cd4d63e5a865ac3d01e7df))
- Enter in the New agent prompt spawns ([`35863ef`](https://github.com/JLRoper/agent-worktree-gui/commit/35863efa675139638814e444b4a219d1c883d20d))
- Shift+Enter inserts a newline in the message boxes ([`fff7a3c`](https://github.com/JLRoper/agent-worktree-gui/commit/fff7a3c39600e3fe4f69b0be44ae755dc8e5ef37))
- Make Collapse all fold the New agent and Unattached agents cards ([`8393e64`](https://github.com/JLRoper/agent-worktree-gui/commit/8393e6409f2619a7dd3c8816980971b35039561b))
- Hold the row you clicked still while its accordion opens ([`ac0c994`](https://github.com/JLRoper/agent-worktree-gui/commit/ac0c994c98be39b7d6618307412b17a2776faf8e))
- Let a pinned turn open and close on its own ([`f3809ba`](https://github.com/JLRoper/agent-worktree-gui/commit/f3809ba4646315fd1b702352cab48e657b402525))
- Make URLs in agent output clickable, opened by the panel ([`79f1290`](https://github.com/JLRoper/agent-worktree-gui/commit/79f12901abf293ae6688543889db857b41f5bb31))
- Show what each tool actually did in the agent console ([`89504c6`](https://github.com/JLRoper/agent-worktree-gui/commit/89504c6527432bbbb58b96c18b070f655d48e91a))
- Up/Down in a reply box walk the thread's previous prompts ([`328ed8a`](https://github.com/JLRoper/agent-worktree-gui/commit/328ed8aca403e2c1fab2172645994c70621b5be4))
- Make ✕ the rightmost of the agent row's controls ([`a7968de`](https://github.com/JLRoper/agent-worktree-gui/commit/a7968deb7f992632aeb8770809c5aff940e60477))
- Move Cancel turn into the reply box, right of Send reply ([`0955faf`](https://github.com/JLRoper/agent-worktree-gui/commit/0955fafb752e8338d11ea0f370a6258ac97c54b6))
- Stop the pin star flickering while a turn runs ([`e786f2f`](https://github.com/JLRoper/agent-worktree-gui/commit/e786f2fad6e844af029b7285ae502474a3e8549f))
- Queue a reply while a turn is still running ([`572ebb1`](https://github.com/JLRoper/agent-worktree-gui/commit/572ebb11c8b0eff65f01186f70d9895f4b3f5e00))
- Enter queues while a turn runs, and queued replies say what and how long ([`1840e20`](https://github.com/JLRoper/agent-worktree-gui/commit/1840e20d41ab08ac4e2e3168428754ad173a9ffd))
- Draw queued replies as ghost turns, and show which build is running ([`af92118`](https://github.com/JLRoper/agent-worktree-gui/commit/af92118ace738cbeac870a59375769d4be8b0220))
- Record what the Runs API actually does, probed against a live gateway ([`7eba1fd`](https://github.com/JLRoper/agent-worktree-gui/commit/7eba1fd65005431fe0ad44eb3384cafd8c72a116))
- Run agents through the gateway's Runs API, and let a reply steer the live turn ([`65cc079`](https://github.com/JLRoper/agent-worktree-gui/commit/65cc079f5dc8da26f5c72cf4a716cca570cc1d38))
- Answer a run's approval from its card ([`74a095e`](https://github.com/JLRoper/agent-worktree-gui/commit/74a095edb5e82a405ef98da704613f604fb1934c))
- Put the approval prompt under the turn's own output, and collapse it once answered ([`f13049e`](https://github.com/JLRoper/agent-worktree-gui/commit/f13049e941de1eee3ac39e130f1701f8452cbd9b))
- Make steering the primary reply action while a turn runs ([`ade06bd`](https://github.com/JLRoper/agent-worktree-gui/commit/ade06bd806b7b798b1b4f253e2e192cb8670aebc))
- Make the run's approval reach the card, and stop dropping a late steer ([`0705e5f`](https://github.com/JLRoper/agent-worktree-gui/commit/0705e5f2fdb0dbcdd9ebe0646d23bb6e5d5d6222))
- Mark the approval-transport doc superseded, with the exact retirement commands ([`cc54f34`](https://github.com/JLRoper/agent-worktree-gui/commit/cc54f340e8925c7f4eb5e444e458d9952aa6a005))
- Drop the embedded repo accidentally staged with the doc commit ([`9139624`](https://github.com/JLRoper/agent-worktree-gui/commit/91396249bd995db59f6e90db0e3dd83409e91830))
- Record the gated-first-call cwd defect with its reproduction ([`5e791ac`](https://github.com/JLRoper/agent-worktree-gui/commit/5e791ac9a4c419507ca6079b6bd0423ec975df75))
- Set the run's cwd for the agent's context too, not just for its tools ([`065a3b0`](https://github.com/JLRoper/agent-worktree-gui/commit/065a3b0f268de14068b0bcb912b5984633e9218d))
- Describe the runs transport in the docs, and stop advertising knobs it cannot honour ([`f95a0b3`](https://github.com/JLRoper/agent-worktree-gui/commit/f95a0b3fa9488aa37dc12915cfa955d8ca50875c))
- Walk the New-agent prompt history with Up/Down, and clear it once it spawns ([`f84c904`](https://github.com/JLRoper/agent-worktree-gui/commit/f84c9048390589b89a81a0f7d70e9519892c8c0b))
- Let the prompt line fold a turn as well as unfold it ([`8f1e16a`](https://github.com/JLRoper/agent-worktree-gui/commit/8f1e16aca87047f19b41cb4122e1ef09ef546bc6))
- Show an approval the moment it is asked, not 20 seconds later ([`02712b4`](https://github.com/JLRoper/agent-worktree-gui/commit/02712b4da65d98291187179462f165c60958738f))
- Put a live clock on the tool call that is still running ([`1eb139b`](https://github.com/JLRoper/agent-worktree-gui/commit/1eb139b437a9d43f664d7a6aac3ac859100f48f5))
- Stop printing "exit 0" for something that never exited ([`1b3bb62`](https://github.com/JLRoper/agent-worktree-gui/commit/1b3bb62edd3a938ac9ea8b977b1c043dcfaea8a7))
- List the files an agent produced, with a button that opens or copies them ([`fe28aae`](https://github.com/JLRoper/agent-worktree-gui/commit/fe28aae02a54f031df79d8f2619fab87b3f0288f))
- Land on the agent a spawn just created, caret in its reply box ([`74b3eba`](https://github.com/JLRoper/agent-worktree-gui/commit/74b3eba3d8ef4907775fef570d0f8859d5a33ed8))
- Draw a tool result as text, and say when the gateway cut it ([`f71cbf7`](https://github.com/JLRoper/agent-worktree-gui/commit/f71cbf7ab2656329f7bcfe63317d3a0062dab7de))
- Drop an approval box once its turn is over ([`be74b46`](https://github.com/JLRoper/agent-worktree-gui/commit/be74b465f519e707b5a7ed4ba0f8c03bb671f80f))
- Stop the background sweeps from making the panel feel hung ([`e7235e5`](https://github.com/JLRoper/agent-worktree-gui/commit/e7235e58d0d0175926948ad7f1c0c9a0d1c7eae6))
- Make the deliverables list say what it is: name, copy, delete — files and URLs together ([`ff919b0`](https://github.com/JLRoper/agent-worktree-gui/commit/ff919b0a36cb04f7350ca0b1e5c1a4af0c161947))
- Let a worktree be removed from its row, with the files recoverable ([`743b072`](https://github.com/JLRoper/agent-worktree-gui/commit/743b072120e0dc16125c3dc74bed9d30a491091e))
- Keep a parked approval visible when its worktree row is collapsed ([`cc8df62`](https://github.com/JLRoper/agent-worktree-gui/commit/cc8df621ccf0ba588d6b1e3d86ab0c1436c401a5))
- Make the gateway's approval window a setting in the panel ([`ff25387`](https://github.com/JLRoper/agent-worktree-gui/commit/ff25387dddf49bafd97633d1d08d096a68126497))
- Let a row bring back a session the board has no card for ([`3ee4ca2`](https://github.com/JLRoper/agent-worktree-gui/commit/3ee4ca293dda5afdf7a1120012e8778c86563227))
- Draw the turn's usage above the reply box ([`622c5d2`](https://github.com/JLRoper/agent-worktree-gui/commit/622c5d28c404c821c1251fca8313c93f00c472b1))
- Pick the run's model from the gateway's own list ([`58a240e`](https://github.com/JLRoper/agent-worktree-gui/commit/58a240ec236cce0ae79f1bb7851867cede1aef53))
- Make the CLI's session-list length a setting, and say what the store really holds ([`3297e77`](https://github.com/JLRoper/agent-worktree-gui/commit/3297e77c27a0606a6657907f4ed7d29dbc203917))
- Put the usage strip on the footer line, to the right of the outcome ([`0410cd6`](https://github.com/JLRoper/agent-worktree-gui/commit/0410cd65a2471228bfbda3a533560da4ca45a708))
- Say plainly when a settings save was rejected, and keep what was typed ([`aae6870`](https://github.com/JLRoper/agent-worktree-gui/commit/aae687023c89b7833f7508c69062b845b91c0bb0))
- Only adopt the files a turn could have written ([`91def43`](https://github.com/JLRoper/agent-worktree-gui/commit/91def43b6875616cc9da217f92c953e28b38321e))
- Call a failed turn EXITED on its pill, and keep NOT-RUNNING for the rest ([`823efc4`](https://github.com/JLRoper/agent-worktree-gui/commit/823efc4cede8c8f872d2a1ddb78fd6a0b9b3ed1f))
- Scroll the New-agent card clear of the sticky top bar ([`3be1f24`](https://github.com/JLRoper/agent-worktree-gui/commit/3be1f2450ebcfc58b03bad5b8b56bfcc877f8598))
- Lead each tool call with its emoji, the way the CLI prints one ([`ffe592c`](https://github.com/JLRoper/agent-worktree-gui/commit/ffe592cd7ca45d32e72b51605e921f1bc7e352e1))
- Give every panel request a deadline, and recover a spawn whose reply was lost ([`44bf9f4`](https://github.com/JLRoper/agent-worktree-gui/commit/44bf9f42a81cd723dca4aea46485890dee9924b9))
- Read the usage strip out of the store, so it stops being empty ([`9ef8709`](https://github.com/JLRoper/agent-worktree-gui/commit/9ef8709d8f3e7526905423fa55ce87dd81d61395))
- Draw the context meter with a partial block instead of a dotted hatch ([`bb368b9`](https://github.com/JLRoper/agent-worktree-gui/commit/bb368b96a2d2ae8a5a484169e77b07186deb76e1))
- Bind Ctrl+[ and Ctrl+] to collapse and expand the whole board ([`1e6eb8a`](https://github.com/JLRoper/agent-worktree-gui/commit/1e6eb8ae08c32d38a1917f76d3beb2c0a02c6f2b))
- Show the compaction count on the usage strip ([`d0848b3`](https://github.com/JLRoper/agent-worktree-gui/commit/d0848b3e57f5ae3ad8bdf2c0872f440c5aed1fb5))
- Paste or drop a document into a prompt and hand the agent its path ([`d3af9cd`](https://github.com/JLRoper/agent-worktree-gui/commit/d3af9cdd94a990a559dadbc0a32777bad2d1cd28))
- Lead a session row with its revive button, in the status column ([`3def20f`](https://github.com/JLRoper/agent-worktree-gui/commit/3def20fd680251f0b46a3b37ac62d9ab63fad523))
- Make the console resizable, and show pasted documents as chips ([`3f01a0a`](https://github.com/JLRoper/agent-worktree-gui/commit/3f01a0aa32480cc14af61f9eba4838841f2d6995))
- Drop the sessions heading, and put the last-used time beside revive ([`56298a3`](https://github.com/JLRoper/agent-worktree-gui/commit/56298a3de792b60b15578edffc9dd13f7c3d7a4c))
- Flash grey when a refresh finds nothing, and sort closed rows around an open one ([`c493d1f`](https://github.com/JLRoper/agent-worktree-gui/commit/c493d1f415189ada67a2cd63fa60bcf107dfc410))
- Collapse all the way down to the turns ([`52c31b9`](https://github.com/JLRoper/agent-worktree-gui/commit/52c31b9a4d5b77515a1b06596d1478bd2b464599))
- Link attachments to their file, and list them with the turn they went to ([`337edb5`](https://github.com/JLRoper/agent-worktree-gui/commit/337edb566568110923599929417a991c17dbf9da))
- Make a revivable session row look like an agent head, one level down ([`72c3bd5`](https://github.com/JLRoper/agent-worktree-gui/commit/72c3bd5b6bcea0325f69d5e10f4f1ebf80046d8b))
- Stop a bookkeeping total from counting as an agent moving ([`e6447ab`](https://github.com/JLRoper/agent-worktree-gui/commit/e6447ab9494e1f4505d525ce71399119688d1b48))
- Offer the one-click fix when a spawn refuses an unborn HEAD ([`39a1165`](https://github.com/JLRoper/agent-worktree-gui/commit/39a1165b444f2eca10d94d7c4cd9e24182524b04))
- Delete a worktree's row even when its folder is already gone ([`0b35ca2`](https://github.com/JLRoper/agent-worktree-gui/commit/0b35ca2ad2937c9b85bfd5474d9eeddbd795f3ca))
- Make a fire-and-forget delete look like it registered, and wait for the scan ([`9bb542f`](https://github.com/JLRoper/agent-worktree-gui/commit/9bb542fa22499079d2f38d466d3bb30d53e587cc))
- Stop the main row pulsing for work that happened in a worktree below it ([`dc73041`](https://github.com/JLRoper/agent-worktree-gui/commit/dc73041540f93ec6ff73e8604ca6062a7e9a98e4))
- Scroll to the spawn card when the play button is clicked, not back to the row ([`aa5b97a`](https://github.com/JLRoper/agent-worktree-gui/commit/aa5b97a84d705618a7ffba067d8687f40d3036e2))
- Hold an open project's place through a rebuild, and its folder's place too ([`df75c1a`](https://github.com/JLRoper/agent-worktree-gui/commit/df75c1ab79750c779dbf5554faaeaa4f082f7dc5))
- Give a running turn the same stats strip as a settled one ([`4b7730a`](https://github.com/JLRoper/agent-worktree-gui/commit/4b7730a2d8353c56b7cf2d85456dce77e83656d2))
- Put a revivable session's last-used time next to its revive button ([`1acc4b1`](https://github.com/JLRoper/agent-worktree-gui/commit/1acc4b199541baf3661b658cf5c38e37879d657a))
- Make the board's reorder cadence a setting ([`c1fb31e`](https://github.com/JLRoper/agent-worktree-gui/commit/c1fb31eb3e5bba69038a17b43a89e3faf24e4232))
- Offer the one-click first commit where the reader is actually blocked ([`2069658`](https://github.com/JLRoper/agent-worktree-gui/commit/2069658d66e9798b29d33b85fbf9d7ddb4afb44b))
- Make the project's panel-agent chip violet in both states ([`afc45ca`](https://github.com/JLRoper/agent-worktree-gui/commit/afc45caa8a6cdc09d608e66ca689b00ff66bc9fe))
- Make the panel-agent chip a lighter purple than the live chip ([`ec1e676`](https://github.com/JLRoper/agent-worktree-gui/commit/ec1e676ad5902b7444366f58a822def0a59d7cfe))
- Give the purple chips one job each ([`3bbce77`](https://github.com/JLRoper/agent-worktree-gui/commit/3bbce77950f8be13dfca89b6c6066c02fa676710))
- Make a minimized turn two lines: the request, then what it is doing or concluded ([`15408cd`](https://github.com/JLRoper/agent-worktree-gui/commit/15408cdc0d17e75c9ca74a24e414506f594a6ffc))
- Say "hermes" on the row chip, and explain it in the tooltip ([`d08fc98`](https://github.com/JLRoper/agent-worktree-gui/commit/d08fc9836836a74b48c045470bee9c04d40bd203))
- Give the project's panel chip the running count the row badge has ([`14088ea`](https://github.com/JLRoper/agent-worktree-gui/commit/14088ea62d6f7dc674e968ee4eec1f0c3e368352))
- Split the project's agent counts: light panels, dark hermes ([`897ff7d`](https://github.com/JLRoper/agent-worktree-gui/commit/897ff7d62617305ac9dc039e156e74ac48fcc2c9))
- Let the panels chip jump to the agent that is running ([`e8bc948`](https://github.com/JLRoper/agent-worktree-gui/commit/e8bc9488476cd79769885534eb6e5bf6f253b32f))
- Only exclude sessions the panel actually ran from hermes evidence ([`93dc160`](https://github.com/JLRoper/agent-worktree-gui/commit/93dc160e8c761685d84096e2539144b35769a0fc))
- List the external sessions' titles under the hermes chip's tooltip ([`90fda48`](https://github.com/JLRoper/agent-worktree-gui/commit/90fda48dfdce268015280f56229af5d248729528))
- Make the quiet panel chip a link too, to the project's top agent ([`e232363`](https://github.com/JLRoper/agent-worktree-gui/commit/e232363db61ff498d7c14ded232987fde38098c9))
- Put the agents above the merge state and liveness evidence in a worktree's detail ([`b3c3b75`](https://github.com/JLRoper/agent-worktree-gui/commit/b3c3b75dbb3590be55577db14b37f28d06c63794))
- Give the board a tree rail so a worktree row reads as a child of its project ([`4afc4fe`](https://github.com/JLRoper/agent-worktree-gui/commit/4afc4fec2b517cc1c825020cdd4d859c4f65cdf9))
- Keep the run's bookkeeping out of the console ([`4ee65d6`](https://github.com/JLRoper/agent-worktree-gui/commit/4ee65d64d051f93e1e101e29bf5c161cbdb5ca67))
- Let a minimized agent card be expanded by clicking anywhere on it ([`aa4586e`](https://github.com/JLRoper/agent-worktree-gui/commit/aa4586ed97e3526f3ff15a3866326c2d3907da3e))
- Close the last agent card with a line instead of letting it fade out ([`d8aa3c6`](https://github.com/JLRoper/agent-worktree-gui/commit/d8aa3c63609b76614b9e44050dd89ab09d3778e7))
- Move the agents section rule below the list instead of above it ([`c3e7e4e`](https://github.com/JLRoper/agent-worktree-gui/commit/c3e7e4e9433774a869b5946b518521d0dc79b6c3))
- Stop rows reordering when a refresh found nothing ([`6a16ec1`](https://github.com/JLRoper/agent-worktree-gui/commit/6a16ec1422ebd4f4c919f44521a875d47cbcddef))
- Drop the "Agents n" heading and pull the cards up under their row ([`c13954a`](https://github.com/JLRoper/agent-worktree-gui/commit/c13954ab5a742c6ed627d4f1754ca6676b2fc24a))
- Show a card's session name instead of its cwd, and move the run id to the end ([`e83fce2`](https://github.com/JLRoper/agent-worktree-gui/commit/e83fce2ff5d6b86e33069fb7c5e217e687116660))
- Put the usage readout under the reply box, not above it ([`1b837f2`](https://github.com/JLRoper/agent-worktree-gui/commit/1b837f2f91589c62de8c7dae9435c8eaea52a398))
- Set the card's session name like the revive row: bold, with its age beside it ([`5f54622`](https://github.com/JLRoper/agent-worktree-gui/commit/5f5462288353f8fc35fd17418be821f04483ec73))
- Move the New agent explanations into their tooltips ([`7b25988`](https://github.com/JLRoper/agent-worktree-gui/commit/7b259889045694a7bb75157d68c0166261092a91))
- Remove the Preview request button and its command box from New agent ([`11b42cf`](https://github.com/JLRoper/agent-worktree-gui/commit/11b42cf8e5f44a6edad5d650b6555569ebea2c4d))
- Collapse the empty message lines at the bottom of New agent ([`0ea471f`](https://github.com/JLRoper/agent-worktree-gui/commit/0ea471fa963ec2856616cb13131a702ad91966ed))
- Make a worktree row give up its name and branch, and nothing else ([`6cf4684`](https://github.com/JLRoper/agent-worktree-gui/commit/6cf4684bc12f3f5b334d15212f9356ec7c0c06c8))
- Invert the spawn form's worktree switch: "create workspace", ticked by default ([`e733f2e`](https://github.com/JLRoper/agent-worktree-gui/commit/e733f2e9a6610e7b55e926bf1334f7a963c64685))
- Drop the duplicate running clock, and put the usage strip under the box with the model first ([`0747c26`](https://github.com/JLRoper/agent-worktree-gui/commit/0747c26407ff82836c92c6e550072e05475e693c))
- Give the console its own size and weight, and stop styling what the human typed with them ([`8f85c6c`](https://github.com/JLRoper/agent-worktree-gui/commit/8f85c6ca0c42f018d351295fbe8f9cc84bf218e5))
- Put Cancel before Delete in the destructive confirmations ([`8ff2455`](https://github.com/JLRoper/agent-worktree-gui/commit/8ff245561850ac3c76a6608d424afa49ff8e4dcb))
- Make the worktree table fit its card, so the revive row's session id is not cut off ([`89ea122`](https://github.com/JLRoper/agent-worktree-gui/commit/89ea122aad5ec881646c4f98041da3b311613e0f))
- Close the gap under the reply box and the usage strip ([`b571661`](https://github.com/JLRoper/agent-worktree-gui/commit/b57166103a2d34cd423b1e7e0a08f015672eb5c3))
- Hang the turns off a rail under the card's title ([`4b4a303`](https://github.com/JLRoper/agent-worktree-gui/commit/4b4a3039185bcef29038d5f6cce368d3eee3925b))
- Put half the space back under the usage strip ([`fa5bd22`](https://github.com/JLRoper/agent-worktree-gui/commit/fa5bd22ceeefd9392de187c586fb11349899fe73))
- Lead the worktree block with merge state and liveness again, folded to two strips ([`5e68d09`](https://github.com/JLRoper/agent-worktree-gui/commit/5e68d0913c36d0873e680f2efb48fa6094b56741))
- Use a double-down arrow for the compaction count ([`71f13cb`](https://github.com/JLRoper/agent-worktree-gui/commit/71f13cb9b4308188f0f83b72f8a35d979a86e6b1))
- Give merge state a real list, and drop the summary into it when it opens ([`ca231b8`](https://github.com/JLRoper/agent-worktree-gui/commit/ca231b8d412257808dc7943be4b05dfe1ecd4b5f))
- Offer a retry only where retrying is honest ([`5f747c0`](https://github.com/JLRoper/agent-worktree-gui/commit/5f747c032d0babe3f7e4c34554d76b0efe6d0472))
- Add a Grey flash switch to Settings ([`ebff2df`](https://github.com/JLRoper/agent-worktree-gui/commit/ebff2dfb613f02a3ad8a32137328f8c6a6430ed1))
- Ctrl+wheel over a console resizes its text, like a terminal ([`6cef648`](https://github.com/JLRoper/agent-worktree-gui/commit/6cef648a57009619256fd622e2e0f7c71b901f5b))
- Keep the delete confirmation's buttons inside the card ([`38fc2f0`](https://github.com/JLRoper/agent-worktree-gui/commit/38fc2f0eeb8d053ab07314f89ee94d812dd5e953))
- Block the page zoom while Ctrl+wheel is resizing a console ([`d178362`](https://github.com/JLRoper/agent-worktree-gui/commit/d178362ffd38654a803bf572927a71a1b2bee047))
- Add Hot Agent: a rotation through the agents waiting on you ([`a26759a`](https://github.com/JLRoper/agent-worktree-gui/commit/a26759a29043535a271adb856358e075432dc80b))
- Flash the whole hot card amber, not just its reply box ([`ae2d2da`](https://github.com/JLRoper/agent-worktree-gui/commit/ae2d2da5f371bf4e0af7fa2c12141b16a20f9829))
- Keep the turn's request on its title line when the turn is open ([`7f046d6`](https://github.com/JLRoper/agent-worktree-gui/commit/7f046d680d8ba6d301767a7ef0d9dd1ff1cadb88))
- Drop the open-idle chip, and make the hermes chip read like the panel one ([`a9c3593`](https://github.com/JLRoper/agent-worktree-gui/commit/a9c3593ada9e78104d2e0c556f1829be3aefc5b1))
- Move the page-zoom control from the top bar into Settings ([`c491fdd`](https://github.com/JLRoper/agent-worktree-gui/commit/c491fdd35f6ce68eebc925523d73794fc61a4f22))
- Put Spawn agent on the left of its row, and the project picker beside "start in" ([`d4c1162`](https://github.com/JLRoper/agent-worktree-gui/commit/d4c1162e0aba8e26d4b4d4764d4fecb7e0b89729))
- Make Hot Agent open the path it needs after Collapse all ([`d9c7261`](https://github.com/JLRoper/agent-worktree-gui/commit/d9c7261bfa9723f1ecc9d59d66b12b888bfd6146))
- Answer a revive 409 by showing the card that already exists ([`a266d7a`](https://github.com/JLRoper/agent-worktree-gui/commit/a266d7add12357041daefd3617400440b51f731b))
- Translate the gateway's 409 permission_denied into advice ([`88e5039`](https://github.com/JLRoper/agent-worktree-gui/commit/88e5039dbbbbd0989c08c2b68425bb788f1cf268))
- Add a Panel contrast slider to Settings ([`c7c7149`](https://github.com/JLRoper/agent-worktree-gui/commit/c7c7149d7e875e837a4568543a2f1333b859acd1))
- Show a run's subagents under its card ([`e9fe376`](https://github.com/JLRoper/agent-worktree-gui/commit/e9fe376b569aa2acb4f0741e9954cd1ded905718))
- Give the session panel its own layer in the contrast scale ([`4a7ebf1`](https://github.com/JLRoper/agent-worktree-gui/commit/4a7ebf15931de63abe3f81161d5b43f8e048e650))
- Report subagent status from the store, because the stream cannot ([`38efb61`](https://github.com/JLRoper/agent-worktree-gui/commit/38efb61c87a7551e9f21355cc3582dacc21727e3))
- Put the subagent strip under the console of the turn that spawned them ([`b1d58d2`](https://github.com/JLRoper/agent-worktree-gui/commit/b1d58d2f2a2f2ee1cd17ec5df041e3e4aed88f65))
- Hand a missed steer back as a draft instead of starting a turn ([`1a1f89d`](https://github.com/JLRoper/agent-worktree-gui/commit/1a1f89d416bfb0d2a530194b5e86722589da55ee))
- Drop the leading -- from the yolo chip ([`d19c801`](https://github.com/JLRoper/agent-worktree-gui/commit/d19c8019878497682a516521bea44606a3067ea7))
- Give the worktree chart the same buffer on the right as on the left ([`ac5a6b9`](https://github.com/JLRoper/agent-worktree-gui/commit/ac5a6b94e4ffe9046dd37a57d537dcdc12b6928b))
- Put the last-used counter next to the state pill ([`46b7b4f`](https://github.com/JLRoper/agent-worktree-gui/commit/46b7b4f8134fb805e55ae9b327c336f20dfaa633))
- Keep RUNNING while subagents are out, and let a subagent line open its console ([`fea3155`](https://github.com/JLRoper/agent-worktree-gui/commit/fea315557c05e938f8311676024f6c3eae1a3a20))
- Keep finished subagents on the card, greyed and collapsible ([`a2f0150`](https://github.com/JLRoper/agent-worktree-gui/commit/a2f015063d7ac269e319d5c9f0be9fcad14d0c90))
- Let a session's name reach a card created here ([`9b64a71`](https://github.com/JLRoper/agent-worktree-gui/commit/9b64a71d2c42f6571a0a4cf91ee99c9be0701960))
- Keep every console at its newest line unless the reader moves it ([`95ce679`](https://github.com/JLRoper/agent-worktree-gui/commit/95ce679ded1a9b20df469b3eb12d06be7452d8b7))
- Show what an agent thought, per session, with a default in Settings ([`d09f27a`](https://github.com/JLRoper/agent-worktree-gui/commit/d09f27ae853c5fe9e8a85a8628dcc924c0d89500))
- Condense a run of tool calls into one row per tool ([`f795057`](https://github.com/JLRoper/agent-worktree-gui/commit/f7950579c684e74f2f07a4416ef4d0e9658db32c))
- Add a reasoning button: the live reasoning, as Hermes' own show_reasoning does ([`3293b8f`](https://github.com/JLRoper/agent-worktree-gui/commit/3293b8f80082d6bad8be8565817d32ebfa576bbf))
- Make a tool tally open that tool's calls, not just everything ([`e5ba457`](https://github.com/JLRoper/agent-worktree-gui/commit/e5ba457c2b0872fcc9be0e3d064caec8a452d063))
- Fold the live reasoning into the thinking block ([`9dfca21`](https://github.com/JLRoper/agent-worktree-gui/commit/9dfca219b5274ca134b454dee31a25a6e0b0ff7c))
- Keep a subagent tally with the turn that delegated it ([`502c2f0`](https://github.com/JLRoper/agent-worktree-gui/commit/502c2f03f7b37b7c144eb15ee0c8d16ebccfd1f5))
- A worktree's play button also selects its project ([`4da0c75`](https://github.com/JLRoper/agent-worktree-gui/commit/4da0c754ec575e68031ec467d59c3193063aa10c))
- Make sure a parent gets its subagents' results, and watch the children while they run ([`bf14579`](https://github.com/JLRoper/agent-worktree-gui/commit/bf1457993813dea4df14369ff9606d6f6bc25fa7))
- Say which subagents produced a turn, and collect each turn only once ([`b060b18`](https://github.com/JLRoper/agent-worktree-gui/commit/b060b18a9bb3a4de72fe2f70997683b3f0579c2e))
- Make the thinking block follow its own newest line ([`7ae0e64`](https://github.com/JLRoper/agent-worktree-gui/commit/7ae0e64e0e80501b1baca290b19b8be676f6b917))
- Give a subagent's console the same condensing, and unwrap its tool results ([`37a0e4a`](https://github.com/JLRoper/agent-worktree-gui/commit/37a0e4a4c9e44b186e0f030d1032ceecbd5fe7ff))
- Let a card pick its model, and keep the console still while it runs ([`686bac4`](https://github.com/JLRoper/agent-worktree-gui/commit/686bac49a5312242a935760ed8fa820a437f70e3))
- Put the context window on the card, and let the reader set the ceiling it measures against ([`826d7f0`](https://github.com/JLRoper/agent-worktree-gui/commit/826d7f02132abe12153b10f2f53b9091ee23512f))
- Say what a running subagent is doing, on its folded row ([`6da1c0e`](https://github.com/JLRoper/agent-worktree-gui/commit/6da1c0e3da71058788fffed9cd9a4e583eb19c10))
- Walk only the reader's own prompts up from a reply box ([`092a633`](https://github.com/JLRoper/agent-worktree-gui/commit/092a633a6e73bd771977c155939320c26ac2dcda))
- Keep the thinking block and an open picker where the reader put them ([`fc74499`](https://github.com/JLRoper/agent-worktree-gui/commit/fc744994eaf9292edfaf671dfd4fbb22ff450fd7))
- Let an approval actually be clickable while its run keeps emitting events ([`2876cf4`](https://github.com/JLRoper/agent-worktree-gui/commit/2876cf46439e77d5301490d45df344d1cef5e381))
- Put a running subagent's clock beside its status, and float approvals bottom-right ([`b21975e`](https://github.com/JLRoper/agent-worktree-gui/commit/b21975e04a641ae4868eb65322d2f07ce0777ea9))
- Keep a worktree's agents on screen when the table re-ranks ([`a772d65`](https://github.com/JLRoper/agent-worktree-gui/commit/a772d65db955b4830e01da4849e5d4e26a86a328))
- Hold a reply for the subagents a thread still has out, and queue a steer the run refuses ([`6bd2b2d`](https://github.com/JLRoper/agent-worktree-gui/commit/6bd2b2d6ea0c3a73798ef6e2d49dced62737f902))
- Clear the reply box that is on the page after a send, not the one the send started with ([`f08624a`](https://github.com/JLRoper/agent-worktree-gui/commit/f08624ac80be070dd276ac8b32da99a559e6e4c0))
- Give the worktree and branch columns the room the life column was wasting ([`3d9f280`](https://github.com/JLRoper/agent-worktree-gui/commit/3d9f28003600f11683241dcf5d3fef3fb5deb874))
- Send the execution generation with an approval, so the gateway stops answering invalid_params ([`e2eb6fc`](https://github.com/JLRoper/agent-worktree-gui/commit/e2eb6fc7dff3dbc0e2e16cdbf33e4f0442ed1095))
- Count an agent parked on an approval as running ([`120d270`](https://github.com/JLRoper/agent-worktree-gui/commit/120d270bba74905bdba922bb65fca79b3f077308))
- Name the pending prompt, not just the generation, when answering an approval ([`34c901a`](https://github.com/JLRoper/agent-worktree-gui/commit/34c901a27b6996a146943ddb1f24c0788f05b13c))
- Read URLs from the console, not just prose, and give files and links a button each ([`15b203c`](https://github.com/JLRoper/agent-worktree-gui/commit/15b203c65a58f04ff590c7ebfe1bd09b2a5a602b))
- Make the context size a one-click ladder ([`92f735c`](https://github.com/JLRoper/agent-worktree-gui/commit/92f735cd4ff67ea2885f8bbfd32eb91b5cf36b1b))
- Settings: a scrolling body, grouped rows, and the prose behind tooltips ([`400da08`](https://github.com/JLRoper/agent-worktree-gui/commit/400da08f3d93240dd90ba3a1304a798bcee169ee))
- Add the OpenRouter endpoint and key to Settings ([`a83e459`](https://github.com/JLRoper/agent-worktree-gui/commit/a83e4596f50bfb702825d8d55848e9d4c5cc1788))
- Keep the model picker against the label it belongs to ([`c4427f0`](https://github.com/JLRoper/agent-worktree-gui/commit/c4427f0e54dbd0bda1de1bd1d4046ae91967ee62))
- Put the working directory in the prompt, because the Runs API has no cwd field ([`6e69bba`](https://github.com/JLRoper/agent-worktree-gui/commit/6e69bba86a8298b011d198edccc6534176fb3802))
- Give each project folder a search box in its header ([`b48fb3c`](https://github.com/JLRoper/agent-worktree-gui/commit/b48fb3c95a6a38864005b9c221e5c5b85236bec5))
- Say when an agent is in the project checkout rather than a worktree ([`7727263`](https://github.com/JLRoper/agent-worktree-gui/commit/77272635daa5615e627ff8247e70e4aac8485a98))
- Keep one row, one detail and one card per agent — and hold the reader's place across a rebuild ([`2a13dbe`](https://github.com/JLRoper/agent-worktree-gui/commit/2a13dbe42fccd3d0ea651498f9b2f7a72a8b8fa2))
- Hold the reader's place while cards above them grow — and a pin to choose the card ([`0499bb4`](https://github.com/JLRoper/agent-worktree-gui/commit/0499bb4940e715b9bf0f0a0636a3483801151603))
- Stop a repaint from pulling the page back to the caret, and end the spawn follow on any scroll ([`ebcee3d`](https://github.com/JLRoper/agent-worktree-gui/commit/ebcee3d02032596580e53b6c7d5447d773117ef3))
- Make the spawn jump deliberate in both directions, once each ([`f2138d5`](https://github.com/JLRoper/agent-worktree-gui/commit/f2138d5e8dc74b9d514b5f1efd0f7ff29803545a))
- Grow the reply box with its draft, a line at a time, above the buttons ([`da80b48`](https://github.com/JLRoper/agent-worktree-gui/commit/da80b484363c7953a8d6200c427583fd52050c39))
- Hold the composer still when a turn folds, and fold to a summary instead of a one-liner ([`4d5ca4d`](https://github.com/JLRoper/agent-worktree-gui/commit/4d5ca4d5e7fe135f752d6db8ea3c972b2249080b))
- Stop the board from following a promoted row - and keep the open detail on its row ([`92b317b`](https://github.com/JLRoper/agent-worktree-gui/commit/92b317b6df87b35744e8ee9b3142d4d791bcb451))
- Turn token counts in three significant digits: 636816 reads 636k tok ([`164aeab`](https://github.com/JLRoper/agent-worktree-gui/commit/164aeabdb750af86564069b6ecce251379e9e72f))
- Make every scrollbar part of the dark surface instead of the platform's white rail ([`06d459e`](https://github.com/JLRoper/agent-worktree-gui/commit/06d459e2ab16f6421fbe5f348cfb118bd1389437))
- Stop the five-minute full pass from starting every project at once ([`04516e3`](https://github.com/JLRoper/agent-worktree-gui/commit/04516e3ae5d1b6bc86590362675e3bbb1ff7a30e))
- One row, one detail: stop the duplicated MERGE STATE / LIVENESS block ([`ee7785a`](https://github.com/JLRoper/agent-worktree-gui/commit/ee7785a48b0a24929487a27360d215f9058bf283))
- Ctrl+click a project's title row to theme that project box ([`756a3e1`](https://github.com/JLRoper/agent-worktree-gui/commit/756a3e1fcc1580b033376fb0f89d5bd3deaacb83))
- A reset-colours button in Settings > Display ([`dd2224b`](https://github.com/JLRoper/agent-worktree-gui/commit/dd2224ba3021677cf6ca1dac6d27fe17d1fe89e7))
- Keep the usage readout copyable while it streams, and out of the buttons' highlight ([`73bf6e5`](https://github.com/JLRoper/agent-worktree-gui/commit/73bf6e5718226cae4cfe12ee5dfc368c3863b9f4))
- Rename the Hot Agent button to NOT-RUNNING ([`980fff4`](https://github.com/JLRoper/agent-worktree-gui/commit/980fff4520d46a9afe0228dc991c806b502e6d08))
- Hold a card's selection across a board repaint ([`8b904d8`](https://github.com/JLRoper/agent-worktree-gui/commit/8b904d830e5b5b229343014b39f07c5769db4d41))
- Let the pointer and the last touched card choose the anchor ([`f822076`](https://github.com/JLRoper/agent-worktree-gui/commit/f8220761ef082552189603b72a1342e8f4850fca))
- Two anchor signals, each with its own switch and window in Settings > Board ([`b577b82`](https://github.com/JLRoper/agent-worktree-gui/commit/b577b826b2e65a94f33ff13a2b1194346b57c555))
- Make the flash time a setting ([`d01ad9b`](https://github.com/JLRoper/agent-worktree-gui/commit/d01ad9b1310020be37ea1f280540a32e9f22b545))
- Hold the reader's selection through a card rebuild, by offsets not ranges ([`1fb04a2`](https://github.com/JLRoper/agent-worktree-gui/commit/1fb04a28d1ed0c760e23c1832aba5171bea34d58))
- A "to the newest line" chip on the console and on the thinking body ([`e25901a`](https://github.com/JLRoper/agent-worktree-gui/commit/e25901a92f93d1bf59bfe77d4c48fda39a78059a))
- Show the tool output the live stream never carried ([`936400e`](https://github.com/JLRoper/agent-worktree-gui/commit/936400e8bab6198f1abc2fcef0574205f53ecb1a))
- Make every flash obey the setting - and make a themed project flash at all ([`a6d8e63`](https://github.com/JLRoper/agent-worktree-gui/commit/a6d8e635dce25224c572decd740ecb7a55695690))
- Centre the "to the newest line" chip, and let Ctrl+wheel size the thinking text ([`4fb71b8`](https://github.com/JLRoper/agent-worktree-gui/commit/4fb71b87561f71fa6ae1df5f8045c328acb6967b))
- Discovery stops re-reading every repo with git ([`8bd7347`](https://github.com/JLRoper/agent-worktree-gui/commit/8bd7347649c17c8e095c121d7c6c74e5d33631d8))
- Anchor follows the click, and only one owner corrects a gesture ([`5626dd1`](https://github.com/JLRoper/agent-worktree-gui/commit/5626dd18e4889c42607610145a587e086a39fee2))
- Whatever the click landed on becomes the anchor, at once ([`7429b49`](https://github.com/JLRoper/agent-worktree-gui/commit/7429b49afd1f79f8790dd8ad2eb17db4dfe3360e))
- The tool condenser keeps the block you opened open ([`cca91ac`](https://github.com/JLRoper/agent-worktree-gui/commit/cca91ac584b4741563a8b40d76822244ac604352))
- Answer the agent's own questions on the card, not in the console ([`811ad47`](https://github.com/JLRoper/agent-worktree-gui/commit/811ad47f27f563f2c3d3155d0ce9f4298d16795c))
- An event about a worktree is a sign of life ([`a338986`](https://github.com/JLRoper/agent-worktree-gui/commit/a3389860d38566d969d13e4fd8614b5ca795f1c4))
- Refresh everything, or only the projects on screen ([`d6a2cb0`](https://github.com/JLRoper/agent-worktree-gui/commit/d6a2cb0d21a5d49781e68438bb3131dbe7425ce5))
- List the calls behind a "+ N commands" summary ([`af42366`](https://github.com/JLRoper/agent-worktree-gui/commit/af423663adf2676989e3970ee6f79a3fec033d73))
- A stopped card carries a one-click "continue" ([`24a5f37`](https://github.com/JLRoper/agent-worktree-gui/commit/24a5f377c2b2a5497c2508072bb5729555a6b4b6))
- A project flash is its edge and its header, not the whole panel ([`3d825a8`](https://github.com/JLRoper/agent-worktree-gui/commit/3d825a8b8dcda6893fcaecbcd91bee83a812541a))
- The worktree ▶ probes its stopped agents; a green + bar adds one ([`2e39e0e`](https://github.com/JLRoper/agent-worktree-gui/commit/2e39e0e22eea0a9b033c28affea6126d6f5ce7ec))
- A project flashes only while it is collapsed ([`6529187`](https://github.com/JLRoper/agent-worktree-gui/commit/6529187ce8a009dbd7cd83861fc19e52360e4a40))
- Tool output crosses the wire as text, not as JSON ([`58d46cb`](https://github.com/JLRoper/agent-worktree-gui/commit/58d46cbb26c42ffb10bf85787f9e10327c406b0b))
- Put the add-agent bar's green on a scale in Settings ([`e87024a`](https://github.com/JLRoper/agent-worktree-gui/commit/e87024acde66a23146fa21ca3db64dd01c20cc84))
- The not-running pill is the continue button ([`ea0d225`](https://github.com/JLRoper/agent-worktree-gui/commit/ea0d225e14791c4fc2daf33a6f50464582748c09))
- A minimized card says how its last turn ended ([`9ceab0d`](https://github.com/JLRoper/agent-worktree-gui/commit/9ceab0d6ddf7d47442a31a705afcd6563c68ea15))
- The + bar becomes a field in place; Enter starts the run from there ([`77be022`](https://github.com/JLRoper/agent-worktree-gui/commit/77be02230ee97af84d7e57376a29d365e40c2b70))
- Settings for the question box, and a centred column for it ([`df048b6`](https://github.com/JLRoper/agent-worktree-gui/commit/df048b630365ce380e5168ad4a797b3ef79ea72e))
- A subagent chip belongs to the turn that started it, not the card's first turn ([`9234669`](https://github.com/JLRoper/agent-worktree-gui/commit/9234669820e97003cb09dcbbcf1c475270725573))
- Stop the board's rebuilds from clamping the reader to the top ([`93d9c68`](https://github.com/JLRoper/agent-worktree-gui/commit/93d9c683268d474d9371526cb1519e12f204ca45))
- Document the board page: every control, chip and gesture ([`798011c`](https://github.com/JLRoper/agent-worktree-gui/commit/798011c254e9f740242758b32cbbbb4d118e2849))
- Document the Refresh setting: everything, or only on screen ([`0690f2a`](https://github.com/JLRoper/agent-worktree-gui/commit/0690f2a019b47a88c67137e8dcf3a50a68110d26))
- Document the controls the board gained since the guide was written ([`68d345d`](https://github.com/JLRoper/agent-worktree-gui/commit/68d345d1db221f82c05454a5df34ab64553c123b))
- Keep the caret through a project repaint ([`fd505ba`](https://github.com/JLRoper/agent-worktree-gui/commit/fd505bacf6e442c20fbfec144f16efa241f937e8))
- Give the question box the console's width, and make the width a setting ([`4b9634f`](https://github.com/JLRoper/agent-worktree-gui/commit/4b9634f29e2af107b5ca3740b39c97faa83a29a2))
- The add-agent bar's position is a setting ([`0607663`](https://github.com/JLRoper/agent-worktree-gui/commit/0607663b3dab7cd3fefe9e3f7d0069bb8cf799e7))
- A countdown bar on the question box ([`5943ada`](https://github.com/JLRoper/agent-worktree-gui/commit/5943adaf004018fa179c87c31069a6418e80a4f1))
- A re-rank must not end the sentence in the open row ([`f0b8719`](https://github.com/JLRoper/agent-worktree-gui/commit/f0b8719fe79cc18890d20a9a8c283ec4c8a57b37))
- Bracket every DOM move so a moving field keeps its caret ([`d01f513`](https://github.com/JLRoper/agent-worktree-gui/commit/d01f513279d6152652e1527d5693efe5d83d2403))
- Keep the delete confirmation under its own row ([`c87ab50`](https://github.com/JLRoper/agent-worktree-gui/commit/c87ab5008a50dfe3695e3875aa3e2a5275ae1c8c))
- Add an assistant panel: a sentry over the board, and one thread to talk to ([`e171411`](https://github.com/JLRoper/agent-worktree-gui/commit/e171411f4bbeb017ae0f90398ac203f38174ad97))
- Let the assistant cut worktrees and start workers ([`3847733`](https://github.com/JLRoper/agent-worktree-gui/commit/38477337640c1c28b003d7bf2bc5faeb7c993fa8))
- Put a live countdown and a draining bar on every watch deadline ([`92fa93e`](https://github.com/JLRoper/agent-worktree-gui/commit/92fa93e7fd825d8c638e3ad6bbfc36690954e82a))
- Wake the assistant at a watch's deadline, not just raise an alert ([`d53e024`](https://github.com/JLRoper/agent-worktree-gui/commit/d53e024ee6538c58a850e7274dac6ff0566be887))
- Notice a finished worker's leftover tree, and a delegated child that goes quiet ([`0262c6e`](https://github.com/JLRoper/agent-worktree-gui/commit/0262c6e696c4b8852718cba90943dd0da5d3b94c))
- Only uncommitted work counts as leftover work ([`6b8cf3a`](https://github.com/JLRoper/agent-worktree-gui/commit/6b8cf3a225ef71e09740dfd7dbbc3392a3fcd39c))
- Catch the same failure coming back turn after turn ([`ba0a1f8`](https://github.com/JLRoper/agent-worktree-gui/commit/ba0a1f8574dc264465c190f16fea01c406b067c2))
- Answer a worker's parked clarify question from the assistant panel ([`d9b4a7e`](https://github.com/JLRoper/agent-worktree-gui/commit/d9b4a7ee5bf332c4f94741a7cff1b059978a58fe))
- Resolve a SPAWN project name on the auto path ([`f69df55`](https://github.com/JLRoper/agent-worktree-gui/commit/f69df550506b126c22578dd7972e77c846784919))
- Let the assistant card fill the float when it is resized ([`65c5377`](https://github.com/JLRoper/agent-worktree-gui/commit/65c5377ce0f72057b719b199b2ea3a2bfe6f1528))
- Pin the assistant composer to the foot of the float ([`8620e6b`](https://github.com/JLRoper/agent-worktree-gui/commit/8620e6bfe40d863495ac5494f9dd2539439cb4bd))
- Supervise the sentry from the server, and resume a turn a restart cut in half ([`a52fb32`](https://github.com/JLRoper/agent-worktree-gui/commit/a52fb32456869905b81af8eeba90e5c86f1fb103))
- Add "Stabilize reordering": a list freezes while something in it is open ([`1f2d511`](https://github.com/JLRoper/agent-worktree-gui/commit/1f2d51166739c1e15e37cd805d5d98badfd8f7df))
- Give the assistant a working directory of its own, as a setting ([`6c08e9a`](https://github.com/JLRoper/agent-worktree-gui/commit/6c08e9a66469e45481d037c0c68359af7d2f4b6c))
- Let the assistant write its own standing rules ([`3c0aae5`](https://github.com/JLRoper/agent-worktree-gui/commit/3c0aae59d3470ffa2dd8776650e5b506dfcd2811))
- Stop blaming a worker for the reader's working copy ([`65b68d0`](https://github.com/JLRoper/agent-worktree-gui/commit/65b68d03467f6deaae70113f4a128aecb0c4b9a2))
- Delete the folder, not only git's record of it ([`84228e6`](https://github.com/JLRoper/agent-worktree-gui/commit/84228e61b3cbf7a57c872ea8e06a959f4a623d66))
- Drop a row that is no longer a worktree on the first discovery pass ([`d493461`](https://github.com/JLRoper/agent-worktree-gui/commit/d49346166eb676b8b9148da54e55100a4715e728))
- Name a worktree after the agent, not after the sentence that cut it ([`304d7aa`](https://github.com/JLRoper/agent-worktree-gui/commit/304d7aa93278f43469e5e604876c5c34aca1934e))
- Stagger the next-read rings across each cadence tier ([`e87e7de`](https://github.com/JLRoper/agent-worktree-gui/commit/e87e7de187aab7e1a68e031739edf65011faa5e3))
- Delete a merged, clean worktree without asking — and keep it deleted ([`384960c`](https://github.com/JLRoper/agent-worktree-gui/commit/384960c7bfcd704cdc7ac4db97e391a1a3ea15a7))
- Adopt a worktree only when one is actually on disk ([`fd5d166`](https://github.com/JLRoper/agent-worktree-gui/commit/fd5d166c09c5b2a9e524e2f39e8a5ba3cdd3f92b))
- Alert when a thread's latest turn ended interrupted ([`0f632a2`](https://github.com/JLRoper/agent-worktree-gui/commit/0f632a21fc23a224ea14c3f72c79189f956bad79))
- Keep a running turn's thinking block on its newest line through a project rebuild ([`d0f4414`](https://github.com/JLRoper/agent-worktree-gui/commit/d0f44146f82282c5cf72ca112ab54ee4979f8d52))
- Key the thinking block's open state to the turn, not to the stale node ([`1252c3d`](https://github.com/JLRoper/agent-worktree-gui/commit/1252c3d49b0c1cfdd5939e00ee6396619e14831b))
- Judge a thread's latest turn by its clock, not its trimmed counter ([`162f2c4`](https://github.com/JLRoper/agent-worktree-gui/commit/162f2c49317f450c5ea93e36f555b7ed67896df8))
- Ask the gateway what a restart cut off, and stop a dead turn's clocks ([`2f4b380`](https://github.com/JLRoper/agent-worktree-gui/commit/2f4b3803136a508fff8b052e201551dd9705d395))
- Keep the project's own checkout named after its folder ([`2735471`](https://github.com/JLRoper/agent-worktree-gui/commit/273547192c8694ce7eda7a1c8878b233d69d525f))
- Size the worktree table's columns from their cells, and let a reader drag an edge ([`cd6ebbd`](https://github.com/JLRoper/agent-worktree-gui/commit/cd6ebbdb72badd53a21259775cddce232a3c32d7))
- Land a branch from the UNMERGED chip: one press starts a MERGING agent ([`6d48a69`](https://github.com/JLRoper/agent-worktree-gui/commit/6d48a695d57cf9fefc852280792ca2b697f85670))
- A stored tool result is text in the console, and every call gets its own ([`99ea317`](https://github.com/JLRoper/agent-worktree-gui/commit/99ea3173b1280753f424ce839757bb67550ac8a0))
- Honour the review: one row per burst, a live store that settles, and text that is not thrown away ([`923f63a`](https://github.com/JLRoper/agent-worktree-gui/commit/923f63a921b1347032fcf0aeeb15fb0b960eb9ff))
- Wake the assistant with what the worker produced, not just that it stopped ([`5ca7fd2`](https://github.com/JLRoper/agent-worktree-gui/commit/5ca7fd2b86d79b4f001753ad7ac9325049897f33))
- Resolve a SPAWN IN name the panel renamed out from under it ([`bd1a99b`](https://github.com/JLRoper/agent-worktree-gui/commit/bd1a99bbf7f3fb3a842443a6e29fb1331899a6b9))
- Keep the spawn-target proof out of the live gateway (#4) ([`04297dc`](https://github.com/JLRoper/agent-worktree-gui/commit/04297dcd8c7ae7667cafe1896a8026d8618f0907))
- Let the board restart the gateway, or itself, and resume what that killed ([`eb0efe3`](https://github.com/JLRoper/agent-worktree-gui/commit/eb0efe3f70fc7667ceb2b13ef9f7ec538b64390e))
- Let a remote browser in with a token, and refuse off-machine writes without one ([`e31f949`](https://github.com/JLRoper/agent-worktree-gui/commit/e31f949e9092d10c9df0d0bfa7d41dc2c4a50952))
- Keep the token in PANEL_TOKEN, not in a tracked config file ([`08507ae`](https://github.com/JLRoper/agent-worktree-gui/commit/08507ae56adcd32a62c731ead18c24a20d68c11a))
- Let the worktree chart scroll sideways instead of squeezing ten columns (#11) ([`c9d8ac8`](https://github.com/JLRoper/agent-worktree-gui/commit/c9d8ac8ac4b2212009b6a07bf30d377f9192647e))
- Point the off-machine refusal at PANEL_TOKEN, not config.json ([`5a0724f`](https://github.com/JLRoper/agent-worktree-gui/commit/5a0724fda26af98694ac4ab281918890937f96f5))
- Stop an agent's question staying prose with no clarify box ([`2a9e98e`](https://github.com/JLRoper/agent-worktree-gui/commit/2a9e98ef4f9897b93520bbd0c164909233222edf))
- Read every action line a finished turn wrote, and carry each one out on its own ([`91d0362`](https://github.com/JLRoper/agent-worktree-gui/commit/91d0362b13d8ad2eccf8cab883f31c4de8072867))
- Stop offering an approval the gateway has already decided ([`a050ce0`](https://github.com/JLRoper/agent-worktree-gui/commit/a050ce094d69eb32dfdbf124b52401613bbf5f98))
- A verify script's scratch store goes with its run ([`8547ac4`](https://github.com/JLRoper/agent-worktree-gui/commit/8547ac47a11db77ecec7d83bf979cd3f6824f5db))
- Monitor Claude Code sessions alongside Hermes ([`b16158f`](https://github.com/JLRoper/agent-worktree-gui/commit/b16158fc5e07401fb319352f54175a06616d2296))
- Bump version to 0.2.0 ([`861652e`](https://github.com/JLRoper/agent-worktree-gui/commit/861652ed00589c5133500d902ab0ff75f195f034))

## v0.1.0 — 2026-10-20 · 1 commit

[`0d3d3a8`](https://github.com/JLRoper/agent-worktree-gui/commit/0d3d3a89179e819b972e1022f59e5854e55f17a9)

### Other

- Worktree monitor panel: worktree dashboard + Hermes agent launcher ([`0d3d3a8`](https://github.com/JLRoper/agent-worktree-gui/commit/0d3d3a89179e819b972e1022f59e5854e55f17a9))
