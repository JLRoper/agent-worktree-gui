// A remote write the SETTING allowed: what the panel records, what Unwind would do, and what the guard reports.
//
// The reader's preference is that an auto-allowed action is still evidence: the guard's own copy of the policy makes
// the hook return before it asks the panel, so without a report the board would never know a push happened. The
// review card is that record — Keep, or one named Unwind — and this file pins the two rules that keep it honest:
// nothing is drawn unless the remote confirms the branch, and no inverse is ever a command the page could supply.
//
// The hook half runs the GENERATED script the way git does (sh, in a real repository), against a stub panel, so
// "it reported" and "it asked nobody" are facts about the script rather than about its source text.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RemoteWrites } from "../lib/remote-writes.js";
import { guardScript } from "../lib/push-guard.js";

const settle = () => new Promise((r) => setTimeout(r, 30));

function collector() {
  const events = [];
  const rw = new RemoteWrites({
    getPolicy: () => "allow",
    onEvent: (e) => events.push(e),
    onLog: () => {},
    timeoutSeconds: 5,
  });
  return { rw, events };
}

const push = (rw, over = {}) =>
  rw.review({
    kind: "push",
    worktree: "c:/probe/tree",
    project: "probe",
    branch: "wtgui/task-27",
    remote: "origin",
    refs: "refs/heads/wtgui/task-27",
    command: "git push origin wtgui/task-27",
    why: "the setting allows remote writes",
    ...over,
  });

test("a confirmed auto-allowed push is a review card whose Unwind names the exact delete", async () => {
  const { rw, events } = collector();
  rw.setVerifier(async () => ({ found: true, sha: "0123456789abcdef" }));
  push(rw);
  await settle();

  const ev = events.find((e) => e.type === "remote-write-review");
  assert.ok(ev, "the confirmed write was broadcast");
  assert.equal(ev.review.state, "ran");
  assert.equal(ev.review.sha, "0123456789abcdef");
  assert.equal(ev.review.unwind.type, "delete-branch");
  assert.equal(ev.review.unwind.command, "git push origin --delete wtgui/task-27", "the command is the record's, spelled in full");
  assert.equal(ev.review.unwind.label, "delete remote branch origin/wtgui/task-27", "and the button's label names it");
});

test("a write the remote does not show is dropped, never drawn", async () => {
  const { rw, events } = collector();
  rw.setVerifier(async () => ({ found: false }));
  const rec = push(rw);
  await settle();
  assert.equal(events.filter((e) => e.type === "remote-write-review").length, 0, "nothing ran, so there is nothing to review");
  assert.equal(rw.reviewFor(rec.id), null, "and the record is gone, not left pending forever");
});

test("a base branch has no delete inverse — the offer is a drafted message", async () => {
  const { rw, events } = collector();
  rw.setVerifier(async () => ({ found: true, sha: "abc1234" }));
  push(rw, { branch: "main", refs: "refs/heads/main", command: "git push origin main", why: "this tree was started to land" });
  await settle();

  const review = events.find((e) => e.type === "remote-write-review").review;
  assert.equal(review.unwind.type, "message", "main is never offered as a delete");
  assert.equal(review.unwind.command, undefined, "and there is no command for the page to run");
  assert.match(review.unwind.text, /push main/);
  assert.match(review.unwind.text, /this tree was started to land/);
});

test("a branch with no slash is refused the delete inverse too", async () => {
  const { rw, events } = collector();
  rw.setVerifier(async () => ({ found: true, sha: "abc1234" }));
  push(rw, { branch: "release-2027" });
  await settle();
  assert.equal(events.find((e) => e.type === "remote-write-review").review.unwind.type, "message");
});

test("Keep removes the record and tells the other pages; Unwind leaves a receipt", async () => {
  const { rw, events } = collector();
  rw.setVerifier(async () => ({ found: true, sha: "abc1234" }));
  const rec = push(rw);
  await settle();
  assert.equal(rw.state().reviews.length, 1, "a settled review rides the snapshot");

  assert.deepEqual(rw.keepReview(rec.id), { ok: true });
  assert.equal(rw.reviewFor(rec.id), null);
  assert.ok(events.some((e) => e.type === "remote-write-review-done" && e.action === "keep"));

  const second = push(rw);
  await settle();
  const undone = rw.markUnwound(second.id, {});
  assert.equal(undone.state, "unwound");
  assert.ok(events.some((e) => e.type === "remote-write-review-done" && e.action === "unwind" && e.review.state === "unwound"));
});

test("a review still being checked is not in the snapshot", async () => {
  const { rw } = collector();
  let release;
  rw.setVerifier(() => new Promise((r) => (release = r)));
  push(rw);
  assert.deepEqual(rw.state().reviews, [], "a write nobody has confirmed is not a record yet");
  release({ found: true, sha: "abc1234" });
  await settle();
  assert.equal(rw.state().reviews.length, 1);
});

// ---- the hook's half: a policy of `allow` reports the write and asks nobody ------------------------------------
function findSh() {
  for (const c of [process.env.WTGUI_SH, "sh", "C:/Program Files/Git/usr/bin/sh.exe", "C:/Program Files/Git/bin/sh.exe"]) {
    if (!c) continue;
    const r = spawnSync(c, ["-c", "exit 0"], { stdio: "ignore", windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}
const SH = findSh();
const NO_SH = SH ? false : "no sh on PATH — the hook runs under the sh git ships, so set WTGUI_SH to one";

async function stubPanel() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: "rwv_stub", status: "pending", choice: null }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    stop: () => new Promise((r) => server.close(r)),
  };
}

async function guardFixture(t, policy) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-guard-report-"));
  const repo = path.join(dir, "repo");
  const panel = await stubPanel();
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  spawnSync("git", ["init", "-q", repo], { encoding: "utf8", windowsHide: true });
  git("remote", "add", "origin", path.join(dir, "remote.git").replace(/\\/g, "/"));
  git("checkout", "-q", "-b", "wtgui/probe-27");
  t.after(async () => {
    await panel.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { dir, repo, panel, git };
}

function runHook(hookPath, cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(SH, [hookPath], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const killer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, out, err });
    });
    child.stdin.end('refs/heads/wtgui/probe-27 0000000000000000000000000000000000000000 refs/heads/wtgui/probe-27 0000000000000000000000000000000000000000\n');
  });
}

async function installHook(dir, repo, panel, policy) {
  const { mkdir } = await import("node:fs/promises");
  const hooks = path.join(dir, "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(path.join(hooks, "pre-push"), guardScript().split(String.fromCharCode(13)).join(""), "utf8");
  await writeFile(path.join(hooks, "panel"), `${panel.url}\n`, "utf8");
  await writeFile(path.join(hooks, "timeout"), "3\n", "utf8");
  await writeFile(path.join(hooks, "policy"), `${policy}\n`, "utf8");
  await writeFile(path.join(hooks, "landing"), "\n", "utf8");
  await writeFile(path.join(hooks, "chain"), "\n", "utf8");
  // Keep a repo fixture honest: the hook reads its own tree from git, so it has to be run from one.
  assert.ok(repo, "a repository fixture is required");
  return path.join(hooks, "pre-push");
}

test("under a policy of allow the hook reports the write and asks nobody", { skip: NO_SH }, async (t) => {
  const { dir, repo, panel } = await guardFixture(t, "allow");
  const hook = await installHook(dir, repo, panel, "allow");
  const r = await runHook(hook, repo);
  const where = `exit=${r.code} signal=${r.signal}\n--- stderr ---\n${r.err}`;
  assert.equal(r.code, 0, `an allow-policy push goes through\n${where}`);
  const reports = panel.seen.filter((s) => s.url === "/api/remote-write/report");
  assert.equal(reports.length, 1, `the write was reported once: ${JSON.stringify(panel.seen)}\n${where}`);
  const body = JSON.parse(reports[0].body);
  assert.equal(body.branch, "wtgui/probe-27", "the branch travels with the report");
  assert.equal(body.worktree.replace(/\\/g, "/").toLowerCase().endsWith("/repo"), true, `the tree travels too: ${body.worktree}`);
  assert.equal(body.remote, "origin");
  assert.match(body.why, /policy in this tree/, "and the report says why nobody was asked");
  assert.equal(panel.seen.filter((s) => s.url === "/api/remote-write/request").length, 0, "no permission box was drawn");
});

test("a deliberate WTGUI_PUSH_GRANT bypass reports nothing", { skip: NO_SH }, async (t) => {
  const { dir, repo, panel } = await guardFixture(t, "allow");
  const hook = await installHook(dir, repo, panel, "allow");
  const r = await runHook(hook, repo, { WTGUI_PUSH_GRANT: "1" });
  assert.equal(r.code, 0);
  assert.deepEqual(panel.seen, [], `the documented bypass involves no panel at all: ${JSON.stringify(panel.seen)}`);
});
