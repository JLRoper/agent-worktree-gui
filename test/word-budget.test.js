// What a brief says about length, and what the panel is allowed to add to it.
//
// The round-7 review's last item: the draft landed at 599 of the 600 words its brief allowed, and the critic's own
// acceptance note recorded "599 of its 600 words" as a constraint rather than a target. The reader's decision is that
// the BRIEF's own text governs — the critic enforces only a budget the brief states, there is no default ceiling, and
// the one number the panel owns is a high runaway guard (4,000 words) which is a guard, not a style rule.
//
// So this file pins three things:
//
//   - the parser reads the phrasings a brief actually uses ("400-600 words", "no more than 900 words", "800 words")
//     and answers NOTHING for prose that states no budget — never a guess and never a default;
//   - a stage prompt carries a BUDGET block only when the brief states one, quoting the brief's own words and the
//     guard; a brief that says nothing about length adds no line;
//   - the shipped seed's critic states the rule itself, because that seat reviews prose even when the brief is silent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readBundle } from "../lib/pipeline-bundle.js";
import { stagePrompt } from "../lib/task-pipeline-drive.js";
import { RUNAWAY_WORDS, budgetBlock, budgetLine, wordBudgetOf } from "../lib/word-budget.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = path.join(ROOT, "pipeline-bundle.seed.json");

// The brief round 7 ran on, verbatim from the dossier's stage prompt: the one that produced a 599-word draft.
const ROUND7 = [
  "BRIEF: Write one short field note, 400-600 words, for an engineer who has never used this panel, explaining how a queue",
  "task moves through a pipeline stage by stage: the tree cut, the stage run, the settle, the loop edge and its cap, and",
  "the gate.",
].join(" ");

test("a brief's stated budget is read, in the phrasings a brief uses", () => {
  assert.deepEqual(wordBudgetOf(ROUND7), { min: 400, max: 600, stated: "400-600 words" });
  assert.deepEqual(wordBudgetOf("write between 250 and 400 words about it"), { min: 250, max: 400, stated: "between 250 and 400 words" });
  assert.deepEqual(wordBudgetOf("one page, no more than 900 words"), { min: null, max: 900, stated: "no more than 900 words" });
  assert.deepEqual(wordBudgetOf("at least 250 words, please"), { min: 250, max: null, stated: "at least 250 words" });
  // "800 word note" states one number and no bound; it is quoted back in the plural a budget is written in.
  assert.deepEqual(wordBudgetOf("an 800 word note"), { min: 800, max: 800, stated: "800 words" });
  // A qualifier AFTER the number is a bound, not a target: "1,200 words maximum" has no floor.
  assert.deepEqual(wordBudgetOf("1,200 words maximum"), { min: null, max: 1200, stated: "1,200 words maximum" });

  // Prose that states NO budget answers nothing. A default here is the defect the decision exists to stop: a stage
  // told to keep to 600 words about a brief that never asked would cut real work to satisfy the panel's own guess.
  assert.equal(wordBudgetOf("write a short field note for an engineer"), null);
  assert.equal(wordBudgetOf("the loop is capped at 3 rounds"), null, "\"rounds\" is not words");
  assert.equal(wordBudgetOf(""), null);
  assert.equal(wordBudgetOf(null), null);
});

test("the BUDGET line quotes the brief and names the guard; a brief with no budget adds no line", () => {
  const line = budgetLine(ROUND7);
  assert.match(line, /the brief states 400-600 words \(400-600 words\)/);
  assert.match(line, /enforce that and only that/);
  assert.match(line, /4,000 words is the panel's runaway guard — a guard, not a style rule/);
  assert.equal(RUNAWAY_WORDS, 4000, "the guard is one number, and the page's sentence uses it");

  // With no stated budget the sentence says so — the absence is the rule — but the prompt does not carry it at all,
  // because a brief about code or a ticket has no length question and every prompt pays for what it carries.
  assert.match(budgetLine("land the queue fix"), /states no word budget/);
  assert.deepEqual(budgetBlock("land the queue fix"), []);
  assert.deepEqual(budgetBlock(""), []);
  assert.deepEqual(budgetBlock(ROUND7), ["BUDGET", line]);
});

test("a stage prompt carries the brief's budget only when the brief states one", () => {
  const source = readBundle(SEED);
  const pingPong = source.bundle.pipelines.find((entry) => entry.id === "ping-pong");
  const [draft, critique] = pingPong.stages;

  const withBudget = stagePrompt({ id: 335, title: "round 7", detail: ROUND7 }, pingPong, critique);
  assert.match(withBudget, /\nBUDGET\n {2}budget {6}the brief states 400-600 words/, "the panel quotes the brief's own range");
  assert.match(withBudget, /4,000 words is the panel's runaway guard/, "the guard is stated where the budget is");
  assert.match(withBudget, /400-600 words, for an engineer/, "and the brief itself is still there, unedited");

  const withoutBudget = stagePrompt({ id: 335, title: "land it", detail: "Land the queue fix and report the merge commit." }, pingPong, draft);
  assert.doesNotMatch(withoutBudget, /BUDGET/, "a brief with no budget gets no budget line — not a default one");
  assert.doesNotMatch(withoutBudget, /word/, "nor the word out of a sentence nobody asked for");
});

test("the shipped seed's critic is told: the brief governs, no default ceiling, 4,000 words is a guard", () => {
  const source = readBundle(SEED);
  const pingPong = source.bundle.pipelines.find((entry) => entry.id === "ping-pong");
  const critique = pingPong.stages.find((entry) => entry.id === "critique");

  // The stage's own prompt is what the seat reads, because the loader takes `stage.prompt` ahead of the role's
  // instructions — so the rule lives there, and the roster role carries the same rule for a reader who re-exports it.
  assert.match(critique.prompt, /The word budget is the brief's own text/);
  assert.match(critique.prompt, /where it states none there is no default ceiling - do not invent one/);
  assert.match(critique.prompt, /4,000 words is the panel's runaway guard rather than a style rule/);
  assert.match(critique.prompt, /past it, say the work has run away instead of cutting it to fit/);
  // The rule names no ceiling of its own: 600 was the brief's, and a seed that fell back to it would be the defect.
  assert.doesNotMatch(critique.prompt, /\b600\b/);
  assert.doesNotMatch(critique.prompt, /\bwords? (?:max|maximum|ceiling)\b/i);

  // The roster role carries the same rule, for a reader who re-exports the document and reads the roles: the loader
  // does not keep `roles` on its normalised pipeline, so this half is read from the seed's own text.
  const raw = JSON.parse(readFileSync(SEED, "utf8"));
  const document = raw.pipelines.find((entry) => entry.id === "ping-pong");
  const critic = document.roles.find((role) => role.id === "critic");
  assert.match(critic.instructions, /The brief's own text decides the word budget/);
  assert.match(critic.instructions, /never invent a ceiling/);
  assert.match(critic.instructions, /4,000 words as a runaway guard/);
});
