// Exercises the header's aggressive-mode toggle against the real Assistant class and a real assistant.json:
// what the profile writes, what the record remembers (including keys that were ABSENT), what a switch-off
// restores, what the two no-ops say, and whether a "panel restart" (a second Assistant on the same file) can
// still switch the mode off correctly.
//
//   node tools/verify-aggressive.mjs
//
// The point is the memory, not the UI: the record has to hold, for every key the profile writes, whether the
// key existed before and exactly what it was — and an absent key has to come back absent, not frozen at
// whatever its default happened to be on the day the button was pressed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Assistant } from "../lib/assistant.js";
import { AGGRESSIVE, AGGRESSIVE_KEYS, AGGRESSIVE_RULE_IDS, AGGRESSIVE_RULE_LEVEL, DEFAULTS } from "../lib/assistant/config.js";

const dir = mkdtempSync(path.join(tmpdir(), "aggressive-test-"));
const file = path.join(dir, "assistant.json");
let failures = 0;
const ok = (cond, what, extra = "") => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    failures += 1;
    console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ""}`);
  }
};
// Key order in the written file is an implementation detail (the writer puts `rules` first); equality here is
// about the VALUES the reader gets back, so compare canonically.
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
      : v;
const eq = (a, b, what) =>
  ok(JSON.stringify(canon(a)) === JSON.stringify(canon(b)), what, `${JSON.stringify(canon(a))} !== ${JSON.stringify(canon(b))}`);

const jobs = {
  list: () => [],
  firstOfThread: () => null,
  busyFor: () => ({ held: false, where: null, thread: null, tree: null, by: [] }),
  modelFor: () => null,
  create: async () => ({ id: "fake" }),
  answerQuestion: async () => ({ ok: true }),
  stop: async () => ({ ok: true }),
};
const make = () =>
  new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: file, defaultCwd: dir },
    jobs,
    onEvent: () => {},
    onLog: () => {},
  });
const readFile = () => JSON.parse(readFileSync(file, "utf8"));

try {
  // ---- a first boot with three knobs the reader set, and one deliberately absent -----------------
  console.log("setup: a real assistant.json with a few settings the reader chose");
  let a = make();
  a.setSettings({ autonomy: "draft", seconds: 7, rules: { loop: "alert" } });
  a.writeNow();
  const boot = readFile();
  eq(boot.settings, { autonomy: "draft", seconds: 7, rules: { loop: "alert" } }, "the file carries only the knobs the reader set");
  ok(!("quietSeconds" in boot.settings), "quietSeconds is ABSENT from the file before the toggle");
  const before = { ...a.settings };

  // ---- toggle ON ----------------------------------------------------------------------------------
  console.log("\ntoggle ON: the profile, key by key");
  const on1 = a.setAggressive(true);
  eq(on1.changed, true, "the first press changes the state");
  eq(a.settings.autonomy, "auto", "autonomy → auto");
  eq(a.settings.spawn, "auto", "spawn → auto");
  eq(a.settings.enabled, true, "enabled → true (the mode cannot monitor with the sentry off)");
  eq(a.settings.maxWakesPerHour, 60, "maxWakesPerHour → 60 (top of [0,60])");
  const windows = {
    seconds: 2,
    rearmSeconds: 60,
    quietSeconds: 30,
    approvalSeconds: 15,
    contextPercent: 50,
    leftoverMinutes: 1,
    childQuietSeconds: 60,
    repeatTurns: 2,
    repeatLimit: 2,
  };
  for (const [k, v] of Object.entries(windows)) eq(a.settings[k], v, `${k} → ${v} (the earliest the validator allows)`);
  const ruleVals = AGGRESSIVE_RULE_IDS.map((id) => a.settings.rules[id]);
  ok(AGGRESSIVE_RULE_IDS.length === 13, `all 13 rules are in the profile (${AGGRESSIVE_RULE_IDS.length})`);
  ok(ruleVals.every((v) => v === AGGRESSIVE_RULE_LEVEL), `every rule is at "${AGGRESSIVE_RULE_LEVEL}" (the top rung)`);
  ok(AGGRESSIVE_KEYS.every((k) => a.settingsExplicit.settings.has(k)), "every profile knob is now carried by the file");
  const rec = a.aggressive.saved;
  eq(rec.settings.autonomy, { present: true, value: "draft" }, "autonomy was present and is recorded with its value");
  eq(rec.settings.seconds, { present: true, value: 7 }, "seconds was present and is recorded with its value");
  eq(rec.settings.quietSeconds, { present: false }, "quietSeconds was ABSENT and is recorded as absent");
  eq(rec.rules.loop, { present: true, value: "alert" }, "rules.loop was present and is recorded with its value");
  eq(rec.rules.errorloop, { present: false }, "rules.errorloop was ABSENT and is recorded as absent");
  eq(a.state().aggressive.on, true, "state() reports the mode on");
  ok(a.preamble().includes("Aggressive mode is ON"), "the assistant's own briefing carries the mode");
  a.writeNow();
  const onFile = readFile();
  eq(onFile.aggressive.on, true, "the record is on disk while the mode is on");
  eq(onFile.aggressive.saved.settings.quietSeconds, { present: false }, "the absent key is absent in the record on disk");

  // ---- toggle ON twice ----------------------------------------------------------------------------
  console.log("\ntoggle ON twice: the record must not be re-taken");
  const savedBefore = JSON.stringify(a.aggressive.saved);
  const on2 = a.setAggressive(true);
  eq(on2.changed, false, "the second press changes nothing");
  ok(String(on2.reason || "").includes("already on"), "it says the mode is already on", on2.reason);
  eq(JSON.stringify(a.aggressive.saved), savedBefore, "the record is byte-for-byte unchanged (the aggressive values were not captured as the reader's own)");

  // ---- toggle OFF ---------------------------------------------------------------------------------
  console.log("\ntoggle OFF: every key back to exactly what it was");
  const off1 = a.setAggressive(false);
  eq(off1.changed, true, "the switch-off changes the state");
  eq(a.settings.autonomy, "draft", "autonomy is back to draft");
  eq(a.settings.seconds, 7, "seconds is back to 7");
  eq(a.settings.rules.loop, "alert", "rules.loop is back to alert");
  eq(a.settings.quietSeconds, DEFAULTS.quietSeconds, "quietSeconds falls back to its default in memory");
  eq(a.settings.rules.errorloop, DEFAULTS.rules.errorloop, "rules.errorloop falls back to its default in memory");
  ok(!a.settingsExplicit.settings.has("quietSeconds"), "quietSeconds is no longer carried by the file (so it follows its default)");
  ok(!a.settingsExplicit.rules.has("errorloop"), "rules.errorloop is no longer carried by the file");
  a.writeNow();
  const offFile = readFile();
  eq(offFile.settings, { autonomy: "draft", seconds: 7, rules: { loop: "alert" } }, "the file is back to exactly the three knobs it had");
  ok(!("quietSeconds" in offFile.settings), "quietSeconds is ABSENT again in the file (proved, not assumed)");
  ok(!("errorloop" in offFile.settings.rules), "rules.errorloop is ABSENT again in the file");
  eq(offFile.aggressive, { on: false }, "the record is emptied once the mode is off");

  // ---- toggle OFF when it was never on ------------------------------------------------------------
  console.log("\ntoggle OFF when it was never on: a no-op that says so");
  const off2 = a.setAggressive(false);
  eq(off2.changed, false, "it changes nothing");
  ok(String(off2.reason || "").includes("not on"), "it says the mode is not on", off2.reason);

  // ---- toggle ON, "restart", toggle OFF -----------------------------------------------------------
  console.log("\ntoggle ON, panel restart, toggle OFF: the record survives in the store");
  a.setAggressive(true);
  a.writeNow();
  const recOn = JSON.stringify(readFile().aggressive.saved);
  const b = make(); // a new process reading the same assistant.json
  eq(b.aggressive.on, true, "the restarted assistant comes back in aggressive mode");
  eq(b.settings.maxWakesPerHour, 60, "the restarted settings are the aggressive ones");
  ok(AGGRESSIVE_RULE_IDS.every((id) => b.settings.rules[id] === AGGRESSIVE_RULE_LEVEL), "every rule is still at the top rung after the restart");
  eq(JSON.stringify(b.aggressive.saved), recOn, "the record read back from disk is the one written before the restart");
  const off3 = b.setAggressive(false);
  eq(off3.changed, true, "the restarted panel can still switch the mode off");
  eq(b.settings.autonomy, "draft", "…and the reader's autonomy is back");
  eq(b.settings.seconds, 7, "…and the reader's cadence is back");
  b.writeNow();
  const backFile = readFile();
  eq(backFile.settings, { autonomy: "draft", seconds: 7, rules: { loop: "alert" } }, "…and the file matches what it held before the mode went on");
  ok(!("quietSeconds" in backFile.settings), "…including the key that was absent");

  // ---- a held knob cannot be moved while the mode is on -------------------------------------------
  console.log("\nheld knobs: setSettings refuses a write the profile holds");
  const c = make();
  c.setSettings({ seconds: 7 });
  c.setAggressive(true);
  const returned = c.setSettings({ seconds: 45, model: "kept-model" });
  eq(returned.seconds, 2, "seconds stays at the profile value");
  eq(returned.model, "kept-model", "a knob the profile does not hold still changes");
  ok(c.journal.some((j) => /refused/.test(j.text) && /seconds/.test(j.text)), "the refusal is journaled with the key named");
  c.setAggressive(false);
  eq(c.settings.seconds, 7, "the reader's own seconds came back after the refused write");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall aggressive-mode checks passed");
process.exit(failures ? 1 : 0);
