# Splitting `public/app.js` — the panel cut

`public/app.js` is **22,695 lines** in one classic script, loaded by one `<script>` tag at
`public/index.html:822`, and it publishes **no `window.*` name by assignment at all** — every name it
offers the page is a bare top-level declaration, and every name the page offers back is read by bare
name too. That is the fact the whole cut turns on: 874 function declarations become `window`
properties, 266 `const`/`let` declarations become global lexical bindings that a later classic script
can read but `window` cannot show, and **65 of those 1,140 names are read by the other sixteen
scripts on the page**. Keep those 65 resolvable and no HTML has to change.

- Snapshot: **`1e1c595`** (`package.json` `1.4.2`), the tip this page lands on. `public/app.js` is
  **1,198,279 bytes** as checked out (CRLF) and **1,175,584** as the git blob (LF). Every count below
  was taken at that commit with the commands in §8; nothing is carried from an earlier report.
- Companion: [`lanes-and-modules.md`](lanes-and-modules.md) — the module map this page extends. §6.1
  there is the summary of this cut and the lane it creates. The older, costed landing plan is
  [`../split-public-app-plan.md`](../split-public-app-plan.md) (measured at `0.56.1`); where the two
  disagree, §7 says which number is which.
- This is research. It moves nothing under `public/`, changes no server file and adds no test.

**Contents**

1. [The load order, and what it actually guarantees](#1-the-load-order-and-what-it-actually-guarantees)
2. [What `app.js` publishes](#2-what-appjs-publishes)
3. [The DOM each block owns](#3-the-dom-each-block-owns)
4. [The cut, by panel](#4-the-cut-by-panel)
5. [The genuinely shared helpers, and where they live](#5-the-genuinely-shared-helpers-and-where-they-live)
6. [The first extraction that makes the rest parallel](#6-the-first-extraction-that-makes-the-rest-parallel)
7. [What this cut does not decide](#7-what-this-cut-does-not-decide)
8. [Re-measuring this page](#8-re-measuring-this-page)
- [Appendix A — every top-level declaration](#appendix-a--every-top-level-declaration)

---

## 1. The load order, and what it actually guarantees

Seventeen classic scripts and one inline block, in this order. The comment above each tag is the
reason the file sits there, quoted from `index.html`; the phase column is the contract those comments
add up to.

| # | `index.html` | File | Phase | What it must be able to do when it is evaluated |
|---|---|---|---:|---|
| 1 | 782 | `core/dom-format.js` | declare | publishes `$`, `esc`, `keyOf`, `relTime`, `fmtAgo`, `fmtDur`, `elapsed`, `rowTier`, `lifeAt`, `isMainWorktree`, `movementKey`, `orderRows`, `verdictClass`, `linkifyText`, `tailPath`, `fmtBytes` |
| 2 | 785 | `core/model-menu.js` | declare | one model picker; reads `esc` at call time |
| 3 | 786 | `core/console-format.js` | declare | one folded box per tool result; reads `wtType` at call time |
| 4 | 791 | `core/console-markdown.js` | declare | the console's prose as markdown; `test/console-markdown.test.js` imports it |
| 5 | 795 | `core/stream-merge.js` | declare | `wtStream`; `test/single-stream.test.js` imports it |
| 6 | 799 | `core/liveness.js` | declare | `wtLive`; `test/liveness.test.js` imports it |
| 7 | 804 | `core/steerable.js` | declare | `wtSteerable`; `test/steerable.test.js` imports it |
| 8 | 808 | `core/type-stream.js` | declare | `wtType`; `test/type-stream.test.js` imports it |
| 9 | 809 | `board/attachments.js` | declare | pasted documents; registers its paste listener first |
| 10 | 813 | `board/paste-chips.js` | declare | big pastes as inline chips; loads after `attachments.js` because it steps aside for it |
| 11 | 814 | `core/transport.js` | declare | `apiFetch`, `resync`, `post` — the panel token and the deadline |
| 12 | 815 | `core/sse.js` | declare | the page's one `EventSource`; reads app.js names **inside `connect()`**, never at load |
| 13 | 820 | `pipeline-flow.js` | declare | data in, markup out |
| 14 | 821 | `pipeline-modal.js` | declare | the dialog; reads `PipelineFlow` at call time |
| **15** | **822** | **`app.js`** | **pivot** | **declares 1,140 names, then runs 243 top-level statements** |
| 16 | 825 | `core/update-check.js` | execute | reads `state`, `turnLive` and the banner helpers at call time |
| 17 | 828 | `assistant.js` | execute | reads app.js's state and card renderer; publishes five `window.__*` functions app.js calls back |
| — | 839 | inline (`<script>`) | execute | the Gateway tab's Element block: `apiFetch` only, then its own 5 s poll |

Two facts the table does not show, both measured in a real browser on a fixture of two classic scripts
(the probe is in §8):

- **A top-level `function` declaration in a classic script is a property of `window`; a top-level
  `const`/`let` is not.** `typeof window.FN === "function"`, `typeof window.LEX === "undefined"` — yet
  a later script reading `LEX` gets the value, because every classic script on a page shares the
  global lexical environment. So the publish surface is two different things, and a cut that moves a
  `const` to another file keeps it readable everywhere; a cut that moves a `function` keeps it on
  `window` too.
- **A second top-level `const` with the same name, in another classic script, is a `SyntaxError` that
  kills that script alone.** In the probe, the fixture's fourth script declared `const LEX` again: it
  never ran (`window.__probe.s4` was never set, `LEX` kept the first script's value), and the scripts
  after it ran normally. That is the silent failure mode a moved block walks into — the page still
  loads, one file is simply dead, and nothing in the UI says so. **No block may carry a `const`/`let`
  whose name stays behind.**

`app.js`'s own 243 top-level statements (2,570 code lines, 15% of the file's code) are the load-time
spine: listeners, timers, late `state.x = state.x || …` fields and the boot IIFE at 22,664. They are
why the phase-1 rule exists — a file loaded before `app.js` may declare, not execute.

---

## 2. What `app.js` publishes

**Measured: zero writes to `window`.** `grep -n 'window\.' public/app.js` returns 110 lines and every
one is a read or a browser API (`window.scrollY`, `window.innerHeight`, `window.getSelection`,
`window.prompt`, `addEventListener`), plus one read of a module namespace at 7,584
(`window.WMApp?.core?.consoleFormat?.setShownFor?.(typedShown)`). There is no `window.X = …` line in
the file.

What it publishes instead:

| Shape | Count | On `window`? | Read by a later script by bare name? |
|---|---:|---|---|
| `function name(...)` | 786 | **yes** | yes |
| `async function name(...)` | 88 | **yes** | yes |
| `const name = …` | 196 | no | yes (global lexical environment) |
| `let name = …` | 70 | no | yes |
| **total** | **1,140** | 874 | 1,140 |

Appendix A lists all 1,140 with their line numbers. The map's older count of "1,052 top-level names"
counted only the 786 `^function` lines and missed the 88 `async function` declarations; the number for
this tree is **1,140**.

### 2.1 The 65 names the page reads back

These are the names that must stay resolvable by bare name or `window`, or the sixteen other scripts
break. The count per reader is the number of app.js names that file references.

| Reader | n | Names (app.js line) |
|---|---:|---|
| `assistant.js` | 36 | `state`@55, `toggleProject`@542, `normPath`@622, `rootOf`@641, `toggleRoot`@662, `conversations`@1530, `turnKey`@3270, `toggleTurn`@3281, `conversationHtml`@4572, `restoreReplyDraft`@4859, `captureTyping`@4876, `restoreTyping`@4939, `restoreThinkBodies`@8665, `settleScrolls`@8670, `captureScrolls`@8703, `restoreScrolls`@8717, `applyStoredScrolls`@8757, `updateJob`@9035, `conversationSignature`@9084, `captureCardSelection`@9229, `restoreCardSelection`@9250, `paintCardMeta`@9280, `renderConversation`@9303, `programmaticScroll`@9418, `modelsState`@9726, `modelOptionHtml`@9734, `revealCard`@9853, `jumpToAgent`@10085, `rowHtml`@11306, `chartHeaderHtml`@13977, `reorder`@14403, `showBanner`@15222, `showNote`@15300, `selectSettingsTab`@18998, `toggleSettings`@20598, `fmtBytes`@22198 |
| `core/sse.js` | 22 | `state`@55, `captureTyping`@4876, `restoreAddAgent`@5002, `beginDomMove`@6220, `endDomMove`@6223, `renderApprovals`@6810, `scheduleRenderJobs`@8901, `updateJob`@9035, `renderConversation`@9303, `appendJobLine`@9434, `repaintAgentState`@10386, `noteEventLife`@12122, `flashProjectMs`@12367, `reorderProjects`@13528, `projectSection`@13802, `refreshChips`@13835, `queueRow`@14536, `removeRow`@14731, `renderProjectRows`@14755, `renderAll`@14907, `applySnapshot`@15012, `applySettings`@22316 |
| `core/update-check.js` | 5 | `state`@55, `questionDrafts`@3026, `turnLive`@10277, `showBanner`@15222, `showNote`@15300 |
| `core/dom-format.js` | 4 | `state`@55, `normPath`@622, `panelFor`@10334, `isRowLive`@10338 |
| `board/paste-chips.js` | 4 | `state`@55, `REPLY_MAX_LINES`@4902, `SPAWN_MAX_LINES`@4903, `growBoxToDraft`@4905 |
| `core/transport.js` | 3 | `state`@55, `applySnapshot`@15012, `showBanner`@15222 |
| `board/attachments.js` | 2 | `state`@55, `fmtBytes`@22198 |
| `pipeline-flow.js` | 2 | `state`@55, `pointAt`@9210 |
| `pipeline-modal.js` | 2 | `state`@55, `watchMotion`@8431 |
| `core/console-format.js` | 1 | `fullForFold`@1929 |
| `core/model-menu.js` | 1 | `fmtTokens`@3665 |

`index.html`'s inline block reads no app.js name at all — only `apiFetch`, which is
`core/transport.js`'s. These 65 are the whole HTML-facing contract; 44 of them are also read across the
ten proposed files in §4, which is why that table's "publishes to the page" column and this one overlap
but do not match.

### 2.2 What `app.js` reads back from the page

Four functions published by `assistant.js`, called at five sites — `applyAssistant` by bare name, the
rest through `window`:

| Name | Read at | What it does |
|---|---|---|
| `applyAssistant` | 6,281, 15,075 | applies the assistant payload after a snapshot or an SSE frame |
| `window.__assistantRenderChat` | 9,311 | repaints the assistant's thread after a card action |
| `window.__assistantShowThread` | 17,782, 18,487 | opens the float on a thread; the HUMAN rotation and the deliverables list both use it |
| `window.__openTaskPipelineWindow` | 20,411 | opens a task's pipeline window from the Pipeline tab |

A cut that moves `renderConversation` or the deliverables list must keep those four calls shape-for-
shape: three of them are `typeof … === "function"` guards, so a typo does not throw, it silently
disables the press. `__assistantToggle`, the fifth name `assistant.js` publishes, is called by nothing
on the page — three harnesses reach it through `page.evaluate`.

### 2.3 The names read most *inside* the file

Inbound references, measured over the 1,140 declarations (a unit that names the name counts once):

| Name | Inbound | Name | Inbound |
|---|---:|---|---:|
| `state` | 316 | `renderJobs` | 11 |
| `showBanner` | 55 | `agentsFor` | 11 |
| `turnLive` | 31 | `CHART_COLUMNS` | 11 |
| `renderConversation` | 27 | `assistantSessionFor` | 10 |
| `normPath` | 20 | `programmaticScroll` | 10 |
| `conversations` | 19 | `pipelineDraft` | 10 |
| `setScroll` | 15 | `pipelineDraftDirty` | 10 |
| `turnKey` | 14 | `renderProjectRows` | 9 |
| `refreshAnchorBaseline` | 13 | `rootOf` | 9 |
| `deliver` | 13 | `TOOL_DONE_RE` | 12 |

`state` is read by 316 of the 1,140 declarations — every panel, and nine of the sixteen other scripts.

---

## 3. The DOM each block owns

`app.js` does not hold element references: it builds markup as strings and assigns `innerHTML`, then
finds what it needs later. Measured: **49 `document.getElementById` calls**, the rest through
`dom-format.js`'s `$` (a one-line `getElementById`), and the per-card caches live in `state`
(`rowEls`, `detailEls`, `tbodyEls`, `confirmEls`). So "owns" here means: **the ids a block looks up or
creates, and the classes its own markup strings carry**.

- **160 ids** are referenced by `app.js`; **143** of them are declared in `index.html`; **17** are
  created by `app.js` itself — the deliverables pop (`deliver-pop`, `dl-list`, `dl-count`, `dl-filter`,
  `dl-foot`), the scratch-clean buttons (`btn-clean-cancel`, `btn-clean-go`), and the ten pipeline
  editor/finding nodes (`pipeline-add-stage`, `pipeline-description`, `pipeline-editor-close`,
  `pipeline-findings`, `pipeline-kind`, `pipeline-next`, `pipeline-reload`, `pipeline-save`,
  `pipeline-status`, `pipeline-title`).
- **505 distinct classes** appear in `app.js`'s markup strings and `classList` calls. Of those, **426**
  are named by exactly one of the ten proposed files below — the per-block column is that count, so a
  class in it is a class no other panel's markup carries.
- `index.html` declares **269 ids**; **126** are never read by `app.js` (they belong to
  `assistant.js`'s `as-*` block, to `core/` scripts, or are labels a settings row paints itself).

| Proposed file | ids it reads or creates | classes exclusive to it |
|---|---:|---:|
| `board/board.js` | 14 — `banner`, `banner-layer`, `banner-preview`, `banner-seconds`, `banner-text`, `btn-collapse-all`, `chip-bin`, `chip-key`, `config-line`, `health`, `job-reasoning`, `projects`, `skipped-note`, `stabilize-reorder` | 42 |
| `board/rows.js` | 3 — `jobs`, `projects`, `refresh-agent` | 107 |
| `board/cards.js` | 11 — `approvals`, `approval-chips`, `approval-head`, `approval-list`, `btn-dock-approvals`, `prev-turn-mode`, `q-compact`, `q-size`, `q-typed`, `q-width`, `spawn-msg` | 139 |
| `board/jobs.js` | 18 — `agents-chips`, `btn-fold-jobs`, `btn-spawn`, `job-budget`, `job-create`, `job-cwd`, `job-landing`, `job-maxTurns`, `job-model`, `job-project`, `job-prompt`, `job-reasoning`, `jobs`, `newagent`, `project-paths`, `spawn-msg`, `spawn-note`, `spawn-warn` | 7 |
| `board/console.js` | 3 — `stream-lines`, `stream-preview`, `stream-words` | 44 |
| `board/charts.js` | 2 — `colors-row`, `projects` | 14 |
| `board/deliverables.js` | 6 — `btn-deliver`, `deliver-pop`, `dl-count`, `dl-filter`, `dl-foot`, `dl-list` | 18 |
| `board/settings.js` | 84 — every `settings-*` control on the eleven tabs (the `settings-*` and `skills-*` blocks of `style.css`) | 38 |
| `board/pipeline.js` | 22 — `pipeline-*`, `bundle-*`, `settings-search` (shared with settings' search) | 14 |
| `board/human.js` | 4 — `approvals`, `btn-human`, `human-badge`, `human-label` | 3 |

Five ids are claimed by two files because both read them: `projects` (board renders it, charts
measures it), `jobs` (rows and jobs), `approvals` (cards and human), `spawn-msg` (cards and jobs), and
`settings-search` (settings paints it, pipeline's search box is the same node). They are reads, not
owners: the shell keeps the node, the panel reads it.

**The classes are the stronger ownership signal.** 426 of 505 are single-owner; the 79 that are not
are the shared vocabulary (`is-open`, `is-quiet`, `good`, `bad`, `mono`, `meta`, …) that any panel may
add to its own element. A cut that moves markup must move its classes' *rules* with it or declare
`public/style.css`, which is why §6 of the map still names the stylesheet as the lane.

---

## 4. The cut, by panel

Ten files: the seven the brief names, plus the three the residue needs (the shell, the row table, the
HUMAN rotation). Units and lines are the declarations whose bodies move; **the load-time wiring that
goes with them is separate** — 2,570 code lines in 243 top-level statements, of which 1,770 sit in the
shell's one listener block (15,499–17,498) and the rest are the settings rows and the console's
wheel/zoom handlers. A panel's wiring is contiguous and belongs to it; a first landing may leave all
wiring in `app.js` and move only the declarations, because a listener that calls a name by bare name
does not care which file declares it.

| File | Owns (sections, by their `// ----` marker) | Units | Lines | Publishes to the page | Publishes to the cut |
|---|---|---:|---:|---:|---:|
| `board/board.js` | keys + `state`@9–314, the boot IIFE@22,664, `renderAll`/`applySnapshot`/`placeRow`/`reorder`@14,333–15,154, folders/projects/collapse@559–1,357, clone@1,157, live pulse@1,430, banner@15,155–15,329, board hygiene@12,645, ordering@13,416, hosts chip@13,676, split width and column drag@14,121–14,332, visibility@22,608 | 222 | 3,065 | 13 | 56 |
| `board/rows.js` | worktrees@9,981–10,439, remove@10,440, lock@10,604, rename@10,662, child tree@10,712, merge control + chooser@10,763–11,121, the six cells@11,122–11,434, age column@11,397, TODO + detail + chips@12,874–13,415 | 98 | 1,856 | 6 | 22 |
| `board/cards.js` | conversations/turns@1,521–2,224, turn body@2,739, clarify@3,017, question box + turn rendering + artifacts + stats@3,040–3,824, model picker + context@3,825–4,058, subagents@4,059–4,550, `conversationHtml` + reply draft@4,551–4,895, box growth@4,896, send/steer@6,213, previous turn@6,396, approvals dock@6,628–7,195, `updateJob`/`renderConversation`@9,035–9,433, retry/spawn messages@9,602–9,648 | 188 | 3,218 | 15 | 26 |
| `board/jobs.js` | add-agent bar + naming + prompt history@5,739–6,130, spawn form + model picker@9,649–9,980, `renderJobs`/`paintAgentBadges`@8,887–9,034 | 47 | 740 | 3 | 18 |
| `board/console.js` | tool-burst bookkeeping@1,521–2,360, tool call as a row@2,361–2,738, sub-console@4,076–4,493, reasoning pacing@7,389–7,585, console row text + markdown + raw@7,586–7,859, console writers@7,820–8,360, copy + motion@8,361–8,577, reader input/scroll@8,578–8,813, `appendJobLine`/`drawJobLine`@9,434–9,600 | 166 | 2,263 | 6 | 30 |
| `board/charts.js` | top-N@11,434–11,734, sliding average@11,735, ranked sequence@11,826, contexts@11,907, seeding@11,974, ticks@12,028, reading anchor@12,152–12,644, chart columns + fit + drag@13,868–14,332 | 131 | 1,277 | 1 | 41 |
| `board/deliverables.js` | the DELIVERABLES button and list@18,015–18,538 | 20 | 411 | 0 | 0 |
| `board/settings.js` | every settings tab@17,531–17,580 and 18,540–22,607 except the Pipeline and Bundles tabs, plus the Agent-cards/Display value rows@7,196–7,388: display, cards, board, branches, data, gateway, skills, permissions, providers, restarts, matrix | 210 | 2,558 | 0 | 13 |
| `board/pipeline.js` | pipeline chip@4,551–4,569, Settings > Pipeline@19,725–20,154, Settings > Bundles@20,155–20,421 | 43 | 602 | 0 | 8 |
| `board/human.js` | HUMAN's landing helpers@17,581, the rotation@17,632–18,014 | 15 | 315 | 0 | 5 |
| **total** | | **1,140** | **16,305** | **44** | — |

**The `window` names each file must keep so no HTML changes.** The left column is the names on page
§2.1's list; the right column is the additional names the other nine files read (the cut's internal
contract, spelled out in §4.1). Keep both and no `<script>` order changes, no `onclick=` appears, and
`assistant.js`/`sse.js`/`update-check.js` keep working untouched.

| File | Must stay resolvable for the page | Also read by another new file |
|---|---|---|
| `board/board.js` | `state`, `showBanner`, `normPath`, `showNote`, `toggleProject`, `rootOf`, `reorderProjects`, `reorder`, `refreshChips`, `renderProjectRows`, `renderAll`, `toggleRoot`, `removeRow` | `assistantSessionFor`, `jobLines`, `placeRow`, `saveCollapsedRoots`, `applyRootCollapse`, `focusReplyBox`, `queuedEditFor`, `scrollThreadToBottom`, `rememberReply`, `childrenOut`, `threadBusy`, `drainReplyQueue`, `projectNode`, `pruneOutHeights`, `saveCollapsedFixed`, `applyFixedCollapse`, `saveShowOldProjects`, `projectOfTree`, `paintCollapseAll`, `setMaximized`, `turnStateText`, `livePulseHtml`, `jobPreviewHtml`, `refreshJobPreview`, `turnPrompts`, `queueReply`, `ghostTurnHtml`, `captureBoardAnchor`, `scheduleBoardSweep`, `gitSubHtml`, `descLines`, `projectRanks`, `boardGroups`, `stabilizeOn`, `rowHasOpenCard`, `orderedAgents`, `paintConfigLine`, `placeBanner`, `startReorderClock`, and 17 key/const names (`SPAWN_HISTORY_KEY`, `SPAWN_HISTORY_MAX`, `PROJECT_HUE_KEY`, `ANCHOR_THREAD_KEY`, `FLASH_TIME_KEY`, `FLASH_TIME_DEFAULT`, `TREENAMES_KEY`, `RANK_WINDOW_KEY`, `RANK_WINDOW_DEFAULT`, `RANK_WINDOW_MIN`, `RANK_WINDOW_MAX`, `RANK_EVENT_CAP`, `RANK_MARGIN_PER_MIN`, `COLLAPSE_CASCADE_DEFAULT_SECONDS`, `REORDER_KEY`, `REORDER_MAX`, `reorderSeconds`) |
| `board/rows.js` | `turnLive`, `panelFor`, `isRowLive`, `repaintAgentState`, `rowHtml`, `jumpToAgent` | `invalidatePanelMap`, `revealSpawnedAgent`, `agentsFor`, `approvalLive`, `lifeAtFor`, `agentsByPath`, `isHomelessConv`, `RING_C`, `noteScan`, `eventLifeAt`, `detailHtml`, `chipsHtml`, `paintRefreshAgent`, `paintRefreshOffer`, `paintRefreshOffers`, `clearRefreshOffer`, `threadRowKeyCache`, `convLive`, `agentsRunning`, `homelessConversations`, `sigChips`, `agentBadgeHtml` |
| `board/cards.js` | `renderConversation`, `conversations`, `turnKey`, `captureTyping`, `restoreTyping`, `beginDomMove`, `endDomMove`, `captureCardSelection`, `restoreCardSelection`, `restoreAddAgent`, `updateJob`, `conversationHtml`, `conversationSignature`, `restoreReplyDraft`, `renderApprovals` | `saveCollapsedJobs`, `loadCollapsedJobs`, `applyPendingFocus`, `paintSubagents`, `sendReply`, `steerTurn`, `TURNS_PER_PAGE`, `growReplyBox`, `turnOrder`, `liveSuffix`, `streamBodyHtml`, `paintQLook`, `applyQLook`, `turnIsOpen`, `refreshTurnPeek`, `baseNameOf`, `fmtTok`, `positionModelPop`, `subagentFallback`, `fmtSeconds`, `turnBounds`, `APPROVALS_FOLDED_KEY`, `applyApprovalsFold`, `approvalAgentName`, `applyRemoteWrites`, `recoverSpawnAfterTimeout` |
| `board/jobs.js` | `modelsState`, `scheduleRenderJobs`, `revealCard` | `renderJobs`, `clearSpawnPrompt`, `loadTreeNames`, `saveTreeNames`, `isProjectRootRow`, `treeTitleOf`, `loadSpawnHistory`, `rememberSpawnPrompt`, `CONTINUE_TEXT`, `addAgentBarHtml`, `queueJobsRefresh`, `paintAgentBadges`, `retryableError`, `lastSpawnAttempt`, `spawnMsgHtml`, `loadModels`, `syncProjectPicker`, `scrollCardUnderBar` |
| `board/console.js` | `programmaticScroll`, `restoreThinkBodies`, `settleScrolls`, `applyStoredScrolls`, `restoreScrolls`, `captureScrolls` | `releaseScrolls`, `holdScrolls`, `setScroll`, `placeInOrder`, `TOOL_DONE_RE`, `inflightToolName`, `isBookkeeping`, `lineHtml`, `toolGroupHtml`, `placedNodes`, `applySubConsoleScrolls`, `holdSubConsoles`, `inflightToolIndex`, `burstGroups`, `windowLines`, `toBottomBtnHtml`, `consoleToolsHtml`, `subConsoleHtml`, `loadSubConsole`, `paceThinkBlock`, `typedShown`, `flushTypeStream`, `loadThinking`, `thinkAutoOpened`, `thinkOpenFor`, `thinkHtml`, `consolePinned`, `pinConsole`, `applyStoredHeight`, `placeBuiltConsoles` |
| `board/charts.js` | `chartHeaderHtml` | `refreshAnchorBaseline`, `CHART_COLUMNS`, `orderedByRank`, `flashRingMs`, `wtColspan`, `rowTopHidden`, `chartDrawOrder`, `projectRankCtx`, `seedRankWindows`, `tickLivenessRanks`, `readingTop`, `anchorMuteUntil`, `scheduleColumnFit`, `CHART_TOP_DEFAULT`, `chartTopLimit`, `chartTopOrder`, `chartTopSplit`, `refreshTopToggle`, `ageCellHtml`, `rowKeyForThread`, `pulseProject`, `folderRankCtx`, `agentRankCtx`, `seedProjectRank`, `loadProjectHues`, `headTitle`, `loadAnchorFlag`, `loadAnchorSeconds`, `loadRankSeconds`, `loadAnchorThread`, `setAnchorThread`, `loadFlashSeconds`, `flashRowMs`, `applyFlashTime`, `anchorNodeFor`, `readingAnchor`, `ownerMatters`, `OWNER_COLUMN_ID`, `shownColumns`, `fitColumns`, `fitAllColumns` |
| `board/deliverables.js` | — | — |
| `board/settings.js` | — | `streamOn`, `thinkingOn`, `toolGroupsOn`, `foldFollowsConsole`, `settingsRowText`, `paintSettingsRows`, `paintSettingsSearch`, `SETTINGS_SEARCH_ID`, `TYPE_WORDS_KEY`, `TYPE_LINES_KEY`, `typeWordSpeed`, `typeLineRate`, `paintPaths` |
| `board/pipeline.js` | — | `pipelineChipHtml`, `loadPipelines`, `loadBundles`, `initBundlesPanel`, `paintPipelineSearch`, `paintBundlesSearch`, `pipelinesLoadedAt`, `bundlesLoadedAt` |
| `board/human.js` | — | `paintHumanButton`, `hotOpenPath`, `hotRowFor`, `flashHotCard`, `humanRefocus` |

`deliverables.js` publishes nothing and reads only the shell and four cards/human names — it is the
one panel that can be cut and landed with no counterpart.

### 4.1 Why the seam is where it is

Every file above is a *closure*: the units inside it reference each other more than they reference any
one other file, and the cross-file references that remain are the names in the table. Measured
outbound counts, in the order they matter:

| File | Its refs point at |
|---|---|
| `board.js` | cards 80, charts 39, console 30, rows 24, jobs 10 |
| `rows.js` | board 69, charts 15, cards 13, jobs 6, console 3 |
| `cards.js` | board 100, console 36, rows 21, jobs 14, settings 10, charts 4 |
| `jobs.js` | board 44, cards 15, rows 9, console 6 |
| `console.js` | board 61, cards 12, settings 12, rows 7 |
| `charts.js` | board 69, rows 12, console 4, cards 3 |
| `settings.js` | board 64, charts 10, pipeline 9, cards 7 |
| `pipeline.js` | settings 7 |
| `human.js` | board 18, cards 9, rows 4 |
| `deliverables.js` | board 6, human 4, cards 3, jobs 2 |

The shell is the hub — **511 of the 880 cross-file references** point at `board.js`, which is expected:
it declares `state`, the banner, `normPath` and the render engine. The two files that read *each other*
hardest are `cards` and `console` — 13 alternations between their contiguous runs, the only two-digit
pair in the file (§6).

---

## 5. The genuinely shared helpers, and where they live

The names below are read by three or more files, and one of them is declared twice.

### 5.1 `fmtBytes` — declared twice, and the page silently picks one

| Copy | Line | Body | Output for 0 | Output for 1,536 |
|---|---|---|---:|---|
| `public/app.js` | **22,198** (12 lines) | B/KB/MB/GB/TB, one decimal above KB, `"0 B"` at zero | `0 B` | `1.5 KB` |
| `public/core/dom-format.js` | **171** (4 lines) | MB with one decimal, else KB with none, minimum `1 KB` | `1 KB` | `2 KB` |

Both are top-level `function` declarations in classic scripts, so **app.js's copy replaces the
module's** — measured in the browser probe: two scripts declaring the same function name, the second
one's body is what the page calls. `assistant.js:1568` and `board/attachments.js:72` call the bare
name, so they get app.js's; nothing calls `WMApp.core.domFormat.fmtBytes` (measured: zero call sites),
so the module's copy is dead code that still publishes a different answer for the same fact.

The brief's line (`app.js:17964`) is the older snapshot; at `1e1c595` it is **22,198**. `../split-public-app-plan.md`
found the same defect at `0.56.1` and held it for its S6.

**Where it should live:** one copy in `public/core/dom-format.js`, replacing the four-line body with
app.js's twelve-line body — that is behaviour-preserving for the page (app.js's copy is the one in
force today, for both of its callers and for the shell's own folder-size rows at 22,224 and 22,252),
and it removes the only duplicate declaration in the tree. Delete `app.js:22,198` in the same commit;
two `function` declarations of one name is exactly the hazard §1's probe documents.

### 5.2 The other cross-file names

| Name(s) | Readers | Where it belongs | Why |
|---|---|---|---|
| `state` | 16 scripts, all 10 files | `board/board.js`, declared first | one object, one declaration; a per-panel copy of `state` would be a new global per panel |
| `showBanner`, `showNote` (and `hideBanner`/`placeBanner` with them) | `assistant.js`, `transport.js`, `update-check.js`, 7 panels | `board/board.js` (DOM) | they own `#banner` and its timer; a pure helper cannot take the node |
| `normPath` | `assistant.js`, `dom-format.js`, 5 files | **`core/dom-format.js`** | one-line pure value→value; it is already the file's neighbours' home |
| `esc`, `$`, `relTime`, `fmtAgo`, `keyOf`, `tailPath`, `verdictClass` | already in `core/dom-format.js` | stay | 323 bare `esc()` calls from `assistant.js` alone, 633 from `app.js` |
| `assistantSessionFor` | 5 files | `board/board.js` | reads `state.assistant`; a pure reader of a passed board, but every caller passes the page's |
| `renderAll`, `applySnapshot`, `renderProjectRows`, `placeRow`, `removeRow`, `reorder` | the shell + every panel | `board/board.js` | the render engine; moving it is the shell split, not a panel split |
| `turnLive`, `panelFor`, `isRowLive` | `dom-format.js`, `update-check.js`, 5 files | `board/rows.js` | the row predicate set |
| `programmaticScroll`, `captureScrolls`, `restoreScrolls`, `settleScrolls` | 6 files | `board/console.js` | they own the scroll capture, which is the console's |

The rule that falls out: **value→value goes to `core/`, anything that reads the page's `state` or a
node stays in the panel that owns it.** `normPath` and `fmtBytes` are the two pure names still in
`app.js`; the rest of the pure vocabulary has already been cut (`dom-format`, `console-format`,
`console-markdown`, `stream-merge`, `liveness`, `steerable`, `type-stream`, `model-menu`, `transport`,
`sse`).

---

## 6. The first extraction that makes the rest parallel

**The console.** `public/board/console.js` — 166 units, 2,263 lines, two sections a test already
slices.

The measure: for each pair of proposed files, take their contiguous runs in line order and count how
often the sequence flips from one file to the other. A pair that never alternates can be cut in any
order; a pair that alternates N times will produce N conflicting hunks if the two cuts are made from
the same base.

| Pair | Alternations | Flips at (line) |
|---|---:|---|
| **cards / console** | **13** | 1,566, 1,607, 1,633, 2,748, 4,076, 4,088, 4,450, 4,500, 7,402, 9,035, 9,415, 9,602, 15,440 |
| board / cards | 6 | 340, 370, 1,527, 5,277, 6,219, 12,653 |
| board / console | 6 | 1,566, 5,277, 7,402, 12,653, 15,440, 17,499 |
| board / rows | 6 | 5,101, 5,277, 9,984, 12,653, 12,883, 13,419 |
| console / jobs | 6 | 5,744, 7,402, 8,887, 9,415, 9,654, 15,440 |
| cards / jobs | 5 | 5,744, 6,219, 8,887, 9,035, 9,654 |
| every other pair | ≤ 4 | — |

Thirteen is the outlier, and it is structural: the turn's own model (`conversations`, `turnOrder`,
`turnSeqOf`, `tickLiveClocks`) sits inside the tool-burst bookkeeping (`burstGroups`, `groupLines`,
`ensureToolStore`, `expandToolFold`) — one section, two panels. **Until one of the two moves, cards and
console cannot be cut in parallel**, and they are the two largest panels after settings. Every other
pair is ≤ 6, and those six are the shell's own blocks (the state preamble, the render engine, the
banner), which the shell cut takes whole.

Why the console and not the cards:

1. **It is the provider.** 30 of the 36 names cards reads from outside itself come from the console
   (`lineHtml`, `toolGroupHtml`, `burstGroups`, `thinkHtml`, `paceThinkBlock`, …). Cut the console and
   the cards file is left with 106 outbound names instead of 136 — and the console is the only file
   whose absence would otherwise be a re-cut of cards.
2. **Its own state fields are already declared in its own region.** The five late fields it adds at
   load (`state.collecting`@4,224, `state.openSubConsole`/`collapsedSubs`/`subConsoles`@4,440–4,448,
   `state.thinkCache`…@7,201–7,206, `state.typePacer`/`typeGate`@7,373–7,376, `state.outPinned`@8,577)
   are top-level statements beside its own functions, not lines in the `state` literal. Moving the
   console moves them with it, and nothing else has to change shape.
3. **The proofs already read it out of the file.** `test/console-row-text.test.js` slices the
   `console row text` marker; `test/console-typed-line.test.js` slices the block between
   `// ---- end result row head` and that marker; and four more read console helpers by function name
   (`reasoningWants`, `flushTypeStream`, `recordJobLine`, `appendJobLine`, `paintStreamSpeed`).
   `test/console-markdown.test.js` already imports a console *module* file — the shape this cut
   repeats. The older plan's S2 (`core/console-rows.js`, 945 lines) is the same move at a smaller
   radius.
4. **It is a contiguous delete.** Its 142 runs cluster in two blocks (1,566–2,359 and 7,389–9,648)
   plus the sub-console block at 4,076–4,493; there is no piece of it inside another panel's run.

### 6.1 Why not the state block first

The tempting first move is `state` (316 inbound, read by every file). It is the *worst* first move:
its literal calls **19 loader functions** that live in three panels — `loadCollapsedJobs`@340,
`loadOutHeights`@370, `loadOpenDescs`@424, `loadOpenTodos`@443, `loadOpenTodoFacts`@465,
`loadExpandedProjects`@483, `loadCollapsedFixed`@502, `loadCollapsedRoots`@563, `loadRecentRoots`@581,
`loadShowOldProjects`@606, `collapseAfterSeconds`@702 (board), `loadTreeNames`@5,744,
`loadSpawnHistory`@5,787 (jobs), and the six in charts — `loadProjectHues`@12,158,
`loadAnchorFlag`@12,226, `loadAnchorSeconds`@12,243, `loadRankSeconds`@12,254,
`loadAnchorThread`@12,266, `loadFlashSeconds`@12,341.

Moving `state` means moving all 19 — 19 hunks in three panels' regions — before any panel has moved. It
is the one cut that collides with all the others, so it belongs after them, not before.

A smaller, honest companion to the console exists: **`normPath` and `fmtBytes` into `core/dom-format.js`**
(§5). It is a two-name move, it removes the duplicate declaration, and it ships with the console if
you want the first PR to leave the vocabulary clean. It does not affect the parallelism measure.

### 6.2 What the first extraction buys, precisely

After `console.js` lands, the remaining nine cuts have a worst-case alternation of 6, and those six
belong to the shell — which means the second wave (rows, cards, jobs, charts, deliverables, settings,
pipeline, human) can be authored against *different* base commits without touching the same lines,
provided each keeps the names in §4's table resolvable. What still serialises them is not `app.js`:

- `public/index.html` — one `<script>` line per new file, all in the same 782–828 block. Two cuts both
  add a line there; git merges them only if they are not adjacent, so the second wave should agree on
  a fixed insertion order and add its line at its own phase boundary.
- `package.json` — the version gate. Every landing bumps it (the map's §3.1), so the *landings* stay
  one at a time even when the *authoring* is parallel. This cut does not change that, and no code move
  can.

---

## 7. What this cut does not decide

- **The `// ----` markers are a test API, not decoration.** 25 test files slice `public/app.js` with
  `sliceRegion`/`sliceBetween`, and 43 of the 168 test files name the path. A moved section must carry
  its marker text verbatim, or the slice returns `""` and the test fails with a confusing assertion.
  §4's file map keeps every marker inside exactly one file, which is what makes the move mechanical.
- **The older plan and this one answer different questions.** `../split-public-app-plan.md` orders
  landings by *blast radius* and puts ranking maths first (S1, 713 lines, no DOM). This page orders by
  *parallelism* and puts the console first. Both can be true: S1 is the cheapest first PR, the console
  is the one that unblocks the rest. A panel that wants one answer should take S1 as the first landing
  and the console as the second, or take the console as the first and fold S1's three files into it.
- **`assistant.js` is not in this cut.** It is 4,666 lines and reads 36 app.js names; its own split is
  the older plan's S7. Nothing here changes its reads.
- **The assistant's five published names stay.** `app.js` calls four of them (§2.2); the fifth,
  `__assistantToggle`, is reached by `tools/verify-assistant-dock.mjs`, `verify-human-button.mjs` and
  `verify-leftover-holder.mjs` through `page.evaluate`. Moving a press handler must keep the names.
- **No HTML change is required, and that is a measured claim, not a hope.** `index.html` has zero
  inline event handlers (measured: no `onclick`/`onchange`/`onsubmit` attribute anywhere) and its one
  inline script reads `apiFetch` only. The page finds every control through `addEventListener` in
  `app.js`, so a function that moves and keeps its name is invisible to the shell.
- **The measurements are line-numbered at one commit.** Every line in this page moves with the next
  landing; re-locate a block by its `// ----` marker and its function name, never by the number.

---

## 8. Re-measuring this page

Read-only, native `C:/…` paths, run at the commit in the masthead.

```sh
cd C:/ProjectDevelopment/agent-worktree-gui/.worktrees/split-research-2-public-aa78b1

# size, and the two byte counts
wc -l public/app.js && wc -c public/app.js && git cat-file -s HEAD:public/app.js

# the declaration census
grep -c '^function ' public/app.js                       # 786
grep -c '^async function ' public/app.js                 # 88
grep -c '^const ' public/app.js                          # 196
grep -c '^let ' public/app.js                            # 70
grep -c '^// ----' public/app.js                         # 148 (120 open, 28 end)
grep -c '^window\.[A-Za-z_$]*[[:space:]]*=' public/app.js  # 0

# the load order, and the inline block
grep -n '<script' public/index.html

# the cross-file reads (65): take every top-level name, then match it whole-word in each reader
# after stripping comments and strings; a name counts once per reader
grep -oE '^(async )?function [A-Za-z_$][A-Za-z0-9_$]*|^const [A-Za-z_$][A-Za-z0-9_$]*|^let [A-Za-z_$][A-Za-z0-9_$]*' public/app.js \
  | awk '{print $NF}' | sort -u > "$TMPDIR/app-names.txt"
wc -l < "$TMPDIR/app-names.txt"                          # 1,140
# then, per reader file, the equivalent of a whole-word grep for every name in that list

# the duplicate
grep -n 'function fmtBytes' public/app.js public/core/dom-format.js
sed -n '22198,22210p' public/app.js
sed -n '171,175p' public/core/dom-format.js

# the ids and classes
grep -c 'getElementById' public/app.js                   # 49
grep -o 'id="[^"]*"' public/index.html | sort -u | wc -l # 269
```

The browser probe behind §1 and §5.1 is two classic scripts in one page:

```html
<script>
  const LEX = "lexical-value";
  function FN() { return "fn-ok"; }
  function fmtBytes(n) { return "early:" + n; }
</script>
<script>
  window.__probe = {
    fnOnWindow: typeof window.FN,          // "function"
    lexOnWindow: typeof window.LEX,        // "undefined"
    lexReadable: LEX,                      // "lexical-value"
    fmtBefore: fmtBytes(1024),             // "early:1024"
  };
</script>
<script>function fmtBytes(n) { return "late:" + n; }</script>
<script>window.__probe.fmtAfter = fmtBytes(1024); /* "late:1024" */</script>
<script>const LEX = "second";</script>   <!-- SyntaxError: this script alone dies -->
<script>window.__probe.afterBadConst = "still running";</script>
```

Measured output: `{"fnOnWindow":"function","lexOnWindow":"undefined","lexReadable":"lexical-value","fmtBefore":"early:1024","fmtAfter":"late:1024","afterBadConst":"still running"}`,
and the `const LEX` script never set its variable. That is the whole load contract in six lines.

---


## Appendix A — every top-level declaration

Every declaration in `public/app.js`, in line order, four to a row. `name@line`. §2 is the count and
the rule; this is the list.

### A.1 the 874 on `window`

Top-level `function` and `async function` declarations. In a classic script each one is a property of
`window` under its own name.

```
assistantSessionFor@322           jobLines@333                      loadCollapsedJobs@340             saveCollapsedJobs@348
loadOutHeights@370                saveOutHeights@384                rememberOutHeight@394             pruneOutHeights@404
loadOpenDescs@424                 saveOpenDescs@432                 loadOpenTodos@443                 saveOpenTodos@451
loadOpenTodoFacts@465             saveOpenTodoFacts@473             loadExpandedProjects@483          saveExpandedProjects@491
loadCollapsedFixed@502            saveCollapsedFixed@510            applyFixedCollapse@518            toggleFixed@531
toggleProject@542                 loadCollapsedRoots@563            saveCollapsedRoots@571            loadRecentRoots@581
saveRecentRoots@589               loadShowOldProjects@606           saveShowOldProjects@614           projectOfTree@631
rootOf@641                        labelRoot@656                     toggleRoot@662                    applyRootCollapse@672
collapseAfterSeconds@702          cardOwnerPath@711                 cardsUnderParent@718              cascadeCollapse@747
scheduleCollapseCascade@760       clearCollapseCascade@774          clearEveryCollapseCascade@784     rootFilterValue@794
applyRootFilter@798               setRootFilter@825                 paintRootButton@836               toggleAllInRoot@846
renderRoot@865                    toggleRootRecent@897              boardRoots@908                    keepInPlace@920
anythingOpen@945                  paintCollapseAll@955              setEverythingOpen@972             toggleEverything@1011
boardRootsOf@1026                 cardThreadsOf@1035                latestTurnOf@1045                 tierHasOpen@1057
nextCollapseTier@1081             collapseOneTier@1088              showCloneForm@1160                setCloneStatus@1172
cloneIntoRoot@1181                newProjectInRoot@1223             applyProjectCollapse@1262         toggleJob@1275
setMaximized@1288                 scrollThreadToBottom@1320         foldAll@1332                      jobPreview@1344
isWaiting@1363                    waitTries@1369                    waitNext@1377                     waitNote@1384
turnStateText@1391                jobStatusWord@1408                jobStatusClass@1419               livePulse@1449
livePulseHtml@1493                jobPreviewHtml@1499               refreshJobPreview@1514            conversations@1530
turnSeqOf@1554                    inflightToolIndex@1578            inflightToolName@1600             liveLabel@1607
liveSuffix@1612                   tickLiveClocks@1617               isBookkeeping@1634                lineHtml@1644
burstGroups@1658                  toolBurstRows@1677                burstSegments@1707                groupLines@1733
storeOffsetsBefore@1810           resultBlocksFor@1825              repaintToolGroup@1835             ensureToolStore@1859
wholeStoredHtml@1915              rowForHead@1960                   foldForNote@1985                  foldByHeadAnyTool@2002
noteFolds@2016                    burstStoreTools@2030              stampedRowFor@2039                expandToolFold@2053
loadBatchCalls@2152               rebuildToolGroup@2194             toolGroupAnchor@2233              windowLines@2249
toolGroupStateKey@2267            toolGroupDropsState@2274          rememberToolGroup@2279            linkBatchTail@2301
trimmedBurstHtml@2314             trimmedGroupHtml@2328             toolGroupHtml@2373                toBottomBtnHtml@2713
consoleToolsHtml@2720             paintToBottom@2729                streamBodyHtml@2748               mdRunHtml@2820
condensedBodyHtml@2827            turnBody@2865                     permissionBoxHtml@2908            approvalPrompt@2952
approvalClosedNote@2996           approvalDecided@3002              questionHead@3034                 qLook@3054
paintQLook@3077                   applyQLook@3096                   questionPrompt@3127               fmtLeft@3194
tickQuestionClocks@3204           questionAnswered@3223             answerRunQuestion@3233            turnKey@3270
turnIsOpen@3274                   toggleTurn@3281                   turnPageOffset@3305               originHtml@3314
turnHead@3348                     inlinePrompt@3358                 displayPrompt@3371                turnAttachmentsHtml@3377
firstSentence@3390                turnPeekLine@3398                 compactHtml@3441                  peekHtml@3468
refreshTurnPeek@3475              turnBlock@3487                    artifactsFor@3512                 baseNameOf@3523
splitArtifacts@3529               closeArtifactPops@3536            openArtifact@3541                 openArtifactUrl@3555
deleteArtifact@3569               copyText@3586                     artifactRowsHtml@3611             artifactsPopHtml@3628
renderArtifactsPop@3639           fmtTokens@3665                    fmtTok@3679                       contextBar@3699
modelSegHtml@3709                 statsRowHtml@3713                 contextSegHtml@3721               fmtUsd@3737
usageSegHtml@3751                 statsLine@3771                    closeModelPop@3836                popAnchor@3845
positionModelPop@3853             openModelPop@3896                 parseContextSize@3911             contextTiers@3920
contextTierValues@3936            cycleContext@3940                 openContextPop@3955               pickContext@4007
pickModel@4028                    turnRetryHtml@4053                fmtSeconds@4069                   subConsoleHtml@4076
subagentsHtml@4088                turnWindow@4139                   childOwner@4150                   subagentsForTurn@4175
turnBounds@4187                   turnSubagentsHtml@4199            subagentsCompactHtml@4210         autoCollectOn@4226
collectedIds@4234                 markCollected@4242                collectThread@4252                parentLeftEarly@4292
subagentsSig@4300                 subagentsOpenSig@4309             subagentsStripSig@4317            paintSubagents@4330
refreshSubagentRoster@4381        bumpSubRead@4450                  loadSubConsole@4454               toggleSubs@4472
toggleSubConsole@4479             sweepThinking@4500                pipelineChipHtml@4562             conversationHtml@4572
restoreReplyDraft@4859            captureTyping@4876                growBoxToDraft@4905               growReplyBox@4925
restoreTyping@4939                restoreAddAgent@5002              beginRename@5030                  saveLabel@5075
refreshAgentMode@5104             saveRefreshAgent@5113             paintRefreshAgent@5123            refreshOfferHtml@5130
paintRefreshOffer@5147            paintRefreshOffers@5161           clearRefreshOffer@5168            refreshTreeRow@5173
startRefreshAgentFromCard@5215    forceRowRead@5250                 focusReplyBox@5277                insertNewlineAtCaret@5291
openInBrowser@5300                replyHistoryStore@5329            rememberReply@5338                turnPrompts@5353
queueReply@5378                   queueReplyFromBox@5392            queueOfferedFor@5414              steerOfferedFor@5420
steerFromBox@5427                 replyQueued@5438                  queuedEditFor@5445                ghostTurnHtml@5455
openQueuedEdit@5476               saveQueuedEdit@5500               cancelQueuedEdit@5534             takeQueuedReply@5545
revertEditOnClickAway@5561        heldReplyBlocked@5624             markReplySent@5635                replyTakenByDrain@5641
cancelQueuedReply@5649            childrenOut@5682                  threadBusy@5690                   drainReplyQueue@5694
loadTreeNames@5744                saveTreeNames@5757                isProjectRootRow@5770             treeTitleOf@5779
loadSpawnHistory@5787             saveSpawnHistory@5798             rememberSpawnPrompt@5808          recallSpawnPrompt@5823
recallReply@5843                  continueThread@5871               reattachCard@5892                 askComplete@5942
markChipAsked@5984                probeWorktreeAgents@5992          addAgentBarHtml@6024              swapAddAgentBox@6041
openAddAgent@6056                 closeAddAgent@6077                submitAddAgent@6087               beginDomMove@6220
endDomMove@6223                   rememberAddAgentCaret@6227        sendReply@6240                    steerTurn@6302
jobHtml@6392                      prevTurnMode@6404                 previousTurnPlan@6416             applyPreviousTurnPlan@6427
applyPrevTurnMode@6436            focusNewTurn@6451                 matchWorktree@6488                attachAgent@6501
clearThread@6524                  answerRunApproval@6570            closeApprovalCard@6616            approvalsFolded@6638
applyApprovalsFold@6646           approvalAgentName@6656            approvalCard@6666                 applyRemoteWrites@6699
remoteWriteBoxHtml@6712           remoteWriteDecidedHtml@6742       reviewAgentName@6755              remoteWriteReviewHtml@6771
rwGroupHtml@6803                  renderApprovals@6810              revealAgentHome@6873              rwAgentFor@6895
rwUnresolved@6905                 dockNote@6913                     dockGoto@6921                     keepReview@6977
unwindReview@7003                 tickApprovals@7049                approvalKey@7107                  approvalAlreadySent@7111
noteApprovalSent@7116             answerApproval@7124               answerRemoteWrite@7154            thinkDefault@7208
thinkingOn@7216                   setThinking@7227                  streamDefault@7244                streamOn@7256
setStreamMode@7267                toolGroupsOn@7285                 setToolGroups@7294                foldFollowsConsole@7317
setFoldFollow@7325                typeSpeedStored@7354              typeWordSpeed@7364                typeLineRate@7368
reasoningShown@7406               reasoningWants@7413               reasoningFloor@7423               reasoningStart@7431
reasoningBusy@7448                paceThinkBlock@7484               resultToolOf@7507                 paceResultLine@7519
resultRowIndex@7539               shouldPaceResultRow@7550          typedText@7557                    typedShown@7574
rowTakesTail@7601                 drawRowText@7609                  startMdBlock@7641                 appendFenceRow@7648
finishFence@7659                  appendProseLine@7674              consoleRawLines@7707              paintRawConsole@7711
restoreRenderedConsole@7721       paintConsoleModes@7737            consoleCopies@7758                toggleConsoleRaw@7766
toggleConsoleFocus@7784           toggleConsoleFence@7804           wireConsole@7832                  placedNodes@7876
notePlaced@7889                   byDocumentOrder@7896              consoleOuts@7902                  stickSoon@7918
paintTypedLines@7938              flushTypeStream@7966              paintStreamSpeed@7981             saveTypeWords@8003
saveTypeLines@8014                loadThinkingAfter@8029            loadThinking@8036                 stickSubConsole@8080
stickThinkBody@8089               syncStreamConsole@8116            paintStreamConsole@8191           sameThinkShape@8212
writeThinkText@8226               syncThinkBody@8241                syncThinkBlock@8286               paintThink@8297
thinkOpenFor@8327                 thinkHtml@8333                    copyButtonHtml@8378               mountCopyButtons@8384
armPlacedThink@8407               watchMotion@8431                  copyBlockBox@8485                 copyShownText@8490
blockCopyText@8533                flashCopyButton@8537              readerInputHere@8597              consolePinned@8605
pinConsole@8609                   holdConsoleFor@8624               justPlaced@8640                   setScroll@8644
restoreThinkBodies@8665           settleScrolls@8670                restoreThinkBody@8684             stickConsole@8696
captureScrolls@8703               restoreScrolls@8717               applyStoredHeight@8738            applyStoredHeights@8750
applyStoredScrolls@8757           placeBuiltConsoles@8775           applySubConsoleScrolls@8798       placeInOrder@8822
holdScrolls@8839                  releaseScrolls@8858               holdSubConsoles@8875              queueJobsRefresh@8888
scheduleRenderJobs@8901           renderJobs@8910                   paintAgentBadges@9016             updateJob@9035
conversationSignature@9084        selectionIn@9182                  offsetIn@9198                     pointAt@9210
cardForThread@9224                captureCardSelection@9229         restoreCardSelection@9250         paintCardMeta@9280
renderConversation@9303           applyPendingFocus@9378            programmaticScroll@9418           appendJobLine@9434
recordJobLine@9456                drawJobLine@9471                  retrySpawn@9602                   recoverSpawnAfterTimeout@9629
retryableError@9654               spawnMsgHtml@9668                 spawnAgent@9675                   modelOptionHtml@9734
renderModelPicker@9754            loadModels@9779                   syncProjectPicker@9791            selectedProject@9813
updateSpawnNote@9818              openAgentsBlock@9843              revealCard@9853                   scrollCardUnderBar@9865
clearSpawnPrompt@9892             focusPromptWithoutScrolling@9899  aimSpawnAtWorktree@9911           resetSpawnDefaults@9928
focusSpawn@9940                   formValues@9959                   panelAgentsByPath@9984            rowsInBoardOrder@10010
topAgentOf@10026                  jumpToPanelAgent@10033            jumpToAgent@10085                 findTurnStar@10111
landOnSpawnedCard@10120           revealSpawnedAgent@10139          panelMap@10188                    invalidatePanelMap@10192
agentsByPath@10203                agentsFor@10218                   knownThreads@10224                reviveSession@10231
turnLive@10277                    approvalLive@10287                convLive@10295                    agentsRunning@10301
isAgentRunning@10305              isHomelessConv@10309              homelessConversations@10319       worktreeOptionsHtml@10326
panelFor@10334                    isRowLive@10338                   hermesTitle@10344                 sigChips@10351
paintRowChips@10378               repaintAgentState@10386           livenessLines@10401               agentBadgeHtml@10426
deletableWithoutAsking@10446      showWorktreeConfirm@10464         scanTick@10510                    waitForScanPass@10519
confirmDeleteWorktree@10530       toggleWorktreeLock@10608          answerRowConfirm@10643            renameWorktreePrompt@10666
cutChildTree@10723                mergeAgentLabel@10773             checkAgentLabel@10784             baseBranchOf@10793
rebaseTargetOf@10801              verdictHtml@10806                 mergeParentOf@10871               mergeChooserTitle@10890
closeMergeChooser@10908           openMergeChooser@10920            chooseMergeOutcome@10980          startMerge@11071
prMatchNote@11116                 branchCellHtml@11138              vsMainLine@11174                  aheadBehindCellHtml@11181
prCellHtml@11237                  ownerTagOf@11273                  ownerCellHtml@11289               ownerDetailHtml@11299
rowHtml@11306                     noteScan@11406                    eventLifeAt@11426                 lifeAtFor@11430
rowActivityAt@11438               chartTopLimit@11446               chartTopOrder@11458               chartTopSplit@11471
rowTopHidden@11481                heldRowCount@11489                chartDrawOrder@11497              topToggleTitle@11504
topSlotHtml@11525                 paintTopToggle@11538              refreshTopToggle@11554            toggleShowOld@11568
ringState@11578                   ringOffset@11605                  ringStroke@11611                  ageCellHtml@11617
paintAgeCell@11628                rowKeyForThread@11666             pulseRow@11687                    rowNode@11699
restartClassAnimation@11710       pulseProject@11723                lifeRowKey@11747                  lifeProjKey@11750
lifeAgentKey@11753                rankWindowMs@11757                pushEventLife@11764               rankWindowCount@11783
rankScore@11794                   pruneRankWindows@11800            rankIdealOrder@11831              tickRankedOrder@11841
orderedByRank@11891               rowRankCtx@11910                  projectRankCtx@11922              folderRankCtx@11933
agentRankCtx@11960                seedRankWindows@11978             seedProjectRank@12020             tickRowScope@12029
tickAgentScopes@12034             tickProjectScopes@12047           tickLivenessRanks@12066           applyRowRank@12081
reorderAgentCards@12092           noteEventLife@12122               loadProjectHues@12158             saveProjectHues@12172
rollProjectHue@12181              applyProjectHue@12193             updateColorsRow@12207             headTitle@12216
loadAnchorFlag@12226              saveAnchorFlag@12235              loadAnchorSeconds@12243           loadRankSeconds@12254
saveAnchorSeconds@12258           loadAnchorThread@12266            saveAnchorThread@12274            setAnchorThread@12283
toggleAnchorPin@12296             readingTop@12300                  nearestReadingLine@12306          anchorVisible@12324
anchorCardFor@12330               loadFlashSeconds@12341            saveFlashSeconds@12351            flashScale@12361
flashRowMs@12364                  flashProjectMs@12367              flashRingMs@12370                 applyFlashTime@12376
anchorHoverMs@12383               anchorTouchMs@12387               anchorNodeFor@12394               boardTargetOf@12413
sameAnchorTarget@12437            projectBarVisible@12446           intentAnchorNode@12451            readingAnchor@12472
refreshAnchorBaseline@12497       scheduleAnchorCompensation@12516  compensateAnchor@12526            trackAnchorIntent@12572
startAnchorObserver@12604         captureBoardAnchor@12659          holdAnchor@12688                  scheduleBoardSweep@12711
sweepStaleBoard@12724             fillAgentSlots@12806              gitSubHtml@12846                  descLines@12865
todoAge@12886                     todoOldest@12899                  todoLine@12909                    todoPeekFor@12920
repaintTodoBlock@12932            todoPost@12957                    todoBlockHtml@12974               refreshClock@13083
detailHtml@13090                  chipsHtml@13314                   projectActivity@13419             projectTouchedAt@13431
shownInRoot@13440                 projectRanks@13449                pinOpenProjects@13466             sortedProjects@13487
queueReorderProjects@13500        childrenMatching@13516            boardGroups@13521                 groupBody@13524
reorderProjects@13528             rootChips@13617                   rootSection@13638                 hostChipHtml@13682
hostPanelHtml@13693               repaintHostPanel@13707            proposeHostMapping@13722          saveHostMapping@13766
projectSection@13802              refreshChips@13835                projectNode@13857                 hiddenColumnIds@13932
ownerMatters@13947                shownColumns@13962                wtColspan@13973                   chartHeaderHtml@13977
loadColWidths@13990               saveColWidths@14002               headerCells@14010                 naturalColumnWidths@14028
columnPlan@14061                  applyColumnWidths@14115           fitTarget@14136                   applyFitMode@14145
columnSignature@14161             fitColumns@14174                  scheduleColumnFit@14200           fitAllColumns@14220
installColumnGrips@14234          beginColumnDrag@14254             dragColumn@14274                  endColumnDrag@14287
watchBoardWidth@14317             stabilizeOn@14339                 applyStabilize@14349              projectHasOpenRow@14364
rowHasOpenCard@14369              orderedAgents@14377               rememberAgentOrder@14392          rememberAgentOrders@14399
reorder@14403                     flashMovedByKey@14479             flashMoved@14506                  stableStringify@14522
rowDetailSig@14530                queueRow@14536                    placeRow@14555                    removeRow@14731
renderProjectRows@14755           paintConfigLine@14899             renderAll@14907                   applySnapshot@15012
placeBanner@15141                 bannerSeconds@15166               stopBannerTimer@15185             bannerHeld@15192
armBannerTimer@15200              hideBanner@15212                  showBanner@15222                  paintBannerSetting@15243
saveBannerSetting@15256           showNote@15300                    readNow@15330                     cardConsoleSize@15445
zoomConsole@15450                 reorderSeconds@17503              startReorderClock@17512           applyZoom@17539
zoomBy@17562                      hotRowFor@17585                   hotOpenPath@17595                 flashHotCard@17617
humanOpenOnTurn@17644             humanAgentName@17653              humanQuestions@17670              paintHumanButton@17726
humanShow@17763                   humanLandOnQuestion@17808         humanFocusNow@17847               humanRefocus@17863
humanTick@17878                   humanShowDock@17898               humanStep@17935                   humanTextEntry@17973
deliverPopEl@18051                deliverPosition@18101             openDeliverPop@18115              closeDeliverPop@18131
toggleDeliverPop@18141            deliverHookStream@18194           deliverList@18204                 deliverFetch@18212
paintDeliverRows@18242            deliverRowHtml@18310              deliverLinkLabel@18334            deliverDayLabel@18345
deliverMarkActive@18358           paintDeliverAges@18379            deliverKeydown@18387              deliverOpenTarget@18423
deliverOpenAgent@18451            deliverOpenWorktree@18515         withEmojiFallback@18595           currentFontId@18607
applyFont@18618                   termSize@18637                    termWeight@18647                  applyTermStyle@18657
retireTextStyleSize@18703         textStyleColor@18713              textStyleSize@18723               applyTextStyle@18736
resetTextStyle@18772              contrastColor@18799               applyContrast@18804               contrastSetting@18822
addBarColors@18839                applyAddBarBrightness@18853       addBarBrightnessSetting@18870     addBarAtTop@18885
applyAddBarTop@18895              greyFlashOn@18912                 applyGreyFlash@18920              settingsTabButtons@18945
settingsTabPanels@18951           settingsTabKey@18957              saveSettingsTab@18968             paintSettingsTab@18979
selectSettingsTab@18998           paintSettingsTabCounts@19008      initSettingsTabs@19029            settingsRowText@19078
paintSettingsRows@19089           paintSettingsSearch@19108         paintSettingsSearchHighlight@19145  clearSettingsSearch@19175
initSettingsSearch@19182          readSkillsFolds@19265             saveSkillsFolds@19275             skillsSourceOpen@19286
skillsCategoryOpen@19294          setSkillsFold@19301               applySkillsFold@19314             skillsByName@19327
skillsCategories@19335            skillsRowHtml@19354               skillsCategoryHtml@19392          skillsSourceHtml@19411
initSkillsGroups@19442            paintSkillsSearch@19470           paintSkills@19500                 loadSkills@19563
permissionStatusText@19596        permissionsGroupHtml@19606        paintPermissions@19640            paintPermissionsSearch@19681
loadPermissions@19706             loadPipelines@19745               pipelineDroppedHtml@19771         pipelineOptionLabel@19776
paintPipelines@19781              selectPipelineTab@19852           openPipelineFlow@19869            openPipelineEditor@19905
closePipelineEditor@19920         setPipelineStatus@19932           paintPipelineFindings@19939       pipelineStageHtml@19953
paintPipelineEditor@19976         wirePipelineEditor@20015          updateDraftFromForm@20062         addPipelineStage@20086
removePipelineStage@20095         savePipelineEditor@20104          paintPipelineSearch@20139         bundleTaskPlace@20188
bundlePipelineRowHtml@20198       bundleTaskRowHtml@20210           paintBundles@20224                paintBundleTasks@20279
paintBundlesSearch@20328          loadBundles@20347                 initBundlesPanel@20389            settingsZoom@20437
settingsViewport@20444            readSettingsRect@20451            writeSettingsRect@20462           clampSettingsRect@20475
placeSettingsWindow@20488         initSettingsWindow@20503          toggleSettings@20598              paintProviderSetting@20664
loadProviderSetting@20695         saveProviderSetting@20706         clearProviderKey@20736            providerProfiles@20784
selectedProfile@20788             paintProviderProfiles@20792       loadProviderProfiles@20837        saveProviderProfile@20853
deleteProviderProfile@20891       applyProviderProfile@20932        restartFromSettings@20971         modelListAgeText@21032
snapshotDate@21036                modelAgeText@21040                paintModelsSetting@21045          loadModelsSetting@21069
refreshModels@21081               humanWindow@21135                 paintApprovalSetting@21142        loadApprovalSetting@21185
saveApprovalSetting@21199         matrixTitle@21241                 matrixSettingsShowing@21248       paintMatrix@21257
loadMatrixStatus@21361            matrixPress@21375                 matrixSave@21408                  paintReorderSetting@21443
saveReorderSetting@21457          paintRankWindow@21475             saveRankWindow@21480              paintSessionSetting@21510
loadSessionSetting@21553          saveSessionSetting@21567          initFonts@21595                   initQLook@21626
agentCleanupStored@21745          paintAgentCleanup@21749           chartTopStored@21809              chartTopSentence@21814
legacyAgeNote@21823               paintTopSetting@21829             saveTopSetting@21853              collapseAfterStored@21913
collapseAfterSentence@21918       paintCollapseAfterSetting@21924   saveCollapseAfterSetting@21946    chartColumnsStored@21982
chartColumnsSentence@21992        paintChartColumns@22003           saveChartColumns@22029            remotePolicyStored@22090
paintRemotePolicy@22095           refreshRemoteGuards@22121         saveRemotePolicy@22132            installPushGuardNow@22159
fmtBytes@22198                    paintPaths@22213                  paintScratchActions@22248         openPathFolder@22261
cleanScratchNow@22277             applySettings@22316               paintAnchorSettings@22333         visibleProjects@22621
reportVisibility@22632            startVisibilityReporting@22648
```

### A.2 the 266 lexical bindings

Top-level `const`/`let`. Visible to every later classic script by bare name; **not** on `window`.
A second declaration of one of these names in another file is a `SyntaxError` that kills that file alone.

```
SPAWN_HISTORY_KEY@9               SPAWN_HISTORY_MAX@10              PROJECT_HUE_KEY@16                ANCHOR_THREAD_KEY@17
ANCHOR_HOVER_KEY@18               ANCHOR_HOVER_SECONDS_KEY@19       ANCHOR_HOVER_SECONDS_DEFAULT@20   ANCHOR_TOUCH_KEY@21
ANCHOR_TOUCH_SECONDS_KEY@22       ANCHOR_TOUCH_SECONDS_DEFAULT@23   FLASH_TIME_KEY@24                 FLASH_TIME_DEFAULT@25
EVENT_FLASH_KEY@26                TREENAMES_KEY@30                  SHOW_OLD_KEY@35                   boxChips@40
RANK_WINDOW_KEY@45                RANK_WINDOW_DEFAULT@46            RANK_WINDOW_MIN@47                RANK_WINDOW_MAX@48
RANK_EVENT_CAP@49                 RANK_MARGIN_PER_MIN@53            state@55                          RECENT_DAYS@597
normPath@622                      COLLAPSE_CASCADE_DEFAULT_SECONDS@699  COLLAPSE_CASCADE_MAX_SECONDS@700  collapseTimerKey@708
FIXED_CARDS@914                   COLLAPSE_TIERS@1022               PULSE_SILENT_SECONDS@1447         turnOrder@1527
TOOL_START_RE@1566                TOOL_DONE_RE@1567                 toolCallArg@1570                  BOOKKEEPING_LINES@1633
READ_CODE_OPEN@1914               foldKey@1928                      fullForFold@1929                  FOLD_ROWS_MAX@1930
HEAD_LINES@1948                   LF@1949                           foldLineText@1952                 storeRowsFor@1953
TURN_WINDOW@2247                  BATCH_TAIL_RE@2299                APPROVAL_CHOICE_LABEL@2901        APPROVAL_CLOSED_HEAD@2994
questionPicks@3025                questionDrafts@3026               questionSending@3027              RECOMMENDED_RE@3028
Q_LOOK_KEY@3045                   Q_TINTS@3046                      Q_SIZE_MIN@3047                   Q_SIZE_MAX@3048
Q_SIZE_DEFAULT@3049               Q_WIDTH_MIN@3051                  Q_WIDTH_MAX@3052                  qLookState@3075
TURNS_PER_PAGE@3303               ATTACH_BLOCK_RE@3370              modelPop@3828                     modelPopTarget@3831
modelPopAnchorEl@3834             subagentFallback@4065             subagentLive@4066                 subagentRosterAt@4067
CHILD_SLACK_MS@4137               AUTO_COLLECT_KEY@4223             REPLY_MAX_LINES@4902              SPAWN_MAX_LINES@4903
REFRESH_AGENT_KEY@5101            REFRESH_AGENT_MODES@5102          PANEL_PROMPT@5322                 REPLY_HISTORY_KEY@5326
REPLY_HISTORY_MAX@5327            CONTINUE_TEXT@5865                addAgentFieldOf@6135              domMoveDepth@6219
PREV_TURN_KEY@6402                PREV_TURN_MODES@6403              APPROVAL_LABEL@6632               APPROVALS_FOLDED_KEY@6635
approvalThreadsShown@6636         DECIDED_TTL_MS@6696               DECIDED_SHOWN@6697                approvalSent@7105
THINK_KEY@7200                    STREAM_KEY@7242                   TOOL_GROUPS_KEY@7283              FOLD_FOLLOW_KEY@7315
TYPE_WORDS_KEY@7347               TYPE_WORDS_DEFAULT@7350           TYPE_LINES_KEY@7351               TYPE_LINES_DEFAULT@7352
REASONING_READ_WAIT_MS@7402       REASONING_READ_COOLDOWN_MS@7403   RESULT_PACED_ROWS@7535            ROW_URL_RE@7599
MD_MARK_RE@7634                   stickPending@7914                 stickFrame@7915                   thinkAutoOpened@8074
streamRowKey@8109                 thinkRowKey@8209                  COPY_SEL@8372                     COPY_BTN_SEL@8373
COPY_TEXT_SEL@8374                COPY_TITLE@8375                   COPY_FLASH_MS@8376                motionDots@8423
offscreenMotion@8424              copyObserver@8447                 COPY_SKIP_TAGS@8483               INPUT_WINDOW_MS@8584
lastInputAt@8585                  selfScrolled@8603                 jobsRefreshQueued@8887            renderJobsQueued@8900
pendingScrollAt@9415              endFollowOnScroll@9421            lastSpawnAttempt@9666             modelsState@9726
panelMapCache@10187               agentsByPathCache@10200           threadRowKeyCache@10202           LIVE_STATUS@10275
rowConfirmSent@10641              childPresses@10721                mergeInFlight@10769               mergePress@10771
mergeChooser@10906                ownerNameOf@11265                 ownerLabelOf@11266                ownerRoleOf@11267
RING_C@11404                      CHART_TOP_DEFAULT@11445           chartTopName@11451                FLASH_BASE_SECONDS@12360
anchorState@12488                 anchorScrollY@12489               lastAnchorScrollAt@12490          anchorRepickTimer@12491
anchorMuteUntil@12495             anchorBusy@12514                  anchorObserver@12568              boardSweepQueued@12653
boardAnchor@12657                 DESC_SENTENCE_BREAK@12863         TODO_GLYPH@12883                  reorderFrame@13499
CHART_COLUMNS@13886               WT_COLS@13920                     COL_MIN@13924                     COL_GIVE@13928
OWNER_COLUMN_ID@13960             COL_WIDTHS_KEY@13988              colWidths@14000                   WT_SCROLL@14134
columnSigs@14159                  pendingFits@14197                 fitScheduled@14198                colDrag@14232
columnFitTimer@14304              boardWidthObserver@14316          STABILIZE_KEY@14338               pendingRows@14513
rowFrame@14514                    DETAIL_VOLATILE@14519             BANNER_SECONDS_KEY@15161          BANNER_SECONDS_DEFAULT@15162
BANNER_SECONDS_MAX@15163          BANNER_NOTE_MS@15164              noteTimer@15182                   bannerTimer@15183
CONSOLE_ZOOM_MIN@15440            CONSOLE_ZOOM_MAX@15441            onConsoleWheel@15468              consoleDrag@15498
REORDER_KEY@17499                 REORDER_DEFAULT@17500             REORDER_MAX@17501                 ZOOM_KEY@17535
ZOOM_MIN@17536                    ZOOM_MAX@17537                    DELIVER_DEFAULT_CAP@18035         deliver@18036
UI_FONTS@18547                    TERM_FONTS@18560                  TERM_SIZES@18581                  TERM_WEIGHTS@18582
EMOJI_FALLBACK@18594              FONT_SETS@18602                   TEXT_STYLES@18694                 TEXT_COLOR_RE@18699
CONTRAST_KEY@18783                CONTRAST_FLAT@18786               CONTRAST_MAX@18787                ADDBAR_KEY@18837
ADDBAR_DEFAULT@18838              ADDBAR_TOP_KEY@18884              SETTINGS_TAB_KEY@18942            SETTINGS_TABS_ID@18943
SETTINGS_SEARCH_ID@19074          SETTINGS_SEARCH_CLEAR_ID@19075    SETTINGS_SEARCH_HIGHLIGHT@19076   SKILLS_PANEL_ID@19239
SKILLS_GROUPS_KEY@19240           SKILLS_OPEN_CATEGORIES@19243      SKILLS_KIND_LABEL@19244           skillsIndex@19253
skillsLoadedAt@19254              skillsLoading@19255               skillsKind@19257                  skillsMany@19258
skillsFoldRecord@19283            skillsFoldTitle@19309             skillsSetCount@19461              PERMISSIONS_PANEL_ID@19588
permissionsIndex@19589            permissionsLoadedAt@19590         permissionsLoading@19591          permissionsRows@19593
permissionsBad@19594              PIPELINE_PANEL_ID@19733           pipelinesIndex@19734              pipelinesLoadedAt@19735
pipelinesLoading@19736            pipelineOpenId@19737              pipelineDraft@19738               pipelineDraftDirty@19739
pipelineFindings@19740            pipelineExitChecks@19743          BUNDLES_PANEL_ID@20175            bundlesIndex@20176
bundlesLoadedAt@20177             bundlesLoading@20178              bundleQueues@20179                bundleQueuesAt@20180
bundleQueuesError@20183           SETTINGS_RECT_KEY@20429           SETTINGS_MIN_W@20430              SETTINGS_MIN_H@20431
SETTINGS_EDGE@20432               SETTINGS_SLOP@20433               settingsRect@20470                providerStateCache@20662
providerProfilesCache@20779       providerProfileChosen@20782       modelsSetting@21026               approvalState@21132
matrixState@21237                 matrixBusy@21238                  MATRIX_TITLES@21240               sessionsState@21508
CHART_TOP_MAX_UI@21807            COLLAPSE_AFTER_MAX_UI@21911       REMOTE_POLICY_SENTENCE@22084      PATH_SOURCE_WORD@22190
pathText@22211                    VISIBLE_MARGIN@22612              visibleSentAt@22613               visibleKey@22617
visibleSampleKey@22618            visibleTimer@22619
```
