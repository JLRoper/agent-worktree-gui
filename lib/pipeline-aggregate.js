// The aggregate: ONE merge that combines a fan-out's lane branches in the aggregator's tree.
//
// A fan-out (lib/pipeline-fanout.js) cuts one tree per lane from the same base. Nothing reads across while the
// lanes run; the join stage is the one reader, and this module is how its workspace is assembled. Three rules:
//
//   1. PRE-FLIGHT, THEN MERGE. `git merge-tree --write-tree` performs the whole merge in the object database and
//      writes no working file, so a conflict is a VALUE — the paths, before a merge starts. `git merge-tree` takes
//      two inputs, so the lanes are folded pairwise over the object database with an explicit
//      `--merge-base=<base>`: that is the same merge git's octopus will perform, and the tree it prints is the tree
//      the merge commit ends up with (asserted in test/pipeline-fanout.test.js).
//   2. ONE COMMIT. `git merge --no-ff <lane>…` with every lane at once is git's octopus: one commit, one more parent
//      per lane, the row's branch advanced by a single object. Merging the lanes one after another would be N
//      commits and N chances to leave the tree half-merged — the failure the pre-flight exists to prevent.
//   3. LOCAL ONLY. Nothing here pushes, names a remote, or touches a lane tree. The lanes exist on this disk to be
//      merged; the only branch that ever leaves the machine is the aggregate's own, by the ordinary landing rule.
//
// A conflict is not an error to retry: it is the fact that two lanes wrote the same file, which is exactly what
// "each stage writes only files nobody else writes" means. The caller parks the row with the paths (the driver's
// `pipeline-conflict`), and a person decides which lane is right.
import { execFileSync } from "node:child_process";

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The named reasons this module answers with. A test and the row's decision record name one of these.
export const AGGREGATE_FAULTS = Object.freeze({
  CONFLICT: "pipeline-conflict", // two lanes changed the same path: the merge is refused, nothing is merged
  MERGE: "pipeline-aggregate", // git could not perform the merge the pre-flight passed
  SHAPE: "pipeline-aggregate-input", // nothing to merge, or a lane with no commit
});

function git(worktree, args, { raw = false } = {}) {
  try {
    const out = execFileSync("git", ["-C", worktree, ...args], {
      ...(raw ? {} : { encoding: "utf8" }),
      timeout: 60_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out, status: 0 };
  } catch (error) {
    return { ok: false, out: error && error.stdout ? String(error.stdout) : "", err: error && error.stderr ? String(error.stderr) : "", status: Number(error && error.status) || 1 };
  }
}

// The object id a rev resolves to, of the type asked for: `${rev}^{commit}` for a head, `${rev}^{tree}` for a tree.
// `HEAD^{tree}^{commit}` is not a rev at all, which is how a comparison between a pre-flight TREE and a commit's tree
// silently answers null and makes a verified merge read as unverified.
function oidOf(worktree, rev, type = "commit") {
  const run = git(worktree, ["rev-parse", "--verify", "--quiet", `${rev}^{${type}}`]);
  if (!run.ok) return null;
  const sha = String(run.out || "").trim();
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : null;
}

// `git merge-tree --write-tree --name-only` prints the resulting tree's object id on the first line; on a conflict it
// prints the conflicted paths next, then a blank line and the informational messages. One reader for that shape, so a
// conflict list and a clean answer cannot be read out of each other.
export function parseMergeTree(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  const tree = text(lines[0] || "");
  const conflicts = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break;
    // `--name-only` gives a bare path; an unmerged index line is `<mode> <oid> <stage>\t<path>`. Both are read, so a
    // git that ignored the flag would not turn a conflict into "no paths".
    const staged = /^\d{6} [0-9a-f]+ [123]\t(.+)$/.exec(line);
    conflicts.push(staged ? staged[1] : line.trim());
  }
  return { tree: /^[0-9a-f]{40,64}$/i.test(tree) ? tree : null, conflicts: unique(conflicts), clean: unique(conflicts).length === 0 };
}

const unique = (list) => [...new Set(list.filter(Boolean))];

// The lanes as `git` needs them: the COMMIT each lane settled at, never the branch name. A branch is a moving name,
// and a stage branch that was rebased or reset between its settle and the aggregate would merge something the row
// never recorded (lib/stage-pin.js rule 1).
function targetsOf(branches) {
  const out = [];
  for (const branch of Array.isArray(branches) ? branches : []) {
    const item = isObject(branch) ? branch : null;
    if (!item) continue;
    const target = text(item.commit) || text(item.branch);
    if (!target) return { ok: false, reason: "a lane carries neither a commit nor a branch — there is nothing to merge" };
    out.push({ stage: text(item.stage) || null, branch: text(item.branch) || null, target });
  }
  return { ok: true, targets: out };
}

// The whole merge, as one fold over the object database. Each step answers the tree the accumulated merge would
// write; a conflict stops the fold and names every path that is unmerged at that step.
export function preflightMerge({ tree, base = null, branches = [] } = {}) {
  const where = text(tree);
  if (!where) return { ok: false, code: AGGREGATE_FAULTS.SHAPE, conflicts: [], reason: "there is no aggregate tree to merge into" };
  const wanted = targetsOf(branches);
  if (!wanted.ok) return { ok: false, code: AGGREGATE_FAULTS.SHAPE, conflicts: [], reason: wanted.reason };
  if (!wanted.targets.length) return { ok: false, code: AGGREGATE_FAULTS.SHAPE, conflicts: [], reason: "there is no lane to merge" };
  const root = text(base) ? oidOf(where, text(base)) : oidOf(where, "HEAD");
  if (!root) {
    return { ok: false, code: AGGREGATE_FAULTS.SHAPE, conflicts: [], reason: `the base ${text(base) ? text(base).slice(0, 12) : "commit"} does not resolve in the aggregate tree` };
  }
  let acc = root;
  const conflicts = [];
  for (const target of wanted.targets) {
    const commit = oidOf(where, target.target);
    if (!commit) {
      return { ok: false, code: AGGREGATE_FAULTS.SHAPE, conflicts, reason: `lane ${target.stage || target.branch || target.target} names ${target.target.slice(0, 12)}, which the aggregate tree cannot resolve` };
    }
    const run = git(where, ["merge-tree", "--write-tree", "--name-only", `--merge-base=${root}`, acc, commit]);
    const parsed = parseMergeTree(run.out);
    if (!run.ok || parsed.conflicts.length) {
      conflicts.push(...parsed.conflicts);
      return {
        ok: false,
        code: AGGREGATE_FAULTS.CONFLICT,
        conflicts: unique(conflicts),
        tree: parsed.tree,
        reason: `lane ${target.stage || target.branch || target.target.slice(0, 12)} conflicts with the lanes merged before it on ${unique(conflicts).join(", ")}`,
      };
    }
    acc = parsed.tree || acc;
  }
  return { ok: true, code: null, tree: acc, conflicts: [], reason: null };
}

// The aggregate itself: pre-flight, then ONE commit built from the tree the pre-flight produced, then prove the commit
// carries that tree. `verified` is that equality — it is the number the commit body and the row quote, and it is what
// makes "the pre-flight is the merge" a fact rather than a hope.
//
// WHY `commit-tree` AND NOT `git merge --no-ff <lane>…`: git's octopus strategy is the one thing that would produce
// this commit in a single command, and on Git for Windows it is a shell script that fails inside a LINKED worktree
// (measured on 2.53.0.windows.3: `fatal: not a git repository: '/tmp/…/.git/worktrees/…'` plus a false "local changes
// would be overwritten", while a single-head merge in the same tree succeeds). `commit-tree` needs no strategy at all:
// the pre-flight already produced the merged TREE, so the commit is that tree plus one parent per lane — byte for byte
// what octopus would have written, without a working tree touched until the very last step.
export function aggregateBranches({ tree, base = null, branches = [], message = "", at = null } = {}) {
  const where = text(tree);
  const before = oidOf(where, "HEAD");
  const preflight = preflightMerge({ tree: where, base, branches });
  if (!preflight.ok) return { ...preflight, merged: false, commit: before };
  const wanted = targetsOf(branches);
  const targets = wanted.ok ? wanted.targets : [];
  // Nothing to do: every lane is already an ancestor of the aggregate. That is a finished aggregate, not a failure —
  // and the check is by commit, because a branch name cannot answer it.
  const pending = targets.filter((target) => !isAncestor(where, target.target, "HEAD"));
  if (!pending.length) {
    return { ok: true, code: null, merged: false, alreadyMerged: true, commit: before, tree: preflight.tree, conflicts: [], verified: false, reason: "every lane is already merged into the aggregate" };
  }
  // The aggregate tree is a workspace the panel cut for this merge and nobody has worked in. A file in it is either a
  // previous attempt's half-merge or a reader's edit, and advancing the branch over it would destroy it: refuse.
  const dirty = git(where, ["status", "--porcelain"]);
  const dirtyCount = dirty.ok ? String(dirty.out || "").trim().split(/\r?\n/).filter((line) => line.trim()).length : 0;
  if (dirtyCount) {
    return {
      ok: false,
      code: AGGREGATE_FAULTS.MERGE,
      merged: false,
      commit: before,
      conflicts: [],
      reason: `the aggregate tree has ${dirtyCount} uncommitted file${dirtyCount === 1 ? "" : "s"} — the merge is refused rather than advancing the branch over them`,
    };
  }
  if (!before) return { ok: false, code: AGGREGATE_FAULTS.SHAPE, merged: false, commit: null, conflicts: [], reason: "the aggregate tree has no commit to merge onto" };
  const built = git(where, ["commit-tree", preflight.tree, "-p", before, ...pending.flatMap((target) => ["-p", target.target]), "-m", text(message) || "aggregate the fan-out's stage branches"]);
  const commit = /^[0-9a-f]{40,64}$/i.test(String(built.out || "").trim()) ? String(built.out).trim().toLowerCase() : null;
  if (!built.ok || !commit) {
    return { ok: false, code: AGGREGATE_FAULTS.MERGE, merged: false, commit: before, conflicts: [], reason: `building the aggregate commit failed (${text(built.err) || "git refused it"})` };
  }
  // Advance the branch with a compare-and-swap on the commit we read, so a move nobody expected is refused rather than
  // overwritten; then bring the working tree to it (it was just proven clean, so this loses nothing).
  const branchRun = git(where, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchRun.ok ? text(branchRun.out) : "";
  const moved = branch
    ? git(where, ["update-ref", "-m", `aggregate ${pending.length} stage branch${pending.length === 1 ? "" : "es"}`, `refs/heads/${branch}`, commit, before])
    : git(where, ["update-ref", "-m", "aggregate", "HEAD", commit, before]);
  if (!moved.ok) {
    return { ok: false, code: AGGREGATE_FAULTS.MERGE, merged: false, commit: before, conflicts: [], reason: `the aggregate branch moved while the merge was built (${text(moved.err) || "update-ref refused"}) — nothing was advanced` };
  }
  const checkout = git(where, ["reset", "--hard", commit]);
  if (!checkout.ok) {
    // The commit exists and the branch points at it; only the checkout failed. Say so plainly instead of reporting the
    // merge as un-made — a reader can run `git reset --hard` in a tree that is already the merge.
    return { ok: true, code: null, merged: true, commit, tree: preflight.tree, written: null, verified: false, conflicts: [], parents: parentCount(where, commit), checkedOut: false, at: at || null, reason: `the aggregate commit is made but the tree could not be checked out to it (${text(checkout.err)})` };
  }
  const written = oidOf(where, "HEAD", "tree");
  return {
    ok: true,
    code: null,
    merged: true,
    commit,
    tree: preflight.tree,
    written,
    // The pre-flight's tree and the commit's tree are the same object: the merge carries what the pre-flight read.
    verified: Boolean(preflight.tree && written && preflight.tree === written),
    conflicts: [],
    parents: parentCount(where, commit),
    checkedOut: true,
    at: at || null,
    reason: null,
  };
}

function isAncestor(worktree, ancestor, descendant) {
  const commit = oidOf(worktree, ancestor);
  if (!commit) return false;
  const run = git(worktree, ["merge-base", "--is-ancestor", commit, descendant]);
  return run.ok;
}

function parentCount(worktree, commit) {
  const run = git(worktree, ["rev-list", "--parents", "-n", "1", commit]);
  if (!run.ok) return null;
  const parts = String(run.out || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.length - 1 : 0;
}
