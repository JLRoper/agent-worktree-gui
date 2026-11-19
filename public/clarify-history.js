// clarify-history.js - the floating header's Clarify control: every question this panel has asked the reader.
//
// WHAT IT IS. The fourth control in the topbar, after the assistant's entry and the Hot Agent pen and before Human.
// Purple, one glyph, and a popup that lists EVERY clarify question the panel has asked on this board, newest first:
// the ones still unanswered in full colour with their choices, the answered ones greyed with the answer the reader
// actually chose standing out of the row and the question muted behind it, and the ones that went away unanswered
// saying why ("cancelled after 16m"). Each row names the agent, its tree and the assistant that asked.
//
// WHY IT READS A STORE AND NOT THE JOB LIST. `j.question` exists only while a prompt is parked, and `questionDone` is
// one line without the question, its choices or its tree. A popup built from those would forget a question the moment
// it was answered and would be empty after a restart. The list therefore comes from the persisted clarify store
// (lib/clarify-history.js, served by routes/clarify-history.js), which records the ask when it arrives and the answer,
// who and when as it settles. A restart re-reads the file; it never re-derives the history.
//
// WHAT A ROW DOES. One click, two moves plus the landing: the agent that asked is opened (a board row through
// hotOpenPath, an assistant through its own float), the turn that asked is made the current page with
// wtTurnFold.reveal, and the row AND the card take a PURPLE flash (the worktree links' flash row, in the header's
// colour rather than green) while the question box itself is centred and ringed. A question from a previous turn is
// therefore opened as that turn, not merely as that agent.
//
// REACHED BY KEYBOARD, SPACE AND POINTER. The button is a real button; the popup is a listbox whose rows are buttons
// with a roving tabindex, so Up/Down step one row per press, Home/End go to the ends, Enter or Space opens the row
// under the caret, and Escape closes and hands the caret back to the button. A press outside closes it. It scrolls
// inside itself, resizes from its corner handle (and drags by its head), and the size it was left at is remembered in
// localStorage `wtgui.clarify.rect` - the same store and the same shape the deliverables popup uses.
//
// THE CAP IS HONEST. 50 rows are drawn, and the footer says "showing 50 of 137" with the store's own total; Show all
// draws the rest. Nothing is ever truncated without the number beside it.
//
// WHAT IT REACHES OUT FOR (by name, at call time): state, conversations, renderConversation, renderJobs,
// assistantSessionFor, hotRowFor, hotOpenPath, keyOf, flashRowMs, esc, apiFetch, showBanner, programmaticScroll and
// wtTurnFold. public/app.js wires the button and calls the functions below; the markup is built here, once.
const clarifyHist = {
  el: null,          // the popup, built once and reused
  open: false,
  loading: false,
  error: "",
  entries: [],       // the store's rows, newest first, untouched by this file
  total: 0,
  kept: 0,
  limit: 0,          // 0 means the render cap; Show all sets it to the total
  active: 0,         // index into the rows currently drawn
  tick: null,
  seq: 0,            // guards a slow answer landing after a newer one
};

// The popup's place and size: LAYOUT lengths are written as styles, but every number read back from the page
// (getBoundingClientRect, innerWidth) is a VISUAL length, and Settings > Display's page zoom is the factor between
// them. So the rectangle is kept and clamped in visual px and divided by the zoom only when it is written.
const CH_MIN_W = 380;
const CH_MIN_H = 220;
const CH_MAX_W = 900;
const CH_MAX_H = 820;
const CH_MARGIN = 8;
const CH_GAP = 6;
const CH_SLOP = 3;
const CH_RECT_KEY = "wtgui.clarify.rect";
const CH_POLL_MS = 5000;

const chGeo = { rect: null, sized: false, drag: null, resize: null };

const chEsc = (s) =>
  typeof esc === "function"
    ? esc(String(s ?? ""))
    : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const chCore = () => window.wtClarifyHistory;

// ---- the popup: one panel, built once --------------------------------------------------------------------------
function clarifyHistoryPopEl() {
  if (clarifyHist.el && clarifyHist.el.isConnected) return clarifyHist.el;
  const pop = document.createElement("div");
  pop.id = "clarify-pop";
  pop.className = "ch-pop";
  pop.hidden = true;
  pop.tabIndex = -1;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "clarify history - every question this panel has asked you, newest first");
  pop.innerHTML = `
    <div class="ch-head" id="ch-head">
      <span class="ch-dot" aria-hidden="true">?</span>
      <span class="ch-title">Clarify</span>
      <span class="ch-count mono" id="ch-count"></span>
      <button id="ch-close" class="ch-close" type="button" title="close (Esc)" aria-label="close the clarify history">✕</button>
    </div>
    <div class="ch-list" id="ch-list" role="listbox" aria-label="clarify questions, newest first"></div>
    <div class="ch-foot" id="ch-foot">
      <span class="ch-foot-text mono" id="ch-foot-text"></span>
      <button id="ch-more" class="ch-more" type="button" hidden>show all</button>
    </div>
    <div class="ch-resize" id="ch-resize" title="drag to resize the list" aria-hidden="true"></div>
  `;
  document.body.append(pop);
  clarifyHist.el = pop;

  pop.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("#ch-resize")) return chGestureStart(e, "resize");
    const head = e.target.closest?.(".ch-head");
    if (!head || e.target.closest?.("button, input, select, textarea, label, a")) return;
    chGestureStart(e, "drag");
  });
  window.addEventListener("pointermove", chGestureMove);
  window.addEventListener("pointerup", chGestureEnd);
  window.addEventListener("pointercancel", chGestureEnd);

  pop.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest?.("#ch-close")) return clarifyHistoryClose({ focus: true });
    if (t.closest?.("#ch-more")) return clarifyHistoryShowAll();
    const row = t.closest?.(".ch-row");
    if (row) return clarifyHistoryOpenItem(Number(row.dataset.seq));
  });

  pop.addEventListener("keydown", clarifyHistoryKeydown);
  return pop;
}

// ---- the rows ---------------------------------------------------------------------------------------------------
// One row per question. The state decides the whole shape: an open row is loud (a purple marker, the question at full
// weight, its choices as chips), an answered row is quiet except for the answer itself (the question greys out behind
// it), and a closed row carries its reason instead of an answer, in the warning colour, never the answered grey.
function clarifyHistoryRowHtml(entry, index) {
  const C = chCore();
  const state = C.stateOf(entry);
  const names = C.namesOf(entry);
  const question = C.questionLine(entry) || "(the question was not recorded)";
  const age = C.ageText(entry);
  const active = index === clarifyHist.active;
  const meta = `
    <span class="ch-meta mono">
      <span class="ch-agent" title="the agent that asked">${chEsc(names.agent)}</span>
      <span class="ch-tree" title="the tree it asked from">${chEsc(names.tree)}</span>
      <span class="ch-assistant" title="the assistant that asked">${chEsc(names.assistant)}</span>
      ${age ? `<span class="ch-age">${chEsc(age)}</span>` : ""}
    </span>`;
  if (state === "answered") {
    const answer = C.answerText(entry) || "(no answer recorded)";
    return `
      <button type="button" class="ch-row is-answered${active ? " is-active" : ""}" data-seq="${Number(entry.seq) || 0}" role="option" aria-selected="${active ? "true" : "false"}" tabindex="-1" title="${chEsc(question)}">
        <span class="ch-mark ch-mark-answered">✓ answered</span>
        <span class="ch-answer">${chEsc(answer)}</span>
        <span class="ch-q is-muted">${chEsc(question)}</span>
        <span class="ch-when mono">answered by ${chEsc(entry.answeredBy || "the reader")}${entry.answeredAt ? ` · ${chEsc(C.ageText({ askedAt: entry.answeredAt }))}` : ""}</span>
        ${meta}
      </button>`;
  }
  if (state === "closed") {
    return `
      <button type="button" class="ch-row is-closed${active ? " is-active" : ""}" data-seq="${Number(entry.seq) || 0}" role="option" aria-selected="${active ? "true" : "false"}" tabindex="-1" title="${chEsc(question)}">
        <span class="ch-mark ch-mark-closed">✕ ${chEsc(C.closedLine(entry))}</span>
        <span class="ch-q">${chEsc(question)}</span>
        ${meta}
      </button>`;
  }
  const choices = Array.isArray(entry.choices) && entry.choices.length
    ? `<span class="ch-choices">${entry.choices.map((c) => `<span class="ch-choice">${chEsc(c)}</span>`).join("")}</span>`
    : `<span class="ch-choices is-open-answer"><span class="ch-choice is-free">a written answer</span></span>`;
  return `
    <button type="button" class="ch-row is-open${active ? " is-active" : ""}" data-seq="${Number(entry.seq) || 0}" role="option" aria-selected="${active ? "true" : "false"}" tabindex="-1" title="${chEsc(question)}">
      <span class="ch-mark ch-mark-open">● unanswered</span>
      <span class="ch-q">${chEsc(question)}</span>
      ${choices}
      ${meta}
    </button>`;
}

// Repaint the list from `clarifyHist.entries`, drawing at most the current cap and saying the honest total. Focus is
// put back on the row the reader was standing on (by seq), so a poll landing under their hands never moves the caret.
function paintClarifyHistory() {
  const pop = clarifyHistoryPopEl();
  const C = chCore();
  const list = pop.querySelector("#ch-list");
  const foot = pop.querySelector("#ch-foot-text");
  const more = pop.querySelector("#ch-more");
  const count = pop.querySelector("#ch-count");
  if (!C) return;
  const cap = C.capOf(clarifyHist.entries, clarifyHist.limit || C.RENDER_CAP);
  const held = clarifyHist.total || cap.total;
  if (clarifyHist.active >= cap.rows.length) clarifyHist.active = Math.max(0, cap.rows.length - 1);
  const focused = document.activeElement?.closest?.(".ch-row");
  const keep = focused ? Number(focused.dataset.seq) : Number(cap.rows[clarifyHist.active]?.seq || 0);
  if (clarifyHist.error && !cap.total) {
    list.innerHTML = `<div class="ch-none is-error">${chEsc(clarifyHist.error)} <button type="button" class="ch-retry" id="ch-retry">try again</button></div>`;
  } else if (!cap.total) {
    list.innerHTML = `<div class="ch-none">No clarify question has been asked on this panel yet.</div>`;
  } else {
    list.innerHTML = cap.rows.map((e, i) => clarifyHistoryRowHtml(e, i)).join("");
  }
  // The total is the STORE's, so a page cap can never make the count smaller than what exists.
  const shown = clarifyHist.error && !cap.total ? 0 : cap.shown;
  foot.textContent = clarifyHist.error && !cap.total ? "" : C.footText(shown, held);
  more.hidden = !(held > shown && !(clarifyHist.error && !cap.total));
  if (!more.hidden) more.textContent = `show all ${held}`;
  count.textContent = clarifyHist.loading ? "reading…" : held ? `${held} question${held === 1 ? "" : "s"}` : "";
  if (keep) {
    const again = list.querySelector(`.ch-row[data-seq="${CSS.escape(String(keep))}"]`);
    if (again && focused) again.focus({ preventScroll: true });
  }
  list.querySelector("#ch-retry")?.addEventListener("click", () => void clarifyHistoryFetch());
}

// ---- the read ---------------------------------------------------------------------------------------------------
async function clarifyHistoryFetch() {
  const pop = clarifyHistoryPopEl();
  clarifyHist.loading = true;
  clarifyHist.error = "";
  const mine = ++clarifyHist.seq;
  paintClarifyHistory();
  try {
    const res = await apiFetch("/api/clarify/history", { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (mine !== clarifyHist.seq) return; // a newer read already landed
    if (!res.ok) throw new Error(body?.error || `the panel answered HTTP ${res.status}`);
    clarifyHist.entries = Array.isArray(body.entries) ? body.entries : [];
    clarifyHist.total = Number(body.total) || clarifyHist.entries.length;
    clarifyHist.kept = Number(body.kept) || clarifyHist.entries.length;
  } catch (e) {
    if (mine !== clarifyHist.seq) return;
    clarifyHist.error = `the panel could not answer: ${String((e && e.message) || e)}`;
    clarifyHist.entries = [];
    clarifyHist.total = 0;
  } finally {
    if (mine === clarifyHist.seq) {
      clarifyHist.loading = false;
      paintClarifyHistory();
    }
  }
}

// ---- open, close, and the shared press ------------------------------------------------------------------------
function clarifyHistoryIsOpen() {
  return clarifyHist.open;
}

function clarifyHistoryOpen({ focus = true } = {}) {
  const pop = clarifyHistoryPopEl();
  const btn = document.getElementById("btn-clarify");
  clarifyHist.open = true;
  pop.hidden = false;
  btn?.setAttribute("aria-expanded", "true");
  btn?.classList.add("is-open");
  clarifyHistPlace();
  paintClarifyHistory();
  void clarifyHistoryFetch();
  clearInterval(clarifyHist.tick);
  clarifyHist.tick = setInterval(() => {
    if (!clarifyHist.open) return;
    if (document.hidden) return; // a hidden page has nobody reading it, and the poll resumes on the next open
    void clarifyHistoryFetch();
  }, CH_POLL_MS);
  if (focus) {
    // The POPUP takes the caret, not the first row: ArrowDown inside it lands on row one, so opening by keyboard and
    // opening by pointer behave the same and neither steals a row's focus before the reader has read anything.
    try {
      pop.focus({ preventScroll: true });
    } catch {
      pop.focus();
    }
  }
  return pop;
}

function clarifyHistoryClose({ focus = false } = {}) {
  const pop = clarifyHistoryPopEl();
  clarifyHist.open = false;
  pop.hidden = true;
  document.getElementById("btn-clarify")?.setAttribute("aria-expanded", "false");
  document.getElementById("btn-clarify")?.classList.remove("is-open");
  clearInterval(clarifyHist.tick);
  clarifyHist.tick = null;
  if (focus) document.getElementById("btn-clarify")?.focus({ preventScroll: true });
}

function clarifyHistoryToggle() {
  if (clarifyHist.open) clarifyHistoryClose({ focus: true });
  else clarifyHistoryOpen();
}

function clarifyHistoryShowAll() {
  clarifyHist.limit = clarifyHist.total || clarifyHist.kept || 0;
  paintClarifyHistory();
}

// ---- keyboard --------------------------------------------------------------------------------------------------
// Up/Down step one row, Home/End go to the ends, Enter/Space open the row under the caret (or the active one when the
// caret is on the popup itself), Escape closes and hands the caret back to the header button.
function clarifyHistoryKeydown(e) {
  const pop = clarifyHist.el;
  if (!pop) return;
  const rows = [...pop.querySelectorAll(".ch-row")];
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    return clarifyHistoryClose({ focus: true });
  }
  if (!rows.length) return;
  const on = rows.indexOf(document.activeElement);
  let next = null;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (on < 0) next = e.key === "ArrowDown" ? 0 : rows.length - 1;
    else next = Math.min(rows.length - 1, Math.max(0, on + (e.key === "ArrowDown" ? 1 : -1)));
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    next = e.key === "Home" ? 0 : rows.length - 1;
  } else if ((e.key === "Enter" || e.key === " ") && on < 0) {
    // The caret is on the popup (fresh open): the first row is the newest question, which is where the reader starts.
    e.preventDefault();
    return clarifyHistoryOpenItem(Number(rows[clarifyHist.active]?.dataset.seq || rows[0].dataset.seq));
  } else if (e.key === "Tab" && on < 0) {
    // Tab leaves a listbox; it does not walk fifty rows. The popup closes behind the reader.
    clarifyHistoryClose();
    return;
  }
  if (next == null) return;
  clarifyHist.active = next;
  rows.forEach((r, i) => r.setAttribute("aria-selected", i === next ? "true" : "false"));
  rows.forEach((r, i) => r.classList.toggle("is-active", i === next));
  rows[next].focus({ preventScroll: true });
  rows[next].scrollIntoView({ block: "nearest" });
}

// ---- the landing: the agent, its turn, the purple flash, the question ------------------------------------------
function clipText(s, n = 60) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// The purple flash: the same animation the worktree links use on a row (`flash`, the `flashrow` keyframes), in the
// header's violet. Applied to the agent's BOARD row and to its card, because an assistant's agent has no board row.
//
// WHY THIS WATCHES INSTEAD OF TOUCHING THE NODE ONCE. Opening the agent repaints its row (and, for an assistant, its
// card) within a frame or two of the press, and a repaint builds NEW nodes: a class put on the old one is gone before
// the reader's eye gets there - measured at 40 to 90ms, well inside the 900ms animation. So the flash is a short
// watchdog: it paints whatever stands in that row NOW, leaves a live element alone, and re-paints a replaced one until
// the window closes. The animation itself stays the worktree link's own length (`flashRowMs`).
function flashClarifyAgent(thread) {
  const ms = typeof flashRowMs === "function" ? flashRowMs() : 900;
  const hit = (el) => {
    if (!el || el.classList.contains("flash-clarify")) return; // a live element keeps its own animation running
    void el.offsetWidth; // a node that just arrived has no animation to restart, but the reflow makes it deterministic
    el.classList.add("flash-clarify");
    clearTimeout(el._clarifyT);
    el._clarifyT = setTimeout(() => el.classList.remove("flash-clarify"), ms + 40);
  };
  const paint = () => {
    if (typeof hotRowFor === "function" && typeof keyOf === "function") {
      const row = hotRowFor(thread);
      if (row) hit(document.querySelector(`tr.row[data-key="${CSS.escape(String(keyOf(row.project, row.path)))}"]`));
    }
    hit(document.querySelector(`.job[data-thread="${CSS.escape(String(thread))}"]`));
  };
  paint();
  clearInterval(clarifyHist.flashTick);
  const until = Date.now() + Math.max(400, ms + 300);
  clarifyHist.flashTick = setInterval(() => {
    paint();
    if (Date.now() >= until) {
      clearInterval(clarifyHist.flashTick);
      clarifyHist.flashTick = null;
    }
  }, 120);
}

/**
 * A row press: open the agent that asked, make the turn it asked in the CURRENT page (not just the agent), ring that
 * agent's row purple, and put the question in front of the reader. Returns false only when the row is gone.
 *
 * The order matters: the trace is closed FIRST, so a click that fails to reach the agent still leaves the reader on the
 * board rather than behind a panel saying nothing; then the agent's card is opened and the turn is paged in; then the
 * landing and the flash follow whatever the panel actually painted (which can be a frame later).
 */
function clarifyHistoryOpenItem(seq) {
  const entry = clarifyHist.entries.find((e) => Number(e.seq) === Number(seq));
  if (!entry) return false;
  clarifyHistoryClose();
  const C = chCore();
  const thread = String(entry.thread || "");
  const conv = conversations().find((c) => c.thread === thread);
  const turns = conv ? conv.turns : [];
  const turn = turns.find((t) => t.id === entry.jobId) || null;
  const assistant = typeof assistantSessionFor === "function" ? assistantSessionFor(thread) : null;
  let opened = false;
  if (assistant) {
    // An assistant's agent has no board row: its own float is the card, so the thread is shown there and the turn is
    // opened inside it.
    if (typeof window.__assistantShowThread === "function" && window.__assistantShowThread(thread)) {
      if (turn && typeof wtTurnFold !== "undefined") wtTurnFold.reveal(state, thread, turns, turn.id);
      renderConversation(thread);
      opened = true;
    }
  } else {
    if (typeof hotRowFor === "function" && typeof hotOpenPath === "function") {
      const row = hotRowFor(thread);
      if (row) hotOpenPath(row);
    }
    if (state.collapsedJobs?.has(thread)) state.collapsedJobs.delete(thread);
    if (turn && typeof wtTurnFold !== "undefined") wtTurnFold.reveal(state, thread, turns, turn.id);
    if (typeof renderConversation === "function") renderConversation(thread);
    if (typeof renderJobs === "function" && !document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)) renderJobs();
    opened = Boolean(document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`));
  }
  flashClarifyAgent(thread);
  // A turn the store no longer holds cannot be paged in: the agent is opened and the row says why rather than the
  // click doing nothing at all.
  if (!turn && typeof showBanner === "function") {
    showBanner(`“${clipText(C.questionLine(entry), 70)}” was asked in a turn this board no longer holds - the agent it was asked in is opened.`);
  }
  clarifyHistoryLandSoon(entry, thread);
  return opened || Boolean(turn);
}

// The purple ring on a question box or a turn, once per node: a landing that runs a few times while the card settles
// must not restart the animation under the reader's eyes. `_clarifyRung` holds the timer that takes it off.
function clarifyRung(el) {
  if (!el || el._clarifyRung) return;
  el.classList.remove("clarify-flash");
  void el.offsetWidth;
  el.classList.add("clarify-flash");
  el._clarifyRung = setTimeout(() => {
    el.classList.remove("clarify-flash");
    el._clarifyRung = null;
  }, 1900);
}

// Where the question itself lives now. An unanswered row is landed on its BOX: centred, ringed purple, with the first
// answer control under the caret, because answering it is what the reader came for. A settled row is landed on the turn
// that asked, so the answered (or closed) line is read in the place it was written. The CARD is rung when the turn is
// not painted yet, so the press always has an answer on screen.
//
// Every step is idempotent and checks the page before acting (is the box already centred? does it already hold the
// caret?), because this runs a few times while the row's detail is fetched and painted.
function clarifyHistoryLand(entry, thread) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(String(thread))}"]`);
  const turnEl = entry.jobId && card ? card.querySelector(`.turn[data-turn="${CSS.escape(String(entry.jobId))}"]`) : null;
  const target = turnEl || card;
  if (!target) return false;
  const open = chCore().stateOf(entry) === "open";
  const box = turnEl?.querySelector(".turn-question");
  const live = box && !box.classList.contains("is-expired");
  if (!live) {
    // Not the box's moment: the turn is not painted yet, or the question has settled. Ring what is there once.
    if (!target._clarifyRung) {
      const r = target.getBoundingClientRect();
      if (Math.abs(r.top + r.height / 2 - window.innerHeight / 2) > 120) target.scrollIntoView({ block: "center", behavior: "smooth" });
      clarifyRung(target);
    }
    return !open;
  }
  const rect = box.getBoundingClientRect();
  if (Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2) > 120) {
    if (typeof programmaticScroll === "function") programmaticScroll();
    box.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  clarifyRung(box);
  const control = box.querySelector("input[data-qpick], button.tq-choice, textarea.tq-other, button.tq-send");
  if (control && !box.contains(document.activeElement)) {
    try {
      control.focus({ preventScroll: true });
    } catch {
      control.focus();
    }
  }
  return true;
}

// The card is painted by the panel a frame or two after the row is opened (hotOpenPath rebuilds the row's detail, and
// the turns in it are drawn from the jobs read that follows), and that paint REPLACES the nodes a first landing had
// already scrolled, rung and focused. So the landing is a watchdog over the settling itself: it runs now, then every
// 150ms until the window closes, and each pass acts only on what is missing. Three seconds is long enough for the
// detail fetch on a big board and short enough that it is over before the reader's next thought.
function clarifyHistoryLandSoon(entry, thread) {
  const tick = () => {
    clarifyHistoryLand(entry, thread);
  };
  tick();
  clearInterval(clarifyHist.landTick);
  const until = Date.now() + 3000;
  clarifyHist.landTick = setInterval(() => {
    tick();
    if (Date.now() >= until) {
      clearInterval(clarifyHist.landTick);
      clarifyHist.landTick = null;
    }
  }, 150);
}

// ---- place and size, remembered ---------------------------------------------------------------------------------
function chZoom() {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function chSpace() {
  const vw = Math.max(1, Math.round(window.innerWidth));
  const vh = Math.max(1, Math.round(window.innerHeight));
  return { z: chZoom(), vw, vh, roomW: Math.max(1, vw - CH_MARGIN * 2), roomH: Math.max(1, vh - CH_MARGIN * 2) };
}

function clampClarifyRect(g, { max = true } = {}) {
  const { vw, vh, roomW, roomH } = chSpace();
  const w = max
    ? Math.min(Math.max(Math.round(g.w), CH_MIN_W), CH_MAX_W, roomW)
    : Math.min(Math.max(Math.round(g.w), CH_MIN_W), roomW);
  const h = max
    ? Math.min(Math.max(Math.round(g.h), CH_MIN_H), CH_MAX_H, roomH)
    : Math.min(Math.max(Math.round(g.h), CH_MIN_H), roomH);
  const x = Math.min(Math.max(Math.round(g.x), CH_MARGIN), Math.max(CH_MARGIN, vw - w - CH_MARGIN));
  const y = Math.min(Math.max(Math.round(g.y), CH_MARGIN), Math.max(CH_MARGIN, vh - h - CH_MARGIN));
  return { x, y, w, h };
}

function paintClarifyRect(g) {
  const pop = clarifyHist.el;
  if (!pop) return;
  const { z } = chSpace();
  pop.style.left = `${Math.round(g.x / z)}px`;
  pop.style.top = `${Math.round(g.y / z)}px`;
  pop.style.right = "auto";
  if (!chGeo.sized) return;
  pop.style.width = `${Math.round(g.w / z)}px`;
  pop.style.height = `${Math.round(g.h / z)}px`;
  pop.style.maxHeight = "none";
}

function clearClarifyRect() {
  const pop = clarifyHist.el;
  if (!pop) return;
  chGeo.rect = null;
  chGeo.sized = false;
  pop.style.width = "";
  pop.style.height = "";
  pop.style.maxHeight = "";
}

function clarifyHistoryStoredRect() {
  try {
    const raw = JSON.parse(localStorage.getItem(CH_RECT_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const r = { x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h) };
    return ["x", "y", "w", "h"].every((k) => Number.isFinite(r[k])) ? r : null;
  } catch {
    return null;
  }
}

function clarifyHistoryForgetRect() {
  try {
    localStorage.removeItem(CH_RECT_KEY);
  } catch {
    /* a private window may refuse the write; the popup still works, it just will not remember */
  }
}

function clarifyHistoryRememberRect(g) {
  try {
    localStorage.setItem(CH_RECT_KEY, JSON.stringify(g));
  } catch {
    /* see above */
  }
}

// Does the remembered rectangle still fit THIS window (after a resize or a raised zoom)? A panel restored off the edge
// is worse than no memory, so a stored rect that no longer fits is dropped rather than quietly clamped.
function clarifyHistoryStoredFits(r) {
  if (!r) return false;
  const { vw, vh } = chSpace();
  return r.w >= CH_MIN_W && r.h >= CH_MIN_H && r.x >= 0 && r.y >= 0 && r.x + r.w <= vw && r.y + r.h <= vh;
}

// Place it: the reader's remembered rectangle when it still fits, otherwise under the button at a width that fits a
// 768-wide window (the brief's narrow case) without touching either edge.
function clarifyHistPlace() {
  const pop = clarifyHistoryPopEl();
  const stored = clarifyHistoryStoredRect();
  const { vw, vh } = chSpace();
  if (clarifyHistoryStoredFits(stored)) {
    chGeo.rect = stored;
    chGeo.sized = true;
    const g = clampClarifyRect(stored);
    chGeo.rect = g;
    paintClarifyRect(g);
    return;
  }
  chGeo.sized = false;
  chGeo.rect = null;
  clearClarifyRect();
  pop.style.width = `${Math.min(560, Math.max(CH_MIN_W, vw - CH_MARGIN * 2))}px`;
  const btn = document.getElementById("btn-clarify");
  const r = btn?.getBoundingClientRect?.();
  const h = pop.offsetHeight || 380;
  let x = r ? Math.round(r.right - pop.offsetWidth) : CH_MARGIN;
  let y = r ? Math.round(r.bottom + CH_GAP) : CH_MARGIN;
  x = Math.min(Math.max(x, CH_MARGIN), Math.max(CH_MARGIN, vw - pop.offsetWidth - CH_MARGIN));
  y = Math.min(Math.max(y, CH_MARGIN), Math.max(CH_MARGIN, vh - h - CH_MARGIN));
  const { z } = chSpace();
  pop.style.left = `${Math.round(x / z)}px`;
  pop.style.top = `${Math.round(y / z)}px`;
  pop.style.right = "auto";
}

function chGestureStart(e, kind) {
  if (e.button != null && e.button !== 0) return;
  const pop = clarifyHistoryPopEl();
  const r = pop.getBoundingClientRect();
  const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
  chGeo[kind] = { start, moved: false, pointer: e.pointerId };
  chGeo.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  chGeo.sized = true;
  pop.classList.add(kind === "resize" ? "is-resizing" : "is-dragging");
  try {
    pop.setPointerCapture?.(e.pointerId);
  } catch {
    /* a pointer that cannot be captured still tracks on the window */
  }
  e.preventDefault();
}

function chGestureMove(e) {
  const kind = chGeo.drag ? "drag" : chGeo.resize ? "resize" : null;
  if (!kind) return;
  const g = chGeo[kind];
  if (!g) return;
  const dx = e.clientX - g.start.x;
  const dy = e.clientY - g.start.y;
  if (!g.moved && Math.abs(dx) < CH_SLOP && Math.abs(dy) < CH_SLOP) return;
  g.moved = true;
  const base = chGeo.rect || { x: g.start.left, y: g.start.top, w: g.start.w, h: g.start.h };
  const next =
    kind === "resize"
      ? clampClarifyRect({ x: base.x, y: base.y, w: g.start.w + dx, h: g.start.h + dy })
      : clampClarifyRect({ x: g.start.left + dx, y: g.start.top + dy, w: base.w, h: base.h }, { max: false });
  chGeo.rect = next;
  paintClarifyRect(next);
}

function chGestureEnd() {
  const kind = chGeo.drag ? "drag" : chGeo.resize ? "resize" : null;
  if (!kind) return;
  const g = chGeo[kind];
  chGeo[kind] = null;
  const pop = clarifyHist.el;
  pop?.classList.remove("is-dragging", "is-resizing");
  if (!g?.moved) return;
  if (chGeo.rect) clarifyHistoryRememberRect(chGeo.rect);
}

// A window that changed size can leave a remembered panel off the edge: re-place it when it still fits, otherwise drop
// back to the default under the button. Only while the popup is open and only if the reader moved or sized it.
function clarifyHistoryReposition() {
  if (!clarifyHist.open) return;
  const stored = clarifyHistoryStoredRect();
  if (!clarifyHistoryStoredFits(stored)) {
    clarifyHistoryForgetRect();
    clarifyHistPlace();
    return;
  }
  const g = clampClarifyRect(stored);
  chGeo.rect = g;
  chGeo.sized = true;
  paintClarifyRect(g);
}
