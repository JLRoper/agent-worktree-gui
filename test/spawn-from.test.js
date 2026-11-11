// A SPAWN that cuts its tree from a NAMED parent ref (`SPAWN FROM <ref> <project>`).
//
// ae6888ca made the turnover branch first-class: a project can name the branch its work rolls up into, a plain cut
// starts from it instead of from whatever the checkout stands on, the parent book records it, and the landing
// paragraph says "merge locally, do not push". What it could not do is let a SPAWN name a DIFFERENT parent for one
// cut: `from` existed only as the fan-out's base commit, and a name passed there was handed to `worktree add` with no
// sha and (worse) recorded as a tree with no parent at all.
//
// What is pinned here, each one a way this can look right and be wrong:
//
//   1. the LINE: `FROM <ref>` is read off the SPAWN's target and is not part of the project name, with or without a
//      leading task id, and `SPAWN IN` still reads as a tree that already stands (no parent, nothing cut);
//   2. the PROMPT offers the shape, because a grammar the model is not told is a line the panel silently drops;
//   3. the CUT: the tree is cut at the named branch's commit, not at the checkout's, and the parent book records
//      `parent: <ref>`, `parentSource: "cut"` and the RESOLVED sha - that triple is what the chart and a later
//      roll-up read;
//   4. a LANDING branch named on purpose is recorded as the parent (main is a name, not "unknown"), and the
//      project's turnover branch does not override the paragraph for a cut the caller pinned to main;
//   5. a ref that resolves to NOTHING refuses the line, cuts nothing and posts no run - never a fallback to the
//      checkout, which would put the tree somewhere nobody asked for;
//   6. the CARD: `ask` mode records the ref on the card and on its evidence, and the press cuts from it - a card that
//      forgot the ref would start the worker on the checkout's branch, which is the one thing the line said not to do.
//
// Driven through the REAL parser, the REAL assistant harvest, the REAL spawner (lib/features/spawn.js
// `assistantSpawnRun`), the REAL `Jobs.create`/`makeWorktree` and a real repository: a stub gateway only counts what
// it was asked to start.
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
import { actionGrammar, parseActions } from "../lib/assistant/actions.js";

const slash = (p) => String(p).replace(/\\/g, "/");
const turn = (id, line) => ({ id, thread: ASSISTANT_THREAD, lines: [{ kind: "text", text: line, at: Date.now(), lid: Math.random() }] });

// ---- 1: the line, and the grammar it is documented in ----------------------------------------------------------
test("`FROM <ref>` is read off a SPAWN line and the prompt offers the shape", () => {
  const plain = parseActions("SPAWN FROM feature/roll-up demo | carry the docs").spawn[0];
  assert.equal(plain.target, "demo", "the ref is not part of the project name");
  assert.equal(plain.from, "feature/roll-up");
  assert.equal(plain.existing, false);
  assert.equal(plain.prompt, "carry the docs");

  // The task id may lead the line or follow FROM, like it may lead a plain SPAWN or follow IN.
  assert.equal(parseActions("SPAWN #12 FROM feature/roll-up demo | x").spawn[0].taskId, 12);
  const after = parseActions("SPAWN FROM feature/roll-up #12 demo | x").spawn[0];
  assert.equal(after.taskId, 12);
  assert.equal(after.target, "demo");
  assert.equal(after.from, "feature/roll-up");

  // Quotes a model likes to add around a path are stripped off the ref too.
  assert.equal(parseActions('SPAWN FROM "feature/roll-up" demo | x').spawn[0].from, "feature/roll-up");

  // Nothing changes for the shapes that were already there: a plain SPAWN names no parent, and a SPAWN IN is a tree
  // that already stands, so it can name none.
  assert.equal(parseActions("SPAWN demo | x").spawn[0].from, null);
  const inside = parseActions("SPAWN IN demo/.worktrees/one | x").spawn[0];
  assert.equal(inside.existing, true);
  assert.equal(inside.from, null);
  assert.equal(inside.target, "demo/.worktrees/one");

  // The prompt has to offer the shape: a line it is not told about is a line the panel drops without a word.
  const grammar = actionGrammar({ spawn: "auto" }).join("\n");
  assert.match(grammar, /SPAWN FROM <parent ref>/);
  assert.match(grammar, /refuses the line and cuts nothing/);
});

// ---- the panel: a real store, a real assistant, the real spawner ------------------------------------------------
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

// A real repo parked on `main`, with `feature/roll-up` ONE COMMIT AHEAD of it: a cut from the checkout's branch and a
// cut from the named branch start at different commits, so "cut from the right place" is measured, not assumed.
function repo(dir) {
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
  writeFileSync(path.join(tree, "roll-up.md"), "the work that has not landed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "the roll-up work");
  const rollUpSha = git("rev-parse", "feature/roll-up");
  git("checkout", "-q", "main");
  mkdirSync(path.join(tree, ".worktrees"), { recursive: true });
  return { tree, git, inDir: (cwd, ...args) => run(cwd, ...args), mainSha, rollUpSha };
}

async function panel(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-spawn-from-"));
  const gw = await stubGateway();
  const r = repo(dir);
  const project = { name: "demo", path: r.tree, mainBranch: "main" };

  const config = {
    jobsFile: path.join(dir, "logs", "jobs.json"),
    apiServer: { url: gw.url, key: "stub" },
    defaultCwd: dir,
    // The project's turnover branch, read per cut exactly as server.js wires it (lib/project-turnover.js
    // `turnoverLookup`). Empty until a test sets one.
    turnoverBranchFor: (name) => (getProjects().find((p) => p.name === name)?.turnoverBranch || ""),
  };
  const getProjects = () => [project];
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  const parents = new ParentBook({ file: path.join(dir, "logs", "parents.json"), onLog: () => {} });
  jobs.parents = parents;
  const spawn = createSpawn({ getConfig: () => config, getProjects, jobs, getRows: () => [] });
  const a = new Assistant({
    config: { ...config, assistantFile: path.join(dir, "logs", "assistant.json") },
    jobs,
    getProjects,
    getRows: () => [],
    getChildren: () => ({}),
    spawner: spawn.assistantSpawnRun,
    onEvent: () => {},
    onLog: () => {},
  });
  a.settings.spawn = "auto";
  a.settings.autonomy = "auto";

  t.after(async () => {
    for (const j of jobs.jobs.values()) {
      j.ctrl?.abort();
      for (const timer of [j.timer, j.poller, j.textTimer, j.statsTimer]) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    }
    for (const timer of ["wakeTimer", "settleTimer", "timer", "persistTimer"]) if (a[timer]) clearTimeout(a[timer]);
    await gw.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const spawns = () => [...jobs.jobs.values()].filter((j) => j.origin?.kind === "assistant-spawn");
  // The STORED record, not the summary `create` returns: the cut's parent fields live on the job the store holds (the
  // summary is the card's own shape and carries origin, cwd, branch and worktree only).
  const recordOf = (job) => jobs.jobs.get(job.id);
  const trees = () => (existsSync(path.join(r.tree, ".worktrees")) ? readdirSync(path.join(r.tree, ".worktrees")) : []);
  return { dir, gw, repo: r, project, jobs, assistant: a, parents, spawns, trees, recordOf };
}

// ---- 3: the cut -------------------------------------------------------------------------------------------------
test("a SPAWN FROM cuts at the named branch and records it as the cut parent, with the resolved sha", async (t) => {
  const p = await panel(t);
  const job = await p.assistant.startSpawn({ target: "demo", project: "demo", from: "feature/roll-up", prompt: "carry the roll-up docs" }, { source: "assistant" });
  assert.ok(job?.id, "the cut started a run");

  // The tree stands at the NAMED branch's commit, not where the checkout is: that is the whole point of the line.
  assert.equal(p.repo.inDir(job.cwd, "rev-parse", "HEAD"), p.repo.rollUpSha, "the tree was cut at feature/roll-up's commit");
  assert.notEqual(p.repo.rollUpSha, p.repo.mainSha, "the fixture must make the two tips differ");
  assert.equal(p.repo.inDir(job.cwd, "rev-parse", "--abbrev-ref", "HEAD"), job.branch, "the new tree is on its own branch");

  // What the chart and a later roll-up read: the parent book, written at the cut.
  const rec = p.parents.rowsFor("demo").find((x) => x.branch === job.branch);
  assert.ok(rec, `the cut is in the parent book: ${JSON.stringify(p.parents.rowsFor("demo"))}`);
  assert.equal(rec.parent, "feature/roll-up");
  assert.equal(rec.parentSource, "cut");
  assert.equal(rec.parentSha, p.repo.rollUpSha, "the RESOLVED commit, not just the name");
  // …and on the job's own record, which is what the card and a later run read without a second lookup.
  const stored = p.recordOf(job);
  assert.equal(stored.parent, "feature/roll-up");
  assert.equal(stored.parentSource, "cut");
  assert.equal(stored.parentSha, p.repo.rollUpSha);
  assert.equal(job.origin?.fromRef, "feature/roll-up", "the origin names what was asked for");

  // The worker is told where the work goes: the parent's own case (not a landing branch, so a LOCAL roll-up).
  const brief = p.gw.posts.at(-1)?.input || "";
  assert.match(brief, /LANDING:/);
  assert.match(brief, /cut from `feature\/roll-up`/);
  assert.match(brief, /merging .* into `feature\/roll-up` LOCALLY and do not push/);
  // The journal says which parent it cut from, so the assistant reading its own wake can find it.
  assert.ok(p.assistant.journal.some((e) => e.kind === "spawned" && /new worktree in demo from feature\/roll-up/.test(e.text)), "the journal names the parent");
});

// ---- 4: a landing branch, named on purpose ------------------------------------------------------------------------
test("a SPAWN FROM main records main as the cut parent and still says push and open a PR", async (t) => {
  const p = await panel(t);
  const job = await p.assistant.startSpawn({ target: "demo", project: "demo", from: "main", prompt: "a branch for a reviewable PR" }, { source: "assistant" });
  const stored = p.recordOf(job);
  assert.equal(stored.parent, "main", "a named landing branch is a name the chart can show, not 'unknown'");
  assert.equal(stored.parentSource, "cut");
  assert.equal(stored.parentSha, p.repo.mainSha);
  assert.match(p.gw.posts.at(-1)?.input || "", /cut from `main` - a landing branch[\s\S]*push it and open a pull request/);

  // A project that HAS a turnover branch does not rewrite the paragraph for a cut the caller pinned to main: the
  // tree does not start from the turnover branch, so telling the worker to roll into it would be a false sentence.
  p.project.turnoverBranch = "feature/roll-up";
  const pinned = await p.assistant.startSpawn({ target: "demo", project: "demo", from: "main", prompt: "another branch off main" }, { source: "assistant" });
  const brief = p.gw.posts.at(-1)?.input || "";
  assert.equal(p.recordOf(pinned).parent, "main");
  assert.match(brief, /cut from `main` - a landing branch[\s\S]*push it and open a pull request/);
  assert.doesNotMatch(brief, /turnover branch is `feature\/roll-up`/, "a named parent is not overridden by the project's turnover branch");

  // The case ae6888ca built is untouched: a plain SPAWN on that project cuts from the turnover branch and rolls up.
  const plain = await p.assistant.startSpawn({ target: "demo", project: "demo", prompt: "the ordinary cut on this project" }, { source: "assistant" });
  assert.equal(p.recordOf(plain).parent, "feature/roll-up", "a plain cut still follows the project's turnover branch");
  assert.match(p.gw.posts.at(-1)?.input || "", /this project's turnover branch/);
});

// ---- 5: a ref that names nothing ----------------------------------------------------------------------------------
test("a FROM that resolves to nothing refuses the line, cuts nothing and posts no run", async (t) => {
  const p = await panel(t);
  const before = p.trees();
  await assert.rejects(
    () => p.assistant.startSpawn({ target: "demo", project: "demo", from: "no/such-branch", prompt: "cut from a branch nobody has" }, { source: "assistant" }),
    (e) => {
      assert.match(e.message, /no\/such-branch is not a ref in/);
      return true;
    },
  );
  assert.equal(p.gw.posts.length, 0, "the gateway was never asked");
  assert.equal(p.spawns().length, 0, "no job was left on the board");
  assert.deepEqual(p.trees(), before, "nothing was cut");

  // Through the harvest the refusal is written down, which is the only way the assistant finds out its line did not
  // run: the debt is settled failed and the reason names the line and the ref.
  await p.assistant.harvest(turn("turn-bad-from", "SPAWN FROM no/such-branch demo | cut from a branch nobody has"));
  const failed = p.assistant.journal.filter((e) => e.kind === "spawn-failed");
  assert.equal(failed.length, 1, `one refusal, one journal line: ${JSON.stringify(p.assistant.journal.map((e) => e.kind))}`);
  assert.match(failed[0].text, /SPAWN FROM no\/such-branch demo/);
  assert.match(failed[0].text, /is not a ref in/);
  assert.equal(p.spawns().length, 0, "the line produced no run");
  assert.deepEqual(p.trees(), before, "and no tree");
  assert.equal(p.assistant.spawnIntents.find((x) => x.turnId === "turn-bad-from")?.outcome, "failed", "the debt is settled, not left owed");
});

test("a SPAWN IN cannot be cut from a ref: an existing tree keeps the parent it was cut with", async (t) => {
  const p = await panel(t);
  await assert.rejects(
    () => p.assistant.startSpawn({ existing: true, target: p.repo.tree, from: "feature/roll-up", prompt: "work in the checkout" }, { source: "assistant" }),
    /SPAWN IN starts in a tree that already exists/,
  );
  assert.equal(p.gw.posts.length, 0);
});

// ---- 6: the card, and the press -----------------------------------------------------------------------------------
test("the ask-mode card carries the ref on its evidence, and the press cuts from it", async (t) => {
  const p = await panel(t);
  p.assistant.settings.spawn = "ask";
  await p.assistant.harvest(turn("turn-card-from", "SPAWN FROM feature/roll-up demo | carry the roll-up docs"));
  assert.equal(p.gw.posts.length, 0, "a card starts nothing");

  const card = p.assistant.alerts.find((a) => a.rule === "spawn" && a.status === "open");
  assert.ok(card, "the line became a card");
  assert.equal(card.spawn.from, "feature/roll-up");
  assert.equal(card.spawn.project, "demo");
  assert.ok(card.evidence.some((e) => e.label === "cut from" && e.value === "feature/roll-up"), `the card says where it is cut from: ${JSON.stringify(card.evidence)}`);
  assert.match(card.title, /from feature\/roll-up/);

  // The press is the cut. A card that forgot the ref would start the worker on the checkout's branch.
  const job = await p.assistant.startSpawn(p.assistant.pendingSpawn(card.id), { alertId: card.id, source: "reader" });
  assert.equal(p.gw.posts.length, 1, "one press, one run");
  assert.equal(p.recordOf(job).parent, "feature/roll-up");
  assert.equal(p.repo.inDir(job.cwd, "rev-parse", "HEAD"), p.repo.rollUpSha);
  assert.equal(p.assistant.alerts.find((a) => a.id === card.id)?.status, "done", "the card is closed against the run it started");
});
