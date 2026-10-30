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
  const TAB_KEY = "wm.assistantTab";
  const RECT_KEY = "wm.assistantRect";
  const SEEN_KEY = "wm.assistantSeenAt";
  const PIN_KEY = "wm.assistantPinned";
  const TABS = ["chat", "alerts", "watches", "messages", "pad", "charter", "settings"];
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
  function readTab() {
    try {
      const v = localStorage.getItem(TAB_KEY);
      return TABS.includes(v) ? v : "chat";
    } catch {
      return "chat";
    }
  }
  function readRect() {
    try {
      const r = JSON.parse(localStorage.getItem(RECT_KEY) || "null");
      if (!r || !["x", "y", "w", "h"].every((k) => Number.isFinite(Number(r[k])))) return null;
      return { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) };
    } catch {
      return null;
    }
  }
  function writeRect(r) {
    try {
      localStorage.setItem(RECT_KEY, JSON.stringify(r));
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
  state.assistantTab = state.assistantTab || readTab();
  state.assistantSeenAt = state.assistantSeenAt ?? seenAt();
  state.assistantPinned = state.assistantPinned ?? readFlag(PIN_KEY, false);
  // Maximized is a mode of the float, not a saved position: a reload puts the panel back to the window it
  // remembered rather than covering the board after a refresh (Esc is the way out, not F5).
  state.assistantFull = false;

  let dragState = null;

  // ---- the panel's own frame ------------------------------------------------------------------

  function placeAssistant() {
    const el = as$("assistant");
    if (!el) return;
    // Maximized, the frame is the viewport: `inset: 0` in CSS owns it, and any remembered rect written here
    // would fight it.
    if (state.assistantFull) return;
    const r = state.assistantRect || readRect();
    if (!r) return;
    const { vw, vh } = viewportBox();
    const w = Math.max(320, Math.min(r.w, vw - 2 * EDGE));
    const h = Math.max(320, Math.min(r.h, vh - 2 * EDGE));
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.left = `${Math.max(EDGE, Math.min(r.x, vw - w - EDGE))}px`;
    el.style.top = `${Math.max(EDGE, Math.min(r.y, vh - h - EDGE))}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  function currentRect() {
    const el = as$("assistant");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  // Air kept between the float and every viewport edge, and the box it is kept inside.
  //
  // That box is the LAYOUT viewport — `documentElement.clientWidth/Height`, the rectangle a `position: fixed`
  // element is laid out in, which already excludes the classic scrollbar. It is deliberately not `visualViewport`:
  // a classic scrollbar shrinks the visual viewport by its own width (11px on this machine), so a float sitting on
  // the layout viewport's 8px edge is already 3px outside the visual one, and the first pixel of a drag snapped the
  // whole frame 11px inward — the window jumped the instant it was grabbed instead of just stopping at the edge.
  const EDGE = 8;
  function viewportBox() {
    const doc = document.documentElement;
    return {
      vw: doc.clientWidth || window.innerWidth,
      vh: doc.clientHeight || window.innerHeight,
    };
  }

  // The chat's scroll box: the card's body, and the only thing in the float that scrolls.
  function chatBody() {
    const host = as$("as-chat");
    return host ? host.querySelector(":scope > .job > .job-body") : null;
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

  // Maximize/restore. An explicit control beside a resize gesture that is a pointer drag: a double-click in the head
  // already does this, and the button is the visible way in for a reader who never discovers the gesture.
  function paintAssistantMax() {
    const btn = as$("btn-as-max");
    const el = as$("assistant");
    const on = Boolean(state.assistantFull);
    if (btn) {
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.textContent = on ? "\u2921" : "\u2922";
      btn.title = on
        ? "restore the assistant to a floating window (Esc, or double-click the header)"
        : "maximize the assistant to the whole window (double-click the header; Esc restores)";
    }
    if (el) el.classList.toggle("as-full", on);
    const close = as$("btn-as-close");
    if (close) close.title = on ? "close — Esc puts the float back first" : "close (Esc) — it keeps watching while closed";
  }

  function setAssistantFull(on) {
    const el = as$("assistant");
    if (!el) return;
    const next = Boolean(on);
    if (next === Boolean(state.assistantFull)) return;
    if (next) {
      // Remember the frame to come back to, then hand the geometry to the stylesheet.
      const r = currentRect();
      if (r) {
        state.assistantRect = r;
        writeRect(r);
      }
      state.assistantFull = true;
      el.style.width = "";
      el.style.height = "";
      el.style.left = "";
      el.style.top = "";
      el.style.right = "";
      el.style.bottom = "";
      paintAssistantMax();
      pinChatToBottom(true);
      return;
    }
    state.assistantFull = false;
    paintAssistantMax();
    placeAssistant();
    pinChatToBottom(true);
  }

  function toggleAssistant(open = !state.assistantOpen) {
    state.assistantOpen = Boolean(open);
    writeFlag(OPEN_KEY, state.assistantOpen);
    const el = as$("assistant");
    const btn = as$("btn-assistant");
    if (el) el.hidden = !state.assistantOpen;
    if (btn) btn.classList.toggle("is-on", state.assistantOpen);
    if (state.assistantOpen) {
      placeAssistant();
      state.assistantSeenAt = Date.now();
      markSeen();
      renderAssistant();
      paintAssistantBadge();
      pinChatToBottom(true);
    } else if (state.assistantFull) {
      // A closed panel reopens as the float, not as the whole window.
      setAssistantFull(false);
    }
  }

  // Pinning: while it is on, the float ignores the press that would otherwise dismiss it, and it is remembered
  // across reloads beside the open flag. The button reads as pressed (is-on, aria-pressed) and so does the frame.
  function paintAssistantPin() {
    const btn = as$("btn-as-pin");
    const el = as$("assistant");
    const on = Boolean(state.assistantPinned);
    if (btn) {
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on
        ? "pinned open — a click elsewhere on the board leaves the assistant up (click to unpin)"
        : "pin the assistant open — unpinned, a click elsewhere on the board closes it (click to pin)";
    }
    if (el) el.classList.toggle("is-pinned", on);
  }

  function setAssistantPinned(on) {
    state.assistantPinned = Boolean(on);
    writeFlag(PIN_KEY, state.assistantPinned);
    paintAssistantPin();
  }

  // Unpinned, a press anywhere off the float closes it through the SAME toggle the ✕ calls — one close path.
  // It listens on pointerdown rather than click on purpose: a drag of the frame starts on the head (inside) and
  // ends wherever the pointer got to, and the click that follows lands on the nearest common ancestor of press
  // and release, which is outside the panel — a click listener would close the float every time it was dragged.
  function onOutsidePress(e) {
    const el = as$("assistant");
    if (!el || el.hidden || e.button !== 0) return;
    if (el.contains(e.target)) return;
    // The two header buttons toggle for themselves: closing here first would make their own click reopen (or,
    // for the aggressive switch, dismiss the panel the reader is reading while it changes how it behaves).
    if (e.target?.closest?.("#btn-assistant, #btn-aggressive")) return;
    // The shared model picker is portaled onto <body> on purpose — it has to paint over this float — so a press
    // on its rows is "outside" by containment while still belonging to the panel: it picks a model, it does not
    // dismiss the panel that pick is being made in.
    if (e.target?.closest?.(".model-pop")) return;
    if (state.assistantPinned) return;
    toggleAssistant(false);
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
    paintAssistantBadge();
    paintSpawnStrip();
    paintAggressive();
    // The card has to exist even while the float is closed: app.js's renderConversation finds it by thread
    // anywhere in the document, and that is what keeps a running turn current instead of frozen.
    renderAssistantChat();
    if (state.assistantOpen) renderAssistant();
  }

  // The waiting spawn cards, oldest first: the strip and the badges all read this one list.
  function spawnCards() {
    return (state.assistant?.alerts || []).filter((a) => a.spawn && typeof a.spawn.prompt === "string");
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
    const alerts = state.assistant?.alerts || [];
    // Two numbers for two different things, and neither double-counted: the badge above counts NOTICES (spawn
    // cards excluded — a card is an act waiting on the reader, not a notice about the board), and the spawn badge
    // counts cards waiting on a press.
    const plain = alerts.filter((a) => !a.spawn);
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
    const s = state.assistant?.spawnCards || { open: 0, unstarted: 0 };
    const stuck = Number(s.unstarted) || 0;
    const cards = spawnCards();
    // The server's count is the fallback while its state is the only thing that has arrived (a socket replay of
    // `state` before any tab repainted its list); the page's own list wins as soon as it has rows.
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
    const cards = spawnCards().sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
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
    state.assistantTab = "alerts";
    try {
      localStorage.setItem(TAB_KEY, "alerts");
    } catch {
      /* not fatal */
    }
    toggleAssistant(true);
    requestAnimationFrame(() => {
      const sel = id ? `#as-alerts [data-alert="${CSS.escape(id)}"]` : "#as-alerts";
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

  // The header's aggressive switch. The SERVER owns the record of what the mode changed — this only paints what
  // the server says and asks it to change. The pill reads on/off so the state is legible without colour alone,
  // and the title carries the plain description of the cost.
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

  // Say something briefly beside the header button without opening a panel: a no-op press (on twice, or off when
  // it was never on) has to be acknowledged, or the button reads as broken.
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
      renderAssistantSettings(true);
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
    const mode = a?.settings?.autonomy || "draft";
    const modeEl = as$("as-mode");
    if (modeEl) {
      modeEl.textContent = mode === "draft" ? "draft-only" : mode === "auto-safe" ? "auto-safe" : "auto";
      modeEl.className = `as-mode mono${mode === "auto" ? " is-auto" : mode === "auto-safe" ? " is-safe" : ""}`;
    }
    // The tab's count is the alert count LESS the spawn cards: the spawn cards have their own strip and badge,
    // and a number that silently included them is how a card nobody started stayed invisible.
    const openAlerts = (a?.alerts || []).filter((x) => !x.spawn).length;
    const spawnOpen = spawnCards().length;
    const liveWatches = (a?.watches || []).filter((w) => w.state !== "done").length;
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
          ? `<span class="chip warn" title="aggressive mode is on — the assistant wakes on everything, checks every live card and keeps pushing until the fleet is waiting on something outside. Switch it off in the header (Alt+Shift+A)">⚡ aggressive</span>`
          : "",
        sentryState(a?.health) ? `<span class="chip warn" title="the sentry's clock is not running or has not ticked — the server watchdog restarts it, and this goes green again">sentry ${sentryState(a?.health)}</span>` : "",
        a ? `<span class="chip" title="self-wakes in the last hour (a rule set to wake, or an alert handed to it)">${a.wakes?.lastHour ?? 0}/${a.wakes?.limit ?? 0} wakes</span>` : "",
      ].join("");
    }
    for (const b of document.querySelectorAll("#as-tabs [data-as-tab]")) {
      b.classList.toggle("is-on", b.dataset.asTab === state.assistantTab);
    }
    for (const p of document.querySelectorAll("#assistant .as-pane")) {
      p.classList.toggle("hidden", p.dataset.pane !== state.assistantTab);
    }
    renderAssistantChat();
    // Coming back to Chat lands on the foot, where the composer is — the turns only scroll while the reader
    // scrolls them.
    if (state.assistantTab === "chat") pinChatToBottom();
    if (state.assistantTab === "alerts") renderAssistantAlerts();
    else if (state.assistantTab === "watches") renderAssistantWatches();
    else if (state.assistantTab === "messages") renderAssistantMessages();
    else if (state.assistantTab === "pad") renderAssistantPad();
    else if (state.assistantTab === "charter") renderAssistantCharter();
    else if (state.assistantTab === "settings") renderAssistantSettings();
  }

  // ---- chat: the assistant as one of the agents -------------------------------------------------

  function assistantIntroHtml() {
    const off = state.assistant?.enabled === false;
    return `<div class="as-intro">
      <p><b>✧ Assistant</b> reads this board and nothing else: the agents' cards, the approvals and its own
      scratchpad. It has no terminal of its own.</p>
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
        <div id="as-first-text" class="chipbox" contenteditable="true" role="textbox" aria-multiline="true" data-chipbox="as-first" spellcheck="false" data-ph="Ask it something, or tell it what to watch…"${off ? ' data-off="1"' : ""}></div>
        <div class="as-first-actions">
          <button id="btn-as-first" type="button" class="primary"${off ? " disabled" : ""}>Send to the assistant</button>
          <span class="as-hint">its own Hermes thread · it knows the board, not your repository</span>
        </div>
      </div>
    </div>`;
  }

  function renderAssistantChat() {
    const host = as$("as-chat");
    if (!host) return;
    const conv = conversations().find((c) => c.thread === state.assistantThread);
    if (!conv) {
      if (host.dataset.mode !== "intro") {
        host.dataset.mode = "intro";
        host.innerHTML = assistantIntroHtml();
        // A pasted block the reader was writing here before a reload comes back as a chip, with its text.
        restorePersistedBox(as$("as-first-text"));
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
  }

  // ---- alerts ---------------------------------------------------------------------------------

  function assistantThreadName(thread) {
    const conv = conversations().find((c) => c.thread === thread);
    return conv?.latest?.label || conv?.latest?.title || thread;
  }

  // "Open agent" has to open every accordion between the reader and the card: a card owned by a worktree
  // exists in the DOM only while its project and its row are open, and jumpToAgent alone lands on
  // #jobs — the wrong place — when it is not. Same path the row's own ⧉ badge takes.
  function openAgentThread(thread) {
    if (!thread) return;
    if (thread === state.assistantThread) {
      state.assistantTab = "chat";
      renderAssistant();
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

  function renderAssistantAlerts(force = false) {
    const host = as$("as-alerts");
    if (!host) return;
    if (!state.assistant) {
      host.innerHTML = `<div class="as-empty">connecting…</div>`;
      return;
    }
    // A poll must not take the draft the reader is writing: the list is only repainted when nothing in it
    // holds the caret, or when the reader's own action asked for it.
    if (!force && typingInside("#as-alerts")) return;
    const alerts = [...(state.assistant.alerts || [])].sort(
      (a, b) =>
        Number(Boolean(b.spawn)) - Number(Boolean(a.spawn)) ||
        Number(Boolean(b.stuck)) - Number(Boolean(a.stuck)) ||
        String(b.at).localeCompare(String(a.at)),
    );
    if (!alerts.length) {
      const w = (state.assistant.watches || []).filter((x) => x.state !== "done").length;
      host.innerHTML = `<div class="as-empty">Nothing needs you. ${w ? `Watching ${w} thing${w === 1 ? "" : "s"}.` : "No watches either."} It is still reading the board every ${state.assistant.settings?.seconds ?? 5}s.</div>`;
      return;
    }
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
    host.innerHTML = `${banner}${parts.join("")}`;
  }

  // ---- watches --------------------------------------------------------------------------------

  function renderAssistantWatches(force = false) {
    const host = as$("as-watches");
    if (!host || !state.assistant) return;
    if (!force && typingInside("#as-watches")) return;
    const watches = state.assistant.watches || [];
    const rows = watches
      .map((w) => {
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
      })
      .join("");
    const options = conversations()
      .map((c) => `<option value="${esc(c.thread)}">${esc(String(c.latest.label || c.latest.title || c.thread).slice(0, 60))}</option>`)
      .join("");
    host.innerHTML = `${rows || `<div class="as-empty">Nothing on the watchlist. Tell it in Chat (“keep an eye on…”), or add one here.</div>`}
      <div class="as-form">
        <div class="as-line">
          <select id="as-w-thread" title="which agent to watch">${options || '<option value="">(no agents yet)</option>'}</select>
          <input id="as-w-title" class="as-grow" placeholder="what to watch for — e.g. the deploy finishes" />
        </div>
        <div class="as-line">
          <label>deadline <input id="as-w-min" type="number" min="1" max="1440" placeholder="minutes" /></label>
          <button id="btn-as-watch" type="button" class="primary">Add watch</button>
          <span class="as-hint">it tells you when that thread finishes, or when the deadline passes</span>
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
    if (!state.assistantOpen || state.assistantTab !== "watches") return;
    const host = as$("as-watches");
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

  // ---- scratchpad -----------------------------------------------------------------------------

  function renderAssistantPad(force = false) {
    const host = as$("as-pad");
    if (!host || !state.assistant) return;
    if (!force && typingInside("#as-pad")) return;
    const a = state.assistant;
    const rules = a.rules || [];
    host.innerHTML = `
      <div class="as-group">
        <h4>Notes — read on every turn</h4>
        <textarea class="as-note-box" id="as-notes" rows="6" placeholder="What it should remember: how this project deploys, which agents are doing what, an answer you gave today…">${esc(a.notes || "")}</textarea>
        <div class="as-actions">
          <button id="btn-as-notes" type="button" class="primary">Save notes</button>
          <span class="as-hint">kept on the server in assistant.json</span>
          <span class="as-err" id="as-pad-err"></span>
        </div>
      </div>
      <div class="as-group">
        <h4>Standing rules — its only confident answers</h4>
        ${rules.map((r) => `<div class="as-rule-row${r.by === "assistant" ? " is-by-assistant" : ""}"><span class="as-rule-name">${esc(r.text)}${r.by === "assistant" ? `<i class="as-rule-by" title="the assistant wrote this one; delete it if it is wrong">assistant</i>` : ""}</span><button type="button" data-as-unrule="${esc(r.id)}" title="remove this rule">✕</button></div>`).join("") || `<div class="as-help">None yet. A rule is an answer you have given once and do not want to give twice.</div>`}
        <div class="as-form">
          <div class="as-line">
            <input id="as-rule-text" class="as-grow" placeholder="e.g. Deploy to QA, never PROD, from a worktree agent" />
            <button id="btn-as-rule" type="button">Add rule</button>
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

  // ---- the message board: what it sent them, and what they sent back ------------------------------

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

  function renderAssistantMessages() {
    const host = as$("as-messages");
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
    const dirs = ["all", "out", "in"];
    const dirLabel = { all: "All", out: "Sent", in: "Received" };
    const dirCount = { all: b.shown, out: b.counts?.out ?? 0, in: b.counts?.in ?? 0 };
    const groups = (b.groups || [])
      .map((g) => ({ ...g, entries: msgDir === "all" ? g.entries : g.entries.filter((e) => e.dir === msgDir) }))
      .filter((g) => g.entries.length);
    const shown = groups.reduce((n, g) => n + g.entries.length, 0);
    const chips = dirs
      .map((d) => `<button type="button" data-as-msgdir="${d}" aria-pressed="${msgDir === d ? "true" : "false"}" class="${msgDir === d ? "is-on" : ""}" title="${d === "all" ? "both directions, thread by thread" : d === "out" ? "what the assistant (or the panel) sent them" : "what they sent back"}">${dirLabel[d]} <span class="as-n">${dirCount[d]}</span></button>`)
      .join("");
    const windowLine = `<div class="as-msg-bar">
      <span class="as-msg-window" title="the window is fixed at seven days, computed from each message's own timestamp — nothing older is shown here, whatever the store still holds">the last ${b.windowDays} days</span>
      <span class="as-hint">since ${esc(new Date(b.since).toLocaleString())}</span>
      <span class="as-hint">${b.shown} entr${b.shown === 1 ? "y" : "ies"} in ${b.counts?.threads ?? 0} thread${(b.counts?.threads ?? 0) === 1 ? "" : "s"} · ${b.counts?.out ?? 0} sent · ${b.counts?.in ?? 0} received</span>
      <span class="as-hint" title="what the view was built from: the runs this panel still holds, and the assistant's own journal. An entry the store no longer holds is marked 'from the journal' where it appears.">from ${b.counts?.jobs ?? 0} runs and ${b.counts?.journal ?? 0} journal lines${b.counts?.fromJournal ? ` · ${b.counts.fromJournal} journal-only` : ""}</span>
    </div>`;
    const capLine = b.capped
      ? `<div class="as-msg-cap" title="the cap is applied on the server, so the page never receives more than this">showing the newest ${b.shown} of ${b.total} messages in the window — the older ${b.dropped} are still in the stores, past the ${b.cap}-entry cap this view reads with</div>`
      : "";
    let list;
    if (!shown) {
      list = msgDir === "all"
        ? `<div class="as-empty">Nothing in the last ${b.windowDays} days (since ${esc(new Date(b.since).toLocaleString())}). The panel holds ${b.counts?.jobs ?? 0} run${(b.counts?.jobs ?? 0) === 1 ? "" : "s"} and the assistant's journal ${b.counts?.journal ?? 0} line${(b.counts?.journal ?? 0) === 1 ? "" : "s"}, and not one of them is a message newer than that — an empty tab here is not an empty board.</div>`
        : `<div class="as-empty">No ${msgDir === "out" ? "sent" : "received"} messages in the last ${b.windowDays} days. ${b.shown} message${b.shown === 1 ? "" : "s"} exist in this window in the other direction. <button type="button" data-as-msgdir="all">Show all</button></div>`;
    } else {
      list = groups.map(msgGroupHtml).join("");
    }
    host.innerHTML = `${windowLine}${capLine}<div class="as-msg-chips" role="group" aria-label="which direction to show">${chips}</div>${list}`;
    if (scroller) scroller.scrollTop = keepScroll;
  }

  // ---- the charter: the continuity file ---------------------------------------------------------

  // The text is NOT in the polled state: it runs to 20 KB and the board repaints on every event, so the pane
  // fetches it when it is opened instead. `charterLoaded` is what keeps the box honest — a textarea that never
  // read the file must not be able to save an empty one over it, which is why Save stays disabled until the
  // GET has landed. `charterMtime` is sent back with the save so a write the assistant made in between is a
  // refusal rather than a lost edit.
  let charterText = null;
  let charterMtime = null;
  let charterLoaded = false;
  let charterTried = false;
  let charterLoadedAt = 0;
  let charterErr = "";

  async function loadCharter() {
    charterTried = true;
    try {
      const r = await apiFetch("/api/assistant/charter");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (d.assistant) applyAssistant(d.assistant);
      charterText = String(d.charter?.text ?? "");
      charterMtime = Number.isFinite(Number(d.charter?.mtime)) ? Number(d.charter.mtime) : null;
      charterLoaded = true;
      charterLoadedAt = Date.now();
      charterErr = "";
    } catch (err) {
      charterErr = String((err && err.message) || err);
    }
    renderAssistantCharter(true);
  }

  function renderAssistantCharter(force = false) {
    const host = as$("as-charter");
    if (!host || !state.assistant) return;
    if (!force && typingInside("#as-charter")) return;
    const c = state.assistant.charter || {};
    // First open: ask for the text once. `charterTried` keeps a failed fetch from re-asking on every repaint.
    if (!charterTried) void loadCharter();
    const size = charterLoaded ? String(charterText ?? "").length : Number(c.chars) || 0;
    const cap = Number(c.cap) || 0;
    const pct = cap ? Math.round((size / cap) * 100) : 0;
    const when = c.exists ? `last written ${esc(relTime(c.mtimeIso))} ago` : "not on disk yet — the panel seeds it on first boot";
    host.innerHTML = `
      <div class="as-group">
        <h4>The continuity file — the long tier, injected in full on every turn</h4>
        <div class="as-charter-meta">
          <code class="as-charter-path" title="${esc(c.path || "")}">${esc(c.path || "…")}</code>
          <span class="as-hint">${when}</span>
          <span class="as-hint${c.over ? " is-bad" : ""}">${size}/${cap} chars${c.over ? " — over the cap, prune it" : pct >= 90 ? ` (${pct}%)` : ""}</span>
        </div>
        <textarea class="as-note-box as-charter-box" id="as-charter-text" rows="16" spellcheck="false"${charterLoaded ? "" : " readonly"} placeholder="${charterLoaded ? "" : "reading the file…"}">${esc(charterText ?? "")}</textarea>
        <div class="as-actions">
          <button id="btn-as-charter" type="button" class="primary"${charterLoaded ? "" : " disabled"}>Save charter</button>
          <button id="btn-as-charter-reload" type="button">Reload from disk</button>
          <span class="as-hint">${
            charterLoaded
              ? `read from disk ${esc(relTime(new Date(charterLoadedAt).toISOString()))} ago — saving replaces the whole file`
              : "read-only until the file has been read"
          }</span>
          <span class="as-err" id="as-charter-err">${esc(charterErr)}</span>
        </div>
        <div class="as-help">This is what the assistant is handed on every turn, whole, the way the standing rules
        and the scratchpad are — Hermes does not read it by itself, the panel injects it. It is where the
        reasoning behind a rule and the lore that a compaction would take go: one dated entry per changed
        standing answer or closed long task, the oldest entries pruned first over the ${cap}-character cap. The
        assistant writes one with a CHARTER: line at the end of a reply.</div>
      </div>`;
  }

  // ---- settings -------------------------------------------------------------------------------

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

  // A saved model the catalogue no longer lists still gets a row in the shared picker — checked, so the list
  // never reads as "nothing is chosen" while a model is in force.
  function assistantModelExtra(value) {
    const id = String(value || "");
    if (!id) return [];
    const d = typeof modelsState === "undefined" ? null : modelsState;
    const known = (d?.providers || []).some((p) => (p.models || []).includes(id));
    return known ? [] : [{ id, name: `${id} (not in the catalogue)` }];
  }

  function renderAssistantSettings(force = false) {
    const host = as$("as-settings");
    if (!host || !state.assistant) return;
    if (!force && typingInside("#as-settings")) return;
    const a = state.assistant;
    const s = a.settings;
    const defs = a.ruleDefs || {};
    const levels = a.escalations || ["log", "alert", "wake", "act"];
    const autonomy = a.autonomy || ["draft", "auto-safe", "auto"];
    const autonomyLabel = {
      draft: "draft only — nothing is sent without my click",
      "auto-safe": "auto-safe — send what the assistant writes",
      auto: "auto — send any draft it has text for",
    };
    const health = a.health || {};
    const hs = sentryState(health);
    const lastPass = health.lastTickAt ? `${Math.max(0, Math.round((Date.now() - health.lastTickAt) / 1000))}s ago` : "not yet";
    // Aggressive mode: while it is on, the controls whose knobs or rules it holds are disabled here and marked,
    // so the reader can see which values are the mode's and where to switch it off. Controls the profile does
    // not touch (model, working dir, and anything else outside its list) stay usable.
    const agg = a.aggressive || {};
    const heldKnobs = new Set(agg.on ? (agg.holds && agg.holds.settings) || [] : []);
    const heldRules = new Set(agg.on ? (agg.holds && agg.holds.rules) || [] : []);
    const dis = (key) => (heldKnobs.has(key) ? ' disabled title="aggressive mode holds this setting — switch it off in the header to change it"' : "");
    const disRule = (id) => (heldRules.has(id) ? ' disabled title="aggressive mode holds this rule — switch it off in the header to change it"' : "");
    const savedLine = agg.restore
      ? `${agg.restore.present} of your own value${agg.restore.present === 1 ? "" : "s"} come back when it is switched off; ${agg.restore.absent} key${agg.restore.absent === 1 ? "" : "s"} that were absent will be deleted again so they follow their default.`
      : "";
    host.innerHTML = `
      ${agg.on
        ? `<div class="as-group as-held">
        <h4>⚡ Aggressive mode is holding these</h4>
        <div class="as-help">The settings and rules marked <b>held</b> below are set to the aggressive profile and cannot be changed from this tab. Switch aggressive mode off with the <b>⚡ Aggressive</b> button in the header (Alt+Shift+A) and they are put back exactly as you had them — ${esc(savedLine)}</div>
        <div class="as-line"><button type="button" id="btn-as-aggressive-off" title="switch aggressive mode off and put your own settings back">Switch aggressive mode off</button></div>
      </div>`
        : ""}
      <div class="as-group">
        <h4>How it behaves</h4>
        <div class="as-line">
          <label${heldKnobs.has("enabled") ? ' class="as-held-label"' : ""}>watching <input type="checkbox" data-as-set="enabled"${s.enabled ? " checked" : ""}${dis("enabled")}></label>
          <label${heldKnobs.has("autonomy") ? ' class="as-held-label"' : ""}>autonomy <select data-as-set="autonomy"${dis("autonomy")}>${autonomy.map((v) => `<option value="${v}"${s.autonomy === v ? " selected" : ""}>${esc(autonomyLabel[v] || v)}</option>`).join("")}</select></label>
        </div>
        <div class="as-line"><label${heldKnobs.has("spawn") ? ' class="as-held-label"' : ""}>create worktrees <select data-as-set="spawn"${dis("spawn")} title="whether the assistant may cut a worktree and start a worker — ask keeps a one-click card between it and git">${(a.spawnModes || ["off", "ask", "auto"]).map((v) => `<option value="${v}"${s.spawn === v ? " selected" : ""}>${v === "off" ? "off — it may not start workers" : v === "ask" ? "ask me first" : "start immediately"}</option>`).join("")}</select></label></div>
        <div class="as-line"><label title="a spawn card with no run behind it is always named after about two minutes. With this on, the panel starts that card once by itself instead of only telling you — it never retries a card it has already tried, and a card you discarded is never started">auto-start a stuck card <input type="checkbox" data-as-set="spawnAutoStart"${s.spawnAutoStart ? " checked" : ""}></label><span class="as-hint">one attempt, never a retry — off by default</span></div>
        <div class="as-line"><label title="every command line an assistant turn writes is counted against what the panel did with it: the eight kinds, one ledger per turn. report raises a red card naming the turn, the kind and how many lines were read and never carried out, and writes that to the journal the digest reads. enforce does the same and then carries those lines out once on the next pass — never a line that already ran. A near-miss line (a known prefix that misses its shape) is journalled as unparsed instead of vanishing.">command audit <select data-as-set="commandAudit">${(a.commandAuditModes || ["off", "report", "enforce"]).map((v) => `<option value="${v}"${s.commandAudit === v ? " selected" : ""}>${v === "off" ? "off — nothing is checked" : v === "report" ? "report — red card and journal" : "enforce — also replay once"}</option>`).join("")}</select></label><span class="as-hint">off by default</span></div>
        <div class="as-line"><label>model <select data-as-set="model" title="the assistant's own model — pick something small and fast; the board digest is the whole input">${modelOptionsHtml(s.model || "")}</select></label></div>
        <div class="as-line"><label title="the assistant does no work here — the gateway just refuses a run without an existing cwd. It is created if missing; leave empty for a folder beside the job store.">working dir <input type="text" spellcheck="false" data-as-set="cwd" value="${esc(s.cwd || "")}" placeholder="default: beside the job store"></label></div>
        <div class="as-help">Draft-only is the default: a reply reaches a worker only when you press Send on it. Auto-safe sends a reply the assistant itself wrote with a TO line; auto also sends anything a standing rule drafted. Creating a worktree has its own switch: <b>ask me first</b> turns a SPAWN line into a card, and nothing runs until you press it — the panel checks that card again after about two minutes, names it on its own header badge if no run exists, and (with auto-start on) starts it once rather than leaving it sitting. An approval is never answered from here at any setting.</div>
        <div class="as-help">sentry: ${hs ? `<b>${esc(hs)}</b> — the server watchdog restarts the clock and runs a missed pass` : "clock running"} · last pass ${esc(lastPass)} · every ${esc(String(health.everySeconds || s.seconds))}s${health.resumed ? " · resumed after a restart" : ""}</div>
      </div>
      <div class="as-group">
        <h4>Thresholds</h4>
        <div class="as-line"><label>pass every <input type="number" min="2" max="120" data-as-set="seconds" value="${s.seconds}"${dis("seconds")}> s</label>
          <label>same call × <input type="number" min="2" max="12" data-as-set="repeatLimit" value="${s.repeatLimit}"${dis("repeatLimit")}></label>
          <label title="consecutive turns of one thread ending on the same failure before it is reported">same failure × <input type="number" min="2" max="10" data-as-set="repeatTurns" value="${s.repeatTurns}"${dis("repeatTurns")}></label></div>
        <div class="as-line"><label>silent for <input type="number" min="30" max="3600" data-as-set="quietSeconds" value="${s.quietSeconds}"${dis("quietSeconds")}> s</label>
          <label>approval waiting <input type="number" min="15" max="3600" data-as-set="approvalSeconds" value="${s.approvalSeconds}"${dis("approvalSeconds")}> s</label></div>
        <div class="as-line"><label>context over <input type="number" min="50" max="100" data-as-set="contextPercent" value="${s.contextPercent}"${dis("contextPercent")}> %</label>
          <label>wakes / hour <input type="number" min="0" max="60" data-as-set="maxWakesPerHour" value="${s.maxWakesPerHour}"${dis("maxWakesPerHour")}></label></div>
        <div class="as-line"><label title="how recently a worker must have finished for work left in its tree to be worth a word">leftover work <input type="number" min="1" max="240" data-as-set="leftoverMinutes" value="${s.leftoverMinutes}"${dis("leftoverMinutes")}> min</label>
          <label title="a delegated subagent that writes nothing for this long is worth flagging">child silent <input type="number" min="60" max="3600" data-as-set="childQuietSeconds" value="${s.childQuietSeconds}"${dis("childQuietSeconds")}> s</label></div>
        <div class="as-help">A long build is silent too, which is why “no new output” only journals by default. Raise the repeat bar if “same call” is noisy on your agents. Leftover work and a silent child are both judged from what the board and the gateway already know — no extra git or sqlite pass.</div>
      </div>
      <div class="as-group">
        <h4>Per-rule escalation</h4>
        ${Object.entries(defs)
          .map(
            ([id, def]) => `<div class="as-rule-row">
              <span class="as-rule-name"><b>${esc(def.label)}</b><i>${esc(def.hint)}</i></span>
              <select data-as-rule="${esc(id)}"${disRule(id)}>${levels.map((v) => `<option value="${v}"${s.rules[id] === v ? " selected" : ""}>${v}</option>`).join("")}</select>
            </div>`,
          )
          .join("")}
        <div class="as-help">log keeps it in the journal · alert shows it under Alerts · wake asks the assistant about it (rate limited) · act wakes it and lets it send a reply when autonomy allows.</div>
      </div>
      <div class="as-group">
        <h4>Now</h4>
        <div class="as-line">
          <button type="button" id="btn-as-check" title="one sentry pass, no waiting for the clock">Check the board now</button>
          <button type="button" id="btn-as-wake" title="ask the assistant what it sees — one turn">Ask what it sees</button>
          <span class="as-err" id="as-set-err"></span>
        </div>
        <div class="as-help">${a.wakes.lastHour}/${a.wakes.limit} wakes in the last hour${a.wakePending ? ` · ${a.wakePending} queued behind the running turn` : ""} · scratchpad at ${esc(a.settings.model || "(gateway default model)")}</div>
      </div>`;
    // The model field is the shared picker (core/model-menu.js), not a native select: a select can only print
    // text, so it can never show a row's price, coding rating or context window — and a popup opened inside this
    // float would be clipped by its overflow instead of painting over it. The select stays in the DOM as the
    // control whose `change` the delegated [data-as-set] handler below answers.
    ModelMenu.attach(host.querySelector('select[data-as-set="model"]'), {
      models: () => (typeof modelsState === "undefined" ? null : modelsState),
      extra: assistantModelExtra,
    });
  }

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

  async function say(text, button = null) {
    const t = String(text || "").trim();
    if (!t) return;
    if (button) button.disabled = true;
    try {
      await asPost("/api/assistant/say", { text: t });
      // The intro box is gone once the card exists; clear it in case a repaint has not landed yet.
      const box = as$("as-first-text");
      if (box) writeBox(box, "");
      state.assistantTab = "chat";
      try {
        localStorage.setItem(TAB_KEY, "chat");
      } catch {
        /* not fatal */
      }
      renderAssistant();
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
  // The aggressive switch is its own button beside the Assistant one: it does not open the float, it changes how
  // the assistant behaves. The server answers whether anything changed, and the note beside it says so.
  as$("btn-aggressive")?.addEventListener("click", () => setAggressiveMode(!state.assistant?.aggressive?.on));
  as$("btn-as-close")?.addEventListener("click", () => toggleAssistant(false));
  as$("btn-as-pin")?.addEventListener("click", () => setAssistantPinned(!state.assistantPinned));
  // Capture phase, so a handler on the thing being pressed cannot keep the press from dismissing the float.
  document.addEventListener("pointerdown", onOutsidePress, true);

  as$("as-tabs")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-as-tab]");
    if (!b) return;
    state.assistantTab = b.dataset.asTab;
    // Coming back to Chat is a jump to the newest turn: the reader left the transcript to look at an alert,
    // and returning them to a scroll position that is no longer where the conversation is helps nobody.
    if (state.assistantTab === "chat") chatPinned = true;
    try {
      localStorage.setItem(TAB_KEY, state.assistantTab);
    } catch {
      /* not fatal */
    }
    renderAssistant();
  });

  as$("assistant")?.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    // Tabs are buttons too and are handled above; ignore a second pass here.
    if (t.dataset.asTab) return;

    // The message board's own two controls: the direction chips, and an entry's expander. Neither is a
    // round trip — the board is already on the page — so both are a repaint of this pane alone.
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

    if (t.dataset.asAction) {
      t.disabled = true;
      try {
        await asPost("/api/assistant/alert", { id: t.dataset.id, action: t.dataset.asAction });
        renderAssistantAlerts(true);
        if (t.dataset.asAction === "ask") state.assistantTab = "chat";
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

    if (t.dataset.asSend) {
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
      t.disabled = true;
      try {
        await asPost("/api/assistant/rule/remove", { id: t.dataset.asUnrule });
        renderAssistantPad(true);
      } catch (err) {
        setErr("as-pad-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-first") {
      // readBox: a chip pasted into the intro box is the text it swallowed.
      await say(readBox(as$("as-first-text")), t);
      return;
    }

    if (t.id === "btn-as-watch") {
      const thread = as$("as-w-thread")?.value;
      const title = String(as$("as-w-title")?.value || "").trim();
      const minutes = Number(as$("as-w-min")?.value) || null;
      if (!thread || !title) return setErr("as-w-err", "pick an agent and say what to watch for");
      t.disabled = true;
      try {
        await asPost("/api/assistant/watch", { thread, title, minutes });
        renderAssistantWatches(true);
      } catch (err) {
        setErr("as-w-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-rule") {
      const text = String(as$("as-rule-text")?.value || "").trim();
      if (!text) return;
      t.disabled = true;
      try {
        await asPost("/api/assistant/rule", { text });
        renderAssistantPad(true);
      } catch (err) {
        setErr("as-pad-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-notes") {
      const text = String(as$("as-notes")?.value || "");
      t.disabled = true;
      try {
        await asPost("/api/assistant/notes", { text });
        renderAssistantPad(true);
      } catch (err) {
        setErr("as-pad-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-charter") {
      const text = String(as$("as-charter-text")?.value ?? "");
      t.disabled = true;
      try {
        const d = await asPut("/api/assistant/charter", { text, expectMtime: charterMtime });
        charterText = String(d.charter?.text ?? text);
        charterMtime = Number.isFinite(Number(d.charter?.mtime)) ? Number(d.charter.mtime) : null;
        charterLoaded = true;
        charterLoadedAt = Date.now();
        setErr("as-charter-err", "");
        renderAssistantCharter(true);
      } catch (err) {
        // A stale save (409) and an over-cap save (413) both land here as the server's own words: the reader
        // is told what to do about it rather than that something went wrong.
        setErr("as-charter-err", err.message);
      } finally {
        t.disabled = false;
      }
      return;
    }

    if (t.id === "btn-as-charter-reload") {
      t.disabled = true;
      try {
        await loadCharter();
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
    if (el.dataset.asSet) {
      const key = el.dataset.asSet;
      const value = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
      try {
        await asPost("/api/assistant/settings", { [key]: value });
        renderAssistantSettings(true);
      } catch (err) {
        setErr("as-set-err", err.message);
      }
      return;
    }
    if (el.dataset.asRule) {
      try {
        await asPost("/api/assistant/settings", { rules: { [el.dataset.asRule]: el.value } });
        renderAssistantSettings(true);
      } catch (err) {
        setErr("as-set-err", err.message);
      }
    }
  });

  // The watch countdown: one tick a second, painting only the clocks on screen. It returns immediately when the
  // panel is closed or another tab is showing, so a board of quiet cards pays nothing for it.
  setInterval(paintWatchClocks, 1000);

  // The message board's read, on the same clock the rest of the panel refreshes on, and only while its tab
  // is the one on screen: a reader of the server's view costs nothing while nobody is looking at it. A
  // repaint is skipped while the reader has text selected in the pane — the board is a thing you read and
  // copy out of, and yanking a selection out from under them every fifteen seconds is worse than a stale
  // relative time.
  setInterval(() => {
    if (!state.assistantOpen || state.assistantTab !== "messages" || document.hidden) return;
    const host = as$("as-messages");
    const sel = window.getSelection?.();
    if (host && sel && !sel.isCollapsed && sel.anchorNode && host.contains(sel.anchorNode)) return;
    void loadMessages(true);
  }, MSG_REFRESH_MS);

  // ---- drag and resize -------------------------------------------------------------------------

  (() => {
    const el = as$("assistant");
    const head = as$("as-drag");
    const grips = as$("as-grips");
    if (!el || !head || !grips) return;

    const MIN_W = 340;
    const MIN_H = 320;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

    // The frame is sized against the LAYOUT viewport (see `viewportBox`), never against `visualViewport`: the visual
    // one excludes the classic scrollbar, so clamping to it snapped a frame parked on the layout viewport's edge
    // inward by the scrollbar's width the instant a grab started.
    const viewport = () => viewportBox();

    // Anchor the frame with left/top before any gesture. The stylesheet right-anchors it (`right: 16px`), and a float
    // anchored by `right` grows its LEFT edge: with no remembered rect the first resize drag could travel 8px before
    // its own clamp froze it, while the pointer walked on. `getBoundingClientRect` is the state it actually has.
    const pinFrame = () => {
      const r = el.getBoundingClientRect();
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
      return r;
    };

    const onDown = (mode, dir, captureEl) => (e) => {
      if (e.button !== 0) return;
      if (state.assistantFull) return; // maximized, the frame is the viewport: Esc or a double-click restores
      if (mode === "move" && e.target.closest("button,input,select,textarea")) return;
      const r = pinFrame();
      dragState = { mode, dir, px: e.clientX, py: e.clientY, x: r.left, y: r.top, w: r.width, h: r.height };
      el.classList.add("is-dragging");
      // Hold the pointer for the length of the gesture: without capture it leaves the float (and the window) and the
      // moves stop arriving, so a release out there never ends the drag we started in here.
      try {
        (captureEl || el).setPointerCapture(e.pointerId);
      } catch {
        /* older pointer stacks: the window listeners below still carry the gesture */
      }
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragState) return;
      const d = dragState;
      const { vw, vh } = viewport();
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (d.mode === "move") {
        // Keep the whole float inside the window. The old clamp allowed `8 - width + 120`, which let the left
        // edge sit ~160px off-screen — the tabs and the first characters of every transcript row went with it.
        const maxX = Math.max(EDGE, vw - Math.min(d.w, vw - 2 * EDGE) - EDGE);
        const maxY = Math.max(EDGE, vh - Math.min(d.h, vh - 2 * EDGE) - EDGE);
        // A frame already outside the box (a rect remembered on a bigger screen) is left where it is until the drag
        // pulls it back in — clamping it to `EDGE` here would snap it to the top-left corner on the grab itself.
        const x = clamp(d.x + dx, Math.min(EDGE, d.x), Math.max(maxX, d.x));
        const y = clamp(d.y + dy, Math.min(EDGE, d.y), Math.max(maxY, d.y));
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
        // Absorb what the clamp ate into the drag's own origin. Otherwise the pointer has to walk the whole overshoot
        // back before the frame stirs, which is what "the cursor came off the window" feels like.
        d.px += d.x + dx - x;
        d.py += d.y + dy - y;
        return;
      }

      const dir = d.dir || "se";
      let x = d.x, y = d.y, w = d.w, h = d.h;

      // The limits below never ask for LESS than the size the frame already has. A frame wider or taller than the
      // room left — from an older build's clamp, a rotated screen, a narrower window, a zoom change — would otherwise
      // be snapped down to the limit on the first pixel of the drag, which is the grab that "jumps".
      if (dir.includes("e")) {
        const want = d.w + dx;
        w = clamp(want, MIN_W, Math.max(d.w, vw - EDGE - d.x));
        d.px += want - w;
      } else if (dir.includes("w")) {
        const wantX = d.x + dx;
        x = clamp(wantX, EDGE, d.x + d.w - MIN_W);
        w = d.x + d.w - x;
        d.px += wantX - x;
      }

      if (dir.includes("s")) {
        const want = d.h + dy;
        h = clamp(want, MIN_H, Math.max(d.h, vh - EDGE - d.y));
        d.py += want - h;
      } else if (dir.includes("n")) {
        const wantY = d.y + dy;
        y = clamp(wantY, EDGE, d.y + d.h - MIN_H);
        h = d.y + d.h - y;
        d.py += wantY - y;
      }

      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    };

    const onUp = () => {
      if (!dragState) return;
      dragState = null;
      el.classList.remove("is-dragging");
      const r = currentRect();
      if (r) {
        state.assistantRect = r;
        writeRect(r);
      }
    };

    head.addEventListener("pointerdown", onDown("move", null, head));
    grips.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest("[data-dir]");
      if (!grip) return;
      onDown("size", grip.dataset.dir, grip)(e);
    });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    // Double-click the header: the gesture the reader already makes on a window's title bar. Buttons in the
    // head (pin / maximize / close) keep their own clicks.
    head.addEventListener("dblclick", (e) => {
      if (e.target.closest("button,input,select,textarea")) return;
      e.preventDefault();
      setAssistantFull(!state.assistantFull);
    });

    const maxBtn = as$("btn-as-max");
    if (maxBtn) maxBtn.addEventListener("click", () => setAssistantFull(!state.assistantFull));
  })();

  // Which way the chat is being read: the reader's own scroll decides whether a repaint lands on the newest
  // turn or holds their place. Ours (pinChatToBottom) lands at the bottom, which is what "pinned" means.
  document.addEventListener(
    "scroll",
    (e) => {
      const body = e.target;
      if (!body?.matches?.("#as-chat > .job > .job-body")) return;
      chatPinned = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
    },
    true,
  );

  // Keep the panel on screen when the window shrinks: a remembered position from a 4K screen must not open
  // half outside a laptop screen.
  window.addEventListener("resize", () => {
    if (!state.assistantOpen) return;
    // Maximized, the frame follows the viewport through CSS — writing the measured rect here would overwrite
    // the window the reader comes back to with the fullscreen size.
    if (state.assistantFull) return;
    placeAssistant();
    const r = currentRect();
    if (r) {
      state.assistantRect = r;
      writeRect(r);
    }
  });

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
    // Maximized, Esc puts the float back — wherever the caret is, since the panel is the whole window and the
    // reader is almost always typing in its composer.
    if (state.assistantFull) {
      e.preventDefault();
      setAssistantFull(false);
      return;
    }
    // Otherwise Esc closes the float only when the caret is in it: a reader dismissing something on the
    // board, or a model popup, must not lose the panel.
    if (document.activeElement && el.contains(document.activeElement)) {
      e.preventDefault();
      toggleAssistant(false);
    }
  });

  // ---- boot ------------------------------------------------------------------------------------

  // app.js's boot fills state from the first snapshot and connects the stream; this restores the frame in the
  // same breath, so a reload opens on the panel the reader left open.
  (function restoreFrame() {
    const el = as$("assistant");
    if (!el) return;
    el.hidden = !state.assistantOpen;
    as$("btn-assistant")?.classList.toggle("is-on", state.assistantOpen);
    placeAssistant();
    paintAssistantPin();
    paintAssistantMax();
    paintAssistantBadge();
    paintAggressive();
    if (state.assistantOpen) renderAssistant();
  })();

  // app.js calls these: applyAssistant from the snapshot, the SSE event and after a reply; the chat renderer
  // when a job event arrives for a card that does not exist yet (the float may never have been opened).
  window.applyAssistant = applyAssistant;
  window.__assistantRenderChat = renderAssistantChat;
  window.__assistantToggle = toggleAssistant;
})();
