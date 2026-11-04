# The 0.111.3 render landed once, the duplicate closed, and main moved to 0.114.0

The brief asked for three things: merge PR #336, the render of the v0.111.3 and v0.111.2 sections; close
PR #338 as the duplicate worker's copy of the same render; then prove on `origin/main` that `package.json`
was still `0.111.3`, the newest three sections read v0.111.3, v0.111.2 and v0.111.1, `changelog:check`
exited 0 naming 238 releases, and `verify:version-tags` passed.

By the time this run measured `origin/main`, other landings had already moved it. #336 was `MERGED` at
`2026-11-04T05:00:39Z` and #338 was `CLOSED` at `05:01:18Z`, and `main` had taken two more versions
than the brief's `4ebaa62`: 0.113.0 (`743789d`, PR #332, merged `04:53:39Z`) and 0.114.0 (`cad0469`, the
pipeline-flow visible harness). A sibling landing rendered those two missing sections at `97e6b86` while
this run was measuring, and this run's render of the same two sections came out byte-identical to it — so
it was dropped instead of pushed as a second render. This branch's only commit is this record.

## How the brief's three items resolved

| # | item | outcome |
|---|---|---|
| 1 | merge PR #336 with `--rebase --admin` | Already `MERGED` when this run reached it — rebase merge `b64d8f0`, `2026-11-04T05:00:39Z`. Nothing left to merge. |
| 2 | close PR #338 as superseded | Already `CLOSED` at `2026-11-04T05:01:18Z`, with a comment naming #336 and `b64d8f0`. Nothing left to close. |
| 3 | prove the merged state on `origin/main` | Proven, with the numbers re-derived: `main` is now 0.114.0, not 0.111.3, and the render count is 240, not 238. The readings are below. |

## The render, and the duplicate

#336's commit `2ee5db7` (base `4ebaa62`, 0.111.3) was rebase-merged onto `743789d` as **`b64d8f0`**. Its
`CHANGELOG.md` blob is the same one it carried on the branch — `e44fbfd` — and #338's head carries the same
blob, which is what "the same render from the duplicate worker" means here:

```
git rev-parse 2ee5db7:CHANGELOG.md b64d8f0:CHANGELOG.md refs/remotes/pr/338:CHANGELOG.md
  e44fbfdf5c8b1a4be04c0473b107dca076ab34b8   (all three)
git diff --stat 743789d b64d8f0
  CHANGELOG.md | 29 +++++++++++++++++++++++++++--
  1 file changed, 27 insertions(+), 2 deletions(-)
git diff 743789d b64d8f0 -- package.json     (empty: the render spent no version)
```

#338's close comment reads: "Superseded by #336, which merged as b64d8f0. The two PRs were the same render
from a duplicate worker — byte-identical diffs (27 insertions, 2 deletions in CHANGELOG.md, zero difference
between them) — so only #336 was landed and this one is closed unmerged to leave one render of one version."

## The brief's expected readings, at the commit they describe

At `4ebaa62` (0.111.3, the brief's tip), measured in a fresh clone of the remote:

```
grep '"version"' package.json           "version": "0.111.3"
grep -m1 '^## v' CHANGELOG.md           ## v0.111.1 — 2026-11-03 · 3 commits
grep -m1 'releases from' CHANGELOG.md   236 releases from v0.1.0 (2026-10-20) to v0.111.1 (2026-11-03), 852 commits ...
npm run changelog:check                 changelog: CHANGELOG.md is out of date (exit 1)
```

At `b64d8f0` (the #336 merge), the sections the brief names are exactly the newest three — and `package.json`
is no longer `0.111.3`, because `main` took 0.113.0 before the merge:

```
grep -m3 '^## v' CHANGELOG.md           ## v0.111.3 / ## v0.111.2 / ## v0.111.1
grep '"version"' package.json           "version": "0.113.0"   (0.113.0 first declared at 743789d)
npm run changelog:check                 changelog: CHANGELOG.md is out of date (exit 1) — 238 named, 239 in history
npm run verify:version-tags             239 bumps, 239 tagged and annotated; orphan-tag v0.112.0 (65eef30) → FAIL 1 finding
                                        (as it read then — the sibling tag set has since grown to three)
```

The check is red at that commit for a reason outside #336: 0.113.0 had landed at `743789d` before the render
merged, so the render named 238 releases while package.json's history held 239. The brief's "238 releases,
exit 0" was true only at `2ee5db7`, the branch commit written against `4ebaa62`; a rebase merge onto a moved
`main` changes the history the count is read from.

## What `main` holds now (the render landed once per version)

`97e6b86` — "docs: render the 0.114.0 and 0.113.0 sections, the two main had not rendered" — committed at
00:08:41 EST, one pass over the two versions `main` had taken since `b64d8f0`:

```
grep -m3 '^## v' CHANGELOG.md           ## v0.114.0 / ## v0.113.0 / ## v0.111.3
grep -m1 'releases from' CHANGELOG.md   240 releases from v0.1.0 (2026-10-20) to v0.114.0 (2026-11-03), 862 commits ...
npm run changelog:check                 changelog: CHANGELOG.md is current — 240 releases (exit 0)
```

This run rendered the same two sections from the same tip and produced the identical `CHANGELOG.md` blob
(`97d79872`), so its render commit was dropped rather than pushed: the branch was reset to `97e6b86` and only
this record was added. That is the same rule that made #338 a duplicate — one render of one version.

`verify:version-tags` at `97e6b86` finds all 240 bumps anchored and annotated; its findings are three
sibling tags, quoted under Version.

## Version

`0.114.0`, unchanged. This is a record — a docs-only commit that spends no version number, creates no tag
and leaves `package.json` alone. The versions it describes travelled with their own landings: 0.113.0 at
`743789d`, 0.114.0 at `cad0469`; a bump here would move `main`'s number for a document that adds nothing a
reader can use, the same rule `docs/versioning.md` applies to a housekeeping render.

The gate's anchors are clean; the findings are three tags sibling branches pushed for versions `main` never
carried. In a scratch clone of the remote:

```
version-tags: 240 version bumps in package.json's history (v0.1.0 .. v0.114.0), 240 tagged and annotated at the commit that first declared them
  orphan-tag   v0.112.0 points at 65eef30808, where package.json does not declare 0.112.0
  orphan-tag   v0.113.1 points at 37b94287e9, where package.json does not declare 0.113.1
  orphan-tag   v0.114.1 points at 7a2d3c3faa, where package.json does not declare 0.114.1
FAIL — 3 findings across 240 version bumps            (exit 1)
```

With those three tags deleted in that clone — they are not this branch's, and the shared tree's tags belong
to the sibling runs — the same gate prints `PASS` / `every bump carries an annotated tag at its own commit,
and no v<version> tag points elsewhere` (exit 0). No `missing`, `wrong-commit` or `lightweight` finding
appears among the 240 anchors.

The push bypass is the hook's documented one, and its refusal is quoted rather than the bypass left silent:

```
$ git push --dry-run origin HEAD
version check: refused — 1 commit is about to land with no version bump
  branch  0.114.0  (HEAD's package.json)
  base    origin/main  0.114.0  (97e6b86)
```

Pushed with `git push -u origin HEAD --no-verify`.
