// A SPAWN that CARRIES A QUEUE ROW cuts a tree that may push; a tree cut by hand, or by a SPAWN that names no row,
// stays local only until a person lifts it.
//
// The mechanism is the one a person's lift already uses (`POST /api/worktree/kind-lift`): the branch-kind record reads
// `kind: "research"` with `lifted: true`, and lib/push-permissions.js `treeKindRefusal` then answers null, so the push
// meets the ordinary controls instead of the research refusal. What is new here is WHEN it is written - at the cut,
// for a SPAWN line that named a task id - and WHY it is written: `preLiftedBy: "row <id>"` names the row, so a later
// reader can tell a panel pre-lift from a person's lift (which writes no preLiftedBy).
//
// Three cases, and they are the three the rule has:
//
//   1. a SPAWN carrying a row: record `research` + `lifted: true` + `preLiftedBy: "row N"`, `made.localOnly` false,
//      the guard installed with the ordinary controls (not marked "started to land"), and the worker still handed the
//      parent's own LANDING paragraph;
//   2. a SPAWN naming no row: exactly what it was - `research` and unlifted, no preLiftedBy;
//   3. a tree cut by hand (no SPAWN at all): `research` and unlifted, and a person's lift later writes `lifted` with
//      no preLiftedBy.
//
// A fourth pins the boundary: a row SPAWN cut from a TURNOVER branch is a turnover child, which is not local only and
// is never lifted - the row changes nothing about the kind.
//
// Driven through the REAL assistant spawn path (`startSpawn`), the REAL spawner (lib/features/spawn.js
// `assistantSpawnRun`), the REAL `Jobs.create`/`makeWorktree` and a real repository. A stub gateway only accepts the
// run and ends it at once, so no worker is left live in the fixture.
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

const slash = (p) => String(p).replace(/\\/g, "/");
const email = ["tester", "example.invalid"].join(String.fromCharCode(64));
const TURNOVER = "20261121_1200_ROPER-186_demo";

// A repo parked on `main`, with one commit, and (when asked) a turnover branch one commit ahead of it.
function repo(dir, { turnover = false } = {}) {
  const at = slash(path.join(dir, "demo"));
  execFileSync("git", ["init", "-q", "-b", "main", at], { encoding: "utf8" });
  writeFileSync(path.join(at, "README.md"), "seed\n");
  const git = (...args) =>
    execFileSync("git", ["-C", at, "-c", "user.name=Test", "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  if (turnover) {
    git("checkout", "-q", "-b", TURNOVER);
    writeFileSync(path.join(at, "roll-up.md"), "the work that has not landed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "the turnover work");
    git("checkout", "-q", "main");
  }
  return at;
}

// The smallest gateway that ACCEPTS a run and ends it at once: the panel's probe is answered, the run body is
// recorded, and no run is left live.
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

async function panel(t, { turnover = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-spawn-row-lift-"));
  const gw = await stubGateway();
  const project = { name: "demo", path: repo(dir, { turnover }), mainBranch: "main", remote: "origin", remoteBranchPolicy: "ask" };
  const config = {
    jobsFile: path.join(dir, "logs", "jobs.json"),
    apiServer: { url: gw.url, key: "stub" },
    defaultCwd: dir,
    // The project's turnover branch, read per cut the way server.js wires it (lib/project-turnover.js).
    turnoverBranchFor: (name) => (getProjects().find((p) => p.name === name)?.turnoverBranch || ""),
  };
  const getProjects = () => [project];
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  const spawn = createSpawn({ getConfig: () => config, getProjects, jobs, getRows: () => [] });
  const assistant = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "logs", "assistant.json") },
    jobs,
    getProjects,
    getRows: () => [],
    getChildren: () => ({}),
    spawner: spawn.assistantSpawnRun,
    onEvent: () => {},
    onLog: () => {},
  });
  // The guard's own install, spied rather than written: this is the argument the panel's
  // `jobs.afterWorktreeCreate` would hand to installGuardFor, and it is what says whether a tree was started to LAND.
  const guardLandings = [];
  jobs.afterWorktreeCreate = async ({ landing }) => {
    guardLandings.push(Boolean(landing));
    return { ok: true, policy: "ask", newBranches: "ask", existingBranches: "ask", dir: "guard" };
  };
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
  // The branch-kind record, read the way the push rule and the row read it.
  const kindOf = (tree, branch) => jobs.treeKindFor({ tree, branch });
  // The book ON DISK, for the read-back that proves the field survives a restart (lib/jobs.js `loadParents`).
  const book = () => JSON.parse(readFileSync(path.join(dir, "logs", "branch-parents.json"), "utf8"));
  // A queue row for a SPAWN to carry, through the assistant's own queue writer.
  const row = (title = "carry the row") => assistant.queueMutate("assistant-1", "add", { title }).task;
  return { dir, gw, project, jobs, assistant, spawn, guardLandings, kindOf, book, row, getProjects };
}

// ---- 1: a SPAWN carrying a row ---------------------------------------------------------------------------------
test("a SPAWN carrying a queue row cuts a research tree that is already lifted, and names the row", async (t) => {
  const p = await panel(t);
  const task = p.row("carry the row's work");
  const job = await p.assistant.startSpawn({ target: "demo", project: "demo", taskId: task.id, prompt: "carry the row's work" }, { source: "assistant" });
  assert.ok(job?.id, "the cut started a run");
  assert.notEqual(job.status, "failed", `the run was accepted: ${job.error || ""}`);

  // The record the push rule reads: research (the vocabulary did not change) and LIFTED, with the row as the reason.
  const rec = p.kindOf(job.cwd, job.branch);
  assert.ok(rec, `the cut wrote a branch-kind record: ${JSON.stringify(p.book())}`);
  assert.equal(rec.kind, "research", "the kind is still one of the two - no third vocabulary");
  assert.equal(rec.lifted, true, "the cut itself lifted it");
  assert.equal(rec.preLiftedBy, `row ${task.id}`, "and the record says which row pre-lifted it");
  const onDisk = Object.values(p.book()).find((r) => slash(r.tree) === slash(job.cwd));
  assert.equal(onDisk.preLiftedBy, `row ${task.id}`, "the reason is on disk, not only in memory");

  // …and the read-back is loadParents, the same reader a restart goes through.
  const reloaded = [...p.jobs.loadParents().values()].find((r) => slash(r.tree) === slash(job.cwd));
  assert.equal(reloaded.preLiftedBy, `row ${task.id}`, "loadParents reads the row back");
  assert.equal(reloaded.lifted, true);

  // The lift is the RECORD only: the guard is installed with the ordinary controls, not marked "started to land",
  // so the push meets the project's permission box (or policy) rather than a blanket allow.
  assert.deepEqual(p.guardLandings, [false], "a pre-lifted cut is not a run started to land");

  // The worker is still told what the parent's own paragraph says: a cut from main pushes and opens a PR, under this
  // tree's controls - the instruction does not become the blanket "WILL LAND" of the merge flow.
  const brief = p.gw.last();
  assert.match(brief, /cut from `main` - a landing branch/);
  assert.doesNotMatch(brief, /^WILL LAND:/m, "the merge flow's paragraph is not what a row SPAWN gets");
});

// ---- 2: a SPAWN that names no row -------------------------------------------------------------------------------
test("a SPAWN naming no row stays research, local only, and nothing pre-lifts it", async (t) => {
  const p = await panel(t);
  const job = await p.assistant.startSpawn({ target: "demo", project: "demo", prompt: "answer a question about the code" }, { source: "assistant" });
  assert.ok(job?.id);
  const rec = p.kindOf(job.cwd, job.branch);
  assert.ok(rec, "a plain SPAWN still records its kind");
  assert.equal(rec.kind, "research");
  assert.notEqual(rec.lifted, true, "no row, no lift");
  assert.equal(rec.preLiftedBy ?? null, null, "and no row is named as a reason");
  assert.deepEqual(p.guardLandings, [false]);
  const onDisk = Object.values(p.book()).find((r) => slash(r.tree) === slash(job.cwd));
  assert.equal(onDisk.lifted ?? false, false);
  assert.equal(onDisk.preLiftedBy ?? null, null);
});

// ---- 3: a hand cut, and a person's lift -------------------------------------------------------------------------
test("a tree cut by hand stays unlifted, and a person's lift writes no row", async (t) => {
  const p = await panel(t);
  // The panel's own New-agent path: jobs.create with no landing flag and no row.
  const job = await p.jobs.create({ prompt: "cut by hand", cwd: p.project.path, existing: false, project: p.project.name });
  const rec = p.kindOf(job.worktreePath, job.branch);
  assert.ok(rec);
  assert.equal(rec.kind, "research");
  assert.notEqual(rec.lifted, true, "a hand cut is not lifted by anything but a person");

  // The person lifts it through the route's own writer: `lifted` gains true, and no preLiftedBy appears.
  const lifted = await p.jobs.liftKind({ tree: job.worktreePath, branch: job.branch });
  assert.equal(lifted.lifted, true);
  assert.equal(lifted.preLiftedBy ?? null, null, "a person's lift names no row");
  const onDisk = Object.values(p.book()).find((r) => slash(r.tree) === slash(job.worktreePath));
  assert.equal(onDisk.lifted, true);
  assert.equal(onDisk.preLiftedBy ?? null, null);

  // The same rule at the cut itself: `makeWorktree` with `landing: true` and no row lifts the record; with no
  // landing it does not, and `made.localOnly` is the caller's answer.
  const preLifted = await p.jobs.makeWorktree(p.project.path, "a row pre-lifted this", { landing: true, preLiftedBy: "row 7" });
  assert.equal(preLifted.localOnly, false, "a pre-lifted research cut is not local only");
  const preRec = p.kindOf(preLifted.path, preLifted.branch);
  assert.equal(preRec.lifted, true);
  assert.equal(preRec.preLiftedBy, "row 7");
  const plain = await p.jobs.makeWorktree(p.project.path, "nobody lifted this", {});
  assert.equal(plain.localOnly, true, "an ordinary cut is local only");
  const plainRec = p.kindOf(plain.path, plain.branch);
  assert.notEqual(plainRec.lifted, true);
  assert.equal(plainRec.preLiftedBy ?? null, null);
});

// ---- 4: a row on a turnover parent changes nothing about the kind -----------------------------------------------
test("a SPAWN carrying a row from a turnover branch is a turnover child, never lifted", async (t) => {
  const p = await panel(t, { turnover: true });
  p.project.turnoverBranch = TURNOVER;
  const task = p.row("roll the turnover work up");
  const job = await p.assistant.startSpawn({ target: "demo", project: "demo", taskId: task.id, prompt: "roll the turnover work up" }, { source: "assistant" });
  assert.ok(job?.id);
  const rec = p.kindOf(job.cwd, job.branch);
  assert.equal(rec.kind, "turnover", "cut from the project's turnover branch");
  assert.notEqual(rec.lifted, true, "a turnover child is not local only, so there is nothing to lift");
  assert.equal(rec.preLiftedBy ?? null, null);
  assert.deepEqual(p.guardLandings, [false]);
  assert.match(p.gw.last(), /this project's turnover branch/, "and the worker is still told to roll up locally");
});
