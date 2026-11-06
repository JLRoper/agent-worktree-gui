# A — Version numbers: how a bump is chosen, how it is declared, and how lanes get it wrong

Read-only research. Measured in the worktree `wtgui/lane-a-the-version-numbe-505c4c` at `HEAD`
`603617b`, against `origin/main` `f6f0c2f` (which reads `1.32.1`). No product file was edited,
`package.json` was not touched, and no tag was created, moved or deleted. It landed as a docs-only PR
after rebasing onto the current `origin/main` tip. When this lane was cut, the panel's row for the
tree (attachment `2026-11-06T02-06-20`) read "Resume lane A version numbering analysis" and its tooltip
read "local only — this branch has no copy on the remote" — the first brief's "push nothing", later
superseded by the landing brief.

## In one paragraph

A bump is chosen by the landing agent, from the diff, by one question — *who outside this PR can this
break, and how much?* — and declared in four places that must agree: `package.json`'s `"version"`, the
commit whose patch first writes that value, the annotated `v<version>` tag on that commit, and the
`CHANGELOG.md` section rendered between consecutive tags. Lanes get it wrong in two ways that are easy
to conflate. Rarely, two lanes compute the same next number from the same base, and only landing order
decides who keeps it. Much more often, one landing's bump exists twice — the branch's copy and the
merge's re-creation — and the tag keeps naming the branch's copy. The number is a global resource with
no reservation; the tag is a pointer that has to be moved.

## 1. The one number

The version lives once, in `package.json`'s `"version"` (`docs/versioning.md:3`). The server reads that
field once, at boot, and hands it to the page, which prints it on the board's config line
(`v1.32.1 · 9 project(s) · …`). Two consequences follow:

- A bump is a one-line change, and `node tools/version.mjs apply` writes exactly that one line in
  place rather than re-serialising the JSON (`tools/version.mjs:487-498`). A JSON round-trip would
  reformat every key and change the file's CRLF endings — a diff nobody asked for.
- The number on screen is the build that started, not the number now in the file. A running panel
  keeps its old version until it restarts (`tools/version.mjs:531`).

Semver is read as three integers and compared as integers, not as strings (`semver`,
`compareVersions` at `tools/version.mjs:204-215`). That matters: the old check treated every value
that was not equal as "a bump", which is how `0.84.0` passed against main's `0.87.0`.

## 2. Choosing the level: a judgement, not a derivation

`docs/versioning.md:74-87` is the rule, and it is deliberately a judgement:

> A version number answers one question: *who outside this PR can this break, and how much?* That is
> a question about the diff, and the only reader who has the diff is the agent landing it.

The three levels, as the repo applies them:

| level | the test | examples from this repo | what it costs to get wrong |
|---|---|---|---|
| **major** | a contract someone outside the PR depends on breaks | a store the panel reads back changes shape (the job store, `DESCRIPTIONS_VERSION`, `assistant.json`, the charter); an action line's grammar changes (`lib/assistant/actions.js`); a route payload loses or reshapes a field; a `config.json` key is removed or renamed; a gesture is swapped (Ctrl+Enter vs Enter) | every client, bookmark, script and habit that relied on the old shape silently breaks |
| **minor** | a new capability that breaks nothing | a new section or strip; a new source of rows; a new reader-facing affordance; a new route or an additive field; a new harness that can fail a landing | a reader is told a capability exists where the number says only a fix happened — or the reverse |
| **patch** | a fix, a doc, a refactor that moves code without changing behaviour, or a test-only change | `Stop offering an approval the gateway has already decided`; anything under `docs/`; `Lift the event-to-console translator into its own module`; changing, extending or repairing a harness | a real capability ships under a number that tells nobody to look for it |

No merge on main has been landed as a major yet: `0.2.0` was declared wholesale, not derived
(`docs/versioning.md:106-107`), so the first major will be the first real break.

Two edges are easy to get wrong and are called out in `docs/versioning.md:117-121` and `:122-131`:

- **A new gate is a minor; changing an existing test is a patch.** "Put the chart's age collapse under
  a browser proof" is a capability the repo did not have. Adjusting the same harness is a patch.
- **A doc is a patch — including `docs/versioning.md` itself.** But a *render* of `CHANGELOG.md` spends
  no number at all: it is the landing's own docs commit, not a release (`docs/versioning.md:67-68`).

`node tools/version.mjs suggest` reads the branch's commits — and the PR's title and body when `gh`
has them — and prints a level with a reason per commit (`tools/version.mjs:274-316`). Its scale is
purely the conventional-commit prefix:

```
feat:                                      -> minor
fix: docs: doc: test: tests: chore:        -> patch
refactor: perf: style: build: ci: revert:  -> patch
<type>!  or  BREAKING CHANGE: in body      -> major
anything else                              -> unclassified, reported as such
```

It says so when a prefix is missing rather than folding the commit into patch
(`tools/version.mjs:124-141`), and when any commit is unclassified the printed level is a **floor**,
not an answer. `docs/versioning.md:79-80` and `lib/merge-prompt.js:116-137` both say the level is the
landing agent's call; the tool advises and the hook refuses, and neither decides.

The declaration of the level travels with the change: the bump commit's message and the PR body carry
the same one-line reason (`lib/merge-prompt.js:132-137`). A rebase merge builds main's commit body out
of the branch's own subjects, so a bump nobody explained becomes a number in main's history nobody
can account for.

## 3. Declaring it: four anchors, one order

| declaration | written by | read by | failure when it disagrees |
|---|---|---|---|
| `package.json` `"version"` | `version.mjs apply <level>` | the server at boot; `check`; the release-history walk | number unchanged, behind, or unreadable |
| the commit that first writes the value | `apply` on a clean tree, or the agent's own commit on a dirty one | `tools/release-history.mjs` | a tag anchors a commit that did not declare the number |
| annotated tag `v<version>` on that commit | `apply`, or `version.mjs tag` after a hand commit / after the merge | `verify-version-tags`, `changelog.mjs` | `missing`, `wrong-commit`, `lightweight`, `orphan-tag` |
| `## v<version>` section in `CHANGELOG.md` | `land.mjs`, at the merged tip | `changelog:check`, `land:check`, the reader | stale file, or sections naming shas the base does not carry |

The order is one motion (`docs/versioning.md:44-61`; `lib/merge-prompt.js:139-152`):

```
1. node tools/version.mjs apply <level>      # on the branch; writes, commits, tags
2. git push -u origin <branch>               # the pre-push hook runs check
3. gh pr merge <n> --rebase --admin          # the merge rewrites the bump commit's sha
4. node tools/version.mjs tag --ref origin/main --force
   git push origin v<version> --force        # move the anchor onto the commit main carries
5. npm run land                              # AT THE MERGED TIP: render CHANGELOG.md, docs commit, push
6. npm run land:check                        # "changelog: CHANGELOG.md is current — N releases"
```

### 3.1 `apply`

On a clean tree, `apply` writes the number, commits only `package.json` as
`chore: <version> — the version this landing carries`, and creates the annotated tag on that commit
(`tools/version.mjs:453-535`). On a dirty tree it deliberately stops after writing the number: a tag
belongs to a commit that carries the bump and nothing else, so it prints the dirty lines and tells you
to commit by hand and then run `node tools/version.mjs tag` (`:501-509`).

`apply` refuses a number an existing local tag already names (`:474-483`). That is its only collision
check — it never consults another branch, another worktree, or the remote.

### 3.2 `check`

`check` is the landing gate and never writes (`tools/version.mjs:318-451`). It compares the number a
push would carry — `HEAD:package.json`, **not** the working file (`:195-200`, `:343`) — with the number
at the base ref's **current tip** (`origin/main`'s tree, never the merge-base, never this checkout's
own file). It prints branch version, base ref and base version on **both** outcomes, so silence can
never be read as a pass.

It refuses, beyond a base or a version it cannot read, three states:

- no base ref resolved (`:327-339`) — a gate that cannot name its base has proved nothing;
- the branch's number is **equal** to the base's while the branch adds commits (`:406-450`) — "N
  commits are about to land with no version bump";
- the branch's number is **behind** the base's (`:407-437`) — a branch cut before main moved carries
  main's old number, and "different" is not "bumped".

It passes when the branch is strictly above the base, and when the branch adds no commits and its
number equals the base's (main itself: nothing to land, nothing to bump). At measurement, one commit
behind main and adding none of its own, it read:

```
$ node tools/version.mjs check
version check: ok — nothing to land, so nothing to bump
  branch  1.32.1  (HEAD's package.json)
  base    origin/main  1.32.1  (f6f0c2f)
  this branch adds no commits on top of origin/main; there is no change here for a number to name
```

### 3.3 `tag`

`tag` anchors the commit whose `package.json` patch **first declared** the version the ref's tree
carries — not the ref's tip (`tools/version.mjs:544-651`). It reads the number out of the ref's tree
and the commit out of the same history walk the gate reads (`tools/release-history.mjs`), so a
changelog render commit on top of a bump cannot steal the anchor. This is not theoretical: `v1.5.0`
was anchored on `5234a3c`, a commit whose patch touches only `CHANGELOG.md`, and the gate refused it
(`tools/version.mjs:26-35`). It refuses a dirty tree when the declaring commit is `HEAD`, refuses to
move an existing tag without `--force`, and is a no-op when the tag already names the right commit.

### 3.4 `verify-version-tags`

`npm run verify:version-tags` walks `git log -p --follow -- package.json` and reports:

| finding | meaning |
|---|---|
| `missing` | a version that first appeared at a commit has no `v<version>` tag there |
| `wrong-commit` | the tag points at a commit that is not the declaration |
| `lightweight` | the tag has no message; a clone cannot say what it meant |
| `orphan-tag` | the tagged commit's own `package.json` does not declare the number |
| **held** (a note, not a finding) | the tag is outside the ref's walk but its own commit declares the number — a live branch's pre-landing anchor |

The held/`orphan-tag` split is the fix recorded in `docs/version-tag-orphans-2026-11-05.md`: a branch
carrying its bump tag before landing is exactly what `docs/versioning.md` asks for, and the old gate
called it an orphan because the number was not yet in `main`'s walk. The gate now reports that as a
note; only a commit that does not declare the number is an orphan.

### 3.5 The render

`land.mjs` renders `CHANGELOG.md` from the base's own history — the shas the merge produced, never the
branch's — commits only `CHANGELOG.md`, pushes the base and proves itself by re-rendering
(`tools/land.mjs:1-38`). A render spends no version and creates no tag.

A branch that carries a bump is **expected** to read red under `npm run changelog:check` until the
merge: the section it would add names the bump commit's pre-merge sha. Rendering on the branch to clear
that red is the defect the rule exists to stop (`docs/versioning.md:63-65`).

### 3.6 The hook

`.githooks/pre-push` makes forgetting impossible for the author who installed it: on a push that adds
commits it runs `check` (`:62`), then the absolute-path gate against each pushed tree, then — for a
push of `main`/`master` — `land.mjs --check` so a base push cannot carry a stale changelog
(`:107-128`). It is fast and offline, and it is bypassable with `--no-verify` (`:21`).

## 4. How lanes get it wrong

A lane is one worktree, one branch, one landing. Every failure below comes from the same root: the
declaration is made on a branch against a base that moves, and both the number and the tag are written
before the landing owns either. When this was measured, seven of the eight lane worktrees sat on
`603617b`, one commit behind `origin/main` `f6f0c2f`; their `package.json` read `1.32.1`, exactly main's
number then.

At a glance:

| failure | symptom | caught by | measured instance |
|---|---|---|---|
| two lanes choose one number | two bump commits with different parent trees | nothing until one lands; then `check` | `v1.32.0` (`c964c534` 20:14 vs `bb814f35` 20:27); `v1.6.0` (61 s apart) |
| one landing's bump exists twice | the tag names the branch's copy | `verify-version-tags` | 48 of 51 duplicate declarations; `v1.32.1`@`39d2e52` |
| number claimed by landing order | the next landing is refused as unchanged | `check` at push | `1.32.0` taken while the config.json landing worked; it landed as `1.32.1` |
| stale base | "behind" refusal, or a bump below main's | `check` | seven lanes at `1.32.1`; `make-optym` jumped `1.30.4` → `1.32.3` |
| rebase eats the bump | commit has no `package.json` hunk | `check`, `git show --stat HEAD` | `1.31.0`'s pre-rebase `0af857b` is in no ref, rewritten as `15c1040` |
| tag left on the branch | `wrong-commit` after the merge | `verify-version-tags` | `v1.32.1`@`39d2e52` vs main's `9465787` |
| number main skipped | a tag for a version main never carried | `verify-version-tags` (held/orphan) | `v1.8.3`, `v1.23.1`; `1.25.0` held by a lane |
| tag on the render commit | anchor names a docs-only commit | `verify-version-tags` | `v1.5.0`@`5234a3c` |
| bump folded into a code commit | bump is not its own revertable unit | nothing (the tag is still correct) | `v1.30.5`@`a1421c0` |
| taking the prefix as the level | number understates or overstates the change | nothing | a `fix:` that changes a route payload |
| `--no-verify` | commits land with no number | nothing after the push | documented bypass path |

### 4.1 Two lanes choosing one number is rare; the tag naming the wrong copy is not

The distinction matters, and a sibling study (landed on main as `82e0d17`) measured it precisely
(`docs/research/version-integrity/parallel-lanes-and-one-version.md:19-24`): of 110 distinct numbers
declared by a `chore: <version>` commit, **51 appear on more than one commit**. Forty-eight of those are
the landing's own bump commit re-created by the rebase merge — mechanical and expected. One is a false
positive from a rebase with a new parent. Two are genuine: `v1.6.0` on 2026-11-04 (two landings 61
seconds apart) and `v1.32.0` on the night this was measured.

The genuine collision is visible as two bump commits whose parent **trees** differ:

```
c964c534  2026-11-05 20:14:17  wtgui/hold-a-pipeline-row-on-i-04c7d1
bb814f35  2026-11-05 20:27:36  wtgui/link-the-mermaid-pipelin-e2fc16
$ git diff --name-only c964c534^ bb814f35^ | wc -l
41
```

Both lanes computed `1.32.0` from the same base. The mermaid lane landed first, as `9123e8c` at
20:29:50; the losing lane rebased and re-bumped to `1.33.0` at 20:37:47 (`c88a342`). `c964c534` is now
reachable from nothing: the losing bump commit is discarded, so the collision leaves no durable trace
beyond a number that was spent twice.

The pairs that look like collisions are mostly the same landing twice. `9465787` (main) and `39d2e52`
(the untrack lane) differ only in `CHANGELOG.md`, and `git cherry` marks both of the lane's commits `-`:
they are the branch copy and the main copy of one landing. The same is true of `e0ef3ef`/`980a8f9`
(`1.32.2`) and `3db5e28`/`83463d4` (`1.30.4`). The number was chosen once. What went wrong is that the
tag stayed on the branch's copy after the merge re-created it — the fault in 4.5, and the one that
accounts for 48 of those 51 duplicate declarations.

So there are two lane faults here, and they are fixed by different things:

- **the genuine collision** — two lanes, one number, decided by landing order. Nothing in the repo
  reserves the number, and `apply` checks only a local tag (`tools/version.mjs:474-483`).
- **the tag on the branch copy** — one landing, two commits, and the anchor not moved. This is the
  common case and the one the gate reports.

Conflating them makes the number look like the problem. Most nights, the number was fine; the pointer
was stale.

### 4.2 The number is claimed by landing order, not by branch order

A lane that picks a number first has no claim on it. The next landing is refused as unchanged and must
re-bump above the new tip. Two consecutive landings on main are the measured case:

```
5d9e559          feat: the map is reachable from the panel's pipeline surfaces
9123e8c 20:27    chore: 1.32.0 — the version this landing carries
3ae7223          chore: config.json is the reader's own file, not the repo's
9465787 20:35    chore: 1.32.1 — the version this landing carries
```

`9465787`'s body says why the second landing is not `1.32.0`: *"origin/main read 1.32.0 at push time;
1.30.4-1.30.6 were already taken by other lanes."* Each bump is correct for its own change, but the
second number exists only because another lane reached `1.32.0` first. That is the honest outcome of a
race, and the cost is permanent: the config.json landing carries a number it did not need when it was
chosen, and its bump commit exists partly to lose the race gracefully.

### 4.3 Stale base: "behind" is a refusal, not a bump

`check` compares `HEAD`'s number with `origin/main`'s **tip**, so a lane cut before main moved is
refused: it still carries the number it was cut at, and an equal number is not a bump
(`tools/version.mjs:406-437`). When this was measured, seven of the eight lane worktrees were in exactly
that state: `603617b`, one commit behind `f6f0c2f`, `package.json` reading `1.32.1` — main's own number.
The moment such a lane commits without a bump, `check` reads "unchanged" and refuses.

A lane that resumes late pays the whole gap. `wtgui/make-optym-integration-m-b580a2` sat at
`83463d4` (`1.30.4`), was rebased onto `f6f0c2f`, and re-derived `1.32.3` (`ea15bb1`) — crossing
`1.30.5`, `1.30.6`, `1.31.0`, `1.32.0`, `1.32.1` and `1.32.2`. Its old `1.30.4` commit is no longer an
ancestor of its branch (`git merge-base --is-ancestor 83463d4 …` exits 1), and `v1.30.4` now points at
main's `3db5e28`.

The other half of the same trap is `apply` itself: it bumps whatever number the working file holds
(`:464-473`). A tree whose `package.json` was copied back from an older commit prints a number **below**
main's, which looks like a bump and is refused. Read the number you must beat before applying:

```
git show origin/main:package.json | sed -n '3p'
```

### 4.4 The bump the rebase eats

Three shapes; this history records the rewrite a rebase performs, the silent form is its sibling, and
the third follows from the base being one shared ref.

- **Conflict.** `UU package.json` stops the rebase. Resolve to the higher number; when main has passed
  you, write the next level over main's by hand (a minor over `1.32.1` is `1.33.0`) — `apply` reads the
  file, so it must hold main's number first.
- **Silent loss.** When main has already taken the same number, both sides are the identical line
  change. Git merges them, prints `Successfully rebased and updated refs/heads/…`, and the commit loses
  its `package.json` hunk with no `UU` to warn anyone. The proof is the commit, not the file:
  `git show --stat HEAD` must still list `package.json`. What this history records is the rewrite
  itself: the `1.31.0` pre-rebase commit `0af857b` is contained in no ref now, and main's `15c1040`
  is the declaration (`docs/landing-repair-v1-30-4-tag-2026-11-05.md:156-160`). The silent form — no
  conflict at all — follows from applying an identical line change; it is not a separate tool
  behaviour.
- **The check/push race.** `origin/main` is one ref shared by every worktree of the clone. A sibling
  tree's `git fetch` moves it with no command of yours, so a `check` that passed earlier proves nothing at
  push time. Run `node tools/version.mjs check` in the same shell call as the push.

### 4.5 The tag left on the branch

`apply` tags the branch commit. A rebase merge re-creates that commit under a new sha, so the anchor
must move. The tag passes through three states, and only the middle one is a finding:

| when | tag names | on `main`? | gate says |
|---|---|---|---|
| branch open, before the merge | the branch's bump commit | no | **held** (a note) |
| merged, move skipped | the branch's old commit | no, but the number is now in main's walk | **`wrong-commit`** |
| moved, as landed | main's declaring commit | yes | nothing |

Live example: `v1.32.1` points at `39d2e52` (the untrack lane's branch copy of the same landing), while
main first declared `1.32.1` at `9465787` — `wrong-commit`. Historical example: `v1.30.4` pointed at
`83463d4` (the make-optym lane's copy) while main's declaration was `3db5e28`; the repair record shows
the tag created on the remote's commit without touching the lane's anchor
(`docs/landing-repair-v1-30-4-tag-2026-11-05.md:62-108`).

The rule: a tag is a name for the declaration, not a moral claim about where the code is. Move it onto
the commit main carries, and do it in the landing, not in a later row.

### 4.6 Numbers main never carried

`v1.8.3` (`ea16b282`) and `v1.23.1` (`988d8494`) are numbers `main` skipped: it went `1.8.2` → `1.8.4`
and `1.23.0` → `1.23.2`. Their bump commits are reachable from nothing but their tags
(`docs/version-tag-orphans-2026-11-05.md:18-38`).

Skipping is also done deliberately. `7cdebf2`'s subject is
`chore: 1.26.0 — the version this landing carries (1.25.0 is held by wtgui/fix-the-two-driver-defec-72dda4)`
— a lane stepped over a number another live lane had already claimed, and `main` never declared
`1.25.0`. That is correct etiquette: a held number is skipped, not stolen. The hole it leaves is
permanent and is not a gate failure; because no commit ever declared `1.25.0`, there is not even a tag
to report. A held tag for a number `main` skipped — `v1.8.3`, `v1.23.1` — is a note, and retiring it is
a deliberate act, not something the gate forces (`docs/tag-retirement-2026-11-04.md`).

### 4.7 The tag on the render commit

`v1.5.0` was anchored on `5234a3c`, a commit whose patch touches only `CHANGELOG.md`, and the gate
refused it (`tools/version.mjs:26-35`). The mistake is easy to make by hand — resolve the ref, read its
tree, tag its tip — and it is why `tag` takes the commit from the history walk instead of the tip
(`:568-572`).

The mirror error is rendering the changelog on the branch to clear `changelog:check`. A branch that
carries a bump is supposed to read red until the merge (`docs/versioning.md:63-65`); a render there
names pre-merge shas that 404 for the reader. The render is post-merge, by `land.mjs`, as its own docs
commit, and it spends no number.

### 4.8 The bump folded into a code commit

`v1.30.5` points at `a1421c0`, a `fix:` commit whose stat is `package.json` plus `public/app.js`,
`public/style.css` and `tools/verify-push-permissions.mjs` (142 insertions, 99 deletions across four
files). The number is anchored — the gate passes — but the bump is not a separate revertable unit, and
the subject says "fix" while also declaring a release. Against the 103 `chore: <version> — the version
this landing carries` commits on main, this is the shape `apply`'s dirty-tree branch invites: it writes
the number and stops, and if the agent then commits the whole tree, `tag` anchors the mixed commit.

The cure is the order `apply` prints: commit the change first, then the number, then the tag — or let
`apply` make the bump-only commit on a clean tree.

### 4.9 Taking the tool's advice as the decision

`suggest` reads prefixes, and a prefix is a floor, not a reading of the diff. A `fix:` that reshapes a
route payload is a **major** by the question and a patch by the prefix. A `feat:` that adds nothing but
a new harness is a **minor** — coincidentally right by the prefix, but for the wrong reason. The merge
prompt is blunt about it: a tool advises, a hook refuses, neither decides; if you disagree with the
suggestion, land the level you can defend and say why (`lib/merge-prompt.js:116-137`).

The cost is invisible to every gate. `check` compares numbers; `verify-version-tags` compares tags to
declarations. Neither knows whether `1.33.0` should have been `1.32.4`. This history does not record a
mis-levelled release as a finding; the point is that no gate here would catch one if it occurred. A
wrong level is a silent contract error, not a red build.

### 4.10 The bypass

`--no-verify` skips `check`, and a local hook binds only its own author (`tools/version.mjs:446`).
There is one legitimate shape: a commit that genuinely spends no number — a changelog render, a
docs-only record — with the refusal quoted rather than hidden. `docs/landing-repair-v1-30-4-tag-2026-11-05.md:184-202`
does exactly that: it quotes the hook's refusal for a docs-only commit, says `--no-verify` was used, and
explains why the number stayed still. A lane that uses the bypass to dodge a real bump leaves main with
commits and no number, and the next gate run cannot tell that from a deliberate no-number change.

## 5. What the gates prove — and what they do not

| gate | proves | does not prove |
|---|---|---|
| `version.mjs check` | `HEAD`'s number is strictly above `origin/main`'s tip at the moment it runs | that the level is right; that the number is free on another branch; that a tag exists; that the changelog is current |
| `verify-version-tags` | every number in a ref's `package.json` history has an annotated tag at its declaring commit | that the tag's number is the right number for the change; that the tag is on the remote |
| `changelog.mjs --check` / `land.mjs --check` | the file reads the same tag history the walk does | that the sections describe the right release level |
| `.githooks/pre-push` | the pushed branch bumped, contains no new machine path, and a base push has a current changelog | anything after a `--no-verify`, or on a clone that never installed the hook |

Nothing catches, by construction: a wrong level, a bump with no stated reason, two branches declaring
the same number before either lands, a bump folded into a code commit, or a tag force-moved onto a
commit that does declare the number but is not the one main carries.

## 6. A lane's version checklist

Before choosing:

```
git fetch origin main
git rev-list --left-right --count origin/main...HEAD
git show origin/main:package.json | sed -n '3p'     # the number you must beat
node tools/version.mjs suggest                       # a floor, with a reason per commit
```

Then read the diff and choose the level. Declare it:

```
node tools/version.mjs apply <patch|minor|major>
# dirty tree? commit the change first, then:
node tools/version.mjs tag
```

The bump commit is `chore: <version> — the version this landing carries`; the PR body carries the
same line: `version: <old> -> <new> (<level>: <reason>)`.

Push, with the gate in the same shell:

```
node tools/version.mjs check && git push -u origin HEAD
```

Refused "behind"? `git fetch origin main && git rebase origin/main`, then re-bump **above the new tip**
and amend your own commit (`git log -1 --format='%h %s'` must name it). Never resolve a version
conflict to a number below main's.

After the merge, on the base:

```
node tools/version.mjs tag --ref origin/main --force
git push origin v<version> --force
npm run land
npm run land:check
```

Never:

- bump to a number a live lane holds — skip it and say so in the subject, as `1.26.0` did with `1.25.0`;
- leave the tag on the pre-merge commit;
- render `CHANGELOG.md` on the branch, or fold a render into the bump commit;
- tag a render commit;
- `--no-verify` a change that has a real bump to make.

## 7. The state at the time of writing

At measurement, `origin/main` was `f6f0c2f` and read `1.32.1`; this tree was `603617b`, one commit
behind and adding none of its own (this record's commit is the one the branch adds). Since then
`origin/main` has moved on (it read `1.32.6` at the final rebase), which is why every sha below is a
snapshot. `package.json`'s history holds **334 version bumps**; the clone holds 340 `v*` tags. The gate:

```
$ node tools/verify-version-tags.mjs --ref origin/main
version-tags: 334 version bumps in package.json's history (v0.1.0 .. v1.32.1), 333 tagged and annotated at the commit that first declared them
  7 tags name a version origin/main does not carry yet, each at a commit whose package.json declares it (held on a branch): v1.23.1@988d8494, v1.27.2@64115779, v1.32.2@e0ef3ef2, v1.32.3@ea15bb1d, v1.32.4@948fcc95, v1.33.0@28c28536, and 1 more
  wrong-commit v1.32.1 points at 39d2e523af, but 1.32.1 first appeared at 946578704c

FAIL — 1 finding across 334 version bumps        (exit 1)
```

In the same snapshot, `git tag --no-merged origin/main` listed eight: `v1.8.3`, `v1.23.1`, `v1.27.2`,
`v1.32.1`, `v1.32.2`, `v1.32.3`, `v1.32.4`, `v1.33.0`. The refs moved while this was written — the
`v1.32.2` tag target changed, and `v1.32.4` appeared — so every sha here is a snapshot of a live clone.
The mechanism it documents is not.

## 8. Sources

- `package.json:3` — the one number.
- `docs/versioning.md:3-8` — the single source, the two anchors; `:44-68` — the landing order and the
  render; `:74-87` — the level is the landing agent's judgement; `:88-131` — the three levels and their
  examples; `:133-148` — what each tool does and does not do.
- `tools/version.mjs:1-45` — the modes and their refusals; `:195-200` — `HEAD`, not the working file;
  `:204-224` — integer semver and the next number; `:274-316` — `suggest`; `:318-451` — `check`;
  `:453-535` — `apply`; `:544-651` — `tag`; `:656-724` — `backfill`.
- `tools/release-history.mjs:1-16` — the one derivation of "which commit first declared each version".
- `tools/land.mjs:1-38` — the post-merge render, and why it spends no version.
- `.githooks/pre-push:1-130` — `check`, the absolute-path gate, the base changelog gate, the bypass.
- `lib/merge-prompt.js:116-152` — the landing agent's instructions for the bump and the render.
- `docs/version-tag-orphans-2026-11-05.md` — the held/orphan split and the `v1.27.1`/`v1.28.0` moves.
- `docs/research/version-integrity/parallel-lanes-and-one-version.md` — the sibling study of duplicate
  declarations (51 of 110), the four failure modes F1–F4, and the options costed against them.
- `docs/landing-repair-v1-30-4-tag-2026-11-05.md` — the `v1.30.4` anchor created on the remote's commit,
  the wrong-commit rows, and the quoted docs-only bypass.
- `docs/tag-retirement-2026-11-04.md` — retiring a number main skipped is deliberate.
- Measured with `git log --follow -- package.json`, `git tag --no-merged origin/main`,
  `git cherry -v origin/main <branch>`, `git for-each-ref --contains <sha>`,
  `node tools/version.mjs check`, and `node tools/verify-version-tags.mjs --ref origin/main`.

## 9. This document

A docs-only research record: it spends **no version number**, creates **no tag**, and leaves
`package.json` alone. It is committed on its lane's branch and landed as a docs-only PR: one file, no
version bump. `.githooks/pre-push` refused the push exactly as this record describes, and the push used
`--no-verify` with the refusal quoted here and in the PR — not a fabricated number. The quoted refusal,
at the first push, was:

```
pre-push: refused — wtgui/lane-a-the-version-numbe-505c4c would go out with no version bump

version check: refused — 1 commit is about to land with no version bump

  branch  1.32.4  (HEAD's package.json)
  base    origin/main  1.32.4  (1c68bf6)
```
