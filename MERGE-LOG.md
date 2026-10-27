# MERGE-LOG — integration/all-open-work-2026-10-27

Base: main @ d8ae753 (0.11.2). Each entry is one merge commit, tested after it landed.

| # | branch | commit | result | tests |
|---|---|---|---|---|
| 1 | wtgui/enforce-static-worktree-names-with-one-r-eab400 | 70c1648 | clean | 48/48 pass |
| 2 | wtgui/store-project-branch-and-pr-host-links-5523df | 5c84c6b | conflicts: package.json (kept 0.11.2), lib/scheduler.js + server.js (kept both sides) | 72/72 pass |
| 3 | wtgui/reconcile-assistant-command-lines-agains-75c2c2 | 51f173d | conflict: README.md (kept audit paragraphs + main's once-only rename wording) | 77/77 pass |
| 4 | wtgui/version-static-assets-with-content-hash-6f26a9 | 45f0ab7 | conflict: package.json (kept main's 0.11.2) | 94/94 pass |
| 5 | wtgui/subscribe-panel-to-run-event-stream-1e310c | 34dd646 | version restored to 0.11.2 | 96/96 pass |
| 6 | wtgui/make-todo-fact-lines-collapsible-by-defa-90909d | eaed59f | conflicts: package.json (0.11.2), server.js (kept ledger + git gates; cut/skipped both off the named line) | 96/96 pass |
| 7 | wtgui/fix-gateway-restart-false-positive-detec-4e3521 | 078a154 | conflicts: package.json (0.11.2), lib/jobs.js (kept lastSeq + gatewayPid/Start) | 103/103 pass |
| 8 | wtgui/stop-board-listing-foreign-worktrees-4adc4f | e18f957 | conflicts: scheduler, tree-names, server imports/naming (both sides kept; old autoNameWorktree dropped — superseded by WorktreeNaming); test re-pointed | 110/110 pass |
| 9 | wtgui/stop-board-showing-deleted-worktrees-32ac68 | f268180 | conflicts: scheduler (discover→reconcile, kept ownership filter + seeding), server imports (kept ledger + Locks); lifecycle fixtures moved inside <repo>/.worktrees; board tests call reconcile | 114/114 pass |
| 10 | wtgui/build-project-steward-for-branch-rollbac-667552 | aaadf78 | conflicts: locks.js add/add (reader Locks kept, writer queue added as WriterLocks), jobs.js makeWorktree (ledger cut + startRef/parents), server.js routes (both kept) | 129/129 pass |
| 11 | wtgui/give-workers-per-project-branch-landing-b902b4 | 7596d42 | conflicts: README, jobs.js makeWorktree (ledger + startRef + ParentBook + treeParents), server.js config (kept both) | 132/132 pass |
| 12 | wtgui/make-spawn-cards-impossible-to-miss-dacabc | 31325d9 | conflicts: README.md, lib/assistant.js, lib/assistant/store-file.js, package.json (0.11.2), public/assistant.js, public/index.html, public/style.css (all UU), lib/assistant/config.js (MM) — union of main's command audit + spawn watchdog with the branch's strip, own badge, Alerts grouping and `spawnIntents`; duplicate `SPAWN_WATCH_MS` export deduped. `bootedAt` initialised again; `noteSpawnIntent`/`settleSpawnIntent` wired into the audited spawn path (which kept `mark`/`settleLine`), `addSpawnAlert` handed the turn | 138/138 pass |
| 13 | wtgui/audit-local-branches-against-origin-main-f2a70a | 50838e0 | clean: lib/store.js + test/store.test.js; version restored to 0.11.2 | 147/147 pass |
| — | land/pr-todo-folds | skipped | no-op: `git cherry HEAD` marks 6900000 `-` (patch-id 78ee1cd2 = 90909d's 58a1a60, merged as eaed59f); the only `+` is its 0.14.0 bump | — |
| — | land/tree-naming-rule | skipped | no-op: `git cherry HEAD` marks 097627c `-` (patch-id f4479148 = 90909d's 0978556, merged as eaed59f); the only `+` is its 0.14.1 bump | — |
| 14 | feature/shared-model-menu | c664232 | conflict: package.json only (kept 0.11.2); new public/core/model-menu.js, app.js/assistant.js/index.html/style.css auto-merged | 147/147 pass |
| 15 | land/spawn-cards-visible | b8dc24b | `-s ours`: verified superseded by merge 12 (its 4 tests ⊂ this tree's 6; same `noteSpawnIntent`/`settleSpawnIntent`/`checkSpawns`/`spawnIntents`; no `spawnidle`, so its "Fourteen rules" is our "Fifteen"). Also deduped the ✧ Assistant row in docs/using-the-board.md, which merge 12 had left twice | 147/147 pass |
| 16 | land/pr-model-picker (picker/price half only) | 5d345a1 | conflicts: .gitignore (kept both), package.json (0.11.2), public/style.css (branch's rating/price columns; spawn-strip block intact), public/app.js (`modelOptionHtml` gains `{selected, extra}`), public/core/model-menu.js add/add (branch's superset), docs/using-the-board.md. Its shared-picker commit + 0.12.0 bump were `-` under `git cherry` (d0a10ef/3c5833d). `lib/model-prices.js` is a pure superset of main's | 147/147 pass; tools/verify-model-prices.mjs 67/67 |

Note on the commit column: rows 2–11 were recorded by the previous run with ids from a pass that was
superseded (those commits still exist but no branch contains them). The ids above are the merge commits
actually on this branch, one per branch name, in the order they were made.

## Where this stands

- Merge 12 was half-applied when the previous run hit its iteration cap: seven UU files plus
  `lib/assistant/config.js` at MM, and `test/spawn-cards.test.js` failing because the kept (audited)
  spawn path never called `noteSpawnIntent`. Both finished here; the test was fixed, not deleted.
- Every branch on the list is now in: merges 12–16 plus the two verified no-ops (rows marked `—`).
  Nothing is left to merge.
- `node --test test/*.test.js` is 147/147 after the last merge. One earlier full-suite run failed
  `push-guard.test.js: an env-granted push neither asks the panel nor parks` at 3002 ms; it passes alone
  (1417 ms) and passed on the next full run — a timing test that is flaky under parallel load, not a
  regression from these merges.
- `package.json` was held at main's 0.11.2 through every merge (branch bumps 0.11.3 → 0.14.1 were all
  dropped). The single bump is the last commit on the branch: 0.12.0 — minor, because the integration
  carries features (spawn cards, the shared model picker with prices and ratings).
- One cleanup after the union: merge 12 left TWO writers for the `#assistant-spawn-badge` element (the
  branch's `4 spawn` text with its amber `is-late`, then main's plain number with `is-stuck`, last one
  winning). They are one painter now, carrying the page's own card count and the server watchdog's
  `unstarted` verdict on the same pill.
- The branch is LOCAL ONLY: no push, no PR, main not moved.
- Open question for the reader: `land/pr-model-picker` has no PR-side code in it — all four of its commits
  are the picker and its price data. The "picker half" was its already-landed pair (shared picker + 0.12.0
  bump, both `-` under `git cherry`); the two price commits are merged here.
