// A deliverable belongs to the turn that wrote it. The end-of-turn sweep used to adopt every
// untracked file in the run's directory, so a run started in a project ROOT (shared with every other
// agent) collected stray files that another row's agent had left there weeks earlier.
//
//   node tools/verify-artifact-scope.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Jobs } from "../lib/jobs.js";

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(got)}`);
};

const reg = new Jobs({ jobsFile: null });
const artifactsOf = async (cwd, startedAt) => {
  const j = { id: "sweep1", thread: "sweep", turn: 1, status: "done", cwd, startedAt, artifacts: [], lines: [] };
  await reg.sweepArtifacts(j);
  return (j.artifacts || []).map((a) => path.basename(a.path)).sort();
};

const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

// ---- a scratch repo: one old file, one written during the turn, one directory --------------------
const dir = mkdtempSync(path.join(tmpdir(), "artifact-scope-"));
try {
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
  writeFileSync(path.join(dir, "OLD_HANDOFF.md"), "# left by someone else\n");
  utimesSync(path.join(dir, "OLD_HANDOFF.md"), dayAgo, dayAgo);
  writeFileSync(path.join(dir, "NEW_REPORT.md"), "# written by this turn\n");
  mkdirSync(path.join(dir, "plans"));
  writeFileSync(path.join(dir, "plans", "plan.md"), "# inside an untracked directory\n");

  const startedAt = new Date(Date.now()).toISOString();
  check(
    "the turn's own files are adopted, including one inside a new folder",
    await artifactsOf(dir, startedAt),
    ["NEW_REPORT.md", "plan.md"],
  );

  // A turn that started BEFORE the old file was created (i.e. the old file is inside the window)
  // must still see it — the rule is time, not name.
  check(
    "a file inside the turn's window is adopted",
    await artifactsOf(dir, new Date(dayAgo.getTime() - 60_000).toISOString()),
    ["NEW_REPORT.md", "OLD_HANDOFF.md", "plan.md"],
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---- the reported case: a real project root with another agent's leftovers ----------------------
const realRoot = "C:/ProjectDevelopment/email-multi";
const leftover = await artifactsOf(realRoot, new Date().toISOString()).catch(() => null);
if (leftover === null) {
  console.log("SKIP  the real project root is not available here");
} else {
  check("a fresh turn in the shared project root adopts nothing", leftover, []);
}

console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
