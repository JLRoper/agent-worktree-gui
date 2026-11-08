// settings.js - the page's settings appliers: every `apply*` function that takes a stored or arrived
// value and puts it on the page. Cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js held 20,561 lines and one file was one lane. This is step 6 of the order
// of work in docs/reports/module-map-2026-11-07.html ("settings.js out of app.js. Larger, but the apply* cluster
// is already cohesive"), and it takes the whole cluster together: the 32 apply* declarations, moved line for
// line. Not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   the page's look            zoom, the two font settings, the three text styles, panel contrast, the add-agent
//                              bar's green and its place, the flash duration and the grey flash, and the
//                              question box's look
//   the board's own folds      a fixed card, a root folder, a project card and one folder's filter, plus the
//                              project hue the reader chose
//   the settings payloads      the snapshot's settings merge, the saved provider profile, the scan roots answer
//                              and the remote-write policy
//   approvals and turns        the approvals dock's fold, an approval answered, a question answered, the
//                              previous-turn plan and its mode
//   the chart's columns        the fit mode, the column widths and the stabilize switch
//   the snapshot and the       the job half, the whole snapshot merge, the ranked order for the rows a caller is
//   page's focus               about to draw, and the caret a spawn leaves in the new agent's reply box
//   the skills folds           one group's open state, the same two writes the search and the reader use
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state, $, esc               the page's state literal, the cached node lookup and the escaper
//   the region helpers          whatever each body called before: the settings readers and writers, the paint
//                              functions, the renderers, the stores and the constants, all still in app.js or in
//                              the module that owns them
//   localStorage                the keys the appliers save under, in their own try/catch as before
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `let` is a binding every other script reads by bare name.
// This file DECLARES ONLY: it has no top-level statement, no listener and no read of an app.js binding while it
// loads, so being loaded before app.js costs nothing. public/app.js re-exports these names on
// window.WMApp.settings.

function applyFixedCollapse(name) {
  const sec = document.getElementById(name);
  if (!sec) return;
  const open = !state.collapsedFixed.has(name);
  sec.classList.toggle("fixed-collapsed", !open);
  const head = sec.querySelector(".project-head[data-toggle-fixed]");
  if (head) {
    head.title = `${open ? "minimize" : "expand"} this card`;
    const chev = head.querySelector(".chev");
    if (chev) chev.textContent = open ? "\u25be" : "\u25b8";
  }
}

function applyRootCollapse(root) {
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  if (!sec) return;
  const open = !state.collapsedRoots.has(root);
  sec.classList.toggle("collapsed", !open);
  const head = sec.querySelector(".root-head[data-toggle-root]");
  if (head) {
    head.title = `${open ? "collapse" : "expand"} ${labelRoot(root)}`;
    const chev = head.querySelector(".chev");
    if (chev) chev.textContent = open ? "\u25be" : "\u25b8";
  }
}

function applyRootFilter(root) {
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  if (!sec) return;
  const q = rootFilterValue(root).trim().toLowerCase();
  const sections = [...sec.querySelectorAll(".root-body section.project")];
  let shown = 0;
  for (const s of sections) {
    const p = state.projects.get(s.dataset.project) || { name: s.dataset.project };
    const hay = `${p.name || ""} ${p.path || ""}`.toLowerCase();
    const hit = !q || hay.includes(q);
    s.classList.toggle("is-filtered-out", !hit);
    if (hit) shown += 1;
  }
  const count = sec.querySelector("[data-root-count]");
  if (count) {
    count.textContent = q ? `${shown}/${sections.length}` : "";
    count.classList.toggle("on", Boolean(q));
  }
  const empty = sec.querySelector("[data-root-empty]");
  if (empty) {
    // A folder with nothing in it is not an error — a root the reader has just named holds no repo yet — so the card
    // says which of the two cases it is instead of drawing a bare header over nothing.
    const typed = rootFilterValue(root).trim();
    empty.classList.toggle("is-on", typed ? shown === 0 : sections.length === 0);
    empty.textContent = typed
      ? `no project in this folder matches \u201c${typed}\u201d`
      : sections.length === 0
        ? "no git repo in this folder yet — a repository checked out directly under it appears here on the next read"
        : "";
  }
  const clear = sec.querySelector("[data-root-search-clear]");
  if (clear) clear.classList.toggle("is-on", Boolean(q));
}

// Toggle the class in place rather than re-rendering: the rows stay painted underneath, so
// expanding is instant and a collapse costs no DOM churn.
function applyProjectCollapse(name) {
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  if (!sec) return;
  const open = state.expandedProjects.has(name);
  sec.classList.toggle("collapsed", !open);
  const head = sec.querySelector(".project-head[data-toggle-project]");
  if (head) {
    head.title = `${open ? "minimize" : "expand"} ${name}`;
    const chev = head.querySelector(".chev");
    if (chev) chev.textContent = open ? "\u25be" : "\u25b8";
  }
}

// The route accepted the answer: clear every copy now rather than waiting for the next snapshot, and record the
// decision the way the server did. Both renderers are called because the board card and the assistant's floating
// chat are separate surfaces - a clear that only reaches one leaves the other offering a request that is over.
function applyApprovalAnswered(turnId, requestId, choice) {
  const rid = String(requestId || "").trim();
  const threads = new Set();
  for (const j of state.jobs.values()) {
    const a = j.approval;
    const same = rid ? a && String(a.requestId || "") === rid : j.id === turnId;
    if (!same) continue;
    j.approvalDone = { choice: String(choice || ""), command: a.command || "", at: new Date().toISOString(), here: true };
    j.approval = null;
    threads.add(j.thread || j.id);
  }
  if (!threads.size && turnId) threads.add(turnId);
  for (const thread of threads) {
    renderConversation(thread);
    if (assistantSessionFor(thread) && typeof window.__assistantRenderChat === "function") window.__assistantRenderChat(thread);
  }
  paintHumanButton();
}

function applyQLook(next = {}, { save = true } = {}) {
  const look = { ...qLookState, ...next };
  if (!Q_TINTS.includes(look.tint)) look.tint = "violet";
  const n = Number(look.size);
  look.size = Math.min(Q_SIZE_MAX, Math.max(Q_SIZE_MIN, Number.isFinite(n) && n > 0 ? n : Q_SIZE_DEFAULT));
  const w = Number(look.width);
  look.width = Math.min(Q_WIDTH_MAX, Math.max(Q_WIDTH_MIN, Number.isFinite(w) && w > 0 ? w : 0));
  look.compact = Boolean(look.compact);
  look.typed = Boolean(look.typed);
  qLookState = look;
  const root = document.documentElement;
  for (const tint of Q_TINTS) root.classList.toggle(`q-tint-${tint}`, tint === look.tint);
  root.classList.toggle("q-compact", look.compact);
  // Purely for the Settings sample, which has its typed row in its markup; a live card omits the row.
  root.classList.toggle("q-no-typed", !look.typed);
  root.style.setProperty("--q-size", `${look.size}px`);
  // 0 is not a width: it means "take the console's box", so no cap and no centring.
  root.classList.toggle("q-width-set", look.width > 0);
  if (look.width > 0) root.style.setProperty("--q-width", `${look.width}px`);
  else root.style.removeProperty("--q-width");
  paintQLook(look);
  if (save) {
    try {
      localStorage.setItem(Q_LOOK_KEY, JSON.stringify(look));
    } catch {
      /* private mode: the look still applies for this page */
    }
  }
  return look;
}

// The answer was accepted: clear every copy NOW rather than waiting for the next snapshot. The job records
// are updated first, so any repaint from any host agrees with the cards, then each affected thread is drawn
// again. The board card is `renderConversation`; the assistant's floating chat is its own renderer, and
// calling both is what makes two surfaces clear together - `renderConversation` only reaches the board.
function applyQuestionAnswered(turnId, requestId, answer) {
  const rid = String(requestId || "").trim();
  const threads = new Set();
  for (const j of state.jobs.values()) {
    const q = j.question;
    const same = rid ? q && String(q.requestId || "") === rid : j.id === turnId;
    if (!same) continue;
    j.questionDone = { answer: String(answer ?? ""), at: new Date().toISOString(), here: true };
    j.question = null;
    threads.add(j.thread || j.id);
  }
  if (!threads.size && turnId) threads.add(turnId);
  for (const thread of threads) {
    renderConversation(thread);
    if (assistantSessionFor(thread) && typeof window.__assistantRenderChat === "function") window.__assistantRenderChat(thread);
  }
  paintHumanButton();
}

function applyPreviousTurnPlan(plan) {
  for (const op of plan) {
    // `undefined` is the plan's own "leave that flag alone": "leave as is" is one of the answers, so a mode must be
    // able to say nothing about a turn rather than writing a flag that would re-open one the reader folded.
    if (op.open === true) wtTurnFold.setOpen(state, op.id, true);
    else if (op.open === false) wtTurnFold.setOpen(state, op.id, false);
    if (op.compact === true) wtTurnFold.freeze(state, op.id);
    else if (op.compact === false) wtTurnFold.unfreeze(state, op.id);
  }
}

function applyPrevTurnMode(mode) {
  const value = PREV_TURN_MODES.includes(mode) ? mode : "snippet";
  const sel = $("prev-turn-mode");
  if (sel) sel.value = value;
  try {
    localStorage.setItem(PREV_TURN_KEY, value);
  } catch {
    /* private mode: the choice just will not persist */
  }
}

function applyApprovalsFold(dock = $("approvals")) {
  if (!dock) return;
  const folded = approvalsFolded();
  dock.classList.toggle("is-folded", folded);
  const btn = $("btn-dock-approvals");
  if (btn) btn.textContent = folded ? "\u25b8" : "\u25be";
}

function applyRemoteWrites(rw) {
  state.rwPolicy = (rw && rw.policy) || state.rwPolicy;
  state.rwPending.clear();
  for (const r of (rw && rw.pending) || []) if (r && r.id) state.rwPending.set(r.id, r);
  // Reviews ride the snapshot too (the panel keeps them for its own window), so a reload inside the receipt's 90 s
  // comes back to the record of a write nobody was asked about instead of losing it.
  state.rwReviews.clear();
  for (const r of (rw && rw.reviews) || []) if (r && r.id) state.rwReviews.set(r.id, r);
  renderApprovals();
}

// After a spawn the reader wants to be typing, not hunting: put that agent's card in view and its
// reply box under the cursor. Both have to survive the repaint that follows a spawn (the first job
// event rebuilds the card), so the target is remembered and re-applied after every render until it
// takes — or until the reader starts typing somewhere else, which is never interrupted.
function applyPendingFocus() {
  const pending = state.pendingFocus;
  if (!pending) return;
  if (Date.now() > pending.until) {
    state.pendingFocus = null;
    return;
  }
  // No "is something else focused" guard on purpose: right after a spawn the caret is still in the
  // New-agent box, which is exactly the state we are replacing. The reader taking over is signalled by
  // a click outside the card, a keypress or a wheel scroll, and each clears the target on its own.
  focusReplyBox(pending.thread);
  // The jump needs the same treatment as the caret: a smooth scroll is cancelled when the card is
  // rebuilt mid-animation, and that is why the page only sometimes followed the new agent. Keep the
  // card in view for a few seconds, and only until the reader takes over.
  if (!pending.placed && Date.now() < (pending.scrollUntil || 0)) {
    const card = document.querySelector(`.job[data-thread="${CSS.escape(pending.thread)}"]`);
    if (card) {
      const r = card.getBoundingClientRect();
      const outOfView = r.top < 48 || r.bottom > window.innerHeight - 48;
      pending.placed = true; // once is a welcome; repeating it is the page fighting the reader
      if (outOfView) {
        programmaticScroll();
        card.scrollIntoView({ block: "center", behavior: "auto" });
      }
    }
  }
}

// The ranked order for the rows a caller is about to draw or move. Age-hidden rows are ranked too, so a row that
// comes back takes its slot rather than appearing at the bottom.
function applyRowRank(rows) {
  if (!rows.length) return rows;
  const project = rows[0].project;
  const byKey = new Map(rows.map((r) => [keyOf(r.project, r.path), r]));
  const all = [...state.rows.values()].filter((r) => r.project === project).map((r) => keyOf(r.project, r.path));
  const order = orderedByRank(`rows:${project}`, all, rowRankCtx(Date.now()));
  return order.map((k) => byKey.get(k)).filter(Boolean);
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

// CSS owns the animation, so the durations are handed over as variables; the class-removal timeouts below
// use the same numbers, so a flash cannot keep a class after it has finished fading.
function applyFlashTime() {
  const root = document.documentElement;
  root.style.setProperty("--flash-row", `${flashRowMs()}ms`);
  root.style.setProperty("--flash-project", `${flashProjectMs()}ms`);
  root.style.setProperty("--flash-ring", `${flashRingMs()}ms`);
}

function applyColumnWidths(table, widths) {
  headerCells(table).forEach((th, p) => {
    th.style.width = `${Math.max(24, Math.round(widths[p]))}px`;
  });
}

// Writes the mode onto the page: nothing but the class the CSS uses to say "the chart is a wrapper" — the table's
// min-width is cleared, because a min-width is how it used to outgrow the card, and the two column-spanning rows are
// simply as wide as the table now that there is no scroller to pin them inside.
function applyFitMode(table, fit) {
  if (!fit.wrap) return;
  fit.wrap.classList.remove("is-scroll");
  if (table.style.minWidth) table.style.minWidth = "";
  if (fit.wrap.style.getPropertyValue("--wt-visible")) fit.wrap.style.removeProperty("--wt-visible");
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

// The job half of a snapshot: the records the server still lists, and the console buffers that go with them.
//
// The whole store was replaced on every poll and `state.jobLines` was only ever ADDED to, so a turn the panel had
// forgotten kept its buffer for the life of the tab. Measured on a real page (docs/console-memory-growth.md): after
// the reader's own "Clear finished" emptied the board, all 19 buffers and all 752 lines stayed; the same held when
// the panel was swapped for a fresh one with an empty store. A turn the server no longer lists has no record, no
// card and no frames coming, so its buffer is released here.
//
// A turn that WAS live before this snapshot is kept even when the list has not caught up with it: a record that has
// not arrived yet is not the same fact as a record that is gone, and dropping a running turn's buffer would empty a
// console the run is still writing into. The next snapshot settles it.
function applyJobSnapshot(jobs) {
  const prev = new Map(state.jobs);
  state.jobs.clear();
  const listed = new Set();
  for (const j of jobs) {
    listed.add(j.id);
    state.jobs.set(j.id, j);
  }
  for (const id of [...state.jobLines.keys()]) {
    if (listed.has(id)) continue;
    if (turnLive(prev.get(id))) continue;
    state.jobLines.delete(id);
  }
}

function applySnapshot(data) {
  // Captured before anything is mutated: if the set of projects is the same afterwards, the
  // sections on screen are still valid and a full re-render would be pure cost.
  const beforeSig = [...state.projects.keys()].sort().join("|");
  state.settings = data.settings || state.settings;
  // The General tab draws from these numbers, and the pane's frame is one of them (`dockMode`). A snapshot is how a
  // value this page migrated at boot, or another tab saved, reaches that row and the frame — the settings EVENT is
  // not always heard: the migration's own save can land before this tab's stream is open. Both hooks are cheap and
  // idempotent (the painter writes only what changed, `applyFrame` returns early when the mode has not moved).
  if (typeof paintGeneralSettings === "function") paintGeneralSettings(state.settings);
  if (typeof window.__assistantFrame === "function") window.__assistantFrame();
  // The push controls ride every snapshot, and a project's repository is only known once discovery has probed its
  // remote URL. The cards and the Settings sections are repainted here so that fact arrives where it is drawn,
  // without waiting for a full board render.
  paintPushPermissions();
  syncPushControls();
  // The folders list is drawn from `settings`, which every snapshot carries: repaint only when the list actually
  // moved (a settings write in another tab, a hand-edited config), so a board ticking every few seconds does not
  // rebuild the rows — or stat the folders — for nothing.
  {
    const rootsSig = `${(state.settings?.scanRootsConfigured || []).join("|")}#${state.settings?.scanRootsFallback === true}`;
    if (rootsSig !== state.scanRootsSig) {
      state.scanRootsSig = rootsSig;
      void refreshScanRootsAnswer();
    }
  }
  // The panel's own two folders and their sizes. A snapshot is the only thing that carries them, so the Settings
  // row repaints from here as well as from its own presses — the clean's answer, a boot that migrated, a job event.
  if (data.paths) {
    state.paths = data.paths;
    paintPaths();
  }
  if (data.hosts) state.hosts = data.hosts;
  if (Array.isArray(data.scanRoots)) state.scanRoots = data.scanRoots;
  if (data.spawn) {
    state.spawn = data.spawn;
    const t = data.spawn.transport || {};
    const caps = t.capabilities || {};
    const reasoning = $("job-reasoning");
    if (reasoning) {
      reasoning.disabled = !t.reachable || caps.modelOptions !== true;
      reasoning.title = reasoning.disabled
        ? "Per-agent reasoning is unavailable: the gateway must advertise model_options and the panel must support it. Restart the panel after updating it."
        : "Per-agent reasoning effort; replies keep this choice. Default uses Hermes settings. Models may map unsupported levels to their nearest supported level.";
    }
    $("chip-key").textContent = t.reachable ? `api: up${caps.steer ? " · steer" : ""}` : "api: down";
    $("chip-key").title = t.error || `${t.url || ""}${caps.version ? ` · hermes ${caps.version}` : ""}`;
    $("chip-bin").textContent = String(t.url || "").replace(/^https?:\/\//, "") || "no gateway";
    $("chip-bin").title = caps.runCwd
      ? "the gateway advertises per-run cwd — measured 2026-10-27: it is accepted, and a run's tools still start in the gateway's directory, so the prompt carries the path too"
      : "the gateway ignores per-run cwd (hermes-runs-api-knobs.diff not applied) — agents run in the gateway's directory";
    syncProjectPicker(data.spawn.projects || []);
  }
  if (data.skipped) {
    $("skipped-note").textContent = data.skipped.length
      ? `skipped under scanRoots (not git repos): ${data.skipped.map((s) => String(s.dir).split(/[\\/]/).pop()).join(", ")}`
      : "";
  }
  if (data.jobs) {
    applyJobSnapshot(data.jobs);
    renderJobs();
    invalidatePanelMap();
  }
  if (Array.isArray(data.approvals)) {
    state.approvals.clear();
    for (const r of data.approvals) if (r && r.id) state.approvals.set(r.id, r);
    // Instrumented on purpose (0.91.0): `/api/approvals` is the approval-transport plugin's own long-poll feed,
    // while this is what the page's snapshot carried. When the two disagree — the plugin feed empty while a
    // worker is genuinely parked — this line and `state.approvalsSeen` say which feed the reader's card came from.
    const count = state.approvals.size;
    if (count !== state.approvalsSeen.count) {
      state.approvalsSeen = { at: Date.now(), count, ids: [...state.approvals.keys()] };
      console.info(`panel: approvals from /api/state: ${count} pending${count ? ` (${state.approvalsSeen.ids.join(", ")})` : ""}`);
    }
    renderApprovals();
  }
  // The panel's own permission requests travel with the snapshot like the CLI-transport approvals: a reload comes
  // back to the same open question (a push still parked on an answer) rather than losing it.
  if (data.remoteWrites) applyRemoteWrites(data.remoteWrites);
  // The assistant's scratchpad, alerts and thread id travel with the snapshot (assistant.js owns the panel).
  if (data.assistant && typeof applyAssistant === "function") applyAssistant(data.assistant);
  // The reset control's select is drawn from that same roster, so a snapshot is when a newly created assistant
  // becomes a choice here. It keeps the reader's current pick; with one assistant the select stays hidden.
  if (typeof paintResetRow === "function") paintResetRow();
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
    // A project's own activityAt seeds its window once, so the folder order is smoothed from the first paint.
    seedProjectRank(p);
    const wts = Array.isArray(p.worktrees) ? p.worktrees : [];
    if (!wts.length) continue;
    for (const [k, r] of [...state.rows]) if (r.project === p.name) state.rows.delete(k);
    for (const w of wts) {
      const row = { ...w, project: p.name };
      state.rows.set(keyOf(p.name, w.path), row);
      noteScan(row);
      // Seed the ranking windows from the life the row already carries, so the first paint is smoothed.
      seedRankWindows(row);
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
  // A healthy snapshot clears a green confirmation (it was about one gesture, and the board is fine) but never a
  // red one: a failure is the reader's to dismiss with its ✕, and a poll every few seconds would wipe it before it
  // could be read.
  const b = $("banner");
  if (b && b.classList.contains("ok")) hideBanner();
}

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
  // The banner's three sides are measured client lengths written back as layout lengths, so a zoom moves them too.
  placeBanner();
  if (save) {
    try {
      localStorage.setItem(ZOOM_KEY, String(z));
    } catch {
      /* private mode: the zoom just will not persist */
    }
  }
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

// `color` / `size` left out read the stored value; "" / 0 mean the default. Only a value this panel offers is applied
// or kept, so a hand-edited key cannot write nonsense into a stylesheet.
function applyTextStyle(kind, { save = false, color, size } = {}) {
  const set = TEXT_STYLES[kind];
  if (!set) return;
  const root = document.documentElement.style;
  const c = color === undefined ? textStyleColor(kind) : TEXT_COLOR_RE.test(String(color).toLowerCase()) ? String(color).toLowerCase() : "";
  if (c) root.setProperty(set.colorVar, c);
  else root.removeProperty(set.colorVar);
  const input = $(set.color);
  if (input && input.value !== (c || set.fallback)) input.value = c || set.fallback;
  const state = $(set.state);
  if (state) state.textContent = c || "default";
  let n = 0;
  if (set.sizeKey) {
    n = size === undefined ? textStyleSize(kind) : TERM_SIZES.includes(Number(size)) ? Number(size) : 0;
    if (n) root.setProperty(set.sizeVar, `${n}px`);
    else root.removeProperty(set.sizeVar);
    const sel = $(set.size);
    const want = n ? String(n) : "";
    if (sel && sel.value !== want) sel.value = want;
  }
  if (save) {
    try {
      if (c) localStorage.setItem(set.colorKey, c);
      else localStorage.removeItem(set.colorKey);
      if (set.sizeKey) {
        if (n) localStorage.setItem(set.sizeKey, String(n));
        else localStorage.removeItem(set.sizeKey);
      }
    } catch {
      /* private mode: the choice just will not persist */
    }
  }
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

// The whole of a group's open state is these two writes: the attribute the caret and a screen reader read, and the
// body's own `hidden`. Nothing else is stored here, so the search can open a group for the duration of a query
// without touching what the reader chose.
function applySkillsFold(head, body, open) {
  if (head) {
    head.setAttribute("aria-expanded", String(open));
    if (head.dataset.skillsFoldLabel) head.title = skillsFoldTitle(open, head.dataset.skillsFoldLabel);
  }
  if (body) body.hidden = !open;
}

async function applyProviderProfile() {
  const chosen = selectedProfile();
  if (!chosen || !providerStateCache?.editable) return;
  const preview = $("provider-profile-preview");
  if (preview) {
    preview.textContent = `applying ${chosen.name}…`;
    preview.classList.remove("bad");
  }
  try {
    const r = await apiFetch("/api/settings/provider/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: chosen.id }),
    });
    const d = await r.json();
    providerStateCache = d;
    // The key box is emptied on the way through, whether or not the write landed: what it held belonged to
    // the pair just replaced, and a later Save with it still in the box would put that old key back.
    const key = $("provider-key");
    if (key) key.value = "";
    if (!r.ok) {
      paintProviderSetting(d.error || `HTTP ${r.status}`);
      paintProviderProfiles(d.error || `HTTP ${r.status}`);
      return;
    }
    paintProviderSetting();
    paintProviderProfiles();
    showBanner(d.note || `profile "${chosen.name}" applied`);
  } catch (e) {
    paintProviderSetting(e.message);
    paintProviderProfiles(e.message);
  }
}

// What the server answered about the list: what config.json says, whether the fallback is in force, which folder that
// is, what discovery walks, and per-row existence. Every one of those travels in the answer so the tab never has to
// guess a folder's state from a path it typed.
function applyScanRootsAnswer(d) {
  if (!d) return;
  if (Array.isArray(d.scanRootsConfigured)) {
    state.settings = {
      ...(state.settings || {}),
      scanRootsConfigured: d.scanRootsConfigured.map((p) => String(p || "")).filter(Boolean),
      scanRootsFallback: d.scanRootsFallback === true,
      scanRootsFallbackPath: d.scanRootsFallbackPath || state.settings?.scanRootsFallbackPath || "",
    };
  }
  if (Array.isArray(d.scanRoots)) state.scanRoots = d.scanRoots.map((p) => String(p || "")).filter(Boolean);
  if (Array.isArray(d.scanRootsDetail)) {
    state.scanRootsDetail = new Map(d.scanRootsDetail.map((x) => [String(x.path || "").toLowerCase(), { exists: Boolean(x.exists) }]));
  }
}

// Settings that arrive from the SERVER apply here, in one place: a snapshot carries them, and a `settings` event
// carries them after a change made anywhere else (another tab, or "Always allow" in the permission box).
function applySettings(settings) {
  if (!settings) return;
  // Which columns are drawn is the one setting here that changes the table's SHAPE: another tab (or a hand-edited
  // config the panel re-broadcasts) can hide a column, and a board that only repainted its cells would leave the old
  // header over rows that no longer match it.
  const colsBefore = (state.settings?.hiddenColumns || []).join(",");
  state.settings = { ...(state.settings || {}), ...settings };
  paintConfigLine();
  const scanMode = $("scan-mode");
  if (scanMode) scanMode.value = state.settings.scanMode === "visible" ? "visible" : "all";
  paintRemotePolicy();
  // The push controls ride the same snapshot and the same event, so a change made in another tab (or by the
  // permission box's Always allow) is what this page draws — both the Settings sections and every card's pair.
  paintPushPermissions();
  syncPushControls();
  paintChartColumns();
  paintScanRoots();
  paintCollapseAfterSetting();
  // The pane's frame is the panel's now, and a change made in another tab has to re-frame this one: the row on the
  // General tab is painted from these same numbers, and the painter lives in public/assistant.js.
  if (typeof paintGeneralSettings === "function") paintGeneralSettings(state.settings);
  if (typeof window.__assistantFrame === "function") window.__assistantFrame();
  if ((state.settings.hiddenColumns || []).join(",") !== colsBefore) renderAll();
}

