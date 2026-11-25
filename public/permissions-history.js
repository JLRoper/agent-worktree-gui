// permissions-history.js - the floating header's Permissions control: every permission request this panel has held,
// the ones still waiting with the exact request text and the host's own choices, and the record of how the rest ended.
//
// WHAT IT IS. A header button beside Clarify, in the amber the permission box already wears, and a popup that lists
// every permission request the panel's approval transport has presented, newest first: the ones still waiting in full
// colour with the exact request text, the gateway's one-line policy note and one button per choice the HOST allowed;
// the answered ones quiet with the choice a person pressed standing out of the row; and the expired ones saying why
// and how long they waited ("timed out after 4m") instead of looking like a denial somebody chose. Each row names the
// agent, its thread, the gateway run, the tree and the assistant the request belongs to.
//
// WHY IT READS A STORE AND NOT THE PENDING MAP. lib/approvals.js forgets a request the moment it is answered or its
// window closes, and a restart empties it: a popup built from the live map would lose every decision and would call
// every timeout a `deny`. The list therefore comes from the persisted store (lib/permissions-history.js, served by
// routes/permissions-history.js), which records the request when it arrives and settles it when it ends. A restart
// re-reads the file; it never re-derives the history.
//
// THE ONE ANSWER PATH. A choice button posts to the panel's own POST /api/approvals/answer, the same route the board's
// permission box posts to. Nothing here answers anything by itself: no timer, no default, no press that was not the
// reader's. A second press cannot double-answer: the row's buttons are disabled the instant one is pressed, this page
// remembers the request and choice it sent, and the panel itself refuses a second answer (the request left its pending
// map when the first one was accepted).
//
// THE COUNT AND THE NOTIFICATION are the Clarify button's own mechanism, not a second path: `paintCountBadge` paints
// the number, a slow tick reads this route's `outstanding` (`?limit=1`), and the same read is repeated shortly after
// any job or approval frame. There is no toast, no sound and no second popup.
//
// REACHED BY KEYBOARD, SPACE AND POINTER. The button is a real button; the popup is a listbox whose rows carry a
// roving tabindex, so Up/Down step one row per press, Home/End go to the ends, Enter on a row lands on the agent (and,
// on a row still waiting, puts the caret on its first choice), Escape closes and hands the caret back to the button. A
// press outside closes it. It scrolls inside itself, resizes from its corner handle (and drags by its head), and the
// size it was left at is remembered in localStorage `wtgui.permissions.rect`.
//
// THE CAP IS HONEST. 50 rows are drawn, and the footer says "showing 50 of 137" with the store's own total; Show all
// draws the rest. Nothing is ever truncated without the number beside it.
//
// WHAT IT REACHES OUT FOR (by name, at call time): apiFetch, esc, conversations, renderConversation, wtTurnFold,
// assistantSessionFor, hotRowFor, hotOpenPath, keyOf, flashRowMs, showBanner. public/app.js wires the button and calls
// the functions below; the markup is built here, once.
const permissionsHist = {
  el: null,          // the popup, built once and reused
  open: false,
  loading: false,
  error: "",
  entries: [],       // the store's rows, as the route sent them
  pending: [],       // the live requests, keyed by id: what the popup may answer right now
  total: 0,
  kept: 0,
  limit: 0,          // 0 means the render cap; Show all sets it to the total
  active: 0,         // index into the rows currently drawn
  tick: null,        // the 5s read while the popup is open
  clock: null,       // the 1s countdown while the popup is open
  seq: 0,            // guards a slow answer landing after a newer one
  pendingCount: 0,   // requests still waiting on a person - the number on the header button
  pendingAt: 0,      // when that number was last read
  pendingTick: null, // the slow count tick, independent of the popup being open
  pendingOnce: null, // the debounced read after a frame
  sent: new Map(),   // `${id}|${choice}` -> when it was pressed, so one press cannot send twice
};

// The popup's place and size: LAYOUT lengths are written as styles, but every number read back from the page
// (getBoundingClientRect, innerWidth) is a VISUAL length, and Settings > Display's page zoom is the factor between
// them. So the rectangle is kept and clamped in visual px and divided by the zoom only when it is written.
const PH_MIN_W = 400;
const PH_MIN_H = 220;
const PH_MAX_W = 960;
const PH_MAX_H = 820;
const PH_MARGIN = 8;
const PH_GAP = 6;
const PH_SLOP = 3;
const PH_RECT_KEY = "wtgui.permissions.rect";
const PH_POLL_MS = 5000;
const PH_SEND_TTL_MS = 4000;

const phGeo = { rect: null, sized: false, drag: null, resize: null };

const phEsc = (s) =>
  typeof esc === "function"
    ? esc(String(s ?? ""))
    : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const phCore = () => window.wtPermissionsHistory;

// ---- the popup: one panel, built once --------------------------------------------------------------------------
function permissionsHistoryPopEl() {
  if (permissionsHist.el && permissionsHist.el.isConnected) return permissionsHist.el;
  const pop = document.createElement("div");
  pop.id = "permissions-pop";
  pop.className = "ph-pop";
  pop.hidden = true;
  pop.tabIndex = -1;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "permissions - every permission request this panel has held, newest first");
  pop.innerHTML = `
    <div class="ph-head" id="ph-head">
      <span class="ph-dot" aria-hidden="true">⚿</span>
      <span class="ph-title">Permissions</span>
      <span class="ph-count mono" id="ph-count"></span>
      <button id="ph-close" class="ph-close" type="button" title="close (Esc)" aria-label="close the permissions list">✕</button>
    </div>
    <div class="ph-list" id="ph-list" role="listbox" aria-label="permission requests, waiting first"></div>
    <div class="ph-foot" id="ph-foot">
      <span class="ph-foot-text mono" id="ph-foot-text"></span>
      <button id="ph-more" class="ph-more" type="button" hidden>show all</button>
    </div>
    <div class="ph-resize" id="ph-resize" title="drag to resize the list" aria-hidden="true"></div>
  `;
  document.body.append(pop);
  permissionsHist.el = pop;

  pop.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.("#ph-resize")) return phGestureStart(e, "resize");
    const head = e.target.closest?.(".ph-head");
    if (!head || e.target.closest?.("button, input, select, textarea, label, a")) return;
    phGestureStart(e, "drag");
  });
  window.addEventListener("pointermove", phGestureMove);
  window.addEventListener("pointerup", phGestureEnd);
  window.addEventListener("pointercancel", phGestureEnd);

  pop.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest?.("#ph-close")) return permissionsHistoryClose({ focus: true });
    if (t.closest?.("#ph-more")) return permissionsHistoryShowAll();
    // A choice press comes FIRST: pressing a button inside a row must never also open the agent.
    const choice = t.closest?.("[data-ph-choice]");
    if (choice) {
      const id = String(choice.dataset.phId || "");
      const said = String(choice.dataset.phChoice || "");
      if (id && said) void permissionsAnswer(id, said, choice);
      return;
    }
    const row = t.closest?.(".ph-row");
    if (row && !t.closest?.("button, a, input")) return permissionsHistoryOpenRow(Number(row.dataset.seq));
  });

  pop.addEventListener("keydown", permissionsHistoryKeydown);
  return pop;
}

// ---- the rows ---------------------------------------------------------------------------------------------------
// One row per request. The state decides the whole shape: an open row is loud, keeps the request text EXACTLY as the
// gateway sent it (a <pre>, so line breaks and spacing survive) and carries one button per choice the host allowed; an
// answered row is quiet with the choice standing out; an expired row carries its reason instead of a decision, in the
// warning colour, never the answered grey.
function phRowShell(entry, index, cls, body) {
  const active = index === permissionsHist.active;
  const C = phCore();
  const request = C.requestLine(entry);
  return `
    <div class="ph-row ${cls}${active ? " is-active" : ""}" data-seq="${Number(entry.seq) || 0}" role="option" aria-selected="${active ? "true" : "false"}" tabindex="-1" title="${phEsc(request)}">
      ${body}
    </div>`;
}

function phMetaHtml(entry) {
  const C = phCore();
  const names = C.namesOf(entry);
  const age = C.ageText(entry);
  return `
    <span class="ph-meta mono">
      <span class="ph-agent" title="the agent blocked on this request">${phEsc(names.agent)}</span>
      <span class="ph-thread" title="the agent's thread id">${phEsc(names.thread)}</span>
      <span class="ph-run" title="the gateway run that is parked">${phEsc(names.run)}</span>
      <span class="ph-tree" title="the tree the run was working in">${phEsc(names.tree)}</span>
      <span class="ph-assistant" title="the assistant that started the run">${phEsc(names.assistant)}</span>
      ${age ? `<span class="ph-age">asked ${phEsc(age)}</span>` : ""}
    </span>`;
}

/** The live request behind an open row, or null when the route says the panel can no longer answer it. */
function phLiveFor(id) {
  return permissionsHist.pending.find((r) => String(r.id || "") === String(id || "")) || null;
}

function permissionsHistoryRowHtml(entry, index) {
  const C = phCore();
  const state = C.stateOf(entry);
  if (state === "answered") {
    const said = C.choiceText(entry) || "(no choice recorded)";
    const how = `answered by ${phEsc(entry.answeredBy || "the reader")}${entry.answeredAt ? ` · ${phEsc(C.ageText({ askedAt: entry.answeredAt }))}` : ""}`;
    return phRowShell(
      entry,
      index,
      "is-answered",
      `
        <span class="ph-mark ph-mark-answered">✓ answered</span>
        <span class="ph-answer">${phEsc(said)}</span>
        <pre class="ph-cmd is-muted">${phEsc(C.requestLine(entry, 400))}</pre>
        <span class="ph-when mono">${how}</span>
        ${phMetaHtml(entry)}`,
    );
  }
  if (state === "expired") {
    return phRowShell(
      entry,
      index,
      "is-expired",
      `
        <span class="ph-mark ph-mark-expired">✕ ${phEsc(C.closedLine(entry))}</span>
        <span class="ph-q">nobody answered, so nothing was decided here</span>
        <pre class="ph-cmd">${phEsc(C.requestLine(entry, 400))}</pre>
        ${phMetaHtml(entry)}`,
    );
  }
  // OPEN. The live request wins for the text, the choices and the deadline when the route still carries it: that is
  // what the gateway is holding right now, and the row must offer exactly the choices it would accept.
  const live = phLiveFor(String(entry.id || entry.requestId || entry.key || ""));
  const id = String(live?.id || entry.requestId || entry.key || "");
  const command = String(live?.command ?? entry.command ?? "");
  const policy = C.policyLine(live ? { policy: live.policy } : entry);
  const choices = (live?.choices || entry.choices || ["once", "deny"]).map((c) => String(c));
  const deadline = Number(live?.deadline || entry.deadline) || 0;
  const buttons = live
    ? `<span class="ph-choices">${choices
        .map(
          (c) =>
            `<button type="button" class="ph-choice${c === "deny" ? " is-deny" : ""}" data-ph-id="${phEsc(id)}" data-ph-choice="${phEsc(c)}" title="${phEsc(`${C.CHOICE_LABEL[c] || c}: answer this request exactly as the panel's permission box would`)}">${phEsc(C.CHOICE_LABEL[c] || c)}</button>`,
        )
        .join("")}</span>
       <span class="ph-err mono" data-ph-err></span>`
    : `<span class="ph-note mono is-over" data-ph-over>the panel no longer holds this request, so no choice is offered here</span>`;
  return phRowShell(
    entry,
    index,
    "is-open",
    `
      <span class="ph-mark ph-mark-open">● waiting on you</span>
      <span class="ph-when mono" data-ph-until="${deadline || ""}" data-ph-window="${(Number(live?.timeoutSeconds || entry.timeoutSeconds) || 0) * 1000}">${phEsc(C.leftText({ deadline }, Date.now()))}</span>
      <pre class="ph-cmd">${phEsc(command)}</pre>
      ${policy ? `<span class="ph-policy mono" title="the gateway's policy note for this request">⚠ ${phEsc(policy)}</span>` : ""}
      ${buttons}
      ${phMetaHtml(entry)}`,
  );
}

// Repaint the list from `permissionsHist.entries`, drawing at most the current cap and saying the honest total.
function paintPermissionsHistory() {
  const pop = permissionsHistoryPopEl();
  const C = phCore();
  const list = pop.querySelector("#ph-list");
  const foot = pop.querySelector("#ph-foot-text");
  const more = pop.querySelector("#ph-more");
  const count = pop.querySelector("#ph-count");
  if (!C) return;
  const cap = C.capOf(permissionsHist.entries, permissionsHist.limit || C.RENDER_CAP);
  const held = permissionsHist.total || cap.total;
  if (permissionsHist.active >= cap.rows.length) permissionsHist.active = Math.max(0, cap.rows.length - 1);
  const focused = document.activeElement?.closest?.(".ph-row");
  const keep = focused ? Number(focused.dataset.seq) : Number(cap.rows[permissionsHist.active]?.seq || 0);
  if (permissionsHist.error && !cap.total) {
    list.innerHTML = `<div class="ph-none is-error">${phEsc(permissionsHist.error)} <button type="button" class="ph-retry" id="ph-retry">try again</button></div>`;
  } else if (!cap.total) {
    list.innerHTML = `<div class="ph-none">No permission request has reached this panel yet.</div>`;
  } else {
    list.innerHTML = cap.rows.map((e, i) => permissionsHistoryRowHtml(e, i)).join("");
  }
  // The total is the STORE's, so a page cap can never make the count smaller than what exists.
  const shown = permissionsHist.error && !cap.total ? 0 : cap.shown;
  foot.textContent = permissionsHist.error && !cap.total ? "" : C.footText(shown, held);
  more.hidden = !(held > shown && !(permissionsHist.error && !cap.total));
  if (!more.hidden) more.textContent = `show all ${held}`;
  const waiting = Math.max(0, Number(permissionsHist.pendingCount) || 0);
  count.textContent = permissionsHist.loading ? "reading…" : held ? `${held} request${held === 1 ? "" : "s"}${waiting ? ` · ${waiting} waiting` : ""}` : "";
  if (keep) {
    const again = list.querySelector(`.ph-row[data-seq="${CSS.escape(String(keep))}"]`);
    if (again && focused) again.focus({ preventScroll: true });
  }
  list.querySelector("#ph-retry")?.addEventListener("click", () => void permissionsHistoryFetch());
}

// ---- the read ---------------------------------------------------------------------------------------------------
async function permissionsHistoryFetch() {
  permissionsHistoryPopEl();
  permissionsHist.loading = true;
  permissionsHist.error = "";
  const mine = ++permissionsHist.seq;
  paintPermissionsHistory();
  try {
    const res = await apiFetch("/api/permissions/history", { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (mine !== permissionsHist.seq) return; // a newer read already landed
    if (!res.ok) throw new Error(body?.error || `the panel answered HTTP ${res.status}`);
    permissionsHist.entries = Array.isArray(body.entries) ? body.entries : [];
    permissionsHist.pending = Array.isArray(body.pending) ? body.pending : [];
    permissionsHist.total = Number(body.total) || permissionsHist.entries.length;
    permissionsHist.kept = Number(body.kept) || permissionsHist.entries.length;
    if (Number.isFinite(Number(body.outstanding))) setPermissionsPending(Number(body.outstanding));
  } catch (e) {
    if (mine !== permissionsHist.seq) return;
    permissionsHist.error = `the panel could not answer: ${String((e && e.message) || e)}`;
    permissionsHist.entries = [];
    permissionsHist.pending = [];
    permissionsHist.total = 0;
  } finally {
    if (mine === permissionsHist.seq) {
      permissionsHist.loading = false;
      paintPermissionsHistory();
    }
  }
}

// ---- the answer: the panel's own route, and one press at a time -------------------------------------------------
// The ONE thing this file does that changes anything. The same POST the board's permission box sends, with the same
// request id and the same choice key, so a press here and a press there are the same answer to the same question.
//
// A second press cannot send twice: the map below remembers the request and choice for four seconds (a click can be
// delivered twice around a repaint), every button on the row is disabled at the press, and the panel refuses a second
// answer anyway because the request left its pending map when the first was accepted. A refusal is SAID on the row.
function phSentKey(id, choice) {
  return `${id || ""}|${choice || ""}`;
}

function phAlreadySent(id, choice) {
  const at = permissionsHist.sent.get(phSentKey(id, choice));
  return Boolean(at && Date.now() - at < PH_SEND_TTL_MS);
}

async function permissionsAnswer(id, choice, btn) {
  if (!id || !choice) return;
  if (phAlreadySent(id, choice)) return;
  permissionsHist.sent.set(phSentKey(id, choice), Date.now());
  const row = btn?.closest?.(".ph-row");
  const err = row?.querySelector?.("[data-ph-err]");
  row?.querySelectorAll?.("button[data-ph-choice]").forEach((b) => (b.disabled = true));
  if (err) err.textContent = "";
  try {
    const res = await apiFetch("/api/approvals/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, choice }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.ok === false) {
      // Nothing was accepted, so the same choice may be pressed again at once - and the sentence the panel refused
      // with is what the row says, not a silent no-op.
      permissionsHist.sent.delete(phSentKey(id, choice));
      row?.querySelectorAll?.("button[data-ph-choice]").forEach((b) => (b.disabled = false));
      if (err) err.textContent = String(out.error || `the panel answered HTTP ${res.status}`);
      if (String(out.error || "").includes("already-resolved")) {
        // The request was answered an instant ago (here or on the board's box): re-read, so the row becomes the
        // record of the decision instead of an error that reads like a failure of the press.
        void permissionsHistoryFetch();
      }
      return;
    }
    // The decision is the panel's own record now; re-read so the row flips to it, and the count drops in the same tick.
    void permissionsHistoryRefreshCount();
    void permissionsHistoryFetch();
  } catch (e) {
    permissionsHist.sent.delete(phSentKey(id, choice));
    row?.querySelectorAll?.("button[data-ph-choice]").forEach((b) => (b.disabled = false));
    if (err) err.textContent = `the panel could not be reached: ${String((e && e.message) || e)}`;
  }
}

// ---- the count the header button carries -----------------------------------------------------------------------
// The button says how many requests are WAITING, and it is painted by the same code as Human's and Clarify's
// (app.js `paintCountBadge`). THE SOURCE IS /api/state: the snapshot carries the approval transport's live queue in
// `approvals`, public/settings.js applies it, and the approval frames keep that map current - so the badge is a fact
// the board has already received, on the same map the Human button's dock counts, not a request of its own. Only a
// request whose window has not closed counts, so one request counts once and an answered or expired one counts
// nothing. The route read below is the fallback for a page that has not had its first snapshot yet (and it is what
// the popup's own footer counts), so the two never disagree about what is open for longer than one frame.
const PH_COUNT_MS = 4000;
const PH_COUNT_AFTER_FRAME_MS = 1200;

function setPermissionsPending(n) {
  const next = Math.max(0, Math.floor(Number(n) || 0));
  const changed = next !== permissionsHist.pendingCount;
  permissionsHist.pendingCount = next;
  permissionsHist.pendingAt = Date.now();
  if (changed && typeof paintPermissionsButton === "function") paintPermissionsButton();
  if (permissionsHist.open) paintPermissionsHistory();
}

/** How many permission requests are waiting. Read by the header button's painting code. */
function permissionsPendingCount() {
  // /api/state's own list. `approvalsSeen.count` is below zero until the first snapshot has applied `approvals`, so a
  // page that has not painted the board yet reads the route instead of claiming that nothing is waiting.
  if (typeof state !== "undefined" && Number(state?.approvalsSeen?.count) >= 0) {
    const C = phCore();
    return C.openCount(state.approvals instanceof Map ? [...state.approvals.values()] : [], Date.now());
  }
  return Math.max(0, Math.floor(Number(permissionsHist.pendingCount) || 0));
}

async function permissionsHistoryRefreshCount() {
  try {
    const res = await apiFetch("/api/permissions/history?limit=1", { headers: { accept: "application/json" } }, { timeoutMs: 8000 });
    if (!res.ok) return;
    const body = await res.json().catch(() => ({}));
    if (Number.isFinite(Number(body.outstanding))) setPermissionsPending(Number(body.outstanding));
  } catch {
    // A count is not worth a banner: the next tick asks again, and the last number stays on the button.
  }
}

// A frame is the moment a request arrives, is answered or expires. The read is debounced so a burst of frames (a run
// starting, a tree landing) costs one request rather than one per frame. Same debounce, same slow tick, same painting
// as the Clarify button: this is not a second notification path.
function permissionsHistoryHookStream() {
  const es = typeof state !== "undefined" ? state?.es : null;
  if (!es || typeof es.addEventListener !== "function" || es.__permissionsCount) return;
  es.__permissionsCount = true;
  const after = () => {
    clearTimeout(permissionsHist.pendingOnce);
    permissionsHist.pendingOnce = setTimeout(() => void permissionsHistoryRefreshCount(), PH_COUNT_AFTER_FRAME_MS);
  };
  es.addEventListener("jobs", after);
  es.addEventListener("approval", after);
  es.addEventListener("approval-answered", after);
}

function permissionsHistoryCountStart() {
  permissionsHistoryHookStream();
  void permissionsHistoryRefreshCount();
  clearInterval(permissionsHist.pendingTick);
  permissionsHist.pendingTick = setInterval(() => {
    permissionsHistoryHookStream();
    if (document.hidden) return; // a hidden page has nobody reading the button, and the next focus reads again
    void permissionsHistoryRefreshCount();
  }, PH_COUNT_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void permissionsHistoryRefreshCount();
});

// ---- open, close, and the shared press ------------------------------------------------------------------------
function permissionsHistoryIsOpen() {
  return permissionsHist.open;
}

function permissionsHistoryOpen({ focus = true } = {}) {
  const pop = permissionsHistoryPopEl();
  const btn = document.getElementById("btn-permissions");
  permissionsHist.open = true;
  pop.hidden = false;
  btn?.setAttribute("aria-expanded", "true");
  btn?.classList.add("is-open");
  permissionsHistPlace();
  paintPermissionsHistory();
  void permissionsHistoryFetch();
  clearInterval(permissionsHist.tick);
  permissionsHist.tick = setInterval(() => {
    if (!permissionsHist.open) return;
    if (document.hidden) return; // a hidden page has nobody reading it, and the poll resumes on the next open
    void permissionsHistoryFetch();
  }, PH_POLL_MS);
  // The countdown is the page's own clock, like every other deadline on the board: the label counts down and at the
  // deadline the choices go, because the gateway has denied the command by then and a button could only be refused.
  clearInterval(permissionsHist.clock);
  permissionsHist.clock = setInterval(phClockTick, 1000);
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

function phClockTick() {
  const pop = permissionsHist.el;
  if (!pop || pop.hidden) return;
  const C = phCore();
  const now = Date.now();
  for (const when of pop.querySelectorAll("[data-ph-until]")) {
    const until = Number(when.dataset.phUntil) || 0;
    const left = until ? until - now : 0;
    if (!until) continue;
    when.textContent = C.leftText({ deadline: until }, now);
    when.classList.toggle("is-low", left > 0 && left <= 20_000);
    when.classList.toggle("is-over", left <= 0);
    if (left <= 0) {
      const row = when.closest(".ph-row");
      row?.querySelectorAll?.("button[data-ph-choice]").forEach((b) => (b.disabled = true));
      row?.classList.add("is-over");
    }
  }
}

function permissionsHistoryClose({ focus = false } = {}) {
  const pop = permissionsHistoryPopEl();
  permissionsHist.open = false;
  pop.hidden = true;
  document.getElementById("btn-permissions")?.setAttribute("aria-expanded", "false");
  document.getElementById("btn-permissions")?.classList.remove("is-open");
  clearInterval(permissionsHist.tick);
  permissionsHist.tick = null;
  clearInterval(permissionsHist.clock);
  permissionsHist.clock = null;
  if (focus) document.getElementById("btn-permissions")?.focus({ preventScroll: true });
}

function permissionsHistoryToggle() {
  if (permissionsHist.open) permissionsHistoryClose({ focus: true });
  else permissionsHistoryOpen();
}

function permissionsHistoryShowAll() {
  permissionsHist.limit = permissionsHist.total || permissionsHist.kept || 0;
  paintPermissionsHistory();
}

// ---- keyboard --------------------------------------------------------------------------------------------------
// Up/Down step one row, Home/End go to the ends, Enter lands on the row under the caret (and puts the caret on the
// first choice of a row still waiting), Escape closes and hands the caret back to the header button.
function permissionsHistoryKeydown(e) {
  const pop = permissionsHist.el;
  if (!pop) return;
  const rows = [...pop.querySelectorAll(".ph-row")];
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    return permissionsHistoryClose({ focus: true });
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
  } else if (e.key === "Enter" || e.key === " ") {
    // A choice button is a real button and keeps its own Enter; this is for a row that has the caret. On an open row
    // it moves the caret to the first choice rather than answering: only a press on a choice is an answer.
    if (document.activeElement?.closest?.("button")) return;
    e.preventDefault();
    const target = on >= 0 ? rows[on] : rows[permissionsHist.active] || rows[0];
    const first = target.querySelector("button[data-ph-choice]");
    if (first) return first.focus({ preventScroll: true });
    return permissionsHistoryOpenRow(Number(target.dataset.seq));
  } else if (e.key === "Tab" && on < 0) {
    // Tab leaves a listbox; it does not walk fifty rows. The choices inside are real buttons and Tab reaches them
    // from a row, which is why this only applies while the caret is on the popup itself.
    permissionsHistoryClose();
    return;
  }
  if (next == null) return;
  permissionsHist.active = next;
  rows.forEach((r, i) => r.setAttribute("aria-selected", i === next ? "true" : "false"));
  rows.forEach((r, i) => r.classList.toggle("is-active", i === next));
  rows[next].focus({ preventScroll: true });
  rows[next].scrollIntoView({ block: "nearest" });
}

// ---- the landing: the agent, its turn, the amber flash ----------------------------------------------------------
function phClip(s, n = 60) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// The row press: open the agent the request belongs to and page in the turn that parked on it. The flash is the
// worktree links' own animation in the permission box's amber, applied to the row and the card, and re-applied while
// the panel repaints (a repaint builds new nodes, and a class put on the old one is gone before the eye gets there).
function flashPermissionsAgent(thread) {
  const ms = typeof flashRowMs === "function" ? flashRowMs() : 900;
  const hit = (el) => {
    if (!el || el.classList.contains("flash-permissions")) return;
    void el.offsetWidth;
    el.classList.add("flash-permissions");
    clearTimeout(el._permissionsT);
    el._permissionsT = setTimeout(() => el.classList.remove("flash-permissions"), ms + 40);
  };
  const paint = () => {
    if (typeof hotRowFor === "function" && typeof keyOf === "function") {
      const row = hotRowFor(thread);
      if (row) hit(document.querySelector(`tr.row[data-key="${CSS.escape(String(keyOf(row.project, row.path)))}"]`));
    }
    hit(document.querySelector(`.job[data-thread="${CSS.escape(String(thread))}"]`));
  };
  paint();
  clearInterval(permissionsHist.flashTick);
  const until = Date.now() + Math.max(400, ms + 300);
  permissionsHist.flashTick = setInterval(() => {
    paint();
    if (Date.now() >= until) {
      clearInterval(permissionsHist.flashTick);
      permissionsHist.flashTick = null;
    }
  }, 120);
}

/**
 * A row press: open the agent that is blocked (a board row through hotOpenPath, an assistant through its own float),
 * page in the turn the request belongs to, and flash the row amber. Returns false only when the row is gone.
 */
function permissionsHistoryOpenRow(seq) {
  const entry = permissionsHist.entries.find((e) => Number(e.seq) === Number(seq));
  if (!entry) return false;
  permissionsHistoryClose();
  const C = phCore();
  const thread = String(entry.thread || "");
  if (!thread) return false;
  const conv = typeof conversations === "function" ? conversations().find((c) => c.thread === thread) : null;
  const turns = conv ? conv.turns : [];
  const turn = turns.find((t) => t.id === entry.jobId) || null;
  const assistant = typeof assistantSessionFor === "function" ? assistantSessionFor(thread) : null;
  let opened = false;
  if (assistant) {
    if (typeof window.__assistantShowThread === "function" && window.__assistantShowThread(thread)) {
      if (turn && typeof wtTurnFold !== "undefined") wtTurnFold.reveal(state, thread, turns, turn.id);
      if (typeof renderConversation === "function") renderConversation(thread);
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
    opened = Boolean(document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`));
  }
  flashPermissionsAgent(thread);
  if (!turn && typeof showBanner === "function") {
    showBanner(`“${phClip(C.requestLine(entry), 70)}” was asked in a turn this board no longer holds - the agent it was asked on is opened.`);
  }
  return opened || Boolean(turn);
}

// ---- place and size, remembered ---------------------------------------------------------------------------------
function phZoom() {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function phSpace() {
  const vw = Math.max(1, Math.round(window.innerWidth));
  const vh = Math.max(1, Math.round(window.innerHeight));
  return { z: phZoom(), vw, vh, roomW: Math.max(1, vw - PH_MARGIN * 2), roomH: Math.max(1, vh - PH_MARGIN * 2) };
}

function clampPermissionsRect(g, { max = true } = {}) {
  const { vw, vh, roomW, roomH } = phSpace();
  const w = max ? Math.min(Math.max(Math.round(g.w), PH_MIN_W), PH_MAX_W, roomW) : Math.min(Math.max(Math.round(g.w), PH_MIN_W), roomW);
  const h = max ? Math.min(Math.max(Math.round(g.h), PH_MIN_H), PH_MAX_H, roomH) : Math.min(Math.max(Math.round(g.h), PH_MIN_H), roomH);
  const x = Math.min(Math.max(Math.round(g.x), PH_MARGIN), Math.max(PH_MARGIN, vw - w - PH_MARGIN));
  const y = Math.min(Math.max(Math.round(g.y), PH_MARGIN), Math.max(PH_MARGIN, vh - h - PH_MARGIN));
  return { x, y, w, h };
}

function paintPermissionsRect(g) {
  const pop = permissionsHist.el;
  if (!pop) return;
  const { z } = phSpace();
  pop.style.left = `${Math.round(g.x / z)}px`;
  pop.style.top = `${Math.round(g.y / z)}px`;
  pop.style.right = "auto";
  if (!phGeo.sized) return;
  pop.style.width = `${Math.round(g.w / z)}px`;
  pop.style.height = `${Math.round(g.h / z)}px`;
  pop.style.maxHeight = "none";
}

function clearPermissionsRect() {
  const pop = permissionsHist.el;
  if (!pop) return;
  phGeo.rect = null;
  phGeo.sized = false;
  pop.style.width = "";
  pop.style.height = "";
  pop.style.maxHeight = "";
}

function permissionsHistoryStoredRect() {
  try {
    const raw = JSON.parse(localStorage.getItem(PH_RECT_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const r = { x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h) };
    return ["x", "y", "w", "h"].every((k) => Number.isFinite(r[k])) ? r : null;
  } catch {
    return null;
  }
}

function permissionsHistoryForgetRect() {
  try {
    localStorage.removeItem(PH_RECT_KEY);
  } catch {
    /* a private window may refuse the write; the popup still works, it just will not remember */
  }
}

function permissionsHistoryRememberRect(g) {
  try {
    localStorage.setItem(PH_RECT_KEY, JSON.stringify(g));
  } catch {
    /* see above */
  }
}

// Does the remembered rectangle still fit THIS window (after a resize or a raised zoom)? A panel restored off the edge
// is worse than no memory, so a stored rect that no longer fits is dropped rather than quietly clamped.
function permissionsHistoryStoredFits(r) {
  if (!r) return false;
  const { vw, vh } = phSpace();
  return r.w >= PH_MIN_W && r.h >= PH_MIN_H && r.x >= 0 && r.y >= 0 && r.x + r.w <= vw && r.y + r.h <= vh;
}

// Place it: the reader's remembered rectangle when it still fits, otherwise under the button at a width that fits a
// 768-wide window without touching either edge.
function permissionsHistPlace() {
  const pop = permissionsHistoryPopEl();
  const stored = permissionsHistoryStoredRect();
  const { vw, vh } = phSpace();
  if (permissionsHistoryStoredFits(stored)) {
    const g = clampPermissionsRect(stored);
    phGeo.rect = g;
    phGeo.sized = true;
    paintPermissionsRect(g);
    return;
  }
  phGeo.sized = false;
  phGeo.rect = null;
  clearPermissionsRect();
  pop.style.width = `${Math.min(600, Math.max(PH_MIN_W, vw - PH_MARGIN * 2))}px`;
  const btn = document.getElementById("btn-permissions");
  const r = btn?.getBoundingClientRect?.();
  const h = pop.offsetHeight || 380;
  let x = r ? Math.round(r.right - pop.offsetWidth) : PH_MARGIN;
  let y = r ? Math.round(r.bottom + PH_GAP) : PH_MARGIN;
  x = Math.min(Math.max(x, PH_MARGIN), Math.max(PH_MARGIN, vw - pop.offsetWidth - PH_MARGIN));
  y = Math.min(Math.max(y, PH_MARGIN), Math.max(PH_MARGIN, vh - h - PH_MARGIN));
  const { z } = phSpace();
  pop.style.left = `${Math.round(x / z)}px`;
  pop.style.top = `${Math.round(y / z)}px`;
  pop.style.right = "auto";
}

function phGestureStart(e, kind) {
  if (e.button != null && e.button !== 0) return;
  const pop = permissionsHistoryPopEl();
  const r = pop.getBoundingClientRect();
  const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
  phGeo[kind] = { start, moved: false, pointer: e.pointerId };
  phGeo.rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  phGeo.sized = true;
  pop.classList.add(kind === "resize" ? "is-resizing" : "is-dragging");
  try {
    pop.setPointerCapture?.(e.pointerId);
  } catch {
    /* a pointer that cannot be captured still tracks on the window */
  }
  e.preventDefault();
}

function phGestureMove(e) {
  const kind = phGeo.drag ? "drag" : phGeo.resize ? "resize" : null;
  if (!kind) return;
  const g = phGeo[kind];
  if (!g) return;
  const dx = e.clientX - g.start.x;
  const dy = e.clientY - g.start.y;
  if (!g.moved && Math.abs(dx) < PH_SLOP && Math.abs(dy) < PH_SLOP) return;
  g.moved = true;
  const base = phGeo.rect || { x: g.start.left, y: g.start.top, w: g.start.w, h: g.start.h };
  const next =
    kind === "resize"
      ? clampPermissionsRect({ x: base.x, y: base.y, w: g.start.w + dx, h: g.start.h + dy })
      : clampPermissionsRect({ x: g.start.left + dx, y: g.start.top + dy, w: base.w, h: base.h }, { max: false });
  phGeo.rect = next;
  paintPermissionsRect(next);
}

function phGestureEnd() {
  const kind = phGeo.drag ? "drag" : phGeo.resize ? "resize" : null;
  if (!kind) return;
  const g = phGeo[kind];
  phGeo[kind] = null;
  permissionsHist.el?.classList.remove("is-dragging", "is-resizing");
  if (!g?.moved) return;
  if (phGeo.rect) permissionsHistoryRememberRect(phGeo.rect);
}

// A window that changed size can leave a remembered panel off the edge: re-place it when it still fits, otherwise drop
// back to the default under the button. Only while the popup is open and only if the reader moved or sized it.
function permissionsHistoryReposition() {
  if (!permissionsHist.open) return;
  const stored = permissionsHistoryStoredRect();
  if (!permissionsHistoryStoredFits(stored)) {
    permissionsHistoryForgetRect();
    permissionsHistPlace();
    return;
  }
  const g = clampPermissionsRect(stored);
  phGeo.rect = g;
  phGeo.sized = true;
  paintPermissionsRect(g);
}
