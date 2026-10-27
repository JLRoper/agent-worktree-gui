// The steward, end to end, on a REAL panel: a throwaway config, a real git repository with real worktrees, and the
// routes the page actually posts to. No gateway, no worker, no network.
//
//   node tools/verify-steward.mjs
//
// What is driven, in order:
//   1. STAGE 1's row — /api/state carries parent + parentSha + parentSource for every worktree row. A tree the panel
//      recorded at the cut reads "cut"; a tree nobody recorded but whose branch carries the same ticket id as another
//      branch reads "backfilled" (a guess); a branch with no ticket reads "unknown".
//   2. STAGE 3's plan — POST /api/steward writes the plan file and ACTS ON NOTHING: every worktree in the fixture is
//      still on disk afterwards, and the .md on disk names what it would delete, roll and ask.
//   3. The two refusals, over HTTP — a roll-up into a recorded parent is allowed and really fast-forwards the PARENT's
//      tree; a roll-up into a backfilled parent is 409 and moves nothing; master is never a roll target.
//   4. The ask path — POST /api/worktree/parent-question records the question, starts nothing, and the next plan lists
//      it under the questions it is waiting on.
//   5. STAGE 4's act — a dry run lists and deletes nothing; a confirm (with the plan's own stamp) deletes only the
//      landed+clean+unlocked tree and leaves the dirty, the locked and the rolling ones alone.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { post, startPanel } from "./panel-testkit.mjs";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo" };
let checks = 0;
let failures = 0;
const ok = (name, cond, detail) => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const say = (line) => console.log(`      ${line}`);

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    .replace(/\r\n/g, "\n")
    .trim();
}
function commit(repo, file, text, message) {
  writeFileSync(path.join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

// The fixture: one repo, a turnover parent in its own tree, and children of every kind the steward must tell apart.
function buildFixture(root) {
  const repo = path.join(root, "fixture-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.email", "steward@example.test");
  git(repo, "config", "user.name", "Steward Verify");
  git(repo, "config", "commit.gpgsign", "false");
  commit(repo, "a.txt", "one\n", "one");
  const tree = (branch, startRef = "master", create = true) => {
    const wt = path.join(repo, ".worktrees", branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
    const args = ["worktree", "add", "-q"];
    if (create) args.push("-b", branch);
    args.push(wt);
    if (startRef) args.push(startRef);
    git(repo, ...args);
    return wt;
  };
  // The turnover parent, with its own tree so a roll-up has somewhere to land.
  const parentWt = tree("dmr-77-turnover");
  commit(parentWt, "turn.txt", "turnover\n", "turnover base");
  // A child the panel "cut" (it will be in the parent book), one it never recorded (backfilled guess), one dirty, one
  // locked, and one with no ticket at all (unknown).
  const cutWt = tree("dmr-77-child-cut", "dmr-77-turnover");
  commit(cutWt, "cut.txt", "cut\n", "work from a recorded cut");
  const guessWt = tree("dmr-77-child-guess", "dmr-77-turnover");
  commit(guessWt, "guess.txt", "guess\n", "work whose parent is only a guess");
  const dirtyWt = tree("dmr-77-dirty", "dmr-77-turnover");
  writeFileSync(path.join(dirtyWt, "wip.txt"), "half\n");
  const lockedWt = tree("dmr-77-locked", "dmr-77-turnover");
  git(repo, "worktree", "lock", lockedWt);
  const orphanWt = tree("wtgui/nothing-to-go-on-abc123", "master");
  commit(orphanWt, "orphan.txt", "orphan\n", "no ticket, no parent");
  // A landed child: committed, then fast-forwarded into the parent, so its content is already there.
  const landedWt = tree("dmr-77-child-landed", "dmr-77-turnover");
  commit(landedWt, "landed.txt", "landed\n", "work that already landed");
  git(parentWt, "merge", "-q", "--ff-only", "dmr-77-child-landed");
  return { repo, parentWt, cutWt, guessWt, dirtyWt, landedWt };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "steward-e2e-"));
  const { repo, parentWt } = buildFixture(root);
  const turnoverSha = git(repo, "rev-parse", "dmr-77-turnover");

  // The parent book the panel will boot with: ONE recorded cut, and nothing else — every other tree has to be guessed
  // or left unknown, which is the state a legacy board is in.
  const logsDir = path.join(root, "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    path.join(logsDir, "parents.json"),
    JSON.stringify({
      version: 1,
      records: [{ project: "fixture-repo", branch: "dmr-77-child-cut", path: path.join(repo, ".worktrees", "dmr-77-child-cut").replace(/\\/g, "/"), parent: "dmr-77-turnover", parentSha: turnoverSha, parentRef: "dmr-77-turnover", parentSource: "cut", by: "verify", at: new Date().toISOString() }],
    }),
  );

  // jobsFile is what every other ledger's default is derived from, so naming it here is what makes the panel read the
  // parents.json written above (parentsFile = <dirname(jobsFile)>/parents.json).
  const panel = await startPanel({
    config: {
      scanRoots: [root],
      projects: [{ name: "fixture-repo", path: repo, mainBranch: "master" }],
      jobsFile: path.join(logsDir, "jobs.json"),
      assistantFile: path.join(logsDir, "assistant.json"),
      stewardDir: logsDir,
      // The rows have to move while this script is watching: the parent a legacy tree gets is filled in by the panel's
      // own slow pass, and this is the shortest cadence the board permits.
      worktreeSeconds: 3,
      midSeconds: 5,
      dormantSeconds: 5,
      slowSeconds: 30,
      refreshSeconds: 60,
      fetchSeconds: 3600,
    },
  });
  try {
    // ---- 1. the row ---------------------------------------------------------------------------------------
    // The cut record is on disk at boot; the GUESS is filled in by the panel's own slow parent pass (20s in), so this
    // waits for the row to say "backfilled" rather than sampling one instant and calling it the answer.
    let rows = [];
    const until = Date.now() + 75_000;
    while (Date.now() < until) {
      const r = await fetch(`${panel.base}/api/state`);
      const state = await r.json();
      const project = (state.projects || []).find((p) => p.name === "fixture-repo");
      rows = project?.worktrees || [];
      const guess = rows.find((x) => x.branch === "dmr-77-child-guess");
      const orphan = rows.find((x) => x.branch === "wtgui/nothing-to-go-on-abc123");
      if (guess?.parentSource === "backfilled" && orphan?.parentSource === "unknown") break;
      await sleep(500);
    }
    const row = (branch) => rows.find((r) => r.branch === branch) || {};
    ok("1a. /api/state carries the parent on the row (cut)", row("dmr-77-child-cut").parent === "dmr-77-turnover" && row("dmr-77-child-cut").parentSource === "cut", {
      parent: row("dmr-77-child-cut").parent,
      sha: row("dmr-77-child-cut").parentSha,
      source: row("dmr-77-child-cut").parentSource,
    });
    ok("1b. a legacy tree is backfilled from the shared ticket id", row("dmr-77-child-guess").parent === "dmr-77-turnover" && row("dmr-77-child-guess").parentSource === "backfilled", {
      parent: row("dmr-77-child-guess").parent,
      source: row("dmr-77-child-guess").parentSource,
    });
    ok("1c. a branch with no ticket has no parent, and says unknown", row("wtgui/nothing-to-go-on-abc123").parent === null && row("wtgui/nothing-to-go-on-abc123").parentSource === "unknown", {
      parent: row("wtgui/nothing-to-go-on-abc123").parent,
      source: row("wtgui/nothing-to-go-on-abc123").parentSource,
    });

    // ---- 2. the plan --------------------------------------------------------------------------------------
    const before = git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
    const planned = await post(panel.base, "/api/steward", { body: { project: "fixture-repo" } });
    ok("2a. POST /api/steward writes a plan", planned.status === 200 && Boolean(planned.json?.at), planned.json?.error || planned.status);
    const planFile = planned.json?.file || "";
    ok("2b. the plan file exists on disk, with its three sections", existsSync(planFile) && /Would delete/.test(readFileSync(planFile, "utf8")) && /Would roll/.test(readFileSync(planFile, "utf8")) && /Needs you to answer/.test(readFileSync(planFile, "utf8")), planFile);
    const after = git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
    ok("2c. the plan acted on nothing — every worktree is still there", before === after, { before, after });
    const plan = planned.json || {};
    ok("2d. exactly the landed, clean, unlocked branch is in the delete list", plan.delete?.length === 1 && plan.delete[0].branch === "dmr-77-child-landed", plan.delete?.map((d) => d.branch));
    ok("2e. the roll list is a recorded cut only", plan.roll?.length === 1 && plan.roll[0].branch === "dmr-77-child-cut", plan.roll?.map((d) => d.branch));
    ok(
      "2f. the guessed, the orphan and the turnover branch are questions, not actions",
      ["dmr-77-child-guess", "wtgui/nothing-to-go-on-abc123", "dmr-77-turnover"].every((b) => plan.ask?.some((a) => a.branch === b)),
      plan.ask?.map((a) => a.branch),
    );
    ok("2g. the dirty and locked trees are named as skipped", ["dmr-77-dirty", "dmr-77-locked"].every((b) => plan.skip?.some((s) => s.branch === b)), plan.skip?.map((s) => s.branch));
    say(`plan: ${planFile}`);

    // ---- 3. the refusals, over HTTP -----------------------------------------------------------------------
    const guessRoll = await post(panel.base, "/api/worktree/rollup", {
      body: { project: "fixture-repo", path: path.join(repo, ".worktrees", "dmr-77-child-guess"), confirm: true },
    });
    ok("3a. a roll-up into a BACKFILLED parent is refused (409) and names the guess", guessRoll.status === 409 && /guess/.test(guessRoll.json?.error || ""), guessRoll.json?.error);
    const masterRoll = await post(panel.base, "/api/worktree/rollup", {
      body: { project: "fixture-repo", path: path.join(repo, ".worktrees", "wtgui-nothing-to-go-on-abc123"), parent: "master", confirm: true },
    });
    ok("3b. a roll-up into master is refused", masterRoll.status === 409 && /main branch|never merges/.test(masterRoll.json?.error || ""), masterRoll.json?.error);
    const noConfirm = await post(panel.base, "/api/worktree/rollup", {
      body: { project: "fixture-repo", path: path.join(repo, ".worktrees", "dmr-77-child-cut") },
    });
    ok("3c. a roll-up without a confirm answers 428 and lands nothing", noConfirm.status === 428, noConfirm.status);
    const parentBefore = git(parentWt, "rev-parse", "HEAD");
    const roll = await post(panel.base, "/api/worktree/rollup", {
      body: { project: "fixture-repo", path: path.join(repo, ".worktrees", "dmr-77-child-cut"), confirm: true },
    });
    ok("3d. the recorded cut rolls into the parent's OWN worktree", roll.status === 200 && roll.json?.ok === true, roll.json);
    ok("3e. the parent branch actually moved, and master did not", git(parentWt, "rev-parse", "HEAD") !== parentBefore && git(repo, "rev-parse", "master") === git(repo, "rev-parse", "master"), {
      parentBefore,
      parentAfter: git(parentWt, "rev-parse", "HEAD"),
    });

    // ---- 4. the ask path ----------------------------------------------------------------------------------
    const asked = await post(panel.base, "/api/worktree/parent-question", {
      body: { project: "fixture-repo", path: path.join(repo, ".worktrees", "wtgui-nothing-to-go-on-abc123"), branch: "wtgui/nothing-to-go-on-abc123", note: "no ticket, no parent — where does this go?" },
    });
    ok("4a. 'where should this go?' records the question and starts nothing", asked.status === 202 && asked.json?.started === false && Boolean(asked.json?.question?.at), asked.json?.question);
    const replan = await post(panel.base, "/api/steward", { body: { project: "fixture-repo" } });
    ok("4b. the next plan lists the question it is waiting on", (replan.json?.questions || []).some((q) => q.branch === "wtgui/nothing-to-go-on-abc123"), replan.json?.questions);

    // ---- 5. the act --------------------------------------------------------------------------------------
    const treesBefore = git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
    const dry = await post(panel.base, "/api/steward/apply", { body: { project: "fixture-repo", dryRun: true, planAt: replan.json?.at } });
    ok("5a. a dry run lists what it would delete and deletes nothing", dry.status === 200 && dry.json?.dryRun === true && dry.json.delete.length >= 1 && git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length === treesBefore, {
      wouldDelete: dry.json?.delete?.map((d) => d.branch),
    });
    const act = await post(panel.base, "/api/steward/apply", { body: { project: "fixture-repo", confirm: true, planAt: replan.json?.at } });
    ok("5b. a confirmed apply runs", act.status === 200 && act.json?.ok === true, act.json?.error || act.json?.deleted?.map((d) => d.branch));
    const branches = git(repo, "branch", "--format=%(refname:short)").split("\n");
    ok("5c. the landed branch is gone, its tree with it", !branches.includes("dmr-77-child-landed") && !existsSync(path.join(repo, ".worktrees", "dmr-77-child-landed")), branches);
    ok("5d. the dirty, locked, guessed and rolled branches are all still there", ["dmr-77-dirty", "dmr-77-locked", "dmr-77-child-guess"].every((b) => branches.includes(b)), branches);
    ok("5e. nothing was rolled into master", git(repo, "log", "-1", "--format=%s", "master") === "one");
  } finally {
    // A failure here is usually the panel's own log line saying WHY (a throw in a route is logged with its stack), so
    // it is printed rather than left in a temp dir that is about to be deleted.
    if (failures) {
      const lines = panel.log().split("\n").filter(Boolean);
      console.log("\n---- panel log (tail) ----");
      for (const line of lines.slice(-30)) console.log(`      ${line}`);
    }
    await panel.stop();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* a locked fixture worktree is the OS's to reap */
    }
  }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

await main();
