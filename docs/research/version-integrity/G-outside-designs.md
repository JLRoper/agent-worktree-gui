# G — outside designs: how five release systems keep versions monotonic

**Scope.** This is the outside-designs lane of the version-integrity series: what changesets, semantic-release, Nx
release, merge queues and CalVer each do to keep a version number moving forward, cited to their own documentation,
then judged against this repository's landing path.

**Measured at.** `origin/main` `f6f0c2f` — `package.json` `1.32.1`, `CHANGELOG.md` 334 releases — on 2026-11-06.
`origin/main` moved to `1.32.4` (`e06e119`, 335 releases) while the note was being written, which is the churn this
note is about; the numbers below are the `f6f0c2f` snapshot unless a row says otherwise. Eight lane worktrees were
open on the board at the same time.

**What it lands with.** A docs-only landing: one new file, no version spent, `package.json` untouched. The pre-push
gate refuses a branch that carries commits at the base's number, docs included, so the push uses the documented
`--no-verify` bypass and the PR body carries the reason. No code changed.

## 1. "Monotonic" is three guarantees, and this repo has only one of them

The word hides three properties that are easy to conflate:

| property | what it means | what enforces it here |
|---|---|---|
| **monotonic** | a later release is never lower than the one before it | `tools/version.mjs check`, at push time: HEAD's number must be strictly above `origin/main`'s current tip; `verify-version-tags` also reports a `backwards` finding when `package.json`'s history re-declares a lower number (`tools/verify-version-tags.mjs:42-50`) |
| **unique** | no two releases, or two commits, carry the same number | nothing across branches; the gate compares one branch with one base |
| **gapless** | the numbers between two releases were actually used | nothing; a branch's bump can be dropped, or a number can be claimed by a branch that never lands |

The push gate buys the first property only at the moment of the push; the tag gate audits history for a backwards
transition after the fact. Neither can see a base that moves after the push, and neither has a view of a number
another branch has already claimed. The history shows all three failures:

- **Same number, three branches.** Three docs PRs were cut from `dac78f1` (0.46.3) and each bumped itself to
  **0.46.4** — the same number main's own `21aa536` took. One rebase finished with no conflict at all because both
  sides wrote the same value; git dropped the bump silently, leaving a branch the pre-push gate then refused as
  unbumped while `git log` still showed the bump subject (`docs/landing-three-open-prs-2026-11-01.md`).
- **A number held by a branch.** Main's bump commit reads `chore: 1.26.0 — the version this landing carries (1.25.0
  is held by wtgui/fix-the-two-driver-defec-72dda4)` (`7cdebf2`). The number was spent by a branch that had not
  landed, so main skipped it.
- **Numbers skipped, not reused.** Main went `1.8.2` → `1.8.4` and `1.23.0` → `1.23.2`; the bump commits that
  declared `1.8.3` and `1.23.1` were made on branches that never landed, and the tags are now reachable from
  nothing but themselves (`docs/version-tag-orphans-2026-11-05.md`).
- **Numbers spent in sequence by hand.** A landing note records the brief asking for "the next free minor at landing
  time": `0.53.0` was spent by PR #196, `0.54.0` by PR #202, `0.55.0` by PR #203, so the branch took `0.56.0`
  (`docs/landing-assistant-queue-2026-11-02.md`).

Every design below is a different answer to one question: **where is the number decided, relative to the merge that
makes it true?** The repo decides on the branch, before the merge, and then trusts a gate at push time. A rebase
merge re-creates the branch's commits afterwards, so the decision can be replayed onto a base that has since spent
it. That is a time-of-check-to-time-of-use gap, not an incrementing bug. Each design below closes it in a different
place — after the merge, at the release run, at dequeue, or by construction — and the merge queue narrows the window
without ever touching the number.

## 2. Changesets

**What it is.** A changeset is a small Markdown file committed with the PR. Its YAML front matter maps each package
to `major`, `minor` or `patch`; its body is the changelog entry. The docs call it "an intent to change" and store it
under `.changeset/<id>.md` [1].

**How it keeps the number moving.** `changeset version` "combines all changesets, creates one version bump for each
package based on the maximum version bump of each package, updates dependencies where needed, and writes
changelogs" [1]. It is a reduction over the pending files: ten patch changesets and one minor changeset produce one
minor bump, not eleven bumps. The command "takes changesets that have been made and updates versions and
dependencies of packages, as well as writing changelogs" [3]. The tags come later: `changeset publish` "creates git
tags for each package by default", and in a single-package repo the tag is `vX.X.X` [2]. The publish step assumes
"the last commit is the version commit", so nothing may be committed between `version` and `publish` [3].

**What that guarantees, and what it does not.** The version is computed from the version currently written in each
package's manifest, then one relative bump is applied [3]. A consumed changeset is deleted, so it cannot be applied
twice. That makes the release train monotonic and gapless *on the branch where `version` runs*. It does not make the
result unique across branches: two "Version packages" branches cut from the same commit read the same current
version and compute the same next one. The documented flow is a version step on the release branch, then a separate
publish [2][3]; nothing in `version` compares its result with a remote base or a registry.

**Fit here.** This is the closest of the five to the repo's existing shape, because the repo already asks for the
bump to travel with the change; the changeset merely separates the *intent* from the *number*.

- **What it would cost us.** One dev dependency (`@changesets/cli`) in a repository whose `dependencies` is `{}` and
  which has no other build tooling; a `.changeset/` directory and a changeset in every PR; a version step after the
  merge (or a standing "Version packages" PR); and a second changelog writer competing with `tools/changelog.mjs`.
  For one package, the CLI is a wrapper around the one-line edit the repo already does.
- **What it would break.** `docs/versioning.md`'s rule that the bump lands "in the same PR as the change it
  describes", so that one branch is one revertable unit. Once `changeset version` runs after the merge, reverting
  the change no longer reverts its number. It also empties the pre-push gate: a branch carries an intent, not a
  number, so `tools/version.mjs check` has nothing to compare and the hook that makes forgetting impossible would
  have to go. And the post-merge render becomes a contest between two changelog formats.
- **The shape that fits.** Borrow the intent file, not the release train: keep a changeset-style note in the PR as
  the reviewable statement of level and reason, and keep `node tools/version.mjs apply` at landing. That preserves
  the one-commit rule and the gate, and costs a file per landing rather than a dependency and a second release
  process.

## 3. semantic-release

**How it keeps the number moving.** semantic-release runs in CI on a configured release branch. Its pipeline
"Obtain[s] the commit corresponding to the last release by analyzing Git tags", then "Determine[s] the type of
release based on the commits added since the last release" [5]. A `fix` is a patch, a `feat` is a minor, and a
`BREAKING CHANGE` footer is a major; if no commit since the last tag carries a recognized type, no release is
published [4]. The next number is therefore a function of the tag history and the commits after it — not of a value
written on the branch. That is the strongest monotonicity story of the five: there is no branch-carried number to
collide, because the number does not exist until the release run computes it.

**The guard rails.** When several release branches are configured, "the order of the release branch definitions is
significant, as versions released on a given branch must always be higher than the last release made on the previous
branch", and a run that would publish an existing version with a different codebase fails with
`EINVALIDNEXTVERSION` [6]. The documentation is explicit that "a release version must be unique, independently of
the distribution channel" [6].

**Where it hurts.** The last release commit must be in the release branch's history. The configuration page says:
if the commit is not in the branch history, "the commit sha has been rewritten (with git rebase)" is one of the two
causes, and the fix is to put the last release commit back into the release branch's history [7]. That is precisely
what a rebase merge does to every commit on a landing branch. A tag created on the branch before the merge names a
commit main never had; a tag created after the merge has to be re-anchored, which is the repair this repo has
already had to run (`docs/landing-repair-v1-30-4-tag-2026-11-05.md`, `docs/version-tag-orphans-2026-11-05.md`).
semantic-release also assumes it owns publishing and the tag push; running it with `--no-ci` on a developer machine
forfeits the determinism it exists for [7].

**Fit here.** No. This repo has no CI (`.github/workflows` is absent; `README.md:190` says "this repo has **no
CI**"), it does not publish a package, and its house merge is `gh pr merge --rebase --admin`, which rewrites the
very shas semantic-release uses as its anchor. The one idea worth taking is its source of truth: compute the next
number from tags at release time, not from the branch. `tools/release-history.mjs` already walks the same history;
the missing half is doing that walk at the merge rather than at the push.

## 4. Nx release

**How it keeps the number moving.** Nx release supports "version plans": Markdown files under
`.nx/version-plans/` whose front matter maps a project (or release group) to a bump, exactly the changeset idea
[8]. `nx release` applies the plans, and "once a particular version plan has been applied it will be deleted from
the `.nx/version-plans/` directory so that it does not inadvertently get applied again" [8]. A `nx release
plan:check` command can fail a PR when a touched project has no plan [8]. The current version is resolved from a
configured source — the docs name "disk vs registry vs git tags" [8] — and a relative semver bump is applied to it.
With conventional commits enabled, Nx "will use the commit messages since the last release to determine the version
bump" and take the highest of them; with no relevant commits it skips the release [9]. By default it stages the
changed manifests and changelogs, commits them, and creates the tag (`v{version}` for a single project)
[10][11].

**What that guarantees.** The plan is consumed exactly once, the current version comes from an advancing source,
and the commit and tag are made in one motion. That is a real improvement over a branch-carried number — provided
the source is the tag or the registry, not the checkout. When no matching tag exists, Nx either errors and tells you
to create one or use `--first-release`, or falls back to the version on disk if configured to [8][11]; a disk
fallback is the same stale-checkout hazard as changesets.

**Fit here.** Mechanically it fits the three constraints: it runs locally, needs no CI, and a rebase merge only
moves the tag, which Nx can re-anchor. But it is the worst value of the three that fit.

- **What it would cost us.** The Nx package itself (a large dev dependency), an `nx.json` with a project graph, a
  release group and version-plan configuration, and a second CLI that every landing agent has to learn — for one
  package. The repo currently has zero dependencies and one 80-line history walker.
- **What it would break.** The zero-dependency install and the "one command" property of the gate. It also
  duplicates `tools/release-history.mjs`: Nx's `git-tag` resolver and the repo's declaration walk would be two
  implementations of the same question, which is the kind of drift `docs/versioning.md` exists to prevent. And its
  default `git commit` + `git tag` is a second writer on top of `version.mjs apply`, not a replacement for the
  repository's tag-anchor rule.
- **The shape that fits.** Take `currentVersionResolver: git-tag` as a design constraint, not as a dependency:
  resolve the current version from the tag at merge time. The repo already has the walk; the gap is when it runs.

## 5. Merge-queue versions

**What the queue does.** GitHub's merge queue takes PRs that have passed the required checks and merges them
first-in-first-out, validating a *group* against "the latest version of the `base_branch` as well as changes from
pull requests ahead of it" [12]. It creates temporary branches — third-party CI is told to watch the
`gh-readonly-queue/{base_branch}` prefix — and those branches "contain a different `sha` from the pull request"
[12]. The merge method is configurable: merge, rebase, or squash [12].

**Where the version comes in.** The queue does not version anything. It serializes the *application* of changes. If
the number is assigned when the group is validated or when it is dequeued, each group sees the previous group's base
and can increment from it; that is what makes "merge-queue versions" monotonic. If each PR carries its own number,
the queue is happy to merge two PRs that both say `1.33.0`; the second bump is a no-op against the first, and the
queue reports success. The queue guarantees a moving base, not a unique number.

**Fit here.** The product does not fit. Merge queues are "available in any public repository owned by an
organization, or in private repositories owned by organizations using GitHub Enterprise Cloud" [13]; this repo is
public but owned by a user (`JLRoper`), not an organization. A queue also "will wait for required checks to be
reported" [12], and the repo's ruleset has no required status checks at all — its rules are `deletion`,
`non_fast_forward`, `creation`, `update` and `required_linear_history`, and its only bypass actor is
`RepositoryRole` 5 (admin) with `bypass_mode: always` (`gh api repos/JLRoper/agent-worktree-gui/rulesets/25783530`).
Every merge here is the admin bypass, `gh pr merge --rebase --admin`. A queue would either be unavailable or wait
forever for checks that do not exist.

**The pattern that does fit.** Assign the number at dequeue, not at cut. This does not need GitHub's queue: it is a
fresh fetch plus `node tools/version.mjs check` immediately before `gh pr merge`, and a renumber if the base has
moved. The repo already does this by hand — the `0.53.0`/`0.54.0`/`0.55.0` sequence in
`docs/landing-assistant-queue-2026-11-02.md` is that discipline under another name. What is missing is that it is a
habit, not a step in the pipeline.

## 6. CalVer

**How it keeps the number moving.** CalVer derives the number from the release calendar: `YYYY.0M.0D` for a full
date, `YY.0M` for Ubuntu, `YY.M.MICRO` for Twisted, and so on [14]. The number is a function of *when* the release
happened, not of a counter a branch carries. Two releases on the same day are separated by an appended micro:
`2026.9.11`, then `2026.9.11.1` [14]. A leading zero marks padding; a single letter is the plain number [14].

**What that guarantees, and what it does not.** Time moves in one direction, so a release line that follows the
calendar is monotonic by construction and needs no gate to stay that way. Same-day collisions have an explicit
answer. But CalVer "deliberately does not attempt to communicate breaking changes" [14]: a major/minor/patch
judgement has no home in it. It also orders by release time, not by lineage: a backport or a release rebuilt for an
older line gets a later date and sorts above the mainline, which is monotonic by date and wrong by history. And a
scheme with a fourth segment or zero-padding is not the three-numeric-segment shape this repo's tools parse.

**Fit here.** This is the only one of the five that removes the collision instead of managing it, and the panel's
version is in fact a build identity — the server reads `package.json` and prints it on the board's config line, not
a promise to a package consumer (`docs/versioning.md:3`).

- **What it would cost us.** A rewrite of the tag parser and comparator: `tools/release-history.mjs` declares
  `VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/` (`:21`) and `compareVersions` reads exactly three segments (`:47`). A
  four-segment `YYYY.M.D.MICRO` is not a version tag at all to that parser, and `compareVersions` ignores the fourth
  segment entirely, so `2026.11.6.1` and `2026.11.6.2` compare equal — two same-day releases would be
  indistinguishable to the gate. Padding is a second hazard: `parseVersionTag` normalizes `2026.11.06` to
  `2026.11.6`, while the declaration lookup in `readReleaseHistory` asks for the exact `v<version>` string, so a
  scheme that pads in one place and not the other produces a missing tag. `version.mjs suggest` would also need a
  new meaning (a `feat` no longer implies minor), and `docs/versioning.md`'s three-level scale would have to be
  retired or rewritten.
- **What it would break.** The major/minor/patch judgement that the whole landing prompt is built around, and the
  continuity of 334 rendered sections and 339 tag refs at the snapshot: the first CalVer release sorts above every
  `1.x` tag (`compareVersions` reads `2026` > `1`), so the changelog stays ordered, but the number jumps from
  `1.32.4` to something like `2026.11.6` and no reader can compare the two. It also breaks the "a version answers
  who outside the PR this can break" question in `docs/versioning.md`; CalVer's own FAQ says that is not its job.

## 7. The three that fit

"Fit" here means compatible with the constraints the brief names: no package consumers, a rebase-merge landing and a
ruleset whose only bypass is the owner's admin role. The brief calls the repo private; `gh repo view` measures it
**public** (`visibility: PUBLIC`, `isPrivate: false`, owner `JLRoper`). The distinction changes only two answers —
merge-queue availability (still no: user-owned, not an organization) and npm publishing (not done either way) — so
the judgement stands, with those two caveats.

| design | property it buys | cost | what it breaks |
|---|---|---|---|
| **Changesets** | one bump per release, from an accumulated intent; version decided after the merge | one dev dependency, `.changeset/` per PR, a version step or version PR, a second changelog writer | the same-PR bump rule; the pre-push gate's branch comparison; one revertable unit |
| **Nx release** | the same plan idea plus a tag/registry resolver and commit+tag in one command | Nx, `nx.json`, a project graph, release groups, a second CLI for one package | zero-dependency install; the one-command gate; duplicate history walks |
| **CalVer** | monotonic by construction; same-day collisions handled by the micro | rewrite the 3-segment parser/comparator, `suggest`, the versioning scale, 334 sections of history | major/minor/patch meaning; the tag gate if padded or four-segment; continuity at the switch |

**Changesets — cost and break, plainly.** It costs a dependency and a release step the repo does not have, and it
breaks the rule that the number travels in the same commit as the change. If the changeset is applied on the branch
instead, to keep that rule, it buys nothing over the one-line bump the repo already has. The useful half is the
intent file; the release train is the half that does not fit.

**Nx release — cost and break, plainly.** It is the most expensive way to get the changeset idea. It costs a build
system where there is none, and it breaks the zero-dependency property that makes `npm test` and the hooks portable.
Its one genuinely better idea, resolving the current version from the git tag rather than the checkout, is already
implemented in `tools/release-history.mjs`; the repo would gain a second implementation, not a new capability.

**CalVer — cost and break, plainly.** It makes a collision structurally unlikely — same-day releases take the
micro, and the number follows the calendar — and it costs the meaning of the number. It breaks the three-level
judgement, the three-segment tag parser and the continuity of the changelog; it is worth considering only if the
repo decides the version is a build stamp and nothing else, and then the change should be a deliberate
versioning-policy change, not a tool swap.

## 8. The two that do not fit

**semantic-release.** It needs CI, a release branch whose history contains the last release commit, and a tag it
owns. This repo has no CI, rebase-merges every PR (which rewrites the shas its "last release" lookup depends on),
and does not publish a package. The cost of making it fit — a CI provider, a release workflow, a tag-repair step
after every merge — is larger than the problem. The idea to keep is "compute the number from tags at release time".

**Merge queue.** The product is unavailable to a user-owned repository (public: organization-owned only; private:
GitHub Enterprise Cloud organization) and needs required status checks this ruleset does not have. Every merge here
is already an admin bypass. The idea to keep is "assign the number at dequeue"; the queue itself is infrastructure
the repo would have to buy before it could use it.

## 9. What this means here

1. **The gate is the right shape; the window is the defect.** `tools/version.mjs check` already refuses a number at
   or below the base. What it cannot see is a base that moves between the push and the merge. Close that with a
   fresh fetch and a second `check` immediately before `gh pr merge`; on a refusal, renumber above the new base,
   re-tag, re-push, then merge. That is the merge-queue discipline without the queue, and it addresses the
   0.46.4 ×3, the held `1.25.0` and the `0.53`/`0.54`/`0.55` sequence directly.
2. **If a structural change is wanted, take the changeset intent, not the release train.** A `.changeset`-style
   file in the PR makes the level and the reason reviewable without moving the number out of the commit. Keep
   `apply` at landing and the gate in the hook.
3. **Do not adopt CalVer to fix collisions.** It fixes them and costs the scale. If the scale is ever retired, do it
   as a policy change with a migration note for the 334 sections and 339 tags, not as a side effect of a release
   tool.
4. **Do not adopt Nx or semantic-release for one package with no CI.** Both are release systems for a shape this
   repo does not have; the parts worth copying are already present in `tools/release-history.mjs` and
   `tools/version.mjs`.

The short version: the repo is not failing to increment. It is deciding the number too early. Changesets and Nx move
the decision later and pay for it with a release process; CalVer removes the decision and pays for it with the
meaning; the merge queue moves it to dequeue and needs infrastructure this repo does not have. The cheapest fix is
to move the decision to the last possible moment the repo already controls — immediately before the merge — and to
keep the gate that makes the decision visible.

## 10. Sources

External, read 2026-11-06:

1. Changesets, "A Detailed Explanation of Changesets" — https://changesets-docs.vercel.app/detailed-explanation.html
2. Changesets, "Versioning and Publishing" — https://changesets.dev/guide/versioning-and-publishing
3. Changesets, "Command Line Interface" — https://changesets.dev/guide/cli
4. semantic-release, "How it Works" — https://semantic-release.org/foundation/how-it-works/
5. semantic-release, "Introduction" (release steps) — https://semantic-release.org/intro/
6. semantic-release, "Release Workflow Configuration" — https://semantic-release.org/foundation/workflow-configuration/
7. semantic-release, "Configuration — Existing version tags" — https://semantic-release.org/usage/configuration/
8. Nx, "File Based Versioning (Version Plans)" — https://nx.dev/docs/guides/nx-release/file-based-versioning-version-plans
9. Nx, "Automatically Version with Conventional Commits" — https://nx.dev/docs/guides/nx-release/automatically-version-with-conventional-commits
10. Nx, "Manage Releases" — https://nx.dev/docs/features/manage-releases
11. Nx, "Release TypeScript/JavaScript Packages to NPM" — https://nx.dev/docs/guides/nx-release/release-npm-packages
12. GitHub Docs, "Managing a merge queue" — https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
13. GitHub Docs, "Merging a pull request with a merge queue" — https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request-with-a-merge-queue
14. CalVer, "Calendar Versioning" — https://calver.org/

Internal:

- `docs/versioning.md` — the one number, the three levels, the tag anchor and the post-merge render.
- `docs/pushing-to-a-remote.md` — gate 8, the `Owner only` ruleset and the admin bypass.
- `docs/version-tag-orphans-2026-11-05.md` — the four orphan tags and the skipped numbers.
- `docs/landing-three-open-prs-2026-11-01.md` — three branches at 0.46.4 and the silent drop.
- `docs/landing-assistant-queue-2026-11-02.md` — the 0.53.0 / 0.54.0 / 0.55.0 spending sequence.
- `docs/landing-repair-v1-30-4-tag-2026-11-05.md` — the post-rebase tag repair.
- `tools/release-history.mjs` — the declaration walk, `VERSION_TAG` and `compareVersions`.
- `tools/version.mjs` — `check`, `apply`, `tag`, `backfill`.
- `README.md:190` — "this repo has **no CI**".

## 11. Measured evidence

All of the following were read in this worktree on 2026-11-06, not recalled. The base and the tag count moved while
the note was being written, so a number that is a snapshot says so.

| read | result |
|---|---|
| `git log -1 origin/main --format='%h %s'` | `e06e119 docs: render the changelog — 335 releases`; the base was `f6f0c2f` (1.32.1, 334) at the first read |
| `git show origin/main:package.json` | `"version": "1.32.4"` |
| `git rev-list --left-right --count origin/main...HEAD` | `0 1` — the one landing commit, after the rebase onto `e06e119` |
| `grep -m1 '"version"' package.json` | `1.32.4` — unchanged from the base; this landing spends no number |
| `grep -c '^## v' CHANGELOG.md` | `335` now; `334` at the `f6f0c2f` snapshot |
| `git tag -l 'v*' \| wc -l` | `342` now; `339` at the first read |
| `git rev-parse -q --verify 'refs/tags/v1.32.2^{commit}'` | `e0ef3ef` — another lane's pre-landing anchor, no remote tag |
| `git rev-parse -q --verify 'refs/tags/v1.33.0^{commit}'` | `28c2853` — another lane's pre-landing anchor, no remote tag |
| `git ls-remote --tags origin 'refs/tags/v1.32.4*'` | the tag is on the remote; `1.32.4` is the base this note rebased onto |
| `gh repo view --json visibility,isPrivate,owner` | `PUBLIC`, `false`, `JLRoper` (user) |
| `gh api repos/JLRoper/agent-worktree-gui/rulesets/25783530` | rules `deletion`, `non_fast_forward`, `creation`, `update`, `required_linear_history`; `bypass_actors: [{actor_type: RepositoryRole, actor_id: 5, bypass_mode: always}]`; `current_user_can_bypass: always` |
| `ls .github/workflows` | absent |
| `python -c "import json; print(json.load(open('package.json'))['dependencies'])"` | `{}` |
| `grep -n 'VERSION_TAG' tools/release-history.mjs` | `:21` — `/^v(\d+)\.(\d+)\.(\d+)$/` |
| `grep -n 'compareVersions' tools/release-history.mjs` | `:47` — three numeric segments |
| `ls -d ../lane-* \| wc -l` | `8` open lane worktrees |
