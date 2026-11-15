// The page the cleanup chip opens: one row per worktree and branch, the proof behind it, what a merge added, and
// the keep-or-drop call with its reason.
//
// Written into the TARGET repo, under docs/reports/, because that is where this project keeps a run's evidence and
// the reader finds it next to the trees it describes. The file is the run's own record: a dry run writes a plan,
// an apply writes the same plan with what each row's act returned, and both are written by the SAME renderer so the
// page a reader compares against is the page the run decided from.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const humanBytes = (n) => {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs < 1024) return `${v} B`;
  if (abs < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
};

/** `worktree-cleanup-2026-11-14-0930.html`, under docs/reports/ of the repo the run is about. */
export function reportRelPath(at = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  return `docs/reports/worktree-cleanup-${day}-${p(at.getHours())}${p(at.getMinutes())}.html`;
}

const VERDICT_NOTE = {
  remove: "drop the tree and its branch",
  merge: "merge the branch --no-ff into a child, then keep the tree",
  keep: "keep it as it is",
  skip: "not the cleanup's to touch",
};

const CALL_LABEL = { drop: "drop", keep: "keep" };

function mergeCell(row) {
  const m = row?.merge;
  if (!m) return `<span class="muted">-</span>`;
  if (m.error) return `<span class="bad">${esc(m.error)}</span>`;
  const bytes = Number(m.bytes) || 0;
  return [
    `<code>${esc(m.child || "")}</code>`,
    `<div class="small">${esc(m.base || "")} -&gt; ${esc(String(m.commit || "").slice(0, 12))}</div>`,
    `<div class="small">${Number(m.files) || 0} file${Number(m.files) === 1 ? "" : "s"}, ${humanBytes(bytes)}${bytes < 0 ? " (net removed)" : " added"}, +${Number(m.linesAdded) || 0}/-${Number(m.linesRemoved) || 0} lines</div>`,
    m.treeKept ? `<div class="small warn">the dirty tree was left in place, its working files untouched</div>` : "",
  ].filter(Boolean).join("");
}

function resultCell(row) {
  const r = row?.result;
  if (!r) return "";
  if (r.acted && r.ok) return `<span class="ok">${esc(r.why)}</span>`;
  if (r.acted && !r.ok) return `<span class="bad">${esc(r.why)}</span>`;
  if (r.ok === false) return `<span class="bad">${esc(r.why)}</span>`;
  return `<span class="muted">${esc(r.why)}</span>`;
}

function dirtyCell(row) {
  if (!row?.dirty) return `<span class="muted">clean</span>`;
  const files = Array.isArray(row.dirtyFiles) ? row.dirtyFiles : [];
  const shown = files.slice(0, 4).map((f) => `<code>${esc(f)}</code>`).join(" ");
  return `<span class="warn">${files.length || "some"} file${files.length === 1 ? "" : "s"}</span>${shown ? `<div class="small">${shown}${files.length > 4 ? ` +${files.length - 4}` : ""}</div>` : ""}`;
}

/**
 * The page. `run` is `applyCleanup`'s answer, or null for a dry run: the same rows, the same proofs, and a header
 * that says which of the two the reader is holding.
 */
export function renderCleanupReport({ project = {}, plan = {}, run = null, at = new Date(), reportPath = "" } = {}) {
  const rows = Array.isArray(run?.rows) ? run.rows : Array.isArray(plan?.rows) ? plan.rows : [];
  const counts = run?.counts || plan?.counts || {};
  const applied = Boolean(run);
  const drop = Number(counts.remove) || 0;
  const merge = Number(counts.merge) || 0;
  const keep = Number(counts.keep) || 0;
  const skip = Number(counts.skip) || 0;
  const failed = Number(counts.failed) || 0;
  const when = `${String(at.getFullYear())}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const title = applied
    ? `${project.name || "project"} cleanup - ${drop} dropped, ${merge} merged, ${keep + skip} kept${failed ? `, ${failed} failed` : ""}`
    : `${project.name || "project"} cleanup plan - ${drop} to drop, ${merge} to merge, ${keep + skip} to keep`;

  const table = rows
    .map(
      (row) => `<tr>
      <td class="tree"><code>${esc(row.path || "")}</code><div class="small">${esc(row.branch || "no branch")}</div></td>
      <td><span class="verdict v-${esc(row.verdict)}">${esc(row.verdict)}</span><div class="small">${esc(VERDICT_NOTE[row.verdict] || "")}</div></td>
      <td>${row.verdict === "skip" ? `<span class="muted">-</span>` : `${esc(row.proof?.detail || "")}${row.proof?.kind && row.proof.kind !== "none" ? `<div class="small"><code>${esc(row.proof.kind)}</code></div>` : ""}`}</td>
      <td>${dirtyCell(row)}</td>
      <td>${mergeCell(row)}</td>
      <td><span class="call c-${esc(row.call || "keep")}">${esc(CALL_LABEL[row.call] || row.call || "keep")}</span><div class="small">${esc(row.reason || "")}</div>${resultCell(row)}</td>
    </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>
  :root{ color-scheme:dark; --ink:#e8e6e1; --paper:#14161a; --rule:#2a2f38; --muted:#9aa3ad; --accent:#c8a6ff; --warn:#f0c674; --bad:#e5534b; --ok:#7ee2a8; --sunk:#1a1d22; }
  html,body{ margin:0; background:var(--paper); color:var(--ink); font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif; }
  main{ max-width:1180px; margin:0 auto; padding:36px 28px 80px; }
  h1{ font-size:26px; margin:0 0 4px; letter-spacing:-.01em; }
  h2{ font-size:18px; margin:34px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--rule); }
  .sub{ color:var(--muted); margin:0 0 22px; }
  .prov{ color:var(--ink); margin:0 0 12px; }
  .prov b{ color:var(--accent); }
  .cards{ display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin:18px 0 6px; }
  .card{ border:1px solid var(--rule); border-radius:10px; padding:12px 14px; }
  .card b{ display:block; font-size:22px; letter-spacing:-.02em; }
  .card span{ color:var(--muted); font-size:13px; }
  table{ border-collapse:collapse; width:100%; font-size:13.5px; }
  th,td{ text-align:left; padding:7px 9px; border-bottom:1px solid var(--rule); vertical-align:top; }
  th{ color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  td.tree{ min-width:220px; overflow-wrap:anywhere; }
  code{ font:12.5px ui-monospace,Consolas,monospace; background:rgba(127,127,127,.12); padding:1px 5px; border-radius:4px; }
  .small{ font-size:12px; color:var(--muted); }
  .muted{ color:var(--muted); }
  .ok{ color:var(--ok); }
  .warn{ color:var(--warn); }
  .bad{ color:var(--bad); }
  .verdict{ font:12px ui-monospace,Consolas,monospace; padding:1px 6px; border:1px solid var(--rule); border-radius:9px; }
  .v-remove{ color:var(--bad); border-color:#4a2622; }
  .v-merge{ color:var(--accent); border-color:#3b2d5c; }
  .v-keep{ color:var(--warn); border-color:#4a3a1f; }
  .v-skip{ color:var(--muted); }
  .call{ font:12px ui-monospace,Consolas,monospace; padding:1px 6px; border-radius:9px; border:1px solid var(--rule); }
  .c-drop{ color:var(--bad); border-color:#4a2622; background:#2a1817; }
  .c-keep{ color:var(--ok); border-color:#22402f; background:#16241c; }
  .box{ border:1px solid var(--rule); border-radius:10px; padding:14px 16px; margin:20px 0 0; background:var(--sunk); }
  .box h2{ margin:0 0 8px; border:0; padding:0; font-size:17px; }
  .box ol{ padding-left:22px; margin:6px 0 0; }
  .box li{ margin:6px 0; }
</style>
</head>
<body>
<main>

<h1>${esc(title)}</h1>
<p class="sub">Every verdict below was read from the tree at the moment of the run, never from a list written earlier. ${applied ? "This run APPLIED the plan; each row says what its act returned." : "This is a DRY RUN: nothing was removed, merged or moved."}</p>

<p class="prov"><b>Measured</b> ${esc(when)}, in <code>${esc(project.path || "")}</code>, against <code>${esc(plan.main || project.mainBranch || "main")}</code>${plan.turnoverBranch ? `, with turnover branch <code>${esc(plan.turnoverBranch)}</code>` : ", with no turnover branch configured"}. The panel's own tree${plan.ownPath ? ` (<code>${esc(plan.ownPath)}</code>)` : ""} and the primary checkout are never candidates.</p>

<div class="cards">
  <div class="card"><b>${drop}</b><span>worktrees and branches to drop</span></div>
  <div class="card"><b>${merge}</b><span>branches to merge into a child</span></div>
  <div class="card"><b>${keep}</b><span>kept, with a reason</span></div>
  <div class="card"><b>${skip}</b><span>not the cleanup's to touch</span></div>
</div>

<h2>One row per worktree</h2>
<div style="overflow-x:auto">
<table>
<thead><tr><th>Worktree</th><th>Verdict</th><th>Proof</th><th>Tree</th><th>Merge</th><th>Call, and why</th></tr></thead>
<tbody>
${table || `<tr><td colspan="6" class="muted">no worktrees were read for this project</td></tr>`}
</tbody>
</table>
</div>

<div class="box">
  <h2>The rules this plan obeys</h2>
  <ol>
    <li>The primary checkout and the panel's own tree are never touched.</li>
    <li>A locked worktree, or one a live job holds, is skipped.</li>
    <li>A turnover branch, and the branch the project marks as its base, is never deleted.</li>
    <li>A worktree and branch are removed only when the branch is an ancestor of main, or every commit main lacks is cherry-equivalent.</li>
    <li>Otherwise a branch holding work main lacks is merged <code>--no-ff</code> into a child of the turnover branch when the project has one, else of main.</li>
    <li>A dirty tree with such work has its branch merged and its working tree left alone, named here.</li>
    <li>No <code>--force</code> anywhere, and nothing is pushed.</li>
  </ol>
</div>

<p class="small" style="margin-top:22px">Report written by the panel's cleanup chip to <code>${esc(reportPath || "")}</code>.</p>

</main>
</body>
</html>
`;
}

/** Write the page into the target repo. Returns where it landed, and the byte count it wrote. */
export async function writeCleanupReport({ repo, html, at = new Date() } = {}) {
  const dir = String(repo || "").trim();
  if (!dir) return { ok: false, error: "no repo to write the report into" };
  const rel = reportRelPath(at);
  const target = path.join(dir, ...rel.split("/"));
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, html, "utf8");
  } catch (e) {
    return { ok: false, error: `could not write ${target}: ${String((e && e.message) || e)}` };
  }
  return { ok: true, path: rel.replace(/\//g, path.sep), absPath: target, bytes: Buffer.byteLength(html, "utf8") };
}
