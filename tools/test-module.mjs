#!/usr/bin/env node
// `npm run test:module <path>` - the tests that name or import ONE file, so a cut can be checked without the suite.
//
// WHY. `test:changed` answers "what did this whole diff touch", and for a broad diff the honest answer is most of
// the suite. A worker checking one cut - a helper it just wrote, a branch it just moved - wants the opposite: the
// few tests that read THAT file. Naming the file is the cheapest possible brief, and the selector already knows how
// to follow it: this command is the same mapping as `test:changed` with a one-file change set.
//
// A TEST FILE NAMED IS THE SET. `npm run test:module test/jobs.test.js` runs that test and nothing else: a reader who
// names a test has already said which one they mean, and the import rule has nothing to add (nothing imports a test).
//
// AN EMPTY SET IS A SENTENCE. A file no test names or imports answers so, and exits 0: a module with no test is a
// finding to say out loud, not a silent pass and not a failure of the command.
//
//   npm run test:module lib/jobs.js            # run what names or imports lib/jobs.js
//   npm run test:module lib/jobs.js --list     # print the set, run nothing
//   npm run test:module jobs.js --list         # a bare name resolves when it is unique in the tree
//   npm run test:module lib/jobs.js --root <another checkout>   # another tree (the tests use this)
//
// Exit codes: the run's own status; 2 for a path this tree does not have (or one that names more than one file); 0
// for a set that is empty.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveTarget, selectTests } from "./test-select.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
  if (value) args.splice(i, 2);
  else args.splice(i, 1);
  return value ?? true;
};

const listOnly = flag("--list") === true;
const rootArg = flag("--root");
const here = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = typeof rootArg === "string" && rootArg ? path.resolve(rootArg) : here;
const target = args.find((a) => !a.startsWith("--"));

if (!target) {
  console.error("test:module - name one file or module: npm run test:module <path> [--list] [--root <dir>]");
  process.exit(2);
}

const resolved = resolveTarget(root, target);
if (resolved.error) {
  console.error(`test:module - ${resolved.error}.`);
  for (const c of resolved.candidates || []) console.error(`  ${c}`);
  if (!(resolved.candidates || []).length) console.error("  give a path this tree has, relative to its root, or a bare file name that is unique in it.");
  process.exit(2);
}

// A test named is the set: nothing imports a test, and the reader has already chosen.
const set = /^test\/(?:.+\.)?test\.js$/.test(resolved.file)
  ? [{ file: resolved.file, how: "named", because: "itself" }]
  : selectTests({ root, changed: [resolved.file] }).picked;

console.log(`test:module - ${resolved.file}: ${set.length} test file${set.length === 1 ? "" : "s"} name or import it.`);
for (const { file, how, because } of set) {
  console.log(`  ${file}  (${how === "named" ? "named" : how === "import" ? "imports" : "names"} ${because})`);
}
if (!set.length) {
  console.log("test:module - nothing in test/ names or imports it. That is a finding, not a pass: say so in the report.");
  process.exit(0);
}
if (listOnly) process.exit(0);

const started = Date.now();
const res = spawnSync(process.execPath, ["--test", "--test-concurrency=4", ...set.map((s) => path.join(root, s.file))], {
  cwd: root,
  stdio: "inherit",
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`test:module - ${set.length} file(s), ${seconds}s, exit ${res.status ?? "?"}`);
process.exit(res.status ?? 1);
