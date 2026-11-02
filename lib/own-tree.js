// Is this directory a TREE, or only a directory that still exists?
//
// The replay guard and the spawn route both have to answer it before they trust a path, because the two are not
// the same thing. Removing a worktree (`git worktree remove`, a Windows delete that keeps the folder, a scratch
// sweep that empties it) can leave the EMPTY directory behind: `existsSync` says yes, `stat().isDirectory()` says
// yes, and every `git -C <it>` call then walks UP to the project's own checkout and answers for THAT — its branch,
// its HEAD, its dirty files. Two failures came from exactly this, on the 0.58.2 boot: a landed brief's debt was
// settled as "main is already in origin/main" because `main` was the PRIMARY checkout's branch, and a replay
// started a worker in a leftover directory whose shell then worked in the primary checkout.
//
// So a tree of its own is one of two things: a LINKED worktree (git's absolute git dir lives under the common
// dir's `worktrees/`, so the two answers differ) or a repository's own checkout root (`--show-toplevel` is the
// path itself). Anything else that merely exists is a leftover, and `outer` names the checkout git would answer
// for, so a refusal or a journal line can say which one.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const clean = (s) => String(s ?? "").replace(/\r/g, "").trim();
// The spelling every comparison here uses: resolved, forward slashes, case folded, no trailing separator.
const key = (p) => path.resolve(clean(p)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

async function git(cwd, args, timeout) {
  try {
    const { stdout } = await pexec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    return { ok: true, out: clean(stdout) };
  } catch (e) {
    return { ok: false, out: clean(e?.stdout || "") };
  }
}

// The three questions `ownTree` decides on, asked in ONE process: `rev-parse` prints one line per flag, in the order
// it was asked. Three spawns would be this module's whole cost (a git process is tens of milliseconds on Windows) and
// lib/scan.js asks it about every worktree on every pass, so the combined call is what makes the guard affordable. A
// call that FAILS says nothing about which question failed — a directory outside every repository prints nothing, and
// one whose toplevel cannot be named prints the first two — so the answers are read from whatever came back, and the
// three separate calls are the fallback only when the combined one printed nothing at all.
async function revParseThree(raw, timeout) {
  const one = await git(raw, ["rev-parse", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"], timeout);
  const lines = one.out ? one.out.split("\n") : [];
  if (lines.length) {
    const at = (i) => (lines[i] ? { ok: true, out: lines[i] } : { ok: false, out: "" });
    return [at(0), at(1), at(2)];
  }
  return Promise.all([
    git(raw, ["rev-parse", "--absolute-git-dir"], timeout),
    git(raw, ["rev-parse", "--git-common-dir"], timeout),
    git(raw, ["rev-parse", "--show-toplevel"], timeout),
  ]);
}

/**
 * `{ ok: true, dir }` when `dir` is a tree of its own, otherwise `{ ok: false, gone, why, outer, notRepo }`.
 *
 * `gone` is always true on the false branch: the caller's question is "can this host a run / be compared with the
 * base", and a directory that git answers for some other checkout cannot do either. `notRepo` separates "there is
 * no repository above it at all" from "there is one, but it is not this directory's" — the spawn route already
 * refuses the first for its own reason, and must not mistake it for a leftover worktree.
 */
export async function ownTree(dir, { timeout = 8_000 } = {}) {
  const raw = clean(dir);
  if (!raw) return { ok: false, gone: true, why: "it names no tree at all", outer: null, notRepo: false };
  if (!existsSync(raw)) return { ok: false, gone: true, why: "its tree is gone", outer: null, notRepo: false };
  const [gitDir, commonDir, top] = await revParseThree(raw, timeout);
  if (!gitDir.ok || !gitDir.out) {
    return { ok: false, gone: true, notRepo: true, why: `its tree is not a git repository (${raw})`, outer: null };
  }
  const common = commonDir.ok && commonDir.out ? key(path.resolve(raw, commonDir.out)) : null;
  if (common && key(gitDir.out) !== common) return { ok: true, dir: raw, outer: null, notRepo: false };
  if (top.ok && top.out && key(top.out) === key(raw)) return { ok: true, dir: raw, outer: null, notRepo: false };
  const outer = top.ok && top.out ? clean(top.out) : null;
  return {
    ok: false,
    gone: true,
    notRepo: false,
    why: outer ? `its tree is a leftover directory — git answers for ${outer} there` : "its tree is a leftover directory",
    outer,
  };
}

/**
 * The checkout git would answer for at the nearest directory that still EXISTS above `dir`. A removed worktree leaves
 * its parent in place — `<repo>/.worktrees` or `<repo>` itself — and git there names the primary checkout, which is
 * where a run's shell would have ended up. One git call, only on the refusal path; `null` when nothing above it is a
 * repository.
 */
async function checkoutAbove(dir, timeout) {
  let up = path.dirname(path.resolve(dir));
  for (let i = 0; i < 8 && up && up !== path.dirname(up); i += 1) {
    if (existsSync(up)) {
      const top = await git(up, ["rev-parse", "--show-toplevel"], timeout);
      if (top.ok && top.out && key(top.out) !== key(dir)) return clean(top.out);
    }
    up = path.dirname(up);
  }
  return null;
}

/**
 * Where a thread's NEXT run may start — the tree that thread was created for, or the refusal that says why it may
 * not run there.
 *
 * A reply continues the SAME agent, so it belongs in that agent's tree. `stat(…).isDirectory()` was the test until
 * 0.62.2, and it let both shapes a release leaves behind through: an empty folder says yes while every `git` call
 * inside it walks up to the project's PRIMARY checkout, and a folder that is gone outright fell through to the
 * record's `cwd` — the same dead path, which the gateway's shell resolves against its own directory. Either way the
 * run started with a cwd that is not its own tree and worked in the reader's checkout. Measured on the 0.62.1 boot:
 * job 5ba56bf1 was a TO line replayed at a thread whose tree had been released hours earlier.
 *
 * So the question is the one `ownTree` already answers, and the answer carries the two things a refusal has to
 * name: the tree it was asked about, and the checkout a run there would have worked in instead.
 *
 * `record` is a job record (a board summary is enough): `worktreePath` is the tree the panel cut for it, and `cwd`
 * is the directory it ran in — the same directory for a run in a tree that already stood.
 */
export async function replyTree(record = {}, { timeout = 8_000 } = {}) {
  const named = clean(record?.worktreePath || record?.cwd || "");
  const own = await ownTree(named, { timeout });
  if (own.ok) return { ok: true, dir: own.dir, named };
  // The checkout a run would have worked in instead. A leftover directory's answer is already in `why` (git named
  // it); a directory that is gone has none of its own, so the nearest directory above it that still exists answers —
  // and the record's `projectPath` is the last resort (a path outside any repository).
  const from = clean(record?.projectPath || "");
  const instead = own.outer || (await checkoutAbove(named, timeout)) || (from && key(from) !== key(named) ? from : null);
  // A leftover directory's `why` already names the checkout git answered for, so the sentence only adds the one a
  // directory that is GONE would have left the run to.
  const refusal =
    `its tree ${named || "(no path recorded)"} is not a tree of its own any more (${own.why})` +
    `${instead && !own.outer ? ` — a run there would have worked in ${instead}, not in a tree of its own` : ""}`;
  return { ok: false, named, why: own.why, outer: own.outer, instead, notRepo: Boolean(own.notRepo), refusal };
}
