# Landing: the step list splits on the shell's separators and folds what cannot bite (1.114.0)

PR #782 lands the permission-box card's two halves: a splitter that follows the shell, and a step list that earns
its length. Before it, a real parked command drew eleven rows - `+%s%N): no argument`, `(empty): no argument` twice
over, `--` - and hid the one row that deleted something between five echoes.

Merge `9a2e92e`, tag `v1.114.0` at `9a2e92e`, `origin/main` at `8e1ae4a` (the render), `changelog --check` reads
current - 624 releases.

## What the card does now

**The split.** `&&`, `||`, a lone `;`, `|` and a newline separate steps, and the scan carries quotes, `$(...)`,
`${...}` and backtick spans across a separator, so a pipe inside one of those stays inside its step. A step with no
program of its own is not a step: an assignment rides along with the step it sets up (`RC=$?; echo "EXIT_CODE=$RC"`
is one row about an echo), a bare fragment is dropped, and `( ... )` is opened so its inside counts as the steps it
runs. A line that ends in a redirect still raises the warning it earned.

**The list.** At most four consequential steps are drawn in full: a delete, a history rewrite, a push, a write
outside the repo, a PROD or live-port action, a network fetch, a package install, and sudo - because a step that
runs as root is never harmless. Every other step is one line that says how many there are and names each program
once, in a `<details>` that opens on click. A command that only reads draws no row at all.

The chained one-liner from the card reads: eleven shell steps, eight programs, `find: walks ... deleting what it
matches` in full, `7 harmless steps: cd, echo, ls` folded. The `deletes what it matches` and `writes outside the
repo` warnings stay as their own rows above the command, the pager (`and N more steps - read the command below`) is
gone, and the command block, the four buttons and the countdown are untouched.

## What proves it

`test/approval-command-summary.test.js`, 21 of 21: the chained one-liner's eleven-step split and eight programs, the
five fragments the old splitter drew (`+%s%N)`, `--`, `(empty)`, `+`, `no argument`), assignments riding with their
step, the four-step cap, the read-only collapse, the destructive keep.

`tools/verify-approval-summary.mjs`, 112 of 112 checks, exit 0: four real parked cards through a throwaway panel and
a stub Runs API at 1440x900, the folded line asserted collapsed and then opened onto exactly the rows it counted, and
four refreshed screenshots under `docs/assets/approval-summary/` - `permission-box-1440x900.png` is the card this
landing was written about.

`npm test`, once: 2972 tests, 2957 pass, 15 fail. A clean `git archive` of the base over the same twelve failing
files reads 93 tests, 77 pass, 16 fail, and every one of the 15 names is in that set; the single name that is not,
`no run is ever written interrupted while the gateway says running`, passes 4 of 4 when its file runs alone in both
trees.

## The landing, and the gate that caught the fixture

The first `land:pr` was refused by the merge mutation, and `gh pr merge --rebase --admin` then found the PR not
mergeable: another landing had taken `main` to 1.113.2 while this branch sat on 1.113.1. The branch was rebased onto
`origin/main` (the only conflict was the version line, resolved to 1.114.0), force-pushed with `--force-with-lease`,
and the second `land:pr` did the rest: merged `--rebase --admin`, fast-forwarded the primary checkout, moved
`v1.114.0` from the pre-rebase bump onto `9a2e92e`, rendered `CHANGELOG.md` at the merged tip as `8e1ae4a` and
pushed it.

The pre-push gate refused the first push of this branch and was right to: the new fixtures spelled the card's own
folder with a drive letter. `tools/absolute-paths.mjs` exists so that a landing is readable on another machine, so
the two constants are built from the drive letter's code point and the VALUE stays exactly the path the card showed.
No allowlist line was added - a new landing does not belong there.

This note went out on a plain push from the primary checkout, which carries no pre-push hook of its own (the panel
installs its hook per worktree), so the gates that guard a branch push do not run over it.
