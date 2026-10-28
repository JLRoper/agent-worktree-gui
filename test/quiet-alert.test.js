// The quiet rule: one silence is one alert.
//
// The subject used to be `${thread}|${turnId}|${Math.floor(quietFor / 60000)}`, which is the clock rather than the
// silence: one unchanged run crossed a minute boundary between two sweeps and raised a second alert for the same
// fact (measured: "no new output for 33m" and "no new output for 34m" for one run, same last line both times), and
// with the rule at `wake` each duplicate spent another turn. The key is now thread + turn + run id + the run's own
// last-output timestamp, so two sweeps of one unchanged run are one key.
//
// `evaluate` takes a `now`, which is how two sweeps either side of a minute boundary are driven in milliseconds.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";

const RUN = "run_fe8af9942ccc474987962ff44c653e79";
const THREAD = "wtgui-do-some-project-cleanup-of-w-42c493";

test("two quiet sweeps of one unchanged run raise one alert", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-quiet-"));
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
      defaultCwd: dir,
    },
    jobs: { list: () => rows },
    getProjects: () => [],
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(async () => {
    if (assistant.timer) clearInterval(assistant.timer);
    await rm(dir, { recursive: true, force: true });
  });
  assistant.settings.quietSeconds = 240;
  assistant.settings.rules.quiet = "alert";

  // One run, one last line, two sweeps either side of the minute boundary the old key quantised on — the pair that
  // produced "no new output for 33m" and "no new output for 34m" for the same unchanged run.
  const lastLineAt = Date.parse("2026-10-27T12:00:00.000Z");
  const rows = [
    {
      id: "job-1",
      thread: THREAD,
      runId: RUN,
      status: "running",
      startedAt: new Date(lastLineAt - 60_000).toISOString(),
      lines: [{ kind: "text", text: "still working", at: lastLineAt }],
    },
  ];
  const firstAt = lastLineAt + 33 * 60_000 + 54_000; // 33m54s of silence
  const secondAt = lastLineAt + 34 * 60_000 + 6_000; // 34m06s
  assert.notEqual(
    Math.floor((firstAt - lastLineAt) / 60_000),
    Math.floor((secondAt - lastLineAt) / 60_000),
    "the two sweeps straddle the boundary that used to make a second key",
  );

  assistant.evaluate(rows, firstAt);
  assistant.evaluate(rows, secondAt);

  const quiet = assistant.alerts.filter((a) => a.rule === "quiet");
  assert.equal(quiet.length, 1, "one silence is one alert");
  assert.match(quiet[0].title, /no new output/);
  assert.equal(quiet[0].turnId, "job-1");
});
