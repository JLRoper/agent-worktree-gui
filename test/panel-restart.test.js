// A restart replaces the listener. It does not leave the old build serving.
//
// The helper a panel restart leaves behind (lib/panel-restart.cjs) waits for the outgoing pid and then starts
// server.js. It used to stop there: the wait had a 60 s escape hatch that launched straight into the port the
// outgoing panel was still holding, and nothing looked at who else was LISTENING on it, so a stray `server.js`
// from an earlier bounce kept the port and the replacement died on EADDRINUSE — with no line in the panel's log
// saying so, and the old build still answering the reader's browser. lib/port-holder.js is the rule the helper
// now asks first, and these are the proofs:
//
//   * the outgoing panel is stopped when it will not leave, and the replacement serves the port afterwards;
//   * a stray server.js is stopped even though the pid the helper was told to wait for is already gone;
//   * a port nothing holds is the quiet path — launch, no kill, and the replacement answers;
//   * a holder that does not read as this panel is left alone, by the unit that decides it.
//
// The end-to-end cases boot the REAL server.js on both sides, so the assertion is about a listener a browser
// would reach (the pid in `netstat` and `/api/health`), not about the text of a function.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  listeningPids,
  listeningPidsFromNetstat,
  panelEvidence,
  pidAlive,
  releasePort,
  stopPid,
  waitForPidGone,
} from "../lib/port-holder.js";
import { startPanel, readSource, waitFor } from "../tools/panel-testkit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The one switch a failing-first proof needs: point this at an older lib/panel-restart.cjs (extracted with
// `git show <sha>:lib/panel-restart.cjs`) and the three cases below fail the way the bug did.
const HELPER = process.env.PANEL_RESTART_HELPER || path.join(ROOT, "lib", "panel-restart.cjs");
const SERVER = path.join(ROOT, "server.js");

// ---- the helper, driven the way lib/restart.js drives it -----------------------------------------------

function runHelper({ parentPid, port, dir, env = {} }) {
  const logs = path.join(dir, "logs");
  const pidFile = path.join(logs, "server.pid");
  const out = [];
  const child = spawn(
    process.execPath,
    [HELPER, SERVER, pidFile, path.join(logs, "server.out.log"), path.join(logs, "server.err.log"), String(parentPid), String(port), "127.0.0.1"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PANEL_CONFIG: path.join(dir, "config.json"),
        HERMES_HOME: path.join(dir, "hermes"),
        // A sandbox must never reach the developer's own gateway, and its boot must not wait the production
        // five seconds for a port it is only just about to be given.
        API_SERVER_KEY: "",
        PANEL_PORT_WAIT_MS: "6000",
        // The waits this test is about: the outgoing panel is given 1.2 s to leave, the replacement 15 s to bind.
        HERMES_PANEL_RESTART_WAIT_MS: "1200",
        HERMES_PANEL_RESTART_BIND_MS: "15000",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, pidFile, out: () => out.join(""), exited };
}

// The pid the helper was told to wait for, after it is gone: a process that ran and exited, as the outgoing panel
// of a completed restart does.
async function gonePid() {
  const child = spawn(process.execPath, ["-e", "0"], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid;
}

const pidIn = (file) => {
  try {
    return Number(readFileSync(file, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
};

// The pid netstat names as the port's listener, once exactly one process answers there. The helper exits only
// after it has seen the port answer, so this is a read of the outcome, not another wait.
async function listenerPids(port) {
  const pids = await listeningPids(port);
  return pids.filter((p) => pidAlive(p));
}

// ---- the three restarts ------------------------------------------------------------------------------

test("a restart stops the panel still holding the port, and the replacement serves it", async () => {
  const old = await startPanel({ keep: true });
  const helper = runHelper({ parentPid: old.pid, port: old.port, dir: old.dir });
  let replacement = 0;
  try {
    await helper.exited;
    replacement = pidIn(helper.pidFile);

    assert.equal(pidAlive(old.pid), false, `the outgoing panel (pid ${old.pid}) was stopped, not left holding ${old.port}`);
    assert.ok(replacement > 0, "the pid file names the replacement");
    assert.notEqual(replacement, old.pid, "the replacement is a new process, not the one that was serving");
    assert.equal(pidAlive(replacement), true, "the replacement is running");
    assert.equal((await fetch(`${old.base}/api/health`)).ok, true, "the port answers again");
    assert.deepEqual(await listenerPids(old.port), [replacement], "the replacement is the only listener on the port");
    assert.match(helper.out(), /still running 1s after the restart was asked for — stopped it/, "and the log says the old pid was stopped");
    assert.match(helper.out(), new RegExp(`pid ${replacement} is serving on 127\\.0\\.0\\.1:${old.port}`), "and that the replacement took the port");
  } finally {
    if (replacement) await stopPid(replacement);
    await old.stop();
  }
});

test("a stray server.js on the port is stopped even when the pid the helper waited for is already gone", async () => {
  const stray = await startPanel({ keep: true });
  const dead = await gonePid();
  const helper = runHelper({ parentPid: dead, port: stray.port, dir: stray.dir });
  let replacement = 0;
  try {
    await helper.exited;
    replacement = pidIn(helper.pidFile);

    assert.equal(pidAlive(stray.pid), false, `the stray panel (pid ${stray.pid}) was stopped`);
    assert.ok(replacement > 0 && replacement !== stray.pid, "the replacement is a new pid");
    assert.equal(pidAlive(replacement), true, "the replacement is running");
    assert.equal((await fetch(`${stray.base}/api/health`)).ok, true, "the port answers again");
    assert.deepEqual(await listenerPids(stray.port), [replacement], "the stray is not listening any more — only the replacement is");
    assert.match(helper.out(), new RegExp(`port ${stray.port}: stopped pid ${stray.pid} \\(server\\.js\\)`), "and the log names the stray it stopped");
  } finally {
    if (replacement) await stopPid(replacement);
    await stray.stop();
  }
});

test("a port nothing holds is the quiet path: no kill, and the replacement answers", async () => {
  const panel = await startPanel({ keep: true });
  const { port, pid, dir, base } = panel;
  // The panel exits normally, as the one that asked for the bounce does; the helper is then started with its
  // pid, exactly as the restart would.
  await panel.stop();
  const helper = runHelper({ parentPid: pid, port, dir });
  let replacement = 0;
  try {
    const code = await helper.exited;
    replacement = pidIn(helper.pidFile);

    assert.equal(code, 0, "the helper finished cleanly");
    assert.ok(replacement > 0 && replacement !== pid, "the pid file names a new process");
    // Waited for here, not taken from the helper: this case is the control, and whether the replacement answers
    // must not depend on how long the helper lingers after spawning it.
    assert.equal(await waitFor(async () => (await fetch(`${base}/api/health`)).ok, { timeoutMs: 20_000, what: "the replacement to answer" }), true, "the replacement answers on the port");
    assert.deepEqual(await listenerPids(port), [replacement], "and is the listener");
    assert.doesNotMatch(helper.out(), /stopped pid/, "nothing was there to stop");
  } finally {
    if (replacement) await stopPid(replacement);
    await panel.stop();
  }
});

// ---- the rule the helper asks, pinned without a process ------------------------------------------------

test("netstat rows name the listener for the port asked about, and no other", () => {
  const rows = [
    "  TCP    0.0.0.0:7331           0.0.0.0:0              LISTENING       48564",
    "  TCP    127.0.0.1:7331         127.0.0.1:52048        ESTABLISHED     48564",
    "  TCP    [::1]:7331             [::]:0                 LISTENING       48564",
    "  TCP    127.0.0.1:73310        0.0.0.0:0              LISTENING       111",
    "  TCP    10.0.0.5:22            0.0.0.0:0              LISTENING       222",
  ].join("\r\n");
  assert.deepEqual(listeningPidsFromNetstat(rows, 7331), [48564], "one pid, once, from the IPv4 and IPv6 rows");
  assert.deepEqual(listeningPidsFromNetstat(rows, 73310), [111], "73310 is not 7331");
  assert.deepEqual(listeningPidsFromNetstat(rows, 9999), []);
});

test("only a process that reads as this panel is ours to stop", () => {
  // The command lines are shaped, not copied: one Windows-shaped with a quoted exe and backslashes, one POSIX,
  // and the near-misses. No drive letter appears in any of them — a landing may not name a folder that exists on
  // the machine that wrote it, and the rule being pinned is about the shape of the command line anyway.
  assert.equal(panelEvidence({ command: '"nodejs\\node.exe" "srv\\repo\\server.js"' }), "server.js");
  assert.equal(panelEvidence({ command: "node server.js", image: "node.exe" }), "server.js");
  assert.equal(panelEvidence({ command: '"node" "srv/repo/server.js" --quiet', serverPath: "srv/repo/server.js" }), "server.js");
  assert.equal(panelEvidence({ command: '"node" "srv/elsewhere/other-listener.js"', image: "node.exe" }), "", "another script on the port is not ours");
  assert.equal(panelEvidence({ command: '"python.exe" "srv/tools/serve.py"' }), "");
  assert.equal(panelEvidence({ image: "node.exe" }), "node (no command line to read)", "a node we cannot read is still a panel on this port");
  assert.equal(panelEvidence({ image: "chrome.exe" }), "");
  assert.equal(panelEvidence({}), "");
});

test("releasePort stops a server.js holder, and leaves a stranger alone", async () => {
  const log = [];
  const killed = [];
  let answering = true;
  const out = await releasePort({
    port: 7331,
    waitMs: 500,
    stepMs: 5,
    probe: async () => answering,
    pids: async () => [11],
    info: async (pid) => ({ pid, command: "node srv/repo/server.js", image: "node.exe" }),
    stop: async (pid) => {
      killed.push(pid);
      answering = false;
      return { ok: true, how: "stub kill" };
    },
    onLog: (l) => log.push(l),
  });
  assert.deepEqual(killed, [11], "the holder was stopped");
  assert.equal(out.freed, true, "and the port came free");
  assert.deepEqual(out.killed, [11]);
  assert.match(log.join("\n"), /port 7331: stopped pid 11 \(server\.js\)/);

  const strangerLog = [];
  const refused = await releasePort({
    port: 7331,
    waitMs: 100,
    stepMs: 5,
    probe: async () => true,
    pids: async () => [22],
    info: async (pid) => ({ pid, command: '"node" "srv/elsewhere/other-listener.js"', image: "node.exe" }),
    stop: async () => {
      throw new Error("releasePort must never stop a process that does not read as this panel");
    },
    onLog: (l) => strangerLog.push(l),
  });
  assert.equal(refused.freed, false);
  assert.deepEqual(refused.killed, []);
  assert.match(strangerLog.join("\n"), /does not read as this panel — left alone/);

  let asked = 0;
  const quiet = await releasePort({
    port: 7331,
    probe: async () => {
      asked += 1;
      return false;
    },
    pids: async () => {
      throw new Error("a port nothing answers on never asks who holds it");
    },
  });
  assert.equal(quiet.freed, true);
  assert.equal(asked, 1, "one probe, no netstat, no kill");
});

test("the wait for a pid that will not leave is bounded, and says so", async () => {
  const t0 = Date.now();
  const gone = await waitForPidGone(424242, { timeoutMs: 150, stepMs: 20, alive: () => true });
  assert.equal(gone, false, "a pid that never leaves is reported as still there");
  assert.ok(Date.now() - t0 >= 140, "after the wait, not at once");
  assert.equal(await waitForPidGone(424242, { timeoutMs: 150, alive: () => false }), true);
});

// The controller is the one link these three cases do not drive (a panel bounce exits the process that would be
// doing the asserting). The helper's argv is the contract between them, and losing the port there would silently
// turn the freeing step back off, so it is pinned.
test("the controller tells the helper the outgoing pid and the port to free", () => {
  const src = readSource("lib/restart.js");
  const call = /panel-restart\.cjs[\s\S]{0,700}?String\(this\.config\.port/.exec(src);
  assert.ok(call, "the spawn of lib/panel-restart.cjs carries the parent pid and this panel's port");
});
