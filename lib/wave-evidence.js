// THE EVIDENCE A WAVE GATE READS: two live facts, and no word.
//
//   1. THE PULL REQUEST READS MERGED THROUGH THE HOST'S API. A task row's `pr.state` is a scan's copy of an answer
//      that was true at some earlier moment, and a row that says `done` says nothing at all about the pull request.
//      So the gate asks the API again, for the PR number the member recorded, and an API that cannot answer is
//      `unknown`, never a pass.
//
//   2. THE MEMBER'S CONTENT IS ON THE MAIN BRANCH, JUDGED BY CONTENT. This repo lands by squash, which REWRITES the
//      sha: the commit a member recorded is not an ancestor of main and never will be, so ancestry - and an
//      "ahead by N" count - is not evidence of a landing here. The read takes the files the member's change touched
//      (the diff from the merge base to the recorded sha) and asks whether origin/main's copy of those same files
//      is the member's copy. Equal content is the landing; a commit that is merely reachable is not, and a sha
//      that is merely absent from main is not a refusal either.
//
// BOTH READS ANSWER `unknown` WHEN THEY CANNOT BE MADE: the API is down, the member records no pull request, the sha
// is not in the clone, git throws. `unknown` blocks the gate (lib/waves.js). A read that failed never becomes a pass.
//
// WHERE THE SHA COMES FROM. The pull request's own head (`headRefOid`) is the sharpest record: it is the head the
// host merged, and the API read returns it in the same answer as the state. A member whose PR read failed or gave no
// head falls back to the sha its own pipeline run recorded - the round's assembly commit, else the newest settled
// stage run's commit (`lib/task-pipeline.js` `settleStageRun`) - which is a fact the run wrote, not a status word.
import { gitIn } from "./scan.js";
import { waveMemberKey } from "./waves.js";

// The three answers a landing read can give. `landed` is content equality, `not-landed` is a content difference,
// and `unknown` is the reader's blindness. They are kept apart for the same reason the gate keeps met and cannot-tell
// apart: "the work is not there" and "the panel cannot see it" are different facts.
export const LANDING_STATES = Object.freeze(["landed", "not-landed", "unknown"]);

const text = (value) => String(value ?? "").trim();

/**
 * The sha a member's own run recorded, or null. The assembly commit first: it is the head of the branch a round
 * lands, so its content is exactly what a squash merge would have rewritten. Otherwise the newest settled stage
 * run's commit. A run that settled without a commit contributes nothing (the settle deletes a missing one rather
 * than writing a guess, lib/task-pipeline.js).
 */
export function recordedShaOf(task) {
  const run = task && typeof task === "object" ? task.pipelineRun : null;
  if (!run || typeof run !== "object") return null;
  const assembled = text(run.assembly && run.assembly.commit);
  if (assembled) return assembled;
  const settled = (Array.isArray(run.stageRuns) ? run.stageRuns : [])
    .filter((entry) => entry && typeof entry === "object" && text(entry.commit) && text(entry.status) === "done")
    .sort((a, b) => text(b.settledAt || b.at).localeCompare(text(a.settledAt || a.at)));
  return settled.length ? text(settled[0].commit) : null;
}

/**
 * One pull request by number, out of the index the board's PR cell already reads. The index keeps every PR's own
 * record (state, mergedAt, headRefOid); it is grouped by head ref, so a number lookup walks the groups. A number
 * that appears under two refs (a re-land) answers the newest, the same rule `prFor` applies.
 */
export function prByNumber(index, number) {
  const wanted = Number(number);
  if (!Number.isFinite(wanted) || wanted <= 0) return null;
  const groups = [];
  if (index && typeof index === "object") {
    if (index.byRef instanceof Map) groups.push(...index.byRef.values());
    else if (index instanceof Map) groups.push(...index.values());
  }
  for (const list of groups) {
    for (const pr of Array.isArray(list) ? list : []) {
      // A PR number is unique in a repository, so the first record that carries it IS the record.
      if (Number(pr?.number) === wanted) return pr;
    }
  }
  return null;
}

const landing = (state, why, extra = {}) => ({
  state,
  why,
  sha: null,
  main: null,
  mainSha: null,
  base: null,
  paths: [],
  ancestor: null,
  at: new Date().toISOString(),
  ...extra,
});

/**
 * Judge one recorded sha against the main branch BY CONTENT.
 *
 * The steps are all reads of the member's own clone (or its project's checkout): resolve the sha, resolve the main
 * ref, find the merge base, list the files the change touched, and compare those files between the sha and main.
 * The result always answers one of LANDING_STATES and never throws: a git call that throws, exits non-zero or
 * answers nothing is `unknown` with the sentence.
 */
export async function readLanding({ git = gitIn, cwd, sha, mainRef = "origin/main", timeout = 15000 } = {}) {
  const wanted = text(sha);
  const main = text(mainRef) || "origin/main";
  const call = async (args) => {
    if (typeof git !== "function") return { ok: false, err: "no git reader was supplied" };
    try {
      return await git(cwd, args, timeout);
    } catch (error) {
      return { ok: false, err: `git threw: ${text(error && error.message) || String(error)}` };
    }
  };
  if (!text(cwd)) return landing("unknown", "the member records no worktree and no project path, so git cannot be asked about its content", { sha: wanted || null, main });
  if (!wanted) return landing("unknown", "the member records no sha, so there is no content to find on main", { main });

  const commitOf = async (ref) => {
    const r = await call(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (!r || !r.ok) return { sha: null, why: text(r && r.err) || "no output" };
    const out = text(r.out).split("\n")[0];
    return { sha: out || null, why: out ? "" : "no output" };
  };

  const member = await commitOf(wanted);
  if (!member.sha) {
    return landing("unknown", `the recorded sha ${wanted.slice(0, 12)} is not a commit in ${cwd}'s object store (${member.why}), so its content cannot be compared with main`, { sha: wanted, main });
  }
  const target = await commitOf(main);
  if (!target.sha) {
    return landing("unknown", `${main} cannot be read in ${cwd} (${target.why}), so there is no main content to compare against`, { sha: wanted, main });
  }

  const baseRead = await call(["merge-base", member.sha, target.sha]);
  const base = baseRead && baseRead.ok ? text(baseRead.out).split("\n")[0] : "";
  if (!base) {
    return landing("unknown", `git could not find a common base between ${member.sha.slice(0, 7)} and ${main} (${text(baseRead && baseRead.err) || "no output"}), so the touched files cannot be named`, { sha: member.sha, main, mainSha: target.sha });
  }

  const touched = await call(["diff", "--name-only", base, member.sha]);
  if (!touched || !touched.ok) {
    return landing("unknown", `git could not list the files ${member.sha.slice(0, 7)} changed (${text(touched && touched.err) || "no output"})`, { sha: member.sha, main, mainSha: target.sha, base });
  }
  const paths = text(touched.out).split("\n").map((p) => p.trim()).filter(Boolean);
  if (!paths.length) {
    return landing("unknown", `the recorded sha changes no files against its own base, so there is no content to find on ${main}`, { sha: member.sha, main, mainSha: target.sha, base });
  }

  const compare = await call(["diff", "--name-only", member.sha, target.sha, "--", ...paths]);
  if (!compare || !compare.ok) {
    return landing("unknown", `git could not compare ${member.sha.slice(0, 7)} with ${main} (${text(compare && compare.err) || "no output"})`, { sha: member.sha, main, mainSha: target.sha, base, paths });
  }
  const differ = text(compare.out).split("\n").map((p) => p.trim()).filter(Boolean);
  // Ancestry is RECORDED, never the verdict. It is the fact that proves a squash landing was judged by content: a
  // landed member whose sha is not an ancestor of main is exactly the case a merge-base test would refuse.
  const ancestry = await call(["merge-base", "--is-ancestor", member.sha, target.sha]);
  const ancestor = Boolean(ancestry && ancestry.ok);

  if (!differ.length) {
    const count = `${paths.length} file${paths.length === 1 ? "" : "s"}`;
    const rewritten = ancestor ? "" : "; the sha is not an ancestor of main, so this was judged by content, not ancestry";
    return landing("landed", `${main} ${target.sha.slice(0, 7)} holds the recorded sha's content in ${count}${rewritten}`, { sha: member.sha, main, mainSha: target.sha, base, paths, ancestor });
  }
  const named = differ.slice(0, 3).join(", ");
  const more = differ.length > 3 ? `, and ${differ.length - 3} more` : "";
  return landing("not-landed", `${main} ${target.sha.slice(0, 7)} differs from the recorded sha in ${named}${more}`, { sha: member.sha, main, mainSha: target.sha, base, paths, differ, ancestor });
}

/**
 * One member's evidence: the pull request read through the API, and the landing read by content. Every failure is a
 * sentence on the evidence, so the gate can say WHY it cannot tell instead of a bare unknown.
 *
 * `readPr({number, project, task, row})` is the host read. It answers `{ok: true, pr}` or `{ok: false, why}`, and a
 * throw is caught here as cannot-tell. `cwdFor({task, row})` names the clone to ask: the member's own worktree while
 * it exists, else the project's checkout, whose object store usually still holds the landed commits.
 */
export async function readMemberEvidence({ task, row = null, project = null, readPr = null, git = gitIn, cwdFor = null, mainRef = "origin/main", timeout = 15000 } = {}) {
  const recorded = task?.row?.pr && typeof task.row.pr === "object" ? task.row.pr : row?.pr && typeof row.pr === "object" ? row.pr : null;
  const number = Number(recorded?.number) > 0 ? Number(recorded.number) : null;
  let pr = null;
  let why = null;
  if (!number) {
    why = "the member names no pull request, so no API read can be made for it";
  } else if (typeof readPr !== "function") {
    why = `pull request #${number} cannot be read: no host reader was supplied`;
  } else {
    try {
      const answer = await readPr({ number, project, task, row });
      if (answer && answer.ok && answer.pr) {
        pr = {
          number: Number(answer.pr.number) > 0 ? Number(answer.pr.number) : number,
          state: text(answer.pr.state) || null,
          mergedAt: answer.pr.mergedAt || null,
          headRefOid: text(answer.pr.headRefOid) || null,
        };
      } else {
        why = text(answer && answer.why) || `pull request #${number} could not be read`;
      }
    } catch (error) {
      why = `the pull request read for #${number} threw: ${text(error && error.message) || String(error)}`;
    }
  }
  // The PR head first: it is the sha the host merged. A PR read that failed or gave no head falls back to the run's
  // own recorded commit, which is still evidence about content (just not about the PR's final head).
  const sha = text(pr?.headRefOid) || recordedShaOf(task);
  // The clone to ask: the caller's rule when it has one, else the member's own tree, else the project's checkout.
  let cwd = null;
  try {
    if (typeof cwdFor === "function") cwd = text(cwdFor({ task, row, project })) || null;
    else cwd = text(task?.worktree) || text(row?.path) || text(project?.path) || null;
  } catch {
    cwd = null;
  }
  const read = await readLanding({ git, cwd, sha, mainRef, timeout });
  return {
    member: task?.id ?? null,
    key: waveMemberKey(task),
    number,
    project: typeof project === "string" ? project : text(project?.name) || text(task?.project) || null,
    pr,
    why,
    sha: sha || null,
    cwd,
    landing: read,
    at: new Date().toISOString(),
  };
}

/**
 * The evidence for every task that names a wave, keyed by the SAME `waveMemberKey` the fold buckets members by, so a
 * caller can hand the map straight to `waveLane` as `evidenceFor: (member) => map.get(member.key)`.
 *
 * Sequential on purpose: this runs on a panel read, and promising a hundred git children at once would make the
 * Initiatives tab the busiest thing on the box. A caller that wants a cache puts it above this function.
 */
export async function collectWaveEvidence({ tasks = [], rowFor = () => null, projectFor = () => null, readPr = null, git = gitIn, cwdFor = null, mainRef = "origin/main", timeout = 15000 } = {}) {
  const out = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task !== "object") continue;
    if (!text(task.waveId)) continue; // a task in no wave has no gate to feed
    const row = task.worktree ? rowFor(text(task.project), task.worktree) : null;
    const project = typeof projectFor === "function" ? projectFor(text(task.project) || text(row?.project)) : null;
    const evidence = await readMemberEvidence({
      task,
      row,
      project,
      readPr,
      git,
      cwdFor: cwdFor || (({ task: t }) => (t && t.worktree ? t.worktree : project && project.path ? project.path : null)),
      mainRef,
      timeout,
    });
    out.set(evidence.key, evidence);
  }
  return out;
}
