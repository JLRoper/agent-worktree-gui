// Which twelve of an assistant's standing rules a turn is shown.
//
// The store holds up to 40 rules in the order they were written, and the briefing took the last twelve by position
// alone (`rules.slice(-12)`). The list is appended to and the assistant writes to it, so thirty rules it wrote for
// itself pushed every reader rule out of the window: the turn read the model's own guesses with the reader's
// answers nowhere in the text. The reader's now hold their own places in the twelve, the assistant's fill only
// what is left, and the block says how many rules the window left out.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RULE_BRIEFING_MAX, Assistant, briefingRules } from "../lib/assistant.js";

const READER_RULE = "never start a second run on a thread the digest lists as LIVE";

// Thirty sentences the assistant could plausibly have written for itself, all textually distinct: a list of
// near-identical lines would be collapsed into ONE rule by the refinement check on the way in, which is a
// different behaviour and not the one under test.
const ASSISTANT_TEXTS = [
  "name the merge commit in the landing report",
  "quote the failing assertion before touching the code",
  "read the queue before the board on every wake",
  "stop a worker that has been silent for an hour",
  "report a refused spawn with the panel's reason",
  "keep a reply under three sentences",
  "check the live run before starting a second one",
  "say which worktree a change belongs to",
  "never widen a test to make it pass",
  "leave the scratchpad shorter than you found it",
  "name the branch when a tree is mentioned",
  "copy evidence into the reply, not a summary",
  "watch the digest for a row that stopped moving",
  "ask the reader before restarting a live worker",
  "close a watch when its thread finishes",
  "mention the version a fix shipped in",
  "read the charter marker before rewriting it",
  "park a task that waits on a person",
  "spell out the command you would run",
  "count the rows before claiming the board is clean",
  "give the project name first in an approval question",
  "wake the reader for a patient wait, not a slow build",
  "record the reason a queue row was dropped",
  "keep a promise out of a reply unless it is done",
  "name the file a claim came from",
  "prefer an existing record over a duplicate ticket",
  "state the before and after numbers",
  "leave main alone while a tree is landing",
  "hand the merge to the panel, not to a script",
  "tell the reader what is blocked and what is next",
];

const iso = (minute) => new Date(Date.parse("2026-11-01T00:00:00Z") + minute * 60_000).toISOString();

/** A store in the order rules were written: the reader's first, then however many the assistant added after. */
function store({ reader = [READER_RULE], assistant = 0 } = {}) {
  return [
    ...reader.map((text, i) => ({ id: `reader-${i + 1}`, text, at: iso(i), by: "reader" })),
    ...ASSISTANT_TEXTS.slice(0, assistant).map((text, i) => ({
      id: `assistant-${i + 1}`,
      text,
      at: iso(reader.length + i),
      by: "assistant",
    })),
  ];
}

async function panel(t, { rules = store() } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-rules-briefing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(
    assistantFile,
    JSON.stringify({ version: 2, settings: {}, notes: "", rules, watches: [], alerts: [], journal: [] }),
  );
  return new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile,
      charterFile: path.join(dir, "assistant-charter.md"),
    },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => body },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
}

/** The rules block exactly as the standing text carries it: the header, the numbered lines and the left-out line. */
function rulesBlock(system) {
  const lines = system.split("\n");
  const start = lines.findIndex((line) => line.startsWith("Standing rules"));
  assert.ok(start >= 0, "the standing text carries the rules block");
  const end = lines.findIndex((line, i) => i > start && line.startsWith("Notes"));
  assert.ok(end > start, "the rules block ends where the notes begin");
  return lines.slice(start + 1, end);
}

const numbered = (block) => block.filter((line) => /^\d+\. /.test(line));

test("thirty assistant-written rules cannot displace a reader rule added before them", async (t) => {
  const assistant = await panel(t, { rules: store({ assistant: 30 }) });
  assert.equal(assistant.rulesFor().length, 31, "the store holds the reader's rule and the thirty the assistant wrote");

  const block = rulesBlock(assistant.systemBriefing());
  const shown = numbered(block);

  assert.equal(shown.length, RULE_BRIEFING_MAX, "the block still shows exactly twelve rules");
  assert.ok(shown[0].includes(READER_RULE), "the reader's rule holds the first place, however many the assistant wrote");
  assert.equal(
    block.filter((line) => line.includes(READER_RULE)).length,
    1,
    "and it is injected once, not repeated to make room for itself",
  );

  // The assistant's own newest rules fill the eleven places that are left, in the order they were written.
  for (let i = 30; i > 19; i -= 1) {
    assert.ok(
      block.some((line) => line.includes(ASSISTANT_TEXTS[i - 1])),
      `the assistant's rule ${i} still fits in what is left of the twelve`,
    );
  }
  assert.ok(
    !block.some((line) => line.includes(ASSISTANT_TEXTS[18])),
    "and rule 19, the oldest of the thirty, is the one the window leaves out",
  );

  assert.ok(
    block.includes("(19 older rules left out to fit the twelve)"),
    "the block says how many of the store's 31 rules the twelve left out",
  );
});

test("a reader whose own rules fill the twelve keeps every place from the assistant", async (t) => {
  const thirteen = Array.from({ length: 13 }, (_, i) => `reader rule ${i + 1}: keep the board honest`);
  // 13 + 27 is exactly the store's own cap of 40. A bigger fixture would be trimmed on the way in — by POSITION,
  // the load-time `slice(-RULE_MAX)` — and the three oldest reader rules would be gone before the briefing ran,
  // so the case would be measuring the store's cap instead of the window this file is about.
  const assistant = await panel(t, { rules: store({ reader: thirteen, assistant: 27 }) });
  assert.equal(assistant.rulesFor().length, 40, "the fixture sits exactly at the store's cap, nothing trimmed on load");
  const block = rulesBlock(assistant.systemBriefing());
  const shown = numbered(block);

  assert.equal(shown.length, RULE_BRIEFING_MAX, "still twelve");
  assert.ok(shown.every((line) => line.includes("keep the board honest")), "all twelve are the reader's");
  assert.ok(!shown.some((line) => line.includes("reader rule 1:")), "and the window took the reader's OLDEST, not one of the assistant's");
  assert.ok(!block.some((line) => ASSISTANT_TEXTS.some((text) => line.includes(text))), "the assistant's fill nothing");
  // 1 reader rule plus all 27 of the assistant's are behind the window.
  assert.ok(block.includes("(28 older rules left out to fit the twelve)"), "and the count says what is behind it");
});

test("briefingRules keeps the reader's first, fills with the assistant's newest, and counts what it dropped", () => {
  const rules = store({ reader: ["reader one", "reader two"], assistant: 3 });
  const out = briefingRules(rules);
  assert.deepEqual(
    out.rules.map((r) => r.text),
    ["reader one", "reader two", ...ASSISTANT_TEXTS.slice(0, 3)],
    "the reader's in the order they were written, then the assistant's",
  );
  assert.equal(out.leftOut, 0, "a store that fits loses nothing");
  assert.deepEqual(briefingRules([]), { rules: [], leftOut: 0 }, "an empty store is an empty block");
  assert.deepEqual(
    briefingRules(store({ reader: ["reader one"], assistant: 30 })).rules.slice(0, 1).map((r) => r.text),
    ["reader one"],
    "the reader's place does not depend on how many rules follow it",
  );
});
