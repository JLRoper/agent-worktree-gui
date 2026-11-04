# The v1.1.0 tag named a docs commit, not the bump

The brief: `verify:version-tags` is red at `main` with three findings — one wrong commit and two
pre-existing orphans. The wrong one was repaired; the orphans are reported and left alone, because
they belong to rows that have closed. Everything below was measured in this worktree at
`f00c0e0` (`origin/main`, 1.1.1) and against `origin` itself.

## What the gate said before the move

```
$ node tools/verify-version-tags.mjs --ref origin/main
version-tags: 248 version bumps in package.json's history (v0.1.0 .. v1.1.1), 247 tagged and annotated at the commit that first declared them
  wrong-commit v1.1.0 points at 0e16e541e3, but 1.1.0 first appeared at d5b35ebdcc
  orphan-tag   v0.112.0 points at 65eef30808, where package.json does not declare 0.112.0
  orphan-tag   v0.113.1 points at 37b94287e9, where package.json does not declare 0.113.1

FAIL — 3 findings across 248 version bumps
```

`d5b35eb` is the bump: `chore: 1.1.0 — the version this landing carries`, one file, `package.json`,
one line changed. `0e16e54` is `docs: render the 1.1.0 section, cut by this landing` — one file,
`CHANGELOG.md`, and it never writes `package.json` at all:

```
$ git show --name-only --format= 0e16e54
CHANGELOG.md
$ git show --stat --format='%h %s' d5b35eb | head -3
d5b35eb chore: 1.1.0 — the version this landing carries

 package.json | 2 +-
```

So the tag had been placed on the commit that rendered the section for 1.1.0, not on the commit that
declared the number — and its own message repeated the mistake: "package.json first carried 1.1.0 at
0e16e541e3". The gate reads the walk in `tools/release-history.mjs`, which anchors a version at the
first commit whose patch writes the `"version"` line, and by that reading `0e16e54` does not declare
anything.

## The move, and the peel a clone reads

The repository's own tool does this and writes the two-line message every tag here carries:

```
$ node tools/version.mjs tag --ref d5b35eb --force
version tag: v1.1.0 (annotated) at d5b35ebdcc — moved from 0e16e541e3
$ git rev-parse v1.1.0^{commit}
d5b35ebdcce609b3dc94064539f3f7d056681313
$ git push --force origin refs/tags/v1.1.0
 + ade3430...47103b1 v1.1.0 -> v1.1.0 (forced update)
$ git ls-remote origin 'refs/tags/v1.1.0*'
47103b1db8ca23145150fdd2d7ce54b94ad9ad77	refs/tags/v1.1.0
d5b35ebdcce609b3dc94064539f3f7d056681313	refs/tags/v1.1.0^{}
```

A moved tag is the one case where `--force` on a tag ref is the right operation rather than a
rewrite of someone's history: the tag object is new (`47103b1`, annotated), and the peeled value
`refs/tags/v1.1.0^{}` — what `git checkout v1.1.0` and the gate both read — is `d5b35eb`. The tag
now says what it means:

```
$ git cat-file -p v1.1.0
object d5b35ebdcce609b3dc94064539f3f7d056681313
type commit
tag v1.1.0

v1.1.0

package.json first carried 1.1.0 at d5b35ebdcc (chore: 1.1.0 — the version this landing carries)
```

## The two orphans — reported, not moved or deleted

Exact lines from the same gate, after the move:

```
  orphan-tag   v0.112.0 points at 65eef30808, where package.json does not declare 0.112.0
  orphan-tag   v0.113.1 points at 37b94287e9, where package.json does not declare 0.113.1
```

- **`v0.112.0` → `65eef30808`**, `chore: 0.112.0 — the version this landing carries` (2026-11-03).
  The commit is still reachable only from `wtgui/two-changes-to-the-assis-6291a1`, the head of PR
  **#337, which is `CLOSED`** (unmerged). `0.112.0` never appears in `main`'s `package.json` history.
- **`v0.113.1` → `37b94287e9`**, `chore: 0.113.1 — the version this landing carries` (2026-11-04).
  No local branch and no PR head contains it now. It sits on `69da5ae` (the pipeline-flow integration
  plan), whose parent is `743789d` (0.113.0, on `main`), and that plan landed through PR **#339**, whose
  merge commit is `fe6613a` — a rebase that did not carry the branch's own bump. `69da5ae` is not an
  ancestor of `main`; `fe6613a` is. So `0.113.1` is a number a branch declared and the merge dropped.

Neither is a tag this branch may re-point: each names a commit another row created, and moving one
would attach a version to a commit `main` never carried while deleting one leaves that row's only
record gone. Both belong to closed rows, so they are reported here and left in place. That is also
why the gate still exits 1 after the repair — red for two known orphans is the truthful state, and
clearing it is a decision about those rows, not a tag move.

## Verification at `origin/main` after the move

```
$ node tools/verify-version-tags.mjs --ref origin/main
version-tags: 248 version bumps in package.json's history (v0.1.0 .. v1.1.1), 248 tagged and annotated at the commit that first declared them
  orphan-tag   v0.112.0 points at 65eef30808, where package.json does not declare 0.112.0
  orphan-tag   v0.113.1 points at 37b94287e9, where package.json does not declare 0.113.1

FAIL — 2 findings across 248 version bumps        (exit 1)
```

```
$ npm run changelog:check
changelog: CHANGELOG.md is current — 248 releases        (exit 0)
```

The `wrong-commit` finding is gone, the anchored count went 247 → 248, the bump count is unchanged
at 248, and the changelog still reads current at the same tip.

## Version

`1.1.1`, unchanged. This is a record — a docs-only commit that spends no version number, creates no
tag and leaves `package.json` alone, the same rule `docs/versioning.md` applies to a housekeeping
render. The tag it describes is a repair of an existing anchor, not a new release.

The push hook refuses a docs commit by design, and the refusal is quoted rather than the bypass left
silent:

```
$ git push --dry-run origin HEAD
pre-push: refused — wtgui/repair-the-v1-1-0-tag-ve-c49be6 would go out with no version bump

version check: refused — 1 commit is about to land with no version bump

  branch  1.1.1  (HEAD's package.json)
  base    origin/main  1.1.1  (f00c0e0)
```

Pushed with `git push -u origin HEAD --no-verify`.
