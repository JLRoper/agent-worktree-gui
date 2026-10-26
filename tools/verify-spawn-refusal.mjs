// No spawn starts a turn in a repository that cannot host one — through the card OR through the assistant.
//
// The New-agent card has always refused a tree in a repo with no commits (or one that is not a repo at
// all): an agent's first `git status` fails and the card says "starting" while nothing can work. The
// assistant's own spawner measured the same verdict and threw it away, on the stated assumption that
// lib/jobs.js's `create` refuses an unborn HEAD for whichever tree it is handed. It does not — that guard
// lives inside the worktree-cutting branch (`!opts.existing`), and an existing tree never goes near it.
// So `SPAWN IN <a project with no commits>` resolved (git's worktree list answers in an unborn repo, and
// lib/spawn-target.js matches it) and started a run, while the same request through the card was refused
// and lib/assistant.js told the reader the server refuses it.
//
// Driven here, in a sandbox of its own: a real repo with a real commit beside a real repo with an unborn
// HEAD, its own PANEL_CONFIG, HERMES_HOME and port, and a stub gateway that records every run it is asked
// to start — so "refused" is not a status code alone but "the gateway was never asked". The counterfactual
// is stated rather than re-run: with lib/features/spawn.js's verdict put back on the floor, the two
// assistant checks below fail with a run posted.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sandbox = path.join(os.tmpdir(), `wtgui-spawn-refusal-${Math.random().toString(36).slice(2, 8)}`);
const scanRoot = path.join(sandbox, "scan-root");
const repo = path.join(scanRoot, "sandbox-repo");
const unborn = path.join(scanRoot, "unborn-repo");
const home = path.join(sandbox, "hermes-home");
for (const d of [repo, unborn, home]) mkdirSync(d, { recursive: true });

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

const run = (cmd, args, cwd) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
const git = (args, cwd = repo) => run("git", args, cwd);

writeFileSync(path.join(repo, "README.md"), "a repo with a commit\n", "utf8");
writeFileSync(path.join(unborn, "README.md"), "a repo with no commits\n", "utf8");
await git(["init", "-q"]);
await git(["add", "-A"]);
await git(["-c", "user.name=Refusal", "-c", "user.email=refusal@localhost", "commit", "-q", "-m", "first"]);
await git(["init", "-q"], unborn);
const unbornHead = await git(["rev-parse", "--verify", "--quiet", "HEAD"], unborn);
ok("the second sandbox repo really has an unborn HEAD", unbornHead.code !== 0);

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

// ---- a stub gateway: records every run it is asked to start --------------------------------------
const stub = { bodies: [], runs: new Map(), seq: 0, timers: [] };
const stubServer = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  if (url.pathname === "/v1/capabilities") {
    return json(200, { version: "0.22.2-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
  }
  if (url.pathname === "/v1/runs" && req.method === "POST") {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      stub.seq += 1;
      const id = `run-${stub.seq}`;
      stub.bodies.push(body);
      stub.runs.set(id, { id, status: "running", output: "" });
      stub.timers.push(
        setTimeout(() => {
          const rec = stub.runs.get(id);
          if (rec && rec.status === "running") {
            rec.status = "completed";
            rec.output = "sandbox stub: done";
          }
        }, 400),
      );
      json(200, { run_id: id });
    });
    return;
  }
  const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
  if (one && req.method === "GET") {
    const rec = stub.runs.get(one[1]);
    return rec ? json(200, { run_id: rec.id, status: rec.status, output: rec.output }) : json(404, { error: { message: "Run not found" } });
  }
  if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
    const rec = stub.runs.get(url.pathname.split("/")[3]);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    if (!rec) return res.end();
    const timer = setInterval(() => {
      if (rec.status !== "running") {
        clearInterval(timer);
        res.write(`event: run.${rec.status}\ndata: ${JSON.stringify({ event: `run.${rec.status}`, output: rec.output })}\n\n`);
        res.end();
      }
    }, 150);
    stub.timers.push(timer);
    req.on("close", () => clearInterval(timer));
    return;
  }
  json(404, {});
});
const stubPort = await freePort();
await new Promise((r) => stubServer.listen(stubPort, "127.0.0.1", r));

const panelPort = await freePort();
const configPath = path.join(sandbox, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    port: panelPort,
    host: "127.0.0.1",
    scanRoots: [scanRoot],
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: 3600,
    threads: 1,
    scanMode: "all",
    defaultCwd: repo,
    projectsCacheFile: path.join(sandbox, "logs", "projects.json"),
    apiServer: { url: `http://127.0.0.1:${stubPort}`, key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  }),
  "utf8",
);

const base = `http://127.0.0.1:${panelPort}`;
const log = [];
const panel = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
panel.stdout.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
panel.stderr.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));

const post = async (route, body) => {
  const res = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  let got = null;
  try {
    got = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: got };
};

let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    up = (await fetch(`${base}/api/health`)).ok;
  } catch {
    /* not listening */
  }
  if (!up) await new Promise((r) => setTimeout(r, 500));
}
if (!up) {
  console.log("panel never came up\n" + log.slice(-20).join("\n"));
  panel.kill();
  process.exit(1);
}

const UNBORN_PROJECT = "unborn-repo";
const HEALTHY_PROJECT = "sandbox-repo";
const unbornNamed = /has no commits yet \(unborn HEAD\)/;

console.log("== the card: a new tree in a repo with no commits ==");
const cardNew = await post("/api/agents", { project: UNBORN_PROJECT, prompt: "cut a tree in a repo with no HEAD" });
check("refused", cardNew.status, 400);
check("with the reason attached twice, error and blocked", [cardNew.body?.error, cardNew.body?.blocked], [
  `${UNBORN_PROJECT} has no commits yet (unborn HEAD), so a worktree cannot be created there — make an initial commit first.`,
  `${UNBORN_PROJECT} has no commits yet (unborn HEAD), so a worktree cannot be created there — make an initial commit first.`,
]);
check("and the gateway was never asked", stub.bodies.length, 0);

console.log("\n== the card: an EXISTING tree in that repo (the case the guard does not cover) ==");
const cardExisting = await post("/api/agents", { project: UNBORN_PROJECT, cwd: unborn, existing: true, prompt: "run in the tree that already exists" });
check("refused", cardExisting.status, 400);
ok("with the unborn-HEAD reason", unbornNamed.test(String(cardExisting.body?.error || "")), String(cardExisting.body?.error || "").slice(0, 120));
check("and the gateway was still never asked", stub.bodies.length, 0);

console.log("\n== the assistant: the same existing-tree spawn (SPAWN IN on a project with no HEAD) ==");
const assistUnborn = await post("/api/assistant/spawn", { target: UNBORN_PROJECT, existing: true, prompt: "SPAWN IN the repo with no commits" });
check("refused, as lib/assistant.js tells the reader the server will", assistUnborn.status, 400);
ok("with the same unborn-HEAD reason", unbornNamed.test(String(assistUnborn.body?.error || "")), String(assistUnborn.body?.error || "").slice(0, 140));
check("and no run was started for it", stub.bodies.length, 0);

console.log("\n== the fix does not over-refuse: the assistant's healthy paths still work ==");
const assistExisting = await post("/api/assistant/spawn", { target: HEALTHY_PROJECT, existing: true, prompt: "carry on in the checkout" });
check("an existing tree in a repo with a commit is accepted", assistExisting.status, 202);
check("filed as an existing run", assistExisting.body?.job?.existing, true);
check("attached to the project's own checkout", assistExisting.body?.job?.baseCheckout, true);
check("and the gateway was asked exactly once, in that directory", stub.bodies.length, 1);
check("with the directory as cwd", String(stub.bodies[0]?.cwd || "").replace(/\\/g, "/"), repo.replace(/\\/g, "/"));

const assistNew = await post("/api/assistant/spawn", { project: HEALTHY_PROJECT, prompt: "cut a fresh tree" });
check("a new tree is still accepted", assistNew.status, 202);
check("filed as a new one", assistNew.body?.job?.existing, false);
check("and a second run was posted", stub.bodies.length, 2);
ok("in a worktree cut under the project", String(stub.bodies[1]?.cwd || "").includes(".worktrees"), String(stub.bodies[1]?.cwd || ""));

panel.kill();
for (const t of stub.timers) clearInterval(t);
stubServer.closeAllConnections?.();
await new Promise((r) => stubServer.close(r));
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  /* a held handle; the sandbox is under the temp dir */
}
console.log(`\n== summary ==\n${checks} checks, ${failures} failed.`);
console.log("driven end to end in a sandbox of its own (own port, own PANEL_CONFIG, own HERMES_HOME, a real");
console.log("repo with a commit beside a real repo with an unborn HEAD, and a stub gateway that records what");
console.log("it was asked to start), so 'refused' means the gateway was never asked.");
if (failures) console.log("RESULT: SPAWN-REFUSAL-FAILED");
else console.log("RESULT: SPAWN-REFUSAL-OK");
process.exit(failures ? 1 : 0);
