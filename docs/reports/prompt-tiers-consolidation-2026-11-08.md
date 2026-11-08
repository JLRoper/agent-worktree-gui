# The tiers pass: Assistant #2 and #3 consolidated, charters back under 18,000

Executed 2026-11-08 16:57 EST (2026-11-08T21:57Z) against the live panel store (`<dataDir>/state`), with the
panel stopped for the two passes and restarted after them. The pass ran through the shipped consolidation
facility (`lib/assistant/consolidate.js`, `Assistant.consolidateRulesFor`), driven by
`tools/consolidate-rules.mjs` and the two plan files beside this report's design document:
`docs/design/prompt-tiers-pass-2026-11-08/assistant-2.plan.json` and `assistant-3.plan.json`.

**Verdict: done, and the three targets hold.** Assistant #2's 40 rules are 12 (11 of its own, narrowed, plus the
reader's dash rule) and Assistant #3's 30 reader rules are 12. Both lists are shown whole by the twelve-seat
window (`leftOut 0`), the reader's rules come first, both charters are under 18,000 characters (17,353 and 17,502),
and every rule a pass produced carries `rewritten: true` and its `rewrittenFrom` ids. The BEFORE state of each
pass is in a snapshot under `<dataDir>/logs/rule-consolidations/`.

Paths are written relative, or as `<dataDir>` for the panel's data directory. Rule ids are the store's own.

## 1. What each assistant looks like after the pass

| | Assistant #2 | Assistant #3 |
|---|---|---|
| rules before | 40 (1 reader, 39 assistant) | 30 (all reader) |
| rules after | 12 (1 reader, 11 assistant) | 12 (all reader) |
| shown by the twelve-seat window | 12, left out 0 | 12, left out 0 |
| pinned (`safety: true`) | 2 (the oauth2-multi rule, the dash rule) | 2 (the oauth2-multi rule, the dash rule) |
| rewritten summaries | 12 | 12 |
| charter before -> after | 19,377 -> 17,353 chars | 19,773 -> 17,502 chars |
| role prompt | 411 chars, written by the pass (`promptBy: assistant`) | empty (its rules are the reader's) |
| system block before -> after | 10,871 -> 11,269 bytes | 10,647 -> 10,759 bytes |
| snapshot | `rule-consolidations/2026-11-08T21-57-15-367Z-assistant-2.json` | `rule-consolidations/2026-11-08T21-57-28-164Z-assistant-3.json` |

The block grows by 398 bytes on #2 and 112 on #3. That is the tier-1 prompt arriving (about 480 bytes on #2,
including its header) against a small shrink in the rules block: before, the reader's dash rule was clipped to
200 characters and a `28 older rules left out` line rode under the list; after, the rule is 190 characters whole,
nothing is left out, and the assistant's rules are still clipped to 200 at injection. Nothing was cut from the
identity, the queue directive or the action grammar.

Both passes were validated by a dry run before anything was written. The dry run reported
`40 -> 12, left out 0` and `30 -> 12, left out 0` and was refused no op.

## 2. What the plans did

Assistant #2: 11 merges, 1 rewrite of the reader's dash rule, 6 rules moved to the charter, 1 dropped, 1 prompt
set. The drop is `recorded:` - a nine-character fragment, not a rule. The charter moves are the rules that only
matter when a particular situation arises: review a branch by cutting from that branch, a restart proved by pid,
the stale-`old_string` diagnosis, the empty-branch trap, the patch-run-versus-loop test, and `NO BASE REF`.

Assistant #3: 10 merges, 2 rewrites (the SEFL landing pattern and the dash rule), 3 rules moved to the charter
(`NO BASE REF` and the two patch-loop rules). Every produced rule keeps `by: "reader"`: the whole list is the
reader's, and a merge of the reader's rules is a rewrite of their answer, not the assistant taking it over.

The charter trim ran after each pass, because the pass appends the moved rules and its summary to the charter and
trimming first would let the pass's own entries be what a later prune eats. It drops the two frozen sections the
design says to drop (`Standing rules carried over`, `Scratchpad notes carried over` - both empty on these files)
and then the OLDEST changelog entries, never a line above the changelog heading. #2 lost 7 entries, #3 lost 7.
Those entries are the clipped text of rules that are now consolidated rules or charter entries, and the snapshot
still holds the before state.

## 3. The rule lists

### Assistant #2 (assistant-2)

| # | id | by | pin | rewrittenFrom | chars | rule |
|---|---|---|---|---|---|---|
| 1 | e3f2a020 | assistant |  | e3f2a020, 205dbcc7, ceebc516, a60a69dd | 321 | GitHub repos land by PR only, never a local merge or a push to main: agent-worktree-gui's gate is `gh pr merge <n> --rebase --admin`, and a sub-task merges into its feature branch. SEFL Bitbucket never pushes master - one feature branch and ONE reviewed PR. Here remoteBranchPolicy is allow, so a wtgui/* worker may push. |
| 2 | f2e7c533 | assistant |  | f2e7c533, 56c403b9 | 229 | A SPAWN line is not a started worker: read /api/jobs (never logs/jobs.json) within 2 minutes for a running job in that tree, then name the thread and job id; an unclicked card is waiting for a click, and say how many are stacked. |
| 3 | ec5090a7 | assistant |  | ec5090a7, 5acc2ee2 | 271 | After a restart assess EVERY session by end state, tree and final message, and re-issue only the ones it killed - no outcome and no endedAt, or running with a dead run id. Never re-issue a reader-cancelled run, a 402 credits or 429 concurrency failure, or a finished one. |
| 4 | 5b9c0b85 | assistant |  | 5b9c0b85, 4b4e0bc6 | 282 | Re-attach a killed session through its EXITED or NOT-RUNNING chip, the continue path and not a new spawn, only when the tree still holds work. Resolve a killed run first: GET /v1/runs/{old_id}, then resolve-unknown with its admission_id and execution_generation, then re-issue once. |
| 5 | b51d40ee | assistant |  | b51d40ee, 3d661fe2, a65db958, 248a9487, b1d77961, 06e7066f | 288 | Judge landing by CONTENT against the branch's PARENT, never ancestry, commit counts or a worker's done message: git diff the touched files. A squash rewrites SHAs so AHEAD never zeroes; `MERGED (N commits)` is a receipt. Done is not landed until the PR reads MERGED and origin/main moved. |
| 6 | 5a3083a2 | assistant |  | 5a3083a2, a79b69c6, 92574f20, 074c57ac, 21fa5721 | 331 | Never cut a worktree to compare, export or clean up: use git archive or git show. A tree is deleted the moment its work is in its parent, after `git rev-list --count <parent>..HEAD`; a RELEASE line is a request, not an eviction - it is only a worker's final line for its own tree, and proof it is done, never that the tree is gone. |
| 7 | f930bc32 | assistant |  | f930bc32, 563e58b4, da688bd4 | 337 | A quiet run is stalled, not slow, only when its last event is a completed tool result, no child of its tree is alive and no approval is open; a quiet npm test proves nothing. The panel will not reap it: the reader cancels and the thread continues, never a TO. A failed row is judged by outcome.reason and its tree, never the status word. |
| 8 | 3fc43b5d | assistant | safety | 3fc43b5d, b0426cd0 | 351 | oauth2-multi remediation is LOCAL ONLY: cut every implementation branch from turnover branch 20260710_1338_DMR-39015_authorizationCodeFlowPCKE, merge it back locally with a fast-forward, never push it and never open its PR. Never push that turnover branch at all - its history carries a real JWT private key and OKTA_CLIENT_SECRET_VALUE in 25 commits. |
| 9 | 157dbf62 | assistant |  | 157dbf62, bf273d58 | 280 | An approval `/api/approvals` does not list is not a card: confirm approvals empty, `approvalDone` null and the transcript line, then cancel and re-issue only the unfinished step. An api_server approval is not a person seeing it - record it as unsanctioned, never relay 'approved'. |
| 10 | 0ba6fcd2 | assistant |  | 0ba6fcd2, 1981abda | 299 | A fix brief names exactly one endpoint, once: stop at the commit and report the SHA, or push, open a PR and land it - never both. When the next step is genuinely ambiguous, ask the reader a short question with numbered options instead of guessing or staying silent; never invent a task to look busy. |
| 11 | 5092163d | assistant |  | 5092163d, 2db83f5d | 286 | The gateway denies an approval at 600s and a working worker simply re-asks, so a row parked on approval every ~10 minutes is looping on expiry, not stalled. A live --test child proves a healthy run only when its start time matches the launch; leaked children outlive their run by hours. |
| 12 | 0f49e2bb | reader | safety | 0f49e2bb | 190 | Never write U+2014 or U+2013 anywhere - replies, commits, PR titles and bodies, comments, docs, logs or shell output. Use a plain ASCII hyphen; those characters become mojibake under cp1252. |

### Assistant #3 (assistant-3)

| # | id | by | pin | rewrittenFrom | chars | rule |
|---|---|---|---|---|---|---|
| 1 | 0f424040 | reader |  | 0f424040, 5aaae7cf | 304 | GitHub-remote repos land by PR only, never a local merge or a push to main; agent-worktree-gui has no Jenkins - its gate is `gh pr merge <n> --rebase --admin`, then pull and restart only if server.js, lib/** or public/** changed. A sub-task merges into its feature branch and the feature lands as ONE PR. |
| 2 | 25dd92b1 | reader |  | 25dd92b1 | 235 | SEFL Bitbucket: never push master, never merge locally. Deliver one feature branch plus ONE PR to master, reviewed by code_review_java; the title is `Java Code Review for <repo> <branch>`, and add code_review_java_dal for a DAL change. |
| 3 | ca23a83c | reader |  | ca23a83c, 21e5c90f | 298 | Cut a SPAWN or new branch from the repo's current HEAD, and review a branch by cutting from THAT branch and verifying rev-parse/log -1. An empty branch is not evidence work landed: measure the tree (git status --porcelain, added lines) before judging, and never remove a tree holding the only copy. |
| 4 | b220dfb0 | reader |  | b220dfb0, c8587554, 2ebea9f1, 121e2492 | 323 | Judge landing against the branch's PARENT by content (git diff the touched files), never ancestry or a worker's done message. A squash rewrites SHAs, so judge by tree equality and AHEAD never zeroes; `git branch -D` only after the PR reads MERGED. A done run is not finished until the PR reads MERGED and origin/main moved. |
| 5 | 6d64cb30 | reader | safety | 6d64cb30, 7effd91f | 310 | oauth2-multi remediation is LOCAL ONLY: implementation branches are cut from turnover branch 20260710_1338_DMR-39015_authorizationCodeFlowPCKE, merged back locally with a fast-forward, never pushed and never given a PR. Never push that turnover branch for any task - its history carries a real JWT private key. |
| 6 | 444fee49 | reader |  | 444fee49, 2ed1a837 | 313 | Delete a worktree the moment its work is in its parent, same turn, after `git rev-list --count <parent>..HEAD`; never cut a worktree to compare or export a branch (git archive or git show). A RELEASE line is a request, not an eviction: a worker may write it only for its own tree, and the panel acts after settle. |
| 7 | 4c247a60 | reader |  | 4c247a60, c43e1d3d, 9b46d45b | 299 | A SPAWN line is not a started worker: check /api/jobs (never logs/jobs.json) within 2 minutes for a running job in that tree, then name the thread and job id. A fix brief names exactly one endpoint - stop at the commit, or push, PR and land - and an ambiguous next step is a short numbered question. |
| 8 | eade91df | reader |  | eade91df, d0ef82a8 | 302 | After a restart assess EVERY session by end state, tree and final message, and re-issue only the ones it killed; never a reader-cancelled run, a 402/429 failure or a finished one. A failed row is judged by outcome.reason and its tree, never the status word - max_turns means the turns ran out mid-task. |
| 9 | 590962f3 | reader |  | 590962f3, 409399ed, 2a2abe93 | 272 | Re-attach a killed session through its EXITED or NOT-RUNNING chip, not a new spawn, only if the tree holds work; resolve a killed run via GET /v1/runs/{id} and resolve-unknown first, then re-issue once. A restart is proved by a changed pid and start_time, never by a turn. |
| 10 | bd4d20aa | reader |  | bd4d20aa, 853a9b34, 5f128752 | 323 | An approval /api/approvals does not list is not a card (approvals empty, approvalDone null, the transcript line): cancel and re-issue only the unfinished step. The gateway denies at 600s and a working worker re-asks, so a row parked every ~10 min is looping. A live --test child counts only if its start matches the launch. |
| 11 | b9ee44a4 | reader |  | b9ee44a4, b97ab0b4 | 280 | A quiet run is stalled only when its last event is a completed tool result, no child of its tree is alive and no approval is open; a quiet npm test, especially piped through grep, proves nothing. The panel will not reap it: the reader cancels and the thread continues, never a TO. |
| 12 | af0b26cb | reader | safety | af0b26cb | 174 | Never write U+2014 or U+2013 anywhere: replies, commits, PR titles and bodies, comments, docs, logs, shell output. Use a plain ASCII hyphen, and state that the count is zero. |

## 4. How it ran

1. Stage one (PR #599) landed first, so the consolidation facility was on `main` before the pass.
2. The panel was stopped (`stop-background.cmd`) for both passes: `tools/consolidate-rules.mjs` refuses to write
   while a panel is serving on the port, because the panel holds the same records in memory and would rewrite
   `assistants.json` from them.
3. The reader's grant was written on each record by the pass's `--grant` step (the brief is the reader's
   instruction): `consolidate: { by: "reader", at }`. Without it the real pass refuses with
   `consolidate-not-granted`.
4. Each plan was applied by `Assistant.consolidateRulesFor`, which validated every op, wrote the snapshot
   BEFORE anything else, wrote the rules once, appended the charter entries and the summary, saved the prompt,
   and journaled one line per op.
5. The panel was restarted and read the new records at boot. `GET /api/state` then answered 12 rules for each
   assistant with the grant, the pins and the provenance intact; the module-level read in section 1 was taken
   from that state.

## 5. What this pass did not do

- The 200-character store cap is still design (the store cap is 400); the rules above are 174-351 characters and
  are clipped to 200 at injection.
- The project-rules tier and the 12,288-byte system block are still design rows in the design doc's section 6.
- Assistant #3's prompt is deliberately empty: a prompt written by the assistant would be the assistant's
  contract over the reader's 12 rules, and nothing in the brief asked for one. Its tier-1 seat is the role's
  empty prompt.
- Assistant #1 and the Director were not touched.
