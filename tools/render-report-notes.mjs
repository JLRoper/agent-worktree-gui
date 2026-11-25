// Render a report's notes to a self-contained page.
//
//   node tools/render-report-notes.mjs docs/reports/<name>.md docs/reports/<name>.html
//
// The notes are the source and the page is generated from them, so a correction is made once. The subset is
// deliberately small - headings, paragraphs, flat lists, pipe tables, fenced code, quotes, rules, and inline
// code/bold/em/links - because a report is prose with citations, not a document language. Nothing is fetched: the
// sheet is inlined and the page opens from disk with no server and no build step.
import { readFileSync, writeFileSync } from "node:fs";

const [notesPath, outPath] = process.argv.slice(2);
if (!notesPath || !outPath) {
  console.error("usage: node tools/render-report-notes.mjs <notes.md> <out.html>");
  process.exit(2);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Inline spans: code is escaped and left alone, everything else gets bold, em and links.
function inline(text) {
  const parts = String(text).split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return `<code>${esc(part.slice(1, -1))}</code>`;
      }
      let s = esc(part);
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
      return s;
    })
    .join("");
}

const lines = readFileSync(notesPath, "utf8").replace(/\r\n/g, "\n").split("\n");
const out = [];
const toc = [];
let title = "";
let i = 0;
let listOpen = false;
let orderedOpen = false;

const closeLists = () => {
  if (listOpen) { out.push("</ul>"); listOpen = false; }
  if (orderedOpen) { out.push("</ol>"); orderedOpen = false; }
};

while (i < lines.length) {
  const line = lines[i];

  // fenced code
  if (/^```/.test(line)) {
    closeLists();
    const lang = line.slice(3).trim();
    const body = [];
    i += 1;
    while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1; }
    i += 1;
    out.push(`<pre class="code${lang ? ` lang-${esc(lang)}` : ""}"><code>${esc(body.join("\n"))}</code></pre>`);
    continue;
  }

  // table
  if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
    closeLists();
    const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const head = cells(line);
    i += 2;
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
    out.push('<div class="tw"><table>');
    out.push(`<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`);
    out.push("<tbody>");
    for (const r of rows) out.push(`<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
    out.push("</tbody></table></div>");
    continue;
  }

  // headings
  const h = /^(#{1,4})\s+(.*)$/.exec(line);
  if (h) {
    closeLists();
    const level = h[1].length;
    const text = h[2];
    if (level === 1 && !title) { title = text.replace(/`/g, ""); i += 1; continue; }
    const id = slug(text);
    if (level === 2) toc.push({ id, text, depth: 2 });
    if (level === 3) toc.push({ id, text, depth: 3 });
    out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
    i += 1;
    continue;
  }

  // rule
  if (/^---\s*$/.test(line)) { closeLists(); out.push("<hr>"); i += 1; continue; }

  // quote
  if (/^>\s?/.test(line)) {
    closeLists();
    const body = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, "")); i += 1; }
    out.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
    continue;
  }

  // lists
  if (/^\s*-\s+/.test(line)) {
    if (orderedOpen) { out.push("</ol>"); orderedOpen = false; }
    if (!listOpen) { out.push("<ul>"); listOpen = true; }
    out.push(`<li>${inline(line.replace(/^\s*-\s+/, ""))}</li>`);
    i += 1;
    continue;
  }
  if (/^\s*\d+\.\s+/.test(line)) {
    if (listOpen) { out.push("</ul>"); listOpen = false; }
    if (!orderedOpen) { out.push("<ol>"); orderedOpen = true; }
    out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
    i += 1;
    continue;
  }

  // blank
  if (!line.trim()) { closeLists(); i += 1; continue; }

  // paragraph
  closeLists();
  const para = [line];
  i += 1;
  while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\||>\s?|\s*-\s+|\s*\d+\.\s+|---\s*$)/.test(lines[i])) {
    para.push(lines[i]);
    i += 1;
  }
  out.push(`<p>${inline(para.join(" "))}</p>`);
}

const css = `
:root { --ink:#e7ecf3; --dim:#9aa7b8; --faint:#6c7a8c; --bg:#0b0e13; --panel:#111722; --line:#212b3a;
        --accent:#7cc4ff; --warn:#ffb86b; --bad:#ff8a80; --good:#7ee787; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
* { box-sizing:border-box; }
html { background:var(--bg); }
body { margin:0; color:var(--ink); background:var(--bg);
       font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width:1020px; margin:0 auto; padding:38px 26px 90px; }
header.report { border-bottom:1px solid var(--line); padding-bottom:18px; margin-bottom:26px; }
header.report .row { color:var(--faint); font:12px/1.4 var(--mono); letter-spacing:.06em; text-transform:uppercase; }
header.report h1 { font-size:30px; line-height:1.2; margin:8px 0 10px; letter-spacing:-.01em; }
header.report .meta { color:var(--dim); font:12.5px/1.6 var(--mono); }
header.report .meta b { color:var(--ink); font-weight:600; }
nav.toc { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 18px; margin:0 0 30px; }
nav.toc .t { color:var(--faint); font:11px/1.4 var(--mono); text-transform:uppercase; letter-spacing:.08em; margin-bottom:8px; }
nav.toc > ol { margin:0; padding-left:0; list-style:none; columns:2; column-gap:34px; }
nav.toc > ol > li { margin:5px 0 2px; font-size:13px; break-inside:avoid; }
nav.toc ol.sub { columns:1; list-style:none; margin:1px 0 5px; padding-left:14px; }
nav.toc ol.sub li { margin:1px 0; font-size:12.5px; }
nav.toc ol.sub a { color:var(--faint); }
nav.toc a { color:var(--dim); text-decoration:none; }
nav.toc a:hover { color:var(--accent); }
h2 { font-size:22px; margin:44px 0 12px; padding-top:14px; border-top:1px solid var(--line); letter-spacing:-.01em; }
h3 { font-size:17px; margin:28px 0 8px; color:#cfd9e6; }
h4 { font-size:15px; margin:22px 0 6px; color:var(--dim); text-transform:uppercase; letter-spacing:.05em; font-size:12px; }
p { margin:10px 0 12px; }
ul, ol { margin:10px 0 14px; padding-left:24px; }
li { margin:5px 0; }
code { font:12.5px/1.45 var(--mono); background:#0f1520; border:1px solid var(--line); border-radius:4px; padding:0 4px; color:#bcd4ee; }
pre.code { background:#0d1219; border:1px solid var(--line); border-radius:8px; padding:14px 16px; overflow:auto; margin:14px 0 18px; }
pre.code code { background:none; border:0; padding:0; font-size:12px; line-height:1.55; color:#c9d6e6; }
blockquote { margin:14px 0; padding:10px 16px; border-left:3px solid var(--warn); background:#171208; color:#f0dcbf; border-radius:0 6px 6px 0; }
blockquote code { background:#20180c; border-color:#3a2c14; color:#ffd9a4; }
hr { border:0; border-top:1px solid var(--line); margin:34px 0; }
.tw { overflow:auto; margin:14px 0 20px; }
table { border-collapse:collapse; width:100%; font-size:13.5px; }
th, td { text-align:left; vertical-align:top; padding:7px 10px; border-bottom:1px solid var(--line); }
th { color:var(--faint); font:11px/1.4 var(--mono); text-transform:uppercase; letter-spacing:.06em; border-bottom:1px solid #2c394c; }
tbody tr:hover { background:#0f1520; }
td code, th code { font-size:11.5px; }
a { color:var(--accent); }
strong { color:#fff; font-weight:600; }
.tag { display:inline-block; font:10.5px/1.6 var(--mono); letter-spacing:.06em; text-transform:uppercase;
       border:1px solid var(--line); border-radius:99px; padding:0 7px; margin-left:6px; color:var(--dim); }
footer.report { margin-top:60px; padding-top:16px; border-top:1px solid var(--line); color:var(--faint); font:12px/1.6 var(--mono); }
@media print { html, body { background:#fff; color:#111; } main { max-width:none; } nav.toc { display:none; }
  code, pre.code { background:#f4f6f9; color:#111; border-color:#d6dce5; } th { color:#333; } }
`;

const tocHtml = () => {
  const parts = [];
  let inSub = false;
  for (let k = 0; k < toc.length; k += 1) {
    const t = toc[k];
    const next = toc[k + 1];
    if (t.depth === 2) {
      if (inSub) { parts.push("</ol></li>"); inSub = false; }
      parts.push(`<li><a href="#${t.id}">${esc(t.text.replace(/`/g, ""))}</a>`);
      if (next && next.depth === 3) parts.push('<ol class="sub">');
      else parts.push("</li>");
      continue;
    }
    parts.push(`<li><a href="#${t.id}">${esc(t.text.replace(/`/g, ""))}</a></li>`);
    inSub = true;
  }
  if (inSub) parts.push("</ol></li>");
  return parts.join("");
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${css}</style>
</head>
<body>
<main>
<header class="report">
<div class="row">agent-worktree-gui &middot; queue row 315 &middot; the code half</div>
<h1>${esc(title)}</h1>
<div class="meta">rendered from <code>${esc(notesPath.replace(/\\/g, "/"))}</code> by <code>tools/render-report-notes.mjs</code></div>
</header>
<nav class="toc"><div class="t">on this page</div><ol>${tocHtml()}</ol></nav>
${out.join("\n")}
<footer class="report">Read-only: no file under <code>public/</code> or <code>lib/</code> was changed for this page.</footer>
</main>
</body>
</html>
`;

writeFileSync(outPath, html, "utf8");
console.log(`${outPath}: ${html.length} bytes, ${toc.length} sections, from ${notesPath}`);
