// Every assistant resolves a role, and the role the panel used to seed is retired without losing a byte of it.
//
// What this file is the contract for:
//
//   1. THE RETIRED LIBRARY IS UPGRADED ON READ. A roles.json written before the manager role moved under the
//      `assistant-` prefix — the reader's own store, carrying BOTH the retired record and the record that replaced it
//      — comes out of a boot holding exactly the two built-ins, with no retired id anywhere in the library. The
//      retired record is deleted only after every assistant that named it has been re-pointed, because
//   2. THE DELETE REFUSES WHILE AN ASSISTANT STILL NAMES THE ROLE. `deleteRole` with a non-empty `heldBy` is
//      `role-in-use`, names the holders, and leaves the file untouched. An assistant's record stores a roleId, not a
//      copy of the role, so a cascade delete would leave that assistant resolving nothing: the refusal is the point.
//   3. A STORE THAT HAS ONLY THE RETIRED RECORD KEEPS ITS BYTES. The upgrade renames the record in place — same id
//      comes out, same name, same remit, same prompt, and the charter's bytes are the reader's own edited text, not
//      the seed in `data/roles/`.
//   4. EVERY ASSISTANT RESOLVES A ROLE AFTERWARDS. `roleOf` answers a record for #1, #2 and #3, the preamble names
//      the role it runs, and the upgrade is idempotent: a second boot writes neither file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import {
  ASSISTANT_AGENT_MANAGER_ID,
  ASSISTANT_DIRECTOR_ID,
  RETIRED_AGENT_MANAGER_ID,
  deleteRole,
  readRolesFile,
  seedCharter,
} from "../lib/roles.js";
import { assistantsRunning } from "../lib/assistants.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const iso = (at) => new Date(at).toISOString();

// The store the reader's panel actually had on 2026-11-08: three assistants on the retired id, and a library holding
// the retired record beside a second record for the same job (created by hand, so the id — not the job — is the only
// difference between them). Both records carry the same charter bytes here, which is what makes the delete safe.
async function legacyStore(dir, { charter = null, ids = [1, 2, 3] } = {}) {
  const rolesFile = path.join(dir, "roles.json");
  const assistantsFile = path.join(dir, "assistants.json");
  const text = charter ?? seedCharter();
  const when = iso("2026-11-01T15:50:54.167Z");
  const record = (id, name) => ({ id, name, description: "The board manager.", prompt: "", charter: text, createdAt: when, updatedAt: when });
  await writeFile(
    rolesFile,
    JSON.stringify({ version: 1, roles: [record(RETIRED_AGENT_MANAGER_ID, "Agent Manager"), record(ASSISTANT_AGENT_MANAGER_ID, "Assistant Agent Manager")] }),
  );
  await writeFile(
    assistantsFile,
    JSON.stringify({
      version: 1,
      assistants: ids.map((n) => ({
        id: `assistant-${n}`,
        name: `Assistant #${n}`,
        roleId: RETIRED_AGENT_MANAGER_ID,
        threadId: n === 1 ? "panel-assistant" : `panel-assistant-${n}`,
        rules: [],
        createdAt: when,
      })),
    }),
  );
  return { rolesFile, assistantsFile };
}

async function boot(t, dir) {
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const logs = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }), stop: async () => ({ ok: true }) },
    getProjects: () => [],
    getRows: () => [],
    onLog: (m) => logs.push(m),
  });
  t.after(() => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
  });
  return { assistant, logs, assistantFile };
}

const tmp = async (t, prefix) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test("the delete refuses while an assistant still names the role, and the file is untouched", async (t) => {
  const dir = await tmp(t, "wtgui-role-guard-");
  const { rolesFile, assistantsFile } = await legacyStore(dir);
  const { roles } = readRolesFile(rolesFile, { at: new Date("2026-11-08T00:00:00Z") });
  // The read above registered the built-in Director the store predates; the refusal below is judged against the file
  // as it then stands, so `before` is taken after it.
  const before = await readFile(rolesFile, "utf8");
  const onDisk = JSON.parse(await readFile(assistantsFile, "utf8")).assistants;
  const heldBy = assistantsRunning(onDisk, RETIRED_AGENT_MANAGER_ID);

  assert.deepEqual(heldBy, ["assistant-1", "assistant-2", "assistant-3"], "all three assistants name the retired role");
  let refusal = null;
  try {
    deleteRole(rolesFile, roles, RETIRED_AGENT_MANAGER_ID, { heldBy });
  } catch (e) {
    refusal = e;
  }
  assert.ok(refusal, "a role three assistants run is not deleted");
  assert.equal(refusal.code, "role-in-use", "the refusal has its own code, which a route maps to 409");
  assert.deepEqual(refusal.heldBy, heldBy, "and it names the assistants holding it");
  assert.match(refusal.message, /still run by assistant-1, assistant-2, assistant-3/);
  assert.equal(await readFile(rolesFile, "utf8"), before, "nothing was written");

  // The same call once the roster no longer names it is the delete the upgrade performs.
  const out = deleteRole(rolesFile, roles, RETIRED_AGENT_MANAGER_ID, { heldBy: [] });
  assert.equal(out.deleted.id, RETIRED_AGENT_MANAGER_ID);
  assert.deepEqual(JSON.parse(await readFile(rolesFile, "utf8")).roles.map((r) => r.id), [ASSISTANT_AGENT_MANAGER_ID, ASSISTANT_DIRECTOR_ID]);
});

test("a boot over the reader's library re-points #1, #2 and #3, leaves two roles and retires the old id", async (t) => {
  const dir = await tmp(t, "wtgui-role-retire-");
  const { rolesFile, assistantsFile } = await legacyStore(dir);
  const { assistant } = await boot(t, dir);

  assert.deepEqual(
    assistant.roles.map((r) => r.id),
    [ASSISTANT_AGENT_MANAGER_ID, ASSISTANT_DIRECTOR_ID],
    "the library is the two built-ins, in order",
  );
  assert.deepEqual(assistant.retiredRoleIds, [RETIRED_AGENT_MANAGER_ID], "the boot saw the retired record and removed it");
  assert.equal(assistant.roles[0].name, "Assistant Agent Manager", "the surviving record is the reader's own, by name");
  assert.equal(assistant.roles[0].charter, seedCharter(), "and by its charter bytes");

  const stored = JSON.parse(await readFile(rolesFile, "utf8"));
  assert.deepEqual(stored.roles.map((r) => r.id), [ASSISTANT_AGENT_MANAGER_ID, ASSISTANT_DIRECTOR_ID]);
  assert.ok(!stored.roles.some((r) => r.id === RETIRED_AGENT_MANAGER_ID), "no record survives under the retired id");
  assert.ok(!JSON.stringify(stored).replaceAll(ASSISTANT_AGENT_MANAGER_ID, "").includes(RETIRED_AGENT_MANAGER_ID), "nor is the retired id named anywhere else in roles.json");

  const roster = JSON.parse(await readFile(assistantsFile, "utf8")).assistants;
  assert.deepEqual(roster.map((a) => a.roleId), [ASSISTANT_AGENT_MANAGER_ID, ASSISTANT_AGENT_MANAGER_ID, ASSISTANT_AGENT_MANAGER_ID]);
  assert.ok(!JSON.stringify(roster).replaceAll(ASSISTANT_AGENT_MANAGER_ID, "").includes(RETIRED_AGENT_MANAGER_ID), "nor in assistants.json");

  // Every assistant resolves a role, which is the thing a delete without the guard would have broken.
  for (const rec of assistant.assistants) {
    const role = assistant.roleOf(rec);
    assert.ok(role, `${rec.id} resolves a role`);
    assert.equal(role.id, ASSISTANT_AGENT_MANAGER_ID, `${rec.id} runs the surviving role`);
    assert.equal(assistant.roleNameOf(rec), "Assistant Agent Manager", `${rec.id}'s label comes from it`);
    assert.match(assistant.preamble(rec.id), /Your role: Assistant Agent Manager — The board manager\./, `${rec.id}'s turn names its role`);
  }
});

test("a library holding only the retired record is renamed in place, keeping the reader's charter bytes", async (t) => {
  const dir = await tmp(t, "wtgui-role-rename-");
  // The reader's own text, not the seed: the rename must carry it, and a re-seed would silently replace it.
  const edited = "# The reader's own manager charter\n\nEDITED-BY-THE-READER\n";
  const rolesFile = path.join(dir, "roles.json");
  const when = iso("2026-11-01T15:50:54.167Z");
  await writeFile(
    rolesFile,
    JSON.stringify({
      version: 1,
      roles: [
        { id: RETIRED_AGENT_MANAGER_ID, name: "Manager Prime", description: "drives the board", prompt: "BE-BRIEF", charter: edited, createdAt: when, updatedAt: when },
        { id: ASSISTANT_DIRECTOR_ID, name: "Assistant Director", description: "routes work", prompt: "", charter: "# director\n", createdAt: when, updatedAt: when },
      ],
    }),
  );
  await writeFile(path.join(dir, "assistants.json"), JSON.stringify({ version: 1, assistants: [{ id: "assistant-1", name: "Assistant #1", roleId: RETIRED_AGENT_MANAGER_ID, threadId: "panel-assistant", rules: [], createdAt: when }] }));

  const { assistant } = await boot(t, dir);
  const role = assistant.roles.find((r) => r.id === ASSISTANT_AGENT_MANAGER_ID);
  assert.ok(role, "the record moved to the new id");
  assert.equal(role.charter, edited, "the charter is the reader's bytes, byte for byte");
  assert.equal(sha(role.charter), sha(edited));
  assert.notEqual(sha(role.charter), sha(seedCharter()), "and it is emphatically not a re-seed");
  assert.deepEqual([role.name, role.description, role.prompt], ["Manager Prime", "drives the board", "BE-BRIEF"], "every other field came with it");
  assert.equal(role.createdAt, when, "the record's own age is untouched");
  assert.deepEqual(assistant.roles.map((r) => r.id), [ASSISTANT_AGENT_MANAGER_ID, ASSISTANT_DIRECTOR_ID], "and no retired record is left behind");
  assert.equal(assistant.assistants[0].roleId, ASSISTANT_AGENT_MANAGER_ID, "the assistant was re-pointed, not re-created");
  assert.ok(!JSON.parse(await readFile(rolesFile, "utf8")).roles.some((r) => r.id === RETIRED_AGENT_MANAGER_ID));
});

test("the upgrade is idempotent: a second boot over the same store writes neither file", async (t) => {
  const dir = await tmp(t, "wtgui-role-idem-");
  const { rolesFile, assistantsFile } = await legacyStore(dir);
  const { assistant } = await boot(t, dir);
  const first = { roles: await readFile(rolesFile, "utf8"), assistants: await readFile(assistantsFile, "utf8") };
  const rolesAt = (await stat(rolesFile)).mtimeMs;
  const assistantsAt = (await stat(assistantsFile)).mtimeMs;

  await new Promise((r) => setTimeout(r, 25));
  const second = await boot(t, dir);
  assert.deepEqual(second.assistant.retiredRoleIds, [], "the second boot finds nothing retired");
  assert.deepEqual(second.assistant.roles.map((r) => r.id), [ASSISTANT_AGENT_MANAGER_ID, ASSISTANT_DIRECTOR_ID]);
  assert.equal(await readFile(rolesFile, "utf8"), first.roles, "roles.json did not move");
  assert.equal(await readFile(assistantsFile, "utf8"), first.assistants, "assistants.json did not move");
  assert.equal((await stat(rolesFile)).mtimeMs, rolesAt);
  assert.equal((await stat(assistantsFile)).mtimeMs, assistantsAt);
  assert.ok(assistant.rolesSeeded === false, "nothing was re-seeded");
});
