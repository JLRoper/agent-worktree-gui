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

function turnHead(turn, index, total) {
  const label = `turn ${turn.turn || index + 1}`;
  const state_ = turn.status === "running" || turn.status === "starting" ? `running ${elapsed(turn)}` : `${turn.status} · ${elapsed(turn)}${turn.tokens?.total ? ` · ${turn.tokens.total} tok` : ""}`;
  return `<div class="turn-head mono dimmer" data-turn-head="${esc(turn.id)}">${esc(label)} · ${esc(state_)}${total > 1 ? "" : ""}</div>`;
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
  const blocks = turns
    .map((t, i) => `${turnHead(t, i, turns.length)}<div class="job-prompt">${esc(t.prompt)}</div>${turnBody(t)}`)
    .join("");
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

function renderJobs() {
  const convs = conversations();
  for (const id of [...state.collapsedJobs]) if (!convs.some((c) => c.thread === id)) state.collapsedJobs.delete(id);
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
  state.jobs.set(j.id, { ...prev, ...j });
  if (!state.jobLines.has(j.id) && j.lines?.length) state.jobLines.set(j.id, j.lines.slice());
  renderConversation(j.thread || j.id, { scroll });
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
function sigChips(row) {
  const s = row.signals || {};
  const out = [];
  if (s.hermes?.on) out.push(`<span class="sig sig-hermes" title="Hermes session active in this worktree: ${esc((s.hermes.titles || []).join(' · '))}">⧉ hermes</span>`);
  if (s.board?.on) out.push(`<span class="sig sig-board" title="board entry, PID alive now: ${esc((s.board.entries || []).map((e) => e.pid).join(', '))}">● board</span>`);
  if (s.ports?.on) out.push(`<span class="sig sig-port" title="dev server listening: ${esc((s.ports.listening || []).join(', '))}">:${esc((s.ports.listening || []).join(' :'))}</span>`);
  if (s.files?.on) out.push(`<span class="sig sig-files" title="files edited ${relTime(s.files.at)} ago">✎ files</span>`);
  if (!out.length && row.idle) out.push(`<span class="sig sig-idle" title="a Hermes session is open here but idle — not counted as live">⧉ ${s.hermes?.idle ?? 1} idle</span>`);
  return out.join("");
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
    <td class="age nowrap" data-key="${esc(keyOf(row.project, row.path))}"><span class="age-num">${relTime(row.scannedAt)}</span>${sigChips(row)}</td>
    <td>${badge}</td>
  </tr>`;
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
  const live = rows.filter((r) => r.live).length;
  const open = rows.filter((r) => !r.live && r.idle).length;
  const serving = rows.filter((r) => r.signals?.ports?.on).length;
  const removable = rows.filter((r) => r.mergeable).length;
  const stale = rows.filter((r) => r.verdictStale).length;
  const out = [`<span class="chip">${rows.length} worktrees</span>`];
  if (merged) out.push(`<span class="chip good">${merged} merged</span>`);
  if (noCommits) out.push(`<span class="chip">${noCommits} no commits</span>`);
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  if (live) out.push(`<span class="chip warn">${live} live</span>`);
  if (open) out.push(`<span class="chip">${open} open idle</span>`);
  if (serving) out.push(`<span class="chip info">${serving} serving</span>`);
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
  for (const p of sortedProjects()) {
    const sec = host.querySelector(`section.project[data-project="${CSS.escape(p.name)}"]`);
    if (sec) host.appendChild(sec);
  }
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
      <th>PR</th><th>Dirty</th><th title="row age, plus liveness evidence: ⧉ hermes session · ● board PID · :port dev server · ✎ files edited">Age / evidence</th><th>Verdict</th>
    </tr></thead><tbody data-tbody="${esc(name)}"></tbody></table>
    <div class="legend">liveness evidence: <span class="sig sig-hermes">⧉ hermes</span> session active · <span class="sig sig-board">● board</span> live board PID · <span class="sig sig-port">:port</span> dev server listening · <span class="sig sig-files">✎ files</span> edited recently — a row is live only if one of these fired</div>
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

function renderAll() {
  const projects = sortedProjects();
  for (const id of [...state.expandedProjects]) if (!state.projects.has(id)) state.expandedProjects.delete(id);
  $("projects").innerHTML =
    projects.map((p) => projectSection(p.name)).join("") ||
    '<p class="empty">No git repos found under scanRoots.</p>';
  state.tbodyEls.clear();
  state.rowEls.clear();
  state.detailEls.clear();
  for (const p of projects) {
    const tbody = document.querySelector(`[data-tbody="${CSS.escape(p.name)}"]`);
    if (tbody) state.tbodyEls.set(p.name, tbody);
    renderProjectRows(p.name);
    refreshChips(p.name);
  }
}

function applySnapshot(data) {
  state.settings = data.settings || state.settings;
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
    for (const w of wts) state.rows.set(keyOf(p.name, w.path), { ...w, project: p.name });
  }
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
  es.addEventListener("jobs", (e) => {
    state.jobs.clear();
    for (const j of JSON.parse(e.data).jobs) state.jobs.set(j.id, j);
    renderJobs();
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
  const plus = e.target.closest(".btn-plus");
  if (plus) {
    e.stopPropagation();
    e.preventDefault();
    focusSpawn(plus.dataset.spawnProject);
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
    cell.innerHTML = `<span class="age-num">${relTime(row.scannedAt)}</span>${sigChips(row)}`;
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
    $("f-worktree").textContent = cfg.worktreeSeconds;
    $("f-slow").textContent = cfg.slowSeconds;
    $("config-line").textContent = `${cfg.projects.length} project(s) · cheap fields every ${cfg.worktreeSeconds}s · verdict/PR every ${cfg.slowSeconds}s · ${cfg.threads} scan threads · ${cfg.host}`;
    for (const p of cfg.projects || []) state.projects.set(p.name, p);
    await resync();
    connect();
    state.eventsAt = Date.now();
  } catch (e) {
    setStream("offline", "bad");
    showBanner(`Cannot reach the server: ${e.message}. Start it with npm start.`);
  }
})();
