// Per-worktree git inspection. Runs inside a worker thread (lib/scan-worker.js),
// so a slow or hung git call can never stall the HTTP event loop.
// Read-only: rev-parse / rev-list / merge-base / cherry / diff / status / log.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ownTree, treeOnDisk } from "./own-tree.js";
import { onBaseVerdict, rowBaseCandidates } from "./base-branches.js";

const pexec = promisify(execFile);

// The registry this thread's git calls report to. scan.js runs in a worker thread (lib/scan-worker.js) AND
// in the main thread (server.js imports scanWorktree for its own reads), so the caller names the registry
// once per thread: a worker points it at its own ChildTree, whose onTrack posts the pid up to the panel that
// owns the kill list; server.js points it at panelChildren. Unset means "no supervision", which is only
// honest for a one-off script that exits with its children.
let children = null;
let childrenScope = "scan";
export function setChildTracker(tree, scope = "scan") {
  children = tree || null;
  childrenScope = String(scope || "scan");
  return children;
}

// Git must never sit waiting for a human. A repo whose remote wants credentials (or whose SSH key is
// passphrase-locked) would otherwise hold the call until the timeout — 180 s of one fetch used to be
// enough to make the whole panel feel hung, because the fetch pass walks every project in turn.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0", // fail instead of prompting for a username/password
  GCM_INTERACTIVE: "never", // no Git Credential Manager dialog
  GIT_ASKPASS: "echo", // anything that answers without a UI
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=8",
};

export async function gitIn(cwd, args, timeout = 20000) {
  try {
    // Through the registry when this thread has one: the call's own timeout becomes a CEILING for its kind,
    // and the deadline kills the process TREE — which is what stops a scan's git from surviving the scan.
    const opts = { timeout, kind: "git", maxBuffer: 32 * 1024 * 1024, env: GIT_ENV };
    const { stdout } = children
      ? await children.exec(childrenScope, "git", ["-C", cwd, ...args], opts)
      : await pexec("git", ["-C", cwd, ...args], { ...opts, windowsHide: true });
    return { ok: true, out: stdout.replace(/\r\n/g, "\n").trim() };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout || "").replace(/\r\n/g, "\n").trim(),
      err: String(e.stderr || e.message || "").trim(),
    };
  }
}

function unquote(p) {
  if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return p;
}

// The parent record for one worktree: path first (a tree keeps its identity when its branch is renamed), branch
// second (a tree can be re-cut somewhere else and keep its branch). Nothing found is "unknown", never a guess.
function parentFor(parents, wtPath, branch) {
  const list = Array.isArray(parents) ? parents : [];
  if (!list.length) return null;
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const want = norm(wtPath);
  return list.find((p) => p && p.path && norm(p.path) === want) || (branch ? list.find((p) => p && p.branch === branch) : null) || null;
}

// ---- the scan cache: one process per unchanged row, not three ------------------------------------
// `status` carries the head sha, and the other two reads are functions of it:
//
//   log -1 %cI        the commit date of THAT sha — immutable, so it never needs asking twice;
//   rev-list base...  the count against the row's base — unchanged while both tips stand. Its key is the ref name
//                     and the head sha, with a 30s TTL: the board already re-reads a row on a 30s cadence, so a
//                     count that is one cadence old is no staler than the row it decorates, and a fetch that moves
//                     the base is reflected on the next scan rather than for ever.
//
// The caches live in the module, so each scan worker has its own; the cap keeps a long-lived panel from growing one
// entry per commit it ever sees. `forgetScanCaches()` is for a test (and a caller that knows a base moved).
const COMMIT_DATE = new Map(); // full sha -> %cI
const AHEAD_BEHIND = new Map(); // `${ref}|${headSha}` -> { out, at }
const SCAN_CACHE_CAP = 4000;
const AHEAD_BEHIND_TTL_MS = 30_000;

function remember(map, key, value) {
  if (map.size >= SCAN_CACHE_CAP) map.delete(map.keys().next().value);
  map.set(key, value);
}

export function forgetScanCaches() {
  AHEAD_BEHIND.clear();
}

async function commitDateFor(wtPath, sha) {
  if (COMMIT_DATE.has(sha)) return { ok: true, out: COMMIT_DATE.get(sha) };
  const r = await gitIn(wtPath, ["log", "-1", "--format=%cI", sha]);
  if (r.ok) remember(COMMIT_DATE, sha, r.out);
  return r;
}

async function aheadBehindFor(wtPath, ref, headSha, now = Date.now()) {
  const key = `${ref}|${headSha}`;
  const hit = AHEAD_BEHIND.get(key);
  if (hit && now - hit.at < AHEAD_BEHIND_TTL_MS) return { ok: true, out: hit.out };
  const r = await gitIn(wtPath, ["rev-list", "--left-right", "--count", `${ref}...${headSha}`]);
  if (r.ok) remember(AHEAD_BEHIND, key, { out: r.out, at: now });
  return r;
}

// depth "fast": branch/head/ahead/behind/status/lastCommit/lastEdit (+ ancestor when ahead is 0)
// depth "full": everything above plus cherry patch-ids, verdict, commit list, diffstat
//
// The fast path is deliberately two git processes, not six: `status --porcelain=v2 --branch`
// carries the head sha, the branch, the upstream ahead/behind and every dirty/untracked path in
// one call, and `log -1` carries the commit date. Spawning git is the whole cost of a scan on
// Windows (each process is tens of milliseconds of kernel time), and the panel re-reads 110
// worktrees forever, so the count of processes is the thing that decides how many cores it burns.
export async function scanWorktree(wtPath, ctx, depth = "fast") {
  const { remoteRef, mainBranch, remote = null, bases = [], liveMinutes = 5 } = ctx;
  const row = {
    path: wtPath.replace(/\\/g, "/"),
    name: path.basename(wtPath) || wtPath,
    branch: null,
    head: null,
    ahead: null,
    behind: null,
    // The branch against its OWN upstream, as `status` reports it (see lib/sync-state.js): `ahead` / `behind` above are
    // the count against the project's main, a different question. Null when the branch has no upstream, and
    // `upstreamAhead` / `upstreamBehind` stay null when git has no count for it (the upstream ref is gone).
    upstream: null,
    upstreamAhead: null,
    upstreamBehind: null,
    isAncestor: null,
    dirty: 0,
    untracked: 0,
    dirtyFiles: [],
    untrackedFiles: [],
    lastCommit: null,
    lastEdit: null,
    live: false,
    // Where this tree was cut from, and how sure that is (lib/parents.js). "unknown" is the default on purpose: a row
    // with no record says so, and both the UNMERGED chip and the steward treat a non-"cut" answer as a question for
    // the reader rather than as a place to write.
    parent: null,
    parentSha: null,
    parentSource: "unknown",
    // The base THIS ROW is measured against (lib/base-branches.js), which is not necessarily the project's single
    // base: fleet-kafka's dev tree is measured against origin/dev and its prod tree against origin/prod. `baseSource`
    // names how it was resolved, `baseEnv` the environment label that matched, and `baseMissing` says the row's own
    // base could not be resolved here - that row alone reads NO BASE REF, never the whole project.
    baseRef: null,
    baseBranch: null,
    baseEnv: null,
    baseSource: null,
    baseMissing: false,
    // Set (see below) when the path is not a tree of its own; carried on EVERY row, null included, because the store
    // merges a scan over the row it held — a released row's `released` must not outlive the folder being re-cut.
    released: null,
    error: null,
  };

  // A worktree PATH is not necessarily a worktree any more, and `git -C` cannot tell you that: on a leftover
  // directory (a `git worktree remove` that kept the folder, a scratch sweep that emptied it) it does not fail — it
  // walks UP to the project's own checkout and answers for THAT: its branch, its HEAD, the reader's own dirty files.
  // That is how nine released trees each reported "2 modified · 4 untracked — branch main" while measuring zero
  // worktree registrations and no .git of their own. So the tree question is asked FIRST, before any `git -C
  // status/log` on this path (lib/own-tree.js): a path that is not its own tree is reported RELEASED with no counts
  // at all and the reason, and no process ever answers for somebody else's checkout. A real tree — dirty or clean —
  // is unaffected: its own git answers, as before.
  // The expensive half of that question is a `rev-parse` spawn per row. A directory that still holds a `.git` entry
  // (a linked tree's file, the primary checkout's dir) is its own tree for every case this guard exists for: git
  // cannot walk UP out of a directory that has one. `treeOnDisk` is that fact without a process (own-tree.js), and
  // `ownTree` stays the authority for a directory that has none - the leftover an eviction leaves - and for a `.git`
  // whose registration was pruned while the file stayed: the status call below fails on that one, and the failure
  // path asks the authority then.
  const releasedRow = (own) => {
    const why = own.why || "its tree is gone";
    return {
      ...row,
      verdict: "RELEASED",
      baseRef: remoteRef || null,
      baseSource: remoteRef ? "default" : null,
      // The row's own record of WHY (`outer` is the checkout git answered for), and the same sentence as the row's
      // error so the routes that read one tree for a merge/replay/check refuse with it instead of with a count.
      released: { why, outer: own.outer || null, notRepo: Boolean(own.notRepo) },
      error: why,
    };
  };
  if (!treeOnDisk(wtPath).there) {
    const own = await ownTree(wtPath);
    if (!own.ok) return releasedRow(own);
  }

  // `status` first: it carries the head sha, and the other two reads are keyed by it (the scan cache above). The old
  // shape spawned all three together and paid three processes on every row; this pays one, plus whichever of the two
  // the cache does not already hold. The process count — not the wall clock — is what the panel's loop pays for.
  const st = await gitIn(wtPath, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"]);
  if (!st.ok) {
    // A `.git` whose registration is gone fails here instead of walking up. Ask the authority before this reads as a
    // plain error: a pruned tree is RELEASED (no work to count), not an UNMERGED row.
    const own = await ownTree(wtPath);
    if (!own.ok) return releasedRow(own);
    return { ...row, error: "not a git worktree" };
  }

  let branchName = "";
  let oid = "";
  let upstream = "";
  let abAhead = null;
  let abBehind = null;
  const dirtyFiles = [];
  const untrackedFiles = [];
  for (const line of st.out ? st.out.split("\n") : []) {
    if (line.startsWith("# branch.head ")) branchName = line.slice(14).trim();
    else if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim();
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (m) {
        abAhead = Number.parseInt(m[1], 10);
        abBehind = Number.parseInt(m[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      // v2 spells the unchanged side "." where v1 used a space, so normalise back to the v1 shape
      // the rest of the panel already understands ("M", "MM", "A", "D").
      const parts = line.split(" ");
      const xy = String(parts[1] || "").replace(/\./g, " ").trim() || "?";
      const at = line.startsWith("2 ") ? parts.slice(9).join(" ") : parts.slice(8).join(" ");
      const p = unquote(at.split("\t")[0].trim());
      if (p) dirtyFiles.push({ code: xy, path: p });
    } else if (line.startsWith("? ")) {
      const p = unquote(line.slice(2).trim());
      if (p) untrackedFiles.push(p);
    }
  }
  // An unborn HEAD (a repo with no commits yet) reports "(initial)" and has no branch shadow.
  const unborn = oid === "(initial)" || branchName === "(initial)";
  if (branchName === "(detached)") branchName = "HEAD";
  // The head sha is the cache key for both remaining reads: the commit date is immutable per sha, and the count is
  // unchanged while the base and the head both stand (lib/scan.js's cache, with a 30s TTL on the count).
  const headSha = unborn || !oid ? null : oid;
  const [log1, lr] = await Promise.all([
    headSha ? commitDateFor(wtPath, headSha) : Promise.resolve({ ok: false, out: "" }),
    headSha && remoteRef ? aheadBehindFor(wtPath, remoteRef, headSha) : Promise.resolve({ ok: false, out: "" }),
  ]);
  row.branch = branchName || null;
  row.head = headSha ? headSha.slice(0, 7) : null;
  row.upstream = upstream || null;
  row.upstreamAhead = abAhead;
  row.upstreamBehind = abBehind;
  // The parent comes from the panel's parent book, handed to the worker as plain data (`ctx.parents`), matched by
  // path first and branch second: a tree can be renamed, a branch usually cannot be.
  const parentHit = parentFor(ctx.parents, wtPath, row.branch);
  if (parentHit) {
    row.parent = parentHit.parent || null;
    row.parentSha = parentHit.parentSha || null;
    row.parentSource = parentHit.parentSource || "unknown";
  }
  row.dirtyFiles = dirtyFiles;
  row.untrackedFiles = untrackedFiles;
  row.dirty = dirtyFiles.length;
  row.untracked = untrackedFiles.length;

  // The commit date and the ahead/behind count were read above, after `status` gave the head sha they are keyed by.
  if (log1.ok) row.lastCommit = log1.out || null;

  // THE ROW'S OWN BASE. A project may have several long-lived base branches (fleet-kafka has dev, qa, uat and prod
  // and no main at all), so the ref this row is measured against is resolved per row: its recorded parent, then the
  // environment its branch or folder name carries, then the project's single base. lib/base-branches.js owns that
  // order; here each candidate is put to git in turn and the first ref this tree actually has wins. A row that runs
  // out of candidates reports NO BASE REF for itself, never for its project.
  const candidates = rowBaseCandidates({
    bases,
    parent: row.parent,
    branch: row.branch,
    treeName: row.name,
    remote,
    mainBranch,
    fallbackRef: remoteRef,
  });
  let resolved = null;
  let counts = null;
  for (const candidate of candidates) {
    // The single base's count is already in flight above (`lr`), which keeps the common scan at the number of git
    // processes it had before this per-row rule existed; a row measured against its own base costs one more spawn.
    const count =
      candidate.ref === remoteRef
        ? lr
        : headSha
          ? await aheadBehindFor(wtPath, candidate.ref, headSha)
          : { ok: false, out: "" };
    if (!count.ok) continue;
    const [behind, ahead] = count.out.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) continue;
    resolved = candidate;
    counts = { behind, ahead };
    break;
  }
  const chosen = resolved || candidates[0] || null;
  row.baseRef = chosen?.ref || null;
  row.baseBranch = chosen?.branch || null;
  row.baseEnv = chosen?.env || null;
  row.baseSource = resolved ? chosen.source : chosen ? "missing" : null;
  row.baseMissing = Boolean(chosen) && !resolved && !unborn;

  if (counts) {
    row.ahead = counts.ahead;
    row.behind = counts.behind;
  } else if (abAhead !== null && upstream && chosen && upstream === chosen.ref) {
    // `status` reports the branch's own upstream, which is a different comparison unless that upstream IS this
    // row's base - then its count is the one the verdict needs, without a rev-list that has just failed.
    row.ahead = abAhead;
    row.behind = abBehind;
  }

  if (unborn) {
    // Repo with no commits yet: there is no merge state to judge.
    row.verdict = "EMPTY REPO";
    row.reflogEntries = 0;
    row.everMoved = false;
    row.ahead = 0;
    row.behind = 0;
  } else if (!row.baseRef) {
    row.verdict = "NO BASE REF";
    row.reflogEntries = 0;
    row.everMoved = false;
  } else if (row.baseMissing) {
    row.verdict = "NO BASE REF";
    row.reflogEntries = 0;
    row.everMoved = false;
  } else if (depth === "full") {
    const [anc, cherry, reflog] = await Promise.all([
      gitIn(wtPath, ["merge-base", "--is-ancestor", "HEAD", row.baseRef]),
      gitIn(wtPath, ["cherry", row.baseRef, "HEAD"]),
      gitIn(wtPath, ["reflog", "show", "--format=%H %gs", row.branch || "HEAD"]),
    ]);
    row.isAncestor = anc.ok;
    row.cherryPlus = 0;
    row.cherryMinus = 0;
    if (cherry.ok) {
      const lines = cherry.out ? cherry.out.split("\n") : [];
      row.cherryPlus = lines.filter((l) => l.startsWith("+")).length;
      row.cherryMinus = lines.filter((l) => l.startsWith("-")).length;
    }

    // The branch reflog is the only record of what this branch ever pointed at, so it is
    // what separates "its commits landed in main" from "it never had any commits". A
    // freshly created worktree branch has exactly one entry ("branch: Created from ...").
    const reflogLines = reflog.ok ? reflog.out.split("\n").filter(Boolean) : [];
    const shas = [...new Set(reflogLines.map((l) => l.split(" ")[0]))];
    row.reflogEntries = shas.length;
    row.branchBase = reflogLines.length ? reflogLines[reflogLines.length - 1].split(" ")[0] : null;
    row.everMoved = shas.length > 1;
    // Commits this branch actually made, straight from its own reflog — a commit-range
    // count would also count the base's commits it merged in, which is not its work.
    const own = new Set();
    for (const l of reflogLines) {
      const sp = l.indexOf(" ");
      const subject = sp < 0 ? "" : l.slice(sp + 1);
      if (/^commit( \(amend\))?:/.test(subject)) own.add(l.slice(0, sp));
    }
    row.ownCommits = own.size;
    // A reflog with entries but not one `commit:` line is proof this branch never made a commit: it
    // only ever pointed at somebody else's work — a fast-forward, a reset, a re-cut. Such a branch has
    // nothing of its own to land, so no MERGED verdict may be built on it.
    const neverCommitted = reflog.ok && shas.length > 0 && row.ownCommits === 0;
    row.mergedCount = null;

    row.unmergedCommits = [];
    row.diffSummary = null;
    if (row.ahead === 0) {
      // Nothing of ours is off the row's base — which is NOT the same as "this was merged": a branch that never
      // committed anything looks identical from here, and so does one that was only fast-forwarded or reset onto
      // it. Only a `commit:` line in the branch's own reflog proves it ever held work, so the verdict is built on
      // that, not on the reflog having moved.
      const onBase = onBaseVerdict({ branch: row.branch, baseBranch: row.baseBranch, mainBranch });
      if (onBase) {
        row.verdict = onBase;
      } else if (row.ownCommits > 0) {
        row.mergedCount = row.ownCommits;
        row.verdict = `MERGED (${row.ownCommits} commit${row.ownCommits === 1 ? "" : "s"})`;
      } else if (reflog.ok) {
        row.verdict = "NO COMMITS";
      } else {
        row.verdict = "NO COMMITS?"; // reflog expired/unreadable: cannot tell, so do not claim
      }
    } else if (row.cherryPlus === 0 && row.cherryMinus > 0) {
      // Every patch this branch carries is already in the row's base — but that is evidence about the commits it
      // POINTS AT, not about work it did. A branch cut from another branch inherits those commits and
      // has none of its own, so it is not MERGED either; it simply has nothing to land.
      row.verdict = neverCommitted
        ? "NO COMMITS"
        : `MERGED (squash/rebase, ${row.ahead} commit${row.ahead === 1 ? "" : "s"})`;
    } else {
      // Compare the two TREES, not the branch's own diff: `<row base>...HEAD` is the merge base to HEAD,
      // which still shows a squash-merged branch's changes — exactly the case this verdict was written
      // for. Two dots answer the question it asks: does this branch's tree already match its base's?
      const d = await gitIn(wtPath, ["diff", "--stat", row.baseRef, "HEAD"]);
      if (d.ok && d.out === "") {
        // A tree that matches the base proves there is nothing to LAND, not that this branch landed it.
        // A squash-merged branch made commits of its own; a branch that was only re-pointed at its base,
        // or cut from another branch, never made any, and calling that MERGED invents a merge.
        row.verdict = neverCommitted ? "NO COMMITS" : "MERGED (content identical)";
      } else {
        row.verdict = `UNMERGED (${row.ahead ?? "?"} commit${row.ahead === 1 ? "" : "s"})`;
        const [list, shortstat] = await Promise.all([
          gitIn(wtPath, ["log", "--oneline", "-20", `${row.baseRef}..HEAD`]),
          gitIn(wtPath, ["diff", "--shortstat", `${row.baseRef}...HEAD`]),
        ]);
        if (list.ok) {
          row.unmergedCommits = list.out.split("\n").filter(Boolean).map((l) => {
            const sp = l.indexOf(" ");
            return sp < 0 ? { sha: l, subject: "" } : { sha: l.slice(0, sp), subject: l.slice(sp + 1) };
          });
        }
        if (shortstat.ok) row.diffSummary = shortstat.out || null;
      }
    }
    row.fullAhead = row.ahead;
    row.fullVerdict = row.verdict;
  } else if (row.ahead === 0) {
    // Cheap pass knows only that nothing of ours is off the row's base. Claiming MERGED here was the
    // bug: only the full scan's reflog check can say whether anything was merged. Claim
    // nothing — the store keeps the last full verdict, or marks the row stale for a full scan.
    row.isAncestor = true;
    const onBase = onBaseVerdict({ branch: row.branch, baseBranch: row.baseBranch, mainBranch });
    if (onBase) row.verdict = onBase;
  }

  // activity: newest of last commit and newest modified/untracked file mtime
  let newest = row.lastCommit ? Date.parse(row.lastCommit) : 0;
  const files = outsideNestedWorktrees(
    [...row.dirtyFiles.map((f) => f.path), ...row.untrackedFiles],
    wtPath,
    ctx.nested,
  ).slice(0, 40);
  const stamps = await Promise.all(
    files.map(async (f) => {
      try {
        return (await stat(path.join(wtPath, f))).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  for (const s of stamps) if (s > newest) newest = s;
  if (newest) row.lastEdit = new Date(newest).toISOString();
  row.live = Boolean(newest) && Date.now() - newest < liveMinutes * 60_000;

  // WHAT ITS OWN COMMITS CHANGE SINCE THE PARENT (lib/collisions.js). The detector compares two live rows by the work
  // they are touching, and a tree that has committed is touching those files as surely as one holding them dirty.
  // Three dots, so the range starts at the MERGE BASE: a branch that merged its parent in must not report the parent's
  // own commits as work of its own. Full scans only - a quick pass has no resolved base ref, and the row it merges over
  // is the one this full scan wrote, so the list is not lost between passes. One spawn, on a live row with commits.
  if (depth === "full") {
    row.commitFiles = [];
    row.commitSource = null;
    if (row.live && !unborn && row.ahead > 0) {
      const ref = row.parent || row.baseRef;
      let own = ref ? await gitIn(wtPath, ["diff", "--name-only", `${ref}...HEAD`]) : null;
      if ((!own || !own.ok) && row.baseRef && ref !== row.baseRef) {
        own = await gitIn(wtPath, ["diff", "--name-only", `${row.baseRef}...HEAD`]);
        if (own && own.ok) row.commitSource = row.baseRef;
      } else if (own && own.ok) {
        row.commitSource = ref;
      }
      if (own && own.ok) row.commitFiles = own.out.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 200);
    }
  }
  return row;
}

// A worktree nested inside another checkout appears in the parent's `git status` as ordinary untracked
// paths — `bug/incorrect-workspace-agent/src/x.js` inside the main tree, or anything under `.worktrees/`.
// An agent working in the nested tree is NOT the parent working, so those paths must not count as the
// parent's edit evidence (that was the main row flashing green while its agent worked one level down).
// `.worktrees/` is excluded whether or not it is a registered worktree yet.
export function outsideNestedWorktrees(files, wtPath, nested = []) {
  const norm = (p) => path.resolve(String(p)).replace(/\\/g, "/").toLowerCase();
  const self = norm(wtPath);
  // A file belongs to the INNERMOST worktree that contains it. Testing "is it inside any other worktree"
  // dropped every file of a worktree that lives inside the parent checkout (`bug/x`, `.worktrees/y`),
  // because those paths are also inside the project root - so such rows could never show file evidence.
  const roots = [...new Set([self, ...(nested || []).map(norm).filter(Boolean)])];
  return (files || []).filter((f) => {
    const rel = String(f || "").replace(/\\/g, "/");
    if (!rel) return false;
    const abs = norm(path.resolve(wtPath, rel));
    let owner = null;
    for (const root of roots) {
      if (abs !== root && !abs.startsWith(`${root}/`)) continue;
      if (!owner || root.length > owner.length) owner = root;
    }
    return !owner || owner === self;
  });
}

// Newest mtime among the given repo-relative paths. Used by the cheap liveness pass so the
// `files` evidence does not have to wait for a full git scan of a dormant worktree.
export async function newestEditMs(wtPath, files) {
  const list = (files || []).filter(Boolean).slice(0, 40);
  if (!list.length) return 0;
  const stamps = await Promise.all(
    list.map(async (f) => {
      try {
        return (await stat(path.join(wtPath, f))).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  return Math.max(0, ...stamps);
}

// A deterministic signature of a scanned row's core state. Used to tell whether the board changed
// without re-serialising the whole row (which carries timestamps and volatile fields).
export function rowSignature(row = {}) {
  const state = {
    path: row.path,
    branch: row.branch,
    head: row.head,
    ahead: row.ahead,
    behind: row.behind,
    dirty: row.dirty,
    untracked: row.untracked,
    dirtyFiles: (row.dirtyFiles || []).map((f) => `${f.code}:${f.path}`).sort(),
    untrackedFiles: (row.untrackedFiles || []).slice().sort(),
    // The files its own commits change since the parent: a collision whose evidence is a COMMIT moves the board too.
    commitFiles: (row.commitFiles || []).slice().sort(),
    parent: row.parent,
    parentSha: row.parentSha,
    verdict: row.verdict,
    baseRef: row.baseRef,
    baseSource: row.baseSource,
    baseMissing: row.baseMissing,
    released: row.released ? { why: row.released.why, outer: row.released.outer } : null,
    error: row.error,
  };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

// The board's signature: the sorted signatures of its rows. One row changing moves the whole board.
export function boardSignature(rows = []) {
  const sigs = (rows || []).map(rowSignature).sort();
  return createHash("sha256").update(sigs.join("\n")).digest("hex");
}
