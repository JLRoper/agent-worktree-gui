// The TESTING paragraph - the half of "focused testing is the default" that reaches the WORKER.
//
// A command nobody told the model about is one it will not run, so the brief has to say it: run the focused set while
// you work, save the full suite for ONE final sweep before the pull request. This file pins the paragraph against
// four claims:
//
//   1. a tree whose package.json carries `test:changed` and `test:module` is handed the paragraph, it names both
//      commands and `npm test`, and the focused instruction comes BEFORE the final sweep (the order is the rule);
//   2. a tree whose package.json does not carry them is handed nothing: the panel starts workers in projects that
//      are not this one, and a brief naming a command the tree lacks is a lie;
//   3. the assistant's own turn (`anchorCwd: false`) is not briefed to run a suite: it has no tree;
//   4. the paragraph sits beside the TODO and DELIVER blocks, not inside them.
//
// The body is read off a stub Runs API that records what was POSTed - "what the worker reads" is the claim, not what
// the constant says.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs, TESTING_BRIEF } from "../lib/jobs.js";
import { configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test.
const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-testing-home-"));
process.env.API_SERVER_KEY = "";

const git = (dir, args) => runGit(dir, args);
const commit = (dir, message = "work") => git(dir, ["commit", "-q", "--allow-empty", "-m", message]);

const SCRIPTS = {
  test: "node --test --test-concurrency=4 test/*.test.js",
  "test:changed": "node tools/test-changed.mjs",
  "test:module": "node tools/test-module.mjs",
};

function makeRepo(scripts = SCRIPTS) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-testing-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# testing brief sandbox\n");
  // The gate reads the tree's OWN package.json, so the fixture has to carry one - and it is committed, because the
  // worker runs in a worktree cut from HEAD.
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts }, null, 1));
  git(dir, ["add", "-A"]);
  commit(dir, "first");
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

// The smallest gateway that accepts a run and records its body (the shape test/deliverables-brief.test.js uses).
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

test("a worker is told to run the focused set while it works and the suite once before the PR", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-testing-jobs-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  const job = await jobs.create({ prompt: "make focused testing the default", cwd: repo, existing: false, project: "fixture" });
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("Work in "), `this is a worker's brief, not the assistant's turn:\n${body}`);

  assert.match(body, /TESTING - the full suite is one node process per test file/, "the paragraph is in the brief");
  assert.match(body, /While you work, run the focused set: `npm run test:changed`/, "the focused command is named");
  assert.match(body, /`npm run test:module lib\/the-file\.js`/, "the one-file command is named with its argument");
  assert.match(body, /`npm test`, once/, "the full suite is named as a one-time sweep");
  assert.match(body, /ONE final sweep before the pull request/, "and it is placed before the PR, not during the work");

  // The ORDER is the instruction: focused first, the sweep last. A brief that named them in the other order would be
  // telling the worker to run the whole suite first, which is the cost this paragraph exists to remove.
  const focused = body.indexOf("While you work, run the focused set");
  const sweepAt = body.indexOf("ONE final sweep before the pull request");
  assert.ok(focused > -1 && sweepAt > focused, "the focused set comes before the final sweep");

  // …and it rides beside the other paragraphs, not inside one: the TODO block's own text carries no TESTING line.
  assert.doesNotMatch(TESTING_BRIEF, /^TODO\b/m);
});

test("a tree whose package.json lacks the commands is not briefed about them", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo({ test: "node --test" });
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-testing-noscripts-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  await jobs.create({ prompt: "work in a tree that cannot run them", cwd: repo, existing: false, project: "fixture" });
  const body = stub.last();
  assert.ok(body.includes("Work in "), "this really is a worker's brief");
  assert.doesNotMatch(body, /TESTING - the full suite/, `a project without the scripts hears nothing:\n${body}`);
  assert.doesNotMatch(body, /npm run test:changed/, "and no command it cannot run is named");
});

test("the assistant's own turn is not briefed to run a suite it has no tree for", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-testing-assistant-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir);
  });

  await jobs.create({ prompt: "read the board", cwd: dir, anchorCwd: false });
  const body = stub.last();
  assert.equal(body.includes("TESTING - the full suite"), false, `an assistant turn has no tree to test:\n${body}`);
});

test("the paragraph names commands this repo's package.json actually ships", () => {
  // A paragraph that names a command nobody ships is worse than none, so the two are held together: the scripts this
  // repo's package.json declares are the ones the brief tells a worker to run.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(typeof pkg.scripts?.["test:changed"], "string", "package.json has test:changed");
  assert.equal(typeof pkg.scripts?.["test:module"], "string", "package.json has test:module");
  assert.equal(typeof pkg.scripts?.test, "string", "package.json has test");
  assert.match(TESTING_BRIEF, /npm run test:changed/);
  assert.match(TESTING_BRIEF, /npm run test:module/);
  assert.match(TESTING_BRIEF, /`npm test`/);
});
