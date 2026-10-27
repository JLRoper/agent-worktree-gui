# MERGE-LOG — integration/all-open-work-2026-10-27

Base: main @ d8ae753 (0.11.2). Each entry is one merge commit, tested after it landed.

| # | branch | commit | result | tests |
|---|---|---|---|---|
| 1 | wtgui/enforce-static-worktree-names-with-one-r-eab400 | 70c1648 | clean | 48/48 pass |
| 2 | wtgui/store-project-branch-and-pr-host-links-5523df | a194c67 | conflicts: package.json (kept 0.11.2), lib/scheduler.js + server.js (kept both sides) | 72/72 pass |
| 3 | wtgui/reconcile-assistant-command-lines-agains-75c2c2 | c9bc76e | conflict: README.md (kept audit paragraphs + main's once-only rename wording) | 77/77 pass |
| 4 | wtgui/version-static-assets-with-content-hash-6f26a9 | 0a4a797 | conflict: package.json (kept main's 0.11.2) | 94/94 pass |
| 5 | wtgui/subscribe-panel-to-run-event-stream-1e310c | a95c768 | version restored to 0.11.2 | 96/96 pass |
| 6 | wtgui/make-todo-fact-lines-collapsible-by-defa-90909d | b554f80 | conflicts: package.json (0.11.2), server.js (kept ledger + git gates; cut/skipped both off the named line) | 96/96 pass |
| 7 | wtgui/fix-gateway-restart-false-positive-detec-4e3521 | de34ded | conflicts: package.json (0.11.2), lib/jobs.js (kept lastSeq + gatewayPid/Start) | 103/103 pass |
| 8 | wtgui/stop-board-listing-foreign-worktrees-4adc4f | 43ac0cf | conflicts: scheduler, tree-names, server imports/naming (both sides kept; old autoNameWorktree dropped — superseded by WorktreeNaming); test re-pointed | 110/110 pass |
| 9 | wtgui/stop-board-showing-deleted-worktrees-32ac68 | 0ac4d8a | conflicts: scheduler (discover→reconcile, kept ownership filter + seeding), server imports (kept ledger + Locks); lifecycle fixtures moved inside <repo>/.worktrees; board tests call reconcile | 114/114 pass |
