// core/dom-format.js — the pure value→string and value→value helpers.
//
// Extracted from public/app.js as M2 in .agentboard/refactor-research/frontend-app-js.md (§2, §5 step 1),
// moved line for line: lines 255-371, 1049-1069 and 9525-9528 of public/app.js at ae528c7. Nothing was
// renamed, nothing was rewritten and no call site was touched.
//
// WHY A CLASSIC SCRIPT, LOADED FIRST
//
// The plan's mechanism for public/ is plain <script> tags plus one namespace object — no bundler, no module
// system. index.html loads this file BEFORE app.js, and every unit below is declared at the top level of it,
// so they are page globals by the time app.js runs: the exact bindings they were when they lived in that file
// (a top-level `function` was a property of window, a top-level `const` was a script-scoped global — the move
// keeps both).
//
// That is not a shortcut, it is the requirement. public/assistant.js (loaded after app.js, and untouched by
// this change) calls `esc()` by its bare name 72 times, and app.js has ~180 call sites into this file — `$`
// from 74 units, `esc` from 55, `keyOf` from 28. Keeping the names global is what makes the move
// behaviour-preserving; the namespace below is additive.
//
// WHAT IT STILL REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   normPath                  — tailPath
//   panelFor, isRowLive       — rowTier
//   state                     — isMainWorktree reads state.projects
//
// The plan records those three as this module's only back-edges (M2 → M5 ×2, M2 → M8 ×1). They are why it
// cannot be a leaf, and why `$` returning null on a missing id is the one trap to keep in mind: every call
// site assumes the element exists.

const $ = (id) => document.getElementById(id);
const keyOf = (project, p) => `${project}::${p}`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// A path as a card can afford to show it: forward slashes, and only the last few segments, prefixed
// with an ellipsis when there is more. The whole path lives in the element's tooltip.
function tailPath(p, keep = 3) {
  const parts = normPath(p).split("/").filter(Boolean);
  if (parts.length <= keep) return parts.join("/");
  return `…/${parts.slice(-keep).join("/")}`;
}

function relTime(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Precise duration for the life column: 1h24m12s, not "1h". Seconds matter there because the
// number is the whole point of the column.
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m${String(rs).padStart(2, "0")}s`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

// Coarse on purpose: "4h ago" answers "when did I last use this", and a per-second figure on a stale
// session would be noise. The exact moment is in the tooltip.
function fmtAgo(ts) {
  const t = typeof ts === "number" ? ts : Date.parse(String(ts || ""));
  if (!Number.isFinite(t) || t <= 0) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function elapsed(j) {
  if (!j.startedAt) return "—";
  const end = j.endedAt ? Date.parse(j.endedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(j.startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// Row order inside a project: work that is happening right now comes first. Our own running agents
// lead (that is the panel driving a process), then any other live session, then everything else
// newest-life-first — the worktree that showed signs of life most recently sits at the top.
function rowTier(row) {
  if (panelFor(row)?.running) return 0;
  if (isRowLive(row)) return 1;
  return 2;
}

function lifeAt(row) {
  const alive = Date.parse(row.lastAliveAt || "");
  return Number.isFinite(alive) ? alive : Number.NEGATIVE_INFINITY; // never alive sorts last
}

// What counts as an agent moving in a row. The cheap scan fields (verdict, age, git tip) are the
// scanner working, not the agent: a verdict flipping is not movement, and flashing green for it made
// every poll look like progress.
// The project's own checkout, on its main branch. Merges land here and a fast-forward rewrites file
// mtimes, which read exactly like an agent working in the main tree — it is how main kept flashing
// while the real work happened one directory down. Main rows therefore move on agent evidence
// (sessions, board entries, ports, cards) and on nothing else.
function isMainWorktree(project, row) {
  const main = state.projects.get(project)?.mainBranch;
  return Boolean(main && row.branch && row.branch === main);
}

function movementKey(row, { onMain = false } = {}) {
  const s = row.signals || {};
  const h = s.hermes || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cl = s.claude || {};
  const sessions = `${(h.titles || []).join("|")}#${num(h.running)}#${(cl.titles || []).join("|")}#${num(cl.running)}`;
  const idle = (h.idleList || []).map((x) => `${x.id}:${num(x.lastActivityAt)}`).join("|");
  const board = (s.board?.entries || []).map((e) => e.pid).join("|");
  const ports = (s.ports?.listening || []).join("|");
  // Only what a card is DOING, never how many cards there are: the count and the thread list are
  // omitted from some row events, so `0/0` flipping to `0/10` read as movement on every refresh and
  // every row pulsed green. A start is still movement; a bookkeeping total is not.
  const cards = num(s.panel?.running);
  const files = onMain ? "" : s.files?.at || "";
  return `${sessions}#${idle}#${board}#${ports}#${cards}#${files}`;
}

function orderRows(rows) {
  return rows.sort(
    (a, b) => rowTier(a) - rowTier(b) || lifeAt(b) - lifeAt(a) || String(a.name).localeCompare(String(b.name)),
  );
}

function verdictClass(v) {
  const s = String(v || "");
  if (s.startsWith("MERGED")) return "merged";
  if (s === "ON MAIN") return "onmain";
  if (s.startsWith("NO COMMITS") || s.startsWith("EMPTY REPO")) return "nocommits";
  if (s === "RELEASED") return "released";
  if (s.startsWith("UNMERGED")) return "unmerged";
  return "error";
}

// URLs in agent output become links. They are opened by the panel (POST /api/open-url) rather than by
// navigating, so a webview host cannot swallow the click and the link lands in the OS default browser.
const OUT_URL_RE = /https?:\/\/[^\s<>"'`\u001b]+/g;

// A LOCAL FILE PATH in agent output or in a question, made a link. Same reason as the URL: the panel opens it (the
// OS-registered browser, through lib/open-url.js) instead of the page navigating anywhere, and a path to a file the
// reader is meant to look at is otherwise something to copy out of the card and paste into an address bar.
//
// Three shapes, because those are the three an agent writes: a drive letter (a letter, a colon, a slash, forward or
// back), a POSIX absolute path (`/var/tmp/x.log`), or a relative one with at least one slash (`docs/reports/x.html`).
// Every shape must END in an extension - that is what keeps `and/or` and `24/7` and a bare `lib/` from becoming links
// - and a sentence's full stop lands outside the match because the greedy run is backtracked to the extension.
const OUT_FILE_RE =
  /(?:[A-Za-z]:[\\/][^\s<>"'`|]+|\/(?:[\w.@+-]+\/)*[\w.@+-]+|(?:\.{1,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]+)(?:\.[A-Za-z0-9]{1,8})(?:[?#][^\s<>"'`|]*)?/g;

// Trailing sentence punctuation belongs to the sentence, not to the link - `see docs/x.html.` is a link to
// `docs/x.html`. `)` and `]` are only trimmed when they are not balanced inside the target, which for a path means
// never: a path with a paren in it is rare and a path inside prose parens is not.
function trimLinkTail(raw) {
  let target = raw;
  let tail = "";
  while (target && /[.,;:!?'"]$/.test(target)) {
    tail = target.slice(-1) + tail;
    target = target.slice(0, -1);
  }
  return { target, tail };
}

// Does this look like something worth opening, or is it prose that happens to carry a slash? A URL has one of these
// already (linkifyText checks the host); a path is a path if its last segment has an extension, which the regex
// above already demanded. What is left is the false positive it cannot see: a version string (`v1.2.3/beta`) or a
// fraction with a dot after it. Both are short and carry no directory, so a relative path needs a real directory.
function plausiblePath(target) {
  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("/")) return true;
  const dir = target.split("/")[0] || "";
  return dir.length > 1 && /[A-Za-z]/.test(dir);
}

// The anchor for a local file: `data-open-file`, which the page's own handler turns into a POST to
// /api/open-file. No href: there is nothing for this page to navigate to, and a link with a dead href is one a
// middle-click opens onto an error.
function fileAnchor(target, { label = "", title = "" } = {}) {
  const name = label || target;
  return `<a class="out-file" href="#" data-open-file="${esc(target)}" title="${esc(title || `open ${target} in your browser`)}">${esc(name)}</a>`;
}

// The question text as the card draws it: URLs and paths both clickable, everything else escaped exactly as before.
// One pass with both patterns, in that order, because a URL contains slashes and a second pass over already-linked
// text would link the path inside the anchor it just made.
function linkifyCardText(text) {
  // Every anchor made here is STASHED before the next pass runs. A second pass over the page would otherwise see the
  // slashes inside `href="https://host/a.html"` and link a path inside the anchor it just wrote - the markup, not the
  // reader's text. The stash is one sentinel per anchor, restored at the end.
  const held = [];
  const stash = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let out = esc(text ?? "").replace(OUT_URL_RE, (raw) => {
    const { target, tail } = trimLinkTail(raw);
    const host = target.replace(/^https?:\/\//, "").split(/[/:?#]/)[0].toLowerCase();
    const plausible = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(".");
    if (!plausible) return raw;
    return stash(`<a class="out-link" href="${target}" target="_blank" rel="noreferrer noopener" data-open-url="${target}" title="open in your browser">${target}</a>`) + tail;
  });
  out = out.replace(OUT_FILE_RE, (raw) => {
    const { target, tail } = trimLinkTail(raw);
    if (!plausiblePath(target)) return raw;
    return stash(fileAnchor(target)) + tail;
  });
  // `null` as the sentinel must not survive as a stray digit if a stash index is ever wrong: an unmatched sentinel is
  // dropped, which reads as plain text rather than as markup.
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)] ?? "");
}

function linkifyText(text) {
  return esc(text ?? "").replace(OUT_URL_RE, (raw) => {
    let url = raw;
    let tail = "";
    // Sentence punctuation after a URL belongs to the sentence, not to the link.
    while (url && /[.,;:!?)\]]$/.test(url)) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    // Looks like a real host: a dotted name, an IP, or localhost — a dev agent prints
    // http://localhost:5173/ constantly, and that is exactly the link worth clicking.
    const host = url.replace(/^https?:\/\//, "").split(/[/:?#]/)[0].toLowerCase();
    const plausible = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(".");
    if (!plausible) return raw;
    return `<a class="out-link" href="${url}" target="_blank" rel="noreferrer noopener" data-open-url="${url}" title="open in your browser">${url}</a>${tail}`;
  });
}

function fmtBytes(n) {
  const bytes = Number(n) || 0;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

window.WMApp = window.WMApp || {};
window.WMApp.core = window.WMApp.core || {};
// Published for the later steps of the split, which reach a module through this object instead of
// through a new global. Nothing reads it yet: app.js still calls the bare names above.
window.WMApp.core.domFormat = {
  $, keyOf, esc, tailPath, relTime, fmtDur, fmtAgo, elapsed, rowTier, lifeAt, isMainWorktree,
  movementKey, orderRows, verdictClass, linkifyText, linkifyCardText, fileAnchor, fmtBytes,
};
