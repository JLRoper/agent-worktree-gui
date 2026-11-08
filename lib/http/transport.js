// ---- Who may write, and how a reader attaches ----------------------------------------------
// Everything here knows about `req` and `res` and knows nothing about worktrees, jobs, the store or
// the scheduler: an SSE reader attaches, and a write is admitted only from the panel's own page or
// with the panel's token. The two functions that used to read a module-level singleton are handed it
// instead - `authorised(req, token)` and `handleStream(req, res, { clients, snapshot })` - so this
// file imports no domain state at all and can be read on its own.
//
// The response and body helpers that used to sit above these moved to lib/http/respond.js, so a
// route can import the way it answers without also importing the way a caller is let in.

// The same one-line timestamped logger every other module in this tree keeps its own copy of
// (lib/jobs.js has one too). A refused write has to be visible in the panel's log, and nothing else
// in this file logs, so it is not worth threading one in for those two lines.
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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
