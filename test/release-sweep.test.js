// The release executor on a REAL panel: the switch, the sweep, and the sentence the row ends up carrying.
//
// The gates themselves are proved in test/worktree-release.test.js; this file proves the wiring the reader actually
// meets — a request sitting in the store when the panel boots is swept, refused on the panel's own evidence, and the
// refusal is written back onto that tree's ROW in `/api/state`, which is the field the page draws. Nothing here needs
// GitHub: both cases are refused BEFORE the PR is ever asked about, which is also the point — a closed switch or one
// uncommitted file stops the act without a single remote call.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const slash = (p) => String(p || "").replace(/\\/g, "/");
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();

// A repo with one commit on main and one worktree `<repo>/.worktrees/tree-1a2b3c`, cut from main. The tree lives
// inside the project on purpose: a row is a tree this project OWNS (`isInsideProject`), and a tree outside it is not
// on the board at all.
async function makeBoard(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-release-panel-"));
  const repos = path.join(dir, "repos");
  const proj = path.join(repos, "proj");
  const tree = path.join(proj, ".worktrees", "tree-1a2b3c");
  await mkdir(proj, { recursive: true });
  git(proj, ["init", "-q", "-b", "main"]);
  git(proj, ["config", "user.email", ["tester", "example.invalid"].join(String.fromCharCode(64))]);
  git(proj, ["config", "user.name", "Test"]);
  git(proj, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(proj, "README.md"), "# test\n", "utf8");
  git(proj, ["add", "."]);
  git(proj, ["commit", "-q", "-m", "init"]);
  git(proj, ["worktree", "add", "-q", "-b", "feature", slash(tree)]);
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { dir, repos, proj, tree };
}

const configFor = (board, { releaseWorktrees, agentCleanup }) => ({
  scanRoots: [slash(board.repos)],
  projects: [
    {
      name: "proj",
      path: slash(board.proj),
      mainBranch: "main",
      remote: null,
      ...(releaseWorktrees === undefined ? {} : { releaseWorktrees }),
    },
  ],
  // The board's own veto (Settings → Board → Agents clean up), above every project's grant.
  ...(agentCleanup === undefined ? {} : { agentCleanup }),
  jobsFile: path.join(board.dir, "logs", "jobs.json"),
  assistantFile: path.join(board.dir, "logs", "assistant.json"),
  projectsCacheFile: path.join(board.dir, "logs", "projects.json"),
  releasesFile: path.join(board.dir, "logs", "releases.json"),
  assistant: { enabled: false },
});

// A request already in the store, as lib/jobs.js would have written it as a turn ended.
async function seedRequest(board, { runId = "run-seeded", why = "the PR is merged and the tree is clean" } = {}) {
  const file = path.join(board.dir, "logs", "releases.json");
  const key = `proj::${slash(board.tree)}`;
  const rec = {
    key,
    project: "proj",
    path: slash(board.tree),
    branch: "feature",
    why,
    requestedAt: new Date().toISOString(),
    runId,
    thread: "wtgui-release-probe",
    state: "requested",
    outcome: null,
    at: null,
    detail: "",
    steps: [],
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: 1, requests: { [key]: rec } }, null, 2)}\n`, "utf8");
  return { file, key };
}

const hasRef = (cwd, ref) => {
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
};

const rowFor = (snap, tree) => {
  for (const project of snap.projects || []) {
    const row = (project.worktrees || []).find((w) => slash(w.path).toLowerCase() === slash(tree).toLowerCase());
    if (row) return row;
  }
  return null;
};

async function waitForRow(base, tree, predicate, what, { timeout = 60_000 } = {}) {
  const until = Date.now() + timeout;
  let last = null;
  for (;;) {
    const r = await fetch(`${base}/api/state`);
    assert.equal(r.status, 200, "/api/state answers the sandbox");
    last = await r.json();
    const row = rowFor(last, tree);
    if (row && predicate(row)) return row;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}; row: ${JSON.stringify(row ? { path: row.path, release: row.release } : null)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test("a request on a project with the switch off is refused, and nothing on disk is touched", { timeout: 120_000 }, async (t) => {
  const board = await makeBoard(t);
  const { file } = await seedRequest(board);
  const panel = await startPanel({ dir: board.dir, keep: true, config: configFor(board, { releaseWorktrees: undefined }) });
  t.after(async () => {
    await panel.stop();
  });
  const r = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(r.status, 200, `reload must succeed: ${r.text.slice(0, 200)}`);

  const row = await waitForRow(panel.base, board.tree, (w) => Boolean(w.release?.outcome), "the row's release outcome");
  assert.match(row.release.outcome, /^refused: releaseWorktrees is off for project proj/);
  assert.equal(row.release.state, "refused");
  assert.equal(row.release.runId, "run-seeded");
  assert.equal(row.release.path, slash(board.tree));
  assert.ok(row.release.requestedAt, "the row says when the request was made");
  assert.equal(row.release.why, "the PR is merged and the tree is clean");
  // The tree, its branch and the record itself are exactly where they were.
  assert.equal(existsSync(board.tree), true);
  assert.equal(hasRef(board.proj, "refs/heads/feature"), true, "the branch is still there");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(Object.values(saved.requests)[0].state, "refused");
  assert.equal(panel.log().includes("release "), true, "the panel logged the decision");
});

test("with the switch on, one uncommitted file refuses the release and the row says which gate", { timeout: 120_000 }, async (t) => {
  const board = await makeBoard(t);
  await writeFile(path.join(board.tree, "scratch.txt"), "not committed\n", "utf8");
  await seedRequest(board, { runId: "run-dirty" });
  const panel = await startPanel({ dir: board.dir, keep: true, config: configFor(board, { releaseWorktrees: true }) });
  t.after(async () => {
    await panel.stop();
  });
  const r = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(r.status, 200, `reload must succeed: ${r.text.slice(0, 200)}`);

  const row = await waitForRow(panel.base, board.tree, (w) => Boolean(w.release?.outcome), "the row's release outcome");
  assert.match(row.release.outcome, /^refused: the tree is not clean \(1 changed path\)/);
  assert.equal(row.release.state, "refused");
  // Nothing was removed: the tree, its untracked file and its branch are all still there.
  assert.equal(existsSync(board.tree), true);
  assert.equal(existsSync(path.join(board.tree, "scratch.txt")), true);
  assert.equal(git(board.proj, ["worktree", "list", "--porcelain"]).includes(slash(board.tree)), true);
  assert.equal(hasRef(board.proj, "refs/heads/feature"), true, "the branch is still there");
});

test("a project with the grant is still refused while the board's switch is off, and nothing on disk is touched", { timeout: 120_000 }, async (t) => {
  const board = await makeBoard(t);
  const { file } = await seedRequest(board, { runId: "run-veto" });
  const panel = await startPanel({ dir: board.dir, keep: true, config: configFor(board, { releaseWorktrees: true, agentCleanup: false }) });
  t.after(async () => {
    await panel.stop();
  });
  const r = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(r.status, 200, `reload must succeed: ${r.text.slice(0, 200)}`);

  const row = await waitForRow(panel.base, board.tree, (w) => Boolean(w.release?.outcome), "the row's release outcome");
  // The sentence names the row the reader pressed, not the project key they never edited: this refusal is the
  // switch's, and a reader who goes looking for `releaseWorktrees` in config.json finds it true and is confused.
  assert.match(row.release.outcome, /^refused: agent cleanup is off in Settings → Board → Agents clean up/);
  assert.equal(row.release.state, "refused");
  assert.equal(existsSync(board.tree), true);
  assert.equal(hasRef(board.proj, "refs/heads/feature"), true, "the branch is still there");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(Object.values(saved.requests)[0].state, "refused");
});
