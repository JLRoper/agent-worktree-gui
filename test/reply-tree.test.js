// A reply runs in the tree its thread was created for — never in the primary checkout.
//
// Two shapes a released tree leaves behind, and both started a run on the 0.62.1 boot: an EMPTY folder, where every
// `git` call walks up to the project's own checkout, and a folder that is GONE, which fell through the
// `stat().isDirectory()` test to the record's own dead `cwd` (the gateway's shell then resolves against its own
// directory). The path that started it was the assistant's own TO line — `answerThread` — and the reader's Send on a
// draft takes the same route in server.js. Both ask lib/own-tree.js's `replyTree` now, and a refusal is journalled
// by name with the tree and the checkout the run would have worked in.
//
// The legitimate cases matter as much as the refusal: a thread in a real worktree still resumes, and a run that was
// STARTED in the project's own checkout is a tree of its own — refusing that would break the base-checkout card.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ASSISTANT_THREAD, Assistant } from "../lib/assistant.js";
import { ownTree, replyTree } from "../lib/own-tree.js";

// The spelling every path comparison here uses: forward slashes, case folded. git answers with `/`, the fixture
// paths carry `\`, and both name the same checkout.
const key = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", `user.email=${"tester" + String.fromCharCode(64) + "example.invalid"}`, "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    windowsHide: true,
  }).trim();

// A repo, a REAL worktree cut from it, and then that tree released the way a removal leaves one: the registration
// and the branch go with `git worktree remove`, and the folder stays (empty) when the removal did not delete it.
function sandbox(t, { keepFolder = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-reply-tree-"));
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const wt = path.join(repo, ".worktrees", "two-assistants-run-da6402");
  git(repo, "worktree", "add", "-q", "-b", "wtgui/two-assistants-run-da6402", wt);
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold a folder; the scratch sweep takes it later */
    }
  });
  return { dir, repo, wt, release: () => {
    git(repo, "worktree", "remove", wt);
    if (keepFolder) mkdirSync(wt, { recursive: true });
  } };
}

test("a linked worktree is a tree of its own, and a thread replies there", async (t) => {
  const { repo, wt } = sandbox(t);
  const own = await ownTree(wt);
  assert.equal(own.ok, true, `the fixture worktree is its own tree: ${JSON.stringify(own)}`);

  const rec = { id: "j1", thread: "wtgui-live", cwd: wt, worktreePath: wt, projectPath: repo };
  const verdict = await replyTree(rec);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.dir, wt);
});

test("the project's own checkout is its own tree — a base-checkout thread still replies", async (t) => {
  // Refusing this would break the card whose run deliberately stays in the reader's checkout. What the guard is
  // about is a directory that is NOT its own tree, not "the primary checkout" as a path.
  const { repo } = sandbox(t);
  const verdict = await replyTree({ id: "j2", thread: "wtgui-base", cwd: repo, worktreePath: null, projectPath: repo });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.dir, repo);
});

test("a released tree's leftover folder is refused, naming the primary checkout it would work in", async (t) => {
  const { repo, wt, release } = sandbox(t);
  release();
  // The shape of the failure: the folder is there, and git inside it answers for the PRIMARY checkout.
  assert.equal(git(wt, "rev-parse", "--show-toplevel").replace(/\\/g, "/").toLowerCase(), repo.replace(/\\/g, "/").toLowerCase());
  const verdict = await replyTree({ id: "j3", thread: "wtgui-dead", cwd: wt, worktreePath: wt, projectPath: repo });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.named, wt);
  assert.equal(key(verdict.instead), key(repo), "the checkout git answered for is the one named");
  assert.match(verdict.refusal, /not a tree of its own any more/);
  assert.match(verdict.refusal, /git answers for/);
  assert.ok(verdict.refusal.includes(repo), `the checkout is named: ${verdict.refusal}`);
});

test("a released tree whose folder is gone is refused, naming the checkout it was cut from", async (t) => {
  const { repo, wt, release } = sandbox(t, { keepFolder: false });
  release();
  const verdict = await replyTree({ id: "j4", thread: "wtgui-gone", cwd: wt, worktreePath: wt, projectPath: repo });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /tree is gone/);
  assert.equal(key(verdict.instead), key(repo), "the checkout above the gone tree is named");
  assert.ok(verdict.refusal.includes(repo), `the checkout is named: ${verdict.refusal}`);
});

// ---- the path that started the run: the assistant's TO line --------------------------------------
async function board(t, { record, created = [] }) {
  const { dir } = sandbox(t);
  const assistant = new Assistant({
    config: {
      jobsFile: path.join(dir, "jobs.json"),
      defaultCwd: dir,
      assistantFile: path.join(dir, "assistant.json"),
      charterFile: path.join(dir, "assistant-charter.md"),
    },
    jobs: {
      list: () => [record],
      get: (id) => (id === record.id ? record : null),
      firstOfThread: (thread) => (thread === record.thread ? record : null),
      busyFor: () => ({ held: false, where: null, by: [] }),
      modelFor: () => null,
      create: async (opts) => {
        created.push(opts);
        return { id: "job-started", thread: opts.thread, status: "starting" };
      },
    },
    getProjects: () => [{ name: "repo", path: dir, mainBranch: "main", remote: "origin" }],
    onEvent: () => {},
    onLog: () => {},
  });
  assistant.setSettings({ autonomy: "auto" });
  t.after(() => {
    clearTimeout(assistant.persistTimer);
    if (assistant.timer) clearInterval(assistant.timer);
  });
  return { assistant, created, dir };
}

const to = (thread, text = "are you still there?") => ({
  id: "turn-to-released",
  thread: ASSISTANT_THREAD,
  turn: 1,
  status: "done",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  endedAt: new Date().toISOString(),
  lines: [{ kind: "text", text: `That worker's tree is finished. Letting it know.\nTO ${thread}: ${text}\n`, at: Date.now() }],
});

test("a TO line at a released tree starts no run, and the refusal is journalled by name", async (t) => {
  const { repo, wt, release } = sandbox(t);
  release();
  const record = { id: "5ba56bf1", thread: "wtgui-prove-two-assistants-running-4f046", cwd: wt, worktreePath: wt, projectPath: repo, status: "done" };
  const { assistant, created } = await board(t, { record });
  await assistant.harvest(to(record.thread));

  assert.equal(created.length, 0, "no job was created — the reply never reached the store");
  const refused = assistant.journal.filter((j) => j.kind === "reply-tree-refused");
  assert.equal(refused.length, 1, JSON.stringify(assistant.journal.map((j) => j.kind)));
  assert.ok(String(refused[0].text).includes(wt), "the tree is named");
  assert.ok(String(refused[0].text).includes(repo), "…and the checkout it would have worked in");
  assert.match(String(refused[0].text), /nothing was sent and no run was started/);
  // One refusal is one line: `carry`'s generic send-failed must not say the same thing a second time.
  assert.equal(assistant.journal.filter((j) => j.kind === "send-failed").length, 0, JSON.stringify(assistant.journal.map((j) => j.kind)));
});

test("a TO line at a real worktree still starts its run there", async (t) => {
  const { repo, wt } = sandbox(t);
  const record = { id: "aa6b72b5", thread: "wtgui-live-worker", cwd: wt, worktreePath: wt, projectPath: repo, status: "done" };
  const { assistant, created } = await board(t, { record });
  await assistant.harvest(to(record.thread));

  assert.equal(created.length, 1, JSON.stringify(assistant.journal.map((j) => `${j.kind}: ${j.text}`)));
  assert.equal(created[0].cwd, wt, "the reply runs in the thread's own tree");
  assert.equal(created[0].resumeDir, wt);
  assert.equal(created[0].thread, record.thread);
  assert.equal(assistant.journal.filter((j) => j.kind === "reply-tree-refused").length, 0);
});
