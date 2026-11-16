# The report pile: what stays, what folded, what went

Provenance: written 2026-11-16 on branch `wtgui/prune-the-generated-report-pile-list-d8478a`, read against
`origin/main` at `6177a99a` (1.112.0). It walks every tracked file under `docs/reports/` and every file
directly under `docs/`: 252 files, of which 177 are pages (.md, .html or .diff) and 75 are captures.

The criteria, in the order a file was judged:

1. **Keep** anything a test, a code comment or a live doc cites; anything that records a standing
   decision, a landing record, or a measurement still in force.
2. **Fold** a draft or a duplicate into the surviving report: the finding that still matters moves there,
   the file goes.
3. **Drop** a one-off measurement whose finding has landed and been fixed, and a cleanup record whose
   actions are done.

Counts: **152 kept**, **19 folded**, **81 dropped**.

The nested collections under `docs/` (`reviews/`, `research/`, `assets/`, `snapshots/`, `design/`,
`perf/`, `cleanup/`, `rounds/`, `pipeline-integration/`, `plan/`, `runbooks/`, `pipelines/`) are counted
and named at the end, not pruned in this pass: they are review ledgers, captures and research series
that a row reads while it runs, not the generated report pile.

## Kept: pages that stay (119)

One line each: what it records, and why it stays.

- [../arch-review-efficiency.md](../arch-review-efficiency.md) - what the timers cost; named by docs/architecture.md as a deep-dive companion
- [../arch-review-functional.md](../arch-review-functional.md) - the board's state machine; named by docs/architecture.md as a deep-dive companion
- [../arch-review-organization.md](../arch-review-organization.md) - where the code lives; named by docs/architecture.md as a deep-dive companion
- [../arch-review-r1-a.md](../arch-review-r1-a.md) - the round's first review brief; docs/reviews/architecture-modules.html is built on it and cites it
- [../arch-review-r1-b.md](../arch-review-r1-b.md) - the round's second brief, cited by the same page
- [../arch-review-r2-a.md](../arch-review-r2-a.md) - the adjudication of the two briefs; docs/reviews/architecture-modules.html cites it for the six oversized files
- [../arch-review-r2-b.md](../arch-review-r2-b.md) - the second adjudication, cited by the same page
- [../architecture.md](../architecture.md) - the architecture doc: modules, the call graph and the landing order
- [../assistant-attach-after-restart-2026-11-05.md](../assistant-attach-after-restart-2026-11-05.md) - the session fence: why an assistant fails every turn after a gateway restart; cited by lib/ and a test
- [../assistant-command-cards.md](../assistant-command-cards.md) - the assistant's command cards: the renderer the console draws
- [../assistant-search-keys.md](../assistant-search-keys.md) - the keyboard search shipped in 1.112.0: the keys it answers and the list it filters
- [../child-worktrees-and-rollups.md](../child-worktrees-and-rollups.md) - a child worktree and how it rolls back into its parent; README and architecture name it
- [../clarify-over-the-runs-api.md](../clarify-over-the-runs-api.md) - how a question is delivered over the Runs API; README and lib/jobs.js cite it
- [../code-review-2026-10-21.md](../code-review-2026-10-21.md) - the review docs/arch-review-organization.md names as the round's starting point
- [../console-bounce-column-fit.html](../console-bounce-column-fit.html) - the console column-fit measurement; README names it and tools/verify-console-column-fit.mjs gates it
- [../console-bounce-manual-7391.md](../console-bounce-manual-7391.md) - cited by public/board/console.js and test/console-column-fit.test.js; the 60 s window that made the column fit measurable
- [../console-combined-first-line.md](../console-combined-first-line.md) - the combined layout's console rule; README and test/console-independence.test.js cite it
- [../console-expand.md](../console-expand.md) - cited by tools/verify-console-zoom.mjs; the console height store it measured landed
- [../console-frames-7393-0461.md](../console-frames-7393-0461.md) - the frame test on 7393; README names it and tools/measure-console-expand-frames.mjs runs it
- [../console-lag.md](../console-lag.md) - cited by tools/measure-console-lag.mjs and docs/console-scroll-hop.md; the clamp it found was fixed
- [../console-live-observation.md](../console-live-observation.md) - the console watched while the card is rebuilt; README names it
- [../console-memory-growth.md](../console-memory-growth.md) - the memory measurement test/console-memory-bounds.test.js takes its bounds from
- [../console-rebuild-built-card.md](../console-rebuild-built-card.md) - cited by tools/verify-console-independence.mjs; placeBuiltConsoles is the fix it measured
- [../console-scroll-hop.md](../console-scroll-hop.md) - the scroll hop and the one browser rule behind it; README and the console tests cite it
- [../gateway-usage-changes.html](../gateway-usage-changes.html) - cited by docs-review-roots-2026-11-16.html, which published its hash as a served page; the implementation handoff beside the usage review
- [../gateway-usage-review.html](../gateway-usage-review.html) - the gateway usage measurement: what the panel's turns actually cost, and the changes proposed
- [../hermes-approval-transport.md](../hermes-approval-transport.md) - the approval transport the panel uses; cited by docs/runs-api-phase0.md
- [../hermes-cli-session-limit.diff](../hermes-cli-session-limit.diff) - the local session-limit patch README says to re-apply after hermes update
- [../hermes-run-cwd.md](../hermes-run-cwd.md) - the pending canonical Runs API cwd proposal; README says it is prepared, not installed
- [../hermes-runs-api-knobs.diff](../hermes-runs-api-knobs.diff) - the legacy per-run knobs patch README still names
- [../hosts.md](../hosts.md) - the host-mapping doctrine; README names it and test/hosts.test.js pins it
- [../investigation.md](../investigation.md) - rung 7's stage 2 conclusion: the round beside main, and what it ruled out
- [../jitter-streaming.md](../jitter-streaming.md) - the streaming renderer's jitter measurement; README names it
- [../jitter-synthesis.md](../jitter-synthesis.md) - the jitter campaign reconciled into one ranking; cited by test/liveness.test.js
- [../landing-approval-command-summary-2026-11-16.md](../landing-approval-command-summary-2026-11-16.md) - the approval card names what the command will do before the command
- [../landing-assistant-queue-2026-11-02.md](../landing-assistant-queue-2026-11-02.md) - every assistant's own task queue was already landed; the re-check record
- [../landing-assistant-search-keys-1.112.0-2026-11-16.md](../landing-assistant-search-keys-1.112.0-2026-11-16.md) - the 1.112.0 landing: the assistant search on the keyboard alone
- [../landing-assistant-settings-split-2026-11-01.md](../landing-assistant-settings-split-2026-11-01.md) - the assistant's settings split into a Watchdog tab and per-assistant settings
- [../landing-board-digest-tail-2026-11-09.md](../landing-board-digest-tail-2026-11-09.md) - the board digest is an append-only tail
- [../landing-boot-replay-settled-2026-11-02.md](../landing-boot-replay-settled-2026-11-02.md) - a boot replay settled the debt, and the tree was cut anyway (0.60.1)
- [../landing-changelog-render-2026-11-04.md](../landing-changelog-render-2026-11-04.md) - the 0.111.3 render landed once, the duplicate closed, main moved to 0.114.0
- [../landing-changelog-scope-2026-11-09.md](../landing-changelog-scope-2026-11-09.md) - the cross-project report is out of the changelog, and the next one cannot get in
- [../landing-cheaper-promotion-detector-2026-11-06.md](../landing-cheaper-promotion-detector-2026-11-06.md) - the cheaper promotion detector
- [../landing-combined-output-default-2026-11-01.md](../landing-combined-output-default-2026-11-01.md) - the combined output default was already landed; the re-check record
- [../landing-console-grab-2026-11-01.md](../landing-console-grab-2026-11-01.md) - the console-grab measurement was already landed; the re-check record
- [../landing-held-reply-restart-1.111.0-2026-11-16.md](../landing-held-reply-restart-1.111.0-2026-11-16.md) - a reply queued behind a live turn survives the panel (1.111.0)
- [../landing-per-assistant-settings-2026-11-01.md](../landing-per-assistant-settings-2026-11-01.md) - per-assistant settings, role prompts and whitelists landed as 0.49.0; the re-check
- [../landing-pr-359-and-changelog-2026-11-04.md](../landing-pr-359-and-changelog-2026-11-04.md) - PR #359 landed as 1e1c595, and the 1.4.2 and 1.4.1 sections are rendered
- [../landing-render-in-the-landing-path-2026-11-04.md](../landing-render-in-the-landing-path-2026-11-04.md) - the landing renders the changelog itself, proven on main's own tip
- [../landing-repair-v1-1-0-tag-2026-11-04.md](../landing-repair-v1-1-0-tag-2026-11-04.md) - the v1.1.0 tag named a docs commit, not the bump
- [../landing-repair-v1-30-4-tag-2026-11-05.md](../landing-repair-v1-30-4-tag-2026-11-05.md) - the v1.30.4 anchor main never got
- [../landing-report-brief-cards-1.111.1-2026-11-16.md](../landing-report-brief-cards-1.111.1-2026-11-16.md) - the 1.111.1 landing: the report brief in cards
- [../landing-session-replace-on-unknown-2026-11-06.md](../landing-session-replace-on-unknown-2026-11-06.md) - the gateway's unknown_execution replaces the session (1.43.1)
- [../landing-split-discovery-2026-11-06.md](../landing-split-discovery-2026-11-06.md) - two tiers for discovery and the scan
- [../landing-stage-hold-1.41.0-2026-11-06.md](../landing-stage-hold-1.41.0-2026-11-06.md) - a stage's own run, held in the wait book (1.41.0)
- [../landing-stage-settle-and-gate-1.43.3-2026-11-06.md](../landing-stage-settle-and-gate-1.43.3-2026-11-06.md) - a stage run settles on its own thread, and a gate is asked again (1.43.3)
- [../landing-three-open-prs-2026-11-01.md](../landing-three-open-prs-2026-11-01.md) - three open docs and harness PRs landed in order: 0.46.4 to 0.46.7
- [../landing-unified-console-size-2026-11-01.md](../landing-unified-console-size-2026-11-01.md) - one console size for normal, reasoning and tool text was already landed; the re-check
- [../landing-worktree-assistant-owner-2026-11-01.md](../landing-worktree-assistant-owner-2026-11-01.md) - every worktree's owning assistant was already landed; the re-check
- [../panel-watch.md](../panel-watch.md) - the contract tools/panel-watch.mjs and test/panel-watch.test.js implement
- [../pipeline-sources.md](../pipeline-sources.md) - the two pipeline definitions the panel reads; cited by docs/task-pipeline.md
- [../pipelines-audit.md](../pipelines-audit.md) - cited by lib/pipelines.js for the hole P0-6 names
- [../pipelines.md](../pipelines.md) - the pipeline data model; read by test/pipelines.test.js and cited across lib/
- [../pushing-to-a-remote.md](../pushing-to-a-remote.md) - every guard between a worktree and a remote, in the order a push meets them
- [../queue-park-release.md](../queue-park-release.md) - the parked-row rule: a machine-readable reason, released the moment it stops being true
- [../reading-line-anchor-frame.md](../reading-line-anchor-frame.md) - the reading line is held in the frame that moved it: compensateAnchor's rule
- [ai-factory-api-examples.md](ai-factory-api-examples.md) - the verbatim API calls the POC's summary cites, so a re-run is checked against them
- [ai-factory-poc-2026-11-09.html](ai-factory-poc-2026-11-09.html) - the POC's own summary: both services measured on the panel's box, and which one fits it
- [ai-factory-poc-n8n-2026-11-09.md](ai-factory-poc-n8n-2026-11-09.md) - the n8n half of the POC, cited by the summary page
- [ai-factory-poc-qdrant-2026-11-09.md](ai-factory-poc-qdrant-2026-11-09.md) - the Qdrant half of the POC, cited by the summary page
- [clarify-card-link-smoke-2026-11-09.html](clarify-card-link-smoke-2026-11-09.html) - cited by tools/verify-clarify-card-link.mjs, which serves it as the link target its gate opens
- [command-card-inside-padding-2026-11-14.html](command-card-inside-padding-2026-11-14.html) - the command card's fold marker, spacing and inside padding, with the full capture set; survivor of the three command-card pages
- [console-streaming-lag-2026-11-14.html](console-streaming-lag-2026-11-14.html) - cited by public/core/type-stream.js (cause 7) and by test/type-stream.test.js
- [copy-full-highlight-2026-11-12.html](copy-full-highlight-2026-11-12.html) - records the copy-on-highlight rule shipped 2026-11-12; survivor of the two copy reports
- [cut-to-first-stage-2026-11-09.md](cut-to-first-stage-2026-11-09.md) - cited by lib/assistant.js in the round's makeWorktree account
- [deliverables-open-audit-2026-11-05.md](deliverables-open-audit-2026-11-05.md) - cited by docs/plan/deliverables-handback.md; the 200-row audit behind the DELIVERABLES handler
- [deliverables-open-handler-2026-11-05.md](deliverables-open-handler-2026-11-05.md) - cited by docs/plan/deliverables-handback.md; records the handler the rows now reach
- [dmr-39015-standalone-login-review-2026-11-10.html](dmr-39015-standalone-login-review-2026-11-10.html) - SEFL SSO review: the app token's fixed 20-minute life is still a live constraint
- [docs-review-roots-2026-11-16.html](docs-review-roots-2026-11-16.html) - records the two static roots landed 2026-11-16, still lib/http/static.js's shape
- [email-multi-272-session-review-2026-11-09.html](email-multi-272-session-review-2026-11-09.html) - SEFL session review kept as a frozen record; the fence it measured is in force
- [focused-testing-replay-2026-11-09.md](focused-testing-replay-2026-11-09.md) - cited by tools/test-changed.mjs and tools/test-select.mjs as the replay table their rule came from
- [gui-improve-board-2026-11-09.html](gui-improve-board-2026-11-09.html) - records the Board round's 13 rules and its hand landing
- [gui-improve-experience-review-2026-11-09.md](gui-improve-experience-review-2026-11-09.md) - adjudicates the gui-improve recommendations against main: four survive as written
- [held-reply-restart-2026-11-16.html](held-reply-restart-2026-11-16.html) - the 1.111.0 landing's report, cited by docs/landing-held-reply-restart-1.111.0-2026-11-16.md; survivor of the held-reply series
- [local-turnover-base-2026-11-12.html](local-turnover-base-2026-11-12.html) - records the third base-ref kind the panel resolves, a frozen allowlist record
- [module-map-2026-11-08.html](module-map-2026-11-08.html) - the module map's surviving page: the recipe, the tables and the totals the thirteen citing files mean when they name the absent 11-07 page
- [one-window-per-file-2026-11-12.html](one-window-per-file-2026-11-12.html) - records the one-window-per-file rule landed 1.89.3, still lib/open-url.js's behaviour
- [panel-vocabulary-and-overview-2026-11-09.html](panel-vocabulary-and-overview-2026-11-09.html) - the panel's vocabulary and overview: the orientation page a reader starts from
- [pipeline-execution-next-moves-2026-11-10.html](pipeline-execution-next-moves-2026-11-10.html) - cited by test/pipeline-wait.test.js; survivor of the three next-moves pages
- [pipeline-ledger-three-defects-2026-11-13.html](pipeline-ledger-three-defects-2026-11-13.html) - cited by test/pipeline-ledger-defects.test.js
- [pipeline-window-stale-bundle-2026-11-08.md](pipeline-window-stale-bundle-2026-11-08.md) - cited by test/pipeline-bundle-import.test.js
- [prompt-tiers-consolidation-2026-11-08.md](prompt-tiers-consolidation-2026-11-08.md) - records the charter consolidation; the caps it set are still the charters'
- [prompt-tiers-consolidation-stage-two-2026-11-09.md](prompt-tiers-consolidation-stage-two-2026-11-09.md) - stage two of the same standing decision: both role prompts written, both rule sets cut to twelve
- [queue-recarry-2026-11-07.html](queue-recarry-2026-11-07.html) - cited by test/assistant-carry-key.test.js
- [round-grouping-persistence-2026-11-09.html](round-grouping-persistence-2026-11-09.html) - records the round-grouping store, still where a round's grouping lives; frozen allowlist record
- [routes-cut-1.66.1-baseline.md](routes-cut-1.66.1-baseline.md) - the routes-cut baseline the module map's step order is read against
- [rung-4-live-walk-resumed-2026-11-11.html](rung-4-live-walk-resumed-2026-11-11.html) - the latest live rung 4 walk: the SEFL decline record
- [terminal-call-latency-2026-11-11.html](terminal-call-latency-2026-11-11.html) - cited by lib/jobs.js and by test/terminal-brief.test.js and test/tool-timing.test.js
- [version-integrity-B-tags-2026-11-06.md](version-integrity-B-tags-2026-11-06.md) - the tag-anchor forensics the version-integrity series and docs/versioning.md rest on
- [worktree-cleanup-2026-11-14.md](worktree-cleanup-2026-11-14.md) - the latest full sweep; the record the report generator's own naming follows
- [../retire-agent-manager-role-2026-11-08.md](../retire-agent-manager-role-2026-11-08.md) - the standing decision that retires the Agent Manager role, and the delete refusal that protects a running assistant
- [../runs-api-phase0.md](../runs-api-phase0.md) - the Runs API probed live: the phase 0 record
- [../runs-api-phase1.md](../runs-api-phase1.md) - the design the panel runs agents through: the phase 1 record
- [../spawn-reuse.md](../spawn-reuse.md) - one job, one tree: the rule lib/spawn-reuse.js implements
- [../split-public-app-plan.md](../split-public-app-plan.md) - the module split's standing order of work, with one step still open
- [../steer-refusal.md](../steer-refusal.md) - steer refusals and zombie live rows; cited by public/app.js and lib/jobs.js
- [../tag-retirement-2026-11-04.md](../tag-retirement-2026-11-04.md) - the tag retirement case docs/research/version-integrity/A and D cite
- [../task-pipeline.md](../task-pipeline.md) - a task's pipeline: the record, the window and the control; cited across lib/
- [../thinking-block-live-observation.md](../thinking-block-live-observation.md) - cited by docs/console-live-observation.md for the reasoning block
- [../thinking-block-redraw.md](../thinking-block-redraw.md) - cited by docs/using-the-board.md and docs/jitter-streaming.md; the redraw was fixed
- [../ticket-watch.md](../ticket-watch.md) - the procedure lib/ticket-watch.js follows
- [../tool-output-hidden-lines.md](../tool-output-hidden-lines.md) - what the 'N lines hidden - click to read' control means
- [../tool-output-truncation.md](../tool-output-truncation.md) - where a tool result is cut and what raises the cap; README names it
- [../turn-fold.md](../turn-fold.md) - the pager-as-collapse gesture: every turn on the page you leave folds
- [../using-the-board.md](../using-the-board.md) - the reader's manual for every control and gesture; README's own page
- [../version-tag-orphans-2026-11-05.md](../version-tag-orphans-2026-11-05.md) - the four orphan tags the version-integrity research cites; tools/verify-version-tags.mjs is the gate now
- [../versioning.md](../versioning.md) - the version scale; cited by .githooks/pre-push and tools/merge-prompt.js
- [../worker-brief-git-remotes.md](../worker-brief-git-remotes.md) - the worker brief's git-remote line; cited by lib/project-rules.js
- [../worker-brief-report-cards.md](../worker-brief-report-cards.md) - the worker brief's report-card line, live since 1.111.1

## Kept: captures that stay (33)

The images and ledgers a kept page reads, grouped by the directory that holds them.

- `assets/ai-factory-poc/` - 6: n8n-calls.json, n8n-executions-1440x900.png, n8n-workflow-1440x900.png, qdrant-calls.json, qdrant-collection-poc-panel-docs-1440x900.png, qdrant-dashboard-1440x900.png
- `assets/clarify-card-link-2026-11-09/` - 2: card.png, opened.png
- `command-card-inside-padding/` - 23: 00-default-two-rows.png, 01-default-open.png, 05-settings-rows.png, 06-settings-reset.png, 07-settings-inside-padding.png, 10-rows-min-1.png, 11-rows-max-8.png, 20-side-min-0.png, 21-side-max-60.png, 30-pad-min-0.png, 31-pad-max-32.png, 40-blank-min-0.png, 41-blank-max-4.png, 50-con-min-0.png, 51-con-max-60.png, 60-hit-closed-1440x900.png, 61-hit-open-1440x900.png, 70-padtop-min-0.png, 71-padtop-default-0.png, 72-padtop-max-32.png, 80-padbottom-min-0.png, 81-padbottom-default-0.png, 82-padbottom-max-32.png
- `console-grip/` - 2: console-grip-after-release.png, console-grip-mid-drag.png

## Folded into the surviving report (19)

The survivor gained a "Folded reports" section naming each of these and the number it found.

- `../console-popping-a.md` -> [../console-scroll-hop.md](../console-scroll-hop.md) - slot A's per-frame measurement of the popping console
- `../console-popping-b.md` -> [../console-scroll-hop.md](../console-scroll-hop.md) - slot B: the main console hops, the reasoning box does not
- `../console-popping-c.md` -> [../console-scroll-hop.md](../console-scroll-hop.md) - slot C: one agent at a time, both renderers, and a tail that never held a minute
- `../console-popping-synthesis.md` -> [../console-scroll-hop.md](../console-scroll-hop.md) - the campaign's synthesis: the writes, the callers, and what stayed unknown
- `../console-scroll-hop-candidates.md` -> [../console-scroll-hop.md](../console-scroll-hop.md) - every shared write that could move all consoles at once, ranked at 0.32.6
- `../cwd-the-run-does-not-have.md` -> [../hermes-run-cwd.md](../hermes-run-cwd.md) - the dogfood observation that produced the pending cwd patch
- `../jitter-sources.md` -> [../jitter-synthesis.md](../jitter-synthesis.md) - the sources measured per page counter across five sandbox passes
- `../jitter-static.md` -> [../jitter-synthesis.md](../jitter-synthesis.md) - the two consoles at rest: what still moves with no input
- `command-card-hit-2026-11-14.html` -> [command-card-inside-padding-2026-11-14.html](command-card-inside-padding-2026-11-14.html) - first pass: 79 of 79 checks on the fold marker and the row spacing
- `command-card-look-2026-11-14.html` -> [command-card-inside-padding-2026-11-14.html](command-card-inside-padding-2026-11-14.html) - middle pass: 61 of 61 checks on the same card, before the inside padding
- `copy-full-name-2026-11-11.html` -> [copy-full-highlight-2026-11-12.html](copy-full-highlight-2026-11-12.html) - first copy report: the truncated name and branch copied whole at 1.82.4
- `gui-improve-experience-2026-11-09.html` -> [gui-improve-experience-review-2026-11-09.md](gui-improve-experience-review-2026-11-09.md) - the walk's own record: 71m 40s, four verdicts, four stage commits
- `module-map-2026-11-08-1.66.html` -> [module-map-2026-11-08.html](module-map-2026-11-08.html) - re-measure at 1.66.6: 16,888 lines in app.js, 16.0% of the shipped code
- `pipeline-execution-next-test-2026-11-09.html` -> [pipeline-execution-next-moves-2026-11-10.html](pipeline-execution-next-moves-2026-11-10.html) - stage map at 1.76.24: three landing ladders and the furthest state without SEFL merge rights
- `pipeline-execution-rung4-live-2026-11-10.html` -> [pipeline-execution-next-moves-2026-11-10.html](pipeline-execution-next-moves-2026-11-10.html) - live rung 4 evidence: the comment loop on one PDL row, 05:05Z to 05:32Z
- `pipeline-next-moves-2026-11-09.html` -> [pipeline-execution-next-moves-2026-11-10.html](pipeline-execution-next-moves-2026-11-10.html) - first next-moves page: the GitHub ladder walk and the SEFL refusal test
- `queue-multi-hold-2026-11-12.html` -> [held-reply-restart-2026-11-16.html](held-reply-restart-2026-11-16.html) - closed-card measurement: the card closed for the whole hold, which 1.111.0 replaces
- `queue-single-press-2026-11-11.html` -> [held-reply-restart-2026-11-16.html](held-reply-restart-2026-11-16.html) - one-press measurement: 19 of 19 checks and exactly one held reply
- `terminal-call-rules-2026-11-11.html` -> [terminal-call-latency-2026-11-11.html](terminal-call-latency-2026-11-11.html) - what changed for the terminal call, and the numbers the tests returned

## Dropped (81)

### Pages (39)

- `../agent-card-session-scroll.md` - one-off measurement; the card's own scroller is in public/app.js
- `../branch-audit-2026-11-02.md` - one-off branch audit; its actions are done
- `../console-draw-order.md` - one-off measurement; the draw order it fixed is the code
- `../console-lost-text.md` - one-off; the paragraph stop it measured was fixed
- `../deliverables-control-stability.md` - one-off measurement of #btn-deliver; the stable control shipped
- `../matrix-bridge-restart-2026-11-05.md` - an operational record; the procedure is the matrix-hermes-bridge-media skill
- `../pipeline-tabs.html` - a review page superseded by docs/pipelines/viz
- `../queue-tab-review.md` - a read-only visual review; the tab shipped
- `assistant-2-task-queue-assessment.md` - one-off assessment; the queue sweep it judged is lib/assistant/queue.js
- `assistant-director-2026-11-04.html` - the Director role it documents was retired on 2026-11-08
- `assistant-reset-store-request-id-2026-11-04.md` - the request-id admission it measured landed; the store's reset path is the code
- `assistant-search-2026-11-12.html` - one-off measurement; the search shipped and test/assistant-search.test.js is the gate
- `awg-tree-backlog-2026-11-05.md` - 2 landed and 11 retired as moot; the backlog is done
- `clarify-card-relative-base-2026-11-11.html` - one-off measurement; the relative-link rule landed and tools/verify-clarify-card-links.mjs gates it
- `clarify-card-two-changes-2026-11-11.html` - one-off measurement of two changes that landed; the gates are verify-clarify-card-links and verify-clarify-answer-reuse
- `console-fonts-and-row-spacing-2026-11-14.html` - the fonts and spacing landed in 5cf42a25; the stylesheet and tools/verify-console-fonts.mjs are the record
- `gated-pdl-walk-author-review-revise-2026-11-07.md` - a walk whose two defects are fixed; the rung 4 walks supersede it
- `leftover-branches-2026-11-14.md` - the refs it retired are gone; worktree-cleanup-2026-11-14.md is the surviving sweep
- `local-refs-leftovers-2026-11-13.html` - one-off cleanup; the ten refs and one tree it named are gone
- `pipeline-catalogue-repair-2026-11-08.md` - the repair landed; pipeline-bundle.seed.json is the record
- `pipeline-fork-diagnosis-2026-11-10.html` - both defects it diagnosed are fixed
- `pipeline-rounds-parent-tree-2026-11-09.html` - one-off round measurement; docs/task-pipeline.md is the model's record
- `pipeline-row-github-ladder-2026-11-10.html` - rung 2, superseded by the rung 4 walk that stays
- `retired-worktrees-2026-11-05.md` - 93 trees retired; the audit's actions are done
- `salvage-async-pipeline-driver-delta.html` - a salvage of a branch that never landed
- `settings-pipeline-unlanded-2026-11-07.md` - every one of the 279 lines is placed; the salvage record is done
- `spawn-todo-bullets-2026-11-13.html` - the bullets landed; tools/verify-spawn-todo-bullets.mjs is the gate now
- `step-8-queue-prefix-2026-11-07.md` - the first route prefix moved out of server.js; the route files are the record
- `token-spend-2026-11-06.md` - one-off prompt-spend measurement; the preamble builders it measured have since moved
- `unmerged-worktrees-2026-11-04.md` - one-off audit; the backlog it listed is closed
- `walk-leftovers-cleanup-2026-11-11.html` - the leftovers were cleaned
- `worktree-aggregate-2026-11-13.html` - 167 branches judged and landed; the 11-14 sweep supersedes it
- `worktree-board-cleanup-2026-11-11.html` - the sweep's actions are done; the 11-14 sweep supersedes it
- `worktree-consolidation-2026-11-13.md` - superseded by the 11-14 sweep
- `worktree-triage-2026-11-07.md` - one-off triage; its actions are done
- `../role-pick-charter-2026-11-04.md` - a change note; the picker it describes is live and tested
- `../role-tab-role-editor-2026-11-08.md` - a change note; the editor it describes is live and tested
- `../rung-1-gate-recovery.md` - a recovery record; the gate was recovered and landed
- `../skill-audit-2026-10-30.md` - a 2026-10-30 skill audit, superseded

### Captures deleted with their page (42)

- `reports/` - 2: assistant-search-header.png, command-card-look-2026-11-14.json
- `assets/clarify-card-caret-2026-11-11/` - 2: after.png, before.png
- `assets/clarify-card-links-2026-11-11/` - 1: card.png
- `assets/clarify-card-relative-2026-11-11/` - 2: before.png, card.png
- `assets/pipeline-catalogue-repair-2026-11-08/` - 2: flow-author-review-revise.png, pipeline-tab.png
- `command-card-hit/` - 16: 00-default-two-rows.png, 01-default-open.png, 05-settings-rows.png, 06-settings-reset.png, 10-rows-min-1.png, 11-rows-max-8.png, 20-side-min-0.png, 21-side-max-60.png, 30-pad-min-0.png, 31-pad-max-32.png, 40-blank-min-0.png, 41-blank-max-4.png, 50-con-min-0.png, 51-con-max-60.png, 60-hit-closed-1440x900.png, 61-hit-open-1440x900.png
- `command-card-look/` - 14: 00-default-two-rows.png, 01-default-open.png, 05-settings-rows.png, 06-settings-reset.png, 10-rows-min-1.png, 11-rows-max-8.png, 20-side-min-0.png, 21-side-max-60.png, 30-pad-min-0.png, 31-pad-max-32.png, 40-blank-min-0.png, 41-blank-max-4.png, 50-con-min-0.png, 51-con-max-60.png
- `pipeline-rounds-2026-11-09/` - 3: round-b.png, round-c.png, round-d.png

## Nested collections, counted and left for a later pass

- `assets/` - 89 files
- `cleanup/` - 6 files
- `design/` - 5 files
- `perf/` - 6 files
- `pipeline-integration/` - 4 files
- `pipelines/` - 2 files
- `plan/` - 3 files
- `research/` - 27 files
- `reviews/` - 225 files
- `rounds/` - 7 files
- `runbooks/` - 2 files
- `snapshots/` - 16 files

## Two gaps this pass found, and did not paper over

1. **`docs/reports/module-map-2026-11-07.html` is cited and absent.** Twenty-one references across
   thirteen files name it as the module split's order of work (`public/app.js`, `public/assistant.js`,
   `public/charts.js`, `routes/assistant-queue.js`, `lib/assistant/queue.js` and eight more). No commit in
   this clone ever deleted it - `git log --all --diff-filter=D` is empty for that path - so the page was
   renamed to `module-map-2026-11-08.html` (the page that stays) without the references following. A later
   pass should repoint them at the page that exists.
2. **The pre-push absolute-paths gate refused every push from this base.** `origin/main`'s own tree
   carried two drive-letter paths: a provenance line in `docs/reports/held-reply-restart-2026-11-16.html`
   and a placeholder in `tools/verify-held-reply-restart.mjs`. Main allowlisted both in `41b6bd73`, so the
   gate could run again; this branch goes one step further on the placeholder, rewriting it to a path a
   reader can type and dropping its allowlist line, and leaves the report line allowlisted with its reason
   because it records what ran. `node tools/absolute-paths.mjs --rev <each pushed sha>` is clean, and no
   push used `--no-verify`.
