# Every guard between a worktree and a remote branch

A `git push` out of a tree this panel cut does not go straight out. It passes a fixed set of gates, and this page
lists them in the order a push meets them: what each one decides, where the decision is recorded, and what waives
it. Two of the gates are the panel's own (the setting and the hook it installs); the rest were already here (the
repo's hooks and the host's ruleset).

The short version: the push controls for this clone are read from `pushPermissions.repos[<repo>]` and one project's
own `pushNewBranches` / `pushExistingBranches`; a project that names nothing inherits its repository's defaults, and
anything nobody states asks. The clone's own `.githooks` are not installed, so the version gate and the
commit-subject gate are not chained; and the host's ruleset covers the default branch only. From a `wtgui/*` tree,
the instruction the tree was cut with and the two controls are what decide whether a push goes out.

## At a glance

| # | gate | where it lives | what it decides | what waives it |
|---|---|---|---|---|
| 1 | the instruction | `lib/branch-policy.js` `branchLandingLine` (the brief's LANDING line) | push + PR, or merge into the parent locally and do not push | nothing — prose, not enforcement |
| 2 | the project's push controls | `config.json` `pushPermissions.repos[<repo>]` (per-repository defaults + force-override) and `projects[].pushNewBranches` / `pushExistingBranches` (one project's own pair) | per branch kind: allow all / allow-name-gate / always ask / never | Settings → **Repo**; the two selects on the project card; `POST /api/settings/push-repo` and `POST /api/settings/push-project`; **Always allow** in the box writes that project's pair |
| 3 | the installed pre-push hook | `<git-common-dir>/wtgui-hooks/pre-push`, enabled per worktree | allows, refuses, or parks the push on the panel | `WTGUI_PUSH_GRANT=1`, `--no-verify`, `-c core.hooksPath=` |
| 4 | the permission box | `lib/remote-writes.js` + `/api/remote-write/{request,status,answer}` | once / this session / always / deny; no answer is a deny | answer it; "Always allow" writes gate 2 |
| 5 | the chained pre-push (version gate) | `.githooks/pre-push` → `node tools/version.mjs check`, reached via `wtgui-hooks/chain` | refuses a push that carries commits and no version bump | `--no-verify` |
| 6 | the commit-subject hook | `.githooks/commit-msg` | refuses a subject that names no symptom | `git commit --no-verify` |
| 7 | the panel's merge flow | `POST /api/worktree/merge` | starts (or parks, or refuses) an agent that pushes the base branch | gate 2, or the box |
| 8 | the host's ruleset | GitHub ruleset **Owner only** (`25783530`), default branch | no delete, no force, no update except through it, linear history | repository-admin bypass (`always`) |
| — | not a guard for git | `PANEL_TOKEN`, `lib/http/transport.js` `authorised` | writes to the PANEL from another machine | loopback is never challenged |

## 1. The instruction the tree was cut with

`lib/branch-policy.js` writes the LANDING line from the branch the tree was cut from:

- **parent is `main`/`master`** — "push it and open a pull request".
- **parent is any other branch** — "merge into the parent LOCALLY and do not push", because the parent has not
  landed and a remote branch of this tree lands nothing.

The same line carries `guardTail`, one sentence on what the guard will do — "a push is not asked about" under
`allow`, "will park and then fail" under `local-only`, "will fail" under `deny`. The parent is read from the panel's
record at cut time, never assumed, and it is a branch NAME: the ref `git worktree add` was told to cut from, `main`
included. (The parent book's own record is an object whose `parent` is null for a tree cut from main, because main is
not a branch to roll up into — handing that record over is how a brief once said "cut from `[object Object]`" and told
a tree in a project that allows pushes to merge locally and not push.) The record is filed under the tree's six-hex
tag, so it survives the panel renaming the tree's branch, and a reply's brief carries the tree's project policy and
remote just as the first turn's did (`POST /api/agents/reply`). When the parent still cannot be read the line is
omitted and the worker falls back to the blanket rule, which follows the policy too: `LOCAL-ONLY` under `local-only`,
`REMOTE WRITES ALLOWED` under `allow` (a worker still pushes only when the reader asks or the work is meant to land),
`NO REMOTE WRITES` under `deny`.

This is advice. The panel cannot see inside a worker's shell, which is why gates 3 and 4 exist.

## 2. The two push controls: `pushPermissions`

Two four-way controls with the same four values — one for a **NEW** branch (one the remote does not carry yet), one
for an **EXISTING** branch. The pair is what decides whether a push goes through, asks, or is refused; the old
`remoteBranchPolicy` and `allowPushWithoutAsking` keys are read only to MIGRATE an older file (see below).

| value | meaning |
|---|---|
| `allow-all` | the push goes through without asking. |
| `allow-name-gate` | the push goes through without asking ONLY when the branch name passes the gate the hook already enforces: `main`/`master`, or `YYYYMMDD_HHMM_<TICKET>_<desc>`. A name that fails the gate parks on the permission box. |
| `always-ask` (default) | the push parks on the reader's permission box. |
| `never` | refused outright, and the box is not offered. **Absolute**: it beats the project's own value, the repository's value, a force-override, and the legacy keys. |

Precedence, most specific first:

1. `projects[].pushNewBranches` / `pushExistingBranches` (one project's own pair);
2. `pushPermissions.repos[<key>].newBranches` / `existingBranches` — the repository's defaults, where `<key>` is
   `git.sefl.com/IT`, `git.sefl.com/SA`, `github/JLRoper`, `other` (any other remote) or `none` (no remote at all);
3. the shipped `always-ask`.

And one override above that walk: a repository section with `force: true` makes its two values win for every project
in it. The one thing force cannot beat is `never` — a project that says never stays refused, and so does a repository
that says never. The card renders the pair read-only (with a one-line "repo setting in force" note) while a
force-override owns it, and `POST /api/settings/push-project` answers 409 for the same reason.

`lib/push-permissions.js` is the whole model: the four values, `repoKeyForRemoteUrl`, `resolvePushPermissions`,
`branchNamePassesGate` and the `BRANCH_NAME_GATE_PATTERN` constant. `lib/push-guard.js` writes that exact pattern into
the guard's `namegate` file, so the hook's `grep -E` and the resolver's `RegExp` are one rule rather than two.

**Migration, on read.** An install that only ever knew the old keys keeps its meaning, and the file is not rewritten:

| old | new |
|---|---|
| `remoteBranchPolicy: "deny"` (global or per project) | `never` / `never` |
| `remoteBranchPolicy: "allow"`, or `allowPushWithoutAsking: true` | `allow-all` / `allow-all` |
| `remoteBranchPolicy: "local-only"`, or nothing | `always-ask` / `always-ask` |

Where to see it: `settings.pushPermissions` in `GET /api/config` and in every snapshot — the values, each repository
section with its defaults and force flag, and every project's RESOLVED pair. `GET /api/remote-write/allow-push?path=…`
(or `?project=…`, plus `?branch=…&new=1`) says what a push would meet (`permission: allow|ask|refuse`).

Where to write it: `POST /api/settings/push-repo` `{ repo, kind?, value?, force? }` and
`POST /api/settings/push-project` `{ project, kind: "new"|"existing", value }`. A value outside the four, a wrong
kind, or an unknown project is a 400/404; a project under a force-override is a 409.

## 3. The installed pre-push hook

`lib/push-guard.js` writes the hook into `<git-common-dir>/wtgui-hooks/` — inside `.git`, so it is not a tracked
file and cannot appear in a worktree's own `git status` — and enables it for ONE worktree by setting
`core.hooksPath` with `--worktree` (which requires `extensions.worktreeConfig=true`). The reader's own checkout
and every other tree keep the hooks they had.

It is installed the moment the panel cuts a tree (`jobs.afterWorktreeCreate` → `installGuardFor`), by
`POST /api/remote-write/guard` (`{action:"install"|"remove"}`), and re-written for policy on every settings change
and at boot (`refreshGuardFiles` touches only the policy/panel/window/landing files, never the hook or the config).

The directory holds the facts the hook needs as one-word files, because the hook is POSIX `sh` and does not parse
JSON:

| file | holds |
|---|---|
| `pre-push` | the hook itself |
| `panel` | the panel URL it calls back on (`http://127.0.0.1:<port>`, loopback on purpose) |
| `timeout` | how long it waits for an answer, in seconds (min 30) |
| `new-branches` | the NEW-branch control in force for this project (`allow-all` / `allow-name-gate` / `always-ask` / `never`) |
| `existing-branches` | the EXISTING-branch control in force for this project |
| `namegate` | the gate pattern, written from `BRANCH_NAME_GATE_PATTERN` — the same string the resolver compiles |
| `policy` | the legacy `local-only` / `allow` / `deny` word, still written for `GET /api/remote-write/state`; a guard installed before the two controls existed carries only this, and the hook reads it as the pair it meant |
| `landing` | one normalized tree path per line — trees started to land, which push by design |
| `chain` | the absolute path of the `pre-push` this worktree had when the guard went in (empty when it had none) |
| `wtgui-guard.json` | what the install replaced, when, and which shims it wrote |

The hook's decision order, and this is the whole of it:

1. `WTGUI_PUSH_GRANT=1` in the environment → allow, printing that no permission was asked.
2. read the ref list and take EACH ref's control: a ref the remote carries no sha for is NEW, one it carries is
   EXISTING. `never` on any ref refuses the whole push (no box); `allow-all` allows that ref; `allow-name-gate` allows
   it only when the name passes `namegate`; anything else is an ask.
3. `never` anywhere → refuse, no question offered.
4. no ref needs asking → allow (and the hook reports the write so the panel can draw its Keep/Unwind receipt).
5. the tree's normalized top level is in `landing` → allow.
6. no `panel` file, or no `curl` on `PATH` → refuse (fail closed; a guard that cannot ask is not a guard that says yes).
7. `POST /api/remote-write/request` → `allowed:true` allows; `refused:true` denies; anything else parks the push
   and prints the id. The route re-resolves the SAME refs, so a session or once grant still applies.
8. while parked, poll `/api/remote-write/status?id=…` once a second: `once` / `session` / `always` allow, `deny`
   refuses, and the window closing refuses.
9. every path that allows a push runs `chain` first, and its refusal is this hook's refusal.

Two consequences worth knowing: the hook decides per REF KIND now — a project can publish a correctly named new
branch without a question while an existing branch still asks — but the grant itself is per TREE once given. And it
is not a lock: `git push --no-verify`, `git -c core.hooksPath= push`, `WTGUI_PUSH_GRANT=1`, and a push from a
checkout the panel did not cut all go around it. It is a speed bump on the default path.

## 4. The permission box

`lib/remote-writes.js` holds the pending questions and the grants. One question is parked per attempt, keyed on the
worktree (`once` and `session` are matched on a normalized path, so `C:/x` and `/c/x` are one tree).

| answer | what it records |
|---|---|
| **Allow once** | a one-shot grant for that tree. It is spent when the hook is TOLD the answer (`GET /api/remote-write/status` calls `spend`), so a push that then fails on the version gate spends it and the next push asks again. |
| **Allow for this session** | the tree is added to an in-memory set — a panel restart asks again, by design. |
| **Always allow** | `onPolicy` writes the asking project's own pair to `allow-all` / `allow-all`, not a global key: one reader's grant about one tree does not open every other checkout. Under a force-override the write is stored but reported as not in force. |
| **Deny** | nothing is granted; the remote is untouched. |

Nothing answered inside the window is a deny: the panel's sweep runs every 5 s and denies at
`timeoutSeconds - 5`, five seconds before the hook's own window closes, so the refusal the worker sees is its own
message rather than a race. A parked question lives in the process, never in a store — a restart cannot leave a
button that does nothing.

The hook reaches the panel on loopback, which is never challenged for the panel token; a browser on another machine
answering the box needs `PANEL_TOKEN` and is refused without it.

## 5. The chained pre-push: the version gate

`.githooks/pre-push` refuses a push whose branch is not above its base's version — it runs
`node tools/version.mjs check` on the branch being pushed, and that check compares HEAD's `package.json` with the
version at `origin/main`'s current tip (never the merge-base, never the working tree's copy). A branch that did
not move the number is refused, and so is a branch that is merely behind main: it still holds the number it was
cut at, and "different from the base" is not "above the base". The check prints the branch version, the base ref
and the base version on both outcomes, so a pass is a line you can read rather than a silence you have to trust;
the hook discards that line on success. It passes when the push adds no commits (a deletion, a tag, an
up-to-date ref), and when the tool or `node` is missing, so a clone that cannot run the check still lands.
`docs/versioning.md` is the scale; `node tools/version.mjs apply <patch|minor|major>` writes the bump.

The guard never replaces this hook: whatever `pre-push` the worktree had at install time is written into `chain` and
run from every path that allows a push. But the chain is read ONCE, at install, and a worktree's own
`core.hooksPath` is the guard's directory from then on — so a `npm run hooks:install` run afterwards
(`git config core.hooksPath .githooks`, repo-wide) does not reach a guarded tree. To wire it in, remove and
re-install the guard for that tree. Anyone else's hook the install found gets a shim in the same directory instead,
so taking the hooks path never silently switches off a hook somebody else added.

Measured on this clone today: `git config --get core.hooksPath` in the main checkout prints nothing, so
`hooks:install` has not been run, the guard recorded `.git/hooks` (samples only) as its predecessor, `chain` is
empty, and this tree pushes with **no version gate at all**.

## 6. The commit-subject hook

`.githooks/commit-msg` is a gate on the commit rather than on the push, and it matters here because this repo sets
`squash_merge_commit_message = COMMIT_MESSAGES`: a squash composes main's commit out of the branch's own subjects.
It refuses the first non-comment line when it is empty, under 12 characters, ends in a full stop, ends in
whitespace, or is a bare no-op word (`wip`, `fix`, `updates`, `misc`, `cleanup`, …). Installed by the same
`npm run hooks:install`, bypassed by `git commit --no-verify`, and — for the same reason as the chain above — absent
from a tree whose hooks path the guard took before the hook was installed.

## 7. The panel's own merge flow

`POST /api/worktree/merge` starts an agent that lands a tree; its last phase pushes the base branch. So it passes
the same gate: `deny` refuses before anything starts, `local-only` parks the request on the permission box and
starts the merge only on a yes, `allow` starts it. Those are the same `decision()` and the same grants as gate 4 —
there is no second opinion.

Before that it re-reads, from git, every fact the button claims: the project owns the tree, the base branch exists,
the tree is not on the base, the branch has at least one commit off it, the tree is clean (modified and untracked
counts both zero), and no merge agent is already live for that tree. Those rules are about merging, not about
pushing, but they are what stops the panel's own write.

## 8. The host side

The repository carries one ruleset, **Owner only** (`25783530`), enforced on the default branch only
(`conditions.ref_name.include: ["~DEFAULT_BRANCH"]`):

- `deletion` — the branch cannot be deleted;
- `non_fast_forward` — no force push;
- `creation` / `update` — ref creation and every update are covered by the ruleset;
- `required_linear_history` — no merge commits: a landing has to be a squash or a rebase.

It does not touch a feature-branch push at all, so nothing on the host is in the way of putting `wtgui/*` on the
remote. And its only bypass actor is `RepositoryRole` 5 (**admin**) with `bypass_mode: always` — the API reports
`current_user_can_bypass: "always"` — so for this box's owner it is not a wall either: it is what stops everyone
else, and every non-admin token, from rewriting `main`. This repo has no CI, so nothing else checks a branch at PR
time.

## 9. Where a lane lands, and why a local `main` is not it

The ruleset in section 8 is the reason. `required_linear_history` means the only shape `origin/main` accepts from a
lane is a squash or a rebase, and `non_fast_forward` means whatever gets there cannot be rewritten afterwards. A
local `main` that lanes are merged into is therefore a dead end: its merge commits cannot be pushed, and the next
lane cut from it carries every one of them into its pull request.

Measured on 2026-10-28: local `main` was 33 commits ahead of `origin/main`, 16 of them merge commits from 15 lane
branches (28 files, 5,423 insertions), and `origin/main` was an ancestor — a clean fast-forward. The push would have
been accepted only through the admin bypass, and it would have put 16 merge commits on the branch whose rule exists
to keep them off it.

So:

- a lane branch is cut from `origin/main`, and `git fetch` plus `git rebase origin/main` is how it stays current;
- a lane lands as a pull request that is squashed on `main`; nothing is merged into the local `main`;
- a local `main` that has already drifted is not repaired by pushing it. It is replaced (`git reset --hard
  origin/main`) only after every lane it carries has landed through a pull request, because the rewrite changes
  every worktree's base and every lane branch's ancestry. That is a stopping-the-panel operation, never something a
  lane does to itself.

## What is NOT in the way

- `git push --no-verify` skips the guard AND the chained version gate, in one flag.
- `git -c core.hooksPath= push` runs no hooks at all.
- `WTGUI_PUSH_GRANT=1 git push …` skips only the panel's question; the chain still runs.
- A tree the panel did not cut — a plain checkout, a hand-made `git worktree add` — has no guard.
- Writing `<git-common-dir>/wtgui-hooks/new-branches`, `existing-branches` or `namegate` by hand changes what the hook
  decides for every tree of that clone until the panel next refreshes it (a settings change, or boot). They are mutable
  text files in `.git`, not a lock.
- A push from another clone or another machine is outside all of this; gate 8 is what is left.
- `PANEL_TOKEN` gates the panel's own HTTP writes, not git.

## Checking it

```
# the policy in force, the grants standing, and which trees carry a guard
curl -s http://127.0.0.1:7484/api/remote-write/state

# what THIS tree's hook will decide (here: the two controls, the gate, landing list, chain, panel)
cd "$(git rev-parse --show-toplevel)" && for f in new-branches existing-branches namegate chain landing panel timeout; do printf '%s: ' "$f"; cat "$(git rev-parse --git-common-dir)/wtgui-hooks/$f" 2>/dev/null || echo '(none)'; done

# is the guard in this tree's path at all?
git config --worktree --get core.hooksPath

# the repo's own hooks: installed, or inert?
git config --get core.hooksPath

# what the host enforces on the default branch, and who may bypass it
gh api repos/JLRoper/agent-worktree-gui/rulesets/25783530 --jq '{conditions,rules,bypass_actors,current_user_can_bypass}'
```
