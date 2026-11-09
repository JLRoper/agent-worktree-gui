#!/usr/bin/env node
// `npm run test:changed` - the bounded validation an agent should run before a push.
//
// WHY THIS EXISTS. The most expensive thing a turn does on this machine is spawn a process: every test file is one
// `node` process, and the full suite is 226 of them. Measured on the panel's own logs, tool calls that ran a
// repo-wide command sat at the 300s terminal timeout and were retried - the five slowest terminal errors were 403s,
// 309s, 307s, 306s and 305s. A landing turn does not need 226 processes to answer "did I break what I touched"; it
// needs the files that NAME or IMPORT what changed.
//
// HOW THE SET IS CHOSEN. These tests are file-readers: a test slices the file it is about by its relative path
// (`public/app.js`, `lib/scheduler.js`) or imports it. So the set is every test whose text mentions a changed path -
// the same mapping the suite already encodes, read out of the tests themselves instead of a hand-kept table that
// would drift. The text match tries the repo-relative path and the bare file name, at least six characters.
//
// ...and every test whose import chain REACHES a changed module, because a test of a module that imports the changed
// one never spells the changed path out. That rule was added on evidence: replayed against the last ten merged
// landings on origin/main, the text rule caught every DIRECT importer (0 missed in all ten - a direct import names
// the path) and missed second-order tests only, `test/pipeline-bench.test.js` for a change to lib/assistant.js and
// `test/agent-cleanup.test.js`, `test/verify-landed.test.js`, `test/worktree-release.test.js` for a change to
// lib/jobs.js. The replay table is docs/reports/focused-testing-replay-2026-11-09.md, and tools/test-select.mjs is
// the one mapping both this command and `test:module` use.
//
// WHAT IT IS NOT. It is not a gate and it does not replace the full suite before a landing: a change to a hub module
// reaches most of the suite by design (the widest here is 114 of 264 test files), and a change to `package.json` or
// `server.js` deserves the whole suite. `--list` prints the set so a turn can say what it ran, and an empty set is a
// sentence, not a silent pass.
//
//   node tools/test-changed.mjs                 # vs origin/main, run what names the diff
//   node tools/test-changed.mjs --list          # print the set, run nothing
//   node tools/test-changed.mjs --base HEAD~3   # a different base
//   node tools/test-changed.mjs --all           # the full suite (the same command as npm test)
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { selectTests } from "./test-select.mjs";

const args = process.argv.slice(2);
const has = (flag) => {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
  if (value) args.splice(i, 2);
  else args.splice(i, 1);
  return value ?? true;
};
const listOnly = has("--list") === true;
const all = has("--all") === true;
const base = has("--base") || "origin/main";
const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const git = (...rest) => {
  try {
    return execFileSync("git", rest, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

if (all) {
  const tests = readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.js")).sort();
  run(tests.map((f) => path.join(root, "test", f)));
  process.exit(0);
}

// The diff a push would carry: committed since the merge base, plus whatever is staged or dirty in the tree. The
// second half matters because a turn usually asks this question BEFORE it commits.
const mergeBase = git("merge-base", base, "HEAD") || base;
const changed = new Set(
  [git("diff", "--name-only", mergeBase), git("diff", "--name-only", "--cached"), git("status", "--porcelain")]
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/^\s*[AMD?]{1,2}\s+/, "").trim())
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/")),
);

if (!changed.size) {
  console.log(`test:changed - no diff against ${base}; nothing to run.`);
  process.exit(0);
}

// The mapping itself lives in tools/test-select.mjs: the text mention, then the import chain. One call, so this
// command and `test:module` cannot disagree about what "the set" means.
const { picked, byText, byImport } = selectTests({ root, changed: [...changed] });

const shown = new Set(changed);
console.log(`test:changed - ${shown.size} changed file${shown.size === 1 ? "" : "s"} against ${base}:`);
for (const p of [...shown].sort().slice(0, 20)) console.log(`  ${p}`);
if (shown.size > 20) console.log(`  ... and ${shown.size - 20} more`);
if (!picked.length) {
  console.log(`test:changed - no test names or imports any of them. That is a sentence, not a pass: run npm test if the change is broad.`);
  process.exit(0);
}
const byImportOnly = byImport;
console.log(
  `test:changed - ${picked.length} test file${picked.length === 1 ? "" : "s"} name or import the diff ` +
    `(${byText} by name, ${byImportOnly} by import):`,
);
for (const { file, how, because } of picked) {
  console.log(`  ${file}  (${how === "import" ? "imports" : "names"} ${because})`);
}

if (listOnly) process.exit(0);
run(picked.map((p) => path.join(root, p.file)));

function run(files) {
  const started = Date.now();
  const res = spawnSync(process.execPath, ["--test", "--test-concurrency=4", ...files], { cwd: root, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`test:changed - ${files.length} file(s), ${seconds}s, exit ${res.status ?? "?"}`);
  process.exit(res.status ?? 1);
}
