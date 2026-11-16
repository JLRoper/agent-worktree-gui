// The REPORT CARDS paragraph - a finding worth the reader's time arrives as a report and a card.
//
// The brief taught a worker how to hand over a deliverable (DELIVER_BRIEF) and how to put a link on a question
// (CLARIFY_LINKS_BRIEF), but nothing said that research, a review, an audit or a measurement IS a report. A finding
// therefore arrived as prose in a chat panel: nothing the reader could reopen, search, cite or act on in one place.
// This file pins the paragraph against the claims the brief makes and against the shapes a brief is rendered in:
//
//   1. a tree run carries it exactly once - a self-contained .html under docs/reports/ with the evidence inline and
//      file:line citations, declared on a clarify card as a links entry, the recommended next steps as that card's
//      choices in the order the agent recommends them, and the rule that a report with no card is unread;
//   2. the assistant's own turn (anchorCwd: false) does not carry it: it works in no tree and files no report, and
//      that standard reaches it through its standing rules instead (docs/worker-brief-report-cards.md);
//   3. the brief still RENDERS in the other tree-run modes - a run in an existing tree, and a landing turn - so the
//      paragraph rides the assembled text rather than replacing or breaking it.
//
// The body is read off a stub Runs API that records what was POSTed - "what the worker reads" is the claim, not what
// the constant says.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs, REPORT_BRIEF } from "../lib/jobs.js";
import { configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-reportbrief-home-"));
process.env.API_SERVER_KEY = "";

const HEADING = "REPORT CARDS - a finding worth the reader's time arrives as a report and a card, not as a paragraph in the chat:";

const git = (dir, args) => runGit(dir, args);

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-reportbrief-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# report brief sandbox\n");
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

// The count of a fixed string in the assembled brief. The claim is "exactly once", so the count is a number the test
// compares, not an `includes` that a second copy would pass.
const countOf = (body, needle) => String(body || "").split(needle).length - 1;

// The smallest gateway that accepts a run and records its body (the shape test/git-brief.test.js uses).
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

test("a tree run is handed the report-card paragraph, exactly once", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-reportbrief-jobs-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  const job = await jobs.create({ prompt: "audit the console path", cwd: repo, existing: false, project: "fixture" });
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("Work in "), `this is a worker's brief, not the assistant's turn:\n${body}`);

  assert.equal(countOf(body, HEADING), 1, `the paragraph rides this turn exactly once:\n${body}`);
  assert.match(body, /Research, reviews, audits and measurements are written as a self-contained \.html under `docs\/reports\/`/, "the report is a page under docs/reports/");
  assert.match(body, /with the evidence inline and `file:line` citations/, "the evidence and its citations are inside the page");
  assert.match(body, /Declare the report on a `clarify` card as a `links` entry with an absolute `path` and a label that says what it is/, "the card carries the report as a labelled links entry");
  assert.match(body, /that card's choices, in the order you recommend them/, "the recommended next steps become the choices, in the agent's order");
  assert.match(body, /A report with no card is a report nobody reads/, "a report with no card is called out");

  // The constant carries the same rules, so a hook that reuses it cannot drop them silently.
  assert.equal(countOf(REPORT_BRIEF, HEADING), 1);
  assert.match(REPORT_BRIEF, /A report with no card is a report nobody reads/);
});

test("the assistant's own turn carries no report-card paragraph it has no tree for", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-reportbrief-assistant-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir);
  });

  await jobs.create({ prompt: "read the board", cwd: dir, anchorCwd: false });
  const body = stub.last();
  assert.equal(countOf(body, HEADING), 0, `an assistant turn files no report and must not carry the paragraph:\n${body}`);
  assert.equal(body.includes("REPORT CARDS"), false, "not even the heading");
});

test("the brief still renders in the other tree-run modes, with the paragraph", async (t) => {
  const stub = await stubGateway();
  const made = [];
  t.after(async () => {
    await stub.stop();
    sweep(...made);
  });

  const modes = [
    { label: "a run in an existing tree", opts: { existing: true } },
    { label: "a landing turn", opts: { existing: true, remoteWrite: "land" } },
  ];
  for (const mode of modes) {
    const repo = makeRepo();
    made.push(repo);
    const dir = mkdtempSync(path.join(tmpdir(), "wtgui-reportbrief-mode-"));
    made.push(dir);
    const jobs = makeJobs(dir, stub.url);
    try {
      const job = await jobs.create({ prompt: `audit the console path (${mode.label})`, cwd: repo, project: "fixture", ...mode.opts });
      assert.notEqual(job.status, "failed", `${mode.label} was accepted: ${job.error || ""}`);
      const body = stub.last();
      assert.match(body, /Work in \S+/, `${mode.label} still renders the anchored brief:\n${body}`);
      assert.equal(countOf(body, HEADING), 1, `${mode.label} carries the paragraph exactly once:\n${body}`);
      assert.match(body, /GIT REMOTES - clone and add remotes over SSH/, `${mode.label} still carries the paragraphs beside it`);
      assert.equal(/undefined|\[object Object\]/.test(body), false, `${mode.label} renders no interpolation junk:\n${body}`);
    } finally {
      jobs.dispose();
    }
  }
});
