// Independent check of the panel's merge verdicts: recomputes the expected verdict straight
// from git (branch reflog + rev-list) and diffs it against what /api/state reports.
//
//   node tools/verify-verdicts.mjs              # first project, panel on 127.0.0.1:7331
//   node tools/verify-verdicts.mjs heroes-js    # a named project
//   PANEL=http://127.0.0.1:9000 node tools/verify-verdicts.mjs
//
// Exit code 1 if any row disagrees, so it can be used as a regression check.
import { execFileSync } from "node:child_process";

const API = process.env.PANEL || "http://127.0.0.1:7331";

const git = (cwd, args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n").trim();
  } catch {
    return "";
  }
};

const state = await fetch(`${API}/api/state`).then((r) => r.json());
const wanted = process.argv[2];
const project = wanted ? state.projects.find((p) => p.name === wanted) : state.projects[0];
if (!project) {
  console.error(`no such project: ${wanted ?? "(first)"} — have: ${state.projects.map((p) => p.name).join(", ")}`);
  process.exit(2);
}
const base = project.remote ? `${project.remote}/${project.mainBranch}` : project.mainBranch;
console.log(`project ${project.name}  (${project.path})\ncomparing against ${base}\n`);

const porcelain = git(project.path, ["worktree", "list", "--porcelain"]);
const entries = [];
let cur = null;
for (const line of porcelain.split("\n")) {
  if (line.startsWith("worktree ")) cur = { dir: line.slice(9), branch: null };
  else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "");
  else if (line === "" && cur) {
    entries.push(cur);
    cur = null;
  }
}
if (cur) entries.push(cur);

const rows = new Map((project.worktrees || []).map((w) => [w.name, w]));
let bad = 0;
console.log("worktree".padEnd(34), "ahead".padStart(5), "own".padStart(4), "expected".padEnd(20), "panel verdict");
for (const e of entries) {
  const name = e.dir.split(/[\\/]/).pop();
  const [behind, ahead] = git(e.dir, ["rev-list", "--left-right", "--count", `${base}...HEAD`])
    .split(/\s+/)
    .map((n) => Number.parseInt(n, 10));
  const reflog = git(e.dir, ["reflog", "show", "--format=%H %gs", e.branch || "HEAD"]).split("\n").filter(Boolean);
  const own = new Set();
  for (const l of reflog) {
    const sp = l.indexOf(" ");
    const subject = sp < 0 ? "" : l.slice(sp + 1);
    if (/^commit( \(amend\))?:/.test(subject)) own.add(l.slice(0, sp));
  }
  let expect;
  if (ahead === 0) expect = own.size > 0 ? `MERGED (${own.size} commit${own.size === 1 ? "" : "s"})` : "NO COMMITS";
  else expect = "UNMERGED";

  const row = rows.get(name);
  const got = row ? String(row.verdict) : "(row missing)";
  const want = e.branch === project.mainBranch ? "ON MAIN" : expect;
  const ok = got === want || (expect === "UNMERGED" && got.startsWith("UNMERGED")) || (expect === "MERGED" && got.startsWith("MERGED"));
  if (!ok) bad += 1;
  console.log(name.padEnd(34), String(ahead).padStart(5), String(own.size).padStart(4), want.padEnd(20), got.padEnd(24), ok ? "" : "  <== MISMATCH");
}
console.log(`\nmismatches: ${bad} | rows checked: ${entries.length}`);
console.log("panel summary:", JSON.stringify(project.summary));
process.exit(bad ? 1 : 0);
