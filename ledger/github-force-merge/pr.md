# github-force-merge / pr

Stage: pr (4 of 6)
Artifact: PR 674
Command: gh pr create --fill
Base: main (57de1d54 at open)
Head at open: 8a1b6c2a

## The PR

https://github.com/JLRoper/agent-worktree-gui/pull/674

`gh pr create --fill` produced the branch slug as the title and two commit
bullets as the body, which is not a reviewable request. The title and body were
then set from the page's four sections: what, the walk, the two gaps, the SEFL
test plan; plus the version note, the test sweep and what is checked but not
fixed.

## The read at open

gh pr view 674:
  state OPEN
  base main
  head 8a1b6c2a, the same as the pushed head
  mergeable MERGEABLE
  mergeStateStatus BLOCKED

BLOCKED is the repository's rule, not a conflict. The landing uses
--admin, which is the owner's bypass the 2026-11-09 report describes.

## Gate G4

verified_by: pr-open
Read: one PR, base main, head equals the pushed commit. The stage record commit
that follows moves the head to the record; re-read the head before the merge so
the merged head is the one the records describe.

## Next stage

merge: gh pr merge --rebase --admin. Then read the PR state and the merge commit,
and the main stage checks that the merge is an ancestor of origin/main.
