// The harness itself, asserted. If these fail, every other test in this directory is lying.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ROOT, startPanel } from "../tools/panel-testkit.mjs";

const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));

test("the project stays zero-dependency and ESM", () => {
  assert.equal(pkg.type, "module", "server.js and lib/ are ESM");
  assert.deepEqual(pkg.dependencies ?? {}, {}, "no runtime dependencies: the panel runs from a bare clone");
});

test("npm test is the node:test runner, not a framework", () => {
  assert.equal(typeof pkg.scripts?.test, "string", "package.json has a test script");
  assert.match(pkg.scripts.test, /node --test/, "the runner is Node's built-in, so no install is needed");
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
