// assistant/watches.js - one assistant's watchlist: the row it draws, the pane that holds the list and its add
// form, and the clock that runs each deadline's number and its bar down in place.
//
// CUT 1 of the four cuts public/assistant.js's card names, and a move rather than a rewrite. The block left
// public/assistant.js at lines 2852-2952, line for line: watchRowHtml, renderAssistantWatches, leftText and
// paintWatchClocks, with the section's own begin and end markers around them. Not one body was rewritten, not one
// name renamed and not one call site touched.
//
// WHY THIS BLOCK, AND NOT THE PLAN'S FIRST. The plan's card was not in this tree when the cut was made (no report
// under docs/ names four cuts of this file), so the rule was the file's own: take the first section in file order
// that the file delimits with a begin and an end marker and whose seam is small enough to hand over in one list.
// The first marker-delimited block is the float's two rows, and it is not separable - it defines 26 names the rest
// of the file reads and takes 2 back. Watches is the first that is: 4 names in, 2 names out, no state of the
// source's crossing the seam. The report beside the commit carries the measurement for every candidate.
//
// WHY A FACTORY. public/assistant.js is one IIFE, so its helpers are not page-wide names and a plain classic
// script could not reach them. This file therefore declares ONE thing: a factory, the same contract
// public/queue-cards.js uses. public/index.html loads it after app.js and before assistant.js; the panel calls it
// once, when it loads, hands its helpers in, and gets the pane's names back under exactly the spellings the call
// sites in assistant.js already use.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move):
//
//   handed in                selectedSessionId, hostFor, paneIdFor, typingInside, sessionById, isAssistant,
//                            assistantThreadName and FIRST_ASSISTANT, all of them inside public/assistant.js's
//                            IIFE and given here as this factory's one argument.
//   page-wide already        esc (public/core/dom-format.js), state (public/app.js) and conversations()
//                            (public/turns.js), which the pane reads itself, as it did before the move.

window.WMApp = window.WMApp || {};
window.WMApp.assistantWatches = function assistantWatches(deps) {
  "use strict";
  const {
    selectedSessionId, hostFor, paneIdFor, typingInside,
    sessionById, isAssistant, assistantThreadName, FIRST_ASSISTANT,
  } = deps;

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

  // The two names the panel keeps reading after the move: the paint of one assistant's pane, and the clock the
  // panel's own one-second ticker drives.
  return { renderAssistantWatches, paintWatchClocks };
};
