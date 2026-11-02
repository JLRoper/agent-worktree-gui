# Splitting `public/app.js` — the plan

**Measured on `622940f` (`package.json` 0.53.2); `public/app.js` is byte-identical at `28bad77`, the commit this
document lands on top of.** Every count and range below is measured at that commit and drifts with each landing:
re-locate a section by its marker text, never by the line. This document is a plan — the PR that carries it touches
nothing under `public/`, no server file and no `lib/` file.

The plan first landed at 0.51.4 (`fb9e6eb`). §8 re-derives every number against this base: 43 of the 118 regions had
moved, and four of the original §1 counts were wrong at the base they were measured on. Read §8 before quoting a
range from that first version.

## 1. The file, measured

- **18,426 lines**, **976,041 bytes** as checked out (CRLF) and **957,615 bytes** as the git blob (LF). The two differ
  by one byte per line (`core.autocrlf=true`), so a document that quotes one must say which: the brief's 972,997 is
  the checkout size at the first version's base.
- **118 marker lines** start `// ----` (`grep -c '^// ----'`): **98 open a section** — 96 named sections plus the two
  banners `agents`@310 and `worktrees`@8933 — and **20 are `// ---- end …` closers**. Lines 1–309 carry no marker
  (the keys, `state` and the boot constants). The brief's "~40 section markers" and "728 top-level functions" do not
  describe this file: it has 96 sections and **714 top-level `function` declarations** (915 top-level declarations
  counting the 201 `const`/`let`).
- A section runs from its marker to the next marker, but **an `// ---- end` line is a test API, not a boundary**:
  `sliceRegion` (`tools/panel-testkit.mjs`) reads between `// ---- <name>` and `// ---- end <name>`, and 10 of the 20
  closers are followed by code of the same concern (the largest: `// ---- end moving nodes…`@7858 is followed by 742
  lines of job renderers). §3 therefore names, where a section is split, the line or function where the next concern
  starts.
- The sections are uneven: the five largest hold 5,837 lines and `stabilize reordering`@13316 alone is **2,977**; 38 of
  the 118 marker-to-marker rows are under 50 lines, 14 of them a closing marker with nothing after it. Markers name
  concepts, not boundaries.
- **53 browser-stored keys** (`"wtgui.…"`/`"wm.…"` literals), **45 `click` listeners**, 8 of them on `document`.
- **22 of the 26 test files** that read `public/app.js` cut a marker-delimited slice out of it — 11 through the kit's
  `sliceRegion`/`sliceBetween`, 11 through their own `indexOf` pair — and **3 assistant tests** slice
  `public/assistant.js` the same way. Those are the proofs that already run this code outside the page, and they are
  what makes a move landable: the slice's marker text travels with the code and only the path changes.
- `public/assistant.js` is **3,068 lines** in **18 sections** of its own (2-space-indented markers, 2 closers).

## 2. The contract the nine `public/core/` modules already follow

Eight of the nine are loaded by `index.html` before `app.js` and `update-check` after it, and every one is a classic
script that owns no DOM: `dom-format`, `console-format`, `sse` and `transport` publish one object each on
`window.WMApp.core.<name>`, `model-menu` publishes `window.ModelMenu`, and `liveness`, `stream-merge`, `type-stream`
and `update-check` publish `globalThis.wtLive|wtStream|wtType|wtUpdateCheck`, while the units themselves stay **page
globals**, exactly as they were inside `app.js` — which is why no call site changed when `dom-format` moved (209 bare
`esc()` calls from `public/assistant.js` alone — its own header still says 72, a count from when that file was
smaller), nor when `transport` or `sse` did. Each header states what it still reaches for by name at call time
(`state`, `$`, `esc`, `applySnapshot`, `resync`, `showBanner`) and what it was cut
from, line for line; the decisions a node test drives (`quiet`, `fresh`, `merge`, `reloadDecision`) are exported so
the test runs the shipped implementation rather than a copy. **The rule this plan applies everywhere:** pure
value→value work goes to `public/core/`; anything that owns elements goes to `public/features/`; each file publishes
one namespace object, and its `<script>` line in `index.html` is its import — one `init(deps)` call at boot hands it
the slices it reads, so every edge is a named argument on one line instead of a bare global nobody can grep for. A
module that cannot be pure declares its edges in its header and takes them at init; none of them receives the `state`
object itself.

## 3. The module map — every section to a proposed file

Ranges are inclusive at `622940f`, and a section's name is shortened where its marker runs long — the line range is
the reliable half of each pair. "Calls out" is the top names a module reads that are declared outside it; "called
by" the top names it declares that are read outside it (counted over `app.js` only, so a name the hub calls and a
test slices appears in both). `R` = mapped here, scheduled by the follow-on plan in §7.

| Proposed file | Kind | Sections (marker@lines) | Lines | Calls out | Called by | Landing |
|---|---|---|---|---|---|---|
| `public/app.js` (hub — stays) | hub | preamble (keys, `state`, boot constants)@1–309<br>`agents` banner@310–314<br>`rowHtml` (after `end owner cell`@10371)@10372–10465<br>`toggleSettings` (after `end settings search`@16957)@16958–16997<br>`applySettings` (end of the folders row)@18082–18096 | 463 | `reorder`×4, `loadAnchorFlag`×3, `loadOpenTodoFacts`×2 | `state`×1,130, `jobLines`×17, `assistantSessionFor`×6 | — |
| `public/core/rank-order.js` | core | the sliding average@10770–10860<br>one ranked sequence@10861–10941<br>the contexts@10942–11008<br>seeding@11009–11062<br>the ticks@11063–11186 | 417 | `state`×44, `reorder`×5, `RANK_EVENT_CAP`×4 | `orderedByRank`×4, `projectRankCtx`×2, `applyRowRank`×2 | S1 |
| `public/core/tool-groups.js` | core | tool group key@1872–1940<br>end tool group key@1941–1966<br>trimmed group head@1967–2005<br>end trimmed group head@2006–2007 | 136 | `state`×13, `toolGroupHtml`×1, `burstGroups`×1 | `windowLines`×3, `toolGroupStateKey`×2, `rememberToolGroup`×2 | S1 |
| `public/core/subagents.js` | core | subagents@3639–3711<br>attribution@3712–3751<br>end attribution@3752–3798 | 160 | `state`×5, `turnKey`×2, `burstGroups`×1 | `subagentFallback`×10, `subagentLive`×4, `subagentsForTurn`×3 | S1 |
| `public/core/turn-text.js` | core | a turn held on the 429 cap@1015–1086<br>the stats row@3240–3404 (a `// --- ` sub-marker inside the question-box section) | 237 | `state`×2, `turnLive`×2, `modelsState`×1 | `fmtTokens`×5, `isWaiting`×3, `turnStateText`×2 | S2 |
| `public/core/stream-rows.js` | core | one stream: a tool call@2008–2371<br>one stream: the turn's own body@2372–2596<br>the agent's own question@2597–2619 | 612 | `state`×25, `turnLive`×4, `TOOL_DONE_RE`×4 | `questionPicks`×6, `toolGroupHtml`×5, `questionSending`×5 | S2 |
| `public/core/console-rows.js` | core | result row head@6707–6763<br>console row text@6764–6802 | 96 | `state`×2 | `typedShown`×3, `drawRowText`×3, `typedText`×2 | S2 |
| `public/core/cell-html.js` | core | branch cell@10216–10251<br>ahead / behind cell@10252–10319<br>pr cell@10320–10343<br>owner cell@10344–10371 | 156 | `state`×9, `prMatchNote`×1 | `prCellHtml`, `branchCellHtml`, `ownerCellHtml` ×1 each | S3 |
| `public/core/chart-columns.js` | core | chart columns: eleven@12900–13119 (incl. the `end` tail: `COL_WIDTHS_KEY`, `colWidths`, `headerCells`, `naturalColumnWidths`) | 220 | `state`×1, `scheduleColumnFit`×1 | `CHART_COLUMNS`×11, `wtColspan`×5, `shownColumns`×4 | S3 |
| `public/features/age-chart.js` | feature | the age column@10466–10502<br>the age collapse@10503–10769 | 304 | `state`×22, `threadRowKeyCache`×5, `projectNode`×2 | `rowAgeHidden`×4, `paintAgeCell`×2, `pulseProject`×2 | S4 |
| `public/core/settings-values.js` | core | how often the closed board re-sorts@17320–17351<br>how far back the ranking averages@17352–17380<br>how old a worktree may be@17665–17750 | 147 | `state`×9, `reorder`×2, `humanWindow`×2 | `saveReorderSetting`×3, `saveRankWindow`×2, `paintRankWindow`×1 | S5 |
| `public/features/settings-rows.js` | feature | a run of tool calls@6454–6482<br>a fold the reader opens@6483–6510<br>how a run's output arrives@6511–6566 | 113 | `state`×3, `conversationSignature`, `renderConversation` ×1 | `toolGroupsOn`×6, `foldFollowsConsole`×3, `setToolGroups`×2 | S5 |
| `public/features/settings-local.js` | feature | page zoom@16293–16375<br>fonts@16376–16517<br>text styles@16518–16613<br>panel contrast@16614–16667<br>the add-agent bar (green, then where it sits)@16668–16766<br>settings group folds@16767–16834<br>settings search@16835–16957<br>the pickers' start-up + the panel's own wiring@17471–17533 (the tail of the sessions section)<br>the question box's look@17534–17602<br>the anchor's two signals@18097–18339 | 1,040 | `state`×42, `reorder`×8, `applyQLook`×7 | `clearSettingsSearch`, `currentFontId`, `paintAnchorSettings` ×1 | S5 |
| `public/features/settings-server.js` | feature | the provider endpoint@16998–17111<br>the model menu's prices and ratings@17112–17220<br>the approval window@17221–17319<br>how many sessions the CLI's picker lists@17381–17470 (the row only; its tail is S5's)<br>whether an agent may clean up after itself@17603–17664<br>which columns are drawn@17751–17844<br>may a branch exist on a REMOTE@17845–17950<br>the panel's own two folders@17951–18081 | 805 | `state`×39, `showBanner`×11, `CHART_COLUMNS`×9 | `paintPaths`×2, `paintAgentCleanup`×2, `refreshRemoteGuards`×2 | S6 |
| `public/features/assistant/*.js` | feature | — no `app.js` sections: `public/assistant.js`, 18 sections@1–3068 | 3,068 | — | — | S7 |
| `public/features/question-box.js` | feature | the question box's look (Settings > Display)@2620–3239 | 620 | `state`×13, `showBanner`×7, `questionSending`×5 | `turnKey`×11, `applyQLook`×7, `TURNS_PER_PAGE`×4 | R |
| `public/features/conversation.js` | feature | conversations@1178–1871<br>collecting results@3799–4413<br>thinking@6374–6413<br>one stream@6414–6453<br>reasoning first@6567–6706 | 1,529 | `state`×145, `subagentFallback`×8, `turnLive`×7 | `conversations`×22, `captureTyping`×8, `conversationHtml`×7 | R |
| `public/features/reply-box.js` | feature | the box grows with its draft@4414–4608<br>the row's own ⟳@4609–5246<br>New-agent prompt history@5247–5252<br>moving nodes without losing the caret@5726–5886<br>previous turn on send@5887–6118 | 1,232 | `state`×70, `renderConversation`×13, `showBanner`×9 | `restoreTyping`×13, `endDomMove`×9, `beginDomMove`×8 | R |
| `public/features/agent-card.js` | feature | `end moving nodes…`@7858–8600 (the job renderers: `renderJobs`, `renderJobsQueued`, `paintAgentBadges`) | 743 | `state`×46, `jobLines`×5, `isBookkeeping`×4 | `renderConversation`×33, `programmaticScroll`×10, `renderJobs`×7 | R |
| `public/features/console-writers.js` | feature | console writers@6803–7335<br>copy buttons@7336–7387<br>motion nobody can see@7388–7552<br>the reader's own input@7553–7788<br>moving nodes without losing what is scrolled@7789–7857 | 1,055 | `state`×43, `turnKey`×4, `turnLive`×3 | `holdConsoleFor`×8, `placedNodes`×8, `releaseScrolls`×8 | R |
| `public/features/naming.js` | feature | what a worktree is called@5253–5643<br>naming a tree from the work@9609–9762<br>naming by hand@9763–9812<br>a child worktree@9813–9863 | 646 | `state`×47, `showBanner`×17, `normPath`×4 | `answerNameConfirm`×5, `closeAddAgent`×2, `rememberSpawnPrompt`×2 | R |
| `public/features/worktree-actions.js` | feature | retry@8601–8673<br>removing a worktree@9387–9550<br>the reader's lock@9551–9608<br>merge control@9864–9947<br>the UNMERGED chip's chooser@9948–10215 | 647 | `showBanner`×17, `state`×14, `updateJob`×3 | `spawnAgent`×5, `mergePress`×4, `deletableWithoutAsking`×3 | R |
| `public/features/model-picker.js` | feature | picking a session's model@3405–3487<br>the context ceiling@3488–3638<br>the model picker@8674–8932 | 493 | `state`×16, `fmtTokens`×5, `renderConversation`×2 | `updateSpawnNote`×5, `positionModelPop`×3, `clearSpawnPrompt`×3 | R |
| `public/features/approvals.js` | feature | approvals@6119–6172<br>remote writes@6173–6373 | 255 | `state`×19, `permissionBoxHtml`×2, `showBanner`×2 | `approvalSent`×5, `approvalKey`×3, `answerApproval`×2 | R |
| `public/features/board-anchor.js` | feature | the reading anchor@11187–11679<br>board hygiene@11680–11908 | 722 | `state`×45, `ANCHOR_THREAD_KEY`×4, `reorder`×2 | `refreshAnchorBaseline`×12, `fillAgentSlots`×5, `captureBoardAnchor`×4 | R |
| `public/features/board-projects.js` | feature | minimize / expand a card@315–333<br>the height a console was dragged to@334–534<br>folder layer@535–643<br>filter one folder@644–685<br>collapse-all in one folder@686–859<br>clone a repo into a folder@860–1014<br>the live pulse@1087–1177<br>the inline add-agent field@5644–5725<br>`worktrees` banner + its rows@8933–9386 | 1,327 | `state`×126, `rememberAddAgentCaret`×6, `renderConversation`×5 | `turnLive`×26, `normPath`×17, `agentsFor`×8 | R |
| `public/features/board-panels.js` | feature | the worktree's TODO list@11909–12448<br>project ordering + the green "+"@12449–12542<br>the board's own children@12543–12707<br>a project's branches and PRs@12708–12899<br>how wide the split may be@13120–13234<br>dragging a column edge@13235–13315 | 1,187 | `state`×75, `RECENT_DAYS`×5, `labelRoot`×4 | `refreshChips`×12, `reorderProjects`×7, `detailHtml`×4 | R |
| `public/features/board.js` | feature | stabilize reordering@13316–16292 | 2,977 | `state`×250, `restoreTyping`×7, `refreshChips`×7 | `showBanner`×78, `reorder`×22, `showNote`×7 | R |
| `public/features/visibility.js` | feature | what the page can see@18340–18426 | 87 | `state`×5, `paintConfigLine`, `startAnchorObserver` ×1 | `visibleProjects`, `reportVisibility` ×1 | R |

**Totals: 118 regions, 18,426 lines — every one has a home.** 463 stay in the hub, **4,443** move in S1–S6, 13,520
are `R`; S7 adds `public/assistant.js`'s 3,068 lines.

## 4. The landing order — cheapest blast radius first

Cheapest means: no DOM, no state beyond one slice, and a proof that already runs the code outside the page. The 22
page-slice tests are that proof — they execute these sections standalone — so the sections they name come first. The
one renderer that owns DOM but takes its data as arguments comes next. The settings surface follows: it is the most
read surface in the panel (a settings bug is visible to every reader) and it writes both the browser and
`config.json`. The assistant float is last: it is a separate file that reads `app.js` by bare name and calls one
function back, so its landing is the one that replaces those reads with an init call.

| Landing | Moves | Files | Lines | Why here |
|---|---|---|---:|---|
| S1 | ranking maths, tool-group identity, subagent attribution | `core/rank-order.js`, `core/tool-groups.js`, `core/subagents.js` | 713 | no DOM; two sections already sliced by tests and two verify scripts read the ranking through the page |
| S2 | held-turn text, stats row, stream and console row builders | `core/turn-text.js`, `core/stream-rows.js`, `core/console-rows.js` | 945 | no DOM; five sections already sliced by tests |
| S3 | the four cells and the chart-column plan | `core/cell-html.js`, `core/chart-columns.js` | 376 | no DOM; four sections sliced by tests; the column table has a `lib/` twin to pin |
| S4 | the age cell and the age-collapse chart | `features/age-chart.js` | 304 | the one renderer that owns DOM but takes rows and settings in; one stored key; one verify harness |
| S5 | settings values, the three Agent-cards/Display rows, the browser-stored settings surface | `core/settings-values.js`, `features/settings-rows.js`, `features/settings-local.js` | 1,300 | first settings landing: the browser-stored half only, no route changes |
| S6 | the rows that write `config.json` / the gateway's config | `features/settings-server.js` | 805 | second settings landing: the server-stored half; no route moves |
| S7 | the assistant float | `features/assistant/*.js` (from `public/assistant.js`) | 3,068 | last: replaces `app.js`'s bare reads with one init call |

One step per PR, in this order. S5 is the widest step and the only one that needs a comment-only PR first: §3's S5
row takes one slice out of a section named for something else (`@17471–17533` sits under "how many sessions the
CLI's picker lists"), so that PR adds the missing `// ---- ` pair and moves nothing.

## 5. Each landing: the seam

The seam rule for every row below: **app.js keeps the state, the boot order and the wiring; the module gets the
slices it reads in one `init(deps)` call at boot; a call site is `WMApp.<name>.<fn>(...)`, and a name stays a page
global only where a shipped harness reads it through `page.evaluate`.** A module that only reads or only writes one
slice gets accessors and callbacks, not the `state` object.

### S1 — ranking maths, tool-group identity, subagent attribution

| | |
|---|---|
| Keeps in app.js | `state` (`rankOrder`, `rankSeeded`, `rankProjSeeded`, `rows`, `projects`, `rankWindowSeconds`), the 1 s and 5 s timers that call the tick, `reorder()`, the boot order |
| Moves | 47 units — the whole rank engine: `rankScore`, `rankWindowMs`, `pushEventLife`, `pruneRankWindows`, `seedRankWindows`, `seedProjectRank`, `orderedByRank`, `rankIdealOrder`, `applyRowRank`, the four context builders (`agentRankCtx`, `folderRankCtx`, `projectRankCtx`, `rowRankCtx`), `tickRankedOrder` + `tickRowScope`/`tickProjectScopes`/`tickAgentScopes`, `reorderAgentCards`; `toolGroupAnchor`, `toolGroupStateKey`, `rememberToolGroup`, `toolGroupDropsState`, `windowLines`, `BATCH_TAIL_RE`, `linkBatchTail`, `trimmedBurstHtml`, `trimmedGroupHtml`, `TURN_WINDOW`; `childOwner`, `turnWindow`, `turnBounds`, `subagentsForTurn`, `subagentFallback`, `subagentLive`, `subagentRosterAt`, `subagentsHtml`, `subagentsCompactHtml`, `turnSubagentsHtml`, `subConsoleHtml`, `fmtSeconds`, `CHILD_SLACK_MS` |
| How they talk | one `<script src="/core/rank-order.js">` before `/app.js` is the import; then `WMApp.rankOrder.init({ getOrder, setOrder, getSeeded, setSeeded, getRows, getProjects, now, requestTick })` — the six `state` fields as named accessors, never the object. The timers call `WMApp.rankOrder.tickRankedOrder(scope)`. `rankScore`, `applyRowRank` and `toolGroupAnchor` stay page globals because `tools/verify-ranking-scopes.mjs`, `tools/verify-row-rank-smoothing.mjs` and `tools/verify-lane-a-burst.mjs` reach them by name from the page |
| Harnesses | `test/tool-group-key.test.js` re-points its two `between()` reads to the module; `tools/verify-subagent-turns.mjs` re-points `readFileSync` (it slices `// ---- subagents: attribution`); `verify-lane-a-burst.mjs`'s `refs` block (`find("public/app.js", /^function windowLines/)`) must search the module or report `?` for every line it cites; `npm test` |

### S2 — held-turn text and the stream/console row builders

| | |
|---|---|
| Keeps in app.js | `state`, `turnLive`, the `conversationHtml` call sites, the settings reads (`toolGroupsOn`, `typeWordSpeed`, `typeLineRate`) |
| Moves | `waitNote`/`waitNext`/`waitTries`/`turnStateText`/`jobStatusWord`/`jobStatusClass`/`isWaiting`, `fmtTok`/`fmtTokens`/`fmtUsd`/`statsLine`/`statsRowHtml` + the context bar; `toolGroupHtml`, `streamBodyHtml`, `turnBody`, `toBottomBtnHtml`, `paintToBottom`, `questionHead`/`questionPicks`/`questionSending`/`questionDrafts`, `permissionBoxHtml`, the approval-row builders; the result-row head (`resultRowIndex`, `rowTakesTail`), `drawRowText`, `shouldPaceResultRow`, `typedShown`, `typedText`, `resultRowIndex`, `rowTakesTail` |
| How they talk | stateless string builders called with their data: `WMApp.streamRows.toolGroupHtml(burst, { window, settings })`. The `state×25` reads become named arguments from `init({ getSettings, getOpenGroup, setOpenGroup, getRows })`; nothing is cached between calls |
| Harnesses | `test/result-row-head.test.js`, `test/console-row-text.test.js`, `test/console-typed-line.test.js` (path change only — `sliceRegion`/`sliceBetween` marker text moves with the code); `test/tool-call-rows.test.js` and `test/tool-usage-group.test.js` read the same sections by `indexOf`; `npm test` |

### S3 — the cell builders and the chart column plan

| | |
|---|---|
| Keeps in app.js | `rowHtml`'s cell map (it stays in the hub), the column-width application in the board, `scheduleColumnFit` |
| Moves | `branchCellHtml`, `aheadBehindCellHtml`, `vsMainLine`, `prCellHtml`, `prMatchNote`, `ownerNameOf`/`ownerLabelOf`/`ownerRoleOf`, `ownerCellHtml`, `ownerDetailHtml`; `WT_COLS`, `CHART_COLUMNS`, `COL_MIN`, `COL_GIVE`, `COL_WIDTHS_KEY`, `shownColumns`, `hiddenColumnIds`, `columnPlan`, `headerCells`, `wtColspan`, `chartHeaderHtml`, `colWidths`, `loadColWidths`, `saveColWidths`, `naturalColumnWidths`, `applyColumnWidths` |
| How they talk | stateless: `WMApp.cellHtml.prCellHtml(row)`. `WMApp.chartColumns.CHART_COLUMNS` is data read by the hub's header/rows, by `lib/chart-columns.js`'s client twin in `test/chart-columns.test.js`, and by S6's column row. `rowHtml` keeps calling the cells by bare name, so its five references do not change |
| Harnesses | `test/branch-cell`, `ahead-behind-cell`, `pr-cell-none`, `owner-cell` (each `sliceRegion`s `../public/app.js`), `test/chart-columns` (asserts the client table against `lib/chart-columns.js`), `test/worktree-assistant`, `npm test` |

### S4 — the age cell and the age-collapse chart

| | |
|---|---|
| Keeps in app.js | `state.rows`/`state.settings`, the `rowHtml` call for the age cell, the chart header's refresh, the sweep that repaints |
| Moves | `ageCellHtml`, `ageSlotHtml`, `paintAgeCell`, `rowAgeHidden`, `rowAgeStale`, `staleRowCount`, `toggleShowOld`, `ageHideDays`, `RING_C`, `ringOffset`/`ringStroke`/`ringState`/`restartClassAnimation`, `rowActivityAt`/`eventLifeAt`/`lifeAtFor`/`rowKeyForThread`/`rowNode`, `pulseRow`/`pulseProject` |
| How they talk | `WMApp.ageChart.init({ getRows, getSettings, getExpanded, doc, pulseRow, pulseProject })` — the two hub pulses it calls are callbacks. Exposes `ageCellHtml(row)`, `rowAgeHidden(row)`, `paintAgeCell(el, row)` |
| Harnesses | `node tools/verify.mjs --only age-collapse` drives the real chart in a browser; its only reference to `public/app.js` is prose (lines 38 and 439 name it as the home of `rowAgeHidden`), so nothing runs differently — but that sentence is a claim about where the filter lives, and it re-points to the module in the same PR; `npm test` |

### S5 — the settings surface, browser-stored half

| | |
|---|---|
| Keeps in app.js | `state.settings`, `applySettings()` (the snapshot merge every module reads), the `#settings` element, `toggleSettings()`, `showBanner` |
| Moves | `reorderSeconds`/`rankWindowMs`/`ageDaysSentence` and their save/paint pairs; the three Settings > Agent cards / Display rows; page zoom, fonts, text styles, contrast, the add-agent bar (two rows), group folds, settings search, `initFonts`/`initQLook` and the panel's own wiring block (the three open/close presses included), the question-box look block, the anchor's two signals |
| How they talk | `WMApp.settingsLocal.init({ doc, $, getSettings, mergeSettings, applySettings, renderAll, showBanner, toggleSettings, applyQLook })`, called once after the first `applySettings`. The module's init runs the listener block that is top-level code today, which is why `toggleSettings` and `applyQLook` arrive as callbacks: both stay in `app.js` until §7 |
| Harnesses | `test/settings-groups.test.js` (2 sections), `test/text-styles.test.js` (`indexOf`), `test/stream-default.test.js` (its `sliceBetween` end marker `// ---- a run of tool calls` now lives in `settings-rows.js`), `npm test`. **`index.html` does not move** — its 48 static `settings-row` elements and their ARIA stay where the tests read them |

### S6 — the settings surface, server-stored half

| | |
|---|---|
| Keeps in app.js | `apiFetch`, `showBanner`, `state.settings`, `applySettings`, `paintConfigLine` and the paint callbacks the rows own today |
| Moves | the provider, models, approvals, sessions, agent-cleanup, chart-columns, remote-policy and folders rows |
| How they talk | `WMApp.settingsServer.init({ apiFetch, showBanner, getSettings, mergeSettings, paintConfigLine, refreshRemoteGuards, paintChartColumns, renderAll })`; each row keeps calling its existing route and merges the answer through `mergeSettings` |
| Harnesses | no page-slice test covers these rows, and no route moves; `test/agent-cleanup.test.js` slices the cleanup section out of `public/app.js` (path change), `test/chart-columns.test.js` covers the column route, `test/auth.test.js` the settings route's token; `npm test` |

### S7 — the assistant float

| | |
|---|---|
| Keeps in app.js | nothing of the float except one init call and the two globals it publishes today (`applyAssistant`, `__assistantRenderChat`) |
| Moves | the IIFE's 18 sections into eight files: `frame.js` (the float's two rows, the panel's own frame, drag and resize, keys), `chat.js` (the spawn strip, chat), `lists.js` (alerts, watches, scratchpad, the message board), `role.js` (role and charter), `settings.js` (settings), `queue.js` (the queue sub-tab, the queue's controls), `server.js` (what arrives from the server, talking to the server), `boot.js` (wiring, boot) |
| How they talk | `WMApp.assistant.init({ state, $, esc, conversations, conversationHtml, renderConversation })` after the first snapshot; the module publishes `applyAssistant(thread)`, `renderChat(thread)`, `toggle(open)`, and app.js's SSE/snapshot path calls `WMApp.assistant.applyAssistant(thread)` instead of the bare global |
| Harnesses | `test/assistant-subtabs`, `assistant-thresholds`, `assistant-queue-ui` slice `public/assistant.js` by marker; `assistant-resize` and `assistant-queue` read it; the browser verifies drive the same ids and need no change |

## 6. The invariant every landing carries

1. **No behaviour change.** A section moves with its comments, markers, names and whitespace intact. The only new
   text is the `init` call in `app.js` and, where a call site is qualified, the qualifier. The module keeps the
   section's marker lines verbatim, so a page-slice test changes its `readFileSync` path and nothing else.
2. **The existing verification harnesses still pass.** Every test and verify script named in §5's Harnesses row is
   re-pointed in the same PR and run: `npm test`, `node tools/verify.mjs --only <area>`, and the pre-push
   `node tools/version.mjs check`. A harness that reads `public/app.js` to prove something about a line it no longer
   holds is a broken proof, not a passing one.
3. **One step per PR.** One branch, one commit, one revertable unit — never two landings in one PR.
4. **A version bump in the commit that carries it.** A behaviour-preserving refactor is a **patch**
   (`docs/versioning.md`), applied with `node tools/version.mjs apply patch` over main's current number; the level
   and its reason go in the commit body and the PR body, so a revert takes both.
5. **No module receives the `state` object.** The one shared store that remains is `state`, and each module gets the
   slices it reads as named accessors in its `init` call — visible, greppable, and one line per edge. A classic
   script is not a licence for a bare read.

## 7. What this plan does not schedule

The `R` rows in §3 (13,520 lines) stay in `app.js` for a follow-on plan, for two reasons: `stabilize
reordering`@13316 (2,977 lines) and `end moving nodes…`@7858 (743 lines) hold several concerns under one marker, so
their first landing is a **comment-only PR that adds internal markers and moves no code**; and the board modules read
the hub's `renderAll`/`placeRow`/`applySnapshot` directly, so they need that sub-marker pass first, and `board.js`
needs its own plan. Order within `R`, cheapest first: `naming` → `worktree-actions` → `approvals` → `model-picker` →
`question-box` → `visibility` → `conversation` → `reply-box` → `console-writers` → `agent-card` → `board-anchor` →
`board-panels` → `board-projects` → `board`.

## 8. What moved since the first version, and what §1 got wrong

The first version was measured at `fb9e6eb` (0.51.4). Two landings have touched `public/app.js` since, both about the
new owner column:

- **the owner cell** — `10344–10371` (`ownerNameOf`, `ownerLabelOf`, `ownerRoleOf`, `ownerCellHtml`,
  `ownerDetailHtml`), plus one line in `rowHtml`'s cell map and one in `detailHtml`'s bullet list: +33 lines before
  `@10466`, which re-based **43 of the 118 regions**. It lands in `core/cell-html.js` (S3), which is where a
  cell-builder belongs; §3's first version swallowed `rowHtml`'s first 90 lines into that module by taking the
  `end pr cell` tail, and this version stops the module at the `end owner cell` marker and leaves `rowHtml` in the
  hub.
- **the eleventh chart column** (`assistant`, `min: 92`) — the section is now `@12900–13119` (220 lines, was 212) and
  its marker reads "eleven", not "ten"; the row for `settings-server.js` still takes the column *setting*, while the
  table itself is `chart-columns.js`'s.
- **the sessions section's tail is not the sessions row.** `initFonts`, `initQLook` and the settings panel's own
  listener block sit under `// ---- how many sessions the CLI's picker lists` (`@17471–17533`); the first version
  gave that whole section to `settings-server.js`. §3 now splits it at `@17470`/`@17471`: the sessions row is S6's,
  the initialisers and wiring are S5's, which is the sub-marker PR §4 describes.
- **`public/assistant.js` grew 2,835 → 3,068 lines** (the role label and its queue), and it now carries 18 sections
  of its own; S7's file list follows them.
- **§1's counts are re-taken, not carried, and four were wrong at the original base.** The first version said "118
  marker comment lines forming 119 regions" (the file had **116** `^// ----` lines at `fb9e6eb`: 97 openers, 19
  closers), "54 distinct `localStorage` keys" (**53**), "five document/element click handlers" (**8** on `document`,
  45 in all), and "eight regions hold 7,319 lines" (**7,484**); it also said 18,385 lines where the file had 18,384 (a
  trailing line counted). What it got right stays: 910 top-level declarations, 712 functions, 36 sections under 50
  lines. This version states each count beside the command that produces it, and both byte counts.

**One defect found while re-measuring, which no landing above owns: `fmtBytes` is defined twice.** `public/app.js`
@17964 formats B/KB/MB/GB/TB with one decimal place; `public/core/dom-format.js`@170 prints MB with one decimal and
KB with none. Both are top-level `function` declarations in classic scripts, so **app.js's copy silently replaces the
module's** — and `public/board/attachments.js` and `public/assistant.js` call the bare name, so they get app.js's copy
while `WMApp.core.domFormat.fmtBytes` stays the module's: two formats for one fact, decided by `<script>` order. S6
would carry the app.js copy into `settings-server.js` as a third one. Fix it before S6 — keep the module's, delete the
app.js copy, and let the folders row call `fmtBytes` from `dom-format`, which already publishes it.

## 9. Landing this document

This PR is a doc: **patch** per `docs/versioning.md`. At `0.53.3` the next free patch is **0.53.4** — `node
tools/version.mjs suggest` prints the floor and `git show origin/main:package.json` the number to beat; re-take it
immediately before landing, because another landing can spend it while this branch waits. It already has: the plan was
measured against 0.53.2 and a sibling doc landing took 0.53.3, so this branch was fast-forwarded before the bump
rather than rebased after it. Bump in the commit that carries the plan, name the number, the level and the reason in
the commit body and the PR body, then `git push -u origin HEAD` and `gh pr create --fill`. If main has moved,
`git rebase origin/main` first and re-take the number; a rebase over a spent number leaves the branch equal to main
and the pre-push gate refuses it.
