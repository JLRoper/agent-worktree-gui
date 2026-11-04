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
//   5. NO SECRET REACHES THE PANEL. A bridge.env holding a sentinel sits beside the fake script; `credentialsPresent`
//      is true and NO answer — GET, save, start, stop, test, refusal — carries the sentinel, and neither does
//      config.json after a save that was SENT one. The panel never opens that file, and this is the measurement.
//   6. THE SELF-TEST'S EXIT CODE IS THE ANSWER. `--self-test` on the fake passes (0) and fails (3) on demand, and
//      both the output and the code come back. A GET never runs one: the first read says `ok: null`.
//   7. THE BRIDGE AUTO-STARTS AT BOOT (the reader's decision). With `autoStart` absent — the default — and
//      bridge.env and a room present, the panel spawns the fake during server boot and says so in `boot`; with
//      `autoStart: false` it starts nothing and names the reason. A spawn that DIES is not swallowed: panel C's
//      script exits at once and `boot.error` carries the refusal the Gateway tab paints.
//   8. THE FOUR FIELDS ARE EDITABLE, THROUGH ONE ROUTE. POST /api/settings/matrix takes scriptPath, pythonPath,
//      roomId and autoStart, writes exactly those into config.json's matrix block (a sent-in secret and an unknown
//      key are dropped), answers with the GET shape, and persists — the file on disk carries the four keys and no
//      sentinel.
//   9. AN EMPTY ROOM IS "NO ROOM SET", NOT A DEFAULT. Saved empty, Start answers 400 and Run self-test answers
//      ok:false with the reason, rather than launching the bridge into nothing.
//  10. THE TAB'S CONTROLS AND THEIR RULES. The markup carries the dot, the status line, the four inputs with titles,
//      Save, the three presses each with a title, and the page's bridge block adds no timer of its own.
//
// THE REAL BRIDGE IS NEVER LAUNCHED: every path here is a fake in a temp directory, `pythonPath` is this Node
// binary, and each temp directory is removed at the end. No Matrix account, no bridge.env of the reader's, no login.
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
// Spelled in two pieces: this file is read by a redactor on its way to a log, and a literal `password: "…"`
// assignment gets masked — which would turn the body under test into something else. The key the panel must
// IGNORE is still exactly `password` on the wire.
const SECRET_KEY = "pass" + "word";

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

// A bridge that cannot come up at all: it exits on its first line, inside the window start() watches. That is the
// boot spawn the reader must be told about — a background child whose corpse only ever reached a log file.
const BROKEN = `#!/usr/bin/env node
console.error("fake bridge: the dependency this fake needs is missing");
process.exit(1);
`;

const v = createVerifier();
const envSentinel = `MATRIX_HOMESERVER=https://matrix.example.invalid\nMATRIX_USERNAME=@fake:matrix.example.invalid\nMATRIX_ROOM_ID=${ROOM}\nMATRIX_${SECRET_KEY.toUpperCase()}=${SENTINEL}\n`;
const answers = [];
const cleanup = [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
    const pid = child.pid;
    child.once("exit", () => resolve(pid));
    child.once("error", reject);
  });
}
// One sandbox: its own temp directory, its own config, its own panel. `script` names the fake to write there.
async function sandbox(label, { matrix = {}, script = FAKE } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `wag-verify-matrix-${label}-`));
  cleanup.push(dir);
  const scriptPath = path.join(dir, "fake-bridge.mjs");
  const pythonPath = process.execPath; // the panel spawns `pythonPath scriptPath`; this is about process handling
  await writeFile(scriptPath, script, "utf8");
  await writeFile(path.join(dir, "bridge.env"), envSentinel, "utf8");
  const panel = await startPanel({
    dir,
    token: "verify-matrix-token",
    config: { matrix: { scriptPath, pythonPath, roomId: ROOM, ...matrix } },
  });
  cleanup.push(panel);
  const token = "verify-matrix-token";
  const json = async (route = "/api/settings/matrix") => {
    const r = await fetch(`${panel.base}${route}`);
    const text = await r.text();
    return { status: r.status, text, json: JSON.parse(text) };
  };
  const record = async (name, route) => {
    const out = await json(route);
    answers.push([name, out.text]);
    return out;
  };
  return { label, dir, scriptPath, pythonPath, panel, token, json, record };
}

try {
  // ============================== A. auto-start at boot, then the four routes ==============================
  const a = await sandbox("a");
  const pidFile = path.join(a.dir, "logs", "matrix-bridge.pid");
  const logFile = path.join(a.dir, "logs", "matrix-bridge.log");

  // ---- 7. the boot spawn: on by default, with credentials and a room present -------------------------------
  const booted = await waitFor(
    async () => {
      const now = await a.json();
      // `boot` lands when autoStart()'s own start() has watched the child for its first 800 ms, so waiting for
      // `running` alone reads the moment between the spawn and the record — the record is what this section asserts.
      return now.json.running && now.json.boot && now.json.boot.attempted && now.json.log.some((line) => line.includes("Bridge live.")) ? now : false;
    },
    { timeoutMs: 25_000, what: "the boot spawn to be live, recorded, and to have printed Bridge live." },
  );
  v.ok("the bridge auto-starts at boot with no flag set (the default)", Boolean(booted), booted ? `pid ${booted.json.pid}` : "timed out");
  const first = await a.record("GET after the boot spawn");
  const bootPid = first.json.pid;
  v.ok("GET reports the boot child as running", first.json.running === true, String(bootPid));
  v.ok("and its pid is a process the OS has", Number.isInteger(bootPid) && alive(bootPid), String(bootPid));
  v.ok("the boot spawn wrote the pid file", existsSync(pidFile), pidFile);
  v.check("the pid file names the boot child", JSON.parse(await readFile(pidFile, "utf8").catch(() => "{}")).pid, bootPid);
  v.ok("the log file holds the child's own line", readFileSafe(logFile).includes("Bridge live."), logFile);
  v.check("the panel's boot record says it started", first.json.boot && first.json.boot.started, true);
  v.check("and that it was attempted, not skipped", first.json.boot && first.json.boot.attempted, true);
  v.ok("the boot record carries no error", !first.json.boot.error, String(first.json.boot.error || ""));
  v.ok("the panel's own log says the boot spawn landed", a.panel.log().includes("matrix bridge at boot: started at boot as pid"), a.panel.log().slice(-400));

  // ---- 5. the config block, and no secret in any answer ---------------------------------------------------
  v.check("the room id is the configured one", first.json.roomId, ROOM);
  v.check("the script path is the configured one", first.json.scriptPath, a.scriptPath);
  v.check("the interpreter is the configured one", first.json.pythonPath, a.pythonPath);
  v.check("autoStart reads true for an absent flag", first.json.autoStart, true);
  v.ok("the script is reported present", first.json.scriptPresent === true);
  v.ok("the interpreter is reported present", first.json.pythonPresent === true);
  v.ok("credentialsPresent is true — bridge.env exists beside the script", first.json.credentialsPresent === true);
  v.ok("credentialsPresent is a boolean, not a value", typeof first.json.credentialsPresent === "boolean");
  v.check("the self-test has not been run by a GET", first.json.selfTest.ok, null);
  v.ok("the pid file path is the panel's state dir, not the script's dir", String(first.json.pidFile).startsWith(path.join(a.dir, "logs")), String(first.json.pidFile));
  v.ok("the log path is the panel's state dir, not the script's dir", String(first.json.logFile).startsWith(path.join(a.dir, "logs")), String(first.json.logFile));
  v.ok("GET carries no password", !first.text.includes(SENTINEL));

  // ---- 3 (part one). stop the boot child, so the routes below start from nothing --------------------------
  const bootStop = await post(a.panel.base, "/api/settings/matrix/stop", { token: a.token });
  answers.push(["POST stop (boot child)", bootStop.text]);
  v.ok("the boot child stops on demand", bootStop.status === 200 && bootStop.json.running === false, bootStop.text.slice(0, 240));
  const bootGone = await waitFor(() => !alive(bootPid), { timeoutMs: 15_000, what: `pid ${bootPid} to exit` });
  v.ok("its pid is gone from the OS's point of view", Boolean(bootGone), String(bootPid));
  v.ok("and its pid file was cleared", !existsSync(pidFile), pidFile);

  // ---- 8. the save route: four keys, nothing else, and it persists ----------------------------------------
  const saved = await post(a.panel.base, "/api/settings/matrix", {
    token: a.token,
    body: {
      scriptPath: a.scriptPath,
      pythonPath: a.pythonPath,
      roomId: ROOM,
      autoStart: false,
      [SECRET_KEY]: SENTINEL,
      notAField: "must-not-be-written",
    },
  });
  answers.push(["POST save", saved.text]);
  v.ok("POST /api/settings/matrix answers 200", saved.status === 200, saved.text.slice(0, 240));
  v.ok("the answer is the GET shape", typeof saved.json.running === "boolean" && "roomId" in saved.json && "scriptPath" in saved.json && "autoStart" in saved.json);
  v.check("it stored autoStart false", saved.json.autoStart, false);
  v.check("it stored the room", saved.json.roomId, ROOM);
  v.ok("the answer carries no secret", !saved.text.includes(SENTINEL));
  v.ok("the answer does not echo the unknown key", !saved.text.includes("must-not-be-written"), saved.text.slice(0, 300));
  const onDisk = JSON.parse(await readFile(a.panel.configPath, "utf8"));
  v.check("config.json's matrix block is exactly the four keys", Object.keys(onDisk.matrix).sort(), ["autoStart", "pythonPath", "roomId", "scriptPath"]);
  v.check("the file carries the saved room", onDisk.matrix.roomId, ROOM);
  v.check("and the saved flag", onDisk.matrix.autoStart, false);
  const fileText = await readFile(a.panel.configPath, "utf8");
  v.ok("config.json carries no password after a save that was sent one", !fileText.includes(SENTINEL) && !fileText.includes("must-not-be-written"));
  const afterSave = await a.record("GET after the save");
  v.check("a GET straight after the save reads the new flag", afterSave.json.autoStart, false);
  v.check("and the same room", afterSave.json.roomId, ROOM);

  // A body with nothing the route accepts is refused, and a bad flag type is refused with its name.
  const secretOnly = await post(a.panel.base, "/api/settings/matrix", { token: a.token, body: { [SECRET_KEY]: SENTINEL } });
  answers.push(["POST save (secret only)", secretOnly.text]);
  v.ok("a body with no whitelisted key is refused with 400", secretOnly.status === 400, `status ${secretOnly.status}`);
  v.ok("the refusal does not write or echo the secret", !secretOnly.text.includes(SENTINEL));
  const badFlag = await post(a.panel.base, "/api/settings/matrix", { token: a.token, body: { autoStart: "maybe" } });
  answers.push(["POST save (bad flag)", badFlag.text]);
  v.ok("autoStart of another type is refused with 400", badFlag.status === 400, `status ${badFlag.status}`);
  v.ok("and the refusal names the field", /autoStart/.test(badFlag.text), badFlag.text.slice(0, 200));

  // ---- 9. an empty room is "no room set": start and self-test refuse loudly -------------------------------
  const emptied = await post(a.panel.base, "/api/settings/matrix", { token: a.token, body: { roomId: "" } });
  answers.push(["POST save (empty room)", emptied.text]);
  v.ok("an empty room saves as a value", emptied.status === 200 && emptied.json.roomId === "", emptied.text.slice(0, 240));
  const noRoomStart = await post(a.panel.base, "/api/settings/matrix/start", { token: a.token });
  answers.push(["POST start (no room)", noRoomStart.text]);
  v.ok("Start with no room is refused with 400", noRoomStart.status === 400, `status ${noRoomStart.status}`);
  v.ok("and the refusal says there is no room", /no room is set/i.test(noRoomStart.text), noRoomStart.text.slice(0, 240));
  v.ok("nothing was spawned", noRoomStart.json.running === false && !existsSync(pidFile));
  const noRoomTest = await post(a.panel.base, "/api/settings/matrix/test", { token: a.token });
  answers.push(["POST test (no room)", noRoomTest.text]);
  v.ok("the self-test fails loudly with no room", noRoomTest.json.ok === false, String(noRoomTest.json.output || "").slice(0, 200));
  v.ok("and the failure is the no-room sentence", /no room is set/i.test(String(noRoomTest.json.output || "")), String(noRoomTest.json.output || "").slice(0, 240));
  const stillEmpty = await a.record("GET after the no-room refusals");
  v.check("the empty room stayed empty", stillEmpty.json.roomId, "");

  // Put the room and the flag back: the rest of the run is about a bridge that CAN start.
  const restored = await post(a.panel.base, "/api/settings/matrix", { token: a.token, body: { roomId: ROOM, autoStart: true } });
  answers.push(["POST save (restore)", restored.text]);
  v.ok("the room can be put back through the same route", restored.status === 200 && restored.json.roomId === ROOM && restored.json.autoStart === true, restored.text.slice(0, 240));

  // ---- 1. start -> a live pid, and the bridge's own line in the log ---------------------------------------
  const started = await post(a.panel.base, "/api/settings/matrix/start", { token: a.token });
  answers.push(["POST start", started.text]);
  v.ok("POST …/start answers 200", started.status === 200, started.text.slice(0, 240));
  v.check("the answer says it is running", started.json.running, true);
  v.ok("the answer carries the child's pid", Number.isInteger(started.json.pid) && started.json.pid > 0, String(started.json.pid));
  const childPid = started.json.pid;
  v.ok("that pid is a process the OS has", alive(childPid), String(childPid));
  const running = await waitFor(
    async () => {
      const now = await a.json();
      return now.json.running && now.json.log.some((line) => line.includes("Bridge live.")) ? now.json : false;
    },
    { timeoutMs: 20_000, what: "the fake bridge to say Bridge live. and be reported running" },
  );
  v.ok("GET reports running, with `Bridge live.` in the log", Boolean(running), running ? `${running.log.length} line(s)` : "timed out");
  const pidOnDisk = JSON.parse(await readFile(pidFile, "utf8").catch(() => "{}"));
  v.check("the pid file names the child", Number(pidOnDisk.pid), childPid);

  // ---- 2. a second start while that pid is alive is a 409 --------------------------------------------------
  const again = await post(a.panel.base, "/api/settings/matrix/start", { token: a.token });
  answers.push(["POST start (second)", again.text]);
  v.ok("a second start is refused with 409", again.status === 409, `status ${again.status}`);
  v.ok("the refusal names the pid it refused for", again.text.includes(String(childPid)), again.text.slice(0, 200));
  // Two starts in this panel's log: the boot spawn and this press. A third would be the refusal spawning anyway.
  v.check("the refusal does not start a second child", (a.panel.log().match(/matrix bridge started/g) || []).length, 2);

  // ---- 6. the self-test: pass, then fail, and a GET keeps the last answer ----------------------------------
  const passed = await post(a.panel.base, "/api/settings/matrix/test", { token: a.token });
  answers.push(["POST test (pass)", passed.text]);
  v.ok("POST …/test answers 200", passed.status === 200, passed.text.slice(0, 240));
  v.ok("the self-test passed", passed.json.ok === true, String(passed.json.output || "").slice(0, 200));
  v.check("its exit code is 0", passed.json.exitCode, 0);
  v.ok("its output is the fake's own block", String(passed.json.output).includes("fake matrix bridge — self-test"), String(passed.json.output).slice(0, 200));
  const kept = await a.record("GET after a self-test");
  v.ok("GET keeps the last self-test's answer", kept.json.selfTest.ok === true && String(kept.json.selfTest.output).includes("fake matrix bridge"), JSON.stringify(kept.json.selfTest).slice(0, 240));

  await writeFile(path.join(a.dir, "self-test-fail"), "fail please\n", "utf8");
  const failed = await post(a.panel.base, "/api/settings/matrix/test", { token: a.token });
  answers.push(["POST test (fail)", failed.text]);
  v.ok("a failing self-test answers with ok: false", failed.json.ok === false, failed.text.slice(0, 240));
  v.check("the failing exit code is reported", failed.json.exitCode, 3);
  v.ok("its stderr is in the output", String(failed.json.output).includes("the fake was told to fail"), String(failed.json.output).slice(0, 200));
  await rm(path.join(a.dir, "self-test-fail"), { force: true });

  // ---- 3 (part two). stop -> not running, and the pid is gone --------------------------------------------
  const stopOut = await post(a.panel.base, "/api/settings/matrix/stop", { token: a.token });
  answers.push(["POST stop", stopOut.text]);
  v.ok("POST …/stop answers 200", stopOut.status === 200, stopOut.text.slice(0, 240));
  v.check("the answer says running: false", stopOut.json.running, false);
  v.check("the answer says it stopped the child", stopOut.json.stopped, true);
  const gone = await waitFor(() => !alive(childPid), { timeoutMs: 15_000, what: `pid ${childPid} to exit` });
  v.ok("the pid is gone from the OS's point of view", Boolean(gone), String(childPid));
  v.ok("the pid file was cleared by the stop", !existsSync(pidFile), pidFile);

  // A stop with nothing running is a sentence, never an error.
  const idleStop = await post(a.panel.base, "/api/settings/matrix/stop", { token: a.token });
  answers.push(["POST stop (nothing running)", idleStop.text]);
  v.ok("a stop with nothing running answers 200", idleStop.status === 200, `status ${idleStop.status}`);
  v.ok("it does not report an error", !idleStop.json.error, String(idleStop.json.error || ""));
  v.ok("it says nothing was running", /nothing was running|already gone/.test(String(idleStop.json.note || "")), String(idleStop.json.note || ""));

  // ---- 4. a stale pid file is not a running bridge, and does not block a start -----------------------------
  const stale = await deadPid();
  await writeFile(pidFile, `${JSON.stringify({ pid: stale, startedAt: new Date(0).toISOString(), scriptPath: a.scriptPath }, null, 2)}\n`, "utf8");
  const staleRead = await a.record("GET with a stale pid file");
  v.check("a stale pid file is not running", staleRead.json.running, false);
  v.check("the stale pid is named as such", staleRead.json.stalePid, stale);
  v.check("and no live pid is reported", staleRead.json.pid, null);
  const restarted = await post(a.panel.base, "/api/settings/matrix/start", { token: a.token });
  answers.push(["POST start (after a stale pid)", restarted.text]);
  v.ok("a stale pid file does not block a start", restarted.status === 200 && restarted.json.running === true, restarted.text.slice(0, 240));
  v.ok("the new pid is not the stale one", restarted.json.pid !== stale, `${restarted.json.pid} vs ${stale}`);
  const restop = await post(a.panel.base, "/api/settings/matrix/stop", { token: a.token });
  v.ok("the restart is stopped again", restop.status === 200 && restop.json.running === false, restop.text.slice(0, 240));

  // ---- the log tail GET returns is bounded, and is lines --------------------------------------------------
  const tail = await a.record("GET final");
  v.ok("the log is an array of lines", Array.isArray(tail.json.log));
  v.ok("the tail is at most 40 lines", tail.json.log.length <= 40, `${tail.json.log.length} lines`);

  // ---- 5 (continued). NO ANSWER, over the whole run, carried the sentinel ---------------------------------
  for (const [name, text] of answers) v.ok(`${name} carries no password`, !String(text).includes(SENTINEL));

  // ============================== B. autoStart:false starts nothing at boot ==============================
  const b = await sandbox("b", { matrix: { autoStart: false } });
  const bFirst = await b.record("B GET after boot");
  v.check("autoStart:false leaves the bridge stopped at boot", bFirst.json.running, false);
  v.check("and reports autoStart false", bFirst.json.autoStart, false);
  v.check("its boot record says nothing was attempted", bFirst.json.boot && bFirst.json.boot.attempted, false);
  v.ok("the boot record names the reason", /auto-start is off/i.test(String(bFirst.json.boot.note || "")), String(bFirst.json.boot.note || ""));
  v.ok("B wrote no pid file at boot", !existsSync(path.join(b.dir, "logs", "matrix-bridge.pid")));
  v.ok("B wrote no log at boot", !existsSync(path.join(b.dir, "logs", "matrix-bridge.log")));
  v.ok("B's panel log says the boot spawn was off", b.panel.log().includes("matrix bridge at boot: auto-start is off"), b.panel.log().slice(-400));

  // ============================== C. a boot spawn that dies is surfaced =================================
  const c = await sandbox("c", { script: BROKEN });
  const brokenBoot = await waitFor(
    async () => {
      const now = await c.json();
      return now.json.boot && now.json.boot.attempted && now.json.boot.error ? now : false;
    },
    { timeoutMs: 25_000, what: "the boot spawn to fail and record why" },
  );
  v.ok("a boot spawn that exits at once is recorded, not swallowed", Boolean(brokenBoot), brokenBoot ? String(brokenBoot.json.boot.error).slice(0, 160) : "timed out");
  v.check("the failed boot reports the bridge not running", brokenBoot.json.running, false);
  v.check("and no live pid", brokenBoot.json.pid, null);
  v.ok("the boot error names the exit", /exited/i.test(String(brokenBoot.json.boot.error)), String(brokenBoot.json.boot.error || "").slice(0, 200));
  v.ok("the panel log says the auto-start FAILED", c.panel.log().includes("matrix bridge auto-start FAILED"), c.panel.log().slice(-400));
  answers.push(["C GET (failed boot)", brokenBoot.text]);

  // ============================== the tab's controls, and the page's rules ==============================
  const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  for (const id of ["matrix-row", "matrix-dot", "matrix-state", "matrix-room", "matrix-preview", "matrix-log", "matrix-paths"]) {
    v.ok(`the Gateway tab carries #${id}`, html.includes(`id="${id}"`));
  }
  for (const id of ["btn-matrix-start", "btn-matrix-stop", "btn-matrix-test", "btn-matrix-save"]) {
    v.ok(`the tab carries #${id}, with a title`, new RegExp(`id="${id}"[^>]*title="[^"]{20,}"`).test(html));
  }
  for (const id of ["matrix-script-path", "matrix-python-path", "matrix-room-id", "matrix-autostart"]) {
    v.ok(`#${id} is an input`, new RegExp(`<input[^>]+id="${id}"`).test(html));
    v.ok(`#${id} carries a title`, new RegExp(`<input[^>]+id="${id}"[^>]*title="[^"]{20,}"`).test(html));
  }
  v.ok("the checkbox is a checkbox", /<input[^>]+id="matrix-autostart"[^>]*type="checkbox"/.test(html));
  const gateway = html.slice(html.indexOf('id="settings-panel-gateway"'), html.indexOf('id="settings-panel-skills"'));
  v.ok("the block is inside #settings-panel-gateway", gateway.includes('id="matrix-row"') && gateway.includes('id="matrix-log"'));
  v.ok("the log preview is a mono pre", /<pre class="settings-preview mono" id="matrix-log"/.test(gateway));
  v.ok("the four fields and Save sit inside the same pane", ["matrix-script-path", "matrix-python-path", "matrix-room-id", "matrix-autostart", "btn-matrix-save"].every((id) => gateway.includes(`id="${id}"`)));

  const block = app.slice(app.indexOf("// ---- the Matrix bridge"), app.indexOf("// ---- how often the closed part of the board re-sorts"));
  v.ok("the page's bridge block adds no timer of its own", !/setInterval|setTimeout/.test(block), "no setInterval/setTimeout in the block");
  v.ok("the existing 30 s clock is what re-reads the bridge", /matrixSettingsShowing\(\)\) void loadMatrixStatus\(\)/.test(app));
  v.ok("Start is disabled with its reason in the title", /start\.disabled = Boolean\(why\)/.test(block) && /UNAVAILABLE/.test(block));
  v.ok("Start's reason names an empty room", /no room set/.test(block), "the no-room branch is in the reason chain");
  v.ok("Stop is never disabled for nothing running", /stop\.disabled = Boolean\(matrixBusy\)/.test(block));
  v.ok("the save posts the four fields and no credential", /matrixSave/.test(block) && /JSON\.stringify\(body\)/.test(block) && !/pass(word)?"?\s*:/i.test(block));
  v.ok("the four field ids are the ones the page reads", ["matrix-script-path", "matrix-python-path", "matrix-room-id", "matrix-autostart"].every((id) => block.includes(id)));
  v.ok("a failed boot spawn is painted, not swallowed", /AUTO-START FAILED at boot/.test(block) && /s\.boot\s*&&\s*s\.boot\.error/.test(block));
  v.ok("the page never reads a credential", !/MATRIX_PASSWORD|bridge\.env["']?\s*\)/.test(app));
  const lib = readFileSync(path.join(ROOT, "lib", "matrix-bridge.js"), "utf8");
  v.ok("the server's bridge module names no password key", !/MATRIX_PASSWORD/.test(lib));
  v.ok("and opens bridge.env nowhere (existence only)", (lib.match(/bridge\.env/g) || []).length >= 1 && !/readFileSync\([^)]*bridge\.env/.test(lib));
  v.ok("the whitelist carries autoStart", /MATRIX_KEYS = \["scriptPath", "pythonPath", "roomId", "autoStart"\]/.test(lib));
  const server = readFileSync(path.join(ROOT, "server.js"), "utf8");
  v.ok("server.js spawns the bridge at boot", /matrixBridge\.autoStart\(\)/.test(server), "the listen callback calls it");
  v.ok("server.js answers POST /api/settings/matrix", /route === "\/api\/settings\/matrix" && req\.method === "POST"/.test(server));
} catch (e) {
  console.log(`FAIL  the run threw before it finished — ${String((e && e.stack) || e)}`);
} finally {
  // Every fake this run started is killed before its sandbox is deleted, even when an assertion threw between a
  // start and its stop: a fake still running would hold the temp directory open, and leaving one behind would be
  // the harness leaking the thing it exists to prove the panel can stop.
  for (const panel of cleanup.filter((c) => c && typeof c === "object" && typeof c.stop === "function")) {
    try {
      const rec = JSON.parse(await readFile(path.join(panel.dir, "logs", "matrix-bridge.pid"), "utf8"));
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
      await panel.stop();
    } catch {
      /* a panel the run already killed */
    }
  }
  for (const dir of cleanup.filter((c) => typeof c === "string")) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
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
