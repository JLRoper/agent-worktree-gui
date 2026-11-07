# B - Version tags: every anchor, where it points, and what can and cannot see it

> Consolidated 2026-11-07 from the research-only worktree `lane-b-tags-hyper-deep-r-061613`
> (branch `wtgui/lane-b-tags-hyper-deep-r-061613`, commit `603617b`), where it was an uncommitted
> file at `docs/research/version-integrity/B-tags.md`. The text below is that file verbatim; only this
> header is new. It is a measurement record of 2026-11-06T03:25:57Z against `origin/main` at
> `cf5bf58` (1.34.0), kept because main has no copy of it: the version-integrity sweep on main
> carries lanes A and C-H but not this one. The tree it came from was released after this copy
> was proved byte-identical.


Lane B of the version-integrity sweep. **Read-only**: no tag was created, moved, retargeted or deleted, and
nothing was pushed. Every command below is a read; the only network call is `git fetch --no-tags origin main`.

- measured ref: `origin/main` = `cf5bf582a1eff4125333bf56e80e8a464f67009d` — `package.json` **`1.34.0`** at 337 versions
- this landing branch's HEAD: `603617b`, cut from an older main
- **snapshot instant: 2026-11-06T03:25:57Z** — every count in this document is that instant, because the tag set moved under
  the run (§0)

## 0. The tag set is a live object, not a constant

This was measured in a clone shared by a dozen landing worktrees, and tags are repo-global: every lane that bumps
creates a tag in the same object database. The set changed on every read, over the hour this took:

| when | what changed |
|---|---|
| first read (~01:55Z) | main at `f6f0c2f` (`v1.32.1`); 5 tags naming numbers main never carried |
| +10 min | `v1.32.2` re-created on a rebased branch; `v1.32.3` created |
| +15 min | `v1.33.0` moved to a **different lane's** branch (§3a) |
| +25 min | `v1.32.4` created, then re-created; **main landed it** (`f61739f9`, `v1.32.4`) |
| +35 min | `v1.33.1` created; lanes queueing on `1.32.5`, `1.32.6`, `1.33.2` |
| +40 min | `v1.32.2` deleted after its lane renumbered to `1.32.6`; the `1.33.0` pair resolved by the second lane moving to `1.33.2` (§3a) |

Two consequences, both visible below. "How many tags are there" is a timestamp, not a fact — a document that
quotes a count without one is wrong by default. And **the walk's end point moved too**: main went from `v1.32.1`
to `1.34.0` while this was being written, so every number a lane spent inside that window and did not land
is skipped, and its tag can never be correct.

At the snapshot instant: **346 tags, all annotated; 340 published; 336 anchored correctly;
1 published anchor pointing off main; 9 names for versions main never carried (4 dead,
5 held by live lanes); 0 missing; 0 lightweight; 0 backwards.** Plus 220
superseded or deleted tag objects still in the object database — the debris of 163 re-anchors and
54 deletions, invisible to every gate.

## 1. The tag set

Measured with `git for-each-ref --format='%(refname:short) %(objecttype) %(objectname) %(*objectname)' refs/tags`
and `git ls-remote --tags origin`. Every published tag contributes two remote refs (`vX` and `vX^{}`), and a peel
line on every one of them means every published tag is annotated on the remote too.

| measure | value |
|---|---|
| tags in the clone | 346 |
| annotated (`%(objecttype)` = `tag`) | 346 |
| lightweight | 0 |
| published on `origin` | 340 |
| local-only (never pushed) | 6 |
| published tags whose local and remote peels disagree | 0 |
| versions in `package.json`'s history at `origin/main` | 337 (`v0.1.0` .. `v1.34.0`) |
| versions tagged at the commit that first declared them | 336 |
| versions with no tag at all | 0 |
| versions whose tag points elsewhere | 1 |
| tag names for a version main never carried | 9 |
| superseded/deleted tag objects in the object database | 220 |

"Annotated" is not "well-formed": **7 tags carry only the subject line** — `v0.85.1`, `v0.85.2`, `v0.93.0`,
`v0.93.1`, `v0.109.0`, `v0.114.0`, `v1.8.0` — and all seven pass every gate, because `annotated` is the only
message test there is (`tools/verify-version-tags.mjs:86-95`). Every tag's message, where it names a sha, names
its own target (0 self-contradicting).

## 2. The one published anchor that points off main: `v1.32.1`

```
tag object  b3ebd9e0297f010f4f7e9556e39b9112de8d93f2   (live; what origin publishes)
  -> commit 39d2e523af3055ec456fde90f1a8029e12d2df16   chore: 1.32.1 — the version this landing carries
                                                       NOT an ancestor of origin/main
main's anchor for the same number:
  -> commit 946578704c0cae579ba25eed91ca74bb50164be6   chore: 1.32.1 — the version this landing carries
                                                       parent 603617b; origin/main's first declaration
```

`39d2e523` is the tip of `wtgui/untrack-config-json-land-8e3f5a`, whose PR **#460 merged**: `git cherry -v
origin/main wtgui/untrack-config-json-land-8e3f5a` prints `-` for both of its commits, so they are
patch-equivalent to what main carries under new shas. The worktree still sits on that pre-merge tip
(`git worktree list`), which is normal — the branch is the record of what was reviewed; the tag should not be
there.

**A second tag object for the same name exists and is unreachable:**

| object | names | tagger date |
|---|---|---|
| `b3ebd9e0297f010f4f7e9556e39b9112de8d93f2` | `39d2e523` (off main) | 2026-11-06T01:35:16Z |
| `0a0077b5bb6ae592a589245d0593df612d3e6ab6` | `94657870` (main's commit) | 2026-11-06T01:38:28Z |

The correct object is the **later** one. The loose ref file `.git/refs/tags/v1.32.1` was written at 20:44:03.046
local (01:44:03Z) — the same second as `.git/refs/tags/v1.30.4` and `v1.31.0`, i.e. three tag refs rewritten in
one operation, which is what a forced tag fetch does (`git fetch --tags --force` rewrites each ref whose value
differs), or an equivalent bulk ref write. So the sequence the object database shows is: the branch anchor was
published; a correct object naming main's commit was created three minutes later; a bulk ref write six minutes
after that put the published value back; nothing pushed the correction. **The bulk-write mechanism is
inference** — what is measured is the two objects, their targets, their dates and the three ref mtimes.
`git ls-remote --tags origin v1.32.1` today returns `b3ebd9e0…` and `^{}39d2e523af…`, so the bad value is what
every clone gets.

Two things make this instance legible without the gate:

- **the tag's own message contradicts main.** It reads `package.json first carried 1.32.1 at 39d2e523af` — true
  about the branch, false about main. Of every tag whose message names a version main carries, all but this one
  name main's true first appearance (§1).
- **its commit is reachable only from a merged branch**: `git for-each-ref --contains 39d2e523` lists
  `wtgui/untrack-config-json-land-8e3f5a`, its `origin/` copy, and the tag itself.

Consequence for a reader: `git checkout v1.32.1` lands on a commit main does not have, `git describe` at main's
`94657870` refuses to name the version, and the changelog's `v1.32.1` section links main's sha while the tag names
the other one. This is precisely the rule in `docs/versioning.md:22-31` — the tag is made on the branch and moved
after the merge — with the move skipped or undone.

## 3. Tags naming a number main never carried

`published` is what `git ls-remote --tags origin vX` answers: `no` means the tag exists only in this clone.
"Target" is the peeled commit; "reachable from" is `git for-each-ref --contains <peel>` with remote-tracking refs
and the tag itself removed.

| tag | tag object | target | published | reachable from | verdict |
|---|---|---|---|---|---|
| `v1.8.3` | `b496c9ab07db` | `ea16b282d35cb8f9bcd80c7a7f1872cf061c8ea8` | no | nothing (tag only) | dead number |
| `v1.23.1` | `d52641175bb8` | `988d8494f5a6f173ae2e6303ab26581775c8849d` | no | nothing (tag only) | dead number |
| `v1.27.2` | `d6173e111bbd` | `6411577947e8d9c50f53d197a3607de010113e03` | no | nothing (tag only) | dead number |
| `v1.32.3` | `c47afa1f7238` | `ea15bb1de2cba3740f01929f8ca3951766576c58` | no | `wtgui/make-optym-integration-m-b580a2` (tip) | live-lane anchor |
| `v1.32.5` | `4b18f1baddf2` | `c777f5d6e15df6ac6de23999970bffcb43f569f8` | yes | `wtgui/deep-dive-why-some-assis-e8cb2e` (tip) | live-lane anchor |
| `v1.32.7` | `10b5bc8c54c6` | `68e6a5e5c90ba1bb0876af509151a9d52bd85e8b` | yes | `wtgui/a-repair-turn-must-not-c-aa2953` (tip) | live-lane anchor |
| `v1.33.0` | `8acc2855f7a0` | `e52a88c0873cdecdeb8abbc820f37dbad33729a1` | no | nothing (tag only) | dead number |
| `v1.33.2` | `e26c6d1585d1` | `2cb4ddc13e6d593eb30655ae159594a4aba40951` | yes | `wtgui/let-each-assistant-be-re-b279a4` (tip) | live-lane anchor |
| `v1.35.0` | `4b174d302f6f` | `f74f61f647867021528d41cbe9bbb7aef40408c9` | no | `wtgui/hold-a-pipeline-row-on-i-04c7d1` (tip) | live-lane anchor |

**Published but held: `v1.32.5`, `v1.32.7`, `v1.33.2`.** Pushed to `origin` while the commit it names is not on main — the case the brief asks about directly. A published tag naming a number main does not carry is harmless only while the lane is unlanded: every clone now carries it, so the post-merge re-anchor becomes a force-push of a ref somebody else may already have fetched, and a clone that never re-fetches keeps the branch sha.

**Each live-lane tag sits on the commit that first declares its number on its own branch** — verified by walking
that branch's `package.json` history (`readReleaseHistory` at the ref), not by reading the tip's file. Some are
`chore:` bump commits; others carry the bump inside a feature commit. These are the normal pre-landing anchors
`docs/versioning.md:16-19` calls *held*; each must be re-anchored after its merge or it becomes §2.

**Any held tag whose number is below main's tip can never become main's anchor.** Main's walk went
`1.32.1 → 1.34.0` during the run, so a lane still sitting on a number inside that window has to re-bump above
main's tip before it can land, and when it does the old tag anchors nothing. At the snapshot that is
`v1.32.3`, `v1.32.5`, `v1.32.7`, `v1.33.2`. `v1.32.2` was in that position earlier, and its tag was deleted once the lane renumbered to
`1.32.6` — the disposition §9 prescribes, applied by its owner.

**The dead numbers are mislabelled by the gate.** `verify-version-tags` prints them in its note as *"each at a
commit whose package.json declares it (held on a branch)"*. No branch holds `v1.8.3`, `v1.23.1`, `v1.27.2` or
`v1.33.0`, whose commit `e52a88c087` no ref reaches any more:
those commits are reachable from nothing but their own tag, and `git ls-remote` has never seen them. The gate's
test — does `package.json` **at the tagged commit** declare this version (`tools/release-history.mjs:132-140`) —
is satisfied by any commit whose tree reads that number, including one no ref reaches. Only
`git for-each-ref --contains` separates live from dead, and no gate runs it.

### 3a. Two lanes, one number: the `v1.33.0` collision (observed, then resolved)

At 02:20Z two unlanded lanes both declared `1.33.0`, and the tag moved between them:

| branch (state at 02:20Z) | tip | version at tip | tag at tip |
|---|---|---|---|
| `wtgui/let-each-assistant-be-re-b279a4` | `e52a88c087` | `1.33.0` | **none** |
| `wtgui/hold-a-pipeline-row-on-i-04c7d1` | `28c28536e1` | `1.33.0` | `v1.33.0` |

The tag was first created on the first branch (`e52a88c087`) and by the last read resolved to the second
(`28c28536e1`). Both are unlanded (`git cherry -v origin/main` prints `+`), so nothing has landed wrongly yet —
but the first lane's history now has a version whose name another branch holds, and whichever merges second will
either steal the tag with `--force` or land a release with no anchor. The gate says it plainly on each branch,
and not at all on main:

```
$ node tools/verify-version-tags.mjs --ref wtgui/let-each-assistant-be-re-b279a4
  wrong-commit v1.33.0 points at 28c28536e1, but 1.33.0 first appeared at e52a88c087

$ node tools/verify-version-tags.mjs --ref origin/main
  … name a version origin/main does not carry yet … (held on a branch)
```

Same tag, same shas: a failure on the branch that owns the number, a reassuring note on main. That asymmetry is
blind spot 2 in §7, with a live instance.

By the end of the run the first lane had renumbered to `1.33.2` and created `v1.33.2` for itself, so the
collision closed the way §9 prescribes — one of the two numbers moved. The hazard is general, not this pair's:
tag names are repo-global while version numbers are chosen per lane, so two lanes can spend the same number and
only the last `--force` decides who holds it.

## 4. The brief's premises, corrected

The brief named four tags to check; measurement disagrees with three.

| brief said | measured | what the sha actually is |
|---|---|---|
| remote `v1.32.1` peels to `39d2e523`, not on main | **true** | §2; the tag object is `b3ebd9e0`, the commit `39d2e523` |
| `v1.30.4` on `83463d4` | **false** | `v1.30.4` peels to `3db5e284b2c39385bb05e6675f92b5f9f39f08b3`, on main, correct. `83463d4afc` was the tip of `wtgui/make-optym-integration-m-b580a2` at the first read (PR #454 merged, `git cherry` printed `-`) — an untagged twin of the same bump. That branch was then rebased and bumped onward, leaving `83463d4` unreachable. Either way it was a branch commit, never a tag target |
| `v1.31.0` on `0af857bd` | **false** | `v1.31.0` peels to `15c10407750d56987d7533f602cbb8c2ad62d502`, on main, correct. `0af857bd3f` is a commit **no ref contains** (dangling after a rewrite) that carries a `1.31.0` bump and no tag |
| orphans `v1.8.3`/`v1.23.1`/`v1.27.1`/`v1.28.0` | **two of four wrong** | `v1.8.3` and `v1.23.1` are dead numbers (§3). `v1.27.1` (`f67ce5c7` → `dfae827e8a`) and `v1.28.0` (`54d1d260` → `600fbc4640`) are both on main, tagged at their own bump commits, no finding. The third dead number is **`v1.27.2`** (`6411577947e8d9c50f53d197a3607de010113e03`), not `v1.27.1` |

`git cat-file -t` on every sha above returns `commit`. The two "mystery" shas are real commits with the expected
subjects, which is how a branch tip and a dangling twin get mistaken for tag targets — the same confusion, in
reverse, that §2's tag encodes.

## 5. How tags get here: creation, moves, deletions

**Creation** is `node tools/version.mjs apply <level>` on a clean tree: it writes the number, commits it as
`chore: <version> — the version this landing carries`, and creates the annotated tag on that commit
(`tools/version.mjs:474-533`); a dirty tree gets the number and neither commit nor tag. `version.mjs tag [--ref
<ref>] [--force]` creates or moves one, `version.mjs backfill [--push]` fills gaps idempotently — the rules and
their reasons are `docs/versioning.md:12-42`. Every tag in the clone fits that shape: annotated, on a bump commit,
message naming the number and its declaration.

**Moves leave no reflog.** Tags have no reflog, so the only record of a re-anchored tag is its orphaned tag
object. `git fsck --unreachable --no-reflogs` finds them here:

| what the unreachable tag object is | objects | distinct tag names |
|---|---|---|
| superseded anchor — the name now points at another commit | 163 | 108 |
| re-created with the same target (message or date only) | 3 | 3 |
| deleted tag — no live ref of that name | 54 | 28 |
| **total unreachable tag objects** | **220** | — |

Of the 163 superseded objects, 8 name a commit **inside main's history** — an earlier anchor
that was on main but at the wrong commit, later corrected (`v1.0.1`, `v1.1.0`, `v1.3.0`, `v1.5.0`, `v1.5.5`,
`v0.106.2`, and `v1.32.1`). Six went from one on-main commit to another; `v1.32.1` went the other way, from
main's commit to a branch sha (§2). The rest went from a branch sha onto main's — the post-merge re-anchor working
as designed, a hundred-odd times, plus the lane churn of §0.

**Deletions are clean.** All 28 deleted names are version numbers main never carried:

```
`v0.96.0`, `v0.97.0`, `v0.105.1`, `v0.107.0`, `v0.111.4`, `v0.112.0`, `v0.113.1`, `v1.0.2`, `v1.2.1`, `v1.3.1`, `v1.5.1`, `v1.5.3`, `v1.6.2`, `v1.10.1`, `v1.14.0`, `v1.16.1`, `v1.16.3`, `v1.20.2`, `v1.21.2`, `v1.25.0`, `v1.26.1`, `v1.28.4`, `v1.29.1`, `v1.29.2`, `v1.29.3`, `v1.30.1`, `v1.32.2`, `v1.33.1`
```

None of the 54 deleted objects pointed at a commit on main, and none of those numbers appears in main's
bump walk — so no landed anchor has ever been deleted. That is the disposition `docs/versioning.md:19-20` calls
for a number that never landed, applied consistently.

The debris is harmless and stays until gc prunes it, but it is the only place a *move* is recorded: nothing else
in the repository says a tag was ever somewhere else.

## 6. Missing tags: none, and what one would look like

337 versions, 336 correctly anchored, 1 anchored elsewhere, 0 missing — the
`missing` finding has nothing to report at `origin/main`, and neither does the branch HEAD. That is worth stating
because "every bump is tagged" is the property the whole scheme rests on, and it is currently true. It is also
fragile in a specific way: main's walk jumped `1.32.1 → 1.32.4 → 1.34.0` during this run, and lanes spent
`1.32.2`, `1.32.3` and `1.32.5` without landing. The tags for those numbers sit outside the walk — `v1.32.2` was
deleted and `v1.32.5` is still published — which is a gap the gate reports as nothing at all.

Two things the gate does **not** treat as missing, both present here:

- **a number skipped entirely.** Main's patch sequence jumps `1.0.1 → 1.0.3`, `1.5.0 → 1.5.2`, `1.5.2 → 1.5.4`,
  `1.8.2 → 1.8.4`, `1.16.0 → 1.16.2`, `1.23.0 → 1.23.2`, `1.30.0 → 1.30.2`, `1.27.1 → 1.28.0`, `1.32.1 → 1.32.4`
  and `1.32.4 → 1.34.0`. Nine same-minor gaps plus the minor-boundary ones (`1.27.2`, and the lanes that
  spent `1.32.2`/`1.32.3`/`1.32.5` without landing). A gap is not a finding: `release-history.mjs` walks the
  commits that wrote the line, and a number never written has no commit to be missing a tag from.
- **a tag name the parser does not recognise.** `VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/`
  (`release-history.mjs:21`) and the `.filter((t) => t.version …)` at `:159` drop anything else before it is
  judged: `v1.33`, `v1.32.1-rc1`, `release-1.2.3` would be invisible — neither anchored, nor held, nor an orphan.

## 7. `tools/verify-version-tags.mjs` — what it catches, what it cannot

```
$ node tools/verify-version-tags.mjs --ref cf5bf582a1ef   # the snapshot commit
version-tags: 337 version bumps in package.json's history (v0.1.0 .. v1.34.0), 336 tagged and annotated at the commit that first declared them
  9 tags name a version cf5bf582a1eff4125333bf56e80e8a464f67009d does not carry yet, each at a commit whose package.json declares it (held on a branch): v1.23.1@988d8494, v1.27.2@64115779, v1.32.3@ea15bb1d, v1.32.5@c777f5d6, v1.32.7@68e6a5e5, v1.33.0@e52a88c0, and 3 more
  wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1 first appeared at 946578704c

FAIL — 1 finding across 337 version bumps
(exit 1)
```

The gate's own held count (9) matches §1's table.

**Catches** (all as failures, in `checkReleaseTags`, `tools/verify-version-tags.mjs:37-105`):

- `missing` — a version in the walked history with no `v<version>` tag at all (`:55-64`).
- `wrong-commit` — the tag exists and resolves to another commit (`:65-72`). The finding that names `v1.32.1`,
  and the only one this repository currently produces at main.
- `lightweight` — right commit, no message (`:73-80`), including for a held tag that does declare its number
  (`:86-94`).
- `orphan-tag` — a version tag whose **own commit's** `package.json` does not declare it (`:97-102`).
- `backwards` — a version line that decreases along the walk (`:40-54`).
- **a vacuous pass is impossible**: an empty walk exits **2**, not 0 (`:145-148`). A gate that certifies nothing
  cannot print PASS.
- `--ref` judges another ref, which matters here: the branch is cut behind main and the default walk is the
  branch's (`readReleaseHistory({ref: 'HEAD'})`, `:136`). Both readings agree today because the only commit
  between HEAD and main is a changelog render — but §3a shows how far apart a branch reading and main's can be.

**Cannot catch, with the instance that proves it:**

1. **The remote.** `readTags` reads `refs/tags` in the local clone (`release-history.mjs:112-126`); nothing calls
   `ls-remote`. A tag that differs between clone and remote, or exists only on one side, is invisible, and a PASS
   is a statement about this clone. (Here all 340 published tags agree, so `v1.32.1` is caught only because
   the clone happens to hold the published value.)
2. **Held vs dead.** The `declares` test asks the *tagged commit's tree*, not the ref graph. Measured: 4 of
   the 9 tags printed as "held on a branch" are held by no branch at all (§3). A live lane's pre-landing
   anchor and an abandoned number get the same sentence.
3. **A held tag at the wrong commit.** For a version the ref does not carry, only `annotated` is checked
   (`:86-95`); `wrong-commit` is never evaluated. A tag for a branch-held version can sit on any commit whose tree
   declares the number — including one after the bump and before a render — and pass. §3a is the same hole from
   the other side: the branch that owns the number fails, main says it is merely held.
4. **The message.** `annotated` is the only test. The seven subject-only tags in §1 pass; so would
   `git tag -a vX -m "x"`.
5. **Names the parser rejects.** §6: a malformed tag is dropped before any check.
6. **Movement history.** 220 superseded objects, 163 re-anchors, invisible (§5). Nothing records
   that a tag was ever at another sha.
7. **Skipped numbers.** §6: a gap in the sequence is not a finding.
8. **Reachability of the target.** No check that the tagged commit is reachable from a branch; the `declares` test
   is all that stands between a dead number and a PASS-shaped note.
9. **It is not on the push path.** `.githooks/pre-push` runs `node tools/version.mjs check` and, for a base push,
   `node tools/land.mjs --check`; `grep -n "verify-version-tags" .githooks/pre-push` returns nothing. Nothing
   refuses a landing whose tag is mis-anchored — the tag gate is `npm run verify:version-tags`, run by hand. That
   is how `v1.32.1` reached the remote and stayed.

## 8. `test/release-tags.test.js` — what it pins, what it cannot

```
$ node --test test/release-tags.test.js
ℹ tests 15   ℹ pass 15   ℹ fail 0
```

**Pins** the pure functions: the walk's first-appearance rule (a later edit of `package.json` is not a bump; a
re-written number keeps its first commit), tag-name parsing and numeric ordering (`v0.9.0 < v0.84.0`), the
changelog's grouping/order/links/`--since`, and every finding of `checkReleaseTags` — pass, all four kinds,
held-is-not-a-finding, held-lightweight-is, orphan when the commit does not declare, wrong-commit for a landed
version, backwards.

**Cannot catch: the git half is untested.** Nothing in the suite imports or executes `readVersionHistory`,
`readTags`, `readVersionAtCommit`, `readReleaseHistory` or `findDeclaration`. The peel (`%(objectname)` vs
`%(*objectname)`), the `objecttype === "tag"` annotated test and the tag-name→version map are therefore unverified
— a regression that compared a tag **object** sha with a commit (the mistake the gate's own header warns about at
`verify-version-tags.mjs:12-14`) would pass all 15 tests. The CLI half is untested too: `--ref`, `--json`,
`--limit`, exits 0/1/2, the held note's wording, the empty-walk exit 2.

The one test that looks like it covers the held/orphan split (`release-tags.test.js:140-151`) hands
`checkReleaseTags` a `declares: true` it never computes. `readVersionAtCommit` — exactly what turns a dead tag into
"held" — is the untested part that produces finding 2 above.

The file's header is also stale: it says the live walk "is run by hand against this repo's own **205** tags"
(`release-tags.test.js:8`). There are now 346 tags and 337 versions. The manual half of the
proof is unrecorded, which is why the number rotted unnoticed.

## 9. Dispositions — none of them executed here

Read-only lane: these are recommendations, not a record of anything run. No bump is involved in any of them; tags
spend no version.

**`v1.32.1` — move it onto main's commit.** Its old target's branch is merged and no live row owns `39d2e523`.
This is the `docs/versioning.md:27-31` pair:

```
node tools/version.mjs tag --ref origin/main --force
git push origin v1.32.1 --force
```

Prove it with `git ls-remote --tags origin v1.32.1` (the `^{}` value must be `946578704c…`) and
`node tools/verify-version-tags.mjs --ref origin/main` printing `PASS`. **Push immediately after the move** — a
`git fetch --tags --force` from a remote still holding the old value puts it right back (§2).

**`v1.8.3`, `v1.23.1`, `v1.27.2` — delete them.** Dead numbers, tag-only targets, local refs:
`git tag -d v1.8.3 v1.23.1 v1.27.2`. No remote delete is possible or needed — `git push origin :refs/tags/v1.8.3`
would fail `remote ref does not exist`; quote the empty `git ls-remote` instead. The objects stay unreachable
until gc, which is normal.

**A held tag numbered below main's tip — renumber, then delete.** At the snapshot that is `v1.32.3`, `v1.32.5`, `v1.32.7`, `v1.33.2`. Main
skipped `1.32.2`, `1.32.3` and `1.32.5`; `v1.32.2`'s lane re-bumped to `1.32.6` and the old tag was deleted,
which is the pattern. The rule for any such tag: re-bump above main's number, then `git tag -d`. Do not move the
tag onto the new bump — the new bump declares a different number, so the tag name would be a lie by definition.
A published one (`v1.32.5` at this snapshot) needs `git push origin :refs/tags/<name>` as well, once its lane has
moved; that is the one deletion that cannot be done locally only.

**The live-lane tags in §3 — leave them; they belong to lanes in flight.** Each is a correct pre-landing anchor
for its own branch right now, and each becomes the next §2 if its landing skips the post-merge move. Numbers are
being claimed faster than they land, so expect the set to look different by the time anyone reads this: re-read
§10 rather than trusting these names.

**Nothing to do about the 220 superseded objects or the 28 deleted names** beyond this record:
they are already unreachable and no gate reads them.

## 10. Re-running this measurement

```
git fetch --no-tags origin main
git for-each-ref --sort=version:refname --format='%(refname:short) %(objecttype) %(objectname) %(*objectname)' refs/tags
git ls-remote --tags origin
node tools/verify-version-tags.mjs --ref origin/main
git fsck --unreachable --no-reflogs | grep 'unreachable tag' | wc -l
git for-each-ref --contains <a suspect sha> --format='%(refname:short)'   # live branch vs dead number
```

Two cautions for whoever runs it. `git ls-remote` counts every annotated tag twice (`vX` and `vX^{}`), so the
ref count is twice the tag count, not the tag count. And `git rev-parse vX` answers the **tag object's** sha, not
the commit — the anchor is `git rev-parse vX^{commit}` or the peeled column, which is why §2's reading has to
state the peel. And because tags are repo-global in a shared clone, take the reads close together and stamp the
result: §0 is what happens when you do not.

## Appendix A — every tag, its object, its commit, and its state

Peel = the commit the annotated tag names. `on main` = that commit is an ancestor of `origin/main` at
`cf5bf582a1ef`. `state`: `ok` (version on main, anchored there), `wrong-commit` (§2), `live-lane` (§3, held by a
branch), `dead-number` (§3, held by nothing). Snapshot 2026-11-06T03:25:57Z.

```
v0.1.0     2cbf0d58974f 0d3d3a89179e yes   yes ok
v0.2.0     66d827859461 861652ed0058 yes   yes ok
v0.3.0     a5a0411499f9 c60805d9d8c6 yes   yes ok
v0.4.0     771912d78c3b 3470b18b48f2 yes   yes ok
v0.5.0     65816c7d9d38 4480cf2c0a11 yes   yes ok
v0.6.0     fc78be7a88d9 8ebc0f5d7bba yes   yes ok
v0.7.0     6c32df25b8d1 78e2145aabd0 yes   yes ok
v0.7.1     4217fbd15e58 e8acc2725759 yes   yes ok
v0.8.0     c2fa2faf081a 0c8bba6e9851 yes   yes ok
v0.8.1     19c2ba429996 8b4b1f027787 yes   yes ok
v0.9.0     ff89017c592f 999289ad76be yes   yes ok
v0.10.0    1e4de8996030 5697d083c38a yes   yes ok
v0.10.1    605a490144e1 4410d38a8e53 yes   yes ok
v0.10.2    5ea12a81e0a9 df5905e89614 yes   yes ok
v0.10.3    53f96e69f07d 27da6be27e3e yes   yes ok
v0.11.0    3cba59391f24 814755b3fba9 yes   yes ok
v0.11.1    1f002b0e19f5 f27a5b1dbb5b yes   yes ok
v0.11.2    987aa53a5d1e d8ae7539e3a0 yes   yes ok
v0.12.0    1a1bbcaf6972 692c36295a2b yes   yes ok
v0.12.1    b65f31067b9a c0b46d22068c yes   yes ok
v0.13.0    cefcda7ba5d3 1a24139c1068 yes   yes ok
v0.14.0    422b5471d0a6 30a51bb94da2 yes   yes ok
v0.15.0    83c9b494767d df7513e2c8d2 yes   yes ok
v0.15.1    c33f49f080d7 2bda56854d43 yes   yes ok
v0.16.0    17cbe335d907 7ebf0774ca34 yes   yes ok
v0.17.0    375920738c2e b3964811fbef yes   yes ok
v0.18.0    df1ca69f9e4a 81496d916291 yes   yes ok
v0.19.0    50071f6ccb5e 3958b373fbef yes   yes ok
v0.19.1    f274eca8bb0d d4318598ae6f yes   yes ok
v0.20.0    983d6931ee66 9fa7bb1d1db9 yes   yes ok
v0.21.0    33415b0eab17 24d61aa9e95e yes   yes ok
v0.22.0    aa731a14f847 fdc13c40b413 yes   yes ok
v0.23.0    173b523abf75 6842c67c5d8b yes   yes ok
v0.24.0    04054997c9d4 68864f3a5531 yes   yes ok
v0.24.1    5c361c10e80f 2a9e231d2b4d yes   yes ok
v0.24.2    1efec86df5c4 7c3d8cce2400 yes   yes ok
v0.25.0    e0de02149f86 aea5b9bee77a yes   yes ok
v0.26.0    0605405382cb b6c7c677f4a7 yes   yes ok
v0.27.0    d94858a0a044 4b7c1c1ef587 yes   yes ok
v0.28.0    43df30b0d17f 4916b6e8cd76 yes   yes ok
v0.29.0    f66f3295e737 dad67fc7cd16 yes   yes ok
v0.30.0    bb1443db8fca 2db77ec3ef1a yes   yes ok
v0.30.1    5a298c9a1ad0 6e074ee4c3f0 yes   yes ok
v0.30.2    8aa6d066b62c 1c4e5732b14e yes   yes ok
v0.31.0    1cdf73ee7c1e f406a942270c yes   yes ok
v0.32.0    aec8ad218575 999706a223a2 yes   yes ok
v0.32.1    19736aeebea2 1cd8616a07b9 yes   yes ok
v0.32.2    69c816324ac9 6b8724a53039 yes   yes ok
v0.32.3    6c88f93c1962 60e3c5aced31 yes   yes ok
v0.32.4    273975ee5e56 5528137f3bbd yes   yes ok
v0.32.5    689d38806fbf 6ccf004aaf2c yes   yes ok
v0.32.6    dda6a2ba13bd e1bdb0e32f24 yes   yes ok
v0.32.7    718358cf52d9 1b79deba8c25 yes   yes ok
v0.33.0    34f2508f11a9 e5722e6f91c0 yes   yes ok
v0.33.1    fd563dd39b12 918b44c69de5 yes   yes ok
v0.33.2    73a95531b456 bb838f0405a3 yes   yes ok
v0.34.0    54c40fee4ecd 4ad107f2c070 yes   yes ok
v0.34.1    d9e396098d31 31bda32927d5 yes   yes ok
v0.34.2    6c82c5336d9f a53aabad7163 yes   yes ok
v0.34.3    e4d77bff3ba7 f56691ad96a3 yes   yes ok
v0.34.4    3274209a8120 f98a82b0527d yes   yes ok
v0.35.0    861774416f0e ac2ea8a9e53a yes   yes ok
v0.35.1    3b00b8ccb40f dfdf0550722d yes   yes ok
v0.35.2    f3fcd7560e37 81943dff0b1c yes   yes ok
v0.36.0    c6544c96ea0d d1aa72a21f7c yes   yes ok
v0.36.1    3ecc610cf4bb 7090c01c405f yes   yes ok
v0.37.0    1a9ada8cbbf1 84ca277c051c yes   yes ok
v0.37.1    6af2315feec4 d48e23076c3c yes   yes ok
v0.38.0    450984849512 244224713da4 yes   yes ok
v0.38.1    c574723b2f17 81fd8053f791 yes   yes ok
v0.39.0    37f7b1584842 9689b51e55d1 yes   yes ok
v0.39.1    74a7cfffdbea 4194b3f851fd yes   yes ok
v0.40.0    61af39efeb79 df0048a97b84 yes   yes ok
v0.40.1    885264a3b108 f4098b0934a5 yes   yes ok
v0.41.0    57929fb6192a 0e391af5acb3 yes   yes ok
v0.41.1    1d844ebb8960 d0f83e585ae0 yes   yes ok
v0.42.0    12850f32f8c5 6dcf1baebddd yes   yes ok
v0.43.0    d876419d9079 6d1c9c02734a yes   yes ok
v0.44.0    f3a2ddd3ff7d 768c5cc93a1b yes   yes ok
v0.44.1    c2de5d01b61c 68d96e6d248b yes   yes ok
v0.45.0    69fc000c2c1d 29d2a0b874b8 yes   yes ok
v0.46.0    815e77df7b8a 0581afdd5dfe yes   yes ok
v0.46.1    b62443d240da b499c61a598f yes   yes ok
v0.46.2    babc78c9645d a0b0026e9096 yes   yes ok
v0.46.3    61b513aaf6df 52937608ca29 yes   yes ok
v0.46.4    29935281fa6e 21aa5361e343 yes   yes ok
v0.46.5    5f578e4aad89 788a7a8f72cd yes   yes ok
v0.46.6    8a1f1e033c36 4ea03f7d617b yes   yes ok
v0.46.7    6a3ef5287f95 b1c5bd294a6a yes   yes ok
v0.46.8    9b290b4c944d c4a009358959 yes   yes ok
v0.47.0    1453d622b316 e237d6e8c739 yes   yes ok
v0.47.1    3061ea88427a 56aa66d194d3 yes   yes ok
v0.47.2    a32fc8032f40 4d7bcf37401d yes   yes ok
v0.48.0    a19130c1c336 9808fec2e5c2 yes   yes ok
v0.48.1    70a7f3e5f95e f4ebe34781dc yes   yes ok
v0.48.2    22c7f07132b8 dbcc0058338e yes   yes ok
v0.48.3    1da24c9805ca 8e7c01e9b601 yes   yes ok
v0.48.4    a2d65e0e1dbe 7e7879a8bb3c yes   yes ok
v0.49.0    e6f4668dcfa0 554d1cd6164e yes   yes ok
v0.49.1    b5ede8438bef e69b6be68876 yes   yes ok
v0.49.2    a342685ca93b 7d451764f35e yes   yes ok
v0.49.3    dad905516d8a c063405f9482 yes   yes ok
v0.50.0    0e7c498eec2e 8237843e9fc8 yes   yes ok
v0.50.1    cee0cc933ef4 ae3d9c148f2c yes   yes ok
v0.50.2    dcdbfe884c7d 2d80df080c79 yes   yes ok
v0.51.0    f5b3eb50ac58 65f1e8e050a2 yes   yes ok
v0.51.1    14c1089d834a 14c27c38a00a yes   yes ok
v0.51.2    72829203b866 66659c4be679 yes   yes ok
v0.51.3    9bd025c5419f 78d5cd7d326f yes   yes ok
v0.51.4    9cc12d85aa3d fb9e6ebd2d4b yes   yes ok
v0.52.0    01a253f3ac5a 635404b1dd21 yes   yes ok
v0.52.1    4f01140b079f 3d1706392b04 yes   yes ok
v0.52.2    c7e040d717ba e3177989e535 yes   yes ok
v0.53.0    a632084836da 935bfc42b6f1 yes   yes ok
v0.53.1    0d5504f4c6c4 23bdd104e7b8 yes   yes ok
v0.53.2    444e43fed992 622940f1ff17 yes   yes ok
v0.53.3    f3c63bb0a848 28bad77b9cf4 yes   yes ok
v0.53.4    1970a39122bd 71e188fcc736 yes   yes ok
v0.54.0    16474125474f 2a0a96ff2084 yes   yes ok
v0.55.0    50185f2bb9b3 75a89f466496 yes   yes ok
v0.56.0    3faf28738b28 c503b74de302 yes   yes ok
v0.56.1    e2bc65f64ce8 f94e286dfc19 yes   yes ok
v0.56.2    16f6a6f9d4b5 04db63ff2d8e yes   yes ok
v0.56.3    19086d368fb6 e92243b9ffdd yes   yes ok
v0.56.4    543b222e0d41 e08f9f01145d yes   yes ok
v0.56.5    25de3f10fd33 1a0fb98d937b yes   yes ok
v0.57.0    b7e2b14f05de 25b3ea39ce06 yes   yes ok
v0.57.1    ad1c25f7102d 29217b1e5ca5 yes   yes ok
v0.58.0    a5f1b12d4438 23cbac9b921b yes   yes ok
v0.58.1    6b85c5506966 e14e7b7b8e0e yes   yes ok
v0.58.2    1bd2628d580e 18b6a4f9696c yes   yes ok
v0.58.3    cc6df942bc3b 697881f042dc yes   yes ok
v0.59.0    f4ac84861bc4 df3b95dbd611 yes   yes ok
v0.60.0    96160469f01b 7a9959afa876 yes   yes ok
v0.60.1    f1d4565ea7d8 67659448166b yes   yes ok
v0.61.0    15790eb9b4ac 208979415263 yes   yes ok
v0.62.0    ecbe47408677 8aee64a53848 yes   yes ok
v0.62.1    ee7035f443a3 4294879ee752 yes   yes ok
v0.62.2    dc204bf35825 69d10e3c53ff yes   yes ok
v0.62.3    f5dd599eef29 b5fe7a0d06cf yes   yes ok
v0.63.0    b06a1a7a4b2c 9127b8ddbc25 yes   yes ok
v0.64.0    4767b92a43df 61a6403ac3ae yes   yes ok
v0.65.0    3d14a8d43e46 861328ccba1c yes   yes ok
v0.66.0    3963657e67e4 f7a2202af77b yes   yes ok
v0.66.1    453bb72dae3a b066acd9f80c yes   yes ok
v0.67.0    e83623a92698 68445de77f06 yes   yes ok
v0.67.1    de5a12e74498 ac66a3a648b1 yes   yes ok
v0.67.2    ff3495821923 b62ab179885b yes   yes ok
v0.67.3    f0c188107cc0 71201595d350 yes   yes ok
v0.67.4    3ba76be0aa7b b524da971b60 yes   yes ok
v0.67.5    ddf59a5f7315 804ed4e3bcef yes   yes ok
v0.67.6    065e3104efe7 d34794b5baf2 yes   yes ok
v0.68.0    b6356023d4e4 c879e303e8e4 yes   yes ok
v0.68.1    0c665964cee4 1cb87731dddc yes   yes ok
v0.68.2    53dd756c4559 e0ae8a42c879 yes   yes ok
v0.68.3    de6a4f63dd2d a0ecde3ca069 yes   yes ok
v0.68.4    516090f2f8b3 b4ee8132f0a6 yes   yes ok
v0.68.5    e229e8e9dcb4 5f110b8f9f4e yes   yes ok
v0.68.6    97babbc44fad 9d4e9b823f7c yes   yes ok
v0.68.7    5a5fa7af3295 5d58d213cc1e yes   yes ok
v0.68.8    15e9422a56ac 12f915e5f6d8 yes   yes ok
v0.68.9    e10211f27823 1036a381e8a1 yes   yes ok
v0.68.10   b770cd2179b9 cee444f4b4e1 yes   yes ok
v0.69.0    39ee32cc0741 c2f48aaa2e97 yes   yes ok
v0.69.1    92a7ef917963 8a2b170000f6 yes   yes ok
v0.69.2    07e3312c434c 07ae700e82c2 yes   yes ok
v0.69.3    003317bd2f9f 9b253cfa3923 yes   yes ok
v0.70.0    22c32192f266 a12c7375fdce yes   yes ok
v0.70.1    694cb8e0799f 01947d65cbe9 yes   yes ok
v0.70.2    1e710ea42752 b95995701ba6 yes   yes ok
v0.71.0    18c88bc0c233 c57001b832ca yes   yes ok
v0.71.1    2195adec6089 c8087f4fcd43 yes   yes ok
v0.71.2    fa9553a99f29 8eb2bf0f55ab yes   yes ok
v0.72.0    a25bb2fbac29 23b8b126aee2 yes   yes ok
v0.72.1    506cf89464dc 02f15c33e0b0 yes   yes ok
v0.72.2    cc757d0157b6 2d45d6cdb432 yes   yes ok
v0.72.3    df3ac0054f69 1a8efc05af04 yes   yes ok
v0.72.4    c8712870c262 2d24432d3a3f yes   yes ok
v0.72.5    9804f0e3dcf0 64f5339c4be3 yes   yes ok
v0.73.0    de0bda512bc9 178ce9b4b896 yes   yes ok
v0.73.1    55fe8644d8cc dfee4acb2a5c yes   yes ok
v0.73.2    3c4fb165f477 7d516d3bf223 yes   yes ok
v0.73.3    e8dbcd1d569b 9c15e576dc7e yes   yes ok
v0.73.4    a18184eaedc7 55a8e456b692 yes   yes ok
v0.73.5    7c9ad52862cd 5bd5425b2de4 yes   yes ok
v0.73.6    eddf8393244f e97291f71221 yes   yes ok
v0.73.7    f2d2d22fb892 26c3b1407c0f yes   yes ok
v0.73.8    26fe5d558516 d86ca819ebdc yes   yes ok
v0.73.9    84e2e797f299 f75164c0e8e6 yes   yes ok
v0.74.0    99731730933d 88703ca22989 yes   yes ok
v0.75.0    d21b14164be5 dd11c9f9aa2d yes   yes ok
v0.76.0    b4ad5e141642 eeec9febce07 yes   yes ok
v0.77.0    5b2e83eb8fcb ab2db8c4a102 yes   yes ok
v0.77.1    1b7c8e3faeab c652f51efed9 yes   yes ok
v0.77.2    f80ed6a481bd 4ba624e47192 yes   yes ok
v0.78.0    26906645439e e544b436c379 yes   yes ok
v0.78.1    4073370e1b1b fd36130900d1 yes   yes ok
v0.78.2    20aad43b5cbf 7836d7107d5b yes   yes ok
v0.79.0    88a51561a8d7 2700cc4de418 yes   yes ok
v0.79.1    a2b142b8e0e0 3a1d1649ca7f yes   yes ok
v0.80.0    aabc32d6055c c5aa9f7effd6 yes   yes ok
v0.81.0    61c9fc547492 4102020c8c83 yes   yes ok
v0.82.0    cfe73dec6016 298fa1e46a2d yes   yes ok
v0.83.0    03a2ed7188f2 a99883f7a082 yes   yes ok
v0.84.0    590db042927a cc61bb9e76b9 yes   yes ok
v0.85.0    9f491332f212 44cb6a8d31dd yes   yes ok
v0.85.1    a5031fe7878f 163fed33db69 yes   yes ok
v0.85.2    c6135fea6be1 97b17e139076 yes   yes ok
v0.86.0    113208aa3e46 489389d9094e yes   yes ok
v0.87.0    1d33f4bf4d03 4f660d2ca842 yes   yes ok
v0.87.1    bd4b17a7ff38 e6e11fbaa5bb yes   yes ok
v0.87.2    da26c7917838 2e444e0ca4ab yes   yes ok
v0.90.0    fefdebbb4ba5 b8106ed5a284 yes   yes ok
v0.90.1    433a5f3915eb 9474bf15c3aa yes   yes ok
v0.90.2    2cf98bc29654 c7b6912c0b31 yes   yes ok
v0.91.0    e72335c20755 99e58cf34ace yes   yes ok
v0.92.0    24def1d73ea6 f55fecb257a6 yes   yes ok
v0.93.0    3db9bea67fe7 dc5bde23d6d5 yes   yes ok
v0.93.1    892fd5a76f1e 6db8f29c4455 yes   yes ok
v0.94.0    dd84077fd8d2 e88dc53d5ecc yes   yes ok
v0.95.0    4f9d32f15f63 9669681c62fe yes   yes ok
v0.98.0    0e75ccd0c565 fe629de57a2e yes   yes ok
v0.99.0    cbebaa724793 e4cb244e0323 yes   yes ok
v0.100.0   a41557b667e9 e7beb8e19118 yes   yes ok
v0.101.0   616507d02cac 4463e0e0fc73 yes   yes ok
v0.102.0   0b4808a22f83 6a25c5b73b79 yes   yes ok
v0.103.0   0c9893a8ab1f 206d61eaa78b yes   yes ok
v0.104.0   9d46bb58eb49 c55f88f54672 yes   yes ok
v0.105.0   dfbd5b5fc825 0ef104a54976 yes   yes ok
v0.106.0   83956f934c00 4c42a05c2976 yes   yes ok
v0.106.1   4ee183a5a632 47e277478268 yes   yes ok
v0.106.2   283858a840e5 1641e5a71bb9 yes   yes ok
v0.109.0   3885fab52aed 9166869b5fde yes   yes ok
v0.110.0   954c814fdb22 b662bce1b2f0 yes   yes ok
v0.111.0   406174fb522c 75e648c3708b yes   yes ok
v0.111.1   fc9c5eeb02ed d3b3954afb1e yes   yes ok
v0.111.2   dd4f207555a4 a980b30988c2 yes   yes ok
v0.111.3   2d640792fe7c 4ebaa6261b80 yes   yes ok
v0.113.0   cc3ced2e64d6 743789d4c3bf yes   yes ok
v0.114.0   efbe3defc784 cad046900e7c yes   yes ok
v0.114.1   35da15737825 698743f96fa9 yes   yes ok
v0.115.0   dea43fb980c3 f108689aa6f7 yes   yes ok
v1.0.0     070ad9bedfe6 e9d3d7064bf9 yes   yes ok
v1.0.1     49d3f331229b 0b0ff0b34465 yes   yes ok
v1.0.3     0b3074cfaf1a 5ea54e9e088b yes   yes ok
v1.0.4     bb80cb3a0c3f 4c0a52b34fa2 yes   yes ok
v1.1.0     47103b1db8ca d5b35ebdcce6 yes   yes ok
v1.1.1     913016ce1b79 5116bd20e19b yes   yes ok
v1.2.0     ee83935f03af a8436412c1db yes   yes ok
v1.3.0     91ccb1508367 6ba1e8571a09 yes   yes ok
v1.4.0     6cc13e8268d4 db8dc06328bc yes   yes ok
v1.4.1     d91708d6e28f 6cd6426fe534 yes   yes ok
v1.4.2     18201a4b1fb1 1e1c595b8ca7 yes   yes ok
v1.5.0     01641abc2f59 4209390f30e3 yes   yes ok
v1.5.2     9f153dc1db36 7ffd71251264 yes   yes ok
v1.5.4     46b7b4241c9a c9b8406f3f7a yes   yes ok
v1.5.5     d4c4a0a99404 c7188bf20afd yes   yes ok
v1.5.6     82f597681d0d 75ec22050600 yes   yes ok
v1.5.7     cf3cb9c088ca 6be197804cdd yes   yes ok
v1.6.0     6d02c75763df eec525149a48 yes   yes ok
v1.6.1     340bf7edf27a 0507237f79e7 yes   yes ok
v1.7.0     1c2e3219431c 6a3de2935360 yes   yes ok
v1.7.1     419ca4079121 81ad61457751 yes   yes ok
v1.7.2     b939d90cbba6 fd394140fdc9 yes   yes ok
v1.7.3     84ea7f3d9f25 90004addb855 yes   yes ok
v1.8.0     f51a83458b98 2704ce37753d yes   yes ok
v1.8.1     43cd672db496 f3c9c81eec93 yes   yes ok
v1.8.2     7ca470efb4fc 45e2bf082de9 yes   yes ok
v1.8.3     b496c9ab07db ea16b282d35c no    no  dead-number
v1.8.4     99d28f83a12d fb8b63a80170 yes   yes ok
v1.8.5     42994774f9cb 3569b9448af7 yes   yes ok
v1.8.6     182d8efc323a 49b117610258 yes   yes ok
v1.8.7     76912996ed42 ae32ae56d08a yes   yes ok
v1.9.0     3f5421190f2d 1c9eb2469180 yes   yes ok
v1.9.1     6d7e6545a369 6fc78bf245dd yes   yes ok
v1.10.0    58f12712f8df 9e145f2114b8 yes   yes ok
v1.11.0    345df2dedbec 70dce67885aa yes   yes ok
v1.11.1    9102302791d5 6353569a65d0 yes   yes ok
v1.11.2    f8868d974bed 7679eca730b2 yes   yes ok
v1.11.3    6d61118fa0a5 23ba6d1259a4 yes   yes ok
v1.12.0    e6b349790775 07b8358525a1 yes   yes ok
v1.12.1    c78757cfbd4f 79e735b99028 yes   yes ok
v1.12.2    a155173c3708 4651ace711cc yes   yes ok
v1.12.3    9a7880a2bd44 dc16bccab190 yes   yes ok
v1.12.4    8f693d2438db cfdb75b8ba8b yes   yes ok
v1.12.5    d40ec8dca9ad c325f7d67b2e yes   yes ok
v1.12.6    ba00b14e72b3 f9ce45013dc9 yes   yes ok
v1.12.7    cfaada57767b 06a083db051c yes   yes ok
v1.12.8    bd0ac8e67e8e 4534179eafae yes   yes ok
v1.12.9    9f317f09ab44 ea7dc4df9859 yes   yes ok
v1.12.10   86b8b32fdf57 c12874762f4a yes   yes ok
v1.13.0    1466728c1409 d1489cab9542 yes   yes ok
v1.13.1    88768adf3067 7a47b93e45fa yes   yes ok
v1.15.0    60e3ae0ddf7c 3295fcea374b yes   yes ok
v1.15.1    adf61648956f bf39bb98b22c yes   yes ok
v1.15.2    4e47ed05f5ca 659d73eb4e90 yes   yes ok
v1.15.3    9edcc8c71494 55f4f91c2c5f yes   yes ok
v1.16.0    75676b488923 3072db93572a yes   yes ok
v1.16.2    76b4e4f0d03f e33ec71fc83e yes   yes ok
v1.17.0    19cdd47b6967 77b0c15cbdbe yes   yes ok
v1.17.1    17400be140bb 548b5f0875c2 yes   yes ok
v1.17.2    697f7141e3fb 75dc3a8e659b yes   yes ok
v1.17.3    5fa4e664de71 2fc33152ec09 yes   yes ok
v1.18.0    b80240dcb458 8db9cf609ba9 yes   yes ok
v1.18.1    1d788acc0e44 32b4ae72b0dc yes   yes ok
v1.18.2    abe8472c61ba af73988f715c yes   yes ok
v1.18.3    639f72c5c063 6b180b26ddd8 yes   yes ok
v1.19.0    6364c3657c0d 59ca5d3b8d98 yes   yes ok
v1.19.1    8ba446d5b4ff 5de8a5a05b9e yes   yes ok
v1.20.0    a03b20db3b76 2ee87e0c1429 yes   yes ok
v1.20.1    a3feab663181 0eaa68f58744 yes   yes ok
v1.21.0    e8f212005260 9a14da6b5197 yes   yes ok
v1.21.1    818f669f316d 6263ccc0b179 yes   yes ok
v1.22.0    c08e509dedf6 88664a81b01d yes   yes ok
v1.23.0    dbd288ef6b30 5d8b1cf218dd yes   yes ok
v1.23.1    d52641175bb8 988d8494f5a6 no    no  dead-number
v1.23.2    7b8b860f9e0d 6537c6539ca3 yes   yes ok
v1.24.0    b1e3f9355faf ef0c4c3cb253 yes   yes ok
v1.24.1    c17994727c59 85d4a58977d0 yes   yes ok
v1.26.0    a9b964d8ac83 7cdebf2e8e13 yes   yes ok
v1.27.0    fc24adf5c1a9 77033508e01e yes   yes ok
v1.27.1    f67ce5c73a51 dfae827e8ac3 yes   yes ok
v1.27.2    d6173e111bbd 6411577947e8 no    no  dead-number
v1.28.0    54d1d26060e8 600fbc4640cb yes   yes ok
v1.28.1    203a47dd83b2 72feecdd3d05 yes   yes ok
v1.28.2    ce8f7855cd17 942f86df8a05 yes   yes ok
v1.28.3    b81fa8e48105 caebf19467a7 yes   yes ok
v1.29.0    bfee55065e52 915564611155 yes   yes ok
v1.30.0    0190588539ce 1bb76d62a1d6 yes   yes ok
v1.30.2    246c6cdd8a45 c1bba49a65d9 yes   yes ok
v1.30.3    c711ee87a039 811799c671ee yes   yes ok
v1.30.4    b4284522bd04 3db5e284b2c3 yes   yes ok
v1.30.5    c76b5461f357 a1421c002888 yes   yes ok
v1.30.6    cbd4a59d287f b326a2f4034e yes   yes ok
v1.31.0    93dffa0d9a0f 15c10407750d yes   yes ok
v1.32.0    d13055ae0bf7 9123e8c770fb yes   yes ok
v1.32.1    b3ebd9e0297f 39d2e523af30 no    yes wrong-commit
v1.32.3    c47afa1f7238 ea15bb1de2cb no    no  live-lane
v1.32.4    c9e96a544e51 3dfeb3a55086 yes   yes ok
v1.32.5    4b18f1baddf2 c777f5d6e15d no    yes live-lane
v1.32.6    7ca36b2821b6 1812594ec393 yes   yes ok
v1.32.7    10b5bc8c54c6 68e6a5e5c90b no    yes live-lane
v1.33.0    8acc2855f7a0 e52a88c0873c no    no  dead-number
v1.33.2    e26c6d1585d1 2cb4ddc13e6d no    yes live-lane
v1.34.0    58ded2cfb151 cf5bf582a1ef yes   yes ok
v1.35.0    4b174d302f6f f74f61f64786 no    no  live-lane
```
