// ---- How a response is written, and how a body is read --------------------------------------
// Every route on the panel answers through these, and nothing here knows what the route was about:
// `sendJson` writes the status, the headers and (over 2 KB, when the caller takes it) the gzip body;
// `readBody` and `readRawBody` turn a request stream into JSON or bytes; `TYPES` and `gzip` are what
// lib/http/static.js serves a file with. Who may write, and how an SSE reader attaches, stay in
// transport.js, because those two need to know who is calling rather than what is being answered.
//
// The bodies below are the ones server.js used to hold: the status codes, the Content-Type,
// Cache-Control and Vary headers, the 2 KB gzip threshold and the 400/413 rejections are unchanged,
// so every call site answers exactly what it answered before the move.
import { gzipSync as zlibGzipSync } from "node:zlib";
import { HttpError } from "../errors.js";

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
    let done = false;
    const chunks = [];
    req.on("data", (d) => {
      // Over the limit the body is discarded, not the connection: destroying the request here meant
      // the caller never received the 413 that says why - it saw a reset socket instead.
      if (done) return;
      size += d.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new HttpError(413, `attachment is larger than ${Math.round(limit / (1024 * 1024))} MB`), { tooLarge: true }));
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
    let done = false;
    const chunks = [];
    req.on("data", (d) => {
      if (done) return;
      size += d.length;
      if (size > limit) {
        // Answer 413 rather than resetting the socket: the caller has to be able to read the reason.
        done = true;
        reject(new HttpError(413, "body too large"));
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
        reject(new HttpError(400, `invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}
