// The message board's per-assistant split.
//
// Every entry carries an owner, decided in THIS order (the split's rule): the run's own `assistantId`, then the
// thread's owner, then Assistant #1. The tab then draws one payload twice: "All assistants" hides nothing, and a
// named chip is that assistant's split. The last section drives the shipped renderer out of public/assistant.js,
// because "a message from a #2 thread shows under #2 and under All" is a claim about the HTML.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { buildMessages } from "../lib/assistant/messages.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const T0 = 1_700_000_000_000;
const iso = (ms = 0) => new Date(T0 + ms).toISOString();
const IDS = [PRIMARY_ASSISTANT, "assistant-2", "assistant-3"];
const ASSISTANTS = [
  { id: "assistant-1", name: "Assistant #1", threadId: ASSISTANT_THREAD, rules: [] },
  { id: "assistant-2", name: "Assistant #2", threadId: threadFor("assistant-2"), rules: [] },
  { id: "assistant-3", name: "Assistant #3", threadId: threadFor("assistant-3"), rules: [] },
];

// The resolver lib/assistant.js hands buildMessages, spelled out here so the ORDER is the thing under test.
const ownerOf = (job, thread) => {
  const stamped = String(job?.assistantId || "").trim();
  if (stamped && IDS.includes(stamped)) return stamped;
  const byThread = ASSISTANTS.find((a) => a.threadId === thread)?.id;
  return byThread || PRIMARY_ASSISTANT;
};

const job = (over = {}) => ({
  id: "run",
  thread: "wtgui-worker",
  status: "done",
  prompt: "do the thing",
  startedAt: iso(0),
  endedAt: iso(60_000),
  runId: "r1",
  lines: [],
  ...over,
});

test("a message's owner is the job's stamp, then its thread's, then Assistant #1", () => {
  const now = T0 + 120_000;
  const board = buildMessages({
    summaries: [
      // 1. The run says whose it is: this is #2's, even though the worker thread belongs to nobody.
      job({ id: "stamped", thread: "wtgui-worker-1", prompt: "STAMPED-BY-TWO", assistantId: "assistant-2" }),
      // 2. No stamp, but the run is on #3's own thread: the thread answers.
      job({ id: "by-thread", thread: threadFor("assistant-3"), prompt: "ON-THREES-THREAD" }),
      // 3. A stamp naming an assistant this panel does not hold is not an owner; the thread is a worker's, so #1.
      job({ id: "bogus", thread: "wtgui-worker-2", prompt: "BOGUS-STAMP", assistantId: "assistant-99" }),
      // 4. The stamp OUTRANKS the thread, as the rule says: #3's turn handed to #2 is still #3's message.
      job({ id: "outranks", thread: threadFor("assistant-2"), prompt: "STAMP-WINS", assistantId: "assistant-3" }),
    ],
    assistantThread: ASSISTANT_THREAD,
    assistantThreads: ASSISTANTS.map((a) => a.threadId),
    ownerOf,
    now,
  });
  const owners = Object.fromEntries(
    board.groups.flatMap((g) => g.entries).filter((e) => e.dir === "out").map((e) => [e.text, e.assistantId]),
  );
  assert.deepEqual(owners, {
    "STAMPED-BY-TWO": "assistant-2",
    "ON-THREES-THREAD": "assistant-3",
    "BOGUS-STAMP": PRIMARY_ASSISTANT,
    "STAMP-WINS": "assistant-3",
  });
  assert.ok(board.groups.flatMap((g) => g.entries).every((e) => IDS.includes(e.assistantId)), "every entry has a real owner");
});

test("a journal-only line is attributed by the thread it names, and falls back to #1", () => {
  const now = T0 + 600_000;
  const board = buildMessages({
    summaries: [],
    journal: [
      { at: iso(0), kind: "said", thread: threadFor("assistant-2"), text: "SAID-BY-TWO" },
      { at: iso(1000), kind: "said", thread: null, text: "OLD-SAID-LINE" },
    ],
    assistantThread: ASSISTANT_THREAD,
    assistantThreads: ASSISTANTS.map((a) => a.threadId),
    ownerOf,
    now,
  });
  const byText = Object.fromEntries(board.groups.flatMap((g) => g.entries).map((e) => [e.text, e.assistantId]));
  assert.equal(byText["SAID-BY-TWO"], "assistant-2", "the line's own thread names its assistant");
  assert.equal(byText["OLD-SAID-LINE"], PRIMARY_ASSISTANT, "a line with no thread is the legacy #1 record");
});

async function panel(t, { rows = [], journal = [], assistants = ASSISTANTS } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-msg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal }));
  await writeFile(path.join(dir, "assistants.json"), JSON.stringify({ version: 1, assistants }));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => rows, get: (id) => rows.find((r) => r.id === id) || null, firstOfThread: () => null, create: async (b) => b },
    getProjects: () => [],
    onLog: () => {},
  });
  return { assistant, dir };
}

test("Assistant #2's thread carries its own messages through the real Assistant", async (t) => {
  const rows = [
    job({ id: "run-1", thread: ASSISTANT_THREAD, prompt: "PRIMARY-TURN", assistantId: PRIMARY_ASSISTANT, startedAt: iso(0) }),
    job({ id: "run-2", thread: threadFor("assistant-2"), prompt: "SECOND-TURN", assistantId: "assistant-2", startedAt: iso(1_000) }),
  ];
  const { assistant } = await panel(t, { rows });
  const board = assistant.messages({ now: T0 + 300_000 });
  const byText = Object.fromEntries(board.groups.flatMap((g) => g.entries).map((e) => [e.text, e.assistantId]));
  assert.equal(byText["PRIMARY-TURN"], PRIMARY_ASSISTANT);
  assert.equal(byText["SECOND-TURN"], "assistant-2", "the #2 thread's message belongs to #2");
});

// ---- the page: the Messages tab's all view and the #2 view --------------------------------

const page = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function boardWith(rows) {
  return buildMessages({
    summaries: rows,
    assistantThread: ASSISTANT_THREAD,
    assistantThreads: ASSISTANTS.map((a) => a.threadId),
    ownerOf,
    now: T0 + 300_000,
  });
}

async function messagesPane({ board, who = "all" }) {
  const host = { innerHTML: "", closest: () => null };
  const state = {
    assistant: { assistants: ASSISTANTS, notes: "" },
    assistantThread: ASSISTANT_THREAD,
    assistantView: { assistant: "messages" },
  };
  const sessionById = (id) => ASSISTANTS.find((a) => a.id === String(id || "")) || null;
  const assistantIds = () => ASSISTANTS.map((a) => a.id);
  const apiFetch = async () => ({ ok: true, json: async () => ({ messages: board }) });
  const api = new Function(
    "state",
    "as$",
    "esc",
    "relTime",
    "tailPath",
    "fmtBytes",
    "apiFetch",
    "assistantIds",
    "sessionById",
    "FIRST_ASSISTANT",
    `${sliceRegion(page, "messages")}
return {
  loadMessages,
  renderAssistantMessages,
  setWho: (v) => { msgWho = v; },
  setDir: (v) => { msgDir = v; },
};`,
  )(state, (id) => (id === "as-messages" ? host : null), esc, () => "1m", (p) => p, (n) => String(n), apiFetch, assistantIds, sessionById, PRIMARY_ASSISTANT);
  await api.loadMessages(true);
  api.setWho(who);
  api.renderAssistantMessages();
  return { host, api };
}

test("the Messages tab's All view hides nothing, and #2's view shows only #2's message", async () => {
  const board = boardWith([
    job({ id: "run-1", thread: ASSISTANT_THREAD, prompt: "PRIMARY-MESSAGE", assistantId: PRIMARY_ASSISTANT, status: "running", startedAt: iso(0) }),
    job({ id: "run-2", thread: threadFor("assistant-2"), prompt: "SECOND-MESSAGE", assistantId: "assistant-2", status: "running", startedAt: iso(1_000) }),
    job({ id: "run-3", thread: threadFor("assistant-3"), prompt: "THIRD-MESSAGE", assistantId: "assistant-3", status: "running", startedAt: iso(2_000) }),
  ]);

  const all = await messagesPane({ board, who: "all" });
  assert.match(all.host.innerHTML, /PRIMARY-MESSAGE/, "All shows #1's message");
  assert.match(all.host.innerHTML, /SECOND-MESSAGE/, "All shows #2's message");
  assert.match(all.host.innerHTML, /THIRD-MESSAGE/, "All shows #3's message");
  assert.match(all.host.innerHTML, /data-as-msgwho="all" aria-pressed="true"/, "All is the view that is on");
  assert.match(all.host.innerHTML, /every assistant, nothing hidden/, "and it says so");

  const two = await messagesPane({ board, who: "assistant-2" });
  assert.match(two.host.innerHTML, /SECOND-MESSAGE/, "#2's view has #2's message");
  assert.doesNotMatch(two.host.innerHTML, /PRIMARY-MESSAGE/, "and not #1's");
  assert.doesNotMatch(two.host.innerHTML, /THIRD-MESSAGE/, "and not #3's");
  assert.match(two.host.innerHTML, /narrowed to Assistant #2 — 1 of 3/, "the bar names the split and its count");
  assert.equal((two.host.innerHTML.match(/data-as-msgdir=/g) || []).length, 3, "the direction chips are still exactly three");

  // The #2 chip is on All's payload too: nothing was hidden from the reader who wants to narrow it.
  assert.match(all.host.innerHTML, /data-as-msgwho="assistant-2"/, "All offers #2's split");
});
