// Main-thread project-level git helpers (few calls per project, unlike the
// per-worktree scans which go through the worker pool).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { gitIn } from "./scan.js";
import { tagOf } from "./tree-names.js";
import { linkFor, prListing, docOf } from "./hosts.js";

const pexec = promisify(execFile);

// A caller may hand over the Hosts object (server.js does) or a plain loaded document (a test does); docOf (lib/hosts.js)
// is the one helper for that, so neither has to know about the other.

export async function worktreeList(projectPath) {
  const r = await gitIn(projectPath, ["worktree", "list", "--porcelain"], 25000);
  if (!r.ok) throw new Error(`git worktree list failed in ${projectPath}: ${r.err || r.out}`);
  const out = [];
  let cur = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length).trim() };
      out.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return out;
}

// Where a path sits relative to the project, in the spelling every comparison here uses: resolved, backslashes
// to forward slashes, case folded, no trailing separator. Windows prints `C:\…`, the store keeps `C:/…`, and a
// project may be configured with either, so the raw strings must never be compared. Symlinks are NOT resolved:
// git's own worktree list reports the path it registered, and that is the path the row is keyed on.
const pathKey = (p) => {
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  return path.resolve(raw).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
};

// Is `p` the project's own root, or inside it? Equality counts: the primary checkout IS the project, and its row
// is the one that carries `ON MAIN`.
//
// This is the board's membership test, and it is deliberately about the FOLDER, not about the repository. A
// `git worktree list` answer is per REPOSITORY and names every tree of it wherever it sits on disk — a lander's
// comparison trees under `%LOCALAPPDATA%/hermes/cache/scratch/land-check/` are worktrees of this repo just as
// much as `.worktrees/…` is, and boarding them drew nine basenames with no tag, detached HEADs and duplicated
// `land/*` branches as if they were this project's work. A tree the panel did not cut and cannot name is not a
// row: the panel's own tree lives at `<project>/.worktrees/<slug>-<tag>` (renameWorktree), and the trees a
// reader cuts by hand live inside the checkout too. A sibling prefix must not match — `agent-worktree-gui-old`
// is a different project, not a subdirectory of this one.
export function isInsideProject(projectPath, p) {
  const root = pathKey(projectPath);
  const dir = pathKey(p);
  if (!root || !dir) return false;
  return dir === root || dir.startsWith(`${root}/`);
}

// Split a `git worktree list` answer into the trees this project owns and the ones git only mentions because
// they share a repository with it. Exported pure so the split is proved without a repository (test/
// worktree-board.test.js) — the caller supplies whatever the listing said.
export function projectWorktrees(projectPath, entries = []) {
  const kept = [];
  const outside = [];
  for (const entry of entries || []) {
    if (!entry || !entry.path) continue;
    (isInsideProject(projectPath, entry.path) ? kept : outside).push(entry);
  }
  return { kept, outside };
}

export async function projectMeta(project) {
  // A project without a remote is compared against its own main branch, so the panel still
  // says something useful instead of erroring on a missing <remote>/<branch> ref.
  const remoteRef = project.remote ? `${project.remote}/${project.mainBranch}` : project.mainBranch;
  if (!remoteRef) return { error: "no base ref: project has no remote and no main branch" };
  // A repo with no commits yet has nothing to resolve; report it as such, not as an error.
  if (project.empty) return { remoteRef, hasRemote: Boolean(project.remote), noCommits: true };
  const [tip, subj, date, lmain, lr] = await Promise.all([
    gitIn(project.path, ["rev-parse", "--short", remoteRef]),
    gitIn(project.path, ["log", "-1", "--format=%s", remoteRef]),
    gitIn(project.path, ["log", "-1", "--format=%cI", remoteRef]),
    gitIn(project.path, ["rev-parse", "--short", project.mainBranch]),
    gitIn(project.path, ["rev-list", "--left-right", "--count", `${remoteRef}...${project.mainBranch}`]),
  ]);
  const meta = { remoteRef, hasRemote: Boolean(project.remote) };
  if (!tip.ok) return { ...meta, error: `cannot resolve ${remoteRef}: ${tip.err || tip.out}` };
  meta.remoteTip = tip.out;
  meta.remoteTipSubject = subj.ok ? subj.out : null;
  meta.remoteTipDate = date.ok ? date.out : null;
  meta.localMain = lmain.ok ? lmain.out : null;
  if (lr.ok) {
    const [behind, ahead] = lr.out.split(/\s+/).map((n) => Number.parseInt(n, 10));
    meta.mainBehind = Number.isFinite(behind) ? behind : null;
    meta.mainAhead = Number.isFinite(ahead) ? ahead : null;
  }
  return meta;
}

const cache = new Map();
function memo(key, ttlMs, factory) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(factory);
  cache.set(key, { at: now, promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

export function remoteHeads(project, ttlSeconds) {
  if (!project.remote) return Promise.resolve(new Set());
  return memo(`heads:${project.path}:${project.remote}`, ttlSeconds * 1000, async () => {
    const r = await gitIn(project.path, ["ls-remote", "--heads", project.remote], 45000);
    const set = new Set();
    if (!r.ok) return set;
    for (const line of r.out.split("\n")) {
      const m = /refs\/heads\/(.+)$/.exec(line);
      if (m) set.add(m[1]);
    }
    return set;
  });
}

// The same question as `remoteHeads`, asked of the LOCAL repository instead of the network: which remote branches
// does the last fetch know about? One `for-each-ref` per project, memoised like the others, and it is what answers
// "the remote has this branch" when the remote itself could not be reached (a laptop offline, a key that needs a
// passphrase, a mirror that is down) — refs/remotes/<remote>/<branch> is the offline form of that answer.
// `null` when the read failed, so a caller can tell "nothing there" from "could not look".
export function remoteTrackedBranches(project, ttlSeconds) {
  if (!project.remote) return Promise.resolve(new Set());
  return memo(`refs:${project.path}:${project.remote}`, ttlSeconds * 1000, async () => {
    const r = await gitIn(project.path, ["for-each-ref", "--format=%(refname)", `refs/remotes/${project.remote}`], 25000);
    if (!r.ok) return null;
    const set = new Set();
    for (const line of r.out.split("\n")) {
      const m = /^refs\/remotes\/[^/]+\/(.+)$/.exec(line.trim());
      // `<remote>/HEAD` is the remote's default-branch symbolic ref, not a branch of its own.
      if (m && m[1] !== "HEAD") set.add(m[1]);
    }
    return set;
  });
}

// A branch's page on the remote's web UI, or null.
//
// The SHAPE of that URL is not decided here any more: it is the `links.branch` template of the project's host record
// (lib/hosts.js, the panel's hosts.json), so github and git.sefl.com — and a host nobody has seen yet — differ by data and
// not by a code path. `linkFor()` is the one place that turns a template plus coordinates into a URL, and it refuses
// to build one when the project has no host mapping or the host's record does not carry that link. A project whose
// mapping is missing therefore gets NO link and a sentence, rather than a guessed URL that would 404.
//
// The branch is encoded per path segment by the template renderer: `wtgui/foo-1a2b3c` is addressed as
// `tree/wtgui/foo-1a2b3c` (the shape GitHub documents), while a token inside a query string is encoded whole, which
// is what Bitbucket's `browse?at=refs%2Fheads%2F...` needs.
// One place that answers "does the remote have this branch, and where is its page": the row's own scan answer
// (`remoteBranch`, from `ls-remote` — per project and cached, never per row) with the local refs as the offline
// fallback. Every caller gets the same words, so the cell, the detail strip and any test cannot disagree.
export function branchLink({ project = {}, row = {}, offline = null, hosts = null } = {}) {
  const branch = String(row.branch || "").trim();
  const remote = project.remote || null;
  if (!branch || branch === "HEAD") return { url: null, why: "no branch was read for this worktree", onRemote: null };
  if (!remote) return { url: null, why: "no remote configured", onRemote: null };
  const seen = String(row.remoteBranch || "");
  const known = offline instanceof Set ? offline.has(branch) : typeof offline === "boolean" ? offline : null;
  let onRemote = null;
  let how = "";
  if (seen === "exists") {
    onRemote = true;
    how = `the remote ${remote} lists it`;
  } else if (seen === "gone") {
    onRemote = false;
    how = `the remote ${remote} does not list it`;
  } else if (known !== null) {
    // The remote itself could not be reached (or has not been read yet): the last fetch's refs are the offline
    // answer, and the title says which of the two it came from.
    onRemote = known;
    how = known
      ? `refs/remotes/${remote}/${branch} is here from the last fetch (the remote itself was not asked)`
      : `there is no refs/remotes/${remote}/${branch} either (the remote itself was not asked)`;
  }
  if (onRemote !== true) {
    // "local only" is a claim about the REMOTE, so it is only said when the remote itself answered (`gone`). The
    // stale-refs answer says what it is — the branch is not in the last fetch's refs and the remote was not asked —
    // because a branch pushed from another box after that fetch is exactly the branch the stronger sentence would
    // lie about, and the cell's tooltip is where a reader goes to find out how sure the panel is.
    const why =
      seen === "gone"
        ? `local only — this branch has no copy on the remote (${how})`
        : onRemote === false
          ? `not on the remote as of the last fetch — ${how}`
          : `cannot tell whether the remote has this branch yet (${seen === "unknown" ? "the remote could not be reached" : "the scan has not read it"})`;
    return { url: null, why, onRemote, remote };
  }
  const link = linkFor(docOf(hosts), project, "branch", { branch, sha: row.head, main: project.mainBranch });
  if (!link.url) {
    return { url: null, why: `${remote} has this branch, but its page cannot be built: ${link.why}`, onRemote: true, remote };
  }
  return { url: link.url, why: "", onRemote: true, remote, how };
}

// The PR index, keyed by the two names a row can be looked up by. A branch name is NOT stable in this panel:
// it renames a finished worktree's BRANCH after the thread slug and keeps only the six-hex tag (lib/tree-names.js),
// so a PR opened under the old name is invisible to an exact-name lookup. Measured on this repo: a branch the panel
// renamed mid-run read "no PR" on the board while its PR was MERGED, and the same blindness made
// `tools/merged-branches.mjs` print "nothing shows it landed" for it.
// The index a list of PRs makes. Its own function because the GROUPING is what decides which lookups can find
// anything at all, and that part deserves to be exercised without shelling out to `gh`.
export function buildPrIndex(prs = []) {
  const byRef = new Map();
  const byTag = new Map();
  for (const pr of prs) {
    if (!pr || !pr.headRefName) continue;
    const arr = byRef.get(pr.headRefName) || [];
    arr.push(pr);
    byRef.set(pr.headRefName, arr);
    // The tag is the tree's identity across a rename, but only that: see prFor for why a tag alone is never
    // enough to hand a row someone's PR.
    const tag = tagOf(pr.headRefName);
    if (tag) {
      const t = byTag.get(tag) || [];
      t.push(pr);
      byTag.set(tag, t);
    }
  }
  return { byRef, byTag };
}

// The PRs a project's host can list, in the one shape the board reads. Two transports, both named by the host record
// (`api.transport`) rather than chosen by a branch in the code: `gh` for a GitHub checkout with the CLI installed
// (which is what this box uses — `--state all` comes back in one call), and `rest` for a JSON API reached with a
// bearer token from `api.tokenEnv` (Bitbucket Server's `/pull-requests?state=ALL`, paged on `nextPageStart`).
//
// A record may name both `listOpenPrs` (the endpoint the reader is handed) and `listPullRequests` (all states, which
// is what the board needs — an OPEN-only list reads a merged branch as "none" forever). The all-states one is used
// when it exists; lib/hosts.js decides that, not this function.
function normalisePr(v, kind) {
  if (kind === "bitbucket-server") {
    return {
      number: v.id,
      state: v.state || null,
      mergedAt: v.state === "MERGED" ? v.closedDate || null : null,
      headRefName: v.fromRef?.displayId || null,
      headRefOid: v.fromRef?.latestCommit || null,
      title: v.title || null,
    };
  }
  // A github record that asked for `rest` rather than `gh`: same shape, different names.
  const state = String(v.state || "").toUpperCase() === "OPEN" ? "OPEN" : v.merged_at ? "MERGED" : "CLOSED";
  return { number: v.number, state, mergedAt: v.merged_at || null, headRefName: v.head?.ref || null, headRefOid: v.head?.sha || null, title: v.title || null };
}

async function fetchRestPrs(listing) {
  const token = listing.tokenEnv ? process.env[listing.tokenEnv] : null;
  if (!token) throw new Error(`no token in ${listing.tokenEnv || "(api.tokenEnv is not set)"}`);
  const out = [];
  let url = listing.url;
  for (let page = 0; page < 5 && url; page += 1) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const body = await res.json();
    const values = Array.isArray(body) ? body : Array.isArray(body?.values) ? body.values : [];
    for (const v of values) out.push(normalisePr(v, listing.kind));
    url = body && body.isLastPage === false && body.nextPageStart != null ? `${listing.url}${listing.url.includes("?") ? "&" : "?"}start=${body.nextPageStart}` : null;
  }
  return out;
}

export function prIndex(project, ttlSeconds, hosts = null) {
  const listing = prListing(docOf(hosts), project);
  // No mapping, or a mapping whose coordinates cannot build the endpoint: no PRs are claimed, and the board reads
  // "none" exactly as it does for a `gh` that is missing. The cell's title carries the reason (mappingView).
  if (!listing.url) return Promise.resolve(buildPrIndex([]));
  const coords = listing.coordinates || {};
  return memo(`pr:${project.name}:${listing.id || ""}:${coords.owner || ""}/${coords.repo || ""}${coords.projectKey || ""}/${coords.repoSlug || ""}`, ttlSeconds * 1000, async () => {
    try {
      let prs = [];
      if (listing.transport === "gh") {
        if (!coords.owner || !coords.repo) throw new Error(`gh needs owner and repo coordinates, the host record supplies ${JSON.stringify(coords)}`);
        const { stdout } = await pexec(
          "gh",
          ["pr", "list", "--state", "all", "--json", "number,state,mergedAt,headRefName,headRefOid,title", "--limit", "400", "--repo", `${coords.owner}/${coords.repo}`],
          { cwd: project.path, timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        );
        prs = JSON.parse(stdout || "[]");
      } else {
        prs = await fetchRestPrs(listing);
      }
      return buildPrIndex(prs);
    } catch (e) {
      // Swallowed for the board (a PR column reading "none" is survivable), but never silently: a missing token, a
      // host that refuses the request and a `gh` that is logged out all look identical from the cell, and this line is
      // the only place that difference is written down.
      console.log(new Date().toISOString().slice(11, 19), `PR list for ${project.name} (${listing.id || "unmapped"}) failed: ${String((e && e.message) || e)}`);
    }
    return buildPrIndex([]);
  });
}

// Which local branch tracks which remote ref, in ONE git call for the whole project. A renamed local branch keeps
// its upstream, and the upstream names the ref the PR was opened from — the second place a PR can be found after
// the branch's own name. `ref` is that name with its remote prefix taken off, because a PR's headRefName never
// carries one.
export async function branchUpstreams(project) {
  const map = new Map();
  const r = await gitIn(project.path, ["for-each-ref", "--format=%(refname:short)\t%(upstream:remotename)\t%(upstream:short)", "refs/heads"], 25000);
  if (!r.ok) return map;
  for (const line of r.out.split("\n")) {
    const [branch, remoteName, upstream] = String(line).split("\t");
    if (!branch || !upstream) continue;
    map.set(branch, {
      upstream,
      ref: remoteName && upstream.startsWith(`${remoteName}/`) ? upstream.slice(remoteName.length + 1) : upstream,
    });
  }
  return map;
}

// The PR that owns a row's branch, or null. Three names are tried, cheapest-to-be-wrong first: the branch as it is
// now, the remote ref its upstream names, and the six-hex tag — the one part of the name the panel's own rename
// keeps.
//
// THE TAG IS NOT AN IDENTITY FOR THE WORK, ONLY FOR THE TREE, so a tag match is allowed only while the tree still
// carries that PR's own commit (`tip` is the branch tip the scan just read; a PR's `headRefOid` is the commit its
// head ref was left on). Without that check an agent that changes branch INSIDE one worktree — a follow-up cut off
// main in the same tree, which the panel's own rename cannot tell apart from a rename — would have the tree's old,
// already-merged PR attributed to a branch that has not landed at all. With it, the switch reads as what it is: no
// PR for that branch, rather than somebody else's. A tip the scan did not read is not a licence to guess, and a PR
// whose head ref left the branch (more commits on top after the merge) is not attributed either.
//
// The newest PR wins when one tree appeared in more than one (a land, then a re-land): the row is about where the
// tree stands now, and the older PR is history.
export function prFor(index, branch, { upstream = null, tip = null, base = null } = {}) {
  // Tolerate the older index shape (a bare Map of headRefName -> PRs): a caller mid-upgrade must not crash.
  const byRef = index instanceof Map ? index : index?.byRef || new Map();
  const byTag = index instanceof Map ? new Map() : index?.byTag || new Map();
  const newest = (list) => (list && list.length ? list.slice().sort((a, b) => b.number - a.number)[0] : null);
  const brief = (pr, matched) => ({ number: pr.number, state: pr.state, mergedAt: pr.mergedAt || null, title: pr.title, matched });

  const names = [];
  if (branch) names.push({ name: String(branch), matched: "ref" });
  const baseName = String(base || "").trim();
  const addUpstream = (u) => {
    if (!u) return;
    // A PR's headRefName never carries a remote prefix, so an upstream handed over as one raw string (rather
    // than the {upstream, ref} pair branchUpstreams builds) is also tried with its first segment taken off.
    const bare = String(u).replace(/^[^/]+\//, "");
    // Tracking the BASE branch is not evidence of anything: `git worktree add` sets that up by itself, and a
    // PR's head ref can legitimately be named `main` (a fork's), so without this a brand-new branch that merely
    // tracks main is handed somebody else's PR. Measured: a fresh worktree of this repo, upstream `github/main`,
    // was given an OPEN fork PR whose head ref was `main`.
    if (baseName && (String(u) === baseName || bare === baseName)) return;
    if (!names.some((n) => n.name === String(u))) names.push({ name: String(u), matched: "upstream" });
    if (bare !== u && !names.some((n) => n.name === bare)) names.push({ name: bare, matched: "upstream" });
  };
  addUpstream(upstream?.ref);
  addUpstream(upstream?.upstream);
  if (typeof upstream === "string") addUpstream(upstream);

  for (const n of names) {
    const pr = newest(byRef.get(n.name));
    if (pr) return brief(pr, n.matched);
  }

  const head = String(tip || "").toLowerCase();
  if (head.length < 7) return null; // nothing was read to check the tag against: claim nothing
  for (const n of names) {
    const tag = tagOf(n.name);
    if (!tag) continue;
    const pr = newest((byTag.get(tag) || []).filter((p) => String(p.headRefOid || "").toLowerCase().startsWith(head)));
    if (pr) return brief(pr, "tag");
  }
  return null;
}
