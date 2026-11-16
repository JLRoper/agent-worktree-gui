// ---- the docs mirror ----------------------------------------------------------------------
// docs/ and docs/reviews/ are the repo's own pages, and the board serves them from public/,
// because the static route only reads that folder. Keeping the copies in step by hand is what
// left the mirror stale: public/reviews held 1 of docs/reviews' 226 files and public/docs was
// missing 10, so the board answered 404 for pages that exist on disk.
//
// So the copy is part of SERVING, not a hand step: before a page under /docs/ or /reviews/ is
// read, that root's mirror is brought up to date from its source folder - a file the source no
// longer has is removed, so a deleted page answers 404 instead of being served from a copy
// nobody owns.
//
// The check for a page that is already current is two stats - the source file and its copy - so
// the common request costs nothing. A page that is stale or missing is the expensive case: that
// walks the root (which is also what removes what the source dropped), at most once per window
// and one walk at a time, so a page load's burst of assets is one walk. The window is short on
// purpose (1 s), because a mirror a second behind is not the stale mirror this replaces. Nothing
// here is committed: public/docs and public/reviews are build output and .gitignore says so.
//
// Copies land through a temp name in the same directory and a rename, so a page is never read
// half-written and a failed copy leaves the previous bytes in place.
import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../log.js";

// The repo this module belongs to: lib/http/../../ is the checkout's own root, the same way
// lib/http/static.js derives public/ - so a panel started from a worktree mirrors that worktree's
// docs, never another checkout's.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// One entry per served prefix. `route` is what a request path starts with (after the leading
// slash is stripped), `source` is where the pages live, `target` is what the static route reads.
export const MIRROR_ROOTS = [
  { route: "docs/", source: path.join(ROOT, "docs"), target: path.join(ROOT, "public", "docs") },
  { route: "reviews/", source: path.join(ROOT, "docs", "reviews"), target: path.join(ROOT, "public", "reviews") },
];

// How long a sync is trusted before the next request may start another one. Long enough that a
// page's own asset burst is one walk, short enough that an edited page is served on the next look.
export const SYNC_WINDOW_MS = 1000;

// The root a request path belongs to, or null when it is not a mirrored prefix. `docs-old/x`
// must not match `docs/`, which is why the comparison is by prefix WITH the separator.
export function mirrorRootFor(rel) {
  const clean = mirrorPath(rel).replace(/^\/+/, "");
  return MIRROR_ROOTS.find((root) => clean.startsWith(root.route)) || null;
}

// A request path with one spelling for both separators: a URL carries `/`, and Windows accepts
// `\` as one too, so the walk below must not be fooled by the second form.
function mirrorPath(rel) {
  return String(rel || "").replace(/\\/g, "/");
}

// Where `rel` sits inside its root, or null when it would climb out. A mirrored prefix plus
// `..` is a request for another file in public/ (the static route's own containment check
// answers that one), and it must never be read from - or written to - a place outside the root.
function subPathOf(rel, root) {
  const sub = mirrorPath(rel).replace(/^\/+/, "").slice(root.route.length);
  const normal = path.posix.normalize(sub);
  if (!normal || normal === "." || normal.startsWith("../") || normal === ".." || path.isAbsolute(normal)) return null;
  return normal;
}

// Every file under `dir`, as forward-slashed paths relative to it. A missing directory is an
// empty list, never an error: a checkout without docs/reviews is a repo with nothing to mirror.
async function listFiles(dir, prefix = "", out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === "ENOENT") return out;
    throw e;
  }
  for (const ent of entries) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) await listFiles(path.join(dir, ent.name), rel, out);
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

// True when the copy is already the source's bytes as far as stat can tell. The copy's mtime is
// set from the source's after a write, so an unchanged file settles and stops being copied; a
// same-size edit still moves the mtime, which is what catches it.
function looksCurrent(sourceStat, targetStat) {
  if (!targetStat || !targetStat.isFile()) return false;
  return targetStat.size === sourceStat.size && Math.abs(targetStat.mtimeMs - sourceStat.mtimeMs) < 1;
}

// One root, source to target, in one pass. Returns what moved, so a caller (and a test) can see
// that a second pass is a no-op rather than assume it.
export async function syncMirror(source, target) {
  let sourceStat;
  try {
    sourceStat = await stat(source);
  } catch (e) {
    if (e && e.code === "ENOENT") return { copied: 0, removed: 0, files: 0, skipped: "no source folder" };
    throw e;
  }
  if (!sourceStat.isDirectory()) return { copied: 0, removed: 0, files: 0, skipped: "source is not a folder" };

  const wanted = await listFiles(source);
  const wantedSet = new Set(wanted);
  let copied = 0;
  let removed = 0;

  for (const rel of wanted) {
    const from = path.join(source, rel);
    const to = path.join(target, rel);
    const fromStat = await stat(from);
    const toStat = await stat(to).catch(() => null);
    if (looksCurrent(fromStat, toStat)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    const temp = `${to}.mirror-${process.pid}`;
    try {
      await copyFile(from, temp);
      await utimes(temp, fromStat.atime, fromStat.mtime);
      await rename(temp, to);
      copied++;
    } catch (e) {
      await rm(temp, { force: true }).catch(() => {});
      // A reader holding the destination open on Windows can refuse the rename. The next pass
      // retries; the page already on disk is a page, and failing the request over it is worse.
      log(`docs mirror ${rel} could not be copied: ${String((e && e.message) || e)}`);
    }
  }

  const have = await listFiles(target);
  for (const rel of have) {
    if (wantedSet.has(rel)) continue;
    await rm(path.join(target, rel), { force: true }).catch(() => {});
    removed++;
  }

  return { copied, removed, files: wanted.length };
}

// One clock per root: a /reviews/ page loaded right after a /docs/ page is not a reason to serve
// the reviews copy the previous walk happened to leave behind.
const clocks = new Map(MIRROR_ROOTS.map((root) => [root.route, { lastSyncAt: 0, running: null }]));

// The request-time entry point: make sure the page `rel` names is the source's bytes. The cheap
// check is the one file this request is about - two stats - so a page that is already current
// costs nothing; anything else walks the root, at most once per window and one walk at a time,
// which also removes what the source dropped.
export async function refreshMirror(rel, { force = false } = {}) {
  const root = mirrorRootFor(rel);
  if (!root) return null;
  const sub = subPathOf(rel, root);
  if (sub === null) return { copied: 0, removed: 0, files: null, skipped: "outside the mirror root" };

  if (!force) {
    const [from, to] = await Promise.all([
      stat(path.join(root.source, sub)).catch(() => null),
      stat(path.join(root.target, sub)).catch(() => null),
    ]);
    if (from && from.isFile() && looksCurrent(from, to)) return { copied: 0, removed: 0, files: null, skipped: "current" };
  }

  const clock = clocks.get(root.route);
  if (clock.running) return clock.running;
  if (!force && Date.now() - clock.lastSyncAt < SYNC_WINDOW_MS) {
    return { copied: 0, removed: 0, files: null, skipped: "inside the sync window" };
  }
  clock.running = (async () => {
    try {
      return await syncMirror(root.source, root.target);
    } finally {
      clock.lastSyncAt = Date.now();
      clock.running = null;
    }
  })();
  return clock.running;
}

// Tests and tools that need a fresh look without waiting out the window.
export function resetMirrorClock() {
  for (const clock of clocks.values()) clock.lastSyncAt = 0;
}
