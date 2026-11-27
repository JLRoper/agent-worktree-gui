// The scratchpad cap, and the one-time condensation that brought the four live pads inside it.
//
// The defect this file is the contract for: `preamble()` has always clipped a pad at 1,200 characters, while the
// STORE accepted 8,000. So a pad could hold 6,800 characters no turn ever read — and the four live pads did exactly
// that: 8,000, 8,002, 6,263 and 8,000 bytes of mostly-duplicated lines. The durable half of each was moved into that
// assistant's charter and the cap was cut to the number a turn reads, so the file cannot grow back past it.
//
// Three claims, one test each:
//   1. the cap IS the clip — one number in one place, and a save over it is REFUSED rather than trimmed;
//   2. every condensed pad fits the cap (read from the live panel state when this checkout has one);
//   3. every durable item moved out of a pad is readable in the charter it moved to.
//
// Plus the pad's other half: an assistant's own NOTE line still lands when the pad is full (the OLDEST lines go),
// and a note whose assistant the roster does not hold is refused rather than written into #1's memory.
//
// And the per-note half: a single NOTE is CLIPPED to `NOTE_LINE_CAP` at a word boundary with `NOTE_CLIP_MARK`, so
// three 500-character notes are three capped lines with NONE evicted (before this, the third pushed the first out);
// the full text of each goes to the journal instead of the pad; the Pad tab draws every note's own length beside
// it; and the reader's save over `NOTES_CAP` is still refused with the same sentence and the route's 413.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { parseActions } from "../lib/assistant/actions.js";
import { ASK_TEXT_CAP, NOTE_LINE_CAP, NOTES_CAP } from "../lib/assistant/config.js";
import {
  appendNoteLine,
  clipNoteLine,
  fitNotesText,
  noteLines,
  noteLocatorOf,
  readNotesFile,
  writeNotesFile,
  NOTE_CLIP_MARK,
} from "../lib/assistant/notes-file.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { post, sliceRegion, startPanel } from "../tools/panel-testkit.mjs";

const here = (rel) => new URL(rel, import.meta.url);
const manifest = JSON.parse(readFileSync(here("./fixtures/notes-condensation.json"), "utf8"));

// The live panel's state directory. A checkout that has never run a panel has none, and the two live-state tests
// SKIP there rather than pretending: the claim is about the pads on the machine, and a machine without them has
// nothing to prove.
const stateDir = process.env.WTGUI_STATE_DIR || path.join(os.homedir(), ".wag", "state");
const hasState = existsSync(path.join(stateDir, "assistant.json"));
const skipNoState = hasState ? false : `no panel state at ${stateDir}`;

/** One assistant's pad as the panel reads it: #1's is a field in assistant.json, every other is its own file. */
function padOf(entry) {
  if (entry.pad.endsWith("#notes")) return JSON.parse(readFileSync(path.join(stateDir, "assistant.json"), "utf8")).notes || "";
  return readFileSync(path.join(stateDir, entry.pad), "utf8");
}

test("the pad cap is the number a turn actually reads, and the ask text has its own", () => {
  const source = readFileSync(here("../lib/assistant.js"), "utf8");
  assert.equal(NOTES_CAP, 1200, "the cap is the clip's number");
  assert.ok(source.includes(`clip(notes, ${NOTES_CAP})`), "preamble() clips the pad at exactly this number");
  // The one LINE_CAP left is the per-note cap, which is not a second pad cap: it clips one appended NOTE before
  // the pad's own cap ever sees it (lib/assistant/notes-file.js `clipNoteLine`).
  assert.ok(!/\bLINE_CAP\b/.test(source.replace(/NOTE_LINE_CAP/g, "")), "no second pad cap is left in the shell");
  assert.equal(ASK_TEXT_CAP, 8000, "the finished-card ask keeps its own length guard");
  assert.ok(source.includes("ASK_TEXT_CAP"), "and the ask still reads it");
});

test("a save over the cap is refused, and the file keeps exactly what it held", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-notes-cap-"));
  const file = path.join(dir, "assistants", "assistant-3", "notes.md");
  try {
    const kept = writeNotesFile(file, "k".repeat(NOTES_CAP));
    assert.equal(kept.chars, NOTES_CAP, "a pad at the cap is written whole");
    const refused = writeNotesFile(file, "x".repeat(NOTES_CAP + 1));
    assert.equal(refused.refused, true, "one character over is refused");
    assert.equal(refused.code, "notes-too-long");
    assert.equal(refused.chars, NOTES_CAP, "the answer reports the bytes still on disk");
    assert.equal(readNotesFile(file).text, "k".repeat(NOTES_CAP), "and the file was not touched");
    assert.equal(readNotesFile(file).over, false, "the file on disk is never over the cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a full pad still takes the assistant's next NOTE, dropping the OLDEST lines", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-notes-append-"));
  const file = path.join(dir, "assistants", "assistant-2", "notes.md");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${"- old line\n".repeat(200)}- NEWEST LINE`);
    const out = appendNoteLine(file, "the line this turn wrote");
    assert.equal(out.appended, true, "the new line landed");
    assert.ok(out.text.length <= NOTES_CAP, "and the pad fits the cap");
    assert.match(out.text, /the line this turn wrote/, "the newest line is kept");
    assert.ok((out.text.match(/- old line/g) || []).length < 200, "the oldest of the long list went to make room");
    assert.equal(fitNotesText(out.text), out.text, "what was written is already the fitted text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a note for an assistant the roster does not hold is refused, never written to #1", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-notes-owner-"));
  const assistantFile = path.join(dir, "assistant.json");
  writeFileSync(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "PRIMARY-PAD", rules: [], alerts: [], journal: [] }));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => [], get: () => null, firstOfThread: () => null, create: async () => ({}) },
    getProjects: () => [],
    onLog: () => {},
  });
  try {
    assert.throws(() => assistant.appendNote("assistant-99", "a stranger's line"), /no such assistant/);
    assert.equal(assistant.notesFor("assistant-1"), "PRIMARY-PAD", "#1's pad is not the fallback for a typo");
    assert.ok(!assistant.notesFor("assistant-1").includes("a stranger's line"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every condensed pad fits the cap a turn reads", { skip: skipNoState }, () => {
  for (const entry of manifest.assistants) {
    const text = padOf(entry);
    // The pad on disk may have taken a NOTE since the condensation (that is the pad working). What must hold is the
    // cap, and that it never grows back near the store size the condensation removed.
    assert.ok(text.length <= manifest.cap, `${entry.id}: ${text.length} chars is over the ${manifest.cap}-char cap`);
    assert.ok(text.length < entry.beforeBytes, `${entry.id}: the pad really shrank (${entry.beforeBytes} bytes before)`);
    assert.ok(entry.afterChars <= manifest.cap, `${entry.id}: the condensed size the report records fits the cap too`);
  }
});

test("every durable item moved is readable in the charter it moved to", { skip: skipNoState }, () => {
  for (const entry of manifest.assistants) {
    const charter = readFileSync(path.join(stateDir, entry.charter), "utf8");
    assert.ok(charter.includes(manifest.section), `${entry.id}: the charter carries the moved-facts section`);
    for (const item of entry.items) {
      assert.ok(charter.includes(item.marker), `${entry.id}/${item.id}: "${item.marker}" is readable in ${entry.charter}`);
    }
  }
});

// ---- the per-note cap: one long NOTE is clipped at a word boundary, and the full text is journalled --------------

const sentence = (n) => `the notes are ${n} characters and the cap is ${NOTES_CAP} — a turn reads only ${NOTES_CAP}; prune the oldest lines and save again`;

/** A 500-character note, distinct per index, built from whole words so the clip has a boundary to find. */
function longNote(n) {
  const body = `note ${n} ` + Array.from({ length: 120 }, (_, i) => `fact${n}-${i}`).join(" ");
  return body.slice(0, 500);
}

/** One panel over a temp state directory, enough for `applyActions` and the two pad owners. */
function panel(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-notes-line-"));
  const assistantFile = path.join(dir, "assistant.json");
  writeFileSync(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const rows = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs: { list: () => rows, get: (id) => rows.find((j) => j.id === id) || null, firstOfThread: (thread) => rows.find((j) => j.thread === thread) || null, create: async (body) => ({ id: `job-${rows.length + 1}`, ...body }) },
    getProjects: () => [],
    onLog: () => {},
  });
  t.after(() => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
    rmSync(dir, { recursive: true, force: true });
  });
  const notesFile = (id) => path.join(dir, "assistants", id, "notes.md");
  const turnOf = (id) => ({ id: `turn-${id}`, thread: assistant.threadOf(id) });
  return { assistant, dir, notesFile, turnOf };
}

test("the per-note cap sits beside the pad's, and a clipped line keeps whole words with a marker", () => {
  assert.equal(NOTE_LINE_CAP, 200, "one NOTE's stored line is capped at 200");
  assert.ok(NOTE_LINE_CAP < NOTES_CAP, "and the line fits the pad several times over");
  const words = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
  const cut = clipNoteLine(words);
  assert.equal(cut.clipped, true, "a 600-character line is clipped");
  assert.ok(cut.text.length + 2 <= NOTE_LINE_CAP, `the stored line is ${cut.text.length + 2} chars, at or under ${NOTE_LINE_CAP}`);
  assert.ok(cut.text.endsWith(NOTE_CLIP_MARK), "the clip is visible");
  const kept = cut.text.slice(0, -NOTE_CLIP_MARK.length);
  assert.ok(words.startsWith(`${kept} `), "the cut is on a word boundary, never inside a word");
  const whole = clipNoteLine("a short note");
  assert.deepEqual(whole, { text: "a short note", clipped: false, dropped: 0 }, "a line that fits is untouched");
});

test("three 500-character NOTEs are three capped lines in the file, with none evicted", () => {
  const notes = [1, 2, 3].map(longNote);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "wtgui-notes-three-")), "assistants", "assistant-2", "notes.md");
  try {
    for (const note of notes) {
      const out = appendNoteLine(file, note);
      assert.equal(out.appended, true, "each line landed");
      assert.equal(out.full, note, "the caller gets the FULL text back");
      assert.equal(out.clipped, true, "and is told the pad line was clipped");
    }
    const lines = readNotesFile(file).text.split("\n");
    assert.equal(lines.length, 3, "three notes, three lines - the third does not push the first out");
    for (const line of lines) {
      assert.ok(line.length <= NOTE_LINE_CAP, `${line.length} chars is at or under ${NOTE_LINE_CAP}`);
      assert.ok(line.endsWith(NOTE_CLIP_MARK), "each capped line carries the marker");
    }
    for (const note of notes) assert.ok(!lines.some((line) => line.includes(note)), "the pad holds the cap, not the full note");
  } finally {
    rmSync(path.dirname(path.dirname(path.dirname(file))), { recursive: true, force: true });
  }
});

test("the NOTE action caps the pad line and journals the full text, on #1's pad and on an extra assistant's", async (t) => {
  const { assistant, notesFile, turnOf } = panel(t);
  const two = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  assert.equal(two, "assistant-2");
  const notes = [1, 2, 3].map(longNote);

  for (const note of notes) await assistant.applyActions(turnOf(PRIMARY_ASSISTANT), parseActions(`NOTE: ${note}`));
  const primary = assistant.notesFor(PRIMARY_ASSISTANT).split("\n");
  assert.equal(primary.length, 3, "#1's pad has three lines: none evicted");
  for (const line of primary) {
    assert.ok(line.length <= NOTE_LINE_CAP, `#1's line is ${line.length}, at or under ${NOTE_LINE_CAP}`);
    assert.ok(noteLocatorOf(line), "with the journal entry's locator in the marker");
  }
  const firstEntry = assistant.journal.find((j) => j.id === noteLocatorOf(primary[0]));
  assert.equal(firstEntry?.text, notes[0], "the marker's id resolves to the note's full text");

  for (const note of notes) await assistant.applyActions(turnOf(two), parseActions(`NOTE: ${note}`));
  const theirs = readFileSync(notesFile(two), "utf8").split("\n");
  assert.equal(theirs.length, 3, "#2's own notes.md has three lines: none evicted");
  for (const line of theirs) {
    assert.ok(line.length <= NOTE_LINE_CAP, `#2's line is ${line.length}, at or under ${NOTE_LINE_CAP}`);
    assert.ok(noteLocatorOf(line), "with the journal entry's locator in the marker");
  }
  const thirdEntry = assistant.journal.find((j) => j.id === noteLocatorOf(theirs[2]));
  assert.equal(thirdEntry?.text, notes[2], "and #2's marker resolves the same way");

  const journalled = assistant.journal.filter((j) => j.kind === "note").map((j) => j.text);
  assert.deepEqual(journalled, [...notes, ...notes], "the journal holds each full text, for both pads");
});

test("the pad payload carries every note's own length, and #1's state carries the same", async (t) => {
  const { assistant, turnOf } = panel(t);
  const notes = [1, 2, 3].map(longNote);
  for (const note of notes) await assistant.applyActions(turnOf(PRIMARY_ASSISTANT), parseActions(`NOTE: ${note}`));

  const payload = assistant.notesPayloadFor(PRIMARY_ASSISTANT);
  assert.equal(payload.noteCap, NOTE_LINE_CAP, "the payload names the per-note cap");
  assert.equal(payload.lines.length, 3, "one row per note");
  assert.deepEqual(payload.lines.map((l) => l.cap), [NOTE_LINE_CAP, NOTE_LINE_CAP, NOTE_LINE_CAP]);
  assert.ok(payload.lines.every((l) => l.chars <= NOTE_LINE_CAP), "each row's length is the stored line's, at or under the cap");
  assert.ok(payload.lines.every((l) => l.clipped), "and says the line was clipped");
  const state = assistant.state();
  assert.equal(state.noteCap, NOTE_LINE_CAP);
  assert.deepEqual(state.noteLines, payload.lines, "the polled state and the tab's read are one set of numbers");
  assert.deepEqual(noteLines(payload.notes), payload.lines);
});

// The page: drive the Pad region out of public/assistant.js, as the other pad tests do, with the payload the
// server sends. The claim is about HTML: each note's own length is drawn beside it, not only the total.
const page = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const escHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function padPane({ who, notes, lines, noteCap, cap = NOTES_CAP }) {
  const paneIdFor = (id, sub) => (id === "assistant-1" ? `as-${sub}` : `as-${sub}-${id.replace(/^assistant-/, "")}`);
  const hosts = new Map([paneIdFor("assistant-1", "pad"), paneIdFor("assistant-2", "pad")].map((id) => [id, { innerHTML: "" }]));
  const host = hosts.get(paneIdFor(who, "pad"));
  const state = { assistant: { notes, notesCap: cap, noteCap, noteLines: lines, rules: [], journal: [] }, assistantView: { assistant: who, subTab: "pad" } };
  const recordFor = (id) => ({ id, name: id === "assistant-1" ? "Assistant #1" : "Assistant #2", rules: [] });
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
  )(state, (id) => hosts.get(id) || null, escHtml, () => false, (id, sub) => hosts.get(paneIdFor(id, sub)) || null, paneIdFor, () => who, () => who, recordFor, "assistant-1", () => Promise.resolve({ ok: true, json: async () => ({}) }));
  api.renderAssistantPad(true, who);
  return host.innerHTML;
}

test("the Pad tab draws each note's own length beside it, not only the total counter", () => {
  const notes = [1, 2, 3].map(longNote);
  const pad = notes.map((note) => `- ${clipNoteLine(note).text}`).join("\n");
  const lines = noteLines(pad);
  const html = padPane({ who: "assistant-1", notes: pad, lines, noteCap: NOTE_LINE_CAP });
  assert.match(html, /Each note, with its own length:/, "the per-note list is drawn");
  const rows = html.match(/data-as-notelen="\d+" data-as-notecap="200"/g) || [];
  assert.equal(rows.length, 3, "one row per note, each carrying its own length against the per-note cap");
  for (const line of lines) assert.match(html, new RegExp(`data-as-notelen="${line.chars}"`), `the row for ${line.chars} chars is drawn`);
  assert.match(html, new RegExp(`${pad.length}/${NOTES_CAP} chars`), "the pad's total is still there");
  assert.doesNotMatch(html, new RegExp(`>${pad.length}/200<`), "the per-note numbers are not the pad's total");
});

test("the reader's save over the pad's cap is still refused with the same sentence, and the route answers 413", async (t) => {
  const { assistant } = panel(t);
  const kept = assistant.setNotesFor(PRIMARY_ASSISTANT, "k".repeat(NOTES_CAP));
  assert.equal(kept.chars, NOTES_CAP, "a save at the cap lands whole");
  assert.throws(
    () => assistant.setNotesFor(PRIMARY_ASSISTANT, "x".repeat(NOTES_CAP + 1)),
    (err) => err.code === "notes-too-long" && err.message === sentence(NOTES_CAP + 1),
    "one character over is refused with the sentence the pad has always used",
  );
  assert.equal(assistant.notes.length, NOTES_CAP, "and the pad is untouched");

  const panelProcess = await startPanel({ token: "notes-cap-test" });
  t.after(() => panelProcess.stop());
  const over = await post(panelProcess.base, "/api/assistant/notes", {
    token: "notes-cap-test",
    body: { assistantId: PRIMARY_ASSISTANT, text: "x".repeat(NOTES_CAP + 1) },
  });
  assert.equal(over.status, 413, "the route's own status for too big");
  assert.equal(over.json.error, sentence(NOTES_CAP + 1), "with the same sentence");
  const at = await post(panelProcess.base, "/api/assistant/notes", {
    token: "notes-cap-test",
    body: { assistantId: PRIMARY_ASSISTANT, text: "k".repeat(NOTES_CAP) },
  });
  assert.equal(at.status, 200, "a save at the cap still lands");
  assert.equal(at.json.chars, NOTES_CAP);
});
