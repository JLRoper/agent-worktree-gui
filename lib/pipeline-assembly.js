// The ASSEMBLY: ONE branch that carries every stage of a per-stage ROUND.
//
// A round gives every stage its own tree, cut at the round's frozen parent (lib/task-pipeline-drive.js `roundOf`).
// That is what makes a stage unable to see a sibling's files, and it leaves the round with one problem the fan-out
// does not have: N commits on N local branches, and no single branch to land. The fan-out's join merges its lanes in
// one octopus commit (lib/pipeline-aggregate.js); a CHAIN cannot, because its stages are not siblings - each stage
// finishes what the last one started, in order. So the round's work is assembled the way a chain is read:
//
//   1. ONE BRANCH, CUT FROM THE ROUND'S FROZEN PARENT. The assembly branch starts at `round.sha`, never at the parent
//      branch as it stands now, so a commit that landed after the round began cannot enter it. That is the same fact
//      every stage tree was cut under, which is why every stage commit applies to it.
//   2. IN VISIT ORDER: by visit, then by the stage's position in the document. Baseline first, then implement,
//      compare and correct - and a loop's second visit of the baseline comes after the first visit's last stage,
//      because that is the order the round actually ran. Ordering by stage alone would replay a stage's visits out
//      of the history they were written in.
//   3. THE LATER STAGE WINS A SHARED PATH. A chain's later stage applies ON TOP of the earlier one, so for a path both
//      stages wrote, the assembled branch carries the LATER stage's version - that is what "each stage finishes what
//      the last started" means, and it is the difference from a fan-out, where two lanes writing one path is a
//      conflict. Where the later stage changed the SAME LINES the earlier one changed, git cannot apply the pick: the
//      branch is discarded, nothing is committed, and the caller parks the row `pipeline-assembly` naming the paths
//      and both stages. A person decides which stage is right. The panel never resolves a hunk by choosing a side.
//   4. A STAGE THAT COMMITTED NOTHING IS NAMED, NOT INVENTED. A stage whose commit is its own tree's base (the worker
//      wrote files and never committed) has nothing to pick; it is recorded as skipped so a reader can see the round
//      was assembled from fewer commits than it had stages.
//   5. LOCAL ONLY. Nothing here pushes, names a remote, or touches a stage tree. The assembly branch is the one that
//      lands, by the ordinary landing rule; the stage branches stay local, exactly like a fan-out's lanes
//      (lib/pipeline-fanout.js rule 5).
import { execFileSync } from "node:child_process";

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The named reasons this module answers with. A test and the row's decision record name one of these.
export const ASSEMBLY_FAULTS = Object.freeze({
  CONFLICT: "pipeline-assembly-conflict", // two stages changed the same lines: the pick stops and the branch is abandoned
  PICK: "pipeline-assembly", // git could not pick a commit the plan passed
  SHAPE: "pipeline-assembly-input", // no tree, no base, no stage commit, or a tree not cut at the round's parent
});

function git(worktree, args, { raw = false } = {}) {
  try {
    const out = execFileSync("git", ["-C", worktree, ...args], {
      ...(raw ? {} : { encoding: "utf8" }),
      timeout: 120_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out, status: 0 };
  } catch (error) {
    return { ok: false, out: error && error.stdout ? String(error.stdout) : "", err: error && error.stderr ? String(error.stderr) : "", status: Number(error && error.status) || 1 };
  }
}

const lines = (value) => String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const firstLine = (value) => lines(value)[0] || "";

function oidOf(worktree, rev) {
  const run = git(worktree, ["rev-parse", "--verify", "--quiet", rev]);
  if (!run.ok) return null;
  const sha = String(run.out || "").trim();
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : null;
}

function isAncestor(worktree, ancestor, descendant) {
  const commit = oidOf(worktree, ancestor);
  if (!commit) return false;
  return git(worktree, ["merge-base", "--is-ancestor", commit, descendant]).ok;
}

// A commit that changes nothing has nothing to pick, and an empty pick stops git for a decision nobody needs.
function changesNothing(worktree, commit) {
  const parent = oidOf(worktree, `${commit}^`);
  if (!parent) return false;
  return git(worktree, ["diff", "--quiet", parent, commit]).ok;
}

// The unmerged paths at a stopped pick. `--diff-filter=U` is the index's answer and works whether the pick stopped on
// content or on a delete/modify; the porcelain reading is the fallback for a git that answered with an empty index.
function conflictedPaths(worktree) {
  const unmerged = git(worktree, ["diff", "--name-only", "--diff-filter=U"]);
  const fromIndex = unmerged.ok ? lines(unmerged.out) : [];
  if (fromIndex.length) return [...new Set(fromIndex)];
  const status = git(worktree, ["status", "--porcelain"]);
  const fromStatus = (status.ok ? lines(status.out) : [])
    .map((line) => /^(?:U.|.U|AA|DD)\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);
  return [...new Set(fromStatus)];
}

// The paths one commit changed, against its own parent - exactly the change the pick applies.
function changedPathsOf(worktree, commit) {
  const parent = oidOf(worktree, `${commit}^`);
  if (!parent) return [];
  const run = git(worktree, ["diff", "--name-only", "--no-renames", parent, commit]);
  return run.ok ? lines(run.out) : [];
}

function skipStoppedPick(worktree, before) {
  // An empty pick stops the sequence without a conflict; `--skip` is git's own way out. A git that cannot skip is
  // restored to the commit the pick started from rather than left mid-sequence.
  if (git(worktree, ["cherry-pick", "--skip"]).ok) return { ok: true };
  git(worktree, ["cherry-pick", "--abort"]);
  if (before && git(worktree, ["reset", "--hard", before]).ok) return { ok: true };
  return { ok: false };
}

// The order a round's stage commits are replayed in: by VISIT, then by the stage's position in the document.
//
// `stages` are the entries the caller planned (stage id, visit, commit). The reader is defensive because the plan
// crosses a process boundary: a record written by another version may carry a missing visit or position.
export function assemblyOrder(stages) {
  const list = (Array.isArray(stages) ? stages : []).filter((entry) => isObject(entry) && text(entry.stage) && text(entry.commit));
  return list
    .map((entry, index) => ({
      stage: text(entry.stage),
      visit: Number.isInteger(Number(entry.visit)) && Number(entry.visit) > 0 ? Number(entry.visit) : 1,
      commit: text(entry.commit),
      branch: text(entry.branch) || null,
      position: Number.isFinite(Number(entry.position)) ? Number(entry.position) : index + 1,
      index,
    }))
    .sort((a, b) => a.visit - b.visit || a.position - b.position || a.index - b.index)
    .map(({ index, ...entry }) => entry);
}

// The commit's subject and the record's sentence: which round, which stages, from which frozen parent.
export function assemblyMessage(pipeline, stages, base = null) {
  const names = (Array.isArray(stages) ? stages : []).map((entry) => text(entry && entry.stage)).filter(Boolean).join(", ");
  const id = text(pipeline && pipeline.id) || "the pipeline";
  return `stage assembly: ${Array.isArray(stages) ? stages.length : 0} stage commit${(Array.isArray(stages) ? stages.length : 0) === 1 ? "" : "s"} of ${id} (${names || "no stages"}) on the round's parent ${text(base) ? String(base).slice(0, 12) : "(unknown)"}`;
}

// The record written on the row: the branch that lands, the commit it reached, the stages it picked and the ones it
// could not. It is also the proof that the assembly happened once - a second one for the same round is refused.
export function assemblyRecord({ commit, base, branch, path: treePath = null, stages = [], skipped = [], verified = false, paths = [], at = null }) {
  return {
    commit: text(commit) || null,
    base: text(base) || null,
    branch: text(branch) || null,
    ...(text(treePath) ? { path: text(treePath) } : {}),
    ...(at ? { at } : {}),
    verified: Boolean(verified),
    ...(Array.isArray(paths) && paths.length ? { paths } : {}),
    stages: (Array.isArray(stages) ? stages : []).map((entry) => ({
      stage: text(entry && entry.stage) || null,
      visit: Number(entry && entry.visit) > 0 ? Number(entry.visit) : 1,
      branch: text(entry && entry.branch) || null,
      commit: text(entry && entry.from) || text(entry && entry.commit) || null,
      picked: text(entry && entry.picked) || text(entry && entry.commit) || null,
    })),
    skipped: (Array.isArray(skipped) ? skipped : []).map((entry) => ({
      stage: text(entry && entry.stage) || null,
      visit: Number(entry && entry.visit) > 0 ? Number(entry.visit) : 1,
      why: text(entry && entry.why) || null,
    })),
  };
}

// AFTER the picks: does the branch carry every stage's work? For each path a picked stage changed, the LAST stage that
// changed it owns the version on the branch (rule 3). The blob at HEAD must be that stage's blob - or absent, when the
// owner deleted the path. `mismatches` is the list, so a failure says which path and which stage disagree.
function verifyRound(worktree, picked) {
  const owner = new Map();
  for (const entry of picked) {
    for (const rel of changedPathsOf(worktree, entry.commit)) owner.set(rel, entry);
  }
  const mismatches = [];
  for (const [rel, entry] of owner) {
    const want = oidOf(worktree, `${entry.commit}:${rel}`);
    const have = oidOf(worktree, `HEAD:${rel}`);
    if (want !== have) mismatches.push({ path: rel, stage: entry.stage, want, have });
  }
  return { ok: mismatches.length === 0, paths: [...owner.keys()].sort(), mismatches };
}

// The assembly itself: the tree is a fresh worktree cut at the round's frozen parent, and the stage commits are
// cherry-picked onto it in visit order. One commit per stage, so the assembled history reads as the round ran.
export function assembleStages({ tree = null, base = null, stages = [], message = "", at = null } = {}) {
  const where = text(tree);
  if (!where) return { ok: false, code: ASSEMBLY_FAULTS.SHAPE, conflicts: [], stages: [], skipped: [], reason: "there is no assembly tree to build in" };
  const root = text(base) ? oidOf(where, text(base)) : oidOf(where, "HEAD");
  if (!root) {
    return {
      ok: false,
      code: ASSEMBLY_FAULTS.SHAPE,
      conflicts: [],
      stages: [],
      skipped: [],
      reason: `the round's frozen parent ${text(base) ? text(base).slice(0, 12) : "(none)"} does not resolve in the assembly tree`,
    };
  }
  const head = oidOf(where, "HEAD");
  if (head !== root) {
    return {
      ok: false,
      code: ASSEMBLY_FAULTS.SHAPE,
      conflicts: [],
      stages: [],
      skipped: [],
      reason: `the assembly tree starts at ${String(head || "no commit").slice(0, 12)}, not at the round's frozen parent ${root.slice(0, 12)} - a branch cut from the parent branch as it stands now would carry another round's work`,
    };
  }
  const wanted = assemblyOrder(stages);
  if (!wanted.length) return { ok: false, code: ASSEMBLY_FAULTS.SHAPE, conflicts: [], stages: [], skipped: [], reason: "there is no stage commit to assemble" };
  const dirty = git(where, ["status", "--porcelain"]);
  const dirtyCount = dirty.ok ? lines(dirty.out).length : 0;
  if (dirtyCount) {
    return {
      ok: false,
      code: ASSEMBLY_FAULTS.PICK,
      conflicts: [],
      stages: [],
      skipped: [],
      reason: `the assembly tree has ${dirtyCount} uncommitted file${dirtyCount === 1 ? "" : "s"} - the assembly is refused rather than committing around them`,
    };
  }

  const picked = [];
  const skipped = [];
  for (const entry of wanted) {
    const commit = oidOf(where, entry.commit);
    if (!commit) {
      return {
        ok: false,
        code: ASSEMBLY_FAULTS.PICK,
        conflicts: [],
        stages: picked,
        skipped,
        reason: `stage ${entry.stage} names ${entry.commit.slice(0, 12)}, which the assembly tree cannot resolve`,
      };
    }
    if (isAncestor(where, commit, "HEAD")) {
      skipped.push({ stage: entry.stage, visit: entry.visit, commit, why: "the commit is already in the assembly" });
      continue;
    }
    if (changesNothing(where, commit)) {
      skipped.push({ stage: entry.stage, visit: entry.visit, commit, why: "the stage commit changes nothing, so there is nothing to pick" });
      continue;
    }
    const before = oidOf(where, "HEAD");
    const run = git(where, ["cherry-pick", commit]);
    if (!run.ok) {
      const conflicts = conflictedPaths(where);
      if (conflicts.length) {
        git(where, ["cherry-pick", "--abort"]);
        const earlier = [...picked, ...skipped].map((item) => item.stage).filter(Boolean);
        return {
          ok: false,
          code: ASSEMBLY_FAULTS.CONFLICT,
          conflicts,
          stage: entry.stage,
          stages: picked,
          skipped,
          reason: `stage ${entry.stage} changes the ${conflicts.length === 1 ? "path" : "paths"} ${conflicts.join(", ")}, and so did a stage before it (${earlier.join(", ") || "none picked"}) on the same lines - git cannot apply the later stage on top of the earlier one, so the branch was discarded`,
        };
      }
      const restored = skipStoppedPick(where, before);
      if (!restored.ok) {
        return {
          ok: false,
          code: ASSEMBLY_FAULTS.PICK,
          conflicts: [],
          stages: picked,
          skipped,
          reason: `picking stage ${entry.stage} (${commit.slice(0, 12)}) failed (${firstLine(run.err) || firstLine(run.out) || "git refused it"}) and the assembly tree could not be restored`,
        };
      }
      skipped.push({ stage: entry.stage, visit: entry.visit, commit, why: "the pick was empty once the earlier stages were applied" });
      continue;
    }
    picked.push({ stage: entry.stage, visit: entry.visit, branch: entry.branch, from: commit, commit: oidOf(where, "HEAD") });
  }

  const tip = oidOf(where, "HEAD");
  if (!picked.length) {
    return {
      ok: false,
      code: ASSEMBLY_FAULTS.SHAPE,
      conflicts: [],
      stages: [],
      skipped,
      commit: tip,
      reason: "no stage commit could be picked - every stage of the round is already in the base or changes nothing",
    };
  }
  const checked = verifyRound(where, picked);
  return {
    ok: true,
    code: null,
    commit: tip,
    base: root,
    tree: head,
    stages: picked,
    skipped,
    paths: checked.paths,
    mismatches: checked.mismatches,
    verified: checked.ok,
    message: text(message) || null,
    at: at || null,
    reason: null,
  };
}
