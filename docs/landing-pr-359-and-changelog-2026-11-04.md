# PR #359 landed as 1e1c595, and the 1.4.2 and 1.4.1 sections are rendered

The brief asked for three things: merge PR #359 with `gh pr merge 359 --rebase --admin` and prove it read
`MERGED` with `origin/main` past `6cd6426`; run `npm run changelog:check` on main and render the 1.4.2 section
as its own post-merge commit if it was missing; and say what the 16,956-line `ledger.json` under the round's
evidence is, leaving it in place.

## How the brief's three items resolved

| # | item | outcome |
|---|---|---|
| 1 | merge PR #359 | Already `MERGED` when this run first read it — rebase merge **`1e1c595`**, `2026-11-04T08:16:22Z`. Nothing left to merge; the state is proven below. |
| 2 | render the 1.4.2 section | It was missing, and so was 1.4.1: one pass covers both. Committed as `77e5bc0` with `CHANGELOG.md` alone; it spends no version. |
| 3 | say what the 16,956-line ledger is | The harness's own run record, not an accidental dump — 18 measured cases, 42–43 fields each, zero errors, and its numbers are the report's. It stays where it is. |

## The merge, and the two shas it rewrote

```
gh pr view 359 --json state,mergeCommit
  state        MERGED
  mergeCommit  1e1c595b8ca75d6c039dbc277f309be86b357a5d
  mergedAt     2026-11-04T08:16:22Z
  headRefName  wtgui/playwright-usability-rou-8ec471
git merge-base --is-ancestor 6cd6426 origin/main      exit 0 — the 1.4.1 base it was cut from is behind the merge
git rev-parse origin/main                             1e1c595b8ca75d6c039dbc277f309be86b357a5d
```

A rebase merge re-creates the branch's commits, and this one did: the branch's tip `d92edbd` (chore: 1.4.2) is
**not** an ancestor of `origin/main`, while the pair it became is `4ebc73c` (the round's report, harness, shots
and ledger) and `1e1c595` (the 1.4.2 bump). The content is unchanged — the docs commit and its rebased twin have
the same tree and the same parent:

```
git rev-parse d593a5a^{tree} 4ebc73c^{tree}   47b6bc92e038d12344ed1303646c3421768adbd8 (both)
git rev-parse d593a5a^ 4ebc73c^               6cd6426fe534a12e9a77e7e33b5d7c79103337f0 (both)
git show d92edbd:package.json                 "version": "1.4.2"
git show 1e1c595:package.json                 "version": "1.4.2"
```

## The render, made at main's tip

The render is written after the merge, in a tree whose `HEAD` is `origin/main`'s tip, so every sha the new
sections link is one main carries. Before it, the file had stopped one release short of `package.json`:

```
npm run changelog:check               changelog: CHANGELOG.md is out of date (exit 1)
grep -m1 '^## v' CHANGELOG.md         ## v1.4.0 — 2026-11-04 · 5 commits
grep '"version"' package.json         "version": "1.4.2"
```

One pass renders both missing releases (`tools/changelog.mjs` walks package.json's version history end to end,
so running it once per bump is wrong). After it:

```
grep -m3 '^## v' CHANGELOG.md         ## v1.4.2 — 2026-11-04 · 2 commits
                                      ## v1.4.1 — 2026-11-04 · 3 commits
                                      ## v1.4.0 — 2026-11-04 · 5 commits
grep -m1 'releases from' CHANGELOG.md 253 releases from v0.1.0 (2026-10-20) to v1.4.2 (2026-11-04), 906 commits
npm run changelog:check               changelog: CHANGELOG.md is current — 253 releases (exit 0)
git diff --stat                        CHANGELOG.md | 29 +++++++++++++++++++++++++++--
                                      1 file changed, 27 insertions(+), 2 deletions(-)
```

The two deletions are the header's release count and tip line, not content: everything from `## v1.4.0` to EOF is
byte-identical to main's copy (`sha256 797f8ef8…2131` on both sides, taken through `tr -d '\r'`), so the render
only prepended. Every sha in the newest section is an ancestor of main:

```
git merge-base --is-ancestor 4ebc73c origin/main   exit 0
git merge-base --is-ancestor 1e1c595 origin/main   exit 0
```

The render is its own docs commit (`77e5bc0`), after the bump it describes, so no section describes it and a
rebase merge landing it rewrites no link. It leaves `package.json` alone — no version is spent and no tag is
created. The 1.4.2 anchor itself is already right: `v1.4.2` is annotated at `18201a4`, peels to `1e1c595`, and is
on the remote, and `node tools/verify-version-tags.mjs --ref origin/main` prints
`253 version bumps … 253 tagged and annotated at the commit that first declared them` / `PASS`.

## What the 16,956-line ledger.json is

`docs/reviews/pipeline-flow-usability-round/ledger.json` is the run's record, not an accidental dump. It is the
harness's own `--json` output (`tools/verify-pipeline-flow-usability.mjs` writes `JSON.stringify(out, null, 1)` —
one-space pretty printing is why 358 KB becomes 16,956 lines), and the report links to it as "the raw ledger"
(`docs/reviews/pipeline-flow-usability-round.html`, lines 217–218 and 581–582).

It is measurement data, one entry per fixture per viewport:

- top-level keys `tree`, `viewports`, `cases`, `pageErrors`, `consoleErrors`, `errors`;
- 18 cases = 9 fixtures × 2 viewports (`1280x800`, `1821x700`); each case carries 42–43 fields, the extra one on
  the three `A/` position and long-track cases;
- the fields are the readings the report quotes: word counts, gate names and deciders, card/body/scroll geometry,
  stage and legend word counts, notch/link/arc counts, `hiddenPx`, `marksFrom`, `fit`, `status`, ink area;
- `pageErrors`, `consoleErrors` and `errors` are all empty arrays;
- nothing in it is a copy of an input (no `bundleVersion`, no `pipelines`, no base64 or `data:` image), the deepest
  nesting is 8, and the serialized blob is byte-identical to the one main carries — `a8e79fdc…c720` on both sides.

Its numbers are the report's: `B/investigate` 104 words, `B/sefl-review-loop` 415, `B/acceptance-thirteen` 450,
and `hiddenPx: 468` on the thirteen-stage default view. It names its own provenance in `tree` (the branch
worktree the round ran in), which is what makes it a record of that run rather than of this landing. It is left
untouched.

## Version

No bump. This landing carries the render of a version that already landed (1.4.2) and a record document; a
render spends no number and creates no tag, so `package.json` stays at 1.4.2 and the branch is docs-only. The
pre-push gate refuses exactly that shape (`version check: refused — … no version bump`), and this branch is
pushed with its documented `--no-verify` bypass, quoted in the PR body.
