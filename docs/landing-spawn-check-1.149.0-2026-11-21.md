# Landing: a SPAWN is checked before its line, and every refusal names the fix (1.149.0)

A SPAWN is a claim about the future, and until this branch the panel answered it only after the line was written.
On 2026-11-21 a SPAWN naming parked row 184 came back `task #184 is parked` (lib/assistant.js `spawnTaskRefusal`)
after the manager had already told the reader the run had started, so the reader was told two things and only the
second was true. The same evening two SPAWNs went into worktrees that still held unlanded work:
`the-worktree-row-name-carries-two-review-4c9db3` (assistant-2's #613 commits) and
`land-the-review-chip-lane-as-a-squash-pr-58597e` (two unlanded commits). Both trees are still on this host and both
still hold work today, so the second half of this landing was measured against them rather than argued:

```
the-worktree-row-name-carries-two-review-4c9db3: held=yes ahead=1 dirty=0
  the tree .../.worktrees/the-worktree-row-name-carries-two-review-4c9db3 still holds work of its own: its branch
  wtgui/the-worktree-row-name-carries-two-review-4c9db3 carries 1 unlanded commit that main does not have. land
  wtgui/the-worktree-row-name-carries-two-review-4c9db3 first, or name a free tree - a worker started here would
  edit work nobody has landed.
land-the-review-chip-lane-as-a-squash-pr-58597e: held=yes ahead=0 dirty=11
  the tree .../.worktrees/land-the-review-chip-lane-as-a-squash-pr-58597e still holds work of its own: 11
  uncommitted files. commit or discard those files first, or name a free tree - a worker started here would edit
  work nobody has landed.
```

(That run is `node -e` over `git rev-parse`/`rev-list`/`status` in each tree, feeding the same `unfinishedTree`
and `heldTreeWork` this branch ships; the commit counts have moved since the brief's account, the trees have not.)

## What landed

- `lib/spawn-check.js` - new. The three checks a SPAWN meets at the cut, in one place, each returning
  `{check, code, reason, remedy}`: `rowRefusal` (no such row, another assistant's row, done, PARKED, a live run on
  the row's thread), `heldTreeRefusal` (a live run standing in the tree), and `heldTreeWork` (the tree still holds
  commits its base does not have, or uncommitted files). `sentenceOf` is the one join a thrown refusal uses, so the
  cut and the route read identical words.
- `lib/assistant.js` - `spawnTaskRefusal` is now a thin caller of `taskRowCheck`, and `taskRowCheck` is the body the
  new `spawnCheck` uses, so the cut and the pre-flight ask the same question of the same three places. Every refusal
  gained its remedy: a parked row is told to unpark (`queue action state queued with a reason`), a live row names
  the job and thread to wait for, a done row is told to requeue. `spawnCheck` composes the row check,
  `liveJobsInTree` (the lookup `jobs.create` refuses on) and `unfinishedTree` (the function the reuse
  recommendation decides with), and is read-only. The queue directive gained one sentence naming the new route, so
  an assistant knows it exists without a charter being rewritten.
- `lib/jobs.js` - the `tree_busy` 409 is built from `heldTreeRefusal` + `sentenceOf`, the same functions the route
  answers with, and the error carries `remedy`. Nothing about when it refuses changed.
- `lib/assistant/queue.js` - the digest now says what a state BLOCKS. A parked line reads
  `PARKED, and a SPAWN carrying this id is refused until it is unparked: <reason>`; a LIVE line reads
  `LIVE, and a SPAWN into its tree is refused until this run ends`; and a row whose tree another live run holds
  carries `TREE HELD by job <id> on thread <t> - a SPAWN into it is refused until that run ends` (`treeHeld` on the
  decorated row, derived from the job list the caller already hands in). A row's own run is not reported as a second
  holder.
- `lib/spawn-reuse.js` - the "a second tree was cut" note keeps its branch and commit evidence and now names the
  run that held the tree and the two fixes: wait for `job <id>` and reuse the tree, or land the branch. The
  candidate carries `holder` so the note can say which run.
- `routes/assistant-spawn-check.js` - new: `GET /api/assistant/spawn-check?task=<id>&project=<name>&tree=<path>`
  answers `{ok, reason, remedy, checks, task, project, tree, resolved}`. The tree is resolved by the cut's own
  resolver (`lib/spawn-target.js`), so a path, a worktree directory name and a branch all mean what a `SPAWN IN`
  line means; an unresolvable tree or an unknown project is answered as a refusal with its fix. Read only: it starts
  nothing, writes nothing and grants nothing.
- `server.js` - the route is mounted beside the digest's two GETs.
- `test/spawn-check.test.js` - new; `test/assistant-queue.test.js`, `test/queue-holds.test.js` and
  `test/spawn-queue-link.test.js` - the digest and refusal assertions tightened to the new sentences, plus the
  held-tree digest snapshots.

## What proves it

- `node --test test/spawn-check.test.js` - **10 tests, 10 pass, 0 fail**. One per refusal (parked, live row, held
  tree, done row, foreign row), the held-work note with its branch and count, the MERGED row that is not reported,
  the ok case, the wire's 400/403s, and the read-only proof (queue file byte-identical, job store unchanged).
- The drift proof is inside that file: the route's `reason`/`remedy` for a held tree is compared **byte for byte**
  with the message `jobs.create` throws for the same tree, so the two cannot say different things.
- `node --test test/spawn-busy.test.js test/spawn-reuse.test.js test/spawn-queue-link.test.js
  test/spawn-cards.test.js test/spawn-from.test.js test/queue-holds.test.js test/assistant-queue.test.js` -
  **114 tests, 114 pass, 0 fail**.
- `node --test test/assistant-digest.test.js test/assistant-digest-route.test.js test/queue-sweep.test.js
  test/queue-state-hold-route.test.js test/queue-task-refs.test.js test/queue-order.test.js
  test/queue-single-press.test.js test/spawn-stage-landing.test.js test/worktree-lifecycle.test.js` -
  **62 tests, 62 pass, 0 fail**.
- `node --test test/assistant-queue-pane.test.js test/assistant-queue-ui.test.js
  test/assistant-queue-reattach.test.js test/queue-drag-ui.test.js test/collisions.test.js
  test/restart-idempotence.test.js test/assistant-event-wakes.test.js test/assistant-wake-ladder.test.js` -
  **122 tests, 122 pass, 0 fail** (it prints `git` LF/CRLF warnings from the temp repos it builds; that is the
  fixture, not this branch).
- `node --test test/assistant-queue-directive.test.js test/spawn-watch.test.js` - **11 tests, 11 pass, 0 fail**.
- `npm run absolute-paths` - **clean, 1957 tracked files, none new**. The one allow count it touched is the fixture
  row for `test/assistant-queue.test.js`, raised from 24 to 29 because the held-tree digest rows add five fixture
  tree paths of the same kind the file already carries.
- `npm test`, the full sweep, was started once and **killed at 27.9 minutes with no result** - the 20-minute cap
  this project's worker briefs set, and two other suites were running on this host at the same time (a second
  `npm test` and an `--test-concurrency=8` run belonging to another tree, both left alone). So the suite's own
  answer is NOT claimed here: the 379 tests above are what ran, and the modules they cover are the ones this branch
  touches. A reader who wants the full sweep can run `npm test` on an idle host.

## The version and the tag

`main` read 1.148.0 at `1aad736b` when this branch was cut, so the branch carries 1.149.0: a minor, because the
panel gains a new route and the digest says a fact it did not say before. The `v1.149.0` anchor is the landing's
step, not this branch's: `tools/land-pr.mjs` runs `release-tag` after the merge to put the annotated tag on the
commit `main` shows first declaring the number (`node tools/version.mjs check` reads ok on this branch now).

## The landing

Branch `wtgui/give-an-assistant-a-way-to-know-what-a-65e039`, cut from `origin/main` 1aad736b, pushed as a new
remote branch (this project has no turnover branch and none on origin), pull request opened with `gh pr create
--fill` and left for the reader to land. No merge into the landing branch, no touch of `public/render-projects.js`,
`public/app.js`'s columns panel or `tools/verify-branch-kind.mjs`.
