# Splitting `public/app.js` — the plan

This document is a plan, not a change: the PR that lands it touches nothing under `public/`, and no server or
`lib/` file. It maps every marker region in `public/app.js` to a proposed module, ranks the extractions by blast
radius, and fixes the seam and the invariant each landing carries. The split follows the pattern the repo already
uses for `public/core/*` and `public/board/*`: a classic `<script>` moved line for line into a file loaded before
`app.js`, one published namespace object, and the edges it still reaches for declared in the header.

## 1. The file, measured

- 972,997 bytes, 18,385 lines, 118 marker comment lines forming **119 regions**, 910 top-level declarations
  (712 functions).
- Two top-level dividers (`agents`@310, `worktrees`@8933); only ten `// ---- end …` closers. Those closers are a
  **test API**: `tools/panel-testkit.mjs`'s `sliceRegion` searches for `// ---- <name>` and `// ---- end <name>`.
- **Ten test files** slice `app.js` by marker and `new Function` the slice (`ahead-behind-cell`, `branch-cell`,
  `chart-columns`, `console-row-text`, `console-typed-line`, `pr-cell-none`, `prev-turn-mode`, `result-row-head`,
  `settings-groups` ×2, `stream-default`); four more slice the same marker text with `indexOf` (`tool-group-key`,
  `stream-button-title`, `new-agent-reasoning`, `text-styles`).
- The regions are uneven: eight regions hold 7,319 lines between them — 40% of the file, and `stabilize
  reordering`@13274 alone is **2,977 lines under one marker** — while 36 regions are under 50 lines. Markers name
  concepts, not module boundaries; §92 and §55 have to be sub-marked before they can move.
- 54 distinct `localStorage` keys, five document/element click handlers (one 1,113 lines with 88 `data-*` actions),
  and 29 comments that name a `lib/` module as the owner of a fact the client re-draws.

## 2. The contract the nine `public/core/` modules already follow

Read their headers and their publication lines: nine modules in `public/core/` — eight loaded before `app.js`, and
`update-check` after it because it reads `app.js`'s state by name at call time. The three whose headers cite an
extraction (`dom-format`, `transport`, `sse` — M2, M3, M4) were moved line for line from an `app.js` region with the
original marker text intact; the rest were written to the same shape. Each publishes one object
(`window.WMApp.core.<name>`, `window.ModelMenu`, or `globalThis.wtStream|wtLive|wtType|wtUpdateCheck`) whose header
names what it still reaches for by name at call time (`state`, `$`, `esc`, `applySnapshot`, `resync`). **None of
them owns the DOM**: they format values, merge streams, answer "is the live path alive?", pace output, carry HTTP,
translate SSE frames and decide a reload — the document and the elements are always the caller's. That is the rule
this plan applies everywhere: **pure helpers go to `public/core/`, DOM owners to `public/features/`, one namespace
object per file, dependencies named in the header and passed in at init.** A module that cannot be pure declares
its edges instead of pretending it has none.

## 3. The module map — every marker to a proposed file

Region names are abbreviated where long; line ranges are exact. "Calls out" lists the top names this module's
regions reference; "called by" lists the top names they define that other regions call. Landing `R` means the
module is mapped here but not scheduled by this plan (§7).

| Proposed file | Kind | Regions (marker@lines) | Lines | Calls out | Called by | Landing |
|---|---|---|---|---|---|---|
| `public/app.js` (hub — stays) | hub | (preamble: keys, state, boot)@1–309<br>agents@310–314 | 314 | reorder×4, loadAnchorFlag×3, loadOpenTodoFacts×2, loadAnchorSeconds×2 | state×784, jobLines×7, assistantSessionFor×5, SPAWN_HISTORY_MAX×4 | — |
| `public/core/rank-order.js` | core | the sliding average every liveness ranking is built on@10737–10827<br>one ranked sequence, advanced a tick at a time@10828–10908<br>the contexts: what each scope ranks on@10909–10975<br>seeding: the first paint is the smoothed order@10976–11029<br>the ticks: the order moves here and nowhere else@11030–11153 | 417 | state×35, pushEventLife×7, lifeProjKey×5, rankScore×4, tickRankedOrder×4 | pushEventLife×7, orderedByRank×6, lifeProjKey×5, rankScore×4 | S1 |
| `public/core/tool-groups.js` | core | tool group key: what a burst is remembered BY@1872–1940<br>end tool group key@1941–1966<br>trimmed group head: a burst that lost its call line is still a group@1967–2005<br>end trimmed group head@2006–2007 | 136 | state×9, toolGroupAnchor×2, burstGroups×1, fullForFold×1 | toolGroupAnchor×4, toolGroupStateKey×3, rememberToolGroup×3, windowLines×3 | S1 |
| `public/core/subagents.js` | core | subagents@3639–3711<br>subagents: attribution (pure, so tools/verify-subagent-turns.mjs can run it)@3712–3751<br>end attribution@3752–3798 | 160 | state×3, turnKey×2, lineHtml×1, burstGroups×1 | subagentFallback×9, subagentLive×3, subagentsHtml×2, subagentsCompactHtml×2 | S1 |
| `public/core/turn-text.js` | core | a turn held on the gateway's 429 cap@1015–1086<br>the stats row above an agent's reply box@3240–3404 | 237 | turnLive×2, fmtTok×1, modelsState×1 | fmtTokens×5, isWaiting×2, fmtTok×2, waitNote×1 | S2 |
| `public/core/stream-rows.js` | core | one stream: a tool call, drawn as a row of it@2008–2204<br>the reader's tool-usage group: ONE row per call@2205–2371<br>one stream: the turn's own body, drawn in its order@2372–2596<br>the agent's own question (the clarify tool)@2597–2619 | 612 | state×25, TOOL_DONE_RE×4, turnLive×4, liveSuffix×3, lineHtml×3 | toolGroupHtml×6, questionSending×5, toBottomBtnHtml×2, turnBody×2 | S2 |
| `public/core/console-rows.js` | core | result row head@6707–6730<br>end result row head@6731–6763<br>console row text@6764–6800<br>end console row text@6801–6802 | 96 | state×2 | drawRowText×3, typedShown×2, typedText×2, RESULT_PACED_ROWS×1 | S2 |
| `public/core/cell-html.js` | core | the branch cell: a link only when the remote actually has that branch@10216–10230<br>branch cell: the link, and the local chip@10231–10249<br>end branch cell@10250–10251<br>ahead / behind cell: the branch against its OWN copy@10252–10317<br>end ahead / behind cell@10318–10319<br>pr cell: the number and the state, or the one word 'none'@10320–10341<br>end pr cell@10342–10432 | 217 | state×3, CHART_COLUMNS×2, prMatchNote×1, isProjectRootRow×1 | rowHtml×2, branchCellHtml×1, aheadBehindCellHtml×1, prCellHtml×1 | S3 |
| `public/core/chart-columns.js` | core | chart columns: which of the table's ten the reader keeps@12866–12951<br>end chart columns@12952–13077 | 212 | WT_COLS×2, COL_MIN×2, state×1, CHART_COLUMNS×1 | CHART_COLUMNS×11, COL_MIN×5, wtColspan×4, shownColumns×4, headerCells×4 | S3 |
| `public/core/settings-values.js` | core | how often the closed part of the board re-sorts@17278–17309<br>how far back the row ranking averages@17310–17338<br>how old a worktree may be before the chart holds its row back@17623–17708 | 147 | state×8, reorder×2, humanWindow×2, REORDER_MAX×2 | — | S5 |
| `public/features/age-chart.js` | feature | the age column: last life seen, plus a ring that fills toward the next read@10433–10469<br>the age collapse: which rows a chart is holding back@10470–10736 | 304 | state×19, threadRowKeyCache×5, lifeAtFor×3, projectNode×2 | rowAgeHidden×4, lifeAtFor×3, eventLifeAt×2, RING_C×2, pulseProject×2 | S4 |
| `public/features/settings-rows.js` | feature | a run of tool calls: tallied, or one line each (Settings > Agent cards)@6454–6482<br>what a fold the reader opens does to the console@6483–6510<br>how a run's output arrives (Settings > Display)@6511–6566 | 113 | conversations×1, conversationSignature×1, renderConversation×1 | toolGroupsOn×5, foldFollowsConsole×1, typeWordSpeed×1, typeLineRate×1 | S5 |
| `public/features/settings-local.js` | feature | page zoom@16251–16333<br>fonts: two settings, not one@16334–16475<br>text styles: thinking, skill output, console@16476–16569<br>end text styles@16570–16571<br>panel contrast@16572–16625<br>the add-agent bar's green@16626–16673<br>where the add-agent bar sits@16674–16724<br>settings group folds@16725–16790<br>end settings group folds@16791–16792<br>settings search@16793–16915<br>end settings search@16916–16955<br>the question box's look: tint, size, density@17492–17560<br>the anchor's two signals: hover and last touched@18055–18297 | 1,017 | state×20, TERM_SIZES×2, paintSettingsFold×2, fitAllColumns×1 | TERM_SIZES×4, applyTermStyle×2, currentFontId×2, FONT_SETS×2, paintSettingsFold×2 | S5 |
| `public/features/settings-server.js` | feature | the provider endpoint every run talks to@16956–17069<br>the model menu's prices and ratings@17070–17178<br>the approval window@17179–17277<br>how many sessions the CLI's picker lists@17339–17491<br>whether an agent may clean up after itself@17561–17620<br>end agent cleanup@17621–17622<br>which of the chart's columns are drawn@17709–17802<br>may a branch exist on a REMOTE at all?@17803–17908<br>the panel's own two folders@17909–18054 | 883 | state×40, showBanner×9, CHART_COLUMNS×8 | humanWindow×2, paintPaths×2, loadProviderSetting×1, loadModelsSetting×1 | S6 |
| `public/features/question-box.js` | feature | the question box's look (Settings > Display)@2620–3239 | 620 | state×12, showBanner×7, questionSending×5, turnLive×3 | turnKey×11, fmtLeft×3, TURNS_PER_PAGE×3, turnBlock×2 | R |
| `public/features/conversation.js` | feature | conversations@1178–1871<br>collecting results@3799–4413<br>thinking@6374–6413<br>one stream@6414–6453<br>reasoning first: a tool's lines wait for the thought@6567–6706 | 1,529 | state×92, turnLive×7, subagentFallback×6, showBanner×3 | conversations×15, TOOL_DONE_RE×8, captureTyping×8, isBookkeeping×7 | R |
| `public/features/reply-box.js` | feature | the box grows with its draft@4414–4608<br>the row's own ⟳@4609–5246<br>New-agent prompt history@5247–5252<br>moving nodes without letting go of the caret@5726–5886<br>previous turn on send@5887–5936<br>end previous turn on send@5937–6118 | 1,232 | state×61, renderConversation×13, showBanner×9, focusReplyBox×5 | restoreTyping×12, endDomMove×8, beginDomMove×7, restoreAddAgent×6 | R |
| `public/features/agent-card.js` | feature | end moving nodes without losing what is scrolled inside them@7858–8600 | 743 | state×36, isBookkeeping×4, assistantSessionFor×3 | renderConversation×27, programmaticScroll×10, updateJob×6 | R |
| `public/features/console-writers.js` | feature | console writers@6803–6837<br>the board's consoles, without walking the board@6838–6911<br>end console writers@6912–7335<br>copy buttons@7336–7387<br>motion nobody can see@7388–7552<br>the reader's own input, per card@7553–7576<br>end the reader's own input, per card@7577–7788<br>moving nodes without losing what is scrolled@7789–7857 | 1,055 | state×33, setScroll×6, consolePinned×4, turnKey×4 | setScroll×12, releaseScrolls×8, consolePinned×6, holdScrolls×6 | R |
| `public/features/naming.js` | feature | what a worktree is called on the board@5253–5643<br>naming a tree from the work in it@9609–9762<br>naming a tree by hand (the ✎)@9763–9812<br>a child worktree off this row's branch@9813–9861<br>end a child worktree@9862–9863 | 646 | state×46, showBanner×17, normPath×4, SPAWN_HISTORY_MAX×4 | saveTreeNames×3, rememberSpawnPrompt×2, isProjectRootRow×2 | R |
| `public/features/worktree-actions.js` | feature | retry@8601–8673<br>removing a worktree@9387–9550<br>the reader's lock: one press, one scope@9551–9608<br>merge control: the UNMERGED chip@9864–9945<br>end merge control@9946–9947<br>the UNMERGED chip's chooser@9948–10215 | 647 | showBanner×17, state×13, mergeInFlight×6, updateJob×3 | mergeInFlight×6, rebaseTargetOf×3, spawnAgent×2, rowConfirmSent×2 | R |
| `public/features/model-picker.js` | feature | picking a session's model@3405–3487<br>the context ceiling@3488–3638<br>the model picker@8674–8932 | 493 | state×13, modelsState×5, fmtTokens×5, closeModelPop×4 | modelsState×6, closeModelPop×4, positionModelPop×3, clearSpawnPrompt×3 | R |
| `public/features/approvals.js` | feature | approvals@6119–6172<br>remote writes: the panel's own permission box@6173–6373 | 255 | state×8, approvalThreadsShown×2, showBanner×2 | approvalSent×3, approvalKey×3, approvalThreadsShown×2 | R |
| `public/features/board-anchor.js` | feature | the reading anchor@11154–11646<br>board hygiene@11647–11875 | 722 | state×41, ANCHOR_THREAD_KEY×3, PROJECT_HUE_KEY×2 | refreshAnchorBaseline×9, flashRingMs×4, captureBoardAnchor×4, scheduleBoardSweep×4 | R |
| `public/features/board-projects.js` | feature | minimize / expand a card@315–333<br>the height a console was dragged to@334–534<br>folder layer@535–643<br>filter one folder's projects@644–685<br>collapse-all inside one folder@686–859<br>clone a repo into a folder@860–1014<br>the live pulse@1087–1177<br>the inline add-agent field's own events@5644–5725<br>worktrees@8933–9386 | 1,327 | state×89, normPath×7, saveCollapsedJobs×6, renderConversation×5 | turnLive×28, normPath×24, agentsFor×8, saveCollapsedJobs×6 | R |
| `public/features/board-panels.js` | feature | the worktree's TODO list@11876–12414<br>project ordering + the green "+"@12415–12508<br>the board's own children, not its subtree@12509–12673<br>where a project's branches and PRs live@12674–12865<br>how wide the split is allowed to be@13078–13192<br>dragging a column edge@13193–13273 | 1,186 | state×60, RECENT_DAYS×5, labelRoot×4, headerCells×4 | refreshChips×11, reorderProjects×7, detailHtml×3, fitAllColumns×3 | R |
| `public/features/board.js` | feature | stabilize reordering@13274–16250 | 2,977 | state×113, refreshChips×7, restoreTyping×6, endDomMove×5 | showBanner×72, reorder×10, showNote×7, renderProjectRows×5, renderAll×5 | R |
| `public/features/visibility.js` | feature | what the page can see@18298–18385 | 88 | state×1 | — | R |
| `public/features/assistant/*.js` | feature | _no app.js markers_ (public/assistant.js, 2,835 lines) | — | — | — | S7 |

Totals: 119 regions, 18,385 lines — every marker has a home. Scheduled landings S1–S7 move 4,551 lines plus the
2,835-line `public/assistant.js`; the 13,520 lines marked `R` stay in `app.js` until §7's follow-on plan.

## 4. The landing order — cheapest blast radius first

Cheapest means: no DOM, no state beyond one slice, and a proof that already runs the code outside the page. The ten
page-slice tests are that proof — they already execute these regions standalone — so the regions they name come
first. The one renderer that owns DOM but takes its data as arguments comes next. The settings surface follows:
it is the most-read surface in the panel (a settings bug is visible to every reader) and it writes both the
browser and `config.json`. The assistant float is last: it is a separate file that reads `app.js` by bare name and
calls one function back, so its landing is the one that replaces those bare reads with an init call.

| Landing | Moves | Files | Lines | Why here |
|---|---|---|---:|---|
| S1 | ranking maths, tool-group identity, subagent attribution | `core/rank-order.js`, `core/tool-groups.js`, `core/subagents.js` | 713 | no DOM; two regions already sliced by tests; subagent attribution already run by a verify tool |
| S2 | held-turn text, stats row, stream/console row builders | `core/turn-text.js`, `core/stream-rows.js`, `core/console-rows.js` | 945 | no DOM; three regions already sliced by tests |
| S3 | branch/ahead-behind/PR cells, chart column plan | `core/cell-html.js`, `core/chart-columns.js` | 429 | no DOM; four regions already sliced by tests; the column plan has a server twin to pin |
| S4 | the age cell and the age-collapse chart | `features/age-chart.js` | 304 | the one renderer that owns DOM but takes rows/settings in; one localStorage key; one verify harness |
| S5 | settings values, the three Settings>Cards/Display toggles, the browser-stored settings rows | `core/settings-values.js`, `features/settings-rows.js`, `features/settings-local.js` | 1,277 | first settings landing: browser-stored half only, no route changes |
| S6 | the settings rows that write `config.json` / the gateway's `config.yaml` | `features/settings-server.js` | 883 | second settings landing: server-stored half; routes stay put |
| S7 | the assistant float | `features/assistant/*.js` (from `public/assistant.js`) | 2,835 | last: replaces `app.js`'s bare reads with one init call |

## 5. Each landing: the seam

The seam rule for every row below: **app.js keeps the state singleton, the boot order and the wiring; the module
gets its dependencies in one `init(deps)` call at boot; a call site is `WMApp.<name>.<fn>(...)`, never a bare
global.** A module that only reads or only writes one slice gets accessors and callbacks, not the `state` object.

### S1 — ranking maths, tool groups, subagent attribution

| | |
|---|---|
| Keeps in app.js | `state` (the rank windows, `agentOrder`, `expanded`, `rows`), the 1 s/5 s timers that call the tick, the boot order |
| Moves | `orderedByRank`, `tickRankedOrder`, `rankScore`, the four context builders, `pushEventLife`, `pruneRankWindows`, `seedRankWindows`; `toolGroupAnchor`, `toolGroupStateKey`, `rememberToolGroup`, `windowLines`, `trimmedBurstHtml`, `trimmedGroupHtml`; `subagentFallback`, `subagentLive`, attribution (`childOwner`, `turnWindow`) and the two subagent renderers |
| How they talk | `WMApp.rankOrder.init({ readWindow, writeWindow, dropWindow, now, requestTick })` — the four accessors are built once in app.js over its own maps; stateless functions are called as `WMApp.rankOrder.orderedByRank(scope, keys, ctx)`. Tool groups and subagents are stateless: no init, namespace read only |
| Harnesses | `test/tool-group-key.test.js` re-pointed to the module (same marker text, new file); `tools/verify-subagent-turns.mjs` unchanged — the module keeps publishing `globalThis.wtSubagents` |

### S2 — held-turn text and the stream/console row builders

| | |
|---|---|
| Keeps in app.js | `state`, `turnLive`, the `conversationHtml`/`turnBody` call sites, the settings reads |
| Moves | `heldTurn`/`waitNote`/`jobStatusWord`/`jobStatusClass`/`turnStateText`, `fmtTok`/`fmtTokens`, `statsRowHtml`; `toolGroupHtml`, `toolCallArg`, `liveSuffix`, `groupLines`, `lineHtml`, `turnBody`, `questionHead`, `questionPicks`, `questionDrafts`; `resultRowHead`, `shouldPaceResultRow`, `drawRowText`, `typedShown`, `typedText` |
| How they talk | stateless string builders: the caller passes the turn, its lines and the settings it needs — `WMApp.streamRows.toolGroupHtml(burst, { settings, window })`. The regions' `state×25` reads become explicit arguments; the plan lists the slices to pass so no module reaches for `state` |
| Harnesses | `test/result-row-head.test.js`, `test/console-row-text.test.js`, `test/console-typed-line.test.js` — path change only, the `sliceRegion`/`sliceBetween` markers move into the module verbatim |

### S3 — the cell builders and the chart column plan

| | |
|---|---|
| Keeps in app.js | `rowHtml`'s call sites in the board hub, the column-width application (§90/91 stays in `board-panels` for now) |
| Moves | `branchCellHtml`, `aheadBehindCellHtml`, `prCellHtml`, `prMatchNote`; `WT_COLS`, `CHART_COLUMNS`, `COL_MIN`, `COL_GIVE`, `shownColumns`, `columnPlan`, `headerCells`, `colWidths`, `saveColWidths`, `naturalColumnWidths` |
| How they talk | stateless: `WMApp.cellHtml.prCellHtml(row, opts)`; `WMApp.chartColumns.columnPlan(widths)` returns the plan the board applies. No init |
| Harnesses | `test/branch-cell.test.js`, `test/ahead-behind-cell.test.js`, `test/pr-cell-none.test.js`, `test/chart-columns.test.js` — path change; the chart-columns test keeps its HTTP assertions and now also pins the client table against `lib/chart-columns.js` |

### S4 — the age cell and the age-collapse chart

| | |
|---|---|
| Keeps in app.js | `state.rows`/`state.settings`, the `rowHtml` call for the age cell, the chart header's refresh, the sweep that repaints |
| Moves | `ageCellHtml`, `paintAgeCell`, `rowAgeHidden`, `RING_C`, the chart's paint/refresh and its own localStorage key |
| How they talk | `WMApp.ageChart.init({ getRows: () => state.rows, getSettings: () => state.settings, doc: document, pulseRow, pulseProject })` — the two hub pulses it calls are passed as callbacks. Exposes `ageCellHtml(row)`, `rowAgeHidden(row)`, `paintAgeCell(el, row)` |
| Harnesses | `node tools/verify.mjs --only age` (drives the real chart in a browser; its only source reference is a prose comment, so it must still pass); `npm test` |

### S5 — the settings surface, browser-stored half

| | |
|---|---|
| Keeps in app.js | `state.settings`, `applySettings()` (the snapshot merge every module reads), the `#settings` element, the `#btn-settings`/`#title-settings`/`#btn-settings-close` wiring, `showBanner` |
| Moves | `reorderSeconds`, `rankWindowMs`, `ageDaysSentence`; the three Settings>Agent cards/Display toggles; page zoom, fonts, text styles, contrast, add-agent bar, group folds, settings search, the question-box look row, the anchor's two signals |
| How they talk | `WMApp.settingsLocal.init({ $, doc: document, store: { get: () => state.settings, merge: (s) => { state.settings = { ...state.settings, ...s }; paintConfigLine(); } }, renderAll, showBanner })`, called once after the first `applySettings`. Fold/search expose `toggle(open)`, `filter(query)` |
| Harnesses | `test/settings-groups.test.js` (2 regions) path change; `test/stream-default.test.js`'s `sliceBetween` end marker now lives in `settings-rows.js`, so its path changes; `npm test`. **index.html's markup does not move** — 48 static `settings-row` elements stay put; moving them would touch `style.css` and break the assertions that read the panel's folds and ARIA |

### S6 — the settings surface, server-stored half

| | |
|---|---|
| Keeps in app.js | `apiFetch`, `showBanner`, `state.settings`, and the `paintConfigLine`/`refreshRemoteGuards`/`paintPaths`/`paintChartColumns` callbacks |
| Moves | provider endpoint, models prices/ratings, approval window, sessions list, agent cleanup, age threshold, chart columns, remote branch policy, the two folders |
| How they talk | `WMApp.settingsServer.init({ apiFetch, showBanner, getSettings, setSettings, paintConfigLine, refreshRemoteGuards, paintPaths, paintChartColumns })`; each row's save calls the existing route and merges the answer through `setSettings` |
| Harnesses | no page-slice test covers these rows; the route tests that POST `/api/settings/{provider,models,approvals,sessions,cleanup,age,columns,remote-branches}` keep passing because the routes do not move; `npm test` |

### S7 — the assistant float

| | |
|---|---|
| Keeps in app.js | nothing of the float except the init call and the three globals it publishes today (`applyAssistant`, `__assistantRenderChat`, `__assistantToggle`) — replaced by `WMApp.assistant.init({ state, $, esc, conversations, conversationHtml, renderConversation })`, called after the first snapshot |
| Moves | the IIFE's sections, one module each: `frame.js` (the float's two rows, panel frame, drag/resize, keys), `lists.js` (alerts, watches, scratchpad, message board), `role.js` (role and charter), `settings.js` (its settings tab), `server.js` (talking to the server), `boot.js` (restore + `applyAssistant`) |
| How they talk | one init call at boot; the module publishes `applyAssistant(thread)`, `renderChat(thread)`, `toggle(open)`. app.js's SSE/snapshot path calls `WMApp.assistant.applyAssistant(thread)` instead of the bare global |
| Harnesses | `test/assistant-subtabs.test.js` and `test/assistant-thresholds.test.js` slice `public/assistant.js`'s "the float's two rows" — re-pointed to `features/assistant/frame.js`; `test/assistant-resize.test.js`, `test/assistant-profile.test.js` and the assistant route tests still pass; the browser verify scripts drive the same DOM ids |

## 6. The invariant every landing carries

1. **No behaviour change.** The region moves byte for byte — comments, markers, names and whitespace included. The
   only new text is the `init` call in `app.js` and the namespace-qualified call sites. The module keeps the source
   region's marker lines verbatim, so a page-slice test changes its `readSource` path and nothing else.
2. **The existing verification harnesses still pass.** Every test and verify script named in §5's "Harnesses" row is
   re-pointed in the same PR and run: `npm test`, `node tools/verify.mjs --only <area>`, and the pre-push
   `node tools/version.mjs check`.
3. **One step per PR.** One branch, one squash-merged commit, one revertable unit — never two landings in one PR.
4. **A version bump in the commit that carries it.** A behaviour-preserving refactor is a **patch**
   (`docs/versioning.md`), applied with `node tools/version.mjs apply patch`; the level and its reason go in the
   commit body and the PR body. The bump travels with the move so a revert takes both.
5. **No module reaches for a global it did not receive.** The one shared object that remains is `state`, and it is
   passed explicitly at init — named in the call — so the edge is visible and greppable. A classic script is not a
   licence for a bare read.

## 7. What this plan does not schedule

The `R` modules in §3 (13,520 lines) stay in `app.js` for a follow-on plan. Two reasons: `stabilize reordering`
(§92, 2,977 lines) and `end moving nodes…` (§55, 743 lines) are marker-poor — they hold several concerns under one
marker, so their first landing is a **comment-only PR that adds internal markers without moving code**; and the
board modules read the hub's `renderAll`/`placeRow`/`applySnapshot` directly, so they need that sub-marker pass and,
for `board.js`, its own plan. Order within `R`, cheapest first: `naming` → `worktree-actions` → `approvals` →
`model-picker` → `question-box` → `visibility` → `conversation` → `reply-box` → `console-writers` → `agent-card` →
`board-anchor` → `board-panels` → `board-projects` → `board`.

## 8. Landing this document

This PR is a doc: **patch** per `docs/versioning.md`. Rebase onto `origin/main` immediately before landing and take
the next free patch number at that moment — `node tools/version.mjs suggest` prints the floor, and the number is the
first patch not already on `main`; bump in the commit that carries the plan and name the number, the level and the
reason in the commit body and the PR body. Then `git push -u origin HEAD` and `gh pr create --fill`.
