// lib/pipeline-doc.js — one pipeline document, read from a loopback service for the reader's own page.
//
// WHY THIS EXISTS. public/pipeline-map.html can draw a document it did not build (`?doc=<url>`), but the page is
// served by this panel on http://127.0.0.1:<port> and the factory answers on :8090 with no CORS header — so the
// browser refuses the read and the reader is left with a URL that works in curl and not on the page. The panel is
// already the reader's own machine, so it is the one place that read is allowed to happen. The page sends the URL
// here and gets back the bytes, their length and their sha256, which is the provenance line the drawing has to name.
//
// LOOPBACK ONLY, and deliberately. A panel route that fetches any URL on the network is an SSRF primitive nobody
// asked for: a page on another origin could point it at anything the panel's host can reach and read the answer.
// The services this page imports from are on the reader's machine (the factory's index, a local catalogue), and a
// non-loopback host is refused with a sentence that says so. Redirects are followed by hand, one hop at a time,
// for the same reason — a loopback URL that 302s to a public host must not be read.
//
// It does not parse the document. The page's importer (public/core/pipeline-import.js) owns that, and a route that
// validated a shape it does not draw would be a second opinion that can disagree with the drawing.
import { createHash } from "node:crypto";

export const MAX_BYTES = 4 * 1024 * 1024;
export const TIMEOUT_MS = 15000;
export const MAX_REDIRECTS = 3;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function isLoopbackHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

const refuse = (status, error) => ({ status, body: { ok: false, error } });

async function readCapped(body, maxBytes) {
  if (!body || typeof body.getReader !== "function") return { ok: true, buf: Buffer.alloc(0) };
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* the socket is already going away */
      }
      return { ok: false, total };
    }
    chunks.push(Buffer.from(value));
  }
  return { ok: true, buf: Buffer.concat(chunks) };
}

/**
 * Read one document from a loopback http(s) URL.
 *
 * Returns `{status, body}`. On success the body is
 * `{ok: true, source, finalUrl, status, contentType, bytes, sha256, text}` — `source` is what the reader asked for,
 * `finalUrl` is where the bytes actually came from after redirects, and the sha256 is over the bytes as received.
 */
export async function readPipelineDocument(raw, { fetchImpl = globalThis.fetch, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = {}) {
  const asked = String(raw == null ? "" : raw).trim();
  if (!asked) return refuse(400, "`url` is required — it names one http(s) document");
  let url;
  try {
    url = new URL(asked);
  } catch {
    return refuse(400, "`url` must be an absolute http(s) URL");
  }
  const source = url.href;

  let response;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return refuse(400, `\`url\` must be http or https, not ${JSON.stringify(url.protocol)}`);
    }
    if (!isLoopbackHost(url.hostname)) {
      return refuse(403, `only a loopback URL is read — this panel reads the services on the reader's own machine, and ${JSON.stringify(url.hostname)} is not one of them`);
    }
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
      });
    } catch (e) {
      const why = e && e.name === "TimeoutError" ? `did not answer within ${Math.round(timeoutMs / 1000)}s` : String((e && e.message) || e);
      return refuse(502, `could not reach ${url.href} — ${why}`);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      try {
        await response.body?.cancel();
      } catch {
        /* the body was already empty */
      }
      if (hop >= maxRedirects) return refuse(502, `${source} redirects more than ${maxRedirects} times — refusing to keep following it`);
      try {
        url = new URL(location, url);
      } catch {
        return refuse(502, `${source} redirected to ${JSON.stringify(location)}, which is not a URL`);
      }
      continue;
    }
    break;
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* nothing to drain */
    }
    return refuse(502, `${url.href} answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
  }

  const read = await readCapped(response.body, maxBytes);
  if (!read.ok) return refuse(413, `${url.href} is larger than ${Math.round(maxBytes / 1024)} KiB — a pipeline document is read whole or not at all`);
  if (read.buf.length === 0) return refuse(502, `${url.href} answered an empty body`);

  const text = read.buf.toString("utf8").replace(/^\uFEFF/, "");
  return {
    status: 200,
    body: {
      ok: true,
      source,
      finalUrl: url.href,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      bytes: read.buf.length,
      sha256: sha256(read.buf),
      text,
    },
  };
}
