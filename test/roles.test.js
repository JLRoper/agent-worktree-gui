// A role is {id, name, description, charter}, and an assistant is a thread plus the role it runs.
//
// What this file is the contract for:
//
//   1. the seed — the panel's own `state/assistant-charter.md` copied verbatim to `data/roles/agent-manager.md`, so
//      seeding the Agent Manager role loses NOTHING of a charter a reader already wrote. Asserted by bytes: the
//      seeded charter is strictly equal to the file, and both sha256s are the same string;
//   2. the remit — the manager's one-line description names the end state it drives to (an approved PR ready to
//      merge) and each of the five wakes it exists for (a settle, an EXITED run, a loop, a quiet agent, leftover
//      work), because that line is what the preamble carries on every turn;
//   3. the seam — each assistant's preamble is built from ITS OWN charter and ITS OWN rules. The item that asked
//      for roles says it plainly: Assistant #2's edit must not change one byte of what Assistant #1 is told;
//   4. the copies — an assistant made from a role gets the role's bytes as its own file, a fresh thread number, and
//      an empty rule list; editing one copy leaves the other alone;
//   5. the cap and #1's route — 20,000 characters on every copy, and the first assistant still writes the file and
//      answers `charterPayload()` the way it did before roles existed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant, ASSISTANT_THREAD } from "../lib/assistant.js";
import { CHARTER_MAX_CHARS } from "../lib/charter.js";
import { AGENT_MANAGER_DESCRIPTION, ROLE_CHARTER_MAX_CHARS, agentManagerRole, roleMeta, writeRoleCharter } from "../lib/roles.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";

const SEED_URL = new URL("../data/roles/agent-manager.md", import.meta.url);
const sha = (text) => createHash("sha256").update(text).digest("hex");

async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-roles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const created = [];
  const logs = [];
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: {
      list: () => [],
      firstOfThread: () => null,
      create: async (body) => {
        created.push(body);
        return { id: `job-${created.length}`, ...body };
      },
    },
    onLog: (m) => logs.push(m),
  });
  return {
    assistant,
    created,
    logs,
    dir,
    charter: path.join(dir, "assistant-charter.md"),
    rolesFile: path.join(dir, "roles.json"),
    assistantsFile: path.join(dir, "assistants.json"),
  };
}

test("the Agent Manager role is the panel's own charter, byte for byte", async (t) => {
  const { assistant, rolesFile } = await panel(t);
  const seed = await readFile(SEED_URL, "utf8");
  assert.equal(assistant.roles.length, 1, "one seeded role");
  const [role] = assistant.roles;
  assert.equal(role.id, "agent-manager");
  assert.equal(role.name, "Agent Manager");
  assert.equal(role.charter, seed, "the seeded charter IS the repo's copy of the live file");
  assert.equal(sha(role.charter), sha(seed), "…and its sha256 is the same string");
  assert.ok(role.charter.includes("## Role and remit"), "the reader's own headings survive");
  assert.ok(role.charter.includes("## How to update this file"), "including the one that says how to edit it");
  assert.ok(role.charter.length <= ROLE_CHARTER_MAX_CHARS, `it fits the cap (${role.charter.length}/${ROLE_CHARTER_MAX_CHARS})`);
  // Seeded once on disk, and read back rather than regenerated: a second boot keeps whatever the reader wrote.
  const stored = JSON.parse(await readFile(rolesFile, "utf8"));
  assert.equal(stored.roles.length, 1);
  assert.equal(stored.roles[0].charter, seed);
  assert.ok(await stat(rolesFile));
});

test("the remit says what the manager drives to and what it wakes on", () => {
  assert.match(AGENT_MANAGER_DESCRIPTION, /approved PR ready to merge/i, "the end state is an approved, mergeable PR");
  for (const w of ["settle", "EXITED", "loop", "quiet", "leftover"]) {
    assert.ok(AGENT_MANAGER_DESCRIPTION.includes(w), `…and it names the ${w} wake`);
  }
  const meta = roleMeta(agentManagerRole({ charter: "x" }));
  assert.deepEqual(
    Object.keys(meta).sort(),
    ["cap", "chars", "description", "id", "name", "over", "updatedAt"],
    "the tab's view of a role never carries the text",
  );
  assert.equal(meta.chars, 1);
  assert.equal(meta.over, false);
});

test("a role's charter has the same cap and the same stale-save refusal as the file it came from", async (t) => {
  const { assistant, rolesFile } = await panel(t);
  const over = "x".repeat(ROLE_CHARTER_MAX_CHARS + 1);
  let code = null;
  try {
    // Through the same writer the route uses: lib/roles.js's `writeRoleCharter`.
    writeRoleCharter(rolesFile, assistant.roles, "agent-manager", over);
  } catch (e) {
    code = e.code;
  }
  assert.equal(code, "charter-too-long", "over the cap is refused with its own code");
  const stored = JSON.parse(await readFile(rolesFile, "utf8"));
  assert.equal(stored.roles[0].charter.length, (await readFile(SEED_URL, "utf8")).length, "and the file is untouched");

  const before = new Date(assistant.roles[0].updatedAt || 0).getTime();
  await new Promise((r) => setTimeout(r, 25));
  writeRoleCharter(rolesFile, assistant.roles, "agent-manager", "# rewritten\n");
  code = null;
  try {
    writeRoleCharter(rolesFile, assistant.roles, "agent-manager", "# stale\n", { expectMtime: before });
  } catch (e) {
    code = e.code;
  }
  assert.equal(code, "charter-stale", "a save that read the older role is refused");
  assert.equal(JSON.parse(await readFile(rolesFile, "utf8")).roles[0].charter, "# rewritten\n", "and the newer text stands");
});

test("Assistant #1 keeps its thread, its file and its route; #2 gets a copy of its own", async (t) => {
  const { assistant, charter } = await panel(t);
  const seed = await readFile(SEED_URL, "utf8");
  assert.equal(assistant.assistants.length, 1);
  assert.equal(assistant.assistants[0].id, PRIMARY_ASSISTANT);
  assert.equal(assistant.threadOf(PRIMARY_ASSISTANT), ASSISTANT_THREAD, "#1's thread is the id the panel always used");
  assert.equal(assistant.charterPathOf(assistant.assistantRecord()), charter, "#1's charter is the panel's own file");

  // #1's route, unchanged: the same file, the same payload shape, the same cap.
  const payload = assistant.setCharter("# mine\n");
  assert.equal(await readFile(charter, "utf8"), "# mine\n");
  assert.equal(payload.chars, 7);
  assert.equal(payload.cap, CHARTER_MAX_CHARS);
  assert.equal(typeof payload.mtime, "number");

  const out = assistant.createAssistant({ roleId: "agent-manager" });
  assert.equal(out.assistant.id, "assistant-2");
  assert.equal(out.assistant.threadId, threadFor("assistant-2"));
  assert.equal(out.assistant.threadId, "panel-assistant-2");
  assert.notEqual(out.assistant.threadId, ASSISTANT_THREAD, "its own thread, not the first one's");
  assert.deepEqual(out.assistant.rules, [], "its own rules start empty");
  const copy = assistant.charterPathOf(assistant.assistantRecord("assistant-2"));
  assert.equal(await readFile(copy, "utf8"), seed, "its charter is the role's bytes");
  assert.notEqual(copy, charter, "in a file of its own");
  assert.equal(await readFile(charter, "utf8"), "# mine\n", "and #1's file was not touched by creating it");
});

test("each assistant's preamble carries only its own charter, so #2 cannot inherit #1's text", async (t) => {
  const { assistant } = await panel(t);
  assistant.setCharter("# #1\n\nFIRST-ONLY-TEXT\n");
  assistant.createAssistant({ roleId: "agent-manager" });

  const first = assistant.preamble(PRIMARY_ASSISTANT);
  assert.ok(first.includes("FIRST-ONLY-TEXT"), "#1's preamble carries its own text");
  assert.match(first, /Your role: Agent Manager — /, "and it names the role it runs");
  assert.match(first, /Charter — the long tier, read in full on every turn \(role Agent Manager; /, "the briefing is labelled with the role");
  assert.ok(!assistant.preamble("assistant-2").includes("FIRST-ONLY-TEXT"), "#2 does not start with #1's memory");

  // The edit that the item is really about.
  assistant.setCharterFor("assistant-2", "SECOND-ONLY-TEXT\n");
  assert.ok(assistant.preamble("assistant-2").includes("SECOND-ONLY-TEXT"), "#2 sees its own edit");
  assert.ok(!assistant.preamble(PRIMARY_ASSISTANT).includes("SECOND-ONLY-TEXT"), "#1 does not");
  assert.ok(assistant.preamble(PRIMARY_ASSISTANT).includes("FIRST-ONLY-TEXT"), "and still sees its own");
  assert.match(assistant.preamble("assistant-2"), /You are Assistant #2,/, "a preamble says which assistant it is for");
});

test("a turn for #2 is created on #2's thread with #2's preamble", async (t) => {
  const { assistant, created } = await panel(t);
  assistant.setCharter("# #1\n\nFIRST-ONLY-TEXT\n");
  assistant.createAssistant({ roleId: "agent-manager" });
  await assistant.say("what is going on?", { assistantId: "assistant-2" });
  await assistant.say("and for you?");
  assert.equal(created.length, 2);
  assert.equal(created[0].thread, "panel-assistant-2", "#2's turn runs on #2's thread");
  assert.ok(created[0].preamble.includes("You are Assistant #2,"), "with #2's preamble");
  assert.ok(!created[0].preamble.includes("FIRST-ONLY-TEXT"), "and not #1's charter");
  assert.equal(created[0].assistant, true, "still marked as an assistant turn, so no rule judges it a worker");
  assert.equal(created[1].thread, ASSISTANT_THREAD, "the default is still Assistant #1");
  assert.ok(created[1].preamble.includes("FIRST-ONLY-TEXT"));
  assert.ok(assistant.isAssistantThread("panel-assistant-2") && assistant.isAssistantThread(ASSISTANT_THREAD));
  assert.ok(assistant.isOwnRun({ thread: "panel-assistant-2" }), "#2's run is the assistant's own, not a worker's");
  const digest = assistant.digest();
  assert.doesNotMatch(digest, /panel-assistant-2/, "and neither assistant's thread is listed as a worker");
});

test("rules belong to one assistant, and adopting a role replaces only that assistant's copy", async (t) => {
  const { assistant } = await panel(t);
  assistant.createAssistant({ roleId: "agent-manager" });
  assistant.addRuleFor("assistant-2", "ask before writing");
  assert.equal(assistant.assistantRecord("assistant-2").rules.length, 1);
  assert.equal(assistant.rules.length, 0, "#1's rules were not touched");
  assert.ok(assistant.preamble("assistant-2").includes("ask before writing"));
  assert.ok(!assistant.preamble(PRIMARY_ASSISTANT).includes("ask before writing"));

  assistant.createRole({ name: "Reviewer", description: "reads PRs and says no", from: "agent-manager" });
  assert.equal(assistant.roles.length, 2);
  const picked = assistant.pickRole("assistant-2", "reviewer", { adopt: true });
  assert.equal(picked.role.id, "reviewer");
  assert.equal(picked.sameAsRole, true, "its charter is the role's text again");
  assert.match(picked.role.description, /reads PRs/);
  assert.ok(assistant.preamble("assistant-2").includes("Your role: Reviewer"), "#2's preamble follows the pick");
  assert.match(assistant.preamble(PRIMARY_ASSISTANT), /Your role: Agent Manager/, "#1 still runs the manager role");

  // A pick without `adopt` changes the title and leaves the text where the reader put it.
  assistant.setCharterFor("assistant-2", "# mine again\n");
  const again = assistant.pickRole("assistant-2", "agent-manager");
  assert.equal(again.role.id, "agent-manager");
  assert.equal(again.charter.text, "# mine again\n", "picking a role is not an overwrite");
});

test("both copies refuse a save over the 20,000-character cap", async (t) => {
  const { assistant } = await panel(t);
  assistant.createAssistant({ roleId: "agent-manager" });
  for (const id of [PRIMARY_ASSISTANT, "assistant-2"]) {
    let code = null;
    try {
      assistant.setCharterFor(id, "x".repeat(CHARTER_MAX_CHARS + 1));
    } catch (e) {
      code = e.code;
    }
    assert.equal(code, "charter-too-long", `${id}: over the cap is a 413`);
    assert.ok(assistant.charterPayloadFor(id).chars < CHARTER_MAX_CHARS, `${id}: and nothing was written`);
  }
  assert.equal(assistant.setCharterFor("assistant-2", "y".repeat(CHARTER_MAX_CHARS)).chars, CHARTER_MAX_CHARS, "exactly the cap is allowed");
});
