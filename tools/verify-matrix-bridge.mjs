#!/usr/bin/env node
// verify-matrix-bridge.mjs — the Gateway tab's Matrix bridge, driven end to end against a FAKE bridge.
//
// WHAT THIS PROVES, and why each one needs a booted panel rather than a read of the source:
//
//   1. THE PANEL OWNS A PROCESS. POST …/matrix/start spawns the configured interpreter and script detached, with
//      stdout+stderr going to the panel's own log, and records the pid. The fake prints `Bridge live.` and sleeps,
//      so "running" is a real live child that GET reports — not a flag a route wrote.
//   2. A SECOND START IS A 409. While that pid is alive the route refuses, and the refusal names it.
//   3. STOP REALLY STOPS IT. POST …/matrix/stop answers `running: false`, the pid is gone from the OS's point of
//      view, and the pid file has been cleared — so the next start is not answered by a leftover record.
//   4. A STALE PID FILE IS NOT A RUNNING BRIDGE. A pid file naming a process that has exited reads as
//      `running: false` with `stalePid` naming it, and it does NOT block the next start. A record outliving its
//      process (a crash, a reboot) is the ordinary case this rule exists for.
//   5. NO SECRET REACHES THE PANEL. A bridge.env holding a sentinel password sits beside the fake script;
//      `credentialsPresent` is true and NO answer — GET, start, stop, test, refusal — carries the sentinel. The
//      panel never opens that file, and this is the measurement, not the promise.
//   6. THE SELF-TEST'S EXIT CODE IS THE ANSWER. `--self-test` on the fake passes (0) and fails (3) on demand, and
//      both the output and the code come back. A GET never runs one: the first read says `ok: null`.
//   7. NOTHING STARTS AT BOOT. The sandbox is read twice before any press, and no pid file and no log exist.
//   8. THE TAB'S CONTROLS AND THEIR RULES. The markup carries the dot, the room, the read-only paths and the three
//      presses, each with a title; the page's bridge block adds no timer of its own (it rides the existing 30 s
//      clock) and Start's reason travels in the title the page paints.
//
// THE REAL BRIDGE IS NEVER LAUNCHED: every path here is the fake in a temp directory, `pythonPath` is this Node
// binary, and the temp directory is removed at the end. No Matrix account, no bridge.env of the reader's, no login.
//
//   npm run verify:matrix-bridge
// HARNESS: LIVE GATE
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createVerifier, post, ROOT, startPanel, waitFor } from "./panel-testkit.mjs";

const SENTINEL = "sentinel-password-2f7a19-never-in-an-answer";
const ROOM = "!verify-room:matrix.example.invalid";

// The fake bridge: the smallest program with the real one's CONTRACT. `--self-test` prints a readable block and
// exits 0 (or 3 when a marker file asks for it); a normal run prints `Bridge live.` once and sleeps until a
// signal, which is what makes "running" and "stopped" measurable rather than assumed.
const FAKE = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.includes("--self-test")) {
  console.log("fake matrix bridge — self-test");
  console.log("  config: ok (room " + (process.env.MATRIX_ROOM_ID || "unset") + ")");
  console.log("  matrix-nio: ok (not imported by the fake)");
  if (existsSync(path.join(here, "self-test-fail"))) {
    console.error("  self-test: the fake was told to fail");
    process.exit(3);
  }
  process.exit(0);
}
console.log("Bridge live.");
const bye = () => process.exit(0);
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
setInterval(() => {}, 1000);
`;

const v = createVerifier();
const dir = await mkdtemp(path.join(os.tmpdir(), "wag-verify-matrix-"));
const scriptPath = path.join(dir, "fake-bridge.mjs");
// The interpreter is THIS Node binary: the panel spawns `pythonPath scriptPath`, and the point of the harness is the
// panel's process handling, not a Python install on the machine running it.
const pythonPath = process.execPath;
const envFile = path.join(dir, "bridge.env");
let panel = null;

const json = async (route) => {
  const r = await fetch(`${panel.base}${route}`);
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text) };
};
const answers = [];
// The whole envelope ({ status, text, json }), not just the body: the status of a refusal is half of what a route
// promises, and a caller that only kept the body could not assert a 409.
const record = (name, out) => {
  answers.push([name, out.text]);
  return out;
};
// A pid that is certainly dead: spawn a trivial child, let it exit, and keep its number. A recycled pid would make
// the "stale" reading ambiguous, so the test says which pid it used.
function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
    const pid = child.pid;
    child.once("exit", () => resolve(pid));
    child.once("error", reject);
  });
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

try {
  await writeFile(scriptPath, FAKE, "utf8");
  await writeFile(envFile, `MATRIX_HOMESERVER=https://matrix.example.invalid\nMATRIX_USERNAME=@fake:matrix.example.invalid\nMATRIX_PASSWORD=${SENTINEL}\nMATRIX_ROOM_ID=${ROOM}\n`, "utf8");

  panel = await startPanel({
    dir,
    token: "verify-matrix-token",
    config: { matrix: { scriptPath, pythonPath, roomId: ROOM } },
  });
  const token = "verify-matrix-token";
  const pidFile = path.join(dir, "logs", "matrix-bridge.pid");
  const logFile = path.join(dir, "logs", "matrix-bridge.log");

  // ---- 7. nothing starts at boot -------------------------------------------------------------------------
  const first = record("GET before any press", await json("/api/settings/matrix"));
  v.ok("GET /api/settings/matrix answers", first.status === 200, `status ${first.status}`);
  v.check("nothing is running at boot", first.json.running, false);
  v.check("and no pid is reported", first.json.pid, null);
  v.ok("no pid file was written at boot", !existsSync(pidFile), pidFile);
  v.ok("no log was written at boot", !existsSync(logFile), logFile);
  v.ok("the sandbox never auto-started the fake", !panel.log().includes("matrix bridge started"), panel.log().slice(-300));

  // ---- 5. the config block, and no secret in any answer ---------------------------------------------------
  v.check("the room id is the configured one", first.json.roomId, ROOM);
  v.check("the script path is the configured one", first.json.scriptPath, scriptPath);
  v.check("the interpreter is the configured one", first.json.pythonPath, pythonPath);
  v.ok("the script is reported present", first.json.scriptPresent === true);
  v.ok("the interpreter is reported present", first.json.pythonPresent === true);
  v.ok("credentialsPresent is true — bridge.env exists beside the script", first.json.credentialsPresent === true);
  v.ok("credentialsPresent is a boolean, not a value", typeof first.json.credentialsPresent === "boolean");
  v.check("the self-test has not been run by a GET", first.json.selfTest.ok, null);
  v.check("the log starts empty", first.json.log, []);
  v.ok("the pid file path is the panel's state dir, not the script's dir", String(first.json.pidFile).startsWith(path.join(dir, "logs")), String(first.json.pidFile));
  v.ok("the log path is the panel's state dir, not the script's dir", String(first.json.logFile).startsWith(path.join(dir, "logs")), String(first.json.logFile));
  v.ok("GET carries no password", !first.text.includes(SENTINEL));

  // ---- 1. start -> a live pid, and the bridge's own line in the log ---------------------------------------
  // The panel's own write rule allows a loopback request without the token (lib/http/transport.js: `authorised`
  // answers true for a request from this machine), so the harness does not pretend a 403 it would never get. The
  // token is sent anyway, which is what the page's `apiFetch` does.
  const started = record("POST start", await post(panel.base, "/api/settings/matrix/start", { token }));
  v.ok("POST …/start answers 200", started.status === 200, started.text.slice(0, 240));
  v.ok("the answer says it is running", started.json.running === true);
  v.ok("the answer carries the child's pid", Number.isInteger(started.json.pid) && started.json.pid > 0, String(started.json.pid));
  const childPid = started.json.pid;
  v.ok("that pid is a process the OS has", alive(childPid), String(childPid));
  const running = await waitFor(
    async () => {
      const now = await json("/api/settings/matrix");
      return now.json.running && now.json.log.some((line) => line.includes("Bridge live.")) ? now.json : false;
    },
    { timeoutMs: 20_000, what: "the fake bridge to say Bridge live. and be reported running" },
  );
  v.ok("GET reports running, with `Bridge live.` in the log", Boolean(running), running ? `${running.log.length} line(s)` : "timed out");
  const pidOnDisk = JSON.parse(await readFile(pidFile, "utf8").catch(() => "{}"));
  v.check("the pid file names the child", Number(pidOnDisk.pid), childPid);
  v.ok("the log file holds the same lines GET reports", readFileSafe(logFile).includes("Bridge live."), logFile);

  // ---- 2. a second start while that pid is alive is a 409 --------------------------------------------------
  const again = await post(panel.base, "/api/settings/matrix/start", { token });
  answers.push(["POST start (second)", again.text]);
  v.ok("a second start is refused with 409", again.status === 409, `status ${again.status}`);
  v.ok("the refusal names the pid it refused for", again.text.includes(String(childPid)), again.text.slice(0, 200));
  v.ok("the refusal does not start a second child", (panel.log().match(/matrix bridge started/g) || []).length === 1, panel.log().slice(-300));

  // ---- 6. the self-test: pass, then fail, and a GET keeps the last answer ----------------------------------
  const passed = await post(panel.base, "/api/settings/matrix/test", { token });
  answers.push(["POST test (pass)", passed.text]);
  v.ok("POST …/test answers 200", passed.status === 200, passed.text.slice(0, 240));
  v.ok("the self-test passed", passed.json.ok === true, String(passed.json.output || "").slice(0, 200));
  v.check("its exit code is 0", passed.json.exitCode, 0);
  v.ok("its output is the fake's own block", String(passed.json.output).includes("fake matrix bridge — self-test"), String(passed.json.output).slice(0, 200));
  v.ok("the pass is not a start", (panel.log().match(/matrix bridge started/g) || []).length === 1);
  const kept = record("GET after a self-test", await json("/api/settings/matrix"));
  v.ok("GET keeps the last self-test's answer", kept.json.selfTest.ok === true && String(kept.json.selfTest.output).includes("fake matrix bridge"), JSON.stringify(kept.json.selfTest).slice(0, 240));

  await writeFile(path.join(dir, "self-test-fail"), "fail please\n", "utf8");
  const failed = await post(panel.base, "/api/settings/matrix/test", { token });
  answers.push(["POST test (fail)", failed.text]);
  v.ok("a failing self-test answers with ok: false", failed.json.ok === false, failed.text.slice(0, 240));
  v.check("the failing exit code is reported", failed.json.exitCode, 3);
  v.ok("its stderr is in the output", String(failed.json.output).includes("the fake was told to fail"), String(failed.json.output).slice(0, 200));
  await rm(path.join(dir, "self-test-fail"), { force: true });

  // ---- 3. stop -> not running, and the pid is gone --------------------------------------------------------
  const stopped = record("POST stop", await post(panel.base, "/api/settings/matrix/stop", { token }));
  v.ok("POST …/stop answers 200", stopped.status === 200, stopped.text.slice(0, 240));
  v.check("the answer says running: false", stopped.json.running, false);
  v.ok("the answer says it stopped something", stopped.json.stopped === true, String(stopped.json.note || ""));
  const gone = await waitFor(() => !alive(childPid), { timeoutMs: 15_000, what: `pid ${childPid} to exit` });
  v.ok("the pid is gone from the OS's point of view", Boolean(gone), String(childPid));
  v.ok("the pid file was cleared by the stop", !existsSync(pidFile), pidFile);
  const afterStop = record("GET after stop", await json("/api/settings/matrix"));
  v.check("GET says not running", afterStop.json.running, false);
  v.check("and reports no pid", afterStop.json.pid, null);

  // A stop with nothing running is a sentence, never an error.
  const idleStop = await post(panel.base, "/api/settings/matrix/stop", { token });
  answers.push(["POST stop (nothing running)", idleStop.text]);
  v.ok("a stop with nothing running answers 200", idleStop.status === 200, `status ${idleStop.status}`);
  v.ok("it does not report an error", !idleStop.json.error, String(idleStop.json.error || ""));
  v.ok("it says nothing was running", /nothing was running|already gone/.test(String(idleStop.json.note || "")), String(idleStop.json.note || ""));

  // ---- 4. a stale pid file is not a running bridge, and does not block a start -----------------------------
  const stale = await deadPid();
  await writeFile(pidFile, `${JSON.stringify({ pid: stale, startedAt: new Date(0).toISOString(), scriptPath }, null, 2)}\n`, "utf8");
  const staleRead = record("GET with a stale pid file", await json("/api/settings/matrix"));
  v.check("a stale pid file is not running", staleRead.json.running, false);
  v.check("the stale pid is named as such", staleRead.json.stalePid, stale);
  v.check("and no live pid is reported", staleRead.json.pid, null);
  const restarted = await post(panel.base, "/api/settings/matrix/start", { token });
  answers.push(["POST start (after a stale pid)", restarted.text]);
  v.ok("a stale pid file does not block a start", restarted.status === 200 && restarted.json.running === true, restarted.text.slice(0, 240));
  v.ok("the new pid is not the stale one", restarted.json.pid !== stale, `${restarted.json.pid} vs ${stale}`);
  const restop = await post(panel.base, "/api/settings/matrix/stop", { token });
  v.ok("the restart is stopped again", restop.status === 200 && restop.json.running === false, restop.text.slice(0, 240));

  // ---- the log tail GET returns is bounded, and is lines --------------------------------------------------
  const tail = record("GET final", await json("/api/settings/matrix"));
  v.ok("the log is an array of lines", Array.isArray(tail.json.log));
  v.ok("the tail is at most 40 lines", tail.json.log.length <= 40, `${tail.json.log.length} lines`);

  // ---- 5 (continued). NO ANSWER, over the whole run, carried the sentinel ---------------------------------
  for (const [name, text] of answers) v.ok(`${name} carries no password`, !String(text).includes(SENTINEL));

  // ---- 8. the tab's controls, their titles, and the page's one-clock rule ---------------------------------
  const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  for (const id of ["matrix-row", "matrix-dot", "matrix-state", "matrix-room", "matrix-script", "matrix-preview", "matrix-log"]) {
    v.ok(`the Gateway tab carries #${id}`, html.includes(`id="${id}"`));
  }
  for (const id of ["btn-matrix-start", "btn-matrix-stop", "btn-matrix-test"]) {
    v.ok(`the tab carries #${id}, with a title`, new RegExp(`id="${id}"[^>]*title="[^"]{20,}"`).test(html));
  }
  const gateway = html.slice(html.indexOf('id="settings-panel-gateway"'), html.indexOf('id="settings-panel-skills"'));
  v.ok("the block is inside #settings-panel-gateway", gateway.includes('id="matrix-row"') && gateway.includes('id="matrix-log"'));
  v.ok("the log preview is a mono pre", /<pre class="settings-preview mono" id="matrix-log"/.test(gateway));
  v.ok("the script path is read-only text, not an input", !/<input[^>]+id="matrix-script"/.test(gateway) && !/<input[^>]+id="matrix-room"/.test(gateway));

  const block = app.slice(app.indexOf("// ---- the Matrix bridge"), app.indexOf("// ---- how often the closed part of the board re-sorts"));
  v.ok("the page's bridge block adds no timer of its own", !/setInterval|setTimeout/.test(block), "no setInterval/setTimeout in the block");
  v.ok("the existing 30 s clock is what re-reads the bridge", /matrixSettingsShowing\(\)\) void loadMatrixStatus\(\)/.test(app));
  v.ok("Start is disabled with its reason in the title", /start\.disabled = Boolean\(why\)/.test(block) && /UNAVAILABLE/.test(block));
  v.ok("Stop is never disabled for nothing running", /stop\.disabled = Boolean\(matrixBusy\)/.test(block));
  v.ok("the page never reads a credential", !/MATRIX_PASSWORD|bridge\.env["']?\s*\)/.test(app));
  const lib = readFileSync(path.join(ROOT, "lib", "matrix-bridge.js"), "utf8");
  v.ok("the server's bridge module names no password key", !/MATRIX_PASSWORD/.test(lib));
  v.ok("and opens bridge.env nowhere (existence only)", (lib.match(/bridge\.env/g) || []).length >= 1 && !/readFileSync\([^)]*bridge\.env/.test(lib));
} catch (e) {
  console.log(`FAIL  the run threw before it finished — ${String((e && e.stack) || e)}`);
} finally {
  // The child this run started is killed before the sandbox is deleted, even when an assertion threw between the
  // start and its stop: a fake bridge still running would hold the temp directory open, and leaving it behind would
  // be the harness leaking the thing it exists to prove the panel can stop.
  try {
    const rec = JSON.parse(await readFile(path.join(dir, "logs", "matrix-bridge.pid"), "utf8"));
    if (rec && rec.pid && alive(rec.pid)) {
      try {
        process.kill(rec.pid);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no pid file — the run never started one, or its stop cleared it */
  }
  try {
    if (panel) await panel.stop();
  } catch {
    /* a panel the run already killed */
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${v.failures === 0 ? "PASS" : "FAIL"}  matrix bridge — ${v.checks - v.failures}/${v.checks} checks passed`);
process.exit(v.failures === 0 ? 0 : 1);


function readFileSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
