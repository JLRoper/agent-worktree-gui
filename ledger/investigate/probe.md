# Round D: the name module on disk - stage 1 probe

Worktree: C:/ProjectDevelopment/agent-worktree-gui/.worktrees/round-d-the-name-module-on-disk-stage-1-probe-bb62d8
Branch: wtgui/round-d-the-name-module-on-disk-stage-1-probe-bb62d8
HEAD at probe time: 99f2bd7 (docs: render the changelog - 496 releases)
Working tree: clean (git status --porcelain printed nothing)

## Commands run and exact output

### Command 1

    wc -l lib/stage-tree-name.js

Output:

    95 lib/stage-tree-name.js

### Command 2

    git log --oneline -1 -- lib/stage-tree-name.js

Output:

    62b0a71 feat: a round cuts one parent tree from origin/main, and one name describes its trees

## What the two outputs say

The name module at the top of this tree is lib/stage-tree-name.js, 95 lines long on disk.
The newest commit touching it is 62b0a71, whose subject is "a round cuts one parent tree
from origin/main, and one name describes its trees". That commit is an ancestor of the
tree's HEAD 99f2bd7.

No other commands were run: no test suite, no installs, no edits beyond this file.
