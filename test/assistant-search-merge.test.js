// The assistant search over EVERY assistant's turns: the merge, its order, and a tie between two assistants.
//
// WHAT THIS FILE IS FOR. The header search box used to send the open tab's assistant id, so a phrase in Assistant
// #2's turns was invisible while #1 was selected. The corpus is every assistant's own turns now: each assistant's
// threads are matched into their own list and the lists are merged into ONE ordered index at query time
// (`mergeAssistantHits`), with every hit carrying the assistant it belongs to. Two things are pinned here:
//
//   * THE MERGE - two assistants' hits become one list, newest first inside the cap's field preference, and a tie at
//     the same millisecond is decided by the assistant so the order never depends on how the groups were read;
//   * THE CORPUS - every assistant's current thread and the threads a hard restart left behind are searched, a
//     worker's thread is not, each hit names its assistant, and `matched`/`turns` count across all of them while the
//     cap only limits what is displayed.
//
// The Assistant's own method is driven over a stub job store, so the thread ownership (and the 404 for an unknown
// assistant) is proved on the shipped code rather than on a copy of it. The route's status codes are
// test/assistant-search.test.js's subject; the page's list order is test/assistant-search-items.test.js's.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { threadFor } from "../lib/assistants.js";
import { mergeAssistantHits, searchTurns } from "../lib/assistant/search.js";

const A1 = { id: "assistant-1", name: "Assistant #1", threads: [ASSISTANT_THREAD] };
const A2 = { id: "assistant-2", name: "Assistant #2", threads: [threadFor("assistant-2")] };
// A second assistant that hard-restarted once: its live thread and the one it left behind are both its own.
const A3 = { id: "assistant-3", name: "Assistant #3", threads: [threadFor("assistant-3"), `${threadFor("assistant-3")}-r2`] };

const at = (h, m = 0) => Date.UTC(2026, 10, 12, h, m);

// The shape the job store keeps: the summary carries the prompt, the record carries the reply and the lines.
const TURNS = [
  {
    id: "a1-old",
    thread: ASSISTANT_THREAD,
    turn: 1,
    startedAt: new Date(at(8)).toISOString(),
    prompt: "beacon one, from the first assistant",
    finalMessage: "nothing to add",
    lines: [],
  },
  {
    id: "a1-new",
    thread: ASSISTANT_THREAD,
    turn: 2,
    startedAt: new Date(at(10)).toISOString(),
    prompt: "beacon two, newer",
    finalMessage: "done",
    lines: [],
  },
  {
    id: "a2-beacon",
    thread: threadFor("assistant-2"),
    turn: 1,
    startedAt: new Date(at(9)).toISOString(),
    prompt: "beacon from the second assistant",
    finalMessage: "reply",
    lines: [],
  },
  {
    id: "a2-sextant",
    thread: threadFor("assistant-2"),
    turn: 2,
    startedAt: new Date(at(9, 30)).toISOString(),
    prompt: "sextant only here",
    finalMessage: "kept",
    lines: [],
  },
  {
    id: "a3-old-thread",
    thread: `${threadFor("assistant-3")}-r2`,
    turn: 1,
    startedAt: new Date(at(7)).toISOString(),
    prompt: "sextant from before the restart",
    finalMessage: "",
    lines: [],
  },
  {
    id: "worker-beacon",
    thread: "worker-thread-9",
    turn: 1,
    startedAt: new Date(at(11)).toISOString(),
    prompt: "beacon in a worker's turn",
    finalMessage: "",
    lines: [],
  },
];

const store = (turns = TURNS) => ({
  summaries: turns.map((t) => ({ id: t.id, thread: t.thread, turn: t.turn, startedAt: t.startedAt, prompt: t.prompt })),
  records: (id) => turns.find((t) => t.id === id) || null,
});

const every = (query, over = {}) =>
  searchTurns({ ...store(), assistants: [A1, A2, A3], query, scope: "all", limit: 20, ...over });

const hitOf = (out, id) => out.hits.find((h) => h.id === id) || null;

test("hits that are already ordered merge into one list without being changed", () => {
  const one = { at: at(9), field: "input", assistantId: "assistant-1", thread: ASSISTANT_THREAD, id: "a" };
  const two = { at: at(8), field: "input", assistantId: "assistant-2", thread: threadFor("assistant-2"), id: "b" };
  const groups = [
    { assistantId: "assistant-1", assistant: "Assistant #1", hits: [one] },
    { assistantId: "assistant-2", assistant: "Assistant #2", hits: [two] },
  ];
  const merged = mergeAssistantHits(groups);
  assert.deepEqual(merged.map((h) => h.id), ["a", "b"], "newest first across the two assistants");
  assert.equal(merged[0], one, "the same hit objects, not copies");
  assert.equal(groups[0].hits.length, 1, "the groups are not emptied");
});

test("the merged index ranks newest first inside the cap's field preference", () => {
  const out = every("beacon");
  assert.equal(out.matched, 3, "two from #1 and one from #2 - the worker's turn is not any assistant's");
  assert.deepEqual(
    out.hits.map((h) => h.id),
    ["a1-new", "a2-beacon", "a1-old"],
    "the store's rows are the cap's preference first - every hit is the prompt here - so the clock decides",
  );
  // A worker's turn is not any assistant's, so it is not in the every-assistant read at all.
  assert.equal(out.hits.some((h) => h.id === "worker-beacon"), false);
  assert.equal(out.hits.every((h) => [ASSISTANT_THREAD, threadFor("assistant-2")].includes(h.thread)), true);
});

test("every hit names its assistant, current thread or one a restart left behind", () => {
  const out = every("beacon");
  assert.equal(hitOf(out, "a1-new").assistantId, "assistant-1");
  assert.equal(hitOf(out, "a1-new").assistant, "Assistant #1");
  assert.equal(hitOf(out, "a2-beacon").assistantId, "assistant-2");
  assert.equal(hitOf(out, "a2-beacon").assistant, "Assistant #2");
  const restarted = every("sextant");
  assert.equal(restarted.matched, 2, "the live thread and the one the restart left behind are both #2's and #3's");
  assert.equal(hitOf(restarted, "a3-old-thread").assistantId, "assistant-3", "a previous thread is still that assistant's");
  assert.equal(hitOf(restarted, "a3-old-thread").assistant, "Assistant #3");
});

test("a phrase only another assistant holds is found while the groups hold nothing for it", () => {
  // The first assistant has no sextant turn at all: the answer is #2's and #3's alone, and the page can switch to
  // them because every hit says whose it is.
  const out = every("sextant");
  assert.equal(out.matched, 2);
  assert.deepEqual(new Set(out.hits.map((h) => h.assistantId)), new Set(["assistant-2", "assistant-3"]));
  assert.equal(out.hits.some((h) => h.assistantId === "assistant-1"), false);
});

test("the cap limits the rows shown and both counts stay honest across assistants", () => {
  const out = every("beacon", { limit: 2 });
  assert.equal(out.matched, 3, "three assistant hits matched");
  assert.equal(out.displayed, 2, "the cap shows two of them");
  assert.equal(out.hits.length, 2);
  assert.equal(out.turns, 3, "three distinct turns matched, though two are displayed");
  assert.deepEqual(out.hits.map((h) => h.id), ["a1-new", "a2-beacon"], "the newest two survive the cap");
  // Every displayed row carries its excerpt; the cap did not window the rows it did not show.
  for (const hit of out.hits) assert.ok(hit.hit.length > 0);
});

test("a tie between two assistants is decided by the assistant, whatever order the groups arrive in", () => {
  const same = at(9);
  const one = { at: same, field: "input", assistantId: "assistant-1", assistant: "Assistant #1", thread: ASSISTANT_THREAD, id: "one", turn: 4 };
  const two = { at: same, field: "input", assistantId: "assistant-2", assistant: "Assistant #2", thread: threadFor("assistant-2"), id: "two", turn: 1 };
  const forward = mergeAssistantHits([
    { assistantId: "assistant-1", assistant: "Assistant #1", hits: [one] },
    { assistantId: "assistant-2", assistant: "Assistant #2", hits: [two] },
  ]);
  const reversed = mergeAssistantHits([
    { assistantId: "assistant-2", assistant: "Assistant #2", hits: [two] },
    { assistantId: "assistant-1", assistant: "Assistant #1", hits: [one] },
  ]);
  assert.deepEqual(forward.map((h) => h.id), reversed.map((h) => h.id), "the same order from either read");
  assert.deepEqual(forward.map((h) => h.id), ["one", "two"], "assistant-1's hit leads the tie - the assistant's id decides, not the turn counter");
  // And the same tie through the whole read: two assistants' turns at one millisecond, same field, same kind.
  const turns = [
    { id: "z1", thread: ASSISTANT_THREAD, turn: 9, startedAt: new Date(same).toISOString(), prompt: "quarry", finalMessage: "", lines: [] },
    { id: "z2", thread: threadFor("assistant-2"), turn: 1, startedAt: new Date(same).toISOString(), prompt: "quarry", finalMessage: "", lines: [] },
  ];
  const out = searchTurns({ ...store(turns), assistants: [A1, A2], query: "quarry", limit: 10 });
  assert.deepEqual(out.hits.map((h) => h.id), ["z1", "z2"]);
});

test("an assistant with no thread of its own is skipped, not searched as nobody", () => {
  const out = searchTurns({ ...store(), assistants: [A1, A2, { id: "assistant-4", name: "Assistant #4", threads: [] }], query: "beacon", limit: 20 });
  assert.equal(out.matched, 3, "the empty group adds no hit and cannot swallow another's");
  assert.equal(out.hits.some((h) => h.assistantId === "assistant-4"), false);
});

// ---- the shipped method over a stub store ---------------------------------------------------------------

async function panel(t, { turns = TURNS } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-search-all-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  await writeFile(
    path.join(dir, "assistants.json"),
    JSON.stringify({
      version: 1,
      assistants: [
        { id: "assistant-1", name: "Assistant #1", threadId: ASSISTANT_THREAD, rules: [] },
        { id: "assistant-2", name: "Assistant #2", threadId: threadFor("assistant-2"), rules: [] },
        { id: "assistant-3", name: "Assistant #3", threadId: threadFor("assistant-3"), previousThreads: [`${threadFor("assistant-3")}-r2`], rules: [] },
      ],
    }),
  );
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: {
      list: () => turns.map((x) => ({ id: x.id, thread: x.thread, turn: x.turn, startedAt: x.startedAt, prompt: x.prompt })),
      get: (id) => turns.find((x) => x.id === id) || null,
    },
    getProjects: () => [],
    onLog: () => {},
  });
  return assistant;
}

test("the Assistant searches every assistant's own turns, and refuses an id it does not hold", async (t) => {
  const assistant = await panel(t);
  const out = assistant.searchTurns({ query: "beacon", limit: 20 });
  assert.equal(out.matched, 3, "both assistants' prompts, never the worker's");
  assert.deepEqual(new Set(out.hits.map((h) => h.assistantId)), new Set(["assistant-1", "assistant-2"]));
  assert.equal(hitOf(out, "a2-beacon").assistant, "Assistant #2");

  const one = assistant.searchTurns({ query: "beacon", limit: 20, assistantId: "assistant-2" });
  assert.equal(one.matched, 1, "one assistant narrows the same read");
  assert.equal(one.hits[0].assistantId, "assistant-2");

  const restarted = assistant.searchTurns({ query: "sextant", limit: 20 });
  assert.equal(restarted.matched, 2, "#2's live turn and #3's previous thread");
  assert.equal(hitOf(restarted, "a3-old-thread").assistantId, "assistant-3");

  assert.throws(() => assistant.searchTurns({ query: "beacon", assistantId: "assistant-9" }), /no assistant assistant-9/);
});
