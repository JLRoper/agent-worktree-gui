// Queue row 401, both acceptance halves, proved through the REAL parser, the REAL harvest, the REAL spawner
// (lib/features/spawn.js `assistantSpawnRun`), the REAL `Jobs.create`/`makeWorktree` and a real repository:
//
//   1. a SPAWN line OVER 2,000 CHARACTERS cuts a worker, is journalled, and the worker receives the WHOLE brief.
//      Before this the prompt was clipped at 2,000 characters and the tail of a long line silently vanished.
//   2. a SPAWN line that misses the grammar leaves a journal line naming its reason, its length and the line
//      itself - on a panel whose command audit is OFF, which is the default. Before this the line vanished: no
//      job, no refusal, no journal line (the 2026-11-28 defect).
//   3. a spawn asked to use a DIRTY or STALE-BASE tree is refused BY NAME, before a record or a run exists.
//   4. a plain SPAWN on a project whose named turnover branch has LANDED cuts from main, not from the dead branch
//      (the trap that put three children on a branch main had left behind).
//
// A stub gateway only counts what it was asked to start; every git answer is a real one from a scratch repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs } from "../lib/jobs.js";
import { Assistant, ASSISTANT_THREAD } from "../lib/assistant.js";
import { createSpawn } from "../lib/features/spawn.js";
import { ParentBook } from "../lib/parents.js";
import { TRIVIAL_BEHIND } from "../lib/spawn-check.js";

const slash = (p) => String(p).replace(/\\/g, "/");
const turn = (id, line, thread = ASSISTANT_THREAD) => ({
  id,
  thread,
  turn: 1,
  status: "done",
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  endedAt: new Date().toISOString(),
  lines: [{ kind: "text", text: line, at: Date.now() - 60_000, lid: Math.random() }],
});
const kinds = (assistant, kind) => assistant.journal.filter((j) => j.kind === kind);

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
        return json(200, {
          version: "stub",
          features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true },
        });
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
  // A test that spends twenty seconds in git must not lose the pooled keep-alive socket Node drops after 5 s idle:
  // the next probe would read ECONNRESET and report "the gateway is not usable" instead of the refusal under test.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
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

// A real repo parked on `main`. `feature/roll-up` is one commit ahead; `landed` merges it into main with a merge
// commit, so main's tip is a commit the branch does NOT carry - which is what makes "cut from main" and "cut from
// the branch" two different commits a test can tell apart.
function repo(dir, { landed = false } = {}) {
  const tree = slash(path.join(dir, "demo"));
  const email = ["tester", "example.invalid"].join(String.fromCharCode(64));
  mkdirSync(tree, { recursive: true });
  const run = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const git = (...args) => run(tree, ...args);
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(tree, "README.md"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const mainSha = git("rev-parse", "main");
  git("checkout", "-q", "-b", "feature/roll-up");
  writeFileSync(path.join(tree, "roll-up.md"), "the work that lands\n");
  git("add", "-A");
  git("commit", "-q", "-m", "the roll-up work");
  const rollUpSha = git("rev-parse", "feature/roll-up");
  git("checkout", "-q", "main");
  let mergeSha = null;
  if (landed) {
    git("merge", "-q", "--no-ff", "-m", "Merge feature/roll-up into main", "feature/roll-up");
    mergeSha = git("rev-parse", "main");
  }
  mkdirSync(path.join(tree, ".worktrees"), { recursive: true });
  return { tree, git, inDir: (cwd, ...args) => run(cwd, ...args), mainSha, rollUpSha, mergeSha };
}

// `main` moves on by `n` empty commits, in ONE process: a `git commit` per commit is a process per commit, and a
// test that needs fifty of them spends half a minute on nothing. The commit objects are empty, so the checkout's
// files and index are unchanged and `git status` stays clean.
function advanceMain(r, n) {
  const email = ["test", "example.invalid"].join(String.fromCharCode(64));
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push("commit refs/heads/main");
    // The timestamp is computed, never typed: a long digit run is redacted on its way through this harness,
    // and a fast-import committer line needs one. One second per commit keeps the history monotonic.
    const stamp = `${Math.floor(Date.now() / 1000) + i} +0000`;
    lines.push(`committer Test <${email}> ${stamp}`);
    const message = `main moves ${i + 1}`;
    lines.push(`data ${Buffer.byteLength(message)}`, message);
    if (i === 0) lines.push(`from ${r.git("rev-parse", "main")}`);
  }
  const stream = `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`;
  execFileSync("git", ["-C", r.tree, "fast-import", "--quiet"], { input: stream, stdio: ["pipe", "pipe", "pipe"] });
}

async function panel(t, { landed = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-spawn-record-"));
  const gw = await stubGateway();
  const r = repo(dir, { landed });
  const project = { name: "demo", path: r.tree, mainBranch: "main", remote: null };
  // The board's rows, as the scanner would have written them. A test pushes one to make a tree visible to the
  // reuse recommendation; nothing else reads them here.
  const rows = [];

  const config = {
    jobsFile: path.join(dir, "logs", "jobs.json"),
    apiServer: { url: gw.url, key: "stub" },
    defaultCwd: dir,
    turnoverBranchFor: (name) => getProjects().find((p) => p.name === name)?.turnoverBranch || "",
  };
  const getProjects = () => [project];
  const logs = [];
  const onLog = (line) => logs.push(String(line));
  const jobs = new Jobs({ config, onEvent: () => {}, onLog });
  const parents = new ParentBook({ file: path.join(dir, "logs", "parents.json"), onLog: () => {} });
  jobs.parents = parents;
  const spawn = createSpawn({ getConfig: () => config, getProjects, jobs, getRows: () => rows });
  const assistant = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "logs", "assistant.json") },
    jobs,
    getProjects,
    getRows: () => rows,
    getChildren: () => ({}),
    spawner: spawn.assistantSpawnRun,
    onEvent: () => {},
    onLog,
  });
  // A panel as it ships: the command audit is OFF unless the reader turns it on.
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

  const spawns = () => [...jobs.jobs.values()].filter((j) => j.origin?.kind === "assistant-spawn");
  const recordOf = (job) => jobs.jobs.get(job.id);
  const trees = () => (existsSync(path.join(r.tree, ".worktrees")) ? readdirSync(path.join(r.tree, ".worktrees")) : []);
  return { dir, gw, repo: r, project, rows, jobs, assistant, parents, spawns, recordOf, trees, logs };
}

// ---------------------------------------------------------------------------------------------
// 1. a SPAWN line over 2,000 characters: a worker cuts, the journal names the line, the brief arrives whole
// ---------------------------------------------------------------------------------------------

test("a SPAWN line over 2,000 characters cuts a worker, is journalled, and the brief arrives whole", async (t) => {
  const p = await panel(t);
  const tail = "TAIL-MARKER-THE-END-OF-THE-LONG-BRIEF";
  const filler = "Read every file under lib, in order, and say what each one does in one line. ".repeat(40);
  const line = `SPAWN demo | ${filler}${tail}`;
  assert.ok(line.length > 2000, `the fixture line is over 2,000 characters (${line.length})`);

  await p.assistant.harvest(turn("turn-long-1", line));

  const job = p.spawns()[0];
  assert.ok(job?.id, "the long line cut a worker");
  assert.ok(slash(job.cwd).startsWith(`${p.repo.tree}/.worktrees/`), `the worker is in a tree of this project: ${job.cwd}`);
  assert.equal(p.gw.posts.length, 1, "one line, one run");

  // THE WHOLE BRIEF: the prompt used to be clipped at 2,000 characters, which is how the tail of a long line was
  // lost without a word. The marker only survives if the action carried the line's full text.
  const input = String(p.gw.posts[0].input || "");
  assert.ok(input.includes(tail), "the worker was handed the END of the brief, not a 2,000-character cut");

  // ...and the journal says which line it was: the started line and the turn's own count, both naming the length.
  const started = kinds(p.assistant, "spawned");
  assert.equal(started.length, 1, "the started line is journalled");
  assert.match(started[0].text, /new worktree in demo/);
  assert.match(started[0].text, new RegExp(`\\(line ${line.length} chars\\)`), `the journal names the line's length: ${started[0].text}`);
  const counted = kinds(p.assistant, "spawn-lines");
  assert.equal(counted.length, 1, "the turn's own count is journalled");
  assert.match(counted[0].text, /turn turn-long-1: 1 SPAWN line read - 1 parsed, 0 unparsed/);
  assert.equal(kinds(p.assistant, "spawn-unparsed").length, 0);
});

// ---------------------------------------------------------------------------------------------
// 2. a SPAWN line that misses the grammar: a journal line with the reason and the length, audit off
// ---------------------------------------------------------------------------------------------

test("a malformed SPAWN line journals its refusal with the reason and its length, even with the command audit off", async (t) => {
  const p = await panel(t);
  assert.equal(p.assistant.settings.commandAudit, "off", "the panel's default: the audit is not what writes this record");

  const bad = "SPAWN demo without a pipe so the grammar cannot read it";
  await p.assistant.harvest(turn("turn-bad-1", bad));

  assert.equal(p.gw.posts.length, 0, "nothing was started");
  assert.equal(p.spawns().length, 0, "and no run exists");
  assert.equal(p.assistant.spawnIntents.filter((x) => x.turnId === "turn-bad-1").length, 0, "no debt was opened for a line nothing could run");

  const unparsed = kinds(p.assistant, "spawn-unparsed");
  assert.equal(unparsed.length, 1, `one journal line for the dropped SPAWN: ${JSON.stringify(p.assistant.journal.map((e) => e.kind))}`);
  assert.match(unparsed[0].text, /turn turn-bad-1/);
  assert.match(unparsed[0].text, new RegExp(`a SPAWN line of ${bad.length} characters`), "the LENGTH of the line");
  assert.match(unparsed[0].text, /no pipe/, "the REASON it could not be read");
  assert.match(unparsed[0].text, /SPAWN demo without a pipe/, "and the line itself, quoted");

  // The turn's count is the second half: a reader can tell "wrote one and it was unparsed" from "wrote none".
  const counted = kinds(p.assistant, "spawn-lines");
  assert.equal(counted.length, 1);
  assert.match(counted[0].text, /turn turn-bad-1: 1 SPAWN line read - 0 parsed, 1 unparsed/);

  // A line with an empty brief is the same record, with a different reason: the grammar needs both sides of the pipe.
  await p.assistant.harvest(turn("turn-bad-2", "SPAWN demo |"));
  const second = kinds(p.assistant, "spawn-unparsed").find((e) => /turn-bad-2/.test(e.text));
  assert.ok(second, "the second bad line also leaves a record");
  assert.match(second.text, /no brief after the pipe/);
});

// ---------------------------------------------------------------------------------------------
// 3. a spawn asked to use a dirty or stale tree is refused BY NAME
// ---------------------------------------------------------------------------------------------

test("a spawn asked to use a dirty or stale-base tree is refused by name, before anything runs", async (t) => {
  const p = await panel(t);

  // (a) DIRTY: a real worktree with one uncommitted file - the shape of the three PNGs left in row 677's tree.
  const dirty = slash(path.join(p.repo.tree, ".worktrees", "dirty-tree"));
  p.repo.git("worktree", "add", "-q", "-b", "wtgui/dirty-tree", dirty);
  writeFileSync(path.join(dirty, "uncommitted.png"), "not committed\n");

  const before = p.gw.posts.length;
  // Driven through the REAL harvest, because the line's record is half of what this row is about.
  await p.assistant.harvest(turn("turn-dirty-1", `SPAWN IN ${dirty} | continue the work in this tree`));

  assert.equal(p.gw.posts.length, before, "no run was posted");
  assert.equal(p.spawns().length, 0, "and no run record exists");
  // A refusal is `spawn-refused` (the same kind a held tree writes), and it raises a CARD - queue row 419: a
  // refusal the reader cannot see is the absence the row is about.
  const refused = kinds(p.assistant, "spawn-refused");
  assert.equal(refused.length, 1, `the refusal was journalled: ${JSON.stringify(p.assistant.journal.map((e) => e.kind))}`);
  assert.match(refused[0].text, /cannot take a new worker/);
  assert.match(refused[0].text, /dirty-tree/, "the refusal NAMES the tree");
  assert.match(refused[0].text, /1 uncommitted file/);
  assert.match(refused[0].text, /cut a FRESH tree from current main/);
  const card = p.assistant.alerts.find((a) => a.rule === "spawn-refused" && a.status === "open");
  assert.ok(card, "the dirty-tree refusal raised a card");
  assert.match(card.detail, /1 uncommitted file/, "the card carries the reason");
  assert.match(card.detail, /commit or discard those files/, "and the remedy");
  assert.equal(p.assistant.spawnIntents.find((x) => x.turnId === "turn-dirty-1")?.outcome, "failed", "the debt is settled, not left owed");

  // The same refusal through a direct start (a card press takes this path): it throws, and the sentence is the same.
  await assert.rejects(
    () => p.assistant.startSpawn({ existing: true, target: dirty, prompt: "continue the work in this tree" }, { source: "assistant" }),
    (e) => {
      assert.match(e.message, /cannot take a new worker/);
      assert.ok(e.message.includes("dirty-tree"), `the refusal NAMES the tree: ${e.message}`);
      return true;
    },
  );
  assert.equal(p.gw.posts.length, before, "still nothing posted");

  // (b) STALE: a clean worktree whose base main has left behind by more than the trivial drift.
  const stale = slash(path.join(p.repo.tree, ".worktrees", "stale-tree"));
  p.repo.git("worktree", "add", "-q", "-b", "wtgui/stale-tree", stale);
  advanceMain(p.repo, TRIVIAL_BEHIND + 1);
  assert.equal(p.repo.inDir(stale, "status", "--porcelain"), "", "the stale tree itself is clean");

  await p.assistant.harvest(turn("turn-stale-1", `SPAWN IN ${stale} | carry on here`));
  assert.equal(p.gw.posts.length, before, "the stale tree posted nothing either");
  const second = kinds(p.assistant, "spawn-refused").find((e) => /turn-stale-1|stale-tree/.test(e.text));
  assert.ok(second, `the stale refusal is a second journal line: ${JSON.stringify(p.assistant.journal.filter((e) => e.kind === "spawn-refused").map((e) => e.text))}`);
  assert.match(second.text, /cannot take a new worker/);
  assert.match(second.text, /stale-tree/, "named, not guessed at");
  assert.match(second.text, new RegExp(`trails main by ${(TRIVIAL_BEHIND + 1).toLocaleString("en-US")} commits`));

  // A FRESH cut on the same project is unaffected: the refusal is about the tree, not about spawning.
  const fresh = await p.assistant.startSpawn({ project: "demo", prompt: "read the notes and report what the ladder does" }, { source: "assistant" });
  assert.ok(fresh?.id, "a plain SPAWN still cuts a tree of its own");
  assert.equal(p.gw.posts.length, before + 1);
});

// ---------------------------------------------------------------------------------------------
// 4. a plain SPAWN on a project whose turnover branch has LANDED cuts from main
// ---------------------------------------------------------------------------------------------

test("a plain SPAWN on a project whose turnover branch has landed cuts from main, not from the dead branch", async (t) => {
  const p = await panel(t, { landed: true });
  p.project.turnoverBranch = "feature/roll-up";
  assert.notEqual(p.repo.mergeSha, p.repo.rollUpSha, "the fixture makes main and the landed branch different commits");

  // A research brief: no code word, so the cut is a research tree and the implementation container is not the
  // question here. What is measured is the COMMIT the tree starts at.
  const job = await p.assistant.startSpawn({ project: "demo", prompt: "read the notes and report what the ladder does" }, { source: "assistant" });
  assert.ok(job?.id, "the cut started a run");

  assert.equal(p.repo.inDir(job.cwd, "rev-parse", "HEAD"), p.repo.mergeSha, "the tree starts at main's tip, not the landed branch's");
  assert.notEqual(p.repo.inDir(job.cwd, "rev-parse", "HEAD"), p.repo.rollUpSha, "and specifically not at the dead branch's commit");
  assert.equal(p.repo.inDir(job.cwd, "rev-parse", "--abbrev-ref", "HEAD"), job.branch, "the new tree is on its own branch");

  // The recorded parent is main, so the chart and a later roll-up are not pointed at a branch main already holds.
  const rec = p.parents.rowsFor("demo").find((x) => x.branch === job.branch);
  assert.ok(rec, `the cut is in the parent book: ${JSON.stringify(p.parents.rowsFor("demo"))}`);
  assert.equal(rec.parent, "main", "the cut parent is main");
  assert.equal(rec.parentSha, p.repo.mergeSha);

  // The engine says which branch it skipped, so the reader is not left wondering why the setting did not apply.
  assert.ok(
    p.logs.some((line) => /names the turnover branch feature\/roll-up, but it is already landed on main/.test(line)),
    `the cut logs the branch it skipped: ${JSON.stringify(p.logs.filter((l) => /cut:/.test(l)))}`,
  );
});

// ---------------------------------------------------------------------------------------------
// 5. the incident itself: a plain SPAWN whose only overlapping tree is dirty cuts FRESH and says why
// ---------------------------------------------------------------------------------------------

test("a plain SPAWN does not reuse an overlapping tree that is dirty: it cuts fresh and names the tree it skipped", async (t) => {
  const p = await panel(t);
  const slug = "convert-built-in-ladder-pipelines-to-pdl";
  const dir = slash(path.join(p.repo.tree, ".worktrees", `${slug}-abc123`));
  const branch = `wtgui/${slug}-abc123`;
  p.repo.git("worktree", "add", "-q", "-b", branch, dir);
  writeFileSync(path.join(dir, "ladder.txt"), "work\n");
  p.repo.inDir(dir, "add", "-A");
  p.repo.inDir(dir, "commit", "-q", "-m", "the ladder, converted");
  writeFileSync(path.join(dir, "leftover.png"), "nobody committed this\n");
  // The row the scanner would write: one commit of its own, one uncommitted file, no live run.
  p.rows.push({ path: dir, branch, project: "demo", verdict: "UNMERGED (1 commit)", ahead: 1, dirty: 1, untracked: 0, live: false });

  const job = await p.assistant.startSpawn({ project: "demo", prompt: "Convert all seven built-in ladder pipelines to PDL" }, { source: "assistant" });
  const rec = p.recordOf(job);
  assert.equal(rec.existing, false, "the dirty tree was NOT reused");
  assert.equal(p.trees().length, 2, "a fresh tree was cut beside it");
  assert.notEqual(slash(rec.worktreePath), dir, "and it is not the dirty tree");

  const card = (rec.lines || []).map((l) => String(l.text || "")).join("\n");
  assert.match(card, /reuse was NOT used for 1 unfinished tree/, `the card says why reuse was skipped: ${card}`);
  assert.ok(card.includes(dir), "naming the tree it skipped");
  assert.match(card, /uncommitted files?/);
  assert.equal(rec.origin?.reused, undefined, "the origin records no reuse, because there was none");
});
