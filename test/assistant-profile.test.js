// One assistant's own settings and its own default role prompt. There is no whitelist any more.
//
// What this file is the contract for:
//
//   1. ISOLATION — a second assistant's knobs are its own. Setting #2's autonomy, spawn mode and model leaves
//      Assistant #1 byte-identical: same assistant.json, same `settings` object, no file of its own. The item that
//      asked for this reported the defect in one line ("the settings for all followup assistants currently don't
//      match the settings for the first assistant"), so the test asserts BOTH directions: #2's values are #2's, and
//      #1's are untouched — asserted on the bytes of assistant.json, not on the object graph alone.
//
//   2. THE ROLE PROMPT SURVIVES A RESTART — the default prompt the Role tab saves is in a file beside that
//      assistant's charter, and a NEW Assistant built over the same directory reads it back and runs on it. That is
//      the "use for if they need to restart" half of the request, and it is the reason the prompt is a file rather
//      than a field in the page.
//
//   3. THE WHITELISTS ARE GONE — the two lists that decided which projects an assistant was shown and where a
//      SPAWN might cut a tree are removed from the profile, the store, the Role pane, the route and the spawn check.
//      A profile file written by the older build still parses (the key is dropped); a SPAWN is judged by that
//      assistant's own spawn switch and by nothing else; and every project is offered to every assistant.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { parseActions } from "../lib/assistant/actions.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";
import { EMPTY_PROFILE, pickProfile, profileRelFor, readProfileFile, writeProfileFile } from "../lib/assistant/profile.js";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const slash = (p) => String(p || "").replace(/\\/g, "/");

// Two projects on the board: one to spawn in, and one more to prove that a second project is offered just the same
// now that no list decides what an assistant may see. The paths are fabricated on purpose: nothing here reads the
// filesystem for a project, and the card paths do not either.
const PROJECTS = [
  { name: "alpha", path: "C:/work/alpha" },
  { name: "beta", path: "C:/work/beta" },
];

async function panel(t, { projects = PROJECTS } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-profile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  // The v2 shape a live panel's file has: settings for #1 only, and nothing about assistants or profiles.
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const created = [];
  const logs = [];
  const spawned = [];
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
    getProjects: () => projects,
    spawner: async (spec) => {
      spawned.push(spec);
      return { id: `spawn-${spawned.length}`, thread: "wtgui-spawned", origin: {} };
    },
    onLog: (m) => logs.push(m),
  });
  const profileFile = (id) => path.join(dir, "assistants", id, "settings.json");
  return { assistant, created, spawned, logs, dir, assistantFile, profileFile };
}

// A turn of one assistant's thread, as far as `applyActions` is concerned: a thread, an id and the prose it wrote.
const turnOf = (assistant, id, prose) => ({
  id: `turn-${Math.random().toString(16).slice(2, 8)}`,
  thread: assistant.threadOf(id),
  lines: [{ type: "text", text: prose }],
});

test("a second assistant's knobs are its own, and Assistant #1's file is not touched", async (t) => {
  const { assistant, profileFile, assistantFile } = await panel(t);
  const before = sha(await readFile(assistantFile));
  const created = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" });
  const id = created.created.id;
  assert.equal(id, "assistant-2", "the next assistant");
  assert.equal(assistant.settingsFor(id).autonomy, "draft", "before anything is set, #2 is at its own default");
  assert.equal(assistant.settingsFor(id).spawn, "ask");

  assistant.setSettingsFor(id, { autonomy: "auto", spawn: "off", model: "some/small-model" });
  // Its own values…
  assert.equal(assistant.settingsFor(id).autonomy, "auto");
  assert.equal(assistant.settingsFor(id).spawn, "off");
  assert.equal(assistant.settingsFor(id).model, "some/small-model");
  // …and NOT Assistant #1's, which are the ones the panel booted with.
  assert.equal(assistant.settings.autonomy, "draft", "#1's autonomy did not move");
  assert.equal(assistant.settings.spawn, "ask", "#1's spawn mode did not move");
  assert.equal(assistant.settings.model, "", "#1's model did not move");
  assert.equal(assistant.settingsFor(PRIMARY_ASSISTANT), assistant.settings, "#1 resolves to the live settings object");
  // The settings went to #2's own file, beside its charter, and nowhere else.
  const stored = JSON.parse(await readFile(profileFile(id), "utf8"));
  assert.equal(stored.settings.autonomy, "auto");
  assert.equal(stored.settings.spawn, "off");
  assert.ok(!("rules" in stored) || Object.keys(stored.rules).length === 0, "a rule level nobody chose stays absent");
  // assistant.json is byte-identical: creating an assistant writes assistants.json, not this file, and writing #2's
  // knobs never touches it either.
  assert.equal(sha(await readFile(assistantFile)), before, "Assistant #1's store is byte-identical");
  // A rule level is per assistant too.
  assistant.setSettingsFor(id, { rules: { quiet: "wake" } });
  assert.equal(assistant.settingsFor(id).rules.quiet, "wake");
  assert.equal(assistant.settings.rules.quiet, "log", "#1's quiet rule is still its default");
  // The wake knobs ride in the profile as well: they are pickSettings keys, so #2's file can carry its own budget
  // and its own quiet windows instead of answering with Assistant #1's numbers. Only #2's move.
  const WAKE = { maxWakesPerHour: 3, quietSeconds: 90, childQuietSeconds: 120 };
  assistant.setSettingsFor(id, WAKE);
  assert.deepEqual(
    { maxWakesPerHour: assistant.settingsFor(id).maxWakesPerHour, quietSeconds: assistant.settingsFor(id).quietSeconds, childQuietSeconds: assistant.settingsFor(id).childQuietSeconds },
    WAKE,
    "#2's wake knobs are its own",
  );
  const wakeStored = JSON.parse(await readFile(profileFile(id), "utf8")).settings;
  assert.equal(wakeStored.maxWakesPerHour, 3, "and they are in its file, not in memory alone");
  assert.equal(assistant.settings.maxWakesPerHour, 6, "#1's wake budget did not move");
  assert.equal(assistant.settings.quietSeconds, 240);
  assert.equal(assistant.settings.childQuietSeconds, 300);
});

test("the default role prompt is saved by the Role tab's route and read back after a restart", async (t) => {
  const { assistant, dir, profileFile } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager" }).created.id;
  const PROMPT = "You are the reviewer: read the diff before you answer, and never approve your own work.";
  const saved = assistant.saveProfile(id, { prompt: PROMPT });
  assert.equal(saved.profile.promptChars, PROMPT.length, "the pane is told the size it just saved");
  assert.ok(saved.profile.exists, "the file exists on disk");
  assert.equal(JSON.parse(await readFile(profileFile(id), "utf8")).prompt, PROMPT);
  // The turn runs on it — that is what the prompt is FOR.
  assert.ok(assistant.preamble(id).includes("Your default role prompt"), "the preamble carries it");
  assert.ok(assistant.preamble(id).includes(PROMPT), "in full");
  assert.ok(!assistant.preamble(PRIMARY_ASSISTANT).includes(PROMPT), "#1 is not told #2's prompt");

  // A RESTART: a new instance over the same state directory. Nothing is re-saved here — the file is the authority.
  const booted = new Assistant({ config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json") }, jobs: { list: () => [], firstOfThread: () => null, create: async () => ({}) }, getProjects: () => PROJECTS });
  assert.equal(booted.profileOf(id).prompt, PROMPT, "the prompt survived the restart");
  assert.ok(booted.preamble(id).includes(PROMPT), "and the first turn after it runs on the prompt");
  assert.equal(booted.rolePayload(id).prompt, PROMPT, "the Role tab opens showing it");

  // #1's own prompt: an optional file it never had, holding ONLY the new field — its knobs stay in assistant.json.
  // Written only when the reader actually uses the field.
  assert.equal(assistant.profileMetaOf(PRIMARY_ASSISTANT).exists, false, "nothing was created for #1 by merely existing");
  assistant.saveProfile(PRIMARY_ASSISTANT, { prompt: "Be brief." });
  const own = JSON.parse(await readFile(profileFile(PRIMARY_ASSISTANT), "utf8"));
  assert.equal(own.prompt, "Be brief.");
  assert.ok(!("settings" in own), "#1's profile carries no knobs — those live in assistant.json");
  assert.ok(assistant.preamble(PRIMARY_ASSISTANT).includes("Be brief."), "#1 runs on its own prompt");
  assert.ok(!assistant.preamble(id).includes("Be brief."), "and #2 does not");
});

test("clearing the prompt clears it in the file and in the next turn", async (t) => {
  const { assistant, profileFile } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager" }).created.id;
  assistant.saveProfile(id, { prompt: "first" });
  assistant.saveProfile(id, { prompt: "" });
  assert.equal(JSON.parse(await readFile(profileFile(id), "utf8")).prompt, "");
  assert.ok(!assistant.preamble(id).includes("Your default role prompt"), "an empty prompt adds nothing to the turn");
});

test("the whitelists are gone from the profile, the payloads, the page and the route", async (t) => {
  const { assistant, profileFile } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager" }).created.id;
  // The module exports nothing to match a list against, and the profile it hands back has no key for one.
  const profile = await import("../lib/assistant/profile.js");
  for (const key of ["whitelistMatches", "parseWhitelist", "whitelistText", "describeList", "WHITELIST_ALL", "WHITELIST_MAX"]) {
    assert.ok(!(key in profile), `${key} is not exported any more`);
  }
  assert.deepEqual(EMPTY_PROFILE, { settings: {}, rules: {}, prompt: "", escalateTo: [], dock: "docked" });
  // A profile file written by the older build still reads: the retired key is dropped, not carried.
  assert.deepEqual(pickProfile({ prompt: "hello", whitelists: { projects: ["alpha"], worktrees: ["*"] } }), {
    settings: {},
    rules: {},
    prompt: "hello",
    escalateTo: [],
    dock: "docked",
  });
  // The route's body no longer carries them: a caller that posts them anyway writes no such key.
  assistant.saveProfile(id, { prompt: "kept", projects: ["alpha"], worktrees: ["wtgui-x-1a2b3c"] });
  const stored = JSON.parse(await readFile(profileFile(id), "utf8"));
  // An extra assistant's file carries its own knobs beside the prompt (that is main's saveProfile design — a Role
  // save must not wipe the settings a reader chose on the Settings tab). What must NOT be there is the two lists
  // the posted body still names, or the retired key.
  assert.deepEqual(Object.keys(stored).sort(), ["prompt", "rules", "savedAt", "settings", "version"], "the posted lists are not written");
  assert.ok(!("whitelists" in stored), "and neither is the retired key");
  assert.ok(!("projects" in stored) && !("worktrees" in stored), "nor either posted list");
  // The payloads the page reads carry no list either.
  assert.ok(!("whitelists" in assistant.rolePayload(id)));
  assert.ok(!("whitelists" in assistant.profileMetaOf(id)));
  // The page's Role pane offers no whitelist control at all.
  const page = await readFile(new URL("../public/assistant.js", import.meta.url), "utf8");
  for (const control of ["as-projects", "as-worktrees", "btn-as-whitelists", "as-whitelist-err"]) {
    assert.ok(!page.includes(`"${control}"`), `${control} is gone from the page`);
  }
  // And the server's profile route does not read the two fields out of the body.
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.doesNotMatch(server, /projects: body\.projects|worktrees: body\.worktrees/);
});

test("a SPAWN is judged by the assistant's own spawn switch and by nothing else", async (t) => {
  const { assistant, spawned } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager" }).created.id;
  // `ask`: the line becomes a card, whichever project it names — there is no list to fall outside of.
  assistant.setSettingsFor(id, { spawn: "ask" });
  const job = turnOf(assistant, id, "SPAWN beta | do something in beta");
  await assistant.applyActions(job, parseActions(job.lines[0].text));
  const card = assistant.alerts.find((a) => a.spawn && a.status === "open");
  assert.ok(card, "the line became a card");
  assert.equal(card.spawn.assistantId, id, "the card says whose card it is");
  assert.equal(assistant.journal.filter((j) => j.kind === "spawn-refused").length, 0, "nothing was refused");
  assert.equal(spawned.length, 0, "a card starts nothing");

  // `off`: nothing exists behind the line, and the journal says why.
  assistant.setSettingsFor(id, { spawn: "off" });
  const off = turnOf(assistant, id, "SPAWN alpha | never mind");
  await assistant.applyActions(off, parseActions(off.lines[0].text));
  const skipped = assistant.journal.find((j) => j.kind === "spawn-skipped");
  assert.ok(skipped, "the switch is what refuses it");
  assert.match(skipped.text, /switched off/);
  assert.equal(assistant.alerts.filter((a) => a.spawn && a.status === "open").length, 1, "no second card");

  // Assistant #1's own settings are untouched by either turn.
  assert.equal(assistant.settings.spawn, "ask");
});

test("the preamble offers every project on the panel, to every assistant", async (t) => {
  const { assistant } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager" }).created.id;
  for (const who of [PRIMARY_ASSISTANT, id]) {
    const text = assistant.preamble(who);
    assert.match(text, /- alpha · C:\/work\/alpha/, `${who} is shown alpha`);
    assert.match(text, /- beta · C:\/work\/beta/, `${who} is shown beta`);
    assert.ok(!/whitelist|hidden by your/i.test(text), "and nothing claims a project is hidden");
  }
});

test("Assistant #1 with no profile file answers the same payload it always did", async (t) => {
  const { assistant, assistantFile, dir } = await panel(t);
  const before = sha(await readFile(assistantFile));
  const state = assistant.state();
  assert.ok(!("assistantSettings" in state), "no per-assistant map on a single-assistant panel");
  assert.ok(!("profile" in state.assistants[0]), "and no profile field on its record");
  assert.equal(state.settings.autonomy, "draft");
  assert.equal(state.settings.rules.settle, "wake");
  // Booting and reading wrote nothing: the store, the charter and #1's own directory are untouched.
  assert.equal(sha(await readFile(assistantFile)), before);
  await assert.rejects(() => stat(path.join(dir, "assistants", PRIMARY_ASSISTANT, "settings.json")));
  // Its role payload is the one the tab has always read, with the new field EMPTY rather than missing.
  const role = assistant.rolePayload(PRIMARY_ASSISTANT);
  assert.equal(role.prompt, "");
  assert.ok(!("whitelists" in role), "and no list on it");
  assert.equal(role.target.id, PRIMARY_ASSISTANT);
});

test("the profile file's own shape: one path per assistant, beside its charter", () => {
  assert.equal(slash(profileRelFor("assistant-2")), "assistants/assistant-2/settings.json");
  assert.equal(slash(profileRelFor("assistant-1")), "assistants/assistant-1/settings.json");
  assert.deepEqual(readProfileFile(path.join(os.tmpdir(), "wtgui-no-such-file", "settings.json")).profile, EMPTY_PROFILE);
  // The thread of an extra assistant is its own, which is how a finished turn is traced back to whose settings
  // judged it.
  assert.equal(threadFor("assistant-2"), "panel-assistant-2");
});

test("the writer never puts a whitelist back on disk", async (t) => {
  const { dir } = await panel(t);
  const file = path.join(dir, "assistants", "assistant-2", "settings.json");
  assert.deepEqual(writeProfileFile(file, { prompt: "p", whitelists: { projects: ["alpha"], worktrees: [] } }), { error: null });
  const body = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(body).sort(), ["prompt", "savedAt", "version"]);
});
