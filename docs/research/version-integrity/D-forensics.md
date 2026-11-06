# D — Forensics: 48 hours of version, tag and render failures

The brief: count the version, tag and render failures over 48h, quote the sha of every incident, give each
class a frequency and a cost, and rank the classes by what they cost. This file is that count. Nothing in the
repository was changed to produce it: no tag was created, moved or deleted, `package.json` was not edited, and
the only commit this lane adds is this document.

## The window, the ref, and how each number was read

| | |
|---|---|
| window | `2026-11-04T02:15:00Z` .. `2026-11-06T02:15:00Z` (48h) |
| ref | `f6f0c2f118f0bff36f3e37598b958c068a5634d5` — the tip this lane was cut from |
| commits on `main` in the window | 331 (first-parent) |
| version bumps in `package.json`'s history at the ref | 334 (`v0.1.0` .. `v1.32.1`), per `tools/release-history.mjs` |
| first appearances in the window ("landings") | 107 |
| renders in the window | 54 — every `docs: render the changelog…` commit, counted from the `N releases from v0.1.0` line in the file it wrote, not from the subject |
| tags in the shared repository at the read | 342 (`git tag \| wc -l`, `2026-11-06T02:45:52Z`) |

Every tag read is a read of a **shared, live namespace**: sibling lanes tag into the same repository while a
forensic walk runs. It moved under this one — 339 tags when the walk started, 342 at the read, and `v1.33.0`
was re-pointed from `e52a88c0` to `28c28536` between two of this run's own reads. So the tag counts below are
pinned to the read named with them, and the landing and render counts are pinned to `f6f0c2f`, which does not
move.

Two derivations do the work, and both are the repository's own:

- **which commit first declared each version** — `readReleaseHistory({ref})` (`tools/release-history.mjs`), the
  same walk the tag gate and the changelog renderer read;
- **whether a landing's tip was stale** — `package.json`'s version at the landing commit against the newest
  `## v…` section in `CHANGELOG.md` at that same commit. A landing is **red** when its own version's section
  arrived after the next version landed; a release is **batched** when the next render's count jumps over it.

The zeroes are worth stating before the failures: at the pinned ref every one of the 334 bumps carries an
annotated tag at its own commit except one, and no version is missing a tag at all. The failures below are the
exceptions, not a broken gate.

## The count, ranked by cost

| rank | class | incidents in the window | frequency | measured cost |
|---|---|---|---|---|
| 1 | **stale renders** | 62 of 107 landings red; 20 episodes; 55 releases batched into 17 catch-up renders; 9 of 54 renders name a commit their own tip lacks; 2 duplicate renders | 57.9% of landings; one episode every 2.4h | **1,497 release-minutes** behind, longest 257m; 55 releases with no note at their tip |
| 2 | **tags left on unlanded commits, or rewritten** | 4 unlanded tags created inside the window (9 at the read); 1 wrong-commit; 3 documented rewrites; 2 retirements | 4 of 342 tags = 1.2%; the gate's **only FAIL** at the read | a reader checking out a bad version gets a commit `main` never carried; the landing gate red until repaired |
| 3 | **landings that outran `main`** | 3 numbers claimed by 2–3 landings each: `1.32.1`, `1.32.4`, `1.33.0` (7 competing bump commits) | a 50-minute burst (20:35–21:25) while lanes were cut from `1.32.0` and `1.32.1` | 1 tag still on the losing commit (the wrong-commit above), 1 repaired 3 minutes later; 3 lanes renumbered |
| 4 | **missing release tags** | 2: `v1.30.4` and `v1.32.0` | 2 of 107 landings = 1.9% | 64 anchor-minutes (54m + 10m), 2 repair pushes |

Stale renders are first by more than an order of magnitude: they are the only class that recurs on most
landings, and the only one measured in hours rather than minutes. The three tag classes are individually cheap
and collectively the only ones that make the landing gate FAIL — which is why they rank above their raw count.

## 1. Stale renders — 62 of 107 landings, 20 episodes, 1,497 release-minutes

A landing is supposed to render at the merged tip, in its own last step (`docs/versioning.md`, PHASE 4). The
measurement is the plainest one available: at the landing's own commit, `package.json` already names the new
version, and the newest `## v…` heading in `CHANGELOG.md` still names the one before it.

```
$ git show 600fbc4:package.json | grep '"version"'
  "version": "1.28.0",
$ git show 600fbc4:CHANGELOG.md | grep -m1 '^## v'
## v1.27.1 — 2026-11-05 · 5 commits
```

That is `v1.28.0`'s bump (`600fbc4`, 2026-11-05T22:55:58Z) landing with `v1.27.1` as the newest section. It
stayed that way for 22 minutes, until `5849647` ("docs: render the changelog — 322 releases") wrote the section.

**62 of the window's 107 landings were red by that test** — 57.9%, one every 46 minutes across the 48h. The 20
episodes, each closed by the render that caught it up:

| closed by | landings | red minutes | first landing | closed at | range |
|---|---|---|---|---|---|
| `7f55744` | 3 | 64 | 2026-11-03T21:16:57-05:00 | 2026-11-04T03:21:18Z | 0.104.0..0.106.0 |
| `65b7c01` | 1 | 23 | 2026-11-03T22:21:18-05:00 | 2026-11-04T03:44:00Z | 0.106.2..0.106.2 |
| `b64d8f0` | 2 | 34 | 2026-11-03T23:26:46-05:00 | 2026-11-04T05:00:38Z | 0.111.2..0.111.3 |
| `97e6b86` | 1 | 20 | 2026-11-03T23:53:38-05:00 | 2026-11-04T05:13:24Z | 0.113.0..0.113.0 |
| `eca3bac` | 1 | 11 | 2026-11-04T00:31:20-05:00 | 2026-11-04T05:42:18Z | 0.114.1..0.114.1 |
| `f0b52a3` | 17 | 215 | 2026-11-04T00:51:35-05:00 | 2026-11-04T09:26:30Z | 1.0.0..1.5.7 |
| `896e78d` | 2 | 97 | 2026-11-04T04:54:43-05:00 | 2026-11-04T11:31:17Z | 1.7.0..1.7.1 |
| `cb5f505` | 1 | 13 | 2026-11-04T06:31:17-05:00 | 2026-11-04T11:44:08Z | 1.7.3..1.7.3 |
| `4f6c6c3` | 2 | **257** | 2026-11-04T06:55:17-05:00 | 2026-11-04T16:12:22Z | 1.8.1..1.8.2 |
| `c2a3d5b` | 1 | 40 | 2026-11-04T13:27:08-05:00 | 2026-11-04T19:06:54Z | 1.8.7..1.8.7 |
| `9069f8d` | 6 | 170 | 2026-11-04T20:14:14-05:00 | 2026-11-05T04:04:40Z | 1.11.1..1.12.2 |
| `82b4d0f` | 15 | 169 | 2026-11-04T23:15:55-05:00 | 2026-11-05T07:04:33Z | 1.12.4..1.16.2 |
| `91b3430` | 1 | 228 | 2026-11-05T06:23:18-05:00 | 2026-11-05T15:10:52Z | 1.19.0..1.19.0 |
| `ce583ac` | 1 | 46 | 2026-11-05T13:38:10-05:00 | 2026-11-05T19:24:11Z | 1.20.1..1.20.1 |
| `8c93ed6` | 1 | 5 | 2026-11-05T14:50:50-05:00 | 2026-11-05T19:56:01Z | 1.22.0..1.22.0 |
| `5849647` | 2 | 22 | 2026-11-05T17:55:58-05:00 | 2026-11-05T23:17:51Z | 1.28.0..1.28.1 |
| `1e61686` | 1 | 21 | 2026-11-05T18:16:33-05:00 | 2026-11-05T23:37:49Z | 1.28.2..1.28.2 |
| `588ed19` | 1 | 27 | 2026-11-05T18:45:17-05:00 | 2026-11-06T00:11:59Z | 1.29.0..1.29.0 |
| `208620a` | 1 | 8 | 2026-11-05T19:20:17-05:00 | 2026-11-06T00:28:45Z | 1.30.2..1.30.2 |
| `60d8818` | 2 | 27 | 2026-11-05T19:33:46-05:00 | 2026-11-06T01:01:05Z | 1.30.4..1.30.5 |

The total is **1,497 release-minutes** — each release counted from its landing to the render that finally named
it. The distribution is the point: 10 episodes were closed inside half an hour, while the other 10 carried the
four largest, and the 257-minute episode is two releases (`1.8.1@f3c9c81`, `1.8.2@45e2bf0`) that sat red from
06:55 to 16:12.

### Every red landing

| version | commit | landed (UTC) | red minutes | cleared by |
|---|---|---|---|---|
| `v1.8.1` | `f3c9c81eec` | 2026-11-04 11:55:17 | 257 | `4f6c6c36cc` |
| `v1.8.2` | `45e2bf082d` | 2026-11-04 12:03:13 | 249 | `4f6c6c36cc` |
| `v1.19.0` | `59ca5d3b8d` | 2026-11-05 11:23:18 | 228 | `91b34307c9` |
| `v1.0.0` | `e9d3d7064b` | 2026-11-04 05:51:35 | 215 | `f0b52a3ba0` |
| `v1.0.1` | `0b0ff0b344` | 2026-11-04 06:07:27 | 199 | `f0b52a3ba0` |
| `v1.0.3` | `5ea54e9e08` | 2026-11-04 06:22:15 | 184 | `f0b52a3ba0` |
| `v1.0.4` | `4c0a52b34f` | 2026-11-04 06:32:43 | 174 | `f0b52a3ba0` |
| `v1.11.1` | `6353569a65` | 2026-11-05 01:14:14 | 170 | `9069f8df5b` |
| `v1.12.4` | `cfdb75b8ba` | 2026-11-05 04:15:55 | 169 | `82b4d0fa0f` |
| `v1.11.2` | `7679eca730` | 2026-11-05 01:16:29 | 168 | `9069f8df5b` |
| `v1.12.5` | `c325f7d67b` | 2026-11-05 04:18:32 | 166 | `82b4d0fa0f` |
| `v1.11.3` | `23ba6d1259` | 2026-11-05 01:20:04 | 165 | `9069f8df5b` |
| `v1.1.0` | `d5b35ebdcc` | 2026-11-04 06:45:44 | 161 | `f0b52a3ba0` |
| `v1.12.6` | `f9ce45013d` | 2026-11-05 04:27:08 | 157 | `82b4d0fa0f` |
| `v1.1.1` | `5116bd20e1` | 2026-11-04 06:58:42 | 148 | `f0b52a3ba0` |
| `v1.12.7` | `06a083db05` | 2026-11-05 04:37:11 | 147 | `82b4d0fa0f` |
| `v1.12.0` | `07b8358525` | 2026-11-05 01:43:49 | 141 | `9069f8df5b` |
| `v1.12.8` | `4534179eaf` | 2026-11-05 04:49:55 | 135 | `82b4d0fa0f` |
| `v1.12.9` | `ea7dc4df98` | 2026-11-05 04:52:57 | 132 | `82b4d0fa0f` |
| `v1.12.1` | `79e735b990` | 2026-11-05 01:54:10 | 131 | `9069f8df5b` |
| `v1.2.0` | `a8436412c1` | 2026-11-04 07:32:14 | 114 | `f0b52a3ba0` |
| `v1.12.10` | `c12874762f` | 2026-11-05 05:10:42 | 114 | `82b4d0fa0f` |
| `v1.13.0` | `d1489cab95` | 2026-11-05 05:20:29 | 104 | `82b4d0fa0f` |
| `v1.7.0` | `6a3de29353` | 2026-11-04 09:54:43 | 97 | `896e78dc01` |
| `v1.3.0` | `6ba1e8571a` | 2026-11-04 07:51:19 | 95 | `f0b52a3ba0` |
| `v1.4.0` | `db8dc06328` | 2026-11-04 08:02:25 | 84 | `f0b52a3ba0` |
| `v1.7.1` | `81ad614577` | 2026-11-04 10:06:51 | 84 | `896e78dc01` |
| `v1.13.1` | `7a47b93e45` | 2026-11-05 05:44:20 | 80 | `82b4d0fa0f` |
| `v1.4.1` | `6cd6426fe5` | 2026-11-04 08:09:33 | 77 | `f0b52a3ba0` |
| `v1.15.0` | `3295fcea37` | 2026-11-05 05:53:56 | 71 | `82b4d0fa0f` |
| `v1.4.2` | `1e1c595b8c` | 2026-11-04 08:16:21 | 70 | `f0b52a3ba0` |
| `v0.104.0` | `c55f88f546` | 2026-11-04 02:16:57 | 64 | `7f55744092` |
| `v0.105.0` | `0ef104a549` | 2026-11-04 02:28:12 | 53 | `7f55744092` |
| `v1.15.1` | `bf39bb98b2` | 2026-11-05 06:14:09 | 50 | `82b4d0fa0f` |
| `v1.5.0` | `4209390f30` | 2026-11-04 08:38:07 | 48 | `f0b52a3ba0` |
| `v1.20.1` | `0eaa68f587` | 2026-11-05 18:38:10 | 46 | `ce583ac663` |
| `v1.15.2` | `659d73eb4e` | 2026-11-05 06:20:28 | 44 | `82b4d0fa0f` |
| `v1.8.7` | `ae32ae56d0` | 2026-11-04 18:27:08 | 40 | `c2a3d5b2a6` |
| `v1.15.3` | `55f4f91c2c` | 2026-11-05 06:25:34 | 39 | `82b4d0fa0f` |
| `v1.5.2` | `7ffd712512` | 2026-11-04 08:50:31 | 36 | `f0b52a3ba0` |
| `v0.111.2` | `a980b30988` | 2026-11-04 04:26:46 | 34 | `b64d8f0b2f` |
| `v1.5.4` | `c9b8406f3f` | 2026-11-04 08:53:30 | 33 | `f0b52a3ba0` |
| `v1.16.0` | `3072db9357` | 2026-11-05 06:31:08 | 33 | `82b4d0fa0f` |
| `v0.111.3` | `4ebaa6261b` | 2026-11-04 04:30:24 | 30 | `b64d8f0b2f` |
| `v1.5.5` | `c7188bf20a` | 2026-11-04 08:57:41 | 29 | `f0b52a3ba0` |
| `v1.16.2` | `e33ec71fc8` | 2026-11-05 06:36:59 | 28 | `82b4d0fa0f` |
| `v0.106.0` | `4c42a05c29` | 2026-11-04 02:54:38 | 27 | `7f55744092` |
| `v1.29.0` | `91556461` | 2026-11-05 23:45:17 | 27 | `588ed19b2b` |
| `v1.30.4` | `3db5e284b2` | 2026-11-06 00:33:46 | 27 | `60d8818c84` |
| `v0.106.2` | `1641e5a71b` | 2026-11-04 03:21:18 | 23 | `65b7c016e1` |
| `v1.12.2` | `4651ace711` | 2026-11-05 03:42:32 | 22 | `9069f8df5b` |
| `v1.28.0` | `600fbc4640` | 2026-11-05 22:55:58 | 22 | `5849647cbf` |
| `v1.28.2` | `942f86df8a` | 2026-11-05 23:16:33 | 21 | `1e61686748` |
| `v0.113.0` | `743789d4c3` | 2026-11-04 04:53:38 | 20 | `97e6b86f16` |
| `v1.5.6` | `75ec220506` | 2026-11-04 09:06:59 | 20 | `f0b52a3ba0` |
| `v1.5.7` | `6be197804c` | 2026-11-04 09:12:36 | 14 | `f0b52a3ba0` |
| `v1.7.3` | `90004addb8` | 2026-11-04 11:31:17 | 13 | `cb5f505bd9` |
| `v0.114.1` | `698743f96f` | 2026-11-04 05:31:20 | 11 | `eca3bacf22` |
| `v1.30.2` | `c1bba49a65` | 2026-11-06 00:20:17 | 8 | `208620a5da` |
| `v1.30.5` | `a1421c0028` | 2026-11-06 00:55:07 | 6 | `60d8818c84` |
| `v1.22.0` | `88664a81b0` | 2026-11-05 19:50:50 | 5 | `8c93ed66f1` |
| `v1.28.1` | `72feecdd3d` | 2026-11-05 23:15:22 | 2 | `5849647cbf` |

### The batches: 55 releases rendered by a later pass

The same failure read from the other end: a render names `N` releases, the previous one named `M`, and `N-M-1`
releases landed in between with no render of their own. **17 jumps, 55 releases.**

| jump | missed | previous render | catch-up render | at |
|---|---|---|---|---|
| 236 -> 238 | 1 | `19879ba` | `b64d8f0` | 2026-11-04T00:00:38-05:00 |
| 238 -> 240 | 1 | `b64d8f0` | `97e6b86` | 2026-11-04T00:13:24-05:00 |
| 240 -> 242 | 1 | `97e6b86` | `eca3bac` | 2026-11-04T00:42:18-05:00 |
| 242 -> 260 | **17** | `eca3bac` | `f0b52a3` | 2026-11-04T04:26:30-05:00 |
| 261 -> 264 | 2 | `977635a` | `896e78d` | 2026-11-04T06:31:17-05:00 |
| 264 -> 266 | 1 | `896e78d` | `cb5f505` | 2026-11-04T06:44:08-05:00 |
| 266 -> 269 | 2 | `cb5f505` | `4f6c6c3` | 2026-11-04T11:12:22-05:00 |
| 271 -> 273 | 1 | `7c7eb23` | `c2a3d5b` | 2026-11-04T14:06:54-05:00 |
| 276 -> 283 | 6 | `c341613` | `9069f8d` | 2026-11-04T23:04:40-05:00 |
| 283 -> 299 | **15** | `9069f8d` | `82b4d0f` | 2026-11-05T02:04:33-05:00 |
| 302 -> 304 | 1 | `f7abde0` | `d06b59c` | 2026-11-05T03:28:59-05:00 |
| 309 -> 311 | 1 | `b116ec4` | `ce583ac` | 2026-11-05T14:24:11-05:00 |
| 312 -> 314 | 1 | `e29fb7e` | `8c93ed6` | 2026-11-05T14:56:01-05:00 |
| 320 -> 322 | 1 | `79ec3f3` | `5849647` | 2026-11-05T18:17:51-05:00 |
| 322 -> 324 | 1 | `5849647` | `1e61686` | 2026-11-05T18:37:49-05:00 |
| 326 -> 328 | 1 | `588ed19` | `208620a` | 2026-11-05T19:28:45-05:00 |
| 328 -> 331 | 2 | `208620a` | `60d8818` | 2026-11-05T20:01:05-05:00 |

Two of those jumps are the shape the rule exists to stop. `f0b52a3` is one render covering 17 landings
(`1.0.0`..`1.5.7`, landed 00:51–04:12 EST) at 04:26 EST; `82b4d0f` is one render covering 15 (`1.12.4`..`1.16.2`,
landed 23:15–01:36 EST) at 02:04 EST. Both are "render main so the tail is not red", not a landing's own last
step.

The same failure in its oldest form is `7f55744` — "docs: render the changelog through 0.106.2, where it had
stopped at 0.91.0" (2026-11-03T22:21:18-05:00):

```
$ git show 7f55744~1:CHANGELOG.md | grep -m1 'releases from'
216 releases from v0.1.0 (2026-10-20) to v0.91.0 (2026-11-03), 803 commits between the tags.
$ git show 7f55744:CHANGELOG.md | grep -m1 'releases from'
232 releases from v0.1.0 (2026-10-20) to v0.106.2 (2026-11-03), 837 commits between the tags.
```

Sixteen releases had landed behind a changelog that stopped at `0.91.0`.

### Renders that name commits the reader cannot follow — 9 of 54

Every section links the shas it lists. A section written on a branch names the branch's commits, and a rebase
merge re-creates them under new shas, so the section lands pointing at history `main` does not have. Testing
the newest section's commit links against the render commit's own ancestry finds **9 of the window's 54 renders**
with at least one such link, 23 distinct shas:

| render | releases named | at | commits the render's tip lacks |
|---|---|---|---|
| `7f55744` | 232 | 2026-11-03T22:21:18-05:00 | `3db2d70b`, `22195567` |
| `35230cc` | 261 | 2026-11-04T04:43:20-05:00 | `e6b80d7d` |
| `dd0b571` | 301 | 2026-11-05T02:34:00-05:00 | `fa294b7c`, `b7f2185b` |
| `7b8c02d` | 302 | 2026-11-05T02:40:58-05:00 | `a4825cdf`, `ca22644e`, `d27b2eda` |
| `d06b59c` | 304 | 2026-11-05T03:28:59-05:00 | `c8d3ea84`, `0ad018c0` |
| `bafe473` | 305 | 2026-11-05T04:04:30-05:00 | `7e3172bc`, `f92f5f07`, `33268fac`, `e17fe6ba` |
| `45cea65` | 306 | 2026-11-05T04:35:38-05:00 | `d493baaf`, `70ea537b` |
| `cfe6b5b` | 307 | 2026-11-05T06:23:18-05:00 | `8e4e2986`, `2a2ffe98`, `3387c863`, `0022026b` |
| `cea25cc` | 325 | 2026-11-05T18:45:17-05:00 | `be9e98ff`, `e070cfc0`, `21a414de` |

`7b8c02d` is the clearest single case: the render names `a4825cdf`, `ca22644e` and `d27b2eda`, and none of the
three is an ancestor of `7b8c02d` — the section was written against a branch whose commits `main` replaced.

### Duplicate renders — 2

Two passes rendered the same versions in the window, both recorded in the repo's own docs:

- **`b64d8f0`** (PR #336's rebase merge, 2026-11-04T05:00:39Z) and the head of **PR #338**, closed 39 s later
  as the duplicate: the same `CHANGELOG.md` blob `e44fbfd` on both, 27 insertions and 2 deletions, zero
  difference between them (`docs/landing-changelog-render-2026-11-04.md`).
- **`97e6b86`** (the catch-up render of `0.113.0`/`0.114.0`) and the render this run's sibling produced from the
  same tip: identical blob `97d79872`, so the second was dropped rather than pushed.

Cost: 55 releases whose section existed only after a later pass; 1,497 release-minutes in which a reader asking
"what changed since my build" got a stale answer; 9 renders (16.7%) whose newest section names history `main`
does not carry; 2 duplicate renders' worth of wasted work.

## 2. Tags left on unlanded commits, or rewritten — 4 in the window, 9 at the read

### Left on unlanded commits

At the pinned ref, four tags created **inside the window** name a commit `f6f0c2f` does not contain; by the read
at `02:45Z` the shared namespace held nine such tags, because five more were created after the window closed:

| tag | peels to | tagged | version `main` carries? | owner |
|---|---|---|---|---|
| `v1.8.3` | `ea16b282d3` | 2026-11-04T15:22:10Z | no — `main` went `1.8.2` -> `1.8.4` | dead row (`wtgui/...`) |
| `v1.23.1` | `988d8494f5` | 2026-11-05T19:56:55Z | no — `main` went `1.23.0` -> `1.23.2` | dead row |
| `v1.27.2` | `64115779` | 2026-11-05T22:48:57Z | no — `main` went `1.27.1` -> `1.28.0` | dead row |
| `v1.32.1` | `39d2e523af` | 2026-11-06T01:35:16Z | **yes, at `946578704c`** | losing landing (the wrong-commit) |

The five tags created after the window are all live-lane anchors or later repairs, and they are counted at the
read rather than in the window: `v1.32.2@e0ef3ef2`, `v1.32.3@ea15bb1d`, `v1.33.0@28c28536` (whose tag had already
been re-pointed from `e52a88c0`), `v1.32.4@3dfeb3a5` and `v1.33.1@4f64d46e`.

The three "dead row" tags are numbers `main` skipped: `1.8.3`, `1.23.1`, `1.27.2`. Their branches closed without
landing those numbers, so the tags are honest about their own commits and useless as anchors — the gate now
prints them as *held*, not as failures, and retiring them is a deliberate act (`docs/tag-retirement-2026-11-04.md`
did that for `v0.112.0` and `v0.113.1`).

Inside the window two tags were retired that way — `v0.112.0@65eef308` and `v0.113.1@37b94287`, deleted from
`origin` while the record that retired them landed (its PR merged at 2026-11-04T07:21:32Z). That is the correct
disposition, and it is also two more incidents: each is a version number `main` never carried.

### The one current wrong-commit

`v1.32.1` is the only FAIL the tag gate has at the pinned ref:

```
$ node tools/verify-version-tags.mjs --ref f6f0c2f
version-tags: 334 version bumps in package.json's history (v0.1.0 .. v1.32.1), 333 tagged and annotated at the commit that first declared them
  8 tags name a version f6f0c2f does not carry yet, each at a commit whose package.json declares it (held on a branch): v1.23.1@988d8494, v1.27.2@64115779, v1.32.2@e0ef3ef2, v1.32.3@ea15bb1d, v1.32.4@3dfeb3a5, v1.33.0@28c28536, and 2 more
  wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1 first appeared at 946578704c

FAIL — 1 finding across 334 version bumps        (exit 1)
```

```
$ git show 9465787:package.json | grep '"version"'      "version": "1.32.1"
$ git rev-parse --short 'v1.32.1^{}'                    39d2e52
$ git merge-base --is-ancestor 39d2e523 f6f0c2f; echo $?  1
```

`39d2e523` is a real bump — `chore: 1.32.1 — the version this landing carries`, one line — on
`wtgui/untrack-config-json-land-8e3f5a`. It was tagged at 20:35:16, and `main`'s own `1.32.1` landed at 20:37:00
from a different branch. The tag stayed on the branch that lost the race.

### Rewritten anchors — 3

| version | tag was on | moved to | when | evidence |
|---|---|---|---|---|
| `v1.1.0` | `0e16e541e3` — a `docs:` render commit that never wrote `package.json` | `d5b35ebdcc` — the bump | +27 min | `docs/landing-repair-v1-1-0-tag-2026-11-04.md` |
| `v1.27.1` | `c485717626` — the branch's pre-merge bump | `dfae827e` — the commit PR #379's rebase made | post-merge | `docs/version-tag-orphans-2026-11-05.md` |
| `v1.28.0` | `e989fd4aaa` — the branch's pre-merge bump | `600fbc4640` — the commit PR #445's rebase made | 41 s after the merge | same doc, measured from the tag object |

The `v1.28.0` move is the healthy shape: `tag --ref origin/main --force` 41 seconds after the merge, the
documented post-merge step. `v1.1.0` is the failure shape: the tag was placed on the render commit, so the
anchor named a commit that cannot declare a version at all, and 27 minutes passed before the gate was read and
the tag moved.

Cost: the gate's only FAIL at the read; a `git checkout v1.32.1` that yields a commit `main` never carried; three
anchors re-pointed (each a force-push of a tag); two retired tags; three held tags that will never anchor
anything.

## 3. Landings that outran `main` — 3 numbers, 7 competing commits

A landing outran `main` when two lanes cut from the same version and each bumped to the same next number; the
one that lands second has a bump commit that `main` has already passed. All three cases are in one burst, while
lanes were being cut from `1.32.0` and then `1.32.1` as `main` moved:

| version | losing commit (branch) | won by `main` | gap |
|---|---|---|---|
| `1.32.1` | `39d2e523` @ 20:35:02, tagged 20:35:16 (`wtgui/untrack-config-json-land-8e3f5a`) | `9465787` @ 20:37:00 | 2 min |
| `1.32.4` | `948fcc95` @ 21:25:12, tagged 21:25:38 (`wtgui/research-how-to-stop-par-fa30aa`) | `3dfeb3a5` @ 21:28:35 | 3 min |
| `1.33.0` | three writers: `c88a342` @ 20:37:47, `28c28536` @ 20:46:34, `e52a88c0` @ 20:47:47 | not landed at the ref | 3-way claim |

`git branch --contains` puts the losing `1.32.1` commit on `wtgui/untrack-config-json-land-8e3f5a` and the
losing `1.32.4` commit on `wtgui/research-how-to-stop-par-fa30aa`; both branches are still live. Two outcomes:
`v1.32.1`'s tag is still on the losing commit (the wrong-commit above; the lane landed `3ae7223`/`9465787`
instead), while `v1.32.4`'s tag was already moved onto `main`'s `3dfeb3a5` before the read — which is why the
held list names it there and not on the branch. `v1.33.0`'s tag was re-pointed from `e52a88c0` to `28c28536`
between two reads of this run. The costs are the wrong-commit, three number allocations that had to be redone,
and one lane left holding a tag for a number it never landed.

A related traceability cost: **11 of the window's 107 bumps ride a commit whose subject is not the bump** — the
version line lands inside a feature, fix or docs commit, so a reader scanning subjects cannot see the number:

| version | sha | subject the bump rode |
|---|---|---|
| `0.114.0` | `cad04690` | test: both routes into the pipeline flow, judged visible and clean at 1280 and 1821 |
| `1.0.0` | `e9d3d706` | feat!: the row's name-from-work path is gone; the padlock leads |
| `1.3.0` | `6ba1e857` | feat: thirteen stages fit the card, and the scroller says what it hides |
| `1.5.0` | `4209390f` | feat: Settings -> Updates draws the checkout's own changelog |
| `1.5.7` | `6be19780` | fix: tag the commit that declared the version, never the ref's tip (#368) |
| `1.7.1` | `81ad6145` | docs: order the split into ten landable stages (#373) |
| `1.12.1` | `79e735b9` | refactor: the Matrix bridge moves into the repo as a module |
| `1.12.6` | `f9ce4501` | docs: five free renderers measured, two demos, and mermaid recommended |
| `1.15.0` | `3295fcea` | feat: the map draws a document it did not build, and names its source |
| `1.21.1` | `6263ccc0` | wtgui/capture the settings pip 66e947 (#437) |
| `1.30.5` | `a1421c00` | fix: the two push selects ride the remote-mapping row, not their own band |

`a1421c0` is the one that cost an anchor: its patch writes `1.30.4` -> `1.30.5`, it is the commit the `v1.30.5`
tag names, and its subject reads as a fix — the tag is correct, but nothing in the subject trail says a number
landed.

## 4. Missing release tags — 2

At the read, zero versions lack a tag. Inside the window two did, and both were repaired by hand:

| version | declared at | tag created | missing for | record |
|---|---|---|---|---|
| `1.30.4` | `3db5e284` @ 2026-11-05T19:33:46-05:00 | 2026-11-05T20:28:08-05:00 | **54 min** | `docs/landing-repair-v1-30-4-tag-2026-11-05.md` |
| `1.32.0` | `9123e8c7` @ 2026-11-05T20:29:50-05:00 | 2026-11-05T20:39:34-05:00 | **10 min** | same record, fresh-clone reading |

Both are plain bump commits — `3db5e284` is `chore: 1.30.4 — the version this landing carries` and `9123e8c7`
is the same line for `1.32.0`; the tag simply was not written when the landing finished. The 54-minute case is
the one the repair record documents: `main` declared `1.30.4` at `3db5e284`, `origin` had no `v1.30.4`, and the
tag had to be created rather than moved because the local clone's `v1.30.4` already named another lane's
pre-landing commit (`83463d4a` on `wtgui/make-optym-integration-m-b580a2`).

The same measurement, one step wider: **22 of the 107 landings had an anchor created or moved more than two
minutes after the landing**, because the tag either did not exist yet or named a pre-merge commit:

| version | sha | landed | tag written | late by |
|---|---|---|---|---|
| `0.106.0` | `4c42a05c` | 2026-11-04 02:54:38Z | 2026-11-04 03:14:25Z | +20m |
| `0.110.0` | `b662bce1` | 2026-11-04 03:44:56Z | 2026-11-04 03:51:36Z | +7m |
| `0.114.1` | `698743f9` | 2026-11-04 05:31:20Z | 2026-11-04 05:42:43Z | +11m |
| `0.115.0` | `f108689a` | 2026-11-04 05:35:21Z | 2026-11-04 05:43:14Z | +8m |
| `1.0.1` | `0b0ff0b3` | 2026-11-04 06:07:27Z | 2026-11-04 06:16:24Z | +9m |
| `1.1.0` | `d5b35ebd` | 2026-11-04 06:45:44Z | 2026-11-04 07:13:07Z | +27m (a move: wrong commit -> bump) |
| `1.4.2` | `1e1c595b` | 2026-11-04 08:16:21Z | 2026-11-04 08:20:47Z | +4m |
| `1.5.0` | `4209390f` | 2026-11-04 08:38:07Z | 2026-11-04 08:50:05Z | +12m |
| `1.6.1` | `0507237f` | 2026-11-04 09:43:20Z | 2026-11-04 09:48:15Z | +5m |
| `1.7.1` | `81ad6145` | 2026-11-04 10:06:51Z | 2026-11-04 10:11:15Z | +4m |
| `1.8.0` | `2704ce37` | 2026-11-04 11:42:05Z | 2026-11-04 11:45:17Z | +3m |
| `1.9.1` | `6fc78bf2` | 2026-11-04 20:02:54Z | 2026-11-04 20:09:51Z | +7m |
| `1.16.2` | `e33ec71f` | 2026-11-05 06:36:59Z | 2026-11-05 06:59:51Z | +23m |
| `1.19.0` | `59ca5d3b` | 2026-11-05 11:23:18Z | 2026-11-05 11:28:32Z | +5m |
| `1.21.0` | `9a14da6b` | 2026-11-05 19:20:01Z | 2026-11-05 19:24:35Z | +5m |
| `1.21.1` | `6263ccc0` | 2026-11-05 19:24:34Z | 2026-11-05 19:29:59Z | +5m |
| `1.24.0` | `ef0c4c3c` | 2026-11-05 20:57:25Z | 2026-11-05 21:01:49Z | +4m |
| `1.27.0` | `77033508` | 2026-11-05 22:19:48Z | 2026-11-05 22:23:57Z | +4m |
| `1.30.4` | `3db5e284` | 2026-11-06 00:33:46Z | 2026-11-06 01:28:08Z | +54m (missing: created) |
| `1.30.6` | `b326a2f4` | 2026-11-06 00:58:52Z | 2026-11-06 01:01:39Z | +3m |
| `1.31.0` | `15c10407` | 2026-11-06 01:02:02Z | 2026-11-06 01:04:19Z | +2m |
| `1.32.0` | `9123e8c7` | 2026-11-06 01:29:50Z | 2026-11-06 01:39:34Z | +10m (missing: created) |

Those are all anchors that were not in place when the number landed. Most were moves (a rebase re-made the
commit, and the tag followed within minutes); two were the missing tags above, and both needed a create, not a
move.

## What the 48h says, in one paragraph per class

**Render discipline is the systemic failure, not the tag discipline.** 62 of 107 landings (57.9%) finished with a
`CHANGELOG.md` that did not name the version `package.json` already carried, 20 times over, and the repair was
almost always a later bulk render that covered 1–17 releases. The tags, by contrast, are 333/334 correct at the
ref, with one wrong-commit and one version (1.32.1) racing another. So the cost order is: hours of stale
release notes for a reader, then a single broken anchor, then three racing numbers, then two missing tags.

**The tag failures cluster in the last two hours of the window**, and they cluster around the same event: lanes
were cut from `1.32.0` (then `1.32.1`) and by 20:35–21:25 three of them had claimed `1.32.1`, `1.32.4` and
`1.33.0` at once. That is when `v1.32.1` became a wrong-commit, `v1.30.4`'s anchor had to be created 54 minutes
late, and `v1.32.0`'s tag arrived 10 minutes after its landing. The day's render failures are spread across all
48 hours; the tag failures are a burst.

**Two failure shapes are cheap to prevent and expensive to leave**: an anchor written after the landing
(22 cases; 64 minutes of proven missing-tag time in the two documented ones) and a render written on the branch
that the landing then rewrote (9 renders naming 23 commits `main` does not carry). Both are the same mistake in
different files — the artifact was made before the merge, and the merge gave it a new sha to name.

## Method, and how to reproduce it

All of this was read from the repository, pinned to `f6f0c2f`, with `git` and the repo's own tools:

```
git log --format='%H%x09%cI%x09%s' f6f0c2f                     # dates for every commit
node -e "…readReleaseHistory({ref:'f6f0c2f'})…"                # 334 first appearances
git for-each-ref --format='%(refname:short) %(taggerdate:iso-strict) …' refs/tags
git show <commit>:package.json | grep '"version"'             # version at a landing
git show <commit>:CHANGELOG.md | grep -m1 '^## v'              # newest section at a landing
git merge-base --is-ancestor <sha> <render-sha>                # is the section's link followable?
node tools/verify-version-tags.mjs --ref f6f0c2f               # the gate's own reading
node tools/land.mjs --check                                    # changelog current at the worktree tip
```

The landing set is `readReleaseHistory`'s first appearances whose commit date falls in the window; the render
set is every `docs: render the changelog…` commit on `main`'s first-parent line in the window, with `N` read from
the `N releases from v0.1.0` line in the file that commit wrote (a render's subject is not a reliable count:
`7f55744`'s says "through 0.106.2, where it had stopped at 0.91.0"). A landing is red when the first later
render naming its version comes after the next version's landing.

Two limits are worth stating. The tag namespace is shared and live — sibling lanes wrote to it during this walk,
so the tag counts carry the read timestamp printed above. And "red minutes" counts each release from its landing
to the render that named it; overlapping episodes are not deduplicated, so the 1,497 is a sum of exposure, not
wall-clock time.

## What this run changed

Nothing. No tag created, moved or deleted; `package.json` untouched; `CHANGELOG.md` untouched; no branch or PR
state changed. The only file added is this record, and the only commit this lane makes is the one that carries
it.

## Version

`1.32.1`, the version `f6f0c2f` carries. This is a docs-only record: it spends no number, creates no tag and
leaves `package.json` alone — the same rule `docs/versioning.md` applies to a housekeeping render. It is written
against a landing branch, so the pre-push hook will refuse it by design; the documented docs-only path is
`git push --no-verify`, and the refusal is expected rather than bypassed silently.
