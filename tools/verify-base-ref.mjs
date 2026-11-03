// The gate for "every row on this project reads NO BASE REF": a configured remote that the checkout does not have
// must degrade to the remote that IS there, and a configured remote that exists must be used verbatim.
//
//   node tools/verify-base-ref.mjs                  # boot this checkout's server.js
//   node tools/verify-base-ref.mjs --root <dir>     # boot another checkout (the failing-first proof: a 9c00028 export)
//   node tools/verify-base-ref.mjs --keep           # leave the scratch repositories and the panel's log behind
//
// WHY. `config.json` is the reader's file and a `projects[]` entry carries `remote` through discovery verbatim, so
// an entry naming a remote the clone does not have (`"github"` over a clone that only has `origin`) built
// `github/main` into the project header and into every row's scan; `git rev-list` failed in each tree and the whole
// Verdict column read NO BASE REF (docs/rounds/playwright-round-1.md, measured twice on that page and on the live
// board). lib/base-ref.js now resolves the name against `git remote` — the configured one if present, else `origin`,
// else the only remote there is — and says so once in the log; lib/project.js and lib/scheduler.js both call it.
//
// WHAT IS DRIVEN: real git repositories under a scratch directory (a bare origin, a clone, a merged tree, an
// unmerged tree), the real server booted from `--root` through tools/panel-testkit.mjs against a throwaway config,
// and the rows read from that panel's own /api/state after its scans settle. Two projects differ only in their
// configured remote name:
//
//   wrong-remote   one remote (`origin`), configured "github"  -> falls back to origin/main, one journal line
//   right-remote   two remotes (`origin`, `upstream`), configured "upstream" -> used verbatim, no substitution
//
// Every tree in both projects must read a real verdict (ON MAIN / MERGED / UNMERGED), never NO BASE REF.
//
// Exit codes: 0 every check passed, 1 a check failed, 2 the panel could not be booted.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, startPanel, waitForState } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
// The checkout whose server.js is booted. Absent, this one — so the same gate can be run against an export of the
// code before the change (`git archive 9c00028 | tar -x -C <dir>`) and read its refusal.
const ROOT = path.resolve(argOf("root") || path.join(HERE, ".."));
const KEEP = argv.includes("--keep");

const scratch = mkdtempSync(path.join(os.tmpdir(), "wtgui-base-ref-"));
const S = scratch.replace(/\\/g, "/");
const REPOS = `${S}/repos`;
const EMPTY = `${S}/empty`;
const TAG = String(process.pid).slice(-6);

let checks = 0;
let failures = 0;
const ok = (name, cond, detail) => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const say = (line) => console.log(`      ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let counter = 0;
const commitIn = (dir, file, message) => {
  writeFileSync(path.join(dir, file), `${file} ${++counter} ${TAG}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message || file);
};

// One project: a bare origin, a clone of it, and two worktrees whose verdicts are the two merge states a row can
// carry besides ON MAIN. `extraRemote` adds a SECOND remote after the clone (so the configured name under test can
// be one that is not `origin`).
function makeProject(name, { extraRemote = null } = {}) {
  const origin = `${S}/srv/${name}.git`;
  const dir = `${REPOS}/${name}`;
  git(S, "init", "-q", "--bare", "-b", "main", origin);
  git(S, "clone", "-q", origin, dir);
  git(dir, "switch", "-q", "-C", "main");
  commitIn(dir, "base.txt", "base");
  git(dir, "push", "-q", "-u", "origin", "main");
  if (extraRemote) {
    git(dir, "remote", "add", extraRemote, origin);
    git(dir, "fetch", "-q", extraRemote);
  }

  // merged: one commit of its own, squash-merged into main and pushed — the branch is still ahead by its own
  // commit, but `git cherry` finds that commit's patch on the remote, which is exactly MERGED (squash/rebase, N).
  const merged = `wtgui/proof-merged-${TAG}`;
  const mergedTree = `${dir}/.worktrees/merged`;
  git(dir, "worktree", "add", "-q", "-b", merged, mergedTree, "origin/main");
  commitIn(mergedTree, "merged.txt", "the work that landed as a squash");
  git(dir, "merge", "--squash", merged);
  git(dir, "commit", "-q", "-m", "the merged work (squashed)");
  git(dir, "push", "-q", "origin", "main");
  if (extraRemote) git(dir, "push", "-q", extraRemote, "main");

  // unmerged: cut from the new main, one commit, never merged anywhere.
  const unmerged = `wtgui/proof-unmerged-${TAG}`;
  const unmergedTree = `${dir}/.worktrees/unmerged`;
  git(dir, "worktree", "add", "-q", "-b", unmerged, unmergedTree, `${extraRemote || "origin"}/main`);
  commitIn(unmergedTree, "unmerged.txt", "the work that has not landed");

  return { name, origin, dir, merged, mergedTree, unmerged, unmergedTree };
}

const WANT = (p) => [
  { branch: "main", tree: p.dir, verdict: "ON MAIN" },
  { branch: p.merged, tree: p.mergedTree, verdict: "MERGED (squash/rebase, 1 commit)" },
  { branch: p.unmerged, tree: p.unmergedTree, verdict: "UNMERGED (1 commit)" },
];
// Filled once the fixtures exist (their branch names carry the run's tag), read by the settle loop and the checks.
const EXPECTED = {};

const rowsFor = (state, projectName) => {
  const project = (state.projects || []).find((p) => p.name === projectName);
  if (!project) return { project: null, byBranch: {} };
  const byBranch = {};
  for (const row of project.worktrees || []) if (row.branch) byBranch[row.branch] = row;
  return { project, byBranch };
};

// The board is a projection of the last passes, so the read waits until every expected tree is on it with a
// verdict read by a FULL scan (`fullVerdict` is only written by one), then lets one more pass go by so the
// "one journal line" check covers more than the boot.
async function waitForBoard(base) {
  return waitForState(
    base,
    (state) =>
      ["wrong-remote", "right-remote"].every((name) => {
        const { project, byBranch } = rowsFor(state, name);
        if (!project || !project.remoteRef) return false;
        return EXPECTED[name].every((w) => {
          const row = byBranch[w.branch];
          return Boolean(row && row.verdict && row.fullVerdict && row.baseRef !== undefined);
        });
      }),
    "every proof tree on the board with a full verdict",
    { timeout: 90_000 },
  );
}

let panel = null;
let projects = {};
let exitCode = 1;
try {
  console.log(`scratch: ${S}`);
  console.log(`server:  ${ROOT}`);
  mkdirSync(REPOS, { recursive: true });
  mkdirSync(EMPTY, { recursive: true });
  mkdirSync(`${S}/srv`, { recursive: true });

  const wrong = makeProject("wrong-remote");
  const right = makeProject("right-remote", { extraRemote: "upstream" });
  projects = { wrong, right };
  EXPECTED["wrong-remote"] = WANT(wrong);
  EXPECTED["right-remote"] = WANT(right);

  panel = await startPanel({
    root: ROOT,
    config: {
      // No discovery sweep: the two projects are explicit entries, which is the shape config.json's projects[] is
      // read in and the shape the bug lives in.
      scanRoots: [EMPTY],
      projects: [
        // The measured bug: `github` is not a remote of this checkout (only `origin` is).
        { name: "wrong-remote", path: wrong.dir, remote: "github", mainBranch: "main" },
        // The contrast: a configured remote that DOES exist, and is not `origin`, so a fallback cannot be what
        // answers — `upstream/main` is only correct if the configured name was used verbatim.
        { name: "right-remote", path: right.dir, remote: "upstream", mainBranch: "main" },
      ],
      // Never fetch on a timer: the fixtures are pushed inside this run, and the gate is about the ref the rows
      // were counted against, not about the network.
      fetchSeconds: -1,
      worktreeSeconds: 5,
      midSeconds: 5,
      dormantSeconds: 5,
      slowSeconds: 5,
      refreshSeconds: 30,
      hideOlderThanDays: 0,
    },
  });
  say(`sandbox panel on ${panel.base}`);

  await waitForBoard(panel.base);
  await sleep(6500); // one more slow pass: the journal line must not be repeated per row or per pass
  const state = await (await fetch(`${panel.base}/api/state`)).json();

  // ---- the wrong-remote project: a bad name degrades to the checkout's own remote ----
  const w = rowsFor(state, "wrong-remote");
  const wh = w.project || {};
  ok("wrong-remote: the header names a ref that resolves (origin/main, not github/main)", wh.remoteRef === "origin/main", { remoteRef: wh.remoteRef, error: wh.error || null });
  ok("wrong-remote: the header carries no resolve error", !wh.error, wh.error || null);
  for (const want of EXPECTED["wrong-remote"]) {
    const row = w.byBranch[want.branch];
    say(`wrong-remote ${want.branch.split("/").pop().padEnd(9)} baseRef=${JSON.stringify(row?.baseRef)} verdict=${JSON.stringify(row?.verdict)}`);
    ok(`wrong-remote: ${want.branch.split("/").pop()} carries baseRef origin/main (never github/main)`, row?.baseRef === "origin/main", row?.baseRef ?? null);
    ok(`wrong-remote: ${want.branch.split("/").pop()} reads ${want.verdict}`, row?.verdict === want.verdict, row?.verdict ?? null);
  }
  ok("wrong-remote: no row reads NO BASE REF", Object.values(w.byBranch).every((r) => r.verdict !== "NO BASE REF"), Object.values(w.byBranch).map((r) => r.verdict));

  // ---- the right-remote project: the configured name is used verbatim ----
  const r = rowsFor(state, "right-remote");
  const rh = r.project || {};
  ok("right-remote: the header uses the configured remote verbatim (upstream/main)", rh.remoteRef === "upstream/main", { remoteRef: rh.remoteRef, error: rh.error || null });
  for (const want of EXPECTED["right-remote"]) {
    const row = r.byBranch[want.branch];
    say(`right-remote  ${want.branch.split("/").pop().padEnd(9)} baseRef=${JSON.stringify(row?.baseRef)} verdict=${JSON.stringify(row?.verdict)}`);
    ok(`right-remote: ${want.branch.split("/").pop()} carries baseRef upstream/main`, row?.baseRef === "upstream/main", row?.baseRef ?? null);
    ok(`right-remote: ${want.branch.split("/").pop()} reads ${want.verdict}`, row?.verdict === want.verdict, row?.verdict ?? null);
  }

  // ---- one journal line, and it says what was substituted ----
  const log = panel.log();
  const lines = log.split(/\r?\n/).filter((l) => /is not in this checkout/.test(l));
  lines.forEach((l) => say(`log: ${l}`));
  ok("exactly one journal line names the substitution, across every row and every pass", lines.length === 1, lines.length);
  ok("the line names the configured remote, the remotes present, the one used and the project", lines.length === 1 && /wrong-remote/.test(lines[0]) && /configured remote 'github'/.test(lines[0]) && /remotes: origin/.test(lines[0]) && /using 'origin'/.test(lines[0]) && /origin\/main/.test(lines[0]), lines[0] || null);
  ok("the resolvable project is never journalled as a substitution", !lines.some((l) => /right-remote/.test(l)), lines.filter((l) => /right-remote/.test(l)));

  exitCode = failures ? 1 : 0;
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run itself threw: ${String((e && e.stack) || e)}`);
  if (panel) console.log(`      panel log tail:\n${panel.log().split(/\r?\n/).slice(-25).join("\n")}`);
  exitCode = 2;
} finally {
  if (panel) await panel.stop().catch(() => {});
  if (KEEP) console.log(`kept: ${S}`);
  else rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${checks} checks, ${failures} failed`);
console.log(failures ? "RESULT: FAILED" : "RESULT: ALL PASS");
process.exit(exitCode);
