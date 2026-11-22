// ONE press of Enter holds ONE queued reply, even though the press writes to the panel and to this page at once.
//
// The defect this file pins: `queueReply()` pushes the entry into `state.replyQueue` and THEN posts it to the panel
// (POST /api/held-replies, action add). The panel stores the record with the page's own `at` and broadcasts its
// `held-replies` view - and the drain broadcasts that view whenever a hold arrives, starts or is released. When the
// broadcast lands before the POST's answer has stamped `heldId` on the local entry, `applyHeldReplies()` could not
// find the record by id, read it as a record the page did NOT hold, and pushed a second entry for the same words:
// two chips for one press, both with the same age, the card counting "2 queued", and the x clearing both.
//
// The fix is identity: an entry the panel has not keyed yet is recognised by the identity the queue already works in,
// its `at` (which the panel stores and echoes with the record), with its text beside it. The record is then that
// entry, its id is adopted, and nothing is added.
//
// The page's OWN functions run over a small state model (the pattern test/queue-single-press.test.js uses); the
// browser half - one chip at 1440, before and after - is tools/verify-queue-held-snapshot-race.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const page = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = page("public/app.js");

// One top-level function from public/app.js, by name. `async` is part of some of them, so the prefix is optional.
function grab(src, name) {
  const m = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(src);
  assert.ok(m, `the page carries ${name}()`);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is a top-level function`);
  return src.slice(start, end + 3);
}

const NAMES = [
  "queueReply",
  "replyQueued",
  "queueWaitingOn",
  "takeQueuedReply",
  "queuedEditFor",
  "cancelQueuedReply",
  "replyTakenByDrain",
  "applyHeldReplies",
  "postHeldReply",
  "cancelHeldReply",
];
const source = NAMES.map((n) => grab(app, n)).join("\n");

const THREAD = "wtgui-held-snapshot-race-4d1c2a";
const FIRST = "held while the turn is still running";
const SECOND = "a different message, held on purpose";

function harness() {
  const calls = { adds: [], cancels: [], renders: [], drains: [] };
  // The POST's answer, held open until the test lets it land: that is the window the defect lives in.
  let answerAdd = null;
  const ctx = {
    Map,
    Set,
    String,
    Number,
    Array,
    Boolean,
    JSON,
    Date,
    Promise,
    Math,
    RegExp,
    state: { replyQueue: new Map(), replySent: new Map(), replyDrafts: {} },
    esc: (s) => String(s ?? ""),
    CSS: { escape: (s) => String(s) },
    document: { querySelector: () => null },
    readBox: () => "",
    addAttachments: () => 0,
    attachmentsFor: () => [],
    setAttachments: () => {},
    renderChips: () => {},
    renderConversation: (thread) => calls.renders.push(thread),
    paintQueueWait: () => {},
    drainReplyQueue: (thread) => {
      calls.drains.push(thread);
      return Promise.resolve({ started: null });
    },
    // The panel, as the page sees it: `add` is answered only when the test says so, so the entry can sit without a
    // `heldId` exactly as it does on a live page between the press and the answer.
    apiFetch: (url, opts = {}) => {
      const body = opts.body ? JSON.parse(String(opts.body)) : {};
      if (String(url) !== "/api/held-replies") return Promise.resolve({ ok: false, json: async () => ({}) });
      if (body.action === "cancel") {
        calls.cancels.push(body.id);
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, changed: true }) });
      }
      calls.adds.push(body);
      return new Promise((resolve) => {
        answerAdd = () =>
          resolve({
            ok: true,
            json: async () => ({
              ok: true,
              added: true,
              reply: { id: `held-${calls.adds.length}`, thread: body.thread, text: body.text, at: body.at, state: "held" },
            }),
          });
      });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return Object.assign(ctx, {
    calls,
    answerAdd: () => answerAdd && answerAdd(),
    held: () => Array.from(ctx.replyQueued(THREAD)),
  });
}

// The panel's own `held-replies` view of ONE record, as the store keeps it: the page's `at` comes back untouched.
const record = (h, entry, over = {}) => ({
  id: over.id || "held-1",
  thread: THREAD,
  text: entry.text,
  at: entry.at,
  state: "held",
  ...over,
});

// ---- the defect: the broadcast lands before the answer that names the entry ---------------------------------------
test("one press and the panel's view of that same press is ONE entry, not two", () => {
  const h = harness();
  h.queueReply(THREAD, FIRST);
  const [entry] = h.held();
  assert.equal(entry.text, FIRST, "the press pushed its entry at once");
  assert.equal(entry.heldId, undefined, "and its answer has not named it yet");

  // The panel's broadcast of THIS record, while the POST's answer is still in flight.
  h.applyHeldReplies([record(h, entry)]);
  assert.equal(h.held().length, 1, "one Enter is one queued entry, never a chip and its twin");
  assert.equal(h.held()[0].heldId, "held-1", "and the entry took the panel's id from the record it already was");
  assert.equal(h.queueWaitingOn(THREAD), true, "the reply is still held");

  // The answer lands afterwards with the same id: still one entry.
  h.answerAdd();
  return h.held()[0].held.then(() => {
    assert.equal(h.held().length, 1, "and the answer that follows does not add a second");
    assert.equal(h.held()[0].heldId, "held-1");
  });
});

test("the card counts one, and the x takes that one back with the record", () => {
  const h = harness();
  h.queueReply(THREAD, FIRST);
  const [entry] = h.held();
  h.applyHeldReplies([record(h, entry)]);
  assert.equal(h.held().length, 1);
  assert.equal(h.replyQueued(THREAD).length, 1, "the count the card draws is the queue");

  // The x, keyed on the entry's own `at`: it takes the ONE entry and cancels the record it now knows the id of.
  assert.equal(h.cancelQueuedReply(THREAD, entry.at), "cancelled");
  assert.equal(h.held().length, 0, "the entry is gone");
  assert.deepEqual(h.calls.cancels, ["held-1"], "and so is the panel's record, by the id the entry adopted");
});

test("re-queueing after the x brings back ONE entry, not the pair", () => {
  const h = harness();
  h.queueReply(THREAD, FIRST);
  h.applyHeldReplies([record(h, h.held()[0])]);
  const firstAt = h.held()[0].at;
  h.cancelQueuedReply(THREAD, firstAt);

  h.queueReply(THREAD, FIRST);
  const [again] = h.held();
  // The cancelled record and the new press can share a millisecond, so the broadcast that cancels the first must not
  // take the second with it: a settled record is only ever removed by its id.
  h.applyHeldReplies([{ id: "held-1", thread: THREAD, text: FIRST, at: firstAt, state: "cancelled" }]);
  assert.equal(h.held().length, 1, "the re-queued reply survives the cancelled record");
  h.applyHeldReplies([{ id: "held-2", thread: THREAD, text: FIRST, at: again.at, state: "held" }]);
  assert.equal(h.held().length, 1, "and its own record is that one entry");
  assert.equal(h.held()[0].heldId, "held-2");
});

// ---- what applyHeldReplies is for, still intact ------------------------------------------------------------------
test("a record the panel settled comes off the card", () => {
  const h = harness();
  h.queueReply(THREAD, FIRST);
  const [entry] = h.held();
  h.applyHeldReplies([record(h, entry, { state: "held" })]);
  assert.equal(h.held()[0].heldId, "held-1", "the id landed on the entry");
  h.applyHeldReplies([record(h, entry, { state: "sent" })]);
  assert.equal(h.held().length, 0, "a hold the panel already sent is not still waiting on the card");
});

test("a record this page does not hold is still put back where it belongs", () => {
  const h = harness();
  // A fresh tab: nothing in its queue, and the panel holds a record from before the reload.
  h.applyHeldReplies([{ id: "held-7", thread: THREAD, text: SECOND, at: Date.now() - 4000, state: "held", attachments: [] }]);
  assert.equal(h.held().length, 1, "the record goes back into its thread's queue");
  assert.equal(h.held()[0].text, SECOND);
  assert.equal(h.held()[0].heldId, "held-7");
});

test("a press on the page and a DIFFERENT record stay two entries", () => {
  const h = harness();
  h.queueReply(THREAD, FIRST);
  const [mine] = h.held();
  h.applyHeldReplies([{ id: "held-8", thread: THREAD, text: SECOND, at: mine.at + 1, state: "held" }]);
  assert.equal(h.held().length, 2, "two different messages are two held entries");
  assert.deepEqual(h.held().map((e) => e.text), [FIRST, SECOND], "in the order they were written");
  assert.deepEqual(h.held().map((e) => e.heldId), [undefined, "held-8"], "and only the record's own press takes its id");
});

test("two presses in one turn of the clock still get one entry each", () => {
  const h = harness();
  const same = Date.now();
  h.queueReply(THREAD, FIRST);
  h.queueReply(THREAD, SECOND);
  const [a, b] = h.held();
  assert.notEqual(a.at, b.at, "each press has its own identity, even in the same millisecond");
  // The panel answers both, one broadcast carrying both records.
  h.applyHeldReplies([
    { id: "held-a", thread: THREAD, text: FIRST, at: a.at, state: "held" },
    { id: "held-b", thread: THREAD, text: SECOND, at: b.at, state: "held" },
  ]);
  assert.equal(h.held().length, 2, "two presses, two entries, never four");
  assert.deepEqual(h.held().map((e) => e.heldId), ["held-a", "held-b"]);
  assert.ok(Date.now() >= same, "the clock is the real one the queue stamps with");
});
