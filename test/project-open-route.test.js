// POST /api/project/open: the reader's own promotion signal. Opening an OLD project asks the server to re-probe
// it and read its rows once (lib/tiers.js); opening a recent one is a no-op because the scan cadence already has
// it, and naming a project the board does not watch is a 404 rather than a silent success.
//
// The panel here is a real server in a sandbox: the route, the scheduler and the tier book are the shipped ones.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { startPanel, waitForState, post } from "../tools/panel-testkit.mjs";

const sandbox = mkdtempSync(path.join(tmpdir(), "wag-open-route-"));
const repos = path.join(sandbox, "repos");
mkdirSync(repos, { recursive: true });
after(() => rmSync(sandbox, { recursive: true, force: true }));

function makeRepo(name, ageDays) {
  const dir = path.join(repos, name);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() - ageDays * 864e5).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], { stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  execFileSync("git", ["-C", dir, "add", "-A"], { env, stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "first"], { env, stdio: "ignore" });
}

makeRepo("old-repo", 20);
makeRepo("new-repo", 0);

const panel = await startPanel({
  dir: sandbox,
  config: {
    // One bucket of one second: the gate runs on every tick, so a promotion is observable in a test instead of
    // waiting for a wall-clock hour.
    tierBuckets: 1,
    tierCheckSeconds: 1,
    tierDays: 7,
    tiersFile: path.join(sandbox, "tiers.json"),
  },
});
after(() => panel.stop());
const base = panel.base;

const stats = async () => (await fetch(`${base}/api/stats`).then((r) => r.json())).scheduler;

test("discovery gives the old repo its tier and the route promotes it once", async () => {
  await waitForState(
    base,
    (state) => state.projects.some((p) => p.name === "old-repo" && p.tier === "old") && state.projects.some((p) => p.name === "new-repo" && p.tier === "recent"),
    "both repos discovered and classified",
    { timeout: 60_000 },
  );
  // The boot pass is what writes the rows; a promotion that races it would find `projectRunning` and do nothing,
  // so wait until both projects have had their pass.
  const deadline = Date.now() + 60_000;
  while ((await stats()).fullPasses < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));

  const opened = await post(base, "/api/project/open", { body: { project: "old-repo" } });
  assert.equal(opened.status, 200, opened.text);
  assert.equal(opened.json.project, "old-repo");
  assert.equal(opened.json.tier, "old");
  assert.equal(opened.json.promoting, true, "opening an old project starts a promotion");

  // It happened: the scheduler counted one promotion and the repo is back on the gate with the same old commit.
  const done = Date.now() + 60_000;
  let promoted = 0;
  while (Date.now() < done) {
    promoted = (await stats()).tierPromotions || 0;
    if (promoted >= 1) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(promoted >= 1, `the promotion ran (tierPromotions=${promoted})`);
  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  const old = state.projects.find((p) => p.name === "old-repo");
  assert.equal(old.tier, "old", "a 20-day commit is still the old tier after the probe");
  assert.ok(old.worktrees.length >= 1, "its row is on the board");
});

test("a recent project needs no promotion, and an unknown name is refused", async () => {
  const recent = await post(base, "/api/project/open", { body: { project: "new-repo" } });
  assert.equal(recent.status, 200);
  assert.equal(recent.json.tier, "recent");
  assert.equal(recent.json.promoting, false, "the scan cadence already reads it");

  const missing = await post(base, "/api/project/open", { body: { project: "not-watched" } });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /no project called 'not-watched'/);
});
