#!/usr/bin/env node
// tools/check-env.mjs — the environment preflight: can this machine run the panel, and can git reach a remote?
//
// WHY: the failures this names are invisible until a fetch or a start misbehaves, and the message names the
// symptom, not the cause. 2026-11-04: git fetch refused with "Host key verification failed" while
// `ssh -T <host>` authenticated fine — git ran the ssh it BUNDLES, and that ssh resolved `~` from HOME (unset
// here) and the Windows home variables (HOMEDRIVE/HOMEPATH, here a redirected folder), so it read a `.ssh`
// with no known_hosts, no config and no keys, while Windows' own ssh read the profile's `.ssh` and worked.
// Two ssh clients, two home directories, one confusing error. The fix is one environment variable, and the
// hunt for it is what this tool removes.
//
//   node tools/check-env.mjs                     check this checkout's environment
//   node tools/check-env.mjs --remote <url|dir>  probe that remote (a URL, or a project directory's origin)
//                                                instead of this checkout's origin — how a "project X will
//                                                not fetch" report is reproduced
//   node tools/check-env.mjs --config <file>     answer for that config file (fixtures and tests: PANEL_CONFIG)
//
// Read-only: it writes nothing and changes nothing. Network use is one `git ls-remote` of one remote; every
// other probe is loopback (the panel's own port) or offline (`ssh -G` plus file checks). Exit 0 when every
// hard check passed, 1 when one failed, 2 on a usage error. The panel not running and the gateway not running
// are WARNINGS, not failures: they are states to name, not defects.
//
// A hard check is one this machine must fix before the panel can do its job: node below the engines floor, no
// git, a remote git cannot reach. Each failed line is followed by the raw output and the fix for its class —
// the same block a "my fetch will not work" report should carry.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLayout } from "../lib/paths.js";
import { portAnswers } from "../lib/port-guard.js";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- pure helpers (exported: the test pins these without a network) ----------

// `engines.node` ("24.5", ">=22.5", "^20.10 || >=22") -> the floor [major, minor], or null when no `>=` floor
// is written. Only `>=` is read: that is the shape this repo uses, and a caret's semantics are not worth
// guessing in a preflight — a range the tool cannot read is reported, never enforced.
export function engineFloor(range) {
  const m = /(?:^|[^0-9.])>=\s*(\d+)(?:\.(\d+))?/.exec(String(range || ""));
  return m ? [Number(m[1]), Number(m[2] || 0)] : null;
}

export function versionAtLeast(version, floor) {
  const [major = 0, minor = 0] = String(version || "").split(".").map((n) => parseInt(n, 10) || 0);
  return major > floor[0] || (major === floor[0] && minor >= floor[1]);
}

// An ssh command line as the two halves git treats it as: the executable and its leading options. Quoted
// tokens survive, because a doctor that cannot read the command it is diagnosing is worse than none.
export function splitCommand(text) {
  const parts = String(text || "").match(/"[^"]*"|\S+/g) || [];
  const clean = parts.map((p) => p.replace(/^"|"$/g, ""));
  return { cmd: clean[0] || "", args: clean.slice(1) };
}

// The ssh destination in a remote URL, or null when the URL is not ssh: `ssh://` URLs and scp syntax
// (`user@host:path`). A single-letter "host" is refused — a drive-letter path is not host "C" — the same rule
// tools/absolute-paths.mjs applies to drive letters.
export function sshTarget(url) {
  const s = String(url || "").trim();
  let m = /^ssh:\/\/(?:([^@/]+)@)?([^:/]+)(?::(\d+))?\//.exec(s);
  if (m) return { user: m[1] || null, host: m[2], port: m[3] ? Number(m[3]) : null };
  m = /^(?:([^@/]+)@)?([^:/]+):(?!\/)/.exec(s);
  if (m && !(m[2].length === 1 && /[A-Za-z]/.test(m[2]))) return { user: m[1] || null, host: m[2], port: null };
  return null;
}

// What a failed git/ssh attempt says about WHERE it broke. `hostkey` and `auth` are the two an environment
// fix answers; the rest are named so the fix lines can be honest about not being this machine's to fix.
export function classifyGitFailure(text) {
  const t = String(text || "");
  if (/host key verification failed/i.test(t)) return "hostkey";
  if (/permission denied \(publickey\)/i.test(t)) return "auth";
  if (/cannot prompt|interactivity has been disabled|terminal prompts disabled/i.test(t)) return "interactive";
  if (/connection (refused|timed out|reset)|could not resolve|network is unreachable|broken pipe/i.test(t)) return "network";
  if (/repository not found|does not exist|does not appear to be a git repository|access denied|forbidden/i.test(t)) return "repourl";
  return "other";
}

// The `userknownhostsfile` / `identityfile` lines of one `ssh -G` run, nothing else read from it.
export function parseSshG(text) {
  const out = { userknownhostsfile: "", identityfile: [] };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*)$/.exec(raw.trim());
    if (!m) continue;
    if (m[1] === "userknownhostsfile") out.userknownhostsfile = m[2];
    else if (m[1] === "identityfile") out.identityfile.push(m[2]);
  }
  return out;
}

// Every file the ssh's `userknownhostsfile` line could name on this machine, plus the standard files under
// every home the environment knows — because the fix for the whole failure class is "read the profile's .ssh",
// and a diagnosis that never checks where the keys actually live cannot say that. `~` in the ssh's own output
// may already be expanded by the client (Git's bundled ssh prints the resolved path); both shapes are handled,
// and the result dedupes by path.
export function knownHostsCandidates(value, env = process.env, home = os.homedir()) {
  const homes = [];
  const envHome = String(env.HOME || "").trim();
  if (envHome) homes.push(envHome);
  homes.push(home);
  if (process.platform === "win32") {
    const d = String(env.HOMEDRIVE || "").trim();
    const p = String(env.HOMEPATH || "").trim();
    if (d || p) homes.push(`${d}${p}`);
  }
  const resolved = [];
  for (const item of String(value || "").split(/\s+/).filter(Boolean)) {
    if (item.startsWith("~/") || item.startsWith("~\\")) {
      for (const h of homes) resolved.push(path.join(h, item.slice(2)));
    } else {
      resolved.push(item);
    }
  }
  for (const h of homes) {
    resolved.push(path.join(h, ".ssh", "known_hosts"));
    resolved.push(path.join(h, ".ssh", "known_hosts2"));
  }
  const seen = new Set();
  const out = [];
  for (const entry of resolved) {
    const key = path.normalize(entry).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ resolved: entry });
  }
  return out;
}

// Does this known_hosts file name the host? ssh-keygen -F understands the file's real format (including hashed
// entries); the text search is the fallback for a known_hosts whose sibling does not carry the tool.
export function knowsHost(file, host, sshBin = null) {
  if (!file || !existsSync(file)) return false;
  const keygen = sshBin ? path.join(path.dirname(sshBin), process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen") : null;
  if (keygen && existsSync(keygen)) {
    try {
      const out = execFileSync(keygen, ["-F", host, "-f", file], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      return out.trim().length > 0;
    } catch {
      /* fall through to the text search */
    }
  }
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const first = (line.split(/\s+/)[0] || "").trim();
      if (!first || first.startsWith("#")) continue;
      if (first.split(",").some((name) => name === host || name.startsWith(`[${host}]:`))) return true;
    }
  } catch {
    /* unreadable */
  }
  return false;
}

// ---------- process checks ----------

function gitRun(args, { cwd = here, timeout = 20000 } = {}) {
  // Non-interactive exactly as the panel runs git (lib/scan.js GIT_ENV): a probe must fail, not wait on a human.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo" };
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", timeout, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout || "").replace(/\r\n/g, "\n").trim(),
      err: `${String(e.stderr || "")}\n${String(e.message || "")}`.replace(/\r\n/g, "\n").trim(),
    };
  }
}

// Which ssh git itself will run for an ssh remote, and why that one: the three overrides first, then the ssh
// Git for Windows prefers over PATH (its own, beside the installation — the one that resolved `~` to the wrong
// home in the incident this tool exists for), then PATH.
export function sshForGit(root = here) {
  const envCmd = String(process.env.GIT_SSH_COMMAND || "").trim();
  if (envCmd) return { ...splitCommand(envCmd), source: "GIT_SSH_COMMAND" };
  const cfg = gitRun(["config", "--get", "core.sshCommand"], { cwd: root });
  if (cfg.ok && cfg.out) return { ...splitCommand(cfg.out), source: "core.sshCommand" };
  const gssh = String(process.env.GIT_SSH || "").trim();
  if (gssh) return { cmd: gssh, args: [], source: "GIT_SSH" };
  if (process.platform === "win32") {
    const exec = gitRun(["--exec-path"]);
    if (exec.ok && exec.out) {
      const bundled = path.resolve(exec.out, "..", "..", "..", "usr", "bin", "ssh.exe");
      if (existsSync(bundled)) return { cmd: bundled, args: [], source: "the ssh Git for Windows bundles (git prefers it over PATH)" };
    }
  }
  return { cmd: "ssh", args: [], source: "ssh on PATH" };
}

function sshG(ssh, target) {
  try {
    const out = execFileSync(ssh.cmd, [...ssh.args, "-G", target.host], { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return parseSshG(out);
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
}

function readPid(file) {
  try {
    const n = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function panelHealth(port, timeoutMs = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const firstLine = (t) => String(t || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "(no output)";
const rawLines = (t, max = 3) => String(t || "").split("\n").map((s) => s.trimEnd()).filter((s) => s.trim()).slice(0, max);

// ---------- the command line ----------

const USAGE = `usage:
  node tools/check-env.mjs                     check this checkout's environment
  node tools/check-env.mjs --remote <url|dir>  probe that remote (a URL, or a directory's origin)
  node tools/check-env.mjs --config <file>     answer for that config file (fixtures and tests)
`;

async function main(argv) {
  let remoteArg = null;
  let configArg = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") {
      remoteArg = argv[i + 1];
      if (!remoteArg) return { code: 2, out: ["check-env: --remote needs a URL or a directory\n", USAGE] };
      i += 1;
    } else if (arg === "--config") {
      configArg = argv[i + 1];
      if (!configArg) return { code: 2, out: ["check-env: --config needs a file\n", USAGE] };
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      return { code: 0, out: [USAGE] };
    } else {
      return { code: 2, out: [`check-env: unknown argument "${arg}"\n`, USAGE] };
    }
  }

  const log = [];
  const tally = { ok: 0, warn: 0, fail: 0 };
  const line = (status, text) => {
    tally[status] += 1;
    log.push(`${status.padEnd(4)}  ${text}`);
  };
  const detail = (text) => log.push(`      ${text}`);
  const fix = (text) => log.push(`      fix: ${text}`);

  // ---- node ----
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
  } catch {
    /* no package.json is the engines check's problem only */
  }
  const engines = pkg && pkg.engines && pkg.engines.node;
  const floor = engineFloor(engines);
  const nodeVersion = process.versions.node;
  if (floor && !versionAtLeast(nodeVersion, floor)) {
    line("fail", `node ${nodeVersion} — this checkout's engines want ${engines}`);
    fix(`install Node ${engines} or newer — the panel is zero-dependency, so the runtime is the whole platform`);
  } else {
    line("ok", `node ${nodeVersion}${engines ? ` (engines ${engines})` : ""}`);
  }

  // ---- git ----
  const gitVersion = gitRun(["--version"]);
  if (!gitVersion.ok || !gitVersion.out) {
    line("fail", "git — not on PATH");
    fix("install git; the panel and every worktree it watches are built around the git binary");
  } else {
    line("ok", gitVersion.out.replace(/^git version /, "git "));
  }

  // ---- the remote (the one network probe) ----
  if (gitVersion.ok) {
    const remote = (() => {
      if (remoteArg) {
        const asDir = path.resolve(remoteArg);
        if (existsSync(asDir) && statSync(asDir).isDirectory()) {
          const out = gitRun(["-C", asDir, "remote", "get-url", "origin"]);
          if (out.ok && out.out) return { url: out.out };
          // A git repository with no origin (a bare clone, a local remote) is probed AS the remote — that is
          // what the person pointing at it means; a directory that is not a repository has nothing to probe.
          const isRepo = gitRun(["-C", asDir, "rev-parse", "--git-dir"]);
          if (isRepo.ok) return { url: asDir };
          return { url: null, why: `--remote ${remoteArg} is not a git repository and names no origin` };
        }
        return { url: remoteArg };
      }
      const out = gitRun(["remote", "get-url", "origin"]);
      return out.ok && out.out ? { url: out.out } : { url: null, why: "this checkout has no origin remote" };
    })();

    if (!remote.url) {
      line("warn", `remote — ${remote.why}; nothing to probe`);
    } else {
      const probe = gitRun(["ls-remote", "--heads", remote.url], { timeout: 20000 });
      if (probe.ok) {
        const heads = probe.out.split("\n").filter(Boolean).length;
        line("ok", `remote ${remote.url} — ls-remote ok (${heads} head${heads === 1 ? "" : "s"})`);
      } else {
        const text = `${probe.out}\n${probe.err}`.trim();
        const kind = classifyGitFailure(text);
        const target = sshTarget(remote.url);
        line("fail", `remote ${remote.url} — ls-remote failed: ${firstLine(text)}`);
        for (const l of rawLines(text, 3)) detail(l);

        // The diagnosis runs only after a failure, and only for ssh remotes: the two classes an environment
        // fix answers are precisely the ones where the ssh git runs and the files it reads decide.
        let diag = null;
        if (target) {
          const ssh = sshForGit();
          const g = sshG(ssh, target);
          diag = { ssh, g, files: [] };
          detail(`the ssh git will run: ${ssh.cmd} (${ssh.source})`);
          if (g && g.userknownhostsfile) {
            detail(`the known_hosts it reads: ${g.userknownhostsfile}`);
            for (const c of knownHostsCandidates(g.userknownhostsfile)) {
              const exists = existsSync(c.resolved);
              const knows = exists && knowsHost(c.resolved, target.host, ssh.cmd);
              diag.files.push({ ...c, exists, knows });
              detail(`  ${c.resolved} — ${!exists ? "does not exist" : knows ? `knows ${target.host}` : `has no entry for ${target.host}`}`);
            }
          } else {
            detail("the ssh did not answer `-G` — it may be missing, or not an ssh");
          }
          if (g && g.identityfile.length) detail(`its identity files (as written): ${g.identityfile.join(" ")}`);
        }

        const dest = target ? `${target.user || "git"}@${target.host}` : null;
        const setHome = process.platform === "win32"
          ? "cmd `set HOME=%USERPROFILE%` · PowerShell `$env:HOME=$env:USERPROFILE`"
          : "`export HOME=$HOME` from the profile that owns your keys";
        if (kind === "hostkey") {
          const knows = diag ? diag.files.filter((f) => f.knows) : [];
          if (knows.length) {
            detail("the machine already has this host's key — in a folder this ssh does not read");
            fix(`run git with HOME pointed at your profile (${setHome}), and start the panel the same way — its fetches and its agents inherit it`);
            fix(`or pin it for every command: git config --global core.sshCommand "ssh -o UserKnownHostsFile=${knows[0].resolved}" (add -o IdentityFile=... when the key is not under that .ssh either)`);
          } else {
            fix(`record ${dest}'s host key once: connect with the ssh git runs and accept it — check the fingerprint against the host's published keys first — or add a verified ssh-keyscan line to the known_hosts above`);
          }
        } else if (kind === "auth") {
          fix(`the connection reached ${dest} but the offered key was refused — confirm the key is registered for that account (ssh -T ${dest} answers "Hi …!" when it is) and that its IdentityFile resolves from the same home as the known_hosts above`);
        } else if (kind === "interactive") {
          fix("the remote asked for a username/password and git was told not to prompt (the panel runs it this way) — give it credentials a helper can supply: for GitHub `gh auth setup-git`, or switch the remote to ssh");
        } else if (kind === "network") {
          fix(`${dest} did not answer — VPN, proxy or firewall; reproduce with a plain \`ssh -T ${dest}\` to see the raw failure`);
        } else if (kind === "repourl") {
          fix("the remote answered but refused this repository — check the URL and the account's access to it");
        } else {
          fix(`compare by hand: git ls-remote ${remote.url}${dest ? ` · ssh -T ${dest}` : ""} — the raw lines above are the ground truth`);
        }
      }
    }
  } else {
    line("warn", "remote — not probed (no git)");
  }

  // ---- the panel ----
  const layout = resolveLayout({ here, env: configArg ? { ...process.env, PANEL_CONFIG: configArg } : process.env });
  const port = Number(layout.config.port) || 7331;
  const pidPath = path.join(layout.paths.logsDir, "server.pid");
  // The legacy pid file beside the checkout belongs to a DEFAULT install only: a --config instance keeps its
  // state in its own folder, and reading the developer's pid file for it would describe the wrong panel.
  const legacyPidPath = configArg ? null : path.join(here, "logs", "server.pid");
  const pidFile = existsSync(pidPath) ? pidPath : legacyPidPath && existsSync(legacyPidPath) ? legacyPidPath : null;
  const pid = pidFile ? readPid(pidFile) : null;
  const alive = pid ? pidAlive(pid) : false;
  const answered = await portAnswers("127.0.0.1", port, 800);
  if (answered && alive) {
    const health = await panelHealth(port);
    if (health && health.ok) {
      line("ok", `panel on ${port} — http://127.0.0.1:${port} answers ok:true v${health.settings && health.settings.version ? health.settings.version : "?"} (pid ${pid})`);
    } else {
      line("warn", `panel — something answers on ${port} (pid ${pid} is alive) but /api/health did not answer; another program may hold the port`);
    }
  } else if (answered && !alive) {
    line("warn", `panel — port ${port} is in use, and server.pid does not account for it; a panel start would refuse (EADDRINUSE)`);
    fix(`find the holder: netstat -ano | findstr :${port} (Windows) · lsof -i :${port} (macOS/Linux)`);
  } else if (!answered && alive) {
    line("warn", `panel — pid ${pid} is alive but nothing answers on ${port} yet (still starting, or bound elsewhere)`);
  } else if (pidFile && pid && !alive) {
    line("warn", `panel — stale ${pidFile} (pid ${pid} is not running); the launchers replace it, or remove it by hand`);
  } else {
    line("ok", `panel — not running on ${port}; start it detached with start-background.cmd, then open http://127.0.0.1:${port}`);
  }
  detail(`config ${layout.configFile.path} (${layout.configFile.source}) · data ${layout.paths.dataDir} (${layout.dirs.dataSource})`);

  // ---- the gateway ----
  const gatewayUrl = String((layout.config.apiServer && layout.config.apiServer.url) || process.env.API_SERVER_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
  let gateway = null;
  try {
    gateway = new URL(gatewayUrl);
  } catch {
    /* an unreadable URL is named below */
  }
  if (!gateway) {
    line("warn", `gateway — ${gatewayUrl} is not a URL this tool can read`);
  } else {
    const gport = gateway.port ? Number(gateway.port) : gateway.protocol === "https:" ? 443 : 80;
    const gAnswered = await portAnswers(gateway.hostname, gport, 800);
    if (gAnswered) {
      line("ok", `gateway ${gatewayUrl} — listening`);
    } else {
      line("warn", `gateway ${gatewayUrl} — not listening; new agent runs and assistant turns are refused until it is back (hermes gateway restart)`);
    }
  }

  log.push(
    `check-env: ${tally.ok} ok, ${tally.warn} warn, ${tally.fail} fail — ` +
      (tally.fail ? `${tally.fail} hard check${tally.fail === 1 ? "" : "s"} failed` : "every hard check passed"),
  );
  return { code: tally.fail ? 1 : 0, out: log };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, out } = await main(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(`${out.join("\n")}\n`);
  process.exitCode = code;
}
