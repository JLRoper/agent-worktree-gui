// The sweep that acts on a CHECKING agent's answer, proved end to end and WITHOUT a gateway.
//
// The run itself is the one part a sandbox cannot produce (no API_SERVER_KEY, by design). What it CAN produce is the
// shape that matters: a real panel, booted over a real job store that already holds a settled `CHECKING MAIN` card
// whose final message ends in `LANDED: YES`, and a real worktree of a real repo. If the sweep does its job, the tree
// goes - the folder to the Recycle Bin, git's record pruned, the row off the board - and the card says which word it
// read. This is the half of the feature a reader actually feels, and the half no module test can see.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const slash = (p) => String(p || "").replace(/\\/g, "/");
const exists = (p) => stat(p).then((s) => s.isDirectory()).catch(() => false);

async function waitFor(base, predicate, what, { timeout = 40_000, interval = 500 } = {}) {
  const until = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await (await fetch(`${base}/api/state`)).json();
    if (predicate(last)) return last;
    if (Date.now() > until) {
      const projects = (last?.projects || []).map((p) => `${p.name} (${(p.worktrees || []).length} rows)`).join(", ");
      throw new Error(`timed out waiting for ${what}; projects: ${projects || "none"}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

test("a settled LANDED: YES card deletes its worktree, and a PARTIAL one does not", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-sweep-"));
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "wtgui-sweep-store-"));
  const repo = path.join(root, "proj");
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "check@local"]);
  git(repo, ["config", "user.name", "Check"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);

  // Two trees: one the answer says is landed, one the answer says is only partly there.
  const landedTree = path.join(repo, ".worktrees", "wt-landed");
  git(repo, ["worktree", "add", "-b", "feat/landed", landedTree]);
  await writeFile(path.join(landedTree, "work.txt"), "landed\n", "utf8");
  git(landedTree, ["add", "."]);
  git(landedTree, ["commit", "-m", "feat: the work"]);
  const partialTree = path.join(repo, ".worktrees", "wt-partial");
  git(repo, ["worktree", "add", "-b", "feat/partial", partialTree]);
  await writeFile(path.join(partialTree, "half.txt"), "half\n", "utf8");
  git(partialTree, ["add", "."]);
  git(partialTree, ["commit", "-m", "feat: half the work"]);

  // The job store a previous panel would have written the moment those two runs settled. `labels.json` is the
  // panel's own display name for a thread - that is where CHECKING MAIN lives, not on the job.
  const now = new Date().toISOString();
  const card = (id, thread, tree, message) => ({
    id,
    thread,
    turn: 1,
    existing: true,
    prompt: `CHECKING MAIN - proj: is feat/x's own change already on main?`,
    cwd: slash(tree),
    ownerPath: slash(tree),
    projectPath: slash(repo),
    sessionId: thread,
    status: "done",
    startedAt: now,
    endedAt: now,
    finalMessage: message,
    lines: [],
    artifacts: [],
    attachments: [],
  });
  const jobsFile = path.join(storeDir, "logs", "jobs.json");
  await mkdir(path.dirname(jobsFile), { recursive: true });
  await writeFile(
    jobsFile,
    JSON.stringify({
      savedAt: now,
      jobs: [
        card("seedland", "wtgui-check-landed", landedTree, `CHECKING MAIN: feat/landed -> main\n  reverse-apply: PRESENT\n\nLANDED: YES`),
        card("seedpart", "wtgui-check-partial", partialTree, `CHECKING MAIN: feat/partial -> main\n  reverse-apply: PARTIAL\n\nLANDED: PARTIAL - 1 of 2 files`),
      ],
    }),
    "utf8",
  );
  await writeFile(path.join(storeDir, "logs", "labels.json"), JSON.stringify({ "wtgui-check-landed": "CHECKING MAIN", "wtgui-check-partial": "CHECKING MAIN" }), "utf8");

  const panel = await startPanel({ config: { scanRoots: [root], jobsFile } });
  t.after(async () => {
    await panel.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(storeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const reload = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(reload.status, 200, `reload must succeed: ${reload.text.slice(0, 200)}`);

  const rowOf = (snap, p) => {
    const proj = (snap.projects || []).find((x) => x.name === "proj");
    return proj ? (proj.worktrees || []).find((w) => slash(w.path) === slash(p)) || null : null;
  };
  // Discovery first, and only the tree that must SURVIVE is waited for: the landed row may already be gone by the time
  // this reads the board (the sweep's boot pass is 6 s in, and a loaded box can take longer than that to scan), and
  // waiting for a row that is being deleted is a race this test would lose for the right reason.
  await waitFor(panel.base, (s) => Boolean(rowOf(s, partialTree)), "the worktrees on the board");

  // The answer is acted on within one sweep tick (10 s), with a boot pass 6 s in. The budget is for a LOADED box, not
  // for the tick: this file takes ~24 s solo, and in the full suite (60 files in parallel, each driving real git and a
  // real panel) the scan workers are starved past the old 60 s — measured 122 s and still three rows. The assertion is
  // unchanged: the row must go, however long the sweep needs to get round to it.
  // The panel's own log is attached to a timeout, because "the sweep never ran" and "it ran and could not act" read
  // the same from /api/state and are two different bugs.
  let after;
  try {
    after = await waitFor(panel.base, (s) => !rowOf(s, landedTree), "the landed row to be swept off the board", { timeout: 180_000 });
  } catch (e) {
    throw new Error(`${e.message}\n--- panel log (tail) ---\n${panel.log().slice(-4000)}`);
  }
  assert.equal(await exists(landedTree), false, "the landed worktree's folder is gone (Recycle Bin or git's removal)");
  assert.equal(/feat\/landed/.test(git(repo, ["worktree", "list", "--porcelain"])), false, "git no longer lists the removed tree");
  assert.ok(rowOf(after, partialTree), "a LANDED: PARTIAL answer deletes nothing: its tree is still a row");
  assert.equal(await exists(partialTree), true, "…and still on disk");

  // The card says which word it read, and what the panel did about it. That is the reader's only account of why a
  // tree vanished, so it has to be on the console and not only in the panel's log.
  const jobs = await (await fetch(`${panel.base}/api/jobs`)).json();
  const landedCard = (jobs.jobs || []).find((j) => j.thread === "wtgui-check-landed");
  const partialCard = (jobs.jobs || []).find((j) => j.thread === "wtgui-check-partial");
  const text = (j) => (j?.lines || []).map((l) => String(l.text || "")).join("\n");
  assert.match(text(landedCard), /panel: LANDED: YES .*Recycle Bin/, "the landed card says the tree went to the Recycle Bin");
  assert.match(text(partialCard), /panel: LANDED: PARTIAL .*nothing was deleted/, "the partial card says nothing was deleted");
});
