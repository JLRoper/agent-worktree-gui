# Audit of every local `wtgui/*` branch — 2026-11-02

The board carried 70 local branches under `refs/heads/wtgui`, most of them older than a squash-merged `main`.
Ancestry cannot answer which of them are finished: this repo squash-merges, so a landed branch is never an
ancestor of `main` and `git branch --merged` refuses all of them. This audit used the branch's **own files**
instead, and deleted only the branches whose own files are already on `main` byte for byte.

## The test, applied to every branch

```
mb=$(git merge-base main <branch>)
git diff --name-only "$mb..<branch>"          # the branch's OWN file list
git diff --stat main <branch> -- <own files>  # empty == those files are on main as they are here
```

A branch was deleted only when all three held:

1. its own files are identical to `main` (the second diff printed nothing);
2. it has no worktree, or its worktree is clean (`git status --porcelain` empty);
3. no live run is in that tree — read from the panel's own job store (`GET /api/jobs`), not from a log file.

A branch whose own files differ keeps **both** its branch and its tree. A tree holding any uncommitted file
stays. On top of those rules two branches were exempt by name: `wtgui/task-24-tidy-the-agent-c-0320bb`, which
has a worker in it right now, and this audit's own landing branch. `public/app.js`, `public/style.css` and
`public/index.html` were not read or written by this audit.

## Result

- **70 branches audited**
- **24 deleted** — 23 plain branches plus the `fix-22` worktree and its branch
- **46 kept** — 44 whose own files differ from `main`, plus the live `task-24` and this landing branch
- **4 worktrees remain** — `split-assistant-settings-033234`, `task-18-...-85f01d`, `task-20-...-a39ad4`, `task-24-...-0320bb`

The first branch deleted was the known-good proof case, `wtgui/fix-22-a-stale-restart-e-ecb92d`: its merge-base
is `68445de`, its six own files are byte-identical to `main` (`lib/assistant/actions.js`, `lib/restart.js`,
`package.json`, `server.js`, `test/restart-idempotence.test.js`, `tools/verify-restart-idempotence.mjs`), its
worktree was clean, and its PR **#230** is `MERGED` at `ac66a3a` — which is `main`'s tip. The tree was removed
with `git worktree remove` and the branch with `git branch -D`; the same test then deleted the remaining 23.

## Every branch

| # | Branch | Own files | Diff vs `main` (own files only) | Verdict | Action |
|---|---|---|---|---|---|
| 1 | `wtgui/add-permanent-user-data-and-scratch-dire-f4fb89` | 24 | +1170/-9138 across 16 files | not landed | kept — own files differ from main |
| 2 | `wtgui/add-rebase-on-parent-option-to-unmerged-d4e21e` | 0 | no own files — nothing to compare | landed | branch deleted |
| 3 | `wtgui/add-settings-toggle-for-auto-worktree-cl-86dba4` | 0 | no own files — nothing to compare | landed | branch deleted |
| 4 | `wtgui/ahead-behind-own-remote-copy-47786e` | 12 | +795/-5365 across 8 files | not landed | kept — own files differ from main |
| 5 | `wtgui/audit-every-local-wtgui-7fb40a` | 0 | no own files — nothing to compare | landed | kept — this audit's own landing branch |
| 6 | `wtgui/board-efficiency-and-port-guard` | 17 | +432/-2608 across 8 files | not landed | kept — own files differ from main |
| 7 | `wtgui/bounce-trend-slot-c-own-4f165c` | 0 | no own files — nothing to compare | landed | branch deleted |
| 8 | `wtgui/can-you-run-this-on-it-s-aeae8e` | 3 | +33/-270 across 3 files | not landed | kept — own files differ from main |
| 9 | `wtgui/change-the-panel-so-a-wo-ed6267` | 1 | +45/-133 across 1 file | not landed | kept — own files differ from main |
| 10 | `wtgui/console-redraw-guard-e1cea2` | 7 | +313/-1982 across 4 files | not landed | kept — own files differ from main |
| 11 | `wtgui/console-scroll-stability-test-on-0-46-8-84c4f9` | 0 | no own files — nothing to compare | landed | branch deleted |
| 12 | `wtgui/could-you-enumerate-the-7682e4` | 3 | +41/-236 across 3 files | not landed | kept — own files differ from main |
| 13 | `wtgui/deep-architectural-revie-4141e9` | 1 | identical — no diff | landed | branch deleted |
| 14 | `wtgui/deep-architectural-revie-49a4f7` | 0 | no own files — nothing to compare | landed | branch deleted |
| 15 | `wtgui/deep-architectural-review-of-codebase-or-28b854` | 0 | no own files — nothing to compare | landed | branch deleted |
| 16 | `wtgui/delete-finished-worktree-and-branch-refs-3440e4` | 2 | +11/-12 across 2 files | not landed | kept — own files differ from main |
| 17 | `wtgui/document-jitter-in-the-p-a2d6df` | 3 | +1102/-146 across 2 files | not landed | kept — own files differ from main |
| 18 | `wtgui/document-jitter-in-the-p-abf9e9` | 1 | identical — no diff | landed | branch deleted |
| 19 | `wtgui/fix-22-a-stale-restart-e-ecb92d` | 6 | identical — no diff | landed | worktree removed, branch deleted (proof case, PR #230) |
| 20 | `wtgui/fix-agent-popping-and-jumping-fd0c04` | 0 | no own files — nothing to compare | landed | branch deleted |
| 21 | `wtgui/fix-approvals-dock-pending-request-count-3a515a` | 11 | +1/-4 across 2 files | not landed | kept — own files differ from main |
| 22 | `wtgui/fix-console-scroll-jump-on-card-rebuild-56ae58` | 5 | +309/-1897 across 3 files | not landed | kept — own files differ from main |
| 23 | `wtgui/gate-reinstall-fix` | 3 | +9/-155 across 3 files | not landed | kept — own files differ from main |
| 24 | `wtgui/have-any-agent-playwrigh-d7a801` | 3 | +1037/-1730 across 3 files | not landed | kept — own files differ from main |
| 25 | `wtgui/i-m-constently-trying-an-8a3c3c` | 6 | +285/-1886 across 5 files | not landed | kept — own files differ from main |
| 26 | `wtgui/i-noticed-every-agent-wo-054fd6` | 2 | +2/-12 across 1 file | not landed | kept — own files differ from main |
| 27 | `wtgui/i-really-like-these-opti-2370e9` | 1 | +40/-100 across 1 file | not landed | kept — own files differ from main |
| 28 | `wtgui/implement-console-height-persistence-wit-c502ac` | 0 | no own files — nothing to compare | landed | branch deleted |
| 29 | `wtgui/in-the-last-pull-request-2597a3` | 6 | +511/-3698 across 5 files | not landed | kept — own files differ from main |
| 30 | `wtgui/investigate-agent-turn-restarts-and-cwd-920fc0` | 12 | +712/-4544 across 6 files | not landed | kept — own files differ from main |
| 31 | `wtgui/land-three-open-prs-in-t-28a86d` | 2 | +1/-10 across 1 file | not landed | kept — own files differ from main |
| 32 | `wtgui/land-unlanded-worktree-work-onto-main-544bf6` | 5 | +1134/-8489 across 5 files | not landed | kept — own files differ from main |
| 33 | `wtgui/local-main-drift-2026-10-28` | 28 | +1208/-9190 across 20 files | not landed | kept — own files differ from main |
| 34 | `wtgui/local-main-remainder-2026-10-28` | 25 | +1180/-9082 across 16 files | not landed | kept — own files differ from main |
| 35 | `wtgui/locate-the-sources-of-co-2517ca` | 1 | identical — no diff | landed | branch deleted |
| 36 | `wtgui/make-settle-wake-exempt-from-rate-limit-734b68` | 0 | no own files — nothing to compare | landed | branch deleted |
| 37 | `wtgui/make-the-panel-wake-its-bb851c` | 0 | no own files — nothing to compare | landed | branch deleted |
| 38 | `wtgui/measure-console-height-survival-across-c-a93347` | 0 | no own files — nothing to compare | landed | branch deleted |
| 39 | `wtgui/measure-console-jump-to-top-baseline-on-faee24` | 0 | no own files — nothing to compare | landed | branch deleted |
| 40 | `wtgui/merge-worktree-branch-locally-without-pu-e53e94` | 0 | no own files — nothing to compare | landed | branch deleted |
| 41 | `wtgui/move-local-main-onto-origin-main-47786e` | 13 | +806/-5603 across 9 files | not landed | kept — own files differ from main |
| 42 | `wtgui/plan-the-split-of-public-ac001b` | 2 | +33/-75 across 2 files | not landed | kept — own files differ from main |
| 43 | `wtgui/playwright-lane-a-long-t-7dbdfb` | 25 | +1181/-9114 across 17 files | not landed | kept — own files differ from main |
| 44 | `wtgui/playwright-lane-b-stream-f1411d` | 28 | +1208/-9190 across 20 files | not landed | kept — own files differ from main |
| 45 | `wtgui/playwright-lane-c-branch-0c9b99` | 32 | +1214/-9395 across 22 files | not landed | kept — own files differ from main |
| 46 | `wtgui/playwright-measure-console-height-across-45eaeb` | 0 | no own files — nothing to compare | landed | branch deleted |
| 47 | `wtgui/playwright-measure-the-c-545668` | 2 | +1/-9 across 1 file | not landed | kept — own files differ from main |
| 48 | `wtgui/playwright-measure-the-c-54fd7a` | 2 | +1/-9 across 1 file | not landed | kept — own files differ from main |
| 49 | `wtgui/prepare-run-cwd-fix-920fc0` | 4 | +6/-54 across 2 files | not landed | kept — own files differ from main |
| 50 | `wtgui/read-only-review-of-prs-169-171-8009c1` | 0 | no own files — nothing to compare | landed | branch deleted |
| 51 | `wtgui/remove-one-finished-worktree-and-open-pr-c3ba08` | 0 | no own files — nothing to compare | landed | branch deleted |
| 52 | `wtgui/rescue-unstick-session-4d68f9` | 1 | +164/-162 across 1 file | not landed | kept — own files differ from main |
| 53 | `wtgui/review-prs-169-170-171-read-only-9d3113` | 0 | no own files — nothing to compare | landed | branch deleted |
| 54 | `wtgui/right-now-when-i-am-goin-3879ba` | 4 | +646/-3732 across 4 files | not landed | kept — own files differ from main |
| 55 | `wtgui/separate-thinking-skill-console-font-set-c9fe06` | 0 | no own files — nothing to compare | landed | branch deleted |
| 56 | `wtgui/speed-up-and-deduplicate-playwright-test-b1cbcd` | 3 | +1/-10 across 1 file | not landed | kept — own files differ from main |
| 57 | `wtgui/split-assistant-settings-033234` | 3 | +5/-12 across 2 files | not landed | kept — tree clean but own files differ, so tree and branch both stay |
| 58 | `wtgui/split-assistant-settings-acf8d8` | 2 | +1/-72 across 2 files | not landed | kept — own files differ from main |
| 59 | `wtgui/stream-trail-and-board-scans` | 7 | +235/-1548 across 3 files | not landed | kept — own files differ from main |
| 60 | `wtgui/task-18-queue-row-alread-85f01d` | 7 | +141/-1017 across 5 files | not landed | kept — tree clean but own files differ, so tree and branch both stay |
| 61 | `wtgui/task-20-queue-row-alread-a39ad4` | 14 | +58/-763 across 6 files | not landed | kept — tree clean but own files differ, so tree and branch both stay |
| 62 | `wtgui/task-23-queue-row-alread-31faff` | 8 | +61/-664 across 5 files | not landed | kept — own files differ from main |
| 63 | `wtgui/task-24-tidy-the-agent-c-0320bb` | 0 | no own files — nothing to compare | landed | kept — live run 47501f63 in its tree; tree dirty (4 entries), branch untouched |
| 64 | `wtgui/test-collapsed-row-scroll-skip-behavior-f592a4` | 0 | no own files — nothing to compare | landed | branch deleted |
| 65 | `wtgui/test-spawn-a-worktree-29f2ee` | 0 | no own files — nothing to compare | landed | branch deleted |
| 66 | `wtgui/unify-console-text-sizin-40a5a0` | 4 | +169/-207 across 3 files | not landed | kept — own files differ from main |
| 67 | `wtgui/unify-console-text-sizin-c095c1` | 9 | +507/-1944 across 6 files | not landed | kept — own files differ from main |
| 68 | `wtgui/version-gate-in-guard` | 3 | +10/-183 across 3 files | not landed | kept — own files differ from main |
| 69 | `wtgui/when-it-says-n-hidden-li-55522e` | 12 | +762/-5253 across 11 files | not landed | kept — own files differ from main |
| 70 | `wtgui/you-are-the-consolidator-89001a` | 2 | +23/-289 across 2 files | not landed | kept — own files differ from main |

## What was kept, and why

**44 branches whose own files differ from `main`.** These are not finished: the versions of
the files they touched are not the versions on `main`. Most are far behind a `main` that has since grown in
the same files, which is why their diff reads as a large deletion count — that is drift, not a deletion this
audit made. Their branches and trees are untouched; `public/app.js` is among the files several of them carry,
and it is being edited in this repo by another worker.

**`wtgui/task-24-tidy-the-agent-c-0320bb`** — 0 own files, which the identity test alone would call landed, but
its tree has a live worker: job `47501f63` in `.worktrees/task-24-tidy-the-agent-c-0320bb`, and that tree holds
four uncommitted entries (`package.json`, `public/app.js`, `public/style.css`,
`tools/verify-agent-card-chrome.mjs`). Left alone by name.

**`wtgui/audit-every-local-wtgui-7fb40a`** — this branch: 0 own files until this audit's own commit lands.

**Three kept trees with a clean status but differing own files** — `split-assistant-settings-033234`,
`task-18-queue-row-alread-85f01d`, `task-20-queue-row-alread-a39ad4`. A clean tree is not a finished branch:
the identity test is what decides, and each of these changes files `main` does not hold in that form. Both the
tree and the branch stay until their content is on `main`.

## Reproducing the audit

```
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/wtgui); do
  mb=$(git merge-base main "$b"); files=$(git diff --name-only "$mb..$b")
  printf '%s [%s own files] %s\n' "$b" "$(printf '%s\n' $files | grep -c .)" "$(git diff --stat main "$b" -- $files | tail -1)"
done
```

An empty last field means the branch's own files are on `main` as they are on the branch.
