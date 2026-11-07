// core/turn-fold.js — the transcript renderer's fold book: which turn a card opens on, what the pager folds on the
// way past, and the one copy the gesture leaves for the reader's own click.
//
// The fold state used to be answered in two files. app.js's renderer decided "open" from `state.turnOpen`, and its
// pager arithmetic lived in three separate places (the page's own slice in `conversationHtml`, the count beside the
// arrows, and the click that moved the offset). assistant.js reached into `state.turnOpen` / `state.turnPage` itself
// to unfold the newest turn for a queue row — and could not page to it, because it re-derived the thread's turns and
// wrote only the fold: a reader who had paged back landed on the card with the turn's console missing. Every rule
// below already existed in one of those files. This module writes each one once and both callers go through it.
//
// The three books it owns, all on `state`:
//
//   turnOpen     "<turn id>" -> open/closed for the turn in its page; "pin:<turn id>" -> the starred copy above it
//   turnCompact  the same keys -> that copy is frozen to a snippet rather than merely folded
//   turnPage     thread -> how many pages back from the newest that card is showing (absent = the newest page)
//
// What it decides, and why:
//
//   isOpen     an entry the reader made wins. With no entry the newest turn is open and every older one is folded:
//              a card opens showing its current turn and lists the rest as one line each. The pinned copy is the
//              exception both ways — it starts folded (a pin is a REFERENCE to a turn, and one that arrived
//              expanded would push down the page it is pinned above) and it opens only on a click.
//   foldPage   paging past a page folds every turn ON that page. That is the reader's collapse gesture: up folds the
//              page being read, and coming back down folds the page that was only passed through, so a thread read
//              through the pager ends with every turn closed. The pinned copy is deliberately NOT folded: it sits
//              above the page on every page and never leaves the screen in this gesture, so it is not "the page I
//              left", and something the reader opened on purpose is not closed by a gesture about something else.
//   reveal     put one turn in front of the reader: unfolded, un-frozen, and on the page it lives on. The panel's
//              jump paths and the assistant's "open this turn" all mean exactly this, and none of them should have to
//              spell out three books to say it.
//   foldAll    one direction for every turn, both copies: Collapse all / Expand all and the Ctrl+[ turns tier. The
//              reader asked for the turns, not for the page they happen to be on.
//
// No DOM and no rendering here — callers paint, this file decides. Published on globalThis as `wtTurnFold`; loaded
// before app.js in public/index.html, used by public/app.js and public/assistant.js, imported by
// test/turn-fold.test.js. `docs/turn-fold.md` is the long form: the rule, the three books, and the browser proof.
(function (root) {
  "use strict";

  // The marker a turn's pinned duplicate carries in the fold book (and in the head's `data-toggle-turn`).
  const PIN = "@pin";
  // Five turns a page: a thread longer than this is one the reader walks rather than scrolls, and the count beside
  // the arrows ("3–7 / 7") is read against this number.
  const PER_PAGE = 5;

  // One turn, two copies: the one in its page (`turn.id`) and the pinned one above it (`pin:<turn id>`). The key is
  // spelled here and nowhere else, so a reader's click, a render and a prune cannot disagree about it.
  function key(turnId, copy = "") {
    return copy === PIN ? `pin:${turnId}` : String(turnId);
  }
  function idOf(k) {
    const s = String(k == null ? "" : k);
    return s.startsWith("pin:") ? s.slice(4) : s;
  }
  const isPinCopy = (k) => String(k == null ? "" : k).startsWith("pin:");
  // A turn object, a job, or an id: every entry point here takes whichever the caller already has.
  const idOfTurn = (turn) => (turn && typeof turn === "object" ? turn.id : turn);

  // ---- the fold itself ------------------------------------------------------------------------------------------
  // Is this copy of the turn open? `latestId` is the newest turn of the conversation, which is the one a card paints
  // open when nothing has been written about it.
  function isOpen(state, turn, latestId = null, copy = "") {
    const id = idOfTurn(turn);
    const forced = state.turnOpen.get(key(id, copy));
    if (forced !== undefined) return Boolean(forced);
    if (copy === PIN) return false;
    return id === latestId;
  }

  function setOpen(state, turn, open, copy = "") {
    state.turnOpen.set(key(idOfTurn(turn), copy), Boolean(open));
  }

  // The other way round, and reading a turn in full un-freezes it (a snippet is a folded form, and opening one has to
  // give the whole turn rather than the one line it was frozen to).
  function toggle(state, turn, latestId, copy = "") {
    const open = !isOpen(state, turn, latestId, copy);
    setOpen(state, turn, open, copy);
    unfreeze(state, turn, copy);
    return open;
  }

  // A turn that is open carries no snippet: the frozen form is a shorter way to say a closed turn, and a stale mark
  // left behind would resurface the next time the turn is folded.
  function unfreeze(state, turn, copy = "") {
    state.turnCompact.delete(key(idOfTurn(turn), copy));
  }

  // The frozen form of a folded turn: a readable snippet instead of one request line. It is still a CLOSED turn, so
  // this never opens one — "freeze a snippet" is a way to close what the reader was reading, not a third state.
  function freeze(state, turn, copy = "") {
    state.turnCompact.add(key(idOfTurn(turn), copy));
  }

  // ---- the pager ------------------------------------------------------------------------------------------------
  // How many pages a thread of this many turns has. Never zero: a card with one turn is one page, and the pager is
  // not drawn at all (the card draws it only when there is somewhere to go).
  function pages(total, per = PER_PAGE) {
    return Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / per));
  }

  // The offset a card is on, clamped to the pages that exist NOW — the store trims old turns, and a remembered
  // offset from before a trim would otherwise show a page that is no longer there.
  function offset(state, thread, total, per = PER_PAGE) {
    return Math.min(pages(total, per) - 1, Math.max(0, state.turnPage.get(thread) || 0));
  }

  // What one page holds. `start`/`end` are slice bounds into the clock-ordered `turns` (`end` exclusive). The page at
  // offset 0 is the NEWEST `per` turns — a card opens at its end — and each step back walks toward the oldest, which
  // is why the slice counts from the end rather than from the start.
  function range(total, off, per = PER_PAGE) {
    const p = pages(total, per);
    const at = Math.min(p - 1, Math.max(0, off || 0));
    const end = Math.max(0, Math.max(0, Number(total) || 0) - at * per);
    return { offset: at, pages: p, start: Math.max(0, end - per), end };
  }

  // The newest page is the ABSENCE of a page: every reader who never pressed an arrow has no entry, and the card's
  // own signature reads the map that way, so "back to the newest" deletes rather than writing a 0.
  function setOffset(state, thread, off) {
    if (off > 0) state.turnPage.set(thread, off);
    else state.turnPage.delete(thread);
  }

  function resetPage(state, thread) {
    state.turnPage.delete(thread);
  }

  // One arrow press. Returns the page the reader is LEAVING and the one they land on — `left` is what the fold
  // gesture needs, and it has to be read before the offset moves. null when the arrow is at its own end (the buttons
  // are drawn disabled there, so this is the honest answer for a press that arrives anyway): nothing moved, so
  // nothing folds.
  function stepPage(state, thread, total, dir, per = PER_PAGE) {
    const from = range(total, offset(state, thread, total, per), per);
    const to = dir === "older" ? Math.min(from.pages - 1, from.offset + 1) : Math.max(0, from.offset - 1);
    if (to === from.offset) return null;
    setOffset(state, thread, to);
    return { from: from.offset, to, left: from };
  }

  // The offset that SHOWS one turn. The pager counts backwards from the newest page, so the answer is how many whole
  // pages of NEWER turns stand between this turn and the end of the thread. It is not `pages - floor(index/per)`:
  // that only agrees when the thread divides evenly into pages. Seven turns of five put the third turn on the newest
  // page, while the old formula answered page 1 — a jump to that turn left the pager showing turns 1–2, and the
  // console the caller meant to scroll to was not on the page at all.
  function pageForIndex(total, index, per = PER_PAGE) {
    const count = Math.max(0, Number(total) || 0);
    const last = Math.max(0, count - 1);
    const i = Math.min(Math.max(0, index), last);
    return Math.floor((last - i) / per);
  }

  function gotoPageForIndex(state, thread, total, index, per = PER_PAGE) {
    setOffset(state, thread, pageForIndex(total, index, per));
  }

  // ---- the gestures ---------------------------------------------------------------------------------------------
  // The page just left folds — every turn on it, and never the pinned copy (see the header). `off` is the offset the
  // reader LEFT, which is `stepPage`'s `left.offset`, not the one they landed on.
  function foldPage(state, turns, off, per = PER_PAGE) {
    const list = Array.isArray(turns) ? turns : [];
    const r = range(list.length, off, per);
    for (const turn of list.slice(r.start, r.end)) setOpen(state, turn.id, false);
    return { start: r.start, end: r.end };
  }

  // Every turn, in one direction. Both copies move: this is the reader asking for all of them, so a starred copy left
  // open above a collapsed card would be the one body still on screen.
  function foldAll(state, turns, pinnedIds, open) {
    const pinned = pinnedIds && typeof pinnedIds.has === "function" ? pinnedIds : new Set(pinnedIds || []);
    for (const turn of Array.isArray(turns) ? turns : []) {
      setOpen(state, turn.id, open);
      if (pinned.has(turn.id)) setOpen(state, turn.id, open, PIN);
    }
  }

  // Put one turn in front of the reader: unfolded, un-frozen, on its own page. Returns what it had to change, so a
  // caller that already owns a repaint can skip it when nothing moved.
  function reveal(state, thread, turns, turnId) {
    const list = Array.isArray(turns) ? turns : [];
    const index = list.findIndex((t) => t.id === turnId);
    if (index < 0) return { found: false, changed: false, page: null };
    const latestId = list.length ? list[list.length - 1].id : null;
    const page = pageForIndex(list.length, index);
    const changed =
      !isOpen(state, turnId, latestId) || offset(state, thread, list.length) !== page || state.turnCompact.has(key(turnId));
    setOpen(state, turnId, true);
    state.turnCompact.delete(key(turnId));
    setOffset(state, thread, page);
    return { found: true, changed, page };
  }

  // Forget what the board no longer holds: a cleared job takes its fold entries with it (a pinned copy prunes on the
  // turn it belongs to), and a cleared thread takes its remembered page. Called from the render that rebuilds the
  // board, so the books cannot outgrow the jobs they describe.
  function prune(state, { turnIds = new Set(), threads = new Set() } = {}) {
    const live = turnIds && typeof turnIds.has === "function" ? turnIds : new Set(turnIds || []);
    const liveThreads = threads && typeof threads.has === "function" ? threads : new Set(threads || []);
    let forgotten = 0;
    for (const k of [...state.turnOpen.keys()]) {
      if (live.has(idOf(k))) continue;
      state.turnOpen.delete(k);
      state.turnCompact.delete(k);
      forgotten += 1;
    }
    for (const thread of [...state.turnPage.keys()]) if (!liveThreads.has(thread)) state.turnPage.delete(thread);
    return forgotten;
  }

  root.wtTurnFold = {
    PIN,
    PER_PAGE,
    key,
    idOf,
    isPinCopy,
    isOpen,
    setOpen,
    toggle,
    unfreeze,
    freeze,
    pages,
    offset,
    range,
    setOffset,
    resetPage,
    stepPage,
    pageForIndex,
    gotoPageForIndex,
    foldPage,
    foldAll,
    reveal,
    prune,
  };
})(globalThis);
