// board/replies.js - the reply box's queue, its held replies and the send and steer paths, cut out of
// public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js is the file six open queue rows claimed at 2026-11-28. This is
// cut 2 of the eight in docs/reports/module-separation-2026-11-28.html, section 5's card for
// public/app.js: "the held reply, the reply queue, send and steer". Moved line for line: not one
// body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   the draft a send consumed   clearSentDraft and captureTyping: the ONE place a sent reply is
//                               cleared from all three stores (state.replyDrafts, the paste-chip
//                               mirror this tab keeps, and the box's own DOM).
//   the session's own words     turnPrompts: everything the reader said on one session, oldest
//                               first, which is what Up steps back through.
//   the queue                   replyQueued, queueReply, queueReplyFromBox, queuePressInFlight,
//                               queueWaitingOn, queueWaitPhrase, pressSettled, paintQueueWait,
//                               queueOfferedFor, steerOfferedFor, steerFromBox, heldReplyBlocked,
//                               takeQueuedReply, markReplySent, replyTakenByDrain, cancelQueuedReply,
//                               childrenOut and threadBusy: what the Queue and Steer controls
//                               decide, and what the card says while they wait.
//   the held reply              postHeldReply, cancelHeldReply, retryHeldReply, heldRepliesLoaded,
//                               loadHeldReplies, acceptHeldReply, applyHeldReplies and heldIdFor: the
//                               panel's record of a reply that is waiting for the turn in front of
//                               it, and the write-through that ties the page's entry to it.
//   the drain                   drainReplyQueue: one entry per pass, the next one only when that
//                               turn ends, never a burst.
//   the ghost editor            queuedEditFor, ghostTurnHtml, openQueuedEdit, saveQueuedEdit,
//                               cancelQueuedEdit and revertEditOnClickAway: the entry opened for
//                               editing, and the click-away that can only ever revert it.
//   send and steer              sendReply and steerTurn: the two things the box's own buttons do.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state.replyDrafts, state.replyEdit, state.replyHistory, state.jobs, state.boxModels,
//   state.justSent, state.prevTurnMode
//                           the stores the box and the queue keep.
//   apiFetch (core/transport.js), readBox, writeBox, clearBoxDraft, transferBoxModel and
//   setCaretOffset (board/paste-chips.js), esc and normPath (core/dom-format.js), wtTurnFold
//   (core/turn-fold.js), and public/app.js's own $, showBanner, showNote, growReplyBox,
//   growBoxToDraft, renderConversation, refreshChipCount, paintChrome, attachFile, the
//   previous-turn plan and the composer's own focus helpers.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a
// top-level `function` here is a window property and a top-level `let` here (heldRepliesLoaded) is a
// binding every other script reads by bare name. index.html loads this file before app.js, and the
// file DECLARES ONLY - nothing here reads a `state` field or an app.js binding while it loads - so
// sitting before app.js costs nothing and cannot land in a temporal dead zone. public/app.js
// re-exports these names on window.WMApp.replies, which is the door public/render-jobs.js,
// public/render-projects.js, public/assistant.js and public/core/sse.js already reach for.
//
// WHAT STAYED IN app.js
//
//   - `state.justSent = state.justSent || new Map()`, beside the state literal it hangs off, with
//     its own comment: a load-time statement cannot move to a file that loads first.
//   - the two delegated listeners the editor owns (keydown on .ghost-edit-box, input on
//     .ghost-edit-box). They are load-time wiring, so they stay in app.js with the page's other
//     listeners, exactly as the deliverables button's own wiring does; they call these functions by
//     bare name at event time.
//
// RE-MEASURED FROM 3bb43694. The report's card names 3,644-3,745, 4,179-4,945 and 5,473-5,639. On
// this base those are 3,445-3,513 (through captureTyping), 3,979-4,549 and 4,597-4,758 (the queue,
// split around the two listeners that stay) and 5,274-5,440 (send and steer). The second and third
// rows of the report had drifted apart by the block that moved between them.

// ---- the draft a send consumed, cleared in ONE place ------------------------------------------------
// A sent reply must leave nothing a repaint can hand back, and the draft lives in three stores:
// state.replyDrafts (the map the box's input listener writes), the paste-chip mirror this tab keeps for a draft
// that ever carried a chip (state.boxModels + sessionStorage, public/board/paste-chips.js), and the box's own
// DOM. They used to be cleared by separate statements keyed on whatever thread name the send path happened to
// hold, and the mirror was reachable only THROUGH a box node the send could still see. So a send whose card was
// rebuilt, moved or folded away for the length of the POST left the mirror behind, and the landing repaint - the
// moment the box IS rebuilt - took the sent words, chip and all, back out of it and drew them under the answer.
// A preset send (the queue's drain, Retry turn, Continue) had the hole the other way round: it was allowed to
// clear only an EMPTY box, yet it wiped the draft map regardless, so the reader's next plain draft died on the
// following repaint while a chipped one survived on the mirror alone.
//
// `thread` is the name the send path holds; the BOX's own binding (box.dataset.reply) wins over it, because the
// panel can rename a thread while a turn settles and the draft belongs to the box, not to the name. `sent` is the
// text that went out. A box holding something ELSE is the reader's newer draft: it is left exactly as it is, map
// and mirror included, and only the just-sent record is written.
function clearSentDraft(thread, sent, box = null) {
  const bound = String((box && box.dataset && box.dataset.reply) || thread || "");
  if (!bound) return false;
  const text = String(sent == null ? "" : sent).trim();
  // The response's repaint may restore a typing snapshot taken while the POST was open: this is the record
  // that tells restoreTyping (and a pending steer's seed) that the snapshot is the text that has just gone out.
  state.justSent.set(bound, { text, at: Date.now() });
  const boxes = [...document.querySelectorAll(`.reply-box[data-reply="${CSS.escape(bound)}"]`)];
  if (box && box.nodeType === 1 && !boxes.includes(box)) boxes.push(box);
  // Anything the reader has typed SINCE the press is not ours to clear.
  if (boxes.some((el) => {
    const held = readBox(el).trim();
    return held && held !== text;
  })) {
    return false;
  }
  state.replyDrafts[bound] = "";
  state.replyNav.delete(bound);
  // The mirror is keyed on the thread, never on a node: it is cleared whether or not a box is still on the page.
  forgetReplyDraft(bound);
  for (const el of boxes) writeBox(el, "");
  return true;
}

// Typing state inside a card, so a rebuild can put it back. Row events arrive every few seconds for a
// fast-polling row, and the detail row is rebuilt on each one — without this, a half-typed reply was
// thrown away mid-sentence and the cursor went with it.
function captureTyping(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el)) return null;
  // The clarify card's answer box is the one field a reader types a whole sentence into while the board is live, and
  // it is a plain textarea the card rebuilds from its draft map - so the draft survived a repaint and the CARET did
  // not: the box came back full and unfocused, mid-sentence. Captured here, put back in restoreTyping().
  if (el.classList?.contains("tq-other")) {
    return {
      qbox: el.dataset.qother || "",
      qcopy: el.dataset.qcopy || "",
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
    };
  }
  // The held reply's editor is a textarea inside the card, so a repaint takes it away the same way it takes the reply
  // box — and the reader can be mid-edit exactly when a turn ends. Captured here, put back in restoreTyping().
  if (el.classList?.contains("ghost-edit-box")) {
    return { edit: el.dataset.editThread, editAt: Number(el.dataset.editQueued) || 0, value: el.value, start: el.selectionStart, end: el.selectionEnd };
  }
  if (!el.classList?.contains("reply-box")) return null;
  // The caret is captured in the units readBox measures in, so a chip in the draft cannot move it: the
  // value is the serialized text, which is exactly what the send path posts.
  const at = caretOffset(el);
  return { thread: el.dataset.reply, value: readBox(el), start: at, end: at };
}

// Everything the reader said on ONE session, oldest first. Up steps back from the end of this array.
function turnPrompts(thread) {
  if (!thread) return [];
  const entries = [];
  for (const j of state.jobs.values()) {
    // Strictly this composer's session, by its thread and nothing else. `(j.thread || j.id)` recalled a record that
    // carries no thread through its own id, which is another session's box as soon as the two strings meet.
    if (j.thread !== thread || j.origin) continue;
    // A prompt that carried attachments holds the panel's file block at the end; recalling it must not
    // re-attach anything, so the block comes off and the words are what moves through the box.
    const text = String(j.prompt || "").replace(/(?:\n\n?Attachment: [^\n]*before answering\.)+$/g, "").trim();
    if (!text || PANEL_PROMPT.test(text)) continue;
    // A missing turn number is NOT a zero. Zero sorted the record in front of the session's whole history, which is
    // the out-of-order entry this fixes; the stamp places it, and the number only breaks a tie on one millisecond.
    const turn = Number(j.turn);
    entries.push({ text, at: promptClock(j), turn: Number.isFinite(turn) && turn > 0 ? turn : null, order: entries.length });
  }
  // A turn record the store wrote before it kept a stamp has nothing to sort on. Its number says which prompt it
  // came AFTER, so it borrows that prompt's clock; a record with neither goes after the timed ones, in arrival order.
  const newestTimed = entries.reduce((max, e) => (e.at != null && e.at > max ? e.at : max), 0);
  for (const e of entries) {
    if (e.at != null) continue;
    const earlier = entries.filter((o) => o.at != null && o.turn != null && e.turn != null && o.turn < e.turn);
    const later = entries.filter((o) => o.at != null && o.turn != null && e.turn != null && o.turn > e.turn);
    if (earlier.length) e.at = Math.max(...earlier.map((o) => o.at)) + 1;
    else if (later.length) e.at = Math.min(...later.map((o) => o.at)) - 1;
    else e.at = newestTimed + 1 + e.order;
  }
  // Then what this browser sent, on the same clock: the only record of a steer, and of a reply whose turn this
  // panel has not been told about yet. Appending this list AFTER the turns made every typed entry claim to be newer
  // than every turn, so a session whose newest entry was typed in the box could read a stale turn prompt instead.
  const sent = replyHistoryEntries(replyHistoryStore()[thread]).filter((e) => !PANEL_PROMPT.test(e.text));
  const tailClock = entries.reduce((max, e) => (e.at != null && e.at > max ? e.at : max), 0);
  sent.forEach((e, i) => {
    // An entry with no clock of its own keeps its place at the end of the walk, in the order the store kept it: the
    // reader's own words are the newest thing this build can name for it, which is where the append had them.
    entries.push({ text: e.text, at: e.at != null ? e.at : tailClock + 1 + i, turn: null, order: entries.length });
  });
  entries.sort((a, b) => a.at - b.at || (a.turn ?? Infinity) - (b.turn ?? Infinity) || a.order - b.order);
  // One entry per text, at its NEWEST place: the turn echo of what the reader typed is the same entry as the typed
  // one rather than a second step, and a repeated prompt is one step where the reader last said it.
  const seen = new Set();
  const out = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const text = entries[i].text;
    if (seen.has(text)) continue;
    seen.add(text);
    out.unshift(text);
  }
  return out;
}

// A reply typed while the agent is still working: hold it and start it the moment that turn ends, so
// Hermes never sees a second session on the same thread at once (which it answers with "busy").
//
// The hold is written to the PANEL as well as to this page (POST /api/held-replies, action add) BEFORE any turn is
// accepted: this Map is one tab's memory, and a panel bounce, a reloaded tab or a dead node process used to drop the
// words and leave the attachments it named as files nothing pointed at. The record's id rides on the entry
// (`heldId`), so the drain can ask the panel to start THAT record and a replay by the panel cannot start it twice
// (the record's claim is the one thing only one caller can win). A POST that failed leaves the entry with no id, and
// the drain then sends it exactly as this page always did - a panel that cannot store a hold must not also lose it.
function queueReply(thread, text, attachments = []) {
  const q = state.replyQueue.get(thread) || [];
  // `at` is this entry's identity — the × and the drain both key on it — so two replies held in the same
  // millisecond still get one each: the stamp is nudged until it is unique within this thread's queue.
  let at = Date.now();
  while (q.some((entry) => entry && entry.at === at)) at += 1;
  // The files travel WITH the entry. They leave the composer's staged set in the same breath: a chip that
  // stayed there would attach the same file to the next message as well, and a send would carry it twice.
  const files = (Array.isArray(attachments) ? attachments : []).filter((a) => a && a.path);
  const entry = { text, at, attachments: files };
  q.push(entry);
  state.replyQueue.set(thread, q);
  postHeldReply(thread, entry);
  if (files.length) {
    const held = new Set(files.map((a) => a.path));
    setAttachments(thread, attachmentsFor(thread).filter((a) => !held.has(a.path)));
    renderChips(thread);
  }
  renderConversation(thread);
}

// The write-through that makes a held reply outlive this tab. Resolves to the panel's record (with its id) or null.
// Kept on the entry so the drain can await it instead of guessing: `entry.held`.
function postHeldReply(thread, entry, { action = "add" } = {}) {
  const body =
    action === "add"
      ? { action, thread, text: entry.text, attachments: entry.attachments || [], at: entry.at }
      : { action, id: entry.heldId, text: entry.text };
  entry.held = apiFetch("/api/held-replies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok || !d.reply) return null;
      entry.heldId = d.reply.id;
      return d.reply;
    })
    .catch(() => null);
  return entry.held;
}

// A hold the reader took back, or saved empty: the record is cancelled on the panel too, or the panel's own replay
// would start a message the reader had already withdrawn. Best effort - the page's answer is the removal it already
// made, and a cancel that arrives too late is answered `sending`/`sent`, which the next reconcile shows.
function cancelHeldReply(entry) {
  if (!entry || !entry.heldId) return Promise.resolve(null);
  const id = entry.heldId;
  return apiFetch("/api/held-replies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "cancel", id }),
  }).catch(() => null);
}

// The Retry on a PARKED record (the panel could not start its turn and will not ask again). Only the panel may
// revive it - it owns the state - so this asks, then lets the drain try once more. The record's words never left
// the store, which is why a retry is possible at all.
async function retryHeldReply(entry, thread) {
  if (!entry || !entry.heldId) return false;
  const warn = thread ? document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`) : null;
  try {
    const r = await apiFetch("/api/held-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", id: entry.heldId }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      if (warn) warn.textContent = `still parked — ${d.error || `HTTP ${r.status}`}`;
      return false;
    }
    entry.state = undefined;
    entry.why = undefined;
    renderConversation(thread);
    paintQueueWait(thread);
    void drainReplyQueue(thread);
    return true;
  } catch (err) {
    if (warn) warn.textContent = `still parked — the panel could not be asked (${err.message})`;
    return false;
  }
}


// The panel's own copy of what this tab holds, read ONCE when the page has a job snapshot (so it does not race the
// page's first paint): every record still owed a turn goes back into its thread's queue, with its text and its
// attachments, and a settled one is dropped. That is the whole point of the store - the tab that queued the message
// may not be the tab, or the process, that is running when it comes due.
let heldRepliesLoaded = false;
async function loadHeldReplies() {
  if (heldRepliesLoaded) return;
  heldRepliesLoaded = true;
  try {
    const r = await apiFetch("/api/held-replies");
    if (!r.ok) return;
    const d = await r.json();
    applyHeldReplies(d.replies);
  } catch {
    // A panel that cannot answer leaves the page's own queue exactly as it is: the held entries it already has are
    // still sendable, and the next snapshot tries again.
    heldRepliesLoaded = false;
  }
}

// Ask the panel to start the turn for one held record. The panel is the one acceptor: it rebuilds the words and the
// files from the record it stored before the turn existed, so nothing here can disagree with the copy a restart
// replays. Answers `{ok:true, body}` with the panel's own `{job}` answer, or `{ok:false, gone, why}` where `gone`
// means the record was already settled (sent or cancelled) and the page's copy is a duplicate.
async function acceptHeldReply(heldId, thread = "") {
  try {
    const r = await apiFetch("/api/held-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", id: heldId }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok && d.job) return { ok: true, body: d };
    const why = String(d.error || `HTTP ${r.status}`);
    const warn = thread ? document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`) : null;
    if (warn) {
      warn.textContent = d.gone
        ? "that queued reply was already sent, so it is off the queue"
        : d.parked
          ? "that queued reply is parked — it could not be sent, so use Retry on its card"
          : `still held — ${why}`;
    }
    return { ok: false, gone: Boolean(d.gone), why };
  } catch (err) {
    const warn = thread ? document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`) : null;
    if (warn) warn.textContent = `still held — the panel could not be asked (${err.message})`;
    return { ok: false, gone: false, why: err.message };
  }
}

// One record's state from the panel, reconciled into this page's queue: an entry the panel has SETTLED comes off
// (its turn exists, or the reader took it back), and a record the page does not hold is put back where it belongs.
// This is what a reloaded tab and a panel that replayed a hold both need, and it is also how the SSE `held-replies`
// event keeps a card from promising a queue that has already gone out.
function applyHeldReplies(list) {
  const records = Array.isArray(list) ? list : [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const threads = new Set();
  // ONE PRESS IS ONE ENTRY, even though a press writes to the panel twice before it is done: the entry goes into this
  // Map at once, and the panel's own record of it comes back - in the POST's answer, and in the `held-replies`
  // broadcast the drain sends - before that answer has had a chance to stamp `heldId` on the entry. So for a moment
  // the page holds an entry with no id, and a record it cannot find by id read as a record the page did NOT hold:
  // `queueReply` pushed one chip and this function pushed its twin, which is the reader's "2 queued" for one Enter.
  // The entry's own `at` is the identity the queue already works in, the panel stores and echoes it with the record,
  // and the text rides with it so a same-millisecond press in another tab cannot claim this entry's record. A record
  // that matches an entry this way is THAT entry: its id is adopted and nothing is added.
  const sameEntry = (entry, rec) =>
    entry.heldId
      ? String(entry.heldId) === String(rec.id)
      : entry.at != null &&
        String(entry.at) === String(rec.at) &&
        String(entry.text ?? "") === String(rec.text ?? "");
  const entryFor = (thread, rec) => (state.replyQueue.get(thread) || []).find((e) => e && sameEntry(e, rec)) || null;
  // A record the panel settled: the page's copy of it is a duplicate.
  for (const [thread, q] of [...state.replyQueue]) {
    const keep = [];
    for (const entry of q) {
      if (!entry) continue;
      const rec = entry.heldId ? byId.get(entry.heldId) : null;
      if (rec && (rec.state === "sent" || rec.state === "cancelled")) {
        threads.add(thread);
        continue;
      }
      // Parked: the panel could not start it and will not ask again. The entry STAYS on the card, with the reason
      // and a Retry, because the words are still the reader's and still stored.
      if (rec && rec.state === "parked") {
        entry.state = "parked";
        entry.why = rec.why || "";
        threads.add(thread);
      } else if (rec && rec.state === "held" && entry.state) {
        // A retry (here or in another tab) took it back off the parked shelf.
        entry.state = undefined;
        entry.why = undefined;
        threads.add(thread);
      }
      keep.push(entry);
    }
    if (keep.length !== q.length) {
      if (keep.length) state.replyQueue.set(thread, keep);
      else state.replyQueue.delete(thread);
      threads.add(thread);
    }
  }
  // A record the page does not hold: the panel kept it while this tab was gone (or restarted under it). It goes in by
  // its `seq` order, after whatever this page already holds for that thread and before anything held later.
  const known = new Set();
  for (const q of state.replyQueue.values()) for (const e of q) if (e?.heldId) known.add(e.heldId);
  for (const rec of records) {
    if (!rec || known.has(rec.id)) continue;
    if (rec.state !== "held" && rec.state !== "sending" && rec.state !== "parked") continue;
    if (!rec.thread || !String(rec.text || "").trim()) continue;
    const mine = entryFor(rec.thread, rec);
    if (mine) {
      // This page's own press, seen again before its answer stamped the id: the entry IS the record, so it takes the
      // panel's id (which the × and the drain both need) and the card is not given a second chip for one press.
      mine.heldId = rec.id;
      known.add(rec.id);
      continue;
    }
    const q = state.replyQueue.get(rec.thread) || [];
    q.push({
      text: rec.text,
      at: Number(rec.at) || Date.now(),
      attachments: rec.attachments || [],
      heldId: rec.id,
      ...(rec.state === "parked" ? { state: "parked", why: rec.why || "" } : {}),
    });
    q.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    state.replyQueue.set(rec.thread, q);
    threads.add(rec.thread);
  }
  for (const thread of threads) {
    renderConversation(thread);
    // The count beside Queue reply is drawn from the queue's SENDABLE entries, so a record that just became parked
    // (or was revived) has to repaint that note too - renderConversation does not touch the composer's line.
    paintQueueWait(thread);
    void drainReplyQueue(thread);
  }
}

// One press of Queue reply, from the button or from Enter: hold what the box holds and send it when the thread
// is free, instead of steering the turn that is running now. The draft is cleared BEFORE queueReply, which
// rebuilds the card - the rebuild would otherwise put the text back into the new box from the saved draft.
// The staged files are read before either happens: they are the held reply's now, not the composer's.
//
// ONE PRESS IS ONE ENTRY, AND ONLY THE PRESS'S OWN FLIGHT CLOSES THE CARD. The press claims the thread for the
// length of its own work - the commit of the entry plus the task the browser takes to draw it - and closes the
// card for exactly that window: the Queue reply button off, the box read-only, "queued, waiting" in place of its
// sentence. When it settles, success or failure, the face comes off and the box is back, EMPTY, so the next
// message can be typed and held as its own entry. A press that arrives inside the window is the same press: it is
// refused rather than racing the first for the same box, which is what keeps a double press from holding twice.
// The guard is asked HERE rather than in the click handler because Enter comes through this same function.
async function queueReplyFromBox(thread) {
  if (queuePressInFlight(thread)) {
    // Already in flight: this press is the same press. Put a node that missed the repaint back in step, and hold
    // nothing a second time.
    paintQueueWait(thread);
    return false;
  }
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  // readBox, not box.value: what is held is what the agent would receive, a chip being the text it holds.
  const text = readBox(box).trim();
  if (!text) {
    if (box) box.focus();
    return false;
  }
  const files = attachmentsFor(thread);
  // The flight is claimed BEFORE the box is touched, so a press that lands while this one is still committing is
  // refused by the guard above rather than reading a half-cleared box.
  state.replyPress.set(thread, true);
  paintQueueWait(thread);
  try {
    // The press's own text went out as a held reply: one clear covers the map, the mirror and the box - keyed on
    // the thread the BOX is bound to - before queueReply rebuilds the card.
    clearSentDraft(String((box && box.dataset.reply) || thread || ""), text, box);
    queueReply(thread, text, files);
    // queueReply rebuilt the card, and the rebuild draws the closed face from this same predicate. The wait is
    // what makes the window real: a second press from a double click, a held key or a stale node lands inside it
    // and is refused instead of holding the same text again.
    await pressSettled();
    return true;
  } finally {
    state.replyPress.delete(thread);
    // Whatever happened - held, refused, or a commit that threw - the reader gets the box back, cleared, with the
    // replies that are still held counted beside it.
    paintQueueWait(thread);
  }
}

// Is a press of Queue reply still IN FLIGHT on this thread? The one question the press, the box's keys and the
// card's closed face ask, so none of them can disagree about the window. A HELD reply is not this: the queue may
// hold several separate messages, and the box stays open for the next one.
function queuePressInFlight(thread) {
  return Boolean(thread && state.replyPress.get(thread));
}

// Does this thread hold a reply that has not gone out yet? The count the card shows and the drain walks. A PARKED
// entry is not waiting to go: the panel will not send it, so it must not be counted as queued (it has its own card
// with Retry/×). It closes nothing either way.
function queueWaitingOn(thread) {
  return replyQueued(thread).some((e) => e && e.state !== "parked");
}

// The sentence a closed box carries while a press is in flight, in one place: the renderer writes it on the box
// and the painter puts it back when the flight ends.
function queueWaitPhrase() {
  return "queued, waiting - your reply goes out when this turn finishes";
}

// One task: long enough for the closed face to be drawn before it comes off, short enough that the reader never
// sees a delay.
function pressSettled() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// The face of a press that is still IN FLIGHT, applied to the live DOM: the Queue reply button off, the box
// read-only and the note saying "queued, waiting". A press applies it when it claims the thread and takes it off
// when it settles; the card's render draws the same face from queuePressInFlight, so a repaint cannot reopen a box
// mid-press. Once the press has settled the box is OPEN - a reply being held is no reason to refuse the next
// message - and the note counts what is held instead.
function paintQueueWait(thread) {
  const inFlight = queuePressInFlight(thread);
  const held = replyQueued(thread).filter((e) => e && e.state !== "parked").length;
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  const btn = card?.querySelector("[data-queue-reply]");
  if (btn) {
    btn.disabled = inFlight;
    if (inFlight) btn.setAttribute("aria-disabled", "true");
    else btn.removeAttribute("aria-disabled");
  }
  if (box) {
    box.setAttribute("contenteditable", inFlight ? "false" : "true");
    if (inFlight) box.setAttribute("aria-readonly", "true");
    else box.removeAttribute("aria-readonly");
    box.classList.toggle("queued-waiting", inFlight);
    // The placeholder is the renderer's, kept beside the live one on data-ph-idle: the closed face borrows the box
    // for one task, it does not own the sentence the box goes back to.
    if (box.dataset && box.dataset.phIdle != null) box.dataset.ph = inFlight ? queueWaitPhrase() : box.dataset.phIdle;
  }
  const note = card?.querySelector("[data-queue-wait]");
  if (note) {
    note.hidden = !inFlight && !held;
    note.textContent = inFlight ? "queued, waiting" : held ? `${held} queued` : "";
  }
  return inFlight;
}

// Is the Queue reply button offered for this card right now? It is drawn for two reasons - a turn is running, or
// a finished turn whose subagents are still out - and Enter means the same thing as that button. Asking the page
// where the card drew it is what keeps the gesture and the button from ever disagreeing about whether there is
// anything to hold: no button, nothing to wait for, so Enter sends.
function queueOfferedFor(box) {
  return Boolean(box && box.closest(".reply")?.querySelector("[data-queue-reply]"));
}

// Is the Steer turn button offered for this card right now? It is drawn while a turn is live on the thread, and
// Ctrl/Cmd+Enter means the same thing as that button - the same question asked of the same markup.
function steerOfferedFor(box) {
  return Boolean(box && box.closest(".reply")?.querySelector("[data-steer]"));
}

// One press of Steer turn, from the button or from Ctrl/Cmd+Enter: send what the box holds into the turn that is
// running now. The button carries the id of the turn it was drawn for; from the keyboard the live turn on this
// thread is looked up instead, which is the same turn the card drew its button for. `pressed` is the element the
// press came from - the button, or the box from a keystroke - and it is what steerTurn greys for the round trip.
function steerFromBox(thread, turnId = null, pressed = null) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  // From the keyboard the turn is found through the SAME predicate the card drew its button from, never through any
  // live turn on the thread: Ctrl+Enter is offered only while that button is, so it must name the same turn.
  const id =
    turnId ||
    [...state.jobs.values()].find((j) => (j.thread || j.id) === thread && turnLive(j) && j.steerable?.ok)?.id;
  if (!id) return Promise.resolve(false);
  return steerTurn(thread, id, readBox(box), pressed);
}

function replyQueued(thread) {
  return state.replyQueue.get(thread) || [];
}

// The held reply the reader has open in its own editor, if any. One editor at a time, and it names the entry by the
// entry's own `at` — which is the identity everything here works in: a save writes back to that one entry, and an
// edit never becomes a new queue entry with a new timestamp.
function queuedEditFor(thread) {
  const edit = state.replyEdit;
  if (!edit) return null;
  return thread && edit.thread !== thread ? null : edit;
}

// One held reply on the card: the badge, the age it has been waiting and the line saying when it goes out. Its text
// is a ghost line — or, when this is the entry the reader has open, a textarea in that line's place, seeded with the
// entry's text and nothing else about the card moved. The age is the entry's own `at` either way, so an edit does not
// restart the clock: editing is not re-queueing.
function ghostTurnHtml(thread, q, edit, freeToSend) {
  // The head is the same for a held reply and for the one being edited — the badge, the age counting from the entry's
  // own `at`, the line saying when it goes out, and the × that takes this ONE entry back (usable while it is being
  // edited: the removal closes the editor with it).
  const head = (when, editing) =>
    `<div class="ghost-turn${editing ? " editing" : ""}"><div class="ghost-head mono"><span class="ghost-badge">queued</span><span class="queue-ago" data-queued-at="${q.at}">${fmtDur(Date.now() - q.at)}</span><span class="dimmer">${when}</span><button class="ghost-cancel" type="button" data-queue-cancel="${esc(thread)}" data-queue-cancel-at="${q.at}" title="cancel this queued reply — it will not be sent, and if the reply box is empty its text comes back as your draft" aria-label="cancel this queued reply for ${esc(thread)}">✕</button></div>`;
  // The entry's own files, under its text: the same chip the composer drew, opening the same path. They are
  // drawn from the ENTRY, never from the composer, so a file staged later cannot appear in this bubble.
  const chips = q.attachments?.length
    ? `<div class="ghost-chips">${attachmentChipsFor(q.attachments)}</div>`
    : "";
  // A PARKED entry: the panel could not start it and will not ask again. It keeps its place, its words and its age,
  // and offers the two honest actions - Retry (the panel revives the record) or the × (cancel it).
  if (q.state === "parked") {
    const why = q.why || "the panel could not start a turn for it";
    return `<div class="ghost-turn parked"><div class="ghost-head mono"><span class="ghost-badge parked">not sent</span><span class="queue-ago" data-queued-at="${q.at}">${fmtDur(Date.now() - q.at)}</span><span class="dimmer" title="${esc(why)}">parked — ${esc(why)}</span><button class="ghost-retry" type="button" data-queue-retry="${esc(thread)}" data-queue-retry-id="${esc(q.heldId || "")}" data-queue-retry-at="${q.at}" title="try this held reply once more">Retry</button><button class="ghost-cancel" type="button" data-queue-cancel="${esc(thread)}" data-queue-cancel-at="${q.at}" title="cancel this held reply — it will not be sent" aria-label="cancel this held reply for ${esc(thread)}">✕</button></div><div class="ghost-prompt">${linkifyText(q.text)}</div>${chips}</div>`;
  }
  if (!edit || edit.at !== q.at) {
    return `${head("sends when the current turn finishes", false)}<div class="ghost-prompt" data-edit-queued-open="${q.at}" data-edit-thread="${esc(thread)}" role="button" tabindex="0" title="click to edit this held reply">${linkifyText(q.text)}</div>${chips}</div>`;
  }
  // An editor is open on this entry, so the line above it cannot keep promising a send: while the reader is in the
  // box this reply is held, and the card says which hold it is — still waiting for the turn and its subagents, or free
  // to go the moment it is saved.
  const when = freeToSend
    ? "the turn has finished — this held reply waits for your edit; save and it goes"
    : "editing — it is not sent while you edit it; save sends it, Escape leaves it as it was";
  return `${head(when, true)}<div class="ghost-edit" data-edit-for="${q.at}"><textarea class="ghost-edit-box mono" data-edit-queued="${q.at}" data-edit-thread="${esc(thread)}" rows="2" spellcheck="false" aria-label="edit this held reply">${esc(edit.text)}</textarea><div class="ghost-edit-actions mono"><button class="btn-edit-save" type="button" data-edit-save="${q.at}" data-edit-thread="${esc(thread)}" title="save this edit — the held reply becomes this text (Enter)">Save</button><button class="btn-edit-cancel" type="button" data-edit-cancel="${q.at}" data-edit-thread="${esc(thread)}" title="leave this held reply exactly as it was (Escape)">Cancel</button></div></div>${chips}</div>`;
}

// Open the editor on one held reply, named by its own `at`. The text it opens on is remembered, so Escape, Cancel and
// a click away all put that entry back exactly as it was: nothing the reader did not save can reach the queue. One
// editor at a time — opening another leaves the first as it was.
function openQueuedEdit(thread, at) {
  const entry = replyQueued(thread).find((e) => e && e.at === at);
  if (!entry) return false;
  const already = queuedEditFor(null);
  if (already && (already.thread !== thread || already.at !== at)) cancelQueuedEdit(already.thread, already.at);
  state.replyEdit = { thread, at, original: entry.text, text: entry.text };
  renderConversation(thread);
  const box = document.querySelector(`.ghost-edit-box[data-edit-queued="${at}"][data-edit-thread="${CSS.escape(thread)}"]`);
  if (box) {
    box.focus({ preventScroll: true });
    growReplyBox(box);
    // The caret goes to the end: the reader clicked a held line to add to it, not to retype it.
    try {
      box.setSelectionRange(box.value.length, box.value.length);
    } catch {
      /* not a text field any more: nothing to place */
    }
  }
  return true;
}

// Save the edit to the ONE entry it belongs to, found by its `at`: not a new queue entry, and not the thread's whole
// queue. The entry keeps its place and its `at`, so its age carries on from when it was first held. Enter or the Save
// button is the only thing that commits an edit — nothing here sends.
function saveQueuedEdit(thread, at) {
  const edit = queuedEditFor(thread);
  if (!edit || edit.at !== at) return false;
  const box = document.querySelector(`.ghost-edit-box[data-edit-queued="${at}"][data-edit-thread="${CSS.escape(thread)}"]`);
  const text = String(box ? box.value : edit.text).trim();
  state.replyEdit = null;
  const q = replyQueued(thread);
  const i = q.findIndex((e) => e && e.at === at);
  if (i < 0) {
    // The entry left the queue while the editor was open (the × stays usable mid-edit): there is nothing to write to.
    renderConversation(thread);
    return false;
  }
  if (!text) {
    // An empty box is the reader saying the same thing the × says: that entry goes. Taken out by the same removal, so
    // the queue has one way out rather than two — and nothing is sent.
    const gone = takeQueuedReply(thread, at);
    // The panel's copy goes with it: a hold left `held` there would be started by the panel's own replay, which is
    // exactly the message the reader just withdrew.
    cancelHeldReply(gone);
    renderConversation(thread);
    const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
    if (warn) warn.textContent = "that held reply was saved empty — it is gone, and nothing was sent";
    void drainReplyQueue(thread);
    return true;
  }
  q[i] = { ...q[i], text };
  state.replyQueue.set(thread, q);
  // The panel's record carries the words it will start a turn with, so an edit that stays only in this tab would be
  // undone by a restart: the new text goes to the record too, and a record already claimed answers "sending", which
  // the card would show anyway.
  if (q[i].heldId) postHeldReply(thread, q[i], { action: "edit" });
  renderConversation(thread);
  // Sendable again the moment the edit is saved: if the turn and its subagents are already done, the drain sends it
  // now; if they are not, it stays held exactly as it was and goes when they finish.
  void drainReplyQueue(thread);
  return true;
}

// Leave the edit: the entry goes back to the text it had when the editor opened, and nothing else on the card moves.
// This is what Escape and Cancel do, and what clicking away does.
function cancelQueuedEdit(thread, at) {
  const edit = queuedEditFor(thread);
  if (!edit || (at && edit.at !== at)) return false;
  state.replyEdit = null;
  renderConversation(thread);
  return true;
}

// Take ONE held reply out of the queue, by its own identity: the removal an empty save makes and the removal the
// entry's × makes — one path, so "it goes" means the same thing however it was asked for. No other held reply on the
// thread is touched, and nothing is sent.
function takeQueuedReply(thread, at) {
  const q = replyQueued(thread);
  const i = q.findIndex((e) => e && e.at === at);
  if (i < 0) return null;
  const [entry] = q.splice(i, 1);
  if (!q.length) state.replyQueue.delete(thread);
  else state.replyQueue.set(thread, q);
  // An editor open on the entry that just left has nothing left to edit.
  const edit = queuedEditFor(thread);
  if (edit && edit.at === at) state.replyEdit = null;
  return entry;
}

// Clicking anywhere outside the open editor means the same one thing every time: REVERT — exactly what Escape means.
// An edit is therefore only ever committed by Enter or Save, an accidental click can never write text the reader had
// not finished, and no click can send anything. The editor's own box and buttons are not "away".
function revertEditOnClickAway(target) {
  const edit = state.replyEdit;
  if (!edit) return false;
  if (target && target.closest && target.closest(`.ghost-edit[data-edit-for="${edit.at}"]`)) return false;
  return cancelQueuedEdit(edit.thread, edit.at);
}

// Why a held reply must NOT be sent right now, asked in ONE place so the two reasons can never disagree about the
// same entry:
//   "cancelled" — the reader took that entry back: it is out of the queue (the × takes it out; a flagged entry is the
//                 same answer), so it is never sent and the queue moves on without it
//   "editing"   — the reader has that entry open in its editor: it stays exactly where it is, holding everything
//                 behind it, and becomes sendable again when the edit is saved
// The × and the editor only ever change the state this reads, and the drain has no second opinion of its own. Asked
// about a held entry, the two answers it can give are "the reader is editing this" and ""; "cancelled" is what an entry
// the drain captured but the queue no longer carries looks like, so a × that removes its entry (or one that flags it)
// is answered here rather than by a check of the drain's own.
function heldReplyBlocked(thread, entry) {
  if (!entry) return "";
  if (entry.cancelled) return "cancelled";
  if (!replyQueued(thread).some((e) => e && e.at === entry.at)) return "cancelled";
  const edit = queuedEditFor(thread);
  return edit && edit.at === entry.at ? "editing" : "";
}

// The entries the drain has taken out of a thread's queue to send, newest last, so a × pressed after the send
// can tell "already sent" apart from "never held". Bounded: it is a record of the last few press answers, not a
// history of the thread.
function markReplySent(thread, entry) {
  const sent = state.replySent.get(thread) || [];
  sent.push({ at: entry.at, text: entry.text });
  state.replySent.set(thread, sent.slice(-8));
}

function replyTakenByDrain(thread, at) {
  return (state.replySent.get(thread) || []).some((entry) => entry.at === at);
}

// The × on a queued entry. It is keyed on the ENTRY's own identity — its `at` — never on the thread, so two
// held replies stay independent: cancelling the first leaves the second scheduled and still sending. An
// accidental × gives the text back as the draft when that thread's reply box is EMPTY, and leaves a box that
// already holds something alone (the reader's own words there are not ours to overwrite).
function cancelQueuedReply(thread, at) {
  // The removal is takeQueuedReply — the same one an empty save makes, so there is ONE way out of this queue and not
  // two. It keys on the entry's own `at`, and it closes an editor left open on the entry it takes, which is what keeps
  // the × working while the reader is editing one.
  const entry = takeQueuedReply(thread, at);
  if (!entry) {
    // The race, and the only two honest answers: the drain has already taken this entry out and its send is on
    // its way (the press cannot call it back, so say so), or it is simply not held here any more.
    const sent = replyTakenByDrain(thread, at);
    renderConversation(thread);
    const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
    if (warn) warn.textContent = sent ? "that one was already sent" : "that queued reply is no longer held";
    return sent ? "sent" : "gone";
  }
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  // The box's own text, read the one way a prompt box is read now (a chip is the text it swallowed): the
  // answer decides whether the cancelled reply can come back as a draft.
  const backToDraft = Boolean(box && !readBox(box).trim() && entry.text);
  // The panel's record is cancelled first thing, before anything on the card moves: a hold the panel still thinks is
  // owed a turn would be started by its own replay.
  cancelHeldReply(entry);
  if (backToDraft) state.replyDrafts[thread] = entry.text;
  // The entry's files come back to the composer the same way its text does — only into an empty box, so a file
  // staged since is never joined by one from a reply the reader took back.
  const back = backToDraft && entry.attachments?.length ? addAttachments(thread, entry.attachments) : 0;
  renderConversation(thread);
  // After the repaint: a rebuild replaces the card and the warnline with it, so the note goes in last.
  const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
  if (warn) {
    warn.textContent = backToDraft
      ? back
        ? `that queued reply is cancelled — the text and its ${back === 1 ? "file are" : `${back} files are`} back in the box`
        : "that queued reply is cancelled — the text is back in the box as your draft"
      : "that queued reply is cancelled";
  }
  return "cancelled";
}

// Children this thread started that are still working. A finished parent turn with children out is not "busy"
// in the run sense, but a reply sent then races them: the parent starts a new turn while its own children are
// still writing. So the queue waits for them too.
function childrenOut(thread) {
  if (!thread) return false;
  if ((subagentFallback.get(thread) || []).some((s) => s && s.running)) return true;
  return [...state.jobs.values()].some(
    (j) => (j.thread || j.id) === thread && (j.subagents || []).some((s) => s && s.running),
  );
}

function threadBusy(thread) {
  return [...state.jobs.values()].some((j) => (j.thread || j.id) === thread && turnLive(j));
}

async function drainReplyQueue(thread) {
  // The next entry is read here, then the queue is re-read at send time and that entry is looked up by its own
  // identity (`at`): the turn finishing and the reader working on a held reply can land in the same moment. ONE guard
  // answers for both of the reasons an entry must not be sent — the reader took it back with its ×, or the reader has
  // it open in its editor — so the queue has no second check that could disagree with either of them.
  // A PARKED entry cannot be sent - the panel will not start it - and it must not block the entries behind it: it
  // stays on the card with its reason and Retry/×, and the drain takes the first entry that can actually go.
  const next = replyQueued(thread).find((e) => e && !e.sending && e.state !== "parked");
  // `sending` is this page's own flight marker: a second drain call (one per job event) must not send the same entry
  // twice now that the entry stays in the queue until its turn exists.
  if (!next || threadBusy(thread) || childrenOut(thread)) return;
  const blocked = heldReplyBlocked(thread, next);
  if (blocked === "editing") {
    // Held, not sent: the entry keeps its place and its age, the card says why it is waiting, and saving the edit is
    // what makes it sendable again. Everything behind it waits with it, so the queue cannot re-order around it.
    renderConversation(thread);
    return;
  }
  if (blocked === "cancelled") {
    // Gone, not sent: an entry the reader took back leaves the queue, and the queue moves on to the one behind it.
    const rest = replyQueued(thread).filter((e) => e && !e.cancelled && e.at !== next.at);
    if (rest.length) state.replyQueue.set(thread, rest);
    else state.replyQueue.delete(thread);
    renderConversation(thread);
    return void drainReplyQueue(thread);
  }
  const q = state.replyQueue.get(thread) || [];
  const i = q.findIndex((entry) => entry && entry.at === next.at);
  if (i < 0) return;
  // The entry is NOT taken out here any more: a send can be refused (the panel still counts a live run in that tree,
  // the tree was released, the gateway declined the turn), and the old splice-then-send lost the reader's message on
  // every one of those. It leaves the queue when - and only when - a turn exists for it.
  const entry = q[i];
  entry.sending = true;
  renderConversation(thread);
  paintQueueWait(thread);
  let ok = false;
  try {
    // The entry's OWN files travel with the send (and, for a held record, the panel rebuilds the same block from the
    // copy it stored). The composer's staged set belongs to a later message and is neither read nor cleared here.
    ok = await sendReply(thread, entry.text, entry.attachments || [], { heldId: await heldIdFor(entry) });
  } catch {
    /* sendReply reports its own errors */
  } finally {
    entry.sending = false;
  }
  // Already settled on the panel (sent by its own replay, or taken back): the page's copy is a duplicate, not a
  // message owed a turn, so it comes off without a warning.
  if (ok === "gone") {
    takeQueuedReply(thread, entry.at);
    renderConversation(thread);
    paintQueueWait(thread);
    return;
  }
  if (!ok) return;
  // Accepted: the entry's turn exists, so the held copy goes - the one path out that follows a send.
  takeQueuedReply(thread, entry.at);
  markReplySent(thread, entry);
  renderConversation(thread);
  paintQueueWait(thread);
  // The next one behind it goes only when that turn ends, so this is one entry per pass, never a burst.
}

// The panel's id for one held entry, waiting for the write-through when it is still in flight. Null means the page's
// POST never landed: the drain then sends the words itself, exactly as it did before the panel kept a record.
async function heldIdFor(entry) {
  if (!entry) return null;
  if (entry.heldId) return entry.heldId;
  if (entry.held) {
    const rec = await entry.held.catch(() => null);
    return rec?.id || entry.heldId || null;
  }
  return null;
}

async function sendReply(thread, preset = null, presetAttachments = null, { heldId = null } = {}) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  // The thread the BOX is bound to, resolved once: the draft stores below are keyed on this, never on a name
  // the send path happens to hold a moment later.
  const bound = String((box && box.dataset.reply) || thread || "");
  // The one place a box's text is read. A chip serializes back to the text it swallowed, IN PLACE: quotes
  // the reader put around it and the prose on either side arrive in the order they are on screen.
  const typed = String(preset ?? (box ? readBox(box) : "")).trim();
  // A queued reply hands its OWN files in: the block is built from those, and the composer's staged set is a
  // later message's — never read, never cleared here. A box send passes null and the staged set is its own.
  const held = Array.isArray(presetAttachments);
  const files = held ? presetAttachments : attachmentsFor(thread);
  // A HELD reply is accepted by the panel from its own record (POST action send): the words and the files are the
  // copy it stored before any turn existed, so this page does not send them a second time - it only asks for that
  // record's turn. The panel's claim is what makes the page's press and the panel's own replay unable to start two.
  // `"gone"` is the one answer that takes the entry out of the queue without a turn: it was sent (or taken back)
  // already, so the page's copy is a duplicate of a settled fact. `false` means the record is still owed a turn.
  const acc = heldId ? await acceptHeldReply(heldId, thread) : null;
  if (heldId && !acc.ok) return acc.gone ? "gone" : false;
  const attached = heldId ? "" : attachmentBlockFor(files);
  if (!typed && !attached && !acc) return false;
  const text = typed + attached;
  // The typed part only: the attachment block is panel-added, and recalling it would duplicate the files.
  rememberReply(thread, typed);
  const btn = document.querySelector(`.btn-reply[data-thread="${CSS.escape(thread)}"]`);
  if (btn) btn.disabled = true;
  // The assistant's thread is answered through its own route: the server attaches the scratchpad and the
  // board digest to that turn, and a plain reply here would start a turn with neither.
  const toAssistant = assistantSessionFor(thread);
  try {
    const r = heldId
      ? { ok: true, json: async () => acc.body }
      : await apiFetch(toAssistant ? "/api/assistant/say" : "/api/agents/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toAssistant ? { text, assistantId: toAssistant.id } : { thread, text, attachments: files }),
        });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // ONE clear, once the post is ACCEPTED and BEFORE the response's repaint - the map, the paste-chip mirror
    // for the thread the box is bound to, and every box for it - so nothing between the two can put the words
    // back (the landing repaint is exactly when the box is rebuilt). A box holding something the reader typed
    // since is left alone, with its draft and its chips.
    clearSentDraft(bound, typed, box);
    if (!held) clearAttachments(bound);
    updateJob(d.job, { scroll: true });
    if (d.assistant && typeof applyAssistant === "function") applyAssistant(d.assistant);
    // Sending a reply is you switching to the new turn: fold everything before it, including turns
    // you had opened by hand, so the card shows one full chat — the one you are now in — instead of
    // that one plus the scrollback you were reading a moment ago. The assistant's card sits in a fixed
    // panel, so there is no page position to hold there.
    if (!toAssistant) focusNewTurn(thread, d.job.id);
    // Sending is one keystroke away from the follow-up: keep the caret in the box instead of dropping
    // it (the click on Send used to move focus to the button, and the rebuild replaces the textarea).
    focusReplyBox(thread);
    setTimeout(() => focusReplyBox(thread), 0);
    setTimeout(() => focusReplyBox(thread), 80);
    return true;
  } catch (err) {
    const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
    if (warn) warn.textContent = `reply failed: ${err.message}`;
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// `pressed` is the element the press came from - the [data-steer] button from a click, the box from Enter - and it
// is what the press's two controls are resolved from, so a steer waiting on the gateway is never a still frame.
async function steerTurn(thread, id, text, pressed = null) {
  const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
  const typed = String(text ?? "").trim();
  const attached = attachmentBlock(thread);
  if (!typed && !attached) {
    focusReplyBox(thread);
    if (warn) warn.textContent = "type what the agent should do instead";
    return false;
  }
  // The two controls this press owns: the Steer button and the box it sends. Read from the element that was pressed
  // and, on the way back, from the page as it stands THEN - a repaint can replace either node while the fetch is
  // open, so the node captured at the press would be the detached one. The box is contenteditable, where `disabled`
  // paints nothing: it takes a class (public/style.css, beside button:disabled), and the button its own property.
  const steerPaint = (on, from) => {
    const reply =
      from?.closest?.(".reply") ||
      document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`)?.closest(".reply") ||
      null;
    const btn = reply?.querySelector("[data-steer]");
    const box = reply?.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    if (btn) btn.disabled = on;
    if (box) box.classList.toggle("steer-pending", on);
  };
  const body = typed + attached;
  rememberReply(thread, typed);
  steerPaint(true, pressed);
  try {
    const res = await apiFetch("/api/jobs/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text: body, attachments: attachmentsFor(thread) }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      // One sentence per reason, because the three refusals want three different next actions (docs/steer-refusal.md
      // §2.2/§2.4). `out.reason` is classified by the route from the same predicate the card drew its button from;
      // a refusal it could not classify falls through to the plain sentence rather than guessing a case.
      const reason = String(out.reason || "").trim();
      const why = String(out.error || "").trim() || `HTTP ${res.status}`;
      // The route settled a run the gateway no longer has and carried the card back: repaint now, so the Steer control
      // and the card's "running" word go in the same round trip as the answer.
      if (out.card && typeof updateJob === "function") {
        try {
          updateJob(out.card);
        } catch {
          /* the job frame that follows repaints anyway */
        }
      }
      if (reason === "past_boundary") {
        // A GENUINE 409: the run exists and is already past its last tool boundary, so this text cannot land in it and
        // no later press will land either. Hold it as the reply the reader asked for — the same hold the Queue reply
        // press makes — and say it was held, so nobody is left thinking the instruction was lost. The staged files are
        // read BEFORE the box is cleared and held ON the entry: the drain sends those, not whatever is staged by then,
        // and the text stays the reader's words (the block would be a second copy of the paths).
        const files = attachmentsFor(thread);
        const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
        clearSentDraft(String((box && box.dataset.reply) || thread || ""), typed, box);
        queueReply(thread, typed, files);
        // After the repaint queueReply causes: it replaces the card, and the old warnline with it.
        const heldWarn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
        if (heldWarn) heldWarn.textContent = `steer held — ${why}; your text is queued and goes out as the next turn on this thread.`;
        steerPaint(false, null);
        return false;
      }
      const advice =
        reason === "parked"
          ? "Nothing was queued — answer the approval above and Steer works again."
          : reason === "gone"
            ? "Nothing was queued — the card is settled now, and Send reply starts a new turn."
            : "Nothing was queued; the text is still in the box.";
      // The repaint above replaced the warnline with the card, so the sentence goes on the node that is on the page
      // now — the one captured when this press started may already be detached.
      const liveWarn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`) || warn;
      if (liveWarn) liveWarn.textContent = `steer refused — ${why}. ${advice}`;
      steerPaint(false, null);
      return false;
    }
    // The text went into the LIVE turn, so clear the draft: leaving it would invite sending the same
    // instruction twice, once as a steer and once as the next turn. One clear, keyed on the box's own thread.
    const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    clearSentDraft(String((box && box.dataset.reply) || thread || ""), typed, box);
    clearAttachments(thread);
    if (warn) {
      // A steer only lands at a tool boundary, and `delegate_task` is one call that can run for minutes: say what
      // it is waiting for, and what happens if the wait outlasts the turn.
      const waitingOn = inflightToolName(jobLines(id));
      warn.textContent = waitingOn === "delegate_task"
        ? "steered — it waits for delegate_task to return; if the turn ends first it comes back to this box unsent"
        : "steered — the agent reads this at its next tool boundary";
    }
    focusReplyBox(thread);
    return true;
  } catch (err) {
    if (warn) warn.textContent = `steer failed: ${err.message}`;
    steerPaint(false, null);
    return false;
  }
}
