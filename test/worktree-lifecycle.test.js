// The worktree lifecycle, asserted against a real repo and a real panel:
//
//   - a worktree removed behind the panel's back (`git worktree remove` in a shell) loses its row on the next
//     full scan. The row used to live in the store's Map for the life of the process, because only the panel's
//     own ✕ called dropRow. This is the ghost row the Menu project showed 22 of.
//   - a locked worktree cannot be deleted: the delete route answers 409 with the lock named, and unlocking it
//     lets the same call through.
//   - a locked BRANCH protects a worktree created on it later, without that tree being locked itself.
//   - the lock survives a store reload (a second Locks instance over the same file).
//
// Every integration test boots the real server against a throwaway git repo and drives the routes the page
// drives. The assertions are about answers and state, not about the source.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Locks } from "../lib/locks.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

// One git call, synchronous and quiet: the fixture's git work is a handful of commands and the test's
// own assertions are what matter. windowsHide keeps a console from flashing in the suite.
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();

const slash = (p) => String(p || "").replace(/\\/g, "/");

// A repo with one commit on main. Every test gets its own, so nothing shares a git directory.
async function makeRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-life-"));
  const repo = path.join(root, "proj");
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { root, repo };
}

// Poll until predicate(state) is true. A scan is asynchronous by design (the page gets events), so the
// test waits on the observable answer rather than on a timer that might be too short on a slow box.
async function waitFor(base, predicate, what, { timeout = 20_000, interval = 250 } = {}) {
  const until = Date.now() + timeout;
  let last = null;
  for (;;) {
    const r = await fetch(`${base}/api/state`);
    assert.equal(r.status, 200, "/api/state answers the sandbox");
    last = await r.json();
    if (predicate(last)) return last;
    if (Date.now() > until) {
      const projects = (last?.projects || []).map((p) => `${p.name} (${(p.worktrees || []).length} rows)`).join(", ");
      throw new Error(`timed out waiting for ${what}; projects: ${projects || "none"}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

const projectOf = (snap, name) => (snap.projects || []).find((p) => p.name === name) || null;
const rowOf = (snap, name, wtPath) => {
  const p = projectOf(snap, name);
  return p ? (p.worktrees || []).find((w) => slash(w.path) === slash(wtPath)) || null : null;
};

// Boot's first full pass runs BEFORE registry.refresh() discovers repos created since the last run (server.js
// deliberately does discovery behind the first scan so the board is up fast). In a throwaway sandbox the repo is
// brand new, so the boot pass sees nothing and the row appears only on the next tick. A reload awaits discovery and
// then a full pass, so the row exists by the time this returns — deterministic without waiting out a tick.
async function reload(base) {
  const r = await post(base, "/api/reload", { body: {} });
  assert.equal(r.status, 200, `reload must succeed: ${r.text.slice(0, 200)}`);
}

test("an out-of-band git worktree remove drops its row on the next full scan", async (t) => {
  const { root, repo } = await makeRepo(t);
  const wt = path.join(root, "wt-ghost");
  git(repo, ["worktree", "add", "-b", "feature/ghost", wt]);

  const panel = await startPanel({ config: { scanRoots: [root] } });
  t.after(() => panel.stop());

  // The repo is new to this panel, so discovery lands behind the boot pass; a reload runs both and awaits them.
  await reload(panel.base);
  await waitFor(panel.base, (s) => Boolean(rowOf(s, "proj", wt)), "the worktree row to appear after the reload");

  // The removal the panel never hears about: a worker's own shell, a merge agent's cleanup, a script.
  git(repo, ["worktree", "remove", "--force", wt]);
  await assert.rejects(stat(wt), "the fixture's directory really is gone");

  // A full pass is the scan that reconciles. /api/reload restarts the scheduler and awaits its boot full
  // pass, so the answer to this request is the answer to "did the next scan drop the row?".
  const again = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(again.status, 200, `reload must succeed: ${again.text.slice(0, 200)}`);

  const after = await waitFor(panel.base, (s) => !rowOf(s, "proj", wt), "the ghost row to disappear");
  assert.equal(rowOf(after, "proj", wt), null, "a row for a worktree git no longer lists is gone, not marked ERROR");
  // The project itself is still there: dropping a worktree must never drop its repo.
  assert.ok(projectOf(after, "proj"), "the project survives its worktree's removal");
});

test("a locked worktree refuses deletion with the lock named, and unlocking allows it again", async (t) => {
  const { root, repo } = await makeRepo(t);
  const wt = path.join(root, "wt-locked");
  git(repo, ["worktree", "add", "-b", "feature/locked", wt]);

  const panel = await startPanel({ config: { scanRoots: [root] } });
  t.after(() => panel.stop());

  // The repo is new to this panel, so discovery lands behind the boot pass; a reload runs both and awaits them.
  await reload(panel.base);
  await waitFor(panel.base, (s) => Boolean(rowOf(s, "proj", wt)), "the worktree row to appear after the reload");

  const lock = await post(panel.base, "/api/worktree/lock", { body: { project: "proj", path: wt, scope: "tree" } });
  assert.equal(lock.status, 200, `lock must be accepted: ${lock.text.slice(0, 200)}`);
  assert.equal(lock.json.locked, true, "the answer says the worktree is locked");

  const refused = await post(panel.base, "/api/worktree/delete", { body: { project: "proj", path: wt } });
  assert.equal(refused.status, 409, "a locked worktree's delete is refused, not silently ignored");
  assert.match(refused.json?.error || "", /locked worktree/i, "the refusal names the lock");
  assert.ok((await stat(wt).then(() => true).catch(() => false)), "the refused delete left the directory in place");

  const unlock = await post(panel.base, "/api/worktree/lock", { body: { project: "proj", path: wt, scope: "tree", locked: false } });
  assert.equal(unlock.status, 200, `unlock must be accepted: ${unlock.text.slice(0, 200)}`);
  assert.equal(unlock.json.locked, false, "the answer says the worktree is unlocked");

  const deleted = await post(panel.base, "/api/worktree/delete", { body: { project: "proj", path: wt } });
  assert.equal(deleted.status, 200, `the unlocked delete must go through: ${deleted.text.slice(0, 300)}`);
  assert.equal(deleted.json?.ok, true);
  await waitFor(panel.base, (s) => !rowOf(s, "proj", wt), "the deleted row to leave the board");
});

test("a locked branch protects a worktree created on it later", async (t) => {
  const { root, repo } = await makeRepo(t);
  // The branch exists and is not checked out, which is the turnover-branch shape: trees come and go on it.
  git(repo, ["branch", "feature/turnover"]);

  const panel = await startPanel({ config: { scanRoots: [root] } });
  t.after(() => panel.stop());

  await reload(panel.base);
  await waitFor(panel.base, (s) => Boolean(projectOf(s, "proj")), "the project to appear after the reload");

  // No path: a branch lock is about the branch, and the route accepts that without a row.
  const lock = await post(panel.base, "/api/worktree/lock", { body: { project: "proj", branch: "feature/turnover", scope: "branch" } });
  assert.equal(lock.status, 200, `branch lock must be accepted: ${lock.text.slice(0, 200)}`);
  assert.equal(lock.json.locked, true);

  // A tree cut on the locked branch AFTER the lock — the case the branch scope exists for.
  const wt = path.join(root, "wt-turnover");
  git(repo, ["worktree", "add", wt, "feature/turnover"]);
  const again = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(again.status, 200, `reload must succeed: ${again.text.slice(0, 200)}`);
  await waitFor(panel.base, (s) => Boolean(rowOf(s, "proj", wt)), "the new worktree row to appear");

  const refused = await post(panel.base, "/api/worktree/delete", { body: { project: "proj", path: wt } });
  assert.equal(refused.status, 409, "a worktree on a locked branch is refused, though the tree itself was never locked");
  assert.match(refused.json?.error || "", /locked branch/i, "the refusal names the branch lock");
  assert.ok((await stat(wt).then(() => true).catch(() => false)), "the refused delete left the directory in place");

  const unlock = await post(panel.base, "/api/worktree/lock", { body: { project: "proj", branch: "feature/turnover", scope: "branch", locked: false } });
  assert.equal(unlock.status, 200);
  assert.equal(unlock.json.locked, false);

  const deleted = await post(panel.base, "/api/worktree/delete", { body: { project: "proj", path: wt } });
  assert.equal(deleted.status, 200, `the unlocked delete must go through: ${deleted.text.slice(0, 300)}`);
});

test("a lock survives a store reload", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-locks-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const file = path.join(dir, "logs", "locks.json");

  const first = new Locks({ file });
  const tree = first.setTree("proj", "C:/work/tree", true, { by: "the reader", branch: "feature/turnover" });
  assert.equal(tree.locked, true);
  const branch = first.setBranch("proj", "feature/turnover", true, { by: "the reader" });
  assert.equal(branch.locked, true);

  // A second instance reads the same file: this is the reload, and the lock must be in it.
  const reloaded = new Locks({ file });
  const heldTree = reloaded.check({ project: "proj", path: "C:/work/tree", branch: "feature/turnover" });
  assert.equal(heldTree.locked, true, "the worktree lock survived the reload");
  assert.equal(heldTree.tree, true, "and it is the worktree bit that holds it");
  const heldBranch = reloaded.check({ project: "proj", path: "C:/work/another", branch: "feature/turnover" });
  assert.equal(heldBranch.locked, true, "the branch lock protects a tree the lock never named");
  assert.equal(heldBranch.branchLocked, true, "and it is the branch bit that holds it");
  assert.equal(heldBranch.branch, "feature/turnover", "the branch's name is carried alongside the bit");
  assert.match(heldBranch.reason, /locked branch/i, "the reason names the branch lock");

  // Absence is unlocked: a tree on another branch in another project is not protected by either lock.
  const free = reloaded.check({ project: "other", path: "C:/work/free", branch: "feature/other" });
  assert.equal(free.locked, false, "an unrelated tree stays unlocked");

  // Clearing a lock is persisted too: a second reload must not resurrect it.
  reloaded.setTree("proj", "C:/work/tree", false);
  const third = new Locks({ file });
  assert.equal(third.check({ project: "proj", path: "C:/work/tree" }).tree, false, "an unlocked tree stays unlocked across a reload");
  // The branch lock was not cleared with it.
  assert.equal(third.check({ project: "proj", path: "C:/work/tree", branch: "feature/turnover" }).locked, true);
});
