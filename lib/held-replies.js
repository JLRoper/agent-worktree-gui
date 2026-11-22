// ---- a reply the reader held behind a live turn -------------------------------------------------
//
// The page's reply queue (public/app.js `state.replyQueue`) is the reader's "queue reply" press: a message typed
// while the agent is still turning, held until that turn ends. It lived ONLY in the page's memory and only in the
// words the page sent: a panel restart, a tab reload, or the restart of the node process the page talks to dropped
// every held entry, and the attachments it named became files nothing pointed at any more. A refused send lost it
// too, because the drain took the entry out of the queue BEFORE the POST and kept nothing on failure.
//
// So the hold is a record on the panel's own disk, written BEFORE any turn is accepted, and the panel replays it.
// This module owns that record and nothing else: the schema, the caps, the ordering, the state transitions and the
// claim. It never touches the job store and never starts a turn -- server.js does both, through the one function
// that accepts a turn (`startThreadReply`), so a replayed hold and a reader's own press cannot take two different
// paths.
//
// The record is `{version, seq, replies: [entry]}` at state/held-replies.json, one file for the panel:
//
//   {id, seq, thread, text, attachments: [{path, name, type, bytes}], at, state, jobId, why, sentAt}
//
// `id` is the identity a replay is deduplicated BY: a turn this hold started carries it as `origin.heldId` on the
// job, and a job that names an id is that id's turn. A replay that finds such a job marks the hold sent with that
// job id instead of starting a second run -- which is the whole reason the id exists, because the panel can die
// between "the turn was accepted" and "the record says so".
//
// `seq` is the ARRIVAL order, and it is what the replay walks. `at` is the page's own clock, kept for the card's
// "queued 3m ago" line, but two presses in one millisecond share it: seq is the order, `at` is only the age.
//
// States:
//   held      -- written and not accepted yet. The only state a replay may start.
//   sending   -- CLAIMED by exactly one caller (the page's press or the boot replay), which is in the middle of
//                accepting it. `claim()` flips it synchronously, so in a single-process panel two callers cannot both
//                win. A death in this window is repaired on the next boot by `reconcile`: a job carrying the id means
//                the turn WAS accepted (mark sent), no such job means the claim died before the acceptance (held).
//   sent      -- a turn carries it; `jobId` names that turn.
//   cancelled -- the reader took it back with the x, or saved the edit empty. Never sent, never replayed.
//   parked    -- a send failed for a reason that cannot fix itself (the thread no longer exists, the tree was
//                released). The words are kept and the card offers Retry; the drain never touches it again. A hold
//                that failed for a reason that MIGHT fix itself stays `held` with an exponential backoff
//                (`nextTryAt`), so a gateway outage or a busy tree is not retried every two seconds for ever.
//
// A failed attempt is recorded on the record (`attempts`, `lastError`, `nextTryAt`) rather than only in the log: the
// log line is written when the state or the reason CHANGES, not once per pass, which is what a 2s clock times a
// permanently failing record used to produce (87% of one day's log, measured 2026-11-21).
//
// Caps: held/sending entries are never dropped (they are the reader's words, owed a turn), and the newest
// TERMINAL records (sent, cancelled, parked) are kept so a card can say what happened to one. A file over the cap
// loses its oldest terminal records first.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normaliseOne } from "./attachments.js";

export const HELD_VERSION = 1;
export const HELD_STATES = ["held", "sending", "sent", "cancelled", "parked"];
// The states a replay may start, in the one order it walks them.
export const HELD_OPEN = ["held", "sending"];
// States that are settled: they are never replayed, and they are the only ones the cap may drop.
export const HELD_TERMINAL = ["sent", "cancelled", "parked"];
export const HELD_TEXT_MAX = 12_000;
export const HELD_THREAD_MAX = 200;
export const HELD_ATTACH_MAX = 12;
export const HELD_DONE_KEEP = 40;
export const HELD_TOTAL_CAP = 200;
export const HELD_WHY_MAX = 400;
// A transient failure backs off from one clock beat to a ceiling: 2s, 4s, 8s ... 5 min. The clock keeps running
// while anything is open; a record that is not due is skipped, not retried.
export const HELD_BACKOFF_BASE_MS = 2_000;
export const HELD_BACKOFF_MAX_MS = 5 * 60_000;

export function heldBackoffMs(attempts = 1) {
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  return Math.min(HELD_BACKOFF_MAX_MS, HELD_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 8));
}

const clean = (s) => String(s ?? "").replace(/\r/g, "").trim();

// A held reply's attachments: the same shape every other store uses (lib/attachments.js), the reader's own words
// untouched. A path that is not one the panel stored is NOT dropped here -- the page loads the queue back and the
// chip must show what the reader attached; the gate that decides what may reach a run is `inheritAttachments`, and
// the send path asks it, so a hand-edited file cannot smuggle a path in through this store.
function normaliseList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const one = normaliseOne(raw);
    if (!one) continue;
    const key = one.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(one);
    if (out.length >= HELD_ATTACH_MAX) break;
  }
  return out;
}

// The record as it is written and answered: a fixed shape, so a hand-edited file cannot grow a field every route
// then trusts. An unknown state reads as `held` -- the safe half: it is a message the reader meant to send, and the
// replay will only start it if the thread is free.
function pickReply(r, { seq = 0 } = {}) {
  const state = HELD_STATES.includes(r?.state) ? r.state : "held";
  return {
    id: String(r?.id || "").trim() || randomUUID().slice(0, 8),
    seq: Number(r?.seq) > 0 ? Math.floor(Number(r.seq)) : seq,
    thread: clean(r?.thread).slice(0, HELD_THREAD_MAX),
    text: String(r?.text ?? "").replace(/\r/g, "").slice(0, HELD_TEXT_MAX),
    attachments: normaliseList(r?.attachments),
    at: Number(r?.at) > 0 ? Math.floor(Number(r.at)) : Date.now(),
    state,
    jobId: clean(r?.jobId) || null,
    why: clean(r?.why).slice(0, HELD_WHY_MAX) || null,
    sentAt: clean(r?.sentAt) || null,
    // The attempt record. Additive to version 1: an older file simply has none of these, and a `parked` state in a
    // file written by this build reads as `held` on an older one (the safe half: it would be retried, not lost).
    attempts: Number.isFinite(Number(r?.attempts)) && Number(r.attempts) > 0 ? Math.floor(Number(r.attempts)) : 0,
    lastError: clean(r?.lastError).slice(0, HELD_WHY_MAX) || null,
    nextTryAt: Number(r?.nextTryAt) > 0 ? Math.floor(Number(r.nextTryAt)) : 0,
    parkedAt: clean(r?.parkedAt) || null,
  };
}

export function createHeldReplies({ file = null, onLog = () => {} } = {}) {
  let doc = { version: HELD_VERSION, seq: 0, replies: [] };
  let loaded = false;

  const all = () => doc.replies;
  const bySeq = (a, b) => a.seq - b.seq || a.at - b.at || String(a.id).localeCompare(String(b.id));

  // The cap, applied on the way IN and on the way OUT (the same rule the assistant queue keeps): the active
  // records survive, and only the oldest terminal ones go -- first down to HELD_DONE_KEEP of them, then, if the file
  // is still over HELD_TOTAL_CAP, oldest first until it fits. A record that is still owed a turn is never dropped.
  function trimmed(list) {
    const sorted = [...list].sort(bySeq);
    const drop = new Set();
    const terminal = sorted.filter((r) => HELD_TERMINAL.includes(r.state));
    for (const r of terminal.slice(0, Math.max(0, terminal.length - HELD_DONE_KEEP))) drop.add(r.id);
    let kept = sorted.filter((r) => !drop.has(r.id));
    if (kept.length > HELD_TOTAL_CAP) {
      const over = kept.length - HELD_TOTAL_CAP;
      for (const r of kept.filter((r) => !HELD_OPEN.includes(r.state)).slice(0, over)) drop.add(r.id);
      kept = kept.filter((r) => !drop.has(r.id));
    }
    return kept;
  }

  function persist() {
    const out = { version: HELD_VERSION, seq: doc.seq, savedAt: new Date().toISOString(), replies: doc.replies };
    if (!file) return;
    // SYNCHRONOUS on purpose. The whole point of this record is that it exists before the turn does: a queued write
    // that lands a few milliseconds later is a window where the process can die holding a message nothing has stored.
    // The file is small (a few hundred records at most), so the cost is a sub-millisecond write on the path that
    // starts a turn, and every transition pays it once.
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(out));
      // Windows refuses a rename onto a target another process holds open (a scanner, an editor) with EPERM or EBUSY
      // rather than waiting. The window is milliseconds, so a retry, and a direct write as the last resort: the record
      // reaching the disk matters more than the swap being atomic.
      for (let attempt = 0; ; attempt += 1) {
        try {
          renameSync(tmp, file);
          return;
        } catch (e) {
          if (attempt >= 4) {
            writeFileSync(file, JSON.stringify(out));
            return;
          }
        }
      }
    } catch (e) {
      onLog(`held replies: could not write ${file}: ${String((e && e.message) || e)}`);
    } finally {
      // A write that did not reach the rename leaves only its own temp file.
      try {
        unlinkSync(tmp);
      } catch {
        /* it was renamed, or it was never created */
      }
    }
  }

  function nextSeq() {
    let max = Number(doc.seq) || 0;
    for (const r of doc.replies) max = Math.max(max, Number(r.seq) || 0);
    doc.seq = max + 1;
    return doc.seq;
  }

  return {
    get file() {
      return file;
    },

    // Read the store. A file that cannot be parsed is SAID and left where it is: this module does not overwrite a
    // record it could not read, because the reader's message may still be in it and a human can recover it.
    load() {
      if (loaded) return this.view();
      loaded = true;
      if (!file || !existsSync(file)) return this.view();
      try {
        const saved = JSON.parse(readFileSync(file, "utf8"));
        const list = [];
        for (const r of Array.isArray(saved?.replies) ? saved.replies : []) {
          if (!r || typeof r !== "object") continue;
          const one = pickReply(r, { seq: list.length + 1 });
          if (!one.thread || !one.text.trim()) continue;
          list.push(one);
        }
        doc = { version: HELD_VERSION, seq: Number(saved?.seq) || list.reduce((m, r) => Math.max(m, r.seq), 0), replies: trimmed(list.sort(bySeq)) };
        const open = doc.replies.filter((r) => HELD_OPEN.includes(r.state)).length;
        onLog(`held replies: ${doc.replies.length} record(s) from ${file}, ${open} waiting for a turn`);
      } catch (e) {
        onLog(`held replies: ${file} could not be read (${String((e && e.message) || e)}) -- it was left untouched, and no hold is replayed from it`);
      }
      return this.view();
    },

    view() {
      const list = [...doc.replies].sort(bySeq);
      return {
        file,
        seq: doc.seq,
        replies: list,
        counts: {
          total: list.length,
          // `open` is the number still owed a turn (held + sending). It is in `counts` so a card and this panel's own
          // drain ask the same question of the same number.
          open: list.filter((r) => HELD_OPEN.includes(r.state)).length,
          held: list.filter((r) => r.state === "held").length,
          sending: list.filter((r) => r.state === "sending").length,
          sent: list.filter((r) => r.state === "sent").length,
          cancelled: list.filter((r) => r.state === "cancelled").length,
          parked: list.filter((r) => r.state === "parked").length,
        },
        open: list.filter((r) => HELD_OPEN.includes(r.state)),
      };
    },

    get(id) {
      return doc.replies.find((r) => r.id === String(id || "")) || null;
    },

    openCount() {
      let n = 0;
      for (const r of doc.replies) if (HELD_OPEN.includes(r.state)) n += 1;
      return n;
    },

    // Every record for one thread, oldest first: the order the card draws and the drain sends.
    forThread(thread) {
      const t = String(thread || "");
      return doc.replies.filter((r) => r.thread === t).sort(bySeq);
    },

    openForThread(thread) {
      const t = String(thread || "");
      return doc.replies.filter((r) => r.thread === t && HELD_OPEN.includes(r.state)).sort(bySeq);
    },

    // Add a hold. IDEMPOTENT BY ID: the page can press twice, or retry a POST whose answer it never saw, and the
    // same id is still one record. A record that already has a turn is not reopened.
    add({ id = null, thread = "", text = "", attachments = [], at = null } = {}) {
      const t = clean(thread).slice(0, HELD_THREAD_MAX);
      const body = String(text ?? "").replace(/\r/g, "");
      if (!t) {
        const err = new Error("a held reply needs the thread it is meant for");
        err.code = "held-thread";
        throw err;
      }
      if (!body.trim()) {
        const err = new Error("a held reply needs its text");
        err.code = "held-text";
        throw err;
      }
      const wanted = clean(id);
      if (wanted) {
        const existing = this.get(wanted);
        if (existing) return { reply: existing, added: false };
      }
      const reply = pickReply(
        { id: wanted || randomUUID().slice(0, 8), seq: nextSeq(), thread: t, text: body, attachments, at: at || Date.now(), state: "held" },
        { seq: doc.seq },
      );
      doc.replies = trimmed([...doc.replies, reply].sort(bySeq));
      persist();
      return { reply, added: true };
    },

    // The reader changed the words of a hold that has not been sent. Only a `held` record may be edited: a claimed
    // one is already being accepted, and a sent one belongs to a turn. An empty edit is the reader saying what the
    // x says, so it cancels (the caller sends `cancel` for that; this returns false and changes nothing).
    edit(id, text) {
      const r = this.get(id);
      if (!r) return { ok: false, why: "no such held reply" };
      if (r.state !== "held") return { ok: false, why: `it is already ${r.state}, so its words are settled` };
      const body = String(text ?? "").replace(/\r/g, "");
      if (!body.trim()) return { ok: false, why: "an empty edit cancels the hold" };
      r.text = body.slice(0, HELD_TEXT_MAX);
      persist();
      return { ok: true, reply: r };
    },

    // The reader took it back. A claimed record is reported, not silently cancelled: the turn may already be
    // starting, and saying "sending" is the honest answer the page can put beside the box.
    cancel(id, why = "the reader took it back") {
      const r = this.get(id);
      if (!r) return { ok: false, why: "no such held reply" };
      if (r.state === "sent") return { ok: false, why: "that one was already sent", state: "sent" };
      if (r.state === "sending") return { ok: false, why: "it is being sent now", state: "sending" };
      if (r.state === "cancelled") return { ok: true, reply: r, changed: false };
      r.state = "cancelled";
      r.why = clean(why).slice(0, HELD_WHY_MAX) || null;
      r.nextTryAt = 0;
      persist();
      return { ok: true, reply: r, changed: true };
    },

    // THE compare-and-set. One caller wins a `held` record; every other sees null and must not start a turn. It is
    // synchronous on purpose: Node runs one callback at a time, so two callers cannot both read `held` before either
    // writes `sending`.
    claim(id) {
      const r = this.get(id);
      if (!r || r.state !== "held") return null;
      r.state = "sending";
      r.why = null;
      persist();
      return r;
    },

    // A claim whose turn was accepted. `jobId` is the panel's own job record, and it is what a later reconcile reads
    // the id back from.
    sent(id, jobId) {
      const r = this.get(id);
      if (!r) return null;
      r.state = "sent";
      r.jobId = clean(jobId) || null;
      r.sentAt = new Date().toISOString();
      r.why = null;
      r.lastError = null;
      r.nextTryAt = 0;
      persist();
      return r;
    },

    // A claim that could NOT be accepted (the tree has a live run, the gateway refused, the tree is gone): it goes
    // back to `held`, with the reason named, so the next pass tries again instead of the message being lost.
    release(id, why = "") {
      const r = this.get(id);
      if (!r || r.state === "sent" || r.state === "cancelled") return null;
      r.state = "held";
      r.why = clean(why).slice(0, HELD_WHY_MAX) || null;
      // A busy thread is not a failure: the hold goes the moment the turn ends, with no backoff.
      r.nextTryAt = 0;
      persist();
      return r;
    },

    // A send that FAILED. This is the one place that decides whether the record is still owed a turn:
    //
    //   permanent  the reason cannot fix itself (`unknown thread`: the panel has no job for it, and nothing will
    //              create one). The record is PARKED, not dropped: its words stay, the card offers Retry, and the
    //              drain never asks again. This is what a 45.9h retry loop taught (2026-11-21).
    //   transient  a gateway outage, a released tree, a refusal: still owed a turn, with exponential backoff so the
    //              2s clock does not hammer it. It is never parked for being slow; the reader's words are not
    //              abandoned because a host was down.
    fail(id, why = "", { permanent = false, now = Date.now() } = {}) {
      const r = this.get(id);
      if (!r || r.state === "sent" || r.state === "cancelled") return null;
      const reason = clean(why).slice(0, HELD_WHY_MAX) || "the turn could not be started";
      r.attempts = (Number(r.attempts) || 0) + 1;
      r.lastError = reason;
      r.why = reason;
      if (permanent) {
        r.state = "parked";
        r.parkedAt = new Date(now).toISOString();
        r.nextTryAt = 0;
      } else {
        r.state = "held";
        r.nextTryAt = now + heldBackoffMs(r.attempts);
      }
      persist();
      return r;
    },

    // The reader's Retry on a parked record: the words go back in the queue and the drain tries once more. Only a
    // parked record may be revived here; a held one is already waiting and a settled one is not the reader's to
    // reopen.
    retry(id) {
      const r = this.get(id);
      if (!r || r.state !== "parked") return { ok: false, why: r ? `it is ${r.state}, not parked` : "no such held reply" };
      r.state = "held";
      r.attempts = 0;
      r.lastError = null;
      r.nextTryAt = 0;
      r.why = null;
      r.parkedAt = null;
      persist();
      return { ok: true, reply: r };
    },

    // Boot repair for the one window a crash can leave: a record CLAIMED by a process that died before the record
    // said `sent`. `jobFor(id)` answers the job that carries this hold's id, if any. Found: the turn was accepted
    // (mark sent with it, no second run). Not found: the claim died before the acceptance (back to held).
    reconcile(jobFor) {
      let changed = 0;
      for (const r of doc.replies) {
        if (r.state !== "sending") continue;
        const job = typeof jobFor === "function" ? jobFor(r.id) : null;
        if (job && job.id) {
          r.state = "sent";
          r.jobId = String(job.id);
          r.sentAt = r.sentAt || new Date().toISOString();
          r.why = null;
          changed += 1;
        } else {
          r.state = "held";
          r.why = "the panel restarted while this hold was being accepted; no turn carries it, so it is owed one";
          r.nextTryAt = 0;
          changed += 1;
        }
      }
      if (changed) persist();
      return { changed, view: this.view() };
    },
  };
}
