// The verification runner, asserted: what it finds, what it runs, and what it calls a failure.
//
// The runner is the one thing every other harness now goes through, so its own mistakes are the loudest: a
// discovery that silently skips a file (a harness nobody runs again), a timeout that reports PASS (a claim that
// was never measured), or a summary that counts the wrong thing. Each is a claim here, driven by three throwaway
// harnesses in a temp directory — the runner's --dir exists for this test, and nothing under tools/ is executed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "tools", "verify.mjs");

function run(args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [RUNNER, ...args], { cwd: ROOT, timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function fixture({ slow = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "wtgui-runner-"));
  const files = {
    "verify-ok.mjs": '// a harness that measures something and agrees\nconsole.log("measured 1 thing");\nprocess.exit(0);\n',
    "verify-bad.mjs": '// a harness whose claim did not hold\nconsole.log("measured 2 things; one was wrong");\nprocess.exit(3);\n',
    "verify-slow.mjs": '// a harness that never finishes\nsetTimeout(() => process.exit(0), 30_000);\n',
    "not-a-harness.mjs": "process.exit(1);\n",
  };
  for (const [name, body] of Object.entries(files)) {
    if (!slow && name === "verify-slow.mjs") continue;
    await writeFile(path.join(dir, name), body, "utf8");
  }
  return dir;
}

test("--list finds the harnesses and reads each one's own sentence", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await run(["--list", "--dir", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /verify-ok\.mjs\n {4}a harness that measures something and agrees/);
  assert.match(r.stdout, /verify-bad\.mjs/);
  assert.match(r.stdout, /verify-slow\.mjs/);
  assert.doesNotMatch(r.stdout, /not-a-harness/, "only verify-*.mjs is a harness");
  assert.match(r.stdout, /3 harnesses in/);
});

test("--all runs every harness, passes the ones that pass and fails the one that does not", async (t) => {
  const dir = await fixture({ slow: false });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await run(["--all", "--dir", dir, "--timeout", "20000"]);
  assert.equal(r.code, 1, "one harness exited 3, so the runner fails");
  assert.match(r.stdout, /PASS {2}.*verify-ok\.mjs/);
  assert.match(r.stdout, /FAIL {2}.*verify-bad\.mjs {2}\d+\.\ds {2}\(exit 3\)/);
  assert.match(r.stdout, /\| measured 2 things; one was wrong/, "a failing harness's own last lines are echoed");
  assert.match(r.stdout, /1\/2 passed, 1 failed/);
});

test("a selector runs one thing, and an unmatched selector is exit 2, not a pass", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const one = await run(["--only", "verify-ok", "--dir", dir]);
  assert.equal(one.code, 0, "verify-ok passes and nothing else ran");
  assert.match(one.stdout, /1\/1 passed/);
  assert.doesNotMatch(one.stdout, /verify-bad/);

  const none = await run(["--only", "nothing-matches-this", "--dir", dir]);
  assert.equal(none.code, 2, "no harness selected is not a green run");
  assert.match(none.stderr, /no harness matches/);
});

test("a timed-out harness is a TIMEOUT failure, never a pass", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const started = Date.now();
  const r = await run(["--only", "verify-slow", "--dir", dir, "--timeout", "600"]);
  assert.equal(r.code, 1, "the child was killed, so the claim was never measured");
  assert.match(r.stdout, /TIMEOUT {2}.*verify-slow\.mjs/);
  assert.ok(Date.now() - started < 25_000, "the runner killed it instead of waiting for 30s");
});

test("--json is one object a caller can read, with no child output in it", async (t) => {
  const dir = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await run(["--only", "verify-ok", "--dir", dir, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.ran, 1);
  assert.equal(payload.failed, 0);
  assert.equal(payload.results[0].ok, true);
  assert.equal(payload.results[0].timedOut, false);
  assert.equal(typeof payload.results[0].ms, "number");
});
