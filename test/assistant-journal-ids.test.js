// Stable journal ids, and the locator that lets a cut pad line name the entry holding its full text.
//
// The defect this file is the contract for: a NOTE is clipped to 200 characters on the pad, and the full text was
// journalled with no way to name it. A clipped line said only `[clipped]`; a turn reading the pad could not tell
// where the rest of the note went, and the journal's 500-character clip could silently shorten a long note too.
//
// The five claims, one section each:
//   1. every journal entry carries a stable `j<n>` id, persisted beside the list, and a restart never renumbers it;
//   2. a file written before ids existed gets them once, and the counter (not the list's length) is what keeps them
//      from being reused after the 300-entry cap ages an entry out;
//   3. a NOTE is journalled whole up to `NOTE_TEXT_CAP` while every other entry keeps the historical 500;
//   4. a 600-character NOTE is cut on the pad with `[cut - full note jN]`, and that id gives the whole 600 back -
//      from the store, from the state payload, and from a live panel's /api/state;
//   5. the notes block a turn reads ends with `clipped notes: jN, jM - full text: GET <panel>/api/state` only when
//      a pad line was cut, and the Pad tab draws the locator beside the note and in the journal row.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { parseActions } from "../lib/assistant/actions.js";
import { NOTE_LINE_CAP, NOTE_TEXT_CAP } from "../lib/assistant/config.js";
import { clippedNoteIds, noteCutMark, noteLines, noteLocatorOf, NOTE_CLIP_MARK } from "../lib/assistant/notes-file.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { sliceRegion, startPanel } from "../tools/panel-testkit.mjs";

const iso = (ms = 0) => new Date(1_700_000_000_000 + ms).toISOString();

/** A 600-character note built from whole words, with no trailing space for the parser to trim off. */
const longNote = (n = 1) => {
  const body = (`note ${n} ` + Array.from({ length: 100 }, (_, i) => `fact${n}-${i}`).join(" ")).slice(0, 600);
  return body.endsWith(" ") ? `${body.slice(0, 599)}x` : body;
};

function makeAssistant(assistantFile, dir) {
  return new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs: {
      list: () => [],
      get: () => null,
      firstOfThread: () => null,
      create: async (body) => ({ id: "job-1", ...body }),
    },
    getProjects: () => [],
    onLog: () => {},
  });
}

/** One panel over a temp state directory, with whatever journal the test needs already on disk. */
function panel(t, { journal = [], journalSeq = 0, notes = "", port = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-journal-id-"));
  const assistantFile = path.join(dir, "assistant.json");
  const seed = { version: 2, settings: {}, notes, rules: [], watches: [], alerts: [], journal };
  if (journalSeq) seed.journalSeq = journalSeq;
  writeFileSync(assistantFile, JSON.stringify(seed));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir, ...(port ? { port } : {}) },
    jobs: {
      list: () => [],
      get: () => null,
      firstOfThread: () => null,
      create: async (body) => ({ id: "job-1", ...body }),
    },
    getProjects: () => [],
    onLog: () => {},
  });
  const stop = () => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
  };
  t.after(() => {
    stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const notesFile = (id) => path.join(dir, "assistants", id, "notes.md");
  const turnOf = (id) => ({ id: `turn-${id}`, thread: assistant.threadOf(id) });
  const stored = () => JSON.parse(readFileSync(assistantFile, "utf8"));
  return { assistant, dir, assistantFile, notesFile, turnOf, stored, stop };
}

test("every journal entry gets a stable id, and the counter survives a restart", (t) => {
  const { assistant, assistantFile, dir } = panel(t);
  // A boot seeds the role library and the charter, and those are journalled too: they are entries like any other.
  assert.ok(assistant.journal.length >= 1, "the boot's own entries are already in the journal");
  assert.ok(assistant.journal.every((e) => /^j\d+$/.test(e.id)), "and every one carries an id");
  const seq = assistant.journalSeq;
  const first = assistant.journalAdd("charter", null, "seeded the charter");
  const second = assistant.journalAdd("notes", null, "saved the notes");
  assert.equal(first.id, `j${seq + 1}`);
  assert.equal(second.id, `j${seq + 2}`);
  assistant.writeNow();
  const file = JSON.parse(readFileSync(assistantFile, "utf8"));
  assert.equal(file.journalSeq, seq + 2, "the counter is persisted beside the list");
  assert.ok(file.journal.every((e) => /^j\d+$/.test(e.id)), "and every entry on disk carries its id");
  const onDisk = new Map(file.journal.map((e) => [e.id, e.text]));

  // A new process over the same file: ids unchanged, and the next entry is above the counter rather than reusing
  // the length of the list.
  const again = makeAssistant(assistantFile, dir);
  try {
    for (const [id, text] of onDisk) assert.equal(again.journal.find((e) => e.id === id)?.text, text, `${id} is not renumbered`);
    assert.ok(again.journalSeq >= seq + 2, "the reloaded counter is at least the persisted one");
    assert.equal(again.journalAdd("note", null, "the next entry").id, `j${again.journalSeq}`, "and the next id is above it, not j1 again");
  } finally {
    if (again.persistTimer) clearTimeout(again.persistTimer);
    if (again.timer) clearInterval(again.timer);
  }
});

test("a journal written before ids existed gets them once, and keeps them", (t) => {
  const legacy = [
    { at: iso(0), kind: "charter", thread: null, text: "old one" },
    { at: iso(1), kind: "notes", thread: null, text: "old two" },
  ];
  const { assistant, assistantFile, dir } = panel(t, { journal: legacy });
  const one = assistant.journal.find((e) => e.text === "old one");
  const two = assistant.journal.find((e) => e.text === "old two");
  assert.match(one.id, /^j\d+$/, "the first legacy entry is stamped");
  assert.match(two.id, /^j\d+$/, "and the second");
  assert.ok(assistant.journalSeq >= Math.max(Number(one.id.slice(1)), Number(two.id.slice(1))), "the counter covers them");
  assistant.writeNow();
  const file = JSON.parse(readFileSync(assistantFile, "utf8"));
  assert.equal(file.journalSeq, assistant.journalSeq, "the adopted counter is persisted");
  assert.ok(file.journal.every((e) => /^j\d+$/.test(e.id)), "every entry is stamped on disk");

  const again = makeAssistant(assistantFile, dir);
  try {
    assert.equal(again.journal.find((e) => e.text === "old one")?.id, one.id, "a second boot leaves the first alone");
    assert.equal(again.journal.find((e) => e.text === "old two")?.id, two.id, "and the second");
    assert.equal(again.journalAdd("note", null, "after the migration").id, `j${again.journalSeq}`, "new entries continue above them");
  } finally {
    if (again.persistTimer) clearTimeout(again.persistTimer);
    if (again.timer) clearInterval(again.timer);
  }
});

test("a journal entry has 500 characters as before; a NOTE is kept whole up to NOTE_TEXT_CAP", (t) => {
  const { assistant } = panel(t);
  const clipped = assistant.journalAdd("charter", null, "x".repeat(600));
  assert.equal(clipped.text.length, 500, "the historical clip is unchanged for every other kind");
  const long = "z ".repeat(1500);
  const whole = assistant.journalAdd("note", null, long, { cap: NOTE_TEXT_CAP, raw: true });
  assert.equal(whole.text, long, "a NOTE is held exactly as the turn wrote it");
  assert.equal(whole.text.length, 3000);
  const over = assistant.journalAdd("note", null, "y".repeat(NOTE_TEXT_CAP + 100), { cap: NOTE_TEXT_CAP, raw: true });
  assert.equal(over.text.length, NOTE_TEXT_CAP, "the note ceiling still exists, and it is the note's own");
});

test("a 600-character NOTE is cut with its entry's locator, and the id gives the whole text back", async (t) => {
  const { assistant, notesFile, turnOf } = panel(t);
  const note = longNote(1);
  assert.equal(note.length, 600);
  await assistant.applyActions(turnOf(PRIMARY_ASSISTANT), parseActions(`NOTE: ${note}`));
  const [line] = assistant.notesFor(PRIMARY_ASSISTANT).split("\n");
  const id = noteLocatorOf(line);
  assert.match(id, /^j\d+$/, "the cut line names a journal id");
  assert.ok(line.endsWith(noteCutMark(id)), `the line ends with ${noteCutMark(id)}`);
  assert.ok(line.length <= NOTE_LINE_CAP, `and is ${line.length}, at or under ${NOTE_LINE_CAP}`);
  assert.ok(!line.includes(note), "the pad line is the cut one, not the whole note");
  const entry = assistant.journal.find((e) => e.id === id);
  assert.equal(entry?.text, note, "the journal holds the whole 600 characters");
  assert.equal(entry.text.length, 600);
  assert.equal(assistant.state().journal.find((e) => e.id === id)?.text, note, "and the state payload carries the same entry");

  // An extra assistant's own notes.md gets the same locator, resolving in the same journal. (It is created after
  // #1's note, so its pad is SEEDED with that line; its own append is the last one.)
  const two = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  const other = longNote(2);
  await assistant.applyActions(turnOf(two), parseActions(`NOTE: ${other}`));
  const theirs = readFileSync(notesFile(two), "utf8").split("\n").at(-1);
  assert.ok(theirs.endsWith(noteCutMark(noteLocatorOf(theirs))), "#2's line names its entry");
  assert.equal(assistant.journal.find((e) => e.id === noteLocatorOf(theirs))?.text, other);

  // A note that FITS is not cut and carries no marker: the locator costs nothing when there is nothing to find.
  await assistant.applyActions(turnOf(PRIMARY_ASSISTANT), parseActions("NOTE: a short line that fits the pad"));
  const fit = assistant.notesFor(PRIMARY_ASSISTANT).split("\n").at(-1);
  assert.equal(noteLocatorOf(fit), "");
  assert.ok(!fit.endsWith(NOTE_CLIP_MARK));
  assert.doesNotMatch(fit, /\[cut - full note/);
});

test("a live panel's /api/state carries the id from the pad line, with the whole note", async (t) => {
  const { assistant, assistantFile, dir, stop, turnOf } = panel(t);
  const note = longNote(3);
  await assistant.applyActions(turnOf(PRIMARY_ASSISTANT), parseActions(`NOTE: ${note}`));
  const line = assistant.notesFor(PRIMARY_ASSISTANT).split("\n")[0];
  const id = noteLocatorOf(line);
  assert.ok(id, "the pad line names the entry");
  assistant.writeNow();
  stop(); // no debounced writer left running beside the server

  const live = await startPanel({ dir, config: { assistantFile, jobsFile: path.join(dir, "jobs.json") } });
  t.after(() => live.stop());
  const r = await fetch(`${live.base}/api/state`);
  assert.equal(r.status, 200);
  const body = await r.json();
  const entry = (body.assistant?.journal || []).find((e) => e.id === id);
  assert.ok(entry, `the state payload carries ${id}`);
  assert.equal(entry.text, note, "and the full 600 characters come back by that id");
});

test("the notes block a turn reads ends with the clipped index, only when a pad line is cut", async (t) => {
  const { assistant, turnOf } = panel(t, { port: 7455 });
  await assistant.applyActions(turnOf(PRIMARY_ASSISTANT), parseActions("NOTE: a short line that fits"));
  const plain = assistant.preamble(PRIMARY_ASSISTANT);
  assert.match(plain, /Notes:/);
  assert.doesNotMatch(plain, /clipped notes:/, "an uncut pad costs no index line");

  const first = longNote(1);
  const second = longNote(2);
  await assistant.applyActions(turnOf(PRIMARY_ASSISTANT), parseActions(`NOTE: ${first}`));
  await assistant.applyActions(turnOf(PRIMARY_ASSISTANT), parseActions(`NOTE: ${second}`));
  const id1 = noteLocatorOf(assistant.notesFor(PRIMARY_ASSISTANT).split("\n")[1]);
  const id2 = noteLocatorOf(assistant.notesFor(PRIMARY_ASSISTANT).split("\n")[2]);
  const p = assistant.preamble(PRIMARY_ASSISTANT);
  assert.match(
    p,
    new RegExp(`clipped notes: ${id1}, ${id2} - full text: GET http://127\\.0\\.0\\.1:7455/api/state \\(this assistant's journal, by id\\)`),
    "the index names both entries, in pad order, and the route that carries them",
  );
  assert.deepEqual(clippedNoteIds(assistant.notesFor(PRIMARY_ASSISTANT)), [id1, id2]);
});

// The page: the same sliced-region harness the pad tests use, with the payload the server sends.
const page = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const escHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function padPane({ notes, lines, journal }) {
  const paneIdFor = (id, sub) => (id === "assistant-1" ? `as-${sub}` : `as-${sub}-${id.replace(/^assistant-/, "")}`);
  const host = { innerHTML: "" };
  const state = { assistant: { notes, notesCap: 1200, noteCap: NOTE_LINE_CAP, noteLines: lines, rules: [], journal }, assistantView: { assistant: "assistant-1", subTab: "pad" } };
  const recordFor = (id) => ({ id, name: "Assistant #1", rules: [] });
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
return { renderAssistantPad };`,
  )(state, () => host, escHtml, () => false, () => host, paneIdFor, () => "assistant-1", () => "assistant-1", recordFor, "assistant-1", () => Promise.resolve({ ok: true, json: async () => ({}) }));
  api.renderAssistantPad(true, "assistant-1");
  return host.innerHTML;
}

test("the Pad tab draws the locator beside the cut note and in its journal row", () => {
  const note = longNote(7);
  const cut = `- ${note.slice(0, 150)} [cut - full note j7]`;
  const pad = `${cut}\n- a short note`;
  const html = padPane({ notes: pad, lines: noteLines(pad), journal: [{ id: "j7", at: iso(), kind: "note", thread: null, text: note }] });
  assert.match(html, /data-as-notelocator="j7"/, "the row carries the id");
  assert.match(html, /\/200 · j7/, "and draws it beside the length");
  assert.match(html, /GET \/api\/state/, "the read path is named under the list");
  assert.match(html, /note j7/, "the journal row names the entry the line points at");
});
