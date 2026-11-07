// The detached helper a panel restart leaves behind.
//
// The panel cannot spawn its own replacement and then exit: the replacement would try to bind the port the
// outgoing process is still holding, and the restart would leave the board down. So the panel starts THIS
// process detached instead, and it makes the port bindable before it launches server.js:
//
//   1. it waits for the outgoing panel (the pid that spawned it) to disappear, and stops that pid itself when it
//      is still there after `HERMES_PANEL_RESTART_WAIT_MS` — a panel that asked to be bounced and then hung in
//      shutdown is not something the replacement can wait out;
//   2. it stops any OTHER process still LISTENING on the port that reads as this panel (a stray `server.js` from
//      an earlier bounce). A holder that does not read as a panel is named in the log and left alone
//      (lib/port-holder.js has the rule, and lib/port-guard.js the incident);
//   3. it launches server.js, writes its pid into the pid file, and waits for the port to answer — logging
//      either "serving on port N" or the failure by name, because a replacement that died on EADDRINUSE used to
//      leave no line anywhere in the panel's log at all.
//
//   node lib/panel-restart.cjs <server.js> <server.pid> <out.log> <err.log> <parentPid> [port] [host]
//
// It writes the new process's pid into the pid file (the same file start-background.cmd and
// stop-background.cmd use), appends the replacement's output AND its own lines to the panel's own log, and exits.
"use strict";
const { spawn } = require("node:child_process");
const { appendFileSync, mkdirSync, openSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const [serverPath, pidFile, outLog, errLog, parentPidArg, portArg, hostArg] = process.argv.slice(2);
const parentPid = Number(parentPidArg) || 0;
const port = Number(portArg || process.env.PANEL_PORT) || 0;
const host = String(hostArg || process.env.PANEL_HOST || "127.0.0.1");
// How long the outgoing panel is given to leave on its own, and how long the replacement is given to take the
// port. Both are escape hatches: the first is followed by a kill, the second by a line saying what happened.
const waitMaxMs = Number(process.env.HERMES_PANEL_RESTART_WAIT_MS) || 20_000;
const bindMaxMs = Number(process.env.HERMES_PANEL_RESTART_BIND_MS) || 20_000;

// The helper's own lines go where the replacement's output goes: a restart that goes wrong has to be readable in
// the panel's log, and `stdio: "ignore"` on this process (lib/restart.js) leaves it no console of its own.
const say = (text) => {
  const line = `${new Date().toISOString().slice(11, 19)} panel-restart: ${text}\n`;
  try {
    appendFileSync(outLog, line);
  } catch {
    /* the log is a convenience, not a reason to fail a restart */
  }
  try {
    process.stdout.write(line);
  } catch {
    /* no console */
  }
};

const launch = () => {
  const root = path.dirname(path.resolve(serverPath));
  mkdirSync(path.dirname(outLog), { recursive: true });
  const out = openSync(outLog, "a");
  const err = openSync(errLog, "a");
  const env = { ...process.env };
  // A detached replacement has no stdin to watch. A panel booted by the testkit carries "exit when my stdin
  // closes", and inheriting that would take the replacement down the moment it started — so it stops here.
  delete env.PANEL_PARENT_WATCH_STDIN;
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, err],
    env,
  });
  child.unref();
  try {
    writeFileSync(pidFile, String(child.pid));
  } catch {
    /* the pid file is a convenience for the stop script */
  }
  return child;
};

async function main() {
  // The module that asks who holds the port is ESM, like the rest of lib/: this helper is CommonJS because it is
  // spawned as a plain script, so it loads the rule rather than restating it.
  const holder = await import("./port-holder.js");

  // ---- 1. the panel that asked for the bounce ------------------------------------------------------------
  if (parentPid) {
    const gone = await holder.waitForPidGone(parentPid, { timeoutMs: waitMaxMs, stepMs: 200 });
    if (!gone) {
      const seen = await holder.processInfo(parentPid);
      const why = holder.panelEvidence({ ...seen, serverPath });
      if (why) {
        const out = await holder.stopPid(parentPid);
        say(out.ok
          ? `the outgoing panel (pid ${parentPid}) was still running ${Math.round(waitMaxMs / 1000)}s after the restart was asked for — stopped it (${out.how})`
          : `the outgoing panel (pid ${parentPid}) was still running after ${Math.round(waitMaxMs / 1000)}s and could NOT be stopped (${out.how})`);
      } else {
        say(`pid ${parentPid} is still running but does not read as a panel (${seen.image || "no command line to read"}) — not killing it`);
      }
    }
  }

  // ---- 2. anything else on the port ----------------------------------------------------------------------
  if (port) {
    const released = await holder.releasePort({ port, host, serverPath, onLog: say });
    if (!released.freed) {
      say(`port ${port} is still not free — starting anyway; a boot that cannot bind names the holder in its refusal`);
    }
  }

  // ---- 3. the replacement ---------------------------------------------------------------------------------
  const child = launch();
  say(`launched ${serverPath} as pid ${child.pid}${port ? ` for port ${port}` : ""}`);

  // ---- 4. did it take the port? ---------------------------------------------------------------------------
  if (!port) return process.exit(0);
  const answered = await holder.waitForAnswer(port, { host, timeoutMs: bindMaxMs });
  if (answered) {
    say(`pid ${child.pid} is serving on ${answered}:${port}`);
    return process.exit(0);
  }
  if (!holder.pidAlive(child.pid)) {
    say(`pid ${child.pid} exited before it bound port ${port} — the previous listener is still serving; see ${errLog}`);
    return process.exit(1);
  }
  say(`pid ${child.pid} is still starting after ${Math.round(bindMaxMs / 1000)}s and has not bound port ${port} yet`);
  process.exit(0);
}

main().catch((e) => {
  say(`failed: ${String((e && e.message) || e)}`);
  process.exit(1);
});
