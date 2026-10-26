// ---- HTTP framing, and nothing else --------------------------------------------------------
// Everything here knows about `req` and `res` and knows nothing about worktrees, jobs, the store or
// the scheduler: how a JSON response is written, when it is gzipped, how a request body is read, how
// an SSE reader is attached and who may write. The two functions that used to read a module-level
// singleton are handed it instead — `authorised(req, token)` and
// `handleStream(req, res, { clients, snapshot })` — so this file imports no domain state at all and
// can be read on its own.
import { gzipSync as zlibGzipSync } from "node:zlib";

// The same one-line timestamped logger every other module in this tree keeps its own copy of
// (lib/jobs.js has one too). A refused write has to be visible in the panel's log, and nothing else
// in this file logs, so it is not worth threading one in for those two lines.
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// What a served file will be called. The static server looks an extension up here, and anything not
// in the map is handed over as application/octet-stream.
export const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export const gzip = (buf) => zlibGzipSync(buf, { level: 6 });

export function acceptsGzip(req) {
  return /\bgzip\b/.test(String((req && req.headers["accept-encoding"]) || ""));
}

export function sendJson(res, code, body) {
  const req = res.req;
  const text = JSON.stringify(body);
  const raw = Buffer.from(text);
  const head = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Encoding" };
  // /api/state is half a megabyte of JSON and the page asks for it periodically; gzip costs a few
  // ms of CPU and removes ~90% of the bytes and most of the client's parse time.
  if (raw.length > 2048 && acceptsGzip(req)) {
    const gz = gzip(raw);
    res.writeHead(code, { ...head, "Content-Encoding": "gzip", "Content-Length": gz.length });
    return res.end(gz);
  }
  res.writeHead(code, { ...head, "Content-Length": raw.length });
  res.end(raw);
}

// Attachments arrive as raw bytes (no multipart parser here): the filename rides in x-filename, so the
// body is exactly the file.
export function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        reject(Object.assign(new Error(`attachment is larger than ${Math.round(limit / (1024 * 1024))} MB`), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

// Attach one SSE reader: the current snapshot first, then whatever `broadcast` pushes at it. The
// client set and the snapshot producer belong to the composition root, so both arrive as arguments.
export function handleStream(req, res, { clients, snapshot }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  log(`client connected (${clients.size} streaming)`);
  req.on("close", () => {
    clients.delete(res);
    log(`client disconnected (${clients.size} streaming)`);
  });
}

// Did this request come in over loopback — i.e. from the machine the panel runs on? That is the panel's
// own UI, and it is the only caller allowed in without a token.
export function isLoopback(req) {
  const addr = String((req.socket && req.socket.remoteAddress) || "").toLowerCase().replace(/^::ffff:/, "");
  return addr === "::1" || addr.startsWith("127.");
}

// Loopback is allowed exactly as before, so the local board is untouched. Anything else — the LAN, a
// tailnet — is allowed only when the panel holds a token (PANEL_TOKEN, from the environment, never
// config.json) AND the request sends it in x-panel-token; with no token configured off-machine writes
// are refused outright. Every write route
// can spawn a process or write a file, so an unauthenticated one reachable from another host is remote
// code execution — the refusal has to be the default, not something a route has to remember.
// A refusal is logged with the address it came from: a 403 nobody can see is a bug report nobody can act on.
//
// `token` is passed in per request rather than captured: the panel can reload its config while a
// route is in flight, and a token read at boot would be the wrong one after that.
export function authorised(req, token) {
  if (isLoopback(req)) return true;
  const addr = (req.socket && req.socket.remoteAddress) || "?";
  if (!token) {
    log(`write refused from ${addr}: no PANEL_TOKEN in the environment, so non-loopback writes are off`);
    return false;
  }
  if (req.headers["x-panel-token"] === token) return true;
  log(`write refused from ${addr}: missing or wrong x-panel-token`);
  return false;
}
