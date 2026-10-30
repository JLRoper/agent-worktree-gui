// The ＋ route, proved over HTTP against the real server on its own port.
//
//   POST /api/worktree/child {project, path, name?}
//
// The cut itself is proved in test/child-worktree.test.js against real git. This file is about the wiring the page
// talks to, and about the ONE claim that only the route can make: the tree it cuts is a tree the ROLL-UP will accept.
// That is two records and a boarded row, not one git command — a cut child with no ParentBook record reads as a
// guess, and a guess may not drive a merge — so the last case asks the rollup route itself for its preview.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    .replace(/\r\n/g, "\n")
    .trim();
const slash = (p) => String(p || "").replace(/\\/g, "/");

async function waitForRow(base, name, treePath, ms = 30_000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    const state = await (await fetch(`${base}/api/state`)).json();
    last = (state.projects || []).find((p) => p.name === name);
    const row = (last?.worktrees || []).find((w) => slash(w.path) === slash(treePath));
    if (row) return row;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the board never held ${treePath}: ${JSON.stringify(last && last.worktrees)}`);
}

test("the child route cuts from the row's branch, records the cut, and hands the rollup a rollable child", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "wtgui-childroute-"));
  const scanRoot = path.join(base, "repos");
  const repo = path.join(scanRoot, "proj");
  await mkdir(repo, { recursive: true });

  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", ["child", "local"].join(String.fromCharCode(64))]);
  git(repo, ["config", "user.name", "Child Route"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main: base"]);

  // The parent row: a worktree on its own branch, one commit of its own — the branch a child is cut from.
  const parentTree = path.join(repo, ".worktrees", "feat-parent");
  git(repo, ["worktree", "add", "-q", "-b", "feat/parent", parentTree]);
  await writeFile(path.join(parentTree, "parent.txt"), "the parent's work\n", "utf8");
  git(parentTree, ["add", "."]);
  git(parentTree, ["commit", "-q", "-m", "parent: its own commit"]);
  const parentSha = git(parentTree, ["rev-parse", "HEAD"]);

  // main moves on AFTER the parent was cut, so a child cut from HEAD is a different sha and a different tree.
  await writeFile(path.join(repo, "later.txt"), "main moved on\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main: later"]);

  const panel = await startPanel({ config: { scanRoots: [scanRoot] } });
  t.after(async () => {
    await panel.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const reload = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(reload.status, 200, `reload must succeed: ${reload.text.slice(0, 200)}`);
  // The snapshot's own spelling is what the page posts back; the route matches that string.
  const parentRow = await waitForRow(panel.base, "proj", parentTree);

  // Refusals first: the project's own checkout is not a worktree, an unknown project and an unknown path are 404s.
  const root = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: repo } });
  assert.equal(root.status, 409, `the checkout is refused: ${root.text.slice(0, 200)}`);
  assert.match(root.json?.error || "", /own checkout, not a worktree/);

  const noProject = await post(panel.base, "/api/worktree/child", { body: { project: "nope", path: parentRow.path } });
  assert.equal(noProject.status, 404);
  assert.match(noProject.json?.error || "", /unknown project/);

  const noRow = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: path.join(base, "elsewhere") } });
  assert.equal(noRow.status, 404, "a path no row holds is a 404, not a cut somewhere else");

  // The press. The name is the reader's; the tag is the server's.
  const cut = await post(panel.base, "/api/worktree/child", {
    body: { project: "proj", path: parentRow.path, name: "child of feat/parent" },
  });
  assert.equal(cut.status, 200, `the cut must answer 200: ${cut.text.slice(0, 400)}`);
  const made = cut.json;
  assert.equal(made.ok, true);
  assert.match(made.branch, /^wtgui\/child-of-feat-parent-[0-9a-f]{6}$/);
  assert.equal(made.parent, "feat/parent");
  assert.equal(made.parentSha, parentSha, "the parent's tip at the cut is on the answer, so the page can name it");
  assert.equal(slash(made.path), `${slash(repo)}/.worktrees/${path.basename(made.path)}`);
  assert.match(slash(made.path), /\/\.worktrees\/child-of-feat-parent-[0-9a-f]{6}$/, "the tree lands inside the project, where the board holds rows");

  // What git says, not what the answer says.
  assert.equal(git(made.path, ["rev-parse", "HEAD"]), parentSha);
  assert.equal(git(made.path, ["rev-parse", "--abbrev-ref", "HEAD"]), made.branch);
  assert.equal(existsSync(path.join(made.path, "parent.txt")), true);
  assert.equal(existsSync(path.join(made.path, "later.txt")), false, "the child came from the parent, not from main");
  assert.match(git(repo, ["worktree", "list", "--porcelain"]), new RegExp(`worktree ${made.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // The parent's own tree did not move and did not gain the child's branch as a checkout.
  assert.equal(git(parentTree, ["rev-parse", "HEAD"]), parentSha);
  assert.equal(git(parentTree, ["status", "--porcelain"]), "", "a cut writes nothing into the parent's tree");

  // The parent book says "cut" — the only source the roll-up will act on — and the row is on the board.
  const parents = await (await fetch(`${panel.base}/api/parents?project=proj`)).json();
  const rec = (parents.parents || []).find((r) => r.branch === made.branch);
  assert.ok(rec, `the cut is written down as a parent record: ${JSON.stringify(parents.parents)}`);
  assert.equal(rec.parent, "feat/parent");
  assert.equal(rec.parentSource, "cut", "a guess would refuse the roll-up");
  assert.equal(rec.parentSha, parentSha);

  const childRow = await waitForRow(panel.base, "proj", made.path);
  assert.equal(childRow.branch, made.branch, "the child is boarded by the route, not by the next discovery pass");

  // The claim the button exists for: the rollup route accepts this child, and names the parent it would write in.
  const preview = await post(panel.base, "/api/worktree/rollup", { body: { project: "proj", path: childRow.path } });
  assert.equal(preview.status, 428, `a roll preview (no confirm) is the route working: ${preview.text.slice(0, 300)}`);
  assert.equal(preview.json?.parent, "feat/parent");
  assert.equal(preview.json?.branch, made.branch);

  // A second press is a SECOND child of the same branch: the tag is what makes the name unique, so both stand.
  const second = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: parentRow.path } });
  assert.equal(second.status, 200, second.text.slice(0, 300));
  assert.notEqual(second.json.path, made.path);
  assert.notEqual(second.json.branch, made.branch);
  assert.match(second.json.branch, /^wtgui\/parent-[0-9a-f]{6}$/, "with no name, the child is named after the branch's last word");
  await waitForRow(panel.base, "proj", second.json.path);
});
