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
import { discover, stateOf } from "../tools/verify.mjs";

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

// THE FAMILY'S OWN CONTRACT. A harness that NOTHING runs is a rumour: its red is not evidence of a regression and its
// green is not evidence of a fix, which is exactly how two of them rotted against main for a week while every reader
// assumed somebody was watching. So each one declares what it is on its own header line, and this test holds the
// declaration to something:
//
//   // HARNESS: LIVE GATE        it tracks main, and the repo can run it by NAME — a `verify:*` script in package.json
//   // HARNESS: FROZEN EVIDENCE  it records one commit, that commit is named, and it must NEVER be used as a gate
//
// The runner skips the frozen ones (test/verify-runner.test.js proves the skip against a fixture that would fail if it
// ran). This half is the other direction: a live gate that loses its registration, or its header, fails here — in
// `npm test`, which is the gate somebody actually runs.
test("every declared harness is wired the way its own header says", async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const commands = Object.values(pkg.scripts ?? {}).join("\n");
  const files = [...discover(path.join(ROOT, "tools")), ...discover(path.join(ROOT, "harness"))];
  const declared = files.map((f) => ({ rel: slash(path.relative(ROOT, f)), state: stateOf(f), file: f })).filter((x) => x.state);

  const live = declared.filter((x) => x.state === "LIVE GATE");
  const frozen = declared.filter((x) => x.state === "FROZEN EVIDENCE");

  // The two members this contract was written for, by name. A rename or a dropped header fails here rather than
  // quietly turning a gate back into a rumour.
  for (const name of ["tools/verify-action-harvest.mjs", "tools/verify-restart-line-harvest.mjs"]) {
    assert.ok(
      live.some((x) => x.rel === name),
      `${name} must declare \`// HARNESS: LIVE GATE\` in its header — it is the live gate for a rule main still has to keep`,
    );
  }

  for (const x of live) {
    assert.ok(
      commands.includes(x.rel),
      `${x.rel} says LIVE GATE but no package.json script runs it — wire it (npm run verify:<name>), or it is a rumour`,
    );
    assert.match(
      (await readFile(x.file, "utf8")).split(/\n/).slice(0, 40).join("\n"),
      /^\/\/\s*HARNESS:\s*LIVE GATE\b/m,
      `${x.rel} must carry its declaration in the header, where the runner and a reader look for it`,
    );
  }

  for (const x of frozen) {
    const head = (await readFile(x.file, "utf8")).split(/\n/).slice(0, 12).join("\n");
    assert.match(head, /\b[0-9a-f]{7,40}\b/, `${x.rel} says FROZEN EVIDENCE but names no commit it proved`);
    assert.match(head, /\bnever\b/i, `${x.rel} says FROZEN EVIDENCE but does not say it must never be run as a gate`);
  }

  assert.ok(live.length >= 2, `the fleet keeps at least the two live gates this contract exists for; found ${live.length}`);
});
