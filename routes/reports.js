// The reports a task left behind: the chip on a wave member row, its list, and the one file it opens.
//
//   GET /api/reports?thread=<task thread>&task=<id>&project=<name>
//       one task's .html reports, from the UNION of two sources:
//         (a) the deliverables store - every `file`/`image` row recorded for the task's THREAD (or for its run id),
//             whose target ends .html and still exists; and
//         (b) the task's own tree - the .html files under `docs/reports/` that this branch ADDED or changed, read from
//             `git diff <merge-base>...HEAD` plus `git status --porcelain` so the reports main already carried are not
//             claimed as this task's work.
//       Deduped by absolute path, newest first, capped.
//
//   GET /api/reports/view?thread=<thread>&task=<id>&path=<relative>
//       one of those files, served as text/html under a sandboxing CSP with no-store: a report can never call this
//       panel's own API from its origin. The path is resolved under the task's tree ONLY - an absolute path, a `..`
//       segment, a non-.html suffix or a symlink that leaves the root is refused with a sentence, never served.
//
// WHY A TASK'S THREAD IS THE KEY. A queue task id is per-assistant (assistant-2's #7 and assistant-3's #7 are two
// different rows), so a request that named only the id would have to guess which queue it meant. The thread is the
// task's own identity across the panel, and it is also what the deliverables store records at settle, which is what
// makes the two sources join at all. `task` still travels: it picks one row when a thread carried more than one.
//
// NEVER INVENT A REPORT. A deliverable whose file is gone, or whose file lives outside the task's tree, is NAMED with
// its reason and given no url - the list says what the panel knows and cannot open, rather than dropping it silently
// or handing out a link to a 404. A tree that is gone leaves the deliverables' own absolute paths as the only
// evidence, and the same relative path under the project checkout is tried when the branch's work has already
// merged - which is the one case where the file still exists but no longer under the tree.
//
// THE FILESYSTEM IS THE LINE, NOT THE GIT READ. The two git commands choose WHICH .html files this branch touched;
// every candidate is then stat'ed, and a file that is not on disk is never listed as if it were.
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The one path this prefix answers, and the view under it. */
export const REPORTS_PATH = "/api/reports";
export const REPORTS_VIEW_PATH = "/api/reports/view";

/** How many reports one task may answer with, after the dedupe and the newest-first sort. */
export const REPORTS_CAP = 50;
/** The directory a worker brief tells every agent to write its reports into, relative to the tree. */
export const REPORTS_DIR = "docs/reports";
/**
 * The sandbox a report is served under. `default-src 'none'` plus the two inline allowances is what a SELF-CONTAINED
 * report needs (its own <style> and <script>), `img-src data:` carries an inlined chart, and nothing here lets the
 * page reach back into the panel, its API or a cookie on this origin.
 */
export const REPORTS_CSP =
  "sandbox allow-scripts; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";
/** The suffix a report must carry. A route that served any file would be a file server wearing a chip. */
const REPORT_SUFFIX = /\.html?$/i;
/** How much of a file is read looking for its <title>, and how long a title may be. */
const TITLE_READ = 8192;
const TITLE_MAX = 160;

const slash = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
const oneLine = (s, n = TITLE_MAX) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Whether `file` sits strictly under `root`, judged on the resolved strings. */
function inside(root, file) {
  const a = path.resolve(String(root || ""));
  const b = path.resolve(String(file || ""));
  const rel = path.relative(a, b);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The relative path of `file` under `root`, or null when it is not under it. */
function relUnder(root, file) {
  if (!root || !file) return null;
  if (!inside(root, file)) return null;
  return path.relative(path.resolve(root), path.resolve(file)).replace(/\\/g, "/");
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The path guard, pure and exported: one place decides what a `path` query may name, so the route's 400 and the
 * listed row's `rel` cannot disagree about which strings are legal. `root` is the task's tree (or the project
 * checkout when the tree is gone); `rel` is what the reader's link carried.
 */
export function resolveReportPath(root, rel) {
  const raw = String(rel ?? "").trim();
  if (!raw) return { ok: false, status: 400, error: "a path is required: pass path=<the report's path under the task's tree>" };
  // Every absolute form is refused: a leading slash (POSIX and UNC both), and a drive letter with a colon after it,
  // forward-slash or backslash. None of them is a path "under the tree", and a route that resolved one would be a
  // file server.
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, status: 400, error: "an absolute path is refused: a report is read under the task's tree only" };
  }
  const norm = slash(raw);
  if (!norm) return { ok: false, status: 400, error: "a path is required: pass path=<the report's path under the task's tree>" };
  if (norm.split("/").some((seg) => seg === "..")) {
    return { ok: false, status: 400, error: "a path with `..` is refused: a report is read under the task's tree only" };
  }
  if (!REPORT_SUFFIX.test(norm)) return { ok: false, status: 400, error: "only .html reports are served" };
  if (!root) return { ok: false, status: 409, error: "this task names no tree on disk, so no report can be read from it" };
  const file = path.resolve(String(root), norm);
  if (!inside(root, file)) return { ok: false, status: 400, error: "that path is outside the task's tree" };
  return { ok: true, file, rel: norm };
}

/**
 * The file behind a listed row: the candidate first, then (for a deliverable whose tree has gone or merged) the same
 * relative path under any of the other roots the task has. A hit is checked on disk and, when it exists, through its
 * REAL path as well - a junction inside the tree that points out of it is an escape, not a report.
 */
function locate(candidate, roots) {
  const tries = [];
  if (candidate) tries.push(candidate);
  // The same relative path under another root: a deliverable written into a tree that has since been removed is found
  // in the project checkout once the branch's work merged, and the row still names the file the reader was handed.
  for (const base of roots) {
    const rel = relUnder(base, candidate);
    if (!rel) continue;
    for (const root of roots) tries.push(path.join(root, rel));
  }
  for (const file of tries) {
    if (!isFile(file)) continue;
    let real = file;
    try {
      real = realpathSync(file);
    } catch {
      continue;
    }
    const owner = roots.find((root) => inside(root, real));
    if (!owner) continue;
    return { file: real, root: owner, rel: relUnder(owner, real) || "" };
  }
  return null;
}

/** A title a reader can tell two reports apart by: the delivered one, else the file's own <title>, else its name. */
function titleOf(file, wanted) {
  if (wanted) return oneLine(wanted, TITLE_MAX);
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(TITLE_READ);
      const read = readSync(fd, buf, 0, TITLE_READ, 0);
      const head = buf.subarray(0, read).toString("utf8");
      const hit = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (hit) {
        const text = oneLine(
          hit[1]
            .replace(/<[^>]*>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'"),
        );
        if (text) return text;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* an unreadable head is not a reason to fail the list: the name below is still true */
  }
  const name = path.basename(file);
  return oneLine(name.replace(/\.html?$/i, "").replace(/[-_]+/g, " ").trim() || name);
}

function mtimeOf(file) {
  try {
    return Math.round(statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * One git read, bounded. Every git failure is a value, never a throw: a tree that is not a repo, or a git that is not
 * on PATH, must leave the route answering the deliverables half rather than a 500 with no list.
 */
async function git(cwd, args) {
  try {
    const { stdout } = await run("git", ["-C", cwd, "-c", "core.quotePath=false", ...args], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 4 << 20,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, out: String(stdout || "") };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** The merge base this branch is measured from: the row's own base branch first, then the usual names. */
async function baseOf(tree, hint) {
  const names = [String(hint || "").trim(), "origin/main", "main", "master", "origin/master"].filter(Boolean);
  for (const name of names) {
    const res = await git(tree, ["merge-base", "HEAD", name]);
    if (res.ok && res.out.trim()) return { ref: name, sha: res.out.trim() };
  }
  return null;
}

/** The .html paths a `git status --porcelain` line names, both sides of a rename kept when both are reports. */
function statusPaths(out) {
  const paths = [];
  for (const line of String(out || "").split(/\r?\n/)) {
    if (!line.trim() || line.length < 4) continue;
    const body = line.slice(3).trim();
    const arrow = body.indexOf(" -> ");
    const name = arrow >= 0 ? body.slice(arrow + 4) : body;
    paths.push(name.replace(/^"(.*)"$/, "$1"));
  }
  return paths;
}

/**
 * The tree half: the reports THIS branch added or changed under docs/reports, plus the untracked ones it still holds.
 * With no base branch to measure from, every .html in the directory is listed and `why` says so - a fallback that
 * states its own rule rather than pretending the read was the narrow one.
 */
async function treeReports(tree, hint) {
  const dir = path.join(tree, REPORTS_DIR);
  const out = { paths: [], why: null, base: null };
  if (!existsSync(dir)) {
    out.why = `the tree has no ${REPORTS_DIR} directory`;
    return out;
  }
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && REPORT_SUFFIX.test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch (err) {
    out.why = `${REPORTS_DIR} cannot be read: ${String((err && err.message) || err)}`;
    return out;
  }
  const base = await baseOf(tree, hint);
  const touched = new Set();
  if (base) {
    out.base = base.ref;
    const diff = await git(tree, ["diff", "--name-only", "--diff-filter=AM", `${base.sha}...HEAD`, "--", REPORTS_DIR]);
    if (diff.ok) {
      for (const line of diff.out.split(/\r?\n/)) {
        const name = line.trim();
        if (name) touched.add(slash(name));
      }
    }
    const status = await git(tree, ["status", "--porcelain", "--untracked-files=all", "--", REPORTS_DIR]);
    if (status.ok) for (const name of statusPaths(status.out)) touched.add(slash(name));
  } else {
    out.why = `no base branch could be read in this tree, so every .html in ${REPORTS_DIR} is listed`;
    for (const file of names) touched.add(`${REPORTS_DIR}/${path.basename(file)}`);
  }
  out.paths = names.filter((file) => touched.has(`${REPORTS_DIR}/${path.basename(file)}`));
  if (!out.paths.length && !out.why) out.why = `no .html report under ${REPORTS_DIR} was added or changed on this branch`;
  return out;
}

/**
 * The two sources, joined. Everything here is a READ: the route never writes the deliverables store, never touches
 * the tree and never moves a file - a chip press is a look.
 */
async function listReports({ task, tree, roots, deliverables, log }) {
  const thread = String(task?.thread || "").trim();
  const rows = [];
  const seen = new Set();
  const skipped = [];
  // (a) the deliverables store: the thread (and the run, when the store recorded a job id) is the join.
  let fromDeliverables = 0;
  if (deliverables && typeof deliverables.list === "function") {
    let listed = null;
    try {
      listed = deliverables.list();
    } catch (err) {
      skipped.push({ source: "deliverables", why: String((err && err.message) || err) });
    }
    for (const entry of Array.isArray(listed?.entries) ? listed.entries : []) {
      if (!entry || entry.kind === "link") continue;
      const sameThread = thread && String(entry.thread || "").trim() === thread;
      const sameRun = task?.runId && entry.jobId && String(entry.jobId) === String(task.runId);
      if (!sameThread && !sameRun) continue;
      if (!REPORT_SUFFIX.test(String(entry.target || ""))) continue;
      const hit = locate(String(entry.target), roots);
      if (hit && seen.has(hit.file)) continue;
      if (!hit) {
        rows.push({
          name: path.basename(String(entry.target)),
          path: slash(entry.target),
          rel: null,
          title: oneLine(entry.title || "") || path.basename(String(entry.target)),
          at: entry.at || null,
          source: "deliverable",
          url: null,
          why: existsSync(String(entry.target)) && !isFile(String(entry.target))
            ? "the delivered path is not a regular file"
            : "the delivered file is gone and the same path is not in this task's tree, so it cannot be opened",
          mtimeMs: 0,
          delivered: { seq: entry.seq || null, at: entry.at || null },
        });
        continue;
      }
      seen.add(hit.file);
      fromDeliverables += 1;
      rows.push({
        name: path.basename(hit.file),
        path: slash(hit.file),
        rel: hit.rel,
        title: titleOf(hit.file, entry.title),
        at: entry.at || new Date(mtimeOf(hit.file)).toISOString(),
        source: "deliverable",
        url: null, // filled below, once the row knows its thread and task
        why: null,
        mtimeMs: mtimeOf(hit.file),
        delivered: { seq: entry.seq || null, at: entry.at || null },
      });
    }
  } else {
    skipped.push({ source: "deliverables", why: "this server was composed without the deliverables store" });
  }
  // (b) the tree: files this branch touched, stat'ed after the git read so a path that is not there never becomes a row.
  let fromTree = 0;
  if (tree && existsSync(tree)) {
    const scan = await treeReports(tree, task?.row?.baseBranch || task?.baseBranch || null);
    if (scan.why) skipped.push({ source: "tree", why: scan.why });
    for (const file of scan.paths) {
      const hit = locate(file, roots);
      if (!hit) continue;
      if (seen.has(hit.file)) continue;
      seen.add(hit.file);
      fromTree += 1;
      rows.push({
        name: path.basename(hit.file),
        path: slash(hit.file),
        rel: hit.rel,
        title: titleOf(hit.file, ""),
        at: new Date(mtimeOf(hit.file)).toISOString(),
        source: "tree",
        url: null,
        why: null,
        mtimeMs: mtimeOf(hit.file),
        delivered: null,
      });
    }
  } else if (!tree) {
    skipped.push({ source: "tree", why: "this task names no worktree, so there is no tree to scan" });
  } else {
    skipped.push({ source: "tree", why: `the task's tree is gone (${slash(tree)}), so only the deliverables could be read` });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs || String(a.title).localeCompare(String(b.title)));
  const kept = rows.slice(0, REPORTS_CAP);
  // The url is added LAST, so every row's link names the same thread, task and relative path the view route resolves.
  const q = (rel) => `thread=${encodeURIComponent(thread)}&task=${encodeURIComponent(String(task?.id ?? ""))}&path=${encodeURIComponent(rel)}`;
  for (const row of kept) {
    if (!row.rel) continue;
    row.url = `${REPORTS_VIEW_PATH}?${q(row.rel)}`;
  }
  log(`reports: ${kept.length} report${kept.length === 1 ? "" : "s"} for ${thread || "no thread"} (${fromDeliverables} deliverable, ${fromTree} tree)`);
  return {
    reports: kept,
    sources: { deliverables: fromDeliverables, tree: fromTree },
    skipped,
  };
}

/**
 * The route. `taskRows` is the composition root's flattened queue read (routes/waves.js `queueRows`), `deliverables`
 * its store, and `projectRoot` the checkout a project's name resolves to - the fallback root when a task's tree has
 * been removed but its branch has already merged.
 */
export function createReportsRoutes({ taskRows = null, deliverables = null, projectRoot = null, sendJson, log = () => {} } = {}) {
  if (typeof sendJson !== "function") throw new Error("createReportsRoutes needs sendJson from the server's transport");

  const rowsOf = () => {
    try {
      return typeof taskRows === "function" ? taskRows() || [] : [];
    } catch (err) {
      log(`reports: the queue read failed (${String((err && err.message) || err)}) - no task can be located`);
      return [];
    }
  };

  /**
   * The row a request names: the thread is the key, the id picks one row when a thread carried several. A row that is
   * not found is a 404 with the reason, never an empty list - "no reports" and "no such task" are different answers.
   */
  const find = ({ thread, task }) => {
    const want = String(thread || "").trim();
    if (!want) return { status: 400, error: "a thread is required: pass thread=<the task's thread> (a task id is per-assistant, so the thread is the key)" };
    const id = task == null || String(task).trim() === "" ? null : Number(task);
    if (id !== null && !Number.isFinite(id)) return { status: 400, error: `task must be a number (got "${oneLine(task, 40)}")` };
    const all = rowsOf();
    const matches = all.filter((row) => {
      if (!row) return false;
      const threads = [row.thread, ...(Array.isArray(row.threads) ? row.threads : [])].map((t) => String(t || "").trim()).filter(Boolean);
      if (!threads.includes(want)) return false;
      return id === null || Number(row.id) === id;
    });
    if (!matches.length) return { status: 404, error: `no queue row on thread ${want}${id === null ? "" : ` with id ${id}`} - this task's reports cannot be located` };
    return { status: 200, task: matches[0] };
  };

  /** The roots a task's reports may be read from, in order: its own tree, then the project checkout. */
  const rootsOf = (task) => {
    const tree = slash(task?.worktree) || null;
    const roots = [];
    if (tree && existsSync(tree)) roots.push(path.resolve(tree));
    if (typeof projectRoot === "function") {
      let checkout = null;
      try {
        checkout = projectRoot(String(task?.project || "").trim());
      } catch {
        checkout = null;
      }
      if (checkout && existsSync(checkout) && !roots.includes(path.resolve(checkout))) roots.push(path.resolve(checkout));
    }
    return { tree, roots };
  };

  return async function reportsRoutes(req, res, route, url) {
    if (route !== REPORTS_PATH && route !== REPORTS_VIEW_PATH) return false;
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "GET only: a report is read, never written" });
      return true;
    }
    const found = find({ thread: params.get("thread"), task: params.get("task") });
    if (found.status !== 200) {
      sendJson(res, found.status, { error: found.error });
      return true;
    }
    const task = found.task;
    const { tree, roots } = rootsOf(task);
    const project = params.get("project") || task.project || null;

    if (route === REPORTS_PATH) {
      const answer = await listReports({ task, tree, roots, deliverables, log });
      sendJson(res, 200, {
        at: new Date().toISOString(),
        thread: String(task.thread || ""),
        task: { id: task.id ?? null, title: task.title || "", state: task.state || null, project: project || null, worktree: tree },
        reports: answer.reports,
        sources: answer.sources,
        skipped: answer.skipped,
        searched: {
          tree,
          root: roots[0] || null,
          sources: ["deliverables", tree && existsSync(tree) ? "tree" : null].filter(Boolean),
        },
        cap: REPORTS_CAP,
        count: answer.reports.length,
      });
      return true;
    }

    // ---- the view: one file, sandboxed, from under the task's roots only -------------------------------------------
    const wanted = resolveReportPath(roots[0] || null, params.get("path"));
    if (!wanted.ok) {
      sendJson(res, wanted.status, { error: wanted.error });
      return true;
    }
    const hit = locate(wanted.file, roots);
    if (!hit) {
      sendJson(res, 404, { error: `no such report under this task: ${wanted.rel}` });
      return true;
    }
    let body;
    try {
      body = readFileSync(hit.file);
    } catch (err) {
      sendJson(res, 404, { error: `the report could not be read: ${String((err && err.message) || err)}` });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "Content-Security-Policy": REPORTS_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
    log(`reports: served ${hit.rel} for ${String(task.thread || "")} (${hit.root === tree ? "tree" : "checkout"})`);
    return true;
  };
}
