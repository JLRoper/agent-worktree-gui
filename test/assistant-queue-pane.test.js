// The Queue sub-tab's PANE — what a reader sees when there is nothing to list, and what a paint is allowed to spend.
//
// The pane has four states and one rule about requests. The states, in the order the painter decides them:
//
//   error    the read failed (or the file could not be parsed) — the reason and a Retry, never a spinner;
//   missing  state/assistants/<id>/queue.json does not exist yet (`found: false`) — "no queue yet — Add task
//            creates it", because "(empty)" and "no file" are different facts and only one of them is a bug;
//   loading  a read is in flight and there is nothing cached yet — "reading its queue…";
//   ready    rows, or "(empty — this assistant is carrying nothing)".
//
// The rule is single-flight: a paint may ask for a read, and only ONE read per assistant may be in flight. The defect
// this pins is the spinner that never stopped — `loadQueue`'s `.finally()` repainted with `force = true`, a forced
// repaint calls `loadQueue` again, and every superseded answer was then dropped by the sequence guard, so the pane
// read "reading its queue…" for as long as the tab was open. A read's own completion must repaint WITHOUT force.
//
// The add form is the third thing here: no owner picker. A task is created into the assistant whose page it is, and
// the only way work changes hands is the explicit Move control on an existing row (pinned in assistant-queue-ui).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const region = sliceRegion(assistant, "the queue sub-tab");

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const QUEUE_FILE = "C:/panel/state/assistants/assistant-1/queue.json";
const view = (extra = {}) => ({
  assistantId: "assistant-1",
  name: "Assistant #1",
  thread: "panel-assistant-1",
  file: QUEUE_FILE,
  found: true,
  error: null,
  tasks: [],
  counts: {},
  digest: [],
  ...extra,
});

// The page's own region, run against the six things it asks of the page: a host per pane, the tab record, the fetch,
// and three no-ops. `queueInflight` is returned so a test can await the read a paint started instead of guessing at a
// timer — the same map the painter's single-flight guard reads.
function pane({ read }) {
  const hosts = new Map();
  const calls = [];
  const state = { assistant: { assistantId: "assistant-1" }, assistantView: { subTab: "queue", assistant: "assistant-1" } };
  const hostFor = (id) => {
    if (!hosts.has(id)) hosts.set(id, { id, innerHTML: "" });
    return hosts.get(id);
  };
  const apiFetch = (url) => {
    calls.push(url);
    return read(url);
  };
  const api = new Function(
    "esc",
    "assistantIds",
    "sessionById",
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
    `${region}
return { renderAssistantQueue, loadQueue, queuePaneState, queueStateHtml, queueCache, queueInflight };`,
  )(
    esc,
    () => ["assistant-1", "assistant-2"],
    (id) => ({ id, name: id === "assistant-1" ? "Assistant #1" : "Assistant #2" }),
    hostFor,
    (id, kind) => `as-${id}-${kind}`,
    () => false,
    state,
    apiFetch,
    () => {},
    () => {},
    async () => ({}),
    () => null,
    () => "assistant-1",
  );
  return { api, calls, state, host: (id = "assistant-1") => hostFor(id) };
}

test("a queue file that does not exist yet draws its own empty state, and the spinner stops", async () => {
  const { api, calls, host } = pane({ read: async () => reply({ queue: view({ found: false }), assistant: {} }) });
  api.renderAssistantQueue("assistant-1", true);
  assert.match(host().innerHTML, /reading its queue…/, "the first paint says it is reading");
  await api.queueInflight.get("assistant-1");
  const html = host().innerHTML;
  assert.doesNotMatch(html, /reading its queue…/, "the answer clears the spinner");
  assert.match(html, /no queue yet — <b>Add task<\/b> creates it/, "an absent store gets its own sentence, not an empty list");
  assert.match(html, /as-qstate-1/, "in the pane's own state slot");
  assert.match(html, new RegExp(QUEUE_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and it names the file that will be created");
  assert.equal(calls.length, 1, "one read, for the one paint that asked");
  assert.equal(api.queueCache.get("assistant-1").loading, false, "and the cache is not left reading");
});

test("three forced paints start ONE read, and the read's own repaint starts none", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { api, calls, host } = pane({
    read: async () => {
      await gate;
      return reply({ queue: view({ tasks: [{ id: 1, title: "carry it", state: "queued", owner: "assistant-1", files: [] }], counts: { queued: 1 } }), assistant: {} });
    },
  });
  api.renderAssistantQueue("assistant-1", true);
  api.renderAssistantQueue("assistant-1", true);
  api.renderAssistantQueue("assistant-1", true);
  assert.equal(calls.length, 1, "a paint that lands while a read is in flight joins it");
  release();
  await api.queueInflight.get("assistant-1");
  assert.equal(calls.length, 1, "the read's own repaint does not re-arm the read that just finished");
  for (let i = 0; i < 5; i += 1) api.renderAssistantQueue("assistant-1");
  assert.equal(calls.length, 1, "and neither do the board's polls, once the answer is cached");
  assert.match(host().innerHTML, /#1<\/b>/, "the row the answer brought is on the pane");
});

test("a read for one assistant does not stand in for another's", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { api, calls, host } = pane({
    read: async (url) => {
      if (url.includes("assistant-1")) await gate;
      const id = url.includes("assistant-2") ? "assistant-2" : "assistant-1";
      return reply({ queue: view({ assistantId: id, found: false, file: `C:/panel/state/assistants/${id}/queue.json` }), assistant: {} });
    },
  });
  api.renderAssistantQueue("assistant-1", true);
  api.renderAssistantQueue("assistant-2", true);
  assert.equal(calls.length, 2, "two assistants, two reads — the guard is per id");
  release();
  await Promise.all([api.queueInflight.get("assistant-1"), api.queueInflight.get("assistant-2")]);
  assert.match(host("assistant-2").innerHTML, /assistant-2\/queue.json/, "#2's pane is painted from #2's answer");
});

test("a read that fails draws the error and a Retry, not a spinner that never ends", async () => {
  const { api, calls, host } = pane({
    read: async () => {
      throw new Error("HTTP 500");
    },
  });
  api.renderAssistantQueue("assistant-1", true);
  await api.queueInflight.get("assistant-1");
  const html = host().innerHTML;
  assert.doesNotMatch(html, /reading its queue…/, "the failure is a state, not a spinner");
  assert.match(html, /could not read its queue — HTTP 500/, "and it says what failed");
  assert.match(html, /data-as-qact="reload"[^>]*>Retry</, "with the Retry the reader presses to try again");
  assert.equal(calls.length, 1, "a failed read does not re-arm itself either");
});

test("a queue file that is there but unparseable reads as an error, not as an empty queue", async () => {
  const { api, host } = pane({ read: async () => reply({ queue: view({ found: false, error: "Unexpected token < in JSON" }), assistant: {} }) });
  api.renderAssistantQueue("assistant-1", true);
  await api.queueInflight.get("assistant-1");
  assert.match(host().innerHTML, /could not read its queue — Unexpected token/);
  assert.match(host().innerHTML, />Retry</);
});

test("the add form has no owner picker: a task is created into the assistant whose page it is", async () => {
  const { api, host } = pane({ read: async () => reply({ queue: view(), assistant: {} }) });
  api.renderAssistantQueue("assistant-1", true);
  const html = host().innerHTML;
  assert.doesNotMatch(html, /as-qowner/, "no owner select on the add form");
  assert.doesNotMatch(html, /<label[^>]*>\s*owner\b/, "and no owner label either");
  assert.match(html, /data-as-qact="add"/, "Add task is still the one control that creates a task");
  assert.match(html, /files work into THIS assistant's queue/, "the help says where the work goes");
  assert.match(html, /the <b>Move<\/b> control on an existing row/, "and that moving work is the explicit action on a task");
  // A handler that still read a control the pane no longer draws would throw on the first press, so the page must not
  // name the picker at all.
  assert.doesNotMatch(assistant, /as-qowner/, "nothing in the page still looks for the owner picker");
  assert.match(assistant, /owner: own,/, "and the add sends the page's own assistant as the owner");
});
