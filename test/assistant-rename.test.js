// One assistant's NAME, renamed from its own Settings.
//
// What this file is the contract for:
//
//   1. THE RECORD IS THE STORE. `renameAssistant` writes the assistants file that `createAssistant` and `pickRole`
//      already own — the same one the tab label is painted from — and a NEW Assistant over the same directory reads the
//      new name back (a panel reload). Nothing is written to the queue, the profile or the charter.
//   2. THE ID DOES NOT MOVE. The record keeps `assistant-N`, `threadId`, `charterRel` and the queue path exactly as they
//      were, and the queue file's bytes are untouched: a rename is a label, not a hand-over.
//   3. THE INPUT IS TRIMMED AND CAPPED, and an empty or whitespace-only name is REFUSED with a code and a message — the
//      brief's "visible message rather than a silent no-op". Duplicates are allowed: the id disambiguates.
//   4. THE ROUTE RIDES THE SETTINGS ONE. `POST /api/assistant/settings` with a `name` answers with the record it wrote
//      and the whole assistant state, and a rename-only POST does not store `name` as a settings knob.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT, ASSISTANT_NAME_MAX, pickAssistantName } from "../lib/assistants.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-rename-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }), stop: async () => ({ ok: true }) },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  t.after(() => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
  });
  const created = assistant.createAssistant({ roleId: "assistant-agent-manager" });
  return { assistant, dir, assistantFile, assistantsFile: assistant.assistantsFile, id: created.created.id };
}

test("a rename is written to the assistant's record and survives a reload", async (t) => {
  const { assistant, dir, assistantsFile, id } = await panel(t);
  const rec = assistant.assistantRecord(id);
  const before = {
    name: rec.name,
    threadId: rec.threadId,
    charterRel: rec.charterRel,
    queue: assistant.queuePathOf(rec),
    charter: assistant.charterPathOf(rec),
    profile: assistant.profilePathOf(rec),
  };
  assert.equal(before.name, "Assistant #2", "the record starts with the derived name");

  const out = assistant.renameAssistant(id, "  Docs Reviewer  ");
  assert.equal(out.changed, true);
  assert.deepEqual(out.target, { id, name: "Docs Reviewer", threadId: before.threadId }, "the answer names the id the rename keeps");
  assert.equal(assistant.assistantRecord(id).name, "Docs Reviewer", "the live record carries it");

  // The store, not the in-memory record: a reload is a new Assistant over the same files.
  const onDisk = JSON.parse(await readFile(assistantsFile, "utf8"));
  assert.equal(onDisk.assistants.find((a) => a.id === id)?.name, "Docs Reviewer", "the name is on the assistant's record");

  // The id, and everything derived from it, did not move.
  const after = assistant.assistantRecord(id);
  assert.equal(after.id, id, "the id stays assistant-N");
  assert.equal(assistant.queuePathOf(after), before.queue, "the queue path did not move");
  assert.equal(assistant.charterPathOf(after), before.charter, "the charter path did not move");
  assert.equal(assistant.profilePathOf(after), before.profile, "the profile path did not move");
  assert.equal(after.threadId, before.threadId, "the thread did not move");

  const reloaded = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantsFile, defaultCwd: dir },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }), stop: async () => ({ ok: true }) },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  t.after(() => {
    if (reloaded.timer) clearInterval(reloaded.timer);
    if (reloaded.persistTimer) clearTimeout(reloaded.persistTimer);
  });
  assert.equal(reloaded.assistantRecord(id).name, "Docs Reviewer", "a panel reload reads the new name");
  assert.equal(reloaded.roster().find((a) => a.id === id)?.name, "Docs Reviewer", "the roster — what the page paints — agrees");
});

test("a rename does not write the queue file or the charter", async (t) => {
  const { assistant, id } = await panel(t);
  const rec = assistant.assistantRecord(id);
  const queueFile = assistant.queuePathOf(rec);
  const queueBefore = await readFile(queueFile, "utf8");
  const charterFile = assistant.charterPathOf(rec);
  const charterBefore = await readFile(charterFile, "utf8");

  assistant.renameAssistant(id, "Queue Keeper");

  assert.equal(await readFile(queueFile, "utf8"), queueBefore, "the queue file is byte-identical after a rename");
  assert.equal(await readFile(charterFile, "utf8"), charterBefore, "the charter is byte-identical after a rename");
});

test("the name is trimmed, capped at 40, and an empty one is refused with a message", async (t) => {
  const { assistant, assistantsFile, id } = await panel(t);

  assistant.renameAssistant(id, "   Two   Spaces   ");
  assert.equal(assistant.assistantRecord(id).name, "Two Spaces", "runs of whitespace fold to one space, and the ends are trimmed");

  const long = "x".repeat(ASSISTANT_NAME_MAX + 20);
  assistant.renameAssistant(id, long);
  assert.equal(assistant.assistantRecord(id).name.length, ASSISTANT_NAME_MAX, `the cap is ${ASSISTANT_NAME_MAX}`);
  assert.equal(pickAssistantName(long).length, ASSISTANT_NAME_MAX);

  const kept = assistant.assistantRecord(id).name;
  const before = await readFile(assistantsFile, "utf8");
  for (const empty of ["", "   ", "\n\t "]) {
    assert.throws(
      () => assistant.renameAssistant(id, empty),
      (e) => e.code === "name-invalid" && /cannot be empty/.test(e.message),
      `"${empty}" is refused with name-invalid`,
    );
  }
  assert.equal(assistant.assistantRecord(id).name, kept, "a refused rename left the name alone");
  assert.equal(await readFile(assistantsFile, "utf8"), before, "…and wrote nothing");

  // Duplicates are deliberately allowed: the id is what disambiguates.
  assistant.renameAssistant(PRIMARY_ASSISTANT, kept);
  assert.equal(assistant.assistantRecord(PRIMARY_ASSISTANT).name, kept, "two assistants may share a name");
  assert.notEqual(PRIMARY_ASSISTANT, id, "…and their ids still tell them apart");
});

test("a rename aimed at an id this panel does not have is refused, not filed onto Assistant #1", async (t) => {
  const { assistant } = await panel(t);
  const oneBefore = assistant.assistantRecord(PRIMARY_ASSISTANT).name;
  assert.throws(
    () => assistant.renameAssistant("assistant-9", "Nobody"),
    (e) => e.code === "assistant-unknown",
    "an unknown id is a refusal",
  );
  assert.equal(assistant.assistantRecord(PRIMARY_ASSISTANT).name, oneBefore, "Assistant #1 was not renamed");
});

test("POST /api/assistant/settings carries the rename and answers with the state a repaint needs", async (t) => {
  const panel = await startPanel({});
  t.after(() => panel.stop());

  const created = await post(panel.base, "/api/assistant/assistants", { body: { roleId: "assistant-agent-manager" } });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  const id = created.json.created.id;

  const renamed = await post(panel.base, "/api/assistant/settings", { body: { assistantId: id, name: "  Night Watch  " } });
  assert.equal(renamed.status, 200, renamed.text.slice(0, 300));
  assert.equal(renamed.json.renamed.target.id, id);
  assert.equal(renamed.json.renamed.target.name, "Night Watch", "the answer carries the trimmed name");
  assert.equal(renamed.json.renamed.changed, true);
  assert.equal(renamed.json.assistant.assistants.find((a) => a.id === id)?.name, "Night Watch", "the state the page repaints from agrees");
  assert.equal(renamed.json.settings.name, undefined, "the name is NOT stored as a settings knob");
  assert.equal(renamed.json.settings.autonomy, "draft", "a rename-only POST leaves the knobs alone");

  const reloaded = await fetch(`${panel.base}/api/assistant`).then((r) => r.json());
  assert.equal(reloaded.assistants.find((a) => a.id === id)?.name, "Night Watch", "a fresh read of the panel agrees");
  assert.equal(reloaded.assistantSettings[id].name, undefined, "no profile gained a `name` key");

  const same = await post(panel.base, "/api/assistant/settings", { body: { assistantId: id, name: "Night Watch" } });
  assert.equal(same.status, 200);
  assert.equal(same.json.renamed.changed, false, "saving the same name is answered as unchanged, not as a silent no-op");

  const empty = await post(panel.base, "/api/assistant/settings", { body: { assistantId: id, name: "   " } });
  assert.equal(empty.status, 400, `empty name refused: ${empty.text.slice(0, 200)}`);
  assert.match(empty.json.error, /cannot be empty/, "the refusal carries a sentence the pane can show");
  const after = await fetch(`${panel.base}/api/assistant`).then((r) => r.json());
  assert.equal(after.assistants.find((a) => a.id === id)?.name, "Night Watch", "the refused rename left the record alone");

  const unknown = await post(panel.base, "/api/assistant/settings", { body: { assistantId: "assistant-9", name: "Ghost" } });
  assert.equal(unknown.status, 404, "an unknown assistant is a 404");
});
