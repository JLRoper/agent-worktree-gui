// One press of Queue reply holds ONE entry - and the box comes back for the next message.
//
// The defect this file pins: 205d7098 answered "is a reply held?" and closed the card on it, so a card that held
// a reply could not take a second, different message. The block was total - the button was disabled and the box
// was read-only with "queued, waiting" where its sentence was - and it lasted as long as the entry waited, which
// is the whole turn. The duplicate press it was fixing was never the same thing: that hole is open only while a
// press is IN FLIGHT, which is a window of one task, not of one turn.
//
// So the predicate is split, and this file pins the split against the page's OWN functions over a small DOM
// model (the pattern queued-reply-attachments.test.js uses):
//   (a) after a reply is held the box accepts text again - open, empty, with the button live and the note
//       counting what is held;
//   (b) two different messages from one card produce two held entries, in the order they were written;
//   (c) a second press INSIDE the first press's flight holds nothing - the guard is the flight, not the queue;
//   (d) Enter asks the same predicate and calls the same function as the button, so it cannot slip past.
// Plus the face itself: the closed state belongs to the flight and is gone when it settles, success or failure.
//
// RED PROOF. On the base build this file fails at load: the page carries no queuePressInFlight(), so the grab
// below refuses. The behavioural red - the box refusing text, and the second message being impossible - is
// tools/verify-queue-multi-hold.mjs run against a `git archive` of the base: a real card in a real browser,
// where the same four claims are measured on the shipped renderer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const page = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = page("public/app.js");
const renderJobs = page("public/render-jobs.js");

// One top-level function from a classic script, by name. `async` is part of some of them, so the prefix is optional.
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
  "queueReplyFromBox",
  "replyQueued",
  "queueWaitingOn",
  "queuePressInFlight",
  "queueWaitPhrase",
  "pressSettled",
  "paintQueueWait",
  "heldReplyBlocked",
  "markReplySent",
  "replyTakenByDrain",
  "drainReplyQueue",
];
const source = NAMES.map((n) => grab(app, n)).join("\n");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const CSS = { escape: (s) => String(s) };
const THREAD = "wtgui-queue-multi-hold-abc123";
const FIRST = "hold this one while the turn runs";
const SECOND = "and this one is a different message";
const IDLE_PH = "a turn is running - Ctrl+Enter steers it; Enter holds yours for the next turn";

// ---- a DOM small enough to see: the box, the card's button and its queued note -------------------------------
class El {
  constructor(dataset = {}, { tag = "DIV", value = "", html = "" } = {}) {
    this.dataset = dataset;
    this.tagName = tag;
    this.value = value;
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    this._attrs = new Map();
    this._html = html;
    this.classList = {
      toggle: (name, on) => {
        const set = new Set(String(this.className || "").split(/\s+/).filter(Boolean));
        if (on) set.add(name);
        else set.delete(name);
        this.className = [...set].join(" ");
      },
      contains: (name) => String(this.className || "").split(/\s+/).includes(name),
    };
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
  }
  get className() {
    return this._className || "";
  }
  set className(v) {
    this._className = String(v);
  }
  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }
  removeAttribute(name) {
    this._attrs.delete(name);
  }
  focus() {}
  closest() {
    return null;
  }
}

function harness({ box = "" } = {}) {
  const boxEl = new El({ reply: THREAD, ph: IDLE_PH, phIdle: IDLE_PH }, { tag: "DIV", value: box });
  boxEl.setAttribute("contenteditable", "true");
  const btn = new El({ queueReply: THREAD }, { tag: "BUTTON" });
  const note = new El({ queueWait: THREAD });
  note.hidden = true;
  const card = new El({ thread: THREAD }, { html: "card" });
  card.querySelector = (sel) => {
    if (sel.includes("[data-queue-reply]")) return btn;
    if (sel.includes("[data-queue-wait]")) return note;
    return null;
  };
  const nodes = [boxEl, card];
  const doc = {
    nodes,
    querySelector(sel) {
      const want = [...sel.matchAll(/\[data-([\w-]+)="([^"]*)"\]/g)].map((m) => [m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()), m[2].replace(/\\(.)/g, "$1")]);
      if (!want.length) return null;
      return nodes.find((n) => want.every(([k, v]) => n.dataset[k] === v)) || null;
    },
  };
  const sent = [];
  const renders = [];
  const ctx = {
    document: doc,
    CSS,
    Map,
    Set,
    Boolean,
    String,
    Array,
    Number,
    JSON,
    Date,
    RegExp,
    Promise,
    setTimeout,
    esc,
    readBox: (el) => (el ? String(el.value) : ""),
    writeBox: (el, text) => {
      if (el) el.value = String(text == null ? "" : text);
    },
    clearBoxDraft: () => {},
    renderConversation: (thread) => renders.push(thread),
    attachmentsFor: () => [],
    setAttachments: () => {},
    renderChips: () => {},
    threadBusy: () => ctx.__busy,
    childrenOut: () => false,
    queuedEditFor: () => null,
    sendReply: async (thread, text) => {
      sent.push({ thread, text });
      return true;
    },
    apiFetch: async () => ({ ok: true, json: async () => ({}) }),
    state: {
      replyQueue: new Map(),
      replyPress: new Map(),
      replyAttachments: new Map(),
      replyDrafts: {},
      replyEdit: null,
      replySent: new Map(),
      replyNav: new Map(),
      justSent: new Map(),
      jobs: new Map(),
      boxModels: new Map(),
      pasteChips: new Map(),
    },
    subagentFallback: new Map(),
    __busy: false,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return Object.assign(ctx, { doc, card, boxEl, btn, note, sent, renders });
}

// Paths in the HOST realm: arrays built inside the vm carry the vm's Array prototype.
const texts = (h) => Array.from(h.replyQueued(THREAD), (e) => e.text);
const face = (h) => ({
  editable: h.boxEl.getAttribute("contenteditable"),
  readOnly: h.boxEl.getAttribute("aria-readonly"),
  closed: h.boxEl.classList.contains("queued-waiting"),
  btn: h.btn.disabled,
  note: h.note.hidden ? null : h.note.textContent,
  ph: h.boxEl.dataset.ph,
});

// ---- (a) the box comes back -------------------------------------------------------------------------------------
test("(a) after a reply is held the box accepts text again, empty and with the button live", async () => {
  const h = harness({ box: FIRST });

  assert.equal(await h.queueReplyFromBox(THREAD), true, "the first press holds the reply");
  assert.deepEqual(texts(h), [FIRST], "one held entry");

  assert.equal(h.boxEl.getAttribute("contenteditable"), "true", "the box is editable again");
  assert.equal(h.boxEl.getAttribute("aria-readonly"), null, "and no longer says it is read-only");
  assert.equal(h.boxEl.classList.contains("queued-waiting"), false, "the closed class is off");
  assert.equal(h.btn.disabled, false, "the Queue reply button is live again");
  assert.equal(h.boxEl.value, "", "the box came back cleared");
  assert.equal(h.note.hidden, false, "the held reply is still counted beside it");
  assert.equal(h.note.textContent, "1 queued", "in the count, not in the closed face's words");
  assert.equal(h.boxEl.dataset.ph, IDLE_PH, "and the box carries its own sentence again");

  // The claim in the reader's words: it takes a second, different message.
  h.writeBox(h.boxEl, SECOND);
  assert.equal(h.readBox(h.boxEl), SECOND, "the box accepts text again");
});

// ---- (b) two different messages are two held entries ------------------------------------------------------------
test("(b) two different messages from one card produce two held entries, in the order they were written", async () => {
  const h = harness({ box: FIRST });

  assert.equal(await h.queueReplyFromBox(THREAD), true);
  assert.equal(h.queuePressInFlight(THREAD), false, "the first press has settled");
  h.writeBox(h.boxEl, SECOND);
  assert.equal(await h.queueReplyFromBox(THREAD), true, "the second press holds the second message");

  assert.deepEqual(texts(h), [FIRST, SECOND], "both are held, in order");
  assert.equal(h.note.textContent, "2 queued", "the card counts both");
  const [a, b] = Array.from(h.replyQueued(THREAD));
  assert.notEqual(a.at, b.at, "each entry has its own identity");
});

// ---- (c) the flight, and nothing else, refuses a press ----------------------------------------------------------
test("(c) a second press inside the first press's flight holds nothing", async () => {
  const h = harness({ box: FIRST });

  // The first press is NOT awaited: while it is in flight the guard must answer for it.
  const first = h.queueReplyFromBox(THREAD);
  assert.equal(h.queuePressInFlight(THREAD), true, "the press is in flight");

  const inflight = face(h);
  assert.equal(inflight.editable, "false", "and the box is closed for exactly that window");
  assert.equal(inflight.readOnly, "true");
  assert.equal(inflight.closed, true);
  assert.equal(inflight.btn, true, "with the button off");
  assert.equal(inflight.note, "queued, waiting", "and the closed face's words");
  assert.equal(inflight.ph, h.queueWaitPhrase(), "and its placeholder");

  // A stale node, or a keypress the repaint has not caught up with, still carries text: the refusal has to be
  // the flight, not an empty box.
  h.writeBox(h.boxEl, SECOND);
  assert.equal(await h.queueReplyFromBox(THREAD), false, "the second press holds nothing");
  assert.deepEqual(texts(h), [FIRST], "so the card still holds exactly one reply");

  assert.equal(await first, true, "the first press still reports that it held its reply");
  assert.equal(h.queuePressInFlight(THREAD), false, "and the flight is over");
  assert.deepEqual(
    face(h),
    { editable: "true", readOnly: null, closed: false, btn: false, note: "1 queued", ph: IDLE_PH },
    "the face came off when it settled",
  );
});

test("the face comes off even when the commit is refused", async () => {
  const h = harness({ box: FIRST });
  // A queueReply that throws stands for any failure inside the press: the reader must get the box back.
  h.queueReply = () => {
    throw new Error("the commit failed");
  };
  await assert.rejects(() => h.queueReplyFromBox(THREAD), /the commit failed/);

  assert.equal(h.queuePressInFlight(THREAD), false, "the flight is released");
  assert.equal(h.boxEl.getAttribute("contenteditable"), "true", "the box is back");
  assert.equal(h.btn.disabled, false, "and the button is live");
});

// ---- (d) Enter asks the same question and calls the same function -----------------------------------------------
test("(d) Enter obeys the same predicate as the button and goes through the same function", async () => {
  // The keyboard's guard is the press's flight, never the queue: a held reply must not put keys out of reach.
  assert.match(app, /if \(queuePressInFlight\(box\.dataset\.reply\)\) return;/, "the keydown handler asks queuePressInFlight");
  assert.ok(!/if \(queueWaitingOn\(box\.dataset\.reply\)\) return;/.test(app), "and no longer asks the queue predicate");

  // Both gestures are one function: the click branch and the Enter branch.
  const clickBranch = /const queueBtn = e\.target\.closest\("\[data-queue-reply\]"\);[\s\S]{0,500}?queueReplyFromBox\(queueBtn\.dataset\.queueReply\);/.exec(app);
  assert.ok(clickBranch, "the Queue reply button's press goes through queueReplyFromBox");
  const enterBranch = /if \(queueOfferedFor\(box\)\) \{\s*void queueReplyFromBox\(thread\);/.exec(app);
  assert.ok(enterBranch, "and so does Enter, through the same function");

  // And the behaviour behind it: while a press is in flight the predicate the handler asks is true for the box's
  // thread, so the keystroke returns before it can reach a press of its own.
  const h = harness({ box: FIRST });
  const first = h.queueReplyFromBox(THREAD);
  assert.equal(h.queuePressInFlight(h.boxEl.dataset.reply), true, "the handler's guard answers yes mid-flight");
  await first;
  assert.equal(h.queuePressInFlight(h.boxEl.dataset.reply), false, "and no once it has settled");
});

// ---- the render draws the closed face from the flight, and the count from the queue -----------------------------
test("the card's render closes the box on the press in flight and counts the held replies separately", () => {
  assert.match(renderJobs, /const queueInFlight = queuePressInFlight\(thread\);/, "the render asks the flight");
  assert.match(renderJobs, /const queueHeld = queueWaitingOn\(thread\);/, "and the queue for the count");
  assert.match(renderJobs, /contenteditable="\$\{queueInFlight \? "false" : "true"\}"/, "the box is closed only mid-press");
  assert.match(renderJobs, /data-ph="\$\{esc\(queueInFlight \? queueWaitPhrase\(\) : idlePh\)\}"/, "with the flight's sentence");
  assert.match(renderJobs, /data-ph-idle="\$\{esc\(idlePh\)\}"/, "and its own kept beside it");
  assert.match(renderJobs, /disabled aria-disabled="true"/, "the button is drawn off mid-press");
  assert.match(renderJobs, /\$\{queueInFlight \? "queued, waiting" : `\$\{queued\} queued`\}/, "the note counts, unless a press is landing");
  assert.match(renderJobs, /running \|\| childrenStillOut \|\| queueHeld \|\| queueInFlight/, "the button is offered while a reply is held");
});

// ---- the count clears when the drain takes the entries out -----------------------------------------------------
test("the drain sends the held replies in order and takes the count off the card", async () => {
  const h = harness({ box: FIRST });
  await h.queueReplyFromBox(THREAD);
  h.writeBox(h.boxEl, SECOND);
  await h.queueReplyFromBox(THREAD);

  await h.drainReplyQueue(THREAD);
  assert.deepEqual(h.sent.map((s) => s.text), [FIRST], "the first one goes first");
  assert.deepEqual(texts(h), [SECOND], "the second is still held");
  assert.equal(h.note.textContent, "1 queued", "the count follows the queue");

  await h.drainReplyQueue(THREAD);
  assert.deepEqual(h.sent.map((s) => s.text), [FIRST, SECOND], "and then the second");
  assert.deepEqual(texts(h), [], "nothing is left held");
  assert.equal(h.note.hidden, true, "so the note is gone");
  assert.equal(h.boxEl.getAttribute("contenteditable"), "true", "the box is the reader's");
});

// ---- the old duplicate hole, still shut ------------------------------------------------------------------------
test("a double press that lands before the repaint holds one entry, not two", async () => {
  const h = harness({ box: FIRST });
  // Two presses in the same turn of the event loop, as a double click or a held Enter key delivers them.
  const a = h.queueReplyFromBox(THREAD);
  const b = h.queueReplyFromBox(THREAD);
  assert.equal(await a, true, "the first holds");
  assert.equal(await b, false, "the second is the same press");
  assert.deepEqual(texts(h), [FIRST], "one entry, never two of the same text");
});
