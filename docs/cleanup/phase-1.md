# Phase 1 — correctness, small, independent (the rest of the review's first phase)

Status: pending. Phase 0 pulled #1's floor, #3's auth, #4's outer catch and the first #10
coverage forward; what remains of the review's Phase 1 is below.

- [ ] **#6 — one path rule.** `lib/paths.js` exporting `display(p)` (forward slashes, trailing
      slash stripped, case kept) and `key(p)` (same, lowercased), and the identical file served
      to the browser from `public/shared/paths.js`. Migrate all 20 normalisation sites across 8
      files. On a case-insensitive filesystem, mixing the two rules is a latent mismatch, not a
      style issue.
      *Drift:* the review's 20 sites were counted at `fff7a3c`; recount before migrating.
- [ ] **#2 — the `token` setting works from the browser.** Today `public/app.js` contains zero
      occurrences of `x-panel-token` and every action 403s once `token` is set. Phase 0 made four
      more routes fail closed, so this is now the only thing standing between a token user and a
      usable panel. One header in the `apiFetch()` wrapper, which becomes `js/api.js` in Phase 3.
- [ ] **#9 — delete dead code.** `jobHtml` and `isAgentRunning`. Verify by whole-tree search, not
      by inspection; the file has grown since the review.
- [ ] **#8 — static boundary.** `filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep)`
      instead of a bare prefix, which lets a sibling `public-old/` through and is case-sensitive
      on a case-insensitive filesystem.
- [ ] **#7 — composition-root ordering.** `adoptFromJob` / the `panelAgents` closure reference
      `normPathKey` and `jobs` above their `const` declarations. Declare helpers, then instances,
      then wire callbacks. Safe only because nothing calls back synchronously today.
- [ ] **#10 — finish the coverage.** `parseLine` + `push` (the trickiest logic in the repo),
      `putRow`'s fast-merge rules, `pathsIn`/`deepest` attribution, `setLabel` sanitising, the
      client's `orderRows`/signature. `node:test`, no framework; export the pure part.

Blocked by: nothing. This phase is safe to start immediately and is the right place to resume.

## Done in Phase 0 (for reference, do not redo)

`engines` (#1), four unprotected POSTs (#3), outer-catch status/logging (#4), the harness half of
#10, and `C1` (`/api/open-url`).
