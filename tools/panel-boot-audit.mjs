// Rank the panel-booting test files by how exposed they are to the stall row 569 measured.
//
// WHY. A panel is a child process plus three pipes, and a test file's worker only exits once its event loop is
// empty. A test that throws between `startPanel()` and its own `panel.stop()` line strands that child, and the
// worker waits on it forever: every test in the file answers, the file's summary prints, and the run never ends.
// The cure is tools/panel-testkit.mjs `boot()` - one registry per file, swept by one file-level `after()` - so a
// panel-booting file that still calls `startPanel()` directly is the exposure this tool ranks.
//
// WHAT IT COUNTS, per file:
//   boots   every `startPanel(` / `boot(` call site (comments and strings masked out, declarations skipped)
//   hooks   every `t.after(...)` whose body calls `.stop(` - the per-test fast path
//   gap     boots - hooks: the calls a throw could reach before any stop
//   kit     the file imports `boot` from the testkit, which is the only state that cannot strand a child
//
// A file with `gap > 0` and no `kit` is exposed. Sort is worst first: gap, then boots. That is the order the batch
// conversions take, so the first batch fixes the files a throw is most likely to catch.
//
//   node tools/panel-boot-audit.mjs                 # the table
//   node tools/panel-boot-audit.mjs --json          # the same numbers, for a report
//   node tools/panel-boot-audit.mjs --limit 12      # the twelve worst
//   node tools/panel-boot-audit.mjs --fail          # exit 1 while any panel-booting file is not on boot()
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { maskSource } from "./child-process-audit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
// `--root` measures another checkout (a `git archive` of the base, say), so a batch's "before" is the same counting
// rules run on the bytes it started from rather than a remembered number.
const TREE = valueOf("--root", ROOT);
const TEST_DIR = path.join(TREE, "test");

function matchingParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === "(") depth += 1;
    else if (masked[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Call sites only. `import { startPanel }` has no paren, a declaration (`export async function boot(`, `const boot =`)
// binds a name rather than starting a child, and `.boot(` is somebody else's method.
function countCalls(masked, name) {
  const call = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, "g");
  let n = 0;
  for (let m = call.exec(masked); m; m = call.exec(masked)) {
    const before = masked.slice(Math.max(0, m.index - 40), m.index);
    if (/\b(?:function|const|let|var|class)\s+$/.test(before)) continue;
    if (/\bfunction\s*$/.test(before)) continue;
    n += 1;
  }
  return n;
}

// Hooks whose callback stops a panel, by the call's own receiver: `t.after` is a per-test hook; `after(...)` and
// `test.after(...)` are the file-level ones. Only the per-test count enters the ranking - a file-level hook is what
// the kit brings, and a file that already has one is a different (earlier) cure.
function countStopHooks(masked, receiver) {
  const pattern = receiver === "t" ? /(?<![\w.])t\.after\s*\(/g : /(?<![.\w])(?:test\.)?after\s*\(/g;
  let n = 0;
  for (let m = pattern.exec(masked); m; m = pattern.exec(masked)) {
    const open = masked.indexOf("(", m.index);
    const close = matchingParen(masked, open);
    if (close < 0) continue;
    if (/\.stop\s*\(/.test(masked.slice(open, close))) n += 1;
  }
  return n;
}

// A file registers the file-level sweep when an `after(...)` hook's body calls stopBootedPanels(): that is the
// graceful stop at the end of the file. It is not what makes a file safe (boot() unrefs the child, and the kit
// sweeps on beforeExit), so it does not decide the ranking - it is reported so a converted file can be seen whole.
function registersSweep(masked) {
  for (const m of masked.matchAll(/(?<![.\w])(?:test\.)?after\s*\(/g)) {
    const open = masked.indexOf("(", m.index);
    const close = matchingParen(masked, open);
    if (close < 0) continue;
    if (/stopBootedPanels/.test(masked.slice(open, close))) return true;
  }
  return false;
}

const importsBoot = (source) => {
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*panel-testkit\.mjs["']/g)) {
    // `startPanel as boot` is an alias for startPanel, not this kit's boot: only an item whose imported name is
    // `boot` registers a panel in the file-level registry.
    const items = m[1].split(",").map((item) => item.trim()).filter(Boolean);
    if (items.some((item) => /^boot(?:\s+as\s+[\w$]+)?$/.test(item))) return true;
  }
  return false;
};

export function auditFile(file) {
  const rel = path.relative(TREE, file).replace(/\\/g, "/");
  const source = readFileSync(file, "utf8");
  const masked = maskSource(source);
  const kit = importsBoot(source);
  // Only the kit's `boot` is a panel boot. These files are full of local helpers called `boot` (a Jobs fixture, a
  // fake gateway), and counting those would rank a file that never starts a child at the top of the list.
  const starts = countCalls(masked, "startPanel");
  const boots = kit ? countCalls(masked, "boot") : 0;
  if (starts + boots === 0) return null;
  const hooks = countStopHooks(masked, "t");
  const fileHooks = countStopHooks(masked, "after");
  return {
    file: rel,
    starts,
    boots,
    panelBoots: starts + boots,
    hooks,
    fileHooks,
    gap: starts + boots - hooks,
    kit,
    sweep: kit && registersSweep(masked),
  };
}

export function auditPanels(root = TEST_DIR) {
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".test.js"))
    // A dotfile is a proof copy (tools/panel-boot-proof.mjs) or a scratch file: `test/*.test.js` never runs one, so
    // it is not part of the suite's exposure.
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(root, name));
  const rows = [];
  for (const file of files) {
    const row = auditFile(file);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.gap - a.gap || b.panelBoots - a.panelBoots || a.file.localeCompare(b.file));
  const exposed = rows.filter((row) => row.gap > 0 && !row.kit);
  return {
    rows,
    files: rows.length,
    gapFiles: rows.filter((row) => row.gap > 0).length,
    kitFiles: rows.filter((row) => row.kit).length,
    exposed,
    boots: rows.reduce((n, row) => n + row.panelBoots, 0),
    hooks: rows.reduce((n, row) => n + row.hooks, 0),
  };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("panel-boot-audit.mjs")) {
  const report = auditPanels();
  if (has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const tail = report.rows.filter((row) => !row.kit && row.gap <= 0).length;
    console.log(`panel-boot-audit  ${report.files} test files boot a panel (${report.boots} panel boots, ${report.hooks} per-test stop hooks)`);
    console.log(`  ${report.kitFiles} are on boot(): the registry nets every one of their panels`);
    console.log(`  ${report.exposed.length} exposed: not on boot(), and they call startPanel more often than they register a per-test stop hook`);
    console.log(`  ${tail} more are not on boot(), but each registers at least as many per-test hooks as boots (the tail, ranked after these)\n`);
    console.log("  gap  boots  hooks  kit  file");
    const limit = Number(valueOf("--limit", "0")) || report.rows.length;
    for (const row of report.rows.slice(0, limit)) {
      console.log(`  ${String(row.gap).padStart(3)}  ${String(row.panelBoots).padStart(5)}  ${String(row.hooks).padStart(5)}  ${row.kit ? "yes" : " - "}  ${row.file}`);
    }
  }
  if (has("--fail") && report.exposed.length > 0) {
    console.error(`\nFAIL  ${report.exposed.length} exposed panel-booting file(s) not on boot(): ${report.exposed.map((row) => row.file).join(", ")}`);
    process.exit(1);
  }
  if (has("--fail")) console.log(`\nPASS  no panel-booting file is exposed (${report.kitFiles} of ${report.files} on boot(), ${report.exposed.length} with a gap off it)`);
}
