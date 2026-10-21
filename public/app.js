// Worktree Monitor client.
//   - worktree rows are patched individually from the SSE stream
//   - liveness is shown as labelled evidence chips (files / hermes / board / port)
//   - agents spawned from the "New agent" card stream their stdout live
const state = {
  projects: new Map(),
  rows: new Map(),
  expanded: new Set(),
  rowEls: new Map(),
  detailEls: new Map(),
  tbodyEls: new Map(),
  settings: {},
  spawn: {},
  paused: false,
  es: null,
  events: 0,
  eventsAt: 0,
  lastEventAt: null,
  pool: null,
  jobs: new Map(),
  jobLines: new Map(),
  replyDrafts: {},
  collapsedJobs: loadCollapsedJobs(),
  expandedProjects: loadExpandedProjects(),
  collapsedRoots: loadCollapsedRoots(),
  cloneStatus: {},
  approvals: new Map(),
  scanRoots: [],
  pollGap: new Map(), // key -> observed seconds between that row's scans, smoothed
  lastScanAt: new Map(), // key -> ms of the previous scan we rendered
  turnOpen: new Map(), // job id -> whether that turn's body is expanded (default: only the newest)
};

const $ = (id) => document.getElementById(id);
const keyOf = (project, p) => `${project}::${p}`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

function elapsed(j) {
  if (!j.startedAt) return "—";
  const end = j.endedAt ? Date.parse(j.endedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(j.startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function rank(w) {
  const v = String(w.verdict || "");
  if (v.startsWith("UNMERGED")) return 0;
  if (w.dirty || w.untracked) return 1;
  if (v.startsWith("MERGED") || v.startsWith("NO COMMITS") || v.startsWith("EMPTY REPO")) return 2;
  if (v === "ON MAIN") return 3;
  return 4;
}

function verdictClass(v) {
  const s = String(v || "");
  if (s.startsWith("MERGED")) return "merged";
  if (s === "ON MAIN") return "onmain";
  if (s.startsWith("NO COMMITS") || s.startsWith("EMPTY REPO")) return "nocommits";
  if (s.startsWith("UNMERGED")) return "unmerged";
  return "error";
}

// ---------------- agents ----------------
function jobLines(id) {
  return state.jobLines.get(id) || [];
}

// ---- minimize / expand a card -----------------------------------------------
// Folding is per-card and remembered in localStorage, so a refresh (or the 30s
// resync, which rebuilds every card) does not spring everything back open.
function loadCollapsedJobs() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.collapsedJobs") || "[]"));
  } catch {
    return new Set();
  }
}

function saveCollapsedJobs() {
  try {
    localStorage.setItem("wm.collapsedJobs", JSON.stringify([...state.collapsedJobs]));
  } catch {
    /* no storage available: folding just won't survive a reload */
  }
}

// Each project section is minimized to its title line by default; the ones you opened are
// remembered, so a reload (or the 30s resync, which rebuilds every section) keeps your layout.
function loadExpandedProjects() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.expandedProjects") || "[]"));
  } catch {
    return new Set();
  }
}

function saveExpandedProjects() {
  try {
    localStorage.setItem("wm.expandedProjects", JSON.stringify([...state.expandedProjects]));
  } catch {
    /* no storage: the choice simply will not persist */
  }
}

function toggleProject(name) {
  if (!name) return;
  if (state.expandedProjects.has(name)) state.expandedProjects.delete(name);
  else state.expandedProjects.add(name);
  saveExpandedProjects();
  applyProjectCollapse(name);
  // Keep the folder's collapse-all button honest when projects are opened one by one.
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  const root = sec?.closest("section.root-group")?.dataset.root;
  if (root) paintRootButton(root);
}

// ---- folder layer ------------------------------------------------------------
// Projects are wrapped in one accordion per folder: `scanRoots` entries, plus a sibling folder
// group for any project that is NOT actually inside a root (an explicit `projects[]` entry can
// point anywhere, and a repo outside every root must not be shown under one).
function loadCollapsedRoots() {
  try {
    return new Set(JSON.parse(localStorage.getItem("wm.collapsedRoots") || "[]"));
  } catch {
    return new Set();
  }
}

function saveCollapsedRoots() {
  try {
    localStorage.setItem("wm.collapsedRoots", JSON.stringify([...state.collapsedRoots]));
  } catch {
    /* no storage: the choice simply will not persist */
  }
}

const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");

// Longest matching scan root wins, so a nested root groups under the more specific folder.
// No match means the project lives outside every root: group it under its own parent folder.
function rootOf(project) {
  const raw = normPath(project.path);
  const lower = raw.toLowerCase();
  if (!lower) return "(unknown folder)";
  const roots = (state.scanRoots || []).map(normPath).filter(Boolean);
  const match = roots
    .filter((r) => lower === r.toLowerCase() || lower.startsWith(`${r.toLowerCase()}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return match;
  const cut = raw.lastIndexOf("/");
  return cut > 0 ? raw.slice(0, cut) : raw;
}

// `C:/ProjectDevelopment` reads as `C:\ProjectDevelopment\` in the header — that is the folder
// the user recognises — while a posix path keeps its slashes.
function labelRoot(root) {
  const r = String(root || "");
  if (/^[A-Za-z]:\//.test(r)) return `${r.replace(/\//g, "\\")}\\`;
  return r.endsWith("/") ? r : `${r}/`;
}

function toggleRoot(root) {
  if (!root) return;
  if (state.collapsedRoots.has(root)) state.collapsedRoots.delete(root);
  else state.collapsedRoots.add(root);
  saveCollapsedRoots();
  applyRootCollapse(root);
}

function applyRootCollapse(root) {
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  if (!sec) return;
  const open = !state.collapsedRoots.has(root);
  sec.classList.toggle("collapsed", !open);
  const head = sec.querySelector(".root-head[data-toggle-root]");
  if (head) {
    head.title = `${open ? "collapse" : "expand"} ${labelRoot(root)}`;
    const chev = head.querySelector(".chev");
    if (chev) chev.textContent = open ? "\u25be" : "\u25b8";
  }
}

// ---- collapse-all inside one folder -------------------------------------------
// One button per folder that opens or closes every project section it holds, without touching
// the folder itself. The label follows what is actually on screen: "Collapse all" while any
// project in the folder is open, "Expand all" once none are.
function paintRootButton(root) {
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  const btn = sec?.querySelector("[data-root-collapse]");
  if (!btn) return;
  const names = [...sec.querySelectorAll("section.project")].map((s) => s.dataset.project);
  const anyOpen = names.some((n) => state.expandedProjects.has(n));
  btn.textContent = anyOpen ? "Collapse all" : "Expand all";
  btn.title = `${anyOpen ? "collapse" : "expand"} every project in ${labelRoot(root)} (${names.length})`;
}

function toggleAllInRoot(root) {
  if (!root) return;
  const sec = document.querySelector(`section.root-group[data-root="${CSS.escape(root)}"]`);
  if (!sec) return;
  const names = [...sec.querySelectorAll("section.project")].map((s) => s.dataset.project);
  if (!names.length) return;
  const collapse = names.some((n) => state.expandedProjects.has(n));
  for (const n of names) {
    if (collapse) state.expandedProjects.delete(n);
    else state.expandedProjects.add(n);
  }
  saveExpandedProjects();
  for (const n of names) applyProjectCollapse(n);
  paintRootButton(root);
}

// ---- clone a repo into a folder ------------------------------------------------
// The "+" in a folder header opens this row. The root is fixed to the folder you clicked, so a
// clone can only ever land inside a configured scan root, and the server re-checks that.
function showCloneForm(root, show = true) {
  const form = document.querySelector(`[data-clone-form="${CSS.escape(root)}"]`);
  if (!form) return;
  form.hidden = !show;
  if (show) form.querySelector("[data-clone-input]")?.focus();
}

async function cloneIntoRoot(root) {
  const form = document.querySelector(`[data-clone-form="${CSS.escape(root)}"]`);
  if (!form) return;
  const input = form.querySelector("[data-clone-input]");
  const btn = form.querySelector("[data-clone-go]");
  const name = String(input?.value || "").trim();

  // Status lives in state, not only in the DOM: a snapshot re-renders every folder section, and
  // an inline-only message was wiped a couple of seconds after the clone finished.
  const setStatus = (text, kind = "busy") => {
    state.cloneStatus[root] = { text, kind };
    const span = document.querySelector(`[data-clone-form="${CSS.escape(root)}"] [data-clone-msg]`);
    if (span) {
      span.textContent = text;
      span.classList.toggle("clone-err", kind === "err");
    }
  };

  if (!name) {
    input?.focus();
    return;
  }
  btn.disabled = true;
  setStatus("cloning over ssh…");
  try {
    const res = await fetch("/api/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, name }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(j.error || `HTTP ${res.status}`, "err");
      return;
    }
    setStatus(`cloned → ${j.dest} (${Math.round((j.tookMs || 0) / 1000)}s, ${j.url})`, "ok");
    if (input) input.value = "";
    // Discovery re-runs server-side and broadcasts a snapshot when it is done; this second
    // resync covers a missed event so the new project appears without waiting for the timer.
    setTimeout(() => void resync(), 2000);
  } catch (e) {
    setStatus(`failed: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
}

// Toggle the class in place rather than re-rendering: the rows stay painted underneath, so
// expanding is instant and a collapse costs no DOM churn.
function applyProjectCollapse(name) {
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  if (!sec) return;
  const open = state.expandedProjects.has(name);
  sec.classList.toggle("collapsed", !open);
  const head = sec.querySelector(".project-head[data-toggle-project]");
  if (head) {
    head.title = `${open ? "minimize" : "expand"} ${name}`;
    const chev = head.querySelector(".chev");
    if (chev) chev.textContent = open ? "\u25be" : "\u25b8";
  }
}

function toggleJob(id) {
  if (!id) return;
  if (state.collapsedJobs.has(id)) state.collapsedJobs.delete(id);
  else state.collapsedJobs.add(id);
  saveCollapsedJobs();
  renderConversation(id);
}

function foldAll(collapsed) {
  for (const c of conversations()) {
    if (collapsed) state.collapsedJobs.add(c.thread);
    else state.collapsedJobs.delete(c.thread);
  }
  saveCollapsedJobs();
  renderJobs();
}

// One-line summary shown while a card is minimized: the newest prose the agent
// wrote (its last thought, or the final answer once it is done), falling back to
// the newest thing it did.
function jobPreview(j) {
  const lines = jobLines(j.id);
  const from = Math.max(0, lines.length - 40);
  let fallback = null;
  for (let i = lines.length - 1; i >= from; i--) {
    const t = String(lines[i].text || "").replace(/\s+/g, " ").trim();
    if (!t || lines[i].kind === "cmd" || lines[i].kind === "dim") continue;
    if (lines[i].kind === "text") return t.slice(-150);
    if (!fallback) fallback = t.slice(-150);
  }
  if (fallback) return fallback;
  return j.status === "running" || j.status === "starting" ? "starting…" : "no output";
}

function refreshJobPreview(id) {
  const j = state.jobs.get(id);
  if (!j) return;
  const el = document.querySelector(`[data-preview="${CSS.escape(j.thread || j.id)}"]`);
  if (el) el.textContent = jobPreview(j);
}

// ---- conversations ------------------------------------------------------------
// Every turn of one thread is a separate CLI process, but they are one conversation: group
// them so the card reads top to bottom and the reply box continues the same session.
function conversations() {
  const groups = new Map();
  for (const j of state.jobs.values()) {
    const key = j.thread || j.id;
    const arr = groups.get(key) || [];
    arr.push(j);
    groups.set(key, arr);
  }
  const out = [];
  for (const [thread, turns] of groups) {
    turns.sort((a, b) => (a.turn || 1) - (b.turn || 1) || String(a.startedAt).localeCompare(String(b.startedAt)));
    out.push({ thread, turns, first: turns[0], latest: turns[turns.length - 1] });
  }
  out.sort((a, b) => String(b.latest.startedAt).localeCompare(String(a.latest.startedAt)));
  return out;
}

function turnBody(turn) {
  const body = jobLines(turn.id)
    .slice(-300)
    .map((l) => `<div class="jl jl-${esc(l.kind || "raw")}" data-lid="${esc(l.lid ?? "")}">${esc(l.text ?? "")}</div>`)
    .join("") || '<div class="jl jl-dim">waiting for output…</div>';
  return `<pre class="job-out" data-out="${esc(turn.id)}">${body}</pre>`;
}

// A turn is open when the reader opened it, otherwise only the newest turn is: opening an agent
// shows its current turn in full and lists the earlier ones as the single request line each.
function turnIsOpen(conv, turn) {
  const forced = state.turnOpen.get(turn.id);
  if (forced !== undefined) return forced;
  return turn.id === conv.latest.id;
}

function toggleTurn(id) {
  const turn = state.jobs.get(id);
  if (!turn) return;
  const conv = conversations().find((c) => c.thread === (turn.thread || turn.id));
  if (!conv) return;
  state.turnOpen.set(id, !turnIsOpen(conv, turn));
  renderConversation(conv.thread);
}

function turnHead(turn, index, open) {
  const label = `turn ${turn.turn || index + 1}`;
  const state_ =
    turn.status === "running" || turn.status === "starting"
      ? `running ${elapsed(turn)}`
      : `${turn.status} · ${elapsed(turn)}${turn.tokens?.total ? ` · ${turn.tokens.total} tok` : ""}`;
  return `<div class="turn-head mono dimmer" data-turn-head="${esc(turn.id)}" data-toggle-turn="${esc(turn.id)}" title="${open ? "collapse" : "expand"} this turn"><span class="chev">${open ? "\u25be" : "\u25b8"}</span> ${esc(label)} · ${esc(state_)}</div>`;
}

// One turn: its head, then either the full prompt + output, or a single line carrying the request
// that turn was about. The one-line form is what makes a long conversation readable.
function turnBlock(conv, turn, index) {
  const open = turnIsOpen(conv, turn);
  if (!open) {
    return `<div class="turn folded" data-turn="${esc(turn.id)}">${turnHead(turn, index, false)}` +
      `<div class="turn-prompt" data-toggle-turn="${esc(turn.id)}" title="${esc(turn.prompt || "")}">${esc(turn.prompt || "(no prompt recorded)")}</div></div>`;
  }
  return `<div class="turn" data-turn="${esc(turn.id)}">${turnHead(turn, index, true)}` +
    `<div class="job-prompt">${esc(turn.prompt || "")}</div>${turnBody(turn)}</div>`;
}

function conversationHtml(conv) {
  const { thread, turns, latest } = conv;
  const collapsed = state.collapsedJobs.has(thread);
  const runningTurn = turns.find((t) => t.status === "running" || t.status === "starting");
  const running = Boolean(runningTurn);
  const meta = [
    latest.pid ? `pid ${latest.pid}` : null,
    latest.cwd ? `cwd ${latest.cwd}` : null,
    latest.model ? `model ${latest.model}` : "(default model)",
    latest.worktree ? `worktree ${latest.worktree}` : null,
    latest.existing ? "in existing worktree" : null,
    turns.length > 1 ? `${turns.length} turns` : null,
  ].filter(Boolean).join(" · ");
  const foot = latest.status === "running" || latest.status === "starting"
    ? `<span class="dimmer mono">running ${esc(elapsed(latest))}</span>`
    : `<span class="mono dim">exit ${latest.exitCode ?? "?"} · ${esc(elapsed(latest))}${latest.tokens?.total ? ` · tokens ${latest.tokens.total}` : ""}${latest.error ? ` · ${esc(latest.error)}` : ""}</span>`;
  const blocks = turns.map((t, i) => turnBlock(conv, t, i)).join("");
  return `<div class="job${collapsed ? " collapsed" : ""}" data-thread="${esc(thread)}" data-id="${esc(thread)}">
    <div class="job-head" data-toggle="${esc(thread)}" title="${collapsed ? "expand" : "minimize"} this conversation">
      <span class="chev">${collapsed ? "\u25b8" : "\u25be"}</span>
      <span class="pill ${esc(latest.status)}">${esc(latest.status)}</span>
      <span class="mono dim">${esc(meta)}</span>
      <span class="spacer"></span>
      <span class="mono dimmer thread-name" title="Hermes session thread — continue it any time">${esc(thread)}</span>
      ${latest.yolo ? '<span class="pill yolo">--yolo</span>' : ""}
      ${running ? `<button class="btn-cancel" data-id="${esc(runningTurn.id)}" type="button">Cancel</button>` : ""}
    </div>
    ${collapsed ? `<div class="job-preview mono" data-preview="${esc(thread)}">${esc(jobPreview(latest))}</div>` : ""}
    <div class="job-body">
      ${blocks}
      <div class="job-foot">${foot}</div>
      <div class="reply">
        <textarea class="reply-box" data-reply="${esc(thread)}" rows="2" spellcheck="false"
          placeholder="${running ? "a turn is still running — a reply queues another one" : "Reply to this agent — continues the same Hermes thread, Enter to send"}"></textarea>
        <div class="reply-row">
          <span class="warnline" data-reply-warn="${esc(thread)}"></span>
          <span class="spacer"></span>
          <button class="btn-reply" data-thread="${esc(thread)}" type="button">Send reply</button>
        </div>
      </div>
    </div>
  </div>`;
}

function restoreReplyDraft(thread) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  if (box && state.replyDrafts[thread]) box.value = state.replyDrafts[thread];
}

async function sendReply(thread) {
  const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
  const text = (box?.value || "").trim();
  if (!text) return;
  const btn = document.querySelector(`.btn-reply[data-thread="${CSS.escape(thread)}"]`);
  if (btn) btn.disabled = true;
  try {
    const r = await fetch("/api/agents/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread, text }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    state.replyDrafts[thread] = "";
    if (box) box.value = "";
    updateJob(d.job, { scroll: true });
  } catch (err) {
    const warn = document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`);
    if (warn) warn.textContent = `reply failed: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function jobHtml(j) {
  return conversationHtml({ thread: j.thread || j.id, turns: [j], first: j, latest: j });
}

// ---- approvals ------------------------------------------------------------------
// Requests arrive from the Hermes approval-transport plugin (~/.hermes/plugins/worktree-panel).
// This only records the human's choice: Hermes owns the policy, the timeout and the fail-closed
// behaviour, and a request that expires here is denied there.
const APPROVAL_LABEL = { once: "Allow once", session: "Allow for session", always: "Always allow", deny: "Deny" };

function approvalCard(r) {
  const left = Math.max(0, Math.round(((r.deadline || 0) - Date.now()) / 1000));
  const buttons = (r.allowed || ["once", "deny"])
    .map((c) => {
      const cls = c === "deny" ? "" : c === "once" ? ' class="primary"' : "";
      return `<button type="button"${cls} data-approval-id="${esc(r.id)}" data-approval-choice="${esc(c)}">${esc(APPROVAL_LABEL[c] || c)}</button>`;
    })
    .join("");
  return `<div class="approval" data-approval="${esc(r.id)}">
    <div class="ap-head"><span class="mono dim">${esc(r.surface || "agent")}</span><span class="spacer"></span><span class="mono ${left < 20 ? "warn" : "dimmer"}" data-approval-left="${esc(r.id)}">expires in ${left}s</span></div>
    <pre class="ap-cmd mono">${esc(r.command || "(no command text)")}</pre>
    ${r.description ? `<div class="ap-desc dim">${esc(r.description)}</div>` : ""}
    <div class="ap-actions">${buttons}<span class="ap-err mono"></span></div>
  </div>`;
}

function renderApprovals() {
  const sec = $("approvals");
  if (!sec) return;
  const list = [...state.approvals.values()].sort((a, b) => (a.deadline || 0) - (b.deadline || 0));
  sec.hidden = list.length === 0;
  if (!list.length) {
    $("approval-list").innerHTML = "";
    return;
  }
  $("approval-chips").innerHTML = `<span class="chip bad">${list.length} waiting</span>`;
  $("approval-list").innerHTML = list.map(approvalCard).join("");
}

function tickApprovals() {
  for (const r of state.approvals.values()) {
    const el = document.querySelector(`[data-approval-left="${CSS.escape(r.id)}"]`);
    if (!el) continue;
    const left = Math.max(0, Math.round(((r.deadline || 0) - Date.now()) / 1000));
    el.textContent = left ? `expires in ${left}s` : "expired";
    el.classList.toggle("warn", left < 20);
  }
}
setInterval(tickApprovals, 1000);

async function answerApproval(id, choice, btn) {
  const card = btn?.closest(".approval");
  const err = card?.querySelector(".ap-err");
  card?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  if (err) err.textContent = "";
  try {
    const res = await fetch("/api/approvals/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, choice }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (err) err.textContent = j.error || `HTTP ${res.status}`;
      card?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  } catch (e) {
    if (err) err.textContent = e.message;
    card?.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

function renderJobs() {
  const convs = conversations();
  for (const id of [...state.collapsedJobs]) if (!convs.some((c) => c.thread === id)) state.collapsedJobs.delete(id);
  // Forgetting a cleared job's explicit turn state keeps the map from growing forever.
  const live = new Set([...state.jobs.keys()]);
  for (const id of [...state.turnOpen.keys()]) if (!live.has(id)) state.turnOpen.delete(id);
  $("jobs").innerHTML = convs.length ? convs.map(conversationHtml).join("") : '<p class="empty">No agents started from here yet.</p>';
  for (const c of convs) restoreReplyDraft(c.thread);
  const running = convs.filter((c) => c.turns.some((t) => t.status === "running" || t.status === "starting")).length;
  const folded = convs.filter((c) => state.collapsedJobs.has(c.thread)).length;
  const turns = [...state.jobs.values()].length;
  $("agents-chips").innerHTML =
    `<span class="chip">${convs.length} conversation${convs.length === 1 ? "" : "s"}</span>` +
    (turns > convs.length ? `<span class="chip">${turns} turns</span>` : "") +
    (running ? `<span class="chip warn">${running} running</span>` : "") +
    (folded ? `<span class="chip">${folded} minimized</span>` : "");
  const fold = $("btn-fold-jobs");
  if (fold) fold.textContent = convs.length && folded === convs.length ? "Expand all" : "Minimize all";
}

function updateJob(j, { scroll = false } = {}) {
  const prev = state.jobs.get(j.id);
  const statusChanged = !prev || prev.status !== j.status;
  state.jobs.set(j.id, { ...prev, ...j });
  if (!state.jobLines.has(j.id) && j.lines?.length) state.jobLines.set(j.id, j.lines.slice());
  renderConversation(j.thread || j.id, { scroll });
  // Starting or finishing a turn changes what the worktree rows should say about themselves.
  if (statusChanged) repaintAgentState();
}

function renderConversation(thread, { scroll = false } = {}) {
  const conv = conversations().find((c) => c.thread === thread);
  const el = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!conv) return renderJobs();
  const holder = document.createElement("div");
  holder.innerHTML = conversationHtml(conv);
  const fresh = holder.firstElementChild;
  if (!el) return renderJobs();
  el.replaceWith(fresh);
  restoreReplyDraft(thread);
  const out = fresh.querySelector(`pre[data-out="${CSS.escape(conv.latest.id)}"]`);
  if (out && (scroll || conv.latest.status === "running")) out.scrollTop = out.scrollHeight;
}

function appendJobLine(evt) {
  const line = evt.line || {};
  const buf = state.jobLines.get(evt.id) || [];
  // mode "set" = the agent is still writing the same paragraph; that line grows in place
  // instead of a new one being pushed for every streamed fragment.
  const at = line.lid ? buf.findIndex((l) => l.lid === line.lid) : -1;
  if (line.mode === "set" && at >= 0) buf[at] = { ...buf[at], ...line };
  else buf.push(line);
  if (buf.length > 1000) buf.splice(0, buf.length - 1000);
  state.jobLines.set(evt.id, buf);
  const out = document.querySelector(`pre[data-out="${CSS.escape(evt.id)}"]`);
  if (!out) return;
  if (out.firstElementChild?.classList.contains("jl-dim")) out.innerHTML = "";
  if (line.mode === "set") {
    const el = out.querySelector(`[data-lid="${line.lid}"]`);
    if (el) {
      el.textContent = line.text ?? "";
      out.scrollTop = out.scrollHeight;
      refreshJobPreview(evt.id);
      return;
    }
  }
  const div = document.createElement("div");
  div.className = `jl jl-${line.kind || "raw"}`;
  if (line.lid) div.dataset.lid = line.lid;
  div.textContent = line.text ?? "";
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
  refreshJobPreview(evt.id);
}

async function preview() {
  const body = formValues();
  try {
    const r = await fetch("/api/agents/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    $("job-cmd").textContent = `cwd ${d.cwd}\n${d.command}`;
    $("job-cmd").classList.remove("dimmer");
  } catch (e) {
    $("job-cmd").textContent = `preview failed: ${e.message}`;
  }
}

async function spawnAgent() {
  const body = formValues();
  if (!body.prompt.trim()) {
    $("spawn-msg").textContent = "a prompt is required";
    return;
  }
  $("btn-spawn").disabled = true;
  try {
    const r = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    $("spawn-msg").textContent = `spawned ${d.job.id} (pid ${d.job.pid})${d.job.yolo ? " with --yolo" : ""}`;
    updateJob(d.job, { scroll: true });
  } catch (e) {
    $("spawn-msg").textContent = `spawn failed: ${e.message}`;
  } finally {
    $("btn-spawn").disabled = false;
  }
}

// The spawn target: one entry per discovered project, most recently worked on first.
function syncProjectPicker(projects) {
  const sel = $("job-project");
  const keep = sel.value;
  sel.innerHTML = projects.length
    ? projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.activityAt ? ` · ${relTime(p.activityAt)}` : ""}</option>`).join("")
    : '<option value="">(no projects)</option>';
  if (keep && projects.some((p) => p.name === keep)) sel.value = keep;
  // The startup location is a plain editable field; keep suggestions and the default in step.
  const dl = $("project-paths");
  if (dl) dl.innerHTML = projects.map((p) => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join("");
  const cur = selectedProject();
  if (cur && !$("job-cwd").value.trim()) $("job-cwd").value = cur.path;
  updateSpawnNote();
}

function selectedProject() {
  const name = $("job-project").value;
  return (state.spawn.projects || []).find((p) => p.name === name) || null;
}

function updateSpawnNote() {
  const p = selectedProject();
  const cwd = $("job-cwd").value.trim();
  const where = cwd || p?.path || state.spawn.defaultCwd || "?";
  const custom = Boolean(cwd) && Boolean(p) && cwd !== p.path;
  const existing = $("job-existing").checked;
  $("spawn-note").textContent = existing
    ? `hermes chat — runs IN ${where} (no new worktree${state.spawnTarget ? ` · ${state.spawnTarget}` : ""}); edits land in that tree`
    : `hermes chat -w — worktree under ${where}\\.worktrees\\` +
      (custom ? " · custom location (differs from the selected project)" : ` · project ${p ? p.name : "(none)"}`);
  // A repo with no commits has no HEAD to branch from, so -w cannot create a worktree in it.
  const emptyRepo = Boolean(p) && Boolean(p.empty) && (!cwd || cwd === p.path);
  const warn = $("spawn-warn");
  warn.textContent = emptyRepo
    ? `${p.name} has no commits yet (unborn HEAD), so hermes -w cannot create a worktree there. ` +
      `Make an initial commit first, e.g. in ${p.path}: git add -A && git commit -m "initial commit"`
    : "";
  $("btn-spawn").disabled = emptyRepo;
}

// The per-worktree "\u25b6": run an agent INSIDE that existing worktree (no new tree at all).
function focusSpawnForWorktree(path, name) {
  $("job-cwd").value = path;
  $("job-existing").checked = true;
  state.spawnTarget = name || null;
  updateSpawnNote();
  const card = $("newagent");
  card.classList.add("armed");
  setTimeout(() => card.classList.remove("armed"), 1400);
  card.scrollIntoView({ block: "start", behavior: "smooth" });
  $("job-prompt").focus();
}

// The green "+": aim the spawn card at that project and put the cursor in the prompt.
function focusSpawn(projectName) {
  if (projectName) {
    const p = (state.spawn.projects || []).find((x) => x.name === projectName);
    $("job-project").value = projectName;
    // The green "+" is the "start work here" gesture: point the location field at that project.
    if (p) $("job-cwd").value = p.path;
    // ...and that means a NEW worktree in that project, not the project folder itself.
    $("job-existing").checked = false;
    state.spawnTarget = null;
    updateSpawnNote();
  }
  const card = $("newagent");
  card.classList.add("armed");
  setTimeout(() => card.classList.remove("armed"), 1400);
  card.scrollIntoView({ block: "start", behavior: "smooth" });
  $("job-prompt").focus();
}

function formValues() {
  return {
    prompt: $("job-prompt").value,
    // An explicitly edited location wins over the project picker (the server prefers `cwd`).
    cwd: $("job-cwd").value.trim() || undefined,
    // true = run in that directory as-is (an existing worktree), no new worktree created.
    existing: $("job-existing").checked,
    project: $("job-project").value || undefined,
    model: $("job-model").value.trim() || undefined,
    budget: Number($("job-budget").value) || undefined,
    maxTurns: Number($("job-maxTurns").value) || undefined,
    skills: $("job-skills").value.trim() || undefined,
    yolo: $("job-yolo").checked,
  };
}

// ---------------- worktrees ----------------
// The panel's own agents, mapped to the worktree they work in. Rendered straight from the job
// list so a just-started agent shows up immediately, without waiting for the next scan.
function panelAgentsByPath() {
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const map = new Map();
  const add = (p, j) => {
    if (!p) return;
    const k = norm(p);
    const cur = map.get(k) || { running: 0, total: 0, threads: [] };
    cur.total += 1;
    if (j.status === "running" || j.status === "starting") cur.running += 1;
    if (!cur.threads.includes(j.thread)) cur.threads.push(j.thread);
    map.set(k, cur);
  };
  for (const j of state.jobs.values()) {
    if (j.existing || j.reply) add(j.cwd, j);
    if (j.worktreePath) add(j.worktreePath, j);
  }
  return map;
}

// Jump from a worktree row to the agent card it belongs to.
function jumpToAgent(thread) {
  if (!thread) return;
  if (state.collapsedJobs.has(thread)) {
    state.collapsedJobs.delete(thread);
    saveCollapsedJobs();
    renderConversation(thread);
  }
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) {
    $("jobs").scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.add("jump");
  setTimeout(() => card.classList.remove("jump"), 1700);
}

// The panel's own agents are the freshest evidence there is — we are literally driving the process
// — so the chip and the row's liveness must follow the job list, not the last git scan. The map is
// memoized per job change because sigChips runs once per row.
let panelMapCache = null;
function panelMap() {
  if (!panelMapCache) panelMapCache = panelAgentsByPath();
  return panelMapCache;
}
function invalidatePanelMap() {
  panelMapCache = null;
}
function panelFor(row) {
  return panelMap().get(normPath(row.path).toLowerCase()) || null;
}
// A row is live if a signal fired OR one of our agents is running in it right now.
function isRowLive(row) {
  return Boolean(row.live) || Boolean(panelFor(row)?.running);
}

function sigChips(row) {
  const s = row.signals || {};
  const out = [];
  if (s.hermes?.on) out.push(`<span class="sig sig-hermes" title="Hermes session active in this worktree: ${esc((s.hermes.titles || []).join(' · '))}">⧉ hermes</span>`);
  if (s.board?.on) out.push(`<span class="sig sig-board" title="board entry, PID alive now: ${esc((s.board.entries || []).map((e) => e.pid).join(', '))}">● board</span>`);
  if (s.ports?.on) out.push(`<span class="sig sig-port" title="dev server listening: ${esc((s.ports.listening || []).join(', '))}">:${esc((s.ports.listening || []).join(' :'))}</span>`);
  if (s.files?.on) out.push(`<span class="sig sig-files" title="files edited ${relTime(s.files.at)} ago">✎ files</span>`);
  const panel = panelFor(row);
  if (panel) {
    const t = panel.threads[0];
    out.push(
      `<button class="sig ${panel.running ? "sig-panel" : "sig-panel-done"}" data-agent-thread="${esc(t)}" ` +
        `title="${panel.running ? `a Hermes agent you started here is running in this worktree right now` : `the agent you started here is between turns (nothing running)`} · ${esc(t)} — click to jump to it">` +
        `⧉ panel${panel.running ? " running" : " (done)"}</button>`,
    );
  }
  if (!out.length && row.idle) out.push(`<span class="sig sig-idle" title="a Hermes session is open here but idle — not counted as live">⧉ ${s.hermes?.idle ?? 1} idle</span>`);
  return out.join("");
}

// Repaint only the chip strip of one row, so a turn starting/finishing lands instantly instead of
// waiting for that row's next scan (which can be 45-90s away).
function paintRowChips(row) {
  const cell = document.querySelector(`td.age[data-key="${CSS.escape(keyOf(row.project, row.path))}"]`);
  const holder = cell?.querySelector(".sigs");
  if (!holder) return;
  const html = sigChips(row);
  if (holder.innerHTML !== html) holder.innerHTML = html;
}

function repaintAgentState() {
  invalidatePanelMap();
  for (const row of state.rows.values()) paintRowChips(row);
  for (const name of state.projects.keys()) refreshChips(name);
}

function livenessLines(row) {
  const s = row.signals || {};
  const lines = [];
  if (s.hermes?.on) lines.push(`Hermes session active here: ${(s.hermes.titles || []).map((t) => `"${t}"`).join(" · ")}`);
  else if (s.hermes?.idle) lines.push(`Hermes session open here but idle (${s.hermes.idle})`);
  if (s.board?.on) lines.push(`Board: PID ${(s.board.entries || []).map((e) => e.pid).join(", ")} — alive now`);
  else if (s.board?.dead) lines.push(`Board: ${s.board.dead} entr${s.board.dead === 1 ? "y" : "ies"}, none with a live PID`);
  if (s.ports?.on) lines.push(`Dev server: :${(s.ports.listening || []).join(", ")} listening`);
  else if (s.ports?.declared?.length) lines.push(`Dev server: declared :${(s.ports.declared || []).join(", ")} — nothing listening`);
  if (s.files?.on) lines.push(`Files edited ${relTime(s.files.at)} ago`);
  lines.push(row.live ? `Verdict: live via ${row.liveWhy || "?"}` : "Verdict: not live — no session, board entry or listening port");
  return lines;
}

function rowHtml(row) {
  const isOpen = state.expanded.has(keyOf(row.project, row.path));
  const dirty =
    row.dirty || row.untracked
      ? `<span class="dirty">${row.dirty}</span>${row.untracked ? ` <span class="dimmer">+${row.untracked}?</span>` : ""}`
      : `<span class="clean">clean</span>`;
  const pr = row.pr
    ? `<span class="${row.pr.state === "OPEN" ? "pr-open" : "pr-merged"}" title="${esc(row.pr.title || "")}">#${row.pr.number} ${esc(row.pr.state)}</span>`
    : row.remoteBranch === "gone"
      ? `<span class="dimmer">none · branch gone</span>`
      : `<span class="dimmer">none</span>`;
  const badge = `<span class="badge ${verdictClass(row.verdict)}${row.verdictStale ? " stale" : ""}">${esc(row.verdict)}</span>`;
  return `<tr class="row${isOpen ? " expanded" : ""}" data-key="${esc(keyOf(row.project, row.path))}">
    <td class="name"><button class="btn-row-agent" data-agent-path="${esc(row.path)}" data-agent-name="${esc(row.name)}"
      title="start a Hermes agent in this worktree — it runs here (no new worktree)">\u25b6</button> <span>${esc(row.name)}</span></td>
    <td class="mono branch">${esc(row.branch || "—")}</td>
    <td class="mono dim nowrap">${esc(row.head || "—")}</td>
    <td class="mono nowrap">${row.ahead === null ? "—" : `<span class="${row.ahead ? "dirty" : "dimmer"}">${row.ahead}</span> / ${row.behind ?? "—"}`}</td>
    <td class="mono dim nowrap">+${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}</td>
    <td>${pr}</td>
    <td class="mono nowrap">${dirty}</td>
    ${ageCellHtml(row)}
    <td>${badge}</td>
  </tr>`;
}

// ---- the age column: last life seen, plus a ring that drains to the next read ----------------
// The number is NOT "time since last poll" (that is the ring): it is the last moment any liveness
// evidence fired for this worktree. The ring empties when the row is due for its next read.
//
// The cadence the server sends is what the scheduler WOULD apply; when the panel is behind (a big
// fleet, a slow repo) the real gap is longer, so the ring is sized to the observed gap once we
// have one -- otherwise it empties 30s in and then sits empty for a minute, which reads as broken.
const RING_C = 2 * Math.PI * 6;

function noteScan(row) {
  const key = keyOf(row.project, row.path);
  const t = Date.parse(row.scannedAt || "");
  if (!Number.isFinite(t)) return;
  const configured = Math.max(1, Number(row.pollSeconds || state.settings.worktreeSeconds || 5));
  const prev = state.lastScanAt.get(key);
  if (Number.isFinite(prev) && t > prev) {
    const gap = (t - prev) / 1000;
    // A 30s resync can be the first time we see two scans of a 5s row; that gap (30s) says nothing
    // about how often the row is really read, so only gaps inside a sane multiple are believed.
    if (gap > 0 && gap <= configured * 4) {
      const smoothed = state.pollGap.has(key) ? state.pollGap.get(key) * 0.6 + gap * 0.4 : gap;
      state.pollGap.set(key, smoothed);
    }
  }
  state.lastScanAt.set(key, t);
}

function ringState(row) {
  const now = Date.now();
  const scanned = Date.parse(row.scannedAt || "");
  const configured = Math.max(1, Number(row.pollSeconds || state.settings.worktreeSeconds || 5));
  const observed = state.pollGap.get(keyOf(row.project, row.path)) || 0;
  // Never shorter than the configured cadence, never more than 10x it (a stuck row must not turn
  // into a 10-minute ring that looks frozen).
  const every = Math.max(configured, Math.min(Math.round(observed), configured * 10));
  const total = every * 1000;
  const remain = Number.isFinite(scanned) ? Math.max(0, scanned + total - now) : 0;
  const overdue = Number.isFinite(scanned) ? Math.max(0, now - (scanned + total)) : 0;
  return { now, scanned, configured, every, total, remain, overdue, frac: Math.min(1, remain / total) };
}

function ringOffset(st) {
  return (RING_C * (1 - st.frac)).toFixed(2);
}

function ringStroke(st) {
  if (st.remain > 0) return st.frac < 0.25 ? "var(--amber)" : "var(--green)";
  return st.overdue > st.total * 0.5 ? "var(--red)" : "var(--amber)";
}

function ageCellHtml(row) {
  const alive = Date.parse(row.lastAliveAt || "");
  const label = Number.isFinite(alive) ? fmtDur(Date.now() - alive) : "never live";
  const st = ringState(row);
  return `<td class="age nowrap" data-key="${esc(keyOf(row.project, row.path))}">
      <svg class="poll-ring" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle class="poll-track" cx="8" cy="8" r="6" fill="none" stroke-width="2"></circle>
        <circle class="poll-arc" cx="8" cy="8" r="6" fill="none" stroke-width="2" transform="rotate(-90 8 8)" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${ringOffset(st)}" stroke="${ringStroke(st)}"></circle>
      </svg><span class="age-num${Number.isFinite(alive) ? "" : " dimmer"}">${esc(label)}</span><span class="sigs">${sigChips(row)}</span></td>`;
}

function paintAgeCell(cell, row) {
  const st = ringState(row);
  const arc = cell.querySelector(".poll-arc");
  if (arc) {
    arc.setAttribute("stroke-dashoffset", ringOffset(st));
    arc.setAttribute("stroke", ringStroke(st));
  }
  // A running panel agent IS life, observed by us, whatever the last scan said.
  const running = panelFor(row)?.running;
  const alive = running ? st.now : Date.parse(row.lastAliveAt || "");
  const live = Number.isFinite(alive);
  const num = cell.querySelector(".age-num");
  if (num) {
    num.textContent = live ? fmtDur(st.now - alive) : "never live";
    num.classList.toggle("dimmer", !live);
  }
  const cadence = st.every === st.configured ? `every ${st.every}s` : `every ${st.every}s, observed (configured ${st.configured}s)`;
  cell.title =
    `last life ${live ? `${fmtDur(st.now - alive)} ago${running ? " (a panel agent is running here now)" : ""}` : "never seen"} · polled ${relTime(row.scannedAt)} ago · ` +
    `next read ${st.remain > 0 ? `in ${Math.ceil(st.remain / 1000)}s` : `due now${st.overdue > st.total ? ` (overdue ${fmtDur(st.overdue)})` : ""}`} (${cadence})`;
}

function detailHtml(row) {
  const parts = [];
  const dirty = row.dirtyFiles || [];
  const untr = row.untrackedFiles || [];
  const commits = row.unmergedCommits || [];
  if (dirty.length) {
    parts.push(`<div class="col"><h4>Modified (${dirty.length})</h4><ul>${dirty.map((f) => `<li><span class="dimmer">${esc(f.code)}</span> ${esc(f.path)}</li>`).join("")}</ul></div>`);
  }
  if (untr.length) {
    parts.push(`<div class="col"><h4>Untracked (${untr.length})</h4><ul>${untr.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>`);
  }
  const pm = state.projects.get(row.project) || {};
  if (commits.length) {
    parts.push(
      `<div class="col"><h4>Commits not on ${esc(pm.remoteRef || "remote main")}${row.diffSummary ? ` · ${esc(row.diffSummary)}` : ""}</h4><ul>${commits
        .map((c) => `<li><span class="dimmer">${esc(c.sha)}</span> ${esc(c.subject)}</li>`)
        .join("")}</ul></div>`,
    );
  }
  parts.push(`<div class="col"><h4>Liveness evidence</h4><ul>${livenessLines(row).map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`);
  const meta = [
    row.isAncestor === true ? "ancestor of remote main" : row.isAncestor === false ? "not an ancestor" : null,
    `cherry +${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}`,
    row.reflogEntries ? `branch reflog: ${row.reflogEntries} distinct commit(s)` : null,
    row.everMoved === true
      ? `branch carried its own commits${row.mergedCount ? ` (${row.mergedCount} since ${esc(String(row.branchBase || "").slice(0, 7))})` : ""}`
      : row.everMoved === false
        ? "branch never moved — it has no commits of its own"
        : null,
    `remote branch: ${esc(row.remoteBranch || "?")}`,
    row.lastCommit ? `last commit ${relTime(row.lastCommit)} ago` : null,
    row.error ? `error: ${esc(row.error)}` : null,
  ].filter(Boolean).join(" · ");
  return `<tr class="detail" data-detail="${esc(keyOf(row.project, row.path))}"><td colspan="9">
    <div class="codelist" style="margin-bottom:8px">${meta}</div>
    <div class="cols">${parts.join("")}</div>
  </td></tr>`;
}

function chipsHtml(name) {
  const rows = [...state.rows.values()].filter((r) => r.project === name);
  const merged = rows.filter((r) => String(r.verdict || "").startsWith("MERGED")).length;
  const noCommits = rows.filter((r) => {
    const v = String(r.verdict || "");
    return v.startsWith("NO COMMITS") || v.startsWith("EMPTY REPO");
  }).length;
  const unmerged = rows.filter((r) => {
    const v = String(r.verdict || "");
    return !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN";
  }).length;
  const dirty = rows.filter((r) => r.dirty || r.untracked).length;
  const live = rows.filter(isRowLive).length;
  const open = rows.filter((r) => !isRowLive(r) && r.idle).length;
  const serving = rows.filter((r) => r.signals?.ports?.on).length;
  const removable = rows.filter((r) => r.mergeable).length;
  const panelRunning = rows.filter((r) => panelAgentsByPath().get(String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase())?.running).length;
  const stale = rows.filter((r) => r.verdictStale).length;
  const out = [`<span class="chip">${rows.length} worktrees</span>`];
  if (merged) out.push(`<span class="chip good">${merged} merged</span>`);
  if (noCommits) out.push(`<span class="chip">${noCommits} no commits</span>`);
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  if (live) out.push(`<span class="chip warn">${live} live</span>`);
  if (open) out.push(`<span class="chip">${open} open idle</span>`);
  if (serving) out.push(`<span class="chip info">${serving} serving</span>`);
  if (panelRunning) out.push(`<span class="chip warn">${panelRunning} panel agent${panelRunning === 1 ? "" : "s"}</span>`);
  if (removable) out.push(`<span class="chip info">${removable} safe to remove</span>`);
  if (stale) out.push(`<span class="chip">${stale} reclassifying</span>`);
  return out.join("");
}

// ---- project ordering + the green "+" ------------------------------------------
// Projects are listed most-recently-worked-on first: the newest of the repo's own activity
// (last commit / git index mtime) and the newest file edit inside any of its worktrees.
function projectActivity(p) {
  let best = Date.parse(p.activityAt || "") || 0;
  for (const r of state.rows.values()) {
    if (r.project !== p.name) continue;
    best = Math.max(best, Date.parse(r.lastEdit || "") || 0, Date.parse(r.lastCommit || "") || 0);
  }
  return best;
}

function sortedProjects() {
  return [...state.projects.values()].sort(
    (a, b) => projectActivity(b) - projectActivity(a) || String(a.name).localeCompare(String(b.name)),
  );
}

function reorderProjects() {
  const host = $("projects");
  // A project only ever moves inside its own folder — never into a folder it is not in.
  for (const p of sortedProjects()) {
    const sec = host.querySelector(`section.project[data-project="${CSS.escape(p.name)}"]`);
    const body = sec?.closest(".root-body");
    if (body) body.appendChild(sec);
  }
  // Then the folders themselves, by their most recently active project.
  const groups = [...host.querySelectorAll("section.root-group")];
  const activity = (g) => {
    let best = 0;
    for (const s of g.querySelectorAll("section.project")) {
      best = Math.max(best, projectActivity(state.projects.get(s.dataset.project) || {}));
    }
    return best;
  };
  groups.sort((a, b) => activity(b) - activity(a) || String(a.dataset.root || "").localeCompare(String(b.dataset.root || "")));
  for (const g of groups) host.appendChild(g);
}

// One accordion per folder. The header carries the folder path and the aggregate state of
// everything inside it, so a collapsed folder still says what it holds.
function rootChips(projects) {
  const names = new Set(projects.map((p) => p.name));
  const rows = [...state.rows.values()].filter((r) => names.has(r.project));
  const unmerged = rows.filter((r) => {
    const v = String(r.verdict || "");
    return v && !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN";
  }).length;
  const dirty = rows.filter((r) => r.dirty || r.untracked).length;
  const live = rows.filter(isRowLive).length;
  const out = [
    `<span class="chip">${projects.length} project${projects.length === 1 ? "" : "s"}</span>`,
    `<span class="chip">${rows.length} worktrees</span>`,
  ];
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  if (live) out.push(`<span class="chip warn">${live} live</span>`);
  return out.join("");
}

function rootSection(root, projects) {
  const open = !state.collapsedRoots.has(root);
  const anyOpen = projects.some((p) => state.expandedProjects.has(p.name));
  return `<section class="root-group${open ? "" : " collapsed"}" data-root="${esc(root)}">
    <div class="root-head" data-toggle-root="${esc(root)}" title="${open ? "collapse" : "expand"} ${esc(labelRoot(root))}">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <h2>${esc(labelRoot(root))}</h2>
      <div class="chips">${rootChips(projects)}</div>
      <span class="spacer"></span>
      <button type="button" class="btn-root-collapse" data-root-collapse="${esc(root)}" title="${anyOpen ? "collapse" : "expand"} every project in ${esc(labelRoot(root))} (${projects.length})">${anyOpen ? "Collapse all" : "Expand all"}</button>
      <button type="button" class="btn-root-clone" data-root-clone="${esc(root)}" title="clone a GitHub repo over ssh into ${esc(labelRoot(root))}">+</button>
    </div>
    <div class="root-clone" data-clone-form="${esc(root)}"${state.cloneStatus[root] ? "" : " hidden"}>
      <input type="text" data-clone-input="${esc(root)}" placeholder="repo name — e.g. agent-worktree-gui, or owner/repo" spellcheck="false" autocomplete="off">
      <button type="button" data-clone-go="${esc(root)}">Clone via ssh</button>
      <span class="mono dim${state.cloneStatus[root]?.kind === "err" ? " clone-err" : ""}" data-clone-msg="${esc(root)}">${esc(state.cloneStatus[root]?.text || "")}</span>
    </div>
    <div class="root-body">
${projects.map((p) => projectSection(p.name)).join("\n")}
    </div>
  </section>`;
}

function projectSection(name) {
  const p = state.projects.get(name) || { name };
  const open = state.expandedProjects.has(name);
  const mainLine = p.localMain && p.remoteTip
    ? `local ${esc(p.mainBranch)} <code>${esc(p.localMain)}</code> · ${p.mainBehind ?? "?"} behind / ${p.mainAhead ?? "?"} ahead of remote`
    : p.error ? esc(p.error) : "local main unknown";
  const board = p.board
    ? `<span class="mono ${p.board.live?.length ? "sig-board-live" : "dimmer"}">board: ${p.board.live?.length ? p.board.live.map((e) => `pid ${e.pid}`).join(", ") : `no live entries (${p.board.dead} stale)`}</span>`
    : "";
  const tip = p.remoteTip
    ? `<span class="mono dim">${esc(p.remoteRef || "")} <code>${esc(p.remoteTip)}</code> ${esc(String(p.remoteTipSubject || "").slice(0, 60))} · ${relTime(p.remoteTipDate)} ago</span>`
    : "";
  return `<section class="project${open ? "" : " collapsed"}" data-project="${esc(name)}">
    <div class="project-head" data-toggle-project="${esc(name)}" title="${open ? "minimize" : "expand"} ${esc(name)}">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <h2>${esc(name)}</h2>
      <button class="btn-plus" data-spawn-project="${esc(name)}" title="start a Hermes agent, worktree and branch in ${esc(name)}">+</button>
      <span class="path">${esc(p.path || "")}</span>
      <span class="spacer"></span><div class="chips" data-chips="${esc(name)}">${chipsHtml(name)}</div>
    </div>
    <div class="project-head meta-line">
      <span class="mono dim">${mainLine}</span><span class="spacer"></span>${board}${tip}
      <span class="dimmer mono">${p.fetchNote ? esc(p.fetchNote) + " · " : ""}fetched ${relTime(p.fetchedAt)} ago</span>
    </div>
    <table><thead><tr>
      <th>Worktree</th><th>Branch</th><th>Tip</th><th>Ahead / Behind</th><th>Cherry</th>
      <th>PR</th><th>Dirty</th><th title="time since this worktree was last seen alive (any evidence firing) · the ring drains to empty when the row is due for its next read · chips are the evidence: ⧉ hermes session · ● board PID · :port dev server · ✎ files edited">Life / next read</th><th>Verdict</th>
    </tr></thead><tbody data-tbody="${esc(name)}"></tbody></table>
    <div class="legend">liveness evidence: <span class="sig sig-hermes">⧉ hermes</span> session active · <span class="sig sig-board">● board</span> live board PID · <span class="sig sig-port">:port</span> dev server listening · <span class="sig sig-files">✎ files</span> edited recently — a row is live only if one of these fired · the number is time since that last happened, the ring drains to empty when the row is due for its next read</div>
  </section>`;
}

function refreshChips(name) {
  const el = document.querySelector(`[data-chips="${CSS.escape(name)}"]`);
  if (el) el.innerHTML = chipsHtml(name);
}

function reorder(name) {
  const tbody = state.tbodyEls.get(name);
  if (!tbody) return;
  const rows = [...state.rows.values()].filter((r) => r.project === name).sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
  for (const r of rows) {
    const k = keyOf(name, r.path);
    const tr = state.rowEls.get(k);
    if (tr) tbody.appendChild(tr);
    const d = state.detailEls.get(k);
    if (d) tbody.appendChild(d);
  }
}

function placeRow(project, row, { flash = false } = {}) {
  row.project = project;
  const key = keyOf(project, row.path);
  noteScan(row);
  state.rows.set(key, row);
  const tbody = state.tbodyEls.get(project);
  // If the section was rebuilt (project event), the cached tbody is detached. Repaint this
  // project's rows instead of quietly appending into a node nobody can see.
  if (!tbody || !tbody.isConnected) {
    if (!state.projects.has(project)) {
      renderAll();
      return;
    }
    const fresh = document.querySelector(`[data-tbody="${CSS.escape(project)}"]`);
    if (fresh) state.tbodyEls.set(project, fresh);
    renderProjectRows(project);
    refreshChips(project);
    return;
  }
  const holder = document.createElement("tbody");
  holder.innerHTML = rowHtml(row);
  const newTr = holder.firstElementChild;
  const old = state.rowEls.get(key);
  const oldDetail = state.detailEls.get(key);
  if (oldDetail) oldDetail.remove();
  state.detailEls.delete(key);
  if (old) old.replaceWith(newTr);
  else tbody.appendChild(newTr);
  state.rowEls.set(key, newTr);
  if (state.expanded.has(key)) {
    const h2 = document.createElement("tbody");
    h2.innerHTML = detailHtml(row);
    const dEl = h2.firstElementChild;
    newTr.after(dEl);
    state.detailEls.set(key, dEl);
  }
  if (flash && old) {
    newTr.classList.add("flash");
    setTimeout(() => newTr.classList.remove("flash"), 900);
  }
  reorder(project);
  refreshChips(project);
}

function removeRow(project, p) {
  const key = keyOf(project, p);
  state.rowEls.get(key)?.remove();
  state.detailEls.get(key)?.remove();
  state.rowEls.delete(key);
  state.detailEls.delete(key);
  state.rows.delete(key);
  refreshChips(project);
}

// Paint one project's rows into its (possibly just replaced) tbody.
function renderProjectRows(name) {
  const tbody = state.tbodyEls.get(name);
  if (!tbody) return;
  tbody.innerHTML = "";
  const rows = [...state.rows.values()]
    .filter((r) => r.project === name)
    .sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
  for (const row of rows) {
    const key = keyOf(name, row.path);
    const holder = document.createElement("tbody");
    holder.innerHTML = rowHtml(row);
    const tr = holder.firstElementChild;
    tbody.appendChild(tr);
    state.rowEls.set(key, tr);
    if (state.expanded.has(key)) {
      const h2 = document.createElement("tbody");
      h2.innerHTML = detailHtml(row);
      const dEl = h2.firstElementChild;
      tr.after(dEl);
      state.detailEls.set(key, dEl);
    }
  }
}

// Header summary. The project count is the live one — what the table is actually showing — not
// the configured fallback list the server reports before discovery has run.
function paintConfigLine() {
  const cfg = state.settings || {};
  if (cfg.host === undefined) return;
  const n = state.projects.size || (Array.isArray(cfg.projects) ? cfg.projects.length : 0);
  $("config-line").textContent = `${n} project(s) · cheap fields every ${cfg.worktreeSeconds}s · verdict/PR every ${cfg.slowSeconds}s · ${cfg.threads} scan threads · ${cfg.host}`;
}

function renderAll() {
  // A full re-render rebuilds the chips from scratch; the job list is the freshest input.
  invalidatePanelMap();
  const projects = sortedProjects();
  for (const id of [...state.expandedProjects]) if (!state.projects.has(id)) state.expandedProjects.delete(id);
  // Wrap every project in its folder accordion: one group per scan root, and a sibling group
  // for any project that lives outside all of them (so nothing is filed under a folder it is
  // not actually in). Groups are ordered by their most recently active project.
  const groups = new Map();
  for (const p of projects) {
    const root = rootOf(p);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  }
  $("projects").innerHTML =
    [...groups.entries()]
      .sort((a, b) => projectActivity(b[1][0]) - projectActivity(a[1][0]) || a[0].localeCompare(b[0]))
      .map(([root, list]) => rootSection(root, list))
      .join("") || '<p class="empty">No git repos found under scanRoots.</p>';
  state.tbodyEls.clear();
  state.rowEls.clear();
  state.detailEls.clear();
  for (const p of projects) {
    const tbody = document.querySelector(`[data-tbody="${CSS.escape(p.name)}"]`);
    if (tbody) state.tbodyEls.set(p.name, tbody);
    renderProjectRows(p.name);
    refreshChips(p.name);
  }
  paintConfigLine();
}

function applySnapshot(data) {
  state.settings = data.settings || state.settings;
  if (Array.isArray(data.scanRoots)) state.scanRoots = data.scanRoots;
  if (data.spawn) {
    state.spawn = data.spawn;
    $("chip-key").textContent = `key: ${data.spawn.key?.fromEnv ? "env" : "from registry"}`;
    $("chip-bin").textContent = String(data.spawn.binary || "").split(/[\\/]/).pop() || "hermes";
    syncProjectPicker(data.spawn.projects || []);
  }
  if (data.skipped) {
    $("skipped-note").textContent = data.skipped.length
      ? `skipped under scanRoots (not git repos): ${data.skipped.map((s) => String(s.dir).split(/[\\/]/).pop()).join(", ")}`
      : "";
  }
  if (data.jobs) {
    state.jobs.clear();
    for (const j of data.jobs) {
      state.jobs.set(j.id, j);
      if (!state.jobLines.has(j.id) && j.lines?.length) state.jobLines.set(j.id, j.lines.slice());
    }
    renderJobs();
    invalidatePanelMap();
  }
  if (Array.isArray(data.approvals)) {
    state.approvals.clear();
    for (const r of data.approvals) if (r && r.id) state.approvals.set(r.id, r);
    renderApprovals();
  }
  // A snapshot refreshes what it carries; it does not retract rows. Only an explicit "drop"
  // event retires a worktree, so a snapshot arriving mid-scan can never blank the table.
  const seen = new Set();
  for (const p of data.projects || []) {
    seen.add(p.name);
    state.projects.set(p.name, p);
    const wts = Array.isArray(p.worktrees) ? p.worktrees : [];
    if (!wts.length) continue;
    for (const [k, r] of [...state.rows]) if (r.project === p.name) state.rows.delete(k);
    for (const w of wts) {
      const row = { ...w, project: p.name };
      state.rows.set(keyOf(p.name, w.path), row);
      noteScan(row);
    }
  }
  // A snapshot is authoritative about WHICH projects exist: the server drops a project when it
  // disappears from the roots (or was only ever a config fallback before discovery ran), and the
  // client must drop it too instead of keeping a section nothing will ever repaint.
  for (const name of [...state.projects.keys()]) if (!seen.has(name)) state.projects.delete(name);
  for (const [k, r] of [...state.rows]) {
    if (!seen.has(r.project)) {
      state.rows.delete(k);
      state.rowEls.delete(k);
      state.detailEls.delete(k);
    }
  }
  renderAll();
  $("health").className = "dot ok";
  $("banner").classList.add("hidden");
}

function showBanner(msg) {
  const b = $("banner");
  if (!msg) return b.classList.add("hidden");
  b.textContent = msg;
  b.classList.remove("hidden");
}

function setStream(label, cls = "ok") {
  $("stream-state").textContent = label;
  $("health").className = `dot ${cls}`;
}

function connect() {
  if (state.es) state.es.close();
  const es = new EventSource("/api/stream");
  state.es = es;
  es.addEventListener("open", () => setStream("● live"));
  es.addEventListener("snapshot", (e) => {
    const d = JSON.parse(e.data);
    applySnapshot(d.data ? d.data : d);
  });
  es.addEventListener("row", (e) => {
    const evt = JSON.parse(e.data);
    state.events += 1;
    state.lastEventAt = Date.now();
    // Liveness-only updates repaint the row but do not flash it: evidence blinks on and off
    // far more often than git state moves, and flashing for that is just noise.
    placeRow(evt.project, evt.row, { flash: evt.changed !== false && !evt.livenessOnly });
  });
  es.addEventListener("project", (e) => {
    const evt = JSON.parse(e.data);
    const cur = state.projects.get(evt.project.name) || {};
    state.projects.set(evt.project.name, { ...cur, ...evt.project });
    refreshChips(evt.project.name);
    const sec = document.querySelector(`section.project[data-project="${CSS.escape(evt.project.name)}"]`);
    if (!sec) {
      renderAll();
      return;
    }
    // Replace only the section's own markup, then immediately repaint its rows: swapping the
    // whole section used to leave an empty <tbody> behind until the next full re-render,
    // which is what made the worktree table vanish for seconds at a time.
    const holder = document.createElement("div");
    holder.innerHTML = projectSection(evt.project.name);
    const freshHolder = holder.firstElementChild;
    sec.replaceWith(freshHolder);
    state.tbodyEls.set(evt.project.name, freshHolder.querySelector(`[data-tbody="${CSS.escape(evt.project.name)}"]`));
    renderProjectRows(evt.project.name);
    reorderProjects();
  });
  es.addEventListener("drop", (e) => {
    const evt = JSON.parse(e.data);
    removeRow(evt.project, evt.path);
  });
  es.addEventListener("job", (e) => updateJob(JSON.parse(e.data).job));
  es.addEventListener("jobline", (e) => appendJobLine(JSON.parse(e.data)));
  es.addEventListener("approval", (e) => {
    const r = JSON.parse(e.data).request;
    if (!r || !r.id) return;
    state.approvals.set(r.id, r);
    renderApprovals();
  });
  es.addEventListener("approval-answered", (e) => {
    const evt = JSON.parse(e.data);
    state.approvals.delete(evt.id);
    renderApprovals();
  });
  es.addEventListener("jobs", (e) => {
    state.jobs.clear();
    for (const j of JSON.parse(e.data).jobs) state.jobs.set(j.id, j);
    renderJobs();
    repaintAgentState();
  });
  es.addEventListener("heartbeat", (e) => {
    state.pool = JSON.parse(e.data).pool;
  });
  es.addEventListener("error", () => setStream("reconnecting…", "warn"));
}

async function resync() {
  try {
    applySnapshot(await fetch("/api/state").then((r) => r.json()));
  } catch (e) {
    showBanner(`Cannot reach the server: ${e.message}`);
    setStream("offline", "bad");
  }
}

async function post(route) {
  try {
    await fetch(route, { method: "POST" });
    await resync();
  } catch (e) {
    showBanner(`${route}: ${e.message}`);
  }
}

$("btn-refresh").addEventListener("click", () => post("/api/refresh"));
$("btn-fetch").addEventListener("click", () => post("/api/fetch"));
$("job-project").addEventListener("change", () => {
  const p = selectedProject();
  if (p) $("job-cwd").value = p.path;
  $("job-existing").checked = false;
  state.spawnTarget = null;
  updateSpawnNote();
  $("job-cmd").textContent = "preview a command to see exactly what would run…";
  $("job-cmd").classList.add("dimmer");
});
$("job-cwd").addEventListener("input", updateSpawnNote);
$("job-existing").addEventListener("change", () => {
  updateSpawnNote();
  $("job-cmd").textContent = "preview a command to see exactly what would run…";
  $("job-cmd").classList.add("dimmer");
});
$("btn-preview").addEventListener("click", preview);
$("btn-spawn").addEventListener("click", spawnAgent);
$("btn-clear-jobs").addEventListener("click", () => post("/api/jobs/clear"));
$("btn-fold-jobs").addEventListener("click", () => {
  const convs = conversations();
  const allFolded = convs.length > 0 && convs.every((c) => state.collapsedJobs.has(c.thread));
  foldAll(!allFolded);
});
$("job-prompt").addEventListener("input", () => {
  $("job-cmd").textContent = "preview a command to see exactly what would run…";
  $("job-cmd").classList.add("dimmer");
});
$("btn-pause").addEventListener("click", () => {
  state.paused = !state.paused;
  $("btn-pause").textContent = state.paused ? "Resume" : "Pause";
  if (state.paused) {
    state.es?.close();
    setStream("paused", "warn");
  } else {
    connect();
    resync();
  }
});

document.addEventListener("click", async (e) => {
  const apBtn = e.target.closest("[data-approval-choice]");
  if (apBtn) {
    e.preventDefault();
    e.stopPropagation();
    void answerApproval(apBtn.dataset.approvalId, apBtn.dataset.approvalChoice, apBtn);
    return;
  }
  const plus = e.target.closest(".btn-plus");
  if (plus) {
    e.stopPropagation();
    e.preventDefault();
    focusSpawn(plus.dataset.spawnProject);
    return;
  }
  const rcollapse = e.target.closest("[data-root-collapse]");
  if (rcollapse) {
    e.stopPropagation();
    e.preventDefault();
    toggleAllInRoot(rcollapse.dataset.rootCollapse);
    return;
  }
  const rclone = e.target.closest("[data-root-clone]");
  if (rclone) {
    e.stopPropagation();
    e.preventDefault();
    const root = rclone.dataset.rootClone;
    const form = document.querySelector(`[data-clone-form="${CSS.escape(root)}"]`);
    showCloneForm(root, form ? form.hidden : true); // the "+" toggles the row
    return;
  }
  const rgo = e.target.closest("[data-clone-go]");
  if (rgo) {
    e.stopPropagation();
    e.preventDefault();
    void cloneIntoRoot(rgo.dataset.cloneGo);
    return;
  }
  const rhead = e.target.closest(".root-head[data-toggle-root]");
  if (rhead) {
    toggleRoot(rhead.dataset.toggleRoot);
    return;
  }
  const phead = e.target.closest(".project-head[data-toggle-project]");
  if (phead) {
    toggleProject(phead.dataset.toggleProject);
    return;
  }
  const rowAgent = e.target.closest(".btn-row-agent");
  if (rowAgent) {
    e.stopPropagation();
    e.preventDefault();
    focusSpawnForWorktree(rowAgent.dataset.agentPath, rowAgent.dataset.agentName);
    return;
  }
  const replyBtn = e.target.closest(".btn-reply");
  if (replyBtn) {
    await sendReply(replyBtn.dataset.thread);
    return;
  }
  // A turn folds on its own: the head row or the one-line request opens/closes that turn,
  // independently of the conversation card it sits in.
  const turnToggle = e.target.closest("[data-toggle-turn]");
  if (turnToggle) {
    e.preventDefault();
    toggleTurn(turnToggle.dataset.toggleTurn);
    return;
  }
  const head = e.target.closest(".job-head");
  if (head && !e.target.closest(".btn-cancel") && !e.target.closest(".reply")) {
    toggleJob(head.dataset.toggle);
    return;
  }
  const btn = e.target.closest(".btn-cancel");
  if (!btn) return;
  btn.disabled = true;
  try {
    await fetch("/api/jobs/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: btn.dataset.id }) });
  } catch {
    btn.disabled = false;
  }
});

// Reply affordances are re-created on every render, so they are handled at document level.
document.addEventListener("keydown", (e) => {
  // The folder clone input: Enter clones, Escape closes the row.
  const cloneInput = e.target.closest && e.target.closest("[data-clone-input]");
  if (cloneInput) {
    if (e.key === "Enter") {
      e.preventDefault();
      void cloneIntoRoot(cloneInput.dataset.cloneInput);
    } else if (e.key === "Escape") {
      e.preventDefault();
      showCloneForm(cloneInput.dataset.cloneInput, false);
    }
    return;
  }
  const box = e.target.closest && e.target.closest(".reply-box");
  if (!box) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendReply(box.dataset.reply);
  }
});
document.addEventListener("input", (e) => {
  const box = e.target.closest && e.target.closest(".reply-box");
  if (box) state.replyDrafts[box.dataset.reply] = box.value;
});

$("projects").addEventListener("click", (e) => {
  // A row's agent chip jumps up to that conversation instead of expanding the row.
  const jump = e.target.closest("[data-agent-thread]");
  if (jump) {
    e.preventDefault();
    e.stopPropagation();
    jumpToAgent(jump.dataset.agentThread);
    return;
  }
  const tr = e.target.closest("tr.row");
  if (!tr) return;
  const key = tr.dataset.key;
  const row = state.rows.get(key);
  if (!row) return;
  if (state.expanded.has(key)) {
    state.expanded.delete(key);
    state.detailEls.get(key)?.remove();
    state.detailEls.delete(key);
    tr.classList.remove("expanded");
  } else {
    state.expanded.add(key);
    const holder = document.createElement("tbody");
    holder.innerHTML = detailHtml(row);
    const dEl = holder.firstElementChild;
    tr.after(dEl);
    state.detailEls.set(key, dEl);
    tr.classList.add("expanded");
  }
});

setInterval(() => {
  for (const cell of document.querySelectorAll("td.age")) {
    const row = state.rows.get(cell.dataset.key);
    if (!row) continue;
    paintAgeCell(cell, row);
  }
  for (const j of state.jobs.values()) {
    if (j.status !== "running" && j.status !== "starting") continue;
    const card = document.querySelector(`.job[data-thread="${CSS.escape(j.thread || j.id)}"]`);
    const foot = card?.querySelector(".job-foot");
    if (foot) foot.innerHTML = `<span class="dimmer mono">running ${esc(elapsed(j))}</span>`;
    const head = card?.querySelector(`[data-turn-head="${CSS.escape(j.id)}"]`);
    if (head) head.textContent = `turn ${j.turn || "?"} · running ${elapsed(j)}`;
  }
  const bits = [];
  if (state.pool) bits.push(`pool ${state.pool.inFlight}/${state.settings.threads || "?"}`);
  if (state.jobs.size) {
    const convs = conversations();
    const running = convs.filter((c) => c.turns.some((t) => t.status === "running")).length;
    bits.push(`${convs.length} conversation${convs.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`);
  }
  if (state.lastEventAt) {
    const rate = state.events / Math.max(1, (Date.now() - state.eventsAt) / 1000);
    bits.push(`${state.events} events · ${rate.toFixed(1)}/s`);
  } else {
    bits.push("no changes yet");
  }
  $("stream-rate").textContent = bits.join(" · ");
}, 1000);

setInterval(() => {
  if (!state.paused) resync();
}, 30000);

(async function boot() {
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    state.settings = cfg;
    state.scanRoots = Array.isArray(cfg.scanRoots) ? cfg.scanRoots : [];
    $("f-worktree").textContent = cfg.worktreeSeconds;
    $("f-slow").textContent = cfg.slowSeconds;
    paintConfigLine();
    // Deliberately no seeding of state.projects from cfg.projects here: before discovery has
    // run that list is only the config fallback, and a project seeded that way can never be
    // removed by a later snapshot (heroes-js showed up forever this way on a machine that does
    // not have it). The first snapshot paints the real set.
    await resync();
    connect();
    state.eventsAt = Date.now();
  } catch (e) {
    setStream("offline", "bad");
    showBanner(`Cannot reach the server: ${e.message}. Start it with npm start.`);
  }
})();
