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

// ---- the three cuts, and the re-export ------------------------------------------------------------
// Row 530 cuts this file into three modules, one commit per cut, and this file keeps the header and
// the record of the surface. Cut 1 has landed: the project ordering, a folder's card, the legend and
// the project section are declared in public/board/project-order.js. Cut 2 has landed: the turnover
// containers, the children under their parent, the row itself, its kind column and its reviewed chip
// are declared in public/board/project-row.js. public/index.html loads both before this file, and
// every name moved there is a top-level declaration in a classic script, so it is the same page
// global it was before the move; nothing here declares it twice.

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
  // THE ORDER HOLD. While the board is drawing a cached tree list and the scan that replaces it, no row of any project
  // re-ranks: the cached rows were painted in their last-read order and the fresh rows replace them one for one, so a
  // re-rank under the reader would be the same jump the cache exists to remove. Grouping still updates (a child that
  // arrived belongs under its parent), and the hold expires on its own (see applyTreeList in public/app.js), so the
  // board ranks normally again once the scan has settled.
  if (typeof rowOrderHold === "function" && rowOrderHold()) {
    syncChildGroups(name);
    return;
  }
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
  // A real row standing on a branch the chart was drawing as a container placeholder replaces it: the branch is no
  // longer a row of its own, it is this worktree. Done before the row is painted so the two never both exist.
  if (typeof dropTurnoverPlaceholder === "function") dropTurnoverPlaceholder(project, row.branch);
  const prevRow = state.rows.get(key) || null;
  // A row seeded from the cached tree list (lib/tree-cache.js) being replaced by its own fresh read is not NEWS: it is
  // the same row, read at last. No green flash and no rank move - the cached row was painted in the slot its own read
  // hands back, and the reader watched the list arrive instead of watching it jump.
  const cachedToRead = Boolean(prevRow?.cached) && !row.cached;
  if (cachedToRead) flash = false;
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
  if (moved && !cachedToRead) state.movedRows.add(key);
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
  if (tableHidesRow(row)) {
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
  // waits for the release, which asks for one full repaint (public/core/console-grip.js end).
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
  // THE REVIEW FILTER replaces the order outright: every awaiting row of this project, oldest first, whether or not
  // the chart was holding it back or focus mode hid it. That is what "filters the table to exactly those rows" has to
  // mean - a counted row the reader cannot see would be a count that lied.
  const laneOrder = reviewModeOn()
    ? [...state.rows.values()]
        .filter((r) => r.project === name && typeof wtReviewLane !== "undefined" && wtReviewLane && wtReviewLane.awaiting(r))
        .sort((a, b) => wtReviewLane.since(a) - wtReviewLane.since(b))
    : null;
  let rowsInOrder = laneOrder || chartDrawOrder(name).filter((r) => !focusHidesRow(r));
  // The order is held by the tree list's own hold (public/app.js's rowOrderHold: a cached first paint and the scan that
  // replaces it) exactly as it is held by an open row: the keys on screen are the keys that were painted, and the same
  // rows come back in the same slots.
  const heldOrder = (typeof rowOrderHold === "function" && rowOrderHold()) || (stabilizeOn() && projectHasOpenRow(name));
  if (heldOrder && prevRowKeys.length) {
    // THE SET, not only the sequence. The rank decides which rows are drawn at all (the chart's top N), and a cached row
    // has no verdict to rank with, so taking the set from the rank is what made a fully read board draw a different ten
    // rows than the cached paint had. While the hold is on, the painted keys ARE the drawn set, in their painted slots;
    // a row that is genuinely new goes last, and a row that has left the board is simply not in the map.
    const byKey = new Map(rowsInOrder.map((r) => [keyOf(name, r.path), r]));
    const painted = prevRowKeys.map((k) => byKey.get(k)).filter(Boolean);
    const paintedKeys = new Set(prevRowKeys);
    const arrivals = rowsInOrder.filter((r) => !paintedKeys.has(keyOf(name, r.path)));
    rowsInOrder = [...painted, ...arrivals];
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
  // …and the same for the two chips' open cards: this path replaced every row of the project, so a card the reader
  // left open is re-anchored onto its row's new chip, and only its body is repainted when the record moved.
  if (typeof paintRowChipPops === "function") paintRowChipPops(name);
  // The section follows its rows: kept while one of them is, hidden otherwise (a no-op while the mode is off).
  paintFocusSection(name);
}
