// The per-assistant split for the scratchpad and the watches.
//
// Settings, charter, queue, role and rules were already per assistant; the PAD and the WATCHLIST were not. Two
// symptoms, both from one shared field and one unowned list:
//
//   1. `notes` was ONE string in the panel-wide payload. Every assistant's preamble clipped the same 1,200
//      characters of it, so one assistant's notes evicted another's and a NOTE written in #3's turn landed in the
//      pad every assistant reads.
//   2. `watches` was one array of records with no owner, `slice(-10)` in every preamble, so a turn saw watches it
//      never set.
//
// What this file is the contract for:
//
//   · #1's notes stay the `notes` string in assistant.json, unmigrated and byte-identical; every other assistant
//     owns state/assistants/assistant-N/notes.md, starts EMPTY (the shared blob is not copied in) and reads and
//     writes that file alone — both from its own turn's NOTE lines and from the reader's Pad-tab save.
//   · a watch is stamped with its owner when it is CREATED, from the turn (or the tab) that created it; the legacy
//     records carry no stamp, are resolved at READ time from the thread and fall back to #1, and the store is never
//     rewritten.
//   · the preamble's watch block and the Watches tab are filtered to one assistant, and the other assistants'
//     watches are still shown — under their own heading, with whose they are on the row.
//
// The last section drives the two renderers out of public/assistant.js with `sliceRegion`, because "the tab shows
// the selected assistant's" is a claim about the HTML and not about the store.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { parseActions } from "../lib/assistant/actions.js";
import { notesRelFor, readNotesFile, writeNotesFile } from "../lib/assistant/notes-file.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const SHARED = "SHARED-NOTES: the one 7,999-character string every assistant used to read";
const iso = (ms = 0) => new Date(1_700_000_000_000 + ms).toISOString();

async function panel(t, { notes = "", watches = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-pad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes, rules: [], watches, alerts: [], journal: [] }));
  const rows = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: {
      list: () => rows,
      get: (id) => rows.find((j) => j.id === id) || null,
      firstOfThread: (thread) => rows.find((j) => j.thread === thread) || null,
      create: async (body) => {
        const job = { id: `job-${rows.length + 1}`, ...body };
        rows.push(job);
        return job;
      },
    },
    getProjects: () => [],
    onLog: () => {},
  });
  const notesFile = (id) => path.join(dir, "assistants", id, "notes.md");
  const stored = async () => JSON.parse(await readFile(assistantFile, "utf8"));
  return { assistant, dir, assistantFile, notesFile, rows, stored };
}

// A turn of one assistant's own thread, as far as `applyActions` is concerned.
const turnOf = (assistant, id) => ({ id: `turn-${id}`, thread: assistant.threadOf(id) });

test("#2 starts with an empty pad of its own, and the shared string is not copied into it", async (t) => {
  const { assistant, notesFile } = await panel(t, { notes: SHARED });
  const id = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  assert.equal(id, "assistant-2");
  // Seeded at CREATE, beside its charter, and empty on purpose: the shared blob is Assistant #1's.
  assert.equal(await readFile(notesFile(id), "utf8"), "", "its own notes.md exists and is empty");
  assert.equal(assistant.notesFor(id), "", "and its pad reads empty");
  assert.equal(assistant.notesFor(PRIMARY_ASSISTANT), SHARED, "#1's notes are where they always were");
  assert.equal(assistant.notesPayloadFor(id).path.replace(/\\/g, "/"), notesFile(id).replace(/\\/g, "/"));
  assert.equal(assistant.notesPayloadFor(id).file, true, "the payload says the pad is a file");
  assert.equal(assistant.notesPayloadFor(PRIMARY_ASSISTANT).file, false, "and that #1's is a field in its store");
});

test("the Pad-tab save writes the assistant it was made for, and nothing else", async (t) => {
  const { assistant, assistantFile, notesFile, dir, stored } = await panel(t, { notes: SHARED });
  const id = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  assistant.setNotesFor(id, "REVIEWER-PAD: read the diff before you answer");
  assert.equal(await readFile(notesFile(id), "utf8"), "REVIEWER-PAD: read the diff before you answer", "the save is #2's file");
  assert.equal(assistant.notesFor(PRIMARY_ASSISTANT), SHARED, "#1's notes did not move");

  // #1's own save still lands in assistant.json's `notes`, the field it has always had.
  assistant.setNotesFor(PRIMARY_ASSISTANT, "PRIMARY-PAD");
  assistant.writeNow();
  assert.equal((await stored()).notes, "PRIMARY-PAD");
  assert.equal(await readFile(notesFile(id), "utf8"), "REVIEWER-PAD: read the diff before you answer", "and #2's pad is untouched by it");
  // No notes.md was created for #1: its pad is a field, not a file.
  await assert.rejects(() => stat(path.join(dir, "assistants", PRIMARY_ASSISTANT, "notes.md")));
  assert.equal(JSON.parse(await readFile(assistantFile, "utf8")).notes, "PRIMARY-PAD");
});

test("each assistant's preamble carries its OWN scratchpad — the eviction the split exists to stop", async (t) => {
  // #1's pad is the long one, the shape the defect was reported on: every turn clipped the same 1,200 characters.
  const long = Array.from({ length: 220 }, (_, i) => `- shared line ${i} ${"z".repeat(24)}`).join("\n").slice(-7999);
  const { assistant } = await panel(t, { notes: long });
  const id = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;

  const empty = assistant.preamble(id);
  assert.match(empty, /Scratchpad \(empty\):/, "a new assistant's pad says it is empty rather than borrowing #1's");

  assistant.setNotesFor(id, "REVIEWER-PAD");
  const mine = assistant.preamble(id);
  assert.ok(mine.includes("REVIEWER-PAD"), "#2's turn reads #2's pad");
  assert.ok(!mine.includes("shared line"), "and none of #1's blob");
  const theirs = assistant.preamble(PRIMARY_ASSISTANT);
  assert.ok(theirs.includes(long.slice(0, 40)), "#1's turn still reads #1's pad");
  assert.ok(!theirs.includes("REVIEWER-PAD"), "and not #2's");
});

test("a NOTE lands in the pad of the assistant whose turn wrote it", async (t) => {
  const { assistant, notesFile } = await panel(t, { notes: SHARED });
  const id = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;

  await assistant.applyActions(turnOf(assistant, id), parseActions("NOTE: the reviewer prefers the short diff"));
  assert.match(await readFile(notesFile(id), "utf8"), /reviewer prefers the short diff/, "#2's NOTE is in #2's pad");
  assert.ok(!assistant.notesFor(PRIMARY_ASSISTANT).includes("reviewer prefers"), "and not in #1's");

  await assistant.applyActions({ id: "turn-1", thread: ASSISTANT_THREAD }, parseActions("NOTE: the primary prefers a queue row"));
  assert.match(assistant.notesFor(PRIMARY_ASSISTANT), /primary prefers a queue row/, "#1's NOTE is still #1's string");
  assert.ok(!(await readFile(notesFile(id), "utf8")).includes("primary prefers"), "and did not leak into #2's file");
});

test("a watch is stamped with the assistant whose turn created it", async (t) => {
  const { assistant, rows, stored } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  rows.push({ id: "run-1", thread: "wtgui-worker-1", status: "running", startedAt: iso() });

  await assistant.applyActions(turnOf(assistant, id), parseActions("WATCH wtgui-worker-1: the deploy finishes | 15"));
  const stamped = assistant.watches.find((w) => w.title === "the deploy finishes");
  assert.equal(stamped?.assistantId, id, "the record carries the turn's assistant");
  assert.equal(assistant.watchOwnerOf(stamped), id);
  // The page reads it off the state, resolved, so the tab can group without guessing.
  assert.equal(assistant.state().watches.find((w) => w.id === stamped.id)?.assistantId, id);
  assistant.writeNow();
  assert.equal((await stored()).watches.find((w) => w.title === "the deploy finishes")?.assistantId, id, "and it is on disk");

  // The preamble of each assistant lists its own, and only its own.
  assert.ok(assistant.preamble(id).includes("the deploy finishes"));
  assert.ok(!assistant.preamble(PRIMARY_ASSISTANT).includes("the deploy finishes"));
});

test("the reader's own add is stamped for the tab it was made from, and #1's records keep their shape", async (t) => {
  const { assistant } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  const theirs = assistant.addWatch({ thread: "wtgui-worker-2", title: "from #2's tab", assistantId: id }, "reader");
  assert.equal(theirs.assistantId, id, "the tab's assistant is the watch's");
  const mine = assistant.addWatch({ thread: "wtgui-worker-3", title: "from #1's tab", assistantId: PRIMARY_ASSISTANT }, "reader");
  assert.ok(!("assistantId" in mine), "#1's record keeps the shape every earlier build wrote");
  assert.equal(assistant.watchOwnerOf(mine), PRIMARY_ASSISTANT, "and resolves to #1");
  // A stamp naming an assistant this panel does not hold is dropped rather than written.
  const bogus = assistant.addWatch({ thread: "wtgui-worker-4", title: "nobody's", assistantId: "assistant-99" }, "reader");
  assert.ok(!("assistantId" in bogus), "a stranger's id is not a stamp");
  assert.equal(assistant.watchOwnerOf(bogus), PRIMARY_ASSISTANT);
});

test("legacy watches are resolved from the thread at read time, and the store is not rewritten", async (t) => {
  const legacy = [
    { id: "w1", thread: ASSISTANT_THREAD, title: "legacy on #1's own thread", at: iso(1), by: "reader", state: "watching" },
    { id: "w2", thread: threadFor("assistant-2"), title: "legacy on #2's own thread", at: iso(2), by: "reader", state: "watching" },
    { id: "w3", thread: "wtgui-worker-legacy", title: "legacy on a worker thread", at: iso(3), by: "reader", state: "watching" },
  ];
  const { assistant, stored } = await panel(t, { watches: legacy });
  const id = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  assert.equal(id, "assistant-2");

  // A record with no stamp answers from its thread, and a worker thread belongs to nobody — which reads as #1.
  assert.equal(assistant.watchOwnerOf(legacy[1]), "assistant-2");
  assert.equal(assistant.watchOwnerOf(legacy[2]), PRIMARY_ASSISTANT);
  assert.deepEqual(
    assistant.state().watches.map((w) => w.assistantId),
    [PRIMARY_ASSISTANT, "assistant-2", PRIMARY_ASSISTANT],
    "the payload resolves every owner without touching the store",
  );
  // The two preambles see their own half.
  assert.ok(assistant.preamble(id).includes("legacy on #2's own thread"));
  assert.ok(!assistant.preamble(id).includes("legacy on a worker thread"), "a legacy worker watch is not handed to #2");
  assert.ok(assistant.preamble(PRIMARY_ASSISTANT).includes("legacy on a worker thread"));
  assert.ok(!assistant.preamble(PRIMARY_ASSISTANT).includes("legacy on #2's own thread"));

  // Nothing was migrated: the records on disk still carry no owner, whatever the reads resolved.
  assistant.writeNow();
  const onDisk = (await stored()).watches;
  assert.equal(onDisk.length, 3);
  assert.ok(onDisk.every((w) => !("assistantId" in w)), "the legacy list is the record of what was watched");
  assert.deepEqual(onDisk.map((w) => w.id), ["w1", "w2", "w3"], "and its order");
});

test("the notes file's own shape: one path per assistant, beside its charter, capped like the string", async (t) => {
  assert.equal(notesRelFor("assistant-2").replace(/\\/g, "/"), "assistants/assistant-2/notes.md");
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "assistants", "assistant-3", "notes.md");
  assert.deepEqual(readNotesFile(file), { text: "", exists: false, chars: 0, error: null }, "an absent pad is empty, not an error");
  const out = writeNotesFile(file, `${"a".repeat(8000)}TAIL`);
  assert.equal(out.chars, 8000, "the cap is the string's own 8,000");
  assert.ok(out.text.endsWith("TAIL"), "and it keeps the tail, as the store's own setNotes does");
  assert.equal(readNotesFile(file).text, out.text, "the bytes read back are the bytes written");
});

// ---- the page: the Watches tab and the Pad tab, driven out of public/assistant.js -------------------

const page = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const sessionById = (id) => ({ id, name: id === "assistant-1" ? "Assistant #1" : "Assistant #2" });

// The watches region: two rows, one of each assistant's, and the tab on #1 or #2.
function watchesPane({ who, watches }) {
  const host = { innerHTML: "", querySelectorAll: () => [] };
  const state = { assistant: { watches }, assistantOpen: true, assistantView: { assistant: "watches" } };
  const api = new Function(
    "state",
    "as$",
    "esc",
    "typingInside",
    "frameSessionId",
    "sessionById",
    "assistantThreadName",
    "conversations",
    "FIRST_ASSISTANT",
    `${sliceRegion(page, "watches")}
return { renderAssistantWatches };`,
  )(state, (id) => (id === "as-watches" ? host : null), esc, () => false, () => who, sessionById, (t) => t, () => [], "assistant-1");
  api.renderAssistantWatches(true);
  return host.innerHTML;
}

const TWO_WATCHES = [
  { id: "w1", thread: "wtgui-worker-1", title: "the deploy finishes", assistantId: "assistant-1", state: "watching" },
  { id: "w2", thread: "wtgui-worker-2", title: "the review lands", assistantId: "assistant-2", state: "watching" },
];

test("the Watches tab lists the selected assistant's watches first, and the others under their own heading", () => {
  const forTwo = watchesPane({ who: "assistant-2", watches: TWO_WATCHES });
  assert.ok(forTwo.indexOf("the review lands") < forTwo.indexOf("the deploy finishes"), "#2's watch is the list; #1's is below it");
  assert.match(forTwo, /Kept by the other assistants/, "the other assistants' watches are still shown");
  assert.match(forTwo, /kept by Assistant #1/, "and the row says whose it is");
  assert.match(forTwo, /Assistant #2 will be told when that thread finishes/, "the add form names who will be told");
  assert.doesNotMatch(forTwo, /Nothing on Assistant #2's watchlist/, "a list with a row in it is not empty");

  const forOne = watchesPane({ who: "assistant-1", watches: TWO_WATCHES });
  assert.ok(forOne.indexOf("the deploy finishes") < forOne.indexOf("the review lands"), "#1's tab leads with #1's watch");
  assert.match(forOne, /kept by Assistant #2/, "and #2's is labelled in the section below");
});

test("an assistant with nothing of its own says so, without hiding the others", () => {
  const html = watchesPane({ who: "assistant-1", watches: [TWO_WATCHES[1]] });
  assert.match(html, /Nothing on Assistant #1's watchlist/, "the empty list is #1's, in its own words");
  assert.match(html, /Kept by the other assistants/, "and #2's watch is still on the tab");
});

// The pad region: #1 reads the state's string, an extra assistant reads its own file through the route.
function padPane({ who, notes, pad = null }) {
  const host = { innerHTML: "" };
  const state = { assistant: { notes, rules: [], journal: [] }, assistantView: { assistant: "pad" } };
  const calls = [];
  const apiFetch = (url) => {
    calls.push(url);
    return Promise.resolve({ ok: true, json: async () => pad });
  };
  const api = new Function(
    "state",
    "as$",
    "esc",
    "typingInside",
    "frameSessionId",
    "sessionById",
    "FIRST_ASSISTANT",
    "apiFetch",
    `${sliceRegion(page, "scratchpad")}
return { renderAssistantPad, padInflight };`,
  )(state, (id) => (id === "as-pad" ? host : null), esc, () => false, () => who, sessionById, "assistant-1", apiFetch);
  api.renderAssistantPad(true);
  return { host, calls, api };
}

test("the Pad tab shows the selected assistant's notes — and never another's", async () => {
  const mine = padPane({ who: "assistant-1", notes: "#1's own line" });
  assert.match(mine.host.innerHTML, /#1's own line/, "#1 reads the string the state carries");
  assert.equal(mine.calls.length, 0, "and asks the server for nothing");
  assert.match(mine.host.innerHTML, /kept on the server in assistant\.json/, "saying where the text is kept");

  const theirs = padPane({
    who: "assistant-2",
    notes: "#1's own line",
    pad: { assistantId: "assistant-2", notes: "#2's own line", path: "C:/panel/state/assistants/assistant-2/notes.md", file: true, exists: true, chars: 13, cap: 8000, error: null },
  });
  // The first paint is the read, not #1's pad under #2's name.
  assert.match(theirs.host.innerHTML, /reading Assistant #2's pad…/, "it says it is reading");
  assert.doesNotMatch(theirs.host.innerHTML, /#1's own line/, "and does not draw the wrong assistant's pad meanwhile");
  assert.equal(theirs.calls.length, 1, "one read");
  assert.equal(theirs.calls[0], "/api/assistant/notes?assistantId=assistant-2", "for the assistant the tab is showing");
  await theirs.api.padInflight.get("assistant-2");
  assert.match(theirs.host.innerHTML, /#2's own line/, "the answer is #2's pad");
  assert.doesNotMatch(theirs.host.innerHTML, /#1's own line/, "and still not #1's");
  assert.match(theirs.host.innerHTML, /kept in this assistant's own notes\.md/, "the hint names the file it is kept in");
});

test("the routes and the two presses carry the assistant id", () => {
  // The save is per assistant, and the read is a GET the Pad tab makes when it opens.
  assert.match(server, /assistant\.setNotesFor\(body\.assistantId, body\.text\)/, "the save routes to the owning assistant");
  assert.match(server, /assistant\.notesPayloadFor\(q\.get\("assistantId"\)/, "and the read takes an assistantId");
  assert.match(page, /asPost\("\/api\/assistant\/notes", \{ text, assistantId: who \}\)/, "the Pad tab's save posts it");
  assert.match(page, /asPost\("\/api\/assistant\/watch", \{ thread, title, minutes, assistantId: frameSessionId\(\) \}\)/, "so does the watch form");
});
