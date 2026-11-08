// board-scaffold.js - the board's shared scaffolding: the element builders every surface still draws with, and the
// panel wiring that keeps each of them current in place. Cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js is 17,689 lines and one file is one lane: every row repaint, every card
// repaint and every settings applier lands in it. docs/reports/module-map-2026-11-08.html names this cut as item 2
// of "The remaining lane" - "public/app.js's board scaffolding: the element builders and the panel wiring that
// every remaining surface still shares. It is the dom.js cut repeated on what dom.js left behind." That is what
// this file is: the row's chip strip and its agent badge, the project header's counts and its host strip, the
// row's expanded detail block with its TODO strip, the refresh offer card, and the panel map and liveness reads
// all of them ask. 45 declarations moved line for line - every body is byte identical to its text in app.js at
// 4829d3c, compared after CRLF normalisation - and not one call site was touched. What render-projects.js and
// render-jobs.js already carry was not re-cut: the row template and the project section stay in the first, the
// job card and its turns in the second.
//
// WHAT IS HERE
//
//   the panel map        panelMapCache, panelMap, invalidatePanelMap, agentsByPathCache, threadRowKeyCache,
//                        agentsByPath, agentsFor and knownThreads: which panel agents belong to which worktree,
//                        memoized per job change because a row asks on every paint
//   the liveness reads   LIVE_STATUS, turnLive, approvalLive, convLive, agentsRunning, isAgentRunning, panelFor and
//                        isRowLive: the two questions every chip, badge and row asks - is this turn live, and is
//                        this row live
//   the row's evidence   hermesTitle, sigChips, paintRowChips, livenessLines, agentBadgeHtml and repaintAgentState:
//                        the chip strip in a row's age cell, the tooltip naming the session behind each chip, the
//                        liveness evidence block, the panel badge, and the one painter an event and an answer both
//                        call
//   the project header   headTitle, chipsHtml, hostChipHtml, hostPanelHtml, repaintHostPanel, proposeHostMapping and
//                        saveHostMapping: the title's tooltip, the counts strip, the host chip, and the Discover
//                        strip that proposes a mapping and writes one only when the reader presses
//   the row's detail     gitSubHtml (one folded file strip), DESC_SENTENCE_BREAK and descLines (the description as
//                        bullets), refreshClock (the refresh journal's wall clock) and detailHtml, the whole
//                        tr.detail block: merge state, description, TODO, liveness, the agent slots and the idle
//                        sessions the row offers to revive
//   the TODO strip       TODO_GLYPH, todoAge, todoOldest, todoLine, todoPeekFor, repaintTodoBlock and todoBlockHtml:
//                        folded it reads the oldest open item, unfolded every item with its facts and its controls
//   the refresh offer    refreshOfferHtml, paintRefreshOffer, paintRefreshOffers and clearRefreshOffer: the card the
//                        row's own refresh opens, placed under its row and repainted after a project rebuild
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state                the page's state literal: rows, jobs, projects, hosts, hostPanel, refreshOffers, todoOpen,
//                        todoDraft, todoFactsOpen, gitOpen, gitSubOpen, liveOpen, openDescs, expandedProjects
//   the formatters       esc, keyOf, relTime and fmtAgo (public/core/dom-format.js)
//   the record reads     conversations and panelAgentsByPath, chartTopLimit, chartTopSplit and wtColspan
//                        (public/charts.js), orderedAgents and markUnder (public/render-projects.js)
//   the builders that    addAgentBarHtml, ownerDetailHtml and pushControlsHtml, which stay in app.js
//   stay in app.js
//   the writers          apiFetch and resync (public/core/transport.js), showBanner
//   the repaint targets  paintAgentBadges (public/render-jobs.js), refreshChips and reorderProjects
//                        (public/render-projects.js), paintHumanButton (app.js)
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `const` or `let` is a binding every other script reads by
// bare name. This file DECLARES ONLY: no top-level statement, no listener and no read of an app.js binding while it
// loads (panelMapCache, agentsByPathCache, threadRowKeyCache, LIVE_STATUS, DESC_SENTENCE_BREAK and TODO_GLYPH are
// literal initialisers), so being loaded before app.js costs nothing. public/app.js re-exports these names on
// window.WMApp.scaffold.

// The panel map: which panel agents belong to which worktree, and the liveness reads every chip and row asks.
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
  agentsByPathCache = null;
  threadRowKeyCache = null;
}

// Agents grouped by the worktree that OWNS them (set when the agent was created), so a row can
// list its own agents. Conversations with no owner are "homeless" and stay in the Agents panel.
let agentsByPathCache = null;

// thread -> worktree row key, for turning an event into life on a row. Rebuilt with the panel maps.
let threadRowKeyCache = null;

function agentsByPath() {
  if (agentsByPathCache) return agentsByPathCache;
  const map = new Map();
  for (const c of conversations()) {
    const owner = c.latest.ownerPath || c.first.ownerPath || null;
    if (!owner) continue;
    const k = normPath(owner).toLowerCase();
    const list = map.get(k) || [];
    list.push(c);
    map.set(k, list);
  }
  agentsByPathCache = map;
  return map;
}

function agentsFor(row) {
  return agentsByPath().get(normPath(row.path).toLowerCase()) || [];
}

// Threads that already have a card somewhere on the board, so a session the row reports is never
// offered for revival when it is already there.
function knownThreads() {
  return new Set([...state.jobs.values()].map((j) => j.thread || j.id));
}

// A turn is live while it runs - and a turn parked on an approval is still live: the agent is inside the turn,
// waiting on the reader, not finished with it. Counting a parked turn as done is what let a worktree badge say
// "2 awaiting approval" and show no running count at all. A turn HELD on the gateway's 429 cap is live for the
// same reason in the other direction: it has no run id yet, but it owns its thread and its worktree, so it must
// not read as a finished turn (the reply queue and the "is this thread busy" checks both ask this).
const LIVE_STATUS = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);

function turnLive(t) {
  if (!t) return false;
  if (t.status && LIVE_STATUS.has(String(t.status))) return true;
  return Boolean(t.approval && !t.approvalDone);
}

// An approval is only a question while the gateway is still holding it. The window is the gateway's own
// (`approvals.timeout`, carried on the request when it arrives): past it the gateway denies the command by itself
// and moves the turn on, so every place that says "waiting on you" asks this first. An approval with no window at
// all (an older panel record, restored from the store) is left alone rather than guessed at.
function approvalLive(a) {
  if (!a) return false;
  const deadline = Number(a.deadline);
  return !Number.isFinite(deadline) || Date.now() < deadline;
}

// A conversation is live if any of its turns is - not just the newest one. A parked turn can sit behind a newer
// finished one, and asking only `latest` reported such an agent as not running.
function convLive(c) {
  if (!c) return false;
  if (turnLive(c.latest)) return true;
  return (c.turns || []).some(turnLive);
}

function agentsRunning(list) {
  return list.filter(convLive).length;
}

function isAgentRunning(conv) {
  return convLive(conv);
}

function panelFor(row) {
  return panelMap().get(normPath(row.path).toLowerCase()) || null;
}

// A row is live if a signal fired OR one of our agents is running in it right now.
function isRowLive(row) {
  return Boolean(row.live) || Boolean(panelFor(row)?.running);
}

// The row's evidence: the chip strip, its tooltip, the liveness block, the badge and the one painter.
// The chip's tooltip: what the evidence is, then which sessions it is — numbered, one per line. A native
// tooltip honors the newlines, so the list reads as a list instead of one long run-on line.
function hermesTitle(head, titles) {
  const list = (titles || []).map((x) => String(x || "").trim()).filter(Boolean);
  if (!list.length) return head;
  const numbered = list.map((x, i) => `${i + 1}. ${x}`).join("\n");
  return `${head}\n\n${numbered}`;
}

function sigChips(row) {
  const s = row.signals || {};
  const out = [];
  // The label says only WHO the evidence is (a Hermes session external to this panel). Whether it is
  // working right now lives in the tooltip: "hermes running" read as a second kind of chip.
  if (s.hermes?.on) {
    const head = s.hermes.running
      ? "A Hermes agent external to this application is actively taking turns in this worktree."
      : `Hermes session open here${s.hermes.matched === "work" ? " — placed by its newest tool calls, not its start directory" : ""}.`;
    out.push(`<span class="sig sig-hermes" title="${esc(hermesTitle(head, s.hermes.titles))}">⧉ hermes</span>`);
  }
  if (s.claude?.on) {
    const head = s.claude.running
      ? "A Claude Code session external to this application is actively taking turns in this worktree."
      : `Claude Code session open here${s.claude.matched === "work" ? " — placed by its newest tool calls, not its start directory" : ""}.`;
    out.push(`<span class="sig sig-claude" title="${esc(hermesTitle(head, s.claude.titles))}">⧉ claude</span>`);
  }
  if (s.board?.on) out.push(`<span class="sig sig-board" title="board entry, PID alive now: ${esc((s.board.entries || []).map((e) => e.pid).join(', '))}">● board</span>`);
  if (s.ports?.on) out.push(`<span class="sig sig-port" title="dev server listening: ${esc((s.ports.listening || []).join(', '))}">:${esc((s.ports.listening || []).join(' :'))}</span>`);
  if (s.files?.on) out.push(`<span class="sig sig-files" title="files edited ${relTime(s.files.at)} ago">✎ files</span>`);
  // The row's panel agents are already drawn as the ⧉ badge beside its name — same count, same running
  // state — so a second "⧉ panel" chip here just said it twice. The badge opens the row and its agents.
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

function livenessLines(row) {
  const s = row.signals || {};
  const lines = [];
  if (s.hermes?.on)
    lines.push(
      `Hermes session active here${s.hermes.running ? " (a turn is executing right now)" : ""}: ${(s.hermes.titles || []).map((t) => `"${t}"`).join(" · ")}` +
        (s.hermes.matched === "work" ? " — placed by its newest tool calls, not its start directory" : ""),
    );
  else if (s.hermes?.idle) lines.push(`Hermes session open here but idle (${s.hermes.idle})`);
  if (s.claude?.on)
    lines.push(
      `Claude Code session active here${s.claude.running ? " (a turn is executing right now)" : ""}: ${(s.claude.titles || []).map((t) => `"${t}"`).join(" · ")}` +
        (s.claude.matched === "work" ? " — placed by its newest tool calls, not its start directory" : ""),
    );
  else if (s.claude?.idle) lines.push(`Claude Code session open here but idle (${s.claude.idle})`);
  if (s.board?.on) lines.push(`Board: PID ${(s.board.entries || []).map((e) => e.pid).join(", ")} — alive now`);
  else if (s.board?.dead) lines.push(`Board: ${s.board.dead} entr${s.board.dead === 1 ? "y" : "ies"}, none with a live PID`);
  if (s.ports?.on) lines.push(`Dev server: :${(s.ports.listening || []).join(", ")} listening`);
  else if (s.ports?.declared?.length) lines.push(`Dev server: declared :${(s.ports.declared || []).join(", ")} — nothing listening`);
  if (s.files?.on) lines.push(`Files edited ${relTime(s.files.at)} ago`);
  lines.push(row.live ? `Verdict: live via ${row.liveWhy || "?"}` : "Verdict: not live — no session, board entry or listening port");
  return lines;
}

// One badge per row saying how many agents this worktree owns, and how many are running.
function agentBadgeHtml(row) {
  const mine = agentsFor(row);
  if (!mine.length) return "";
  const running = agentsRunning(mine);
  // A parked approval is the one state that needs the reader, and it used to be invisible the moment
  // the row was collapsed — the badge only ever said "running".
  // `approvalDone` is deliberately absent: a turn whose FIRST approval was answered is not thereby un-parked when
  // its SECOND one arrives, and this badge is how the reader is told a human is needed (docs/steer-refusal.md §1.4).
  const waiting = mine.filter((c) => (c.turns || []).some((t) => approvalLive(t.approval) && turnLive(t))).length;
  const cls = waiting ? "sig-approval" : running ? "sig-panel" : "sig-panel-done";
  const bits = [waiting ? `${waiting} awaiting approval` : null, running ? `${running} running` : null].filter(Boolean);
  return `<button class="sig ${cls}" data-open-row="${esc(keyOf(row.project, row.path))}" title="${mine.length} agent${mine.length === 1 ? "" : "s"} owned by this worktree${waiting ? `, ${waiting} parked on a permission request — click to answer it` : running ? `, ${running} running` : ""} — click to open the row and its agents">⧉ ${mine.length}${bits.length ? ` · ${bits.join(" · ")}` : ""}</button>`;
}

function repaintAgentState() {
  invalidatePanelMap();
  for (const row of state.rows.values()) paintRowChips(row);
  // The ⧉ badge in a row's name cell carries "awaiting approval", so it has to be repainted here too —
  // it is not part of the chips, and it was the one thing left stale after an answer.
  paintAgentBadges();
  for (const name of state.projects.keys()) refreshChips(name);
  // An agent starting or finishing changes where its project belongs: bring it up (or let it settle)
  // without waiting for the next 30s snapshot, in every folder the reader is not working in.
  reorderProjects();
  // A job that started, stopped or parked changes the HUMAN rotation's own list, and the count on its button is
  // how the reader notices a question without looking for it — so it is repainted with the rest of the state.
  paintHumanButton();
}

// The project header: its title tooltip, its counts strip, and the host chip with its Discover strip.
function headTitle(name) {
  const open = state.expandedProjects.has(name);
  return `${open ? "minimize" : "expand"} ${name} — Ctrl+click to colour this project, Ctrl+Shift+click to clear it`;
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
    // A RELEASED row is a folder left behind, not work waiting to merge: it is counted in the tree total only.
    return !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN" && v !== "RELEASED";
  }).length;
  const dirty = rows.filter((r) => r.dirty || r.untracked).length;
  const serving = rows.filter((r) => r.signals?.ports?.on).length;
  const removable = rows.filter((r) => r.mergeable).length;
  // Every agent whose home is a row in this project. Violet while any of them is working; amber as
  // soon as they are all idle, because "a live panel" is only true when something is actually running.
  const panelAgents = rows.flatMap((r) => agentsFor(r));
  const panelAgentCount = panelAgents.length;
  const panelRunningCount = panelAgents.filter(convLive).length;
  const stale = rows.filter((r) => r.verdictStale).length;
  // What the chart is holding back, so a collapsed project cannot silently under-report its trees: the count is of
  // rows below this project's top N (chartTopOrder: newest activity first, then by name), and it goes away the moment
  // that chart is asked for everything.
  const topCount = chartTopLimit();
  const held = state.showOldProjects.has(name) ? 0 : chartTopSplit(rows).held.length;
  const out = [`<span class="chip">${rows.length} worktrees</span>`];
  if (held) out.push(`<span class="chip" title="${esc(`${held} worktree${held === 1 ? "" : "s"} below the top ${topCount} — newest activity first, then by name; the arrow at the bottom of the chart shows ${held === 1 ? "it" : "them"} in that same order`)}">${held} more hidden</span>`);
  if (merged) out.push(`<span class="chip good">${merged} merged</span>`);
  if (noCommits) out.push(`<span class="chip">${noCommits} no commits</span>`);
  if (unmerged) out.push(`<span class="chip bad">${unmerged} unmerged</span>`);
  if (dirty) out.push(`<span class="chip warn">${dirty} dirty</span>`);
  if (serving) out.push(`<span class="chip info">${serving} serving</span>`);
  // Violet in both states, like the ⧉ hermes chip: this is a Hermes-agent fact, not a warning. Amber
  // made every project with finished agents look like it wanted attention; the tooltip still says how
  // many are running right now.
  // How many agents are working RIGHT NOW, from every source: the panel's own cards and any Hermes
  // session (CLI or otherwise) whose turn is leased. The split is in the tooltip, so the chip stays the
  // answer to one question — "is anything running".
  // Hermes agents that are NOT this panel's, read the way the panel chip is: how many sessions the project
  // has, and how many of them are executing right now. Grey while they are all sitting there, violet as soon
  // as one is running, so the colour answers "is someone working" without parsing the numbers.
  const hermesRunning = rows.reduce((n, r) => n + (Number(r.signals?.hermes?.running) || 0), 0);
  const hermesIdle = rows.reduce((n, r) => n + (Number(r.signals?.hermes?.idle) || 0), 0);
  const hermesTotal = hermesRunning + hermesIdle;
  if (hermesTotal) {
    const busy = hermesRunning > 0;
    const head = busy
      ? `${hermesTotal} Hermes session${hermesTotal === 1 ? "" : "s"} from outside this panel in this project · ${hermesRunning} executing a turn right now`
      : `${hermesTotal} Hermes session${hermesTotal === 1 ? "" : "s"} from outside this panel in this project · none executing right now`;
    const titles = rows.flatMap((r) => [
      ...(r.signals?.hermes?.titles || []),
      ...((r.signals?.hermes?.idleList || []).map((s) => s.title).filter(Boolean)),
    ]);
    const tag = busy ? ` · ${hermesRunning} running` : "";
    out.push(
      `<span class="chip hermes${busy ? " on" : ""}" title="${esc(hermesTitle(head, titles))}">${hermesTotal} hermes${tag}</span>`,
    );
  }
  // Claude Code sessions, counted the same way as the Hermes ones above.
  const claudeRunning = rows.reduce((n, r) => n + (Number(r.signals?.claude?.running) || 0), 0);
  const claudeOpen = rows.reduce((n, r) => n + (r.signals?.claude?.on ? (r.signals.claude.titles || []).length : 0) + (Number(r.signals?.claude?.idle) || 0), 0);
  if (claudeOpen) {
    const busy = claudeRunning > 0;
    const head = `${claudeOpen} Claude Code session${claudeOpen === 1 ? "" : "s"} from outside this panel in this project · ${busy ? `${claudeRunning} executing a turn right now` : "none executing right now"}`;
    const titles = rows.flatMap((r) => r.signals?.claude?.titles || []).filter(Boolean);
    out.push(
      `<span class="chip claude${busy ? " on" : ""}" title="${esc(hermesTitle(head, titles))}">${claudeOpen} claude${busy ? ` · ${claudeRunning} running` : ""}</span>`,
    );
  }
  // The panel's own agents: how many cards, and how many of them are executing. The colour IS the state —
  // violet while something runs, grey while the panel is quiet — so a reader does not have to parse the
  // number to know whether anything is working.
  if (panelAgentCount) {
    const trees = rows.filter((r) => agentsFor(r).length).length;
    const busy = panelRunningCount > 0;
    const title = `${panelAgentCount} agent card${panelAgentCount === 1 ? "" : "s"} across ${trees} worktree${trees === 1 ? "" : "s"} in this project${busy ? ` · ${panelRunningCount} running right now` : " · none running"}`;
    const tag = busy ? ` · ${panelRunningCount} running` : "";
    const body = `⧉ ${panelAgentCount} panel${panelAgentCount === 1 ? "" : "s"}${tag}`;
    // Always a button: busy it jumps to the agent that is working, quiet it jumps to the top agent card.
    const cls = `chip${busy ? " agents" : ""} chip-jump`;
    const hint = busy ? "click to jump to the running agent" : "click to jump to the top agent";
    out.push(
      `<button type="button" class="${cls}" data-jump-panel="${esc(name)}" data-jump-running="${busy ? "1" : "0"}" title="${esc(title)} — ${hint}">${body}</button>`,
    );
  }
  // Amber and loud: an agent parked on a permission request is the one thing here that is waiting for
  // a human, and it must be visible with the project collapsed.
  // Same rule as the row badge: the park on the card is the signal, not the record of an earlier answer.
  const panelWaiting = panelAgents.filter((c) =>
    (c.turns || []).some((t) => approvalLive(t.approval) && turnLive(t)),
  ).length;
  if (panelWaiting) {
    out.push(
      `<span class="chip sig-approval" title="an agent in this project is parked on a permission request — open the row to answer it">\u26a0 ${panelWaiting} awaiting approval</span>`,
    );
  }
  if (removable) out.push(`<span class="chip info">${removable} safe to remove</span>`);
  if (stale) out.push(`<span class="chip">${stale} reclassifying</span>`);
  return out.join("");
}

// Where a project's branches and PRs live: the header's chip and its Discover strip.
// The board links a branch and a PR to whatever host the project's mapping names (logs/hosts.json, lib/hosts.js). That
// mapping is data, so it has to be visible and fillable from the page: the chip says which host a project resolves to
// (or that it has none, and why), and pressing it reads the project's own remote and offers the mapping it implies.
// The proposal is never written until the reader presses the button that writes it — a mapping the panel guessed is
// not a mapping, and a guessed URL is worse than the plain text this whole feature replaced.
function hostChipHtml(name) {
  const v = state.hosts?.projects?.[name];
  if (!v) return "";
  const coords = v.coordinates ? Object.values(v.coordinates).filter(Boolean).join("/") : "";
  const label = v.host ? `host: ${v.host}` : "no host";
  const title = v.host
    ? `links come from ${v.host}${coords ? ` (${coords})` : ""}${v.landing ? " · its landing doctrine is in the merge prompt" : " · no landing doctrine"}${v.links?.repo ? ` · ${v.links.repo}` : ""} — click to change or re-discover the mapping`
    : `${v.why} — click to read this project's remote and propose a mapping for you to confirm`;
  return `<button type="button" class="btn-host${v.host ? " is-mapped" : " is-unmapped"}" data-host-project="${esc(name)}" title="${esc(title)}">${esc(label)}${coords ? ` <span class="host-coords">${esc(coords)}</span>` : ""}</button>`;
}

function hostPanelHtml(name) {
  const panel = state.hostPanel;
  if (!panel || panel.project !== name) return "";
  const ids = Object.keys(state.hosts?.hosts || {});
  const opts = ids.length ? ids.map((id) => `<option value="${esc(id)}"${id === panel.host ? " selected" : ""}>${esc(id)}</option>`).join("") : `<option value="">(no host records)</option>`;
  return `<div class="host-form" data-host-form="${esc(name)}">
      <span class="mono host-line${panel.error ? " clone-err" : ""}" data-host-line>${esc(panel.line || "")}</span>
      <span class="host-fields">
      ${pushControlsHtml(name)}
      <label class="host-field">host <select data-host-select="${esc(name)}"${panel.busy ? " disabled" : ""}>${opts}</select></label>
      <label class="host-field">coordinates <input type="text" class="mono" data-host-coords="${esc(name)}" data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" spellcheck="false" placeholder="owner/repo or PROJECT/slug" value="${esc(panel.coords || "")}"${panel.busy ? " disabled" : ""}></label>
      <button type="button" data-host-save="${esc(name)}"${panel.busy ? " disabled" : ""}>Use this mapping</button>
      <button type="button" data-host-cancel="${esc(name)}">Cancel</button>
      </span>
    </div>`;
}

function repaintHostPanel(name) {
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  if (!sec) return;
  const html = hostPanelHtml(name);
  const old = sec.querySelector("[data-host-form]");
  if (old) {
    if (html) old.outerHTML = html;
    else old.remove();
    return;
  }
  if (!html) return;
  const head = sec.querySelector(".project-head.meta-line");
  if (head) head.insertAdjacentHTML("afterend", html);
}

async function proposeHostMapping(name) {
  // A second press on the same chip closes the strip; it is a toggle, not a dialog.
  if (state.hostPanel?.project === name) {
    state.hostPanel = null;
    repaintHostPanel(name);
    return;
  }
  const current = state.hosts?.projects?.[name] || {};
  state.hostPanel = { project: name, host: current.host || "", coords: "", line: "reading the remote…", busy: true };
  repaintHostPanel(name);
  try {
    const res = await apiFetch("/api/hosts/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: name }),
    });
    const out = await res.json().catch(() => ({}));
    if (state.hostPanel?.project !== name) return;
    if (!res.ok) {
      state.hostPanel = { ...state.hostPanel, busy: false, error: true, line: out.error || `could not read the remote (HTTP ${res.status})` };
      repaintHostPanel(name);
      return;
    }
    const prop = out.proposal || {};
    const coords = prop.ok ? Object.values(prop.coordinates || {}).filter(Boolean).join("/") : "";
    state.hostPanel = {
      project: name,
      host: prop.ok ? prop.host : current.host || Object.keys(state.hosts?.hosts || {})[0] || "",
      coords,
      busy: false,
      error: !prop.ok,
      line: prop.ok
        ? `${prop.remoteUrl} -> ${prop.host}`
        : `no proposal: ${prop.why || "unknown reason"}`,
    };
    repaintHostPanel(name);
    document.querySelector(`[data-host-coords="${CSS.escape(name)}"]`)?.focus();
  } catch (e) {
    if (state.hostPanel?.project !== name) return;
    state.hostPanel = { ...state.hostPanel, busy: false, error: true, line: `could not read the remote: ${e.message}` };
    repaintHostPanel(name);
  }
}

async function saveHostMapping(name) {
  const panel = state.hostPanel;
  if (!panel || panel.project !== name) return;
  const host = document.querySelector(`[data-host-select="${CSS.escape(name)}"]`)?.value || panel.host;
  const coords = document.querySelector(`[data-host-coords="${CSS.escape(name)}"]`)?.value ?? panel.coords;
  if (!host) {
    state.hostPanel = { ...panel, error: true, line: "pick a host id first — logs/hosts.json and hosts.seed.json define them" };
    repaintHostPanel(name);
    return;
  }
  state.hostPanel = { ...panel, busy: true, error: false, line: "writing the mapping…" };
  repaintHostPanel(name);
  try {
    const res = await apiFetch("/api/hosts/mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: name, host, coordinates: String(coords || "").trim() }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      state.hostPanel = { ...state.hostPanel, busy: false, error: true, line: out.error || `could not write the mapping (HTTP ${res.status})` };
      repaintHostPanel(name);
      return;
    }
    state.hostPanel = null;
    repaintHostPanel(name);
    showBanner(`host mapping: ${name} → ${host}${out.mapping?.links?.repo ? ` (${out.mapping.links.repo})` : ""}`);
    // The rows carry their link as a scan result, so the cells catch up on the next pass; this resync brings the new
    // chip and the project's own coordinates back immediately.
    void resync();
  } catch (e) {
    state.hostPanel = { ...state.hostPanel, busy: false, error: true, line: `could not write the mapping: ${e.message}` };
    repaintHostPanel(name);
  }
}

// The row's detail block: the merge state, the description, the TODO strip, liveness and the agent slots.
// One file-list strip inside merge state: a one-line head carrying its count, its names folded away until the
// reader opens it. The fold's own key is the row's key plus the kind, so the two strips of a row (and the merge
// state strip around them) each open and close on their own. Nothing is emitted for an empty list, so a clean
// tree has no strips at all rather than two empty ones.
function gitSubHtml(key, kind, title, count, items) {
  const subKey = `${key}::${kind}`;
  const open = state.gitSubOpen.has(subKey);
  const what = kind === "modified" ? "changed" : "untracked";
  return `<div class="git-sub${open ? "" : " collapsed"}" data-git-sub="${esc(subKey)}">
        <div class="git-sub-head" data-toggle-git-sub="${esc(subKey)}" title="${open ? "fold" : "unfold"} the ${count} ${what} file${count === 1 ? "" : "s"}">
          <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
          <h4>${esc(title)} (${count})</h4>
        </div>
        <ul>${items.join("")}</ul>
      </div>`;
}

// The description as bullets: one per sentence. The split is the SAME boundary lib/descriptions.js used to cut the
// text down to two sentences in the first place (a full stop, question or bang mark, then whitespace and something
// that can start a sentence), so the panel shows the sentences the server recognised rather than re-parsing the prose
// its own way — and text with no sentence punctuation at all (the store's word-boundary fallback) stays one bullet.
const DESC_SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"'([])/;

function descLines(text) {
  const all = String(text ?? "").trim();
  if (!all) return [];
  return all
    .split(DESC_SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The worktree's TODO list.
// The section the reader asked for. FOLDED it reads the OLDEST incomplete item — the lowest id whose status is todo or
// doing — with a done/total count beside it, and deliberately NOT the most recently touched item: finishing out of
// order is the normal case, so "what is the first thing still open" is the only line worth having without opening
// anything. UNFOLDED it lists every item with its status glyph, its owner and its age, and offers the four things a
// reader can do to one — add, edit, complete, drop — plus reopening.
//
// The list itself is the server's (lib/todos.js holds it, keyed on the row, and the assistant and every agent in the
// tree write to it); nothing here derives a status or invents an item.
const TODO_GLYPH = { todo: "\u25a1", doing: "\u25b6", done: "\u2713", dropped: "\u2298" };

// A duration the way the row's other strips say them: seconds under a minute and a half, then minutes, hours, days.
function todoAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// The oldest incomplete item, from the row's own copy. The SAME rule the server applies (lib/todos.js `oldestOpen`),
// restated here because the folded line must not need a round trip — and because the harness can drive it directly.
function todoOldest(todo) {
  let best = null;
  for (const item of todo?.items || []) {
    if (item.status !== "todo" && item.status !== "doing") continue;
    if (!best || Number(item.id) < Number(best.id)) best = item;
  }
  return best;
}

// One item as one line: its id (the number every agent is told to write), its glyph, its words, and who and how long.
function todoLine(item) {
  if (!item) return "";
  const bits = [String(item.status || "todo")];
  if (item.owner) bits.push(String(item.owner));
  const age = todoAge(item.ageMs);
  if (age) bits.push(age);
  return `#${item.id} ${TODO_GLYPH[item.status] || "?"} ${item.text} · ${bits.join(" · ")}`;
}

// The folded line's peek, recomputed from the row's own state — used when the section is folded again in place (the
// head must go back to the OLDEST item still open, not to whatever was drawn last).
function todoPeekFor(key) {
  const todo = state.rows.get(key)?.todo;
  if (!todo) return "";
  const oldest = todoOldest(todo);
  if (oldest) return todoLine(oldest);
  const done = Number(todo.done) || 0;
  const total = Number(todo.total) || 0;
  return `nothing open — ${done}/${total} done${todo.dropped ? `, ${todo.dropped} dropped` : ""}`;
}

// Repaint ONE row's detail, in place, so a draft swap (the reader opening an input) lands without rebuilding the
// project. The node is rebuilt from state, so everything else in the row keeps its own remembered fold.
function repaintTodoBlock(key) {
  const row = state.rows.get(key);
  const detail = state.detailEls.get(key) || document.querySelector(`tr.detail[data-detail="${CSS.escape(key)}"]`);
  if (!row || !detail) return;
  // A <tbody> holder, like every other path that builds a <tr class="detail">. Parsed inside a <div> the `<tr>` start
  // tag is dropped by the HTML parser, so `firstElementChild` came back as the inner `<div class="detail-inner">` and
  // `replaceWith` put THAT in the tbody: the row's detail stopped being a `tr.detail[data-detail]`, every selector that
  // follows one (placeRow, the sweep, a second unfold) missed it, and the reader's fold was carried by a node the panel
  // could no longer find. One edit or add on any row did it.
  const holder = document.createElement("tbody");
  holder.innerHTML = detailHtml(row);
  const fresh = holder.firstElementChild;
  if (!fresh) return;
  markUnder(fresh, key);
  detail.replaceWith(fresh);
  state.detailEls.set(key, fresh);
  const input = fresh.querySelector(".todo-edit, .todo-add-input");
  if (input && typeof input.focus === "function") {
    input.focus();
    input.select?.();
  }
}

function todoBlockHtml(row, key) {
  const todo = row.todo;
  if (!todo || !(todo.items || []).length) return "";
  const open = state.todoOpen.has(key);
  const oldest = todoOldest(todo);
  const done = Number(todo.done) || 0;
  const total = Number(todo.total) || (todo.items || []).length;
  const count = `${done}/${total}`;
  // The folded line: the count, then the OLDEST item still open. With nothing open it says so rather than showing the
  // last thing that moved.
  const peek = oldest
    ? todoLine(oldest)
    : `nothing open — ${done}/${total} done${todo.dropped ? `, ${todo.dropped} dropped` : ""}`;
  const draft = state.todoDraft && state.todoDraft.key === key ? state.todoDraft : null;
  const itemHtml = (todo.items || [])
    .map((item) => {
      const editing = draft && draft.id === item.id;
      const glyph = TODO_GLYPH[item.status] || "?";
      // The facts under this item are a disclosure of its OWN: folded unless the reader opened this item, and the key
      // carries the row as well as the id, so two worktrees' item #2 never share a fold.
      const factsKey = `${key}::${item.id}`;
      const factsOpen = state.todoFactsOpen.has(factsKey);
      // The facts about the item, ONE PER BULLET, as a nested list under its line. They used to be a single string
      // ridden to the far right of a full-width line (`margin-left:auto`), so on a 1,400px row the owner and age sat a
      // screen away from the words the reader was reading and both ends needed a zoomed-out browser. The fields are the
      // store's own (lib/todos.js): owner, by, the age since it last changed, plus the optional note and files.
      const age = todoAge(item.ageMs);
      const facts = [];
      if (item.owner) facts.push(`<li class="todo-fact" data-todo-fact="owner"><span class="todo-fact-label">owner</span> ${esc(item.owner)}</li>`);
      if (item.by) facts.push(`<li class="todo-fact" data-todo-fact="by"><span class="todo-fact-label">by</span> ${esc(item.by)}</li>`);
      if (age) facts.push(`<li class="todo-fact" data-todo-fact="updated"><span class="todo-fact-label">updated</span> ${esc(age)} ago</li>`);
      if (item.note) facts.push(`<li class="todo-fact todo-note dim" data-todo-fact="note">${esc(item.note)}</li>`);
      if ((item.files || []).length) facts.push(`<li class="todo-fact todo-files dimmer mono" data-todo-fact="files">${esc(item.files.join(" "))}</li>`);
      const factsHtml = facts.length
        ? `<ul class="todo-meta todo-facts mono" aria-label="who touched TODO #${item.id}, and when">${facts.join("")}</ul>`
        : "";
      const text = editing
        ? `<input class="todo-edit" type="text" maxlength="400" data-todo-edit="${item.id}" data-todo-key="${esc(key)}" value="${esc(draft.text)}" aria-label="edit TODO #${item.id}">
           <button type="button" class="todo-btn on" data-todo-op="edit-save" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="save this item">save</button>
           <button type="button" class="todo-btn" data-todo-op="edit-cancel" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="leave it as it was">cancel</button>`
        : `<span class="todo-text">${esc(item.text)}</span>
           <button type="button" class="todo-btn" data-todo-op="edit-start" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="edit this item (stored as by: reader)">✎</button>`;
      const actions = editing
        ? ""
        : `<button type="button" class="todo-btn" data-todo-op="doing" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="claim it — doing">▶</button>
           <button type="button" class="todo-btn" data-todo-op="done" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="mark it done">✓</button>
           <button type="button" class="todo-btn" data-todo-op="drop" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="drop it — it no longer applies">⊘</button>
           ${item.status === "done" || item.status === "dropped" ? `<button type="button" class="todo-btn" data-todo-op="reopen" data-todo-id="${item.id}" data-todo-key="${esc(key)}" title="reopen it — back to todo">↺</button>` : ""}`;
      // The item's own line is unchanged — glyph, id, its words, its controls — with ONE control in front of it: the
      // disclosure that folds its facts away. The facts still hang under the line, in the same list, indented the same
      // way; only whether they are showing is new, and that is the reader's to decide per item.
      const factsToggle = facts.length
        ? `<button type="button" class="todo-facts-btn" data-toggle-todo-facts="${item.id}" data-todo-key="${esc(key)}" aria-expanded="${factsOpen ? "true" : "false"}" aria-label="${factsOpen ? "hide" : "show"} the facts for TODO #${item.id}" title="${factsOpen ? "hide" : "show"} what the panel knows about TODO #${item.id} — its owner, who touched it and when"><span class="chev">${factsOpen ? "\u25be" : "\u25b8"}</span></button>`
        : "";
      return `<li class="todo-item todo-${esc(item.status)}${facts.length && !factsOpen ? " collapsed" : ""}" data-todo-item="${item.id}">
        <div class="todo-line">
          ${factsToggle}
          <span class="todo-glyph" title="${esc(item.status)}">${glyph}</span>
          <span class="todo-id mono dimmer">#${item.id}</span>
          ${text}
          ${actions}
        </div>
        ${factsHtml}
      </li>`;
    })
    .join("");
  const journal = (todo.journal || [])
    .slice(-6)
    .map((j) => `<li>${esc(`${j.by || "?"} ${j.op || ""}${j.id ? ` #${j.id}` : ""}${j.text ? `: ${j.text}` : ""}`)}</li>`)
    .join("");
  const addOpen = Boolean(draft && draft.id === null);
  const addHtml = `<div class="todo-add">
      ${
        addOpen
          ? `<input class="todo-add-input" type="text" maxlength="400" data-todo-add-input="${esc(key)}" value="${esc(draft.text)}" placeholder="what has to happen" aria-label="add a TODO item">
             <button type="button" class="todo-btn on" data-todo-op="add-save" data-todo-key="${esc(key)}" title="add it to this worktree's list (stored as by: reader)">add</button>
             <button type="button" class="todo-btn" data-todo-op="add-cancel" data-todo-key="${esc(key)}" title="cancel">cancel</button>`
          : `<button type="button" class="todo-btn add" data-todo-op="add-start" data-todo-key="${esc(key)}" title="add an item to this worktree's TODO list">+ add</button>`
      }
    </div>`;
  // The head is a real <button>, so the section is keyboard reachable (Tab to it, Enter or Space to unfold) — the two
  // strips under it are click-only, and the brief asks for this one to be reachable.
  // The reconcile the last ⟳ wrote, on the badge: how many items the TREE's own commits and touched files make look
  // closed. Nothing is applied — it is a question, and the reader's ✓ is the only thing that closes an item.
  const proposal = Array.isArray(todo.proposal) ? todo.proposal : [];
  const proposalTitle = proposal.length
    ? `nothing is marked done by itself — this is what the last ⟳ found:\n${proposal.map((p) => `#${p.id} ${p.text}${p.because ? ` — ${p.because}` : ""}`).join("\n")}`
    : "";
  const proposalChip = proposal.length
    ? `<span class="todo-proposal mono" title="${esc(proposalTitle)}">${proposal.length} look${proposal.length === 1 ? "s" : ""} closed</span>`
    : "";
  return `<div class="todo-block${open ? "" : " collapsed"}" data-todo-block="${esc(key)}">
    <button type="button" class="todo-head" data-toggle-todo="${esc(key)}" aria-expanded="${open ? "true" : "false"}" title="${open ? "fold" : "unfold"} this worktree's TODO list — folded it reads the OLDEST item still open">
      <span class="chev">${open ? "\u25be" : "\u25b8"}</span>
      <span class="todo-title">TODO</span>
      <span class="todo-count mono" title="${done} done of ${total}">${count}</span>
      ${proposalChip}
      ${open ? "" : `<span class="todo-first mono" title="${esc(peek)}">${esc(peek)}</span>`}
    </button>
    <div class="todo-body">
      <ul class="git-list todo-list">${itemHtml}</ul>
      ${journal ? `<div class="todo-journal mono dimmer"><span>journal</span><ul>${journal}</ul></div>` : ""}
      ${addHtml}
    </div>
  </div>`;
}

// The clock on a ⟳ journal line: the reader's own wall time, because the strip answers "when did I refresh this and what
// did it find" and a relative age would drift on a repaint.
function refreshClock(at) {
  const t = Date.parse(at || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function detailHtml(row) {
  const dirty = row.dirtyFiles || [];
  const untr = row.untrackedFiles || [];
  const commits = row.unmergedCommits || [];
  const pm = state.projects.get(row.project) || {};
  // The key is what the folds in this row are remembered by (state.gitOpen, state.gitSubOpen), and the commit and
  // file strips below are built before the rest of the row, so it is taken here rather than further down.
  const key = keyOf(row.project, row.path);
  // The commits this tree carries off remote main are the reason the row is worth opening, so they are a list of
  // their own: full width of the row, one commit per line, and nothing is dropped when the list is long — the list
  // extends and the panel scrolls, it is never clipped. It used to be one of three columns in a flex row, where a
  // long commit list was cut off and a long file list was squeezed into 300px beside its neighbours.
  const commitsBlock = commits.length
    ? `<div class="git-commits">
        <h4>Commits not on ${esc(pm.remoteRef || "remote main")}${row.diffSummary ? ` · ${esc(row.diffSummary)}` : ""}</h4>
        <ul class="git-commits-list">${commits
          .map((c) => `<li><span class="dimmer">${esc(c.sha)}</span> ${esc(c.subject)}</li>`)
          .join("")}</ul>
      </div>`
    : "";
  // Modified and Untracked were the other two columns of that flex row, and a tree with forty changed files turned
  // into a wall of names above its agents. Each is a one-line strip now, carrying its count, and its names stay
  // folded away until the reader opens it. A clean tree, or one with nothing unmerged, simply has no strips here.
  const subStrips = [];
  if (dirty.length) {
    subStrips.push(
      gitSubHtml(
        key,
        "modified",
        "Modified",
        dirty.length,
        dirty.map((f) => `<li><span class="dimmer">${esc(f.code)}</span> ${esc(f.path)}</li>`),
      ),
    );
  }
  if (untr.length) {
    subStrips.push(gitSubHtml(key, "untracked", "Untracked", untr.length, untr.map((f) => `<li>${esc(f)}</li>`)));
  }
  // The git side of the row (state, commit list, dirty files, diff summary) folds into one line:
  // opening a worktree is about seeing its agents and what is unmerged, not a wall of file names.
  // Liveness evidence folds too; collapsed, its strongest line stays visible to the right of the
  // header, because "why is this row live" is the one thing worth seeing without unfolding.
  const liveLines = livenessLines(row);
  const liveOpen = state.liveOpen.has(key);
  const liveBlock = `<div class="live-block${liveOpen ? "" : " collapsed"}" data-live-block="${esc(key)}">
      <div class="live-head" data-toggle-live="${esc(key)}" title="${liveOpen ? "fold" : "unfold"} the liveness evidence">
        <span class="chev">${liveOpen ? "\u25be" : "\u25b8"}</span>
        <h4>Liveness evidence</h4>
        ${liveOpen ? "" : `<span class="live-first mono" title="${esc(liveLines[0] || "no evidence")}">${esc(liveLines[0] || "no evidence")}</span>`}
      </div>
      <ul>${liveLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    </div>`;
  const gitOpen = state.gitOpen.has(key);
  const gitSummary = [
    row.verdict || "…",
    row.branch ? `branch ${row.branch}` : null,
    dirty.length ? `${dirty.length} modified` : null,
    untr.length ? `${untr.length} untracked` : null,
    commits.length ? `${commits.length} not on ${pm.remoteRef || "remote main"}` : null,
    row.diffSummary || null,
    row.lastCommit ? `last commit ${relTime(row.lastCommit)} ago` : null,
  ].filter(Boolean).join(" · ");
  // Each of these was a fragment of one long "·"-joined line, so the reader had to hunt for "cherry" inside it.
  // They are list items now, and the head's summary joins them as the first item while the block is open.
  const metaItems = [
    row.isAncestor === true ? "ancestor of remote main" : row.isAncestor === false ? "not an ancestor" : null,
    `cherry +${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}`,
    row.reflogEntries ? `branch reflog: ${row.reflogEntries} distinct commit(s)` : null,
    row.everMoved === true
      ? `branch carried its own commits${row.mergedCount ? ` (${row.mergedCount} since ${esc(String(row.branchBase || "").slice(0, 7))})` : ""}`
      : row.everMoved === false
        ? "branch never moved — it has no commits of its own"
        : null,
    `remote branch: ${esc(row.remoteBranch || "?")}`,
    // Why the branch cell is plain text rather than a link (or the page it links to), in the reader's own words.
    row.branchUrl ? `remote page: ${esc(row.branchUrl)}` : row.branchWhy ? `branch link: ${esc(row.branchWhy)}` : null,
    row.lastCommit ? `last commit ${relTime(row.lastCommit)} ago` : null,
    row.error ? `error: ${esc(row.error)}` : null,
  ].filter(Boolean);
  // orderedAgents: with "Stabilize reordering" on and an open card in this row, the cards keep the slots they have on
  // screen instead of sorting to newest-turn-first under the one the reader is reading.
  const agents = orderedAgents(row, agentsFor(row));
  // No heading: the row's own badge already says how many agents it owns and how many are running, and the
  // cards are the first thing under the row - a title above them only pushed them down.
  // A slot per card, not a copy of it: placeRow() moves the card that is already on the board into its slot.
  // Rebuilding the cards here destroyed their consoles on every scan - several times a second while a turn ran -
  // and every rebuild is a chance for a scroll position to be lost.
  // The add-agent bar is the full width of an agent card, half its height, a white + in the middle. Its position is a
  // setting (Settings > Display > Add-agent bar at top): above the cards when on, under them when off.
  // It is what the row's green ▶ used to do, because the ▶ now probes the agents the worktree already has. It stays
  // when the row has no agents at all - that is exactly when it is needed. Clicking it turns the bar into the text
  // field below (same footprint, so the row does not move), and Enter starts the run from there.
  const addKey = keyOf(row.project, row.path);
  const addOpen = state.addAgent && state.addAgent.key === addKey;
  const addBar = addAgentBarHtml({
    key: addKey,
    path: row.path,
    name: row.name,
    project: row.project,
    value: addOpen ? state.addAgent.value : null,
  });
  const agentsHtml = `<div class="agents-block">${agents.map((c) => `<div class="agent-slot" data-agent-slot="${esc(c.thread)}"></div>`).join("")}${addBar}</div>`;
  // Sessions the row says are here but that have no card: the conversation lives in the gateway, and
  // the panel's job store is what held the card. Reviving one puts a card back you can reply to —
  // offered one at a time, because a tree collects every session ever run in it.
  const known = knownThreads();
  const idleSessions = (row.signals?.hermes?.idleList || []).filter((s) => s && s.id && !known.has(s.id));
  const sessionsHtml = idleSessions.length
    ? `<div class="sessions-block">
        ${idleSessions
          .map(
            // Shaped like an agent card's head — glyph, chevron, then a pill-sized revive button in the
            // status column — so a session with no card reads as the same kind of thing, one level down.
            // The glyph is grey rather than the purple of a live agent: this session has no card.
            (s) => `<div class="session-row">
            <span class="agent-glyph" title="a Hermes session in this worktree with no card on the board">\u29c9</span>
            <span class="chev" title="no card on the board">\u25b8</span>
            <button type="button" class="btn-revive" data-revive-session="${esc(s.id)}" data-revive-path="${esc(row.path)}" title="put this session back on the board as a card — the conversation is in the gateway, so a reply continues it where it stopped">revive</button>
            <span class="session-when mono" title="${esc(s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : "last use unknown")}">${esc(fmtAgo(s.lastActivityAt))}</span>
            <span class="session-name mono dim">${esc(s.title || "(untitled session)")}</span>
            <span class="session-id mono" title="${esc(s.id)}">${esc(String(s.id).slice(0, 16))}…</span>
          </div>`,
          )
          .join("")}
      </div>`
    : "";
  // What this branch was STARTED to do, in the words of its first run's own brief. The MERGE STATE below says where
  // the branch got to; this says what it was for, which is the question an old row actually raises. The text is the
  // server's (lib/descriptions.js, written down once per tree from the earliest run in it) — nothing here derives or
  // summarises anything beyond cutting it into its own sentences — and a tree the panel has no run for has no block at
  // all, so the section simply goes away rather than standing there empty.
  //
  // A bullet list, one bullet per sentence, and FOLDED to start with — the same shape as the two strips under it
  // (`ul.git-list`, one fact per `<li>`, the head's own line repeated as the first item). Folded, the first bullet
  // rides to the right of the header as the peek, exactly as the merge state's summary and the liveness block's first
  // line do, so the three strips read as one column of one-line headers.
  const desc = row.description && row.description.text ? row.description : null;
  const descOpen = desc ? state.openDescs.has(key) : false;
  const descBullets = desc ? descLines(desc.text) : [];
  const descFrom = desc?.from
    ? ["first run in this tree", desc.from.thread || null, desc.from.at ? `started ${relTime(desc.from.at)} ago` : null]
        .filter(Boolean)
        .join(" · ")
    : "";
  const descBlock = desc
    ? `<div class="desc-block${descOpen ? "" : " collapsed"}" data-desc-block="${esc(key)}">
      <div class="desc-head" data-toggle-desc="${esc(key)}" title="${descOpen ? "fold" : "unfold"} what this branch was started to do">
        <span class="chev">${descOpen ? "\u25be" : "\u25b8"}</span>
        <h4>Description</h4>
        ${descOpen ? "" : `<span class="desc-first mono">${esc(descBullets[0] || desc.text)}</span>`}
      </div>
      <div class="desc-body">
        <ul class="git-list desc-list">
          ${descBullets.map((line, i) => `<li${i === 0 ? ` class="git-summary-line"` : ""}>${esc(line)}</li>`).join("")}
        </ul>
        ${descFrom ? `<div class="desc-from mono">${esc(descFrom)}</div>` : ""}
      </div>
    </div>`
    : "";
  // What the row's own ⟳ found: one dim line per action it took, newest first. The journal is the server's (kept per row
  // beside the panel's other stores), so the strip survives a reload — and a row nobody has refreshed by hand has no
  // strip at all rather than an empty one.
  const refreshJournal = Array.isArray(row.refreshJournal) && row.refreshJournal.length
    ? `<div class="refresh-journal mono dimmer" data-refresh-journal="${esc(key)}" title="what the ⟳ on this row found — newest first, one line per action">${row.refreshJournal
        .map((j) => `<div class="rj-line"><span class="rj-at">⟳ ${esc(refreshClock(j.at))}</span> ${esc(j.text)}</div>`)
        .join("")}</div>`
    : "";
  // Merge state and liveness evidence lead the block again, but as two folded one-line strips: they are reference
  // material and were taking a block's worth of height above the agents when they sat open here.
  // Ten columns, not nine: the row-actions cell is the tenth, and a colspan of 9 left the card area short of the
  // table's right edge by that column, so the expanded agent section ended in a bare strip of panel on the right
  // while the left was flush. (The delete confirmation row below already spans 10.)
  // A RELEASE request a worker asked for (lib/worktrees.js): the tree, when it was asked for, the run that asked, why
  // it said it was finished, and what the panel's executor answered — `removed`, or `refused: <gate>`. It is one line,
  // never a block: a reader needs the verdict and the reason, and the gates are named in the sentence. A tree nobody
  // has asked about has no `release` field and draws nothing here.
  const rel = row.release || null;
  const relWhen = rel ? relTime(rel.at || rel.requestedAt) : "";
  const relState = rel ? String(rel.state || "") : "";
  const releaseBlock = rel
    ? `<div class="release-block ${esc(relState)}" data-release="${esc(key)}" title="${esc(
        [
          rel.outcome ? `outcome ${rel.outcome}` : "no outcome yet — the executor has not run",
          rel.detail || null,
          rel.runId ? `asked by run ${rel.runId}` : null,
          rel.requestedAt ? `requested ${new Date(rel.requestedAt).toLocaleString()}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      )}">
        <span class="release-mark">⇢</span>
        <span class="release-word">release</span>
        <span class="release-state">${esc(rel.outcome || "requested")}</span>
        <span class="release-when mono">${esc(relWhen)} ago${rel.runId ? ` · run ${esc(rel.runId)}` : ""}</span>
        <span class="release-why">${esc(rel.why || "")}</span>
      </div>`
    : "";
  return `<tr class="detail" data-detail="${esc(key)}"><td colspan="${wtColspan()}"><div class="detail-inner">
    ${releaseBlock}
    ${descBlock}
    ${todoBlockHtml(row, key)}
    <div class="git-block${gitOpen ? "" : " collapsed"}" data-git-block="${esc(key)}">
      <div class="git-head" data-toggle-git="${esc(key)}" title="${gitOpen ? "fold" : "unfold"} the merge state, commit and diff detail">
        <span class="chev">${gitOpen ? "\u25be" : "\u25b8"}</span>
        <h4>Merge state</h4>
        <span class="git-summary mono">${esc(gitSummary)}</span>
      </div>
      <div class="git-body">
        <ul class="git-list">
          <li class="git-summary-line">${esc(gitSummary)}</li>
          ${ownerDetailHtml(row)}
          ${metaItems.map((m) => `<li>${m}</li>`).join("")}
        </ul>
        ${commitsBlock}
        ${subStrips.join("")}
      </div>
    </div>
    ${refreshJournal}
    ${liveBlock}
    ${agentsHtml}
    ${sessionsHtml}
  </div></td></tr>`;
}

// The refresh offer: the card the row's own refresh opens, and the wiring that keeps it under its row.
// The card the offer opens: the panel's own in-place question (the same `row-confirm` shape the ✕ asks in), under the
// row it belongs to, because the whole point is that the agent starts in THAT worktree.
function refreshOfferHtml(offer) {
  const row = state.rows.get(offer.key);
  if (!row) return "";
  const evidence = (offer.evidence || []).filter(Boolean);
  const what = evidence.length ? evidence.join(" · ") : "a mismatch the cheap pass cannot resolve by itself";
  return `<tr class="row-confirm refresh-offer" data-refresh-offer="${esc(offer.key)}">
      <td colspan="${wtColspan()}">
        <div class="row-confirm-cell">
          <span class="rc-msg"><span class="dimmer">⟳ re-read</span> <b>${esc(row.name)}</b> <span class="dimmer">found</span> <span class="mono">${esc(what)}</span>
            <span class="dimmer">— start one agent in this worktree to double-check the TODO, the description and the merge state? It reads the tree itself and reports back; nothing is pushed or merged.</span></span>
          <span class="rc-actions"><button class="btn-del-no" type="button" data-refresh-offer-no="${esc(offer.key)}" title="leave it — the cheap pass's journal line is already under the row">not now</button><button class="btn-refresh-yes" type="button" data-refresh-offer-yes="${esc(offer.key)}" title="start an agent in ${esc(row.path)} to double-check what the ⟳ found">start agent</button></span>
        </div>
      </td>
    </tr>`;
}

// Put the card under its row (one copy), or take it away when there is no offer for that key.
function paintRefreshOffer(key) {
  const rowEl = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  for (const old of document.querySelectorAll(`tr.refresh-offer[data-refresh-offer="${CSS.escape(key)}"]`)) old.remove();
  const offer = state.refreshOffers.get(key);
  if (!offer || !rowEl) return false;
  const holder = document.createElement("tbody");
  holder.innerHTML = refreshOfferHtml(offer);
  const card = holder.firstElementChild;
  if (!card) return false;
  markUnder(card, key);
  rowEl.after(card);
  return true;
}

// Every open card, after a rebuild that emptied a project's tbody.
function paintRefreshOffers(project = null) {
  for (const offer of [...state.refreshOffers.values()]) {
    if (project && offer.project !== project) continue;
    paintRefreshOffer(offer.key);
  }
}

function clearRefreshOffer(key) {
  state.refreshOffers.delete(key);
  for (const old of document.querySelectorAll(`tr.refresh-offer[data-refresh-offer="${CSS.escape(key)}"]`)) old.remove();
}
