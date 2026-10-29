// The rebase outcome's route, proved over HTTP against the real server on its own port.
//
//   POST /api/worktree/rebase {project, path, dryRun?}
//
// The module is proved in test/rebase.test.js against real git; this file is about the wiring the page talks to — the
// resolution of a path to its project, every refusal that has to reach the reader as a sentence, and the one property
// a first-press test cannot show: a route that REWRITES a branch is not idempotent, so the second press is a 409, not
// a changed:false. The dry run is sent first because it must answer with the plan and leave the tip byte-identical —
// a probe that only sends the real press cannot tell "read the tree and acted" from "assumed it".
//
// The fixture carries a bare `origin` with the branch pushed to it on purpose: that is what makes `published: true`
// reachable, and the page prints the force-push sentence off exactly that field.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    .replace(/\r\n/g, "\n")
    .trim();
const slash = (p) => String(p || "").replace(/\\/g, "/");
// For the questions git answers with an exit code (is-ancestor, diff --quiet) rather than with output.
const ran = (cwd, args) => {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
};

// Discovery happens in /api/reload and settles a scan behind the answer, so poll /api/state rather than sleeping and
// hoping: the route resolves a path against the registry, and a row that is not there yet is a false refusal.
async function waitForRow(base, name, treePath, ms = 30_000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    const state = await (await fetch(`${base}/api/state`)).json();
    last = (state.projects || []).find((p) => p.name === name);
    if (last && (last.worktrees || []).some((w) => slash(w.path) === slash(treePath))) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the board never held ${treePath}: ${JSON.stringify(last && last.worktrees)}`);
}

test("the rebase route resolves the tree, refuses what it must, plans on a dry run and rewrites only on the press", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "wtgui-rebaseroute-"));
  const scanRoot = path.join(base, "repos");
  const repo = path.join(scanRoot, "proj");
  const origin = path.join(base, "origin.git");
  await mkdir(repo, { recursive: true });

  // A real repo with a real remote, so `published` has something to be true about.
  git(base, ["init", "--bare", "-q", origin]);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "rebase@local"]);
  git(repo, ["config", "user.name", "Rebase Route"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  git(repo, ["remote", "add", "origin", slash(origin)]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);

  // The branch under test, pushed so it has its own copy on the remote — the shape whose shas a replay rewrites.
  const worked = path.join(repo, ".worktrees", "wt-worked");
  git(repo, ["worktree", "add", "-q", "-b", "feat/worked", worked]);
  await writeFile(path.join(worked, "work.txt"), "a change\n", "utf8");
  git(worked, ["add", "."]);
  git(worked, ["commit", "-q", "-m", "add work"]);
  git(worked, ["push", "-q", "-u", "origin", "feat/worked"]);

  // The base moves on after the cut, so there is one commit to replay — and one thing for the remote to be behind.
  await writeFile(path.join(repo, "later.txt"), "later\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main moves on"]);
  git(repo, ["push", "-q", "origin", "main"]);

  // A branch that never moved off main: nothing to replay, and a different sentence from a clean branch's.
  const empty = path.join(repo, ".worktrees", "wt-empty");
  git(repo, ["worktree", "add", "-q", "-b", "feat/empty", empty]);

  const panel = await startPanel({ config: { scanRoots: [scanRoot] } });
  t.after(async () => {
    await panel.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const reload = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(reload.status, 200, `reload must succeed: ${reload.text.slice(0, 200)}`);
  await waitForRow(panel.base, "proj", worked);

  // A path that is not a directory: a sentence, not a stack trace.
  const stray = await post(panel.base, "/api/worktree/rebase", { body: { project: "proj", path: path.join(base, "nope") } });
  assert.equal(stray.status, 404);
  assert.match(stray.json?.error || "", /no such directory/);

  // A directory no project owns is refused, not rebased.
  const unowned = await post(panel.base, "/api/worktree/rebase", { body: { project: "proj", path: base } });
  assert.equal(unowned.status, 400, `a directory no project owns is refused: ${unowned.status} ${unowned.text.slice(0, 200)}`);
  assert.match(unowned.json?.error || "", /not inside a known project/);

  // The project's own checkout is on the base branch: there is no branch of its own to replay.
  const onBase = await post(panel.base, "/api/worktree/rebase", { body: { project: "proj", path: repo } });
  assert.equal(onBase.status, 409);
  assert.match(onBase.json?.error || "", /on main itself/);

  // A branch that never committed has nothing to move.
  const nothing = await post(panel.base, "/api/worktree/rebase", { body: { project: "proj", path: empty } });
  assert.equal(nothing.status, 409);
  assert.match(nothing.json?.error || "", /no commits of its own/);

  // A dirty tree is refused from git, not from the page's stale row: a replay would carry somebody's unfinished work.
  await writeFile(path.join(worked, "work.txt"), "half finished\n", "utf8");
  const dirty = await post(panel.base, "/api/worktree/rebase", { body: { project: "proj", path: worked, dryRun: true } });
  assert.equal(dirty.status, 409);
  assert.match(dirty.json?.error || "", /not clean/);
  git(worked, ["checkout", "--", "work.txt"]);

  // The dry run: the plan, the ref, and NO write — the tip has to be byte-identical afterwards.
  const before = git(worked, ["rev-parse", "HEAD"]);
  const dry = await post(panel.base, "/api/worktree/rebase", { body: { project: "proj", path: worked, dryRun: true } });
  assert.equal(dry.status, 200, `the dry run must answer 200: ${dry.text.slice(0, 300)}`);
  assert.equal(dry.json.dryRun, true);
  assert.equal(dry.json.ok, true);
  assert.equal(dry.json.target, "origin/main", "the board's own base ref is the target");
  assert.equal(dry.json.replayed, 1);
  assert.equal(dry.json.branch, "feat/worked");
  assert.equal(dry.json.base, "main");
  assert.equal(slash(dry.json.worktree), slash(worked));
  assert.match(dry.json.why || "", /replays this branch's own 1 commit/);
  assert.equal(git(worked, ["rev-parse", "HEAD"]), before, "a dry run writes nothing");
  assert.equal(git(worked, ["status", "--porcelain"]), "");

  // The real press: the shas it moved, the count it replayed, and the target proved an ancestor of the new tip.
  const pressed = await post(panel.base, "/api/worktree/rebase", { body: { project: "proj", path: worked } });
  assert.equal(pressed.status, 200, `the press must answer 200: ${pressed.text.slice(0, 300)}`);
  assert.equal(pressed.json.ok, true);
  assert.equal(pressed.json.target, "origin/main");
  assert.equal(pressed.json.replayed, 1);
  assert.equal(pressed.json.fromShort, before.slice(0, 7));
  assert.notEqual(pressed.json.toShort, pressed.json.fromShort, "the branch was rewritten");
  assert.equal(pressed.json.containsTarget, true, "git was asked whether the target is now an ancestor");
  assert.equal(pressed.json.published, true, "the branch has its own copy on the remote, so the page must warn about a force-push");
  assert.equal(pressed.json.branch, "feat/worked");

  // The tree on disk is the new tip, still clean, and the base's newer file is in it.
  assert.equal(git(worked, ["rev-parse", "HEAD"]), pressed.json.to, "HEAD is the tip the route reported");
  assert.equal(git(worked, ["status", "--porcelain"]), "");
  assert.equal(ran(worked, ["merge-base", "--is-ancestor", "origin/main", "HEAD"]), true, "the base's tip is an ancestor of the new tip");
  assert.equal(existsSync(path.join(worked, "later.txt")), true, "the base's newer file is in the worktree");

  // A route that rewrites a branch is not idempotent: the second press is a REFUSAL with a sentence, not a success.
  const again = await post(panel.base, "/api/worktree/rebase", { body: { project: "proj", path: worked } });
  assert.equal(again.status, 409);
  assert.match(again.json?.error || "", /already contains origin\/main's tip — nothing to replay/);

  // And the board holds the row on the new tip, which is what every other tab is redrawn from.
  const state = await (await fetch(`${panel.base}/api/state`)).json();
  const proj = (state.projects || []).find((p) => p.name === "proj");
  assert.ok(proj, "the project is still on the board");
  const row = (proj.worktrees || []).find((w) => slash(w.path) === slash(worked));
  assert.ok(row, "the rebased tree is still a row");
  assert.equal(row.branch, "feat/worked");
  assert.equal(row.head, pressed.json.toShort, "the row the page draws carries the new tip");
});
