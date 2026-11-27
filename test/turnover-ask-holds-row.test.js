// AN ASK AT THE CUT HOLDS THE ROW, IT DOES NOT FAIL THE SPAWN.
//
// MEASURED (job 2dc01973): a SPAWN whose implementation cut needed the feature's turnover branch failed in 0.5 s with
// no tree and no commits, its exact words naming the panel's permission card. Minutes later the card was gone from
// `/api/approvals` and no job was waiting, so the answer had nothing to resume: the row sat queued reading "the run
// ended failed with no final message".
//
// What this file pins, one case per paragraph of the brief, over a fabricated project and a real queue file:
//
//   1. ASK        the row parks on the permission record, naming its id and the card, and NO failed job exists;
//   2. ALLOW      the answered card cuts the container and the child and starts the worker on the SAME row;
//   3. DENY       the row returns to queued with the refusal as its reason, never a failed run;
//   4. EXPIRY     the same, with the expiry named in the reason;
//   5. NO ASK     one-per-feature with an existing branch for the key, and a project at `free`, both cut without a card.
//
// Every case drives the shipped code: `spawnFeature.assistantSpawnRun` (the real spawner), `Jobs.create` and
// `Jobs.makeWorktree` (the real cut), `Assistant.startSpawn`/`parkSpawnForPermission` (the real park),
// `RemoteWrites` (the real permission store), `allowTurnoverAsk`/`resumeRowAfterAsk` (the real resume) and
// `settleTasks` (the real release). Only the registry rows and the `jobs.probe` network read are stubs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Assistant } from "../lib/assistant.js";
import { queuePathOf, readQueueFile, settleTasks, writeQueueFile } from "../lib/assistant/queue.js";
import { createSpawn } from "../lib/features/spawn.js";
import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { planTurnoverCut } from "../lib/project-turnover.js";
import { RemoteWrites } from "../lib/remote-writes.js";
import { allowTurnoverAsk, permissionStateOf, queueOwnerOf, TURNOVER_ASK_CODE } from "../lib/turnover-ask.js";

const EMAIL = ["tester", "example.invalid"].join(String.fromCharCode(64));
const PROMPT = "fix the push gate in lib/push-permissions.js";

// ---- the fabricated project: one real repository, on main, with one commit ---------------------------------
function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-turnover-ask-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Ask Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Ask Fixture");
  git("config", "user.email", EMAIL);
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  writeFileSync(path.join(dir, "lib", "push-permissions.js"), "export const PUSH = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "the project's own work");
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { dir, git };
}

// The project record the registry would hand the cut: a name, the checkout, and the turnover policy under test.
const projectOf = (dir, over = {}) => ({ name: "demo", path: dir, mainBranch: "main", turnoverBranches: [], turnoverPolicy: "ask", ...over });

// ---- the panel: a real store, a real assistant, the real spawner, the real permission box ------------------
function panel(t, { policy = "ask", branches = [] } = {}) {
  const r = repo(t);
  const project = projectOf(r.dir, { turnoverPolicy: policy, turnoverBranches: branches });
  // NO REAL GATEWAY: a closed loopback port, so a run that is posted here is refused at once rather than started on the
  // machine's own Hermes gateway. The cut is what this file proves; a run that cannot be posted is `failed` for a reason
  // that has nothing to do with the ask, and every case asserts the jobs it created rather than a live thread.
  const config = { jobsFile: path.join(r.dir, "logs", "jobs.json"), defaultCwd: r.dir, apiServer: { url: "http://127.0.0.1:1", key: "test" } };
  const jobs = new Jobs({ config, onEvent: () => {}, onLog: () => {} });
  jobs.parents = new ParentBook({ file: path.join(r.dir, "logs", "parents.json"), onLog: () => {} });
  // The one network read a spawn makes. There is no gateway in this test; the cut is what is being proved, and a run
  // that cannot be posted is `failed` for a reason that has nothing to do with the ask.
  jobs.probe = async () => ({ reachable: true, capabilities: { runs: true, clarifyRoute: true } });
  // The project's turnover lookup, the same `planTurnoverCut` the server calls, over the record this test mutates.
  jobs.turnoverCutFor = (name, key, opts) => planTurnoverCut({ project, key, name: opts?.name || "", at: new Date() });
  const remoteWrites = new RemoteWrites({ getPolicy: () => "local-only", onEvent: () => {}, onLog: () => {} });
  t.after(() => {
    if (remoteWrites.timer) clearInterval(remoteWrites.timer);
  });
  const spawn = createSpawn({ getConfig: () => config, getProjects: () => [project], jobs, getRows: () => [] });
  const assistant = new Assistant({
    config: { ...config, assistantFile: path.join(r.dir, "logs", "assistant.json") },
    jobs,
    getProjects: () => [project],
    getRows: () => [],
    getChildren: () => ({}),
    spawner: spawn.assistantSpawnRun,
    // The server's own wiring: the queue's `permission` hold reads the record through this one mapping.
    permissionStatus: (id) => permissionStateOf(remoteWrites.status(id)),
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(() => {
    for (const timer of ["persistTimer", "wakeTimer", "settleTimer", "timer"]) if (assistant[timer]) clearTimeout(assistant[timer]);
  });
  // The reader's own landing list for the feature: the allowed branch is joined here, which is what makes the
  // restarted cut answer `reuse` and hang the child under the container.
  const remember = (branch, key) => {
    if (!project.turnoverBranches.some((entry) => String(entry.branch || entry).toLowerCase() === String(branch).toLowerCase())) {
      project.turnoverBranches.push(key ? { branch, key } : { branch });
    }
  };
  // THE CARD, wired exactly as server.js wires it: the resume is the real `allowTurnoverAsk`, handed the project's
  // checkout, its base and the row the cut named.
  let asked = 0;
  jobs.requestTurnoverBranch = ({ project: name, key = "", branch = "", policy: said = "", prompt = "", row = null, todos = [] } = {}) => {
    asked += 1;
    return remoteWrites.request({
      kind: "turnover",
      worktree: r.dir,
      project: name,
      branch,
      title: `${name}: new turnover branch ${branch}`,
      command: `add the feature's turnover branch ${branch} to ${name}${key ? ` (key ${key})` : ""}`,
      description: `this project's turnover policy is ${said}, so a new turnover branch waits for you.`,
      allowed: ["once", "deny"],
      grants: false,
      resume: async () => allowTurnoverAsk({ assistant, jobs, repoDir: r.dir, project: name, mainBranch: "main", key, branch, rowId: row, prompt, todos, remember }),
    });
  };
  // One queued row, in the queue the panel seeds for Assistant #1 at boot.
  writeQueueFile(queuePathOf(path.dirname(assistant.file), "assistant-1"), [{ id: 1, title: "fix the push gate", detail: PROMPT, state: "queued", files: [] }], 2);
  return { dir: r.dir, project, jobs, remoteWrites, assistant, remember, askedCount: () => asked };
}

const rowNow = (assistant) => readQueueFile(assistant.queuePathOf(assistant.assistantRecord())).tasks.find((t) => Number(t.id) === 1) || null;
const jobsNow = (jobs) => jobs.list();

// One SPAWN of row 1: the same spec the harvest builds (a project by name, a fresh cut, the row it carries).
const spawnRow = (assistant) =>
  assistant.startSpawn({ target: "demo", project: "demo", existing: false, taskId: 1, prompt: PROMPT }, { source: "assistant" });

// The server's answer route, in order: take the resumable action, answer, then run it unless the answer was a deny.
async function answerCard(p, id, choice) {
  const resume = p.remoteWrites.takeResume(id);
  const out = p.remoteWrites.answer(id, choice, { by: "reader" });
  assert.equal(out.ok, true, `the card accepted ${choice}: ${out.error || ""}`);
  const resumed = resume && out.choice !== "deny" ? await resume() : null;
  return { out, resumed };
}

// ---- 1. ASK ------------------------------------------------------------------------------------------------
test("1. an ask PARKS the row on the permission record and leaves no failed job", async (t) => {
  const p = panel(t);
  const made = await spawnRow(p.assistant);

  assert.equal(made.asked, true, "the spawner answered an ask, not a run");
  assert.equal(made.id, null, "no job was started");

  const row = rowNow(p.assistant);
  assert.equal(row.state, "parked", "the row is parked, not queued behind a failed run");
  assert.equal(row.hold.kind, "permission", "the park names what it waits on");
  const card = String(row.hold.value);
  assert.match(card, /^rw_/, "the hold is the permission record's own id");
  assert.equal(p.remoteWrites.status(card).status, "pending", "and that record is still on the panel");
  assert.match(row.reason, new RegExp(card), "the reason names the record id");
  assert.match(row.reason, /new turnover branch/, "and names the card");
  assert.match(row.reason, /2026\d{4}_\d{4}_TASK-1_/, "and the branch the answer will make");

  assert.equal(jobsNow(p.jobs).length, 0, "NO job exists at all - not a failed one, none");
  assert.equal(existsSync(path.join(p.dir, ".worktrees")), false, "nothing was cut: the tree comes after the answer");
  assert.equal(p.askedCount(), 1, "exactly one card was raised");

  // The hold is TESTABLE, which is what makes the answer able to move the row: pending still holds it.
  const held = settleTasks(readQueueFile(p.assistant.queuePathOf(p.assistant.assistantRecord())).tasks, {
    jobs: jobsNow(p.jobs),
    permissionStatus: (id) => permissionStateOf(p.remoteWrites.status(id)),
  });
  assert.equal(held.changed.length, 0, "a card still waiting holds the row");
  assert.equal(held.tasks[0].state, "parked");
});

// ---- 2. ALLOW ----------------------------------------------------------------------------------------------
test("2. the allowed card cuts the container and the child and starts the SAME row", async (t) => {
  const p = panel(t);
  await spawnRow(p.assistant);
  const card = String(rowNow(p.assistant).hold.value);
  const containerBranch = p.remoteWrites.list().find((r) => r.id === card).branch;

  const { resumed } = await answerCard(p, card, "once");
  assert.equal(resumed.ok, true, `the allowed cut ran: ${resumed.error || ""}`);
  assert.equal(resumed.made.ok, true, "the feature's container was cut");

  // Two trees: the container stands on the branch the card named, the child is cut from it.
  const containerPath = path.join(p.dir, ".worktrees", containerBranch.replace(/[\\/]+/g, "-"));
  assert.equal(existsSync(containerPath), true, "the container's tree exists");
  const child = resumed.started;
  assert.equal(child.ok, true, `the row's fresh cut started: ${child.error || ""}`);
  assert.ok(child.job, "the worker exists");
  const cut = p.jobs.get(child.job);
  assert.ok(cut, "the run is in the store");
  assert.equal(cut.thread, child.thread);
  assert.ok(existsSync(cut.cwd), `the child tree exists at ${cut.cwd}`);
  assert.notEqual(path.resolve(cut.cwd), path.resolve(containerPath), "the child is its own tree");
  assert.equal(execFileSync("git", ["-C", cut.cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(), cut.branch);
  assert.equal(execFileSync("git", ["-C", cut.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), execFileSync("git", ["-C", containerPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "the child starts at the container's tip");
  const book = JSON.parse(readFileSync(path.join(p.dir, "logs", "branch-parents.json"), "utf8"));
  const childRec = Object.values(book).find((rec) => rec.branch === cut.branch);
  assert.equal(childRec.parent, containerBranch, "the child's parent is the container");

  // The SAME row runs: it was not left parked and no second row was filed.
  const row = rowNow(p.assistant);
  assert.equal(row.state, "running", "the row is running");
  assert.equal(row.thread, cut.thread, "on the worker's thread");
  assert.equal(row.hold ?? null, null, "and its permission hold is cleared");
  assert.equal(p.project.turnoverBranches.filter((e) => (e.branch || e) === containerBranch).length, 1, "the branch is on the project's list once");
});

// ---- 3. DENY -----------------------------------------------------------------------------------------------
test("3. a denied card returns the row to queued with the refusal as its reason", async (t) => {
  const p = panel(t);
  await spawnRow(p.assistant);
  const card = String(rowNow(p.assistant).hold.value);
  const { resumed } = await answerCard(p, card, "deny");
  assert.equal(resumed, null, "a deny runs no resume at all");

  const settled = settleTasks(readQueueFile(p.assistant.queuePathOf(p.assistant.assistantRecord())).tasks, {
    jobs: jobsNow(p.jobs),
    permissionStatus: (id) => permissionStateOf(p.remoteWrites.status(id)),
  });
  const row = settled.tasks.find((x) => Number(x.id) === 1);
  assert.equal(row.state, "queued", "the row is back in the queue");
  assert.equal(row.hold, null, "with no hold left behind");
  assert.match(row.reason, /permission/, "the reason names the record");
  assert.match(row.reason, new RegExp(card));
  assert.match(row.reason, /denied/, "and says it was denied");
  assert.equal(settled.changed[0].to, "queued", "the settle reports the move");
  assert.equal(jobsNow(p.jobs).length, 0, "and still no failed run was ever created");
  assert.equal(existsSync(path.join(p.dir, ".worktrees")), false, "a deny cuts nothing");
});

// ---- 4. EXPIRY ---------------------------------------------------------------------------------------------
test("4. an expired card returns the row to queued WITH the expiry named", async (t) => {
  const p = panel(t);
  await spawnRow(p.assistant);
  const card = String(rowNow(p.assistant).hold.value);
  // Nobody answers: the panel's own sweep closes the record at its deadline.
  const pending = p.remoteWrites.pending.get(card);
  pending.deadline = Date.now() - 1;
  p.remoteWrites.sweep();
  assert.equal(p.remoteWrites.status(card).by, "timeout", "the record is closed by the window, not by a reader");
  assert.equal(p.remoteWrites.takeResume(card), null, "and there is nothing left to resume");

  const settled = settleTasks(readQueueFile(p.assistant.queuePathOf(p.assistant.assistantRecord())).tasks, {
    jobs: jobsNow(p.jobs),
    permissionStatus: (id) => permissionStateOf(p.remoteWrites.status(id)),
  });
  const row = settled.tasks.find((x) => Number(x.id) === 1);
  assert.equal(row.state, "queued", "the row is back in the queue");
  assert.equal(row.hold, null);
  assert.match(row.reason, new RegExp(card), "the reason names the record");
  assert.match(row.reason, /expired/, "and says it expired");
  assert.match(row.reason, /no answer inside the window/, "naming the expiry's own reason");
  assert.equal(jobsNow(p.jobs).length, 0, "no failed run");
});

// ---- 5. NO ASK ---------------------------------------------------------------------------------------------
test("5. one-per-feature with a branch for the key, and a project at free, both cut without a card", async (t) => {
  // 5a. one-per-feature: the key already has a branch, so the cut reuses it and asks nothing.
  const existing = "20261127_1422_TASK-1_fix-the-push-gate";
  const p = panel(t, { policy: "one-per-feature", branches: [{ branch: existing, key: "task 1" }] });
  const made = await spawnRow(p.assistant);
  assert.notEqual(made.asked, true, "an existing branch for the key raises no card");
  assert.ok(made.id, "a run was started");
  assert.equal(p.askedCount(), 0, "no permission record was created");
  assert.equal(p.remoteWrites.list().length, 0);
  const run = p.jobs.get(made.id);
  const row = rowNow(p.assistant);
  assert.equal(row.state, "running", "the row runs");
  assert.equal(row.thread, run.thread);
  const containerPath = path.join(p.dir, ".worktrees", existing.replace(/[\\/]+/g, "-"));
  assert.equal(existsSync(containerPath), true, "the existing branch's container is put on a tree");
  assert.notEqual(path.resolve(run.cwd), path.resolve(containerPath), "the child is its own tree, cut from the container");
  assert.equal(execFileSync("git", ["-C", run.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), execFileSync("git", ["-C", containerPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "from the container's tip");

  // 5b. free: a brand new branch is made at once, and still no card.
  const q = panel(t, { policy: "free" });
  const free = await spawnRow(q.assistant);
  assert.notEqual(free.asked, true, "a free project never asks");
  assert.ok(free.id);
  assert.equal(q.askedCount(), 0);
  assert.equal(q.remoteWrites.list().length, 0);
  assert.equal(rowNow(q.assistant).state, "running");
  const freeRun = q.jobs.get(free.id);
  const cut = q.jobs.get(free.id);
  const book = JSON.parse(readFileSync(path.join(q.dir, "logs", "branch-parents.json"), "utf8"));
  const childRec = Object.values(book).find((rec) => rec.branch === freeRun.branch);
  assert.match(String(childRec.parent), /^2026\d{4}_\d{4}_TASK-1_/, "the child hangs under the branch the cut made itself");
});

// ---- the seams the cases above stand on ---------------------------------------------------------------
test("6. the raise site names its code, and the record's three states map to one hold answer", () => {
  assert.equal(TURNOVER_ASK_CODE, "turnover-ask");
  // pending, a reader's deny, an expiry, and a record that is gone.
  assert.deepEqual(permissionStateOf({ status: "pending" }), { pending: true, choice: null, expired: false, by: null, why: "waiting for your answer" });
  const denied = permissionStateOf({ status: "answered", choice: "deny", by: "reader", why: "denied by the reader" });
  assert.equal(denied.pending, false);
  assert.equal(denied.expired, false);
  assert.equal(denied.choice, "deny");
  const expired = permissionStateOf({ status: "answered", choice: "deny", by: "timeout", why: "no answer inside the window" });
  assert.equal(expired.expired, true, "a timeout is an expiry, not a reader's denial");
  const gone = permissionStateOf({ status: "unknown" });
  assert.equal(gone.expired, true, "a record the panel no longer holds releases the row rather than parking it for ever");
  // A row id is found in the queue that actually holds it, and in no other.
  const p = { assistants: [{ id: "assistant-1", name: "one" }], queuePathOf: () => path.join(tmpdir(), "wag-no-such-queue.json") };
  assert.equal(queueOwnerOf(p, 1), null);
  assert.equal(queueOwnerOf(p, 0), null);
});
