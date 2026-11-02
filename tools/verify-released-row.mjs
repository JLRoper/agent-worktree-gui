// A released worktree's leftover folder must not report the primary checkout's branch and dirt — proved on real git.
//
//   node tools/verify-released-row.mjs
//
// The rule this drives: `git -C <a leftover directory>` does not fail. It walks UP to the project's own checkout and
// answers for THAT — its branch, its HEAD, the reader's own dirty files — so a worktree row whose tree had been
// released still reported "2 modified · 4 untracked — branch main" while measuring zero worktree registrations, zero
// entries and no `.git` of its own. Nine of them reported it on one night, each one raising a [leftover] alert about
// files the reader had left in their own checkout.
//
// lib/own-tree.js answers "is this a tree of its own", and lib/scan.js now asks it BEFORE any `git -C status/log`:
// a path that is not its own tree comes back RELEASED with no counts at all, the reason, and the checkout git would
// have answered for. The store keeps that verdict instead of the one the row held while the tree was there, so the
// board and the leftover sweep (which reads row.dirtyFiles / row.untrackedFiles) see nothing to blame.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven   the panel's own scanner (lib/scan.js `scanWorktree`) over five REAL paths of a sandbox repo: the leftover
//            folder, a real worktree carrying its own uncommitted work, a real clean worktree, the project's own
//            checkout, and a directory outside every repository. The sandbox's primary checkout is made dirty with
//            exactly the shape the report named — 2 modified, 4 untracked — and the worktree's own work is a
//            DIFFERENT shape (3 modified, 2 untracked), so a scan that read the wrong tree could not pass.
//   driven   the store (lib/store.js): a row that read MERGED while the tree existed is put, then the scanner's
//            RELEASED row goes through a fast `putRow`, and the row + the project summary are read back.
//   inspected  nothing. No source is read and no assertion is about a comment: every check is a value the panel's own
//            modules returned for a real filesystem.
//
// The deterministic half of the same contract is in test/scan-released-row.test.js (node:test, run by `npm test`).
// This file is the standalone gate: one command, its own sandbox, a PASS/FAIL per claim and a non-zero exit.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanWorktree } from "../lib/scan.js";
import { Store } from "../lib/store.js";
import { git } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const check = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(name, same, same ? JSON.stringify(got) : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const note = (text) => console.log(`      ${text}`);
const here = path.dirname(fileURLToPath(import.meta.url));

// ---- the sandbox: one checkout with the reader's files, two real trees, and a folder a release left behind --------
const root = mkdtempSync(path.join(tmpdir(), "wtgui-released-row-"));
const repo = path.join(root, "project");
const trees = path.join(repo, ".worktrees");
const ownTree = path.join(trees, "own-tree");
const cleanTree = path.join(trees, "clean-tree");
const husk = path.join(trees, "released-husk");
const outside = path.join(root, "not-a-repo");
for (const d of [repo, trees, outside]) mkdirSync(d, { recursive: true });
const write = (dir, file, text) => writeFileSync(path.join(dir, file), text);

git(repo, "init", "-q", "-b", "main");
for (const f of ["one.txt", "two.txt", "three.txt", "four.txt", "five.txt"]) write(repo, f, `${f}\n`);
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");
git(repo, "worktree", "add", "-q", "-b", "wtgui/own-tree", ownTree);
git(repo, "worktree", "add", "-q", "-b", "wtgui/clean-tree", cleanTree);
// The released tree, made the way a release makes one: it was cut, git's record of it was pruned, the folder stayed.
git(repo, "worktree", "add", "-q", "-b", "wtgui/released-husk", husk);
git(repo, "worktree", "remove", "--force", husk);
rmSync(husk, { recursive: true, force: true });
mkdirSync(husk, { recursive: true });
// The reader's own working copy: exactly the shape the report named.
write(repo, "one.txt", "edited by the reader\n");
write(repo, "two.txt", "edited by the reader\n");
for (const f of ["config.json", "lib-jobs.js", "notes.md", "scratch.tmp"]) write(repo, f, "the reader's own file\n");
// The real tree's own work: a different shape, so reading the wrong tree cannot pass.
write(ownTree, "one.txt", "edited in the tree\n");
write(ownTree, "two.txt", "edited in the tree\n");
write(ownTree, "three.txt", "edited in the tree\n");
for (const f of ["tree-note.md", "tree-scratch.tmp"]) write(ownTree, f, "the tree's own work\n");

const ctx = { remoteRef: "origin/main", mainBranch: "main", parents: [] };
const scan = (dir) => scanWorktree(dir, ctx, "fast");

// ---- the run --------------------------------------------------------------------------------------------------
let err = null;
try {
  console.log("\nphase 1 — the husk really is the reported shape");
  const registrations = git(repo, "worktree", "list", "--porcelain")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree ")).length;
  ok("worktree registrations", registrations === 3, String(registrations));
  ok("the husk has no .git of its own", !existsSync(path.join(husk, ".git")));
  check("and no entries", readdirSync(husk).length, 0);
  ok(
    "yet git -C in it answers for the primary checkout (which is why the guard has to come first)",
    git(husk, "rev-parse", "--show-toplevel").trim().replace(/\\/g, "/").toLowerCase() === repo.replace(/\\/g, "/").toLowerCase(),
  );

  console.log("\nphase 2 — the row: RELEASED, no counts, and the reason");
  const release = await scan(husk);
  check("verdict", release.verdict, "RELEASED");
  check("branch (not the primary's)", release.branch, null);
  check("head", release.head, null);
  check("dirty", release.dirty, 0);
  check("untracked", release.untracked, 0);
  check("dirty files", release.dirtyFiles, []);
  check("untracked files", release.untrackedFiles, []);
  ok("the reason names a leftover directory", /leftover directory/.test(String(release.released?.why)), release.released?.why || "");
  const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
  ok("…and the checkout git would have answered for", norm(release.released?.outer) === norm(repo), String(release.released?.outer));
  ok("the routes that read one tree get the same sentence", release.error === release.released?.why, String(release.error));

  console.log("\nphase 3 — a real tree is untouched: its OWN dirt, its own files");
  const own = await scan(ownTree);
  check("branch", own.branch, "wtgui/own-tree");
  check("dirty", own.dirty, 3);
  check("untracked", own.untracked, 2);
  check("dirty paths", own.dirtyFiles.map((f) => f.path).sort(), ["one.txt", "three.txt", "two.txt"]);
  check("untracked paths", [...own.untrackedFiles].sort(), ["tree-note.md", "tree-scratch.tmp"]);
  ok("…and it is not labelled released", own.released === null);

  const clean = await scan(cleanTree);
  check("a real clean tree reads 0 modified", clean.dirty, 0);
  check("…0 untracked", clean.untracked, 0);
  ok("…and is not released", clean.verdict !== "RELEASED", String(clean.verdict));

  const primary = await scan(repo);
  check("the project's own checkout still reports its own branch", primary.branch, "main");
  check("…its own 2 modified", primary.dirty, 2);
  ok(
    "…and the reader's four untracked files",
    ["config.json", "lib-jobs.js", "notes.md", "scratch.tmp"].every((f) => primary.untrackedFiles.map((x) => x.replace(/\/$/, "")).includes(f)),
    JSON.stringify(primary.untrackedFiles),
  );

  const noRepo = await scan(outside);
  check("a directory outside every repository is RELEASED too, with its own reason", [noRepo.verdict, noRepo.dirty, noRepo.untracked], ["RELEASED", 0, 0]);
  ok("…naming the missing repository", /not a git repository/.test(String(noRepo.released?.why)), noRepo.released?.why || "");

  console.log("\nphase 4 — the row the board keeps, and the summary it feeds");
  const store = new Store();
  store.ensureProject({ name: "project", path: repo, mainBranch: "main", remote: "origin" });
  store.putRow("project", { path: husk, name: "released-husk", verdict: "MERGED (2 commits)", branch: "wtgui/released-husk", dirty: 0, untracked: 0, ahead: 0 }, "full");
  store.putRow("project", release, "fast");
  const row = store.rowsFor("project").find((r) => r.path === release.path);
  check("the row keeps RELEASED through a fast pass", row?.verdict, "RELEASED");
  check("…with no counts", [row?.dirty, row?.untracked], [0, 0]);
  check("…and is not offered as safe to remove", row?.mergeable, false);
  const summary = store.summaryFor("project");
  check("the summary counts it as released, not unmerged", [summary.released, summary.unmerged, summary.dirty], [1, 0, 0]);
} catch (e) {
  err = e;
  failures += 1;
  console.log(`\nphases threw: ${String((e && e.message) || e)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nDRIVEN: lib/scan.js over five real paths of a sandbox repo (a released leftover folder, a real dirty tree,`);
console.log("        a real clean tree, the primary checkout, a directory outside any repo) and lib/store.js's row and");
console.log("        summary. The primary checkout is dirty with the reported shape; the real tree's work has a");
console.log("        DIFFERENT shape, so a row answered by the wrong checkout cannot pass.");
console.log("INSPECTED: nothing.");
console.log(`gate: ${here.replace(/\\/g, "/")}`);
console.log(err ? `RESULT: threw — ${String(err.message || err)}` : failures ? `RESULT: ${failures} FAILED of ${checks}` : `RESULT: ALL PASS (${checks} checks)`);
process.exitCode = err || failures ? 1 : 0;
