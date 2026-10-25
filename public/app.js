  const delKey = key;
  const delDirect = !isProjectRoot && deletableWithoutAsking(delKey);
  // The grip on the left is a drag handle, not a toggle: it is a <button> so the row's own
  // click-to-expand handler (which already skips "button, a, input, select, textarea, label") leaves
  // it alone, and dragging it reorders this row within its project — see the dragstart/dragover/drop
  // wiring near the end of the file, and applyManualOrder() for how the drop is remembered.
  const dragHandle = `<button type="button" class="drag-handle" draggable="true" data-drag-key="${esc(key)}" data-drag-project="${esc(row.project)}" title="drag to move this worktree up or down in the list">⠿</button>`;
  return `<tr class="row${isOpen ? " expanded" : ""}" data-key="${esc(key)}">
    <td class="name"><div class="name-line">${dragHandle}<button class="btn-row-agent" data-agent-path="${esc(row.path)}" data-agent-name="${esc(row.name)}" data-agent-project="${esc(row.project)}"
      title="probe every NOT-RUNNING agent in this worktree — sends 'Continue if you can, exit if you are done' to each of them (the + under the agents starts a new one)">▶</button><span class="row-name" title="${esc(row.path)}">${esc(shownName)}</span>${renameBtn}${nameFromWorkBtn}${agentBadgeHtml(row)}</div></td>`;
    <td class="mono branch">${esc(row.branch || "—")}</td>
    <td class="mono dim nowrap">${esc(row.head || "—")}</td>
    <td class="mono nowrap">${row.ahead === null ? "—" : `<span class="${row.ahead ? "dirty" : "dimmer"}">${row.ahead}</span> / ${row.behind ?? "—"}`}</td>
    <td class="mono dim nowrap">+${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}</td>
    <td>${pr}</td>
    <td class="mono nowrap">${dirty}</td>
    ${ageCellHtml(row)}
    <td class="verdict">${badge}</td>
    <td class="row-actions">${isProjectRoot ? "" : `<button class="btn-del-tree${delDirect ? " is-direct" : ""}" data-del-tree="${esc(delKey)}" title="${delDirect ? "this worktree is merged and clean — deletes it straight away, its files go to the Recycle Bin and git's record is pruned" : "remove this worktree — asks first; its files go to the Recycle Bin and git's record of it is pruned"}">✕</button>`}</td>
  </tr>`;
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

function ageCellHtml(row) {
  const alive = lifeAtFor(row) || NaN;
  const label = Number.isFinite(alive) ? fmtDur(Date.now() - alive) : "never live";
  const st = ringState(row);
  return `<td class="age nowrap" data-key="${esc(keyOf(row.project, row.path))}">
      <span class="age-line"><span class="age-num${Number.isFinite(alive) ? "" : " dimmer"}">${esc(label)}</span><button class="poll-btn" data-refresh-row="${esc(keyOf(row.project, row.path))}" type="button" title="read this worktree now"><svg class="poll-ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle class="poll-track" cx="8" cy="8" r="6" fill="none" stroke-width="2"></circle>
        <circle class="poll-arc" cx="8" cy="8" r="6" fill="none" stroke-width="2" transform="rotate(-90 8 8)" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${ringOffset(st)}" stroke="${ringStroke(st)}"></circle>
      </svg></button></span><span class="sigs">${sigChips(row)}</span></td>`;
}

function paintAgeCell(cell, row) {
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
  // A running panel agent IS life, observed by us, whatever the last scan said - and so is any event we have
  // received about this worktree since.
  const running = panelFor(row)?.running;
  const fromEvent = eventLifeAt(row);
  const alive = running ? st.now : lifeAtFor(row) || NaN;
  const live = Number.isFinite(alive);
  const num = cell.querySelector(".age-num");
  if (num) {
    num.textContent = live ? fmtDur(st.now - alive) : "never live";
    num.classList.toggle("dimmer", !live);
  }
  const cadence = st.every === st.configured ? `every ${st.every}s` : `every ${st.every}s, observed (configured ${st.configured}s)`;
  const why = running
    ? " (a panel agent is running here now)"
    : fromEvent && fromEvent >= (Date.parse(row.lastAliveAt || "") || 0)
      ? " (an event we received for this worktree)"
      : "";
  const title =
    `last life ${live ? `${fmtDur(st.now - alive)} ago${why}` : "never seen"} · polled ${relTime(row.scannedAt)} ago · ` +
    `next read ${st.remain > 0 ? `in ${Math.ceil(st.remain / 1000)}s` : `due now${st.overdue > st.total ? ` (overdue ${fmtDur(st.overdue)})` : ""}`} (${cadence})`;
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
  const tr = document.querySelector(`#projects tr.row[data-key="${CSS.escape(key)}"]`);
  if (!tr) return;
  tr.classList.remove("flash", "flash-idle");
  void tr.offsetWidth; // restart the animation rather than let one already running expire under the new class
  tr.classList.add("flash");
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

// An event about a worktree is a sign of life in its own right: the age number starts again, the ring (which counts
// toward the next read) restarts from now, and the row and its project take the green pulse - unless the reader has
// switched that pulse off. Returns true when the event belonged to a row, so a caller can tell the difference.
function noteEventLife(thread) {
  const key = rowKeyForThread(thread);
  if (!key) return false;
  const now = Date.now();
  if (now > (state.eventLife.get(key) || 0)) state.eventLife.set(key, now);
  const row = state.rows.get(key);
  const cell = document.querySelector(`td.age[data-key="${CSS.escape(key)}"]`);
  if (cell && row) paintAgeCell(cell, row);
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

function loadProjectHues() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECT_HUE_KEY) || "{}");
    const map = new Map();
    for (const [name, hue] of Object.entries(raw || {})) {
      const h = Number(hue);
      if (Number.isFinite(h)) map.set(name, ((h % 360) + 360) % 360);
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveProjectHues() {
  try {
    localStorage.setItem(PROJECT_HUE_KEY, JSON.stringify(Object.fromEntries(state.projectHues)));
  } catch {
    /* no storage: the colour lasts this tab only */
  }
}

// A random hue that is not the one already there: re-rolling must change what you see.
function rollProjectHue(name) {
  const prev = state.projectHues.get(name);
  let hue = Math.floor(Math.random() * 360);
  if (prev != null && Math.abs(hue - prev) < 45) hue = (hue + 150) % 360;
  state.projectHues.set(name, hue);
  saveProjectHues();
  return hue;
}

// Paint a project box in the hue it was given (or take the colour away). The section is rebuilt on every
// render, and projectSection() carries the class and the variable, so this only has to touch what is on
// screen right now.
function applyProjectHue(name) {
  const hue = state.projectHues.get(name);
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  if (sec) {
    sec.classList.toggle("has-hue", hue != null);
    if (hue != null) sec.style.setProperty("--proj-hue", String(hue));
    else sec.style.removeProperty("--proj-hue");
  }
  const head = sec?.querySelector(".project-head[data-toggle-project]");
  if (head) head.title = headTitle(name);
  updateColorsRow();
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

function headTitle(name) {
  const open = state.expandedProjects.has(name);
  return `${open ? "minimize" : "expand"} ${name} — Ctrl+click to colour this project, Ctrl+Shift+click to clear it`;
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

function loadAnchorSeconds(key, fallback, min = 1, legacyKey = null) {
  try {
    const raw = localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
    const n = Number(raw);
    return Number.isFinite(n) && raw !== null && n >= min && n <= 600 ? Math.round(n) : fallback;
  } catch {
    return fallback;
  }
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

// CSS owns the animation, so the durations are handed over as variables; the class-removal timeouts below
// use the same numbers, so a flash cannot keep a class after it has finished fading.
function applyFlashTime() {
  const root = document.documentElement;
  root.style.setProperty("--flash-row", `${flashRowMs()}ms`);
  root.style.setProperty("--flash-project", `${flashProjectMs()}ms`);
  root.style.setProperty("--flash-ring", `${flashRingMs()}ms`);
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
let anchorFrame = 0;
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

// One correction per frame. Called from the ResizeObserver on the two containers that can change height.
function scheduleAnchorCompensation() {
  if (anchorFrame) return;
  const flush = () => {
    anchorFrame = 0;
    compensateAnchor();
  };
  if (document.hidden) return flush();
  anchorFrame = requestAnimationFrame(flush);
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
  beginDomMove();
  // A detail whose row is gone, or which no longer follows its own row.
  for (const d of [...document.querySelectorAll("tr.detail[data-detail]")]) {
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
    if (ownRow && d.previousElementSibling !== ownRow) ownRow.after(d);
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
      if (card.closest("#as-chat")) return 5;
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
  if (typing) restoreTyping($("projects"), typing);
  restoreAddAgent($("projects"));
  restoreCardSelection(heldSelection);
}

function fillAgentSlots(root, reuse) {
  if (!root) return;
  for (const slot of [...root.querySelectorAll("[data-agent-slot]")]) {
    const thread = slot.dataset.agentSlot;
    const card = reuse?.get(thread);
    if (card) {
      slot.replaceWith(card);
      continue;
    }
    const conv = conversations().find((c) => c.thread === thread);
    if (!conv) {
      slot.remove();
      continue;
    }
    const holder = document.createElement("div");
    holder.innerHTML = conversationHtml(conv);
    const fresh = holder.firstElementChild;
    if (fresh) {
      fresh.dataset.sig = conversationSignature(conv);
      slot.replaceWith(fresh);
    } else slot.remove();
  }
}

function detailHtml(row) {
  const parts = [];
  const dirty = row.dirtyFiles || [];
  const untr = row.untrackedFiles || [];
  const commits = row.unmergedCommits || [];
  if (dirty.length) {
    parts.push(`<div class="col"><h4>Modified (${dirty.length})</h4><ul>${dirty.map((f) => `<li><span class="dimmer">${esc(f.code)}</span> ${esc(f.path)}</li>`).join("")}</ul></div>`);
  }
  if (untr.length) {
    parts.push(`<div class="col"><h4>Untracked (${untr.length})</h4><ul>${untr.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>`);
  }
  const pm = state.projects.get(row.project) || {};
  if (commits.length) {
    parts.push(
      `<div class="col"><h4>Commits not on ${esc(pm.remoteRef || "remote main")}${row.diffSummary ? ` · ${esc(row.diffSummary)}` : ""}</h4><ul>${commits
        .map((c) => `<li><span class="dimmer">${esc(c.sha)}</span> ${esc(c.subject)}</li>`)
        .join("")}</ul></div>`,
    );
  }
  // The git side of the row (state, commit list, dirty files, diff summary) folds into one line:
  // opening a worktree is about seeing its agents and what is unmerged, not a wall of file names.
  const key = keyOf(row.project, row.path);
  // Liveness evidence folds too; collapsed, its strongest line stays visible to the right of the
  // header, because "why is this row live" is the one thing worth seeing without unfolding.
  const liveLines = livenessLines(row);
  const liveOpen = state.liveOpen.has(key);
  const liveBlock = `<div class="live-block${liveOpen ? "" : " collapsed"}" data-live-block="${esc(key)}">
      <div class="live-head" data-toggle-live="${esc(key)}" title="${liveOpen ? "fold" : "unfold"} the liveness evidence">
        <span class="chev">${liveOpen ? "\u25be" : "\u25b8"}</span>
        <h4>Liveness evidence</h4>
        ${liveOpen ? "" : `<span class="live-first mono" title="${esc(liveLines[0] || "no evidence")}">${esc(liveLines[0] || "no evidence")}</span>`}
      </div>
      <ul>${liveLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    </div>`;
  const gitOpen = state.gitOpen.has(key);
  const gitSummary = [
    row.verdict || "…",
    row.branch ? `branch ${row.branch}` : null,
    dirty.length ? `${dirty.length} modified` : null,
    untr.length ? `${untr.length} untracked` : null,
    commits.length ? `${commits.length} not on ${pm.remoteRef || "remote main"}` : null,
    row.diffSummary || null,
    row.lastCommit ? `last commit ${relTime(row.lastCommit)} ago` : null,
  ].filter(Boolean).join(" · ");
  // Each of these was a fragment of one long "·"-joined line, so the reader had to hunt for "cherry" inside it.
  // They are list items now, and the head's summary joins them as the first item while the block is open.
  const metaItems = [
    row.isAncestor === true ? "ancestor of remote main" : row.isAncestor === false ? "not an ancestor" : null,
    `cherry +${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}`,
    row.reflogEntries ? `branch reflog: ${row.reflogEntries} distinct commit(s)` : null,
    row.everMoved === true
      ? `branch carried its own commits${row.mergedCount ? ` (${row.mergedCount} since ${esc(String(row.branchBase || "").slice(0, 7))})` : ""}`
      : row.everMoved === false
        ? "branch never moved — it has no commits of its own"
        : null,
    `remote branch: ${esc(row.remoteBranch || "?")}`,
    row.lastCommit ? `last commit ${relTime(row.lastCommit)} ago` : null,
    row.error ? `error: ${esc(row.error)}` : null,
  ].filter(Boolean);
  // orderedAgents: with "Stabilize reordering" on and an open card in this row, the cards keep the slots they have on
  // screen instead of sorting to newest-turn-first under the one the reader is reading.
  const agents = orderedAgents(row, agentsFor(row));
  // No heading: the row's own badge already says how many agents it owns and how many are running, and the
  // cards are the first thing under the row - a title above them only pushed them down.
  // A slot per card, not a copy of it: placeRow() moves the card that is already on the board into its slot.
  // Rebuilding the cards here destroyed their consoles on every scan - several times a second while a turn ran -
  // and every rebuild is a chance for a scroll position to be lost.
  // The add-agent bar is the full width of an agent card, half its height, a white + in the middle. Its position is a
  // setting (Settings > Display > Add-agent bar at top): above the cards when on, under them when off.
  // It is what the row's green ▶ used to do, because the ▶ now probes the agents the worktree already has. It stays
  // when the row has no agents at all - that is exactly when it is needed. Clicking it turns the bar into the text
  // field below (same footprint, so the row does not move), and Enter starts the run from there.
  const addKey = keyOf(row.project, row.path);
  const addOpen = state.addAgent && state.addAgent.key === addKey;
  const addBar = addAgentBarHtml({
    key: addKey,
    path: row.path,
    name: row.name,
    project: row.project,
    value: addOpen ? state.addAgent.value : null,
  });
  const agentsHtml = `<div class="agents-block">${agents.map((c) => `<div class="agent-slot" data-agent-slot="${esc(c.thread)}"></div>`).join("")}${addBar}</div>`;
  // Sessions the row says are here but that have no card: the conversation lives in the gateway, and
  // the panel's job store is what held the card. Reviving one puts a card back you can reply to —
  // offered one at a time, because a tree collects every session ever run in it.
  const known = knownThreads();
  const idleSessions = (row.signals?.hermes?.idleList || []).filter((s) => s && s.id && !known.has(s.id));
  const sessionsHtml = idleSessions.length
    ? `<div class="sessions-block">
        ${idleSessions
          .map(
            // Shaped like an agent card's head — glyph, chevron, then a pill-sized revive button in the
            // status column — so a session with no card reads as the same kind of thing, one level down.
            // The glyph is grey rather than the purple of a live agent: this session has no card.
            (s) => `<div class="session-row">
            <span class="agent-glyph" title="a Hermes session in this worktree with no card on the board">\u29c9</span>
            <span class="chev" title="no card on the board">\u25b8</span>
            <button type="button" class="btn-revive" data-revive-session="${esc(s.id)}" data-revive-path="${esc(row.path)}" title="put this session back on the board as a card — the conversation is in the gateway, so a reply continues it where it stopped">revive</button>
            <span class="session-when mono" title="${esc(s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : "last use unknown")}">${esc(fmtAgo(s.lastActivityAt))}</span>
            <span class="session-name mono dim">${esc(s.title || "(untitled session)")}</span>
            <span class="session-id mono" title="${esc(s.id)}">${esc(String(s.id).slice(0, 16))}…</span>
          </div>`,
          )
          .join("")}
      </div>`
    : "";
  // Merge state and liveness evidence lead the block again, but as two folded one-line strips: they are
  // reference material and were taking a block's worth of height above the agents when they sat open here.
  // Ten columns, not nine: the row-actions cell is the tenth, and a colspan of 9 left the card area short of the
  // table's right edge by that column, so the expanded agent section ended in a bare strip of panel on the right
  // while the left was flush. (The delete confirmation row below already spans 10.)
  return `<tr class="detail" data-detail="${esc(key)}"><td colspan="10"><div class="detail-inner">
    <div class="git-block${gitOpen ? "" : " collapsed"}" data-git-block="${esc(key)}">
      <div class="git-head" data-toggle-git="${esc(key)}" title="${gitOpen ? "fold" : "unfold"} the merge state, commit and diff detail">
        <span class="chev">${gitOpen ? "\u25be" : "\u25b8"}</span>
        <h4>Merge state</h4>
        <span class="git-summary mono">${esc(gitSummary)}</span>
      </div>
      <div class="git-body">
        <ul class="git-list">
          <li class="git-summary-line">${esc(gitSummary)}</li>
          ${metaItems.map((m) => `<li>${m}</li>`).join("")}
        </ul>
        ${parts.length ? `<div class="cols">${parts.join("")}</div>` : ""}
      </div>
    </div>
    ${liveBlock}
    ${agentsHtml}
    ${sessionsHtml}
  </div></td></tr>`;
}

function chipsHtml(name) {
  const rows = [...state.rows.values()].filter((r) => r.project === name);
  const merged = rows.filter((r) => String(r.verdict || "").startsWith("MERGED")).length;
  const noCommits = rows.filter((r) => {
    const v = String(r.verdict || "");
    return v.startsWith("NO COMMITS") || v.startsWith("EMPTY REPO");
  }).length;
  const unmerged = rows.filter((r) => {
    const v = String(r.verdict || "");
    return !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN";
  }).length;
  const dirty = rows.filter((r) => r.dirty || r.untracked).length;
  const serving = rows.filter((r) => r.signals?.ports?.on).length;
  const removable = rows.filter((r) => r.mergeable).length;
  // Every agent whose home is a row in this project. Violet while any of them is working; amber as
  // soon as they are all idle, because "a live panel" is only true when something is actually running.
  const panelAgents = rows.flatMap((r) => agentsFor(r));
  const panelAgentCount = panelAgents.length;
  const panelRunningCount = panelAgents.filter(convLive).length;
  const stale = rows.filter((r) => r.verdictStale).length;
  const out = [`<span class="chip">${rows.length} worktrees</span>`];
  if (merged) out.push(`<span class="chip good">${merged} merged</span>`);
  if (noCommits) out.push(`<span class="chip">${noCommits} no commits</span>`);
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  if (serving) out.push(`<span class="chip info">${serving} serving</span>`);
  // Violet in both states, like the ⧉ hermes chip: this is a Hermes-agent fact, not a warning. Amber
  // made every project with finished agents look like it wanted attention; the tooltip still says how
  // many are running right now.
  // How many agents are working RIGHT NOW, from every source: the panel's own cards and any Hermes
  // session (CLI or otherwise) whose turn is leased. The split is in the tooltip, so the chip stays the
  // answer to one question — "is anything running".
  // Hermes agents that are NOT this panel's, read the way the panel chip is: how many sessions the project
  // has, and how many of them are executing right now. Grey while they are all sitting there, violet as soon
  // as one is running, so the colour answers "is someone working" without parsing the numbers.
  const hermesRunning = rows.reduce((n, r) => n + (Number(r.signals?.hermes?.running) || 0), 0);
  const hermesIdle = rows.reduce((n, r) => n + (Number(r.signals?.hermes?.idle) || 0), 0);
  const hermesTotal = hermesRunning + hermesIdle;
  if (hermesTotal) {
    const busy = hermesRunning > 0;
    const head = busy
      ? `${hermesTotal} Hermes session${hermesTotal === 1 ? "" : "s"} from outside this panel in this project · ${hermesRunning} executing a turn right now`
      : `${hermesTotal} Hermes session${hermesTotal === 1 ? "" : "s"} from outside this panel in this project · none executing right now`;
    const titles = rows.flatMap((r) => [
      ...(r.signals?.hermes?.titles || []),
      ...((r.signals?.hermes?.idleList || []).map((s) => s.title).filter(Boolean)),
    ]);
    const tag = busy ? ` · ${hermesRunning} running` : "";
    out.push(
      `<span class="chip hermes${busy ? " on" : ""}" title="${esc(hermesTitle(head, titles))}">${hermesTotal} hermes${tag}</span>`,
    );
  }
  // Claude Code sessions, counted the same way as the Hermes ones above.
  const claudeRunning = rows.reduce((n, r) => n + (Number(r.signals?.claude?.running) || 0), 0);
  const claudeOpen = rows.reduce((n, r) => n + (r.signals?.claude?.on ? (r.signals.claude.titles || []).length : 0) + (Number(r.signals?.claude?.idle) || 0), 0);
  if (claudeOpen) {
    const busy = claudeRunning > 0;
    const head = `${claudeOpen} Claude Code session${claudeOpen === 1 ? "" : "s"} from outside this panel in this project · ${busy ? `${claudeRunning} executing a turn right now` : "none executing right now"}`;
    const titles = rows.flatMap((r) => r.signals?.claude?.titles || []).filter(Boolean);
    out.push(
      `<span class="chip claude${busy ? " on" : ""}" title="${esc(hermesTitle(head, titles))}">${claudeOpen} claude${busy ? ` · ${claudeRunning} running` : ""}</span>`,
    );
  }
  // The panel's own agents: how many cards, and how many of them are executing. The colour IS the state —
  // violet while something runs, grey while the panel is quiet — so a reader does not have to parse the
  // number to know whether anything is working.
  if (panelAgentCount) {
    const trees = rows.filter((r) => agentsFor(r).length).length;
    const busy = panelRunningCount > 0;
    const title = `${panelAgentCount} agent card${panelAgentCount === 1 ? "" : "s"} across ${trees} worktree${trees === 1 ? "" : "s"} in this project${busy ? ` · ${panelRunningCount} running right now` : " · none running"}`;
    const tag = busy ? ` · ${panelRunningCount} running` : "";
    const body = `⧉ ${panelAgentCount} panel${panelAgentCount === 1 ? "" : "s"}${tag}`;
    // Always a button: busy it jumps to the agent that is working, quiet it jumps to the top agent card.
    const cls = `chip${busy ? " agents" : ""} chip-jump`;
    const hint = busy ? "click to jump to the running agent" : "click to jump to the top agent";
    out.push(
      `<button type="button" class="${cls}" data-jump-panel="${esc(name)}" data-jump-running="${busy ? "1" : "0"}" title="${esc(title)} — ${hint}">${body}</button>`,
    );
  }
  // Amber and loud: an agent parked on a permission request is the one thing here that is waiting for
  // a human, and it must be visible with the project collapsed.
  const panelWaiting = panelAgents.filter((c) =>
    (c.turns || []).some((t) => approvalLive(t.approval) && !t.approvalDone && turnLive(t)),
  ).length;
  if (panelWaiting) {
    out.push(
      `<span class="chip sig-approval" title="an agent in this project is parked on a permission request — open the row to answer it">\u26a0 ${panelWaiting} awaiting approval</span>`,
    );
  }
  if (removable) out.push(`<span class="chip info">${removable} safe to remove</span>`);
  if (stale) out.push(`<span class="chip">${stale} reclassifying</span>`);
  return out.join("");
}

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

// "Touched" is deliberately wider than sort order: a commit, a file edit, or any life evidence
// observed in one of its worktrees. A month-old checkout that an agent is working in right now is
// touched; a merged tree nobody has opened since spring is not.
function projectTouchedAt(p) {
  let best = projectActivity(p);
  for (const r of state.rows.values()) {
    if (r.project !== p.name) continue;
    best = Math.max(best, Date.parse(r.lastAliveAt || "") || 0);
  }
  return best;
}

function shownInRoot(root, projects) {
  if (!state.recentRoots.has(root)) return projects;
  const cutoff = Date.now() - RECENT_DAYS * 864e5;
  return projects.filter((p) => projectTouchedAt(p) >= cutoff);
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
    if (!state.expandedProjects.has(n) || i >= els.length) return;
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
  const at = (p) => rank.get(p.name) || { tier: 2, activity: 0 };
  return [...state.projects.values()].sort((a, b) => {
    const ra = at(a);
    const rb = at(b);
    return ra.tier - rb.tier || rb.activity - ra.activity || String(a.name).localeCompare(String(b.name));
  });
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

function reorderProjects() {
  const host = $("projects");
  if (!host) return;
  // Moving a section or a folder moves the cards inside them, and that drops a selection standing in one.
  const heldSelection = captureCardSelection();
  // It also drops the caret: re-appending a project section or a folder takes every card and the inline add-agent
  // field inside it out of the page, and a detached field is blurred. Read both before the moves, put them back after.
  const typing = captureTyping(host);
  beginDomMove();
  const rank = projectRanks();
  const at = (n) => rank.get(n) || { tier: 2, activity: 0 };
  const cmp = (x, y) => {
    const a = at(x.dataset.project);
    const b = at(y.dataset.project);
    return a.tier - b.tier || b.activity - a.activity || String(x.dataset.project).localeCompare(String(y.dataset.project));
  };
  // An open project keeps its exact slot — opening one is you saying "this is the one I am reading",
  // so it must not slide out from under the cursor. Everything closed sorts into the gaps around it:
  // one open project is no reason to hold the rest of the folder still.
  const order = (els) => {
    const open = new Map();
    els.forEach((el, i) => {
      if (state.expandedProjects.has(el.dataset.project)) open.set(i, el);
    });
    const free = els.filter((el) => !state.expandedProjects.has(el.dataset.project)).sort(cmp);
    const out = [];
    let f = 0;
    els.forEach((_, i) => out.push(open.has(i) ? open.get(i) : free[f++]));
    return out;
  };
  for (const body of host.querySelectorAll(".root-body")) {
    const sections = [...body.querySelectorAll("section.project")];
    if (!sections.length) continue;
    const want = order(sections);
    if (want.every((el, i) => el === sections[i])) continue;
    for (const el of want) body.appendChild(el);
    flashMoved(sections, want, body);
  }
  // Then the folders themselves, on the same ranking: a folder holding the project an agent is busy
  // in leads, then the one worked in most recently.
  const groups = [...host.querySelectorAll("section.root-group")];
  const folderRank = (g) => {
    let tier = 2;
    let act = 0;
    for (const s of g.querySelectorAll("section.project")) {
      const r = at(s.dataset.project);
      tier = Math.min(tier, r.tier);
      act = Math.max(act, r.activity);
    }
    return { tier, act };
  };
  // A folder you are reading a project in holds its slot for the same reason the project does: the
  // folder sliding up takes the open section with it, which looks exactly like the section itself jumping.
  const holdsOpen = (g) => [...g.querySelectorAll("section.project")].some((s) => state.expandedProjects.has(s.dataset.project));
  const ranked = groups.slice().sort((a, b) => {
    const ra = folderRank(a);
    const rb = folderRank(b);
    return ra.tier - rb.tier || rb.act - ra.act || String(a.dataset.root || "").localeCompare(String(b.dataset.root || ""));
  });
  const pinnedGroups = new Map();
  groups.forEach((g, i) => { if (holdsOpen(g)) pinnedGroups.set(i, g); });
  const freeGroups = ranked.filter((g) => !pinnedGroups.has(groups.indexOf(g)));
  const wantGroups = [];
  let gf = 0;
  groups.forEach((_, i) => wantGroups.push(pinnedGroups.has(i) ? pinnedGroups.get(i) : freeGroups[gf++]));
  if (!wantGroups.every((g, i) => g === groups[i])) for (const g of wantGroups) host.appendChild(g);
  endDomMove();
  if (typing) restoreTyping(host, typing);
  restoreAddAgent(host);
  restoreCardSelection(heldSelection);
}

// One accordion per folder. The header carries the folder path and the aggregate state of
// everything inside it, so a collapsed folder still says what it holds.
function rootChips(projects, hidden = 0) {
  const names = new Set(projects.map((p) => p.name));
  const rows = [...state.rows.values()].filter((r) => names.has(r.project));
  const unmerged = rows.filter((r) => {
    const v = String(r.verdict || "");
    return v && !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN";
  }).length;
  const dirty = rows.filter((r) => r.dirty || r.untracked).length;
  const live = rows.filter(isRowLive).length;
  const out = [
    `<span class="chip">${projects.length} project${projects.length === 1 ? "" : "s"}</span>`,
    `<span class="chip">${rows.length} worktrees</span>`,
  ];
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  if (live) out.push(`<span class="chip live">${live} live</span>`);
  // In "last 7 days" mode the folder is a filtered view, and saying so beats an unexplained short list.
  if (hidden) out.push(`<span class="chip" title="projects with no commit, edit or life evidence in the last ${RECENT_DAYS} days">${hidden} hidden</span>`);
  return out.join("");
}

function rootSection(root, allProjects) {
  const open = !state.collapsedRoots.has(root);
  const recentOnly = state.recentRoots.has(root);
  const projects = shownInRoot(root, allProjects);
  const hidden = allProjects.length - projects.length;
  const anyOpen = projects.some((p) => state.expandedProjects.has(p.name));
  const recentTitle = recentOnly
    ? `showing ${projects.length} of ${allProjects.length} projects — only those touched in the last ${RECENT_DAYS} days; click to show every project`
    : `showing all ${allProjects.length} projects; click to show only those touched in the last ${RECENT_DAYS} days`;
  return `<section class="root-group${open ? "" : " collapsed"}" data-root="${esc(root)}">
    <div class="root-head" data-toggle-root="${esc(root)}" title="${open ? "collapse" : "expand"} ${esc(labelRoot(root))}">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <h2${state.rootLabels.has(root) ? ` title="${esc(labelRoot(root))}"` : ""}>${esc(displayRootLabel(root))}</h2>
      <button type="button" class="btn-rename btn-root-rename" data-rename-root="${esc(root)}" title="${state.rootLabels.has(root) ? `rename this folder's tab — path: ${esc(labelRoot(root))} · blank clears it back to the path` : `give this folder a custom tab name instead of ${esc(labelRoot(root))}`}">\u270e</button>
      <div class="chips">${rootChips(projects, hidden)}</div>
      <span class="spacer"></span>
      <span class="root-filter" title="filter the projects in this folder by name or path — Escape clears it">
        <input class="root-search mono" data-root-search="${esc(root)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" spellcheck="false"
          placeholder="filter ${allProjects.length}&hellip;" value="${esc(rootFilterValue(root))}">
        <button type="button" class="root-search-clear${rootFilterValue(root) ? " is-on" : ""}" data-root-search-clear="${esc(root)}" title="clear the filter">\u2715</button>
        <span class="root-count mono${rootFilterValue(root) ? " on" : ""}" data-root-count></span>
      </span>
      <button type="button" class="btn-root-recent${recentOnly ? " on" : ""}" data-root-recent="${esc(root)}" title="${esc(recentTitle)}">${recentOnly ? `${RECENT_DAYS}d` : "All"}</button>
      <button type="button" class="btn-root-collapse" data-root-collapse="${esc(root)}" title="${anyOpen ? "collapse" : "expand"} every project in ${esc(labelRoot(root))} (${projects.length})">${anyOpen ? "Collapse all" : "Expand all"}</button>
      <button type="button" class="btn-root-clone" data-root-clone="${esc(root)}" title="clone a GitHub repo over ssh into ${esc(labelRoot(root))}">+</button>
    </div>
    <div class="root-clone" data-clone-form="${esc(root)}"${state.cloneStatus[root] ? "" : " hidden"}>
      <input type="text" data-clone-input="${esc(root)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" placeholder="repo name — e.g. agent-worktree-gui, or owner/repo" spellcheck="false">
      <button type="button" data-clone-go="${esc(root)}">Clone via ssh</button>
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
  const open = state.expandedProjects.has(name);
  const mainLine = p.localMain && p.remoteTip
    ? `local ${esc(p.mainBranch)} <code>${esc(p.localMain)}</code> · ${p.mainBehind ?? "?"} behind / ${p.mainAhead ?? "?"} ahead of remote`
    : p.error ? esc(p.error) : "local main unknown";
  const board = p.board
    ? `<span class="mono ${p.board.live?.length ? "sig-board-live" : "dimmer"}">board: ${p.board.live?.length ? p.board.live.map((e) => `pid ${e.pid}`).join(", ") : `no live entries (${p.board.dead} stale)`}</span>`
    : "";
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
      <span class="mono dim">${mainLine}</span><span class="spacer"></span>${board}${tip}
      <span class="dimmer mono">${p.fetchNote ? esc(p.fetchNote) + " · " : ""}fetched ${relTime(p.fetchedAt)} ago</span>
    </div>
    <div class="wt-scroll">
      <table><thead><tr>
        <th>Worktree</th><th>Branch</th><th>Tip</th><th>Ahead / Behind</th><th>Cherry</th>
        <th>PR</th><th>Dirty</th><th title="time since this worktree was last seen alive (any evidence firing) · the ring fills up to green as the row becomes due for its next read · chips are the evidence: ⧉ hermes session · ● board PID · :port dev server · ✎ files edited">Life / next read</th><th>Verdict</th><th title="remove a worktree (sent to the Recycle Bin)"></th>
      </tr></thead><tbody data-tbody="${esc(name)}"></tbody></table>
    </div>
    <div class="legend">liveness evidence: <span class="sig sig-hermes">⧉ hermes</span> session active · <span class="sig sig-claude">⧉ claude</span> Claude Code session active · <span class="sig sig-board">● board</span> live board PID · <span class="sig sig-port">:port</span> dev server listening · <span class="sig sig-files">✎ files</span> edited recently — a row is live only if one of these fired · the number is time since that last happened, the ring fills up to green as the row becomes due for its next read</div>
  </section>`;
}

function refreshChips(name) {
  const el = document.querySelector(`[data-chips="${CSS.escape(name)}"]`);
  if (el) el.innerHTML = chipsHtml(name);
}

// ---- column widths: measured from the rows, draggable, remembered ----------------------------
// The table is `table-layout: fixed` on purpose (auto layout let one long branch grow it past its card), so every
// column width is a number somebody has to choose. Percentages chose badly: the verdict column held 12.6% of the
// row to show "NO COMMITS", and the worktree column held 28% to carry a name, a rename ✎ and the agent chips -
// exactly what the name alone used up, so the chips were the part that got clipped while the far side of the row
// sat empty. The split is now measured: each column asks for its widest cell, the columns that read the same at any
// width give their room up first when the table is narrower than that, and the spare room goes to the two text
// columns. A drag on the edge between two headers sets those two by hand (remembered in this browser, shared by
// every project table); a double-click on any edge hands the board back to the measurement.
const WT_COLS = 10;
// Floors, measured off the real cell text at the panel's own font sizes: the hash, `0 / 0`, `+0/−0`, `none`,
// `clean`/`3 +1?`, `0s` with the ring and one chip, `NO COMMITS` and the row's ✕ each fit whole at these numbers.
// A long branch or a long `MERGED (squash/rebase, 3 commits)` still ellipsizes - that is the cheapest thing to lose.
const COL_MIN = [170, 110, 70, 58, 56, 62, 64, 120, 104, 32];
// How readily a column gives width back when the content is wider than the table, per column: 1 is a column that
// says little at any width (`+0/−0`, `none`), 0.15 is one that must not move (the row's ✕). A column only ever gives
// up its own slack above its floor, so the numbers decide how the squeeze is shared, not who is cut to the bone.
const COL_GIVE = [0.35, 0.45, 1, 1, 1.1, 1.1, 1, 0.5, 0.5, 0.15];
const COL_WIDTHS_KEY = "wtgui.colWidths";

function loadColWidths() {
  const out = new Array(WT_COLS).fill(null);
  try {
    const raw = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || "[]");
    if (Array.isArray(raw)) for (let i = 0; i < WT_COLS; i += 1) if (Number.isFinite(raw[i]) && raw[i] > 0) out[i] = Math.round(raw[i]);
  } catch {
    /* a corrupt value is the same as none */
  }
  return out;
}
let colWidths = loadColWidths();

function saveColWidths() {
  try {
    localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths));
  } catch {
    /* private mode: the widths just do not persist */
  }
}

function headerCells(table) {
  return table?.tHead?.rows?.[0] ? [...table.tHead.rows[0].cells] : [];
}

// What each column would be with nothing constraining it: the header text and every cell below it, chips and
// buttons included. Measured on the real table by letting it lay out at max-content for one synchronous step and
// putting the fixed split back before the frame paints - no clone, no flicker.
function naturalColumnWidths(table) {
  const ths = headerCells(table);
  const kept = ths.map((th) => th.style.width);
  const layout = table.style.tableLayout;
  const width = table.style.width;
  table.style.tableLayout = "auto";
  table.style.width = "max-content";
  for (const th of ths) th.style.width = "";
  const natural = ths.map((th) => Math.ceil(th.getBoundingClientRect().width));
  table.style.tableLayout = layout;
  table.style.width = width;
  ths.forEach((th, i) => {
    th.style.width = kept[i];
  });
  return natural;
}

// What the columns want turned into what they get, in px, adding up to the table's own width.
function columnPlan(natural, total) {
  const fixed = colWidths.map((w) => w != null);
  const want = natural.map((n, i) => (fixed[i] ? colWidths[i] : Math.max(COL_MIN[i], n)));
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  let spare = total - sum(want);
  if (spare > 0) {
    // Spare room belongs to the columns whose text truncates: 70/30 worktree and branch. A column the reader sized
    // by hand is a promise, so it is skipped; with both text columns hand-set the room is spread over the rest.
    let pool = [0, 1].filter((i) => !fixed[i]);
    if (!pool.length) pool = want.map((_, i) => i).filter((i) => !fixed[i]);
    if (!pool.length) pool = [0, 1];
    if (pool.length === 1) want[pool[0]] += spare;
    else if (pool.includes(0) && pool.includes(1)) {
      const toName = Math.round(spare * 0.7);
      want[0] += toName;
      want[1] += spare - toName;
    } else for (const i of pool) want[i] += Math.floor(spare / pool.length);
  } else if (spare < 0) {
    // Too narrow for the content: every column gives up the same fraction of what it can spare above its floor,
    // weighted by how little that costs it. Proportional rather than one column at a time - draining the first
    // column to its floor left it clipped mid-word while its neighbour sat at its full natural width.
    let over = -spare;
    for (let pass = 0; pass < 4 && over > 0.5; pass += 1) {
      const room = want.map((w, i) => (fixed[i] ? 0 : Math.max(0, w - COL_MIN[i]) * COL_GIVE[i]));
      const avail = sum(room);
      if (!avail) break;
      const take = Math.min(over, avail);
      for (let i = 0; i < want.length; i += 1) if (room[i]) want[i] -= (room[i] / avail) * take;
      over -= take;
    }
    // Every column at its floor and still too wide (a very narrow window): scale instead of letting the table grow
    // past its card, which is the bug `table-layout: fixed` exists to prevent.
    if (over > 0) {
      const scale = Math.min(1, total / sum(want));
      for (let i = 0; i < want.length; i += 1) want[i] = Math.max(24, Math.floor(want[i] * scale));
    }
  }
  // Integers that add up to the table's width exactly: rounding lands on the worktree column, the one with room.
  want[0] = Math.max(24, want[0] + (total - sum(want)));
  return want;
}

function applyColumnWidths(table, widths) {
  headerCells(table).forEach((th, i) => {
    th.style.width = `${Math.max(24, Math.round(widths[i]))}px`;
  });
}

// ---- how wide the split is allowed to be, and what happens when there is less room than that ----------------
// The table's own box has always been the answer, and on a desktop card it still is. It stops being an answer once
// the card is narrower than the ten columns' measured floors (COL_MIN, 846px in total): the plan then had to scale
// every column below its floor, and a 393px phone - 330px of table - gave each column ~24px, so the headers wrapped
// onto three lines and the values ran into each other. There is no smaller readable version of ten columns, so below
// that width the table keeps the floor width and `.wt-scroll` (its wrapper) scrolls sideways instead. The mode is
// decided here, from the wrapper's own width, which the table cannot influence: no feedback loop, and no scrollbar
// that makes itself necessary.
const WT_SCROLL = "wt-scroll";

function fitTarget(table) {
  const wrap = table.parentElement && table.parentElement.classList.contains(WT_SCROLL) ? table.parentElement : null;
  const box = Math.floor((wrap || table).clientWidth);
  const floor = COL_MIN.reduce((a, b) => a + b, 0);
  const scroll = Boolean(wrap) && box > 0 && box < floor;
  return { wrap, box, total: scroll ? floor : box, scroll };
}

// Writes the mode onto the page: the class the CSS hangs the sideways scroll on, the table's own min-width (the
// width the column split adds up to, so nothing overflows inside the table), and the visible width the two
// column-spanning rows are pinned to while the columns move under them.
function applyFitMode(table, fit) {
  if (!fit.wrap) return;
  fit.wrap.classList.toggle("is-scroll", fit.scroll);
  // Written only when it changes: this runs on every row rebuild, and re-setting a value that is already there
  // costs a style recalculation of the whole table for nothing.
  const minWidth = fit.scroll ? `${fit.total}px` : "";
  if (table.style.minWidth !== minWidth) table.style.minWidth = minWidth;
  if (fit.scroll) {
    const visible = `${fit.box}px`;
    if (fit.wrap.style.getPropertyValue("--wt-visible") !== visible) fit.wrap.style.setProperty("--wt-visible", visible);
  } else if (fit.wrap.style.getPropertyValue("--wt-visible")) {
    fit.wrap.style.removeProperty("--wt-visible");
  }
}

// Measurements are only good while the cells are: a repaint that changed no text should not pay for a layout.
const columnSigs = new WeakMap();

function columnSignature(tbody) {
  let chips = 0;
  for (const el of tbody.querySelectorAll(".sig, .chip")) chips += 1;
  return `${tbody.children.length}:${tbody.textContent.length}:${chips}`;
}

function fitColumns(table) {
  // A scan landing mid-drag must not fight the pointer for the pair being sized.
  if (colDrag) return;
  const ths = headerCells(table);
  if (ths.length !== WT_COLS) return;
  installColumnGrips(table);
  const tbody = table.tBodies[0];
  const fit = fitTarget(table);
  if (!fit.total || !tbody) return;
  // Applied BEFORE the "nothing changed" return below: whether the chart scrolls is not a fact about the rows, and
  // a phone rotating changes the answer with every cell staying exactly as it was.
  applyFitMode(table, fit);
  const sig = columnSignature(tbody);
  if (columnSigs.get(table) === sig && ths[0].style.width) return;
  columnSigs.set(table, sig);
  applyColumnWidths(table, columnPlan(naturalColumnWidths(table), fit.total));
}

// One measurement per table per frame, however many rows arrived this tick.
const pendingFits = new Set();
let fitScheduled = false;

function scheduleColumnFit(table) {
  if (!table || !table.isConnected) return;
  pendingFits.add(table);
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    const tables = [...pendingFits];
    pendingFits.clear();
    // A new split can re-wrap a chip strip and make a row taller. Near the bottom of the page that shortens (or
    // lengthens) the document under the reader, so the position is held across the measurement like any rebuild.
    const pageY = window.scrollY;
    for (const t of tables) if (t.isConnected) fitColumns(t);
    if (window.scrollY !== pageY) {
      const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(pageY, maxY) });
    }
  });
}

function fitAllColumns() {
  const slot = $("projects");
  if (!slot) return;
  for (const table of slot.querySelectorAll("section.project > .wt-scroll > table")) {
    columnSigs.delete(table);
    fitColumns(table);
  }
}

// ---- dragging a column edge ------------------------------------------------------------------
// Only the two columns on either side of the grip move, and they trade width rather than push the rest of the row
// around: the sum of the pair is what stays put. Released, the pair is remembered for every project's table.
let colDrag = null;

function installColumnGrips(table) {
  const ths = headerCells(table);
  ths.forEach((th, i) => {
    // Nothing sits to the right of the ✕ column, and one grip per header is enough however often this repaints.
    if (i === ths.length - 1 || th.querySelector(".col-grip")) return;
    const grip = document.createElement("span");
    grip.className = "col-grip";
    grip.dataset.col = String(i);
    grip.title = "drag to set this column's width · double-click to fit every column to its content again";
    grip.addEventListener("pointerdown", beginColumnDrag);
    grip.addEventListener("dblclick", (e) => {
      e.preventDefault();
      colWidths = new Array(WT_COLS).fill(null);
      saveColWidths();
      fitAllColumns();
    });
    th.appendChild(grip);
  });
}

function beginColumnDrag(e) {
  if (e.button !== 0) return;
  const grip = e.currentTarget;
  const table = grip.closest("table");
  const i = Number(grip.dataset.col);
  const widths = headerCells(table).map((th) => th.getBoundingClientRect().width);
  if (!widths.length || widths[i + 1] == null) return;
  colDrag = { grip, table, i, x: e.clientX, widths, pair: widths[i] + widths[i + 1], left: null };
  grip.classList.add("is-dragging");
  document.body.classList.add("col-resizing");
  e.preventDefault();
  e.stopPropagation();
  window.addEventListener("pointermove", dragColumn);
  window.addEventListener("pointerup", endColumnDrag, { once: true });
  window.addEventListener("pointercancel", endColumnDrag, { once: true });
}

function dragColumn(e) {
  if (!colDrag) return;
  const { table, i, x, widths, pair } = colDrag;
  const ths = headerCells(table);
  const left = Math.max(COL_MIN[i], Math.min(pair - COL_MIN[i + 1], Math.round(widths[i] + (e.clientX - x))));
  colDrag.left = left;
  colDrag.right = Math.round(pair - left);
  ths[i].style.width = `${colDrag.left}px`;
  ths[i + 1].style.width = `${colDrag.right}px`;
}

function endColumnDrag() {
  if (!colDrag) return;
  const { grip, i, left, right } = colDrag;
  colDrag = null;
  window.removeEventListener("pointermove", dragColumn);
  grip.classList.remove("is-dragging");
  document.body.classList.remove("col-resizing");
  // A press with no movement is a click on the edge, not a decision about the width.
  if (left == null) return;
  colWidths[i] = left;
  colWidths[i + 1] = right;
  saveColWidths();
  fitAllColumns();
}

// A narrower window means the same content in less room, so the measurement is redone. Resizing the window fires
// this continuously, and each fit costs a layout, so it waits for the drag to settle.
let columnFitTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(columnFitTimer);
  columnFitTimer = setTimeout(fitAllColumns, 140);
});

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

function applyStabilize(on) {
  const box = $("stabilize-reorder");
  if (box) box.checked = on;
  try {
    localStorage.setItem(STABILIZE_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the choice just will not persist */
  }
  // Turned on, the current order is the order worth keeping: take it before the next paint re-sorts anything.
  rememberAgentOrders();
  renderAll();
  scheduleRenderJobs();
}

// ---- automatic sort, on/off ------------------------------------------------------------------
// Settings > Board > Automatic sort. On (default) is the panel's usual behaviour: running agents first,
// then anything recently alive, newest first. Off, orderRows() stops ranking rows altogether — the only
// thing that still moves a row is a manual drag (see applyManualOrder), and an untouched row just keeps
// sitting wherever it already was. Saved in this browser.
const AUTO_SORT_KEY = "wtgui.autoSort";
function autoSortOn() {
  try {
    const raw = localStorage.getItem(AUTO_SORT_KEY);
    return raw === null ? true : raw !== "0";
  } catch {
    return true;
  }
}

function applyAutoSort(on) {
  const box = $("autosort-toggle");
  if (box) box.checked = on;
  try {
    localStorage.setItem(AUTO_SORT_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the choice just will not persist */
  }
  renderAll();
}

// Is anything open in this list? Rows of a project, and cards of a row.
function projectHasOpenRow(name) {
  for (const key of state.expanded) if (state.rows.get(key)?.project === name) return true;
  return false;
}

function rowHasOpenCard(threads) {
  return threads.some((t) => !state.collapsedJobs.has(t));
}

// The order the cards in one row were last painted in, with anything new appended. A frozen list keeps this; a list
// that is free to sort ignores it.
function orderedAgents(row, agents) {
  const key = keyOf(row.project, row.path);
  if (!stabilizeOn() || !rowHasOpenCard(agents.map((c) => c.thread))) return agents;
  const last = state.agentOrder.get(key);
  if (!last || !last.length) return agents;
  const pos = new Map(last.map((t, i) => [t, i]));
  return [...agents].sort((a, b) => (pos.get(a.thread) ?? last.length) - (pos.get(b.thread) ?? last.length));
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
  if (stabilizeOn() && projectHasOpenRow(name)) return;
  // Re-appending a detail takes its cards out of the DOM on the way, which is enough to lose a selection.
  const heldSelection = captureCardSelection();
  // And enough to lose the caret: a re-rank of some OTHER worktree re-appends every row in this project, including
  // the open one the reader is typing in, and a detached box cannot keep focus. That is the cursor going missing
  // when a row flashes green - the flash touches nothing, the re-sort under it moves everything.
  const typing = $("projects") ? captureTyping($("projects")) : null;
  const mine = [...state.rows.values()].filter((r) => r.project === name);
  // The order if nothing were pinned: our running agents first, then everything by how recently it
  // showed life, with any manual drag order from this project laid on top (see applyManualOrder). This is
  // what "latest movement at the top" means once all the accordions are closed and nothing has been dragged.
  const ranked = applyManualOrder(orderRows([...mine]), state.manualOrder.get(name)).map((r) => keyOf(name, r.path));
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
  const want = [];
  for (const k of orderedKeys) {
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
  if (current.length === want.length && current.every((el, i) => el === want[i])) return;
  beginDomMove();
  for (const el of want) tbody.appendChild(el);
  endDomMove();
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
  const old = state.rowEls.get(key);
  // A collapsed section is not on screen: keep the row in state (the chips and counters need it)
  // but spend nothing on its markup. Expanding the project renders it from state.
  if (!state.expandedProjects.has(project)) {
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
  beginDomMove();
  if (oldDetail) oldDetail.remove();
  // Any other copy for this key is a stray from an earlier render: one row, one detail.
  for (const stray of document.querySelectorAll(`tr.detail[data-detail="${CSS.escape(key)}"]`)) stray.remove();
  state.detailEls.delete(key);
  if (old) old.replaceWith(newTr);
  else tbody.appendChild(newTr);
  state.rowEls.set(key, newTr);
  if (state.expanded.has(key)) {
    const h2 = document.createElement("tbody");
    h2.innerHTML = detailHtml(row);
    const dEl = h2.firstElementChild;
    newTr.after(dEl);
    state.detailEls.set(key, dEl);
    // The cards move across before anything is measured, so "where was this console" is answered by the node
    // that is actually going to stay on screen.
    fillAgentSlots(dEl, oldCards);
    rememberAgentOrder(key, dEl);
    restoreThinkBodies(dEl);
    // Put the reader back: the reply they were typing, where the caret was, and how far each
    // transcript had been scrolled.
    restoreTyping(dEl, typing);
    restoreAddAgent(dEl);
    const scrollMap = new Map(outs.map((o) => [o.id, { top: o.top, atBottom: o.atBottom }]));
    restoreScrolls(dEl, scrollMap);
    applyStoredScrolls(dEl);
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
}

function removeRow(project, p) {
  const key = keyOf(project, p);
  // A row and its detail leaving the page shortens the document. A reader parked at the bottom would be clamped
  // upward by however tall it was, and the height does not come back with their scroll - hold the position.
  const pageY = window.scrollY;
  state.rowEls.get(key)?.remove();
  state.detailEls.get(key)?.remove();
  state.confirmEls.get(key)?.remove();
  state.rowEls.delete(key);
  state.detailEls.delete(key);
  state.confirmEls.delete(key);
  state.rows.delete(key);
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
  // The rebuild below replaces every row of this project, and it must not walk the reader up the page. Emptying the
  // tbody and appending row by row laid the page out with part of the project missing - the reply box measures
  // itself (scrollHeight) while a draft is restored, which forces that layout - and at the bottom of the page ANY
  // shrink clamps the reader's scroll upward for good: the height comes back, the scroll position does not. So the
  // rows are built off the document and swapped in one operation, and the page position is held across the swap.
  const pageY = window.scrollY;
  // Open rows carry agent transcripts; a rebuild must not throw the reader to the top of one.
  const prevScrolls = captureScrolls(tbody);
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
  // projects that was ~110 invisible rows and most of the render cost of a snapshot.
  const expanded = state.expandedProjects.has(name);
  const frag = document.createDocumentFragment();
  const built = [];
  // Stabilized: while a row of this project is open, the rows keep the order they are already in on screen (a row
  // that is genuinely new goes last). Only the painting order changes - the ranking is still there for when the
  // reader closes everything.
  const rowsInOrder = applyManualOrder(orderRows([...state.rows.values()].filter((r) => r.project === name)), state.manualOrder.get(name));
  if (stabilizeOn() && projectHasOpenRow(name) && prevRowKeys.length) {
    const pos = new Map(prevRowKeys.map((k, i) => [k, i]));
    rowsInOrder.sort(
      (a, b) =>
        (pos.get(keyOf(name, a.path)) ?? prevRowKeys.length) - (pos.get(keyOf(name, b.path)) ?? prevRowKeys.length),
    );
  }
  if (expanded) {
    for (const row of rowsInOrder) {
      const key = keyOf(name, row.path);
      const holder = document.createElement("tbody");
      holder.innerHTML = rowHtml(row);
      const tr = holder.firstElementChild;
      frag.appendChild(tr);
      // An open confirmation belongs to its row, and this path rebuilds every row: carry the live node
      // over so the question survives the repaint (and does not come back at the top of the table).
      const confirmEl = state.confirmEls.get(key);
      if (confirmEl) frag.appendChild(confirmEl);
      let dEl = null;
      if (state.expanded.has(key)) {
        const h2 = document.createElement("tbody");
        h2.innerHTML = detailHtml(row);
        dEl = h2.firstElementChild;
        frag.appendChild(dEl);
      }
      built.push({ key, tr, dEl });
    }
  }
  // One swap: the old rows leave as the new ones arrive, so the document never lays out half-built.
  beginDomMove();
  tbody.replaceChildren(frag);
  if (!expanded) {
    for (const k of [...state.rowEls.keys()]) if (state.rows.get(k)?.project === name) state.rowEls.delete(k);
    for (const k of [...state.detailEls.keys()]) if (state.rows.get(k)?.project === name) state.detailEls.delete(k);
    endDomMove();
    // Nothing of this project's is on screen any more, so its confirmation is gone with it.
    for (const k of [...state.confirmEls.keys()]) if (state.rows.get(k)?.project === name) state.confirmEls.delete(k);
    // The header is still on screen and its rows are not: measure it anyway, so opening the project later does not
    // start from the percentage fallback.
    fitColumns(tbody.closest("table"));
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
  // A row that no longer exists must not leave a dead detail element remembered.
  for (const k of [...state.detailEls.keys()]) {
    if (state.rows.get(k)?.project !== name) state.detailEls.delete(k);
    else if (!state.expanded.has(k)) state.detailEls.delete(k);
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
}

// Header summary. The project count is the live one — what the table is actually showing — not
// the configured fallback list the server reports before discovery has run.
function paintConfigLine() {
  const cfg = state.settings || {};
  if (cfg.host === undefined) return;
  const n = state.projects.size || (Array.isArray(cfg.projects) ? cfg.projects.length : 0);
  const scope = cfg.scanMode === "visible" ? " · refresh on screen only" : "";
  $("config-line").textContent = `${cfg.version ? `v${cfg.version} · ` : ""}${n} project(s) · cheap fields every ${cfg.worktreeSeconds}s · verdict/PR every ${cfg.slowSeconds}s · ${cfg.threads} scan threads · ${cfg.host}${scope}`;
}

function renderAll() {
  // A full re-render rebuilds the chips from scratch; the job list is the freshest input.
  const anchor = captureBoardAnchor();
  // The whole board is replaced below, one project tbody at a time. Hold the page position across it: a layout that
  // happens while part of the board is missing clamps a reader parked near the bottom up the page, and the height
  // coming back does not bring their scroll with it.
  const pageY = window.scrollY;
  // The replacement takes every card off the page, so the caret is read here, before it is gone, and put back at the
  // end - a snapshot repaint must not end a sentence the reader is in the middle of.
  const typingBoard = captureTyping($("projects"));
  invalidatePanelMap();
  const projects = sortedProjects();
  for (const id of [...state.expandedProjects]) if (!state.projects.has(id)) state.expandedProjects.delete(id);
  // Wrap every project in its folder accordion: one group per scan root, and a sibling group
  // for any project that lives outside all of them (so nothing is filed under a folder it is
  // not actually in). Groups are ordered by their most recently active project.
  const groups = new Map();
  for (const p of projects) {
    const root = rootOf(p);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  }
  const prevRoots = new Map();
  for (const g of $("projects").querySelectorAll("section.root-group")) {
    prevRoots.set(g.dataset.root, [...g.querySelectorAll(".root-body section.project")].map((s) => s.dataset.project));
  }
  // Every card and the inline add-agent field leave the page here; bracketed so their blur is not read as the reader
  // walking away. Both are put back below.
  beginDomMove();
  $("projects").innerHTML =
    [...groups.entries()]
      .sort((a, b) => projectActivity(b[1][0]) - projectActivity(a[1][0]) || a[0].localeCompare(b[0]))
      .map(([root, list]) => rootSection(root, list))
      .join("") || '<p class="empty">No git repos found under scanRoots.</p>';
  // Every tbody on the page was just replaced, so an open confirmation row is detached now. Forget it
  // here: renderProjectRows would otherwise re-insert the old node into a fresh table.
  for (const el of state.confirmEls.values()) el.remove();
  state.confirmEls.clear();
  // The rebuild sorted every folder by activity; put the open ones back in the slot they held.
  for (const g of $("projects").querySelectorAll("section.root-group")) {
    pinOpenProjects(g.querySelector(".root-body"), prevRoots.get(g.dataset.root));
  }
  // ...and the folder that holds an open project keeps its own place in the folder list.
  {
    const folders = [...$("projects").querySelectorAll("section.root-group")];
    const holdsOpen = (g) => [...g.querySelectorAll("section.project")].some((s) => state.expandedProjects.has(s.dataset.project));
    const pinned = new Map();
    folders.forEach((g, i) => {
      const prev = prevRoots.get(g.dataset.root);
      if (prev && holdsOpen(g)) pinned.set(i, g);
    });
    if (pinned.size) {
      const held = new Set(pinned.values());
      const free = folders.filter((g) => !held.has(g));
      const want = [];
      let f = 0;
      for (let i = 0; i < folders.length; i++) want.push(pinned.has(i) ? pinned.get(i) : free[f++]);
      if (!want.every((g, i) => g === folders[i])) for (const g of want) $("projects").appendChild(g);
    }
  }
  state.tbodyEls.clear();
  state.rowEls.clear();
  state.detailEls.clear();
  for (const p of projects) {
    const tbody = document.querySelector(`[data-tbody="${CSS.escape(p.name)}"]`);
    if (tbody) state.tbodyEls.set(p.name, tbody);
    renderProjectRows(p.name);
    refreshChips(p.name);
  }
  // The caret read before the replacement: put it back in the box this rebuild made for it.
  if (typingBoard) restoreTyping($("projects"), typingBoard);
  restoreAddAgent($("projects"));
  endDomMove();
  paintConfigLine();
  paintCollapseAll();
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  scheduleBoardSweep(anchor);
  refreshAnchorBaseline();
  // A rebuild recreates the sections, so every folder's filter has to be re-applied to the new nodes.
  for (const g of $("projects").querySelectorAll("section.root-group")) applyRootFilter(g.dataset.root);
  // A full rebuild reorders the sections too: same test as renderRoot — a re-rank flashes, a filter
  // change (different set) does not.
  for (const g of $("projects").querySelectorAll("section.root-group")) {
    const was = prevRoots.get(g.dataset.root);
    const now = [...g.querySelectorAll(".root-body section.project")];
    if (was && was.length === now.length) flashMovedByKey(was, now, g);
  }
}

function applySnapshot(data) {
  // Captured before anything is mutated: if the set of projects is the same afterwards, the
  // sections on screen are still valid and a full re-render would be pure cost.
  const beforeSig = [...state.projects.keys()].sort().join("|");
  state.settings = data.settings || state.settings;
  if (Array.isArray(data.scanRoots)) state.scanRoots = data.scanRoots;
  if (data.spawn) {
    state.spawn = data.spawn;
    const t = data.spawn.transport || {};
    const caps = t.capabilities || {};
    $("chip-key").textContent = t.reachable ? `api: up${caps.steer ? " · steer" : ""}` : "api: down";
    $("chip-key").title = t.error || `${t.url || ""}${caps.version ? ` · hermes ${caps.version}` : ""}`;
    $("chip-bin").textContent = String(t.url || "").replace(/^https?:\/\//, "") || "no gateway";
    $("chip-bin").title = caps.runCwd
      ? "the gateway honours per-run cwd, so agents work in their own worktree"
      : "the gateway ignores per-run cwd (hermes-runs-api-knobs.diff not applied) — agents run in the gateway's directory";
    syncProjectPicker(data.spawn.projects || []);
  }
  if (data.skipped) {
    $("skipped-note").textContent = data.skipped.length
      ? `skipped under scanRoots (not git repos): ${data.skipped.map((s) => String(s.dir).split(/[\\/]/).pop()).join(", ")}`
      : "";
  }
  if (data.jobs) {
    state.jobs.clear();
    for (const j of data.jobs) {
      state.jobs.set(j.id, j);
      if (!state.jobLines.has(j.id) && j.lines?.length) state.jobLines.set(j.id, j.lines.slice());
    }
    renderJobs();
    invalidatePanelMap();
  }
  if (Array.isArray(data.approvals)) {
    state.approvals.clear();
    for (const r of data.approvals) if (r && r.id) state.approvals.set(r.id, r);
    renderApprovals();
  }
  // The assistant's scratchpad, alerts and thread id travel with the snapshot (assistant.js owns the panel).
  if (data.assistant && typeof applyAssistant === "function") applyAssistant(data.assistant);
  // A snapshot refreshes what it carries; it does not retract rows. Only an explicit "drop"
  // event retires a worktree, so a snapshot arriving mid-scan can never blank the table.
  const incomingProjects = data.projects || [];
  // ...and a snapshot that knows of NO projects is not evidence that there are none: it is what the
  // server reports while its first discovery sweep is still running (a restart, or a sweep that
  // failed). Keeping the board and saying so beats flashing "No git repos found under scanRoots".
  if (!incomingProjects.length && state.projects.size) {
    $("health").className = "dot warn";
    return;
  }
  const seen = new Set();
  for (const p of incomingProjects) {
    seen.add(p.name);
    state.projects.set(p.name, p);
    const wts = Array.isArray(p.worktrees) ? p.worktrees : [];
    if (!wts.length) continue;
    for (const [k, r] of [...state.rows]) if (r.project === p.name) state.rows.delete(k);
    for (const w of wts) {
      const row = { ...w, project: p.name };
      state.rows.set(keyOf(p.name, w.path), row);
      noteScan(row);
    }
  }
  // A snapshot is authoritative about WHICH projects exist: the server drops a project when it
  // disappears from the roots (or was only ever a config fallback before discovery ran), and the
  // client must drop it too instead of keeping a section nothing will ever repaint.
  for (const name of [...state.projects.keys()]) if (!seen.has(name)) state.projects.delete(name);
  for (const [k, r] of [...state.rows]) {
    if (!seen.has(r.project)) {
      state.rows.delete(k);
      state.rowEls.delete(k);
      state.detailEls.delete(k);
    }
  }
  const afterSig = [...state.projects.keys()].sort().join("|");
  if (beforeSig !== afterSig || !document.querySelector("section.project[data-project]")) {
    // The set of projects changed: sections have to be built (or removed) wholesale.
    renderAll();
  } else {
    // Same projects: repaint what is actually on screen. A full re-render here rebuilt 94
    // sections and every row twice a minute for no structural reason, which is exactly the
    // periodic hitch the panel had.
    for (const p of state.projects.values()) {
      refreshChips(p.name);
      renderProjectRows(p.name); // no-ops for a collapsed project
    }
  }
  reorderProjects();
  $("health").className = "dot ok";
  $("banner").classList.add("hidden");
}

function showBanner(msg) {
  const b = $("banner");
  if (!msg) return b.classList.add("hidden");
  b.classList.remove("ok");
  b.textContent = msg;
  b.classList.remove("hidden");
}

// A short green confirmation (the red banner is for failures): used when a gesture did what it said
// without opening a dialog, e.g. an agent attaching itself to the worktree it was already sitting in.
let noteTimer = 0;
function showNote(msg) {
  const b = $("banner");
  if (!b) return;
  b.textContent = msg;
  b.classList.add("ok");
  b.classList.remove("hidden");
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    b.classList.add("hidden");
    b.classList.remove("ok");
  }, 4000);
}

function setStream(label, cls = "ok") {
  $("stream-state").textContent = label;
  $("health").className = `dot ${cls}`;
}

function connect() {
  if (state.es) state.es.close();
  const es = new EventSource("/api/stream");
  state.es = es;
  es.addEventListener("open", () => setStream("● live"));
  es.addEventListener("snapshot", (e) => {
    const d = JSON.parse(e.data);
    state.lastEventAt = Date.now();
    applySnapshot(d.data ? d.data : d);
  });
  es.addEventListener("row", (e) => {
    const evt = JSON.parse(e.data);
    state.events += 1;
    state.lastEventAt = Date.now();
    // Liveness-only updates repaint the row but do not flash it: evidence blinks on and off
    // far more often than git state moves, and flashing for that is just noise.
    queueRow(evt.project, evt.row, { flash: evt.changed !== false && !evt.livenessOnly });
  });
  es.addEventListener("project", (e) => {
    const evt = JSON.parse(e.data);
    const cur = state.projects.get(evt.project.name) || {};
    state.projects.set(evt.project.name, { ...cur, ...evt.project });
    refreshChips(evt.project.name);
    const sec = document.querySelector(`section.project[data-project="${CSS.escape(evt.project.name)}"]`);
    if (!sec) {
      renderAll();
      return;
    }
    // Replace only the section's own markup, then immediately repaint its rows: swapping the
    // whole section used to leave an empty <tbody> behind until the next full re-render,
    // which is what made the worktree table vanish for seconds at a time.
    // Read the page position BEFORE anything leaves the document. Reading scrollY forces a layout, and a layout with
    // this project's rows detached is exactly what clamps the reader upward when they are near the bottom of the page.
    const pageY = window.scrollY;
    // And the caret, for the same reason: this section is about to leave the page, taking the reply box the reader
    // is typing in with it. Once it is detached there is no focus left to capture, so it is read here and handed to
    // the row repaint below, which puts it back in the box it rebuilds.
    const typing = captureTyping(sec);
    // The section swap below takes every card and the inline add-agent field out of the page for an instant; bracketed
    // so their blur does not read as the reader leaving, and both are restored by the row repaint.
    beginDomMove();
    const oldBody = sec.querySelector(`[data-tbody="${CSS.escape(evt.project.name)}"]`);
    const oldRows = oldBody ? [...oldBody.childNodes] : [];
    const holder = document.createElement("div");
    holder.innerHTML = projectSection(evt.project.name);
    const freshHolder = holder.firstElementChild;
    // A project event replaces the whole section. If it was mid-flash (it had just moved because an
    // agent started in it), the replacement would silently drop the highlight.
    if (sec.classList.contains("flash")) {
      freshHolder.classList.add("flash");
      clearTimeout(freshHolder._flashT);
      freshHolder._flashT = setTimeout(() => freshHolder.classList.remove("flash"), flashProjectMs() + 40);
    }
    sec.replaceWith(freshHolder);
    // The fresh section arrives with an empty tbody. Put the rows that were on screen straight back into it, before
    // anything measures, so the document never lays out with the project missing: the swap takes the section out and
    // the rows back in between two statements, and nothing in between reads the layout.
    const newBody = freshHolder.querySelector(`[data-tbody="${CSS.escape(evt.project.name)}"]`);
    if (oldRows.length && newBody) newBody.replaceChildren(...oldRows);
    state.tbodyEls.set(evt.project.name, newBody);
    if (window.scrollY !== pageY) {
      const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(pageY, maxY) });
    }
    renderProjectRows(evt.project.name, { typing });
    endDomMove();
    restoreAddAgent(freshHolder);
    // A project whose rows really did grow or shrink moves the document. This handler is one synchronous step, so a
    // scroll that moved under it is a clamp, not the reader: put them back before the board re-sorts under them.
    if (window.scrollY !== pageY) {
      const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(pageY, maxY) });
    }
    reorderProjects();
  });
  es.addEventListener("drop", (e) => {
    const evt = JSON.parse(e.data);
    removeRow(evt.project, evt.path);
  });
  es.addEventListener("job", (e) => {
    state.lastEventAt = Date.now();
    const job = JSON.parse(e.data).job;
    updateJob(job);
    // A job being created, re-statused or finished is news about the worktree that owns it.
    if (job) noteEventLife(job.thread || job.id);
  });
  es.addEventListener("jobline", (e) => {
    const evt = JSON.parse(e.data);
    appendJobLine(evt);
    // Every line an agent writes is proof that its worktree is being worked in right now - the freshest sign of
    // life there is, and one the scanner only finds out about on its next pass.
    noteEventLife(state.jobs.get(evt.id)?.thread || evt.thread || evt.id);
  });
  es.addEventListener("approval", (e) => {
    const r = JSON.parse(e.data).request;
    if (!r || !r.id) return;
    state.approvals.set(r.id, r);
    renderApprovals();
    // The agent that is blocked now says "waiting on you" instead of just "running".
    if (r.thread) {
      noteEventLife(r.thread);
      renderConversation(r.thread);
    }
  });
  es.addEventListener("approval-answered", (e) => {
    const evt = JSON.parse(e.data);
    const r = state.approvals.get(evt.id);
    state.approvals.delete(evt.id);
    renderApprovals();
    if (r && r.thread) {
      noteEventLife(r.thread);
      renderConversation(r.thread);
    }
  });
  es.addEventListener("jobs", (e) => {
    state.lastEventAt = Date.now();
    state.jobs.clear();
    for (const j of JSON.parse(e.data).jobs) state.jobs.set(j.id, j);
    scheduleRenderJobs();
    repaintAgentState();
  });
  // The sentry's own state: a new alert, a dismissed one, a watch closing, a settings change from another tab.
  es.addEventListener("assistant", (e) => {
    state.lastEventAt = Date.now();
    const d = JSON.parse(e.data);
    if (d.assistant && typeof applyAssistant === "function") applyAssistant(d.assistant);
  });
  es.addEventListener("heartbeat", (e) => {
    state.pool = JSON.parse(e.data).pool;
  });
  es.addEventListener("error", () => setStream("reconnecting…", "warn"));
}

async function resync() {
  try {
    applySnapshot(await apiFetch("/api/state").then((r) => r.json()));
  } catch (e) {
    showBanner(`Cannot reach the server: ${e.message}`);
    setStream("offline", "bad");
  }
}

async function post(route) {
  try {
    await apiFetch(route, { method: "POST" });
    await resync();
  } catch (e) {
    showBanner(`${route}: ${e.message}`);
  }
}

$("btn-refresh").addEventListener("click", () => post("/api/refresh"));
$("btn-reset-colors").addEventListener("click", () => {
  const n = state.projectHues.size;
  state.projectHues.clear();
  saveProjectHues();
  for (const sec of document.querySelectorAll("section.project.has-hue")) {
    sec.classList.remove("has-hue");
    sec.style.removeProperty("--proj-hue");
    const head = sec.querySelector(".project-head[data-toggle-project]");
    if (head) head.title = headTitle(sec.dataset.project);
  }
  updateColorsRow();
  showBanner(n ? `project colours cleared (${n} project${n === 1 ? "" : "s"})` : "no project colours to clear");
});
$("btn-collapse-all").addEventListener("click", () => toggleEverything());

// Ctrl+[ folds the whole board, Ctrl+] opens it — the square brackets point the way (in, then out).
// Ignored while a field has focus: a bracket belongs in a prompt or a filter, not on the board.
window.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.metaKey || e.altKey) return;
  // e.key is layout-dependent; e.code is not, so either identifies the key.
  let open = null;
  if (e.key === "[" || e.code === "BracketLeft") open = false;
  else if (e.key === "]" || e.code === "BracketRight") open = true;
  if (open === null) return;
  const el = e.target;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  e.preventDefault();
  setEverythingOpen(open);
});
$("btn-fetch").addEventListener("click", () => post("/api/fetch"));
$("job-project").addEventListener("change", () => {
  const p = selectedProject();
  if (p) $("job-cwd").value = p.path;
  $("job-create").checked = true;
  state.spawnTarget = null;
  updateSpawnNote();
});
$("job-cwd").addEventListener("input", updateSpawnNote);
$("job-create").addEventListener("change", () => {
  updateSpawnNote();
});
$("btn-spawn").addEventListener("click", spawnAgent);
// Retry, in the two places an error is posted: the spawn card and a settled turn's foot.
document.addEventListener("click", (e) => {
  const spawn = e.target.closest ? e.target.closest("[data-retry-spawn]") : null;
  if (spawn) {
    e.preventDefault();
    void retrySpawn();
    return;
  }
  const turn = e.target.closest ? e.target.closest("[data-retry-turn]") : null;
  if (!turn) return;
  e.preventDefault();
  e.stopPropagation();
  const thread = turn.dataset.retryTurn;
  const conv = conversations().find((c) => c.thread === thread);
  const last = conv?.turns?.[conv.turns.length - 1];
  const text = String(last?.prompt || "").trim();
  if (!text) return;
  turn.disabled = true;
  void sendReply(thread, text);
});
$("btn-clear-jobs").addEventListener("click", () => post("/api/jobs/clear"));
$("btn-fold-jobs").addEventListener("click", () => {
  const convs = conversations();
  const allFolded = convs.length > 0 && convs.every((c) => state.collapsedJobs.has(c.thread));
  foldAll(!allFolded);
});
$("job-prompt").addEventListener("input", () => updateSpawnNote());
// Ctrl+wheel over a console resizes its text, the way a terminal does, instead of zooming the page. Scoped to
// that card's output (`--out-size`), so one long transcript can be shrunk without touching the rest of the board;
// the Settings "Console size" remains the baseline. Steps of 1px, clamped to what a monospace face still reads
// at, and the page zoom is only suppressed while the pointer is actually over a console.
const CONSOLE_ZOOM_MIN = 7;
const CONSOLE_ZOOM_MAX = 24;
const THINK_ZOOM_MIN = 8;
const THINK_ZOOM_MAX = 22;

function zoomConsole(out, step) {
  const card = out.closest(".job");
  const thread = card && card.dataset.thread;
  if (!thread) return;
  const base = Number(state.consoleZoom.get(thread)) || parseFloat(getComputedStyle(out).fontSize) || 11.5;
  // Half-pixel steps: the console's default size is 11.5px, and rounding to whole pixels made the first tick
  // jump 1.5px while every tick after it moved 1.
  const next = Math.min(CONSOLE_ZOOM_MAX, Math.max(CONSOLE_ZOOM_MIN, Math.round((base + step) * 2) / 2));
  state.consoleZoom.set(thread, next);
  card.style.setProperty("--out-size", `${next}px`);
  out.style.fontSize = `${next}px`;
}

// The same gesture over a thinking body: reasoning text has its own size (11.5px by default) and its own var, so
// zooming it never moves the console's text.
function zoomThink(body, step) {
  const card = body.closest(".job");
  const thread = card && card.dataset.thread;
  if (!thread) return;
  const block = body.querySelector(".think-block") || body;
  const base = Number(state.thinkZoom.get(thread)) || parseFloat(getComputedStyle(block).fontSize) || 11.5;
  const next = Math.min(THINK_ZOOM_MAX, Math.max(THINK_ZOOM_MIN, Math.round((base + step) * 2) / 2));
  state.thinkZoom.set(thread, next);
  card.style.setProperty("--think-size", `${next}px`);
}

// Ctrl+wheel over a console must not ALSO zoom the window. Cancel it at the earliest point in the event's path
// (capture on window) and stop it there, so neither the page's own listeners nor anything above them sees a
// cancellable wheel: a passive listener anywhere in the path - the panel has one on document for pendingFocus -
// can otherwise leave the browser free to run its zoom gesture.
const onConsoleWheel = (e) => {
  if (!e.ctrlKey) return;
  const target = e.target && e.target.closest ? e.target : null;
  const out = target ? target.closest(".job-out") : null;
  const think = !out && target ? target.closest(".think-body") : null;
  if (!out && !think) return;
  if (e.cancelable) e.preventDefault();
  e.stopPropagation();
  if (out) zoomConsole(out, e.deltaY < 0 ? 1 : -1);
  else zoomThink(think, e.deltaY < 0 ? 1 : -1);
};
window.addEventListener("wheel", onConsoleWheel, { passive: false, capture: true });
// Trackpad pinch arrives as a gesture in Safari, not as a ctrl+wheel, and would zoom the page under the pointer.
for (const type of ["gesturestart", "gesturechange"]) {
  window.addEventListener(
    type,
    (e) => {
      const out = e.target && e.target.closest ? e.target.closest(".job-out") : null;
      if (!out) return;
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    },
    { passive: false, capture: true },
  );
}

// The console resizes like the reply box, but its max-height is what stops it eating the card — and a
// max-height also stops the drag dead. The handle lives in the bottom-right 16px corner, so grabbing
// there lifts the cap first; the height the drag then writes is an inline style and wins over both.
document.addEventListener(
  "pointerdown",
  (e) => {
    const out = e.target && e.target.closest ? e.target.closest(".job-out") : null;
    if (!out) return;
    const r = out.getBoundingClientRect();
    if (e.clientX >= r.right - 16 && e.clientY >= r.bottom - 16) out.style.maxHeight = "none";
  },
  true,
);

// ---- documents pasted into a prompt ------------------------------------------------
// The gateway's runs API has no attachment field, so a document is stored by the panel and its absolute
// path is appended to the prompt at SEND time. On screen it is a chip above the box — `[name] ×` — so the
// thing you typed is not buried under a paragraph of machine text.
const spawnAttachments = []; // the New-agent box's list; it lives in static markup, so no re-render to survive

function attachmentsFor(ctx) {
  return ctx === "spawn" ? spawnAttachments : state.replyAttachments.get(ctx) || [];
}

function setAttachments(ctx, list) {
  if (ctx === "spawn") {
    spawnAttachments.length = 0;
    spawnAttachments.push(...list);
  } else if (list.length) {
    state.replyAttachments.set(ctx, list);
  } else {
    state.replyAttachments.delete(ctx);
  }
}

function fmtBytes(n) {
  const bytes = Number(n) || 0;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function attachmentChipsHtml(ctx) {
  return attachmentsFor(ctx)
    .map(
      (a) =>
        `<span class="attach-chip mono" data-open-path="${esc(a.path)}" title="open ${esc(a.path)} in Notepad++">[${esc(a.name)}]<button type="button" class="chip-x" data-chip-remove="${esc(a.path)}" data-chip-ctx="${esc(ctx)}" title="remove this attachment">\u00d7</button></span>`,
    )
    .join("");
}

function renderChips(ctx) {
  const el =
    ctx === "spawn"
      ? document.getElementById("spawn-chips")
      : document.querySelector(`.attach-chips[data-chips="${CSS.escape(ctx)}"]`);
  if (!el) return;
  el.innerHTML = attachmentChipsHtml(ctx);
}

// What the agent actually receives: the chip stays a chip, the path travels with the message.
function attachmentBlock(ctx) {
  return attachmentsFor(ctx)
    .map((a) => {
      const how = /^image\//.test(String(a.type)) ? "use vision_analyze on it" : "read_file it";
      return `\n\nAttachment: ${a.path} (${a.type || "unknown type"}, ${fmtBytes(a.bytes)}) — ${how} before answering.`;
    })
    .join("");
}

function clearAttachments(ctx) {
  setAttachments(ctx, []);
  renderChips(ctx);
}

async function attachFiles(files, box) {
  const ctx = box.id === "job-prompt" ? "spawn" : box.dataset.reply || null;
  if (!ctx) return;
  for (const file of files) {
    if (!file) continue;
    if (!file.size) {
      if (ctx === "spawn") $("spawn-msg").textContent = `${file.name || "file"} is empty`;
      continue;
    }
    try {
      const res = await apiFetch(
        "/api/attachments",
        {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "x-filename": encodeURIComponent(file.name || "pasted-file"),
          },
          body: file,
        },
        { timeoutMs: 120000 },
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setAttachments(ctx, [...attachmentsFor(ctx), d]);
      renderChips(ctx);
    } catch (e) {
      const warn = ctx === "spawn" ? $("spawn-msg") : document.querySelector(`[data-reply-warn="${CSS.escape(ctx)}"]`);
      if (warn) warn.textContent = `attachment failed: ${e.message}`;
    }
  }
}

function attachTarget(el) {
  return el && el.closest ? el.closest("#job-prompt, .reply-box") : null;
}

document.addEventListener("paste", (e) => {
  const box = attachTarget(e.target);
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!box || !files.length) return; // text pastes stay text
  e.preventDefault();
  void attachFiles(files, box);
});

document.addEventListener("dragover", (e) => {
  const box = attachTarget(e.target);
  if (!box || !e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
  e.preventDefault();
  box.classList.add("drop-target");
});
document.addEventListener("dragleave", (e) => {
  const box = attachTarget(e.target);
  if (box) box.classList.remove("drop-target");
});
document.addEventListener("drop", (e) => {
  const box = attachTarget(e.target);
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (!box || !files.length) return;
  e.preventDefault();
  box.classList.remove("drop-target");
  void attachFiles(files, box);
});

// ---- manual sort: drag a worktree row by the grip on its left to reorder it vertically ------------
// Native HTML5 drag-and-drop, started only from the handle (it is the one draggable="true" element in
// the row, so nothing else in the row can kick off a drag by accident). The dragged row's whole group —
// itself, plus its detail/confirm siblings if it is expanded — follows the pointer by actually moving in
// the DOM on every dragover; dropping just stops moving it. dragend reads the final DOM order and saves
// it, so the spot a row is dropped at is the spot it keeps on the next resync (see applyManualOrder()).
state.dragRow = null;

// A row's detail (open agents) and delete-confirmation live as sibling <tr>s right after it (see
// renderProjectRows). They must move WITH the row or dragging would strand an open row's agents under
// whatever row ends up above it.
function dragRowGroup(tr) {
  const els = [tr];
  let sib = tr.nextElementSibling;
  while (sib && !sib.classList.contains("row")) {
    els.push(sib);
    sib = sib.nextElementSibling;
  }
  return els;
}

document.addEventListener("dragstart", (e) => {
  const handle = e.target.closest ? e.target.closest(".drag-handle") : null;
  if (!handle) return;
  const tr = handle.closest("tr.row");
  const tbody = tr && tr.closest("tbody[data-tbody]");
  if (!tr || !tbody) return;
  state.dragRow = { tr, project: tbody.dataset.tbody };
  e.dataTransfer.effectAllowed = "move";
  // Firefox refuses to start a drag without data on the transfer.
  try {
    e.dataTransfer.setData("text/plain", tr.dataset.key || "");
  } catch {
    /* some browsers throw on setData for non-text drags; the drag still works without it */
  }
  try {
    e.dataTransfer.setDragImage(tr, 16, tr.offsetHeight / 2);
  } catch {
    /* setDragImage is optional polish; the default drag image is fine without it */
  }
  // Applied a tick late so the drag image snapshot (taken synchronously on dragstart) isn't dimmed too.
  setTimeout(() => tr.classList.add("dragging"), 0);
});

document.addEventListener("dragover", (e) => {
  const dragging = state.dragRow;
  if (!dragging) return;
  const targetRow = e.target.closest ? e.target.closest("tr.row") : null;
  if (!targetRow || targetRow === dragging.tr) return;
  const tbody = targetRow.closest("tbody[data-tbody]");
  // Dropping a worktree into a different project would mix projects' worktrees together — keep the
  // reorder scoped to the project the row was picked up from.
  if (!tbody || tbody.dataset.tbody !== dragging.project) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const rect = targetRow.getBoundingClientRect();
  const before = e.clientY - rect.top < rect.height / 2;
  const group = dragRowGroup(dragging.tr);
  if (group.includes(targetRow)) return; // already in place relative to itself
  const anchor = before ? targetRow : dragRowGroup(targetRow).at(-1).nextElementSibling;
  for (const el of group) tbody.insertBefore(el, anchor);
});

document.addEventListener("drop", (e) => {
  if (!state.dragRow) return;
  const tbody = e.target.closest ? e.target.closest("tbody[data-tbody]") : null;
  if (tbody && tbody.dataset.tbody === state.dragRow.project) e.preventDefault();
});

document.addEventListener("dragend", () => {
  const dragging = state.dragRow;
  state.dragRow = null;
  if (!dragging) return;
  dragging.tr.classList.remove("dragging");
  const tbody = dragging.tr.closest("tbody[data-tbody]");
  if (!tbody) return;
  const paths = [...tbody.querySelectorAll(":scope > tr.row")]
    .map((tr) => state.rows.get(tr.dataset.key)?.path)
    .filter(Boolean);
  setManualOrder(dragging.project, paths);
});

// "make the first commit" on an unborn-HEAD refusal: one empty local commit, then the spawn the button was
// offered for runs again. No push, no file invented for the repo.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest ? e.target.closest("[data-first-commit]") : null;
  if (!btn) return;
  const dir = btn.dataset.firstCommit || "";
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "committing…";
  try {
    const r = await apiFetch(
      "/api/repo/first-commit",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: dir }) },
      { timeoutMs: 60000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // Two entry points, two continuations: from a refused spawn the reader had already asked to run, so
    // it runs again; from the warning above the spawn button they have not, so it just clears the block.
    if (btn.dataset.firstCommitRun === "1") {
      $("spawn-msg").textContent = `first commit ${d.sha} made in ${d.path} — nothing pushed. Spawning again…`;
      void spawnAgent();
    } else {
      $("spawn-msg").textContent = `first commit ${d.sha} made in ${d.path} — nothing pushed.`;
      void resync().then(() => updateSpawnNote());
    }
  } catch (err) {
    $("spawn-msg").textContent = `could not make the first commit: ${err.message}`;
    btn.disabled = false;
    btn.textContent = label;
  }
});

// The chip opens its file; the x removes it.
document.addEventListener("click", (e) => {
  if (!e.target.closest) return;
  const x = e.target.closest("[data-chip-remove]");
  if (x) {
    const ctx = x.dataset.chipCtx;
    setAttachments(ctx, attachmentsFor(ctx).filter((a) => a.path !== x.dataset.chipRemove));
    renderChips(ctx);
    return;
  }
  const chip = e.target.closest(".attach-chip[data-open-path]");
  if (chip) void openArtifact(chip.dataset.openPath);
});

// Enter in the prompt spawns, the way it does in every other box here. Shift+Enter is a newline, so a
// multi-line prompt is still possible.
$("job-prompt").addEventListener("keydown", (e) => {
  // Up/Down walk what you have already spawned, shell style. Only from the very start (Up) or the very
  // end (Down) of the text, so the arrows still move the caret inside a multi-line prompt.
  if (e.key === "ArrowUp" && !e.shiftKey) {
    const box = e.target;
    // A single-line prompt walks history from anywhere (that is shell behaviour, and the caret sits at
    // the END after typing). A multi-line prompt only walks when the caret is already at the start, so
    // Up still moves between its lines first.
    const singleLine = !String(box.value).includes("\n");
    const atStart = box.selectionStart === 0 && box.selectionEnd === 0;
    if ((singleLine && box.selectionStart === box.selectionEnd) || atStart || !box.value) {
      if (recallSpawnPrompt(1)) {
        e.preventDefault();
        return;
      }
    }
  }
  if (e.key === "ArrowDown" && !e.shiftKey) {
    const box = e.target;
    const singleLine = !String(box.value).includes("\n");
    const atEnd = box.selectionStart === box.value.length && box.selectionEnd === box.value.length;
    if ((singleLine && box.selectionStart === box.selectionEnd) || atEnd) {
      if (recallSpawnPrompt(-1)) {
        e.preventDefault();
        return;
      }
    }
  }
  if (e.key !== "Enter") return;
  e.preventDefault();
  e.stopPropagation();
  // Shift+Enter is a newline: a prompt is often more than one line.
  if (e.shiftKey) {
    insertNewlineAtCaret(e.target);
    return;
  }
  if (!$("btn-spawn").disabled) spawnAgent();
});

// Typing ends the history walk, so the next Up starts from whatever is in the box now.
$("job-prompt").addEventListener("input", () => {
  if (state.spawnNav) state.spawnNav = { back: 0, stash: $("job-prompt").value };
});
$("btn-pause").addEventListener("click", () => {
  state.paused = !state.paused;
  $("btn-pause").textContent = state.paused ? "Resume" : "Pause";
  if (state.paused) {
    state.es?.close();
    setStream("paused", "warn");
  } else {
    connect();
    resync();
  }
});

document.addEventListener("click", async (e) => {
  // A click is the reader taking over: stop chasing the box a spawn wanted focused. Clicking inside
  // that agent's own card keeps the target, so reading its output does not undo it.
  if (state.pendingFocus && !e.target.closest(`.job[data-thread="${CSS.escape(state.pendingFocus.thread)}"]`)) {
    state.pendingFocus = null;
  }
  // The context readout right of the model: one click moves the session's ceiling to the next size.
  const ctxPick = e.target.closest?.("[data-context-pick]");
  if (ctxPick) {
    e.preventDefault();
    e.stopPropagation();
    void cycleContext(ctxPick.dataset.contextPick);
    return;
  }
  // Files this agent produced: the button opens the list, a row opens that file in an editor, and
  // the copy button takes the full path. Clicking anywhere else closes the list.
  const artBtn = e.target.closest("[data-artifacts]");
  const insidePop = e.target.closest("[data-artifacts-pop]");
  if (!artBtn && !insidePop) closeArtifactPops();
  if (artBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = artBtn.dataset.artifacts;
    const kind = artBtn.dataset.artifactsKind === "url" ? "url" : "file";
    const pop = document.querySelector(
      `[data-artifacts-pop="${CSS.escape(thread)}"][data-artifacts-kind="${kind}"]`,
    );
    if (pop) {
      const wasHidden = pop.hidden;
      closeArtifactPops();
      pop.hidden = !wasHidden;
      if (!pop.hidden) {
        // Fixed positioning in viewport space: the head is sticky-ish and the list must not be
        // clipped by the card, so it hangs off the button itself. The position is remembered so a
        // repaint can put the list back where the reader left it.
        const r = artBtn.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - 420, r.left));
        const top = r.bottom + 6;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
        state.openArtifacts.set(thread, { left, top, kind });
      }
    }
    return;
  }
  const delTree = e.target.closest("[data-del-tree]");
  if (delTree) {
    e.preventDefault();
    e.stopPropagation();
    const key = delTree.dataset.delTree;
    // Merged and clean: nothing here that main does not already have, so no question.
    if (deletableWithoutAsking(key)) void confirmDeleteWorktree(key);
    else showWorktreeConfirm(key);
    return;
  }
  const renameTree = e.target.closest("[data-rename-tree]");
  if (renameTree) {
    e.preventDefault();
    e.stopPropagation();
    void renameWorktreePrompt(renameTree);
    return;
  }
  // ✦: ask the work what this tree should be called. Nothing is renamed here — the question that comes back is
  // answered on its own buttons, on the release (see answerNameConfirm).
  const nameTree = e.target.closest("[data-name-tree]");
  if (nameTree) {
    e.preventDefault();
    e.stopPropagation();
    void suggestTreeName(nameTree);
    return;
  }
  const nameTreeYes = e.target.closest("[data-name-tree-yes]");
  if (nameTreeYes) {
    e.preventDefault();
    e.stopPropagation();
    answerNameConfirm("yes", nameTreeYes.dataset.nameTreeYes);
    return;
  }
  const nameTreeNo = e.target.closest("[data-name-tree-no]");
  if (nameTreeNo) {
    e.preventDefault();
    e.stopPropagation();
    answerNameConfirm("no", nameTreeNo.dataset.nameTreeNo);
    return;
  }
  const nameTreeEdit = e.target.closest("[data-name-tree-edit]");
  if (nameTreeEdit) {
    e.preventDefault();
    e.stopPropagation();
    answerNameConfirm("edit", nameTreeEdit.dataset.nameTreeEdit);
    return;
  }
  const delTreeYes = e.target.closest("[data-del-tree-yes]");
  if (delTreeYes) {
    e.preventDefault();
    e.stopPropagation();
    answerRowConfirm("yes", delTreeYes.dataset.delTreeYes);
    return;
  }
  const delTreeNo = e.target.closest("[data-del-tree-no]");
  if (delTreeNo) {
    e.preventDefault();
    e.stopPropagation();
    answerRowConfirm("no", delTreeNo.dataset.delTreeNo);
    return;
  }
  const delBtn = e.target.closest("[data-del-artifact]");
  if (delBtn) {
    e.preventDefault();
    e.stopPropagation();
    const key = delBtn.dataset.delArtifact;
    const pop = delBtn.closest("[data-artifacts-pop]");
    const row = delBtn.closest(".ap-row");
    const isUrl = /^https?:\/\//i.test(key);
    if (row) {
      row.innerHTML = `<span class="ap-confirm mono" title="${esc(key)}">Delete ${esc(isUrl ? "this URL from the list" : baseNameOf(key))}?</span>
        <button type="button" class="ap-del-no" data-del-no="${esc(key)}" data-pop="${esc(pop?.dataset.artifactsPop || "")}">cancel</button>
        <button type="button" class="ap-del-yes" data-del-yes="${esc(key)}" data-pop="${esc(pop?.dataset.artifactsPop || "")}">yes, delete</button>`;
    }
    return;
  }
  const delYes = e.target.closest("[data-del-yes]");
  if (delYes) {
    e.preventDefault();
    e.stopPropagation();
    void deleteArtifact(delYes.dataset.pop, delYes.dataset.delYes);
    return;
  }
  const delNo = e.target.closest("[data-del-no]");
  if (delNo) {
    e.preventDefault();
    e.stopPropagation();
    renderArtifactsPop(delNo.dataset.pop);
    return;
  }
  const openUrlBtn = e.target.closest("[data-open-url]");
  if (openUrlBtn) {
    e.preventDefault();
    e.stopPropagation();
    void openArtifactUrl(openUrlBtn.dataset.openUrl);
    return;
  }
  const openBtn = e.target.closest("[data-open-path]");
  if (openBtn) {
    e.preventDefault();
    e.stopPropagation();
    void openArtifact(openBtn.dataset.openPath);
    return;
  }
  const copyBtn = e.target.closest("[data-copy-path]");
  if (copyBtn) {
    e.preventDefault();
    e.stopPropagation();
    void copyText(copyBtn.dataset.copyPath).then((ok) => {
      copyBtn.textContent = ok ? "copied" : "failed";
      copyBtn.classList.toggle("is-copied", ok);
      setTimeout(() => {
        copyBtn.textContent = "copy";
        copyBtn.classList.remove("is-copied");
      }, 1200);
    });
    return;
  }
  const apBtn = e.target.closest("[data-approval-choice]");
  if (apBtn) {
    e.preventDefault();
    e.stopPropagation();
    void answerApproval(apBtn.dataset.approvalId, apBtn.dataset.approvalChoice, apBtn);
    return;
  }
  const plus = e.target.closest(".btn-plus");
  if (plus) {
    e.stopPropagation();
    e.preventDefault();
    focusSpawn(plus.dataset.spawnProject);
    return;
  }
  const rrecent = e.target.closest("[data-root-recent]");
  if (rrecent) {
    e.stopPropagation();
    e.preventDefault();
    toggleRootRecent(rrecent.dataset.rootRecent);
    return;
  }
  const rrename = e.target.closest("[data-rename-root]");
  if (rrename) {
    e.stopPropagation();
    e.preventDefault();
    renameRootLabel(rrename);
    return;
  }
  const rcollapse = e.target.closest("[data-root-collapse]");
  if (rcollapse) {
    e.stopPropagation();
    e.preventDefault();
    toggleAllInRoot(rcollapse.dataset.rootCollapse);
    return;
  }
  const rclone = e.target.closest("[data-root-clone]");
  if (rclone) {
    e.stopPropagation();
    e.preventDefault();
    const root = rclone.dataset.rootClone;
    const form = document.querySelector(`[data-clone-form="${CSS.escape(root)}"]`);
    showCloneForm(root, form ? form.hidden : true); // the "+" toggles the row
    return;
  }
  const rgo = e.target.closest("[data-clone-go]");
  if (rgo) {
    e.stopPropagation();
    e.preventDefault();
    void cloneIntoRoot(rgo.dataset.cloneGo);
    return;
  }
  // The clear button inside the folder search box: restore the full list and put the caret back.
  const searchClear = e.target.closest?.("[data-root-search-clear]");
  if (searchClear) {
    e.preventDefault();
    e.stopPropagation();
    const root = searchClear.dataset.rootSearchClear;
    const box = document.querySelector(`[data-root-search="${CSS.escape(root)}"]`);
    if (box) {
      box.value = "";
      box.focus();
    }
    setRootFilter(root, "");
    return;
  }
  // The search box lives in the folder head; a click in it is the reader typing, not a request to fold
  // the folder under the caret.
  if (e.target.closest?.(".root-filter")) return;
  const rhead = e.target.closest(".root-head[data-toggle-root]");
  if (rhead) {
    const root = rhead.dataset.toggleRoot;
    keepInPlace(() => document.querySelector(`.root-head[data-toggle-root="${CSS.escape(root)}"]`), () => toggleRoot(root));
    return;
  }
  // The project's panel chip is a button only while something is running: jump to that agent instead of
  // toggling the project the chip sits in.
  const panelJump = e.target.closest("[data-jump-panel]");
  if (panelJump) {
    e.preventDefault();
    e.stopPropagation();
    jumpToPanelAgent(panelJump.dataset.jumpPanel, { running: panelJump.dataset.jumpRunning === "1" });
    return;
  }
  const phead = e.target.closest(".project-head[data-toggle-project]");
  if (phead) {
    const name = phead.dataset.toggleProject;
    // Ctrl+click themes the box instead of folding it, so a colour is one gesture away and cannot be
    // mistaken for the open/close click. Shift drops the colour again.
    if ((e.ctrlKey || e.metaKey) && !e.target.closest("button, input, select, textarea, a, label")) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        state.projectHues.delete(name);
        saveProjectHues();
        applyProjectHue(name);
        showBanner(`${name}: colour cleared`);
      } else {
        const hue = rollProjectHue(name);
        applyProjectHue(name);
        showBanner(`${name}: themed hue ${hue}° — Ctrl+click again for another, Ctrl+Shift+click to clear`);
      }
      return;
    }
    keepInPlace(() => document.querySelector(`.project-head[data-toggle-project="${CSS.escape(name)}"]`), () => toggleProject(name));
    return;
  }
  // The fixed cards (New agent / Agents): the title row collapses them, but their own controls
  // (Minimize all, Clear finished, the chips) must keep working.
  const fixedHead = e.target.closest("[data-toggle-fixed]");
  if (fixedHead) {
    if (e.target.closest("button, input, select, textarea, a, label")) return;
    e.preventDefault();
    const id = fixedHead.dataset.toggleFixed;
    keepInPlace(() => document.querySelector(`[data-toggle-fixed="${CSS.escape(id)}"]`), () => toggleFixed(id));
    return;
  }
  // The row's green ▶: probe every NOT-RUNNING agent in that worktree with the continue sentence.
  const rowAgent = e.target.closest(".btn-row-agent");
  if (rowAgent) {
    e.stopPropagation();
    e.preventDefault();
    void probeWorktreeAgents(rowAgent.dataset.agentPath || "", rowAgent);
    return;
  }
  // The + bar under a row's agents: start a new agent in this worktree. This is what the ▶ used to do.
  // The green + bar: it becomes a text field in place. The field itself carries the same data attributes, so this
  // matches the button only - a click inside the input must not re-open it.
  const addAgent = e.target.closest("button.btn-add-agent");
  if (addAgent) {
    e.stopPropagation();
    e.preventDefault();
    openAddAgent(addAgent);
    return;
  }
  // The row's agent badge: open the row so the agents block is visible.
  const openRowBtn = e.target.closest("[data-open-row]");
  if (openRowBtn) {
    e.stopPropagation();
    e.preventDefault();
    openAgentsBlock(openRowBtn.dataset.openRow);
    return;
  }
  // "revive" on a session the row reports but that has no card: ask the server to rebuild one.
  const reviveBtn = e.target.closest("[data-revive-session]");
  if (reviveBtn) {
    e.stopPropagation();
    e.preventDefault();
    void reviveSession(reviveBtn);
    return;
  }
  // The dock's own fold control.
  const dockFold = e.target.closest("#btn-dock-approvals");
  if (dockFold) {
    e.preventDefault();
    e.stopPropagation();
    try {
      localStorage.setItem(APPROVALS_FOLDED_KEY, approvalsFolded() ? "0" : "1");
    } catch {
      /* private mode: the fold still works, it just does not survive a reload */
    }
    applyApprovalsFold();
    return;
  }
  // "waiting on your answer →" on an agent card: take the reader to the question box in that card, unfolding
  // the card first if they had minimised it (a folded card renders no turn body, so there is nothing to jump to).
  const qJump = e.target.closest("[data-question-jump]");
  if (qJump) {
    e.preventDefault();
    e.stopPropagation();
    const thread = qJump.dataset.questionJump;
    if (state.collapsedJobs.has(thread)) {
      state.collapsedJobs.delete(thread);
      renderConversation(thread);
    }
    const box = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] .turn-question`);
    if (box) {
      box.scrollIntoView({ block: "center", behavior: "smooth" });
      box.classList.add("jump");
      setTimeout(() => box.classList.remove("jump"), 1600);
    }
    return;
  }
  // "waiting on you →" on an agent card: take the reader to the approval that is blocking it. The dock is fixed,
  // so this unfolds it and scrolls its own list — scrollIntoView on a fixed element only moves the page.
  const apJump = e.target.closest("[data-approval-jump]");
  if (apJump) {
    e.preventDefault();
    e.stopPropagation();
    const dock = $("approvals");
    try {
      localStorage.setItem(APPROVALS_FOLDED_KEY, "0");
    } catch {
      /* the jump still happens */
    }
    applyApprovalsFold(dock);
    const card = document.querySelector(`.approval[data-approval="${CSS.escape(apJump.dataset.approvalJump)}"]`);
    if (card) {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      card.classList.add("jump");
      setTimeout(() => card.classList.remove("jump"), 1600);
    }
    return;
  }
  // The approval card's "⧉ agent": jump to the agent that is blocked (works outside #projects too).
  const apAgent = e.target.closest(".approval [data-agent-thread]");
  if (apAgent) {
    e.preventDefault();
    jumpToAgent(apAgent.dataset.agentThread);
    return;
  }
  const replyBtn = e.target.closest(".btn-reply");
  if (replyBtn) {
    await sendReply(replyBtn.dataset.thread);
    return;
  }
  // "Pull this chat out": the maximise button sits inside the head, so it must not also toggle
  // the card's collapse state.
  const maxBtn = e.target.closest("[data-max-thread]");
  if (maxBtn) {
    e.preventDefault();
    e.stopPropagation();
    setMaximized(maxBtn.dataset.maxThread);
    return;
  }
  const clearBtn = e.target.closest("[data-clear-thread]");
  if (clearBtn) {
    e.preventDefault();
    e.stopPropagation();
    await clearThread(clearBtn);
    return;
  }
  const renameBtn = e.target.closest("[data-rename-thread]");
  if (renameBtn) {
    e.preventDefault();
    e.stopPropagation();
    beginRename(renameBtn.dataset.renameThread);
    return;
  }
  // "attach": if the agent's own directory is a worktree we know, attach it there straight away;
  // only ask which one when there is no obvious answer.
  const attachToggle = e.target.closest("[data-attach-toggle]");
  if (attachToggle) {
    e.preventDefault();
    e.stopPropagation();
    const thread = attachToggle.dataset.attachToggle;
    const conv = conversations().find((c) => c.thread === thread);
    const cwd = conv ? conv.latest.cwd || conv.first.cwd || "" : "";
    const match = matchWorktree(cwd);
    if (match) {
      const ok = await attachAgent(thread, match.path);
      if (ok) showNote(`attached to ${match.project} · ${match.name}`);
      return;
    }
    const row = document.querySelector(`[data-attach-row="${CSS.escape(thread)}"]`);
    if (row) {
      // A minimized card would show a dropdown hanging off a one-liner; unfold it first so the
      // picker has context, then reveal it on the rebuilt card.
      const card = attachToggle.closest(".job");
      const minimized = Boolean(card && card.classList.contains("collapsed"));
      if (minimized) {
        state.collapsedJobs.delete(thread);
        saveCollapsedJobs();
        renderConversation(thread);
      }
      const fresh = document.querySelector(`[data-attach-row="${CSS.escape(thread)}"]`);
      if (fresh) fresh.hidden = false;
      if (fresh) {
        // Built on demand: the card may be rendered before any worktree row exists.
        const sel = fresh.querySelector("select");
        if (sel && !sel.options.length) sel.innerHTML = worktreeOptionsHtml();
        // Start from the agent's current owner when the scan does not show it, so "attach" is a
        // deliberate re-point rather than a silent move to whatever the list happens to start with.
        const owner = conv && (conv.latest.ownerPath || conv.first.ownerPath);
        if (sel && owner) {
          const hit = [...sel.options].find((o) => o.value.toLowerCase() === String(owner).toLowerCase());
          if (hit) sel.value = hit.value;
        }
        sel?.focus();
      }
    }
    return;
  }
  const attachGo = e.target.closest("[data-attach-go]");
  if (attachGo) {
    e.preventDefault();
    e.stopPropagation();
    await attachAgent(attachGo.dataset.attachGo);
    return;
  }
  // A turn folds on its own: the head row or the one-line request opens/closes that turn,
  // independently of the conversation card it sits in.
  // Star a turn: it also shows, still accordionable, in the pinned block above the paged turns.
  const starBtn = e.target.closest("[data-star-turn]");
  if (starBtn) {
    e.preventDefault();
    e.stopPropagation();
    const id = starBtn.dataset.starTurn;
    const job = state.jobs.get(id);
    if (state.pinnedTurns.has(id)) state.pinnedTurns.delete(id);
    else state.pinnedTurns.add(id);
    const thread = job ? job.thread || job.id : null;
    if (thread) {
      // Pinning inserts a block above the page, so the star just clicked would slide down out from
      // under the pointer (and a second click to undo would land somewhere else). Anchor on the PAGE
      // copy of that star (the pinned one is a different element at a different place), then scroll
      // by however far it moved so it stays where the cursor is.
      const pageStar = findTurnStar(thread, id);
      const beforeTop = pageStar ? pageStar.getBoundingClientRect().top : null;
      renderConversation(thread);
      // Correct, then correct again once the browser has settled layout: inserting the pinned block
      // changes the page height in two passes (the card now, its line boxes at the next layout), so a
      // single correction leaves the star short of where it started.
      const keepStarPut = () => {
        const anchor = findTurnStar(thread, id);
        if (beforeTop == null || !anchor) return;
        const delta = anchor.getBoundingClientRect().top - beforeTop;
        if (Math.abs(delta) > 1) window.scrollBy(0, delta);
      };
      // Now, then once layout has definitely settled: inserting the pinned block can change the page
      // height again on the next layout pass (line boxes, images), which would leave the star adrift.
      keepStarPut();
      setTimeout(keepStarPut, 0);
      setTimeout(keepStarPut, 80);
    }
    return;
  }
  // Liveness evidence folds in place; collapsed, the strongest line rides to the right of the header.
  const liveToggle = e.target.closest("[data-toggle-live]");
  if (liveToggle) {
    e.preventDefault();
    e.stopPropagation();
    const key = liveToggle.dataset.toggleLive;
    const block = document.querySelector(`[data-live-block="${CSS.escape(key)}"]`);
    if (block) {
      const open = state.liveOpen.has(key);
      if (open) state.liveOpen.delete(key);
      else state.liveOpen.add(key);
      block.classList.toggle("collapsed", open);
      const chev = liveToggle.querySelector(".chev");
      if (chev) chev.textContent = open ? "\u25b8" : "\u25be";
      let first = liveToggle.querySelector(".live-first");
      const firstLine = block.querySelector("ul li");
      if (open) {
        if (!first && firstLine) {
          first = document.createElement("span");
          first.className = "live-first mono";
          first.textContent = firstLine.textContent;
          first.title = firstLine.textContent;
          liveToggle.appendChild(first);
        }
      } else if (first) {
        first.remove();
      }
      liveToggle.title = `${open ? "unfold" : "fold"} the liveness evidence`;
    }
    return;
  }
  // The git / commit / diff accordion inside a worktree's detail row: fold and unfold in place, so
  // nothing else in the row (agent cards, scroll positions) is rebuilt.
  const gitToggle = e.target.closest("[data-toggle-git]");
  if (gitToggle) {
    e.preventDefault();
    e.stopPropagation();
    const key = gitToggle.dataset.toggleGit;
    const block = document.querySelector(`[data-git-block="${CSS.escape(key)}"]`);
    if (block) {
      const open = state.gitOpen.has(key);
      if (open) state.gitOpen.delete(key);
      else state.gitOpen.add(key);
      block.classList.toggle("collapsed", open);
      const chev = gitToggle.querySelector(".chev");
      if (chev) chev.textContent = open ? "\u25b8" : "\u25be";
      gitToggle.title = `${open ? "unfold" : "fold"} the git, commit and diff detail`;
    }
    return;
  }
  const turnToggle = e.target.closest("[data-toggle-turn]");
  if (turnToggle) {
    e.preventDefault();
    const id = turnToggle.dataset.toggleTurn;
    keepInPlace(() => document.querySelector(`[data-turn-head="${CSS.escape(id)}"]`), () => toggleTurn(id));
    return;
  }
  // Turn pagination: the arrows sit in the card head, next to the turn count.
  const pageBtn = e.target.closest("[data-turn-page]");
  if (pageBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = pageBtn.dataset.threadPage;
    const conv = conversations().find((c) => c.thread === thread);
    if (conv) {
      const pages = Math.max(1, Math.ceil(conv.turns.length / TURNS_PER_PAGE));
      const cur = turnPageOffset(thread, conv.turns.length);
      const next = pageBtn.dataset.turnPage === "older" ? Math.min(pages - 1, cur + 1) : Math.max(0, cur - 1);
      if (next === 0) state.turnPage.delete(thread);
      else state.turnPage.set(thread, next);
      renderConversation(thread);
    }
    return;
  }
  // A click on anything interactive inside the head belongs to that control, never to the fold:
  // attach, clear, maximize, cancel, the attach picker and its select all live in the head row.
  // The not-running pill on a stopped card, which is the continue button: send the canned nudge and start the next
  // turn. It is a <button>, so the fold handler below would leave it alone anyway - this stops the click at the
  // control even if the pill is later drawn as something else.
  const continueBtn = e.target.closest("[data-continue-thread]");
  if (continueBtn) {
    e.preventDefault();
    e.stopPropagation();
    void continueThread(continueBtn.dataset.continueThread || "", continueBtn);
    return;
  }
  const head = e.target.closest(".job-head");
  // A minimized card is one row plus its preview line, and both are the handle: clicking the preview (or
  // any empty part of the row) expands it. Buttons inside the head keep their own behaviour, and an open
  // card is only folded by its head — its body is full of things to click.
  const foldedCard = e.target.closest(".job.collapsed");
  if (
    (head || foldedCard) &&
    !e.target.closest("button, a, input, select, textarea, label, [data-attach-row], [data-toggle-turn]")
  ) {
    const id = head ? head.dataset.toggle : foldedCard.dataset.thread;
    keepInPlace(() => document.querySelector(`.job[data-thread="${CSS.escape(id)}"] .job-head`), () => toggleJob(id));
    return;
  }
  // Queue reply: hold the text (do not send) because a turn is running on this thread.
  const queueBtn = e.target.closest("[data-queue-reply]");
  if (queueBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = queueBtn.dataset.queueReply;
    const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    const text = (box?.value || "").trim();
    if (!text) {
      if (box) box.focus();
      return;
    }
    // Clear the draft first: queueReply rebuilds the card, and the rebuild would put the text back
    // into the new box from the saved draft.
    state.replyDrafts[thread] = "";
    if (box) box.value = "";
    queueReply(thread, text);
    document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`)?.focus();
    return;
  }
  // Answer an approval a run is parked on. The buttons come from the host's own choice list.
  const approveBtn = e.target.closest("[data-approve]");
  if (approveBtn) {
    e.preventDefault();
    e.stopPropagation();
    void answerRunApproval(approveBtn);
    return;
  }
  // Send what the question box holds: a typed answer wins (that is the tool's "Other"), otherwise the
  // ticked choices go back as one array — the clarify tool decodes it as a multi-select answer.
  const qSend = e.target.closest("[data-qsend]");
  if (qSend) {
    e.preventDefault();
    e.stopPropagation();
    const turnId = qSend.dataset.qsend;
    const copy = qSend.dataset.qcopy || "";
    const box = qSend.closest(".turn-question");
    const typed = (box?.querySelector(".tq-other")?.value || "").trim();
    if (typed) {
      void answerRunQuestion(turnId, typed, qSend.dataset.qrequest, box);
      return;
    }
    const labels = [...(box?.querySelectorAll(".tq-choice[data-qvalue]") || [])].map((el) => el.dataset.qvalue);
    const picked = [...(questionPicks.get(`${turnId}${copy}`) || new Set())].sort((a, b) => a - b).map((i) => labels[i]).filter(Boolean);
    if (!picked.length) {
      const warn = box?.querySelector("[data-qwarn]");
      if (warn) warn.textContent = "pick an answer, or type one";
      return;
    }
    void answerRunQuestion(turnId, picked, qSend.dataset.qrequest, box);
    return;
  }
  // The "+ N commands" tail of a batch: before the row handler, because the button lives inside that row.
  const batchBtn = e.target.closest("[data-batch-tool]");
  if (batchBtn) {
    e.preventDefault();
    e.stopPropagation();
    void loadBatchCalls(batchBtn);
    return;
  }
  // Steer the turn that is running: the primary action while the agent is busy.
  const tgrpRow = e.target.closest("[data-tgrp-tool]");
  if (tgrpRow) {
    e.preventDefault();
    e.stopPropagation();
    const grp = tgrpRow.closest(".tgrp");
    if (grp) {
      const tool = tgrpRow.dataset.tgrpTool;
      const active = grp.dataset.filter === tool;
      const key = grp.dataset.tgrp || "";
      // Read the identity and the console BEFORE the rebuild: `grp` is detached by it, and a turn drawn twice (the
      // pinned card and its paged copy) shares every key — the lookup has to stay in the console the reader clicked.
      const gstate = grp.dataset.gstate || "";
      const scope = grp.closest("pre.job-out") || document;
      rebuildToolGroup(grp, { filter: active ? "" : tool, open: !active });
      if (!active) {
        // Opening a call asks for its stored output: the live stream's preview for this tool is routinely empty,
        // and a bare "↳ patch" header is exactly the report.
        const fresh = scope.querySelector(`.tgrp[data-gstate="${CSS.escape(gstate)}"]`);
        void ensureToolStore(String(key).split("#")[0], tool, fresh);
      }
    }
    return;
  }
  const tgrpMore = e.target.closest("[data-tgrp-more]");
  if (tgrpMore) {
    e.preventDefault();
    e.stopPropagation();
    const grp = tgrpMore.closest(".tgrp");
    if (grp) {
      // "all N" while one tool is being shown clears the filter; otherwise it just folds the block.
      const filtered = Boolean(grp.dataset.filter);
      const bodyEl = grp.querySelector(".tgrp-body");
      const open = filtered || Boolean(bodyEl && bodyEl.hidden);
      const gstate = grp.dataset.gstate || "";
      const turnId = String(grp.dataset.tgrp || "").split("#")[0];
      const scope = grp.closest("pre.job-out") || document;
      rebuildToolGroup(grp, { filter: "", open });
      // Opening the whole run asks every tool's store, not only the one that was filtered: the reader opened this
      // to read what the calls returned.
      if (open) {
        const fresh = scope.querySelector(`.tgrp[data-gstate="${CSS.escape(gstate)}"]`);
        if (fresh) for (const r of toolBurstRows(groupLines(fresh))) void ensureToolStore(turnId, r.name, fresh);
      }
    }
    return;
  }
  const toBottom = e.target.closest("[data-to-bottom]");
  if (toBottom) {
    e.preventDefault();
    e.stopPropagation();
    const box = toBottom.closest(".out-wrap")?.querySelector("pre.job-out, .think-body");
    if (box) {
      // Ask for the tail explicitly: the jump is the reader's, so the console must stop holding its old
      // position and follow the newest line again.
      if (box.matches("pre.job-out")) pinConsole(box.dataset.out);
      else state.thinkPinned.set(box.closest("details.think")?.dataset.thinkTurn || "", true);
      setScroll(box, box.scrollHeight);
      paintToBottom(box);
    }
    return;
  }
  const pinBtn = e.target.closest("[data-pin-thread]");
  if (pinBtn) {
    e.preventDefault();
    e.stopPropagation();
    toggleAnchorPin(pinBtn.dataset.pinThread);
    return;
  }
  const thinkBtn = e.target.closest("[data-think-thread]");
  if (thinkBtn) {
    e.preventDefault();
    e.stopPropagation();
    const thread = thinkBtn.dataset.thinkThread;
    setThinking(thread, !thinkingOn(thread));
    return;
  }
  const subsCollect = e.target.closest("[data-subs-collect]");
  if (subsCollect) {
    e.preventDefault();
    e.stopPropagation();
    const turn = [...state.jobs.values()].find((j) => j.id === subsCollect.dataset.subsCollect);
    if (turn) void collectThread(turn);
    return;
  }
  const subsHead = e.target.closest("[data-subs-toggle]");
  if (subsHead) {
    e.preventDefault();
    e.stopPropagation();
    toggleSubs(subsHead.dataset.subsToggle);
    return;
  }
  const subRow = e.target.closest("[data-sub-console]");
  if (subRow) {
    e.preventDefault();
    e.stopPropagation();
    await toggleSubConsole(subRow.dataset.subConsole);
    return;
  }
  const steerBtn = e.target.closest("[data-steer]");
  if (steerBtn) {
    e.preventDefault();
    e.stopPropagation();
    const card = steerBtn.closest(".job");
    const thread = card?.dataset.thread || "";
    const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    await steerTurn(thread, steerBtn.dataset.steer, box?.value || "", steerBtn);
    return;
  }
  const btn = e.target.closest(".btn-cancel");
  if (!btn) return;
  btn.disabled = true;
  try {
    await apiFetch("/api/jobs/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: btn.dataset.id }) });
  } catch {
    btn.disabled = false;
  }
});

// Reply affordances are re-created on every render, so they are handled at document level.
// Double-click, on its own listener: a single click on the readout must stay a single click.
document.addEventListener("dblclick", (e) => {
  const btn = e.target.closest?.("[data-model-pick]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  void openModelPop(btn.dataset.modelPick, btn);
});

// The reply and spawn boxes grow a line at a time as the draft gets longer.
document.addEventListener("input", (e) => {
  const box = e.target?.closest?.(".reply-box, #job-prompt");
  if (box) growReplyBox(box);
});

// A narrower window means fewer characters per line and more wrapped lines: re-measure what has content.
window.addEventListener("resize", () => {
  for (const box of document.querySelectorAll(".reply-box, #job-prompt")) {
    if (box.value) growBoxToDraft(box, box.id === "job-prompt" ? SPAWN_MAX_LINES : REPLY_MAX_LINES);
  }
});

// Typing in a folder's search box filters that folder in place: no re-render, so the caret and the
// hidden projects' open state survive. Escape clears it and gives the keyboard back to the page.
document.addEventListener("input", (e) => {
  const box = e.target.closest?.("[data-root-search]");
  if (!box) return;
  setRootFilter(box.dataset.rootSearch, box.value);
});
document.addEventListener(
  "keydown",
  (e) => {
    const box = e.target.closest?.("[data-root-search]");
    if (!box) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const root = box.dataset.rootSearch;
      box.value = "";
      setRootFilter(root, "");
      box.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      box.blur();
    }
  },
  true,
);

// The context readout is a one-click control: each click moves to the next size in the ladder. The full list
// (and a typed size) is still there on right-click, which no ordinary click can trigger by accident.
document.addEventListener("contextmenu", (e) => {
  const ctx = e.target.closest?.("[data-context-pick]");
  if (!ctx) return;
  e.preventDefault();
  e.stopPropagation();
  void openContextPop(ctx.dataset.contextPick, ctx);
});

// Clicking anywhere else, or scrolling the board, closes the model list.
document.addEventListener(
  "mousedown",
  (e) => {
    if (!modelPop || modelPop.contains(e.target) || e.target.closest?.("[data-model-pick],[data-context-pick]")) return;
    closeModelPop();
  },
  true,
);
// A console sticking to its newest line scrolls constantly, and that is not the reader moving the page - only a
// scroll of the page itself puts the anchor somewhere else, so only that closes the list.
window.addEventListener(
  "scroll",
  (e) => {
    if (e.target === document) positionModelPop();
  },
  true,
);
window.addEventListener("resize", () => positionModelPop());

// A subagent line is focusable, so Enter or Space has to do what a click does.
document.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const batchKey = e.target.closest?.("[data-batch-tool]");
  if (batchKey) {
    e.preventDefault();
    void loadBatchCalls(batchKey);
    return;
  }
  const tgrpRow = e.target.closest?.("[data-tgrp-tool]");
  if (tgrpRow) {
    e.preventDefault();
    const grp = tgrpRow.closest(".tgrp");
    if (grp) {
      const tool = tgrpRow.dataset.tgrpTool;
      const active = grp.dataset.filter === tool;
      const key = grp.dataset.tgrp || "";
      // Read the identity and the console BEFORE the rebuild: `grp` is detached by it, and a turn drawn twice (the
      // pinned card and its paged copy) shares every key — the lookup has to stay in the console the reader clicked.
      const gstate = grp.dataset.gstate || "";
      const scope = grp.closest("pre.job-out") || document;
      rebuildToolGroup(grp, { filter: active ? "" : tool, open: !active });
      if (!active) {
        // Opening a call asks for its stored output: the live stream's preview for this tool is routinely empty,
        // and a bare "↳ patch" header is exactly the report.
        const fresh = scope.querySelector(`.tgrp[data-gstate="${CSS.escape(gstate)}"]`);
        void ensureToolStore(String(key).split("#")[0], tool, fresh);
      }
    }
    return;
  }
  const head = e.target.closest?.("[data-subs-toggle]");
  if (head) {
    e.preventDefault();
    toggleSubs(head.dataset.subsToggle);
    return;
  }
  const row = e.target.closest?.("[data-sub-console]");
  if (!row) return;
  e.preventDefault();
  await toggleSubConsole(row.dataset.subConsole);
});

document.addEventListener("keydown", async (e) => {
  // Any key means the reader is working: stop chasing a spawn's reply box (Esc is exempt — it closes
  // things and never means "I am typing").
  if (state.pendingFocus && e.key !== "Escape") state.pendingFocus = null;
  // Esc closes the produced-files list first; a second Esc does whatever Esc did before.
  if (e.key === "Escape" && document.querySelector("[data-artifacts-pop]:not([hidden])")) {
    closeArtifactPops();
  }
  // Esc puts a pulled-out chat back; nothing else in the page holds that key.
  if (e.key === "Escape" && !$("settings").classList.contains("hidden")) {
    e.preventDefault();
    toggleSettings(false);
    return;
  }
  if (e.key === "Escape" && state.maximized) {
    e.preventDefault();
    setMaximized(null);
    return;
  }
  // The folder clone input: Enter clones, Escape closes the row.
  const cloneInput = e.target.closest && e.target.closest("[data-clone-input]");
  if (cloneInput) {
    if (e.key === "Enter") {
      e.preventDefault();
      void cloneIntoRoot(cloneInput.dataset.cloneInput);
    } else if (e.key === "Escape") {
      e.preventDefault();
      showCloneForm(cloneInput.dataset.cloneInput, false);
    }
    return;
  }
  const box = e.target.closest && e.target.closest(".reply-box");
  if (!box) return;
  // Up/Down walk the thread's previous prompts, shell style: only from the very start (Up) or the very
  // end (Down) of the text, so the arrows still move the caret inside a multi-line reply.
  // A box still showing a recalled entry keeps walking, with the caret wherever the recall left it; a box the
  // reader has typed into only steps at the very start (Up) or the very end (Down), so the arrows stay usable
  // inside a multi-line reply.
  const nav = state.replyNav.get(box.dataset.reply);
  const recalled = Boolean(nav && nav.back > 0 && box.value === nav.current);
  const atStart = box.selectionStart === 0 && box.selectionEnd === 0;
  const atEnd = box.selectionStart === box.value.length && box.selectionEnd === box.value.length;
  if (e.key === "ArrowUp" && !e.shiftKey && (atStart || (recalled && atEnd))) {
    e.preventDefault();
    recallReply(box, 1);
    return;
  }
  if (e.key === "ArrowDown" && !e.shiftKey && (atEnd || (recalled && atStart))) {
    e.preventDefault();
    recallReply(box, -1);
    return;
  }
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    insertNewlineAtCaret(box);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const thread = box.dataset.reply;
    const text = (box.value || "").trim();
    // While a turn is running, the primary action IS steering: the text goes into the live turn
    // rather than bouncing off a busy agent. Queue reply is the explicit "next turn" button.
    if (threadBusy(thread)) {
      if (!text) return;
      const running = [...state.jobs.values()].find(
        (j) => (j.thread || j.id) === thread && (turnLive(j)),
      );
      if (running) {
        await steerTurn(thread, running.id, text);
        return;
      }
    }
    void sendReply(thread);
    if (state.hot.on) hotAfterSend(thread);
  }
});
// A press on the merge chip is remembered until the release: the verdict cell above is rebuilt on every scan.
document.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest && e.target.closest(".merge-start[data-merge-start]");
  mergePress = btn ? { key: btn.dataset.mergeStart, at: Date.now() } : null;
});

// Answering an approval happens on pointerup, not on click: a repaint between the press and the release replaces
// the button, and the browser then delivers no click at all. The choices are explicit buttons, so the release is
// the decision; `approvalSent` makes the click that sometimes still follows a no-op.
document.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  const panelBtn = e.target.closest && e.target.closest("[data-approval-choice]");
  if (panelBtn) {
    e.preventDefault();
    void answerApproval(panelBtn.dataset.approvalId, panelBtn.dataset.approvalChoice, panelBtn);
    return;
  }
  const runBtn = e.target.closest && e.target.closest("[data-approve]");
  if (runBtn) {
    e.preventDefault();
    void answerRunApproval(runBtn);
    return;
  }
  // A choice in the agent's question is the same kind of decision: answered on the release, so a repaint
  // between press and release cannot swallow it the way it swallows a click.
  const qChoice = e.target.closest && e.target.closest("[data-qanswer]");
  if (qChoice) {
    e.preventDefault();
    void answerRunQuestion(qChoice.dataset.qanswer, qChoice.dataset.qvalue, qChoice.dataset.qrequest, qChoice.closest(".turn-question"));
  }
  // Cancel/Delete on a worktree confirmation: the same failure as the approval buttons. The board re-ranks
  // the table under the cursor, a repaint replaces the button, and the click is never delivered - the reader
  // clicks Delete and nothing happens. Read at release, matched by data attribute, so a rebuilt button counts.
  const delConfirm = e.target.closest && e.target.closest("[data-del-tree-yes], [data-del-tree-no]");
  if (delConfirm) {
    e.preventDefault();
    answerRowConfirm(delConfirm.dataset.delTreeYes ? "yes" : "no", delConfirm.dataset.delTreeYes || delConfirm.dataset.delTreeNo);
    return;
  }
  // Cancel / ✎ / "Name it" on a naming question: the same swallowed-click failure, and the same answer — read at
  // the release, matched by data attribute, so a button the board rebuilt mid-press still counts.
  const nameConfirm = e.target.closest && e.target.closest("[data-name-tree-yes], [data-name-tree-no], [data-name-tree-edit]");
  if (nameConfirm) {
    e.preventDefault();
    const action = nameConfirm.dataset.nameTreeYes ? "yes" : nameConfirm.dataset.nameTreeEdit ? "edit" : "no";
    answerNameConfirm(action, nameConfirm.dataset.nameTreeYes || nameConfirm.dataset.nameTreeEdit || nameConfirm.dataset.nameTreeNo);
    return;
  }
  // The UNMERGED chip starts a merge agent - the same swallowed-click failure as the buttons above, on the busiest
  // table in the panel. Taken here, matched on the row rather than on the node: a scan repaint that replaces the
  // button mid-press lands the release on the cell it rebuilt, and the key recorded at press still names the row.
  const mergeBtn = e.target.closest && e.target.closest(".merge-start[data-merge-start]");
  if (mergeBtn && !mergeBtn.disabled) {
    e.preventDefault();
    mergePress = null;
    void startMerge(mergeBtn);
    return;
  }
  const pressed = mergePress;
  mergePress = null;
  if (pressed && Date.now() - pressed.at < 2000 && e.target.closest?.("td.verdict")) {
    const built = document.querySelector(`[data-merge-start="${CSS.escape(pressed.key)}"]`);
    if (built && !built.disabled && built.closest("tr.row")?.dataset.key === pressed.key) {
      e.preventDefault();
      void startMerge(built);
    }
  }
});

// Multi-select ticks and a typed answer are the reader's scratch state until they send: keep them where a
// repaint of the card will find them again.
document.addEventListener("change", (e) => {
  const pick = e.target.closest && e.target.closest("[data-qpick]");
  if (!pick) return;
  const key = `${pick.dataset.qturn}${pick.dataset.qcopy}`;
  const set = questionPicks.get(key) || new Set();
  if (pick.checked) set.add(Number(pick.dataset.qindex));
  else set.delete(Number(pick.dataset.qindex));
  questionPicks.set(key, set);
  pick.closest(".tq-choice")?.classList.toggle("on", pick.checked);
});

document.addEventListener("input", (e) => {
  const box = e.target.closest && e.target.closest(".tq-other");
  if (!box) return;
  questionDrafts.set(`${box.dataset.qother}${box.dataset.qcopy}`, box.value);
});

// Enter sends a typed answer, Shift+Enter adds a line: the same rule as the reply box, because this is a
// box the reader types a sentence into.
document.addEventListener("keydown", (e) => {
  const box = e.target.closest && e.target.closest(".tq-other");
  if (!box || e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  box.closest(".turn-question")?.querySelector("[data-qsend]")?.click();
});

document.addEventListener("input", (e) => {
  const box = e.target.closest && e.target.closest(".reply-box");
  if (!box) return;
  const thread = box.dataset.reply;
  state.replyDrafts[thread] = box.value;
  // Editing a recalled prompt ends the walk: what is in the box is now the reader's draft, and the next Up
  // should start from the newest prompt again rather than from wherever the recall had got to.
  const nav = state.replyNav.get(thread);
  if (nav && nav.current !== undefined && box.value !== nav.current) {
    state.replyNav.set(thread, { back: 0, stash: box.value });
  }
  const sent = state.justSent.get(thread);
  if (sent && box.value.trim() !== sent.text) state.justSent.delete(thread);
});

// A link in agent output is opened by the panel, not by navigating: capture phase, so the row and agent
// fold handlers never see the click.
document.addEventListener(
  "click",
  (e) => {
    const link = e.target.closest && e.target.closest("a.out-link");
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    void openInBrowser(link.dataset.openUrl || link.getAttribute("href") || "");
  },
  true,
);

// Pressing Send must not steal focus from the box it is sending: without this the mousedown moves the
// caret to the button and the next keystroke goes nowhere.
document.addEventListener("mousedown", (e) => {
  const btn = e.target.closest && e.target.closest(".btn-reply");
  if (btn) e.preventDefault();
});

// Folding a project throws its console markup away, so where you had scrolled has to be remembered by
// turn rather than by node — otherwise it comes back at the top. Capture phase: scroll does not bubble.
document.addEventListener(
  "scroll",
  (e) => {
    const pre = e.target;
    // The "to the newest line" chip follows the scroll as it happens, not on the 400ms sweep: the reader should
    // see it the moment they take the console over. This also runs for the panel's own scrolls, which is right -
    // a chip that is shown or hidden has no effect on where anything sits.
    if (pre && pre.classList && (pre.classList.contains("job-out") || pre.classList.contains("think-body"))) {
      paintToBottom(pre);
    }
    if (pre && pre.classList && pre.classList.contains("think-body")) {
      const key = pre.closest("details.think")?.dataset.thinkTurn || "";
      if (selfScrolled.has(pre) || justPlaced(pre)) {
        selfScrolled.delete(pre);
        return;
      }
      if (Date.now() - lastInputAt < 1200) {
        state.thinkPinned.set(key, pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24);
        // Kept for the next repaint: the block is replaced whenever its text is re-read, and this is where the
        // reader was when they took it over.
        state.thinkScroll.set(key, { top: pre.scrollTop });
      }
      return;
    }
    if (pre && pre.classList && pre.classList.contains("sub-console")) {
      const id = pre.dataset.subConsoleBox || "";
      if (selfScrolled.has(pre) || justPlaced(pre)) {
        selfScrolled.delete(pre);
        return;
      }
      if (Date.now() - lastInputAt < 1200) {
        state.subConsolePinned.set(id, pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24);
      }
      return;
    }
    if (!pre || pre.tagName !== "PRE" || !pre.classList || !pre.classList.contains("job-out") || !pre.dataset.out) return;
    // A scroll the panel caused itself (restoring a position, following new lines) is not the reader leaving the
    // bottom, so it must not unpin the console.
    if (selfScrolled.has(pre) || justPlaced(pre)) {
      selfScrolled.delete(pre);
      return;
    }
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 32;
    // Only a reader's own input decides the pin. Without this, a clamp that happens while a card is rebuilt looks
    // exactly like someone scrolling up, and the console sticks at the top until they notice.
    if (Date.now() - lastInputAt < 1200) state.outPinned[pre.dataset.out] = atBottom;
    state.outScrolls[pre.dataset.out] = { top: pre.scrollTop, atBottom };
  },
  true,
);

// Whatever moved a pinned console off its newest line - a rebuild, the browser clamping a replaced node, a resize -
// is corrected here within a frame or two. Only pinned consoles are touched, so reading history is never interrupted.
setInterval(() => {
  for (const pre of document.querySelectorAll("pre.job-out")) {
    stickConsole(pre);
    paintToBottom(pre);
  }
  for (const body of document.querySelectorAll(".think-body")) {
    stickThinkBody(body);
    paintToBottom(body);
  }
  for (const box of document.querySelectorAll(".sub-console")) stickSubConsole(box);
}, 400);

// A wheel up is the reader leaving the bottom on purpose; coming back down re-pins in the scroll handler.
document.addEventListener(
  "wheel",
  (e) => {
    const pre = e.target && e.target.closest && e.target.closest("pre.job-out");
    if (pre && e.deltaY < 0) state.outPinned[pre.dataset.out] = false;
    const subBox = e.target && e.target.closest && e.target.closest(".sub-console");
    if (subBox && e.deltaY < 0) state.subConsolePinned.set(subBox.dataset.subConsoleBox || "", false);
    const body = e.target && e.target.closest && e.target.closest(".think-body");
    if (body && e.deltaY < 0) {
      const key = body.closest("details.think")?.dataset.thinkTurn || "";
      state.thinkPinned.set(key, false);
    }
  },
  { capture: true, passive: true },
);

$("projects").addEventListener("click", (e) => {
  // The agent badge inside a row opens the row (and its agents block) instead of toggling blindly.
  const badgeBtn = e.target.closest("[data-open-row]");
  if (badgeBtn) {
    e.preventDefault();
    e.stopPropagation();
    openAgentsBlock(badgeBtn.dataset.openRow);
    return;
  }
  // A row's agent chip jumps up to that conversation instead of expanding the row.
  const jump = e.target.closest("[data-agent-thread]");
  if (jump) {
    e.preventDefault();
    e.stopPropagation();
    jumpToAgent(jump.dataset.agentThread);
    return;
  }
  // The next-read ring is also a button: it forces one fresh read of just this worktree.
  const refreshBtn = e.target.closest("[data-refresh-row]");
  if (refreshBtn) {
    e.preventDefault();
    e.stopPropagation();
    void forceRowRead(refreshBtn);
    return;
  }
  const tr = e.target.closest("tr.row");
  if (!tr) return;
  // A row's own controls (play, delete, revive, refresh ring) have their own handlers. If the toggle
  // ALSO fires, `keepInPlace` corrects the page for the accordion that just opened and yanks it back —
  // which is exactly how clicking the green play button moved the caret into the prompt while leaving
  // the card off-screen.
  if (e.target.closest("button, a, input, select, textarea, label")) return;
  const key = tr.dataset.key;
  const row = state.rows.get(key);
  if (!row) return;
  keepInPlace(
    () => document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`),
    () => {
      if (state.expanded.has(key)) {
        state.expanded.delete(key);
        state.detailEls.get(key)?.remove();
        state.detailEls.delete(key);
        tr.classList.remove("expanded");
      } else {
        state.expanded.add(key);
        const holder = document.createElement("tbody");
        holder.innerHTML = detailHtml(row);
        const dEl = holder.firstElementChild;
        tr.after(dEl);
        state.detailEls.set(key, dEl);
        fillAgentSlots(dEl, new Map());
        tr.classList.add("expanded");
      }
    },
  );
});

setInterval(() => {
  // A hidden tab has nothing to repaint: timers keep firing there, and the work (plus the layout
  // each repaint forces) is what made coming back to the tab feel like a freeze.
  if (document.hidden) return;
  for (const el of document.querySelectorAll(".queue-ago[data-queued-at]")) {
    const at = Number(el.dataset.queuedAt) || 0;
    if (!at) continue;
    const next = fmtDur(Date.now() - at);
    if (el.textContent !== next) el.textContent = next;
  }
  for (const cell of document.querySelectorAll("td.age")) {
    const row = state.rows.get(cell.dataset.key);
    if (!row) continue;
    paintAgeCell(cell, row);
  }
  // Subagent rows carry their own clock, like the turn head above them.
  for (const el of document.querySelectorAll("[data-sub-elapsed]")) {
    const started = Number(el.dataset.subElapsed) || 0;
    const next = started ? fmtSeconds((Date.now() - started) / 1000) : "";
    if (next && el.textContent !== next) el.textContent = next;
  }
  for (const j of state.jobs.values()) {
    if (j.status !== "running" && j.status !== "starting") continue;
    const card = document.querySelector(`.job[data-thread="${CSS.escape(j.thread || j.id)}"]`);
    // The clock is its own span. Replacing the whole foot here deleted the stats strip one second
    // after the card rendered it: a running card showed "running 42s" and nothing else, while every
    // settled sibling had its numbers.
    const clock = card?.querySelector(".job-foot [data-run-clock]");
    if (clock) {
      const next = `running ${elapsed(j)}`;
      if (clock.textContent !== next) clock.textContent = next;
    }
    // Only the status text is repainted. Writing head.textContent here deleted the pin star and the
    // chevron every second and put them back on the next render — the star visibly popped in and out
    // while a turn ran, and the row reflowed with it.
    // Both copies (page and pinned block) carry the same id, so update every head, not just the first.
    const heads = card?.querySelectorAll(`[data-turn-head="${CSS.escape(j.id)}"]`) || [];
    for (const head of heads) {
      const txt = head.querySelector(".turn-text");
      if (!txt) continue;
      const next = `turn ${turnSeqOf(j)} · running ${elapsed(j)}`;
      if (txt.textContent !== next) txt.textContent = next;
    }
  }
  const bits = [];
  if (state.pool) bits.push(`pool ${state.pool.inFlight}/${state.settings.threads || "?"}`);
  if (state.jobs.size) {
    // The assistant is a conversation but not a board agent: the float says "thinking" for it, and counting
    // it here read as a phantom agent while the Agents panel said there were none.
    const convs = conversations().filter((c) => c.thread !== state.assistantThread);
    const running = convs.filter(convLive).length;
    if (convs.length) bits.push(`${convs.length} conversation${convs.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`);
  }
  if (state.lastEventAt) {
    const rate = state.events / Math.max(1, (Date.now() - state.eventsAt) / 1000);
    bits.push(`${state.events} events · ${rate.toFixed(1)}/s`);
  } else {
    bits.push("no changes yet");
  }
  $("stream-rate").textContent = bits.join(" · ");
}, 1000);

setInterval(() => {
  if (state.paused) return;
  // SSE is the live path; this is only a safety net for a stream that has gone quiet or died.
  const quiet = !state.lastEventAt || Date.now() - state.lastEventAt > 20000 || state.es?.readyState !== 1;
  if (quiet) void resync();
}, 30000);

// A folder whose projects are all closed shows nothing but their titles, so a reorder there is easy to
// miss and no row event is arriving to trigger one — check it on a clock instead. Folders holding an open
// project are skipped inside reorderProjects(), so this never moves a card being read. The cadence is a
// setting (0 turns it off): some readers want the board to settle and stay put.
const REORDER_KEY = "wm.reorderSeconds";
const REORDER_DEFAULT = 5;
const REORDER_MAX = 600;

function reorderSeconds() {
  const stored = localStorage.getItem(REORDER_KEY);
  // Number(null) is 0, which would read as "off" for a reader who never touched the setting.
  if (stored === null || stored === "") return REORDER_DEFAULT;
  const n = Number(stored);
  if (!Number.isFinite(n) || n < 0) return REORDER_DEFAULT;
  return Math.min(REORDER_MAX, Math.round(n));
}

function startReorderClock() {
  clearInterval(state.reorderTimer);
  const every = reorderSeconds();
  state.reorderTimer = every > 0
    ? setInterval(() => {
        if (document.hidden) return;
        reorderProjects();
      }, every * 1000)
    : null;
}

document.addEventListener("visibilitychange", () => {
  // Coming back to the tab: one catch-up, then the stream and the 1s tick take over again.
  if (!document.hidden) void resync();
});

// ---- page zoom -------------------------------------------------------------------------------
// Nothing in this page blocks the browser's own zoom, but when it is opened inside a shell that
// swallows Ctrl +/- (an embedded pane, a kiosk window) there is no way to make the table bigger.
// So the page owns a scale factor as well: Ctrl+wheel, Ctrl +/- and the − 100% + control above.
const ZOOM_KEY = "wtgui.zoom";
const ZOOM_MIN = 50;
const ZOOM_MAX = 250;

function applyZoom(pct, { save = true } = {}) {
  const n = Number(pct);
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number.isFinite(n) ? Math.round(n / 10) * 10 : 100));
  state.zoom = z;
  // `zoom` scales layout, not just paint, so the sticky header and the table stay coherent.
  document.documentElement.style.zoom = z === 100 ? "" : String(z / 100);
  const label = $("zoom-pct");
  if (label) label.textContent = `${z}%`;
  // The zoom is a layout scale, so it changes how much room the columns have without a resize event to say so:
  // without this the chart kept a split measured for the previous scale (and, on a phone, the wrong idea of
  // whether it should be scrolling sideways).
  fitAllColumns();
  if (save) {
    try {
      localStorage.setItem(ZOOM_KEY, String(z));
    } catch {
      /* private mode: the zoom just will not persist */
    }
  }
}

function zoomBy(delta) {
  applyZoom((state.zoom || 100) + delta);
}

$("btn-zoom-in")?.addEventListener("click", () => zoomBy(10));
$("btn-zoom-out")?.addEventListener("click", () => zoomBy(-10));

document.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 10 : -10);
  },
  { passive: false },
);

// ---- NOT-RUNNING (the hot-agent rotation) --------------------------------------------------
// A rotation through the agents that are waiting on you: a card whose latest turn is NOT running has said what
// it wanted and is sitting there. Turning this on opens the first one, puts the caret in its reply box and
// flashes that box amber; Enter sends and moves to the next, Alt+Right skips one, Alt+Left steps back. The box
// flashes on every hop, not just the first, so the eye can follow the caret through the list.

function hotWaiting() {
  return conversations().filter((c) => {
    const t = c.latest || {};
    return t.status !== "running" && t.status !== "starting";
  });
}

function hotCandidates() {
  const waiting = hotWaiting();
  // Visible cards first, in the order the board shows them, then everything else newest-first: a folded
  // project has no cards in the DOM and those agents are just as waiting.
  const rank = new Map([...document.querySelectorAll(".agents-block .job")].map((el, i) => [el.dataset.thread, i]));
  const dom = waiting.filter((c) => rank.has(c.thread)).sort((a, b) => rank.get(a.thread) - rank.get(b.thread));
  const rest = waiting
    .filter((c) => !rank.has(c.thread))
    .sort((a, b) => Date.parse(b.latest?.startedAt || 0) - Date.parse(a.latest?.startedAt || 0));
  return [...dom, ...rest].map((c) => c.thread);
}

function hotRowFor(thread) {
  for (const row of state.rows.values()) {
    if (agentsFor(row).some((c) => c.thread === thread)) return row;
  }
  return null;
}

function hotStillWaiting(thread) {
  const conv = conversations().find((c) => c.thread === thread);
  if (!conv) return false;
  const t = conv.latest || {};
  return t.status !== "running" && t.status !== "starting";
}

// The whole card flashes, not just the box: the rotation moves the reader's attention to a panel, and a ring
// around the panel is what says "this one". The caret still lands in the reply box.
function flashHotCard(thread) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return;
  const until = Date.now() + 1300;
  state.hotFlash = { thread, until };
  card.classList.remove("hot-flash");
  void card.offsetWidth; // restart it even when the last flash is still fading
  card.classList.add("hot-flash");
  clearTimeout(state.hotFlashTimer);
  state.hotFlashTimer = setTimeout(() => {
    state.hotFlash = { thread: null, until: 0 };
    document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)?.classList.remove("hot-flash");
  }, 1300);
}

function paintHotButton() {
  const btn = $("btn-hot");
  if (!btn) return;
  const h = state.hot;
  btn.classList.toggle("on", h.on);
  btn.textContent = h.on ? `NOT-RUNNING ${Math.min(h.cursor + 1, h.stack.length)}/${h.stack.length}` : "NOT-RUNNING";
  btn.title = h.on
    ? "NOT-RUNNING is on — Enter sends and moves to the next agent that is waiting on you, Alt+Right skips, Alt+Left goes back. Click to stop."
    : "NOT-RUNNING — step through the agents that are not running and are waiting on you: each one is opened, its reply box focused and flashed amber. Enter sends and moves on; Alt+Right skips; Alt+Left goes back.";
}

// Open exactly the path to one card and close everything else: after Collapse all the project is only "open"
// in state, and the folder holding it is still shut - an open project inside a closed folder is not on screen,
// which is why the counter moved and nothing appeared. The rotation keeps one project visible at a time.
function hotOpenPath(row) {
  const project = row.project;
  for (const name of [...state.expandedProjects]) {
    if (name !== project) toggleProject(name);
  }
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(project)}"]`);
  const root = sec?.closest("section.root-group")?.dataset.root;
  if (root && state.collapsedRoots.has(root)) {
    state.collapsedRoots.delete(root);
    saveCollapsedRoots();
    applyRootCollapse(root);
    paintCollapseAll();
  }
  if (!state.expandedProjects.has(project)) toggleProject(project);
  const key = keyOf(project, row.path);
  if (!state.expanded.has(key)) {
    document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
  }
}

function hotFocus(thread) {
  const row = hotRowFor(thread);
  if (!row) return false;
  hotOpenPath(row);
  let card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return false;
  if (card.classList.contains("collapsed")) {
    // Unfolding repaints the card, so the node we clicked is replaced: re-query or every step after this
    // (scroll, focus, flash) runs against a detached element and does nothing visible.
    card.querySelector(".job-head")?.click();
    card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`) || card;
  }
  scrollCardUnderBar(card);
  const box = card.querySelector(".reply-box");
  if (box) {
    try {
      box.focus({ preventScroll: true });
    } catch {
      box.focus();
    }
    const end = box.value.length;
    if (box.setSelectionRange) box.setSelectionRange(end, end);
  }
  flashHotCard(thread);
  return true;
}

function hotStep(dir) {
  const h = state.hot;
  if (!h.on) return;
  if (dir > 0) {
    let i = h.cursor;
    while (i + 1 < h.stack.length) {
      i += 1;
      if (hotStillWaiting(h.stack[i]) && hotFocus(h.stack[i])) {
        h.cursor = i;
        paintHotButton();
        return;
      }
    }
    const next = hotCandidates().find((t) => !h.stack.includes(t));
    if (!next) {
      showBanner("NOT-RUNNING: no agents are waiting for input");
      return;
    }
    h.stack.push(next);
    h.cursor = h.stack.length - 1;
    hotFocus(next);
    paintHotButton();
    return;
  }
  let i = h.cursor;
  while (i - 1 >= 0) {
    i -= 1;
    if (hotStillWaiting(h.stack[i]) && hotFocus(h.stack[i])) {
      h.cursor = i;
      paintHotButton();
      return;
    }
  }
}

function hotToggle() {
  const h = state.hot;
  h.on = !h.on;
  if (!h.on) {
    h.stack = [];
    h.cursor = -1;
    paintHotButton();
    return;
  }
  const list = hotCandidates();
  if (!list.length) {
    h.on = false;
    paintHotButton();
    showBanner("NOT-RUNNING: no agents are waiting for input");
    return;
  }
  h.stack = [list[0]];
  h.cursor = 0;
  paintHotButton();
  hotFocus(list[0]);
}

// Enter in the hot card: the reply is on its way, so fold that project away and step on.
function hotAfterSend(thread) {
  if (!state.hot.on) return;
  const row = hotRowFor(thread);
  if (row && state.expandedProjects.has(row.project)) toggleProject(row.project);
  hotStep(1);
}

$("btn-hot")?.addEventListener("click", (e) => {
  e.stopPropagation();
  hotToggle();
});
window.addEventListener("keydown", (e) => {
  if (!state.hot.on || !e.altKey) return;
  if (e.key === "ArrowRight") {
    e.preventDefault();
    hotStep(1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    hotStep(-1);
  }
});

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  // Ctrl+, opens Settings even if the button is out of reach (a host shell can eat pointer events).
  if (e.key === "," || e.key === "<") {
    e.preventDefault();
    toggleSettings();
    return;
  }
  if (e.key === "+" || e.key === "=") {
    e.preventDefault();
    zoomBy(10);
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    zoomBy(-10);
  } else if (e.key === "0") {
    e.preventDefault();
    applyZoom(100);
  }
});

try {
  applyZoom(Number(localStorage.getItem(ZOOM_KEY) || 100), { save: false });
} catch {
  applyZoom(100, { save: false });
}

// ---- fonts: two settings, not one ----------------------------------------------
// Panel font: the page's own labels, headings and buttons (--ui).
// Terminal font: the text inside an agent card — transcript, prompt, reply box, command preview
// (--term). They are separate on purpose: a readable serif UI with a monospace transcript is a
// normal preference, and so is the other way round.
// Stacks, not families: the first face the machine actually has wins, so listing one that is not
// installed is harmless.
const UI_FONTS = [
  { id: "default", label: "Default (system UI)", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "segoe", label: "Segoe UI", stack: '"Segoe UI", system-ui, sans-serif' },
  { id: "calibri", label: "Calibri", stack: 'Calibri, "Segoe UI", sans-serif' },
  { id: "tahoma", label: "Tahoma", stack: 'Tahoma, Verdana, sans-serif' },
  { id: "verdana", label: "Verdana", stack: 'Verdana, Geneva, sans-serif' },
  { id: "trebuchet", label: "Trebuchet MS", stack: '"Trebuchet MS", "Segoe UI", sans-serif' },
  { id: "georgia", label: "Georgia (serif)", stack: 'Georgia, "Times New Roman", serif' },
  { id: "consolas", label: "Consolas (monospace UI)", stack: 'Consolas, "Cascadia Mono", monospace' },
  { id: "cascadia", label: "Cascadia Code (monospace UI)", stack: '"Cascadia Code", Consolas, monospace' },
  { id: "jetbrains", label: "JetBrains Mono (monospace UI)", stack: '"JetBrains Mono", Consolas, monospace' },
];

const TERM_FONTS = [
  { id: "default", label: "Default (monospace)", stack: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
  { id: "consolas", label: "Consolas", stack: 'Consolas, "Cascadia Mono", monospace' },
  { id: "cascadia", label: "Cascadia Code", stack: '"Cascadia Code", Consolas, monospace' },
  { id: "cascadia-mono", label: "Cascadia Mono", stack: '"Cascadia Mono", Consolas, monospace' },
  { id: "jetbrains", label: "JetBrains Mono", stack: '"JetBrains Mono", Consolas, monospace' },
  { id: "fira", label: "Fira Code", stack: '"Fira Code", Consolas, monospace' },
  { id: "source-code", label: "Source Code Pro", stack: '"Source Code Pro", Consolas, monospace' },
  { id: "ibm-plex", label: "IBM Plex Mono", stack: '"IBM Plex Mono", Consolas, monospace' },
  { id: "inconsolata", label: "Inconsolata", stack: 'Inconsolata, "Inconsolata-g", Consolas, monospace' },
  { id: "victor", label: "Victor Mono", stack: '"Victor Mono", Consolas, monospace' },
  { id: "ubuntu-mono", label: "Ubuntu Mono", stack: '"Ubuntu Mono", Consolas, monospace' },
  { id: "hack", label: "Hack", stack: 'Hack, Consolas, monospace' },
  { id: "menlo", label: "Menlo", stack: 'Menlo, Consolas, monospace' },
  { id: "lucida", label: "Lucida Console", stack: '"Lucida Console", Consolas, monospace' },
  { id: "courier", label: "Courier New", stack: '"Courier New", monospace' },
  { id: "panel", label: "Same as the panel font", stack: "var(--ui)" },
];

// Console text size and weight. Sizes are px at the console's default line-height; weights are the four
// the monospace faces on this box actually resolve to.
const TERM_SIZES = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 18];
const TERM_WEIGHTS = [
  { id: "300", label: "Light (300)" },
  { id: "400", label: "Normal (400)" },
  { id: "500", label: "Medium (500)" },
  { id: "600", label: "Semibold (600)" },
  { id: "700", label: "Bold (700)" },
];

// A monospace face has no emoji of its own, and a stack that ends in `monospace` hands the glyph to
// whatever monochrome symbol font the system offers — the console's tool icons then come out as small
// grey marks instead of 📖 💻 🔧. Name the colour emoji fonts just before the generic keyword, so
// ASCII still resolves in the chosen face and only the glyphs fall through.
const EMOJI_FALLBACK = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji"';
function withEmojiFallback(stack) {
  const s = String(stack || "").trim();
  if (!s || s.includes("Emoji")) return s;
  const m = /^(.*?),?\s*(monospace|sans-serif|serif|system-ui)$/.exec(s);
  return m ? `${m[1]}, ${EMOJI_FALLBACK}, ${m[2]}` : `${s}, ${EMOJI_FALLBACK}`;
}

const FONT_SETS = {
  ui: { key: "wtgui.font", varName: "--ui", select: "font-select", preview: "font-preview", list: UI_FONTS },
  term: { key: "wtgui.termFont", varName: "--term", select: "term-select", preview: "term-preview", list: TERM_FONTS },
};

function currentFontId(kind) {
  const set = FONT_SETS[kind] || FONT_SETS.ui;
  let id = "default";
  try {
    id = localStorage.getItem(set.key) || "default";
  } catch {
    /* private mode: the default is fine */
  }
  return set.list.some((f) => f.id === id) ? id : "default";
}

function applyFont(kind, id, { save = true } = {}) {
  const set = FONT_SETS[kind] || FONT_SETS.ui;
  const font = set.list.find((f) => f.id === id) || set.list[0];
  document.documentElement.style.setProperty(set.varName, withEmojiFallback(font.stack));
  const sel = $(set.select);
  if (sel && sel.value !== font.id) sel.value = font.id;
  const preview = $(set.preview);
  if (preview) preview.style.fontFamily = font.stack;
  if (save) {
    try {
      localStorage.setItem(set.key, font.id);
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

// Console size/weight are not part of the font stacks: they are two vars the console box reads, so the
// panel can resize its own output without touching anything the reader types.
function termSize() {
  let n = 11.5;
  try {
    n = Number(localStorage.getItem("wtgui.termSize")) || 11.5;
  } catch {
    /* private mode */
  }
  return TERM_SIZES.includes(n) ? n : 11.5;
}

function termWeight() {
  let w = "400";
  try {
    w = localStorage.getItem("wtgui.termWeight") || "400";
  } catch {
    /* private mode */
  }
  return TERM_WEIGHTS.some((x) => x.id === w) ? w : "400";
}

function applyTermStyle({ save = false, size = null, weight = null } = {}) {
  const n = size === null ? termSize() : Number(size) || 11.5;
  const w = weight === null ? termWeight() : String(weight);
  document.documentElement.style.setProperty("--term-size", `${n}px`);
  document.documentElement.style.setProperty("--term-weight", w);
  const sizeSel = $("term-size-select");
  if (sizeSel && sizeSel.value !== String(n)) sizeSel.value = String(n);
  const weightSel = $("term-weight-select");
  if (weightSel && weightSel.value !== w) weightSel.value = w;
  // The preview must show what it describes, or it is just decoration.
  const preview = $("term-preview");
  if (preview) {
    preview.style.fontSize = `${n}px`;
    preview.style.fontWeight = w;
  }
  if (save) {
    try {
      localStorage.setItem("wtgui.termSize", String(n));
      localStorage.setItem("wtgui.termWeight", w);
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

// ---- panel contrast -----------------------------------------------------------------------
// The board is a stack of greys - page, detail row, card, card header, hovered row - and each layer is a CSS
// variable. One slider places the whole stack on a scale: at 0% every layer is the same neutral (a flat board),
// at 100% the page is near black and the raised surfaces are much lighter. Colours are interpolated here rather
// than in CSS because a single scale has to move six independent variables together.
const CONTRAST_KEY = "wtgui.contrast";
// The flat point is today's most common surface, so the slider's resting position is where the board already
// was. Targets are what each layer becomes at 100%.
const CONTRAST_FLAT = [18, 22, 29]; // #12161d
const CONTRAST_MAX = {
  "--console": [0, 0, 0],
  "--bg": [5, 7, 11],
  "--surface": [26, 32, 43],
  "--card": [60, 71, 86],
  "--panel": [52, 62, 76],
  "--band": [64, 76, 92],
  "--hover": [74, 86, 104],
  "--panel-2": [92, 106, 124],
  "--line": [120, 136, 156],
};

function contrastColor(target, k) {
  const c = target.map((v, i) => Math.round(CONTRAST_FLAT[i] + (v - CONTRAST_FLAT[i]) * k));
  return `rgb(${c.join(" ")})`;
}

function applyContrast(pct, { save = true } = {}) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct)) || 0));
  const k = p / 100;
  const root = document.documentElement.style;
  for (const [name, target] of Object.entries(CONTRAST_MAX)) root.setProperty(name, contrastColor(target, k));
  const input = $("contrast");
  if (input && Number(input.value) !== p) input.value = String(p);
  const label = $("contrast-pct");
  if (label) label.textContent = `${p}%`;
  if (save) {
    try {
      localStorage.setItem(CONTRAST_KEY, String(p));
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

function contrastSetting() {
  try {
    const raw = localStorage.getItem(CONTRAST_KEY);
    if (raw !== null && Number.isFinite(Number(raw))) return Math.max(0, Math.min(100, Number(raw)));
  } catch {
    /* private mode */
  }
  return 15;
}

// ---- the add-agent bar's green --------------------------------------------------------------
// The + bar under a worktree's agents is the one thing on the row you click to start an agent, so it is meant to be
// bright and solid. But "bright" is not one number on every screen: the same green reads like a warning label on a
// dark 4K panel. One scale moves lightness and saturation together - 0% a deep, quiet green, 100% the vivid one -
// and the bar's CSS reads the five variables this writes. Saved in this browser, applied at once.
const ADDBAR_KEY = "wtgui.addbar";
const ADDBAR_DEFAULT = 40; // a notch below the old fixed #1e6b38: still solid, less shouty
function addBarColors(pct) {
  const k = Math.max(0, Math.min(100, Number(pct))) / 100;
  const s = 42 + 18 * k; // saturation 42% .. 60%
  const l = 15 + 25 * k; // lightness 15% .. 40%
  const hsl = (l2) => `hsl(140 ${Math.round(s)}% ${Math.round(l2)}%)`;
  return {
    "--addbar": hsl(l),
    "--addbar-edge": hsl(l + 9),
    "--addbar-hover": hsl(l + 5),
    "--addbar-hover-edge": hsl(l + 13),
    "--addbar-active": hsl(l - 4),
  };
}

function applyAddBarBrightness(pct, { save = true } = {}) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct)) || 0));
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(addBarColors(p))) root.setProperty(name, value);
  const input = $("addbar-bright");
  if (input && Number(input.value) !== p) input.value = String(p);
  const label = $("addbar-pct");
  if (label) label.textContent = `${p}%`;
  if (save) {
    try {
      localStorage.setItem(ADDBAR_KEY, String(p));
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

function addBarBrightnessSetting() {
  try {
    const raw = localStorage.getItem(ADDBAR_KEY);
    if (raw !== null && Number.isFinite(Number(raw))) return Math.max(0, Math.min(100, Number(raw)));
  } catch {
    /* private mode */
  }
  return ADDBAR_DEFAULT;
}

// ---- where the add-agent bar sits -----------------------------------------------------------
// The + bar is the row's "start another agent here" control. Under the cards it closes the list; above them it is the
// first thing in it. Which reads better depends on whether the reader is starting agents or reading them, so it is a
// switch. CSS-only: one class on the body flips the stack, so nothing repaints and the open cards keep their scroll.
const ADDBAR_TOP_KEY = "wtgui.addbarTop";
function addBarAtTop() {
  try {
    const raw = localStorage.getItem(ADDBAR_TOP_KEY);
    if (raw !== null) return raw !== "0";
  } catch {
    /* private mode */
  }
  return true; // above the cards: the reader asked for it there
}

function applyAddBarTop(on, { save = true } = {}) {
  const top = Boolean(on);
  document.body.classList.toggle("addbar-top", top);
  const box = $("addbar-top");
  if (box && box.checked !== top) box.checked = top;
  if (save) {
    try {
      localStorage.setItem(ADDBAR_TOP_KEY, top ? "1" : "0");
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
}

// The grey flash says "re-read, nothing moved". It is useful when watching a row settle and noise when the board
// is busy, so it can be switched off - while the green flash, which means something actually happened, cannot.
// A body class is enough: the row still gets its class for 950ms, the animation just does not run.
function greyFlashOn() {
  try {
    return localStorage.getItem("wtgui.greyFlash") !== "0";
  } catch {
    return true;
  }
}

function applyGreyFlash(on) {
  document.body.classList.toggle("no-grey-flash", !on);
  const box = $("grey-flash");
  if (box && box.checked !== on) box.checked = on;
  try {
    localStorage.setItem("wtgui.greyFlash", on ? "1" : "0");
  } catch {
    /* private mode: the choice just will not persist */
  }
}

function toggleSettings(open = null) {
  const panel = $("settings");
  if (!panel) return;
  const show = open === null ? panel.classList.contains("hidden") : open;
  panel.classList.toggle("hidden", !show);
  if (!show) return;
  const sel = $("font-select");
  if (sel) {
    sel.value = currentFontId("ui");
    sel.focus();
  }
  // The browser-owned rows are read at boot; painting them again here just means the panel always opens on
  // what is in effect, even if another tab changed it.
  paintQLook();
  // Read the gateway's window every time the panel opens: it can be changed from a CLI, and the
  // panel is not the owner of that value.
  void loadApprovalSetting();
  void loadSessionSetting();
  void loadProviderSetting();
  void loadProjectsSetting();
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
      sel.innerHTML = set.list.map((f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join("");
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
}

// Paint the saved question-box look before the first card is drawn.
function initQLook() {
  applyQLook({}, { save: false });
}

// ---- projects and scan roots configuration ------
let projectsState = { scanRoots: [], projects: [] };

function paintProjectsSetting(note = "") {
  const list = $("scanroots-list");
  const input = $("scanroot-new");
  const preview = $("scanroots-preview");
  const save = $("btn-scanroots-save");

  if (list) {
    list.innerHTML = projectsState.scanRoots.map((root, i) =>
      `<div class="settings-list-item"><span>${esc(root)}</span><button type="button" data-remove="${i}" title="remove this folder">Remove</button></div>`
    ).join("");
    for (const btn of list.querySelectorAll("button[data-remove]")) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const idx = Number(btn.dataset.remove);
        const updated = projectsState.scanRoots.filter((_, i) => i !== idx);
        projectsState.scanRoots = updated;
        paintProjectsSetting();
        save?.classList.add("dirty");
      });
    }
  }

  if (preview) {
    if (note) {
      preview.textContent = `${note} — ${projectsState.scanRoots.length} folder${projectsState.scanRoots.length === 1 ? "" : "s"}`;
    } else {
      preview.textContent = projectsState.scanRoots.length
        ? `${projectsState.scanRoots.length} folder${projectsState.scanRoots.length === 1 ? "" : "s"}`
        : "no folders configured";
    }
  }

  if (save) {
    save.classList.toggle("dirty", String(JSON.stringify(projectsState.scanRoots)) !== String(JSON.stringify(state.savedScanRoots || [])));
  }
}

async function loadProjectsSetting() {
  try {
    const r = await apiFetch("/api/settings/projects");
    projectsState = await r.json();
    state.savedScanRoots = [...projectsState.scanRoots];
    paintProjectsSetting();
  } catch (e) {
    const preview = $("scanroots-preview");
    if (preview) {
      preview.textContent = `could not read projects: ${e.message}`;
      preview.classList.add("bad");
    }
  }
}

async function saveProjectsSetting() {
  const preview = $("scanroots-preview");
  if (!projectsState.scanRoots.length) {
    if (preview) preview.textContent = "NOT SAVED — at least one folder is required";
    return;
  }
  if (preview) {
    preview.textContent = "saving…";
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanRoots: projectsState.scanRoots }),
    });
    const d = await r.json();
    if (!r.ok) {
      paintProjectsSetting(d.error || `HTTP ${r.status}`, true);
      return;
    }
    projectsState = d;
    state.savedScanRoots = [...projectsState.scanRoots];
    paintProjectsSetting(d.note || "saved");
    $("scanroot-new").value = "";
    $("btn-scanroots-save").classList.remove("dirty");
  } catch (e) {
    paintProjectsSetting(e.message, true);
  }
}

$("btn-settings")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});
$("btn-settings-close")?.addEventListener("click", () => toggleSettings(false));
// A second way in that is always on screen at the top left: the title opens Settings.
$("title-settings")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettings();
});
$("font-select")?.addEventListener("change", (e) => applyFont("ui", e.target.value));
$("term-select")?.addEventListener("change", (e) => applyFont("term", e.target.value));
$("term-size-select")?.addEventListener("change", (e) => applyTermStyle({ save: true, size: e.target.value }));

// ---- the question box's look: tint, size, density, and whether the typed answer is offered --------
for (const btn of document.querySelectorAll("[data-q-tint]")) {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    applyQLook({ tint: btn.dataset.qTint });
  });
}
$("q-size")?.addEventListener("change", (e) => {
  const n = Number(e.target.value);
  const look = applyQLook({ size: Number.isFinite(n) && n > 0 ? n : Q_SIZE_DEFAULT });
  // Show the clamped value: typing 40 lands on 18, and the box must say so rather than silently disagree.
  e.target.value = String(look.size);
});
$("q-width")?.addEventListener("change", (e) => {
  const n = Number(e.target.value);
  const look = applyQLook({ width: Number.isFinite(n) && n > 0 ? n : 0 });
  e.target.value = String(look.width);
});
for (const btn of document.querySelectorAll("[data-q-width-set]")) {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    applyQLook({ width: Number(btn.dataset.qWidthSet) || 0 });
  });
}
$("q-compact")?.addEventListener("change", (e) => applyQLook({ compact: Boolean(e.target.checked) }));
$("q-typed")?.addEventListener("change", (e) => {
  applyQLook({ typed: Boolean(e.target.checked) });
  // The typed row is markup, not only CSS: an open question has to be redrawn to gain or lose it.
  renderJobs();
});
$("grey-flash")?.addEventListener("change", (e) => applyGreyFlash(Boolean(e.target.checked)));
$("event-flash")?.addEventListener("change", (e) => {
  state.eventFlash = Boolean(e.target.checked);
  saveAnchorFlag(EVENT_FLASH_KEY, state.eventFlash);
});
$("stabilize-reorder")?.addEventListener("change", (e) => applyStabilize(Boolean(e.target.checked)));
$("autosort-toggle")?.addEventListener("change", (e) => applyAutoSort(Boolean(e.target.checked)));

// Refresh everything, or only what is on screen. The scans happen in the server, so this is a server setting: it is
// written to the panel's config.json and applies to whichever browser is open.
$("scan-mode")?.addEventListener("change", async (e) => {
  const before = state.settings?.scanMode === "visible" ? "visible" : "all";
  const mode = e.target.value === "visible" ? "visible" : "all";
  try {
    const r = await apiFetch("/api/settings/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) }, { timeoutMs: 10000 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.settings.scanMode = d.mode || mode;
    paintConfigLine();
    showBanner(mode === "visible" ? "refresh: only the projects on screen" : "refresh: every project");
    reportVisibility({ force: true });
  } catch (err) {
    e.target.value = before;
    showBanner(`could not change the refresh mode: ${err.message}`);
  }
});

// ---- the anchor's two signals: hover and last touched, each switched and timed on its own ----------
function paintAnchorSettings() {
  const hover = $("anchor-hover");
  const hoverSeconds = $("anchor-hover-seconds");
  const touch = $("anchor-touch");
  const touchSeconds = $("anchor-touch-seconds");
  const flash = $("flash-time");
  const eventFlash = $("event-flash");
  const scanMode = $("scan-mode");
  if (hover) hover.checked = state.anchorHover;
  if (hoverSeconds) hoverSeconds.value = String(state.anchorHoverSeconds);
  if (touch) touch.checked = state.anchorTouch;
  if (touchSeconds) touchSeconds.value = String(state.anchorTouchSeconds);
  if (flash) flash.value = String(state.flashSeconds);
  if (eventFlash) eventFlash.checked = state.eventFlash;
  if (scanMode) scanMode.value = state.settings?.scanMode === "visible" ? "visible" : "all";
  applyFlashTime();
}

$("flash-time")?.addEventListener("input", (e) => {
  const raw = Number(e.target.value);
  const n = Number.isFinite(raw) ? Math.max(0, Math.min(5, Math.round(raw * 10) / 10)) : FLASH_TIME_DEFAULT;
  state.flashSeconds = n;
  saveFlashSeconds(n);
  applyFlashTime();
});

$("anchor-hover")?.addEventListener("change", (e) => {
  state.anchorHover = Boolean(e.target.checked);
  saveAnchorFlag(ANCHOR_HOVER_KEY, state.anchorHover);
  if (!state.anchorHover) {
    state.hoverThread = null;
    state.hoverAt = 0;
  }
  refreshAnchorBaseline();
});

$("anchor-hover-seconds")?.addEventListener("input", (e) => {
  const n = Math.max(1, Math.min(600, Math.round(Number(e.target.value)) || ANCHOR_HOVER_SECONDS_DEFAULT));
  state.anchorHoverSeconds = n;
  saveAnchorSeconds(ANCHOR_HOVER_SECONDS_KEY, n);
  refreshAnchorBaseline();
});

$("anchor-touch")?.addEventListener("change", (e) => {
  state.anchorTouch = Boolean(e.target.checked);
  saveAnchorFlag(ANCHOR_TOUCH_KEY, state.anchorTouch);
  if (!state.anchorTouch) {
    state.touchTarget = null;
    state.touchAt = 0;
  }
  refreshAnchorBaseline();
});

$("anchor-touch-seconds")?.addEventListener("input", (e) => {
  const n = Math.max(3, Math.min(600, Math.round(Number(e.target.value)) || ANCHOR_TOUCH_SECONDS_DEFAULT));
  state.anchorTouchSeconds = n;
  saveAnchorSeconds(ANCHOR_TOUCH_SECONDS_KEY, n);
  refreshAnchorBaseline();
});
$("contrast")?.addEventListener("input", (e) => applyContrast(Number(e.target.value)));
$("addbar-bright")?.addEventListener("input", (e) => applyAddBarBrightness(Number(e.target.value)));
$("addbar-top")?.addEventListener("change", (e) => applyAddBarTop(Boolean(e.target.checked)));
$("auto-collect")?.addEventListener("change", (e) => {
  try {
    localStorage.setItem(AUTO_COLLECT_KEY, e.target.checked ? "1" : "0");
  } catch {
    /* private mode */
  }
});
$("show-thinking")?.addEventListener("change", (e) => {
  try {
    localStorage.setItem(THINK_KEY, e.target.checked ? "1" : "0");
  } catch {
    /* private mode: the default just will not persist */
  }
  // Only cards that have no answer of their own follow this.
  for (const c of conversations()) {
    let own = null;
    try {
      own = localStorage.getItem(`wtgui.think.${c.thread}`);
    } catch {
      /* ignore */
    }
    if (own === null) renderConversation(c.thread);
  }
});
$("term-weight-select")?.addEventListener("change", (e) => applyTermStyle({ save: true, weight: e.target.value }));

// The approval window. A preset only fills the box and lights Save: one click here rewrites the
// user's global Hermes config, so it takes a deliberate second one.
$("btn-approval-save")?.addEventListener("click", () => void saveApprovalSetting());
$("btn-session-limit-save")?.addEventListener("click", () => void saveSessionSetting());
$("btn-provider-save")?.addEventListener("click", () => void saveProviderSetting());
$("btn-provider-clear")?.addEventListener("click", (e) => void clearProviderKey(e.currentTarget));
$("btn-provider-default-url")?.addEventListener("click", () => {
  const url = $("provider-url");
  if (url) url.value = url.placeholder || "https://openrouter.ai/api/v1";
});
$("session-limit")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void saveSessionSetting();
});
$("session-limit")?.addEventListener("input", (e) => {
  const dirty = Number(e.target.value) !== sessionsState?.listLimit;
  $("btn-session-limit-save")?.classList.toggle("dirty", dirty);
});
$("approval-timeout")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void saveApprovalSetting();
});
$("approval-timeout")?.addEventListener("input", (e) => {
  const dirty = Number(e.target.value) !== approvalState?.timeoutSeconds;
  $("btn-approval-save")?.classList.toggle("dirty", dirty);
});
for (const btn of document.querySelectorAll("[data-approval-set]")) {
  btn.addEventListener("click", () => {
    const input = $("approval-timeout");
    if (!input || input.disabled) return;
    input.value = btn.dataset.approvalSet;
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
}
$("btn-scanroot-add")?.addEventListener("click", (e) => {
  e.preventDefault();
  const input = $("scanroot-new");
  if (!input || !input.value.trim()) return;
  const path = input.value.trim();
  if (!projectsState.scanRoots.includes(path)) {
    projectsState.scanRoots.push(path);
    paintProjectsSetting();
    $("btn-scanroots-save")?.classList.add("dirty");
  }
  input.value = "";
  input.focus();
});
$("scanroot-new")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  $("btn-scanroot-add")?.click();
});
$("btn-scanroots-save")?.addEventListener("click", () => void saveProjectsSetting());
document.addEventListener("click", (e) => {
  const panel = $("settings");
  if (!panel || panel.classList.contains("hidden")) return;
  if (panel.contains(e.target) || (e.target.closest && e.target.closest("#btn-settings"))) return;
  toggleSettings(false);
});

initFonts();
initQLook();
// The question countdowns move on their own; nothing else in the panel needs a 1s clock.
setInterval(tickQuestionClocks, 1000);
applyGreyFlash(greyFlashOn());
if ($("stabilize-reorder")) $("stabilize-reorder").checked = stabilizeOn();
if ($("autosort-toggle")) $("autosort-toggle").checked = autoSortOn();
applyContrast(contrastSetting(), { save: false });
applyAddBarBrightness(addBarBrightnessSetting(), { save: false });
applyAddBarTop(addBarAtTop(), { save: false });
if ($("show-thinking")) $("show-thinking").checked = thinkDefault();
if ($("auto-collect")) $("auto-collect").checked = autoCollectOn();
void refreshSubagentRoster();
// The model menu is filled once at start-up from the gateway's own provider list; a failure leaves
// the "(gateway default)" entry, which is what a spawn sends anyway.
void loadModels();

// The board-reorder cadence: an input plus presets, applied the moment it is accepted.
$("reorder-every")?.addEventListener("change", (e) => saveReorderSetting(e.target.value));
$("reorder-every")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveReorderSetting(e.target.value);
    e.target.blur();
  }
});
for (const b of document.querySelectorAll("[data-reorder-set]")) {
  b.addEventListener("click", () => {
    saveReorderSetting(b.dataset.reorderSet);
    const input = $("reorder-every");
    if (input) input.value = String(reorderSeconds());
  });
}
startReorderClock();
paintReorderSetting();

// Reflect the remembered collapse state of the two fixed cards before the first paint of them.
for (const id of ["newagent", "agents"]) applyFixedCollapse(id);

// ---- what the page can see ---------------------------------------------------------------------------------
// In "on screen" mode the scheduler re-reads only the projects in view. Half a screen above and below counts too,
// so scrolling to the next project finds it already read instead of blank for a second. The report is a heartbeat:
// the server believes it for 45s, so a closed tab stops pinning the fleet to nothing.
const VISIBLE_MARGIN = 0.5;
let visibleSentAt = 0;
// The last list actually sent, and the last one merely sampled. A sample taken while the board is being rebuilt is
// not the truth: collapsed sections are ~60px tall, so a mid-repaint reading says half the fleet is on screen. Only
// a list that comes up the same twice in a row is sent.
let visibleKey = "";
let visibleSampleKey = "";
let visibleTimer = 0;

function visibleProjects() {
  const margin = window.innerHeight * VISIBLE_MARGIN;
  const names = [];
  for (const sec of document.querySelectorAll("#projects section.project[data-project]")) {
    const r = sec.getBoundingClientRect();
    if (r.height < 1) continue;
    if (r.bottom >= -margin && r.top <= window.innerHeight + margin) names.push(sec.dataset.project);
  }
  return names;
}

function reportVisibility({ force = false } = {}) {
  if (state.settings?.scanMode !== "visible") return;
  const names = visibleProjects();
  const key = names.join("|");
  const stable = key === visibleSampleKey;
  visibleSampleKey = key;
  if (!stable && !force) return; // still settling: the next sample decides
  const now = Date.now();
  if (!force && key === visibleKey && now - visibleSentAt < 15000) return;
  visibleKey = key;
  visibleSentAt = now;
  apiFetch("/api/visible", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projects: names }) }, { timeoutMs: 5000 }).catch(() => {
    /* a missed heartbeat only means the server falls back to reading everything for a while */
  });
}

function startVisibilityReporting() {
  const nudge = () => {
    clearTimeout(visibleTimer);
    // Two samples a beat apart: the first may catch a repaint, the second decides.
    visibleTimer = setTimeout(() => reportVisibility(), 260);
  };
  window.addEventListener("scroll", () => { visibleKey = ""; nudge(); }, { passive: true });
  window.addEventListener("resize", () => { visibleKey = ""; nudge(); });
  // Sampled often, sent rarely: a stable list is posted when it changes and as a 15s heartbeat (the server believes
  // a report for 45s, so a closed tab stops pinning the fleet after a few missed beats).
  setInterval(() => reportVisibility(), 3000);
  setInterval(() => reportVisibility({ force: Date.now() - visibleSentAt > 15000 }), 5000);
}

startVisibilityReporting();

(async function boot() {
  try {
    const cfg = await apiFetch("/api/config").then((r) => r.json());
    state.settings = cfg;
    state.scanRoots = Array.isArray(cfg.scanRoots) ? cfg.scanRoots : [];
    $("f-worktree").textContent = cfg.worktreeSeconds;
    $("f-slow").textContent = cfg.slowSeconds;
    paintConfigLine();
    // Deliberately no seeding of state.projects from cfg.projects here: before discovery has
    // run that list is only the config fallback, and a project seeded that way can never be
    // removed by a later snapshot (heroes-js showed up forever this way on a machine that does
    // not have it). The first snapshot paints the real set.
    await resync();
    connect();
    startAnchorObserver();
    updateColorsRow();
    paintAnchorSettings();
    // "On screen" mode: say what is visible before the first paint settles, so the rows in front of the reader are
    // the first thing the scheduler reads.
    reportVisibility({ force: true });
    state.eventsAt = Date.now();
  } catch (e) {
    setStream("offline", "bad");
    showBanner(`Cannot reach the server: ${e.message}. Start it with npm start.`);
  }
})();
