// A junctioned `node_modules` is a trap for every removal path in this panel, and this file is where the trap is
// measured and where the way out of it is held.
//
// WHAT WAS MEASURED (Windows 11, git 2.53.0.windows.3, node 24, current main):
//
//   `git worktree remove <tree>` — the release path's own step 9 — WALKS THROUGH a directory reparse point. Against a
//   tree whose `node_modules` is a junction onto the primary checkout's own it exits 0, prints nothing, drops git's
//   record, and leaves the PRIMARY's `node_modules` EMPTY: every entry deleted, dot-prefixed ones first, in the order
//   a recursive walk reaches them. The panel's ✕ path is one Recycle Bin failure away from the same act — its recycle
//   step is best effort by design and its fallback is `git worktree remove --force` — and the steward's apply path
//   runs the same git command. Nothing on the tree's own side undoes it.
//
// So every removal path in `lib/` unlinks the links first (lib/junction-links.js) and REFUSES rather than deleting
// through one it cannot take out. The tests below are in three groups, deliberately:
//
//   1. the hazard itself, kept as the negative control: a raw `git worktree remove` with the link still standing is
//      the thing that empties the primary's dependencies. It is the measurement this fix exists for — if git ever
//      stops recursing through a junction this is the assertion to retire, and the guards below still stand;
//   2. the guards, one per removal path, each driven for real against a scratch repo: the ✕ path
//      (lib/worktree-remove.js), the guarded release path (lib/worktrees.js) and the steward's apply
//      (lib/steward.js). Every one of them FAILS on the code before this change — the primary's node_modules comes
//      back empty — which is what "fails when the link is not unlinked first" means here;
//   3. the refusal half. It cannot be driven on this box: measured, `rmdir` on a junction succeeds even with a
//      process standing inside it and always leaves the target intact, so there is no way to make the unlink fail
//      for real. It is proved where it is decided instead — the pure sentence, and the ORDER of the refusal against
//      every `git worktree remove` call in the three files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { linkRefusal, linkedDirsIn, unlinkLinkedDirs } from "../lib/junction-links.js";
import { applyPlan } from "../lib/steward.js";
import { removeWorktreeDir } from "../lib/worktree-remove.js";
import { releaseWorktree } from "../lib/worktrees.js";
import { configureRepo, git, readSource, slash } from "../tools/panel-testkit.mjs";

// `mklink /J` is a cmd builtin and junctions are a Windows thing: the rest of the suite is platform-agnostic, this
// file is not.
const onWindows = process.platform === "win32";
const skip = !onWindows && "a junctioned node_modules is a Windows fixture (mklink /J)";

const exists = (p) => lstat(p).then(() => true).catch(() => false);

// The primary checkout's dependencies, dot-prefixed entries FIRST — the order the fleet's own transcript reported
// them disappearing in.
const ENTRIES = [
  ".bin/tsc",
  ".bin/vitest",
  ".cache/blob-a",
  ".cache/blob-b",
  ".package-lock.json",
  "aaa-dep/index.js",
  "aaa-dep/package.json",
  "deep/pkg/nested/leaf.js",
  "zzz-dep/index.js",
];

async function seedDeps(deps) {
  for (const rel of ENTRIES) {
    const file = path.join(deps, ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `// ${rel}\n`, "utf8");
  }
}

// Every entry under a directory, as relative paths — so "the primary survived" is a comparison of what it HOLDS and
// not merely of whether the directory still exists (git leaves the emptied directory behind).
async function walk(dir, out = [], base = dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    return out.concat(`<unreadable: ${e.code}>`);
  }
  for (const name of names) {
    const p = path.join(dir, name);
    const st = await lstat(p).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) out.push(`LINK ${path.relative(base, p)}`);
    else if (st.isDirectory()) {
      out.push(`DIR  ${path.relative(base, p)}`);
      await walk(p, out, base);
    } else out.push(`FILE ${path.relative(base, p)}`);
  }
  return out.sort();
}

// The one junction-maker in this file. Native paths with backslashes: `mklink` is a cmd builtin and does not read
// MSYS-style paths.
function makeJunction(link, target) {
  execFileSync("cmd", ["/c", "mklink", "/J", link.replace(/\//g, "\\"), target.replace(/\//g, "\\")], {
    cwd: path.dirname(link),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

// A primary checkout with a tree the fleet prepared: a real worktree of it whose `node_modules` is a junction onto
// the checkout's own `node_modules`, which is what every worktree this fleet cuts looks like.
async function preparedTree(name, { branch = `wtgui/${name}` } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-link-"));
  const primary = path.join(root, "primary");
  await mkdir(primary, { recursive: true });
  git(primary, ["init", "-q", "-b", "main"]);
  configureRepo(primary);
  await writeFile(path.join(primary, ".gitignore"), "node_modules/\n", "utf8");
  const deps = path.join(primary, "node_modules");
  await seedDeps(deps);
  git(primary, ["add", "."]);
  git(primary, ["commit", "-q", "-m", "the checkout, its ignore rule and nothing else"]);
  const tree = path.join(primary, ".worktrees", name);
  git(primary, ["worktree", "add", "-q", "-b", branch, slash(tree)]);
  const link = path.join(tree, "node_modules");
  makeJunction(link, deps);
  return { root, primary, tree, link, deps, branch };
}

const ROOTS = [];
test.after(async () => {
  for (const root of ROOTS) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
});
const track = (fixture) => {
  ROOTS.push(fixture.root);
  return fixture;
};

// ── 1. the hazard, as measured ────────────────────────────────────────────────────────────────────────────────
test("git worktree remove walks THROUGH a junctioned node_modules — the measurement this fix exists for", { skip }, async () => {
  const { primary, tree, deps } = track(await preparedTree("wt-hazard"));
  const before = await walk(deps);
  assert.equal(before.filter((l) => l.startsWith("FILE")).length, ENTRIES.length, "the fixture holds every dependency");

  const out = execFileSync("git", ["-C", slash(primary), "worktree", "remove", slash(tree)], { encoding: "utf8", windowsHide: true });

  assert.equal(out.trim(), "", "git says nothing at all");
  assert.equal(await exists(tree), false, "and the tree it was asked to remove is gone");
  assert.deepEqual(await walk(deps), [], "while the PRIMARY's node_modules is emptied through the link — every entry, dot-prefixed first");
});

// ── 2. the guards: one per removal path in lib/ ───────────────────────────────────────────────────────────────
test("the ✕ path unlinks the junction before git touches the tree, and the primary keeps its dependencies", { skip }, async () => {
  const { primary, tree, link, deps } = track(await preparedTree("wt-cross"));
  const before = await walk(deps);

  // `platform: linux` is the documented fallback — the Recycle Bin is best effort and this is the shape of the run
  // where the shell cannot reach it. It is also what keeps a test fixture out of the reader's own Recycle Bin.
  const out = await removeWorktreeDir({ projectPath: primary, target: tree, platform: "linux" });

  assert.equal(out.ok, true, `the removal must succeed: ${out.error || ""}`);
  // The invariant first, so a failure names the DAMAGE rather than a missing field: without the unlink this is the
  // assertion that fires, with the primary's node_modules coming back empty.
  assert.deepEqual(await walk(deps), before, "the primary's node_modules is untouched");
  assert.deepEqual(out.unlinked.map((p) => slash(p)), [slash(link)], "the answer names the link it took out first");
  assert.equal(await exists(tree), false, "the tree is gone");
  assert.doesNotMatch(git(primary, ["worktree", "list", "--porcelain"]), /wt-cross/, "and git no longer lists it");
});

test("the guarded release path unlinks it too, and reports the junction step before the worktree step", { skip }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-link-land-"));
  ROOTS.push(root);
  const remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", slash(remote)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const proj = path.join(root, "proj");
  await mkdir(proj, { recursive: true });
  git(proj, ["init", "-q", "-b", "main"]);
  configureRepo(proj);
  await writeFile(path.join(proj, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(path.join(proj, "README.md"), "# test\n", "utf8");
  const deps = path.join(proj, "node_modules");
  await seedDeps(deps);
  git(proj, ["add", "."]);
  git(proj, ["commit", "-q", "-m", "the checkout, its ignore rule and its README"]);
  git(proj, ["remote", "add", "origin", slash(remote)]);
  git(proj, ["push", "-q", "-u", "origin", "main"]);
  execFileSync("git", ["-C", slash(remote), "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // The tree, its branch, and the branch's own commit on the remote.
  const tree = path.join(proj, ".worktrees", "wt-released");
  git(proj, ["worktree", "add", "-q", "-b", "feature", slash(tree)]);
  await writeFile(path.join(tree, "feature.txt"), "the feature\n", "utf8");
  git(tree, ["add", "."]);
  git(tree, ["commit", "-q", "-m", "the feature"]);
  git(tree, ["push", "-q", "-u", "origin", "feature"]);
  const link = path.join(tree, "node_modules");
  makeJunction(link, deps);
  // Main moves on, then takes the branch as one squashed commit: the landing the release path is for.
  await writeFile(path.join(proj, "other.txt"), "somebody else's work\n", "utf8");
  git(proj, ["add", "."]);
  git(proj, ["commit", "-q", "-m", "other work on main"]);
  git(proj, ["merge", "-q", "--squash", "feature"]);
  git(proj, ["commit", "-q", "-m", "the feature (squashed)"]);
  const mergeSha = git(proj, ["rev-parse", "HEAD"]);
  git(proj, ["push", "-q", "origin", "main"]);
  const before = await walk(deps);

  // `gh` is faked at the boundary: this test is about what happens to the LINK, not about how a PR is read.
  const runGh = async (args) => {
    const line = args.join(" ");
    if (line.startsWith("pr list")) {
      return { ok: true, out: JSON.stringify([{ number: 7, state: "MERGED", mergedAt: "2026-11-04T12:00:00Z", headRefName: "feature", headRefOid: mergeSha, title: "the feature" }]), err: "" };
    }
    if (line.startsWith("pr view")) return { ok: true, out: JSON.stringify({ state: "MERGED", mergeCommit: { oid: mergeSha } }), err: "" };
    return { ok: false, out: "", err: `unexpected gh call: ${line}` };
  };

  const out = await releaseWorktree({
    project: { name: "wtgui", path: slash(proj), mainBranch: "main", remote: "origin", releaseWorktrees: true },
    request: { path: slash(tree), branch: "feature" },
    row: null,
    jobs: [],
    runGh,
  });

  assert.equal(out.ok, true, `expected a removal, got: ${out.outcome} ${JSON.stringify(out.steps)}`);
  assert.equal(out.outcome, "removed");
  assert.deepEqual(await walk(deps), before, "the project's node_modules is untouched — without the unlink this is the assertion that fires");
  const junction = out.steps.find((s) => s.step === "junction");
  assert.ok(junction, "the removal reports a junction step");
  assert.equal(junction.ok, true);
  assert.match(junction.detail, /unlinked 1 directory link \(node_modules\) before git walked the tree/);
  assert.ok(out.steps.indexOf(junction) < out.steps.findIndex((s) => s.step === "worktree"), "and it comes before the worktree step");
  assert.equal(await exists(tree), false, "the tree is gone");
});

test("the steward's apply path unlinks the junction before its own git worktree remove", { skip }, async () => {
  const { primary, tree, branch, deps } = track(await preparedTree("wt-steward"));
  const before = await walk(deps);
  const at = new Date().toISOString();

  const out = await applyPlan({
    plan: { at },
    fresh: { project: "links", at, mainBranch: "main", delete: [{ path: slash(tree), branch }], roll: [], counts: {} },
    repoDir: slash(primary),
    trees: [],
    confirm: true,
  });

  assert.equal(out.ok, true, out.error || "");
  assert.equal(out.deleted.length, 1, `the tree is deleted: ${JSON.stringify(out.refused)}`);
  assert.deepEqual(out.refused, [], "and nothing was refused");
  assert.deepEqual(await walk(deps), before, "the project's node_modules is untouched");
  assert.equal(await exists(tree), false, "the tree is gone");
  assert.equal(git(primary, ["branch", "--format=%(refname:short)"]).split(String.fromCharCode(10)).includes(branch), false, "and its branch went with it");
});

// ── 3. the refusal half, and the links the walk finds ────────────────────────────────────────────────────────
test("a link that will not come out refuses, and every path refuses BEFORE it calls git", { skip }, async () => {
  const clean = { links: [{ path: "C:/t/node_modules", target: "C:/primary/node_modules" }], unlinked: ["C:/t/node_modules"], failed: [], unreadable: [] };
  assert.equal(linkRefusal(clean), null, "a link that came out is not a refusal");
  assert.equal(linkRefusal({ links: [], unlinked: [], failed: [], unreadable: [] }), null);

  const stuck = { ...clean, unlinked: [], failed: [{ path: "C:/t/node_modules", target: "C:/primary/node_modules", error: "EPERM" }] };
  assert.match(linkRefusal(stuck), /could not be unlinked \(EPERM\)/);
  assert.match(linkRefusal(stuck), /C:\/t\/node_modules/, "the refusal names the link");
  assert.match(linkRefusal(stuck), /would delete through it/, "and says what would have happened");

  // A directory the walk could not read is a failure too: a link inside THAT one is exactly the one git would follow.
  const unreadable = { links: [], unlinked: [], failed: [], unreadable: [{ path: "C:/t/vendor", error: "EACCES" }] };
  assert.match(linkRefusal(unreadable), /C:\/t\/vendor could not be read \(EACCES\)/);

  // The ORDER, in each of the three files that remove a tree: the unlink and its refusal come first, and the git call
  // that would recurse through a link comes after. This is what a revert of the fix breaks.
  for (const [file, call] of [
    ["lib/worktree-remove.js", '"worktree", "remove", "--force"'],
    ["lib/worktrees.js", '["worktree", "remove", tree]'],
    ["lib/steward.js", '["worktree", "remove", treePath]'],
  ]) {
    const src = readSource(file);
    const unlinkAt = src.indexOf("unlinkLinkedDirs(");
    const refuseAt = src.indexOf("linkRefusal(");
    const gitAt = src.indexOf(call);
    assert.ok(gitAt > 0, `${file} still removes a tree`);
    assert.ok(unlinkAt > 0, `${file} unlinks the links`);
    assert.ok(refuseAt > 0, `${file} refuses on one it cannot take out`);
    assert.ok(unlinkAt < gitAt, `${file}: the unlink comes before the git call`);
    assert.ok(refuseAt < gitAt, `${file}: the refusal comes before the git call`);
  }
});

test("the walk finds every link without descending through one, and unlinks the link and never its target", { skip }, async () => {
  const { tree, link, deps } = track(await preparedTree("wt-walk"));
  // A second link, nested, and pointed at the same dependencies: the walk must find it too.
  const nested = path.join(tree, "packages", "app");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "package.json"), "{}\n", "utf8");
  const nestedLink = path.join(nested, "node_modules");
  makeJunction(nestedLink, deps);

  const found = await linkedDirsIn(tree);
  assert.deepEqual(found.links.map((l) => slash(l.path)).sort(), [slash(link), slash(nestedLink)].sort(), "both links, at both depths");
  assert.deepEqual(found.unreadable, [], "and nothing unreadable");
  assert.deepEqual(found.links.map((l) => slash(l.target)), [slash(deps), slash(deps)], "each link reports the target it points at");

  const before = await walk(deps);
  const out = await unlinkLinkedDirs(tree);
  assert.equal(out.failed.length, 0);
  assert.equal(out.unlinked.length, 2, "both links came out");
  assert.equal(await exists(link), false);
  assert.equal(await exists(nestedLink), false);
  assert.deepEqual(await walk(deps), before, "and the target they pointed at holds every entry it did before");
});
