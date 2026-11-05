// lib/matrix-reminders.js, the bridge's OWN reminder list and the read-only watches view beside it.
//
// What this pins:
//   1. add / complete / reopen / remove round-trip through the FILE — a second store reads what the first wrote,
//      so the panel is the source of truth rather than a process's memory;
//   2. a reminder is not a watch: it carries `kind: "bridge-reminder"`, no thread and no state, and lives in its
//      own array and its own file;
//   3. the watches view is a READ-ONLY projection: `readOnly` on every row and on the payload, and a body that
//      names a watch field is refused BEFORE the file moves;
//   4. the count, the cap and the two text refusals are the store's, so the route only maps codes to statuses;
//   5. the turn preamble carries both lists under headings that say who may write which, and is empty when there
//      is nothing to carry.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MATRIX_REMINDER_TEXT_MAX,
  MATRIX_REMINDERS_MAX,
  MatrixRemindersStore,
  matrixRemindersPreamble,
  watchesView,
} from "../lib/matrix-reminders.js";

async function scratch(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wag-matrix-reminders-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { file: path.join(dir, "state", "matrix-reminders.json") };
}

const WATCHES = [
  { id: "ab12cd34", thread: "t-1", title: "deploy watch", state: "watching", at: "2026-11-05T10:00:00.000Z", doneWhen: "deployed", minutes: 20, assistantId: "assistant-2" },
  { id: "ef56", thread: "t-2", title: "old watch", state: "done", at: "2026-11-01T10:00:00.000Z" },
];

test("a fresh panel has no reminders and says where the list would live", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixRemindersStore({ file });
  const out = store.payload();
  assert.deepEqual(out.reminders, []);
  assert.deepEqual(out.counts, { total: 0, open: 0, done: 0, cap: MATRIX_REMINDERS_MAX });
  assert.equal(out.saved, false);
  assert.equal(out.path.includes("\\"), false, "the page gets a forward-slash path");
  assert.ok(out.path.endsWith("matrix-reminders.json"));
});

test("add, complete, reopen and remove round-trip through the file", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixRemindersStore({ file });
  const added = store.add({ text: "check the deploy", due: "after lunch" });
  assert.equal(added.kind, "bridge-reminder");
  assert.equal(added.text, "check the deploy");
  assert.equal(added.due, "after lunch");
  assert.equal(added.doneAt, null);
  assert.match(added.id, /^br-/);

  // A SECOND store reads the bytes, not a cache — the panel's file is the list.
  const reread = new MatrixRemindersStore({ file }).payload();
  assert.equal(reread.reminders.length, 1);
  assert.equal(reread.reminders[0].text, "check the deploy");
  assert.equal(reread.counts.open, 1);

  const done = new MatrixRemindersStore({ file }).apply({ id: added.id, done: true });
  assert.equal(done.counts.open, 0);
  assert.equal(done.counts.done, 1);
  assert.ok(done.reminders[0].doneAt, "completing stamps a time; it does not move a card");

  const reopened = new MatrixRemindersStore({ file }).apply({ id: added.id, done: false });
  assert.equal(reopened.reminders[0].doneAt, null);

  const removed = new MatrixRemindersStore({ file }).apply({ id: added.id, remove: true });
  assert.deepEqual(removed.reminders, []);
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(onDisk.reminders, [], "the file is the record, and it is empty again");
});

test("a reminder is not a watch: no thread, no state, and its own array", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixRemindersStore({ file, watches: () => WATCHES });
  store.add({ text: "call the dentist" });
  const out = store.payload();
  const [reminder] = out.reminders;
  assert.equal("thread" in reminder, false);
  assert.equal("state" in reminder, false);
  assert.equal(reminder.kind, "bridge-reminder");
  assert.equal(out.watches.length, 2, "the assistants' list is reported beside it, not merged into it");
  assert.equal(out.watches[0].kind, "watch");
  assert.equal(out.watches[0].thread, "t-1");
});

test("the watches view is read-only, and a body that asks to write one is refused before the file moves", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixRemindersStore({ file, watches: () => WATCHES });
  store.add({ text: "kept" });
  const before = await readFile(file, "utf8");

  const view = watchesView(WATCHES);
  assert.equal(view.length, 2);
  for (const row of view) assert.equal(row.readOnly, true, "every row says so on its own");
  assert.equal(store.payload().watchesReadOnly, true);

  for (const body of [
    { watches: [] },
    { watch: { title: "mine" } },
    { id: "ab12cd34", watchId: "ab12cd34", done: true },
    { watchState: "done", assistantId: "assistant-2" },
  ]) {
    assert.throws(
      () => store.apply(body),
      (e) => e.code === "reminder-watch-readonly" && /READ ONLY/.test(e.message),
      `${JSON.stringify(body)} must not write a watch`,
    );
  }
  assert.equal(await readFile(file, "utf8"), before, "a refused write leaves the reader's list alone");
  assert.equal(store.payload().reminders.length, 1);
});

test("the text, the cap and an unknown id are refusals with their own codes", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixRemindersStore({ file });
  assert.throws(() => store.add({ text: "  " }), (e) => e.code === "reminder-text-required");
  assert.throws(() => store.add({ text: "x".repeat(MATRIX_REMINDER_TEXT_MAX + 1) }), (e) => e.code === "reminder-too-long");
  assert.throws(() => store.apply({ id: "nope", done: true }), (e) => e.code === "reminder-not-found");
  assert.throws(() => store.apply({ id: "nope", remove: true }), (e) => e.code === "reminder-not-found");
  assert.throws(() => store.apply({ done: true }), (e) => e.code === "reminder-text-required", "no id and no text is not an add");
  assert.deepEqual(store.payload().reminders, [], "nothing was written by a refusal");
});

test("the list is full at its cap rather than growing without bound", async (t) => {
  const { file } = await scratch(t);
  const store = new MatrixRemindersStore({ file });
  store.write(Array.from({ length: MATRIX_REMINDERS_MAX }, (_, i) => ({ text: `reminder ${i}` })));
  assert.equal(store.payload().reminders.length, MATRIX_REMINDERS_MAX);
  assert.throws(() => store.add({ text: "one more" }), (e) => e.code === "reminders-full");
});

test("a hand-edited file cannot smuggle a field into a turn, and a broken one reads as no list", async (t) => {
  const { file } = await scratch(t);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ reminders: [{ text: "ok", thread: "t-1", state: "watching", id: "x" }] }), "utf8");
  const row = new MatrixRemindersStore({ file }).payload().reminders[0];
  assert.equal(row.thread, undefined, "a reminder never carries a watch's thread");
  assert.equal(row.state, undefined);
  assert.equal(row.kind, "bridge-reminder");

  await writeFile(file, "{ not json", "utf8");
  assert.deepEqual(new MatrixRemindersStore({ file }).payload().reminders, [], "an unreadable file is an empty list, not a crash");
});

test("the turn preamble carries both lists, says which is read-only, and is empty when there is nothing", async (t) => {
  const { file } = await scratch(t);
  const empty = new MatrixRemindersStore({ file, watches: () => [] });
  assert.equal(empty.payload().preamble, "", "no reminders and no watches injects nothing");
  const store = new MatrixRemindersStore({ file, watches: () => WATCHES });
  store.add({ text: "check the deploy", due: "17:00" });
  const preamble = store.payload().preamble;
  assert.match(preamble, /## Reminders you keep for the reader/);
  assert.match(preamble, /- \[ \] check the deploy — due 17:00/);
  assert.match(preamble, /## Assistants' watches — READ ONLY/);
  assert.match(preamble, /deploy watch — watching \(assistant-2, t-1\)/);
  assert.match(preamble, /never create, complete, re-title or delete one/);
  // The pure builder is the same one the payload uses, so a caller with its own lists cannot drift.
  assert.equal(matrixRemindersPreamble({ reminders: store.payload().reminders, watches: WATCHES }), preamble);
});
