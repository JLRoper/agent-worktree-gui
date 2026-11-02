// One assistant's own settings, its own default role prompt and its two optional whitelists.
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
//   3. WHITELIST MATCHING — "*", an exact name, an empty list and a name nothing matches, all four, on the matcher
//      itself and through `spawnAllowed` (which is what a SPAWN line and a pressed card actually ask).
//
//   4. ENFORCEMENT — a SPAWN outside the project list is refused where the line is read (journaled, no card, no
//      run), a SPAWN IN outside the worktree list likewise, and a card pressed AFTER the list was tightened is
//      refused too: a card is not a way around the list it was made under.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { parseActions } from "../lib/assistant/actions.js";
import { PRIMARY_ASSISTANT, threadFor } from "../lib/assistants.js";
import { EMPTY_PROFILE, describeList, parseWhitelist, profileRelFor, readProfileFile, whitelistMatches } from "../lib/assistant/profile.js";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const slash = (p) => String(p || "").replace(/\\/g, "/");

// Two projects on the board, so a whitelist has something to include and something to leave out. The paths are
// fabricated on purpose: nothing here reads the filesystem for a project, and the card/refusal paths do not either.
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
  assert.equal(assistant.settings.rules.quiet, "debug" in assistant.settings.rules ? assistant.settings.rules.quiet : "log", "#1's quiet rule is still its default");
  assert.equal(assistant.settings.rules.quiet, "log");
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

  // #1's own prompt: an optional file it never had, holding ONLY the two new fields — its knobs stay in
  // assistant.json. Written only when the reader actually uses the field.
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

test("whitelist matching: *, an exact name, an empty list, and a name nothing matches", () => {
  // Empty means ALL — neither list is required, so a blank box must not hide the whole board.
  assert.equal(whitelistMatches([], ["alpha"]), true);
  assert.equal(whitelistMatches(parseWhitelist(""), ["alpha"]), true);
  // "*" means all, alone or beside real entries.
  assert.equal(whitelistMatches(["*"], ["anything", "C:/x"]), true);
  assert.equal(whitelistMatches(parseWhitelist("*, alpha"), ["beta"]), true);
  // An exact name matches, case- and separator-insensitively, and WHOLE — never as a prefix.
  assert.equal(whitelistMatches(["alpha"], ["alpha"]), true);
  assert.equal(whitelistMatches(["alpha"], ["Alpha"]), true);
  assert.equal(whitelistMatches(["C:/work/alpha"], ["c:\\work\\alpha\\"]), true);
  assert.equal(whitelistMatches(["agent"], ["agent-worktree-gui"]), false, "a name is whole, not a prefix");
  // An unknown name simply matches nothing: it is not an error, and it is not the same as "*".
  assert.equal(whitelistMatches(["gamma"], ["alpha", "beta"]), false);
  // Separators: commas AND newlines, blanks dropped, duplicates folded.
  assert.deepEqual(parseWhitelist("alpha, beta\ngamma\n\n"), ["alpha", "beta", "gamma"]);
  assert.deepEqual(parseWhitelist("alpha, Alpha , alpha"), ["alpha"], "deduped case-insensitively, the first spelling kept");
  assert.deepEqual(parseWhitelist([]), []);
  // The sentence the journal and the refusal carry.
  assert.equal(describeList([]), "all (no list — every one)");
  assert.equal(describeList(["*"]), "all (*)");
  assert.match(describeList(["alpha", "beta"]), /^2 entries \(alpha, beta\)$/);
});

test("spawnAllowed asks the project list for a SPAWN and the worktree list for a SPAWN IN", async (t) => {
  const { assistant } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager" }).created.id;
  // Open by default: everything is allowed until the reader types.
  assert.equal(assistant.spawnAllowed(id, { target: "beta" }).ok, true, "no list = all");
  assistant.saveProfile(id, { projects: ["alpha"] });
  assert.equal(assistant.spawnAllowed(id, { target: "alpha" }).ok, true);
  assert.equal(assistant.spawnAllowed(id, { target: "C:/work/alpha/.worktrees/x" }).ok, true, "a path inside a whitelisted project");
  const refused = assistant.spawnAllowed(id, { target: "beta" });
  assert.equal(refused.ok, false);
  assert.equal(refused.list, "projects");
  assert.match(refused.reason, /whitelisted projects \(1 entry \(alpha\)\)/);
  // "*" opens it again.
  assistant.saveProfile(id, { projects: "*" });
  assert.equal(assistant.spawnAllowed(id, { target: "beta" }).ok, true, "* means all");
  // SPAWN IN is the WORKTREE list, and a project name counts as one of that tree's names.
  assistant.saveProfile(id, { worktrees: ["wtgui-fix-the-thing-abc123"] });
  assert.equal(assistant.spawnAllowed(id, { target: "wtgui-fix-the-thing-abc123", existing: true }).ok, true);
  assert.equal(assistant.spawnAllowed(id, { target: "C:/work/alpha/.worktrees/wtgui-fix-the-thing-abc123", existing: true }).ok, true, "the directory name matches the path");
  const inRefused = assistant.spawnAllowed(id, { target: "C:/work/beta/.worktrees/other", existing: true });
  assert.equal(inRefused.ok, false);
  assert.equal(inRefused.list, "worktrees");
  // Assistant #1 keeps its own behaviour: no lists, everything allowed.
  assert.equal(assistant.spawnAllowed(PRIMARY_ASSISTANT, { target: "beta" }).ok, true);
  assert.equal(assistant.spawnAllowed(PRIMARY_ASSISTANT, { target: "whatever", existing: true }).ok, true);
});

test("a SPAWN outside the project list is refused where the line is read — no card, no run", async (t) => {
  const { assistant, spawned } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager" }).created.id;
  assistant.saveProfile(id, { projects: ["alpha"] });
  // `ask` mode: an allowed line becomes a card, a refused one becomes nothing at all.
  assistant.setSettingsFor(id, { spawn: "ask" });
  const job = turnOf(assistant, id, "SPAWN beta | do something in beta");
  await assistant.applyActions(job, parseActions(job.lines[0].text));
  const refusal = assistant.journal.find((j) => j.kind === "spawn-refused");
  assert.ok(refusal, "the refusal is in the journal the digest reads");
  assert.match(refusal.text, /SPAWN beta/);
  assert.match(refusal.text, /whitelisted projects/);
  assert.equal(assistant.alerts.filter((a) => a.spawn).length, 0, "no card was made for a line it may not write");
  assert.equal(spawned.length, 0, "and nothing started");

  const ok = turnOf(assistant, id, "SPAWN alpha | do something in alpha");
  await assistant.applyActions(ok, parseActions(ok.lines[0].text));
  const card = assistant.alerts.find((a) => a.spawn && a.status === "open");
  assert.ok(card, "an allowed line still becomes a card");
  assert.equal(card.spawn.assistantId, id, "the card says whose card it is");

  // The press path re-checks: a card made while the list was open must not start after the reader narrows it.
  assistant.saveProfile(id, { projects: ["gamma"] });
  await assert.rejects(() => assistant.startSpawn(card.spawn, { alertId: card.id }), (e) => e.code === "spawn-not-allowed");
  assert.equal(spawned.length, 0, "the press did not start a run either");
  // Assistant #1's own card path is unaffected: no stamp, no list, allowed.
  assert.equal(assistant.spawnAllowed(PRIMARY_ASSISTANT, { target: "beta" }).ok, true);
  assert.equal(assistant.spawnAllowed(PRIMARY_ASSISTANT, { target: "beta" }).entries.length, 0);
});

test("a SPAWN IN outside the worktree list is refused the same way", async (t) => {
  const { assistant } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager" }).created.id;
  assistant.saveProfile(id, { worktrees: ["wtgui-mine-abc123"] });
  assistant.setSettingsFor(id, { spawn: "ask" });
  const job = turnOf(assistant, id, "SPAWN IN C:/work/alpha/.worktrees/wtgui-theirs-def456 | look at it");
  await assistant.applyActions(job, parseActions(job.lines[0].text));
  const refusal = assistant.journal.find((j) => j.kind === "spawn-refused");
  assert.ok(refusal);
  assert.match(refusal.text, /whitelisted worktrees/);
  assert.equal(assistant.alerts.filter((a) => a.spawn).length, 0);
});

test("the preamble shows only the whitelisted projects, and says how many it is hiding", async (t) => {
  const { assistant } = await panel(t);
  const id = assistant.createAssistant({ roleId: "agent-manager" }).created.id;
  assistant.saveProfile(id, { projects: ["alpha"] });
  const own = assistant.preamble(id);
  assert.match(own, /- alpha · C:\/work\/alpha/);
  assert.ok(!own.includes("beta"), "#2 is not shown the project it may not use");
  assert.match(own, /1 more project exists on this panel and are hidden by your project whitelist/);
  // Assistant #1's preamble is what it always was: both projects, no hidden line, no prompt block.
  const first = assistant.preamble(PRIMARY_ASSISTANT);
  assert.match(first, /- alpha · C:\/work\/alpha/);
  assert.match(first, /- beta · C:\/work\/beta/);
  assert.ok(!/hidden by your project whitelist/.test(first));
  assert.ok(!first.includes("Your default role prompt"));
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
  // Its role payload is the one the tab has always read, with the two new fields EMPTY rather than missing.
  const role = assistant.rolePayload(PRIMARY_ASSISTANT);
  assert.equal(role.prompt, "");
  assert.deepEqual(role.whitelists, { projects: [], worktrees: [] });
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
