// The mapping behind `npm run test:changed` and `npm run test:module`, asserted on a tree built for it.
//
// The two rules are the claim. TEXT: a test whose own text names a changed path is in the set - the original rule,
// kept as it was. IMPORTS: a test whose import chain reaches a changed module is in the set even though its text
// never names it - added after the replay of the last ten landings on origin/main found direct importers already
// covered (0 missed, because a direct import spells the path out) and second-order tests missed. This file builds a
// three-deep chain so "second-order" is a fact of the fixture and not of the real repo's layout.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { importGraph, moduleFiles, resolveTarget, selectTests, testFiles } from "../tools/test-select.mjs";

const sweep = (...dirs) => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* a handle on Windows; the OS temp dir is throwaway */
    }
  }
};

// alpha <- beta <- gamma: a change to alpha is named by alpha's own test and reached by beta's and gamma's tests.
const FILES = {
  "package.json": JSON.stringify({ name: "selector-fixture", private: true, type: "module" }, null, 1),
  "lib/alpha.js": 'export const alpha = 1;\n',
  "lib/beta.js": 'import { alpha } from "./alpha.js";\nexport const beta = alpha + 1;\n',
  "lib/gamma.js": 'import { beta } from "./beta.js";\nexport const gamma = beta + 1;\n',
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
  "test/gamma.test.js": [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { gamma } from "../lib/gamma.js";',
    'test("gamma is three", () => assert.equal(gamma, 3));',
    "",
  ].join("\n"),
  "test/plain.test.js": [
    'import test from "node:test";',
    'test("nothing in particular", () => {});',
    "",
  ].join("\n"),
};

function makeTree(files = FILES) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-select-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const filesOf = (picked) => picked.map((p) => p.file).sort();
const pickOf = (picked, file) => picked.find((p) => p.file === file) || null;

test("a test whose text names the changed path is picked by text", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const { picked, byText } = selectTests({ root: dir, changed: ["lib/alpha.js"] });
  const hit = pickOf(picked, "test/alpha.test.js");
  assert.ok(hit, `the module's own test is in the set:\n${filesOf(picked).join("\n")}`);
  assert.equal(hit.how, "text", "its own text names lib/alpha.js");
  assert.equal(hit.because, "lib/alpha.js");
  assert.equal(byText, 1, "one file by name");
});

test("a test that only imports a dependent module is picked by import, one and two hops out", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const { picked } = selectTests({ root: dir, changed: ["lib/alpha.js"] });
  const beta = pickOf(picked, "test/beta.test.js");
  const gamma = pickOf(picked, "test/gamma.test.js");
  assert.ok(beta, "beta's test imports lib/beta.js, which imports the changed lib/alpha.js");
  assert.equal(beta.how, "import", "beta's test never names lib/alpha.js, so only the import rule can find it");
  assert.equal(beta.because, "lib/alpha.js via lib/beta.js");
  assert.ok(gamma, "gamma's test is two modules away from the change");
  assert.equal(gamma.how, "import");
  assert.equal(gamma.because, "lib/alpha.js via lib/gamma.js", "the sentence names the module the test does import");
});

test("a test that neither names nor imports the change stays out of the set", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const { picked } = selectTests({ root: dir, changed: ["lib/alpha.js"] });
  assert.equal(pickOf(picked, "test/plain.test.js"), null, "an unrelated test is not swept in");
});

test("the import rule is additive: the text hits are still there beside it", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const { picked, byText, byImport } = selectTests({ root: dir, changed: ["lib/alpha.js"] });
  assert.equal(picked.length, byText + byImport, "every pick is counted as one rule or the other");
  assert.equal(byText, 1);
  assert.equal(byImport, 2, "beta's test and gamma's test");
});

test("the bare file name is still a text hit, as it was before the import rule", (t) => {
  const dir = makeTree({
    ...FILES,
    "test/leaf-name.test.js": 'import test from "node:test";\n// alpha.js is the stem this test writes\n',
  });
  t.after(() => sweep(dir));
  const { picked } = selectTests({ root: dir, changed: ["lib/alpha.js"] });
  const hit = pickOf(picked, "test/leaf-name.test.js");
  assert.ok(hit, "a test that writes only the bare name still matches");
  assert.equal(hit.how, "text");
  assert.equal(hit.because, "alpha.js");
});

test("a module nothing names and nothing imports answers with an empty set", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const { picked } = selectTests({ root: dir, changed: ["lib/lonely.js"] });
  assert.deepEqual(filesOf(picked), [], "no test reads it: an empty set, which the commands print as a sentence");
});

test("a changed file that is not a module is not followed into the import graph", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const { picked } = selectTests({ root: dir, changed: ["README.md"] });
  assert.deepEqual(filesOf(picked), [], "a markdown file has no importers to walk");
});

test("the graph reads relative imports and skips bare ones", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  const g = importGraph(dir);
  assert.deepEqual(g.imports.get("lib/beta.js"), ["lib/alpha.js"], "the relative specifier resolves to the file");
  assert.equal(g.importers.get("lib/alpha.js").has("lib/beta.js"), true);
  assert.equal(g.imports.get("test/gamma.test.js").includes("lib/gamma.js"), true);
});

test("the walk skips the directories this repo does not import from", (t) => {
  const dir = makeTree({
    ...FILES,
    "node_modules/dep/index.js": "export const dep = 1;\n",
    "data/scratch.js": "export const scratch = 1;\n",
  });
  t.after(() => sweep(dir));
  const mods = moduleFiles(dir);
  assert.equal(mods.some((f) => f.startsWith("node_modules/")), false);
  assert.equal(mods.some((f) => f.startsWith("data/")), false);
  assert.equal(testFiles(dir).length, 4, "the four .test.js files under test/");
});

test("a target resolves by exact path, by unique suffix, and refuses an ambiguous or absent one", (t) => {
  const dir = makeTree();
  t.after(() => sweep(dir));
  assert.deepEqual(resolveTarget(dir, "lib/alpha.js"), { file: "lib/alpha.js" });
  assert.deepEqual(resolveTarget(dir, "alpha.js"), { file: "lib/alpha.js" }, "a bare name resolves when unique");
  const many = resolveTarget(dir, "lib/nope.js");
  assert.match(many.error, /is not a file in this tree/);
  const ambiguous = makeTree({ ...FILES, "other/gamma.js": "export const gamma = 9;\n" });
  try {
    const two = resolveTarget(ambiguous, "gamma.js");
    assert.match(two.error, /names more than one file/);
    assert.deepEqual(two.candidates.sort(), ["lib/gamma.js", "other/gamma.js"]);
  } finally {
    sweep(ambiguous);
  }
});
