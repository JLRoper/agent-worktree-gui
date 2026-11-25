// Who holds the panel's port, and is it ours to stop?
//
// A panel restart leaves a detached helper behind (lib/panel-restart.cjs) whose whole job is to start the
// replacement AFTER the outgoing panel has let go of the port. Two things defeat that wait, and both of them end
// the same way — the replacement dies on EADDRINUSE and the reader keeps the old build with nothing on screen
// saying so:
//
//   * the outgoing panel never exits. It asked for the bounce and then hung in shutdown (a store write, a wedged
//     socket). The helper's escape hatch used to launch anyway after 60 s, straight into the port its own parent
//     was still holding, and the boot guard refused the replacement in favour of the old one.
//   * a stray `server.js` holds the port while the pid the helper waits for is already gone — the orphaned panel
//     2026-11-01 left behind (lib/port-guard.js has the measured case: two binds sharing a port on Windows).
//
// So the helper asks this module, before it starts anything, which pids are LISTENING on the port, and stops the
// ones that read as this panel: `server.js` in the command line, or `node` with no command line to read. A holder
// that does not read as a panel is named in the log and left alone — the panel does not own the port enough to
// kill a stranger, and a boot that cannot bind still refuses in words.
import { execFile } from "node:child_process";
import { portAnswers, probeHosts } from "./port-guard.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Is this pid a process on this machine? `kill(pid, 0)` sends no signal; EPERM means it exists and belongs to
// somebody else, which is still alive. Never throws.
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
}

// One command, never a throw: a reader that cannot run (no netstat, no lsof, a denied powershell) is an empty
// answer, and every caller here has an honest "unknown" to fall back on.
//
// `windowsHide` is here AND at every call site: the option has to be on the execFile this runs, and
// tools/child-process-audit.mjs reads the call site (an alias it cannot see through), so a site without it is a
// reported violation — the same shape lib/activity.js uses for its `pexec`.
export function run(bin, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ""), error: err ? String((err && err.message) || err) : null, stderr: String(stderr || "") });
    });
  });
}

// The pids netstat calls LISTENING on `port`. Rows look like
//   TCP    0.0.0.0:7331     0.0.0.0:0     LISTENING     48564
//   TCP    [::1]:7331       [::]:0        LISTENING     48564
// and the columns that matter are the bound address and the last one. The bind is kept, not just the pid: a
// listener on 0.0.0.0 answers a 127.0.0.1 probe (lib/port-guard.js has the incident), so a lookup made for the
// address that answered has to see a wildcard socket as covering it.
export function listeningBindingsFromNetstat(stdout, port) {
  const want = String(Number(port));
  const out = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m && m[2] === want) out.push({ address: m[1], port: Number(m[2]), pid: Number(m[3]) });
  }
  return out;
}

// The binding behind `listeningPidsFromNetstat`, which stays the pid-only answer every older caller reads.
export function listeningPidsFromNetstat(stdout, port) {
  return [...new Set(listeningBindingsFromNetstat(stdout, port).map((b) => b.pid))];
}

const WILDCARD = new Set(["0.0.0.0", "::", "[::]", "*", "0:0:0:0:0:0:0:0"]);
const loopback = (v) => ["127.0.0.1", "::1", "[::1]", "localhost"].includes(v);

// Does a socket bound to `address` answer a connection to `host`? A wildcard bind covers every local address -
// that is the case which made the helper print "answers on 127.0.0.1" and "nothing reports as LISTENING" in the
// same second, when the holder was a 0.0.0.0 listener. An address neither side can read never narrows the answer:
// the rule is evidence against a holder, never a guess that hides one.
export function bindingAnswers(address, host) {
  const a = String(address || "").trim().toLowerCase();
  const h = String(host || "").trim().toLowerCase();
  if (!a || !h) return true;
  if (WILDCARD.has(a) || WILDCARD.has(h)) return true;
  if (a === h) return true;
  return loopback(a) && loopback(h);
}

// The lines `ss -ltnp` prints for one port, whose local address is the `0.0.0.0:7331` field and whose pid is
// inside the users:(("node",pid=48564,fd=21)) field.
export function listeningBindingsFromSs(stdout, port) {
  const want = String(Number(port));
  const out = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    const fields = line.trim().split(/\s+/);
    const at = fields.findIndex((f) => new RegExp(`:${want}$`).test(f));
    if (at < 0) continue;
    const address = fields[at].replace(new RegExp(`:${want}$`), "");
    for (const m of line.matchAll(/pid=(\d+)/g)) out.push({ address, port: Number(want), pid: Number(m[1]) });
  }
  return out;
}

// The lines `ss -ltnp` prints for one port, whose pid is inside the users:(("node",pid=48564,fd=21)) field.
export function listeningPidsFromSs(stdout, port) {
  return [...new Set(listeningBindingsFromSs(stdout, port).map((b) => b.pid))];
}

// Every socket LISTENING on `port`, with the address it bound, by whichever tool this OS has.
async function listeningBindings(port, { platform = process.platform, exec = run } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0) return [];
  if (platform === "win32") {
    const { out } = await exec("netstat", ["-ano"], { windowsHide: true });
    return listeningBindingsFromNetstat(out, n);
  }
  const ss = await exec("ss", ["-ltnp"], { windowsHide: true });
  const fromSs = listeningBindingsFromSs(ss.out, n);
  if (fromSs.length) return fromSs;
  // lsof is the fallback where ss is absent; it names pids only, so those bindings answer every host.
  const lsof = await exec("lsof", ["-nP", `-iTCP:${n}`, "-sTCP:LISTEN", "-t"], { windowsHide: true });
  if (lsof.ok) {
    const pids = lsof.out.split(/\s+/).map(Number).filter((p) => Number.isInteger(p) && p > 0);
    return [...new Set(pids)].map((pid) => ({ address: "", port: n, pid }));
  }
  return [];
}

// Every pid listening on `port`, by whichever tool this OS has. An empty answer means "nothing I can name", which
// is not the same as "nothing is listening" - the connect probe answers that question. `host` narrows the answer
// to the sockets that can answer that address, so a lookup for 127.0.0.1 still names a 0.0.0.0 listener and does
// not name a socket bound to an address the probe never reached.
export async function listeningPids(port, { platform = process.platform, exec = run, host = "" } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0) return [];
  const bindings = await listeningBindings(n, { platform, exec });
  const want = String(host || "").trim();
  const rows = want ? bindings.filter((b) => bindingAnswers(b.address, want)) : bindings;
  return [...new Set(rows.map((b) => b.pid))];
}

// What this pid is running: the command line when the OS will give it to us, and the image name always (it is the
// cheap call, and the only one that answers when the command line is refused). `commandTimeoutMs` bounds the
// expensive half: `Get-CimInstance` costs seconds here, and a restart's helper asks this while it is on the clock,
// so the 15 s default is too long to hang on. Six seconds clears a slow-but-working read and still bounds a wedged
// one; the image name answers either way, so the bound costs the recognition nothing.
export async function processInfo(pid, { platform = process.platform, exec = run, commandTimeoutMs = 6000 } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { pid: n, command: "", image: "" };
  if (platform === "win32") {
    const ps = await exec("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${n}').CommandLine`,
    ], { windowsHide: true, timeout: commandTimeoutMs });
    const command = ps.ok ? ps.out.trim() : "";
    const list = await exec("tasklist", ["/FI", `PID eq ${n}`, "/FO", "CSV", "/NH"], { windowsHide: true });
    const m = /^"([^"]+)"/.exec(list.out.trim());
    return { pid: n, command, image: m ? m[1] : "" };
  }
  const ps = await exec("ps", ["-o", "command=", "-p", String(n)], { windowsHide: true });
  const comm = await exec("ps", ["-o", "comm=", "-p", String(n)], { windowsHide: true });
  return { pid: n, command: ps.ok ? ps.out.trim() : "", image: comm.ok ? comm.out.trim() : "" };
}

// The evidence that this process is a panel of ours — `"server.js"` when the command line names it, `"node"`
// when the command line was refused but the image is node, and "" when it is somebody else's process. The empty
// answer is the one that must never be killed: a stranger on this port is named in the log, not stopped.
export function panelEvidence({ command = "", image = "", serverPath = "" } = {}) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\\/g, "/");
  const cmd = norm(command);
  if (cmd) {
    if (serverPath && cmd.includes(norm(serverPath))) return "server.js";
    return /(^|[/\s"'=])server\.js(\s|"|'|$)/.test(cmd) ? "server.js" : "";
  }
  const img = String(image || "").trim().toLowerCase();
  return img === "node.exe" || img === "node" ? "node (no command line to read)" : "";
}

// Stop one pid and wait for it to be gone. Windows takes the whole tree with `taskkill /T /F` — the right
// form for a stray helper — or (`tree: false`) the ONE pid, which is what the restart helper must use: that
// helper was SPAWNED BY the outgoing panel, so a /T kill of the panel takes the helper — and with it the
// replacement launch — down as well (proven twice on 2026-11-09; it fires exactly when a loaded panel
// outlives the helper's 20 s window). Elsewhere a polite TERM first, then KILL. "It was already gone" is
// the outcome we wanted, not a failure.
export async function stopPid(pid, { platform = process.platform, timeoutMs = 6000, exec = run, tree = true } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, how: "no pid" };
  if (!pidAlive(n)) return { ok: true, how: "already gone" };
  if (platform === "win32") {
    const args = tree ? ["/PID", String(n), "/T", "/F"] : ["/PID", String(n), "/F"];
    const out = await exec("taskkill", args, { windowsHide: true });
    if (out.ok) return { ok: true, how: tree ? "taskkill /T /F" : "taskkill /F" };
    if (!pidAlive(n)) return { ok: true, how: "gone before the kill" };
    return { ok: false, how: `taskkill failed: ${out.error || out.stderr || "unknown"}` };
  }
  try {
    process.kill(n, "SIGTERM");
  } catch {
    /* no such process: the check below answers */
  }
  const until = Date.now() + Math.min(3000, timeoutMs);
  while (Date.now() < until) {
    if (!pidAlive(n)) return { ok: true, how: "SIGTERM" };
    await sleep(100);
  }
  try {
    process.kill(n, "SIGKILL");
  } catch {
    /* gone between the loop and the kill */
  }
  const hard = Date.now() + Math.max(0, timeoutMs - 3000);
  while (Date.now() < hard) {
    if (!pidAlive(n)) return { ok: true, how: "SIGKILL", forced: true };
    await sleep(100);
  }
  return { ok: false, how: `pid ${n} is still running after SIGKILL` };
}

// Poll until the pid is gone, or the wait runs out. `alive` is injectable so the wait can be tested without
// processes. The default is the panel's flush window, not a blind 20 s: nothing in this repo waits that long for a
// pid any more, and a helper asking this question has already decided there is something worth flushing.
export async function waitForPidGone(pid, { timeoutMs = 2000, stepMs = 200, alive = pidAlive } = {}) {
  if (!pid) return true;
  const until = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() >= until) return false;
    await sleep(stepMs);
  }
}

// Wait for anything to answer on the port — the replacement proving it took it. Returns the host that answered,
// or null. The child's own liveness is the caller's business: a slow boot is not a failure, a dead pid is.
export async function waitForAnswer(port, { host = "127.0.0.1", timeoutMs = 20_000, stepMs = 200, probe = portAnswers } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0) return null;
  const hosts = probeHosts(host);
  const until = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    for (const h of hosts) if (await probe(h, n)) return h;
    if (Date.now() >= until) return null;
    await sleep(stepMs);
  }
}

// Make the port bindable before the replacement starts: stop every LISTENING pid that reads as a panel of ours,
// and leave everybody else alone. Idempotent — a port nothing answers on returns `freed` without running a
// command at all, which is the normal path (the outgoing panel has just exited). `tree` is the form of the stop:
// a restart's helper passes false, because it is a CHILD of the outgoing panel and a /T kill would take the helper
// (and the launch it has not done yet) with it.
export async function releasePort({
  port,
  host = "127.0.0.1",
  serverPath = "",
  waitMs = 10_000,
  stepMs = 200,
  tree = true,
  onLog = () => {},
  platform = process.platform,
  exec = run,
  probe = portAnswers,
  pids = listeningPids,
  info = processInfo,
  stop = stopPid,
  alive = pidAlive,
} = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0) return { freed: true, killed: [], holders: [] };
  const hosts = probeHosts(host);
  const answeredOn = async () => {
    for (const h of hosts) if (await probe(h, n)) return h;
    return null;
  };
  const killed = [];
  const dying = new Set();
  const started = Date.now();
  const deadline = started + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    const on = await answeredOn();
    if (!on) return { freed: true, killed, holders: [] };
    // The lookup is made for the address the probe REACHED, so a socket bound to a wildcard (0.0.0.0, [::]) is
    // named as the holder of a 127.0.0.1 answer, and a socket on an address the probe never touched is not.
    const holders = await pids(n, { platform, exec, host: on });
    if (!holders.length) {
      // Something answers on the address we probed and nothing reports as LISTENING on it. This used to give up
      // here, and the helper then printed "still not free" in the same second it had printed "answers on ..." -
      // a report that contradicts itself. A socket outliving its pid (a panel mid-exit, a handler the OS has not
      // reaped) is the ordinary cause, so the answer is waited out inside the caller's window: the port is free
      // if the answer stops, and only the deadline says it did not.
      if (Date.now() >= deadline) {
        onLog(`port ${n} answered on ${on} but no process reports as LISTENING on it ${Math.round((Date.now() - started) / 1000)}s after the release began - left alone`);
        return { freed: false, killed, holders: [] };
      }
      await sleep(stepMs);
      continue;
    }
    let acted = false;
    let waiting = false;
    for (const pid of holders) {
      if (pid === process.pid) continue;
      // A pid that is already gone cannot be identified and is not a stranger worth protecting: what answers is
      // its socket on the way out. That is the ordinary state a moment after the outgoing panel was stopped, and
      // asking powershell about a dead pid is a multi-second detour for an answer that cannot exist.
      if (!alive(pid)) {
        if (!dying.has(pid)) {
          dying.add(pid);
          onLog(`port ${n} answers on ${on} and pid ${pid} is no longer running - its socket outlived it; waiting for it to close`);
        }
        waiting = true;
        continue;
      }
      const seen = await info(pid, { platform, exec });
      const why = panelEvidence({ ...seen, serverPath });
      if (!why) {
        onLog(`port ${n} is held by pid ${pid} (${seen.image || seen.command || "unknown"}), which does not read as this panel — left alone`);
        continue;
      }
      const out = await stop(pid, { platform, exec, tree });
      onLog(out.ok
        ? `port ${n}: stopped pid ${pid} (${why}) — ${out.how}`
        : `port ${n}: could not stop pid ${pid} (${why}) — ${out.how}`);
      if (out.ok) {
        killed.push(pid);
        acted = true;
      }
    }
    if (!acted && waiting) {
      if (Date.now() >= deadline) {
        onLog(`port ${n} still answers on ${on} ${Math.round((Date.now() - started) / 1000)}s after the release began - the socket of pid ${[...dying].join(", ")} did not close in time`);
        return { freed: false, killed, holders };
      }
      await sleep(stepMs);
      continue;
    }
    if (!acted) return { freed: false, killed, holders };
    if (Date.now() >= deadline) return { freed: Boolean(!(await answeredOn())), killed, holders };
    await sleep(stepMs);
  }
}
