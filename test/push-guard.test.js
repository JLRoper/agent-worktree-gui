// The push guard's own bypass, run the way git runs the hook.
//
// WTGUI_PUSH_GRANT=1 is the route the guard's refusal message advertises ("no panel involved — your own call,
// nothing is asked") and the route a landing worker is told to use. It only works if `allow_push` is DEFINED
// above the first line that calls it: sh reads a script top-down and does not hoist function definitions, so a
// definition below the call makes the granted path die with "allow_push: command not found" and fall straight
// through into the ask-the-panel branch — which prints "no permission was asked" while it asks, and parks the
// push for the guard's whole window. That is the defect this suite pins.
//
// The hook the panel installs is GENERATED from lib/push-guard.js, so the assertions run the generated script,
// never the source text. The stub panel is a real listener: it is what makes "nothing was asked" and "it did
// not park" mean something — if the guard reaches it, the request is on the record and the test fails.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { guardScript, installGuard } from "../lib/push-guard.js";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

// git runs a hook with the sh its own installation ships, so `sh` is on PATH inside a hook but a suite started
// from cmd.exe may have none. Look for one instead of failing on the harness's environment.
function findSh() {
  const candidates = [process.env.WTGUI_SH, "sh", "C:/Program Files/Git/usr/bin/sh.exe", "C:/Program Files/Git/bin/sh.exe"];
  for (const c of candidates) {
    if (!c) continue;
    const r = spawnSync(c, ["-c", "exit 0"], { stdio: "ignore", windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}
const SH = findSh();
const NO_SH = SH ? false : "no sh on PATH — the hook itself runs under the sh git ships, so set WTGUI_SH to one";

// A panel that answers the way the real one does, and remembers being asked.
async function stubPanel() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    // The real panel parks a request and hands back an id; /status then reports pending until a human answers.
    const body = req.url.startsWith("/api/remote-write/status")
      ? { status: "pending", choice: null, timeoutSeconds: 300 }
      : { status: "pending", id: "rw_stub", timeoutSeconds: 300 };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    stop: () => new Promise((r) => server.close(r)),
  };
}

// One guard, installed the way lib/push-guard.js installs one: LF endings (this checkout stores source as
// CRLF, and a CR at the end of a shell line is not executable), the facts in one-word files beside it, and the
// worktree's previous pre-push named in `chain`.
async function installOneGuardInto(dir, { panelUrl, timeoutSeconds = 3, chain = "" }) {
  await writeFile(path.join(dir, "pre-push"), guardScript().split(CRLF).join(LF), "utf8");
  await writeFile(path.join(dir, "panel"), `${panelUrl}\n`, "utf8");
  // Deliberately short: the guard reads this file verbatim, and a parking run then finishes inside the test's
  // patience rather than needing a kill to be observable.
  await writeFile(path.join(dir, "timeout"), `${timeoutSeconds}\n`, "utf8");
  await writeFile(path.join(dir, "policy"), "local-only\n", "utf8");
  await writeFile(path.join(dir, "landing"), "\n", "utf8");
  await writeFile(path.join(dir, "chain"), `${chain}\n`, "utf8");
  return dir;
}

// git hands a pre-push hook one line per ref on stdin: <local ref> <local sha> <remote ref> <remote sha>.
//
// The kill budget is a guard against a hook that never returns, not a timing assertion: the control run below parks
// on purpose for the fixture's 3 s window, and every git/sh spawn the hook makes costs about a second on this host.
// Measured: 61 s for this file solo, and the full suite (60 files in parallel, each driving real git) blew straight
// through the old 30 s and reported `exit=null` — the hook was still working, not stuck. The assertions that matter
// are on what the hook PRINTED and whether it asked the panel; the ceiling only has to be longer than a loaded box.
function runHook({ dir, env = {}, cwd, timeoutMs = 120_000 }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(SH, [path.join(dir, "pre-push")], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve({ ...r, out, err, ms: Date.now() - started });
    };
    const killer = setTimeout(() => {
      child.kill();
      finish({ code: null, signal: "test-timeout" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(killer);
      finish({ code: null, error: String(e.message) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      finish({ code, signal });
    });
    child.stdin.end(`refs/heads/wtgui/test ${"a".repeat(40)} refs/heads/wtgui/test ${"0".repeat(40)}\n`);
  });
}

// The generated hook, line by line, so an assertion can name the line numbers it is complaining about.
const hookLines = () => guardScript().split(/\r?\n/);
const firstLineMatching = (lines, re) => lines.findIndex((l) => re.test(l));

test("the generated hook defines what its granted paths call before the first call", () => {
  const lines = hookLines();
  const defined = firstLineMatching(lines, /^allow_push\(\) \{/);
  const chainDefined = firstLineMatching(lines, /^run_chain\(\) \{/);
  const chainRead = firstLineMatching(lines, /^chain=\$\(cat /);
  const firstCall = firstLineMatching(lines, /^\s*allow_push\s*$/);
  assert.ok(defined > 0, "the hook defines allow_push at all");
  assert.ok(chainDefined > 0, "the hook defines run_chain at all");
  assert.ok(chainRead > 0, "the hook reads the chain file at all");
  assert.ok(firstCall > 0, "the hook calls allow_push at all");
  // sh has no hoisting: every one of these has to be above the first call, not merely somewhere in the file.
  assert.ok(
    defined < firstCall,
    `allow_push is called at line ${firstCall + 1} and defined at line ${defined + 1} — sh does not hoist, so the ` +
      `granted path dies with "allow_push: command not found" and falls through to asking the panel`,
  );
  assert.ok(chainDefined < firstCall, `run_chain is defined at line ${chainDefined + 1}, below the call at line ${firstCall + 1}`);
  assert.ok(chainRead < firstCall, `the chain file is read at line ${chainRead + 1}, below the call at line ${firstCall + 1}`);
});

test("installing the guard again leaves the same shims, never one that execs itself", async (t) => {
  // A tree that ships its own hook: the guard shims it rather than shadowing it. The SECOND install is the one
  // that read the guard's OWN dir back as "the hooks this worktree had before the panel took them" and wrote a
  // commit-msg that execs itself — which is every commit in every worktree of the clone, forever, since one
  // guard dir covers them all. Re-installing is how the guard is refreshed, so it has to be safe to repeat.
  const repo = await mkdtemp(path.join(os.tmpdir(), "wtgui-guard-repo-"));
  t.after(() => rm(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  git("init", "-q", ".");
  await mkdir(path.join(repo, ".githooks"), { recursive: true });
  await writeFile(path.join(repo, ".githooks", "commit-msg"), "#!/bin/sh\nexit 0\n", "utf8");
  git("config", "core.hooksPath", ".githooks");
  const realHooks = path.join(repo, ".githooks").replace(/\\/g, "/");

  const install = () => installGuard({ projectPath: repo, worktree: repo, panelUrl: "http://127.0.0.1:7331", policy: "local-only", landing: [] });
  const first = await install();
  assert.equal(first.ok, true, `the first install works: ${first.error || ""}`);
  const guardDir = first.dir;
  const shim = () => readFile(path.join(guardDir, "commit-msg"), "utf8");

  assert.equal(first.previous, realHooks, "the dir the guard replaced is the worktree's own .githooks");
  assert.match(await shim(), new RegExp(`exec "${realHooks.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/commit-msg"`));

  const second = await install();
  assert.equal(second.ok, true, `a second install works: ${second.error || ""}`);
  assert.equal(second.previous, realHooks, "a re-install still names the worktree's own .githooks, not the guard's dir");
  assert.deepEqual(second.shims, first.shims, "the same hooks are shimmed");
  assert.doesNotMatch(await shim(), new RegExp(guardDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no shim points back at the guard dir");

  // A tree the pre-fix installer already poisoned: its record names the guard's dir as its predecessor and the
  // self-exec shim is on disk. Re-installing has to clear both, or the tree can never be repaired.
  const recordFile = path.join(guardDir, "wtgui-guard.json");
  const record = JSON.parse(await readFile(recordFile, "utf8"));
  await writeFile(recordFile, JSON.stringify({ ...record, previousHooksPath: guardDir }, null, 2), "utf8");
  await writeFile(path.join(guardDir, "commit-msg"), `#!/bin/sh\nexec "${guardDir}/commit-msg" "$@"\n`, "utf8");
  const third = await install();
  assert.equal(third.ok, true, `the repairing install works: ${third.error || ""}`);
  assert.notEqual(third.previous, guardDir, "the guard's own dir is never recorded as its own predecessor");
  const after = JSON.parse(await readFile(recordFile, "utf8"));
  assert.notEqual(after.previousHooksPath, guardDir, "the poisoned record is replaced by the real predecessor");
  await assert.rejects(() => readFile(path.join(guardDir, "commit-msg"), "utf8"), "the self-exec shim is taken away");
  assert.ok((await readFile(path.join(guardDir, "pre-push"), "utf8")).startsWith("#!/bin/sh"), "the guard's own hook is still there");
});

test("an env-granted push neither asks the panel nor parks", { skip: NO_SH }, async (t) => {
  const panel = await stubPanel();
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-guard-"));
  // The worktree's own pre-push, chained from every path that allows a push. If the fix moved the definition
  // up and lost the chain, this marker never appears.
  const marker = path.join(dir, "chain-ran");
  const chain = path.join(dir, "chain-hook");
  await writeFile(chain, `#!/bin/sh\ncat > /dev/null\nprintf 'ran\\n' >> "${marker.replace(/\\/g, "/")}"\nexit 0\n`, "utf8");
  await installOneGuardInto(dir, { panelUrl: panel.url, chain: chain.replace(/\\/g, "/") });

  t.after(async () => {
    await panel.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // The control first: the SAME hook with no grant, so it asks the stub panel and parks in the guard's own 1 s poll
  // loop until the 3 s window this fixture installs runs out. Both runs are then measured on one host at one moment,
  // which is what makes their difference a fact about the guard rather than about the machine: every git/sh spawn
  // costs about a second here, and the fixed 2.5 s ceiling this test used to assert measured the host — 2325 ms solo,
  // 6222-7359 ms inside the full suite on the same tree.
  const parked = await runHook({ dir, cwd: dir });
  const parkedWhere = `exit=${parked.code} after ${parked.ms}ms\n--- stderr ---\n${parked.err}`;
  assert.match(parked.err, /is parked until it is answered/, `the control really parks — otherwise there is no wait to compare against\n${parkedWhere}`);
  assert.ok(parked.ms >= 3000, `the control waited out the fixture's 3 s window: ${parked.ms}ms\n${parkedWhere}`);
  const askedByControl = panel.seen.length;

  const r = await runHook({ dir, env: { WTGUI_PUSH_GRANT: "1" }, cwd: dir });
  const where = `exit=${r.code} signal=${r.signal} after ${r.ms}ms\n--- stderr ---\n${r.err}`;

  // The grant has to be honest about itself: it says the guard was bypassed...
  assert.match(r.err, /bypassed by WTGUI_PUSH_GRANT=1/, `the granted path has to say what it did\n${where}`);
  assert.doesNotMatch(r.err, /command not found/, `the granted path has to run, not die on a missing function\n${where}`);
  // ...and it must not ask the panel: no permission box, no parked push, no request on the wire for THIS run.
  assert.doesNotMatch(r.err, /waiting on the panel's permission box/, `a granted push asks nobody\n${where}`);
  assert.doesNotMatch(r.err, /is parked until it is answered/, `a granted push never parks\n${where}`);
  assert.deepEqual(panel.seen.slice(askedByControl), [], `nothing reached the panel for the granted run, and it was asked: ${JSON.stringify(panel.seen.slice(askedByControl))}\n${where}`);
  // It finishes without waiting the window the control just waited out — one hook run's cost, not the guard's window.
  // The margin is the control's shelf: it spent 3 s in `sleep 1` alone, so a granted push that parked with it would
  // land within a second of it, and this fails. Relative, so a loaded box moves both numbers together.
  assert.ok(
    r.ms < parked.ms - 1000,
    `a granted push costs one hook run, not the guard's window: granted ${r.ms}ms vs the parked control ${parked.ms}ms\n${where}`,
  );
  assert.equal(r.code, 0, `a granted push succeeds\n${where}`);
  // And the hook this worktree already had still runs: taking the hooks path never switches off somebody
  // else's hook.
  const ran = await readFile(marker, "utf8").catch(() => null);
  assert.match(String(ran), /ran/, `the chained pre-push ran\n${where}`);
});
