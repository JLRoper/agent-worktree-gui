// The initiative note log: an append-only memory per initiative, with links as first-class rows.
//
// What this file is the contract for:
//
//   1. EVERY ENTRY CARRIES WHO AND WHEN. The reader types a note and an assistant logs one from a finished turn, so
//      `id` and `at` are the panel's (minted by the store) and `by` is the writer. A reload reads the same four
//      facts back, which is what makes the log worth keeping: an entry nobody can attribute is not memory.
//   2. A PASTED URL IS A LINK, WITH ITS HOST. A note whose whole text is one http(s) URL is `kind: "link"` and carries
//      `host` (jira / bitbucket / github / other), read from the URL's HOSTNAME - a page that merely mentions Jira in
//      its path is not a Jira ticket. The label is the reader's, and a duplicate URL is ONE ROW rather than five
//      copies of one ticket.
//   3. THE CAPS REFUSE. Unlike the title and the description (which clip), an over-long note, label or link is a
//      clean `{ ok: false, error }`, and a full log says so instead of dropping the oldest memory.
//   4. THE ASSISTANT HALF IS ONE LINE. `INITIATIVE NOTE <initiative> | <text>` parses as its own kind, is carried by
//      `applyActions` through the SAME store, and reads back `by` the assistant whose turn wrote it. A line naming an
//      initiative nobody has is refused in the journal, not silently dropped.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { actionGrammar, parseActions } from "../lib/assistant/actions.js";
import { scanCommands } from "../lib/assistant/audit.js";
import {
  Initiatives,
  NOTE_LABEL_MAX,
  NOTE_TEXT_MAX,
  NOTES_MAX,
  noteHostOf,
  noteUrlKey,
  noteUrlOf,
} from "../lib/initiatives.js";
import { initiativesView } from "../routes/initiatives.js";

const JIRA = "https://jira.prog.sefl.com/browse/DMR-39015";
const BITBUCKET = "https://bitbucket.prog.sefl.com/projects/DMR/repos/menu/pull-requests/4/overview";
const GITHUB = "https://github.com/JLRoper/agent-worktree-gui/pull/806";
const OTHER = "https://example.test/notes/on-the-migration";

function store(t, name = "notes") {
  const dir = mkdtempSync(path.join(tmpdir(), `wtgui-initiatives-${name}-`));
  const file = path.join(dir, "initiatives.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file, make: () => new Initiatives({ file, log: () => {} }) };
}

function seeded(t) {
  const box = store(t);
  const s = box.make();
  const id = s.create({ title: "SSO migration", description: "Menu and oauth2, one piece of work" }).initiative.id;
  return { ...box, s, id };
}

// ---- 1. the log itself ------------------------------------------------------------------------------------------
test("a note is appended with an id, a time and its author, and reads back newest first", (t) => {
  const { s, id, file } = seeded(t);
  const first = s.addNote({ initiative: id, text: "DMR-39015 is the ticket that started this", by: "reader" });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.match(first.note.id, /^note_/);
  assert.equal(first.note.kind, "note");
  assert.equal(first.note.by, "reader");
  assert.match(first.note.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.note.url, undefined, "a prose note carries no url");

  const second = s.addNote({ initiative: id, text: "shipped in 1.2.3", by: "assistant-3" });
  assert.equal(second.note.by, "assistant-3");

  // Newest first for the page, oldest first on disk: one order for the reader, one for a reader of the file.
  const list = s.notesFor(id);
  assert.deepEqual(list.map((n) => n.text), ["shipped in 1.2.3", "DMR-39015 is the ticket that started this"]);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.initiatives[0].notes.map((n) => n.text), ["DMR-39015 is the ticket that started this", "shipped in 1.2.3"]);
});

test("a note survives a reload: a second store over the same file reads the same entries", (t) => {
  const { make, id, s } = seeded(t);
  s.addNote({ initiative: id, text: "the version this first went out in is 1.169.7", by: "assistant-2" });
  s.addNote({ initiative: id, text: JIRA, by: "reader", label: "the ticket" });
  // A restart, in the panel's terms: a NEW object over the same path with nothing carried in memory.
  const reread = make();
  const notes = reread.notesFor(id);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].kind, "link");
  assert.equal(notes[0].host, "jira");
  assert.equal(notes[0].label, "the ticket");
  assert.equal(notes[0].by, "reader");
  assert.equal(notes[1].by, "assistant-2");
  assert.equal(notes[1].text, "the version this first went out in is 1.169.7");
});

// ---- 2. links: host, label, dedupe -------------------------------------------------------------------------------
test("a Jira, a Bitbucket and a GitHub url each land as a link with the right host", (t) => {
  const { s, id } = seeded(t);
  const jira = s.addNote({ initiative: id, text: JIRA }).note;
  const bitbucket = s.addNote({ initiative: id, text: BITBUCKET }).note;
  const github = s.addNote({ initiative: id, text: GITHUB }).note;
  const other = s.addNote({ initiative: id, text: OTHER }).note;
  assert.deepEqual([jira.host, bitbucket.host, github.host, other.host], ["jira", "bitbucket", "github", "other"]);
  for (const note of [jira, bitbucket, github, other]) {
    assert.equal(note.kind, "link");
    assert.equal(note.url, note.text, "a pasted url is its own text");
  }
  // The host comes from the hostname, never the path: a page that talks about Jira is not a Jira link.
  assert.equal(noteHostOf("https://wiki.example.test/jira/DMR-1"), "other");
  assert.equal(noteHostOf("https://jira.prog.sefl.com/browse/DMR-1"), "jira");
});

test("words around a url stay prose; only a note that IS one url becomes a link", (t) => {
  const { s, id } = seeded(t);
  const prose = s.addNote({ initiative: id, text: `see ${JIRA} before the next slice` }).note;
  assert.equal(prose.kind, "note");
  assert.equal(prose.url, undefined);
  assert.equal(noteUrlOf("see https://example.test/x"), null);
  assert.equal(noteUrlOf("ftp://example.test/x"), null);
});

test("a duplicate url is one row, whatever spelling the browser copied", (t) => {
  const { s, id } = seeded(t);
  const first = s.addNote({ initiative: id, text: JIRA, label: "DMR-39015" });
  assert.equal(first.changed, true);
  const again = s.addNote({ initiative: id, text: `${JIRA}/#comment-4` });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.note.id, first.note.id, "the row that already holds the reference is the answer");
  const upper = s.addNote({ initiative: id, text: JIRA.replace("jira.prog.sefl.com", "JIRA.PROG.SEFL.COM") });
  assert.equal(upper.changed, false, "a host is case-insensitive, so the same ticket is the same key");
  assert.equal(s.initiativeById(id).notes.length, 1, "one row per reference, not five copies of one ticket");
  // The reader's label is not overwritten by a later paste of the same url.
  assert.equal(s.notesFor(id)[0].label, "DMR-39015");
  assert.equal(noteUrlKey(`${JIRA}/`), noteUrlKey(JIRA));
});

test("a link's label is the reader's to set, and an edit sets it without rewriting the author", (t) => {
  const { s, id } = seeded(t);
  const made = s.addNote({ initiative: id, text: GITHUB, by: "reader" }).note;
  const edited = s.editNote({ initiative: id, note: made.id, label: "the landing PR", by: "assistant-2" });
  assert.equal(edited.ok, true);
  assert.equal(edited.note.label, "the landing PR");
  assert.equal(edited.note.host, "github", "the reference itself did not move");
  assert.equal(edited.note.by, "reader", "the author is the author");
  assert.equal(edited.note.editedBy, "assistant-2", "the editor is recorded beside it");
  assert.match(edited.note.editedAt, /^\d{4}-/);
});

// ---- 3. edit and delete ------------------------------------------------------------------------------------------
test("an edit changes the words and keeps who logged it and when", (t) => {
  const { s, id } = seeded(t);
  const made = s.addNote({ initiative: id, text: "the first wording", by: "reader" }).note;
  const edited = s.editNote({ initiative: id, note: made.id, text: "the decided wording", by: "assistant-3" });
  assert.equal(edited.ok, true);
  assert.equal(edited.note.text, "the decided wording");
  assert.equal(edited.note.at, made.at);
  assert.equal(edited.note.by, "reader");
  assert.equal(edited.note.editedBy, "assistant-3");
  // An edit that changes nothing is not a write.
  const same = s.editNote({ initiative: id, note: made.id, text: "the decided wording" });
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  // A prose note has no label to set.
  const proseLabel = s.editNote({ initiative: id, note: made.id, label: "nope" });
  assert.equal(proseLabel.ok, false);
  assert.match(proseLabel.error, /only a link carries a label/);
  // A link whose words are replaced by another url follows it, host and all.
  const link = s.addNote({ initiative: id, text: JIRA }).note;
  const moved = s.editNote({ initiative: id, note: link.id, text: GITHUB });
  assert.equal(moved.ok, true);
  assert.equal(moved.note.host, "github");
  assert.equal(moved.note.url, GITHUB);
});

test("a delete removes the one row and leaves the rest of the log", (t) => {
  const { s, id } = seeded(t);
  const keep = s.addNote({ initiative: id, text: "keep me" }).note;
  const drop = s.addNote({ initiative: id, text: "drop me" }).note;
  const out = s.deleteNote({ initiative: id, note: drop.id, by: "assistant-2" });
  assert.equal(out.ok, true);
  assert.equal(out.deleted.id, drop.id);
  assert.deepEqual(s.notesFor(id).map((n) => n.text), ["keep me"]);
  assert.equal(s.initiativeById(id).notes.length, 1);
  assert.equal(keep.id, s.notesFor(id)[0].id);
  // Deleting it again is a 404-shaped refusal, not a silent success.
  assert.equal(s.deleteNote({ initiative: id, note: drop.id }).notFound, true);
});

// ---- 4. refusals and caps ----------------------------------------------------------------------------------------
test("an unknown initiative or note is notFound, and an empty note is refused", (t) => {
  const { s, id } = seeded(t);
  assert.equal(s.addNote({ initiative: "init_missing", text: "x" }).notFound, true);
  const empty = s.addNote({ initiative: id, text: "   " });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /needs something to remember/);
  assert.equal(s.editNote({ initiative: id, note: "note_missing", text: "x" }).notFound, true);
  assert.equal(s.editNote({ initiative: id, note: "note_missing" }).notFound, true);
  assert.equal(s.notesFor("init_missing").length, 0);
});

test("the caps refuse cleanly: the text, the label, the url, and a full log", (t) => {
  const { s, id } = seeded(t);
  const overText = s.addNote({ initiative: id, text: "x".repeat(NOTE_TEXT_MAX + 1) });
  assert.equal(overText.ok, false);
  assert.equal(overText.cap, "note-text");
  assert.match(overText.error, new RegExp(String(NOTE_TEXT_MAX)));
  const overLabel = s.addNote({ initiative: id, text: JIRA, label: "x".repeat(NOTE_LABEL_MAX + 1) });
  assert.equal(overLabel.ok, false);
  assert.equal(overLabel.cap, "note-label");
  const notAUrl = s.addNote({ initiative: id, text: "a reference", url: "not-a-url" });
  assert.equal(notAUrl.ok, false);
  assert.equal(notAUrl.cap, "note-url");
  // A full log is a refusal that says what to do, not a silent drop of the oldest memory.
  const full = seeded(t);
  const doc = JSON.parse(readFileSync(full.file, "utf8"));
  doc.initiatives[0].notes = Array.from({ length: NOTES_MAX }, (_, at) => ({
    id: `note_${at}`,
    at: new Date(1_700_000_000_000 + at).toISOString(),
    by: "reader",
    kind: "note",
    text: `note ${at}`,
  }));
  writeFileSync(full.file, JSON.stringify(doc, null, 2), "utf8");
  const reread = full.make();
  assert.equal(reread.notesFor(full.id).length, NOTES_MAX);
  const refused = reread.addNote({ initiative: full.id, text: "one more" });
  assert.equal(refused.ok, false);
  assert.equal(refused.cap, "notes");
  assert.match(refused.error, /delete one/);
  // The log was not touched by the refusal.
  assert.equal(reread.notesFor(full.id).length, NOTES_MAX);
});

// ---- 5. the fold the tab draws -----------------------------------------------------------------------------------
test("the initiative read returns its notes newest first, with the caps beside the title's", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-initiatives-view-notes-"));
  try {
    const s = new Initiatives({ file: path.join(dir, "initiatives.json"), log: () => {} });
    const id = s.create({ title: "SSO migration" }).initiative.id;
    s.addNote({ initiative: id, text: "older", by: "reader" });
    s.addNote({ initiative: id, text: JIRA, by: "assistant-2", label: "DMR-39015" });
    const doc = initiativesView({ initiatives: s, projectForPath: () => null, rowFor: () => null });
    const init = doc.initiatives.find((i) => i.id === id);
    assert.equal(init.noteCount, 2);
    assert.deepEqual(init.notes.map((n) => n.text), [JIRA, "older"]);
    assert.equal(init.notes[0].host, "jira");
    assert.equal(doc.caps.notes, NOTES_MAX);
    assert.equal(doc.caps.noteText, NOTE_TEXT_MAX);
    assert.equal(doc.caps.noteLabel, NOTE_LABEL_MAX);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 6. the assistant half ---------------------------------------------------------------------------------------
test("INITIATIVE NOTE is one typed line: it parses as its own kind and is offered by the grammar", () => {
  const actions = parseActions("INITIATIVE NOTE SSO migration | DMR-39015 shipped in 1.169.7");
  assert.deepEqual(actions.initiativeNote, [{ initiative: "SSO migration", text: "DMR-39015 shipped in 1.169.7" }]);
  assert.equal(actions.note.length, 0, "it is not the assistant's own NOTE pad");
  const byId = parseActions("INITIATIVE NOTE init_abc | https://github.com/o/r/pull/1");
  assert.equal(byId.initiativeNote[0].initiative, "init_abc");
  // The ledger sees the line, so a turn that wrote it cannot be reconciled as if it wrote nothing.
  assert.deepEqual(scanCommands("INITIATIVE NOTE init_abc | x").map((e) => [e.kind, e.parsed]), [["initiativeNote", true]]);
  const grammar = actionGrammar({ spawn: "auto" }).join(String.fromCharCode(10));
  assert.match(grammar, /^INITIATIVE NOTE <initiative id or title> \|/m);
  assert.match(grammar, /work that OUTLIVES a tree is remembered/);
  // The Director is offered it too: memory is not a role's power.
  assert.match(actionGrammar({ spawn: "off" }, { director: true }).join(String.fromCharCode(10)), /^INITIATIVE NOTE/m);
});

async function panel(t, store) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-notes-assistant-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  writeFileSync(
    assistantFile,
    JSON.stringify({ version: 2, settings: { commandAudit: "report" }, notes: "", rules: [], watches: [], alerts: [], journal: [] }),
    "utf8",
  );
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
    initiatives: store,
    onLog: () => {},
  });
  return { assistant, dir };
}

test("an assistant logs a note from its own turn, and it reads back attributed to that assistant", async (t) => {
  const box = seeded(t);
  const { assistant } = await panel(t, box.s);
  const id = assistant.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  assert.equal(id, "assistant-2");
  const text = `INITIATIVE NOTE SSO migration | ${GITHUB}`;
  const turn = { id: "turn-note", thread: assistant.threadOf(id), status: "done", prompt: "", lines: [], startedAt: new Date().toISOString() };
  // The harvest is the path a real turn takes: parse, carry, settle. It is not `addNote` called by a test.
  const audit = assistant.openAudit(turn, text);
  await assistant.applyActions(turn, parseActions(text), audit);
  const notes = box.s.notesFor(box.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "link");
  assert.equal(notes[0].host, "github");
  assert.equal(notes[0].by, "assistant-2", "the entry names the assistant whose turn wrote the line");
  assert.ok(assistant.journal.some((j) => j.kind === "initiative-note" && /noted: https:\/\/github\.com/.test(j.text)));
  assert.equal(audit?.lines?.[0]?.outcome, "applied", "the ledger says the line was carried, not dropped");
});

test("a line naming an initiative nobody has is refused in the journal, not silently dropped", async (t) => {
  const box = seeded(t);
  const { assistant } = await panel(t, box.s);
  const turn = { id: "turn-bad", thread: assistant.threadOf("assistant-1"), status: "done", prompt: "" };
  await assistant.applyActions(turn, parseActions("INITIATIVE NOTE No Such Initiative | a reference"));
  assert.equal(box.s.notesFor(box.id).length, 0);
  assert.ok(assistant.journal.some((j) => j.kind === "initiative-note-refused" && /no such initiative/.test(j.text)));
});

test("a panel with no initiative store refuses the line by name instead of pretending it was logged", async (t) => {
  const box = seeded(t);
  const { assistant } = await panel(t, null);
  const turn = { id: "turn-none", thread: assistant.threadOf("assistant-1"), status: "done", prompt: "" };
  await assistant.applyActions(turn, parseActions("INITIATIVE NOTE SSO migration | a decision"));
  assert.equal(box.s.notesFor(box.id).length, 0);
  assert.ok(assistant.journal.some((j) => j.kind === "initiative-note-refused" && /no initiative store/.test(j.text)));
});
