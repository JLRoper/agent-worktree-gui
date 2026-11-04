// A directory link inside a worktree, and the one thing that has to happen before anything removes that worktree.
//
// `git worktree remove` WALKS INTO a directory reparse point. Measured on this box against a tree whose `node_modules`
// is a junction onto the primary checkout's own: the command exits 0, prints nothing, drops git's own record, and
// leaves the PRIMARY's `node_modules` empty — every entry deleted, dot-prefixed ones first, in the order a recursive
// walk reaches them, stopping at the first file Windows will not release. Nothing on the tree's own side can undo
// that, and the panel's ✕ path is one Recycle Bin failure away from the same act: its recycle step is best effort by
// design (`recycleError` in lib/worktree-remove.js) and its fallback is `git worktree remove --force`.
//
// So the link comes OUT first, in every removal path in this lib, and a link that will not come out is a REFUSAL
// rather than a removal that deletes through it. Unlinking a junction takes the LINK and never the target: measured
// with a process standing inside the junction, `rmdir` removes the link and the target directory is untouched.
//
// Node's own `fs.rm({recursive})` does NOT recurse through a junction (measured), so the retry loops that empty a
// leftover folder are not the hazard — `git worktree remove` is.
import { lstat, opendir, readlink, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

// A worktree nests deeply (node_modules inside node_modules), but a walk past this is a pathological checkout rather
// than a tree worth deleting: it is reported as unreadable, so the caller refuses instead of guessing.
const MAX_DEPTH = 64;
// `.git` is never descended into: in a worktree it is a file, and in a checkout that reached here by mistake it is an
// object store no removal needs to read.
const SKIP = new Set([".git"]);

const codeOf = (e) => String((e && (e.code || e.message)) || e || "unknown");

// Every directory reparse point under `root`, depth-first. A link is recorded and NOT descended into, so a link that
// points back at an ancestor cannot loop this walk.
export async function linkedDirsIn(root) {
  const out = { links: [], unreadable: [] };
  const start = String(root || "").trim();
  if (!start) return out;
  const top = await lstat(start).catch(() => null);
  // Nothing there, or not a directory: there is no link to speak of, and a caller that meant to delete a missing
  // tree must hear about that from its own check rather than from this walk.
  if (!top || !top.isDirectory()) return out;
  await walk(start, 0, out);
  return out;
}

async function walk(dir, depth, out) {
  if (depth > MAX_DEPTH) {
    out.unreadable.push({ path: dir, error: `deeper than ${MAX_DEPTH} levels` });
    return;
  }
  let handle;
  try {
    handle = await opendir(dir);
  } catch (e) {
    out.unreadable.push({ path: dir, error: codeOf(e) });
    return;
  }
  for await (const entry of handle) {
    const p = path.join(dir, entry.name);
    const st = await lstat(p).catch((e) => {
      out.unreadable.push({ path: p, error: codeOf(e) });
      return null;
    });
    if (!st) continue;
    if (st.isSymbolicLink()) {
      // On Windows a junction reads as a link here as well as a symlink does, which is what makes one rule enough
      // for both kinds of reparse point.
      out.links.push({ path: p, target: await readlink(p).catch(() => "") });
      continue;
    }
    if (st.isDirectory() && !SKIP.has(entry.name)) await walk(p, depth + 1, out);
  }
}

// The links out of the way, taking the LINK and never its target. `rmdir` first — a directory reparse point is
// removed by RemoveDirectoryW, which cannot reach the target — with `unlink` as the fallback for a link Windows
// calls a file. The filesystem is asked again afterwards: a link still standing there is a FAILURE, not a warning,
// because the next thing to walk the tree is `git worktree remove`.
export async function unlinkLinkedDirs(root, { onLog = () => {} } = {}) {
  const found = await linkedDirsIn(root);
  const unlinked = [];
  const failed = [];
  for (const link of found.links) {
    let error = null;
    try {
      await rmdir(link.path);
    } catch (e) {
      try {
        await unlink(link.path);
      } catch (e2) {
        error = codeOf(e2) || codeOf(e);
      }
    }
    const still = await lstat(link.path).catch(() => null);
    if (still) {
      if (!error) error = "still there after rmdir and unlink";
      failed.push({ path: link.path, target: link.target, error });
      onLog(`worktree link: could not unlink ${link.path} (${error}) — its target ${link.target || "(unknown)"} would be deleted through`);
    } else {
      unlinked.push(link.path);
      onLog(`worktree link: unlinked ${link.path} (was ${link.target || "a junction"}) before anything walked the tree`);
    }
  }
  return { links: found.links, unlinked, failed, unreadable: found.unreadable };
}

// The one sentence a caller refuses with, or null when the tree is as link-free as this can prove. Both halves are
// failures: a link that would not come out, and a path the walk could not read — a link inside THAT one would be
// invisible here, and it is exactly the link `git worktree remove` would follow.
export function linkRefusal(report) {
  const bad = [
    ...(report?.failed || []).map((f) => `the link ${f.path} could not be unlinked (${f.error})`),
    ...(report?.unreadable || []).map((u) => `the path ${u.path} could not be read (${u.error})`),
  ];
  if (!bad.length) return null;
  return `this worktree carries a directory link that could not be taken out of the way, and removing the tree would delete through it: ${bad.join("; ")}`;
}
