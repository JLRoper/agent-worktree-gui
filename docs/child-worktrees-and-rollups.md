# A child worktree, and rolling it back into its parent

Two controls that only make sense together, and were one feature apart: the **＋** at the right-hand end of a row cuts
a worktree **from that row's branch**, and the **UNMERGED** chip's **Roll into <parent>** merges that child's work back
**into its parent, locally**. Until the ＋ existed the panel could only cut children of the project's own checkout —
`git worktree add -b <branch> <path>` with no start ref, i.e. from HEAD, which is `main` — so the roll's target was
never a branch the panel had made, and the chip offered an outcome most rows could not reach.

Everything below was measured on a test instance of its own (see [the worked example](#a-worked-example-on-a-test-instance));
the numbers are its own.

## The ＋ in the last column

It is the leftmost of the row's three controls — **＋ ⟳ ✕** — and it is drawn only where it can act:

| row | ＋ | why |
|---|---|---|
| a worktree on a branch | yes | that branch can be a parent: a child cut from it can be rolled back into it |
| the project's own checkout | no | it is not a worktree, and its branch is the landing branch a roll may never write |
| a detached HEAD | no | there is no branch to cut from |

Its tooltip names the branch it would cut from and what the child is for; the id, class and attributes are
`btn-child-tree` / `data-child-tree` (plus `-project`, `-path`, `-branch`), and `tools/verify-child-button.mjs` holds
the order, the two suppressions and the wiring.

### The press

1. It asks one question — the panel's own prompt, the same shape the ✎ uses:

       cut a child worktree off wtgui/parent-demo-4f1a2b
       its branch: wtgui/<name>-<tag>, cut from wtgui/parent-demo-4f1a2b
       nothing is started in it and nothing is pushed — it becomes a row of its own
       name (empty = “parent-demo”):

   The name is **optional**. Empty means "name it after the branch it was cut from" (the branch's last word, minus its
   six-hex tag); anything typed goes through the same slug pass (`Child two` → `child-two`, capped at 24 characters).
   Cancel cuts nothing at all.
2. `POST /api/worktree/child {project, path, name?}` runs
   `git worktree add -b wtgui/<slug>-<tag> .worktrees/<slug>-<tag> <the row's branch>` in the project's checkout.
   The start ref is stated, never implied: this is the whole difference between this route and a spawn.
3. It writes the cut down in the two places a parent is read from — `logs/parents.json` (the ParentBook, with the tip
   the parent resolved to **at the cut**, which git forgets) and the tree's own parent record used by the landing
   paragraph a later worker is handed — and settles the name in `logs/tree-names.json`, so the panel's automatic
   rename can never move it later.
4. The new tree is boarded at once (`Scheduler.adoptWorktree`, the same door a spawn's tree comes through), so it is a
   row with its own controls in the same breath as the banner:

       cut wtgui/demo-child-222369 from wtgui/parent-demo-4f1a2b — demo-child-222369 is a row now, and its
       UNMERGED chip rolls it back into wtgui/parent-demo-4f1a2b

**What it does not do:** it starts nothing in the new tree (no agent, no run, no bill), it pushes nothing, it writes
nothing into the parent's tree — not one file, not its index — and it never touches the parent's branch.

### What it refuses, in its own words

| the row | the answer |
|---|---|
| the project's own checkout | **409** `…is the project's own checkout, not a worktree — start that work from the New-agent card` |
| a detached HEAD | **409** `…is on a detached HEAD, so there is no branch to cut from` |
| a branch the panel calls main (`main`, `master`, `trunk`, `develop`, or the project's own base) | **409** `…is a main branch — a child of it has no roll-up to arrive at; start that work from the New-agent card` |
| a branch git does not have locally | **409** `…is not a local branch of this repository, so no child can be cut from it` |
| the name is taken (directory **or** ref) | **409** `…is already there — pick another name` / `…already exists — pick another name` |

A second press is a **second child**, not an error: every cut gets its own six-hex tag, which is what makes the name
unique and what survives every later rename.

## What the roll does

The child's `UNMERGED (N commits)` badge is a button; its first outcome is **Roll into `<parent>`**. One press, and
the server runs `lib/steward.js` → `rollUp()`:

1. **The gate** (`rollGate`), refusing before anything is written: no parent resolved, a parent that is a main
   branch, a parent that is a *guess* rather than a recorded cut, a parent that is the project's `steward.prodBranch`,
   or a parent checked out in no local worktree.
2. **The parent's own worktree is read first**: `git status --porcelain` must be empty (a roll would bury uncommitted
   work), and its HEAD must be the parent branch. Nothing is done in the child's tree.
3. `git merge --ff-only --no-edit <child>` — the normal case, because a child that stayed current with its parent is
   simply ahead of it. **No merge commit**, nothing rewritten, linear history preserved.
4. If that fails (the parent has moved on since the cut), `git merge --no-edit <child>` — a real merge commit, the
   panel's house rule for diverged work. A conflict is `git merge --abort`: the parent's tree is left exactly as it
   was, and the banner says which merge conflicted.
5. Rolls are **serialised per parent branch** (an in-process writer lock), so two children of one parent cannot drive
   the same index at once; the second waits.

The answer the page reads is `{ok, method: "ff"|"merge", parentBranch, parentWorktree, childBranch, sha}` and the
banner repeats it: `rolled wtgui/demo-child-222369 into wtgui/parent-demo-4f1a2b (ff 14431d3)`.

**What it does not do:** no agent and no bill (it is one or two git commands, not a run), no push, no PR, no delete,
and it does not rewrite the child. The child's tree, branch and tip are exactly where they were; what changed is the
parent's branch, which now contains the child's commits.

### What the board shows afterwards

- **The parent's row** moves to the new tip (`ff`) or to the merge commit (`merge`), and its count against
  `origin/main` goes up by what the child added.
- **The child's row** still reads `UNMERGED (N commits)`. That is correct and not a leftover: the verdict counts the
  child against **origin/main**, and the roll only put the work on its **parent**. The child's content is one branch
  away from main, not on it.
- **The steward's plan** (`POST /api/steward`, a dry run that writes a plan and acts on nothing) reads the rolled
  child as `LANDED` — `landedIn: "parent"` — and lists its tree under *would delete*. The roll itself deletes nothing;
  removing the child is the reader's ✕ (or that plan's confirmed apply).

### Refusals the route gives (real answers from the test instance)

| what was tried | the answer |
|---|---|
| the parent's tree had one uncommitted file | **409** `refused: …(wtgui/parent-demo-4f1a2b) has uncommitted work — a roll would bury it` |
| a `parent` in the body that is not the recorded one | **409** `refused: some-other-branch is not wtgui/parent-demo-ebd796's recorded parent (wtgui/parent-demo-4f1a2b)` |
| no `confirm` | **428** `nothing was rolled: confirming starts a merge into wtgui/parent-demo-4f1a2b in its own worktree` |
| the merge would conflict | **409** `the merge conflicted and was aborted: …` — the parent's `HEAD`, `status` and `MERGE_HEAD` all as before |
| the parent is the project's production branch | **409** `refused: … is the production branch — a roll-up there is handed to a worker, never done by editing a tree` |

## A worked example on a test instance

The instance: a throwaway repo with a bare `origin`, a parent worktree cut by hand (this is the "create a worktree"
step — the panel boards any tree inside the project), and a panel started from the worktree under test with its own
`PANEL_CONFIG`, its own data directory and an empty `API_SERVER_KEY` so nothing can reach a real gateway.

```bash
S=<scratch>/inst
git init -q --bare "$S/remote.git" && git clone -q "$S/remote.git" "$S/repo" && cd "$S/repo"
git commit -qm "main: the first commit" --allow-empty && git branch -M main && git push -q -u origin main
git worktree add -q -b wtgui/parent-demo-4f1a2b .worktrees/parent-demo-4f1a2b origin/main
# …one commit in the parent's tree: 2bbe242 "parent: add a line of its own"
```

```json
{ "port": 7345, "scanRoots": ["<scratch>/inst/repos"],
  "projects": [{ "name": "rollup-demo", "path": "<scratch>/inst/repo", "remote": "origin", "mainBranch": "main" }],
  "fetchSeconds": -1, "assistant": { "enabled": false } }
```

### 1. The child, from the ＋ on the parent's row

Prompt answered `demo child`:

| | |
|---|---|
| branch | `wtgui/demo-child-222369` |
| tree | `…/repo/.worktrees/demo-child-222369` |
| cut from | `wtgui/parent-demo-4f1a2b` @ `2bbe242` |
| its parent record | `cut`, `parentSha 2bbe242`, by *the reader (＋ a child of wtgui/parent-demo-4f1a2b from its row)* |

`git worktree list` then names three trees, and the child's `HEAD` is `2bbe242` — the **parent's** tip, not
`6a511bc` (main). Its tree has the parent's file and **not** main's later commit: the cut came from the branch.

### 2. Work in the child, then roll: the fast-forward

A commit in the child (`14431d3`) and one press on **Roll into wtgui/parent-demo-4f1a2b**:

    POST /api/worktree/rollup → 200
    {"ok":true,"method":"ff","parentBranch":"wtgui/parent-demo-4f1a2b",
     "parentWorktree":"…/.worktrees/parent-demo-4f1a2b","childBranch":"wtgui/demo-child-222369","sha":"14431d3"}

    banner: rolled wtgui/demo-child-222369 into wtgui/parent-demo-4f1a2b (ff 14431d3)

From git, in the parent's tree:

    * 14431d3 (wtgui/parent-demo-4f1a2b, wtgui/demo-child-222369) child: do its own work
    * 2bbe242 parent: add a line of its own
    * 6a511bc (HEAD -> main, origin/main) main: the first commit

One new commit, no merge commit, both branches at the same sha, `parent..child` and `child..parent` both `0`, the
child's line now in the parent's `app.txt`, both trees clean, and the remote still carries only
`refs/heads/main`.

### 3. The parent moves on, and the same press conflicts

A commit in the parent (`92b5e76`) and a commit in the child (`fc92988`) both touch `app.txt`, so the roll is a real
merge — and it conflicts:

    POST /api/worktree/rollup → 409
    {"ok":false,"error":"the merge conflicted and was aborted: Command failed: git -C …/.worktrees/parent-demo-4f1a2b
     merge --no-edit wtgui/demo-child-222369","conflict":true}

The child's row and the parent's row are unchanged (`92b5e76` and `fc92988`), the parent's tree is clean, and it has
no `MERGE_HEAD`: the abort put it back exactly as it was. Nothing was half-merged and nothing was reported as rolled.

### 4. A second child, diverged but clean: a merge commit

A second ＋ on the same parent, with the name left empty, produced `wtgui/parent-demo-ebd796` at `92b5e76`. A commit
in the child (`ccfaf01`, a new file) and a commit in the parent (`2700aec`, a different new file) make the two
diverge without colliding, and the roll then does the other method:

    POST /api/worktree/rollup → 200
    {"ok":true,"method":"merge", … ,"sha":"dd69f75"}

    banner: rolled wtgui/parent-demo-ebd796 into wtgui/parent-demo-4f1a2b (merge dd69f75)

    *   dd69f75 (wtgui/parent-demo-4f1a2b) Merge branch 'wtgui/parent-demo-ebd796' into wtgui/parent-demo-4f1a2b
    |\
    | * ccfaf01 (wtgui/parent-demo-ebd796) child two: add its own note
    * | 2700aec parent: a note of its own
    |/
    * 92b5e76 parent: moves on after the roll

`git log -1 --format='%p'` prints **two** parents (`2700aec ccfaf01`), both trees are clean, and the parent's tree
holds both new files. Still nothing pushed, and neither worktree was removed.

## Limits worth knowing

- **A roll never writes a main branch.** Work reaches `main` through the merge agent or a PR; a child's work belongs
  on its parent, and the parent lands afterwards the same way any other branch does.
- **The parent has to be checked out somewhere.** A branch with no worktree cannot be merged into without making one,
  which the panel will not do on your behalf: the refusal says a worker (or you) has to make that tree.
- **Only a recorded cut is rollable.** A parent the panel *guessed* from a shared ticket id is shown on the row and
  can open the question, but never drives a merge — the ＋ is what turns a parent into a recorded fact.
- **The roll is local, and that is the point.** A child of an unpublished branch is work in progress; pushing its
  branch would put a branch nobody asked for on a repository other people share, while its parent has not landed yet.
- **The child is not deleted.** After a roll its content sits on the parent, and its own row stays until you remove it
  — safely, because the work is one merge away rather than only on that tree.
