// Boots the real server.js against a throwaway config, so a test can assert what a route does
// rather than what its source says. No dependencies: child_process + fetch are both built in.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const slash = (p) => String(p || "").replace(/\\/g, "/");

export const GIT_TEST_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "echo",
};
const DEFAULT_EMAIL = ["tester", "example.invalid"].join(String.fromCharCode(64));
const GIT_TEST_ID = [
  "-c",
  "user.name=Test",
  "-c",
  `user.email=${DEFAULT_EMAIL}`,
  "-c",
  "commit.gpgsign=false",
];

// One synchronous git helper for test and verify fixtures. Accepts either `git(cwd, ["status"])` or
// `git(cwd, "status")` and supplies a non-interactive environment plus commit identity flags so a
// throwaway repo does not need three `git config` subprocesses before its first commit.
export function git(cwd, ...rest) {
  let args = rest;
  let env = GIT_TEST_ENV;
  if (Array.isArray(rest[0])) {
    args = rest[0];
    if (rest[1] && typeof rest[1] === "object") {
      env = { ...GIT_TEST_ENV, ...(rest[1].env || rest[1]) };
    }
  }
  return execFileSync("git", ["-C", cwd, ...GIT_TEST_ID, ...args], {
    encoding: "utf8",
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split(String.fromCharCode(13))
    .join("")
    .trim();
}

export function ran(cwd, ...rest) {
  try {
    git(cwd, ...rest);
    return true;
  } catch {
    return false;
  }
}

// Write the test identity and gpgsign=false straight into .git/config instead of spawning three
// `git config` processes per fixture repository (on Windows each git.exe spawn costs 200-1500ms).
export function configureRepo(repo, { name = "Test", email = DEFAULT_EMAIL } = {}) {
  const cfgFile = path.join(repo, ".git", "config");
  if (!existsSync(cfgFile)) return;
  appendFileSync(
    cfgFile,
    `\n[user]\n\temail = ${email}\n\tname = ${name}\n[commit]\n\tgpgsign = false\n`,
    "utf8",
  );
}

// Ask the OS for a port that is free right now, then let go of it. The gap between close and the
// server's listen is a few milliseconds; a collision fails the boot with EADDRINUSE and the helper
// reports it instead of hanging.
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A panel with no projects, no gateway key and its own HERMES_HOME: it can answer HTTP but
// it cannot spawn anything, which is exactly what a route test wants. `dir` lets a test hand in a folder it has
// already seeded (a legacy store to migrate), and `keep` leaves that folder behind on stop() so the SAME sandbox
// can be booted a second time — the only way to prove what a restart does.
//
// `reuseConfig` is the second half of that: boot the folder's EXISTING config.json instead of writing the defaults
// over it, keeping every key the last run (or a route it answered) wrote. Only the port and the paths this kit
// derives are refreshed, because the test needs a free port and the same throwaway store. Without it a restart test
// silently proves that the kit's defaults survive a restart, not the setting under test.
export async function startPanel({ token = null, config = {}, env = {}, dir: givenDir = null, keep = false, reuseConfig = false } = {}) {
  const dir = givenDir || (await mkdtemp(path.join(os.tmpdir(), "wtgui-test-")));
  const repos = path.join(dir, "repos");
  await mkdir(repos, { recursive: true });
  const port = await freePort();
  const cfgPath = path.join(dir, "config.json");
  const cfg = {
    port,
    host: "127.0.0.1",
    scanRoots: [repos],
    threads: 1,
    worktreeSeconds: 60,
    midSeconds: 60,
    dormantSeconds: 60,
    slowSeconds: 60,
    refreshSeconds: 60,
    fetchSeconds: 60,
    projects: [],
    jobsFile: path.join(dir, "logs", "jobs.json"),
    assistantFile: path.join(dir, "logs", "assistant.json"),
    // The discovery cache is a path, not a directory under jobsFile, and it defaults to
    // cwd/logs/projects.json. Without this line the sandbox boots with the developer's own cache:
    // "empty scan root" then still holds every project the real panel discovered, /api/fetch sweeps
    // them over the network, and /api/reload resets the connection mid-sweep (ECONNRESET).
    projectsCacheFile: path.join(dir, "logs", "projects.json"),
    ...config,
  };
  // The existing file wins when a test is re-booting its own sandbox: every key the last process (or a route it
  // answered) wrote is the thing under test, and only the port and the derived paths are refreshed here.
  let boot = cfg;
  if (reuseConfig && existsSync(cfgPath)) {
    try {
      const stored = JSON.parse(await readFile(cfgPath, "utf8"));
      boot = { ...stored, ...{ port, jobsFile: cfg.jobsFile, assistantFile: cfg.assistantFile, projectsCacheFile: cfg.projectsCacheFile }, ...config };
    } catch {
      /* an unreadable config is the fresh boot's problem, not this branch's */
    }
  }
  await writeFile(cfgPath, JSON.stringify(boot, null, 2), "utf8");

  const out = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_CONFIG: cfgPath,
      HERMES_HOME: path.join(dir, "hermes"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      PANEL_PARENT_WATCH_STDIN: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "echo",
      // The write token comes from the environment and nowhere else: loadConfig() ignores a "token" key
      // in config.json (loudly), so a sandbox that needs one sets PANEL_TOKEN for the child instead.
      ...(token ? { PANEL_TOKEN: token } : {}),
      // A test must never reach the developer's own gateway.
      API_SERVER_KEY: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));

  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (exited) {
      throw new Error(`panel exited before it was ready (${JSON.stringify(exited)}):\n${out.join("")}`);
    }
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`panel did not answer /api/health within 25s:\n${out.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    port,
    dir,
    repos,
    configPath: cfgPath,
    home: path.join(dir, "hermes"),
    log: () => out.join(""),
    pid: child.pid,
    async stop() {
      if (!exited) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 8_000);
          timer.unref?.();
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill();
        });
        if (!exited) child.kill("SIGKILL");
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!keep) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

// Poll `fn()` until it returns a truthy value or `timeoutMs` expires. Used across the verification harnesses
// so each script does not carry its own copy of the polling loop.
export async function waitFor(fn, { timeoutMs = 30_000, stepMs = 150, what = "condition", silent = false } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return got;
    if (Date.now() > until) {
      if (!silent) console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// Poll `/api/state` until `predicate(state)` holds, or throw with the projects on the board.
export async function waitForState(base, predicate, what = "state condition", { timeout = 30_000, interval = 150 } = {}) {
  const until = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) {
        last = await r.json();
        if (predicate(last)) return last;
      }
    } catch {
      /* transient socket reset during reload — retry until timeout */
    }
    if (Date.now() > until) {
      const projects = (last?.projects || []).map((p) => `${p.name} (${(p.worktrees || []).length} rows)`).join(", ");
      throw new Error(`timed out waiting for ${what}; projects: ${projects || "none"}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Poll `/api/state` until the worktree row at `treePath` exists (and satisfies `predicate` when given).
export async function waitForRow(base, project, treePath, { predicate = null, what = null, timeout = 30_000, interval = 150 } = {}) {
  const wantPath = slash(treePath).toLowerCase();
  const until = Date.now() + timeout;
  let lastRow = null;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) {
        const state = await r.json();
        const projects = project ? (state.projects || []).filter((p) => p.name === project) : state.projects || [];
        for (const p of projects) {
          const hit = (p.worktrees || []).find((w) => slash(w.path).toLowerCase() === wantPath);
          if (hit) {
            lastRow = hit;
            break;
          }
        }
        if (lastRow && (!predicate || predicate(lastRow))) return lastRow;
      }
    } catch {
      /* transient socket reset during reload — retry until timeout */
    }
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what || `row ${treePath}`}; row: ${JSON.stringify(lastRow ? { path: lastRow.path, release: lastRow.release } : null)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Slice a `// ---- <name> ... // ---- end <endName>` region out of a classic script for unit testing.
export function sliceRegion(src, name, endName = name) {
  const begin = src.indexOf(`// ---- ${name}`);
  const end = src.indexOf(`// ---- end ${endName}`);
  if (!(begin >= 0 && end > begin)) throw new Error(`missing region // ---- ${name} in source`);
  return src.slice(src.indexOf("\n", begin) + 1, end);
}

const sourceCache = new Map();
export function readSource(relPath) {
  const abs = path.resolve(ROOT, relPath);
  if (!sourceCache.has(abs)) sourceCache.set(abs, readFileSync(abs, "utf8"));
  return sourceCache.get(abs);
}

export function sliceBetween(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = endMarker ? src.indexOf(endMarker, a + 1) : src.length;
  if (a < 0 || b < 0) throw new Error(`missing markers ${startMarker} .. ${endMarker || "EOF"}`);
  return src.slice(a, b);
}

export function createVerifier() {
  let checks = 0;
  let failures = 0;
  const ok = (name, cond, extra = "") => {
    checks += 1;
    if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
    else {
      failures += 1;
      console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
    }
    return Boolean(cond);
  };
  const check = (name, got, want) => {
    checks += 1;
    const pass = JSON.stringify(got) === JSON.stringify(want);
    if (!pass) failures += 1;
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${name}${
        pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`
      }`,
    );
    return pass;
  };
  return {
    ok,
    check,
    get checks() {
      return checks;
    },
    get failures() {
      return failures;
    },
  };
}

// POST with an optional token, returning status + parsed body. Used by the route tests so the
// assertion is about the answer, not about fetch's plumbing.
export async function post(base, route, { body, token, headers = {} } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (token) h["x-panel-token"] = token;
  const r = await fetch(`${base}${route}`, {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — the caller can read text via the returned field */
  }
  return { status: r.status, json, text };
}
