// A worker asking the panel to remove the worktree it can never remove itself.
//
// The problem this exists for is mechanical: an agent's own cwd is inside the tree, and on Windows an open handle
// keeps a directory busy, so `git worktree remove` from inside that tree fails on its last step (the rmdir) every
// time — and a worker that tries harder with `rmdir /s /q` or `Remove-Item -Recurse -Force` walks into the gateway's
// destructive-command gate, which expires the call after 600 seconds. That is what wedged a cleanup worker. So the
// worker does not delete anything: it ends its turn with ONE marker line, and the PANEL — a different process, with
// its cwd outside every tree — does the removal after the run has settled.
//
// The grammar, read out of a settled turn's FINAL message (never out of the middle of a transcript):
//
//     RELEASE <worktree path or slug> | <why it is finished>
//
//   <worktree path or slug>  the tree's path (quoted if it has spaces), a path suffix, its directory name, its
//                            branch, or the six-hex tag the panel keeps across a rename. Resolution is
//                            `resolveTreeTarget`, and it names the tree it matched.
//   <why it is finished>     required. A request with no reason is refused with a sentence, because the reason is
//                            the only thing the reader has to go on if a gate then says no.
//
// Two halves, deliberately apart:
//
//   1. `ReleaseRequests.record()` — the request. Called once per settled run, from lib/jobs.js, where the TODO lines
//      are harvested too. It writes the tree's row (tree, requestedAt, runId, why) and ACTS ON NOTHING. Nothing in a
//      worker's own run can reach the executor, so a worker cannot evict the tree it is still standing in.
//   2. `releaseWorktree()` — the executor, swept by server.js after the turn settled. Every gate is measured by the
//      panel with its own git/gh calls; not one of them is taken from the worker's word:
//
//        releaseWorktrees  the project's own switch, `projects[].releaseWorktrees` in config.json. Strictly `true`:
//                          an unreadable value is OFF, because a delete permission that is assumed is not one.
//        lock              the reader's own lock on the tree (lib/locks.js) — "leave this alone" outranks a worker.
//        worktree          git must still list it, and it must not be the project's own checkout.
//        clean             `git status --porcelain` empty. The file list is the only copy of anything uncommitted.
//        pr                `gh pr view <n> --json state,mergeCommit` must read MERGED, with a merge commit.
//        tree              nothing on this tree that the landed commit does not already contain — an empty
//                          `git diff --merge-base <mergeCommit> HEAD`, or HEAD's tree identical to the merge
//                          commit's (the squash/rebase shape, where the content is what landed even though the
//                          SHAs were rewritten). git REJECTS `--merge-base` with `A..B` ("does not work with
//                          ranges"), so the two-revision form is what is run: measured, not assumed.
//        jobs              no job in the store is still holding that tree (`running`, `starting`, `waiting`, `queued`).
//
// Then, in this order and only after every gate passed: `git worktree remove <path>`, `git branch -D <branch>`,
// `git push <remote> --delete <branch>`, and a PLAIN `rmdir` for an empty shell a held handle left behind.
// `git branch -D` is correct here only because the PR read MERGED and the tree-equal gate passed first; and the shell
// is removed with `fs.rmdir` (non-recursive) — never `rmdir /s /q`, never `Remove-Item -Recurse -Force`, never
// `fs.rm({recursive})` — because the gateway's destructive-command gate expires those and a non-recursive rmdir
// cannot delete a file it did not mean to.
//
// The outcome goes back onto the row as `removed` or `refused: <the gate that said no>`, and the whole record (with
// each step's own result) is kept in the store beside the job store, so a panel restart can still say what happened.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rmdir as rmdirP } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { LIVE_JOB_STATUS } from "./jobs.js";
import { buildPrIndex, prFor } from "./project.js";
import { tagOf } from "./tree-names.js";

const execP = promisify(execFile);

export const RELEASES_VERSION = 1;
// How many requests the store keeps. A tree is released once and its record is history after that; the cap is what
// keeps a year of releases from growing a file the panel rewrites whole.
export const RELEASE_KEEP = 200;
export const RELEASE_WHY_CAP = 300;
export const RELEASE_OUTCOME_REMOVED = "removed";

const nowIso = () => new Date().toISOString();
const oneLine = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// One spelling of a tree path, everywhere: resolved, forward slashes, no trailing separator, and NOT case-folded —
// the display spelling is kept, and comparisons fold with `pathKey` below.
export const normTreePath = (p) => {
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  return path.resolve(raw).replace(/\\/g, "/").replace(/\/+$/, "");
};
// The comparison spelling: case-folded, because Windows hands the same directory back in whichever case it likes.
export const pathKey = (p) => normTreePath(p).toLowerCase();
// A target the way it was WRITTEN: no `path.resolve`, because an agent writes `.worktrees/<name>` relative to the
// repository and resolving that against the panel's cwd would name a directory that has nothing to do with it.
const rawKey = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
const lastSegment = (p) => String(p || "").split("/").filter(Boolean).pop() || "";

// ---- the marker ----------------------------------------------------------------------------------------------------
// The pure half: text in, markers out. Nothing here knows about the panel, so the grammar is testable on its own.
//
// A line that looks like a marker and cannot be read comes back with an `error` and is NOT a request: the caller says
// it on the card. Silence is what makes an agent's request vanish, which is the failure this whole feature is for.
export function parseReleaseLines(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^RELEASE\b/i.test(line)) continue;
    const body = line.replace(/^RELEASE\b/i, "").trim();
    if (!body) {
      out.push({ target: null, why: "", raw: line, error: "a RELEASE line needs a worktree and `| <why it is finished>`" });
      continue;
    }
    // The pipe is the one separator: a Windows path carries colons and spaces, so neither can also be the field
    // break. Split on the FIRST pipe — a reason may well contain another one.
    const at = body.indexOf("|");
    if (at < 0) {
      out.push({ target: null, why: "", raw: line, error: "RELEASE needs `| <why it is finished>` after the worktree" });
      continue;
    }
    const target = body.slice(0, at).trim().replace(/^["'`]|["'`]$/g, "").trim();
    const why = oneLine(body.slice(at + 1), RELEASE_WHY_CAP);
    if (!target) {
      out.push({ target: null, why: "", raw: line, error: "RELEASE names no worktree" });
      continue;
    }
    if (!why) {
      out.push({ target: null, why: "", raw: line, error: `RELEASE names no reason — say what makes "${oneLine(target, 60)}" finished` });
      continue;
    }
    out.push({ target, why, raw: line, error: null });
  }
  return out;
}

// Which tree a marker names. `trees` is what the panel knows — `{project, path, branch}` per row — and the order is
// cheapest-and-least-ambiguous first: the whole path, a path SUFFIX (an agent often writes `.worktrees/<name>`), the
// directory name, the branch, then the six-hex tag. A slug that matches two trees resolves to neither: a delete
// decided by a coin toss is worse than one that asks again.
export function resolveTreeTarget(target, trees = []) {
  const want = String(target ?? "").trim();
  if (!want) return null;
  const list = (trees || []).filter((t) => t && t.path);
  const wantKey = pathKey(want);
  const fold = (s) => String(s ?? "").trim().toLowerCase();

  const unique = (hits) => {
    const seen = new Map();
    for (const hit of hits) seen.set(pathKey(hit.path), hit);
    return seen.size === 1 ? [...seen.values()][0] : null;
  };

  const exact = unique(list.filter((t) => pathKey(t.path) === wantKey));
  if (exact) return exact;

  // A suffix on a segment boundary: `…/.worktrees/foo` names the tree whose path ends that way. Compared on the RAW
  // spelling as well as the resolved one, because `.worktrees/foo` is how a worker inside the repo names its own tree.
  const wantRaw = rawKey(want);
  const suffix = unique(list.filter((t) => pathKey(t.path).endsWith(`/${wantKey}`) || (wantRaw && rawKey(t.path).endsWith(`/${wantRaw}`))));
  if (suffix) return suffix;

  const byName = unique(list.filter((t) => fold(lastSegment(t.path)) === fold(want)));
  if (byName) return byName;

  const byBranch = unique(list.filter((t) => t.branch && fold(t.branch) === fold(want.replace(/^refs\/heads\//, ""))));
  if (byBranch) return byBranch;

  const tag = tagOf(want);
  if (tag) {
    const byTag = unique(list.filter((t) => tagOf(t.branch || "") === tag || tagOf(lastSegment(t.path)) === tag));
    if (byTag) return byTag;
  }
  return null;
}

// "Is this project allowed to release trees at all?" — the switch Part 4 of the brief asks for, and it is strictly
// `true`. A string "true", a 1, or anything else is OFF: the panel reads config.json, which is JSON, so a boolean is
// what a reader writes, and an unreadable value must never open a delete.
export const releasesEnabled = (project) => project?.releaseWorktrees === true;

// The statuses that mean a turn is still holding its tree. The panel's own live set (lib/jobs.js) plus `queued`: a job
// written by another build, or a status word the gateway adds, must not let a delete into a tree something is using.
export const RELEASE_BUSY_STATUS = new Set([...LIVE_JOB_STATUS, "queued"]);
export const isReleaseBusyStatus = (s) => RELEASE_BUSY_STATUS.has(String(s || ""));

// The one live job standing in a tree, if there is one. `cwd`, `ownerPath` and `worktreePath` are all consulted: a
// job's cwd is where its run is, its ownerPath is the tree the panel cut for it, and a run that has not been given a
// directory yet has neither.
export function jobHoldingTree(jobs = [], tree) {
  const key = pathKey(tree);
  if (!key) return null;
  for (const job of jobs || []) {
    if (!job || !isReleaseBusyStatus(job.status)) continue;
    for (const candidate of [job.cwd, job.ownerPath, job.worktreePath]) {
      if (candidate && pathKey(candidate) === key) return job;
    }
  }
  return null;
}

// ---- the store -------------------------------------------------------------------------------------------------------
// One record per tree, keyed the way the board's row is (`<project>::<path>`), written through a temp file + rename
// like every other store in this panel. Every writer is this one Node process, so the store is its own lock.
export class ReleaseRequests {
  constructor({ file = null, log = () => {}, trees = null } = {}) {
    this.file = file;
    this.log = log;
    this.treesProvider = trees;
    this.records = new Map();
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const recs = raw && typeof raw === "object" && raw.requests && typeof raw.requests === "object" ? raw.requests : {};
      for (const [key, rec] of Object.entries(recs)) {
        if (!rec || typeof rec !== "object" || !rec.path) continue;
        this.records.set(key, {
          key,
          project: rec.project || String(key).split("::")[0] || null,
          path: normTreePath(rec.path),
          branch: rec.branch || null,
          why: String(rec.why || ""),
          requestedAt: rec.requestedAt || null,
          runId: rec.runId || null,
          thread: rec.thread || null,
          // `requested` is the only state that has not been answered yet; anything else is history the card reads.
          state: ["requested", "removed", "refused"].includes(rec.state) ? rec.state : "requested",
          outcome: rec.outcome || null,
          at: rec.at || null,
          detail: String(rec.detail || ""),
          steps: Array.isArray(rec.steps) ? rec.steps : [],
        });
      }
    } catch (err) {
      if (existsSync(this.file)) this.log(`releases: could not read ${this.file} (${String((err && err.message) || err)}) — starting empty`);
    }
    return this;
  }

  save() {
    if (!this.file) return this;
    this.load();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const recs = [...this.records.values()]
        .sort((a, b) => String(b.requestedAt || "").localeCompare(String(a.requestedAt || "")))
        .slice(0, RELEASE_KEEP);
      this.records = new Map(recs.map((r) => [r.key, r]));
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: RELEASES_VERSION, requests: Object.fromEntries(recs.map((r) => [r.key, r])) }, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      this.log(`releases: could not write ${this.file} (${String((err && err.message) || err)})`);
    }
    return this;
  }

  get size() {
    this.load();
    return this.records.size;
  }

  all() {
    this.load();
    return [...this.records.values()];
  }

  get(key) {
    this.load();
    return this.records.get(key) || null;
  }

  // Every tree the store may name: the panel's rows (path + branch), and — handed in by the caller — the run's own
  // two candidate paths, so a marker written by a worker whose row has not been scanned yet still resolves.
  candidateTrees(extra = []) {
    const out = [];
    const seen = new Set();
    const add = (t) => {
      if (!t || !t.path) return;
      const key = pathKey(t.path);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ project: t.project || null, path: normTreePath(t.path), branch: t.branch || null });
    };
    for (const t of this.treesProvider ? this.treesProvider() || [] : []) add(t);
    for (const t of extra || []) add(t);
    return out;
  }

  // A settled run's last words. Records (or refuses, out loud) one request per marker and returns what happened;
  // `lines` are console lines for the card, in the panel's own voice.
  record({ job = {}, finalText = "", now = Date.now(), trees = null } = {}) {
    this.load();
    const out = { requests: [], refused: [], lines: [] };
    const markers = parseReleaseLines(finalText);
    if (!markers.length) return out;
    const candidates = this.candidateTrees(
      trees || [
        { project: job.project, path: job.worktreePath, branch: job.branch },
        { project: job.project, path: job.ownerPath, branch: job.branch },
      ],
    );
    for (const mark of markers) {
      if (mark.error) {
        out.refused.push({ raw: mark.raw, error: mark.error });
        out.lines.push({ kind: "raw", text: `⚠ RELEASE was NOT recorded — ${mark.error}` });
        continue;
      }
      const hit = resolveTreeTarget(mark.target, candidates);
      if (!hit) {
        const why = `no worktree the panel knows matches “${oneLine(mark.target, 80)}”`;
        out.refused.push({ raw: mark.raw, error: why });
        out.lines.push({ kind: "raw", text: `⚠ RELEASE was NOT recorded — ${why} (the panel matches a path, a directory name, a branch or the six-hex tag)` });
        continue;
      }
      const rec = this.put({
        project: hit.project,
        path: hit.path,
        branch: hit.branch,
        why: mark.why,
        runId: job.id || null,
        thread: job.thread || null,
        now,
      });
      out.requests.push(rec);
      out.lines.push({
        kind: "dim",
        text: `⇢ RELEASE requested for ${rec.path}${rec.branch ? ` (${rec.branch})` : ""} — ${rec.why}`,
      });
    }
    if (out.requests.length) this.save();
    return out;
  }

  // One record per tree. A second request for the same tree REPLACES the first: the newest sentence is the one the
  // reader acts on, and a stale `requested` record must not outlive the tree it named.
  put({ project, path: treePath, branch = null, why = "", runId = null, thread = null, now = Date.now() } = {}) {
    this.load();
    const key = `${String(project || "")}::${normTreePath(treePath)}`;
    const rec = {
      key,
      project: project ? String(project) : String(key).split("::")[0],
      path: normTreePath(treePath),
      branch: branch || null,
      why: oneLine(why, RELEASE_WHY_CAP),
      requestedAt: new Date(now).toISOString(),
      runId: runId || null,
      thread: thread || null,
      state: "requested",
      outcome: null,
      at: null,
      detail: "",
      steps: [],
    };
    this.records.set(key, rec);
    return rec;
  }

  // What the executor decided, written back onto the record the row reads. `outcome` is the sentence the brief asks
  // for: `removed`, or `refused: <gate that failed>`.
  finish(key, { outcome, detail = "", steps = [], now = Date.now() } = {}) {
    this.load();
    const rec = this.records.get(key);
    if (!rec) return null;
    const text = String(outcome || "");
    rec.outcome = text;
    rec.state = text === RELEASE_OUTCOME_REMOVED ? "removed" : "refused";
    rec.detail = oneLine(detail, 400);
    rec.steps = (steps || []).map((s) => ({ step: String(s.step || ""), ok: Boolean(s.ok), detail: oneLine(s.detail, 240) }));
    rec.at = new Date(now).toISOString();
    this.save();
    return rec;
  }

  // Requests nothing has answered yet. A `removed` record is history; a `refused` one is answered (the reader or the
  // worker asks again with a new marker, which replaces it).
  pending() {
    this.load();
    return this.all().filter((r) => r.state === "requested");
  }

  // What the row carries. Deliberately small: the tree, when it was asked for, by which run, why, and the outcome.
  forRow(project, treePath) {
    this.load();
    const rec = this.records.get(`${String(project || "")}::${normTreePath(treePath)}`);
    if (!rec) return null;
    return {
      path: rec.path,
      branch: rec.branch,
      requestedAt: rec.requestedAt,
      runId: rec.runId,
      why: rec.why,
      state: rec.state,
      outcome: rec.outcome,
      at: rec.at,
      detail: rec.detail,
    };
  }
}

// ---- the executor ----------------------------------------------------------------------------------------------------
// `run` and `runGh` are the two subprocess seams; both default to the real thing, and both return `{ok, out, err}`
// instead of throwing, because every gate has to be able to say WHAT failed without an exception deciding it.
export async function defaultRun(args, cwd, timeout = 60_000) {
  try {
    const { stdout, stderr } = await execP("git", ["-C", cwd, ...args], { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: String(stdout || ""), err: String(stderr || "") };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || ""), err: String((e && e.stderr) || (e && e.message) || e) };
  }
}

export async function defaultGh(args, cwd, timeout = 60_000) {
  try {
    const { stdout, stderr } = await execP("gh", args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: String(stdout || ""), err: String(stderr || "") };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || ""), err: String((e && e.stderr) || (e && e.message) || e) };
  }
}

const lastLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || "";

// git's `worktree list --porcelain`, parsed here rather than in lib/project.js because this module's runner is the
// injected seam: a gate must be testable without a real repo.
export function parseWorktreeListing(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: normTreePath(line.slice("worktree ".length)), branch: null, bare: false, locked: false };
      out.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (cur && line === "bare") {
      cur.bare = true;
    } else if (cur && line.startsWith("locked")) {
      cur.locked = true;
    }
  }
  return out;
}

const refusal = (gate, why, extra = {}) => ({ ok: false, gate, outcome: `refused: ${why}`, detail: why, steps: [], ...extra });

// The whole act for one request, and every gate before it. Returns:
//   { ok, outcome, gate, detail, steps: [{step, ok, detail}], path, branch, pr, mergeCommit }
// `outcome` is exactly what goes onto the row: `removed`, or `refused: <gate that failed>`.
export async function releaseWorktree({
  project = null,
  request = null,
  row = null,
  jobs = null,
  locks = null,
  log = () => {},
  run = defaultRun,
  runGh = defaultGh,
  onStep = () => {},
} = {}) {
  if (!project || !project.path) return refusal("project", `unknown project for ${request?.path || "(no path)"}`);
  if (!request || !request.path) return refusal("request", "this request names no worktree");
  const tree = normTreePath(request.path);
  const projectDir = normTreePath(project.path);
  const steps = [];
  const step = (name, ok, detail = "") => {
    const rowOut = { step: name, ok, detail: oneLine(detail, 240) };
    steps.push(rowOut);
    onStep(rowOut);
    return rowOut;
  };
  const base = { path: tree, branch: request.branch || null, steps };

  // 1. the project's own switch ---------------------------------------------------------------------------------
  if (!releasesEnabled(project)) {
    return refusal("releaseWorktrees", `releaseWorktrees is off for project ${project.name || "(unnamed)"}`, base);
  }

  // 2. the reader's lock ----------------------------------------------------------------------------------------
  if (locks?.check) {
    const lock = locks.check({ project: project.name, path: request.path, branch: request.branch || null });
    if (lock?.locked) return refusal("lock", lock.reason || "the reader locked this worktree", base);
  }

  // 3. it is a worktree of this project, and not the checkout itself ---------------------------------------------
  if (projectDir === tree) return refusal("worktree", `${tree} is the project's own checkout, not a worktree`, base);
  const listing = await run(["worktree", "list", "--porcelain"], projectDir, 30_000);
  if (!listing.ok) return refusal("worktree", `git could not list the worktrees of ${project.name || projectDir} — ${lastLine(listing.err)}`, base);
  const entry = parseWorktreeListing(listing.out).find((w) => pathKey(w.path) === pathKey(tree));
  if (!entry) return refusal("worktree", `${tree} is not a worktree of ${project.name || projectDir} (git does not list it)`, base);
  const branch = request.branch || entry.branch || null;
  base.branch = branch;
  if (!branch) return refusal("branch", `${tree} has a detached HEAD, so there is no branch to delete`, base);
  if (project.mainBranch && branch === project.mainBranch) {
    return refusal("branch", `${branch} is the project's main branch`, base);
  }

  // 4. clean -----------------------------------------------------------------------------------------------------
  const status = await run(["status", "--porcelain"], tree, 60_000);
  if (!status.ok) return refusal("clean", `git status failed in ${tree} — ${lastLine(status.err)}`, base);
  const changed = String(status.out || "").split(/\r?\n/).filter((l) => l.trim()).length;
  if (changed) return refusal("clean", `the tree is not clean (${changed} changed path${changed === 1 ? "" : "s"})`, base);
  step("clean", true, "git status --porcelain is empty");

  // 5. the PR reads MERGED ----------------------------------------------------------------------------------------
  // The board's row already carries the PR (lib/scheduler.js decorates it on a full pass), so that is the number to
  // use when there is one. A request can still arrive for a tree no scan has decorated yet, and it must not die for
  // that: `gh pr list --head <branch>` is the panel's own second answer, matched by the same rules the PR cell uses
  // (lib/project.js `prFor`), so the PR column and this gate can never disagree about which PR a branch has.
  let prNumber = Number(row?.pr?.number || request.pr || 0) || null;
  if (!prNumber) {
    const listed = await runGh(
      ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,mergedAt,headRefName,headRefOid,title", "--limit", "50"],
      projectDir,
      60_000,
    );
    if (listed.ok) {
      try {
        prNumber = Number(prFor(buildPrIndex(JSON.parse(listed.out || "[]")), branch, { base: project.mainBranch })?.number) || null;
      } catch {
        prNumber = null; // an unreadable list is the same as no PR: the refusal below names it
      }
    }
  }
  if (!prNumber) return refusal("pr", `no pull request is recorded for ${branch}, so nothing shows this branch landed`, base);
  const view = await runGh(["pr", "view", String(prNumber), "--json", "state,mergeCommit"], projectDir, 60_000);
  if (!view.ok) return refusal("pr", `gh could not read PR #${prNumber} — ${lastLine(view.err)}`, base);
  let viewJson = null;
  try {
    viewJson = JSON.parse(view.out || "{}");
  } catch {
    viewJson = null;
  }
  if (!viewJson) return refusal("pr", `gh returned nothing readable for PR #${prNumber}`, base);
  const state = String(viewJson.state || "").toUpperCase();
  if (state !== "MERGED") return refusal("pr", `PR #${prNumber} reads ${state || "NO STATE"}, not MERGED`, base);
  const mergeCommit = String(viewJson.mergeCommit?.oid || viewJson.mergeCommit || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(mergeCommit)) return refusal("pr", `PR #${prNumber} reads MERGED but has no merge commit`, base);
  step("pr", true, `PR #${prNumber} is MERGED (merge commit ${mergeCommit.slice(0, 8)})`);
  base.pr = prNumber;
  base.mergeCommit = mergeCommit;

  // 6. nothing on this tree that the merge commit does not already contain ----------------------------------------
  // The object has to be HERE before any diff can be asked about it: `gh` reads the PR from GitHub, so a squash or
  // rebase merge lands a commit this clone may not have fetched yet. One fetch of the base branch, then the gate.
  let have = await run(["cat-file", "-e", `${mergeCommit}^{commit}`], projectDir, 20_000);
  if (!have.ok) {
    const remote = project.remote || "origin";
    const main = project.mainBranch || "main";
    const fetched = await run(["fetch", "--quiet", "--no-tags", remote, main], projectDir, 60_000);
    log(`release ${tree}: the merge commit ${mergeCommit.slice(0, 8)} was not local — git fetch ${remote} ${main} ${fetched.ok ? "ok" : `failed (${lastLine(fetched.err)})`}`);
    have = await run(["cat-file", "-e", `${mergeCommit}^{commit}`], projectDir, 20_000);
  }
  if (!have.ok) {
    return refusal("tree", `the merge commit ${mergeCommit.slice(0, 8)} is not in this checkout and could not be fetched`, base);
  }
  // What `git diff --merge-base <mergeCommit>..HEAD` asks for, in the form git accepts (a range is refused outright by
  // this git: "--merge-base does not work with ranges"). Empty means HEAD brings nothing the merge does not have: the
  // merge commit (or a fast-forward) contains HEAD, which is the `--merge`/ff landing.
  const carry = await run(["diff", "--merge-base", mergeCommit, "HEAD"], tree, 60_000);
  if (!carry.ok && !/unknown revision|bad revision|not a valid object/i.test(String(carry.err || ""))) {
    return refusal("tree", `git could not compare the tree with ${mergeCommit.slice(0, 8)} — ${lastLine(carry.err)}`, base);
  }
  let landed = carry.ok && !String(carry.out || "").trim();
  let landedHow = landed ? "HEAD brings nothing the merge commit does not have" : "";
  // The squash/rebase shape: the content landed, the SHAs were rewritten, and main may have moved on since the fork,
  // so neither ancestry nor a whole-tree comparison can answer. What can: every path THIS branch touched already
  // carries the branch's content in the merge commit. Paths the branch never touched are not its business (main's own
  // work there would otherwise read as work missing from the tree, which is exactly the false refusal to avoid).
  if (!landed) {
    const fork = await run(["merge-base", mergeCommit, "HEAD"], tree, 20_000);
    const touched = fork.ok ? await run(["diff", "--name-only", String(fork.out || "").trim(), "HEAD"], tree, 60_000) : { ok: false, out: "" };
    const paths = touched.ok ? String(touched.out || "").split(/\r?\n/).map((p) => p.trim()).filter(Boolean) : [];
    if (paths.length) {
      const same = await run(["diff", mergeCommit, "HEAD", "--", ...paths], tree, 60_000);
      if (same.ok && !String(same.out || "").trim()) {
        landed = true;
        landedHow = `every path this branch touched (${paths.length}) already carries its content in the merge commit`;
      } else if (same.ok) {
        const differ = String(same.out || "").split(/\r?\n/).filter((l) => l.trim()).length;
        return refusal("tree", `the tree carries work PR #${prNumber} did not land (${paths.length} path${paths.length === 1 ? "" : "s"} of its own, ${differ} line${differ === 1 ? "" : "s"} still differing from the merge commit)`, base);
      }
    }
    if (!landed) return refusal("tree", `the tree is not level with the merge commit ${mergeCommit.slice(0, 8)} and none of its own paths match it`, base);
  }
  step("tree", true, landedHow);

  // 7. nothing is still standing in it ---------------------------------------------------------------------------
  const busy = jobHoldingTree(jobs?.list?.() || jobs || [], tree);
  if (busy) return refusal("jobs", `an agent is still holding that worktree (${busy.id || "a run"}, ${busy.status})`, base);
  step("jobs", true, "no running or queued job has that tree");

  // ---- the removal, in the one order that leaves the fewest half-removed things ---------------------------------
  // 8. the worktree. Not `--force`: the clean gate already passed, so a refusal here is a real refusal (a submodule,
  // a locked tree, a repository git will not let go of) and it must be reported, not overridden.
  const removed = await run(["worktree", "remove", tree], projectDir, 120_000);
  let stillListed = null;
  const after = await run(["worktree", "list", "--porcelain"], projectDir, 30_000);
  if (after.ok) stillListed = parseWorktreeListing(after.out).some((w) => pathKey(w.path) === pathKey(tree));
  if (stillListed) {
    step("worktree", false, `git still lists it — ${lastLine(removed.err)}`);
    return { ...refusal("worktree", `git could not remove the worktree — ${lastLine(removed.err) || "it is still listed"}`, base), steps };
  }
  // A held directory makes git fail on its LAST step (the rmdir) after the files and the record are already gone:
  // `failed to delete '…': Permission denied` with nothing left but an empty shell. That is not a failed removal, and
  // the shell is handled by the plain rmdir below.
  step("worktree", true, removed.ok ? "git dropped the worktree" : `git reported ${lastLine(removed.err) || "an error"}, and its record is gone`);

  // 9. the local branch. `-D` is right ONLY because the PR read MERGED and the tree-equal gate passed: the content
  // is in what landed, so the label is all that is being thrown away.
  const del = await run(["branch", "-D", branch], projectDir, 30_000);
  if (!del.ok) {
    const why = lastLine(del.err);
    if (/not found|no such branch|unknown revision/i.test(why)) step("branch", true, `${branch} was already gone`);
    else {
      step("branch", false, why);
      return { ...refusal("branch", `the local branch ${branch} could not be deleted — ${why}`, base), steps };
    }
  } else {
    step("branch", true, `deleted ${branch} (was ${String(del.out || "").trim().split(/\s+/)[1] || "?"})`);
  }

  // 10. the remote branch. Same reason, and a branch that is not on the remote is already in the state this wants.
  let remoteDetail = "";
  const remoteName = project.remote || "origin";
  const push = await run(["push", remoteName, "--delete", branch], projectDir, 120_000);
  if (!push.ok) {
    const why = lastLine(push.err);
    if (/remote ref does not exist|unable to delete|does not exist/i.test(why)) remoteDetail = `${branch} was not on ${remoteName}`;
    else {
      step("remote", false, why);
      return { ...refusal("remote", `the branch ${branch} could not be deleted from ${remoteName} — ${why}`, base), steps };
    }
  } else {
    remoteDetail = `deleted ${branch} on ${remoteName}`;
  }
  step("remote", true, remoteDetail);

  // 11. a plain rmdir for an empty shell. NOT recursive, NOT `rmdir /s /q`, NOT `Remove-Item -Recurse -Force`: this
  // cannot delete a file, so a shell that still holds anything is reported instead of emptied.
  let dirLeft = false;
  let shellDetail = "no folder was left behind";
  if (existsSync(tree)) {
    try {
      await rmdirP(tree);
      shellDetail = "removed the empty folder git's rmdir could not take";
    } catch (e) {
      if (e?.code === "ENOENT") shellDetail = "no folder was left behind";
      else {
        dirLeft = true;
        shellDetail = String(e?.code === "ENOTEMPTY" ? "the folder still holds files" : e?.message || e);
      }
    }
  }
  step("shell", !dirLeft, shellDetail);
  if (dirLeft) return { ...refusal("shell", `the worktree is gone but its folder still holds files (${shellDetail})`, base), steps };

  log(`release ${tree}: removed (worktree, ${branch} locally and on ${remoteName})`);
  return {
    ok: true,
    outcome: RELEASE_OUTCOME_REMOVED,
    gate: null,
    detail: `worktree removed · ${branch} deleted locally and on ${remoteName}`,
    steps,
    path: tree,
    branch,
    pr: prNumber,
    mergeCommit,
  };
}
