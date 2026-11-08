// Consolidation: the assistant tidies its own list under the reader's grant.
//
// The design this implements (docs/design/prompt-tiers-2026-11-08.md §5) used to leave the tidy-up to a
// reader-pressed pass. This file is the contract for the correction: the reader GRANTS, the assistant runs the
// pass, and the pass writes a snapshot before it writes anything.
//
//   1. THE FOUR DOORS, EACH WITH ITS UNSAFE CASE REFUSED BY NAME:
//        merge        two rules become one, provenance kept; a pinned source without `safety: true` is refused.
//        delete       an assistant's own unpinned rule goes; a reader's rule and a pinned rule are refused.
//        charter      a rule's text moves to the long tier, dated; a pinned rule is refused, a full charter is
//                     refused rather than truncated.
//        prompt       the tier-1 seat is set; over 1,472 characters, empty, or over a prompt the READER wrote is
//                     refused.
//   2. THE GRANT IS THE ONLY DOOR. No pass writes a rule, a charter or a prompt without
//      `consolidate: { by: "reader" }` on the assistant's record, and a plan posted around it is refused.
//   3. THE SNAPSHOT COMES FIRST, and survives the pass: the file holds the BEFORE list, charter and prompt, and a
//      second Assistant built over the same directory reads the rewritten rule with its `rewrittenFrom` ids.
//
// The unit half drives the module directly (no store); the pass half drives a real Assistant over a temp state
// directory, which is the same instance the server builds.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { CHARTER_HEADING } from "../lib/charter.js";
import {
  ROLE_PROMPT_MAX,
  deleteRule,
  mergeRules,
  moveRuleToCharter,
  rewriteRule,
  setRolePrompt,
} from "../lib/assistant/consolidate.js";

const fails = (fn, code) =>
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `refused with ${code}, got ${err.code || "(no code)"}: ${err.message}`);
    return true;
  });

const iso = (minute) => new Date(Date.parse("2026-11-08T12:00:00Z") + minute * 60_000).toISOString();

const rule = (id, text, by = "assistant", extra = {}) => ({ id, text, at: iso(0), by, ...extra });

// A list with one reader rule and two assistant rules: enough for a merge, a drop and a pin without overlaps.
const LIST = () => [
  rule("r-reader", "never deploy to PROD without the reader naming the environment", "reader"),
  rule("r-one", "a quiet test run is not evidence"),
  rule("r-two", "match the test child's start time to its launch before calling a run quiet"),
  rule("r-pin", "never push the turnover branch that carries the JWT private key", "assistant", { safety: true }),
];

async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-consolidate-"));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(
    assistantFile,
    JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }),
  );
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  t.after(async () => {
    if (assistant.persistTimer) clearTimeout(assistant.persistTimer);
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(dir, { recursive: true, force: true });
  });
  const second = assistant.createAssistant({ name: "Assistant #2" }).created;
  return { dir, assistant, second, charterFile: assistant.charterPathOf(second) };
}

test("merge makes one rule out of several and keeps rewrittenFrom", () => {
  const out = mergeRules({
    rules: LIST(),
    from: ["r-one", "r-two"],
    text: "a quiet test run is not evidence: match the test child's start time to its launch",
    granted: true,
    at: iso(5),
  });
  assert.equal(out.rules.length, 3, "two rules became one");
  const merged = out.rules.find((r) => r.id === "r-one");
  assert.ok(merged, "the merged rule keeps the earliest source's id");
  assert.equal(merged.by, "assistant", "two assistant rules stay the assistant's");
  assert.equal(merged.rewritten, true);
  assert.deepEqual(merged.rewrittenFrom, ["r-one", "r-two"]);
  assert.equal(merged.rewrittenAt, iso(5));
  assert.ok(out.rules.some((r) => r.id === "r-reader"), "the reader's rule is untouched");
  assert.ok(!out.rules.some((r) => r.id === "r-two"), "the absorbed source is gone");
});

test("merge refuses to demote a safety pin", () => {
  fails(
    () => mergeRules({ rules: LIST(), from: ["r-pin", "r-one"], text: "never push a turnover branch", granted: true }),
    "consolidate-safety-lost",
  );
  // The same merge, marked safety, is allowed and the pin survives.
  const out = mergeRules({ rules: LIST(), from: ["r-pin", "r-one"], text: "never push a turnover branch", safety: true, granted: true });
  assert.equal(out.rule.safety, true);
  assert.equal(out.rule.rewritten, true);
});

test("merge refuses one source and an unknown id", () => {
  fails(() => mergeRules({ rules: LIST(), from: ["r-one"], text: "x", granted: true }), "consolidate-merge");
  fails(() => mergeRules({ rules: LIST(), from: ["r-one", "nope"], text: "x", granted: true }), "consolidate-unknown-rule");
});

test("a rewrite is the one-source merge, with the same pin refusal", () => {
  const out = rewriteRule({ rules: LIST(), id: "r-two", text: "match the child start time to the launch", granted: true });
  const rewritten = out.rules.find((r) => r.id === "r-two");
  assert.equal(rewritten.rewritten, true);
  assert.deepEqual(rewritten.rewrittenFrom, ["r-two"]);
  fails(() => rewriteRule({ rules: LIST(), id: "r-pin", text: "never push a turnover branch", granted: true }), "consolidate-safety-lost");
});

test("delete drops an assistant rule and refuses the reader's and the pinned one", () => {
  const out = deleteRule({ rules: LIST(), id: "r-two", granted: true });
  assert.deepEqual(out.rules.map((r) => r.id), ["r-reader", "r-one", "r-pin"]);
  fails(() => deleteRule({ rules: LIST(), id: "r-reader", granted: true }), "consolidate-reader");
  fails(() => deleteRule({ rules: LIST(), id: "r-pin", granted: true }), "consolidate-pinned");
});

test("move to charter writes the text into the long tier and refuses the pinned case", () => {
  const out = moveRuleToCharter({ rules: LIST(), id: "r-two", charter: "# Charter\n", because: "one repository's history", granted: true, at: iso(9) });
  assert.ok(out.charter.includes("match the test child's start time"), "the moved text is in the charter");
  assert.ok(out.charter.includes("2026-11-08"), "the entry is dated");
  assert.ok(out.charter.includes("r-two"), "the entry names the rule it came from");
  assert.ok(!out.rules.some((r) => r.id === "r-two"), "and it left the every-turn list");
  fails(() => moveRuleToCharter({ rules: LIST(), id: "r-pin", charter: "# Charter\n", granted: true }), "consolidate-pinned");
});

test("move to charter refuses a charter with no room rather than truncating it", () => {
  // The prose ABOVE the changelog is already over the cap, so pruning every dated entry still leaves the file too
  // long: the writer refuses rather than dropping the reader's own words.
  const fullCharter = `# Charter\n${"p".repeat(19_990)}\n${CHARTER_HEADING}\n- one entry\n`;
  fails(
    () => moveRuleToCharter({ rules: LIST(), id: "r-two", charter: fullCharter, granted: true }),
    "charter-full",
  );
});

test("setting the role prompt refuses over the seat, empty, and a reader's prompt", () => {
  const out = setRolePrompt({ prompt: "", promptBy: null, text: "Read the queue first.", from: ["r-one"], granted: true, at: iso(3) });
  assert.equal(out.prompt, "Read the queue first.");
  assert.equal(out.promptBy, "assistant");
  assert.deepEqual(out.promptFrom, ["r-one"]);
  fails(() => setRolePrompt({ prompt: "", text: "x".repeat(ROLE_PROMPT_MAX + 1), granted: true }), "consolidate-prompt-long");
  fails(() => setRolePrompt({ prompt: "", text: "   ", granted: true }), "consolidate-prompt-empty");
  fails(
    () => setRolePrompt({ prompt: "the reader's contract", promptBy: "reader", text: "a shorter one", granted: true }),
    "consolidate-prompt-reader",
  );
  // An assistant's own earlier prompt may be replaced: the seat is its own to keep current.
  assert.equal(
    setRolePrompt({ prompt: "an older assistant prompt", promptBy: "assistant", text: "the new one", granted: true }).prompt,
    "the new one",
  );
});

test("no grant means no write, for every door", () => {
  fails(() => mergeRules({ rules: LIST(), from: ["r-one", "r-two"], text: "x", granted: false }), "consolidate-not-granted");
  fails(() => rewriteRule({ rules: LIST(), id: "r-one", text: "x", granted: false }), "consolidate-not-granted");
  fails(() => deleteRule({ rules: LIST(), id: "r-two", granted: false }), "consolidate-not-granted");
  fails(() => moveRuleToCharter({ rules: LIST(), id: "r-two", charter: "", granted: false }), "consolidate-not-granted");
  fails(() => setRolePrompt({ prompt: "", text: "x", granted: false }), "consolidate-not-granted");
});

test("a dry run reports and writes nothing; a granted pass writes the snapshot first and keeps provenance", async (t) => {
  const { dir, assistant, second, charterFile } = await panel(t);
  for (const text of [
    "a quiet test run is not evidence",
    "match the test child's start time to its launch before calling a run quiet",
    "the queue is read before the board on every wake",
  ]) {
    assistant.addRuleFor(second.id, text, "assistant");
  }
  assistant.addRuleFor(second.id, "never deploy to PROD without the reader naming the environment", "reader");
  const rec = assistant.assistantRecord(second.id);
  const [quiet, match, queue] = rec.rules.filter((r) => r.by === "assistant");
  const reader = rec.rules.find((r) => r.by === "reader");
  rec.rules.find((r) => r.id === match.id).safety = true; // a pinned boundary, for the prompt refusal below
  const before = rec.rules.map((r) => ({ ...r }));

  const plan = {
    ops: [
      { op: "keep", id: reader.id },
      { op: "merge", from: [quiet.id, match.id], text: "a quiet test run is not evidence: match the test child's start time to its launch", safety: true },
      { op: "drop", id: queue.id, because: "covered by the merged rule" },
    ],
  };

  // No grant yet: refused, and nothing on disk moved.
  fails(() => assistant.consolidateRulesFor(second.id, { plan }), "consolidate-not-granted");
  assert.deepEqual(rec.rules.map((r) => r.id), before.map((r) => r.id), "the refused pass wrote nothing");

  assistant.setConsolidationGrant(second.id, true);
  const dry = assistant.consolidateRulesFor(second.id, { plan, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.snapshot, null, "a dry run takes no snapshot");
  assert.equal(dry.counts.merged, 1);
  assert.equal(dry.counts.dropped, 1);
  assert.equal(dry.after.rules, 2);
  assert.deepEqual(rec.rules.map((r) => r.id), before.map((r) => r.id), "the dry run wrote nothing");

  // The real pass.
  const out = assistant.consolidateRulesFor(second.id, { plan });
  assert.equal(out.dryRun, false);
  assert.ok(existsSync(out.snapshot), "the snapshot file exists");
  const snap = JSON.parse(readFileSync(out.snapshot, "utf8"));
  assert.deepEqual(snap.before.rules.map((r) => r.id), before.map((r) => r.id), "the snapshot holds the BEFORE list");
  assert.equal(snap.assistantId, second.id);
  assert.equal(snap.plan.ops.length, 3, "and the plan that produced the pass");

  assert.equal(rec.rules.length, 2, "the pass wrote the list once");
  const merged = rec.rules.find((r) => r.id === quiet.id);
  assert.ok(merged, "the merged rule keeps the earliest source's id");
  assert.equal(merged.rewritten, true);
  assert.deepEqual(merged.rewrittenFrom, [quiet.id, match.id]);
  assert.equal(merged.safety, true);
  assert.ok(!rec.rules.some((r) => r.id === queue.id), "the dropped rule is gone");
  assert.ok(rec.rules.some((r) => r.id === reader.id), "the reader's rule survived");

  const charter = readFileSync(charterFile, "utf8");
  assert.ok(charter.includes("rule consolidation: kept 1"), "the charter carries the pass's counts");
  assert.ok(charter.includes(String(out.snapshot).replace(/\\/g, "/")), "and names the snapshot that makes it reversible");

  // A fresh Assistant over the same directory reads the rule back with its provenance: the record keeps it.
  const again = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile: path.join(dir, "assistant.json") },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => body },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  const reloaded = again.assistantRecord(second.id).rules.find((r) => r.id === quiet.id);
  assert.equal(reloaded.rewritten, true, "rewritten survives a reload");
  assert.deepEqual(reloaded.rewrittenFrom, [quiet.id, match.id], "and so does rewrittenFrom");
  assert.equal(again.consolidationGrantFor(second.id).granted, true, "the grant survives a reload");
});

test("a pass moves a rule into the charter and fills the role prompt, and refuses to absorb a pinned rule", async (t) => {
  const { assistant, second, charterFile } = await panel(t);
  for (const text of [
    "read the queue before the board",
    "answer a worker only from something written down",
    "a repository's landing pattern is not a standing rule",
    "never push the turnover branch that carries the JWT private key",
  ]) {
    assistant.addRuleFor(second.id, text, "assistant");
  }
  const rec = assistant.assistantRecord(second.id);
  const [read, answer, repo, pin] = rec.rules;
  rec.rules.find((r) => r.id === pin.id).safety = true;
  assistant.setConsolidationGrant(second.id, true);

  const plan = {
    ops: [
      { op: "prompt", text: "Read the queue before the board. Answer a worker only from something written down.", from: [read.id, answer.id] },
      { op: "charter", id: repo.id, because: "one repository's history" },
      { op: "keep", id: pin.id },
    ],
  };
  // The pinned rule cannot be absorbed: it must stay a rule with its own pin.
  fails(
    () =>
      assistant.consolidateRulesFor(second.id, {
        plan: { ops: [{ op: "prompt", text: "Read the queue first.", from: [pin.id] }] },
      }),
    "consolidate-pinned",
  );

  const out = assistant.consolidateRulesFor(second.id, { plan });
  assert.equal(out.counts.prompted, 1);
  assert.equal(out.counts.chartered, 1);
  assert.equal(out.after.rules, 1, "only the pinned rule is left riding its own seat");
  assert.equal(rec.rules[0].id, pin.id);

  const profile = assistant.profileOf(second.id);
  assert.equal(profile.promptBy, "assistant");
  assert.deepEqual(profile.promptFrom, [read.id, answer.id]);
  assert.ok(profile.prompt.startsWith("Read the queue before the board"));
  assert.ok(assistant.systemBriefing(second.id).includes("Read the queue before the board"), "the narrowed contract rides every turn");

  const charter = readFileSync(charterFile, "utf8");
  assert.ok(charter.includes("a repository's landing pattern"), "the moved rule's text is in the charter");
  assert.ok(charter.includes("moved to the charter: a repository's landing pattern"), "as a move, not a rewrite");
});

test("a plan that skips a rule is refused with the ids", async (t) => {
  const { assistant, second } = await panel(t);
  assistant.addRuleFor(second.id, "one", "assistant");
  assistant.addRuleFor(second.id, "two", "assistant");
  assistant.setConsolidationGrant(second.id, true);
  const [one, two] = assistant.assistantRecord(second.id).rules;
  assert.throws(
    () => assistant.consolidateRulesFor(second.id, { plan: { ops: [{ op: "keep", id: one.id }] } }),
    (err) => {
      assert.equal(err.code, "consolidate-plan");
      assert.ok(err.message.includes(two.id), "the refusal names the unaccounted id");
      return true;
    },
  );
});

test("the action grammar offers the pass only when the reader granted it", async (t) => {
  const { assistant, second } = await panel(t);
  assert.ok(!assistant.systemBriefing(second.id).includes("Consolidation is GRANTED"), "nothing is offered before the grant");
  assistant.setConsolidationGrant(second.id, true);
  const brief = assistant.systemBriefing(second.id);
  assert.ok(brief.includes(`Consolidation is GRANTED for you (${second.id})`), "the granted turn is told it may run a pass");
  assert.ok(brief.includes("/api/assistant/consolidate"), "and which route takes the plan");
});

test("the reader can take the grant back, and then no pass writes", async (t) => {
  const { assistant, second } = await panel(t);
  assistant.addRuleFor(second.id, "one", "assistant");
  assistant.addRuleFor(second.id, "two", "assistant");
  assistant.setConsolidationGrant(second.id, true);
  assert.equal(assistant.consolidationGrantFor(second.id).granted, true);
  assistant.setConsolidationGrant(second.id, false);
  assert.equal(assistant.consolidationGrantFor(second.id).granted, false, "the grant is gone");
  const [one, two] = assistant.assistantRecord(second.id).rules;
  fails(
    () => assistant.consolidateRulesFor(second.id, { plan: { ops: [{ op: "keep", id: one.id }, { op: "drop", id: two.id }] } }),
    "consolidate-not-granted",
  );
});
