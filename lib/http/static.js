// ---- the panel's own files ----------------------------------------------------------------
// public/ is read from disk on every request — the panel is edited while it runs, so nothing is
// cached — with the containment check that turns a `..` in the path into a 403 instead of a read of
// whatever sits beside public/.
//
// Since the client bundle carries a version (lib/build-version.js), the cache policy is split in
// two: the shell is no-store, because its URL can never move and a cached copy is exactly the stale
// HTML this panel must not run, while an asset whose URL carries the current version is immutable —
// a changed file changes its URL, not the bytes behind an old one. An asset with no ?v= (or an old
// one) is served no-store, so a stale URL can never be filled with new bytes either.
//
// Three roots, one handler: public/ for the panel's own files, docs/ at /docs/ and docs/reviews/
// at /reviews/ for the repo's own pages. Every root is derived from THIS file rather than from
// server.js, so the module is complete on its own: lib/http/../../ is the repo's own root.
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TYPES, acceptsGzip, gzip } from "./respond.js";
import { SHELL, rewriteShell } from "../build-version.js";

// One line, only when a file that exists cannot be read: the panel's log is where a blank page is
// explained, and nothing else in this module writes to it.
// The shared leveled logger (lib/log.js) replaces this module's own copy of the one-line console.log.
import { log } from "../log.js";

// The checkout this module belongs to: lib/http/../../ is the repo's own root, so a panel started
// from a worktree serves that worktree's files and never another checkout's.
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PUBLIC_DIR = path.join(REPO_DIR, "public");
export const DOCS_DIR = path.join(REPO_DIR, "docs");
export const REVIEWS_DIR = path.join(REPO_DIR, "docs", "reviews");

// The repo's own pages, served as their own roots beside public/: /docs/... reads docs/ and
// /reviews/... reads docs/reviews/. `prefix` is compared WITH its separator, so `docs-old/x` is a
// public/ path and never this root. Each root has its own containment check (`insideRoot`), so a
// request can neither climb out of the root it named nor out of one root into the other.
export const PAGE_ROOTS = [
  { prefix: "docs/", dir: DOCS_DIR },
  { prefix: "reviews/", dir: REVIEWS_DIR },
];

// The page root a request path names, or null when the path is a public/ file.
export function pageRootFor(rel) {
  const clean = String(rel || "").replace(/\\/g, "/");
  return PAGE_ROOTS.find((root) => clean.startsWith(root.prefix)) || null;
}

// Is `target` the root itself or a file under it? The root's own directory is not a file and the
// read answers 404 for it, but it still has to pass HERE, so the refusal that stays is about
// containment rather than about a directory happening to fail a read.
function insideRoot(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

const SHELL_CACHE = "no-store, must-revalidate";
const HASHED_CACHE = "public, max-age=31536000, immutable";
const PLAIN_CACHE = "no-store";

// True when the bytes on disk are still the ones the held build hashed. The held bundle is what
// the watcher proved, so it can lag a write by its debounce; this is asked only to decide whether
// one file may be cached as immutable, never to decide whether the bundle moved.
async function unchangedSinceHeld(filePath, held) {
  if (!held) return false;
  const now = await stat(filePath).catch(() => null);
  return !!now && now.mtimeMs === held.mtimeMs && now.size === held.size;
}

export async function serveStatic(req, res, route, build = null) {
  // One spelling for both separators before anything is joined: a URL carries `/`, and Windows
  // accepts `\` as a separator too, so a path must not be matched one way and read another.
  const asked = route === "/" ? SHELL : route.replace(/^\/+/, "").replace(/\\/g, "/");
  // Which folder answers: public/ for the panel's own files, or the page root the path names with
  // its prefix taken off. `docs-old/x` matches no prefix, so it stays a public/ path.
  const mount = pageRootFor(asked);
  const rootDir = mount ? mount.dir : PUBLIC_DIR;
  const rel = mount ? asked.slice(mount.prefix.length) : asked;
  const filePath = path.join(rootDir, rel);
  // A `..` that leaves the root is a 403, never a read beside it: /docs/../config.json is the
  // repo's own config, and /reviews/../architecture-modules.html is a docs/ page reached by
  // climbing out of the root that was named. No percent-decoding happens on the way in, so an
  // encoded `..` is a literal file name that the read answers 404 for instead of a way through.
  if (!insideRoot(rootDir, filePath)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    let body = await readFile(filePath);
    const type = TYPES[path.extname(filePath)] || "application/octet-stream";
    // Read once per request: it is the answer to "which build is this?" and, for the shell, what the
    // URLs inside it are rewritten to. It is a held value, never a disk read — the watcher in
    // lib/build-version.js is what proves it fresh, so this call cannot wait on a stat or a scan.
    const info = build ? await build.current() : null;
    let cache = PLAIN_CACHE;
    if (rel === SHELL) {
      // The one file a browser must never keep: it is how the tab learns about every other change.
      cache = SHELL_CACHE;
      if (info && info.version) {
        body = Buffer.from(rewriteShell(body.toString("utf8"), info.version, info.files, info.semver), "utf8");
      }
    } else if (!mount && info && info.version && info.files[rel]) {
      // The URL itself names the bytes, so only the URL that names THIS build may be kept — and
      // only while the held build still describes the bytes on disk. The held version can trail an
      // edit by the watcher's debounce (that lag is what keeps the request off the check), and a
      // file the held bundle has not caught up with must not be cached for a year under a URL that
      // names the previous bytes. One stat of the one file being served says which it is.
      //
      // Only public/ is versioned: the build manifest is taken over public/, so a docs/ page can
      // never be immutable, whatever its name collides with.
      const askedVersion = new URL(req.url, "http://localhost").searchParams.get("v");
      cache = askedVersion === info.version && (await unchangedSinceHeld(filePath, info.stamps?.[rel])) ? HASHED_CACHE : PLAIN_CACHE;
    }
    const head = { "Content-Type": type, "Cache-Control": cache, Vary: "Accept-Encoding" };
    // app.js is ~80KB of text the client parses on every load; gzip is free at this size.
    if (body.length > 2048 && /^(text\/|application\/(javascript|json))/.test(type) && acceptsGzip(req)) {
      const gz = gzip(body);
      res.writeHead(200, { ...head, "Content-Encoding": "gzip", "Content-Length": gz.length });
      return res.end(gz);
    }
    res.writeHead(200, { ...head, "Content-Length": body.length });
    res.end(body);
  } catch (e) {
    // Not every readFile failure means "no such file": a permission problem, a directory, or a
    // handle limit used to be answered "404 not found" as well, which is how a page that could not
    // read index.html arrived blank with nothing in the log to explain it. Missing is 404; anything
    // else is the server's problem and says so.
    if (e && (e.code === "ENOENT" || e.code === "EISDIR" || e.code === "ENOTDIR")) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    log(`static ${rel} could not be read: ${String((e && e.message) || e)}`);
    res.writeHead(500, { "Content-Type": "text/plain" }).end("could not read that file");
  }
}
