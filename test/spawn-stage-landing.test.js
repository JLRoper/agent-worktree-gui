// The acceptance test for the landing a PIPELINE STAGE earns, driven through the panel's own doors.
//
// The defect it pins (docs/reviews/ping-pong-round-6-2026-11-08.html, "Every stage worker is told to push and open a
// PR"): `lib/assistant.js` startSpawn passed no remote-write flag, and the LANDING paragraph `lib/branch-policy.js`
// renders was the PARENT's — so a stage writing `ledger/ping-pong/draft.md` was told to push its branch and open a
// pull request, and did: PR #607, a remote write nobody asked for, from a document stage.
//
// The claim here is the worker's own instruction, not the formatter's: the real spawner (lib/features/spawn.js
// `assistantSpawnRun`), the real job store and a spy gateway are used, and the assertions are made against the run
// body the gateway was actually asked to start. Three cases, and they are the three the rule has:
//
//   1. a stage whose artifact is NOT a pull request, started the way `sweepQueues` starts it (`remoteWrite: "local"`),
//      is told to commit on the stage branch and report the commit — and never to push or open a PR;
//   2. a stage whose artifact IS the pull request (`kind: "pr"`) keeps the parent's paragraph: push it, open a PR;
//   3. an ordinary worker, started with no stage at all, is unchanged (the parent's paragraph, as before).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { createSpawn } from "../lib/features/spawn.js";
import { Jobs } from "../lib/jobs.js";
import { parseBundle } from "../lib/pipeline-bundle.js";
import { stagePrompt } from "../lib/task-pipeline-drive.js";

const slash = (p) => String(p).replace(/\\/g, "/");
const email = ["tester", "example.invalid"].join(String.fromCharCode(64));

// A repo on `main`, one commit, so a tree can be cut FROM it and `main` recorded as the parent.
function repo(dir) {
  const at = slash(path.join(dir, "project"));
  execFileSync("git", ["init", "-q", "-b", "main", at], { encoding: "utf8" });
  writeFileSync(path.join(at, "README.md"), "seed\n");
  const git = (...args) =>
    execFileSync("git", ["-C", at, "-c", "user.name=Test", "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return at;
}

// The smallest gateway that ACCEPTS a run, records its body and ends it at once: no run is left live, so the next
// start in the same tree is not a second worker.
async function stubGateway() {
  const posts = [];
  const server = createServer((req, res) => {
    const url = String(req.url || "");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const json = (code, out) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      if (req.method === "GET" && url === "/v1/capabilities") {
        return json(200, { version: "stub", features: { run_submission: true, run_events_sse: true, run_stop: true } });
      }
      if (req.method === "POST" && url === "/v1/runs") {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
        posts.push(body);
        return json(200, { run_id: `run_${posts.length}`, session_id: String(body.session_id || "") });
      }
      if (req.method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url)) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write(`event: run.completed\ndata: ${JSON.stringify({ event: "run.completed", output: "done", exit_code: 0 })}\n\n`);
        return res.end();
      }
      if (req.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(url)) return json(200, { status: "completed", output: "done" });
      if (req.method === "POST") return json(200, {});
      json(404, { error: { message: "no such route" } });
    });
  });
  await new Promise((open) => server.listen(0, "127.0.0.1", open));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    posts,
    last: () => String(posts[posts.length - 1]?.input || ""),
    close: () => new Promise((done) => (server.closeAllConnections?.(), server.close(done))),
  };
}

// The seed's own ping-pong document: the pipeline whose two stages are documents, and the one PR #607 came from.
const BUNDLE = parseBundle(JSON.parse(readFileSync(new URL("../pipeline-bundle.seed.json", import.meta.url), "utf8")), { file: "seed" });
const PING_PONG = BUNDLE.bundle.pipelines.find((pipeline) => pipeline.id === "ping-pong");

async function panel(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-stage-landing-"));
  const project = { name: "agent-worktree-gui", path: repo(dir), remote: "github", mainBranch: "main", remoteBranchPolicy: "allow" };
  const gw = await stubGateway();
  const config = { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: gw.url, key: "stub" }, defaultCwd: dir };
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  const spawn = createSpawn({ getConfig: () => config, getProjects: () => [project], jobs });
  const assistant = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "assistant.json") },
    jobs,
    getProjects: () => [project],
    getRows: () => [],
    spawner: spawn.assistantSpawnRun,
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(async () => {
    for (const j of jobs.jobs.values()) {
      j.ctrl?.abort();
      for (const timer of [j.timer, j.poller, j.textTimer, j.statsTimer]) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    }
    for (const timer of ["wakeTimer", "settleTimer", "timer", "persistTimer"]) if (assistant[timer]) clearTimeout(assistant[timer]);
    await gw.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  // The tree a stage runs in, cut the way the panel cuts one: from the checkout's own branch, which is `main`, so the
  // parent's paragraph WOULD say "push it and open a pull request" for anything that gets it.
  const cutTree = async (prompt) => {
    const job = await jobs.create({ prompt, cwd: project.path, existing: false, project: project.name, branchPolicy: "allow", remote: "github" });
    return { path: job.worktreePath, branch: job.branch || null };
  };
  const stageOf = (id) => PING_PONG.stages.find((stage) => stage.id === id);
  const promptFor = (stage, tree, visit = 1) =>
    stagePrompt(
      { id: 4, title: "draft and critique" },
      PING_PONG,
      stage,
      { run: { pipeline: "ping-pong", stage: stage.id, enteredAt: "2026-11-08T22:49:15.901Z", visits: { [stage.id]: visit } }, tree, facts: { head: "9f3c1a2", dirty: 0 } },
    );
  return { dir, project, gw, jobs, assistant, cutTree, stageOf, promptFor };
}

test("a document stage is started local-only: commit and report, no push and no PR", async (t) => {
  const p = await panel(t);
  const tree = await p.cutTree("cut the ping-pong tree");
  const draft = p.stageOf("draft");
  const prompt = p.promptFor(draft, tree);
  assert.match(prompt, /Do stage|Write the draft|draft/i, "the stage prompt is the document's own instruction");

  // Exactly the spec `sweepQueues` builds for a non-`pr` stage: the driver's `remoteWrite: "local"`, carried through
  // `startSpawn` to the spawner and into the run body.
  const job = await p.assistant.startSpawn(
    { target: tree.path, existing: true, project: p.project.name, prompt, remoteWrite: "local", branch: tree.branch },
    { source: "pipeline" },
  );
  assert.equal(job?.status !== "failed", true, `the run was accepted: ${job?.error || ""}`);
  const body = p.gw.last();
  assert.match(body, /LANDING: this worktree/, `the worker is handed a landing paragraph:\n${body}`);
  assert.match(body, /This stage's artifact is not a pull request, so this tree is local-only/, "the paragraph is the STAGE's case, not the parent's");
  assert.match(body, /commit on `[^`]+` and report the commit/, "it is told to commit on the stage branch and report the commit");
  assert.doesNotMatch(body, /gh pr create/, "no pull request is asked for");
  assert.doesNotMatch(body, /push it and open a pull request/, "and no push is asked for");
  assert.doesNotMatch(body, /cut from `main`/, "the parent's case is not rendered at all");
});

test("a pr stage keeps its push and PR, and an ordinary worker is untouched", async (t) => {
  const p = await panel(t);
  const tree = await p.cutTree("cut the landing tree");
  const critique = p.stageOf("critique");

  // The driver's word for a stage whose artifact is the pull request.
  await p.assistant.startSpawn(
    { target: tree.path, existing: true, project: p.project.name, prompt: p.promptFor(critique, tree), remoteWrite: "pr", branch: tree.branch },
    { source: "pipeline" },
  );
  const prBody = p.gw.last();
  assert.match(prBody, /cut from `main`/, `a pr stage is still handed the parent's paragraph:\n${prBody}`);
  assert.match(prBody, /push it and open a pull request/);
  assert.match(prBody, /gh pr create --fill/);
  assert.doesNotMatch(prBody, /is not a pull request/, "and never the local-only stage paragraph");

  // An ordinary worker — no stage, no flag — is the same parent's paragraph every worker had before this change.
  const other = await p.cutTree("cut an ordinary tree");
  await p.assistant.startSpawn({ target: other.path, existing: true, project: p.project.name, prompt: "fix the failing test", branch: other.branch }, { source: "assistant" });
  const plain = p.gw.last();
  assert.match(plain, /cut from `main`/, `an ordinary worker is unchanged:\n${plain}`);
  assert.match(plain, /push it and open a pull request/);
  assert.doesNotMatch(plain, /is not a pull request/);
});
