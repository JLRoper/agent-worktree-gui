// The DELIVER paragraph — the half of the hand-back feature that reaches the WORKER.
//
// The button and its list shipped without it (PR #319), so the marker lived in a tooltip and in the empty state and
// nowhere a run reads: a worker that wrote a report and said so in prose left the reader with nothing to open, and a
// row marked done with no deliverable read as finished. This file pins the paragraph against three claims:
//
//   1. the brief the panel POSTs carries the marker line, the definition of a deliverable, the "one line in your
//      FINAL message" instruction and the "a finished row with no deliverable is an incomplete row" rule;
//   2. NO line of the paragraph starts with `DELIVER` — a model that echoes what it was just told must not produce a
//      refused marker (`docs/plan/deliverables-handback-review.md` M4), so the grammar is printed after `syntax:` and
//      the one example is a real path;
//   3. it rides a brief whose TODO list has no items too: it is appended beside the TODO block, not inside it, and a
//      Jobs with no TodoLists store at all still hands it over.
//
// The body is read off a stub Runs API that records what was POSTed — "what the worker reads" is the claim, not what
// the constant says.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DELIVER_BRIEF, Jobs } from "../lib/jobs.js";
import { todoBlock } from "../lib/todos.js";
import { configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-deliver-home-"));
process.env.API_SERVER_KEY = "";

const git = (dir, args) => runGit(dir, args);
const commit = (dir, message = "work") => git(dir, ["commit", "-q", "--allow-empty", "-m", message]);

function makeRepo(branch = "main") {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-deliver-repo-"));
  git(dir, ["init", "-q", "-b", branch]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# deliver brief sandbox\n");
  git(dir, ["add", "."]);
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

// The smallest gateway that accepts a run and records its body (the shape test/brief-follows-the-policy.test.js uses).
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

// No `todos` store on purpose: this is the tree with nothing written down, which is the case the paragraph must
// survive. `dispose` clears the run's timers so the suite exits.
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

test("a built brief carries the marker, the definition and the incomplete-row rule", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo("main");
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-deliver-jobs-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  const job = await jobs.create({ prompt: "write the report", cwd: repo, existing: false, project: "fixture" });
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("Work in "), `this is a worker's brief, not the assistant's turn:\n${body}`);

  assert.ok(body.includes("DELIVER <link|file|image> <target> | <title>"), `the marker line is in the brief:\n${body}`);
  assert.match(body, /a deliverable is a file or URL the reader can open, not a description of one/, "the definition is stated");
  assert.match(body, /declare it with that one line in your FINAL message/, "the line goes in the final message");
  assert.match(body, /A finished row with no deliverable is an incomplete row/, "and a done row with nothing to open is not done");
  assert.match(body, /example: DELIVER file \S+report\.html \| The HTML report/, "the brief shows a real target, not a placeholder");
});

test("no line of the paragraph is itself a DELIVER marker (a model may echo it verbatim)", () => {
  const lines = DELIVER_BRIEF.split("\n");
  assert.ok(lines.length > 3, "the paragraph is more than the marker line");
  for (const line of lines) {
    assert.doesNotMatch(line.trim(), /^DELIVER\b/i, `a line that starts with DELIVER would be harvested as a delivery: ${line}`);
  }
  // …and the marker itself is still there, because it is the whole point of the paragraph.
  assert.match(DELIVER_BRIEF, /DELIVER <link\|file\|image> <target> \| <title>/);
  assert.match(DELIVER_BRIEF, /a deliverable is a file or URL the reader can open, not a description of one/);
});

test("a brief with no TODO items still carries the paragraph — it is not part of the list", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo("main");
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-deliver-notodo-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  // The list the brief carries is the EMPTY form — nothing written down for this tree yet, and no store behind it.
  await jobs.create({ prompt: "write the report", cwd: repo, existing: false, project: "fixture" });
  const body = stub.last();
  assert.match(body, /nothing has been written down for this tree yet/, "this brief really has no TODO items");
  assert.match(body, /A finished row with no deliverable is an incomplete row/, `the paragraph rides regardless:\n${body}`);

  // Structurally: the TODO block's own text has no marker in it, so the paragraph cannot be surviving as a member of
  // the list — it is appended beside it.
  const empty = todoBlock([], { where: repo });
  assert.doesNotMatch(empty, /DELIVER/, "the TODO block carries no deliverable paragraph of its own");
});

test("a turn with no directory is not handed a paragraph about a file the reader opens", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-deliver-nocwd-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir);
  });

  // `anchorCwd: false` is the panel's own assistant turn: no tree, no list, and no paragraph that presumes either.
  await jobs.create({ prompt: "read the board", cwd: dir, anchorCwd: false });
  const body = stub.last();
  assert.equal(body.includes("DELIVERABLES — a deliverable is a file or URL the reader can open"), false, `an assistant turn is not briefed for a tree:\n${body}`);
});
