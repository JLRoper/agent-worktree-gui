// Worktree Monitor — the assistant's client half.
//
// One header button, one floating panel, and inside it the assistant's own agent card. The card is built by
// app.js's own renderer (conversationHtml / renderConversation), so it is not a lookalike: it has the console,
// the reply box, steering, approvals and the usage readout because it IS one of those cards. This file owns the
// float around it, the alerts list, the watchlist, the scratchpad and the settings.
//
// Loaded as a classic script after app.js, so `state`, `$`, `esc`, `conversations`, `conversationHtml` and the
// rest of app.js's top-level bindings are in scope. app.js calls exactly one function here: applyAssistant().
(() => {
  "use strict";

  const OPEN_KEY = "wm.assistantOpen";
  // The dock's width, in LAYOUT px — the unit a CSS width is written in — so it means the same thing at every page
  // zoom. The rect this replaced remembered a position and a size for a window that could be dragged anywhere.
  const DOCK_KEY = "wm.assistantWidth";
  const DOCK_MIN = 340;
  const DOCK_MAX = 640;
  const DOCK_SHARE = 0.6;
  const DOCK_DEFAULT = 480;
  // ---- the frame's other mode: the float ----------------------------------------------------------
  // Which one is on screen is the ASSISTANT's setting (`dock`, in that assistant's own settings file), not a panel
  // switch: #2 can float while #1 stays docked, and the page re-frames on a tab change. What the float remembers is
  // its rect, kept beside the rail's width rather than replacing it — switching back to the rail must not lose the
  // width the reader dragged, and switching to the float must not lose the place they left it at.
  const FLOAT_KEY = "wm.assistantFloat";
  const FLOAT_MIN_W = 320;
  const FLOAT_MIN_H = 320;
  // Air kept between the float and every viewport edge, in client px. The float is laid out in the LAYOUT viewport
  // (`documentElement.clientWidth/Height`, which already excludes the classic scrollbar) — see `viewportBox`.
  const FLOAT_EDGE = 8;
  const SEEN_KEY = "wm.assistantSeenAt";
  // ---- the float's two rows: what it remembers, and how it is painted -----------------------------
  const VIEW_KEY = "wm.assistantView";
  // The one-tab record this replaced: a reader who left the float on "chat" or "settings" is moved onto the new
  // shape once, and this key is never written again.
  const TAB_KEY = "wm.assistantTab";
  // The panes that belong to the PANEL, not to one assistant. Role is a library every assistant picks a role from,
  // the watchdog is the panel's own sentry, and the Bridge is the panel's one Matrix/Element agent — none is one
  // session's to own, so all three stay on the float's row. Everything else that used to be here (alerts, watches,
  // messages, the pad) is a session's OWN: it moved into SUBTABS, where each pane is filled for the assistant whose
  // tab it sits in.
  const LISTS = ["role", "watchdog", "bridge"];
  // What a session holds: the card you talk to, how it behaves, the work it is carrying (its queue, its trees) and
  // what it has seen and said (its alerts, watches, messages, pad). Every one of these renders for the ACTIVE
  // session through paneIdFor, so #2's Alerts is #2's list rather than a panel-wide one wearing #2's name.
  const SUBTABS = ["chat", "settings", "queue", "worktrees", "alerts", "watches", "messages", "pad"];
  const FIRST_ASSISTANT = "assistant-1";
  const DEFAULT_VIEW = { assistant: FIRST_ASSISTANT, subTab: SUBTABS[0] };
  // Every session the page knows about. Before the first /api/assistant answer there is still Assistant #1 — the
  // panel has always had it, and an empty row until a fetch lands reads as a broken float rather than a slow one.
  function sessionRecords() {
    const list = state.assistant?.assistants;
    return Array.isArray(list) && list.length
      ? list
      : [{ id: FIRST_ASSISTANT, name: "Assistant #1", threadId: state.assistantThread || "panel-assistant", rules: [] }];
  }
  const sessionById = (id) => sessionRecords().find((x) => x.id === String(id || "")) || null;
  const assistantIds = () => sessionRecords().map((x) => x.id);
  const tabsNow = () => [...assistantIds(), ...LISTS];
  const isAssistant = (id) => assistantIds().includes(id);
  // The id of a session's own chat or settings pane. #1 keeps the ids the page and the harnesses have always used;
  // a second one is `as-chat-2`, derived from its number rather than stored anywhere.
  const paneIdFor = (id, sub) => (id === FIRST_ASSISTANT ? `as-${sub}` : `as-${sub}-${String(id).replace(/^assistant-/, "")}`);
  // The session whose tab is on screen (a list tab reads as #1, which is what the float opens on), and that
  // session's own chat or settings pane. Every renderer below asks these two instead of a fixed id.
  const activeSessionId = () => (isAssistant(state.assistantView?.assistant) ? state.assistantView.assistant : FIRST_ASSISTANT);
  const hostFor = (id, sub) => document.getElementById(paneIdFor(id, sub));
  // The last session tab the reader was on. A list tab (Alerts, Role, …) is not a session, so the session-owned
  // things — the Role pane's default target, a send from an intro box — fall back to this rather than to #1.
  let lastSession = FIRST_ASSISTANT;

  // The old record was one tab name, where "chat" was the assistant's card and "settings" was a tab of the float's.
  // Both are the session's own row now, so a reader who left the float on either lands where they were. "charter"
  // was this tab under its old name. And since alerts, watches, messages and the pad moved INSIDE the assistant,
  // a remembered "alerts" (or "watches", "messages", "pad") is one of Assistant #1's sub-tabs — the session the
  // float opens on — rather than a tab of its own that no longer exists.
  function legacyView(tab) {
    if (tab === "settings") return { assistant: DEFAULT_VIEW.assistant, subTab: "settings" };
    if (tab === "charter") return { assistant: "role", subTab: DEFAULT_VIEW.subTab };
    if (SUBTABS.includes(tab)) return { assistant: DEFAULT_VIEW.assistant, subTab: tab };
    if (tabsNow().includes(tab)) return { assistant: tab, subTab: DEFAULT_VIEW.subTab };
    return null;
  }
  // {assistant, subTab} is the whole record of where the float is: which session (or list) is the tab on screen, and
  // which of that session's own panes is showing. A name this build no longer carries reads as the default rather
  // than as nothing on screen — including a tab name the previous shape wrote, which goes through legacyView above.
  function readView() {
    try {
      const raw = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
      if (raw && typeof raw === "object") {
        if (tabsNow().includes(raw.assistant)) {
          return {
            assistant: raw.assistant,
            subTab: SUBTABS.includes(raw.subTab) ? raw.subTab : DEFAULT_VIEW.subTab,
          };
        }
        // A record written while the lists were the float's own tabs: that name is a sub-tab of #1's now.
        return legacyView(raw.assistant) || { ...DEFAULT_VIEW };
      }
      return legacyView(localStorage.getItem(TAB_KEY)) || { ...DEFAULT_VIEW };
    } catch {
      return { ...DEFAULT_VIEW };
    }
  }
  function writeView(view) {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      /* a browser with storage off still gets the float; it just forgets where it was */
    }
  }

  // Every move through the float goes through here: one record, written where a reload reads it, then the float
  // repainted from it. Nothing else assigns the view — a press on either row, a jump from the board and the card's
  // own send all land on the same one, so "where the reader was" has a single author.
  function setView(patch, { render = true } = {}) {
    const next = { ...state.assistantView, ...patch };
    state.assistantView = {
      assistant: tabsNow().includes(next.assistant) ? next.assistant : DEFAULT_VIEW.assistant,
      subTab: SUBTABS.includes(next.subTab) ? next.subTab : DEFAULT_VIEW.subTab,
    };
    writeView(state.assistantView);
    // `lastSession` is what a list tab falls back to: the Role pane edits the session the reader last had open.
    if (isAssistant(state.assistantView.assistant)) lastSession = state.assistantView.assistant;
    if (render) renderAssistant();
    return state.assistantView;
  }

  // The buttons and the panes a session needs, created once and then left alone: the button at the head of the row
  // (before the lists, so the sessions always read first) and the pane at the head of the body. This is the whole of
  // "a second assistant shows up in the top tab row" — the records are the source and nothing here knows a number.
  function syncSessionTabs() {
    const row = as$("as-tabs");
    const body = document.querySelector("#assistant .as-body");
    for (const rec of sessionRecords()) {
      if (row && !document.querySelector(`#as-tabs [data-as-tab="${rec.id}"]`)) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.asTab = rec.id;
        b.title = `${rec.name} — a real agent thread of its own (${rec.threadId ?? ""}), running the role it picked`;
        b.textContent = rec.name;
        const firstList = [...row.querySelectorAll("[data-as-tab]")].find((x) => LISTS.includes(x.dataset.asTab));
        row.insertBefore(b, firstList || null);
      }
      if (body && !document.getElementById(`as-${rec.id}`)) {
        const pane = document.createElement("section");
        pane.className = "as-pane hidden";
        pane.dataset.pane = rec.id;
        pane.id = `as-${rec.id}`;
        for (const sub of SUBTABS) {
          const s = document.createElement("section");
          s.className = `as-subpane${sub === SUBTABS[0] ? "" : " hidden"}`;
          s.dataset.subpane = sub;
          s.id = paneIdFor(rec.id, sub);
          pane.appendChild(s);
        }
        body.insertBefore(pane, body.firstElementChild || null);
      }
    }
  }

  // Both rows, and the panes under them, painted from that one record. The second row exists only while a session is
  // the tab on screen — it is that session's Chat and Settings, not a row of the float's — and both of a session's
  // panes follow the one subTab, so a second assistant needs no second row either.
  function paintAssistantTabs() {
    const view = state.assistantView;
    syncSessionTabs();
    for (const b of document.querySelectorAll("#as-tabs [data-as-tab]")) {
      b.classList.toggle("is-on", b.dataset.asTab === view.assistant);
    }
    const subs = as$("as-subtabs");
    if (subs) subs.hidden = !isAssistant(view.assistant);
    for (const b of document.querySelectorAll("#as-subtabs [data-as-subtab]")) {
      b.classList.toggle("is-on", b.dataset.asSubtab === view.subTab);
    }
    for (const p of document.querySelectorAll("#assistant .as-pane")) {
      p.classList.toggle("hidden", p.dataset.pane !== view.assistant);
    }
    for (const p of document.querySelectorAll("#assistant .as-subpane")) {
      p.classList.toggle("hidden", p.dataset.subpane !== view.subTab);
    }
  }
  // ---- end the float's two rows ------------------------------------------------------------------
  // Mirrors lib/assistant/config.js's SPAWN_WATCH_MS: the server escalates a card at two minutes, so the strip
  // and the badges turn amber on the same clock the alert is raised on rather than on a second opinion.
  const SPAWN_WATCH_MS = 120_000;

  // Ticks on a multi-select question outlive a repaint: the alerts pane is rebuilt whenever the assistant's
  // state changes, and a selection that vanishes on the next job event is the same bug as a lost draft.
  const parkedPicks = new Map(); // alert id -> Set(choice index)
  // "(Recommended)" is the gateway's decoration, not part of the label an answer needs to send.
  const stripRecommended = (c) => String(c).replace(/\s*\(Recommended\)\s*$/i, "");

  const as$ = (id) => document.getElementById(id);

  // One line, at most n characters, for a prompt shown inside a control: a card's prompt can be 2,000
  // characters and a strip row is one line.
  const oneLine = (s, n = 90) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  // The waiting time as the strip states it, in the card's own units: "48s", "3m12s".
  const waited = (ms) => fmtDur(Math.max(0, Number(ms) || 0));

  function readFlag(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v === "1";
    } catch {
      return fallback;
    }
  }
  function writeFlag(key, on) {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* a browser with storage off still gets the panel; it just forgets where it was */
    }
  }
  function readDockWidth() {
    try {
      const w = Number(localStorage.getItem(DOCK_KEY));
      return Number.isFinite(w) && w > 0 ? w : null;
    } catch {
      return null;
    }
  }
  function writeDockWidth(w) {
    try {
      localStorage.setItem(DOCK_KEY, String(Math.round(w)));
    } catch {
      /* not fatal */
    }
  }
  // The float's rect, remembered per browser beside the rail's width. A record with any of the four numbers missing is
  // not a rect: it reads as nothing remembered, and the float opens at its default place rather than at half a frame.
  function readFloatRect() {
    try {
      const r = JSON.parse(localStorage.getItem(FLOAT_KEY) || "null");
      if (!r || typeof r !== "object") return null;
      if (!["x", "y", "w", "h"].every((k) => Number.isFinite(Number(r[k])))) return null;
      return { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) };
    } catch {
      return null;
    }
  }
  function writeFloatRect(r) {
    try {
      localStorage.setItem(FLOAT_KEY, JSON.stringify(r));
    } catch {
      /* not fatal */
    }
  }
  function seenAt() {
    try {
      return Number(localStorage.getItem(SEEN_KEY) || 0) || 0;
    } catch {
      return 0;
    }
  }
  function markSeen() {
    try {
      localStorage.setItem(SEEN_KEY, String(Date.now()));
    } catch {
      /* not fatal */
    }
  }

  // The assistant's own fields on the shared state object. app.js reads assistantThread in three places
  // (the board excludes it, the reply route is chosen by it, and a missing card is repainted into the float).
  state.assistant = state.assistant || null;
  state.assistantThread = state.assistantThread || "panel-assistant";
  state.assistantOpen = state.assistantOpen ?? readFlag(OPEN_KEY, false);
  state.assistantView = state.assistantView || readView();
  state.assistantSeenAt = state.assistantSeenAt ?? seenAt();
  // The width the reader last dragged the rail to. Nothing else about the rail is remembered: it is docked, so there
  // is no position to restore and no size but the column's width. The float has its own record, `assistantFloat`, and
  // the two are kept apart on purpose — a mode switch is not a reason to lose either one.
  state.assistantWidth = state.assistantWidth ?? readDockWidth();
  state.assistantFloat = state.assistantFloat ?? readFloatRect();

  // ---- the frame: the docked rail and the floating window -------------------------------------

  // The width the rail is drawn at: the remembered one, clamped. The 60% cap is measured in the same layout px the
  // width is stored in, so a zoomed page cannot hand the rail more of the window than it would at 100% — and on a
  // window too narrow for the 340px floor the cap wins, because the board keeping the majority of the row is the
  // rule the floor serves.
  // ---- dock width: the one clamp ---------------------------------------------------------------
  function clampDockWidth(want, vw, z) {
    const cap = Math.min(DOCK_MAX, Math.floor((vw / (z || 1)) * DOCK_SHARE));
    const lo = Math.min(DOCK_MIN, cap);
    return Math.max(lo, Math.min(Number(want) || DOCK_DEFAULT, cap));
  }
  // ---- end dock width --------------------------------------------------------------------------

  function dockWidth() {
    const { vw } = viewportBox();
    return clampDockWidth(state.assistantWidth, vw, zoomScale());
  }

  // The rail's geometry: its width, and the height of the window below the topbar. It is ONE of the frame's two
  // painters — `applyFrame` is the entry point that decides which one runs — and it is the default one: the rail is
  // what a reader who never touches the setting keeps.
  // The topbar is MEASURED rather than assumed — it wraps to a second row on a narrow window — and the rail is
  // pinned under it with `position: sticky`, so the board scrolls while the rail stays put.
  function paintDock() {
    const el = as$("assistant");
    if (!el) return;
    const z = zoomScale();
    const { vh } = viewportBox();
    const top = document.querySelector(".topbar")?.getBoundingClientRect().height || 0;
    const h = Math.max(240, vh - top);
    el.style.width = `${dockWidth()}px`;
    el.style.top = cssPx(top, z);
    el.style.height = cssPx(h, z);
    // The row the rail is docked in has to be at least as tall as the rail, or `position: sticky` runs out of
    // containing block at the end of a short board and the rail slides up under the topbar. A board taller than
    // the window is unaffected: this is a floor, not a height.
    const shell = el.parentElement;
    if (shell) shell.style.minHeight = cssPx(h, z);
  }

  // ---- which frame is on screen: the rail, or the float -------------------------------------------
  //
  // The frame is ONE ASSISTANT'S OWN setting, not the panel's: `state.assistant.dock` is the server's map of
  // assistant id -> "docked" | "floating", read from that assistant's settings file. `docked` is the default and the
  // absence of the key, so a panel that has never been touched draws exactly the rail it always did.
  //
  // The tab the reader is on decides whose frame is drawn. A list tab (Alerts, Watchdog, …) belongs to no session, so
  // it falls back to the last session tab — the same fallback the Role pane and the intro boxes use — which keeps the
  // frame still while the reader walks the lists.
  const frameSessionId = () => (isAssistant(state.assistantView?.assistant) ? state.assistantView.assistant : lastSession);
  const dockModeOf = (id) => ((state.assistant && state.assistant.dock ? state.assistant.dock[id] : "") === "floating" ? "floating" : "docked");
  const floating = () => dockModeOf(frameSessionId()) === "floating";
  // A remembered number, or the fallback for anything that is not one: a style length must never be `NaNpx`.
  const finite = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  // The float's geometry: the rect the reader left it at, clamped to the window. A measured client rect is VISUAL px
  // while a length written to `style` is LAYOUT px, so every length is divided by the page zoom (see `cssPx`); the box
  // is the same LAYOUT viewport the dock measures its column against, so the two modes agree about where the edges are.
  // The minimum is the float's own (320) rather than the rail's floor: a window may be narrower than the rail's band.
  function placeFloat() {
    const el = as$("assistant");
    if (!el) return;
    const { vw, vh } = viewportBox();
    const z = zoomScale();
    const r = state.assistantFloat || null;
    const maxW = Math.max(FLOAT_MIN_W, vw - 2 * FLOAT_EDGE);
    const maxH = Math.max(FLOAT_MIN_H, vh - 2 * FLOAT_EDGE);
    const w = Math.max(FLOAT_MIN_W, Math.min(finite(r?.w, Math.round(vw * 0.42)), maxW));
    const h = Math.max(FLOAT_MIN_H, Math.min(finite(r?.h, Math.round(vh * 0.8)), maxH));
    const x = Math.max(FLOAT_EDGE, Math.min(finite(r?.x, vw - w - FLOAT_EDGE), vw - w - FLOAT_EDGE));
    const y = Math.max(FLOAT_EDGE, Math.min(finite(r?.y, Math.round(vh * 0.1)), vh - h - FLOAT_EDGE));
    el.style.left = cssPx(x, z);
    el.style.top = cssPx(y, z);
    el.style.width = cssPx(w, z);
    el.style.height = cssPx(h, z);
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  // The frame, written here and nowhere else. `docked` hands the geometry to the rail (the stylesheet's sticky column
  // and `paintDock`); `floating` takes the pane out of the row and gives it the rect. Two modes, one entry point: a
  // load, a tab change, a resize and the settings row all land here, so the geometry cannot outlive the setting that
  // chose it. `force` re-lays a mode that has not changed (an open, a resize); the class and the titles are written
  // either way, because they are what the stylesheet and the reader's cursor read.
  let frameMode = null;
  let frameId = null;
  function applyFrame(force = false) {
    const el = as$("assistant");
    if (!el) return;
    const id = frameSessionId();
    const mode = dockModeOf(id) === "floating" ? "floating" : "docked";
    const moved = mode !== frameMode || id !== frameId;
    frameMode = mode;
    frameId = id;
    el.classList.toggle("is-floating", mode === "floating");
    const split = as$("as-split");
    if (split) split.title = mode === "floating" ? "drag to resize the floating assistant (320 px minimum)" : "drag to resize the assistant's column (340–640 px, at most 60% of the window)";
    // The bar is the float's handle and nothing in the rail: a title says so where the cursor turns into a move.
    const bar = el.querySelector(".as-bar");
    if (bar) bar.title = mode === "floating" ? "drag to move the floating assistant" : "";
    if (!moved && !force) return;
    const shell = el.parentElement;
    // A closed pane measures nothing: the class is what it opens with, and the geometry is written on the way in
    // (`toggleAssistant` -> here, forced).
    if (el.hidden) {
      if (shell) shell.style.minHeight = "";
      return;
    }
    if (mode === "floating") {
      // The row is the board's again: the float is out of flow, so nothing may hold the rail's height for it.
      if (shell) shell.style.minHeight = "";
      placeFloat();
    } else {
      // The float's lengths must not survive into a sticky column: `left` on a sticky element is a sticky OFFSET, so
      // a rail carrying the last float's x would sit a few hundred pixels in from its own edge — the frame disagreeing
      // with the setting it was drawn from.
      el.style.left = "";
      el.style.right = "auto";
      el.style.bottom = "auto";
      paintDock();
    }
    // The pane's box just changed shape: the room goes to the open turn's console, not to the space above it.
    queueSlackPaint();
  }

  // The box the rail is measured against: the LAYOUT viewport — `documentElement.clientWidth/Height`, which
  // already excludes the classic scrollbar. It is deliberately not `visualViewport`: a classic scrollbar shrinks
  // the visual viewport by its own width (11px on this machine), so a rail sized against it would be narrower
  // than the row it is docked in.
  function viewportBox() {
    const doc = document.documentElement;
    return {
      vw: doc.clientWidth || window.innerWidth,
      vh: doc.clientHeight || window.innerHeight,
    };
  }

  // The page zoom this panel applies to `documentElement` (`applyZoom` in app.js, persisted in `wtgui.zoom`).
  //
  // It scales LAYOUT, not client coordinates: `getBoundingClientRect()` and `clientX/Y` are already VISUAL px
  // (a 480px-wide float measures 528 at 110%, and `elementFromPoint(168, …)` — 3px inside its visual edge —
  // hits its grab), while a length written to `style.left`/`style.width` is LAYOUT px and renders `zoom`× larger.
  // Writing a measured client length straight back into the style therefore made every gesture zoom-scaled: at
  // 110% the first move of a corner grab jumped the frame a tenth of its own size, its corner sat 148px past the
  // cursor, and a 150px drag carried the frame 135px outside the window. Divide every written length by this.
  function zoomScale() {
    const z = parseFloat(getComputedStyle(document.documentElement).zoom);
    return Number.isFinite(z) && z > 0 ? z : 1;
  }

  // A client-pixel length as a CSS length for this zoom.
  function cssPx(v, z) {
    return `${v / (z || 1)}px`;
  }

  // The chat's scroll box: the card's body, and the only thing in the float that scrolls.
  const chatBody = (id = activeSessionId()) => {
    const host = hostFor(id, "chat");
    return host ? host.querySelector(":scope > .job > .job-body") : null;
  };

  // Which turn takes the room the float gains. A taller panel used to hand the extra height to the spacer above the
  // turns — blank background between the card's head and the first turn — while the thing the reader is reading, the
  // open turn's console, stayed at its 230px cap. The room goes to the LOWEST open turn (the newest one they have
  // open, i.e. the one at the foot of the transcript); with nothing open there is no console on the page to grow, so
  // nothing is marked and the spacer keeps owning the slack until a turn opens (a resize gesture opens the newest —
  // see `openNewestTurn`).
  let slackQueued = false;
  function paintSlackTurn() {
    slackQueued = false;
    const body = chatBody();
    if (!body) return;
    const turns = [...body.querySelectorAll(":scope > .turn")];
    const open = turns.filter((t) => !t.classList.contains("folded"));
    const target = open.length ? open[open.length - 1] : null;
    for (const t of turns) t.classList.toggle("is-slack", t === target);
  }
  function queueSlackPaint() {
    if (slackQueued) return;
    slackQueued = true;
    requestAnimationFrame(paintSlackTurn);
  }

  // The newest turn, opened through the board's own toggle, so the room a resize creates has a console to land in.
  // Guarded: a folded turn's console is not on the page at all, and the reader who folded everything gets one turn
  // back rather than a blank panel.
  function openNewestTurn() {
    const body = chatBody();
    if (!body) return;
    const turns = [...body.querySelectorAll(":scope > .turn")];
    if (!turns.length) return;
    if (turns.some((t) => !t.classList.contains("folded"))) return;
    const head = turns[turns.length - 1].querySelector("[data-toggle-turn]");
    const key = head && head.dataset ? head.dataset.toggleTurn : null;
    if (key && typeof toggleTurn === "function") toggleTurn(key);
  }

  // app.js rebuilds the card on every job event and on every fold the reader makes, which drops the class that hands
  // the room to a console. Watch the pane's children instead of chasing every call site. An attribute-only repaint
  // cannot loop: only `class` is written, and childList is all that is observed.
  const slackObserver = typeof MutationObserver === "function" ? new MutationObserver(queueSlackPaint) : null;
  // One observer, one host each: a second assistant's chat pane is a second host, and the old `started` flag would
  // have observed whichever pane was on screen first and never the other.
  const slackWatched = typeof WeakSet === "function" ? new WeakSet() : null;
  function watchSlack() {
    const host = hostFor(activeSessionId(), "chat");
    if (!slackObserver || !host || (slackWatched && slackWatched.has(host))) return;
    if (slackWatched) slackWatched.add(host);
    slackObserver.observe(host, { childList: true, subtree: true });
    queueSlackPaint();
  }

  // A conversation shorter than the panel belongs at the panel's foot, not at its top with the composer
  // stranded below the fold: the panel opens on the turn the reader just sent, the way the board's maximized
  // card does. A reader who has scrolled up keeps their place — `chatPinned` follows their scroll, and only a
  // forced pin (opening the panel, maximizing, switching back to Chat) overrides it.
  let chatPinned = true;
  function pinChatToBottom(force = false) {
    const body = chatBody();
    if (!body) return;
    if (!force && !chatPinned) return;
    const toFoot = () => {
      body.scrollTop = body.scrollHeight;
    };
    toFoot();
    requestAnimationFrame(toFoot);
  }

  function toggleAssistant(open = !state.assistantOpen) {
    state.assistantOpen = Boolean(open);
    writeFlag(OPEN_KEY, state.assistantOpen);
    const el = as$("assistant");
    const btn = as$("btn-assistant");
    if (el) el.hidden = !state.assistantOpen;
    if (btn) btn.classList.toggle("is-on", state.assistantOpen);
    if (state.assistantOpen) {
      applyFrame(true);
      state.assistantSeenAt = Date.now();
      markSeen();
      renderAssistant();
      paintAssistantBadge();
      pinChatToBottom(true);
    }
    else {
      // Closed, the rail takes no room: the row goes back to the board's own height.
      const shell = el?.parentElement;
      if (shell) shell.style.minHeight = "";
    }
    // The board's row just gained or lost the rail's width: the room goes to the open turn's console, not to the
    // spacer above it.
    queueSlackPaint();
  }

  // Is the caret sitting in a field the reader is typing into? A shortcut that eats a letter out of a prompt box
  // is worse than no shortcut, so every text-ish host disqualifies a bare key: a contenteditable (or one of its
  // children) reports isContentEditable, and input/textarea/select are the three tags a caret can live in.
  function inTextField(node) {
    const el = node && node.nodeType === 1 ? node : null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    const host = el.closest?.("input, textarea, select, [contenteditable]");
    return Boolean(host && (host.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(host.tagName)));
  }

  // ---- what arrives from the server ------------------------------------------------------------

  function applyAssistant(data) {
    if (!data || typeof data !== "object") return;
    state.assistant = data;
    if (data.thread) state.assistantThread = data.thread;
    // Every assistant thread, for app.js: a conversation is the float's when its thread is in here, and with
    // roles there can be more than one.
    state.assistantThreads = (Array.isArray(data.assistants) && data.assistants.length ? data.assistants : [{ threadId: data.thread }])
      .map((a) => a.threadId)
      .filter(Boolean);
    paintAssistantBadge();
    paintSpawnStrip();
    paintAggressive();
    // The card has to exist even while the float is closed: app.js's renderConversation finds it by thread
    // anywhere in the document, and that is what keeps a running turn current instead of frozen. Every session's
    // card, not only the one on screen — Assistant #2's turn can land while #1 is the tab the reader has open.
    syncSessionTabs();
    for (const rec of sessionRecords()) renderAssistantChat(rec.id);
    if (state.assistantOpen) renderAssistant();
  }

  // The waiting spawn cards. `who` is the scope the caller speaks for: the float's header badge asks for the SELECTED
  // assistant's (the same scope its alert count uses), and the board's strip asks for every assistant's — a card
  // waiting for a click is never hidden behind a tab the reader does not have open.
  function spawnCards(who = selectedSessionId()) {
    return (state.assistant?.alerts || []).filter((a) => a.spawn && typeof a.spawn.prompt === "string" && inAlertScope(a, who));
  }
  function spawnAge(a) {
    return Date.now() - (Date.parse(a.at) || Date.now());
  }

  // Two counts, because they are two different facts: N things need a look, and of those M are SPAWN cards —
  // workers that have NOT started. The second number is the one the reader missed while four cards sat open
  // behind a single badge, and it turns amber once the oldest is past the two minutes the server escalates on.
  // The spawn badge itself is painted by `paintSpawnBadge` (one writer for one element).
  function paintAssistantBadge() {
    const btn = as$("btn-assistant");
    const badge = as$("assistant-badge");
    if (!btn || !badge) return;
    // The header's number is the SELECTED assistant's number: the same scope that fills its Alerts pane (and its All
    // toggle) fills this badge, so a reader on #2 is told about #2's notices and not handed a count of everyone's.
    const plain = alertsInScope(state.assistant?.alerts || []).filter((a) => !a.spawn);
    const n = plain.length;
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? "99+" : String(n);
    const cards = spawnCards();
    const m = cards.length;
    const oldest = cards.reduce((t, a) => Math.min(t, Date.parse(a.at) || Date.now()), Date.now());
    const late = m > 0 && Date.now() - oldest >= SPAWN_WATCH_MS;
    const newest = plain.reduce((t, a) => Math.max(t, Date.parse(a.at) || 0), 0);
    btn.classList.toggle("is-hot", (n > 0 && newest > (state.assistantSeenAt || 0)) || late);
    const spawnWords = m ? ` — ${m} of them ${m === 1 ? "is a spawn card" : "are spawn cards"} waiting for a click, so nothing has started` : "";
    btn.title = n
      ? `assistant — ${n} thing${n === 1 ? "" : "s"} on the board need${n === 1 ? "s" : ""} a look${spawnWords} (A or Ctrl+Shift+A)`
      : "assistant — watches the agents on this board, notices loops and stalls, and drafts answers to a worker's questions (A or Ctrl+Shift+A)";
    paintSpawnBadge();
  }

  // The spawn badge: ONE element, one painter, two facts joined — how many cards are waiting (the page's own
  // list, so the badge and the strip can never disagree) and what the server's watchdog has found among them
  // (`spawnCards.unstarted`: a card past its deadline with no run behind it). The count is the number the
  // reader missed while four cards sat open; amber says the oldest has waited past the window, red says the
  // watchdog looked and found nothing behind one. Neither is folded into the alert count beside it: a card is
  // the reader's pending act, not a notice about the board.
  function paintSpawnBadge() {
    const el = as$("assistant-spawn-badge");
    if (!el) return;
    const all = state.assistant?.spawnCards || { open: 0, unstarted: 0 };
    // The server's numbers are the fallback while its state is the only thing that has arrived (a socket replay of
    // `state` before any tab repainted its list); the page's own list wins as soon as it has rows. Both are read at
    // the scope the float is showing — the selected assistant, or the whole board when its pane is widened to All —
    // so a panel-wide total cannot reappear on a narrowed badge.
    const scope = alertScopeOf();
    const s = scope === "all" ? all : all.byAssistant?.[scope] || { open: 0, unstarted: 0 };
    const stuck = Number(s.unstarted) || 0;
    const cards = spawnCards(scope);
    const m = cards.length || Number(s.open) || 0;
    const oldest = cards.reduce((t, a) => Math.min(t, Date.parse(a.at) || Date.now()), Date.now());
    const late = m > 0 && (cards.length ? Date.now() - oldest >= SPAWN_WATCH_MS : false);
    el.hidden = m === 0;
    el.textContent = m > 99 ? "99+" : `${m} spawn`;
    el.classList.toggle("is-late", late && !stuck);
    el.classList.toggle("is-stuck", stuck > 0);
    if (!m) {
      el.title = "";
      return;
    }
    const due = s.nextDueAt ? Math.max(0, s.nextDueAt - Date.now()) : 0;
    el.title =
      `${m} spawn card${m === 1 ? "" : "s"} waiting for your click — nothing has started` +
      (late ? ` · the oldest has waited ${waited(Date.now() - oldest)}` : "") +
      (stuck ? ` · ${stuck} never started and the watchdog has said so` : due ? ` · checked again in ${Math.ceil(due / 1000)}s` : "") +
      (s.autoStart ? " · auto-start is ON: a card with no run is started once when its check comes round" : "");
  }

  // ---- the spawn strip --------------------------------------------------------------------------
  //
  // A spawn card is a worker that has not started, and the board draws nothing for it: no job, no row, no
  // card. Four of them sat open for an evening (19:54, 19:57, 19:58, 20:00) behind the badge number, and the
  // reader concluded the agents had failed to spawn. This strip is the board's own answer — above every
  // project, one row per waiting card, the Start button on the row. It starts NOTHING by itself: every button
  // here is the same POST the float's own card makes.

  let spawnStripSig = "";

  function paintSpawnStrip() {
    const host = as$("spawn-strip");
    if (!host) return;
    // The board's strip is every assistant's: a waiting card is the reader's pending act wherever they are reading, and
    // a tab they do not have open is exactly where one would go missing again.
    const cards = spawnCards("all").sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    if (!cards.length) {
      if (!host.hidden) {
        host.hidden = true;
        host.innerHTML = "";
      }
      spawnStripSig = "";
      return;
    }
    // Repaint only when the strip would look different. The board polls every few seconds, and a button
    // rebuilt under the reader's pointer is a press that lands on nothing (the panel's own rebuild rule).
    const sig = cards.map((a) => `${a.id}@${Math.floor(spawnAge(a) / 60_000)}`).join(",");
    if (sig === spawnStripSig) return;
    spawnStripSig = sig;
    const late = cards.filter((a) => spawnAge(a) >= SPAWN_WATCH_MS).length;
    host.hidden = false;
    host.innerHTML = `<div class="spawn-strip-head">
        <span class="spawn-strip-title">${cards.length} spawn card${cards.length === 1 ? "" : "s"} waiting</span>
        <span class="spawn-strip-note">${late ? `<b>${late} unclicked for over 2 minutes</b> · ` : ""}the assistant proposed ${cards.length === 1 ? "a worker" : "these workers"} — nothing runs until you press Start</span>
        <span class="spacer"></span>
        <button id="btn-spawn-review" type="button" title="open the assistant on its Alerts tab, where the spawn cards are drawn first">Review in Alerts</button>
      </div>
      <div class="spawn-strip-rows">${cards.map(spawnStripRow).join("")}</div>`;
  }

  function spawnStripRow(a) {
    const age = spawnAge(a);
    const late = age >= SPAWN_WATCH_MS;
    const prompt = String(a.spawn.prompt || "");
    return `<div class="spawn-strip-row${late ? " is-late" : ""}" data-spawn-row="${esc(a.id)}">
        <span class="spawn-strip-what">${esc(a.title || "spawn a worker")}</span>
        <span class="spawn-strip-prompt" title="${esc(prompt)}">“${esc(oneLine(prompt, 90))}”</span>
        <span class="spawn-strip-age">waiting ${esc(waited(age))}${late ? " · unclicked 2m+" : ""}</span>
        <button type="button" class="primary" data-spawn-start="${esc(a.id)}" title="cut the worktree (or use that tree) and start the worker — ${esc(oneLine(prompt, 160))}">${a.spawn.existing ? "Start worker there" : "Create worktree &amp; start"}</button>
        <button type="button" data-spawn-review="${esc(a.id)}" title="open this card in the assistant's Alerts tab">Open card</button>
      </div>`;
  }

  // Open the float on Alerts with one card (or the top of the list) in view. The pane is inside the float's
  // own scroller, so this is a scrollIntoView, not a page jump.
  function openAlertsAt(id = null) {
    // A card named from somewhere else in the panel — the HUMAN rotation, the approvals dock, a spawn row — has to be
    // ON the pane it lands on, so naming a card opens ITS OWNER's Alerts pane: the owner is a field on the record, and
    // a pane belonging to another assistant would hide exactly the row the reader asked for. Asking for the tab alone
    // lands on the assistant the float is already showing.
    const card = id ? (state.assistant?.alerts || []).find((a) => a.id === id) : null;
    const owner = card ? alertOwner(card) : selectedSessionId();
    const target = isAssistant(owner) ? owner : FIRST_ASSISTANT;
    setView({ assistant: target, subTab: "alerts" }, { render: false });
    toggleAssistant(true);
    if (id) paintSpawnStrip();
    requestAnimationFrame(() => {
      const pane = `#${paneIdFor(target, "alerts")}`;
      const sel = id ? `${pane} [data-alert="${CSS.escape(id)}"]` : pane;
      const el = document.querySelector(sel);
      if (!el) return;
      el.scrollIntoView({ block: "nearest" });
      if (!id) return;
      el.classList.add("is-flash");
      setTimeout(() => el.classList.remove("is-flash"), 1600);
    });
  }

  // The one act a spawn card has, from either surface: the strip's row or the float's card. Never called by a
  // timer — `data-spawn-start` exists because the reader pressed it.
  async function startSpawnCard(id, button = null) {
    if (!id) return;
    const was = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = "cutting the worktree…";
    }
    try {
      const d = await asPost("/api/assistant/spawn", { id }, { timeoutMs: 150_000 });
      showNote(`worker started · ${d.job?.thread || d.job?.id || ""}`);
      if (d.assistant) applyAssistant(d.assistant);
      renderAssistantAlerts(true);
      renderAssistant();
    } catch (err) {
      // The error belongs where the reader is looking, on both surfaces, and the strip keeps its row so the
      // card can be retried (a refusal names what is wrong with the tree or the gateway).
      const slot = document.querySelector(`[data-as-err="${CSS.escape(id)}"]`);
      if (slot) slot.textContent = err.message;
      const row = document.querySelector(`[data-spawn-row="${CSS.escape(id)}"]`);
      if (row) {
        let line = row.querySelector(".spawn-strip-err");
        if (!line) {
          line = document.createElement("span");
          line.className = "spawn-strip-err as-err";
          row.appendChild(line);
        }
        line.textContent = err.message;
      }
      if (button) button.textContent = was;
    } finally {
      if (button) button.disabled = false;
      paintSpawnStrip();
      paintAssistantBadge();
    }
  }

  // The aggressive switch, at the top of an assistant's Settings sub-pane. The SERVER owns the record of what the
  // mode changed — this only paints what the server says and asks it to change. The pill reads on/off so the state
  // is legible without colour alone, and the title carries the plain description of the cost.
  function paintAggressive() {
    const btn = as$("btn-aggressive");
    const pill = as$("aggressive-state");
    if (!btn || !pill) return;
    const agg = state.assistant?.aggressive || {};
    const on = Boolean(agg.on);
    const saved = agg.restore;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    pill.textContent = on ? "on" : "off";
    btn.title = on
      ? `aggressive assistant is ON — more tokens: it wakes on everything, monitors and checks every live card, and keeps pushing until the fleet is waiting on something outside. ${saved ? `${saved.present} of your settings are saved and ${saved.absent} absent key${saved.absent === 1 ? "" : "s"} will be removed again` : "your settings are saved"} — click to switch it off (Alt+Shift+A)`
      : "aggressive assistant — spends more tokens: the assistant wakes on everything, monitors and checks every live card, and keeps pushing until the fleet is waiting on something outside. Your own settings are saved while it is on and put back exactly when you switch it off (Alt+Shift+A)";
  }

  // ONE control for ONE mode, moved to the top of whichever assistant's Settings sub-pane is on screen. A copy per
  // pane would be several controls (and several elements under one id) for one state; the same node keeps the
  // reader's place and its listener across a repaint. It is created on the first pane that needs it, and
  // renderAssistantSettings() re-inserts it after that pane's markup has been rebuilt.
  let aggressiveBlockEl = null;
  function aggressiveBlock() {
    if (aggressiveBlockEl) return aggressiveBlockEl;
    const wrap = document.createElement("div");
    wrap.className = "as-group as-aggressive";
    wrap.id = "as-aggressive";
    wrap.innerHTML = `
      <div class="as-line">
        <button type="button" id="btn-aggressive" class="btn-aggressive" aria-pressed="false">⚡ Aggressive<span id="aggressive-state">off</span></button>
        <span class="as-hint">Alt+Shift+A</span>
      </div>
      <div class="as-help">The aggressive profile: the assistant wakes on everything, checks every live card and keeps
      pushing until the fleet is waiting on something outside. While it is on it holds the waking, monitoring and acting
      settings; switching it off puts your own values back exactly.</div>`;
    wrap.querySelector("#btn-aggressive").addEventListener("click", () => setAggressiveMode(!state.assistant?.aggressive?.on));
    aggressiveBlockEl = wrap;
    return wrap;
  }

  // Say something briefly beside the aggressive switch without opening a panel: a no-op press (on twice, or off
  // when it was never on) has to be acknowledged, or the switch reads as broken. The note is a fixed toast, so the
  // pane's own repaint after the press cannot wipe it.
  let aggressiveMsgTimer = null;
  function aggressiveNote(text) {
    const el = as$("aggressive-msg");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
    if (aggressiveMsgTimer) clearTimeout(aggressiveMsgTimer);
    aggressiveMsgTimer = text
      ? setTimeout(() => {
          el.hidden = true;
          el.textContent = "";
        }, 6000)
      : null;
  }

  // One press, one round trip. `asPost` applies the assistant state the answer carries, which repaints this
  // button and the settings tab; the extra paint here is for the first frame before that lands.
  async function setAggressiveMode(on) {
    const btn = as$("btn-aggressive");
    if (btn) btn.disabled = true;
    try {
      const d = await asPost("/api/assistant/aggressive", { on: Boolean(on) });
      if (d && d.changed === false) aggressiveNote(d.reason || "no change");
      else aggressiveNote(on ? "aggressive mode on — your settings are saved" : "aggressive mode off — your settings are back");
      paintAggressive();
      // The switch lives in the pane that is on screen, so repaint THAT one — not Assistant #1's hidden pane.
      renderAssistantSettings(activeSessionId(), true);
    } catch (err) {
      aggressiveNote(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // A sentry that has stopped is the one failure the panel would otherwise show as "nothing wrong": the
  // header says so, and Settings repeats it with the numbers. The server's watchdog is what repairs it.
  function sentryState(h) {
    if (!h) return null;
    if (!h.timerAlive) return "stopped";
    const every = (h.everySeconds || 5) * 1000;
    if (h.lastTickAt && Date.now() - h.lastTickAt > every * 3) return "stale";
    return null;
  }

  function renderAssistant() {
    const a = state.assistant;
    // Which frame this assistant is drawn in is a setting, and this is the one painter every path already calls: a
    // save, a tab change and the first snapshot all land here, so the panel re-frames without a reload.
    applyFrame();
    const mode = a?.settings?.autonomy || "draft";
    const modeEl = as$("as-mode");
    if (modeEl) {
      modeEl.textContent = mode === "draft" ? "draft-only" : mode === "auto-safe" ? "auto-safe" : "auto";
      modeEl.className = `as-mode mono${mode === "auto" ? " is-auto" : mode === "auto-safe" ? " is-safe" : ""}`;
    }
    // The sub-tab's count is the alert count LESS the spawn cards: the spawn cards have their own strip and badge,
    // and a number that silently included them is how a card nobody started stayed invisible. Both counts are the
    // SELECTED assistant's — the session on screen, or the one the reader was last on while Role or Watchdog is
    // showing — and the All toggle inside its pane widens them with it, so every number beside the chips agrees.
    const sel = selectedSessionId();
    const { notices: openAlerts, cards: spawnOpen } = alertCounts(a?.alerts || [], sel);
    const liveWatches = (a?.watches || []).filter((w) => w.state !== "done" && (w.assistantId || FIRST_ASSISTANT) === sel).length;
    if (as$("as-alert-n")) as$("as-alert-n").textContent = String(openAlerts);
    // The Alerts tab carries the same split the header does: how many of the open alerts are spawn cards.
    if (as$("as-spawn-n")) {
      as$("as-spawn-n").textContent = spawnOpen ? `${spawnOpen} spawn` : "0";
      as$("as-spawn-n").hidden = spawnOpen === 0;
      as$("as-spawn-n").title = spawnOpen
        ? `${spawnOpen} spawn card${spawnOpen === 1 ? "" : "s"} waiting for a click — nothing has started`
        : "";
    }
    if (as$("as-watch-n")) as$("as-watch-n").textContent = String(liveWatches);
    if (as$("as-chips")) {
      as$("as-chips").innerHTML = [
        a?.running ? `<span class="chip warn" title="its own turn is running">thinking</span>` : "",
        a && a.enabled === false ? `<span class="chip" title="the sentry is off — no rule is being evaluated">off</span>` : "",
        a?.aggressive?.on
          ? `<span class="chip warn" title="aggressive mode is on — the assistant wakes on everything, checks every live card and keeps pushing until the fleet is waiting on something outside. Switch it off in its Settings tab (Alt+Shift+A)">⚡ aggressive</span>`
          : "",
        sentryState(a?.health) ? `<span class="chip warn" title="the sentry's clock is not running or has not ticked — the server watchdog restarts it, and this goes green again">sentry ${sentryState(a?.health)}</span>` : "",
        a ? `<span class="chip" title="sweep wakes in the last hour — the budgeted class (a polled condition like quiet or loop). An event — a settle, an exit, a question, a watch finishing — is never refused">${a.sweeps?.lastHour ?? 0}/${a.sweeps?.limit ?? 0} sweeps</span>` : "",
      ].join("");
    }
    paintAssistantTabs();
    renderAssistantChat(activeSessionId());
    // A session's own row decides what is showing inside it: the thread (pinned to its foot, where the composer is —
    // the turns only scroll while the reader scrolls them), the rules it follows, the work it carries, or one of the
    // four lists that are its own. Every one of them is painted INTO that session's pane (through paneIdFor), so #2's
    // Alerts is #2's list and never a panel-wide one. Role and Watchdog are the panel's and stay above this.
    const view = state.assistantView;
    if (isAssistant(view.assistant)) {
      if (view.subTab === "settings") renderAssistantSettings(view.assistant);
      else if (view.subTab === "queue") renderAssistantQueue(view.assistant);
      else if (view.subTab === "worktrees") renderAssistantWorktrees(view.assistant);
      else if (view.subTab === "alerts") renderAssistantAlerts(false, view.assistant);
      else if (view.subTab === "watches") renderAssistantWatches(false, view.assistant);
      else if (view.subTab === "messages") renderAssistantMessages(view.assistant);
      else if (view.subTab === "pad") renderAssistantPad(false, view.assistant);
      else pinChatToBottom();
    } else if (view.assistant === "role") renderAssistantRole();
    else if (view.assistant === "watchdog") renderWatchdog();
    else if (view.assistant === "bridge") renderBridge();
  }

  // ---- chat: the assistant as one of the agents -------------------------------------------------

  // The intro box's ids: #1 keeps the ones the page and its harnesses have always used, a second assistant gets its
  // own suffix so two intro boxes can never answer for each other.
  const firstBoxId = (id) => (id === FIRST_ASSISTANT ? "as-first-text" : `as-first-text-${String(id).replace(/^assistant-/, "")}`);
  const firstBtnId = (id) => (id === FIRST_ASSISTANT ? "btn-as-first" : `btn-as-first-${String(id).replace(/^assistant-/, "")}`);

  function assistantIntroHtml(id = FIRST_ASSISTANT) {
    const off = state.assistant?.enabled === false;
    const rec = sessionById(id);
    const role = rec?.roleName ? ` It runs the <b>${esc(rec.roleName)}</b> role.` : "";
    return `<div class="as-intro">
      <p><b>✧ ${esc(rec?.name || "Assistant")}</b> reads this board and nothing else: the agents' cards, the approvals and its own
      scratchpad. It has no terminal of its own.${role}</p>
      <ul>
        <li>“What is going on?” — a digest of the live agents.</li>
        <li>“Keep an eye on the deploy one, and tell me if it stalls.”</li>
        <li>“Create a worktree for the docs and have an agent write them.” — it proposes the worker, and you
        confirm with one click.</li>
        <li>It answers a worker only when your standing rules cover the question; otherwise it drafts and waits
        for your click.</li>
      </ul>
      ${off ? `<p class="as-hint">It is switched off in Settings — turn it on there to start.</p>` : ""}
      <div class="as-first">
        <!-- A chipbox like every other prompt box (board/paste-chips.js): a long paste collapses in place
             here too. No data-single, so a multi-line paste keeps its lines; the placeholder is data-ph,
             because :empty draws it and a div takes no placeholder attribute. -->
        <div id="${firstBoxId(id)}" class="chipbox" contenteditable="true" role="textbox" aria-multiline="true" data-chipbox="as-first-${esc(id)}" spellcheck="false" data-ph="Ask it something, or tell it what to watch…"${off ? ' data-off="1"' : ""}></div>
        <div class="as-first-actions">
          <button id="${firstBtnId(id)}" type="button" class="primary" data-as-send="${esc(id)}"${off ? " disabled" : ""}>Send to ${esc(rec?.name || "the assistant")}</button>
          <span class="as-hint">its own Hermes thread${rec?.threadId ? ` (${esc(rec.threadId)})` : ""} · it knows the board, not your repository</span>
        </div>
      </div>
    </div>`;
  }

  function renderAssistantChat(id = activeSessionId()) {
    const host = hostFor(id, "chat");
    if (!host) return;
    const rec = sessionById(id);
    const thread = rec?.threadId || (id === FIRST_ASSISTANT ? state.assistantThread : null);
    const conv = conversations().find((c) => c.thread === thread);
    if (!conv) {
      if (host.dataset.mode !== "intro") {
        host.dataset.mode = "intro";
        host.innerHTML = assistantIntroHtml(id);
        // A pasted block the reader was writing here before a reload comes back as a chip, with its text.
        restorePersistedBox(as$(firstBoxId(id)));
      }
      return;
    }
    // A live edit in the intro box survives until the first turn exists; after that the card owns the box.
    host.dataset.mode = "card";
    const sig = conversationSignature(conv);
    const card = host.querySelector(`.job[data-thread="${CSS.escape(conv.thread)}"]`);
    if (card && card.dataset.sig === sig) {
      paintCardMeta(card, conv);
      return;
    }
    const prevScrolls = captureScrolls(host);
    const held = captureCardSelection();
    const typing = captureTyping(host);
    // The card body is the float's only scroller, and captureScrolls only knows the consoles: keep its
    // position too, or a repaint mid-read drops the transcript back to its first turn.
    const prevTop = chatBody()?.scrollTop ?? 0;
    const wasPinned = chatPinned;
    const pageY = window.scrollY;
    host.innerHTML = conversationHtml(conv);
    const fresh = host.firstElementChild;
    if (fresh) fresh.dataset.sig = sig;
    restoreScrolls(host, prevScrolls);
    applyStoredScrolls(host);
    restoreThinkBodies(host);
    restoreReplyDraft(conv.thread);
    restoreTyping(host, typing);
    restoreCardSelection(held);
    settleScrolls(host);
    if (wasPinned) pinChatToBottom(true);
    else {
      const body = chatBody();
      if (body) body.scrollTop = prevTop;
    }
    // The panel is fixed, so a rebuild can never move the page — but a focus() inside it can, and this keeps
    // that promise local instead of relying on every callee remembering preventScroll.
    if (window.scrollY !== pageY) window.scrollTo({ top: pageY });
    // A fresh card has none of the classes the last one carried: hand the room to the open turn again, and start
    // watching for the repaints that come from the board rather than from here.
    watchSlack();
    queueSlackPaint();
  }

  // ---- alerts ---------------------------------------------------------------------------------
  //
  // WHOSE alerts a pane shows. Each assistant's Alerts pane opens on ITS OWN list, and "All" is a toggle INSIDE the
  // pane: one press widens it to the whole board and the next puts its own list back. The widened choice is kept per
  // SESSION (`alertAll`), so #1 left on All does not widen #2's pane, #2's count or the header badge. The owner is a
  // field on the record: `fired()` stamps it at fire time, #1's included, and a legacy alert with no stamp is
  // resolved from its thread by the server (`alertOwnerOf`, lib/assistant.js). This side reads one field and never
  // guesses.
  const alertAll = new Set(); // the sessions whose alerts pane is widened to the whole board
  const alertOwner = (a) => String(a?.assistantId || "").trim() || FIRST_ASSISTANT;
  // The assistant a count on the float speaks for: the session on screen, or the one the reader was last on while a
  // panel-wide pane (Role, Watchdog) is showing.
  const selectedSessionId = () => frameSessionId();
  const alertScopeOf = (who = selectedSessionId()) => (alertAll.has(who) ? "all" : who);
  function inAlertScope(a, who = selectedSessionId()) {
    return who === "all" || alertAll.has(who) || alertOwner(a) === who;
  }
  function alertsInScope(list, who = selectedSessionId()) {
    return (Array.isArray(list) ? list : []).filter((a) => inAlertScope(a, who));
  }
  // The two numbers every Alerts surface shows — the sub-tab's count and its spawn badge, and the header button's own
  // badge — read from ONE scope here, so a number beside the chips cannot disagree with the list under them.
  function alertCounts(list = state.assistant?.alerts, who = selectedSessionId()) {
    const scoped = alertsInScope(list, who);
    return {
      notices: scoped.filter((a) => !a.spawn).length,
      cards: scoped.filter((a) => a.spawn && typeof a.spawn.prompt === "string").length,
    };
  }

  function assistantThreadName(thread) {
    const conv = conversations().find((c) => c.thread === thread);
    return conv?.latest?.label || conv?.latest?.title || thread;
  }

  // "Open agent" has to open every accordion between the reader and the card: a card owned by a worktree
  // exists in the DOM only while its project and its row are open, and jumpToAgent alone lands on
  // #jobs — the wrong place — when it is not. Same path the row's own ⧉ badge takes.
  function openAgentThread(thread) {
    if (!thread) return;
    // "Open agent" on an assistant's own message lands on THAT assistant's Chat: with two of them, comparing the
    // thread against #1's alone would open the wrong tab.
    const session = sessionRecords().find((s) => s.threadId === thread);
    if (session) {
      setView({ assistant: session.id, subTab: SUBTABS[0] });
      return;
    }
    const conv = conversations().find((c) => c.thread === thread);
    const owner = conv?.latest?.ownerPath || conv?.first?.ownerPath || null;
    const want = normPath(owner || "").toLowerCase();
    const row = want ? [...state.rows.values()].find((r) => normPath(r.path).toLowerCase() === want) : null;
    if (row) {
      const project = state.projects.get(row.project);
      const root = project ? rootOf(project) : null;
      if (root && state.collapsedRoots.has(root)) toggleRoot(root);
      if (!state.expandedProjects.has(row.project)) toggleProject(row.project);
      const key = keyOf(row.project, row.path);
      if (!state.expanded.has(key)) document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
    } else {
      // Unattached: the Agents section is its home.
      const fixed = document.getElementById("agents");
      if (fixed && fixed.classList.contains("collapsed")) revealCard("agents");
    }
    jumpToAgent(thread);
  }

  // The HUMAN rotation's way into an assistant's own card. An assistant's turn is not on the board: its card lives
  // in this float, one session tab and one Chat pane per assistant, so the path is open the float and put THAT
  // assistant's Chat on screen. The turn's own unfolded/paged state is written by app.js before it calls this,
  // because `conversationHtml` here reads the same `state.turnOpen` / `state.turnPage` a board card does — the
  // repaint this triggers is the one that draws the turn the question lives on. False means there is no session
  // record for the thread (nothing to put on screen), and the rotation steps on instead of flashing a hidden box.
  function showAssistantThread(thread) {
    const rec = sessionRecords().find((s) => s.threadId === thread);
    if (!rec) return false;
    if (!state.assistantOpen) toggleAssistant(true);
    setView({ assistant: rec.id, subTab: SUBTABS[0] });
    return Boolean(hostFor(rec.id, "chat"));
  }

  // A queue row is a CONSOLE row. `openAgentThread` opens the project, the row and the card; the reader asked for the
  // TURN too, because the worst landing is a card header in view with the console it is about somewhere below it. So
  // this unfolds the newest turn (a live one is open by default, but the reader may have folded it), scrolls that
  // console into the middle of the screen and puts the caret on it. It re-asserts for a moment: a live card is rebuilt
  // on every job frame, so the node the first pass found is gone by the second.
  function openAgentTurn(thread) {
    if (!thread) return;
    openAgentThread(thread);
    const land = () => {
      let card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
      if (!card) return; // not painted yet — the next pass looks again
      const turns = [...state.jobs.values()]
        .filter((j) => (j.thread || j.id) === thread)
        .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
      const latest = turns[turns.length - 1] || null;
      if (latest && state.turnOpen.get(turnKey(latest)) === false) {
        state.turnOpen.set(turnKey(latest), true);
        renderConversation(thread);
        // That render replaced the card, so the console below has to be looked up on the new node, not this one.
        card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
        if (!card) return;
      }
      // The newest `pre.job-out` in the card is the turn the agent is on; the ring says which console the click opened.
      const outs = [...card.querySelectorAll("pre.job-out")];
      const out = outs[outs.length - 1];
      if (!out) return;
      programmaticScroll();
      out.scrollIntoView({ block: "center", behavior: "auto" });
      out.setAttribute("tabindex", "-1");
      out.focus({ preventScroll: true });
      out.classList.add("jump");
      setTimeout(() => document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] pre.job-out.jump`)?.classList.remove("jump"), 1600);
    };
    requestAnimationFrame(land);
    setTimeout(land, 120);
    setTimeout(land, 400);
  }

  function alertHtml(a) {
    const draft = a.draft && a.draft.thread ? a.draft : null;
    const conf = draft?.confidence || "";
    const spawn = a.spawn && typeof a.spawn.prompt === "string" ? a.spawn : null;
    const parked = Boolean(a.parked);
    const choices = Array.isArray(a.choices) ? a.choices : [];
    // A parked question is the one alert whose answer settles the run: a single choice is one button, a
    // multi-select question is ticks plus Send (one click must not answer with only the first label), and a
    // typed answer goes over the same call. Draft text is only a suggestion for the box, never a reply.
    const multi = Boolean(a.multiSelect) && choices.length > 0;
    const picks = parkedPicks.get(a.id) || new Set();
    const canSend = Boolean((draft?.text || "").trim()) || (multi && picks.size > 0);
    const parkedChoices = parked && choices.length
      ? multi
        ? `<div class="as-choices is-multi">${choices
            .map(
              (c, i) =>
                `<label class="as-qcheck${picks.has(i) ? " on" : ""}"><input type="checkbox" data-as-qpick="${esc(a.id)}" data-qindex="${i}"${picks.has(i) ? " checked" : ""}><span>${esc(stripRecommended(c))}</span></label>`,
            )
            .join("")}</div>`
        : `<div class="as-choices">${choices
            .map(
              (c) =>
                `<button type="button" data-as-qchoice="${esc(a.id)}" data-choice="${esc(c)}" title="send this answer — the agent carries on with it">${esc(stripRecommended(c))}</button>`,
            )
            .join("")}</div>`
      : "";
    // A spawn card is the one alert with a real side effect: one button, and it cuts a worktree. It gets its
    // own action row so "Dismiss" cannot be mistaken for "not now, but keep the prompt".
    const actions = spawn
      ? `<button type="button" class="primary" data-as-spawn="${esc(a.id)}">${spawn.existing ? "Start worker there" : "Create worktree &amp; start"}</button>
         <button type="button" data-as-action="dismiss" data-id="${esc(a.id)}">Discard</button>
         <span class="as-err" data-as-err="${esc(a.id)}"></span>`
      : parked
        ? `${parkedChoices}
         <div class="as-draft-wrap">
           <textarea class="as-draft" data-as-qtext="${esc(a.id)}" rows="2" placeholder="${choices.length ? "or type your own answer" : "type your answer"}">${esc(draft?.text || "")}</textarea>
           <div class="as-draft-meta${(draft?.confidence || "none") === "none" ? " is-none" : ""}">${
             (draft?.confidence || "none") === "none"
               ? "no standing rule covers this"
               : draft.confidence === "rule+choice"
                 ? `a standing rule picks “${esc(stripRecommended(draft.text))}”`
                 : `drafted from ${esc(draft.source || "a rule")}`
           } · the answer unblocks ${esc(assistantThreadName(a.thread))}, it is not a reply</div>
           <div class="as-actions">
             <button type="button" class="primary" data-as-qsend="${esc(a.id)}"${canSend ? "" : " disabled"}>Send answer</button>
             ${a.thread ? `<button type="button" data-as-open="${esc(a.thread)}">Open agent</button>` : ""}
             <button type="button" data-as-action="dismiss" data-id="${esc(a.id)}">Dismiss</button>
             <span class="as-err" data-as-err="${esc(a.id)}"></span>
           </div>
         </div>`
        : `${draft ? `<button type="button" class="primary" data-as-send="${esc(a.id)}" data-thread="${esc(draft.thread)}"${draft.text ? "" : " disabled"}>Send reply</button>` : ""}
         <button type="button" data-as-action="ask" data-id="${esc(a.id)}" title="hand this to the assistant with a digest — one turn, rate limited">Ask assistant</button>
         ${a.thread ? `<button type="button" data-as-open="${esc(a.thread)}">Open agent</button>` : ""}
         <button type="button" data-as-action="dismiss" data-id="${esc(a.id)}">Dismiss</button>
         <span class="as-err" data-as-err="${esc(a.id)}"></span>`;
    return `<div class="as-alert is-${esc(a.severity || "warn")}${spawn ? " is-spawn" : ""}${parked ? " is-parked" : ""}${a.stuck ? " is-stuck" : ""}" data-alert="${esc(a.id)}">
      <div class="as-alert-head">
        <span class="as-rule is-${esc(a.severity || "warn")}">${esc(a.rule)}</span>
        ${a.stuck ? `<span class="as-stuck-chip" title="the spawn watchdog looked for a run in this card's worktree and found none">never started</span>` : ""}
        ${a.thread ? `<button class="as-thread" data-as-open="${esc(a.thread)}" type="button" title="open that agent's card">${esc(assistantThreadName(a.thread))}</button>` : ""}
        <span class="as-ago">${esc(fmtDur(Date.now() - (Date.parse(a.at) || Date.now())))} ago</span>
      </div>
      <h4>${esc(a.title)}</h4>
      ${a.detail ? `<div class="as-detail">${esc(a.detail)}</div>` : ""}
      ${(a.evidence || []).length ? `<div class="as-ev">${a.evidence.map((e) => `<span>${esc(e.label)} <b>${esc(e.value)}</b></span>`).join("")}</div>` : ""}
      ${draft && !parked ? `<div class="as-draft-wrap">
        <textarea class="as-draft" data-as-draft="${esc(a.id)}" rows="3" placeholder="${conf === "none" ? "No confident answer — write one, or leave it for later" : ""}">${esc(draft.text || "")}</textarea>
        <div class="as-draft-meta${conf === "none" ? " is-none" : ""}">${conf === "none" ? "no standing rule covers this" : `drafted from ${esc(draft.source || conf)}`} · goes into ${esc(assistantThreadName(draft.thread))} as a reply</div>
      </div>` : ""}
      <div class="as-actions">${actions}</div>
    </div>`;
  }

  function typingInside(sel) {
    const el = document.activeElement;
    return Boolean(el && el.closest?.(sel));
  }

  function renderAssistantAlerts(force = false, id = selectedSessionId()) {
    const host = hostFor(id, "alerts");
    if (!host) return;
    if (!state.assistant) {
      host.innerHTML = `<div class="as-empty">connecting…</div>`;
      return;
    }
    // A poll must not take the draft the reader is writing: the list is only repainted when nothing in it
    // holds the caret, or when the reader's own action asked for it.
    if (!force && typingInside(`#${paneIdFor(id, "alerts")}`)) return;
    // Whose list, and the toggle that says so. The pane belongs to ONE assistant, so it opens on that assistant's own
    // alerts and "All assistants" is a toggle INSIDE it: the whole board in one press, its own list again in the next.
    // The choice is kept per session (`alertAll`), so widening #1's pane cannot widen #2's, and every number beside
    // the list (the sub-tab's count, the header badge, the header's spawn badge) is read at the same scope.
    const everything = state.assistant.alerts || [];
    const every = alertAll.has(id);
    const scope = every ? "all" : id;
    const nameOfId = (x) => sessionById(x)?.name || (x === FIRST_ASSISTANT ? "Assistant #1" : x);
    const counts = { all: everything.length };
    for (const a of everything) counts[alertOwner(a)] = (counts[alertOwner(a)] || 0) + 1;
    const chip = (forScope, label, title) =>
      `<button type="button" data-as-alertwho="${esc(forScope)}" data-as-alertfor="${esc(id)}" aria-pressed="${scope === forScope ? "true" : "false"}" class="${scope === forScope ? "is-on" : ""}" title="${esc(title)}">${esc(label)} <span class="as-n">${counts[forScope] ?? 0}</span></button>`;
    const whoBar = `<div class="as-alert-who" role="group" aria-label="whose alerts">${chip(id, nameOfId(id), `only ${nameOfId(id)}'s alerts — the list, the count beside it and its spawn cards`)}${chip("all", "All assistants", "every assistant's alerts — nothing is hidden in this view")}<span class="as-hint">${
      every ? "every assistant — nothing hidden" : `this assistant's own alerts — ${alertsInScope(everything, id).length} of ${everything.length}`
    }</span></div>`;
    const mine = alertsInScope(everything, id);
    if (!mine.length) {
      const w = (state.assistant.watches || []).filter((x) => x.state !== "done" && (x.assistantId || FIRST_ASSISTANT) === id).length;
      // With one assistant in the panel there is nothing to widen to, so the pane keeps the plain words it always had
      // rather than offering a board that is already on screen.
      const alone = assistantIds().length <= 1;
      const empty = every || alone
        ? `Nothing needs you. ${w ? `Watching ${w} thing${w === 1 ? "" : "s"}.` : "No watches either."} It is still reading the board every ${state.assistant.settings?.seconds ?? 5}s.`
        : `Nothing needs ${esc(nameOfId(id))}. It is still reading the board every ${state.assistant.settings?.seconds ?? 5}s, and the whole board is one press away. <button type="button" data-as-alertwho="all" data-as-alertfor="${esc(id)}">Show all assistants</button>`;
      host.innerHTML = `${whoBar}<div class="as-empty">${empty}</div>`;
      return;
    }
    const alerts = [...mine].sort(
      (a, b) =>
        Number(Boolean(b.spawn)) - Number(Boolean(a.spawn)) ||
        Number(Boolean(b.stuck)) - Number(Boolean(a.stuck)) ||
        String(b.at).localeCompare(String(a.at)),
    );
    // A card the watchdog has already named goes above everything, in its own words: the reader is being told
    // that a spawn they may believe is running was never started, and that is not a list row to scroll for.
    const stuck = alerts.filter((a) => a.spawn && a.stuck);
    const banner = stuck.length
      ? `<div class="as-stuck-banner" role="alert"><b>${stuck.length} spawn card${stuck.length === 1 ? "" : "s"} never started${stuck.length === 1 ? "" : "s"}.</b> ${stuck.length === 1 ? "The card" : "Each card"} below named a worktree and no worker was ever started in it — press ${stuck.length === 1 ? "it" : "one"} to start that worker, or discard ${stuck.length === 1 ? "it" : "it"} so it stops asking.</div>`
      : "";
    // Spawn cards first. They are the only alerts with a button that changes the repository, and the reason
    // they were missed is that they sat among eighty findings — the oldest waiting first, so the card that has
    // been ignored longest is the one at the top.
    const spawns = alerts.filter((a) => a.spawn).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    const others = alerts.filter((a) => !a.spawn);
    const parts = [];
    if (spawns.length) {
      const latish = spawns.filter((a) => spawnAge(a) >= SPAWN_WATCH_MS).length;
      parts.push(
        `<div class="as-group-head is-spawn">spawn cards waiting <span class="as-gap"></span><span>${spawns.length}${latish ? ` · ${latish} over 2m` : ""}</span></div>`,
        spawns.map(alertHtml).join(""),
      );
    }
    if (others.length) {
      if (spawns.length) parts.push(`<div class="as-group-head">other alerts <span class="as-gap"></span><span>${others.length}</span></div>`);
      parts.push(others.map(alertHtml).join(""));
    }
    host.innerHTML = `${whoBar}${banner}${parts.join("")}`;
  }

  // ---- watches --------------------------------------------------------------------------------

  // One row of the watchlist. The list is already filtered to one assistant, so the row does not repeat whose it is:
  // the section (and the session tab above it) says that once.
  function watchRowHtml(w) {
    // A watch with a deadline carries a live clock, not a fixed "deadline 30m": the number that matters is
    // how long is left, and the bar is that number running out. Both are painted in place by
    // paintWatchClocks() once a second — a re-render per tick would take the reader's scroll and selection.
    const clock =
      w.state === "done"
        ? `<span class="as-until">done</span>`
        : w.minutes
          ? `<span class="as-watch-timer" data-watch-timer="${esc(w.id)}" data-watch-at="${esc(w.at || "")}" data-watch-min="${esc(w.minutes)}">
                   <span class="as-watch-left" data-watch-left>…</span>
                   <span class="as-bar"><i data-watch-bar style="width:100%"></i></span>
                 </span>`
          : `<span class="as-until">no deadline</span>`;
    return `<div class="as-row${w.state === "done" ? " is-done" : ""}">
          <button class="as-thread" data-as-open="${esc(w.thread)}" type="button">${esc(assistantThreadName(w.thread))}</button>
          <span class="as-what">${esc(w.title)}${w.doneWhen ? `<span class="as-hint"> · done when ${esc(w.doneWhen)}</span>` : ""}</span>
          ${clock}
          <button type="button" data-as-unwatch="${esc(w.id)}" title="stop watching this">✕</button>
        </div>`;
  }

  // Each assistant's Watches pane is ONE assistant's list: the watches it set itself (its turn's WATCH line, its
  // spawned workers) and the ones the reader added from its pane. A watch made by #2 is on #2's pane, not here — the
  // owner is stamped on the record, so switching session switches the list. The add form makes the watch for the
  // assistant whose pane it is in.
  function renderAssistantWatches(force = false, id = selectedSessionId()) {
    const host = hostFor(id, "watches");
    if (!host || !state.assistant) return;
    if (!force && typingInside(`#${paneIdFor(id, "watches")}`)) return;
    const watches = state.assistant.watches || [];
    // Whose list this is: the pane's own assistant. There is no fallback left to make — a watch list is never the
    // panel's, it is the session's whose tab holds it.
    const who = id;
    const owner = sessionById(who);
    const name = owner?.name || "Assistant #1";
    const mine = watches.filter((w) => (w.assistantId || FIRST_ASSISTANT) === who);
    const options = conversations()
      .map((c) => `<option value="${esc(c.thread)}">${esc(String(c.latest.label || c.latest.title || c.thread).slice(0, 60))}</option>`)
      .join("");
    host.innerHTML = `${mine.map(watchRowHtml).join("") || `<div class="as-empty">Nothing on ${esc(name)}'s watchlist. Tell it in Chat (“keep an eye on…”), or add one here.</div>`}
      <div class="as-form">
        <div class="as-line">
          <select id="as-w-thread" title="which agent to watch">${options || '<option value="">(no agents yet)</option>'}</select>
          <input id="as-w-title" class="as-grow" placeholder="what to watch for — e.g. the deploy finishes" />
        </div>
        <div class="as-line">
          <label>deadline <input id="as-w-min" type="number" min="1" max="1440" placeholder="minutes" /></label>
          <button id="btn-as-watch" type="button" class="primary">Add watch</button>
          <span class="as-hint">${esc(name)} will be told when that thread finishes, or when the deadline passes</span>
        </div>
        <span class="as-err" id="as-w-err"></span>
      </div>`;
    paintWatchClocks();
  }

  // "18:42" under an hour, "2h 05m" above it: a countdown is read at a glance, so it is the clock's own shape
  // rather than the panel's precise 18m42s duration.
  function leftText(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  }

  // The countdown and its reverse bar, painted once a second in place. Deliberately not a re-render: this pane
  // holds a form the reader may be typing into, and rebuilding it on every tick would take the caret, the scroll
  // and the selection with it. The bar is the fraction of the deadline still to run, so it empties as time goes.
  function paintWatchClocks() {
    const view = state.assistantView;
    if (!state.assistantOpen || view?.subTab !== "watches" || !isAssistant(view.assistant)) return;
    const host = hostFor(view.assistant, "watches");
    if (!host) return;
    const now = Date.now();
    for (const el of host.querySelectorAll("[data-watch-timer]")) {
      const at = Date.parse(el.dataset.watchAt || "");
      const mins = Number(el.dataset.watchMin);
      if (!Number.isFinite(at) || !Number.isFinite(mins) || mins <= 0) continue;
      const total = mins * 60_000;
      const left = at + total - now;
      const over = left <= 0;
      const frac = over ? 0 : Math.max(0, Math.min(1, left / total));
      const deadline = new Date(at + total);
      el.classList.toggle("is-over", over);
      const label = el.querySelector("[data-watch-left]");
      if (label) {
        label.textContent = over ? "overdue" : `${leftText(left)} left`;
        label.title = `${over ? "deadline passed" : "deadline"} ${deadline.toLocaleString()}`;
      }
      const bar = el.querySelector("[data-watch-bar]");
      if (bar) {
        bar.style.width = `${Math.round(frac * 100)}%`;
        bar.className = frac <= 0.2 ? "is-low" : frac <= 0.5 ? "is-mid" : "";
      }
      el.title = `${over ? "past its deadline" : "counting down"} · deadline ${deadline.toLocaleString()}`;
    }
  }

  // ---- end watches ------------------------------------------------------------------------------

  // ---- scratchpad -----------------------------------------------------------------------------

  // The Pad tab shows the SELECTED assistant's notes. #1's is the `notes` string the polled state carries; an extra
  // assistant's is its own notes.md, read when the tab is open — the same reason the Role tab fetches its charter
  // instead of carrying it in the poll. `padNotes` is that read, keyed by assistant id; the save's own answer
  // refreshes it, and a read older than a few seconds is re-taken so a NOTE a turn harvested while the pad is open
  // shows up without the reader reloading.
  const PAD_FRESH_MS = 10_000;
  const padNotes = new Map();
  const padInflight = new Map();

  function loadPadNotes(id) {
    if (id === FIRST_ASSISTANT) return null;
    if (padInflight.has(id)) return padInflight.get(id);
    const hit = padNotes.get(id);
    if (hit && !hit.error && Date.now() - Number(hit.at || 0) < PAD_FRESH_MS) return null;
    const read = apiFetch(`/api/assistant/notes?assistantId=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        padNotes.set(id, { ...d, at: Date.now() });
      })
      .catch((err) => padNotes.set(id, { assistantId: id, notes: "", error: String((err && err.message) || err), at: Date.now() }))
      .finally(() => {
        padInflight.delete(id);
        // One repaint of the pane on screen, WITHOUT force: a forced paint asks for a read, and a read that repaints
        // itself by force is a spinner with no end.
        if (state.assistantView?.subTab === "pad" && activeSessionId() === id) renderAssistantPad(false, id);
      });
    padInflight.set(id, read);
    return read;
  }

  // The pad for one assistant, or null while its file is being read. #1 never needs a read: its text is in the state
  // every paint already carries.
  function padFor(id) {
    if (id === FIRST_ASSISTANT) return { assistantId: id, notes: state.assistant?.notes || "", file: false, path: "", exists: true, error: null };
    const hit = padNotes.get(id);
    if (hit) {
      loadPadNotes(id); // a stale hit re-reads behind this paint
      return hit;
    }
    loadPadNotes(id);
    return null;
  }

  // A pad's controls are per assistant: two panes exist at once, so a second `#as-notes` would let the save read the
  // hidden #1 box. #1 keeps the ids every harness already drives; an extra assistant's are suffixed with its number.
  const padId = (name, id) => (id === FIRST_ASSISTANT ? name : `${name}-${String(id).replace(/^assistant-/, "")}`);

  function renderAssistantPad(force = false, id = selectedSessionId()) {
    const host = hostFor(id, "pad");
    if (!host || !state.assistant) return;
    if (!force && typingInside(`#${paneIdFor(id, "pad")}`)) return;
    const a = state.assistant;
    const rules = a.rules || [];
    // Whose pad this is: the pane's own assistant. #1's notes are the string the polled state carries; every other
    // assistant's are its own notes.md, read when its pane is open.
    const who = id;
    const owner = sessionById(who);
    const pad = padFor(who);
    const notesGroup = pad
      ? `<div class="as-group">
        <h4>Notes — read on every turn</h4>
        <textarea class="as-note-box" id="${padId("as-notes", who)}" rows="6" placeholder="What it should remember: how this project deploys, which agents are doing what, an answer you gave today…">${esc(pad.notes || "")}</textarea>
        <div class="as-actions">
          <button id="${padId("btn-as-notes", who)}" data-as-padsave="${esc(who)}" type="button" class="primary">Save notes</button>
          <span class="as-hint" title="${esc(pad.path || "")}">${pad.file ? "kept in this assistant's own notes.md" : "kept on the server in assistant.json"}</span>
          <span class="as-err" id="${padId("as-pad-err", who)}">${esc(pad.error || "")}</span>
        </div>
      </div>`
      : `<div class="as-group">
        <h4>Notes — read on every turn</h4>
        <div class="as-help">reading ${esc(owner?.name || who)}'s pad…</div>
      </div>`;
    host.innerHTML = `
      ${notesGroup}
      <div class="as-group">
        <h4>Standing rules — its only confident answers</h4>
        ${rules.map((r) => `<div class="as-rule-row${r.by === "assistant" ? " is-by-assistant" : ""}"><span class="as-rule-name">${esc(r.text)}${r.by === "assistant" ? `<i class="as-rule-by" title="the assistant wrote this one; delete it if it is wrong">assistant</i>` : ""}</span><button type="button" data-as-unrule="${esc(r.id)}" title="remove this rule">✕</button></div>`).join("") || `<div class="as-help">None yet. A rule is an answer you have given once and do not want to give twice.</div>`}
        <div class="as-form">
          <div class="as-line">
            <input id="${padId("as-rule-text", who)}" class="as-grow" placeholder="e.g. Deploy to QA, never PROD, from a worktree agent" />
            <button id="${padId("btn-as-rule", who)}" data-as-padrule="${esc(who)}" type="button">Add rule</button>
          </div>
        </div>
      </div>
      <div class="as-group">
        <h4>Journal</h4>
        <div class="as-journal">${
          (a.journal || [])
            .map((j) => `<div><span class="t">${esc(new Date(j.at).toLocaleTimeString())}</span> <span class="k">${esc(j.kind)}</span> ${esc(j.text)}</div>`)
            .join("") || `<div class="as-help">quiet</div>`
        }</div>
      </div>`;
  }

  // ---- end scratchpad ---------------------------------------------------------------------------

  // ---- messages ------------------------------------------------------------------------------

  // The board is the whole seven-day conversation, so it is NOT in the polled state (which is re-sent on
  // every board event): this pane reads it from its own route, and re-reads it on the panel's refresh
  // clock while it is the tab on screen. Nothing is cached between reads — the server builds the view per
  // request from the job store and the assistant's journal — so there is no second copy of the log here to
  // prune at seven days, and no way for this pane to drift from what the panel actually recorded.
  const MSG_REFRESH_MS = 15000;
  const MSG_RETRY_MS = 5000;
  const MSG_TEXT_CHARS = 320;
  let msgBoard = null; // the last answer from the server
  let msgErr = "";
  let msgAt = 0;
  let msgTried = false;
  let msgDir = "all"; // the in-tab chip: all | out | in
  // WHOSE messages a pane shows. Each assistant's Messages pane opens on ITS OWN split, and "All" is a toggle INSIDE
  // that pane — the whole board in one press, its own split again in the next. `msgAll` is keyed by session, so
  // widening #1's pane never widens #2's. This is a CLIENT filter over the one answer the server sends, so the counts
  // and the entry set cannot disagree about what "All" means.
  const msgAll = new Set(); // the sessions whose messages pane is widened to the whole board
  const msgScopeOf = (id) => (msgAll.has(id) ? "all" : id);
  const msgOpen = new Set(); // entries the reader expanded — a repaint must not fold them back up

  async function loadMessages(force = false) {
    if (!force && msgTried && Date.now() - msgAt < MSG_RETRY_MS) return;
    msgTried = true;
    try {
      const r = await apiFetch("/api/assistant/messages");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      msgBoard = d.messages || null;
      msgErr = "";
    } catch (err) {
      msgErr = String((err && err.message) || err);
    }
    msgAt = Date.now();
    renderAssistantMessages();
  }

  const msgClip = (s, n) => {
    const t = String(s ?? "");
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  // Which way the message went, in words. Never colour alone: the direction is a sentence on the entry
  // itself, and the same sentence is in the entry's accessibility label.
  function msgDirLabel(e) {
    const onAssistant = e.thread === state.assistantThread;
    const thread = onAssistant ? "the assistant" : e.thread || "(no thread)";
    if (e.dir === "in") return onAssistant ? "the assistant → you" : `${thread} → assistant`;
    if (e.from === "you") return `you → ${thread}`;
    if (e.from === "panel") return `the panel → ${thread}`;
    return onAssistant ? "the board → the assistant" : `assistant → ${thread}`;
  }

  function msgTimeHtml(e) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) return `<span class="as-ago">—</span>`;
    return `<span class="as-ago" title="${esc(new Date(at).toLocaleString())}">${esc(relTime(e.at))} ago</span>`;
  }

  function msgMetaHtml(e) {
    const chip = (label, value, title = "") => `<span title="${esc(title || `${label}: ${value}`)}">${esc(label)} <b>${esc(value)}</b></span>`;
    const bits = [];
    if (e.dir === "out") {
      if (e.status) bits.push(chip("run", e.status));
      // A wake runs in the assistant's own thread and is filed under the thread it was about: say so,
      // because "ran in" is the one thing a reader could otherwise get wrong about it.
      if (e.ranIn && e.ranIn !== e.thread) bits.push(chip("ran in", e.ranIn, "the thread this turn actually ran in — it is filed under the thread it was woken about"));
      if (e.worktree) bits.push(chip("tree", tailPath(e.worktree, 2), e.worktree));
      if (e.branch) bits.push(chip("branch", e.branch));
      return bits;
    }
    const c = e.completion;
    if (c) {
      bits.push(chip("ended", `${c.word}${c.reason ? ` — ${msgClip(c.reason, 100)}` : ""}`, `the run ended ${c.word}${c.reason ? `: ${c.reason}` : ""}`));
      if (c.duration) bits.push(chip("took", c.duration));
      if (c.branch) bits.push(chip("branch", c.branch));
      if (c.worktree) bits.push(chip("tree", tailPath(c.worktree, 2), c.worktree));
      if (c.commits !== null) bits.push(chip("commits", String(c.commits)));
      if (c.treeExists === false) bits.push(`<span>its worktree is no longer on disk</span>`);
      else if (c.treeNote) bits.push(`<span title="${esc(c.treeNote)}">${esc(msgClip(c.treeNote, 80))}</span>`);
    }
    if (e.empty && e.wordsFrom) bits.push(chip("held", e.wordsFrom, e.wordsFrom));
    const q = e.question;
    if (q) {
      if (q.choices.length) bits.push(chip(q.multiSelect ? "choices (multi-select)" : "choices", q.choices.join(" · ")));
      if (q.answered) bits.push(chip("answered", q.answer, "the answer the panel sent back"));
      else if (q.withdrawn) bits.push(`<span>it left without an answer — withdrawn, timed out, or answered on another surface</span>`);
      else bits.push(chip("waiting", "still parked on it"));
    }
    return bits;
  }

  // The report path is the way the reader opens what the worker wrote, so it is a real control rather than
  // text: the panel's own open (an editor) and its own copy, on the path the record holds.
  function msgReportHtml(e) {
    const r = e.report;
    if (!r || !r.path) return "";
    return `<div class="as-msg-report">
      <span class="as-hint">report</span>
      <button type="button" class="as-msg-path mono" data-open-path="${esc(r.path)}" title="open ${esc(r.path)}">${esc(r.path)}</button>
      <button type="button" class="as-msg-copy mono" data-copy-path="${esc(r.path)}" title="copy this path">copy</button>
      ${Number.isFinite(Number(r.bytes)) && r.bytes ? `<span class="as-hint">${esc(fmtBytes(r.bytes))}</span>` : ""}
    </div>`;
  }

  // An entry whose text the panel no longer holds says what it is holding instead of showing an empty
  // box: a run that ended with nothing recorded, a question that left unanswered, a turn that is gone
  // from the store but still in the journal.
  function msgMissingText(e) {
    if (e.kind === "final") return "this turn ended with no final message and no transcript left in the store — the panel watched it end and holds nothing it said";
    if (e.kind === "answer") return "the question left without an answer (withdrawn, timed out, or answered on another surface)";
    if (e.kind === "question") return "the question itself is no longer in the store — only that it was asked, and the answer below";
    return "the panel holds no text for this entry";
  }

  function msgEntryHtml(e) {
    const kind = (msgBoard?.kinds || {})[e.kind] || {};
    const dir = msgDirLabel(e);
    const label = kind.label || e.kind;
    const text = String(e.text || "");
    const long = text.length > MSG_TEXT_CHARS;
    const open = msgOpen.has(e.id);
    const meta = msgMetaHtml(e);
    const report = msgReportHtml(e);
    const body = !text.trim()
      ? `<div class="as-msg-text is-missing">${esc(msgMissingText(e))}</div>`
      : `<div class="as-msg-text">${esc(long && !open ? `${text.slice(0, MSG_TEXT_CHARS)}…` : text)}${e.clipped ? `<span class="as-msg-cut"> (the panel clipped this message at its own cap)</span>` : ""}</div>`;
    const aria = `${dir}, ${label}, ${relTime(e.at)} ago: ${msgClip(text.replace(/\s+/g, " "), 160) || msgMissingText(e)}`;
    return `<div class="as-msg is-${e.dir}" role="listitem" data-msg="${esc(e.id)}" data-dir="${e.dir}" aria-label="${esc(aria)}">
      <div class="as-msg-head">
        <span class="as-msg-dir">${esc(dir)}</span>
        <span class="as-msg-kind" title="${esc(kind.hint || "")}">${esc(label)}</span>
        ${e.source === "journal" ? `<span class="as-msg-src" title="the panel's job store no longer holds this turn — the assistant's own journal is what is left of it">from the journal</span>` : ""}
        ${msgTimeHtml(e)}
      </div>
      ${body}
      ${long ? `<button type="button" class="as-msg-more" data-as-msg-more="${esc(e.id)}" aria-expanded="${open ? "true" : "false"}">${open ? "show less" : `show the whole message (${text.length} chars)`}</button>` : ""}
      ${meta.length ? `<div class="as-msg-meta">${meta.join("")}</div>` : ""}
      ${report}
    </div>`;
  }

  function msgGroupHtml(g) {
    const name = g.name || g.thread || "(no thread)";
    return `<div class="as-msg-thread${g.assistant ? " is-assistant" : ""}" role="list" aria-label="${esc(`${name}: ${g.count} message${g.count === 1 ? "" : "s"}, newest ${relTime(g.newestIso)} ago`)}">
      <div class="as-msg-thread-head">
        <button type="button" class="as-thread" data-as-open="${esc(g.thread || "")}" title="open that agent's card">${esc(name)}</button>
        ${g.thread && g.thread !== name ? `<span class="as-hint mono">${esc(g.thread)}</span>` : ""}
        ${g.project ? `<span class="as-hint">${esc(g.project)}</span>` : ""}
        <span class="as-hint">${g.count} message${g.count === 1 ? "" : "s"}</span>
        <span class="as-ago" title="${esc(new Date(g.newest).toLocaleString())}">${esc(relTime(g.newestIso))} ago</span>
      </div>
      ${g.entries.map(msgEntryHtml).join("")}
    </div>`;
  }

  function renderAssistantMessages(id = selectedSessionId()) {
    const host = hostFor(id, "messages");
    if (!host) return;
    if (!msgTried) {
      void loadMessages();
      return;
    }
    const b = msgBoard;
    if (!b) {
      host.innerHTML = `<div class="as-empty">${msgErr ? `could not read the message board: ${esc(msgErr)}` : "reading the message board…"}</div>`;
      return;
    }
    const scroller = host.closest(".as-body");
    const keepScroll = scroller ? scroller.scrollTop : 0;
    // Every entry the board holds, with its owner made explicit. The server stamps each one; a payload from an
    // older panel (or a direct caller of buildMessages) reads as Assistant #1's, which is what absence meant.
    const all = (b.groups || []).flatMap((g) => g.entries.map((e) => ({ ...e, assistantId: e.assistantId || FIRST_ASSISTANT })));
    const ids = assistantIds();
    // The pane's own split, or the whole board when this assistant's All toggle is on. Both the rows and the counts
    // are read off this list, so a chip's number is the number of rows pressing it will show.
    const who = msgScopeOf(id);
    const nameOfId = (x) => sessionById(x)?.name || (x === FIRST_ASSISTANT ? "Assistant #1" : x);
    const inWho = who === "all" ? all : all.filter((e) => e.assistantId === who);
    const dirs = ["all", "out", "in"];
    const dirLabel = { all: "All", out: "Sent", in: "Received" };
    const dirCount = {
      all: inWho.length,
      out: inWho.filter((e) => e.dir === "out").length,
      in: inWho.filter((e) => e.dir === "in").length,
    };
    const groups = (b.groups || [])
      .map((g) => ({
        ...g,
        entries: g.entries
          .map((e) => ({ ...e, assistantId: e.assistantId || FIRST_ASSISTANT }))
          .filter((e) => (msgDir === "all" || e.dir === msgDir) && (who === "all" || e.assistantId === who)),
      }))
      .filter((g) => g.entries.length);
    const shown = groups.reduce((n, g) => n + g.entries.length, 0);
    const chips = dirs
      .map((d) => `<button type="button" data-as-msgdir="${d}" aria-pressed="${msgDir === d ? "true" : "false"}" class="${msgDir === d ? "is-on" : ""}" title="${d === "all" ? "both directions, thread by thread" : d === "out" ? "what the assistant (or the panel) sent them" : "what they sent back"}">${dirLabel[d]} <span class="as-n">${dirCount[d]}</span></button>`)
      .join("");
    // The pane's two scopes: this assistant's own split (what the pane opens on) and All. `data-as-msgfor` names which
    // session's pane the press belongs to, so one pane widening never moves another's.
    const whoCount = { all: all.length };
    for (const x of ids) whoCount[x] = 0;
    for (const e of all) whoCount[e.assistantId] = (whoCount[e.assistantId] || 0) + 1;
    const whoChip = (forScope, label, title) =>
      `<button type="button" data-as-msgwho="${esc(forScope)}" data-as-msgfor="${esc(id)}" aria-pressed="${who === forScope ? "true" : "false"}" class="${who === forScope ? "is-on" : ""}" title="${esc(title)}">${esc(label)} <span class="as-n">${whoCount[forScope] ?? 0}</span></button>`;
    const whoChips = `${whoChip(id, nameOfId(id), `only ${nameOfId(id)}'s messages`)}${whoChip("all", "All assistants", "every assistant's messages — nothing is hidden in this view")}`;
    const windowLine = `<div class="as-msg-bar">
      <span class="as-msg-window" title="the window is fixed at seven days, computed from each message's own timestamp — nothing older is shown here, whatever the store still holds">the last ${b.windowDays} days</span>
      <span class="as-hint">since ${esc(new Date(b.since).toLocaleString())}</span>
      <span class="as-hint">${b.shown} entr${b.shown === 1 ? "y" : "ies"} in ${b.counts?.threads ?? 0} thread${(b.counts?.threads ?? 0) === 1 ? "" : "s"} · ${b.counts?.out ?? 0} sent · ${b.counts?.in ?? 0} received</span>
      <span class="as-hint">${who === "all" ? "every assistant, nothing hidden" : `narrowed to ${esc(nameOfId(who))} — ${shown} of ${b.shown}`}</span>
      <span class="as-hint" title="what the view was built from: the runs this panel still holds, and the assistant's own journal. An entry the store no longer holds is marked 'from the journal' where it appears.">from ${b.counts?.jobs ?? 0} runs and ${b.counts?.journal ?? 0} journal lines${b.counts?.fromJournal ? ` · ${b.counts.fromJournal} journal-only` : ""}</span>
    </div>`;
    const capLine = b.capped
      ? `<div class="as-msg-cap" title="the cap is applied on the server, so the page never receives more than this">showing the newest ${b.shown} of ${b.total} messages in the window — the older ${b.dropped} are still in the stores, past the ${b.cap}-entry cap this view reads with</div>`
      : "";
    let list;
    if (!shown) {
      // With one assistant in the panel, its split IS the board: the plain words, with no "one press away" the reader
      // would press and get the same list back.
      const alone = ids.length <= 1;
      if (who !== "all" && !alone) {
        list = `<div class="as-empty">Nothing from ${esc(nameOfId(who))} in the last ${b.windowDays} days${msgDir === "all" ? "" : ` (${msgDir === "out" ? "sent" : "received"})`}. The whole board is still on this pane — nothing is hidden behind this view. <button type="button" data-as-msgwho="all" data-as-msgfor="${esc(id)}">Show all assistants</button></div>`;
      } else if (msgDir !== "all") {
        list = `<div class="as-empty">No ${msgDir === "out" ? "sent" : "received"} messages in the last ${b.windowDays} days. ${b.shown} message${b.shown === 1 ? "" : "s"} exist in this window in the other direction. <button type="button" data-as-msgdir="all">Show all</button></div>`;
      } else {
        list = `<div class="as-empty">Nothing in the last ${b.windowDays} days (since ${esc(new Date(b.since).toLocaleString())}). The panel holds ${b.counts?.jobs ?? 0} run${(b.counts?.jobs ?? 0) === 1 ? "" : "s"} and the assistant's journal ${b.counts?.journal ?? 0} line${(b.counts?.journal ?? 0) === 1 ? "" : "s"}, and not one of them is a message newer than that — an empty tab here is not an empty board.</div>`;
      }
    } else {
      list = groups.map(msgGroupHtml).join("");
    }
    host.innerHTML = `${windowLine}${capLine}<div class="as-msg-people" role="group" aria-label="whose messages to show">${whoChips}</div><div class="as-msg-chips" role="group" aria-label="which direction to show">${chips}</div>${list}`;
    if (scroller) scroller.scrollTop = keepScroll;
  }

  // ---- end messages ---------------------------------------------------------------------------

  // ---- the role: the job an assistant runs, and the charter it carries --------------------------

  // The text is NOT in the polled state: it runs to 20 KB and the board repaints on every event, so the pane fetches
  // the ONE assistant it is showing when it is opened instead. `roleLoaded` is what keeps the box honest — a textarea
  // that never read the file must not be able to save an empty one over it, which is why Save stays disabled until
  // the GET has landed. `roleMtime` is sent back with the save so a write the assistant made in between is a refusal
  // rather than a lost edit. Every field is keyed by the assistant it describes (`roleFor`), so a late answer for #1
  // cannot paint over #2's box.
  let roleText = null;
  let roleMtime = null;
  let roleLoaded = false;
  // WHAT the box holds, not only how big it is. `roleText` is the text last LOADED — this assistant's copy from
  // `#as-roletarget`'s file, or the picked role's own charter fetched at `#as-role-pick` — and `roleHolds` names
  // which of the two it was. They read the same when an assistant was never edited, and the difference is the
  // whole point when it was: Save always writes this assistant's COPY, so a box holding the role's text has not
  // been saved anywhere yet.
  let roleHolds = "copy";
  // What the reader has typed since that load, or null while the box still holds `roleText`. Kept outside the DOM
  // because the pane is rebuilt from state: a repaint must paint the reader's text back, never the loaded one.
  let roleDraft = null;
  // A question waiting on the reader, asked INLINE in the tab (never a browser dialog): {kind, roleId, name}.
  // kind is "pick" (load that role's text), "adopt" (copy the role's text over this assistant's copy) or "reload"
  // (read the copy from disk). The box and the picker do not move until it is answered.
  let roleAsk = null;
  // The cap the text in the box is judged against. Mostly the assistant's own (`charter.cap`), but a role's own
  // text may be over it, and then the warning has to quote the number the SERVER will refuse at.
  let roleCap = 0;
  // WHICH assistant the text in the box belongs to, and which one has already been asked for. A single boolean here
  // is the bug this replaces: the first open of the tab asked for #1, and every later assistant then read as "already
  // tried" — its box stayed empty and readonly while the pane showed its name.
  let roleTriedFor = "";
  let roleFor = "";
  let roleLoadedAt = 0;
  let roleErr = "";
  let rolePick = "";
  let roleInfo = null;
  let roleRoles = [];
  // Which assistant the Role tab is editing. A role belongs to ONE assistant, and the tab is a list tab (it sits
  // beside Alerts), so it carries its own selector and remembers the last session the reader was on.
  let roleTarget = "";
  // The one field on this tab that is NOT the charter: the default role prompt the assistant runs on. It comes in
  // with the same read that brings the charter text — one request, one answer — and it is keyed by the assistant
  // being edited, never by "the" assistant.
  let rolePrompt = "";
  const roleTargetSession = () => (isAssistant(roleTarget) ? roleTarget : lastSession);

  function loadRole(id = roleTargetSession()) {
    roleTriedFor = id;
    roleFor = id;
    return apiFetch(`/api/assistant/role?assistantId=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (d.assistant) applyAssistant(d.assistant);
        if (roleFor !== id) return;
        roleText = String(d.charter?.text ?? "");
        roleMtime = Number.isFinite(Number(d.charter?.mtime)) ? Number(d.charter.mtime) : null;
        roleInfo = { role: d.role, sameAsRole: Boolean(d.sameAsRole), charter: d.charter, target: d.target };
        roleRoles = Array.isArray(d.roles) ? d.roles : [];
        // The read is the assistant's COPY, and the box says so. Any pending question or typed draft belongs to the
        // text that read replaces, so both go with it.
        roleHolds = "copy";
        roleDraft = null;
        roleAsk = null;
        roleCap = Number(d.charter?.cap) || roleCap;
        rolePick = d.role?.id || rolePick;
        // The non-charter field rides in the same answer, so the box opens showing what is on disk.
        rolePrompt = String(d.prompt ?? "");
        roleLoaded = true;
        roleLoadedAt = Date.now();
        roleErr = "";
      })
      .catch((err) => {
        if (roleFor === id) roleErr = String((err && err.message) || err);
      })
      .finally(() => {
        renderAssistantRole(true);
      });
  }

  function renderAssistantRole(force = false) {
    const host = as$("as-role");
    if (!host || !state.assistant) return;
    if (!force && typingInside("#as-role")) return;
    const target = roleTargetSession();
    // A different assistant is a different charter: drop what is on screen and ask for ITS text instead of painting
    // #1's under #2's name. `roleTriedFor` is per assistant, so opening the tab for a second one fetches it, while a
    // failed fetch is still not retried on every repaint — Reload from disk is what does that.
    if (roleFor !== target) {
      roleLoaded = false;
      roleText = null;
      roleMtime = null;
      roleErr = "";
      roleInfo = null;
      rolePick = "";
      roleHolds = "copy";
      roleDraft = null;
      roleAsk = null;
      roleCap = 0;
      // The prompt is per assistant as well: painting #1's saved prompt under #2's name would offer the reader a
      // box that saves #2's file with #1's words in it.
      rolePrompt = "";
    }
    if (roleTriedFor !== target) void loadRole(target);
    const rec = sessionById(target);
    const c = (state.assistant.assistants || []).find((x) => x.id === target)?.charter || {};
    const role = roleInfo?.role || (rec ? { name: rec.roleName, description: "" } : null);
    const roles = roleRoles.length ? roleRoles : state.assistant.roles || [];
    const boxText = roleLoaded ? String(roleDraft ?? roleText ?? "") : "";
    const size = roleLoaded ? boxText.length : Number(c.chars) || 0;
    const cap = roleCap || Number(c.cap) || 0;
    const pct = cap ? Math.round((size / cap) * 100) : 0;
    // The cap is checked against the text that WOULD BE SENT, a loaded role's own charter included: the server's
    // 413 refuses a 20,001-character save whole, so the warning (and the disabled Save) has to land before the
    // press rather than after it. One charter here sits at 19,773 — four words from the line.
    const over = cap > 0 && size > cap;
    const dirty = roleDirty();
    const when = c.exists ? `last written ${esc(relTime(c.mtimeIso))} ago` : "not on disk yet — the panel seeds it on first boot";
    const pick = roleAsk?.kind === "pick" ? roleAsk.roleId : rolePick || role?.id || "";
    // WHICH TEXT THE BOX HOLDS. Save replaces this assistant's copy whole, so "the role's own text, fetched just
    // now and saved nowhere" and "this assistant's own copy, read from its file" are different facts, and a box
    // that cannot say which one it is asking the reader to overwrite blind. The sentence under the buttons says
    // what Save does with each.
    const holdsHint = roleHoldsLabel(dirty);
    // The inline question. Never a browser dialog: the row is part of the tab, so a reader who is mid-sentence in the
    // textarea keeps their words on screen while they answer, and a page that never repaints the tab cannot lose it.
    const ask = roleAsk
      ? {
          what:
            roleAsk.kind === "pick"
              ? `The box holds text you have not saved. Loading ${roleAsk.name}'s own charter would replace it.`
              : roleAsk.kind === "adopt"
                ? `Adopting ${roleAsk.name}'s charter replaces this assistant's copy${dirty ? " and the text in the box" : ""} whole.`
                : roleAsk.kind === "target"
                  ? `The box holds text you have not saved. Switching to ${roleAsk.name} would discard it.`
                  : "Reloading reads this assistant's copy from disk and replaces the text in the box.",
          use: roleAsk.kind === "reload" ? "Reload from disk" : roleAsk.kind === "target" ? "Switch assistant" : "Use the role's",
        }
      : null;
    const options = roles.map((r) => `<option value="${esc(r.id)}"${r.id === pick ? " selected" : ""}>${esc(r.name)}</option>`).join("");
    const sessions = sessionRecords()
      .map((s) => `<option value="${esc(s.id)}"${s.id === (roleAsk?.kind === "target" ? roleAsk.roleId : target) ? " selected" : ""}>${esc(s.name)}</option>`)
      .join("");
    host.innerHTML = `
      <div class="as-group">
        <h4>The role — the job this assistant runs, and the charter text it carries</h4>
        <div class="as-line">
          <label title="a role belongs to one assistant: this picks whose role and charter text the pane is editing">editing
            <select id="as-roletarget" data-as-roletarget>${sessions}</select></label>
          <span class="as-hint">${esc(rec?.threadId || "")}${state.assistant.assistants?.length > 1 ? " · each assistant has its own copy" : ""}</span>
        </div>
        <div class="as-line">
          <label title="the job this assistant does. Picking one changes the title and loads THAT role's own charter into the box below — Save then writes it to this assistant's copy">role
            <select id="as-role-pick" data-as-role-pick>${options}</select></label>
          <button id="btn-as-role-adopt" type="button" title="replace this assistant's charter text with the role's own text">Adopt this role's charter</button>
          <button id="btn-as-new-assistant" type="button" class="primary" title="make the next assistant from this role: its own thread, its own rules and its own copy of the charter text — Assistant #1 is not touched">New assistant from this role</button>
        </div>
        ${role ? `<div class="as-help"><b>${esc(role.name)}</b> — ${esc(role.description || "(no remit written yet)")}</div>` : ""}
        <div class="as-charter-meta">
          <code class="as-charter-path" title="${esc(c.path || "")}">${esc(c.path || "…")}</code>
          <span class="as-hint">${when}</span>
          <span class="as-hint${over ? " is-bad" : ""}" data-as-rolesize>${size}/${cap} chars${over ? ` — ${size - cap} over the cap, Save is refused` : pct >= 90 ? ` (${pct}%)` : ""}</span>
          <span class="as-hint" data-as-roleholds>${esc(holdsHint)}</span>
        </div>
        <textarea class="as-note-box as-charter-box" id="as-role-text" rows="16" spellcheck="false"${roleLoaded ? "" : " readonly"} placeholder="${roleLoaded ? "" : "reading the charter text…"}">${esc(boxText)}</textarea>
        ${over ? `<div class="as-ask is-bad" id="as-role-cap" role="status"><b>${size.toLocaleString()} characters</b> — ${(size - cap).toLocaleString()} over the ${cap.toLocaleString()}-character cap. The panel refuses a save this size: prune the oldest changelog entries, then save.</div>` : ""}
        ${ask ? `<div class="as-ask" id="as-role-ask" role="alert"><span class="as-ask-what">${esc(ask.what)}</span><button type="button" data-as-roleask="keep">Keep mine</button><button type="button" data-as-roleask="use" class="primary">${esc(ask.use)}</button></div>` : ""}
        <div class="as-actions">
          <button id="btn-as-role" type="button" class="primary"${roleLoaded && !over ? "" : " disabled"}>Save role charter</button>
          <button id="btn-as-role-reload" type="button">Reload from disk</button>
          <span class="as-hint" data-as-rolesave>${esc(roleSaveSentence(dirty))}</span>
          <span class="as-err" id="as-role-err">${esc(roleErr)}</span>
        </div>
        <div class="as-line">
          <label title="a role is a named charter: the new one starts as a copy of the role above">new role
            <input type="text" id="as-role-name" spellcheck="false" maxlength="80" placeholder="e.g. PR Reviewer"></label>
          <button id="btn-as-role-newrole" type="button" title="create a role from the charter text above, under a new name">Create role</button>
          <span class="as-hint" id="as-role-newerr"></span>
        </div>
        <div class="as-help">A role is {name, description, charter text}: the job title, one line of what it is for, and the
        long tier of memory that job needs — injected in full on every one of this assistant's turns, the way the
        standing rules and the scratchpad are. Each assistant carries its OWN copy, so editing Assistant #2's charter
        never changes what Assistant #1 is told. Keep it inside the ${cap}-character cap: prune the OLDEST changelog
        entries first. The assistant adds one with a CHARTER: line at the end of a reply.</div>
      </div>
      <div class="as-group">
        <h4>Its default role prompt — what this assistant runs on, including after a restart</h4>
        <div class="as-help">Saved in this assistant's own settings file beside its charter, and injected at the top of
        every turn it runs. It survives a restart because it is a file, not a field on this page. The charter above is
        the long tier of memory; this is the short standing instruction — the words it should answer in.</div>
        <textarea class="as-note-box" id="as-prompt-text" rows="5" spellcheck="false"${roleLoaded ? "" : " readonly"} placeholder="e.g. You are the PR reviewer: read the diff before you answer, and never approve your own work.">${esc(rolePrompt)}</textarea>
        <div class="as-actions">
          <button id="btn-as-prompt" type="button" class="primary"${roleLoaded ? "" : " disabled"}>Save default prompt</button>
          <span class="as-hint">${rolePrompt.trim() ? `${rolePrompt.trim().length} char${rolePrompt.trim().length === 1 ? "" : "s"} saved` : "nothing saved — an empty prompt adds nothing to the turn"}</span>
          <span class="as-err" id="as-prompt-err"></span>
        </div>
      </div>
      <div class="as-help">Which projects this assistant may spawn in, and which trees a SPAWN IN may target, are no
      longer lists on this tab: the SPAWN switch in its Settings is the only gate, and a tree the assistant cuts is
      <b>its own</b> — the watchdog wakes the assistant whose turn wrote the SPAWN, and the reader still sets an
      owner by hand from the board's row. Both are shown under this assistant's <b>Worktrees</b> tab.</div>`;
  }

  // Is the box holding text the last READ did not put there? Compared against the text that read loaded (this
  // assistant's copy, or the role's own charter), never against the file: a save from another surface is the 409's
  // business, not a reason to call the reader's words dirty.
  function roleDirty() {
    return Boolean(roleLoaded && roleDraft !== null && roleDraft !== String(roleText ?? ""));
  }

  // WHICH TEXT THE BOX HOLDS, in the reader's words: the two provenances Save can replace, plus the state in
  // between (a draft on top of either).
  function roleHoldsLabel(dirty = roleDirty()) {
    if (dirty) return `edited in this box, not saved — it started as ${roleHolds === "role" ? "the role's own text" : "this assistant's copy"}`;
    return roleHolds === "role"
      ? `the role's own text${roleInfo?.sameAsRole ? " — the same bytes as this assistant's copy" : " — not this assistant's copy yet"}`
      : `this assistant's own copy${roleInfo?.sameAsRole ? " — the role's own text" : " — edited from the role's text"}`;
  }

  // What the sentence under the buttons must keep true: Save writes this assistant's COPY, whole, whatever the box
  // happens to hold. A role's own text has not been saved anywhere yet, so the sentence says where it came from.
  function roleSaveSentence(dirty = roleDirty()) {
    if (!roleLoaded) return "read-only until the charter text has been read";
    if (dirty) return "the box has edits that are not saved — Save writes what is in it to this assistant's copy, replacing the copy whole";
    if (roleHolds === "role") return `read from the ${roleInfo?.role?.name || "picked"} role just now — Save writes it to this assistant's copy, replacing the copy whole`;
    return `read from disk ${relTime(new Date(roleLoadedAt).toISOString())} ago — saving replaces this assistant's copy whole`;
  }

  // The cap check, the provenance line and the Save button, repainted IN PLACE as the reader types. Not a full
  // render: that would rebuild the textarea and take the caret with it, which is the one thing a box this size
  // cannot afford.
  function paintRoleBox() {
    const box = as$("as-role-text");
    if (!box) return;
    const size = String(box.value ?? "").length;
    const cap = roleCap || Number((state.assistant?.assistants || []).find((x) => x.id === roleTargetSession())?.charter?.cap) || 0;
    const over = cap > 0 && size > cap;
    const dirty = roleDirty();
    const sizeEl = document.querySelector("#as-role [data-as-rolesize]");
    if (sizeEl) {
      sizeEl.textContent = `${size}/${cap} chars${over ? ` — ${size - cap} over the cap, Save is refused` : ""}`;
      sizeEl.classList.toggle("is-bad", over);
    }
    const holdEl = document.querySelector("#as-role [data-as-roleholds]");
    if (holdEl) holdEl.textContent = roleHoldsLabel(dirty);
    const saveHint = document.querySelector("#as-role [data-as-rolesave]");
    if (saveHint) saveHint.textContent = roleSaveSentence(dirty);
    const save = as$("btn-as-role");
    if (save) save.disabled = !roleLoaded || over;
    // The warning sits between the box and the buttons, so it is seen before the press it is about. It is created
    // once and removed when the text is pruned back under the cap.
    let warn = as$("as-role-cap");
    if (over && !warn) {
      warn = document.createElement("div");
      warn.className = "as-ask is-bad";
      warn.id = "as-role-cap";
      warn.setAttribute("role", "status");
      box.insertAdjacentElement("afterend", warn);
    }
    if (warn && over) {
      warn.textContent = `${size.toLocaleString()} characters — ${(size - cap).toLocaleString()} over the ${cap.toLocaleString()}-character cap. The panel refuses a save this size: prune the oldest changelog entries, then save.`;
    } else if (warn) {
      warn.remove();
    }
  }

  // ONE role's own charter text, by id. The picker change exists for this read: the role library owns the text, and
  // this assistant's copy is a different file — so the box must show the role's, not the copy's, after a pick.
  async function roleCharterOf(roleId) {
    const r = await apiFetch(`/api/assistant/role/charter?roleId=${encodeURIComponent(roleId)}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }

  // Pick a role and put ITS charter in the box. The role's text is read FIRST: if that fails, nothing has moved (the
  // title, the picker and the box still describe the role the assistant runs) and the error is the only change.
  // The pick is `adopt:false` — Save is still the press that writes this assistant's copy.
  async function pickRoleAndLoad(target, roleId) {
    const own = await roleCharterOf(roleId);
    const d = await asPost("/api/assistant/role/pick", { assistantId: target, roleId, adopt: false });
    rolePick = d.role?.id || roleId;
    roleInfo = { role: d.role, sameAsRole: Boolean(d.sameAsRole), charter: d.charter, target: d.target };
    roleRoles = Array.isArray(d.roles) ? d.roles : roleRoles;
    roleText = String(own.text ?? "");
    roleHolds = "role";
    roleDraft = null;
    roleAsk = null;
    roleCap = Number(own.cap) || roleCap;
    roleLoadedAt = Date.now();
    roleErr = "";
    renderAssistantRole(true);
  }

  // The adopt press, unchanged in what it does: the role's text becomes this assistant's copy. What changed is where
  // it asks — the inline row, not a browser dialog.
  async function adoptRole(target, roleId) {
    const d = await asPost("/api/assistant/role/pick", { assistantId: target, roleId, adopt: true });
    rolePick = d.role?.id || roleId;
    roleText = String(d.charter?.text ?? "");
    roleMtime = Number.isFinite(Number(d.charter?.mtime)) ? Number(d.charter.mtime) : null;
    roleInfo = { role: d.role, sameAsRole: Boolean(d.sameAsRole), charter: d.charter, target: d.target };
    roleRoles = Array.isArray(d.roles) ? d.roles : roleRoles;
    roleHolds = "copy";
    roleDraft = null;
    roleAsk = null;
    roleCap = Number(d.charter?.cap) || roleCap;
    roleLoaded = true;
    roleLoadedAt = Date.now();
    setErr("as-role-err", "");
    renderAssistantRole(true);
  }

  // ---- settings -------------------------------------------------------------------------------

  // WHICH PANE OWNS A KNOB is the SERVER's answer (`state.assistant.settingScope`, from
  // lib/assistant/config.js's SETTINGS_SCOPE), never a copy kept here. A second opinion on the page would drift
  // from the store the first time a knob was added, and a key drawn in both panes is two controls for one value.
  // An unknown key falls to the watchdog pane — the panel-wide side — so a stale page can never draw an
  // assistant's key twice.
  const scopeOfKey = (key) => (state.assistant && state.assistant.settingScope && state.assistant.settingScope[key]) || "watchdog";
  const ownsWatchdog = (key) => scopeOfKey(key) === "watchdog";

  // The assistant's select is built by the board's own option builder (public/app.js), over the shared
  // picker's rows and the one price table: same ids, same order, same price and rating text as the spawn
  // form. Nothing about models is decided here. A saved model the catalogue no longer lists is handed in
  // as an extra row, so it renders checked instead of vanishing under a save.
  function modelOptionsHtml(selected) {
    if (typeof modelOptionHtml !== "function") return `<option value="">(default)</option>`;
    const d = typeof modelsState === "undefined" ? null : modelsState;
    const known = (d?.providers || []).some((p) => (p.models || []).includes(selected));
    const extra = selected && !known ? [{ id: selected, name: `${selected} (not in the catalogue)` }] : [];
    return modelOptionHtml(d, { selected, extra });
  }

  // A saved model the catalogue no longer lists still gets a row in the shared picker — checked, so the list
  // never reads as "nothing is chosen" while a model is in force.
  function assistantModelExtra(value) {
    const id = String(value || "");
    if (!id) return [];
    const d = typeof modelsState === "undefined" ? null : modelsState;
    const known = (d?.providers || []).some((p) => (p.models || []).includes(id));
    return known ? [] : [{ id, name: `${id} (not in the catalogue)` }];
  }

  // Which threshold feeds which rule, and the words the disclosure uses for it: the RULE id is the row that
  // consumes the knob, so a bar cannot be drawn under a rule that does not read it. A rule with no entry has
  // nothing to tune — question, noevidence, collision, interrupted, settle, watch, spawnidle, spawnlost and
  // errorloop are judgement calls, and errorloop shares the loop's "same call" bar rather than owning one.
  // The bounds are the config module's (`pickSettings`), repeated here because the input has to carry them.
  // Two of them (`quietSeconds`, `childQuietSeconds`) are an ASSISTANT's quiet windows rather than the pass's,
  // so the watchdog pane filters them out of the rule it would otherwise draw them under.
  const RULE_THRESHOLDS = {
    loop: [{ key: "repeatLimit", min: 2, max: 12, before: "same call ×", after: "" }],
    quiet: [{ key: "quietSeconds", min: 30, max: 3600, before: "silent for", after: "s" }],
    approval: [{ key: "approvalSeconds", min: 15, max: 3600, before: "approval waiting", after: "s" }],
    // The EXITED rule's bar: how long the card may read EXITED before the wake. 0 is the transition itself; a
    // repair turn on the same thread before the bar takes the failure over and nothing is sent.
    exited: [{ key: "exitedSeconds", min: 0, max: 3600, before: "exited for", after: "s", title: "how long a failed run's card may read EXITED before the assistant is woken — a repair turn on the same thread before then takes it over, and 0 wakes on the transition" }],
    // The queue sweep's failsafe clock: the settle half of the rule needs no bar (a finish is the trigger), so
    // this is the one number the sweep has — how long every run of an assistant may be quiet before its queue is
    // swept anyway. 0 turns the timer off and leaves the settle trigger; the row's title says so, because a zero
    // here reads like a disabled rule otherwise.
    queuesweep: [{ key: "queueIdleMinutes", min: 0, max: 1440, before: "idle for", after: "min", title: "how long every run of an assistant may be quiet before its queue is swept anyway — the settle trigger wakes on a finish, and this is the failsafe for a row nothing will ever settle (a blocker that closed elsewhere, a SPAWN line that never ran). 0 turns the timer off; the settle trigger stays." }],
    context: [{ key: "contextPercent", min: 50, max: 100, before: "context over", after: "%" }],
    repeat: [{ key: "repeatTurns", min: 2, max: 10, before: "same failure ×", after: "", title: "consecutive turns of one thread ending on the same failure before it is reported" }],
    leftover: [{ key: "leftoverMinutes", min: 1, max: 240, before: "leftover work", after: "min", title: "how recently a worker must have finished for work left in its tree to be worth a word" }],
    child: [{ key: "childQuietSeconds", min: 60, max: 3600, before: "child silent", after: "s", title: "a delegated subagent that writes nothing for this long is worth flagging" }],
  };

  // Which disclosures the reader left open, per browser: ONE key holding the rule ids that are open, the way
  // the main panel remembers its settings groups. Closed is the default and an absent id is what says so — a
  // second list of closed ones would make "never touched" and "closed by hand" two different states.
  const THRESHOLDS_OPEN_KEY = "wtgui.assistantThresholdsOpen";

  function thresholdsOpen() {
    try {
      const raw = JSON.parse(localStorage.getItem(THRESHOLDS_OPEN_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  }

  function saveThresholdsOpen(open) {
    try {
      localStorage.setItem(THRESHOLDS_OPEN_KEY, JSON.stringify([...open]));
    } catch {
      /* private mode: the fold lasts for this visit */
    }
  }

  // `toggle` does not bubble, so the listener is per disclosure and re-attached with the markup it belongs to.
  function rememberThresholdOpen(details) {
    const id = details?.dataset?.asRuleThresholds;
    if (!id) return;
    const open = thresholdsOpen();
    if (details.open) open.add(id);
    else open.delete(id);
    saveThresholdsOpen(open);
  }

  // "1 threshold · silent for 240 s": the count and the value in force, both in plain text, so a closed
  // disclosure still says what its rule fires on without being opened.
  function thresholdSummary(list, s) {
    const values = list.map((t) => `${t.before} ${s[t.key]}${t.after ? ` ${t.after}` : ""}`).join(" · ");
    return `${list.length} threshold${list.length === 1 ? "" : "s"} · ${values}`;
  }

  // Aggressive mode holds keys on BOTH sides of the split — the pass clock and the wake budget as well as the
  // rules — so each pane answers for the keys it draws: disabled, marked, and explained in the control's title.
  // The switch-off button lives on the watchdog pane only; two buttons under one id would be a second control
  // for one action, and the assistant pane already names where it is.
  function heldSets(a) {
    const agg = a.aggressive || {};
    return {
      agg,
      knobs: new Set(agg.on ? (agg.holds && agg.holds.settings) || [] : []),
      rules: new Set(agg.on ? (agg.holds && agg.holds.rules) || [] : []),
    };
  }

  function heldBanner(agg, owned, { button = false } = {}) {
    if (!agg.on) return "";
    const held = ((agg.holds && agg.holds.settings) || []).filter((k) => owned.has(k));
    if (!held.length && !button) return "";
    const savedLine = agg.restore
      ? `${agg.restore.present} of your own value${agg.restore.present === 1 ? "" : "s"} come back when it is switched off; ${agg.restore.absent} key${agg.restore.absent === 1 ? "" : "s"} that were absent will be deleted again so they follow their default.`
      : "";
    return `<div class="as-group as-held">
        <h4>⚡ Aggressive mode is holding these</h4>
        <div class="as-help">The settings and rules marked <b>held</b> ${button ? "below" : "in this tab"} are set to the aggressive profile and cannot be changed${
          button
            ? ` from this tab. Switch aggressive mode off with the button below (Alt+Shift+A works too) and they are put back exactly as you had them${savedLine ? ` — ${esc(savedLine)}` : ""}`
            : `. Switch it off with the <b>⚡ Aggressive</b> switch at the top of this tab (Alt+Shift+A) and they are put back exactly as you had them${savedLine ? ` — ${esc(savedLine)}` : ""}`
        }</div>
        ${button ? `<div class="as-line"><button type="button" id="btn-as-aggressive-off" title="switch aggressive mode off and put your own settings back">Switch aggressive mode off</button></div>` : ""}
      </div>`;
  }

  // THE WATCHDOG: the panel's one sentry.
  //
  // One value for the whole panel, which is why it is a tab of the float rather than a sub-tab of an assistant:
  // one pass over the board, one journal, one escalation table. A copy under each assistant would be several
  // controls for one value — the defect the per-assistant split exists to remove. What it draws is exactly the
  // keys lib/assistant/config.js marks `watchdog`; an assistant's own settings are in that assistant's Settings.
  function renderWatchdog(force = false) {
    const host = as$("as-watchdog");
    if (!host || !state.assistant) return;
    if (!force && typingInside("#as-watchdog")) return;
    const a = state.assistant;
    const s = a.settings;
    const defs = a.ruleDefs || {};
    const levels = a.escalations || ["log", "alert", "wake", "act"];
    const health = a.health || {};
    const hs = sentryState(health);
    const lastPass = health.lastTickAt ? `${Math.max(0, Math.round((Date.now() - health.lastTickAt) / 1000))}s ago` : "not yet";
    const { agg, knobs, rules: heldRules } = heldSets(a);
    const dis = (key) => (knobs.has(key) ? ' disabled title="aggressive mode holds this setting — switch it off with the ⚡ Aggressive switch in its Settings tab to change it"' : "");
    const disRule = (id) => (heldRules.has(id) ? ' disabled title="aggressive mode holds this rule — switch it off with the ⚡ Aggressive switch in its Settings tab to change it"' : "");
    // Read once per paint: a repaint recreates every disclosure, so the remembered ones are reopened from here
    // rather than from a class left behind on an element that no longer exists.
    const openThresholds = thresholdsOpen();
    const owned = new Set(Object.keys(a.settingScope || {}).filter((k) => ownsWatchdog(k)));
    host.innerHTML = `
      ${heldBanner(agg, owned, { button: true })}
      <div class="as-group">
        <h4>The watchdog</h4>
        <div class="as-help">This panel runs ONE watchdog: one pass over the board, one journal and one escalation
        table, whichever assistants exist. Everything in this tab is the panel's, so it is set once. What belongs to
        one assistant — its model, its autonomy, its spawn mode, its wake budget and quiet windows — is in that
        assistant's <b>Settings</b> tab; its role prompt is in its <b>Role</b> tab and the trees it owns are in its
        <b>Worktrees</b> tab.</div>
        <div class="as-line">
          <label${knobs.has("enabled") ? ' class="as-held-label"' : ""}>watching <input type="checkbox" data-as-set="enabled"${s.enabled ? " checked" : ""}${dis("enabled")}></label>
          <label${knobs.has("commandAudit") ? ' class="as-held-label"' : ""} title="every command line an assistant turn writes is counted against what the panel did with it: the eight kinds, one ledger per turn. report raises a red card naming the turn, the kind and how many lines were read and never carried out, and writes that to the journal the digest reads. enforce does the same and then carries those lines out once on the next pass — never a line that already ran. A near-miss line (a known prefix that misses its shape) is journalled as unparsed instead of vanishing.">command audit <select data-as-set="commandAudit"${dis("commandAudit")}>${(a.commandAuditModes || ["off", "report", "enforce"]).map((v) => `<option value="${v}"${s.commandAudit === v ? " selected" : ""}>${v === "off" ? "off — nothing is checked" : v === "report" ? "report — red card and journal" : "enforce — also replay once"}</option>`).join("")}</select></label>
        </div>
        <div class="as-line"><label${knobs.has("spawnAutoStart") ? ' class="as-held-label"' : ""} title="a spawn card with no run behind it is always named after about two minutes. With this on, the panel starts that card once by itself instead of only telling you — it never retries a card it has already tried, and a card you discarded is never started">auto-start a stuck card <input type="checkbox" data-as-set="spawnAutoStart"${s.spawnAutoStart ? " checked" : ""}${dis("spawnAutoStart")}></label><span class="as-hint">one attempt, never a retry — off by default</span></div>
        <div class="as-help"><b>watching</b> is the alert switch: while it is off no rule is evaluated at all, so nothing is noticed and nothing is journalled. <b>command audit</b> is the journal's other half: off reads nothing, report raises a red card and a journal line, enforce also carries out the lines nothing accounted for. With auto-start on, a card nobody clicked is started once by the panel rather than only being named.</div>
        <div class="as-help">sentry: ${hs ? `<b>${esc(hs)}</b> — the server watchdog restarts the clock and runs a missed pass` : "clock running"} · last pass ${esc(lastPass)} · every ${esc(String(health.everySeconds || s.seconds))}s${health.resumed ? " · resumed after a restart" : ""}</div>
      </div>
      <div class="as-group">
        <h4>Every pass</h4>
        <div class="as-line"><label${knobs.has("seconds") ? ' class="as-held-label"' : ""} title="how often the sentry looks at the board">pass every <input type="number" min="2" max="120" data-as-set="seconds" value="${s.seconds}"${dis("seconds")}> s</label></div>
        <div class="as-help">One pass is one look at every card, approval and watch. The bar each rule fires on sits
        under the rule itself below, except the two quiet windows, which are an assistant's rather than the pass's.</div>
      </div>
      <div class="as-group">
        <h4>Per-rule escalation</h4>
        ${Object.entries(defs)
          .map(([id, def]) => {
            const all = RULE_THRESHOLDS[id] || [];
            // Only the bars the PASS owns are drawn here; the two quiet windows are the assistant's own numbers,
            // and drawing them here as well is the duplicate this split removes.
            const thresholds = all.filter((t) => ownsWatchdog(t.key));
            const elsewhere = all.filter((t) => !ownsWatchdog(t.key));
            // The disclosure sits directly under the row it feeds, closed unless the reader left it open. Its
            // summary names the value in force, so a rule row and its bar read as one thing even folded.
            const disclosure = thresholds.length
              ? `<details class="as-rule-thresholds" data-as-rule-thresholds="${esc(id)}"${openThresholds.has(id) ? " open" : ""}>
              <summary title="the bar this rule fires on — open to change it">${esc(thresholdSummary(thresholds, s))}</summary>
              <div class="as-line">${thresholds
                .map(
                  (t) => `<label${t.title ? ` title="${esc(t.title)}"` : ""}>${esc(t.before)} <input type="number" min="${t.min}" max="${t.max}" data-as-set="${t.key}" value="${s[t.key]}"${dis(t.key)}>${t.after ? ` ${esc(t.after)}` : ""}</label>`,
                )
                .join("")}</div>
              ${id === "loop" ? `<div class="as-help">Raise this if “same call” is noisy on your agents — an identical error repeating is judged on the same bar.</div>` : ""}
            </details>`
              : "";
            const movedHelp = elsewhere.length
              ? `<div class="as-help">Its bar — ${esc(elsewhere.map((t) => `${t.before} ${s[t.key]}${t.after ? ` ${t.after}` : ""}`).join(" · "))} — is a quiet window of an assistant's, set in that assistant's <b>Settings</b> tab.</div>`
              : "";
            return `<div class="as-rule-row">
              <span class="as-rule-name"><b>${esc(def.label)}</b><i>${esc(def.hint)}</i></span>
              <select data-as-rule="${esc(id)}"${disRule(id)}>${levels.map((v) => `<option value="${v}"${s.rules[id] === v ? " selected" : ""}>${v}</option>`).join("")}</select>
            </div>${disclosure}${movedHelp}`;
          })
          .join("")}
        <div class="as-help">log keeps it in the journal · alert shows it under Alerts · wake asks the assistant about it (rate limited) · act wakes it and lets it send a reply when autonomy allows.</div>
        <div class="as-help">Leftover work and a silent child are judged from what the board and the gateway already know — no extra git or sqlite pass.</div>
      </div>
      <div class="as-group">
        <h4>Now</h4>
        <div class="as-line">
          <button type="button" id="btn-as-check" title="one sentry pass, no waiting for the clock">Check the board now</button>
          <button type="button" id="btn-as-wake" title="ask the assistant what it sees — one turn">Ask what it sees</button>
          <span class="as-err" id="as-watchdog-err"></span>
        </div>
        <div class="as-help">${a.sweeps.lastHour}/${a.sweeps.limit} sweep wakes in the last hour — events are never budgeted${a.wakePending ? ` · ${a.wakePending} queued behind the running turn` : ""} · scratchpad at ${esc(a.settings.model || "(gateway default model)")}</div>
      </div>`;
    // Each threshold disclosure remembers itself. `toggle` does not bubble, and this repaint replaces the
    // elements rather than mutating them, so the listener goes on the new element every time.
    for (const d of host.querySelectorAll?.("details.as-rule-thresholds") || []) {
      d.addEventListener("toggle", () => rememberThresholdOpen(d));
    }
  }

  // ---- the bridge: one agent, no worktree, no queue ------------------------------------------------
  //
  // The Matrix/Element bridge is not a session: it has no thread, no worktree and no queue of its own. It is ONE
  // agent for the panel, so its tab sits beside Role and Watchdog rather than inside an assistant. It talks to the
  // reader on their phone and files work into assistants' queues; what this pane owns is what the reader needs to
  // trust it: the process (pid, liveness, the bridge.env PATH — never a value from that file), the room and its
  // senders, the last messages each way, the policy the reader writes for it, and the failures worth acting on.
  //
  // The pane is painted from GET /api/matrix/status, one answer carrying the bridge, the Element channel, the
  // policy, the bridge's OWN reminder list (with the assistants' watches as a read-only projection) and a fresh
  // gateway probe. That is deliberate: six sections drawn from six requests would disagree about the moment they
  // describe. The policy box and the reminder list are the editable things — the bridge's own, never an
  // assistant's watches — and the policy draft lives outside the DOM so a poll cannot take the reader's words.
  const BRIDGE_POLL_MS = 15_000;
  const BRIDGE_MSG_N = 10;
  const BRIDGE_TEXT_CLIP = 280;
  let bridgeData = null;
  let bridgeErr = "";
  let bridgeAt = 0;
  let bridgeTried = false;
  let bridgeLoading = false;
  let bridgeDraft = null; // the text typed in the policy box; null while it still holds the loaded text
  let bridgeSavedNote = "";
  let bridgePolicyMtime = null;

  const bridgeWhen = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    return `${esc(relTime(iso))} ago · ${esc(new Date(t).toLocaleString())}`;
  };
  const bridgeClip = (s, n = BRIDGE_TEXT_CLIP) => {
    const text = String(s == null ? "" : s);
    return text.length > n ? `${text.slice(0, n - 1)}…` : text;
  };
  const bridgeDot = (kind) => `<span class="as-bridge-dot is-${esc(kind)}" aria-hidden="true"></span>`;

  // The health verdict, in one place, because the Connection row and the Alerts row must not disagree. It is
  // ordered by what blocks the bridge first: a missing script cannot be fixed by starting it, and a stale pid is
  // not a running process. An empty room is a refusal, not an assumption — the bridge would launch into nothing.
  function bridgeHealth(b = {}) {
    if (!b.scriptPath) return { kind: "bad", label: "not configured", detail: "no bridge script is set — matrix.scriptPath names it in Settings → Gateway" };
    if (!b.scriptPresent) return { kind: "bad", label: "script missing", detail: `no bridge script at ${b.scriptPath}` };
    if (!b.pythonPath) return { kind: "bad", label: "no interpreter", detail: "matrix.pythonPath is empty, so there is nothing to run the script with" };
    if (!b.pythonPresent) return { kind: "bad", label: "interpreter missing", detail: `no interpreter at ${b.pythonPath}` };
    if (!b.credentialsPresent) return { kind: "bad", label: "bridge.env missing", detail: `no bridge.env at ${b.envPath || "(the script's folder)"} — the bridge would refuse to log in` };
    if (!b.roomId) return { kind: "bad", label: "no room", detail: "matrix.roomId is empty, so a start would launch the bridge into nothing" };
    // A live process is the answer, even if the BOOT spawn failed earlier: the reader may have started it by hand
    // since, and the boot record is history rather than the state of the bridge now.
    if (b.running) return { kind: "ok", label: "alive", detail: `pid ${b.pid}` };
    if (b.boot && b.boot.error) return { kind: "bad", label: "auto-start failed", detail: String(b.boot.error) };
    if (b.stalePid) return { kind: "warn", label: "stopped, stale pid", detail: `pid ${b.stalePid} is a record whose process is gone — a stale record is not a running bridge` };
    return { kind: "warn", label: "stopped", detail: "no live pid is recorded; Start it in Settings → Gateway" };
  }

  async function loadBridge(force = false) {
    if (bridgeLoading) return;
    if (!force && bridgeTried && Date.now() - bridgeAt < BRIDGE_POLL_MS) return;
    bridgeLoading = true;
    bridgeTried = true;
    try {
      const r = await apiFetch("/api/matrix/status");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      bridgeData = d;
      // The mtime travels with the SAVE as the guard the reader's text was read against. A poll must not quietly
      // refresh it while a draft is in the box: that would let the draft save over a file another writer changed
      // since it was loaded, which is exactly the lost edit the 409 exists to prevent.
      if (bridgeDraft === null) bridgePolicyMtime = d.policy?.mtime ?? null;
      bridgeErr = "";
    } catch (err) {
      bridgeErr = String((err && err.message) || err);
    } finally {
      bridgeLoading = false;
      bridgeAt = Date.now();
      if (state.assistantView?.assistant === "bridge") renderBridge();
    }
  }

  async function refreshBridge() {
    bridgeSavedNote = "";
    await loadBridge(true);
    // The press leaves the caret on this button, inside the pane: the unforced paint in `loadBridge` declines while
    // anything in the pane holds the focus, so the answer the press asked for is drawn here, explicitly.
    renderBridge(true);
  }

  // The draft is the reader's; the loaded text is the server's. A poll may replace the latter but never the former,
  // and "Reload from disk" is the only press that drops a draft.
  function bridgeBoxText() {
    return bridgeDraft !== null ? bridgeDraft : String(bridgeData?.policy?.text ?? "");
  }

  function bridgePolicyPaint() {
    const cap = Number(bridgeData?.policy?.cap) || 0;
    const size = bridgeBoxText().length;
    const el = document.querySelector("[data-as-bridge-size]");
    if (el) {
      el.textContent = cap ? `${size}/${cap} chars` : `${size} chars`;
      el.classList.toggle("is-bad", Boolean(cap && size > cap));
    }
    const save = as$("btn-as-bridge-policy-save");
    if (save) save.disabled = Boolean(cap && size > cap) || !bridgeData;
  }

  async function saveBridgePolicy(button) {
    if (!bridgeData) return;
    const text = String(document.querySelector("#as-bridge-policy-text")?.value ?? "");
    if (button) button.disabled = true;
    try {
      const d = await asPost("/api/matrix/policy", { text, expectMtime: bridgePolicyMtime });
      bridgeData = { ...bridgeData, policy: d };
      bridgePolicyMtime = d.mtime ?? null;
      bridgeDraft = null;
      bridgeSavedNote = `saved — ${d.chars}/${d.cap} characters, source ${d.source}`;
      setErr("as-bridge-policy-err", "");
      renderBridge(true);
    } catch (err) {
      // A refusal (stale, too long, a write failure) keeps the reader's text in the box: the draft is theirs, and
      // replacing it with the old file is how a save gets pressed twice with the wrong copy.
      setErr("as-bridge-policy-err", String((err && err.message) || err));
      bridgeSavedNote = "";
      if (button) button.disabled = false;
    }
  }

  function bridgeMessageHtml(m, dir) {
    const out = dir === "out";
    const status = out ? String(m.status || "?") : (m.bridgeAt ? `read ${m.bridgeAt}` : "read");
    const bad = out && Boolean(m.applyError || (m.send && m.send.ok === false) || ["unsent", "held"].includes(m.status));
    const when = out ? m.sentAt || m.at || m.editedAt : m.at;
    const n = out && m.n ? ` · wait ${esc(String(m.n))}` : "";
    const failure = bad
      ? `<div class="as-bridge-fail">${esc(m.send?.error || m.applyError || "NOT DELIVERED — the bridge refused the message")}</div>`
      : "";
    const clipped = m.clipped && !out ? `<div class="as-hint">clipped — this pane keeps a recent-events view, never the room's transcript</div>` : "";
    return `<div class="as-bridge-msg is-${dir}${bad ? " is-bad" : ""}">
      <div class="as-bridge-msg-head"><b>${out ? "OUT" : "IN"}</b><span>${esc(status)}${n}</span><span class="as-ago">${bridgeWhen(when)}</span></div>
      <div class="as-bridge-msg-text">${esc(bridgeClip(m.text))}</div>${failure}${clipped}
    </div>`;
  }

  function renderBridge(force = false) {
    const host = as$("as-bridge");
    if (!host) return;
    // A poll must never take the reader's caret out of the policy box. The reader's own press (Reload, Save,
    // Refresh) is forced and lands where they are looking.
    if (!force && typingInside("#as-bridge")) return;
    if (!bridgeTried) {
      host.innerHTML = `<div class="as-empty">reading the bridge…</div>`;
      void loadBridge();
      return;
    }
    if (!bridgeData) {
      host.innerHTML = `<div class="as-empty">could not read the bridge: ${esc(bridgeErr || "no answer")} <button type="button" id="btn-as-bridge-refresh">Refresh</button></div>`;
      return;
    }
    const b = bridgeData.bridge || {};
    const el = bridgeData.element || {};
    const gw = bridgeData.gateway || {};
    const policy = bridgeData.policy || {};
    const activity = el.activity || {};
    const health = bridgeHealth(b);
    const allow = b.senderAllowList || {};
    const allowText = allow.mode === "room"
      ? allow.roomId
        ? `any member of ${allow.roomId}`
        : "no room set — nobody can reach it"
      : (Array.isArray(allow.senders) && allow.senders.length ? allow.senders.join(", ") : "none configured");
    const allowKind = allow.roomId ? (allow.mode === "room" ? "" : "ok") : "bad";
    const row = (label, value, kind = "", title = "") =>
      `<div class="as-bridge-row"><span class="as-bridge-k">${esc(label)}</span><span class="as-bridge-v${kind ? ` is-${esc(kind)}` : ""}"${title ? ` title="${esc(title)}"` : ""}>${value}</span></div>`;

    // CONNECTION. The pid is the live one, never the pid file's contents; the env row is the PATH and a boolean,
    // never a value from the file. "Last successful" reads the channel's own records, so a held or failed message
    // cannot be shown as a send.
    const connection = `<section class="as-bridge-sec" data-as-bridge-sec="connection" id="as-bridge-connection">
      <h5>Connection <span class="as-hint">the process, the room, and what last went each way</span></h5>
      <div class="as-bridge-rows">
        ${row("process", `${bridgeDot(health.kind)}<b>${esc(health.label)}</b>${b.running ? ` · pid ${esc(String(b.pid))}` : ""}`, health.kind === "ok" ? "ok" : health.kind, health.detail)}
        ${row("pid", b.running ? esc(String(b.pid)) : b.stalePid ? `stale ${esc(String(b.stalePid))} — that process is gone` : "none running", b.running ? "ok" : b.stalePid ? "warn" : "", b.running ? "the OS says this pid is alive; the pid file is not the answer" : "no live process is recorded")}
        ${row("bridge.env", `<code>${esc(b.envPath || "(no script configured — no path to show)")}</code> · ${b.credentialsPresent ? "present" : "MISSING"}`, b.credentialsPresent ? "" : "bad", "the PATH only. The panel never opens this file, so no password can reach this page, a route or a log line.")}
        ${row("room", b.roomId ? esc(b.roomId) : "NO ROOM SET — Start refuses until matrix.roomId names one", b.roomId ? "" : "bad", "MATRIX_ROOM_ID: the one room the bridge serves")}
        ${row("sender allow-list", esc(allowText), allowKind, allow.detail || "the bridge serves one room and obeys any member of it; there is no per-sender list")}
        ${row("last successful send", activity.lastSentAt ? `${bridgeWhen(activity.lastSentAt)}${activity.lastSentN ? ` · wait ${esc(String(activity.lastSentN))}` : ""}` : "none recorded since this panel started", "", "a message the bridge actually took, from the channel's own send record")}
        ${row("last successful receive", activity.lastReceivedAt ? bridgeWhen(activity.lastReceivedAt) : "none recorded since this panel started", "", "the last line the panel read from the bridge's own log")}
      </div>
    </section>`;

    // MESSAGES. Newest ten each way, clipped, and nothing more: the store caps both directions, so this pane is
    // structurally incapable of drawing a room transcript. A failed send is red and names the refusal.
    const inbound = (Array.isArray(el.inbound) ? el.inbound : []).slice(0, BRIDGE_MSG_N);
    const outbound = (Array.isArray(el.messages) ? el.messages : []).slice(0, BRIDGE_MSG_N);
    const messages = `<section class="as-bridge-sec" data-as-bridge-sec="messages" id="as-bridge-messages">
      <h5>Messages <span class="as-hint">the last ${BRIDGE_MSG_N} each way · failures highlighted · never the room's transcript</span></h5>
      <div class="as-bridge-grouphead">Inbound <span class="as-hint">${el.counts?.inbound ?? 0} read since this panel started</span></div>
      ${inbound.length ? inbound.map((m) => bridgeMessageHtml(m, "in")).join("") : `<div class="as-empty">nothing received since this panel started</div>`}
      <div class="as-bridge-grouphead">Outbound <span class="as-hint">${el.counts?.failed ?? 0} failure${(el.counts?.failed ?? 0) === 1 ? "" : "s"} on record</span></div>
      ${outbound.length ? outbound.map((m) => bridgeMessageHtml(m, "out")).join("") : `<div class="as-empty">nothing sent from this panel yet</div>`}
    </section>`;

    // POLICY. The whole textarea is the file; the path, the source and the size are the reader's evidence for what
    // a turn would carry. Panel text wins over the environment default — the precedence is the server's, and this
    // line says which side of it is in force.
    const boxText = bridgeBoxText();
    const cap = Number(policy.cap) || 0;
    const over = Boolean(cap && boxText.length > cap);
    const sourceLine = policy.saved && !policy.panelChars
      ? `a saved policy that is empty — ${policy.source === "env" ? `${esc(policy.envVar || "WTGUI_MATRIX_POLICY")} is in force` : "the template is in force"}`
      : policy.source === "panel"
        ? `your saved copy · ${esc(String(policy.panelChars || boxText.length))} chars on disk`
        : policy.source === "env"
          ? `${esc(policy.envVar || "WTGUI_MATRIX_POLICY")} is in force — no panel text has been saved`
          : "the panel's template — nothing saved yet";
    const policySec = `<section class="as-bridge-sec" data-as-bridge-sec="policy" id="as-bridge-policy">
      <h5>Policy <span class="as-hint">how you want to be spoken to · saved in the panel, injected into the bridge turn</span></h5>
      <div class="as-help">Tone, when it may ping your phone, quiet hours, and which assistant to route to. Your text
      here wins over <code>WTGUI_MATRIX_POLICY</code> (the environment default); a save replaces the whole file. The
      bridge's credentials do not belong anywhere on this page — the path above is all the panel knows about them.</div>
      <div class="as-charter-meta">
        <code class="as-charter-path" title="${esc(policy.path || "")}">${esc(policy.path || "…")}</code>
        <span class="as-hint">${esc(sourceLine)}</span>
        <span class="as-hint" data-as-bridge-size>${boxText.length}/${cap || "?"} chars</span>
        <span class="as-hint">${policy.mtimeIso ? `last written ${esc(relTime(policy.mtimeIso))} ago` : "not saved yet"}</span>
      </div>
      <textarea class="as-note-box as-charter-box as-bridge-policy-box" id="as-bridge-policy-text" rows="12" spellcheck="false" placeholder="how the bridge should speak to you…">${esc(boxText)}</textarea>
      ${over ? `<div class="as-ask is-bad" role="status"><b>${boxText.length.toLocaleString()} characters</b> — ${(boxText.length - cap).toLocaleString()} over the ${cap.toLocaleString()}-character cap. The panel refuses a save this size: shorten it first.</div>` : ""}
      <div class="as-actions">
        <button id="btn-as-bridge-policy-save" type="button" class="primary"${bridgeData && !over ? "" : " disabled"}>Save policy</button>
        <button id="btn-as-bridge-policy-reload" type="button" title="read the file again and drop anything typed in the box">Reload from disk</button>
        <span class="as-hint" data-as-bridge-note>${esc(bridgeSavedNote)}</span>
        <span class="as-err" id="as-bridge-policy-err"></span>
      </div>
      <div class="as-help">Stored in the panel's state folder, served at <code>GET /api/matrix/policy</code> for the
      bridge turn to carry. Nothing here is sent to the room by pressing Save.</div>
    </section>`;

    // REMINDERS. The bridge's OWN list — not an assistant's watches. The panel stores it (POST
    // /api/matrix/reminders), the bridge reads it on every turn, and completing one stamps the row rather than
    // moving a card between states. There is no queue section here by design: work the bridge files belongs to an
    // assistant's queue, and a second queue would be a place for a job to disappear into.
    const rem = bridgeData.reminders || {};
    const remList = Array.isArray(rem.reminders) ? rem.reminders : [];
    const openRem = remList.filter((r) => !r.doneAt);
    const doneRem = remList.filter((r) => r.doneAt);
    const reminderRow = (r) => `<div class="as-bridge-reminder${r.doneAt ? " is-done" : ""}">
      <button type="button" class="as-bridge-check" data-as-bridge-reminder="${esc(r.id)}" data-as-bridge-act="${r.doneAt ? "open" : "done"}" title="${r.doneAt ? "reopen this reminder" : "mark this reminder done"}">${r.doneAt ? "✓" : "○"}</button>
      <span class="as-bridge-reminder-text">${esc(r.text)}</span>
      ${r.due ? `<span class="as-hint">due ${esc(r.due)}</span>` : ""}
      <button type="button" class="as-bridge-remove" data-as-bridge-reminder="${esc(r.id)}" data-as-bridge-act="remove" title="delete this reminder">×</button>
    </div>`;
    const remindersSec = `<section class="as-bridge-sec" data-as-bridge-sec="reminders" id="as-bridge-reminders">
      <h5>Reminders <span class="as-hint">the bridge's own list · ${openRem.length} open · ${doneRem.length} done · never a queue</span></h5>
      <div class="as-help">Not an assistant's watch: a reminder has no thread and wakes nobody, and the bridge keeps
      <b>no task queue</b> of its own — work it files goes into an assistant's queue. The bridge reads this list on
      every turn at <code>GET /api/matrix/reminders</code>; the panel is the only writer.</div>
      <div class="as-bridge-reminders">${remList.length ? [...openRem, ...doneRem].map(reminderRow).join("") : `<div class="as-empty">nothing on the list</div>`}</div>
      <div class="as-actions">
        <input type="text" id="as-bridge-reminder-text" class="as-bridge-reminder-input" placeholder="remind me to…" maxlength="500" />
        <input type="text" id="as-bridge-reminder-due" class="as-bridge-reminder-due" placeholder="when (optional)" />
        <button type="button" id="btn-as-bridge-reminder-add">Add reminder</button>
        <span class="as-err" id="as-bridge-reminder-err"></span>
      </div>
    </section>`;

    // WATCHES. The assistants' list, projected by the panel and READ ONLY on this page: the bridge may mention one
    // on the phone, and neither the page nor the bridge may create, complete or delete one. There is no control in
    // this section on purpose — an edit belongs in the assistant's own Watches sub-tab, where the owner is known.
    const watchList = Array.isArray(rem.watches) ? rem.watches : [];
    const watchesSec = `<section class="as-bridge-sec" data-as-bridge-sec="watches" id="as-bridge-watches">
      <h5>Watches <span class="as-hint">the assistants' own · READ ONLY here · ${watchList.length} shown</span></h5>
      <div class="as-help">${esc(rem.watchesNote || "the assistants' watches are read-only here — the bridge may mention one, never write one")}.
      A watch names a thread and wakes the assistant that owns it; the bridge only gets to read the projection.</div>
      <div class="as-bridge-rows">${watchList.length
        ? watchList.map((w) => row(
          esc(w.assistantId || "assistant-1"),
          `${bridgeDot(w.state === "done" ? "ok" : "warn")}${esc(w.title || "(no title)")}${w.state ? ` · ${esc(w.state)}` : ""}${w.thread ? ` · <code>${esc(w.thread)}</code>` : ""}`,
          "",
          "read-only — the bridge cannot write this",
        )).join("")
        : `<div class="as-empty">no assistant is watching anything right now</div>`}</div>
    </section>`;

    // ALERTS. Three questions, in the order they block: is the bridge healthy, can the panel reach the gateway a
    // turn would run on, and has anything it sent failed? A quiet row says so rather than leaving a section blank.
    const gatewayKind = gw.reachable === true ? "ok" : gw.reachable === false ? "bad" : "warn";
    const gatewayDetail = gw.reachable === true
      ? `reachable at ${gw.url || "the gateway"}${gw.checkedAt ? ` · checked ${esc(relTime(new Date(gw.checkedAt).toISOString()))} ago` : ""}`
      : gw.reachable === false
        ? String(gw.error || "the gateway did not answer")
        : "not checked yet";
    const failures = Array.isArray(el.failures) ? el.failures : [];
    const failureRows = failures.length
      ? failures.map((f) => `<div class="as-bridge-alert is-bad">${bridgeDot("bad")}<b>${esc(String(f.kind || "send"))} failed</b><span>${esc(f.error || "no reason recorded")}${f.n ? ` · wait ${esc(String(f.n))}` : ""}</span><span class="as-ago">${bridgeWhen(f.at)}</span></div>`).join("")
      : `<div class="as-bridge-alert is-ok">${bridgeDot("ok")}<b>no send failures</b><span>nothing has failed to leave since this panel started</span></div>`;
    const alerts = `<section class="as-bridge-sec" data-as-bridge-sec="alerts" id="as-bridge-alerts">
      <h5>Alerts <span class="as-hint">bridge health · gateway reachability · send failures</span></h5>
      <div class="as-bridge-alert is-${esc(health.kind)}">${bridgeDot(health.kind)}<b>bridge ${esc(health.label)}</b><span>${esc(health.detail)}</span></div>
      <div class="as-bridge-alert is-${esc(gatewayKind)}">${bridgeDot(gatewayKind)}<b>gateway ${gatewayKind === "ok" ? "reachable" : gatewayKind === "bad" ? "unreachable" : "not checked"}</b><span>${esc(gatewayDetail)}</span></div>
      ${failureRows}
    </section>`;

    host.innerHTML = `
      <div class="as-bridge-head">
        <div>
          <h4>Bridge</h4>
          <div class="as-help">The Matrix/Element bridge is an agent with <b>no worktree and no queue</b>: it talks to
          you on your phone and files work into assistants' queues. Its sections are connection, messages, the
          policy you write for it, the reminders it keeps, the assistants' watches it may mention (read-only), and
          alerts — there is no queue section, because the queue belongs to the assistants it files into.</div>
        </div>
        <button type="button" id="btn-as-bridge-refresh" title="read the bridge, the room, the policy, the reminders and the gateway again">Refresh</button>
      </div>
      ${connection}${messages}${policySec}${remindersSec}${watchesSec}${alerts}`;
  }

  // ONE ASSISTANT'S OWN SETTINGS.
  //
  // Every control drawn here is read through `settingsFor(id)` in lib/assistant.js out of that assistant's own
  // file. Assistant #1's are the live settings object the panel booted with; a second assistant's come from the
  // server's per-assistant map, so a pane can never silently borrow #1's values — the bug this tab replaces.
  // What is deliberately NOT drawn: the pass clock, the command audit and the per-rule escalation table. The panel
  // runs ONE sentry, so those are the Watchdog tab's, and a second copy here would be two controls for one value.
  function renderAssistantSettings(id = activeSessionId(), force = false) {
    const host = hostFor(id, "settings");
    if (!host || !state.assistant) return;
    if (!force && typingInside(`#${paneIdFor(id, "settings")}`)) return;
    const a = state.assistant;
    const first = id === FIRST_ASSISTANT;
    const rec = sessionById(id);
    const s = first ? a.settings : (a.assistantSettings || {})[id] || {};
    // The frame this assistant's pane is drawn in, from the server's per-assistant map — not from `s`: it is one of
    // the file's non-knob fields, so it is never part of the settings object a turn reads.
    const dockMode = (a.dock || {})[id] === "floating" ? "floating" : "docked";
    const autonomy = a.autonomy || ["draft", "auto-safe", "auto"];
    const autonomyLabel = {
      draft: "draft only — nothing is sent without my click",
      "auto-safe": "auto-safe — send what the assistant writes",
      auto: "auto — send any draft it has text for",
    };
    const { agg, knobs } = heldSets(a);
    const dis = (key) => (knobs.has(key) ? ' disabled title="aggressive mode holds this setting — switch it off with the ⚡ Aggressive switch above to change it"' : "");
    const owned = new Set(Object.keys(a.settingScope || {}).filter((k) => !ownsWatchdog(k)));
    const n = String(id).replace(/^assistant-/, "");
    const nameOf = (x) => sessionById(x)?.name || String(x);
    // The escalation list, in the order the reader put it, minus this assistant itself (it can never hand a subject
    // to itself) and minus the assistants this one already names.
    const escList = ((a.escalateTo || {})[id] || []).filter((x) => x !== id);
    const escOthers = assistantIds().filter((x) => x !== id && !escList.includes(x));
    const rules = Array.isArray(rec?.rules) ? rec.rules : [];
    host.innerHTML = `
      ${heldBanner(agg, owned)}
      <div class="as-group">
        <h4>${first ? "How it behaves" : `${esc(rec?.name || "Assistant")}'s settings — its own, not Assistant #1's`}</h4>
        ${first
          ? `<div class="as-help">What THIS assistant's own turns do: what it may send without a click, whether it may
        start a worker, the model it runs on and the directory it runs in. Nothing here changes another assistant.</div>`
          : `<div class="as-help">Every knob here is read by THIS assistant's own turns, from its own file
        <code>${esc(String(rec?.profile?.path || `assistants/${id}/settings.json`))}</code>. Changing one never
        changes Assistant #1's settings, and changing #1's never changes these.</div>`}
        <div class="as-line">
          <label${knobs.has("autonomy") ? ' class="as-held-label"' : ""}>autonomy <select data-as-set="autonomy"${first ? "" : ` data-as-for="${esc(id)}"`}${dis("autonomy")}>${autonomy.map((v) => `<option value="${v}"${s.autonomy === v ? " selected" : ""}>${esc(autonomyLabel[v] || v)}</option>`).join("")}</select></label>
        </div>
        <div class="as-line"><label${knobs.has("spawn") ? ' class="as-held-label"' : ""}>create worktrees <select data-as-set="spawn"${first ? "" : ` data-as-for="${esc(id)}"`}${dis("spawn")} title="whether THIS assistant may cut a worktree and start a worker — ask keeps a one-click card between it and git">${(a.spawnModes || ["off", "ask", "auto"]).map((v) => `<option value="${v}"${s.spawn === v ? " selected" : ""}>${v === "off" ? "off — it may not start workers" : v === "ask" ? "ask me first" : "start immediately"}</option>`).join("")}</select></label></div>
        <div class="as-line"><label${knobs.has("model") ? ' class="as-held-label"' : ""}>model <select data-as-set="model"${first ? "" : ` data-as-for="${esc(id)}"`}${dis("model")} title="the model THIS assistant's turns run on — pick something small and fast; the board digest is the whole input">${modelOptionsHtml(s.model || "")}</select></label></div>
        <div class="as-line"><label${knobs.has("cwd") ? ' class="as-held-label"' : ""} title="the assistant does no work here — the gateway just refuses a run without an existing cwd. It is created if missing; leave empty for a folder beside the job store.">working dir <input type="text" spellcheck="false" data-as-set="cwd"${first ? "" : ` data-as-for="${esc(id)}"`} value="${esc(s.cwd || "")}" placeholder="default: beside the job store"${dis("cwd")}></label></div>
        <div class="as-help">Draft-only is the default: a reply reaches a worker only when you press Send on it. Auto-safe
        sends a reply the assistant itself wrote with a TO line; auto also sends anything a standing rule drafted.
        Creating a worktree has its own switch — nothing runs until the card is clicked. An approval is never answered
        from here at any setting.</div>
      </div>
      <div class="as-group">
        <h4>How this assistant's pane is drawn</h4>
        <div class="as-help">This is THIS assistant's frame, not the panel's: another assistant can float while this
        one stays docked, and the panel re-frames when you switch tabs. <b>docked</b> is the rail beside the board;
        <b>floating</b> is a window over it, at the size and place you last left it. The switch takes effect at once —
        nothing reloads — and it is saved in this assistant's own settings file with the rest of its fields.</div>
        <div class="as-line">
          <label title="which frame THIS assistant's pane is drawn in — saved in this assistant's own settings file, and never applied to another assistant">pane <select data-as-dock="${esc(id)}" title="docked: the rail beside the board · floating: a window over the board, which you can move by its title row and size from its corner">${(a.dockModes || ["docked", "floating"])
            .map((v) => `<option value="${esc(v)}"${dockMode === v ? " selected" : ""}>${v === "docked" ? "docked — a rail beside the board" : "floating — a window over the board"}</option>`)
            .join("")}</select></label>
          <span class="as-hint">switches as soon as you pick it</span>
          <span class="as-err" id="as-dock-err-${esc(n)}"></span>
        </div>
      </div>
      <div class="as-group">
        <h4>Its wake budget and quiet windows</h4>
        <div class="as-line">
          <label${knobs.has("maxWakesPerHour") ? ' class="as-held-label"' : ""} title="the ceiling on sweep wakes an hour — the conditions the sentry polls for (quiet, loop, leftover, child…). An event (a settle, an exit, a question, an approval, a finished watch) is never refused">sweep wakes / hour <input type="number" min="0" max="60" data-as-set="maxWakesPerHour"${first ? "" : ` data-as-for="${esc(id)}"`} value="${s.maxWakesPerHour}"${dis("maxWakesPerHour")}></label>
          <label${knobs.has("quietSeconds") ? ' class="as-held-label"' : ""} title="a running turn that has produced nothing for this long is quiet — the bar the no-new-output rule fires on">quiet after <input type="number" min="30" max="3600" data-as-set="quietSeconds"${first ? "" : ` data-as-for="${esc(id)}"`} value="${s.quietSeconds}"${dis("quietSeconds")}> s</label>
          <label${knobs.has("childQuietSeconds") ? ' class="as-held-label"' : ""} title="a delegated subagent that writes nothing for this long is worth flagging">child silent <input type="number" min="60" max="3600" data-as-set="childQuietSeconds"${first ? "" : ` data-as-for="${esc(id)}"`} value="${s.childQuietSeconds}"${dis("childQuietSeconds")}> s</label>
        </div>
        <div class="as-help">The budget and the two windows are this assistant's own numbers, saved in the same file as
        its model. The panel runs ONE sentry today and it is Assistant #1's, so it is #1's copies that are read every
        pass; a second assistant's are stored here and become live when a sentry of its own exists.</div>
        <div class="as-help">A long build is silent too, which is why “no new output” only journals by default.</div>
      </div>
      <div class="as-group">
        <h4>Escalate to — the assistants this one would hand a subject to</h4>
        <div class="as-help">An ordered list of this panel's assistants, saved in this assistant's own settings file
        beside its charter. <b>Nothing acts on it yet</b>: a list here changes no wake and hands nothing over — it is
        the place a later branch will read the order from, and this pane says so rather than implying a hand-over that
        never happens.</div>
        <div class="as-line">
          <label>add <select id="as-esc-pick-${esc(n)}" data-as-escpick="${esc(id)}"${escOthers.length ? "" : " disabled"}>${escOthers.length ? escOthers.map((x) => `<option value="${esc(x)}">${esc(nameOf(x))}</option>`).join("") : `<option value="">(no other assistant yet)</option>`}</select></label>
          <button type="button" data-as-escadd="${esc(id)}"${escOthers.length ? "" : " disabled"}>Add</button>
          <span class="as-hint">first on the list is the one it would try first</span>
        </div>
        ${escList.length
          ? escList
              .map(
                (x, i) => `<div class="as-rule-row"><span class="as-rule-name">${i + 1}. ${esc(nameOf(x))} <i>${esc(x)}</i></span>
                <button type="button" data-as-escmove="up" data-as-escid="${esc(x)}" data-as-escown="${esc(id)}"${i === 0 ? " disabled" : ""} title="move earlier">↑</button>
                <button type="button" data-as-escmove="down" data-as-escid="${esc(x)}" data-as-escown="${esc(id)}"${i === escList.length - 1 ? " disabled" : ""} title="move later">↓</button>
                <button type="button" data-as-escdel="${esc(x)}" data-as-escown="${esc(id)}" title="remove from the list">✕</button></div>`,
              )
              .join("")
          : `<div class="as-help">(empty — this assistant hands nothing to another one)</div>`}
        <div class="as-err" id="as-set-err"></div>
      </div>
      ${first
        ? ""
        : `<div class="as-group">
        <h4>${esc(rec?.name || "Assistant")}'s rules — its own, not Assistant #1's</h4>
        <div class="as-help">These ride in THIS assistant's preamble, clipped the way every rule is. Adding or
        removing one here never changes Assistant #1's standing rules.</div>
        <div class="as-actions">
          <input type="text" id="as-rules-text-${esc(n)}" class="as-grow" spellcheck="false" maxlength="400" placeholder="e.g. Ask before writing to a tree another agent owns">
          <button type="button" class="primary" data-as-addrule="${esc(id)}">Add rule</button>
          <span class="as-err" id="as-rules-err-${esc(n)}"></span>
        </div>
        ${rules.length
          ? rules
              .map(
                (r) =>
                  `<div class="as-rule-row"><span class="as-rule-name">${esc(r.text)}</span><button type="button" data-as-unrule="${esc(r.id)}" data-as-rulefor="${esc(id)}" title="remove this rule">✕</button></div>`,
              )
              .join("")
          : `<div class="as-help">(none written down yet)</div>`}
      </div>`}
      <div class="as-help">The pass clock, the command audit and the per-rule escalation table belong to the panel's
      one watchdog — they are in the <b>Watchdog</b> tab. This assistant's default role prompt is in the <b>Role</b> tab
      and the worktrees it owns are in its <b>Worktrees</b> tab. Its thread is
      <code>${esc(rec?.threadId || "")}</code>.</div>`;
    // The aggressive switch is one control for one mode, and its place is the top of whichever assistant's
    // Settings sub-pane is on screen. Inserted after the pane's markup so a repaint cannot leave a stale copy
    // behind, and painted from the server's state here (a hidden pane's copy is never what the reader sees).
    host.insertBefore(aggressiveBlock(), host.firstElementChild || null);
    paintAggressive();
    // The model field is the shared picker (core/model-menu.js), not a native select: a select can only print
    // text, so it can never show a row's price, coding rating or context window — and a popup opened inside this
    // float would be clipped by its overflow instead of painting over it. The select stays in the DOM as the
    // control whose `change` the delegated [data-as-set] handler below answers.
    if (first) {
      ModelMenu.attach(host.querySelector('select[data-as-set="model"]'), {
        models: () => (typeof modelsState === "undefined" ? null : modelsState),
        extra: assistantModelExtra,
      });
    }
  }

  // ---- the queue sub-tab ------------------------------------------------------------------------
  //
  // One assistant's task queue. It is the one session pane that is a LIST and lives on the session's own row, because
  // the work is that assistant's: what it is carrying, what it has parked and what it has finished. The pane is
  // fetched when the tab opens and after every change — the polled board state carries each assistant's settings but
  // not its queue, and pushing up to 200 tasks × N assistants through the board poll would be a payload nobody reads.
  //
  // The cache is keyed by assistant id so stepping between tabs is instant, and a failed fetch leaves the last good
  // list on screen with the error above it rather than a pane that went blank because one request timed out.
  const queueCache = new Map(); // assistantId -> { view, error, loading, at }
  // One read in flight per assistant, and one counter per assistant. The counter used to be one `let` for the whole
  // page, so two panes' answers judged each other stale; per id, an answer about assistant-2 says nothing about
  // assistant-1. A write bumps its own id's counter too, so a read that was already in flight when the write landed
  // cannot repaint the list the write replaced.
  const queueSeq = new Map(); // assistantId -> number
  const queueInflight = new Map(); // assistantId -> the promise of the read in flight
  // Which row's ➡️ picker is open, keyed `<assistant>:<task>`. One record for the whole float rather than a DOM flag,
  // so the pane can be repainted (the board polls it) without shutting a picker the reader is looking at, and two
  // assistants' task #3 cannot toggle each other's list.
  const qmoveOpen = new Set();
  // The agents' own statuses, from GET /api/jobs, newest turn per thread. It is deliberately NOT the page's own job
  // map: the brief asks the queue to read the run store, so a sub-row cannot inherit a stale status from a card that
  // has not been repainted yet. `at` is the read's clock — a paint re-asks only when the answer is older than a few
  // seconds, which is what keeps the pane's own repaint from becoming a request loop.
  const queueJobs = { at: 0, byThread: new Map(), inflight: null };
  // The card being dragged (null when no gesture is live), the moment the last drag ENDED, and the one line a refused
  // drop says. The ended-at stamp is what tells the click the browser fires at the end of a drag from the reader's own
  // press: a drag must never open a card, and a click must still open its console.
  let queueDrag = null;
  let queueDragEnded = 0;
  const queueDropNotes = new Map(); // assistantId -> the sentence a blocked drop left on the pane

  const queueMark = (state) => (state === "done" ? "✓" : state === "parked" ? "⏸" : state === "running" ? "●" : "○");
  const queueStateName = (state) => (state === "running" ? "running" : state === "parked" ? "parked" : state === "done" ? "done" : "queued");
  // The word in the head is a STATUS, and hover is where it explains itself: a reader who does not know what "parked"
  // means here gets the rule without a paragraph under every row.
  const queueStateTitle = (t) =>
    t.stale
      ? `stale — the file still says running, but ${String(t.staleWhy || "its thread has no live run").replace(/^that thread/, "its thread")}`
      : t.state === "running"
        ? "running — a run is carrying it; its agent's own status is on the facts line"
        : t.state === "parked"
          ? "parked — stopped until the condition in the note is released; nothing starts it by itself"
          : t.state === "done"
            ? "done — the record of finished work; it stays in place, dimmed, and can be re-queued"
            : "queued — not started; drag the card to change its place, and a card held by another row cannot go above it";
  // What a row is waiting on, in the row's head: the lane head that goes first. `waitingOn` and `lane` are DERIVED
  // by the store (lib/assistant/queue.js's laneInfo) — this draws the fact the digest already carries, in three
  // words, with the file it shares in title= so the row stays one line.
  function queueLaneChip(t) {
    const w = t?.waitingOn;
    const at = Number(w?.id);
    if (!Number.isFinite(at) || at <= 0) return "";
    const lane = String(w?.lane || "").trim();
    const title = `waiting on #${at}${lane ? ` — #${at} heads this lane (${lane})` : ""}: both rows touch the same file, and it goes first`;
    return `<span class="as-task-wait" data-as-qwait="${esc(String(at))}" title="${esc(title)}">waiting on #${esc(String(at))}</span>`;
  }

  // ---- the reader's order, and the hold that can block it ---------------------------------------------------------
  //
  // The pane groups by STATE first — running, queued, parked, done — and that grouping is not the drag's to change:
  // a running row is being worked on, a parked one is waiting for somebody, and a done one is the record. Inside a
  // group the rows are sorted by `order` (the place a card was dragged to, written by the reorder action) and then by
  // id, which is the order every queue file written before the drag already drew.
  const QUEUE_BUCKET = { running: 0, queued: 1, parked: 2, done: 3 };
  const queueOrderOf = (t) => {
    const n = Number(t?.order);
    return Number.isFinite(n) && n > 0 ? n : Number(t?.id) || 0;
  };
  const queueSorted = (rows) =>
    (Array.isArray(rows) ? rows : [])
      .slice()
      .sort(
        (a, b) =>
          (QUEUE_BUCKET[a.state] ?? 9) - (QUEUE_BUCKET[b.state] ?? 9) ||
          queueOrderOf(a) - queueOrderOf(b) ||
          Number(a.id) - Number(b.id),
      );
  // The row a `task` hold names. Only that kind orders anything on this list: a thread, job, path or manual hold is a
  // park's release condition and names nothing here.
  function queueHoldTarget(t) {
    const hold = t?.hold;
    if (!hold || hold.kind !== "task") return null;
    const m = /^\s*#?\s*(\d+)\s*$/.exec(String(hold.value ?? ""));
    if (!m) return null;
    const ms = Date.parse(String(hold.since || ""));
    return { id: Number(m[1]), since: Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : null };
  }
  // The badge a card carries when its hold actually blocks a drop. Only those cards wear one: greying out everything
  // above the row a card holds for would also grey the running and done rows the drag is not competing with.
  function queueHoldBadge(t, byId) {
    const target = queueHoldTarget(t);
    if (!target) return "";
    const held = byId && typeof byId.get === "function" ? byId.get(target.id) : null;
    // A hold whose row is gone from this queue, or reads done, has ended — there is nothing left to hold for.
    if (byId && typeof byId.get === "function" && (!held || held.state === "done")) return "";
    const title = `held by #${target.id}${target.since ? ` since ${target.since}` : ""} — this card cannot be dragged above it`;
    return `<span class="as-task-hold" data-as-qhold="${target.id}" title="${esc(title)}">held by #${target.id}</span>`;
  }

  // ---- a row whose agent has stopped to ask something ----------------------------------------------
  //
  // A queue row says what the reader has queued, and a row is a lane only while it is waiting on the QUEUE. A row whose
  // agent is parked on a `clarify` question is waiting on a PERSON instead, and until now it read exactly like a lane:
  // "parked" plus a reason, which is what a board full of held work looks like when it is actually stopped. So the row
  // wears one more word and one press, `question`, over the panel's own alert for that question.
  //
  // The alert is the store's, not a second copy: the assistant's state publishes its OPEN alerts (`rule`, `parked`,
  // `requestId`, `thread`, `title`, `detail`, `choices`) and this only joins one to a row — by THREAD, because a task's
  // agent IS its thread and `threads[]` is the whole history a re-attempt leaves behind. That title is clipped to 70
  // characters server-side, so the chip is a SIGN, never the question: the full text, every choice and the answer are
  // drawn in the agent's own card by the turn renderer (`questionPrompt`/`questionAnswered` in public/app.js), and the
  // press lands there.
  function queueQuestionAlert(t, alerts) {
    const list = Array.isArray(alerts) ? alerts : [];
    if (!list.length) return null;
    const threads = new Set([...(Array.isArray(t?.threads) ? t.threads : []), t?.thread].map((v) => String(v || "")).filter(Boolean));
    if (!threads.size) return null;
    // The panel writes this alert as rule `question` with `parked` and a request id (`lib/assistant.js`'s clarify
    // branch); `clarify` is accepted by name for a record written against the other spelling of the same fact. An
    // APPROVAL is not a question — its box lives on the card too, but it is a different prompt with a different answer
    // route — so it is excluded by rule rather than by whatever shape it happens to carry.
    const isQuestion = (a) =>
      Boolean(a) && a.status === "open" && (a.rule === "question" || a.rule === "clarify") && (a.parked === true || Boolean(a.requestId));
    // The NEWEST when a thread somehow holds two: a re-ask is the question holding the run now.
    return (
      list
        .filter((a) => isQuestion(a) && threads.has(String(a.thread || "")))
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0] || null
    );
  }
  // The chip reuses the hold badge's class on purpose: it is the same kind of thing — a pill-sized condition on a row —
  // and a question is made readable with NO new stylesheet rule. A <button> so Enter and Space are the browser's own,
  // and `data-as-qopen` so it opens its agent through the handler that already opens an agent row (the console turn,
  // not just the card header): one opener, not a second path.
  function queueQuestionChip(t, alerts) {
    const alert = queueQuestionAlert(t, alerts);
    if (!alert) return "";
    const thread = String(alert.thread || "");
    const label = String(assistantThreadName(thread) || "").trim();
    const title = `${label && label !== thread ? `“${label}” ` : ""}(${thread}) has stopped to ask you something — click to open its card; the question, every choice and the answer are in its chat`;
    return `<button type="button" class="as-task-hold as-task-question" data-as-qopen="${esc(thread)}" data-as-qid="${esc(String(t.id))}" data-as-qquestion="${esc(alert.id || "")}" title="${esc(title)}" aria-label="${esc(title)}">question</button>`;
  }
  /**
   * The drop the model refuses, found before the request is sent: a queued row may not sit above a row it holds for
   * while that row is still open. `ids` is the whole visible list as the drop leaves it, so this is the same rule
   * `reorderTasks` applies on the server — the pane just answers without a round trip (and the server still refuses a
   * list that got past a stale pane).
   */
  function queueDropBlocked(tasks, ids) {
    const list = Array.isArray(tasks) ? tasks : [];
    const order = (Array.isArray(ids) ? ids : []).map((v) => Number(v));
    const byId = new Map(list.map((t) => [Number(t.id), t]));
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const id of order) {
      const t = byId.get(id);
      if (!t || t.state !== "queued") continue;
      const target = queueHoldTarget(t);
      if (!target || !pos.has(target.id)) continue;
      const held = byId.get(target.id);
      if (!held || held.state === "done") continue;
      if (pos.get(id) < pos.get(target.id)) {
        return {
          id,
          target: target.id,
          since: target.since,
          line: `#${id} is held by #${target.id}${target.since ? ` since ${target.since}` : ""} — it cannot move above it`,
        };
      }
    }
    return null;
  }
  const queueCardsIn = (el) => {
    const pane = el?.closest?.('[data-subpane="queue"]');
    return pane ? [...pane.querySelectorAll(".as-task")] : [];
  };
  // The ids in the order the pane currently draws them — what a drop sends, and what a drag records before it moves.
  const queueIdsIn = (el) => queueCardsIn(el).map((c) => Number(c.dataset.asQrow)).filter((n) => Number.isFinite(n) && n > 0);

  // ---- one agent per task: the threads that carried it, and the status of the RUN each one is on ------------------
  //
  // The status of an agent is read from GET /api/jobs, by thread — never from the task record. The task's `state` is
  // what the READER decided about the work (queued, running, parked, done); an agent's line is what its RUN is doing,
  // and the two disagree on purpose: a task still marked running whose run went away must read EXITED, and a task the
  // reader parked while its agent keeps working must still read RUNNING. Two sources, two questions, one row.
  //
  // The classes and the words are the card's own (public/app.js's job head, `:4260-4300`), so a queue row and a card
  // cannot describe one run two ways: `.pill.pill-running`, `.pill.pill-notrunning` (+ `.is-failed`), `button.pill-complete`,
  // and the words running / complete / exited / not-running — which `.pill`'s own text-transform paints uppercase.
  const QUEUE_LIVE = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);
  function queueAgentChip(job) {
    const status = String(job?.status || "").toLowerCase();
    if (QUEUE_LIVE.has(status)) {
      // ⏸ is the one live state that is not progress: the run is waiting on the reader (an approval, or an answer).
      const waiting = status === "waiting" || status === "waiting_for_approval";
      return { mark: waiting ? "⏸" : "●", markState: waiting ? "parked" : "running", word: "running", cls: "pill pill-running" };
    }
    if (status === "done") return { mark: "✓", markState: "done", word: "complete", cls: "pill pill-complete", button: true };
    if (status === "failed") return { mark: "○", markState: "queued", word: "exited", cls: "pill pill-notrunning is-failed" };
    // A cancelled/interrupted/stopped run, and a thread the job store has never heard of, say the same thing to a
    // reader — nothing is running it now — and the card says the same word for both of them.
    return { mark: "○", markState: "queued", word: "not-running", cls: "pill pill-notrunning" };
  }

  // One sub-row per agent. The whole line is the opener — it carries the mark this RUN owns (not the task's) and the
  // card's own chip — and pressing it opens that agent's card AND the console of the turn it is on (openAgentTurn),
  // not just the card header.
  function queueAgentHtml(id, t, thread, jobs) {
    const job = jobs && typeof jobs.get === "function" ? jobs.get(thread) : null;
    const chip = queueAgentChip(job);
    const label = String(assistantThreadName(thread) || "").trim();
    const named = label && label !== thread;
    const open = `data-as-qopen="${esc(thread)}" data-as-qid="${esc(String(t.id))}"`;
    const title = `open ${named ? `“${label}” ` : ""}(${thread})'s card and its current console turn — this agent's run is ${chip.word}, read from /api/jobs`;
    const pill = chip.button
      ? `<button type="button" class="pill pill-complete" ${open} title="${esc(`${title} — the run finished, so nothing here is being resumed`)}" aria-label="${esc(`${chip.word} — ${title}`)}">${chip.word}</button>`
      : `<span class="${chip.cls}" title="${esc(`this agent's run is ${chip.word} — read from /api/jobs, not from the task record`)}">${chip.word}</span>`;
    return `<div class="as-task-agent" role="button" tabindex="0" ${open} title="${esc(title)}" aria-label="${esc(title)}">
            <span class="as-agent-mark is-${esc(chip.markState)}" aria-hidden="true">${chip.mark}</span>
            <code class="as-task-agent-thread">${esc(thread)}</code>
            ${named ? `<span class="as-task-agent-label">${esc(label)}</span>` : ""}
            ${pill}
          </div>`;
  }

  // The row's pipeline press. It draws what the RECORD says — the contract's `pipelineRun` (lib/task-pipeline.js), as it
  // is stored — because the row has no bundle: resolving it is the window's read, one press away. Every task gets one.
  // A task with no assignment is on the DEFAULT path, and the window is where that path is explained; a row with no
  // press would make the explanation unreachable.
  function queuePipelineChip(t, id) {
    const run = t?.pipelineRun;
    const object = run && typeof run === "object" && !Array.isArray(run) ? run : null;
    const pipeline = object && typeof object.pipeline === "string" ? object.pipeline.trim() : "";
    const stage = object && typeof object.stage === "string" ? object.stage.trim() : "";
    const words = pipeline
      ? `pipeline ${pipeline}${stage ? ` · ${stage}` : ""}`
      : run == null
        ? "assistant decides"
        : object
          ? "pipeline: unresolved — no pipeline named"
          : "pipeline: unresolved — unreadable record";
    const title = pipeline
      ? `pipeline ${pipeline}${stage ? `, stage ${stage}` : ""} — open the pipeline window: every stage in order, where this task is, the gate that ended the stage before it, and the control that moves it`
      : run == null
        ? "no pipeline is assigned — the assistant decides; open the pipeline window to put this task on a pipeline or read what the default path means"
        : `the pipeline record is ${JSON.stringify(run)} — open the pipeline window to see why it cannot be read (it is NOT treated as the default path)`;
    return `<button type="button" class="as-task-pipe" data-as-qpipe="${esc(String(t.id))}" data-as-qown="${esc(id)}" title="${esc(title)}" aria-label="${esc(title)}">${esc(words)}</button>`;
  }

  // The row's FLOW press, beside the pipeline chip. The chip opens the pipeline WINDOW (where the task is assigned and
  // where every stage's artifact and gate is spelled out); this opens the flow the window cannot draw at row width:
  // the whole sequence left to right, the gates as notches, a capped loop as an arc, and where this task is. Both
  // read the same answer; neither writes anything, and the press is a glyph so the row stays narrow.
  function queueFlowButton(t, id) {
    return `<button type="button" class="as-qflow" data-as-qflow="${esc(String(t.id))}" data-as-qown="${esc(id)}" title="the pipeline flow — every stage left to right, gates as notches, a capped loop as an arc, and where this task is. It reads only: the chip beside it is where the task is assigned." aria-label="open the pipeline flow">⇢</button>`;
  }

  // The PROJECT a card is about, in one word — the field the panel wrote when it cut the task, else the project the
  // tree path names (everything before `/.worktrees/`, reduced to its directory name), else the board row's own
  // project. Nothing at all when none of the three says anything: a guessed project reads exactly like a fact, and a
  // wrong one sends the reader to the wrong repository. Always the NAME, never the path — the meta line has room for
  // one short word beside the files, and a path there is what would push them off it.
  function queueProjectName(t) {
    const leaf = (v) =>
      String(v ?? "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean)
        .pop() || "";
    const own = leaf(t?.project);
    if (own) return own;
    const tree = String(t?.worktree || "").replace(/\\/g, "/");
    const at = tree.toLowerCase().indexOf("/.worktrees/");
    if (at > 0) {
      const before = leaf(tree.slice(0, at));
      if (before) return before;
    }
    return leaf(t?.row?.project);
  }

  // One row, read in this order: WHAT the row is (its title), its STATE in a word, and WHAT IT IS WAITING ON — a
  // lane head, a hold, a question, a skipped file, a stopped run. Those are the head, on one line, at full contrast;
  // the marker is the accent beside them, never the only word for the state. The agents, project and PR follow on
  // one facts line, and everything a reader needs only after that question — the tree, the files, the attempts and
  // the task's own detail — sits behind the row's own closed disclosure. Printing all of it is what made one row
  // 166 px tall and put its reason under a paragraph of rationale.
  function queueTaskHtml(id, t, jobs, byId, alerts) {
    const mark = queueMark(t.state);
    const state = queueStateName(t.state);
    // A stale row IS a running row nothing is running any more: the WORD says so where the state is read, instead
    // of a blue marker contradicting the amber sentence underneath it.
    const stateWord = t.stale ? "stale" : state;
    // `threads` is the record's whole history and `thread` its legacy first entry, so a queue file written before the
    // list existed still draws one agent row. The CURRENT run is the last one, and that is what a click on the body
    // (rather than on a sub-row) opens.
    const list = Array.isArray(t.threads) && t.threads.length ? t.threads.filter(Boolean) : t.thread ? [t.thread] : [];
    const current = list.length ? list[list.length - 1] : "";
    // The one line that answers WHERE: the project and the PR. FIRST, because the one word that says where the work
    // is must never wrap off the bottom of a card.
    const meta = [];
    const project = queueProjectName(t);
    if (project) meta.push(`project ${esc(project)}`);
    if (t.row?.pr?.number) meta.push(`PR #${esc(String(t.row.pr.number))} ${esc(t.row.pr.state || "")}`.trim());
    else if (t.row?.verdict) meta.push(`PR ${esc(t.row.verdict)}`);
    // The second read, folded: the tree (usually a long path), the files, the attempts and the task's own detail.
    const fold = [];
    if (t.worktree) fold.push(`<span title="the worktree this task works in">tree ${esc(t.worktree)}</span>`);
    if (Array.isArray(t.files) && t.files.length)
      fold.push(
        `<span title="the files this task claims — a queued task that touches a running task's files is skipped">files ${esc(t.files.slice(0, 4).join(", "))}${t.files.length > 4 ? "…" : ""}</span>`,
      );
    if (Number(t.attempts) > 0) fold.push(`<span title="how many times this task has been started">${Number(t.attempts)} attempt${Number(t.attempts) === 1 ? "" : "s"}</span>`);
    if (t.detail) fold.push(`<span class="as-task-detail" title="the detail written when the task was filed">${esc(t.detail)}</span>`);
    // The waiting-on sentence, on its own line, in the row's voice: amber for a stop, red for a refusal. It is a
    // fact, not a description, so it stays printed — with the whole sentence in title= because the line is one line.
    const note = t.stale
      ? `<div class="as-task-note" title="${esc(`STALE — ${t.staleWhy || "its thread has no live run"}`)}">STALE — ${esc(t.staleWhy || "its thread has no live run")}</div>`
      : t.conflict
        ? `<div class="as-task-note is-bad" title="${esc(`SKIPPED — ${t.skipped || "files in use by a running task"}`)}">SKIPPED — ${esc(t.skipped || "files in use by a running task")}</div>`
        : t.state === "parked" && t.reason
          ? `<div class="as-task-note" title="${esc(`parked — ${t.reason}`)}">parked — ${esc(t.reason)}</div>`
          : t.state === "queued" && t.reason
            ? `<div class="as-task-note" title="${esc(t.reason)}">${esc(t.reason)}</div>`
            : "";
    const agents = list.length
      ? list.map((th) => queueAgentHtml(id, t, th, jobs)).join("")
      : `<div class="as-task-agent is-none" title="nothing has run this task yet — Start marks it running, and the thread it is handed becomes its first agent row">
            <span class="as-agent-mark is-queued" aria-hidden="true">○</span>
            <span class="as-task-agent-label">no agent yet</span>
          </div>`;
    // What can be pressed depends on where the task is. A transition to the state it is already in is not offered:
    // a button that reports "already queued" is a button that wasted a click. Each press is a GLYPH on the row and the
    // real word lives in title= and aria-label=, so the row stays narrow without becoming a row of unlabelled squares.
    const btn = (act, glyph, word, why) =>
      `<button type="button" class="as-qglyph" data-as-qact="${act}" data-as-qid="${esc(String(t.id))}" data-as-qown="${esc(id)}" title="${esc(`${word} — ${why}`)}" aria-label="${esc(word)}">${glyph}</button>`;
    const acts = [];
    if (t.state !== "running") acts.push(btn("running", "▸", "Start", "mark this task running — the thread it names is what carries it"));
    if (t.state !== "queued") acts.push(btn("queued", t.state === "done" ? "↺" : "⇣", t.state === "done" ? "Requeue" : "Queue", t.state === "done" ? "put it back in the queue — a finished task can be re-queued" : "put it back in the queue"));
    if (t.state !== "parked") acts.push(btn("parked", "‖", "Park", "park it — blocked, waiting on something outside this assistant"));
    if (t.state !== "done") acts.push(btn("done", "✓", "Done", "mark it finished — this is the reader's judgement, not the panel's"));
    // Move is a POPOVER, not a select that is always on the row: the picker is as wide as the assistant names, and it
    // was the one control on the row that could not be a glyph. ➡️ opens the list; a name in it IS the choice (the
    // press carries data-as-qmove-to), Esc or a press outside closes it, and the one open picker is remembered by key
    // so a repaint of the pane does not shut a picker the reader is looking at.
    const others = assistantIds().filter((x) => x !== id);
    const mkey = `${id}:${t.id}`;
    const open = qmoveOpen.has(mkey);
    const move = others.length
      ? `<span class="as-qmove-wrap">
          <button type="button" class="as-qglyph" data-as-qmove-open="${esc(mkey)}" data-as-qown="${esc(id)}" data-as-qid="${esc(String(t.id))}" title="Move — hand this task to another assistant; it leaves this queue, arrives in that one's with an id of its own, and the move is recorded on the task (movedFrom)" aria-label="Move" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}">→</button>
          <span class="as-qmove-pop" data-as-qmove-pop="${esc(mkey)}" role="menu" aria-label="Move #${esc(String(t.id))} to another assistant"${open ? "" : " hidden"}>${others
            .map((x) =>
              `<button type="button" role="menuitem" class="as-qmove-pick" data-as-qact="reassign" data-as-qid="${esc(String(t.id))}" data-as-qown="${esc(id)}" data-as-qmove-to="${esc(x)}" title="${esc(`Move to ${sessionById(x)?.name || x} — it leaves this queue, arrives in that one's with an id of its own, and the move is recorded on the task (movedFrom)`)}" aria-label="${esc(`Move to ${sessionById(x)?.name || x}`)}">↳ ${esc(sessionById(x)?.name || x)}</button>`,
            )
            .join("")}</span>
        </span>`
      : "";
    // The disclosure is OUTSIDE the body on purpose: the body is the console opener, and a summary inside it would
    // be swallowed by that press. Closed it is one 9.5 px word; opened it is the tree, the files, the attempts and
    // the task's own detail.
    const more = fold.length
      ? `<details class="as-task-more"><summary title="the tree, the files, the attempts and the detail — folded so the row reads as one line">${t.worktree || (Array.isArray(t.files) && t.files.length) ? "tree · files" : "more"}${Number(t.attempts) > 0 ? " · attempts" : ""}${t.detail ? " · detail" : ""}</summary><div class="as-task-more-body">${fold.join(`<span class="as-task-sep">·</span>`)}</div></details>`
      : "";
    return `<div class="as-task${t.state === "done" ? " is-done" : ""}${t.state === "queued" ? " is-draggable" : ""}" data-as-qrow="${esc(String(t.id))}" data-as-qstate="${esc(state)}" data-as-qown="${esc(id)}" data-as-qthread="${esc(current)}">
        <div class="as-task-main">
          <div class="as-task-body"${current ? ` data-as-qopen="${esc(current)}"` : ""}>
            <div class="as-task-head">
              <span class="as-task-mark is-${esc(state)}" aria-hidden="true">${mark}</span>
              <b class="mono">#${esc(String(t.id))}</b>
              <span class="as-task-state is-${esc(stateWord)}" title="${esc(queueStateTitle(t))}">${esc(stateWord)}</span>
              <span class="as-task-title" title="${esc(t.title)}">${esc(t.title)}</span>
              ${queueLaneChip(t)}
              ${queueHoldBadge(t, byId)}
              ${queueQuestionChip(t, alerts)}
            </div>
            <div class="as-task-facts">${agents}${meta.length ? `<span class="as-task-meta">${meta.join(" · ")}</span>` : ""}<span class="as-task-pipeline">${queuePipelineChip(t, id)}${queueFlowButton(t, id)}</span></div>
            ${note}
          </div>
          <div class="as-task-actions">${acts.join("")}${move}${btn("delete", "✕", "Delete", "delete this task — a removed task leaves no ghost in the digest")}</div>
        </div>
        ${more}
      </div>`;
  }

  // What the pane is showing, as one of four words rather than a read through the cache scattered over the painter.
  // The ORDER is the rule: an error is said before an empty queue, and a store that was never created says so
  // instead of reading as "carrying nothing" — `found: false` is the server's answer for a queue.json that is not
  // there, and `view.error` is the one that is there and could not be parsed.
  function queuePaneState(cached) {
    const error = cached?.error || cached?.view?.error || "";
    if (error) return { kind: "error", message: String(error) };
    if (!cached?.view) return cached?.loading ? { kind: "loading" } : { kind: "idle" };
    if (cached.view.found === false) return { kind: "missing" };
    return { kind: "ready" };
  }

  // The one line a pane with nothing (or nothing readable) to list draws. Its own function so all four cases can be
  // driven without a DOM, and so a pane that has rows AND an error still says the error above them.
  function queueStateHtml(pane, { id, n, view, rows }) {
    const at = `id="as-qstate-${esc(n)}"`;
    if (pane.kind === "error") {
      return `<div class="as-task-note is-bad" ${at}>could not read its queue — ${esc(pane.message)} <button type="button" data-as-qact="reload" data-as-qown="${esc(id)}">Retry</button></div>`;
    }
    if (pane.kind === "missing") {
      return `<div class="as-help" ${at}>no queue yet — <b>Add task</b> creates it${view?.file ? ` at <code>${esc(view.file)}</code>` : ""}</div>`;
    }
    if (pane.kind === "loading") return `<div class="as-help" ${at}>reading its queue…</div>`;
    if (pane.kind === "idle") return `<div class="as-help" ${at}>not read yet</div>`;
    return rows.length ? "" : `<div class="as-help" ${at}>(empty — this assistant is carrying nothing)</div>`;
  }

  // The board's own table, over the trees THIS assistant owns. It is not a second table: the header and every row
  // come from app.js's own `chartHeaderHtml`/`rowHtml`, so a column the reader hides on the board is hidden here too,
  // the row's actions (⟳, ✕, lock, rename) are the board's actions, and the cells cannot drift from the board's.
  // The owner column is FORCED on here: this tab exists to say "these trees are mine", and a table that dropped the
  // column would say it only in its title. A filtered row set means what it says — the rows whose resolved owner is
  // this assistant, in project-then-name order so the table does not reshuffle itself on every scan.
  function renderAssistantWorktrees(id = activeSessionId(), force = false) {
    const host = hostFor(id, "worktrees");
    if (!host || !state.assistant) return;
    const rec = sessionById(id);
    const rows = [...state.rows.values()]
      .filter((r) => r && String(r.assistant?.id || "") === String(id))
      .sort((a, b) => String(a.project || "").localeCompare(String(b.project || "")) || String(a.name || "").localeCompare(String(b.name || "")));
    const table = rows.length
      ? `<div class="wt-scroll as-worktrees-table"><table><thead><tr>${chartHeaderHtml(true)}</tr></thead><tbody>${rows.map((r) => rowHtml(r, true)).join("")}</tbody></table></div>`
      : `<div class="as-help">No worktrees are owned by ${esc(rec?.name || "this assistant")} yet. A tree a SPAWN by this assistant cuts is stamped its own; the reader can also set an owner by hand from the board's row.</div>`;
    const locked = rows.filter((r) => r.lock?.locked).length;
    host.innerHTML = `
      <div class="as-group">
        <h4>Its worktrees — ${esc(rec?.name || "this assistant")}'s own</h4>
        <div class="as-help">The board's own table over the rows this assistant owns, owner column included. ${rows.length} tree${rows.length === 1 ? "" : "s"}${locked ? ` · ${locked} locked` : ""}. Every action is the board's own: ⟳ reconciles the row, ✕ removes the tree, the padlocks lock it. A SPAWN Assistant #2 wrote stamps the tree it cut as #2's; a tree the reader cut stays Assistant #1's.</div>
        ${table}
      </div>`;
  }

  function renderAssistantQueue(id = activeSessionId(), force = false) {
    const host = hostFor(id, "queue");
    if (!host || !state.assistant) return;
    // A card is being dragged: rebuilding the pane now would take the node out from under the pointer and end the
    // gesture mid-air. The drag's own drop repaints from the answer, so skipping a paint here costs nothing.
    if (queueDrag) return;
    if (!force && typingInside(`#${paneIdFor(id, "queue")}`)) return;
    const rec = sessionById(id);
    // Ask for a read BEFORE the paint when the cache is missing or old: the paint then says it is reading instead of
    // "not read yet" for a frame, and the answer repaints it WITHOUT forcing another read (see loadQueue's .finally).
    const before = queueCache.get(id);
    if (force || !before || Date.now() - Number(before.at || 0) > 20_000) void loadQueue(id);
    // The agents' statuses come from their own route, and a paint asks for it at most every few seconds: the pane is
    // repainted by the board poll, so a read per paint would be the request loop the queue pane was fixed for once.
    if (!queueJobs.at || Date.now() - queueJobs.at > 5_000) void loadQueueJobs();
    const cached = queueCache.get(id);
    const view = cached?.view;
    const pane = queuePaneState(cached);
    const n = String(id).replace(/^assistant-/, "");
    const counts = view?.counts || {};
    const head = view
      ? `${counts.queued || 0} queued · ${counts.running || 0} running${counts.stale ? `, ${counts.stale} stale` : ""} · ${counts.parked || 0} parked · ${counts.done || 0} done`
      : cached?.loading
        ? "loading…"
        : "not loaded yet";
    const rows = Array.isArray(view?.tasks) ? view.tasks : [];
    // The pane's order: state bucket first, then the reader's `order` (the place a card was dragged to), then id.
    const sorted = queueSorted(rows);
    const byId = new Map(sorted.map((t) => [Number(t.id), t]));
    const dropNote = queueDropNotes.get(id) || "";
    host.innerHTML = `
      <div class="as-group as-qpane">
        <h4>Its task queue — ${esc(rec?.name || "this assistant")}'s own</h4>
        <div class="as-qline">
          <b class="as-qcounts"${view?.file ? ` title="${esc(view.file)}"` : ""}>${esc(head)}</b>
          <button type="button" class="as-qquiet" data-as-qact="reload" data-as-qown="${esc(id)}" title="read this assistant's queue file again">Refresh</button>
          <button type="button" class="as-qquiet" data-as-qact="pipeline" data-as-qown="${esc(id)}" title="open Settings on its Pipeline tab — the catalogue every task's pipeline is drawn from">Pipeline settings</button>
        </div>
        <details class="as-qhelp">
          <summary title="what this pane draws, how work gets into it, and how the order works">what this pane is</summary>
          <div class="as-help">
            <p class="as-qlead">the work this assistant is carrying — queued, running on its thread, parked, done — and how it gets in and out.</p>
            <dl class="as-qfacts">
              <div><dt>Add task</dt><dd>files work into THIS assistant's queue, the one this page belongs to, so a task cannot be created into a queue nobody is watching.</dd></div>
              <div><dt>Move</dt><dd>the control on an existing row: the task leaves this queue, arrives in that assistant's with an id of its own, recorded as <code>movedFrom</code>.</dd></div>
              <div><dt>Order</dt><dd>drag a queued card — the order is written to the file and survives the next read; running, parked and done keep their own sections, and a card with a <code>held by #N</code> badge cannot go above that row.</dd></div>
              <div><dt>Waiting and STALE</dt><dd>a queued task whose files touch a running task's files is shown skipped with its reason; a running task whose thread has no live run reads STALE, not phantom progress.</dd></div>
              <div><dt>Where it lives</dt><dd><code>state/assistants/${esc(id)}/queue.json</code> beside the charter, read on every wake before the board; the digest names each task's state, thread, worktree, PR and why it is not going (LIVE, STALE or PARKED).</dd></div>
            </dl>
          </div>
        </details>
        <details class="as-qadd">
          <summary title="file a task into this assistant's own queue — one press opens the form">+ Add task</summary>
          <div class="as-line"><label class="as-grow" title="what has to happen — one line is enough">title <input type="text" id="as-qtitle-${esc(n)}" class="as-grow" spellcheck="false" maxlength="200" placeholder="e.g. land the queue sub-tab's PR"></label></div>
          <div class="as-line"><label class="as-grow" title="optional: the detail an assistant needs to do it without asking">detail <input type="text" id="as-qdetail-${esc(n)}" class="as-grow" spellcheck="false" maxlength="400" placeholder="optional"></label></div>
          <div class="as-line"><label title="optional: comma-separated paths this task will touch — a queued task that overlaps a running task's files is skipped with the reason">files <input type="text" id="as-qfiles-${esc(n)}" spellcheck="false" maxlength="300" placeholder="lib/assistant/queue.js, public/assistant.js"></label>
            <button type="button" class="primary" data-as-qact="add" data-as-qown="${esc(id)}" title="add this task to ${esc(rec?.name || "this assistant")}'s own queue">Add task</button>
            <span class="as-err" id="as-qerr-${esc(n)}">${cached?.error ? esc(cached.error) : ""}</span>
          </div>
        </details>
        ${queueStateHtml(pane, { id, n, view, rows: sorted })}
        ${dropNote ? `<div class="as-qdrop" data-as-qdrop="${esc(id)}" role="status">${esc(dropNote)}</div>` : ""}
        ${sorted.map((t) => queueTaskHtml(id, t, queueJobs.byThread, byId, state.assistant?.alerts || [])).join("")}
      </div>`;
  }

  function loadQueue(id = activeSessionId()) {
    // ONE read per assistant at a time. A paint that arrives while a read is in flight joins that read instead of
    // starting a second: the pane is repainted by the board poll and by the read's own completion, so without this
    // guard an answer that lands in 62 ms could start a request per paint.
    const running = queueInflight.get(id);
    if (running) return running;
    const seq = (queueSeq.get(id) || 0) + 1;
    queueSeq.set(id, seq);
    const fresh = () => seq === (queueSeq.get(id) || 0);
    const prior = queueCache.get(id);
    queueCache.set(id, { ...prior, loading: true, error: null });
    // The pane is painted by the caller; this only refreshes the cache and asks for one repaint of the pane the reader
    // is looking at. A second tab's answer repaints nothing.
    const read = apiFetch(`/api/assistant/queue?assistantId=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (d.assistant) applyAssistant(d.assistant);
        if (!fresh()) return; // a newer read or a write has landed; this answer describes a moment already gone
        queueCache.set(id, { view: d.queue, error: null, loading: false, at: Date.now() });
      })
      .catch((err) => {
        if (!fresh()) return;
        const last = queueCache.get(id) || {};
        queueCache.set(id, { ...last, loading: false, error: String((err && err.message) || err), at: Date.now() });
      })
      .finally(() => {
        queueInflight.delete(id);
        // WITHOUT force. A forced repaint calls loadQueue again, and a read that repaints itself by force is a spinner
        // with no end — that was the defect: the pane never left "reading its queue…" and every superseded answer was
        // dropped by the sequence guard. An empty store and a failed read are STATES the pane draws, not reasons to
        // read again; Retry is the reader's own second attempt.
        const view = state.assistantView;
        if (view && view.subTab === "queue" && view.assistant === id) renderAssistantQueue(id);
      });
    queueInflight.set(id, read);
    return read;
  }

  // GET /api/jobs, indexed by thread and keeping that thread's NEWEST turn — the same "latest" the card's head reads,
  // and the reason the queue does not ask the task record what its agents are doing. The answer cannot fail a paint:
  // a refused read leaves the last map in place, so the pane keeps the words it had rather than claiming everything
  // stopped. The clock is stamped on the way out either way, which is what stops a failing route from being retried on
  // every repaint.
  function loadQueueJobs() {
    if (queueJobs.inflight) return queueJobs.inflight;
    const read = apiFetch("/api/jobs")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        const byThread = new Map();
        for (const j of Array.isArray(d.jobs) ? d.jobs : []) {
          const thread = String(j.thread || "");
          if (!thread) continue;
          const prev = byThread.get(thread);
          if (!prev || String(j.startedAt || "").localeCompare(String(prev.startedAt || "")) >= 0) byThread.set(thread, j);
        }
        queueJobs.byThread = byThread;
      })
      .catch(() => {
        /* keep the last answer: an unreadable route is not every run having stopped */
      })
      .finally(() => {
        queueJobs.at = Date.now();
        queueJobs.inflight = null;
        // One repaint of the pane on screen, WITHOUT force: a forced paint asks for a read, and a read that repaints
        // itself by force is the spinner the queue pane was fixed for once already.
        const view = state.assistantView;
        if (view && view.subTab === "queue" && isAssistant(view.assistant)) renderAssistantQueue(view.assistant);
      });
    queueJobs.inflight = read;
    return read;
  }

  // Which row's picker is open is the record above; this paints the DOM from it, so opening one closes the other and a
  // repaint (which rebuilds the markup with `hidden` already right) needs no special case.
  function paintQueueMove() {
    for (const pop of document.querySelectorAll("[data-as-qmove-pop]")) {
      const on = qmoveOpen.has(String(pop.dataset.asQmovePop || ""));
      pop.hidden = !on;
      const btn = pop.parentElement ? pop.parentElement.querySelector("[data-as-qmove-open]") : null;
      if (btn) btn.setAttribute("aria-expanded", on ? "true" : "false");
    }
  }
  function closeQueueMove() {
    if (!qmoveOpen.size) return;
    qmoveOpen.clear();
    paintQueueMove();
  }
  // One picker at a time: opening a second one closes the first, and pressing the open one's ➡️ closes it. A pick is a
  // plain data-as-qact="reassign" press with data-as-qmove-to, so the write path below is the same route it always was.
  function toggleQueueMove(key) {
    const k = String(key || "");
    if (!k) return;
    if (qmoveOpen.has(k)) qmoveOpen.delete(k);
    else {
      qmoveOpen.clear();
      qmoveOpen.add(k);
    }
    paintQueueMove();
  }

  async function queueAct(id, action, body = {}) {
    try {
      const d = await asPost("/api/assistant/queue", { assistantId: id, action, ...body });
      // The route answers with the assistant's whole state and the queue it just wrote, so the pane repaints from the
      // same answer the tab would have fetched — no second read, and no window where the row says "running" while the
      // file says "queued".
      // A read that was already in flight when this write landed describes the queue as it was BEFORE the write, so
      // this write supersedes it rather than letting it repaint the old list over the new one.
      queueSeq.set(id, (queueSeq.get(id) || 0) + 1);
      if (d.queue) queueCache.set(id, { view: d.queue, error: null, loading: false, at: Date.now() });
      // A Move answers with the queue the task landed in as well. Caching it keeps the OTHER assistant's pane honest
      // without a second request — and a read of that pane already in flight describes the queue before the move, so it
      // is superseded rather than allowed to repaint the target's list without the row that just arrived.
      if (d.movedTo?.assistantId) {
        queueSeq.set(d.movedTo.assistantId, (queueSeq.get(d.movedTo.assistantId) || 0) + 1);
        queueCache.set(d.movedTo.assistantId, { view: d.movedTo, error: null, loading: false, at: Date.now() });
      }
      renderAssistantQueue(id, true);
      return d;
    } catch (err) {
      setErr(`as-qerr-${String(id).replace(/^assistant-/, "")}`, String((err && err.message) || err));
      return null;
    }
  }

  // ---- dragging a card into a new place ------------------------------------------------------------
  //
  // The order the pane draws is state bucket → `order` → id, so a drag only ever changes the middle term, and only
  // inside the QUEUED bucket: running, parked and done cards are not `.is-draggable` and never start a gesture. The
  // card itself is what moves — the pointer crossing a queued card's midpoint re-inserts it before that card, and the
  // transform keeps it under the pointer across the reflow — so what the reader sees before the drop is the list the
  // drop sends.
  //
  // Two rules make this safe beside a body that is itself a click target:
  //   - nothing happens until the pointer has TRAVELLED (4 px): a press and a release on the spot is the reader's
  //     click, and it reaches the opener untouched;
  //   - the click the browser fires at the end of a drag is swallowed by `queueCardClickGuard`, judged by the clock
  //     `queueDragEnded` stamps. A drag must never open a card.
  const QUEUE_DRAG_THRESHOLD = 4;

  // ---- the pane's own edge: a held gesture scrolls the list -----------------------------------------
  //
  // The pane is usually SHORTER than the queue — nine queued cards in the 480 px rail are taller than the window it
  // draws — and a pointer cannot travel past the edge of the box it is in. Without the crawl below, a card could only
  // be put where a visible card is: the pointer stopped at the edge and the drop landed on whatever midpoint it had
  // last crossed, while the reader was aiming at a row further down. That is the reader's "it does not drag and drop
  // like it says", so the frame loop is part of the gesture, not a decoration on it.
  //
  // The edge band is measured on the SCROLLER, not the pane: the rail and the float both scroll in `.as-body`, and a
  // narrow enough window falls back to the document, so the walk starts at the pane and takes the first ancestor that
  // can actually move. Speed ramps from nothing at the band's inner edge to full at the box's edge, which is what makes
  // a small overshoot crawl and a deliberate one travel.
  const QUEUE_SCROLL_EDGE = 26;
  const QUEUE_SCROLL_STEP = 14;
  let queueDragRaf = 0;
  function queueScrollerOf(el) {
    for (let n = el?.closest?.('[data-subpane="queue"]') || null; n && n !== document.body; n = n.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
      if (n.scrollHeight <= n.clientHeight + 1) continue;
      return n;
    }
    const doc = document.scrollingElement;
    return doc && doc.scrollHeight > doc.clientHeight + 1 ? doc : null;
  }
  function queueScrollBy(d, dy) {
    const s = d.scroller;
    if (!s) return 0;
    const before = s.scrollTop;
    s.scrollTop = Math.max(0, Math.min(s.scrollHeight - s.clientHeight, before + dy));
    return s.scrollTop - before;
  }
  // Where the card lands, and where it is drawn. Split out because a scroll moves the LIST under a pointer that has
  // not moved: the same decision has to run again with the pointer where it already is.
  function queueDragPaint(d, clientY) {
    // Where the card would land: before the first queued card whose midpoint the pointer has passed, else after the
    // last one. Only queued cards take part — the three fixed sections never swap places with the drag.
    const cards = queueCardsIn(d.el).filter((c) => c !== d.el && c.dataset.asQstate === "queued");
    const at = cards.find((c) => {
      const box = c.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    if (at) {
      if (d.el.nextElementSibling !== at) at.parentElement.insertBefore(d.el, at);
    } else if (cards.length) {
      const last = cards[cards.length - 1];
      if (d.el.previousElementSibling !== last) last.parentElement.insertBefore(d.el, last.nextElementSibling);
    }
    // Re-anchor under the pointer: a DOM move changes the card's layout top, and the transform is measured from that
    // top, so it is recomputed from the box the browser just laid out rather than accumulated from deltas.
    const layoutTop = d.el.getBoundingClientRect().top - d.translate;
    d.translate = Math.round(clientY - d.grab - layoutTop);
    d.el.style.transform = `translateY(${d.translate}px)`;
  }
  function queueDragFrame() {
    const d = queueDrag;
    if (!d || !d.moved) {
      queueDragRaf = 0;
      return;
    }
    let dy = 0;
    const box = d.scroller?.getBoundingClientRect?.();
    if (box && box.height > 0) {
      const top = box.top + QUEUE_SCROLL_EDGE;
      const bottom = box.bottom - QUEUE_SCROLL_EDGE;
      if (d.y < top) dy = -Math.ceil(QUEUE_SCROLL_STEP * Math.min(1, (top - d.y) / QUEUE_SCROLL_EDGE));
      else if (d.y > bottom) dy = Math.ceil(QUEUE_SCROLL_STEP * Math.min(1, (d.y - bottom) / QUEUE_SCROLL_EDGE));
    }
    // The crawl only re-decides the drop when it actually moved the list: a pointer parked far from either edge costs
    // one comparison a frame and nothing else.
    if (dy && queueScrollBy(d, dy)) queueDragPaint(d, d.y);
    queueDragRaf = requestAnimationFrame(queueDragFrame);
  }
  const queueDragScrollStart = () => {
    if (!queueDragRaf) queueDragRaf = requestAnimationFrame(queueDragFrame);
  };
  const queueDragScrollStop = () => {
    if (queueDragRaf) cancelAnimationFrame(queueDragRaf);
    queueDragRaf = 0;
  };

  function queueCardDown(e) {
    if (queueDrag || e.button !== 0) return;
    const el = e.target?.closest?.(".as-task.is-draggable");
    if (!el) return;
    // A press on a control is that control's, not the card's: the glyphs, the Move popover, any field — and the
    // row's own disclosure, whose summary must toggle instead of starting a drag.
    if (e.target.closest("button, a, input, select, textarea, label, .as-qmove-pop, summary, .as-task-more")) return;
    const rect = el.getBoundingClientRect();
    queueDrag = {
      el,
      own: String(el.dataset.asQown || ""),
      // The box a held gesture has to crawl. Measured once: the frame it has to move cannot change mid-press without
      // the pane being rebuilt, and the pane is not rebuilt while a drag is live.
      scroller: queueScrollerOf(el),
      startY: e.clientY,
      y: e.clientY,
      grab: e.clientY - rect.top,
      translate: 0,
      moved: false,
      before: queueIdsIn(el),
    };
    // No text selection and no native drag for the length of the press: without this the browser starts selecting the
    // card's own text the moment the pointer moves.
    e.preventDefault();
  }

  function queueCardMove(e) {
    const d = queueDrag;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < QUEUE_DRAG_THRESHOLD) return;
      d.moved = true;
      d.el.classList.add("is-dragging");
      d.el.closest('[data-subpane="queue"]')?.classList.add("as-qdrag");
      queueDropNotes.delete(d.own);
      // The crawl starts with the gesture and runs until the release, so a pointer held still at the pane's edge keeps
      // travelling: a reader waits for the list, they do not shake the card at it.
      queueDragScrollStart();
    }
    d.y = e.clientY;
    queueDragPaint(d, e.clientY);
  }

  async function queueCardUp(cancelled = false) {
    const d = queueDrag;
    if (!d) return;
    queueDrag = null;
    queueDragScrollStop();
    const el = d.el;
    el.classList.remove("is-dragging");
    el.style.transform = "";
    el.closest('[data-subpane="queue"]')?.classList.remove("as-qdrag");
    // A press that never travelled is the reader's click: the opener on the body gets it, untouched.
    if (!d.moved) return;
    // From here on, the click the browser fires at the end of this gesture belongs to the drag.
    queueDragEnded = Date.now();
    if (cancelled) {
      // The browser took the gesture back — a touch scroll, a lost pointer. Nothing the reader chose happened, so the
      // card goes back where it was and NOTHING is written: committing the DOM's half-finished order would reorder the
      // queue on a scroll.
      renderAssistantQueue(d.own);
      return;
    }
    const ids = queueIdsIn(el);
    if (!ids.length || ids.join(",") === d.before.join(",")) {
      // Nothing moved: a paint from the cache is the honest answer, not a write that says "the order did not move".
      renderAssistantQueue(d.own);
      return;
    }
    const rows = queueCache.get(d.own)?.view?.tasks || [];
    const blocked = queueDropBlocked(rows, ids);
    if (blocked) {
      // Snap back: the cache still holds the order before the drag, so one paint from it restores the list — and the
      // one line says which row is holding the card that was dropped.
      queueDropNotes.set(d.own, blocked.line);
      renderAssistantQueue(d.own);
      return;
    }
    queueDropNotes.delete(d.own);
    const out = await queueAct(d.own, "reorder", { ids });
    // A refusal — the server's own copy of the rule, or a list a stale pane got past — snaps back the same way: the
    // cache is the order the server last confirmed.
    if (!out) renderAssistantQueue(d.own);
  }

  // The browser fires a click at the end of a drag as well: the pointer went down and came up over a card, and that is
  // the whole of its test. This is the one place that knows a drag happened, so it swallows that click in the CAPTURE
  // phase, before the row body's own opener (a bubble listener on the same float) can see it.
  function queueCardClickGuard(e) {
    if (!queueDragEnded) return;
    if (Date.now() - queueDragEnded > 600) return;
    if (!(e.target?.closest?.(".as-task"))) return;
    queueDragEnded = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // ---- end the queue sub-tab --------------------------------------------------------------------

  // ---- the task pipeline window -----------------------------------------------------------------
  //
  // What one queue row's pipeline holds, opened from the row. The DATA is the server's (`/api/assistant/task-pipeline`,
  // lib/pipeline-window.js): every stage in the bundle's order, which one is current, the gate that ended the one before
  // it, and the time in stage computed from the record's stored `enteredAt` against the request's clock. This file draws
  // that answer and owns three things the server cannot: the dialog's behaviour, the tick, and the words.
  //
  // Three states, and no fourth — the same three lib/task-pipeline.js names:
  //   pipeline            every stage, the current one marked, its `position of count`, the artifact each produces, the
  //                       gate that ended the previous stage, and "in this stage 2h30m00s since …";
  //   assistant-decides   the DEFAULT path in words, with no stage list to mistake for one;
  //   unresolved          the reason, no stage marked current, and the sentence that says this is NOT the default path.
  //
  // The clock is a DISPLAY of stored data. `data-pipew-ms` is the number the server computed from `enteredAt`;
  // `pipeWindowElapsedAt` adds only the time since that answer (`data-pipew-at`), so a window opened after the panel sat
  // closed for an hour shows the hour — because the server recomputed on open, not because a timer kept counting.
  const PIPE_WINDOW_ID = "pipew";
  const PIPE_CARD_ID = "pipew-card";
  // What Tab may land on inside the dialog. The card itself has tabindex -1 (it is the thing focused on open), so it is
  // deliberately not in this list.
  const PIPE_TABBABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  // The one open window's frame of reference: the row the caret came from, the ids needed to find it again after a
  // repaint, and the timer. It is a record, not a DOM flag, so the tick can be stopped without reading the page.
  const pipeWindowState = { opener: null, assistantId: null, taskId: null, at: 0, timer: null, model: null, catalogue: null, busy: false };

  // How long a stage has been lived in, `tick` ms after the answer that said `ms`. The server's number is the base: this
  // adds nothing but the wall clock since, and a clock that went backwards takes nothing away from the stage.
  function pipeWindowElapsedAt(ms, at, now) {
    const base = Number(ms);
    if (!Number.isFinite(base)) return null;
    const since = Number(now) - Number(at);
    return Math.max(0, base + (Number.isFinite(since) ? Math.max(0, since) : 0));
  }

  function pipeWindowElapsedText(ms) {
    return ms == null || !Number.isFinite(Number(ms)) ? "—" : fmtDur(ms);
  }

  // A stamp in the reader's own timezone, with the stored instant in the tooltip: the panel stores UTC, the reader reads
  // a clock. A date the browser cannot parse is drawn as it was stored, never as "Invalid Date".
  function pipeWindowStamp(iso) {
    const ms = Date.parse(String(iso || ""));
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : String(iso || "");
  }

  // What a row's phase means, in the words a reader needs rather than the model's own names.
  function pipeWindowPhaseWords(phase) {
    if (phase === "current") return "current stage";
    if (phase === "before") return "before this stage";
    if (phase === "after") return "still ahead";
    return "not in this pipeline";
  }

  // The gate that ends one stage: its name, the artifact it decides on, and the values a decision can be read back as.
  // A gate with no decision is a PAUSE (the studio's own word), and saying so is better than an empty line.
  function pipeWindowGateLine(gate) {
    if (!gate) return "";
    const d = gate.decision;
    const decision = d ? `${esc(d.path)} (${d.outcomes.map((o) => esc(o)).join(", ")})` : "a pause — no decision artifact";
    return `<span class="pipew-gate">gate <b>${esc(gate.name)}</b> — decides ${decision}</span>`;
  }

  // The line above the sequence: the gate that ended the stage before this one, or the handoff that joined them when the
  // bundle draws no gate there. That is the "what came before" a reader cannot get from an index.
  function pipeWindowPreviousLine(previous) {
    if (!previous || !previous.stage) return "";
    if (previous.gate) {
      const d = previous.gate.decision;
      const decision = d ? `${esc(d.path)} (${d.outcomes.map((o) => esc(o)).join(", ")})` : "a pause — no decision artifact";
      return `<div class="pipew-prev">ended the stage before — <b>${esc(previous.gate.name)}</b> on ${esc(previous.gate.artifact)}, decided in ${decision}</div>`;
    }
    const hand = previous.handoff;
    return `<div class="pipew-prev">no gate between <b>${esc(previous.stage.title)}</b> and the current stage — ${hand ? `handoff ${esc(hand.id)} carried ${esc(hand.artifact)}` : "the bundle draws no edge there either"}</div>`;
  }

  // One stage row. The current one carries the moment it began and the elapsed span the tick advances; every row carries
  // its position, the artifact it produces, and the gate that ends it.
  function pipeWindowStageRow(stage, model) {
    const current = stage.phase === "current";
    const ms = current && model.elapsed && model.elapsed.ok ? Number(model.elapsed.ms) : null;
    const at = Date.parse(String(model.computedAt || ""));
    const live = current
      ? `<span class="pipew-live">in this stage <b data-pipew-elapsed data-pipew-ms="${esc(String(ms ?? ""))}" data-pipew-at="${esc(String(Number.isFinite(at) ? at : ""))}">${esc(pipeWindowElapsedText(ms))}</b> since <span class="pipew-since" title="${esc(model.enteredAt || "")}">${esc(pipeWindowStamp(model.enteredAt))}</span>${
          model.elapsed && model.elapsed.future ? ` <span class="pipew-warn">(the stamp is ahead of this clock — shown as 0)</span>` : ""
        }</span>`
      : "";
    return `<li class="pipew-stage is-${esc(stage.phase)}" data-pipew-stage="${esc(stage.id)}" data-pipew-phase="${esc(stage.phase)}">
        <span class="pipew-n mono">${esc(String(stage.position))}</span>
        <span class="pipew-name">${esc(stage.title)}</span>
        <span class="pipew-pos mono">${esc(`${stage.position} of ${model.count}`)}</span>
        <span class="pipew-phase">${esc(pipeWindowPhaseWords(stage.phase))}</span>
        ${live}
        <span class="pipew-artifact">${esc(stage.artifact.id)} → ${esc(stage.artifact.path)} · ${esc(stage.artifact.schema)} · ${esc(stage.artifact.writer)}</span>
        ${pipeWindowGateLine(stage.gateEnding)}
      </li>`;
  }

  // The pipelines a catalogue offers, or none. Kept as one reader so the form and the dependent stage select cannot
  // disagree about what "the bundle holds" means.
  function pipeWindowPipelines(catalogue) {
    return catalogue && catalogue.ok === true && Array.isArray(catalogue.pipelines) ? catalogue.pipelines : [];
  }

  // The stage options for ONE pipeline, with `selectedId` marked when that pipeline holds it. The form's first paint and
  // the change handler both call this, so choosing another pipeline can never leave a stage id from the old one
  // selected — an id the new pipeline does not hold falls back to its first stage, visibly, rather than being kept.
  function pipeWindowStageOptions(catalogue, pipelineId, selectedId) {
    const list = pipeWindowPipelines(catalogue);
    const chosen = list.find((p) => p.id === String(pipelineId || "")) || list[0] || null;
    if (!chosen) return '<option value="">(no stage)</option>';
    const want = String(selectedId || "");
    const keep = chosen.stages.some((s) => s.id === want) ? want : (chosen.stages[0] && chosen.stages[0].id) || "";
    return chosen.stages.map((s) => `<option value="${esc(s.id)}"${s.id === keep ? " selected" : ""}>${esc(`${s.position}. ${s.title}`)}</option>`).join("");
  }

  // The control that puts a task ON a pipeline, moves it, or sends it back to the default. Three answers, and each of
  // them is an explicit press: this never assigns anything on its own, and it never draws the form against a bundle the
  // server said it could not read — the reason is printed where the selects would have been.
  function pipeWindowAssignHtml(model, catalogue) {
    if (!catalogue) {
      return `<div class="pipew-assign" data-pipew-assign><div class="pipew-note">reading the pipelines a task can be put on…</div></div>`;
    }
    const pipelines = pipeWindowPipelines(catalogue);
    if (catalogue.ok !== true || !pipelines.length) {
      return `<div class="pipew-assign" data-pipew-assign><div class="pipew-note is-bad"><b>no pipeline can be chosen</b> — ${esc(
        catalogue.reason || "the bundle holds no pipeline",
      )}${catalogue.code ? ` <span class="mono">(${esc(catalogue.code)})</span>` : ""}${catalogue.file ? ` <span class="mono">${esc(catalogue.file)}</span>` : ""}</div></div>`;
    }
    const mode = model.mode;
    const current = model.current || null;
    const inForce = model.pipeline && pipelines.some((p) => p.id === model.pipeline.id) ? model.pipeline.id : null;
    const chosen = inForce || pipelines[0].id;
    const stageId = inForce && current ? current.id : "";
    const heading = mode === "pipeline" ? "move this task to another stage" : "put this task on a pipeline";
    const apply = mode === "pipeline" ? "move it to this stage" : "put it on this pipeline";
    // An unresolved record is REPAIRED by an assignment, and saying so is the difference between a repair and a silent
    // fallback: the broken record is replaced because the reader pressed a button that says it will be.
    const repair =
      mode === "unresolved"
        ? `<div class="pipew-note">this record cannot be read by the bundle — assigning a pipeline here <b>replaces</b> it with a stage the bundle holds. It is the repair, not a fallback that pretends the record was the default path.</div>`
        : "";
    const clear =
      mode === "pipeline"
        ? `<button type="button" class="pipew-clear" data-pipew-clear title="clear the assignment — the task goes back to the assistant decides, and no stage or time in stage is claimed for it" aria-label="clear the pipeline assignment, back to the assistant decides">clear — back to the assistant decides</button>`
        : "";
    return `<div class="pipew-assign" data-pipew-assign data-pipew-mode="${esc(mode)}">
      <div class="pipew-assign-head"><b>${esc(heading)}</b> — the choice is stored on the task, and entering a stage stamps that moment; the assistant decides only while no pipeline is assigned.</div>
      ${repair}
      <div class="pipew-form">
        <label>pipeline <select data-pipew-pipe>${pipelines
          .map((p) => `<option value="${esc(p.id)}"${p.id === chosen ? " selected" : ""}>${esc(p.title)} (${esc(p.id)})</option>`)
          .join("")}</select></label>
        <label>starting stage <select data-pipew-stage>${pipeWindowStageOptions(catalogue, chosen, stageId)}</select></label>
        <button type="button" class="primary" data-pipew-apply>${esc(apply)}</button>
        ${clear}
        <span class="pipew-assign-note" data-pipew-assign-note role="status" aria-live="polite"></span>
      </div>
    </div>`;
  }

  // The whole dialog body, from the server's model. `null` is the press's first paint: the read is in flight and the
  // window is already open, so the reader sees what is happening instead of a dead row.
  function pipelineWindowHtml(model, catalogue = null) {
    const close = `<button type="button" class="pipew-close" data-pipew-close title="close (Esc) — focus goes back to the task row" aria-label="close the pipeline window">✕</button>`;
    const bar = (title, sub) =>
      `<div class="pipew-bar"><span class="pipew-kicker">pipeline window</span><b class="pipew-title" id="pipew-title">${esc(title)}</b>${
        sub ? `<span class="pipew-sub mono">${esc(sub)}</span>` : ""
      }<span class="spacer"></span>${close}</div>`;

    if (!model) return `${bar("reading…", "")}<div class="pipew-body"><div class="pipew-note">reading this task's pipeline…</div></div>`;

    const task = model.task || {};
    const named = `${task.id != null ? `#${task.id} ` : ""}${task.title || "task"}`;
    const head = (sub) => bar(named, sub);

    if (model.error) {
      return `${head("")}<div class="pipew-body"><div class="pipew-note is-bad"><b>could not read this task's pipeline</b> — ${esc(model.error)}</div></div>`;
    }

    if (model.mode === "assistant-decides") {
      return `${head("no pipeline")}<div class="pipew-body">
        <div class="pipew-note"><b>This task is on the default path</b> — no pipeline is assigned, so the assistant decides what it does next. There is no stage to be in, and no time in stage to measure.</div>
        ${pipeWindowAssignHtml(model, catalogue)}
      </div>`;
    }

    if (model.mode !== "pipeline") {
      const why = model.unresolved ? model.unresolved.reason : model.reason;
      const rows = (model.stages || []).map((s) => pipeWindowStageRow(s, model)).join("");
      return `${head("unresolved")}<div class="pipew-body">
        <div class="pipew-note is-bad"><b>UNRESOLVED</b> — ${esc(why || "this task's pipeline record cannot be read")}</div>
        <div class="pipew-note"><b>Never treated as the default path</b> — a record the bundle cannot read is shown as it is, because calling it “the assistant decides” would silently drop the pipeline this task was put on. The stages below are the sequence the bundle still holds${rows ? ", with nothing marked current" : ""}.</div>
        ${model.bundle && model.bundle.ok === false && model.bundle.file ? `<div class="pipew-note mono">bundle ${esc(model.bundle.file)} — ${esc(model.bundle.code || "refused")}${model.bundle.where ? ` at ${esc(model.bundle.where)}` : ""}</div>` : ""}
        ${rows ? `<ol class="pipew-stages">${rows}</ol>` : ""}
        ${pipeWindowAssignHtml(model, catalogue)}
      </div>`;
    }

    const current = model.current || {};
    const count = model.count;
    const rows = (model.stages || []).map((s) => pipeWindowStageRow(s, model)).join("");
    const elapsed = model.elapsed && model.elapsed.ok ? pipeWindowElapsedText(model.elapsed.ms) : "—";
    const entered = model.enteredAt ? pipeWindowStamp(model.enteredAt) : "";
    return `${head(`${current.position} of ${count} — ${current.title || current.id}`)}<div class="pipew-body">
      <div class="pipew-meta">
        <span class="pipew-pipe">${esc(model.pipeline.title || model.pipeline.id)} <code>${esc(model.pipeline.id)}</code></span>
        <span class="pipew-sub mono">stage ${esc(String(current.position))} of ${esc(String(count))} · ${esc(current.title || current.id)} <code>${esc(current.id)}</code></span>
        <span class="pipew-since">began ${esc(entered)}</span>
        <span class="pipew-sub">in this stage ${esc(elapsed)}</span>
      </div>
      ${pipeWindowPreviousLine(model.previous)}
      <ol class="pipew-stages">${rows}</ol>
      ${pipeWindowAssignHtml(model, catalogue)}
    </div>`;
  }

  // Draw the dialog. `doc` is an argument, not a global, so the whole controller can be driven by a test with a stub
  // page — the same reason the queue's renderer takes `esc`.
  function pipeWindowShow({ doc = document, model = null, catalogue = null, opener = null, assistantId = null, taskId = null } = {}) {
    const host = doc.getElementById(PIPE_WINDOW_ID);
    const card = doc.getElementById(PIPE_CARD_ID);
    if (!host || !card) return null;
    host.hidden = false;
    card.innerHTML = pipelineWindowHtml(model, catalogue);
    // The state, on the element: reading / pipeline / assistant-decides / unresolved / error. A harness (and a reader of
    // the DOM with devtools) can tell a window that is still reading from one that answered without reading the words.
    card.dataset.pipewMode = model ? (model.error ? "error" : model.mode || "unknown") : "reading";
    doc.body?.classList?.add("pipew-open");
    pipeWindowState.opener = opener || pipeWindowState.opener;
    pipeWindowState.assistantId = assistantId ?? model?.assistantId ?? pipeWindowState.assistantId;
    pipeWindowState.taskId = taskId ?? model?.task?.id ?? pipeWindowState.taskId;
    pipeWindowState.at = Date.now();
    pipeWindowState.model = model;
    pipeWindowState.catalogue = catalogue;
    // The dialog takes the caret on open — it is a modal, and the reader's next key must land in it. `preventScroll`
    // because focusing a fixed card must not move the page behind it.
    card.focus?.({ preventScroll: true });
    return pipeWindowState;
  }

  // Close it, and hand the caret back to the row it came from. The opener is usually still there; after a repaint of the
  // queue pane it is detached, so the row is found again by the ids it carries (an assistant's queue is the only scope
  // where a task id is unique).
  function pipeWindowClose({ doc = document, restore = true } = {}) {
    const host = doc.getElementById(PIPE_WINDOW_ID);
    const card = doc.getElementById(PIPE_CARD_ID);
    if (!host || host.hidden) return false;
    host.hidden = true;
    if (card) card.innerHTML = "";
    doc.body?.classList?.remove("pipew-open");
    pipeWindowStopClock();
    const from = pipeWindowState.opener;
    const ids = { own: pipeWindowState.assistantId, task: pipeWindowState.taskId };
    pipeWindowState.opener = null;
    pipeWindowState.model = null;
    if (restore) {
      const again = from && from.isConnected !== false
        ? from
        : ids.own && ids.task
          ? doc.querySelector?.(`[data-as-qpipe="${String(ids.task).replace(/"/g, "")}"][data-as-qown="${String(ids.own).replace(/"/g, "")}"]`)
          : null;
      (again || doc.getElementById("as-queue") || doc.getElementById("as-queue-0"))?.focus?.({ preventScroll: true });
    }
    return true;
  }

  // Escape closes; Tab cycles inside. Returns true when it handled the key, so the caller knows the press was consumed.
  // `stopPropagation` on Escape is the load-bearing line: the rail's own Escape handler would otherwise close the whole
  // assistant panel behind an open dialog.
  function pipeWindowKey(e, { doc = document } = {}) {
    const host = doc.getElementById(PIPE_WINDOW_ID);
    if (!host || host.hidden) return false;
    if (e.key === "Escape") {
      e.preventDefault?.();
      e.stopPropagation?.();
      pipeWindowClose({ doc });
      return true;
    }
    if (e.key !== "Tab") return false;
    const card = doc.getElementById(PIPE_CARD_ID);
    const items = card && typeof card.querySelectorAll === "function" ? [...card.querySelectorAll(PIPE_TABBABLE)] : [];
    if (!items.length) return false;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && doc.activeElement === first) {
      e.preventDefault?.();
      last.focus?.();
      return true;
    }
    if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault?.();
      first.focus?.();
      return true;
    }
    return false;
  }

  // Advance the one number a tick may advance. It re-reads the span the last answer drew and adds only the wall clock
  // since that answer, so a stage change on the server is never invented here — reopening is what re-asks.
  function pipeWindowTick(doc = document) {
    const el = doc.querySelector?.("[data-pipew-elapsed]");
    if (!el || !el.dataset) return null;
    // An elapsed the server could NOT compute (a stamp that is missing or local-time) is drawn as "—" and has no base to
    // advance: a tick that read the empty attribute as 0 would count up from the moment the window opened, which is a
    // number nobody can defend. The window keeps saying it does not know.
    const raw = el.dataset.pipewMs;
    if (raw == null || raw === "" || !Number.isFinite(Number(raw))) return null;
    const ms = pipeWindowElapsedAt(Number(raw), Number(el.dataset.pipewAt), Date.now());
    if (ms == null) return null;
    el.textContent = pipeWindowElapsedText(ms);
    return ms;
  }

  function pipeWindowStopClock() {
    if (pipeWindowState.timer) {
      clearInterval(pipeWindowState.timer);
      pipeWindowState.timer = null;
    }
  }

  // One second, and only while the tab is VISIBLE: a background tab repainting a number nobody is reading is the
  // request-free version of a repaint loop. Coming back to the tab ticks at once, so the number is never stale by a
  // visible frame.
  function pipeWindowStartClock(doc = document) {
    pipeWindowStopClock();
    pipeWindowState.timer = setInterval(() => {
      if (doc.hidden) return;
      pipeWindowTick(doc);
    }, 1000);
  }

  // The press: open at once with the reading state, then draw what the server says. A failed read is a window with the
  // reason in it, never a press that did nothing.
  //
  // TWO reads, in parallel: the task's own answer, and the catalogue the assignment control offers. They are separate
  // routes because the catalogue is panel-wide (one bundle per install) and the window's model is one row's — but they
  // are asked at the same moment, so the control is not a second wait after the window has already answered.
  async function openTaskPipelineWindow(assistantId, taskId, opener = null) {
    if (!assistantId || !taskId) return;
    const doc = document;
    pipeWindowShow({ doc, model: null, catalogue: pipeWindowState.catalogue, opener, assistantId, taskId });
    pipeWindowStartClock(doc);
    const readJson = async (url) => {
      const r = await apiFetch(url);
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error((body && body.error) || `the panel answered ${r.status}`);
      return body;
    };
    let model;
    let catalogue;
    const [taskRead, catalogueRead] = await Promise.allSettled([
      readJson(`/api/assistant/task-pipeline?assistantId=${encodeURIComponent(assistantId)}&task=${encodeURIComponent(taskId)}`),
      readJson(`/api/assistant/pipeline-catalogue?assistantId=${encodeURIComponent(assistantId)}`),
    ]);
    model = taskRead.status === "fulfilled" ? taskRead.value : { mode: "error", error: String((taskRead.reason && taskRead.reason.message) || taskRead.reason) };
    // A catalogue that could not be read is a REFUSAL the control prints, in the same shape the route's own refusals
    // take — never null, which the window would draw as "still reading" forever.
    catalogue =
      catalogueRead.status === "fulfilled"
        ? catalogueRead.value
        : { ok: false, code: "error", reason: String((catalogueRead.reason && catalogueRead.reason.message) || catalogueRead.reason), pipelines: [] };
    // The reader may have closed it, or opened another row's, while the read was in flight: only the window that is
    // still on this task is drawn again.
    if (!pipeWindowState.opener || String(pipeWindowState.taskId) !== String(taskId)) return;
    pipeWindowShow({ doc, model, catalogue, opener: pipeWindowState.opener, assistantId, taskId });
  }

  // The FLOW press's whole read: one task answer, drawn as the sequence. It is a READ — the modal shows where the record
  // is and lets the reader step a PREVIEW through the stages (nothing is written, and the preview says so); the chip
  // beside it opens the window, which is where a task is assigned or moved.
  async function openTaskPipelineFlow(assistantId, taskId, opener = null) {
    if (!assistantId || !taskId) return null;
    const modal = typeof PipelineModal === "undefined" ? null : PipelineModal;
    const flowApi = typeof PipelineFlow === "undefined" ? null : PipelineFlow;
    if (!modal || !flowApi) return null;
    modal.open({ mode: "position", title: `#${taskId}`, loading: true, opener });
    let model;
    let catalogue;
    const readJson = async (url) => {
      const r = await apiFetch(url);
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error((body && body.error) || `the panel answered ${r.status}`);
      return body;
    };
    // Two reads, in parallel, both already on the server: the task's own answer (which stage, since when) and the
    // catalogue (the pipeline's FULL shape — every gate, every handoff, a loop's cap). The window's model carries the
    // gate that ends each stage but only the joining handoff, so the loops a reader is looking for live in the bundle;
    // drawing the flow from the catalogue's pipeline is what makes the arcs complete.
    const [taskRead, catalogueRead] = await Promise.allSettled([
      readJson(`/api/assistant/task-pipeline?assistantId=${encodeURIComponent(assistantId)}&task=${encodeURIComponent(taskId)}`),
      readJson(`/api/assistant/pipeline-catalogue?assistantId=${encodeURIComponent(assistantId)}`),
    ]);
    if (taskRead.status === "fulfilled") model = taskRead.value;
    else model = { mode: "error", error: String((taskRead.reason && taskRead.reason.message) || taskRead.reason) };
    catalogue = catalogueRead.status === "fulfilled" ? catalogueRead.value : null;
    // The reader may have closed it while the read was in flight: a closed dialog is not repainted.
    if (!modal.isOpen()) return null;
    const task = (model && model.task) || { id: taskId, title: null };
    const title = `${task.id != null ? `#${task.id} ` : `#${taskId} `}${task.title || "task"}`;
    if (!model || model.error) {
      modal.open({ mode: "position", title, note: `could not read this task's pipeline — ${(model && model.error) || "the panel answered nothing"}`, facts: [], opener });
      return null;
    }
    const current = model.current || null;
    const count = model.count;
    if (model.mode === "assistant-decides") {
      modal.open({
        mode: "position",
        title,
        subtitle: "no pipeline",
        facts: [{ label: "path", value: "the assistant decides" }],
        note: "This task is on the default path — no pipeline is assigned, so there is no sequence and nothing to mark. The chip beside this press opens the window where a pipeline and a stage can be chosen.",
        opener,
      });
      return null;
    }
    const bundlePipeline =
      catalogue && catalogue.ok === true && model.pipeline ? (catalogue.pipelines || []).find((p) => p.id === model.pipeline.id) || null : null;
    const flow = bundlePipeline ? flowApi.fromBundle(bundlePipeline) : flowApi.fromWindowModel(model);
    const elapsed = model.elapsed && model.elapsed.ok ? fmtDur(model.elapsed.ms) : "—";
    const entered = model.enteredAt ? pipeWindowStamp(model.enteredAt) : "—";
    const placed = model.mode === "pipeline" && current;
    const note = placed
      ? "the marks read the record — everything before this stage is done, this one is current, and everything after it is not reached. The preview below moves nothing."
      : `UNRESOLVED — ${model.unresolved && model.unresolved.reason ? model.unresolved.reason : model.reason || "this task's pipeline record cannot be read"}. The stages are drawn with nothing marked current; this is never read as the default path.`;
    modal.open({
      mode: "position",
      title,
      subtitle: placed ? `${current.position} of ${count} — ${current.title || current.id}` : "unresolved",
      pipeline: flow,
      position: placed ? { stage: current.id } : null,
      preview: flow.stages.length > 0,
      facts: placed
        ? [
            { label: "pipeline", value: `${model.pipeline.title || model.pipeline.id} (${model.pipeline.id})` },
            { label: "began", value: entered },
            { label: "in this stage", value: elapsed },
            { label: "stages", value: String(count) },
          ]
        : [
            { label: "pipeline", value: (model.unresolved && model.unresolved.pipeline) || "—" },
            { label: "stage", value: (model.unresolved && model.unresolved.stage) || "—" },
            { label: "stages", value: String(count || 0) },
          ],
      note,
      opener,
    });
    return model;
  }

  // One assignment press: the pipeline and stage the selects hold, or `clear`. It writes through the QUEUE's route (the
  // record's one door), then re-reads the window at the new clock so the stage, its position and its elapsed span come
  // from the record the write just produced — never from the form.
  async function pipeWindowAssign({ clear = false, doc = document } = {}) {
    if (pipeWindowState.busy) return null;
    const card = doc.getElementById(PIPE_CARD_ID);
    if (!card) return null;
    const note = card.querySelector("[data-pipew-assign-note]");
    const pipeSel = card.querySelector("select[data-pipew-pipe]");
    // `select[...]`, not the bare attribute: the stage ROWS carry `data-pipew-stage` too and they are drawn ABOVE the
    // form, so a bare lookup matches the first <li> — whose `.value` is undefined — and the press answers "choose a
    // pipeline and a stage first" for a stage the reader did choose.
    const stageSel = card.querySelector("select[data-pipew-stage]");
    const body = clear
      ? { clear: true }
      : { pipeline: pipeSel ? pipeSel.value : "", stage: stageSel ? stageSel.value : "" };
    if (!clear && (!body.pipeline || !body.stage)) {
      if (note) note.textContent = "choose a pipeline and a stage first";
      return null;
    }
    const { assistantId, taskId, opener } = pipeWindowState;
    if (!assistantId || !taskId) return null;
    pipeWindowState.busy = true;
    if (note) note.textContent = clear ? "clearing…" : "assigning…";
    // The card is repainted by the re-read, so a busy note is a status on the form, not a lock on the dialog: Esc still
    // closes it, and the write already sent is the server's to finish.
    try {
      const out = await queueAct(assistantId, "pipeline", { id: taskId, ...body });
      if (!out) {
        if (note) note.textContent = "the panel refused the change — see the error above";
        return null;
      }
      await openTaskPipelineWindow(assistantId, taskId, opener);
      // A successful assignment/clear is a QUEUE write, and any surface drawing a task's place from the queue has just
      // gone stale. One event on the document, carrying only the ids the window already holds: the Settings > Bundles
      // tab listens for it and re-reads when it is the tab on screen. A page with no such listener ignores it.
      try {
        document.dispatchEvent(new CustomEvent("wtgui:task-pipeline-assigned", { detail: { assistantId, taskId } }));
      } catch {
        /* an environment without CustomEvent (a stub document in a unit test) needs no notice */
      }
      return out;
    } finally {
      pipeWindowState.busy = false;
    }
  }

  // Delegated on the float (the pane is rebuilt on every change, so a per-row listener would die with it) and on the
  // dialog's own host for the keys. `capture` on the press is what keeps the row body's console opener from also firing:
  // one press, one window.
  function pipeWindowWire() {
    // The FLOW press is the row's own: capture, and stop before the row body's console opener can read it too. Two
    // presses on one row must never do two things.
    as$("assistant")?.addEventListener(
      "click",
      (e) => {
        const btn = e.target?.closest?.("[data-as-qflow]");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        void openTaskPipelineFlow(btn.dataset.asQown, btn.dataset.asQflow, btn);
      },
      true,
    );
    as$("assistant")?.addEventListener(
      "click",
      (e) => {
        const btn = e.target?.closest?.("[data-as-qpipe]");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        void openTaskPipelineWindow(btn.dataset.asQown, btn.dataset.asQpipe, btn);
      },
      true,
    );
    const host = document.getElementById(PIPE_WINDOW_ID);
    host?.addEventListener("keydown", (e) => {
      if (pipeWindowKey(e)) return;
    });
    // Choosing another pipeline redraws the stage list from THAT pipeline. A native select's change is the press; the
    // first paint and this handler share `pipeWindowStageOptions`, so the two can never offer different stages.
    host?.addEventListener("change", (e) => {
      const sel = e.target?.closest?.("[data-pipew-pipe]");
      if (!sel) return;
      // The same qualification as the assignment press: the stage rows carry this attribute too, and repainting the
      // first <li>'s innerHTML would replace the row the reader is looking at with a list of <option> elements.
      const stageSel = document.getElementById(PIPE_CARD_ID)?.querySelector?.("select[data-pipew-stage]");
      if (stageSel) stageSel.innerHTML = pipeWindowStageOptions(pipeWindowState.catalogue, sel.value, "");
    });
    // A press on the backdrop or the ✕ closes it; a press inside the card does not. The two assignment presses are the
    // card's own and are handled before the close test, so a press on them never reads as a backdrop press.
    host?.addEventListener("click", (e) => {
      if (e.target?.closest?.("[data-pipew-apply]")) {
        e.preventDefault();
        void pipeWindowAssign();
        return;
      }
      if (e.target?.closest?.("[data-pipew-clear]")) {
        e.preventDefault();
        void pipeWindowAssign({ clear: true });
        return;
      }
      if (e.target === host || e.target?.closest?.("[data-pipew-close]")) {
        e.preventDefault();
        pipeWindowClose();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pipeWindowTick(document);
    });
  }

  // ---- end the task pipeline window -------------------------------------------------------------

  // ---- talking to the server -------------------------------------------------------------------

  async function asPost(route, body = {}, { timeoutMs } = {}) {
    // A spawn includes `git worktree add`, which is slower than any other call here; the default 20 s would
    // read as a failure while the tree was still being cut.
    const r = await apiFetch(
      route,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs ? { timeoutMs } : {},
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    if (d.assistant) applyAssistant(d.assistant);
    if (d.job) updateJob(d.job, { scroll: true });
    return d;
  }

  // The charter's save is a PUT: it replaces the whole file rather than patching a field, and the route
  // answers 413 when the body is over the cap and 409 when someone else wrote the file since it was loaded.
  async function asPut(route, body = {}) {
    const r = await apiFetch(route, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    if (d.assistant) applyAssistant(d.assistant);
    return d;
  }

  function setErr(sel, message) {
    const el = as$(sel) || document.querySelector(sel);
    if (el) el.textContent = message || "";
  }

  async function say(text, button = null, assistantId = FIRST_ASSISTANT) {
    const t = String(text || "").trim();
    if (!t) return;
    if (button) button.disabled = true;
    try {
      await asPost("/api/assistant/say", { text: t, assistantId });
      // The intro box is gone once the card exists; clear it in case a repaint has not landed yet.
      const box = as$(firstBoxId(assistantId));
      if (box) writeBox(box, "");
      // Sending from the intro lands on the thread it just started: that session's Chat, whichever list was open.
      setView({ assistant: assistantId, subTab: SUBTABS[0] });
    } catch (e) {
      showBanner(`assistant: ${e.message}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  // ---- wiring ---------------------------------------------------------------------------------

  as$("btn-assistant")?.addEventListener("click", () => toggleAssistant());
  // The strip is the board's own copy of the spawn cards, so it lives outside the float and gets its own
  // listener. Its Start is the card's own POST; "Open card" only moves the float, and starts nothing.
  as$("spawn-strip")?.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.spawnStart) {
      startSpawnCard(b.dataset.spawnStart, b);
      return;
    }
    if (b.dataset.spawnReview) {
      openAlertsAt(b.dataset.spawnReview);
      return;
    }
    if (b.id === "btn-spawn-review") openAlertsAt();
  });
  // The aggressive switch is created by aggressiveBlock() and moved into the Settings sub-pane that is on screen;
  // its listener travels with that one element. Alt+Shift+A still throws it from anywhere (see the keys section).
  as$("btn-as-close")?.addEventListener("click", () => toggleAssistant(false));
  as$("as-tabs")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-as-tab]");
    if (!b) return;
    const id = b.dataset.asTab;
    // A session tab keeps the sub-tab the reader left on it: Chat and Settings are the same assistant, and stepping
    // out to Alerts and back must not move them.
    if (isAssistant(id) && state.assistantView.subTab === "chat") chatPinned = true;
    setView({ assistant: id });
  });

  // The session's own row. Chat is a jump to the newest turn: the reader stepped out to look at a rule, and coming
  // back to a scroll position that is no longer where the conversation is helps nobody.
  as$("as-subtabs")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-as-subtab]");
    if (!b) return;
    if (b.dataset.asSubtab === "chat") chatPinned = true;
    setView({ subTab: b.dataset.asSubtab });
  });

  // A ➡️ picker closes on the reader's own gestures: Esc, or a press anywhere outside it. Both are capture-phase and
  // registered before the press that opens one, so a press on another row's ➡️ shuts this list first and the button's
  // own handler then opens that one. Esc stops here while a picker is up: dismissing a list must not also close the rail
  // it lives in, which the keys handler below would do because a picker press leaves the caret inside the rail.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!qmoveOpen.size) return;
      if (e.target && e.target.closest && e.target.closest(".as-qmove-wrap")) return;
      closeQueueMove();
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !qmoveOpen.size) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeQueueMove();
    },
    true,
  );
  // A sub-row is a div with role=button, because a <button> may not hold the COMPLETE pill (that one is a button too).
  // Enter and Space are what the role promises, so they are honoured here or the role is a lie.
  as$("assistant")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const target = e.target && e.target.closest ? e.target.closest('.as-task-agent[role="button"]') : null;
    if (!target || (e.target.closest && e.target.closest("button"))) return;
    e.preventDefault();
    openAgentTurn(target.dataset.asQopen);
  });

  as$("assistant")?.addEventListener("click", async (e) => {
    // A queue row is a console row, so its whole body opens something — and the sub-rows are divs, not buttons, which
    // is why this is asked BEFORE the button lookup below. A sub-row opens THAT agent (its own thread); anywhere else
    // on the task's body opens the agent carrying it now. Controls keep their own presses: the check excludes every
    // button, the picker's own menu, the add form's fields and the labels around them.
    const opener = e.target.closest("[data-as-qopen]");
    if (opener) {
      e.preventDefault();
      openAgentTurn(opener.dataset.asQopen);
      return;
    }
    const taskRow = e.target.closest(".as-task");
    if (taskRow && !e.target.closest("button, a, input, select, textarea, label, .as-qmove-pop, summary, .as-task-more")) {
      const thread = String(taskRow.dataset.asQthread || "");
      if (thread) {
        e.preventDefault();
        openAgentTurn(thread);
      }
      return;
    }
    const t = e.target.closest("button");
    if (!t) return;
    // Tabs are buttons too and are handled above, in their own rows; ignore a second pass here.
    if (t.dataset.asTab || t.dataset.asSubtab) return;

    // The reminder list's own presses: add, complete or reopen one, delete one. Each answer is the WHOLE list, so
    // the pane repaints from one truth rather than splicing a row in locally and drifting from the file.
    if (t.id === "btn-as-bridge-reminder-add") {
      const text = String(document.querySelector("#as-bridge-reminder-text")?.value || "").trim();
      const due = String(document.querySelector("#as-bridge-reminder-due")?.value || "").trim();
      if (!text) {
        setErr("as-bridge-reminder-err", "a reminder needs some text");
        return;
      }
      t.disabled = true;
      try {
        const d = await asPost("/api/matrix/reminders", due ? { text, due } : { text });
        bridgeData = { ...bridgeData, reminders: d };
        setErr("as-bridge-reminder-err", "");
        renderBridge(true);
      } catch (err) {
        setErr("as-bridge-reminder-err", String((err && err.message) || err));
        t.disabled = false;
      }
      return;
    }
    if (t.dataset.asBridgeReminder) {
      const id = t.dataset.asBridgeReminder;
      const act = t.dataset.asBridgeAct;
      if (!id || !act) return;
      t.disabled = true;
      try {
        const d = await asPost("/api/matrix/reminders", act === "remove" ? { id, remove: true } : { id, done: act === "done" });
        bridgeData = { ...bridgeData, reminders: d };
        setErr("as-bridge-reminder-err", "");
        renderBridge(true);
      } catch (err) {
        setErr("as-bridge-reminder-err", String((err && err.message) || err));
        if (t.isConnected) t.disabled = false;
      }
      return;
    }

    // The Bridge tab's three policy presses. Refresh re-reads everything and keeps a policy draft; Reload is the one
    // press that drops a draft and reads the file again; Save sends the box with the mtime the page read.
    if (t.id === "btn-as-bridge-refresh") {
      t.disabled = true;
      try {
        await refreshBridge();
      } finally {
        t.disabled = false;
      }
      return;
    }
    if (t.id === "btn-as-bridge-policy-reload") {
      bridgeDraft = null;
      bridgeSavedNote = "";
      await loadBridge(true);
      renderBridge(true);
      return;
    }
    if (t.id === "btn-as-bridge-policy-save") {
      await saveBridgePolicy(t);
      return;
    }

    // The Alerts pane's scope: this assistant's own list, or the whole board. The choice belongs to the PANE the chip
    // sits in (`data-as-alertfor`), so widening #2's list to All leaves #1's exactly as it was; the sub-tab's count and
    // the header badges follow the SELECTED assistant, which renderAssistant() repaints. The board's spawn strip is
    // every assistant's and never narrows, so it is not repainted here at all.
    if (t.dataset.asAlertwho) {
      const forId = isAssistant(t.dataset.asAlertfor) ? t.dataset.asAlertfor : selectedSessionId();
      if (t.dataset.asAlertwho === "all") alertAll.add(forId);
      else alertAll.delete(forId);
      if (forId === selectedSessionId()) {
        renderAssistant();
        paintAssistantBadge();
      }
      renderAssistantAlerts(true, forId);
      return;
    }

    // The message board's own controls: whose messages, which direction, and an entry's expander. None is a
    // round trip — the board is already on the page — so all three are a repaint of this pane alone.
    if (t.dataset.asMsgwho) {
      const forId = isAssistant(t.dataset.asMsgfor) ? t.dataset.asMsgfor : selectedSessionId();
      if (t.dataset.asMsgwho === "all") msgAll.add(forId);
      else msgAll.delete(forId);
      renderAssistantMessages(forId);
      return;
    }
    if (t.dataset.asMsgdir) {
      msgDir = t.dataset.asMsgdir;
      renderAssistantMessages();
      return;
    }
    if (t.dataset.asMsgMore) {
      const id = t.dataset.asMsgMore;
      if (msgOpen.has(id)) msgOpen.delete(id);
      else msgOpen.add(id);
      renderAssistantMessages();
      return;
    }

    if (t.dataset.asOpen) {
      openAgentThread(t.dataset.asOpen);
      return;
    }

    // The queue row's ➡️: one picker at a time, remembered in `qmoveOpen` so the next repaint of the pane keeps it open
    // and pressing it again closes it.
    if (t.dataset.asQmoveOpen) {
      toggleQueueMove(t.dataset.asQmoveOpen);
      return;
    }

    if (t.dataset.asAction) {
      t.disabled = true;
      try {
        await asPost("/api/assistant/alert", { id: t.dataset.id, action: t.dataset.asAction });
        renderAssistantAlerts(true);
        // "Ask" hands the question to the thread: land on the session's Chat so the reply box is what they see.
        if (t.dataset.asAction === "ask") setView({ assistant: FIRST_ASSISTANT, subTab: SUBTABS[0] }, { render: false });
        renderAssistant();
      } catch (err) {
        const slot = document.querySelector(`[data-as-err="${CSS.escape(t.dataset.id || "")}"]`);
        if (slot) slot.textContent = err.message;
      } finally {
        t.disabled = false;
      }
      return;
    }

    // The card's Start, and the strip's, are one function: the same POST, the same 150 s budget (a worktree
    // cut is slower than apiFetch's 20 s default), the same error landing where the reader is looking.
    if (t.dataset.asSpawn) {
      startSpawnCard(t.dataset.asSpawn, t);
      return;
    }

    // A parked question: the answer settles the prompt the run is holding, so it unblocks the agent instead
    // of stacking a reply behind it. A typed answer wins over ticks, exactly like the card's own box.
    if (t.dataset.asQchoice || t.dataset.asQsend) {
      const id = t.dataset.asQchoice || t.dataset.asQsend;
      const box = document.querySelector(`[data-as-qtext="${CSS.escape(id)}"]`);
      const typed = String(box?.value || "").trim();
      let answer = t.dataset.asQchoice ? t.dataset.choice : typed;
      if (!answer) {
        const picks = parkedPicks.get(id);
        const alert = (state.assistant?.alerts || []).find((x) => x.id === id);
        if (picks?.size && alert) {
          answer = [...picks]
            .sort((a, b) => a - b)
            .map((i) => (alert.choices || [])[i])
            .filter(Boolean);
        }
      }
      if (!answer || (Array.isArray(answer) && !answer.length)) return;
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/answer-question", { id, answer });
        parkedPicks.delete(id);
        if (d.assistant) applyAssistant(d.assistant);
        else renderAssistantAlerts(true);
        renderAssistant();
      } catch (err) {
        const slot = document.querySelector(`[data-as-err="${CSS.escape(id)}"]`);
        if (slot) slot.textContent = err.message;
      } finally {
        t.disabled = false;
      }
      return;
    }

    // An alert's "Send reply" is the ONLY send that carries a thread: it answers a parked question on that
    // thread. The intro box's Send starts a NEW turn on the assistant's own thread and carries no thread, so this
    // branch must not claim it — it did, found no `[data-as-draft]` box for the assistant's id, read empty text and
    // returned, so the intro branch below was unreachable and the press did nothing at all (no request, no error).
    if (t.dataset.asSend && t.dataset.thread) {
      const id = t.dataset.asSend;
      const box = document.querySelector(`[data-as-draft="${CSS.escape(id)}"]`);
      const text = String(box?.value || "").trim();
      if (!text) return;
      t.disabled = true;
      try {
        await asPost("/api/assistant/answer", { thread: t.dataset.thread, text, alertId: id });
        renderAssistantAlerts(true);
        renderAssistant();
      } catch (err) {
        const slot = document.querySelector(`[data-as-err="${CSS.escape(id)}"]`);
        if (slot) slot.textContent = err.message;
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.dataset.asUnwatch) {
      t.disabled = true;
      try {
        await asPost("/api/assistant/watch/remove", { id: t.dataset.asUnwatch });
        renderAssistantWatches(true);
      } catch (err) {
        setErr("as-w-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.dataset.asUnrule) {
      // A rule on another assistant's record names that assistant; #1's rules are the ones in the Scratchpad.
      const forId = t.dataset.asRulefor || "";
      t.disabled = true;
      try {
        await asPost("/api/assistant/rule/remove", { id: t.dataset.asUnrule, ...(forId ? { assistantId: forId } : {}) });
        // The pane that owns the rule is the one that repaints: #1's list is in the Scratchpad, another assistant's
        // is in its own Settings.
        if (forId) renderAssistantSettings(forId, true);
        else renderAssistantPad(true);
      } catch (err) {
        setErr(forId ? `as-rules-err-${String(forId).replace(/^assistant-/, "")}` : padId("as-pad-err", selectedSessionId()), err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    // The escalation list: add, remove, and move one place. One POST of the whole ordered list — the file holds an
    // ORDER, so a move is a list rather than a field. Nothing reads it yet, and the pane says so.
    if (t.dataset.asEscadd || t.dataset.asEscdel || t.dataset.asEscmove) {
      const own = t.dataset.asEscown || t.dataset.asEscadd || FIRST_ASSISTANT;
      const cur = [...((state.assistant?.escalateTo || {})[own] || [])];
      if (t.dataset.asEscadd) {
        const pick = as$(`as-esc-pick-${String(own).replace(/^assistant-/, "")}`);
        const id = String(pick?.value || "").trim();
        if (!id || cur.includes(id)) return;
        cur.push(id);
      } else if (t.dataset.asEscdel) {
        const i = cur.indexOf(t.dataset.asEscdel);
        if (i < 0) return;
        cur.splice(i, 1);
      } else {
        const i = cur.indexOf(t.dataset.asEscid);
        const j = t.dataset.asEscmove === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= cur.length) return;
        [cur[i], cur[j]] = [cur[j], cur[i]];
      }
      t.disabled = true;
      try {
        await asPost("/api/assistant/profile", { assistantId: own, escalateTo: cur });
        renderAssistantSettings(own, true);
      } catch (err) {
        setErr("as-set-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.dataset.asSend) {
      // readBox: a chip pasted into the intro box is the text it swallowed. The button carries WHICH assistant —
      // #1 keeps its own id, a second one has its own box and its own thread.
      const id = t.dataset.asSend;
      await say(readBox(as$(firstBoxId(id))), t, id);
      return;
    }

    if (t.id === "btn-as-watch") {
      const thread = as$("as-w-thread")?.value;
      const title = String(as$("as-w-title")?.value || "").trim();
      const minutes = Number(as$("as-w-min")?.value) || null;
      if (!thread || !title) return setErr("as-w-err", "pick an agent and say what to watch for");
      t.disabled = true;
      try {
        // The watch belongs to the assistant the tab is showing: the server stamps it from this id, so it lands in
        // THAT assistant's list and its notice wakes that assistant, not #1.
        await asPost("/api/assistant/watch", { thread, title, minutes, assistantId: frameSessionId() });
        renderAssistantWatches(true);
      } catch (err) {
        setErr("as-w-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-rule" || t.dataset.asPadrule) {
      // The form belongs to the pane it sits in: `data-as-padrule` names that assistant, so #2's form reads #2's box.
      const who = isAssistant(t.dataset.asPadrule) ? t.dataset.asPadrule : selectedSessionId();
      const text = String(as$(padId("as-rule-text", who))?.value || "").trim();
      if (!text) return;
      t.disabled = true;
      try {
        await asPost("/api/assistant/rule", { text });
        renderAssistantPad(true, who);
      } catch (err) {
        setErr(padId("as-pad-err", who), err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-notes" || t.dataset.asPadsave) {
      const who = isAssistant(t.dataset.asPadsave) ? t.dataset.asPadsave : selectedSessionId();
      const text = String(as$(padId("as-notes", who))?.value || "");
      t.disabled = true;
      try {
        // The save goes to the assistant the pad is showing. #1 keeps its store's string; an extra assistant writes
        // its own notes.md, and the answer carries the text it actually kept (the cap trims the oldest lines).
        const d = await asPost("/api/assistant/notes", { text, assistantId: who });
        // The answer carries the whole assistant state beside the pad; the cache keeps only the pad.
        if (who !== FIRST_ASSISTANT) padNotes.set(who, { ...d, assistant: undefined, at: Date.now() });
        renderAssistantPad(true, who);
      } catch (err) {
        setErr(padId("as-pad-err", who), err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-role") {
      const target = roleTargetSession();
      const text = String(as$("as-role-text")?.value ?? "");
      // The panel refuses an over-cap save WHOLE (413) and writes nothing, so it is not sent: the warning between the
      // box and the buttons already names the numbers, and a press that only turns that sentence into an error is
      // the wait this check exists to save. Save is disabled in the same state; this guard covers a keyboard press.
      const cap = roleCap || 0;
      if (cap && text.length > cap) {
        setErr("as-role-err", `the charter is ${text.length} characters and the cap is ${cap} — prune the oldest changelog entries first`);
        paintRoleBox();
        return;
      }
      t.disabled = true;
      try {
        const d = await asPut("/api/assistant/role", { assistantId: target, text, expectMtime: roleMtime });
        roleText = String(d.charter?.text ?? text);
        roleMtime = Number.isFinite(Number(d.charter?.mtime)) ? Number(d.charter.mtime) : null;
        roleInfo = { ...(roleInfo || {}), sameAsRole: Boolean(d.sameAsRole), charter: d.charter };
        // What the box held (a typed draft, or the role's own text) is now this assistant's copy on disk.
        roleHolds = "copy";
        roleDraft = null;
        roleAsk = null;
        roleCap = Number(d.charter?.cap) || roleCap;
        roleLoaded = true;
        roleLoadedAt = Date.now();
        setErr("as-role-err", "");
        renderAssistantRole(true);
      } catch (err) {
        // A stale save (409) and an over-cap save (413) both land here as the server's own words: the reader
        // is told what to do about it rather than that something went wrong.
        setErr("as-role-err", err.message);
      } finally {
        t.disabled = false;
        paintRoleBox();
      }
      return;
    }

    if (t.id === "btn-as-role-reload") {
      // Reload is a read that REPLACES the box, so typed words get the same inline question a pick does instead of
      // vanishing under a press meant to refresh the file.
      if (roleDirty()) {
        roleAsk = { kind: "reload", roleId: rolePick, name: roleInfo?.role?.name || "" };
        renderAssistantRole(true);
        return;
      }
      t.disabled = true;
      try {
        await loadRole(roleTargetSession());
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-role-adopt") {
      const target = roleTargetSession();
      const pick = String(as$("as-role-pick")?.value || rolePick || "");
      if (!pick) return;
      // Replacing a copy the reader has edited is their decision, not a side effect of picking a role — and the
      // question is asked INLINE, in the tab: a browser dialog would sit over the words it is asking about.
      if (roleDirty() || (roleLoaded && roleInfo?.sameAsRole === false)) {
        const name = String(as$("as-role-pick")?.selectedOptions?.[0]?.textContent || roleInfo?.role?.name || pick).trim();
        roleAsk = { kind: "adopt", roleId: pick, name };
        renderAssistantRole(true);
        return;
      }
      t.disabled = true;
      try {
        await adoptRole(target, pick);
      } catch (err) {
        setErr("as-role-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    // The inline row's two answers. "Keep mine" changes nothing at all: the box keeps the reader's text, the picker
    // returns to the role the assistant actually runs (the pick never reached the server), and the description line
    // stays with the text on screen.
    if (t.dataset.asRoleask) {
      const asked = roleAsk;
      const answer = String(t.dataset.asRoleask);
      roleAsk = null;
      if (!asked || answer !== "use") {
        renderAssistantRole(true);
        return;
      }
      t.disabled = true;
      try {
        if (asked.kind === "pick") await pickRoleAndLoad(roleTargetSession(), asked.roleId);
        else if (asked.kind === "adopt") await adoptRole(roleTargetSession(), asked.roleId);
        else if (asked.kind === "target") {
          // The switch the reader confirmed: now the old assistant's text is dropped and the new one's copy read.
          roleTarget = asked.roleId;
          rolePick = "";
          roleInfo = null;
          roleText = null;
          roleMtime = null;
          roleLoaded = false;
          roleHolds = "copy";
          roleDraft = null;
          roleCap = 0;
          void loadRole(roleTarget);
          renderAssistantRole(true);
        } else await loadRole(roleTargetSession());
      } catch (err) {
        setErr("as-role-err", err.message);
        renderAssistantRole(true);
      } finally {
        t.disabled = false;
      }
      return;
    }

    // The default role prompt: one press, one file. The box's own text is what is saved — never the state variable,
    // which a repaint in between could have moved — and the response's assistant state is applied so the pane and
    // the board agree about how much is saved.
    if (t.id === "btn-as-prompt") {
      const target = roleTargetSession();
      const text = String(as$("as-prompt-text")?.value ?? "");
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/profile", { assistantId: target, prompt: text });
        if (d.assistant) applyAssistant(d.assistant);
        // The box shows what the FILE holds: the server caps the prompt, so a paste over the cap is stored as its
        // first `promptChars` characters and the box would otherwise claim to have saved more than it did.
        rolePrompt = text.slice(0, Number(d.profile?.promptChars ?? text.length));
        setErr("as-prompt-err", "");
        renderAssistantRole(true);
      } catch (err) {
        setErr("as-prompt-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-new-assistant") {
      const pick = String(as$("as-role-pick")?.value || rolePick || "");
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/assistants", { roleId: pick });
        const id = d.created?.id || "";
        showBanner(`assistant: ${d.created?.name || "a new assistant"} is up — thread ${d.created?.threadId || "?"}, its own charter and rules`);
        // Land the reader on the thing they just made: its own tab, its own Chat, its own intro box.
        if (id) setView({ assistant: id, subTab: SUBTABS[0] });
        else renderAssistantRole(true);
      } catch (err) {
        setErr("as-role-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-role-newrole") {
      const name = String(as$("as-role-name")?.value || "").trim();
      if (!name) {
        setErr("as-role-newerr", "name the role first");
        return;
      }
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/roles", { name, from: String(as$("as-role-pick")?.value || rolePick || "") });
        roleRoles = Array.isArray(d.roles) ? d.roles : roleRoles;
        rolePick = d.role?.id || rolePick;
        const box = as$("as-role-name");
        if (box) box.value = "";
        setErr("as-role-newerr", "");
        renderAssistantRole(true);
      } catch (err) {
        setErr("as-role-newerr", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.dataset.asAddrule) {
      // `data-as-addrule` lowercases to `dataset.asAddrule` — reading `asAddRule` was always undefined, so the press
      // fell through to the branches below it and added nothing.
      const id = t.dataset.asAddrule;
      const n = String(id).replace(/^assistant-/, "");
      const box = as$(`as-rules-text-${n}`);
      const text = String(box?.value || "").trim();
      if (!text) return;
      t.disabled = true;
      try {
        await asPost("/api/assistant/rule", { text, assistantId: id });
        if (box) box.value = "";
        renderAssistantSettings(id, true);
      } catch (err) {
        setErr(`as-rules-err-${n}`, err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-aggressive-off") {
      t.disabled = true;
      try {
        await setAggressiveMode(false);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-check") {
      t.disabled = true;
      try {
        await asPost("/api/assistant/check");
        renderAssistant();
      } catch (err) {
        setErr("as-set-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-wake") {
      await say("What do you see on the board right now? Keep it to a few lines.", t);
      return;
    }
  });

  // A draft with no confident text starts with Send disabled (there is nothing to send); the moment the reader
  // writes an answer the button has to come alive, or the alert reads "write one" and then refuses it.
  as$("assistant")?.addEventListener("input", (e) => {
    // The Bridge policy box: remember the draft outside the DOM (a poll paints it back, never over it) and repaint
    // the size and the Save button in place. A full render here would rebuild the textarea and take the caret.
    const bridgeBox = e.target.closest?.("#as-bridge-policy-text");
    if (bridgeBox) {
      const loaded = String(bridgeData?.policy?.text ?? "");
      bridgeDraft = bridgeBox.value === loaded ? null : bridgeBox.value;
      bridgeSavedNote = "";
      const note = document.querySelector("[data-as-bridge-note]");
      if (note) note.textContent = "";
      bridgePolicyPaint();
      return;
    }
    // The charter box: remember the draft outside the DOM (a repaint paints it back) and repaint the cap, the
    // provenance line and Save in place. No full render here — it would take the caret out of a 20 KB document.
    const charter = e.target.closest?.("#as-role-text");
    if (charter) {
      roleDraft = charter.value === String(roleText ?? "") ? null : charter.value;
      paintRoleBox();
      return;
    }
    // A typed answer to a parked question: the Send button has to come alive as soon as there is one, or the
    // box reads "type your answer" and then refuses it.
    const q = e.target.closest?.("[data-as-qtext]");
    if (q) {
      const id = q.dataset.asQtext;
      const btn = document.querySelector(`[data-as-qsend="${CSS.escape(id)}"]`);
      if (btn) btn.disabled = !String(q.value || "").trim() && !parkedPicks.get(id)?.size;
      return;
    }
    const box = e.target.closest?.("[data-as-draft]");
    if (!box) return;
    const btn = document.querySelector(`[data-as-send="${CSS.escape(box.dataset.asDraft)}"]`);
    if (btn) btn.disabled = !String(box.value || "").trim();
  });

  // Ticks on a multi-select question are kept outside the DOM so a repaint cannot erase them, and Send is
  // enabled by a tick the same way it is by a typed answer.
  as$("assistant")?.addEventListener("change", (e) => {
    const box = e.target.closest?.("[data-as-qpick]");
    if (!box) return;
    const id = box.dataset.asQpick;
    const i = Number(box.dataset.qindex);
    const set = parkedPicks.get(id) || new Set();
    if (box.checked) set.add(i);
    else set.delete(i);
    if (set.size) parkedPicks.set(id, set);
    else parkedPicks.delete(id);
    box.closest(".as-qcheck")?.classList.toggle("on", box.checked);
    const typed = String(document.querySelector(`[data-as-qtext="${CSS.escape(id)}"]`)?.value || "").trim();
    const btn = document.querySelector(`[data-as-qsend="${CSS.escape(id)}"]`);
    if (btn) btn.disabled = !set.size && !typed;
  });

  // Settings apply the moment they change: a threshold that needs a Save button is a threshold the reader
  // will believe is live when it is not.
  as$("assistant")?.addEventListener("change", async (e) => {
    const el = e.target;
    // `data-as-roletarget` and `data-as-role-pick` are VALUELESS attributes, so their dataset entries are the empty
    // string — which is falsy. Testing them for truthiness left both selects dead: the picker moved nothing and the
    // target selector never changed which assistant the tab was editing. Presence, not truth, is what says they fired.
    if (el.dataset.asRoletarget !== undefined) {
      // Which assistant the Role tab is editing. Its charter is a different file, so the text is dropped and read
      // again rather than painted under the new name — but a DIRTY box is the reader's words about to go, so that
      // switch gets the same inline question the picker does.
      const nextTarget = String(el.value || "");
      if (nextTarget === roleTargetSession()) return;
      if (roleDirty()) {
        const name = String(el.selectedOptions?.[0]?.textContent || nextTarget).trim();
        roleAsk = { kind: "target", roleId: nextTarget, name };
        renderAssistantRole(true);
        return;
      }
      roleTarget = nextTarget;
      rolePick = "";
      roleInfo = null;
      roleText = null;
      roleMtime = null;
      roleLoaded = false;
      roleHolds = "copy";
      roleDraft = null;
      roleAsk = null;
      roleCap = 0;
      void loadRole(roleTarget);
      renderAssistantRole(true);
      return;
    }
    if (el.dataset.asRolePick !== undefined) {
      // The picker now loads the picked ROLE'S OWN charter into the box, not just its title: leaving the previous
      // role's text under the new role's name is the disagreement this change exists to end. The pick is
      // `adopt:false`, so Save is still the press that writes this assistant's copy.
      const target = roleTargetSession();
      const nextId = String(el.value || "");
      const current = rolePick || roleInfo?.role?.id || "";
      if (nextId === current) {
        roleAsk = null;
        renderAssistantRole(true);
        return;
      }
      // Typed words are the reader's, and a select change must not silently discard them: ask in the tab, keep the
      // text on screen, and only post the pick once they choose. The picker LOOKS moved while the question waits,
      // because that is the change they made; "Keep mine" puts it back.
      if (roleDirty()) {
        const name = String(el.selectedOptions?.[0]?.textContent || nextId).trim();
        roleAsk = { kind: "pick", roleId: nextId, name };
        renderAssistantRole(true);
        return;
      }
      try {
        await pickRoleAndLoad(target, nextId);
      } catch (err) {
        setErr("as-role-err", err.message);
        renderAssistantRole(true);
      }
      return;
    }
    if (el.dataset.asDock) {
      // The FRAME: one assistant's own field, saved through the profile route beside its prompt and its escalation
      // list — the same per-assistant file, not assistant.json and not the panel. The answer carries the whole state,
      // so the panel re-frames through `applyFrame` before this repaint draws the row's new value.
      const own = el.dataset.asDock;
      const n = String(own).replace(/^assistant-/, "");
      try {
        await asPost("/api/assistant/profile", { assistantId: own, dock: el.value });
        setErr(`as-dock-err-${n}`, "");
      } catch (err) {
        setErr(`as-dock-err-${n}`, err.message);
      }
      // Either way the pane is repainted from the stored value: a failed save puts the select back rather than
      // leaving the control claiming a mode the file never took.
      renderAssistantSettings(own, true);
      return;
    }
    if (el.dataset.asSet) {
      const key = el.dataset.asSet;
      // WHICH assistant this knob belongs to: #1's pane carries no id and posts exactly as it always has; a second
      // assistant's pane carries its own id, so its settings land in its own file and #1's are not touched.
      const forId = el.dataset.asFor || "";
      const value = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
      try {
        await asPost("/api/assistant/settings", { [key]: value, ...(forId ? { assistantId: forId } : {}) });
        // asPost already applied the assistant state its answer carried, so this repaint reads the stored value.
        // The pane that OWNS the key is the one repainted: the watchdog's keys are the panel's, an assistant's are its
        // own — and a key is never drawn in both, so one repaint is always enough.
        if (ownsWatchdog(key)) renderWatchdog(true);
        else renderAssistantSettings(forId || FIRST_ASSISTANT, true);
      } catch (err) {
        setErr(ownsWatchdog(key) ? "as-watchdog-err" : "as-set-err", err.message);
      }
      return;
    }
    if (el.dataset.asRule) {
      try {
        // The escalation table is the panel's one watchdog's (one value for the board), so its repaint is that pane's.
        await asPost("/api/assistant/settings", { rules: { [el.dataset.asRule]: el.value } });
        renderWatchdog(true);
      } catch (err) {
        setErr("as-watchdog-err", err.message);
      }
    }
  });

  // ---- the queue's controls ----------------------------------------------------------------------
  // The pane is rebuilt on every change, so the controls are delegated on the float rather than bound per row: a row
  // that vanished under a click cannot leave a dead listener behind. `data-as-qown` is WHICH assistant's queue the
  // control belongs to — a second assistant's pane must never write to Assistant #1's file — and `data-as-qid` is the
  // task. The add form reads its three fields from the pane's own ids, so a repaint cannot cross-wire two assistants'
  // forms.
  as$("assistant")?.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-as-qact]");
    if (!t) return;
    const own = t.dataset.asQown;
    const action = t.dataset.asQact;
    if (!own) return;
    const n = String(own).replace(/^assistant-/, "");
    if (action === "reload") {
      t.disabled = true;
      try {
        // A refresh is the reader asking the file for the truth: the line a refused drop left is about the order the
        // pane had before this read, so it does not survive it.
        queueDropNotes.delete(own);
        await loadQueue(own);
        renderAssistantQueue(own);
      } finally {
        t.disabled = false;
      }
      return;
    }
    if (action === "pipeline") {
      // Where a task's pipeline comes from is the Settings Pipeline tab, so this press is that tab's own two calls —
      // toggleSettings(true) opens a closed Settings (and keeps an open one open), selectSettingsTab("pipeline") lands
      // it on Pipeline whatever tab it was showing. No route of its own and no second copy of the tab logic.
      //
      // The press must not ALSO reach app.js's document listener that closes Settings on a click outside it — this
      // button IS outside it — so it stops propagating exactly as the panel's own two openers (#btn-settings, the
      // title) do. Without this the window opens and is closed again inside the same click.
      e.stopPropagation();
      toggleSettings(true);
      selectSettingsTab("pipeline");
      return;
    }
    if (action === "add") {
      const titleEl = as$(`as-qtitle-${n}`);
      const detailEl = as$(`as-qdetail-${n}`);
      const filesEl = as$(`as-qfiles-${n}`);
      // No owner picker: the owner IS the assistant whose page this is. A task is created into the queue the reader
      // is looking at, and the only way it changes hands is the explicit Move control on an existing row.
      const title = String(titleEl?.value || "").trim();
      if (!title) {
        setErr(`as-qerr-${n}`, "a task needs a title");
        titleEl?.focus();
        return;
      }
      t.disabled = true;
      try {
        await queueAct(own, "add", {
          title,
          detail: String(detailEl?.value || "").trim(),
          files: String(filesEl?.value || "").trim(),
          owner: own,
        });
      } finally {
        t.disabled = false;
      }
      return;
    }
    if (action === "reassign") {
      // The assistant is ON the pressed item (`data-as-qmove-to`) — the always-visible <select> that used to sit beside a
      // Move button is gone, and a name in the ➡️ popover IS the choice. The row's own owner is what the task IS; this
      // is where it is going, and the route records the hand-over on the task as movedFrom.
      const owner = String(t.dataset.asQmoveTo || "").trim();
      if (!owner) return setErr(`as-qerr-${n}`, "pick the assistant to move it to");
      closeQueueMove();
      t.disabled = true;
      try {
        await queueAct(own, "reassign", { id: Number(t.dataset.asQid), owner });
      } finally {
        t.disabled = false;
      }
      return;
    }
    if (action === "delete") {
      t.disabled = true;
      try {
        await queueAct(own, "delete", { id: Number(t.dataset.asQid) });
      } finally {
        t.disabled = false;
      }
      return;
    }
    if (["queued", "running", "parked", "done"].includes(action)) {
      t.disabled = true;
      try {
        await queueAct(own, "state", { id: Number(t.dataset.asQid), state: action });
      } finally {
        t.disabled = false;
      }
      return;
    }
  });

  // ---- the queue cards' drag ----------------------------------------------------------------------
  // Delegated from the float, exactly like the controls above: the pane is rebuilt on every change, so a listener
  // bound per card would die with the node it was bound to. `pointercancel` is the browser taking the gesture back (a
  // touch scroll), and it ends the drag the same way a release does. The guard is CAPTURE, because the row body's
  // opener is a bubble listener on this same element and the click a drag leaves behind must never reach it.
  //
  // A fresh PRESS is what tells the two clicks apart: the one a drag leaves behind arrives with no pointerdown of its
  // own, so any new press clears the stamp and its click belongs to the reader.
  as$("assistant")?.addEventListener("pointerdown", (e) => {
    queueDragEnded = 0;
    queueCardDown(e);
  });
  window.addEventListener("pointermove", queueCardMove);
  window.addEventListener("pointerup", () => void queueCardUp(false));
  window.addEventListener("pointercancel", () => void queueCardUp(true));
  as$("assistant")?.addEventListener("click", queueCardClickGuard, true);

  // The watch countdown: one tick a second, painting only the clocks on screen. It returns immediately when the
  // panel is closed or another tab is showing, so a board of quiet cards pays nothing for it.
  setInterval(paintWatchClocks, 1000);

  // The message board's read, on the same clock the rest of the panel refreshes on, and only while its tab
  // is the one on screen: a reader of the server's view costs nothing while nobody is looking at it. A
  // repaint is skipped while the reader has text selected in the pane — the board is a thing you read and
  // copy out of, and yanking a selection out from under them every fifteen seconds is worse than a stale
  // relative time.
  setInterval(() => {
    const view = state.assistantView;
    if (!state.assistantOpen || view?.subTab !== "messages" || !isAssistant(view.assistant) || document.hidden) return;
    const host = hostFor(view.assistant, "messages");
    const sel = window.getSelection?.();
    if (host && sel && !sel.isCollapsed && sel.anchorNode && host.contains(sel.anchorNode)) return;
    void loadMessages(true);
  }, MSG_REFRESH_MS);

  // ---- the frame's gestures: the rail's edge, and the float's bar and corner ---------------------
  //
  // One listener set for both modes, because they are one thing — the reader sizing and placing the pane they are
  // reading. Which gesture a press starts is decided by the FRAME the pane is in at that moment, so a setting that
  // changed under the pointer cannot leave the wrong drag half-finished.
  (() => {
    const el = as$("assistant");
    const split = as$("as-split");
    const bar = el?.querySelector(".as-bar");
    if (!el || !split) return;

    // A press that never travels this far is a click, not a drag: clicking the edge is what readers do to focus
    // something, and it must leave the frame exactly as it was.
    const DRAG_THRESHOLD = 3;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    let press = null;

    // `kind` is the gesture, not the element: the rail has one (its width) and the float has two (its bar and its
    // corner). Every length below starts as a CLIENT measurement — the unit a pointer arrives in — and is written back
    // through `cssPx`, because a style length is a layout one the page zoom scales.
    const onDown = (e, kind, captureEl) => {
      if (e.button !== 0) return;
      // The bar is a row of buttons too: a press on one of them is that button's, not the pane's.
      if (kind === "float-move" && e.target.closest("button,input,select,textarea,a")) return;
      press = { kind, px: e.clientX, py: e.clientY, moved: false, z: zoomScale(), box: el.getBoundingClientRect(), w: dockWidth() };
      // Hold the pointer for the length of the gesture: without capture it leaves the pane (and the window) and the
      // moves stop arriving, so a release out there never ends the drag we started in here.
      try {
        captureEl.setPointerCapture(e.pointerId);
      } catch {
        /* older pointer stacks: the window listeners below still carry the gesture */
      }
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!press) return;
      const d = press;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.moved = true;
        el.classList.add(d.kind === "dock-width" ? "is-splitting" : "is-moving");
        // Growing the pane hands the room to a turn's console, so a drag with everything folded opens the newest
        // turn first: a folded turn has no console on the page for the room to land in.
        if (d.kind !== "float-move") openNewestTurn();
      }
      const { vw, vh } = viewportBox();
      const z = d.z || 1;
      // The rail: the pointer travels in client px and the width is a layout length, so the zoom divides it. Dragging
      // the edge LEFT widens the rail, which is the direction the pointer is moving.
      if (d.kind === "dock-width") {
        state.assistantWidth = d.w - dx / z;
        paintDock();
        queueSlackPaint();
        return;
      }
      // The float's bar: keep the whole window inside the layout viewport. A frame already outside the box (a rect
      // remembered on a bigger screen) is left where it is until the drag pulls it back in — snapping it to the edge
      // here would jump the window on the grab itself — and the clamp's overshoot is absorbed into the gesture's own
      // origin, or the pointer has to walk it back before the window stirs.
      if (d.kind === "float-move") {
        const w = Math.min(d.box.width, vw - 2 * FLOAT_EDGE);
        const h = Math.min(d.box.height, vh - 2 * FLOAT_EDGE);
        const maxX = Math.max(FLOAT_EDGE, vw - w - FLOAT_EDGE);
        const maxY = Math.max(FLOAT_EDGE, vh - h - FLOAT_EDGE);
        const x = clamp(d.box.left + dx, Math.min(FLOAT_EDGE, d.box.left), Math.max(maxX, d.box.left));
        const y = clamp(d.box.top + dy, Math.min(FLOAT_EDGE, d.box.top), Math.max(maxY, d.box.top));
        el.style.left = cssPx(x, z);
        el.style.top = cssPx(y, z);
        el.style.right = "auto";
        el.style.bottom = "auto";
        d.px += d.box.left + dx - x;
        d.py += d.box.top + dy - y;
        return;
      }
      // The float's bottom-right corner: the left and top edges stay where they are, and neither dimension is ever
      // asked for LESS than the frame already has — a frame taller than the room left would otherwise snap down on
      // the first pixel of the drag.
      const w = clamp(d.box.width + dx, FLOAT_MIN_W, Math.max(d.box.width, vw - FLOAT_EDGE - d.box.left));
      const h = clamp(d.box.height + dy, FLOAT_MIN_H, Math.max(d.box.height, vh - FLOAT_EDGE - d.box.top));
      el.style.width = cssPx(w, z);
      el.style.height = cssPx(h, z);
      queueSlackPaint();
    };

    const onUp = () => {
      if (!press) return;
      const d = press;
      press = null;
      el.classList.remove("is-splitting", "is-moving");
      if (!d.moved) return; // a click: nothing was dragged, so nothing is remembered
      if (d.kind === "dock-width") {
        // Store what the clamp actually drew, not the raw pointer position: a drag past the cap must not remember a
        // width the rail can never have.
        state.assistantWidth = dockWidth();
        writeDockWidth(state.assistantWidth);
        return;
      }
      // The float is remembered where the reader left it: the drawn rect, measured back after the clamp.
      const r = el.getBoundingClientRect();
      state.assistantFloat = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      writeFloatRect(state.assistantFloat);
    };

    split.addEventListener("pointerdown", (e) => onDown(e, floating() ? "float-size" : "dock-width", split));
    if (bar) bar.addEventListener("pointerdown", (e) => { if (floating()) onDown(e, "float-move", bar); });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  })();

  // Which way the chat is being read: the reader's own scroll decides whether a repaint lands on the newest
  // turn or holds their place. Ours (pinChatToBottom) lands at the bottom, which is what "pinned" means.
  document.addEventListener(
    "scroll",
    (e) => {
      const body = e.target;
      if (!body?.matches?.("[data-subpane=\"chat\"] > .job > .job-body")) return;
      chatPinned = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
    },
    true,
  );

  // The rail is sized against the window, so a resize re-measures it: a narrower window caps the width at 60% of
  // it, and a topbar that wrapped to a second row moves the rail's top edge down with it.
  window.addEventListener("resize", () => {
    if (!state.assistantOpen) return;
    applyFrame(true);
    // The pane just changed height: the room goes to the open turn's console, not to the spacer above it.
    queueSlackPaint();
  });

  // The topbar's height is not a constant — it wraps — and the rail is pinned under it. Follow it rather than
  // assume it, and only while the pane is on screen.
  if (typeof ResizeObserver === "function") {
    const bar = document.querySelector(".topbar");
    if (bar) new ResizeObserver(() => { if (state.assistantOpen) applyFrame(true); }).observe(bar);
  }

  // ---- keys ------------------------------------------------------------------------------------

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      toggleAssistant();
      return;
    }
    // Alt+Shift+A throws the aggressive switch — the second assistant key, beside the one that opens the float.
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      setAggressiveMode(!state.assistant?.aggressive?.on);
      return;
    }
    // A bare letter "A" opens it too — and only a bare one: any modifier disqualifies it (Ctrl+A stays
    // select-all, Shift+A is a capital, Alt/Meta keys belong to the desktop), and a keystroke aimed at a field
    // belongs to the field, whether the caret is in one now or has landed there by a repaint.
    if (
      !e.repeat &&
      (e.key === "a" || e.key === "A") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      !inTextField(e.target) &&
      !inTextField(document.activeElement)
    ) {
      e.preventDefault();
      toggleAssistant(true);
      return;
    }
    if (e.key !== "Escape") return;
    const el = as$("assistant");
    if (!el || el.hidden) return;
    // Esc closes the rail only when the caret is in it: a reader dismissing something on the board, or a model
    // popup, must not lose the panel.
    if (document.activeElement && el.contains(document.activeElement)) {
      e.preventDefault();
      toggleAssistant(false);
    }
  });

  // ---- boot ------------------------------------------------------------------------------------

  // The Bridge tab's own clock. Only while that tab is on screen and the caret is not in its policy box: the process,
  // the room and the gateway are not in the board's SSE events, so this is the one pane that has to ask. `loadBridge`
  // keeps its own 15 s guard, so a repaint that lands here between ticks costs nothing.
  setInterval(() => {
    if (!state.assistantOpen) return;
    if (state.assistantView?.assistant !== "bridge") return;
    if (typingInside("#as-bridge")) return;
    void loadBridge();
  }, BRIDGE_POLL_MS);

  // app.js's boot fills state from the first snapshot and connects the stream; this restores the frame in the
  // same breath, so a reload opens on the panel the reader left open — in the mode that assistant's file asked for.
  (function restoreFrame() {
    const el = as$("assistant");
    if (!el) return;
    el.hidden = !state.assistantOpen;
    as$("btn-assistant")?.classList.toggle("is-on", state.assistantOpen);
    applyFrame(true);
    paintAssistantBadge();
    paintAggressive();
    if (state.assistantOpen) renderAssistant();
  })();

  // app.js calls these: applyAssistant from the snapshot, the SSE event and after a reply; the chat renderer
  // when a job event arrives for a card that does not exist yet (the float may never have been opened).
  window.applyAssistant = applyAssistant;
  // app.js hands the THREAD that changed; the renderer wants the session it belongs to.
  window.__assistantRenderChat = (thread) => {
    const rec = sessionRecords().find((x) => x.threadId === thread);
    renderAssistantChat(rec ? rec.id : activeSessionId());
  };
  window.__assistantToggle = toggleAssistant;
  // app.js's HUMAN rotation: the thread an assistant's question lives on -> that assistant's Chat, on screen.
  window.__assistantShowThread = showAssistantThread;
  // The task pipeline window's opener, for the ONE surface outside this rail that lists queue tasks: Settings > Bundles.
  // Its task rows press into this same window rather than growing a second assignment form, so a task is put on a
  // pipeline from the catalogue this window already reads, through the same queue write and the same stamp.
  window.__openTaskPipelineWindow = openTaskPipelineWindow;
  // The task pipeline window's one press, its keys and its clock. Wired once at boot: the dialog lives outside the rail
  // and survives every repaint of the queue pane, so nothing here is per-row.
  pipeWindowWire();
})();
