// The environment preflight: node, git, the ssh git will run, the remote it must reach, the panel's port and
// pid, the gateway.
//
// WHY: on 2026-11-04 `git fetch` refused with "Host key verification failed" while `ssh -T` authenticated fine.
// git runs the ssh it bundles, and that ssh resolves `~` from HOME and the Windows home variables, so on a
// machine with a redirected home folder it read a `.ssh` with no known_hosts, no config and no keys — while
// Windows' own ssh read the profile's and worked. tools/check-env.mjs exists so the next person gets the
// diagnosis and the fix from one command. These tests pin what a test can pin without a network:
//   - the pure judgments (an engines floor, an ssh command line, a failed fetch classified, an ssh URL parsed);
//   - the command itself, in fixtures: a healthy local remote exits 0 with every line named, an unreachable
//     ssh remote exits 1 with the raw output, the ssh git would run, and a fix line;
//   - the usage errors, which must never look like a verdict about the environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyGitFailure, engineFloor, knowsHost, parseSshG, splitCommand, sshTarget, versionAtLeast } from "../tools/check-env.mjs";
import { GIT_TEST_ENV, ROOT, freePort, git } from "../tools/panel-testkit.mjs";

const TOOL = path.join(ROOT, "tools", "check-env.mjs");

function doctor(args, cwd = ROOT) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd, encoding: "utf8", env: GIT_TEST_ENV, windowsHide: true, timeout: 60000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// One config file whose port is free right now, in its own folder: PANEL_CONFIG routing keeps the run away
// from the developer's own panel state (lib/paths.js gives a PANEL_CONFIG instance its own flat logs folder,
// so a missing server.pid there means "not running", which is a stable answer).
async function fixture(t, { port } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-doctor-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, "config.json");
  await writeFile(cfg, JSON.stringify({ port: port || (await freePort()), host: "127.0.0.1" }, null, 2), "utf8");
  return { dir, cfg };
}

// ---------- the pure judgments ----------

test("the engines floor reads the one shape worth enforcing and ignores what it cannot read", () => {
  assert.deepEqual(engineFloor(">=22.5"), [22, 5]);
  assert.deepEqual(engineFloor("^20.10 || >=22.5.0"), [22, 5], "a range: the `>=` floor is still the floor");
  assert.equal(engineFloor("24"), null, "a bare number is not a floor this tool guesses at");
  assert.equal(engineFloor(""), null);
  assert.equal(versionAtLeast("26.3.0", [22, 5]), true);
  assert.equal(versionAtLeast("22.5.0", [22, 5]), true, "the floor itself passes");
  assert.equal(versionAtLeast("22.4.9", [22, 5]), false);
});

test("an ssh command line splits into the executable and its options, quotes included", () => {
  assert.deepEqual(splitCommand('"/opt/ssh dir/ssh" -o BatchMode=yes -o ConnectTimeout=8'), {
    cmd: "/opt/ssh dir/ssh",
    args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"],
  });
  assert.deepEqual(splitCommand("ssh"), { cmd: "ssh", args: [] });
});

test("a failed fetch is classified by the line that says where it broke", () => {
  assert.equal(classifyGitFailure("Host key verification failed.\nfatal: Could not read from remote repository."), "hostkey");
  assert.equal(classifyGitFailure("git@github.com: Permission denied (publickey)."), "auth");
  assert.equal(classifyGitFailure("fatal: Cannot prompt because user interactivity has been disabled."), "interactive");
  assert.equal(classifyGitFailure("ssh: connect to host 127.0.0.1 port 1: Connection refused"), "network");
  assert.equal(classifyGitFailure("remote: Repository not found.\nfatal: Could not read from remote repository."), "repourl");
  assert.equal(classifyGitFailure("something nobody has seen before"), "other");
});

test("an ssh remote URL is parsed; anything that is not ssh is refused", () => {
  assert.deepEqual(sshTarget("ssh://git@host.example:2222/team/repo.git"), { user: "git", host: "host.example", port: 2222 });
  assert.deepEqual(sshTarget("git@github.com:JLRoper/agent-worktree-gui.git"), { user: "git", host: "github.com", port: null });
  assert.deepEqual(sshTarget("github.com:team/repo.git"), { user: null, host: "github.com", port: null });
  assert.equal(sshTarget("https://github.com/a/b.git"), null);
  assert.equal(sshTarget(String.raw`/c/team/repo.git`), null, "an MSYS path is not an ssh remote");
  // The drive-letter case, built rather than written: the absolute-path gate scans this file too, and a literal
  // `letter:/…` is exactly what it exists to refuse (tools/absolute-paths.mjs). The runtime string is the same.
  assert.equal(sshTarget(["Z", ":", "/team/repo.git"].join("")), null, "a drive letter is a path, not host Z");
  assert.equal(sshTarget("git@github.com/repo.git"), null);
});

test("the ssh -G answer is read for exactly the two lines the diagnosis needs", () => {
  const g = parseSshG("host github.com\nuser git\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\nidentityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/id_rsa\n");
  assert.equal(g.userknownhostsfile, "~/.ssh/known_hosts ~/.ssh/known_hosts2");
  assert.deepEqual(g.identityfile, ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"]);
});

// ---------- the command, in fixtures ----------

test("a reachable remote, a free port and no pid file add up to exit 0", async (t) => {
  const { dir, cfg } = await fixture(t);
  const bare = path.join(dir, "remote.git");
  await mkdir(bare, { recursive: true });
  git(dir, ["init", "--bare", bare]);

  const r = doctor(["--config", cfg, "--remote", bare]);
  assert.equal(r.code, 0, `expected every hard check to pass:\n${r.out}\n${r.err}`);
  assert.match(r.out, /node .* \(engines /, "node is checked against the engines floor");
  assert.match(r.out, /^ok +git \S+/m, "git is checked");
  assert.match(r.out, /remote .* — ls-remote ok \(0 heads\)/, "the local bare remote answers with zero heads");
  assert.match(r.out, /panel — not running on \d+/, "a free port with no pid file is the not-running state");
  assert.match(r.out, /gateway http/, "the gateway state is named");
  assert.match(r.out, /check-env: \d+ ok, \d+ warn, 0 fail — every hard check passed/);
  assert.doesNotMatch(r.out, /^fail/m, "no line is a failure");
});

test("an ssh remote nobody answers on exits 1 with the raw output, the ssh git would run, and a fix", async (t) => {
  const { cfg } = await fixture(t);
  const r = doctor(["--config", cfg, "--remote", "ssh://git@127.0.0.1:1/repo.git"]);
  // A refused TCP connect on port 1 is instant everywhere; the classes above it (hostkey, auth) need a server.
  assert.equal(r.code, 1, `expected a hard failure:\n${r.out}\n${r.err}`);
  assert.match(r.err, /remote ssh:\/\/git@127\.0\.0\.1:1\/repo\.git — ls-remote failed: /);
  assert.match(r.err, /refused/i, "the raw ssh line is carried");
  assert.match(r.err, /the ssh git will run: /, "the ssh git resolves is named");
  assert.match(r.err, /fix: /, "a fix line follows the failure");
  assert.match(r.err, /check-env: \d+ ok, \d+ warn, 1 fail — 1 hard check failed/);
});

test("knowsHost reads a plain known_hosts entry and the text fallback does not need ssh-keygen", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-doctor-kh-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "known_hosts");
  await writeFile(file, "# a comment\nhost.example ssh-ed25519 AAAA test\n", "utf8");
  assert.equal(knowsHost(file, "host.example", null), true, "the entry is found");
  assert.equal(knowsHost(file, "other.example", null), false, "another host is not claimed");
  assert.equal(knowsHost(path.join(dir, "missing"), "host.example", null), false, "a file that is not there knows nothing");
});

test("a usage error is exit 2 and never a verdict", () => {
  const r = doctor(["--remote"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--remote needs a URL or a directory/);
  assert.match(r.err, /usage:/);
  const u = doctor(["--nonsense"]);
  assert.equal(u.code, 2);
  assert.match(u.err, /unknown argument "--nonsense"/);
});
