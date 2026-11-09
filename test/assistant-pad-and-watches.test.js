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
//     owns state/assistants/assistant-N/notes.md, seeded ONCE from that string when the split landed, and reads and
//     writes that file alone — both from its own turn's NOTE lines and from the reader's Pad-tab save. The seed is
//     create-only: an existing file is never overwritten, so a boot cannot undo a NOTE or a reader's edit.
//   · the standing rules are COPIED into each other assistant's own record once, with their own ids; #1's list is
//     never written, and a rule deleted from #2 is not deleted from #1 or #3.
//   · a watch is stamped with its owner when it is CREATED, from the turn (or the tab) that created it; the legacy
//     records carry no stamp, are resolved at READ time from the thread and fall back to #1, and the store is never
//     rewritten.
//   · the preamble's watch block and the Watches tab are filtered to one assistant — each tab lists its own watches
//     and nobody else's.
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
import { NOTES_CAP } from "../lib/assistant/config.js";
import { notesRelFor, readNotesFile, seedNotesFile, writeNotesFile } from "../lib/assistant/notes-file.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const SHARED = "SHARED-NOTES: the one 7,999-character string every assistant used to read";
const iso = (ms = 0) => new Date(1_700_000_000_000 + ms).toISOString();
const rule = (id, text) => ({ id, text, by: "reader", at: iso(0) });

async function panel(t, { notes = "", watches = [], rules = [], assistants = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-pad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes, rules, watches, alerts: [], journal: [] }));
  // A panel that already held extra assistants when the split landed: their records are on disk WITHOUT
  // `rulesSeededAt` and without a rules.md/notes.md of their own. This is the boot pass's real input.
  if (assistants) await writeFile(path.join(dir, "assistants.json"), JSON.stringify({ version: 1, assistants }));
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

test("#2's pad is seeded once from the shared text, and a later seed never overwrites it", async (t) => {
  const { assistant, notesFile } = await panel(t, { notes: SHARED });
  const id = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  assert.equal(id, "assistant-2");
  // Seeded at CREATE, beside its charter, from the text every assistant used to share.
  assert.equal(await readFile(notesFile(id), "utf8"), SHARED, "its own notes.md starts from the shared text");
  assert.equal(assistant.notesFor(id), SHARED, "and its pad reads it");
  assert.equal(assistant.notesFor(PRIMARY_ASSISTANT), SHARED, "#1's notes are where they always were");
  assert.equal(assistant.notesPayloadFor(id).path.replace(/\\/g, "/"), notesFile(id).replace(/\\/g, "/"));
  assert.equal(assistant.notesPayloadFor(id).file, true, "the payload says the pad is a file");
  assert.equal(assistant.notesPayloadFor(PRIMARY_ASSISTANT).file, false, "and that #1's is a field in its store");
  assert.throws(() => assistant.notesPayloadFor("assistant-99"), /no such assistant/, "an id the roster does not hold never resolves to #1's pad");

  // A pad the assistant has written since is never touched: the seed is CREATE-only, so a boot (or this second
  // call) cannot put the old shared lines back over it, and cannot undo a NOTE it wrote.
  assistant.setNotesFor(id, "REVIEWER-PAD: mine now");
  const again = seedNotesFile(notesFile(id), SHARED);
  assert.equal(again.seeded, false, "an existing notes.md is not seeded again");
  assert.equal(await readFile(notesFile(id), "utf8"), "REVIEWER-PAD: mine now");
});

test("a record that predates the split gets its own rules and pad on the boot pass, once", async (t) => {
  const rules = [rule("r1", "answer in one line"), rule("r2", "deploy after the suite")];
  const assistants = [
    { id: PRIMARY_ASSISTANT, name: "Assistant #1", roleId: "assistant-agent-manager", threadId: ASSISTANT_THREAD, rules: [], createdAt: iso() },
    { id: "assistant-2", name: "Assistant #2", roleId: "assistant-agent-manager", threadId: threadFor("assistant-2"), rules: [], createdAt: iso(1) },
    { id: "assistant-3", name: "Assistant #3", roleId: "assistant-agent-manager", threadId: threadFor("assistant-3"), rules: [], createdAt: iso(2) },
  ];
  const { assistant, notesFile } = await panel(t, { notes: SHARED, rules, assistants });
  assert.deepEqual(assistant.assistants.map((a) => a.id), [PRIMARY_ASSISTANT, "assistant-2", "assistant-3"]);

  // The copy is per assistant, and #1's list is the one it always was.
  for (const id of [PRIMARY_ASSISTANT, "assistant-2", "assistant-3"]) {
    assert.deepEqual(assistant.rulesFor(id).map((r) => r.text), ["answer in one line", "deploy after the suite"], `${id} carries the standing rules`);
    assert.ok(assistant.preamble(id).includes("deploy after the suite"), `${id}'s preamble carries them`);
  }
  assert.deepEqual(assistant.rules.map((r) => r.id), ["r1", "r2"], "#1's rule ids did not move");
  // Each copy owns its ids, so deleting one from #2 is not deleting #1's.
  for (const id of ["assistant-2", "assistant-3"]) {
    assert.notDeepEqual(assistant.rulesFor(id).map((r) => r.id), ["r1", "r2"], `${id}'s copy has its own ids`);
  }
  const second = assistant.rulesFor("assistant-2");
  assistant.removeRuleFor("assistant-2", second[0].id);
  assert.deepEqual(assistant.rulesFor("assistant-2").map((r) => r.text), ["deploy after the suite"], "the removal is #2's alone");
  assert.deepEqual(assistant.rulesFor(PRIMARY_ASSISTANT).map((r) => r.text), ["answer in one line", "deploy after the suite"], "#1's list is untouched");
  assert.deepEqual(assistant.rulesFor("assistant-3").map((r) => r.text), ["answer in one line", "deploy after the suite"], "#3's copy is untouched");

  // Idempotent: a second boot pass does not copy the rule back, because the record is stamped as seeded.
  assistant.loadAssistantRules();
  assert.deepEqual(assistant.rulesFor("assistant-2").map((r) => r.text), ["deploy after the suite"]);
  // The pad seed is create-only too: a written pad survives a second pass.
  assistant.setNotesFor("assistant-3", "THIRD-PAD");
  assistant.loadNotes();
  assert.equal(await readFile(notesFile("assistant-3"), "utf8"), "THIRD-PAD");
  assert.equal(await readFile(notesFile("assistant-2"), "utf8"), SHARED, "and the untouched one is still the seeded text");
});

test("the Pad-tab save writes the assistant it was made for, and nothing else", async (t) => {
  const { assistant, assistantFile, notesFile, dir, stored } = await panel(t, { notes: SHARED });
  const id = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
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
  const id = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;

  // Seeded from the shared text, #2's first turn reads it — and after its first write, only its own line. The
  // share is the ONE copy; the eviction was every later turn reading the same clipped tail forever.
  assert.match(assistant.preamble(id), /shared line/, "the new assistant starts from the seeded text");

  assistant.setNotesFor(id, "REVIEWER-PAD");
  const mine = assistant.preamble(id);
  assert.ok(mine.includes("REVIEWER-PAD"), "#2's turn reads #2's pad");
  assert.ok(!mine.includes("shared line"), "and none of #1's blob");
  const theirs = assistant.preamble(PRIMARY_ASSISTANT);
  // #1's store keeps the TAIL at the pad cap, so the head of an oversized legacy string is what a save now drops.
  assert.ok(theirs.includes(long.slice(-NOTES_CAP).slice(0, 40)), "#1's turn still reads #1's pad, trimmed to the cap's tail");
  assert.ok(!theirs.includes("REVIEWER-PAD"), "and not #2's");
});

test("a NOTE lands in the pad of the assistant whose turn wrote it", async (t) => {
  const { assistant, notesFile } = await panel(t, { notes: SHARED });
  const two = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  const three = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Auditor" }).created.id;
  assert.deepEqual([two, three], ["assistant-2", "assistant-3"]);

  await assistant.applyActions(turnOf(assistant, two), parseActions("NOTE: the reviewer prefers the short diff"));
  assert.match(await readFile(notesFile(two), "utf8"), /reviewer prefers the short diff/, "#2's NOTE is in #2's pad");
  assert.ok(!assistant.notesFor(PRIMARY_ASSISTANT).includes("reviewer prefers"), "and not in #1's");
  assert.ok(!(await readFile(notesFile(three), "utf8")).includes("reviewer prefers"), "and not in #3's");

  await assistant.applyActions(turnOf(assistant, three), parseActions("NOTE: the auditor wants the raw log"));
  assert.match(await readFile(notesFile(three), "utf8"), /auditor wants the raw log/, "#3's NOTE is in #3's pad");
  assert.ok(!(await readFile(notesFile(two), "utf8")).includes("auditor wants"), "and not in #2's");

  await assistant.applyActions({ id: "turn-1", thread: ASSISTANT_THREAD }, parseActions("NOTE: the primary prefers a queue row"));
  assert.match(assistant.notesFor(PRIMARY_ASSISTANT), /primary prefers a queue row/, "#1's NOTE is still #1's string");
  assert.ok(!(await readFile(notesFile(two), "utf8")).includes("primary prefers"), "and did not leak into #2's file");
  assert.ok(!(await readFile(notesFile(three), "utf8")).includes("primary prefers"), "nor into #3's");
});

test("a watch is stamped with the assistant whose turn created it", async (t) => {
  const { assistant, rows, stored } = await panel(t);
  const id = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
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
  const id = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
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

test("an overdue watch files its notice, stamped with the watch's owner", async (t) => {
  const { assistant, rows } = await panel(t);
  const id = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  // A run still live on the watched thread: `checkWatches` files an OVERDUE notice for a live turn whose deadline
  // was set by the clock, and that branch used to reference a `const` declared inside the FINISHED branch — every
  // overdue watch threw `noticeFor is not defined` and filed nothing.
  rows.push({ id: "run-overdue", thread: "wtgui-worker-overdue", status: "running", startedAt: iso() });
  const watch = assistant.addWatch({ thread: "wtgui-worker-overdue", title: "the deploy finishes", minutes: 5, assistantId: id }, "reader");
  watch.at = new Date(Date.now() - 10 * 60_000).toISOString();

  assistant.checkWatches(rows);

  const notice = assistant.alerts.find((a) => /^watch overdue: /.test(String(a.title || "")));
  assert.ok(notice, "an overdue watch files its notice");
  assert.match(notice.title, /^watch overdue: the deploy finishes/);
  assert.equal(notice.assistantId, id, "and the notice is stamped with the assistant the watch is");
});

test("legacy watches are resolved from the thread at read time, and the store is not rewritten", async (t) => {
  const legacy = [
    { id: "w1", thread: ASSISTANT_THREAD, title: "legacy on #1's own thread", at: iso(1), by: "reader", state: "watching" },
    { id: "w2", thread: threadFor("assistant-2"), title: "legacy on #2's own thread", at: iso(2), by: "reader", state: "watching" },
    { id: "w3", thread: "wtgui-worker-legacy", title: "legacy on a worker thread", at: iso(3), by: "reader", state: "watching" },
  ];
  const { assistant, stored } = await panel(t, { watches: legacy });
  const id = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
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

test("the notes file's own shape: one path per assistant, beside its charter, capped at what a turn reads", async (t) => {
  assert.equal(notesRelFor("assistant-2").replace(/\\/g, "/"), "assistants/assistant-2/notes.md");
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "assistants", "assistant-3", "notes.md");
  assert.deepEqual(
    readNotesFile(file),
    { text: "", exists: false, chars: 0, cap: NOTES_CAP, over: false, error: null },
    "an absent pad is empty, not an error",
  );
  const out = writeNotesFile(file, "a".repeat(NOTES_CAP));
  assert.equal(out.chars, NOTES_CAP, "a pad exactly at the cap is kept whole");
  assert.equal(readNotesFile(file).text.length, NOTES_CAP, "the bytes read back are the bytes written");
  // One character more is REFUSED, not trimmed: the cap is what a turn reads, so the extra text would be bytes
  // nobody sees, and a save that kept the tail would lose the part of the paste the reader was looking at.
  const refused = writeNotesFile(file, `${"a".repeat(NOTES_CAP)}TAIL`);
  assert.equal(refused.refused, true, "over the cap the save is refused");
  assert.equal(refused.code, "notes-too-long");
  assert.equal(readNotesFile(file).text.length, NOTES_CAP, "and the file on disk is exactly as it was");
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

// The watches region: two panes, one per assistant, each drawn for its OWN session.
function watchesPane({ who, watches }) {
  const paneIdFor = (id, sub) => (id === "assistant-1" ? `as-${sub}` : `as-${sub}-${id.replace(/^assistant-/, "")}`);
  const hosts = new Map([paneIdFor("assistant-1", "watches"), paneIdFor("assistant-2", "watches")].map((id) => [id, { innerHTML: "", querySelectorAll: () => [] }]));
  const host = hosts.get(paneIdFor(who, "watches"));
  const state = { assistant: { watches }, assistantOpen: true, assistantView: { assistant: who, subTab: "watches" } };
  const api = new Function(
    "state",
    "as$",
    "esc",
    "typingInside",
    "hostFor",
    "paneIdFor",
    "selectedSessionId",
    "isAssistant",
    "sessionById",
    "assistantThreadName",
    "conversations",
    "FIRST_ASSISTANT",
    `${sliceRegion(page, "watches")}
return { renderAssistantWatches };`,
  )(state, (id) => hosts.get(id) || null, esc, () => false, (id, sub) => hosts.get(paneIdFor(id, sub)) || null, paneIdFor, () => who, (x) => String(x || "").startsWith("assistant-"), sessionById, (t) => t, () => [], "assistant-1");
  api.renderAssistantWatches(true, who);
  return host.innerHTML;
}

const TWO_WATCHES = [
  { id: "w1", thread: "wtgui-worker-1", title: "the deploy finishes", assistantId: "assistant-1", state: "watching" },
  { id: "w2", thread: "wtgui-worker-2", title: "the review lands", assistantId: "assistant-2", state: "watching" },
];

test("the Watches tab is filtered to the selected assistant", () => {
  const forTwo = watchesPane({ who: "assistant-2", watches: TWO_WATCHES });
  assert.match(forTwo, /the review lands/, "#2's tab has #2's watch");
  assert.doesNotMatch(forTwo, /data-as-unwatch="w1"/, "#1's watch is on #1's tab, not #2's");
  assert.doesNotMatch(forTwo, /Kept by the other assistants/, "the tab is one assistant's list, not a combined one");
  assert.match(forTwo, /Assistant #2 will be told when that thread finishes/, "the add form names who will be told");
  assert.doesNotMatch(forTwo, /Nothing on Assistant #2's watchlist/, "a list with a row in it is not empty");

  const forOne = watchesPane({ who: "assistant-1", watches: TWO_WATCHES });
  assert.match(forOne, /the deploy finishes/, "#1's tab has #1's watch");
  assert.doesNotMatch(forOne, /data-as-unwatch="w2"/, "and not #2's");
});

test("an assistant with nothing of its own says so", () => {
  const html = watchesPane({ who: "assistant-1", watches: [TWO_WATCHES[1]] });
  assert.match(html, /Nothing on Assistant #1's watchlist/, "the empty list is #1's, in its own words");
  assert.doesNotMatch(html, /data-as-unwatch="w2"/, "and #2's watch is not drawn in #1's list");
});

// The pad region: #1 reads the state's string, an extra assistant reads its own file through the route. Each pane
// has its own controls, so two pads can be on the page without answering for each other.
// The two records' own standing rules: the pad's Standing rules section must read the SELECTED assistant's list, so
// #2's pane shows #2's rule and the ✕ beside it names #2.
const PAD_RULES = {
  "assistant-1": [{ id: "r1", text: "deploy to QA, never PROD", by: "reader" }],
  "assistant-2": [{ id: "r2", text: "ask before writing to a tree another agent owns", by: "reader" }],
};

function padPane({ who, notes, pad = null }) {
  const paneIdFor = (id, sub) => (id === "assistant-1" ? `as-${sub}` : `as-${sub}-${id.replace(/^assistant-/, "")}`);
  const hosts = new Map([paneIdFor("assistant-1", "pad"), paneIdFor("assistant-2", "pad")].map((id) => [id, { innerHTML: "" }]));
  const host = hosts.get(paneIdFor(who, "pad"));
  const state = { assistant: { notes, rules: [], journal: [] }, assistantView: { assistant: who, subTab: "pad" } };
  const recordFor = (id) => ({ id, name: id === "assistant-1" ? "Assistant #1" : "Assistant #2", rules: PAD_RULES[id] || [] });
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
    "hostFor",
    "paneIdFor",
    "selectedSessionId",
    "activeSessionId",
    "sessionById",
    "FIRST_ASSISTANT",
    "apiFetch",
    `${sliceRegion(page, "scratchpad")}
return { renderAssistantPad, padInflight };`,
  )(state, (id) => hosts.get(id) || null, esc, () => false, (id, sub) => hosts.get(paneIdFor(id, sub)) || null, paneIdFor, () => who, () => who, recordFor, "assistant-1", apiFetch);
  api.renderAssistantPad(true, who);
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
  assert.match(theirs.host.innerHTML, /reading Assistant #2's notes…/, "it says it is reading");
  assert.doesNotMatch(theirs.host.innerHTML, /#1's own line/, "and does not draw the wrong assistant's pad meanwhile");
  assert.equal(theirs.calls.length, 1, "one read");
  assert.equal(theirs.calls[0], "/api/assistant/notes?assistantId=assistant-2", "for the assistant the tab is showing");
  await theirs.api.padInflight.get("assistant-2");
  assert.match(theirs.host.innerHTML, /#2's own line/, "the answer is #2's pad");
  assert.doesNotMatch(theirs.host.innerHTML, /#1's own line/, "and still not #1's");
  assert.match(theirs.host.innerHTML, /kept in this assistant's own notes\.md/, "the hint names the file it is kept in");
});

test("the Standing rules section is the selected assistant's own — and its ✕ names that assistant", () => {
  const one = padPane({ who: "assistant-1", notes: "note one" });
  assert.match(one.host.innerHTML, /deploy to QA, never PROD/, "#1's pane has #1's rule");
  assert.doesNotMatch(one.host.innerHTML, /another agent owns/, "and not #2's");
  assert.match(one.host.innerHTML, /data-as-unrule="r1" data-as-rulefor="assistant-1"/, "the ✕ names the assistant whose rule it is");

  const two = padPane({
    who: "assistant-2",
    notes: "note one",
    pad: { assistantId: "assistant-2", notes: "note two", path: "p", file: true, exists: true, error: null },
  });
  assert.match(two.host.innerHTML, /another agent owns/, "#2's pane has #2's rule");
  assert.doesNotMatch(two.host.innerHTML, /deploy to QA, never PROD/, "and not #1's");
  assert.match(two.host.innerHTML, /data-as-unrule="r2" data-as-rulefor="assistant-2"/, "the ✕ names #2");

  // The Settings tab no longer carries a second rules list: the Notes tab is the one place rules are shown and added.
  assert.match(page, /asPost\("\/api\/assistant\/rule", \{ text, assistantId: who \}\)/, "the pad's Add rule posts the assistant it sits in");
  assert.doesNotMatch(page, /data-as-addrule|as-rules-text/, "and the Settings tab's own rules form is gone");
});

test("the routes and the two presses carry the assistant id", () => {
  // The save is per assistant, and the read is a GET the Pad tab makes when it opens.
  assert.match(server, /assistant\.setNotesFor\(body\.assistantId, body\.text\)/, "the save routes to the owning assistant");
  assert.match(server, /assistant\.notesPayloadFor\(q\.get\("assistantId"\)/, "and the read takes an assistantId");
  assert.match(page, /asPost\("\/api\/assistant\/notes", \{ text, assistantId: who \}\)/, "the Pad tab's save posts it");
  assert.match(page, /asPost\("\/api\/assistant\/watch", \{ thread, title, minutes, assistantId: frameSessionId\(\) \}\)/, "so does the watch form");
});
