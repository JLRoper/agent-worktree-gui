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

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { gitIn } from "./scan.js";
import { commitOf, pinOf } from "./stage-pin.js";
import { WAVE_ARTEFACT_PATHS_MAX, WAVE_EVIDENCE_READS, waveMemberKey } from "./waves.js";
// The read's phase clock (lib/read-profile.js). A member's evidence is the seam that can reach a host and spawn git,
// so each half times itself and each operation is counted.
import { countOperation, noteFact, timeAsync } from "./read-profile.js";

// The three answers a landing read can give. `landed` is content equality, `not-landed` is a content difference,
// and `unknown` is the reader's blindness. They are kept apart for the same reason the gate keeps met and cannot-tell
// apart: "the work is not there" and "the panel cannot see it" are different facts.
export const LANDING_STATES = Object.freeze(["landed", "not-landed", "unknown"]);

const text = (value) => String(value ?? "").trim();

// ---- the ref's tip, read from the ref files when they hold it -------------------------------------------------------
//
// `git rev-parse origin/main` is the honest way to resolve a ref, and it costs a PROCESS on Windows (measured here at
// 100-400 ms for this repository). The tip is the one fact every landing answer is validated against, so it is read on
// every warm read - and a 300 ms spawn per repaint is exactly the kind of cost this row exists to remove. A ref's value
// is ALSO a file, and git's own resolution order is documented, so the tip is read from the ref files when they name it
// and the answer is the sha git would answer; anything unexpected - a tag that needs peeling, a missing file, an
// unreadable directory - falls back to the one spawn (`tipOf` below).
//
// THE RESOLUTION ORDER IS GIT'S, not a guess: a short name is tried as `<name>`, `refs/<name>`, `refs/tags/<name>`,
// `refs/heads/<name>`, `refs/remotes/<name>`, `refs/remotes/<name>/HEAD`, and the FIRST that exists wins. A symbolic
// ref file (`ref: refs/...`) is followed up to three times. An annotated tag would resolve to a tag object whose
// `^{commit}` peel this reader does not do, so a tag candidate makes it answer nothing and git is asked instead.
//
// A REF UPDATE IS ATOMIC (git renames the new file over the old, and rewrites packed-refs the same way), so a reader
// sees the old value or the new one, never a torn one. packed-refs is cached by its own mtime and size, the same rule
// routes/waves.js uses for the pipeline bundle.
const REF_NAME = /^[0-9a-f]{40,64}$/i;
const packedRefsCache = { file: null, stamp: null, map: new Map() };

function commonDirOf(root) {
  const dot = path.join(root, ".git");
  let st = null;
  try {
    st = statSync(dot);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dot;
  if (!st.isFile()) return null;
  let line = "";
  try {
    line = readFileSync(dot, "utf8").split("\n")[0].trim();
  } catch {
    return null;
  }
  if (!line.startsWith("gitdir:")) return null;
  const gitdir = path.resolve(root, line.slice("gitdir:".length).trim());
  try {
    const common = readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
    if (common) return path.resolve(gitdir, common);
  } catch {
    /* a plain clone's gitdir has no commondir: it IS the common dir */
  }
  return gitdir;
}

function packedRefsOf(common) {
  const file = path.join(common, "packed-refs");
  let stamp = null;
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return new Map();
  }
  if (packedRefsCache.file === file && packedRefsCache.stamp === stamp) return packedRefsCache.map;
  const map = new Map();
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const space = line.indexOf(" ");
      if (space < 0) continue;
      map.set(line.slice(space + 1).trim(), line.slice(0, space).trim());
    }
  } catch {
    /* unreadable: an empty map is the fallback to git */
  }
  packedRefsCache.file = file;
  packedRefsCache.stamp = stamp;
  packedRefsCache.map = map;
  return map;
}

function refFileValue(common, name) {
  try {
    const raw = readFileSync(path.join(common, name), "utf8").trim();
    if (raw.startsWith("ref:")) return { sym: raw.slice(4).trim() };
    if (REF_NAME.test(raw)) return { sha: raw };
  } catch {
    /* not a loose ref */
  }
  const packed = packedRefsOf(common).get(name);
  return packed ? { sha: packed } : null;
}

/** The sha a ref names, read out of the repository's ref files, or null when they cannot answer it. */
export function refTipOnDisk(root, ref) {
  const where = text(root);
  const wanted = text(ref);
  if (!where || !wanted) return null;
  const common = commonDirOf(where);
  if (!common) return null;
  const candidates = wanted.startsWith("refs/")
    ? [wanted]
    : [wanted, `refs/${wanted}`, `refs/tags/${wanted}`, `refs/heads/${wanted}`, `refs/remotes/${wanted}`, `refs/remotes/${wanted}/HEAD`];
  for (const name of candidates) {
    let found = refFileValue(common, name);
    if (!found) continue;
    // The FIRST candidate that exists is the ref git would pick, so a tag here must not be skipped for a later one.
    if (name.startsWith("refs/tags/")) return null;
    for (let depth = 0; found && found.sym && depth < 3; depth += 1) found = refFileValue(common, found.sym);
    if (found && found.sha) return found.sha;
    return null;
  }
  return null;
}

// ---- the evidence caches: what an answer is keyed on, and when an entry dies -------------------------------------
//
// A landing answer is a comparison of two CONTENTS: the member's sha, which is immutable, and the main ref's tip,
// which is whatever that ref names right now. So the cache key is (clone, sha, ref) and the entry records the tip sha
// the answer was measured against. The rule below is the whole invalidation contract, and it is written here because a
// stale landing answer is worse than a slow one:
//
//   AN ENTRY DIES WHEN
//     1. the ref's tip is no longer the sha the entry compared against. This is the correctness device: a merge, a
//        fetch, or a local commit on main moves the tip, and the next read measures again. The tip is read ONCE per
//        clone per request (`tips` below), so twelve members of one tree do not pay twelve tip reads and a warm read
//        costs one git spawn per clone, not one per member.
//     2. the key changes. A member whose recorded sha, or whose pull request's head, moved is a different key: the old
//        entry is never consulted for the new content, and the old one ages out (rule 3).
//     3. the entry is older than `WAVE_EVIDENCE_ENTRY_TTL_MS`. This is a MEMORY bound and the pull request word's own
//        freshness window, never the landing rule: trusting a TTL INSTEAD of the tip check is the 30 s staleness this
//        cache replaces. (The PR state rides on a member's evidence, and readWavePrForEvidence's own index has a 60 s
//        TTL; an entry that outlived both would keep an OPEN pull request reading OPEN after it merged.)
//     4. the cache is full: the oldest quarter is evicted, so one huge wave cannot throw away every other answer.
//
// AN `unknown` ANSWER IS NEVER STORED. Blindness is re-read on every call, so a git that comes back is noticed at once
// instead of being cached for the TTL. A cached answer about a sha the clone has since pruned is still a true
// statement about main's content - the answer names the main sha it compared - and a fresh read would only add
// "and the sha is gone".
//
// A PATH READ HAS TWO HALVES, and each is keyed on the fact that decides it:
//   - the member's TREE while it exists: (tree, relative path) plus the stat's stamp, mtime and size. A file that was
//     written, touched, deleted or replaced changes the stamp and the answer is read again; the stat is made either
//     way, so this half saves little and exists for one honest reason - the answer and the stamp cannot disagree.
//   - the wave's MAIN once the tree is gone: (clone, ref, relative path) plus the ref's tip sha, because that read is
//     three or four git spawns (rev-parse, log, ls-tree) and its answer is decided by the tip exactly as a landing is.
export const WAVE_EVIDENCE_ENTRY_TTL_MS = 10 * 60 * 1000;
export const WAVE_EVIDENCE_CACHE_MAX = 600;
// The fan-out's bound: members are read in parallel, up to `CONCURRENCY` at once, against ONE budget for the whole
// answer - the same 15 s one member used to be given, spent by the WAVE rather than by each member in turn. Before
// this, sixteen members against a dead host paid sixteen separate timeouts; the read now tells the caller what it
// could not reach inside the budget, which blocks the gate that needed it.
export const WAVE_EVIDENCE_BUDGET_MS = 15000;
export const WAVE_EVIDENCE_CONCURRENCY = 6;

const landingCache = new Map();
const pathReadCache = new Map();

// A path or a ref is compared by what it names, not by how it is spelled: Windows hands back either slash and a drive
// letter in either case, and the same tree read twice must key the same entry.
const cacheKeyPart = (value) => String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function cacheGet(cache, key, at = Date.now()) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (at - hit.at > WAVE_EVIDENCE_ENTRY_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(cache, key, entry) {
  if (cache.size >= WAVE_EVIDENCE_CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, Math.ceil(WAVE_EVIDENCE_CACHE_MAX / 4));
    for (const [stale] of oldest) cache.delete(stale);
  }
  cache.set(key, entry);
}

/** Empty both caches. A test that rewrites a repository under a fixed path needs this; nothing in the panel calls it. */
export function clearEvidenceCaches() {
  landingCache.clear();
  pathReadCache.clear();
}

/**
 * One read of a ref's tip, shared by every member of the same clone in one request. `tips` is the caller's Map
 * (`collectWaveEvidence` makes one); a caller with no map gets a throwaway one, which is the same read made once.
 * Never throws: an unresolvable ref answers `{sha: null, why}` and the caller's own sentence names the ref.
 */
async function tipOf({ git, cwd, ref, timeout = 15000, tips = null }) {
  const key = `${cacheKeyPart(cwd)}|${text(ref)}`;
  if (tips && tips.has(key)) return tips.get(key);
  const read = (async () => {
    // The ref files first: exact (the first ref git's own resolution order names) and about a millisecond, which is
    // what makes a warm read instant instead of one `git rev-parse` per repaint.
    const onDisk = refTipOnDisk(cwd, text(ref));
    if (onDisk) {
      countOperation("ref.disk");
      return { sha: onDisk, why: "" };
    }
    if (typeof git !== "function") return { sha: null, why: "no git reader was supplied" };
    countOperation("git.calls");
    try {
      const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `${text(ref)}^{commit}`], timeout);
      if (!r || !r.ok) return { sha: null, why: text(r && r.err) || "no output" };
      const out = text(r.out).split("\n")[0];
      return { sha: out || null, why: out ? "" : "no output" };
    } catch (error) {
      return { sha: null, why: `git threw: ${text(error && error.message) || String(error)}` };
    }
  })();
  if (tips) tips.set(key, read);
  return read;
}

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
export async function readLanding({ git = gitIn, cwd, sha, mainRef = "origin/main", timeout = 15000, cache = landingCache, tips = null, tipScope = null } = {}) {
  const wanted = text(sha);
  const main = text(mainRef) || "origin/main";
  const call = async (args) => {
    if (typeof git !== "function") return { ok: false, err: "no git reader was supplied" };
    countOperation("git.calls");
    try {
      return await git(cwd, args, timeout);
    } catch (error) {
      return { ok: false, err: `git threw: ${text(error && error.message) || String(error)}` };
    }
  };
  if (!text(cwd)) return landing("unknown", "the member records no worktree and no project path, so git cannot be asked about its content", { sha: wanted || null, main });
  if (!wanted) return landing("unknown", "the member records no sha, so there is no content to find on main", { main });

  // THE CACHE LOOKUP, before any other spawn: the ref's tip is the one fact that can move, and it is read once per
  // clone per request through `tips`. A hit is an answer measured against the same member content and the same main
  // tip, so it is the answer this read would produce - instant, and not a guess.
  const cacheable = cache instanceof Map;
  const key = cacheable ? `${cacheKeyPart(cwd)}|${wanted}|${main}` : null;
  // THE TIP IS READ IN THE PROJECT'S CHECKOUT WHEN THERE IS ONE (`tipScope`): every worktree of a repo shares one
  // object store, so `origin/main` is one fact however many member trees a wave holds, and a wave of twelve worktrees
  // pays ONE tip read rather than twelve.
  const tip = cacheable ? await tipOf({ git, cwd: text(tipScope) || cwd, ref: main, timeout, tips }) : null;
  if (cacheable && tip && tip.sha) {
    const hit = cacheGet(cache, key);
    if (hit && hit.mainSha === tip.sha) {
      countOperation("landing.cache.hit");
      return { ...hit.answer, cached: true };
    }
    countOperation("landing.cache.miss");
  }

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
  // The tip read above already answered this when the cache is on; asking again would be the second spawn the cache
  // exists to avoid.
  const target = tip ? { sha: tip.sha, why: tip.why } : await commitOf(main);
  if (!target.sha) {
    return landing("unknown", `${main} cannot be read in ${cwd} (${target.why}), so there is no main content to compare against`, { sha: wanted, main });
  }

  // THE MEMBER'S OWN COMMIT *IS* MAIN'S TIP. That is content equality by identity, and it is a fact rather than the
  // blindness the empty-diff branch below reports: a member whose recorded commit is the tip has nothing left to land.
  // Without this, a wave holding such a member answered cannot tell on every read AND re-read it every time, because
  // an unknown answer is never cached (see the rule above).
  if (member.sha === target.sha) {
    const answer = landing("landed", `${main} ${target.sha.slice(0, 7)} IS the recorded sha, so the member's content is main's own`, {
      sha: member.sha,
      main,
      mainSha: target.sha,
      base: target.sha,
      paths: [],
      ancestor: true,
    });
    if (cacheable) cacheSet(cache, key, { at: Date.now(), mainSha: target.sha, answer });
    return answer;
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
    const answer = landing("landed", `${main} ${target.sha.slice(0, 7)} holds the recorded sha's content in ${count}${rewritten}`, { sha: member.sha, main, mainSha: target.sha, base, paths, ancestor });
    if (cacheable) cacheSet(cache, key, { at: Date.now(), mainSha: target.sha, answer });
    return answer;
  }
  const named = differ.slice(0, 3).join(", ");
  const more = differ.length > 3 ? `, and ${differ.length - 3} more` : "";
  const answer = landing("not-landed", `${main} ${target.sha.slice(0, 7)} differs from the recorded sha in ${named}${more}`, { sha: member.sha, main, mainSha: target.sha, base, paths, differ, ancestor });
  if (cacheable) cacheSet(cache, key, { at: Date.now(), mainSha: target.sha, answer });
  return answer;
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
    const kind = found.isFile() ? "file" : "other";
    // THE STAMP IS WHAT THE TREE HALF OF THE PATH CACHE IS KEYED ON: a write, a touch, a delete or a replacement
    // changes it, and the answer is read again. The stat is made either way - this half saves almost nothing and is
    // here so a cached answer can never disagree with the file it describes.
    return { kind, stamp: `${found.mtimeMs}:${found.size}:${kind}` };
  } catch (error) {
    const absent = Boolean(error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
    const kind = absent ? "none" : "blind";
    return { kind, stamp: kind };
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
export async function readMemberPath({ tree = null, rel = "", cwd = null, git = gitIn, mainRef = "origin/main", timeout = 15000, cache = pathReadCache, tips = null, tipScope = null } = {}) {
  const raw = text(rel);
  const repoRel = repoRelativePath(raw);
  if (!raw) return pathRead("unknown", "the gate names no path, so there is no artefact to read");
  if (!repoRel) {
    return pathRead("unknown", `${JSON.stringify(raw)} is not a repo-relative path, so it is not read as an artefact of the tree`, { path: raw });
  }
  const cacheable = cache instanceof Map;
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
      const treeKey = cacheable ? `tree|${cacheKeyPart(where)}|${repoRel.toLowerCase()}` : null;
      const hit = cacheable ? cacheGet(cache, treeKey) : null;
      if (hit && hit.stamp === found.stamp) {
        countOperation("path.cache.hit");
        return { ...hit.answer, cached: true };
      }
      let answer = null;
      if (found.kind === "file") answer = pathRead("present", `the tree at ${where} holds ${repoRel}`, { path: repoRel, where: "tree", tree: where });
      else if (found.kind === "other") answer = pathRead("absent", `the tree at ${where} holds ${repoRel}, but it is not a file`, { path: repoRel, where: "tree", tree: where });
      else if (found.kind === "blind") answer = pathRead("unknown", `the tree at ${where} could not be read for ${repoRel}`, { path: repoRel, where: "tree", tree: where });
      else answer = pathRead("absent", `the tree at ${where} holds no ${repoRel}`, { path: repoRel, where: "tree", tree: where });
      if (cacheable) cacheSet(cache, treeKey, { at: Date.now(), stamp: found.stamp, answer });
      return answer;
    }
    // The tree is gone: fall through to the landing read.
  }

  const clone = text(cwd);
  if (!clone) return pathRead("unknown", `no tree and no clone are named, so ${repoRel} cannot be looked for`, { path: repoRel });
  const call = async (args) => {
    if (typeof git !== "function") return { ok: false, err: "no git reader was supplied" };
    countOperation("git.calls");
    try {
      return await git(clone, args, timeout);
    } catch (error) {
      return { ok: false, err: `git threw: ${text(error && error.message) || String(error)}` };
    }
  };

  const named = text(mainRef) || "origin/main";
  let ref = named;
  // The tip is read through the same per-request table a landing read uses: a member whose tree is gone and a member
  // whose landing is judged share one ref read, not one each.
  const tipRoot = text(tipScope) || clone;
  let main = await tipOf({ git, cwd: tipRoot, ref: named, timeout, tips });
  // A LOCAL-ONLY project has no remote-tracking ref. The local branch of the same name is the wave's main there, and
  // the read says which ref it read rather than pretending it read the one that was asked for.
  if (!main.sha && named.includes("/") && !named.startsWith("refs/")) {
    const local = named.slice(named.indexOf("/") + 1);
    const second = await tipOf({ git, cwd: tipRoot, ref: local, timeout, tips });
    if (second.sha) {
      ref = local;
      main = second;
    }
  }
  if (!main.sha) {
    return pathRead("unknown", `${named} cannot be read in ${clone} (${main.why}), so ${repoRel}'s landing cannot be told`, { path: repoRel, where: "landing", ref: named });
  }

  // THE LANDING HALF'S CACHE: (clone, resolved ref, path) plus the tip the answer was measured at. A hit is the same
  // three or four git reads' answer, and a tip that moved re-reads it.
  const landingKey = cacheable ? `landing|${cacheKeyPart(clone)}|${ref.toLowerCase()}|${repoRel.toLowerCase()}` : null;
  if (cacheable) {
    const hit = cacheGet(cache, landingKey);
    if (hit && hit.refSha === main.sha) {
      countOperation("path.cache.hit");
      return { ...hit.answer, cached: true };
    }
    countOperation("path.cache.miss");
  }
  const remember = (answer) => {
    if (cacheable && (answer.state === "present" || answer.state === "absent")) cacheSet(cache, landingKey, { at: Date.now(), refSha: main.sha, answer });
    return answer;
  };
  const history = await call(["log", "-1", "--format=%H", ref, "--", repoRel]);
  if (!history || !history.ok) {
    return pathRead("unknown", `git could not read ${repoRel}'s history on ${ref} (${text(history && history.err) || "no output"})`, { path: repoRel, where: "landing", ref, mainSha: main.sha });
  }
  const commit = text(history.out).split("\n")[0];
  if (!commit) {
    return remember(pathRead("absent", `${ref} ${main.sha.slice(0, 7)} has no commit that touched ${repoRel}, so its landing does not hold it`, { path: repoRel, where: "landing", ref, mainSha: main.sha }));
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
    return remember(pathRead("absent", `${commit.slice(0, 7)} on ${ref} has no ${repoRel}, so its landing does not hold it`, { path: repoRel, where: "landing", ref, mainSha: main.sha, commit }));
  }
  const [mode, type, blob] = entry.split(/\s+/);
  if (type !== "blob") {
    return remember(pathRead("absent", `${commit.slice(0, 7)} on ${ref} holds ${repoRel} as a ${type || "non-file"}, not a file`, { path: repoRel, where: "landing", ref, mainSha: main.sha, commit }));
  }
  return remember(pathRead("present", `${repoRel} is in ${commit.slice(0, 7)} on ${ref} at ${main.sha.slice(0, 7)}, and that commit is an ancestor of main`, {
    path: repoRel,
    where: "landing",
    ref,
    mainSha: main.sha,
    commit,
    blob: blob || null,
    mode: mode || null,
  }));
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
 * The three halves an evidence read owes for a set of gate checks. `null` (or nothing) is the historical read
 * EVERYTHING - what a caller with no gate in hand, and every test that predates this table, asks for. A list is a
 * union over `WAVE_EVIDENCE_READS`, and an EMPTY list is then "read nothing", which is the answer for a lane whose
 * gates all judge the board row.
 */
export function evidenceReadsFor(checks = null) {
  if (checks === null || checks === undefined) return { pr: true, landing: true, files: true };
  const out = { pr: false, landing: false, files: false };
  for (const check of Array.isArray(checks) ? checks : [checks]) {
    const want = WAVE_EVIDENCE_READS[String(check)];
    if (!want) continue;
    out.pr = out.pr || want.pr;
    out.landing = out.landing || want.landing;
    out.files = out.files || want.files;
  }
  return out;
}

/**
 * One member's evidence: the pull request read through the API, and the landing read by content. Every failure is a
 * sentence on the evidence, so the gate can say WHY it cannot tell instead of a bare unknown.
 *
 * `checks` is the gate vocabulary this read is for (`waveEvidenceNeeds(...).checks`): a `file-exists` lane owes no
 * pull request and no landing, and a `pr-open` lane owes no landing. Reading the halves nobody asks for is what made a
 * two-member gate pay nineteen members' worth of host reads and git spawns, so the halves are read only when a gate in
 * this answer consumes them; `landing` comes back null when none does, and no gate reads it then.
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
export async function readMemberEvidence({ task, row = null, project = null, readPr = null, git = gitIn, cwdFor = null, mainRef = "origin/main", paths = [], checks = null, pathCache = null, tips = null, timeout = 15000 } = {}) {
  const reads = evidenceReadsFor(checks);
  const recorded = task?.row?.pr && typeof task.row.pr === "object" ? task.row.pr : row?.pr && typeof row.pr === "object" ? row.pr : null;
  const number = Number(recorded?.number) > 0 ? Number(recorded.number) : null;
  let pr = null;
  let why = null;
  if (!reads.pr) {
    // Not read, and said so: the sentence is only ever drawn by a gate that reads a pull request, and none in this
    // answer does. A read nobody asked for is not "unknown", it is not owed.
    why = "the gates in this answer take no pull request, so none was read";
  } else if (!number) {
    why = "the member names no pull request, so no API read can be made for it";
  } else if (typeof readPr !== "function") {
    why = `pull request #${number} cannot be read: no host reader was supplied`;
  } else {
    try {
      const answer = await timeAsync("member.pr", () => readPr({ number, project, task, row }));
      countOperation("pr.read");
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
  // own recorded commit, which is still evidence about content (just not about the PR's final head). Neither half is
  // resolved when neither is read: a sha nobody compares is a read nobody owes.
  const sha = reads.pr || reads.landing ? text(pr?.headRefOid) || recordedShaOf(task) : null;
  // The clone to ask: the caller's rule when it has one, else the member's own tree, else the project's checkout.
  let cwd = null;
  try {
    if (typeof cwdFor === "function") cwd = text(cwdFor({ task, row, project })) || null;
    else cwd = text(task?.worktree) || text(row?.path) || text(project?.path) || null;
  } catch {
    cwd = null;
  }
  const read = reads.landing ? await timeAsync("member.landing", () => readLanding({ git, cwd, sha, mainRef, timeout, tips, tipScope: text(project?.path) || null })) : null;
  // The artefact reads, one per path the caller named. Read even while the tree exists - that read is a stat, and it
  // is the authoritative half; a tree that is gone moves the same path to the landing read.
  const tree = text(task?.worktree) || text(row?.path) || null;
  const files = {};
  if (reads.files) {
    // ONE PATH IS ONE READ PER REQUEST. A wave's gate names a path, and every member of that wave is asked about the
    // same artefact: when two of them name the same tree (or share the project's checkout because their trees are
    // gone) the second answer is the first one, and the promise in the cache is what makes two members reading at
    // once share the spawns rather than race them.
    const cache = pathCache instanceof Map ? pathCache : new Map();
    await timeAsync("member.files", async () => {
      for (const rel of artefactPaths(paths)) {
        const key = `${tree || ""}|${cwd || ""}|${mainRef}|${rel}`;
        let read = cache.get(key);
        if (!read) {
          read = readMemberPath({ tree, rel, cwd, git, mainRef, timeout, tips, tipScope: text(project?.path) || null }).catch((error) => {
            cache.delete(key);
            throw error;
          });
          cache.set(key, read);
        }
        files[rel] = await read;
      }
    });
  }
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
 * The bounded fan-out this replaced read one member at a time ("promising a hundred git children at once would make
 * the Initiatives tab the busiest thing on the box"). The bound is now the concurrency and the budget below rather
 * than one-at-a-time, and the caches make a warm member cost no member read at all.
 */
// The fan-out's own sentinel: a member whose read outlived the budget answers with this instead of an evidence object,
// and the gate that reads it blocks. It is a value, not a throw, so one slow member cannot fail the whole answer.
const BUDGET_SPENT = Symbol("wave-evidence-budget-spent");

const budgetEvidence = (task, why) => ({
  member: task?.id ?? null,
  key: waveMemberKey(task),
  number: null,
  project: text(task?.project) || null,
  pr: null,
  why,
  sha: null,
  cwd: null,
  tree: text(task?.worktree) || null,
  files: {},
  landing: null,
  // `error` is what a gate reports verbatim (lib/waves.js `readWaveGate` `evidenceOf`), so the reader is told the
  // budget was spent rather than "no evidence was read".
  error: why,
  budgetExhausted: true,
  at: new Date().toISOString(),
});

/**
 * Every wave member's evidence, keyed by the same `waveMemberKey` the fold buckets members by.
 *
 * THE FAN-OUT IS BOUNDED IN TWO DIMENSIONS. Members are read in parallel, `concurrency` at a time, against ONE
 * `budgetMs` for the whole answer - not one 15 s timeout per member, which is sixteen timeouts for a wave of sixteen.
 * A member that cannot be started or finished inside the budget answers `budgetExhausted` with its sentence, and the
 * gate that needed it reads cannot tell: a read that ran out of time never becomes a pass.
 *
 * `mainRef` may be a function of `{task, row, project}`: a member of another project compares against that project's
 * own main (`origin/<mainBranch>`), which is the rule the composition root already applies per member.
 *
 * A caller that wants a cache puts nothing above this any more: the landing and path reads below key their answers on
 * the facts that decide them, so a warm member costs one ref-tip read per clone and no member read at all.
 */
export async function collectWaveEvidence({
  tasks = [],
  rowFor = () => null,
  projectFor = () => null,
  readPr = null,
  git = gitIn,
  cwdFor = null,
  mainRef = "origin/main",
  paths = [],
  checks = null,
  timeout = 15000,
  concurrency = WAVE_EVIDENCE_CONCURRENCY,
  budgetMs = WAVE_EVIDENCE_BUDGET_MS,
} = {}) {
  const out = new Map();
  const pathCache = new Map();
  // One tip read per clone for the whole answer: the landing read and the path read share it through this map.
  const tips = new Map();
  const refOf = typeof mainRef === "function" ? mainRef : () => mainRef;
  const limit = Number(budgetMs);
  const deadline = Number.isFinite(limit) && limit > 0 ? Date.now() + limit : Infinity;
  const wanted = (Array.isArray(tasks) ? tasks : []).filter((task) => task && typeof task === "object" && text(task.waveId));
  const width = Math.max(1, Math.min(Number(concurrency) > 0 ? Math.floor(Number(concurrency)) : WAVE_EVIDENCE_CONCURRENCY, wanted.length || 1));

  const bounded = (promise, ms) => {
    if (!Number.isFinite(ms)) return promise;
    let timer = null;
    const stop = new Promise((resolve) => {
      timer = setTimeout(() => resolve(BUDGET_SPENT), Math.max(1, ms));
      timer.unref?.();
    });
    return Promise.race([promise, stop]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= wanted.length) return;
      const task = wanted[index];
      const key = waveMemberKey(task);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        countOperation("evidence.skipped");
        out.set(key, budgetEvidence(task, `the evidence read's ${limit}ms budget was spent before #${task.id ?? "?"} could be read, so its gates read cannot tell`));
        continue;
      }
      const row = task.worktree ? rowFor(text(task.project), task.worktree) : null;
      const project = typeof projectFor === "function" ? projectFor(text(task.project) || text(row?.project)) : null;
      const read = readMemberEvidence({
        task,
        row,
        project,
        readPr,
        git,
        cwdFor: cwdFor || (({ task: t }) => (t && t.worktree ? t.worktree : project && project.path ? project.path : null)),
        mainRef: text(refOf({ task, row, project })) || "origin/main",
        paths,
        checks,
        pathCache,
        tips,
        // Each member's own git calls cannot outlive the answer's budget either: a call gets the smaller of the read's
        // timeout and the time the budget has left.
        timeout: Math.max(1, Math.min(Number(timeout) > 0 ? Number(timeout) : 15000, remaining)),
      });
      const evidence = await bounded(read, remaining);
      countOperation("evidence.members");
      if (evidence === BUDGET_SPENT) {
        countOperation("evidence.timedOut");
        out.set(key, budgetEvidence(task, `the evidence read for #${task.id ?? "?"} outlived the ${limit}ms budget, so its gates read cannot tell`));
        continue;
      }
      out.set(evidence.key, evidence);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}
