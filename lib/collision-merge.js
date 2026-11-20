// THE MERGE PROBE: git's own answer to "which side can go first", in both directions, against a pair's two tips.
//
// WHY THIS EXISTS. A collision used to be a card the reader had to rule on, one at a time, and the reader's own
// estimate is that 99 percent of them do not need him: two trees touching one file rarely disagree about the content,
// and the ORDER that makes the merge harder is git's question. `git merge-tree --write-tree` performs a whole merge in
// the object database - no checkout, no working file, no branch moved, no model, no worker turn - and exits 1 when the
// merge would conflict. That exit code is the fact this module reads.
//
// TWO DIRECTIONS, because the panel rules on an ORDER. `aFirst` asks the merge that would happen if A landed first and
// B then merged onto it, i.e. `merge-tree <A> <B>` (git's first branch is the target). `bFirst` is the same question
// with the sides swapped. A clean `aFirst` is proof that A can go first and B still merges without a conflict; the
// reverse direction says the same for B. Everything the sweep then does with the two answers is pure and lives in
// lib/collisions.js (`settleCollision`), which is why this file has no opinion about who should land.
//
// THE TIE-BREAK FACTS travel with the answer, but only when both directions are clean (the only case that needs them):
// the commits each side carries since the merge base, and the cut - the oldest reflog entry for the branch, which is
// the moment its line began ("branch: Created from ..."), falling back to the side's first own commit. The reader's
// order is older cut first, then fewer commits, then the branch name (`lib/collisions.js` `deterministicPick`).
//
// BOUNDED AND OFF THE NETWORK. Each call is a git process against a local repository, with a timeout and with the
// credential prompts switched off; a git older than 2.38 (no `merge-tree --write-tree`) exits 129 and the direction
// reads `clean: null` - "git could not answer" - which never turns into a ruling. The sweep probes only a pair it has
// not settled, and only up to its own per-sweep budget, so a board full of overlaps cannot turn one tick into a queue
// of processes.
import { execFileSync } from "node:child_process";

const MAX_BUFFER = 8 * 1024 * 1024;
// A conflict list is evidence, not a log: the card names the first few paths and the count is what the reader reads.
export const MERGE_CONFLICT_CAP = 24;

const text = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();

function git(cwd, args, timeout) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    return { status: 0, out: text(out), err: "" };
  } catch (error) {
    // `status` is git's own exit code. A timeout or a missing binary has none, and must never be read as a conflict
    // (exit 1) or as a clean merge (exit 0): null is "git could not answer".
    return {
      status: typeof error?.status === "number" ? error.status : null,
      out: text(error?.stdout),
      err: text(error?.stderr || error?.message),
    };
  }
}

/** A rev as the commit it points at, or null. Never a branch name: a name can move between the detection and the probe. */
function commitOf(cwd, rev, timeout) {
  const want = text(rev);
  if (!want) return null;
  const run = git(cwd, ["rev-parse", "--verify", "--quiet", `${want}^{commit}`], timeout);
  if (run.status !== 0) return null;
  const sha = run.out.split("\n").filter(Boolean).pop() || "";
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : null;
}

// `merge-tree --write-tree --name-only --no-messages` prints the resulting tree on the first line and, on a conflict,
// the conflicted paths under it, then a blank line. Only that block is read, so an informational message can never be
// mistaken for a path.
export function mergeConflictPaths(output = "") {
  const lines = text(output).split("\n");
  const paths = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) break;
    paths.push(line);
  }
  return [...new Set(paths)].slice(0, MERGE_CONFLICT_CAP);
}

function direction(repo, ours, theirs, timeout) {
  const run = git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs], timeout);
  if (run.status === 0) return { clean: true, conflicts: [], error: null };
  if (run.status === 1) return { clean: false, conflicts: mergeConflictPaths(run.out), error: null };
  return {
    clean: null,
    conflicts: [],
    error: text(run.err || run.out).split("\n")[0].slice(0, 300) || `git exited ${run.status === null ? "without a code" : run.status}`,
  };
}

/** The moment a side's line began: the oldest reflog entry for its branch, then its first own commit, then nothing. */
function cutOf(repo, side, tip, base, timeout) {
  const branch = text(side?.branch).replace(/^refs\/heads\//, "");
  if (branch) {
    const log = git(repo, ["reflog", "show", "--date=unix", "--format=%gd", `refs/heads/${branch}`], timeout);
    if (log.status === 0) {
      const lines = log.out.split("\n").map((line) => line.trim()).filter(Boolean);
      const oldest = lines[lines.length - 1] || "";
      const at = /@\{(\d{9,12})\}/.exec(oldest);
      if (at) return Number(at[1]) * 1000;
    }
  }
  if (!base) return null;
  const log = git(repo, ["log", "--format=%ct", "--reverse", `${base}..${tip}`], timeout);
  if (log.status !== 0) return null;
  const first = log.out.split("\n").map((line) => line.trim()).find(Boolean);
  const stamp = Number(first);
  return Number.isFinite(stamp) && stamp > 0 ? stamp * 1000 : null;
}

function sideFacts(repo, side, tip, base, timeout) {
  let commits = null;
  if (base) {
    const count = git(repo, ["rev-list", "--count", `${base}..${tip}`], timeout);
    const n = Number(count.out);
    if (count.status === 0 && Number.isFinite(n) && n >= 0) commits = n;
  }
  return { commits, cutAt: cutOf(repo, side, tip, base, timeout) };
}

/**
 * Ask git about ONE pair. `pair.a` and `pair.b` are the record's sides (path, branch and the scanned tip in `head`).
 * Answers `{ok, at, repo, tips, mergeBase, aFirst, bFirst, a, b, error}`: `aFirst.clean` is `true`, `false`, or `null`
 * when git could not answer. `ok` is false only when there is no repository or a tip the repo cannot resolve.
 */
export function probePairMerge(pair = {}, { timeout = 8000, now = () => new Date() } = {}) {
  const at = now().toISOString();
  const a = pair?.a || null;
  const b = pair?.b || null;
  const repo = text(a?.path || b?.path).replace(/\\/g, "/");
  const fail = (error) => ({ ok: false, at, repo: repo || null, tips: null, mergeBase: null, aFirst: null, bFirst: null, a: null, b: null, error });
  if (!repo) return fail("the pair names no tree, so there is no repository to ask");
  const tipA = commitOf(repo, a?.head || a?.branch, timeout);
  const tipB = commitOf(repo, b?.head || b?.branch, timeout);
  if (!tipA || !tipB) {
    const which = !tipA ? a?.name || a?.branch || "the first side" : b?.name || b?.branch || "the second side";
    return fail(`the tip of ${which} does not resolve in ${repo}, so git cannot be asked`);
  }
  // A first means B merges ONTO A: git's first branch is the target of the merge, so A is passed first.
  const aFirst = direction(repo, tipA, tipB, timeout);
  const bFirst = direction(repo, tipB, tipA, timeout);
  const baseRun = git(repo, ["merge-base", tipA, tipB], timeout);
  const mergeBase = baseRun.status === 0 ? baseRun.out.split("\n").map((l) => l.trim()).find(Boolean) || null : null;
  // The tie-break facts are only worth two more git calls when the answer is "either order is clean".
  const bothClean = aFirst.clean === true && bFirst.clean === true;
  return {
    ok: true,
    at,
    repo,
    tips: { a: tipA, b: tipB },
    mergeBase,
    aFirst,
    bFirst,
    a: bothClean ? sideFacts(repo, a, tipA, mergeBase, timeout) : null,
    b: bothClean ? sideFacts(repo, b, tipB, mergeBase, timeout) : null,
    error: null,
  };
}
