// The standing-rule cap: 40 rules, and the one that makes room is the OLDEST the ASSISTANT wrote.
//
// The bug this file is the contract against was a comment and a guard disagreeing. The comment above the guard
// said the list was "capped at 40 with the oldest trimmed by addRule"; the guard refused the line outright at 40,
// and `addRule` itself trimmed by position (`slice(-40)`), which drops the oldest rule whoever wrote it — so the
// one path that could have trimmed dropped a READER's rule. A model that restates itself once per turn could
// therefore fill the list and then be unable to add anything, and any trim it did get took the reader's answers
// with it.
//
// What is asserted here:
//
//   · at 40 rules a RULE line lands: the list stays at 40, the oldest ASSISTANT rule is the one gone, and the
//     reader's dash rule is untouched — position, id and text.
//   · a list full of the READER's rules refuses the line BY NAME (`rule-skipped`), settles the turn's ledger
//     `refused`, and loses nothing: there is nothing of the assistant's own to trade.
//   · the reader's own add obeys the same rule: it takes the oldest assistant rule, never a reader's, and a list
//     of nothing but the reader's rules refuses with `rule-full` rather than silently dropping one.
//   · the trim is one implementation (`withRuleAdded`), used by the harvest's writer, #1's store and an extra
//     assistant's record alike.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { newAudit } from "../lib/assistant/audit.js";
import { parseActions } from "../lib/assistant/actions.js";
import { RULE_MAX, addRuleTo, withRuleAdded } from "../lib/assistants.js";

const iso = (ms = 0) => new Date(1_700_000_000_000 + ms).toISOString();
const DASH = "— deploy to QA, never PROD, from a worktree agent";
const reader = (i, text) => ({ id: `reader-${i}`, text: text || `reader rule ${i}`, by: "reader", at: iso(i) });
const assistantRule = (i, text) => ({ id: `assistant-${i}`, text: text || `assistant rule ${i}`, by: "assistant", at: iso(i) });

// 40 rules with the OLDEST one the assistant's and the reader's dash rule second — the shape that tells a trim by
// author apart from a trim by position (position would take the assistant rule too, so the dash rule is what the
// "never a reader's" half is measured against, at a fixed index the whole test reads).
function fullList({ assistantAt = [0], dash = true } = {}) {
  const list = [];
  for (let i = 0; i < RULE_MAX; i += 1) {
    if (dash && i === 1) list.push(reader(i, DASH));
    else if (assistantAt.includes(i)) list.push(assistantRule(i));
    else list.push(reader(i));
  }
  return list;
}

async function panel(t, { rules = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-rule-cap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules, watches: [], alerts: [], journal: [] }));
  const rows = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile,
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: {
      list: () => rows,
      get: (id) => rows.find((j) => j.id === id) || null,
      firstOfThread: (thread) => rows.find((j) => j.thread === thread) || null,
      create: async (body) => {
        const job = { id: `job-${rows.length + 1}`, ...body };
        rows.push(job);
        return job;
      },
    },
    getProjects: () => [],
    onLog: () => {},
  });
  const stored = async () => JSON.parse(await readFile(assistantFile, "utf8"));
  const turn = { id: "turn-1", thread: ASSISTANT_THREAD, lines: [] };
  return { assistant, dir, assistantFile, stored, turn };
}

const ruleAudit = (line) => newAudit({ id: "turn-1", thread: ASSISTANT_THREAD }, [{ index: 0, kind: "rule", line, parsed: true }]);

test("the 41st rule trims the oldest ASSISTANT rule and lands; the reader's dash rule stays", async (t) => {
  const { assistant, stored, turn } = await panel(t, { rules: fullList() });
  assert.equal(assistant.rules.length, RULE_MAX, "the panel starts at the cap");

  const line = "RULE: a landing branch is cut from main, not from the lane it lands";
  const audit = ruleAudit(line);
  await assistant.applyActions(turn, parseActions(line), audit);

  assert.equal(assistant.rules.length, RULE_MAX, "the list is still exactly at the cap, not over it");
  const texts = assistant.rules.map((r) => r.text);
  assert.ok(!texts.includes("assistant rule 0"), "the OLDEST assistant rule is the one that made room");
  assert.equal(texts.filter((x) => x === "assistant rule 0").length, 0);
  assert.equal(assistant.rules.at(-1).text, "a landing branch is cut from main, not from the lane it lands", "the new rule landed, newest last");
  assert.equal(assistant.rules.at(-1).by, "assistant");

  // The reader's dash rule: same rule, same id, and it moved up only because the rule AHEAD of it was the one
  // trimmed. A trim by position would have taken it at index 0 when the assistant's oldest rule was not first; a
  // trim that ignored authorship would take it here.
  const dash = assistant.rules.find((r) => r.text === DASH);
  assert.ok(dash, "the reader's dash rule is still there");
  assert.equal(dash.id, "reader-1");
  assert.equal(dash.by, "reader");
  assert.equal(assistant.rules.indexOf(dash), 0, "only the rule ahead of it was trimmed; it did not move down or vanish");

  assert.equal(assistant.rules.filter((r) => r.by === "reader").length, RULE_MAX - 1, "no reader rule was lost to the trim");
  assert.equal(audit.lines[0].outcome, "applied", "the RULE line is settled applied on the turn's ledger");
  assert.ok(
    assistant.journal.some((j) => j.kind === "rule" && /trimmed the oldest assistant rule: assistant rule 0/.test(j.text || "")),
    "the journal names the rule that was trimmed",
  );
  // And it is on disk, not only in memory: a restart must not resurrect the trimmed rule. `persist` is debounced,
  // so the test flushes with the panel's own writer rather than sleeping past the timer.
  assistant.writeNow();
  const saved = await stored();
  assert.ok(!saved.rules.some((r) => r.text === "assistant rule 0"));
  assert.ok(saved.rules.some((r) => r.text === DASH));
});

test("a list full of the reader's own rules refuses the line by name and loses nothing", async (t) => {
  const rules = Array.from({ length: RULE_MAX }, (_, i) => reader(i, i === 1 ? DASH : undefined));
  const { assistant, turn } = await panel(t, { rules });
  const before = assistant.rules.map((r) => `${r.id}:${r.text}`);

  const line = "RULE: the panel restarts only after the turn ends";
  const audit = ruleAudit(line);
  await assistant.applyActions(turn, parseActions(line), audit);

  assert.deepEqual(assistant.rules.map((r) => `${r.id}:${r.text}`), before, "not one of the reader's rules moved");
  assert.equal(assistant.rules.length, RULE_MAX);
  assert.equal(audit.lines[0].outcome, "refused", "the line is settled refused, not left pending");
  assert.ok(
    assistant.journal.some((j) => j.kind === "rule-skipped" && /none the assistant wrote/.test(j.text || "")),
    "and the journal says why: there is nothing of the assistant's own to trim",
  );
});

test("the reader's own add takes the oldest assistant rule too, and never a reader's", async (t) => {
  // An assistant rule buried in the middle: position 0 is the reader's, so a trim by position would be caught here.
  const { assistant } = await panel(t, { rules: fullList({ assistantAt: [17, 30] }) });
  assistant.addRule("the reader's newest answer", "reader");
  assert.equal(assistant.rules.length, RULE_MAX);
  assert.ok(!assistant.rules.some((r) => r.text === "assistant rule 17"), "the oldest assistant rule made room");
  assert.ok(assistant.rules.some((r) => r.text === "assistant rule 30"), "the newer assistant rule was left alone");
  assert.ok(assistant.rules.some((r) => r.text === DASH), "the reader's dash rule survives a reader's add as well");
  assert.equal(assistant.rules[0].by, "reader", "and nothing at the head of the list was taken by position");

  // Nothing but the reader's rules: the add is refused by code, so the POST route answers 400 with the reason
  // instead of quietly dropping the oldest rule the reader wrote.
  const { assistant: full } = await panel(t, { rules: Array.from({ length: RULE_MAX }, (_, i) => reader(i)) });
  assert.throws(
    () => full.addRule("one more", "reader"),
    (err) => err.code === "rule-full" && /every one of them is the reader's/.test(err.message),
  );
  assert.equal(full.rules.length, RULE_MAX);
});

test("withRuleAdded is the one cap: it trims the first assistant rule, and refuses only when there is none", () => {
  const rules = fullList({ assistantAt: [3] });
  const added = withRuleAdded(rules, { id: "new", text: "new", by: "assistant" });
  assert.equal(added.refused, false);
  assert.equal(added.rules.length, RULE_MAX);
  assert.equal(added.trimmed.id, "assistant-3");
  assert.equal(added.rules.at(-1).id, "new");

  const allReader = Array.from({ length: RULE_MAX }, (_, i) => reader(i));
  const refused = withRuleAdded(allReader, { id: "new", text: "new", by: "assistant" });
  assert.equal(refused.refused, true);
  assert.equal(refused.trimmed, null);
  assert.deepEqual(refused.rules, allReader, "a refusal returns the list it was given, untouched");

  // Under the cap nothing is trimmed and nothing is refused.
  const short = withRuleAdded([reader(0)], { id: "new", text: "new", by: "assistant" });
  assert.equal(short.rules.length, 2);
  assert.equal(short.trimmed, null);

  // An extra assistant's record obeys the same rule rather than its own slice(-40).
  const record = { rules: fullList({ assistantAt: [0] }) };
  addRuleTo(record, "a rule for #2", { by: "assistant" });
  assert.equal(record.rules.length, RULE_MAX);
  assert.ok(!record.rules.some((r) => r.text === "assistant rule 0"));
  assert.ok(record.rules.some((r) => r.text === DASH));
  assert.throws(
    () => addRuleTo({ rules: Array.from({ length: RULE_MAX }, (_, i) => reader(i)) }, "x", { by: "assistant" }),
    (err) => err.code === "rule-full",
  );
});
