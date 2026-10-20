// Per-worktree git inspection. Runs inside a worker thread (lib/scan-worker.js),
// so a slow or hung git call can never stall the HTTP event loop.
// Read-only: rev-parse / rev-list / merge-base / cherry / diff / status / log.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";

const pexec = promisify(execFile);

export async function gitIn(cwd, args, timeout = 25000) {
  try {
    const { stdout } = await pexec("git", ["-C", cwd, ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
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

// depth "fast": branch/head/ahead/behind/status/lastCommit/lastEdit (+ ancestor when ahead is 0)
// depth "full": everything above plus cherry patch-ids, verdict, commit list, diffstat
export async function scanWorktree(wtPath, ctx, depth = "fast") {
  const { remoteRef, mainBranch, liveMinutes = 5 } = ctx;
  const row = {
    path: wtPath.replace(/\\/g, "/"),
    name: path.basename(wtPath) || wtPath,
    branch: null,
    head: null,
    ahead: null,
    behind: null,
    isAncestor: null,
    dirty: 0,
    untracked: 0,
    dirtyFiles: [],
    untrackedFiles: [],
    lastCommit: null,
    lastEdit: null,
    live: false,
    error: null,
  };

  const br = await gitIn(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // An unborn HEAD (a repo with no commits yet) makes rev-parse fail, but it still has a
  // branch name via symbolic-ref — anything without one is genuinely not a worktree.
  let branchName = br.ok ? br.out : null;
  if (!br.ok) {
    const sym = await gitIn(wtPath, ["symbolic-ref", "--short", "HEAD"]);
    if (!sym.ok) return { ...row, error: "not a git worktree" };
    branchName = sym.out;
  }
  row.branch = branchName;

  const [head, lr, status, log1, base] = await Promise.all([
    gitIn(wtPath, ["rev-parse", "--short", "HEAD"]),
    // No base ref (a project with neither remote nor main branch) means nothing to compare.
    remoteRef ? gitIn(wtPath, ["rev-list", "--left-right", "--count", `${remoteRef}...HEAD`]) : Promise.resolve({ ok: false, out: "" }),
    // --no-optional-locks: a read-only scan must never rewrite the repo's index
    // (git status refreshes the stat cache otherwise, which also wrecked recency ordering).
    gitIn(wtPath, ["--no-optional-locks", "status", "--porcelain"]),
    gitIn(wtPath, ["log", "-1", "--format=%cI"]),
    remoteRef ? gitIn(wtPath, ["rev-parse", "--verify", "--quiet", remoteRef]) : Promise.resolve({ ok: false, out: "" }),
  ]);
  // An unborn HEAD is a repo with no commits at all: no history, no merge state.
  const unborn = !head.ok;
  // A base ref that does not exist here (a stale/renamed remote branch) means we cannot say
  // anything about merging — say that instead of inventing an UNMERGED verdict.
  const baseMissing = Boolean(remoteRef) && !base.ok;
  row.baseRef = remoteRef || null;
  if (head.ok) row.head = head.out;
  if (log1.ok) row.lastCommit = log1.out || null;
  if (lr.ok) {
    const [behind, ahead] = lr.out.split(/\s+/).map((n) => Number.parseInt(n, 10));
    row.behind = Number.isFinite(behind) ? behind : null;
    row.ahead = Number.isFinite(ahead) ? ahead : null;
  }
  if (status.ok) {
    const lines = status.out ? status.out.split("\n") : [];
    row.dirtyFiles = lines
      .filter((l) => !l.startsWith("??"))
      .map((l) => ({ code: l.slice(0, 2).trim() || "?", path: unquote(l.slice(2).trim()) }));
    row.untrackedFiles = lines.filter((l) => l.startsWith("??")).map((l) => unquote(l.slice(2).trim()));
    row.dirty = row.dirtyFiles.length;
    row.untracked = row.untrackedFiles.length;
  }

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
    row.mergedCount = null;

    row.unmergedCommits = [];
    row.diffSummary = null;
    if (row.ahead === 0) {
      // Nothing of ours is off main — which is NOT the same as "this was merged": a branch
      // that never committed anything looks identical from here.
      if (row.branch === mainBranch) {
        row.verdict = "ON MAIN";
      } else if (row.everMoved) {
        row.mergedCount = row.ownCommits || null;
        row.verdict = row.ownCommits
          ? `MERGED (${row.ownCommits} commit${row.ownCommits === 1 ? "" : "s"})`
          : "MERGED";
      } else if (reflog.ok) {
        row.verdict = "NO COMMITS";
      } else {
        row.verdict = "NO COMMITS?"; // reflog expired/unreadable: cannot tell, so do not claim
      }
    } else if (row.cherryPlus === 0 && row.cherryMinus > 0) {
      row.verdict = `MERGED (squash/rebase, ${row.ahead} commit${row.ahead === 1 ? "" : "s"})`;
    } else {
      const d = await gitIn(wtPath, ["diff", "--stat", `${remoteRef}...HEAD`]);
      if (d.ok && d.out === "") {
        row.verdict = "MERGED (content identical)";
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
  const files = [...row.dirtyFiles.map((f) => f.path), ...row.untrackedFiles].slice(0, 40);
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
