# Landing: a SPAWN that carries a queue row cuts a pushable tree (1.149.0)

A research tree is local only until somebody lifts it: `lib/push-permissions.js` `treeKindRefusal` answers with a
refusal before the policy, the controls, the landing mark or any grant, so a worker in one that was never lifted is
refused at push time. Three landings in one evening met that refusal and paid for it with a hand lift. The first was
PR #819 (the one-diamond landing, `2e6889d2`); the second was PR #821 (the kind control, `fb46b15`); and on
2026-11-21 both live trees were recorded research and unlifted while their workers were already running, so
`wtgui/give-an-assistant-a-way-to-know-what-a-65e039` (row 185, cut 21:53:23Z, job `5974d4c2`) and
`wtgui/land-the-review-chip-lane-as-a-squash-pr-58597e` (row 184, cut 2026-11-20T18:57:26Z, job `49bbfce6`) were
both lifted by hand through `POST /api/worktree/kind-lift`. This branch is the fourth: it is row 186 in the
assistant's queue, it was cut research and unlifted at 21:57:56Z, its own brief says "push it and open a pull
request", and its record is the same answer the two hand lifts corrected. (This tree's guard controls are allow-all,
so its pre-push hook returns before the panel's request route and never reaches the kind refusal; a project whose
controls ask is where the refusal bites, as it did for #819 and #821. The record is wrong either way for a row's
tree.)

## The rule

A SPAWN line that names a task id is a worker carrying a queue row, and a row's work is meant to land. The cut is
now made with the answer a person's lift writes, decided from the spec's own `taskId` in `lib/features/spawn.js`
(`rowId` at :214, the two fields at :379):

```js
...(rowId ? { landing: true, preLiftedBy: `row ${rowId}` } : {}),
```

`landing: true` is the mechanism that already existed at the cut and had no caller on this path: `lib/jobs.js`
`makeWorktree` writes the branch-kind record lifted (`:3152`, `:3154`) and `made.localOnly = false` (`:3156`). The
record therefore reads `kind: "research"` with `lifted: true`, which is exactly what `/api/worktree/kind-lift`
writes, and the worker's push falls through to the ordinary decision. The new field is the reason:
`rememberParent` writes `preLiftedBy` only on a lifted record (`lib/jobs.js:3219`) and `loadParents` reads it back
beside `rec.lifted` (`lib/jobs.js:3181`), so a restart keeps it.

A record lifted by a person carries `lifted: true` and no `preLiftedBy`; a record a row pre-lifted carries both. That
is how a later reader tells the two apart, on the book and on the row (`server.js` `applyTreeKind:3862` stamps
`branchKindPreLiftedBy`, and the lift route returns it at `:5514`).

## The judgement: the record, not a merge run

`landing: true` would also have meant "a run started to LAND" - the merge flow's trees are marked that way, their
guard allows a push outright (`server.js:1343`, `lib/remote-writes.js:153`), and their brief is the blanket
`WILL LAND` paragraph (`lib/jobs.js:4089`). A row pre-lift gets neither. `jobs.create` separates the two: the cut
carries `cutPreLiftedBy`, the guard is installed with `landing: false` (`lib/jobs.js:3971`), and the paragraph stays
the parent's (`lib/jobs.js:4089`). The reason is that the parent's paragraph is the only one that knows whether the
project has a turnover branch and what its push policy is; a blanket `WILL LAND` on a turnover project would tell a
worker to push a new remote branch, which that project's doctrine forbids. The pre-lift is the state a hand lift
leaves behind, reached at the cut instead of after a refusal.

## The boundary the vocabulary keeps

The two kinds and their labels are untouched; no third kind was added. A row SPAWN cut from a turnover branch is a
`turnover` child - not local only, so there is nothing to lift, and it records no `lifted` and no `preLiftedBy`. A
SPAWN with no row, a tree cut by hand, and a `SPAWN IN` (which cuts nothing) are unchanged.

## What landed

- `lib/features/spawn.js` - `rowId` read once, and `landing: true, preLiftedBy: "row <id>"` on the new tree's
  `jobs.create`.
- `lib/jobs.js` - `makeWorktree` accepts `preLiftedBy`; `rememberParent` writes it on a lifted record; `loadParents`
  reads it; `jobs.create` separates the record's lift (`cutPreLiftedBy`) from a run started to land (the guard and the
  paragraph).
- `server.js` - `branchKindPreLiftedBy` on every row with a kind, and on the lift route's answer.
- `test/spawn-row-prelift.test.js` - four tests: a row cut, a no-row cut, a hand cut with a person's lift, and a row
  cut from a turnover branch.
- `docs/reports/spawn-row-prelift-2026-11-21.html` - the evidence page for this landing.

## What proves it

- `node --test test/spawn-row-prelift.test.js` - 4 tests, 4 pass, 0 fail. The row cut test reads `kind research`,
  `lifted: true`, `preLiftedBy: "row N"` off `treeKindFor`, off the file and through a fresh `loadParents`; it also
  pins the guard's `landing: false` and the parent's LANDING paragraph on the run body.
- The focused set that already pins this machinery - `branch-kind`, `spawn-stage-landing`, `spawn-from`,
  `spawn-queue-link`, `spawn-busy`, `human-kinds`, `spawn-cards` - 47 tests, 47 pass.
- `node tools/verify-branch-kind.mjs` - 57 checks, 0 failed: the row still draws R and R-with-a-tick, the lift
  route's 404 and its recorded `lifted: true` are unchanged, the cut dialog offers exactly the two kinds, and no
  page error.
- `npm test`, once, before the pull request: it printed 1,485 passes and 8 failures before it stopped producing
  output for 14 minutes with six heavy files still in flight (a sibling tree was running its own suite at the same
  time), and it was cancelled at the 20 minute limit this project's worker briefs set - the run did not reach its
  summary. The eight failing files were re-run on their own: `assistant-carry-key`, `assistant-to-replay` and
  `child-tree` pass alone, and the other five - `assistant-profile`, `assistant-search-scroll`, `child-route`,
  `gateway-permissions`, `header-controls` - fail identically on a clean `git archive main` tree, so none of them is
  this change. `gateway-permissions` fails because it starts `server.js` in a worktree that has no `config.json`.

## The version

`main` read 1.148.0 when this branch was cut, so the branch carries 1.149.0 - a minor, because the cut's record
gains a reason and a worker's push decision changes for a queue-row SPAWN.
