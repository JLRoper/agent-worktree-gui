// The prompt's own budget: what a turn is built from, how much of each section the panel reserves,
// and the three turns the Settings -> Prompt tab draws.
//
// The constants are the point of this file. Every cap the picture shows is read from the module that
// owns it - the rules' 12 seats at 200 characters each, the charter's 20,000, the notes' 1,200, the
// watches' 10 x 120, the role prompt's 8,000 - and this test fails if the picture's table and the
// builder's caps have drifted apart. The sizes are MEASURED from a real briefing built by the class a
// turn uses, so a section cannot be a number the drawing invented.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { writeQueueFile } from "../lib/assistant/queue.js";
import { CHARTER_MAX_CHARS } from "../lib/charter.js";
import { PROMPT_CAP } from "../lib/assistant/profile.js";
import { RULE_BRIEFING_CHARS, RULE_BRIEFING_MAX } from "../lib/assistant/rules.js";
import { startPanel } from "../tools/panel-testkit.mjs";
import {
  NOTES_BRIEFING_CHARS,
  PROJECTS_BRIEFING_MAX,
  PROJECT_LINE_CHARS,
  PROMPT_BUDGET,
  PROMPT_SECTION_DEFS,
  WATCHES_BRIEFING_MAX,
  WATCH_TEXT_CHARS,
  queueBudgetChars,
} from "../lib/assistant/prompt-budget.js";

const RULES = RULE_BRIEFING_MAX;
const RULE_LEN = RULE_BRIEFING_CHARS;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-prompt-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  const rules = Array.from({ length: RULES }, (_, i) => ({
    id: `r${i + 1}`,
    // Each rule is exactly the injection clip. The first is the reader's, so `briefingRules` keeps
    // it at the head of the window; the rest are the assistant's own and fill the remaining seats.
    text: (i === 0 ? "R" : "A") + String(i).padStart(2, "0") + "x".repeat(RULE_LEN - 3),
    at: new Date(Date.now() - (RULES - i) * 1000).toISOString(),
    by: i === 0 ? "reader" : "assistant",
  }));
  const watches = Array.from({ length: WATCHES_BRIEFING_MAX }, (_, i) => ({
    id: `w${i + 1}`,
    thread: `thread-${i}`,
    title: `w${i}`.padEnd(WATCH_TEXT_CHARS, "x"),
    state: "watching",
    minutes: 30,
  }));
  await writeFile(
    assistantFile,
    JSON.stringify({ version: 2, settings: {}, notes: "n".repeat(NOTES_BRIEFING_CHARS), rules, watches, alerts: [], journal: [] }),
  );
  const charterFile = path.join(dir, "assistant-charter.md");
  const head = "# the long tier\n\n";
  await writeFile(charterFile, head + "c".repeat(CHARTER_MAX_CHARS - head.length));
  const projects = Array.from({ length: PROJECTS_BRIEFING_MAX }, (_, i) => ({
    name: `project-${i}`,
    path: `fixtures/project-${i}`,
  }));
  const rows = [{ path: "fixtures/repo", name: "repo", branch: "wtgui/test", head: "abc1234", ahead: 1, behind: 0, dirty: 0, untracked: 0 }];
  // Four live runs, so the board's full digest is a real list and its one-line marker is visibly
  // smaller. The digest filters assistant threads; these are workers' threads.
  const jobs = Array.from({ length: 4 }, (_, i) => ({
    id: `job-${i + 1}`,
    thread: `wtgui/worker-${i + 1}`,
    status: "running",
    prompt: `do the thing number ${i + 1}`,
    startedAt: new Date().toISOString(),
    lines: [],
  }));
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, charterFile },
    jobs: { list: () => jobs, firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => projects,
    getRows: () => rows,
    onLog: () => {},
  });
  // Five queued rows, the default `queueDigestSize`, so the digest has exactly the rows its budget
  // counts.
  writeQueueFile(
    assistant.queuePathOf(assistant.assistantRecord()),
    Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `queued task ${i + 1}`, state: "queued" })),
    6,
  );
  return { assistant, dir };
}

const sectionOf = (turn, key) => turn.sections.find((s) => s.key === key);
const sum = (list) => list.reduce((n, s) => n + s.chars, 0);

test("every budget the picture shows is the panel's own constant", () => {
  assert.equal(PROMPT_BUDGET.prompt, PROMPT_CAP, "the role prompt's cap is PROMPT_CAP");
  assert.equal(PROMPT_BUDGET.rules, RULE_BRIEFING_MAX * RULE_BRIEFING_CHARS, "the rules are twelve seats at the injection clip");
  assert.equal(PROMPT_BUDGET.notes, NOTES_BRIEFING_CHARS, "the notes are their clip");
  assert.equal(PROMPT_BUDGET.watches, WATCHES_BRIEFING_MAX * WATCH_TEXT_CHARS, "the watches are ten rows at their clip");
  assert.equal(PROMPT_BUDGET.projects, PROJECTS_BRIEFING_MAX * PROJECT_LINE_CHARS, "the projects are forty lines");
  assert.equal(PROMPT_BUDGET.charter, CHARTER_MAX_CHARS, "the charter is its cap");
  assert.equal(PROMPT_BUDGET.queue, queueBudgetChars(5), "the queue digest is its five rows and their header");
  assert.equal(PROMPT_SECTION_DEFS.length, 14, "fourteen boxes: the eleven standing sections and the three moving ones");
});

test("the model draws the first turn of a session, an ordinary turn and the fourth wake", async (t) => {
  const { assistant } = await fixture(t);
  const model = assistant.promptBudget();
  assert.deepEqual(model.turns.map((x) => x.key), ["first", "ordinary", "fourth"], "three turns, in reading order");
  assert.deepEqual(model.gates.queueRows, 5);
  assert.equal(model.gates.queueWakes, 2, "the queue gate is the settings default");
  assert.equal(model.gates.boardWakes, 4, "the board's full sweep is the settings default");

  for (const turn of model.turns) {
    assert.equal(turn.total, turn.system + turn.turn, `${turn.key}: the prompt is its two halves`);
    // The section texts exclude the newlines that join them, so the standing half is the sections plus
    // one join per boundary; the exact assembled length is what the second test checks.
    const standing = sum(turn.sections.filter((s) => s.half === "system"));
    assert.ok(turn.system >= standing && turn.system - standing <= turn.sections.length, `${turn.key}: the standing half's sections add up to it (${standing} vs ${turn.system})`);
    // The turn half's sections exclude the newlines that join them; the total is the assembled text.
    const turnSections = sum(turn.sections.filter((s) => s.half === "turn"));
    assert.ok(turnSections <= turn.turn && turn.turn - turnSections <= 4, `${turn.key}: the turn's sections add up to it (${turnSections} vs ${turn.turn})`);
    for (const section of turn.sections) {
      assert.ok(section.share > 0 || section.chars === 0, `${turn.key}/${section.key}: a share is a real fraction`);
      assert.ok(section.share <= 1, `${turn.key}/${section.key}: no section is over 100%`);
    }
  }
});

test("a maxed fixture fills the sections its caps reserve, and the first turn is the builder's own text", async (t) => {
  const { assistant } = await fixture(t);
  const model = assistant.promptBudget();
  const first = model.turns.find((x) => x.key === "first");

  // The measured sizes against the caps. The section includes its header and numbering, so it is at
  // least the reserved text and only slightly above it.
  const rules = sectionOf(first, "rules");
  assert.ok(rules.chars >= RULE_BRIEFING_MAX * RULE_BRIEFING_CHARS, `rules ${rules.chars} >= ${RULE_BRIEFING_MAX * RULE_BRIEFING_CHARS}`);
  assert.ok(rules.chars <= RULE_BRIEFING_MAX * RULE_BRIEFING_CHARS + 200, `rules ${rules.chars} is the cap plus its numbering`);
  const notes = sectionOf(first, "notes");
  assert.ok(notes.chars >= NOTES_BRIEFING_CHARS && notes.chars <= NOTES_BRIEFING_CHARS + 40, `notes ${notes.chars}`);
  const watches = sectionOf(first, "watches");
  assert.ok(watches.chars >= WATCHES_BRIEFING_MAX * WATCH_TEXT_CHARS, `watches ${watches.chars}`);
  const charter = sectionOf(first, "charter");
  assert.ok(charter.chars >= CHARTER_MAX_CHARS, `charter ${charter.chars} carries the whole file`);
  assert.equal(charter.basis, "sent in full", "the first turn is the charter's full send");

  // The first turn's total IS what the builder sends: the system text as `say()` passes it and the
  // turn half as it is appended. `promptBudget` must not have advanced the charter's send record.
  const system = assistant.systemBriefing();
  const turn = assistant.turnBriefing();
  assert.equal(first.system, system.length, "the standing half is the system briefing's own length");
  assert.equal(first.total, system.length + turn.length, `the first turn is ${system.length} + ${turn.length}`);
  assert.match(turn, /Charter — the long tier, read in full this turn/, "the read-only budget did not spend the charter's first send");
});

test("the gates move exactly the sections they govern, and nothing else", async (t) => {
  const { assistant } = await fixture(t);
  const model = assistant.promptBudget();
  const first = model.turns.find((x) => x.key === "first");
  const ordinary = model.turns.find((x) => x.key === "ordinary");
  const fourth = model.turns.find((x) => x.key === "fourth");

  // The ordinary turn closes the queue gate and sends markers for the charter and the board.
  assert.equal(sectionOf(ordinary, "queue").chars, 0, "the ordinary turn carries no queue digest");
  assert.equal(sectionOf(ordinary, "queue").gated, true, "and says its gate is closed");
  assert.equal(sectionOf(ordinary, "queue").whenDue, sectionOf(first, "queue").chars, "naming what the next due wake takes");
  assert.equal(sectionOf(ordinary, "charter").basis, "the one-line marker");
  assert.equal(sectionOf(ordinary, "board").basis, "the one-line marker");
  assert.ok(sectionOf(ordinary, "charter").chars < sectionOf(first, "charter").chars, "the marker is smaller than the text");
  assert.ok(sectionOf(ordinary, "board").chars < sectionOf(first, "board").chars, "the board marker is smaller than the digest");

  // The fourth wake is the ordinary turn with the queue and board gates open, and the charter still a
  // marker: that is why it is drawn beside the other two.
  assert.equal(sectionOf(fourth, "queue").chars, sectionOf(first, "queue").chars, "the fourth wake's queue is due");
  assert.equal(sectionOf(fourth, "board").chars, sectionOf(first, "board").chars, "the fourth wake's board is the full digest");
  assert.equal(sectionOf(fourth, "charter").chars, sectionOf(ordinary, "charter").chars, "the charter is still a marker");
  // The arithmetic is exact to the section texts; the assembled totals also carry the newlines that
  // join them, so the difference between the two diagrams is allowed those few characters.
  const queueBytes = sectionOf(first, "queue").chars;
  const charterSaved = sectionOf(first, "charter").chars - sectionOf(ordinary, "charter").chars;
  const boardSaved = sectionOf(first, "board").chars - sectionOf(ordinary, "board").chars;
  assert.ok(
    Math.abs(fourth.total - (ordinary.total + queueBytes + boardSaved)) <= 4,
    `the fourth wake's extra bytes are the queue and the board's full digest (${fourth.total} vs ${ordinary.total} + ${queueBytes} + ${boardSaved})`,
  );
  assert.ok(
    Math.abs(ordinary.total - (first.total - queueBytes - charterSaved - boardSaved)) <= 4,
    `the ordinary turn's saved bytes are the queue, the charter text and the board digest (${ordinary.total} vs ${first.total} - ${queueBytes} - ${charterSaved} - ${boardSaved})`,
  );
});

test("reading the budget twice does not spend the charter's send, so the next turn still gets the text", async (t) => {
  const { assistant } = await fixture(t);
  const a = assistant.promptBudget();
  const b = assistant.promptBudget();
  assert.deepEqual(a.turns.map((x) => x.sections.map((s) => s.chars)), b.turns.map((x) => x.sections.map((s) => s.chars)));
  // A SECOND read is the one that would turn a real turn into a marker if the budget advanced the
  // record: turn 1 must still be the full charter, not a marker for text nobody read.
  const turn = assistant.turnBriefing();
  assert.match(turn, /Charter — the long tier, read in full this turn/, "the first real turn still carries the charter whole");
  assert.ok(turn.includes("c".repeat(200)), "and the body is in it");
});

test("an empty queue is an empty section, not a closed gate", async (t) => {
  const { assistant } = await fixture(t);
  await writeQueueFile(assistant.queuePathOf(assistant.assistantRecord()), [], 1);
  const model = assistant.promptBudget();
  for (const turn of model.turns) {
    const queue = sectionOf(turn, "queue");
    assert.equal(queue.chars, 0, `${turn.key}: no digest, no bytes`);
    assert.equal(queue.gated, undefined, `${turn.key}: an empty queue is not a gate that is closed`);
    assert.equal(queue.basis, "the queue is empty");
  }
});

// The tab is a route, not a module call: the picture must be what a browser gets. A sandbox panel boots
// the real server and the real Assistant over a fresh store, and the answer has to be the same model the
// unit tests above measured - three turns, the caps table and no error.
test("the Prompt tab's route answers the model through a real panel", async (t) => {
  const panel = await startPanel({ config: { assistant: { enabled: false } } });
  t.after(() => panel.stop());
  const r = await fetch(`${panel.base}/api/settings/prompt-budget`);
  assert.equal(r.status, 200, `GET /api/settings/prompt-budget: ${r.status}`);
  const model = await r.json();
  assert.equal(model.version, 1);
  assert.deepEqual(model.turns.map((x) => x.key), ["first", "ordinary", "fourth"]);
  assert.equal(model.budget.charter, CHARTER_MAX_CHARS);
  assert.equal(model.budget.rules, RULE_BRIEFING_MAX * RULE_BRIEFING_CHARS);
  for (const turn of model.turns) {
    assert.equal(turn.total, turn.system + turn.turn, `${turn.key}: the route's totals are its halves`);
    assert.equal(turn.sections.length, PROMPT_SECTION_DEFS.length, `${turn.key}: every section is drawn`);
  }
});
