import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { errorStatus } from "../lib/errors.js";

async function fixture(t, supported = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-reasoning-"));
  const home = process.env.HERMES_HOME;
  process.env.HERMES_HOME = path.join(dir, "hermes");
  const requests = [];
  const stores = [];
  const server = createServer(async (req, res) => {
    const json = (data) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (req.url === "/v1/capabilities") return json({ features: { run_submission: true, run_events_sse: true, model_options: supported } });
    if (req.url === "/v1/runs" && req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      requests.push(JSON.parse(text));
      return json({ run_id: `fixture-${requests.length}` });
    }
    if (/\/events$/.test(req.url)) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(`data: ${JSON.stringify({ event: "run.completed", output: "done", exit_code: 0 })}\n\n`);
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = { apiServer: { url: `http://127.0.0.1:${server.address().port}`, key: "fixture-key" }, jobsFile: path.join(dir, "jobs.json") };
  const makeJobs = () => {
    const store = new Jobs({ config, onLog: () => {} });
    stores.push(store);
    return store;
  };
  const jobs = makeJobs();
  const create = async (opts = {}, store = jobs) => {
    const result = await store.create({ prompt: "test reasoning", thread: "wtgui-reasoning-fixture", cwd: dir, existing: true, remoteWrite: "none", ...opts });
    const deadline = Date.now() + 10_000;
    while (store.get(result.id).status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.get(result.id).status, "done");
    return store.summary(store.get(result.id));
  };
  t.after(async () => {
    for (const store of stores) {
      for (const job of store.jobs.values()) store.settle(job, "cancelled", {});
      clearInterval(store.titleSweep);
      clearInterval(store.approvalSweep);
      clearTimeout(store.persistTimer);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (home === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = home;
  });
  return { dir, jobs, requests, create, makeJobs, config };
}

test("Off reaches the gateway as disabled; resetting to default omits model_options", async (t) => {
  const f = await fixture(t);
  await f.create({ reasoningEffort: "none" });
  assert.deepEqual(f.requests[0].model_options, { reasoning: { enabled: false } });
  await f.create({ reply: true, reasoningEffort: "" });
  assert.equal(Object.hasOwn(f.requests[1], "model_options"), false);
});

test("the latest reasoning level survives a jobs-store restart and is reused on a reply", async (t) => {
  const f = await fixture(t);
  await f.create({ reasoningEffort: "high" });
  await f.create({ reply: true, reasoningEffort: "low" });
  const deadline = Date.now() + 5000;
  while (f.jobs.persistTimer && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const saved = JSON.parse(await readFile(f.config.jobsFile, "utf8"));
  assert.equal(saved.jobs.find((job) => job.turn === 2).reasoningEffort, "low");
  const restored = f.makeJobs();
  assert.equal(restored.list().find((job) => job.turn === 2).reasoningEffort, "low");
  await f.create({ reply: true }, restored);
  assert.deepEqual(f.requests.at(-1).model_options, { reasoning: { enabled: true, effort: "low" } });
});

test("an invalid effort is rejected before a job, workspace or run is created", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.create({ existing: false, reasoningEffort: "turbo" }), (error) => errorStatus(error) === 400);
  assert.equal(f.jobs.jobs.size, 0);
  assert.equal(f.requests.length, 0);
});

test("unsupported gateways refuse an override but still accept the unchanged default", async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(() => f.create({ existing: false, reasoningEffort: "medium" }), (error) => errorStatus(error) === 503);
  assert.equal(f.jobs.jobs.size, 0);
  assert.equal(f.requests.length, 0);
  await f.create();
  assert.equal(Object.hasOwn(f.requests[0], "model_options"), false);
});
