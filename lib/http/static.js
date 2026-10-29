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
// The directory is derived from THIS file rather than from server.js, so the module is complete on
// its own: lib/http/../../public is the repo's own public/.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TYPES, acceptsGzip, gzip } from "./transport.js";
import { SHELL, rewriteShell } from "../build-version.js";

// One line, only when a file that exists cannot be read: the panel's log is where a blank page is
// explained, and nothing else in this module writes to it.
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

const SHELL_CACHE = "no-store, must-revalidate";
const HASHED_CACHE = "public, max-age=31536000, immutable";
const PLAIN_CACHE = "no-store";

export async function serveStatic(req, res, route, build = null) {
  const rel = route === "/" ? SHELL : route.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    let body = await readFile(filePath);
    const type = TYPES[path.extname(filePath)] || "application/octet-stream";
    // Read once per request: it is the answer to "which build is this?" and, for the shell, what the
    // URLs inside it are rewritten to.
    const info = build ? await build.current() : null;
    let cache = PLAIN_CACHE;
    if (rel === SHELL) {
      // The one file a browser must never keep: it is how the tab learns about every other change.
      cache = SHELL_CACHE;
      if (info && info.version) {
        body = Buffer.from(rewriteShell(body.toString("utf8"), info.version, info.files), "utf8");
      }
    } else if (info && info.version && info.files[rel]) {
      // The URL itself names the bytes, so only the URL that names THIS build may be kept.
      const asked = new URL(req.url, "http://localhost").searchParams.get("v");
      cache = asked === info.version ? HASHED_CACHE : PLAIN_CACHE;
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
