// The SHOWING A PAGE paragraph - the instruction that was missing, and the habit that filled it.
//
// The panel's brief said nothing about how to put a page in front of the reader, so an agent asked to "prove" a page
// reached for the browser it knew: a scratch profile and `--new-window`, one fresh Edge window per proof. The panel
// already owns the honest opener (POST /api/open-file, POST /api/open-url, lib/open-url.js) and now remembers a file
// it opened for five minutes, so this paragraph is the other half: it tells the worker where the page goes. This file
// pins it against:
//
//   1. a tree run carries it - the panel's own open route, no `--new-window`, never a scratch `--user-data-dir`, and
//      the rule that a scratch browser does not outlive the run;
//   2. the assistant's own turn (anchorCwd: false) does not, because it has no tree to prove anything in;
//   3. the project runbook carries the same rule, because a worker reads its runbook as well as its brief.
//
// The body is read off a stub Runs API that records what was POSTed - "what the worker reads" is the claim, not what
// the constant says.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs, PAGE_BRIEF } from "../lib/jobs.js";
import { configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test.
const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-page-home-"));
process.env.API_SERVER_KEY = "";

const git = (dir, args) => runGit(dir, args);

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-page-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# page brief sandbox\n");
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

test("a worker is told how to show a page, and that a second window is the defect", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-page-jobs-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  const job = await jobs.create({ prompt: "prove the report page", cwd: repo, existing: false, project: "fixture" });
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("Work in "), `this is a worker's brief, not the assistant's turn:\n${body}`);

  assert.match(body, /SHOWING A PAGE/, "the paragraph is in the brief");
  assert.match(body, /proved by a test or a headless capture, never by a browser window thrown at the reader/, "a page is proved by a test, not a window");
  assert.match(body, /POST \/api\/open-file/, "the panel's own open route is named");
  assert.match(body, /POST \/api\/open-url/, "and the route for an http(s) page");
  assert.match(body, /do not launch a browser yourself/, "the worker is told not to launch one");
  assert.match(body, /PLAIN TAB/, "if it does open one, it is a plain tab");
  assert.match(body, /no `--new-window`/, "the flag that made the duplicates is forbidden by name");
  assert.match(body, /never your own `--user-data-dir`/, "and a scratch profile of its own");
  assert.match(body, /must never outlive the run that started it/, "nothing is left running after a settle");
  assert.match(body, /close it before you settle, or reuse the one you already have/, "with the two ways to obey it");

  // The constant itself carries the same words, so a hook that reuses it cannot drop them silently.
  assert.match(PAGE_BRIEF, /--new-window/);
  assert.match(PAGE_BRIEF, /--user-data-dir/);
  assert.match(PAGE_BRIEF, /reused/);
});

test("the assistant's own turn is not briefed about pages it has no tree to prove", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-page-assistant-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir);
  });

  await jobs.create({ prompt: "read the board", cwd: dir, anchorCwd: false });
  const body = stub.last();
  assert.equal(body.includes("SHOWING A PAGE"), false, `an assistant turn has no tree to prove a page in:\n${body}`);
});

test("the project runbook carries the same page rule", () => {
  // A worker reads its project's runbook as well as its brief. The rule has to live in both, or the runbook is the
  // place a worker trusts that still says "open it in your browser".
  const runbook = readFileSync(path.join(ROOT, "docs", "runbooks", "email-multi.md"), "utf8");
  assert.match(runbook, /Showing the reader a page/);
  assert.match(runbook, /proved by a test or a headless capture/);
  assert.match(runbook, /POST \/api\/open-file/);
  assert.match(runbook, /No `--new-window`, and never a scratch `--user-data-dir`/);
  assert.match(runbook, /closed before the run settles, or reused/);
  // …and the guide that tells the next runbook author what to carry names it too.
  const guide = readFileSync(path.join(ROOT, "docs", "runbooks", "README.md"), "utf8");
  assert.match(guide, /the page rule/);
  assert.match(guide, /`PAGE_BRIEF`/);
});
