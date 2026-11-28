// board/anchor.js - the liveness ranking, the reading anchor and the board's own hygiene, cut out of
// public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js is the file six open queue rows claimed at 2026-11-28. This is
// cut 6 of the eight in docs/reports/module-separation-2026-11-28.html, section 5's card for
// public/app.js: "the rank windows, the event life and the anchor that keeps a repaint from
// jumping". Moved line for line: not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   the sliding average     lifeRowKey, lifeProjKey, lifeAgentKey, rankWindowMs, pushEventLife,
//                           rankWindowCount, rankScore and pruneRankWindows: a row's "life" used to
//                           be the moment of its last event, which is a maximum; these average over
//                           a sliding window instead, and prune what has aged out.
//   one ranked sequence     rankIdealOrder, tickRankedOrder and orderedByRank: one sequence, advanced
//                           a tick at a time.
//   the contexts            rowRankCtx, projectRankCtx, folderRankCtx and agentRankCtx: what each
//                           scope ranks on.
//   seeding                 seedRankWindows and seedProjectRank: the first paint is the smoothed
//                           order, not a fresh-start scramble.
//   the ticks               tickRowScope, tickAgentScopes, tickProjectScopes, tickLivenessRanks,
//                           reorderAgentCards and noteEventLife: the order moves here and nowhere
//                           else.
//   the reading anchor      the project hue, the anchor flag and its seconds, the thread the reader
//                           pinned, readingTop / nearestReadingLine / anchorVisible / anchorCardFor,
//                           the flash durations (FLASH_BASE_SECONDS, flashScale, flashRowMs,
//                           flashProjectMs, flashRingMs, anchorHoverMs, anchorTouchMs), the node the
//                           anchor intent resolves to, the compensation that keeps a repaint from
//                           jumping, and startAnchorObserver.
//   board hygiene           captureBoardAnchor, holdAnchor, scheduleBoardSweep and sweepStaleBoard:
//                           the reader's place held across a board sweep.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state.rankWindows, state.rowRank, state.projectRank, state.agentRank, state.rows, state.projects,
//   state.jobs, state.anchor, state.anchorPin, state.flash, state.expanded, state.expandedProjects,
//   document, localStorage
//                          the stores and the page the ranking and the anchor keep.
//   esc, keyOf, normPath (core/dom-format.js), and public/app.js's own $, showNote, renderAll,
//   placeRow, refreshChips, paintRowChips, repaintAgentState, applyPendingFocus, programmaticScroll,
//   toggleProject, toggleRoot, saveCollapsedRoots and the chart's column painters.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a
// top-level `function` here is a window property and a top-level `let` (anchorState, anchorBusy,
// boardAnchor and the rest) is a binding every other script reads by bare name. index.html loads this
// file before app.js, and the file DECLARES ONLY - nothing here reads a `state` field or an app.js
// binding while it loads - so sitting before app.js costs nothing and cannot land in a temporal dead
// zone. public/app.js re-exports these names on window.WMApp.anchor, which is the door
// public/render-projects.js, public/render-jobs.js, public/settings.js, public/charts.js,
// public/board/spawn.js and public/core/sse.js already reach for.
//
// WHAT STAYED IN app.js: the 1 s clock and the observers that start them are load-time wiring at the
// bottom of app.js; they call these functions by bare name when they tick.
//
// RE-MEASURED FROM 3bb43694. The report's card names 8,762-9,723. On this base it is 4,786-5,813: the
// report's row began at pruneRankWindows, which would have left the seven helpers that window exists
// for in app.js; the cut takes the whole section from its own banner, which is the same code plus
// those helpers and the board-hygiene block that closes it.

// ---- the sliding average every liveness ranking is built on -----------------------------------
// A row's "life" used to be the moment of its LAST event, which is a maximum: one console line promoted the row to
// the top and the next line demoted it. The same shape drove the projects in a folder (newest activity wins) and
// the agent cards inside a worktree (newest turn first). All of them now average over a sliding window instead -
// the events in the last RANK_WINDOW seconds, as a rate per minute - so something being hammered sits high, a
// single line moves nothing, and a thing that goes quiet slides down as its events age out.
//
// ONE engine serves all of them. `pushEventLife(windowKey, at)` records an event against a namespaced key
// ("row:...", "proj:...", "agent:..."), `rankScore` turns that window into events per minute, and
// `tickRankedOrder` advances one scope's order by ONE adjacent swap per reorder tick, with hysteresis. It is
// bounded: every ring is capped at RANK_EVENT_CAP and pruned by the window, so a long session cannot grow it.

function lifeRowKey(rowKey) {
  return `row:${rowKey}`;
}
function lifeProjKey(project) {
  return `proj:${project}`;
}
function lifeAgentKey(thread) {
  return `agent:${thread}`;
}

function rankWindowMs() {
  const n = Number(state.rankWindowSeconds);
  return (Number.isFinite(n) && n > 0 ? n : RANK_WINDOW_DEFAULT) * 1000;
}

// One liveness event against a window key. Events arrive in time order, so the ring stays sorted and the prune is
// a splice off the front (amortised O(1) per event); the cap bounds it even under a flood.
function pushEventLife(windowKey, at) {
  if (!windowKey) return;
  const t = Number(at);
  if (!Number.isFinite(t)) return;
  let arr = state.eventWindows.get(windowKey);
  if (!arr) {
    arr = [];
    state.eventWindows.set(windowKey, arr);
  }
  arr.push(t);
  const cutoff = t - rankWindowMs();
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  if (i) arr.splice(0, i);
  if (arr.length > RANK_EVENT_CAP) arr.splice(0, arr.length - RANK_EVENT_CAP);
}

// How many of the window's events are still inside it. The ring is sorted, so this is a scan of at most
// RANK_EVENT_CAP entries - read-only, so it is safe to call from a comparator.
function rankWindowCount(windowKey, now) {
  const arr = state.eventWindows.get(windowKey);
  if (!arr || !arr.length) return 0;
  const cutoff = now - rankWindowMs();
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  return arr.length - i;
}

// The smoothed score: events per minute across the window. One console line in the default 300 s window is
// 0.2/min; a burst of twenty in ten seconds is 4/min.
function rankScore(windowKey, now) {
  return rankWindowCount(windowKey, now) / (rankWindowMs() / 60000);
}

// Drop everything that has aged out of the window, and the windows and orders of things that are gone, so a long
// session does not grow with time or with the fleet.
function pruneRankWindows(now) {
  const cutoff = now - rankWindowMs();
  const liveProjects = new Set();
  for (const r of state.rows.values()) liveProjects.add(r.project);
  for (const [key, arr] of [...state.eventWindows]) {
    let i = 0;
    while (i < arr.length && arr[i] <= cutoff) i++;
    if (i) arr.splice(0, i);
    if (!arr.length) state.eventWindows.delete(key);
  }
  for (const key of [...state.rankSeeded]) if (!state.rows.has(key)) state.rankSeeded.delete(key);
  for (const name of [...state.rankProjSeeded]) if (!state.projects.has(name)) state.rankProjSeeded.delete(name);
  for (const scope of [...state.rankOrder.keys()]) {
    const gone = scope.startsWith("rows:")
      ? !liveProjects.has(scope.slice(5))
      : scope.startsWith("agents:")
        ? !state.rows.has(scope.slice(7))
        : scope === "projects"
          ? !state.projects.size
          : scope === "folders"
            ? !$("projects")
            : true;
    if (gone) state.rankOrder.delete(scope);
  }
}

// ---- one ranked sequence, advanced a tick at a time ---------------------------------------------
// `ids` are a scope's members (row keys, project names, thread names). `ctx` answers, per id: its `tier` (a
// primary key that applies at once), its `score` (the smoothed rate over its own window), its `recency` evidence
// and a `path` for the final tie-break. The stored order lives in state.rankOrder under `scope`.

function rankIdealOrder(ids, ctx) {
  return [...ids].sort(
    (x, y) =>
      ctx.tier(x) - ctx.tier(y) ||
      ctx.score(y) - ctx.score(x) ||
      ctx.recency(y) - ctx.recency(x) ||
      String(ctx.path(x)).localeCompare(String(ctx.path(y))),
  );
}

function tickRankedOrder(scope, ids, ctx) {
  const set = new Set(ids);
  if (!set.size) {
    state.rankOrder.delete(scope);
    return [];
  }
  const prev = (state.rankOrder.get(scope) || []).filter((k) => set.has(k));
  if (!prev.length) {
    const order = rankIdealOrder([...set], ctx);
    state.rankOrder.set(scope, order);
    return order;
  }
  const order = prev.slice();
  // A member that has just appeared gets a slot at the end; the pass below lets it climb as it proves itself.
  for (const id of set) if (!order.includes(id)) order.push(id);
  const beats = (down, up) => {
    const td = ctx.tier(down);
    const tu = ctx.tier(up);
    if (td !== tu) return td < tu;
    const sd = ctx.score(down);
    const su = ctx.score(up);
    if (sd > su + RANK_MARGIN_PER_MIN) return true;
    if (su > sd + RANK_MARGIN_PER_MIN) return false;
    // Within the margin of each other: the existing recency evidence decides, then the path.
    const rd = ctx.recency(down);
    const ru = ctx.recency(up);
    if (rd !== ru) return rd > ru;
    return String(ctx.path(down)).localeCompare(String(ctx.path(up))) < 0;
  };
  // ONE pass of adjacent swaps in which each member moves at most one slot, so a burst climbs a place a tick and a
  // burst that stops slides a place a tick, instead of either leaping.
  const moved = new Set();
  for (let i = 0; i < order.length - 1; i++) {
    const up = order[i];
    const down = order[i + 1];
    if (moved.has(up) || moved.has(down)) continue;
    if (beats(down, up)) {
      order[i] = down;
      order[i + 1] = up;
      moved.add(up);
      moved.add(down);
    }
  }
  state.rankOrder.set(scope, order);
  return order;
}

// The ids in the stored order, with tiers still applied at once (a running agent must not wait for a tick) and
// anything the tick has not seen yet falling to the ideal comparison. With no tick yet - a first paint - the
// seeded ideal order IS the order, which is what makes a reload come back smoothed rather than scrambled.
function orderedByRank(scope, ids, ctx) {
  if (ids.length < 2) return ids;
  if (!state.rankOrder.has(scope)) tickRankedOrder(scope, ids, ctx);
  const order = state.rankOrder.get(scope) || [];
  const pos = new Map(order.map((k, i) => [k, i]));
  return [...ids].sort((a, b) => {
    const ta = ctx.tier(a);
    const tb = ctx.tier(b);
    if (ta !== tb) return ta - tb;
    const pa = pos.has(a) ? pos.get(a) : order.length;
    const pb = pos.has(b) ? pos.get(b) : order.length;
    if (pa !== pb) return pa - pb;
    return ctx.score(b) - ctx.score(a) || ctx.recency(b) - ctx.recency(a) || String(ctx.path(a)).localeCompare(String(ctx.path(b)));
  });
}

// ---- the contexts: what each scope ranks on ------------------------------------------------------
// Rows inside a project: our own running agents first (rowTier, untouched), then the row's own window, then the
// existing recency evidence (lastAliveAt, which an event does NOT move), then the path.
function rowRankCtx(now) {
  const rowOf = (key) => state.rows.get(key);
  return {
    tier: (key) => { const r = rowOf(key); return r ? rowTier(r) : 2; },
    score: (key) => rankScore(lifeRowKey(key), now),
    recency: (key) => { const r = rowOf(key); return r ? lifeAt(r) : Number.NEGATIVE_INFINITY; },
    path: (key) => { const r = rowOf(key); return r ? r.path : key; },
  };
}

// Projects in a folder: the existing tier (a project an agent is busy in leads), then the project's own window,
// then its newest activity, then the name.
function projectRankCtx(rank, now) {
  const at = (name) => rank.get(name) || { tier: 2, activity: 0 };
  return {
    tier: (name) => at(name).tier,
    score: (name) => rankScore(lifeProjKey(name), now),
    recency: (name) => at(name).activity,
    path: (name) => String(name),
  };
}

// A folder ranks on its busiest project: the best tier, the best rate, the newest activity.
function folderRankCtx(byRoot, rank, now) {
  const cache = new Map();
  const info = (root) => {
    if (cache.has(root)) return cache.get(root);
    let tier = 2;
    let score = 0;
    let recency = 0;
    for (const name of byRoot.get(root) || []) {
      const r = rank.get(name) || { tier: 2, activity: 0 };
      tier = Math.min(tier, r.tier);
      recency = Math.max(recency, r.activity);
      score = Math.max(score, rankScore(lifeProjKey(name), now));
    }
    const v = { tier, score, recency };
    cache.set(root, v);
    return v;
  };
  return {
    tier: (root) => info(root).tier,
    score: (root) => info(root).score,
    recency: (root) => info(root).recency,
    path: (root) => String(root),
  };
}

// Agent cards inside one worktree: no tier (a card is not a worktree), the thread's own window, then its newest
// turn start, then the thread id so the order is total.
function agentRankCtx(row, now) {
  const byThread = new Map(agentsFor(row).map((c) => [c.thread, c]));
  const started = (t) => {
    const c = byThread.get(t);
    return c ? Number(Date.parse(c.latest?.startedAt || "")) || 0 : 0;
  };
  return {
    tier: () => 0,
    score: (t) => rankScore(lifeAgentKey(t), now),
    recency: (t) => started(t),
    path: (t) => String(t),
  };
}

// ---- seeding: the first paint is the smoothed order, not a fresh-start scramble -------------------
// Seed one row's windows from the life it ALREADY carries - its own lastAliveAt / lastEdit / lastCommit and the
// start or end of any of its jobs' turns - into the row's window, its project's window, and each job's own agent
// window. Seeded once per row key.
function seedRankWindows(row) {
  if (!row) return;
  const key = keyOf(row.project, row.path);
  if (state.rankSeeded.has(key)) return;
  state.rankSeeded.add(key);
  const now = Date.now();
  const cutoff = now - rankWindowMs();
  const stamps = [];
  const perAgent = new Map();
  const add = (v) => {
    const t = Date.parse(v || "");
    if (Number.isFinite(t) && t > cutoff && t <= now) stamps.push(t);
  };
  add(row.lastAliveAt);
  add(row.lastEdit);
  add(row.lastCommit);
  const path = normPath(row.path).toLowerCase();
  for (const j of state.jobs.values()) {
    if (normPath(j.ownerPath || "").toLowerCase() !== path) continue;
    add(j.startedAt);
    add(j.endedAt);
    const thread = j.thread || j.id;
    if (!thread) continue;
    const arr = perAgent.get(thread) || [];
    for (const v of [j.startedAt, j.endedAt]) {
      const t = Date.parse(v || "");
      if (Number.isFinite(t) && t > cutoff && t <= now) arr.push(t);
    }
    if (arr.length) perAgent.set(thread, arr);
  }
  stamps.sort((a, b) => a - b);
  for (const t of stamps) {
    pushEventLife(lifeRowKey(key), t);
    pushEventLife(lifeProjKey(row.project), t);
  }
  for (const [thread, arr] of perAgent) {
    arr.sort((a, b) => a - b);
    for (const t of arr) pushEventLife(lifeAgentKey(thread), t);
  }
}

// A project's own activity is life for its window too, once.
function seedProjectRank(project) {
  if (!project || !project.name || state.rankProjSeeded.has(project.name)) return;
  state.rankProjSeeded.add(project.name);
  const t = Date.parse(project.activityAt || "");
  const now = Date.now();
  if (Number.isFinite(t) && t > now - rankWindowMs() && t <= now) pushEventLife(lifeProjKey(project.name), t);
}

// ---- the ticks: the order moves here and nowhere else --------------------------------------------
function tickRowScope(project, now = Date.now()) {
  const ids = [...state.rows.values()].filter((r) => r.project === project).map((r) => keyOf(r.project, r.path));
  return tickRankedOrder(`rows:${project}`, ids, rowRankCtx(now));
}

function tickAgentScopes(project, now = Date.now()) {
  for (const row of state.rows.values()) {
    if (row.project !== project) continue;
    const key = keyOf(row.project, row.path);
    const threads = agentsFor(row).map((c) => c.thread);
    // A row with no cards right now keeps whatever order it had: the card list is empty for a moment (a repaint, a
    // resync) far more often than it is really gone, and forgetting the order would make every card climb again
    // from the bottom. The scope dies with its row, in pruneRankWindows.
    if (!threads.length) continue;
    tickRankedOrder(`agents:${key}`, threads, agentRankCtx(row, now));
  }
}

function tickProjectScopes(now = Date.now()) {
  const host = $("projects");
  if (!host) return;
  const ids = [...state.projects.keys()];
  const rank = projectRanks();
  tickRankedOrder("projects", ids, projectRankCtx(rank, now));
  const byRoot = new Map();
  for (const name of ids) {
    const root = rootOf(state.projects.get(name)) || "";
    const arr = byRoot.get(root) || [];
    arr.push(name);
    byRoot.set(root, arr);
  }
  const roots = boardGroups(host).map((g) => g.dataset.root).filter(Boolean);
  if (roots.length) tickRankedOrder("folders", roots, folderRankCtx(byRoot, rank, now));
}

// The whole board, on the reorder clock: prune, advance every liveness scope one tick, and re-apply the orders.
// Nothing here runs per event, so a line arriving cannot shuffle anything.
function tickLivenessRanks(now = Date.now()) {
  pruneRankWindows(now);
  const projects = new Set([...state.rows.values()].map((r) => r.project));
  for (const name of projects) {
    tickRowScope(name, now);
    tickAgentScopes(name, now);
    reorder(name);
    reorderAgentCards(name);
  }
  tickProjectScopes(now);
  reorderProjects();
}

// Re-apply the agent-card order inside one project's open rows, in place, so a tick moves the cards without
// rebuilding a transcript. Stabilize reordering (with a card open) wins, exactly as it does for rows.
function reorderAgentCards(project) {
  for (const [key, dEl] of state.detailEls) {
    const row = state.rows.get(key);
    if (!row || row.project !== project) continue;
    const block = dEl.querySelector(".agents-block");
    if (!block) continue;
    const cards = [...block.children].filter((el) => el.classList.contains("job") && el.dataset.thread);
    if (cards.length < 2) continue;
    if (stabilizeOn() && rowHasOpenCard(cards.map((c) => c.dataset.thread))) continue;
    const order = orderedByRank(`agents:${key}`, cards.map((c) => c.dataset.thread), agentRankCtx(row, Date.now()));
    const pos = new Map(order.map((t, i) => [t, i]));
    const sorted = [...cards].sort((a, b) => (pos.get(a.dataset.thread) ?? order.length) - (pos.get(b.dataset.thread) ?? order.length));
    if (sorted.every((el, i) => el === cards[i])) continue;
    // Same discipline as reorder() and reorderProjects(): the cards that are already in their slot are never taken
    // out of the page (re-inserting every card before the anchor detached ALL of them, and a detached console comes
    // back at its first line), and the consoles of the ones that do move are read before the move and handed back in
    // this same task. Two live cards in one worktree row are the pair that swap places most, so this is the move a
    // reader sees as "something is switching between my consoles".
    const rest = [...block.children].filter((el) => !(el.classList.contains("job") && el.dataset.thread));
    const held = holdScrolls(block);
    beginDomMove();
    placeInOrder(block, [...sorted, ...rest]);
    endDomMove();
    releaseScrolls(held);
  }
}

// An event about a worktree is a sign of life in its own right: the age number starts again, the ring (which counts
// toward the next read) restarts from now, and the row and its project take the green pulse - unless the reader has
// switched that pulse off. Returns true when the event belonged to a row, so a caller can tell the difference.
function noteEventLife(thread) {
  const now = Date.now();
  // Every event is life for THREE windows: the agent card itself, the worktree row that owns it, and that row's
  // project. An unattached agent still has its own card, so it still ranks - it just has no row to light up.
  pushEventLife(lifeAgentKey(thread), now);
  const key = rowKeyForThread(thread);
  if (!key) return false;
  if (now > (state.eventLife.get(key) || 0)) state.eventLife.set(key, now);
  const row = state.rows.get(key);
  // ...and the row's and project's windows, which is what those two RANKINGS average. The orders themselves are
  // recomputed on the reorder clock (tickLivenessRanks), never here: an event still stamps life, pulses the row
  // and repaints the age cell exactly as it did before.
  pushEventLife(lifeRowKey(key), now);
  if (row && row.project) pushEventLife(lifeProjKey(row.project), now);
  const node = rowNode(key);
  const cell = node?.querySelector("td.age") || null;
  if (cell && row) paintLifeCell(cell, row);
  const readCell = node?.querySelector("td.nextread") || null;
  if (readCell && row) paintNextReadCell(readCell, row);
  if (state.eventFlash) {
    const last = state.lastEventFlashAt.get(key) || 0;
    if (now - last >= 900) {
      state.lastEventFlashAt.set(key, now);
      pulseRow(key);
      pulseProject(row?.project);
    }
  }
  return true;
}

// Move each live card into the slot the freshly built detail made for it. A card that is not on the board yet is
// built here; one that is keeps its DOM, so its console, its open turns and its scroll position all survive a
// row repaint. Insertion order follows the slots, so the agents stay in the order the row ranks them.
// ---- the reading anchor ------------------------------------------------------------------------
// Order is already held (reorder/pinOpenProjects): nobody jumps over an open row or project. Height is not:
// a console that starts streaming, a thinking block opening, a row arriving - each changes the height above
// whatever the reader is looking at, and the page used to creep out from under them. This holds the viewport:
// the element under the reading line stays under it while things above it grow.

// THE PROJECT'S COLOUR RULE LIVES IN public/core/theme-hue.js, and these three are the names app.js has always
// used for it. The Initiatives tab's cards asked for the same gesture, and two copies of a chooser is two answers
// to "what does a re-roll do": the rule (a random hue, at least 45 degrees from the one it replaces, wrapped into
// the circle) and the storage fallback (a write the browser refuses leaves the colour on this tab only) are
// written once there, and each surface keeps only its own KEY and its own MAP.
function loadProjectHues() {
  return wtThemeHue.load(PROJECT_HUE_KEY);
}

function saveProjectHues() {
  wtThemeHue.save(PROJECT_HUE_KEY, state.projectHues);
}

// A random hue that is not the one already there: re-rolling must change what you see.
function rollProjectHue(name) {
  return wtThemeHue.roll(state.projectHues, PROJECT_HUE_KEY, name);
}

// The settings row says how many projects carry a colour right now, so "reset" is never a blind button.
function updateColorsRow() {
  const row = document.getElementById("colors-row");
  if (!row) return;
  const n = state.projectHues.size;
  row.title = n
    ? `${n} project${n === 1 ? "" : "s"} carr${n === 1 ? "ies" : "y"} a theme colour (Ctrl+click a project's title row to set one, Ctrl+Shift+click to drop it). Reset clears them all — this browser only.`
    : "No project has a theme colour. Ctrl+click a project's title row to give it one; reset clears every colour at once.";
}

// ANCHOR_THREAD_KEY is declared near the top of the file: loadAnchorThread() runs while `state` is built.

// Two independent signals, each with its own switch and its own window: the pointer (hover) and the hand
// (clicked / focused / typed). `legacyKey` is read once so a preference saved under the older single setting is
// not silently lost when the two were split apart.
function loadAnchorFlag(key, fallback, legacyKey = null) {
  try {
    const v = localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function saveAnchorFlag(key, on) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* no storage: this tab only */
  }
}

function loadAnchorSeconds(key, fallback, min = 1, legacyKey = null, max = 600) {
  try {
    const raw = localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
    const n = Number(raw);
    return Number.isFinite(n) && raw !== null && n >= min && n <= max ? Math.round(n) : fallback;
  } catch {
    return fallback;
  }
}

// The row-ranking window. Saved in this browser like the other Display numbers, and read while `state` is built.
function loadRankSeconds() {
  return loadAnchorSeconds(RANK_WINDOW_KEY, RANK_WINDOW_DEFAULT, RANK_WINDOW_MIN, null, RANK_WINDOW_MAX);
}

function saveAnchorSeconds(key, seconds) {
  try {
    localStorage.setItem(key, String(seconds));
  } catch {
    /* no storage: this tab only */
  }
}

function loadAnchorThread() {
  try {
    return localStorage.getItem(ANCHOR_THREAD_KEY) || null;
  } catch {
    return null;
  }
}

function saveAnchorThread(thread) {
  try {
    if (thread) localStorage.setItem(ANCHOR_THREAD_KEY, thread);
    else localStorage.removeItem(ANCHOR_THREAD_KEY);
  } catch {
    /* no storage: the pin lasts this tab only */
  }
}

function setAnchorThread(thread) {
  state.anchorThread = thread ? String(thread) : null;
  saveAnchorThread(state.anchorThread);
  for (const b of document.querySelectorAll("[data-pin-thread]")) {
    const on = b.dataset.pinThread === state.anchorThread;
    b.classList.toggle("is-on", on);
    b.title = on
      ? "this card holds its place while anything above it grows — click to release"
      : "pin this card: hold its place on screen while other cards above it grow (one pin at a time)";
  }
  refreshAnchorBaseline();
}

function toggleAnchorPin(thread) {
  setAnchorThread(state.anchorThread === thread ? null : thread);
}

function readingTop() {
  const bar = document.querySelector(".topbar");
  return bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
}

// The element the reading line sits on: a card straddling it first, then the first one below it.
function nearestReadingLine(nodes, top) {
  let best = null;
  let bestScore = Infinity;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.height < 8) continue;
    if (r.bottom < top - 40 || r.top > window.innerHeight) continue;
    const score = r.top <= top && r.bottom > top ? top - r.top : 400 + Math.abs(r.top - top);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

// A card only counts as the reader's intent while it is actually on screen: an anchor that has scrolled away
// cannot hold anything, and following it would drag the page back.
function anchorVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.height > 8 && r.bottom > readingTop() && r.top < window.innerHeight;
}

function anchorCardFor(thread) {
  if (!thread) return null;
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  return anchorVisible(card) ? card : null;
}

// Where the reader's attention is, beyond the geometry of the reading line:
//   * the card under the pointer, while the pointer is actually moving over it (a mouse parked on a card from
//     two minutes ago says nothing about what is being read now),
//   * the card last interacted with - clicked, focused, typed in - for a couple of minutes, which is the
//     "last panel I touched is where I am thinking" case.
function loadFlashSeconds() {
  try {
    const raw = localStorage.getItem(FLASH_TIME_KEY);
    const n = Number(raw);
    return raw !== null && Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n * 10) / 10 : FLASH_TIME_DEFAULT;
  } catch {
    return FLASH_TIME_DEFAULT;
  }
}

function saveFlashSeconds(seconds) {
  try {
    localStorage.setItem(FLASH_TIME_KEY, String(seconds));
  } catch {
    /* no storage: this tab only */
  }
}

// The three durations the flashes use, all scaled from the one setting (0.9s row : 1.1s project : 1.7s ring).
const FLASH_BASE_SECONDS = 0.9;
function flashScale() {
  return Math.max(0, state.flashSeconds) / FLASH_BASE_SECONDS;
}
function flashRowMs() {
  return Math.round(900 * flashScale());
}
function flashProjectMs() {
  return Math.round(1100 * flashScale());
}
function flashRingMs() {
  return Math.round(1700 * flashScale());
}

function anchorHoverMs() {
  return state.anchorHoverSeconds * 1000;
}

function anchorTouchMs() {
  return state.anchorTouchSeconds * 1000;
}

// The element a target names, looked up fresh every time. A rebuild replaces the project header, the row and
// the worktree's tbody, so holding "that thing" has to be a lookup, not a stored node: the node the click landed
// on is gone by the time the observer measures the layout.
function anchorNodeFor(target) {
  if (!target) return null;
  // A plain element was claimed by the click itself (a button, a chip, a line of text). There is no stable name to
  // look it up by, so the node is the anchor: valid while it stays in the document, dropped when a rebuild
  // replaces it.
  if (target.kind === "el") return target.el && target.el.isConnected ? target.el : null;
  if (!target.id) return null;
  if (target.kind === "card") return document.querySelector(`.job[data-thread="${CSS.escape(target.id)}"]`);
  // A project is held by its section, not just the head: the section is what grows, and its top is the bar.
  if (target.kind === "project") return document.querySelector(`section.project[data-project="${CSS.escape(target.id)}"]`);
  if (target.kind === "fixed") return document.getElementById(target.id);
  if (target.kind === "turn") return document.querySelector(`[data-turn-head="${CSS.escape(target.id)}"]`);
  if (target.kind === "row") return document.querySelector(`#projects tr.row[data-key="${CSS.escape(target.id)}"]`);
  if (target.kind === "root") return document.querySelector(`.root-head[data-toggle-root="${CSS.escape(target.id)}"]`);
  return null;
}

// Which board element an event landed on. A card beats the row and the project containing it: the agent is the
// specific thing, the accordions around it are scenery unless their own header was hit.
function boardTargetOf(el) {
  if (!el || !el.closest) return null;
  const card = el.closest(".job[data-thread]");
  if (card) return { kind: "card", id: card.dataset.thread };
  const phead = el.closest(".project-head[data-toggle-project]");
  if (phead) return { kind: "project", id: phead.dataset.toggleProject };
  const fhead = el.closest("[data-toggle-fixed]");
  if (fhead) return { kind: "fixed", id: fhead.dataset.toggleFixed };
  const turn = el.closest("[data-turn-head]");
  if (turn) return { kind: "turn", id: turn.dataset.turnHead };
  const row = el.closest("#projects tr.row[data-key]");
  if (row) return { kind: "row", id: row.dataset.key };
  const rhead = el.closest(".root-head[data-toggle-root]");
  if (rhead) return { kind: "root", id: rhead.dataset.toggleRoot };
  // Anything else the click landed on: a button, a chip, a badge, a paragraph. The element itself is the anchor.
  // The page background and the scroll containers are not - there is nothing there to hold, and claiming them
  // would fight the reader's own scroll.
  if (el === document.body || el === document.documentElement || el === document.scrollingElement) return null;
  if (el.closest("#settings, .settings")) return { kind: "el", el };
  if (el.closest("main") && el.tagName !== "MAIN" && el.tagName !== "BODY") return { kind: "el", el };
  if (el.closest(".topbar")) return { kind: "el", el };
  return null;
}

function sameAnchorTarget(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "el") return a.el === b.el;
  return a.id === b.id;
}

// A project was claimed by its bar, so its bar is what has to still be on screen: the section it belongs to can be
// taller than the window, and once the bar has scrolled away the reader is somewhere else inside the project -
// the card at the reading line is then the better anchor.
function projectBarVisible(section) {
  const bar = section?.querySelector?.(".project-head[data-toggle-project], .project-head[data-toggle-fixed]");
  return bar ? anchorVisible(bar) : false;
}

function intentAnchorNode() {
  const now = Date.now();
  if (state.anchorHover && state.hoverThread && now - state.hoverAt < anchorHoverMs()) {
    const hovered = anchorCardFor(state.hoverThread);
    if (hovered) return { el: hovered, target: { kind: "card", id: state.hoverThread } };
  }
  if (state.anchorTouch && state.touchTarget && now - state.touchAt < anchorTouchMs()) {
    const el = anchorNodeFor(state.touchTarget);
    const kind = state.touchTarget.kind;
    // A whole project or a whole fixed card is held by its bar: once that bar has scrolled away the reader is
    // somewhere else in it, and the card at the reading line is the better answer. A plain element is only an
    // answer while it is still on screen.
    const head = kind === "project" || kind === "fixed" ? projectBarVisible(el) : true;
    if (anchorVisible(el) && head) return { el, target: state.touchTarget };
  }
  return null;
}

// pinned card > card under the pointer / last touched thing > card at the reading line > open row at it >
// project section at it > nothing. Every answer carries a target descriptor so it can be re-found after a
// rebuild.
function readingAnchor() {
  if (state.anchorThread) {
    const pinned = document.querySelector(`.job[data-thread="${CSS.escape(state.anchorThread)}"]`);
    if (pinned) return { el: pinned, pinned: true, target: { kind: "card", id: state.anchorThread } };
  }
  const intent = intentAnchorNode();
  if (intent) return { el: intent.el, pinned: false, intent: true, target: intent.target };
  const top = readingTop();
  const card = nearestReadingLine(document.querySelectorAll(".job[data-thread]"), top);
  if (card) return { el: card, pinned: false, target: { kind: "card", id: card.dataset.thread } };
  const row = nearestReadingLine(document.querySelectorAll("#projects tr.row.expanded"), top);
  if (row) return { el: row, pinned: false, target: { kind: "row", id: row.dataset.key } };
  const sec = nearestReadingLine(document.querySelectorAll("#projects section.project"), top);
  return sec ? { el: sec, pinned: false, target: { kind: "project", id: sec.dataset.project } } : null;
}

let anchorState = null;       // { el, target, top, height, pinned }
let anchorScrollY = 0;        // page scrollY at the moment the baseline was measured
let lastAnchorScrollAt = 0;   // our own scrollBy, so it is not read as the reader moving
let anchorRepickTimer = 0;
// Set while a click's own hand-keeps-the-bar-still pass (keepInPlace) is running. Both it and the observer
// answer the same layout change, and two answers measured a frame apart scroll the page one way and then the
// other: the page visibly twitches and the clicked bar can end up anywhere. One owner at a time.
let anchorMuteUntil = 0;

function refreshAnchorBaseline() {
  const a = readingAnchor();
  if (!a) {
    anchorState = null;
    return;
  }
  const r = a.el.getBoundingClientRect();
  anchorState = { el: a.el, target: a.target || null, top: Math.round(r.top), height: Math.round(r.height), pinned: a.pinned };
  anchorScrollY = Math.round(window.scrollY);
}

// The correction lands in the frame the growth did. A ResizeObserver's callback runs after layout and BEFORE that
// frame is painted, so compensating here means the reader's element is never drawn displaced; deferring the same
// correction to requestAnimationFrame painted exactly one frame with the anchor moved and then put it back, which
// reads as a twitch. Measured on a parked card with three turns streaming above it: its top jumped 17-52 px for a
// single frame 37 times in 45 s and came straight back, while the page scrolled 26 times to undo it. `anchorBusy`
// keeps compensateAnchor out of itself (a scroll it performs must not start a second correction).
let anchorBusy = false;

function scheduleAnchorCompensation() {
  if (anchorBusy) return;
  anchorBusy = true;
  try {
    compensateAnchor();
  } finally {
    anchorBusy = false;
  }
}

function compensateAnchor() {
  // A spawn/jump follow owns the scroll until it is done: compensating against the position the reader
  // held before the jump would drag them straight back off the card the panel just landed on.
  if (state.pendingFocus) {
    refreshAnchorBaseline();
    return;
  }
  if (!anchorState) return;
  if (Date.now() < anchorMuteUntil) return;
  // A live corner gesture outranks the anchor. The reader is changing a console's height ON PURPOSE, and every pixel of
  // it moves everything below the box: compensating for that scrolls the page by the same amount under the gesture, so
  // the corner walks away from the pointer it is being dragged with. Measured before this guard: ten 20px moves up
  // scrolled the page 200px and left the grip 200px below the cursor. Asked through the body class, which is the one
  // thing both files share (public/app.js sets it, this reads it) and which costs nothing outside a drag.
  if (document.body.classList.contains("is-out-gripping")) {
    refreshAnchorBaseline();
    return;
  }
  if (!anchorState.el.isConnected) {
    // The node was replaced (a snapshot rebuilt this project). Find the same thing again and keep the baseline
    // measured before the change: re-picking here would compare the new layout with itself and let the page
    // move under the reader.
    const again = anchorNodeFor(anchorState.target);
    if (again) anchorState.el = again;
    else {
      refreshAnchorBaseline();
      return;
    }
  }
  const r = anchorState.el.getBoundingClientRect();
  const delta = Math.round(r.top) - anchorState.top;
  // A correction bigger than most of the screen is not growth - it is a baseline measured before the reader
  // moved (or before the board was as tall as it is). Re-measure and leave the page alone: a stale baseline
  // once threw this page 14,000px on a single keystroke.
  if (Math.abs(delta) > window.innerHeight * 0.75) {
    refreshAnchorBaseline();
    return;
  }
  const grewSelf = Math.abs(r.height - anchorState.height) > 1;
  // Something above the anchor changed the layout: put the anchor back where the reader had it. Growth
  // inside the anchor itself is the reader watching it expand - never compensated.
  if (!grewSelf && Math.abs(delta) > 1 && window.scrollY > 0) {
    lastAnchorScrollAt = Date.now();
    programmaticScroll();
    window.scrollBy(0, delta);
  }
  const after = anchorState.el.getBoundingClientRect();
  anchorState.top = Math.round(after.top);
  anchorState.height = Math.round(after.height);
}

let anchorObserver = null;

// Pointer + interaction tracking for the anchor. pointermove's own target is the element under the cursor, so
// this costs one closest() per move and nothing when the cursor stays still.
function trackAnchorIntent() {
  const noteHover = (target) => {
    const thread = target && target.kind === "card" ? target.id : null;
    if (thread === state.hoverThread) return;
    state.hoverThread = thread;
    state.hoverAt = thread ? Date.now() : 0;
    refreshAnchorBaseline();
  };
  const noteTouch = (target) => {
    // A click claims what it landed on, at once: the baseline is measured here, before the click handler grows
    // anything, so the observer holds THIS element rather than whatever happened to sit at the reading line. A
    // click on nothing (the page background) clears the claim and leaves the geometry in charge.
    state.touchTarget = target;
    state.touchAt = target ? Date.now() : 0;
    refreshAnchorBaseline();
  };
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return; // a touch is an interaction, not a hover
      // A moving pointer only claims cards: it crosses project headers and rows on its way somewhere else.
      noteHover(boardTargetOf(e.target));
    },
    { passive: true },
  );
  const touched = (e) => noteTouch(boardTargetOf(e.target));
  document.addEventListener("pointerdown", touched, { passive: true, capture: true });
  document.addEventListener("focusin", touched, { passive: true, capture: true });
  document.addEventListener("keydown", touched, { passive: true, capture: true });
  document.addEventListener("input", touched, { passive: true, capture: true });
}

function startAnchorObserver() {
  if (anchorObserver || typeof ResizeObserver !== "function") return;
  anchorObserver = new ResizeObserver(() => scheduleAnchorCompensation());
  // `main` is the whole scrollable board: the project list, the agent list, the two fixed cards above them and the
  // approvals dock. Native scroll anchoring is switched off (see style.css), so this observer is the only thing
  // that puts the reader's element back - it has to see every container that can grow, not just the two lists.
  const watched = ["main", "projects", "jobs", "newagent", "agents", "approvals"];
  for (const id of watched) {
    const el = document.getElementById(id);
    if (el) anchorObserver.observe(el);
  }
  // Every page scroll moves the anchor's viewport position, and the baseline has to move with it or the next
  // resize reads the reader's own scrolling as growth. Our own compensation is excepted: it measures the
  // element again after scrolling. A quiet moment then re-picks which element the reading line sits on.
  document.addEventListener(
    "scroll",
    (e) => {
      const target = e.target;
      const page = !target || target === document || target === document.scrollingElement || target === window;
      if (!page) return;
      const y = Math.round(window.scrollY);
      if (anchorState && Date.now() - lastAnchorScrollAt > 120) anchorState.top += anchorScrollY - y;
      anchorScrollY = y;
      if (Date.now() - lastAnchorScrollAt < 250) return;
      clearTimeout(anchorRepickTimer);
      anchorRepickTimer = setTimeout(refreshAnchorBaseline, 160);
    },
    { passive: true },
  );
  window.addEventListener("resize", () => {
    // A resize reflows the whole board, so every element's viewport position changes at once. Correcting against
    // a baseline measured at the old width would scroll the page to chase a number that no longer means anything:
    // stand down, then re-measure.
    anchorMuteUntil = Date.now() + 250;
    clearTimeout(anchorRepickTimer);
    anchorRepickTimer = setTimeout(refreshAnchorBaseline, 160);
  });
  trackAnchorIntent();
  refreshAnchorBaseline();
}

// ---- board hygiene ----------------------------------------------------------------------------
// A card and the detail block it sits in can outlive the row they belong to. When a row's key changes
// under it - a nested worktree adopted by its own project, a path re-cased by discovery - the old
// tr/detail pair stays in the parent project's tbody, card and all, while the same conversation is
// also rendered in the row that now owns it. A snapshot rebuilds one project at a time, so that pair
// can sit there for a minute and then vanish: the board jumps and the same agent appears twice.
// Every render ends with this sweep, which is the board's own invariant: one row per live key, one
// detail per row, one card per thread - the copy in the owning row wins, the homeless panel is next.
let boardSweepQueued = false;
// The row the reader is looking at, when a rebuild starts. Restored afterwards: a card appearing, a
// duplicate being swept or a re-rank can all change the height above the viewport, and the board used
// to jump out from under the reader when that happened.
let boardAnchor = null;

function captureBoardAnchor() {
  if (window.scrollY <= 0) return null; // at the top of the page: nothing to hold
  const top = readingTop();
  // The same chain the anchor uses - pinned, then the card under the pointer or the thing last clicked, then the
  // card at the reading line, then the row - so a rebuild holds whatever the reader is thinking about, not just
  // what happens to sit under the topbar. Held by target: that survives a rebuild AND a reorder.
  const a = readingAnchor();
  if (a && a.target && a.el.isConnected) {
    const rows = a.target.kind === "row" ? [...document.querySelectorAll("#projects tr.row[data-key]")] : null;
    return {
      target: a.target,
      index: rows ? rows.indexOf(a.el) : -1,
      offset: Math.round(a.el.getBoundingClientRect().top - top),
      y: Math.round(window.scrollY),
    };
  }
  // Rows are only a stand-in for "somewhere in this worktree". Their index is recorded because rows are
  // sorted newest-life-first: a row that gains life is promoted, and following it is exactly the bounce this
  // anchor used to cause - the page chased a promoted worktree up to the top of the board.
  const rows = [...document.querySelectorAll("#projects tr.row[data-key]")];
  const row = rows.find((tr) => tr.getBoundingClientRect().bottom > top + 1);
  if (!row) return null;
  return { target: { kind: "row", id: row.dataset.key }, index: rows.indexOf(row), offset: Math.round(row.getBoundingClientRect().top - top), y: Math.round(window.scrollY) };
}

// Put the held element back where the reader had it, and keep putting it back for the next few frames: a single
// correction measured too early - before the promoted row's detail had been re-placed, before a card had been
// rebuilt - left the reader half-way to wherever the render was going to put them (observed: a card asked to stay
// at 40px ended at -498px). Four frames is enough for the layout to settle and short enough to be invisible.
function holdAnchor(anchor, attempt = 0) {
  if (!anchor) return;
  // The reader scrolled between the capture and this hold: the page is theirs now.
  if (attempt === 0 && anchor.y != null && Math.abs(Math.round(window.scrollY) - anchor.y) > 6) return;
  const top = readingTop();
  let el = anchorNodeFor(anchor.target);
  // Reordered, not resized: leave the page alone. The green flash already says something moved; dragging the
  // reader to wherever the sort sent the row is not a way to tell them.
  if (el && anchor.target.kind === "row" && anchor.index >= 0) {
    const rows = [...document.querySelectorAll("#projects tr.row[data-key]")];
    if (rows.indexOf(el) !== anchor.index) el = null;
  }
  if (!el) return;
  const delta = Math.round(el.getBoundingClientRect().top - top) - anchor.offset;
  if (Math.abs(delta) > 2) {
    anchorMuteUntil = Date.now() + 220; // this hold owns the correction; the observer answers it too otherwise
    programmaticScroll();
    window.scrollBy(0, delta);
    refreshAnchorBaseline();
  }
  if (attempt < 4 && Math.abs(delta) > 2) requestAnimationFrame(() => holdAnchor(anchor, attempt + 1));
}

function scheduleBoardSweep(anchor = null) {
  if (anchor) boardAnchor = anchor;
  if (boardSweepQueued) return;
  boardSweepQueued = true;
  requestAnimationFrame(() => {
    boardSweepQueued = false;
    sweepStaleBoard();
    const held = boardAnchor;
    boardAnchor = null;
    holdAnchor(held);
  });
}

function sweepStaleBoard() {
  // This pass moves details back under their rows, which takes the cards out of the DOM and puts them back.
  const heldSelection = captureCardSelection();
  // A worktree that gains life is re-ranked, and its detail then follows the row - a move, which detaches the cards
  // and blurs whatever the reader was typing in. That was the cursor going missing on a green flash: the flash itself
  // touches no input, but the re-rank under it moved the box. Read the caret before any of it and put it back after.
  const typing = $("projects") ? captureTyping($("projects")) : null;
  // A detail that changes place under its row takes every console inside it out of the layout tree, which puts them
  // all back at their first line. Read the boxes before the FIRST move of this pass (a read after it would read the
  // 0 it left) and hand them back before the pass ends.
  let heldScrolls = null;
  beginDomMove();
  // A detail whose row is gone, or which no longer follows its own row.
  for (const d of placedNodes("tr.detail").filter((el) => el.hasAttribute("data-detail"))) {
    const key = d.dataset.detail;
    const ownRow = state.rowEls.get(key) || null;
    if (!state.rows.has(key)) {
      d.remove();
      if (state.detailEls.get(key) === d) state.detailEls.delete(key);
      continue;
    }
    // One row, one detail. The registered element wins; any other copy for the same key is a stray from a
    // render whose cache entry had gone stale, and two details under one row is exactly the duplicated
    // MERGE STATE / LIVENESS block the reader saw.
    const registered = state.detailEls.get(key);
    if (registered && registered !== d && registered.isConnected) {
      d.remove();
      continue;
    }
    if (!registered) state.detailEls.set(key, d);
    // The row is still there and the detail still belongs to it - the row just moved (rows sort by newest
    // life, so a worktree that gains life is re-ordered). Moving the detail with its row keeps the open
    // cards on the page; removing it instead dropped the agent card the reader was reading out of the DOM
    // until some later render rebuilt it.
    if (ownRow && d.previousElementSibling !== ownRow) {
      heldScrolls = heldScrolls || holdScrolls($("projects"));
      ownRow.after(d);
    }
  }
  // A row the server no longer lists.
  for (const tr of [...document.querySelectorAll("tr.row[data-key]")]) {
    if (!state.rows.has(tr.dataset.key)) tr.remove();
  }
  // One card per thread.
  const byThread = new Map();
  for (const card of document.querySelectorAll(".job[data-thread]")) {
    const t = card.dataset.thread;
    const list = byThread.get(t) || [];
    list.push(card);
    byThread.set(t, list);
  }
  for (const [thread, cards] of byThread) {
    if (cards.length < 2) continue;
    const conv = conversations().find((c) => c.thread === thread);
    const owner = normPath(conv?.latest?.ownerPath || conv?.first?.ownerPath || "").toLowerCase();
    const rank = (card) => {
      // The floating assistant panel is the assistant thread's only home: it outranks every board copy.
      if (card.closest("[data-subpane=\"chat\"]")) return 5;
      const body = card.closest("tr.detail");
      const key = body?.previousElementSibling?.dataset?.key || "";
      const path = String(key).split("::").slice(1).join("::");
      if (owner && normPath(path).toLowerCase() === owner) return 3;
      if (card.closest("#jobs")) return 1;
      return 2;
    };
    const keep = [...cards].sort((a, b) => rank(b) - rank(a))[0];
    for (const card of cards) {
      if (card === keep) continue;
      const where = card.closest("#jobs")
        ? "the Agents panel"
        : card.closest("tr.detail")?.previousElementSibling?.dataset?.key || "a row";
      console.warn(`panel: dropped a duplicate card for ${thread} (kept the copy in ${keep.closest("#jobs") ? "the Agents panel" : keep.closest("tr.detail")?.previousElementSibling?.dataset?.key || "a row"}, removed ${where})`);
      card.remove();
    }
  }
  endDomMove();
  if (heldScrolls) releaseScrolls(heldScrolls);
  if (typing) restoreTyping($("projects"), typing);
  restoreAddAgent($("projects"));
  restoreCardSelection(heldSelection);
}
