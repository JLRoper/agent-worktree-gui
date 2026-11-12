// The TERMINAL paragraph - the half of "do not poll a build inside a call" that reaches the WORKER.
//
// The report (docs/reports/terminal-call-latency-2026-11-11.html) measured one 152.2 s terminal call and found
// that its time was a sleep-poll loop sitting on a Jenkins build, not the shell, the commands or the pre-execution
// guard. A rule nobody tells the model is one it will not follow, so this file pins the paragraph against:
//
//   1. a tree run carries it, with the bounded-request rule, the two measured `bash -lc` numbers, the 8 to 10 s
//      timeouts, the guard left alone and the host's DNS failures named;
//   2. the assistant's own turn (anchorCwd: false) does not, because it runs no commands in a tree;
//   3. the project runbook carries the same rules, because a worker reads its runbook as well as its brief.
//
// The body is read off a stub Runs API that records what was POSTed - "what the worker reads" is the claim, not
// what the constant says.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs, TERMINAL_BRIEF } from "../lib/jobs.js";
import { configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test.
const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-terminal-home-"));
process.env.API_SERVER_KEY = "";

const git = (dir, args) => runGit(dir, args);

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-terminal-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# terminal brief sandbox\n");
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

// The smallest gateway that accepts a run and records its body (the shape test/testing-brief.test.js uses).
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

test("a worker is told how to spend one terminal call, with the measured numbers", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-terminal-jobs-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  const job = await jobs.create({ prompt: "run a build without sitting on it", cwd: repo, existing: false, project: "fixture" });
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("Work in "), `this is a worker's brief, not the assistant's turn:\n${body}`);

  assert.match(body, /TERMINAL CALLS - how to run a command/, "the paragraph is in the brief");
  assert.match(body, /Never poll a build inside one terminal call/, "the poll loop is forbidden");
  assert.match(body, /ONE bounded request per call - `curl -m 8`/, "the bounded request names curl -m 8");
  assert.match(body, /re-check on the next turn or hand the wait to a background process or the panel's watcher/, "the wait has a home other than the call");
  assert.match(body, /`bash -lc` when the binary can be run directly/, "the login-shell wrapper is forbidden");
  assert.match(body, /1,616 ms on this host against 115 ms/, "the measured login-shell number is quoted");
  assert.match(body, /`--request-timeout 8` to `10` s on kubectl and `-m 8` to `10` on curl/, "both timeouts are bounded at 8 to 10");
  assert.match(body, /not 30 to 60/, "the old 30 to 60 window is named as wrong");
  assert.match(body, /Leave the pre-execution guard alone/, "the guard is out of scope");
  assert.match(body, /sub-millisecond per call/, "the guard's steady state is named");
  assert.match(body, /30 s is a fail-closed ceiling, not a cost/, "the 30 s is a ceiling, not a cost");
  assert.match(body, /jenkins\.prog\.sefl\.com/, "the Jenkins DNS failure is named");
  assert.match(body, /cscvk3smgmt\.prog\.sefl\.com/, "the k3s DEV DNS failure is named");
  assert.match(body, /no such host/, "the resolver error the worker will see is quoted");

  // The constant itself carries the same numbers, so a hook that reuses it cannot drop them silently.
  assert.match(TERMINAL_BRIEF, /1,616 ms/);
  assert.match(TERMINAL_BRIEF, /115 ms/);
  assert.match(TERMINAL_BRIEF, /152\.2 s/);
});

test("the assistant's own turn is not briefed about terminal calls it has no tree for", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-terminal-assistant-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir);
  });

  await jobs.create({ prompt: "read the board", cwd: dir, anchorCwd: false });
  const body = stub.last();
  assert.equal(body.includes("TERMINAL CALLS"), false, `an assistant turn has no tree to run commands in:\n${body}`);
});

test("the project runbook carries the same terminal-call rules", () => {
  // A worker reads its project's runbook as well as its brief. The rules have to live in both or the runbook is
  // the place a worker trusts that still says "poll the build until it finishes".
  const runbook = readFileSync(path.join(ROOT, "docs", "runbooks", "email-multi.md"), "utf8");
  assert.match(runbook, /Never poll a build inside one terminal call/);
  assert.match(runbook, /`curl -m 8`/);
  assert.match(runbook, /1,616 ms on this host against 115 ms/);
  assert.match(runbook, /`--request-timeout 8` to `10` s on kubectl and `-m 8` to `10` on curl/);
  assert.match(runbook, /Leave the pre-execution guard alone/);
  assert.match(runbook, /jenkins\.prog\.sefl\.com/);
  assert.match(runbook, /cscvk3smgmt\.prog\.sefl\.com/);

  const shape = readFileSync(path.join(ROOT, "docs", "runbooks", "README.md"), "utf8");
  assert.match(shape, /terminal-call rules/, "the runbook shape tells the next author to carry them");
  assert.match(shape, /TERMINAL_BRIEF/, "and names the brief paragraph as the other copy");
});
