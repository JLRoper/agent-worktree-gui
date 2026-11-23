// THE EVIDENCE A WAVE GATE READS: three live facts, and no word.
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
//   3. A LANE'S PIN IS A COMMIT AND A BLOB. When a wave holds lanes, its close merges each member's PINNED commit
//      (lib/waves.js `joinWaveLanes`), and the pin is lib/stage-pin.js's own shape: the commit the member's tree
//      stood at, and the blob id of every file it claims, read out of that commit rather than off the disk. The
//      blob is the half that survives a squash: the landed sha is rewritten, the content is not, so a blob read at
//      the commit still names what landed after main has moved. Nothing here re-implements the pin - it reads one
//      through `pinOf` and says which member and which file a pin could not be made for.
//
//   4. A PATH IS READ FROM THE MEMBER'S TREE, OR FROM THE WAVE'S MAIN. The `file-exists` gate names one artefact, and
//      the read it is handed is `readMemberPath`: while the member's tree exists, the tree is the authoritative copy,
//      so a tree that does not hold the path is ABSENT even when main does (a worker's tree is still being written,
//      and the gate is about that work). When the tree is GONE - the cleanup a landed wave goes through - the path is
//      read out of main's own history with no worktree on disk: the newest commit that touched the path on main, and
//      whether that commit's tree holds it as a blob. That commit is an ancestor of main BY CONSTRUCTION (`git log
//      <main> -- <path>` walks main's history), which is what keeps a file that exists only on an unmerged branch from
//      ever reading met. A repo with NO REMOTE has no `origin/main`, and that is the repo class this check exists for,
//      so an unresolvable remote-tracking ref falls back to its local branch and the read names the ref it read.
//
// WHERE THE SHA COMES FROM. The pull request's own head (`headRefOid`) is the sharpest record: it is the head the
// host merged, and the API read returns it in the same answer as the state. A member whose PR read failed or gave no
// head falls back to the sha its own pipeline run recorded - the round's assembly commit, else the newest settled
// stage run's commit (`lib/task-pipeline.js` `settleStageRun`) - which is a fact the run wrote, not a status word.

import { statSync } from "node:fs";
import path from "node:path";

import { gitIn } from "./scan.js";
import { commitOf, pinOf } from "./stage-pin.js";
import { WAVE_ARTEFACT_PATHS_MAX, waveMemberKey } from "./waves.js";

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

// ---- one path, in the member's tree or in the wave's main ---------------------------------------------------------
// The three answers a path read can give. `present` and `absent` are facts about the artefact; `unknown` is the
// reader's blindness, and it blocks exactly as the landing read's `unknown` does.
export const PATH_STATES = Object.freeze(["present", "absent", "unknown"]);

const pathRead = (state, why, extra = {}) => ({
  state,
  why,
  path: null,
  where: null,
  tree: null,
  ref: null,
  mainSha: null,
  commit: null,
  blob: null,
  at: new Date().toISOString(),
  ...extra,
});

/**
 * A repo-relative path, or null. A gate names an ARTEFACT IN THE TREE, so an absolute path, a drive letter, a `~` and a
 * `..` segment are all refused rather than resolved: a read that climbed out of the tree would be reading this machine
 * and answering the gate about a file the wave never owned.
 */
export function repoRelativePath(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) return null;
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

// A stat that separates "not there" from "could not look": ENOENT/ENOTDIR is the absence the gate believes, anything
// else (a permission, a dead drive) is blindness and must not become an unmet or a met.
const statAt = (root, rel) => {
  try {
    const found = statSync(path.join(root, rel));
    return found.isFile() ? "file" : "other";
  } catch (error) {
    return error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? "none" : "blind";
  }
};

/**
 * One path, read from the member's tree while it exists, else from a commit on the wave's main.
 *
 * THE TREE IS AUTHORITATIVE WHILE IT EXISTS. A member whose tree holds the path is `present`; one whose tree exists and
 * does not hold it is `absent`, even if main does - the tree is the copy the work is in, and a gate that read green off
 * somebody else's landing while this member's tree was still being written would close a wave on the wrong work.
 *
 * WHEN THE TREE IS GONE the read moves to main, with no worktree on disk: resolve the ref, take the newest commit on it
 * that touched the path, and list that commit's entry for the path. A `blob` entry is `present`, a `tree` entry (a
 * directory) or no entry is `absent`. The commit is on main's own history, so an unmerged branch cannot contribute.
 *
 * `mainRef` is the caller's (`origin/<main>` from the composition root). A remote-tracking ref that does not resolve -
 * a repo with no remote, which is the class this check exists for - falls back to the local branch of the same name,
 * and `ref` names the one that was read. Never throws.
 */
export async function readMemberPath({ tree = null, rel = "", cwd = null, git = gitIn, mainRef = "origin/main", timeout = 15000 } = {}) {
  const raw = text(rel);
  const repoRel = repoRelativePath(raw);
  if (!raw) return pathRead("unknown", "the gate names no path, so there is no artefact to read");
  if (!repoRel) {
    return pathRead("unknown", `${JSON.stringify(raw)} is not a repo-relative path, so it is not read as an artefact of the tree`, { path: raw });
  }
  const where = text(tree);
  if (where) {
    let root = null;
    try {
      root = statSync(where);
    } catch (error) {
      root = error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? null : "blind";
    }
    if (root === "blind") return pathRead("unknown", `the tree at ${where} could not be read, so ${repoRel} cannot be told`, { path: repoRel, where: "tree", tree: where });
    if (root) {
      if (!root.isDirectory()) return pathRead("unknown", `the member's tree path ${where} is not a directory, so ${repoRel} cannot be told`, { path: repoRel, where: "tree", tree: where });
      const found = statAt(where, repoRel);
      if (found === "file") return pathRead("present", `the tree at ${where} holds ${repoRel}`, { path: repoRel, where: "tree", tree: where });
      if (found === "other") return pathRead("absent", `the tree at ${where} holds ${repoRel}, but it is not a file`, { path: repoRel, where: "tree", tree: where });
      if (found === "blind") return pathRead("unknown", `the tree at ${where} could not be read for ${repoRel}`, { path: repoRel, where: "tree", tree: where });
      return pathRead("absent", `the tree at ${where} holds no ${repoRel}`, { path: repoRel, where: "tree", tree: where });
    }
    // The tree is gone: fall through to the landing read.
  }

  const clone = text(cwd);
  if (!clone) return pathRead("unknown", `no tree and no clone are named, so ${repoRel} cannot be looked for`, { path: repoRel });
  const call = async (args) => {
    if (typeof git !== "function") return { ok: false, err: "no git reader was supplied" };
    try {
      return await git(clone, args, timeout);
    } catch (error) {
      return { ok: false, err: `git threw: ${text(error && error.message) || String(error)}` };
    }
  };
  const commitOf = async (ref) => {
    const r = await call(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const out = r && r.ok ? text(r.out).split("\n")[0] : "";
    return { sha: out || null, why: text(r && r.err) || "no output" };
  };

  const named = text(mainRef) || "origin/main";
  let ref = named;
  let main = await commitOf(named);
  // A LOCAL-ONLY project has no remote-tracking ref. The local branch of the same name is the wave's main there, and
  // the read says which ref it read rather than pretending it read the one that was asked for.
  if (!main.sha && named.includes("/") && !named.startsWith("refs/")) {
    const local = named.slice(named.indexOf("/") + 1);
    const second = await commitOf(local);
    if (second.sha) {
      ref = local;
      main = second;
    }
  }
  if (!main.sha) {
    return pathRead("unknown", `${named} cannot be read in ${clone} (${main.why}), so ${repoRel}'s landing cannot be told`, { path: repoRel, where: "landing", ref: named });
  }

  const history = await call(["log", "-1", "--format=%H", ref, "--", repoRel]);
  if (!history || !history.ok) {
    return pathRead("unknown", `git could not read ${repoRel}'s history on ${ref} (${text(history && history.err) || "no output"})`, { path: repoRel, where: "landing", ref, mainSha: main.sha });
  }
  const commit = text(history.out).split("\n")[0];
  if (!commit) {
    return pathRead("absent", `${ref} ${main.sha.slice(0, 7)} has no commit that touched ${repoRel}, so its landing does not hold it`, { path: repoRel, where: "landing", ref, mainSha: main.sha });
  }
  const listing = await call(["ls-tree", commit, "--", repoRel]);
  if (!listing || !listing.ok) {
    return pathRead("unknown", `git could not list ${repoRel} at ${commit.slice(0, 7)} (${text(listing && listing.err) || "no output"})`, { path: repoRel, where: "landing", ref, mainSha: main.sha, commit });
  }
  // An EXACT path, not a pathspec match: the entry is `<mode> <type> <object>\t<path>` per line, and only the line whose
  // own path is this one is the artefact.
  const entry = text(listing.out)
    .split("\n")
    .find((line) => line.slice(line.indexOf("\t") + 1) === repoRel);
  if (!entry) {
    return pathRead("absent", `${commit.slice(0, 7)} on ${ref} has no ${repoRel}, so its landing does not hold it`, { path: repoRel, where: "landing", ref, mainSha: main.sha, commit });
  }
  const [mode, type, blob] = entry.split(/\s+/);
  if (type !== "blob") {
    return pathRead("absent", `${commit.slice(0, 7)} on ${ref} holds ${repoRel} as a ${type || "non-file"}, not a file`, { path: repoRel, where: "landing", ref, mainSha: main.sha, commit });
  }
  return pathRead("present", `${repoRel} is in ${commit.slice(0, 7)} on ${ref} at ${main.sha.slice(0, 7)}, and that commit is an ancestor of main`, {
    path: repoRel,
    where: "landing",
    ref,
    mainSha: main.sha,
    commit,
    blob: blob || null,
    mode: mode || null,
  });
}

/**
 * The paths an evidence read should carry, unique and bounded. The wave's own gate paths, in the order the routes named
 * them - capped, because a read runs on every request and each tree that is gone costs git calls per path.
 */
export function artefactPaths(paths = []) {
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const rel = text(raw);
    if (!rel || out.includes(rel)) continue;
    out.push(rel);
    if (out.length >= WAVE_ARTEFACT_PATHS_MAX) break;
  }
  return out;
}

/**
 * One member's evidence: the pull request read through the API, and the landing read by content. Every failure is a
 * sentence on the evidence, so the gate can say WHY it cannot tell instead of a bare unknown.
 *
 * `readPr({number, project, task, row})` is the host read. It answers `{ok: true, pr}` or `{ok: false, why}`, and a
 * throw is caught here as cannot-tell. `cwdFor({task, row})` names the clone to ask: the member's own worktree while
 * it exists, else the project's checkout, whose object store usually still holds the landed commits.
 *
 * `paths` are the artefacts the waves being read name in their `file-exists` gates (lib/waves.js
 * `waveFileExistsPaths`). One read per path travels on the evidence as `files`, keyed by the path exactly as the gate
 * wrote it, so the gate reads a fact this request measured rather than one it hopes for. An absent `paths` is no
 * reads, and a gate whose path was not read answers cannot tell.
 */
export async function readMemberEvidence({ task, row = null, project = null, readPr = null, git = gitIn, cwdFor = null, mainRef = "origin/main", paths = [], timeout = 15000 } = {}) {
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
  // The artefact reads, one per path the caller named. Read even while the tree exists - that read is a stat, and it
  // is the authoritative half; a tree that is gone moves the same path to the landing read.
  const tree = text(task?.worktree) || text(row?.path) || null;
  const files = {};
  for (const rel of artefactPaths(paths)) files[rel] = await readMemberPath({ tree, rel, cwd, git, mainRef, timeout });
  return {
    member: task?.id ?? null,
    key: waveMemberKey(task),
    number,
    project: typeof project === "string" ? project : text(project?.name) || text(task?.project) || null,
    pr,
    why,
    sha: sha || null,
    cwd,
    tree,
    files,
    landing: read,
    at: new Date().toISOString(),
  };
}

/**
 * ONE MEMBER'S PIN: the commit its tree stands at, and the blob of every file it claims at that commit.
 *
 * This is the shape lib/waves.js joins on, and it is lib/stage-pin.js's own read (`commitOf`, `pinOf`): the pin names
 * the commit the member settled at and, per claimed file, the blob id that commit holds. A squash rewrites the sha, so
 * the commit half stops naming anything on main; the blob half does not, and that is why a pin carries both.
 *
 * Never throws. `ok: false` carries the sentence, and a member that claims no file is a COMMIT-ONLY pin with `ok:
 * true`: a member with nothing to hash is still pinned to the commit its tree stood at, which is what the join needs.
 */
export function readMemberPin({ member = null, tree = null, files = null, commit = null } = {}) {
  const id = member && member.id != null ? member.id : null;
  const where = text(tree) || text(member && member.worktree);
  if (!where) {
    return { member: id, tree: null, commit: null, files: [], ok: false, why: `#${id ?? "?"} names no worktree, so its pin cannot be read` };
  }
  const head = text(commit) || commitOf(where);
  if (!head) {
    return { member: id, tree: where, commit: null, files: [], ok: false, why: `the tree at ${where} is not a git tree, or it has no commit, so #${id ?? "?"} cannot be pinned` };
  }
  const claimed = (Array.isArray(files) ? files : Array.isArray(member && member.files) ? member.files : []).map(text).filter(Boolean);
  const pins = claimed.map((rel) => {
    const read = pinOf(where, rel, { commit: head });
    return {
      path: rel,
      blob: read.blob || null,
      sha256: read.sha256 || null,
      bytes: Number.isFinite(read.bytes) ? read.bytes : null,
      ...(read.tooLarge ? { tooLarge: true } : {}),
      ...(read.blob ? {} : { reason: read.reason || "the file is not in the commit" }),
    };
  });
  const blind = pins.filter((pin) => !pin.blob);
  return {
    member: id,
    tree: where,
    commit: head,
    files: pins,
    ok: blind.length === 0,
    why: blind.length
      ? `${blind.map((pin) => pin.path).join(", ")} ${blind.length === 1 ? "is" : "are"} not in ${head.slice(0, 12)}, so the pin names no blob for ${blind.length === 1 ? "it" : "them"}`
      : `${head.slice(0, 12)} pins ${pins.length || "no"} file${pins.length === 1 ? "" : "s"}${pins.length ? "" : " - the member claims none, so its commit is the whole pin"}`,
  };
}

/**
 * ONE LANE'S PINS, read live for the join. Each member that owes the join something is pinned through
 * `readMemberPin`; a queued member that never got a tree is skipped (the design lets a wave close with a member still
 * queued), while a member that RAN and names no tree makes the lane unpinnable and is named.
 *
 * `pin` is the reader, taken as an argument so a test can answer without a repository. `ok` is about the whole lane:
 * every member that ran is pinned, and at least one of them names a tree to merge from.
 */
export function readWaveLanePins({ lane = null, pin = readMemberPin } = {}) {
  const record = lane && typeof lane === "object" ? lane : {};
  const label = text(record.label) || text(record.name) || "unlaned";
  const members = Array.isArray(record.members) ? record.members : [];
  const pins = [];
  const blind = [];
  for (const member of members) {
    const where = text(member && member.worktree);
    if (!where) {
      // A member that ran and has no tree is blind; one that never ran owes the join nothing.
      const ran = member && (text(member.state) === "done" || text(member.state) === "parked");
      if (ran) blind.push(`${label} #${member && member.id != null ? member.id : "?"} ran and names no tree`);
      continue;
    }
    const read = pin({ member });
    pins.push(read);
    if (!read.ok) blind.push(read.why);
  }
  const ok = blind.length === 0 && pins.length > 0;
  return {
    lane: record.key || label,
    label,
    members: pins,
    ok,
    why: blind.length
      ? blind.join("; ")
      : pins.length
        ? `${label} pins ${pins.length} member${pins.length === 1 ? "" : "s"} at the commit${pins.length === 1 ? "" : "s"} they settled on`
        : `${label} names no tree, so nothing of it can be pinned to a commit`,
  };
}

/**
 * The evidence for every task that names a wave, keyed by the SAME `waveMemberKey` the fold buckets members by, so a
 * caller can hand the map straight to `waveLane` as `evidenceFor: (member) => map.get(member.key)`.
 *
 * Sequential on purpose: this runs on a panel read, and promising a hundred git children at once would make the
 * Initiatives tab the busiest thing on the box. A caller that wants a cache puts it above this function.
 */
export async function collectWaveEvidence({ tasks = [], rowFor = () => null, projectFor = () => null, readPr = null, git = gitIn, cwdFor = null, mainRef = "origin/main", paths = [], timeout = 15000 } = {}) {
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
      paths,
      timeout,
    });
    out.set(evidence.key, evidence);
  }
  return out;
}
