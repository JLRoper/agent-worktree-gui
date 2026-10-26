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
  const TABS = ["chat", "alerts", "watches", "pad", "charter", "settings"];

  // Ticks on a multi-select question outlive a repaint: the alerts pane is rebuilt whenever the assistant's
  // state changes, and a selection that vanishes on the next job event is the same bug as a lost draft.
  const parkedPicks = new Map(); // alert id -> Set(choice index)
  // "(Recommended)" is the gateway's decoration, not part of the label an answer needs to send.
  const stripRecommended = (c) => String(c).replace(/\s*\(Recommended\)\s*$/i, "");

  const as$ = (id) => document.getElementById(id);

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

  let dragState = null;

  // ---- the panel's own frame ------------------------------------------------------------------

  function placeAssistant() {
    const el = as$("assistant");
    if (!el) return;
    const r = state.assistantRect || readRect();
    if (!r) return;
    const maxW = window.innerWidth - 16;
    const maxH = window.innerHeight - 16;
    const w = Math.max(320, Math.min(r.w, maxW));
    const h = Math.max(220, Math.min(r.h, maxH));
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.left = `${Math.max(8, Math.min(r.x, window.innerWidth - w - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(r.y, window.innerHeight - h - 8))}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  function currentRect() {
    const el = as$("assistant");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
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
    // The header button toggles for itself: closing here first would make its own click reopen the float.
    if (e.target?.closest?.("#btn-assistant")) return;
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
    // The card has to exist even while the float is closed: app.js's renderConversation finds it by thread
    // anywhere in the document, and that is what keeps a running turn current instead of frozen.
    renderAssistantChat();
    if (state.assistantOpen) renderAssistant();
  }

  function paintAssistantBadge() {
    const btn = as$("btn-assistant");
    const badge = as$("assistant-badge");
    if (!btn || !badge) return;
    const alerts = state.assistant?.alerts || [];
    const n = alerts.length;
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? "99+" : String(n);
    const newest = alerts.reduce((t, a) => Math.max(t, Date.parse(a.at) || 0), 0);
    btn.classList.toggle("is-hot", n > 0 && newest > (state.assistantSeenAt || 0));
    btn.title = n
      ? `assistant — ${n} thing${n === 1 ? "" : "s"} on the board need${n === 1 ? "s" : ""} a look (A or Ctrl+Shift+A)`
      : "assistant — watches the agents on this board, notices loops and stalls, and drafts answers to a worker's questions (A or Ctrl+Shift+A)";
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
    const openAlerts = (a?.alerts || []).length;
    const liveWatches = (a?.watches || []).filter((w) => w.state !== "done").length;
    if (as$("as-alert-n")) as$("as-alert-n").textContent = String(openAlerts);
    if (as$("as-watch-n")) as$("as-watch-n").textContent = String(liveWatches);
    if (as$("as-chips")) {
      as$("as-chips").innerHTML = [
        a?.running ? `<span class="chip warn" title="its own turn is running">thinking</span>` : "",
        a && a.enabled === false ? `<span class="chip" title="the sentry is off — no rule is being evaluated">off</span>` : "",
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
    if (state.assistantTab === "alerts") renderAssistantAlerts();
    else if (state.assistantTab === "watches") renderAssistantWatches();
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
    return `<div class="as-alert is-${esc(a.severity || "warn")}${spawn ? " is-spawn" : ""}${parked ? " is-parked" : ""}" data-alert="${esc(a.id)}">
      <div class="as-alert-head">
        <span class="as-rule is-${esc(a.severity || "warn")}">${esc(a.rule)}</span>
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
    const alerts = state.assistant.alerts || [];
    if (!alerts.length) {
      const w = (state.assistant.watches || []).filter((x) => x.state !== "done").length;
      host.innerHTML = `<div class="as-empty">Nothing needs you. ${w ? `Watching ${w} thing${w === 1 ? "" : "s"}.` : "No watches either."} It is still reading the board every ${state.assistant.settings?.seconds ?? 5}s.</div>`;
      return;
    }
    host.innerHTML = alerts.map(alertHtml).join("");
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

  function modelOptionsHtml(selected) {
    const choices = typeof modelChoices === "function" ? modelChoices() : [{ id: "", label: "(default)" }];
    // A model the catalogue no longer lists must still render, or saving the panel would silently replace it.
    if (selected && !choices.some((c) => c.id === selected)) choices.push({ id: selected, label: `${selected} (not in the catalogue)` });
    return choices
      .map((c) => `<option value="${esc(c.id)}"${c.id === selected ? " selected" : ""}>${esc(c.label)}${c.group ? ` · ${esc(c.group)}` : ""}</option>`)
      .join("");
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
    host.innerHTML = `
      <div class="as-group">
        <h4>How it behaves</h4>
        <div class="as-line">
          <label>watching <input type="checkbox" data-as-set="enabled"${s.enabled ? " checked" : ""}></label>
          <label>autonomy <select data-as-set="autonomy">${autonomy.map((v) => `<option value="${v}"${s.autonomy === v ? " selected" : ""}>${esc(autonomyLabel[v] || v)}</option>`).join("")}</select></label>
        </div>
        <div class="as-line"><label>create worktrees <select data-as-set="spawn" title="whether the assistant may cut a worktree and start a worker — ask keeps a one-click card between it and git">${(a.spawnModes || ["off", "ask", "auto"]).map((v) => `<option value="${v}"${s.spawn === v ? " selected" : ""}>${v === "off" ? "off — it may not start workers" : v === "ask" ? "ask me first" : "start immediately"}</option>`).join("")}</select></label></div>
        <div class="as-line"><label>model <select data-as-set="model" title="the assistant's own model — pick something small and fast; the board digest is the whole input">${modelOptionsHtml(s.model || "")}</select></label></div>
        <div class="as-line"><label title="the assistant does no work here — the gateway just refuses a run without an existing cwd. It is created if missing; leave empty for a folder beside the job store.">working dir <input type="text" spellcheck="false" data-as-set="cwd" value="${esc(s.cwd || "")}" placeholder="default: beside the job store"></label></div>
        <div class="as-help">Draft-only is the default: a reply reaches a worker only when you press Send on it. Auto-safe sends a reply the assistant itself wrote with a TO line; auto also sends anything a standing rule drafted. Creating a worktree has its own switch: <b>ask me first</b> turns a SPAWN line into a card, and nothing runs until you press it. An approval is never answered from here at any setting.</div>
        <div class="as-help">sentry: ${hs ? `<b>${esc(hs)}</b> — the server watchdog restarts the clock and runs a missed pass` : "clock running"} · last pass ${esc(lastPass)} · every ${esc(String(health.everySeconds || s.seconds))}s${health.resumed ? " · resumed after a restart" : ""}</div>
      </div>
      <div class="as-group">
        <h4>Thresholds</h4>
        <div class="as-line"><label>pass every <input type="number" min="2" max="120" data-as-set="seconds" value="${s.seconds}"> s</label>
          <label>same call × <input type="number" min="2" max="12" data-as-set="repeatLimit" value="${s.repeatLimit}"></label>
          <label title="consecutive turns of one thread ending on the same failure before it is reported">same failure × <input type="number" min="2" max="10" data-as-set="repeatTurns" value="${s.repeatTurns}"></label></div>
        <div class="as-line"><label>silent for <input type="number" min="30" max="3600" data-as-set="quietSeconds" value="${s.quietSeconds}"> s</label>
          <label>approval waiting <input type="number" min="15" max="3600" data-as-set="approvalSeconds" value="${s.approvalSeconds}"> s</label></div>
        <div class="as-line"><label>context over <input type="number" min="50" max="100" data-as-set="contextPercent" value="${s.contextPercent}"> %</label>
          <label>wakes / hour <input type="number" min="0" max="60" data-as-set="maxWakesPerHour" value="${s.maxWakesPerHour}"></label></div>
        <div class="as-line"><label title="how recently a worker must have finished for work left in its tree to be worth a word">leftover work <input type="number" min="1" max="240" data-as-set="leftoverMinutes" value="${s.leftoverMinutes}"> min</label>
          <label title="a delegated subagent that writes nothing for this long is worth flagging">child silent <input type="number" min="60" max="3600" data-as-set="childQuietSeconds" value="${s.childQuietSeconds}"> s</label></div>
        <div class="as-help">A long build is silent too, which is why “no new output” only journals by default. Raise the repeat bar if “same call” is noisy on your agents. Leftover work and a silent child are both judged from what the board and the gateway already know — no extra git or sqlite pass.</div>
      </div>
      <div class="as-group">
        <h4>Per-rule escalation</h4>
        ${Object.entries(defs)
          .map(
            ([id, def]) => `<div class="as-rule-row">
              <span class="as-rule-name"><b>${esc(def.label)}</b><i>${esc(def.hint)}</i></span>
              <select data-as-rule="${esc(id)}">${levels.map((v) => `<option value="${v}"${s.rules[id] === v ? " selected" : ""}>${v}</option>`).join("")}</select>
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
  as$("btn-as-close")?.addEventListener("click", () => toggleAssistant(false));
  as$("btn-as-pin")?.addEventListener("click", () => setAssistantPinned(!state.assistantPinned));
  // Capture phase, so a handler on the thing being pressed cannot keep the press from dismissing the float.
  document.addEventListener("pointerdown", onOutsidePress, true);

  as$("as-tabs")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-as-tab]");
    if (!b) return;
    state.assistantTab = b.dataset.asTab;
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

    if (t.dataset.asSpawn) {
      const id = t.dataset.asSpawn;
      t.disabled = true;
      const was = t.textContent;
      t.textContent = "cutting the worktree…";
      try {
        const d = await asPost("/api/assistant/spawn", { id }, { timeoutMs: 150_000 });
        showNote(`worker started · ${d.job?.thread || d.job?.id || ""}`);
        renderAssistantAlerts(true);
        renderAssistant();
      } catch (err) {
        const slot = document.querySelector(`[data-as-err="${CSS.escape(id)}"]`);
        if (slot) slot.textContent = err.message;
        t.textContent = was;
      } finally {
        t.disabled = false;
      }
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

  // ---- drag and resize -------------------------------------------------------------------------

  (() => {
    const el = as$("assistant");
    const head = as$("as-drag");
    const grip = as$("as-resize");
    if (!el || !head || !grip) return;

    const onDown = (mode) => (e) => {
      if (e.button !== 0) return;
      if (mode === "move" && e.target.closest("button,input,select,textarea")) return;
      const r = el.getBoundingClientRect();
      dragState = { mode, px: e.clientX, py: e.clientY, x: r.left, y: r.top, w: r.width, h: r.height };
      el.classList.add("is-dragging");
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragState) return;
      const d = dragState;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (d.mode === "move") {
        const maxX = window.innerWidth - 80;
        const maxY = window.innerHeight - 40;
        const x = Math.max(8 - d.w + 120, Math.min(d.x + dx, maxX));
        const y = Math.max(8, Math.min(d.y + dy, maxY));
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
        return;
      }
      const w = Math.max(340, Math.min(d.w + dx, window.innerWidth - d.x - 8));
      const h = Math.max(260, Math.min(d.h + dy, window.innerHeight - d.y - 8));
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
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

    head.addEventListener("pointerdown", onDown("move"));
    grip.addEventListener("pointerdown", onDown("size"));
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  })();

  // Keep the panel on screen when the window shrinks: a remembered position from a 4K screen must not open
  // half outside a laptop screen.
  window.addEventListener("resize", () => {
    if (!state.assistantOpen) return;
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
    // Esc closes the float only when the caret is in it: a reader dismissing something on the board, or a
    // model popup, must not lose the panel.
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
    paintAssistantBadge();
    if (state.assistantOpen) renderAssistant();
  })();

  // app.js calls these: applyAssistant from the snapshot, the SSE event and after a reply; the chat renderer
  // when a job event arrives for a card that does not exist yet (the float may never have been opened).
  window.applyAssistant = applyAssistant;
  window.__assistantRenderChat = renderAssistantChat;
  window.__assistantToggle = toggleAssistant;
})();
