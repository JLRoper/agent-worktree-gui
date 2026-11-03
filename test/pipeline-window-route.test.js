// The task pipeline window's READ, over HTTP, against a real panel on a spare port.
//
//   GET /api/assistant/task-pipeline?assistantId=<id>&task=<id>
//
// The model is proved without a panel in test/pipeline-window.test.js. This file is about what the page actually talks
// to, and the four things a route can get wrong that a pure function cannot:
//
//   1. the assignment reaches the route at all — the queue file is read through `pickTask`, whose schema is a fixed
//      list, so a field it does not carry is a field the window can never see. The pipeline record is carried VERBATIM
//      (a broken one included), and this pins that;
//   2. the bundle is read from the panel's own state folder (`config.pipelineBundleFile`) at request time: a re-export
//      is seen on the next open, and an absent or refused bundle is an ANSWER with its code, not a 500;
//   3. the request is a read: one GET writes nothing, which is checked by hashing the queue file on both sides;
//   4. the failures are sentences the dialog can print — no task, no assistant, and a body on a GET.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pickTask } from "../lib/assistant/queue.js";
import { startPanel } from "../tools/panel-testkit.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

const stage = (n) => ({
  id: `S${n}`,
  title: `Stage ${n}`,
  prompt: `Do stage ${n}.`,
  artifact: { id: `artifact-${n}`, path: `out/${n}.json`, schema: "out/1", writer: `worker-${n}` },
});

const bundleDoc = () => ({
  bundleVersion: 1,
  name: "poc-to-uat",
  pipelines: [
    {
      id: "poc-to-uat",
      title: "POC to UAT",
      stages: [stage(1), stage(2), stage(3), stage(4), stage(5)],
      gates: [
        { id: "g2", name: "contract signed", after: "S2", artifact: "artifact-2", decider: "reader", decision: { id: "d2", path: "decisions/2.json", schema: "decision/1", writer: "gate-2", outcomes: ["go", "no-go"] } },
      ],
      handoffs: [
        { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h2", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
        { id: "h3", from: "S3", to: "S4", artifact: "artifact-3", kind: "sequence" },
        { id: "h4", from: "S4", to: "S5", artifact: "artifact-4", kind: "sequence" },
      ],
    },
  ],
});

const get = async (base, query) => {
  const res = await fetch(`${base}/api/assistant/task-pipeline?${query}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an error page is read as text by the assertion that failed */
  }
  return { status: res.status, json, text };
};

test("the queue's own schema carries the pipeline assignment verbatim, broken records included", () => {
  const run = { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" };
  assert.deepEqual(pickTask({ id: 1, title: "t", pipelineRun: run }).pipelineRun, run);
  assert.equal(pickTask({ id: 1, title: "t" }).pipelineRun, null, "no assignment is null, not a default pipeline");
  assert.equal(pickTask({ id: 1, title: "t", pipelineRun: null }).pipelineRun, null);
  // A record the contract would call unresolved must SURVIVE this schema: normalising it away here would silently put
  // the task back on the assistant-decides path.
  assert.equal(pickTask({ id: 1, title: "t", pipelineRun: "poc-to-uat" }).pipelineRun, "poc-to-uat");
});

test("one GET answers the window for a task, its pipeline, its stage and its stamp — and writes nothing", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-pipewin-"));
  const logs = path.join(dir, "logs");
  await mkdir(path.join(logs, "assistants", "assistant-1"), { recursive: true });
  const bundleFile = path.join(logs, "pipeline-bundle.json");
  await writeFile(bundleFile, JSON.stringify(bundleDoc(), null, 1), "utf8");
  const queueFile = path.join(logs, "assistants", "assistant-1", "queue.json");

  const panel = await startPanel({
    dir,
    keep: true,
    config: {
      pipelineBundleFile: bundleFile,
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    },
  });
  t.after(async () => {
    await panel.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const enteredAt = new Date(Date.now() - 3_600_000).toISOString();
  const tasks = [
    { id: 7, title: "carry the contract", state: "running", thread: null, threads: [], files: [], pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt } },
    { id: 8, title: "unassigned work", state: "queued", files: [], pipelineRun: null },
    { id: 9, title: "points at a pipeline that left", state: "queued", files: [], pipelineRun: { pipeline: "gone-to-uat", stage: "S1", enteredAt } },
  ];
  await writeFile(queueFile, JSON.stringify({ version: 3, nextId: 10, tasks }, null, 1), "utf8");
  const before = sha(await readFile(queueFile, "utf8"));

  // (1) the task on a pipeline: the sequence, the current stage and the gate that ended the one before it.
  const one = await get(panel.base, "assistantId=assistant-1&task=7");
  assert.equal(one.status, 200, `the window read must answer 200: ${one.text.slice(0, 300)}`);
  assert.equal(one.json.mode, "pipeline");
  assert.equal(one.json.assistantId, "assistant-1");
  assert.equal(one.json.task.id, 7);
  assert.equal(one.json.task.title, "carry the contract");
  assert.equal(one.json.pipeline.id, "poc-to-uat");
  assert.equal(one.json.current.id, "S3");
  assert.equal(one.json.current.position, 3);
  assert.equal(one.json.count, 5);
  assert.deepEqual(one.json.stages.map((s) => s.id), ["S1", "S2", "S3", "S4", "S5"]);
  assert.equal(one.json.previous.stage.id, "S2");
  assert.equal(one.json.previous.gate.name, "contract signed");
  assert.equal(one.json.previous.gate.decision.path, "decisions/2.json");
  assert.equal(one.json.enteredAt, enteredAt);
  const ms = one.json.elapsed.ms;
  assert.ok(ms >= 3_600_000 && ms < 3_700_000, `elapsed is the stored stamp against the request's clock (got ${ms})`);
  assert.ok(Number.isFinite(Date.parse(one.json.computedAt)), "the answer carries the instant it was computed at");

  // (2) a task with no pipeline says so, and carries no sequence to mistake for one.
  const two = await get(panel.base, "assistantId=assistant-1&task=8");
  assert.equal(two.status, 200);
  assert.equal(two.json.mode, "assistant-decides");
  assert.deepEqual(two.json.stages, []);
  assert.match(two.json.reason, /assistant decides/);

  // (3) a record the bundle cannot resolve is unresolved, with the reason — never the default path.
  const three = await get(panel.base, "assistantId=assistant-1&task=9");
  assert.equal(three.status, 200);
  assert.equal(three.json.mode, "unresolved");
  assert.equal(three.json.unresolved.kind, "pipeline");
  assert.match(three.json.reason, /gone-to-uat/);

  // (4) a bundle that is not there, and one that was refused: both are answers the dialog can draw.
  await unlink(bundleFile);
  const missing = await get(panel.base, "assistantId=assistant-1&task=7");
  assert.equal(missing.status, 200);
  assert.equal(missing.json.bundle.ok, false);
  assert.equal(missing.json.bundle.code, "missing");
  assert.equal(missing.json.mode, "unresolved");
  assert.match(missing.json.reason, /pipeline-bundle\.json/);

  await writeFile(bundleFile, '{"bundleVersion": 1, "pipelines": [', "utf8");
  const refused = await get(panel.base, "assistantId=assistant-1&task=7");
  assert.equal(refused.status, 200);
  assert.equal(refused.json.bundle.code, "not-a-bundle");
  assert.match(refused.json.reason, /not JSON/);

  // (5) the refusals a route owes a caller that named nothing, or named something not there.
  const noTask = await get(panel.base, "assistantId=assistant-1");
  assert.equal(noTask.status, 400);
  assert.match(noTask.json.error, /task/);

  const unknownTask = await get(panel.base, "assistantId=assistant-1&task=999");
  assert.equal(unknownTask.status, 404);
  assert.match(unknownTask.json.error, /#999/);

  const unknownAssistant = await get(panel.base, "assistantId=nope&task=7");
  assert.equal(unknownAssistant.status, 404);

  const posted = await fetch(`${panel.base}/api/assistant/task-pipeline?assistantId=assistant-1&task=7`, { method: "POST", body: "{}" });
  assert.equal(posted.status, 405, "the window is a read");

  // (6) nothing above wrote a byte of the queue it read.
  const after = sha(await readFile(queueFile, "utf8"));
  assert.equal(after, before, "the window's read does not touch the queue file");
});
