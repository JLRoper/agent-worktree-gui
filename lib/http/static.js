// ---- the panel's own files ----------------------------------------------------------------
// public/ is read from disk on every request — the panel is edited while it runs, so nothing is
// cached — with the containment check that turns a `..` in the path into a 403 instead of a read of
// whatever sits beside public/.
//
// The directory is derived from THIS file rather than from server.js, so the module is complete on
// its own: lib/http/../../public is the repo's own public/.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TYPES, acceptsGzip, gzip } from "./transport.js";

// One line, only when a file that exists cannot be read: the panel's log is where a blank page is
// explained, and nothing else in this module writes to it.
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

export async function serveStatic(req, res, route) {
  const rel = route === "/" ? "index.html" : route.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    const type = TYPES[path.extname(filePath)] || "application/octet-stream";
    const head = { "Content-Type": type, "Cache-Control": "no-store", Vary: "Accept-Encoding" };
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
