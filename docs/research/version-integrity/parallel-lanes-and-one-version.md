# Parallel lanes and one version number

*Provenance: measured in the `research-how-to-stop-par-fa30aa` worktree on 2026-11-05, 20:40–21:10 local (-0500),
carried over unchanged from that run's draft `docs/.hermes-tmp.UdQ9SU` (16,974 bytes, 2,857 words).*

The brief: stop parallel lanes colliding on version numbers and tags, and write up the options. Everything below
was measured in this worktree on 2026-11-05 between 20:40 and 21:10 local (-0500), with `git log`, `git
merge-base --is-ancestor`, `git cherry`, `git diff`, `gh pr list` and the repo's own two gates. Commit times are
local; PR merge times are UTC as `gh` prints them, converted where a comparison is made.

Two corrections to the brief up front, because they change what the fix has to be:

- **1.30.4 was not two lanes choosing one number.** `wtgui/make-optym-integration-m-b580a2` declared 1.30.4 at
  `83463d4` (19:28:53) and main declared 1.30.4 at `3db5e28` (19:33:46), but they are the **same landing**: the
  two change commits differ only in `CHANGELOG.md`, and `git cherry` marks both of the branch's commits as
  patch-equivalent to main. The fault is the tag, not the number — `v1.30.4` was anchored on the branch's copy
  of a commit the merge then re-created, and main's own 1.30.4 was untagged until a repair PR created it at
  20:37.
- **The number is not usually the thing that collides; the tag is.** Of the 110 distinct numbers declared by a
  `chore: <version>` commit, **51 appear on more than one commit**. I tested every pair the parent-tree test
  called different: one is a genuine two-lane collision (`v1.6.0`, 2026-11-04), one is a false positive from a
  rebase (`v1.28.3` — same change, new parent), and one was live tonight (`v1.32.0`) before the losing lane
  rebased and re-bumped. The other 48 are the landing's own bump commit re-created by the merge, which is
  mechanical, expected, and exactly what leaves a tag naming the wrong commit.

## 1. Why the number collides at all

The number is chosen on the branch, from what `main` said when the branch was cut, and frozen into a commit. It is
consumed on `main`, when the merge lands — minutes later, by another process. `lib/merge-prompt.js:116-137` puts
the choice in PHASE 1B, before the PR exists; `tools/version.mjs check` compares it to `origin/main`'s tip at
**push** time; and the merge itself (`docs/versioning.md:53`) is `gh pr merge <n> --rebase --admin`, which no
hook on any machine sees. The gap between "chosen" and "owned" is therefore the whole landing, and nothing is
held during it.

`tools/version.mjs:446` says the quiet part out loud:

```
  (git push --no-verify bypasses this check, and a local hook only ever binds its own author.)
```

### 1.1 The board is 49 lanes wide

```
$ git worktree list | wc -l
49
```

Every one of those trees has a `package.json`, and any of them that lands a change must compute its number from
the same moving base.

### 1.2 The window, measured

For every number that appears twice, the first declaration is the branch's and the second is main's re-creation
of the same landing. The gap is how long the number was held by nobody:

```
51 numbers declared more than once
window first -> last:   min 30 s   median 285 s   p90 1100 s   max 1464 s
```

Between 19:07 and 20:02 seven releases landed (one every ~8 minutes), so a number is held for **longer than the
interval between landings**. Two lanes bumping inside the same window compute the same answer, and nothing in
the repository is asked whether the answer is still free.

### 1.3 The genuine collision, seen live

`v1.32.0` was declared three times:

```
c964c534  2026-11-05 20:14:17  wtgui/hold-a-pipeline-row-on-i-04c7d1
bb814f35  2026-11-05 20:27:36  wtgui/link-the-mermaid-pipelin-e2fc16
9123e8c7  2026-11-05 20:29:50  origin/main
```

`c964c534` and `bb814f35` are different landings — their change commits differ in 41 files:

```
$ git diff --name-only c964c534^ bb814f35^ | wc -l
41
```

The mermaid lane landed at 20:29:50 (PR #458). The lane that had chosen 1.32.0 thirteen minutes earlier rebased
onto the new main and re-bumped:

```
c88a342  2026-11-05 20:37:47  chore: 1.33.0 — the version this landing carries
```

`c964c534` is now reachable from nothing: the losing bump commit is discarded by the rebase, so the collision
leaves no durable trace beyond a number that was spent twice. The earlier genuine case is the same shape:
`v1.6.0` on 2026-11-04 was declared at `2d1a929e` (04:14:44, "every deliverable card's Open opens it") and at
`3c29b07c` (04:15:45, "the landing's render, proven at 250 releases") — two lanes, 61 seconds apart.

### 1.4 The tag, and the gate that is red right now

`node tools/verify-version-tags.mjs --ref origin/main` at `603617b`:

```
version-tags: 334 version bumps in package.json's history (v0.1.0 .. v1.32.1), 333 tagged and annotated at the commit that first declared them
  4 tags name a version origin/main does not carry yet, each at a commit whose package.json declares it (held on a branch): v1.23.1@988d8494, v1.27.2@64115779, v1.32.2@980a8f97, v1.8.3@ea16b282
  wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1 first appeared at 946578704c
FAIL — 1 finding across 334 version bumps
```

Exit code 1. `v1.32.1` names `39d2e523`, the bump commit on `wtgui/untrack-config-json-land-8e3f5a`; main's
copy is `94657870`, and the two differ only in `CHANGELOG.md` — one landing, two commits, the post-merge move
(`node tools/version.mjs tag --ref origin/main --force`) not yet run. That is the same fault as 1.30.4, 1.31.0
and 1.32.0 earlier tonight, each repaired by its own docs PR (459 and siblings) rather than by the landing that
caused it.

### 1.5 A docs lane cannot be pushed at all

This branch carries no commits yet, and the gate already refuses it:

```
$ node tools/version.mjs check
version check: refused — this branch's version is behind origin/main's

  branch  1.30.3  (HEAD's package.json)
  base    origin/main  1.32.1  (603617b)
```

Exit code 1. With a commit and no bump it refuses for the other reason ("commits are about to land with no
version bump"). So a research or docs lane has exactly two ways to publish: spend a number it does not need, or
bypass the gate with `--no-verify`. `docs/versioning.md` blesses the second for a render ("a render that is the
whole PR … spends no number"), and `tools/land.mjs` passes `--no-verify` only when every commit it sends touches
`CHANGELOG.md`. The escape is documented, which is why the gate is not a guarantee even at push time.

### 1.6 What a hand reservation costs

1.25.0 exists in no commit on main. The lane that took it said so in a commit *subject*:

```
7cdebf2  chore: 1.26.0 — the version this landing carries (1.25.0 is held by wtgui/fix-the-two-driver-defec-72dda4)
ae8ff9c  chore: 1.26.0 — the version this landing carries (1.25.0 is held by wtgui/fix-the-two-driver-defec-72dda4)
```

`main` goes 1.24.1 → 1.26.0: the reservation was honoured by everyone and the number was spent by nobody, which
is the permanent hole a claim leaves when its holder does not land. The branch eventually landed as 1.27.0.

## 2. The four failure modes, separated

| | what happens | tonight's evidence |
| --- | --- | --- |
| **F1 two lanes pick one number** | both compute "next above main" from the same base; the later landing wins, the earlier lane rebases and re-bumps | `v1.32.0` (20:14 vs 20:27), `v1.6.0` (61 s apart) |
| **F2 the tag names the branch's copy** | the merge re-creates the bump commit; the tag keeps pointing at the pre-merge sha until someone moves it | `v1.32.1` red now; 1.30.4/1.31.0/1.32.0 repaired one PR at a time tonight |
| **F3 the number is outrun** | main passes the branch's number before it lands; the gate refuses the push, and the lane must rebase and re-bump | every lane cut before 1.32.1 now carries a number main has passed; the re-bump discards the old commit (`c964c534`) |
| **F4 the gate cannot see the merge** | the check runs on the pusher's machine, only at push; the merge is `gh pr merge --admin`; `--no-verify` is documented | `tools/version.mjs:446`, `docs/versioning.md:53` |

F1 and F3 are the same arithmetic seen at different moments; F2 is the tag half of the same race; F4 is why none
of them is caught when it matters.

## 3. The options

Each is described by what it changes, where it plugs in, what it would have done to tonight's two cases, and what
it costs. None of them is free.

### A. Reserve a number range per lane

**Mechanism.** The panel allocates each tree a block of patch numbers when it mints the branch (ten is plenty),
records the block beside the tree record, and `version.mjs apply` takes the lowest free number in the block
instead of main's `+1`.

**Where it plugs in.** The branch-minting path (`lib/worktree-naming.js` calls the panel's naming, and the row's
create route is the only place a `wtgui/` branch is made) plus a persisted allocator — `lib/locks.js` is the
existing precedent for a store that survives a restart and is keyed on branch and tree.

**Tonight.** `hold-a-pipeline-row` and `link-the-mermaid` would hold disjoint blocks: no double 1.32.0, no
re-bump at 20:37.

**Cost.** Numbers arrive out of order, and the repository's own history reader assumes they do not:
`tools/release-history.mjs:71-79` builds each release's `from` as *the previous version in the walk*, so a lane
landing 1.40.3 after 1.41.0 produces a section whose predecessor is numerically above it. The changelog renders
those ranges as consecutive, and the board's config line can show a build number lower than one the reader
already ran. Abandoned lanes leave permanent holes — 1.25.0 is already one, and this scheme makes a hole the
normal cost of every abandoned lane, not an exception. The allocator is new persistent state that must survive
a crash, be reclaimed on release, and cannot race two simultaneous branch creations (the same bug, one level
up).

**Closes:** F1 and F3 for as long as blocks do not overlap. **Leaves:** F2, F4 untouched.

### B. Claim the number by pushing its tag

**Mechanism.** The bump commit is made first, then `git push origin refs/tags/v<next>` — the remote rejects an
existing ref, atomically, for every lane and every machine. A rejection means the number is taken: rewrite the
bump commit above the new main and try the next one. The tag pushed is the same annotated tag the repo already
uses, so the claim is visible to `git ls-remote --tags` and to the existing gate.

**Where it plugs in.** `tools/version.mjs apply` (and the `tag` mode, for the dirty-tree path where `apply` writes
the number and stops). A `claim` step after the commit, before `git push` of the branch.

**Tonight.** `link-the-mermaid` would have pushed `v1.32.0` at 20:27:36, been rejected — `hold-a-pipeline-row`
had claimed it at 20:14:17 — and re-bumped to 1.32.1 in seconds instead of landing on a number another lane had
chosen. The 1.32.1 red gate would not exist either: the claim tag is the anchor, so the "move the tag after the
merge" step becomes a move of a tag that is already right, not the creation of one that was never there.

**Cost.** The claim happens after the bump commit exists, so a lost race means rewriting that commit (`--amend`
or a second commit) and re-tagging — cheap, but it rewrites a branch that may already be pushed. A lane that
claims and then abandons leaves a tag on `origin` for a number main will never carry: the repo already carries
four such tags, and the gate reports them as `held on a branch` forever, with retirement a deliberate
`git push origin :refs/tags/<tag>`. The push needs the network in the bump path, which no other step of the
bump does today (a lane working offline can only claim when it next reaches `origin`). Force-moving a tag that
another clone may have fetched is the existing post-merge step and keeps its existing caveat.

**Closes:** F1 at the moment the number is chosen, and F2 at its root (the anchor is the claim, not a later
repair). **Leaves:** F4 (a lane that skips the claim is unauthorised but not refused), and the hole left by an
abandoned claim.

### C. Serialise landings through a lock

**Mechanism.** One landing at a time. The lander takes a lock before PHASE 1B, re-reads `origin/main` under it,
picks the number, lands, moves the tag, releases.

**Where it plugs in.** `lib/locks.js` already persists exactly this shape of record (a key, a reason, a survival
across restarts) for worktrees and branches, and `lib/merge-prompt.js` is the one text every lander follows. A
remote ref (`refs/heads/landing-lock`, created by a compare-and-swap push) would make the lock bind agents in
different clones, not only this panel's.

**Tonight.** The two landings would not interleave: the second lander would read main after the first released
and compute 1.32.1. F2 is also fixed by construction if the tag move is inside the locked section — the current
failures are all "the landing finished without its last step", which a lock that is released only after the tag
move makes impossible to forget.

**Cost.** Throughput becomes one landing per landing: at 4-6 minutes each, roughly 10-15 releases an hour, against
tonight's peak of 7 releases in 55 minutes (~7.6/h). It costs nothing today and becomes the ceiling the first
time the board runs faster than a serialised landing. A lock that outlives its holder stops every landing until
someone breaks it, so it needs a TTL and a visible "held by X since T" row. And because the landers are separate
agents following a prompt, the lock is only a mechanism if the *push* is gated on it — otherwise it is a rule,
and rules are what the last 51 duplicate declarations are made of.

**Closes:** F1, F2 and F3 together. **Leaves:** F4 (still a push-time check), and the queue itself is new state.

### D. Assign the number at the merge

**Mechanism.** No number on the branch. The lander writes it after the merge, from the merged base, as part of
the post-merge step.

**Where it plugs in.** `tools/land.mjs` already runs on the base after the merge, refuses a dirty tree or a moved
base, commits `CHANGELOG.md` alone and pushes. It would also write `package.json` and create the tag in the same
commit — one motion, on the only commit that knows what main actually is.

**Tonight.** Neither lane would have chosen 1.32.0: `link-the-mermaid` merges, the lander writes 1.32.0; at
20:37 `hold-a-pipeline-row` merges, the lander writes 1.32.1. No duplicate, no re-bump, no tag to move.

**Cost.** It contradicts the rule the repo is built on — "the bump goes in the same PR as the change", because a
branch is one revertable unit (`docs/versioning.md`, "The bump is a judgement"). A version chosen after the merge
is not reviewable in the PR, and a revert of the landing would have to revert the number too, which is no longer
in the same commit. `docs/versioning.md` and `lib/merge-prompt.js` PHASE 1B would both have to be rewritten, and
`apply` would lose its only caller. A crash between the merge and the post-merge commit leaves main at the old
number with the change already in it — the same red-tip class as a missing render, but on the number instead of
the changelog.

**Closes:** F1, F2 and F3 completely — the number is chosen after the base is final. **Costs:** the number's
reviewability, and the revert story.

## 4. Side by side

| | closes | new state | cost when it goes wrong | fits today's docs |
| --- | --- | --- | --- | --- |
| **A ranges** | F1, F3 | an allocator per project | a permanent hole per abandoned lane; out-of-order releases | breaks `release-history`'s `previous..next` assumption |
| **B tag claim** | F1, F2 | tags for claimed numbers | an abandoned claim is a held tag; a lost race rewrites the bump commit | uses the existing tag vocabulary; `apply`/`tag` gain one step |
| **C lock** | F1, F2, F3 | a landing lock + TTL | every landing stops while the lock is stale; throughput capped at one landing | `lib/locks.js` already exists; the prompt gains a phase |
| **D assign at merge** | F1, F2, F3 | nothing (the post-merge step grows) | the number is not in the PR, and not revertable with it | contradicts "the bump travels with the change" |

## 5. What none of them fix

- The tag still has to move after a rebase merge unless the number is assigned at the merge (D). B makes the
  move a re-point of an existing claim; C makes it part of the locked section; A does nothing about it.
- The changelog still renders at the merged tip, after the merge, in `land.mjs`. Every option leaves that step
  where it is.
- The gate still runs on the pusher's machine. Only C's remote lock (or a server-side protected branch) changes
  who can land at all.

## 6. The decision

The trade is between a number that is chosen early and reviewable (A, B, C) and one that is chosen late and
always right (D); between new persistent state (A, C) and state that is a git ref everyone already understands
(B); and between fixing the number and fixing the tag (all four fix the number; only B and C fix the tag by
construction).

That choice is the reader's, and it is being asked for rather than assumed.
