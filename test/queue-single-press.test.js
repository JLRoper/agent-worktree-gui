// One press of Queue reply puts the reply in flight - the card closes behind it.
//
// The defect: queueReplyFromBox read the box, cleared it and called queueReply with no guard. The card came back
// with an empty, editable box and a live Queue reply button beside one held reply, so the reader could type the
// same text again and press Queue reply again - two identical held entries, both of which the drain would send.
//
// This file drives the page's OWN functions over a small DOM model (the pattern queued-reply-attachments.test.js
// uses) and pins five pieces:
//   1. one press holds exactly one reply;
//   2. while it is held the Queue reply button is disabled and the box is read-only, and the card says
//      "queued, waiting";
//   3. a second press on the same text - with the text put back, as a stale node would carry it - holds nothing
//      a second time; the guard is in the function, so it holds even where the disabled attribute does not;
//   4. once the held reply is drawn (the drain sends it) the box is editable again and the note is gone;
//   5. the button and Enter are ONE path: both call queueReplyFromBox, and the card's render draws the closed face
//      from the same predicate the press guards with.
//
// The real card in a real browser, with real key presses, is tools/verify-queue-single-press.mjs. On the base build
// (71c2d169) this file fails at the first assertion: paintQueueWait and queueWaitingOn do not exist there, and a
// retyped reply is held twice.
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
const THREAD = "wtgui-queue-single-press-abc123";
const TEXT = "the same reply, pressed twice";

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
  const boxEl = new El({ reply: THREAD }, { tag: "DIV", value: box });
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

test("one press holds one reply and closes the card behind it", () => {
  const h = harness({ box: TEXT });

  assert.equal(h.queueReplyFromBox(THREAD), true, "the first press holds the reply");

  assert.deepEqual(texts(h), [TEXT], "exactly one held reply");
  assert.equal(h.btn.disabled, true, "the Queue reply button is disabled while it is held");
  assert.equal(h.btn.getAttribute("aria-disabled"), "true", "and says so to a screen reader");
  assert.equal(h.boxEl.getAttribute("contenteditable"), "false", "the box is read-only");
  assert.equal(h.boxEl.getAttribute("aria-readonly"), "true", "and says so to a screen reader");
  assert.equal(h.boxEl.value, "", "the box was cleared, as before");
  assert.equal(h.note.hidden, false, "the queued state is visible");
  assert.equal(h.note.textContent, "queued, waiting", "in the words the card draws");
});

test("a second press on the same text is the same press, never a second entry", () => {
  const h = harness({ box: TEXT });
  assert.equal(h.queueReplyFromBox(THREAD), true);

  // A stale box node can still carry the text (the press and the repaint are not the same frame): the guard is in
  // the function, so the text is refused even though nothing disabled it.
  h.writeBox(h.boxEl, TEXT);
  assert.equal(h.queueReplyFromBox(THREAD), false, "the second press holds nothing");

  assert.deepEqual(texts(h), [TEXT], "still exactly one held reply");
  assert.equal(h.btn.disabled, true, "and the card is still closed");
  assert.equal(h.boxEl.getAttribute("contenteditable"), "false", "the box did not reopen");
});

test("the state clears when the held reply is drawn", async () => {
  const h = harness({ box: TEXT });
  h.queueReplyFromBox(THREAD);
  assert.equal(h.note.hidden, false);

  // The turn ends: the drain takes the entry out and sends it.
  await h.drainReplyQueue(THREAD);

  assert.deepEqual(texts(h), [], "the held reply left the queue");
  assert.deepEqual(h.sent.map((s) => s.text), [TEXT], "and was drawn as the next turn");
  assert.equal(h.boxEl.getAttribute("contenteditable"), "true", "the box is editable again");
  assert.equal(h.boxEl.getAttribute("aria-readonly"), null, "and no longer says it is read-only");
  assert.equal(h.note.hidden, true, "the queued state is gone");
});

test("the button and Enter are one path, and the render draws the closed face from the same predicate", () => {
  // The click branch and the Enter branch both call queueReplyFromBox - the one function the guard lives in.
  const clickBranch = /const queueBtn = e\.target\.closest\("\[data-queue-reply\]"\);[\s\S]{0,500}?queueReplyFromBox\(queueBtn\.dataset\.queueReply\);/.exec(app);
  assert.ok(clickBranch, "the Queue reply button's press goes through queueReplyFromBox");
  const enterBranch = /if \(queueOfferedFor\(box\)\) \{\s*queueReplyFromBox\(thread\);/.exec(app);
  assert.ok(enterBranch, "and so does Enter, through the same function");

  // The card's own face is drawn from the same question the press asks, so a repaint cannot reopen the box.
  assert.match(renderJobs, /const queueHeld = queueWaitingOn\(thread\);/, "the render asks the press's predicate");
  assert.match(renderJobs, /contenteditable="\$\{queueHeld \? "false" : "true"\}"/, "and closes the box while it is held");
  assert.match(renderJobs, /disabled aria-disabled="true"/, "and draws the button off");
  assert.match(renderJobs, /data-queue-wait="\$\{esc\(thread\)\}"/, "and carries the queued state");
  assert.match(renderJobs, />queued, waiting</, "in the words the reader sees");
});
