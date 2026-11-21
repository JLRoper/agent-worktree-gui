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
  // The rail's cap is HALF the window rather than a pixel ceiling: 640 was half of a 1280px window and a third of a
  // 1920px one, so the reader on the wider screen was the one who could not open the transcript. The board's own
  // floor (BOARD_MIN) is the cap's other stop, so a narrow window hands the rail what is left over instead of
  // squeezing the chart, and DOCK_HARD_MIN is where the rail stops being a rail at all.
  const DOCK_SHARE = 0.5;
  const BOARD_MIN = 420;
  const DOCK_HARD_MIN = 240;
  const DOCK_DEFAULT = 480;
  // ---- the frame's other mode: the float ----------------------------------------------------------
  // Which one is on screen is the PANEL's setting (`dockMode` in the panel's own config.json, chosen in
  // Settings → General), not one assistant's: every assistant's pane is drawn the same way, and switching tabs no
  // longer changes it. What the float remembers is its rect, kept beside the rail's width rather than replacing it —
  // switching back to the rail must not lose the width the reader dragged, and switching to the float must not lose
  // the place they left it at.
  const FLOAT_KEY = "wm.assistantFloat";
  const FLOAT_MIN_W = 320;
  const FLOAT_MIN_H = 320;
  // Air kept between the float and every viewport edge, in client px. The float is laid out in the LAYOUT viewport
  // (`documentElement.clientWidth/Height`, which already excludes the classic scrollbar) — see `viewportBox`.
  const FLOAT_EDGE = 8;
  // How far inside the float's bottom-right corner a press still begins a corner resize, in client px. The float and
  // its handle are both ROUND (10px and 9px radii, `overflow: hidden` on the float), so the handle's own box loses its
  // last pixels to the clip: a press on the corner the reader aims at reaches the BOARD under the window, and the
  // resize never starts. This is the band that press has to be claimed in (see the corner zone in the gesture block).
  const FLOAT_GRAB = 6;
  // The floor a corner drag may shrink the open turn's console to: one line of console, the sheet's own base
  // `.job-out { min-height }`. The float's open-turn rule zeroes that on the drawn box, and a console the drag has
  // shrunk is still a console, so this is the floor the gesture keeps rather than a number the box reports.
  const FLOAT_OUT_MIN = 34;

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
  const LISTS = ["role", "initiatives", "watchdog", "bridge"];
  // What a session holds: the card you talk to, how it behaves, the work it is carrying (its queue, its trees) and
  // what it has seen and said (its alerts, watches, messages, pad). Every one of these renders for the ACTIVE
  // session through paneIdFor, so #2's Alerts is #2's list rather than a panel-wide one wearing #2's name.
  const SUBTABS = ["chat", "settings", "queue", "worktrees", "alerts", "watches", "messages", "pad"];
  const FIRST_ASSISTANT = "assistant-1";
  const DEFAULT_VIEW = { assistant: FIRST_ASSISTANT, subTab: SUBTABS[0] };
  // WHICH ASSISTANTS' HARD-RESTART PAIR IS ARMED. One record for the float, not a DOM flag: the Settings pane is
  // rebuilt on every snapshot, and a flag kept on the element would be replaced under the reader's second press. It is
  // cleared whenever the float opens or the reader changes tab — an armed pair is a question about the tab it was
  // asked on — and `armed` is read back by the row's own painter (renderAssistantSettings).
  const hardRestartArmed = new Set();
  // WHICH ASSISTANTS' DELETE IS ARMED, and the dry run that armed it. Same reason as the hard restart's set:
  // the Settings pane is rebuilt on every snapshot, so the question and the archive folder it names have to
  // live in the float's record rather than on a button that a repaint replaces. Cleared with the hard restart's
  // set whenever the tab changes, and on a refusal - a refused delete has nothing left to confirm.
  const deleteArmed = new Map();
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
    // An armed hard restart is a question the reader has walked out on: changing tab or tab-pane puts every
    // assistant's Cancel/Confirm pair back to a single button before anything repaints.
    if (next.subTab !== state.assistantView.subTab || next.assistant !== state.assistantView.assistant) {
      hardRestartArmed.clear();
      deleteArmed.clear();
    }
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
      if (row) {
        let b = document.querySelector(`#as-tabs [data-as-tab="${rec.id}"]`);
        if (!b) {
          b = document.createElement("button");
          b.type = "button";
          b.dataset.asTab = rec.id;
          const firstList = [...row.querySelectorAll("[data-as-tab]")].find((x) => LISTS.includes(x.dataset.asTab));
          row.insertBefore(b, firstList || null);
        }
        // Written on EVERY paint, not only when the button is created: a renamed assistant has to move its tab label
        // in place. Creating it once and leaving the text alone is how a rename would need a page reload to show.
        b.title = `${rec.name} — a real agent thread of its own (${rec.threadId ?? ""}), running the role it picked`;
        if (b.textContent !== rec.name) b.textContent = rec.name;
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
    // A record can also LEAVE the roster - the delete control removes one - so the row and the pane follow the
    // list in both directions. Only session-shaped ids are pruned: LISTS (Role, Watchdog, Bridge) are the
    // panel's own and never appear in `assistantIds()`.
    const ids = new Set(assistantIds());
    if (row) {
      for (const b of row.querySelectorAll("[data-as-tab]")) {
        const id = b.dataset.asTab;
        if (!LISTS.includes(id) && !ids.has(id)) b.remove();
      }
    }
    if (body) {
      for (const p of body.querySelectorAll(":scope > .as-pane[data-pane]")) {
        const id = p.dataset.pane;
        if (!LISTS.includes(id) && !ids.has(id)) p.remove();
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

  // The width the rail is drawn at: the remembered one, clamped. The cap is half the window, measured in the same
  // layout px the width is stored in, so a zoomed page cannot hand the rail more of the window than it would at 100%
  // - and on a window too narrow for both floors the board's 420px is the one that holds, because the board is what
  // the row is for.
  // ---- dock width: the one clamp ---------------------------------------------------------------
  // LAYOUT px in, LAYOUT px out: the unit a style width is written in and the unit the reader's number is stored in.
  function clampDockWidth(want, vw, z) {
    const layout = Math.max(0, Math.floor((vw || 0) / (z || 1)));
    // Half the window is the cap, and the board's floor is the second stop: the two meet at an 840px window, and
    // below it the board keeps its 420px while the rail takes what is left. DOCK_HARD_MIN is the only bound that
    // wins over the board's floor, because a rail narrower than that is not one.
    const cap = Math.max(DOCK_HARD_MIN, Math.min(Math.floor(layout * DOCK_SHARE), layout - BOARD_MIN));
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
  // The frame is ONE CHOICE FOR THE WHOLE PANEL: `state.settings.dockMode` — "docked" | "floating", out of the
  // panel's own config.json, chosen in Settings → General. It used to be each assistant's own field; the move made
  // it one key, so this reader asks that key and nothing else and every assistant's pane is drawn the same way.
  // `docked` is the default AND what an absent key means, so a panel that has never chosen draws the rail it
  // always did. The tab the reader is on therefore no longer decides the frame — it only decides whose content the
  // pane shows — which is why `frameSessionId` is still here: `applyFrame` uses it to notice a tab change and
  // re-place the float for the new pane.
  const frameSessionId = () => (isAssistant(state.assistantView?.assistant) ? state.assistantView.assistant : lastSession);
  const dockModeOf = () => (String(state.settings?.dockMode || "") === "floating" ? "floating" : "docked");
  const floating = () => dockModeOf() === "floating";

  // ---- one-time: the per-assistant frame becomes the panel's one key -------------------------------
  //
  // Until this build each assistant carried its own `dock` in its own settings file. The frame is one key now, so
  // the value is ADOPTED rather than dropped: the server still serves the map of values previous builds wrote
  // (`state.assistant.dock`, empty for ever once this has run), and the assistant whose tab is on screen is the one
  // asked — the frame the reader is actually looking at is the one the panel keeps. Where two assistants disagreed
  // the other value goes, and the General row's help says so. The write lands in the panel's config.json; the
  // server retires every per-assistant key in the same answer, so the map cannot outlive this call.
  let dockAdopted = false;
  function adoptDockFromSettings() {
    if (dockAdopted || !state.settings || typeof state.settings !== "object") return;
    if (state.settings.dockMode === "docked" || state.settings.dockMode === "floating") {
      dockAdopted = true;
      return;
    }
    const legacy = state.assistant && state.assistant.dock;
    if (!legacy || typeof legacy !== "object" || !Object.keys(legacy).length) return;
    dockAdopted = true;
    const shown = frameSessionId();
    const value = legacy[shown] === "floating" ? "floating" : "docked";
    // The page's own copy first, so the very first paint draws the frame the reader has been looking at …
    state.settings = { ...state.settings, dockMode: value };
    // … then the write. A failed save leaves `dockAdopted` false and the old map in place, so the next page load
    // tries again rather than pretending the value was carried.
    asPost("/api/settings/general", { dockMode: value, from: shown }).catch(() => {
      dockAdopted = false;
    });
  }
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
    const mode = dockModeOf();
    const moved = mode !== frameMode || id !== frameId;
    frameMode = mode;
    frameId = id;
    el.classList.toggle("is-floating", mode === "floating");
    const split = as$("as-split");
    if (split) split.title = mode === "floating" ? "drag to resize the floating assistant (320 px minimum)" : "drag to resize the assistant's column (340 px minimum, half the window at most)";
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
  // The lowest open turn: the newest one the reader has open, i.e. the turn at the foot of the transcript.
  function slackTurn() {
    const body = chatBody();
    if (!body) return null;
    const open = [...body.querySelectorAll(":scope > .turn:not(.folded)")];
    return open.length ? open[open.length - 1] : null;
  }
  function paintSlackTurn() {
    slackQueued = false;
    const body = chatBody();
    if (!body) return;
    const target = slackTurn();
    for (const t of body.querySelectorAll(":scope > .turn")) t.classList.toggle("is-slack", t === target);
  }
  // The console that turn draws: the box a resize hands its room to. Null with every turn folded, when no console is
  // on the page at all, and before the card exists.
  function slackConsole() {
    return slackTurn()?.querySelector(":scope > .out-wrap > .out-box > .job-out") || null;
  }
  // The console's own floor, read off the drawn box rather than assumed: `.job-out` carries a base `min-height` in
  // the sheet, and a box that reports none (the float's open-turn rule zeroes it) falls back to `FLOAT_OUT_MIN` so the
  // drag still stops with a console on screen.
  function consoleFloor(out) {
    const min = out ? parseFloat(getComputedStyle(out).minHeight) : NaN;
    return Number.isFinite(min) && min > 0 ? min : FLOAT_OUT_MIN;
  }
  // The console's height for a corner drag: what it had when the press landed, plus the height the FRAME really
  // gained (measured back after the clamp), and never under the console's own floor. Monotonic in the gain by
  // construction, which is what a resize has to be: the box the reader is reading may not shrink while they pull the
  // corner open. It is written by the gesture rather than handed to `.is-slack`'s `flex: 1 1 auto`, because that flex
  // only grows into FREE space - an overflowing transcript has none, so the console kept its content height and a
  // WIDER frame rewrapped that content into fewer lines: measured 132.5 -> 98px while a +200x+150 drag made the panel
  // bigger. The same arithmetic run backwards is what shrinks it, so both directions are honest.
  function consoleDragHeight(start, gained, floor) {
    const lo = Number.isFinite(Number(floor)) && Number(floor) > 0 ? Number(floor) : FLOAT_OUT_MIN;
    return Math.max(lo, Number(start) + Number(gained));
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

  // ---- the header's turn search: one box in the title row, one read of the store behind it -----------------
  //
  // WHY A READ AND NOT A FILTER. The card on screen holds five turns (`wtTurnFold.PER_PAGE`) and the console's
  // tail, and the reader who remembers a phrase from forty turns back is asking about text the page does not
  // hold. So the box asks the server: /api/assistant/search, routes/assistant-search.js over
  // lib/assistant/search.js, which reads the SAME job store the card was built from - `prompt`, `finalMessage`
  // and `lines[]` - and answers `matched` beside `displayed` so the count can never imply the list is complete.
  // The query's meaning (`*`/`?` wildcards, a plain substring, case-insensitive, metacharacters escaped) is
  // public/core/turn-search.js in both places, so a hit cannot mean one thing here and another in the count.
  //
  // THE CORPUS IS EVERY ASSISTANT. The box used to send the open tab's id, so a phrase in Assistant #2's turns was
  // invisible while #1 was selected. The request no longer names an assistant: the server searches each assistant's
  // own threads and merges the lists into one ordered index at query time, and every hit says which assistant it
  // belongs to. A row therefore names its assistant, and a press lands the panel on THAT assistant's tab, in the
  // card of the thread the turn is on, with the turn in view and ringed. Nothing is copied: the turns already live
  // in one store, and the merge is an array of references built while answering.
  //
  // WHAT A HIT DOES. `revealSearchHit` puts the turn in front of the reader through the card's OWN paging:
  // wtTurnFold.reveal picks the page the turn lives on, unfolds it and writes the page offset, so the repaint
  // below is the ordinary one; then the matched text is marked inside the turn. The results are a fixed popover
  // under the box, so no result can ever add a line to the title row.
  //
  // ONE PRESS, ONE MATCH. A "match" is one FIELD of one turn - the prompt, the reply, or one console line - and
  // the keyboard steps THOSE, not the five turns they may belong to: a filter that hits five rows of one turn
  // is five presses, and the count beside the box reads "1 of 5" ... "5 of 5" for it exactly as it does for five
  // turns. The count and the footer are ONE readout (public/core/search-count.js, `wtSearchCount`), so the header
  // cannot divide a total the footer contradicts. The turns a match belongs to are still mapped
  // (public/core/search-items.js) for the ring round the whole message and for the footer's secondary turn count.
  //
  // WHY THE LIST STAYS OPEN WHILE STEPPING. A press keeps the popover up: its footer is half of the count's
  // promise - "5 hits matched, 5 displayed, in 1 turn" beside "2 of 5" - and a footer that vanished on the first press
  // would be the same two-numbers-in-one-view defect in another form. The turn (or the matched row, inside one
  // turn) is scrolled to the bottom of the transcript, below the popover, so the highlight stays visible.
  //
  // THE ORDER OF THE LIST. The server sends the matches in the cap's own preference (your input, then replies, then
  // console lines) because that is what survives the ten-row cap, not the order a reader walks them in. The list is
  // ordered here instead, by public/core/search-items.js's `order`: one item (message) per group, newest first by
  // the item's newest row, and the rows inside an item in reading order - prompt, console lines, reply - so a
  // message still reads top to bottom and a Down walks backwards in time. Equal timestamps break by the assistant
  // and the conversation's own numbering, so a tie cannot shuffle between paints. The header, the footer and the
  // amber note all divide the SAME ordered list: the walk's total is its length, and the footer's "displayed" is
  // that length. Each item is introduced by its own header and never followed by one, so the last row before the
  // footer is a result and not a title with nothing under it.
  //
  // THE COST OF ONE ANSWER. The server caps the rows it answers (SEARCH_LIMIT) and builds the excerpt only for those,
  // and the page draws exactly those rows: a filter that matches thousands of turns never becomes thousands of
  // nodes, and the count's `matched` is the honest total of everything the store held. The input stays responsive
  // because the read is debounced and every answer but the newest keystroke's is dropped (`searchSeq`).
  //
  // A MOUSEDOWN OUTSIDE CLOSES IT. The box and the list are the two places a press belongs to the search; anywhere
  // else - the transcript below, another pane of this float, the board - closes the list and drops the highlight,
  // while the FILTER stays in the box so the next keystroke or Down asks the same question again. The decision is
  // taken on mousedown, through public/core/search-dismiss.js, so a drag that starts inside the results never
  // closes them, and a click on a row still selects it.
  //
  // ALSO TRUE: Ctrl+Q lands in the box from anywhere in the panel with the text it already holds selected
  // (typing replaces the last filter); Escape clears the filter and leaves the caret in the box; the ends WRAP,
  // the same rule Enter has always had, and docs/assistant-search-keys.md states it for the reader.
  const SEARCH_DEBOUNCE = 200;
  const SEARCH_LIMIT = 10;
  let searchTimer = null;
  let searchSeq = 0;
  let searchHits = [];
  // The same hits grouped into the turns they belong to, and the turn each hit belongs to (parallel to
  // searchHits), so the ring, the footer's turn count and a result row can name the message.
  let searchItems = [];
  let searchHitItem = [];
  // The row the reader is standing on: an index into searchHits, -1 before an answer.
  let searchHitAt = -1;
  let searchOut = null;
  let searchShownQuery = "";
  let searchScope = "all";
  // The popover, the keyboard walk and the scroller follow are ONE module for BOTH header searches
  // (public/core/search-popover.js). This bar supplies the hits, the readout and the rows; the module owns the
  // element's life, its placement, the keys, the count's DOM, which row is current and the follow through
  // public/core/search-scroll.js. Mounted on the first `wireSearch()` (the nodes exist by then) and kept.
  let mountedSearchBar = null;
  function searchBar() {
    if (mountedSearchBar) return mountedSearchBar;
    const mod = globalThis.wtSearchPopover;
    const input = as$("as-search-q");
    const pop = as$("as-search-pop");
    if (!mod || typeof mod.mount !== "function" || !input || !pop) return null;
    mountedSearchBar = mod.mount({
      input,
      pop,
      count: as$("as-search-n"),
      // The whole `.as-search` span, not the input: the popover aligns with the control the reader sees, which is
      // what this bar has always used.
      anchor: as$("as-search"),
      readout: searchReadout,
      current: () => searchHitAt,
      onStep: stepSearch,
      onOpen: openCurrentSearchHit,
      onEscape: escapeSearch,
      onDismiss: dismissSearch,
      onType: () => armSearch(),
      onPick: (at) => revealSearchHit(at),
    });
    return mountedSearchBar;
  }

  // One readout, one source. `searchReadout` is the ONLY place the header and the footer get their numbers:
  // public/core/search-count.js turns the rows the box steps plus the server's own counts into the header text
  // ("2 of 5"), the footer text ("5 hits matched, 5 displayed, in 1 turn") and the title. A page that counted the
  // turn list here and the hits there is what printed "1 of 1" beside "5 hits matched" - so the total comes from
  // `searchHits`, and the turn count is secondary text the footer carries.
  function searchReadout() {
    const out = searchOut || {};
    const query = String(out.query || "");
    const mod = globalThis.wtSearchCount;
    if (mod && typeof mod.readout === "function") {
      // The count is hidden until a filter exists - "0 of 0" beside an empty box is noise - and the MODULE paints
      // that visibility from this flag, so the bar keeps its own rule while the writing lives in one place.
      return { ...mod.readout({ hits: searchHits, matched: out.matched, turns: out.turns, at: searchHitAt }), query, hidden: !query };
    }
    // A page that did not load the module still draws its counts rather than nothing: the numbers are the same
    // arithmetic, minus the module's wording. It is a degraded path, not a second source the page may choose.
    const total = searchHits.length;
    const matched = Number(out.matched) || 0;
    const current = total ? Math.min(total, Math.max(1, searchHitAt + 1)) : 0;
    return {
      current,
      total,
      matched,
      displayed: total,
      turns: Number(out.turns) || 0,
      capped: matched > total,
      text: `${current} of ${total}`,
      foot: `${matched} ${matched === 1 ? "hit" : "hits"} matched, ${total} displayed`,
      title: "Up and Down step one match per press, Enter opens the turn it is in",
      query,
      hidden: !query,
    };
  }

  // The count beside the box: "n of N", N being the matching ROWS the box steps through, n the one the reader
  // is standing on. The hit counts stay on the element (and in its title) because the cap is a fact the count
  // must not hide: a list that stopped short says so in amber, and the footer says how many matched and how many
  // are on hand. `data-search-total` is the number the header divides; it is also the footer's `displayed`.
  function paintSearchCount() {
    const el = as$("as-search-n");
    if (!el) return;
    const bar = searchBar();
    if (bar) {
      bar.paintCount();
      return;
    }
    // The module missing is a build error, not a state to design for; the count still paints from the same readout.
    const c = searchReadout();
    el.dataset.searchCurrent = String(c.current);
    el.dataset.searchTotal = String(c.total);
    el.dataset.searchMatched = String(c.matched);
    el.dataset.searchDisplayed = String(c.displayed);
    el.dataset.searchTurns = String(c.turns);
    el.dataset.searchQuery = String(c.query || "");
    el.hidden = Boolean(c.hidden);
    el.textContent = c.hidden ? "" : c.text;
    el.classList.toggle("is-capped", Boolean(c.capped));
    if (c.title) el.title = c.title;
    else el.removeAttribute("title");
  }

  // Which assistant a thread belongs to: its current thread, or one a hard restart left behind. This is what a
  // result row names and what a press switches the panel to, so it is one resolver rather than two guesses.
  function assistantIdOfThread(thread) {
    const t = String(thread || "");
    if (!t) return null;
    const rec = sessionRecords().find((r) => r.threadId === t || (Array.isArray(r.previousThreads) && r.previousThreads.includes(t)));
    return rec ? rec.id : null;
  }

  // The name a row prints. The server puts it on the hit (`assistant`, from the record it searched); a hit from an
  // older answer, or one the page mapped itself, falls back to the session record - so a row can never be anonymous
  // while the panel knows whose turn it is.
  function searchAssistantName(hit) {
    const named = String(hit?.assistant || "").trim();
    if (named) return named;
    const id = assistantIdOfThread(hit?.thread) || String(hit?.assistantId || "").trim();
    return id ? sessionById(id)?.name || id : "";
  }

  // One result row: WHOSE turn it is, where the hit is (the reader's input, the reply, or the console line's own
  // kind) and a one-line window with the match marked. The window is built by the server and split into
  // before/hit/after there, so this never re-finds a match with a second regex that could disagree. The row carries
  // the HIT it stands for (its press opens that match) and the TURN it belongs to, and the standing row is marked -
  // the list, the ring and the count agree about where the reader is. The assistant's name is on EVERY row because
  // the corpus is every assistant's turns: two hits from two assistants have to be told apart at a glance. The row's
  // age is its OWN (a console line from an hour into a turn is an hour old); which message it belongs to is the item
  // header above it, so the two facts are said once each.
  function searchHitHtml(hit, index, itemAt) {
    const where = hit.field === "input" ? "you" : hit.field === "reply" ? "reply" : String(hit.kind || "tool");
    const who = searchAssistantName(hit);
    const when = searchAge(hit.at);
    const lead = hit.lead ? "..." : "";
    const tail = hit.tail ? "..." : "";
    const marked = hit.hit ? `<mark class="as-search-mark">${esc(hit.hit)}</mark>` : "";
    const current = index === searchHitAt;
    return (
      `<button type="button" class="as-search-row${who ? " as-search-row-who" : ""}${current ? " is-current" : ""}" data-search-hit="${index}" data-search-item="${itemAt}" data-assistant="${esc(hit.assistantId || assistantIdOfThread(hit.thread) || "")}"` +
      `${current ? ' aria-current="true"' : ""} title="open this turn in ${esc(who || "its assistant")}'s card">` +
      `${who ? `<span class="as-search-who mono">${esc(who)}</span>` : ""}` +
      `<span class="as-search-where mono">${esc(where)}</span>` +
      `<span class="as-search-meta mono">${esc(when)}</span>` +
      `<span class="as-search-snip">${lead}${esc(hit.before)}${marked}${esc(hit.after)}${tail}</span>` +
      `</button>`
    );
  }

  // One item's head: whose message the rows under it belong to, which message, when it last did something, and how
  // many of its rows matched. It is drawn BEFORE the item's rows and never after them - a title with no rows under
  // it reads as one more, empty result - so the last row before the footer is always a result.
  function searchItemHtml(item) {
    if (!item) return "";
    const who = searchAssistantName(item.hits[0]);
    const ordinal = searchTurnOrdinal(item.hits[0]);
    const when = searchAge(item.stamp);
    const rows = item.hits.length;
    const meta = [who, ordinal ? `turn ${ordinal}` : "", when, rows > 1 ? `${rows} rows` : ""].filter(Boolean).join(" - ");
    if (!meta) return "";
    return `<div class="as-search-item mono">${esc(meta)}</div>`;
  }

  function renderSearchPop(out) {
    const pop = as$("as-search-pop");
    if (!pop) return;
    const bar = searchBar();
    const hits = searchHits;
    if (!out || !out.matched || !hits.length) {
      if (bar) bar.hide();
      else {
        pop.hidden = true;
        pop.innerHTML = "";
      }
      return;
    }
    // The footer is the readout's own sentence, so it cannot print a total the header contradicts: the header's
    // "n of N" divides the same N the footer calls "displayed". The cap keeps its note; the turn count is the
    // secondary clause.
    const c = searchReadout();
    const foot =
      `<div class="as-search-more mono">${esc(c.foot)}` +
      `${c.capped ? " - your own input is kept when the cap bites" : ""}</div>`;
    // One header per item, then that item's rows in reading order. The order the rows are drawn in IS the order the
    // walk steps: the index each row carries is its position in `searchHits`, incremented as the items are walked, so
    // a press cannot open a row the list drew somewhere else.
    const parts = [];
    if (searchItems.length) {
      let at = 0;
      for (let i = 0; i < searchItems.length; i += 1) {
        parts.push(searchItemHtml(searchItems[i]));
        for (const hit of searchItems[i].hits) {
          parts.push(searchHitHtml(hit, at, i));
          at += 1;
        }
      }
      // A hit the map could not place (no thread or no id) is not on a message: draw the flat list rather than lose
      // a row the header is counting.
      if (at !== hits.length) parts.length = 0;
    }
    if (!parts.length) for (let i = 0; i < hits.length; i += 1) parts.push(searchHitHtml(hits[i], i, 0));
    if (bar) bar.show(parts.join("") + foot);
    else {
      pop.innerHTML = parts.join("") + foot;
      pop.hidden = false;
      placeSearchPop();
    }
  }

  // Under the box, right edges aligned and never off the screen: the rail hugs the window's right edge and the
  // popover is wider than the box, so it grows leftwards. The arithmetic is public/core/search-popover.js's
  // `placeGeometry`, one pure function both header searches use; this keeps the old read of the two nodes for a page
  // that did not load the module.
  function placeSearchPop() {
    const bar = searchBar();
    if (bar) return bar.place();
    return null;
  }

  function clearSearchMarks() {
    for (const mark of document.querySelectorAll("mark.as-search-mark")) {
      if (!mark.parentNode) continue;
      mark.replaceWith(...mark.childNodes);
    }
  }

  // Empty the popover and the count, leave the box's text alone: this is what a re-search or a scope change does
  // before its own answer lands.
  function clearSearch() {
    searchHits = [];
    searchItems = [];
    searchHitItem = [];
    searchHitAt = -1;
    searchOut = null;
    searchShownQuery = "";
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    const pop = as$("as-search-pop");
    if (pop) {
      const bar = searchBar();
      if (bar) bar.hide();
      else {
        pop.hidden = true;
        pop.innerHTML = "";
      }
    }
    clearSearchMarks();
    paintSearchCurrent();
    paintSearchCount();
  }

  function clearSearchAll() {
    const input = as$("as-search-q");
    if (input) input.value = "";
    clearSearch();
  }

  function armSearch(delay = SEARCH_DEBOUNCE) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      runSearch();
    }, delay);
  }

  // The hits grouped into the turns they belong to, and the turn each hit belongs to. `searchHits` is already in the
  // walk's order (public/core/search-items.js's `order`), so group() keeps the items in that order and each item's
  // hits in reading order - the list, the ring, the footer's turn count and the walk all speak one list.
  function regroupSearch() {
    searchItems = globalThis.wtSearchItems ? globalThis.wtSearchItems.group(searchHits) : [];
    searchHitItem = [];
    for (let i = 0; i < searchItems.length; i += 1) {
      for (let k = 0; k < searchItems[i].hits.length; k += 1) searchHitItem.push(i);
    }
  }

  // One read. `seq` is the whole guard against a slow answer for `app` landing after a fast one for `app.js`: the
  // answer that is not the latest keystroke's is dropped, not drawn over the newer one.
  async function runSearch() {
    const input = as$("as-search-q");
    if (!input) return null;
    const q = String(input.value || "").trim();
    if (!q) {
      clearSearch();
      return null;
    }
    const seq = ++searchSeq;
    // No assistantId: the corpus is EVERY assistant's turns (the server searches each one's own threads and merges
    // them into one ordered index), so the open tab no longer decides what is findable. The cap is the render's
    // too - the answer holds at most SEARCH_LIMIT rows and the popover draws exactly those.
    const params = new URLSearchParams({ q, scope: searchScope, limit: String(SEARCH_LIMIT) });
    let out = null;
    try {
      const r = await apiFetch(`/api/assistant/search?${params.toString()}`, {}, { timeoutMs: 8000 });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      out = await r.json();
    } catch (err) {
      if (seq !== searchSeq) return null;
      searchHits = [];
      searchItems = [];
      searchHitItem = [];
      searchHitAt = -1;
      searchOut = null;
      searchShownQuery = q;
      clearSearchMarks();
      paintSearchCurrent();
      const pop = as$("as-search-pop");
      if (pop) {
        pop.innerHTML = `<div class="as-search-more mono">search failed: ${esc(String(err?.message || err))}</div>`;
        pop.hidden = false;
        placeSearchPop();
      }
      paintSearchCount();
      return null;
    }
    if (seq !== searchSeq) return null;
    const answered = Array.isArray(out.hits) ? out.hits : [];
    // The server's order is the CAP's preference (what survives ten rows), not the walk's: order the list here, by
    // the clock, newest message first with its rows in reading order. `matched` and `turns` stay the server's own
    // counts over every match, and the walk's total is this list's length, so the header, the footer and the amber
    // note keep dividing one list.
    searchHits = globalThis.wtSearchItems?.order ? globalThis.wtSearchItems.order(answered) : answered;
    searchOut = out;
    regroupSearch();
    // An answer makes its FIRST row current: the count reads "1 of N" and the first press of Down is the second
    // row, exactly as the reader expects. Nothing scrolls until they press - a keystroke must not throw the
    // transcript around - but the row is highlighted if it is on the page already.
    searchHitAt = searchHits.length ? 0 : -1;
    searchShownQuery = String(out.query || q);
    paintSearchCount();
    renderSearchPop(out);
    paintSearchCurrent();
    // A new answer is drawn from its first row: the popover may still hold the scroll of the list it replaced, so
    // the row the count is standing on is put back in view rather than left above the fold.
    if (searchHitAt >= 0) keepSearchRowVisible();
    return out;
  }

  const conversationsByThread = (thread) => conversations().find((c) => c.thread === thread) || null;

  function searchTurnOrdinal(hit) {
    const conv = conversationsByThread(hit?.thread);
    if (!conv) return 0;
    const i = conv.turns.findIndex((t) => t.id === hit.id);
    return i >= 0 ? i + 1 : 0;
  }

  function searchAge(at) {
    const ms = Date.now() - Number(at || 0);
    if (!Number.isFinite(ms) || Number(at) <= 0) return "";
    if (ms < 60000) return "now";
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return d < 30 ? `${d}d` : `${Math.floor(d / 30)}mo`;
  }

  // Mark the first place the query appears inside `scope`. TEXT nodes only, walked in order, so the mark can never
  // rewrite a tag or an attribute: the renderer already escaped the prompt, and this keeps the same promise. Returns
  // the mark it made (or null), because the caller brightens THAT one - on a step inside one turn, the first mark in
  // the message can be the row before the one now current.
  function markInsideTurn(scope, query) {
    const compiled = globalThis.wtTurnSearch?.compile(query);
    if (!scope || !compiled) return null;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !compiled.re.test(node.nodeValue)) return NodeFilter.FILTER_SKIP;
        if (node.parentElement && node.parentElement.closest("mark.as-search-mark")) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const m = compiled.re.exec(node.nodeValue);
      if (!m || !m[0].length) continue;
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const mark = document.createElement("mark");
      mark.className = "as-search-mark";
      try {
        range.surroundContents(mark);
        return mark;
      } catch {
        return null;
      }
    }
    return null;
  }

  // The turn element a hit lives in, if the card draws it right now. A turn on another page of its card is not in
  // the DOM until `revealSearchHit` has repainted; asking for it again after the repaint is the honest answer. The
  // assistant comes from the THREAD (its current one or a thread a restart left behind), never from the open tab:
  // a cross-assistant hit has to be looked for in its own assistant's card.
  function turnElementFor(hit) {
    if (!hit) return null;
    const targetId = assistantIdOfThread(hit.thread) || activeSessionId();
    const host = hostFor(targetId, "chat");
    const card = host?.querySelector(`.job[data-thread="${CSS.escape(hit.thread)}"]`);
    return card?.querySelector(`[data-turn="${CSS.escape(hit.id)}"]`) || null;
  }

  // Where inside a turn the hit's text lives, so a step inside ONE turn brightens the row the hit names instead of
  // the first matching text in the message. The rows are the ones the card draws: the prompt rides the turn's head
  // as `.turn-prompt-inline` (public/turns.js), and every console line is a `.jl[data-lid]` row
  // (public/core/console-format.js). A hit whose row is not drawn (a tool line older than the console's window, or a
  // reply the panel only knows from the terminal event) answers the turn itself and leaves the excerpt to say where.
  function hitScopeIn(turnEl, hit) {
    if (!turnEl || !hit) return turnEl;
    if (hit.field === "input") return turnEl.querySelector(".turn-prompt-inline, .turn-prompt") || turnEl;
    if (hit.lid != null && hit.lid !== "") {
      for (const row of turnEl.querySelectorAll("[data-lid]")) {
        if (String(row.dataset.lid) === String(hit.lid)) return row;
      }
    }
    return turnEl;
  }

  // Which row the reader is standing on, drawn once so every surface agrees: the turn gets `.is-search-current` (a
  // readable ring around the whole message, all of its rows), the mark inside it gets `.is-current` (brighter than a
  // plain hit's mark), the row the hit names gets `.is-search-current-row` (the console draws a tool CALL as a folded
  // group row - "cat" and a chevron, with the command in `data-ltext` - so a hit on that line has no visible text to
  // mark and the row's amber edge is what says where the walk is standing), and the result row of that hit is marked
  // `aria-current`. No scroll happens here: this repaint runs while the reader is typing, and it must not move the
  // transcript under them. The LIST's own scroller is the walk's business (`keepSearchRowVisible`), and a new answer
  // calls it once after this paint.
  function paintSearchCurrent() {
    for (const el of document.querySelectorAll(".turn.is-search-current")) el.classList.remove("is-search-current");
    for (const mark of document.querySelectorAll("mark.as-search-mark.is-current")) mark.classList.remove("is-current");
    for (const row of document.querySelectorAll(".is-search-current-row")) row.classList.remove("is-search-current-row");
    // Which row of the LIST is current: the shared module marks it (`.is-current` plus aria-current) from the
    // `current` accessor this bar supplied, so the assistant's list and the Hot Agent list mark rows the same way.
    searchBar()?.markCurrent();
    const hit = searchHits[searchHitAt];
    if (!hit) return null;
    const turnEl = turnElementFor(hit);
    if (!turnEl) return null;
    turnEl.classList.add("is-search-current");
    const scope = hitScopeIn(turnEl, hit);
    if (scope && scope !== turnEl) scope.classList.add("is-search-current-row");
    // The mark is the one the reveal made. A repaint of the card (a streamed line, a fold) drops the mark with the
    // node, and the ring would then sit round a turn with nothing lit inside it: put the mark back on the row the
    // hit names before brightening it.
    let mark = turnEl.querySelector("mark.as-search-mark.is-current") || turnEl.querySelector("mark.as-search-mark");
    if (!mark) mark = markInsideTurn(scope, searchShownQuery || String(hit.hit || ""));
    if (mark) mark.classList.add("is-current");
    return turnEl;
  }

  // The popover's OWN scroller follows the highlight. The list is a fixed popover with its own scroll (`.as-search-pop`
  // is a flex column, `overflow-y: auto`, and placeSearchPop caps its height), so a row the keyboard stepped to past
  // its bottom edge is a row the reader cannot see while the header goes on counting. The arithmetic - nearest edge
  // in, one row per press, a row taller than the band keeping its top, and the way back up retracing the way down -
  // is public/core/search-scroll.js, which is a pure function with a test; this reads the two nodes and hands them
  // over. It moves the popover and nothing else: no transcript, no page, no focus, no height.
  function keepSearchRowVisible() {
    const bar = searchBar();
    if (bar) return bar.follow();
    return null;
  }

  // ONE MATCH, in front of the reader: the assistant whose turn it is, the page that turn lives on (through the same
  // reveal the board's jump and the toast use), the turn unfolded if it was folded, the match marked inside its own
  // row, and the list's current row kept in view. `keepList` is the keyboard's case: the popover stays up because its
  // footer is half the count's promise, so the LIST is what follows the walk - its own scroller is moved to the row,
  // and the transcript is left exactly where the reader had it. Enter and a click still open the turn in the card.
  //
  // ACROSS ASSISTANTS. A hit may belong to an assistant whose tab is not the one on screen, so the tab switch comes
  // FIRST: the panel moves to that assistant's Chat, the card is repainted for that thread, and only then is the turn
  // looked for. A keyboard STEP within one assistant still leaves the transcript alone (the reader is reading the
  // list), but a step that CROSSES to another assistant's tab has just put a different card on screen: it scrolls the
  // turn into view, because a tab switch with the match somewhere below the fold would be a press that showed nothing.
  //
  // Returns whether the match was marked - false when the turn is gone from the store or the text is not on the page
  // (a tool line older than the console's window, or a turn on a thread a hard restart left behind that the card does
  // not draw), which the row's own marked excerpt still answers.
  function revealSearchHit(hitAt, { keepList = false } = {}) {
    const prev = searchHits[searchHitAt];
    const hit = searchHits[Number(hitAt)];
    if (!hit) return false;
    searchHitAt = Number(hitAt);
    const targetId = assistantIdOfThread(hit.thread) || String(hit.assistantId || "").trim() || activeSessionId();
    const switched = targetId !== activeSessionId() || state.assistantView?.subTab !== "chat";
    const conv = conversationsByThread(hit.thread);
    if (conv) wtTurnFold.reveal(state, conv.thread, conv.turns, hit.id);
    if (targetId !== activeSessionId()) setView({ assistant: targetId, subTab: "chat" });
    else if (state.assistantView?.subTab !== "chat") setView({ subTab: "chat" });
    renderAssistantChat(targetId);
    // Enter and a click open the turn: the popover gets out of its way (the count beside the box carries the
    // reader's place, and a new answer brings the list back). A keyboard STEP keeps it, footer and all.
    const pop = as$("as-search-pop");
    if (pop && !keepList) {
      const bar = searchBar();
      if (bar) bar.hide();
      else pop.hidden = true;
    }
    const turnEl = turnElementFor(hit);
    if (!turnEl) {
      paintSearchCount();
      return false;
    }
    clearSearchMarks();
    const mark = markInsideTurn(hitScopeIn(turnEl, hit), searchShownQuery || String(hit.hit || ""));
    const sameTurn = Boolean(prev) && prev.id === hit.id && prev.thread === hit.thread;
    const pageY = window.scrollY;
    // Enter and a click put the turn in the middle of the card. A keyboard STEP does not touch the transcript at all,
    // unless it switched tabs: the reader's place is the list, whose row is the thing that has to move, and a press
    // that dragged the card around under a floating popover would move the text they are not reading. A step that
    // landed on another assistant's tab has no "their place" left in that card, so it puts the turn in view.
    if (!keepList || switched) {
      if (!sameTurn || switched) turnEl.scrollIntoView({ block: "center" });
      else if (mark) mark.scrollIntoView({ block: "center" });
    }
    // The reveal can still move the window through the card's own pager or a fold; put it back where the reader had
    // it, whatever asked.
    if (window.scrollY !== pageY) window.scrollTo({ top: pageY });
    paintSearchCount();
    paintSearchCurrent();
    // The list follows the walk: the popover's own scroller is moved so the row the keyboard is standing on is fully
    // visible, one row per press, in either direction.
    if (keepList) keepSearchRowVisible();
    return Boolean(mark);
  }

  // One press, one MATCH. Down and Up move the current match through the rows the answer listed - five rows of ONE
  // turn are five presses, because the count says "5" and the keyboard has to reach every one of them - and WRAP at
  // both ends (docs/assistant-search-keys.md states it): Down on the last row lands on the first, Up on the first
  // lands on the last. A press that arrives while a NEW filter is still being read answers THAT filter and lands on
  // its first row: stepping the previous answer would print a count beside a box that no longer says the same thing.
  function stepSearch(delta) {
    const q = String(as$("as-search-q")?.value || "").trim();
    // The answer on screen is not the box's text yet: the debounce has not fired, or it fired and the answer is in
    // flight. Either way the press belongs to the new filter, not to the old list.
    if (searchTimer || (q && q !== searchShownQuery)) {
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      if (!q) {
        clearSearch();
        return;
      }
      runSearch().then((out) => {
        if (!out || !searchHits.length) return;
        searchHitAt = 0;
        revealSearchHit(0, { keepList: true });
      });
      return;
    }
    if (searchHits.length) {
      const walk = globalThis.wtSearchCount?.step;
      if (typeof walk !== "function") return;
      searchHitAt = walk(searchHitAt, delta, searchHits.length);
      revealSearchHit(searchHitAt, { keepList: true });
      return;
    }
    if (!q) return;
    runSearch().then((out) => {
      if (!out || !searchHits.length) return;
      searchHitAt = 0;
      revealSearchHit(0, { keepList: true });
    });
  }

  // Enter: the current match, opened. A filter the box holds but the page has not answered opens the answer's first
  // row instead - Enter acts on what is typed, and a filter still being read is not a reason to do nothing.
  function openCurrentSearchHit() {
    const q = String(as$("as-search-q")?.value || "").trim();
    if (searchTimer || (q && q !== searchShownQuery)) {
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      if (!q) return;
      runSearch().then((out) => {
        if (out && searchHits.length) revealSearchHit(0);
      });
      return;
    }
    if (searchHits.length) {
      revealSearchHit(searchHitAt >= 0 ? searchHitAt : 0);
      return;
    }
    if (!q) return;
    runSearch().then((out) => {
      if (out && searchHits.length) revealSearchHit(0);
    });
  }

  // Escape: the filter goes and the caret STAYS IN THE BOX, so the next filter can be typed without reaching for
  // Ctrl+Q again. The rail's own Escape closes the whole panel; a reader clearing the box means the box, not the
  // panel - so this stops the event where it is.
  function escapeSearch() {
    clearSearchAll();
    as$("as-search-q")?.focus({ preventScroll: true });
  }

  // A mousedown OUTSIDE the box and outside the list: the reader has gone somewhere else, so the list closes and the
  // highlight goes with it. The FILTER stays in the box - the text is the reader's work, not the popover's - so the
  // next keystroke (or a Down) asks the same question again and the list comes back. The answer is dropped rather
  // than parked: the sequence moves on so a read already in flight cannot reopen what this closed, and
  // `clearSearch()` is what hides the count beside the box, so no stale number is left behind.
  function dismissSearch() {
    const pop = as$("as-search-pop");
    const open = Boolean(pop && !pop.hidden);
    if (!open && !searchOut && !searchHits.length) return;
    searchSeq += 1;
    clearSearch();
  }

  // Ctrl+Q's half: the box takes the caret and SELECTS what it already holds, so the first character typed replaces
  // the last filter instead of appending to it.
  function focusSearch() {
    const input = as$("as-search-q");
    if (!input) return false;
    input.focus({ preventScroll: true });
    input.select();
    return true;
  }

  // The hosts Ctrl+Q must not touch: a textarea, and the composer (the card's reply box, which is a contenteditable,
  // and the board's own prompt field). These are where the reader is WRITING, and a chord that moved the caret out
  // of them would eat the words being written.
  function inComposer(node) {
    const el = node && node.nodeType === 1 ? node : null;
    if (!el) return false;
    if (/^TEXTAREA$/.test(el.tagName)) return true;
    return Boolean(el.closest?.("textarea, .reply-box, [data-reply], #job-prompt"));
  }

  function wireSearch() {
    const input = as$("as-search-q");
    if (!input) return;
    // The input, the keys, the popover's own Escape, a result press, the place-on-resize/scroll and the mousedown
    // dismissal are all the shared module's (public/core/search-popover.js), mounted here with this bar's callbacks.
    // The scope chip is this bar's own control and stays below.
    const bar = searchBar();
    if (!bar) return;
    bar.wire();
    const scope = as$("as-search-scope");
    scope?.addEventListener("click", (e) => {
      searchScope = searchScope === "input" ? "all" : "input";
      const on = searchScope === "input";
      e.currentTarget.setAttribute("aria-pressed", on ? "true" : "false");
      e.currentTarget.title = on
        ? "searching your own input only - press for every field"
        : "search your own input only - every turn the store kept, not just the page on screen";
      if (String(input.value || "").trim()) {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = null;
        runSearch();
      }
    });
  }

  // ---- the Hot Agent search: the turns the READER wrote to worker agents, beside the turn search ---------------
  //
  // WHAT IT LISTS, and why the page does not filter. `/api/hot-agent/search` (routes/hot-agent-search.js over
  // lib/hot-agent/search.js) answers only the turns the reader wrote to worker agents, read from the panel's job
  // store: an assistant manager turn, an agent's own reply and a turn the assistant started on a worker's behalf are
  // excluded THERE, so this bar cannot draw a row the server refused. An empty box is a real read - the most recent N
  // turns - with N from public/core/hot-agent-list.js, the number the Settings > Board row writes.
  //
  // NEWEST FIRST is the server's order (startedAt, then the turn counter, then the id, so a tie is stable) and the
  // page does not re-sort: a Down walks down the clock, which is the direction a reader browses a store in. The row
  // names the AGENT (its label or its session title, the thread id when it has neither), the THREAD and the PROJECT
  // TREE it ran in; Enter lands on the turn's own card in the board.
  //
  // THE LIST IS THE SAME COMPONENT as the turn search beside it: public/core/search-popover.js supplies the popover,
  // the keys, the count's DOM, which row is current and the follow through public/core/search-scroll.js, so the row
  // the keyboard stands on stays inside the list's own scroller (the head and the footer do not scroll). The bar
  // supplies the hits, the readout wording and the row markup - nothing else.
  const HOT_AGENT_DEBOUNCE = 180;
  let hotHits = [];
  let hotOut = null;
  let hotAt = -1;
  let hotShownQuery = "";
  let hotSeq = 0;
  let hotTimer = null;
  let mountedHotBar = null;

  // The list's size, as this browser holds it: the module's read is the same default and clamp the server falls back
  // to (lib/hot-agent/search.js imports the identical file), so a Settings row and a request cannot disagree.
  function hotLimit() {
    const mod = globalThis.wtHotAgentList;
    if (mod && typeof mod.read === "function") return mod.read(window.localStorage);
    return 20;
  }

  function hotBar() {
    if (mountedHotBar) return mountedHotBar;
    const mod = globalThis.wtSearchPopover;
    const input = as$("ha-search-q");
    const pop = as$("ha-search-pop");
    if (!mod || typeof mod.mount !== "function" || !input || !pop) return null;
    mountedHotBar = mod.mount({
      input,
      pop,
      // The popover has a permanent head (the box) and a footer, so the LIST is the scroller the walk follows.
      scroller: as$("ha-search-list"),
      count: as$("ha-search-n"),
      anchor: as$("ha-search-open"),
      readout: hotReadout,
      current: () => hotAt,
      onStep: hotStep,
      onOpen: hotEnter,
      onEscape: hotEscape,
      onDismiss: hotDismiss,
      onType: () => hotArm(),
      onPick: (at) => openHotAt(at),
      // The assistant's popover opens under a box in the rail's title row; this one opens under a 90px button, so it
      // starts wider than the assistant's 250px floor and grows leftwards by the same rule.
      placeOptions: { minWidth: 330, widthCap: 420 },
    });
    return mountedHotBar;
  }

  // The one readout both the count header and the footer are drawn from. The assistant's wording is its own
  // (public/core/search-count.js); this bar's wording is its own too, while the walk's arithmetic stays shared: a
  // press goes through `wtSearchCount.step`, whose wrap is the same rule at both ends.
  function hotReadout() {
    const query = String(hotOut?.query || "");
    const total = hotHits.length;
    const matched = hotOut ? Number(hotOut.matched) || 0 : 0;
    const current = total ? Math.min(total, Math.max(1, hotAt + 1)) : 0;
    // A cap is a cap whichever question was asked: more turns answered than are on hand. The filter says so in the
    // footer's first clause, the empty box in its second - and both flag it, so the amber means one thing.
    const capped = matched > total;
    if (query) {
      return {
        query,
        hidden: false,
        current,
        total,
        matched,
        displayed: total,
        turns: total,
        capped,
        text: total ? `${current} of ${total}` : "0 of 0",
        foot: `${matched} ${matched === 1 ? "turn" : "turns"} matched, ${total} displayed, newest first`,
        title: `${matched} ${matched === 1 ? "turn" : "turns"} you wrote to worker agents match this filter - Up and Down step one turn per press, Enter opens its card`,
      };
    }
    // The empty box is not a filter: the list IS the newest N, so the count reads as a size and the footer says how
    // many the store holds when that is more.
    return {
      query: "",
      hidden: false,
      current,
      total,
      matched: Math.max(matched, total),
      displayed: total,
      turns: total,
      capped,
      // The count's TEXT: the size while the reader is standing on the first row, the position once a press has moved
      // them. A browsing list that counts nothing would leave the reader with no way back to "where am I", and the
      // size is the right answer exactly once - when the list opens.
      text: hotAt > 0 ? `${current} of ${total}` : `${total} ${total === 1 ? "turn" : "turns"}`,
      foot: total
        ? `${capped ? `${total} of ${matched} turns, ` : `${total} ${total === 1 ? "turn" : "turns"}, `}newest first, every tree`
        : "no turn you wrote to an agent is in the store yet",
      title: `the ${total} most recent turns you wrote to worker agents, newest first - type to filter, Up and Down step one turn, Enter opens its card`,
    };
  }

  // One turn: the agent (loud), the tree and the age, then the project and the thread on their own quiet line, then a
  // one-line window with the match marked. The three names the brief asks for are all on the row, and the tree's PATH
  // rides the tooltip rather than a fourth line.
  function hotRowHtml(hit, index) {
    const current = index === hotAt;
    const lead = hit.lead ? "..." : "";
    const tail = hit.tail ? "..." : "";
    const marked = hit.hit ? `<mark class="as-search-mark">${esc(hit.hit)}</mark>` : "";
    const tree = String(hit.tree || "");
    const meta = [tree, searchAge(hit.at)].filter(Boolean).join(" - ");
    const project = String(hit.project || "") && hit.project !== tree ? hit.project : "";
    // The thread is named unless the agent IS its thread id (a job with no session title), because printing the
    // same string on two lines of one row spends the row's height to say nothing twice.
    const named = String(hit.agent || "").trim();
    const thread = named && named === String(hit.thread || "").trim() ? "" : `thread ${hit.thread}${hit.turn ? ` - turn ${hit.turn}` : ""}`;
    const tip = `${hit.agent || hit.thread}${tree ? ` in ${tree}` : ""}${hit.treePath ? ` (${hit.treePath})` : ""} - press Enter to open this turn's card`;
    return (
      `<button type="button" class="as-search-row ha-search-row${current ? " is-current" : ""}" data-search-hit="${index}" data-thread="${esc(hit.thread)}" data-agent="${esc(hit.agent)}" data-tree="${esc(tree)}"${current ? ' aria-current="true"' : ""} title="${esc(tip)}">` +
      `<span class="as-search-where mono">${esc(hit.agent || hit.thread)}</span>` +
      `<span class="as-search-meta mono">${esc(meta)}</span>` +
      `<span class="ha-search-thread mono">${esc([project, thread].filter(Boolean).join(" - "))}</span>` +
      `<span class="as-search-snip">${lead}${esc(hit.before)}${marked}${esc(hit.after)}${tail}</span>` +
      `</button>`
    );
  }

  // The count in the popover's head and the footer under its list, both from `hotReadout()`.
  function paintHotReadout() {
    hotBar()?.paintCount();
    const foot = as$("ha-search-more");
    if (!foot) return;
    const c = hotReadout();
    foot.textContent = c.foot || "";
    foot.classList.toggle("is-capped", Boolean(c.capped));
  }

  function renderHotPop() {
    const bar = hotBar();
    if (!bar) return;
    const c = hotReadout();
    if (!hotHits.length) {
      const none = c.query ? "no turn you wrote to an agent matches this filter" : "no turn you wrote to an agent is in the store yet";
      bar.show(`<div class="ha-search-empty">${esc(none)}</div>`);
    } else {
      bar.show(hotHits.map((hit, i) => hotRowHtml(hit, i)).join(""));
    }
    paintHotReadout();
    bar.markCurrent();
  }

  function hotArm(delay = HOT_AGENT_DEBOUNCE) {
    if (hotTimer) clearTimeout(hotTimer);
    hotTimer = setTimeout(() => {
      hotTimer = null;
      void runHotSearch();
    }, delay);
  }

  // One read. `seq` is the same guard the turn search uses: a slow answer for `saff` must not land over a fast one for
  // `saffron`, and a read already in flight when the reader closes the list must not reopen it.
  async function runHotSearch() {
    const input = as$("ha-search-q");
    if (!input) return null;
    const q = String(input.value || "").trim();
    const seq = ++hotSeq;
    let out = null;
    try {
      const params = new URLSearchParams({ q, limit: String(hotLimit()) });
      const r = await apiFetch(`/api/hot-agent/search?${params.toString()}`, {}, { timeoutMs: 8000 });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      out = await r.json();
    } catch (err) {
      if (seq !== hotSeq) return null;
      hotHits = [];
      hotOut = null;
      hotAt = -1;
      hotShownQuery = q;
      hotBar()?.show(`<div class="ha-search-empty">search failed: ${esc(String(err?.message || err))}</div>`);
      paintHotReadout();
      return null;
    }
    if (seq !== hotSeq) return null;
    hotHits = Array.isArray(out.hits) ? out.hits : [];
    hotOut = out;
    hotShownQuery = String(out.query || q);
    hotAt = hotHits.length ? 0 : -1;
    renderHotPop();
    // A new answer is drawn from its first row: the list may still hold the scroll of the one it replaced, so put the
    // row the count is standing on back in view instead of leaving it above the fold.
    if (hotAt >= 0) hotBar()?.follow();
    return out;
  }

  // One press, one TURN: the walk steps the list the count divides, wrapping at both ends through the same
  // public/core/search-count.js `step` the turn search uses. A press that arrives while a new filter is still being
  // read answers THAT filter and lands on its first row.
  function hotStep(delta) {
    const q = String(as$("ha-search-q")?.value || "").trim();
    if (hotTimer || q !== hotShownQuery) {
      if (hotTimer) {
        clearTimeout(hotTimer);
        hotTimer = null;
      }
      void runHotSearch().then((out) => {
        if (!out || !hotHits.length) return;
        hotAt = 0;
        hotBar()?.markCurrent();
        hotBar()?.follow();
      });
      return;
    }
    if (!hotHits.length) return;
    const walk = globalThis.wtSearchCount?.step;
    const total = hotHits.length;
    hotAt = typeof walk === "function" ? walk(hotAt, delta, total) : (hotAt + delta + total) % total;
    paintHotReadout();
    hotBar()?.markCurrent();
    hotBar()?.follow();
  }

  function hotEnter() {
    const q = String(as$("ha-search-q")?.value || "").trim();
    if (hotTimer || (q && q !== hotShownQuery)) {
      if (hotTimer) {
        clearTimeout(hotTimer);
        hotTimer = null;
      }
      void runHotSearch().then((out) => {
        if (out && hotHits.length) openHotAt(0);
      });
      return;
    }
    if (hotHits.length) openHotAt(hotAt >= 0 ? hotAt : 0);
  }

  // Enter (or a click) on one turn: the board's own landing, then the turn itself ringed. This is HUMAN's board
  // path (public/app.js `humanShow`) step for step - the fold reveals the page the turn lives on, hotOpenPath opens
  // the project and the row, the card is unfolded, renderConversation draws it - because a second idea of "open this
  // turn" is exactly what drifts. `programmaticScroll` keeps the panel's scroll-follow from reading the landing as
  // the reader taking the page over, and the amber ring says WHICH TURN, where the card's own flash says which agent.
  function revealHotTurn(hit) {
    if (!hit) return false;
    const conv = conversationsByThread(hit.thread);
    if (conv && globalThis.wtTurnFold?.reveal) {
      try {
        wtTurnFold.reveal(state, conv.thread, conv.turns, hit.id);
      } catch {
        /* the card falls back to the page it was on */
      }
    }
    // The ring goes into STATE before the card is drawn, so the renderer stamps it on the turn it belongs to and a
    // repaint (opening the row rebuilds the card) carries it rather than dropping a class put on the old element.
    const until = Date.now() + 2600;
    state.haHit = { thread: hit.thread, id: hit.id, until };
    clearTimeout(state.haHitTimer);
    state.haHitTimer = setTimeout(() => {
      state.haHit = { thread: null, id: null, until: 0 };
      for (const el of document.querySelectorAll(".turn.ha-hit")) el.classList.remove("ha-hit");
    }, 2600);
    const row = typeof hotRowFor === "function" ? hotRowFor(hit.thread) : null;
    if (row) hotOpenPath(row);
    if (state.collapsedJobs?.has?.(hit.thread)) state.collapsedJobs.delete(hit.thread);
    renderConversation(hit.thread);
    let card = document.querySelector(`.job[data-thread="${CSS.escape(hit.thread)}"]`);
    if (!card && typeof renderJobs === "function") {
      // An unattached card that no render has placed yet: #jobs is the panel's own renderer for that set.
      renderJobs();
      card = document.querySelector(`.job[data-thread="${CSS.escape(hit.thread)}"]`);
    }
    if (!card) return false;
    const turn = card.querySelector(`[data-turn="${CSS.escape(hit.id)}"]`);
    flashHotCard(hit.thread);
    if (typeof programmaticScroll === "function") programmaticScroll();
    // INSTANT, like the board's own landing (`humanShow`): a smooth scroll is cancelled the moment the card is
    // re-rendered under it - and opening the row does re-render - which left the reader at the top of a page with
    // the turn a screenful away.
    //
    // AND AGAIN WHILE THE BOARD SETTLES. A repaint can move the card by a screenful (other cards fold, a project
    // closes, the poll re-sorts), so one scroll is a scroll to where the card WAS. This re-aims at whatever card is
    // there now, every 100ms, until three samples in a row have it still and inside the viewport - and stops at the
    // ring's own window regardless, so nothing outlives the ring and the page is never pulled from a reader who has
    // started scrolling it.
    // A reader who has started moving the page themselves owns it: the loop stops on their first wheel, touch or
    // navigation key rather than pulling the page back under them.
    let readerMoved = false;
    const handOver = () => {
      readerMoved = true;
    };
    const NAV = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
    const onKey = (e) => {
      if (NAV.has(e.key)) readerMoved = true;
    };
    globalThis.addEventListener?.("wheel", handOver, { passive: true, once: true });
    globalThis.addEventListener?.("touchstart", handOver, { passive: true, once: true });
    globalThis.addEventListener?.("keydown", onKey, { passive: true });
    const stopWatching = () => {
      globalThis.removeEventListener?.("wheel", handOver);
      globalThis.removeEventListener?.("touchstart", handOver);
      globalThis.removeEventListener?.("keydown", onKey);
      if (globalThis.wtHotAim === aim) delete globalThis.wtHotAim;
    };
    // The card is looked up EVERY time: the board repaints on its poll, so the node found a moment ago is gone by
    // the next sample, and giving up on the first miss was the one way the landing could leave the reader at the top
    // of a page with the ringed turn a screenful away. A miss is not an answer - it is a reason to look again.
    const aim = () => {
      if (readerMoved || Date.now() >= until) {
        stopWatching();
        return true;
      }
      const live = document.querySelector(`.job[data-thread="${CSS.escape(hit.thread)}"]`);
      const node = live?.querySelector(`[data-turn="${CSS.escape(hit.id)}"]`) || live;
      if (node) {
        const r = node.getBoundingClientRect();
        const inside = r.top >= 0 && r.bottom <= (globalThis.innerHeight || 0);
        if (!inside) node.scrollIntoView({ block: "center" });
      }
      return false;
    };
    // Every render pass asks for a re-aim while the ring is live (render-jobs.js reaimHotHit), which is what makes a
    // repaint that moves the card a correction in the same frame instead of a jump the reader has to find.
    globalThis.wtHotAim = aim;
    if (!aim()) {
      const timer = setInterval(() => {
        if (aim()) clearInterval(timer);
      }, 100);
      // A hard stop of its own: a card that never settles must not leave an interval running behind the panel.
      setTimeout(() => {
        clearInterval(timer);
        stopWatching();
      }, 3000);
    }
    return true;
  }

  function openHotAt(at) {
    const hit = hotHits[Number(at)];
    if (!hit) return false;
    // Close before opening: the popover is over the board, and the card has to be visible when the ring lands on it.
    closeHotSearch();
    const opened = revealHotTurn(hit);
    // The box went with the popover, so the keyboard's place is the button that opened it - Escape and Enter both
    // leave the reader somewhere they can press again.
    as$("ha-search-open")?.focus({ preventScroll: true });
    if (!opened) showNote(`no card on the board for ${hit.agent || hit.thread}`);
    return opened;
  }

  // Close the list. `clear` empties the box (Escape), `focus` hands the keyboard back to the button; a dismissal
  // leaves the filter in place, like the turn search, so the next open asks the same question.
  function closeHotSearch({ clear = false, focus = false } = {}) {
    if (hotTimer) {
      clearTimeout(hotTimer);
      hotTimer = null;
    }
    // The sequence moves on: a read already in flight must not reopen what this closed.
    hotSeq += 1;
    hotBar()?.hide();
    as$("ha-search-open")?.setAttribute("aria-expanded", "false");
    if (clear) {
      const input = as$("ha-search-q");
      if (input) input.value = "";
    }
    hotHits = [];
    hotOut = null;
    hotAt = -1;
    hotShownQuery = "";
    paintHotReadout();
    if (focus) as$("ha-search-open")?.focus({ preventScroll: true });
  }

  function hotEscape() {
    // Escape closes the list, clears the filter and hands focus back to the button that opened it.
    closeHotSearch({ clear: true, focus: true });
  }

  function hotDismiss() {
    closeHotSearch();
  }

  // Ctrl+Shift+Q, and the header button - the hand-and-pen control in the floating header, beside Human - land here:
  // the panel opens if it was closed (the popover lives in its title row), the popover opens on the reader's last
  // filter (or the most recent N), the box takes the caret with its text selected so the first character typed
  // replaces it, and the store is read again - the empty box promises "the most recent", not "the most recent at page
  // load".
  function openHotSearch() {
    const panel = as$("assistant");
    const bar = hotBar();
    const input = as$("ha-search-q");
    if (!panel || !bar || !input) return false;
    if (panel.hidden) toggleAssistant(true);
    if (!bar.isOpen()) {
      bar.show(`<div class="ha-search-empty">reading the turns you wrote to agents...</div>`);
      paintHotReadout();
      as$("ha-search-open")?.setAttribute("aria-expanded", "true");
    }
    input.focus({ preventScroll: true });
    input.select();
    if (hotTimer) {
      clearTimeout(hotTimer);
      hotTimer = null;
    }
    void runHotSearch();
    return true;
  }

  function wireHotSearch() {
    const bar = hotBar();
    if (!bar) return;
    bar.wire();
    as$("ha-search-open")?.addEventListener("click", () => {
      if (bar.isOpen()) closeHotSearch({ focus: true });
      else openHotSearch();
    });
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
      // Through `setScroll` (public/board/console.js), so the box remembers where the panel put it: the card's own
      // pin (`stickCardBodySoon`) reads that record to tell the reader's scroll from the panel's, and a write it
      // cannot attribute is a write that can unpin a pane the reader never touched.
      setScroll(body, body.scrollHeight);
      body._atBottom = true;
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
      // Opening the float is opening Settings from the reader's point of view: a pair armed before it closed is one
      // Enter away from clearing a conversation, so it starts at rest.
      hardRestartArmed.clear();
      renderAssistant();
      // The transcript's task ids are anchors only once the page can name their owner, and the owner comes from the
      // queues. Opening the float asks once (throttled and single-flight, see public/queue-cards.js): the chat is
      // already on screen, and the answer repaints it a moment later if it placed anything.
      void ensureTaskIndex();
      paintAssistantBadge();
      pinChatToBottom(true);
    }
    else {
      // Closed, the rail takes no room: the row goes back to the board's own height.
      const shell = el?.parentElement;
      if (shell) shell.style.minHeight = "";
      // A list left open inside a closed rail is a button that still says it is expanded: close it rather than let the
      // panel's own state disagree with what is on screen.
      closeHotSearch();
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
    // The one-time move of the frame out of this payload and into the panel's own key. Before any paint, so the
    // reader never sees the rail flash where their window was.
    adoptDockFromSettings();
    if (data.thread) state.assistantThread = data.thread;
    // WHICH THREADS ARE THE FLOAT'S. The list is every assistant's CURRENT thread plus the threads a hard restart
    // left behind: those still hold that assistant's transcript, and app.js hides an assistant conversation from the
    // board by this list — a retired thread would otherwise be drawn as an agent's card the moment #1 moved off it.
    state.assistantThreads = [
      ...new Set(
        (Array.isArray(data.assistants) && data.assistants.length ? data.assistants : [{ threadId: data.thread }])
          .flatMap((a) => [a.threadId, ...(Array.isArray(a.previousThreads) ? a.previousThreads : [])])
          .filter(Boolean),
      ),
    ];
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
    // Which frame the PANE is drawn in is the panel's setting, and this is the one painter every path already calls:
    // a save, a settings event from another tab and the first snapshot all land here, so it re-frames without a
    // reload. The tab decides whose content is inside the pane, never its shape.
    applyFrame();
    const mode = a?.settings?.autonomy || "draft";
    const modeEl = as$("as-mode");
    if (modeEl) {
      modeEl.textContent = mode === "draft" ? "draft-only" : mode === "auto-safe" ? "auto-safe" : "auto";
      modeEl.className = `as-mode mono${mode === "auto" ? " is-auto" : mode === "auto-safe" ? " is-safe" : ""}`;
    }
    // The bar names the assistant the float is showing, from the same record the tab label is painted from — the two
    // surfaces read one fact, so a rename lands in both on the same repaint.
    const nameEl = as$("as-name");
    if (nameEl) {
      const shown = sessionById(selectedSessionId());
      const label = shown?.name || "Assistant";
      if (nameEl.textContent !== label) nameEl.textContent = label;
      // The row gives the name ONE line, so a name wider than the row ellipsizes. The title carries the whole name
      // first, then what the field is — otherwise the tail of a long name is nowhere on screen.
      const hint = `${label} — the assistant this float is showing, named from its own record`;
      if (nameEl.title !== hint) nameEl.title = hint;
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
    else if (view.assistant === "initiatives") renderAssistantInitiatives();
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
    // A role with a standing wake says so here: the interval is part of the job, not a hidden setting, and this is
    // the first thing the assistant's own tab shows. 0 is "no cadence" and says nothing.
    const cadence = Number(rec?.wakeEveryMinutes) > 0 ? ` It wakes every <b>${Number(rec.wakeEveryMinutes)} minutes</b>.` : "";
    const director = rec?.roleId === "assistant-director";
    return `<div class="as-intro">
      <p><b>✧ ${esc(rec?.name || "Assistant")}</b> reads this board and nothing else: the agents' cards, the approvals and its own
      notes. It has no terminal of its own.${role}${cadence}</p>
      ${director
        ? `<ul>
        <li>“Who is stuck?” — every assistant's queue, with a dead run, a stale park and startable work marked.</li>
        <li>It files a row into another assistant's queue, or messages that assistant, and says which one it chose and why.</li>
        <li>It never starts a worker: that is the owning assistant's job, and this one only routes.</li>
      </ul>`
        : `<ul>
        <li>“What is going on?” — a digest of the live agents.</li>
        <li>“Keep an eye on the deploy one, and tell me if it stalls.”</li>
        <li>“Create a worktree for the docs and have an agent write them.” — it proposes the worker, and you
        confirm with one click.</li>
        <li>It answers a worker only when your standing rules cover the question; otherwise it drafts and waits
        for your click.</li>
      </ul>`}
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

  // How tall the pane's own foot is. The composer is `position: sticky; bottom: 0` inside the card body, so it occupies
  // the bottom of the scrollport the reader is looking at, and anything that has to sit just above it has to know that
  // height. It is written as a custom property on the body (one number, read by the ↓ chip's `bottom: calc()` in
  // public/style.css) and re-written only when the composer changes size - a ResizeObserver, not a read per line, so
  // the per-append path pays nothing for it.
  let footObserver = null;
  function watchPaneFoot(host) {
    if (typeof ResizeObserver !== "function") return;
    const reply = host?.querySelector(':scope > .job > .job-body > .reply');
    const body = reply?.parentElement;
    if (!reply || !body) return;
    const write = () => body.style.setProperty("--reply-h", `${reply.offsetHeight || 0}px`);
    write();
    if (!footObserver) {
      footObserver = new ResizeObserver((entries) => {
        for (const e of entries) {
          const box = e.target?.parentElement;
          if (box) box.style.setProperty("--reply-h", `${e.target.offsetHeight || 0}px`);
        }
      });
    }
    // Whichever composer is on screen is the only one this pane has: observing the fresh one is the whole update.
    footObserver.disconnect();
    footObserver.observe(reply);
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
    // A transcript on screen is a transcript that may carry task ids: ask for the attribution if the page has not got
    // it (one read per 20 s, shared with every other caller).
    void ensureTaskIndex();
    const sig = conversationSignature(conv);
    // The task index is the second half of the card's key: an id that was plain when this card was drawn becomes an
    // anchor the moment the page can name its owner (see public/queue-cards.js), and the card has to draw again for
    // that - the anchor is built while the console renders, never by a pass over the drawn DOM.
    const rev = taskIndexRev();
    const card = host.querySelector(`.job[data-thread="${CSS.escape(conv.thread)}"]`);
    if (card && card.dataset.sig === sig && card.dataset.taskrev === rev) {
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
    if (fresh) {
      fresh.dataset.sig = sig;
      fresh.dataset.taskrev = rev;
    }
    restoreScrolls(host, prevScrolls);
    applyStoredScrolls(host);
    restoreThinkBodies(host);
    restoreReplyDraft(conv.thread);
    restoreTyping(host, typing);
    restoreCardSelection(held);
    settleScrolls(host);
    watchPaneFoot(host);
    if (wasPinned) pinChatToBottom(true);
    else {
      const body = chatBody();
      if (body) {
        // The same two records `pinChatToBottom` keeps, written the other way round: where the panel put the box, and
        // that this body is NOT following. Without the second, a fresh node answers "following" and the next streamed
        // line drags a reader who is reading the middle of the transcript back down to the foot.
        setScroll(body, prevTop);
        noteCardBodyScroll(body);
      }
    }
    // The panel is fixed, so a rebuild can never move the page — but a focus() inside it can, and this keeps
    // that promise local instead of relying on every callee remembering preventScroll.
    if (window.scrollY !== pageY) window.scrollTo({ top: pageY });
    // A fresh card has none of the classes the last one carried: hand the room to the open turn again, and start
    // watching for the repaints that come from the board rather than from here.
    watchSlack();
    queueSlackPaint();
    // A repaint builds a fresh card, so the search's current-match ring went with the old one. While a filter is
    // live that ring is the reader's place in the transcript, so it is put back on the same item here - and only
    // painted, never scrolled: a streamed line must not drag a reader who is standing somewhere else.
    if (searchHits.length) paintSearchCurrent();
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
  // assistant's Chat on screen. The turn's own unfolded/paged state is written through wtTurnFold
  // (public/core/turn-fold.js) — this file never touches `state.turnOpen` / `state.turnPage` itself, and the repaint
  // this triggers is the one that draws the turn the question lives on. False means there is no session record for
  // the thread (nothing to put on screen), and the rotation steps on instead of flashing a hidden box.
  function showAssistantThread(thread) {
    const rec = sessionRecords().find((s) => s.threadId === thread);
    if (!rec) return false;
    if (!state.assistantOpen) toggleAssistant(true);
    setView({ assistant: rec.id, subTab: SUBTABS[0] });
    return Boolean(hostFor(rec.id, "chat"));
  }

  // A task id in the transcript and the chart's owner chip are one intent from two places - put the reader in THAT
  // assistant's pane - so the two share this opener. It is the same path `showAssistantThread` takes: open the float
  // if it is closed, then write the view; the paint follows the view.
  function showAssistantPane(assistantId, subTab) {
    const own = String(assistantId || "").trim();
    if (!own || !isAssistant(own)) return false;
    if (!state.assistantOpen) toggleAssistant(true);
    setView({ assistant: own, subTab: SUBTABS.includes(subTab) ? subTab : SUBTABS[0] });
    return true;
  }

  // A task id written as `#405` in the assistant's own prose. The anchor is built while the console renders
  // (public/core/console-markdown.js); this is the one press it makes: that assistant's Queue on screen, and the row
  // carrying the id centred in the pane with the chart's green pulse on it. The row may be outside the window the
  // pane draws, or in a queue this tab has never read - queueOpenTask widens the window or makes ONE read and
  // retries, and says so on the pane when the id is really not there. Nothing is sent.
  async function openTaskRef(assistantId, taskId) {
    if (!showAssistantPane(assistantId, "queue")) return false;
    return queueOpenTask(assistantId, taskId);
  }

  // The chart's owner column chip (M1, M2, A1): that assistant's Chat, with the reader's sentence already started
  // from the row they pressed - "Regarding <project> <worktree> <branch>: " - the caret after the colon and the box
  // focused, so the first keystroke continues it. NOTHING is sent: Enter is still the reader's to press, and a chip
  // that posted on its own would be a message they never wrote. The three fields are the row's own spellings, taken
  // from the chip's data at press time; a row with no branch (or an unnamed tree) simply leaves that part out
  // rather than writing a hole into the sentence.
  function openRegarding(at) {
    const own = String(at?.assistantId || "").trim();
    if (!showAssistantPane(own, "chat")) return false;
    const box = as$(firstBoxId(own));
    if (!box) return false;
    const about = [at.project, at.worktree, at.branch].map((s) => String(s ?? "").trim()).filter(Boolean).join(" ");
    writeBox(box, `Regarding ${about}: `);
    box.focus({ preventScroll: true });
    setCaretOffset(box, readBox(box).length);
    return document.activeElement === box;
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
      // The newest turn, unfolded and on the page it lives on: wtTurnFold writes the three books this card's renderer
      // reads, so a reader who had paged back still lands on the console. `changed` false means it was already in
      // front of them, and then there is nothing to repaint.
      const conv = conversations().find((c) => c.thread === thread);
      if (conv?.latest && wtTurnFold.reveal(state, thread, conv.turns, conv.latest.id).changed) {
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
        ${parked && Number(a.asks) > 1 ? `<span class="as-again-chip" title="the panel asks again once an hour while this stays unanswered — this is the same question, not a new one, and it keeps one entry">↻ asked again ${Number(a.asks) - 1}×</span>` : ""}
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
                   <span class="as-watchbar"><i data-watch-bar style="width:100%"></i></span>
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
    if (id === FIRST_ASSISTANT)
      return { assistantId: id, notes: state.assistant?.notes || "", file: false, path: "", exists: true, cap: Number(state.assistant?.notesCap) || 0, error: null };
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
    // Whose pad this is: the pane's own assistant. #1's notes are the string the polled state carries; every other
    // assistant's are its own notes.md, read when its pane is open.
    const who = id;
    const owner = sessionById(who);
    // Its OWN standing rules: the server sends every assistant's list on its own record, so #2's pane shows #2's
    // rules and the ✕ beside one names #2. `a.rules` is Assistant #1's list and is the fallback for a page whose
    // first /api/assistant answer has not landed yet.
    const rules = (Array.isArray(owner?.rules) ? owner.rules : a.rules) || [];
    const pad = padFor(who);
    // How full the pad is, against the SAME cap a turn reads it at. The box says the number and Save is refused
    // past it — the server refuses it too (413), so this is the same rule drawn before the press rather than a
    // second opinion. padOver is the value at PAINT time; the input listener below keeps it current while typing.
    const padCap = Number(pad?.cap) || 0;
    const padLen = String(pad?.notes || "").length;
    const padOver = padCap > 0 && padLen > padCap;
    const notesGroup = pad
      ? `<div class="as-group">
        <h4>Notes — read on every turn</h4>
        <textarea class="as-note-box" id="${padId("as-notes", who)}" data-as-padbox="${esc(who)}" data-as-cap="${padCap}" rows="6" placeholder="What it should remember: how this project deploys, which agents are doing what, an answer you gave today…">${esc(pad.notes || "")}</textarea>
        <div class="as-actions">
          <button id="${padId("btn-as-notes", who)}" data-as-padsave="${esc(who)}" type="button" class="primary"${padOver ? " disabled" : ""}>Save notes</button>
          <span class="as-hint${padOver ? " is-bad" : ""}" data-as-padcap="${esc(who)}" title="${esc(pad.path || "")}">${padCap ? `${padLen}/${padCap} chars — a turn reads exactly ${padCap}${padOver ? " · over the cap, Save is refused" : ""}` : ""}</span>
          <span class="as-err" id="${padId("as-pad-err", who)}">${esc(pad.error || "")}</span>
          <span class="as-hint">${pad.file ? "kept in this assistant's own notes.md" : "kept on the server in assistant.json"}</span>
        </div>
      </div>`
      : `<div class="as-group">
        <h4>Notes — read on every turn</h4>
        <div class="as-help">reading ${esc(owner?.name || who)}'s notes…</div>
      </div>`;
    host.innerHTML = `
      ${notesGroup}
      <div class="as-group">
        <h4>Standing rules — its only confident answers</h4>
        <div class="as-line">
          <label class="as-hint" title="The reader's permission for one consolidation pass: merge rules, drop one, move one into the charter, set the role prompt. A snapshot of the before state is written first."><input type="checkbox" data-as-padgrant="${esc(who)}" ${owner?.consolidate?.granted ? "checked" : ""}/> allow this assistant to consolidate its own rules</label>
        </div>
        ${rules.map((r) => `<div class="as-rule-row${r.by === "assistant" ? " is-by-assistant" : ""}"><span class="as-rule-name">${esc(r.text)}${r.by === "assistant" ? `<i class="as-rule-by" title="the assistant wrote this one; delete it if it is wrong">assistant</i>` : ""}${r.rewritten ? `<i class="as-rule-by" title="a consolidation summary; the original is in the pass's snapshot">rewritten</i>` : ""}${r.safety ? `<i class="as-rule-by" title="pinned: the twelve-seat window never leaves this one out, and a pass may not drop or unpin it">safety</i>` : ""}</span><button type="button" data-as-unrule="${esc(r.id)}" data-as-rulefor="${esc(who)}" title="remove this rule">✕</button></div>`).join("") || `<div class="as-help">None yet. A rule is an answer you have given once and do not want to give twice.</div>`}
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

  // The assistant's own command lines, drawn as the tool card (public/core/assistant-command.js): the same frame
  // the board's tail uses, with the body folded to two lines. "" when the text holds no TITLED command line, which
  // is what leaves every other message's body exactly as it was drawn before.
  function msgCommandCards(text, scope) {
    const mod = globalThis.wtAssistantCommand;
    if (!mod || typeof mod.cardsHtml !== "function") return "";
    return mod.cardsHtml(text, { scope, open: state.codeBoxOpen, renderText: (line) => `<div class="as-msg-line">${esc(line)}</div>` });
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
    // A reply's command lines are drawn as cards here too: the transcript is where the reader meets them after the
    // fact, and the emoji, the recipient and the title are the three things a row of prose cannot give at a glance.
    // The module is asked only for the text actually being shown, so a clipped message clips its cards as well.
    const cmd = msgCommandCards(long && !open ? text.slice(0, MSG_TEXT_CHARS) : text, `msg|${e.id}`);
    const cut = e.clipped ? `<span class="as-msg-cut"> (the panel clipped this message at its own cap)</span>` : "";
    const body = !text.trim()
        ? `<div class="as-msg-text is-missing">${esc(msgMissingText(e))}</div>`
        : cmd
          ? `<div class="as-msg-text is-cards">${cmd}${cut}</div>`
          : `<div class="as-msg-text">${esc(long && !open ? `${text.slice(0, MSG_TEXT_CHARS)}…` : text)}${cut}</div>`;
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

  // ---- the role editor: name, description, prompt and charter of ONE role --------------------------------------

  // THE ROLE TAB EDITS A ROLE, not one assistant's copy of one. A role is the library's record of a job: what it
  // is called, the one line that says what it is for, the short instruction its turns begin with, and the long
  // charter. Every assistant that runs the role reads these four fields, and which role an assistant runs is its
  // Settings' business — this pane names no assistant and carries no per-assistant copy.
  //
  // The library's metadata rides the polled state (`state.assistant.roles`: name, remit and size, never the text).
  // The text is read for the ONE role the picker shows, through `GET /api/assistant/role/charter`, and written back
  // through the same route's PUT — one read and one write per role, never a 20 KB body on the poll.
  let rolePick = ""; // the role id the editor shows; "" means the default below
  let roleDoc = null; // what the read landed: {id, name, description, prompt, text, cap, mtime}
  let roleDraft = null; // the reader's edits since that read: {name, description, prompt, text}, or null
  let roleLoading = ""; // the role id a read is in flight for, so the boxes say "reading…" rather than lie
  let roleSeq = 0; // bumped per read: a slow answer for a role the reader has moved off is dropped
  let roleFailed = ""; // the role id whose read failed, so a repaint does not re-request it in a loop
  let roleErr = "";
  let roleAsk = null; // {kind:"switch", roleId} — leaving unsaved edits behind, answered inside the tab
  let roleLoadedAt = 0;

  // The role the pane opens on: the one the session the reader last had open runs, else the library's first. An id
  // the library no longer holds reads the same way, rather than leaving the editor blank.
  function roleDefault() {
    const own = String(sessionById(lastSession)?.roleId || "");
    const list = state.assistant?.roles || [];
    if (own && list.some((r) => r.id === own)) return own;
    return String(list[0]?.id || "");
  }
  function roleShown() {
    const list = state.assistant?.roles || [];
    const pick = String(rolePick || "");
    return pick && list.some((r) => r.id === pick) ? pick : roleDefault();
  }
  const roleMetaOf = (id) => (state.assistant?.roles || []).find((r) => r.id === id) || null;
  const roleLoadedFor = () => (roleDoc && roleDoc.id === roleShown() ? roleDoc : null);

  // What the boxes hold: the reader's draft when there is one, otherwise the role as it was read.
  function roleValues() {
    const d = roleDraft || roleLoadedFor();
    return {
      name: String(d?.name ?? ""),
      description: String(d?.description ?? ""),
      prompt: String(d?.prompt ?? ""),
      text: String(d?.text ?? ""),
    };
  }

  function loadRoleText(roleId = roleShown()) {
    const id = String(roleId || "");
    if (!id) return Promise.resolve();
    // A different subject: drop the previous role's text before the read, so the boxes never show one role's words
    // under another role's name.
    if (roleDoc && roleDoc.id !== id) roleDoc = null;
    roleDraft = null;
    roleAsk = null;
    roleFailed = "";
    roleErr = "";
    roleLoading = id;
    const seq = ++roleSeq;
    return apiFetch(`/api/assistant/role/charter?roleId=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (seq !== roleSeq) return;
        roleDoc = {
          id: String(d.role?.id || id),
          name: String(d.role?.name || ""),
          description: String(d.role?.description || ""),
          prompt: String(d.prompt ?? ""),
          text: String(d.text ?? ""),
          cap: Number(d.cap) || Number(d.role?.cap) || 0,
          mtime: Number.isFinite(Number(d.mtime)) ? Number(d.mtime) : null,
        };
        roleDraft = null;
        roleLoadedAt = Date.now();
        roleErr = "";
      })
      .catch((err) => {
        if (seq !== roleSeq) return;
        roleFailed = id;
        roleErr = String((err && err.message) || err);
      })
      .finally(() => {
        if (seq !== roleSeq) return;
        roleLoading = "";
        renderAssistantRole(true);
      });
  }

  // What Save posts: exactly what is in the boxes. Read from the DOM rather than from `roleDraft`, because a press
  // is the moment the page must believe its own fields, and a repaint in between may have moved the draft.
  function roleForm() {
    const doc = roleLoadedFor();
    return {
      name: String(as$("as-role-name")?.value ?? doc?.name ?? ""),
      description: String(as$("as-role-description")?.value ?? doc?.description ?? ""),
      prompt: String(as$("as-role-prompt")?.value ?? doc?.prompt ?? ""),
      text: String(as$("as-role-text")?.value ?? doc?.text ?? ""),
    };
  }

  function roleDirty() {
    const doc = roleLoadedFor();
    if (!doc) return false;
    const v = roleValues();
    return v.name !== doc.name || v.description !== doc.description || v.prompt !== doc.prompt || v.text !== doc.text;
  }

  // What the box holds, in the reader's words: the role as it was read, or edits that have not been saved.
  function roleHoldsLabel() {
    if (roleDirty()) return "edited here, not saved";
    return "the role's own text";
  }

  // The sentence beside the buttons: what Save writes, and when this role was read.
  function roleSaveSentence() {
    const doc = roleLoadedFor();
    if (roleLoading) return `reading the ${roleMetaOf(roleLoading)?.name || "role"}…`;
    if (!doc) return roleErr ? "the role could not be read — pick it again to retry" : "reading the role…";
    if (roleDirty()) return "edited here, not saved yet — Save writes all four fields to this role";
    return `read ${relTime(new Date(roleLoadedAt).toISOString())} ago — Save writes all four fields to this role`;
  }

  function renderAssistantRole(force = false) {
    const host = as$("as-role");
    if (!host || !state.assistant) return;
    if (!force && typingInside("#as-role")) return;
    const roles = state.assistant.roles || [];
    const shown = roleShown();
    const doc = roleLoadedFor();
    // The picker moved (or the pane opened) and this role's text is not here yet: ask for it. `roleFailed` keeps a
    // refused read from being retried on every poll; a pick clears it.
    if (shown && !doc && roleLoading !== shown && roleFailed !== shown) void loadRoleText(shown);
    const values = roleValues();
    const cap = Number(doc?.cap) || Number(roleMetaOf(shown)?.cap) || 0;
    const over = cap > 0 && values.text.length > cap;
    const pct = cap ? Math.round((values.text.length / cap) * 100) : 0;
    const loading = Boolean(shown) && !doc && !roleFailed;
    const off = loading ? " disabled" : "";
    const options = roles
      .map((r) => `<option value="${esc(r.id)}"${r.id === shown ? " selected" : ""}>${esc(r.name)}</option>`)
      .join("");
    // Leaving the editor with text the reader has not saved: asked INLINE (never a browser dialog), with the words
    // kept on screen while they answer, so a pick cannot silently discard an edit.
    const ask = roleAsk
      ? `<div class="as-ask" id="as-role-ask" role="alert"><span class="as-ask-what">This role has edits you have not saved. Switching to ${esc(roleMetaOf(roleAsk.roleId)?.name || "another role")} replaces them.</span><button type="button" data-as-roleask="keep">Keep editing</button><button type="button" data-as-roleask="switch" class="primary">Switch</button></div>`
      : "";
    host.innerHTML = `
      <div class="as-group" data-as-roletop>
        <h4>Role <span class="as-hint" data-as-rolecount>${roles.length ? `${roles.length} role${roles.length === 1 ? "" : "s"} in this panel` : "no roles yet — Create role makes the first one"}</span></h4>
        <div class="as-line">
          <label class="as-role-field" title="which role this tab edits — the panel's role library. Picking one reads that role's own four fields; it changes no assistant">role
            <select id="as-role-pick" data-as-role-pick${roles.length ? "" : " disabled"}>${options}</select></label>
        </div>
      </div>
      <div class="as-group">
        <h4>What this role is for</h4>
        <p class="as-help">The name is what the picker, the board and every turn call this role; the description is the one line that says what it is for.</p>
        <div class="as-line">
          <label class="as-role-field" title="the role's name — 80 characters at most">name
            <input type="text" id="as-role-name" maxlength="80" spellcheck="false" placeholder="e.g. PR Reviewer" value="${esc(values.name)}"${off}></label>
        </div>
        <label class="as-role-caption" for="as-role-description">description</label>
        <textarea class="as-note-box" id="as-role-description" rows="2" maxlength="400" spellcheck="false" placeholder="what this role is for, in one line"${off}>${esc(values.description)}</textarea>
      </div>
      <div class="as-group">
        <h4>The prompt</h4>
        <p class="as-help">The prompt is the short instruction every turn of this role begins with.</p>
        <textarea class="as-note-box" id="as-role-prompt" rows="4" spellcheck="false" placeholder="e.g. Read the diff before you answer, and never approve your own work."${off}>${esc(values.prompt)}</textarea>
      </div>
      <div class="as-group">
        <h4>The charter</h4>
        <p class="as-help">The charter is the long tier, sent in full on the first turn, whenever it changes, and every twentieth turn.</p>
        <div class="as-charter-meta">
          <span class="as-hint${over ? " is-bad" : ""}" data-as-rolesize>${values.text.length}/${cap} chars${over ? ` — ${values.text.length - cap} over the cap, Save is refused` : pct >= 90 ? ` (${pct}%)` : ""}</span>
          <span class="as-hint" data-as-roleholds>${esc(roleHoldsLabel())}</span>
        </div>
        <textarea class="as-note-box as-charter-box" id="as-role-text" rows="14" spellcheck="false" placeholder="${loading ? "reading the role's charter…" : ""}"${off}>${esc(values.text)}</textarea>
        ${over ? `<div class="as-ask is-bad" id="as-role-cap" role="status"><b>${values.text.length.toLocaleString()} characters</b> — ${(values.text.length - cap).toLocaleString()} over the ${cap.toLocaleString()}-character cap. The panel refuses a save this size: prune the oldest changelog entries, then save.</div>` : ""}
      </div>
      ${ask}
      <div class="as-actions" data-as-roleactions>
        <button id="btn-as-role" type="button" class="primary"${doc && !over ? "" : " disabled"}>Save</button>
        <button id="btn-as-role-newrole" type="button" title="create a new role as a copy of this one, and open it here to rename">Create role</button>
        <button id="btn-as-new-assistant" type="button" title="make a new assistant that runs this role">New assistant from this role</button>
        <span class="as-hint" data-as-rolesave>${esc(roleSaveSentence())}</span>
        <span class="as-err" id="as-role-err">${esc(roleErr)}</span>
      </div>`;
  }

  // The charter cap, the provenance line and Save, repainted IN PLACE as the reader types. Not a full render: that
  // would rebuild a 20 KB textarea and take the caret with it.
  function paintRoleBox() {
    const doc = roleLoadedFor();
    if (!doc) return;
    const v = roleForm();
    const cap = Number(doc.cap) || 0;
    const over = cap > 0 && v.text.length > cap;
    const sizeEl = document.querySelector("#as-role [data-as-rolesize]");
    if (sizeEl) {
      sizeEl.textContent = `${v.text.length}/${cap} chars${over ? ` — ${v.text.length - cap} over the cap, Save is refused` : ""}`;
      sizeEl.classList.toggle("is-bad", over);
    }
    const holdEl = document.querySelector("#as-role [data-as-roleholds]");
    if (holdEl) holdEl.textContent = roleHoldsLabel();
    const saveHint = document.querySelector("#as-role [data-as-rolesave]");
    if (saveHint) saveHint.textContent = roleSaveSentence();
    const save = as$("btn-as-role");
    if (save) save.disabled = !doc || over;
    // The warning sits between the box and the buttons, so it is seen before the press it is about. It is created
    // once and removed when the text is pruned back under the cap.
    let warn = as$("as-role-cap");
    if (over && !warn) {
      warn = document.createElement("div");
      warn.className = "as-ask is-bad";
      warn.id = "as-role-cap";
      warn.setAttribute("role", "status");
      as$("as-role-text")?.insertAdjacentElement("afterend", warn);
    }
    if (warn && over) {
      warn.textContent = `${v.text.length.toLocaleString()} characters — ${(v.text.length - cap).toLocaleString()} over the ${cap.toLocaleString()}-character cap. The panel refuses a save this size: prune the oldest changelog entries, then save.`;
    } else if (warn) {
      warn.remove();
    }
  }

  // The boxes ARE the draft. Kept outside the DOM because the pane is rebuilt from state: a repaint has to paint the
  // reader's words back, never the text the last read landed.
  function noteRoleInput() {
    const doc = roleLoadedFor();
    if (!doc) return;
    const v = roleForm();
    roleDraft = v.name === doc.name && v.description === doc.description && v.prompt === doc.prompt && v.text === doc.text ? null : v;
    paintRoleBox();
  }

  // ---- end the role editor ---------------------------------------------------------------------------------------

  // ---- the initiatives tab ---------------------------------------------------------------------------------------
  // THE PANEL'S MAP OF THE BIG PIECES OF WORK. An initiative is a title, a description and the worktrees behind it,
  // and this pane is the whole of it: the read comes from GET /api/initiatives, the words are written straight back,
  // and a membership change is the ONE thing that leaves a question in the dock instead of happening here.
  //
  // WHY THE PANE KEEPS A DOCUMENT OF ITS OWN. The snapshot carries the membership (each row's `initiatives`) but not
  // the title, the description, the projects' names or the assistants' counts - and those are the tab. One small read
  // on demand is cheaper than growing the snapshot every project table already polls, and the read is re-taken after
  // every write and every answer to a move question, so the pane is never showing a map the server has moved on from.
  //
  // FOLDS ARE MODULE STATE, NOT DOM STATE. Every snapshot repaints this pane from `state.assistant`; a fold kept only
  // on the <details> element would pop open again on the next job event. The books below are read back by the
  // painter, so a project stays folded, an assistant list stays folded, one assistant's tasks stay open and a
  // half-typed title stays typed.
  const initFolds = new Set(); // `${initiativeId}::${projectName}` - projects are folded until the reader opens one
  const initAssistOpen = new Set(); // initiative ids whose assistant rows are unfolded
  // ONE FOLD PER ASSISTANT PER INITIATIVE, keyed `${initiativeId}::${assistantId}` (public/core/initiative-fold.js
  // `taskFoldKey`). It is the reader's own state, so it survives every repaint of the pane - a snapshot every couple
  // of seconds must not shut the list a reader is reading - and two assistants under one initiative fold apart.
  const initTaskOpen = new Set();
  // THE CARD NODES already drawn, keyed by the fold and then by task id, each carrying the signature of the row it was
  // drawn for: a card whose row has not moved is kept as the same element, and only a row whose state, title, thread,
  // clock or run changed is redrawn. The card's MARKUP is never written here - public/queue-cards.js's taskCardHtml
  // draws it, in compact mode, and this map only decides whether the node it drew last pass can stand.
  const initTaskNodes = new Map();
  // HOW MANY CARDS the reader has asked for, per fold: the fold opens at public/core/initiative-fold.js's
  // TASK_CARD_FIRST and one "show more" adds TASK_CARD_MORE. Module state, so the poll that repaints this pane cannot
  // shut a list the reader opened, and two assistants under one initiative grow apart.
  const initTaskShown = new Map();
  // ONE OPEN STATE PER INITIATIVE, in two books because the card and its description fold separately: `initOpen`
  // holds the initiatives the reader has unfolded (every card starts as a title card: a title, a two-line preview
  // and the counts), and `initDescClosed` holds the ones whose description the reader has folded back to that
  // preview while the card stayed open. Absent is the default in each, so neither book has to grow an entry for a
  // card nobody touched; both live as long as this tab does, which is what "remembered while the tab is open" means
  // and why a reload starts folded again.
  const initOpen = new Set();
  const initDescClosed = new Set();
  // The initiatives whose history is unfolded. Folded by default: the history is the evidence behind a removal, not
  // the first thing a card should spend its height on, and a card opened to read a title should not arrive with forty
  // lines of who did what.
  const initHistoryOpen = new Set();
  const initNotes = new Map(); // initiative id (or "new") -> { text, bad, requestId } - what the last write answered
  let initDoc = null; // the last document this pane read
  let initReadAt = 0; // when, for the freshness gap below
  let initLoading = false;
  let initErr = "";
  let initSeq = 0;
  let initNewOpen = false; // the create form
  let initEditId = ""; // the initiative whose words are in the edit form
  let initAddId = ""; // the initiative whose "add a worktree" picker is open
  let initDraft = { newTitle: "", newDesc: "", editTitle: "", editDesc: "", addTree: "" };
  // A read is not worth repeating on every 2 s snapshot, but it must not be stale either: four seconds is shorter
  // than the time it takes to open the tab, read a card and press Edit.
  const INIT_READ_GAP_MS = 4000;
  const initKey = (p) => normPath(p).toLowerCase();
  const initById = (id) => (initDoc?.initiatives || []).find((i) => i.id === id) || null;
  const initBlocked = () => Boolean(initDoc && initDoc.readable === false);

  function initNoteFor(id) {
    const n = initNotes.get(id);
    if (!n || !n.text) return "";
    // A note that says "answer in the dock" stops being true the moment the question is answered, and leaving it
    // standing would tell the reader to answer a card that is gone. The answered change is in the history by then.
    if (n.requestId && !(state.remoteWrites?.pending || []).some((p) => p.id === n.requestId)) {
      initNotes.delete(id);
      return "";
    }
    return `<div class="as-ask${n.bad ? " is-bad" : ""}" role="status">${esc(n.text)}</div>`;
  }
  function setInitNote(id, text, bad = false, requestId = "") {
    initNotes.set(id, { text: String(text || ""), bad, requestId: String(requestId || "") });
  }

  function loadInitiatives() {
    if (initLoading) return Promise.resolve();
    initLoading = true;
    const seq = ++initSeq;
    return apiFetch("/api/initiatives", {}, { timeoutMs: 12000 })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (seq !== initSeq) return;
        initDoc = d;
        initReadAt = Date.now();
        initErr = "";
      })
      .catch((err) => {
        if (seq !== initSeq) return;
        // A failed read says so and keeps the last document on screen: the tab is the only place the map exists, so
        // blanking it on one bad poll would look like the work was deleted.
        initErr = String((err && err.message) || err);
      })
      .finally(() => {
        if (seq !== initSeq) return;
        initLoading = false;
        // Not forced: a read that lands while the reader is typing must leave the box alone, and the words are in the
        // drafts, so the next paint (any snapshot) carries them back.
        if (state.assistantView.assistant === "initiatives") renderAssistantInitiatives();
      });
  }

  // Every write goes through here: one POST, the server's own sentence on a refusal (a 409 carries the store's
  // unreadable reason verbatim), and the tab repainted from the answer when the answer is the whole document.
  async function initPost(route, body) {
    const r = await apiFetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, { timeoutMs: 12000 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { data: d, status: r.status });
    return d;
  }
  // The read a write hands back (create and edit both return the whole document) is adopted as-is: a second read
  // would be a round trip for a fact the write already answered.
  function adoptInitiatives(d) {
    if (!d || !Array.isArray(d.initiatives)) return;
    initDoc = { ...d, at: d.at || new Date().toISOString() };
    initReadAt = Date.now();
    initErr = "";
  }

  // A PROJECT'S TREES, unfolded. Each row is a LINK to the board (the row itself, scrolled to and flashed) and one
  // Remove control that asks. A tree the board no longer carries is drawn dimmed rather than dropped: the initiative
  // still counts it, and this is the one place the reader can take it out.
  //
  // THE BRANCH is drawn by public/core/branch-link.js, the SAME renderer the chart's branch cell calls: a link to the
  // branch's page on the remote when the server resolved one for this tree, and the branch name as plain text when
  // it did not (no dead link). The route hands the tree the row's own `branchUrl`/`branchWhy`/`branchLinkFrom`, so
  // this pane holds no URL policy of its own. The link is an `<a>`, which the initiative press rule answers as
  // "self" (public/core/initiative-fold.js): following it changes nothing about the card's open state.
  function initTreeRowHtml(init, project, tree) {
    const name = String(tree.name || tree.path);
    const branch = String(tree.branch || "");
    // Who attached it, and when, is drawn on the Remove control: the `own` tier relaxes the question for a tree the
    // reader put here himself, so the actor has to be readable before the press, not only in the history fold.
    const attachedWho = String(tree.attachedBy || "");
    const attachedWhen = tree.attachedAt ? `${relTime(tree.attachedAt)} ago` : "";
    const attachedNote = attachedWho || attachedWhen
      ? ` - ${attachedWho === "reader" || !attachedWho ? "you" : attachedWho} attached it${attachedWhen ? ` ${attachedWhen}` : ""}`
      : " - no record of who attached it, so every tier that asks about removals asks";
    const link = tree.missing
      ? `<span class="init-tree-name is-missing" title="this path is no longer a worktree on the board - the initiative still counts it, and Remove takes it out">${esc(name)}</span>`
      : `<a href="#" class="init-tree-name" data-init-open="${esc(project)}|${esc(tree.path)}" title="open this worktree's row on the chart: its project unfolds, the window scrolls to it and the row flashes">${esc(name)}</a>`;
    return `<div class="init-tree" data-init-tree-row="${esc(tree.path)}">
      <div class="init-tree-main">
        ${link}
        <button type="button" class="init-mini init-detach" data-init-move="${esc(init.id)}|remove|${esc(tree.path)}"${initBlocked() ? " disabled" : ""} aria-label="remove ${esc(name)} from this initiative" title="take this worktree out of the initiative${esc(attachedNote)} - your tier decides whether that asks, and nothing changes until you answer if it does">Remove</button>
      </div>
      ${branch ? `<div class="init-tree-branch">${wtBranchLink.branchNameHtml({ branch, url: tree.branchUrl, linkFrom: tree.branchLinkFrom, why: tree.branchWhy, fallback: "the branch this worktree is on", linkClass: "chip init-branch mono init-branch-link", plainClass: "chip init-branch mono" })}</div>` : ""}
    </div>`;
  }

  // ONE ASSISTANT BESIDE ITS COUNTS, AND THE FOLD THAT OPENS ITS EXACT TASKS.
  // Four chips, in the order a task moves through them - queued, running, completed, parked - and all four always
  // drawn, zeros included: a strip that grew a chip the moment a count stopped being zero would shift the row
  // sideways every time work moved between the states. The order, the labels, the tones and the zero-marking are one
  // rule in public/core/initiative-fold.js (with a test beside it), so the strip cannot be drawn here with three of
  // the four or with a colour the rest of the panel does not use.
  // The counts come from the same queue read that feeds every other surface: GET /api/initiatives counts the rows
  // whose state is queued in the same pass it counts the other three.
  //
  // THE FOLD BESIDE THE NAME is a real button with the same chevron the tab's other folds use, and `aria-expanded`
  // says which way it goes. It sits inside the initiative card, so the card's press rule answers it as a control that
  // acts on itself (public/core/initiative-fold.js `press`): opening a list of tasks never folds the initiative out
  // from under the reader. Its open state is kept per initiative AND assistant, in `initTaskOpen`.
  function initAssistantRowHtml(init, a) {
    const c = a.counts || {};
    const running = Number(c.running) || 0;
    const chips = wtInitiativeFold
      .countChips(c)
      .map((chip) => `<span class="${chip.cls}" title="${esc(chip.title)}">${chip.text}</span>`)
      .join("");
    const who = String(a.name || a.id);
    const key = wtInitiativeFold.taskFoldKey(init.id, a.id);
    const tasksOpen = initTaskOpen.has(key);
    const n = Number(a.tasks) || (Array.isArray(a.taskRows) ? a.taskRows.length : 0);
    return `<div class="init-assist" data-init-assistant-row="${esc(a.id)}">
      <button type="button" class="init-assist-btn" data-init-assistant="${esc(a.id)}" data-init-thread="${esc(a.thread || "")}" title="open ${esc(who)}'s pane and put the cursor in its chat box - nothing is sent">${esc(who)}</button>
      <button type="button" class="init-proj init-assist-fold" data-init-task-fold="${esc(key)}" aria-expanded="${tasksOpen ? "true" : "false"}" aria-label="${esc(`${who}: ${tasksOpen ? "hide" : "show"} the ${n} task${n === 1 ? "" : "s"} on this initiative`)}" title="${tasksOpen ? "fold" : "unfold"} the exact tasks ${esc(who)} is doing on this initiative's worktrees - every queue row on its trees, newest activity first">
        <span class="init-caret">${tasksOpen ? "▾" : "▸"}</span>
        <span class="init-proj-name">tasks</span>
        <span class="chip is-zero" data-init-task-count>${n}</span>
      </button>
      <span class="as-hint init-assist-when">${running ? "working now" : a.lastAt ? `worked ${esc(relTime(a.lastAt))} ago` : "no stamped work yet"}</span>
      <span class="init-counts">${chips}</span>
      ${tasksOpen ? `<div class="init-tasks" data-init-tasks="${esc(key)}" data-init-task-own="${esc(a.id)}" aria-label="${esc(`the tasks ${who} is doing on this initiative`)}"></div>` : ""}
    </div>`;
  }

  // The task rows for one fold, from the document the pane last read: the initiative's assistant entry by id, so a
  // row the server did not count cannot be drawn and a row it counted cannot be missing. Absent means an empty list,
  // which the painter draws as the honest "nothing is filed here" line rather than a blank box.
  function initTaskRowsFor(key) {
    const at = String(key || "").indexOf("::");
    if (at < 0) return [];
    const init = initById(String(key).slice(0, at));
    const aid = String(key).slice(at + 2);
    const a = (init?.assistants || []).find((x) => x.id === aid) || null;
    return a && Array.isArray(a.taskRows) ? a.taskRows : [];
  }

  // What one card was drawn FROM, as one string: the five fields a compact card shows. A row that moved in any of them
  // is redrawn, and a row that did not keeps the element already on screen - the pane repaints on every snapshot, and
  // 169 cards rebuilt every few seconds would restart the list under a reader who is reading it.
  function initTaskSig(row) {
    return [row.state, row.title, row.thread, row.at, row.runId].join("|");
  }

  // Copy one freshly drawn compact card onto the element already on screen: its attributes (the state class, the
  // tooltip, the values its press reads) and its contents. The ROOT node is never replaced - it is the press target a
  // reader may have just tabbed onto, and a card that vanished under the caret would take the keyboard's place with it.
  // No card markup is written here: `html` is the renderer's own output, copied onto the node.
  //
  // Attributes are SET, never pruned. The compact mode emits the same set on every draw, so there is nothing stale to
  // remove - and pruning would delete whatever is not the renderer's: a probe a test hung on the node, a class another
  // surface added, the very marker that proves this node is the one that was there before.
  function refreshInitTaskCard(el, html) {
    const made = document.createElement("div");
    made.innerHTML = html;
    const next = made.firstElementChild;
    if (!next) return el;
    for (const attr of [...next.attributes]) el.setAttribute(attr.name, attr.value);
    el.innerHTML = next.innerHTML;
    return el;
  }

  // Reconcile every open fold's cards against this pass's document. THE CARD ITSELF is public/queue-cards.js's
  // taskCardHtml in its compact mode - the queue's own card, with no drag, no edit and no per-row button - so this
  // painter decides three things and nothing else: which rows are drawn (the fold's window, active states first), how
  // many (the reader's own count, six by default), and whether the node drawn last pass can stand (its signature).
  // `appendChild` on a node that is already a child MOVES it, which is how an order change costs a reorder and not a
  // redraw. The "show more" line is the fold's honest count: how many of how many, and what one press adds.
  function paintInitTaskLists(host) {
    if (!host) return;
    for (const box of host.querySelectorAll("[data-init-tasks]")) {
      const key = String(box.dataset.initTasks || "");
      const own = String(box.dataset.initTaskOwn || "");
      const rows = initTaskRowsFor(key);
      const win = wtInitiativeFold.taskCardWindow(rows, initTaskShown.get(key));
      let kept = initTaskNodes.get(key);
      if (!kept) {
        kept = new Map();
        initTaskNodes.set(key, kept);
      }
      const used = new Set();
      for (const row of win.visible) {
        const id = String(row.id ?? "");
        const sig = initTaskSig(row);
        let el = kept.get(id) || null;
        if (!el) {
          const made = document.createElement("div");
          made.innerHTML = taskCardHtml(row, "compact", { own }).trim();
          el = made.firstElementChild;
          if (!el) continue;
          kept.set(id, el);
        } else if (String(el.dataset.initCardSig || "") !== sig) {
          // The row moved, so every word on its card may have moved with it: one more draw from the same renderer,
          // copied onto the node already on screen.
          el = refreshInitTaskCard(el, taskCardHtml(row, "compact", { own }).trim());
        }
        el.dataset.initCardSig = sig;
        used.add(id);
        box.appendChild(el);
      }
      for (const [id, el] of kept) {
        if (used.has(id)) continue;
        el.remove();
        kept.delete(id);
      }
      // The one control under the cards, and the count beside it. It RETIRES when the fold shows everything: with
      // nothing hidden there is no control to draw, rather than a button that costs a line and does nothing.
      let more = box.querySelector(".init-tasks-more");
      if (win.hidden > 0) {
        if (!more) {
          more = document.createElement("div");
          more.className = "init-tasks-more";
          more.innerHTML = `<button type="button" class="init-mini" data-init-tasks-more></button><span class="as-hint" data-init-tasks-left></span>`;
        }
        const btn = more.querySelector("[data-init-tasks-more]");
        const left = more.querySelector("[data-init-tasks-left]");
        if (btn) {
          btn.dataset.initTasksMore = key;
          btn.textContent = `Show ${win.more} more`;
          btn.title = `draw the next ${win.more} card${win.more === 1 ? "" : "s"} - the fold opens at the ${wtInitiativeFold.TASK_CARD_FIRST} rows being acted on, then the most recent finished ones`;
        }
        if (left) left.textContent = `${win.visible.length} of ${win.total} shown - ${win.hidden} not shown`;
        box.appendChild(more);
      } else if (more) {
        more.remove();
      }
      const none = box.querySelector(".init-task-none");
      if (!rows.length) {
        if (!none) {
          const empty = document.createElement("div");
          empty.className = "as-hint init-task-none";
          empty.textContent = "no task is filed on this initiative's worktrees for this assistant right now";
          box.appendChild(empty);
        }
      } else if (none) {
        none.remove();
      }
    }
  }


  // The "add a worktree" picker: every row on the board that is not already in this initiative, grouped by project.
  // The list comes from the SAME rows the chart draws, so a tree that exists is offered and a tree that is gone is
  // not; the move itself is a question either way.
  function initAddFormHtml(init) {
    const mine = new Set((init.projects || []).flatMap((p) => p.trees.map((t) => t.key)));
    const byProject = new Map();
    for (const row of state.rows.values()) {
      const key = initKey(row.path);
      if (mine.has(key)) continue;
      if (!byProject.has(row.project)) byProject.set(row.project, []);
      byProject.get(row.project).push(row);
    }
    const groups = [...byProject.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([name, rows]) =>
          `<optgroup label="${esc(name)}">${rows
            .slice()
            .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
            .map((r) => `<option value="${esc(r.path)}" data-project="${esc(name)}">${esc(r.name || r.path)}</option>`)
            .join("")}</optgroup>`,
      )
      .join("");
    const none = groups ? "" : `<option value="">every worktree on the board is already here</option>`;
    // The button says what the press will do, because the level decides that and only the level: attaching asks only
    // at "ask me for everything", so at the other three the word "Ask" would promise a question that never comes.
    const asksAttach = String((initDoc.tier && initDoc.tier.id) || "all") === "all";
    return `<div class="init-form init-addform" data-init-addform="${esc(init.id)}">
      <label class="as-role-caption" for="as-init-add-${esc(init.id)}">worktree</label>
      <select id="as-init-add-${esc(init.id)}" data-init-field="addTree"${groups ? "" : " disabled"}>${none}${groups}</select>
      <div class="as-actions">
        <button type="button" class="primary" data-init-move="${esc(init.id)}|add|"${groups ? "" : " disabled"}>${asksAttach ? "Ask to add" : "Attach"}</button>
        <button type="button" data-init-cancel="add">Cancel</button>
        <span class="as-hint">${asksAttach ? "the question names the tree and the initiative" : "this level attaches at once, and the history records who and when"}</span>
      </div>
    </div>`;
  }

  // ---- the description's two-line preview, measured --------------------------------------------------------------
  // A DESCRIPTION FOLDS TO THE FIRST TWO LINES THE CARD ACTUALLY DRAWS. Which character that is, is a fact only the
  // browser has: `.init-desc` is pre-wrap prose at the rail's own 11.5px, so the break moves with the rail's width,
  // the zoom and the font. A character budget would be right at one width and wrong at the next. So the whole
  // description is painted and then cut, in the same task, before a frame of it is drawn: the two lines are
  // measured with a Range over its text node, the cut is backed up to a whole word (public/core/initiative-fold.js
  // `cut`, with a test), and the three dots are placed after the text they end.
  //
  // WHY NO RESTORE MACHINERY. A repaint rebuilds this pane from the store, so a folded body is always a NEW node
  // holding the whole description: nothing has to be put back. The one case that is not a new node is a rail dragged
  // to another width while the pane stands still, and that is what the width observer below re-cuts from the text
  // this pass remembers.
  let descCtx = null;
  const descFull = new WeakMap(); // a folded body -> the whole description it was drawn from, for a re-cut at a new width

  function initDotsWidth(el) {
    if (!descCtx && typeof document !== "undefined" && document.createElement) descCtx = document.createElement("canvas").getContext("2d");
    if (!descCtx) return 0;
    const cs = getComputedStyle(el);
    descCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return descCtx.measureText(wtInitiativeFold.DOTS).width;
  }

  // The last character that renders inside `lines` line boxes of this element, backed off until the dots fit after it
  // on the same row (three dots that did not fit would be clipped, or wrapped onto a third line of their own).
  function initDescCutAt(el, lines) {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3 || !node.data) return 0;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45 || 0;
    const box = el.getBoundingClientRect();
    const limitY = box.top + (parseFloat(cs.paddingTop) || 0) + lineHeight * lines;
    const maxX = box.left + el.clientWidth - (parseFloat(cs.paddingRight) || 0) - (parseFloat(cs.borderRightWidth) || 0);
    const dots = initDotsWidth(el);
    const range = document.createRange();
    const at = (i) => {
      range.setStart(node, Math.max(0, i - 1));
      range.setEnd(node, i);
      return range.getBoundingClientRect();
    };
    // Text flows down, so a character's bottom only grows with its offset: the last one inside the two line boxes is
    // one binary search, not a walk over 2000 characters.
    let lo = 0;
    let hi = node.data.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (at(mid).bottom <= limitY + 0.5) lo = mid;
      else hi = mid - 1;
    }
    while (lo > 0 && at(lo).right + dots > maxX) lo -= 1;
    return lo;
  }

  // One body, whole or folded, from its own full text. Idempotent in both directions: a body being re-measured is
  // measured on the whole description, never on what the last cut left on screen.
  function paintInitDescription(el, full) {
    const text = String(full == null ? "" : full);
    if (!el) return;
    descFull.set(el, text);
    el.textContent = text;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45 || 0;
    // A body with no layout (a pane that is not on screen) cannot be measured: it stays whole, and the next paint
    // - which a tab switch is - measures it.
    if (!lineHeight || !el.getClientRects().length) return;
    if (el.scrollHeight <= lineHeight * wtInitiativeFold.PREVIEW_LINES + 1) return; // fits its two lines: no dots
    const cut = wtInitiativeFold.cut(text, initDescCutAt(el, wtInitiativeFold.PREVIEW_LINES));
    if (!cut.truncated) return;
    el.textContent = cut.text;
    const dots = document.createElement("span");
    dots.className = "init-dots";
    dots.textContent = wtInitiativeFold.DOTS;
    el.appendChild(dots);
  }

  function paintInitDescriptions(host) {
    if (!host) return;
    for (const el of host.querySelectorAll("[data-init-desc-cut]")) paintInitDescription(el, descFull.has(el) ? descFull.get(el) : el.textContent);
  }

  function initCardHtml(init) {
    const blocked = initBlocked();
    const desc = String(init.description || "").trim();
    const projects = init.projects || [];
    const assistants = init.assistants || [];
    const editing = initEditId === init.id;
    const adding = initAddId === init.id;
    const open = initOpen.has(init.id);
    // A folded description is drawn as a body to be measured (`data-init-desc-cut`), never as text with an ellipsis
    // typed on: where line two stops is decided on the element, in paintInitDescription below.
    const descOpen = open && !initDescClosed.has(init.id);
    const assistantsOpen = initAssistOpen.has(init.id);
    const historyOpen = initHistoryOpen.has(init.id);
    const history = Array.isArray(init.history) ? init.history : [];
    const fold = (name) => initFolds.has(`${init.id}::${name}`);
    const projectsHtml = projects.length
      ? projects
          .map((p) => {
            const projOpen = fold(p.name);
            const trees = projOpen ? p.trees.map((t) => initTreeRowHtml(init, p.name, t)).join("") : "";
            return `<div class="init-project">
              <button type="button" class="init-proj" data-init-fold="${esc(init.id)}::${esc(p.name)}" aria-expanded="${projOpen ? "true" : "false"}" title="${projOpen ? "fold" : "unfold"} ${esc(p.name)}'s worktrees - a project is folded until you open it">
                <span class="init-caret">${projOpen ? "▾" : "▸"}</span>
                <span class="init-proj-name">${esc(p.name)}</span>
                <span class="chip" title="${p.trees.length} worktree${p.trees.length === 1 ? "" : "s"} in this project">${p.trees.length} tree${p.trees.length === 1 ? "" : "s"}</span>
              </button>
              ${projOpen ? `<div class="init-trees">${trees}</div>` : ""}
            </div>`;
          })
          .join("")
      : `<div class="init-none init-no-trees"><b>No worktrees yet</b><span>Add a worktree puts the first one here, and your tier decides whether it asks first</span></div>`;
    const assistHtml = assistants.length
      ? assistantsOpen
        ? `<div class="init-assists">${assistants.map((a) => initAssistantRowHtml(init, a)).join("")}</div>`
        : ""
      : `<div class="init-none init-no-assist"><span>no assistant has worked on these worktrees yet</span></div>`;
    const editHtml = editing
      ? `<div class="init-form" data-init-editform="${esc(init.id)}">
          <label class="as-role-caption" for="as-init-edit-title-${esc(init.id)}">title</label>
          <input type="text" id="as-init-edit-title-${esc(init.id)}" data-init-field="editTitle" maxlength="${Number(initDoc?.caps?.title) || 120}" spellcheck="false" value="${esc(initDraft.editTitle)}">
          <label class="as-role-caption" for="as-init-edit-desc-${esc(init.id)}">description</label>
          <textarea class="as-note-box" id="as-init-edit-desc-${esc(init.id)}" data-init-field="editDesc" rows="3" spellcheck="false" placeholder="what this piece of work is, in a line or two">${esc(initDraft.editDesc)}</textarea>
          <div class="as-actions">
            <button type="button" class="primary" data-init-save="${esc(init.id)}"${blocked ? " disabled" : ""}>Save words</button>
            <button type="button" data-init-cancel="edit">Cancel</button>
            <span class="as-hint">you and the assistants may edit these; your tier decides whether that asks first, and membership is the part it is really for</span>
          </div>
        </div>`
      : "";
    // THE DESCRIPTION, IN ITS TWO DRAWINGS. Unfolded, it is the whole text - pre-wrap, so its paragraph breaks come
    // through untouched. Folded, it is the first two lines with three dots where they stop, and its header says
    // which way the press goes. A card folded back to its title shows the same preview with NO header: there is
    // nothing inside a title card to fold, so that press belongs to the card itself.
    const descBody = desc
      ? descOpen
        ? `<p class="init-desc" data-init-desc-body="${esc(init.id)}">${esc(desc)}</p>`
        : `<p class="init-desc is-cut" data-init-desc-body="${esc(init.id)}" data-init-desc-cut>${esc(desc)}</p>`
      : `<p class="init-desc is-empty">no description yet - Edit says what this piece of work is</p>`;
    const descHtml = desc && open
      ? `<div class="init-descfold">
          <button type="button" class="init-proj init-desc-head" data-init-desc-fold="${esc(init.id)}" aria-expanded="${descOpen ? "true" : "false"}" title="the description ${descOpen ? "is whole - fold it back to its first two lines" : "is folded to its first two lines - unfold it for the whole thing, paragraph breaks and all"}. Enter or Space folds it too, and the card's own state is not touched">
            <span class="init-caret">${descOpen ? "▾" : "▸"}</span>
            <span class="init-proj-name">Description</span>
          </button>
          ${descBody}
        </div>`
      : descBody;
    return `<article class="as-group init-card${open ? "" : " is-titlecard"}" data-init-card="${esc(init.id)}">
      <div class="init-head">
        <button type="button" class="init-head-btn" data-init-card-toggle="${esc(init.id)}" aria-expanded="${open ? "true" : "false"}" title="this initiative ${open ? "is open - a press folds it back to its title card" : "is folded to its title card - a press unfolds it, and one open state is kept per initiative while the tab is open"}">
          <span class="init-title">${esc(init.title)}</span>
          <span class="init-caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
        </button>
        ${open ? `<button type="button" class="init-mini" data-init-edit="${esc(init.id)}"${blocked || editing ? " disabled" : ""} title="edit the title and the description - the words are free to change, unlike who is behind the work">Edit</button>` : ""}
      </div>
      ${descHtml}
      <div class="init-chips">
        <span class="chip" title="${init.projectCount} project${init.projectCount === 1 ? "" : "s"} this initiative spans">${init.projectCount} project${init.projectCount === 1 ? "" : "s"}</span>
        <span class="chip" title="${init.treeCount} worktree${init.treeCount === 1 ? "" : "s"} behind this piece of work">${init.treeCount} worktree${init.treeCount === 1 ? "" : "s"}</span>
        <span class="chip" title="${init.assistantCount} assistant${init.assistantCount === 1 ? "" : "s"} have worked on this initiative's worktrees">${init.assistantCount} assistant${init.assistantCount === 1 ? "" : "s"}</span>
        ${init.updatedAt ? `<span class="as-hint init-meta">edited ${esc(relTime(init.updatedAt))} ago${init.updatedBy && init.updatedBy !== "reader" ? ` by ${esc(init.updatedBy)}` : ""}</span>` : ""}
      </div>
      ${open
        ? `${editHtml}
      ${/* THE WAVE LANE (public/core/waves-lane.js). A lane inside this card, not a tab of its own: position, members and
           gate state, drawn from the same GET /api/initiatives read the rest of the card comes from. Every word is the
           server's fold - the state, the gate reads and which wave the stated order makes current - so a repaint cannot
           disagree with the route, and nothing here writes a wave. */ ""}
      ${wtWavesLane.laneHtml(init, initDoc?.waveStatus || null, esc)}
      <div class="init-side">
        <div class="init-sechead">Projects</div>
        <div class="init-projects">${projectsHtml}</div>
        <div class="init-addrow">
          ${adding ? initAddFormHtml(init) : `<button type="button" class="init-mini init-add" data-init-add="${esc(init.id)}"${blocked ? " disabled" : ""} title="put another worktree on this piece of work - your tier decides whether it asks, and a question names both the tree and the initiative">+ Add a worktree</button>`}
        </div>
      </div>
      <div class="init-assistfold">
        <button type="button" class="init-proj" data-init-assist-fold="${esc(init.id)}" aria-expanded="${assistantsOpen ? "true" : "false"}" title="${assistantsOpen ? "fold" : "unfold"} the assistants that worked on this initiative, newest first - folded, the card stays a map of the work">
          <span class="init-caret">${assistantsOpen ? "▾" : "▸"}</span>
          <span class="init-proj-name">Assistants</span>
          <span class="chip is-zero">${assistants.length}</span>
        </button>
        ${assistHtml}
      </div>
      <div class="init-histfold">
        <button type="button" class="init-proj" data-init-history-fold="${esc(init.id)}" aria-expanded="${historyOpen ? "true" : "false"}" title="${historyOpen ? "fold" : "unfold"} the history of this initiative: every attach, detach, create and edit, with the actor and the time - the record a removal is judged against, and one every tier writes">
          <span class="init-caret">${historyOpen ? "▾" : "▸"}</span>
          <span class="init-proj-name">History</span>
          <span class="chip is-zero">${history.length}</span>
        </button>
        ${historyOpen
          ? `<div class="init-history">${
              history.length
                ? history
                    .map((ev) => {
                      const line = wtInitiativeFold.historyLine(ev);
                      return `<div class="init-hist-row" data-init-hist-row="${esc(line.at || "")}" data-init-hist-actor="${esc(line.who)}"><span class="init-hist-what"><b class="init-hist-who">${esc(line.who)}</b> ${esc(line.what)}</span><span class="as-hint init-hist-when" title="${esc(line.at || "")}">${line.at ? `${esc(relTime(line.at))} ago` : "no time recorded"}</span></div>`;
                    })
                    .join("")
                : `<div class="as-hint init-hist-none">nothing recorded yet - the first change writes the first line</div>`
            }</div>`
          : ""}
      </div>`
        : ""}
      ${initNoteFor(init.id)}
    </article>`;
  }

  function initTyping() {
    const el = document.activeElement;
    if (!el || !el.closest || !el.closest("#as-initiatives")) return false;
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable;
  }

  // THE TAB KEEPS ITSELF CURRENT. A snapshot does not always repaint this pane (the rail's own render is driven by the
  // assistant's state, not by this tab), so a read triggered only from a render would leave the card showing a doc
  // fetched before the worktree scan filled in its branches. One timer, re-armed after every paint, holds the read at
  // the same four seconds: the pane is a view of a store that other surfaces write, and it must not go stale while it
  // is the thing on screen.
  let initTimer = null;
  function scheduleInitRefresh() {
    clearTimeout(initTimer);
    initTimer = setTimeout(() => {
      if (state.assistantView.assistant !== "initiatives") return;
      if (initTyping()) return scheduleInitRefresh();
      void loadInitiatives();
    }, INIT_READ_GAP_MS);
  }

  // FOCUS SURVIVES THE FOUR-SECOND REPAINT. The pane is rebuilt from a read on a timer, so a keyboard user who has
  // tabbed to a fold loses it every few seconds and the ring blinks out mid-task. The control is remembered by its
  // own data attribute (each one names the initiative, the fold or the tree it acts on), then found again by value in
  // the new markup and focused without scrolling. Inputs are already protected by initTyping(), so a caret is never
  // rebuilt; this is for the buttons a keyboard reaches.
  const INIT_FOCUS_ATTRS = [
    "data-init-card-toggle", "data-init-fold", "data-init-desc-fold", "data-init-assist-fold", "data-init-task-fold",
    "data-init-history-fold", "data-init-add", "data-init-edit", "data-init-move", "data-init-open", "data-init-new",
    "data-init-refresh", "data-init-task-card", "data-init-tasks-more", "data-init-assistant", "data-init-create",
    "data-init-save", "data-init-cancel", "data-init-field",
  ];
  let initKeyboardModality = false;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab" || e.key === "Enter" || e.key === " ") initKeyboardModality = true;
  }, true);
  document.addEventListener("pointerdown", () => { initKeyboardModality = false; }, true);
  function initFocusToken(host) {
    const el = document.activeElement;
    if (!el || !host.contains(el)) return null;
    for (const attr of INIT_FOCUS_ATTRS) {
      if (el.hasAttribute(attr)) return { attr, value: el.getAttribute(attr), keyboard: initKeyboardModality };
    }
    return el.id ? { id: el.id, keyboard: initKeyboardModality } : null;
  }
  function restoreInitFocus(host, token) {
    if (!token) return;
    const target = token.attr
      ? [...host.querySelectorAll(`[${token.attr}]`)].find((n) => n.getAttribute(token.attr) === token.value)
      : document.getElementById(token.id);
    if (!target || target === document.activeElement) return;
    target.focus({ preventScroll: true });
    // A script focus after a rebuild does not always paint `:focus-visible` in Chromium even when the reader reached
    // the control with Tab. The token knows the last input was the keyboard, so the ring is re-applied for exactly as
    // long as that control keeps focus, and the next Tab paints its own.
    if (!token.keyboard) return;
    target.classList.add("init-focus-restored");
    target.addEventListener("blur", () => target.classList.remove("init-focus-restored"), { once: true });
  }

  function renderAssistantInitiatives(force = false) {
    const host = as$("as-initiatives");
    if (!host) return;
    // The pane is rebuilt on every snapshot; a caret in one of its boxes means the reader is writing, and a repaint
    // would take the sentence with it. The drafts above paint the words back when the render does run, and an action
    // the reader just pressed (force) paints at once - a button is never protected, only a box being typed in.
    if (!force && initTyping()) return;
    if (!initDoc && !initLoading && !initErr) void loadInitiatives();
    else if (initDoc && !initLoading && Date.now() - initReadAt > INIT_READ_GAP_MS) void loadInitiatives();
    if (!initDoc) {
      host.innerHTML = initErr
        ? `<div class="as-empty">could not read the initiatives: ${esc(initErr)}</div><div class="as-actions"><button type="button" data-init-refresh>Try again</button></div>`
        : `<div class="as-empty">reading the initiatives…</div>`;
      return;
    }
    const list = initDoc.initiatives || [];
    const unreadable = initDoc.readable === false;
    const storeLine = unreadable
      ? `<div class="as-ask is-bad" role="alert"><b>The initiative store cannot be read, so nothing may be written.</b> ${esc(initDoc.error || "")} The file is left exactly as it is: fix or move it, then try again.</div>`
      : initDoc.found === false
        ? `<p class="as-help">nothing saved yet - the first initiative creates <span class="mono">${esc(String(initDoc.file || "initiatives.json").split(/[\\/]/).pop())}</span> beside the panel's other state</p>`
        : `<p class="as-help">${list.length} initiative${list.length === 1 ? "" : "s"} in <span class="mono" title="${esc(initDoc.file || "")}">${esc(String(initDoc.file || "initiatives.json").split(/[\\/]/).pop())}</span></p>`;
    const newForm = initNewOpen
      ? `<div class="init-form" data-init-newform>
          <label class="as-role-caption" for="as-init-new-title">title</label>
          <input type="text" id="as-init-new-title" data-init-field="newTitle" maxlength="${Number(initDoc.caps?.title) || 120}" spellcheck="false" placeholder="e.g. SSO migration" value="${esc(initDraft.newTitle)}">
          <label class="as-role-caption" for="as-init-new-desc">description</label>
          <textarea class="as-note-box" id="as-init-new-desc" data-init-field="newDesc" rows="3" spellcheck="false" placeholder="what this piece of work is, in a line or two">${esc(initDraft.newDesc)}</textarea>
          <div class="as-actions">
            <button type="button" class="primary" data-init-create${unreadable ? " disabled" : ""}>Create initiative</button>
            <button type="button" data-init-cancel="new">Cancel</button>
            <span class="as-hint">a title is enough; the description can come later</span>
          </div>
          ${initNoteFor("new")}
        </div>`
      : "";
    const empty = list.length
      ? ""
      : `<div class="as-empty init-empty" data-init-empty>
          <h5>No initiatives yet</h5>
          <p class="init-empty-copy">An initiative is a title, a description and the worktrees behind it. One may span several projects and several assistants, and a worktree with none is normal: nothing is enforced.</p>
          <div class="as-actions"><button type="button" class="primary" data-init-new="empty"${unreadable ? " disabled" : ""}>New initiative</button></div>
        </div>`;
    const tier = initDoc.tier && initDoc.tier.id ? initDoc.tier : { id: "all", label: "ask me for everything", hint: "every create, edit, attach and detach waits for your answer" };
    const focusToken = initFocusToken(host);
    host.innerHTML = `
      <div class="as-group">
        <h4>Initiatives <span class="as-hint">the big pieces of work, and the worktrees behind each one</span></h4>
        <p class="as-help">You and the assistants create and edit initiatives; the tier below decides whether a change asks you first. Every change records the actor and the time.</p>
        ${storeLine}
        <p class="as-help init-tier" data-init-tier="${esc(tier.id)}">Initiative changes: <b>${esc(tier.label)}</b> - ${esc(tier.hint)}. Settings, Board tab changes the level.</p>
        <div class="as-actions">
          <button type="button" data-init-new="head"${unreadable ? " disabled" : ""}${initNewOpen ? " hidden" : ""}>New initiative</button>
          <button type="button" data-init-refresh title="read the store again - the tab also re-reads after every write and every answered move">Refresh</button>
          <span class="as-hint">${initLoading ? "reading…" : initErr ? `read failed: ${esc(initErr)}` : ""}</span>
        </div>
        ${newForm}
      </div>
      ${empty}
      ${list.map(initCardHtml).join("")}`;
    // The markup carries every folded description whole; the paint that folds it to its two lines happens here, in
    // the same task, so no frame is drawn with the wall of text the fold exists to hide.
    paintInitDescriptions(host);
    // The open task folds are filled here, from the document above, RECONCILED against the nodes the last pass drew:
    // a row already on screen is patched where it stands, never rebuilt. The pane repaints on every snapshot, so a
    // rebuild would restart each row every couple of seconds under a reader's eyes.
    paintInitTaskLists(host);
    restoreInitFocus(host, focusToken);
    scheduleInitRefresh();
  }

  // A worktree LINK: the board's own row, unfolded, scrolled to and flashed. `hotOpenPath` is the page's one "open
  // this row" (it opens the root group, the project and the row's detail), so this does not grow a second opinion
  // about what opening a row means. The scroll and the pulse are the tab's addition: the reader pressed a name in a
  // narrow rail, and the row it names may be far down a long board.
  function openInitiativeTree(project, treePath) {
    const want = initKey(treePath);
    const row =
      state.rows.get(keyOf(project, treePath)) ||
      [...state.rows.values()].find((r) => r.project === project && initKey(r.path) === want) ||
      [...state.rows.values()].find((r) => initKey(r.path) === want);
    if (!row) {
      showBanner("that worktree is no longer on the board - the initiative still counts it; Remove takes it out");
      return false;
    }
    hotOpenPath(row);
    const key = keyOf(row.project, row.path);
    // hotOpenPath opens the project and the row through the page's own render, which may paint on the next frame; the
    // scroll and the pulse wait one frame rather than reading a node the render has not placed yet.
    const land = () => {
      const tr = rowNode(key);
      if (!tr) return false;
      tr.scrollIntoView({ block: "center", behavior: "auto" });
      pulseRow(key);
      return true;
    };
    if (!land()) requestAnimationFrame(land);
    return true;
  }

  // An assistant's NAME in the card: that assistant's pane on screen, its Chat selected, and the caret in the box it
  // types into. The box is the thread's own reply box when the assistant has a thread on screen, and its intro box
  // when it is new (nothing has been asked of it yet) - the same pair the chat pane itself draws, never a guess. The
  // caret goes to the END of what is there: pressing a name must not overwrite a draft the reader left in it.
  function focusInitiativeAssistant(id, thread) {
    const own = String(id || "");
    if (!showAssistantPane(own, "chat")) return false;
    const want = String(thread || "");
    const chat = as$("as-chat");
    const box =
      (want ? chat?.querySelector(`.reply-box[data-reply="${CSS.escape(want)}"]`) : null) ||
      chat?.querySelector(".reply-box[data-reply]") ||
      as$(firstBoxId(own));
    if (!box) return false;
    box.focus({ preventScroll: true });
    setCaretOffset(box, readBox(box).length);
    box.scrollIntoView({ block: "center", behavior: "auto" });
    return document.activeElement === box;
  }

  // All three writes the tab makes, in one place. `action` is add or remove and the tree is the select's value for an
  // add - read from the DOM at the press, because the picker is the reader's choice and a repaint may have moved the
  // draft.
  async function initMove(id, action, treeRaw) {
    const init = initById(id);
    if (!init) return;
    const tree = String(treeRaw || "").trim();
    if (!tree) {
      setInitNote(id, "choose a worktree first - the question names the tree it will move", true);
      renderAssistantInitiatives(true);
      return;
    }
    try {
      const d = await initPost("/api/initiatives/move", { tree, initiative: id, action });
      adoptInitiatives(d);
      const leaf = tree.split(/[\\/]/).pop();
      // 202 is the question, not the move: the store has not changed, and saying "moved" here would be a lie the card
      // in the dock is about to contradict. A 200 with `changed: true` is the level that does not ask, and its own
      // history line is the proof it happened.
      if (d.asked) {
        setInitNote(id, `${d.note || "asked - answer in the dock, bottom right"} (${action === "add" ? `add ${leaf}` : `remove ${leaf}`})`, false, d.id);
      } else if (d.changed === false) {
        setInitNote(id, action === "add" ? "that worktree is already in this initiative" : "that worktree is not in this initiative", false);
      } else {
        setInitNote(id, `${action === "add" ? "attached" : "removed"} ${leaf} - recorded in the history with who did it and when`, false);
      }
      initAddId = "";
      initDraft.addTree = "";
    } catch (err) {
      setInitNote(id, String((err && err.message) || err), true);
    }
    renderAssistantInitiatives(true);
  }

  async function initCreate() {
    const title = String(initDraft.newTitle || "").trim();
    const description = String(initDraft.newDesc || "");
    if (!title) {
      setInitNote("new", "an initiative needs a title - one line saying what the work is", true);
      renderAssistantInitiatives(true);
      return;
    }
    try {
      const d = await initPost("/api/initiatives", { title, description });
      adoptInitiatives(d);
      if (d.asked) {
        // Nothing exists yet: the form keeps its words, so answering the card creates the initiative the reader was
        // writing, and a Deny leaves the draft exactly where it is.
        setInitNote("new", `${d.note || "asked - answer in the dock, bottom right"} (create "${title}")`, false, d.id);
        renderAssistantInitiatives(true);
        return;
      }
      initNewOpen = false;
      initDraft.newTitle = "";
      initDraft.newDesc = "";
      initNotes.delete("new");
      setInitNote(d.initiative?.id || "", "created - Edit changes the words, Add a worktree starts the work", false);
    } catch (err) {
      setInitNote("new", String((err && err.message) || err), true);
    }
    renderAssistantInitiatives(true);
  }

  async function initEditSave(id) {
    const title = String(initDraft.editTitle || "").trim();
    const description = String(initDraft.editDesc || "");
    if (!title) {
      setInitNote(id, "an initiative needs a title - clearing it would leave a piece of work with no name", true);
      renderAssistantInitiatives(true);
      return;
    }
    try {
      const d = await initPost("/api/initiatives/update", { id, title, description });
      adoptInitiatives(d);
      if (d.asked) {
        setInitNote(id, `${d.note || "asked - answer in the dock, bottom right"} (edit "${title}")`, false, d.id);
      } else {
        initEditId = "";
        setInitNote(id, d.changed === false ? "nothing changed - the words are the same ones" : "saved", false);
      }
    } catch (err) {
      setInitNote(id, String((err && err.message) || err), true);
    }
    renderAssistantInitiatives(true);
  }

  // One listener set for the life of the page, on the pane's own host: the cards inside it are rebuilt constantly, and
  // a listener per card would be a listener per snapshot.
  function wireInitiativesPane() {
    const host = as$("as-initiatives");
    if (!host) return;
    host.addEventListener("click", (e) => {
      // WHAT THIS PRESS MEANS comes first, and it is a rule with a test rather than the order of the branches
      // below: the title card folds the initiative, the description's header folds only the description, and every
      // control inside the card - a project fold, a worktree link, an assistant's name, Edit - acts on itself and
      // leaves the card's open state alone. Deciding it here means a control added later cannot start folding cards
      // by accident: it is a button, so it answers for itself.
      const card = e.target && e.target.closest ? e.target.closest("[data-init-card]") : null;
      const head = card ? card.querySelector("[data-init-card-toggle]") : null;
      const cardOpen = String(head?.getAttribute("aria-expanded") || "") === "true";
      const kind = wtInitiativeFold.press(e.target, { card, open: cardOpen });
      if (kind === "card") {
        const id = String(card?.dataset.initCard || "");
        if (!id) return;
        if (initOpen.has(id)) initOpen.delete(id);
        else initOpen.add(id);
        renderAssistantInitiatives(true);
        return;
      }
      if (kind === "description") {
        const id = String(e.target.closest("[data-init-desc-fold]")?.dataset.initDescFold || "");
        if (!id) return;
        if (initDescClosed.has(id)) initDescClosed.delete(id);
        else initDescClosed.add(id);
        renderAssistantInitiatives(true);
        return;
      }
      if (kind !== "self") return;
      const el = e.target.closest("[data-init-fold], [data-init-assist-fold], [data-init-task-fold], [data-init-history-fold], [data-init-task-card], [data-init-tasks-more], [data-init-open], [data-init-edit], [data-init-add], [data-init-cancel], [data-init-create], [data-init-save], [data-init-move], [data-init-assistant], [data-init-new], [data-init-refresh]");
      if (!el) return;
      // THE QUEUE'S OWN CARD, PRESSED IN THE INITIATIVES TAB. It is the same card the queue draws, in its compact
      // read-only mode, so the press does what the card can no longer do for itself: it opens that task in its REAL
      // queue - the assistant's pane on the queue sub-tab, the row widened into the window, centred in the pane's
      // scroller and flashed - which is the walk the console's `#405` anchors and the chart's owner chips take
      // (`openTaskRef`), not a second set of controls grown inside this tab.
      if (el.hasAttribute("data-init-task-card")) {
        e.preventDefault();
        void openTaskRef(String(el.dataset.initTaskOwn || ""), String(el.dataset.initTaskCard || ""));
        return;
      }
      // ONE MORE SLICE OF THE FOLD. The window is the tab's own (public/core/initiative-fold.js `taskCardWindow`), so
      // this press owes no route: it asks the painter for TASK_CARD_MORE more cards and repaints from the document the
      // pane already holds.
      if (el.dataset.initTasksMore) {
        e.preventDefault();
        const key = String(el.dataset.initTasksMore);
        initTaskShown.set(key, (initTaskShown.get(key) || wtInitiativeFold.TASK_CARD_FIRST) + wtInitiativeFold.TASK_CARD_MORE);
        renderAssistantInitiatives(true);
        return;
      }
      if (el.hasAttribute("data-init-open")) {
        e.preventDefault();
        const [project, ...rest] = String(el.dataset.initOpen || "").split("|");
        openInitiativeTree(project, rest.join("|"));
        return;
      }
      if (el.dataset.initFold) {
        const key = String(el.dataset.initFold);
        if (initFolds.has(key)) initFolds.delete(key);
        else initFolds.add(key);
        renderAssistantInitiatives(true);
        return;
      }
      if (el.dataset.initAssistFold) {
        const id = String(el.dataset.initAssistFold);
        if (initAssistOpen.has(id)) initAssistOpen.delete(id);
        else initAssistOpen.add(id);
        renderAssistantInitiatives(true);
        return;
      }
      // ONE ASSISTANT'S TASKS, opened and shut by the reader. The key is the initiative AND the assistant, so a press
      // here never grows or shuts another assistant's list, and the state lives in the module, so the repaint that
      // follows this press (and every snapshot after it) draws the same open fold.
      if (el.dataset.initTaskFold) {
        const key = String(el.dataset.initTaskFold);
        if (initTaskOpen.has(key)) initTaskOpen.delete(key);
        else initTaskOpen.add(key);
        renderAssistantInitiatives(true);
        return;
      }
      if (el.dataset.initHistoryFold) {
        const id = String(el.dataset.initHistoryFold);
        if (initHistoryOpen.has(id)) initHistoryOpen.delete(id);
        else initHistoryOpen.add(id);
        renderAssistantInitiatives(true);
        return;
      }
      if (el.dataset.initAssistant) {
        focusInitiativeAssistant(String(el.dataset.initAssistant), String(el.dataset.initThread || ""));
        return;
      }
      if (el.dataset.initEdit) {
        const init = initById(String(el.dataset.initEdit));
        if (!init) return;
        initEditId = init.id;
        initAddId = "";
        initDraft.editTitle = init.title;
        initDraft.editDesc = init.description || "";
        renderAssistantInitiatives(true);
        as$(`as-init-edit-title-${init.id}`)?.focus();
        return;
      }
      if (el.dataset.initAdd) {
        initAddId = String(el.dataset.initAdd);
        initEditId = "";
        initDraft.addTree = "";
        renderAssistantInitiatives(true);
        return;
      }
      if (el.dataset.initCancel === "new") {
        initNewOpen = false;
        initNotes.delete("new");
        renderAssistantInitiatives(true);
        return;
      }
      if (el.dataset.initCancel === "edit") {
        initEditId = "";
        renderAssistantInitiatives(true);
        return;
      }
      if (el.dataset.initCancel === "add") {
        initAddId = "";
        renderAssistantInitiatives(true);
        return;
      }
      if (el.hasAttribute("data-init-new")) {
        initNewOpen = true;
        initEditId = "";
        initAddId = "";
        renderAssistantInitiatives(true);
        as$("as-init-new-title")?.focus();
        return;
      }
      if (el.hasAttribute("data-init-refresh")) {
        initDoc = null;
        initErr = "";
        initReadAt = 0;
        renderAssistantInitiatives(true);
        return;
      }
      if (el.hasAttribute("data-init-create")) {
        void initCreate();
        return;
      }
      if (el.dataset.initSave) {
        void initEditSave(String(el.dataset.initSave));
        return;
      }
      if (el.dataset.initMove) {
        const [id, action, ...rest] = String(el.dataset.initMove).split("|");
        // An add reads the picker at the press; a remove carries its tree in the attribute, so it cannot depend on a
        // select that is not on screen.
        const tree = action === "add" ? String(host.querySelector(`[data-init-addform="${CSS.escape(id)}"] [data-init-field="addTree"]`)?.value || "") : rest.join("|");
        void initMove(id, action, tree);
      }
    });
    // A card is a `role="button"` on a div, so Enter and Space are the press it advertises and the browser will not
    // synthesise one. Only the card itself is answered: a key pressed in the fold's fields inside the card must type,
    // not open a task.
    host.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target && e.target.closest ? e.target.closest("[data-init-task-card]") : null;
      if (!card) return;
      e.preventDefault();
      void openTaskRef(String(card.dataset.initTaskOwn || ""), String(card.dataset.initTaskCard || ""));
    });
    // The words are kept outside the DOM: a snapshot repaints the card under the caret, and a draft the painter cannot
    // read back would erase what the reader had typed.
    host.addEventListener("input", (e) => {
      const field = e.target.closest("[data-init-field]");
      if (!field) return;
      const which = String(field.dataset.initField || "");
      if (which === "newTitle" || which === "newDesc" || which === "editTitle" || which === "editDesc") initDraft[which] = String(field.value ?? "");
    });
    host.addEventListener("change", (e) => {
      const field = e.target.closest("[data-init-field]");
      if (field && field.dataset.initField === "addTree") initDraft.addTree = String(field.value ?? "");
    });
    // A RAIL DRAGGED TO ANOTHER WIDTH MOVES THE LINE BREAK, so a folded description is re-cut when the pane's width
    // changes: the text comes back from the book the pass keeps, never from what the last cut left on screen. The
    // guard on the width is what stops the re-cut (which changes the pane's height, not its width) from looping.
    if (typeof ResizeObserver === "function") {
      let seenW = 0;
      new ResizeObserver(() => {
        if (!host.isConnected) return;
        const w = host.clientWidth;
        if (!w || w === seenW) return;
        seenW = w;
        paintInitDescriptions(host);
      }).observe(host);
    }
    // The dock's answer to a move question: the store has moved (or not), so the tab re-reads. The detail carries the
    // question's kind, which is how a push's answer does not cause a read this pane does not need.
    window.addEventListener("wtgui:remote-write-answered", (e) => {
      if (String(e?.detail?.kind || "") !== "initiative") return;
      initReadAt = 0;
      if (state.assistantView.assistant === "initiatives") void loadInitiatives();
    });
  }

  // ---- end the initiatives tab -----------------------------------------------------------------------------------


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
        <div class="as-help">${a.sweeps.lastHour}/${a.sweeps.limit} sweep wakes in the last hour — events are never budgeted${a.wakePending ? ` · ${a.wakePending} queued behind the running turn` : ""} · model at ${esc(a.settings.model || "(gateway default model)")}</div>
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

  // ---- the hard restart: one assistant, a fresh thread, two presses -------------------------------
  //
  // The row's three states are all in the markup and toggled with `hidden`, never swapped: this pane is rebuilt on
  // every snapshot, and a button that replaces itself mid-click is how a drawer closes under the press. The armed
  // state lives in the float's `hardRestartArmed` set, so a repaint between the two presses keeps the question up.
  //
  // The first press does NOTHING but arm: it sets the flag, and the flag is the whole effect. Only the second press
  // calls the route. That is the contract the reader asked for — one click arms, a second "Are you sure?" click does
  // it — and it is why this is not `window.confirm`, which the browser can suppress.
  function hardRestartRowHtml(id, rec, { armed = false, note = "", live = false } = {}) {
    const now = String(rec?.threadId || "");
    const was = Array.isArray(rec?.previousThreads) && rec.previousThreads.length ? rec.previousThreads[0] : "";
    const from = was && was !== now ? `${esc(was)} → ` : "";
    return `
      <div class="as-group" data-as-hardrestart-group="${esc(id)}">
        <h4>Hard restart — a fresh thread for this assistant</h4>
        <div class="as-help">Clears THIS assistant's carried thread context and starts a fresh Hermes thread for it, so
        its next turn is the first turn of a new session and nothing of the old conversation comes with it. It moves
        <code>${from}${esc(now)}</code>; its queue, watches, charter, rules, settings and alerts are kept. The panel and
        the gateway are <b>not</b> restarted, and no other assistant's thread is touched.
        ${live ? "A turn is running — stop it first; a hard restart never moves the thread under a live run." : ""}</div>
        <div class="as-line">
          <button type="button" data-as-hardrestart="${esc(id)}" title="clear this assistant's carried thread context and start a fresh Hermes thread — no panel restart, no gateway restart"${armed ? " hidden" : ""}>Hard restart</button>
          <button type="button" data-as-hardrestart-cancel="${esc(id)}" title="keep the thread it has now"${armed ? "" : " hidden"}>Cancel</button>
          <button type="button" data-as-hardrestart-go="${esc(id)}" title="the second press does it: this assistant moves to a new thread now"${armed ? "" : " hidden"}>Are you sure? Start a fresh thread</button>
          <span class="as-hint" data-as-hardrestart-note="${esc(id)}">${esc(note || `thread ${now}${live ? " · a turn is running — stop it first" : ""}`)}</span>
          <span class="as-err" id="as-hardrestart-err-${esc(String(id).replace(/^assistant-/, ""))}"></span>
        </div>
      </div>`;
  }
  // ---- end the hard restart -----------------------------------------------------------------------

  // ---- delete one assistant: two presses, an archive, and the bottom of its Settings tab ----------
  //
  // The destructive pair the hard restart does not cover: a hard restart KEEPS every file, a delete takes
  // the assistant out of the roster. Drawn only for Assistant #2 and up (#1 is the panel's own session and
  // the route refuses it by name), and the second press names the assistant and exactly what goes: its
  // record, its queue, its charter and its notes, which are archived rather than erased.
  //
  // The armed state lives in the float's `deleteArmed` map, not on the button: this pane is rebuilt on every
  // snapshot, and a DOM flag would be replaced under the reader's second press. The map holds the DRY RUN's
  // plan, so the confirmation can name the archive folder the real press will write.
  function deleteRowHtml(id, rec, { first = false, armed = false, plan = null, note = "" } = {}) {
    // Assistant #1 is the panel's own session: the row is not drawn at all, and the route refuses it by name.
    if (first) return "";
    const n = String(id).replace(/^assistant-/, "");
    const who = rec?.name || `Assistant #${n}`;
    const at = String(plan?.archive?.dir || "");
    const goes = Array.isArray(plan?.removes) && plan.removes.length ? plan.removes.join(", ") : "record.json, queue.json, charter.md, notes.md";
    return `
      <div class="as-group as-delete" data-as-delete-group="${esc(id)}">
        <h4>Delete this assistant</h4>
        <div class="as-help">Takes <b>${esc(who)}</b> out of the roster and off this float's tab row. Its <b>record</b>,
        its <b>queue</b>, its <b>charter</b> and its <b>notes</b> are copied to a timestamped folder under the panel's
        state directory — not deleted. Its Hermes thread and its transcript stay with the gateway. A live run or an
        open queue row refuses the delete and says which one; Assistant #1 is the panel's own and has no row here.</div>
        <div class="as-line">
          <button type="button" class="as-danger" data-as-delete="${esc(id)}" title="delete ${esc(who)} — two presses, and the second names exactly what is removed"${armed ? " hidden" : ""}>Delete ${esc(who)}…</button>
          <button type="button" data-as-delete-cancel="${esc(id)}" title="keep ${esc(who)} and close this question"${armed ? "" : " hidden"}>Cancel</button>
          <button type="button" class="as-danger" data-as-delete-go="${esc(id)}" title="the second press does it: ${esc(who)}'s record, queue, charter and notes are archived and it leaves the roster"${armed ? "" : " hidden"}>Delete ${esc(who)} and archive its record, queue, charter and notes</button>
          <span class="as-hint" data-as-delete-note="${esc(id)}">${esc(note)}</span>
        </div>
        ${armed ? `<div class="as-help" data-as-delete-what="${esc(id)}">Second press: removes <b>${esc(who)}</b> from the roster and archives <b>${esc(goes)}</b>${at ? ` to <code>${esc(at)}</code>` : ""}. Nothing is erased.</div>` : ""}
        <div class="as-err" id="as-delete-err-${esc(n)}"></div>
      </div>`;
  }
  // ---- end delete one assistant -------------------------------------------------------------------

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
    // THE ROLE THIS ASSISTANT RUNS. The list is the server's own library (`state.assistant.roles`) and the current
    // value is the RECORD's `roleId` — not a page copy, so two tabs cannot disagree about the job. This is the one
    // control that changes a role; the Role tab's picker only chooses which role's charter it shows, read-only. A
    // library with no rows still shows the role the record names rather than an empty box.
    const roles = Array.isArray(a.roles) ? a.roles : [];
    const roleNow = String(rec?.roleId || "");
    const roleNameNow = String(rec?.roleName || "");
    const roleOptions = roles.length
      ? roles.map((r) => `<option value="${esc(r.id)}"${r.id === roleNow ? " selected" : ""}>${esc(r.name)}</option>`).join("")
      : `<option value="${esc(roleNow)}">${esc(roleNameNow || "(no role)")}</option>`;
    // The line under the row: the save's "press Restart" sentence or the restart's own account of what it rebuilt.
    // Kept on the pane's own element (not in a page map) so a repaint of the markup keeps it, a panel reload drops it
    // with the server-side send records it describes, and the function sliced by test/assistant-thresholds.js needs no
    // outer helper it cannot see.
    const roleRestartNote = String((host.dataset && host.dataset.roleRestartNote) || "");
    // The rename row's own answer — "Saved…" or "that is already its name" — kept the same way: on the pane's element,
    // so it survives this function's repaint and dies with a page reload that no longer needs it.
    const nameNote = String((host.dataset && host.dataset.nameNote) || "");
    host.innerHTML = `
      <div class="as-group" id="as-rename-${esc(n)}">
        <h4>Its name</h4>
        <div class="as-help">What this assistant is called on its tab and in this float's header. The <b>id</b> does not
        change: it stays <code>${esc(id)}</code>, so a rename moves nothing — not its queue, not its thread, not its
        charter and not its state directory. Duplicate names are fine; the id is what tells two apart.</div>
        <div class="as-line">
          <label>name <input type="text" id="as-name-text-${esc(n)}" data-as-namefor="${esc(id)}" spellcheck="false"
            maxlength="40" value="${esc(rec?.name || "")}" placeholder="${esc(`Assistant #${n}`)}"
            title="up to 40 characters — trimmed, and refused if it is only spaces"></label>
          <button type="button" class="primary" data-as-namesave="${esc(id)}" title="save this name on ${esc(rec?.name || "this assistant")}'s record — the tab and the float's header repaint at once">Save name</button>
          <button type="button" data-as-namecancel="${esc(id)}" title="put the stored name back in the box and leave the record alone">Cancel</button>
        </div>
        <div class="as-line">
          <span class="as-hint" data-as-namestatus="${esc(id)}">${esc(nameNote)}</span>
          <span class="as-err" id="as-name-err-${esc(n)}"></span>
        </div>
      </div>
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
      <div class="as-group" data-as-rolepanel="${esc(id)}">
        <h4>The role it runs <span class="as-hint" data-as-rolename>${esc(roleNameNow || "(no role)")}</span></h4>
        <div class="as-help">The role is the job this assistant's turns are told they are doing. Picking one writes
        <code>roleId</code> on this assistant's own record and nothing else: the charter text stays this assistant's
        own copy, which the <b>Role</b> tab edits and saves. This row is the one place a role is changed — the Role
        tab's picker only chooses which role's charter it SHOWS, read-only, and assigns nothing. <b>Restart role</b> is the press that applies it to the next turn: it
        rebuilds THIS assistant's turn context from the role now on the record, so the charter, the board digest and
        the queue digest go in full again under the new role. It does not restart the panel, the gateway, or any other
        assistant's context.</div>
        <div class="as-line">
          <label title="the role THIS assistant's turns run — saving it writes this assistant's record and changes no other assistant">role
            <select data-as-setrole="${esc(id)}" title="the job this assistant's turns are told they are doing — picking saves the choice; Restart role applies it to the next turn">${roleOptions}</select></label>
          <button type="button" data-as-rolerestart="${esc(id)}" title="rebuild this assistant's NEXT turn from the role on its record — the full charter, board and queue again; the panel and the gateway are not restarted">Restart role</button>
          <button type="button" data-as-roleopen="${esc(id)}" title="open the panel-level Role tab on the role this assistant runs, where that role's name, remit, prompt and charter are edited">Open Role tab</button>
          <span class="as-hint" data-as-rolestatus="${esc(id)}">${esc(roleRestartNote)}</span>
        </div>
        <div class="as-err" id="as-rolesave-err-${esc(n)}"></div>
      </div>
      ${hardRestartRowHtml(id, rec, {
        armed: hardRestartArmed.has(id),
        note: String(host.dataset?.hardRestartNote || ""),
        live: Boolean(rec?.live),
      })}
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
      <div class="as-help">The pass clock, the command audit and the per-rule escalation table belong to the panel's
      one watchdog — they are in the <b>Watchdog</b> tab. This assistant's default role prompt is in the <b>Role</b> tab
      and the worktrees it owns are in its <b>Worktrees</b> tab. Its thread is
      <code>${esc(rec?.threadId || "")}</code>.</div>
      ${deleteRowHtml(id, rec, { first, armed: deleteArmed.has(id), plan: deleteArmed.get(id) || null, note: String(host.dataset?.deleteNote || "") })}`;
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

  // ---- the queue cards live in public/queue-cards.js, and are handed back here -------------------------
  //
  // The queue sub-tab was cut out of this file into public/queue-cards.js: the row and its head, the lane, hold and
  // question chips, the agents under a task, the pipeline and flow presses, the re-attach press, the window that
  // limits how many rows are drawn, the reader's order and the drag, and the reads and the one write path behind
  // them. That is step 5 of docs/reports/module-map-2026-11-07.html's order of work, and it was a move, not a
  // rewrite: nothing was renamed and no call site changed.
  //
  // This file is an IIFE and the queue reads this file's own helpers (hostFor, sessionById, asPost, setErr and the
  // rest), so the cut is a factory rather than a set of page globals: public/queue-cards.js is a classic script the
  // shell loads before this one, and the helpers are handed in here, once. The names below are the same bindings
  // every call site in this file already read. The press listeners that run at this file's load stay where they
  // were, below, because they must keep the order they had beside this file's other handlers.
  const {
    renderAssistantQueue, loadQueue, queueAct, queueReattach,
    QUEUE_LIVE, qmoveOpen, closeQueueMove, toggleQueueMove,
    queueDropNotes, queueShown, queueWindowOf, QUEUE_MORE,
    queueCardDown, queueCardMove, queueCardUp, queueCardClickGuard, queueDragReset,
    taskOwnerOf, taskIndexRev, ensureTaskIndex, queueOpenTask, taskCardHtml,
  } = window.WMApp.queueCards({
    asPost,
    setErr,
    sessionById,
    assistantIds,
    assistantThreadName,
    isAssistant,
    activeSessionId,
    hostFor,
    paneIdFor,
    typingInside,
    applyAssistant,
  });

  // ---- the worktrees sub-tab: one card per project ------------------------------------------------
  //
  // The board's own table, over the trees THIS assistant owns, grouped into the board's own project cards. It is
  // not a second table: the header and every row come from app.js's own `chartHeaderHtml`/`rowHtml`, so a column
  // the reader hides on the board is hidden here too, the row's actions (⟳, ✕, lock, rename) are the board's
  // actions, and the cells cannot drift from the board's. The owner column is FORCED on here: this tab exists to
  // say "these trees are mine", and a table that dropped the column would say it only in its title.
  //
  // The fold is THIS pane's own record. `wm.expandedProjects` is the board's project fold — written by the board's
  // own toggle and read by its renderer — so sharing it would make one press move both surfaces and neither fold
  // would mean what it says. A record that cannot be read is an empty one, which is the first visit: every card
  // starts collapsed.
  const WT_GROUPS_KEY = "wm.assistantWorktreeGroups";
  let wtGroupsOpen = null;
  function wtGroupSet() {
    if (wtGroupsOpen) return wtGroupsOpen;
    try {
      const raw = JSON.parse(localStorage.getItem(WT_GROUPS_KEY) || "[]");
      wtGroupsOpen = new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch {
      wtGroupsOpen = new Set();
    }
    return wtGroupsOpen;
  }
  function saveWtGroups() {
    try {
      localStorage.setItem(WT_GROUPS_KEY, JSON.stringify([...wtGroupSet()]));
    } catch {
      /* a browser that refuses the write keeps the fold for this page only */
    }
  }

  // The project a tree belongs to, exactly as the board names it: everything before `/.worktrees/`, reduced to
  // its directory name (a tree at `<repo>/.worktrees/x` belongs to `<repo>`). A tree with no
  // `.worktrees` segment has no parent to read, so it falls back to the row's own project field.
  function treeProjectName(row) {
    const tree = String(row?.path || "").replace(/\\/g, "/");
    const at = tree.toLowerCase().indexOf("/.worktrees/");
    if (at > 0) {
      const leaf = tree.slice(0, at).split("/").filter(Boolean).pop() || "";
      if (leaf) return leaf;
    }
    return String(row?.project || "").trim();
  }

  // How many of a project's trees have an agent ON THEM right now — `live` is a run in progress, `parked` is one
  // waiting on the reader. Read from the job list the float already holds (the freshest answer there is), and from
  // the row's own panel signal when no job is known. A tree with neither adds nothing to either count.
  function groupAgentCounts(rows) {
    let live = 0;
    let parked = 0;
    const jobs = state.jobs instanceof Map ? [...state.jobs.values()] : [];
    for (const row of rows) {
      const want = normPath(row.path).toLowerCase();
      let l = false;
      let p = false;
      for (const j of jobs) {
        const at = normPath(j.ownerPath || j.worktreePath || "").toLowerCase();
        if (!at || at !== want) continue;
        const status = String(j.status || "").toLowerCase();
        if (status === "waiting" || status === "waiting_for_approval") p = true;
        else if (QUEUE_LIVE.has(status)) l = true;
        if (l && p) break;
      }
      if (!l && !p) {
        const running = Number(row.panelAgent?.running ?? row.signals?.panel?.running ?? 0) || 0;
        l = running > 0;
      }
      if (l) live += 1;
      if (p) parked += 1;
    }
    return { live, parked };
  }

  // The row the board draws, plus the board's own opener attribute ON THE ROW: `data-open-row` is what the board's
  // ⧉ badge carries, and here it makes the whole row that press. Nothing else about the markup moves.
  function wtRowHtml(row) {
    const key = keyOf(row.project, row.path);
    const html = rowHtml(row, true);
    return html.startsWith("<tr ") ? html.replace("<tr ", `<tr data-open-row="${esc(key)}" `) : html;
  }

  // One card per project, in the board's own panel shape: `section.project` with its `project-head` (the chevron,
  // the name, the counts) and the table in the body. The `collapsed` class is the board's own rule, so the body is
  // hidden by the same CSS the board's projects use rather than a second fold implementation.
  function wtGroupHtml(name, rows) {
    const open = wtGroupSet().has(name);
    const { live, parked } = groupAgentCounts(rows);
    const trees = `${rows.length} tree${rows.length === 1 ? "" : "s"}`;
    const agents = [live ? `${live} live` : "", parked ? `${parked} parked` : ""].filter(Boolean).join(" · ");
    const line = `${trees}${agents ? ` · ${agents}` : ""}`;
    const title = `${open ? "fold" : "open"} ${name} — ${line} in one table; a click on a tree opens its board row and centres the window on it`;
    return `<section class="project as-wtgroup${open ? "" : " collapsed"}" data-as-wtgroup-card="${esc(name)}">
      <div class="project-head" data-as-wtgroup="${esc(name)}" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}" title="${esc(title)}">
        <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
        <h2>${esc(name)}</h2>
        <span class="as-wtgroup-count">${esc(line)}</span>
        <span class="spacer"></span>
      </div>
      <div class="wt-scroll as-worktrees-table"><table><thead><tr>${chartHeaderHtml(true)}</tr></thead><tbody>${rows.map(wtRowHtml).join("")}</tbody></table></div>
    </section>`;
  }

  function renderAssistantWorktrees(id = activeSessionId(), force = false) {
    const host = hostFor(id, "worktrees");
    if (!host || !state.assistant) return;
    const rec = sessionById(id);
    const rows = [...state.rows.values()]
      .filter((r) => r && String(r.assistant?.id || "") === String(id))
      .sort((a, b) => String(a.project || "").localeCompare(String(b.project || "")) || String(a.name || "").localeCompare(String(b.name || "")));
    // The project for a tree is read from its path, not from the row's field: a tree cut outside its project's
    // `.worktrees` folder still belongs to the project the board scanned, and the two readings agree for every
    // tree the panel cuts itself. The card order is the project name, so a repaint never reshuffles the pane.
    const groups = new Map();
    for (const row of rows) {
      const name = treeProjectName(row) || "(no project)";
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row);
    }
    const cards = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    const table = rows.length
      ? `<div class="as-wtgroups">${cards.map(([name, list]) => wtGroupHtml(name, list)).join("")}</div>`
      : `<div class="as-help">No worktrees are owned by ${esc(rec?.name || "this assistant")} yet. A tree a SPAWN by this assistant cuts is stamped its own; the reader can also set an owner by hand from the board's row.</div>`;
    const locked = rows.filter((r) => r.lock?.locked).length;
    host.innerHTML = `
      <div class="as-group">
        <h4>Its worktrees — ${esc(rec?.name || "this assistant")}'s own</h4>
        <div class="as-help">The board's own table over the rows this assistant owns, one card per project. ${rows.length} tree${rows.length === 1 ? "" : "s"} in ${cards.length} project${cards.length === 1 ? "" : "s"}${locked ? ` · ${locked} locked` : ""}. Every action is the board's own: ⟳ reconciles the row, ✕ removes the tree, the padlocks lock it — and a click on a tree opens its board row and centres the window on it. A SPAWN Assistant #2 wrote stamps the tree it cut as #2's; a tree the reader cut stays Assistant #1's.</div>
        ${table}
      </div>`;
  }

  // A group header is a fold, not a navigation: the card's own class carries the state (the board's `collapsed`
  // rule), and the record is written so the next render — and the next page load — agrees with what is on screen.
  function toggleWtGroup(name) {
    const open = wtGroupSet();
    if (open.has(name)) open.delete(name);
    else open.add(name);
    saveWtGroups();
    const view = state.assistantView;
    if (view && view.subTab === "worktrees" && isAssistant(view.assistant)) renderAssistantWorktrees(view.assistant, true);
  }

  // A tree press from this pane is the BOARD's press: unfold its project, open the row through the same
  // `openAgentsBlock` the row's ⧉ badge uses (which is what paints the agents block), and then — AFTER that
  // repaint, never before it — centre the window on the row. `keyOf` is the board's own key and the row carries it
  // as `data-open-row`. A row that carries a thread opens that agent too. The float is left exactly as it is: it
  // may cover part of the board, but closing it would take the reader's pane away under the click they just made.
  function openTreeOnBoard(key) {
    const row = [...state.rows.values()].find((r) => keyOf(r.project, r.path) === key);
    if (!row) return false;
    const project = state.projects.get(row.project);
    const root = project ? rootOf(project) : "";
    if (root && state.collapsedRoots.has(root)) toggleRoot(root);
    if (!state.expandedProjects.has(row.project)) toggleProject(row.project);
    // A chart holds its rows past the top N back, so a tree the reader picked here can be one the board is not
    // drawing. That is the board's own "show the rest" press, not a second way to open a project: without it the
    // row exists in state and nowhere on screen, and the press would land on nothing.
    if (rowTopHidden(row)) toggleShowOld(row.project);
    if (!state.expanded.has(key)) openAgentsBlock(key);
    if (row.thread) openAgentThread(row.thread);
    const land = () => {
      const tr = document.querySelector(`#projects tr.row[data-key="${CSS.escape(key)}"]`);
      if (!tr) return;
      programmaticScroll();
      tr.scrollIntoView({ block: "center", behavior: "auto" });
      refreshAnchorBaseline();
    };
    requestAnimationFrame(land);
    setTimeout(land, 120);
    setTimeout(land, 400);
    return true;
  }

  // ---- end the worktrees sub-tab -------------------------------------------------------------------

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
        ${current && model.visit ? `<span class="pipew-visit mono" data-pipew-visit="${esc(String(model.visit))}">visit ${esc(String(model.visit))}${model.stageRun ? ` · ${esc(model.stageRun)}` : ""}</span>` : ""}
        ${current && model.decision && model.decision.reason ? `<span class="pipew-decision" data-pipew-decision="${esc(model.decision.code || "")}">last decision — ${esc(model.decision.reason)}</span>` : ""}
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
      // The two parks only a READER can release (§6.4 of the design): a cap is a bound the panel just enforced, and a
      // routing change is a re-export somebody has to acknowledge. Without the cap's reset a requeue re-parks on the
      // next settle, because the count is compared as `used + 1 > limit` and a requeue never touches it.
      const wait = model.position && model.position.waitingFor ? model.position.waitingFor : null;
      const releaseKind = wait && (wait.kind === "cap" || wait.kind === "route") ? wait.kind : null;
      const release = releaseKind
        ? `<button type="button" class="pipew-release" data-pipew-release="${esc(releaseKind)}" title="${
            releaseKind === "cap"
              ? "release the cap — resets this loop edge's crossing count to zero and returns the row to the queue"
              : "accept the re-export — re-stamps the routing fingerprint at this stage and returns the row to the queue"
          }">release the ${releaseKind === "cap" ? "cap" : "routing change"}</button>`
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
        ${release}
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
    // The row's clock, from `createdAt` — never `startedAt`, which a pipeline row rewrites at every stage move. It sits
    // beside the stage's clock because the two answer different questions: "in this stage 5 m 32 s" and "on this row
    // 1 h 19 m 44 s". A record with no readable createdAt draws no line at all rather than a zero.
    const rowAge = model.sinceCreated && model.sinceCreated.ok ? pipeWindowElapsedText(model.sinceCreated.ms) : null;
    const created = model.sinceCreated && model.sinceCreated.at ? pipeWindowStamp(model.sinceCreated.at) : "";
    const rowClock = rowAge
      ? `<span class="pipew-sub" data-pipew-rowclock="${esc(String(model.sinceCreated.ms ?? ""))}" title="from the row's own createdAt — the row's age, not the stage's${created ? ` (filed ${esc(created)})` : ""}">on this row ${esc(rowAge)}</span>`
      : "";
    return `${head(`${current.position} of ${count} — ${current.title || current.id}`)}<div class="pipew-body">
      <div class="pipew-meta">
        <span class="pipew-pipe">${esc(model.pipeline.title || model.pipeline.id)} <code>${esc(model.pipeline.id)}</code></span>
        <span class="pipew-sub mono">stage ${esc(String(current.position))} of ${esc(String(count))} · ${esc(current.title || current.id)} <code>${esc(current.id)}</code></span>
        <span class="pipew-since">began ${esc(entered)}</span>
        <span class="pipew-sub">in this stage ${esc(elapsed)}</span>
        ${rowClock}
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
            ...(model.sinceCreated && model.sinceCreated.ok ? [{ label: "on this row", value: fmtDur(model.sinceCreated.ms) }] : []),
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

  // The reader's release of a cap or a routing-change park (§6.4): one queue write, then the window is re-read at the
  // new clock. It deliberately does NOT start anything — the row returns to `queued`, and the driver's next pass is
  // what starts its stage, exactly as for any other queued pipeline row.
  async function pipeWindowRelease(kind = "cap", { doc = document } = {}) {
    if (pipeWindowState.busy) return null;
    const card = doc.getElementById(PIPE_CARD_ID);
    const note = card ? card.querySelector("[data-pipew-assign-note]") : null;
    const { assistantId, taskId, opener } = pipeWindowState;
    if (!assistantId || !taskId) return null;
    pipeWindowState.busy = true;
    if (note) note.textContent = kind === "cap" ? "releasing the cap…" : "accepting the new routing…";
    try {
      const out = await queueAct(assistantId, "pipeline-release", { id: taskId, release: kind });
      if (!out) {
        if (note) note.textContent = "the panel refused the release — see the error above";
        return null;
      }
      await openTaskPipelineWindow(assistantId, taskId, opener);
      try {
        document.dispatchEvent(new CustomEvent("wtgui:task-pipeline-assigned", { detail: { assistantId, taskId } }));
      } catch {
        /* an environment without CustomEvent needs no notice */
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
      if (e.target?.closest?.("[data-pipew-release]")) {
        e.preventDefault();
        const kind = e.target.closest("[data-pipew-release]").getAttribute("data-pipew-release") || "cap";
        void pipeWindowRelease(kind);
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
  // ONE delegated listener for every task id in every assistant's transcript. The anchors are built while the console
  // renders (public/core/console-markdown.js), so nothing here has to find or rewrite them: this only recognises the
  // one that was pressed. It sits on the float rather than on each chat host because those hosts are rebuilt, and a
  // listener per card would be one more to place on every repaint.
  as$("assistant")?.addEventListener("click", (e) => {
    const link = e.target?.closest?.("a[data-as-task]");
    if (!link) return;
    e.preventDefault();
    void openTaskRef(link.dataset.asTaskOwn, link.dataset.asTask);
  });
  // The task index landed (public/queue-cards.js dispatches this when an answer placed something new). The anchors are
  // built at render time, so the cards already on screen are asked to draw again; nothing is rewritten in place.
  document.addEventListener("wtgui:task-index", () => {
    for (const rec of sessionRecords()) if (hostFor(rec.id, "chat")) renderAssistantChat(rec.id);
  });
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

  // ---- the worktrees pane: the project cards and their rows ---------------------------------------
  // Delegated on the float, not bound per row: the pane is rebuilt on every snapshot, and a listener on a row that
  // was replaced is a press that does nothing. A card's head is its fold (the same `role=button` contract the queue's
  // sub-rows honour); a tree row is the board's own opener, so a press on it does exactly what the board's ⧉ badge
  // does — the row's own controls keep their presses.
  as$("assistant")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const head = e.target && e.target.closest ? e.target.closest("[data-as-wtgroup]") : null;
    if (!head) return;
    e.preventDefault();
    toggleWtGroup(head.dataset.asWtgroup);
  });
  as$("assistant")?.addEventListener("click", (e) => {
    const head = e.target.closest("[data-as-wtgroup]");
    if (head) {
      e.preventDefault();
      e.stopPropagation();
      toggleWtGroup(head.dataset.asWtgroup);
      return;
    }
    const tr = e.target.closest(".as-wtgroup tr[data-open-row]");
    if (!tr) return;
    // Every control on the row (⟳, ✕, the padlocks, the rename, the PR link) keeps its own press; the ⧉ badge is
    // itself a `data-open-row` button, so it is the one exception and opens the tree like the row around it.
    const control = e.target.closest("button, a, input, select, textarea, label, summary");
    if (control && !control.matches("[data-open-row]")) return;
    e.preventDefault();
    e.stopPropagation();
    openTreeOnBoard(tr.dataset.openRow);
  });

  as$("assistant")?.addEventListener("click", async (e) => {
    // The stopped chip's press comes FIRST: the chip sits INSIDE the sub-row that carries `data-as-qopen`, so the
    // opener lookup below would answer the row and open a card the reader did not ask to open. `stopPropagation` keeps
    // the press from reaching the float's other handlers; the chip's own listener is this one, so the row's opener
    // never sees it.
    const reattachChip = e.target.closest("[data-as-qreattach]");
    if (reattachChip) {
      e.preventDefault();
      e.stopPropagation();
      await queueReattach(reattachChip.dataset.asQown, reattachChip.dataset.asQid, reattachChip);
      return;
    }
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
    const taskRow = e.target.closest(".as-task:not(.is-compact)");
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
      // A rule is one assistant's own: the row carries the assistant whose pane drew it, so #2's ✕ removes #2's rule
      // and repaints #2's Notes pane. #1 keeps the ids and the route call every harness already drives.
      const forId = t.dataset.asRulefor || "";
      t.disabled = true;
      try {
        await asPost("/api/assistant/rule/remove", { id: t.dataset.asUnrule, ...(forId ? { assistantId: forId } : {}) });
        renderAssistantPad(true, forId || selectedSessionId());
      } catch (err) {
        setErr(forId ? padId("as-pad-err", forId) : padId("as-pad-err", selectedSessionId()), err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.dataset.asPadgrant) {
      // The reader's one press for the consolidation grant. The checkbox is already toggled by the browser, so
      // `checked` is the answer being saved; the repaint takes the state the server sends, not the box's guess.
      const who = isAssistant(t.dataset.asPadgrant) ? t.dataset.asPadgrant : selectedSessionId();
      const granted = t.checked === true;
      t.disabled = true;
      try {
        await asPost("/api/assistant/consolidate/grant", { assistantId: who, granted });
        renderAssistantPad(true, who);
      } catch (err) {
        setErr(padId("as-pad-err", who), err.message);
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
      // The form belongs to the pane it sits in: `data-as-padrule` names that assistant, so #2's form reads #2's box
      // and the rule it adds lands on #2's own record.
      const who = isAssistant(t.dataset.asPadrule) ? t.dataset.asPadrule : selectedSessionId();
      const text = String(as$(padId("as-rule-text", who))?.value || "").trim();
      if (!text) return;
      t.disabled = true;
      try {
        await asPost("/api/assistant/rule", { text, assistantId: who });
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
      const box = as$(padId("as-notes", who));
      const text = String(box?.value || "");
      const cap = Number(box?.dataset?.asCap) || 0;
      if (cap > 0 && text.length > cap) {
        // The cap is what a turn reads, so an over-cap paste is refused HERE as well as on the route: a reader
        // who pasted past it has to prune, not discover later that the panel kept a tail they never saw.
        setErr(padId("as-pad-err", who), `the notes are ${text.length} characters and the cap is ${cap} — prune the oldest lines and save again`);
        return;
      }
      t.disabled = true;
      try {
        // The save goes to the assistant the pad is showing. #1 keeps its store's string; an extra assistant writes
        // its own notes.md, and the answer carries the text it actually kept.
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
      // Save writes the ROLE the picker shows: its name, its one line of remit, the short prompt its turns begin
      // with, and the long charter, in ONE write. The text is read from the boxes, not from the draft, because a
      // press is the moment the page must believe what it is looking at.
      const id = roleShown();
      const doc = roleLoadedFor();
      if (!doc) {
        setErr("as-role-err", "the role's text has not been read yet — pick the role again to retry");
        return;
      }
      const v = roleForm();
      const name = v.name.replace(/\s+/g, " ").trim();
      if (!name) {
        setErr("as-role-err", "a role needs a name — the first group has its box");
        as$("as-role-name")?.focus();
        return;
      }
      // The panel refuses an over-cap save WHOLE (413) and writes nothing, so it is not sent: the warning between the
      // box and the buttons already names the numbers, and a press that only turns that sentence into an error is
      // the wait this check exists to save. Save is disabled in the same state; this guard covers a keyboard press.
      const cap = Number(doc.cap) || 0;
      if (cap && v.text.length > cap) {
        setErr("as-role-err", `the charter is ${v.text.length} characters and the cap is ${cap} — prune the oldest changelog entries first`);
        paintRoleBox();
        return;
      }
      t.disabled = true;
      try {
        const d = await asPut("/api/assistant/role/charter", {
          roleId: id,
          name,
          description: v.description.replace(/[ \t\r\n]+/g, " ").trim(),
          prompt: v.prompt,
          text: v.text,
          expectMtime: doc.mtime,
        });
        // The answer is the role as it now reads on disk plus the library's metadata; the picker's label follows
        // from the state `asPut` already applied.
        roleDoc = {
          id: String(d.role?.id || id),
          name: String(d.role?.name || name),
          description: String(d.role?.description ?? v.description),
          prompt: String(d.prompt ?? v.prompt),
          text: String(d.text ?? v.text),
          cap: Number(d.cap) || cap,
          mtime: Number.isFinite(Number(d.mtime)) ? Number(d.mtime) : null,
        };
        roleDraft = null;
        roleAsk = null;
        roleErr = "";
        roleLoadedAt = Date.now();
        setErr("as-role-err", "");
        renderAssistantRole(true);
      } catch (err) {
        // A stale save (409) and an over-cap save (413) both land here as the server's own words: the reader is told
        // what to do about it rather than that something went wrong.
        setErr("as-role-err", err.message);
      } finally {
        t.disabled = false;
        paintRoleBox();
      }
      return;
    }

    // The inline row's two answers. "Keep editing" changes nothing at all: the boxes keep the reader's words and the
    // question goes.
    if (t.dataset.asRoleask) {
      const asked = roleAsk;
      const answer = String(t.dataset.asRoleask);
      roleAsk = null;
      if (!asked || answer !== "switch") {
        renderAssistantRole(true);
        return;
      }
      t.disabled = true;
      try {
        rolePick = asked.roleId;
        roleDoc = null;
        roleDraft = null;
        await loadRoleText(asked.roleId);
      } catch (err) {
        setErr("as-role-err", err.message);
        renderAssistantRole(true);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-new-assistant") {
      // A new assistant is made from the role the editor shows: its own thread, its own rules and its own copy of
      // the role's charter. The role itself is not changed.
      const pick = roleShown();
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
      // Create role makes a copy of the role the editor shows and OPENS it here, so the reader names it in the first
      // group and saves. No dialog, no second name box: the name starts as "<role> copy", which the second press
      // changes.
      const from = roleShown();
      const base = roleMetaOf(from);
      const taken = new Set((state.assistant?.roles || []).map((r) => String(r.name || "").toLowerCase()));
      const stem = `${base?.name || "Role"} copy`;
      let name = stem;
      for (let n = 2; taken.has(name.toLowerCase()) && n < 100; n += 1) name = `${stem} ${n}`;
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/roles", { name, from });
        rolePick = String(d.role?.id || "");
        roleDoc = null;
        roleDraft = null;
        roleAsk = null;
        roleFailed = "";
        setErr("as-role-err", "");
        if (rolePick) await loadRoleText(rolePick);
        else renderAssistantRole(true);
      } catch (err) {
        setErr("as-role-err", err.message);
        renderAssistantRole(true);
      } finally {
        t.disabled = false;
      }
      return;
    }

    // The Settings role row's two presses. Restart is a turn-context rebuild on the server for THIS id only — it
    // drops that assistant's session send records, so its next turn carries the full charter under the role its
    // record now holds. Nothing here restarts the panel or calls the gateway, and the line under the row says exactly
    // what was rebuilt. Open Role tab is the panel-level tab, pointed at this assistant, for the charter itself.
    if (t.dataset.asRolerestart) {
      const own = t.dataset.asRolerestart;
      const n = String(own).replace(/^assistant-/, "");
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/role/restart", { assistantId: own });
        const who = d.target?.name || "this assistant";
        const roleName = d.role?.name || "its role";
        const again = Array.isArray(d.cleared) && d.cleared.length ? `, and the ${d.cleared.join(", the ")} go in full again` : ". Nothing had been sent yet this session, so its next turn is already a first turn";
        const pane = hostFor(own, "settings");
        if (pane) {
          pane.dataset.roleRestartNote = `Restarted ${who}'s turn context${d.live ? " (a turn was already running; the rebuild is its next one)" : ""} — its next turn is built from the ${roleName} role${again}. The panel and the gateway were not restarted.`;
        }
        setErr(`as-rolesave-err-${n}`, "");
      } catch (err) {
        setErr(`as-rolesave-err-${n}`, err.message);
      } finally {
        t.disabled = false;
      }
      renderAssistantSettings(own, true);
      return;
    }

    // THE HARD RESTART'S THREE PRESSES. The first only ARMS: it sets the float's armed flag and returns, with no request
    // and no state change, so a stray click cannot clear a conversation. Cancel disarms. The confirm posts once; the
    // answer's whole state rides back through `asPost` → `applyAssistant`, which repaints this assistant's tab on its
    // NEW thread — its Chat goes back to the intro, because that thread has no turn yet.
    if (t.dataset.asHardrestart) {
      const own = t.dataset.asHardrestart;
      hardRestartArmed.add(own);
      renderAssistantSettings(own, true);
      return;
    }

    if (t.dataset.asHardrestartCancel) {
      const own = t.dataset.asHardrestartCancel;
      hardRestartArmed.delete(own);
      renderAssistantSettings(own, true);
      return;
    }

    if (t.dataset.asHardrestartGo) {
      const own = t.dataset.asHardrestartGo;
      const n = String(own).replace(/^assistant-/, "");
      const pane = hostFor(own, "settings");
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/hard-restart", { assistantId: own });
        const who = d.target?.name || "this assistant";
        const from = d.target?.previousThread || "its old thread";
        const to = d.target?.threadId || "a new thread";
        if (pane) {
          pane.dataset.hardRestartNote =
            `Hard restarted ${who} — thread ${from} → ${to}. Its next turn is the first turn of a new session, ` +
            `carrying none of the old conversation; its queue, watches, charter, rules and settings were kept. ` +
            `The panel and the gateway were not restarted.`;
        }
        hardRestartArmed.delete(own);
        setErr(`as-hardrestart-err-${n}`, "");
      } catch (err) {
        // A live turn is a refusal with a reason to wait, not a failure: say it beside the question and leave the pair
        // armed, so the reader's next press (after stopping the turn) is the retry.
        setErr(`as-hardrestart-err-${n}`, err.message);
      } finally {
        t.disabled = false;
      }
      renderAssistantSettings(own, true);
      return;
    }

    // THE DELETE'S TWO PRESSES. The first is a DRY RUN: it asks the route what a second press would do, so a live
    // run or an open queue row is refused HERE, in the route's own sentence naming the run or the rows. The plan it
    // returns is what the confirmation names — the four files and the archive folder. The second press posts once;
    // the answer's assistant state is applied by asPost, and syncSessionTabs prunes the tab and the pane.
    if (t.dataset.asDelete) {
      const own = t.dataset.asDelete;
      const n = String(own).replace(/^assistant-/, "");
      const pane = hostFor(own, "settings");
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/delete", { assistantId: own, dryRun: true });
        deleteArmed.set(own, d.plan || null);
        if (pane) pane.dataset.deleteNote = "";
        setErr(`as-delete-err-${n}`, "");
      } catch (err) {
        // A refusal disarms: the route refused before mutating, so a second press would ask the same question and
        // get the same answer. The sentence is the route's, and it names the run or the rows.
        deleteArmed.delete(own);
        if (pane) pane.dataset.deleteNote = err.message;
        setErr(`as-delete-err-${n}`, err.message);
      } finally {
        t.disabled = false;
      }
      renderAssistantSettings(own, true);
      return;
    }

    if (t.dataset.asDeleteCancel) {
      const own = t.dataset.asDeleteCancel;
      deleteArmed.delete(own);
      const pane = hostFor(own, "settings");
      if (pane) pane.dataset.deleteNote = "";
      renderAssistantSettings(own, true);
      return;
    }

    if (t.dataset.asDeleteGo) {
      const own = t.dataset.asDeleteGo;
      const n = String(own).replace(/^assistant-/, "");
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/delete", { assistantId: own });
        deleteArmed.delete(own);
        showBanner(
          `${d.removed?.name || "The assistant"} was deleted — its record, queue, charter and notes are archived at ${d.archive?.dir || "the panel's assistant archive"}`,
        );
        setErr(`as-delete-err-${n}`, "");
        // A list tab (Role, Watchdog) falls back to the session the reader was last on, so a deleted id must not
        // stay there; and the float may have been ON the deleted assistant, in which case it moves to #1 before the
        // next paint, since the tab and its pane no longer exist by then.
        if (lastSession === own) lastSession = FIRST_ASSISTANT;
        if (state.assistantView?.assistant === own) {
          lastSession = FIRST_ASSISTANT;
          setView({ assistant: FIRST_ASSISTANT, subTab: "chat" });
        }
      } catch (err) {
        const pane = hostFor(own, "settings");
        if (pane) pane.dataset.deleteNote = err.message;
        setErr(`as-delete-err-${n}`, err.message);
        renderAssistantSettings(own, true);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.dataset.asRoleopen) {
      // The panel-level Role editor is aimed at the ROLE this assistant runs: point its picker at that role, then
      // switch the view. `setView` persists the record, so a reload lands on the same tab.
      const open = t.dataset.asRoleopen;
      rolePick = String(sessionById(open)?.roleId || "");
      roleDoc = null;
      roleDraft = null;
      roleAsk = null;
      roleFailed = "";
      setView({ assistant: "role" });
      return;
    }

    // THE RENAME. Save posts the trimmed box to the SAME /api/assistant/settings route the knobs use, which writes the
    // name on the assistant's RECORD; the answer's assistant state repaints the tab row and this pane, so the label
    // moves with no reload. Empty is refused here (a visible line, no request) and again on the server; over 40 is
    // capped by the input's own maxlength and by the server's cap.
    if (t.dataset.asNamesave) {
      const id = t.dataset.asNamesave;
      const n = String(id).replace(/^assistant-/, "");
      const box = as$(`as-name-text-${n}`);
      const name = String(box?.value || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!name) {
        setErr(`as-name-err-${n}`, "a name cannot be empty — type one, or press Cancel to keep the current name");
        box?.focus();
        return;
      }
      t.disabled = true;
      try {
        const d = await asPost("/api/assistant/settings", { assistantId: id, name: name.slice(0, 40) });
        const pane = hostFor(id, "settings");
        const saved = d?.renamed?.target?.name || name;
        if (pane) {
          pane.dataset.nameNote = d?.renamed?.changed === false
            ? `That is already its name — ${saved} is what its record holds.`
            : `Saved — its tab and this float's header now read ${saved}. Its id, queue, thread, charter and state directory are unchanged.`;
        }
        setErr(`as-name-err-${n}`, "");
        // asPost already applied the answer's assistant state (the tab row is repainted); this repaints the pane the
        // reader is looking at so the input shows the stored name and the note explains the save.
        renderAssistantSettings(id, true);
      } catch (err) {
        setErr(`as-name-err-${n}`, err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.dataset.asNamecancel) {
      // Cancel is a local undo of the box, nothing else: the record was never written, so the stored name is what the
      // input is put back to.
      const id = t.dataset.asNamecancel;
      const n = String(id).replace(/^assistant-/, "");
      const box = as$(`as-name-text-${n}`);
      if (box) box.value = sessionById(id)?.name || "";
      setErr(`as-name-err-${n}`, "");
      const pane = hostFor(id, "settings");
      if (pane) pane.dataset.nameNote = "";
      const note = hostFor(id, "settings")?.querySelector(`[data-as-namestatus="${id}"]`);
      if (note) note.textContent = "";
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
    // The role editor's four fields: remember the draft outside the DOM (a repaint paints it back) and repaint
    // the cap, the provenance line and Save in place. No full render here — it would take the caret out of a 20 KB
    // charter, or out of the name box the reader is halfway through.
    const roleField = e.target.closest?.("#as-role-name, #as-role-description, #as-role-prompt, #as-role-text");
    if (roleField) {
      noteRoleInput();
      return;
    }
    // The pad: the size against the cap, and Save disabled the moment the text is over it. No full render — that
    // would empty the box under the caret.
    const padBox = e.target.closest?.("[data-as-padbox]");
    if (padBox) {
      const who = padBox.dataset.asPadbox;
      const cap = Number(padBox.dataset.asCap) || 0;
      const len = String(padBox.value || "").length;
      const over = cap > 0 && len > cap;
      const hint = document.querySelector(`[data-as-padcap="${CSS.escape(who)}"]`);
      if (hint) {
        hint.textContent = cap ? `${len}/${cap} chars — a turn reads exactly ${cap}${over ? " · over the cap, Save is refused" : ""}` : "";
        hint.classList.toggle("is-bad", over);
      }
      const btn = document.querySelector(`[data-as-padsave="${CSS.escape(who)}"]`);
      if (btn) btn.disabled = over;
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
    if (el.dataset.asRolePick !== undefined) {
      // WHICH ROLE THE EDITOR SHOWS. Picking another role reads that role's own four fields; no assistant's record
      // moves — which role an assistant runs is its Settings' business. Typed words are the reader's, so a pick that
      // would discard them asks in the tab and leaves the boxes alone until they answer.
      const nextId = String(el.value || "");
      if (!nextId || nextId === roleShown()) {
        renderAssistantRole(true);
        return;
      }
      if (roleDirty()) {
        roleAsk = { kind: "switch", roleId: nextId };
        renderAssistantRole(true);
        return;
      }
      rolePick = nextId;
      roleDoc = null;
      roleDraft = null;
      roleAsk = null;
      await loadRoleText(nextId);
      return;
    }
    if (el.dataset.asSetrole) {
      // THE ROLE PICKER in Settings — the one control that changes a role. It writes the assistant's own record
      // through the role route, never a page-side copy, and it deliberately does NOT adopt the role's charter: the
      // text stays this assistant's own copy, edited in the Role tab.
      const own = el.dataset.asSetrole;
      const roleId = String(el.value || "");
      const n = String(own).replace(/^assistant-/, "");
      el.disabled = true;
      try {
        const d = await asPost("/api/assistant/role/pick", { assistantId: own, roleId, adopt: false });
        // The answer carries the whole assistant state (asPost applied it), so the repaint below reads the role the
        // server actually stored — a refused pick cannot leave the select claiming a job the record never took.
        const pane = hostFor(own, "settings");
        if (pane) pane.dataset.roleRestartNote = `Saved — ${d.target?.name || "this assistant"} runs the ${d.role?.name || "picked"} role. Press Restart role to rebuild its next turn from it.`;
        setErr(`as-rolesave-err-${n}`, "");
      } catch (err) {
        setErr(`as-rolesave-err-${n}`, err.message);
      } finally {
        el.disabled = false;
      }
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
    if (action === "more") {
      // Append the next slice and repaint from the cache: the window is client-side, so this press owes no route.
      // `queueShown` lives outside the painter, which is why the next board tick repaints the same rows. The paint is
      // FORCED because the press leaves the caret on this button, inside the pane: the unforced guard exists to keep a
      // poll from taking a draft out of a text field, and a focused button is not a draft.
      queueShown.set(own, queueWindowOf(own) + QUEUE_MORE);
      renderAssistantQueue(own, true);
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
    queueDragReset();
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
      // Growing the pane hands its room to a turn's console, and a folded transcript has none on the page at all:
      // `openNewestTurn` above opens the newest turn, and the height it draws at THIS frame is the number every move
      // below hands the frame's gain to. A repaint that has not reached the DOM yet is retried on the next move rather
      // than leaving the drag with nothing to hand the room to.
      if (d.kind === "float-size" && !d.out) {
        paintSlackTurn();
        const out = slackConsole();
        if (out) d.out = { floor: consoleFloor(out), h: out.getBoundingClientRect().height };
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
      // The float's bottom-right corner: the left and top edges stay where they are, the corner travels by EXACTLY the
      // pointer's own travel (`dx`/`dy`, both measured from the press), and neither dimension is ever asked for LESS
      // than the frame already has — a frame taller than the room left would otherwise snap down on the first pixel of
      // the drag. The press's own inset inside the corner (`grab`, up to the handle's 16px) is deliberately KEPT: the
      // frame must not yank its corner onto the cursor on the first move, which is the "jump" a resize cannot have.
      const w = clamp(d.box.width + dx, FLOAT_MIN_W, Math.max(d.box.width, vw - FLOAT_EDGE - d.box.left));
      const h = clamp(d.box.height + dy, FLOAT_MIN_H, Math.max(d.box.height, vh - FLOAT_EDGE - d.box.top));
      el.style.width = cssPx(w, z);
      el.style.height = cssPx(h, z);
      // The room the frame just gained goes to the console the reader is reading, WRITTEN on the box. `.is-slack`
      // alone cannot do it: the flex grows into free space only, and an overflowing transcript has none. The gain is
      // read back off the DRAWN frame after the clamp - so a drag past the window's edge, or the floor, hands over
      // nothing - and floored at the console's own min-height, which is what makes the drag monotonic both ways
      // instead of letting a wider frame's reflow draw a shorter console.
      const cons = d.out ? slackConsole() : null;
      if (cons) {
        const drawn = el.getBoundingClientRect().height - d.box.height;
        const outH = consoleDragHeight(d.out.h, drawn, d.out.floor);
        cons.style.height = cssPx(outH, z);
        // The cap with it: the sheet's open-turn rule says `max-height: none`, so a flex-grow on a later paint would
        // hand the console more than the drag did; pinning the cap keeps the number the drag wrote.
        cons.style.maxHeight = cssPx(outH, z);
      }
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
      // The console keeps the size the drag gave it through the store a console drag writes, so the rebuild that
      // replaces the node (a new turn, a fold, a reload) puts the number back on the box that follows it.
      const cons = d.out ? slackConsole() : null;
      if (cons?.dataset.out && typeof rememberOutHeight === "function") {
        rememberOutHeight(cons.dataset.out, Math.round(cons.getBoundingClientRect().height / (d.z || 1)));
      }
    };

    split.addEventListener("pointerdown", (e) => onDown(e, floating() ? "float-size" : "dock-width", split));
    if (bar) bar.addEventListener("pointerdown", (e) => { if (floating()) onDown(e, "float-move", bar); });
    // THE FLOAT'S CORNER IS ROUND, AND THAT IS WHAT MAKES ITS GRAB DEAD. The handle's 16x16 box sits inside the
    // float's 10px corner radius with `overflow: hidden` on the float, so the last pixels of the handle are clipped
    // out of every hit area: a press on the corner a reader aims at does not reach the handle, does not even reach
    // the pane, and lands on the BOARD under the window. The reader grabs the grip and drags, and nothing resizes.
    // Claim that band in CAPTURE, before anything under the float can act on the press, and start the same
    // `float-size` gesture the handle starts. Only a press on the board or the pane is given up: one that belongs to
    // Settings, a banner or a popup is that layer's, even when it sits over the float's corner.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 || press || !floating()) return;
        // A closed pane has no corner: `getBoundingClientRect` on a `[hidden]` float is four zeros, and every press
        // near the window's own top-left would read as a corner grab.
        if (el.hidden) return;
        if (!e.target?.closest?.(".shell, main, body")) return;
        const r = el.getBoundingClientRect();
        if (e.clientX < r.right - FLOAT_GRAB || e.clientY < r.bottom - FLOAT_GRAB) return;
        e.stopPropagation();
        onDown(e, "float-size", el);
      },
      true,
    );
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

  // The rail is sized against the window, so a resize re-measures it: a narrower window caps the width at half of
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
    // Ctrl+Shift+Q is the Hot Agent search's key, beside Ctrl+Q and deliberately SHIFTED: the branch below refuses
    // every shifted press, so one press cannot be answered by both bars. It opens the panel when it is closed (the
    // bar lives in its header) and lands in the Hot Agent box with its text selected, so a typed filter replaces the
    // last one. Unlike Ctrl+Q it is honoured from a composer: the chord is explicit - nobody types it by accident -
    // and the popover never touches the reply's text.
    if (!e.repeat && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "q" || e.key === "Q" || e.code === "KeyQ")) {
      e.preventDefault();
      e.stopPropagation();
      openHotSearch();
      return;
    }
    // Ctrl+Q is the search box's own key: pressed anywhere in the open panel, the caret lands in the box with the
    // text it already holds SELECTED, so the first character typed replaces the last filter. It is reported handled
    // (preventDefault) rather than merely acted on - no browser default may also fire. A caret in a textarea or the
    // composer is the reader writing, and a chord that stole it would eat their words, so those hosts are left alone.
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.key === "q" || e.key === "Q" || e.code === "KeyQ")) {
      const panel = as$("assistant");
      if (!panel || panel.hidden) return;
      if (inComposer(e.target) || inComposer(document.activeElement)) return;
      if (!focusSearch()) return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
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
    // The header's search box: one listener set for the life of the page. Wired before the first render so a
    // restored frame that is already open can be typed into at once.
    wireSearch();
    // ...and the Hot Agent bar beside it, on the same one-listener-per-page rule: both mounts are idempotent (each
    // keeps its own module instance), and restoreFrame runs once.
    wireHotSearch();
    // The Initiatives tab's one listener set, wired before the first render for the same reason: a restored frame can
    // open straight onto it, and a card painted before its listener exists is a card whose buttons do nothing.
    wireInitiativesPane();
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
  // The chart's owner column chip: app.js hands the four fields it drew on the chip (the assistant, the project, the
  // worktree, the branch) and this opens that assistant's Chat with "Regarding <project> <worktree> <branch>: " in the
  // box, the caret at the end and the box focused. Nothing is sent.
  window.__assistantRegarding = openRegarding;
  // The task id in the transcript: app.js's renderer asks this for the assistant that owns an id while the console is
  // being built (public/render-jobs.js -> core/console-markdown.js). null means no one owner, and the words stay plain.
  window.__assistantTaskLink = taskOwnerOf;
  // Settings → General's frame picker: the setting is the panel's, the painter is here, so app.js calls this after
  // the save (and public/settings.js `applySettings` after any settings change from any tab). `applyFrame()` is
  // idempotent — an unchanged mode returns before it measures anything — so calling it on every settings event is
  // free, and a changed one re-frames the open pane with no reload.
  window.__assistantFrame = () => applyFrame();
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
