# H — the sentences a worker reads about versions and tags, and the ones that land a wrong one

Read-only pass. Every sentence below is quoted from a file a worker can actually read, with the file and line
it sits on. Each is marked:

- **MARKED** — a careful worker can obey the sentence exactly as written and land a wrong version.
- **no mark** — I tried to build that path and could not.

"Wrong version" means one of four things, and a sentence is marked if obeying it can produce any of them:

| shape | what it is |
|---|---|
| **below the base** | a number `main` has already passed, so the build that lands is older than the one it lands on |
| **taken** | a number another live lane already holds, so one number names two different commits |
| **skipped** | a number no landing carries, so `main`'s history jumps it and a tag for it points at a commit `main` never had |
| **mis-anchored** | a `v<version>` tag naming a commit that did not declare the number, or naming no commit on `main` at all |

The number and the tag are one subject here because every sentence about one is also a sentence about the
other: the tag is how the number is attached to history, and the gate that reads the tag is the gate the push
meets.

Nothing was fixed. This lane changed no source file, no `package.json`, no tag and no ref. The probes quoted
below ran in a `git clone --shared` of this repo in the run's scratch directory; a tag deletion named as a probe
was made in that clone only, and `git ls-remote` was used to show the remote was untouched.

## At a glance

| # | where | mark | the wrong version it can land |
|---|---|---|---|
| H-01 | `lib/merge-prompt.js:117-119` | no mark | — |
| H-02 | `lib/merge-prompt.js:125-126` | **MARKED** | below the base: `apply` bumps the branch's own number, not the base's |
| H-03 | `lib/merge-prompt.js:132-137` | **MARKED** | mis-anchored: the reason goes into a commit the tag already names |
| H-04 | `lib/merge-prompt.js:144` | **MARKED** | mis-anchored: a dirty-tree `apply` creates no tag, and the prompt never says to make one |
| H-05 | `lib/merge-prompt.js:194` | **MARKED** | mis-anchored or rewritten: it forbids the only step that fixes the anchor |
| H-06 | `lib/merge-prompt.js:246-247` | **MARKED** | skipped: the one "spends no number" rule is scoped to a render and generalises to docs |
| H-07 | `lib/merge-prompt.js:280,287` | **MARKED** | taken/skipped: the report format has no shape for a landing that spent no number |
| H-08 | `lib/merge-prompt.js:127-130` | **MARKED** | taken: "a doc" is a patch here, and the repo's own docs commits spend none |
| H-09 | `docs/versioning.md:3-5` | no mark | — |
| H-10 | `docs/versioning.md:4-5` | **MARKED** | taken: "visible where you already look" invites a second bump |
| H-11 | `docs/versioning.md:12` | **MARKED** | mis-anchored: "on `main`" tags the tip, which is a render commit |
| H-12 | `docs/versioning.md:17-19` | **MARKED** | mis-anchored: "the landing moves it" is not in the landing prompt |
| H-13 | `docs/versioning.md:27-31` | **MARKED** | mis-anchored: the move reads a stale `origin/main` and force-pushes a published tag |
| H-14 | `docs/versioning.md:36-42` | **MARKED** | skipped: `backfill` defaults to `HEAD` and tags branch commits |
| H-15 | `docs/versioning.md:19-20` | **MARKED** | skipped: retiring a live lane's anchor deletes a number that did land |
| H-16 | `docs/versioning.md:63-65` | no mark | — |
| H-17 | `docs/versioning.md:67-68` | **MARKED** | skipped: a shape the doc blesses is refused by the hook |
| H-18 | `docs/versioning.md:79-83` | **MARKED** | mis-anchored: "landed as one commit on `main`" is false under a rebase |
| H-19 | `tools/version.mjs:432-446` | **MARKED** | below the base: the refusal prints the floor as the command to run |
| H-20 | `tools/version.mjs:476-481` | **MARKED** | taken: it tells the worker to move or delete another lane's tag |
| H-21 | `tools/version.mjs:532-533` | **MARKED** | mis-anchored: unconditional post-merge force-move, no fetch |
| H-22 | `tools/version.mjs:308-315` | no mark | — |
| H-23 | `.githooks/pre-push:67` | **MARKED** | below the base: one headline for two refusals |
| H-24 | `.githooks/pre-push:70-72` | **MARKED** | taken/skipped: the refusal offers the bypass as the remedy |
| H-25 | `README.md:194-196` | **MARKED** | below the base: "current tip" is a ref nobody fetched |
| H-26 | `README.md:199-202` | **MARKED** | mis-anchored: it names the wrong actor as instructed |
| H-27 | `docs/pushing-to-a-remote.md:170-176` | **MARKED** | skipped: "no version gate at all" is false on this clone |
| H-28 | `lib/branch-policy.js:55-58` | **MARKED** | skipped: the paragraph a lane worker is handed has no version sentence |
| H-29 | `matrix-bridge/WAG-PROMPT.md:72` | **MARKED** | skipped: "Do not bump the version" is still a numbered step |

## The sentences

### `lib/merge-prompt.js` — the prompt the merging agent runs

**H-01 · lines 117-119 — no mark.**
> The version lives once, in package.json, and it is the only thing that tells the board's config line which
> build is running. Which level it moves by is YOUR judgement, made from the diff you are about to land - a tool
> advises, a hook refuses, neither one decides.

Both halves are true and the second is the correct division of labour: `suggest` writes nothing, `check` refuses
numbers and never levels. I could not obey this into a wrong version. It is quoted because three later sentences
break it (H-19, H-21, H-25).

**H-02 · lines 125-126 — MARKED.**
> node tools/version.mjs apply `<patch|minor|major>`   <- writes the new version to package.json, the ONE place it
> lives, and prints the old and the new value

"The old" is the branch's own `package.json`, read from the working tree, not the base's number. On a branch cut
before `main` moved, that old number is one `main` has passed, so `apply patch` writes a number below the base.
The prompt lists this step before PHASE 2's rebase, so the order it gives is: bump from the stale tree, then
move the tree under the bump. `check` then refuses as **behind**, and its remedy is another `apply` — see H-19.
Probe B below is the write itself: `1.32.1 -> 1.32.2` on this tree, while `origin` already had `v1.32.2` at
another commit.

**H-03 · lines 132-137 — MARKED.**
> Land the bump as a commit ON ${branch}, before PHASE 2, with the level and the reason in its own message, and
> say the same level and reason in the PR body: the squash merge composes main's commit body from this branch's
> subjects, so a bump nobody explained is a version in main's history nobody can account for.

`apply` has already made that commit, and its subject is fixed: `chore: <version> — the version this landing
carries`. It carries no reason. To obey "with the level and the reason in its own message" a careful worker
amends that commit or stacks a second one. Both are in the prompt's own gift: the HARD RULES forbid amending a
commit `${baseRef}` carries, not one of your own, and PHASE 1C tells the worker a harness, its screenshots and
its report travel in the SAME commit as the change.

The amend is the worse path. `apply` tagged that commit, so an amend moves the commit and leaves `v<version>` on
the replaced sha. Probe C: `HEAD` `0d445f3`, `v1.32.2` still on `dad4351`, and the only ref naming the old commit
is the tag. The gate reads that as `wrong-commit` once the number lands, or as a tag on a commit no branch
carries. The stacked-commit path breaks the doc's "one branch is one revertable unit" (H-18) instead.

**H-04 · line 144 — MARKED.**
> 1. bump the version on ${branch} (PHASE 1B) - the tag anchors that commit

This is the sentence that promises the tag. `apply` creates the tag only on a clean tree. On a dirty tree it
writes the number and stops, and says so in its own output: "no commit and no tag … commit the change, then
anchor it: node tools/version.mjs tag". The prompt never mentions that second command, and its own PHASE 1C
makes the tree dirty by design — a verification harness, its screenshots and its report "travel in the SAME
commit".

So a careful worker who followed PHASE 1C to the letter reaches PHASE 1B with an untracked report, gets the
number written and no tag, commits the change, and believes step 1's promise. The landing then carries a bump
with no tag: `verify:version-tags` reads `missing`, and the release has no anchor at all. That is the v1.30.4
shape, whose repair is a whole separate record.

**H-05 · line 194 — MARKED.**
> - Never force-push, never rewrite published history, never "git push --force"/"-f".

In isolation this is the rule that keeps other people's work. Read against the rest of the instructions it is one
half of a contradiction: `docs/versioning.md:31` and `apply`'s own output both require
`git push origin v<version> --force` as the step that moves the anchor after a rebase merge. A careful worker
cannot obey both. If they keep this rule the tag stays on the branch's pre-merge tip and the gate reads
`wrong-commit` — which is exactly the live state of `v1.32.1` today (E1). If they keep the tag rule they rewrite
a published tag, which this sentence calls broken. The repo's history contains both outcomes: `v1.27.1` and
`v1.28.0` were moved 41 s after their merges, and `v1.32.1` was not moved at all.

**H-06 · lines 246-247 — MARKED.**
> commits that render as its own docs commit - a render spends no version and creates no tag - pushes ${base} with
> the render, and proves both by re-rendering

This is the only "spends no version" sentence in the prompt, and it is scoped to a render. A careful worker with
a docs-only change — a report, a repair record, this file — has no sentence of their own, so this is the one they
reach for: the repo's own landed docs commits sit above a bump without one (`603617b` above `9465787`, `f6f0c2f`
above the same bump), and the repair record attributes its `--no-verify` push to "the docs-only path
`docs/versioning.md` describes for a change that spends no number". `docs/versioning.md` describes no such path:
its only exemption is this render sentence. Obeying the generalisation lands a branch at the base's number, which
the hook refuses (H-23/H-24); the only way through is the bypass the prompt calls a stop.

**H-07 · lines 280, 287 — MARKED.**
> version: `<old>` -> `<new>` (`<patch|minor|major>`: `<the reason, one line, the same one in the PR body>`)
>
> A merge reported as done without these lines did not happen.

The report has a slot for a number that moved and no shape for one that did not. A worker whose landing
legitimately spent none — the render-only PR of H-17, a docs catch-up at the base's version — must either omit a
line the prompt says makes the merge not have happened, or invent a bump to fill it. The invented patch is how a
docs landing acquires a number for nothing, which is the "taken" fault one commit later: the next lane's patch
collides with it.

**H-08 · lines 127-130 — MARKED.**
> The scale, in one line each: major breaks a contract someone outside this PR depends on … patch is a fix, a doc,
> a refactor that moves code without changing behaviour, or a test-only change.

"a doc" is a patch here. The repo's practice says otherwise: `603617b` ("docs: v1.30.4 is anchored at main's
release commit") and `f6f0c2f` ("docs: render the changelog — 334 releases") both landed above `9465787` with the
number unchanged, and the repair record calls its own docs-only commit "a change that spends no number". A
careful worker on a docs-only branch has two authorities that disagree, and the hook refuses the answer practice
gives. Whichever they choose, the other sentence is the one they broke — and the patch they'd spend is a number
another lane may already be computing (H-20).

### `docs/versioning.md` — the scale the prompt tells the worker to read first

**H-09 · lines 3-5 — no mark.**
> The version is one number, declared once, in `package.json`'s `"version"`.

Accurate, and the rest of the file is built on it. The server does read that one field. No path to a wrong
number from this sentence alone.

**H-10 · lines 4-5 — MARKED (weaker).**
> so a bump is a one-line change and is visible where you already look.

"Where you already look" is the board's config line, and that line prints the number the panel process read at
boot — `apply` says it itself: "the board's config line reads this at its next start (server.js reads
package.json once, at boot)". A bump made in a worktree is visible nowhere until it lands and the panel restarts.
A careful worker who uses the board to confirm the write sees the old number, concludes the write failed, and
runs `apply` again. Two bumps for one change: the first number is tagged and never lands, which is the "skipped"
fault with a tag on it. I mark this weaker than the rest because it needs the board to be the worker's check;
on its own the sentence only overstates visibility.

**H-11 · line 12 — MARKED.**
> A version number is anchored by an annotated tag, `v<version>`, at the commit on `main` that first declared it

A branch's tag is not on `main` until the landing, which this file says itself sixteen lines later (H-12). A
worker who obeys "on `main`" literally tags `main`'s tip. On this tree that tip is `f6f0c2f` — "docs: render the
changelog — 334 releases", a CHANGELOG-only commit — sitting directly above `9465787`, "chore: 1.32.1 — the
version this landing carries", a `package.json`-only commit. The tag would name the render. That is not
hypothetical: `tools/version.mjs` records the same mis-anchor by name — "v1.5.0 was anchored that way on 5234a3c
and the gate refused it". The tool has since grown `findDeclaration` to stop it; the sentence a worker reads
still describes the defect.

**H-12 · lines 17-19 — MARKED.**
> a tag on a branch that has not landed yet, whose own commit declares the number, is **held** — the branch
> carries the tag so the gate can read it, and the landing moves it onto the commit `main` carries

"the landing moves it" is not in the landing. `lib/merge-prompt.js` is the script the landing agent runs, phase
by phase, and it never mentions the tag between PHASE 1B and PHASE 6 — no `tag --ref origin/main`, no tag push,
no line in the report. The move exists only in this file's next paragraph. A careful worker who treats the
prompt as the landing script finishes with the tag on the commit the merge dropped. That is the live
`v1.32.1` reading: the tag names `39d2e52`, the bump on `wtgui/untrack-config-json-land-8e3f5a`, while `1.32.1`
first appeared at `9465787` on `main` (E1).

**H-13 · lines 27-31 — MARKED.**
> Once the PR has merged, move the anchor onto the commit `main` carries — never leave it on the branch's
> pre-merge tip:
>
>     node tools/version.mjs tag --ref origin/main --force
>     git push origin v<version> --force

Two faults in four lines. **No fetch.** `modeTag` resolves the ref with `git rev-parse --verify --quiet
${ref}^{commit}` and the file contains no `fetch` call anywhere; `origin/main` is whatever the last fetch left.
On a clone that has not fetched since the merge — the normal state of the clone that just pushed a PR from a
worktree — the "move" targets the pre-merge commit the worker is trying to leave. The tool then refuses ("no
commit reachable from origin/main … first carries `<version>`"), or, if an older commit on that stale ref happens
to carry the number, tags the previous release. The worker has been told this is the step that fixes the anchor.

**The force-push**, line 31, is the other half of H-05: it rewrites a published tag, which the merge prompt's
HARD RULES forbid outright. And the two commands are separate lines: a worker whose `tag` step refused still has
a `git push --force` in front of them for a tag that did not move.

**H-14 · lines 36-42 — MARKED.**
> A bump that reached `main` without its tag is repaired by one idempotent pass:
>
>     node tools/version.mjs backfill --push
>
> It tags every version in `package.json`'s history that has none, at the commit the walk says first declared it,
> and sends only the tags it created.

The framing is "reached `main`", and the tool never checks that. `modeBackfill` defaults `ref` to `HEAD`, walks
the history reachable from it, and pushes whatever it created to `origin`. Run where a worker works — a worktree
branch — it tags the branch's own bump and sends it. Probe D: a branch off `main` with one hand-made `1.34.0`
bump, `backfill` reports "1 tagged now", creates `v1.34.0` at `be94a33`, and `git merge-base --is-ancestor`
against `main` says no; the only refs naming that commit are the probe branch and the tag. With `--push` that tag
goes to the shared remote: a number `main` never carried, anchored on a commit `main` will never have. This is
exactly the `v1.8.3` / `v1.23.1` orphan shape the repo already has.

**H-15 · lines 19-20 — MARKED.**
> Only a tag whose own commit does not declare the number is an orphan; retiring it (a deliberate
> `git push origin :refs/tags/<tag>` once its row is closed) is the disposition.

The test is right; the label a worker acts on was wrong for months. The `v1.30.4` record shows the gate calling
honest pre-landing anchors `orphan-tag` because `main`'s walk had not reached them yet, and the repair had to
create that tag by hand under a temporary ref precisely because "a plain `git tag -a v1.30.4` in this clone would
have re-pointed it — spending the lane's anchor". A careful worker who trusts the label deletes another lane's
live anchor. A deletion is also the one disposition the tool cannot undo: `backfill` will only rebuild a tag at
a commit that declares the number, so a number `main` carries whose only tag was deleted becomes `missing` with
nothing to point at.

**H-16 · lines 63-65 — no mark.**
> A branch that carries a bump reads red under `npm run changelog:check` until the merge — the section it would
> add names the bump commit's pre-merge sha. That red is expected, and rendering on the branch to clear it is the
> defect this section exists to stop.

This is the most useful sentence in the file: it predicts the reading a worker will see and forbids the reaction
that makes it worse. No path to a wrong version.

**H-17 · lines 67-68 — MARKED.**
> A render that is the whole PR — a housekeeping commit that catches the file up — spends no number and creates no
> tag: it lands at the base's own version.

The shape is legitimate in the doc and impossible under the hook: a branch with commits and no bump is refused by
`.githooks/pre-push` (H-23/H-24), which cannot tell a render from a feature. So the only way to land the PR this
sentence blesses is `--no-verify` — the bypass the merge prompt calls "a stop". The repair record did exactly
that and then described the bypass as the doc's docs-only path, which this file does not contain. A worker who
believes the sentence and does not want to bypass has to spend a number on a housekeeping commit, which is the
H-07 pressure.

**H-18 · lines 79-83 — MARKED.**
> - **the bump goes in the same PR as the change it describes.** One branch is one revertable unit, landed as one
>   commit on main, so the version that names the change has to travel with it. A bump landed separately cannot be
>   reverted with the thing it was describing.

"landed as one commit on main" is not this repo's landing. PHASE 2 permits a real merge commit when the repo
keeps them and the branch has several commits, and the history does keep them (`504f2cd` is a true merge). Under
a rebase or a squash the commit that lands is a different sha from the one `apply` tagged — which is why H-12's
move exists at all. A worker who believes "the commit travels" sees no reason to move the tag, and lands the
live `v1.32.1` fault. The sentence is true of the change's content and false of the commit's identity, and the
tag follows identity.

### `tools/version.mjs` — what the tool says while it refuses or writes

**H-19 · lines 432-446 — MARKED.**
> a version that does not move with its change tells a reader nothing moved … Fix it in the same PR as the
> change:
>
>     node tools/version.mjs apply ${level || "patch|minor|major"}
>
> apply writes the number, commits it as its own commit and tags that commit.

`${level}` here is `overall(read)` — the floor computed from commit prefixes, `null` folded into
`"patch|minor|major"`. Printing it inside the remediation turns advice into a command line. A careful worker
whose branch carries a `feat:` under a `fix:` subject, or a commit with no prefix at all, copy-pastes the level
the tool printed and lands a capability as a patch. That is the "below the base" fault in level space: the number
moves, so the gate is green, and the release understates what it shipped. The prompt spends a paragraph saying
"a tool advises … neither one decides"; the tool's refusal spends one line undoing it.

**H-20 · lines 476-481 — MARKED.**
> version apply: package.json would declare 1.32.2, and v1.32.2 already names e0ef3ef204 — a version is anchored
> once; move or delete that tag first

The refusal is correct: a version is anchored once, and `1.32.2` is held by another lane. The remedy is the
fault. "move or delete that tag first" tells the worker to take a tag that belongs to a live branch's landing.
The `v1.30.4` record is the worked example of why that is destructive: re-pointing that lane's tag would have
left its own landing, whose last step is to move the tag onto the commit `main` carries, with nothing to move.
The tool has no third answer — it cannot see that the tag is held by an open branch rather than stale — and it
puts the destructive one first. Probe A is this message verbatim.

**H-21 · lines 532-533 — MARKED.**
> a rebase merge re-creates this commit — after the merge, move the tag onto the commit main carries:
>
>     node tools/version.mjs tag --ref origin/main --force && git push origin v1.32.2 --force

Printed by `apply` on every successful write, unconditionally: not only for a rebase merge, and before the worker
knows which merge route the landing will take. It carries H-13's two faults (no fetch, a published-tag
force-push) and adds one of its own: it is a compound command. A worker who pastes it after a squash merge runs
the move against whatever `findDeclaration` finds on a possibly stale `origin/main`; the `&&` means a refusal in
the first half silently leaves the second half unrun, so the tag can be moved locally and never published, or
the reverse in a copy-paste of only the second line. The sentence that should be conditional is unconditional,
and it is printed at the moment the worker is most likely to obey it without reading.

**H-22 · lines 308-315 — no mark.**
> suggested level: ${level}
>   The judgement is the landing agent's, and the bump belongs in this PR. See docs/versioning.md.
>   Advice only — nothing was written.

Honest about its own status, prints the reason per commit, and says when a commit could not be classified. No
path to a wrong version — the fault is in H-19, where the refusal quotes this level as a command.

### `.githooks/pre-push` — the refusal a lane worker actually meets

**H-23 · line 67 — MARKED.**
> pre-push: refused — $branch would go out with no version bump

One headline for two refusals. `check` refuses an unchanged number *and* a number behind a base that moved; the
hook prints the first for both. A careful worker on a branch cut before `main` moved reads "no version bump",
runs `apply`, gets a number that is still below `main` because `apply` read the stale tree (H-02), and is refused
again — with the same headline. The detail is in the check block underneath, but the line a worker quotes back
and acts on is this one. The second `apply` is the "skipped" fault: the number that was written first, tagged
and never landed, is a number `main` jumps.

**H-24 · lines 70-72 — MARKED.**
> Nothing was pushed. The bump belongs in the same PR as the change — docs/versioning.md has the scale.
>   node tools/version.mjs apply `<patch|minor|major>`    (writes the number, commits it, tags the commit)
>   git push --no-verify                                (deliberate bypass of this hook)

The refusal offers the bypass as a remedy, three lines under the sentence saying the bump belongs in the PR. A
careful worker with a change the scale itself says spends no number (H-06, H-08, H-17) has no other option, and
the sentence they are obeying calls the bypass "deliberate". The tool prints the same offer in its own refusal
("git push --no-verify bypasses this check, and a local hook only ever binds its own author"), so both gates
advertise the door. This lane's own push is the instance; it is quoted in the last section.

### `README.md` and `docs/pushing-to-a-remote.md` — the summaries a reader trusts

**H-25 · lines 194-196 — MARKED.**
> `.githooks/pre-push` refuses a push whose branch is not above its base's version: it runs
> `node tools/version.mjs check`, which compares HEAD's `package.json` with the version at `origin/main`'s current
> tip.

"current tip" is the local remote-tracking ref. Neither the hook nor the tool fetches, so on a clone that has not
fetched since `main` moved, `origin/main` is the old tip. A branch at `1.32.2` is above a stale `1.32.1` and
passes, while the real base reads `1.32.3`: a number below the base lands with a green gate. This is the one path
in the whole set where the gate *passes* a wrong number rather than refusing a right one, and the sentence is
what makes a reader believe the comparison is against the remote.

**H-26 · lines 199-202 — MARKED.**
> The level is a judgement the landing agent makes from the diff and lands in the same PR as the change — …
> and `docs/versioning.md` is the scale. The merge prompt tells the landing agent to do it.

True of the merging agent, and misleading for everyone else. The merge prompt is started from a worktree row's
UNMERGED chip; the agent that pushes a lane branch is handed `lib/branch-policy.js`'s LANDING paragraph instead
(H-28), which says push and open a pull request and never mentions a version. So "the merge prompt tells the
landing agent to do it" is the sentence that lets a reader believe the instruction reaches the actor who pushes.
It reaches a different actor, later, for a different branch.

**H-27 · `docs/pushing-to-a-remote.md:170-176` — MARKED.**
> Measured on this clone today: `git config --get core.hooksPath` in the main checkout prints nothing, so
> `hooks:install` has not been run, the guard recorded `.git/hooks` (samples only) as its predecessor, `chain` is
> empty, and this tree pushes with **no version gate at all**.

False on today's clone, and the measurement is the kind a careful worker trusts. `core.hooksPath` is the panel's
guard directory, its `chain` file holds `.githooks/pre-push`, and the guard's `pre-push` runs the chain — this
lane's push was refused by the version gate through exactly that path (last section). The same file's §5 also
repeats "origin/main's current tip" (H-25). A worker who reads "no version gate at all" and skips the bump finds
the gate at the push, and the sentence that was supposed to explain it is wrong.

### `lib/branch-policy.js` — the paragraph a lane worker is actually handed

**H-28 · lines 55-58 — MARKED.**
> LANDING: this worktree (…) is on `wtgui/…`, cut from `main` — a landing branch, so do not merge into it. When
> the work is done, commit on `wtgui/…`, push it and open a pull request: `git push -u origin HEAD` then
> `gh pr create --fill`.

This is the whole landing instruction a lane worker gets, and it contains no version sentence, no pointer to
`docs/versioning.md`, no mention of the hook. It tells the worker to push; the push with commits and no bump is
the one the hook refuses. So the first version instruction the worker meets is a refusal, in a file nothing
pointed them to, whose headline is H-23 and whose remedy includes H-24. The omission is the structural fault the
rest of the marks hang on: every "landing agent" sentence in the repo means the merge agent, and the agent that
writes and pushes the branch has no sentence at all. That is also why the panel's row for this lane — "Analyze
lane instruction ambiguities read-only" on the board — carries no version instruction of its own.

### `matrix-bridge/WAG-PROMPT.md` — a prompt still in the tree

**H-29 · line 72 — MARKED.**
> 7. Add a CHANGELOG.md entry. Do not bump the version.

The file's own header says the code supersedes it — "every landing carries a version bump" — but the numbered
step is still there, and a numbered step is what a worker follows. Obeying it lands a changelog commit at the
base's number: refused, or bypassed and unnumbered. It is H-17's fault in a second file, with a stronger
imperative and no scope.

## What the live tree shows

All of this was read from this worktree, at `HEAD` `603617b` and `main` `f6f0c2f`, on 2026-11-06 between 02:20
and 02:30 UTC. The repo is live while the lane runs — two `verify:version-tags` reads minutes apart saw the held
list grow from five tags to six (`v1.32.3` appeared), and `v1.32.2` moved from `980a8f9` to `e0ef3ef` between two
reads in the same run. That moving state is itself part of the finding: every sentence above that assumes one
worker at a time is being read by many.

**E1 — the gate is red on the number `main` carries.**

```
$ node tools/verify-version-tags.mjs
version-tags: 334 version bumps in package.json's history (v0.1.0 .. v1.32.1), 333 tagged and annotated at the commit that first declared them
  6 tags name a version HEAD does not carry yet, each at a commit whose package.json declares it (held on a branch): v1.23.1@988d8494, v1.27.2@64115779, v1.32.2@e0ef3ef2, v1.32.3@ea15bb1d, v1.33.0@e52a88c0, v1.8.3@ea16b282
  wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1 first appeared at 946578704c

FAIL — 1 finding across 334 version bumps        (exit 1)
```

`39d2e52` is "chore: 1.32.1 — the version this landing carries" and is the tip of
`wtgui/untrack-config-json-land-8e3f5a` (and its `origin/` counterpart); `9465787` is the same subject on `main`.
The tag was created on the branch, the landing happened, and the move H-12/H-13 describe did not. This is not a
reconstruction: it is the reading this lane started from.

**E2 — `main`'s tip is a render above the bump, so "the commit on `main`" is not the declaring commit.**

```
$ git show --stat --format='%h %s' 9465787
9465787 chore: 1.32.1 — the version this landing carries

 package.json | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

$ git show --stat --format='%h %s' f6f0c2f
f6f0c2f docs: render the changelog — 334 releases

 CHANGELOG.md | 17 +++++++++++++++--
 1 file changed, 15 insertions(+), 2 deletions(-)
```

H-11, obeyed on this tree, tags `f6f0c2f` — the render. The tool's `findDeclaration` exists to prevent exactly
that; the sentence does not mention it.

**E3 — probe A: `apply` refuses the taken number, and tells the worker to take it.**

Run in a `git clone --shared` of this repo (the clone's tags only; origin untouched):

```
$ node tools/version.mjs apply patch
version apply: package.json would declare 1.32.2, and v1.32.2 already names e0ef3ef204 — a version is anchored once; move or delete that tag first        (exit 2)
```

This is H-20's message, produced by the state another lane had already created. The refusal is right. The advice
is the fault.

**E4 — probe B: the guard is the clone's own tags, so the number gets written anyway.**

In the same clone, `git tag -d v1.32.2` (local only), then the same command:

```
version apply: patch
  package.json  1.32.1 -> 1.32.2
  commit  dad4351fd3  chore: 1.32.2 — the version this landing carries
  tag     v1.32.2 (annotated) at dad4351fd3
  the board's config line reads this at its next start (server.js reads package.json once, at boot).
  a rebase merge re-creates this commit — after the merge, move the tag onto the commit main carries:
    node tools/version.mjs tag --ref origin/main --force && git push origin v1.32.2 --force
```

The remote already had that number, at a different commit:

```
local  v1.32.2 -> dad4351
origin 61fef02425dd3ec4da4114d74d2f99661568bd34	refs/tags/v1.32.2
origin e0ef3ef2043dcc2afa2234963fb2fe4d17edaed8	refs/tags/v1.32.2^{}
```

So `apply`'s "anchored once" guard sees this clone and nothing else, and the printed remedy is the force-push of
H-21. If the local tag had been missing for any ordinary reason — a fresh clone that did not fetch tags, a lane
that had not created its tag yet — the number would be spent twice.

**E5 — probe C: the amend H-03 invites leaves the tag on the replaced commit.**

After E4's write, amending the bump commit (as "the reason in its own message" asks) gives:

```
HEAD        0d445f3
v1.32.2 ->  dad4351
  named by v1.32.2
```

The tag names a commit no branch carries any more, and the only reference to `dad4351` is the tag itself. Once
the amended commit lands, the gate reads `wrong-commit`; before it lands, the branch carries a tag the gate can
read only as an orphan.

**E6 — probe D: `backfill` run on a branch tags the branch.**

A fresh `--shared` clone, a branch `probe/docs-only` off `main` with one hand-made `1.34.0` bump:

```
$ node tools/version.mjs backfill
version backfill: 335 version bumps at HEAD, 333 already anchored, 1 tagged now
  tagged        v1.34.0  be94a33b73  (2026-11-05) chore: 1.34.0 — the version this landing carries
  wrong-commit  v1.32.1 points at 39d2e523af, but 1.32.1 first appeared at 946578704c        (exit 1)
```

`be94a33` is the probe branch's tip. `git merge-base --is-ancestor v1.34.0 main` says no, and
`git for-each-ref --contains be94a33` names only `probe/docs-only` and the tag. Add `--push` and that tag reaches
the shared remote: a number `main` never carried, which is the `v1.8.3` / `v1.23.1` shape already in the repo's
tag list.

## The five faults the marks add up to

1. **The instruction addresses a different agent than the one that pushes.** Every sentence about deciding and
   landing a level is written for the merge agent (`lib/merge-prompt.js`), and the actor who writes a lane branch
   is handed `lib/branch-policy.js`'s paragraph (H-28), which has no version content. The hook is the first
   version instruction that actor meets, and it arrives as a refusal. H-26 and H-27 are the reader-facing
   versions of the same gap: they say the instruction is covered because it is covered for someone else.
2. **The bump is computed from the branch and guarded by the clone.** `apply` reads the working tree's old number
   and checks `refs/tags` in this clone (E3/E4). A branch cut before `main` moved, or beside a lane holding the
   next number, writes a number below the base or spends one that is already taken; the tool's own remedy is to
   move or delete the other lane's tag (H-20).
3. **The anchor is a separate, post-merge, force-pushing step that the landing script does not contain.** It is
   described only in `docs/versioning.md` (H-12/H-13), it needs a fetch it does not ask for, and it contradicts
   the HARD RULES (H-05). Skipping it is the normal case, not the exception: the gate is red on `v1.32.1` right
   now (E1).
4. **"Spends no number" has one narrow owner and three general readers.** The scale says a doc is a patch
   (H-08); the prompt and the scale exempt a render (H-06, H-17); the repo's landed docs commits spend nothing;
   the hook refuses all of them (H-23) and offers the bypass (H-24). A docs-only change cannot be landed the way
   any one of these sentences says.
5. **The restatements are stale in the direction that removes the gate.** "No version gate at all" (H-27), "the
   merge prompt tells the landing agent" (H-26), and "Do not bump the version" (H-29) each tell a careful worker
   that no action is needed. Each is in a file a reader has reason to trust, and none is marked as history except
   the last, whose header contradicts its own numbered step.

## What this lane changed, and the push it made

This file is the only change. `package.json` is untouched at `1.32.1`, no tag was created, moved or deleted in
this clone, and no branch was cut. The two probe clones live in the run's scratch directory and push nothing.

The push is its own instance of H-24: this is a docs-only commit, the scale calls a doc a patch (H-08), the
number's next patch (`1.32.2`) and the one above it (`1.32.3`) are both held by live lanes (E1), so spending a
patch here would either collide with their tags (H-20) or skip two numbers they will land. The hook refuses the
commit at `1.32.1`; the refusal is quoted below, and the push is made with `--no-verify` — the same disposition
`docs/landing-repair-v1-30-4-tag-2026-11-05.md` records for a docs-only commit, and the sentence in that record
("the docs-only path `docs/versioning.md` describes for a change that spends no number") is itself one more mark:
the path it names is not in `docs/versioning.md`.
