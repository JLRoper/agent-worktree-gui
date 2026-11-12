// Undo and redo for what the composer's pastes put there, without taking ordinary typing's undo away.
//
// WHY THIS FILE EXISTS. A chip is a PROGRAMMATIC write: board/paste-chips.js inserts the atom itself and
// board/attachments.js draws the file chip above the box. The editing engine never saw either write, so its
// own undo stack cannot step over them and Ctrl+Z after a paste did nothing at all. The composer keeps its
// own bounded stack of the writes it made, and these cases state the gestures in keys, through the modules'
// own document listeners:
//
//   1. paste a block, Ctrl+Z: the chip goes, the box reads exactly what it read before the paste, and the
//      pasted text leaves the panel's state with it;
//   2. paste a file, Ctrl+Z: the attachment chip leaves the composer and the file is no longer staged;
//   3. undo then redo, with Ctrl+Shift+Z and with Ctrl+Y: the same chip comes back by id, with its text;
//   4. Ctrl+Backspace and Ctrl+Delete keep the behaviour #82 gave them, and record nothing on the stack;
//   5. ordinary typing keeps the engine's own undo: once the reader has typed in that box the paste entry is
//      stale, so Ctrl+Z is NOT taken and the chip the reader typed around stays exactly where it is.
//
// Cases 1-3 and 5 fail before the stack exists (there is nothing to undo, and Ctrl+Z is never taken); case 4
// fails on its own stack assertions for the same reason, and passes on the #82 outcomes either way.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createDom } from "./fixtures/mini-dom.js";

const page$ = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ATTACHMENTS = page$("public/board/attachments.js");
const PASTE_CHIPS = page$("public/board/paste-chips.js");
const PASTE = Array.from({ length: 6 }, (_, i) => `pasted line ${i + 1} of the block`).join("\n");
const THREAD = "wtgui-probe-undo-5480fc";
const FILE = { name: "turnaround.txt", path: "attachments/1234-turnaround.txt", type: "text/plain", size: 2048, bytes: 2048 };

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// One page's worth of both modules: their own document, their own selection, one selection, and the state the
// panel would hold. attachments.js is loaded first, exactly as public/index.html loads it.
function page() {
  const dom = createDom();
  const state = { pasteChips: new Map(), boxModels: new Map(), pasteChipSeq: 0, replyAttachments: new Map() };
  const store = new Map();
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const uploads = [];
  const sandbox = {
    document: dom.document,
    window: dom.window,
    state,
    sessionStorage,
    Event: dom.MiniEvent,
    setTimeout,
    clearTimeout,
    console,
    esc,
    CSS: { escape: (s) => String(s) },
    fmtBytes: (n) => `${n == null ? 0 : n} B`,
    $: (id) => dom.document.getElementById(id) || { textContent: "" },
    apiFetch: async (url) => {
      uploads.push(url);
      return { ok: true, status: 200, json: async () => ({ ...FILE }) };
    },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(ATTACHMENTS, ctx, { filename: "public/board/attachments.js" });
  vm.runInContext(PASTE_CHIPS, ctx, { filename: "public/board/paste-chips.js" });
  return { dom, ctx, state, document: dom.document, uploads };
}

// The worktree card's reply box, as render-jobs.js draws it: contenteditable, data-reply, and the chipbox name
// the composer's own stack is keyed by.
function replyBox(env, key = THREAD) {
  const box = env.document.createElement("div");
  box.className = "reply-box chipbox";
  box.setAttribute("contenteditable", "true");
  box.setAttribute("data-reply", key);
  box.setAttribute("data-chipbox", `reply:${key}`);
  env.document.body.appendChild(box);
  return box;
}

// The chip row above it, where board/attachments.js draws a pasted file.
function chipsRow(env, key = THREAD) {
  const row = env.document.createElement("div");
  row.className = "attach-chips";
  row.setAttribute("data-chips", key);
  env.document.body.appendChild(row);
  return row;
}

// A real paste event at the box, carrying plain text - the gesture the reader makes.
function pasteTextAt(env, box, text) {
  const ev = new env.dom.MiniEvent("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = { files: [], getData: () => text };
  box.dispatchEvent(ev);
  return ev;
}

// The same gesture carrying a FILE, which is board/attachments.js's paste: it uploads, then draws the chip.
function pasteFileAt(env, box, file) {
  const ev = new env.dom.MiniEvent("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = { files: [file], getData: () => "" };
  box.dispatchEvent(ev);
  return ev;
}

// The upload is a promise chain (fetch, then json): two macrotask turns let it finish.
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

// A real keydown at the box, with the modifiers held.
function keyAt(env, box, key, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
  const ev = new env.dom.MiniEvent("keydown", { bubbles: true, cancelable: true });
  ev.key = key;
  ev.ctrlKey = ctrl;
  ev.shiftKey = shift;
  ev.altKey = alt;
  ev.metaKey = meta;
  box.dispatchEvent(ev);
  return ev;
}

function typedBox(env, before = "Quote this: ") {
  const box = replyBox(env);
  env.ctx.writeBox(box, before);
  box.focus();
  env.ctx.setCaretOffset(box, env.ctx.readBox(box).length);
  return box;
}

const chipsOf = (box) => box.querySelectorAll(".paste-chip").length;
const chipIdOf = (box) => {
  const chip = box.querySelector(".paste-chip");
  return chip ? chip.dataset.pasteChip : null;
};

test("1. paste a block, Ctrl+Z: the chip goes and the box reads exactly what it read before", () => {
  const env = page();
  const box = typedBox(env);
  pasteTextAt(env, box, PASTE);
  assert.equal(env.ctx.readBox(box), `Quote this: ${PASTE}`, "the paste formed one chip that reads back as its text");
  assert.equal(chipsOf(box), 1, "one chip in the box, before the key is pressed");

  const ev = keyAt(env, box, "z", { ctrl: true });

  assert.equal(env.ctx.readBox(box), "Quote this: ", "the box is back to the text it held before the paste");
  assert.equal(chipsOf(box), 0, "the chip is gone from the box");
  assert.equal(env.state.pasteChips.size, 0, "and the pasted text left the panel's state with it");
  assert.equal(env.state.boxModels.size, 0, "the panel's model for the box follows: there is no chip to replay");
  assert.equal(ev.defaultPrevented, true, "the composer took the press, so the browser's own undo did not also run");
});

test("2. paste a file, Ctrl+Z: the attachment chip leaves the composer and the file is no longer staged", async () => {
  const env = page();
  const box = replyBox(env);
  const row = chipsRow(env);
  pasteFileAt(env, box, FILE);
  await flush();

  assert.equal(env.ctx.attachmentsFor(THREAD).length, 1, "the file is staged on the composer");
  assert.match(row.innerHTML, /attach-chip/, "and it is drawn as a chip above the box");
  const before = env.ctx.readBox(box);

  const ev = keyAt(env, box, "z", { ctrl: true });

  assert.equal(env.ctx.attachmentsFor(THREAD).length, 0, "the file is no longer staged on the composer");
  assert.equal(row.innerHTML, "", "the chip is off the composer");
  assert.equal(env.ctx.readBox(box), before, "and the text of the draft is exactly what it was");
  assert.equal(ev.defaultPrevented, true, "the composer took the press");

  const again = keyAt(env, box, "z", { ctrl: true });
  assert.equal(again.defaultPrevented, false, "with nothing left to step back over, Ctrl+Z is the engine's again");
});

test("3. undo then redo: Ctrl+Shift+Z and Ctrl+Y put the same chip back", () => {
  const env = page();
  const box = typedBox(env);
  pasteTextAt(env, box, PASTE);
  const id = chipIdOf(box);
  assert.ok(id, "the paste left a chip to step back over");

  assert.equal(keyAt(env, box, "z", { ctrl: true }).defaultPrevented, true, "Ctrl+Z undid the paste");
  assert.equal(chipsOf(box), 0, "the chip is gone");
  assert.equal(env.ctx.composerActionDepth(box), 0, "and the undo side of the stack is empty");

  const redo = keyAt(env, box, "Z", { ctrl: true, shift: true });

  assert.equal(redo.defaultPrevented, true, "Ctrl+Shift+Z was taken by the composer");
  assert.equal(env.ctx.readBox(box), `Quote this: ${PASTE}`, "the pasted block is back in place");
  assert.equal(chipsOf(box), 1, "as a chip again");
  assert.equal(chipIdOf(box), id, "the same chip, by id, so the panel's state and the DOM still agree");

  assert.equal(keyAt(env, box, "z", { ctrl: true }).defaultPrevented, true, "Ctrl+Z undoes it a second time");
  assert.equal(chipsOf(box), 0, "the chip is gone again");
  const again = keyAt(env, box, "y", { ctrl: true });
  assert.equal(again.defaultPrevented, true, "Ctrl+Y is the redo half as well");
  assert.equal(chipsOf(box), 1, "and the chip is back");
  assert.equal(chipIdOf(box), id, "the same chip again");
});

test("4. Ctrl+Backspace and Ctrl+Delete keep #82's behaviour, and record nothing on the stack", () => {
  const env = page();
  const box = typedBox(env);
  pasteTextAt(env, box, PASTE);
  assert.equal(env.ctx.composerActionDepth(box), 1, "the paste recorded exactly one action");
  env.ctx.setCaretOffset(box, "Quote this: ".length + PASTE.length);

  const ev = keyAt(env, box, "Backspace", { ctrl: true });

  assert.equal(env.ctx.readBox(box), "Quote this: ", "Ctrl+Backspace beside the chip took the chip and nothing else");
  assert.equal(chipsOf(box), 0, "the chip is gone");
  assert.equal(env.state.pasteChips.size, 0, "and its text left the panel's state");
  assert.equal(ev.defaultPrevented, true, "the #82 branch handled the press, not the undo branch");
  assert.equal(env.ctx.composerActionDepth(box), 1, "a word delete records no action of its own");

  const z = keyAt(env, box, "z", { ctrl: true });
  assert.equal(z.defaultPrevented, false, "the paste entry is stale now, so Ctrl+Z is left to the engine");
  assert.equal(chipsOf(box), 0, "and it did not bring the removed chip back");

  const forward = page();
  const fbox = typedBox(forward);
  pasteTextAt(forward, fbox, PASTE);
  forward.ctx.setCaretOffset(fbox, "Quote this: ".length);
  const del = keyAt(forward, fbox, "Delete", { ctrl: true });
  assert.equal(forward.ctx.readBox(fbox), "Quote this: ", "Ctrl+Delete before the chip takes that chip whole");
  assert.equal(chipsOf(fbox), 0, "the chip is gone");
  assert.equal(del.defaultPrevented, true, "and the #82 branch handled it");
});

test("5. ordinary typing keeps the engine's undo: a typed character makes the paste entry stale", () => {
  const env = page();
  const box = typedBox(env);
  pasteTextAt(env, box, PASTE);
  env.ctx.insertTextAt(box, " and this after");
  env.ctx.setCaretOffset(box, env.ctx.readBox(box).length);

  const ev = keyAt(env, box, "z", { ctrl: true });

  assert.equal(ev.defaultPrevented, false, "Ctrl+Z was left to the browser, which owns the typing");
  assert.equal(chipsOf(box), 1, "and the chip the reader typed around is untouched");
  assert.equal(env.ctx.readBox(box), `Quote this: ${PASTE} and this after`, "nothing was rewritten under the reader");
});

test("6. a cleared composer keeps no history: clearBoxDraft drops the entries it could not honour", () => {
  const env = page();
  const box = typedBox(env);
  pasteTextAt(env, box, PASTE);
  assert.equal(env.ctx.composerActionDepth(box), 1, "the paste is on the stack");

  env.ctx.clearBoxDraft(box);

  assert.equal(env.ctx.composerActionDepth(box), 0, "clearing the composer dropped it");
  const ev = keyAt(env, box, "z", { ctrl: true });
  assert.equal(ev.defaultPrevented, false, "so Ctrl+Z is the engine's again");
});

test("7. the stack is bounded: a long session keeps the last 24 inserts and forgets the rest", () => {
  const env = page();
  const box = typedBox(env, "");
  for (let i = 0; i < 30; i += 1) {
    env.ctx.setCaretOffset(box, env.ctx.readBox(box).length);
    pasteTextAt(env, box, `${PASTE}\nblock ${i + 1}`);
  }
  assert.equal(chipsOf(box), 30, "thirty pastes, thirty chips");
  assert.equal(env.ctx.composerActionDepth(box), 24, "and the stack holds the last 24 of them, not all thirty");
});
