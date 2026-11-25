// The worktree REUSE POLICY (queue row 323): three cases, and only two of them are reuse. One test per case, plus the
// one the reader hit.
//
//   1. DISRUPTION RECOVERY - a new agent may go into the SAME tree once the old run resolves DEAD through the runs
//      API, and is refused while that run is live. The brief the new agent is handed says work already exists in the
//      tree from a previous run and must be read before anything is overwritten, and no clean tree is asked for.
//   2. STAGE PING-PONG - a coder and a reviewer hold TWO trees on one lineage. The reviewer's round is a per-round
//      REVIEW BRANCH cut from the coder's branch and anchored on the SHA it was cut from, and neither tree is told it
//      is the other.
//   3. NOT REUSE - a landed or finished tree handed to an unrelated new row. Refused by name when the line carries a
//      row, warned by name when it does not, and the fresh cut a row gets says it inherits no attachment.
//
// The runs API is a stub server: `GET /v1/runs/<id>` answers from the map each test fills, so the DEAD verdict is the
// API's own answer here and not the job store's word. Everything else (the cut, the queue, the brief) is the real
// code path the panel runs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs } from "../lib/jobs.js";
import { Assistant } from "../lib/assistant.js";
import { createSpawn } from "../lib/features/spawn.js";
import { landedTreeCut, priorWorkBrief, reissueRefusal, reviewRoundName, reviewRoundOf, runVerdict, sameBranchRefusal, stagePair, stagePairFor } from "../lib/reuse-policy.js";
import { reuseDecision } from "../lib/spawn-reuse.js";
import { SPAWN_CHECK_PATH, createSpawnCheckRoutes } from "../routes/assistant-spawn-check.js";

const slash = (p) => String(p).replace(/\\/g, "/");
const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// The identity git needs to commit in a fresh sandbox. Built from parts so no literal address sits in this file.
const testUser = ["reuse", "sandbox.test"].join("@");

function makeRepo(dir) {
  const repo = slash(path.join(dir, "repo"));
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "pipe"] });
  git(repo, ["config", "user.email", testUser]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repo, "README.md"), "# reuse sandbox\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "first"]);
  return repo;
}

// One git worktree on its own branch, inside the temp repo. `from` is a branch the repo already has.
function treeOf(repo, name, branch, from = "main") {
  const at = slash(path.join(repo, ".worktrees", name));
  git(repo, ["worktree", "add", "-q", "-b", branch, at, from]);
  return at;
}

// The smallest gateway that accepts a run and answers GET /v1/runs/<id> from `runs`. `runs` is a Map of run id to
// status, or to the string "404" for a run the gateway has forgotten.
async function stubGateway() {
  const submitted = [];
  const runs = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ version: "stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, model_options: true } }));
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const id = decodeURIComponent(one[1]);
      const status = runs.get(id);
      if (!status || status === "404") {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "run_not_found" } }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ run_id: id, status }));
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
    runs,
    last: () => String(submitted[submitted.length - 1]?.input || ""),
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

async function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-reuse-"));
  const stub = await stubGateway();
  const repo = makeRepo(dir);
  const trees = {
    held: treeOf(repo, "held-tree", "wtgui/held-tree-aaaaaa"),
    coder: treeOf(repo, "coder-tree", "wtgui/coder-tree-bbbbbb"),
    reviewer: treeOf(repo, "reviewer-tree", "review/coder-tree-bbbbbb-r1-1a2b3c4"),
    landed: treeOf(repo, "landed-tree", "wtgui/landed-tree-cccccc"),
  };
  const config = { apiServer: { url: stub.url, key: "sandbox-key" }, jobsFile: path.join(dir, "logs", "jobs.json"), defaultCwd: repo, remoteBranchPolicy: "local-only" };
  const project = { name: "proj", path: repo, mainBranch: "main" };
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  const rows = [];
  const assistant = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "assistant.json") },
    jobs,
    getProjects: () => [project],
    getRows: () => rows,
    getChildren: () => ({}),
    onEvent: () => {},
    onLog: () => {},
  });
  assistant.spawner = createSpawn({ getConfig: () => config, getProjects: () => [project], jobs, getRows: () => rows }).assistantSpawnRun;
  t.after(async () => {
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
    for (const timer of ["wakeTimer", "settleTimer", "timer", "persistTimer"]) if (assistant[timer]) clearTimeout(assistant[timer]);
    await stub.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  });
  return { dir, repo, trees, project, jobs, rows, assistant, stub };
}

async function ask(p, { task = "", tree = "", project = "proj", assistantId = "" } = {}) {
  const out = { status: null, body: null };
  const handler = createSpawnCheckRoutes({
    assistant: p.assistant,
    getProjects: () => [p.project],
    config: { token: "secret" },
    sendJson: (res, status, body) => {
      out.status = status;
      out.body = body;
    },
    authorised: (req, token) => req.headers["x-panel-token"] === token,
  });
  const query = new URLSearchParams();
  if (task) query.set("task", String(task));
  if (tree) query.set("tree", tree);
  if (project) query.set("project", project);
  if (assistantId) query.set("assistantId", assistantId);
  const url = new URL(`http://localhost${SPAWN_CHECK_PATH}${query.toString() ? `?${query}` : ""}`);
  await handler({ method: "GET", headers: { "x-panel-token": "secret" } }, {}, SPAWN_CHECK_PATH, url);
  return out;
}

// A card still standing in a tree, exactly as the job store holds a live one.
function standRun(p, { jobId, runId, thread, tree, status = "running" }) {
  p.jobs.jobs.set(jobId, {
    id: jobId,
    runId,
    thread,
    status,
    cwd: tree,
    prompt: "a run standing in the tree",
    lines: [],
    origin: { kind: "assistant-spawn" },
  });
}

function row(p, id, { title, path, branch, parent = "main", verdict = "UNMERGED (2 commits)", ahead = 2 }) {
  p.rows.push({ id, title, path, branch, parent, verdict, ahead, dirty: 0, untracked: 0, project: "proj" });
}

// ---- case 1: disruption recovery ---------------------------------------------------------------------------------

test("a disruption re-issue goes into the SAME tree only on the runs API's DEAD answer, and the brief names the work", async (t) => {
  const p = await fixture(t);
  const heldRow = { id: 41, title: "the tree that was cut off", path: p.trees.held, branch: "wtgui/held-tree-aaaaaa", parent: "main", verdict: "UNMERGED (2 commits)", ahead: 2, dirty: 0, untracked: 0, project: "proj" };
  p.rows.push(heldRow);
  const task = p.assistant.queueMutate("assistant-1", "add", { title: "the work a dead run left", thread: "t-old" }).task;
  p.assistant.queueMutate("assistant-1", "state", { id: task.id, state: "running" });
  standRun(p, { jobId: "job-old", runId: "run_old", thread: "t-old", tree: p.trees.held });
  p.stub.runs.set("run_old", "failed");

  // The pre-flight: the row and the tree are both this one run, and the runs API calls it DEAD, so the answer is a
  // NOTE, not a refusal - and the note says what the brief will say.
  const pre = await ask(p, { task: task.id, tree: p.trees.held });
  assert.equal(pre.body.ok, true, `a dead run does not hold the tree: ${JSON.stringify(pre.body)}`);
  const note = pre.body.checks.find((c) => c.code === "tree_reissue");
  assert.ok(note, "the re-issue is reported as its own check");
  assert.equal(note.allowed, true);
  assert.match(pre.body.reason, /the runs API says run run_old is failed/);
  assert.match(pre.body.reason, /SAME tree/);
  assert.match(pre.body.reason, /must be read before anything is overwritten/);

  // The cut: the SAME tree, a NEW thread, and the brief carries the paragraph the row makes a condition.
  const before = p.stub.submitted.length;
  const job = await p.assistant.startSpawn({ prompt: "continue the work the dead run left", taskId: task.id, existing: true, target: p.trees.held, project: "proj", assistantId: "assistant-1" });
  assert.equal(p.stub.submitted.length, before + 1, "the run was posted");
  const rec = p.jobs.get(job.id);
  assert.equal(rec?.reuse?.case, "disruption", "the card records the case");
  assert.equal(rec?.reuse?.prior?.job, "job-old");
  assert.equal(rec?.reuse?.prior?.runId, "run_old");
  assert.equal(rec?.reuse?.prior?.status, "failed");
  const input = p.stub.last();
  assert.match(input, /REUSE ON A DISRUPTION: work already exists in /, "the brief says work already exists");
  assert.match(input, /previous run \(job job-old on thread t-old, ended failed per the runs API\)/);
  assert.match(input, /Read it before you overwrite anything/, "and that it must be read first");
  assert.match(input, /git log --oneline -20/, "with the reads that show it");
  assert.match(input, /Nothing here asks for a clean tree/, "no clean-tree requirement is invented");
  assert.equal(job.status !== "failed", true, "the tree was not refused");
});

test("a second agent into a tree held by a LIVE run is still refused, by the pre-flight and by the cut", async (t) => {
  const p = await fixture(t);
  row(p, 42, { title: "a different job in a held tree", path: p.trees.held, branch: "wtgui/held-tree-aaaaaa" });
  standRun(p, { jobId: "job-live", runId: "run_live", thread: "t-live", tree: p.trees.held });
  p.stub.runs.set("run_live", "running");

  const pre = await ask(p, { tree: p.trees.held });
  assert.equal(pre.body.ok, false, "a live run is not re-issuable");
  const check = pre.body.checks[0];
  assert.equal(check.code, "tree_live_run");
  assert.match(pre.body.reason, /already has a live run \(job job-live on thread t-live, running\)/);
  assert.match(pre.body.reason, /the runs API says run run_live is running/);
  assert.match(pre.body.remedy, /wait for job job-live on thread t-live to end/);

  const before = p.stub.submitted.length;
  await assert.rejects(
    () => p.assistant.startSpawn({ prompt: "a second agent in the held tree", existing: true, target: p.trees.held, project: "proj", assistantId: "assistant-1" }),
    (err) => {
      assert.equal(err.code, "tree_busy", "the code every other tree refusal carries");
      assert.equal(err.reasonCode, "tree_live_run");
      assert.equal(err.message, `${pre.body.reason}. ${pre.body.remedy}.`, "the cut throws the pre-flight's sentence");
      return true;
    },
  );
  assert.equal(p.stub.submitted.length, before, "nothing was posted");
});

test("a run the gateway has forgotten is NOT dead: a 404 keeps the tree refused", async (t) => {
  const p = await fixture(t);
  row(p, 43, { title: "the unknown run", path: p.trees.held, branch: "wtgui/held-tree-aaaaaa" });
  standRun(p, { jobId: "job-gone", runId: "run_gone", thread: "t-gone", tree: p.trees.held });
  p.stub.runs.set("run_gone", "404");

  const pre = await ask(p, { tree: p.trees.held });
  assert.equal(pre.body.ok, false);
  assert.equal(pre.body.checks[0].code, "tree_run_unknown");
  assert.match(pre.body.reason, /the runs API has no run run_gone \(404\) - a missing run is not evidence the old one ended/);
  assert.match(pre.body.remedy, /Reset assistant/, "the remedy is the route that settles an unknown run");
});

// ---- case 2: stage ping-pong -------------------------------------------------------------------------------------

test("a coder and a reviewer hold two trees on one lineage without either being told it is the other", async (t) => {
  const p = await fixture(t);
  const coder = { id: 51, title: "build the change", path: p.trees.coder, branch: "wtgui/coder-tree-bbbbbb", parent: "main", verdict: "UNMERGED (4 commits)", ahead: 4, dirty: 0, untracked: 0, project: "proj" };
  const reviewer = { id: 52, title: "review the change", path: p.trees.reviewer, branch: "review/coder-tree-bbbbbb-r1-1a2b3c4", parent: "wtgui/coder-tree-bbbbbb", verdict: "UNMERGED (1 commit)", ahead: 1, dirty: 0, untracked: 0, project: "proj" };
  p.rows.push(coder, reviewer);

  // The round's name is derived, and it records the SHA it was cut from.
  const round = reviewRoundName({ coderBranch: "wtgui/coder-tree-bbbbbb", coderSha: "1a2b3c4d5e6f7a8b", round: 1 });
  assert.equal(round.branch, "review/coder-tree-bbbbbb-r1-1a2b3c4");
  assert.equal(round.anchor, "1a2b3c4d5e6f7a8b");
  assert.deepEqual(reviewRoundOf(round.branch), { round: 1, anchor: "1a2b3c4", coderSlug: "coder-tree-bbbbbb" });
  assert.equal(reviewRoundName({ coderBranch: "wtgui/coder-tree-bbbbbb", coderSha: "", round: 1 }).ok, false, "no anchor, no round");

  // The pair, from the board's own facts: the reviewer's branch is a review branch and its parent is the coder's.
  const pair = stagePair({ coder, reviewer });
  assert.equal(pair.pair, true);
  assert.equal(pair.lineage, "wtgui/coder-tree-bbbbbb");
  assert.equal(pair.anchor, "1a2b3c4");
  assert.deepEqual(stagePairFor({ row: reviewer, rows: p.rows }), pair);
  const sameTree = stagePair({ coder, reviewer: coder });
  assert.equal(sameTree.pair, false, "one tree cannot be both stages");
  assert.equal(sameTree.code, "stage_same_tree");

  // git refuses two worktrees on one branch, and the refusal says why the reviewer gets its own.
  const same = sameBranchRefusal({ coderBranch: "wtgui/coder-tree-bbbbbb", reviewerBranch: "wtgui/coder-tree-bbbbbb", coderTree: p.trees.coder, reviewerTree: p.trees.reviewer });
  assert.equal(same.code, "stage_same_branch");
  assert.match(same.reason, /git refuses two worktrees on one branch/);

  // The pre-flight on the reviewer's tree is a NOTE that names the pair, never a duplicate.
  const pre = await ask(p, { tree: p.trees.reviewer });
  assert.equal(pre.body.ok, true, JSON.stringify(pre.body));
  const stage = pre.body.checks.find((c) => c.code === "stage_review");
  assert.ok(stage, "the pair is reported as its own check");
  assert.match(stage.reason, /this tree is the reviewer's in a stage loop with the coder's tree /);
  assert.match(stage.reason, /round 1 anchored at 1a2b3c4/);
  assert.match(stage.reason, /neither is the other's duplicate/);
  assert.doesNotMatch(pre.body.reason || "", /reused the unfinished tree/, "a stage pair is not reported as a reuse of the coder's tree");

  // And the coder's tree is not told it is the reviewer either.
  const coderPre = await ask(p, { tree: p.trees.coder });
  assert.equal(coderPre.body.checks.some((c) => c.code === "stage_review"), false);
  assert.doesNotMatch(coderPre.body.reason || "", /reviewer/);

  // The reuse recommendation does NOT offer the reviewer's tree for a new job either: it is the second tree of the
  // pair, not a second attempt at one job.
  const decision = reuseDecision({ task: "review the change", rows: p.rows, jobs: [], project: p.project, mainBranch: "main" });
  assert.equal(decision.reuse, null, "a per-round review tree is never handed a new job");
  assert.equal(decision.note, "", "and nothing is reported as a reuse the cut could have made");

  // The cut into the reviewer's tree carries the round rule in the brief, so the round is cut and anchored as asked.
  const before = p.stub.submitted.length;
  const job = await p.assistant.startSpawn({ prompt: "review round 1 of the coder's branch", existing: true, target: p.trees.reviewer, project: "proj", assistantId: "assistant-1" });
  assert.equal(p.stub.submitted.length, before + 1, "the reviewer's run was posted");
  const input = p.stub.last();
  assert.match(input, /STAGE LOOP - THIS TREE IS THE REVIEWER'S/);
  assert.match(input, /Do not check out wtgui\/coder-tree-bbbbbb in this tree: git refuses two worktrees on one branch/);
  assert.match(input, /PER-ROUND REVIEW BRANCH here from the coder's branch/);
  assert.match(input, /anchored at 1a2b3c4/);
  assert.equal(job.origin?.stagePair?.lineage, "wtgui/coder-tree-bbbbbb");
  assert.equal(job.origin?.stagePair?.anchor, "1a2b3c4");
});

// ---- case 3: NOT reuse -------------------------------------------------------------------------------------------

test("a landed tree cannot take an unrelated new row: refused by name with a row, warned by name without one", async (t) => {
  const p = await fixture(t);
  const landed = { id: 61, title: "the work that landed", path: p.trees.landed, branch: "wtgui/landed-tree-cccccc", parent: "main", verdict: "MERGED (3 commits)", ahead: 3, dirty: 0, untracked: 0, project: "proj" };
  p.rows.push(landed);
  const fresh = p.assistant.queueMutate("assistant-1", "add", { title: "an unrelated new row" }).task;

  // WITH a row: a refusal, and the reason names the tree, the branch, the verdict and the attachment it never earned.
  const pre = await ask(p, { task: fresh.id, tree: p.trees.landed });
  assert.equal(pre.body.ok, false);
  const check = pre.body.checks.find((c) => c.code === "tree_landed");
  assert.ok(check, JSON.stringify(pre.body.checks));
  assert.equal(check.allowed, undefined, "it is a refusal, not a note");
  assert.match(pre.body.reason, new RegExp(`the tree ${p.trees.landed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is already finished \\(MERGED \\(3 commits\\), branch wtgui/landed-tree-cccccc, 3 commits ahead of main\\)`));
  assert.match(pre.body.reason, /would start row #\d+ against a stale base/);
  assert.match(pre.body.reason, /inherit that tree's initiative attachment, which it never earned/);
  assert.match(pre.body.remedy, /cut row #\d+ a FRESH tree from main at current HEAD/);

  // The CUT refuses the same line in the same sentence, before any run exists.
  const before = p.stub.submitted.length;
  await assert.rejects(
    () => p.assistant.startSpawn({ prompt: "an unrelated new row in a landed tree", taskId: fresh.id, existing: true, target: p.trees.landed, project: "proj", assistantId: "assistant-1" }),
    (err) => {
      assert.match(err.message, /is already finished/);
      assert.match(err.message, /FRESH tree from main/, "the remedy rides with the refusal");
      return true;
    },
  );
  assert.equal(p.stub.submitted.length, before, "nothing was posted");
  assert.equal(p.assistant.queueView("assistant-1").tasks.find((x) => x.id === fresh.id).state, "queued", "the row was not moved");

  // WITHOUT a row: a warning that names the tree, so a person re-entering one they know is told what it is.
  const warned = await ask(p, { tree: p.trees.landed });
  assert.equal(warned.body.ok, true);
  const note = warned.body.checks.find((c) => c.code === "tree_landed");
  assert.equal(note.allowed, true);
  assert.match(warned.body.reason, /No queue row is carried, so this is a warning rather than a refusal/);

  // The reader's own card carries the same warning rather than cutting silently.
  const spawn = createSpawn({ getConfig: () => ({ defaultCwd: p.repo, remoteBranchPolicy: "local-only" }), getProjects: () => [p.project], jobs: p.jobs, getRows: () => p.rows });
  const card = await spawn.linkSpawn({ existing: true, cwd: p.trees.landed }, p.project, null);
  assert.equal(card.ok, true);
  assert.match(String(card.fields.note || ""), /already finished \(MERGED \(3 commits\)/);
});

test("a fresh cut for a row says it inherits no attachment, and the landed rule leaves a landed tree alone", () => {
  const row = { path: "C:/x/repo/.worktrees/old-aaaaaa", branch: "wtgui/old-aaaaaa", verdict: "MERGED (1 commit)", ahead: 1 };
  const refused = landedTreeCut({ row, taskId: 313, mainBranch: "main" });
  assert.equal(refused.refusal?.code, "tree_landed");
  assert.match(refused.refusal.reason, /already finished/);
  const warned = landedTreeCut({ row, mainBranch: "main" });
  assert.equal(warned.refusal, null);
  assert.match(warned.note, /warning rather than a refusal/);
  assert.equal(landedTreeCut({ row: { ...row, verdict: "" } }).note, "", "a cheap scan with no verdict is not a landed tree");
  assert.equal(landedTreeCut({ row: { ...row, verdict: "UNMERGED (2 commits)" } }).note, "", "unlanded work is not finished");
  // The project's own checkout reads ON MAIN by definition and is where every new tree is cut from: "run in place"
  // is a choice the panel has always allowed, so the landed rule must not refuse it.
  assert.equal(landedTreeCut({ row: { path: "C:/x/repo", branch: "main", verdict: "ON MAIN", ahead: 0 }, taskId: 313, projectPath: "C:/x/repo" }).refusal, null);
});

test("the runs-API reading is the only DEAD verdict: a stale card, a 404 and an unreadable answer all keep it alive", () => {
  assert.equal(runVerdict({ runId: "r1", read: true, status: "failed" }).dead, true);
  assert.equal(runVerdict({ runId: "r1", read: true, status: "cancelled" }).dead, true);
  assert.equal(runVerdict({ runId: "r1", read: true, status: "completed" }).dead, true);
  assert.equal(runVerdict({ runId: "r1", read: true, status: "running" }).dead, false);
  assert.equal(runVerdict({ runId: "r1", read: false, gone: true }).dead, false, "a missing run is not a death certificate");
  assert.equal(runVerdict({ runId: "r1", read: false }).dead, false);
  assert.match(runVerdict({ runId: "r1", read: false }).why, /could not be read/);

  // A card with no run id cannot be proved dead, so it keeps the ordinary held-tree sentence, word for word.
  const noRun = { id: "job-1", thread: "t-1", status: "running" };
  const plain = reissueRefusal({ tree: "C:/x/tree-aaaaaa", holder: noRun, run: null });
  assert.equal(plain.code, "tree_busy");
  assert.match(plain.reason, /already has a live run \(job-1 on thread t-1, running\)/);
  // A card WITH a run id is answerable, and an unreadable answer is not a death certificate.
  const holder = { id: "job-1", thread: "t-1", runId: "r1", status: "running" };
  assert.equal(reissueRefusal({ tree: "C:/x/tree-aaaaaa", holder, run: null }).code, "tree_live_run");
  assert.match(reissueRefusal({ tree: "C:/x/tree-aaaaaa", holder, run: null }).reason, /the runs API could not be read for run r1/);
  assert.equal(reissueRefusal({ tree: "C:/x/tree-aaaaaa", holder, run: { runId: "r1", read: true, status: "running" } }).code, "tree_live_run");
  assert.equal(reissueRefusal({ tree: "C:/x/tree-aaaaaa", holder, run: { runId: "r1", read: true, status: "interrupted" } }), null, "DEAD allows it");
  assert.equal(reissueRefusal({ tree: "C:/x/tree-aaaaaa", holder: null, run: null }), null, "no holder, nothing to ask");

  // The paragraph is built from the run that died, and never asks for a clean tree.
  const brief = priorWorkBrief({ tree: "C:/x/tree-aaaaaa", holder, run: { runId: "r1", read: true, status: "failed" } });
  assert.match(brief, /work already exists in C:\/x\/tree-aaaaaa from a previous run/);
  assert.match(brief, /ended failed per the runs API/);
  assert.match(brief, /Read it before you overwrite anything/);
  assert.match(brief, /Nothing here asks for a clean tree/);
});
