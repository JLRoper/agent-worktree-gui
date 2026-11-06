// The quiet rule's subject is the SILENCE, not the clock: one run that has printed nothing for a
// while is one alert. It was not, when the last console line carried no timestamp - the subject fell
// back to the run's age, which advances on every sweep, so the rearm dedupe never matched and the
// rule re-fired every sweep (and, at `wake`, started a turn each time). These cases drive the
// sentry's own `evaluate` over a fixed board and advance the clock by hand.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";

async function board(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-quiet-subject-"));
  const rows = [];
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
      assistant: {},
    },
    jobs: { list: () => rows },
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  assistant.settings.rules.quiet = "alert";
  assistant.settings.quietSeconds = 60;
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { assistant, rows };
}

const live = (extra = {}) => ({
  id: "job-untimed",
  thread: "wtgui-untimed-111111",
  runId: "run_untimed",
  status: "running",
  startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  lines: [{ kind: "text", text: "carried over from the previous turn", at: null }],
  ...extra,
});

const quietAlerts = (assistant) => assistant.alerts.filter((a) => a.rule === "quiet");

test("one silence is one alert even when the last line carries no timestamp", async (t) => {
  const { assistant, rows } = await board(t);
  rows.push(live());

  const at = Date.now();
  for (const step of [0, 8_000, 16_000, 24_000, 32_000]) assistant.evaluate(rows, at + step);

  assert.equal(quietAlerts(assistant).length, 1, "five sweeps over one unchanged silence are one alert");
});

test("a live job that has printed nothing at all is one alert too", async (t) => {
  const { assistant, rows } = await board(t);
  rows.push(live({ id: "job-silent", thread: "wtgui-silent-222222", runId: "run_silent", lines: [] }));

  const at = Date.now();
  for (const step of [0, 8_000, 16_000, 24_000]) assistant.evaluate(rows, at + step);

  assert.equal(quietAlerts(assistant).length, 1, "no line is not a new silence every sweep");
});

test("a genuinely new quiet period is a new alert", async (t) => {
  const { assistant, rows } = await board(t);
  const job = live();
  rows.push(job);

  const at = Date.now();
  assistant.evaluate(rows, at);
  assert.equal(quietAlerts(assistant).length, 1, "the first silence raises one alert");

  // A new line, then silence again: a different silence, so a different alert.
  job.lines = [{ kind: "text", text: "one more thing", at: at + 30_000 }];
  assistant.evaluate(rows, at + 95_000);
  assert.equal(quietAlerts(assistant).length, 2, "a new last-output timestamp is a new silence");
});

test("two runs on one thread are two subjects", async (t) => {
  const { assistant, rows } = await board(t);
  rows.push(live());
  rows.push(live({ id: "job-second-turn", runId: "run_second" }));

  const at = Date.now();
  assistant.evaluate(rows, at);
  assistant.evaluate(rows, at + 8_000);

  assert.equal(quietAlerts(assistant).length, 2, "each live turn gets its own alert, once");
});
