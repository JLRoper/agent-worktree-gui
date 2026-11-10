// ---- Who may write, and how a reader attaches ----------------------------------------------
// Everything here knows about `req` and `res` and knows nothing about worktrees, jobs, the store or
// the scheduler: an SSE reader attaches, and a write is admitted only from the panel's own page or
// with the panel's token. The two functions that used to read a module-level singleton are handed it
// instead - `authorised(req, token)` and `handleStream(req, res, { clients, snapshot })` - so this
// file imports no domain state at all and can be read on its own.
//
// The response and body helpers that used to sit above these moved to lib/http/respond.js, so a
// route can import the way it answers without also importing the way a caller is let in.

// The shared leveled logger (lib/log.js): one switch for the whole process, so a refused write and
// a dropped stream land in the panel's log at the severity they deserve.
import { logger, log } from "../log.js";

// Attach one SSE reader: the current snapshot first, then whatever `broadcast` pushes at it. The
// client set and the snapshot producer belong to the composition root, so both arrive as arguments
// — `metrics` (optional) is the composition root's stream counter object, which /api/diagnostics
// reports: connect/disconnect counts, the snapshot's build cost, write errors. `snapshot()` runs
// on the event loop for THIS client, so its duration is measured and named rather than guessed at
// the next "the page took forever to open".
export function handleStream(req, res, { clients, snapshot, metrics = null }) {
  const addr = String((req.socket && req.socket.remoteAddress) || "?").replace(/^::ffff:/, "");
  const openedAt = Date.now();
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const startedAt = process.hrtime.bigint();
  const body = JSON.stringify(snapshot());
  const snapshotMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (metrics) {
    metrics.connected += 1;
    metrics.lastConnectAt = new Date(openedAt).toISOString();
    metrics.lastSnapshot = { ms: Math.round(snapshotMs), bytes: body.length, at: new Date().toISOString() };
  }
  logger.debug(
    `stream: ${addr} attached (${clients.size + 1} streaming) — snapshot ${Math.round(snapshotMs)}ms, ${(body.length / 1048576).toFixed(2)}MB`,
  );
  res.write(`event: snapshot\ndata: ${body}\n\n`);
  clients.add(res);
  log(`client connected (${clients.size} streaming)`);
  // A socket that dies mid-write is the frontend's "yellow dot" in the making: count it, name it,
  // and let the disconnect below record how long the client had actually held the stream.
  res.on("error", (e) => {
    if (metrics) metrics.writeErrors += 1;
    logger.warn(`stream: write error for ${addr}: ${String((e && e.message) || e)}`);
  });
  req.on("close", () => {
    const heldMs = Date.now() - openedAt;
    if (metrics) {
      metrics.disconnected += 1;
      metrics.lastDisconnectAt = new Date().toISOString();
      metrics.lastDisconnectHeldMs = heldMs;
    }
    clients.delete(res);
    log(`client disconnected (${clients.size} streaming)`);
    logger.debug(`stream: ${addr} left after ${Math.round(heldMs / 1000)}s (${clients.size} streaming)`);
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
    logger.warn(`write refused from ${addr}: no PANEL_TOKEN in the environment, so non-loopback writes are off`);
    return false;
  }
  if (req.headers["x-panel-token"] === token) return true;
  logger.warn(`write refused from ${addr}: missing or wrong x-panel-token`);
  return false;
}

// Did this write come from the panel's own PAGE, as opposed to any other client that can reach the loopback port
// (a run's shell among them)? A browser attaches `Origin` to every POST it makes, same-origin ones included, and
// `Origin` is a forbidden header name: page script cannot set it, so the value the page sends is the browser's own
// account of where the request came from. Comparing it with the `Host` the request arrived on is therefore a real
// test of "same-origin page", and a `curl`/`fetch` from a worker's shell has no Origin at all.
//
// It is not a secret and it is not a security boundary against a local process that forges the header on purpose;
// it is the difference between the reader pressing a control and a route a run stumbles into. Routes that must stay
// the reader's own (reassigning a worktree's assistant, which will drive who wakes on that tree) ask this as well
// as `authorised`, and say why in their own comment.
export function pageCaller(req) {
  const origin = String((req && req.headers && req.headers.origin) || "").trim().toLowerCase();
  const host = String((req && req.headers && req.headers.host) || "").trim().toLowerCase();
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.host.toLowerCase() === host;
  } catch {
    return false;
  }
}
