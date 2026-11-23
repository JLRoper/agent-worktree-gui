// THE REPORTS A TASK LEFT BEHIND, over a real server in a sandbox: the chip's two routes.
//
//   GET /api/reports?thread=<thread>&task=<id>       the list, from the union of the two sources
//   GET /api/reports/view?thread=<thread>&task=<id>&path=<relative>   one file, sandboxed
//
// WHAT THIS FILE PINS, in the order it runs:
//
//   * THE UNION IS A UNION. A report DECLARED by the task's thread and a report the task's TREE added are both listed,
//     and a file both sources name appears ONCE (the deliverable's own title wins, because it is the one the reader was
//     handed).
//   * THE BASE'S REPORTS ARE NOT THIS TASK'S. A report committed to main BEFORE the tree was cut sits in the same
//     docs/reports directory and is NOT listed: the scan reads what the branch added or changed, not the directory.
//   * A FILE THE PANEL CANNOT OPEN IS NAMED, NEVER LINKED. A delivered report whose file is gone, and one delivered from
//     outside the task's tree, are rows with a `why` and a null `url`.
//   * THE VIEW IS SANDBOXED. 200 with text/html; charset=utf-8, Cache-Control no-store and the exact CSP; an absolute
//     path, a `..` segment, a non-.html suffix and a path outside the tree are 400s with a sentence.
//   * NEWEST FIRST, and the row order is the mtimes', not the sources' order.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";
import { git, post, startPanel, waitForState } from "../tools/panel-testkit.mjs";
import { REPORTS_CSP } from "../routes/reports.js";

const sandbox = mkdtempSync(path.join(tmpdir(), "wag-reports-route-"));
const repos = path.join(sandbox, "repos");
mkdirSync(repos, { recursive: true });
after(() => rmSync(sandbox, { recursive: true, force: true }));

const THREAD = "reports-row-thread";
const HOUR = 3600 * 1000;

// One project: main already carries a report (it is NOT this task's), the branch adds a committed one, an untracked one
// and one the thread declares.
const repo = path.join(repos, "reports-proj");
mkdirSync(path.join(repo, "docs", "reports"), { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# reports-proj\n");
writeFileSync(path.join(repo, "docs", "reports", "old-2026-01-01.html"), '<title>Old report</title><p>main carried this before the cut</p>\n');
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "main: the base report"]);
const tree = path.join(repo, ".worktrees", "report-tree");
git(repo, ["worktree", "add", "-q", "-b", "feat/report-tree", tree]);

const treeReports = path.join(tree, "docs", "reports");
mkdirSync(treeReports, { recursive: true });
const fresh = path.join(treeReports, "fresh-2026-11-20.html");
writeFileSync(fresh, '<!doctype html><title>The fresh report</title><p id="marker">fresh body</p>\n');
git(tree, ["add", "docs/reports/fresh-2026-11-20.html"]);
git(tree, ["commit", "-q", "-m", "the tree's report"]);
const untracked = path.join(treeReports, "untracked-2026-11-21.html");
writeFileSync(untracked, "<title>The untracked report</title><p>never committed</p>\n");
const declared = path.join(treeReports, "declared-2026-11-22.html");
writeFileSync(declared, "<title>The declared file's own title</title><p>delivered and on disk</p>\n");
const outside = path.join(sandbox, "outside.html");
writeFileSync(outside, "<title>Outside the tree</title><p>not under any tree</p>\n");
// Deterministic newest-first: declared (now - 1h) then untracked (now - 2h) then fresh (now - 3h).
const now = Date.now() / 1000;
utimesSync(declared, now - HOUR / 1000, now - HOUR / 1000);
utimesSync(untracked, now - (2 * HOUR) / 1000, now - (2 * HOUR) / 1000);
utimesSync(fresh, now - (3 * HOUR) / 1000, now - (3 * HOUR) / 1000);

// The deliverables store, written before the boot: the store loads lazily on its first read, so this is what that read
// sees. Three hrefs on the task's thread - the declared file, one whose file is gone, and one outside the tree.
const deliverablesFile = path.join(sandbox, "logs", "deliverables.json");
mkdirSync(path.dirname(deliverablesFile), { recursive: true });
const entry = (seq, target, title) => ({
  seq,
  kind: "file",
  target,
  title,
  at: new Date(Date.now() - seq * 60_000).toISOString(),
  project: "reports-proj",
  treePath: tree.replace(/\\/g, "/"),
  branch: "feat/report-tree",
  tag: null,
  jobId: null,
  thread: THREAD,
  turn: 1,
  agent: "assistant-1",
  bytes: 10,
  mtimeMs: null,
  missingAt: null,
});
writeFileSync(
  deliverablesFile,
  `${JSON.stringify(
    {
      version: 1,
      savedAt: new Date().toISOString(),
      nextSeq: 4,
      seenSeq: 0,
      seenAt: null,
      entries: [
        entry(1, declared, "The declared report"),
        entry(2, path.join(treeReports, "gone-2026-11-19.html"), "The report whose file is gone"),
        entry(3, outside, "The report outside the tree"),
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const panel = await startPanel({ dir: sandbox, config: { deliverablesFile } });
after(() => panel.stop());
const base = panel.base;
const get = async (p) => {
  const r = await fetch(`${base}${p}`);
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, headers: r.headers, text, json };
};

await waitForState(
  base,
  (s) => s.projects.flatMap((p) => (p.worktrees || []).map((w) => w.path)).some((p) => p.replace(/\\/g, "/").toLowerCase() === tree.replace(/\\/g, "/").toLowerCase()),
  "the task's worktree is on the board",
  { timeout: 120_000 },
);

const assistant = (await get("/api/assistant")).json?.assistants?.[0];
assert.ok(assistant?.id, "the panel seeds an assistant");
const made = await post(base, "/api/assistant/queue", { body: { assistantId: assistant.id, action: "add", title: "the reports row", worktree: tree, project: "reports-proj" } });
assert.equal(made.status, 200, made.text);
const task = (await get(`/api/assistant/queue?assistantId=${assistant.id}`)).json.queue.tasks.find((t) => t.title === "the reports row");
assert.ok(task, "the filed row is in the queue");
// The thread is the key the chip carries, so the row is stamped with the one the deliverables were written against.
const queueFile = path.join(sandbox, "logs", "assistants", assistant.id, "queue.json");
const queued = readQueueFile(queueFile);
assert.equal(queued.error, null);
writeQueueFile(queueFile, queued.tasks.map((t) => (t.id === task.id ? { ...t, thread: THREAD } : t)), queued.nextId);

const listUrl = (over = {}) => {
  const q = new URLSearchParams({ thread: over.thread ?? THREAD, task: String(over.task ?? task.id) });
  return `/api/reports?${q.toString()}`;
};
const viewUrl = (rel, over = {}) => {
  const q = new URLSearchParams({ thread: over.thread ?? THREAD, task: String(over.task ?? task.id), path: rel });
  return `/api/reports/view?${q.toString()}`;
};

// ---- the list and its view, as one test ---------------------------------------------------------
test("the reports list is the union of both sources, and the view serves one file sandboxed", async () => {
  const listed = await get(listUrl());
  assert.equal(listed.status, 200, listed.text);
  const reports = listed.json.reports;
  const byName = (name) => reports.filter((r) => r.name === name);

  // The union: two tree reports, the declared one (deduped with the scan), and the two the panel cannot open.
  assert.equal(byName("fresh-2026-11-20.html").length, 1, "the committed report is listed");
  assert.equal(byName("untracked-2026-11-21.html").length, 1, "the untracked report is listed");
  assert.equal(byName("declared-2026-11-22.html").length, 1, "a file both sources name is ONE row");
  assert.equal(byName("old-2026-01-01.html").length, 0, "a report main carried before the cut is not this task's");
  assert.equal(byName("gone-2026-11-19.html").length, 1, "a delivered file that is gone is still named");
  assert.equal(byName("outside.html").length, 1, "a delivery outside the tree is still named");
  assert.equal(reports.length, 5, `five rows: ${reports.map((r) => r.name).join(", ")}`);

  const declaredRow = byName("declared-2026-11-22.html")[0];
  assert.equal(declaredRow.source, "deliverable", "the declared title wins the dedupe");
  assert.equal(declaredRow.title, "The declared report");
  assert.match(declaredRow.rel, /^docs\/reports\/declared-2026-11-22\.html$/, "the row carries the path the view route resolves");
  assert.match(declaredRow.url, /^\/api\/reports\/view\?/, "an openable row carries a url");
  assert.match(declaredRow.url, /path=docs%2Freports%2Fdeclared-2026-11-22\.html/);

  const freshRow = byName("fresh-2026-11-20.html")[0];
  assert.equal(freshRow.source, "tree");
  assert.equal(freshRow.title, "The fresh report", "a tree report's title comes from its own <title>");

  const goneRow = byName("gone-2026-11-19.html")[0];
  assert.equal(goneRow.url, null, "no url for a file that is not on disk");
  assert.match(goneRow.why, /file is gone/, `the row says why: ${goneRow.why}`);
  const outsideRow = byName("outside.html")[0];
  assert.equal(outsideRow.url, null, "no url for a file outside the task's tree");

  // Newest first: the mtimes, not the sources' order.
  assert.deepEqual(reports.slice(0, 3).map((r) => r.name), ["declared-2026-11-22.html", "untracked-2026-11-21.html", "fresh-2026-11-20.html"]);
  assert.equal(listed.json.task.worktree.replace(/\\/g, "/").toLowerCase(), tree.replace(/\\/g, "/").toLowerCase());
  assert.equal(listed.json.sources.deliverables, 1, "one deliverable could be opened (the other two name no file on disk)");
  assert.equal(listed.json.sources.tree, 2, "two tree reports were added");
  assert.equal(listed.json.cap, 50);

  // A refusal is a sentence, not an empty list.
  const noThread = await get("/api/reports");
  assert.equal(noThread.status, 400);
  assert.match(noThread.json.error, /thread is required/);
  const noRow = await get(listUrl({ thread: "a-thread-nobody-has" }));
  assert.equal(noRow.status, 404);
  assert.match(noRow.json.error, /no queue row/);
  const wrongTask = await get(listUrl({ task: 9999 }));
  assert.equal(wrongTask.status, 404);

  // ---- the view ---------------------------------------------------------------------------------------------------
  const seen = await get(viewUrl("docs/reports/fresh-2026-11-20.html"));
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(seen.headers.get("cache-control"), "no-store");
  assert.equal(seen.headers.get("content-security-policy"), REPORTS_CSP);
  assert.equal(seen.headers.get("x-content-type-options"), "nosniff");
  assert.match(seen.text, /fresh body/, "the file's own bytes are served");

  // Traversal, absolute paths, a non-report and a missing file are refused with a sentence.
  const dotdot = await get(viewUrl("../outside.html"));
  assert.equal(dotdot.status, 400);
  assert.match(dotdot.json.error, /\.\./);
  const absolute = await get(viewUrl(outside));
  assert.equal(absolute.status, 400);
  assert.match(absolute.json.error, /absolute path/);
  const notHtml = await get(viewUrl("docs/reports/fresh-2026-11-20.txt"));
  assert.equal(notHtml.status, 400);
  assert.match(notHtml.json.error, /only \.html/);
  const missing = await get(viewUrl("docs/reports/nope.html"));
  assert.equal(missing.status, 404);

  // The view without a row, and a write, are both refusals.
  const viewNoRow = await get(`/api/reports/view?thread=${encodeURIComponent("nobody")}&task=1&path=docs%2Freports%2Fx.html`);
  assert.equal(viewNoRow.status, 404);
  const write = await fetch(`${base}/api/reports`, { method: "POST" });
  assert.equal(write.status, 405);
});
