// One panel per port.
//
// On Windows a server bound to 127.0.0.1:<port> and one bound to 0.0.0.0:<port> can BOTH listen - the second bind
// gets no EADDRINUSE - and loopback traffic goes to the more specific of the two. So a second panel started on the
// reader's port (a sandbox whose config.json was copied from the reader's, say) takes http://127.0.0.1:<port> over
// without a word: the board the reader reloads is suddenly an empty one, "0 project(s)", while their own panel keeps
// running behind it on 0.0.0.0, unreachable at the address they use. That is what happened on 2026-11-01 (an orphaned
// sandbox, pid 37748 on 127.0.0.1:7331, over the reader's panel, pid 35400 on 0.0.0.0:7331).
//
// So a panel asks before it binds: does anything already answer on this port, on loopback or on the host it is
// configured for? If something does, it is waited for briefly - a restart's predecessor is normally gone before the
// replacement starts (lib/panel-restart.cjs waits for its pid), but a socket can outlive the pid by a moment - and a
// listener still there after that is somebody else, so the panel refuses to start rather than shadow it or be
// shadowed. A plain TCP connect is the question: it needs no protocol, and a refused connection comes back at once.
import net from "node:net";

// Does anything accept a TCP connection on host:port? A refusal is "no" at once; silence past `timeoutMs` is also
// "no" (nothing that could take the address's traffic answered).
export function portAnswers(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.connect({ host, port });
    const done = (answered) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(answered);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

// The addresses another listener could be answering on: loopback always (it is the address the board is opened on,
// and the one a more specific bind steals), plus the configured host when that is a specific address of its own.
export function probeHosts(host) {
  const h = String(host || "").trim();
  const out = ["127.0.0.1"];
  if (h && !["0.0.0.0", "::", "[::]", "127.0.0.1"].includes(h)) out.push(h);
  return out;
}

// The address something already answers on for this port, after waiting up to `waitMs` for it to go away; null when
// the port is free. `probe` is injectable so the wait can be tested without sockets.
export async function portHolder({ port, host, waitMs = 5000, stepMs = 250, probe = portAnswers } = {}) {
  if (!port) return null;
  const hosts = probeHosts(host);
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    let holder = null;
    for (const h of hosts) {
      if (await probe(h, port)) {
        holder = h;
        break;
      }
    }
    if (!holder || Date.now() >= deadline) return holder;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// The line a refused boot writes, naming the address, the port and the two ways out.
export function refusalLine(holder, port) {
  return (
    `REFUSING to start: ${holder}:${port} already answers - another server is listening on this panel's port. ` +
    `A second panel bound beside it would take that address's traffic without an error (on Windows a 127.0.0.1 bind ` +
    `and a 0.0.0.0 bind share a port, and loopback goes to the 127.0.0.1 one). Stop the other server ` +
    `(netstat -ano | findstr :${port}) or give this panel another port (config.json "port").`
  );
}
