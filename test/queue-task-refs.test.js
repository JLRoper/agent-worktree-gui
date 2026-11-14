// WHOSE TASK IS `#405` - the page's answer, and what a press on a reference does when the row is not where the pane
// is looking.
//
// public/queue-cards.js owns two answers, and this pins them apart:
//
//   taskOwnerOf(id)   read at RENDER time, when the console turns `#405` into an anchor. Each assistant's queue
//                     numbers its own tasks, so two queues can both hold a 405: exactly one owner answers, and none
//                     or two answer null - the transcript then keeps the plain words it had rather than guessing.
//   queueOpenTask()   read at PRESS time. The row may be in the queue but outside the window the pane draws, or in a
//                     queue this tab has not read; the window widens to it, or ONE read is made and the row looked up
//                     again, and a row that is still missing leaves a sentence instead of a press that did nothing.
//
// The page's own region is run against stubs, the way assistant-queue-pane.test.js runs the pane: the same source the
// browser loads, with the page's six helpers handed in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const cards = readFileSync(new URL("../public/queue-cards.js", import.meta.url), "utf8");
const region = sliceRegion(cards, "the queue sub-tab");

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const task = (id, extra = {}) => ({
  id,
  state: "queued",
  title: `task ${id}`,
  place: 0,
  files: [],
  agents: [],
  notes: [],
  detail: "",
  ...extra,
});
const viewOf = (assistantId, tasks = []) => ({
  assistantId,
  name: assistantId === "assistant-1" ? "Assistant #1" : "Assistant #2",
  thread: `panel-${assistantId}`,
  // Where the panel keeps this assistant's queue, relative to its own state dir: the fixture is a path the page reads,
  // not a folder on the machine that wrote this test.
  file: `state/assistants/${assistantId}/queue.json`,
  found: true,
  error: null,
  tasks,
  counts: {},
  digest: [],
});

// A drawn row: the press may centre it in a scroller (here `closest` says it is not in a queue pane, so the press
// falls back to scrollIntoView, which is recorded) and it pulses it. `sink` collects the scroll calls.
const rowNode = (sink = [], extra = {}) => ({
  scrollTop: 0,
  clientHeight: 400,
  scrollHeight: 1600,
  offsetHeight: 60,
  getBoundingClientRect: () => ({ top: 500 }),
  closest: () => null,
  scrollIntoView: (opts) => sink.push(opts),
  classList: { add() {}, remove() {} },
  ...extra,
});

// The pane's own region, run against the page: a fetch, the tab record, a host per pane, and the DOM calls the press
// makes (a scroll, an animation, a note). Everything the browser would do to a real row is recorded, not performed.
function page({ read, rows = new Map() }) {
  const calls = [];
  const dispatched = [];
  const flashed = [];
  const state = { assistant: { assistantId: "assistant-1" }, assistantView: { subTab: "queue", assistant: "assistant-1" } };
  // The row the press looks for: one object per "<own>:<id>", handed back by the pane's host when it is drawn.
  const hostFor = (id) => ({
    id,
    innerHTML: "",
    querySelector(sel) {
      const m = /data-as-qrow="([^"]+)"/.exec(sel);
      const row = m ? rows.get(`${id}:${m[1]}`) : null;
      return row || null;
    },
  });
  const apiFetch = (url) => {
    if (String(url).startsWith("/api/jobs")) return Promise.resolve(reply({ jobs: [] }));
    calls.push(url);
    return read(url);
  };
  const api = new Function(
    "esc",
    "assistantIds",
    "sessionById",
    "assistantThreadName",
    "hostFor",
    "paneIdFor",
    "typingInside",
    "state",
    "apiFetch",
    "applyAssistant",
    "setErr",
    "asPost",
    "as$",
    "activeSessionId",
    "isAssistant",
    "document",
    "CustomEvent",
    "CSS",
    "restartClassAnimation",
    "flashRowMs",
    "setTimeout",
    "clearTimeout",
    `${region}
return {
  renderAssistantQueue, loadQueue, queueCache, queueInflight, queueWindowOf, queueShown,
  taskOwnerOf, taskIndexRev, ensureTaskIndex, queueOpenTask, queueDropNotes,
};`,
  )(
    esc,
    () => ["assistant-1", "assistant-2"],
    (id) => ({ id, name: `Assistant ${id}`, threadId: `panel-${id}` }),
    (t) => t,
    hostFor,
    (id, kind) => `as-${kind}-${id}`,
    () => false,
    state,
    apiFetch,
    () => {},
    () => {},
    async () => ({}),
    () => null,
    () => "assistant-1",
    (id) => ["assistant-1", "assistant-2"].includes(String(id)),
    { dispatchEvent: (e) => dispatched.push(e) },
    class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    { escape: (s) => String(s) },
    (el, cls) => flashed.push({ el, cls }),
    () => 900,
    () => 0,
    () => {},
  );
  return {
    api,
    calls,
    dispatched,
    state,
    flashed,
    row: (own, id) => rows.get(`${own}:${id}`),
    hosts: hostFor,
  };
}

test("an id one queue owns is placed; an id nobody owns, or two queues both own, is not", async () => {
  const one = task(405);
  const two = task(405);
  const p = page({
    read: async (url) => {
      if (String(url).includes("assistantId=assistant-1")) return reply({ queue: viewOf("assistant-1", [one]), assistant: {} });
      return reply({ queue: viewOf("assistant-2", [two, task(406)]), assistant: {} });
    },
  });
  await p.api.loadQueue("assistant-1");
  assert.equal(p.api.taskOwnerOf("405"), "assistant-1", "the only queue holding 405 answers for it");
  assert.equal(p.api.taskOwnerOf("406"), null, "an id no loaded queue holds is not placed");
  await p.api.loadQueue("assistant-2");
  assert.equal(p.api.taskOwnerOf("405"), null, "two queues both hold a 405: no guess");
  assert.equal(p.api.taskOwnerOf("406"), "assistant-2", "and the id only one queue holds is still placed");
  assert.equal(p.api.taskOwnerOf(""), null);
});

test("the index reads every queue ONCE, fills the caches, and says so", async () => {
  const p = page({
    read: async (url) => {
      if (String(url) === "/api/assistant/queue") {
        return reply({ queues: [viewOf("assistant-1", [task(405)]), viewOf("assistant-2", [task(406)])] });
      }
      throw new Error(`unexpected read ${url}`);
    },
  });
  const changed = await p.api.ensureTaskIndex();
  assert.equal(changed, true, "the answer filled two caches");
  assert.equal(p.calls.length, 1, "one read for every queue");
  assert.equal(p.dispatched.length, 1, "and one word to the page that it placed something new");
  assert.equal(p.api.taskOwnerOf("405"), "assistant-1");
  assert.equal(p.api.taskOwnerOf("406"), "assistant-2");
  // The throttle: a second ask inside the window joins nothing and starts no second read.
  await p.api.ensureTaskIndex();
  assert.equal(p.calls.length, 1, "the index is not re-read on every paint");
});

test("a cached queue is not replaced by the index answer - the pane's own read is what the reader sees", async () => {
  const p = page({
    read: async (url) => {
      if (String(url).includes("assistantId=assistant-1")) return reply({ queue: viewOf("assistant-1", [task(405)]), assistant: {} });
      return reply({ queues: [viewOf("assistant-1", [task(999)]), viewOf("assistant-2", [task(406)])] });
    },
  });
  await p.api.loadQueue("assistant-1");
  await p.api.ensureTaskIndex();
  assert.equal(p.api.taskOwnerOf("405"), "assistant-1", "the loaded queue still owns 405");
  assert.equal(p.api.taskOwnerOf("999"), null, "the index answer did not paint over a queue this tab holds");
  assert.equal(p.api.taskOwnerOf("406"), "assistant-2", "and the queue it DID fill is used");
});

test("a press widens the window to a row the pane had not drawn", async () => {
  // 405 is older than the pane's first 20 rows: it is in the queue, and not in the window. The host draws the row
  // only when the window covers it - exactly what the pane does - so the press has to widen the window first.
  const tasks = Array.from({ length: 30 }, (_, i) => task(430 - i));
  const target = tasks[25]; // id 405
  const drawn = new Map([["assistant-1:405", rowNode()]]);
  const rows = { get: (key) => (p.api.queueWindowOf(key.split(":")[0]) >= 26 ? drawn.get(key) : null) };
  const p = page({ rows, read: async () => reply({ queue: viewOf("assistant-1", tasks), assistant: {} }) });
  await p.api.loadQueue("assistant-1");
  assert.equal(p.api.queueWindowOf("assistant-1"), 20, "the pane opens on its first window");
  const found = await p.api.queueOpenTask("assistant-1", String(target.id));
  assert.equal(found, true, "the row was found once the window widened");
  assert.equal(p.api.queueWindowOf("assistant-1"), 26, "widened to exactly the target, no wider");
  assert.equal(p.flashed.length, 1, "and the green pulse was started on it");
  assert.equal(p.flashed[0].cls, "flash");
  assert.equal(p.calls.length, 1, "no extra read: the queue was already here");
});

test("a press on a queue this tab has not read makes ONE read, then finds the row", async () => {
  const drawn = new Map([["assistant-2:405", rowNode()]]);
  // The row is on screen only once the read has landed: before that the press has nothing to look at.
  let painted = false;
  const p = page({
    rows: { get: (k) => (painted ? drawn.get(k) : null) },
    read: async () => {
      painted = true;
      return reply({ queue: viewOf("assistant-2", [task(405)]), assistant: {} });
    },
  });
  const found = await p.api.queueOpenTask("assistant-2", "405");
  assert.equal(found, true);
  assert.equal(p.calls.length, 1, "exactly one read");
  assert.equal(p.flashed.length, 1);
});

test("a press whose row is really gone leaves a sentence, not a press that did nothing", async () => {
  const p = page({ read: async () => reply({ queue: viewOf("assistant-1", [task(405)]), assistant: {} }) });
  const found = await p.api.queueOpenTask("assistant-1", "999");
  assert.equal(found, false);
  assert.match(p.api.queueDropNotes.get("assistant-1"), /#999 is not in it/, "the pane says which id is missing");
  assert.equal(p.flashed.length, 0, "nothing was pulsed");
});
