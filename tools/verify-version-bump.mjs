// Fails unless package.json's version moved the way docs/claude-phase2-handoff.md says it must.
//
//   node tools/verify-version-bump.mjs [--base <git ref>]      (default: origin/main)
//
// The handoff declares `Status: in progress` and a `Version line: 0.2.x`. While in progress, the version must
// be strictly higher than the base's AND stay on that line, so only the patch number moves. Otherwise it only
// has to go up.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argAt = process.argv.indexOf("--base");
const base = argAt > -1 ? process.argv[argAt + 1] : "origin/main";

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const fail = (msg) => {
  console.error(`version check FAILED: ${msg}`);
  process.exit(1);
};

const current = parse(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
if (!current) fail("package.json has no x.y.z version");

let baseVersion;
try {
  const text = execFileSync("git", ["show", `${base}:package.json`], { cwd: root, encoding: "utf8" });
  baseVersion = parse(JSON.parse(text).version);
} catch (e) {
  fail(`cannot read package.json at ${base} (${String((e && e.message) || e).split("\n")[0]})`);
}
if (!baseVersion) fail(`${base} has no x.y.z version`);

const handoff = readFileSync(path.join(root, "docs", "claude-phase2-handoff.md"), "utf8");
const inProgress = /^Status:\s*in progress\s*$/im.test(handoff);
const line = /^Version line:\s*(\d+)\.(\d+)\.x\s*$/im.exec(handoff);

console.log(`base ${base}: ${baseVersion.join(".")} -> now ${current.join(".")} · plan ${inProgress ? "in progress" : "not in progress"}`);

if (cmp(current, baseVersion) <= 0) fail(`version must go up from ${baseVersion.join(".")} — bump the patch number in package.json`);
if (inProgress) {
  if (!line) fail("handoff says in progress but has no `Version line: x.y.x`");
  const want = [Number(line[1]), Number(line[2])];
  if (current[0] !== want[0] || current[1] !== want[1]) {
    fail(`while the Claude plan is in progress the version stays on ${want.join(".")}.x (only the third number moves); got ${current.join(".")}`);
  }
}
console.log("version check ok");
