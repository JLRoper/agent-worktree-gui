// The Assistant Director: a role with a twenty-minute clock, two powers and no worker of its own.
//
// What this file is the contract for, in the brief's order:
//
//   1. THE CHARTER is a NEW document, under the existing 20,000-character cap — not the manager's file under a
//      second name — and its own text names the cadence, the three cross-queue conditions and both powers.
//   2. THE ROLE REGISTERS ONCE. A fresh library seeds it; a library written before it existed gets it appended
//      exactly once; a reader's edit under the same id is never regenerated. Two boots leave one Director role.
//   3. THE WAKE IS A PROFILE FIELD. An assistant created from the role carries `wakeEveryMinutes: 20` in its
//      settings file, `spawn: "off"` beside it, and `checkCadence` is the sentry's only reader — there is no
//      second timer. 19 minutes is early, 21 is due, and a live turn is the clock.
//   4. THE TWO POWERS ARE THE ONLY POWERS. `QUEUE` files into another assistant's queue; `MESSAGE` starts a turn
//      on its thread; `TO` and `SPAWN` are refused for this role, and QUEUE/MESSAGE are refused for every other.
//   5. THE ROLE IS ON THE API AND ON THE TAB. `GET /api/roles` lists it; an assistant created from it reads its
//      charter and its interval through the Role tab's payload, and its queue is an empty FILE rather than a
//      missing one. The last test boots the real server.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { actionGrammar, parseActions } from "../lib/assistant/actions.js";
import { addTask, setTaskState, writeQueueFile } from "../lib/assistant/queue.js";
import { CHARTER_MAX_CHARS } from "../lib/charter.js";
import {
  ASSISTANT_DIRECTOR_DESCRIPTION,
  ASSISTANT_DIRECTOR_ID,
  ASSISTANT_DIRECTOR_NAME,
  ASSISTANT_DIRECTOR_WAKE_MINUTES,
  ensureBuiltInRoles,
  readRolesFile,
  roleMeta,
  seedDirectorCharter,
  writeRoleCharter,
} from "../lib/roles.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const MINUTE = 60_000;
const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const DIRECTOR_SEED = new URL("../data/roles/assistant-director.md", import.meta.url);

async function panel(t, { dir: given = null } = {}) {
  const dir = given || (await mkdtemp(path.join(os.tmpdir(), "wtgui-director-")));
  if (!given) t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  if (!given) {
    await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  }
  const created = [];
  const said = [];
  const stopped = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs: {
      list: () => [],
      firstOfThread: () => null,
      create: async (body) => {
        created.push(body);
        return { id: `job-${created.length}`, ...body };
      },
      stop: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  assistant.say = async (text, opts = {}) => {
    said.push({ text: String(text), assistantId: opts.assistantId || null, origin: opts.origin || null });
    return { id: `said-${said.length}` };
  };
  t.after(() => {
    if (assistant.wakeTimer) clearTimeout(assistant.wakeTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    if (assistant.settleTimer) clearTimeout(assistant.settleTimer);
  });
  return {
    assistant,
    dir,
    said,
    stopped,
    assistantFile,
    rolesFile: path.join(dir, "roles.json"),
    profileFile: (id) => path.join(dir, "assistants", id, "settings.json"),
  };
}

function directorPanel(t) {
  return panel(t).then((p) => {
    const created = p.assistant.createAssistant({ roleId: ASSISTANT_DIRECTOR_ID });
    return { ...p, created };
  });
}

// ---- 1. the charter ----------------------------------------------------------------------------------

test("the Assistant Director charter is a new document, under the cap, and it names the job", async (t) => {
  const text = await readFile(DIRECTOR_SEED, "utf8");
  const manager = await readFile(new URL("../data/roles/agent-manager.md", import.meta.url), "utf8");
  assert.ok(text.length < CHARTER_MAX_CHARS, `under the cap (${text.length}/${CHARTER_MAX_CHARS})`);
  assert.notEqual(text, manager, "a NEW charter, not the manager's file under another name");
  assert.ok(text.length > 4000, "a real operating document, not a placeholder");
  // The brief's four duties, in the role's own words.
  assert.match(text, /every 20 minutes|twenty-minute/i, "the 20-minute wake is in the text");
  assert.match(text, /every assistant's queue/i, "read every assistant's queue first");
  assert.match(text, /running[\s\S]{0,80}no live job|no live job[\s\S]{0,80}running/i, "the dead run is named");
  assert.match(text, /parked[\s\S]{0,80}hour|hour[\s\S]{0,80}parked/i, "a park past an hour is named");
  assert.match(text, /QUEUE <assistant> \|/, "the QUEUE line is spelled out");
  assert.match(text, /MESSAGE <assistant> \|/, "the MESSAGE line is spelled out");
  assert.match(text, /naming the assistant you[\s\S]{0,40}chose and why/i, "the routing sentence is a duty");
  assert.match(text, /Never write a SPAWN line/i, "the spawn boundary is explicit");
  assert.match(text, /Changelog/i, "the continuity file's own update section survives");
});

test("the Director role is registered beside the manager, with its own size and remit", async (t) => {
  const { assistant, rolesFile } = await panel(t);
  const director = assistant.roles.find((r) => r.id === ASSISTANT_DIRECTOR_ID);
  assert.ok(director, "the fresh seed carries it");
  assert.equal(director.name, ASSISTANT_DIRECTOR_NAME);
  assert.equal(director.charter, await readFile(DIRECTOR_SEED, "utf8"), "the seed file is the charter, byte for byte");
  assert.equal(director.charter.length, (await readFile(DIRECTOR_SEED, "utf8")).length);
  assert.match(ASSISTANT_DIRECTOR_DESCRIPTION, /20 minutes/i);
  assert.match(ASSISTANT_DIRECTOR_DESCRIPTION, /every assistant's queue/i);
  assert.match(ASSISTANT_DIRECTOR_DESCRIPTION, /never starts a worker/i);
  const meta = roleMeta(director);
  assert.equal(meta.chars, director.charter.length);
  assert.equal(meta.over, false);
  const stored = JSON.parse(await readFile(rolesFile, "utf8"));
  assert.deepEqual(stored.roles.map((r) => r.id), ["agent-manager", ASSISTANT_DIRECTOR_ID]);
});

test("the role registers exactly once across two boots, and a reader's edit is never regenerated", async (t) => {
  const first = await panel(t);
  // A library written by the older build: only the manager, with a reader's edit in it.
  const legacy = {
    version: 1,
    roles: [{ ...first.assistant.roles[0], charter: "# the reader's own manager text\n" }],
  };
  await writeFile(first.rolesFile, JSON.stringify(legacy));
  const bootOne = readRolesFile(first.rolesFile, { at: new Date("2026-11-04T12:00:00Z") });
  assert.equal(bootOne.seeded, false, "the existing file is not re-seeded");
  assert.deepEqual(bootOne.added.map((r) => r.id), [ASSISTANT_DIRECTOR_ID], "one built-in is appended");
  assert.equal(bootOne.roles.length, 2);
  assert.equal(bootOne.roles[0].charter, "# the reader's own manager text\n", "the reader's manager text is untouched");
  assert.equal(bootOne.roles[1].id, ASSISTANT_DIRECTOR_ID);

  // The second boot reads the file the first wrote. It must add NOTHING and write nothing.
  const before = await readFile(first.rolesFile, "utf8");
  const bootTwo = readRolesFile(first.rolesFile, { at: new Date("2026-11-04T13:00:00Z") });
  assert.equal(bootTwo.seeded, false);
  assert.deepEqual(bootTwo.added, [], "nothing is added on the second boot");
  assert.equal(bootTwo.roles.filter((r) => r.id === ASSISTANT_DIRECTOR_ID).length, 1, "exactly one Director");
  assert.equal(bootTwo.roles.length, 2);
  assert.equal(await readFile(first.rolesFile, "utf8"), before, "an idempotent boot does not rewrite the file");

  // The second BOOT is also an Assistant constructor, not only the helper: same file, same two roles.
  const second = await panel(t, { dir: first.dir });
  assert.deepEqual(second.assistant.roles.map((r) => r.id), ["agent-manager", ASSISTANT_DIRECTOR_ID]);

  // A reader's edit to the Director's charter survives a later registration pass.
  const edited = writeRoleCharter(first.rolesFile, bootTwo.roles, ASSISTANT_DIRECTOR_ID, "# the director, edited\n");
  assert.equal(edited.charter, "# the director, edited\n");
  const bootThree = readRolesFile(first.rolesFile, { at: new Date("2026-11-04T14:00:00Z") });
  assert.equal(bootThree.added.length, 0);
  assert.equal(bootThree.roles.find((r) => r.id === ASSISTANT_DIRECTOR_ID).charter, "# the director, edited\n");
});

test("a charter over the cap is refused with the existing code, and the file is untouched", async (t) => {
  const { assistant, rolesFile } = await panel(t);
  const before = await readFile(rolesFile, "utf8");
  let code = null;
  try {
    writeRoleCharter(rolesFile, assistant.roles, ASSISTANT_DIRECTOR_ID, "x".repeat(CHARTER_MAX_CHARS + 1));
  } catch (e) {
    code = e.code;
  }
  assert.equal(code, "charter-too-long", "the same refusal the manager's role raises");
  assert.equal(await readFile(rolesFile, "utf8"), before, "nothing was written");
  // Exactly the cap is allowed, as it is for every charter.
  const atCap = writeRoleCharter(rolesFile, assistant.roles, ASSISTANT_DIRECTOR_ID, "y".repeat(CHARTER_MAX_CHARS));
  assert.equal(atCap.charter.length, CHARTER_MAX_CHARS);
});

test("the built-in registrar never duplicates and never overwrites", () => {
  const seeded = ensureBuiltInRoles([], { at: new Date("2026-11-04T00:00:00Z") });
  assert.deepEqual(seeded.roles.map((r) => r.id), ["agent-manager", ASSISTANT_DIRECTOR_ID]);
  assert.equal(seeded.added.length, 2);
  const again = ensureBuiltInRoles(seeded.roles);
  assert.deepEqual(again.added, [], "a second pass adds nothing");
  assert.equal(again.roles.length, 2);
  const renamed = ensureBuiltInRoles([{ id: ASSISTANT_DIRECTOR_ID, name: "The Boss", charter: "mine", description: "" }]);
  assert.equal(renamed.added.length, 1, "the missing manager is added");
  assert.equal(renamed.roles.find((r) => r.id === ASSISTANT_DIRECTOR_ID).name, "The Boss", "the reader's name stands");
});

// ---- 2. the profile and the wake ---------------------------------------------------------------------

test("an assistant created from the Director role carries the roleId, the 20-minute profile and a real empty queue", async (t) => {
  const { assistant, created } = await directorPanel(t);
  assert.equal(created.created.id, "assistant-2");
  assert.equal(created.created.roleId, ASSISTANT_DIRECTOR_ID);
  assert.equal(ASSISTANT_DIRECTOR_WAKE_MINUTES, 20);

  const profile = assistant.profileOf("assistant-2");
  assert.equal(profile.wakeEveryMinutes, 20, "the interval lives in the assistant's profile");
  assert.equal(assistant.settingsFor("assistant-2").spawn, "off", "and the spawn switch is a gate, not a sentence");
  assert.equal(assistant.rolePayload("assistant-2").wakeEveryMinutes, 20, "the Role tab reads it");
  assert.equal(assistant.assistantList().find((a) => a.id === "assistant-2").wakeEveryMinutes, 20);

  // The queue is a FILE with no rows, not a missing file: the tab can say "empty" rather than "unknown".
  const view = assistant.queueView("assistant-2");
  assert.equal(view.found, true, "the queue file exists");
  assert.deepEqual(view.tasks, []);
  assert.equal(view.counts.total, 0);
  assert.equal(view.error, null);

  // The charter is the role's own bytes, and the payload says so.
  const payload = assistant.rolePayload("assistant-2");
  assert.equal(payload.sameAsRole, true);
  assert.equal(payload.charter.text, await readFile(DIRECTOR_SEED, "utf8"));
});

test("checkCadence is the sentry's only clock: 19 is early, 21 is due, and a live turn restarts it", async (t) => {
  const { assistant, said } = await directorPanel(t);
  const start = assistant.bootedAt;
  assert.equal(assistant.checkCadence(start + 19 * MINUTE), null, "one minute short is not due");
  assert.equal(said.length, 0);
  const due = assistant.checkCadence(start + 21 * MINUTE);
  assert.deepEqual(due, { assistantId: "assistant-2", minutes: 20 });
  await wait(300);
  assert.equal(said.length, 1, "one turn was started");
  assert.equal(said[0].assistantId, "assistant-2", "on the Director's own thread");
  assert.match(said[0].text, /20-minute look/);
  assert.match(said[0].text, /read every assistant's queue before anything else/);

  assert.equal(assistant.checkCadence(start + 25 * MINUTE), null, "the clock restarted when the wake went out");
  assert.equal(assistant.checkCadence(start + 40 * MINUTE), null, "19 minutes after the first wake is not due");
  const second = assistant.checkCadence(start + 41 * MINUTE + 1);
  assert.deepEqual(second, { assistantId: "assistant-2", minutes: 20 }, "20 minutes after the first wake is due");

  // A live turn of that assistant is the clock, and no second turn is opened behind it.
  const live = [{ id: "live-1", thread: "panel-assistant-2", status: "running", startedAt: new Date(start).toISOString(), lines: [] }];
  assistant.jobs.list = () => live;
  const third = assistant.checkCadence(start + 500 * MINUTE);
  assert.equal(third, null, "a live turn is the clock");
  assert.equal(assistant.cadenceAt.get("assistant-2"), start + 500 * MINUTE, "and the window restarts from it");

  // A failed LAST TURN does not walk the cadence onto #1: the interval belongs to this job, so the wake is exact.
  assistant.jobs.list = () => [
    { id: "failed-1", thread: "panel-assistant-2", status: "failed", startedAt: new Date(start).toISOString(), outcome: { word: "failed", reason: "exit code 1" } },
  ];
  assistant.cadenceAt.set("assistant-2", start);
  const exact = assistant.checkCadence(start + 70 * MINUTE);
  assert.deepEqual(exact, { assistantId: "assistant-2", minutes: 20 });
  await wait(300);
  assert.equal(said.at(-1).assistantId, "assistant-2", "the Director kept its own standing wake");
});

test("no interval means no cadence; the profile is the only field the sentry reads", async (t) => {
  const { assistant, profileFile } = await panel(t);
  assistant.createAssistant({ roleId: "agent-manager" });
  // The manager-role assistant has no cadence even after a very long quiet.
  assert.equal(assistant.checkCadence(assistant.bootedAt + 24 * 60 * MINUTE), null);
  assert.equal(assistant.profileOf("assistant-2").wakeEveryMinutes, 0);
  // A hand-set number on that same file is read by the sentry's pass, with no role change and no timer created.
  await writeFile(
    profileFile("assistant-2"),
    JSON.stringify({ version: 1, savedAt: new Date().toISOString(), settings: {}, rules: {}, prompt: "", wakeEveryMinutes: 15 }),
  );
  assistant.readProfile(assistant.assistantRecord("assistant-2"));
  assert.equal(assistant.profileOf("assistant-2").wakeEveryMinutes, 15);
  const due = assistant.checkCadence(assistant.bootedAt + 16 * MINUTE);
  assert.deepEqual(due, { assistantId: "assistant-2", minutes: 15 });
  await wait(250);
  assert.equal(assistant.timer, null, "checkCadence never creates a timer of its own");
});

// ---- 3. the two powers --------------------------------------------------------------------------------

test("the Director files a row into another assistant's queue and messages that assistant", async (t) => {
  const { assistant, said } = await directorPanel(t);
  const turn = { id: "turn-1", thread: "panel-assistant-2", assistantId: "assistant-2", status: "done", prompt: "", startedAt: new Date().toISOString() };
  const text = [
    "Assistant #1 owns the tree, so I filed there and told it why.",
    "QUEUE #1 | fix the stale row on the docs tree — its run has no live job",
    "MESSAGE assistant-1 | #12 on the docs tree is stale: requeue it or close it with evidence.",
  ].join("\n");
  await assistant.applyActions(turn, parseActions(text));

  const queue = assistant.queueView(PRIMARY_ASSISTANT);
  assert.equal(queue.tasks.length, 1, "one row was filed");
  assert.equal(queue.tasks[0].state, "queued");
  assert.match(queue.tasks[0].title, /fix the stale row/);
  assert.equal(queue.tasks[0].createdBy, "assistant-2", "the row records who filed it");
  assert.equal(assistant.queueView("assistant-2").tasks.length, 0, "the Director's own queue stays empty");

  await wait(50);
  assert.equal(said.length, 1, "one message was sent");
  assert.equal(said[0].assistantId, PRIMARY_ASSISTANT);
  assert.match(said[0].text, /\[Assistant #2 → you\]/);
  assert.match(said[0].text, /#12 on the docs tree is stale/);
  assert.equal(said[0].origin.kind, "assistant-message");
});

test("QUEUE/MESSAGE are the Director's alone; TO and SPAWN are refused for it", async (t) => {
  const { assistant, said } = await directorPanel(t);
  const directorTurn = { id: "turn-2", thread: "panel-assistant-2", assistantId: "assistant-2", status: "done", prompt: "", startedAt: new Date().toISOString() };
  // A TO line written anyway is refused, not carried out into a worker's thread.
  await assistant.applyActions(directorTurn, parseActions("TO worker-thread: hello"));
  assert.equal(said.length, 0, "no worker was answered");
  assert.ok(assistant.journal.some((j) => j.kind === "to-refused" && /does not reply to a worker/.test(j.text)));

  // The manager (#1) does not have the two powers: both lines are refused by name.
  const managerTurn = { id: "turn-3", thread: "panel-assistant-1", assistantId: "assistant-1", status: "done", prompt: "", startedAt: new Date().toISOString() };
  await assistant.applyActions(managerTurn, parseActions("QUEUE #2 | do the thing\nMESSAGE #2 | hello"));
  assert.equal(assistant.queueView("assistant-2").tasks.length, 0, "nothing was filed");
  assert.equal(said.length, 0, "nothing was sent");
  const kinds = assistant.journal.map((j) => j.kind);
  assert.ok(kinds.includes("queue-refused"), "the manager's QUEUE is refused out loud");
  assert.ok(kinds.includes("message-refused"), "and so is its MESSAGE");
});

test("the grammar offers QUEUE/MESSAGE only to the Director and withholds SPAWN and TO", () => {
  const director = actionGrammar({ spawn: "auto" }, { director: true }).join("\n");
  assert.match(director, /^QUEUE <assistant> \|/m);
  assert.match(director, /^MESSAGE <assistant> \|/m);
  assert.doesNotMatch(director, /^TO <thread>/m);
  assert.doesNotMatch(director, /^SPAWN /m);
  assert.match(director, /which assistant you chose and why/);

  const manager = actionGrammar({ spawn: "auto" }).join("\n");
  assert.match(manager, /^TO <thread>/m);
  assert.match(manager, /^SPAWN \[<task id>\]/m);
  assert.doesNotMatch(manager, /^QUEUE /m);
  assert.doesNotMatch(manager, /^MESSAGE /m);
});

test("the Director's preamble carries every queue and the three signals, and drops the manager's directive", async (t) => {
  const { assistant } = await directorPanel(t);
  // Seed every condition in Assistant #1's queue: a dead running row, an old park, and a startable queued row.
  const rec = assistant.assistantRecord(PRIMARY_ASSISTANT);
  const dead = addTask([], { title: "the dead run", thread: "T-dead", project: "agent-worktree-gui", worktree: "worktrees/dead-tree" }, { by: "reader" });
  let tasks = setTaskState(dead.tasks, dead.task.id, "running", { by: "reader" }).tasks;
  const parked = addTask(tasks, { title: "the old park", project: "agent-worktree-gui" }, { by: "reader", nextId: dead.nextId });
  tasks = parked.tasks;
  tasks = setTaskState(tasks, parked.task.id, "parked", {
    by: "reader",
    at: new Date(Date.now() - 90 * MINUTE),
    hold: { kind: "manual", value: "" },
    reason: "waiting on the deploy",
  }).tasks;
  const queued = addTask(tasks, { title: "the startable row", project: "agent-worktree-gui" }, { by: "reader", nextId: parked.nextId });
  writeQueueFile(assistant.queuePathOf(rec), queued.tasks, queued.nextId);

  const text = assistant.preamble("assistant-2");
  assert.match(text, /Read EVERY assistant's queue before the board/);
  assert.match(text, /Every assistant's queue \(the whole panel, not only your own\)/);
  assert.match(text, /Assistant #1 — Manager \(1 queued · 1 running, 1 stale · 1 parked/);
  assert.match(text, /Assistant #2 — Assistant Director \(your own\)/, "the Director's own empty queue is named");
  assert.match(text, /the dead run/, "the cross-queue digest carries the row");
  assert.match(text, /the run died/, "the dead-run signal is computed");
  assert.match(text, /parked 90 min/, "the old park is flagged");
  assert.match(text, /the startable row/, "the startable row is named");
  assert.match(text, /holds: agent-worktree-gui/, "the projects this assistant holds are named");
  assert.match(text, /^QUEUE <assistant> \|/m);
  assert.match(text, /^MESSAGE <assistant> \|/m);
  assert.doesNotMatch(text, /Never file work into another assistant's queue/, "the manager's prohibition is not the Director's");
  assert.doesNotMatch(text, /^SPAWN /m, "and it is not offered a worker it may not start");

  // The manager's turn still has the standing directive it always had.
  const manager = assistant.preamble(PRIMARY_ASSISTANT);
  assert.match(manager, /Never file work into another assistant's queue/);
  assert.doesNotMatch(manager, /^QUEUE /m);
});

// ---- 4. the running panel -----------------------------------------------------------------------------

test("a running panel lists the role, creates the assistant from it, and serves its charter, interval and empty queue", async (t) => {
  const panel = await startPanel({});
  t.after(() => panel.stop());

  const roles = await fetch(`${panel.base}/api/roles`);
  assert.equal(roles.status, 200);
  const rolesBody = await roles.json();
  const director = rolesBody.roles.find((r) => r.id === ASSISTANT_DIRECTOR_ID);
  assert.ok(director, "GET /api/roles lists the Assistant Director");
  assert.equal(director.name, "Assistant Director");
  assert.ok(director.chars > 4000 && director.chars <= CHARTER_MAX_CHARS, `its size (${director.chars}) is the charter's`);
  assert.match(director.description, /20 minutes/);
  assert.equal(rolesBody.count, 2, "the manager and the director");
  assert.ok(!("charter" in director), "the list never carries the 20 KB text");

  const created = await post(panel.base, "/api/assistant/assistants", { body: { roleId: ASSISTANT_DIRECTOR_ID } });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  const id = created.json.created.id;
  assert.equal(created.json.created.roleId, ASSISTANT_DIRECTOR_ID);

  const role = await fetch(`${panel.base}/api/assistant/role?assistantId=${id}`);
  assert.equal(role.status, 200);
  const roleBody = await role.json();
  assert.equal(roleBody.target.roleId, ASSISTANT_DIRECTOR_ID);
  assert.equal(roleBody.role.name, "Assistant Director");
  assert.equal(roleBody.wakeEveryMinutes, 20, "the tab reads the interval");
  assert.equal(roleBody.charter.text, await readFile(DIRECTOR_SEED, "utf8"), "and the charter, whole");
  assert.equal(roleBody.sameAsRole, true);

  const queue = await fetch(`${panel.base}/api/assistant/queue?assistantId=${id}`);
  assert.equal(queue.status, 200);
  const queueBody = await queue.json();
  assert.equal(queueBody.queue.found, true, "the queue exists");
  assert.deepEqual(queueBody.queue.tasks, [], "and is empty rather than missing");
  assert.equal(queueBody.queue.counts.total, 0);

  const state = await (await fetch(`${panel.base}/api/assistant`)).json();
  const rec = state.assistants.find((a) => a.id === id);
  assert.equal(rec.wakeEveryMinutes, 20);
  assert.equal(state.assistantSettings[id].spawn, "off", "it cannot start a worker");
});
