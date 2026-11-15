// The cleanup run: measure a project's worktrees, hand the measurements to the planner, and act on the rows the
// planner marked `remove` or `merge`.
//
// Three pieces compose here, all of them already in the panel:
//
//   lib/worktree-remove.js   the ONE remover (`deleteWorktreeRow`), with its own guards: the reader's lock, a live
//                            agent, the project's own checkout, and the junction links a tree may hold;
//   lib/locks.js             the reader's lock, read per tree so a lock taken a second ago counts;
//   lib/own-tree.js          "is this directory a TREE, or a directory that still exists" - a leftover folder makes
//                            every `git -C` inside it answer for the checkout ABOVE it, which is how an audit once
//                            read the reader's own files as a worker's leftover;
//   lib/worktrees.js         the normalised path key and the job-holds-tree test the release path uses.
//
// Two boundaries are deliberate:
//
//   NO `--force` ANYWHERE. The remover's own `git worktree remove --force` is inside lib/worktree-remove.js and is
//   the panel's act, not this module's: nothing here passes it. A branch delete is `git branch -d` when history
//   proves it landed, and `git update-ref -d <ref> <sha>` (a compare-and-set) when only CONTENT proves it - the
//   cherry-equivalent case, where git's own merge test says "not fully merged" although the work is in main. That
//   is a proof-backed delete, not a forced one.
//
//   NO PUSH. Nothing in this file names a remote. A merge lands in a LOCAL child branch; publishing it is the
//   reader's call and lives on their own landing path.
//
// The merge uses git's plumbing (`merge-tree --write-tree`, `commit-tree`, `update-ref`) rather than a scratch
// checkout: it writes the same --no-ff merge commit with two parents, touches no working tree (so a dirty tree is
// never disturbed and never consulted), and leaves nothing behind to clean up if the merge conflicts.
import path from "node:path";
import { childExec } from "./child-tree.js";
import { isLiveJobStatus } from "./jobs.js";
import { jobTreePath } from "./job-trees.js";
import { lockReason } from "./locks.js";
import { ownTree } from "./own-tree.js";
import { isInsideProject, worktreeList } from "./project.js";
import { planCleanup } from "./cleanup-plan.js";
import { normTreePath } from "./worktrees.js";

const clean = (s) => String(s ?? "").replace(/\r/g, "").trim();
const ZERO_SHA = "0000000000000000000000000000000000000000";

// One git call with its exit code kept. `gitIn` (lib/scan.js) collapses a non-zero exit into `ok:false` with no
// code, and this module has to tell "not an ancestor" (exit 1) from "git could not answer" (which must not be
// read as either).
async function run(cwd, args, timeout = 30_000) {
  try {
    const { stdout } = await childExec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 48 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    return { ok: true, code: 0, out: clean(stdout), err: "" };
  } catch (e) {
    const code = typeof e?.code === "number" ? e.code : 1;
    return { ok: false, code, out: clean(e?.stdout), err: clean(e?.stderr || e?.message) };
  }
}

const slug = (s) =>
  String(s ?? "")
    .replace(/^refs\/heads\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "branch";

/** `20261114-0930` in local time: the report's own stamp, and the child branch's suffix. */
export function stampOf(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

// ---- the read ----------------------------------------------------------------------------------------------------

/**
 * Every worktree of one project, measured. Each entry is what `planCleanup` judges, plus the two facts the planner
 * refuses to guess: whether the directory is still a tree of its own, and what a live job is doing in it.
 */
export async function probeWorktrees({ project = {}, jobs = null, locks = null, timeout = 30_000 } = {}) {
  const repo = String(project?.path || "").trim();
  const main = String(project?.mainBranch || "").trim() || "main";
  if (!repo) return { trees: [], error: "the project names no checkout" };
  let list;
  try {
    list = await worktreeList(repo);
  } catch (e) {
    return { trees: [], error: `could not list the worktrees of ${project?.name || repo}: ${String((e && e.message) || e)}` };
  }
  const live = (jobs?.list?.() || []).filter((j) => isLiveJobStatus(j.status) && jobTreePath(j));
  const trees = [];
  for (const wt of list) {
    const treePath = normTreePath(wt.path);
    const branch = wt.branch ? String(wt.branch) : null;
    // `git worktree list` answers for the REPOSITORY, not for the project: a lander's comparison tree under a scratch
    // folder is a worktree of this repo and NOT a row of this board (lib/project.js `isInsideProject` is the board's own
    // membership test). Such a tree gets a row here so the page can say why it is out of play, and then nothing more:
    // no status, no counts, no verdict that could delete it. Judging it would be the cleanup arriving one guard short
    // of the row's x, and removing a tree the board does not own is exactly what that guard exists to stop.
    if (!isInsideProject(repo, treePath)) {
      trees.push({
        path: treePath,
        branch,
        head: null,
        dirty: false,
        dirtyFiles: [],
        ancestor: false,
        behind: 0,
        cherry: { ahead: 0, unique: 0, equivalent: 0 },
        main,
        locked: false,
        lockReason: "",
        liveJob: null,
        notOwnTree: "",
        outside: true,
      });
      continue;
    }
    // Is the directory still a tree of its own? A leftover folder answers every `git -C` with the checkout ABOVE it.
    const own = await ownTree(treePath, { timeout: 15_000 });
    const lock = locks?.check ? locks.check({ project: project.name, path: treePath, branch }) : { locked: false };
    const job = live.find((j) => normTreePath(jobTreePath(j)).toLowerCase() === treePath.toLowerCase());
    const entry = {
      path: treePath,
      branch,
      head: null,
      dirty: false,
      dirtyFiles: [],
      ancestor: false,
      behind: 0,
      cherry: { ahead: 0, unique: 0, equivalent: 0 },
      main,
      locked: Boolean(lock?.locked),
      lockReason: lock?.locked ? lockReason(lock) : "",
      liveJob: job ? String(job.id || "(unnamed job)") : null,
      notOwnTree: own.ok ? "" : String(own.why || "not a tree of its own"),
    };
    if (!own.ok) {
      trees.push(entry);
      continue;
    }
    const head = await run(treePath, ["rev-parse", "HEAD"], 15_000);
    entry.head = head.ok ? head.out.split("\n").pop() || null : null;
    // The tree's own working state, read in the tree. Safe ONLY because `ownTree` just proved the directory is not a
    // leftover: in one, `git status` walks up to the primary checkout and answers with the reader's files.
    const status = await run(treePath, ["status", "--porcelain"], 30_000);
    if (status.ok) {
      const lines = status.out.split("\n").filter(Boolean);
      entry.dirty = lines.length > 0;
      entry.dirtyFiles = lines.map((l) => l.slice(3).trim()).filter(Boolean);
    }
    // How much main lacks, and whether content already covers it. `main..HEAD` is empty exactly when HEAD is an
    // ancestor of main, so one count answers the ancestor question without a second call and without reading an
    // exit code as a fact.
    const ahead = await run(treePath, ["rev-list", "--count", `${main}..HEAD`], 30_000);
    if (ahead.ok) {
      const n = Number(ahead.out) || 0;
      entry.cherry.ahead = n;
      entry.ancestor = n === 0;
      entry.cherry = { ahead: n, unique: 0, equivalent: 0, measured: false };
      if (n > 0) {
        const cherry = await run(treePath, ["cherry", main, "HEAD"], 60_000);
        if (cherry.ok) {
          const marks = cherry.out.split("\n").filter((l) => /^[+-] /.test(l));
          entry.cherry = {
            ahead: n,
            equivalent: marks.filter((l) => l.startsWith("- ")).length,
            unique: marks.filter((l) => l.startsWith("+ ")).length,
            measured: true,
          };
        }
        // A cherry that cannot be read is not a proof: `measured` stays false, and the planner only offers a content
        // delete on a measurement it actually holds.
      }
    }
    const behind = await run(treePath, ["rev-list", "--count", `HEAD..${main}`], 15_000);
    if (behind.ok) entry.behind = Number(behind.out) || 0;
    trees.push(entry);
  }
  return { trees, error: "" };
}

/** Probe, then plan. The one call a route or a test needs for a dry run. */
export async function readCleanup({ project = {}, jobs = null, locks = null, ownPath = "" } = {}) {
  const probed = await probeWorktrees({ project, jobs, locks });
  if (probed.error) return { ok: false, error: probed.error, plan: null };
  const plan = planCleanup({
    project,
    trees: probed.trees,
    primaryPath: project.path,
    ownPath,
  });
  return { ok: true, error: "", plan };
}

// ---- the merge ---------------------------------------------------------------------------------------------------

/**
 * Merge `branch` into a child cut from `base`, with a --no-ff merge commit, entirely in git's object database.
 *
 * `merge-tree --write-tree` resolves the merge and prints the resulting tree; a conflict exits non-zero and the tree
 * it prints must never be committed, so the exit code decides. `commit-tree` then writes a commit with TWO parents
 * (the base and the branch), which is what --no-ff means, and `update-ref` creates the child branch with a
 * compare-and-set against the all-zero sha: a name that already exists is refused rather than moved.
 */
export async function mergeIntoChild({ repo, branch, branchSha = "", base = "main", at = new Date(), timeout = 120_000 } = {}) {
  const into = String(base || "").trim() || "main";
  const baseRev = await run(repo, ["rev-parse", "--verify", `${into}^{commit}`], 15_000);
  if (!baseRev.ok) return { ok: false, error: `the merge base ${into} is not a commit in this repo` };
  const branchRev = branchSha ? { ok: true, out: String(branchSha) } : await run(repo, ["rev-parse", "--verify", `${String(branch)}^{commit}`], 15_000);
  if (!branchRev.ok) return { ok: false, error: `could not read the tip of ${branch}` };
  const baseSha = baseRev.out.split("\n").pop();
  const tip = branchRev.out.split("\n").pop();
  if (tip === baseSha) return { ok: false, error: `${branch} is already at ${into}` };

  // The child's name carries the branch it preserves and the minute it ran, so two runs cannot collide and a reader
  // can see which cleanup a child belongs to.
  const child = `cleanup/${slug(branch)}-${stampOf(at)}-${Math.random().toString(16).slice(2, 6)}`;
  const merged = await run(repo, ["merge-tree", "--write-tree", "--no-messages", baseSha, tip], timeout);
  const tree = merged.out.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l)).pop();
  if (!merged.ok || !tree) {
    // A conflicted merge is a KEEP with the reason, never a forced resolution: the branch's history is not changed
    // and the reader is told the two sides disagree.
    return { ok: false, conflict: true, error: `the merge of ${branch} into ${into} conflicts: ${merged.err || merged.out.split("\n").slice(1).join(" ").trim() || "git refused the merge"}` };
  }
  const message = `cleanup: merge ${branch} into ${child}\n\nThe tree on ${branch} holds ${into} work that main lacks; this child keeps it on the\n${into} line without moving ${into} itself. Merged with --no-ff by the panel's cleanup chip.`;
  const commit = await run(repo, ["commit-tree", tree, "-p", baseSha, "-p", tip, "-m", message], timeout);
  if (!commit.ok) return { ok: false, error: `could not write the merge commit: ${commit.err || commit.out}` };
  const sha = commit.out.split("\n").pop();
  const made = await run(repo, ["update-ref", `refs/heads/${child}`, sha, ZERO_SHA], 15_000);
  if (!made.ok) return { ok: false, error: `could not create ${child}: ${made.err || made.out}` };
  const stats = await mergeStats({ repo, from: baseSha, to: sha });
  return { ok: true, conflict: false, child, commit: sha, base: into, baseSha, branch, branchSha: tip, ...stats };
}

/**
 * What the merge ADDED, in files and bytes, read from the two trees themselves.
 *
 * Line counts come from `diff --numstat`; bytes come from `ls-tree -r -l` on both sides (the blob size is the only
 * number git prints for a file as it stands), summed over the paths whose size moved. A path the merge deleted
 * counts as its own negative, so the total is the NET change and the report says so.
 */
async function mergeStats({ repo, from, to } = {}) {
  const count = await run(repo, ["diff", "--numstat", from, to], 60_000);
  let files = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  if (count.ok) {
    for (const line of count.out.split("\n").filter(Boolean)) {
      const [add, del] = line.split("\t");
      files += 1;
      if (/^\d+$/.test(add)) linesAdded += Number(add);
      if (/^\d+$/.test(del)) linesRemoved += Number(del);
    }
  }
  const sizes = async (rev) => {
    const out = new Map();
    const r = await run(repo, ["ls-tree", "-r", "-l", rev], 60_000);
    if (!r.ok) return out;
    for (const line of r.out.split("\n").filter(Boolean)) {
      if (!line.includes("\t")) continue;
      const meta = line.slice(0, line.indexOf("\t")).split(/\s+/);
      const file = line.slice(line.indexOf("\t") + 1);
      if (meta[1] !== "blob") continue;
      out.set(file, Number(meta[3]) || 0);
    }
    return out;
  };
  const before = await sizes(from);
  const after = await sizes(to);
  let bytes = 0;
  for (const [file, size] of after) bytes += size - (before.get(file) || 0);
  for (const [file, size] of before) if (!after.has(file)) bytes -= size;
  return { files, bytes, linesAdded, linesRemoved };
}

// ---- the act -----------------------------------------------------------------------------------------------------

/**
 * Run a plan. Rows the planner marked `skip` or `keep` are recorded and left alone; `remove` goes through the panel's
 * own remover and then deletes the branch by the proof that justified it; `merge` writes the child merge commit.
 *
 * `removeTree` is injected (server.js hands in `deleteWorktreeRow`) so a test can drive the same code without the
 * Recycle Bin step, and `platform` travels with it for the same reason lib/worktree-remove.js has the seam.
 */
export async function applyCleanup({
  project = {},
  plan,
  jobs = null,
  locks = null,
  removeTree,
  platform = process.platform,
  onLog = () => {},
  now = new Date(),
} = {}) {
  if (!plan || !Array.isArray(plan.rows)) return { ok: false, error: "no plan to apply" };
  if (typeof removeTree !== "function") return { ok: false, error: "applyCleanup needs removeTree (lib/worktree-remove.js deleteWorktreeRow)" };
  const repo = String(project?.path || "").trim();
  const rows = [];
  for (const row of plan.rows) {
    const out = { ...row, result: { acted: false, ok: true, why: "" } };
    if (row.verdict === "remove") {
      const rem = await removeTree({
        project,
        row: { name: path.basename(row.path), path: row.path, branch: row.branch },
        target: row.path,
        jobs,
        locks,
        platform,
        onLog,
      });
      if (!rem?.ok) {
        out.result = { acted: false, ok: false, why: String(rem?.error || "the remover refused it") };
        rows.push(out);
        continue;
      }
      // The branch goes only after the tree is gone: git refuses to delete a branch a worktree still has checked out.
      const branch = await deleteBranchByProof({ repo, row, onLog });
      out.result = {
        acted: true,
        ok: branch.ok,
        why: branch.ok ? `worktree removed and ${row.branch} deleted (${row.proof.kind})` : `worktree removed; ${row.branch} stayed: ${branch.error}`,
        branchDeleted: branch.ok,
        branchError: branch.ok ? null : branch.error,
      };
      rows.push(out);
      continue;
    }
    if (row.verdict === "merge") {
      const merged = await mergeIntoChild({ repo, branch: row.branch, branchSha: row.head, base: row.merge?.base || plan.main, at: now });
      if (!merged.ok) {
        out.result = { acted: false, ok: false, why: merged.error };
        out.merge = { ...(row.merge || {}), error: merged.error, conflict: Boolean(merged.conflict) };
        rows.push(out);
        continue;
      }
      out.merge = { ...merged, treeKept: Boolean(row.dirty) };
      out.result = {
        acted: true,
        ok: true,
        why: `merged --no-ff into ${merged.child} (${merged.files} file${merged.files === 1 ? "" : "s"}, ${merged.bytes} bytes)${row.dirty ? `; the tree was left in place with ${row.dirtyFiles.length} uncommitted file${row.dirtyFiles.length === 1 ? "" : "s"}` : ""}`,
      };
      rows.push(out);
      continue;
    }
    out.result = { acted: false, ok: true, why: row.reason };
    rows.push(out);
  }
  const counts = { remove: 0, merge: 0, keep: 0, skip: 0, failed: 0 };
  for (const row of rows) {
    counts[row.verdict] = (counts[row.verdict] || 0) + 1;
    if (row.result.ok === false) counts.failed += 1;
  }
  return { ok: true, error: "", main: plan.main, rows, counts };
}

/**
 * Delete one branch by the proof the planner used.
 *
 * `ancestor` is git's own merge test, so `git branch -d` (lowercase, the safe one) accepts it. A cherry-equivalent
 * branch is refused by `-d` because its SHAS are not in main, although its content is - that is what `git cherry`
 * proved - so the ref is deleted with `update-ref -d <ref> <sha>`, a compare-and-set on the exact commit the proof
 * was about. Neither call passes a force flag.
 */
async function deleteBranchByProof({ repo, row, onLog = () => {} } = {}) {
  const branch = String(row?.branch || "").trim();
  if (!branch || !repo) return { ok: false, error: "no branch to delete" };
  const proof = row?.proof?.kind;
  if (proof === "ancestor") {
    const del = await run(repo, ["branch", "-d", branch], 30_000);
    if (del.ok) {
      onLog(`cleanup: deleted ${branch} (an ancestor of ${row?.proof?.detail || "main"})`);
      return { ok: true, error: "" };
    }
    return { ok: false, error: del.err || del.out || "git branch -d refused" };
  }
  if (proof === "cherry") {
    const head = String(row?.head || "").trim();
    const del = await run(repo, ["update-ref", "-d", `refs/heads/${branch}`, head], 30_000);
    if (del.ok) {
      onLog(`cleanup: deleted ${branch} (every commit main lacks is cherry-equivalent)`);
      return { ok: true, error: "" };
    }
    return { ok: false, error: del.err || del.out || "git update-ref refused" };
  }
  return { ok: false, error: "no proof this branch is landed" };
}
