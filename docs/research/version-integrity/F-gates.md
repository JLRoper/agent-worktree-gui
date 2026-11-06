# F — the gates

Status: **measured, read-only.** This lane changed no source file, no `package.json`, no `CHANGELOG.md` and no
tag. The one commit is this document.

Snapshot: **2026-11-05 21:46:02 -0500**, `origin/main` **`1c68bf6`**, `package.json` **1.32.4**. The base took
eight tips while this lane ran (`9465787` -> `603617b` -> `f6f0c2f` -> `3dfeb3a` -> `e06e119` -> `d7ee126` ->
`f61739f` -> `1c68bf6`), through 1.32.1 to 1.32.4, so every reading below names the commit and the minute it was
taken. A gate reading is a photograph of movable refs, not a property of the repository.

## 0. The short answer

Four things stand between a wrong version and `main`, and they guard different halves of the problem:

| gate | what it reads | what it refuses | exit | who runs it |
|---|---|---|---|---|
| `.githooks/pre-push` | the ref lines on stdin, `HEAD`'s `package.json`, the base's tree | a push that adds commits with no bump; a commit naming a path new to this machine; a **base** push with a stale changelog | 1 | git, on every local push |
| `node tools/version.mjs check` | `HEAD:package.json` and `<base>:package.json` | no base, an unreadable or incomparable number, unchanged-with-commits, **behind** the base | 1 | the hook, and by hand |
| `node tools/verify-version-tags.mjs` | the `package.json` history walk, plus this clone's `refs/tags` | `missing`, `wrong-commit`, `lightweight`, `orphan-tag`, `backwards` | 1 (2 = could not run) | **nothing automatic** — by hand only |
| `node --test test/release-tags.test.js` | pure inputs: a synthetic `git log -p` text and tag lists | a regression in the walk or in the finding rules | test runner | `node --test` |

Three of the four are a pipeline. The fourth is a book about the pipeline.

The sentence that explains tonight: **the hook can refuse a branch with no bump, but it cannot refuse a tag,
and a landing that skips its post-merge move leaves the remote with a tag on a commit `main` never carried.**
`v1.32.1` is that state at this snapshot: the tag on `origin` peels to `39d2e523`, and the `1.32.1` `main`
carries is `9465787`.

## 1. The pre-push hook: three checks, one ref class it never looks at

### What actually runs

The clone's `core.hooksPath` is the panel's hooks directory, not `.githooks`. That hook is the panel's
remote-write guard (`lib/push-guard.js`): it asks the panel's permission box and, on every path that allows the
push, chains the hook the worktree already had. The chain file names `.githooks/pre-push`, resolved against the
tree doing the pushing, and the guard forwards the original stdin ref list to it. So:

- the guard's refusal ("the push control ... is never", or "nobody answered the permission box") is a
  **permission** refusal, not a version refusal;
- the version gate is `.githooks/pre-push`, and it receives the same ref lines git handed the guard;
- `WTGUI_PUSH_GRANT=1` skips the guard but still runs the chain; `git push --no-verify` skips both.

### The ref parse, and the tag-shaped hole

`.githooks/pre-push:39-59` reads one line per ref: `<local ref> <local sha> <remote ref> <remote sha>`. Three
decisions are made there:

```
case "$lref" in refs/tags/*) continue ;;                 # a tag moves no branch      (line 49)
[ "$lsha" = "000...0" ] && continue                      # deleting the ref
case "$lref" in refs/heads/main|refs/heads/master) base_push=1 ;; esac
```

The comment on line 49 is true and irrelevant to the failure: a tag moves no branch, but it moves the
**anchor**, which is the thing `verify-version-tags` exists to judge. A push carrying only tags therefore
leaves `new_commits=0`, and line 60 exits 0 before any check runs. Measured, at this worktree:

```
$ git push --dry-run origin refs/tags/v1.32.2:refs/tags/v1.32.2
To github.com:JLRoper/agent-worktree-gui.git
 * [new tag]         v1.32.2 -> v1.32.2
(exit 0 — no pre-push line)
```

A dry run executes the same ref update; here git printed its own `* [new tag]` line and nothing from the hook.
Nothing was checked because every line in that push is a `refs/tags/*` line: the `continue` at line 49 skips
each one, `new_commits` stays 0, and line 60 exits before `check` runs. That is the whole mechanism behind
incident 1 below.

### The version check it runs

Line 62 is `out=$(node "$TOOL" check 2>&1)` — no arguments. `check` reads `HEAD`'s `package.json` and the
resolved base's tree. `pushed_shas` is collected at lines 44 and 57 but used only by the absolute-path gate
below; the version gate never reads the sha being pushed. Two consequences:

1. a multi-ref push is judged by whichever branch is checked out, not by every ref in the push;
2. `git push origin some-other-branch` from this worktree runs the comparison against this worktree's `HEAD`.

The hook's own header says the second is deliberate ("the panel pushes one branch per worktree"), which is
true of the panel and false of a person with a terminal.

### The other two checks

- **Absolute paths** (`:78-105`): for each pushed sha it runs `node tools/absolute-paths.mjs --rev <sha>`, which
  scans the tree the push would send, not the dirty tree beside it. Only exit 1 refuses; a tool that cannot run
  does not block a push.
- **Stale changelog on a base push** (`:107-128`): only when the pushed ref is `refs/heads/main` or `master`,
  it runs `node tools/land.mjs --check --no-fetch`. Only exit 1 refuses. The header is explicit that a worktree
  branch's changelog is the base's business.

### Fail-open, by design

Lines 30-33: no repository root, no `tools/version.mjs`, or no `node` on PATH, and the hook exits 0. The header
says why ("a hook that cannot run its own check is not a reason to block somebody's landing"). It is the right
call for a local speed bump and the wrong shape for a release gate: the same absence is silent.

## 2. `version.mjs check`: a comparison, not an anchor check

`modeCheck` (`tools/version.mjs:318-451`) does one thing: it compares the number `HEAD` would push with the
number at the base ref's **current tip**. The base is `--base` when given, else `$VERSION_BASE`, else the
remotes' own HEAD symrefs, then any remote-tracking `main`/`master`, then local `main`/`master`
(`:81-108`). Both numbers are read from git trees, never from the working file (`:189-200`), so an uncommitted
bump is not a pass; when the working file differs from `HEAD` the tool says so in a note (`:366-368`).

It passes in exactly two states:

- the branch's number is **strictly above** the base's (exit 0, `:385-394`);
- the branch adds **no commits** and its number **equals** the base's (exit 0, `:397-404`; this is `main`
  itself).

It refuses in five:

| state | line | what it says |
|---|---|---|
| no base ref resolves | 327-338 | "nothing was compared ... a gate that cannot name the branch's base cannot pass it" |
| `HEAD:package.json` has no readable version | 346-349 | refuses rather than guessing |
| the base tree has no readable version | 350-362 | "nothing was compared, so nothing was proven" |
| the numbers cannot be compared as `major.minor.patch` | 370-382 | refuses |
| unchanged with commits to land, **or behind** | 406-450 | names both numbers and the commits |

It prints what it compared on **both** outcomes, so silence cannot be read as a pass. It never writes. The
behind case is the defect the tool was fixed for: the old check treated every value that was not equal as a
bump, which is how `0.84.0` passed against a base at `0.87.0`; `test/version-check.test.js` builds a real
repository with a bare remote and pins the three states in one tree (two tests, both green).

What it does not read: **tags**. A branch can be above the base, pass this gate, and carry no tag at all — the
tag is not part of the comparison. Nor does it read any other lane's number: the only other number in the
comparison is the base's.

## 3. `verify-version-tags.mjs`: the anchor's gate, run by nobody

The walk is `git log --follow -p -- package.json` from the ref, oldest first
(`tools/release-history.mjs:96-108`). A version **first appears** at the first commit whose patch writes a new
value to the top-level `"version"` line (`parseVersionHistory`, `:59-80`); a commit that touches the file
without touching that line is not a bump, and a number written twice keeps its first declaration
(`firstAppearances`, `:85-94`). `findDeclaration` (`:174-184`) is the same walk used by `version.mjs tag`, which
is why the tool and the gate cannot disagree about where a version began.

`checkReleaseTags` (`tools/verify-version-tags.mjs:37-105`) reports five kinds, all failures:

| kind | what it means | pinned by |
|---|---|---|
| `missing` | the walk first declared `<version>` at `<sha>`, and no `v<version>` tag exists | `release-tags.test.js:129` |
| `wrong-commit` | the tag exists and peels to another commit | `:153` |
| `lightweight` | the tag is at the right commit but carries no message | `:129` |
| `orphan-tag` | a `v<version>` tag names a version `package.json` at **that commit** does not declare | `:146` |
| `backwards` | the version line moved down between two transitions | `:167` |

The nuance that matters tonight is the **held** tag (`:82-103`, `:140-144`): a tag for a version the ref's walk
does not carry yet, whose own commit's `package.json` declares exactly that number, is a branch's pre-landing
anchor and is reported as a note, not a finding. That is the 2026-11-05 fix; before it, every live branch's
bump tag was reported as a false claim and `main` went red after every landing. A held tag still has to be
annotated — held does not excuse a lightweight anchor (`:161-165`).

Two properties of the gate are easy to miss:

- **It reads this clone's `refs/tags`, not the remote's.** `readTags` (`release-history.mjs:112-126`) is a
  `for-each-ref refs/tags`. A lane's unpushed pre-landing tag is visible here and invisible to a reader; a tag
  deleted locally but still on `origin` is invisible here and visible to that reader. The remote's own reading
  requires a fresh clone or a fetch that prunes tags.
- **Exit 2 is a real answer.** An empty walk means the pathspec, ref or checkout is wrong; the gate refuses to
  print PASS on nothing (`:145-148`). It does not fail open.

It is not in the hook and not in CI (this repo has no CI). `npm run verify:version-tags` is a command a person
or a lane has to choose to run. Tonight it was run by hand, repeatedly, and its finding is still open.

## 4. `release-tags.test.js`: the logic is pinned, the wiring is not

`node --test test/release-tags.test.js` is **15/15 green** at this snapshot. It pins the pure functions:

- a version first appears at the commit whose patch writes it, not at a later edit of the file;
- a commit that only touches another `package.json` field is not a bump;
- a version written twice keeps its first commit;
- tags sort by number, not string (`v0.9.0` < `v0.84.0`);
- the five finding kinds, the held-tag exemption, and a landed version tagged elsewhere (`wrong-commit`);
- a held tag that is lightweight is still a finding;
- a number that goes backwards is reported even when both bumps are tagged.

`test/version-tags.test.js` adds **8/8** tests against a real sandbox repository: `tag --force` moves an anchor
onto the commit a rebase re-created, `backfill` is idempotent, `tag --ref` anchors the declaration under a
render commit, and `tag` refuses loudly when no reachable commit declares the ref's version.

Neither file runs `.githooks/pre-push`. `test/absolute-paths.test.js` is the only test that invokes the real
hook, and it does so for path findings only. So the logic of "what a finding is" is tested; the wiring of
"when the gate runs, on which ref, with which number" is not. Every incident below lives in the wiring.

## 5. Tonight's incidents, one command each

Six incidents, in the order they cost the most. The command in the fourth column is the one that would have
**refused** the incident at the moment it was possible to refuse it — not a procedure, not a suggestion. The
fifth column says whether that command exists in a gate today; the last says which gate would have to change
to run it.

| # | incident | state at the snapshot | the one command | today | gate to change |
|---|---|---|---|---|---|
| 1 | a tag pushed onto an unlanded commit | `v1.32.1` peels to `39d2e523` (branch tip); `main`'s 1.32.1 is `9465787` | `git merge-base --is-ancestor 'v1.32.1^{commit}' origin/main` | exit 1, and no gate runs it | pre-push: delete the `refs/tags/*` skip |
| 2 | a landed number with no tag on `origin` | `v1.30.4` now repaired; a fresh clone read `missing` at the time | `node tools/verify-version-tags.mjs --ref origin/main` | exit 1, by hand only | pre-push, base push: run it on the pushed sha |
| 3 | the same number on two lanes | 1.33.0 declared by `28c2853` and `e52a88c`; the one tag moved between them | the `for-each-ref` loop in 5.3 (a `--unique` mode does not exist) | no gate | `version.mjs check`: compare against remote branches |
| 4 | a branch below the base | a tree at 1.27.0, `origin/main` at 1.32.4 | `node tools/version.mjs check` | exit 1 — this one works | none |
| 5 | every docs-only push refused | every record in this research set | `node tools/version.mjs check` | exit 1; the documented remedy is `--no-verify` | pre-push: a docs-only exemption |
| 6 | a stale changelog at the merged tip | 4m03s between `9465787` and the render `f6f0c2f` | `node tools/land.mjs --check --no-fetch` | exit 1, but a merge is not a push | the landing path, not the hook |

### 5.1 The tag pushed onto an unlanded commit (the case the brief names)

Two lanes minted `1.32.1` two minutes apart:

| commit | time | where it lived |
|---|---|---|
| `39d2e523` | 2026-11-05 20:35:02 | `wtgui/untrack-config-json-land-8e3f5a`, the branch tip |
| `9465787` | 2026-11-05 20:37:00 | `main`, by PR #460's rebase merge |

The tag was created 14 seconds after the first commit (`v1.32.1` tagger `20:35:16`) and is on `origin`. The
branch it names was pushed and never landed as that commit: PR #460's rebase merge re-created the bump as
`9465787`, and the post-merge move that `docs/versioning.md` prescribes (`node tools/version.mjs tag --ref
origin/main --force && git push origin v1.32.1 --force`) was not run. The remote still peels the branch's
commit:

```
$ git ls-remote --tags origin 'refs/tags/v1.32.1*'
b3ebd9e0297f010f4f7e9556e39b9112de8d93f2  refs/tags/v1.32.1
39d2e523af3055ec456fde90f1a8029e12d2df16  refs/tags/v1.32.1^{}
$ git cat-file -p v1.32.1
object 39d2e523af3055ec456fde90f1a8029e12d2df16
type commit
tag v1.32.1
...
package.json first carried 1.32.1 at 39d2e523af (chore: 1.32.1 — the version this landing carries)
```

The gate sees it:

```
$ node tools/verify-version-tags.mjs --ref origin/main
version-tags: 335 version bumps in package.json's history (v0.1.0 .. v1.32.4), 334 tagged and annotated at the commit that first declared them
  7 tags name a version origin/main does not carry yet, each at a commit whose package.json declares it (held on a branch): v1.23.1@988d8494, v1.27.2@64115779, v1.32.2@e0ef3ef2, v1.32.3@ea15bb1d, v1.33.0@28c28536, v1.33.1@d7df0d34, and 1 more
  wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1 first appeared at 946578704c

FAIL — 1 finding across 335 version bumps
(exit 1)
```

**The one command that would have refused the tag push:**

```
git merge-base --is-ancestor 'v1.32.1^{commit}' origin/main
```

It exits 1 here. It is the whole test: a version tag may be *pushed* only when the commit it names is on the
base the remote carries. The branch may hold the tag locally before the landing — that is the documented
"the branch carries a tag the gate can read" — but a pre-landing anchor must not travel to `origin`.

**Why no gate runs it.** `.githooks/pre-push:49` skips every `refs/tags/*` line, and a tag-only push then adds
no commits and exits at line 60. Even when the tag travels with the branch (`git push --follow-tags`), the hook
sees only the branch line, checks `HEAD`'s number against the base, and never looks at the tag. **The gate that
would have to change is the pre-push hook**: replace the tag skip with a peel-and-ancestry test against the
remote base, allowing deletions (the zero sha) and allowing a tag whose commit is already an ancestor. That is a
few lines in POSIX sh, and it is the highest-value change in this document.

### 5.2 The landed number with no tag on `origin`

The mirror image, and the one that produces `missing` rather than `wrong-commit`. `main` declared **1.30.4** at
`3db5e284b2` (committed 19:33:46). `origin` had no `v1.30.4` at all: the only local tag named `83463d4`, an
unlanded lane's bump on `wtgui/make-optym-integration-m-b580a2`. A fresh clone therefore read:

```
  missing      v1.30.4 is not tagged — first declared at 3db5e284b2 (2026-11-05) chore: 1.30.4 — the version this landing carries
FAIL — 1 finding across 332 version bumps        (exit 1)
```

That reading is recorded, with the `ls-remote` list taken immediately before the repair, in
`docs/landing-repair-v1-30-4-tag-2026-11-05.md`. The repair wrote a new tag object under a temporary ref and
pushed it to `refs/tags/v1.30.4`, so no lane's anchor moved; at this snapshot the tag peels to `3db5e28` and
the finding is gone.

**The one command:** `node tools/verify-version-tags.mjs --ref origin/main` — the existing gate, exit 1 with
`missing`. **The gate that would have to change is the pre-push hook's base-push branch**: it already gates a
base push for a stale changelog, and it could run this gate on the pushed sha in the same block. Measured cost
at 335 bumps: **9.8 s**, against **7.1 s** for the version check that already runs there — affordable on a base
push, which is rare.

### 5.3 The same number on two lanes

This is not one incident but a class, measured three times tonight:

| number | first declaration | second declaration | how it ended |
|---|---|---|---|
| 1.32.0 | `9123e8c` (landed) | `bb814f3` (branch; see the v1.30.4 record) | the branch's tag was left behind; a fresh clone read `missing v1.32.0` |
| 1.30.4 | `3db5e28` (landed) | `83463d4` (branch) | the remote had no tag at all (5.2) |
| 1.33.0 | `28c2853` (20:46:34) | `e52a88c` (20:47:47) | the single tag `v1.33.0` was at `e52a88c` at 20:48:08 and at `28c2853` at 21:25:20 |

The last row is the sharpest: both commits write `"version": "1.33.0"` to `package.json`, and the one tag was
**force-moved between them** — a `git tag -f` or `version.mjs tag --force` at 21:25:20, 37 minutes after the
second lane's commit. Whichever lane lands, the other's tag either moves again or names an unlanded commit.
`version.mjs check` passes both, because each is above the base at the moment it was cut; a lane's number is
only ever compared with the base, never with another lane's number.

**The one command** that would have refused the second declaration is a uniqueness test across the remote's
branches. In this clone the cheap-enough version is one shell loop:

```
git for-each-ref --format='%(refname:short) %(objectname)' refs/remotes/origin/wtgui \
  | while read r s; do git show "$s:package.json" 2>/dev/null | grep -q '"version": "1.33.0"' && echo "$r"; done
```

It prints `origin/wtgui/hold-a-pipeline-row-on-i-04c7d1` at this snapshot. It is also **slow**: two git
processes per remote branch, 247 of them here, and a second run for another version did not finish in 240 s. A
gate cannot afford that shape; the workable one is a number claimed once — a reservation tag pushed when the
number is chosen, or a registry file on the base — so the comparison is one ref read, not a walk of every
branch.

**The gate that would have to change is `version.mjs check`** (a `--unique` mode, or the reservation check in
`apply`): compare `HEAD`'s number with every remote branch that declares a number, not only with the base. The
existing partial guard is `apply`'s `tagAt` refusal (`version.mjs:476-483`, "a version is anchored once; move or
delete that tag first"), and it did work once tonight: the 1.25.0 number was skipped because a live tree held
its tag, and the landing took 1.26.0 instead (`docs/reports/awg-tree-backlog-2026-11-05.md`). The hole is that
it reads the **tag namespace**, not other branches' `package.json`, and a force-move makes a taken number look
free.

### 5.4 The branch below the base — the gate that works

Most of tonight's open trees were cut before `main` moved and still carry the number they were cut at. The
check refuses them, and it is worth quoting because incident 5 is often confused with it. From a tree at
1.27.0, `origin/main` at 1.32.4 (`f61739f`):

```
$ node tools/version.mjs check
version check: refused — this branch's version is behind origin/main's

  branch  1.27.0  (HEAD's package.json)
  base    origin/main  1.32.4  (f61739f)
...
  a branch cut before origin/main moved still carries the number it was cut at, so "unchanged" is not a bump:
  origin/main already reads 1.32.4, and landing this branch would carry a number main has passed. Merge or
  rebase origin/main into this branch, then bump above 1.32.4 in this PR:

    node tools/version.mjs apply patch|minor|major
(exit 1)
```

**The one command:** `node tools/version.mjs check`. It exists, it runs in the hook, and it refuses. No gate
change is needed for the refusal. The only defect is wording: the hook's headline (`:67`) says "would go out
with no version bump" for both the unchanged case and the behind case, so a worker reading only the first line
is told the wrong thing. That is H-23's finding, and it is a one-line fix, not a gate.

### 5.5 Every docs-only push is refused

A record, a repair note, a lane document — a commit that touches only `docs/` — is refused by the same check,
because it adds a commit and does not move the number. This document's own push is that case; the recorded
example from a sibling lane is:

```
version check: refused — 1 commit is about to land with no version bump

  branch  1.32.1  (HEAD's package.json)
  base    origin/main  1.32.1  (f6f0c2f)

  commits this branch adds:
    e8c754e9  patch docs: trace every version point in the panel's own automation
...
  (git push --no-verify bypasses this check, and a local hook only ever binds its own author.)
```

**The one command:** `node tools/version.mjs check`, exit 1. **The gate that would have to change is the
pre-push hook**: it should exempt a branch whose every commit touches only documentation, the way
`land.mjs` already does for a base push (`docsOnlyPush`, `land.mjs:158-171`: every non-merge commit touches
exactly `CHANGELOG.md`). Today the hook's own refusal prints `git push --no-verify` as the remedy (`:72`), so
the bypass is the documented normal path for records. A bypass that every honest record needs is not a gate;
it is a habit.

### 5.6 The changelog at the merged tip — a merge is not a push

The render is the landing's last step, and the hook gates it only on a **local base push**. Tonight's window:
`9465787` landed at 01:37:01Z; the render `f6f0c2f` (334 releases) was pushed at 01:41:04Z — **4m03s** in which
`main` carried a release with no section. The cause is the one `land.mjs`'s header names: two landings merged
13 seconds apart, the render pipeline runs once per landing run, not once per merge, and the second landing
left no render behind.

`node tools/land.mjs --check --no-fetch` is the gate shape, and it refuses the stale state with exit 1
(recorded at `58ab40a`: `land: CHANGELOG.md is stale — it would add v1.3.0`). But **`gh pr merge --rebase
--admin` is not a push**: it happens on the remote, runs no local hook, and cannot be refused by this clone's
guard. The only local base push after a merge is the one `npm run land` makes, and that command renders
first, so it passes by construction. If the landing run dies between the merge and PHASE 4, nothing refuses
the stale tip; the next reader finds it.

**The one command:** `node tools/land.mjs --check --no-fetch`, exit 1. **The gate that would have to change is
not the hook but the landing path**: the merge prompt's PHASE 4 and the landing's report have to make "merged
but not rendered" a visible, failing state (the report already has a `changelog:` line, but a run that stops
early publishes no report). With no CI, there is no remote-side check to add; the honest fix is to make the
landing's completion depend on the `land:check` reading, and to run the check once more after a run that claims
to have landed.

One cost note for anyone tempted to put this on every push: `node tools/changelog.mjs --check` took **2m50s** at
335 releases in this worktree (the render walks every release range). It is affordable once per base push, as
the hook already does, and not affordable as a branch gate.

## 6. What the four gates add up to

| the failure | caught by | when |
|---|---|---|
| a branch with no bump, or behind the base | `version.mjs check` | at push, refused |
| a commit naming a local path | `absolute-paths.mjs` | at push, refused |
| a stale changelog on a **local** base push | `land.mjs --check` | at push, refused |
| a bump with no tag, a tag at the wrong commit, a lightweight or orphan tag, a backwards number | `verify-version-tags.mjs` | **only when a person runs it** |
| a tag pushed for a commit the base does not carry | nothing | never |
| two lanes minting the same number | nothing (`apply` sees only tags) | never |
| a merge that skips its render | nothing | never |

The pattern is not that the gates are weak. It is that all four guard the **branch's number at push time**,
and tonight's failures happened to the **tag and the base after the merge** — the half of the lifecycle no gate
owns. The one gate that reads the tag is the one nothing runs.

## 7. If one change were made

Add the tag clause to `.githooks/pre-push`: for every pushed `refs/tags/v<major>.<minor>.<patch>` with a
non-zero local sha, peel it and refuse unless the commit is an ancestor of the remote base. Keep deletions and
already-landed anchors passing; keep the branch's pre-landing tag local until the landing moves it. That single
change would have refused incident 1 at 20:35:16, before the tag ever reached `origin`, and with it the class of
"remote tag names a commit `main` never had" — the one finding the repository still carries at this snapshot.

The second change, if there is a second: run `verify-version-tags --ref <pushed sha>` on a base push beside
`land.mjs --check`. It costs 9.8 s, it is the only automatic reading the anchor would ever get, and it would
have caught incident 2 before the next reader did.

Neither change touches the number's scale, the bump's judgement, or the landing order. They make the two
existing tools run where the failures actually happen.

## 8. Evidence

All commands were run in this worktree at `603617b` unless a ref is named. No tag was created, moved or
deleted; `git diff -- package.json CHANGELOG.md` is empty; `git status --porcelain` was empty before this
document's commit.

Snapshot (2026-11-05 21:46:02 -0500):

```
origin/main 1c68bf6  "version": "1.32.4"
v1.30.4  tag=b428452 commit=3db5e28 tagger=2026-11-05 20:28:08  onMain=yes
v1.32.1  tag=b3ebd9e commit=39d2e52 tagger=2026-11-05 20:35:16  onMain=no
v1.32.2  tag=61fef02 commit=e0ef3ef tagger=2026-11-05 21:17:33  onMain=no
v1.33.0  tag=da58824 commit=28c2853 tagger=2026-11-05 21:25:20  onMain=no
v1.33.1  tag=9b645d5 commit=d7df0d3 tagger=2026-11-05 21:45:24  onMain=no
```

The gate at `origin/main` is the FAIL quoted in 5.1 (335 bumps, 1 `wrong-commit`, 7 held).

Tests:

```
$ node --test test/release-tags.test.js
ℹ tests 15  ℹ pass 15  ℹ fail 0
$ node --test test/version-tags.test.js
ℹ tests 8   ℹ pass 8   ℹ fail 0
$ node --test test/version-check.test.js
ℹ tests 2   ℹ pass 2   ℹ fail 0
```

Timings measured in this worktree:

```
node tools/verify-version-tags.mjs --ref origin/main   9.8 s
node tools/version.mjs check                           7.1 s
node tools/changelog.mjs --check                       2 m 50 s
```

The tag-push dry run in 1.1 exited 0 with no `pre-push` line, and the parse at `.githooks/pre-push:49-60` is
the reason a tag-only push never reaches a check: every line is skipped, no commit is counted, the hook returns
before `check`.

The one command this document's own push met is `node tools/version.mjs check`, and the reading is worth
quoting because it shows the behind case winning over the docs case:

```
$ node tools/version.mjs check
version check: refused — this branch's version is behind origin/main's

  branch  1.32.1  (HEAD's package.json)
  base    origin/main  1.32.4  (1c68bf6)

  commits this branch adds:
    1afd9f70  patch docs: what the four version gates refuse, and the one command each i

  the tool would suggest: patch  (advice — the level is the landing agent's judgement)

  a branch cut before origin/main moved still carries the number it was cut at, so "unchanged" is not a bump:
  origin/main already reads 1.32.4, and landing this branch would carry a number main has passed. Merge or
  rebase origin/main into this branch, then bump above 1.32.4 in this PR:

    node tools/version.mjs apply patch
...
(exit 1)
```

The disposition is the one `docs/versioning.md` names for a record that spends no number:
`git push --no-verify`, with this refusal quoted rather than the bypass left silent. Note what the gate did
**not** say: with the base four bumps ahead, the docs-only case never got its own sentence — the behind
refusal is the one the worker sees, and it prescribes a patch bump that would spend a number this record must
not spend. That is incident 5 and incident 4 arriving together, and it is why the docs-only exemption has to
come before the behind comparison in the hook, not after it.
