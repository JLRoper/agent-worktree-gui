#!/usr/bin/env node
// tools/land-pr.mjs - one command that LANDS and RENDERS: merge the pull request, bring the primary checkout to
// the merged tip, render CHANGELOG.md there, and prove the check reads current.
//
// WHY: every `gh pr merge --rebase --admin` bypasses the pre-push hook that renders, so a landing that stopped at
// "merged" left CHANGELOG.md stale at the next tip. It happened at 1.53.6, at 1.60.0 through 1.60.3, at 1.65.0 and
// at 1.65.3 - because the render was a SECOND command an agent had to remember, in a brief that named only the
// merge. `tools/land.mjs` already renders; what was missing was the half that comes before it. This is that half,
// and it is composed rather than duplicated: the merge and the fast-forward, then land.mjs's own render, then the
// check in the check's own words.
//
//   node tools/land-pr.mjs [<pr>]        merge the PR (this branch's when no number is given), fast-forward the
//                                        primary checkout to the merged tip, run tools/land.mjs there, and confirm
//                                        `tools/changelog.mjs --check` reads current
//   node tools/land-pr.mjs --check       judge only: read the PR and the primary checkout, say whether the command
//                                        would merge, and where the checkout stands. Writes and merges nothing.
//
// The refusals all happen BEFORE the merge, which is the property that makes this safe to run: a primary checkout
// on another branch, a checkout carrying tracked changes, a checkout with commits the base does not have, or a PR
// that targets another base are all judged first. The one thing worse than a stale changelog is a merge that
// cannot be followed by its render, because then nobody owns the render.
//
// The render itself stays in tools/land.mjs - the incremental path, the one-file commit, the docs-only push and
// the proof are already there, and a second implementation would drift from it. This tool's own output is the
// landing's record: the merge commit, the tip the checkout moved to, and the release count the check printed.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./release-history.mjs";

const DASHED = "\u2014"; // the separator tools/changelog.mjs and tools/land.mjs print

function run(cmd, args, { cwd, timeout = 120000 } = {}) {
  const r = execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return String(r || "").trim();
}

function git(root, args) {
  return run("git", ["-C", root, ...args]);
}

function gitOk(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

// ---------- the pure half: what is this landing ----------

export function parseArgs(argv) {
  const opt = { pr: null, base: "main", remote: null, check: false, fetch: true, gh: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") opt.check = true;
    else if (a === "--base") opt.base = String(argv[(i += 1)] || "");
    else if (a === "--remote") opt.remote = String(argv[(i += 1)] || "");
    else if (a === "--no-fetch") opt.fetch = false;
    // A test seam, not a feature: the suite answers for gh with a script, so the orchestration (which gh
    // arguments, in which order, against which checkout) is proved without a live pull request.
    else if (a === "--gh-script") opt.gh = String(argv[(i += 1)] || "");
    else if (a === "--help" || a === "-h") opt.help = true;
    else if (/^\d+$/.test(a) || /^https?:\/\//.test(a)) opt.pr = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opt;
}

// The PR as gh reports it, reduced to the three facts the landing judges. `merged` is the only state this command
// acts on; a CLOSED PR is a refusal, because landing a closed one is somebody else's PR and somebody else's branch.
export function readPullRequest(json) {
  const view = typeof json === "string" ? JSON.parse(json) : json || {};
  return {
    number: view.number ?? null,
    url: view.url || null,
    state: String(view.state || "").toUpperCase(),
    merged: String(view.state || "").toUpperCase() === "MERGED",
    mergeCommit: view.mergeCommit && view.mergeCommit.oid ? String(view.mergeCommit.oid) : null,
    base: view.baseRefName || null,
    head: view.headRefName || null,
  };
}

// The decision, every input named. It is made before anything is merged, so `why` is also the reason nothing was
// touched. `tracked` is the count of TRACKED changes in the primary checkout: an untracked file cannot enter a
// one-file commit (tools/land.mjs stages CHANGELOG.md and refuses when the index holds anything else), but a
// modified tracked file means the tree the render would describe is not the tree HEAD says it is.
export function landPrPlan({ pr, base, primaryBranch, tracked, ahead, behind, dirtyLines = [] }) {
  if (!pr || !pr.state) {
    return { action: "refuse", why: "gh did not report a pull request - nothing to land" };
  }
  if (pr.state === "CLOSED") {
    return { action: "refuse", why: `PR #${pr.number} is CLOSED, not MERGED - there is nothing to land; reopen it, or open a new pull request` };
  }
  if (pr.base && pr.base !== base) {
    return { action: "refuse", why: `PR #${pr.number} targets ${pr.base}, not ${base} - this command lands ${base} and renders its changelog` };
  }
  if (primaryBranch !== base) {
    return {
      action: "refuse",
      why: `the primary checkout is on ${primaryBranch || "a detached HEAD"}, not ${base} - the render belongs to ${base}'s own tip, so switch it there and run again`,
    };
  }
  if (tracked > 0) {
    const sample = dirtyLines.slice(0, 5).join("; ");
    return {
      action: "refuse",
      why: `the primary checkout carries ${tracked} tracked change${tracked === 1 ? "" : "s"} (${sample}) - the render is one commit of one file, and a checkout somebody is editing cannot show that the commit is the whole of it`,
    };
  }
  if (ahead > 0) {
    return {
      action: "refuse",
      why: `the primary checkout carries ${ahead} commit${ahead === 1 ? "" : "s"} ${pr.base || base} does not have - the fast-forward would have to rewrite them, and a render made after that is not a render of the merged tip; move those commits to a branch first`,
    };
  }
  if (pr.merged) {
    return { action: "skip-merge", why: `PR #${pr.number} is already MERGED${pr.mergeCommit ? ` at ${pr.mergeCommit.slice(0, 7)}` : ""} - only the fast-forward and the render are left` };
  }
  return { action: "merge", why: `PR #${pr.number} would be merged with --rebase --admin, the primary checkout fast-forwarded ${behind || 0} commit${behind === 1 ? "" : "s"}, and the changelog rendered at the merged tip` };
}

// "changelog: CHANGELOG.md is current — 445 releases" - the count the landing reports, read from the line both
// tools print rather than counted a second way that could disagree with them.
export function releaseCount(text) {
  const m = String(text || "").match(new RegExp(`${DASHED} (\\d+) releases`));
  return m ? Number(m[1]) : null;
}

// The primary checkout: `git worktree list` names it first, always, from whichever tree asks. A linked tree
// renders its own branch's shas, so the render has to happen there, not here.
export function primaryCheckout(root) {
  const out = git(root, ["worktree", "list", "--porcelain"]);
  const first = out.split("\n").find((line) => line.startsWith("worktree "));
  if (!first) throw new Error("git did not name a primary checkout");
  return first.slice("worktree ".length).trim();
}

export function trackedChanges(root) {
  const lines = git(root, ["status", "--porcelain", "-uno"]).split("\n").filter(Boolean);
  return { count: lines.length, lines };
}

// ---------- the CLI ----------

const USAGE = [
  "node tools/land-pr.mjs [<pr>] [--base main] [--remote origin] [--check] [--no-fetch] [--gh-script <file>]",
  "  land and render in one command: merge the PR (--rebase --admin), fast-forward the primary checkout,",
  "  render CHANGELOG.md at the merged tip through tools/land.mjs's incremental path, and prove the check.",
  "  <pr>        the pull request number or URL; omit it for the pull request of the current branch",
  "  --check     judge only: read the PR and the primary checkout, say what would happen, touch nothing",
  "  --base      the base branch this landing lands (default main)",
];

function ghRunner(opt) {
  if (!opt.gh) return (args) => run("gh", args);
  return (args) => run(process.execPath, [opt.gh, ...args]);
}

function ghView(gh, pr) {
  const args = ["pr", "view", ...(pr ? [String(pr)] : []), "--json", "number,url,state,mergeCommit,baseRefName,headRefName"];
  return readPullRequest(gh(args));
}

function main(argv) {
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (e) {
    console.error(`land-pr: ${e.message}`);
    return 2;
  }
  if (opt.help) {
    for (const line of USAGE) console.log(line);
    return 0;
  }

  let root;
  try {
    root = repoRoot(process.cwd());
  } catch {
    console.error("land-pr: not inside a git repository");
    return 2;
  }

  const base = opt.base || "main";
  let primary;
  try {
    primary = primaryCheckout(root);
  } catch (e) {
    console.error(`land-pr: ${e.message}`);
    return 2;
  }

  const remotes = (gitOk(primary, ["remote"]) || "").split("\n").filter(Boolean);
  const remote = opt.remote || (remotes.includes("origin") ? "origin" : remotes[0] || null);
  if (!remote) {
    console.error("land-pr: this clone carries no remote - a landing is a merge on a host, and there is none to land on");
    return 2;
  }
  const baseRef = `${remote}/${base}`;

  if (opt.fetch) {
    try {
      git(primary, ["fetch", "--prune", remote, base]);
    } catch (e) {
      console.error(`land-pr: could not fetch ${remote} - ${String((e.stderr || e.message || "").trim().split("\n")[0] || "unknown error")}`);
      return 2;
    }
  }

  const gh = ghRunner(opt);
  let pr;
  try {
    pr = ghView(gh, opt.pr);
  } catch (e) {
    console.error(`land-pr: gh could not read the pull request - ${String((e.stderr || e.message || "").trim().split("\n")[0] || "unknown error")}`);
    return 2;
  }

  const primaryBranch = gitOk(primary, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const { count: tracked, lines: dirtyLines } = trackedChanges(primary);
  const remoteKnown = Boolean(gitOk(primary, ["rev-parse", "--verify", "--quiet", baseRef]));
  const ahead = remoteKnown ? Number(git(primary, ["rev-list", "--count", `${baseRef}..HEAD`]) || 0) : 0;
  const behind = remoteKnown ? Number(git(primary, ["rev-list", "--count", `HEAD..${baseRef}`]) || 0) : 0;

  const plan = landPrPlan({ pr, base, primaryBranch, tracked, ahead, behind, dirtyLines });

  if (opt.check) {
    console.log(`land-pr: PR #${pr.number} reads ${pr.state || "unknown"}${pr.mergeCommit ? ` at ${pr.mergeCommit.slice(0, 7)}` : ""}`);
    console.log(`land-pr: primary checkout ${primary} is on ${primaryBranch || "a detached HEAD"}, ${ahead} ahead and ${behind} behind ${baseRef}`);
    console.log(`land-pr: ${plan.action === "refuse" ? "refused" : "would proceed"} - ${plan.why}`);
    return plan.action === "refuse" ? 1 : 0;
  }

  if (plan.action === "refuse") {
    console.error(`land-pr: refused - ${plan.why}`);
    return 1;
  }

  if (plan.action === "merge") {
    try {
      gh(["pr", "merge", String(pr.number), "--rebase", "--admin"]);
    } catch (e) {
      console.error(`land-pr: the merge was refused - ${String((e.stderr || e.message || "").trim().split("\n").slice(-2).join(" ") || "unknown error")}`);
      console.error("land-pr: nothing was fast-forwarded and nothing was rendered; the tip is unchanged and the render is still owed.");
      return 1;
    }
    try {
      pr = ghView(gh, String(pr.number));
    } catch (e) {
      console.error(`land-pr: the merge returned, but gh could not read the PR back - ${String((e.stderr || e.message || "").trim().split("\n")[0] || "unknown error")}`);
      return 1;
    }
    if (!pr.merged || !pr.mergeCommit) {
      console.error(`land-pr: PR #${pr.number} reads ${pr.state || "unknown"} after the merge, with no merge commit - the landing did not take, and nothing was rendered`);
      return 1;
    }
  }

  const mergeCommit = pr.mergeCommit || null;
  console.log(`land-pr: PR #${pr.number} is MERGED${mergeCommit ? ` - merge commit ${mergeCommit.slice(0, 7)}` : ""}`);

  // The fast-forward. Fetching again is what makes it a move to the MERGED tip: the merge the line above reports
  // produced the commit this fetch now sees.
  try {
    git(primary, ["fetch", "--prune", remote, base]);
    const before = git(primary, ["rev-parse", "HEAD"]);
    git(primary, ["merge", "--ff-only", baseRef]);
    const after = git(primary, ["rev-parse", "HEAD"]);
    console.log(`land-pr: ${primary} fast-forwarded ${before.slice(0, 7)} -> ${after.slice(0, 7)}`);
    if (mergeCommit && after !== mergeCommit) {
      console.log(
        `land-pr: note - ${baseRef} is at ${after.slice(0, 7)}, past the merge commit ${mergeCommit.slice(0, 7)}; ` +
          `the render is made at the tip, which names every release that landed before it`,
      );
    }
  } catch (e) {
    console.error(`land-pr: the fast-forward failed - ${String((e.stderr || e.message || "").trim().split("\n")[0] || "unknown error")}`);
    console.error("land-pr: the merge HAS happened; the render is owed. Resolve the checkout, then run npm run land there.");
    return 1;
  }

  // The render. tools/land.mjs is the whole of it: the incremental path, one CHANGELOG.md commit, the docs-only
  // push, its own re-render proof. Run it here rather than reimplementing it, and echo what it said.
  let landOut;
  try {
    landOut = run(process.execPath, [path.join(primary, "tools", "land.mjs"), "--no-fetch"], { cwd: primary, timeout: 600000 });
  } catch (e) {
    const text = `${e.stdout || ""}${e.stderr || ""}`.trim();
    if (text) for (const line of text.split("\n")) console.error(`  land: ${line}`);
    console.error("land-pr: the merge landed, but the render did not - the tip is red and this is the failure a follow-up row must not be left to find");
    return 1;
  }
  for (const line of landOut.split("\n").filter(Boolean)) console.log(`  ${line}`);

  // The check, in the check's own words: `changelog --check` against the tree that was just pushed.
  let count = null;
  try {
    const checkOut = run(process.execPath, [path.join(primary, "tools", "changelog.mjs"), "--check"], { cwd: primary, timeout: 600000 });
    count = releaseCount(checkOut);
    for (const line of checkOut.split("\n").filter(Boolean)) console.log(`  ${line}`);
  } catch (e) {
    const text = `${e.stdout || ""}${e.stderr || ""}`.trim();
    if (text) for (const line of text.split("\n")) console.error(`  ${line}`);
    console.error("land-pr: the render was pushed but `changelog --check` is still red - do not report this landing as finished");
    return 1;
  }
  if (count === null) count = releaseCount(landOut);

  console.log(
    `land-pr: done - PR #${pr.number} landed${mergeCommit ? ` at ${mergeCommit.slice(0, 7)}` : ""}, ` +
      `changelog --check reads current${count === null ? "" : ` - ${count} releases`}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
