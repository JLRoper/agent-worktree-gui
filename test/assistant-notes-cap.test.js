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
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { ASK_TEXT_CAP, NOTES_CAP } from "../lib/assistant/config.js";
import { appendNoteLine, fitNotesText, readNotesFile, writeNotesFile } from "../lib/assistant/notes-file.js";

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
  assert.doesNotMatch(source, /LINE_CAP/, "no second pad cap is left in the shell");
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
