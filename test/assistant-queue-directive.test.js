// "Drive your own queue" — the standing directive EVERY assistant's preamble carries.
//
// The queue is per assistant: state/assistants/<id>/queue.json beside that assistant's charter. A per-assistant store
// is only half of the isolation — an assistant that never hears the queue is its own leaves it driving Assistant #1's
// work, or none at all. So the directive is in `Assistant.preamble()`, built for the id it is asked for, and it is
// STANDING: it is not part of the queue digest, which `queueSweepEveryNWakes` gates, so a wake that skips the digest
// still hears it. It rides right after the default role prompt a turn runs on, which is where a reader's own
// instructions end and the panel's begin.
//
// What this file pins, in the brief's own words:
//   1. every assistant is told its queue is its own — Assistant #1 and a second assistant, each with its OWN path;
//   2. the five behaviours are said: read it on every wake, start what can be parallelised, never leave a queued task
//      it could be doing, mark done only when the PR reads MERGED, and never file work into another assistant's queue
//      except by an explicit reassign;
//   3. it is said ONCE, and it survives a reader's own role prompt (which is prepended, not a replacement);
//   4. a wake that skips the digest still carries it — the directive is not the gated briefing.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";

async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-queue-directive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const created = [];
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
    getProjects: () => [],
    onLog: () => {},
  });
  return { assistant, created, dir };
}

// The directive's own sentences. Written out here rather than imported from the module under test: a test that reads
// the page's constant back proves only that the constant agrees with itself, and the words a model is handed are the
// thing being pinned.
const OPENER = "Your task queue is YOURS — this is a standing instruction for every assistant, not only Assistant #1.";
const BEHAVIOURS = [
  "Read it on every wake",
  "Start what can be parallelised",
  "Never leave a queued task you could be doing",
  "Mark a task done only when its PR reads MERGED",
  "Never file work into another assistant's queue",
  "explicit reassign",
];

test("every assistant's preamble carries the directive, each naming its own queue file", async (t) => {
  const { assistant } = await panel(t);
  const second = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  assert.notEqual(second, PRIMARY_ASSISTANT, "there is a second assistant to check");

  for (const id of [PRIMARY_ASSISTANT, second]) {
    const text = assistant.preamble(id);
    assert.ok(text.includes(OPENER), `${id} is told its queue is its own`);
    assert.equal(text.split(OPENER).length - 1, 1, `${id} is told it once, not twice`);
    for (const phrase of BEHAVIOURS) assert.ok(text.includes(phrase), `${id} is told: ${phrase}`);
    assert.ok(
      text.includes(`/assistants/${id}/queue.json`),
      `${id}'s directive names its own file (assistants/${id}/queue.json)`,
    );
  }
  // #2 is not handed #1's path — the file named in a preamble is the one that assistant may write.
  assert.ok(
    !assistant.preamble(second).includes(`/assistants/${PRIMARY_ASSISTANT}/queue.json`),
    "#2 is not shown #1's queue file",
  );
});

test("a reader's own role prompt does not replace the directive", async (t) => {
  const { assistant } = await panel(t);
  const second = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  assistant.saveProfile(second, { prompt: "Answer in one line and never guess." });
  const text = assistant.preamble(second);
  assert.ok(text.includes("Answer in one line and never guess."), "the reader's prompt rides in full");
  assert.ok(text.includes(OPENER), "and the queue directive rides with it");
  assert.ok(text.indexOf(OPENER) > text.indexOf("Answer in one line"), "the directive follows the role prompt");
});

test("the directive is standing: a wake that skips the queue digest still carries it", async (t) => {
  const { assistant } = await panel(t);
  const gated = assistant.preamble(PRIMARY_ASSISTANT, { queue: false });
  for (const phrase of [OPENER, ...BEHAVIOURS]) assert.ok(gated.includes(phrase), `a digest-skipping wake still hears: ${phrase}`);
  assert.ok(!gated.includes("and the digest below is its top"), "but it does not promise a digest this turn does not carry");
  assert.ok(
    assistant.preamble(PRIMARY_ASSISTANT, { queue: true }).includes("and the digest below is its top"),
    "and the turn that does carry the digest says so",
  );
});

test("the turn the panel creates is the one that carries it", async (t) => {
  const { assistant, created } = await panel(t);
  const second = assistant.createAssistant({ roleId: "agent-manager", name: "Reviewer" }).created.id;
  await assistant.say("what are you carrying?", { assistantId: second });
  await assistant.say("and you?");
  assert.equal(created.length, 2);
  // The thread each run was created on is the assistant whose preamble it carries, so the path can be checked per run.
  const idOf = { "panel-assistant-2": second, [ASSISTANT_THREAD]: PRIMARY_ASSISTANT };
  for (const job of created) {
    const id = idOf[job.thread];
    assert.ok(id, `the run's thread is one of the two assistants: ${job.thread}`);
    assert.ok(job.preamble.includes(OPENER), `${job.thread}'s run is handed the directive`);
    assert.ok(job.preamble.includes(`/assistants/${id}/queue.json`), `${job.thread} is handed its own path`);
  }
});
