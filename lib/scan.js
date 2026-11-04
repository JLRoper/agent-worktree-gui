// Per-worktree git inspection. Runs inside a worker thread (lib/scan-worker.js),
// so a slow or hung git call can never stall the HTTP event loop.
// Read-only: rev-parse / rev-list / merge-base / cherry / diff / status / log.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ownTree } from "./own-tree.js";

const pexec = promisify(execFile);

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
    const { stdout } = await pexec("git", ["-C", cwd, ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: GIT_ENV,
    });
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

// depth "fast": branch/head/ahead/behind/status/lastCommit/lastEdit (+ ancestor when ahead is 0)
// depth "full": everything above plus cherry patch-ids, verdict, commit list, diffstat
//
// The fast path is deliberately two git processes, not six: `status --porcelain=v2 --branch`
// carries the head sha, the branch, the upstream ahead/behind and every dirty/untracked path in
// one call, and `log -1` carries the commit date. Spawning git is the whole cost of a scan on
// Windows (each process is tens of milliseconds of kernel time), and the panel re-reads 110
// worktrees forever, so the count of processes is the thing that decides how many cores it burns.
export async function scanWorktree(wtPath, ctx, depth = "fast") {
  const { remoteRef, mainBranch, liveMinutes = 5 } = ctx;
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
  const own = await ownTree(wtPath);
  if (!own.ok) {
    const why = own.why || "its tree is gone";
    return {
      ...row,
      verdict: "RELEASED",
      baseRef: remoteRef || null,
      // The row's own record of WHY (`outer` is the checkout git answered for), and the same sentence as the row's
      // error so the routes that read one tree for a merge/replay/check refuse with it instead of with a count.
      released: { why, outer: own.outer || null, notRepo: Boolean(own.notRepo) },
      error: why,
    };
  }

  // Three independent git calls, spawned together: `status --porcelain=v2 --branch` carries the
  // head sha, the branch, the upstream ahead/behind and every dirty/untracked path; `log -1` the
  // commit date; `rev-list` the count against the project's base ref. Running them in parallel
  // keeps the latency of the old six-process scan while spawning half as many processes (git
  // spawns are the whole cost on Windows, and this loop never stops).
  const [st, log1, lr] = await Promise.all([
    gitIn(wtPath, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"]),
    gitIn(wtPath, ["log", "-1", "--format=%cI"]),
    remoteRef ? gitIn(wtPath, ["rev-list", "--left-right", "--count", `${remoteRef}...HEAD`]) : Promise.resolve({ ok: false, out: "" }),
  ]);
  if (!st.ok) return { ...row, error: "not a git worktree" };

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
  row.branch = branchName || null;
  row.head = unborn || !oid ? null : oid.slice(0, 7);
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

  // The commit date and the ahead/behind count were asked for above, alongside `status`.
  if (log1.ok) row.lastCommit = log1.out || null;

  // ahead/behind against the project's base ref (`status` only knows the branch's own upstream,
  // which a hermes-created worktree does not have).
  if (lr.ok) {
    const [behind, ahead] = lr.out.split(/\s+/).map((n) => Number.parseInt(n, 10));
    row.behind = Number.isFinite(behind) ? behind : null;
    row.ahead = Number.isFinite(ahead) ? ahead : null;
  } else if (abAhead !== null && upstream && upstream === remoteRef) {
    // Only the base ref's own count is meaningful; `status` reports the branch's upstream, which
    // is a different comparison and would invent an ahead/behind that has nothing to do with main.
    row.ahead = abAhead;
    row.behind = abBehind;
  }

  // A base ref that does not exist here (a stale/renamed remote branch) means we cannot say
  // anything about merging — say that instead of inventing an UNMERGED verdict.
  const baseMissing = Boolean(remoteRef) && !unborn && !lr.ok && row.ahead === null;
  row.baseRef = remoteRef || null;

  if (unborn) {
    // Repo with no commits yet: there is no merge state to judge.
    row.verdict = "EMPTY REPO";
    row.reflogEntries = 0;
    row.everMoved = false;
    row.ahead = 0;
    row.behind = 0;
  } else if (!remoteRef) {
    row.verdict = "NO BASE REF";
    row.reflogEntries = 0;
    row.everMoved = false;
  } else if (baseMissing) {
    row.verdict = "NO BASE REF";
    row.reflogEntries = 0;
    row.everMoved = false;
  } else if (depth === "full") {
    const [anc, cherry, reflog] = await Promise.all([
      gitIn(wtPath, ["merge-base", "--is-ancestor", "HEAD", remoteRef]),
      gitIn(wtPath, ["cherry", remoteRef, "HEAD"]),
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
    // count would also count the main commits it merged in, which is not its work.
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
      // Nothing of ours is off main — which is NOT the same as "this was merged": a branch that never
      // committed anything looks identical from here, and so does one that was only fast-forwarded or
      // reset onto main. Only a `commit:` line in the branch's own reflog proves it ever held work, so
      // the verdict is built on that, not on the reflog having moved.
      if (row.branch === mainBranch) {
        row.verdict = "ON MAIN";
      } else if (row.ownCommits > 0) {
        row.mergedCount = row.ownCommits;
        row.verdict = `MERGED (${row.ownCommits} commit${row.ownCommits === 1 ? "" : "s"})`;
      } else if (reflog.ok) {
        row.verdict = "NO COMMITS";
      } else {
        row.verdict = "NO COMMITS?"; // reflog expired/unreadable: cannot tell, so do not claim
      }
    } else if (row.cherryPlus === 0 && row.cherryMinus > 0) {
      // Every patch this branch carries is already in main — but that is evidence about the commits it
      // POINTS AT, not about work it did. A branch cut from another branch inherits those commits and
      // has none of its own, so it is not MERGED either; it simply has nothing to land.
      row.verdict = neverCommitted
        ? "NO COMMITS"
        : `MERGED (squash/rebase, ${row.ahead} commit${row.ahead === 1 ? "" : "s"})`;
    } else {
      // Compare the two TREES, not the branch's own diff: `remoteRef...HEAD` is the merge base to HEAD,
      // which still shows a squash-merged branch's changes — exactly the case this verdict was written
      // for. Two dots answer the question it asks: does this branch's tree already match main's?
      const d = await gitIn(wtPath, ["diff", "--stat", remoteRef, "HEAD"]);
      if (d.ok && d.out === "") {
        // A tree that matches main proves there is nothing to LAND, not that this branch landed it.
        // A squash-merged branch made commits of its own; a branch that was only re-pointed at main,
        // or cut from another branch, never made any, and calling that MERGED invents a merge.
        row.verdict = neverCommitted ? "NO COMMITS" : "MERGED (content identical)";
      } else {
        row.verdict = `UNMERGED (${row.ahead ?? "?"} commit${row.ahead === 1 ? "" : "s"})`;
        const [list, shortstat] = await Promise.all([
          gitIn(wtPath, ["log", "--oneline", "-20", `${remoteRef}..HEAD`]),
          gitIn(wtPath, ["diff", "--shortstat", `${remoteRef}...HEAD`]),
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
    // Cheap pass knows only that nothing of ours is off main. Claiming MERGED here was the
    // bug: only the full scan's reflog check can say whether anything was merged. Claim
    // nothing — the store keeps the last full verdict, or marks the row stale for a full scan.
    row.isAncestor = true;
    if (row.branch === mainBranch) row.verdict = "ON MAIN";
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
    parent: row.parent,
    parentSha: row.parentSha,
    verdict: row.verdict,
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
