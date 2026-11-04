// lib/matrix-bridge.js, the parts that are pure enough to prove without a panel: the config block's filter, the
// save route's whitelist, the pid check, the pid record's shape and the log tail's bound. The process lifecycle
// itself is tools/verify-matrix-bridge.mjs, which drives a real (fake) child through the routes.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MATRIX_KEYS, autoStartFrom, matrixBlock, MatrixBridge, matrixConfig, matrixPatchFrom, pidAlive, tailLines } from "../lib/matrix-bridge.js";

test("the matrix block is exactly its four keys — a password in config.json cannot reach an answer", () => {
  const out = matrixConfig({
    scriptPath: " C:/bridge/hermes_matrix_bridge.py ",
    pythonPath: "C:/bridge/.venv/Scripts/python.exe",
    roomId: "!room:server",
    autoStart: false,
    password: "must-not-survive",
    apiKey: "another-secret"
  });
  assert.deepEqual(Object.keys(out).sort(), ["autoStart", "pythonPath", "roomId", "scriptPath"]);
  assert.deepEqual(MATRIX_KEYS.slice().sort(), Object.keys(out).sort(), "the whitelist IS the answer's key list");
  assert.equal(out.scriptPath, "C:/bridge/hermes_matrix_bridge.py", "the path is trimmed");
  assert.equal(out.roomId, "!room:server");
  assert.equal(out.autoStart, false, "an explicit false is kept");
  assert.equal(JSON.stringify(out).includes("must-not-survive"), false);
  assert.equal(JSON.stringify(out).includes("nor-this"), false);
});

test("a missing or unusable block reads as three empty strings and auto-start ON, never another machine's paths", () => {
  for (const raw of [undefined, null, "nonsense", 7, {}]) {
    assert.deepEqual(matrixConfig(raw), { scriptPath: "", pythonPath: "", roomId: "", autoStart: true });
  }
});

test("autoStart is a flag: absent means on, and only an unmistakable off turns it off", () => {
  assert.equal(autoStartFrom(undefined), true, "an install that predates the flag auto-starts");
  assert.equal(autoStartFrom(null), true);
  assert.equal(autoStartFrom("nonsense"), true, "an unreadable value falls back, it does not switch the bridge off");
  assert.equal(autoStartFrom(false), false);
  assert.equal(autoStartFrom("false"), false);
  assert.equal(autoStartFrom("OFF"), false);
  assert.equal(autoStartFrom(0), false);
  assert.equal(autoStartFrom(true), true);
  assert.equal(autoStartFrom("true"), true);
});

test("the save route reads its four keys and ignores everything else — a body cannot smuggle a password in", () => {
  const ok = matrixPatchFrom({
    scriptPath: "  C:/bridge/x.py  ",
    pythonPath: "C:/py.exe",
    roomId: " !room:server ",
    autoStart: false,
    password: "must-not-survive",
    nested: { whatever: 1 },
  });
  assert.deepEqual(ok, { values: { scriptPath: "C:/bridge/x.py", pythonPath: "C:/py.exe", roomId: "!room:server", autoStart: false } });
  assert.equal(JSON.stringify(ok).includes("must-not-survive"), false);
  assert.equal("nested" in ok.values, false, "a key nobody named is not written");

  assert.ok(matrixPatchFrom({ password: "x" }).error, "a body with no whitelisted key is refused, not written");
  assert.ok(matrixPatchFrom(null).error);
  assert.ok(matrixPatchFrom([1, 2]).error);
  assert.match(matrixPatchFrom({ roomId: 7 }).error, /roomId must be a string/);
  assert.match(matrixPatchFrom({ autoStart: "maybe" }).error, /autoStart must be true or false/);
  assert.deepEqual(matrixPatchFrom({ roomId: "" }), { values: { roomId: "" } }, "an empty room is a value: 'no room set'");
});

test("the block a save writes is the whitelist — current values overlaid, a hand-pasted password dropped", () => {
  const next = matrixBlock(
    { scriptPath: "C:/a.py", pythonPath: "C:/py.exe", roomId: "!old:server", autoStart: true, password: "must-not-survive" },
    { roomId: "!new:server", autoStart: false },
  );
  assert.deepEqual(next, { scriptPath: "C:/a.py", pythonPath: "C:/py.exe", roomId: "!new:server", autoStart: false });
  assert.equal(JSON.stringify(next).includes("must-not-survive"), false);
});

test("pidAlive answers the OS, not the caller's opinion", async () => {
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive("not a pid"), false);
  assert.equal(pidAlive(process.pid), true, "this process is alive");
  // A pid that has certainly exited: a child that exited before this line ran. Reuse is a risk in theory; a pid
  // just handed out and released is not one in practice, and the assertion is about the dead case.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(pidAlive(child.pid), false, `pid ${child.pid} exited`);
});

test("the pid record round-trips, and a file that is not one reads as no record at all", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wag-matrix-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "matrix-bridge.pid");
  const bridge = new MatrixBridge({ config: { dataDir: dir, matrixPidFile: pidFile, matrix: { scriptPath: path.join(dir, "x.py") } } });

  assert.equal(bridge.readPid(), null, "no file is no record");
  bridge.writePid(4321, { scriptPath: "C:/x.py", pythonPath: "C:/py.exe" });
  const rec = bridge.readPid();
  assert.equal(rec.pid, 4321);
  assert.equal(rec.scriptPath, "C:/x.py");

  await writeFile(pidFile, "{ this is not json", "utf8");
  assert.equal(bridge.readPid(), null, "a half-written file is not a pid");
  await writeFile(pidFile, JSON.stringify({ pid: "not-a-number" }), "utf8");
  assert.equal(bridge.readPid(), null, "a pid that is not a positive integer is not a pid");
  await writeFile(pidFile, JSON.stringify({ pid: 0 }), "utf8");
  assert.equal(bridge.readPid(), null);
});

test("the log tail is the LAST lines, bounded, and absent means empty", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wag-matrix-tail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "matrix-bridge.log");
  assert.deepEqual(tailLines(file), [], "no file: no lines");
  await writeFile(file, Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n") + "\n", "utf8");
  const tail = tailLines(file, 40);
  assert.equal(tail.length, 40, "40 asks for 40");
  assert.equal(tail[0], "line 81", "the tail is the newest end of the file");
  assert.equal(tail[39], "line 120");
  await writeFile(file, "one\r\ntwo\r\n\r\n", "utf8");
  assert.deepEqual(tailLines(file, 5), ["one", "two"], "CRLF is split like LF, and blank lines are not lines");
});
