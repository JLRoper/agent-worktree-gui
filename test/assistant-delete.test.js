// Deleting one assistant from its own Settings tab: the refusal, the archive and the roster.
//
// The brief's three proofs, in order:
//
//   1. A REFUSAL NAMES THE BLOCKING RUN OR ROW. A run on the assistant's thread and any queue row that is
//      not done both refuse with the route's own sentence, and that sentence carries the job id and thread,
//      or the row's id and title. Nothing is written: the roster, the archive and the files are untouched.
//   2. THE ARCHIVE EXISTS AFTER A DELETE. The record, the queue, the charter and the notes land in a
//      timestamped folder under the state directory BEFORE the assistant's own directory is removed, and the
//      archived bytes are the bytes the assistant had (its notes and its done queue row are read back).
//   3. THE ROSTER NO LONGER CARRIES THE ASSISTANT. The live array, the assistants.json on disk and a fresh
//      Assistant over the same directory all answer without the deleted record; the other assistant and
//      Assistant #1 are untouched.
//
// The last section drives the row's own renderer (sliced out of public/assistant.js): Assistant #1 gets no
// row at all, and the armed second press names the assistant and exactly the four things that leave.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { createDeleteRoutes } from "../routes/assistant-delete.js";
import { sliceRegion } from "../tools/panel-testkit.mjs";

// One panel over a temp state directory, with two extra assistants (#2 and #3) and a job store the test can
// fill. Nothing is started: no sentry clock, no wake timer, no socket.
async function panel(t, { jobs = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-delete-"));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  let emits = 0;
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs: { list: () => jobs, firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }), stop: async () => ({ ok: true }) },
    getProjects: () => [],
    getRows: () => [],
    onEvent: () => {
      emits += 1;
    },
    onLog: () => {},
  });
  t.after(async () => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
    await rm(dir, { recursive: true, force: true });
  });
  const second = assistant.createAssistant({ name: "Docs Reviewer" }).created;
  const third = assistant.createAssistant({ name: "Builder" }).created;
  // Its notes and its queue are the two files the archive has to prove it carried, so both hold something
  // the test can read back byte for byte.
  await writeFile(assistant.notesPathOf(second), "the notes this assistant was given\n");
  return { dir, assistant, second, third, emits: () => emits, jobs };
}

// The route's transport, handed in exactly as server.js hands it in. `sendJson` records one answer.
function deleteTransport(assistant) {
  const sent = [];
  const routes = createDeleteRoutes({
    assistant,
    config: { token: "delete-token" },
    sendJson: (_res, status, payload) => sent.push({ status, payload }),
    readBody: async (req) => JSON.parse(req.bodyText ?? "{}"),
    authorised: (req, token) => req.headers?.["x-panel-token"] === token,
  });
  const call = async (body, { method = "POST", token = "delete-token" } = {}) => {
    const url = new URL("http://127.0.0.1/api/assistant/delete");
    const req = {
      method,
      url: url.pathname,
      headers: token ? { "x-panel-token": token } : {},
      bodyText: JSON.stringify(body),
    };
    assert.equal(await routes(req, {}, url.pathname, url), true, `${method} is the delete route's own path`);
    return sent.at(-1);
  };
  return { call, sent };
}

test("a live run refuses the delete and the sentence names the job and its thread", async (t) => {
  const jobs = [];
  const { dir, assistant, second, emits } = await panel(t, { jobs });
  jobs.push({ id: "job-9", thread: second.threadId, status: "running" });
  const { call } = deleteTransport(assistant);
  const emitsBefore = emits();

  const out = await call({ assistantId: second.id, dryRun: true });
  assert.equal(out.status, 409, "a live run is a refusal, not a 500");
  assert.match(out.payload.error, /job-9/, "the refusal names the blocking run");
  assert.match(out.payload.error, /panel-assistant-2/, "and the thread it is on");
  assert.match(out.payload.error, /live run/);
  assert.deepEqual(out.payload.blockers?.[0]?.kind, "run");

  assert.equal(assistant.assistants.some((a) => a.id === second.id), true, "a refusal leaves the roster alone");
  assert.equal(existsSync(path.join(dir, "assistant-archive")), false, "and writes no archive");
  assert.equal(emits(), emitsBefore, "and repaints nothing");
});

test("an open queue row refuses the delete and the sentence names the row", async (t) => {
  const { dir, assistant, second } = await panel(t);
  const added = assistant.queueMutate(second.id, "add", { title: "the open row the refusal names" });
  assert.equal(added.ok, true);
  const { call } = deleteTransport(assistant);

  const out = await call({ assistantId: second.id });
  assert.equal(out.status, 409);
  assert.match(out.payload.error, new RegExp(`#${added.task.id}\\b`), "the refusal names the row's id");
  assert.match(out.payload.error, /the open row the refusal names/, "and its title");
  assert.match(out.payload.error, /open row/);

  assert.equal(assistant.assistants.some((a) => a.id === second.id), true, "the roster still carries it");
  assert.equal(existsSync(assistant.charterPathOf(second)), true, "its charter is still there");
  assert.equal(existsSync(path.join(dir, "assistant-archive")), false, "nothing was archived");
});

test("a delete archives the record, queue, charter and notes, and the roster no longer carries it", async (t) => {
  const { dir, assistant, second, third, emits } = await panel(t);
  // One DONE row: a done row is not open, so it does not refuse - it is the row the archive has to carry.
  const added = assistant.queueMutate(second.id, "add", { title: "work already finished" });
  const done = assistant.queueMutate(second.id, "state", { id: added.task.id, state: "done", by: "test" });
  assert.equal(done.ok, true);
  const charter = await readFile(assistant.charterPathOf(second), "utf8");
  const before = assistant.assistants.map((a) => a.id);
  const { call } = deleteTransport(assistant);

  const out = await call({ assistantId: second.id });
  assert.equal(out.status, 200, out.payload.error || "the delete answered");
  assert.equal(out.payload.ok, true);
  assert.equal(out.payload.removed.id, second.id);

  // 2. The archive exists, was made before the directory went, and carries the four things the confirmation
  //    named: the record, the queue, the charter and the notes. The bytes are the bytes it had.
  const archive = out.payload.archive.dir;
  assert.ok(existsSync(archive), `the archive folder exists: ${archive}`);
  assert.match(path.basename(archive), new RegExp(`^${second.id}-\\d{4}-\\d{2}-\\d{2}T`), "the folder is timestamped");
  for (const name of ["record.json", "queue.json", "charter.md", "notes.md"]) {
    assert.ok(existsSync(path.join(archive, name)), `the archive carries ${name}`);
  }
  const record = JSON.parse(await readFile(path.join(archive, "record.json"), "utf8"));
  assert.equal(record.record.id, second.id);
  assert.equal(record.record.name, "Docs Reviewer");
  assert.deepEqual(record.removed, ["record.json", "queue.json", "charter.md", "notes.md"]);
  assert.equal(await readFile(path.join(archive, "charter.md"), "utf8"), charter, "the charter is archived byte for byte");
  assert.equal(await readFile(path.join(archive, "notes.md"), "utf8"), "the notes this assistant was given\n");
  const archivedQueue = JSON.parse(await readFile(path.join(archive, "queue.json"), "utf8"));
  assert.ok(archivedQueue.tasks.some((row) => row.title === "work already finished"), "the queue's row is in the archive");

  // 3. The roster: the live list, the file on disk and a fresh boot over the same directory.
  assert.deepEqual(out.payload.roster, before.filter((id) => id !== second.id));
  assert.equal(assistant.assistants.some((a) => a.id === second.id), false, "the live roster no longer carries it");
  assert.equal(assistant.assistants.some((a) => a.id === third.id), true, "the other assistant stays");
  assert.equal(assistant.assistants.some((a) => a.id === PRIMARY_ASSISTANT), true, "Assistant #1 stays");
  const onDisk = JSON.parse(await readFile(assistant.assistantsFile, "utf8"));
  assert.equal(onDisk.assistants.some((a) => a.id === second.id), false, "assistants.json no longer carries it");
  assert.equal(out.payload.assistant.assistants.some((a) => a.id === second.id), false, "the answer's state is the new roster");
  assert.equal(existsSync(path.join(dir, "assistants", second.id)), false, "its own directory is gone");
  assert.equal(existsSync(assistant.charterPathOf(third)), true, "the other assistant's charter is untouched");
  assert.ok(emits() > 0, "the float is repainted from the answer");

  const reloaded = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: assistant.assistantsFile, defaultCwd: dir },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }), stop: async () => ({ ok: true }) },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  assert.equal(reloaded.assistants.some((a) => a.id === second.id), false, "a reload reads the same roster");
});

test("Assistant #1 and an unknown id are refused by name", async (t) => {
  const { assistant } = await panel(t);
  const { call } = deleteTransport(assistant);

  const first = await call({ assistantId: PRIMARY_ASSISTANT, dryRun: true });
  assert.equal(first.status, 409);
  assert.match(first.payload.error, /Assistant #1/);
  assert.match(first.payload.error, /cannot be deleted/);

  const missing = await call({ assistantId: "assistant-9", dryRun: true });
  assert.equal(missing.status, 404);
  assert.match(missing.payload.error, /no such assistant/);

  assert.equal(assistant.assistants.length, 3, "neither refusal moved the roster");
});

test("the row is absent for Assistant #1 and its second press names the assistant and the four removals", async () => {
  const src = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
  const region = sliceRegion(src, "delete one assistant");
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const deleteRowHtml = new Function("esc", `${region}\nreturn deleteRowHtml;`)(esc);

  assert.equal(deleteRowHtml("assistant-1", { name: "Assistant #1" }, { first: true }), "", "Assistant #1 has no delete row");

  const html = deleteRowHtml(
    "assistant-2",
    { name: "Docs Reviewer", threadId: "panel-assistant-2" },
    {
      armed: true,
      plan: {
        archive: { dir: "C:/state/assistant-archive/assistant-2-2026-11-07T23-59-00-000Z" },
        removes: ["record.json", "queue.json", "charter.md", "notes.md"],
      },
    },
  );
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  assert.match(text, /Delete this assistant/, "the row is the delete control");
  assert.match(text, /Delete Docs Reviewer and archive its record, queue, charter and notes/, "the second press names the assistant and what leaves");
  assert.match(text, /record\.json, queue\.json, charter\.md, notes\.md/, "and lists the four archived files");
  assert.match(text, /assistant-2-2026-11-07T23-59-00-000Z/, "and the archive folder the dry run named");
  assert.match(text, /Nothing is erased/);
  assert.match(html, /data-as-delete-go="assistant-2"/);
  assert.match(html, /data-as-delete-cancel="assistant-2"/);
});
