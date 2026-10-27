// The branch column as a link, and "local only" as a default that actually holds.
//
//   node tools/verify-branch-links-local-only.mjs                     (all phases)
//   node tools/verify-branch-links-local-only.mjs --no-browser        (skip the browser half)
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node …      (where Playwright lives)
//
// Three claims are driven here, each on a REAL panel instance built from a throwaway config, a real git
// repository, a real bare "remote" and a stand-in Runs API (so no gateway, no paid worker, no network):
//
//   A. the chart's branch cell is a link when the remote HAS that branch and plain text with a reason when it does
//      not — the href built from the project's own remote, and the decision taken from git rather than from a URL;
//      plus the browser half: the rendered cell's HTML, and that clicking the link does not fire the row's own
//      gesture.
//   B/C. a worktree the panel cuts is LOCAL ONLY by default: `git ls-remote --heads <remote> <branch>` is empty and
//      `git rev-parse --abbrev-ref '@{upstream}'` fails in the fresh tree; the pre-push guard the panel installed
//      REFUSES a push out of it and parks it on the panel's own permission box; Deny leaves the remote untouched
//      and Allow once lets the same attempt through; a tree started to land pushes with no box at all; the setting
//      survives a panel restart; and the panel's OWN merge flow asks first instead of pushing for itself.
//
// WHAT IS DRIVEN vs READ: every phase below says in its own output which instance it ran against. The one thing
// read rather than driven is the URL policy table (phase 2) — that is a pure function over the four URL forms a
// real remote uses, and it is called directly rather than observed through the panel.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const require = createRequire(import.meta.url);
const pexec = promisify(execFile);
const NO_BROWSER = process.argv.includes("--no-browser");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let checks = 0;
let failures = 0;
const ok = (name, cond, detail) => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const check = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) === JSON.stringify(want) ? got : { got, want });
const say = (line) => console.log(`      ${line}`);

// ---------------------------------------------------------------------------------------------------------------
// git helpers (windowsHide, no prompts: nothing here may sit waiting for a credential)
// ---------------------------------------------------------------------------------------------------------------
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo" };
const git = async (cwd, args, opts = {}) => {
  try {
    const { stdout } = await pexec("git", ["-C", cwd, ...args], { timeout: opts.timeout || 30000, windowsHide: true, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: String(stdout || "").replace(/\r\n/g, "\n").trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "").replace(/\r\n/g, "\n").trim(), err: String(e.stderr || e.message || "").replace(/\r\n/g, "\n").trim(), code: e.code };
  }
};
const gitSync = (cwd, args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------------------------------------------------------
// the scratch world: a bare "remote" whose path SHAPES like a github repo, a project with two worktrees, and a
// throwaway HERMES_HOME so no real .env, session store or assistant is ever read or woken.
//
// The remote lives at `<scratch>/srv/github.com/JLRoper/proof-repo.git`, which is what makes the LINK half real:
// `probe()` reads the remote's url through `githubRepo()` and gets `JLRoper/proof-repo` out of it, exactly as it
// would from `git@github.com:JLRoper/proof-repo.git` — and every push and `ls-remote` below is a local file copy,
// so no phase needs a network or a credential.
// ---------------------------------------------------------------------------------------------------------------
const scratch = mkdtempSync(path.join(tmpdir(), "wtgui-branchlinks-"));
const S = scratch.replace(/\\/g, "/");
const REMOTE = `${S}/srv/github.com/JLRoper/proof-repo.git`;
const PROJECT = `${S}/repos/prooflib`;
const HOME = `${S}/home`;
const PANEL_CWD = `${S}/panel`;
const CONFIG = `${S}/proof.config.json`;
const PUSHED_TREE = `${PROJECT}/.worktrees/proof-pushed-aaaaaa`;
const LOCAL_TREE = `${PROJECT}/.worktrees/proof-local-bbbbbb`;
const PUSHED_BRANCH = "wtgui/proof-pushed-aaaaaa";
const LOCAL_BRANCH = "wtgui/proof-local-bbbbbb";

let panel = null;
let stub = null;
let panelLog = "";
const stubState = { runs: [], capabilities: 0 };
// The run the panel posted for one brief, found by its own text: the stand-in gateway sees every run, including
// the assistant's, so "the last one" is not the one under test.
const runFor = (text) => [...stubState.runs].reverse().find((r) => String(r.body?.input || "").includes(text)) || null;

const killTree = (pid) => {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
};
const normWin = (p) => p.replace(/\\/g, "/");

async function makeFixture() {
  for (const dir of ["srv/github.com/JLRoper", "repos", "home", "panel"]) mkdirSync(`${S}/${dir}`, { recursive: true });
  await git(`${S}/srv/github.com`, ["init", "-q", "--bare", REMOTE]);
  await git(`${S}/repos`, ["init", "-q", "-b", "main", PROJECT]);
  const id = ["-c", "user.email=proof@localhost", "-c", "user.name=proof"];
  // The reader's own commit-msg gate, the way this repo has it: a TRACKED `.githooks/` at the repository root reached
  // through a RELATIVE `core.hooksPath`. It has to be committed BEFORE any worktree exists, because that is what
  // puts a copy in every tree the panel later cuts — which is exactly the hook the guard must keep running.
  mkdirSync(`${PROJECT}/.githooks`, { recursive: true });
  writeFileSync(`${PROJECT}/.githooks/commit-msg`, "#!/bin/sh\necho 'GATE: commit-msg ran' >&2\nexit 0\n", "utf8");
  // …and its own PRE-PUSH, which is the harder half: the guard takes the worktree's hooks path, so a pre-push the
  // worktree already had must be CHAINED (run) rather than shadowed. This repository ships exactly that as a version
  // gate, so the fixture has one that announces itself and then one that refuses (phase 7).
  writeFileSync(`${PROJECT}/.githooks/pre-push`, "#!/bin/sh\necho 'GATE: pre-push ran' >&2\nexit 0\n", "utf8");
  await git(PROJECT, ["config", "core.hooksPath", ".githooks"]);
  await git(PROJECT, [...id, "add", ".githooks/commit-msg", ".githooks/pre-push"]);
  await git(PROJECT, [...id, "commit", "-q", "-m", "the scratch project's first commit, with its own commit-msg and pre-push gates"]);
  await git(PROJECT, ["remote", "add", "github", REMOTE]);
  await git(PROJECT, ["push", "-q", "github", "main"]);
  // The two worktrees the chart is about: one whose branch IS on the remote, one whose branch is not.
  await git(PROJECT, ["worktree", "add", "-q", "-b", PUSHED_BRANCH, PUSHED_TREE]);
  await git(PUSHED_TREE, [...id, "commit", "-q", "--allow-empty", "-m", "work that is already on the remote"]);
  await git(PROJECT, ["push", "-q", "github", PUSHED_BRANCH]);
  await git(PUSHED_TREE, [...id, "commit", "-q", "--allow-empty", "-m", "a later local commit on a pushed branch"]);
  await git(PROJECT, ["worktree", "add", "-q", "-b", LOCAL_BRANCH, LOCAL_TREE]);
  await git(LOCAL_TREE, [...id, "commit", "-q", "--allow-empty", "-m", "work that exists only on this box"]);
}

// ---------------------------------------------------------------------------------------------------------------
// the stand-in Runs API: enough of the Runs API for a spawn to be real (a probe, a run, a stream that ends) so the
// panel cuts a worktree and installs its guard — and nothing that costs money or needs a key.
// ---------------------------------------------------------------------------------------------------------------
function startStub() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const json = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/v1/capabilities") {
        stubState.capabilities += 1;
        // The feature names the panel actually reads (`lib/jobs.js` probe): `runs` is not one of them.
        return json(200, {
          object: "hermes.capabilities",
          features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true, run_budget: true, max_turns: true },
          version: "proof",
        });
      }
      if (url.pathname === "/v1/runs" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(body || "{}");
          } catch {
            /* the shape is checked by the assertions, not here */
          }
          const runId = `run_proof${stubState.runs.length + 1}`;
          stubState.runs.push({ runId, body: parsed });
          json(200, { object: "hermes.run", run_id: runId, status: "running" });
        });
        return;
      }
      const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (events) {
        const runId = events[1];
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": open\n\n");
        res.write(`id: 1\ndata: ${JSON.stringify({ event: "text.delta", run_id: runId, timestamp: Date.now() / 1000, text: "proof worker: nothing to do\n" })}\n\n`);
        res.write(`id: 2\ndata: ${JSON.stringify({ event: "run.completed", run_id: runId, timestamp: Date.now() / 1000, status: "completed" })}\n\n`);
        // Held open for a moment the way the gateway holds a stream, then closed.
        setTimeout(() => res.end(), 250);
        return;
      }
      const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (one) return json(200, { object: "hermes.run", run_id: one[1], status: "completed" });
      const stop = /^\/v1\/runs\/([^/]+)\/stop$/.exec(url.pathname);
      if (stop) return json(200, { object: "hermes.run", run_id: stop[1], status: "cancelled" });
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found", code: "not_found" } }));
    });
    stub.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${stub.address().port}`));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// the panel instance
// ---------------------------------------------------------------------------------------------------------------
const PORT = 7900 + Math.floor(Math.random() * 80);
function writeConfig(stubUrl, extra = {}) {
  const cfg = {
    port: PORT,
    host: "127.0.0.1",
    scanRoots: [`${S}/repos`],
    projects: [{ name: "prooflib", path: PROJECT, remote: "github", mainBranch: "main", prRepo: "JLRoper/proof-repo" }],
    worktreeSeconds: 2,
    midSeconds: 3,
    dormantSeconds: 4,
    slowSeconds: 5,
    refreshSeconds: 600,
    fetchSeconds: 99999,
    prCacheSeconds: 99999,
    remoteCacheSeconds: 4,
    liveSeconds: 2,
    hideOlderThanDays: 0,
    defaultCwd: PROJECT,
    jobsFile: `${S}/panel/logs/jobs.json`,
    assistantFile: `${S}/panel/logs/assistant.json`,
    treeNamesFile: `${S}/panel/logs/tree-names.json`,
    descriptionsFile: `${S}/panel/logs/descriptions.json`,
    modelPricingFile: `${S}/panel/logs/model-prices.json`,
    pushGuardFile: `${S}/panel/logs/push-guard.json`,
    projectsCacheFile: `${S}/panel/logs/projects.json`,
    treeNames: null,
    assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
    // A short window keeps the guard's own poll and the box's countdown inside a test's patience.
    remoteWriteSeconds: 25,
    apiServer: { url: stubUrl, key: "proof-key" },
    discovery: { worktreeSource: "git" },
    ...extra,
  };
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  // Where this project's links go. The panel merges the SHIPPED seed (hosts.seed.json: github + git.sefl.com) under
  // the live file, so the sandbox only has to say which host prooflib belongs to — the link shapes are the seed's.
  mkdirSync(`${S}/panel/logs`, { recursive: true });
  writeFileSync(`${S}/panel/logs/hosts.json`, `${JSON.stringify({ version: 1, hosts: {}, projects: { prooflib: { host: "github", coordinates: { repo: "proof-repo" } } } }, null, 2)}\n`, "utf8");
  cfg.hostsFile = `${S}/panel/logs/hosts.json`;
  cfg.hostsSeedFile = `${normWin(REPO)}/hosts.seed.json`;
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return cfg;
}

async function startPanel() {
  // The script is named by ABSOLUTE path and the cwd is the sandbox: the panel's own `logs/` (and its pid file)
  // then land in the scratch tree rather than in this checkout.
  panel = spawn(process.execPath, [`${normWin(REPO)}/server.js`], {
    cwd: PANEL_CWD,
    env: { ...process.env, PANEL_CONFIG: CONFIG, HERMES_HOME: HOME, ASSISTANT_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // The panel's own log is kept, in memory and on disk: a phase that fails here is usually a server-side refusal,
  // and the sentence it wrote is the answer.
  panelLog = "";
  const logPath = `${S}/panel/panel.log`;
  panel.stdout.on("data", (d) => {
    panelLog += String(d);
  });
  panel.stderr.on("data", (d) => {
    panelLog += String(d);
  });
  panel.on("exit", () => writeFileSync(logPath, panelLog, "utf8"));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return JSON.parse(await r.text());
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`the sandbox panel never answered on :${PORT}. Log:\n${panelLog.slice(-2000)}`);
}

async function stopPanel() {
  if (!panel) return;
  const pid = panel.pid;
  panel = null;
  killTree(pid);
  await sleep(500);
}

const api = async (route, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${route}`, opts);
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
};
const post = (route, body) => api(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

const rowFor = async (branch) => {
  const { body } = await api("/api/state");
  const project = (body.projects || []).find((p) => p.name === "prooflib") || null;
  const rows = project?.worktrees || [];
  return { project, row: rows.find((r) => r.branch === branch) || null, rows };
};
async function waitForRow(branch, predicate, ms = 40000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await rowFor(branch);
    if (last.row && predicate(last.row)) return last;
    await sleep(400);
  }
  return last;
}

// ---------------------------------------------------------------------------------------------------------------
// the phases
// ---------------------------------------------------------------------------------------------------------------
async function phase1Links() {
  console.log("\n== A. the branch cell: a link when the remote has the branch, plain text when it does not ==");
  const pushed = await waitForRow(PUSHED_BRANCH, (r) => Boolean(r.remoteBranch) && r.remoteBranch !== "unknown");
  ok("the pushed branch's row is on the board", Boolean(pushed.row), pushed.row?.path);
  check("the remote's own answer for it", pushed.row?.remoteBranch, "exists");
  check("so the cell carries a link to the branch's page", pushed.row?.branchUrl, `https://github.com/JLRoper/proof-repo/tree/${PUSHED_BRANCH}`);
  check("and the project's remote was parsed into the repo", pushed.project?.prRepo, "JLRoper/proof-repo");
  check("the link came from the remote's own list", pushed.row?.branchLinkFrom, "remote");
  check("no reason to print for a linked branch", pushed.row?.branchWhy, "");

  const local = await waitForRow(LOCAL_BRANCH, (r) => Boolean(r.remoteBranch) && r.remoteBranch !== "unknown");
  ok("the local-only branch's row is on the board", Boolean(local.row), local.row?.path);
  check("the remote's own answer for it", local.row?.remoteBranch, "gone");
  check("so there is NO link (never one that would 404)", local.row?.branchUrl, null);
  ok("the cell says why, in the reader's words", /^local only — this branch has no copy on the remote/.test(String(local.row?.branchWhy)), local.row?.branchWhy);
  say(`branch title: "${local.row?.branchWhy}"`);
}

async function phase2UrlPolicy() {
  console.log("\n== A. the link templates, as a pure function over the mapping (the panel's own modules, called directly — no browser) ==");
  const { linkFor, readHostsFile, mergeDocs } = await import(`file:///${normWin(REPO)}/lib/hosts.js`);
  const { branchLink: branchLinkFor } = await import(`file:///${normWin(REPO)}/lib/project.js`);
  // The same two files the sandbox panel reads: the shipped seed under the sandbox's own live file.
  const doc = mergeDocs(readHostsFile(`${normWin(REPO)}/hosts.seed.json`), readHostsFile(`${S}/panel/logs/hosts.json`));
  // The project parser itself, not a copy of its regex: `githubRepo()` is what `probe()` uses, and it is the only
  // place a remote URL is read. A change to it changes these answers.
  const { githubRepo: parsed } = await import(`file:///${normWin(REPO)}/lib/projects.js`);
  check("git@github.com:owner/repo.git", parsed("git@github.com:owner/repo.git"), "owner/repo");
  check("ssh://git@github.com/owner/repo.git", parsed("ssh://git@github.com/owner/repo.git"), "owner/repo");
  check("https://github.com/owner/repo", parsed("https://github.com/owner/repo"), "owner/repo");
  check("https://github.com/owner/repo.git (trailing .git stripped)", parsed("https://github.com/owner/repo.git"), "owner/repo");
  check("a gitlab remote is NOT parsed (so it gets no link)", parsed("git@gitlab.com:owner/repo.git"), null);
  check("nor a bare local path", parsed("C:/ProjectDevelopment/some-repo"), null);
  const prooflib = { name: "prooflib", mainBranch: "main" };
  check("branch page shape (from links.branch)", linkFor(doc, prooflib, "branch", { branch: "wtgui/x-1a2b3c" }).url, "https://github.com/JLRoper/proof-repo/tree/wtgui/x-1a2b3c");
  check("a branch with a slash keeps its slashes un-encoded in a path", linkFor(doc, prooflib, "branch", { branch: "a/b" }).url, "https://github.com/JLRoper/proof-repo/tree/a/b");
  check("unmapped project, no link", linkFor(doc, { name: "nothing-mapped" }, "branch", { branch: "main" }).url, null);
  ok("and the sentence names the file to edit", /logs\/hosts\.json/.test(String(linkFor(doc, { name: "nothing-mapped" }, "branch", { branch: "main" }).why)), linkFor(doc, { name: "nothing-mapped" }, "branch", { branch: "main" }).why);

  const project = { name: "prooflib", remote: "github" };
  check("a branch the remote has → the page", branchLinkFor({ project, row: { branch: "x", remoteBranch: "exists" }, hosts: doc }).url, "https://github.com/JLRoper/proof-repo/tree/x");
  check("a branch it does not → no link, and a reason", branchLinkFor({ project, row: { branch: "x", remoteBranch: "gone" }, hosts: doc }).url, null);
  check("no remote at all → no link, and that reason", branchLinkFor({ project: { name: "prooflib", remote: null }, row: { branch: "x", remoteBranch: "n/a" }, hosts: doc }).why, "no remote configured");
  check(
    "an unreachable remote falls back to the last fetch's refs",
    branchLinkFor({ project, row: { branch: "x", remoteBranch: "unknown" }, offline: new Set(["x"]), hosts: doc }).url,
    "https://github.com/JLRoper/proof-repo/tree/x",
  );
  check(
    "and stays plain when that fetch knows nothing either",
    branchLinkFor({ project, row: { branch: "x", remoteBranch: "unknown" }, offline: new Set(), hosts: doc }).url,
    null,
  );
  // A project nobody mapped: the remote answer does not turn into a guessed URL.
  check("an unmapped project with the branch present → no link", branchLinkFor({ project: { name: "nothing-mapped", remote: "origin" }, row: { branch: "main", remoteBranch: "exists" }, hosts: doc }).url, null);
}

async function phase3Setting(stubUrl) {
  console.log("\n== C. the setting: default local-only, written to config.json, surviving a restart ==");
  const { body: health } = await api("/api/health");
  check("the default is local only", health.settings.remoteBranchPolicy, "local-only");
  check("the config file the panel booted from has no policy key yet", JSON.parse(readFileSync(CONFIG, "utf8")).remoteBranchPolicy, undefined);

  const bad = await post("/api/settings/remote-branches", { policy: "sometimes" });
  check("an unknown value is refused", bad.status, 400);
  ok("and the refusal names the values", /must be one of: local-only, allow, deny/.test(String(bad.body.error)), bad.body.error);

  const allowed = await post("/api/settings/remote-branches", { policy: "allow" });
  check("allow is accepted", allowed.status, 200);
  check("the setting the panel reports is the new one", allowed.body.settings.remoteBranchPolicy, "allow");
  check("and it was WRITTEN to this panel's config.json", JSON.parse(readFileSync(CONFIG, "utf8")).remoteBranchPolicy, "allow");

  // A restart is the only thing that proves persistence rather than an in-memory value.
  await stopPanel();
  const health2 = await startPanel();
  check("after a panel restart the setting is still there", health2.settings.remoteBranchPolicy, "allow");

  const back = await post("/api/settings/remote-branches", { policy: "local-only" });
  check("putting it back works too", back.body.settings.remoteBranchPolicy, "local-only");
  check("config.json follows", JSON.parse(readFileSync(CONFIG, "utf8")).remoteBranchPolicy, "local-only");
  return stubUrl;
}

async function phase4DefaultSpawn() {
  console.log("\n== B. a fresh spawn under the default: no remote branch, no upstream, and the guard in the way ==");
  const spawn = await api("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "prooflib", cwd: PROJECT, prompt: "Write a one-line note about the scratch project and stop." }),
  });
  check("the spawn is accepted", spawn.status, 202);
  const job = spawn.body.job;
  ok("the panel cut a worktree for it", Boolean(job?.worktreePath), job?.worktreePath);
  const tree = normWin(job.worktreePath || "");
  const branch = job.branch || "";
  say(`tree: ${tree}`);
  say(`branch: ${branch}`);

  // What the run was actually POSTed, read off the stand-in gateway: the LOCAL-ONLY line leads the brief.
  const run = runFor("one-line note about the scratch project");
  ok("the run carried a brief at all", Boolean(run?.body?.input), run?.body?.input?.slice(0, 80));
  ok("the brief OPENS with the local-only line", String(run?.body?.input || "").startsWith("LOCAL-ONLY: this worktree"), String(run?.body?.input || "").slice(0, 160));
  say(`brief line: "${String(run?.body?.input || "").split("\n")[0]}"`);
  ok("it says what not to do", /do not `git push`, do not create a remote branch and do not open a pull request/.test(String(run?.body?.input)), null);
  ok("the reader's own prompt is still in there, after it", String(run?.body?.input || "").includes("Write a one-line note about the scratch project"), null);

  const lsRemote = await git(PROJECT, ["ls-remote", "--heads", "github", branch]);
  check(`'git ls-remote --heads github ${branch}' from the project: nothing`, lsRemote.out, "");
  const upstream = await git(tree, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  ok("'git rev-parse --abbrev-ref @{upstream}' FAILS in the new tree", !upstream.ok, upstream.err || upstream.out);
  say(`upstream error: "${(upstream.err || "").split("\n")[0]}"`);
  check("the tree still works as a tree (it is on its own branch)", (await git(tree, ["rev-parse", "--abbrev-ref", "HEAD"])).out, branch);

  const hooksPath = await git(tree, ["config", "--get", "core.hooksPath"]);
  const guardDir = normWin(hooksPath.out || "");
  ok("the panel installed the push guard on that tree", guardDir.includes("/.git/wtgui-hooks"), guardDir);
  ok("the guard is a real hook file", existsSync(`${guardDir}/pre-push`), `${guardDir}/pre-push`);
  // A CR at the end of a line makes a shell script unrunnable, and this checkout stores its own source as CRLF:
  // the hook is the one file the endings have to be converted for.
  const hookText = existsSync(`${guardDir}/pre-push`) ? readFileSync(`${guardDir}/pre-push`, "utf8") : "";
  ok("the guard's script is LF, not CRLF", hookText.length > 0 && !hookText.includes(String.fromCharCode(13)), `${hookText.length} chars`);
  check("its policy copy says local-only", readFileSync(`${guardDir}/policy`, "utf8").trim(), "local-only");
  const shim = existsSync(`${guardDir}/commit-msg`) ? readFileSync(`${guardDir}/commit-msg`, "utf8") : "";
  ok("the reader's own commit-msg gate got a shim, so it still runs", /exec .*\.githooks\/commit-msg/.test(shim), shim.split("\n")[3]);
  // A pre-push the worktree already had cannot be shimmed (the guard OWNS that name): it is chained instead, from
  // every path that allows a push. This is the half that would silently switch off a version gate.
  const chained = (existsSync(`${guardDir}/chain`) ? readFileSync(`${guardDir}/chain`, "utf8") : "").trim();
  check("the tree's own pre-push is recorded for chaining", chained, `${tree}/.githooks/pre-push`);
  ok("and it is the tracked gate that came with the tree", existsSync(`${tree}/.githooks/pre-push`), `${tree}/.githooks/pre-push`);
  const commit = await git(tree, ["-c", "user.email=proof@localhost", "-c", "user.name=proof", "commit", "-q", "--allow-empty", "-m", "a commit made inside the guarded tree"]);
  ok("and a commit in the guarded tree still goes through it", commit.ok, commit.err || commit.out);
  // The guard is per-worktree: the project's own checkout must be untouched.
  const mainHooks = await git(PROJECT, ["config", "--get", "core.hooksPath"]);
  check("the project's own checkout kept its own hooks path", mainHooks.out, ".githooks");
  return { tree, branch };
}

// Run a push in the tree and wait for the PANEL's permission box to have it parked. Returns the parked request.
async function pushParked(tree, branch, config = {}) {
  const push = pexec("git", ["-C", tree, "push", ...(config.args || []), "github", branch], {
    timeout: config.timeout || 60000,
    windowsHide: true,
    env: { ...GIT_ENV, ...(config.env || {}) },
  }).then(
    (r) => ({ code: 0, out: String(r.stdout || ""), err: String(r.stderr || "") }),
    (e) => ({ code: e.code || 1, out: String(e.stdout || ""), err: String(e.stderr || e.message || "") }),
  );
  let request = null;
  const deadline = Date.now() + (config.parkMs || 30000);
  while (Date.now() < deadline) {
    const { body } = await api("/api/remote-write/state");
    request = (body.pending || [])[0] || null;
    if (request) break;
    await sleep(200);
  }
  return { push, request };
}

async function phase5Box(tree, branch) {
  console.log("\n== C. a push out of a local-only tree: the box appears, Deny stops it, Allow once lets it through ==");
  const first = await pushParked(tree, branch);
  ok("the guard parked the push on the panel instead of pushing", Boolean(first.request), first.request?.id);
  check("the question is about a push", first.request?.kind, "push");
  check("it names the tree's branch", first.request?.branch, branch);
  check("it offers the same four choices an approval does", first.request?.allowed, ["once", "session", "always", "deny"]);
  ok("and it carries the command that would run", /^git push github /.test(String(first.request?.command)), first.request?.command);
  say(`box head: "⚠ waiting on you — a push from this worktree: prooflib is local-only"`);
  say(`box command: "${first.request?.command}"`);

  const denied = await post("/api/remote-write/answer", { id: first.request.id, choice: "deny" });
  check("Deny is accepted", denied.status, 200);
  check("and recorded as a denial", denied.body.choice, "deny");
  const deniedPush = await first.push;
  ok("the push FAILED", deniedPush.code !== 0, deniedPush.code);
  const headsAfterDeny = await git(PROJECT, ["ls-remote", "--heads", "github", branch]);
  check("the remote is untouched — no branch", headsAfterDeny.out, "");
  say("the exact text a blocked push produces:");
  for (const line of deniedPush.err.split("\n").filter(Boolean)) say(`  | ${line}`);
  const status = await api(`/api/remote-write/status?id=${encodeURIComponent(first.request.id)}`);
  check("the hook was told the answer", status.body.choice, "deny");
  const state = await api("/api/remote-write/state");
  check("nothing is parked any more", (state.body.pending || []).length, 0);

  // The same attempt again, allowed once.
  const second = await pushParked(tree, branch);
  ok("a second attempt parks again (the denial was not remembered)", Boolean(second.request), second.request?.id);
  const allowed = await post("/api/remote-write/answer", { id: second.request.id, choice: "once" });
  check("Allow once is accepted", allowed.body.choice, "once");
  const allowedPush = await second.push;
  check("and the SAME attempt now goes through", allowedPush.code, 0);
  const headsAfterAllow = await git(PROJECT, ["ls-remote", "--heads", "github", branch]);
  ok("the remote has the branch", new RegExp(`refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(headsAfterAllow.out), headsAfterAllow.out.split("\n")[0]);
  say(`remote now: ${headsAfterAllow.out.replace(/\t/g, " ")}`);
  // "Allow once" is ONE write, not a standing permission: the very next attempt has to park again.
  const third = await pushParked(tree, branch);
  ok("a THIRD attempt parks again — 'once' was not remembered as a standing grant", Boolean(third.request), third.request?.id);
  await post("/api/remote-write/answer", { id: third.request?.id, choice: "deny" });
  await third.push;
  return { tree, branch };
}

async function phase6LinkFollowsTheRemote() {
  console.log("\n== A. the same cell turns into a link once the remote HAS the branch (the decision is git's, not a URL's) ==");
  const after = await waitForRow(PHASE5.branch, (r) => Boolean(r.branchUrl), 40000);
  check("the branch cell is a link now", after.row?.branchUrl, `https://github.com/JLRoper/proof-repo/tree/${PHASE5.branch}`);
  check("read from the remote's own list", after.row?.branchLinkFrom, "remote");
}

async function phase7WillLand() {
  console.log("\n== B. the will-land opt-in: the brief says the opposite, and the push needs no box ==");
  const spawn = await api("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: "prooflib", cwd: PROJECT, landing: true, prompt: "Land a one-line note about the scratch project." }),
  });
  check("the spawn is accepted", spawn.status, 202);
  const job = spawn.body.job;
  const tree = normWin(job?.worktreePath || "");
  const branch = job.branch || "";
  const run = runFor("Land a one-line note about the scratch project");
  ok("the brief OPENS with the landing line instead", String(run?.body?.input || "").startsWith("WILL LAND: this worktree"), String(run?.body?.input || "").slice(0, 120));
  say(`brief line: "${String(run?.body?.input || "").split("\n")[0]}"`);
  ok("and it NAMES the landing step", /git push -u github HEAD/.test(String(run?.body?.input || "")) && /gh pr create/.test(String(run?.body?.input)), null);
  await git(tree, ["-c", "user.email=proof@localhost", "-c", "user.name=proof", "commit", "-q", "--allow-empty", "-m", "a commit from a worktree that is meant to land"]);

  const pushOnce = () =>
    pexec("git", ["-C", tree, "push", "github", branch], { timeout: 60000, windowsHide: true, env: GIT_ENV }).then(
      (r) => ({ code: 0, err: String(r.stderr || "") }),
      (e) => ({ code: e.code || 1, err: String(e.stderr || e.message || "") }),
    );
  const push = await pushOnce();
  check("the push goes through with no box at all", push.code, 0);
  // …and it went through the worktree's OWN pre-push on the way (the guard chains it rather than shadowing it).
  ok("the tree's own pre-push ran on the allowed path", push.err.includes("GATE: pre-push ran"), push.err.split("\n").filter(Boolean)[0]);
  const heads = await git(PROJECT, ["ls-remote", "--heads", "github", branch]);
  ok("and the remote has that branch", heads.out.includes(branch), heads.out.replace(/\t/g, " "));
  const parked = await api("/api/remote-write/state");
  check("nothing was parked for it", (parked.body.pending || []).length, 0);

  // The other direction: a chained pre-push that REFUSES is the refusal, even from a tree the guard allows.
  const gate = `${tree}/.githooks/pre-push`;
  const original = readFileSync(gate, "utf8");
  writeFileSync(gate, "#!/bin/sh\necho 'GATE: pre-push REFUSED this branch' >&2\nexit 1\n", "utf8");
  await git(tree, ["-c", "user.email=proof@localhost", "-c", "user.name=proof", "commit", "-q", "--allow-empty", "-m", "a commit the chained gate will refuse to carry"]);
  const refused = await pushOnce();
  ok("a refusing chained gate still refuses the push", refused.code !== 0, refused.code);
  ok("and the refusal is attributed to the gate, not to the guard", refused.err.includes("the pre-push hook this worktree already had refused this push"), refused.err.split("\n").filter(Boolean)[0]);
  writeFileSync(gate, original, "utf8");
  const again = await pushOnce();
  check("with the gate restored, the same push goes through", again.code, 0);
}

async function phase8MergeAsksFirst() {
  console.log("\n== C. the panel's OWN remote write (the merge flow) asks through the same box ==");
  const merge = await post("/api/worktree/merge", { project: "prooflib", path: PHASE5.tree });
  check("the merge is accepted as a QUESTION, not started", merge.status, 202);
  check("and it is a parked request of kind merge", merge.body.pending?.kind, "merge");
  const { body: jobs } = await api("/api/jobs");
  ok(
    "no merge agent was started while the question is open",
    !(jobs.jobs || []).some((j) => String(j.label || "").startsWith("MERGING into ")),
    (jobs.jobs || []).map((j) => j.label).filter(Boolean),
  );
  const ready = await api("/api/remote-write/state");
  const req = (ready.body.pending || []).find((r) => r.kind === "merge");
  ok("the box says what would be pushed", /^git push github main/.test(String(req?.command)), req?.command);
  const denied = await post("/api/remote-write/answer", { id: req.id, choice: "deny" });
  check("Deny is accepted", denied.body.choice, "deny");
  const { body: jobs2 } = await api("/api/jobs");
  ok(
    "and still nothing was started — Deny starts no merge at all",
    !(jobs2.jobs || []).some((j) => String(j.label || "").startsWith("MERGING into ")),
    (jobs2.jobs || []).map((j) => j.label).filter(Boolean),
  );
  const preview = await post("/api/worktree/merge", { project: "prooflib", path: PHASE5.tree, dryRun: true });
  check("a dry run still answers without asking anything", preview.status, 200);
  check("and it hands the prompt back untouched", typeof preview.body.prompt, "string");
}

// ---------------------------------------------------------------------------------------------------------------
// the browser half: the CELL as it is really rendered, and the click not firing the row's own gesture
// ---------------------------------------------------------------------------------------------------------------
function loadPlaywright() {
  const roots = [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, REPO, process.cwd()].filter(Boolean);
  for (const root of roots) {
    for (const candidate of [path.join(root, "node_modules", "playwright"), root]) {
      try {
        return require(candidate);
      } catch {
        /* not there */
      }
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

async function phase9Browser() {
  console.log("\n== A. the browser half: the rendered cell, and the link that does not fire the row ==");
  if (NO_BROWSER) {
    console.log("BROWSER-HALF-NOT-RUN  --no-browser was passed, so the cell was not rendered anywhere.");
    failures += 1;
    return;
  }
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log("BROWSER-HALF-NOT-RUN  no Playwright install found; the client half was not exercised.");
    say("re-run with PANEL_PLAYWRIGHT_ROOT=<a dir holding node_modules/playwright>");
    failures += 1;
    return;
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    // A fresh context has no remembered layout, so the project's rows would never be on the page: seed the fold
    // the same way the reader's browser would have it.
    await context.addInitScript(() => {
      try {
        localStorage.setItem("wm.expandedProjects", JSON.stringify(["prooflib"]));
      } catch {
        /* storage off: the click below opens it instead */
      }
    });
    const page = await context.newPage();
    const popups = [];
    context.on("page", (p) => popups.push(p));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(document.querySelector("section.project[data-project]")), null, { timeout: 30000 });
    // Open the project if the seeded fold did not take (a state the reader's own click would produce).
    const rowCount = await page.locator("tr.row").count();
    if (!rowCount) {
      await page.locator('section.project[data-project="prooflib"] .project-head').first().click();
    }
    await page.waitForFunction(
      (b) => [...document.querySelectorAll("tr.row")].some((tr) => (tr.querySelector("td.branch")?.textContent || "").includes(b)),
      PHASE5.branch,
      { timeout: 60000 },
    );
    const cellHtml = async (branch) =>
      page.evaluate((b) => {
        const tr = [...document.querySelectorAll("tr.row")].find((t) => (t.querySelector("td.branch")?.textContent || "").includes(b));
        return tr ? tr.querySelector("td.branch").innerHTML : null;
      }, branch);

    const pushedCell = await cellHtml(PHASE5.branch);
    say(`rendered cell (branch on the remote): ${pushedCell}`);
    const href = await page.evaluate((b) => {
      const a = [...document.querySelectorAll("tr.row td.branch a.branch-link")].find((x) => x.textContent.includes(b));
      return a ? a.getAttribute("href") : null;
    }, PHASE5.branch);
    check("the href is the branch's page on the remote", href, `https://github.com/JLRoper/proof-repo/tree/${PHASE5.branch}`);
    ok("it opens in a new tab and cannot reach back into this page", /target="_blank"/.test(pushedCell) && /rel="noopener"/.test(pushedCell), pushedCell);

    const localCell = await cellHtml(LOCAL_BRANCH);
    say(`rendered cell (local-only branch): ${localCell}`);
    ok("the local-only cell is PLAIN TEXT — no anchor at all", !/<a\b/.test(String(localCell)), localCell);
    const localTitle = await page.evaluate((b) => {
      const span = [...document.querySelectorAll("tr.row td.branch .branch-plain")].find((x) => x.textContent.includes(b));
      return span ? span.getAttribute("title") : null;
    }, LOCAL_BRANCH);
    say(`its title: "${localTitle}"`);
    ok("and says why", /^local only — this branch has no copy on the remote/.test(String(localTitle)), localTitle);
    const marker = await page.evaluate((b) => {
      const el = [...document.querySelectorAll("tr.row td.branch .branch-local")].find((x) => x.closest("td.branch").textContent.includes(b));
      return el ? el.textContent : null;
    }, LOCAL_BRANCH);
    check("with a one-word marker on the row", marker, "local");

    // The click: it must open the remote page and NOT toggle the row (the row's own gesture).
    const key = await page.evaluate((b) => {
      const a = [...document.querySelectorAll("tr.row td.branch a.branch-link")].find((x) => x.textContent.includes(b));
      return a ? a.closest("tr.row").dataset.key : null;
    }, PHASE5.branch);
    const expandedBefore = await page.evaluate((k) => Boolean(document.querySelector(`tr.detail[data-detail="${CSS.escape(k)}"]`)), key);
    await page.locator("tr.row td.branch a.branch-link", { hasText: PHASE5.branch }).first().click();
    await sleep(700);
    const expandedAfter = await page.evaluate((k) => Boolean(document.querySelector(`tr.detail[data-detail="${CSS.escape(k)}"]`)), key);
    check("clicking the link did not open the row", { before: expandedBefore, after: expandedAfter }, { before: false, after: false });
    for (const p of popups) await p.close().catch(() => {});
    ok("and it did open something new (the branch page)", popups.length > 0, popups.length);
    // A control in the same window: clicking the row itself still opens it, so "nothing happened" above is not
    // simply a dead page.
    await page.evaluate((k) => document.querySelector(`tr.row[data-key="${CSS.escape(k)}"] td.name`).click(), key);
    await sleep(600);
    const expandedByRow = await page.evaluate((k) => Boolean(document.querySelector(`tr.detail[data-detail="${CSS.escape(k)}"]`)), key);
    ok("the row's own click still opens it (positive control)", expandedByRow, expandedByRow);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------------------------
let PHASE4 = null;
let PHASE5 = null;
try {
  console.log(`scratch: ${S}`);
  await makeFixture();
  const stubUrl = await startStub();
  writeConfig(stubUrl);
  await startPanel();
  say(`sandbox panel on :${PORT} (config ${CONFIG}); stand-in Runs API at ${stubUrl}`);

  await phase1Links();
  await phase2UrlPolicy();
  await phase3Setting(stubUrl);
  PHASE4 = await phase4DefaultSpawn();
  PHASE5 = await phase5Box(PHASE4.tree, PHASE4.branch);
  await phase6LinkFollowsTheRemote();
  await phase7WillLand();
  await phase8MergeAsksFirst();
  await phase9Browser();
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run itself threw: ${String((e && e.stack) || e)}`);
} finally {
  await stopPanel();
  if (stub) await new Promise((r) => stub.close(r));
  // The scratch root goes last, once nothing the panel started can still be holding a directory in it.
  await sleep(300);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failed`);
console.log(failures ? "RESULT: FAILED" : "RESULT: ALL PASS");
process.exit(failures ? 1 : 0);
