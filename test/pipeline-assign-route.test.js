// Putting a task on a pipeline over HTTP, against a real panel on a spare port.
//
//   GET  /api/assistant/pipeline-catalogue             the pipelines a control may offer, and the loader's refusal
//   POST /api/assistant/queue {action:"pipeline", …}   assign a pipeline + starting stage, or clear back to the default
//
// The interesting half of this route is not the status code, it is the ROUND TRIP: the last round found the queue's
// own schema dropping `pipelineRun` between the file and the page, so nothing here trusts "the write returned ok".
// Every assignment is read back three ways — the raw JSON on disk, `pickTask` over that JSON, and the window route that
// the dialog actually calls — and each must agree on the id, the stage, the stamp and the position.
//
// The other facts this pins:
//   - an unassigned task stays unassigned: one task's press does not put the queue on a pipeline;
//   - the same stage twice is a no-op, so a second press cannot restart the stored clock;
//   - a missing bundle is a 400 with a sentence on the way IN and `unresolved` with a reason on the way OUT — never a
//     silent assignment and never a 500;
//   - a refused assignment writes nothing: the queue file's bytes are identical before and after.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pickTask, readQueueFile } from "../lib/assistant/queue.js";
import { startPanel } from "../tools/panel-testkit.mjs";

const TOKEN = "assign-token";
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
      gates: [{ id: "g2", name: "contract signed", after: "S2", artifact: "artifact-2", decider: "reader", decision: { id: "d2", path: "decisions/2.json", schema: "decision/1", writer: "gate-2", outcomes: ["go", "no-go"] } }],
      handoffs: [
        { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h2", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
        { id: "h3", from: "S3", to: "S4", artifact: "artifact-3", kind: "sequence" },
        { id: "h4", from: "S4", to: "S5", artifact: "artifact-4", kind: "sequence" },
      ],
    },
  ],
});

const get = async (base, route) => {
  const res = await fetch(`${base}${route}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an error page is read as text by the assertion that failed */
  }
  return { status: res.status, json, text };
};

const post = async (base, body, { token = TOKEN } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["x-panel-token"] = token;
  const res = await fetch(`${base}/api/assistant/queue`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the assertion prints the body */
  }
  return { status: res.status, json, text };
};

test("a task can be put on a pipeline, read back from disk, and cleared — with the default left alone", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-pipeassign-"));
  const logs = path.join(dir, "logs");
  await mkdir(path.join(logs, "assistants", "assistant-1"), { recursive: true });
  const bundleFile = path.join(logs, "pipeline-bundle.json");
  await writeFile(bundleFile, JSON.stringify(bundleDoc(), null, 1), "utf8");
  const queueFile = path.join(logs, "assistants", "assistant-1", "queue.json");

  const panel = await startPanel({
    dir,
    keep: true,
    token: TOKEN,
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

  await writeFile(
    queueFile,
    JSON.stringify(
      {
        version: 3,
        nextId: 9,
        tasks: [
          { id: 7, title: "unassigned work", state: "queued", files: [], pipelineRun: null },
          { id: 8, title: "also unassigned", state: "queued", files: [], pipelineRun: null },
        ],
      },
      null,
      1,
    ),
    "utf8",
  );

  // ---- the catalogue the control draws ---------------------------------------------------------------
  const catalogue = await get(panel.base, "/api/assistant/pipeline-catalogue");
  assert.equal(catalogue.status, 200, catalogue.text.slice(0, 300));
  assert.equal(catalogue.json.ok, true);
  assert.deepEqual(catalogue.json.pipelines.map((p) => p.id), ["poc-to-uat"]);
  assert.deepEqual(catalogue.json.pipelines[0].stages.map((s) => s.position), [1, 2, 3, 4, 5]);
  // The rest of the pipeline's own shape travels too: the flow modal draws its notches from `gates` and its capped
  // loops from `handoffs`, and a stage list alone would make it read the bundle twice or draw a sequence with the
  // gates missing.
  assert.deepEqual(catalogue.json.pipelines[0].gates.map((g) => [g.id, g.after, g.name]), [["g2", "S2", "contract signed"]]);
  assert.equal(catalogue.json.pipelines[0].gates[0].decision.outcomes.join(","), "go,no-go", "a gate's decision travels with it");
  assert.deepEqual(catalogue.json.pipelines[0].handoffs.map((h) => [h.id, h.from, h.to, h.kind]), [
    ["h1", "S1", "S2", "sequence"],
    ["h2", "S2", "S3", "sequence"],
    ["h3", "S3", "S4", "sequence"],
    ["h4", "S4", "S5", "sequence"],
  ]);

  // ---- assign #7 at S2 ------------------------------------------------------------------------------
  const before = Date.now();
  const assigned = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 7, pipeline: "poc-to-uat", stage: "S2" });
  assert.equal(assigned.status, 200, assigned.text.slice(0, 400));
  assert.equal(assigned.json.ok, true);

  const onDisk = JSON.parse(await readFile(queueFile, "utf8"));
  const raw = onDisk.tasks.find((x) => x.id === 7);
  assert.equal(raw.pipelineRun.pipeline, "poc-to-uat");
  assert.equal(raw.pipelineRun.stage, "S2");
  const stamped = Date.parse(raw.pipelineRun.enteredAt);
  assert.ok(Number.isFinite(stamped), `the file carries a real stamp: ${raw.pipelineRun.enteredAt}`);
  assert.ok(stamped >= before - 1_000 && stamped <= Date.now() + 1_000, `the stamp is the write's clock, not a guess: ${raw.pipelineRun.enteredAt}`);

  // The queue's own schema carries it back (the defect the last round found).
  const { tasks: picked } = readQueueFile(queueFile);
  assert.deepEqual(picked.find((x) => x.id === 7).pipelineRun, raw.pipelineRun);
  assert.equal(pickTask(raw).pipelineRun.stage, "S2");

  // And the page's own view carries it: read back through the route the dialog calls.
  const view = await get(panel.base, "/api/assistant/task-pipeline?assistantId=assistant-1&task=7");
  assert.equal(view.status, 200, view.text.slice(0, 300));
  assert.equal(view.json.mode, "pipeline");
  assert.equal(view.json.current.id, "S2");
  assert.equal(view.json.current.position, 2);
  assert.equal(view.json.count, 5);
  assert.equal(view.json.enteredAt, raw.pipelineRun.enteredAt, "the window reads the stamp the queue stored");
  assert.ok(Math.abs(view.json.elapsed.ms - (Date.now() - stamped)) < 5_000, `elapsed is now minus the stored stamp (${view.json.elapsed.ms})`);

  // Nothing else was touched: the other task is still on the default path.
  assert.equal(onDisk.tasks.find((x) => x.id === 8).pipelineRun, null, "no task is retro-assigned");
  const other = await get(panel.base, "/api/assistant/task-pipeline?assistantId=assistant-1&task=8");
  assert.equal(other.json.mode, "assistant-decides");

  // ---- the same stage twice does not rewrite the stored stamp ---------------------------------------
  const again = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 7, pipeline: "poc-to-uat", stage: "S2" });
  assert.equal(again.status, 200);
  const twice = JSON.parse(await readFile(queueFile, "utf8")).tasks.find((x) => x.id === 7);
  assert.equal(twice.pipelineRun.enteredAt, raw.pipelineRun.enteredAt, "a second press is not a re-entry");

  // ---- a different stage is a new entry --------------------------------------------------------------
  const moved = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 7, pipeline: "poc-to-uat", stage: "S4" });
  assert.equal(moved.status, 200);
  const atFour = JSON.parse(await readFile(queueFile, "utf8")).tasks.find((x) => x.id === 7);
  assert.equal(atFour.pipelineRun.stage, "S4");
  assert.ok(Date.parse(atFour.pipelineRun.enteredAt) >= stamped, "the new stage starts its own clock");

  // ---- clear it back to assistant-decides -----------------------------------------------------------
  const cleared = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 7, clear: true });
  assert.equal(cleared.status, 200, cleared.text.slice(0, 300));
  const gone = JSON.parse(await readFile(queueFile, "utf8")).tasks.find((x) => x.id === 7);
  assert.equal(gone.pipelineRun, null);
  const afterClear = await get(panel.base, "/api/assistant/task-pipeline?assistantId=assistant-1&task=7");
  assert.equal(afterClear.json.mode, "assistant-decides", "clearing is the default path, not an unresolved record");

  // ---- refusals: named, and the file is not written ------------------------------------------------
  const hashBefore = sha(await readFile(queueFile, "utf8"));
  const unknownPipeline = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 7, pipeline: "gone-to-uat", stage: "S1" });
  assert.equal(unknownPipeline.status, 400);
  assert.match(unknownPipeline.json.error, /gone-to-uat/);
  assert.match(unknownPipeline.json.error, /poc-to-uat/, "the refusal names the pipeline the bundle holds");

  const unknownStage = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 7, pipeline: "poc-to-uat", stage: "S99" });
  assert.equal(unknownStage.status, 400);
  assert.match(unknownStage.json.error, /S99/);
  assert.match(unknownStage.json.error, /S1, S2, S3, S4, S5/);

  const noStage = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 7, pipeline: "poc-to-uat" });
  assert.equal(noStage.status, 400);
  assert.match(noStage.json.error, /stage/i);

  const noTask = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 999, pipeline: "poc-to-uat", stage: "S1" });
  assert.equal(noTask.status, 400);
  assert.match(noTask.json.error, /#999/);
  assert.equal(sha(await readFile(queueFile, "utf8")), hashBefore, "every refused assignment wrote nothing");

  // The write guard itself is the queue's (transport.authorised), and test/auth.test.js proves it from a non-loopback
  // socket: a loopback caller is the board's own page and is exempt by design, so there is nothing to assert here.
  const wrote = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 7, pipeline: "poc-to-uat", stage: "S1" });
  assert.equal(wrote.status, 200, "a real assignment writes");

  // ---- no bundle beside the job store: honest in both directions ------------------------------------
  await unlink(bundleFile);
  const hashAssigned = sha(await readFile(queueFile, "utf8"));
  const refusedWrite = await post(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 8, pipeline: "poc-to-uat", stage: "S1" });
  assert.equal(refusedWrite.status, 400, "with no bundle there is nothing to assign a stage FROM");
  assert.match(refusedWrite.json.error, /pipeline-bundle\.json/);
  assert.match(refusedWrite.json.error, /no bundle/i);
  assert.equal(sha(await readFile(queueFile, "utf8")), hashAssigned, "the refused write left the queue alone");

  const stranded = await get(panel.base, "/api/assistant/task-pipeline?assistantId=assistant-1&task=7");
  assert.equal(stranded.status, 200, "an assigned task still answers — with a reason, not a 500");
  assert.equal(stranded.json.mode, "unresolved");
  assert.equal(stranded.json.unresolved.kind, "bundle");
  assert.match(stranded.json.reason, /pipeline-bundle\.json/);

  const catalogueGone = await get(panel.base, "/api/assistant/pipeline-catalogue");
  assert.equal(catalogueGone.status, 200);
  assert.equal(catalogueGone.json.ok, false);
  assert.equal(catalogueGone.json.code, "missing");
  assert.deepEqual(catalogueGone.json.pipelines, []);

  const cataloguePost = await fetch(`${panel.base}/api/assistant/pipeline-catalogue`, { method: "POST", body: "{}" });
  assert.equal(cataloguePost.status, 405, "the catalogue is a read");
});
