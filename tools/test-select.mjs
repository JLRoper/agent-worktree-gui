// Which test files a changed path touches: the mapping `npm run test:changed` and `npm run test:module` both use.
//
// WHY IT IS ONE MODULE. Two commands answer the same question - "which tests does this file's change reach?" - and a
// second copy of the rule would drift from the first the moment one of them was edited. The selector is the answer;
// the two commands are how a turn asks it about a diff or about one file.
//
// THE TWO RULES, in the order they are applied.
//
//   1. TEXT. A test is in the set when its own text names a changed path: the repo-relative path (`lib/jobs.js`) or
//      its bare file name (`jobs.js`), at least six characters so a two-letter stem cannot match half the suite. This
//      is the original rule and it is kept as it was, because it is what every file-reader test already encodes: a
//      test that slices a file by its path, or imports it, names it.
//
//   2. IMPORTS. A test is also in the set when its import chain reaches a changed module, even though the test's own
//      text never names it: a test of a module that imports the changed one. This was added on evidence, not for
//      symmetry. The replay of the last ten merged landings on origin/main (`npm run test:changed --list` against
//      each landing's own tree, docs/reports/focused-testing-replay-2026-11-09.md) found the text rule caught every
//      DIRECT importer already - 0 missed in all ten, because a direct import spells the path out. What it missed was
//      second-order: `test/pipeline-bench.test.js` reaches lib/assistant.js through tools/bench-pipeline.mjs and is
//      named by neither; `test/agent-cleanup.test.js`, `test/verify-landed.test.js` and
//      `test/worktree-release.test.js` reach lib/jobs.js through lib/worktrees.js. Those are tests of the changed
//      module's dependents, and a change to the module can move them.
//
//      The cost is bounded by the import graph, not by the rule: on this tree the widest-reaching module
//      (lib/tree-names.js, tools/panel-testkit.mjs) reaches 114 of the 264 test files, and following imports added
//      0 to 52 files to the ten replayed sets. A change to a hub is genuinely broad, and the full suite is the honest
//      answer for one; a change to a leaf stays small.
//
// NOT A GATE. Neither rule decides whether a change is safe. The full suite is still the last sweep before a pull
// request (lib/jobs.js's TESTING paragraph says so to every worker), and this module's job is to make the set a
// worker runs while it works small enough to be run again and again.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Directories that hold no source this repo imports: the panel's own data, its logs, dependencies and worktrees.
const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "data", "logs", "coverage", "tmp"]);
const MODULE_FILE = /\.(?:js|mjs|cjs)$/i;
const TEST_FILE = /^test\/(?:.+\.)?test\.js$/;
// An import statement's specifier: `from "..."`, `require("...")`, `import("...")`. Only RELATIVE specifiers are
// followed; a bare specifier is a package, and this repo has no runtime dependencies to follow into.
const SPECIFIER = /(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g;

export const posix = (p) => String(p).replace(/\\/g, "/");

// Every module file in the tree, repo-relative and sorted. One walk, so the text and import rules read the same list.
export function moduleFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && MODULE_FILE.test(entry.name)) {
        found.push(posix(path.relative(root, path.join(dir, entry.name))));
      }
    }
  };
  walk(root);
  return found.sort();
}

// The test files this repo's suite runs: `test/*.test.js`, the same set package.json's `test` script globs.
export function testFiles(root) {
  return moduleFiles(root).filter((f) => TEST_FILE.test(f));
}

// The relative specifiers one file's text imports, resolved against the tree and kept only when the target exists.
// A specifier that resolves outside the tree, or to a file this walk does not know, is dropped: the rule is about
// files a change can move, and a path that does not resolve cannot be moved by it.
export function importsOf(root, file, text = null) {
  const abs = path.join(root, file);
  let body = text;
  if (body === null) {
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      return [];
    }
  }
  const out = new Set();
  SPECIFIER.lastIndex = 0;
  let match;
  while ((match = SPECIFIER.exec(body)) !== null) {
    const spec = match[1];
    if (!spec.startsWith(".")) continue;
    const target = path.resolve(path.dirname(abs), spec);
    let isFile = false;
    try {
      isFile = statSync(target).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    const rel = posix(path.relative(root, target));
    if (rel.startsWith("..")) continue;
    out.add(rel);
  }
  return [...out];
}

// The import graph, both ways round: `imports` for what a module loads, `importers` for who loads it. Built from one
// read of every module in the tree, which is a few megabytes and well under the cost of starting one test process.
export function importGraph(root, modules = moduleFiles(root)) {
  const imports = new Map();
  const importers = new Map();
  for (const file of modules) {
    const list = importsOf(root, file);
    imports.set(file, list);
    for (const dep of list) {
      if (!importers.has(dep)) importers.set(dep, new Set());
      importers.get(dep).add(file);
    }
  }
  return { modules, imports, importers };
}

// The changed paths as a name set: the path and its bare file name. Six characters is the floor, and it is the
// original rule's, so a change to a file called `a.js` cannot pull in half the suite by its stem.
export function nameSet(changed) {
  const names = new Set();
  for (const p of changed) {
    const rel = posix(p);
    if (!rel) continue;
    names.add(rel);
    const leaf = path.posix.basename(rel);
    if (leaf) names.add(leaf);
  }
  return names;
}

// The set itself. `changed` is the diff's file list (committed, staged or dirty - the caller decides). Answers
// `{ picked, byText, byImport }`: each pick is `{ file, how, because }`, where `how` is "text" or "import" and
// `because` is the name the text matched or the changed module the import chain reaches.
export function selectTests({ root, changed = [], graph = null }) {
  const files = testFiles(root);
  const names = nameSet(changed);
  const picked = [];
  const seen = new Set();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.length < 6) continue;
      if (text.includes(name)) {
        picked.push({ file, how: "text", because: name });
        seen.add(file);
        break;
      }
    }
  }
  const byText = picked.length;

  // The changed files that are modules in this tree. A changed test file is followed too: a module cannot import a
  // test, so it costs one lookup and cannot change the answer.
  const changedModules = changed.map(posix).filter((p) => MODULE_FILE.test(p) && !p.startsWith(".."));
  let byImport = 0;
  if (changedModules.length) {
    const g = graph || importGraph(root);
    const known = new Set(g.modules);
    for (const module of changedModules) {
      if (!known.has(module)) continue;
      const parent = new Map([[module, null]]);
      const queue = [module];
      while (queue.length) {
        const current = queue.shift();
        for (const up of g.importers.get(current) || []) {
          if (parent.has(up)) continue;
          parent.set(up, current);
          if (TEST_FILE.test(up)) {
            if (!seen.has(up)) {
              const chain = [up];
              for (let at = parent.get(up); at; at = parent.get(at)) chain.push(at);
              picked.push({ file: up, how: "import", because: chain.length > 2 ? `${module} via ${chain[1]}` : module });
              seen.add(up);
              byImport += 1;
            }
            continue; // a test is a leaf: nothing imports a test, so there is nothing above it to walk
          }
          queue.push(up);
        }
      }
    }
  }
  return { picked, byText, byImport };
}

// One path a reader named, resolved to the file in this tree. An exact repo-relative path wins; failing that, a unique
// suffix (`lib/jobs.js`, `jobs.js`) is accepted, and more than one match is an answer this cannot give rather than a
// guess between two modules. Answers `{ file }` or `{ error, candidates }`.
export function resolveTarget(root, arg) {
  const raw = String(arg ?? "").trim().replace(/^\.\//, "");
  if (!raw) return { error: "no path given", candidates: [] };
  const wanted = posix(path.isAbsolute(raw) ? path.relative(root, raw) : raw);
  const modules = moduleFiles(root);
  if (modules.includes(wanted)) return { file: wanted };
  const suffix = modules.filter((f) => f === wanted || f.endsWith(`/${wanted}`) || path.posix.basename(f) === wanted);
  if (suffix.length === 1) return { file: suffix[0] };
  if (suffix.length > 1) return { error: `${wanted} names more than one file`, candidates: suffix };
  return { error: `${wanted} is not a file in this tree`, candidates: [] };
}
