// A stage's handoff, PINNED to a commit and a blob — never to a branch.
//
// A branch is a moving name. `wtgui/carry-the-contract-a1b2c3` resolved when S3 settled and the same name resolved
// when S4 started can be two different trees, and an artifact read through it is a different artifact with the same
// path. The panel therefore stores, for every artifact a stage settles with, the COMMIT the tree was at and the BLOB
// — the object id, and the sha256 of the object's own bytes — the artifact had in that commit. A later stage is told
// to read `git show <commit>:<path>`, which cannot resolve differently tomorrow.
//
// git answers HERE, not in lib/task-pipeline-drive.js. The driver is pure (§7.3) and takes these readings the way it
// takes the tree facts: as facts handed to it, with one function a test can stand in for.
//
// The sha256 is of the BLOB, not of the checked-out file. With `core.autocrlf` on, the two disagree on identical
// content (the checkout carries CRLF, the blob LF), so a record that hashed the working file would call a clean file
// changed. The blob id is the identity; the sha256 is for a reader who does not want to run git.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Files over 1 MiB record the blob id and their size, not a hash: reading a 2 GB log in a sweep is a stall, not a
// check. The same cap `artifactOf` applies to the working file, so the two readings agree about what was checked.
export const PIN_HASH_MAX = 1024 * 1024;

const text = (value) => (typeof value === "string" ? value.trim() : "");

// The driver stays synchronous, but its caller can suspend and replay a pass around
// asynchronous reads. Scope the reader to one synchronous call, including nested helpers.
let reader = null;
export function withStagePinReader(next, fn) {
  const previous = reader;
  reader = typeof next === "function" ? next : null;
  try {
    return fn();
  } finally {
    reader = previous;
  }
}

function git(worktree, args, { raw = false } = {}) {
  try {
    const out = execFileSync("git", ["-C", worktree, ...args], {
      ...(raw ? {} : { encoding: "utf8" }),
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: null, error };
  }
}

export function shortSha(value) {
  const sha = text(value);
  return sha ? sha.slice(0, 12) : "(none)";
}

// The tree's commit, full-length: what the stage run records and what a handoff is pinned to. An abbreviated sha is
// a display form; storing one would leave the record ambiguous the moment two commits share a prefix (and `git show`
// accepts both, which is exactly how a "pinned" record would quietly resolve to the wrong object).
export function commitOf(worktree) {
  if (reader) return reader("commitOf", [worktree]);
  const where = text(worktree);
  if (!where) return null;
  const found = git(where, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!found.ok) return null;
  const sha = String(found.out || "").trim();
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : null;
}

// The artifact's tree-relative path, as a commit names it. An absolute path the document declared (or a `{{hole}}`
// resolved outside the tree) is not in the commit, and says so rather than being re-rooted by guesswork.
export function relInTree(worktree, target) {
  const where = text(worktree);
  const at = text(target);
  if (!where || !at) return null;
  const root = where.replace(/\\/g, "/").replace(/\/+$/, "");
  const full = at.replace(/\\/g, "/");
  if (full === root) return null;
  if (!full.startsWith(`${root}/`)) return null;
  return full.slice(root.length + 1) || null;
}

// One artifact, resolved at a commit. Answers `{commit, blob, sha256, bytes}` when the file is in that commit;
// `blob: null` with a reason when it is not (an uncommitted artifact, a path outside the tree, no commit at all).
// `sha256` is null for a file over the cap, and `tooLarge` says why — the blob id is still the identity.
export function pinOf(worktree, relPath, { commit = null } = {}) {
  if (reader) return reader("pinOf", [worktree, relPath, { commit }]);
  const head = text(commit) || commitOf(worktree);
  const rel = text(relPath);
  if (!head) return { commit: null, blob: null, sha256: null, reason: "the tree is not a git tree, or it has no commit" };
  if (!rel) return { commit: head, blob: null, sha256: null, reason: "the artifact names no path" };
  // `./` makes the path relative to the working directory of `-C <tree>`, so a worktree that is itself a
  // subdirectory of its repository still names the file the reader sees rather than one re-rooted at the repo.
  const oidRun = git(worktree, ["rev-parse", "--verify", "--quiet", `${head}:./${rel}`]);
  if (!oidRun.ok) return { commit: head, blob: null, sha256: null, reason: "the file is not in the commit" };
  const blob = String(oidRun.out || "").trim();
  const out = { commit: head, blob: blob || null, sha256: null, bytes: null };
  if (!blob) return { ...out, reason: "the file is not in the commit" };
  const sizeRun = git(worktree, ["cat-file", "-s", blob]);
  const size = sizeRun.ok ? Number(String(sizeRun.out || "").trim()) : NaN;
  if (Number.isFinite(size)) out.bytes = size;
  if (Number.isFinite(size) && size > PIN_HASH_MAX) {
    out.sha256 = null;
    out.tooLarge = true;
    return out;
  }
  const body = git(worktree, ["cat-file", "blob", blob], { raw: true });
  if (body.ok && body.out) out.sha256 = createHash("sha256").update(body.out).digest("hex");
  return out;
}

// The blob id a CHECKOUT would produce for the file — `git hash-object` runs the same clean filter `git add` does, so
// a file that is clean and unmodified answers the blob's own id even with `core.autocrlf` on, where hashing the bytes
// on disk would disagree with the object store about identical content.
export function workingBlobOf(worktree, relPath) {
  if (reader) return reader("workingBlobOf", [worktree, relPath]);
  const where = text(worktree);
  const rel = text(relPath);
  if (!where || !rel) return null;
  const run = git(where, ["hash-object", "--", rel]);
  if (!run.ok) return null;
  const oid = String(run.out || "").trim();
  return /^[0-9a-f]{40,64}$/i.test(oid) ? oid.toLowerCase() : null;
}

// Is a RECORDED pin still the tree the stage produced? The question a start asks before it hands the input on.
//
// - no commit recorded (a run from before the pin existed): `ok`, with `recorded: false` — a record that could not
//   have carried the fact is not a refusal, and parking every in-flight row on deploy would be a migration by park.
// - the commit is not in this tree: refused. The branch has moved (a rebase, a reset, another cut) and the record's
//   commit is gone, so a read "at the branch" would be a different tree wearing the same name.
// - the blob at that commit is not the blob recorded: refused. The commit resolves but names other bytes, which is a
//   record about a tree this one is not.
export function pinCheck(worktree, { commit = null, path: rel = null, blob = null } = {}) {
  if (reader) return reader("pinCheck", [worktree, { commit, path: rel, blob }]);
  const want = text(commit);
  if (!want) return { ok: true, recorded: false, reason: null };
  const where = text(worktree);
  if (!where) return { ok: false, recorded: true, reason: `there is no tree to resolve commit ${shortSha(want)} in` };
  const exists = git(where, ["cat-file", "-e", `${want}^{commit}`]);
  if (!exists.ok) {
    return {
      ok: false,
      recorded: true,
      reason: `the commit ${shortSha(want)} it is pinned to is not in this tree — the branch has moved since it settled`,
    };
  }
  const wantBlob = text(blob);
  const relPath = text(rel);
  if (!wantBlob || !relPath) return { ok: true, recorded: true, reason: null };
  const at = git(where, ["rev-parse", "--verify", "--quiet", `${want}:./${relPath}`]);
  const found = at.ok ? String(at.out || "").trim() : "";
  if (found && found !== wantBlob) {
    return {
      ok: false,
      recorded: true,
      reason: `the file ${relPath} at commit ${shortSha(want)} is blob ${shortSha(found)}, not the ${shortSha(wantBlob)} the stage recorded`,
    };
  }
  if (!found) {
    return {
      ok: false,
      recorded: true,
      reason: `the file ${relPath} is not in commit ${shortSha(want)}, so the blob ${shortSha(wantBlob)} it was pinned to is not there either`,
    };
  }
  return { ok: true, recorded: true, reason: null };
}
