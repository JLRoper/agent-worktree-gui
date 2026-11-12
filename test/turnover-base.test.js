// A tree cut on a LOCAL TURNOVER BRANCH - the third base-ref kind.
//
// The two kinds that already exist are the checkout's own branch (lib/jobs.js `startRefOf`) and the branch a project
// NAMES in its settings (lib/project-turnover.js, wired into the cut by ae6888ca). The third kind has no name to read:
// the panel has to FIND the branch, and a branch only counts when THREE things are true together -
//
//   1. its name is the turnover shape `YYYYMMDD_HHMM_<KEY>_<slug>`;
//   2. a remote carries a branch of that name (it has been pushed);
//   3. it is NOT an ancestor of main or master (it has not landed).
//
// Each test below removes exactly one of those, because each one alone is a different mistake: a merged branch looks
// perfectly publishable, an unpushed one has the right name, and a feature branch is pushed and unmerged. The failure
// this option exists to prevent is the SILENT FALLBACK: a cut that cannot find a branch must ask the reader, not cut
// from main, so the last two tests pin the question and the brief rather than a returned branch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TURNOVER_BASE_KIND,
  TURNOVER_BASE_LABEL,
  isTurnoverBranchName,
  pickTurnoverBase,
  resolveTurnoverBase,
  turnoverBaseBrief,
} from "../lib/turnover-base.js";
import { Jobs } from "../lib/jobs.js";

const slash = (p) => String(p).replace(/\\/g, "/");
const MERGED = "20261001_0900_DMR-1_mergedWork";
const UNPUSHED = "20261002_0900_DMR-2_unpushedWork";
const VALID = "20261020_1624_DMR-39015_menuOAuth2Gateway";
const FEATURE = "feature/roll-up";

// ---- the rule, without a repository ------------------------------------------------------------------------------
test("a merged turnover branch is rejected: it is an ancestor of main", () => {
  const out = pickTurnoverBase({
    locals: [MERGED, VALID],
    remotes: [MERGED, VALID],
    merged: [MERGED],
  });
  assert.equal(out.ok, true);
  assert.equal(out.branch, VALID, "the merged branch is not a candidate even though its name and remote are right");
  const why = out.rejected.find((r) => r.name === MERGED);
  assert.equal(why.reason, "merged");
  assert.match(why.why, /ancestor of main or master/);
});

test("an unpushed turnover branch is rejected: no remote carries it", () => {
  const out = pickTurnoverBase({
    locals: [UNPUSHED, VALID],
    remotes: [VALID],
    merged: [],
  });
  assert.equal(out.ok, true);
  assert.equal(out.branch, VALID);
  assert.equal(out.rejected.find((r) => r.name === UNPUSHED).reason, "unpushed");
});

test("a feature branch is rejected: its name is not a turnover name", () => {
  const out = pickTurnoverBase({
    locals: [FEATURE, VALID],
    remotes: [FEATURE, VALID],
    merged: [],
  });
  assert.equal(out.ok, true);
  assert.equal(out.branch, VALID);
  assert.equal(out.rejected.find((r) => r.name === FEATURE).reason, "name");
});

test("with no qualifying branch the rule answers nothing, and says why for every local branch", () => {
  const out = pickTurnoverBase({
    locals: [MERGED, UNPUSHED, FEATURE],
    remotes: [MERGED, FEATURE],
    merged: [MERGED],
  });
  assert.equal(out.ok, false);
  assert.equal(out.branch, null, "never a fallback: no branch means no branch");
  assert.deepEqual(
    out.rejected.map((r) => r.reason).sort(),
    ["merged", "name", "unpushed"],
  );
});

test("two qualifying branches resolve the newer one, because the name is its own clock", () => {
  const older = "20260101_0800_DMR-9_olderWork";
  const out = pickTurnoverBase({ locals: [older, VALID], remotes: [older, VALID], merged: [] });
  assert.equal(out.branch, VALID);
  assert.deepEqual(out.candidates, [VALID, older]);
});

test("the name test is the one pattern, not a second copy of it", () => {
  assert.equal(isTurnoverBranchName(VALID), true);
  assert.equal(isTurnoverBranchName(MERGED), true);
  assert.equal(isTurnoverBranchName(FEATURE), false);
  assert.equal(isTurnoverBranchName("main"), false);
  assert.equal(isTurnoverBranchName("20261020_1624_DMR-39015"), false, "the slug is required");
  assert.equal(TURNOVER_BASE_KIND, "local-turnover");
  assert.equal(TURNOVER_BASE_LABEL, "local turnover branch - ask if none exist");
});

// ---- the rule over a real repository ------------------------------------------------------------------------------
function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-turnover-base-"));
  const tree = slash(path.join(dir, "demo"));
  mkdirSync(tree, { recursive: true });
  const email = ["tester", "example.invalid"].join(String.fromCharCode(64));
  const run = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const git = (...args) => run(tree, ...args);
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(tree, "README.md"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  mkdirSync(path.join(tree, ".worktrees"), { recursive: true });

  // ONE MERGED: a turnover-shaped branch whose commit is already reachable from main.
  git("checkout", "-q", "-b", MERGED);
  writeFileSync(path.join(tree, "merged.md"), "work that landed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "merged work");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "land the merged turnover branch", MERGED);

  // ONE UNPUSHED: the right name, a commit of its own, and nothing on the remote.
  git("checkout", "-q", "-b", UNPUSHED);
  writeFileSync(path.join(tree, "unpushed.md"), "work only this machine has\n");
  git("add", "-A");
  git("commit", "-q", "-m", "unpushed work");

  // ONE VALID: the right name, a commit of its own, and pushed.
  git("checkout", "-q", "main");
  git("checkout", "-q", "-b", VALID);
  writeFileSync(path.join(tree, "valid.md"), "the turnover work nobody has landed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "the turnover work");
  const validSha = git("rev-parse", VALID);

  // The remote is a bare repo beside the checkout: "pushed" is a real remote-tracking ref, not a flag.
  const bare = slash(path.join(dir, "origin.git"));
  execFileSync("git", ["init", "-q", "--bare", bare], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("remote", "add", "origin", bare);
  git("push", "-q", "origin", `${MERGED}:refs/heads/${MERGED}`, `${VALID}:refs/heads/${VALID}`);
  git("fetch", "-q", "origin");
  git("checkout", "-q", "main");

  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { dir, tree, git, bare, validSha };
}

test("a real repo with a merged, an unpushed and a valid branch resolves only the valid one", async (t) => {
  const s = scratch(t);
  const out = await resolveTurnoverBase({ repoDir: s.tree, mainBranch: "main" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.branch, VALID);
  assert.equal(out.sha, s.validSha);
  assert.notEqual(out.sha, s.git("rev-parse", "main"));
  const reasons = Object.fromEntries(out.rejected.map((r) => [r.name, r.reason]));
  assert.equal(reasons[MERGED], "merged");
  assert.equal(reasons[UNPUSHED], "unpushed");
  assert.equal(reasons[FEATURE], undefined, "the fixture holds exactly three branches, so there is no feature branch");
});

test("a cut on the option asks the reader when nothing qualifies, and cuts nothing", async (t) => {
  const s = scratch(t);
  // Take the valid branch's remote away: now only the merged and the unpushed remain, so no branch qualifies.
  s.git("push", "-q", "origin", `:refs/heads/${VALID}`);
  s.git("update-ref", "-d", `refs/remotes/origin/${VALID}`);
  const asked = [];
  const jobs = new Jobs({
    config: { jobsFile: path.join(s.dir, "logs", "jobs.json"), defaultCwd: s.dir },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.askReader = (q) => asked.push(q);

  await assert.rejects(
    () => jobs.makeWorktree(s.tree, "work on the turnover branch", { baseKind: TURNOVER_BASE_KIND }),
    /no local turnover branch/i,
    "the cut refuses instead of falling back to main",
  );
  assert.equal(asked.length, 1, "the reader is asked exactly once");
  assert.match(asked[0].title, /no local turnover branch/i);
  for (const name of [MERGED, UNPUSHED]) assert.match(asked[0].detail, new RegExp(name));
  assert.match(asked[0].detail, /instead of cutting from main/i);
  assert.deepEqual(readdirSync(path.join(s.tree, ".worktrees")), [], "no tree was cut");

  // …and the same repo WITH the valid branch on the remote is cut on it.
  s.git("push", "-q", "origin", `${VALID}:refs/heads/${VALID}`);
  s.git("fetch", "-q", "origin");
  const made = await jobs.makeWorktree(s.tree, "work on the turnover branch", { baseKind: TURNOVER_BASE_KIND });
  assert.equal(made.startRef, VALID);
  assert.equal(made.startSha, s.validSha);
  assert.equal(made.parentName, VALID);
  assert.equal(made.turnover?.name, VALID, "the record says the parent is a turnover branch");
});

// ---- the brief ---------------------------------------------------------------------------------------------------
test("the brief for a run cut on the option carries the local-only turnover rule", () => {
  const brief = turnoverBaseBrief({ branch: VALID, repoDir: "repos/demo" });
  assert.match(brief, /TURNOVER BASE:/);
  assert.match(brief, new RegExp(VALID));
  assert.match(brief, /YYYYMMDD_HHMM_<KEY>_<slug>/);
  assert.match(brief, /pushed/);
  assert.match(brief, /not an ancestor of main or master/);
  assert.match(brief, /Do not push this tree's branch and do not cut a new remote branch/);
  assert.match(brief, /this child stays local/);
  assert.match(brief, /fast-forward/);
  assert.match(brief, /git merge --ff-only/);
});

// ---- the brief as a run actually receives it ---------------------------------------------------------------------
async function stubGateway() {
  const posts = [];
  const server = createServer((req, res) => {
    const url = String(req.url || "");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
      const json = (code, out) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      if (req.method === "GET" && url === "/v1/capabilities") {
        return json(200, { version: "stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true } });
      }
      if (req.method === "POST" && url === "/v1/runs") {
        posts.push(body);
        return json(200, { run_id: `run_${posts.length}`, session_id: String(body.session_id || "") });
      }
      if (req.method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url)) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": open\n\n");
        req.on("close", () => res.end());
        return;
      }
      if (req.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(url)) return json(200, { status: "running", output: "" });
      if (req.method === "POST") return json(200, {});
      json(404, { error: { message: "no such route" } });
    });
  });
  await new Promise((open) => server.listen(0, "127.0.0.1", open));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    posts,
    close: () => new Promise((done) => (server.closeAllConnections?.(), server.close(done))),
  };
}

test("a run cut on the option receives the rule in its brief", async (t) => {
  const s = scratch(t);
  const gw = await stubGateway();
  const jobs = new Jobs({
    config: { jobsFile: path.join(s.dir, "logs", "jobs.json"), apiServer: { url: gw.url, key: "stub" }, defaultCwd: s.dir },
    onEvent: () => {},
    onLog: () => {},
  });
  t.after(async () => {
    for (const j of jobs.jobs.values()) {
      j.ctrl?.abort();
      for (const timer of [j.timer, j.poller, j.textTimer, j.statsTimer]) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    }
    await gw.close();
  });

  const job = await jobs.create({ prompt: "cut on the local turnover branch", project: "demo", cwd: s.tree, worktree: true, baseRefKind: TURNOVER_BASE_KIND });
  const input = gw.posts.at(-1)?.input || "";
  assert.match(input, /TURNOVER BASE:/, "the brief carries the rule");
  assert.match(input, new RegExp(`local turnover branch \`${VALID}\``));
  assert.match(input, /Do not push this tree's branch and do not cut a new remote branch/);
  assert.match(input, /fast-forward/);
  assert.equal(jobs.jobs.get(job.id).branch && existsSync(path.join(s.tree, ".worktrees")), true);
});

// ---- the kind on the project's row, and the wire shape the bar reads ------------------------------------------
// The resolver is only reachable if the reader can SELECT it: a project's `baseRefKind` is what routes a cut to
// lib/turnover-base.js, and a save that cannot store the third kind leaves the option dead in the bar.
test("the three kinds are one list, and a project that names a branch reads as the named kind", async () => {
  const { BASE_REF_KINDS, LOCAL_TURNOVER_KIND, baseRefKindFrom, validateBaseRefKind } = await import("../lib/base-ref-kind.js");
  assert.deepEqual(BASE_REF_KINDS, ["checkout", "turnover", "local-turnover"]);
  assert.equal(LOCAL_TURNOVER_KIND, TURNOVER_BASE_KIND);
  assert.equal(baseRefKindFrom(undefined, { turnoverBranch: "" }), "checkout");
  assert.equal(baseRefKindFrom(undefined, { turnoverBranch: "feature/roll-up" }), "turnover", "a config written before this key existed keeps cutting from its named branch");
  assert.equal(baseRefKindFrom("local-turnover", { turnoverBranch: "feature/roll-up" }), "local-turnover", "the stated kind beats the derivation");
  assert.equal(baseRefKindFrom("localTurnover"), "local-turnover", "a hand-typed value is read, not dropped");
  // A save is STRICT: a typo must be refused, never stored as `checkout`, because the kind decides where a cut starts.
  assert.match(validateBaseRefKind("local-turnovr").error, /must be one of checkout, turnover, local-turnover/);
  assert.equal(validateBaseRefKind("local-turnover").kind, "local-turnover");
  assert.equal(validateBaseRefKind("").kind, null, "an empty value states no kind");
});

test("the row stores the third kind with no branch name, and never stores a kind that absence already means", async () => {
  const { projectTurnoverRow } = await import("../lib/project-turnover.js");
  const third = projectTurnoverRow({ name: "demo" }, "demo", "", "local-turnover");
  assert.equal(third.turnoverBranch, undefined, "the third kind has no name to store");
  assert.equal(third.baseRefKind, "local-turnover", "…and the kind must survive on its own");
  // The named kind is what absence already means, so a row does not grow a key for it.
  assert.equal(projectTurnoverRow({ name: "demo" }, "demo", "feature/roll-up", "turnover").baseRefKind, undefined);
  // …but an explicit `checkout` beside a named branch IS a different answer and must be written.
  assert.equal(projectTurnoverRow({ name: "demo" }, "demo", "feature/roll-up", "checkout").baseRefKind, "checkout");
  // Clearing the name does not clear the selection.
  assert.equal(turnoverKindOfRow(projectTurnoverRow({ name: "demo", baseRefKind: "local-turnover" }, "demo", "")), "local-turnover");
});

test("the wire shape carries the kinds and their labels, and each project's kind", async () => {
  const { turnoverOut } = await import("../routes/project-turnover.js");
  const registry = { projects: [{ name: "demo", turnoverBranch: "feature/roll-up", baseRefKind: "turnover" }, { name: "solo", baseRefKind: "local-turnover" }] };
  const all = turnoverOut(registry);
  assert.deepEqual(all.kinds, ["checkout", "turnover", "local-turnover"]);
  assert.equal(all.kindLabels["local-turnover"], TURNOVER_BASE_LABEL);
  assert.deepEqual(all.baseRefKinds, { demo: "turnover", solo: "local-turnover" });
  const one = turnoverOut(registry, "solo");
  assert.equal(one.baseRefKind, "local-turnover");
  assert.equal(one.turnoverBranch, "");
});

// The row's kind as the cut reads it, so the last assertion above does not re-implement the derivation.
function turnoverKindOfRow(row) {
  return row.baseRefKind === undefined ? (row.turnoverBranch ? "turnover" : "checkout") : row.baseRefKind;
}
