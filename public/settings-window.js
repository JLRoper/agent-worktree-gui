// settings-window.js - the Settings window, cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js is the file six open queue rows claimed at 2026-11-28, and the
// Settings window was the largest single block left in it. This is cut 8 of the eight in
// docs/reports/module-separation-2026-11-28.html, section 5's card for public/app.js: "the whole
// Settings window: tabs, Skills, Permissions, pipeline, bundles, the provider profiles, the Matrix
// bridge and the tier rows". Moved line for line: not one body was rewritten and not one call site
// was touched.
//
// WHAT IS HERE
//
//   the tab strip           SETTINGS_TAB_KEY, SETTINGS_TABS_ID, settingsTabButtons, settingsTabPanels,
//                           settingsTabKey, saveSettingsTab, paintSettingsTab, selectSettingsTab,
//                           paintSettingsTabCounts, initSettingsTabs: eight groups of rows, one panel
//                           on screen at a time, the chosen tab remembered in this browser.
//   release notes           RELEASE_NOTES_ID, RELEASE_NOTES_SOURCE_ID, RELEASE_NOTES_ROW_ID,
//                           changelogIndex, changelogWhen, changelogBytes, releaseNotesSectionHtml,
//                           releaseNotesList, paintChangelog, loadChangelog.
//   settings search         SETTINGS_SEARCH_ID, SETTINGS_SEARCH_CLEAR_ID, SETTINGS_SEARCH_HIGHLIGHT,
//                           settingsRowText, paintSettingsRows, paintSkillsSearchState,
//                           paintSettingsSearch, paintSettingsSearchHighlight, clearSettingsSearch,
//                           initSettingsSearch.
//   the Skills tab          SKILLS_PANEL_ID, SKILLS_SEARCH_ID, SKILLS_GROUPS_KEY, skillsIndex,
//                           skillsKind, readSkillsFolds, saveSkillsFolds, skillsFoldRecord,
//                           skillsSourceOpen, skillsCategoryOpen, setSkillsFold, skillsFoldTitle,
//                           skillsByName, skillsCategories, skillsRowHtml, skillsCategoryHtml,
//                           skillsSourceHtml, initSkillsGroups, paintSkillsSearch, paintSkillsNoHits,
//                           focusSkillsSearch, initSkillsSearch, paintSkills, loadSkills.
//   Permissions             PERMISSIONS_PANEL_ID, permissionsIndex, permissionsRows, permissionsBad,
//                           permissionStatusText, permissionsGroupHtml, paintPermissions,
//                           paintPermissionsSearch, loadPermissions.
//   settings > pipeline     PIPELINE_PANEL_ID, pipelinesIndex, pipelineOpenId, pipelineDraft,
//                           pipelineFindings, pdlPipelines, selectedPdlPipeline, loadPipelines,
//                           pipelineDroppedHtml, pipelineOptionLabel, pdlPipelineRowHtml,
//                           paintPdlPipelines, repairPipelineBundle, paintPipelines, selectPipelineTab,
//                           openPipelineFlow, openPdlFlow, openPipelineEditor, closePipelineEditor,
//                           setPipelineStatus, paintPipelineFindings, pipelineStageHtml,
//                           paintPipelineEditor, markPipelineDraftDirty, wirePipelineStages,
//                           restorePipelineFocus, paintPipelineStages, wirePipelineEditor,
//                           updateDraftFromForm, addPipelineStage, removePipelineStage,
//                           savePipelineEditor, paintPipelineSearch.
//   settings > bundles      BUNDLES_PANEL_ID, bundlesIndex, bundleQueues, bundleTaskPlace,
//                           bundlePipelineRowHtml, bundleTaskRowHtml, paintBundles, paintBundleTasks,
//                           paintBundlesSearch, loadBundles, bundleImportChosen, initBundlesPanel.
//   the window itself       SETTINGS_RECT_KEY, settingsZoom, settingsViewport, readSettingsRect,
//                           writeSettingsRect, clampSettingsRect, placeSettingsWindow,
//                           initSettingsWindow, toggleSettings.
//   the provider            providerStateCache, paintProviderSetting, loadProviderSetting,
//                           saveProviderSetting, clearProviderKey, providerProfilesCache,
//                           providerProfiles, selectedProfile, paintProviderProfiles,
//                           loadProviderProfiles, saveProviderProfile, deleteProviderProfile,
//                           restartFromSettings.
//   models, reset, approval modelsSetting, modelListAgeText, snapshotDate, modelAgeText,
//                           paintModelsSetting, loadModelsSetting, refreshModels, resetArmTimer,
//                           resetRoster, resetChosen, resetDisarm, paintResetRow, resetDryLines,
//                           resetCopyView, paintResetPreview, resetAssistant, approvalState,
//                           humanWindow, paintApprovalSetting, loadApprovalSetting,
//                           saveApprovalSetting.
//   the Matrix bridge       matrixState, MATRIX_TITLES, matrixTitle, matrixSettingsShowing,
//                           paintMatrix, loadMatrixStatus, matrixPress, matrixSave.
//   the small rows          paintReorderSetting, saveReorderSetting, paintRankWindow,
//                           saveRankWindow, paintSessionSetting, loadSessionSetting,
//                           saveSessionSetting, initFonts, initQLook.
//   the folders scanned     scanRootsConfigured, scanRootsFallbackSentence, paintScanRoots,
//                           refreshScanRootsAnswer, saveScanRoots, addScanRootFromInput.
//   agent cleanup           agentCleanupStored, paintAgentCleanup.
//   the initiative tier     initiativeTierStored, paintInitiativeTier.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state.settings, state.projects, state.rows, apiFetch (core/transport.js), esc, relTime, fmtAgo,
//   normPath (core/dom-format.js), applyFont, applyTermStyle, applyTextStyle, applyQLook,
//   applyConRowSpace, applyCommandCardLook and the other appliers in public/settings.js, and
//   public/app.js's own $, showBanner, showNote, renderProjectRows, refreshChips, paintRowChips,
//   scanRoots, saveCollapsedRoots and the board's own repaint helpers.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a
// top-level `function` here is a window property and a top-level `let` (changelogIndex, skillsIndex,
// pipelineDraft, matrixState and the rest) is a binding every other script reads by bare name.
// index.html loads this file before app.js, and the file DECLARES ONLY - nothing here reads a `state`
// field or an app.js binding while it loads - so sitting before app.js costs nothing and cannot land
// in a temporal dead zone. public/app.js re-exports these names on window.WMApp.settingsWindow,
// which is the door public/settings.js and public/assistant.js already reach for.
//
// WHAT STAYED IN app.js, AND WHY. The window's load-time wiring is still there: the two buttons that
// open and close it, the tab strip and search wiring, the reads that fill the Skills, Permissions,
// Pipelines, Bundles, release-notes and Prompt tabs before the first press, the window's own drag and
// grip, the font, text-style, row-spacing and command-card-look rows, the scan-mode switch, the scan
// roots' own listener set, the agent-cleanup switch and the initiative-tier switch. Every one of them
// reads `state` or an app.js helper while it runs, which is exactly why the earlier cuts left their
// wiring in app.js too (the deliverables button, the ghost editor's two listeners). They call the
// declarations above by bare name at press time.
//
// RE-MEASURED FROM 3bb43694. The report's card names 15,012-19,062. On this base the declarations run
// 9,479-13,140 with three wiring lines inside that span kept in app.js, then 13,287-13,397,
// 13,412-13,440 and 13,474-13,501. The drift is the five cuts above; the surface is the report's row
// exactly.

// ---- settings tabs ---------------------------------------------------------------------------------------
// Eight groups of rows is a tall panel, and the reader is nearly always here for one of them. Each group is a
// tab now, keyed by `data-settings-group` and drawn in the order the markup carries them: one panel is on
// screen at a time, and the tab the reader chose is remembered in this browser (Display is a first visit's).
// The strip is the panel's heading, so the panels carry no heading of their own — `aria-labelledby` points each
// one at its tab, and the tab carries the tooltip that used to sit on the group's <h3>.
//
// The older fold stores are deliberately neither read nor rewritten, the way each earlier one was left inert:
// `wtgui.settingsFolded` and `wtgui.settingsUnfolded` record which GROUPS were open, which is not a tab. Reading
// either as one would land the reader on whichever group they happened to open last, and rewriting it would turn
// their own saved choice into its reverse. Both stay where they are, unused.
const SETTINGS_TAB_KEY = "wtgui.settingsTab";
const SETTINGS_TABS_ID = "settings-tabs";

function settingsTabButtons() {
  return [...document.querySelectorAll(`#${SETTINGS_TABS_ID} [role="tab"]`)];
}

// The panels in the order the markup gives them — the same order the strip is in, so the key is the whole link
// between a tab and the panel it shows.
function settingsTabPanels() {
  return [...document.querySelectorAll("#settings .settings-group[data-settings-group]")];
}

// The reader's tab, or the first one: a stored key that no longer names a panel (a tab renamed or removed) must
// not leave the window with nothing on screen.
function settingsTabKey() {
  const keys = settingsTabPanels().map((panel) => panel.dataset.settingsGroup);
  try {
    const raw = localStorage.getItem(SETTINGS_TAB_KEY);
    // A tab RENAMED keeps the reader on it: "Branches" became "Repo" in this build, and falling back to Display
    // for a key that still names the same panel would read as a forgotten choice. The old key is not rewritten
    // here; the next select writes the new one.
    const wanted = raw === "branches" && keys.includes("repo") ? "repo" : raw;
    if (wanted && keys.includes(wanted)) return wanted;
  } catch {
    /* private mode */
  }
  return keys[0] || null;
}

function saveSettingsTab(key) {
  try {
    localStorage.setItem(SETTINGS_TAB_KEY, key);
  } catch {
    /* private mode: the tab just will not persist */
  }
}

// One painter for both halves of the fact — which tab is selected and which panel is on screen — because they
// are one fact. The roving tabindex makes the strip a single Tab stop: the selected tab is the reachable one,
// and the arrows inside the strip move the selection.
function paintSettingsTab(key, { save = true, focus = false, scroll = false } = {}) {
  const tabs = settingsTabButtons();
  const chosen = tabs.some((tab) => tab.dataset.settingsTab === key) ? key : tabs[0]?.dataset.settingsTab;
  if (!chosen) return;
  for (const tab of tabs) {
    const on = tab.dataset.settingsTab === chosen;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of settingsTabPanels()) panel.hidden = panel.dataset.settingsGroup !== chosen;
  if (save) saveSettingsTab(chosen);
  if (focus) tabs.find((tab) => tab.dataset.settingsTab === chosen)?.focus();
  // Opening a tab starts it at its own top, not wherever the last one was scrolled to.
  if (scroll) {
    const body = document.querySelector("#settings .settings-body");
    if (body) body.scrollTop = 0;
  }
}

function selectSettingsTab(key) {
  paintSettingsTab(key, { save: true, scroll: true });
  // The Bundles tab is a read of the bundle file and every assistant's queue, so it is refreshed when the reader asks
  // for it — not on every repaint of the settings window. A tab the reader leaves and comes back to asks again only
  // when the answer is old; a press on its own re-read row asks at once (initBundlesPanel).
  if (key === "bundles" && Date.now() - bundlesLoadedAt > 15000) void loadBundles();
  // The Pipeline tab draws the PDL bundle beside the ladder, so it is a read of a file another tab writes: a press on
  // it asks again once the answer is old, the same rule the Bundles tab follows, and an import clears its stamp.
  if (key === "pipeline" && Date.now() - pipelinesLoadedAt > 15000) void loadPipelines();
  // The release notes are a file read on the server too. A tab the reader comes back to re-asks when the answer
  // is old; the first answer is fetched at boot, beside the other tabs' reads, so the search sees its rows.
  if (key === "updates" && Date.now() - changelogLoadedAt > 15000) void loadChangelog();
  // The Prompt tab measures the built briefing on the server, so it is a read, refreshed when the reader comes back to
  // a stale answer and loaded once at boot (the tab is drawn from the panel's own state, not from this page's).
  if (key === "prompt" && Date.now() - promptBudgetLoadedAt > 15000) void loadPromptBudget();
  // Storage & cleanup is a walk of three folders on the server, so the General tab asks again when its answer is old
  // rather than on every repaint: the first read happens at script load, beside the other tabs'.
  if (key === "general" && Date.now() - maintenanceLoadedAt > 15000) void loadMaintenance();
}

// The per-tab counts the search hands over: a badge on the tab's chrome, and the same number in the tab's own
// name for a screen reader (the badge itself is decoration, so it is not read twice).
function paintSettingsTabCounts(counts, query) {
  for (const tab of settingsTabButtons()) {
    const n = counts.get(tab.dataset.settingsTab) || 0;
    const badge = tab.querySelector(".settings-tab-count");
    if (badge) {
      badge.textContent = String(n);
      badge.hidden = !query;
    }
    const label = tab.querySelector(".settings-tab-label");
    if (query) {
      const name = `${label ? label.textContent : tab.dataset.settingsTab} — ${n ? `${n} match${n === 1 ? "" : "es"}` : "no matches"}`;
      tab.setAttribute("aria-label", name);
    } else {
      tab.removeAttribute("aria-label");
    }
  }
}

// The WAI-ARIA tabs pattern's keys: Left/Right wrap around the strip, Home/End take the ends, and Enter/Space
// select the tab that has the focus (the arrows already selected it; this is for the reader who Tabbed to the
// strip and pressed Enter). Space would scroll the panel, so it is swallowed.
function initSettingsTabs() {
  const strip = document.getElementById(SETTINGS_TABS_ID);
  const tabs = settingsTabButtons();
  if (!strip || !tabs.length) return;
  paintSettingsTab(settingsTabKey(), { save: false });
  const at = (key) => tabs.findIndex((tab) => tab.dataset.settingsTab === key);
  strip.addEventListener("click", (e) => {
    const tab = e.target.closest("[role='tab']");
    if (tab) selectSettingsTab(tab.dataset.settingsTab);
  });
  strip.addEventListener("keydown", (e) => {
    const tab = e.target.closest("[role='tab']");
    if (!tab) return;
    const last = tabs.length - 1;
    const here = at(tab.dataset.settingsTab);
    let next = null;
    if (e.key === "ArrowRight") next = tabs[(here + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(here - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[last];
    else if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      selectSettingsTab(tab.dataset.settingsTab);
      return;
    }
    if (!next) return;
    e.preventDefault();
    paintSettingsTab(next.dataset.settingsTab, { save: true, focus: true, scroll: true });
  });
}

// ---- end settings tabs

// ---- settings > updates: the release notes ----------------------------------------------------------------
// The tab answers "what changed since the build I am running?" from the checkout's own CHANGELOG.md, read
// through GET /api/changelog. The newest release is open with its bullets, the ones below it fold, and the
// version the panel serves is marked so the reader can see where they are in the list. The answer carries its
// own state — ok / empty / missing — and the last two are SAID in as many words: a file with no release
// headings and no file at all are different things to a reader, and neither one is a blank box.
//
// A refresh that FAILS is a notice at the top of that list, not a replacement for it: `changelogIndex` keeps the
// last good answer, and a later fetch that throws re-paints it under the red line. Losing the sections because a
// second read failed is the same blank box by another route - the reader had the list a moment ago.
const RELEASE_NOTES_ID = "release-notes";
const RELEASE_NOTES_SOURCE_ID = "release-notes-source";
const RELEASE_NOTES_ROW_ID = "release-notes-row";
let changelogIndex = null;
let changelogLoadedAt = 0;
let changelogLoading = null;

function changelogWhen(mtime) {
  const at = new Date(mtime);
  if (!mtime || Number.isNaN(at.getTime())) return "mtime unknown";
  return at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function changelogBytes(size) {
  return `${Number(size || 0).toLocaleString()} bytes`;
}

// One release: the summary IS the heading (version, date, commit count), so the folded state already answers
// the three facts a reader scans for; the body is the bullets the changelog groups them under.
function releaseNotesSectionHtml(section, serving, index) {
  const version = String(section.version || "");
  const commits = Number(section.commits) || 0;
  const count = `${commits} commit${commits === 1 ? "" : "s"}`;
  const servingHere = serving && version === String(serving);
  const body = (Array.isArray(section.lines) ? section.lines : [])
    .map((line) =>
      line.startsWith("### ")
        ? `<div class="release-group">${esc(line.slice(4))}</div>`
        : `<div class="release-bullet">${esc(line.replace(/^-\s+/, ""))}</div>`,
    )
    .join("");
  return (
    `<details class="release" data-release-version="${esc(version)}"${index === 0 ? " open" : ""}>` +
    `<summary class="release-head" title="${esc(`v${version} · ${section.date} · ${count}${servingHere ? " · the version this panel serves" : ""}`)}">` +
    `<span class="release-version mono">v${esc(version)}</span>` +
    `<span class="release-date mono">${esc(String(section.date || ""))}</span>` +
    `<span class="release-commits mono">${esc(count)}</span>` +
    (servingHere ? `<span class="release-mark">serving</span>` : "") +
    `</summary>` +
    `<div class="release-body">${body || `<div class="release-bullet">this release carries no grouped commits</div>`}</div>` +
    `</details>`
  );
}

// The list as the last good answer painted it: the sections, or the one line that says why there is no list (a
// missing file, no headings, an answer with no releases). Extracted because a FAILED refresh re-paints this under
// its notice: the two paths have to agree on what "the list" is, or a failure would quietly change it.
function releaseNotesList(data) {
  if (!data) return null;
  const file = data.file || "CHANGELOG.md";
  const where = data.path || file;
  if (data.state === "missing") {
    return {
      html: `<div class="release-state bad">${esc(`${file} is missing — there is no file at the panel root (${where}). The panel is serving v${data.serving || "unknown"}; no release notes are on disk.`)}</div>`,
      line: `${file} · not on disk`,
      title: where,
    };
  }
  if (data.state === "empty") {
    return {
      html: `<div class="release-state">${esc(`${file} is present (${changelogBytes(data.size)}, modified ${changelogWhen(data.mtime)}) but carries no "## vX.Y.Z — date · N commits" heading — there is nothing to list. The panel is serving v${data.serving || "unknown"}.`)}</div>`,
      line: `${file} · modified ${changelogWhen(data.mtime)} · ${changelogBytes(data.size)}`,
      title: where,
    };
  }
  if (data.state !== "ok" || !Array.isArray(data.sections) || !data.sections.length) {
    return {
      html: `<div class="release-state bad">${esc(data.reason || `the panel answered ${file} with no releases and no reason`)}</div>`,
      line: `${file} · no releases`,
      title: where,
    };
  }
  return {
    html: data.sections.map((section, i) => releaseNotesSectionHtml(section, data.serving, i)).join(""),
    line: `${file} · modified ${changelogWhen(data.mtime)} · ${changelogBytes(data.size)}`,
    title: where,
  };
}

function paintChangelog(error = null) {
  const list = document.getElementById(RELEASE_NOTES_ID);
  const source = document.getElementById(RELEASE_NOTES_SOURCE_ID);
  const row = document.getElementById(RELEASE_NOTES_ROW_ID);
  if (!list) return;
  const say = (html, line, title) => {
    list.innerHTML = html;
    if (source) {
      source.textContent = line;
      source.title = title || line;
    }
    if (row) row.classList.remove("search-hidden");
  };
  const held = releaseNotesList(changelogIndex);
  if (error) {
    const notice = `<div class="release-state bad">${esc(`the panel could not answer for CHANGELOG.md — ${error}`)}</div>`;
    // A failed refresh is news ABOUT the list, never a replacement for it: the notice goes at the top and every
    // section the last good read painted stays under it. Only a failure with nothing rendered yet is a lone notice.
    if (!held) return say(notice, "CHANGELOG.md · not read");
    return say(`${notice}${held.html}`, `${held.line} · refresh failed`, held.title);
  }
  if (!held) {
    return say(
      `<div class="release-state bad">${esc("the panel has not answered for CHANGELOG.md yet")}</div>`,
      "CHANGELOG.md · not read",
    );
  }
  return say(held.html, held.line, held.title);
}

async function loadChangelog() {
  if (changelogLoading) return changelogLoading;
  changelogLoading = (async () => {
    try {
      const r = await apiFetch("/api/changelog");
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      changelogIndex = data;
      changelogLoadedAt = Date.now();
      paintChangelog();
    } catch (e) {
      paintChangelog(e.message || String(e));
    } finally {
      changelogLoading = null;
    }
  })();
  return changelogLoading;
}

// ---- end settings > updates

// ---- settings search -------------------------------------------------------------------------------------
// The panel is a long list of rows spread over eight tabs, so the way to a setting is the search box the panel's
// fixed head keeps on screen. What it searches is the row itself: its text, its own `title`, and the `title` of
// any control inside it (`zoom out` lives only in a button's tooltip, and it is exactly the word a reader would
// try). A row that does not answer goes away, in every tab — the search is GLOBAL, not a filter on the tab the
// reader happens to be looking at: each tab carries the count of rows that answer it, and the first tab that
// answers is the one shown, so a match in a tab nobody selected is still revealed. The reader's own tab is never
// written by the search, so clearing the box goes back to it exactly as they left it.
//
// The match is painted with the CSS Custom Highlight API: one Range per hit over the row's own text nodes.
// Nothing is re-rendered, so a keystroke cannot take the focus ring, a select's value or a half-typed number with
// it — and a browser without Custom Highlight still filters, it just does not mark the text.
const SETTINGS_SEARCH_ID = "settings-search";
const SETTINGS_SEARCH_CLEAR_ID = "btn-settings-search-clear";
const SETTINGS_SEARCH_HIGHLIGHT = "settings-search-match";

function settingsRowText(row) {
  const parts = [String(row.textContent || "")];
  if (typeof row.getAttribute === "function") parts.push(row.getAttribute("title") || "");
  if (typeof row.querySelectorAll === "function") {
    for (const node of row.querySelectorAll("[title]")) parts.push(node.getAttribute("title") || "");
  }
  return parts.join(" ").toLowerCase();
}

// One flat stretch of a panel: a row answers or it does not, and a preview strip (or a preset row) belongs to the
// row above it. Extracted so a panel with its own grouping can hand its rows through the same rule.
function paintSettingsRows(nodes, query, matched) {
  let hits = 0;
  let follows = true;
  for (const child of nodes) {
    if (child.classList && child.classList.contains("settings-row")) {
      const hit = !query || settingsRowText(child).includes(query);
      child.classList.toggle("search-hidden", !hit);
      follows = hit;
      if (hit) {
        hits += 1;
        if (query) matched.push(child);
      }
    } else if (child.classList) {
      child.classList.toggle("search-hidden", Boolean(query) && !follows);
    }
  }
  return hits;
}

// The Skills tab's own bar, kept in step with the one query: its value always IS the window search's value, its
// clear press shows only while there is something to clear, and a query no skill answers says so in a sentence
// instead of leaving the groups empty. `read` is whether the inventory has answered yet - before it has, "no skill
// matches" would be a claim this page cannot make.
//
// The two element ids are written as strings for the same reason the skills panel key below is: test/settings-tabs
// slices this region out of app.js and runs it without the Skills tab's constants, where a bare identifier is a
// ReferenceError in that harness rather than a wrong answer.
function paintSkillsSearchState(query, hits) {
  const bar = document.getElementById("skills-search");
  if (!bar) return;
  if (bar.value !== query) bar.value = query;
  const clear = document.getElementById("btn-skills-search-clear");
  if (clear) clear.hidden = !query;
  // The no-hit SENTENCE is the Skills tab's own (paintSkillsNoHits): this region filters and toggles classes only, so
  // a keystroke never writes words into the panel it is filtering. The call is guarded by name for the harness above,
  // where the Skills tab's code is not part of the slice.
  if (typeof paintSkillsNoHits === "function") paintSkillsNoHits(query, hits);
}

// ONE query, one filter, TWO controls. The Skills tab's own bar writes its text into the box in this window's head
// and calls THIS painter, so there is no second filter that can disagree with the first; the bar is a handle on the
// surviving path, not a rival to it. `scope` is the one thing the bar asks for differently: a query typed in the
// Skills bar never yanks the reader off Skills to reveal a match on another tab - they stay where they typed, and
// the no-hit sentence says when nothing there answers.
function paintSettingsSearch({ scope = "window" } = {}) {
  const box = document.getElementById(SETTINGS_SEARCH_ID);
  const query = String((box && box.value) || "").trim().toLowerCase();
  const matched = [];
  const counts = new Map(); // per tab key: how many of ITS rows answer — the global answer, tab by tab
  for (const panel of settingsTabPanels()) {
    // The Skills panel is grouped two levels deep and paints its own rows (and its own heading counts); every other
    // tab is the flat list this loop has always walked. Either way the count is the rows that answer, per tab.
    // The key is written as a string rather than SKILLS_PANEL_ID because test/settings-tabs.test.js slices THIS
    // region out of app.js and runs it without the Skills tab's constants: a bare identifier here is a
    // ReferenceError in that harness, not a wrong answer.
    const hits =
      panel.dataset.settingsGroup === "skills"
        ? paintSkillsSearch(query, matched)
        : panel.dataset.settingsGroup === "permissions"
          ? paintPermissionsSearch(query, matched)
          : panel.dataset.settingsGroup === "pipeline"
            ? paintPipelineSearch(query, matched)
            : panel.dataset.settingsGroup === "bundles"
              ? paintBundlesSearch(query, matched)
              : paintSettingsRows([...panel.children], query, matched);
    counts.set(panel.dataset.settingsGroup, hits);
  }
  paintSettingsTabCounts(counts, query);
  // A match in a tab the reader is not looking at is revealed: the first tab that answers is the one shown while
  // the query is on, and the reader's own tab (never written by the search) comes back when the box clears. The
  // Skills bar's own query is the exception: it was typed ON Skills, so the reader stays there and reads the
  // no-hit sentence rather than being thrown at whichever tab happens to answer a word they meant for a skill.
  const active = settingsTabButtons().find((tab) => tab.getAttribute("aria-selected") === "true");
  const first = [...counts].find(([, n]) => n > 0)?.[0] || null;
  if (!query) paintSettingsTab(settingsTabKey(), { save: false });
  else if (scope !== "skills" && first && (!active || !(counts.get(active.dataset.settingsTab) > 0))) {
    paintSettingsTab(first, { save: false });
  }
  const clear = document.getElementById(SETTINGS_SEARCH_CLEAR_ID);
  if (clear) clear.hidden = !query;
  paintSkillsSearchState(query, counts.get("skills") || 0);
  paintSettingsSearchHighlight(matched, query);
}

function paintSettingsSearchHighlight(rows, query) {
  const highlights = typeof CSS !== "undefined" && CSS ? CSS.highlights : null;
  const unsupported =
    !highlights ||
    typeof Highlight !== "function" ||
    typeof Range !== "function" ||
    typeof NodeFilter === "undefined" ||
    typeof document.createTreeWalker !== "function";
  if (unsupported) return; // the filter still works; only the marking is missing
  if (!query) {
    highlights.delete(SETTINGS_SEARCH_HIGHLIGHT);
    return;
  }
  const ranges = [];
  for (const row of rows) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = String(node.nodeValue || "").toLowerCase();
      for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) {
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + query.length);
        ranges.push(range);
      }
    }
  }
  if (!ranges.length) highlights.delete(SETTINGS_SEARCH_HIGHLIGHT);
  else highlights.set(SETTINGS_SEARCH_HIGHLIGHT, new Highlight(...ranges));
}

function clearSettingsSearch() {
  const box = document.getElementById(SETTINGS_SEARCH_ID);
  if (!box || !box.value) return;
  box.value = "";
  paintSettingsSearch();
}

function initSettingsSearch() {
  const box = document.getElementById(SETTINGS_SEARCH_ID);
  if (!box) return;
  box.addEventListener("input", () => paintSettingsSearch());
  box.addEventListener("search", () => paintSettingsSearch()); // the browser's own ✕ in a type=search box
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Esc in a box with something in it clears the search rather than closing the panel — the first Esc is about
    // what you typed, and stopPropagation keeps the page's own Esc handler (which closes Settings) out of it. On
    // an empty box this returns early and Esc closes the panel exactly as it always did.
    if (!box.value) return;
    e.preventDefault();
    e.stopPropagation();
    box.value = "";
    paintSettingsSearch();
  });
  const clear = document.getElementById(SETTINGS_SEARCH_CLEAR_ID);
  if (clear) {
    clear.addEventListener("click", () => {
      box.value = "";
      paintSettingsSearch();
      box.focus();
    });
  }
}

// ---- end settings search

// ---- the Skills tab -------------------------------------------------------------------------------------
// What an agent started from this panel can actually load, and where each of those skills came from. This tab is an
// INVENTORY, so every row is read-only — there is no switch, no editor and no delete, because a skill is a file in
// somebody's repository and a settings window is the wrong place to rewrite one. The shape is the answer to five
// facts that were each a trap:
//
//   * a skill has FOUR fields a reader needs and one of them is not a word: name, description, category, and the
//     PATH it was read from — the path is how "same name, different file" is settled by hand. The path is DRAWN
//     relative to the source that holds it (the base the heading above prints) and the whole absolute path rides in
//     the row's tooltip, so a long row reads as a skill instead of as a drive letter.
//   * a junctioned directory (`%LOCALAPPDATA%\hermes\skills\sefl` -> the team's own repo) is its OWN source. A
//     naive walk lists those skills under the profile as well, with nothing to say which copy a row is, so the
//     server hands over a source per link — with the target — and dedupes by realpath. The row says `link` when
//     the file it read was reached through one.
//   * the disk is only half the truth: the gateway's `GET /v1/skills` is what a run is actually SERVED (shadowing,
//     disabled names and platform gates resolved). A row the gateway does not serve says so; a name it serves that
//     no root carries — a plugin's `plugin:skill` — is its own row under Gateway; and a gateway that cannot answer
//     leaves every row UNKNOWN — one banner says why, and each row carries a quiet mark instead of the same word
//     stamped onto every skill in the list.
//   * the list has TWO levels of grouping — the source it was read from, then the category the skill's own
//     directory gives it — because that is the tree on disk and a flat list of ninety rows hides it. Both levels
//     fold, the count on every heading is the number of rows under it, and the fold the reader chooses is
//     remembered in this browser under `wtgui.skillsGroups`. A source starts OPEN; its categories start open only
//     while the source has six or fewer of them, so a team repo's twenty-five categories arrive folded.
//   * the settings search is global and it filters the DIRECT CHILDREN of a panel. A grouped list therefore paints
//     its own filter (`paintSkillsSearch`) and hands the same per-tab count back: a category that answers nothing
//     and a source that answers nothing are hidden, every heading's count is repainted against the filtered set,
//     and a group that DOES answer is opened for the duration of the query — a match must never be hidden behind a
//     fold the reader closed earlier.
const SKILLS_PANEL_ID = "settings-panel-skills";
// The tab's own search bar, and the ✕ beside it. This bar is a second CONTROL over the window search's one query
// (see paintSettingsSearch), never a second filter: it writes what it holds into #settings-search and repaints.
const SKILLS_SEARCH_ID = "skills-search";
const SKILLS_SEARCH_CLEAR_ID = "btn-skills-search-clear";
const SKILLS_GROUPS_KEY = "wtgui.skillsGroups";
// A source with more category groups than this starts with them CLOSED: a 25-category team repo is a wall of rows
// to scroll past before the next source, while six still reads as one screen.
const SKILLS_OPEN_CATEGORIES = 6;
const SKILLS_KIND_LABEL = {
  profile: "profile",
  link: "link",
  "create-dir": "create dir",
  external: "external",
  project: "project",
  gateway: "gateway",
};

let skillsIndex = null;
let skillsLoadedAt = 0;
let skillsLoading = null;

const skillsKind = (source) => SKILLS_KIND_LABEL[source.kind] || source.kind || "root";
const skillsMany = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- the fold state: one record in this browser, per source and per category ------------------------------
// `{ "<source key>": { open, cats: { "<category or empty>": open } } }`. A key that is absent means the reader
// never decided it, so the defaults below answer — a skill added tomorrow opens or closes with its own source
// instead of being stranded in whatever the last read happened to hold. A storage that cannot be read (private
// mode, a value written by an older build) is an empty record, never a crash.
function readSkillsFolds() {
  try {
    const raw = localStorage.getItem(SKILLS_GROUPS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveSkillsFolds(folds) {
  try {
    localStorage.setItem(SKILLS_GROUPS_KEY, JSON.stringify(folds));
  } catch {
    /* private mode: the fold just will not persist */
  }
}

const skillsFoldRecord = (folds, key) => (folds[key] && typeof folds[key] === "object" ? folds[key] : null);

// A source starts OPEN — it is the top level, and a reader looking for a source wants to see what it holds.
function skillsSourceOpen(folds, key) {
  const rec = skillsFoldRecord(folds, key);
  return !rec || rec.open !== false;
}

// Six or fewer category groups → open; more → closed. `count` is the number of groups the source will DRAW (the
// uncategorised bucket is one of them), because the threshold is about how much fits on a screen, not about how
// the directories happen to be named.
function skillsCategoryOpen(folds, key, category, count) {
  const rec = skillsFoldRecord(folds, key);
  const chosen = rec && rec.cats ? rec.cats[category || ""] : undefined;
  if (typeof chosen === "boolean") return chosen;
  return count <= SKILLS_OPEN_CATEGORIES;
}

function setSkillsFold(folds, key, category, open) {
  const rec = { ...(skillsFoldRecord(folds, key) || {}) };
  if (category === null) rec.open = open;
  else rec.cats = { ...(rec.cats || {}), [category]: open };
  folds[key] = rec;
  saveSkillsFolds(folds);
}

const skillsFoldTitle = (open, label) => `${open ? "collapse" : "expand"} ${label}`;

// ---- grouping -------------------------------------------------------------------------------------------
// The rows of one source, split by the category their own directory gives them ("" is the bucket for skills that
// sit at the top of the source; a gateway row keeps whatever category the gateway answered). The uncategorised
// bucket comes first, then categories A→Z case-insensitively, and each bucket is name-sorted the same way, so the
// same disk always reads the same list.
function skillsByName(rows) {
  return [...rows].sort(
    (a, b) =>
      String(a.name || "").toLowerCase().localeCompare(String(b.name || "").toLowerCase()) ||
      String(a.name || "").localeCompare(String(b.name || "")),
  );
}

function skillsCategories(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = row.category || "";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === "" || b === "") return a === b ? 0 : a === "" ? -1 : 1;
      return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
    })
    .map(([key, list]) => ({ key, label: key || "(no category)", rows: skillsByName(list) }));
}

// One skill: the identity line (name, the link and gateway marks) and the detail line under it (description, then
// the path RELATIVE to the source it came from). Both lines carry the same words in their `title`, so a search for
// a word in a description finds the row even though the description is drawn on the line below it — and that
// tooltip carries the whole absolute path, which is what settles "same name, different file" by hand.
function skillsRowHtml(skill) {
  const absolute = skill.path || "";
  const where = skill.rel || absolute || "no SKILL.md — the gateway serves this name and no root this panel reads carries it";
  const title = [
    skill.description || "(no description)",
    absolute ? `path: ${absolute}` : where,
    `source: ${skill.sourceLabel || skill.source}`,
  ]
    .concat(skill.category ? [`category: ${skill.category}`] : [])
    .join(" · ");
  const chips = [];
  if (skill.isLink) {
    chips.push(`<span class="skills-chip link" title="reached through a link — the source above names its target">link</span>`);
  }
  if (skill.served === false) {
    chips.push(
      `<span class="skills-chip unsent" title="the gateway does not serve this name: shadowed by a higher-precedence copy, disabled in the profile, gated to another platform, or quarantined by the project scan">not served</span>`,
    );
  }
  // The gateway did not answer: one quiet mark per row, and the ONE banner at the top of the tab explains it. The
  // word "unverified" is deliberately not repeated down the list — a row that cannot be judged must not out-shout
  // the rows that can.
  const unknown =
    skill.served === null
      ? `<span class="skills-mark" data-skills-mark="unknown" aria-hidden="true" title="the gateway did not answer, so whether this skill is served is unknown — the line at the top of this tab says why">?</span>`
      : "";
  const attrs =
    `data-skills-block="1" data-skill="${esc(skill.name)}" data-skills-source="${esc(skill.source)}" data-skills-cat="${esc(skill.category || "")}"`;
  return (
    `<div class="settings-row skills-skill" ${attrs} title="${esc(title)}">` +
    `<span class="skills-name">${esc(skill.name)}</span>${chips.join("")}${unknown}</div>` +
    `<div class="settings-preview mono skills-detail" ${attrs} title="${esc(title)}">` +
    `<span class="skills-desc">${esc(skill.description || "(no description)")}</span>` +
    `<span class="skills-path" title="${esc(absolute || title)}">${esc(where)}</span></div>`
  );
}

// One category inside a source: its own foldable heading and the skills under it.
function skillsCategoryHtml(source, cat, folds, count) {
  const open = skillsCategoryOpen(folds, source.key, cat.key, count);
  const label = `${cat.label} — ${skillsMany(cat.rows.length, "skill", "skills")}`;
  return (
    `<div class="skills-catgroup" data-skills-cat-group="${esc(cat.key)}">` +
    `<button type="button" class="skills-fold skills-fold-cat skills-cathead" data-skills-fold-source="${esc(source.key)}" data-skills-fold-cat="${esc(cat.key)}" data-skills-fold-label="${esc(label)}" aria-expanded="${open}" title="${esc(skillsFoldTitle(open, label))}">` +
    `<span class="skills-caret" aria-hidden="true"></span>` +
    `<span class="skills-cat-name">${esc(cat.label)}</span>` +
    `<span class="skills-cat-count mono">${cat.rows.length}</span></button>` +
    `<div class="skills-catbody" data-skills-body-source="${esc(source.key)}" data-skills-body-cat="${esc(cat.key)}"${open ? "" : " hidden"}>` +
    cat.rows.map(skillsRowHtml).join("") +
    `</div></div>`
  );
}

// One source: a foldable heading (label, kind when it says something the label does not, and the count of rows
// under it) and the line under it — the path it reads, the target when it is a link, or the reason it holds
// nothing. An unreadable source is a heading with a reason, never a silent gap. Its categories are the second
// level, and a source with no rows still says so instead of leaving an empty box under its heading.
function skillsSourceHtml(source, rows, folds) {
  const cats = skillsCategories(rows);
  const open = skillsSourceOpen(folds, source.key);
  const bits = [source.path];
  if (source.isLink && source.target) bits.push(`→ ${source.target}`);
  if (source.status !== "ok" && source.reason) bits.push(`— ${source.reason}`);
  const where = bits.filter(Boolean).join(" ");
  const bad = source.status === "error" || source.status === "missing" || source.status === "ignored";
  // The kind is a chip only when it says something the label does not: "Profile · PROFILE" is noise, while
  // "sefl · LINK" is the whole point of the source.
  const kind = skillsKind(source);
  const kindChip = kind.toLowerCase() === String(source.label || "").toLowerCase() ? "" : `<span class="skills-chip kind">${esc(kind)}</span>`;
  const label = `${source.label || source.key} — ${skillsMany(rows.length, "skill", "skills")}${where ? ` · ${where}` : ""}`;
  const body = cats.length
    ? cats.map((cat) => skillsCategoryHtml(source, cat, folds, cats.length)).join("")
    : `<div class="skills-empty">no skill is read from here</div>`;
  return (
    `<div class="skills-srcgroup" data-skills-block="1" data-skills-source-group="${esc(source.key)}">` +
    `<button type="button" class="skills-fold skills-fold-source skills-source${rows.length ? "" : " empty"}" data-skills-fold-source="${esc(source.key)}" data-skills-fold-label="${esc(label)}" aria-expanded="${open}" title="${esc(skillsFoldTitle(open, label))}">` +
    `<span class="skills-caret" aria-hidden="true"></span>` +
    `<span class="skills-source-name">${esc(source.label)}</span>` +
    kindChip +
    `<span class="skills-source-count mono">${rows.length}</span></button>` +
    `<div class="settings-preview mono skills-source-path${bad ? " bad" : ""}" title="${esc(where)}">${esc(where)}</div>` +
    `<div class="skills-srcbody" data-skills-body-source="${esc(source.key)}"${open ? "" : " hidden"}>${body}</div>` +
    `</div>`
  );
}

// One delegated press for every heading: the headings are drawn again on every read, so a listener per heading
// would be a listener per paint. What it writes is the reader's own choice, in this browser.
function initSkillsGroups() {
  const panel = document.getElementById(SKILLS_PANEL_ID);
  if (!panel || panel.dataset.skillsFoldWired === "1") return;
  panel.dataset.skillsFoldWired = "1";
  panel.addEventListener("click", (e) => {
    const head = e.target.closest ? e.target.closest("[data-skills-fold-source]") : null;
    if (!head || head.tagName !== "BUTTON" || !panel.contains(head)) return;
    const key = head.dataset.skillsFoldSource;
    const isCategory = head.hasAttribute("data-skills-fold-cat");
    const category = isCategory ? head.dataset.skillsFoldCat : null;
    const scope = head.closest(isCategory ? ".skills-catgroup" : ".skills-srcgroup");
    const body = isCategory ? scope?.querySelector("[data-skills-body-cat]") : scope?.querySelector(".skills-srcbody");
    const folds = readSkillsFolds();
    const next = head.getAttribute("aria-expanded") !== "true";
    setSkillsFold(folds, key, category, next);
    applySkillsFold(head, body, next);
  });
}

const skillsSetCount = (scope, selector, n) => {
  const node = scope ? scope.querySelector(selector) : null;
  if (node) node.textContent = String(n);
};

// The Skills panel's own filter. The global search walks a panel's DIRECT children and this list is two levels
// deep, so it gets this painter and the same per-tab count comes back. Every heading's count is repainted against
// the filtered set, a group that answers nothing is hidden outright, and a group that does answer is opened for the
// duration of the query — then the reader's own fold choices are put back when the box clears.
function paintSkillsSearch(query, matched) {
  const panel = document.getElementById(SKILLS_PANEL_ID);
  if (!panel) return 0;
  // The bar and the no-hit line are the tab's CHROME, not rows: the bar must stay on screen while a query is on, so
  // it is never handed to the row walk that would hide it as "part of a row that did not answer".
  const flat = [...panel.children].filter(
    (node) => !node.classList || (!node.classList.contains("skills-srcgroup") && !node.dataset?.skillsChrome),
  );
  let hits = paintSettingsRows(flat, query, matched);
  const folds = readSkillsFolds();
  for (const group of panel.querySelectorAll(".skills-srcgroup")) {
    const key = group.dataset.skillsSourceGroup;
    const cats = [...group.querySelectorAll(".skills-catgroup")];
    let sourceHits = 0;
    for (const cat of cats) {
      const catBody = cat.querySelector("[data-skills-body-cat]");
      const catHits = paintSettingsRows(catBody ? [...catBody.children] : [], query, matched);
      sourceHits += catHits;
      skillsSetCount(cat, ".skills-cat-count", catHits);
      cat.classList.toggle("search-hidden", Boolean(query) && !catHits);
      const open = query ? catHits > 0 : skillsCategoryOpen(folds, key, cat.dataset.skillsCatGroup, cats.length);
      applySkillsFold(cat.querySelector(".skills-cathead"), catBody, open);
    }
    skillsSetCount(group, ".skills-source-count", sourceHits);
    group.classList.toggle("search-hidden", Boolean(query) && !sourceHits);
    const open = query ? sourceHits > 0 : skillsSourceOpen(folds, key);
    applySkillsFold(group.querySelector(".skills-source"), group.querySelector(".skills-srcbody"), open);
    hits += sourceHits;
  }
  return hits;
}

// A query with no answer is a SENTENCE, not an empty list under the folds: it says what was typed, where the filter
// looked, and - before the inventory has answered - that nothing has been checked yet. This is the Skills tab's one
// write in response to a query (the search region itself only toggles classes), and it is a plain line under the
// bar so the words are where the reader is looking.
function paintSkillsNoHits(query, hits) {
  const none = document.getElementById("skills-no-hits");
  if (!none) return;
  none.hidden = !query || hits > 0;
  if (none.hidden) {
    none.textContent = "";
    return;
  }
  none.textContent = skillsIndex
    ? `no skill matches "${query}" - the filter reads skill names and descriptions, and the category and path each row shows`
    : `the skills list is still being read - "${query}" has not been checked against it yet`;
}

// Ctrl+Shift+S lands here (public/assistant.js owns the chord): the general Settings surface, on the Skills tab,
// with the caret in the tab's own bar. The window opens when it is closed and the tab is taken when the window is
// already on another one - the same press a reader makes on the tab, so the choice is remembered like any other.
function focusSkillsSearch() {
  const panel = document.getElementById("settings");
  if (!panel) return false;
  if (panel.classList.contains("hidden")) toggleSettings(true);
  const selected = settingsTabButtons().find((tab) => tab.getAttribute("aria-selected") === "true");
  if (!selected || selected.dataset.settingsTab !== "skills") selectSettingsTab("skills");
  const bar = document.getElementById(SKILLS_SEARCH_ID);
  if (!bar) return false;
  bar.focus();
  // The caret goes to the END of whatever the one filter already holds: the chord is how a reader gets to the bar,
  // and Esc - not a keystroke they did not mean - is what empties it.
  try {
    bar.setSelectionRange(bar.value.length, bar.value.length);
  } catch {
    /* a host that refuses the range still has the focus, which is the ask */
  }
  return true;
}

// The bar's one listener set, wired once at boot. Typing writes the ONE query into the window's head box and
// repaints through the one painter, so the two controls cannot disagree; Escape clears both and leaves the caret
// where it is, because dismissing a filter is not dismissing the window.
function initSkillsSearch() {
  const bar = document.getElementById(SKILLS_SEARCH_ID);
  if (!bar || bar.dataset.skillsSearchWired === "1") return;
  bar.dataset.skillsSearchWired = "1";
  const repaint = () => {
    const box = document.getElementById(SETTINGS_SEARCH_ID);
    if (box && box.value !== bar.value) box.value = bar.value;
    paintSettingsSearch({ scope: "skills" });
  };
  const clearBar = () => {
    bar.value = "";
    const box = document.getElementById(SETTINGS_SEARCH_ID);
    if (box) box.value = "";
    paintSettingsSearch({ scope: "skills" });
    bar.focus();
  };
  bar.addEventListener("input", repaint);
  bar.addEventListener("search", repaint); // the browser's own ✕ in a type=search box
  bar.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // An empty bar is not a filter: the page's own Esc (which closes Settings) is the reader's to use, exactly as it
    // is on the window's search box. With text in it, the first Esc is about what was typed - clear, stay, keep the
    // caret here - and stopPropagation keeps that Esc from also closing the window behind it.
    if (!bar.value) return;
    e.preventDefault();
    e.stopPropagation();
    clearBar();
  });
  const clear = document.getElementById(SKILLS_SEARCH_CLEAR_ID);
  clear?.addEventListener("click", (e) => {
    e.preventDefault();
    clearBar();
  });
}

// The whole tab, from one payload. Called on boot and whenever the panel opens on a stale read; a failure says why
// in the summary line instead of leaving `reading…` up for ever.
function paintSkills(error = null) {
  const panel = document.getElementById(SKILLS_PANEL_ID);
  if (!panel) return;
  for (const node of [...panel.querySelectorAll("[data-skills-block]")]) node.remove();
  const summary = document.getElementById("skills-summary");
  const gateway = document.getElementById("skills-gateway");
  const data = skillsIndex;
  if (error || !data) {
    if (summary) summary.textContent = `could not read the skills — ${error || "no answer"}`;
    if (gateway) {
      gateway.textContent = "nothing was read, so this tab knows nothing about the gateway either";
      gateway.title = gateway.textContent;
      gateway.classList.add("bad");
    }
    return;
  }
  const counts = data.counts || {};
  const bits = [skillsMany(counts.rows || 0, "skill", "skills"), skillsMany(counts.sources || 0, "source", "sources")];
  if (counts.duplicates) bits.push(`${skillsMany(counts.duplicates, "duplicate copy", "duplicate copies")} skipped`);
  bits.push(data.gateway?.ok ? `${counts.served || 0} served` : `${counts.rows || 0} unverified`);
  if (data.gateway?.ok && counts.unserved) bits.push(`${counts.unserved} not served`);
  if (data.gateway?.ok && counts.gatewayOnly) bits.push(`${counts.gatewayOnly} gateway-only`);
  if (summary) summary.textContent = bits.join(" · ");
  if (gateway) {
    const ok = Boolean(data.gateway?.ok);
    // ONE line, whatever the answer: the gateway's own words are the reason a run's served set is unknown, and the
    // rows below carry only a quiet mark — no row repeats the banner in its own words.
    gateway.textContent = ok
      ? `${data.gateway.url} · /v1/skills answers ${data.gateway.count} skills · read ${new Date(data.checkedAt).toLocaleTimeString()}`
      : `gateway ${data.gateway?.url || "(none)"} · ${data.gateway?.reason || "no answer"} — no row below can be said to be served`;
    gateway.title = gateway.textContent;
    gateway.classList.toggle("bad", !ok);
  }
  const folds = readSkillsFolds();
  let html = "";
  for (const source of data.sources || []) {
    const rows = (data.skills || []).filter((s) => s.source === source.key);
    html += skillsSourceHtml(source, rows, folds);
  }
  const served = (data.skills || []).filter((s) => s.source === "gateway");
  if (served.length) {
    html += skillsSourceHtml(
      {
        key: "gateway",
        label: "Gateway",
        kind: "gateway",
        path: data.gateway?.url || "",
        status: "ok",
        target: null,
        isLink: false,
      },
      served,
      folds,
    );
  }
  panel.insertAdjacentHTML("beforeend", html);
  initSkillsGroups();
  // A query typed before this answer landed must still hide what it does not match: the new rows are in the DOM
  // now, and the search paints from the DOM rather than from a cached list.
  const box = document.getElementById("settings-search");
  if (box && box.value) paintSettingsSearch();
}

async function loadSkills() {
  if (skillsLoading) return skillsLoading;
  skillsLoading = (async () => {
    try {
      const r = await apiFetch("/api/settings/skills");
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      skillsIndex = data;
      skillsLoadedAt = Date.now();
      paintSkills();
    } catch (e) {
      paintSkills(e.message || String(e));
    } finally {
      skillsLoading = null;
    }
  })();
  return skillsLoading;
}

// ---- Permissions tab -----------------------------------------------------------------------------
// Read-only: the server parses config.yaml and asks the gateway when this tab is read, and this side
// only draws the answer. Every row prints the file:line (or endpoint) it came from; a source that
// could not be read prints its reason in place of rows, never a guessed value. The search treats this
// list like the Skills one — its rows are two levels deep, so it paints its own filter and hands the
// same per-tab count back.
const PERMISSIONS_PANEL_ID = "settings-panel-permissions";
let permissionsIndex = null;
let permissionsLoadedAt = 0;
let permissionsLoading = null;

const permissionsRows = (source) => (Array.isArray(source && source.rows) ? source.rows : []);
const permissionsBad = (source) => Boolean(source) && source.status !== "ok";

function permissionStatusText(source) {
  if (!source) return "no answer";
  if (source.status === "ok") return "read";
  if (source.status === "missing") return "not in the file";
  if (source.status === "malformed") return "cannot read — malformed";
  if (source.status === "unauthorized") return "not exposed, needs a token";
  if (source.status === "unreachable") return "cannot reach";
  return "cannot read";
}

function permissionsGroupHtml(source) {
  const rows = permissionsRows(source);
  const bad = permissionsBad(source);
  const where = source.source || source.file || source.endpoint || "(no source)";
  const title = [source.label, where, source.reason || ""].filter(Boolean).join(" · ");
  let html =
    `<div class="perm-group" data-permissions-group="${esc(source.key)}" data-permissions-block="1">` +
    `<div class="settings-row perm-head" title="${esc(title)}">` +
    `<span class="perm-label">${esc(source.label || source.key)}</span>` +
    `<span class="perm-status mono${bad ? " bad" : ""}">${esc(permissionStatusText(source))}</span>` +
    `<span class="perm-source mono" title="${esc(where)}">${esc(where)}</span>` +
    `</div>`;
  if (bad) {
    html += `<div class="settings-preview mono perm-note bad" title="${esc(source.reason || "")}">${esc(source.reason || "this source could not be read")}</div>`;
  } else if (!rows.length) {
    html += `<div class="settings-preview mono perm-note">the source is present and holds no rows</div>`;
  } else {
    html += `<div class="perm-rows">`;
    for (const row of rows) {
      const src = row.source || where;
      html +=
        `<div class="settings-row perm-row" data-permissions-row="1" data-permissions-group="${esc(source.key)}" title="${esc(`${row.name}: ${row.value} · ${src}`)}">` +
        `<span class="perm-name mono">${esc(row.name)}</span>` +
        `<span class="perm-value mono">${esc(row.value)}</span>` +
        `<span class="perm-source mono" title="${esc(src)}">${esc(src)}</span>` +
        `</div>`;
    }
    html += `</div>`;
  }
  return `${html}</div>`;
}

// The whole tab, from one payload. A failure says why in the summary line instead of leaving
// `reading…` up for ever; a source that answered still draws its rows beside one that did not.
function paintPermissions(error = null) {
  const panel = document.getElementById(PERMISSIONS_PANEL_ID);
  if (!panel) return;
  for (const node of [...panel.querySelectorAll("[data-permissions-block]")]) node.remove();
  const summary = document.getElementById("permissions-summary");
  const config = document.getElementById("permissions-config");
  const data = permissionsIndex;
  if (error || !data) {
    if (summary) summary.textContent = `could not read the permissions — ${error || "no answer"}`;
    if (config) {
      config.textContent = "nothing was read, so this tab knows nothing about config.yaml or the gateway either";
      config.title = config.textContent;
      config.classList.add("bad");
    }
    return;
  }
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const counts = data.counts || {};
  const read = sources.filter((source) => source.status === "ok").length;
  const bits = [`${read}/${sources.length} sources read`, `${counts.rows || 0} rows`];
  if (counts.unreadable) bits.push(`${counts.unreadable} cannot be read`);
  if (summary) summary.textContent = bits.join(" · ");
  if (config) {
    const ok = data.configFile?.status === "ok";
    config.textContent = ok
      ? `${data.configFile.path} · read ${new Date(data.checkedAt).toLocaleTimeString()}`
      : `config.yaml · ${data.configFile?.reason || "could not be read"}`;
    config.title = config.textContent;
    config.classList.toggle("bad", !ok);
  }
  const list = document.getElementById("permissions-list");
  if (list) list.insertAdjacentHTML("beforeend", sources.map(permissionsGroupHtml).join(""));
  // A query typed before this answer landed must still hide what it does not match.
  const box = document.getElementById("settings-search");
  if (box && box.value) paintSettingsSearch();
}

// The Permissions list's own filter: the global search walks a panel's DIRECT children and this list
// is grouped, so every source heading and every permission row is matched here and the same per-tab
// count goes back. A group that answers nothing is hidden; a heading that answers alone still shows
// its (unmatched) rows, because the heading's tooltip names the source a reader was looking for.
function paintPermissionsSearch(query, matched) {
  const panel = document.getElementById(PERMISSIONS_PANEL_ID);
  if (!panel) return 0;
  const flat = [...panel.children].filter((node) => node.id !== "permissions-list");
  let hits = paintSettingsRows(flat, query, matched);
  for (const group of panel.querySelectorAll(".perm-group[data-permissions-group]")) {
    const head = group.querySelector(".perm-head");
    const rows = [...group.querySelectorAll("[data-permissions-row]")];
    let groupHits = 0;
    for (const row of rows) {
      const hit = !query || settingsRowText(row).includes(query);
      row.classList.toggle("search-hidden", !hit);
      if (hit) {
        groupHits += 1;
        if (query) matched.push(row);
      }
    }
    const headHit = !query || (head && settingsRowText(head).includes(query));
    if (query && headHit && head) matched.push(head);
    group.classList.toggle("search-hidden", Boolean(query) && !groupHits && !headHit);
    hits += groupHits || (query && headHit ? 1 : 0);
  }
  return hits;
}

async function loadPermissions() {
  if (permissionsLoading) return permissionsLoading;
  permissionsLoading = (async () => {
    try {
      const r = await apiFetch("/api/settings/permissions");
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      permissionsIndex = data;
      permissionsLoadedAt = Date.now();
      paintPermissions();
    } catch (e) {
      paintPermissions(e.message || String(e));
    } finally {
      permissionsLoading = null;
    }
  })();
  return permissionsLoading;
}

// ---- settings > pipeline -------------------------------------------------------------------------
// The Pipeline tab's whole surface: the catalogue the panel holds (the reader's pipelines.json merged per id over
// pipelines.seed.json), one definition opened for editing, and the validation the server does before a save. It
// follows the Permissions tab's shape — read on demand, paint from the answer — with one rule the brief names: an
// open editor with unsaved changes is NOT repainted. A repaint that replaced the form would take the caret and the
// half-typed sentence with it, so paintPipelines() refreshes the list and the summary and leaves the editor alone
// while `pipelineDraftDirty` is true; save and reload are the only ways out of a dirty draft. Every input event
// marks the draft dirty, so a keystroke can never arrive at a form a repaint is about to replace.
//
// The stage SEQUENCE is the one part of a dirty form that cannot be left alone. Add and remove are presses on the
// editor's own buttons, and the rows they change are not text the reader is typing: a form still drawing the old
// rows disagrees with the draft Save will write, and the next keystroke's updateDraftFromForm() would read those
// stale rows back — resurrecting a removed stage, or dropping a new one. So add and remove repaint `#pipeline-stages`
// alone (paintPipelineStages), from the draft, and that paint is caret-safe: the focused field's stage, class,
// selection and scroll are captured before the rows are replaced and put back after, so the guard above still holds
// for a reader who is mid-sentence in a stage field.
const PIPELINE_PANEL_ID = "settings-panel-pipeline";
let pipelinesIndex = null;
let pipelinesLoadedAt = 0;
let pipelinesLoading = null;
let pipelineOpenId = null;
let pipelineDraft = null;
let pipelineDraftDirty = false;
let pipelineFindings = [];
// The closed vocabulary the exit select offers. It is read from the last answer rather than written here, so a
// check added to lib/pipelines.js reaches the tab without a second copy going stale.
let pipelineExitChecks = [];
// The PDL pipeline the dropdown names, when the reader picked one. The bundle's pipelines are a different object from
// the ladder (a ladder rung says what a tree may do with a branch; a PDL pipeline says which stages a task runs), so
// the tab keeps one selection of each: `pipelineOpenId` is the ladder being edited, this is the PDL pipeline being
// looked at. Both are offered by the one dropdown, PDL first, and only one of them is ever set.
let pipelinePdlId = null;

// The PDL pipelines this panel holds, from the same `pdl` block the queue's picker reads (lib/pipeline-source.js).
// A refused or missing bundle is [] here: the list above the dropdown already prints the loader's own reason, and a
// control that offered a pipeline the file does not hold would be the second answer this tab exists to remove.
function pdlPipelines() {
  const pdl = pipelinesIndex && pipelinesIndex.pdl;
  return pdl && pdl.ok === true && Array.isArray(pdl.pipelines) ? pdl.pipelines : [];
}

function selectedPdlPipeline() {
  if (!pipelinePdlId) return null;
  return pdlPipelines().find((p) => p.id === pipelinePdlId) || null;
}

// The PDL selection's own sentence. The editor's status element is built INSIDE the ladder editor
// (paintPipelineEditor), and a PDL pipeline closes that editor, so a note about a PDL selection needs its own row.
function setPipelinePdlNote(text = "") {
  const el = document.getElementById("pipeline-pdl-pick");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}

function pdlPickNote(pdl) {
  const stages = Array.isArray(pdl.stages) ? pdl.stages.length : 0;
  const gates = Array.isArray(pdl.gates) ? pdl.gates.length : 0;
  const handoffs = Array.isArray(pdl.handoffs) ? pdl.handoffs.length : 0;
  return `PDL pipeline "${pdl.id}" — read-only here: ${stages} stage${stages === 1 ? "" : "s"}, ${gates} gate${gates === 1 ? "" : "s"}, ${handoffs} handoff${handoffs === 1 ? "" : "s"}. Open the flow to draw it.`;
}

// The map page draws a document it is handed. With a PDL pipeline selected it is handed this panel's own catalogue
// route, so the page draws the pipelines this install actually holds (config.pipelineBundleFile) rather than the
// shipped seed; with a ladder selected it stays the generated library page. Called from the paint AND from the press,
// because the link's target follows the selection, not the last read.
function paintPipelineMapLink() {
  const mapLink = document.getElementById("pipeline-map-open");
  if (!mapLink) return;
  mapLink.href = pipelinePdlId ? "/pipeline-map.html?doc=/api/assistant/pipeline-catalogue" : "/pipeline-map.html";
  mapLink.title = pipelinePdlId
    ? "open the map in a new tab — it reads this panel's PDL catalogue and draws every pipeline in it, each stage's artifact, gate and handoff with it"
    : "open the map in a new tab — every definition and every bundle pipeline on one page, each stage's role and exit check with it";
}

// The option's words: the tag first, because the two lists are one dropdown and the reader has to be able to tell
// which kind of pipeline they are about to look at before they pick it.
function pdlOptionLabel(pipeline) {
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages.length : 0;
  return `PDL · ${pipeline.id} — ${pipeline.title || pipeline.id} (${stages} stage${stages === 1 ? "" : "s"})`;
}

async function loadPipelines() {
  if (pipelinesLoading) return pipelinesLoading;
  pipelinesLoading = (async () => {
    try {
      const r = await apiFetch("/api/pipelines");
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      pipelinesIndex = data;
      pipelinesLoadedAt = Date.now();
      paintPipelines();
    } catch (e) {
      paintPipelines(e.message || String(e));
    } finally {
      pipelinesLoading = null;
    }
  })();
  return pipelinesLoading;
}

// The tab's ONE selector: a dropdown of the definitions the catalogue holds, the editor for the one it names, and the
// button that draws that definition's flow (public/pipeline-flow.js + public/pipeline-modal.js, in edit mode). The
// list of rows this replaces was a second way to say "which pipeline"; a dropdown says it once, and the summary above
// still carries the counts and the file the catalogue was read from.
//
// A definition the loader dropped is named under the dropdown with its reason, not hidden: a pipeline missing from a
// select must say why it is missing. The dropped row is still a settings row, so the tab's own search finds it.
function pipelineDroppedHtml(def) {
  const why = String(def.why || "");
  return `<div class="settings-row pipeline-row bad" data-pipeline-row="${esc(def.id)}" title="${esc(why)}"><span>dropped: <span class="mono">${esc(def.id)}</span></span><span class="settings-unit mono">${esc(why)}</span></div>`;
}

function pipelineOptionLabel(def) {
  const stages = Array.isArray(def.stages) ? def.stages.length : 0;
  return `${def.id} — ${def.title || def.id} (${def.kind || "?"}, ${stages} stage${stages === 1 ? "" : "s"})`;
}

// The pipelines a TASK runs on: the PDL bundle's list, carried by this same route as `pdl` and read by
// lib/pipeline-source.js - the module the queue's task pipeline window and the queue picker read. It is drawn here,
// beside the ladder, because the two are one click apart in the reader's mind and were two different sets of
// "pipelines" on two different tabs. The list is the ROUTE's, never a second parse: a bundle that is missing or
// refused is printed with the loader's own code and locator, and the ladder above is never blamed for it.
function pdlPipelineRowHtml(pipeline) {
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages.length : 0;
  const isolation = pipeline.isolation === "per-stage" ? "one tree per stage" : "one tree";
  const title = `${pipeline.title || pipeline.id} — ${stages} stage${stages === 1 ? "" : "s"}, ${isolation}. This is the pipeline a task is put on: open a queue task's pipeline window to see its stages in order and choose one.`;
  return `<div class="settings-row" data-pdl-pipeline="${esc(pipeline.id)}" title="${esc(title)}">
      <span><strong>${esc(pipeline.title || pipeline.id)}</strong> <span class="mono">${esc(pipeline.id)}</span></span>
      <span class="settings-unit mono">${stages} stage${stages === 1 ? "" : "s"}</span>
    </div>`;
}

function paintPdlPipelines(pdl, error = null) {
  const summary = document.getElementById("pipeline-pdl-summary");
  const source = document.getElementById("pipeline-pdl-source");
  const list = document.getElementById("pipeline-pdl-list");
  if (!summary || !list) return;
  summary.classList.remove("bad");
  if (source) source.classList.remove("bad");
  const answer = !error && pdl && typeof pdl === "object" ? pdl : null;
  // The repair control lives on this row and is offered for ONE state: the loader read the file and refused it. A
  // read that never answered (a dead route) has nothing to replace, and a bundle that loaded needs no repair — so a
  // press that would either guess or overwrite a readable file is not shown at all.
  const repair = document.getElementById("pipeline-pdl-repair");
  const refused = Boolean(answer) && answer.ok !== true;
  if (repair) {
    repair.hidden = !refused;
    repair.disabled = false;
    repair.title = refused
      ? `import the bundle this checkout ships (pipeline-bundle.seed.json) over ${answer.file || "the refused bundle"} — the import replaces a bundle the loader cannot read instead of merging into it, and this tab re-reads when it lands`
      : "import the bundle this checkout ships over a refused one";
  }
  if (!answer) {
    summary.textContent = error ? `could not read the PDL bundle — ${error}` : "no PDL bundle was read by this answer";
    summary.classList.add("bad");
    if (source) {
      source.textContent = "nothing was read, so this tab cannot say which pipelines a task can be put on";
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = "";
    return;
  }
  const pipelines = Array.isArray(answer.pipelines) ? answer.pipelines : [];
  if (answer.ok !== true) {
    summary.textContent = `refused — ${answer.code || "the bundle was refused"}`;
    summary.classList.add("bad");
    if (source) {
      source.textContent = `${answer.file || "the PDL bundle"} — ${answer.reason || "the loader refused it"}`;
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = "";
    return;
  }
  const total = pipelines.reduce((n, p) => n + (Array.isArray(p.stages) ? p.stages.length : 0), 0);
  summary.textContent = `${pipelines.length} pipeline${pipelines.length === 1 ? "" : "s"} · ${total} stage${total === 1 ? "" : "s"}${answer.name ? ` · ${answer.name}` : ""}`;
  if (source) {
    source.textContent = `${answer.file || "the PDL bundle"} · the list the queue's pipeline window offers`;
    source.title = source.textContent;
  }
  list.innerHTML = pipelines.length
    ? pipelines.map(pdlPipelineRowHtml).join("")
    : `<div class="settings-row"><span>this bundle holds no pipeline — a task can only be put on the assistant's default path</span></div>`;
}

// The repair the refused state needs. The live bundle is only ever replaced by the import — PR #566 gave planImport
// the repair path, where a document that loads REPLACES a live file the loader cannot read instead of being refused
// as `live-bundle-unreadable`. The seed this checkout ships is that document, and the route reads it: the page does
// not carry 127 KB of JSON, and it does not name a path the browser would have to know. Nothing here writes when the
// seed or the live file is fine: the route's own plan decides, and its refusal is printed in its own words.
//
// The tab re-reads AFTER the write lands (`pipelinesLoadedAt = 0`, then loadPipelines) — a note saying "repaired"
// beside a dropdown that still offers nothing would be the same dead end the control exists to end.
async function repairPipelineBundle() {
  const btn = document.getElementById("pipeline-pdl-repair");
  const note = document.getElementById("pipeline-pdl-repair-note");
  const say = (message, bad = false) => {
    if (!note) return;
    note.hidden = !message;
    note.textContent = message || "";
    note.classList.toggle("bad", Boolean(message) && bad);
  };
  if (btn) btn.disabled = true;
  say("importing pipeline-bundle.seed.json over the refused bundle…");
  try {
    const r = await apiFetch("/api/assistant/pipeline-bundle/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed: true }),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.ok !== true) {
      const code = body && body.code ? ` (${body.code})` : "";
      say(`the repair was refused — ${(body && body.error) || `the panel answered ${r.status}`}${code}`, true);
      return null;
    }
    say(body.reason || "the bundle was repaired from the seed");
    // The dropdown and the list above are a read of the file the write just changed, so the cached answer is stale.
    pipelinesLoadedAt = 0;
    await loadPipelines();
    return body;
  } catch (e) {
    say(`the repair failed — ${(e && e.message) || e}`, true);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function paintPipelines(error = null) {
  const summary = document.getElementById("pipeline-summary");
  const source = document.getElementById("pipeline-source");
  const list = document.getElementById("pipeline-list");
  const pick = document.getElementById("pipeline-select");
  if (!summary || !list) return;
  const data = pipelinesIndex;
  if (error || !data) {
    summary.textContent = `could not read the pipelines — ${error || "no answer"}`;
    summary.classList.add("bad");
    if (source) {
      source.textContent = "nothing was read, so this tab knows nothing about the catalogue";
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = "";
    if (pick) {
      pick.innerHTML = `<option value="">(no catalogue)</option>`;
      pick.disabled = true;
    }
    // The PDL list has nothing to draw from a failed read either, and saying so is better than leaving the last
    // paint's rows on screen beside a refusal.
    paintPdlPipelines(null, error || "no answer");
    return;
  }
  summary.classList.remove("bad");
  const pipelines = data.pipelines || {};
  const ids = Object.keys(pipelines);
  // The count a reader takes as "how many pipelines does this panel hold" is the PDL catalogue's, and it is read
  // through `data.pdl` — the route's `pipelineSourceCatalogue(config)`, i.e. lib/pipeline-source.js's ONE
  // readPipelineSource, the same list the queue's assignment control offers. The ladder ships empty (pipelines.seed.json
  // holds no definition), so counting only the ladder said "0 definitions" to an install carrying eleven pipelines.
  // The ladder's own count is kept beside it, because a reader who edits one still needs to know how many there are.
  const pdlNow = pdlPipelines();
  const bits = [`${pdlNow.length} pipeline${pdlNow.length === 1 ? "" : "s"}`];
  bits.push(`${ids.length} definition${ids.length === 1 ? "" : "s"}`);
  if (data.readOnly) bits.push("read-only");
  if (data.refused) bits.push("refused whole");
  if (Array.isArray(data.dropped) && data.dropped.length) bits.push(`${data.dropped.length} dropped`);
  summary.textContent = bits.join(" · ");
  if (source) {
    source.textContent = data.refused
      ? `${data.file || "pipelines.json"} refused — ${data.refused.why || "the seed is in force read-only"}`
      : `${data.file || "pipelines.json"} over ${data.seedFile || "pipelines.seed.json"} · version ${data.version ?? "?"} (this panel reads ${data.supported})`;
    source.title = source.textContent;
    source.classList.toggle("bad", Boolean(data.refused));
  }
  pipelineExitChecks = Array.isArray(data.exitChecks) ? data.exitChecks : pipelineExitChecks;
  // The other half of "the pipelines this panel holds": the PDL bundle, drawn from this route's own `pdl` block.
  paintPdlPipelines(data.pdl);
  // The dropdown, and the definition it names. The open one is kept while it is still in the catalogue; when nothing
  // is open (or what was open was dropped) the first definition is selected, because the tab's job is to edit ONE.
  // The dropdown is ONE control over two lists: the PDL pipelines a task runs on, tagged PDL and first, then the
  // built-in ladders this tab edits. A PDL pipeline the bundle no longer holds is dropped from the selection, so the
  // control can never name a pipeline the file does not carry.
  const pdlList = pdlPipelines();
  if (pipelinePdlId && !pdlList.some((p) => p.id === pipelinePdlId)) pipelinePdlId = null;
  const wanted = pipelineOpenId && pipelines[pipelineOpenId] ? pipelineOpenId : ids[0] || "";
  // Nothing open and nothing picked: the control's value is the FIRST pipeline a task runs on, so a tab whose ladder
  // ships empty opens on a real pipeline (and its flow button works) rather than on a blank select. A ladder definition
  // still wins when there is one, because that is the half of this tab the reader can edit.
  if (!pipelinePdlId && !wanted && pdlList.length) pipelinePdlId = pdlList[0].id;
  if (pick) {
    const pdlOptions = pdlList.length
      ? `<optgroup label="PDL pipelines">${pdlList.map((p) => `<option value="pdl:${esc(p.id)}"${p.id === pipelinePdlId ? " selected" : ""}>${esc(pdlOptionLabel(p))}</option>`).join("")}</optgroup>`
      : "";
    const ladderOptions = ids.length
      ? `<optgroup label="built-in ladders">${ids.map((id) => `<option value="${esc(id)}"${!pipelinePdlId && id === wanted ? " selected" : ""}>${esc(pipelineOptionLabel(pipelines[id]))}</option>`).join("")}</optgroup>`
      : "";
    pick.innerHTML = pdlOptions + ladderOptions || `<option value="">(no pipeline is in force)</option>`;
    pick.disabled = !pdlList.length && !ids.length;
    const value = pipelinePdlId ? `pdl:${pipelinePdlId}` : wanted;
    if (pick.value !== value) pick.value = value;
  }
  const flowBtn = document.getElementById("pipeline-flow-open");
  if (flowBtn) {
    flowBtn.disabled = !(pipelinePdlId || wanted);
    flowBtn.title = pipelinePdlId
      ? "open the flow — this PDL pipeline's stages left to right, with its gates on the connectors and its handoffs as the dashed loops. Read-only: nothing here runs a stage."
      : "open the flow — every stage of this definition left to right, with its exit checks as notches on the connectors. A definition has no position, so every stage is drawn not reached.";
  }
  paintPipelineMapLink();
  list.innerHTML = (data.dropped || []).map(pipelineDroppedHtml).join("") || (ids.length || pdlList.length ? "" : `<div class="settings-row"><span>no pipeline is in force — the catalogue is empty</span></div>`);
  // A dirty draft is never replaced: the list may repaint as often as it likes, and the form keeps the reader's text.
  if (!pipelineDraftDirty) {
    if (pipelinePdlId) {
      // A PDL pipeline is not a ladder: the editor edits ladders, so it is closed and the status says what is drawn.
      if (pipelineOpenId) closePipelineEditor();
    } else if (wanted && (pipelineOpenId !== wanted || !pipelineDraft)) {
      pipelineOpenId = wanted;
      pipelineDraft = JSON.parse(JSON.stringify(pipelines[wanted]));
      paintPipelineEditor();
    } else if (wanted && pipelineDraft) {
      pipelineDraft = JSON.parse(JSON.stringify(pipelines[wanted]));
      paintPipelineEditor();
    } else if (!wanted) {
      closePipelineEditor();
    }
  }
  // The PDL selection's note follows the selection, including across a repaint that kept it.
  setPipelinePdlNote(pipelinePdlId ? pdlPickNote(selectedPdlPipeline() || { id: pipelinePdlId }) : "");
  const box = document.getElementById("settings-search");
  if (box && box.value) paintSettingsSearch();
}

// The dropdown's press: select a definition and edit it. A dirty draft is the one thing that can refuse the change,
// and the select snaps back to the definition the form is still holding — a dropdown that stayed on "b" while the form
// showed "a" would be a control that lies about what Save will write.
function selectPipelineTab(value) {
  const pipelines = (pipelinesIndex && pipelinesIndex.pipelines) || {};
  const pick = document.getElementById("pipeline-select");
  const raw = String(value || "");
  // The dropdown's two lists share one control, so the value says which list it came from: `pdl:<id>` is a pipeline a
  // task runs on, anything else is a ladder definition this tab edits.
  const pdlId = raw.startsWith("pdl:") ? raw.slice(4) : "";
  const snapBack = () => {
    if (pick) pick.value = pipelinePdlId ? `pdl:${pipelinePdlId}` : pipelineOpenId || "";
  };
  // A dirty ladder draft is the one thing that can refuse the change, whichever list the press came from.
  if (pipelineDraftDirty && pipelineOpenId) {
    setPipelineStatus(`"${pipelineOpenId}" has unsaved changes — save or reload it before switching`, true);
    snapBack();
    return;
  }
  if (pdlId) {
    const pdl = pdlPipelines().find((p) => p.id === pdlId);
    if (!pdl) {
      snapBack();
      return;
    }
    pipelinePdlId = pdlId;
    // A PDL pipeline is not a ladder: the editor edits ladders, so it is closed rather than left showing another
    // document's stages under this pipeline's name.
    closePipelineEditor();
    setPipelinePdlNote(pdlPickNote(pdl));
    paintPipelineMapLink();
    return;
  }
  if (!pipelines[raw]) {
    snapBack();
    return;
  }
  pipelinePdlId = null;
  setPipelinePdlNote("");
  paintPipelineMapLink();
  openPipelineEditor(raw);
}

// The control that opens the modal, in edit mode. The DRAFT is what is drawn (so a half-made edit is drawn as it
// stands), and the flow's marks are all "not reached": a definition has no position — a task carries the position.
function openPipelineFlow() {
  // A PDL pipeline is drawn from its own document, not from a ladder draft: the two are different objects and the
  // dialog says which one it is showing.
  const pdl = selectedPdlPipeline();
  if (pdl) {
    openPdlFlow(pdl);
    return;
  }
  const pipelines = (pipelinesIndex && pipelinesIndex.pipelines) || {};
  const id = pipelineOpenId || (document.getElementById("pipeline-select") || {}).value || "";
  const def = pipelineDraft || pipelines[id];
  if (!def || typeof PipelineFlow === "undefined" || typeof PipelineModal === "undefined") return;
  const flow = PipelineFlow.fromDefinition(def);
  const stages = flow.stages.length;
  PipelineModal.open({
    mode: "edit",
    title: def.title || def.id || id,
    subtitle: pipelineDraftDirty ? "unsaved changes" : "",
    pipeline: flow,
    // The DRAWER's model: the preview builds the map page's card from the definition itself (ordinals, roles, exit
    // labels), and it is the DRAFT, so an unsaved edit is what the chart shows. The flow above still drives the edit
    // view, which is why both are handed over.
    definition: def,
    position: null,
    preview: false,
    facts: [
      { label: "pipeline", value: id || "—" },
      { label: "kind", value: def.kind || "?" },
      { label: "stages", value: String(stages) },
      { label: "next", value: def.next || "end of the chain" },
    ],
    // No caption here: the drawing's own legend says "not reached 13" once when a definition has no position, and an
    // empty definition draws its own "no stage" box. A sentence repeating either was the dialog apologising for the
    // picture instead of letting it speak.
    opener: document.getElementById("pipeline-flow-open"),
  });
}

// A PDL pipeline's flow: the map page's card, built from the document's own stages, gates and handoffs
// (public/core/pipeline-mermaid.js `fromPdl`). There is no edit drawing and no position — this dialog draws the
// document, and the tab that edits ladders is not editing this one.
function openPdlFlow(pdl) {
  if (typeof PipelineModal === "undefined") return;
  const stages = Array.isArray(pdl.stages) ? pdl.stages.length : 0;
  const gates = Array.isArray(pdl.gates) ? pdl.gates.length : 0;
  const handoffs = Array.isArray(pdl.handoffs) ? pdl.handoffs.length : 0;
  PipelineModal.open({
    mode: "edit",
    pdl: true,
    title: pdl.title || pdl.id,
    subtitle: "PDL · read-only",
    pipeline: null,
    definition: pdl,
    position: null,
    preview: true,
    facts: [
      { label: "pipeline", value: pdl.id || "—" },
      { label: "kind", value: "PDL" },
      { label: "stages", value: String(stages) },
      { label: "gates", value: String(gates) },
      { label: "handoffs", value: String(handoffs) },
    ],
    opener: document.getElementById("pipeline-flow-open"),
  });
}

function openPipelineEditor(id) {
  const pipelines = (pipelinesIndex && pipelinesIndex.pipelines) || {};
  const def = pipelines[id];
  if (!def) return;
  if (pipelineDraftDirty && pipelineOpenId && pipelineOpenId !== id) {
    setPipelineStatus(`"${pipelineOpenId}" has unsaved changes — save or reload it before opening another`, true);
    return;
  }
  pipelineOpenId = id;
  pipelineDraft = JSON.parse(JSON.stringify(def));
  pipelineDraftDirty = false;
  pipelineFindings = [];
  paintPipelineEditor();
}

function closePipelineEditor() {
  pipelineOpenId = null;
  pipelineDraft = null;
  pipelineDraftDirty = false;
  pipelineFindings = [];
  const editor = document.getElementById("pipeline-editor");
  if (editor) {
    editor.hidden = true;
    editor.innerHTML = "";
  }
}

function setPipelineStatus(text, bad = false) {
  const el = document.getElementById("pipeline-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("bad", Boolean(bad));
}

function paintPipelineFindings() {
  const el = document.getElementById("pipeline-findings");
  if (!el) return;
  if (!pipelineFindings.length) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML =
    `<div class="pipeline-finding-head">${pipelineFindings.length} finding${pipelineFindings.length === 1 ? "" : "s"} — nothing was saved</div>` +
    pipelineFindings.map((f) => `<div class="pipeline-finding mono">${esc(f)}</div>`).join("");
}

function pipelineStageHtml(stage, index) {
  const exit = stage.exit && typeof stage.exit === "object" ? stage.exit : {};
  const check = exit.check || "clean";
  const params = Object.fromEntries(Object.entries(exit).filter(([k]) => k !== "check"));
  const options = pipelineExitChecks.map((c) => `<option value="${esc(c)}"${c === check ? " selected" : ""}>${esc(c)}</option>`).join("");
  return `<div class="pipeline-stage" data-stage-index="${index}">
      <div class="settings-row">
        <span class="mono">stage ${index + 1}</span>
        <input type="text" class="stage-id" value="${esc(stage.id || "")}" placeholder="id" aria-label="stage ${index + 1} id" />
        <input type="text" class="stage-title" value="${esc(stage.title || "")}" placeholder="title" aria-label="stage ${index + 1} title" />
        <button type="button" class="stage-remove" title="remove this stage">remove</button>
      </div>
      <div class="settings-row">
        <textarea class="stage-prompt" rows="3" placeholder="the stage's whole instruction to the worker" aria-label="stage ${index + 1} prompt">${esc(stage.prompt || "")}</textarea>
      </div>
      <div class="settings-row">
        <span>exit</span>
        <select class="stage-exit-check" aria-label="stage ${index + 1} exit check">${options}</select>
        <input type="text" class="stage-exit-params mono" value="${esc(JSON.stringify(params))}" placeholder="{}" aria-label="stage ${index + 1} exit parameters" title="the check's parameters as JSON, without the check name" />
      </div>
    </div>`;
}

function paintPipelineEditor() {
  const editor = document.getElementById("pipeline-editor");
  if (!editor) return;
  if (!pipelineOpenId || !pipelineDraft) {
    editor.hidden = true;
    editor.innerHTML = "";
    return;
  }
  editor.hidden = false;
  if (pipelineDraftDirty) {
    paintPipelineFindings();
    return;
  }
  const kinds = Array.isArray(pipelinesIndex?.kinds) ? pipelinesIndex.kinds : ["local", "investigation", "turnover"];
  const ids = Object.keys((pipelinesIndex && pipelinesIndex.pipelines) || {}).filter((id) => id !== pipelineOpenId);
  const nextOptions = [`<option value=""${!pipelineDraft.next ? " selected" : ""}>(none)</option>`]
    .concat(ids.map((id) => `<option value="${esc(id)}"${pipelineDraft.next === id ? " selected" : ""}>${esc(id)}</option>`))
    .join("");
  editor.innerHTML = `<div class="settings-row pipeline-editor-head">
      <span>editing <strong class="mono">${esc(pipelineOpenId)}</strong></span>
      <button type="button" id="pipeline-editor-close" title="close this definition">close</button>
    </div>
    <div class="settings-row"><span>title</span><input type="text" id="pipeline-title" value="${esc(pipelineDraft.title || "")}" aria-label="pipeline title" /></div>
    <div class="settings-row"><span>kind</span><select id="pipeline-kind" aria-label="pipeline kind">${kinds.map((k) => `<option value="${esc(k)}"${pipelineDraft.kind === k ? " selected" : ""}>${esc(k)}</option>`).join("")}</select></div>
    <div class="settings-row"><span>description</span><input type="text" id="pipeline-description" value="${esc(pipelineDraft.description || "")}" aria-label="pipeline description" /></div>
    <div class="settings-row"><span>next</span><select id="pipeline-next" aria-label="pipeline next">${nextOptions}</select></div>
    <div id="pipeline-stages">${(pipelineDraft.stages || []).map((s, i) => pipelineStageHtml(s, i)).join("")}</div>
    <div class="settings-row pipeline-editor-actions">
      <button type="button" id="pipeline-add-stage" title="append a stage">add stage</button>
      <span class="settings-unit" id="pipeline-status"></span>
      <button type="button" id="pipeline-reload" title="discard the unsaved edit and read the definition again">reload</button>
      <button type="button" id="pipeline-save" class="primary" title="validate and save this definition">save</button>
    </div>
    <div id="pipeline-findings" class="pipeline-findings" aria-live="polite" hidden></div>`;
  wirePipelineEditor();
  paintPipelineFindings();
  setPipelineStatus("no unsaved changes");
}

function markPipelineDraftDirty() {
  pipelineDraftDirty = true;
  setPipelineStatus("unsaved changes");
}

// The stage rows are wired on every paint that REPLACES them — the full paint and paintPipelineStages — because the
// rows are new nodes each time. A listener left on the discarded node would watch a field the reader can no longer
// see, so a keystroke in the row that replaced it would never reach the draft.
function wirePipelineStages(editor) {
  for (const stageEl of editor.querySelectorAll(".pipeline-stage")) {
    for (const el of stageEl.querySelectorAll("input, textarea, select")) {
      el.addEventListener("input", () => {
        markPipelineDraftDirty();
        updateDraftFromForm();
      });
      el.addEventListener("change", () => {
        markPipelineDraftDirty();
        updateDraftFromForm();
      });
    }
    stageEl.querySelector(".stage-remove")?.addEventListener("click", () => removePipelineStage(Number(stageEl.dataset.stageIndex)));
  }
}

// What a repaint of the stage rows has to put back: which stage the reader is in, which field of it holds the caret,
// and where the selection and the scroll were. A press on a row's own remove button is not a caret — the button goes
// with the row — so it is reported with no field and the repaint hands focus to the editor's add press.
function pipelineFocusBeforeRepaint() {
  const editor = document.getElementById("pipeline-editor");
  const host = editor && editor.querySelector("#pipeline-stages");
  const active = document.activeElement;
  if (!host || !active || active === document.body) return null;
  let stageEl = null;
  for (let el = active; el && el !== host; el = el.parentElement) {
    if (String(el.className || "").split(/\s+/).includes("pipeline-stage")) {
      stageEl = el;
      break;
    }
  }
  if (!stageEl) return null;
  const cls = String(active.className || "")
    .split(/\s+/)
    .find((c) => c.startsWith("stage-") && c !== "stage-remove");
  const caret =
    typeof active.selectionStart === "number"
      ? { start: active.selectionStart, end: active.selectionEnd, scrollTop: Number(active.scrollTop) || 0 }
      : null;
  return { index: Number(stageEl.dataset.stageIndex), cls: cls || null, caret };
}

function restorePipelineFocus(was) {
  const editor = document.getElementById("pipeline-editor");
  if (!was || !editor) return;
  if (was.cls) {
    const field = editor.querySelector(`.pipeline-stage[data-stage-index="${was.index}"] .${was.cls}`);
    if (field) {
      field.focus({ preventScroll: true });
      if (was.caret && typeof field.setSelectionRange === "function") {
        field.setSelectionRange(was.caret.start, was.caret.end);
        field.scrollTop = was.caret.scrollTop;
      }
      return;
    }
  }
  // The row the press was on is the row that went away (a remove), and leaving focus on a detached node drops the
  // reader at the top of the page. The editor's own add press is the nearest thing to where they were.
  editor.querySelector("#pipeline-add-stage")?.focus({ preventScroll: true });
}

// The stage rows, rebuilt from the draft — the one part of a dirty form that is painted rather than left alone.
function paintPipelineStages() {
  const editor = document.getElementById("pipeline-editor");
  const host = editor && editor.querySelector("#pipeline-stages");
  if (!host || !pipelineDraft) return;
  const was = pipelineFocusBeforeRepaint();
  host.innerHTML = (pipelineDraft.stages || []).map((s, i) => pipelineStageHtml(s, i)).join("");
  wirePipelineStages(editor);
  restorePipelineFocus(was);
}

function wirePipelineEditor() {
  const editor = document.getElementById("pipeline-editor");
  if (!editor) return;
  for (const el of editor.querySelectorAll("#pipeline-title, #pipeline-kind, #pipeline-description, #pipeline-next")) {
    el.addEventListener("input", () => {
      markPipelineDraftDirty();
      updateDraftFromForm();
    });
    el.addEventListener("change", () => {
      markPipelineDraftDirty();
      updateDraftFromForm();
    });
  }
  wirePipelineStages(editor);
  editor.querySelector("#pipeline-editor-close")?.addEventListener("click", () => {
    if (pipelineDraftDirty && !confirm(`discard the unsaved changes to "${pipelineOpenId}"?`)) return;
    closePipelineEditor();
  });
  editor.querySelector("#pipeline-add-stage")?.addEventListener("click", addPipelineStage);
  editor.querySelector("#pipeline-reload")?.addEventListener("click", () => {
    if (pipelineDraftDirty && !confirm(`discard the unsaved changes to "${pipelineOpenId}"?`)) return;
    const def = ((pipelinesIndex && pipelinesIndex.pipelines) || {})[pipelineOpenId];
    if (!def) return closePipelineEditor();
    pipelineDraft = JSON.parse(JSON.stringify(def));
    pipelineDraftDirty = false;
    pipelineFindings = [];
    paintPipelineEditor();
  });
  editor.querySelector("#pipeline-save")?.addEventListener("click", savePipelineEditor);
}

function updateDraftFromForm() {
  const editor = document.getElementById("pipeline-editor");
  if (!editor || !pipelineDraft) return;
  pipelineDraft.title = editor.querySelector("#pipeline-title")?.value ?? pipelineDraft.title;
  pipelineDraft.kind = editor.querySelector("#pipeline-kind")?.value ?? pipelineDraft.kind;
  pipelineDraft.description = editor.querySelector("#pipeline-description")?.value ?? pipelineDraft.description;
  const next = (editor.querySelector("#pipeline-next")?.value || "").trim();
  pipelineDraft.next = next || null;
  pipelineDraft.stages = [...editor.querySelectorAll(".pipeline-stage")].map((stageEl) => {
    let params = {};
    try {
      params = JSON.parse(stageEl.querySelector(".stage-exit-params")?.value || "{}");
    } catch {
      params = {};
    }
    return {
      id: (stageEl.querySelector(".stage-id")?.value || "").trim(),
      title: stageEl.querySelector(".stage-title")?.value || "",
      prompt: stageEl.querySelector(".stage-prompt")?.value || "",
      exit: { check: stageEl.querySelector(".stage-exit-check")?.value || "clean", ...(params && typeof params === "object" && !Array.isArray(params) ? params : {}) },
    };
  });
}

function addPipelineStage() {
  if (!pipelineDraft) return;
  updateDraftFromForm();
  pipelineDraft.stages = [...(pipelineDraft.stages || []), { id: "", title: "", prompt: "", exit: { check: "clean" } }];
  pipelineDraftDirty = true;
  // The rows, not the whole editor: the title, kind, description and next fields keep the reader's text, and the
  // new row is drawn from the draft that Save will write.
  paintPipelineStages();
  setPipelineStatus("unsaved changes — a new stage has no id or prompt yet", false);
}

function removePipelineStage(index) {
  if (!pipelineDraft || !Number.isInteger(index)) return;
  updateDraftFromForm();
  pipelineDraft.stages = (pipelineDraft.stages || []).filter((_, i) => i !== index);
  pipelineDraftDirty = true;
  paintPipelineStages();
  setPipelineStatus("unsaved changes");
}

async function savePipelineEditor() {
  if (!pipelineDraft) return;
  updateDraftFromForm();
  const id = pipelineOpenId;
  const body = { version: pipelinesIndex?.version ?? 1, pipelines: { [id]: pipelineDraft } };
  try {
    const r = await apiFetch("/api/pipelines", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      pipelineFindings = Array.isArray(data.findings) ? data.findings : [data.error || `HTTP ${r.status}`];
      paintPipelineFindings();
      setPipelineStatus(`refused — ${data.error || "the panel refused the document"}`, true);
      return;
    }
    pipelinesIndex = { ...(data.state || pipelinesIndex) };
    pipelineDraft = JSON.parse(JSON.stringify((pipelinesIndex.pipelines || {})[id] || pipelineDraft));
    pipelineDraftDirty = false;
    pipelineFindings = [];
    paintPipelines();
    paintPipelineEditor();
    setPipelineStatus(`saved "${id}"`);
  } catch (e) {
    pipelineFindings = [e.message || String(e)];
    paintPipelineFindings();
    setPipelineStatus("not saved — the panel did not answer", true);
  }
}

// The Pipeline panel's own filter. The list is rebuilt markup, so the global search walks the rows here and returns
// the same per-tab count. The editor is not a settings row: it is the thing being edited, and filtering a form is
// not filtering settings.
function paintPipelineSearch(query, matched) {
  const panel = document.getElementById(PIPELINE_PANEL_ID);
  if (!panel) return 0;
  const flat = [...panel.children].filter((node) => node.id !== "pipeline-list" && node.id !== "pipeline-pdl-list" && node.id !== "pipeline-editor");
  let hits = paintSettingsRows(flat, query, matched);
  // The two LISTS are containers of rows, not rows: each of their rows is walked here so a search finds a pipeline by
  // the name on it. Both lists are rebuilt markup, so this is the only place their rows meet the filter.
  for (const row of panel.querySelectorAll("[data-pipeline-row], [data-pdl-pipeline]")) {
    const hit = !query || settingsRowText(row).includes(query);
    row.classList.toggle("search-hidden", !hit);
    if (hit) {
      hits += 1;
      if (query) matched.push(row);
    }
  }
  return hits;
}

// ---- end settings > pipeline

// ---- settings > bundles ---------------------------------------------------------------------------
// The studio pipeline bundle this panel reads — one exported file per install (config.pipelineBundleFile, default
// state/pipeline-bundle.json) — its pipelines in order, and the queue tasks that sit on them. The tab is a READ of two
// answers that already exist: GET /api/assistant/pipeline-catalogue (lib/pipeline-bundle.js's readBundle, carried as a
// value with its own refusal code and locator) and GET /api/assistant/queue (every assistant's queue, decorated).
//
// It adds no third answer and no second pipeline drawing. Four rules decide its shape:
//
//   1. A refusal is the LOADER's. The catalogue route already answers ok:false with the bundle's code, its reason and
//      the locator in the exported file; this tab prints that code and sentence. "could not read the pipelines" over a
//      bundle that is there and broken sends the reader looking for a missing file.
//   2. The stages are the WINDOW's. A pipeline row names its title, id and stage count and stops there; the stage
//      sequence, the gate and the time in stage are drawn by the task pipeline window the Queue pane opens. A second
//      stage list here would be a second representation of one pipeline, and the two would drift.
//   3. A task with no pipeline is ON the default path. `pipelineRun: null` reads as "assistant decides" — the
//      contract's own words (lib/task-pipeline.js) — never "unassigned", which would read as a row that lost its
//      assignment. A record the bundle cannot resolve keeps its own sentence.
//   4. The press opens the WINDOW. A task row opens the same task pipeline window the Queue pane opens (it is
//      exposed as window.__openTaskPipelineWindow), so a task is put on a pipeline from the catalogue the window
//      already offers, with the same write, the same stamp and the same refusal. Nothing here posts anything.
const BUNDLES_PANEL_ID = "settings-panel-bundles";
let bundlesIndex = null;
let bundlesLoadedAt = 0;
let bundlesLoading = null;
let bundleQueues = null;
let bundleQueuesAt = 0;
// The queue read's own refusal, kept apart from the catalogue's: a refused bundle must not be blamed on the queues,
// and a failed queue read must not erase a pipeline list that is still true.
let bundleQueuesError = null;

// A task's place, in the words the contract uses: the pipeline and stage when the record resolves to both, the default
// path when there is no assignment, and the record's own shape when it is neither. The Queue pane's chip says the same
// three things; the sentence lives in lib/task-pipeline.js's vocabulary (assistant-decides / pipeline / unresolved).
function bundleTaskPlace(t) {
  const run = t?.pipelineRun;
  const object = run && typeof run === "object" && !Array.isArray(run) ? run : null;
  const pipeline = object && typeof object.pipeline === "string" ? object.pipeline.trim() : "";
  const stage = object && typeof object.stage === "string" ? object.stage.trim() : "";
  if (pipeline) return `pipeline ${pipeline}${stage ? ` · ${stage}` : ""}`;
  if (run == null) return "assistant decides";
  return object ? "pipeline: unresolved — no pipeline named" : "pipeline: unresolved — unreadable record";
}

function bundlePipelineRowHtml(pipeline) {
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages.length : 0;
  const title = `${pipeline.title || pipeline.id} — ${stages} stage${stages === 1 ? "" : "s"} in the imported bundle. The stages themselves are drawn by the task pipeline window, not here: open a queue task's window to see them in order.`;
  return `<div class="settings-row" data-bundle-pipeline="${esc(pipeline.id)}" title="${esc(title)}">
      <span><strong>${esc(pipeline.title || pipeline.id)}</strong> <span class="mono">${esc(pipeline.id)}</span></span>
      <span class="settings-unit mono">${stages} stage${stages === 1 ? "" : "s"}</span>
    </div>`;
}

// One row per task the panel can see. The unit carries the task's PLACE and its lane, because a row that only said the
// pipeline would hide a parked task behind a running one. The row is a press: it opens the window that owns the stages
// and the assignment.
function bundleTaskRowHtml(queue, t) {
  const where = bundleTaskPlace(t);
  const lane = String(t.state || "").trim();
  const unit = [where, lane].filter(Boolean).join(" · ");
  const title = `#${t.id} ${t.title || ""} — ${where}${lane ? ` (${lane})` : ""}. Press to open this task's pipeline window: every stage in order, where this task sits, and the control that puts it on a pipeline.`.trim();
  const own = queue?.assistantId || t.owner || "";
  return `<div class="settings-row" data-bundle-task="${esc(own)}" data-bundle-task-id="${esc(String(t.id))}" title="${esc(title)}">
      <span><strong>#${esc(String(t.id))} ${esc(t.title || "")}</strong> <span class="mono">${esc(queue?.name || own)}</span></span>
      <span class="settings-unit mono">${esc(unit)}</span>
    </div>`;
}

// The summary row, the source line and the two lists. Painted from one answer so a refusal cannot leave the summary
// saying "12 pipelines" beside a list saying "none" — the route's own `ok` decides both.
function paintBundles(error = null) {
  const summary = document.getElementById("bundle-summary");
  const source = document.getElementById("bundle-source");
  const list = document.getElementById("bundle-list");
  if (!summary || !list) return;
  summary.classList.remove("bad");
  if (source) source.classList.remove("bad");
  if (error) {
    summary.textContent = `could not read the pipeline catalogue — ${error}`;
    summary.classList.add("bad");
    if (source) {
      source.textContent = "nothing was read, so this tab knows nothing about the bundle";
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = "";
    paintBundleTasks(bundleQueuesError);
    return;
  }
  const data = bundlesIndex;
  if (!data) {
    summary.textContent = "reading…";
    if (source) source.textContent = "…";
    return;
  }
  if (data.ok !== true) {
    // The loader's own refusal: its code first (a reader can quote it), then its sentence and its locator. A generic
    // "no pipelines" here would erase the one fact that fixes it — whether the file is missing or broken.
    summary.textContent = `refused — ${data.code || "pipeline-bundle"}`;
    summary.classList.add("bad");
    if (source) {
      source.textContent = `${data.reason || "the bundle was refused"}${data.where ? ` (at ${data.where})` : ""}`;
      source.title = source.textContent;
      source.classList.add("bad");
    }
    list.innerHTML = `<div class="settings-row" title="the bundle was refused whole, so no pipeline from it can be listed — the sentence above names the file and the place in it"><span>no pipeline can be listed — the bundle was refused whole</span><span class="settings-unit mono">${esc(data.code || "pipeline-bundle")}</span></div>`;
    paintBundleTasks(bundleQueuesError);
    return;
  }
  const pipelines = Array.isArray(data.pipelines) ? data.pipelines : [];
  const bits = [`${pipelines.length} pipeline${pipelines.length === 1 ? "" : "s"}`];
  if (data.name) bits.push(data.name);
  summary.textContent = bits.join(" · ");
  if (source) {
    source.textContent = `${data.file || "the pipeline bundle"}${data.name ? ` · ${data.name}` : ""} — this panel imports whatever the studio's export saved there; the task pipeline window draws each pipeline's stages.`;
    source.title = source.textContent;
  }
  list.innerHTML =
    pipelines.map((pipeline) => bundlePipelineRowHtml(pipeline)).join("") ||
    `<div class="settings-row"><span>the bundle holds no pipeline — the file was read and is empty</span></div>`;
  paintBundleTasks(bundleQueuesError);
}

// The queue half. A read failure is named on its own row — the pipelines above are still true, and a failed queue read
// must not blank them. A task row is a press into the window, so this list carries no assignment control of its own.
function paintBundleTasks(error = null) {
  const summary = document.getElementById("bundle-tasks-summary");
  const list = document.getElementById("bundle-tasks");
  if (!summary || !list) return;
  summary.classList.remove("bad");
  if (error) {
    bundleQueuesError = error;
    summary.textContent = `could not read the queues — ${error}`;
    summary.classList.add("bad");
    list.innerHTML = "";
    return;
  }
  const data = bundleQueues;
  if (!data) {
    summary.textContent = "reading…";
    list.innerHTML = "";
    return;
  }
  const queues = Array.isArray(data.queues) ? data.queues : [];
  const rows = [];
  let active = 0;
  let done = 0;
  for (const queue of queues) {
    for (const t of queue.tasks || []) {
      if (String(t.state || "") === "done") {
        done += 1;
        continue;
      }
      active += 1;
      rows.push(bundleTaskRowHtml(queue, t));
    }
  }
  const failed = queues.filter((q) => q.error);
  const bits = [`${active} active task${active === 1 ? "" : "s"}`];
  if (done) bits.push(`${done} done`);
  if (failed.length) bits.push(`${failed.length} queue file${failed.length === 1 ? "" : "s"} unreadable`);
  summary.textContent = bits.join(" · ");
  if (failed.length) summary.classList.add("bad");
  list.innerHTML =
    rows.join("") ||
    `<div class="settings-row" title="every assistant's queue reads empty — there is no task to put on a pipeline yet"><span>no active queue task — nothing to put on a pipeline</span></div>`;
  // A re-read can land while the settings search is filtering this tab: the rebuilt rows are filtered by the same pass
  // the reader's next keystroke would run, so a match does not blink out of the list after a refresh.
  const box = document.getElementById(SETTINGS_SEARCH_ID);
  if (box && box.value) paintSettingsSearch();
}

// The tab's own filter: the flat rows outside the two lists, then each list's rows. The window's card is not part of
// this panel (it is appended to the document by the task window), so a search never hides a form the reader opened.
function paintBundlesSearch(query, matched) {
  const panel = document.getElementById(BUNDLES_PANEL_ID);
  if (!panel) return 0;
  const flat = [...panel.children].filter((node) => node.id !== "bundle-list" && node.id !== "bundle-tasks");
  let hits = paintSettingsRows(flat, query, matched);
  for (const row of panel.querySelectorAll("[data-bundle-pipeline], [data-bundle-task]")) {
    const hit = !query || settingsRowText(row).includes(query);
    row.classList.toggle("search-hidden", !hit);
    if (hit) {
      hits += 1;
      if (query) matched.push(row);
    }
  }
  return hits;
}

// Two reads in parallel: the bundle's pipelines and every assistant's queue. Either can fail without taking the other
// with it — a refused bundle still lists its refusal beside whatever the queues say, and a failed queue read leaves
// the pipelines standing.
async function loadBundles() {
  if (bundlesLoading) return bundlesLoading;
  bundlesLoading = (async () => {
    let error = null;
    try {
      const [catalogue, queues] = await Promise.allSettled([
        apiFetch("/api/assistant/pipeline-catalogue").then(async (r) => {
          const body = await r.json().catch(() => null);
          if (!r.ok) throw new Error((body && body.error) || `the catalogue answered ${r.status}`);
          return body;
        }),
        apiFetch("/api/assistant/queue").then(async (r) => {
          const body = await r.json().catch(() => null);
          if (!r.ok) throw new Error((body && body.error) || `the queues answered ${r.status}`);
          return body;
        }),
      ]);
      if (catalogue.status === "fulfilled") {
        bundlesIndex = catalogue.value;
        bundlesLoadedAt = Date.now();
      } else {
        error = String((catalogue.reason && catalogue.reason.message) || catalogue.reason);
      }
      if (queues.status === "fulfilled") {
        bundleQueues = queues.value;
        bundleQueuesAt = Date.now();
        bundleQueuesError = null;
      } else {
        bundleQueuesError = String((queues.reason && queues.reason.message) || queues.reason);
      }
      paintBundles(error);
    } catch (e) {
      paintBundles(e.message || String(e));
    } finally {
      bundlesLoading = null;
    }
  })();
  return bundlesLoading;
}

// A chosen studio export, appended to the bundle this panel already reads.
//
// The bundle is a LIST, and the route appends by pipeline id: today's live file is one studio document, so before this
// a second import could only replace the first and the dropdown kept one entry. The page reads the file the reader
// chose, posts its TEXT (the server parses it with the same loader the panel reads with), and prints the route's own
// sentence — the added pipelines and their stage counts, or the refusal's code and the id it names.
async function bundleImportChosen(input) {
  const note = document.getElementById("bundle-import-note");
  const file = input && input.files && input.files[0] ? input.files[0] : null;
  if (!file) return null;
  const say = (message, bad = false) => {
    if (!note) return;
    note.textContent = message;
    note.classList.toggle("bad", bad);
  };
  say(`importing ${file.name}…`);
  let text;
  try {
    text = await file.text();
  } catch (e) {
    say(`${file.name} could not be read — ${(e && e.message) || e}`, true);
    return null;
  }
  try {
    const r = await apiFetch("/api/assistant/pipeline-bundle/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, name: file.name }),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.ok !== true) {
      // The route's refusal, in its own words: `code` first (a reader can quote it), then the sentence that names the
      // pipeline id the bundle already holds.
      const code = body && body.code ? ` (${body.code})` : "";
      say(`${file.name}: ${(body && body.error) || `the panel answered ${r.status}`}${code}`, true);
      return null;
    }
    say(body.reason || `imported ${file.name}`);
    // The Pipeline tab draws this same list (its `pdl` block), so its cached answer is stale the moment the write lands:
    // clearing the stamp makes that tab's next press re-read instead of waiting out the freshness window.
    pipelinesLoadedAt = 0;
    // The list above is a read of the file the write just changed, so it is re-read before the note is trusted.
    await loadBundles();
    return body;
  } catch (e) {
    say(`${file.name}: ${(e && e.message) || e}`, true);
    return null;
  } finally {
    // The same file may be chosen twice in a row (a corrected export with the same name): a file input that kept its
    // value would fire no `change` the second time and the press would look dead.
    if (input) input.value = "";
  }
}

// A task row's press: the SAME window the Queue pane opens. The window reads its own model and catalogue, so this
// handler carries two ids and the row the caret came from — nothing else, and no assignment logic of its own.
function initBundlesPanel() {
  const panel = document.getElementById(BUNDLES_PANEL_ID);
  if (!panel) return;
  // The task pipeline window's assignment press writes the QUEUE (the record's one door), and this tab's rows are a
  // read of that queue. So the window's own event is what tells this tab its rows are stale — without it a row keeps
  // saying "assistant decides" after the reader put the task on a pipeline. The refresh runs whether or not this tab
  // is on screen: the settings window CLOSES while the task window is up (the window opens over it), so gating on
  // "visible" would drop the one notice that the data moved, and the next open would read it as too recent to reload.
  // Two reads behind a closed window are cheaper than a row that contradicts the queue on the next open.
  document.addEventListener("wtgui:task-pipeline-assigned", () => {
    void loadBundles();
  });
  // The import's file picker: the button is the affordance, the hidden input is what a browser will open. Reading
  // happens on `change` (the reader may cancel the dialog, which fires nothing), so a cancelled pick leaves no note.
  panel.addEventListener("change", (e) => {
    if (e.target?.id !== "bundle-import-file") return;
    void bundleImportChosen(e.target);
  });
  panel.addEventListener("click", (e) => {
    const refresh = e.target?.closest?.("[data-bundle-refresh]");
    if (refresh) {
      e.preventDefault();
      void loadBundles();
      return;
    }
    const importer = e.target?.closest?.("[data-bundle-import]");
    if (importer) {
      e.preventDefault();
      document.getElementById("bundle-import-file")?.click?.();
      return;
    }
    const row = e.target?.closest?.("[data-bundle-task]");
    if (!row) return;
    e.preventDefault();
    const opener = typeof window.__openTaskPipelineWindow === "function" ? window.__openTaskPipelineWindow : null;
    if (!opener) {
      paintBundleTasks("this build does not expose the task pipeline window — reload the panel");
      return;
    }
    void opener(row.dataset.bundleTask, row.dataset.bundleTaskId, row);
  });
}

// ---- end settings > bundles

// ---- settings window: move it, size it ------------------------------------------------------------
// The panel used to be a popover pinned under the top bar: `position: fixed; right: 16px; top: 74px` and no way to
// move it off what it was covering, nor to see more of a long group than the height it opened at. It is a window
// now — a press on its head drags it, its corner grip sizes it — and the rect the reader leaves it at is remembered
// in this browser. The gestures follow the assistant's floating pane (`public/assistant.js`: `placeFloat` and the
// `float-move` / `float-size` cases of `onDown`), because the two are the same problem: a fixed node measured in
// CLIENT px and written back in LAYOUT px.
const SETTINGS_RECT_KEY = "wtgui.settingsRect";
const SETTINGS_MIN_W = 320;
const SETTINGS_MIN_H = 240;
const SETTINGS_EDGE = 8;
const SETTINGS_SLOP = 3;

// A client length as a layout one: `getBoundingClientRect` and `clientX` are VISUAL px while a length written to
// `style.left`/`style.width` is LAYOUT px, and Settings > Display's zoom scales the page (`applyZoom`).
function settingsZoom() {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// The box a clamp is measured against: the LAYOUT viewport (`documentElement.clientWidth` is layout px while the
// page is zoomed), the same box the assistant's float places itself in.
function settingsViewport() {
  const doc = document.documentElement;
  return { vw: doc.clientWidth || window.innerWidth, vh: doc.clientHeight || window.innerHeight };
}

// A stored rect, or nothing: a value that is not four finite numbers is no record at all, so a half-written store
// opens the panel where the stylesheet puts it rather than at `NaNpx`.
function readSettingsRect() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_RECT_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const rect = { x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h) };
    return [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ? rect : null;
  } catch {
    return null;
  }
}

function writeSettingsRect(rect) {
  try {
    localStorage.setItem(SETTINGS_RECT_KEY, JSON.stringify(rect));
  } catch {
    /* a browser that refuses storage still drags; it just forgets between loads */
  }
}

let settingsRect = readSettingsRect();

// The remembered rect inside the window it is being opened on: a rect saved on a bigger screen must not put half the
// panel outside a smaller one, and neither dimension goes under the panel's floor. Both edges are clamped, so a rect
// left hanging off one side comes back whole rather than half-visible.
function clampSettingsRect(r) {
  const { vw, vh } = settingsViewport();
  const maxW = Math.max(SETTINGS_MIN_W, vw - 2 * SETTINGS_EDGE);
  const maxH = Math.max(SETTINGS_MIN_H, vh - 2 * SETTINGS_EDGE);
  const w = Math.max(SETTINGS_MIN_W, Math.min(Number(r.w) || SETTINGS_MIN_W, maxW));
  const h = Math.max(SETTINGS_MIN_H, Math.min(Number(r.h) || SETTINGS_MIN_H, maxH));
  const x = Math.max(SETTINGS_EDGE, Math.min(Number(r.x) || 0, Math.max(SETTINGS_EDGE, vw - w - SETTINGS_EDGE)));
  const y = Math.max(SETTINGS_EDGE, Math.min(Number(r.y) || 0, Math.max(SETTINGS_EDGE, vh - h - SETTINGS_EDGE)));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// Put the panel where the reader left it. A panel that was never moved keeps the stylesheet's anchored rule, so
// there is no rect to place and this does nothing at all.
function placeSettingsWindow() {
  const panel = $("settings");
  if (!panel || !settingsRect) return;
  const rect = clampSettingsRect(settingsRect);
  panel.style.left = `${rect.x}px`;
  panel.style.top = `${rect.y}px`;
  panel.style.width = `${rect.w}px`;
  panel.style.height = `${rect.h}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  // The remembered height IS the window's height: the stylesheet's `max-height: calc(100vh - 90px)` would otherwise
  // cap it wherever the top edge has been dragged to.
  panel.style.maxHeight = "none";
}

function initSettingsWindow() {
  const panel = $("settings");
  if (!panel) return;
  const head = panel.querySelector(":scope > .settings-head");
  const grip = document.getElementById("settings-grip");
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let press = null;

  // `kind` is the gesture: the head moves the window, the grip sizes it from its bottom-right corner. Every length
  // starts as a CLIENT measurement — the unit a pointer arrives in — and is divided by the zoom once, so the rect
  // that is written and the rect that is remembered are both LAYOUT px.
  const onDown = (e, kind, captureEl) => {
    if (e.button !== 0) return;
    // The head is a row of CONTROLS as well as the window's bar: a press on the search box or a button is that
    // control's, or the box could never be clicked into and every ✕ press would start a drag first.
    if (kind === "move" && e.target.closest("button,input,select,textarea,a,label")) return;
    const z = settingsZoom();
    const r = panel.getBoundingClientRect();
    press = { kind, px: e.clientX, py: e.clientY, moved: false, z, box: { x: r.left / z, y: r.top / z, w: r.width / z, h: r.height / z } };
    // Hold the pointer for the length of the gesture: without capture it leaves the panel (and the window) and the
    // moves stop arriving, so a release out there never ends the drag started in here.
    try {
      captureEl.setPointerCapture(e.pointerId);
    } catch {
      /* older pointer stacks: the window listeners below still carry the gesture */
    }
    e.preventDefault();
  };

  // The anchored rule becomes explicit edges on the FIRST real movement, never on the press: a click on the head
  // must leave the panel exactly as the stylesheet drew it (auto height and all), and only a drag freezes a rect.
  const pin = (d) => {
    panel.style.left = `${d.box.x}px`;
    panel.style.top = `${d.box.y}px`;
    panel.style.width = `${d.box.w}px`;
    panel.style.height = `${d.box.h}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.maxHeight = "none";
  };

  const onMove = (e) => {
    if (!press) return;
    const d = press;
    const rawX = e.clientX - d.px;
    const rawY = e.clientY - d.py;
    if (!d.moved) {
      if (Math.hypot(rawX, rawY) < SETTINGS_SLOP) return;
      d.moved = true;
      panel.classList.add(d.kind === "move" ? "is-moving" : "is-sizing");
      pin(d);
    }
    const { vw, vh } = settingsViewport();
    if (d.kind === "move") {
      // The whole window stays inside the viewport: no edge of it is ever left off the screen.
      const x = clamp(d.box.x + rawX / d.z, SETTINGS_EDGE, Math.max(SETTINGS_EDGE, vw - d.box.w - SETTINGS_EDGE));
      const y = clamp(d.box.y + rawY / d.z, SETTINGS_EDGE, Math.max(SETTINGS_EDGE, vh - d.box.h - SETTINGS_EDGE));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      return;
    }
    // The corner: the left and top edges stay put, the floor is the panel's own minimum, and neither dimension is
    // ever asked for LESS than the window already has (a panel taller than the room left would snap on the first
    // pixel of the drag).
    const w = clamp(d.box.w + rawX / d.z, SETTINGS_MIN_W, Math.max(d.box.w, vw - SETTINGS_EDGE - d.box.x));
    const h = clamp(d.box.h + rawY / d.z, SETTINGS_MIN_H, Math.max(d.box.h, vh - SETTINGS_EDGE - d.box.y));
    panel.style.width = `${w}px`;
    panel.style.height = `${h}px`;
  };

  const onUp = () => {
    if (!press) return;
    const d = press;
    press = null;
    panel.classList.remove("is-moving", "is-sizing");
    if (!d.moved) return; // a click: nothing was dragged, so nothing is remembered
    // Store what the clamp actually drew, measured back: a drag past an edge must not remember a rect the window can
    // never have.
    const z = settingsZoom();
    const r = panel.getBoundingClientRect();
    settingsRect = { x: Math.round(r.left / z), y: Math.round(r.top / z), w: Math.round(r.width / z), h: Math.round(r.height / z) };
    writeSettingsRect(settingsRect);
  };

  if (head) head.addEventListener("pointerdown", (e) => onDown(e, "move", head));
  if (grip) grip.addEventListener("pointerdown", (e) => onDown(e, "size", grip));
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  // A window that shrinks under a placed panel must not leave it outside: the clamp that opens it re-runs.
  window.addEventListener("resize", () => placeSettingsWindow());
}

// ---- end settings window

function toggleSettings(open = null) {
  const panel = $("settings");
  if (!panel) return;
  const show = open === null ? panel.classList.contains("hidden") : open;
  panel.classList.toggle("hidden", !show);
  if (!show) {
    // A panel that is opened again must not come back filtered: the search belongs to the visit that typed it.
    clearSettingsSearch();
    return;
  }
  // The window goes back where the reader left it — and inside a window that may have shrunk since — before the
  // focus lands in it, so a restored rect never scrolls the body under the caret.
  placeSettingsWindow();
  // The tab the reader chose is read again on every open (another browser tab can have moved it), so the window
  // opens on the panel they left, not on the one this tab last painted.
  paintSettingsTab(settingsTabKey(), { save: false });
  // The search box is the first control the fixed head keeps on screen and the way to a row on any tab — including
  // the tabs the reader is not on — so it takes the focus. (The font select it used to focus is now inside the
  // Display panel, which is not necessarily the visible one.)
  const searchBox = $("settings-search");
  if (searchBox) searchBox.focus();
  const sel = $("font-select");
  if (sel) sel.value = currentFontId("ui");
  // The browser-owned rows are read at boot; painting them again here just means the panel always opens on
  // what is in effect, even if another tab changed it.
  paintQLook();
  // The two folders, always on the last snapshot the page received (their sizes are computed server-side and cached
  // for ten seconds, so opening Settings never waits on a walk), and the clean button disarmed: an armed press left
  // over from last time must not be one Enter away from deleting a folder.
  paintPaths();
  paintScratchActions(false);
  // The agent-cleanup row reads the last snapshot again on every open, so a switch another tab moved is what the
  // panel shows rather than what this tab last saw.
  paintAgentCleanup();
  // …and the initiative tier beside it, for the same reason: it is server-side, so another browser may have moved it,
  // and the row has to open on the level the initiative routes are actually reading.
  paintInitiativeTier();
  // The reset control names WHICH assistant it acts on, and the roster can have grown since the last snapshot was
  // painted (another tab creates one), so it is read again on every visit — keeping the assistant already chosen.
  paintResetRow();
  // Read the gateway's window every time the panel opens: it can be changed from a CLI, and the
  // panel is not the owner of that value.
  void loadApprovalSetting();
  void loadSessionSetting();
  void loadProviderSetting();
  void loadProviderProfiles();
  void loadModelsSetting();
  // The bridge's own process state, read on the same visit as the rows above: the pid may have died while the tab
  // was closed, and "stopped" must be what the reader sees, not last visit's "running".
  void loadMatrixStatus();
  // The skills inventory is a filesystem walk plus a gateway call, so it is read at boot and then only re-read when
  // the answer is old: a reader opening Settings twice in a minute is not asking the disk the same question again.
  if (Date.now() - skillsLoadedAt > 15000) void loadSkills();
  // The permissions inventory reads config.yaml and asks the gateway, so it gets the same treatment:
  // read once when Settings opens, and again only when the answer is old.
  if (Date.now() - permissionsLoadedAt > 15000) void loadPermissions();
  // The catalogue is a read of two small files, so it gets the same treatment: read once when Settings opens, and
  // again only when the answer is old. A dirty draft in its editor is never replaced by that read.
  if (Date.now() - pipelinesLoadedAt > 15000) void loadPipelines();
  // The bundle and every assistant's queue are two more reads the reader may open this window to see: refresh them
  // when their answer is old, so the tab is current on the first press after a re-export or a task moved elsewhere.
  if (Date.now() - bundlesLoadedAt > 15000) void loadBundles();
  // The push controls are read again on every visit: the project list is the snapshot's, and the resolved pair may
  // have moved since this tab last painted it.
  paintPushPermissions();
  // The remote-write setting is the panel's own (config.json), but which trees carry the push guard is a file on
  // disk that another instance or a hand edit can change, so it is re-read every time the panel opens.
  void refreshRemoteGuards();
}

// ---- the provider endpoint every run talks to ------------------------------------------------
// model.base_url and model.api_key in config.yaml. The key never comes back from the server: the box
// shows whether one is set, where it came from and its last four characters, and typing replaces it.
let providerStateCache = null;

function paintProviderSetting(error = null) {
  const url = $("provider-url");
  const key = $("provider-key");
  const preview = $("provider-preview");
  const save = $("btn-provider-save");
  const clear = $("btn-provider-clear");
  const s = providerStateCache;
  if (!preview) return;
  if (!s) {
    preview.textContent = "could not read the provider settings";
    preview.classList.add("bad");
    return;
  }
  if (url && document.activeElement !== url) url.value = s.baseUrl || "";
  if (url) url.placeholder = s.defaultBaseUrl || "https://openrouter.ai/api/v1";
  if (key) {
    const where = s.key.inConfig ? "in config.yaml" : s.key.envName ? `from ${s.key.envName}` : null;
    key.placeholder = s.key.set ? `${s.key.masked}${where ? ` ${where}` : ""} — type to replace` : "(not set — runs have no key)";
    if (error) key.value = "";
  }
  if (save) save.disabled = !s.editable;
  if (clear) clear.disabled = !s.editable || !s.key.inConfig;
  const urlText = s.baseUrl || `${s.defaultBaseUrl} (default)`;
  const keyText = s.key.set ? `${s.key.masked}${s.key.inConfig ? " in config.yaml" : s.key.envName ? ` from ${s.key.envName}` : ""}` : "not set";
  preview.textContent = error
    ? `NOT SAVED — ${error}`
    : `${s.provider} · ${urlText} · key ${keyText}`;
  preview.classList.toggle("bad", Boolean(error) || !s.editable);
  preview.title = s.editable ? s.configPath : s.reason || s.configPath;
}

async function loadProviderSetting() {
  try {
    const r = await apiFetch("/api/settings/provider");
    providerStateCache = await r.json();
    paintProviderSetting();
  } catch (e) {
    providerStateCache = null;
    paintProviderSetting(e.message);
  }
}

async function saveProviderSetting() {
  const url = $("provider-url");
  const key = $("provider-key");
  if (!providerStateCache?.editable) return;
  const preview = $("provider-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: url?.value || "", apiKey: key?.value || "" }),
    });
    const d = await r.json();
    providerStateCache = d;
    if (!r.ok) {
      paintProviderSetting(d.error || `HTTP ${r.status}`);
      return;
    }
    if (key) key.value = "";
    paintProviderSetting();
    showBanner(d.note || "provider settings saved");
  } catch (e) {
    paintProviderSetting(e.message);
  }
}

// Two clicks: the first only arms the button, so a stray one cannot take the key out of config.yaml.
async function clearProviderKey(btn) {
  if (!btn || !providerStateCache?.editable) return;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "clear key?";
    btn.classList.add("dirty");
    clearTimeout(btn._disarm);
    btn._disarm = setTimeout(() => {
      btn.dataset.armed = "";
      btn.textContent = "clear key";
      btn.classList.remove("dirty");
    }, 4000);
    return;
  }
  clearTimeout(btn._disarm);
  btn.dataset.armed = "";
  btn.textContent = "clear key";
  btn.classList.remove("dirty");
  try {
    const r = await apiFetch("/api/settings/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearKey: true }),
    });
    const d = await r.json();
    providerStateCache = d;
    if (!r.ok) {
      paintProviderSetting(d.error || `HTTP ${r.status}`);
      return;
    }
    paintProviderSetting();
    showBanner(d.key?.set ? "model.api_key removed — the .env key is used again" : "model.api_key removed — runs now have no key from config.yaml");
  } catch (e) {
    paintProviderSetting(e.message);
  }
}

// ---- saved provider profiles -------------------------------------------------------------------
// A profile is a named (model.base_url, model.api_key) pair the rows above can apply with one press. What
// comes back from the server is the name, the URL and the LAST FOUR of each key: the key itself is read by
// the panel when Apply runs, so it never enters this page. Apply is deliberately not "fill the boxes and
// save": the key would have to come back here to do that, and a second Save with a stale box would then
// write the wrong one.
let providerProfilesCache = null;
// Which option is chosen, kept here rather than read off the <select>: the list is rebuilt on every paint,
// and a rebuilt select would forget the choice made a moment earlier.
let providerProfileChosen = "";

function providerProfiles() {
  return providerProfilesCache?.profiles || [];
}

function selectedProfile() {
  return providerProfiles().find((p) => p.id === providerProfileChosen) || null;
}

function paintProviderProfiles(error = null) {
  const select = $("provider-profile");
  const preview = $("provider-profile-preview");
  const save = $("btn-provider-profile-save");
  const edit = $("btn-provider-profile-edit");
  const drop = $("btn-provider-profile-delete");
  const apply = $("btn-provider-profile-apply");
  const nameBox = $("provider-profile-name");
  if (!select || !preview) return;
  const list = providerProfiles();
  if (providerProfileChosen && !list.some((p) => p.id === providerProfileChosen)) providerProfileChosen = "";
  const editable = Boolean(providerStateCache?.editable);
  select.textContent = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = list.length === 0 ? "(none saved yet)" : `(${list.length} saved — pick one)`;
  select.append(blank);
  for (const p of list) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} — ${p.baseUrl}${p.key.set ? ` · ${p.key.masked}` : " · no key"}`;
    select.append(opt);
  }
  select.value = providerProfileChosen;
  const chosen = selectedProfile();
  if (save) save.disabled = !editable;
  if (edit) edit.disabled = !editable || !chosen;
  if (drop) drop.disabled = !chosen;
  if (apply) apply.disabled = !editable || !chosen;
  if (nameBox && chosen && document.activeElement !== nameBox) nameBox.value = chosen.name;
  const where = providerProfilesCache?.file ? ` in ${providerProfilesCache.file}` : "";
  if (error) {
    preview.textContent = `NOT SAVED — ${error}`;
    preview.classList.add("bad");
  } else {
    preview.classList.remove("bad");
    preview.textContent = chosen
      ? `${chosen.name} · ${chosen.baseUrl} · key ${chosen.key.set ? chosen.key.masked : "none"}${where}`
      : list.length
        ? `${list.length} profile${list.length === 1 ? "" : "s"} saved${where} — pick one to Apply, or name the pair above and press Save as`
        : `no profiles saved yet — type a name above and press Save as; keys are kept${where || " in the panel's own state folder"}, never in the repository`;
  }
  preview.title = providerProfilesCache?.file || "";
}

async function loadProviderProfiles() {
  try {
    const r = await apiFetch("/api/settings/provider/profiles");
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    providerProfilesCache = d;
    paintProviderProfiles();
  } catch (e) {
    providerProfilesCache = null;
    paintProviderProfiles(e.message);
  }
}

// Save as creates, Edit replaces the chosen record. Both send the boxes exactly as they are, and the server
// treats an empty key box on an Edit as "keep the key already stored" — the reason an Edit that only renames
// a profile cannot silently strip its credential.
async function saveProviderProfile(mode) {
  const chosen = selectedProfile();
  if (mode === "edit" && !chosen) return;
  const nameBox = $("provider-profile-name");
  const preview = $("provider-profile-preview");
  if (!providerStateCache?.editable) return;
  const body = {
    name: (nameBox?.value || "").trim() || (mode === "edit" ? chosen.name : ""),
    baseUrl: $("provider-url")?.value || "",
    apiKey: $("provider-key")?.value || "",
  };
  if (mode === "edit") body.id = chosen.id;
  if (preview) {
    preview.textContent = mode === "edit" ? "updating the profile…" : "saving the profile…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/provider/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      paintProviderProfiles(d.error || `HTTP ${r.status}`);
      return;
    }
    providerProfilesCache = d;
    providerProfileChosen = d.saved?.id || providerProfileChosen;
    if (nameBox && d.saved) nameBox.value = d.saved.name;
    paintProviderProfiles();
    showBanner(d.note || "profile saved");
  } catch (e) {
    paintProviderProfiles(e.message);
  }
}

// Two clicks, like clear key: a profile's key goes with the record, so a stray press must not take it out.
async function deleteProviderProfile(btn) {
  const chosen = selectedProfile();
  if (!btn || !chosen) return;
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "delete?";
    btn.classList.add("dirty");
    clearTimeout(btn._disarm);
    btn._disarm = setTimeout(() => {
      btn.dataset.armed = "";
      btn.textContent = "Delete";
      btn.classList.remove("dirty");
    }, 4000);
    return;
  }
  clearTimeout(btn._disarm);
  btn.dataset.armed = "";
  btn.textContent = "Delete";
  btn.classList.remove("dirty");
  try {
    const r = await apiFetch("/api/settings/provider/profiles/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: chosen.id }),
    });
    const d = await r.json();
    if (!r.ok) {
      paintProviderProfiles(d.error || `HTTP ${r.status}`);
      return;
    }
    providerProfilesCache = d;
    providerProfileChosen = "";
    const nameBox = $("provider-profile-name");
    if (nameBox) nameBox.value = "";
    paintProviderProfiles();
    showBanner(d.note || "profile deleted");
  } catch (e) {
    paintProviderProfiles(e.message);
  }
}

// ---- the two restarts: one press, one target, never chained --------------------------------------
// "Restart gateway" and "Restart panel" are separate controls because they are separate operations: each
// queues exactly one restart with its own target and answers at once, and the panel refuses a second
// request while one is still queued rather than folding them together. A press only disables ITSELF for
// the length of its own request, so the other button stays pressable and this page stays up through both.
async function restartFromSettings(target, btn) {
  const preview = $("restart-preview");
  if (btn) btn.disabled = true;
  if (preview) {
    preview.textContent = `queueing a ${target} restart…`;
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        reason: `reader pressed "Restart ${target}" in Settings → Gateway`,
        // No thread of its own: the panel's own default decides which turn has to end first, which is the
        // whole reason the request returns before the restart runs.
        waitFor: null,
      }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      if (preview) {
        preview.textContent = `${target} restart NOT queued — ${d.error || `HTTP ${r.status}`}`;
        preview.classList.add("bad");
      }
      return;
    }
    const rec = d.restart || {};
    if (preview) {
      preview.classList.remove("bad");
      preview.textContent =
        `${target} restart queued${rec.id ? ` (${rec.id})` : ""} — it runs once ${rec.thread || "the current turn"} has no turn running. ` +
        (target === "panel"
          ? "The gateway keeps running; this page reconnects when the panel is back — reload the tab if it does not."
          : "The panel and this page keep running; runs in flight are interrupted and reported as such.");
    }
    showBanner(`restart queued: ${target}`);
  } catch (e) {
    if (preview) {
      preview.textContent = `${target} restart NOT queued — ${e.message}`;
      preview.classList.add("bad");
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- the model menu's prices and ratings -------------------------------------------------------
// The dropdown's price and coding columns are this panel's own cache of what the gateway's model
// inventory says. They are READ, never fetched, on the path that opens the menu — a cold endpoint
// must not be able to hold a dropdown — so this is the one control that regenerates them: it makes
// the gateway re-fetch every provider's live model list (the same file `hermes model --refresh`
// writes) and rebuilds the cache from that answer, then refills the menu. The reply carries both
// files' row counts and mtimes, and both are shown, because "it regenerated" and "it re-read the
// same bytes" otherwise look identical from here.
let modelsSetting = null;

// Two ages, not one. The press moves BOTH files, and a single "1d old" let the list's age stand for the
// price cache's — while neither of them dated the snapshot the ratings come from. The list's age is the
// newest provider stamp the gateway wrote into provider_models_cache.json; the prices' age is this panel's
// own cache; the ratings are dated by the snapshot's own generatedAt, and no press can move that file.
function modelListAgeText(state) {
  return state.fetchedAt ? `list ${relTime(state.fetchedAt)} old` : "list age unknown";
}

function snapshotDate(state) {
  return state.pricingSnapshotAt ? String(state.pricingSnapshotAt).slice(0, 10) : "";
}

function modelAgeText(state) {
  if (state.pricingAge === null || state.pricingAge === undefined) return "never built";
  return `${relTime(new Date(Date.now() - state.pricingAge * 1000).toISOString())} old`;
}

function paintModelsSetting(error = null) {
  const preview = $("models-preview");
  const age = $("models-age");
  const btn = $("btn-models-refresh");
  if (!preview) return;
  const s = modelsSetting;
  if (!s) {
    if (age) age.textContent = "—";
    preview.textContent = error ? `NOT REGENERATED — ${error}` : "could not read the model list";
    preview.classList.add("bad");
    return;
  }
  if (age) age.textContent = `${modelListAgeText(s)} · prices ${modelAgeText(s)}`;
  if (btn) btn.disabled = false;
  const snapAt = snapshotDate(s);
  const fromSnapshot = s.ratedFromSnapshot || 0;
  preview.textContent = error
    ? `NOT REGENERATED — ${error}`
    : `${s.count} model${s.count === 1 ? "" : "s"} in ${(s.providers || []).length} providers · ${s.pricedCount || 0} priced · ${s.ratedCount || 0} rated` +
      (snapAt && fromSnapshot ? ` · ${fromSnapshot} row${fromSnapshot === 1 ? "" : "s"} from the OpenRouter snapshot of ${snapAt}` : "");
  preview.classList.toggle("bad", Boolean(error));
  preview.title = error ? "" : `provider list: ${s.source}${s.pricingSource ? `\nprices: ${s.pricingSource}` : ""}${snapAt ? `\nratings snapshot: ${snapAt}` : ""}`;
}

async function loadModelsSetting() {
  try {
    const r = await apiFetch("/api/models");
    modelsSetting = r.ok ? await r.json() : null;
  } catch (e) {
    modelsSetting = null;
    paintModelsSetting(e.message);
    return;
  }
  paintModelsSetting();
}

async function refreshModels() {
  const btn = $("btn-models-refresh");
  const preview = $("models-preview");
  if (btn) btn.disabled = true;
  if (preview) {
    preview.textContent = "refreshing models & prices — re-fetching every provider's live model list, then rebuilding the price cache from that answer…";
    preview.classList.remove("bad");
  }
  try {
    // Long: the gateway re-probes every authenticated provider before it answers.
    const r = await apiFetch("/api/models/refresh", { method: "POST" }, { timeoutMs: 240000 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      paintModelsSetting(d.error || `HTTP ${r.status}`);
      return;
    }
    // Re-read through the same path the menu itself uses, so the dropdown is drawing the new file.
    await loadModels();
    await loadModelsSetting();
    const b = d.before || {};
    const a = d.after || {};
    // Local wall clock, not the file's UTC stamp: a reader comparing "at 00:32" against their own clock
    // would be reading the wrong hour of the day.
    const clock = (iso) =>
      iso ? new Date(iso).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
    if (preview) {
      preview.title =
        `provider_models_cache.json: mtime ${b.models?.mtimeIso || "—"} → ${a.models?.mtimeIso || "—"}, ` +
        `rows ${b.models?.rows ?? "?"} → ${a.models?.rows ?? "?"}\n` +
        `model-prices.json: mtime ${b.pricing?.mtimeIso || "—"} → ${a.pricing?.mtimeIso || "—"}, ` +
        `priced rows ${b.pricing?.priced ?? "?"} → ${a.pricing?.priced ?? "?"}\n` +
        `the OpenRouter snapshot behind the ratings is not re-fetched by this press`;
    }
    showBanner(
      `models & prices refreshed — provider list ${b.models?.rows ?? "?"} → ${a.models?.rows ?? "?"} rows ` +
        `(${b.models?.providers ?? "?"} → ${a.models?.providers ?? "?"} providers) at ${clock(a.models?.mtimeIso)} · ` +
        `price cache ${b.pricing?.priced ?? "?"} → ${a.pricing?.priced ?? "?"} rows at ${clock(a.pricing?.mtimeIso)} · ` +
        `the OpenRouter ratings snapshot was not re-fetched`,
    );
  } catch (e) {
    paintModelsSetting(e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- the assistant reset: a dry run, then one real clear ---------------------------------------
// The third control in the Settings gateway restart row (POST /api/assistants/:id/reset, lib/assistant/reset.js).
// It is a control-plane repair, not a chat action: it settles the unknown admission that fences ONE assistant's
// session through the gateway, then drops that assistant's queued wakes and the watches it owns. It keeps the queue,
// the scratchpad, the charter and the thread — and it never starts a run.
//
// Two presses, the same shape `clearProviderKey` uses: the FIRST reads a dry run and paints every row it would
// clear, the SECOND sends the real call. The dry run is the confirmation — a window.confirm cannot show rows — and
// it stays armed for ten seconds rather than four because there is a list to read, not one word. A REFUSAL disarms
// the button: a 409 assistant_live / fence_unclearable refuses before it mutates anything, so a second press could
// only get the same answer.
//
// Five copy states, each painted from the route's own answer (no sentence is composed before a request):
//   dry run   200, ok, dryRun true            — one line per admission, watch and wake, then the keeps line
//   blocked   409 assistant_live              — a run of this assistant's is still executing
//   refused   409 fence_unclearable           — every unknown row is unnameable; nothing local is cleared
//   success   200, ok, dryRun false           — the receipt's outcome, then the resume path
//   incomplete 200, ok false, verdict incomplete — the store is still fenced; the resume path again
// The last two name `hermes --resume <thread>` with the real thread id: a fence the panel cannot move can only be
// entered from a terminal, and the copy has to say so where the reader is standing.
let resetArmTimer = null;
let resetBusy = false;

const resetPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const resetSpan = (ms) => {
  const m = Math.max(0, Math.round(Number(ms) / 60_000));
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

// The roster the select is drawn from, with Assistant #1 as the fallback the float itself uses before the first
// /api/assistant answer lands — the control never says "reset" without saying whose.
function resetRoster() {
  const list = state.assistant?.assistants;
  if (Array.isArray(list) && list.length) return list;
  return [{ id: "assistant-1", name: "Assistant #1", threadId: state.assistantThread || "panel-assistant" }];
}

function resetChosen() {
  const sel = $("reset-assistant");
  const roster = resetRoster();
  const id = String(sel?.value || "");
  return roster.find((a) => String(a.id) === id) || roster[0] || null;
}

function resetDisarm() {
  clearTimeout(resetArmTimer);
  resetArmTimer = null;
  const btn = $("btn-reset-assistant");
  if (!btn) return;
  btn.dataset.armed = "";
  btn.textContent = "Reset assistant";
  btn.classList.remove("dirty");
}

// The select, its options and the button's title. The select is HIDDEN while there is one assistant — the button's
// title and the preview still name it, so nothing is lost — and the chosen id survives a repaint of the roster.
//
// The options are rebuilt only when the ROSTER itself changed: a snapshot arrives every few seconds, and replacing a
// <select>'s children under the reader closes the dropdown they have open. A new title is safe to write every time.
let resetRosterSig = "";
function paintResetRow() {
  const sel = $("reset-assistant");
  const btn = $("btn-reset-assistant");
  if (!sel || !btn) return;
  const roster = resetRoster();
  const sig = roster.map((a) => `${a.id}:${a.name}:${a.threadId}`).join("|");
  if (sig !== resetRosterSig) {
    resetRosterSig = sig;
    const wanted = String(sel.value || "");
    sel.textContent = "";
    for (const a of roster) {
      const opt = document.createElement("option");
      opt.value = String(a.id);
      opt.textContent = String(a.name || a.id);
      opt.title = `${a.name || a.id} · ${a.threadId || ""}`;
      sel.appendChild(opt);
    }
    sel.value = roster.some((a) => String(a.id) === wanted) ? wanted : String(roster[0].id);
  }
  sel.hidden = roster.length < 2;
  const rec = roster.find((a) => String(a.id) === sel.value) || roster[0];
  btn.title =
    `Reset ${rec.name} — settle its gateway turn (the unknown admission that fences ${rec.threadId ?? "its session"}), ` +
    `drop its queued wakes and the watches it owns. Keeps its queue, notes, charter and thread. ` +
    `Two presses: the first shows a dry run, row by row, of exactly what it would clear.`;
  if (btn.dataset.armed !== "1") btn.textContent = "Reset assistant";
}

// The dry run's rows, one per thing it would clear — the whole point of the state is that a count cannot be checked
// against the store. `clear.admissions` names the run, admission, generation, card (or, for a row no card names, the
// store request id the fallback verified) and how long the run has been unknown; `clear.watches` and `clear.wakes`
// are the local half.
function resetDryLines(d, now) {
  const who = `${d.assistant?.name || "this assistant"}${d.assistant?.threadId ? ` · ${d.assistant.threadId}` : ""}`;
  const clear = d.clear || {};
  const admissions = Array.isArray(clear.admissions) ? clear.admissions : [];
  const watches = Array.isArray(clear.watches) ? clear.watches : [];
  const wakes = Array.isArray(clear.wakes) ? clear.wakes : [];
  const unnameable = Array.isArray(d.block?.unnameable) ? d.block.unnameable : [];
  const queued = Array.isArray(d.block?.queued) ? d.block.queued : [];
  const unreadable = Array.isArray(d.block?.unreadable) ? d.block.unreadable : [];
  const keep = d.keep || {};
  const lines = [who];
  if (!admissions.length && !watches.length && !wakes.length) {
    lines.push(d.verdict === "clean" ? "nothing is fenced. Nothing to clear." : "nothing this endpoint can clear.");
  }
  if (admissions.length) {
    lines.push(`would clear ${resetPlural(admissions.length, "admission", "admissions")}:`);
    for (const a of admissions) {
      const bits = [`run ${a.runId}`, `admission ${a.admissionId}`];
      bits.push(a.executionGeneration == null ? "generation null" : `generation ${a.executionGeneration}`);
      if (a.card?.id) bits.push(`card ${a.card.id}${a.card.status ? ` ${a.card.status}` : ""}`);
      if (!a.card?.id && a.evidence?.namedBy === "store-request-id") bits.push("named by its store request id");
      const answers = Array.isArray(a.evidence?.answers) ? a.evidence.answers : [];
      const first = answers.length ? Number(answers[0][0]) : NaN;
      if (Number.isFinite(first)) bits.push(`unknown for ${resetSpan(now - first)}`);
      lines.push(`  · ${bits.join(" · ")}`);
    }
  }
  if (watches.length) {
    const own = watches.filter((w) => w.thread && w.thread === d.assistant?.threadId).length;
    const where = watches.length === 1 ? "" : ` (${own} on its own turn, ${watches.length - own} on workers)`;
    lines.push(`would drop ${resetPlural(watches.length, "watch", "watches")}${where}:`);
    for (const w of watches) lines.push(`  · ${w.thread} — ${w.title}${w.state ? ` (${w.state})` : ""}`);
  }
  if (wakes.length) {
    lines.push(`would drop ${resetPlural(wakes.length, "queued wake", "queued wakes")}:`);
    for (const w of wakes) {
      const age = Number.isFinite(Number(w.ageMs)) ? `, queued ${resetSpan(w.ageMs)} ago` : "";
      lines.push(`  · ${w.reason || "(no reason)"}${w.rule ? ` (rule ${w.rule}${age})` : age ? ` (${age.slice(2)})` : ""}`);
    }
  }
  const q = keep.queue?.rows ?? 0;
  const s = keep.scratchpad || {};
  const c = keep.charter || {};
  lines.push(`keeps: ${resetPlural(q, "queue row", "queue rows")} · ${s.notes ?? 0} notes · ${s.rules ?? 0} rules · charter ${c.chars ?? 0} chars`);
  if (unnameable.length) {
    const rows = unnameable.map((a) => `admission ${a.admissionId} · generation ${a.generation} · seq ${a.seq}`);
    lines.push(
      `blocked: ${resetPlural(unnameable.length, "admission", "admissions")} no card here names (${rows.join("; ")}) — ` +
        `this endpoint can settle an admission only through the run that owns it, so it will clear nothing local and report incomplete.`,
    );
  }
  if (unreadable.length) {
    const rows = unreadable.map((r) => `run ${r.runId}${r.code ? ` (${r.code})` : ""}`);
    lines.push(`unreadable: ${resetPlural(unreadable.length, "card", "cards")} whose run the gateway did not answer — ${rows.join("; ")}`);
  }
  if (queued.length) {
    lines.push(`also: ${resetPlural(queued.length, "turn", "turns")} queued behind the fence will start when it clears (generation ${queued.map((q) => (q.executionGeneration == null ? "null" : q.executionGeneration)).join(", ")}).`);
  }
  // With nothing to clear there is no second press to ask for: the same sentence over an empty list would invite the
  // reader to confirm a reset that clears nothing.
  if (admissions.length || watches.length || wakes.length || unnameable.length) {
    lines.push(
      d.verdict === "blocked"
        ? `press again to reset — it will settle what it can and report incomplete. The rest needs a terminal: hermes --resume ${d.assistant?.threadId || "this session"}`
        : "press again to reset. The settled turn is reported interrupted and is not replayed — resend it if you still want it.",
    );
  }
  return lines;
}

// The five copy states, from the route's answer. `kind` is what a probe asserts on; `bad` is whether the preview
// is painted as a refusal, which is the panel's own class and not a claim about the gateway.
function resetCopyView(body, status, now = Date.now()) {
  const d = body && typeof body === "object" ? body : {};
  const code = String(d.code || "");
  const err = String(d.error || "").trim();
  const who = d.assistant?.name || "the assistant";
  const thread = d.assistant?.threadId || d.thread || "this session";
  const resume = `hermes --resume ${thread}`;

  if (status === 409 && code === "assistant_live") {
    return {
      kind: "blocked",
      bad: true,
      lines: [err || `not reset — ${who} has a run still executing.`, "nothing was cleared — the reset refuses before it mutates anything. Press again once that turn has ended."],
    };
  }
  if (status === 409 && code === "fence_unclearable") {
    const rows = (Array.isArray(d.admissions) ? d.admissions : []).map(
      (a) => `  · admission ${a.admissionId} · generation ${a.generation} · seq ${a.seq} · owner epoch ${a.ownerEpoch}`,
    );
    return { kind: "refused", bad: true, lines: [err || `not reset — the fence on ${thread} is held by an admission no card here names.`, ...(rows.length ? ["the admissions it could not name:", ...rows] : [])] };
  }
  if (status === 200 && d.dryRun === true && d.ok === true) {
    return { kind: "dry", bad: d.verdict === "blocked", lines: resetDryLines(d, now) };
  }
  if (status === 200 && d.ok === true) {
    const cleared = d.cleared || {};
    const admissions = Array.isArray(cleared.admissions) ? cleared.admissions : [];
    const watches = Array.isArray(cleared.watches) ? cleared.watches : [];
    const wakes = Array.isArray(cleared.wakes) ? cleared.wakes : [];
    const receipt = (Array.isArray(d.receipts) ? d.receipts.find((r) => r.ok)?.receipt : null) || {};
    const outcome = receipt.outcome || "interrupted";
    const keep = d.kept || {};
    const q = keep.queue?.rows ?? 0;
    const s = keep.scratchpad || {};
    const c = keep.charter || {};
    return {
      kind: "success",
      bad: false,
      lines: [
        `reset — ${who}: ${resetPlural(admissions.length, "admission", "admissions")} settled (${outcome}; the projection now reads cancelled), ` +
          `${resetPlural(watches.length, "watch", "watches")} dropped, ${resetPlural(wakes.length, "wake", "wakes")} dropped. ` +
          `Kept ${resetPlural(q, "queue row", "queue rows")}, the notes (${s.notes ?? 0} notes, ${s.rules ?? 0} rules) and the charter (${c.chars ?? 0} chars).`,
        "If a panel turn is still refused with 409 permission_denied, the session is the CLI's:",
        `continue it with ${resume}`,
        "the settled turn is reported interrupted and is not replayed — resend it if you still want it.",
      ],
    };
  }
  if (status === 200 && d.ok === false && String(d.verdict || "") === "incomplete") {
    return {
      kind: "incomplete",
      bad: true,
      lines: [
        err || `reset INCOMPLETE — the session ${thread} is still fenced, so nothing local was cleared.`,
        `still fenced — a terminal is the only way into that session now: ${resume}`,
        "resume reopens the conversation; it does not replay the lost turn, so send that prompt again.",
      ],
    };
  }
  return { kind: "error", bad: true, lines: [`reset NOT DONE — ${err || `the panel answered HTTP ${status}`}`] };
}

function paintResetPreview(body, status) {
  const preview = $("reset-preview");
  if (!preview) return null;
  const view = resetCopyView(body, status, Date.now());
  preview.textContent = view.lines.join("\n");
  preview.classList.toggle("bad", view.bad);
  return view;
}

// The press. First: arm, read the dry run, paint it. Second: disarm, send the real call, paint the outcome. Only
// THIS button disables for the length of its own request; the two restart buttons beside it stay pressable.
async function resetAssistant(btn) {
  const rec = resetChosen();
  const preview = $("reset-preview");
  if (!rec || resetBusy) return;
  const armed = btn?.dataset.armed === "1";
  if (!armed) {
    resetDisarm();
    if (btn) {
      btn.dataset.armed = "1";
      btn.textContent = `reset ${rec.name}?`;
      btn.classList.add("dirty");
      btn.disabled = true;
    }
    resetBusy = true;
    resetArmTimer = setTimeout(() => resetDisarm(), 10_000);
    if (preview) {
      preview.textContent = `reading a dry run for ${rec.name}…`;
      preview.classList.remove("bad");
    }
    try {
      const r = await apiFetch(`/api/assistants/${encodeURIComponent(rec.id)}/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true, reason: `reader pressed "Reset ${rec.name}" in Settings → Gateway` }),
      });
      const d = await r.json().catch(() => ({}));
      paintResetPreview(d, r.status);
      // A refusal is final for this arm: the route refuses before it mutates anything, so the second press would
      // ask the same question and get the same answer.
      if (!r.ok || !d.ok) resetDisarm();
    } catch (e) {
      if (preview) {
        preview.textContent = `reset NOT READ — ${e.message}`;
        preview.classList.add("bad");
      }
      resetDisarm();
    } finally {
      resetBusy = false;
      if (btn) btn.disabled = false;
    }
    return;
  }

  resetDisarm();
  resetBusy = true;
  if (btn) btn.disabled = true;
  if (preview) {
    preview.textContent = `resetting ${rec.name}…`;
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(`/api/assistants/${encodeURIComponent(rec.id)}/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: `reader pressed "Reset ${rec.name}" in Settings → Gateway` }),
    });
    const d = await r.json().catch(() => ({}));
    const view = paintResetPreview(d, r.status);
    if (view?.kind === "success") showBanner(`reset: ${rec.name}`);
    else if (view?.kind === "incomplete") showBanner(`reset incomplete: ${rec.name}`);
    else if (view?.kind === "blocked" || view?.kind === "refused") showBanner(`reset refused: ${rec.name}`);
  } catch (e) {
    if (preview) {
      preview.textContent = `reset NOT DONE — ${e.message}`;
      preview.classList.add("bad");
    }
  } finally {
    resetBusy = false;
    if (btn) btn.disabled = false;
    paintResetRow();
  }
}
// ---- end the assistant reset

// ---- the approval window -------------------------------------------------------------------
// approvals.timeout is not a panel preference like the fonts above it. The gate that waits for a
// human runs inside the GATEWAY that is executing the turn, so the server reads and writes the
// gateway's own Hermes config.yaml; the panel only shows what that file says. Which is also why this
// control can be unavailable — a gateway on another machine keeps its own file.
let approvalState = null;

// The same wording the gateway uses for its own timeout notice: 600 → "10 minutes", 7200 → "2 hours".
function humanWindow(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s && s % 3600 === 0) return `${s / 3600} hour${s / 3600 === 1 ? "" : "s"}`;
  if (s && s % 60 === 0) return `${s / 60} minute${s / 60 === 1 ? "" : "s"}`;
  return `${s} second${s === 1 ? "" : "s"}`;
}

function paintApprovalSetting(note = "", bad = false) {
  const s = approvalState;
  if (!s) return;
  const input = $("approval-timeout");
  if (input) {
    // A rejected save must leave what was typed in the box: snapping back to the stored number reads
    // as "it saved that instead", when the save is exactly what failed.
    if (!bad && document.activeElement !== input) input.value = s.timeoutSeconds;
    input.disabled = !s.editable;
    input.min = String(s.minSeconds || 15);
    input.max = String(s.maxSeconds || 86400);
  }
  const save = $("btn-approval-save");
  if (save) {
    save.disabled = !s.editable;
    // Armed whenever the box differs from the file — including after a rejection, where the typed
    // value is still sitting there unsaved and the button must not look inert.
    save.classList.toggle("dirty", Boolean(input) && String(input.value) !== String(s.timeoutSeconds));
  }
  const preview = $("approval-preview");
  if (preview) {
    const bits = [`${humanWindow(s.timeoutSeconds)} · ${s.timeoutSeconds} s`];
    bits.push(s.fromFile ? "set in config.yaml" : "the gateway's built-in default (no timeout in config.yaml)");
    if (s.mode && s.mode !== "manual") bits.push(`approvals.mode ${s.mode} — only the asks that still happen get this window`);
    preview.textContent = bad
      ? `NOT SAVED — ${note}. config.yaml still says ${s.timeoutSeconds} s.`
      : note
        ? `${note} — ${bits.join(" · ")}`
        : bits.join(" · ");
    preview.classList.toggle("bad", bad);
    preview.title = s.configPath;
  }
  // The description lives on the row as a tooltip now; this keeps the live half of it (where the number is
  // written, or why it cannot be written here) in the same place.
  const rowEl = $("approval-row");
  if (rowEl) {
    const base = "How long a permission prompt waits for you before it fails closed — if it expires, nothing runs.";
    rowEl.title = s.editable
      ? `${base} Written to ${s.configPath}, which the gateway re-reads, so the next prompt uses it without a restart.`
      : `${base} ${s.reason || "This window cannot be changed from here"} — nothing is written.`;
  }
}

async function loadApprovalSetting() {
  try {
    const r = await apiFetch("/api/settings/approvals");
    approvalState = await r.json();
    paintApprovalSetting();
  } catch (e) {
    const preview = $("approval-preview");
    if (preview) {
      preview.textContent = `could not read the approval window: ${e.message}`;
      preview.classList.add("bad");
    }
  }
}

async function saveApprovalSetting() {
  const input = $("approval-timeout");
  if (!input || !approvalState?.editable) return;
  const preview = $("approval-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutSeconds: Number(input.value) }),
    });
    const d = await r.json();
    if (!r.ok) {
      // Keep what the file still says in approvalState, so a rejected value can never look saved.
      paintApprovalSetting(d.error || `HTTP ${r.status}`, true);
      return;
    }
    approvalState = d;
    paintApprovalSetting(d.note || "saved");
  } catch (e) {
    paintApprovalSetting(e.message, true);
  }
}

// ---- the Matrix bridge ------------------------------------------------------------------------
// A PROCESS, not a setting. The bridge is a standalone Python program (Matrix + E2EE + the Hermes CLI), and this
// tab starts and stops it without learning anything about the protocol: every fact drawn here came back from
// GET /api/settings/matrix, and the page never sees a credential — `credentialsPresent` is a boolean.
//
// The liveness rule the whole block turns on: a pid FILE is not a process. The server asks the OS about the pid it
// recorded, so a record a crash left behind reads as `stalePid` and never as running; the row says so, and Start is
// offered again.
//
// Polling is on the page's existing 30 s clock (the safety-net resync below), never a timer of this block's own: a
// second interval for one row is exactly the kind of thing that turns a quiet page into a busy one.
let matrixState = null;
let matrixBusy = "";
// The markup's own title, kept once so a disabled control can carry its reason without losing what it does.
const MATRIX_TITLES = {};
function matrixTitle(id) {
  const el = $(id);
  if (!el) return "";
  if (!MATRIX_TITLES[id]) MATRIX_TITLES[id] = el.title;
  return MATRIX_TITLES[id];
}

function matrixSettingsShowing() {
  const panel = $("settings");
  if (!panel || panel.classList.contains("hidden")) return false;
  // The tab strip's own record, not a second selector: `settingsTabPanels` is what the page uses to decide which
  // one is drawn, so this cannot disagree with it about which tab is on screen.
  const gateway = settingsTabPanels().find((p) => p.dataset.settingsGroup === "gateway");
  return Boolean(gateway && !gateway.hidden);
}

function paintMatrix(note = "", bad = false) {
  const s = matrixState;
  if (!s) return;
  const dot = $("matrix-dot");
  if (dot) {
    dot.classList.toggle("ok", Boolean(s.running));
    dot.classList.toggle("bad", !s.running && (!s.scriptPresent || !s.pythonPresent));
    dot.classList.toggle("warn", !s.running && Boolean(s.scriptPresent && s.pythonPresent && s.stalePid));
    dot.title = s.running
      ? `running as pid ${s.pid}`
      : s.stalePid
        ? `not running — pid ${s.stalePid} was left behind and that process is gone`
        : "not running";
  }
  const stateEl = $("matrix-state");
  if (stateEl) {
    stateEl.textContent = matrixBusy || (s.running ? `running · pid ${s.pid}` : s.stalePid ? "stopped · stale pid" : "stopped");
  }
  const roomEl = $("matrix-room");
  if (roomEl) {
    const bits = [
      s.roomId ? `room ${s.roomId}` : "NO ROOM SET — Start and Run self-test refuse until the Room field below has an !id:server address",
      s.credentialsPresent ? "bridge.env present" : "bridge.env missing — the bridge will refuse to log in",
      s.autoStart ? "auto-start with the panel on" : "auto-start with the panel off",
    ];
    if (s.running) bits.push(`pid ${s.pid}`);
    else if (s.stalePid) bits.push(`pid ${s.stalePid} is stale — a stale record is not a running bridge`);
    if (s.boot && s.boot.note) bits.push(`boot: ${s.boot.note}`);
    roomEl.textContent = bits.join(" · ");
    roomEl.title = roomEl.textContent;
  }
  // The four fields the save route owns. A focused input is never overwritten under the reader's cursor, and the
  // save's answer is this same state, so a repaint after a save shows what the server actually stored.
  const fields = { "matrix-script-path": s.scriptPath, "matrix-python-path": s.pythonPath, "matrix-room-id": s.roomId };
  for (const [id, value] of Object.entries(fields)) {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = value || "";
  }
  const auto = $("matrix-autostart");
  if (auto) auto.checked = Boolean(s.autoStart);
  const pathsEl = $("matrix-paths");
  if (pathsEl) {
    pathsEl.textContent = `pid file ${s.pidFile || "(not derived)"} · log ${s.logFile || "(not derived)"}`;
    pathsEl.title = "The panel's own pid file and log. The four fields above are the only matrix settings this page writes; these two paths are derived from the panel's state folder.";
  }
  const start = $("btn-matrix-start");
  if (start) {
    const why = s.running
      ? `already running as pid ${s.pid} — press Stop first`
      : !s.scriptPath
        ? "no bridge script configured — set matrix.scriptPath in config.json"
        : !s.scriptPresent
          ? `the script is not at ${s.scriptPath} — set matrix.scriptPath in config.json`
          : !s.pythonPath
            ? "no interpreter configured — set matrix.pythonPath in config.json"
            : !s.pythonPresent
              ? `the interpreter is not at ${s.pythonPath} — set matrix.pythonPath in config.json`
              : !s.roomId
                ? "no room set — put the bridge's room in the Room field below (an !id:server address) and press Save"
                : null;
    start.disabled = Boolean(why) || Boolean(matrixBusy);
    start.title = why ? `${matrixTitle("btn-matrix-start")} — UNAVAILABLE: ${why}` : matrixTitle("btn-matrix-start");
  }
  const stop = $("btn-matrix-stop");
  if (stop) {
    // Never disabled: it is safe with nothing running, and a button that vanishes when a pid file lies is the one
    // the reader needs. A live pid makes the press meaningful.
    stop.disabled = Boolean(matrixBusy);
    stop.title = s.running
      ? `${matrixTitle("btn-matrix-stop")} — now: pid ${s.pid}`
      : `${matrixTitle("btn-matrix-stop")} — nothing is running right now, so the press reports that and clears any stale pid file.`;
  }
  const test = $("btn-matrix-test");
  if (test) {
    test.disabled = Boolean(matrixBusy) || !s.scriptPresent || !s.pythonPresent;
    test.title = !s.scriptPresent || !s.pythonPresent
      ? `${matrixTitle("btn-matrix-test")} — UNAVAILABLE: the script or interpreter is not on disk, so the test could not run`
      : matrixTitle("btn-matrix-test");
  }
  const preview = $("matrix-preview");
  if (preview) {
    const st = s.selfTest || {};
    const summary = st.ok === true
      ? `self-test passed${st.at ? ` (${new Date(st.at).toLocaleTimeString()})` : ""}`
      : st.ok === false
        ? `self-test FAILED${st.exitCode == null ? "" : ` — exit ${st.exitCode}`}`
        : "self-test has not been run in this panel — press Run self-test";
    // A boot spawn that failed is the one line this block must never swallow: it happened before the page was
    // open, so nothing else would ever say it.
    const bootLine = s.boot && s.boot.error ? `AUTO-START FAILED at boot — ${s.boot.error}` : "";
    const head = bad ? `NOT DONE — ${note}` : note ? `${note}\n${summary}` : summary;
    preview.textContent = [bootLine, head].filter(Boolean).join("\n");
    if (st.output) preview.textContent += `\n${st.output}`;
    preview.classList.toggle("bad", Boolean(bad) || st.ok === false || Boolean(s.boot && s.boot.error));
    preview.title = "The last --self-test this panel ran, everything it printed, and a boot spawn that failed.";
  }
  const logEl = $("matrix-log");
  if (logEl) {
    const lines = Array.isArray(s.log) ? s.log : [];
    logEl.textContent = lines.length ? lines.join("\n") : "no output yet — the bridge's stdout and stderr land here once it is started";
    logEl.title = s.logFile ? `the last 40 lines of ${s.logFile}` : "the panel's own log file";
  }
}

async function loadMatrixStatus() {
  try {
    const r = await apiFetch("/api/settings/matrix");
    matrixState = await r.json();
    paintMatrix();
  } catch (e) {
    const preview = $("matrix-preview");
    if (preview) {
      preview.textContent = `could not read the Matrix bridge's state: ${e.message}`;
      preview.classList.add("bad");
    }
  }
}

async function matrixPress(route, busy, timeoutMs = 20000) {
  if (matrixBusy) return;
  matrixBusy = busy;
  paintMatrix();
  let settled = false;
  try {
    const r = await apiFetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, { timeoutMs });
    const d = await r.json().catch(() => ({}));
    matrixBusy = "";
    settled = true;
    // Every answer carries the state, refusals included — a 409 while a live pid exists must leave the row saying
    // exactly what it said before, with the refusal's own words beside it.
    if (typeof d.running === "boolean") matrixState = d;
    if (!r.ok) {
      paintMatrix(d.error || `HTTP ${r.status}`, true);
      return;
    }
    const done = route.endsWith("/start") ? "started" : route.endsWith("/stop") ? d.note || "stopped" : "self-test finished";
    paintMatrix(d.note && !route.endsWith("/start") ? d.note : done);
  } catch (e) {
    matrixBusy = "";
    settled = true;
    paintMatrix(e.message, true);
  } finally {
    // A throw after the busy flag was cleared must not leave the buttons dead.
    if (!settled) matrixBusy = "";
  }
}

// The save the four fields write through. One POST, one answer: the route replies with the GET shape, so the block
// repaints from what the server stored rather than from what was typed. A refusal (a field the route does not
// accept, a config.json another process holds open) keeps the typed values on screen with the reason beside them,
// because silently reverting a field the reader just edited is how a save gets pressed twice.
async function matrixSave() {
  if (matrixBusy) return;
  // Read the four fields BEFORE the busy repaint. paintMatrix() refills every input from the last state the server
  // sent, and pressing this button has already moved the focus off them — reading after that repaint would save what
  // the panel already had and silently drop the edit. (Measured in a browser probe: the room field was cleared, Save
  // was pressed, and the answer came back with the old room.)
  const body = {
    scriptPath: $("matrix-script-path")?.value ?? "",
    pythonPath: $("matrix-python-path")?.value ?? "",
    roomId: $("matrix-room-id")?.value ?? "",
    autoStart: Boolean($("matrix-autostart")?.checked),
  };
  matrixBusy = "saving…";
  paintMatrix();
  try {
    const r = await apiFetch("/api/settings/matrix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    matrixBusy = "";
    if (typeof d.running === "boolean") matrixState = d;
    if (!r.ok) {
      paintMatrix(d.error || `HTTP ${r.status}`, true);
      return;
    }
    paintMatrix(d.note || "saved");
  } catch (e) {
    matrixBusy = "";
    paintMatrix(e.message, true);
  }
}

// ---- how often the closed part of the board re-sorts -----------------------------------------
function paintReorderSetting(note = "") {
  const input = $("reorder-every");
  const every = reorderSeconds();
  if (input && document.activeElement !== input) input.value = String(every);
  const preview = $("reorder-preview");
  if (preview) {
    preview.textContent = note
      ? `${note} — ${every ? `re-sorting every ${humanWindow(every)}` : "re-sorting off"}`
      : every
        ? `closed folders and projects re-sort every ${humanWindow(every)} (${every} s)`
        : "closed folders and projects stay where they are (0 = off)";
  }
}

function saveReorderSetting(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    paintReorderSetting("NOT SAVED — give a number of seconds, 0 for off");
    return;
  }
  const clamped = Math.min(REORDER_MAX, Math.round(n));
  try {
    localStorage.setItem(REORDER_KEY, String(clamped));
  } catch {
    paintReorderSetting("NOT SAVED — this browser refused to store the setting");
    return;
  }
  startReorderClock();
  paintReorderSetting(clamped === Math.round(n) ? "saved" : `saved, clamped to ${REORDER_MAX} s`);
}

// ---- how far back the row ranking averages ------------------------------------------------
function paintRankWindow() {
  const input = $("rank-window");
  if (input && document.activeElement !== input) input.value = String(state.rankWindowSeconds);
}

function saveRankWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    paintRankWindow();
    showBanner(`Rank window left at ${state.rankWindowSeconds} s — give a number of seconds`);
    return;
  }
  // The window is shared by every liveness ranking: it is one answer to one question, how far back the board
  // looks when it decides what is busiest.
  const clamped = Math.max(RANK_WINDOW_MIN, Math.min(RANK_WINDOW_MAX, Math.round(n)));
  try {
    localStorage.setItem(RANK_WINDOW_KEY, String(clamped));
  } catch {
    /* private mode: the choice just will not persist */
  }
  state.rankWindowSeconds = clamped;
  // An explicit change re-reads the evidence at once rather than easing over ticks: the reader asked for it.
  state.rankOrder.clear();
  tickLivenessRanks();
  paintRankWindow();
  showNote(`Rank window ${clamped} s — every liveness ranking (rows, projects, folders, agent cards) now averages over the last ${clamped} s`);
}

// ---- how many sessions the CLI's picker lists ------------------------------------------------
// Not a panel preference and not a retention policy: the store keeps every session, and this is the
// number the CLI's in-chat browser used to hardcode. It writes `sessions.list_limit`, which only the
// local CLI patch reads — so the row says so when that patch is missing, instead of saving a number
// nothing will honour.
let sessionsState = null;

function paintSessionSetting(note = "", bad = false) {
  const s = sessionsState;
  if (!s) return;
  const input = $("session-limit");
  if (input) {
    // Same as the approval window: a rejected value stays visible so it can be corrected, and the
    // line underneath says what the file actually holds.
    if (!bad && document.activeElement !== input) input.value = s.listLimit;
    input.disabled = !s.editable;
    input.min = String(s.minLimit || 1);
    input.max = String(s.maxLimit || 500);
  }
  const save = $("btn-session-limit-save");
  if (save) {
    save.disabled = !s.editable;
    save.classList.toggle("dirty", Boolean(input) && String(input.value) !== String(s.listLimit));
  }
  const preview = $("session-preview");
  if (preview) {
    const bits = [`${s.listLimit} shown in /sessions`];
    if (s.store) bits.push(`${s.store.sessions} in the store`);
    bits.push(s.fromFile ? "set in config.yaml" : "the default (config.yaml does not set it)");
    if (s.patched === false) bits.push("CLI patch missing — this number is ignored");
    preview.textContent = bad
      ? `NOT SAVED — ${note}. config.yaml still says ${s.listLimit}.`
      : note
        ? `${note} — ${bits.join(" · ")}`
        : bits.join(" · ");
    preview.classList.toggle("bad", bad || s.patched === false);
    preview.title = s.configPath;
  }
  const rowEl = $("session-row");
  if (rowEl) {
    const store = s.store
      ? `The store holds ${s.store.sessions} sessions and ${s.store.messages.toLocaleString()} messages — nothing deletes at ten. `
      : "The store could not be read. ";
    rowEl.title =
      s.patched === false
        ? `${store}That number is written to config.yaml, but the installed CLI has no patch to read it (a hermes update replaces hermes_cli/*.py) — re-apply docs/hermes-cli-session-limit.diff.`
        : `${store}This only changes how many the CLI's /sessions and /resume browser list at once.`;
  }
}

async function loadSessionSetting() {
  try {
    const r = await apiFetch("/api/settings/sessions");
    sessionsState = await r.json();
    paintSessionSetting();
  } catch (e) {
    const preview = $("session-preview");
    if (preview) {
      preview.textContent = `could not read the session list setting: ${e.message}`;
      preview.classList.add("bad");
    }
  }
}

async function saveSessionSetting() {
  const input = $("session-limit");
  if (!input || !sessionsState?.editable) return;
  const preview = $("session-preview");
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listLimit: Number(input.value) }),
    });
    const d = await r.json();
    if (!r.ok) {
      paintSessionSetting(d.error || `HTTP ${r.status}`, true);
      return;
    }
    sessionsState = d;
    paintSessionSetting(d.note || "saved");
  } catch (e) {
    paintSessionSetting(e.message, true);
  }
}

// The pickers are filled once, at start-up: a saved choice then has a real option to sit on before
// the panel is ever opened.
function initFonts() {
  for (const kind of Object.keys(FONT_SETS)) {
    const set = FONT_SETS[kind];
    const sel = $(set.select);
    if (sel && !sel.options.length) {
      sel.innerHTML = set.list.map((f) => `<option value="${esc(f.id)}">${esc(fontOptionLabel(f))}</option>`).join("");
    }
    applyFont(kind, currentFontId(kind), { save: false });
  }
  const sizeSel = $("term-size-select");
  if (sizeSel && !sizeSel.options.length) {
    sizeSel.innerHTML = TERM_SIZES.map((n) => `<option value="${n}">${n}px</option>`).join("");
  }
  const weightSel = $("term-weight-select");
  if (weightSel && !weightSel.options.length) {
    weightSel.innerHTML = TERM_WEIGHTS.map((w) => `<option value="${w.id}">${esc(w.label)}</option>`).join("");
  }
  applyTermStyle({ save: false });
  // The reasoning and skill pickers carry a "Default" first: unset is a real choice for them (the console's has none).
  for (const kind of Object.keys(TEXT_STYLES)) {
    const set = TEXT_STYLES[kind];
    const sel = set.size ? $(set.size) : null;
    if (sel && !sel.options.length) {
      sel.innerHTML = `<option value="">Default</option>${TERM_SIZES.map((n) => `<option value="${n}">${n}px</option>`).join("")}`;
    }
    retireTextStyleSize(kind);
    applyTextStyle(kind);
  }
}

// Paint the saved question-box look before the first card is drawn.
function initQLook() {
  applyQLook({}, { save: false });
}

// ---- the folders the board scans ---------------------------------------------------------------
// One row per folder the panel walks — the path, whether it is still there, and a ✕ — with an input that adds one.
// The list is this panel's own config.json (`scanRoots`) written through POST /api/settings/scan-roots, which
// re-discovers BEFORE it answers: adding a folder puts its repos on the board without a restart, and the board draws
// one expandable card per folder with that folder's path as the title.
//
// An EMPTY list is legal and is the fallback: the folder this panel's own checkout sits in. The line under the list
// says so and names the folder, because a blank list over a board that still shows projects is otherwise a mystery.
function scanRootsConfigured() {
  const list = state.settings?.scanRootsConfigured;
  return Array.isArray(list) ? list.map((p) => String(p || "")).filter(Boolean) : [];
}

// The sentence for an empty list: which folder is being scanned instead. The server names it (it is the one that
// derived the fallback), and the page only has to say it in the reader's terms.
function scanRootsFallbackSentence() {
  const p = String(state.settings?.scanRootsFallbackPath || "");
  return p
    ? `no folder named — the board scans ${p}, the folder this panel's own checkout sits in`
    : "no folder named — the board scans the folder this panel's own checkout sits in";
}

function paintScanRoots(note = "", bad = false) {
  const list = scanRootsConfigured();
  const holder = $("scan-roots");
  if (holder) {
    holder.innerHTML = list.length
      ? list
          .map((p) => {
            const d = state.scanRootsDetail.get(p.toLowerCase());
            const exists = d ? d.exists : null;
            const chip = exists == null ? "" : `<span class="settings-root-chip${exists ? "" : " bad"}">${exists ? "exists" : "missing"}</span>`;
            return `<div class="settings-root" data-scan-root="${esc(p)}">
              <span class="mono settings-root-path" title="${esc(p)}">${esc(p)}</span>${chip}
              <button type="button" class="settings-root-x" data-scan-root-remove="${esc(p)}" title="stop scanning ${esc(p)} — the projects under it leave the board">\u2715</button>
            </div>`;
          })
          .join("")
      : `<div class="settings-root-empty">no folder named</div>`;
  }
  const count = $("scan-roots-count");
  if (count) count.textContent = list.length ? `${list.length} folder${list.length === 1 ? "" : "s"}` : "fallback";
  const preview = $("scan-roots-preview");
  if (preview) {
    preview.textContent = bad
      ? `NOT SAVED — ${note}`
      : note
        ? note
        : state.settings?.scanRootsFallback
          ? `${scanRootsFallbackSentence()} · set in config.json (scanRoots), so it applies to every browser and survives a restart`
          : `one card per folder on the board · set in config.json (scanRoots), so it applies to every browser and survives a restart`;
    preview.classList.toggle("bad", bad);
  }
}

// A `settings` event (or a snapshot) from another browser can move the list, and whether each folder still exists is
// the server's to stat: one cheap read of /api/config refills both, rather than the tab inferring a folder's state.
async function refreshScanRootsAnswer() {
  try {
    const cfg = await apiFetch("/api/config").then((r) => r.json());
    applyScanRootsAnswer(cfg);
    paintScanRoots();
  } catch {
    /* the list keeps what it had; the next settings event tries again */
  }
}

async function saveScanRoots(next) {
  const preview = $("scan-roots-preview");
  if (preview) {
    preview.textContent = "saving, then re-scanning the folders…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch(
      "/api/settings/scan-roots",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roots: next }) },
      { timeoutMs: 60000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    applyScanRootsAnswer(d);
    paintScanRoots();
    const n = Array.isArray(d.scanRootsConfigured) ? d.scanRootsConfigured.length : 0;
    showBanner(
      n
        ? `folders scanned: ${n} — ${d.projects == null ? "re-reading the board" : `${d.projects} project${d.projects === 1 ? "" : "s"} found`}`
        : `folders scanned: none named — ${d.scanRootsFallbackPath || "the panel's own parent folder"}`,
    );
    // The board is drawn from the snapshot the route broadcasts; this repaint is the page that asked for it, so it
    // does not have to wait for the round trip.
    renderAll();
    return true;
  } catch (err) {
    paintScanRoots(String((err && err.message) || err), true);
    return false;
  }
}

async function addScanRootFromInput() {
  const input = $("scan-root-input");
  const typed = String(input?.value || "").trim();
  if (!typed) {
    paintScanRoots("type the path of a folder to add", true);
    return;
  }
  // The server decides whether it is a folder, whether it is absolute and whether it is already listed; the page only
  // sends the list it means and shows the sentence it gets back.
  const ok = await saveScanRoots([...scanRootsConfigured(), typed]);
  if (ok && input) input.value = "";
}

// ---- whether an agent may clean up after itself ------------------------------------------------
// The panel's own switch (config.json `agentCleanup`, POST /api/settings/cleanup): a veto ABOVE every project's own
// `releaseWorktrees` grant, and the reason the row says which projects that grant names — "on" alone would read as
// "every repository is open", which is not what the server decides. Off is the reader's answer to "I want to read and
// remove these trees myself", so nothing an agent says removes one; the row's ✕ still does.
function agentCleanupStored() {
  return state.settings?.agentCleanup !== false;
}

function paintAgentCleanup(note = "", bad = false) {
  const box = $("agent-cleanup");
  const preview = $("agent-cleanup-preview");
  const on = agentCleanupStored();
  // A rejected save leaves the box where the reader put it, saying the save failed: snapping it back reads as
  // "it saved that", when the save is exactly what failed.
  if (box && !bad) box.checked = on;
  if (!preview) return;
  const granted = Array.isArray(state.settings?.releaseProjects) ? state.settings.releaseProjects : [];
  const bits = [
    on
      ? granted.length
        ? `on — a project's own releaseWorktrees grant decides, and it names ${granted.join(", ")}`
        : "on — but no project carries a releaseWorktrees grant, so nothing is removed automatically either"
      : "off — no prompt carries RELEASE, a request is refused on the row, and a LANDED: YES is only a line in the console; the ✕ still removes a tree",
    "set in config.json (agentCleanup), so it applies to every browser and survives a restart",
  ];
  preview.textContent = bad ? `NOT SAVED — ${note}. config.json still says: ${on ? "on" : "off"}.` : note ? `${note} · ${bits.join(" · ")}` : bits.join(" · ");
  preview.classList.toggle("bad", bad);
}

// ---- initiatives: how often a change to the map asks ---------------------------------------------
// The level is the panel's own (config.json `initiativePermissions`), so it applies to every browser and to the workers,
// which have no browser: POST /api/settings/initiative-tier writes it and the initiative routes read the live object on
// every request, so a save here decides the NEXT change rather than the next boot. The card is not drawn from this: the
// level only decides whether the panel asks at all, and the page reads the answer off the 202 it gets back.
function initiativeTierStored() {
  const id = String(state.settings?.initiativeTier || "all").toLowerCase();
  const tiers = Array.isArray(state.settings?.initiativeTiers) ? state.settings.initiativeTiers : [];
  return tiers.some((t) => t.id === id) ? id : "all";
}

function paintInitiativeTier(note = "", bad = false) {
  const box = $("initiative-tier");
  const preview = $("initiative-tier-preview");
  const id = initiativeTierStored();
  const tiers = Array.isArray(state.settings?.initiativeTiers) ? state.settings.initiativeTiers : [];
  const row =
    tiers.find((t) => t.id === id) ||
    { label: "ask me for everything", hint: "every create, edit, attach and detach waits for your answer" };
  // A rejected save leaves the select where the reader put it, saying the save failed: snapping it back reads as "it
  // saved that", when the save is exactly what failed.
  if (box && !bad) box.value = id;
  if (!preview) return;
  preview.textContent = bad
    ? `NOT SAVED - ${note}. config.json still says: ${row.label}.`
    : `${row.label} - ${row.hint}. The card itself never changes, any change is in the initiative's history with its actor and time, and this applies to your presses and to every assistant's.`;
  preview.classList.toggle("bad", bad);
}
