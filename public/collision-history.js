// collision-history.js - the floating header's Collisions control: who settled each overlap of two live trees, and which
// pairs are still waiting on a person.
//
// WHAT IT IS. A button beside Clarify, violet like the collision marker on a row, and a popup that lists EVERY collision
// the panel has recorded for this board:
//
//   waiting     a pair the assistants could not settle and git cannot order. Full colour, both trees named and linked
//               to their rows, the shared files, the relation that caused it, and - the line the reader needs before
//               deciding - THE REASON THE PANEL WOULD PICK IF NOBODY RULED (`if nobody rules: worker-two would go first
//               (older cut first)`). The two ruling presses and the note box are on the row, so answering is one press
//               and one line.
//   queued      still in the assistants' pass: a notice sits in their queues, and the row names the queue task the
//               panel filed, so the button and the notice are not two silent views of one pair.
//   ruled       settled, and the record says WHICH RULE: git's one clean direction, the reader's own order (older cut,
//               fewer commits, branch name), the version line, or a person. Auto-ruled pairs are here in HISTORY - they
//               are never on the badge.
//   superseded  a landing carried one side into main after the pair was stamped; history, naming the commit.
//   absent      a verdict: no second side lives, so no order exists for a person to give.
//
// WHY IT READS THE STORE AND NOT THE SNAPSHOT. A row's `collisions` field exists only while the row is live and only for
// the pair's live lane; a settled pair, an auto-ruling and a landing that ended a pair are the record's own history
// (lib/collisions.js `history`). The badge is read from the same route, so the number on the button is the number of
// records the popup will show at the top - never a second count derived from rows that can be archived out from under
// it.
//
// THE BADGE COUNTS ONLY PAIRS WAITING ON A PERSON. `waiting` is the store's own predicate (`lib/collisions.js`
// `waitingOf`): state reader, no finished side. An automatic ruling, a land order, a superseded pair and a verdict all
// count zero. This is the whole point of the button: the reader can see at a glance whether anything is actually
// theirs to decide.
//
// THE FILTER names the three things a reader searches by - a row (directory, path, task number), a branch, or a file.
// It filters the records already read, through `public/core/collision-history.js`, so typing never costs a round trip
// and the total beside it is the store's own.
//
// THE NOTIFICATION MECHANISM IS CLARIFY'S. The count is read on a slow tick, again shortly after a jobs frame or a
// snapshot frame (the two moments a pair can appear, settle or be answered), and painted by the same
// `paintCountBadge` in app.js; opening the popup re-reads at once and polls while it is open. No toast, no second bell.
//
// WHAT IT REACHES OUT FOR (by name, at call time): state, keyOf, hotRowFor, hotOpenPath, programmaticScroll, apiFetch,
// showBanner, showNote, paintCollisionsButton, paintCountBadge. public/app.js wires the button and the outside press.
const collisionHist = {
  el: null,
  open: false,
  loading: false,
  error: "",
  records: [],
  total: 0,
  waiting: 0,
  held: 0,
  limit: 0,
  active: 0,
  filter: "",
  tick: null,
  seq: 0,
  pending: 0,
  pendingAt: 0,
  pendingTick: null,
  pendingOnce: null,
  notes: new Map(), // key -> the reader's typed reason, kept across a repaint
  ruling: new Set(), // keys whose ruling is in flight
  flashTick: null,
};

const CO_MIN_W = 460;
const CO_MIN_H = 260;
const CO_MAX_W = 980;
const CO_MAX_H = 860;
const CO_MARGIN = 8;
const CO_GAP = 6;
const CO_SLOP = 3;
const CO_RECT_KEY = "wtgui.collisions.rect";
const CO_POLL_MS = 5000;
const CO_COUNT_MS = 4000;
const CO_COUNT_AFTER_FRAME_MS = 1200;

const coGeo = { rect: null, sized: false, drag: null, resize: null };

const coEsc = (s) =>
  typeof esc === "function"
    ? esc(String(s ?? ""))
    : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const coCore = () => window.wtCollisionHistory;

// ---- the popup: one panel, built once --------------------------------------------------------------------------
function collisionHistoryPopEl() {
  if (collisionHist.el && collisionHist.el.isConnected) return collisionHist.el;
  const pop = document.createElement("div");
  pop.id = "collisions-pop";
  // The structural classes are Clarify's own (`.ch-pop`, `.ch-head`, `.ch-list`, `.ch-row`, `.ch-foot`): the two panels
  // are one shape and the CSS is one shape, so only what a collision adds is styled under `.co-`.
  pop.className = "ch-pop co-pop";
  pop.hidden = true;
  pop.tabIndex = -1;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "collisions - every pair of live trees this panel has seen, the ones waiting on you first");
  pop.innerHTML = `
    <div class="ch-head" id="co-head">
      <span class="ch-dot co-dot" aria-hidden="true">◆</span>
      <span class="ch-title">Collisions</span>
      <span class="ch-count mono" id="co-count"></span>
      <button id="co-close" class="ch-close" type="button" title="close (Esc)" aria-label="close the collision history">✕</button>
    </div>
    <div class="co-filter">
      <input id="co-q" type="search" autocomplete="off" spellcheck="false" placeholder="filter by row, branch or file" aria-label="filter the collisions by row, branch or file" title="Every token you type must appear in the record: a worktree's directory or path, a branch name, a shared file, or a queue task number. The count beside the box is of the records that answer it, never of the page drawn.">
      <button id="co-q-clear" class="co-q-clear" type="button" title="clear the filter (Esc in the box)" hidden>✕</button>
      <span class="co-q-count mono" id="co-q-count"></span>
    </div>
    <div class="ch-list" id="co-list" role="listbox" aria-label="collisions, the ones waiting on you first"></div>
    <div class="ch-foot" id="co-foot">
      <span class="ch-foot-text mono" id="co-foot-text"></span>
      <button id="co-more" class="ch-more" type="button" hidden>show all</button>
    </div>
    <div class="ch-resize" id="co-resize" title="drag to resize the list" aria-hidden="true"></div>
  `;
  document.body.append(pop);
  collisionHist.el = pop;

  pop.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("#co-resize")) return coGestureStart(e, "resize");
    const head = e.target.closest?.(".ch-head");
    if (!head || e.target.closest?.("button, input, select, textarea, label, a")) return;
    coGestureStart(e, "drag");
  });
  window.addEventListener("pointermove", coGestureMove);
  window.addEventListener("pointerup", coGestureEnd);
  window.addEventListener("pointercancel", coGestureEnd);

  pop.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest?.("#co-close")) return collisionHistoryClose({ focus: true });
    if (t.closest?.("#co-more")) return collisionHistoryShowAll();
    if (t.closest?.("#co-q-clear")) return collisionHistoryClearFilter();
    // A side's own press opens that tree's row on the board and flashes it. It comes before the row's press because the
    // two controls are inside the row.
    const open = t.closest?.(".co-open");
    if (open) {
      e.preventDefault();
      return collisionHistoryOpenSide(String(open.dataset.path || ""), String(open.dataset.project || ""));
    }
    // A ruling press: one of the two sides goes first. It is not the row's press.
    const rule = t.closest?.(".co-rule");
    if (rule) {
      e.preventDefault();
      if (!rule.disabled) void collisionHistoryRule(String(rule.dataset.key || ""), String(rule.dataset.pick || ""), rule);
      return;
    }
    const row = t.closest?.(".ch-row");
    if (row && !t.closest?.("input")) {
      // A press on the row itself opens the first side that still names a tree: the pair's detail is on both rows.
      const first = row.querySelector?.(".co-open");
      if (first) collisionHistoryOpenSide(String(first.dataset.path || ""), String(first.dataset.project || ""));
    }
  });

  pop.addEventListener("keydown", collisionHistoryKeydown);
  // The note is kept in the model, not only in the DOM: the list is rebuilt on every poll and a half-typed reason must
  // survive the repaint under the reader's hands.
  pop.addEventListener("input", (e) => {
    const q = e.target.closest?.("#co-q");
    if (q) return collisionHistorySetFilter(String(q.value || ""));
    const input = e.target.closest?.(".co-note");
    if (!input) return;
    const key = String(input.dataset.key || "");
    if (key) collisionHist.notes.set(key, String(input.value || ""));
  });
  pop.addEventListener("keydown", (e) => {
    const input = e.target.closest?.(".co-note");
    if (!input) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      input.blur();
    }
  });
  return pop;
}

// ---- the rows ---------------------------------------------------------------------------------------------------
function coSideHtml(side, project, mine) {
  if (!side?.path) return `<span class="co-side is-empty">no tree on this side</span>`;
  const task = side.taskId ? `task #${side.taskId}${side.task?.state ? ` (${side.task.state})` : ""}` : "no task row";
  return `
    <span class="co-side${mine ? " is-mine" : ""}">
      <button type="button" class="co-open" data-path="${coEsc(side.path)}" data-project="${coEsc(project || "")}" title="open this tree's row on the board">${coEsc(side.name || side.branch || side.path)}</button>
      <span class="co-branch mono" title="the branch this tree is on">${coEsc(side.branch || "no branch")}</span>
      <span class="co-task mono" title="the queue row standing in this tree, when the board knows one">${coEsc(task)}</span>
    </span>`;
}

function coFilesHtml(rec) {
  const C = coCore();
  const files = C ? C.filesOf(rec) : rec.files || [];
  if (!files.length) return `<span class="co-files-none mono">no shared file</span>`;
  const shown = files.slice(0, 8);
  const rest = files.length - shown.length;
  return `<span class="co-files">${shown.map((f) => `<span class="co-file mono">${coEsc(f)}</span>`).join("")}${rest > 0 ? `<span class="co-file is-more mono">+${rest} more</span>` : ""}</span>`;
}

// The queue rows the panel filed: the notice each owning assistant holds. Named on the row so the button and the
// assistants' queues cannot look like two unrelated views of one pair.
function coFiledHtml(rec) {
  const filed = (Array.isArray(rec.filed) ? rec.filed : []).filter((f) => f && f.taskId);
  if (!filed.length) return "";
  const bits = filed.map((f) => `#${f.taskId} to ${f.assistantId}`);
  return `<span class="co-filed mono" title="the queue row the panel filed for each owning assistant - the notice they act on, which is NOT a second reader surface">filed ${coEsc(bits.join(", "))}</span>`;
}

function coWaitingHtml(rec) {
  const C = coCore();
  const reason = C ? C.reasonLine(rec) : "";
  const detail = C ? C.reasonDetail(rec) : "";
  const files = C ? C.filesText(rec) : "";
  const relation = C ? C.relationText(rec) : "";
  const note = collisionHist.notes.get(rec.key) || "";
  const busy = collisionHist.ruling.has(rec.key);
  const aName = C ? C.sideName(rec.a) : "the first side";
  const bName = C ? C.sideName(rec.b) : "the second side";
  return `
    <span class="ch-mark co-mark co-mark-waiting">● waiting on you</span>
    <span class="co-reason" title="${coEsc(detail || reason)}">${coEsc(reason)}</span>
    <span class="co-pair">${coSideHtml(rec.a, rec.project)}<span class="co-vs mono">vs</span>${coSideHtml(rec.b, rec.project)}</span>
    <span class="co-evidence">
      ${coFilesHtml(rec)}
      ${relation ? `<span class="co-rel mono" title="the relation that caused this pair">${coEsc(relation)}</span>` : `<span class="co-rel mono">${coEsc(files)}</span>`}
      ${coFiledHtml(rec)}
    </span>
    <span class="co-rulebar">
      <input class="co-note" type="text" data-key="${coEsc(rec.key)}" maxlength="600" value="${coEsc(note)}" placeholder="one line: why this order" aria-label="why this side goes first" title="A ruling records who and why: you are the who, and this line is the why, kept on the record with the rule and the time. Press the side's button to rule.">
      <button type="button" class="co-rule" data-key="${coEsc(rec.key)}" data-pick="a"${busy ? " disabled" : ""} title="rule that ${coEsc(aName)} goes first - this line is stored as the reason">◀ ${coEsc(aName)} goes first</button>
      <button type="button" class="co-rule" data-key="${coEsc(rec.key)}" data-pick="b"${busy ? " disabled" : ""} title="rule that ${coEsc(bName)} goes first - this line is stored as the reason">${coEsc(bName)} goes first ▶</button>
    </span>
    <span class="co-meta mono">first seen ${coEsc(C ? C.ageText({ askedAt: rec.firstAt }) : "")}${rec.reportedAt && rec.reportedAt !== rec.firstAt ? ` · reported ${coEsc(C ? C.ageText({ askedAt: rec.reportedAt }) : "")}` : ""}</span>`;
}

function coSettledHtml(rec) {
  const C = coCore();
  const state = C ? C.stateOf(rec) : rec.state;
  const reason = C ? C.reasonLine(rec) : "";
  const detail = C ? C.reasonDetail(rec) : "";
  const relation = C ? C.relationText(rec) : "";
  const note = rec.reason?.note || rec.ruling?.note || "";
  const when = rec.reason?.at ? ` · ${C ? C.ageText({ askedAt: rec.reason.at }) : ""}` : "";
  const mark =
    state === "ruled"
      ? `<span class="ch-mark co-mark co-mark-ruled">✓ ${coEsc(rec.reason?.by === "auto" ? "auto-ruled" : rec.reason?.by === "reader" ? "you ruled" : "settled")}</span>`
      : state === "superseded"
        ? `<span class="ch-mark co-mark co-mark-history">➜ history</span>`
        : state === "absent"
          ? `<span class="ch-mark co-mark co-mark-history">✕ verdict</span>`
          : `<span class="ch-mark co-mark co-mark-queued">◌ in the assistants' pass</span>`;
  return `
    ${mark}
    <span class="co-reason" title="${coEsc(detail || reason)}">${coEsc(reason)}</span>
    <span class="co-pair">${coSideHtml(rec.a, rec.project)}<span class="co-vs mono">vs</span>${coSideHtml(rec.b, rec.project)}</span>
    <span class="co-evidence">
      ${coFilesHtml(rec)}
      ${relation ? `<span class="co-rel mono">${coEsc(relation)}</span>` : ""}
      ${coFiledHtml(rec)}
    </span>
    ${note ? `<span class="co-note-read mono" title="the reason written with the ruling">“${coEsc(note)}”${coEsc(when)}</span>` : ""}`;
}

function coRowHtml(rec, index) {
  const C = coCore();
  const waiting = C ? C.isWaiting(rec) : Boolean(rec.waiting);
  const state = C ? C.stateOf(rec) : rec.state;
  const active = index === collisionHist.active;
  const title = C ? `${C.pairText(rec)} · ${C.reasonLine(rec)}` : rec.key;
  return `
    <div class="ch-row co-row is-${coEsc(state)}${active ? " is-active" : ""}" data-key="${coEsc(rec.key)}" role="option" aria-selected="${active ? "true" : "false"}" tabindex="-1" title="${coEsc(title)}">
      ${waiting ? coWaitingHtml(rec) : coSettledHtml(rec)}
    </div>`;
}

// Repaint the list from `collisionHist.records`, filtered by the box through the core, drawing at most the current cap
// and saying the honest total. Focus is put back on the row the reader was standing on, so a poll landing under their
// hands never moves the caret.
function paintCollisionHistory() {
  const pop = collisionHistoryPopEl();
  const C = coCore();
  const list = pop.querySelector("#co-list");
  const foot = pop.querySelector("#co-foot-text");
  const more = pop.querySelector("#co-more");
  const count = pop.querySelector("#co-count");
  const qCount = pop.querySelector("#co-q-count");
  const clear = pop.querySelector("#co-q-clear");
  if (!C) return;
  const filtered = C.filterRecords(collisionHist.records, collisionHist.filter);
  const cap = C.capOf(filtered, collisionHist.limit || C.RENDER_CAP);
  const held = collisionHist.total || cap.total;
  if (collisionHist.active >= cap.rows.length) collisionHist.active = Math.max(0, cap.rows.length - 1);
  const focused = document.activeElement?.closest?.(".ch-row");
  const keep = focused ? String(focused.dataset.key || "") : String(cap.rows[collisionHist.active]?.key || "");
  if (collisionHist.error && !cap.total) {
    list.innerHTML = `<div class="ch-none is-error">${coEsc(collisionHist.error)} <button type="button" class="ch-retry" id="co-retry">try again</button></div>`;
  } else if (!cap.total) {
    list.innerHTML = collisionHist.filter
      ? `<div class="ch-none">No collision names “${coEsc(collisionHist.filter)}”.</div>`
      : `<div class="ch-none">No collision has been seen on this board yet.</div>`;
  } else {
    list.innerHTML = cap.rows.map((rec, i) => coRowHtml(rec, i)).join("");
  }
  const shown = collisionHist.error && !cap.total ? 0 : cap.shown;
  foot.textContent = collisionHist.error && !cap.total ? "" : C.footText(shown, held);
  more.hidden = !(held > shown && !(collisionHist.error && !cap.total));
  if (!more.hidden) more.textContent = `show all ${held}`;
  const waiting = collisionHist.waiting;
  count.textContent = collisionHist.loading && !held ? "reading…" : waiting ? `${waiting} waiting` : held ? `${held} recorded` : "";
  if (qCount) {
    if (collisionHist.filter) {
      qCount.hidden = false;
      qCount.textContent = `${cap.total} of ${held}`;
    } else {
      qCount.hidden = true;
      qCount.textContent = "";
    }
  }
  if (clear) clear.hidden = !collisionHist.filter;
  if (keep) {
    const again = list.querySelector(`.ch-row[data-key="${CSS.escape(keep)}"]`);
    if (again && focused) again.focus({ preventScroll: true });
  }
  list.querySelector("#co-retry")?.addEventListener("click", () => void collisionHistoryFetch());
}

// ---- the read ---------------------------------------------------------------------------------------------------
async function collisionHistoryFetch() {
  const pop = collisionHistoryPopEl();
  collisionHist.loading = true;
  collisionHist.error = "";
  const mine = ++collisionHist.seq;
  paintCollisionHistory();
  try {
    const res = await apiFetch("/api/collisions/history", { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (mine !== collisionHist.seq) return;
    if (!res.ok) throw new Error(body?.error || `the panel answered HTTP ${res.status}`);
    collisionHist.records = Array.isArray(body.records) ? body.records : [];
    collisionHist.total = Number(body.total) || collisionHist.records.length;
    collisionHist.held = Number(body.held) || collisionHist.records.length;
    if (Number.isFinite(Number(body.waiting))) setCollisionPending(Number(body.waiting));
  } catch (e) {
    if (mine !== collisionHist.seq) return;
    collisionHist.error = `the panel could not answer: ${String((e && e.message) || e)}`;
    collisionHist.records = [];
    collisionHist.total = 0;
  } finally {
    if (mine === collisionHist.seq) {
      collisionHist.loading = false;
      paintCollisionHistory();
    }
  }
}

// ---- the count the header button carries -----------------------------------------------------------------------
// The button says how many pairs are WAITING ON A PERSON, read from the same route that fills the popup and counted by
// the store's own `waitingOf`. An automatic ruling is history the moment it is made, so it never raises this number.
function setCollisionPending(n) {
  const next = Math.max(0, Math.floor(Number(n) || 0));
  const changed = next !== collisionHist.pending;
  collisionHist.pending = next;
  collisionHist.pendingAt = Date.now();
  if (changed && typeof paintCollisionsButton === "function") paintCollisionsButton();
}

/** How many collisions are waiting on a person. Read by the header button's painting code in app.js. */
function collisionPendingCount() {
  return Math.max(0, Number(collisionHist.pending) || 0);
}

async function collisionHistoryRefreshCount() {
  try {
    const res = await apiFetch("/api/collisions/history?limit=1", { headers: { accept: "application/json" } }, { timeoutMs: 8000 });
    if (!res.ok) return;
    const body = await res.json().catch(() => ({}));
    if (Number.isFinite(Number(body.waiting))) setCollisionPending(Number(body.waiting));
  } catch {
    // A count is not worth a banner: the next tick asks again, and the last number stays on the button.
  }
}

// The two frames that can change this number: a JOB frame (a side's task closed, so the pair may have stood down) and a
// SNAPSHOT frame (the sweep filed, settled or handed a pair over and told every open page). Debounced, so a burst of
// frames costs one request rather than one per frame.
function collisionHistoryHookStream() {
  const es = typeof state !== "undefined" ? state?.es : null;
  if (!es || typeof es.addEventListener !== "function" || es.__collisionCount) return;
  es.__collisionCount = true;
  const soon = () => {
    clearTimeout(collisionHist.pendingOnce);
    collisionHist.pendingOnce = setTimeout(() => void collisionHistoryRefreshCount(), CO_COUNT_AFTER_FRAME_MS);
  };
  es.addEventListener("jobs", soon);
  es.addEventListener("snapshot", soon);
}

function collisionHistoryCountStart() {
  collisionHistoryHookStream();
  void collisionHistoryRefreshCount();
  clearInterval(collisionHist.pendingTick);
  collisionHist.pendingTick = setInterval(() => {
    collisionHistoryHookStream();
    if (document.hidden) return; // a hidden page has nobody reading the button, and the next focus reads again
    void collisionHistoryRefreshCount();
  }, CO_COUNT_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void collisionHistoryRefreshCount();
});

// ---- open, close, and the shared press ------------------------------------------------------------------------
function collisionHistoryIsOpen() {
  return collisionHist.open;
}

function collisionHistoryOpen({ focus = true } = {}) {
  const pop = collisionHistoryPopEl();
  const btn = document.getElementById("btn-collisions");
  collisionHist.open = true;
  pop.hidden = false;
  btn?.setAttribute("aria-expanded", "true");
  btn?.classList.add("is-open");
  collisionHistoryPlace();
  paintCollisionHistory();
  void collisionHistoryFetch();
  clearInterval(collisionHist.tick);
  collisionHist.tick = setInterval(() => {
    if (!collisionHist.open) return;
    if (document.hidden) return; // a hidden page has nobody reading it, and the poll resumes on the next open
    void collisionHistoryFetch();
  }, CO_POLL_MS);
  if (focus) {
    try {
      pop.focus({ preventScroll: true });
    } catch {
      pop.focus();
    }
  }
  return pop;
}

function collisionHistoryClose({ focus = false } = {}) {
  const pop = collisionHistoryPopEl();
  collisionHist.open = false;
  pop.hidden = true;
  document.getElementById("btn-collisions")?.setAttribute("aria-expanded", "false");
  document.getElementById("btn-collisions")?.classList.remove("is-open");
  clearInterval(collisionHist.tick);
  collisionHist.tick = null;
  if (focus) document.getElementById("btn-collisions")?.focus({ preventScroll: true });
}

function collisionHistoryToggle() {
  if (collisionHist.open) collisionHistoryClose({ focus: true });
  else collisionHistoryOpen();
}

function collisionHistoryShowAll() {
  collisionHist.limit = collisionHist.total || collisionHist.held || 0;
  paintCollisionHistory();
}

function collisionHistorySetFilter(text) {
  collisionHist.filter = String(text || "").trim();
  collisionHist.active = 0;
  paintCollisionHistory();
}

function collisionHistoryClearFilter() {
  const input = collisionHistoryPopEl().querySelector("#co-q");
  if (input) input.value = "";
  collisionHistorySetFilter("");
  input?.focus({ preventScroll: true });
}

// ---- keyboard --------------------------------------------------------------------------------------------------
// Up/Down step one row, Home/End go to the ends, Escape closes and hands the caret back to the header button. A press on
// a row's own control (a side link, a ruling press) belongs to that control: the browser turns Enter/Space into a
// click, and swallowing it here is how a keyboard reader could never rule on anything.
function collisionHistoryKeydown(e) {
  const pop = collisionHist.el;
  if (!pop) return;
  if (e.key === "Escape") {
    if (e.target?.closest?.(".co-note")) return; // the note box's own handler blurs it first
    // Escape in the FILTER clears the filter rather than closing the popup under a reader who is narrowing a list.
    if (e.target?.closest?.("#co-q") && collisionHist.filter) {
      e.preventDefault();
      e.stopPropagation();
      return collisionHistoryClearFilter();
    }
    e.preventDefault();
    e.stopPropagation();
    return collisionHistoryClose({ focus: true });
  }
  if (e.target?.closest?.("#co-q")) return;
  if (e.target?.closest?.(".co-note")) return;
  const rows = [...pop.querySelectorAll(".ch-row")];
  if (!rows.length) return;
  if (e.target?.closest?.(".co-rule, .co-open")) return;
  const on = rows.indexOf(document.activeElement);
  let next = null;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (on < 0) next = e.key === "ArrowDown" ? 0 : rows.length - 1;
    else next = Math.min(rows.length - 1, Math.max(0, on + (e.key === "ArrowDown" ? 1 : -1)));
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    next = e.key === "Home" ? 0 : rows.length - 1;
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const target = on >= 0 ? rows[on] : rows[collisionHist.active] || rows[0];
    const first = target.querySelector(".co-open");
    if (first) collisionHistoryOpenSide(String(first.dataset.path || ""), String(first.dataset.project || ""));
    return;
  } else if (e.key === "Tab" && on < 0) {
    collisionHistoryClose();
    return;
  }
  if (next == null) return;
  collisionHist.active = next;
  rows.forEach((r, i) => r.setAttribute("aria-selected", i === next ? "true" : "false"));
  rows.forEach((r, i) => r.classList.toggle("is-active", i === next));
  rows[next].focus({ preventScroll: true });
  rows[next].scrollIntoView({ block: "nearest" });
}

// ---- the landing: a side's row, and the violent flash the collision marker owns --------------------------------
function coRowFor(path, project) {
  if (typeof state === "undefined" || !state?.rows) return null;
  const want = String(path || "");
  if (!want) return null;
  if (typeof keyOf === "function") {
    const hit = state.rows.get(keyOf(project, want));
    if (hit) return hit;
  }
  for (const row of state.rows.values()) {
    if (String(row.path || "").toLowerCase() === want.toLowerCase()) return row;
  }
  return null;
}

function coFlash(el) {
  if (!el) return;
  el.classList.remove("co-flash");
  void el.offsetWidth;
  el.classList.add("co-flash");
  clearTimeout(el._coFlashT);
  el._coFlashT = setTimeout(() => el.classList.remove("co-flash"), 1900);
}

/** A side's press: open that tree's row on the board, scroll it into view and ring it in the collision violet. */
function collisionHistoryOpenSide(path, project) {
  const row = coRowFor(path, project);
  if (!row) {
    if (typeof showBanner === "function") showBanner(`that tree is not on this board any more: ${path}`);
    return false;
  }
  collisionHistoryClose();
  if (typeof hotOpenPath === "function") hotOpenPath(row);
  if (typeof programmaticScroll === "function") programmaticScroll();
  const key = typeof keyOf === "function" ? keyOf(row.project, row.path) : null;
  const tick = () => {
    const el = key ? document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`) : null;
    if (el) coFlash(el);
    const card = document.querySelector(`.job[data-thread="${CSS.escape(String(row.agent || ""))}"]`);
    if (card) coFlash(card);
  };
  tick();
  clearInterval(collisionHist.flashTick);
  const until = Date.now() + 1600;
  collisionHist.flashTick = setInterval(() => {
    tick();
    if (Date.now() >= until) {
      clearInterval(collisionHist.flashTick);
      collisionHist.flashTick = null;
    }
  }, 150);
  return true;
}

/**
 * A ruling press: which side goes first, and the reader's one line saying why. The note is REQUIRED by this page and
 * stored by the route as `note`; the route stamps `by` and `at`, so the record carries who ruled and when. The pair
 * leaves the waiting list the moment the route answers, and the repaint shows it in history with its rule.
 */
async function collisionHistoryRule(key, pick, btn = null) {
  const k = String(key || "");
  if (!k || (pick !== "a" && pick !== "b") || collisionHist.ruling.has(k)) return false;
  const rowEl = collisionHist.el?.querySelector?.(`.ch-row[data-key="${CSS.escape(k)}"]`);
  const input = rowEl?.querySelector?.(".co-note");
  const note = String(collisionHist.notes.get(k) || input?.value || "").trim();
  if (!note) {
    if (typeof showBanner === "function") showBanner("a ruling needs one line saying why - type it in the row's box, then press the side that goes first");
    input?.focus?.();
    return false;
  }
  collisionHist.ruling.add(k);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "ruling…";
  }
  try {
    const res = await apiFetch("/api/collisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "rule", key: k, pick, note }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok !== true) {
      if (typeof showBanner === "function") showBanner(String(body?.error || `the ruling was refused (HTTP ${res.status})`));
      void collisionHistoryFetch();
      return false;
    }
    collisionHist.notes.delete(k);
    if (typeof showNote === "function") showNote(String(body.say || "the pair is ruled"));
    void collisionHistoryFetch();
    return true;
  } catch (e) {
    if (typeof showBanner === "function") showBanner(`the ruling did not reach the panel: ${String((e && e.message) || e)}`);
    return false;
  } finally {
    collisionHist.ruling.delete(k);
    if (btn && btn.isConnected) {
      btn.disabled = false;
      const rec = collisionHist.records.find((r) => r.key === k);
      const C = coCore();
      const name = rec ? (pick === "a" ? C?.sideName(rec.a) : C?.sideName(rec.b)) : "that side";
      btn.textContent = pick === "a" ? `◀ ${name} goes first` : `${name} goes first ▶`;
    }
    paintCollisionHistory();
  }
}

// ---- place and size, remembered --------------------------------------------------------------------------------
function coZoom() {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function coSpace() {
  const vw = Math.max(1, Math.round(window.innerWidth));
  const vh = Math.max(1, Math.round(window.innerHeight));
  return { z: coZoom(), vw, vh, roomW: Math.max(1, vw - CO_MARGIN * 2), roomH: Math.max(1, vh - CO_MARGIN * 2) };
}

function clampCollisionRect(g, { max = true } = {}) {
  const { vw, vh, roomW, roomH } = coSpace();
  const w = max ? Math.min(Math.max(Math.round(g.w), CO_MIN_W), CO_MAX_W, roomW) : Math.min(Math.max(Math.round(g.w), CO_MIN_W), roomW);
  const h = max ? Math.min(Math.max(Math.round(g.h), CO_MIN_H), CO_MAX_H, roomH) : Math.min(Math.max(Math.round(g.h), CO_MIN_H), roomH);
  const x = Math.min(Math.max(Math.round(g.x), CO_MARGIN), Math.max(CO_MARGIN, vw - w - CO_MARGIN));
  const y = Math.min(Math.max(Math.round(g.y), CO_MARGIN), Math.max(CO_MARGIN, vh - h - CO_MARGIN));
  return { x, y, w, h };
}

function paintCollisionRect(g) {
  const pop = collisionHist.el;
  if (!pop) return;
  const { z } = coSpace();
  pop.style.left = `${Math.round(g.x / z)}px`;
  pop.style.top = `${Math.round(g.y / z)}px`;
  pop.style.right = "auto";
  if (!coGeo.sized) return;
  pop.style.width = `${Math.round(g.w / z)}px`;
  pop.style.height = `${Math.round(g.h / z)}px`;
  pop.style.maxHeight = "none";
}

function clearCollisionRect() {
  const pop = collisionHist.el;
  if (!pop) return;
  coGeo.rect = null;
  coGeo.sized = false;
  pop.style.width = "";
  pop.style.height = "";
  pop.style.maxHeight = "";
}

function collisionHistoryStoredRect() {
  try {
    const raw = JSON.parse(localStorage.getItem(CO_RECT_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const r = { x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h) };
    return ["x", "y", "w", "h"].every((k) => Number.isFinite(r[k])) ? r : null;
  } catch {
    return null;
  }
}

function collisionHistoryForgetRect() {
  try {
    localStorage.removeItem(CO_RECT_KEY);
  } catch {
    /* a private window may refuse the write; the popup still works, it just will not remember */
  }
}

function collisionHistoryRememberRect(g) {
  try {
    localStorage.setItem(CO_RECT_KEY, JSON.stringify(g));
  } catch {
    /* see above */
  }
}

function collisionHistoryStoredFits(r) {
  if (!r) return false;
  const { vw, vh } = coSpace();
  return r.w >= CO_MIN_W && r.h >= CO_MIN_H && r.x >= 0 && r.y >= 0 && r.x + r.w <= vw && r.y + r.h <= vh;
}

// Under the button when nothing is remembered, at a width that fits a narrow window without touching either edge.
function collisionHistoryPlace() {
  const pop = collisionHistoryPopEl();
  const stored = collisionHistoryStoredRect();
  const { vw, vh } = coSpace();
  if (collisionHistoryStoredFits(stored)) {
    const g = clampCollisionRect(stored);
    coGeo.rect = g;
    coGeo.sized = true;
    paintCollisionRect(g);
    return;
  }
  coGeo.sized = false;
  coGeo.rect = null;
  clearCollisionRect();
  pop.style.width = `${Math.min(620, Math.max(CO_MIN_W, vw - CO_MARGIN * 2))}px`;
  const btn = document.getElementById("btn-collisions");
  const r = btn?.getBoundingClientRect?.();
  const h = pop.offsetHeight || 420;
  let x = r ? Math.round(r.right - pop.offsetWidth) : CO_MARGIN;
  let y = r ? Math.round(r.bottom + CO_GAP) : CO_MARGIN;
  x = Math.min(Math.max(x, CO_MARGIN), Math.max(CO_MARGIN, vw - pop.offsetWidth - CO_MARGIN));
  y = Math.min(Math.max(y, CO_MARGIN), Math.max(CO_MARGIN, vh - h - CO_MARGIN));
  const { z } = coSpace();
  pop.style.left = `${Math.round(x / z)}px`;
  pop.style.top = `${Math.round(y / z)}px`;
  pop.style.right = "auto";
}

function coGestureStart(e, kind) {
  if (e.button != null && e.button !== 0) return;
  const pop = collisionHistoryPopEl();
  const r = pop.getBoundingClientRect();
  const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
  coGeo[kind] = { start, moved: false, pointer: e.pointerId };
  coGeo.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  coGeo.sized = true;
  pop.classList.add(kind === "resize" ? "is-resizing" : "is-dragging");
  try {
    pop.setPointerCapture?.(e.pointerId);
  } catch {
    /* a pointer that cannot be captured still tracks on the window */
  }
  e.preventDefault();
}

function coGestureMove(e) {
  const kind = coGeo.drag ? "drag" : coGeo.resize ? "resize" : null;
  if (!kind) return;
  const g = coGeo[kind];
  if (!g) return;
  const dx = e.clientX - g.start.x;
  const dy = e.clientY - g.start.y;
  if (!g.moved && Math.abs(dx) < CO_SLOP && Math.abs(dy) < CO_SLOP) return;
  g.moved = true;
  const base = coGeo.rect || { x: g.start.left, y: g.start.top, w: g.start.w, h: g.start.h };
  const next =
    kind === "resize"
      ? clampCollisionRect({ x: base.x, y: base.y, w: g.start.w + dx, h: g.start.h + dy })
      : clampCollisionRect({ x: g.start.left + dx, y: g.start.top + dy, w: base.w, h: base.h }, { max: false });
  coGeo.rect = next;
  paintCollisionRect(next);
}

function coGestureEnd() {
  const kind = coGeo.drag ? "drag" : coGeo.resize ? "resize" : null;
  if (!kind) return;
  const g = coGeo[kind];
  coGeo[kind] = null;
  const pop = collisionHist.el;
  pop?.classList.remove("is-dragging", "is-resizing");
  if (!g?.moved) return;
  if (coGeo.rect) collisionHistoryRememberRect(coGeo.rect);
}

function collisionHistoryReposition() {
  if (!collisionHist.open) return;
  const stored = collisionHistoryStoredRect();
  if (!collisionHistoryStoredFits(stored)) {
    collisionHistoryForgetRect();
    collisionHistoryPlace();
    return;
  }
  const g = clampCollisionRect(stored);
  coGeo.rect = g;
  coGeo.sized = true;
  paintCollisionRect(g);
}
