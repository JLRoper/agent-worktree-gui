// The GIT REMOTES paragraph - ssh for every clone and every remote a worker adds.
//
// The one text every tree run receives is the worker brief assembled in lib/jobs.js. A worker that clones over https
// is asked for a password no headless run has, or puts a token in a URL that `git remote -v` then prints forever. A
// rule nobody tells the model is one it will not follow, so this file pins the paragraph against:
//
//   1. a tree run carries it, with both ssh forms and the `git remote set-url` step for an https origin;
//   2. the assistant's own turn (anchorCwd: false) does not, because it works in no tree and fetches nothing;
//   3. it appears EXACTLY ONCE - the brief is on every worker turn forever, and a second copy is paid for twice.
//
// The body is read off a stub Runs API that records what was POSTed - "what the worker reads" is the claim, not
// what the constant says.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GIT_BRIEF, Jobs } from "../lib/jobs.js";
import { configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-gitbrief-home-"));
process.env.API_SERVER_KEY = "";

const HEADING = "GIT REMOTES - clone and add remotes over SSH, never https:";

const git = (dir, args) => runGit(dir, args);

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-gitbrief-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# git brief sandbox\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  return dir;
}

const sweep = (...dirs) => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* background measureTree git handle on Windows; OS temp is throwaway */
    }
  }
};

// The count of a fixed string in the assembled brief. The claim is "exactly once", so the count is a number the
// test compares, not a `includes` that a second copy would pass.
const countOf = (body, needle) => String(body || "").split(needle).length - 1;

// The smallest gateway that accepts a run and records its body (the shape test/terminal-brief.test.js uses).
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
    submitted,
    last: () => String(submitted[submitted.length - 1]?.input || ""),
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function makeJobs(dir, url) {
  const jobs = new Jobs({
    config: { apiServer: { url }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 3600 },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.dispose = () => {
    for (const j of jobs.jobs.values()) {
      clearTimeout(j.timer);
      clearTimeout(j.persistTimer);
      clearInterval(j.poller);
      clearInterval(j.statsTimer);
      try {
        j.ctrl?.abort();
      } catch {
        /* an aborted stream is the point */
      }
    }
    clearTimeout(jobs.persistTimer);
  };
  return jobs;
}

test("a tree run is told to clone and fetch over ssh, exactly once", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-gitbrief-jobs-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  const job = await jobs.create({ prompt: "clone the service and fetch its tests", cwd: repo, existing: false, project: "fixture" });
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("Work in "), `this is a worker's brief, not the assistant's turn:\n${body}`);

  assert.equal(countOf(body, HEADING), 1, `the paragraph rides this turn exactly once:\n${body}`);
  assert.match(body, /GIT REMOTES - clone and add remotes over SSH, never https:/, "the paragraph is in the brief");
  assert.match(body, /any remote this run adds, uses an ssh URL/, "a remote the run adds is ssh too");
  assert.match(body, /`git@host:path` or `ssh:\/\/`/, "both ssh forms are named");
  assert.match(body, /never an `https:\/\/` one/, "the https form is forbidden");
  assert.match(body, /`git remote set-url origin git@host:path` BEFORE fetching/, "an https origin is switched before the fetch");

  // The constant carries the same rules, so a hook that reuses it cannot drop them silently.
  assert.equal(countOf(GIT_BRIEF, HEADING), 1);
  assert.match(GIT_BRIEF, /git remote set-url/);
});

test("the assistant's own turn carries no git-remote rule it has no tree for", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-gitbrief-assistant-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir);
  });

  await jobs.create({ prompt: "read the board", cwd: dir, anchorCwd: false });
  const body = stub.last();
  assert.equal(countOf(body, HEADING), 0, `an assistant turn clones nothing and must not carry the paragraph:\n${body}`);
  assert.equal(body.includes("GIT REMOTES"), false, "not even the heading");
});
