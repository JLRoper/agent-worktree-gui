// ---- the provenance card every rendered report ends with ------------------------------------------
// A report page is a snapshot. It says what the panel knew when it was drawn, and a reader who opens it
// a month later has no way to tell which run produced it, which commit the panel was running, or which
// file the numbers came from. This module is the ONE renderer for that answer, so every page the panel
// produces ends with the same card instead of a footer written per page.
//
// The card IS the panel's clarify card: the same `.turn-question` shell, the same `.tq-*` rows, the same
// colours. A report page is one self-contained file and cannot link the panel's stylesheet, so
// REPORT_FOOTER_CSS carries those rules verbatim from public/style.css, and test/report-footer.test.js
// fails when the two drift apart. That is what makes this a reuse of the card rather than a second card
// style: change the panel's card and the test names the line to copy.
//
// A field the renderer cannot establish is printed as "unknown". Never a blank, never a guess: a card
// that says unknown is a fact about the render, while a card that invents a run id is a claim a reader
// cannot check.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveLayout } from "./paths.js";

export const UNKNOWN = "unknown";

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// The panel's clarify card, copied rule for rule out of public/style.css. The `:root` block is the
// card's default (violet) tint; the `.report-provenance` rules below it are the only additions, and
// they set the card's place on a report page and make its rows read as facts rather than buttons.
export const REPORT_FOOTER_CSS = `
:root { --q-line: #55407a; --q-head: #ecd9ff; --q-question: #f4efff; --q-bg-a: rgba(42, 32, 68, .72); --q-bg-b: rgba(30, 24, 46, .72); --q-choice-bg: rgba(26, 20, 40, .55); --q-choice-line: #4a3a6b; --q-choice-text: #e7dcff; --q-choice-hover: #352a52; --q-choice-hover-line: #66509a; --q-choice-on: #3b2e5c; --q-choice-on-line: #8a6fc0; --q-accent: #8a6fc0; --q-box: #66509a; --q-tick: #ecd9ff; --q-note: #b6a3d6; --q-size: 13px; }
.turn-question { max-width: none; margin: 8px 0 6px 18px; border: 1px solid var(--q-line); border-radius: 8px; background: linear-gradient(180deg, var(--q-bg-a), var(--q-bg-b)); box-shadow: 0 6px 18px rgba(0,0,0,.35); padding: 10px 12px; }
.tq-head { font-size: 11.5px; color: var(--q-head); letter-spacing: .01em; }
.tq-question { margin: 8px 0 9px; font: var(--q-size, 13px)/1.5 var(--ui); color: var(--q-question); white-space: pre-wrap; word-break: break-word; }
.tq-choices { display: flex; flex-direction: column; gap: 6px; }
.tq-choice { display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; padding: 7px 10px; border: 1px solid var(--q-choice-line); border-radius: 6px; background: var(--q-choice-bg); color: var(--q-choice-text); font: calc(var(--q-size, 13px) - 0.5px)/1.45 var(--ui); white-space: pre-wrap; word-break: break-word; cursor: pointer; }
.tq-text { min-width: 0; flex: 1 1 auto; }
.tq-note { margin: 9px 0 5px; font-size: 10.5px; color: var(--q-note); }
.tq-foot { display: flex; align-items: center; gap: 10px; margin-top: 9px; }
.tq-left { flex: none; font-size: 10.5px; color: var(--q-note); }
.report-provenance { margin: 26px 0 0; }
.report-provenance .tq-choice { cursor: default; }
.report-provenance .tq-choice b { flex: none; min-width: 74px; color: var(--q-head); font-weight: 600; }
.report-provenance .tq-choice code { font-family: var(--mono, ui-monospace, monospace); font-size: 11.5px; color: var(--q-question); background: transparent; border: 0; padding: 0; }
.report-provenance a { color: var(--q-accent); text-decoration: underline; }
.report-provenance .tq-unknown { color: var(--q-note); font-style: italic; }
`;

const unknown = () => `<span class="tq-unknown">${UNKNOWN}</span>`;

// One row of the card: a label and the value the renderer could establish. `value` is already HTML.
const fact = (label, value) => `<div class="tq-choice"><b>${esc(label)}</b><span class="tq-text">${value}</span></div>`;

const text = (v) => {
  const s = String(v == null ? "" : v).trim();
  return s ? s : UNKNOWN;
};

const url = (v) => {
  const s = String(v == null ? "" : v).trim();
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
};

// The card. Every field is optional: a missing one prints "unknown" rather than an empty cell, and the
// link is the commit on the remote when the renderer could build one, otherwise the run on the panel.
export function reportFooter(fields = {}) {
  const f = fields || {};
  const title = text(f.title);
  const runId = text(f.runId);
  const thread = text(f.thread);
  const commit = text(f.commit);
  const generatedAt = text(f.generatedAt);
  const source = text(f.source);
  const commitUrl = url(f.commitUrl);
  const runUrl = url(f.runUrl);

  // One link, and the commit wins it: a commit page is reachable by anyone who opens the report, while the
  // panel URL names a listener on the machine that rendered it. The run is the fallback only when there is
  // no commit page to point at, and it says so in its title.
  const runValue = runId === UNKNOWN
    ? unknown()
    : !commitUrl && runUrl
      ? `<a href="${esc(runUrl)}" title="opens the panel on the machine that rendered this report">${esc(runId)}</a>`
      : `<code>${esc(runId)}</code>`;
  const threadValue = thread === UNKNOWN ? unknown() : `<code>${esc(thread)}</code>`;
  const commitValue = commit === UNKNOWN
    ? unknown()
    : commitUrl
      ? `<a href="${esc(commitUrl)}" title="the commit on the remote">${esc(commit)}</a>`
      : `<code>${esc(commit)}</code>`;
  const generatedValue = generatedAt === UNKNOWN ? unknown() : `<code>${esc(generatedAt)}</code> UTC`;

  return `<div class="turn-question report-provenance" data-report-footer="1" role="note" aria-label="where this report's numbers came from" data-run="${esc(runId)}" data-thread="${esc(thread)}" data-commit="${esc(commit)}" data-generated-at="${esc(generatedAt)}" data-source="${esc(source)}" data-link="${esc(commitUrl || runUrl || "")}">
  <div class="tq-head mono">where these numbers came from</div>
  <div class="tq-question">${esc(title)}</div>
  <div class="tq-choices">
    ${fact("run", `${runValue} <span class="tq-thread">thread ${threadValue}</span>`)}
    ${fact("commit", `${commitValue}${commitUrl ? " on the remote" : ""}`)}
    ${fact("generated", generatedValue)}
  </div>
  <div class="tq-note mono">${esc(source)}</div>
</div>`;
}

// ---- what the renderer can honestly establish ------------------------------------------------------
// The commit is the checkout the renderer ran in, which is the commit the panel serving that checkout is
// running. The run is the live job the panel's own store holds for this tree: the run that invoked the
// render. Both are read, never assumed, and either can come back unknown.
function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
  } catch {
    return "";
  }
}

// A remote URL to the commit page a reader can open. Only the two hosts whose commit URL shape is fixed
// are built; anything else answers null, and the card falls back to the run rather than inventing a link.
export function commitUrlFor(remote, sha) {
  const r = String(remote || "").trim();
  const s = String(sha || "").trim();
  if (!r || !s) return null;
  let host = "";
  let slug = "";
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(r);
  if (scp && !/^[a-z]+:\/\//i.test(r)) {
    host = scp[1].toLowerCase();
    slug = scp[2];
  } else {
    try {
      const u = new URL(r);
      host = u.hostname.toLowerCase();
      slug = u.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }
  slug = slug.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!/^[^/]+\/[^/]+$/.test(slug)) return null;
  if (host === "github.com") return `https://github.com/${slug}/commit/${s}`;
  if (host === "bitbucket.org") return `https://bitbucket.org/${slug}/commits/${s}`;
  return null;
}

const norm = (p) => String(p == null ? "" : p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// The newest live job the panel's store holds for this tree. A store that is missing, unreadable or
// holds no live job in this tree answers null, and the card says unknown.
export function liveRunFor(root, { jobsFile = null, env = process.env } = {}) {
  let file = jobsFile;
  if (!file) {
    try {
      file = resolveLayout({ here: root, env }).paths.jobsFile;
    } catch {
      return null;
    }
  }
  let store;
  try {
    store = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  const jobs = Array.isArray(store && store.jobs) ? store.jobs : [];
  const here = norm(root);
  const live = jobs
    .filter((j) => j && (j.status === "running" || j.status === "waiting"))
    .filter((j) => {
      const cwd = norm(j.cwd);
      return cwd === here || cwd.startsWith(`${here}/`);
    })
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  const job = live[0];
  if (!job) return null;
  return { id: job.id || null, runId: job.runId || null, thread: job.thread || null };
}

// Everything the card needs, resolved once. `source` is the caller's own sentence: the command that
// rendered the page and the file its figures came from.
export function resolveReportProvenance({ repo, title, source, now = new Date(), env = process.env, jobsFile = null } = {}) {
  const root = path.resolve(repo || process.cwd());
  const sha = git(root, ["rev-parse", "HEAD"]);
  const remote = git(root, ["remote", "get-url", "origin"]);
  const run = liveRunFor(root, { jobsFile, env });
  let port = 7331;
  try {
    const layout = resolveLayout({ here: root, env });
    const n = Number(layout.config && layout.config.port);
    if (Number.isFinite(n) && n > 0) port = n;
  } catch {
    /* the default port is the panel's own default, not a guess about this install */
  }
  return {
    title: text(title),
    runId: run && run.runId ? run.runId : UNKNOWN,
    thread: run && run.thread ? run.thread : UNKNOWN,
    commit: sha ? sha.slice(0, 7) : UNKNOWN,
    commitFull: sha || UNKNOWN,
    commitUrl: commitUrlFor(remote, sha),
    runUrl: run && run.id ? `http://127.0.0.1:${port}/` : null,
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    source: text(source),
  };
}
