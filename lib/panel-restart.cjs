// The detached helper a panel restart leaves behind.
//
// The panel cannot spawn its own replacement and then exit: the replacement would try to bind the port the
// outgoing process is still holding, and the restart would leave the board down. So the panel starts THIS
// process detached instead, and it makes the port bindable before it launches server.js:
//
//   1. the outgoing panel is given a SHORT flush window, and only when it ASKED to exit (the `graceful` word in
//      argv, which the panel passes because it calls its own shutdown right after spawning this helper). Sessions
//      live in the Hermes gateway and re-attach to the replacement, so the wait protects nothing but the panel's
//      own JSON stores: 2 s by default, not 20. A pid nobody asked to exit is not waited for at all - the port is
//      taken at once, which is what the measured bounce at 04:30:43Z needed (20 s of blind waiting, then a kill);
//   2. it stops any OTHER process still LISTENING on the port that reads as this panel (a stray `server.js` from
//      an earlier bounce). A holder that does not read as a panel is named in the log and left alone
//      (lib/port-holder.js has the rule, and lib/port-guard.js the incident);
//   3. it launches server.js, writes its pid into the pid file, and waits for the port to answer - logging
//      either "serving on port N" or the failure by name, because a replacement that died on EADDRINUSE used to
//      leave no line anywhere in the panel's log at all.
//
//   node lib/panel-restart.cjs <server.js> <server.pid> <out.log> <err.log> <parentPid> [port] [host] [graceful]
//
// A supervisor captures the replacement's pipes and writes the actual panel pid into the usual pid file.
"use strict";
const { launchSupervisor, validatePaths, acquire, RotatingPanelLog } = require("./panel-log.cjs");

const [serverPath, pidFile, outLog, errLog, parentPidArg, portArg, hostArg, gracefulArg] = process.argv.slice(2);
const parentPid = Number(parentPidArg) || 0;
const port = Number(portArg || process.env.PANEL_PORT) || 0;
const host = String(hostArg || process.env.PANEL_HOST || "127.0.0.1");
// Did the outgoing panel ASK to exit? Only lib/restart.js says yes, and only because it calls `shutdown` right
// after spawning this helper. Anything else that starts a helper - a hand run, a supervisor, a stray - takes the
// port at once, because a pid nobody asked to leave is not one to sit waiting on.
const graceful = /^(1|true|yes|graceful|shutdown)$/i.test(String(gracefulArg ?? "").trim());
// The flush window a graceful shutdown gets: the panel closes its listener and exits (its own ceiling in
// server.js `shutdown` is 2 s), and what the next boot still needs is the JSON stores, not the socket. Also the
// window the port guard gets to see a dying socket let go, and env-overridable for a machine that needs more.
const flushMs = Number(process.env.HERMES_PANEL_RESTART_WAIT_MS) || 2_000;
const bindMaxMs = Number(process.env.HERMES_PANEL_RESTART_BIND_MS) || 20_000;

// The helper's own lines go where the replacement's output goes: a restart that goes wrong has to be readable in
// the panel's log, and `stdio: "ignore"` on this process (lib/restart.js) leaves it no console of its own.
const notes = [];
const say = (text) => {
  const line = `${new Date().toISOString().slice(11, 19)} panel-restart: ${text}\n`;
  notes.push(line);
  try {
    process.stdout.write(line);
  } catch {
    /* no console */
  }
};

let supervisor;
async function done(code) {
  let persisted = false;
  if (supervisor?.connected) {
    persisted = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      supervisor.once("message", (msg) => { clearTimeout(timer); resolve(Boolean(msg?.logged)); });
      supervisor.send({ log: notes.join("") }, (e) => { if (e) { clearTimeout(timer); resolve(false); } });
    });
    if (supervisor.connected) supervisor.disconnect();
  }
  if (!persisted) {
    try {
      const dir = validatePaths(pidFile, outLog, errLog);
      const release = await acquire(dir);
      try { new RotatingPanelLog(dir).write("out", notes.join("")); } finally { release(); }
    } catch (e) {
      try { process.stderr.write(`panel-restart: could not persist diagnostics: ${e.message}\n`); } catch { /* no console */ }
    }
  }
  process.exit(code);
}

async function main() {
  // The module that asks who holds the port is ESM, like the rest of lib/: this helper is CommonJS because it is
  // spawned as a plain script, so it loads the rule rather than restating it.
  const holder = await import("./port-holder.js");

  // Is the pid that spawned this helper the thing holding the port? netstat answers that in milliseconds, and a
  // pid LISTENING on this panel's port is this panel - the cheap evidence comes first, because asking powershell
  // what a pid is can cost seconds and this helper is on the clock.
  const parentHoldsPort = async () => {
    if (!port || !holder.pidAlive(parentPid)) return false;
    return (await holder.listeningPids(port)).includes(Number(parentPid));
  };

  // ---- 1. the panel that asked for the bounce ------------------------------------------------------------
  if (parentPid) {
    if (!graceful) {
      // Nobody asked this pid to exit, so there is nothing to flush. The wait here used to run the full window
      // anyway: 20 s blind, protecting only stores the replacement re-reads as it boots. Take the port instead.
      const listening = await parentHoldsPort();
      if (listening) {
        // ONE pid, never the tree (`tree: false`): this helper is a child of that panel, and a /T kill
        // would take the helper - and the replacement launch - down with it (lib/port-holder.js has the rule).
        const out = await holder.stopPid(parentPid, { tree: false });
        say(out.ok
          ? `pid ${parentPid} held port ${port} and no graceful shutdown was asked for - took the port at once (${out.how})`
          : `pid ${parentPid} held port ${port} and no graceful shutdown was asked for, and it could NOT be stopped (${out.how})`);
      } else if (holder.pidAlive(parentPid)) {
        say(`pid ${parentPid} is still running and no graceful shutdown was asked for - not waiting for it; the port guard below decides what holds port ${port}`);
      }
    } else {
      const gone = await holder.waitForPidGone(parentPid, { timeoutMs: flushMs, stepMs: 100 });
      if (!gone) {
        // The flush window is spent. Whether it holds the port is a fresh question: a panel that closed its
        // listener and then wedged in a store write is still gone from the port, and that is cheap to see.
        const listening = await parentHoldsPort();
        const seen = listening ? { command: "", image: "" } : await holder.processInfo(parentPid);
        const why = listening ? `server.js (it holds port ${port})` : holder.panelEvidence({ ...seen, serverPath });
        if (why) {
          const out = await holder.stopPid(parentPid, { tree: false });
          say(out.ok
            ? `the outgoing panel (pid ${parentPid}) was still running ${Math.round(flushMs / 1000)}s after the restart was asked for - stopped it (${out.how})`
            : `the outgoing panel (pid ${parentPid}) was still running after ${Math.round(flushMs / 1000)}s and could NOT be stopped (${out.how})`);
        } else {
          say(`pid ${parentPid} is still running but does not read as a panel (${seen.image || "no command line to read"}) - not killing it`);
        }
      }
    }
  }

  // ---- 2. anything else on the port ----------------------------------------------------------------------
  if (port) {
    // The same short window, and one pid per stop: this helper is a child of the outgoing panel, so a tree kill
    // here can take the helper (and the launch it has not done yet) with it.
    const released = await holder.releasePort({ port, host, serverPath, waitMs: flushMs, tree: false, onLog: say });
    if (!released.freed) {
      say(`port ${port} is still not free - starting anyway; a boot that cannot bind names the holder in its refusal`);
    }
  }

  // ---- 3. the replacement ---------------------------------------------------------------------------------
  const launched = await launchSupervisor(serverPath, pidFile, outLog, errLog);
  supervisor = launched.supervisor;
  const child = { pid: launched.pid };
  say(`launched ${serverPath} as pid ${child.pid}${port ? ` for port ${port}` : ""}`);

  // ---- 4. did it take the port? ---------------------------------------------------------------------------
  if (!port) return done(0);
  const answered = await holder.waitForAnswer(port, { host, timeoutMs: bindMaxMs });
  if (answered) {
    say(`pid ${child.pid} is serving on ${answered}:${port}`);
    return done(0);
  }
  if (!holder.pidAlive(child.pid)) {
    say(`pid ${child.pid} exited before it bound port ${port} - the previous listener is still serving; see ${errLog}`);
    return done(1);
  }
  say(`pid ${child.pid} is still starting after ${Math.round(bindMaxMs / 1000)}s and has not bound port ${port} yet`);
  return done(0);
}

main().catch((e) => {
  say(`failed: ${String((e && e.message) || e)}`);
  done(1);
});
