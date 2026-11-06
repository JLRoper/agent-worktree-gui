// The Settings role picker and the restart that applies it.
//
// What this file is the contract for:
//
//   1. THE PICK WRITES THE RECORD. `pickRole` is the one writer of `roleId`, so a role chosen from Settings is the
//      same fact the Role tab reads, survives a fresh Assistant over the same files (a panel reload), and never
//      adopts the role's charter — replacing the reader's copy stays the Role tab's own press.
//   2. THE RESTART IS SCOPED. `restartRole` drops ONLY that assistant's session send records (charter, board digest,
//      queue digest) and says which it dropped; another assistant's records and the panel's process are untouched.
//   3. THE NEXT TURN IS REBUILT FROM THE NEW ROLE. Before a restart an unchanged charter is withheld with the role's
//      name; after one the same turn carries the charter in full under the role the record now holds.
//   4. THE ROUTE ANSWERS WITH THE WHOLE STATE. `POST /api/assistant/role/restart` is a real panel's read for the
//      Settings pane: one answer carries the assistant record, the role it now runs and what was cleared.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { ASSISTANT_DIRECTOR_ID, ASSISTANT_DIRECTOR_NAME } from "../lib/roles.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";


async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-role-restart-"));
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
  const created = assistant.createAssistant({ roleId: "agent-manager" });
  return { assistant, dir, assistantFile, assistantsFile: assistant.assistantsFile, id: created.created.id };
}

test("a role picked from Settings is written to that assistant's record and survives a reload", async (t) => {
  const { assistant, dir, assistantsFile, id } = await panel(t);
  const before = assistant.rolePayload(id);
  assert.equal(before.role.id, "agent-manager", "Assistant #2 starts on the manager role");
  const copyBefore = assistant.charterPayloadFor(id).text;

  const picked = assistant.pickRole(id, ASSISTANT_DIRECTOR_ID, { adopt: false });
  assert.equal(picked.role.id, ASSISTANT_DIRECTOR_ID, "the pick answers the role it saved");
  assert.equal(picked.role.name, ASSISTANT_DIRECTOR_NAME);
  assert.equal(assistant.charterPayloadFor(id).text, copyBefore, "a plain pick does not adopt the role's charter — the copy is untouched");

  // The store, not the in-memory record: a reload is a new Assistant over the same files.
  const onDisk = JSON.parse(await readFile(assistantsFile, "utf8"));
  assert.equal(onDisk.assistants.find((a) => a.id === id)?.roleId, ASSISTANT_DIRECTOR_ID, "roleId is on the assistant's record");

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
  assert.equal(reloaded.rolePayload(id).role.id, ASSISTANT_DIRECTOR_ID, "a panel reload still reads the new role");
});

test("a restart drops only that assistant's send records and names what it cleared", async (t) => {
  const { assistant, id } = await panel(t);
  assistant.pickRole(id, ASSISTANT_DIRECTOR_ID, { adopt: false });
  // Build one turn of each gated block for BOTH assistants, so "only this one" is a real comparison.
  assistant.preamble(PRIMARY_ASSISTANT);
  assistant.boardForTurn(PRIMARY_ASSISTANT);
  assistant.queueDigestDue(PRIMARY_ASSISTANT);
  assistant.preamble(id);
  assistant.boardForTurn(id);
  assistant.queueDigestDue(id);
  assert.ok(assistant.charterSends.has(id) && assistant.charterSends.has(PRIMARY_ASSISTANT), "both assistants have a charter record");

  const out = assistant.restartRole(id);
  assert.deepEqual(out.target, { id, name: out.target.name, roleId: ASSISTANT_DIRECTOR_ID, threadId: out.target.threadId });
  assert.equal(out.role.id, ASSISTANT_DIRECTOR_ID, "the answer names the role the next turn is built from");
  assert.deepEqual(out.cleared.sort(), ["board", "charter", "queue"], "it says exactly what was cleared");
  assert.equal(assistant.charterSends.has(id), false, "this assistant's charter record is gone");
  assert.equal(assistant.boardSigs.has(id), false, "and its board signature");
  assert.equal(assistant.queueWakeTicks.has(id), false, "and its queue tick");
  assert.equal(assistant.charterSends.has(PRIMARY_ASSISTANT), true, "Assistant #1's record is untouched");
  assert.equal(assistant.boardSigs.has(PRIMARY_ASSISTANT), true);
  assert.equal(assistant.queueWakeTicks.has(PRIMARY_ASSISTANT), true);
});

test("the next turn after a restart carries the new role's charter in full", async (t) => {
  const { assistant, id } = await panel(t);
  assistant.pickRole(id, ASSISTANT_DIRECTOR_ID, { adopt: true });

  const first = assistant.preamble(id);
  assert.match(first, /Charter — the long tier, read in full this turn \(role Assistant Director;/, "the first turn sends it whole");
  assert.match(first, /You are the Assistant Director|Assistant Director of this panel's board/, "the Director's own words are in the turn");

  const withheld = assistant.preamble(id);
  assert.match(withheld, /unchanged and withheld this turn \(sha256:[0-9a-f]+, \d+ chars; role Assistant Director;/, "an unchanged turn withholds it");

  const out = assistant.restartRole(id);
  assert.ok(out.cleared.includes("charter"), "the restart is what makes the next turn a first turn again");
  const rebuilt = assistant.preamble(id);
  assert.match(rebuilt, /Charter — the long tier, read in full this turn \(role Assistant Director;/, "the next turn carries it in full again");
  assert.match(rebuilt, /You are the Assistant Director|Assistant Director of this panel's board/, "and it is still the new role's job");
});

test("a running panel restarts one assistant's turn context and answers with the whole state", async (t) => {
  const panel = await startPanel({});
  t.after(() => panel.stop());

  const created = await post(panel.base, "/api/assistant/assistants", { body: { roleId: "agent-manager" } });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  const id = created.json.created.id;

  const picked = await post(panel.base, "/api/assistant/role/pick", { body: { assistantId: id, roleId: ASSISTANT_DIRECTOR_ID, adopt: false } });
  assert.equal(picked.status, 200, picked.text.slice(0, 300));
  assert.equal(picked.json.role.id, ASSISTANT_DIRECTOR_ID);

  const restarted = await post(panel.base, "/api/assistant/role/restart", { body: { assistantId: id } });
  assert.equal(restarted.status, 200, restarted.text.slice(0, 300));
  assert.equal(restarted.json.role.id, ASSISTANT_DIRECTOR_ID);
  assert.equal(restarted.json.target.id, id);
  assert.ok(Array.isArray(restarted.json.cleared), "the answer says what it cleared");
  assert.ok(restarted.json.assistant, "and carries the whole assistant state");
  assert.equal(restarted.json.assistant.assistants.find((a) => a.id === id)?.roleId, ASSISTANT_DIRECTOR_ID, "the state agrees with the pick");
  assert.equal(restarted.json.target.id === PRIMARY_ASSISTANT, false, "the restart named #2, not #1");
});
