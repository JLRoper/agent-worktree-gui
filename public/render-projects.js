// render-projects.js - the board's project structure: a folder's card, a project's section, the worktree rows
// inside it, and the order all three sit in. Cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js held 19,886 lines and one file was one lane: every row repaint, every
// project re-rank and every scan tick landed in it. This is step 7 of the order of work in
// docs/reports/module-map-2026-11-07.html ("render-projects.js, then render-jobs.js. The two big cuts, last,
// because they are the ones that most want the helper files in place first"), and it takes the project half
// whole: 1,386 lines moved line for line. Not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   a folder's card        rootScanChip and rootChips, the counts on a folder's header, and rootSection, the
//                          accordion one scan root draws: its open state, its recent-only view, and one project
//                          section per project inside it
//   a project's section    projectSection, the whole section.project node: the head and its chips, the
//                          local-main and remote-tip line, the live board PIDs, the split table and the legend;
//                          and refreshChips, the one strip repainted in place instead of rebuilt
//   the worktree row       rowHtml, the template every cell of a row is written into, and the two clock columns
//                          under it: RING_C, noteScan, eventLifeAt, lifeAtFor, ringState, ringOffset, ringStroke,
//                          lifeCellHtml and paintLifeCell (the age number and the chips), nextReadCellHtml and
//                          paintNextReadCell (the ring and its countdown). rowKeyForThread, pulseRow and pulseProject
//                          are the lookups and the two green pulses an event and a scan both use
//   children under a       childTreeOf, groupCtxOf and nestRowKeys (which row hangs under which, and the drawing
//   parent                 order that keeps a child directly under its parent), foldTitle, foldButtonHtml,
//                          paintFoldButton, paintRowGroup, paintUnder, markUnder, syncChildGroups and
//                          toggleChildFold, the one fold that only hides
//   where a folder sits    projectActivity, folderActivity, shownInRoot, projectRanks, sortedProjects,
//                          pinOpenProjects, reorderFrame and queueReorderProjects, plus reorderProjects itself
//                          and the three child reads under it (childrenMatching, boardGroups, groupBody)
//   where a row and its    stabilizeOn and STABILIZE_KEY (a list freezes while something in it is open),
//   cards sit              projectHasOpenRow, rowHasOpenCard, orderedAgents, rememberAgentOrder and
//                          rememberAgentOrders, the row and card re-rank (reorder), the two move flashes
//                          (flashMovedByKey, flashMoved), the SSE batch (pendingRows, rowFrame, queueRow), the
//                          detail signature (DETAIL_VOLATILE, stableStringify, rowDetailSig), placeRow,
//                          removeRow and renderProjectRows
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state                  the page's state literal: projects, rows, expanded, expandedProjects, pollGap,
//                          lastScanAt, eventLife, agentOrder, foldedParents, detailEls and the rest
//   the small formatters   esc, keyOf, relTime and fmtDur (public/core/dom-format.js), and the names app.js
//                          still declares: normPath, rootOf, recentDays, flashRowMs and flashProjectMs
//   the page's helpers     $ and projectNode, rowNode and restartClassAnimation (public/dom.js),
//                          captureCardSelection (public/dom.js), captureTyping and restoreTyping, and the
//                          scroll books in public/board/console.js: holdScrolls, releaseScrolls, placeInOrder
//   the row's own          sigChips, agentBadgeHtml, chipsHtml, headTitle, hostChipHtml, hostPanelHtml,
//   painters               chartHeaderHtml and refreshTopToggle (public/charts.js), paintRefreshOffers,
//                          applyPendingFocus (public/settings.js), saveFoldedParents, saveExpandedProjects
//   the ranking            projectRankCtx and orderedByRank, the sliding average a folder, a project and a
//                          card are all ordered by; panelFor and isRowLive, the two liveness reads
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `let` is a binding every other script reads by bare
// name. This file DECLARES ONLY: no top-level statement, no listener and no read of an app.js binding while it
// loads (RING_C, reorderFrame, STABILIZE_KEY, pendingRows, rowFrame and DETAIL_VOLATILE are literal
// initialisers), so being loaded before app.js costs nothing. public/app.js re-exports these names on
// window.WMApp.projects.

// ---- project ordering + the green "+" ------------------------------------------
// Projects are listed most-recently-worked-on first: the newest of the repo's own activity
// (last commit / git index mtime) and the newest file edit inside any of its worktrees.
function projectActivity(p) {
  let best = Date.parse(p.activityAt || "") || 0;
  for (const r of state.rows.values()) {
    if (r.project !== p.name) continue;
    best = Math.max(best, Date.parse(r.lastEdit || "") || 0, Date.parse(r.lastCommit || "") || 0);
  }
  return best;
}

// A folder's place on the board is its busiest project's activity. A folder with no project yet (a root the reader
// just named, or one whose repos were all moved away) has none: it sorts last, and its card says it is empty.
function folderActivity(list) {
  return list && list[0] ? projectActivity(list[0]) : 0;
}

// A folder's All/7d button is a VIEW of the server's tier, not a second decision: discovery stamps `tier` on
// every project from its last commit (lib/tiers.js), and this only chooses whether to draw the old ones. The
// page holds no cutoff and no recency rule of its own, so the view and the treatment cannot disagree; a project
// with no tier yet (a snapshot from a build before the gate) is drawn, never hidden.
function shownInRoot(root, projects) {
  if (!state.recentRoots.has(root)) return projects;
  return projects.filter((p) => p.tier !== "old");
}

// Where a project belongs in its folder: a panel agent working there leads, then any live worktree,
// then the rest by newest activity. Activity alone never moved a project that agents were working in
// — a turn leaves no commit or file edit behind, so "several agents busy here" ranked like "untouched".
function projectRanks() {
  const rank = new Map();
  for (const p of state.projects.values()) rank.set(p.name, { tier: 2, activity: Date.parse(p.activityAt || "") || 0 });
  for (const r of state.rows.values()) {
    const cur = rank.get(r.project);
    if (!cur) continue;
    if (panelFor(r)?.running) cur.tier = 0;
    else if (cur.tier > 1 && isRowLive(r)) cur.tier = 1;
    cur.activity = Math.max(cur.activity, Date.parse(r.lastEdit || "") || 0, Date.parse(r.lastCommit || "") || 0);
  }
  return rank;
}

// A rebuild regenerates every section in ranked order, which loses the one rule the live reorder keeps:
// the project you have OPEN stays where it is. Without this the 30-second resync slid the project being
// read to the top the moment its agent did something — an open section must never move under the reader.
// `prevNames` is that folder's project order from before the rebuild.
function pinOpenProjects(body, prevNames) {
  if (!body || !prevNames || !prevNames.length) return;
  const els = [...body.querySelectorAll(":scope > section.project")];
  if (!els.length) return;
  const byName = new Map(els.map((el) => [el.dataset.project, el]));
  const pinned = new Map();
  prevNames.forEach((n, i) => {
    if (!projectDrawsOpen(n) || i >= els.length) return;
    const el = byName.get(n);
    if (el) pinned.set(i, el);
  });
  if (!pinned.size) return;
  const held = new Set(pinned.values());
  const free = els.filter((el) => !held.has(el));
  const want = [];
  let f = 0;
  for (let i = 0; i < els.length; i++) want.push(pinned.has(i) ? pinned.get(i) : free[f++]);
  if (want.every((el, i) => el === els[i])) return;
  for (const el of want) body.appendChild(el);
}

function sortedProjects() {
  const rank = projectRanks();
  const ctx = projectRankCtx(rank, Date.now());
  const byName = new Map([...state.projects.values()].map((p) => [p.name, p]));
  return orderedByRank("projects", [...byName.keys()], ctx).map((n) => byName.get(n)).filter(Boolean);
}

// Re-order the board live, one folder at a time. Only the projects the reader has OPEN hold their
// place (moving one under a cursor mid-read is worse than a stale order); every other project sorts
// into the gaps around them, which is what brings a busy project to the top while you read another.
// Project reordering is a full sort of every folder, and row events arrive in bursts, so coalesce it
// into one frame. Hidden tabs never paint: apply at once there rather than leave the order stale.
let reorderFrame = 0;
function queueReorderProjects() {
  if (reorderFrame) return;
  const flush = () => {
    reorderFrame = 0;
    reorderProjects();
  };
  if (document.hidden) return flush();
  reorderFrame = requestAnimationFrame(flush);
}

// ---- the board's own children, not its subtree -----------------------------------------------------------------
// The board is #projects > section.root-group > div.root-body > section.project (the root-group template), and a
// re-rank only ever moves those children. A querySelectorAll below the host visits every node under it, consoles and
// open cards included. reorderProjects is queued after every batch of placed rows and ran 393 times a minute on the
// reader's board; its four such searches a call were 160 ms a minute of native search (0.48.1). On that board the
// children reads find exactly the same nodes in the same order (1 folder, 1 body, 105 sections).
function childrenMatching(el, sel) {
  const out = [];
  for (const c of el?.children || []) if (c.matches(sel)) out.push(c);
  return out;
}
function boardGroups(host = $("projects")) {
  return childrenMatching(host, "section.root-group");
}
function groupBody(group) {
  return childrenMatching(group, ".root-body")[0] || null;
}

function reorderProjects() {
  const host = $("projects");
  if (!host) return;
  // Moving a section or a folder moves the cards inside them, and that drops a selection standing in one.
  const heldSelection = captureCardSelection();
  // It also drops the caret: re-appending a project section or a folder takes every card and the inline add-agent
  // field inside it out of the page, and a detached field is blurred. Read both before the moves, put them back after.
  const typing = captureTyping(host);
  const rank = projectRanks();
  const ctx = projectRankCtx(rank, Date.now());
  // An open project keeps its exact slot — opening one is you saying "this is the one I am reading",
  // so it must not slide out from under the cursor. Everything closed sorts into the gaps around it:
  // one open project is no reason to hold the rest of the folder still. The order itself is the stored
  // smoothed one, so a project climbs or slides a place a tick rather than jumping on its newest line.
  const order = (els) => {
    const open = new Map();
    els.forEach((el, i) => {
      // A project drawn open holds its slot, and focus mode draws every project holding a live row open (app.js
      // projectDrawsOpen) whether or not the reader ever opened it - a section sliding under a live row is the same
      // defect as a section sliding under a console.
      if (projectDrawsOpen(el.dataset.project)) open.set(i, el);
    });
    const byName = new Map(els.map((el) => [el.dataset.project, el]));
    const ranked = orderedByRank("projects", els.map((el) => el.dataset.project), ctx);
    const free = ranked
      .filter((n) => !projectDrawsOpen(n))
      .map((n) => byName.get(n))
      .filter(Boolean);
    const out = [];
    let f = 0;
    els.forEach((_, i) => out.push(open.has(i) ? open.get(i) : free[f++]));
    return out;
  };
  // Worked out BEFORE anything moves: the plan is pure (it only reads elements and the ranking), so it can be known
  // in advance whether this tick has any work at all - and the console scroll boxes can be read while they are still
  // laid out, which a read after the move is not.
  const plans = [];
  for (const body of boardGroups(host).map(groupBody)) {
    if (!body) continue;
    const sections = childrenMatching(body, "section.project");
    if (!sections.length) continue;
    const want = order(sections);
    if (want.every((el, i) => el === sections[i])) continue;
    plans.push({ body, sections, want });
  }
  // Then the folders themselves, on the same ranking: a folder holding the project an agent is busy
  // in leads, then the one worked in most recently.
  const groups = boardGroups(host);
  // A folder's rate is its busiest project's, and it is ranked the same smoothed way, on the same clock.
  const byRoot = new Map();
  for (const name of state.projects.keys()) {
    const root = rootOf(state.projects.get(name)) || "";
    const arr = byRoot.get(root) || [];
    arr.push(name);
    byRoot.set(root, arr);
  }
  const groupByRoot = new Map(groups.map((g) => [g.dataset.root || "", g]));
  const ranked = orderedByRank("folders", groups.map((g) => g.dataset.root || ""), folderRankCtx(byRoot, rank, Date.now()))
    .map((r) => groupByRoot.get(r))
    .filter(Boolean);
  // A folder you are reading a project in holds its slot for the same reason the project does: the
  // folder sliding up takes the open section with it, which looks exactly like the section itself jumping.
  const holdsOpen = (g) => childrenMatching(groupBody(g), "section.project").some((s) => projectDrawsOpen(s.dataset.project));
  const pinnedGroups = new Map();
  groups.forEach((g, i) => { if (holdsOpen(g)) pinnedGroups.set(i, g); });
  const freeGroups = ranked.filter((g) => !pinnedGroups.has(groups.indexOf(g)));
  const wantGroups = [];
  let gf = 0;
  groups.forEach((_, i) => wantGroups.push(pinnedGroups.has(i) ? pinnedGroups.get(i) : freeGroups[gf++]));
  const moveGroups = !wantGroups.every((g, i) => g === groups[i]);
  // The common case on the clock: the ranking moved nothing this tick, so the page is left exactly as it is.
  if (!plans.length && !moveGroups) return;
  // Read the scroll boxes while they are still laid out, then move ONLY what is out of place. An open project keeps
  // its slot in `want`, so its section is never one of the moved ones - which is the whole fix: a re-rank that has
  // nothing to do with a console can no longer reset it. The hold is the belt for the cases where a section really
  // has to move (sections appeared or went away) and for the consoles inside a folder that moves.
  const held = holdScrolls(host);
  beginDomMove();
  for (const p of plans) {
    placeInOrder(p.body, p.want);
    flashMoved(p.sections, p.want, p.body);
  }
  if (moveGroups) placeInOrder(host, wantGroups);
  endDomMove();
  releaseScrolls(held);
  if (typing) restoreTyping(host, typing);
  restoreAddAgent(host);
  restoreCardSelection(heldSelection);
}

// One accordion per folder. The header carries the folder path and the aggregate state of
// everything inside it, so a collapsed folder still says what it holds.
// How many of a folder's projects are on the FREQUENT scan: the recent tier the scheduler reads every few seconds,
// as opposed to the old tier that only its hourly stat slice touches. The count comes from `project.tier`, which is
// the server's own answer, so the header cannot drift from what the scheduler is actually doing. Rendered to the
// right of the project count, where the folder's own totals live.
function rootScanChip(scanning, days = recentDays()) {
  if (!Number.isFinite(scanning)) return "";
  const n = Math.max(0, Math.round(scanning));
  return `<span class="chip scan" title="${n} of this folder's projects have a commit inside the last ${days} days and are read on the frequent scan; every other project sits on the hourly stat gate">${n} scanning</span>`;
}

// `total` is the folder's FULL project count and it is what the count chip states, whatever the 7d view is
// holding back: the number beside the folder's path is the folder's, so it cannot shrink because the reader
// chose a view. The shortfall that view creates belongs to the button that created it (rootRecentButton), and
// the folder card no longer carries a live count at all - a live agent is a row's fact (the row's own chips and
// the project's own chips say it), and the folder-level chip only repeated it one layer out.
function rootChips(projects, { scanning = null, total = projects.length } = {}) {
  const names = new Set(projects.map((p) => p.name));
  const rows = [...state.rows.values()].filter((r) => names.has(r.project));
  const unmerged = rows.filter((r) => {
    const v = String(r.verdict || "");
    return v && !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN" && v !== "RELEASED";
  }).length;
  const dirty = rows.filter((r) => r.dirty || r.untracked).length;
  const full = Number.isFinite(Number(total)) ? Math.max(0, Math.round(Number(total))) : projects.length;
  const out = [
    `<span class="chip">${full} project${full === 1 ? "" : "s"}</span>`,
    rootScanChip(scanning),
    `<span class="chip">${rows.length} worktrees</span>`,
  ].filter(Boolean);
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  return out.join("");
}

// The folder's All/7d toggle. The count it hides lives INSIDE it now: in "last N days" mode the button says how
// many projects the window is folding away, right where the reader pressed to fold them, instead of as a chip at
// the far right of the header a screen away from the control that caused it. The project count beside the folder
// path stays the FULL count (rootChips), so this button is the one place the difference is explained.
function rootRecentButton(root, recentOnly, { hidden = 0, total = 0 } = {}) {
  const days = recentDays();
  const all = Math.max(0, Number(total) || 0);
  const held = Math.max(0, Number(hidden) || 0);
  const title = recentOnly
    ? `showing ${Math.max(0, all - held)} of ${all} projects - only those with a commit in the last ${days} days; click to show every project`
    : `showing all ${all} projects; click to show only those with a commit in the last ${days} days`;
  const label = recentOnly ? `${days}d${held ? ` (${held} hidden)` : ""}` : "All";
  return `<button type="button" class="btn-root-recent${recentOnly ? " on" : ""}" data-root-recent="${esc(root)}" title="${esc(title)}">${label}</button>`;
}

function rootSection(root, allProjects) {
  const open = !state.collapsedRoots.has(root);
  const recentOnly = state.recentRoots.has(root);
  const projects = shownInRoot(root, allProjects);
  const hidden = allProjects.length - projects.length;
  // The folder's frequent-scan count is over ALL its projects, not the ones the recent-only filter is showing: it
  // answers "how many of these am I reading often", which does not change when the reader toggles the filter.
  const scanning = allProjects.filter((p) => rootOf(p) === root && p.tier !== "old").length;
  // The label follows the fold the board DRAWS: focus mode force-expands a project holding a live row (app.js
  // projectDrawsOpen), and a button reading "Expand all" over expanded sections is the wrong word for what is on screen.
  const anyOpen = projects.some((p) => projectDrawsOpen(p.name));
  return `<section class="root-group${open ? "" : " collapsed"}" data-root="${esc(root)}">
    <div class="root-head" data-toggle-root="${esc(root)}" title="${open ? "collapse" : "expand"} ${esc(labelRoot(root))}">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <h2>${esc(labelRoot(root))}</h2>
      <div class="chips">${rootChips(projects, { scanning, total: allProjects.length })}</div>
      <span class="spacer"></span>
      <span class="root-filter" title="filter the projects in this folder by name or path — Escape clears it">
        <input class="root-search mono" data-root-search="${esc(root)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" spellcheck="false"
          placeholder="filter ${allProjects.length}&hellip;" value="${esc(rootFilterValue(root))}">
        <button type="button" class="root-search-clear${rootFilterValue(root) ? " is-on" : ""}" data-root-search-clear="${esc(root)}" title="clear the filter">\u2715</button>
        <span class="root-count mono${rootFilterValue(root) ? " on" : ""}" data-root-count></span>
      </span>
      ${rootRecentButton(root, recentOnly, { hidden, total: allProjects.length })}
      <button type="button" class="btn-root-collapse" data-root-collapse="${esc(root)}" title="${anyOpen ? "collapse" : "expand"} every project in ${esc(labelRoot(root))} (${projects.length})">${anyOpen ? "Collapse all" : "Expand all"}</button>
      <button type="button" class="btn-root-clone" data-root-clone="${esc(root)}" title="clone a GitHub repo over ssh into ${esc(labelRoot(root))}">+</button>
    </div>
    <div class="root-clone" data-clone-form="${esc(root)}"${state.cloneStatus[root] ? "" : " hidden"}>
      <input type="text" data-clone-input="${esc(root)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" placeholder="repo name — e.g. agent-worktree-gui, or owner/repo" spellcheck="false">
      <button type="button" data-clone-go="${esc(root)}">Clone via ssh</button>
      <button type="button" data-project-new="${esc(root)}" title="create a new local git project in ${esc(labelRoot(root))} — inited on main with one commit, nothing fetched or pushed">New local project</button>
      <span class="mono dim${state.cloneStatus[root]?.kind === "err" ? " clone-err" : ""}" data-clone-msg="${esc(root)}">${esc(state.cloneStatus[root]?.text || "")}</span>
    </div>
    <div class="root-body">
      <p class="root-empty" data-root-empty></p>
${projects.map((p) => projectSection(p.name)).join("\n")}
    </div>
  </section>`;
}

function projectSection(name) {
  const p = state.projects.get(name) || { name };
  // Focus mode force-expands a project that holds a live row (public/app.js projectDrawsOpen), so the class, the
  // chevron and the head's tooltip all follow the answer the rows are built from rather than the stored fold.
  const open = projectDrawsOpen(name);
  const mainLine = p.localMain && p.remoteTip
    ? `local ${esc(p.mainBranch)} <code>${esc(p.localMain)}</code> · ${p.mainBehind ?? "?"} behind / ${p.mainAhead ?? "?"} ahead of remote`
    : p.error ? esc(p.error) : "local main unknown";
  const tip = p.remoteTip
    ? `<span class="mono dim">${esc(p.remoteRef || "")} <code>${esc(p.remoteTip)}</code> ${esc(String(p.remoteTipSubject || "").slice(0, 60))} · ${relTime(p.remoteTipDate)} ago</span>`
    : "";
  const hue = state.projectHues.get(name);
  return `<section class="project${open ? "" : " collapsed"}${hue == null ? "" : " has-hue"}" data-project="${esc(name)}"${hue == null ? "" : ` style="--proj-hue:${Number(hue)}"`}>
    <div class="project-head" data-toggle-project="${esc(name)}" title="${esc(headTitle(name))}">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <h2>${esc(name)}</h2>
      <button class="btn-plus" data-spawn-project="${esc(name)}" title="start a Hermes agent, worktree and branch in ${esc(name)}">+</button>
      <span class="path">${esc(p.path || "")}</span>
      <span class="spacer"></span><div class="chips" data-chips="${esc(name)}">${chipsHtml(name)}</div>
    </div>
    <div class="project-head meta-line">
      <span class="mono dim">${mainLine}</span><span class="spacer"></span>${tip}
      <span class="dimmer mono">${p.fetchNote ? esc(p.fetchNote) + " · " : ""}fetched ${relTime(p.fetchedAt)} ago</span>${hostChipHtml(name)}${rulesChipHtml(name)}${turnoverChipHtml(name)}${boardChipHtml(name)}
    </div>
    ${projectBarsHtml(name)}
    <div class="wt-scroll">
      <table><thead><tr>${chartHeaderHtml()}</tr></thead><tbody data-tbody="${esc(name)}"></tbody></table>
    </div>
    <div class="legend"><span class="age-slot" data-age-slot="${esc(name)}"></span>liveness evidence: <span class="sig sig-hermes">⧉ hermes</span> session active · <span class="sig sig-claude">⧉ claude</span> Claude Code session active · <span class="sig sig-board">● board</span> live board PID · <span class="sig sig-port">:port</span> dev server listening · <span class="sig sig-files">✎ files</span> edited recently — a row is live only if one of these fired · the number is time since that last happened, the ring fills up to green as the row becomes due for its next read · a tree cut from another one hangs under it, one indent in, and the ▾ on its parent folds the group out of sight — a fold only hides, every chip and open panel stays as it was</div>
  </section>`;
}

function refreshChips(name) {
  const el = projectNode("data-chips", name);
  if (el) {
    // The same strip again is not a repaint: rewriting it rebuilt every chip node (style, layout, and a pass of the
    // copy observer over each one) on every row placed, for a strip that reads exactly as it did.
    const html = chipsHtml(name);
    if (el._chipsHtml !== html) {
      el.innerHTML = html;
      el._chipsHtml = html;
    }
  }
  // The board chip sits in the same second head line, for the same reason: a scan that found a claim appear or go
  // stale moves a count this strip does not hold, and a snapshot is how that reading arrives.
  refreshBoardChip(name);
  // The rules chip sits in the project's second head line rather than in this strip, and a snapshot (which repaints
  // only the strip and the rows) is how a count saved in another tab arrives — so it is refreshed from here.
  refreshRulesChip(name);
  // The turnover chip is in that same line, and a branch saved in another tab arrives the same way.
  refreshTurnoverChip(name);
  // The chart's arrow (top-N collapse) depends on the same rows, so it is refreshed from the same place.
  refreshTopToggle(name);
}

// ---- children under their parent ---------------------------------------------------------------
// Every tree the panel has a record for says which branch it was cut from — `row.parent` — and `row.parentSource`
// says how sure that record is: "cut" (the panel watched the cut), "backfilled" (a guess from a shared ticket id in
// the branch name) or "unknown". The board draws that record: a row whose parent is another row of the SAME project
// hangs under it, one indent in, with its own chips and its own actions, and the parent carries the fold that puts
// the group out of sight.
//
// Four rules keep the picture honest:
//   • a GUESS still groups. Grouping is a picture, not a write — the UNMERGED chip already refuses to roll into a
//     backfilled parent — and a reader looking for the tree cut from this one wants it here whether the record was
//     watched or guessed. Only the tooltip says which it was.
//   • a child hangs under its parent only while the PARENT IS ON THE CHART. The chart's top-N can hold a parent back
//     while its child ranks higher; the child then keeps its own row at the top level rather than hanging under a
//     row that is not drawn or disappearing with it.
//   • a record can point in a circle (two backfilled guesses). The loop is broken where it closes: the row that would
//     be its own ancestor is drawn at the top level, because a row cannot hang under itself.
//   • MAIN IS NEVER A ROW'S PARENT. The checkout's own row IS main, so a tree cut from main is its SIBLING, not its
//     child: the round's frozen parent tree is that case, and every stage tree of the round hangs under the parent
//     tree instead. A book written before the cut stopped recording `main` (lib/jobs.js `round: true`) still names
//     it, and refusing the edge here is what draws the sibling picture for that board without a migration - the same
//     rule lib/parents.js has always applied to a roll-up target.
//   • A ROUND'S OWN RECORD NAMES ITS CHILDREN. `row.round.parentPath` is read from the queue task that cut the tree
//     (lib/round-tree-names.js), the same record the row's NAME comes from. The branch edge above arrives only with a
//     scanned row, so a board that has just booted drew every name and no group until each row's scan landed - and a
//     stage tree the parent book never recorded had no group at all. The record is exact (the panel cut the tree), so
//     it wins over a scanned branch edge; the same "parent must be a drawn row of this project" rule still applies.
function childTreeOf(project) {
  const byBranch = new Map();
  const byPath = new Map();
  for (const r of state.rows.values()) {
    if (r.project !== project) continue;
    const k = keyOf(project, r.path);
    const p = normPath(r.path).toLowerCase();
    if (p && !byPath.has(p)) byPath.set(p, k);
    const b = String(r.branch || "").trim();
    if (!b) continue;
    if (!byBranch.has(b)) byBranch.set(b, k);
  }
  // The project's own main branch, and the names every project calls it. `state.projects` carries `mainBranch` from
  // the scan (a repo whose main is `dev` says so); the four literal names are the floor under a project the page has
  // not seen yet.
  const mainBranch = String(state.projects?.get?.(project)?.mainBranch || "").trim();
  const turnover = (b) => b === mainBranch || /^(master|main|trunk|develop)$/i.test(b);
  const parentOf = new Map();
  for (const r of state.rows.values()) {
    if (r.project !== project) continue;
    const k = keyOf(project, r.path);
    // A round child's edge is the record's own: the tree was cut for this round, from the parent tree's branch.
    const roundParent = r.round && typeof r.round === "object" ? normPath(r.round.parentPath || "").toLowerCase() : "";
    if (roundParent) {
      const pk = byPath.get(roundParent);
      if (pk && pk !== k) parentOf.set(k, pk);
      continue;
    }
    const par = String(r.parent || "").trim();
    if (!par) continue;
    if (turnover(par)) continue;
    const pk = byBranch.get(par);
    if (pk && pk !== k) parentOf.set(k, pk);
  }
  for (const k of [...parentOf.keys()]) {
    const seen = new Set([k]);
    for (let cur = parentOf.get(k); cur; cur = parentOf.get(cur)) {
      if (seen.has(cur)) {
        parentOf.delete(k);
        break;
      }
      seen.add(cur);
    }
  }
  const childrenOf = new Map();
  for (const [k, pk] of parentOf) {
    const kids = childrenOf.get(pk) || [];
    kids.push(k);
    childrenOf.set(pk, kids);
  }
  return { parentOf, childrenOf };
}

// What one row needs to know about its place: the row it hangs under (only while that row is drawn), how deep it is,
// how many of its own children are drawn, whether the reader has folded IT, and whether an ancestor is folded — the
// last one is what makes a rebuild come back folded instead of re-opening a group on the reader.
//
// The DEPTH counts the rows that are DRAWN above this one, never the records: the chart's top-N can hold a grandparent
// back while its child and grandchild are both on the chart, and a depth read off the records would step the grandchild
// in twice under a parent drawn at 0. A row that hangs under nothing is depth 0, a GROUP PARENT included, which is
// what puts its name in the same column as an ungrouped sibling's. The painter writes that number onto every row and
// public/chart.css turns it into the one indent rule the whole chart shares.
function groupCtxOf(tree, key, drawn = null) {
  const onChart = (k) => !drawn || drawn.has(k);
  const pk = tree.parentOf.get(key) || null;
  const parentKey = pk && onChart(pk) ? pk : null;
  let depth = 0;
  let hidden = false;
  for (let cur = parentKey; cur && onChart(cur); cur = tree.parentOf.get(cur)) {
    depth += 1;
    if (state.foldedParents.has(cur)) hidden = true;
  }
  return {
    parentKey,
    depth,
    childCount: (tree.childrenOf.get(key) || []).filter(onChart).length,
    folded: state.foldedParents.has(key),
    hidden,
  };
}

// The drawing order with every child moved directly under its parent — the one list both renderProjectRows() and
// reorder() paint from, so a scan tick and a full rebuild cannot disagree about where a child sits. A key whose
// parent is not in the list keeps its own place: that is the top-N case, and also a row of another project.
function nestRowKeys(parentOf, keys) {
  const inList = new Set(keys);
  const kidsOf = new Map();
  for (const k of keys) {
    const pk = parentOf.get(k);
    if (!pk || !inList.has(pk)) continue;
    const kids = kidsOf.get(pk) || [];
    kids.push(k);
    kidsOf.set(pk, kids);
  }
  const out = [];
  const seen = new Set();
  const emit = (k) => {
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
    for (const c of kidsOf.get(k) || []) emit(c);
  };
  for (const k of keys) if (!inList.has(parentOf.get(k))) emit(k);
  for (const k of keys) emit(k);
  return out;
}

function foldTitle(row, count, folded) {
  const what = `${count} worktree${count === 1 ? "" : "s"} cut from ${row.branch || "this tree"}`;
  return folded
    ? `show the ${what} — each keeps its own chips, actions and open panel; the fold only put them out of sight`
    : `hide the ${what} — folded one indent in under this row; nothing is removed and every open panel stays open behind the fold`;
}

function foldButtonHtml(key, row, ctx) {
  const n = ctx.childCount;
  return `<button class="btn-row-fold${ctx.folded ? " is-folded" : ""}" type="button" data-fold-tree="${esc(key)}" aria-expanded="${
    ctx.folded ? "false" : "true"
  }" aria-label="${ctx.folded ? "show" : "hide"} the ${n} worktree${n === 1 ? "" : "s"} cut from ${esc(row.branch || "this tree")}" title="${esc(
    foldTitle(row, n, ctx.folded),
  )}">${ctx.folded ? "\u25b8" : "\u25be"}</button>`;
}

// Paint the fold control in place — the node is kept, never replaced, because the button is what the pointer and the
// keyboard are on when it flips.
function paintFoldButton(btn, key, row, ctx) {
  const n = ctx.childCount;
  const glyph = ctx.folded ? "\u25b8" : "\u25be";
  if (btn.textContent !== glyph) btn.textContent = glyph;
  if (btn.getAttribute("aria-expanded") !== (ctx.folded ? "false" : "true")) {
    btn.setAttribute("aria-expanded", ctx.folded ? "false" : "true");
  }
  const label = `${ctx.folded ? "show" : "hide"} the ${n} worktree${n === 1 ? "" : "s"} cut from ${row.branch || "this tree"}`;
  if (btn.getAttribute("aria-label") !== label) btn.setAttribute("aria-label", label);
  const title = foldTitle(row, n, ctx.folded);
  if (btn.title !== title) btn.title = title;
  btn.classList.toggle("is-folded", ctx.folded);
}

// Everything the grouping draws for ONE row: its child/parent classes, the indent, the fold control, and the tick
// that says "cut from the row above". The lead slot is filled in place so a re-rank or a scan tick never rebuilds a
// control the reader is pointing at.
function paintRowGroup(tr, row, key, ctx) {
  const child = Boolean(ctx.parentKey);
  tr.classList.toggle("is-child", child);
  tr.classList.toggle("is-parent", ctx.childCount > 0);
  // Hidden because an ANCESTOR is folded. The row itself stays in the document: folding is a class, not a removal,
  // which is what lets an open console, a half-typed reply and a scroll position survive it.
  tr.classList.toggle("is-fold-hidden", ctx.hidden);
  // The depth is written for EVERY row, a group parent included: 0 is a real answer (it is what keeps the parent in an
  // ungrouped sibling's column) and one rule in public/chart.css reads it off every row, so the indent can no longer
  // depend on which markers a row happens to carry.
  const depth = String(ctx.depth);
  if (tr.dataset.depth !== depth) tr.dataset.depth = depth;
  if (tr.style.getPropertyValue("--child-depth") !== depth) tr.style.setProperty("--child-depth", depth);
  if (child) {
    if (tr.dataset.parentKey !== ctx.parentKey) tr.dataset.parentKey = ctx.parentKey;
  } else if (tr.hasAttribute("data-parent-key")) {
    tr.removeAttribute("data-parent-key");
  }
  const lead = tr.querySelector("td.name .row-lead");
  if (!lead) return;
  let tick = lead.querySelector(".child-tick");
  if (child && !tick) {
    lead.insertAdjacentHTML("afterbegin", `<span class="child-tick" aria-hidden="true">\u2514</span>`);
    tick = lead.querySelector(".child-tick");
  } else if (!child && tick) {
    tick.remove();
  }
  let btn = lead.querySelector(".btn-row-fold");
  if (ctx.childCount && !btn) {
    lead.insertAdjacentHTML("beforeend", foldButtonHtml(key, row, ctx));
    btn = lead.querySelector(".btn-row-fold");
  } else if (!ctx.childCount && btn) {
    btn.remove();
    btn = null;
  }
  if (btn) paintFoldButton(btn, key, row, ctx);
}

// The nodes painted UNDER a row — its detail, a question it is asking, the ⟳'s offer — say which row they hang from
// and hide with it. Everything here carries `data-parent-key`, so one selector finds a whole group.
function paintUnder(el, ctx) {
  if (!el) return;
  if (ctx.parentKey) el.dataset.parentKey = ctx.parentKey;
  else if (el.hasAttribute("data-parent-key")) el.removeAttribute("data-parent-key");
  el.classList.toggle("is-fold-hidden", ctx.hidden);
}

function markUnder(el, key) {
  const project = state.rows.get(key)?.project;
  if (!el || !project) return el;
  paintUnder(el, groupCtxOf(childTreeOf(project), key));
  return el;
}

// One pass over a project's drawn rows, so a rebuild, a single-row repaint and a re-rank cannot each draw a
// different picture of the same tree.
function syncChildGroups(project) {
  const tbody = state.tbodyEls.get(project);
  if (!tbody || !tbody.isConnected) return;
  const tree = childTreeOf(project);
  const rows = [...tbody.children].filter((el) => el.classList.contains("row"));
  const drawn = new Set(rows.map((el) => el.dataset.key));
  const offers = new Map([...tbody.querySelectorAll("tr.refresh-offer")].map((el) => [el.dataset.refreshOffer, el]));
  for (const tr of rows) {
    const key = tr.dataset.key;
    const row = state.rows.get(key);
    if (!row) continue;
    const ctx = groupCtxOf(tree, key, drawn);
    paintRowGroup(tr, row, key, ctx);
    for (const el of [state.detailEls.get(key), state.confirmEls.get(key), offers.get(key)]) paintUnder(el, ctx);
  }
}

// Fold or unfold one parent. It writes nothing but the reader's own book: the children are hidden where they stand,
// so their chips, their open panel and anything typed into it are exactly where they were when the fold opens again.
function toggleChildFold(key) {
  const row = state.rows.get(key);
  if (!row) return;
  if (state.foldedParents.has(key)) state.foldedParents.delete(key);
  else state.foldedParents.add(key);
  saveFoldedParents();
  syncChildGroups(row.project);
}
// ---- end children under their parent

function rowHtml(row, forceOwner = false) {
  const isOpen = rowDrawsOpen(keyOf(row.project, row.path));
  // A row whose path is no longer a tree of its own (lib/scan.js's RELEASED row) has no counts to show: "clean" would
  // be a claim about a worktree that is not there, so the cell says — with the reason in its tooltip.
  const releasedWhy = row.released ? String(row.released.why || "this path is not a worktree any more") : "";
  const dirty = releasedWhy
    ? `<span class="dim" title="${esc(releasedWhy)}">—</span>`
    : row.dirty || row.untracked
      ? `<span class="dirty">${row.dirty}</span>${row.untracked ? ` <span class="dimmer">+${row.untracked}?</span>` : ""}`
      : `<span class="clean">clean</span>`;
  const pr = prCellHtml(row);
  const badge = verdictHtml(row);
  // The project's own checkout is not a worktree anyone may delete or rename from here: it keeps the folder's name.
  const isProjectRoot = isProjectRootRow(row);
  // A tree is named from the prompt, cut at 24 characters; the agent names itself better a moment later. The button
  // offers that name first and takes anything the reader types. The branch column already carries the real name, so
  // the row does not repeat it here.
  const shownTitle = treeTitleOf(row);
  const shownName = shownTitle || row.name;
  const suggestName = shownTitle || "";
  // Who gave this tree the name it has, and when — the panel's own record (lib/tree-names.js), the one fact about
  // naming that git does not hold. It is what makes "the panel will not rename this again by itself" visible.
  const namedLine = String(row.named?.line || "").trim();
  // A title the panel's own naming looked at and DECLINED (it promised a PR, a commit, a merge). The tree keeps
  // the name it was cut with, and the row says why rather than looking like a naming that never arrived.
  const offerLine = String(row.nameOffer?.line || "").trim();
  const renameBtn = isProjectRoot
    ? ""
    : `<button class="btn-row-rename" data-rename-tree="${esc(keyOf(row.project, row.path))}" data-rename-project="${esc(row.project)}" data-rename-path="${esc(row.path)}" data-rename-name="${esc(row.name)}" data-rename-suggest="${esc(suggestName)}" title="name this worktree by hand — renames its branch, and the directory when nothing is holding it${suggestName ? ` (offered: “${esc(suggestName)}”)` : ""}${namedLine ? ` · ${esc(namedLine)}` : ""}${offerLine ? ` · ${esc(offerLine)}` : ""}">\u270e</button>`;
  // ＋ cuts a CHILD worktree off this row's own branch (POST /api/worktree/child). It sits to the left of the ⟳
  // deliberately: the three controls read as one sentence down the row — make another tree from this branch, re-read
  // this one, remove this one. A row with no branch (a detached HEAD) has nothing to cut from, and the project's own
  // checkout is not a worktree, so neither draws it. The glyph is the ASCII plus on purpose: the mono stack this cell
  // is set in has no ⑂/⤷ on Windows, and a control that renders as nothing is worse than a plain one.
  const childBtn = isProjectRoot || !row.branch
    ? ""
    : `<button class="btn-child-tree" data-child-tree="${esc(keyOf(row.project, row.path))}" data-child-project="${esc(row.project)}" data-child-path="${esc(row.path)}" data-child-branch="${esc(row.branch)}" type="button" title="cut a child worktree off ${esc(row.branch)} — a new tree on a new branch cut from this one, on its own row below; nothing is started in it and nothing is pushed, and it is what the child's UNMERGED chip rolls back into ${esc(row.branch)}">+</button>`;
  // One ✕ per row, and whether it needs the question at all: merged + clean deletes straight away.
  const delKey = keyOf(row.project, row.path);
  const delDirect = !isProjectRoot && deletableWithoutAsking(delKey);
  const lock = row.lock || null;
  const lockKeyAttr = esc(keyOf(row.project, row.path));
  // The reader's lock, as an emoji on the row itself (lib/locks.js). TWO toggles, because the two scopes are a real
  // difference: the padlock beside the name is THIS worktree, the one in the branch cell is the BRANCH — and the
  // branch one keeps protecting trees cut from it later, which is the whole point of locking a turnover branch. Each
  // shows its own bit truthfully, so a tree protected only by its branch reads 🔓 beside the name and 🔒 beside the
  // branch, and neither can be mistaken for the other. A locked row also carries `is-locked` on the <tr>, so the
  // state is visible without reading a tooltip.
  const treeLocked = Boolean(lock?.tree);
  // The branch's NAME lives in `lock.branch`; the boolean lives in `lock.branchLocked`. Reading the name as a truthy
  // lock made every row with a branch draw as a locked branch.
  const branchLockedByBranch = Boolean(lock?.branchLocked);
  const lockTitle = treeLocked
    ? `${lock.line || "🔒 this worktree is locked"} — click to unlock it. Nothing may delete it while it is locked.`
    : branchLockedByBranch
      ? `this worktree is not locked itself, but ${lock.branch ? `branch ${lock.branch}` : "its branch"} is (see the 🔒 in the branch cell) — click to lock this worktree as well`
      : "lock this worktree — a locked worktree can never be deleted: not by this row's ✕, not by a merge agent, not by any route";
  const treeLockBtn = `<button class="btn-row-lock${treeLocked ? " is-locked" : ""}" type="button" data-lock-scope="tree" data-lock-tree="${lockKeyAttr}"
    title="${esc(lockTitle)}" aria-pressed="${treeLocked ? "true" : "false"}" aria-label="lock this worktree">${treeLocked ? "\u{1F512}" : "\u{1F513}"}</button>`;
  const branchLockTitle = branchLockedByBranch
    ? `${lock.line || "🔒 this branch is locked"} — click to unlock it. Every worktree on ${lock.branch || "this branch"}, now and later, is protected while it is locked.`
    : "lock this BRANCH — protects this worktree and every worktree created on the branch later (a turnover branch stays protected as trees come and go)";
  const branchLockBtn = isProjectRoot
    ? ""
    : `<button class="btn-row-lock btn-branch-lock${branchLockedByBranch ? " is-locked" : ""}" type="button" data-lock-scope="branch" data-lock-tree="${lockKeyAttr}"
      title="${esc(branchLockTitle)}" aria-pressed="${branchLockedByBranch ? "true" : "false"}" aria-label="lock this branch">${branchLockedByBranch ? "\u{1F512}" : "\u{1F513}"}</button>`;
  // Whether this row stands ON the project's turnover branch. Read here, beside the lock, because the two are the two
  // things a row says about what may be done with the tree: the lock says "nothing deletes this", the turnover mark
  // says "children are cut from here at will". A tree can carry either, both or neither, so neither reads the other.
  const onTurnoverBranch = isTurnoverBranchRow(row);
  // One cell per column, keyed by the column's id (CHART_COLUMNS), so the row and the header cannot disagree about
  // which cell is which: a hidden column is simply not in `cells`, and the row is the shown set in table order. The
  // life and next-read cells carry their own <td> (both are painted in place every second), which is why `life` and
  // `nextread` are read, not wrapped.
  const cells = {
    // The whole name as well as the drawn one: the name can be ellipsised (`td.name .row-name`, chart.css line 113),
    // and the copy handler (public/core/copy-full-value.js) answers a copy OR a highlight inside the cell with this
    // value instead of the fragment the selection covers. It is NOT `data-copy`, which is the console's block-lift
    // attribute and would grow a ⧉ button inside the cell.
    name: `<td class="name" data-copy-value="${esc(shownName)}"><div class="name-line"><span class="row-lead"></span><button class="btn-row-agent" data-agent-path="${esc(row.path)}" data-agent-name="${esc(row.name)}" data-agent-project="${esc(row.project)}"
      title="probe every NOT-RUNNING agent in this worktree — sends 'Continue if you can, exit if you are done' to each of them (the + under the agents starts a new one)">\u25b6</button><span class="row-name${onTurnoverBranch ? " is-turnover" : ""}"${onTurnoverBranch ? ' style="color:var(--blue)"' : ""} title="${esc(row.path)}">${esc(shownName)}</span>${renameBtn}${treeLockBtn}${turnoverRowMarkHtml(row)}${agentBadgeHtml(row)}</div></td>`,
    // Same rule for the branch, whose whole column is one ellipsis (chart.css line 83). The cell also holds the
    // remote link, a `local` chip and the branch's padlock, so the value is the branch itself, never the cell's text.
    branch: `<td class="mono branch" data-copy-value="${esc(row.branch || "")}">${branchCellHtml(row)}${branchLockBtn}</td>`,
    // The owner column: the assistant's NAME from the owner cell region above — never the raw id, never the role
    // label and never a dash. OFF by default: lib/chart-columns.js `DEFAULT_HIDDEN_COLUMNS`, applied when the reader
    // has no stored list.
    assistant: ownerCellHtml(row),
    tip: `<td class="mono dim nowrap">${esc(row.head || "—")}</td>`,
    ahead: `<td class="mono nowrap">${aheadBehindCellHtml(row)}</td>`,
    cherry: `<td class="mono dim nowrap">+${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}</td>`,
    pr: `<td class="pr">${pr}</td>`,
    dirty: `<td class="mono nowrap">${dirty}</td>`,
    life: lifeCellHtml(row),
    nextread: nextReadCellHtml(row),
    verdict: `<td class="verdict">${badge}</td>`,
    actions: `<td class="row-actions">${isProjectRoot ? "" : `${childBtn}<button class="btn-refresh-tree" data-refresh-tree="${esc(delKey)}" type="button" title="reconcile this one worktree — re-read its git state (dirty, ahead/behind, cherry, verdict, PR), then check its TODO list against what the tree now contains (a proposal, nothing closed) and its description, re-derived only if it has gone stale; every action is journalled under the row">\u27f3</button><button class="btn-del-tree${delDirect ? " is-direct" : ""}" data-del-tree="${esc(delKey)}" title="${delDirect ? "this worktree is merged and clean — deletes it straight away, its files go to the Recycle Bin and git's record is pruned" : "remove this worktree — asks first; its files go to the Recycle Bin and git's record of it is pruned"}">✕</button>`}</td>`,
  };
  return `<tr class="row${isOpen ? " expanded" : ""}${lock ? " is-locked" : ""}" data-key="${esc(keyOf(row.project, row.path))}">
    ${shownColumns(forceOwner).map((i) => cells[CHART_COLUMNS[i].id]).join("\n    ")}
  </tr>`;
}

// The row's turnover mark, drawn beside the lock. `turnoverFor` (public/board-scaffold.js) is the branch the project's
// head chip edits and the value a cut for that project starts from, so a row standing ON it is where child worktrees
// are cut from at will - and where this project's work rolls back into. It is NOT the lock and never borrows its
// state: the lock is the reader's "nothing may delete this", and a tree may be on the turnover branch, locked, both or
// neither.
//
// The row says it twice on purpose. The name is drawn blue at a glance (inline, so it wins over the locked row's amber
// name without moving that rule); the marker is the half a reader who cannot see blue still has - a shape of its own,
// plus the same sentence in its tooltip and its aria-label.
const TURNOVER_ROW_SAY = "the turnover branch for this project - assistants may cut child worktrees from it at will";

function isTurnoverBranchRow(row) {
  const branch = String(row?.branch || "").trim();
  return Boolean(branch) && branch === turnoverFor(row?.project);
}

function turnoverRowMarkHtml(row) {
  if (!isTurnoverBranchRow(row)) return "";
  return `<span class="turnover-mark" role="img" aria-label="${esc(TURNOVER_ROW_SAY)}" title="${esc(TURNOVER_ROW_SAY)}">\u21c4</span>`;
}

// ---- the age column: last life seen, plus a ring that fills toward the next read --------------
// The number is NOT "time since last poll" (that is the ring): it is the last moment any liveness
// evidence fired for this worktree. The ring fills up to the moment the row is due to be read again,
//
// The cadence the server sends is what the scheduler WOULD apply; when the panel is behind (a big
// fleet, a slow repo) the real gap is longer, so the ring is sized to the observed gap once we
// have one -- otherwise it empties 30s in and then sits empty for a minute, which reads as broken.
const RING_C = 2 * Math.PI * 6;

function noteScan(row) {
  const key = keyOf(row.project, row.path);
  const t = Date.parse(row.scannedAt || "");
  if (!Number.isFinite(t)) return;
  const configured = Math.max(1, Number(row.pollSeconds || state.settings.worktreeSeconds || 5));
  const prev = state.lastScanAt.get(key);
  if (Number.isFinite(prev) && t > prev) {
    const gap = (t - prev) / 1000;
    // A 30s resync can be the first time we see two scans of a 5s row; that gap (30s) says nothing
    // about how often the row is really read, so only gaps inside a sane multiple are believed.
    if (gap > 0 && gap <= configured * 4) {
      const smoothed = state.pollGap.has(key) ? state.pollGap.get(key) * 0.6 + gap * 0.4 : gap;
      state.pollGap.set(key, smoothed);
    }
  }
  state.lastScanAt.set(key, t);
}

// The newest moment anything told us this worktree is alive: what the last scan found, or an event we received
// that belongs to one of its agents. An event is a fresh look at the tree, so it also restarts the ring.
function eventLifeAt(row) {
  return state.eventLife.get(keyOf(row.project, row.path)) || 0;
}

function lifeAtFor(row) {
  return Math.max(eventLifeAt(row), Date.parse(row.lastAliveAt || "") || 0);
}

function ringState(row) {
  const now = Date.now();
  const scannedRaw = Date.parse(row.scannedAt || "");
  const fromEvent = eventLifeAt(row);
  // The ring counts toward the NEXT READ. An event we just received says the tree is busy now, so the count starts
  // again from it - which is the "reset the donut" the reader asked for. Where neither is known, leave it unknown.
  const scanned = Number.isFinite(scannedRaw) ? Math.max(scannedRaw, fromEvent) : fromEvent || scannedRaw;
  const configured = Math.max(1, Number(row.pollSeconds || state.settings.worktreeSeconds || 5));
  const observed = state.pollGap.get(keyOf(row.project, row.path)) || 0;
  // Never shorter than the configured cadence, never more than 10x it (a stuck row must not turn
  // into a 10-minute ring that looks frozen).
  const every = Math.max(configured, Math.min(Math.round(observed), configured * 10));
  // Rows are deliberately staggered inside their cadence, so the moment this one is really due is the
  // server's own stamp (`nextReadAt`), not scannedAt plus a cadence: sized from the cadence, a phased
  // row's ring would fill early and then sit full until its turn came round. Fall back to the cadence
  // when a row predates the field.
  const dueRaw = Date.parse(row.nextReadAt || "");
  const due = Number.isFinite(dueRaw) ? dueRaw : Number.isFinite(scanned) ? scanned + every * 1000 : NaN;
  const total = Number.isFinite(due) && Number.isFinite(scanned) ? Math.max(1000, due - scanned) : every * 1000;
  const remain = Number.isFinite(due) ? Math.max(0, due - now) : 0;
  const overdue = Number.isFinite(due) ? Math.max(0, now - due) : 0;
  const frac = Math.min(1, remain / total);
  // The ring counts UP to the next read: empty the moment a row is scanned, full and green when it is
  // due again. `frac` is what is left, `fill` is what has elapsed.
  return { now, scanned, configured, every, total, remain, overdue, frac, fill: 1 - frac };
}

function ringOffset(st) {
  // The drawn length is circumference minus offset, so leaving `frac` undrawn means the arc grows as
  // the row approaches its next read: empty just after a scan, full when the row is due.
  return (RING_C * st.frac).toFixed(2);
}

function ringStroke(st) {
  if (st.overdue > st.total * 0.5) return "var(--red)";
  if (st.overdue > 0) return "var(--amber)";
  return st.fill >= 0.9 ? "var(--green)" : "var(--dim)";
}

// The Life column's own facts: the last moment this worktree was seen alive, whether there is one at all, and why if
// it was not the scan that said so (a running panel agent IS life observed by us, and so is any event we received).
// Shared by the builder and the once-a-second painter so the cell cannot say two different things about one row.
function lifeState(row) {
  const running = panelFor(row)?.running;
  const fromEvent = eventLifeAt(row);
  const alive = running ? Date.now() : lifeAtFor(row) || NaN;
  const live = Number.isFinite(alive);
  const why = running
    ? " (a panel agent is running here now)"
    : fromEvent && fromEvent >= (Date.parse(row.lastAliveAt || "") || 0)
      ? " (an event we received for this worktree)"
      : "";
  return { alive, live, why };
}

function lifeTitle(row) {
  const { alive, live, why } = lifeState(row);
  return (
    `last life ${live ? `${fmtDur(Date.now() - alive)} ago${why}` : "never seen"} · polled ${relTime(row.scannedAt)} ago · ` +
    "chips are the evidence: ⧉ hermes session · ● board PID · :port dev server · ✎ files edited"
  );
}

function lifeCellHtml(row) {
  const { alive, live } = lifeState(row);
  const label = live ? fmtDur(Date.now() - alive) : "never live";
  return `<td class="age nowrap" data-key="${esc(keyOf(row.project, row.path))}" title="${esc(lifeTitle(row))}">
      <span class="age-line"><span class="age-num${live ? "" : " dimmer"}">${esc(label)}</span></span><span class="sigs">${sigChips(row)}</span></td>`;
}

// The next-read column: the ring that fills toward the moment this row is due to be read again, and the bare figure
// beside it. The figure is all the cell says - "4s" while the read is owed, and the lateness once it is past - because
// the countdown moves every second and a sentence there read as three different states to scan for. The words live in
// nextReadTitle, so the tooltip still spells the state out; the .late class keys on the same `overdue > 0` the label
// does, so the amber can never disagree with the number it colours.
function nextReadLabel(st) {
  return st.overdue > 0 ? fmtDur(st.overdue) : `${Math.max(0, Math.ceil(st.remain / 1000))}s`;
}

function nextReadTitle(st) {
  const cadence = st.every === st.configured ? `every ${st.every}s` : `every ${st.every}s, observed (configured ${st.configured}s)`;
  const when = st.overdue > 0 ? `overdue ${fmtDur(st.overdue)}` : `due in ${Math.max(0, Math.ceil(st.remain / 1000))}s`;
  return `next read ${when} (${cadence}) · click the ring to read this worktree now`;
}

function nextReadCellHtml(row) {
  const st = ringState(row);
  const key = esc(keyOf(row.project, row.path));
  return `<td class="nextread nowrap" data-key="${key}" title="${esc(nextReadTitle(st))}">
      <button class="poll-btn" data-refresh-row="${key}" type="button" title="read this worktree now"><svg class="poll-ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle class="poll-track" cx="8" cy="8" r="6" fill="none" stroke-width="2"></circle>
        <circle class="poll-arc" cx="8" cy="8" r="6" fill="none" stroke-width="2" transform="rotate(-90 8 8)" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${ringOffset(st)}" stroke="${ringStroke(st)}"></circle>
      </svg></button><span class="next-num${st.overdue > 0 ? " late" : ""}">${esc(nextReadLabel(st))}</span></td>`;
}

function paintLifeCell(cell, row) {
  const { alive, live } = lifeState(row);
  const num = cell.querySelector(".age-num");
  if (num) {
    const text = live ? fmtDur(Date.now() - alive) : "never live";
    if (num.textContent !== text) num.textContent = text;
    num.classList.toggle("dimmer", !live);
  }
  const title = lifeTitle(row);
  if (cell.title !== title) cell.title = title;
}

function paintNextReadCell(cell, row) {
  const st = ringState(row);
  const arc = cell.querySelector(".poll-arc");
  if (arc) {
    // Only write the attributes that actually moved: this runs for every visible row every second,
    // and an unnecessary attribute write on an SVG node still costs style invalidation.
    const off = ringOffset(st);
    const stroke = ringStroke(st);
    if (arc.getAttribute("stroke-dashoffset") !== off) arc.setAttribute("stroke-dashoffset", off);
    if (arc.getAttribute("stroke") !== stroke) arc.setAttribute("stroke", stroke);
  }
  const num = cell.querySelector(".next-num");
  if (num) {
    const text = nextReadLabel(st);
    if (num.textContent !== text) num.textContent = text;
    num.classList.toggle("late", st.overdue > 0);
  }
  const title = nextReadTitle(st);
  if (cell.title !== title) cell.title = title;
}

// The worktree row an agent's thread belongs to, if it has one: the owner path on its newest turn. An agent with no
// owner sits in the unattached panel, so there is no row on the board to light up for it.
// Cached per render generation: this is asked once per streamed line, and a turn emits hundreds of them. The cache
// dies with the rest of the panel maps, which is whenever a row or an owner changes.
function rowKeyForThread(thread) {
  if (!thread) return null;
  if (!threadRowKeyCache) threadRowKeyCache = new Map();
  if (threadRowKeyCache.has(thread)) return threadRowKeyCache.get(thread);
  const conv = conversations().find((c) => c.thread === thread);
  const owner = conv?.latest?.ownerPath || conv?.first?.ownerPath || "";
  let key = null;
  if (owner) {
    const p = normPath(owner).toLowerCase();
    for (const [k, row] of state.rows) {
      if (normPath(row.path).toLowerCase() === p) {
        key = k;
        break;
      }
    }
  }
  threadRowKeyCache.set(thread, key);
  return key;
}

// The green pulse a row gets when the scanner finds life - reused here, so an event and a scan say the same thing.
function pulseRow(key) {
  const tr = rowNode(key);
  if (!tr) return;
  tr.classList.remove("flash-idle"); // a grey flash gives way to the green one: a new animation name starts fresh
  restartClassAnimation(tr, "flash", "flashrow");
  clearTimeout(tr._flashT);
  tr._flashT = setTimeout(() => tr.classList.remove("flash"), flashRowMs() + 40);
}

function pulseProject(project) {
  if (!project) return;
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(project)}"]`);
  // Only a collapsed project: an open one shows its rows, and they are the ones that flash when something happens.
  if (!sec || !sec.classList.contains("collapsed")) return;
  sec.classList.remove("flash");
  void sec.offsetWidth;
  sec.classList.add("flash");
  clearTimeout(sec._flashT);
  sec._flashT = setTimeout(() => sec.classList.remove("flash"), flashProjectMs() + 40);
}

// ---- stabilize reordering -------------------------------------------------------------------
// A list that re-sorts while the reader has something open in it moves the thing they are reading. With this on, a
// list freezes the moment one of its own elements is expanded: a project's worktree rows stop re-ranking while any of
// them is open, and the agent cards in one worktree stop re-ranking while any of those cards is open. Off, everything
// sorts on every paint as it always did. Saved in this browser.
const STABILIZE_KEY = "wtgui.stabilize";
function stabilizeOn() {
  try {
    const raw = localStorage.getItem(STABILIZE_KEY);
    // On by default: a board that shuffles under an open row is the surprise, not the absence of shuffling.
    return raw === null ? true : raw !== "0";
  } catch {
    return true;
  }
}

// Is anything open in this list? Rows of a project, and cards of a row.
function projectHasOpenRow(name) {
  for (const key of state.expanded) if (state.rows.get(key)?.project === name) return true;
  return false;
}

function rowHasOpenCard(threads) {
  return threads.some((t) => !state.collapsedJobs.has(t));
}

// The order the cards in one row show in. With Stabilize reordering on and a card open they keep the slots they
// already have on screen; otherwise they are ranked by the same sliding average as everything else - the thread's
// own liveness over the window, so a chatty agent sits at the top of its row, a card with one line stays put, and
// one that goes quiet slides down. A frozen list keeps its remembered order.
function orderedAgents(row, agents) {
  const key = keyOf(row.project, row.path);
  if (!agents.length) return agents;
  if (stabilizeOn() && rowHasOpenCard(agents.map((c) => c.thread))) {
    const last = state.agentOrder.get(key);
    if (!last || !last.length) return agents;
    const pos = new Map(last.map((t, i) => [t, i]));
    return [...agents].sort((a, b) => (pos.get(a.thread) ?? last.length) - (pos.get(b.thread) ?? last.length));
  }
  const byThread = new Map(agents.map((c) => [c.thread, c]));
  const order = orderedByRank(`agents:${key}`, [...byThread.keys()], agentRankCtx(row, Date.now()));
  return order.map((t) => byThread.get(t)).filter(Boolean);
}

// Remember what was just painted, so the next frozen paint has an order to keep.
function rememberAgentOrder(key, detail) {
  if (!detail) return;
  const order = [...detail.querySelectorAll(".job[data-thread]")].map((c) => c.dataset.thread).filter(Boolean);
  if (order.length) state.agentOrder.set(key, order);
  else state.agentOrder.delete(key);
}

function rememberAgentOrders() {
  for (const [key, detail] of state.detailEls) rememberAgentOrder(key, detail);
}

function reorder(name) {
  const tbody = state.tbodyEls.get(name);
  if (!tbody) return;
  // Stabilized: while one row of this project is open, none of them re-ranks around it.
  if (stabilizeOn() && projectHasOpenRow(name)) {
    // The RANK is held still while a row is open, but the grouping is not a rank: a child that just arrived still
    // belongs under its parent, and a row that has gone must not leave children indented under nothing.
    syncChildGroups(name);
    return;
  }
  // Re-appending a detail takes its cards out of the DOM on the way, which is enough to lose a selection.
  const heldSelection = captureCardSelection();
  // And enough to lose the caret: a re-rank of some OTHER worktree re-appends every row in this project, including
  // the open one the reader is typing in, and a detached box cannot keep focus. That is the cursor going missing
  // when a row flashes green - the flash touches nothing, the re-sort under it moves everything.
  const typing = $("projects") ? captureTyping($("projects")) : null;
  // The order if nothing were pinned: our running agents first, then everything by how recently it
  // showed life. This is what "latest movement at the top" means once all the accordions are closed — and the rows
  // below the chart's top N are not in it at all, so a re-rank can never pull one into a drawn row's slot.
  const ranked = chartDrawOrder(name).map((r) => keyOf(name, r.path));
  // An open row keeps its exact slot — opening it is you saying "I am reading this". Everything closed
  // sorts into the gaps around it, exactly how closed projects sort around an open one in a folder.
  const slotKeys = [...tbody.children].filter((el) => el.classList.contains("row")).map((el) => el.dataset.key);
  const fixed = new Set(slotKeys.filter((k) => state.expanded.has(k)));
  const free = ranked.filter((k) => !fixed.has(k));
  const orderedKeys = [];
  let f = 0;
  for (const k of slotKeys) orderedKeys.push(fixed.has(k) ? k : free[f++] ?? k);
  // A row that just arrived has no slot of its own yet: give it one at the end of the free queue.
  for (const k of free.slice(f)) if (!orderedKeys.includes(k)) orderedKeys.push(k);
  // A child is drawn under its parent whatever slot the rank handed it: the group is the shape of the board, and an
  // open child that the rank happened to slot above its parent still belongs below it.
  const nestedKeys = nestRowKeys(childTreeOf(name).parentOf, orderedKeys);
  const want = [];
  for (const k of nestedKeys) {
    const tr = state.rowEls.get(k);
    if (tr) want.push(tr);
    // The confirmation is a child of its row inside the table, so a re-rank that re-appends only the
    // rows leaves it behind at index 0 - the box "pops up the top" instead of staying under the tree
    // it asks about. Carry it with its row, between the row and its detail.
    const c = state.confirmEls.get(k);
    if (c) want.push(c);
    const d = state.detailEls.get(k);
    if (d) want.push(d);
  }
  // A confirmation for a row that is gone must not survive its own row.
  for (const [k, c] of [...state.confirmEls]) {
    if (!state.rows.has(k)) {
      c.remove();
      state.confirmEls.delete(k);
    }
  }
  // Only touch the DOM when the order really changed: this runs on every row event, and re-appending
  // identical nodes would fight the scroll position while someone is reading.
  const current = [...tbody.children];
  if (current.length === want.length && current.every((el, i) => el === want[i])) {
    // Nothing moved, but the grouping still has to be current: a parent's child count changes when a row is held
    // back by the chart or comes back from it, and that is a fact about state, not about the order.
    syncChildGroups(name);
    return;
  }
  // Same discipline as reorderProjects(): a detail that only slid because a NEIGHBOUR was re-ranked must not take its
  // console out of the layout tree. Only the rows that are out of place move, and what does move is put back in this
  // same task instead of waiting for the next line or the 400 ms sweep.
  const heldScrolls = holdScrolls(tbody);
  beginDomMove();
  placeInOrder(tbody, want);
  endDomMove();
  releaseScrolls(heldScrolls);
  // The rows are in their new order, so say where each one now sits in its group: the indent, the fold control and
  // the class that hides a child behind a folded parent are all read from the order that was just painted.
  syncChildGroups(name);
  if (typing) restoreTyping(tbody, typing);
  restoreAddAgent(tbody);
  // Say which rows moved: the order is the panel's judgement about what to look at first, and a
  // silent shuffle leaves you guessing whether the row under the cursor is still the same row.
  // Green only where an agent actually moved in that row; a row that merely slid a slot because its
  // neighbour came alive gets the quiet grey. This is what stopped the MAIN row pulsing every time an
  // agent one level down did something.
  flashMovedByKey(
    current.map((el) => el.dataset.key),
    want,
    tbody,
    (el) => (state.movedRows.has(el.dataset.key) ? "flash" : "flash-idle"),
  );
  state.movedRows.clear();
  restoreCardSelection(heldSelection);
}

// Green flash on the things that moved UP the order. A project pushed to the top shifts everything
// below it down by one, and flashing those too turned a single mover into a wall of green; an element
// that only slid downwards is not news.
function flashMovedByKey(beforeKeys, afterEls, reflowHost, colorFor = null) {
  const was = new Map();
  beforeKeys.forEach((k, i) => {
    if (k) was.set(k, i);
  });
  const moved = [];
  afterEls.forEach((el, i) => {
    const k = el.dataset.key || el.dataset.project || el.dataset.root;
    const from = k ? was.get(k) : undefined;
    if (from !== undefined && i < from) moved.push(el);
  });
  if (!moved.length) return;
  // Remove then re-add in one pass with a single reflow between, so an element that moves twice in
  // quick succession restarts the animation instead of silently keeping the dying one.
  const kinds = new Map(moved.map((el) => [el, colorFor ? colorFor(el) : "flash"]));
  for (const el of moved) {
    el.classList.remove("flash", "flash-idle");
  }
  if (reflowHost) void reflowHost.offsetWidth;
  for (const el of moved) {
    const kind = kinds.get(el);
    el.classList.add(kind);
    clearTimeout(el._flashT);
    el._flashT = setTimeout(() => el.classList.remove(kind), flashRowMs() + 40);
  }
}

function flashMoved(before, after, reflowHost) {
  flashMovedByKey(before.map((el) => el.dataset.key || el.dataset.project || el.dataset.root), after, reflowHost);
}

// SSE row events arrive in bursts (a scan batch finishes several rows at once). Painting each one
// as it lands forces a layout per event; coalescing them into one animation frame keeps a burst to
// a single style pass, which is what made the table stutter when the scanner was busy.
const pendingRows = new Map();
let rowFrame = 0;

// The fields a row's detail draws, minus the ones that move on their own clock (liveness, the next-read ring, the
// scan stamp). Two rows with the same signature want the same detail, so the one on screen can be kept — cards and
// all — instead of being rebuilt under the agents that live in it.
const DETAIL_VOLATILE = new Set([
  "live", "liveWhy", "signals", "lastAliveAt", "ageMs", "nextReadAt", "pollSeconds", "scannedAt", "tookMs", "activityAt",
]);
function stableStringify(v) {
  if (v == null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(",")}}`;
}
function rowDetailSig(row) {
  const keep = {};
  for (const k of Object.keys(row || {})) if (!DETAIL_VOLATILE.has(k)) keep[k] = row[k];
  return stableStringify(keep);
}

function queueRow(project, row, opts) {
  pendingRows.set(keyOf(project, row.path), { project, row, opts });
  if (rowFrame) return;
  // rAF does not run at all in a hidden tab, so batching there would freeze the board's state until
  // the tab is looked at again (and a spawn's new row would never arrive). Apply immediately when
  // hidden; batch only while the tab is actually painting.
  const flush = () => {
    rowFrame = 0;
    const batch = [...pendingRows.values()];
    pendingRows.clear();
    for (const b of batch) placeRow(b.project, b.row, b.opts);
    // A row that starts or stops being alive changes where its project belongs, and liveness evidence
    // moves far more often than a job status does — so let every row batch also re-rank the folders.
    if (batch.length) queueReorderProjects();
  };
  if (document.hidden) return flush();
  rowFrame = requestAnimationFrame(flush);
}

function placeRow(project, row, { flash = false } = {}) {
  row.project = project;
  const key = keyOf(project, row.path);
  const prevRow = state.rows.get(key) || null;
  // This path takes the row's detail out of the document and puts a new one back. Anything that measures meanwhile
  // lays the page out with that detail missing, and near the bottom of the page a shorter document clamps the
  // reader's scroll upward for good. Hold the position, and give the sweep the anchor to hold afterwards.
  const pageY = window.scrollY;
  const rowAnchor = captureBoardAnchor();
  // Decided before the new row overwrites the old one, and outside the flash branch: it also decides
  // whether a refresh that found nothing gets the quiet grey pulse.
  const onMain = isMainWorktree(project, row);
  const moved = !prevRow || movementKey(prevRow, { onMain }) !== movementKey(row, { onMain });
  // Remembered for the reorder pass that follows this paint: a row that swaps slots because a NEIGHBOUR
  // moved must not flash green for it. Cleared by reorder() once it has coloured the moved rows.
  if (moved) state.movedRows.add(key);
  else state.movedRows.delete(key);
  const isNew = !state.rows.has(key);
  noteScan(row);
  state.rows.set(key, row);
  if (isNew) seedRankWindows(row);
  // A worktree that has just appeared can adopt the agents that were waiting in the unattached panel:
  // their owner path now resolves to a row. (A `-w` spawn is owned seconds before its row exists.)
  if (isNew) {
    invalidatePanelMap();
    queueJobsRefresh();
  }
  const tbody = state.tbodyEls.get(project);
  // If the section was rebuilt (project event), the cached tbody is detached. Repaint this
  // project's rows instead of quietly appending into a node nobody can see.
  if (!tbody || !tbody.isConnected) {
    if (!state.projects.has(project)) {
      renderAll();
      return;
    }
    const fresh = document.querySelector(`[data-tbody="${CSS.escape(project)}"]`);
    if (fresh) state.tbodyEls.set(project, fresh);
    renderProjectRows(project);
    refreshChips(project);
    return;
  }
  const holder = document.createElement("tbody");
  holder.innerHTML = rowHtml(row);
  const newTr = holder.firstElementChild;
  // A row that is not drawn is not built: the chart may hold it below its top N, and focus mode holds back every row
  // whose tree has no live panel (public/app.js's focusHidesRow). The state, the chips and the agents still know the
  // row (they always did; only the drawing is narrowed), and a newer activity can have changed either answer since the
  // last paint - so the row has to leave the DOM here rather than wait for the next full rebuild of the project.
  if (rowTopHidden(row) || focusHidesRow(row)) {
    const gone = state.rowEls.get(key);
    if (gone) {
      state.detailEls.get(key)?.remove();
      state.detailEls.delete(key);
      gone.remove();
      state.rowEls.delete(key);
    }
    // A row the chart held back may have been somebody's parent: its children keep their own rows, and the grouping
    // has to say so now rather than leave them indented under a row that is no longer on the chart.
    syncChildGroups(project);
    refreshChips(project);
    paintFocusSection(project);
    return;
  }
  const old = state.rowEls.get(key);
  // A collapsed section is not on screen: keep the row in state (the chips and counters need it)
  // but spend nothing on its markup. Expanding the project renders it from state. Focus mode force-expands a project
  // that holds a live row, so the fold asked here is the one the section is drawn with.
  if (!projectDrawsOpen(project)) {
    // Collapsed: there is no row on screen to flash, so a GREEN row flash becomes a green flash on the project's own
    // bar - "something inside this box moved and you could not see it". The quiet grey pulse is not repeated here:
    // "re-read, nothing moved" is not worth a project-level signal.
    if (flash && moved) pulseProject(project);
    refreshChips(project);
    return;
  }
  const cachedDetail = state.detailEls.get(key);
  // Ask the DOM, not just the cache: a rebuild can leave `detailEls` pointing at a detached detail while a
  // different one for the same key is on screen. Removing the cached one then added a second detail under the
  // row - the duplicated MERGE STATE / LIVENESS EVIDENCE block.
  const oldDetail = document.querySelector(`tr.detail[data-detail="${CSS.escape(key)}"]`) || cachedDetail;
  const oldCards = new Map();
  if (oldDetail) for (const card of oldDetail.querySelectorAll(".job[data-thread]")) oldCards.set(card.dataset.thread, card);
  const typing = oldDetail ? captureTyping(oldDetail) : null;
  // The details below come down and their cards go into new ones; a selection in a card has to come back with them.
  const heldSelection = captureCardSelection();
  const outs = oldDetail
    ? [...oldDetail.querySelectorAll("pre.job-out")].map((o) => ({
        id: o.dataset.out,
        top: o.scrollTop,
        atBottom: o._selfTop == null || o.scrollHeight - o.scrollTop - o.clientHeight < 32,
      }))
    : [];
  // The cards are carried into the new detail below, and a card taken out of the document and put back comes back at
  // its first line: hold every open child console in the old detail before it leaves, and hand each one its place
  // back in this same task, once its card is in the new detail.
  // A row repaint is not news about the CARDS filed under it. Rebuilding the detail moves every card into a fresh
  // slot, and a move is a remove-then-insert: each scroll box inside the card comes back at its first line and a
  // selection is dropped. With several agents in one row every scanner pass disturbed all of them. So the detail is
  // kept — its cards left exactly where they are — unless something it draws actually changed.
  const detailSig = rowDetailSig(row);
  const keepDetail = Boolean(oldDetail && oldDetail.isConnected && oldDetail.dataset.dsig === detailSig);
  // Only when the detail is really leaving: this detaches its child consoles into a holder to be re-attached below.
  const heldSubs = oldDetail && !keepDetail ? holdSubConsoles(oldDetail) : [];
  // A detail carrying cards is not taken down before its cards are carried out of it. fillAgentSlots() reads each
  // console's place off the node it is about to move, and a node that has already left the page reports 0 - the top,
  // which is the wrong answer for a reader who parked it. The rebuilt detail is attached below, the cards move into it
  // while the old one is still on screen, and only then does the old one go.
  const cardOut = Boolean(oldDetail && oldDetail.isConnected && rowDrawsOpen(key) && !keepDetail);
  beginDomMove();
  if (oldDetail && !keepDetail && !cardOut) oldDetail.remove();
  // Any other copy for this key is a stray from an earlier render: one row, one detail.
  for (const stray of document.querySelectorAll(`tr.detail[data-detail="${CSS.escape(key)}"]`)) {
    if (stray !== oldDetail) stray.remove();
  }
  state.detailEls.delete(key);
  if (old) old.replaceWith(newTr);
  else tbody.appendChild(newTr);
  state.rowEls.set(key, newTr);
  if (rowDrawsOpen(key) && keepDetail) {
    // Nothing the detail draws changed: keep the element — and every console inside it — exactly where it is.
    state.detailEls.set(key, oldDetail);
    // `old.replaceWith(newTr)` already leaves the detail as the new row's next sibling. Only move it if some other
    // repaint put something in between: a move is a detach, and a detached console comes back at its first line.
    if (newTr.nextElementSibling !== oldDetail) {
      const held = holdScrolls(oldDetail);
      newTr.after(oldDetail);
      releaseScrolls(held);
    }
  } else if (rowDrawsOpen(key)) {
    const h2 = document.createElement("tbody");
    h2.innerHTML = detailHtml(row);
    const dEl = h2.firstElementChild;
    if (dEl) dEl.dataset.dsig = detailSig;
    // The detail hangs under this row: it is hidden with it when its group is folded, and a rebuild of the row
    // must not drop that.
    markUnder(dEl, key);
    newTr.after(dEl);
    state.detailEls.set(key, dEl);
    // The cards move across before anything is measured, so "where was this console" is answered by the node
    // that is actually going to stay on screen - the OLD detail is still on the page here and gives up its cards one at
    // a time, so each hold reads the line the reader left, not the 0 a detail already taken down reports.
    fillAgentSlots(dEl, oldCards);
    // Every card of the old detail that is still in it is a straggler (its slot went away): the detail has nothing left
    // to show, and leaving it on the page would be a duplicate.
    if (cardOut && oldDetail) oldDetail.remove();
    rememberAgentOrder(key, dEl);
    restoreThinkBodies(dEl);
    // Put the reader back: the reply they were typing, where the caret was, and how far each
    // transcript had been scrolled.
    restoreTyping(dEl, typing);
    restoreAddAgent(dEl);
    const scrollMap = new Map(outs.map((o) => [o.id, { top: o.top, atBottom: o.atBottom }]));
    restoreScrolls(dEl, scrollMap);
    applyStoredScrolls(dEl);
    releaseScrolls(heldSubs);
    settleScrolls(dEl);
  }
  // The move is over for both shapes of row (a bare row rebuilds no detail but still replaces its <tr>).
  endDomMove();
  // After restoreTyping, which focuses the reply box and would take the document selection with it.
  restoreCardSelection(heldSelection);
  if (flash && old) {
    // Green when an agent moved in this row; a quiet grey when the refresh ran and found nothing new.
    // Two outcomes, two colours — one colour for both made every 5s tick look like progress.
    const kind = moved ? "flash" : "flash-idle";
    newTr.classList.add(kind);
    setTimeout(() => newTr.classList.remove(kind), 900);
  }
  reorder(project);
  refreshChips(project);
  // The row that just arrived can be the first of its project the narrowed board keeps, so the project may have to
  // come back out of the mode's own hiding (a no-op while the mode is off).
  paintFocusSection(project);
  // This row's cells may hold more or less than they did (a longer verdict, a chip that appeared): re-measure, once
  // per frame however many rows of this project arrived in the same tick.
  scheduleColumnFit(tbody.closest("table"));
  // The rebuild is one synchronous step, so a moved scroll is the browser clamping rather than the reader leaving:
  // put the page back before the sweep re-measures the anchor.
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  scheduleBoardSweep(rowAnchor);
  // The ⟳'s offer card sat under this row and the row was just replaced: one copy, back under the new node.
  if (state.refreshOffers.has(key)) paintRefreshOffer(key);
}

function removeRow(project, p) {
  const key = keyOf(project, p);
  // A row and its detail leaving the page shortens the document. A reader parked at the bottom would be clamped
  // upward by however tall it was, and the height does not come back with their scroll - hold the position.
  const pageY = window.scrollY;
  state.rowEls.get(key)?.remove();
  state.detailEls.get(key)?.remove();
  state.confirmEls.get(key)?.remove();
  // The offer belonged to the row that is going away: nothing can start an agent in a tree the board no longer has.
  clearRefreshOffer(key);
  state.rowEls.delete(key);
  state.detailEls.delete(key);
  state.confirmEls.delete(key);
  state.rows.delete(key);
  // A child leaving takes a worktree out of its parent's group: the parent's fold control has one fewer to name, and
  // may have none left at all.
  syncChildGroups(project);
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  refreshChips(project);
  // A row leaving takes its width requirement with it, so the split is measured again - after this tick, not inside it.
  scheduleColumnFit(state.tbodyEls.get(project)?.closest("table"));
}

// Paint one project's rows into its (possibly just replaced) tbody.
function renderProjectRows(name, { typing = null } = {}) {
  const tbody = state.tbodyEls.get(name);
  if (!tbody) return;
  // A live corner gesture holds a console somewhere on the board, and this rebuild replaces the rows it lives in. It
  // waits for the release, which asks for one full repaint (public/app.js's endOutGrip).
  if (typeof outGripLive === "function" && outGripLive()) {
    if (typeof outGripDefer === "function") outGripDefer();
    return;
  }
  // The rebuild below replaces every row of this project, and it must not walk the reader up the page. Emptying the
  // tbody and appending row by row laid the page out with part of the project missing - the reply box measures
  // itself (scrollHeight) while a draft is restored, which forces that layout - and at the bottom of the page ANY
  // shrink clamps the reader's scroll upward for good: the height comes back, the scroll position does not. So the
  // rows are built off the document and swapped in one operation, and the page position is held across the swap.
  const pageY = window.scrollY;
  // Open rows carry agent transcripts; a rebuild must not throw the reader to the top of one.
  const prevScrolls = captureScrolls(tbody);
  // The cards are carried into the rebuilt details below, so the child consoles inside them leave the document with
  // the old tbody and come back at their first line: read them here, before the swap, and release them after.
  const heldSubs = holdSubConsoles(tbody);
  const heldSelection = captureCardSelection();
  const anchor = captureBoardAnchor();
  const prevRowKeys = [...tbody.children].filter((el) => el.classList.contains("row")).map((el) => el.dataset.key);
  // The cards and the typing inside each open row live in its detail element, and this path replaces the whole
  // tbody. Capture them by row key first: the detail is rebuilt from detailHtml() below, whose agent slots are
  // empty placeholders, so without this the agents block came back as nothing and stayed empty until the next
  // scan's placeRow happened to fill it — which is what made the agents vanish for ~5s after sending a reply.
  const prevCards = new Map();
  const prevTyping = new Map();
  for (const [k, dEl] of state.detailEls) {
    if (state.rows.get(k)?.project !== name) continue;
    const cards = new Map();
    for (const card of dEl.querySelectorAll(".job[data-thread]")) cards.set(card.dataset.thread, card);
    prevCards.set(k, cards);
    prevTyping.set(k, captureTyping(dEl));
  }
  // A collapsed project shows nothing, so building its rows would be pure waste — with 94
  // projects that was ~110 invisible rows and most of the render cost of a snapshot. Focus mode force-expands a
  // project that holds a live row, so the fold this reads is the one the section is drawn with.
  const expanded = projectDrawsOpen(name);
  const frag = document.createDocumentFragment();
  const built = [];
  // Stabilized: while a row of this project is open, the rows keep the order they are already in on screen (a row
  // that is genuinely new goes last). Only the painting order changes - the ranking is still there for when the
  // reader closes everything.
  // Rows below the chart's top N are not built at all: the chart draws what it is showing, and the arrow in the
  // legend below it is what brings the rest back, in the same order they were chosen (see rowTopHidden). The ranking
  // above still sees them, so a row that comes back to life takes its place in the order the moment it is drawn again.
  const rowsInOrder = chartDrawOrder(name).filter((r) => !focusHidesRow(r));
  if (stabilizeOn() && projectHasOpenRow(name) && prevRowKeys.length) {
    const pos = new Map(prevRowKeys.map((k, i) => [k, i]));
    rowsInOrder.sort(
      (a, b) =>
        (pos.get(keyOf(name, a.path)) ?? prevRowKeys.length) - (pos.get(keyOf(name, b.path)) ?? prevRowKeys.length),
    );
  }
  if (expanded) {
    // The rank says which rows are drawn; the grouping says where each one hangs. They are one list here: every child
    // sits directly under its parent, and everything else keeps the rank's order.
    const tree = childTreeOf(name);
    const order = nestRowKeys(tree.parentOf, rowsInOrder.map((r) => keyOf(name, r.path)));
    const byKey = new Map(rowsInOrder.map((r) => [keyOf(name, r.path), r]));
    for (const k of order) {
      const row = byKey.get(k);
      if (!row) continue;
      const holder = document.createElement("tbody");
      holder.innerHTML = rowHtml(row);
      const tr = holder.firstElementChild;
      frag.appendChild(tr);
      // An open confirmation belongs to its row, and this path rebuilds every row: carry the live node
      // over so the question survives the repaint (and does not come back at the top of the table).
      const confirmEl = state.confirmEls.get(k);
      if (confirmEl) frag.appendChild(confirmEl);
      let dEl = null;
      if (rowDrawsOpen(k)) {
        const h2 = document.createElement("tbody");
        h2.innerHTML = detailHtml(row);
        dEl = h2.firstElementChild;
        // A detail hangs under its row, so it hides with the row's group; saying so here keeps it right even
        // before syncChildGroups() gets its pass over the rebuilt table.
        if (dEl) markUnder(dEl, k);
        frag.appendChild(dEl);
      }
      built.push({ key: k, tr, dEl });
    }
  }
  // One swap: the old rows leave as the new ones arrive, so the document never lays out half-built.
  beginDomMove();
  tbody.replaceChildren(frag);
  // The grouping is painted into the rebuilt rows before anything measures them: an indent changes how wide the name
  // cell is, and the cards and the typing below are restored against that layout.
  syncChildGroups(name);
  if (!expanded) {
    for (const k of [...state.rowEls.keys()]) if (state.rows.get(k)?.project === name) state.rowEls.delete(k);
    for (const k of [...state.detailEls.keys()]) if (state.rows.get(k)?.project === name) state.detailEls.delete(k);
    endDomMove();
    // Nothing of this project's is on screen any more, so its confirmation is gone with it.
    for (const k of [...state.confirmEls.keys()]) if (state.rows.get(k)?.project === name) state.confirmEls.delete(k);
    // The header is still on screen and its rows are not: measure it anyway, so opening the project later does not
    // start from the percentage fallback.
    fitColumns(tbody.closest("table"));
    // A collapsed project is hidden by focus mode exactly when none of its rows is kept, and that answer does not
    // depend on the rows being built.
    paintFocusSection(name);
    return;
  }
  const live = new Set(built.map((b) => b.key));
  for (const k of [...state.rowEls.keys()]) if (state.rows.get(k)?.project === name && !live.has(k)) state.rowEls.delete(k);
  // A confirmation whose row was not rebuilt is no longer on the page either.
  for (const k of [...state.confirmEls.keys()]) if (state.rows.get(k)?.project === name && !live.has(k)) state.confirmEls.delete(k);
  // Only now, with the rows in the document, put the cards into the slots the rebuilt detail made for them and the
  // reader's draft and caret back into the reply box: a detached box cannot measure itself against its own text.
  for (const { key, tr, dEl } of built) {
    state.rowEls.set(key, tr);
    if (!dEl) continue;
    state.detailEls.set(key, dEl);
    fillAgentSlots(dEl, prevCards.get(key) || new Map());
    // The thinking block lives in the card and this path re-renders or re-inserts every card in the
    // project. Without this the running turn's open block came back at its FIRST line on every project
    // event, which is what read as the reasoning flickering while the tool calls scrolled out of view.
    restoreThinkBodies(dEl);
    rememberAgentOrder(key, dEl);
    restoreTyping(dEl, prevTyping.get(key) || null);
    restoreAddAgent(dEl);
  }
  endDomMove();
  // The cards have been carried into the rebuilt details; put each open child console back on its line in this same
  // task, so the swap is never painted with one of them at the top.
  releaseScrolls(heldSubs);
  // A row that no longer exists must not leave a dead detail element remembered.
  for (const k of [...state.detailEls.keys()]) {
    if (state.rows.get(k)?.project !== name) state.detailEls.delete(k);
    else if (!rowDrawsOpen(k)) state.detailEls.delete(k);
  }
  // The rows this table holds have just changed, so what each column has to be wide enough for changed with them.
  // Measured here, before the position below is restored: a new split can re-wrap a chip strip and make a row
  // taller, and a height change after the restore is a clamp the reader keeps.
  fitColumns(tbody.closest("table"));
  // The swap can still change the document's height - a row that really did appear or go away. This whole rebuild is
  // one synchronous step, so a scroll that moved under it is the browser clamping (near the bottom, a shorter page
  // pulls the reader up), never the reader scrolling away: put the page back where it was.
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  // A caller that replaced the project's section before calling us has already detached the box the reader was
  // typing in, so there was nothing left here to capture: it hands the caret in instead, and this puts it back into
  // the box we just rebuilt.
  if (typing) restoreTyping(tbody, typing);
  restoreScrolls(tbody, prevScrolls);
  applyStoredScrolls(tbody);
  settleScrolls(tbody);
  restoreCardSelection(heldSelection);
  scheduleBoardSweep(anchor);
  refreshAnchorBaseline();
  // This path rebuilds the table in ranked order, which is how a row most often changes place (a
  // project event or a snapshot). Without this the move was silent — the node was new, so nothing
  // remembered where it used to be.
  flashMovedByKey(prevRowKeys, [...tbody.children].filter((el) => el.classList.contains("row")), tbody);
  // …and the ⟳'s offer card was a child of this tbody too. It lives in state, so put it back under its row instead of
  // letting a repaint answer the question for the reader.
  paintRefreshOffers(name);
  // The section follows its rows: kept while one of them is, hidden otherwise (a no-op while the mode is off).
  paintFocusSection(name);
}
