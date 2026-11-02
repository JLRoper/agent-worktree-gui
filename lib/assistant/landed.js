// Is a brief's work already on main? The one question a boot replay has to answer before it starts the brief a
// second time.
//
// The answer is patch-id / tree equality against the base branch, NEVER "ahead by N". A branch three commits ahead
// whose three commits were cherry-picked into main HAS landed, and a count calls it unlanded; a branch that never
// committed anything is 0 ahead and has NOT landed, and a count calls it landed. `git cherry` compares the patches
// main already holds (`-` lines) with the ones it does not (`+`), and the tree comparison covers the branch that was
// merged and then rebuilt on top of the same content. Only those two, plus the PR's own MERGED word, are evidence.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const clean = (s) => String(s || "").replace(/\r/g, "").trim();

async function run(bin, args, cwd, timeout = 8_000) {
  try {
    const { stdout } = await pexec(bin, args, {
      cwd: cwd || undefined,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo" },
    });
    return { ok: true, out: clean(stdout) };
  } catch (e) {
    return { ok: false, out: clean(e?.stdout || ""), error: clean(e?.stderr || e?.message || String(e)) };
  }
}

const gitOut = (cwd, args, timeout) => run("git", ["-C", cwd, ...args], null, timeout);

// The ref a tree's work lands on. origin/main first: it is what the board already judges a branch against, and a
// local main that has not been fetched is the wrong authority after a squash-merge on the remote.
export async function pickBase(tree) {
  if (!tree) return null;
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const r = await gitOut(tree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.ok && r.out) return ref;
  }
  return null;
}

// The tree a replay would start the brief in. A record that names none, or names one that no longer exists, has
// nothing to replay: that is a skip, not a guess, because the alternative is cutting a NEW tree for old work.
export function treeOf(record = {}) {
  const t = String(record.tree || record.cwd || "").trim();
  return t && existsSync(t) ? t : null;
}

// `pr` is `{ number, state }` from `mergedPr()` below, or null. It is passed in rather than looked up here so the
// decision has one shape whether the caller could reach `gh` or not.
export async function judgeLanded({ tree = null, branch = null, base = null, pr = null, timeout = 8_000 } = {}) {
  const where = treeOf({ tree });
  if (!where) return { landed: false, gone: true, why: "its tree is gone", branch: branch || null, base: null };

  const head = branch || (await gitOut(where, ["rev-parse", "--abbrev-ref", "HEAD"])).out || null;
  if (!head || head === "HEAD") return { landed: false, why: "its tree has no branch checked out", branch: head, base: null };

  const baseRef = base || (await pickBase(where));
  if (!baseRef) return { landed: false, why: `no base branch to compare ${head} with`, branch: head, base: null };

  const [branchTip, baseTip] = await Promise.all([
    gitOut(where, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`], timeout),
    gitOut(where, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], timeout),
  ]);
  if (!branchTip.ok || !baseTip.ok || !branchTip.out || !baseTip.out) {
    return { landed: false, why: `could not read ${!branchTip.ok ? head : baseRef}`, branch: head, base: baseRef };
  }

  // (1) The base's history already contains it.
  const ancestor = await gitOut(where, ["merge-base", "--is-ancestor", branchTip.out, baseTip.out], timeout);
  if (ancestor.ok) return { landed: true, why: `${head} is already in ${baseRef}`, branch: head, base: baseRef, evidence: "ancestor" };

  // (2) Same content, different commit: a branch merged and then rebuilt, or one whose only commits are the base's.
  // Nothing would change on replay, so there is no brief left to replay.
  const [branchTree, baseTree] = await Promise.all([
    gitOut(where, ["rev-parse", `${branchTip.out}^{tree}`], timeout),
    gitOut(where, ["rev-parse", `${baseTip.out}^{tree}`], timeout),
  ]);
  if (branchTree.ok && baseTree.ok && branchTree.out && branchTree.out === baseTree.out) {
    return { landed: true, why: `${head}'s tree is identical to ${baseRef}'s`, branch: head, base: baseRef, evidence: "tree" };
  }

  // (3) Every commit of its own is already in the base BY PATCH — the cherry-pick case a count cannot see, and the
  // reason the rule is patch-id and not ahead-by-N.
  const cherry = await gitOut(where, ["cherry", "-v", baseTip.out, branchTip.out], timeout);
  if (cherry.ok) {
    const own = cherry.out ? cherry.out.split("\n").filter((l) => /^[+-]\s/.test(l)) : [];
    if (own.length && own.every((l) => l.startsWith("-"))) {
      return {
        landed: true,
        why: `all ${own.length} commit${own.length === 1 ? "" : "s"} on ${head} are already in ${baseRef} by patch-id`,
        branch: head,
        base: baseRef,
        evidence: "patch-id",
      };
    }
  }

  // (4) The PR is the last authority: a squash-merge rewrites the patch, so git cannot see it, and the merged PR
  // is exactly the record that says the work landed.
  if (pr && /^MERGED$/i.test(String(pr.state || ""))) {
    return {
      landed: true,
      why: `its PR${pr.number ? ` #${pr.number}` : ""} reads MERGED`,
      branch: head,
      base: baseRef,
      evidence: "pr",
    };
  }

  return { landed: false, why: `${head} holds work ${baseRef} does not`, branch: head, base: baseRef };
}

// The PR's own word. Best effort and bounded: no `gh`, no network or no answer is `null`, which leaves the git
// evidence alone to decide. A merged PR is only ever used to SKIP a replay, so a slow or missing answer costs a
// redundant check, never a wrong skip.
export async function mergedPr(tree, branch, { timeout = 6_000 } = {}) {
  const where = treeOf({ tree });
  if (!where || !branch) return null;
  const r = await run(
    "gh",
    ["pr", "list", "--head", String(branch), "--state", "merged", "--json", "number,state", "--limit", "1"],
    where,
    timeout,
  );
  if (!r.ok || !r.out) return null;
  try {
    const list = JSON.parse(r.out);
    const pr = Array.isArray(list) ? list[0] : null;
    return pr && /^MERGED$/i.test(String(pr.state || "")) ? { number: pr.number ?? null, state: "MERGED" } : null;
  } catch {
    return null;
  }
}
