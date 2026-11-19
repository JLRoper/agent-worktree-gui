// The INITIATIVES paragraph - the instruction that makes the map behaviour rather than a feature nobody calls.
//
// The two parts of this feature fail differently without a brief: the tier is a setting a worker never reads (and must
// not read, since the panel decides it), and the history is a record of changes a worker never makes. So the worker
// brief every tree run receives carries one paragraph that says: read the map with GET /api/initiatives, attach your
// tree to the initiative that plainly covers it, do not create an initiative yourself - raise a clarify card - and
// send `by` so the history can name you.
//
// This file pins the paragraph against the body actually POSTed to the Runs API, not against the constant:
//
//   1. a tree run carries it exactly once, and it names the tier's answer (202 asked, do not resend) rather than
//      asking the worker to work the tier out;
//   2. it carries the clarify-never-a-silent-write rule in those words, because "ask first" is the sentence a model
//      will otherwise satisfy by writing and mentioning it afterwards;
//   3. the run's own assistant id is written into it, so `by` is not guessed;
//   4. the assistant's own turn (anchorCwd: false) does not carry it, for the same reason it carries no git rule: it
//      works in no tree and produces no attachment.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WORKTREE_BRIEF, Jobs, worktreeBriefFor } from "../lib/jobs.js";
import { configureRepo, git as runGit } from "../tools/panel-testkit.mjs";

// Off this box's own Hermes install: a run body is what is under test.
process.env.HERMES_HOME = mkdtempSync(path.join(tmpdir(), "wtgui-worktreebrief-home-"));
process.env.API_SERVER_KEY = "";

const HEADING = "INITIATIVES - the board keeps a map of the big pieces of work";

const git = (dir, args) => runGit(dir, args);
const countOf = (body, needle) => String(body || "").split(needle).length - 1;

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-worktreebrief-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  configureRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# worktree brief sandbox\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  return dir;
}

const sweep = (...dirs) => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* a background git handle on Windows; OS temp is throwaway */
    }
  }
};

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

test("a tree run is told to read the map, attach where it plainly fits, and ask rather than create", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-worktreebrief-jobs-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  const job = await jobs.create({ prompt: "cut a tree and make the change", cwd: repo, existing: false, project: "fixture", assistantId: "scout" });
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);
  const body = stub.last();
  assert.ok(body.includes("Work in "), `this is a worker's brief, not the assistant's turn:\n${body}`);

  assert.equal(countOf(body, HEADING), 1, `the paragraph rides this turn exactly once:\n${body}`);
  assert.match(body, /look at that map before you end your turn/, "the paragraph is in the brief");
  assert.match(body, /GET \/api\/initiatives/, "it names the read");
  assert.match(body, /POST \/api\/initiatives\/move with \{tree, initiative, action: "add"/, "it names the attach");
  assert.match(body, /a 202 means the question is in the dock and you must NOT send it again/, "the tier's answer is the panel's, not the worker's");
  assert.match(body, /raise a clarify card naming the tree and the initiative you would create/, "a missing initiative is a card");
  assert.match(body, /A card is a question the reader can answer; writing the map yourself is a silent decision nobody asked for\./, "the clarify-never-a-silent-write rule, in those words");
  assert.match(body, /This run's assistant id is "scout" - send exactly that as by\./, "the actor is written in, not guessed");
  assert.match(body, /recorded in the initiative's history with its time, at every tier/, "the record is described");

  // The constant is what a hook reuses, so it has to carry the same rules.
  assert.equal(countOf(WORKTREE_BRIEF, HEADING), 1);
  assert.match(WORKTREE_BRIEF, /Never edit initiatives\.json by hand/);
});

test("a run with no assistant id is told to send `agent`, never `reader`", async (t) => {
  const stub = await stubGateway();
  const repo = makeRepo();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-worktreebrief-noid-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir, repo);
  });

  await jobs.create({ prompt: "cut a tree", cwd: repo, existing: false, project: "fixture" });
  const body = stub.last();
  assert.match(body, /This run carries no assistant id - send by: "agent", never "reader"/);
  assert.equal(body.includes('This run\'s assistant id is'), false, "no id is invented");

  // And the function itself: a blank or whitespace id is the same as none.
  assert.match(worktreeBriefFor({ assistantId: "   " }), /send by: "agent"/);
  assert.match(worktreeBriefFor({ assistantId: " scout " }), /This run's assistant id is "scout"/);
});

test("the assistant's own turn carries no initiative rule it has no tree for", async (t) => {
  const stub = await stubGateway();
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-worktreebrief-assistant-"));
  const jobs = makeJobs(dir, stub.url);
  t.after(async () => {
    jobs.dispose();
    await stub.stop();
    sweep(dir);
  });

  await jobs.create({ prompt: "read the board", cwd: dir, anchorCwd: false, assistantId: "scout" });
  const body = stub.last();
  assert.equal(countOf(body, HEADING), 0, `an assistant turn cuts no tree and must not carry the paragraph:\n${body}`);
  assert.equal(body.includes("INITIATIVES"), false, "not even the heading");
});
