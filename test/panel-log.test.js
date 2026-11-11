import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import panelLog from "../lib/panel-log.cjs";
import { freePort } from "../tools/panel-testkit.mjs";

const { RotatingPanelLog, acquire, launchSupervisor, validatePaths, readPid, MAX_BYTES } = panelLog;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const names = (dir) => readdirSync(dir).filter((n) => /^server\.(out|err)\.log/.test(n));
const contents = (dir) => names(dir).map((n) => readFileSync(path.join(dir, n), "utf8")).join("");
const total = (dir) => names(dir).reduce((sum, n) => sum + statSync(path.join(dir, n)).size, 0);
const paths = (dir) => ["server.pid", "server.out.log", "server.err.log"].map((name) => path.join(dir, name));
const temp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "panel-log-test-"));
  t.after(async () => {
    for (let attempt = 0; ; attempt++) {
      try { rmSync(dir, { recursive: true, force: true }); return; }
      catch (e) {
        if (attempt >= 50 || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(e.code)) throw e;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });
  return dir;
};
async function waitFor(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for synthetic process");
}
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { if (e.code === "ESRCH") return true; throw e; } };

test("startup preserves both old streams and hourly idle roll closes the active files", (t) => {
  const dir = temp(t);
  const [, out, err] = paths(dir);
  writeFileSync(out, "old stdout\n");
  writeFileSync(err, "old stderr\n");
  let now = Date.UTC(2026, 0, 1, 12, 59);
  const log = new RotatingPanelLog(dir, { maxBytes: 512, segmentBytes: 128, now: () => now });
  assert.match(contents(dir), /old stdout/);
  assert.match(contents(dir), /old stderr/);
  log.write("out", "new stdout\n");
  log.write("err", "new stderr\n");
  now += 60_000;
  log.tick();
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(err), false);
  assert.equal(names(dir).length, 4);
  assert.match(contents(dir), /new stderr/);
});

test("both streams and archives share the hard limit, even for huge records and legacy files", (t) => {
  const dir = temp(t);
  const [, out, err] = paths(dir);
  writeFileSync(out, "obsolete-" + "a".repeat(500) + "legacy-tail\n");
  writeFileSync(err, "older error\n");
  writeFileSync(path.join(dir, "server.out.log.not-an-archive"), "unrelated");
  const log = new RotatingPanelLog(dir, { maxBytes: 192, segmentBytes: 48 });
  assert.ok(total(dir) - 9 <= 192);
  assert.match(contents(dir), /legacy-tail/);
  log.write("out", Buffer.alloc(1100, "x"));
  log.write("err", "important-error\n");
  assert.ok(total(dir) - 9 <= 192);
  assert.match(contents(dir), /important-error/);
  assert.equal(readFileSync(path.join(dir, "server.out.log.not-an-archive"), "utf8"), "unrelated");
  assert.ok(names(dir).filter((n) => n !== "server.out.log.not-an-archive").every((n) => statSync(path.join(dir, n)).size <= 48));
});

test("rejects paths outside the log directory and links to other files", (t) => {
  const dir = temp(t);
  const [pid, out, err] = paths(dir);
  assert.throws(() => validatePaths(pid, path.join(dir, "..", "elsewhere"), err), /invalid panel log path/);
  const target = path.join(dir, "untouched");
  writeFileSync(target, "safe");
  linkSync(target, out);
  assert.throws(() => validatePaths(pid, out, err), /unsafe log file/);
  assert.equal(readFileSync(target, "utf8"), "safe");
  rmSync(out);
  try { symlinkSync(target, out); } catch (e) { if (["EPERM", "EACCES"].includes(e.code)) return; throw e; }
  assert.throws(() => validatePaths(pid, out, err), /unsafe log file/);
  assert.equal(readFileSync(target, "utf8"), "safe");
});

test("pid files are numeric and cannot inject commands or point to linked files", (t) => {
  const dir = temp(t);
  const [pid] = paths(dir);
  writeFileSync(pid, "1 & unwanted-command");
  assert.throws(() => readPid(pid), /invalid panel pid file/);
  rmSync(pid);
  const target = path.join(dir, "other");
  writeFileSync(target, "123");
  linkSync(target, pid);
  assert.throws(() => readPid(pid), /unsafe log file/);
  assert.equal(readFileSync(target, "utf8"), "123");
});

test("the default limit is 20 MiB across both streams and all segments", (t) => {
  const dir = temp(t);
  const log = new RotatingPanelLog(dir);
  log.write("out", Buffer.alloc(MAX_BYTES + 1024, 120));
  log.write("err", "last-error\n");
  assert.equal(MAX_BYTES, 20 * 1024 * 1024);
  assert.ok(total(dir) <= MAX_BYTES);
  assert.match(readFileSync(path.join(dir, "server.err.log"), "utf8"), /last-error/);
});

test("the log lock excludes a live owner and recovers a dead owner", async (t) => {
  const dir = temp(t);
  const release = await acquire(dir);
  await assert.rejects(acquire(dir, 150), /still owned/);
  release();
  const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { dead.once("error", reject); dead.once("exit", resolve); });
  const lock = path.join(dir, ".server-log-lock");
  mkdirSync(lock);
  writeFileSync(path.join(lock, "owner"), String(dead.pid));
  const recovered = await acquire(dir);
  assert.equal(Number(readFileSync(path.join(lock, "owner"), "utf8")), process.pid);
  recovered();
  assert.equal(existsSync(lock), false);
});

test("detached supervisor captures native stdout and stderr, reports panel pid, and releases lock", async (t) => {
  const dir = temp(t);
  const script = path.join(dir, "fake-server.cjs");
  writeFileSync(script, 'const fs = require("node:fs"); fs.writeSync(1, "native-out\\n"); fs.writeSync(2, "native-error\\n"); setInterval(() => {}, 1000);');
  const [pidFile, out, err] = paths(dir);
  const { supervisor, pid } = await launchSupervisor(script, pidFile, out, err);
  t.after(() => { try { process.kill(pid); } catch {} if (supervisor.connected) supervisor.disconnect(); });
  assert.equal(Number(readFileSync(pidFile, "utf8")), pid);
  assert.notEqual(pid, supervisor.pid);
  supervisor.disconnect();
  await waitFor(() => existsSync(out) && existsSync(err) && readFileSync(out, "utf8").includes("native-out") && readFileSync(err, "utf8").includes("native-error"));
  process.kill(pid);
  await waitFor(() => !existsSync(path.join(dir, ".server-log-lock")));
  await waitFor(() => gone(supervisor.pid));
});

test("restart helper logs both a replacement's fatal stderr and its own diagnostics", async (t) => {
  const dir = temp(t);
  const script = path.join(dir, "fake-server.cjs");
  writeFileSync(script, 'require("node:fs").writeFileSync("supervisor.pid", String(process.ppid)); process.stderr.write("replacement fatal\\n"); process.exitCode = 2;');
  const [pid, out, err] = paths(dir);
  const helper = spawn(process.execPath, [path.join(root, "lib", "panel-restart.cjs"), script, pid, out, err, "0", "0"], { windowsHide: true, stdio: "ignore" });
  const code = await new Promise((resolve, reject) => { helper.once("error", reject); helper.once("exit", resolve); });
  assert.equal(code, 0);
  await waitFor(() => existsSync(err) && readFileSync(err, "utf8").includes("replacement fatal"));
  await waitFor(() => !existsSync(path.join(dir, ".server-log-lock")));
  const supervisorPid = Number(readFileSync(path.join(dir, "supervisor.pid"), "utf8"));
  await waitFor(() => gone(supervisorPid));
  assert.match(contents(dir), /panel-restart: launched/);
});

test("Windows background launcher preserves existing logs and writes the listening server pid", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const dir = temp(t);
  const logs = path.join(dir, "logs");
  const repos = path.join(dir, "repos");
  mkdirSync(logs);
  mkdirSync(repos);
  const config = path.join(dir, "config.json");
  const port = await freePort();
  writeFileSync(config, JSON.stringify({ dataDir: dir, port, host: "127.0.0.1", scanRoots: [repos], projects: [] }));
  writeFileSync(path.join(logs, "server.out.log"), "previous stdout\n");
  writeFileSync(path.join(logs, "server.err.log"), "previous stderr\n");
  const env = { ...process.env, PANEL_CONFIG: config, HERMES_HOME: path.join(dir, "hermes"), CLAUDE_CONFIG_DIR: path.join(dir, "claude"), API_SERVER_KEY: "", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  delete env.PANEL_PARENT_WATCH_STDIN;
  delete env.PANEL_TOKEN;
  const launcher = spawn("cmd.exe", ["/d", "/c", "start-background.cmd"], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  launcher.stdout.on("data", (s) => { output += s; });
  launcher.stderr.on("data", (s) => { output += s; });
  const code = await new Promise((resolve, reject) => { launcher.once("error", reject); launcher.once("close", resolve); });
  assert.equal(code, 0, output);
  const pid = Number(readFileSync(path.join(logs, "server.pid"), "utf8"));
  const owner = Number(readFileSync(path.join(logs, ".server-log-lock", "owner"), "utf8"));
  t.after(() => { try { process.kill(pid); } catch {} });
  assert.match(output, new RegExp(`started PID ${pid}\\b`));
  await waitFor(() => names(logs).some((n) => readFileSync(path.join(logs, n), "utf8").includes("previous stderr")));
  assert.match(contents(logs), /previous stdout/);
  assert.match(contents(logs), /previous stderr/);
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; }
  }, 20000);
  assert.equal(gone(pid), false);
  const duplicate = spawn("cmd.exe", ["/d", "/c", "start-background.cmd"], { cwd: root, env, windowsHide: true, stdio: "ignore" });
  const duplicateCode = await new Promise((resolve, reject) => { duplicate.once("error", reject); duplicate.once("close", resolve); });
  assert.equal(duplicateCode, 1);
  assert.equal(Number(readFileSync(path.join(logs, "server.pid"), "utf8")), pid);
  const stopper = spawn("cmd.exe", ["/d", "/c", "stop-background.cmd"], { cwd: root, env, windowsHide: true, stdio: "ignore" });
  const stopCode = await new Promise((resolve, reject) => { stopper.once("error", reject); stopper.once("close", resolve); });
  assert.equal(stopCode, 0);
  await waitFor(() => gone(pid));
  assert.equal(existsSync(path.join(logs, "server.pid")), false);
  await waitFor(() => gone(owner));
});
