# Every guard between a worktree and a remote branch

A `git push` out of a tree this panel cut does not go straight out. It passes a fixed set of gates, and this page
lists them in the order a push meets them: what each one decides, where the decision is recorded, and what waives
it. Two of the gates are the panel's own (the setting and the hook it installs); the rest were already here (the
repo's hooks and the host's ruleset).

The short version, measured on this clone: the setting for this project is `allow`, so the guard lets a push
through without asking; the clone's own `.githooks` are not installed, so the version gate and the commit-subject
gate are not chained; and the host's ruleset covers the default branch only. From a `wtgui/*` tree, the only thing
that stops a push today is the instruction the tree was cut with.

## At a glance

| # | gate | where it lives | what it decides | what waives it |
|---|---|---|---|---|
| 1 | the instruction | `lib/branch-policy.js` `branchLandingLine` (the brief's LANDING line) | push + PR, or merge into the parent locally and do not push | nothing — prose, not enforcement |
| 2 | the project's policy | `config.json` `remoteBranchPolicy`, overridden per project by `projects[].remoteBranchPolicy` | every tree is local only / writes allowed / refused outright | Settings → **Branches on the remote**; `POST /api/settings/remote-branches`; **Always allow** in the box |
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
record at cut time, never assumed; when it cannot be read the line is omitted and the worker falls back to the
blanket rule.

This is advice. The panel cannot see inside a worker's shell, which is why gates 3 and 4 exist.

## 2. The setting: `remoteBranchPolicy`

Three values, and the names say exactly what they govern — whether a branch may exist on a remote at all.

| value | meaning |
|---|---|
| `local-only` (default) | every tree the panel cuts stays on this box. A remote write is refused unless the reader grants it through the permission box — requested either by the installed hook or by the panel's own merge flow. |
| `allow` | remote writes go through without asking. This is what **Always allow** in the box writes, so the box and the setting are one fact. |
| `deny` | never, and do not even ask: the guard refuses without offering a choice. |

Precedence is project, then global, then the closed default:

1. `projects[].remoteBranchPolicy` in `config.json`, when it is one of the three values;
2. else the global `remoteBranchPolicy`;
3. else, and for any value that cannot be read, `local-only` — an unreadable value never opens the door.

`lib/remote-writes.js` `policyForProject` is the one function; `POST /api/remote-write/request` and the merge route
both call it with the tree's own project, so a tree in a repo that lands by PR is not decided by another repo's
setting. This panel and `heroes-js` carry `allow`; every other checkout inherits the global.

Where to see it: `GET /api/remote-write/state` (`policy`, `label`, `policies`, `guards`),
`settings.remoteBranchPolicies` in `GET /api/health`, and the `policy` on each tree in `logs/push-guard.json`.

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
| `policy` | `local-only` / `allow` / `deny` for this project |
| `landing` | one normalized tree path per line — trees started to land, which push by design |
| `chain` | the absolute path of the `pre-push` this worktree had when the guard went in (empty when it had none) |
| `wtgui-guard.json` | what the install replaced, when, and which shims it wrote |

The hook's decision order, and this is the whole of it:

1. `WTGUI_PUSH_GRANT=1` in the environment → allow, printing that no permission was asked.
2. `policy` file is `allow` → allow.
3. the tree's normalized top level is in `landing` → allow.
4. `policy` is `deny` → refuse, no question offered.
5. no `panel` file, or no `curl` on `PATH` → refuse (fail closed; a guard that cannot ask is not a guard that says yes).
6. `POST /api/remote-write/request` → `allowed:true` allows; `refused:true` denies; anything else parks the push
   and prints the id.
7. while parked, poll `/api/remote-write/status?id=…` once a second: `once` / `session` / `always` allow, `deny`
   refuses, and the window closing refuses.
8. every path that allows a push runs `chain` first, and its refusal is this hook's refusal.

Two consequences worth knowing: the hook decides per TREE, not per ref or per remote — once a tree may push, it may
push any ref to whatever `git push` names. And it is not a lock: `git push --no-verify`, `git -c core.hooksPath=
push`, `WTGUI_PUSH_GRANT=1`, and a push from a checkout the panel did not cut all go around it. It is a speed bump
on the default path.

## 4. The permission box

`lib/remote-writes.js` holds the pending questions and the grants. One question is parked per attempt, keyed on the
worktree (`once` and `session` are matched on a normalized path, so `C:/x` and `/c/x` are one tree).

| answer | what it records |
|---|---|
| **Allow once** | a one-shot grant for that tree. It is spent when the hook is TOLD the answer (`GET /api/remote-write/status` calls `spend`), so a push that then fails on the version gate spends it and the next push asks again. |
| **Allow for this session** | the tree is added to an in-memory set — a panel restart asks again, by design. |
| **Always allow** | `onPolicy("allow")` writes `config.json`'s `remoteBranchPolicy`: the setting, not a private list. It is the GLOBAL key, so it also turns off asking for project trees with no override of their own. |
| **Deny** | nothing is granted; the remote is untouched. |

Nothing answered inside the window is a deny: the panel's sweep runs every 5 s and denies at
`timeoutSeconds - 5`, five seconds before the hook's own window closes, so the refusal the worker sees is its own
message rather than a race. A parked question lives in the process, never in a store — a restart cannot leave a
button that does nothing.

The hook reaches the panel on loopback, which is never challenged for the panel token; a browser on another machine
answering the box needs `PANEL_TOKEN` and is refused without it.

## 5. The chained pre-push: the version gate

`.githooks/pre-push` refuses a push that carries commits while `package.json` still holds the base's version — it
runs `node tools/version.mjs check` on the branch being pushed. It passes silently when the push adds no commits (a
deletion, a tag, an up-to-date ref), and when the tool or `node` is missing, so a clone that cannot run the check
still lands. `docs/versioning.md` is the scale; `node tools/version.mjs apply <patch|minor|major>` writes the bump.

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

## What is NOT in the way

- `git push --no-verify` skips the guard AND the chained version gate, in one flag.
- `git -c core.hooksPath= push` runs no hooks at all.
- `WTGUI_PUSH_GRANT=1 git push …` skips only the panel's question; the chain still runs.
- A tree the panel did not cut — a plain checkout, a hand-made `git worktree add` — has no guard.
- Writing `<git-common-dir>/wtgui-hooks/policy` by hand changes what the hook decides for every tree of that clone
  until the panel next refreshes it (a settings change, or boot). It is a mutable text file in `.git`, not a lock.
- A push from another clone or another machine is outside all of this; gate 8 is what is left.
- `PANEL_TOKEN` gates the panel's own HTTP writes, not git.

## Checking it

```
# the policy in force, the grants standing, and which trees carry a guard
curl -s http://127.0.0.1:7484/api/remote-write/state

# what THIS tree's hook will decide (here: policy, landing list, chain, panel)
cd "$(git rev-parse --show-toplevel)" && for f in policy chain landing panel timeout; do printf '%s: ' "$f"; cat "$(git rev-parse --git-common-dir)/wtgui-hooks/$f" 2>/dev/null || echo '(none)'; done

# is the guard in this tree's path at all?
git config --worktree --get core.hooksPath

# the repo's own hooks: installed, or inert?
git config --get core.hooksPath

# what the host enforces on the default branch, and who may bypass it
gh api repos/JLRoper/agent-worktree-gui/rulesets/25783530 --jq '{conditions,rules,bypass_actors,current_user_can_bypass}'
```
