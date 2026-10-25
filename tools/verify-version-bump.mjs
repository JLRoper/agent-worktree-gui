// Checks that package.json's version moved the way docs/claude-phase2-handoff.md says it must: only when code changed.
//
//   node tools/verify-version-bump.mjs [--base <git ref>]      (default: origin/main)
//
// "Code" is server.js, lib/ and public/. Docs, tools and READMEs are not code.
//   - code changed  -> the version must be strictly higher than the base's, and (while the handoff says
//                      `Status: in progress`) stay on its `Version line: x.y.x`, so only the patch number moves
//   - no code change -> the version must be exactly the base's: a docs-only or handoff-only PR does not bump
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argAt = process.argv.indexOf("--base");
const base = argAt > -1 ? process.argv[argAt + 1] : "origin/main";
const CODE = /^(server\.js|lib\/|public\/)/;

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
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
let changed;
try {
  baseVersion = parse(JSON.parse(git("show", `${base}:package.json`)).version);
  // Against the merge-base, so commits that landed on the base after this branch left it do not count as ours.
  // `git diff <commit>` also covers uncommitted edits to tracked files.
  changed = git("diff", "--name-only", git("merge-base", base, "HEAD").trim()).split(/\r?\n/).filter(Boolean);
} catch (e) {
  fail(`cannot compare against ${base} (${String((e && e.message) || e).split("\n")[0]})`);
}
if (!baseVersion) fail(`${base} has no x.y.z version`);

const codeChanged = changed.filter((f) => CODE.test(f));
const handoff = readFileSync(path.join(root, "docs", "claude-phase2-handoff.md"), "utf8");
const inProgress = /^Status:\s*in progress\s*$/im.test(handoff);
const line = /^Version line:\s*(\d+)\.(\d+)\.x\s*$/im.exec(handoff);

console.log(
  `base ${base}: ${baseVersion.join(".")} -> now ${current.join(".")} · ${codeChanged.length ? `code changed (${codeChanged.length} file${codeChanged.length === 1 ? "" : "s"})` : "no code change"} · plan ${inProgress ? "in progress" : "not in progress"}`,
);

if (!codeChanged.length) {
  if (cmp(current, baseVersion) !== 0) fail(`no code changed (only docs/tools/etc.), so the version must stay ${baseVersion.join(".")}; got ${current.join(".")}`);
  console.log("version check ok");
  process.exit(0);
}

if (cmp(current, baseVersion) <= 0) fail(`code changed (${codeChanged.slice(0, 3).join(", ")}${codeChanged.length > 3 ? ", …" : ""}) so the version must go up from ${baseVersion.join(".")} — bump the patch number in package.json`);
if (inProgress) {
  if (!line) fail("handoff says in progress but has no `Version line: x.y.x`");
  const want = [Number(line[1]), Number(line[2])];
  if (current[0] !== want[0] || current[1] !== want[1]) {
    fail(`while the Claude plan is in progress the version stays on ${want.join(".")}.x (only the third number moves); got ${current.join(".")}`);
  }
}
console.log("version check ok");
