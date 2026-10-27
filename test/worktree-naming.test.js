// A tree's name is static for life, with exactly one rename allowed and only right after the tree is cut.
//
//   node --test test/worktree-naming.test.js
//
// Two halves, because the rule lives in two places:
//
//   * lib/tree-names.js + lib/worktree-naming.js directly — the decisions, with no git in them: a tree the panel
//     FOUND is seeded and never renamed by a later run (whatever that run's own `existing` flag says); a tree the
//     panel CUT is renamed exactly once, on the first title, even when a done and a failed event land on one tick;
//   * a real panel (tools/panel-testkit.mjs) over a throwaway repo — the halves that are git: the boot backfill
//     writing down the trees that were already there, a reader's rename settling the record, and the 409 a taken
//     directory earns without moving anything.
//
// Nothing here touches the live panel or the live fleet: its own temp repo, its own config, its own logs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { TreeNames, autoNameRefusal, namingState, tagOf, treeKey } from "../lib/tree-names.js";
import { WorktreeNaming } from "../lib/worktree-naming.js";
import { startPanel, post } from "../tools/panel-testkit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
async function waitFor(fn, { timeoutMs = 30_000, stepMs = 200, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(stepMs);
  }
}
const git = (dir, args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim();

// A ledger of its own per test: a temp directory, no shared file, no state from a previous case.
function freshLedger() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-names-"));
  return { dir, ledger: new TreeNames({ file: path.join(dir, "tree-names.json") }) };
}

// The policy with a fake rename: everything WorktreeNaming asks of the panel, answered from the test.
function namingHarness({ ledger, project = { name: "demo", path: "/repo/demo" }, title = "Fix the delete button", busy = false, rename = null, ready = null }) {
  const calls = [];
  const naming = new WorktreeNaming({
    ledger,
    projectForPath: () => project,
    titleFor: (job) => job.title ?? title,
    isBusy: () => busy,
    rename: async (args) => {
      calls.push(args);
      return rename ? rename(args) : { ok: true, moved: true };
    },
    log: () => {},
    ready,
  });
  return { naming, calls };
}

// =============================================================================================
// the decisions
// =============================================================================================
test("a seeded tree cannot be renamed by a later run, even one that says it cut it", async () => {
  const { ledger } = freshLedger();
  const tree = "/repo/demo/.worktrees/build-a-project-steward-667552";
  const key = treeKey({ project: "demo", path: tree });
  const seeded = ledger.seed(key, {
    name: "build-a-project-steward-667552",
    dir: "build-a-project-steward-667552",
    branch: "wtgui/build-a-project-steward-667552",
    tag: "667552",
    by: "the panel",
    how: "seeded — this tree was already here the first time the panel listed it",
    at: new Date().toISOString(),
  });

  assert.equal(namingState(seeded), "named", "a seeded tree is named from the moment it is recorded");
  assert.match(autoNameRefusal(seeded, "run-later"), /already named by the panel/);

  const { naming, calls } = namingHarness({ ledger });
  // `existing: false` is the job's own claim that its run cut the tree — the flag that used to be the only guard.
  // It is deliberately wrong here: the ledger, not the flag, decides.
  const out = await naming.consider({
    id: "run-later",
    thread: "thread-later",
    worktreePath: tree,
    status: "done",
    existing: false,
    title: "A brand new name the tree must not take",
  });
  assert.equal(calls.length, 0, "no rename was attempted");
  assert.match(out.skipped, /already named/);
  assert.equal(ledger.get(key).name, "build-a-project-steward-667552", "the record still says the name it was found with");
  assert.equal(ledger.get(key).seeded, true, "seed() is what wrote it, and nothing overwrote it");
});

test("a freshly cut tree is renamed once, on the first title, whatever the run's status", async () => {
  const { ledger } = freshLedger();
  const tree = "/repo/demo/.worktrees/land-every-piece-of-unla-adc74e";
  const key = treeKey({ project: "demo", path: tree });
  ledger.claimCut(key, {
    name: "land-every-piece-of-unla-adc74e",
    dir: "land-every-piece-of-unla-adc74e",
    branch: "wtgui/land-every-piece-of-unla-adc74e",
    tag: "adc74e",
    by: "run run-cut (thread-cut)",
    how: "cut by this panel",
    at: new Date().toISOString(),
    cutRun: "run-cut",
    cutThread: "thread-cut",
  });
  assert.equal(namingState(ledger.get(key)), "cut");

  let renames = 0;
  const { naming, calls } = namingHarness({
    ledger,
    rename: async () => {
      renames += 1;
      await sleep(25); // the git work takes a moment; a second event lands inside it
      ledger.settle(key, {
        name: "fix-delete-worktree-button-adc74e",
        dir: "fix-delete-worktree-button-adc74e",
        branch: "wtgui/fix-delete-worktree-button-adc74e",
        tag: "adc74e",
        by: "run run-cut (thread-cut)",
        how: "Hermes named the session",
        at: new Date().toISOString(),
        moved: true,
      });
      return { ok: true, moved: true };
    },
  });

  // The first event is a RUNNING run with a title: the old code waited for a terminal status, which is the
  // "named at the end of a later turn" the reader objected to. The title is the trigger.
  const base = { id: "run-cut", thread: "thread-cut", worktreePath: tree, title: "Fix delete worktree button" };
  const [a, b] = await Promise.all([
    naming.consider({ ...base, status: "running" }),
    naming.consider({ ...base, status: "done" }),
  ]);
  assert.equal(renames, 1, "one title, one rename — the second event on the same tick changed nothing");
  assert.ok(a || b, "at least one attempt ran");
  assert.equal(calls.length, 1);
  assert.equal(ledger.get(key).name, "fix-delete-worktree-button-adc74e");
  assert.equal(namingState(ledger.get(key)), "named");

  // Every later event of the same run, and every later run into the tree, leaves it alone.
  await naming.consider({ ...base, status: "failed" });
  await naming.consider({ ...base, status: "cancelled" });
  await naming.consider({ ...base, id: "run-other", thread: "thread-other", status: "done", title: "Something else" });
  assert.equal(renames, 1, "no second rename for this tree, whatever arrives");
});

test("a run that did not cut the tree cannot name it, even before the cut run has", async () => {
  const { ledger } = freshLedger();
  const tree = "/repo/demo/.worktrees/shared-tree-1a2b3c";
  const key = treeKey({ project: "demo", path: tree });
  ledger.claimCut(key, { name: "shared-tree-1a2b3c", cutRun: "run-cut", tag: "1a2b3c", by: "run run-cut (t)", at: new Date().toISOString() });

  const { naming, calls } = namingHarness({ ledger });
  await naming.consider({ id: "run-second", thread: "t2", worktreePath: tree, status: "done", title: "Second run's title" });
  assert.equal(calls.length, 0, "the second run's title was not used");
  // The cut run itself still may, so the refusal is about the run, not about the tree being frozen too early.
  await naming.consider({ id: "run-cut", thread: "t", worktreePath: tree, status: "running", title: "The cut run's title" });
  assert.equal(calls.length, 1, "the run that cut it still gets its one name");
});

test("a tree nobody recorded is never renamed, and nothing is decided before the boot seeding lands", async () => {
  const { ledger } = freshLedger();
  const unknown = "/repo/demo/.worktrees/unknown-tree-9f9f9f";
  const { naming, calls } = namingHarness({ ledger });

  // The shape a pre-ledger tree had: NO entry at all. It reads as "unnamed" to every rule that asks the ledger
  // only "is there a record?", so the policy refuses it — the name it has is the name it keeps.
  await naming.consider({ id: "run-old", thread: "t", worktreePath: unknown, status: "done", title: "Old run's title" });
  assert.equal(calls.length, 0);
  assert.match(autoNameRefusal(ledger.get(treeKey({ project: "demo", path: unknown })), "run-old"), /no cut record/);

  // And a tree that IS this run's to name is still not decided before the backfill has had its say: the first
  // event of a restored run can arrive while `git worktree list` is still walking the fleet.
  const cut = "/repo/demo/.worktrees/fresh-tree-2c3d4e";
  const cutKey = treeKey({ project: "demo", path: cut });
  ledger.claimCut(cutKey, { name: "fresh-tree-2c3d4e", cutRun: "run-cut", tag: "2c3d4e", by: "run run-cut (t)", at: new Date().toISOString() });
  let release = null;
  const gate = new Promise((r) => (release = r));
  const gated = namingHarness({ ledger, ready: gate, title: "The title of the first turn" });
  const pending = gated.naming.consider({ id: "run-cut", thread: "t", worktreePath: cut, status: "done", title: "The title of the first turn" });
  await sleep(30);
  assert.equal(gated.calls.length, 0, "nothing is attempted while the boot seeding is still running");
  release();
  await pending;
  assert.equal(gated.calls.length, 1, "and the attempt lands as soon as it has");
});

// =============================================================================================
// the panel, over a real repo
// =============================================================================================
const FIXED = "build-a-project-steward-667552"; // a tree that predates the ledger: no entry, must be seeded
const MANUAL = "second-tree-abcdef"; // the tree a reader renames by hand
const COLLIDE = "collide-here-667552"; // a plain directory already sitting where FIXED's rename would land

let sandbox = null;
let panel = null;
let projectName = null;
const repo = () => path.join(sandbox, "demo-repo");
const treePath = (name) => path.join(repo(), ".worktrees", name);
const ledgerPath = () => path.join(sandbox, "panel-logs", "tree-names.json");
const ledgerFile = () => JSON.parse(readFileSync(ledgerPath(), "utf8"));
const state = async () => (await fetch(`${panel.base}/api/state`)).json();

before(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), "wtgui-naming-panel-"));
  const repoDir = repo();
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(path.join(repoDir, ".worktrees"), { recursive: true });
  git(repoDir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repoDir, "README.md"), "# demo\n", "utf8");
  git(repoDir, ["add", "."]);
  git(repoDir, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "first"]);
  git(repoDir, ["worktree", "add", "-q", "-b", `wtgui/${FIXED}`, treePath(FIXED), "HEAD"]);
  git(repoDir, ["worktree", "add", "-q", "-b", `wtgui/${MANUAL}`, treePath(MANUAL), "HEAD"]);
  // Taken already, by something that is not a worktree: the rename must refuse and leave the tree as it was.
  mkdirSync(treePath(COLLIDE), { recursive: true });

  // The discovery cache is what the boot backfill reads: naming it here is the "panel restarted over a fleet it
  // already knew" case, which is exactly the fleet that had no entries.
  const logs = path.join(sandbox, "panel-logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    path.join(logs, "projects.json"),
    JSON.stringify({ savedAt: new Date().toISOString(), projects: [{ name: "demo-repo", path: repoDir }] }),
    "utf8",
  );
  panel = await startPanel({
    config: {
      scanRoots: [sandbox],
      jobsFile: path.join(logs, "jobs.json"),
      projectsCacheFile: path.join(logs, "projects.json"),
    },
  });
  await waitFor(
    async () => {
      const s = await state();
      const p = s.projects?.find((x) => norm(x.path) === norm(repoDir));
      if (!p) return false;
      projectName = p.name;
      return [FIXED, MANUAL].every((t) => p.worktrees?.some((w) => norm(w.path) === norm(treePath(t))));
    },
    { timeoutMs: 60_000, what: "the sandbox repo and its two worktree rows" },
  );
});

after(async () => {
  if (panel) await panel.stop();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

test("the boot backfill writes down every tree it finds, under the name it was found with", async () => {
  await waitFor(() => existsSync(ledgerPath()) && Object.keys(ledgerFile().trees || {}).length >= 2, {
    timeoutMs: 30_000,
    what: "the ledger to hold the fleet",
  });
  const trees = ledgerFile().trees;
  for (const [dir, tag] of [[FIXED, "667552"], [MANUAL, "abcdef"]]) {
    const rec = trees[`${projectName}::${tag}`];
    assert.ok(rec, `${dir} has a record`);
    assert.equal(rec.name, dir, "the name it was found with is the name written down");
    assert.equal(rec.seeded, true);
    assert.equal(rec.cut, false, "a tree the panel found is not a tree it cut");
    assert.equal(rec.by, "the panel");
    assert.match(String(rec.how || ""), /seeded/);
    assert.ok(Number.isFinite(Date.parse(rec.at || "")), "the moment it was written down is real");
    assert.equal(namingState(rec), "named");
  }
  // What the board's row reads: the same record, so the tooltip can say who named it and when.
  const s = await state();
  const row = s.projects.find((p) => p.name === projectName).worktrees.find((w) => norm(w.path) === norm(treePath(FIXED)));
  assert.match(String(row.named?.line || ""), /named by the panel/);
});

test("a manual rename moves the tree once, writes the ledger, and settles it for good", async () => {
  const wasAt = treePath(MANUAL);
  const out = await post(panel.base, "/api/worktree/rename", {
    body: { project: projectName, path: wasAt, name: "a better name", by: "the reader" },
  });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.moved, true, "nothing held the directory, so it moved");
  const nowAt = treePath("a-better-name-abcdef");
  assert.equal(existsSync(wasAt), false, "the old directory is gone");
  assert.equal(existsSync(nowAt), true, "the new one is there");
  assert.equal(git(nowAt, ["symbolic-ref", "--short", "HEAD"]), "wtgui/a-better-name-abcdef");

  const rec = ledgerFile().trees[`${projectName}::abcdef`];
  assert.equal(rec.name, "a-better-name-abcdef");
  assert.equal(rec.by, "the reader");
  assert.equal(rec.cut, false);
  assert.ok(rec.renamedAt, "the record says when the name was settled");
  // The record a manual rename writes is the same one the automatic half consults — and it refuses it.
  assert.match(autoNameRefusal(rec, "run-that-came-later"), /already named by the reader/);
});

test("a taken directory is a 409 that moves nothing and settles nothing", async () => {
  const wasAt = treePath(FIXED);
  const out = await post(panel.base, "/api/worktree/rename", {
    body: { project: projectName, path: wasAt, name: "collide here", by: "the reader" },
  });
  assert.equal(out.status, 409, out.text);
  assert.match(String(out.json.error || ""), /already exists/);
  assert.equal(existsSync(wasAt), true, "the tree is where it was");
  assert.equal(existsSync(treePath(COLLIDE)), true, "and the directory that was in the way is untouched");

  const rec = ledgerFile().trees[`${projectName}::667552`];
  assert.equal(rec.name, FIXED, "the record still says the name it was found with");
  assert.equal(rec.seeded, true);
  assert.equal(rec.cut, false);
  // A refused reader's rename is not a name: the tree stays exactly as it was, seeded and un-renamed.
  assert.equal(tagOf(wasAt), "667552");
  assert.match(autoNameRefusal(rec, "run-later"), /already named by the panel/);
});
