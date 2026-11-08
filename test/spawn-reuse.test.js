// One job, one tree.
//
// A SPAWN names a job, not a directory, and the panel used to cut a tree for it every time. Two trees for one
// job is the failure this file pins: measured on this board, `convert-built-in-ladder-pipelines-to-pdl-f76189`
// and `convert-all-seven-built-efe600` were cut for the same work, and neither card could see the other.
//
// The proof is driven through the REAL spawner (lib/features/spawn.js `assistantSpawnRun` -> lib/jobs.js
// `create` -> a real `git worktree add`), so what is asserted is a tree on disk and a run posted into it, not a
// flag set by the test:
//
//   1. a second SPAWN whose task overlaps a free, unmerged tree runs IN that tree (`existing: true`, no second
//      directory) and the card says it was reused;
//   2. when a live run holds that tree, a second tree IS cut - the one-worker-per-tree rule - and the card says
//      reuse was possible and names the tree it would have been;
//   3. a freshly cut tree is named after the task's TITLE in whole words, so two tasks for one job cannot read as
//      two unrelated trees: `convert-built-in-ladder-pipelines-to-pdl` and `convert-all-seven-built-in-ladder`,
//      never a name cut inside a word.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs } from "../lib/jobs.js";
import { Assistant } from "../lib/assistant.js";
import { createSpawn } from "../lib/features/spawn.js";
import { taskTitle, treeSlug } from "../lib/tree-slug.js";

const slash = (p) => String(p).replace(/\\/g, "/");

// ---- a stub gateway: it records every run it is asked to start, and never finishes one -------------------
async function stubGateway() {
  const posts = [];
  const server = createServer((req, res) => {
    const url = String(req.url || "");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
      const json = (code, out) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      if (req.method === "GET" && url === "/v1/capabilities") {
        return json(200, { version: "stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true } });
      }
      if (req.method === "POST" && url === "/v1/runs") {
        posts.push(body);
        return json(200, { run_id: `run_${posts.length}`, session_id: String(body.session_id || "") });
      }
      if (req.method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url)) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": open\n\n");
        req.on("close", () => res.end());
        return;
      }
      if (req.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(url)) return json(200, { status: "running", output: "" });
      if (req.method === "POST") return json(200, {});
      json(404, { error: { message: "no such route" } });
    });
  });
  await new Promise((open) => server.listen(0, "127.0.0.1", open));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    posts,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(done);
      }),
  };
}

// ---- a repository, and one tree of it already cut and carrying a commit -----------------------------------
function repo(dir) {
  const tree = slash(path.join(dir, "demo"));
  mkdirSync(tree, { recursive: true });
  const email = ["tester", "example.invalid"].join(String.fromCharCode(64));
  const git = (...args) =>
    execFileSync("git", ["-C", tree, "-c", "user.name=Test", "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(tree, "README.md"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return { tree, git };
}

// A tree cut by hand, exactly as the panel cuts one: `<repo>/.worktrees/<slug>-<tag>` on `wtgui/<slug>-<tag>`,
// with one commit of its own that main does not have. The row is what the scanner would have written for it.
function cutTree(r, name, tag) {
  const dir = slash(path.join(r.tree, ".worktrees", `${name}-${tag}`));
  const branch = `wtgui/${name}-${tag}`;
  r.git("worktree", "add", "-q", "-b", branch, dir);
  writeFileSync(path.join(dir, "ladder.txt"), "work\n");
  r.git("-C", dir, "add", "-A");
  r.git("-C", dir, "commit", "-q", "-m", "the ladder, converted");
  return {
    dir,
    branch,
    row: { path: dir, branch, verdict: "UNMERGED (1 commit)", ahead: 1, dirty: 0, untracked: 0, live: false },
  };
}

async function panel(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-spawn-reuse-"));
  const gw = await stubGateway();
  const r = repo(dir);
  const project = { name: "demo", path: r.tree, mainBranch: "main", remote: null };
  const rows = [];
  const config = { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: gw.url, key: "stub" }, defaultCwd: dir };
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  const spawn = createSpawn({ getConfig: () => config, getProjects: () => [project], jobs, getRows: () => rows });
  const assistant = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "assistant.json") },
    jobs,
    getProjects: () => [project],
    getRows: () => rows,
    getChildren: () => ({}),
    spawner: spawn.assistantSpawnRun,
    onEvent: () => {},
    onLog: () => {},
  });
  assistant.settings.spawn = "auto";
  assistant.settings.autonomy = "auto";

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

  const record = (job) => jobs.jobs.get(job.id);
  const hold = (job) => {
    const rec = record(job);
    if (rec) rec.status = "running";
    return rec;
  };
  const trees = () => readdirSync(path.join(r.tree, ".worktrees")).sort();
  const cardText = (job) => (record(job)?.lines || []).map((l) => String(l.text || "")).join("\n");
  return { dir, gw, r, project, rows, jobs, assistant, record, hold, trees, cardText };
}

const FIRST = "convert-built-in-ladder-pipelines-to-pdl";
const SECOND = "convert-all-seven-built-in-ladder-pipelines";

// ---------------------------------------------------------------------------------------------
// 1. a second SPAWN for an overlapping task lands in the first tree, and the card says so
// ---------------------------------------------------------------------------------------------

test("a second SPAWN naming an overlapping task runs in the tree the first one already has", async (t) => {
  const p = await panel(t);
  const first = cutTree(p.r, FIRST, "f76189");
  p.rows.push(first.row);

  const job = await p.assistant.startSpawn({ project: "demo", prompt: "Convert all seven built-in ladder pipelines to PDL" }, { source: "assistant" });

  const rec = p.record(job);
  assert.equal(rec.existing, true, "the run was attached to a tree instead of cutting one");
  assert.equal(slash(rec.cwd), first.dir, "and the tree it attached to is the one that already carries the task");
  assert.equal(slash(rec.ownerPath), first.dir);
  assert.deepEqual(p.trees(), [`${FIRST}-f76189`], "no second tree was cut");
  assert.equal(p.gw.posts.length, 1);
  assert.equal(slash(p.gw.posts[0].cwd), first.dir, "the worker was posted into that tree, not the project checkout");

  assert.match(p.cardText(job), /reused the unfinished tree/, "the card says the tree was reused");
  assert.ok(p.cardText(job).includes(first.dir), `the card names the tree: ${p.cardText(job)}`);
  assert.ok(p.cardText(job).includes(first.branch), "and its branch");
  assert.equal(rec.origin.reused?.path, first.dir, "the origin record carries the reuse, not only the console text");
  assert.ok(rec.origin.reused.shared.includes("pipeline"), "the shared words are the task's own");
  assert.ok(rec.origin.reused.shared.includes("convert"));
});

// ---------------------------------------------------------------------------------------------
// 2. the tree a live run holds is reported, and a second tree is cut rather than sharing it
// ---------------------------------------------------------------------------------------------

test("a SPAWN for an overlapping task cuts its own tree when the first one is held, and says reuse was possible", async (t) => {
  const p = await panel(t);
  const first = cutTree(p.r, FIRST, "f76189");
  p.rows.push(first.row);

  // The same job, started into the tree it already has: a live run, held open.
  const held = await p.assistant.startSpawn(
    { existing: true, target: first.dir, prompt: "Convert built-in ladder pipelines to PDL" },
    { source: "assistant" },
  );
  p.hold(held);
  const asked = p.gw.posts.length;

  const job = await p.assistant.startSpawn({ project: "demo", prompt: "Convert all seven built-in ladder pipelines to PDL" }, { source: "assistant" });
  const rec = p.record(job);

  assert.equal(rec.existing, false, "the held tree was not shared - one worker per tree");
  assert.equal(p.trees().length, 2, "a second tree was cut");
  assert.notEqual(slash(rec.worktreePath), first.dir);
  assert.ok(slash(rec.worktreePath).startsWith(`${p.r.tree}/.worktrees/`), "and it is a tree of this project");
  assert.equal(p.gw.posts.length, asked + 1);

  const card = p.cardText(job);
  assert.match(card, /a second tree was cut/, "the card says a second tree was cut");
  assert.match(card, /reuse was possible/, "and that reuse was possible");
  assert.ok(card.includes(first.dir), `naming the tree that already carries the task: ${card}`);
  assert.equal(rec.origin.reuseBlocked?.path, first.dir);

  // The held tree is untouched by the second run.
  assert.equal(slash(p.record(held).cwd), first.dir);
});

// ---------------------------------------------------------------------------------------------
// 3. a fresh tree is named after the task's title, in whole words
// ---------------------------------------------------------------------------------------------

test("a tree cut from a task title is named in whole, readable words", async (t) => {
  const p = await panel(t);
  const a = await p.jobs.makeWorktree(p.r.tree, "Convert built-in ladder pipelines to PDL. Then convert the rest of the ladders.");
  const b = await p.jobs.makeWorktree(p.r.tree, "Convert all seven built-in ladder pipelines to PDL");
  const dirOf = (made) => path.basename(made.path).replace(/-[0-9a-f]{6}$/, "");

  assert.equal(dirOf(a), FIRST, "the cut name is the task's title, to the end of the first sentence");
  assert.equal(dirOf(b), "convert-all-seven-built-in-ladder", "the longer title is cut between words, at the budget");
  assert.notEqual(dirOf(a), dirOf(b), "two tasks for one job cannot read as one truncated name");

  // The old rule cut inside a word, which is what made two names unjoinable: no fragment of a word may survive.
  const WHOLE = new Set(["convert", "built", "in", "ladder", "pipelines", "to", "pdl", "all", "seven"]);
  for (const name of [dirOf(a), dirOf(b)]) {
    for (const word of name.split("-")) assert.ok(WHOLE.has(word), `whole word in ${name}: ${word}`);
    assert.ok(name.length <= 40, `the name stays inside the budget: ${name}`);
  }

  // A caller holding a better title names the tree with it (a queue row's own words), and the branch and the
  // directory agree.
  const made = await p.jobs.makeWorktree(p.r.tree, "the rendered stage prompt, which is boilerplate", { title: "Port the flavour roster" });
  assert.equal(path.basename(made.path).replace(/-[0-9a-f]{6}$/, ""), "port-the-flavour-roster");
  assert.equal(made.branch, `wtgui/${path.basename(made.path)}`);
});

test("the title is the prompt's first sentence, and a dotted token is never split", () => {
  assert.equal(taskTitle("Convert the ladder. Then do the rest."), "Convert the ladder");
  assert.equal(taskTitle("LANDING: cut the tree\n\nmore words"), "LANDING: cut the tree");
  assert.equal(taskTitle("Fix lib/jobs.js: the cut"), "Fix lib/jobs.js: the cut", "a dotted file name is not a sentence end");
  assert.equal(taskTitle("  ## Fix the cut  "), "Fix the cut");
  assert.equal(treeSlug("Convert built-in ladder pipelines to PDL"), FIRST);
  assert.equal(treeSlug(""), "agent");
});
