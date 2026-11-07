# Changelog

Every released version of the panel, newest first: the commits each release carried over the tag before it,
grouped by what a reader gets from them. Generated from git history — `npm run changelog` rewrites this file and
`npm run changelog:check` fails when it is stale. Do not edit it by hand.

**What changed since the build I am running?** The board's config line names the build (`v1.53.6 · …`).
Pass that version here and read only what came after it:

```
npm run changelog -- --since v0.80.0
```

21 releases from v1.50.2 (2026-11-07) to v1.53.6 (2026-11-07), 50 commits between the tags. Every release is anchored by an
annotated tag at the commit that first declared its version; `npm run verify:version-tags` fails when a bump
has no tag.

## v1.53.6 — 2026-11-07 · 2 commits

[`7ff0b7b`](https://github.com/JLRoper/agent-worktree-gui/commit/7ff0b7b6b2d761b982e6bf2c369be7328ab15e67) · [compare v1.53.5...v1.53.6](https://github.com/JLRoper/agent-worktree-gui/compare/v1.53.5...v1.53.6)

### Fixed

- fix: a carried QUEUE or MESSAGE line gets a key, and the row it files keeps it ([`0b08888`](https://github.com/JLRoper/agent-worktree-gui/commit/0b08888ccccf3a5d75ad41163be6abe2267be6c3))

### Other

- chore: 1.53.6 — the version this landing carries ([`7ff0b7b`](https://github.com/JLRoper/agent-worktree-gui/commit/7ff0b7b6b2d761b982e6bf2c369be7328ab15e67))

## v1.53.5 — 2026-11-07 · 3 commits

[`d74949a`](https://github.com/JLRoper/agent-worktree-gui/commit/d74949aa509b274c75175ef0759c1991ac84c824) · [compare v1.53.4...v1.53.5](https://github.com/JLRoper/agent-worktree-gui/compare/v1.53.4...v1.53.5)

### Docs & tests

- docs: render the changelog — 394 releases ([`4c8714a`](https://github.com/JLRoper/agent-worktree-gui/commit/4c8714a9ecca6e16d94e8d81750ee9b41cd10446))
- docs: render the changelog — 395 releases ([`c458e4a`](https://github.com/JLRoper/agent-worktree-gui/commit/c458e4a2e99fb296f81262ff9c0304af06d2c246))
- docs: the 279 unlanded lines are a post-merge tail main already carries ([`d74949a`](https://github.com/JLRoper/agent-worktree-gui/commit/d74949aa509b274c75175ef0759c1991ac84c824))

## v1.53.4 — 2026-11-07 · 4 commits

[`8d74c44`](https://github.com/JLRoper/agent-worktree-gui/commit/8d74c44b6edde5664302ba7bc86bdd0781dc8e47) · [compare v1.53.3...v1.53.4](https://github.com/JLRoper/agent-worktree-gui/compare/v1.53.3...v1.53.4)

### Added

- feat: a watchdog turn says so in a chip, not in its own prompt ([`11ee461`](https://github.com/JLRoper/agent-worktree-gui/commit/11ee46101ab29a4b43a31593bfbc6c34ae307ff0))

### Docs & tests

- test: pin the watchdog chip to originHtml's output ([`e0aaf5b`](https://github.com/JLRoper/agent-worktree-gui/commit/e0aaf5b7801047f625255e88ebb52f5440184837))
- docs: the watchdog chip on a real watchdog turn ([`69978a4`](https://github.com/JLRoper/agent-worktree-gui/commit/69978a4f58ed44963cdba2faf263d87b7e30e78e))

### Other

- chore: 1.53.4 — the version this landing carries ([`8d74c44`](https://github.com/JLRoper/agent-worktree-gui/commit/8d74c44b6edde5664302ba7bc86bdd0781dc8e47))

## v1.53.3 — 2026-11-07 · 2 commits

[`91752da`](https://github.com/JLRoper/agent-worktree-gui/commit/91752da4e75cbaada00cc1def62ea384f48dd6ad) · [compare v1.53.0...v1.53.3](https://github.com/JLRoper/agent-worktree-gui/compare/v1.53.0...v1.53.3)

### Fixed

- fix: the Role tab carries the charter text, and Settings is the one place a role changes ([`91752da`](https://github.com/JLRoper/agent-worktree-gui/commit/91752da4e75cbaada00cc1def62ea384f48dd6ad))

### Docs & tests

- docs: render the changelog — 393 releases ([`be7a149`](https://github.com/JLRoper/agent-worktree-gui/commit/be7a149b262b9d1cc5d50d0659ea252089493cef))

## v1.53.0 — 2026-11-07 · 1 commit

[`d5872be`](https://github.com/JLRoper/agent-worktree-gui/commit/d5872bed570e424e772ed292a70c843ecd338d84) · [compare v1.52.5...v1.53.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.52.5...v1.53.0)

### Added

- feat: the four PDL pipelines in the Settings dropdown, drawn by the map ([`d5872be`](https://github.com/JLRoper/agent-worktree-gui/commit/d5872bed570e424e772ed292a70c843ecd338d84))

## v1.52.5 — 2026-11-07 · 2 commits

[`c0e9401`](https://github.com/JLRoper/agent-worktree-gui/commit/c0e94017e67d96fd80e92832799306d3b6644199) · [compare v1.52.4...v1.52.5](https://github.com/JLRoper/agent-worktree-gui/compare/v1.52.4...v1.52.5)

### Fixed

- fix: bound the tab's console buffers - what the server lists, a ceiling, no second copy ([`d8c45cb`](https://github.com/JLRoper/agent-worktree-gui/commit/d8c45cbf99a1799b51b7f17c36ac4713c8f319f4))

### Other

- chore: 1.52.5 — the version this landing carries ([`c0e9401`](https://github.com/JLRoper/agent-worktree-gui/commit/c0e94017e67d96fd80e92832799306d3b6644199))

## v1.52.4 — 2026-11-07 · 2 commits

[`28c0b47`](https://github.com/JLRoper/agent-worktree-gui/commit/28c0b47fb2009d93a0702822aac2b50ff98c5622) · [compare v1.52.3...v1.52.4](https://github.com/JLRoper/agent-worktree-gui/compare/v1.52.3...v1.52.4)

### Fixed

- fix(assistant): the system block is one constant string, so a provider can cache it ([`6ddce9f`](https://github.com/JLRoper/agent-worktree-gui/commit/6ddce9f159e403766e748780a2cc2e569cb4f62c))

### Other

- chore: 1.52.4 — the version this landing carries ([`28c0b47`](https://github.com/JLRoper/agent-worktree-gui/commit/28c0b47fb2009d93a0702822aac2b50ff98c5622))

## v1.52.3 — 2026-11-07 · 2 commits

[`db5307a`](https://github.com/JLRoper/agent-worktree-gui/commit/db5307a2a9a5610927b95c07fb4c2e5077087653) · [compare v1.52.2...v1.52.3](https://github.com/JLRoper/agent-worktree-gui/compare/v1.52.2...v1.52.3)

### Docs & tests

- docs: render the changelog — 389 releases ([`24296ef`](https://github.com/JLRoper/agent-worktree-gui/commit/24296ef86dbe0cba1ae53ec7ecdd3cf361f2aafa))
- docs: triage every worktree - 77 released, 7 kept, two features landed ([`db5307a`](https://github.com/JLRoper/agent-worktree-gui/commit/db5307a2a9a5610927b95c07fb4c2e5077087653))

## v1.52.2 — 2026-11-07 · 3 commits

[`098b5f9`](https://github.com/JLRoper/agent-worktree-gui/commit/098b5f906d1a8238b24bc3fec70acf31477568e7) · [compare v1.52.1...v1.52.2](https://github.com/JLRoper/agent-worktree-gui/compare/v1.52.1...v1.52.2)

### Fixed

- fix: the notes tab - one name for the pad, and one rules list ([`a21281b`](https://github.com/JLRoper/agent-worktree-gui/commit/a21281b896c1d17cf4b9366517034f3851f457a7))

### Docs & tests

- docs: render the changelog — 388 releases ([`67a8ab6`](https://github.com/JLRoper/agent-worktree-gui/commit/67a8ab6d7941526f87d25624cc45122282251a90))

### Other

- chore: 1.52.2 — the version this landing carries ([`098b5f9`](https://github.com/JLRoper/agent-worktree-gui/commit/098b5f906d1a8238b24bc3fec70acf31477568e7))

## v1.52.1 — 2026-11-07 · 1 commit

[`aa620ff`](https://github.com/JLRoper/agent-worktree-gui/commit/aa620ff532ba93f5b1cbd78e13d04f0c8b1161fe) · [compare v1.52.0...v1.52.1](https://github.com/JLRoper/agent-worktree-gui/compare/v1.52.0...v1.52.1)

### Docs & tests

- docs: trace the Director QUEUE re-carry to its missing key ([`aa620ff`](https://github.com/JLRoper/agent-worktree-gui/commit/aa620ff532ba93f5b1cbd78e13d04f0c8b1161fe))

## v1.52.0 — 2026-11-07 · 3 commits

[`82794b0`](https://github.com/JLRoper/agent-worktree-gui/commit/82794b03df04ced4ba9137e28363ed838659ea8e) · [compare v1.51.1...v1.52.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.51.1...v1.52.0)

### Added

- feat(assistant): a hard restart moves one assistant to a fresh thread ([`4eede34`](https://github.com/JLRoper/agent-worktree-gui/commit/4eede34d93d122b3057d0e5d5ced174e99fa0213))

### Docs & tests

- test(assistant): the charter rides the system half, not the turn preamble ([`b48612e`](https://github.com/JLRoper/agent-worktree-gui/commit/b48612ef3c70c62c7d2aa9be78df64da6628dd19))

### Other

- chore: 1.52.0 — the version this landing carries ([`82794b0`](https://github.com/JLRoper/agent-worktree-gui/commit/82794b03df04ced4ba9137e28363ed838659ea8e))

## v1.51.1 — 2026-11-07 · 4 commits

[`44a39eb`](https://github.com/JLRoper/agent-worktree-gui/commit/44a39ebb49cc109d9ba4ea268eabcfe6cad7c633) · [compare v1.51.0...v1.51.1](https://github.com/JLRoper/agent-worktree-gui/compare/v1.51.0...v1.51.1)

### Docs & tests

- docs: render the changelog — 385 releases ([`f485824`](https://github.com/JLRoper/agent-worktree-gui/commit/f4858241e41c914b1d95c54c08c2120f0f41fb6e))
- docs: correct the console memory note against the code ([`8531de7`](https://github.com/JLRoper/agent-worktree-gui/commit/8531de7b44c7cb9d3436d3c9f279a93602ef6492))
- docs: review the console memory note against the code and the raw run ([`f0c81bf`](https://github.com/JLRoper/agent-worktree-gui/commit/f0c81bf06126ebf9b3bf51028a4f3507fa141f65))

### Other

- chore: 1.51.1 - the version this landing carries ([`44a39eb`](https://github.com/JLRoper/agent-worktree-gui/commit/44a39ebb49cc109d9ba4ea268eabcfe6cad7c633))

## v1.51.0 — 2026-11-07 · 3 commits

[`cef36be`](https://github.com/JLRoper/agent-worktree-gui/commit/cef36be54083897c00b2643d2a343d86dbe221ea) · [compare v1.50.9...v1.51.0](https://github.com/JLRoper/agent-worktree-gui/compare/v1.50.9...v1.51.0)

### Added

- feat(version): a lane claims its number by pushing its tag ([`de36fc1`](https://github.com/JLRoper/agent-worktree-gui/commit/de36fc15a923d90bccbbfaa0baa6551d5220a61d))

### Docs & tests

- test(version): anchor the fixture's own number, and count the claims the gate sees ([`a17efdc`](https://github.com/JLRoper/agent-worktree-gui/commit/a17efdc5e66cbb23c623746b43f67d8752ba69a9))

### Other

- chore: 1.51.0 — the version this landing carries ([`cef36be`](https://github.com/JLRoper/agent-worktree-gui/commit/cef36be54083897c00b2643d2a343d86dbe221ea))

## v1.50.9 — 2026-11-07 · 2 commits

[`8566b66`](https://github.com/JLRoper/agent-worktree-gui/commit/8566b66aade07ad140c274c9d105c5ac4aea941f) · [compare v1.50.8...v1.50.9](https://github.com/JLRoper/agent-worktree-gui/compare/v1.50.8...v1.50.9)

### Fixed

- fix: wire the queue-line-dim gate into the scripts it declares ([`8566b66`](https://github.com/JLRoper/agent-worktree-gui/commit/8566b66aade07ad140c274c9d105c5ac4aea941f))

### Docs & tests

- docs: render the changelog — 383 releases ([`bb7b4df`](https://github.com/JLRoper/agent-worktree-gui/commit/bb7b4df55c680db8cff9790d309596315dd44094))

## v1.50.8 — 2026-11-07 · 1 commit

[`2035cc3`](https://github.com/JLRoper/agent-worktree-gui/commit/2035cc377ae6aafb45ac3cda0b50e5777e94d9f0) · [compare v1.50.7...v1.50.8](https://github.com/JLRoper/agent-worktree-gui/compare/v1.50.7...v1.50.8)

### Added

- feat: a landed QUEUE row and the Director's outbound lines are dim thread lines ([`2035cc3`](https://github.com/JLRoper/agent-worktree-gui/commit/2035cc377ae6aafb45ac3cda0b50e5777e94d9f0))

## v1.50.7 — 2026-11-07 · 2 commits

[`5ad18dc`](https://github.com/JLRoper/agent-worktree-gui/commit/5ad18dc287f54633e606db248ef680f6cc446aa1) · [compare v1.50.6...v1.50.7](https://github.com/JLRoper/agent-worktree-gui/compare/v1.50.6...v1.50.7)

### Docs & tests

- docs: render the changelog - 381 releases ([`b699291`](https://github.com/JLRoper/agent-worktree-gui/commit/b699291f6ca54092b7713000ae8c4bc530f514dd))
- docs: measure what a long-lived tab retains per turn ([`5ad18dc`](https://github.com/JLRoper/agent-worktree-gui/commit/5ad18dc287f54633e606db248ef680f6cc446aa1))

## v1.50.6 — 2026-11-07 · 5 commits

[`11b7d61`](https://github.com/JLRoper/agent-worktree-gui/commit/11b7d618e4b127e7b7a7876186e6e10a1d658860) · [compare v1.50.5...v1.50.6](https://github.com/JLRoper/agent-worktree-gui/compare/v1.50.5...v1.50.6)

### Added

- feat: one PDL reading, so the queue picker and Settings list the same pipelines ([`cc3dbf5`](https://github.com/JLRoper/agent-worktree-gui/commit/cc3dbf5906a1922bccde99d9f4b6cd341423fce2))

### Docs & tests

- docs: render the changelog — 380 releases ([`c665d7c`](https://github.com/JLRoper/agent-worktree-gui/commit/c665d7c72924003dd276199feadd93f44496803e))
- docs: the two pipeline definitions and the one PDL source ([`2098d43`](https://github.com/JLRoper/agent-worktree-gui/commit/2098d4380e226f59653ca4ed394e53e606ed3dd5))

### Other

- chore: record the base's own root-scan fixture so a push from it is not refused ([`29d9bea`](https://github.com/JLRoper/agent-worktree-gui/commit/29d9bea5101fc5ee70c4d2d23507c70cc54f5621))
- chore: 1.50.6 — the version this landing carries ([`11b7d61`](https://github.com/JLRoper/agent-worktree-gui/commit/11b7d618e4b127e7b7a7876186e6e10a1d658860))

## v1.50.5 — 2026-11-07 · 3 commits

[`461acb4`](https://github.com/JLRoper/agent-worktree-gui/commit/461acb4b63b7ee715cd1f1d0ff7aed503561ea13) · [compare v1.50.4...v1.50.5](https://github.com/JLRoper/agent-worktree-gui/compare/v1.50.4...v1.50.5)

### Fixed

- fix: the tier counters are the fleet's split, not the visible slice ([`b8e9888`](https://github.com/JLRoper/agent-worktree-gui/commit/b8e98885937127cafcc4009ea683faa4dec19ee2))

### Docs & tests

- docs: render the changelog — 379 releases ([`2b11be8`](https://github.com/JLRoper/agent-worktree-gui/commit/2b11be811006a45b8b78761195051aca1dcda77a))

### Other

- chore: 1.50.5 — the version this landing carries ([`461acb4`](https://github.com/JLRoper/agent-worktree-gui/commit/461acb4b63b7ee715cd1f1d0ff7aed503561ea13))

## v1.50.4 — 2026-11-07 · 3 commits

[`c42c5cb`](https://github.com/JLRoper/agent-worktree-gui/commit/c42c5cbfa03e6729f5a2f5e4cbc8be9534c23f7d) · [compare v1.50.3...v1.50.4](https://github.com/JLRoper/agent-worktree-gui/compare/v1.50.3...v1.50.4)

### Added

- feat: a folder header says how many of its projects are on the frequent scan ([`41eb51d`](https://github.com/JLRoper/agent-worktree-gui/commit/41eb51d43a57e5c4ac2653c8e110f35e90fe9639))

### Docs & tests

- docs: render the changelog — 378 releases ([`d22a680`](https://github.com/JLRoper/agent-worktree-gui/commit/d22a680b8abe6a9f64d7a513d93fe5941897d0be))

### Other

- chore: 1.50.4 — the version this landing carries ([`c42c5cb`](https://github.com/JLRoper/agent-worktree-gui/commit/c42c5cbfa03e6729f5a2f5e4cbc8be9534c23f7d))

## v1.50.3 — 2026-11-07 · 1 commit

[`eedf510`](https://github.com/JLRoper/agent-worktree-gui/commit/eedf510a006c3ac732b94c9dff385e56f2c43779) · [compare v1.50.2...v1.50.3](https://github.com/JLRoper/agent-worktree-gui/compare/v1.50.2...v1.50.3)

### Other

- chore: 1.50.3 — the version this landing carries ([`eedf510`](https://github.com/JLRoper/agent-worktree-gui/commit/eedf510a006c3ac732b94c9dff385e56f2c43779))

## v1.50.2 — 2026-11-07 · 1 commit

[`f92781c`](https://github.com/JLRoper/agent-worktree-gui/commit/f92781c1b5260d9ef004e9224ecfdf7e4c977b15)

### Fixed

- fix: a page load promotes nothing, and promotions run one at a time ([`f92781c`](https://github.com/JLRoper/agent-worktree-gui/commit/f92781c1b5260d9ef004e9224ecfdf7e4c977b15))
