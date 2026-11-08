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
const cards = readFileSync(new URL("../public/queue-cards.js", import.meta.url), "utf8");
const region = sliceRegion(cards, "the queue sub-tab");

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
  // `/api/jobs` is answered here and kept out of `calls`: the queue painter asks for the agents' own statuses on its
  // own clock, and every count in this file is about the QUEUE reads the cache gate is responsible for. `jobCalls`
  // is what the run-status read is judged by instead.
  const jobCalls = [];
  const apiFetch = (url) => {
    if (String(url).startsWith("/api/jobs")) {
      jobCalls.push(url);
      return Promise.resolve(reply({ jobs: [] }));
    }
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
    `${region}
return { renderAssistantQueue, loadQueue, queuePaneState, queueStateHtml, queueCache, queueInflight, queueJobs, queueShown, queueWindowOf, queueWindowIds, queueWindowRows, queueMoreHtml };`,
  )(
    esc,
    () => ["assistant-1", "assistant-2"],
    (id) => ({ id, name: id === "assistant-1" ? "Assistant #1" : "Assistant #2" }),
    (t) => t,
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
    (id) => ["assistant-1", "assistant-2"].includes(String(id)),
  );
  return { api, calls, jobCalls, state, host: (id = "assistant-1") => hostFor(id) };
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
  assert.match(html, /<dt>Move<\/dt><dd>the control on an existing row/, "and that moving work is the explicit action on a task");
  // A handler that still read a control the pane no longer draws would throw on the first press, so the page must not
  // name the picker at all.
  assert.doesNotMatch(assistant, /as-qowner/, "nothing in the page still looks for the owner picker");
  assert.match(assistant, /owner: own,/, "and the add sends the page's own assistant as the owner");
});

// The explainer's SHAPE. It was one nine-line paragraph with <b> sprinkled through it; the rewrite is a one-line lead
// and five labelled entries in a real <dl>. Every fact the paragraph carried has to survive that re-shape, so the
// facts are pinned here by the words that state them — a shorter rewrite that drops one is a red test, not a tidy-up.
test("the explainer is a lead and five labelled lines, every fact kept", async () => {
  const { api, host } = pane({ read: async () => reply({ queue: view(), assistant: {} }) });
  api.renderAssistantQueue("assistant-1", true);
  const html = host().innerHTML;
  const help = html.slice(html.indexOf('<div class="as-help">'), html.indexOf("</details>", html.indexOf('<div class="as-help">')));

  assert.match(help, /<p class="as-qlead">the work this assistant is carrying — queued, running on its thread, parked, done — and how it gets in and out\.<\/p>/, "one sentence of lead");
  assert.equal(help.split("<dt>").length - 1, 5, "five labelled lines");
  assert.deepEqual([...help.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ["Add task", "Move", "Order", "Waiting and STALE", "Where it lives"]);
  assert.doesNotMatch(help, /<b>/, "the labels are <dt>s, not bold inside another paragraph");
  for (const fact of [
    /the one this page belongs to/,
    /queue nobody is watching/,
    /leaves this queue/,
    /an id of its own/,
    /movedFrom/,
    /drag a queued card/i,
    /written to the file/,
    /survives the next read/,
    /running, parked and done keep their own sections/i,
    /held by #N/,
    /cannot go above that row/,
    /touch a running task's files/,
    /skipped with its reason/,
    /no live run reads STALE/,
    /phantom progress/,
    /<code>state\/assistants\/assistant-1\/queue\.json<\/code>/,
    /beside the charter/,
    /every wake before the board/,
    /state, thread, worktree, PR/,
    /LIVE, STALE or PARKED/,
  ]) {
    assert.match(help, fact, `the rewrite dropped a fact: ${fact}`);
  }
});

// The pane's way into Settings → Pipeline: the same class the pane already styles, beside Refresh, and the press is
// the settings tab strip's own two calls. The outside-click closer is the trap (app.js closes Settings on a click
// that did not land inside it), so the opener stops propagating exactly as #btn-settings does.
test("the qline's Pipeline button is the quiet class beside Refresh, and presses the tab strip's own two calls", async () => {
  const { api, host } = pane({ read: async () => reply({ queue: view(), assistant: {} }) });
  api.renderAssistantQueue("assistant-1", true);
  const html = host().innerHTML;
  assert.match(html, /data-as-qact="reload"[^>]*>Refresh<\/button>\s*<button type="button" class="as-qquiet" data-as-qact="pipeline"/, "immediately after Refresh, in the existing quiet class");
  assert.match(html, /class="as-qquiet" data-as-qact="pipeline" data-as-qown="assistant-1"[^>]*>Pipeline settings<\/button>/, "and it belongs to this pane's assistant");
  assert.doesNotMatch(html, /as-qpipeline/, "no new class was invented for it");
  const handler = assistant.slice(assistant.indexOf('if (action === "pipeline")'));
  const body = handler.slice(0, handler.indexOf('if (action === "add")'));
  assert.match(body, /e\.stopPropagation\(\);/, "the press stops before app.js's outside-click closer");
  assert.match(body, /toggleSettings\(true\);/, "and opens a closed Settings");
  assert.match(body, /selectSettingsTab\("pipeline"\);/, "on the Pipeline tab, with the tab strip's own call");
});

// The window: a queue can hold 200 tasks and the pane is repainted on every board tick and after every action, so it
// opens at the newest 20 and appends 50 per press. The count lives OUTSIDE the painter - that is the whole point: a
// repaint that started at 20 again would throw the reader back to the newest slice on the next tick.
test("the pane opens on the newest 20, appends 50 per press, and retires the control at the end", async () => {
  const tasks = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, title: `task ${i + 1}`, state: "done", files: [] }));
  const { api, host } = pane({ read: async () => reply({ queue: view({ tasks, counts: { total: 120, done: 120 } }), assistant: {} }) });
  const render = () => api.renderAssistantQueue("assistant-1");
  const rows = () => [...host().innerHTML.matchAll(/data-as-qrow="(\d+)"/g)].map((m) => Number(m[1]));
  api.renderAssistantQueue("assistant-1", true);
  await api.queueInflight.get("assistant-1");
  assert.equal(rows().length, 20, "twenty rows on open");
  assert.deepEqual([...rows()].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => 101 + i), "and they are the NEWEST twenty ids");
  assert.deepEqual(rows().slice(0, 3), [120, 119, 118], "the finished history reads newest first");
  assert.deepEqual(rows().slice(-2), [102, 101], "down to the oldest row the window carries");
  assert.match(host().innerHTML, /data-as-qact="more"[^>]*>Load 50 more</, "one control appends the next slice");
  assert.match(host().innerHTML, /100 older tasks not shown/, "and says how much it is still hiding");
  // The press the delegated handler makes: 50 more, from the same cache. `queueShown` is the record a repaint reads.
  const press = () => {
    api.queueShown.set("assistant-1", api.queueWindowOf("assistant-1") + 50);
    render();
  };
  render();
  render();
  assert.equal(rows().length, 20, "a repaint that is not the press keeps the window");
  press();
  assert.equal(rows().length, 70, "one press appends fifty");
  assert.deepEqual(rows().slice(0, 2), [120, 119], "the rows already on screen keep their place");
  assert.deepEqual(rows().slice(-2), [52, 51], "and the fifty older tasks land under them");
  render();
  assert.equal(rows().length, 70, "and the next repaint keeps them");
  press();
  assert.equal(rows().length, 120, "the second press reaches the end of the list");
  assert.doesNotMatch(host().innerHTML, /data-as-qact="more"/, "the control retires at the end");
  render();
  assert.equal(rows().length, 120, "and the retirement survives a repaint");
  assert.doesNotMatch(host().innerHTML, /data-as-qact="more"/, "with no control back");
});

test("the more press is the delegated handler's own window write, not a route", () => {
  const handler = assistant.slice(assistant.indexOf('if (action === "more")'), assistant.indexOf('if (action === "pipeline")'));
  assert.match(handler, /queueShown\.set\(own, queueWindowOf\(own\) \+ QUEUE_MORE\)/, "the press grows the stored window");
  assert.match(handler, /renderAssistantQueue\(own, true\)/, "and forces a repaint past the focused button it was pressed on");
  assert.doesNotMatch(handler, /apiFetch|queueAct|await /, "the press itself owes no request and no state write");
});
