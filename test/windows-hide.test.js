// A console child started without windowsHide is a cmd window that flashes over whatever the reader is
// typing into. The panel runs without a console of its own, so EVERY spawn/exec site has to pass it — not
// only the one that happened to flash on one machine, because which site fires depends on which poll is due
// or which turn just ended.
//
// The scan is honest about its own coverage: it asserts the inventory it found, so a scanner that quietly
// stops matching (a renamed alias, a new wrapper) fails here instead of passing an empty list.
import assert from "node:assert/strict";
import test from "node:test";
import { auditChildProcess, auditSource } from "../tools/child-process-audit.mjs";

test("every child_process call in server.js and lib/** passes windowsHide: true", () => {
  const { files, calls, violations } = auditChildProcess();
  assert.ok(files.length >= 20, `the audit only opened ${files.length} files — the walk has stopped finding server.js + lib/**`);
  assert.ok(calls.length >= 25, `the audit only found ${calls.length} child_process calls — it is no longer matching the real sites`);
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.callee} ${v.snippet}`),
    [],
    "a child started without windowsHide flashes a console window and takes the reader's focus",
  );
});

test("the audit flags the shapes that caused the flashes", () => {
  const cases = [
    [`spawn(bin, args, { detached: true, stdio: "ignore" });`, "detached with no windowsHide"],
    [`execFile("git", ["status"], { timeout: 1000 });`, "options without windowsHide"],
    [`exec("git", ["status"]);`, "no options at all"],
    [`execSync("git status");`, "sync form with no options"],
    [`spawnSync("git", ["status"], { timeout: 5 });`, "spawnSync with options but no windowsHide"],
  ];
  for (const [code, why] of cases) {
    const calls = auditSource(code, "fixture.js");
    assert.equal(calls.length, 1, `the audit did not see the call at all: ${code}`);
    assert.equal(calls[0].windowsHide, false, `missed windowsHide on ${why}: ${code}`);
  }
});

test("the audit follows the promisified aliases the modules actually use", () => {
  const aliased = `import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);
export async function read(dir, exec = pexec) {
  await pexec("git", ["-C", dir, "status"], { timeout: 1 });
  await exec("git", ["-C", dir, "log"], { timeout: 1 });
}`;
  const calls = auditSource(aliased, "fixture.js");
  assert.equal(calls.length, 2, `expected pexec and its parameter alias to be followed: ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.map((c) => c.windowsHide), [false, false]);
});

test("the audit does not mistake a fixed call, a method or a string for a violation", () => {
  const clean = `// spawn(bin, args, { detached: true }) in a comment
const note = "execFile(x, y, { timeout: 1 }) in a string";
class Pool { spawn() { return 1; } }
this.spawn();
const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
execFile("git", ["-C", dir, "status"], { timeout: 20_000, windowsHide: true });`;
  const calls = auditSource(clean, "fixture.js");
  assert.equal(calls.length, 2, `only the real calls count: ${JSON.stringify(calls.map((c) => `${c.callee}:${c.line}`))}`);
  assert.deepEqual(calls.map((c) => c.windowsHide), [true, true]);
});

test("both detached spawns in server.js carry windowsHide", () => {
  const { calls } = auditChildProcess();
  const detached = calls.filter((c) => c.detached);
  assert.ok(detached.length >= 1, "no detached spawn found — the audit has stopped seeing server.js");
  for (const c of detached) assert.equal(c.windowsHide, true, `${c.file}:${c.line} is detached with no windowsHide`);
});
