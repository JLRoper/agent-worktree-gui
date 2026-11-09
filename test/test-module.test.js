// `npm run test:module <path>` - one file's tests, run without the suite.
//
// The command is the answer to "I changed one cut, which tests read it?" and it must be right in both directions:
// a hit runs the tests that name or import the file (and nothing else), and a miss says so as a sentence rather
// than a silent pass. Both are asserted here against a fixture tree, so the claim is the command's behaviour and
// not this repo's current layout. One smoke case runs it against this repo's own lib/jobs.js.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const HERE = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const COMMAND = path.join(HERE, "tools", "test-module.mjs");

const sweep = (...dirs) => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* a handle on Windows; the OS temp dir is throwaway */
    }
  }
};

const FILES = {
  "package.json": JSON.stringify({ name: "module-fixture", private: true, type: "module" }, null, 1),
  "lib/alpha.js": "export const alpha = 1;\n",
  "lib/beta.js": 'import { alpha } from "./alpha.js";\nexport const beta = alpha + 1;\n',
  "lib/lonely.js": "export const lonely = true;\n",
  "test/alpha.test.js": [
    "// lib/alpha.js - the module's own test.",
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { alpha } from "../lib/alpha.js";',
    'test("alpha is one", () => assert.equal(alpha, 1));',
    "",
  ].join("\n"),
  "test/beta.test.js": [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { beta } from "../lib/beta.js";',
    'test("beta is two", () => assert.equal(beta, 2));',
    "",
  ].join("\n"),
  "test/plain.test.js": 'import test from "node:test";\ntest("nothing in particular", () => {});\n',
};

function makeTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-module-"));
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

// NODE_TEST_CONTEXT is dropped on purpose: this test runs INSIDE `node --test`, and a `node --test` grandchild that
// inherits that variable believes it is a runner's child and keeps its reporter output to itself. The command's own
// behaviour is unchanged; only this harness's environment is cleaned, so what the command prints can be read here.
const run = (args) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [COMMAND, ...args], { encoding: "utf8", timeout: 120_000, windowsHide: true, env });
};

test("a hit runs the module's own test and the tests that import a dependent of it", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const r = run(["lib/alpha.js", "--root", dir]);
  assert.equal(r.status, 0, `the command exits with its run's status:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /test:module - lib\/alpha\.js: 2 test files name or import it\./, "the set is named before it runs");
  assert.match(r.stdout, /test\/alpha\.test\.js {2}\(names lib\/alpha\.js\)/, "the module's own test, by name");
  assert.match(r.stdout, /test\/beta\.test\.js {2}\(imports lib\/alpha\.js via lib\/beta\.js\)/, "beta's test, by import");
  assert.match(r.stdout, /alpha is one/, "the test really ran, not just printed");
  assert.match(r.stdout, /2 file\(s\), .*exit 0/);
});

test("--list prints the set and runs nothing", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const r = run(["lib/alpha.js", "--root", dir, "--list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 test files name or import it/);
  assert.doesNotMatch(r.stdout, /file\(s\), .*exit/, "no run line: the set was printed, nothing was started");
  assert.doesNotMatch(r.stdout, /alpha is one/, "the test's own output is absent");
});

test("a miss is a sentence and an exit 0, not a silent pass", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const r = run(["lib/lonely.js", "--root", dir, "--list"]);
  assert.equal(r.status, 0, "an empty set is not a failure of the command");
  assert.match(r.stdout, /test:module - lib\/lonely\.js: 0 test files name or import it\./);
  assert.match(r.stdout, /nothing in test\/ names or imports it\. That is a finding, not a pass/);
});

test("a test named is the set, and nothing else runs", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const r = run(["test/beta.test.js", "--root", dir, "--list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /test:module - test\/beta\.test\.js: 1 test file name or import it\./);
  assert.match(r.stdout, /test\/beta\.test\.js {2}\(named itself\)/);
});

test("a path this tree does not have is refused with the reason, not guessed", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const r = run(["lib/nowhere.js", "--root", dir]);
  assert.equal(r.status, 2, "the command cannot answer a question about a file it cannot find");
  assert.match(r.stderr, /lib\/nowhere\.js is not a file in this tree/);
});

test("against this repo it answers for a real module", (t) => {
  const r = run(["lib/jobs.js", "--list"]);
  assert.equal(r.status, 0, r.stderr);
  const count = Number((r.stdout.match(/test:module - lib\/jobs\.js: (\d+) test files?/) || [])[1]);
  assert.ok(count > 20, `lib/jobs.js is a hub, so its set is large (measured ${count}):\n${r.stdout.slice(0, 600)}`);
  assert.match(r.stdout, /test\/brief-follows-the-policy\.test\.js {2}\(names lib\/jobs\.js\)/, "the brief tests read jobs.js");
});
