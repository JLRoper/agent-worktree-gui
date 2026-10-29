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

import { TreeNames, autoNameRefusal, describeNaming, namingState, tagOf, treeKey } from "../lib/tree-names.js";
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
test("a name already taken spends the automatic half's one chance instead of retrying it", async () => {
  const { ledger } = freshLedger();
  const tree = "/repo/demo/.worktrees/land-the-export-4b5c6d";
  const key = treeKey({ project: "demo", path: tree });
  ledger.claimCut(key, { name: "land-the-export-4b5c6d", cutRun: "run-cut", tag: "4b5c6d", by: "run run-cut (t)", at: new Date().toISOString() });
  assert.equal(namingState(ledger.get(key)), "cut");

  // Exactly what renameWorktree writes when the directory it would move the tree to is already there: the tree
  // keeps its first name and the record is settled, so the name is not re-derived on the next event.
  ledger.settle(key, {
    name: "land-the-export-4b5c6d",
    dir: "land-the-export-4b5c6d",
    by: "the panel",
    how: "left under its first name — fix-the-export-4b5c6d was already taken",
    collision: true,
    moved: false,
  });
  const rec = ledger.get(key);
  assert.equal(rec.collision, true);
  assert.equal(namingState(rec), "named", "a collision is a settled name, not an open one");
  assert.match(autoNameRefusal(rec, "run-cut"), /already named by the panel/);

  const { naming, calls } = namingHarness({ ledger });
  await naming.consider({ id: "run-cut", thread: "t", worktreePath: tree, status: "done", title: "A name it cannot have" });
  assert.equal(calls.length, 0, "and nothing offers it another name, so the taken target is not tried again");
});

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
  // A tree waiting for its name must not read as a named one anywhere: the ledger's own predicate and the
  // sentence the row's tooltip shows both say it is still to come.
  assert.equal(ledger.isNamed(key), false, "a cut tree has no name yet");
  assert.match(describeNaming(ledger.get(key)), /still to come/);

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
  assert.equal(ledger.isNamed(key), true, "and once it lands the tree is named");
  assert.match(describeNaming(ledger.get(key)), /^named by run run-cut/);

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
// the rule, stated three ways: ONE name for the session that first runs in a new tree, NOTHING for
// the sessions that follow it, and nothing at all for a tree whose name predates the lock
// =============================================================================================

// A tree whose directory and branch this harness models, so "untouched" can be asserted rather than assumed: the
// fake rename below is the only thing that may move them, and the only thing counted.
function modelledTree(name, tag) {
  return { path: `/repo/demo/.worktrees/${name}-${tag}`, branch: `wtgui/${name}-${tag}`, tag };
}

// The same slug rule the panel's rename uses (server.js `worktreeDirName`), so the fake rename lands on the same
// directory name a real one would and a second rename would be visible as a second move.
function dirNameFor(name, tag) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `${slug}-${tag}` : "";
}

// A rename that behaves like the real one: it moves the modelled tree and settles the ledger record. Anything the
// policy refuses therefore shows up twice — no rename counted, and the tree exactly where it was.
function renamingHarness({ ledger, tree, session, thread, renames }) {
  return namingHarness({
    ledger,
    rename: async ({ name }) => {
      renames.count += 1;
      // The git work is not instant, so a second event of the same turn lands inside the first attempt.
      await sleep(20);
      const dirName = dirNameFor(name, tree.tag);
      tree.path = `/repo/demo/.worktrees/${dirName}`;
      tree.branch = `wtgui/${dirName}`;
      ledger.settle(treeKey({ project: "demo", path: tree.path }), {
        name: dirName,
        dir: dirName,
        branch: tree.branch,
        tag: tree.tag,
        by: `run ${session} (${thread})`,
        how: `Hermes named the session “${name}”`,
        at: new Date().toISOString(),
        moved: true,
      });
      return { ok: true, moved: true };
    },
  });
}

test("the first session in a new tree names it once, and the lock it writes outlives the panel", async () => {
  const { dir, ledger } = freshLedger();
  const session = "sess-first";
  const thread = "thread-first";
  const tree = modelledTree("land-every-piece-of-unla", "adc74e");
  const key = treeKey({ project: "demo", path: tree.path });
  // What lib/jobs.js writes before `git worktree add`: this session, and only this session, may name the tree.
  ledger.claimCut(key, {
    name: path.basename(tree.path),
    dir: path.basename(tree.path),
    branch: tree.branch,
    tag: tree.tag,
    by: `run ${session} (${thread})`,
    how: "cut by this panel — its one name is the run's to give",
    at: new Date().toISOString(),
    cutRun: session,
    cutThread: thread,
  });

  const renames = { count: 0 };
  const { naming, calls } = renamingHarness({ ledger, tree, session, thread, renames });
  const base = { id: session, thread, worktreePath: tree.path, title: "Fix the export" };
  // Two events on one tick — the running one carrying the first title, the done one following it — then one more
  // from the same session. One tree, one name.
  await Promise.all([
    naming.consider({ ...base, status: "running" }),
    naming.consider({ ...base, status: "done" }),
  ]);
  await naming.consider({ ...base, status: "failed", title: "A later title from the same session" });
  assert.equal(renames.count, 1, "the first session named the tree exactly once");
  assert.equal(calls.length, 1);

  // The lock, read off the record the rename wrote: WHO named it (the session id, not a path) and WHEN.
  const rec = ledger.get(key);
  assert.equal(rec.cut, false, "settled — the tree is nobody's to cut again");
  assert.equal(rec.by, `run ${session} (${thread})`, "the lock names the session that renamed it");
  assert.ok(Number.isFinite(Date.parse(rec.renamedAt || "")), "and stamps the moment it happened");
  assert.equal(rec.name, path.basename(tree.path), "the record's name is the name the tree now carries");

  // Written down, not held in memory: a fresh ledger over the same file is the panel after a restart, and it must
  // still know this tree is named — otherwise the very first event after a restart would rename it again.
  const reloaded = new TreeNames({ file: path.join(dir, "tree-names.json") });
  const after = reloaded.get(key);
  assert.equal(namingState(after), "named");
  assert.equal(after.by, `run ${session} (${thread})`, "the session that named it is on disk");
  assert.equal(after.renamedAt, rec.renamedAt, "and so is the moment");
  assert.match(autoNameRefusal(after, "sess-second"), /already named by run sess-first/);
});

test("a second and a third session in the same tree leave its branch and its directory alone", async () => {
  const { ledger } = freshLedger();
  const session = "sess-first";
  const thread = "thread-first";
  const tree = modelledTree("land-every-piece-of-unla", "470b28");
  const key = treeKey({ project: "demo", path: tree.path });
  ledger.claimCut(key, {
    name: path.basename(tree.path),
    dir: path.basename(tree.path),
    branch: tree.branch,
    tag: tree.tag,
    by: `run ${session} (${thread})`,
    how: "cut by this panel — its one name is the run's to give",
    at: new Date().toISOString(),
    cutRun: session,
    cutThread: thread,
  });

  const renames = { count: 0 };
  const { naming, calls } = renamingHarness({ ledger, tree, session, thread, renames });
  await naming.consider({ id: session, thread, worktreePath: tree.path, status: "done", title: "Fix the export" });
  assert.equal(renames.count, 1, "the first session names it");
  const named = { path: tree.path, branch: tree.branch, name: ledger.get(key).name };

  // Two more threads in the same tree, each with a title of its own. Their slugs reach their thread titles and
  // nothing else: no rename is attempted, so neither the directory nor the branch can move.
  const second = await naming.consider({
    id: "sess-second",
    thread: "thread-second",
    worktreePath: tree.path,
    status: "done",
    title: "Something the second session decided to call it",
  });
  const third = await naming.consider({
    id: "sess-third",
    thread: "thread-third",
    worktreePath: tree.path,
    status: "running",
    title: "And a third session's title",
  });
  assert.equal(renames.count, 1, "no second rename was even attempted");
  assert.equal(calls.length, 1);
  assert.equal(tree.path, named.path, "the directory is exactly where the first session left it");
  assert.equal(tree.branch, named.branch, "and the branch is still the one the first session gave it");
  assert.match(second.skipped, /already named by run sess-first/, "the second session is told whose name it is");
  assert.match(third.skipped, /already named by run sess-first/, "so is the third");
  assert.equal(ledger.get(key).name, named.name, "the record still carries the first name");
  assert.equal(ledger.get(key).by, `run ${session} (${thread})`, "and credits the first session, not the later ones");
});

test("a tree whose name predates the lock — a wtgui branch and a directory, no record — is left alone", async () => {
  const { ledger } = freshLedger();
  const tree = modelledTree("build-a-project-steward", "667552");
  const at = { path: tree.path, branch: tree.branch };
  const key = treeKey({ project: "demo", path: tree.path });
  assert.equal(ledger.get(key), null, "no record at all: what every tree cut before the ledger looked like");

  const renames = { count: 0 };
  const { naming, calls } = namingHarness({
    ledger,
    rename: async () => {
      renames.count += 1;
      return { ok: true, moved: true };
    },
  });
  // A session starts in it. The tree already HAS a wtgui/… branch and a directory, so it is already named —
  // the absence of a lock is not an invitation to write one.
  const second = await naming.consider({
    id: "sess-second",
    thread: "thread-second",
    worktreePath: tree.path,
    status: "done",
    existing: false,
    title: "A name it must not take",
  });
  assert.equal(renames.count, 0, "nothing moved it");
  assert.equal(calls.length, 0);
  assert.equal(tree.path, at.path, "the directory is where it was");
  assert.equal(tree.branch, at.branch, "and so is the branch");
  assert.match(second.skipped, /no cut record/, "the refusal says why: no run cut this tree");

  // The boot backfill then writes it down under the name it was found with — and that is a NAME, not a licence.
  ledger.seed(key, {
    name: path.basename(tree.path),
    dir: path.basename(tree.path),
    branch: tree.branch,
    tag: tree.tag,
    by: "the panel",
    how: "seeded — this tree was already here the first time the panel listed it",
    at: new Date().toISOString(),
  });
  const third = await naming.consider({
    id: "sess-third",
    thread: "thread-third",
    worktreePath: tree.path,
    status: "done",
    title: "Another name entirely",
  });
  assert.equal(renames.count, 0, "still nothing moved it");
  assert.equal(tree.path, at.path);
  assert.equal(tree.branch, at.branch);
  assert.match(third.skipped, /already named by the panel/);
  assert.equal(namingState(ledger.get(key)), "named", "the record says named, so no later session may ask again");
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

  // The seeding is the panel's own act, and it says so in the log — a fleet written down by something else
  // would leave exactly the hole this closes (a tree with no entry reads as one waiting for a name).
  const log = panel.log();
  assert.match(log, /tree-names: seeded demo-repo::build-a-project-steward-667552 as it was found/, `the seed is logged\n${log.slice(-1500)}`);
  assert.match(log, /tree-names: \d+ tree\(s\) had no record/, `the boot backfill reports what it wrote\n${log.slice(-1500)}`);

  // The project's own checkout is not a tree the panel names — its name is the folder's — so it is not seeded.
  assert.ok(!trees[`${projectName}::path:${norm(repo())}`], "the checkout at the project path has no naming record");
  assert.ok(
    Object.values(trees).every((rec) => norm(rec.dir || "") !== norm(repo())),
    "nothing in the ledger calls the project checkout a named tree",
  );
});

test("the boot backfill seeds the fleet from `git worktree list`, before any row is scanned", async () => {
  // A panel that cannot discover anything — no scan root — over a discovery cache naming the repo. The only
  // listing that can answer for these trees is the boot backfill's own, which is what "seeded at boot" means:
  // the record exists before the board has a row for the tree, so no run can ever find it unrecorded.
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-naming-boot-"));
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    path.join(logs, "projects.json"),
    JSON.stringify({ savedAt: new Date().toISOString(), projects: [{ name: "demo-repo", path: repo() }] }),
    "utf8",
  );
  const boot = await startPanel({
    config: { scanRoots: [], jobsFile: path.join(logs, "jobs.json"), projectsCacheFile: path.join(logs, "projects.json") },
  });
  try {
    const file = path.join(logs, "tree-names.json");
    await waitFor(() => existsSync(file) && Object.keys(JSON.parse(readFileSync(file, "utf8")).trees || {}).length >= 2, {
      timeoutMs: 30_000,
      what: "the boot backfill to write the fleet down",
    });
    const trees = JSON.parse(readFileSync(file, "utf8")).trees;
    for (const [dirName, tag] of [[FIXED, "667552"], [MANUAL, "abcdef"]]) {
      const rec = trees[`demo-repo::${tag}`];
      assert.ok(rec, `${dirName} was written down by the boot backfill`);
      assert.equal(rec.name, dirName);
      assert.equal(rec.seeded, true);
      assert.equal(namingState(rec), "named");
    }
    assert.match(boot.log(), /tree-names: 2 tree\(s\) had no record/, `the boot backfill reported both\n${boot.log().slice(-1500)}`);
  } finally {
    await boot.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
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
