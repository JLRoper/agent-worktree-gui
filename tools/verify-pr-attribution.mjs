// Which PR a row shows, when the branch it shows is not the branch the PR was opened from.
//
// THE BUG. `prFor(index, branch)` looked a PR up by the branch's own name. This panel renames a finished
// worktree's BRANCH after the thread slug and keeps only the six-hex tag (lib/tree-names.js), so a PR opened under
// the old name became invisible: measured on this repo, a branch the panel renamed mid-run read "no PR" on the
// board while its PR was MERGED, and `tools/merged-branches.mjs` printed "nothing shows it landed" for it.
//
// THE FIX (lib/project.js). Three names are tried, cheapest-to-be-wrong first: the branch as it is now, the remote
// ref its upstream tracks (`branchUpstreams`, one `git for-each-ref` per project), and the six-hex tag.
//
// THE TRAP THIS SCRIPT EXISTS FOR. A tag identifies the TREE, not the work: an agent that changes branch INSIDE one
// worktree — the follow-up cut off main in the same tree, which no rename can be told apart from — would otherwise
// be handed the tree's old, already-merged PR, and the row would claim a branch had landed when it had not. So a
// tag match stands only while the tree still carries that PR's own commit (`row.head`, the branch tip the scan just
// read, is a prefix of the PR's `headRefOid`). A tip the scan did not read, or a PR whose head ref has since moved
// on, is not attribution material.
//
//   node tools/verify-pr-attribution.mjs
//
// WHAT IS DRIVEN
//   driven   the shipped grouping and lookup (`buildPrIndex` + `prFor`): the rename, the branch switch, the
//            upstream route, ambiguity, a non-hex suffix, a legacy bare-Map index
//   driven   REAL git (a scratch repo with a real worktree): `branchUpstreams` read from actual refs, a rename that
//            keeps the tag, a commit on top after the merge, and `git switch -c` to a new branch in the same tree
//   driven   the REAL PR list and this REAL checkout, read-only (`gh pr list` + git): the row for this very
//            worktree resolves to its merged PR, by upstream and (upstream unset) by tag, and the upstream is
//            restored and asserted. Needs a WORKTREE — run from the project's own checkout this half is skipped,
//            with a reason, because there is no worktree row to describe
//   driven   a sandbox panel on its own PANEL_CONFIG (own port, own stores, assistant off) pointing at THIS
//            checkout: the row it builds for this worktree carries the PR, which is what the chip on the board draws
//   inspected  the browser half: the chip's title text lives in public/app.js and is not clicked here
//
// The live panel on :7331 and the live gateway on :8642 are never touched. Nothing here writes to this repository:
// the only change it makes is to this worktree's own branch config (the upstream), and it puts it back.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrIndex, prFor, prIndex, branchUpstreams } from "../lib/project.js";
import { tagOf } from "../lib/tree-names.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// This worktree (where the test runs), and the checkout it belongs to — the project a panel would watch. The
// common git dir is the main checkout's `.git`, so its parent is the project, wherever the worktree sits.
const WORKTREE = path.resolve(HERE, "..");
const git = (dir, args) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};
const commonDir = git(WORKTREE, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out;
const MAIN = path.dirname(commonDir).replace(/\\/g, "/");
const PROJECT_NAME = path.basename(MAIN);
const ROW_PATH = `${MAIN}/.worktrees/${path.basename(WORKTREE)}`;
// Phases 3 and 4 describe the worktree this script is RUN FROM: its renamed branch, its upstream, and the row a
// panel builds for it. A linked worktree's git dir is a subdirectory of the project's common one; run from the
// project's own checkout those are the same path and there is no such row, so that half is skipped with a reason
// instead of being reported as a broken feature.
const isWorktree =
  git(WORKTREE, ["rev-parse", "--absolute-git-dir"]).out.toLowerCase() !== commonDir.toLowerCase();

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 500, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}
const heads = (dir) => git(dir, ["for-each-ref", "refs/heads", "--format=%(refname) %(objectname)"]).out;
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const pr = (number, headRefName, headRefOid, { state = "MERGED", title = `PR ${number}`, mergedAt = "2026-10-25T23:47:20Z" } = {}) => ({
  number,
  state,
  mergedAt,
  headRefName,
  headRefOid,
  title,
});
const HEAD40 = "ba3157a0db8533018f90a51ffd1a6c938941c051";

// Is a PR handed to a row justified by one of the three routes, and by which? The real-data phases below assert
// THROUGH this rather than against a hard-coded PR number, so they stay true whenever and wherever they run: a
// row may only show a PR that its own name, its upstream ref, or its tag-plus-tip can actually account for.
function routeFor(index, { branch, upstream = null, tip = null, base = null }, got) {
  if (!got) return null;
  const holds = (prs) => Boolean((prs || []).find((p) => p.number === got.number));
  if (branch && holds(index.byRef.get(branch))) return "ref";
  for (const u of [upstream?.ref, upstream?.upstream, typeof upstream === "string" ? upstream : null]) {
    if (!u) continue;
    const bare = String(u).replace(/^[^/]+\//, "");
    if (base && (String(u) === base || bare === base)) continue;
    if (holds(index.byRef.get(String(u))) || (bare !== u && holds(index.byRef.get(bare)))) return "upstream";
  }
  for (const name of [branch, upstream?.ref, upstream?.upstream]) {
    const tag = name ? tagOf(name) : null;
    if (!tag) continue;
    const list = (index.byTag.get(tag) || []).filter((p) => String(p.headRefOid || "").toLowerCase().startsWith(String(tip || "").toLowerCase()));
    if (holds(list)) return "tag";
  }
  return null;
}

console.log(`this worktree: ${WORKTREE}\nits project:   ${MAIN}`);

// ── 1. the shipped lookup, without gh and without git ───────────────────────────────────────────
console.log("\n1. the decisions (buildPrIndex + prFor, the shipped functions)");
const renamed = buildPrIndex([pr(27, "wtgui/old-name-1a2b3c", HEAD40, { title: "Re-attach a live run" })]);
check("the index is keyed by ref AND by the tree's tag", [[...renamed.byRef.keys()], [...renamed.byTag.keys()]], [["wtgui/old-name-1a2b3c"], ["1a2b3c"]]);
check("the branch as it stands is looked up by its own name", prFor(renamed, "wtgui/old-name-1a2b3c", { tip: HEAD40.slice(0, 7) })?.matched, "ref");
check(
  "a branch the panel RENAMED is found by the tag, and says so",
  prFor(renamed, "wtgui/new-name-1a2b3c", { tip: HEAD40.slice(0, 7) }),
  { number: 27, state: "MERGED", mergedAt: "2026-10-25T23:47:20Z", title: "Re-attach a live run", matched: "tag" },
);
check("...and carries the PR's title, which is the chip's tooltip", prFor(renamed, "wtgui/new-name-1a2b3c", { tip: HEAD40.slice(0, 7) })?.title, "Re-attach a live run");

console.log("   the case the tag must NOT answer: a branch changed inside one tree, and a branch that moved on");
check("a branch switched inside the tree is NOT given the tree's old PR", prFor(renamed, "wtgui/follow-up-1a2b3c", { tip: "a1b2c3d" }), null);
check("...nor is a renamed branch whose tip has moved past the PR's head", prFor(renamed, "wtgui/new-name-1a2b3c", { tip: "0000000" }), null);
check("a tip the scan never read is not a licence to guess", prFor(renamed, "wtgui/new-name-1a2b3c", {}), null);
check("...while the branch's own name needs no tip at all", prFor(renamed, "wtgui/old-name-1a2b3c")?.number, 27);
check("a PR with no headRefOid cannot be matched by tag", prFor(buildPrIndex([{ number: 9, state: "MERGED", headRefName: "wtgui/x-2b3c4d", title: "no sha" }]), "wtgui/y-2b3c4d", { tip: "aaaa111" }), null);

console.log("   the upstream route, and what wins when two routes could answer");
const pushed = buildPrIndex([pr(31, "wtgui/pushed-name-4d5e6f", "c0ffee0000000000000000000000000000000000", { state: "OPEN" })]);
check(
  "a branch whose upstream names the PR's ref is found by that ref",
  prFor(pushed, "wtgui/local-renamed-4d5e6f", { upstream: { ref: "wtgui/pushed-name-4d5e6f", upstream: "origin/wtgui/pushed-name-4d5e6f" }, tip: "9999999" })?.matched,
  "upstream",
);
check(
  "an upstream only known in its remote-prefixed form still answers",
  prFor(pushed, "wtgui/local-renamed-4d5e6f", { upstream: "origin/wtgui/pushed-name-4d5e6f", tip: "9999999" })?.number,
  31,
);
const both = buildPrIndex([
  pr(5, "wtgui/same-name-7a8b9c", "1111111000000000000000000000000000000000", { state: "MERGED" }),
  pr(6, "wtgui/other-name-7a8b9c", "1111111000000000000000000000000000000000", { state: "OPEN" }),
]);
check("the branch's own name wins over the tag", prFor(both, "wtgui/same-name-7a8b9c", { tip: "1111111" })?.number, 5);
check("the upstream wins over the tag too", prFor(both, "wtgui/third-name-7a8b9c", { upstream: { ref: "wtgui/other-name-7a8b9c" }, tip: "1111111" })?.number, 6);
const reland = buildPrIndex([
  pr(4, "wtgui/old-9c8d7e", "2222222000000000000000000000000000000000", { state: "MERGED" }),
  pr(12, "wtgui/new-9c8d7e", "2222222000000000000000000000000000000000", { state: "OPEN" }),
]);
check("when one tree appeared in two PRs the newest is the row's", prFor(reland, "wtgui/renamed-9c8d7e", { tip: "2222222" })?.number, 12);
check("a non-hex suffix is never a tag", prFor(buildPrIndex([pr(3, "wtgui/old-abcdefg", HEAD40)]), "wtgui/new-abcdefg", { tip: HEAD40.slice(0, 7) }), null);
// A branch that merely TRACKS the base branch has not been pushed anywhere of its own: `git worktree add` sets
// that upstream up by itself, and a PR's head ref can be named `main` (a fork's). Measured on this repo — a fresh
// worktree, upstream `github/main`, was handed an OPEN fork PR whose head ref was `main`.
const forkPr = buildPrIndex([pr(18, "main", "3333333000000000000000000000000000000000", { state: "OPEN" })]);
check("tracking the base branch is not a PR for the branch", prFor(forkPr, "wtgui/fresh-abc123", { upstream: { ref: "main", upstream: "github/main" }, tip: "4444444", base: "main" }), null);
check("...while the base branch itself still answers by its own name", prFor(forkPr, "main", { base: "main" })?.number, 18);
check("...and an upstream that is NOT the base is still believed", prFor(forkPr, "wtgui/x-abc123", { upstream: { ref: "wtgui/y-abc123", upstream: "github/wtgui/y-abc123" }, tip: "4444444", base: "main" })?.number, undefined);
const legacy = new Map([["wtgui/plain-5f6a7b", [pr(2, "wtgui/plain-5f6a7b", HEAD40)]]]);
check("an index in the older bare-Map shape still answers by ref", prFor(legacy, "wtgui/plain-5f6a7b")?.number, 2);
check("...and never claims a tag match it cannot check", prFor(legacy, "wtgui/renamed-5f6a7b", { tip: "1234567" }), null);

// ── 2. real git: the refs the branch and its upstream actually carry ───────────────────────────
console.log("\n2. real git — a rename that keeps the tag, and a branch switch inside the same tree");
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-pr-tag-"));
const repo = path.join(dir, "repo");
const tree = path.join(dir, "trees", "old-name-1a2b3c");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# scratch\n");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
git(repo, ["remote", "add", "origin", "https://example.invalid/scratch.git"]);
git(repo, ["worktree", "add", "-q", "-b", "wtgui/old-name-1a2b3c", tree]);
writeFileSync(path.join(tree, "work.txt"), "the branch's own commit\n");
git(tree, ["add", "."]);
git(tree, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "the branch's work"]);
const workTip = git(tree, ["rev-parse", "HEAD"]).out;
git(repo, ["update-ref", "refs/remotes/origin/wtgui/old-name-1a2b3c", workTip]);
git(tree, ["branch", "--set-upstream-to=origin/wtgui/old-name-1a2b3c"]);
const scratchPr = buildPrIndex([pr(27, "wtgui/old-name-1a2b3c", workTip, { title: "Re-attach a live run" })]);
const tip7 = workTip.slice(0, 7);

// The panel renames the branch after the thread slug, keeping the tag.
git(tree, ["branch", "-m", "wtgui/new-name-1a2b3c"]);
const afterRename = await branchUpstreams({ path: tree });
check("the branch rename kept the tag", git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]).out, "wtgui/new-name-1a2b3c");
check(
  "the upstream is read from real refs, with its remote prefix taken off",
  afterRename.get("wtgui/new-name-1a2b3c"),
  { upstream: "origin/wtgui/old-name-1a2b3c", ref: "wtgui/old-name-1a2b3c" },
);
check("the renamed branch resolves through that upstream", prFor(scratchPr, "wtgui/new-name-1a2b3c", { upstream: afterRename.get("wtgui/new-name-1a2b3c"), tip: tip7 })?.matched, "upstream");

// No upstream at all: the tag is the only route left, and the tip is what makes it safe.
git(tree, ["branch", "--unset-upstream"]);
const noUpstream = await branchUpstreams({ path: tree });
check("git reports no upstream once it is unset", noUpstream.has("wtgui/new-name-1a2b3c"), false);
check("the renamed branch resolves by its tag alone", prFor(scratchPr, "wtgui/new-name-1a2b3c", { tip: tip7 })?.matched, "tag");

// More commits on top after the merge: the PR no longer describes this branch's tip.
writeFileSync(path.join(tree, "more.txt"), "more work after the merge\n");
git(tree, ["add", "."]);
git(tree, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "more work after the merge"]);
const movedTip = git(tree, ["rev-parse", "--short=7", "HEAD"]).out;
check("a branch that kept committing after the merge is not given that PR", prFor(scratchPr, "wtgui/new-name-1a2b3c", { tip: movedTip }), null);

// THE SCENARIO: the agent changes branch inside the same worktree — a follow-up cut off main, same tag.
git(tree, ["switch", "-q", "-c", "wtgui/follow-up-1a2b3c", "main"]);
git(tree, ["branch", "--unset-upstream"]);
const switched = await branchUpstreams({ path: tree });
const switchedTip = git(tree, ["rev-parse", "--short=7", "HEAD"]).out;
check("the switch landed on a new branch in the same tree, tag and all", git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]).out, "wtgui/follow-up-1a2b3c");
check("the new branch has no upstream of its own", switched.has("wtgui/follow-up-1a2b3c"), false);
check("THE BRANCH SWITCH GETS NO PR — not the tree's old one", prFor(scratchPr, "wtgui/follow-up-1a2b3c", { upstream: switched.get("wtgui/follow-up-1a2b3c") || null, tip: switchedTip }), null);
check("while the branch the PR really was is still attributed by its name", prFor(scratchPr, "wtgui/old-name-1a2b3c", { tip: tip7 })?.number, 27);
rmSync(dir, { recursive: true, force: true });

if (!isWorktree) {
  console.log("\n      WORKTREE-HALF-SKIPPED — this checkout IS the project, so there is no worktree row to describe; run this from a worktree (one branch per tree) to prove phases 3 and 4.");
} else {
  // ── 3. the real PR list, and this real checkout ─────────────────────────────────────────────
  console.log("\n3. the real PR list and this checkout (read-only: gh pr list + git reads)");
  const project = { name: PROJECT_NAME, path: MAIN, remote: "github", mainBranch: "main", prRepo: "JLRoper/agent-worktree-gui" };
  const liveIndex = await prIndex(project, 0);
  const ups = await branchUpstreams(project);
  let tagRows = 0;
  let here = null;
  let tagTree = null;
  if (!liveIndex.byRef.size) {
    failures += 1;
    console.log("LIVE-PR-HALF-NOT-RUN  gh pr list answered nothing for JLRoper/agent-worktree-gui — this phase proves nothing");
  } else {
    console.log(`      gh listed ${liveIndex.byRef.size} head ref(s), ${liveIndex.byTag.size} tag(s)`);
    const headsBefore = heads(MAIN);
    const trees = git(MAIN, ["worktree", "list", "--porcelain"]).out.split(/\r?\n/).reduce((acc, l) => {
      if (l.startsWith("worktree ")) acc.push({ path: l.slice(9).trim(), branch: null });
      else if (l.startsWith("branch ") && acc.length) acc[acc.length - 1].branch = l.slice(7).trim().replace("refs/heads/", "");
      return acc;
    }, []);
    for (const wt of trees) {
      if (!wt.branch) continue;
      const tip = git(wt.path, ["rev-parse", "--short=7", "HEAD"]).out;
      const upstream = ups.get(wt.branch) || null;
      const got = prFor(liveIndex, wt.branch, { upstream, tip, base: "main" });
      // Every local branch of this checkout against the real PR list: whatever the lookup hands a row has to be
      // accounted for by that row's own name, by its upstream ref, or by its tag AND the commit the tree carries.
      const route = routeFor(liveIndex, { branch: wt.branch, upstream, tip, base: "main" }, got);
      check(`the PR shown for ${wt.branch} is one its own name, upstream or tag accounts for`, got ? [got.number, got.matched] : null, route ? [got.number, route] : null);
      if (route === "tag") {
        tagRows += 1;
        if (!tagTree) tagTree = { wt, got, route };
        if (tagRows === 1) {
          // The rule, on real data: the tag answers while the tree carries that PR's commit, and not otherwise.
          const head = String((liveIndex.byTag.get(tagOf(wt.branch)) || []).find((p) => p.number === got.number)?.headRefOid || "");
          check("...and the tag route answers for a tree still carrying that PR's commit", (() => {
            const p = prFor(liveIndex, wt.branch, { upstream: null, tip: head.slice(0, 7), base: "main" });
            return [p?.number, p?.matched];
          })(), [got.number, "tag"]);
          check("...and refuses it for a tip that belongs to nothing", prFor(liveIndex, wt.branch, { upstream: null, tip: "0000000", base: "main" }), null);
        }
      }
      if (wt.path.replace(/\\/g, "/").toLowerCase() === WORKTREE.replace(/\\/g, "/").toLowerCase()) here = { wt, got, route };
    }
    console.log(`      ${trees.length} worktree(s) of this checkout checked · ${tagRows} of them are RENAMED branches, whose row only the tag can account for`);
    ok("this checkout still contains a renamed branch — the case this change exists for", tagRows > 0, `${tagRows} row(s)`);
    console.log(`      this worktree's branch ${here?.wt?.branch || "(none)"} resolves to ${JSON.stringify(here?.got || null)}${here?.route ? ` (${here.route})` : " — no PR of its own"}`);
    if (here?.got) check("...and this worktree's row was resolved by a justified route", here.got.matched, here.route);
    // The control is a REAL local branch that no PR names: a branch the panel knows about, with nothing to show.
    const noPrBranch = "land/pr-7";
    ok("the control branch really exists in this checkout", git(MAIN, ["rev-parse", "--verify", `refs/heads/${noPrBranch}`]).ok, noPrBranch);
    check("...and it is given no PR at all", prFor(liveIndex, noPrBranch, { tip: git(MAIN, ["rev-parse", "--short=7", `refs/heads/${noPrBranch}`]).out, base: "main" }), null);
    ok("no branch of this checkout moved while the PR list was read", heads(MAIN) === headsBefore, `${headsBefore.split("\n").length} branch(es)`);
  }

  // ── 4. the row a panel builds, which is what the chip draws ───────────────────────────────────
  // The row to assert on is the one phase 3 found the lookup can least explain by name: a renamed branch whose only
  // route is the tag (falling back to this worktree's own row when it has a PR of its own). A worktree cut for a
  // brand-new branch has no PR and is not the case under test.
  const target = (here?.got ? here : null) || (typeof tagTree !== "undefined" ? tagTree : null);
  console.log("\n4. a sandbox panel on this checkout: the row it builds for a renamed tree");
  const sandbox = mkdtempSync(path.join(tmpdir(), "wtgui-pr-row-"));
  const scanRoot = path.join(sandbox, "scan-root");
  const home = path.join(sandbox, "hermes-home");
  const configDir = path.join(sandbox, "panel");
  const cwdDir = path.join(sandbox, "panel-cwd");
  for (const d of [scanRoot, home, configDir, cwdDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        // The project under test is the checkout this worktree belongs to, declared explicitly: the panel scans it
        // read-only (git reads, one `git ls-remote` and one `gh pr list`), and nothing here writes to it.
        projects: [{ name: PROJECT_NAME, path: MAIN, remote: "github", mainBranch: "main", prRepo: "JLRoper/agent-worktree-gui" }],
        refreshSeconds: 5,
        worktreeSeconds: 3,
        midSeconds: 8,
        slowSeconds: 10,
        fetchSeconds: 100000,
        threads: 1,
        defaultCwd: cwdDir,
        jobsFile: path.join(configDir, "logs", "jobs.json"),
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const base = `http://127.0.0.1:${port}`;
  const panelLog = [];
  let panel = null;
  const headsAtStart = heads(MAIN);
  const rowAt = async (want) => {
    const s = await fetch(`${base}/api/state`).then((r) => r.json());
    const p = (s.projects || []).find((x) => x.name === PROJECT_NAME);
    const w = String(want).replace(/\\/g, "/").toLowerCase();
    return { project: p || null, row: (p?.worktrees || []).find((r) => String(r.path || "").replace(/\\/g, "/").toLowerCase() === w) || null };
  };
  ok("the row under test is a tree whose PR only its own route can explain", Boolean(target), target ? `${target.wt.branch} → #${target.got?.number} (${target.route})` : "(none found)");
  try {
    panel = spawn(process.execPath, ["server.js"], {
      cwd: WORKTREE,
      env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
    panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
    const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 60_000, what: "the sandbox panel to answer /api/state" });
    ok("the sandbox panel came up on its own port", up, `http://127.0.0.1:${port}`);
    ok(
      "...and it logs this checkout as the project it monitors",
      panelLog.some((l) => new RegExp(`projects: .*${PROJECT_NAME}`).test(l)),
      panelLog.find((l) => /projects:/.test(l)) || "",
    );
    const found = await waitFor(async () => Boolean((await rowAt(target.wt.path)).row), { timeoutMs: 150_000, stepMs: 1000, what: "that worktree to appear as a row" });
    ok("that tree is a row on the board", found, target.wt.path);
    const decorated = await waitFor(async () => Boolean((await rowAt(target.wt.path)).row?.pr), { timeoutMs: 180_000, stepMs: 1500, what: "the row to be decorated with its PR" });
    ok("the row is decorated with its PR", decorated, JSON.stringify((await rowAt(target.wt.path)).row?.pr || null));
    const row = (await rowAt(target.wt.path)).row || {};
    const rowTip = String(row.head || git(target.wt.path, ["rev-parse", "--short=7", "HEAD"]).out || "");
    const rowRoute = routeFor(liveIndex, { branch: row.branch, upstream: ups.get(row.branch) || null, tip: rowTip, base: "main" }, row.pr);
    ok("...and it is one its own name, upstream or tag accounts for", Boolean(row.pr) && row.pr.matched === rowRoute, JSON.stringify(row.pr || null));
    check("...with the route the row says it matched by", row.pr?.matched, rowRoute);
    check("...and the panel's own row agrees with the lookup for that branch", [row.pr?.number, row.pr?.matched], [target.got.number, target.got.matched]);
    console.log(`      the row reads: branch ${row.branch} · verdict "${row.verdict}" · PR #${row.pr?.number} ${row.pr?.state} (${row.pr?.matched})`);
    ok("no branch of this checkout moved while it was scanned", heads(MAIN) === headsAtStart, `${headsAtStart.split("\n").length} branch(es)`);
  } catch (e) {
    failures += 1;
    console.log(`phase 4 threw: ${String((e && e.message) || e)}`);
    console.log(panelLog.slice(-20).join("\n"));
  } finally {
    if (panel) {
      panel.kill();
      await waitFor(() => panel.exitCode !== null || panel.signalCode !== null, { timeoutMs: 10_000, what: "the sandbox panel to exit" });
      if (panel.exitCode === null) {
        try {
          execFileSync("taskkill", ["/PID", String(panel.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } catch {
          /* already gone */
        }
      }
      panel.stdout?.destroy();
      panel.stderr?.destroy();
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
}


console.log("\nDRIVEN: the shipped buildPrIndex/prFor decisions, real git refs in a scratch repo (rename, commit-after-merge," + (isWorktree ? "" : " [phases 3-4 SKIPPED: not run from a worktree]"));
console.log("        branch switch in one tree), the real PR list plus this checkout read-only, and a sandbox panel on");
console.log("        its own PANEL_CONFIG whose row for this worktree is what the board draws.");
console.log("INSPECTED: the browser half — the chip markup/tooltip in public/app.js is not clicked here.");
console.log(failures ? `RESULT: ${failures} FAILED of ${checks}` : `RESULT: ALL PASS (${checks} checks)`);
process.exit(failures ? 1 : 0);
