// Boots the real server.js against a throwaway config, so a test can assert what a route does
// rather than what its source says. No dependencies: child_process + fetch are both built in.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Ask the OS for a port that is free right now, then let go of it. The gap between close and the
// server's listen is a few milliseconds; a collision fails the boot with EADDRINUSE and the helper
// reports it instead of hanging.
function freePort() {
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

// A panel with no projects, no gateway key and its own HERMES_HOME: it can answer HTTP but it
// cannot spawn anything, which is exactly what a route test wants.
export async function startPanel({ token = null, config = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-test-"));
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
    ...(token ? { token } : {}),
    ...config,
  };
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");

  const out = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_CONFIG: cfgPath,
      HERMES_HOME: path.join(dir, "hermes"),
      // A test must never reach the developer's own gateway.
      API_SERVER_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
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
    log: () => out.join(""),
    pid: child.pid,
    async stop() {
      if (!exited) {
        child.kill();
        const until = Date.now() + 8_000;
        while (!exited && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
        if (!exited) child.kill("SIGKILL");
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
