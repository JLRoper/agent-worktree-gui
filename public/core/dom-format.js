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
  if (s.startsWith("UNMERGED")) return "unmerged";
  return "error";
}

// URLs in agent output become links. They are opened by the panel (POST /api/open-url) rather than by
// navigating, so a webview host cannot swallow the click and the link lands in the OS default browser.
const OUT_URL_RE = /https?:\/\/[^\s<>"'`\u001b]+/g;

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
  movementKey, orderRows, verdictClass, linkifyText, fmtBytes,
};
