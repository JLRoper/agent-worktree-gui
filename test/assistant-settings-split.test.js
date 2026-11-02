// The split between the panel's WATCHDOG and one ASSISTANT's own settings, asserted where the decision lives.
//
// The page can only draw what the server tells it, so the contract is here, in three facts:
//
//   1. ONE OWNER PER KEY — lib/assistant/config.js's SETTINGS_SCOPE partitions every knob (and the three profile
//      fields) into exactly two panes, and the two derived lists never intersect. A key nobody declared has no
//      owner, so a new knob cannot slip into a pane by default.
//
//   2. ASSISTANT #1'S SERVED PAYLOAD IS UNCHANGED — `state().settings` is the same object, the same keys and the
//      same values it was before the split: nothing moved out to a "watchdog" sub-record, and the panel-wide
//      metadata the page needs arrives as NEW keys beside it (settingScope, escalateTo). Its files are
//      byte-identical after a boot that only reads.
//
//   3. A WRITE LANDS IN ONE FILE — a second assistant's knobs (and its escalation list) go to its own file beside
//      its charter, and Assistant #1's store is byte-identical afterwards. The list is STORED and INERT: it is not a
//      settings knob, no preamble mentions it, and nothing in the wake path reads it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { ASSISTANT_KEYS, DEFAULTS, SETTINGS_SCOPE, WATCHDOG_KEYS, scopeOf } from "../lib/assistant/config.js";
import { ESCALATION_MAX, EMPTY_PROFILE, pickEscalation } from "../lib/assistant/profile.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// The keys Assistant #1's `settings` payload has carried since before any of this existed. Written out rather than
// read off DEFAULTS: a test that takes the store's own key list as its expectation cannot notice a key MOVING out of
// `settings` into a per-pane record, which is exactly what a careless split does.
const FIRST_SETTINGS_KEYS = [
  "approvalSeconds",
  "autonomy",
  "childQuietSeconds",
  "commandAudit",
  "contextPercent",
  "cwd",
  "enabled",
  "exitedSeconds",
  "leftoverMinutes",
  "maxWakesPerHour",
  "model",
  // The queue's two knobs are #1's settings like every other assistant's: the digest size and the sweep cadence
  // belong in the same object as its wake budget, so `state.settings` carries them and the Watchdog tab draws them.
  "queueDigestSize",
  "queueSweepEveryNWakes",
  "quietSeconds",
  "rearmSeconds",
  "repeatLimit",
  "repeatTurns",
  "rules",
  "seconds",
  "spawn",
  "spawnAutoStart",
];

async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-split-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    onLog: () => {},
  });
  return { assistant, dir, assistantFile, profileFile: (id) => path.join(dir, "assistants", id, "settings.json") };
}

test("every key has exactly one owner, and the two panes' key lists never intersect", () => {
  const overlap = WATCHDOG_KEYS.filter((k) => ASSISTANT_KEYS.includes(k));
  assert.deepEqual(overlap, [], "no key is owned by both panes");
  assert.deepEqual([...WATCHDOG_KEYS, ...ASSISTANT_KEYS].sort(), Object.keys(SETTINGS_SCOPE).sort(), "the two lists are the table");
  // Every knob is placed; nothing in DEFAULTS is left unowned, and nothing is owned that the store does not have.
  assert.deepEqual(
    Object.keys(DEFAULTS).filter((k) => !scopeOf(k)).sort(),
    [],
    "every knob in DEFAULTS has an owner",
  );
  assert.deepEqual(
    [...WATCHDOG_KEYS, ...ASSISTANT_KEYS].filter((k) => k in DEFAULTS).sort(),
    Object.keys(DEFAULTS).sort(),
    "and the table declares no knob the store lacks",
  );
  // The two profile fields are an assistant's, and they are the only non-knobs in the table.
  const notKnobs = [...WATCHDOG_KEYS, ...ASSISTANT_KEYS].filter((k) => !(k in DEFAULTS));
  assert.deepEqual(notKnobs.sort(), ["escalateTo", "prompt"]);
  for (const key of notKnobs) assert.equal(scopeOf(key), "assistant");
  // A key nobody declared has NO owner: a new knob must be placed before a pane can draw it.
  assert.equal(scopeOf("aKeyNobodyDeclared"), null);
  // The panel-wide half is the sentry's own: the switch, the table, the journal and the per-pass bars.
  for (const key of ["enabled", "rules", "commandAudit", "spawnAutoStart", "seconds", "repeatLimit", "approvalSeconds", "exitedSeconds", "contextPercent", "leftoverMinutes", "repeatTurns", "rearmSeconds"]) {
    assert.equal(scopeOf(key), "watchdog", `${key} is the panel's, not an assistant's`);
  }
  // ...and this assistant's half is what one file can own.
  for (const key of ["autonomy", "spawn", "model", "cwd", "maxWakesPerHour", "quietSeconds", "childQuietSeconds"]) {
    assert.equal(scopeOf(key), "assistant", `${key} belongs to one assistant`);
  }
});

test("Assistant #1's served settings payload is exactly the one it always had", async (t) => {
  const { assistant, assistantFile, dir } = await panel(t);
  const before = sha(await readFile(assistantFile));
  const state = assistant.state();
  // The same object, the same keys, the same values: nothing moved into a per-pane record beside it.
  assert.equal(state.settings, assistant.settings, "the payload IS the live settings object, not a copy of half of it");
  assert.deepEqual(Object.keys(state.settings).sort(), FIRST_SETTINGS_KEYS, "every key it has always carried is still there");
  assert.deepEqual(state.settings, DEFAULTS, "and a panel that has chosen nothing serves the defaults");
  // What the page needs for the split arrives BESIDE it, so the payload above is untouched.
  assert.deepEqual(state.settingScope, SETTINGS_SCOPE, "the ownership table the panes are drawn from");
  assert.deepEqual(state.escalateTo, { [PRIMARY_ASSISTANT]: [] }, "and #1's escalation list, empty");
  assert.ok(!("assistantSettings" in state), "no per-assistant map on a single-assistant panel");
  // Reading is not writing: the store and #1's own directory are untouched.
  assert.equal(sha(await readFile(assistantFile)), before, "assistant.json is byte-identical");
  await assert.rejects(() => stat(path.join(dir, "assistants", PRIMARY_ASSISTANT, "settings.json")), "and #1 has no profile file yet");
});

test("a served payload that a reader has changed still carries every key", async (t) => {
  const { dir } = await panel(t);
  const assistantFile = path.join(dir, "assistant.json");
  // A live panel's file: two knobs chosen, nothing else.
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: { autonomy: "auto", quietSeconds: 120 }, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const live = new Assistant({
    config: { jobsFile: path.join(path.dirname(assistantFile), "jobs.json"), assistantFile },
    jobs: { list: () => [], firstOfThread: () => null, create: async () => ({}) },
    getProjects: () => [],
    onLog: () => {},
  });
  const state = live.state();
  assert.deepEqual(Object.keys(state.settings).sort(), FIRST_SETTINGS_KEYS, "the key set does not change with the values");
  assert.equal(state.settings.autonomy, "auto");
  assert.equal(state.settings.quietSeconds, 120);
  assert.equal(state.settings.maxWakesPerHour, 6, "an unchosen knob is still the default it always was");
});

test("an assistant edits only its own file — #1's store is byte-identical afterwards", async (t) => {
  const { assistant, assistantFile, profileFile } = await panel(t);
  const before = sha(await readFile(assistantFile));
  const id = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  // Both halves of the split move for #2: the assistant-scope knobs AND a wake budget it owns.
  assistant.setSettingsFor(id, { autonomy: "auto", model: "some/small-model", maxWakesPerHour: 3, quietSeconds: 90, childQuietSeconds: 120 });
  const own = assistant.settingsFor(id);
  assert.equal(own.autonomy, "auto");
  assert.equal(own.maxWakesPerHour, 3);
  assert.equal(own.quietSeconds, 90);
  assert.equal(own.childQuietSeconds, 120);
  // #1 did not move: not its object, not its file.
  assert.equal(assistant.settings.autonomy, "draft");
  assert.equal(assistant.settings.maxWakesPerHour, 6);
  assert.equal(assistant.settings.quietSeconds, 240);
  assert.equal(assistant.settings.childQuietSeconds, 300);
  assert.equal(sha(await readFile(assistantFile)), before, "Assistant #1's store is byte-identical");
  const stored = JSON.parse(await readFile(profileFile(id), "utf8"));
  assert.equal(stored.settings.maxWakesPerHour, 3, "the wake budget went to #2's own file");
  assert.equal(stored.settings.quietSeconds, 90);
  // The panel-wide keys are still ONE value for the panel: the sentry reads #1's `settings` for every one of them, so
  // the split moved the CONTROLS, not the wake path. #2's map is resolved from its own file and no more.
  assert.equal(assistant.state().health.everySeconds, DEFAULTS.seconds, "the pass clock is still #1's");
});

test("the escalation list is stored in order, inert, and never written until it is used", async (t) => {
  const { assistant, assistantFile, profileFile, dir } = await panel(t);
  const before = sha(await readFile(assistantFile));
  const second = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  const third = assistant.createAssistant({ roleId: "agent-manager", name: "Triage" }).created.id;
  // Ordered, and the order is the reader's — not sorted, not deduped into a set.
  assistant.saveProfile(second, { escalateTo: [third, PRIMARY_ASSISTANT] });
  assert.deepEqual(JSON.parse(await readFile(profileFile(second), "utf8")).escalateTo, [third, PRIMARY_ASSISTANT]);
  assert.deepEqual(assistant.state().escalateTo[second], [third, PRIMARY_ASSISTANT], "and the page is told the order");
  // A move is a list too: reversing it is one write of the whole list.
  assistant.saveProfile(second, { escalateTo: [PRIMARY_ASSISTANT, third] });
  assert.deepEqual(assistant.state().escalateTo[second], [PRIMARY_ASSISTANT, third]);
  // INERT. It is not a settings knob, so nothing that reads `settingsFor` can act on it...
  assert.ok(!("escalateTo" in assistant.settingsFor(second)), "the list is not a knob");
  assert.equal(assistant.settingsFor(second).escalateTo, undefined);
  // ...and a turn is TOLD nothing different with a list than without one, ...
  assistant.saveProfile(second, { escalateTo: [] });
  const without = assistant.preamble(second);
  assistant.saveProfile(second, { escalateTo: [third, PRIMARY_ASSISTANT] });
  assert.equal(assistant.preamble(second), without, "a list changes nothing the turn is told");
  // ...and it changes no wake: the panel's own budget and settings are the same object they were.
  assert.equal(assistant.settings.maxWakesPerHour, 6);
  assert.equal(sha(await readFile(assistantFile)), before, "Assistant #1's store is byte-identical");
  // #1 has never used the field, so its file still does not exist.
  await assert.rejects(() => stat(path.join(dir, "assistants", PRIMARY_ASSISTANT, "settings.json")));
  // Clearing it removes the key from the file rather than leaving an empty array behind.
  assistant.saveProfile(second, { escalateTo: [] });
  assert.ok(!("escalateTo" in JSON.parse(await readFile(profileFile(second), "utf8"))), "an empty list is the absence of the key");
  assert.deepEqual(assistant.state().escalateTo[second], []);
});

test("the list drops its own assistant, a stranger and a duplicate", async (t) => {
  const { assistant, profileFile } = await panel(t);
  const second = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  assistant.saveProfile(second, { escalateTo: [second, "assistant-99", "not-an-assistant", "assistant-1", "assistant-1"] });
  assert.deepEqual(JSON.parse(await readFile(profileFile(second), "utf8")).escalateTo, ["assistant-1"]);
  // The picker's own contract, so the pane and the route agree on what a list is.
  assert.deepEqual(pickEscalation(["assistant-2", "assistant-2", "ghost"], "assistant-1"), ["assistant-2"]);
  assert.deepEqual(pickEscalation("assistant-3, assistant-2"), ["assistant-3", "assistant-2"]);
  assert.deepEqual(pickEscalation(null), []);
  assert.equal(pickEscalation(Array.from({ length: 20 }, (_, i) => `assistant-${i + 2}`)).length, ESCALATION_MAX, "capped");
  assert.deepEqual(EMPTY_PROFILE.escalateTo, [], "an assistant with no file has nobody to hand to");
});
