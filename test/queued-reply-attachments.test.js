// A queued reply carries its OWN attachments.
//
// The defect: queueReply stored {text, at} and left the file in state.replyAttachments, so the composer kept
// showing a chip for a reply that had already been held; the drain then called sendReply(thread, entry.text),
// which rebuilt the attachment block from whatever was staged AT SEND TIME. A file staged after queueing went
// out with the held reply, and a file that was on the entry could be carried twice (once in the text the
// past_boundary steer path queued, once in the block sendReply recomputed).
//
// The six pieces this file drives, against the page's own functions over a small DOM model:
//   1. queueReply(thread, text, attachments) stores the entry's files and takes them out of the composer;
//   2. queueReplyFromBox reads the staged set BEFORE it clears the box, and the past_boundary steer path does
//      the same and keeps the reader's words as the text (no attachment block in it);
//   3. the ghost bubble draws the entry's chips under its prompt, with data-open-path, and no × of its own;
//   4. the × gives the files back to the composer the way it gives the text back to the draft;
//   5. an edit replaces the text only — the files stay on the entry;
//   6. the drain sends exactly the entry's files and neither reads nor clears a later staged file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const page = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = page("public/app.js");
const attachments = page("public/board/attachments.js");

// One top-level function from a classic script, by name. `async` is part of some of them, so the prefix is optional.
function grab(src, name) {
  const m = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(src);
  assert.ok(m, `the page carries ${name}()`);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is a top-level function`);
  return src.slice(start, end + 3);
}

const ATTACHMENT_NAMES = [
  "attachmentsFor",
  "setAttachments",
  "attachmentChipHtml",
  "attachmentChipsHtml",
  "attachmentChipsFor",
  "renderChips",
  "attachmentBlockFor",
  "attachmentBlock",
  "clearAttachments",
  "addAttachments",
];
const APP_NAMES = [
  "queueReply",
  "queueReplyFromBox",
  "queueWaitingOn",
  "queuePressInFlight",
  "queueWaitPhrase",
  "pressSettled",
  "paintQueueWait",
  "replyQueued",
  "ghostTurnHtml",
  "queuedEditFor",
  "takeQueuedReply",
  "saveQueuedEdit",
  "cancelQueuedReply",
  "heldReplyBlocked",
  "markReplySent",
  "replyTakenByDrain",
  "drainReplyQueue",
  "sendReply",
  "steerTurn",
];

const source = [...ATTACHMENT_NAMES.map((n) => grab(attachments, n)), ...APP_NAMES.map((n) => grab(app, n))].join("\n");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const CSS = { escape: (s) => String(s) };
const THREAD = "wtgui-queued-attachment-abc123";
const FILE = { name: "turnaround.txt", path: "attachments/1234-turnaround.txt", type: "text/plain", bytes: 2048 };
const LATER = { name: "later.md", path: "attachments/9999-later.md", type: "text/markdown", bytes: 128 };

// ---- a DOM small enough to see: elements found by the data- attributes the page asks for --------------------------
class El {
  constructor(dataset = {}, { tag = "DIV", value = "" } = {}) {
    this.dataset = dataset;
    this.tagName = tag;
    this.value = value;
    this.id = "";
    this._html = "";
    this._attrs = new Map();
    this.classList = {
      toggle: (name, on) => {
        const set = new Set(String(this.className || "").split(/\s+/).filter(Boolean));
        if (on) set.add(name);
        else set.delete(name);
        this.className = [...set].join(" ");
      },
    };
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
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
  }
  focus() {}
  closest() {
    return null;
  }
}

const datasetKey = (attr) => attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function harness({ box = "", staged = [] } = {}) {
  const nodes = [];
  const doc = {
    nodes,
    querySelector(sel) {
      const want = [...sel.matchAll(/\[data-([\w-]+)="([^"]*)"\]/g)].map((m) => [datasetKey(m[1]), m[2].replace(/\\(.)/g, "$1")]);
      if (!want.length) return null;
      return nodes.find((n) => want.every(([k, v]) => n.dataset[k] === v)) || null;
    },
    add(node) {
      nodes.push(node);
      return node;
    },
  };
  const replyBox = doc.add(new El({ reply: THREAD }, { tag: "TEXTAREA", value: box }));
  const chips = doc.add(new El({ chips: THREAD }));
  const calls = [];
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
    fmtDur: () => "2s",
    fmtBytes: (n) => `${n == null ? 0 : n} B`,
    linkifyText: (t) => esc(t),
    readBox: (el) => (el ? String(el.value) : ""),
    writeBox: (el, text) => {
      if (el) el.value = String(text == null ? "" : text);
    },
    clearBoxDraft: () => {},
    renderConversation: (thread) => renders.push(thread),
    subagentFallback: new Map(),
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
    apiFetch: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ job: { id: "job-1" } }) };
    },
    rememberReply: () => {},
    assistantSessionFor: () => null,
    updateJob: () => {},
    focusNewTurn: () => {},
    focusReplyBox: () => {},
    threadBusy: () => ctx.__busy,
    childrenOut: () => false,
    __busy: false,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  ctx.setAttachments(THREAD, staged);
  ctx.renderChips(THREAD);
  return Object.assign(ctx, { doc, nodes, replyBox, chips, calls, renders });
}

// Paths in the HOST realm: arrays built inside the vm carry the vm's Array prototype, which deepStrictEqual
// refuses to match against a host array even when the contents are identical.
const paths = (list) => Array.from(list || [], (a) => a.path);

// ---- 1. the queue takes the file with it -----------------------------------------------------------------------
test("queueing from the box stores the staged file on the entry and empties the composer's chip row", async () => {
  const h = harness({ box: "look at this", staged: [FILE] });
  assert.match(h.chips.innerHTML, /attach-chip/, "the composer is showing the chip before the press");

  assert.equal(await h.queueReplyFromBox(THREAD), true);

  const entry = h.replyQueued(THREAD)[0];
  assert.equal(entry.text, "look at this");
  assert.deepEqual(paths(entry.attachments), [FILE.path], "the entry owns the file");
  assert.deepEqual(paths(h.attachmentsFor(THREAD)), [], "and it is no longer staged in the composer");
  assert.equal(h.chips.innerHTML, "", "so the composer chip row is empty");
  assert.equal(h.replyBox.value, "", "the box itself is cleared, as before");

  const html = h.ghostTurnHtml(THREAD, entry, null, false);
  assert.ok(html.includes(`data-open-path="${FILE.path}"`), "the bubble's chip opens the same file");
  assert.ok(html.includes(`[${FILE.name}]`), "and carries the name the composer showed");
  assert.ok(html.indexOf("attach-chip") > html.indexOf("ghost-prompt"), "the chip is under the prompt text");
  assert.ok(!html.includes("chip-x"), "the bubble chip has no remove press: the entry's own × is what gives it back");
  assert.equal(html.split("attach-chip").length - 1, 1, "one file, one chip");
  assert.equal(html.split("ghost-prompt").length - 1, 1, "and the prompt is still drawn once");
});

test("queueReply takes only the files it was handed, leaving any other staged file where it was", () => {
  const h = harness({ staged: [FILE, LATER] });
  h.queueReply(THREAD, "one of them", [FILE]);
  assert.deepEqual(paths(h.replyQueued(THREAD)[0].attachments), [FILE.path]);
  assert.deepEqual(paths(h.attachmentsFor(THREAD)), [LATER.path], "the file this reply did not carry stays staged");
  assert.match(h.chips.innerHTML, /later\.md/, "and still has its chip");
});

// ---- 2. the past_boundary steer path ---------------------------------------------------------------------------
test("a steer held past the boundary takes the staged files with it and queues the reader's words only", async () => {
  const h = harness({ box: "steer this instead", staged: [FILE] });
  h.apiFetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, reason: "past_boundary", error: "the turn is past its last tool boundary" }),
  });

  assert.equal(await h.steerTurn(THREAD, "job-1", "steer this instead"), false);

  const entry = h.replyQueued(THREAD)[0];
  assert.equal(entry.text, "steer this instead", "the text is the reader's words, not the attachment block");
  assert.ok(!entry.text.includes("Attachment: "), "the block is not baked into the queued text");
  assert.deepEqual(paths(entry.attachments), [FILE.path], "the file is held on the entry");
  assert.deepEqual(paths(h.attachmentsFor(THREAD)), [], "and out of the composer");
  assert.equal(h.chips.innerHTML, "");
});

// ---- 3. cancel gives the file back the way it gives the text back ----------------------------------------------
test("the × puts the held file back on the composer beside the text returning as the draft", async () => {
  const h = harness({ box: "look at this", staged: [FILE] });
  await h.queueReplyFromBox(THREAD);
  const entry = h.replyQueued(THREAD)[0];
  assert.deepEqual(paths(h.attachmentsFor(THREAD)), [], "held, not staged");

  assert.equal(h.cancelQueuedReply(THREAD, entry.at), "cancelled");

  assert.equal(h.replyQueued(THREAD).length, 0, "the entry is gone");
  assert.equal(h.state.replyDrafts[THREAD], "look at this", "its text came back as the draft");
  assert.deepEqual(paths(h.attachmentsFor(THREAD)), [FILE.path], "and its file came back to the composer");
  assert.equal(h.chips.innerHTML.split("attach-chip").length - 1, 1, "one chip, not two");
});

test("a cancel into a box that already holds text leaves the composer's chips alone", async () => {
  const h = harness({ box: "first", staged: [FILE] });
  await h.queueReplyFromBox(THREAD);
  // The reader stages a new file and types something new before pressing the ×.
  h.replyBox.value = "a different message";
  h.setAttachments(THREAD, [LATER]);
  h.renderChips(THREAD);

  const entry = h.replyQueued(THREAD)[0];
  h.cancelQueuedReply(THREAD, entry.at);

  assert.equal(h.state.replyDrafts[THREAD], "", "the box was not empty, so the draft was not overwritten");
  assert.deepEqual(paths(h.attachmentsFor(THREAD)), [LATER.path], "the held file did not join a message being written");
  assert.match(h.chips.innerHTML, /later\.md/);
  assert.ok(!h.chips.innerHTML.includes("turnaround.txt"));
});

// ---- 4. an edit replaces the text only -------------------------------------------------------------------------
test("saving an edit changes the text and keeps the entry's file", async () => {
  const h = harness({ box: "look", staged: [FILE] });
  await h.queueReplyFromBox(THREAD);
  const entry = h.replyQueued(THREAD)[0];
  h.__busy = true; // the turn is live: the save must not drain

  h.state.replyEdit = { thread: THREAD, at: entry.at, original: entry.text, text: entry.text };
  h.doc.add(new El({ editQueued: String(entry.at), editThread: THREAD }, { tag: "TEXTAREA", value: "look again, carefully" }));
  assert.equal(h.saveQueuedEdit(THREAD, entry.at), true);

  const edited = h.replyQueued(THREAD)[0];
  assert.equal(edited.at, entry.at, "the edit is the same entry, not a new one");
  assert.equal(edited.text, "look again, carefully");
  assert.deepEqual(paths(edited.attachments), [FILE.path], "and its file is untouched");
  assert.deepEqual(paths(h.attachmentsFor(THREAD)), [], "the composer still does not hold it");

  const html = h.ghostTurnHtml(THREAD, edited, null, false);
  assert.ok(html.includes(`data-open-path="${FILE.path}"`), "the bubble still shows the file after the edit");
});

// ---- 5. the drain sends exactly the entry's file ----------------------------------------------------------------
test("the drain sends the entry's own file once and leaves a file staged later on the composer", async () => {
  const h = harness({ staged: [FILE] });
  h.queueReply(THREAD, "send the turnaround", [FILE]);
  // Staged AFTER the reply was held: this belongs to the next message and must not travel or be cleared.
  h.setAttachments(THREAD, [LATER]);
  h.renderChips(THREAD);

  await h.drainReplyQueue(THREAD);

  assert.equal(h.calls.length, 1, "one send");
  const body = h.calls[0].body;
  assert.equal(body.thread, THREAD);
  assert.equal(body.text.startsWith("send the turnaround"), true);
  assert.equal(body.text.split(FILE.path).length - 1, 1, "the entry's path appears exactly once in the text");
  assert.ok(!body.text.includes(LATER.path), "the later staged file is not in the held reply");
  assert.deepEqual(paths(body.attachments), [FILE.path], "the route receives exactly the entry's file");
  assert.deepEqual(paths(h.attachmentsFor(THREAD)), [LATER.path], "and the later staged file is still staged");
  assert.equal(h.chips.innerHTML.split("attach-chip").length - 1, 1);
  assert.ok(h.chips.innerHTML.includes(LATER.path));
  assert.equal(h.replyQueued(THREAD).length, 0, "the entry left the queue");
});
