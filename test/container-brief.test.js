// The CONTAINERS paragraph: the write half of the container teardown, proved on the body a worker actually receives.
//
// lib/container-teardown.js can only stop what it can find, and what it finds is a Docker label written where the
// container was created. So the label convention is not documentation, it is part of the feature: without this
// paragraph in the brief, every teardown proof is green and every real worker's container is still running.
//
// The body is read off a stub Runs API that records what was POSTed - "what the worker reads" is the claim, not what
// the constant says - and the tree value in it must be THIS run's tree, in the panel's one spelling.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs } from "../lib/jobs.js";
import { labelTree } from "../lib/container-teardown.js";
import { configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-container-home-"));
process.env.API_SERVER_KEY = "";

const sweep = (...dirs) => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* a background git handle on Windows; OS temp is throwaway */
    }
  }
};

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-container-repo-"));
  runGit(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# container brief sandbox\n");
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-q", "-m", "first"]);
  return dir;
}

async function stubGateway() {
  const submitted = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ version: "stub", features: { run_submission: true, run_events_sse: true } }));
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          submitted.push(JSON.parse(raw || "{}"));
        } catch {
          submitted.push({});
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: `stub-run-${submitted.length}`, status: "running" }));
      });
      return;
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", output: "done", exit_code: 0 })}\n\n`);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ run_id: "stub-run-0", status: "completed" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    last: () => String(submitted[submitted.length - 1]?.input || ""),
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

test("a worker is told the two labels and --rm, with its own tree written into the label", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-container-jobs-"));
  const jobs = new Jobs({
    config: { apiServer: { url: stub.url }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 3600 },
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(async () => {
    for (const j of jobs.jobs.values()) {
      clearTimeout(j.timer);
      clearInterval(j.poller);
      clearInterval(j.statsTimer);
      try {
        j.ctrl?.abort();
      } catch {
        /* an aborted stream is the point */
      }
    }
    clearTimeout(jobs.persistTimer);
    await stub.stop();
    sweep(dir, repo);
  });

  const job = await jobs.create({ prompt: "run a container for a measurement", cwd: repo, existing: false, project: "fixture" });
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("Work in "), `this is a worker's brief, not the assistant's turn:\n${body}`);

  assert.match(body, /^CONTAINERS - /m, "the paragraph is in the brief");
  const tree = labelTree(job.worktreePath || job.cwd);
  assert.ok(tree, "the run has a tree");
  assert.ok(body.includes(`--label wag.worktree=${tree} `), `the brief names THIS tree's label value:\n${body}`);
  assert.match(body, /--label wag\.row=/);
  assert.match(body, /docker run -d --rm/, "the --rm requirement is stated with the flag a worker types");
  assert.match(body, /`labels:` block/, "a compose service carries the same labels");
  assert.match(body, /refuses to close your row while one is still running/, "the close gate is stated, so the reason is written for it");
});
