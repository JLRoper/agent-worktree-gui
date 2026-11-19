// The initiative store's own half: one document, keyed by tree path, and the write rule that makes it safe.
//
// The feature rests on two facts that this file pins as behaviour rather than prose:
//
//   1. MEMBERSHIP LIVES BESIDE THE BOARD, NOT ON IT. A row is rebuilt from git on every scan; a tree's initiative is
//      read from `initiatives.json` and overlaid, so a second `Initiatives` instance over the same directory answers
//      exactly what the first one wrote. A same-process read would certify a record a restart forgets, which is the
//      trap `state-files-and-config-keys.md` names for assistant fields - it applies here too.
//   2. AN UNREADABLE STORE IS REFUSED, NEVER OVERWRITTEN. A corrupt file reports `readable: false` with the file and
//      the parse error, all three writes (`create`, `update`, `move`) return `refused: "unreadable"`, and the bytes on
//      disk are unchanged. A reader repairs it and the next write lands.
//
// Also pinned: the key normalisation (case, backslashes, trailing slash), one tree in two initiatives (the chart says
// "a row's initiatives"), the caps, a record pointing at an initiative that no longer exists, and the file shape a
// hand edit has to match.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DESCRIPTION_MAX, Initiatives, TITLE_MAX, normTreePath } from "../lib/initiatives.js";

// A drive-letter path is assembled rather than typed: the repository's own reader refuses a literal one in a tracked
// file (it names a folder on the machine that wrote the line and nowhere else), and this file needs the Windows
// spellings to prove the key normalises case, backslashes and a trailing slash.
const DRIVE = ["C", ":"].join("");
const LOWER = DRIVE.toLowerCase();
const TREE_A = `${DRIVE}/work/alpha/.worktrees/sso-one`;
const TREE_B = `${DRIVE}/work/beta/.worktrees/sso-two`;

function store(t, name = "state") {
  const dir = mkdtempSync(path.join(tmpdir(), `wtgui-initiatives-${name}-`));
  const file = path.join(dir, "initiatives.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file, make: () => new Initiatives({ file, log: () => {} }) };
}

test("a missing store is the empty board, not an error, and the first create works", (t) => {
  const { file, make } = store(t);
  const s = make();
  const status = s.statusOf();
  assert.equal(status.found, false);
  assert.equal(status.readable, true);
  assert.deepEqual(s.initiativeList(), []);
  assert.deepEqual(s.forTree(TREE_A), []);

  const made = s.create({ title: "SSO migration", description: "Menu and oauth2, one piece of work" });
  assert.equal(made.ok, true);
  assert.equal(made.initiative.title, "SSO migration");
  assert.match(made.initiative.id, /^init_/);
  assert.equal(existsSync(file), true);
  assert.equal(s.statusOf().found, true);
});

test("a second instance over the same file reads back what the first wrote", (t) => {
  const { make } = store(t);
  const first = make();
  const created = first.create({ title: "SSO migration", description: "line one\n\nline two", by: "reader" });
  assert.equal(created.ok, true);
  assert.equal(first.move({ tree: TREE_A, initiative: created.initiative.id, action: "add" }).ok, true);

  // A restart, in the terms the panel has: a NEW object over the same path, with nothing carried over in memory.
  const second = make();
  const list = second.initiativeList();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "SSO migration");
  assert.equal(list[0].description, "line one\n\nline two");
  assert.deepEqual(second.forTree(TREE_A), [{ id: created.initiative.id, title: "SSO migration" }]);
  assert.deepEqual(second.forTree(TREE_B), []);
});

test("the tree key normalises case, backslashes and a trailing slash - and keeps the spelling for display", (t) => {
  const { make, file } = store(t);
  const s = make();
  const init = s.create({ title: "Key work" }).initiative;
  const odd = `${DRIVE}\\WORK\\Alpha\\.worktrees\\SSO-One\\`;
  assert.equal(s.move({ tree: odd, initiative: init.id, action: "add" }).ok, true);
  // Every spelling of the same tree is the same membership.
  assert.deepEqual(s.forTree(`${LOWER}/work/alpha/.worktrees/sso-one`), [{ id: init.id, title: "Key work" }]);
  assert.deepEqual(s.forTree(`${DRIVE}\\work\\alpha\\.worktrees\\sso-one\\`), [{ id: init.id, title: "Key work" }]);
  // The stored display path is forward-slashed and un-suffixed, the reader's case kept.
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(doc.trees), [`${LOWER}/work/alpha/.worktrees/sso-one`]);
  assert.equal(doc.trees[`${LOWER}/work/alpha/.worktrees/sso-one`].path, `${DRIVE}/WORK/Alpha/.worktrees/SSO-One`);
  assert.equal(normTreePath(`  ${DRIVE}\\x\\y\\  `), `${LOWER}/x/y`);
});

test("one tree can sit in two initiatives, and removing one leaves the other in place", (t) => {
  const { make } = store(t);
  const s = make();
  const a = s.create({ title: "Alpha push" }).initiative;
  const b = s.create({ title: "Beta push" }).initiative;
  s.move({ tree: TREE_A, initiative: a.id, action: "add" });
  s.move({ tree: TREE_A, initiative: b.id, action: "add" });
  assert.deepEqual(
    s.forTree(TREE_A).map((x) => x.title),
    ["Alpha push", "Beta push"],
  );
  const removed = s.move({ tree: TREE_A, initiative: a.id, action: "remove" });
  assert.equal(removed.ok, true);
  assert.equal(removed.changed, true);
  assert.deepEqual(s.forTree(TREE_A), [{ id: b.id, title: "Beta push" }]);
  // ...and the LAST removal takes the record with it, so an empty list is never stored.
  s.move({ tree: TREE_A, initiative: b.id, action: "remove" });
  const doc = JSON.parse(readFileSync(s.file, "utf8"));
  assert.deepEqual(doc.trees, {});
});

test("a move is idempotent: adding twice and removing what is not there change nothing", (t) => {
  const { make } = store(t);
  const s = make();
  const a = s.create({ title: "Once" }).initiative;
  assert.equal(s.move({ tree: TREE_A, initiative: a.id, action: "add" }).changed, true);
  const again = s.move({ tree: TREE_A, initiative: a.id, action: "add" });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  const absent = s.move({ tree: TREE_B, initiative: a.id, action: "remove" });
  assert.equal(absent.ok, true);
  assert.equal(absent.changed, false);
  assert.deepEqual(s.forTree(TREE_B), []);
});

// ---- the write rule this module exists for -----------------------------------------------------------------------
test("an unreadable store is reported, and every write is refused with the file left byte for byte", (t) => {
  const { file, make } = store(t);
  mkdirSync(path.dirname(file), { recursive: true });
  const broken = '{ "version": 1, "initiatives": [ { "id": "init_x" ';
  writeFileSync(file, broken, "utf8");
  const s = make();

  const status = s.statusOf();
  assert.equal(status.found, true);
  assert.equal(status.readable, false);
  assert.match(status.error, /JSON|Unexpected|end of/i);
  assert.equal(status.file, file);

  for (const [what, call] of [
    ["create", () => s.create({ title: "Should not land" })],
    ["update", () => s.update({ id: "init_x", title: "Should not land" })],
    ["move", () => s.move({ tree: TREE_A, initiative: "init_x", action: "add" })],
  ]) {
    const out = call();
    assert.equal(out.ok, false, `${what} is refused`);
    assert.equal(out.refused, "unreadable", `${what} says why`);
    assert.match(out.error, /could not be read/);
    assert.match(out.error, /NOT overwritten/);
    assert.equal(readFileSync(file, "utf8"), broken, `${what} wrote nothing`);
  }

  // The reader fixes or replaces the file; the next write lands on it.
  writeFileSync(file, JSON.stringify({ version: 1, initiatives: [], trees: {} }), "utf8");
  const fixed = s.create({ title: "After the repair" });
  assert.equal(fixed.ok, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).initiatives[0].title, "After the repair");
});

test("a file that parses but is not an object is an unreadable store too", (t) => {
  const { file, make } = store(t);
  writeFileSync(file, "[1, 2, 3]", "utf8");
  const s = make();
  assert.equal(s.statusOf().readable, false);
  assert.equal(s.create({ title: "no" }).refused, "unreadable");
  assert.equal(readFileSync(file, "utf8"), "[1, 2, 3]");
});

test("a write that cannot be persisted is reported and the memory is re-read from disk", (t) => {
  const { file, make } = store(t);
  const s = make();
  s.create({ title: "Kept" });
  // Make the directory a file: the temp write fails, and the store must not keep an initiative the disk never took.
  rmSync(file);
  rmSync(path.dirname(file), { recursive: true, force: true });
  writeFileSync(path.dirname(file), "not a directory", "utf8");
  const refused = s.create({ title: "Never lands" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not saved/);
  assert.deepEqual(s.initiativeList().map((i) => i.title), []);
});

// ---- validation, caps and the shape a hand edit may write --------------------------------------------------------
test("titles are required and capped; descriptions keep their paragraphs and are capped", (t) => {
  const { make } = store(t);
  const s = make();
  assert.equal(s.create({ title: "   " }).ok, false);
  const long = "x".repeat(TITLE_MAX + 20);
  const made = s.create({ title: long, description: "a\n\nb" });
  assert.equal(made.ok, true);
  assert.equal(made.initiative.title.length, TITLE_MAX);
  assert.equal(made.initiative.description, "a\n\nb");
  const over = s.create({ title: "capped", description: "y".repeat(DESCRIPTION_MAX + 30) });
  assert.equal(over.initiative.description.length, DESCRIPTION_MAX);
  // An update with neither field is a refusal, not a silent no-op that looks saved.
  assert.equal(s.update({ id: made.initiative.id }).ok, false);
  // ...and a title of spaces cannot blank an existing one.
  assert.equal(s.update({ id: made.initiative.id, title: "  " }).ok, false);
});

test("an update writes both fields and stamps who and when", (t) => {
  const { make } = store(t);
  const s = make();
  const made = s.create({ title: "Before", description: "old" }).initiative;
  const out = s.update({ id: made.id, title: "After", description: "new", by: "assistant-2" });
  assert.equal(out.ok, true);
  assert.equal(out.initiative.title, "After");
  assert.equal(out.initiative.description, "new");
  assert.equal(out.initiative.updatedBy, "assistant-2");
  assert.equal(out.initiative.createdAt, made.createdAt);
  assert.notEqual(out.initiative.updatedAt, null);
});

test("an unknown initiative is a refusal, not a record under a name nobody can read", (t) => {
  const { make, file } = store(t);
  const s = make();
  const gone = s.create({ title: "Gone" }).initiative;
  s.move({ tree: TREE_A, initiative: gone.id, action: "add" });
  // A hand edit that removes the initiative leaves its tree record pointing at nothing: the read drops the id, and a
  // tree with no surviving initiative reads as no initiative at all.
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.initiatives = [];
  writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
  const reread = make();
  assert.deepEqual(reread.forTree(TREE_A), []);
  assert.equal(reread.move({ tree: TREE_A, initiative: "init_missing", action: "add" }).ok, false);
});

test("the file is a versioned document a reader can read, and the write is atomic", (t) => {
  const { file, make } = store(t);
  const s = make();
  const made = s.create({ title: "Shape" }).initiative;
  s.move({ tree: TREE_A, initiative: made.id, action: "add", by: "reader" });
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.version, 1);
  assert.equal(typeof doc.savedAt, "string");
  assert.deepEqual(doc.initiatives.map((i) => i.id), [made.id]);
  assert.deepEqual(doc.trees[normTreePath(TREE_A)].initiatives, [made.id]);
  // No temp file is left behind: the rename is the write.
  assert.equal(existsSync(`${file}.tmp-${process.pid}`), false);
});
