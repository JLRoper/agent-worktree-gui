# The unlanded worktree backlog — 2026-11-05

Base: the walk started at `origin/main` **ff84177** (1.24.1) and this record was written at **79ec3f3**
(1.27.1, 320 releases). Measured 2026-11-05 17:00 – 17:48 EST (22:00 – 22:48Z) from the landing tree
`wtgui/triage-and-land-the-unla-761334`.

**Result: 13 rows walked in the row's order — 2 landed, 11 retired as moot, 0 blocked.** Two trees the
row put off-limits, `fix-the-two-driver-defec-72dda4` and `replace-the-push-permiss-588511`, were live
runs and were not touched.

The row's own count was made with `git cherry origin/main <branch>` (patch-equivalence, because this
repo rebases and squashes): 28 worktrees, 13 rows with work main did not carry, one of those dirty-only.
That count held at the start of this walk. What it could not say is whether each row still *mattered* —
eleven of the thirteen were drafts of documents main has since landed in a later revision, or a fix a
sibling landing had already made in a better place.

## One row per tree

| # | tree | own commits | disposition | evidence |
|---|---|---|---|---|
| 1 | `hey-get-me-some-screensh-b7a6e6` | 3 | **landed** | PR [#379](https://github.com/JLRoper/agent-worktree-gui/pull/379) · merge `dfae827` · 1.27.1 |
| 2 | `both-research-docs-are-c-e5b018` | 2 | retired, moot | main's `docs/research/assistant-reset-design.md` is the landed revision — `88f4d42` reads "Status: **built** … version 1.12.0"; the branch carries the 618-line pre-build draft (main: 642) |
| 3 | `make-the-deliverables-po-6815d2` | 2 | **landed** | PR [#438](https://github.com/JLRoper/agent-worktree-gui/pull/438) · merge `7cdebf2` · 1.26.0 |
| 4 | `staged-and-begin-where-y-856177` | 2 | retired, moot | main's `docs/research/assistant-session-fence.md` is 487 lines and was corrected by `9103880`; the branch is a 165-line earlier text |
| 5 | `staged-and-use-your-pred-6e0df2` | 2 | retired, moot | the endpoint note's content was folded into the fence document by `67d3f8f`; main's `gateway-fence-endpoints.md` differs from the branch by 5 added / 7 removed lines |
| 6 | `staged-in-your-first-15-b741a0` | 2 | retired, moot | the same `9103880` revision of the fence document (branch: 208 lines against main's 487) |
| 7 | `critique-a-plan-before-a-93004d` | 1 | retired, moot | a review of a plan whose text was **never in the tree** (the document says so) against `4102020`, 326 commits behind; the pipeline editor it reviews has since landed and moved on, and no `docs/pipeline-modal-plan-review.md` exists on main |
| 8 | `land-pr-359-and-render-t-0e6a57` | 1 | retired, moot | `1e8959c` — "docs: the 1.4.2 usability ledger page, **salvaged from PR #360**"; that PR is CLOSED and its content is on main |
| 9 | `on-a-200-open-handler-an-8f730c` | 4 | retired, moot | PRs #421 and #426 already MERGED; the gate's settle-wait was superseded by `bd55ff6`, which stops the header moving at all; its changelog render names 302 releases against main's 320 |
| 10 | `put-the-primary-checkout-0c0f9b` | 1 | retired, moot | the `v1.8.7` section its commit adds already exists on main, and the changelog is current at 320 releases (`2ffb933`); the untracked report beside it is a point-in-time note |
| 11 | `restore-the-primary-chec-83b67e` | 3 | retired, moot | main's `docs/reviews/pipeline-execution-round.html` is the later revision (`ff6eff8`); the restore record is a note about a primary checkout main's own history has since moved past |
| 12 | `the-facts-to-design-agai-97bed3` | 1 (+dirty) | retired, moot | the same `88f4d42` landed design (642 lines) supersedes the 294-line draft; the uncommitted edit was a partial rewrite of that draft |
| 13 | `the-approval-card-expire-224646` | 0 (+dirty) | retired, moot | `5a33fdd` — "fix: the approval card holds for the host's 600 s and answers inside it" — landed exactly the uncommitted change (`lib/approvals.js`) |

## The two landings

### #3 `make-the-deliverables-po-6815d2` → PR #438, merge `7cdebf2`, version 1.26.0

The one product change in the backlog: the DELIVERABLES list became a window that opens inside the
viewport at any zoom, drags by its header, resizes by its corner grip, and remembers its rectangle. The
branch had an OPEN PR from an earlier run; it was rebased onto `ff84177`, its 1.23.1 bump commit was
resolved to main's number and dropped, and the branch took **1.26.0** (minor: a new reader-facing
affordance — `docs/versioning.md`). `1.25.0` was skipped because the live
`fix-the-two-driver-defec-72dda4` tree already holds that tag locally.

- suite on the rebased tip: **1677 tests, 1677 pass, 0 fail**
- `test/e2e/deliverables-window.spec.mjs`: **7 of 7 pass** (opens inside at 100% and 130% zoom, drag,
  edge clamps, body-is-not-a-handle, resize stops, reload keeps the rectangle, close returns focus)
- `v1.26.0` annotated on `7cdebf2`; changelog rendered at the merged tip as `54a6223` — **318 releases**

### #1 `hey-get-me-some-screensh-b7a6e6` → PR #379, merge `dfae827`, version 1.27.1

Four photographed frames of Settings › Pipeline and Bundles plus the harness that takes them, and a fix
the branch needed to pass the repo's own gate: `capture.json` recorded drive-letter paths and
`test/absolute-paths.test.js` refused it. The harness now writes every path relative to the tree (or as
`<tmp>/…`), and the committed ledger was rewritten by the same rule. Frame bytes and sha256 did not move.

The gallery is a **v1.8.0 capture** and says so in its own provenance line; what is still true at this
PR's base is the surface it photographs — the tab strip, `#pipeline-list`/`#pipeline-editor`,
`#pipeline-flow-open` and the bundle summary/import/task rows are unchanged in shape in main's
`public/index.html`. The harness takes `--root`, so re-shooting any build is one command.

- suite on the rebased tip (`2ffb933`): **1683 tests, 1683 pass, 0 fail**
- `node tools/absolute-paths.mjs`: clean — 906 tracked files, none new
- `v1.27.1` annotated on `dfae827`; changelog rendered at the merged tip as `79ec3f3` — **320 releases**

Version arithmetic: main moved under this walk twice. Landing 1 took main 1.24.1 → 1.26.0; a sibling
landed 1.27.0 (`7703350`) and its render (`2ffb933`) while landing 2 was in flight, so landing 2 was
rebased and its 1.26.1 number was spent before it pushed — it landed as 1.27.1.

## How the eleven retirements were made

Each moot tree's own commits were saved first as a `git bundle` in the run's scratch directory
(`origin/main..<branch>`; 2.8 KB – 847 KB each), plus the two dirty trees' diffs and the one untracked
report. Then the tree's branch was moved to `origin/main`'s tip (`git checkout -B <branch> origin/main`)
and the tree confirmed clean, because the panel's release gate accepts only a MERGED PR or a branch
that carries **nothing** `origin/main` lacks — and these branches carried drafts main had already
superseded. The release requests name each tree; the panel re-reads git and the PR before removing
anything.

Nothing was force-merged, and no moot tree's content was landed as if it were new. Where the branch's
subject file exists on main, the table above names the commit that superseded it.

## Caveats and follow-ups

- **One parallel-suite flake, proven not this branch's:** `test/queue-sweep.test.js` ("one settle is one
  wake, even when two rules answer it") failed once inside the full suite on the pipeline-tabs branch,
  then passed in three consecutive runs of its own file (28/28 with `absolute-paths.test.js`, twice).
  The full suite after the fix is 1683/1683, so it is not red on main at this record's base.
- **The two live trees were left alone as instructed.** `fix-the-two-driver-defec-72dda4` holds the
  local-only tag `v1.25.0`, which is why landing 1 took 1.26.0 rather than 1.25.0.
- **The scratch bundles are run artifacts, not an archive.** They live under the run's scratch directory
  and are pruned with it; the durable record is this document and the commits named in it.
- **What is still unlanded in the board is not in this list.** The row named thirteen trees; the other
  registered worktrees were already level with main or live. A later pass that adds trees should re-run
  the `git cherry` read rather than trust this table's count.
