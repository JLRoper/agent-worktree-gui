# Cleanup — agent-worktree-gui

The work order for the structural cleanup of this panel. It exists so that a change can be
judged against a ranked list instead of a fresh opinion, and so that each phase can be picked
up, paused and resumed without re-reading the codebase.

## Where the list comes from

`docs/code-review/README.md` — the path this workspace was asked to index — **does not exist in
this tree**. The review that is actually committed is
[`docs/code-review-2026-10-21.md`](../code-review-2026-10-21.md), and it is the source of truth
for every finding referenced here.

Two things about it do not match the brief that opened this work, and they are recorded rather
than smoothed over:

- It ranks **17 findings** — ten numbered correctness items (1–10) and seven structural
  recommendations (A–G) — not 101.
- It lays them out in **four phases** (1–4), not five.

This index therefore keeps the review's own four phases and adds **Phase 0** for the small,
independent one-liners that were pulled forward out of it (see the map below). All 17 findings
are accounted for; none were invented, and none were dropped.

## Drift between the review and the tree

The review was written at `main` **fff7a3c** and says so. The tree has moved a long way since,
so its line anchors are stale and were re-read before any edit:

| file | review | now |
|---|---:|---:|
| `server.js` | 659 | 1,960 |
| `public/app.js` | 3,389 | 11,710 |
| `lib/jobs.js` | 622 | 1,988 |
| `lib/scheduler.js` | 496 | 744 |
| `lib/activity.js` | 341 | 374 |

Route counts moved with them: the review counted 14 POSTs with 12 protected, and 22 inline route
checks. The tree now has **45 POST routes, 41 of which call `authorised(req)`**, and 66 inline
route checks. The finding is the same — auth is opt-in per route — but the count that proves it
is 45/41, not 14/12. Where a count is quoted in a checklist it is a count read out of this tree.

## Phase map

| Phase | Scope | Review findings | Checklist |
|---|---|---|---|
| **0** | Independent one-liners, shipped now | #1 (floor + logging), #3 (auth), #4 (outer catch), #10 (harness), plus `C1` open-url (new, found in this turn) | [phase-0.md](phase-0.md) |
| **1** | Correctness, small, independent — the rest of the review's own first phase | #6, #2, #9, #8, #7, #10 (remaining coverage) | [phase-1.md](phase-1.md) |
| **2** | Server structure | #4 (route-table form), #3 (fixed by design), B | [phase-2.md](phase-2.md) |
| **3** | Client structure | A, #5 | [phase-3.md](phase-3.md) |
| **4** | The remaining libs | C, D, E, F | [phase-4.md](phase-4.md) |

Finding IDs are the review's own. `C1` is the one finding this cleanup added: the review never
looked at `/api/open-url`, and the mechanism it uses cannot be made safe by validation alone.

## Rules that hold for every phase

1. **Zero dependencies, no build step.** `node:test` is the only test mechanism; `public/` is
   served as native ES modules when it is eventually split. No `npm install` in any phase.
2. **The comments carry the reasoning.** Move a comment with the code it explains; never
   summarise one away.
3. **One commit per fix, message names the mechanism** (e.g. "auth: make the four unprotected
   POSTs fail closed", not "fix auth"). A commit that mixes two mechanisms is two commits.
4. **Every fix carries an assertion.** `npm test` must fail before the fix and pass after it.
   A test that would pass on the broken code is not a test of the fix.
5. **Verify by what the project already trusts**, in this order: `node --check` on every touched
   file, `npm test`, `curl /api/health`, a project count from `/api/state`, and the page through
   the front door. Numbers in a report are numbers read back from a command.

## Status vocabulary

`done` — landed, asserted, verified. `pending` — not started. `blocked` — cannot start until a
named thing lands (the review is explicit that B/C must not be interleaved with a feature in
`server.js` or `lib/jobs.js`).
