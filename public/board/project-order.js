// project-order.js - cut 1 of the three in public/render-projects.js: where a folder and a project sit.
//
// Cut 1 of the three in the card for public/render-projects.js, entry 6 of the order of work in
// docs/reports/module-separation-2026-11-28.html (row 530). It is a move, not a rewrite: lines
// 59-561 of the base file are below, verbatim, and no body was rewritten and no call site touched.
//
// WHAT IS HERE. A project's ordering: projectActivity, folderActivity, shownInRoot, projectRanks,
// pinOpenProjects, sortedProjects and queueReorderProjects, plus reorderProjects and the board's own
// children reads under it (childrenMatching, boardGroups, groupBody). A folder's card: rootScanChip,
// rootChips, rootRecentButton, cloneHostOptions and rootSection. The legend: legendId, legendHtml,
// legendControl, closeLegends and toggleLegend with legendOpenFor. The project section itself:
// projectSection and refreshChips.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: every
// top-level `function` here is a window property, every `let` a binding another script reads by bare
// name. This file declares and registers only: reorderFrame and legendOpenFor are literal initialisers,
// and the legend's outside-press and Escape listeners are registered at load, exactly where they were
// registered in the parent, so being loaded before render-projects.js and app.js costs nothing.
// public/render-projects.js keeps the header and the record of this surface, and app.js re-exports the
// names on window.WMApp.projects.

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
    return v && !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN" && v !== "ON BASE" && v !== "RELEASED" && v !== "STALE";
  }).length;
  // A tree that has vanished from disk is its own count, never folded into unmerged: the row is kept so its cards stay
  // under it with the reason (lib/store.js markStale), and "unmerged" would be a claim nothing read.
  const gone = rows.filter((r) => String(r.verdict || "") === "STALE").length;
  const dirty = rows.filter((r) => r.dirty || r.untracked).length;
  const full = Number.isFinite(Number(total)) ? Math.max(0, Math.round(Number(total))) : projects.length;
  const out = [
    `<span class="chip">${full} project${full === 1 ? "" : "s"}</span>`,
    rootScanChip(scanning),
    `<span class="chip">${rows.length} worktrees</span>`,
  ].filter(Boolean);
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (gone) out.push(`<span class="chip warn" title="tree rows kept because their folder is gone from disk - their agents stay under them with the reason, instead of falling into the unattached list">${gone} gone</span>`);
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

// The clone row's host dropdown, fed from the host store the page already holds (`state.hosts.hosts`, lib/hosts.js):
// never a second list written here, so a host added to hosts.json is an option on the next snapshot with no code
// change. The label is the record's own `name`; the id is what the route receives. A host without a clone.ssh route
// still lists, because the route's refusal NAMES it and a missing option would hide the reason.
function cloneHostOptions(root) {
  const hosts = state.hosts?.hosts || {};
  const ids = Object.keys(hosts);
  if (!ids.length) return `<option value="">no hosts configured</option>`;
  const remembered = state.cloneHost?.[root];
  const chosen = ids.includes(remembered) ? remembered : ids[0];
  return ids
    .map((id) => {
      const rec = hosts[id] || {};
      const label = rec.name || id;
      return `<option value="${esc(id)}"${id === chosen ? " selected" : ""}>${esc(label)}</option>`;
    })
    .join("");
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
      <button type="button" class="btn-root-clone" data-root-clone="${esc(root)}" title="clone a repo over ssh into ${esc(labelRoot(root))} - pick its host in the row">+</button>
    </div>
    <div class="root-clone" data-clone-form="${esc(root)}"${state.cloneStatus[root] ? "" : " hidden"}>
      <input type="text" data-clone-input="${esc(root)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" placeholder="repo name - agent-worktree-gui, JLRoper/agent-worktree-gui or citdev/java-ruleset" spellcheck="false">
      <select data-clone-host="${esc(root)}" title="which host's clone route builds the URL - the list comes from hosts.json, not from this page">${cloneHostOptions(root)}</select>
      <button type="button" data-clone-go="${esc(root)}">Clone via ssh</button>
      <button type="button" data-project-new="${esc(root)}" title="create a new local git project in ${esc(labelRoot(root))} - inited on main with one commit, nothing fetched or pushed">New local project</button>
      <span class="mono dim${state.cloneStatus[root]?.kind === "err" ? " clone-err" : ""}" data-clone-msg="${esc(root)}">${esc(state.cloneStatus[root]?.text || "")}</span>
    </div>
    <div class="root-body">
      <p class="root-empty" data-root-empty></p>
${projects.map((p) => projectSection(p.name)).join("\n")}
    </div>
  </section>`;
}

// ---- the legend: one line at rest, the words behind a popover -----------------------------------
// The legend used to be ONE dense paragraph under every chart - the five liveness chips, the age number and its
// ring, the kind column's three letters and the fold, all at once, ~700 characters the reader asked to put away.
// It is a DISCLOSURE now. Collapsed, the strip carries every SYMBOL with its short word - the chips already read
// hermes, claude, board, port and files, the kind marks keep T, R and I, and the parent's chevron keeps "fold" -
// plus one control whose visible label says what it is. Expanded, the popover carries the same words as SHORT
// LINES under three headings, so nothing the block taught is lost; it is only deferred until asked for.
//
// The strip is a real one-line box: `flex-wrap: nowrap` in the sheet, and the keys clip rather than wrap, so the
// control stays beside them at the live width instead of dropping to a second row. The popover is absolute, so
// opening it never reflows the chart, and it hangs under the strip - the bottom edge of the card - so it cannot
// cover a tree row; .legend is its containing block.
//
// Keyboard is the button's own: Enter and Space fire its click, so both open (and close) it. Escape closes it and
// leaves focus on the button, where `:focus-visible` draws the ring; a press anywhere outside closes it. The open
// name lives in `legendOpenFor` rather than only in the DOM, so a board repaint (which rebuilds this section's
// markup from `legendHtml`) redraws an open popover open instead of closing it under the reader.
function legendId(name) {
  // Injective, so two project names that sanitise alike cannot share one popover's id: every character outside
  // [A-Za-z0-9_-] becomes its code point in hex, fenced by underscores.
  return `legend-pop-${String(name || "project").replace(/[^A-Za-z0-9_-]/g, (ch) => `_${ch.codePointAt(0).toString(16)}_`)}`;
}

let legendOpenFor = null;

function legendHtml(name) {
  const id = legendId(name);
  const open = legendOpenFor === name;
  return `<div class="legend" data-legend="${esc(name)}">
      <div class="legend-line">
        <span class="age-slot" data-age-slot="${esc(name)}"></span>
        <span class="legend-keys">
          <span class="sig sig-hermes">⧉ hermes</span>
          <span class="sig sig-claude">⧉ claude</span>
          <span class="sig sig-board">● board</span>
          <span class="sig sig-port">:port</span>
          <span class="sig sig-files">✎ files</span>
          <span class="kind-mark kind-turnover" role="img" aria-label="turnover tree">T</span>
          <span class="kind-mark kind-research" role="img" aria-label="research tree">R</span>
          <span class="kind-mark kind-implementation" role="img" aria-label="implementation tree">I</span>
          <span class="legend-fold"><span class="legend-fold-glyph" aria-hidden="true">▾</span> fold</span>
        </span>
        <button type="button" class="legend-toggle" data-legend-toggle="${esc(name)}" aria-expanded="${open ? "true" : "false"}" aria-controls="${esc(id)}"><span class="legend-q" aria-hidden="true">?</span> what these mean</button>
      </div>
      <div class="legend-pop" id="${esc(id)}" data-legend-pop="${esc(name)}" role="group" aria-label="what the chart's marks mean"${open ? "" : " hidden"}>
        <div class="legend-group">
          <h4>liveness evidence</h4>
          <p><span class="sig sig-hermes">⧉ hermes</span> session active</p>
          <p><span class="sig sig-claude">⧉ claude</span> Claude Code session active</p>
          <p><span class="sig sig-board">● board</span> live board PID</p>
          <p><span class="sig sig-port">:port</span> dev server listening</p>
          <p><span class="sig sig-files">✎ files</span> edited recently</p>
          <p class="legend-note">a row is live only if one of these fired</p>
          <p class="legend-note">the number is time since that last happened, the ring fills up to green as the row becomes due for its next read</p>
        </div>
        <div class="legend-group">
          <h4>the kind column</h4>
          <p><span class="kind-mark kind-turnover" role="img" aria-label="turnover tree">T</span> turnover tree (the feature container - research and implementation trees are cut from it, and an implementation tree's work merges back into it locally)</p>
          <p><span class="kind-mark kind-research" role="img" aria-label="research tree">R</span> research tree (local only - press the R to lift it)</p>
          <p><span class="kind-mark kind-implementation" role="img" aria-label="implementation tree">I</span> implementation tree (local only - press the I to lift it)</p>
          <p><span class="kind-mark kind-turnover is-lifted" role="img" aria-label="upgraded tree">T</span> an upgraded tree (was R or I - it behaves as a turnover tree, and its tooltip names the kind it was)</p>
        </div>
        <div class="legend-group">
          <h4>folding</h4>
          <p>a tree cut from another one hangs under it, one indent in, and the ▾ on its parent folds the group out of sight</p>
          <p>a fold only hides, every chip and open panel stays as it was</p>
        </div>
      </div>
    </div>`;
}

function legendControl(name) {
  return [...document.querySelectorAll("[data-legend-toggle]")].find((b) => b.dataset.legendToggle === name) || null;
}

function closeLegends() {
  legendOpenFor = null;
  for (const pop of document.querySelectorAll("[data-legend-pop]")) {
    if (pop.hidden) continue;
    pop.hidden = true;
    legendControl(pop.dataset.legendPop)?.setAttribute("aria-expanded", "false");
  }
}

function toggleLegend(name) {
  const btn = legendControl(name);
  const pop = btn ? document.getElementById(btn.getAttribute("aria-controls") || "") : null;
  if (!btn || !pop || pop.dataset.legendPop !== name) return;
  const opening = pop.hidden;
  closeLegends();
  if (!opening) return;
  pop.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  legendOpenFor = name;
}

// The two delegated presses this disclosure needs, and nothing more. A press on the control toggles; any press
// outside the popover (and off the control) closes it; Escape closes it and puts focus back on the control that
// opened it, which is where the ring stays visible.
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-legend-toggle]");
  if (btn) {
    toggleLegend(btn.dataset.legendToggle);
    return;
  }
  if (legendOpenFor && !e.target.closest?.("[data-legend-pop]")) closeLegends();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !legendOpenFor) return;
  const btn = legendControl(legendOpenFor);
  closeLegends();
  btn?.focus();
});
// ---- end the legend -----------------------------------------------------------------------------

function projectSection(name) {
  const p = state.projects.get(name) || { name };
  // Focus mode force-expands a project that holds a live row (public/app.js projectDrawsOpen), so the class, the
  // chevron and the head's tooltip all follow the answer the rows are built from rather than the stored fold.
  const open = projectDrawsOpen(name);
  // A project that names its base branches is described by THAT list, not by an `origin/main` it does not have: the
  // fleet repositories keep dev, qa, uat and prod long-lived, so the single-base line would read `cannot resolve
  // origin/main:` under a header whose every row is measured correctly against its own base (lib/base-branches.js).
  // The list is what the reader checks the rows' chips against, so it is drawn with the resolved branch names.
  const bases = Array.isArray(p.baseBranches) ? p.baseBranches : [];
  const baseLine = bases.length
    ? `${bases.length} base branch${bases.length === 1 ? "" : "es"}: ${bases
        .map((b) => `${esc(b.branch)}${b.env && b.env !== b.branch ? ` (${esc(b.env)})` : ""}`)
        .join(", ")}`
    : null;
  const mainLine = baseLine
    ? baseLine
    : p.localMain && p.remoteTip
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
      <span class="dimmer mono">${p.fetchNote ? esc(p.fetchNote) + " · " : ""}fetched ${relTime(p.fetchedAt)} ago</span>${hostChipHtml(name)}${rulesChipHtml(name)}${turnoverChipHtml(name)}${boardChipHtml(name)}${cleanupDropAllButtonHtml(name)}${cleanupChipHtml(name)}
    </div>
    ${projectBarsHtml(name)}
    <div class="wt-scroll">
      <table><thead><tr>${chartHeaderHtml()}</tr></thead><tbody data-tbody="${esc(name)}"></tbody></table>
    </div>
    ${legendHtml(name)}
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
  // The two chips in each row's own strip are body-level popups when they are open, and this path is where a row's
  // chip nodes have just been replaced: an open card is re-anchored onto its row's new chip here, and one whose row
  // left the board is closed. It reads the page's remembered set, so the card a reader left open comes back open.
  if (typeof paintRowChipPops === "function") paintRowChipPops();
  // The rules chip sits in the project's second head line rather than in this strip, and a snapshot (which repaints
  // only the strip and the rows) is how a count saved in another tab arrives — so it is refreshed from here.
  refreshRulesChip(name);
  // The turnover chip is in that same line, and a branch saved in another tab arrives the same way.
  refreshTurnoverChip(name);
  // The cleanup chip is the fifth of that line and holds the last answer the server sent, so a repaint of the strip
  // is where a phase that moved while the reader was elsewhere is redrawn.
  refreshCleanupUi(name);
  // The chart's arrow (top-N collapse) depends on the same rows, so it is refreshed from the same place.
  refreshTopToggle(name);
}
