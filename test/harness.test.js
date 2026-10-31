// The harness itself, asserted. If these fail, every other test in this directory is lying.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ROOT,
  createVerifier,
  readSource,
  sliceBetween,
  sliceRegion,
  slash,
  startPanel,
  waitFor,
} from "../tools/panel-testkit.mjs";

const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));

test("the project stays zero-dependency and ESM", () => {
  assert.equal(pkg.type, "module", "server.js and lib/ are ESM");
  assert.deepEqual(pkg.dependencies ?? {}, {}, "no runtime dependencies: the panel runs from a bare clone");
});

test("npm test is the node:test runner, not a framework", () => {
  assert.equal(typeof pkg.scripts?.test, "string", "package.json has a test script");
  assert.match(pkg.scripts.test, /node --test/, "the runner is Node's built-in, so no install is needed");
  // A bare `node --test` discovers every matching file under the checkout, including a nested
  // worktree's copy of this suite; scoping the target is what keeps one checkout to one run.
  assert.match(pkg.scripts.test, /test\/\*\.test\.js/, "the target is this project's test directory, not a bare scan");
});

test("the harness boots a real server and can stop it", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const r = await fetch(`${panel.base}/api/health`);
  assert.equal(r.status, 200);
  const health = await r.json();
  assert.equal(health.ok, true);
  assert.deepEqual(health.projects, [], "the sandbox config scans an empty directory, so there are no projects");
  assert.equal(typeof health.settings.version, "string", "the running build reports its own version");
});

test("shared testkit helpers normalize paths, slice source regions, and track verifier assertions", async () => {
  assert.equal(slash(["C:", "repo", ".worktrees", "wt"].join("\\")), "C:/repo/.worktrees/wt");
  const sample = "// prefix\n// ---- alpha\nconst x = 1;\n// ---- end alpha\n// suffix\n";
  assert.equal(sliceRegion(sample, "alpha").trim(), "const x = 1;");
  assert.equal(sliceBetween(sample, "// ---- alpha", "// ---- end alpha").trim(), "// ---- alpha\nconst x = 1;");
  assert.ok(readSource("package.json").includes('"name"'));
  const v = createVerifier();
  v.ok("passes", true);
  v.check("matches", { a: 1 }, { a: 1 });
  assert.equal(v.checks, 2);
  assert.equal(v.failures, 0);
  assert.equal(await waitFor(() => "ready", { timeoutMs: 200, stepMs: 10 }), "ready");
});
