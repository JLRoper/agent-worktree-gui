// The UNMERGED chip's fourth outcome, proved where it is decided:
//
//   - the script the CHECKING agent is held to (lib/verify-prompt.js), which has to ask the question by CONTENT -
//     a reverse-apply of the branch's own patch to a pristine export of the base - because a squash merge leaves the
//     branch ahead forever and the commit count can never answer "is it on main?";
//   - the ONE line the panel reads back, and the fact that only LANDED: YES acts;
//   - the act itself (lib/worktree-remove.js), against a real repo: a tree that is gone from git and from disk, and a
//     locked row / a live agent / the project's own checkout each still refused before anything is touched.
//
// The prompt is asserted on the sentences that carry a rule, not on its prose: the reverse-apply, the four verdict
// words, the delete being the PANEL's act, and the absence of any push.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { answerDeletes, answerLine, answerTextOf, answeredChecks } from "../lib/verify-landed.js";
import { VERDICTS, verdictFromText, verifyLabel, verifyPrompt } from "../lib/verify-prompt.js";
import { deleteWorktreeRow } from "../lib/worktree-remove.js";
import { configureRepo, git, slash } from "../tools/panel-testkit.mjs";

const exists = (p) => stat(p).then((s) => s.isDirectory()).catch(() => false);

// ── the label: one job name per base branch, in capitals ────────────────────────────────────────────────────────
test("the check agent's label names the base branch it reads", () => {
  assert.equal(verifyLabel("main"), "CHECKING MAIN");
  assert.equal(verifyLabel("master"), "CHECKING MASTER");
  assert.equal(verifyLabel(""), "CHECKING MAIN", "no base falls back to main rather than to an empty label");
});

// ── the script ─────────────────────────────────────────────────────────────────────────────────────────────────
test("the script asks the content question, names the base, and leaves the delete to the panel", () => {
  const prompt = verifyPrompt({
    project: "proj",
    worktree: "C:/trees/wt",
    root: "C:/proj",
    branch: "feat/x",
    base: "master",
    baseRef: "origin/master",
    remote: "origin",
    ahead: 2,
    commits: ["abc1234 do the thing", "def5678 and the other thing"],
    stamp: "2026-10-27T12-00-00",
    panelPort: 7473,
    scratchBase: "C:/Temp",
    dirty: 1,
    untracked: 0,
  });

  // The tree, the base and the ref the answer is about - a script that named a fixed "main" would check the wrong
  // branch on every master repo.
  assert.match(prompt, /CHECKING MASTER/);
  assert.match(prompt, /C:\/trees\/wt/);
  assert.match(prompt, /origin\/master/);
  assert.match(prompt, /abc1234 do the thing/, "the commits under question ride with the brief");
  // The method: a reverse-apply against a pristine export is the only test a squash landing survives.
  assert.match(prompt, /git apply --check --reverse/);
  assert.match(prompt, /git archive origin\/master/);
  assert.match(prompt, /git cherry origin\/master HEAD/);
  assert.match(prompt, /git cat-file -e "origin\/master:\$f"/);
  // The four words, and the grammar the panel parses.
  for (const v of VERDICTS) assert.ok(prompt.includes(v), `the script names the ${v} verdict`);
  assert.match(prompt, /LANDED: YES/);
  // The act is the panel's; the agent must not delete, tidy or push anything.
  assert.match(prompt, /moves this worktree's folder to the Windows Recycle Bin/);
  assert.match(prompt, /never delete, move or empty anything yourself/);
  assert.match(prompt, /never commit, stash, clean, checkout, switch or reset/);
  assert.doesNotMatch(prompt, /git push /, "a check never pushes");
  // The tree's own state is stated rather than assumed: a dirty tree is a finding, not a mess to tidy.
  assert.match(prompt, /1 modified and 0 untracked file/);
  assert.match(prompt, /7473/);
});

test("a locked tree is told to the agent, so its YES cannot be read as permission to delete", () => {
  const prompt = verifyPrompt({ project: "proj", worktree: "C:/trees/wt", base: "main", locked: { locked: true, by: "tree", branch: null } });
  assert.match(prompt, /LOCKED by the reader/);
  assert.match(prompt, /the panel refuses every delete here/);
});

test("a local-only repo is told there is nothing to fetch and nothing to push", () => {
  const prompt = verifyPrompt({ project: "proj", worktree: "C:/trees/wt", base: "main", remote: "" });
  assert.match(prompt, /remote: none/);
  assert.match(prompt, /skip the fetch/);
});

// ── the line the panel reads ───────────────────────────────────────────────────────────────────────────────────
test("the answer is the LAST LANDED: line of the final message, and only the four words count", () => {
  assert.equal(verdictFromText("report…\n\nLANDED: YES").verdict, "YES");
  assert.equal(verdictFromText("LANDED: NO — none of it is there").verdict, "NO");
  assert.equal(verdictFromText("LANDED: PARTIAL 2/5 commits present").verdict, "PARTIAL");
  assert.equal(verdictFromText("LANDED: SUPERSEDED — main rebuilt it in lib/steward.js:12").verdict, "SUPERSEDED");
  // A model that drafts the line and then writes the real one means the last one.
  assert.equal(verdictFromText("LANDED: YES\nrevising…\nLANDED: NO — the reverse-apply failed").verdict, "NO");
  // A word outside the four is not a verdict.
  assert.equal(verdictFromText("LANDED: MAYBE"), null);
  assert.equal(verdictFromText("the branch is not landed: the file is absent"), null, "prose is not the grammar");
  assert.equal(verdictFromText(""), null);
  assert.equal(verdictFromText(undefined), null);
  // ANSI from a tool's output must not hide the line.
  assert.equal(verdictFromText("\u001b[32mLANDED: YES\u001b[0m").verdict, "YES");
  // Whatever follows the word is kept, so the card can say why.
  assert.match(verdictFromText("LANDED: PARTIAL — 2 of 5 commits").note, /2 of 5 commits/);
});

// ── which settled runs act ────────────────────────────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const job = (over = {}) => ({
  id: "j1",
  label: "CHECKING MAIN",
  status: "done",
  endedAt: new Date(NOW - 60_000).toISOString(),
  finalMessage: "CHECKING MAIN: feat/x -> main\n  reverse-apply: PRESENT\n\nLANDED: YES",
  ...over,
});

test("a settled check with LANDED: YES is a candidate; nothing else is", () => {
  const found = answeredChecks([job()], { now: NOW });
  assert.equal(found.length, 1);
  assert.equal(found[0].answer.verdict, "YES");
  assert.equal(answerDeletes(found[0].answer), true);

  // A live turn has said nothing final, however much its transcript already carries.
  assert.equal(answeredChecks([job({ status: "running" })], { now: NOW }).length, 0);
  assert.equal(answeredChecks([job({ status: "starting" })], { now: NOW }).length, 0);
  // A merge agent's label is not a check's.
  assert.equal(answeredChecks([job({ label: "MERGING into MAIN" })], { now: NOW }).length, 0);
  // Answered once, acted on once.
  assert.equal(answeredChecks([job()], { now: NOW, acted: new Set(["j1"]) }).length, 0);
  // An answer older than the window is history, not an instruction.
  assert.equal(answeredChecks([job({ endedAt: new Date(NOW - 20 * 60_000).toISOString() })], { now: NOW }).length, 0);
  // No line, no act.
  assert.equal(answeredChecks([job({ finalMessage: "I looked and it is probably fine" })], { now: NOW }).length, 0);
  // Newest first, so a burst of answers is acted on in the order they arrived.
  const order = answeredChecks(
    [job({ id: "old", endedAt: new Date(NOW - 5 * 60_000).toISOString() }), job({ id: "new", endedAt: new Date(NOW - 10_000).toISOString() })],
    { now: NOW },
  );
  assert.deepEqual(order.map((o) => o.job.id), ["new", "old"]);
});

test("the answer comes from the live final message, with the completion's words as the fallback", () => {
  assert.equal(answerTextOf({ finalMessage: "…\nLANDED: YES" }), "…\nLANDED: YES");
  assert.equal(answerTextOf({ completion: { final: { text: "…\nLANDED: NO" } } }), "…\nLANDED: NO");
  // A summary that carries neither is not an answer, however green its card is: the sweep enriches from jobs.get()
  // for exactly this reason, and this pins the shape the panel must hand in.
  assert.equal(answerTextOf({ label: "CHECKING MAIN", status: "done" }), "");
  assert.equal(answeredChecks([{ ...job(), finalMessage: undefined }], { now: NOW }).length, 0);
});

test("only YES authorises a delete, and the card's line says which word it read", () => {
  for (const word of ["PARTIAL", "NO", "SUPERSEDED"]) {
    assert.equal(answerDeletes(verdictFromText(`LANDED: ${word}`)), false, `${word} must not delete`);
    assert.match(answerLine(verdictFromText(`LANDED: ${word}`), { base: "main" }), new RegExp(`LANDED: ${word}`));
  }
  assert.equal(answerDeletes(null), false, "an unreadable answer must not delete");
  assert.match(answerLine(null), /no LANDED: line/);
  assert.match(answerLine(verdictFromText("LANDED: YES"), { base: "main", deleted: true }), /Recycle Bin/);
  assert.match(answerLine(verdictFromText("LANDED: YES"), { base: "main", error: "the tree is not clean" }), /nothing was deleted: the tree is not clean/);
});

// ── the act, against a real repo ──────────────────────────────────────────────────────────────────────────────
let sharedAct = null;
async function getActFixture() {
  if (!sharedAct) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-check-"));
    const repo = path.join(root, "proj");
    await mkdir(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    configureRepo(repo);
    await writeFile(path.join(repo, "README.md"), "# test\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    const wt = path.join(repo, ".worktrees", "wt-landed");
    git(repo, ["worktree", "add", "-q", "-b", "feat/landed", wt]);
    await writeFile(path.join(wt, "work.txt"), "feat/landed\n", "utf8");
    git(wt, ["add", "."]);
    git(wt, ["commit", "-q", "-m", "work on feat/landed"]);
    sharedAct = { root, repo, wt };
  }
  return sharedAct;
}

test.after(async () => {
  if (sharedAct) await rm(sharedAct.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const project = (repo) => ({ name: "proj", path: repo, mainBranch: "main" });
const rowFor = (wt, branch) => ({ name: path.basename(wt), path: slash(wt), branch });
const quiet = { list: () => [], check: () => ({ locked: false }) };

test("the reader's lock and a live agent both refuse the removal, and neither touches the folder", async () => {
  const { repo, wt } = await getActFixture();

  const locked = await deleteWorktreeRow({
    project: project(repo),
    row: rowFor(wt, "feat/landed"),
    target: wt,
    jobs: quiet,
    locks: { check: () => ({ locked: true, reason: "this worktree is locked by the reader", by: "tree" }) },
    platform: "linux",
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 409, "a locked tree is a refusal the page can banner, not a silent no-op");
  assert.match(locked.error, /locked/);
  assert.equal(await exists(wt), true, "the refused delete left the tree in place");

  // A CHECKING agent standing in the tree is a live job: the answer arrives after it settles, so the sweep must never
  // race its own run.
  const busy = await deleteWorktreeRow({
    project: project(repo),
    row: rowFor(wt, "feat/landed"),
    target: wt,
    jobs: { list: () => [{ id: "abc12345", status: "running", cwd: slash(wt) }] },
    locks: quiet,
    platform: "linux",
  });
  assert.equal(busy.ok, false);
  assert.equal(busy.status, 409);
  assert.match(busy.error, /abc12345/);
  assert.equal(await exists(wt), true);
});

test("a LANDED: YES removal takes the folder off disk and the worktree out of git", async () => {
  const { repo, wt } = await getActFixture();

  const out = await deleteWorktreeRow({
    project: project(repo),
    row: rowFor(wt, "feat/landed"),
    target: wt,
    jobs: quiet,
    locks: quiet,
    platform: "linux",
  });

  assert.equal(out.ok, true, `the removal must succeed: ${out.error || ""}`);
  assert.equal(await exists(wt), false, "the folder is gone");
  assert.equal(/feat\/landed/.test(git(repo, ["worktree", "list", "--porcelain"])), false, "git no longer lists it");
  assert.equal(out.rowPath, slash(wt), "the answer carries the STORE's key, so the browser drops the right row");
});

test("the project's own checkout is never a worktree to remove", async () => {
  const { repo } = await getActFixture();
  const out = await deleteWorktreeRow({
    project: project(repo),
    row: { name: "proj", path: slash(repo), branch: "main" },
    target: repo,
    jobs: quiet,
    locks: quiet,
    platform: "linux",
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.match(out.error, /project's own checkout/);
  assert.equal(await exists(repo), true);
});
