// The question a cut should answer before it makes a second tree: is this task already in hand?
//
// A SPAWN names a job, not a directory. When the project already holds an unfinished tree - its branch still
// carries work main does not have - and that tree's task overlaps the one being spawned, cutting a second tree
// splits one job across two workers, two branches and two cards, and neither card can see the other. Measured on
// this board: two trees for one job, named `convert-built-in-ladder-pipelines-to-pdl-f76189` and
// `convert-all-seven-built-efe600`, read as two unrelated jobs in the one list that shows them.
//
// So the cut asks this module first. The answer is a RECOMMENDATION, and it is deliberately a narrow one:
//
//   * the candidate must be a tree of the same project, on a branch that is not the project's main and that the
//     board does not read as MERGED (the project's own checkout is not a worktree and is never a candidate);
//   * it must be UNFINISHED: commits of its own that main does not have, uncommitted files, or a run standing in
//     it. A tree whose work already landed is not a place to put a second job, it is a tree to sweep;
//   * its task text (its name - which is the task's own words, see lib/tree-slug.js - and the prompts of the runs
//     that stood in it) must share enough of the new task's words. The threshold is a judgement, not a proof, so
//     it is written down here rather than tuned in a caller: at least three shared meaningful words AND at least
//     60% of the smaller task's words (a task of two or three words needs all of them).
//
// A candidate a live run holds is still REPORTED - the panel cuts its tree, because one worker per tree is the
// rule lib/jobs.js enforces, but the card says that reuse was possible and which tree it would have been. An
// overlap that is not reused is not silently ignored.
//
// Everything here is pure: rows and job summaries in, a decision out. Nothing reads git, the store or the clock,
// so the rule is proved by its own test (test/spawn-reuse.test.js) without a repository or a panel.
import { LIVE_JOB_STATUS } from "./jobs.js";
import { jobTreePath } from "./job-trees.js";

export const normTree = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

// Words that say nothing about WHICH job a task is: articles, pronouns, auxiliaries, prepositions and the
// connectives a request is padded with. Everything else counts, including short tokens such as pr, ci and ui,
// which are often the only noun that matters.
const TASK_STOPWORDS = new Set(
  (
    "a an the and or but if then than that this these those there here what which who whom whose why how when where " +
    "is are was were be been being am do does did done doing have has had having " +
    "i me my we us our you your it its they them their he she his her " +
    "of in on at by for from with without into onto over under about across after before between through to too " +
    "not no yes so such very just also only same other another all any some each every both few more most " +
    "should must can could would will shall may might need needs please now again still yet " +
    "todo fixme note"
  ).split(/\s+/),
);

// The words a task is made of, as a set. A trailing plural is folded in ("pipelines" -> "pipeline") because the
// task title and the sentence written about it rarely agree on the number; nothing cleverer is attempted, and a
// word shorter than two characters is dropped.
export function taskWords(text) {
  const out = new Set();
  for (const raw of String(text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || TASK_STOPWORDS.has(raw)) continue;
    const word = raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (word.length < 2) continue;
    out.add(word);
  }
  return out;
}

// How much of one task is in the other. `score` is measured against the SMALLER task, because a short SPAWN
// ("port the flavour roster") and the long brief it echoes are the same job even though the brief has ten words
// the short line never says.
export function taskOverlap(a, b) {
  const left = taskWords(a);
  const right = taskWords(b);
  const shared = [...left].filter((w) => right.has(w)).sort();
  const smaller = Math.min(left.size, right.size);
  return { shared, score: smaller ? shared.length / smaller : 0, left: left.size, right: right.size };
}

// The threshold, in one place: both halves must agree, and a task too short to reach three meaningful words needs
// every one of them instead of quietly matching on a single noun.
export const REUSE_MIN_SHARED = 3;
export const REUSE_MIN_SCORE = 0.6;

function clearsThreshold(overlap) {
  if (!overlap.left || !overlap.right) return false;
  const need = Math.min(REUSE_MIN_SHARED, Math.min(overlap.left, overlap.right));
  return overlap.shared.length >= Math.max(2, need) && overlap.score >= REUSE_MIN_SCORE;
}

// What a tree is about, in words. Its directory name IS the task's readable slug (lib/tree-slug.js) for a tree
// the panel cut, and the runs that stood in it carry the task in full - both are used, so a tree cut before the
// readable name existed still overlaps on the prompt of its own run.
export function treeTask(row = {}, jobs = []) {
  const dir =
    String(row.path || row.name || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .pop() || "";
  const slug = dir.replace(/-[0-9a-f]{6}$/i, "");
  const want = normTree(row.path);
  const prompts = (jobs || [])
    .filter((j) => j && normTree(jobTreePath(j)) === want)
    .map((j) => String(j.prompt || "").trim())
    .filter(Boolean);
  return [row.title, row.task, slug, ...prompts].filter(Boolean).join(". ");
}

// Whether a row is a tree a second job could join, and why not when it is not. Returns null for "not a
// candidate"; an object describing the tree when it is one.
export function unfinishedTree(row = {}, { project = null, mainBranch = "main" } = {}) {
  const branch = String(row.branch || "").trim();
  const at = normTree(row.path);
  if (!at || !branch) return null;
  // The project's own checkout is not a worktree: a run there edits the tree the reader has open, and
  // `existing` on it is a different decision the caller makes explicitly.
  if (normTree(branch) === normTree(mainBranch)) return null;
  if (project?.path) {
    const root = normTree(project.path);
    if (at === root) return null;
    // Only a tree INSIDE the project is this project's business. A comparison tree a lander cut under a scratch
    // directory, or a tree of another project that happens to carry the same words, is not a place to put this job.
    if (!at.startsWith(`${root}/`)) return null;
  }
  if (project?.name && row.project && normTree(row.project) !== normTree(project.name)) return null;
  if (String(row.released || "").trim()) return null;
  const verdict = String(row.verdict || "").toUpperCase();
  // A MERGED verdict is the board saying its work is on main, and NO COMMITS is a branch with nothing of its own:
  // neither is unfinished, and a second job started in either would be a job in a tree nobody is waiting on. The
  // absence of a verdict is not MERGED - a row that has only been through the cheap scan carries none.
  if (verdict.startsWith("MERGED") || verdict === "ON MAIN" || verdict === "NO COMMITS" || verdict === "NO COMMITS?") return null;
  const ahead = Number(row.ahead);
  const commits = Number.isFinite(ahead) ? ahead : 0;
  const dirty = Number(row.dirty || 0) + Number(row.untracked || 0);
  const live = row.live === true;
  if (!(commits > 0 || dirty > 0 || live || verdict.startsWith("UNMERGED"))) return null;
  return { path: row.path, branch, commits, dirty, live };
}

// Every unfinished tree of the project whose task overlaps `task`, best first. `jobs` are job summaries (the
// panel's own list), used for two things: the prompts of the runs that stood in the tree, and whether a live run
// holds it now.
export function reuseCandidates({ task, rows = [], jobs = [], project = null, mainBranch = "main" } = {}) {
  const live = (jobs || []).filter((j) => j && LIVE_JOB_STATUS.has(String(j.status || "")));
  const out = [];
  for (const row of rows || []) {
    const tree = unfinishedTree(row, { project, mainBranch });
    if (!tree) continue;
    const overlap = taskOverlap(task, treeTask(row, jobs));
    if (!clearsThreshold(overlap)) continue;
    const busy = tree.live || live.some((j) => normTree(jobTreePath(j)) === normTree(tree.path));
    out.push({ ...tree, shared: overlap.shared, score: overlap.score, busy });
  }
  // A free tree beats a held one at any score, because the held one cannot be used; then the stronger overlap;
  // then the tree whose branch carries more work, so the oldest surviving attempt wins a tie.
  out.sort((a, b) => Number(a.busy) - Number(b.busy) || b.score - a.score || b.commits - a.commits);
  return out;
}

const listed = (tree) => `${tree.path} (${tree.branch})`;

// What the cut should do, in one place so the spawner and its test read the same sentence:
//
//   { reuse: null, note: "" }                       nothing in the project carries this task
//   { reuse: <tree>, note: "..." }                  run in that tree instead of cutting a second one
//   { reuse: null, note: "...", blocked: <tree> }   a tree carries it, a live run holds it, a tree is cut anyway
export function reuseDecision({ task, rows = [], jobs = [], project = null, mainBranch = "main" } = {}) {
  const [best] = reuseCandidates({ task, rows, jobs, project, mainBranch });
  if (!best) return { reuse: null, note: "", candidates: [] };
  if (best.busy) {
    return {
      reuse: null,
      blocked: best,
      note:
        `a second tree was cut: ${listed(best)} already carries this task (its branch is unmerged${best.commits ? `, ${best.commits} commit${best.commits === 1 ? "" : "s"} ahead` : ""}` +
        `${best.dirty ? `, ${best.dirty} uncommitted file${best.dirty === 1 ? "" : "s"}` : ""}) and reuse was possible, but a run is live in that tree - one worker per tree`,
      candidates: [best],
    };
  }
  const words = best.shared.slice(0, 6).join(", ");
  return {
    reuse: best,
    note: `reused the unfinished tree ${listed(best)} instead of cutting a second one - its branch is unmerged and it already carries this task (${words})`,
    candidates: [best],
  };
}
