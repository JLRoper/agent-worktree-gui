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
//   the rules            rulesChipHtml, refreshRulesChip, rulesFor, projectBarsHtml, repaintBars, repaintBar,
//                        barsOf, openBar, closeBar, proposeHostMapping's bar half, rulesBarHtml, ruleRowHtml,
//                        toggleRulesBar, closeRulesBar, addRule, editRule, moveRule, deleteRule and saveProjectRules:
//                        the chip beside the host chip, the grey strip's STACK of bars, and the editor in the rules
//                        bar that adds, edits, reorders and deletes a project's one-line rules
//   the turnover         turnoverChipHtml, refreshTurnoverChip, turnoverFor, turnoverBarHtml, toggleTurnoverBar,
//                        closeTurnoverBar and saveProjectTurnover: the head line's fourth chip, and the one field that
//                        names the branch a tree cut for this project starts from and rolls back into
//   the row's detail     gitSubHtml (one folded file strip), DESC_SENTENCE_BREAK and descLines (the description as
//                        bullets), refreshClock (the refresh journal's wall clock) and detailHtml, the whole
//                        tr.detail block: merge state, description, TODO, liveness, the agent slots and the idle
//                        sessions the row offers to revive
//   the TODO strip       TODO_GLYPH, todoAge, todoOldest, todoLine, todoPeekFor, repaintTodoBlock and todoBlockHtml:
//                        folded it reads the oldest open item, unfolded every item with its facts and its controls
//   the refresh offer    refreshOfferHtml, paintRefreshOffer, paintRefreshOffers and clearRefreshOffer: the card the
//                        row's own refresh opens, placed under its row and repainted after a project rebuild
//   the two chips        resultChipHtml, collisionDiamondHtml, rowChipInner, toggleRowChip, paintRowChipMarkers and
//                        paintRowChipPops: the result card as a ONE-LINE chip in the name strip, and the collision card
//                        behind the row's ONE diamond - a real 24x24 button that says the state and the count in words
//                        and opens the card listing every pair on that worktree. The expansion is remembered per row
//                        and per card in the browser's own store, so a repaint does not slam a card shut
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state                the page's state literal: rows, jobs, projects, hosts, hostPanel, bars, rulesBar,
//                        refreshOffers, todoOpen, todoDraft, todoFactsOpen, gitOpen, gitSubOpen, liveOpen, openDescs,
//                        expandedProjects
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
// bare name. This file DECLARES, with two exceptions, only: no top-level statement, no listener and no read of an
// app.js binding while it loads (panelMapCache, agentsByPathCache, threadRowKeyCache, LIVE_STATUS,
// DESC_SENTENCE_BREAK, TODO_GLYPH and ROWCHIP_STORE_KEY are literal initialisers). The exceptions are the CHIPS'
// OWN WIRING at the end of their block: a document-level click, keydown and scroll handler and a window resize
// handler for the two cards behind the row's chips, registered beside the markup that draws them so the chips are
// one file's feature rather than three files' shared secret. They read `state` and the page's helpers only when
// they fire, never while this file loads, so being loaded before app.js still costs nothing.
// public/app.js re-exports these names on window.WMApp.scaffold.

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
  // The HOT AGENTS bolt is drawn from the same list and by the same rule: a turn starting or stopping is exactly
  // when the marker has to appear or go, and this is the seam every turn change already passes through.
  paintHotButton();
  // Focus mode draws only the trees a live panel is working in, so a turn starting or stopping moves the board
  // itself. `repaintFocus` repaints only when that set actually changed (app.js owns the predicate).
  if (typeof repaintFocus === "function") repaintFocus();
}

// The project header: its title tooltip, its counts strip, and the host chip with its Discover strip.
function headTitle(name) {
  const open = projectDrawsOpen(name);
  // Focus mode draws every project that holds a live row expanded, so the header must not offer a fold the mode will
  // not make: name the gesture that does work instead.
  const what = focusModeOn() && projectHasFocusRow(name)
    ? "focus mode draws every project with a live panel expanded - double-click the header bar to fold projects again"
    : `${open ? "minimize" : "expand"} ${name}`;
  return `${what} - Ctrl+click to colour this project, Ctrl+Shift+click to clear it`;
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
    // A RELEASED row is a folder left behind, not work waiting to merge: it is counted in the tree total only. A STALE
    // row is a tree gone from disk, kept so its cards stay under it - also not work waiting to merge (lib/store.js
    // markStale).
    return !v.startsWith("MERGED") && !v.startsWith("NO COMMITS") && v !== "ON MAIN" && v !== "ON BASE" && v !== "RELEASED" && v !== "STALE";
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

// The host bar lives INSIDE the grey strip's stack now (see "the rules bar" below), so its repaint is the stack's,
// narrowed to one bar: a rule being saved must not rebuild the mapping form the reader is typing a coordinate into.
function repaintHostPanel(name) {
  repaintBar(name, "host");
}

async function proposeHostMapping(name) {
  // A second press on the same chip closes the strip; it is a toggle, not a dialog.
  if (state.hostPanel?.project === name) {
    state.hostPanel = null;
    closeBar(name, "host");
    repaintHostPanel(name);
    return;
  }
  const current = state.hosts?.projects?.[name] || {};
  state.hostPanel = { project: name, host: current.host || "", coords: "", line: "reading the remote…", busy: true };
  openBar(name, "host");
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
    closeBar(name, "host");
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

// ---- a project's rules: the chip, the bar, and the editor inside it --------------------------------------------
// The rule list is the reader's, one line each, stored on the project's `projects[]` entry in config.json
// (lib/project-rules.js). The snapshot carries it on the project record - lib/projects.js normalises the entry
// discovery merged - so the chip can count it on the first paint with no round trip; `/api/project-rules` is the read
// the bar opens with and the write every gesture goes through.
//
// The chip is ALWAYS drawn, zero included: a count that only appears once there is something to count is a control
// the reader cannot find on the project they want to give a rule to. The bar it opens is the SAME grey strip the host
// chip opens (`.host-form`), and the two share ONE stack per project so a rules bar opened while the host bar is up
// sits directly ABOVE it - the most recently opened bar on top.
// Only the editor's numbers BEFORE the first read answers (`/api/project-rules` carries the real pair, from
// lib/project-rules.js, and `state.ruleCaps` replaces these the moment a bar is opened).
const RULES_FALLBACK_CAPS = { max: 40, maxChars: 200 };

function rulesCaps() {
  const caps = state.ruleCaps;
  return caps && Number.isFinite(caps.max) && Number.isFinite(caps.maxChars) ? caps : RULES_FALLBACK_CAPS;
}

// A project's list, as the page holds it. Absence reads as empty, the same rule lib/project-rules.js applies.
function rulesFor(name) {
  const list = state.projects.get(name)?.rules;
  return Array.isArray(list) ? list : [];
}

function rulesBarOpen(name) {
  return barsOf(name).includes("rules");
}

function rulesChipSig(name) {
  return `${rulesFor(name).length}|${rulesBarOpen(name) ? "1" : "0"}`;
}

function rulesChipHtml(name) {
  const n = rulesFor(name).length;
  const open = rulesBarOpen(name);
  const title = n
    ? `${n} rule${n === 1 ? "" : "s"} for ${name} - one line each, read in this order. Click to open the rules bar and add, edit, reorder or delete one.`
    : `${name} has no rules yet. Click to open the rules bar and write one - a one-line rule a worker in this project is meant to obey.`;
  return `<button type="button" class="btn-rules${n ? " has-rules" : ""}${open ? " is-open" : ""}" data-rules-chip="${esc(name)}" data-rules-project="${esc(name)}" data-rules-sig="${esc(rulesChipSig(name))}" aria-expanded="${open ? "true" : "false"}" title="${esc(title)}">rules: ${n}</button>`;
}

// Repaint the chip in place when the count or the open state moved. The same reasoning as `refreshChips`: a snapshot
// ticks every few seconds and rebuilding a node that reads exactly as it did is pure churn.
//
// The node is found through `projectNode` (public/dom.js) rather than a bare `document.querySelector`, because this
// runs on that same per-snapshot path and a by-attribute walk cannot use the id/class fast paths: the cached node is
// what makes the second refresh of a project ask the document NOTHING (test/board-lookups.test.js counts it).
function refreshRulesChip(name) {
  const el = projectNode("data-rules-chip", name);
  if (!el) return;
  if (el.dataset.rulesSig === rulesChipSig(name)) return;
  el.outerHTML = rulesChipHtml(name);
}

// ---- a project's turnover branch: the chip, and the one field it opens ------------------------------------------
// The branch a cut for this project starts from, and the branch a worker's work rolls up into before anybody lands
// it (lib/project-turnover.js). It is a reader-set fact on the project's `config.json` row, so the snapshot carries
// it on the project record and the chip paints from the first snapshot; `/api/project-turnover` is the read the bar
// opens with and the write the save goes through. The chip is the fourth of the head line: host (where the links
// come from), rules (what a worker here is told), turnover (where its work goes), board (who claims the repo now).
//
// The editor's cap BEFORE the first read answers; `/api/project-turnover` carries the real one and `state.turnoverCaps`
// replaces this the moment a bar is opened - the same pair of numbers the writer refuses past.
const TURNOVER_FALLBACK_MAX = 120;

function turnoverMaxChars() {
  const n = Number(state.turnoverCaps?.maxChars);
  return Number.isFinite(n) && n > 0 ? n : TURNOVER_FALLBACK_MAX;
}

function turnoverFor(name) {
  return String(state.projects.get(name)?.turnoverBranch || "").trim();
}

// Which BASE-REF KIND this project's cuts are made on. The snapshot carries the normalised answer (lib/projects.js
// `baseRefKindOf`), so a project that names a branch and states no kind reads `turnover` here exactly as the cut
// reads it; a project with neither reads `checkout`.
function turnoverKindFor(name) {
  const p = state.projects.get(name);
  const kind = String(p?.baseRefKind || "").trim();
  if (kind === "local-turnover" || kind === "turnover" || kind === "checkout") return kind;
  return turnoverFor(name) ? "turnover" : "checkout";
}

const TURNOVER_KINDS = ["checkout", "turnover", "local-turnover"];
const TURNOVER_KIND_LABELS = {
  checkout: "the checkout's own branch",
  turnover: "the named turnover branch",
  "local-turnover": "local turnover branch - ask if none exist",
};

// The chip's short answer for a kind: the third kind has no name to print, because it has no name yet - it is found
// at the cut, and asking is what happens when nothing is found.
function turnoverKindShort(name) {
  const kind = turnoverKindFor(name);
  if (kind === "local-turnover") return "local turnover";
  return turnoverFor(name) || "none";
}

function turnoverBarOpen(name) {
  return barsOf(name).includes("turnover");
}

function turnoverChipSig(name) {
  return `${turnoverFor(name)}|${turnoverKindFor(name)}|${turnoverBarOpen(name) ? "1" : "0"}`;
}

function turnoverChipHtml(name) {
  const branch = turnoverFor(name);
  const kind = turnoverKindFor(name);
  const open = turnoverBarOpen(name);
  const title = kind === "local-turnover"
    ? `${name} is cut on a local turnover branch: a pushed, unmerged branch named YYYYMMDD_HHMM_<KEY>_<slug>. If no branch qualifies the panel asks instead of cutting from main. Click to change.`
    : branch
      ? `${name}'s turnover branch is ${branch} - a tree cut for this project starts from it, and its worker merges back into it LOCALLY (no push, no pull request). Click to change or clear it.`
      : `${name} has no turnover branch. A tree cut for it starts from whatever the checkout is standing on, so a checkout on main briefs its worker to push and open a pull request. Click to name the branch this project's work rolls up into.`;
  return `<button type="button" class="btn-turnover${branch || kind === "local-turnover" ? " has-turnover" : ""}${open ? " is-open" : ""}" data-turnover-chip="${esc(name)}" data-turnover-project="${esc(name)}" data-turnover-sig="${esc(turnoverChipSig(name))}" aria-expanded="${open ? "true" : "false"}" title="${esc(title)}">turnover: ${esc(turnoverKindShort(name))}</button>`;
}

// Repaint the chip in place when the branch or the open state moved - the same rule refreshRulesChip applies, on the
// same per-snapshot path, through the same cached node lookup.
function refreshTurnoverChip(name) {
  const el = projectNode("data-turnover-chip", name);
  if (!el) return;
  if (el.dataset.turnoverSig === turnoverChipSig(name)) return;
  el.outerHTML = turnoverChipHtml(name);
}

function turnoverLine(name) {
  const kind = turnoverKindFor(name);
  const branch = turnoverFor(name);
  if (kind === "local-turnover") return `${name}: cut on ${TURNOVER_KIND_LABELS[kind]}`;
  return branch ? `${name}: work rolls up into ${branch}` : `${name}: no turnover branch - a cut starts where the checkout stands`;
}

function turnoverBarHtml(name) {
  if (!turnoverBarOpen(name)) return "";
  const bar = state.turnoverBar?.project === name ? state.turnoverBar : null;
  const branch = turnoverFor(name);
  const kind = turnoverKindFor(name);
  const busy = bar?.busy ? " disabled" : "";
  const kinds = TURNOVER_KINDS.map(
    (k) => `<option value="${esc(k)}"${kind === k ? " selected" : ""}>${esc(TURNOVER_KIND_LABELS[k])}</option>`,
  ).join("");
  const local = kind === "local-turnover";
  return `<div class="host-form turnover-form" data-turnover-bar="${esc(name)}">
      <span class="mono host-line${bar?.error ? " clone-err" : ""}" data-turnover-status>${esc(bar?.line || turnoverLine(name))}</span>
      <span class="turnover-body">
        <label class="turnover-kind" title="where a tree cut for this project starts: the checkout's own branch, the branch named here, or a local turnover branch the panel finds">kind <select class="turnover-select" data-turnover-kind="${esc(name)}" aria-label="the base-ref kind for ${esc(name)}"${busy}>${kinds}</select></label>
        <input class="mono turnover-input" type="text" maxlength="${turnoverMaxChars()}" data-turnover-input="${esc(name)}" value="${esc(branch)}" placeholder="a branch name, e.g. feature/turnover"${busy}${local ? " disabled" : ""} data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" spellcheck="false" aria-label="the turnover branch for ${esc(name)}">
        <button type="button" data-turnover-save="${esc(name)}" title="store this kind and branch on the project's config.json row; an empty field clears the branch"${busy}>save</button>
        <button type="button" data-turnover-close="${esc(name)}" title="close the turnover bar">close</button>
      </span>
      <span class="mono dimmer turnover-hint">${esc(
        local
          ? "A tree cut for this project starts from the newest local branch that is named YYYYMMDD_HHMM_<KEY>_<slug>, pushed to a remote, and not an ancestor of main or master. When no branch qualifies the panel asks instead of cutting from main."
          : "A tree cut for this project starts from this branch. Its worker merges back into it locally and does not push or open a pull request. Empty means no turnover branch: a cut starts where the checkout stands.",
      )}</span>
    </div>`;
}

async function toggleTurnoverBar(name) {
  if (turnoverBarOpen(name)) {
    closeTurnoverBar(name);
    return;
  }
  state.turnoverBar = { project: name, line: turnoverLine(name), busy: false, error: false };
  openBar(name, "turnover");
  repaintBars(name);
  refreshTurnoverChip(name);
  try {
    const res = await apiFetch(`/api/project-turnover?project=${encodeURIComponent(name)}`);
    const out = await res.json().catch(() => ({}));
    if (state.turnoverBar?.project !== name) return;
    if (!res.ok) {
      state.turnoverBar = { ...state.turnoverBar, error: true, line: out.error || `could not read the turnover branch (HTTP ${res.status})` };
      repaintBar(name, "turnover");
      return;
    }
    // The cap travels with the read, so the field's `maxlength` and the writer's refusal are one number.
    if (Number.isFinite(Number(out.maxChars))) state.turnoverCaps = { maxChars: Number(out.maxChars) };
    const p = state.projects.get(name);
    if (p) p.turnoverBranch = String(out.turnoverBranch || "");
    if (p && out.baseRefKind) p.baseRefKind = String(out.baseRefKind);
    state.turnoverBar = { project: name, line: turnoverLine(name), busy: false, error: false };
    repaintBar(name, "turnover");
    refreshTurnoverChip(name);
  } catch (e) {
    if (state.turnoverBar?.project !== name) return;
    state.turnoverBar = { ...state.turnoverBar, busy: false, error: true, line: `could not read the turnover branch: ${e.message}` };
    repaintBar(name, "turnover");
  }
}

function closeTurnoverBar(name) {
  if (state.turnoverBar?.project === name) state.turnoverBar = null;
  closeBar(name, "turnover");
  repaintBars(name);
  refreshTurnoverChip(name);
}

// ONE save. The value is read off the field BEFORE the repaint that shows "saving" (a paint rebuilds the field from
// state, so reading it afterwards would save the old name). A refusal keeps what the server holds and says why on the
// bar's own line, so a typed branch is never silently dropped.
async function saveProjectTurnover(name) {
  const input = document.querySelector(`[data-turnover-input="${CSS.escape(name)}"]`);
  const select = document.querySelector(`[data-turnover-kind="${CSS.escape(name)}"]`);
  const kind = String(select?.value || "").trim() || turnoverKindFor(name);
  // The third kind has no name to send: it is found at the cut, so a branch left in the field is not this selection's
  // and must not be stored beside it.
  const typed = String(input?.value || "").replace(/\s+/g, " ").trim();
  const value = kind === "local-turnover" ? "" : typed;
  const bar = state.turnoverBar?.project === name ? state.turnoverBar : { project: name };
  state.turnoverBar = { ...bar, busy: true, error: false, line: "saving..." };
  repaintBar(name, "turnover");
  try {
    const res = await apiFetch(
      "/api/project-turnover",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: name, turnoverBranch: value, baseRefKind: kind }) },
      { timeoutMs: 20000 },
    );
    const out = await res.json().catch(() => ({}));
    if (state.turnoverBar?.project !== name) return false;
    if (!res.ok) {
      state.turnoverBar = { ...state.turnoverBar, busy: false, error: true, line: out.error || `could not save the turnover branch (HTTP ${res.status})` };
      repaintBar(name, "turnover");
      return false;
    }
    // The server's answer, never the request echoed back: a name the writer trimmed reads as the writer stored it.
    const p = state.projects.get(name);
    if (p) p.turnoverBranch = String(out.turnoverBranch || "");
    if (p && out.baseRefKind) p.baseRefKind = String(out.baseRefKind);
    state.turnoverBar = { project: name, busy: false, error: false, line: out.note || turnoverLine(name) };
    repaintBar(name, "turnover");
    refreshTurnoverChip(name);
    return true;
  } catch (e) {
    if (state.turnoverBar?.project !== name) return false;
    state.turnoverBar = { ...state.turnoverBar, busy: false, error: true, line: `could not save the turnover branch: ${e.message}` };
    repaintBar(name, "turnover");
    return false;
  }
}

// ---- a project's board: the chip, and the claims it opens ------------------------------------------------------
// The repo's own coordination board is `.agentboard/{PID}.json` at the checkout root (lib/activity.js
// boardEntries): one file per claim, alive while its PID is in the process list. The server summarises it on the
// project record (`p.board` = total / live[] / dead, projectBoardSummary), so the page has the split without a
// round trip of its own.
//
// The chip replaces the sentence this head line used to carry - "board: no live entries (0 stale)" - and it is
// the third chip of the line, after host: (where the links come from) and rules: (what a worker here is told):
// "board: N" is who claims this repo right now. The sentence was the only one of the three facts you could not
// press, so the one with records behind it had nowhere to go; the bar below is where they are listed.
function boardOf(name) {
  const b = state.projects.get(name)?.board;
  if (!b) return null;
  return { total: Number(b.total) || 0, live: Array.isArray(b.live) ? b.live : [], dead: Number(b.dead) || 0 };
}

function boardBarOpen(name) {
  return barsOf(name).includes("board");
}

// The chip's node is kept and swapped only when what it reads moved - the count, the stale figure, or the bar's
// open state - the same rule refreshRulesChip applies, on the same per-snapshot path.
function boardChipSig(name) {
  const b = boardOf(name);
  return `${b ? b.live.length : "x"}|${b ? b.dead : "x"}|${boardBarOpen(name) ? "1" : "0"}`;
}

function boardChipHtml(name) {
  const b = boardOf(name);
  if (!b) return "";
  const live = b.live.length;
  const open = boardBarOpen(name);
  const stale = b.dead ? ` (${b.dead} stale)` : "";
  const title = live
    ? `board: ${live} claim${live === 1 ? "" : "s"} in this repo's .agentboard name a PID that is alive right now${stale} - click to open the board and read who claims it`
    : `board: no live entries${b.dead ? stale : " (0 stale)"} - no .agentboard claim in this repo names a live PID; click to open the board`;
  return `<button type="button" class="btn-board${live ? " is-live" : ""}${open ? " is-open" : ""}" data-board-chip="${esc(name)}" data-board-project="${esc(name)}" data-board-sig="${esc(boardChipSig(name))}" aria-expanded="${open ? "true" : "false"}" title="${esc(title)}">board: ${live}</button>`;
}

function refreshBoardChip(name) {
  const el = projectNode("data-board-chip", name);
  if (!el) return;
  if (el.dataset.boardSig === boardChipSig(name)) return;
  el.outerHTML = boardChipHtml(name);
}

function boardLine(name, b) {
  const dir = `${String(state.projects.get(name)?.path || name).replace(/\\/g, "/")}/.agentboard`;
  if (!b) return `this project has no board summary yet - the next scan reads ${dir}`;
  return `${b.live.length} live claim${b.live.length === 1 ? "" : "s"} · ${b.dead} stale · ${dir}`;
}

function boardBarHtml(name) {
  if (!boardBarOpen(name)) return "";
  const b = boardOf(name);
  const rows = b ? b.live.map((e, i) => `<span class="board-row mono" data-board-entry="${i}"><span class="board-pid">pid ${esc(String(e.pid ?? "?"))}</span><span class="board-goal">${e.goal ? esc(String(e.goal)) : "<span class=\"dimmer\">no goal recorded</span>"}</span></span>`) : [];
  const body = rows.length ? rows.join("") : `<span class="board-empty mono dimmer">${b ? `no live entries (${b.dead} stale)` : "not read yet"}</span>`;
  return `<div class="host-form board-form" data-board-bar="${esc(name)}">
      <span class="mono host-line" data-board-line>${esc(boardLine(name, b))}</span>
      <span class="board-body">${body}</span>
      <button type="button" data-board-close="${esc(name)}" title="close the board">close</button>
    </div>`;
}

function toggleBoardBar(name) {
  if (boardBarOpen(name)) {
    closeBoardBar(name);
    return;
  }
  openBar(name, "board");
  repaintBars(name);
  refreshBoardChip(name);
}

function closeBoardBar(name) {
  closeBar(name, "board");
  repaintBars(name);
  refreshBoardChip(name);
}

// ---- the cleanup chip -------------------------------------------------------------------------------------------
// The fifth chip of the project head line, beside host, rules, turnover and board: one press reads every worktree of
// this project (the dry run), a second press does what the plan allowed (the apply), and the run leaves a page in the
// target repo with a row per worktree and the keep-or-drop call behind it.
//
// TWO PRESSES, not one, and the label says which press is next. A one-press delete of every merged tree in a project
// is not a control this board should carry: the plan is a read the reader can look at (it opens the page), and the
// press that acts only arms once that page exists. The chip never guesses at the state either - `cleanupStateCache`
// holds the last answer the server sent, keyed by project, and every label is drawn from it.
//
// The chip does not remove anything itself: a drop row's button posts the panel's OWN delete route
// (POST /api/worktree/delete), so a cleanup cannot arrive one guard short of the row's x. `keep` writes nothing at
// all - it drops the call from this list, which is the only thing the server has to do about a tree it kept.
let cleanupStateCache = null;
function cleanupRuns() {
  if (!cleanupStateCache) cleanupStateCache = new Map();
  return cleanupStateCache;
}

function cleanupOf(name) {
  return cleanupRuns().get(name) || null;
}

// What the chip needs to know changed, so a repaint of the strip does not rebuild a node nothing about it moved.
function cleanupChipSig(name) {
  const c = cleanupOf(name);
  if (!c) return "idle";
  // The drop-all's progress is in the signature: its label is a count that moves once per row, and a signature that
  // did not carry it would freeze the chip at "dropping 0 of 41" until the run ended.
  const prog = c.dropAll ? `:${c.dropAll.done}/${c.dropAll.total}` : "";
  return `${c.phase}:${c.plan?.counts?.remove ?? ""}:${c.plan?.counts?.merge ?? ""}:${c.run?.counts?.remove ?? ""}:${c.report?.path || ""}:${c.error ? "err" : "ok"}${prog}`;
}

function cleanupChipHtml(name) {
  const c = cleanupOf(name);
  const phase = c?.phase || "idle";
  const counts = c?.run?.counts || c?.plan?.counts || {};
  let label = "cleanup";
  let cls = "";
  let title = "read every worktree of this project and plan a cleanup: the trees and branches already in main, the branches still holding work, the locked and live ones this will not touch - nothing is removed until a second press";
  if (phase === "planning") {
    label = "cleanup: reading";
    cls = " is-busy";
    title = "reading every worktree of this project - a git status, a rev-list and a git cherry per tree";
  } else if (phase === "armed") {
    // The press acts on BOTH kinds of row. A plan with no drops but two merges still moves two branches, so a pill that
    // read "0 to drop" over a press that merges would be the one label that lies about what the second press does.
    const drop = Number(counts.remove) || 0;
    const merge = Number(counts.merge) || 0;
    const parts = [];
    if (drop) parts.push(`${drop} to drop`);
    if (merge) parts.push(`${merge} to merge`);
    label = parts.length ? `cleanup: ${parts.join(", ")} · apply` : "cleanup: nothing to do";
    cls = parts.length ? " is-armed" : "";
    title = parts.length
      ? `${drop} worktree${drop === 1 ? "" : "s"} and branch${drop === 1 ? "" : "es"} can go, ${merge} branch${merge === 1 ? "" : "es"} would be merged into a child, ${Number(counts.keep) || 0} kept and ${Number(counts.skip) || 0} left alone - press to APPLY, or read the plan page first`
      : `the plan has no row to act on - ${Number(counts.keep) || 0} kept and ${Number(counts.skip) || 0} left alone, so a second press only reads the project again`;
  } else if (phase === "applying") {
    label = "cleanup: applying";
    cls = " is-busy";
    title = "removing the trees the plan dropped and merging the branches it kept - no force, no push";
  } else if (phase === "dropping") {
    // The drop-all's own phase, distinct from the plan's apply: it removes one row at a time through the panel's
    // single-row delete and never merges anything, so it must not borrow the apply's words.
    const d = c.dropAll || {};
    label = `cleanup: dropping ${Number(d.done) || 0} of ${Number(d.total) || 0}`;
    cls = " is-busy";
    title = `dropping the worktrees labelled drop, one at a time through the panel's own delete route: ${Number(d.done) || 0} of ${Number(d.total) || 0}${d.name ? `, now ${d.name}` : ""} - a refusal is listed and the run carries on`;
  } else if (phase === "done") {
    label = `cleanup: ${Number(counts.remove) || 0} dropped · ${Number(counts.merge) || 0} merged`;
    cls = " is-done";
    title = `done at ${c.at || ""}${c.report?.path ? ` - report: ${c.report.path}` : ""} - press to read the project again`;
  } else if (phase === "error") {
    label = `cleanup failed: ${c.failing || name}`;
    cls = " is-error";
    title = `${c.error || "the run failed"} - the repo that failed is ${c.failing || name}`;
  }
  return `<button type="button" class="btn-cleanup${cls}" data-cleanup-chip="${esc(name)}" data-cleanup-sig="${esc(cleanupChipSig(name))}" title="${esc(title)}">${esc(label)}</button>`;
}

function refreshCleanupChip(name) {
  const el = projectNode("data-cleanup-chip", name);
  if (!el) return;
  if (el.dataset.cleanupSig === cleanupChipSig(name)) return;
  el.outerHTML = cleanupChipHtml(name);
}

// The row's short name, so the bar reads as a list of trees rather than a list of paths.
function cleanupTreeName(row) {
  const p = String(row?.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

function cleanupRowHtml(name, row) {
  const call = row.call === "drop" ? "drop" : "keep";
  const verdict = String(row.verdict || "keep");
  const answered = Boolean(row.result);
  const why = String(row.result?.why || row.reason || "");
  const branch = row.branch ? `<code>${esc(row.branch)}</code>` : `<span class="dimmer">no branch</span>`;
  // While another cleanup action runs, the per-row call is not pressable either: the drop-all removes one row at a
  // time through this same route, and a row's own press would join it.
  const frozen = cleanupDropAllBusy(name) ? ' disabled aria-disabled="true"' : "";
  // One button per call, and it only ever asks the server for something the server already offers: `drop` posts the
  // row's own delete route, `keep` writes nothing and takes the call off this list.
  const button = call === "drop"
    ? `<button type="button" class="cleanup-call is-drop" data-cleanup-call="drop" data-cleanup-project="${esc(name)}" data-cleanup-path="${esc(row.path || "")}" data-cleanup-branch="${esc(row.branch || "")}"${frozen} title="remove this worktree with the panel's own delete path - the branch stays, and the same locks and live jobs guard it">drop</button>`
    : `<button type="button" class="cleanup-call is-keep" data-cleanup-call="keep" data-cleanup-project="${esc(name)}" data-cleanup-path="${esc(row.path || "")}"${frozen} title="the plan keeps this one - press to take it off this list; nothing is written">keep</button>`;
  const merge = row.merge && row.merge.ok
    ? `<span class="cleanup-merge mono" title="merged --no-ff into a child of ${esc(row.merge.base || "")}">${esc(row.merge.child || "")} · ${Number(row.merge.files) || 0} file${Number(row.merge.files) === 1 ? "" : "s"} · ${Number(row.merge.bytes) || 0} bytes</span>`
    : "";
  return `<div class="cleanup-row${answered ? " is-done" : ""}" data-cleanup-row="${esc(row.path || "")}">
        <span class="cleanup-name mono" title="${esc(row.path || "")}">${esc(cleanupTreeName(row))}</span>
        <span class="cleanup-branch">${branch}</span>
        <span class="cleanup-verdict v-${esc(verdict)}">${esc(verdict)}</span>
        ${merge}
        <span class="cleanup-why dimmer" title="${esc(why)}">${esc(why)}</span>
        ${button}
      </div>`;
}

function cleanupBarHtml(name) {
  const c = cleanupOf(name);
  if (!c || !c.plan) return "";
  const rows = (c.run?.rows || c.plan.rows || []).filter((r) => !c.dismissed?.has?.(r.path));
  const counts = c.run?.counts || c.plan.counts || {};
  // While the drop-all runs, the line IS the progress ("dropping 12 of 41 - <name>"): one row at a time, in place,
  // instead of a count that only moves when the whole run ends.
  const dropping = c.phase === "dropping" && c.dropAll ? c.dropAll : null;
  const what = dropping
    ? `dropping ${Number(dropping.done) || 0} of ${Number(dropping.total) || 0}${dropping.name ? ` - ${dropping.name}` : ""}`
    : c.run
      ? `${counts.remove || 0} dropped, ${counts.merge || 0} merged, ${(counts.keep || 0) + (counts.skip || 0)} left alone${counts.failed ? `, ${counts.failed} failed` : ""}`
      : `${counts.remove || 0} to drop, ${counts.merge || 0} to merge, ${counts.keep || 0} kept, ${counts.skip || 0} left alone - nothing has been touched yet`;
  const report = c.report?.path ? ` · report <code>${esc(c.report.path)}</code>` : "";
  const body = rows.length
    ? rows.map((r) => cleanupRowHtml(name, r)).join("")
    : `<span class="cleanup-empty dimmer mono">every call on this list has been answered</span>`;
  return `<div class="host-form cleanup-form" data-cleanup-bar="${esc(name)}">
      <span class="mono host-line" data-cleanup-line>${esc(name)}: ${esc(what)}${report}</span>
      ${cleanupDropAllBlockHtml(name)}
      <div class="cleanup-rows">${body}</div>
      <span class="cleanup-actions">
        ${cleanupDropAllButtonHtml(name)}
        ${c.report?.path ? `<button type="button" data-cleanup-open="${esc(name)}" title="open the plan page the run wrote in ${esc(name)}">open report</button>` : ""}
        <button type="button" data-cleanup-close="${esc(name)}" title="close this list; the chip keeps its state">close</button>
      </span>
    </div>`;
}

// The rows a second press would act on: a drop removes, a merge moves a branch. Both are acts; either one earns the press.
function cleanupActs(c) {
  const counts = c?.plan?.counts || {};
  return (Number(counts.remove) || 0) + (Number(counts.merge) || 0);
}

// The chip's own press: the first is the dry run, the second applies the plan it left armed.
async function runCleanupChip(name) {
  const cur = cleanupOf(name);
  if (cur && (cur.phase === "planning" || cur.phase === "applying")) return;
  // Armed with nothing to act on is not an apply: it would write an "APPLIED" report about an empty plan. The press
  // reads the project again instead, which is what the chip's own label says it will do.
  const apply = Boolean(cur && cur.phase === "armed" && cleanupActs(cur) > 0);
  const next = { ...(cur || {}), phase: apply ? "applying" : "planning", error: "", failing: "", dismissed: cur?.dismissed || new Set() };
  cleanupRuns().set(name, next);
  refreshCleanupUi(name);
  openBar(name, "cleanup");
  repaintBars(name);
  try {
    const res = await apiFetch(`/api/projects/${encodeURIComponent(name)}/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: !apply }),
    }, { timeoutMs: apply ? 300000 : 180000 });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status} from the panel`);
    const at = new Date().toLocaleTimeString();
    // An apply answers 200 even when a single row failed: the plan ran, and one tree refused it. That is an ERROR
    // state, and the repo that failed is the tree in that row, so the chip names it rather than the project.
    const failedRow = apply ? (body.run?.rows || []).find((r) => r.result && r.result.ok === false) || null : null;
    cleanupRuns().set(name, {
      phase: apply ? (failedRow ? "error" : "done") : "armed",
      plan: body.plan || next.plan || null,
      run: apply ? body.run || null : null,
      report: body.report || null,
      at,
      error: failedRow ? String(failedRow.result?.why || "the row failed") : "",
      failing: failedRow ? cleanupTreeName(failedRow) : "",
      dismissed: new Set(),
    });
    refreshCleanupUi(name);
    repaintBars(name);
    // The page the run wrote is the point of the press: open it, through the panel's own opener, once the run ends.
    // A page that could NOT be written is said out loud: the run still happened, and a silent missing report is the
    // one outcome the reader cannot check.
    const target = body.report?.absPath || body.report?.path;
    if (target) void openQuestionFile(target);
    else if (body.report?.error) showBanner(`${name}: cleanup ran but its report was not written - ${body.report.error}`);
    if (apply) {
      const c = body.run?.counts || {};
      showBanner(`${name}: cleanup dropped ${c.remove || 0}, merged ${c.merge || 0}, left ${(c.keep || 0) + (c.skip || 0)} alone${c.failed ? `, ${c.failed} failed` : ""}`);
      // The rows changed under the board: ask for the snapshot rather than wait up to 30s for the next one.
      void resync();
    }
  } catch (e) {
    cleanupRuns().set(name, {
      ...next,
      phase: "error",
      error: String((e && e.message) || e),
      // The repo that failed: the project the press was about. It is named in the chip and in its tooltip, because a
      // banner over a board of twenty projects does not say which one broke.
      failing: name,
    });
    refreshCleanupUi(name);
    repaintBars(name);
    showBanner(`${name}: cleanup failed - ${String((e && e.message) || e)}`);
  }
}

// A keep-or-drop call from the bar. `drop` asks the panel's own delete route; `keep` writes nothing.
async function answerCleanupCall(kind, button) {
  const name = button?.dataset?.cleanupProject || "";
  const treePath = button?.dataset?.cleanupPath || "";
  if (!name || !treePath) return;
  if (kind === "keep") {
    const cur = cleanupOf(name);
    if (cur) {
      cur.dismissed = cur.dismissed || new Set();
      cur.dismissed.add(treePath);
      repaintBars(name);
    }
    return;
  }
  button.disabled = true;
  button.textContent = "dropping";
  try {
    const res = await apiFetch("/api/worktree/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: name, path: treePath, branch: button.dataset.cleanupBranch || null }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status} from the panel`);
    const cur = cleanupOf(name);
    if (cur) {
      cur.dismissed = cur.dismissed || new Set();
      cur.dismissed.add(treePath);
    }
    repaintBars(name);
    void resync();
  } catch (e) {
    button.disabled = false;
    button.textContent = "drop";
    showBanner(`${name}: drop refused - ${String((e && e.message) || e)}`);
  }
}

function closeCleanupBar(name) {
  closeBar(name, "cleanup");
  repaintBars(name);
  refreshCleanupUi(name);
}

// ---- the cleanup chip's drop-all -----------------------------------------------------------------------------
// One button beside the chip (and the same button in the bar the chip opens), reading "drop all 41 suggested" with
// the count taken live from the plan. It acts on exactly the rows carrying the drop label and on nothing else: the
// selection is `wtCleanupDropAll.isDropSuggested` (public/core/cleanup-drop-all.js), a named predicate the unit tests
// call, not a selector written into this handler.
//
// THE PRESS IS TWO STEPS. The button opens a confirm that states the exact count and names every class it will not
// touch (the classes come from the same rows, so the numbers add up to the whole plan); the confirm's own button is
// focused the moment it opens, so the whole gesture is reachable from the keyboard. The confirm closes on Escape.
//
// THE RUN is the panel's own single-row delete, once per row (POST /api/worktree/delete), the same route the row's x
// and the per-row drop button use: no second deletion path, the same guards, the same history entry. Before the
// first drop the plan is read again - the confirm may be minutes old, and a tree that has picked up a commit or an
// uncommitted file since then is one the planner no longer calls drop. That row is refused with the fresh plan's own
// sentence and listed; the run carries on past it. A refusal from the remover is collected the same way. At the end
// the chip and this button are redrawn from a fresh read (so the count is the new state), the report path is the page
// that read wrote, and the list says what was removed and what was refused and why.
function cleanupDropAllBusy(name) {
  const c = cleanupOf(name);
  return Boolean(c && (c.phase === "planning" || c.phase === "applying" || c.phase === "dropping"));
}

function cleanupDropAllSig(name) {
  const c = cleanupOf(name);
  const rows = Array.isArray(c?.plan?.rows) ? c.plan.rows : [];
  const prog = c?.dropAll ? `${c.dropAll.done}/${c.dropAll.total}` : "";
  return `${c?.plan ? "plan" : "none"}:${wtCleanupDropAll.dropAllCount(rows)}:${cleanupDropAllBusy(name) ? "busy" : "ready"}:${prog}`;
}

// The one button, drawn in two places: the project head line (before the cleanup chip) and the bar's action row.
// It is drawn from the first render, like the chip, so a refresh always has a node to correct rather than having to
// create one: with no plan read yet it reads "nothing to drop" and says why in its tooltip.
function cleanupDropAllButtonHtml(name) {
  const c = cleanupOf(name);
  const rows = Array.isArray(c?.plan?.rows) ? c.plan.rows : [];
  const busy = cleanupDropAllBusy(name);
  const disabled = wtCleanupDropAll.dropAllDisabled(rows, { busy });
  const label = wtCleanupDropAll.dropAllLabel(rows);
  const title = !c?.plan
    ? "press the cleanup chip first: this button drops the worktrees that plan labels drop, and nothing has been read yet"
    : busy && wtCleanupDropAll.dropAllCount(rows)
      ? "another cleanup action is running in this project - this button is unavailable until it ends"
      : wtCleanupDropAll.dropAllTitle(rows);
  return `<button type="button" class="btn-cleanup-drop-all${disabled ? " is-off" : ""}" data-cleanup-drop-all="${esc(name)}" data-cleanup-drop-all-sig="${esc(cleanupDropAllSig(name))}"${disabled ? ' disabled aria-disabled="true"' : ""} title="${esc(title)}">${esc(label)}</button>`;
}

function refreshCleanupDropAll(name) {
  // The head line's copy, found by the same cached attribute lookup the chip uses (`projectNode`), so a snapshot's
  // repaint costs one lookup rather than a whole-document walk per row placed. The bar's copy is not refreshed here:
  // `repaintBars` rebuilds that block from `cleanupBarHtml`, which draws this button itself.
  const el = projectNode("data-cleanup-drop-all", name);
  if (!el) return;
  if (el.dataset.cleanupDropAllSig === cleanupDropAllSig(name)) return;
  const html = cleanupDropAllButtonHtml(name);
  if (html) el.outerHTML = html;
  else el.remove();
}

// One call for both controls: the chip and the button beside it are drawn from the same state, so every place that
// repaints one repaints the other.
function refreshCleanupUi(name) {
  refreshCleanupChip(name);
  refreshCleanupDropAll(name);
}

// The confirm, the run's progress and the list of what was refused: one block, in the bar the chip opens.
function cleanupDropAllBlockHtml(name) {
  const c = cleanupOf(name);
  if (!c || !c.plan) return "";
  const rows = Array.isArray(c.plan.rows) ? c.plan.rows : [];
  const out = [];
  if (c.confirmOpen) {
    const n = wtCleanupDropAll.dropAllCount(rows);
    out.push(`<div class="cleanup-confirm" data-cleanup-confirm="${esc(name)}" role="dialog" aria-modal="false" aria-label="confirm dropping every worktree labelled drop" aria-live="polite">
          <span class="cleanup-confirm-text">${esc(wtCleanupDropAll.dropAllConfirmText(rows))}</span>
          <button type="button" class="cleanup-confirm-go" data-cleanup-confirm-go="${esc(name)}" title="run the panel's own single-row drop once for each of the ${n} worktrees labelled drop, refusing any tree the plan no longer calls drop">drop ${n}</button>
          <button type="button" class="cleanup-confirm-cancel" data-cleanup-confirm-cancel="${esc(name)}" title="cancel this confirm - nothing is removed">cancel</button>
        </div>`);
  }
  const res = c.dropAllResult;
  if (res) {
    const fails = Array.isArray(res.failures) ? res.failures : [];
    out.push(`<div class="cleanup-drop-all-result${fails.length ? " has-failures" : ""}" data-cleanup-drop-all-result="${esc(name)}">
          <span class="mono">${esc(res.note || wtCleanupDropAll.dropAllNote(res))}</span>
          ${fails.length ? `<ul class="cleanup-drop-failures">${fails
            .map((f) => `<li data-cleanup-drop-all-failure="${esc(f.path || f.name || "")}"><code>${esc(f.name || f.path || "")}</code> <span class="dimmer">${esc(f.why || "")}</span></li>`)
            .join("")}</ul>` : ""}
        </div>`);
  }
  return out.join("");
}

function openCleanupDropAllConfirm(name) {
  const c = cleanupOf(name);
  if (!c || !c.plan) return;
  if (wtCleanupDropAll.dropAllDisabled(c.plan.rows || [], { busy: cleanupDropAllBusy(name) })) return;
  c.confirmOpen = true;
  cleanupRuns().set(name, c);
  openBar(name, "cleanup");
  repaintBars(name);
  refreshCleanupDropAll(name);
  // The confirm is focused, so the press that opened it can be answered from the keyboard alone.
  const go = document.querySelector(`section.project[data-project="${CSS.escape(name)}"] [data-cleanup-confirm-go="${CSS.escape(name)}"]`);
  if (go && typeof go.focus === "function") go.focus();
}

function closeCleanupDropAllConfirm(name) {
  const c = cleanupOf(name);
  if (!c || !c.confirmOpen) return;
  c.confirmOpen = false;
  cleanupRuns().set(name, c);
  repaintBars(name);
}

// The panel's own single-row drop, as one call, so the run below is a loop over rows rather than a second path.
function cleanupDropOne(name) {
  return async (row) => {
    const res = await apiFetch("/api/worktree/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: name, path: row.path, branch: row.branch || null }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) return { ok: false, why: String(body.error || `HTTP ${res.status} from the panel`) };
    return { ok: true, why: "" };
  };
}

// One read of a project's plan: the chip's dry run, and the guard the drop-all asks again before it acts.
async function readCleanupPlan(name) {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(name)}/cleanup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun: true }),
  }, { timeoutMs: 180000 });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status} from the panel`);
  return body;
}

async function runCleanupDropAll(name) {
  const c = cleanupOf(name);
  if (!c || !c.plan || cleanupDropAllBusy(name)) return;
  const planned = Array.isArray(c.plan.rows) ? c.plan.rows : [];
  const selection = wtCleanupDropAll.suggestedDropRows(planned);
  if (!selection.length) return;
  c.confirmOpen = false;
  c.phase = "dropping";
  c.dropAll = { done: 0, total: selection.length, name: "" };
  c.dropAllResult = null;
  c.error = "";
  c.failing = "";
  cleanupRuns().set(name, c);
  refreshCleanupUi(name);
  repaintBars(name);

  let summary;
  try {
    // THE GUARD, asked again: the plan the confirm named its count from, read afresh. A row this read no longer
    // calls drop is refused here, with the fresh plan's own sentence, and never handed to the remover.
    const fresh = await readCleanupPlan(name);
    const guard = wtCleanupDropAll.confirmAgainstFresh({ planned, fresh: (fresh.plan || {}).rows || [] });
    const run = await wtCleanupDropAll.runDropAll({
      rows: guard.rows,
      refused: guard.refused,
      onProgress: ({ done, total, name: tree, path: treePath }) => {
        const cur = cleanupOf(name);
        if (!cur) return;
        cur.dropAll = { done, total, name: tree, path: treePath };
        refreshCleanupUi(name);
        repaintBars(name);
      },
      dropOne: cleanupDropOne(name),
    });
    summary = run.summary;
  } catch (e) {
    const why = String((e && e.message) || e);
    summary = { attempted: 0, dropped: 0, refused: 0, failures: [], note: `nothing was dropped - the plan could not be re-read (${why})` };
  }

  const done = cleanupOf(name) || { dismissed: new Set() };
  done.dropAll = null;
  done.confirmOpen = false;
  done.dropAllResult = summary;
  done.dismissed = new Set();
  done.at = new Date().toLocaleTimeString();
  try {
    // The state AFTER the run, which is what the chip and this button are redrawn from: its counts are the trees
    // that are left, and its page is the report this run leaves behind.
    const after = await readCleanupPlan(name);
    done.plan = after.plan || done.plan;
    done.report = after.report || null;
    done.phase = "armed";
    done.error = "";
    done.failing = "";
  } catch (e) {
    done.phase = "done";
    done.error = String((e && e.message) || e);
    done.failing = "";
  }
  cleanupRuns().set(name, done);
  refreshCleanupUi(name);
  repaintBars(name);
  const refused = Number(summary.refused) || 0;
  showBanner(`${name}: ${summary.note}${refused && summary.failures.length ? " - the refused rows and their reasons are in the cleanup list" : ""}`);
  // The rows changed under the board: ask for the snapshot rather than wait up to 30s for the next one.
  void resync();
}

// ---- end the cleanup chip's drop-all

// ---- the grey strip's stack ------------------------------------------------------------------------------------
// `state.bars` is a Map of project -> the bar KINDS it has open, in the order they were opened. Rendering walks it
// backwards, so the most recent bar is the top one. It is kept here, not only in the DOM, for the same reason the
// host panel's proposal is: a section rebuild (a snapshot with a changed project set, another tab's save) redraws the
// whole project from state, and a bar that lived only in the DOM would go away with the section.
function barsOf(name) {
  const list = state.bars?.get?.(name);
  return Array.isArray(list) ? list : [];
}

function setBarOrder(name, kinds) {
  if (!state.bars) state.bars = new Map();
  if (kinds.length) state.bars.set(name, kinds);
  else state.bars.delete(name);
}

// Opening a bar that is already up MOVES it to the top rather than adding a second copy.
function openBar(name, kind) {
  setBarOrder(name, [...barsOf(name).filter((k) => k !== kind), kind]);
}

function closeBar(name, kind) {
  setBarOrder(name, barsOf(name).filter((k) => k !== kind));
}

// One bar's markup and the attribute that finds its node, by kind. Three kinds now share the strip, so the two
// places that used to spell the pair out in a ternary chain (`projectBarsHtml` and `repaintBar`) ask these instead:
// a fourth kind is one line here, in both, and cannot be added to one and forgotten in the other.
function barHtml(name, kind) {
  if (kind === "host") return hostPanelHtml(name);
  if (kind === "rules") return rulesBarHtml(name);
  if (kind === "turnover") return turnoverBarHtml(name);
  if (kind === "board") return boardBarHtml(name);
  if (kind === "cleanup") return cleanupBarHtml(name);
  return "";
}

function barSelector(kind) {
  if (kind === "host") return "[data-host-form]";
  if (kind === "rules") return "[data-rules-bar]";
  if (kind === "turnover") return "[data-turnover-bar]";
  if (kind === "cleanup") return "[data-cleanup-bar]";
  return "[data-board-bar]";
}

// The stack itself. An empty stack draws nothing at all rather than an empty band.
function projectBarsHtml(name) {
  const kinds = barsOf(name).slice().reverse();
  if (!kinds.length) return "";
  const bars = kinds.map((kind) => barHtml(name, kind)).filter(Boolean);
  if (!bars.length) return "";
  return `<div class="proj-bars" data-bars="${esc(name)}">${bars.join("")}</div>`;
}

// Replace the whole stack: used when the ORDER moved (a bar was opened or closed), which no single-bar repaint can do.
function repaintBars(name) {
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(name)}"]`);
  if (!sec) return;
  const html = projectBarsHtml(name);
  const old = sec.querySelector("[data-bars]");
  if (old) {
    if (html) old.outerHTML = html;
    else old.remove();
    return;
  }
  if (!html) return;
  const head = sec.querySelector(".project-head.meta-line");
  if (head) head.insertAdjacentHTML("afterend", html);
}

// Replace ONE bar inside the stack, leaving its neighbours' nodes (and whatever the reader typed in them) alone.
function repaintBar(name, kind) {
  const holder = document.querySelector(`section.project[data-project="${CSS.escape(name)}"] [data-bars]`);
  if (!holder) {
    // No stack yet: this bar is the first one open for the project.
    repaintBars(name);
    return;
  }
  const html = barHtml(name, kind);
  const old = holder.querySelector(barSelector(kind));
  if (old) {
    if (html) old.outerHTML = html;
    else old.remove();
  } else if (html) {
    // A bar that was opened while this one was already up goes on top, which is the order `openBar` recorded.
    holder.insertAdjacentHTML("afterbegin", html);
  }
  // The last bar to close takes the stack with it, rather than leaving an empty band in the card.
  if (!holder.children.length) holder.remove();
}

// ---- the rules bar and its editor ------------------------------------------------------------------------------
function ruleRowHtml(name, rule, i, count) {
  const busy = state.rulesBar?.project === name && state.rulesBar.busy ? " disabled" : "";
  const caps = rulesCaps();
  return `<span class="rule-row" data-rule-row="${i}">
      <span class="rule-n mono">${i + 1}</span>
      <input class="mono rule-input" type="text" maxlength="${caps.maxChars}" data-rule-text="${i}" data-rule-project="${esc(name)}" value="${esc(rule)}"${busy} data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" spellcheck="false" aria-label="rule ${i + 1} for ${esc(name)}">
      <button type="button" class="rule-btn" data-rule-move="up" data-rule-index="${i}" data-rule-project="${esc(name)}" title="move this rule up - the order is the order a worker reads them in"${busy || i === 0 ? " disabled" : ""}>↑</button>
      <button type="button" class="rule-btn" data-rule-move="down" data-rule-index="${i}" data-rule-project="${esc(name)}" title="move this rule down"${busy || i === count - 1 ? " disabled" : ""}>↓</button>
      <button type="button" class="rule-btn rule-del" data-rule-delete="${i}" data-rule-project="${esc(name)}" title="delete this rule"${busy}>✕</button>
    </span>`;
}

function rulesLine(name) {
  const n = rulesFor(name).length;
  if (!n) return "no rules yet - one line each; the editor below adds one at a time";
  return `${n} rule${n === 1 ? "" : "s"} - one line each, in this order`;
}

function rulesBarHtml(name) {
  const bar = state.rulesBar;
  if (!bar || bar.project !== name) return "";
  const rules = rulesFor(name);
  const busy = bar.busy ? " disabled" : "";
  const caps = rulesCaps();
  const rows = rules.map((rule, i) => ruleRowHtml(name, rule, i, rules.length)).join("");
  return `<div class="host-form rules-form" data-rules-bar="${esc(name)}">
      <span class="mono host-line${bar.error ? " clone-err" : ""}" data-rules-line>${esc(bar.line || rulesLine(name))}</span>
      <span class="rules-body">
        ${rules.length ? `<span class="rules-list">${rows}</span>` : `<span class="rules-empty mono dimmer">no rules for ${esc(name)} yet</span>`}
        <span class="rules-add">
          <input class="mono" type="text" maxlength="${caps.maxChars}" data-rules-new="${esc(name)}" placeholder="a one-line rule for ${esc(name)}"${busy} data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off" spellcheck="false" aria-label="a new rule for ${esc(name)}">
          <button type="button" data-rules-add="${esc(name)}" title="add this line to the project's rules"${busy}>add</button>
          <button type="button" data-rules-close="${esc(name)}" title="close the rules bar">close</button>
        </span>
      </span>
    </div>`;
}

async function toggleRulesBar(name) {
  if (state.rulesBar?.project === name) {
    closeRulesBar(name);
    return;
  }
  state.rulesBar = { project: name, line: "reading the rules…", busy: false, error: false };
  openBar(name, "rules");
  repaintBars(name);
  refreshRulesChip(name);
  try {
    const res = await apiFetch(`/api/project-rules?project=${encodeURIComponent(name)}`);
    const out = await res.json().catch(() => ({}));
    if (state.rulesBar?.project !== name) return;
    if (!res.ok) {
      state.rulesBar = { ...state.rulesBar, error: true, line: out.error || `could not read the rules (HTTP ${res.status})` };
      repaintBar(name, "rules");
      return;
    }
    // The caps travel with the read, so the editor's `maxlength` and the writer's refusal are one pair of numbers.
    if (Number.isFinite(out.max) && Number.isFinite(out.maxChars)) state.ruleCaps = { max: out.max, maxChars: out.maxChars };
    setRules(name, out.rules || []);
    state.rulesBar = { project: name, busy: false, error: false, line: rulesLine(name) };
    repaintBar(name, "rules");
    refreshRulesChip(name);
  } catch (e) {
    if (state.rulesBar?.project !== name) return;
    state.rulesBar = { ...state.rulesBar, busy: false, error: true, line: `could not read the rules: ${e.message}` };
    repaintBar(name, "rules");
  }
}

function closeRulesBar(name) {
  if (state.rulesBar?.project === name) state.rulesBar = null;
  closeBar(name, "rules");
  repaintBars(name);
  refreshRulesChip(name);
}

// The page's copy of a saved list: the project record the chip counts and the bar draws. A save is the server's
// answer, never the request echoed back, so a rule the writer trimmed reads as the writer stored it.
function setRules(name, rules) {
  const p = state.projects.get(name);
  if (p) p.rules = Array.isArray(rules) ? rules.slice() : [];
}

// ONE save, for every gesture. The whole list goes up in the reader's order; a refusal keeps the list the server
// holds and puts the reason on the bar's own line, so a typed rule is never silently dropped.
async function saveProjectRules(name, next, { line = "saving…" } = {}) {
  const bar = state.rulesBar?.project === name ? state.rulesBar : { project: name };
  state.rulesBar = { ...bar, busy: true, error: false, line };
  repaintBar(name, "rules");
  try {
    const res = await apiFetch(
      "/api/project-rules",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: name, rules: next }) },
      { timeoutMs: 20000 },
    );
    const out = await res.json().catch(() => ({}));
    if (state.rulesBar?.project !== name) return false;
    if (!res.ok) {
      state.rulesBar = { ...state.rulesBar, busy: false, error: true, line: out.error || `could not save the rules (HTTP ${res.status})` };
      repaintBar(name, "rules");
      return false;
    }
    setRules(name, out.rules || []);
    state.rulesBar = { project: name, busy: false, error: false, line: out.note || rulesLine(name) };
    repaintBar(name, "rules");
    refreshRulesChip(name);
    return true;
  } catch (e) {
    if (state.rulesBar?.project !== name) return false;
    state.rulesBar = { ...state.rulesBar, busy: false, error: true, line: `could not save the rules: ${e.message}` };
    repaintBar(name, "rules");
    return false;
  }
}

// The add gesture: the new-rule box's text, read BEFORE anything repaints (a paint refills the boxes from state, and
// the click has already moved the caret off the box).
function addRule(name) {
  const box = document.querySelector(`[data-rules-new="${CSS.escape(name)}"]`);
  const text = String(box?.value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) {
    box?.focus();
    return;
  }
  const caps = rulesCaps();
  const rules = rulesFor(name);
  if (rules.length >= caps.max) {
    state.rulesBar = { ...(state.rulesBar || { project: name }), busy: false, error: true, line: `${name} already carries ${caps.max} rules - delete one before adding another` };
    repaintBar(name, "rules");
    return;
  }
  if (text.length > caps.maxChars) {
    state.rulesBar = { ...(state.rulesBar || { project: name }), busy: false, error: true, line: `that line is ${text.length} characters - the cap is ${caps.maxChars}` };
    repaintBar(name, "rules");
    return;
  }
  void saveProjectRules(name, [...rules, text], { line: "adding…" });
}

// An edit arrives from the input's own `change` (blur or Enter). A box the reader emptied is a DELETION they did not
// press ✕ on: nothing is posted, the stored line comes back, and the line says how to delete it. Posting the blank
// would either store it (a rule nobody can read) or drop the row behind their back.
function editRule(name, index, value) {
  const rules = rulesFor(name);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= rules.length) return;
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) {
    state.rulesBar = { ...(state.rulesBar || { project: name }), busy: false, error: true, line: "a rule cannot be blank - press ✕ on its row to delete it, or type the sentence you meant" };
    repaintBar(name, "rules");
    return;
  }
  if (text === rules[i]) return;
  const next = rules.slice();
  next[i] = text;
  void saveProjectRules(name, next, { line: "saving…" });
}

// Reorder: one position up or down, in the reader's hand, saved at once. The arrows are disabled at the ends, so the
// bounds check here is for a hand-written press only.
function moveRule(name, index, dir) {
  const rules = rulesFor(name);
  const i = Number(index);
  const j = dir === "up" ? i - 1 : i + 1;
  if (!Number.isInteger(i) || i < 0 || i >= rules.length || j < 0 || j >= rules.length) return;
  const next = rules.slice();
  [next[i], next[j]] = [next[j], next[i]];
  void saveProjectRules(name, next, { line: `moving rule ${i + 1} ${dir}…` });
}

function deleteRule(name, index) {
  const rules = rulesFor(name);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= rules.length) return;
  const next = rules.filter((_, at) => at !== i);
  void saveProjectRules(name, next, { line: "deleting…" });
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
          <span class="chev">${open ? "▾" : "▸"}</span>
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
      <span class="chev">${open ? "▾" : "▸"}</span>
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

// THE COLLISION CARD reads the RECORD, never a guess of its own. `resolution` is the answer the store gave when the
// worker's note was filed (lib/collisions.js `resolveCounterpart`): another tree, this same tree, or nothing. Only the
// first can be ruled on, and only with measured paths between the two branches - so:
//
//   same tree        "same tree, not a collision", one side drawn, no press at all;
//   no match         the words the worker typed, said back with "no row matches", no press;
//   no shared file   "no shared file" and no press, whether the set is empty or git could not compute it;
//   superseded       in HISTORY only: the landing that ended the pair is named, and there is nothing to press.
//
// THE EVIDENCE IS MEASURED, not the worker's prose: the paths both branches changed against their merge base, printed
// as chips. `evidence.ok === false` says git could not answer, which is a different sentence from "nothing in common"
// and gets its own - a reader is never told a measurement happened when it did not.
//
// THE TWO PRESSES are the ruling: which side goes first. The panel files the priority into both assistants' queues and
// stores it against the PAIR, so the same overlap never asks again - it renders as "already ruled" with the side named
// and a withdraw beside it. "Bring it to me" exists only while the pair is still with the assistants and there is
// evidence to bring: it is the reader's own way in before the pass would have handed it over.
//
// A STAND-DOWN IS SAID OUT LOUD. When one side closed or parked its filed notice the pair stops waiting on the reader,
// and the card says which side yielded and why ("its notice #12 was done") - on both rows. A quiet stand-down is the
// hand reconciliation this surface exists to replace.
function collisionEvidence(rec) {
  const rels = Array.isArray(rec.relations) ? rec.relations : [];
  const bits = [];
  for (const rel of rels) {
    if (rel.kind === "shared-file") bits.push(`both trees touch ${rel.files.length} shared file${rel.files.length === 1 ? "" : "s"}`);
    else if (rel.kind === "merge-target") bits.push(`${rel.branch ? `branch ${rel.branch}` : "one tree"} lands into ${rel.target}`);
    else if (rel.kind === "sibling" || rel.kind === "sibling-turnover")
      bits.push(`both children of ${rel.parent} change ${rel.files.length} of the same file${rel.files.length === 1 ? "" : "s"}`);
  }
  return bits.join("; ");
}

// A SIDE OF THE PAIR, and the TASK that side is working. The tree and its branch were already here; what a reader
// could not see was whether the two sides were on the SAME work or merely both landing into main - which is the whole
// question a collision card exists to answer. So each side names the queue row that owns its tree: the row's number,
// its own title, the assistant whose queue holds it and its state, in that order beside the tree and branch.
//
// TWO PLACES, TWO JOBS. The SUMMARY line wears the whole identity in one line per side - role, tree, branch, task
// number and state - and the task's own title clamped to one line beneath it, so both sides, the shared files and the
// two ruling presses fit above the fold on a 560px card. The full title, the assistant whose queue holds it and the
// tree's path are the side's own accordion section, below.
//
// A tree no queue row owns says so ("no task row on this tree") rather than leaving the line blank: a blank reads as
// "nothing to see" and is exactly the ambiguity this card removes. A row that is done or parked is named with its
// state and the side reads as already stood down, because a collision against finished work is not one the reader
// has to arbitrate.
function collisionTaskChip(task, finished) {
  if (!task) return `<span class="collision-side-task is-none" title="no queue row on this board names this tree in its worktree field">no task row on this tree</span>`;
  return `<span class="collision-side-task${finished ? " is-finished" : ""}" data-collision-task="${esc(task.id)}" data-task-state="${esc(task.state || "")}" title="the queue row that owns this tree, matched on its own worktree field">
      <span class="collision-task" title="the queue task standing in this tree">#${esc(task.id)}</span>
      ${task.state ? `<span class="collision-task-state is-${esc(task.state)}">${esc(task.state)}</span>` : ""}
    </span>`;
}

function collisionSideSummaryHtml(rec, side, mine) {
  if (!side) return "";
  const role = side === rec.a ? "a" : "b";
  const task = side.task || null;
  const finished = Boolean(task && task.open === false);
  return `<div class="collision-side is-${role}${mine ? " is-mine" : " is-other"}${finished ? " is-finished" : ""}" data-collision-side="${role}">
    <div class="collision-side-top">
      <span class="collision-side-role">${mine ? "this row" : "counterpart"}</span>
      <b class="collision-side-name">${esc(side.name || side.path || "a tree")}</b>
      ${side.branch ? `<span class="collision-branch mono" title="branch">${esc(side.branch)}</span>` : ""}
      ${collisionTaskChip(task, finished)}
    </div>
    ${task && task.name ? `<div class="collision-side-title" title="${esc(task.name)}"><span class="collision-task-name">${esc(task.name)}</span></div>` : ""}
  </div>`;
}

// The accordion section's own body: everything the summary line had to clamp or leave out. Labels are dim and the
// values are what a reader copies (a path) or reads twice (a task's whole title).
function collisionSideDetailHtml(rec, side, mine) {
  if (!side) return "";
  const task = side.task || null;
  const path = side.path || "";
  const out = [];
  out.push(
    `<div class="collision-acc-line"><span class="collision-acc-label">tree</span><b>${esc(side.name || path || "a tree")}</b>${
      side.branch ? ` <span class="collision-branch mono" title="branch">${esc(side.branch)}</span>` : ""
    }</div>`,
  );
  if (task && task.name) out.push(`<div class="collision-acc-line"><span class="collision-acc-label">task</span><span class="collision-task-name">${esc(task.name)}</span></div>`);
  out.push(
    task
      ? `<div class="collision-acc-line"><span class="collision-acc-label">queue</span>#${esc(task.id)}${
          task.assistant ? ` · <span class="collision-task-who">${esc(task.assistant)}</span>` : ""
        }${task.state ? ` · <span class="collision-task-state is-${esc(task.state)}">${esc(task.state)}</span>` : ""}</div>`
      : `<div class="collision-acc-line"><span class="collision-acc-label">queue</span><span class="collision-acc-none">no queue row on this board names this tree in its worktree field</span></div>`,
  );
  if (path) out.push(`<div class="collision-acc-path mono">${esc(path)}</div>`);
  return out.join("");
}

// ONE COLLAPSED SECTION. A real <button> header, so Tab reaches it and Enter/Space opens it for free; the header
// keeps its one-line key info (the task numbers, the git verdict, the shared-file count) so a minimised section
// still says what is inside it. The body is `hidden` rather than merely styled away: a closed section is not in the
// tab order and not in a screen reader's read of the card.
function collisionAccordionHtml(id, title, keyInfo, bodyHtml, open = false) {
  return `<section class="collision-acc${open ? " is-open" : ""}" data-collision-acc="${esc(id)}">
    <button type="button" class="collision-acc-head" data-collision-acc-toggle="${esc(id)}" aria-expanded="${open ? "true" : "false"}" aria-controls="cacc-${esc(id)}">
      <span class="collision-acc-chev" aria-hidden="true">${open ? "\u25be" : "\u25b8"}</span>
      <span class="collision-acc-title">${esc(title)}</span>
      <span class="collision-acc-key mono" title="${esc(keyInfo)}">${esc(keyInfo)}</span>
    </button>
    <div class="collision-acc-body" id="cacc-${esc(id)}"${open ? "" : " hidden"}>${bodyHtml}</div>
  </section>`;
}

// The press that opens and closes one section. The chevron and `aria-expanded` are the whole visual difference, and
// the body is shown/hidden by the attribute rather than a class, so a keyboard reader and a pointer reader see the
// same thing.
function toggleCollisionSection(section) {
  if (!section) return false;
  const head = section.querySelector(".collision-acc-head");
  const body = section.querySelector(".collision-acc-body");
  if (!head || !body) return false;
  const open = head.getAttribute("aria-expanded") === "true";
  head.setAttribute("aria-expanded", open ? "false" : "true");
  section.classList.toggle("is-open", !open);
  body.hidden = open;
  const chev = head.querySelector(".collision-acc-chev");
  if (chev) chev.textContent = open ? "\u25b8" : "\u25be";
  return true;
}

// A press on a header is the section's own: it never closes the popup it sits in (the row-chip wiring treats a press
// inside the card as the card's). Registered here because this markup is this file's.
document.addEventListener("click", (e) => {
  const head = e.target.closest && e.target.closest("[data-collision-acc-toggle]");
  if (!head) return;
  e.preventDefault();
  e.stopPropagation();
  toggleCollisionSection(head.closest(".collision-acc"));
});

function collisionBlockHtml(row, key) {
  const live = Array.isArray(row?.collisions) ? row.collisions : [];
  const history = Array.isArray(row?.collisionHistory) ? row.collisionHistory : [];
  const blockFor = (rec, lane) => {
    // The ANSWER the store gave for this record: another tree, this same tree, or nothing. Every press and every
    // sentence below is decided by it, so a card can no longer print a stranger's words as a counterpart.
    const resolution = rec.resolution && typeof rec.resolution === "object" ? rec.resolution : null;
    const kind = resolution?.kind || (rec.other?.path ? "tree" : rec.otherTarget ? "none" : "tree");
    const superseded = rec.superseded && typeof rec.superseded === "object" ? rec.superseded : null;
    // THE VERDICT, when the panel settled this note without a second side: no row on the board and no live agent
    // answers to the name (lib/collisions.js `absent`). The card prints it as the answer it is - settled, nothing to
    // press, not waiting on anybody - instead of the old "no row matches" line beside a card that still read live.
    const absent = rec.absent && typeof rec.absent === "object" ? rec.absent : null;
    const target = resolution?.target || rec.otherTarget || "";
    const other = kind === "same-tree" ? target || row.name || "this tree" : rec.other?.name || rec.otherTarget || "an unnamed tree";
    const otherPath = kind === "tree" ? rec.other?.path || "" : "";
    const otherBranch = kind === "tree" ? rec.other?.branch || "" : "";
    const state = rec.state || "assistants";
    const files = Array.isArray(rec.files) ? rec.files : [];
    // MEASURED, OR NOT SAID. `evidence.ok === true` is git's own answer; a false one is "could not be computed" and is
    // printed as that, never as a set of zero files. With no measurement at all the card says what it has: the worker's
    // sentence, named as such.
    const evidence = rec.evidence && typeof rec.evidence === "object" ? rec.evidence : null;
    const measured = evidence?.ok === true;
    // THE SHARED FILES ARE THE SUMMARY'S, the explanation of an empty set is the Merge check section's: a chip row is
    // something a reader scans, and a sentence about git is something they open.
    const chipsHtml = files.length
      ? `<ul class="collision-chips" aria-label="the files both branches changed against their merge base">${files.map((f) => `<li class="collision-chip mono" title="${esc(f)}">${esc(f)}</li>`).join("")}</ul>`
      : "";
    const noFilesSay = files.length
      ? ""
      : measured
        ? `<span class="collision-none" data-collision-files="none">no shared file: both branches changed nothing in common against their merge base</span>`
        : evidence && evidence.ok === false
          ? `<span class="collision-none" data-collision-files="unknown" title="${esc(evidence.error || "git could not compute the overlap")}">no shared file - the overlap could not be computed (${esc(evidence.error || "git did not answer")})</span>`
          : `<span class="collision-none" data-collision-files="none">no shared file is named: the evidence is the worker's own sentence</span>`;
    const when = rec.firstAt ? `${relTime(rec.firstAt)} ago` : "";
    // The sides whose OWN task is finished. Derived by the store on every read (lib/collisions.js `finishedSides`),
    // so it is never a stale flag: work that starts again in that tree brings the pair back as a live one.
    const stoodByTask = Array.isArray(rec.stoodByTask) ? rec.stoodByTask : [];
    // AN AUTOMATIC PICK IS NOT THE READER'S RULING and does not read like one: it says who chose and why, and the
    // withdraw beside it is the reader's one press to overrule it (withdrawing an automatic pick stops the sweep from
    // putting the same order straight back, so the pair becomes his).
    const auto = state === "ruled" && Boolean(rec.ruling?.auto);
    // THE PILL IS A WORD, NOT A PARAGRAPH. It used to print the whole stand-down - "already stood down: <tree>
    // (<task title>) is parked, <tree> ... is done" - which is the same prose the History section repeats in full,
    // and it is why the card's first screen was a wall of text. At a glance a reader needs to know WHICH of these
    // states the pair is in; who yielded and why is History's job, one press away.
    const stateWord = superseded
      ? `superseded by ${esc(superseded.short || String(superseded.commit || "").slice(0, 12))}`
      : absent
        ? "resolved by absence"
        : kind === "same-tree"
          ? "same tree, not a collision"
          : kind === "none"
            ? "no row matches"
            : auto
              ? `auto-settled: ${esc(rec.ruling?.name || "a side")} goes first`
              : state === "ruled"
                ? `already ruled: ${esc(rec.ruling?.name || "a side")}${rec.ruling?.taskId ? ` (#${esc(rec.ruling.taskId)})` : ""} goes first`
                : stoodByTask.length
                  ? "stood down"
                  : state === "reader"
                    ? "yours to rule on"
                    : "with both assistants";
    // WHAT GIT SAID, when it said "the reader's": both directions conflict, or it could not answer. A card that asked
    // for a decision with no reason visible is the bare flag this whole surface exists to avoid.
    const dirs = rec.merge || null;
    const bothConflict = Boolean(dirs && dirs.aFirst?.clean === false && dirs.bFirst?.clean === false);
    const gitUnknown = Boolean(dirs && (dirs.aFirst?.error || dirs.bFirst?.error));
    const anyClean = Boolean(dirs && (dirs.aFirst?.clean === true || dirs.bFirst?.clean === true));
    const conflictSay = bothConflict
      ? `git: both directions conflict${Array.isArray(dirs.aFirst.conflicts) && dirs.aFirst.conflicts.length ? ` (${dirs.aFirst.conflicts.slice(0, 3).join(", ")})` : ""} - the order is yours`
      : gitUnknown
        ? "git could not answer the merge question - the order is yours"
        : "";
    // THE MERGE CHECK SECTION'S ONE LINE: git's own verdict on the order, and how many files the two branches share.
    // That is the whole reason to open the section, said in its header so a closed section still reads.
    const mergeKey = [
      bothConflict ? "both directions conflict" : gitUnknown ? "git could not answer" : anyClean ? "clean one way" : "not checked",
      files.length ? `${files.length} shared file${files.length === 1 ? "" : "s"}` : measured ? "no shared file" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    // THE RULE: two trees, and paths measured between them. A card with no shared file, no counterpart or a counterpart
    // that IS this tree offers no press - there is nothing to order, and a press between one tree and itself is the
    // defect this card was fixed for.
    const canRule = !superseded && kind === "tree" && Boolean(rec.other?.path) && files.length > 0;
    const ruleBtn = (pick, label, title) =>
      `<button class="btn-collision-rule" type="button" data-collision-rule="${esc(rec.key)}" data-collision-pick="${pick}" title="${esc(title)}">${esc(label)}</button>`;
    const mine = row.name || "this tree";
    // The picks are the RECORD's sides (a/b), not this row's: the pair is carried by both rows and a row can be side
    // b. Labelling by role is what keeps "⇢ this tree goes first" pointing at the tree the reader is looking at.
    const minePick = rec.role === "b" ? "b" : "a";
    const otherPick = minePick === "a" ? "b" : "a";
    const actions = [];
    if (canRule) {
      actions.push(ruleBtn(minePick, "⇢ this tree goes first", `rule that ${mine} goes first: the priority is filed into both assistants' queues and stored against this pair`));
      actions.push(ruleBtn(otherPick, `⇢ ${other} goes first`, `rule that ${other} goes first: the priority is filed into both assistants' queues and stored against this pair`));
    }
    if (state === "ruled" && !superseded) {
      actions.push(
        `<button class="btn-collision-clear" type="button" data-collision-rule="${esc(rec.key)}" data-collision-pick="clear" title="${
          auto
            ? "withdraw this automatic pick - the panel will not put the same order back, so the pair is yours to rule"
            : "withdraw the ruling - the pair goes back to the assistants' own pass"
        }">withdraw the ruling</button>`,
      );
    } else if (rec.canAsk && canRule) {
      actions.push(`<button class="btn-collision-ask" type="button" data-collision-ask="${esc(rec.key)}" title="bring this pair to you now, instead of waiting for the assistants' pass">bring it to me</button>`);
    }
    const mineSide = rec.role === "b" ? rec.b : rec.a;
    const otherSide = rec.role === "b" ? rec.a : rec.b;
    const stood = [
      (Array.isArray(rec.stoodDown) ? rec.stoodDown : []).map((s) => {
        const who = s.name || (s.side === "a" ? rec.a?.name : rec.b?.name) || "one side";
        const why = s.taskId ? `its notice #${s.taskId} was ${s.state || "closed"}` : "its notice was closed";
        return `${who} stood down: ${why} - the pair is not waiting on you`;
      }),
      // A side whose OWN task is done or parked: the work the collision was about has been laid down, so the reader is
      // not the one to decide. Said on both rows, with the task named, because "why is this pair quiet?" is the same
      // question the notice stand-down answers.
      stoodByTask.map((f) => {
        const who = f.tree || "one side";
        const what = f.taskId ? `its task #${f.taskId}${f.name ? ` (${f.name})` : ""} is ${f.state || "finished"}` : `its task is ${f.state || "finished"}`;
        return `${who} is already stood down: ${what} - the collision is with finished work, so the pair is not waiting on you`;
      }),
    ]
      .flat()
      .join("; ");
    // The measured stamp names the merge base the paths were read against, so a reader can tell a measurement from a
    // sentence without trusting either.
    const measuredSay = measured && files.length ? `git: both branches against merge base ${String(evidence.base || "").slice(0, 12)} - ${files.length} shared` : "";
    const peerLine = kind === "tree"
      ? `<div class="collision-peer mono" title="the other tree, as the scanner knows it">${esc(otherPath)}${rec.filed && rec.filed.length ? ` · filed with ${esc(rec.filed.map((f) => f.assistantId).join(", "))}` : ""}</div>`
      : kind === "same-tree"
        ? `<div class="collision-peer" data-collision-resolution="same-tree">the counterpart named here is <span class="mono">${esc(target || row.path)}</span> - the tree this card is drawn on. There is no second side and nothing to order.</div>`
        : absent
          ? `<div class="collision-peer" data-collision-resolution="none">no row on this board answers to <span class="mono">${esc(target || "that name")}</span>, and no live agent is standing in a tree it names - there is no second side to rule against.</div>`
          : `<div class="collision-peer" data-collision-resolution="none">no row on this board answers to <span class="mono">${esc(target || "that name")}</span> - there is no second side to rule against.</div>`;
    // THE FOUR SECTIONS, COLLAPSED. Each header keeps the one line a minimised section still has to say: the side's
    // task number, assistant and state; git's verdict and the shared-file count; the task numbers and their states.
    const sideKeyInfo = (side) => {
      const t = side?.task || null;
      return t ? [`#${t.id}`, t.assistant, t.state].filter(Boolean).join(" · ") : "no task row on this tree";
    };
    const historyKey =
      [
        ...stoodByTask.map((f) => `#${f.taskId}${f.state ? ` ${f.state}` : ""}`),
        ...(Array.isArray(rec.stoodDown) ? rec.stoodDown : []).map((s) => `notice #${s.taskId}${s.state ? ` ${s.state}` : ""}`),
        superseded ? `superseded ${superseded.short || String(superseded.commit || "").slice(0, 7)}` : "",
        absent ? "resolved by absence" : "",
        rec.ruling ? `${rec.ruling.auto ? "auto-picked" : "ruled"}: ${rec.ruling.name || "a side"}` : "",
      ]
        .filter(Boolean)
        .slice(0, 5)
        .join(" · ") || "nothing stood down";
    const mergeBody = [
      collisionEvidence(rec) ? `<div class="collision-say">${esc(collisionEvidence(rec))}</div>` : "",
      measuredSay ? `<div class="collision-say collision-measured">${esc(measuredSay)}</div>` : "",
      conflictSay ? `<div class="collision-say collision-merge-say">${esc(conflictSay)}</div>` : "",
      noFilesSay ? `<div class="collision-say">${noFilesSay}</div>` : "",
    ].join("");
    const historyBody = [
      stood ? `<div class="collision-stood">${esc(stood)}</div>` : "",
      peerLine,
      rec.notes && rec.notes.length ? `<ul class="collision-notes">${rec.notes.map((n) => `<li>“${esc(n.text)}”</li>`).join("")}</ul>` : "",
      auto
        ? `<div class="collision-ruling-note">settled by the panel from git's own merge check - withdraw it to make this pair yours</div>`
        : rec.ruling?.note
          ? `<div class="collision-ruling-note">your note: ${esc(rec.ruling.note)}</div>`
          : "",
      superseded
        ? `<div class="collision-ruling-note collision-superseded" data-collision-superseded="${esc(superseded.commit)}">the landing <span class="mono">${esc(superseded.short || superseded.commit)}</span> carried ${esc(superseded.side === "b" ? rec.b?.name || "the other side" : rec.a?.name || "this side")} into ${esc(superseded.main || "main")}${superseded.landedAt ? ` ${relTime(superseded.landedAt)} ago` : ""}, after this report was stamped${superseded.reportAt ? ` (${esc(String(superseded.reportAt))})` : ""} - the pair is history and asks nothing of you</div>`
        : "",
      absent
        ? `<div class="collision-ruling-note collision-absent" data-collision-absent="${esc(absent.at || "")}">recorded as resolved by absence${absent.at ? ` ${relTime(absent.at)} ago` : ""}: ${esc(absent.why || "the target names nothing on this board and no live agent stands in a tree it names")} - kept so the report stays readable, and it is not waiting on you</div>`
        : "",
    ].join("");
    // An id that survives a repaint and stays unique on a card carrying several pairs: the record's key, the lane
    // and the section's own slug, with everything a browser refuses in an id folded to a dash.
    const secId = (slug) => `${String(rec.key || key).replace(/[^A-Za-z0-9]+/g, "-")}-${lane}-${slug}`;
    return `<div class="collision-block is-${esc(state)}${lane === "history" ? " is-history" : ""}" data-collision-block="${esc(key)}" data-collision-key="${esc(rec.key)}" data-collision-pair="${esc(rec.key)}" data-collision-lane="${esc(lane)}">
      <div class="collision-head">
        <span class="collision-mark" role="img" aria-label="collision with ${esc(other)}">◆</span>
        <h4>Collision</h4>
        <span class="collision-other">with <b>${esc(other)}</b>${otherBranch ? ` <span class="collision-branch mono">${esc(otherBranch)}</span>` : ""}</span>
        <span class="collision-state is-${esc(state)}">${stateWord}</span>
        <span class="collision-when mono">${esc([when, rec.source === "reported" ? "reported by its worker" : ""].filter(Boolean).join(" · "))}</span>
      </div>
      <div class="collision-summary">
        <div class="collision-sides">${collisionSideSummaryHtml(rec, mineSide, true)}${kind === "tree" ? collisionSideSummaryHtml(rec, otherSide, false) : ""}</div>
        ${kind === "tree" && chipsHtml ? `<div class="collision-files"><span class="collision-files-label">shared</span>${chipsHtml}</div>` : ""}
        ${actions.length ? `<div class="collision-actions">${actions.join("")}</div>` : ""}
      </div>
      <div class="collision-accordion">
        ${collisionAccordionHtml(secId("this-row"), "This row", sideKeyInfo(mineSide), collisionSideDetailHtml(rec, mineSide, true))}
        ${kind === "tree" ? collisionAccordionHtml(secId("counterpart"), "Counterpart", sideKeyInfo(otherSide), collisionSideDetailHtml(rec, otherSide, false)) : ""}
        ${kind === "tree" ? collisionAccordionHtml(secId("merge"), "Merge check", mergeKey, mergeBody) : ""}
        ${collisionAccordionHtml(secId("history"), "History", historyKey, historyBody)}
      </div>
    </div>`;
  };
  const blocks = live.map((rec) => blockFor(rec, "live"));
  if (history.length) {
    blocks.push(`<div class="collision-history" data-collision-history="${esc(key)}">
      <div class="collision-history-head">history - a landing ended ${history.length === 1 ? "this pair" : "these pairs"}; kept so the reason is still readable</div>
      ${history.map((rec) => blockFor(rec, "history")).join("")}
    </div>`);
  }
  return blocks.join("");
}

// THE RESULT CARD. A row whose last run left something to check carries one: the one-line summary the run ended
// with, the report it named as a real anchor through the panel's own open-file route, and its next steps as chips.
//
// WHO EMITS IT, AND WHEN. The PANEL, from the stored delivery (lib/review-inbox.js), every time the row's result CHIP
// is opened - never the agent inside the run, and never at the run's own moment. The card is the chip's popup now: the
// row itself carries only the chip (the summary's first clause, the age, "reviewed"), so the tall card costs the board
// nothing until somebody asks for it. That is what makes an unanswered card free: the record is written after the run
// settled, and this card exists whether or not anybody ever presses Reviewed. Nothing here waits, times out, or
// reports back to a run.
//
// The anchor carries the TREE as its base (the same `data-open-file-base` a clarify card carries), because the
// report path is relative to the worktree the run worked in - resolved against the project's checkout it would name
// a file that is not there.
//
// A delivery with no report and no steps still draws its card: the summary is the deliverable, and the card says so
// in a sentence rather than leaving a blank space where a report would have been.
function reviewBlockHtml(row, key) {
  const rec = row && row.review;
  if (!rec || !rec.summary) return "";
  const awaiting = typeof wtReviewLane !== "undefined" && wtReviewLane ? wtReviewLane.awaiting(row) : !rec.reviewedAt;
  const when = rec.at ? `${relTime(rec.at)} ago` : "";
  const next = Array.isArray(rec.next) ? rec.next : [];
  const anchor = rec.report
    ? fileAnchor(rec.report, {
        label: tailPath(rec.report),
        base: row.path,
        title: `open ${rec.report} in your browser - the report this run left, opened by the panel's own file route`,
      }) || `<span class="review-path mono">${esc(rec.report)}</span>`
    : `<span class="review-none">no report path - the summary above is the whole of what this run left</span>`;
  const chipList = next.length
    ? `<ul class="review-chips" aria-label="next steps this run named">${next.map((s) => `<li class="review-chip" title="${esc(s)}">${esc(s)}</li>`).join("")}</ul>`
    : `<span class="review-none">no next steps were named</span>`;
  return `<div class="review-block${awaiting ? " is-awaiting" : " is-reviewed"}" data-review-block="${esc(key)}">
      <div class="review-head">
        <span class="review-mark" role="img" aria-label="${esc(awaiting ? "result awaiting review" : "result reviewed")}" title="${esc(awaiting ? "result awaiting review" : "result reviewed")}">${awaiting ? "\u25a3" : "\u2713"}</span>
        <h4>Result</h4>
        <span class="review-summary">${esc(rec.summary)}</span>
        <span class="review-when mono">${esc([when, rec.runId ? `run ${rec.runId}` : ""].filter(Boolean).join(" · "))}</span>
        ${awaiting
          ? `<button class="btn-review-done" type="button" data-review-done="${esc(key)}" data-review-project="${esc(row.project)}" data-review-path="${esc(row.path)}" title="mark this result reviewed - it leaves the review lane and the header count, and this card stays with what the run left">\u2713 Reviewed</button>`
          : `<span class="review-stamp mono" title="you checked this result; the card stays so it is still readable">reviewed${rec.reviewedAt ? ` ${relTime(rec.reviewedAt)} ago` : ""}</span>`}
      </div>
      <div class="review-body">
        <div class="review-anchor" data-review-anchor="${esc(key)}">${anchor}</div>
        ${chipList}
      </div>
    </div>`;
}

// ---- THE SAME TWO CARDS AS ONE-LINE CHIPS --------------------------------------------------------------------
// The result block and the collision blocks above are TALL: drawn in the row's detail they cost a paragraph each, and
// only existed once the reader had opened the row - the reader opened the row to find out whether there was anything
// worth opening. Both are chips in the row's chip strip now (public/render-projects.js draws them beside the name,
// with the violet mark and the amber one), so a row carries them without growing a pixel: the strip is one line, the
// name ellipsises beside them, and the CARD is a popup behind the chip.
//
// WHAT EACH CONTROL SAYS. The result chip is the first clause of the run's summary, the run's age, and "reviewed" once
// it has been checked (public/core/row-chips.js `resultLabel`). It carries NO chevron and NO path while collapsed: the
// report path is the one thing the expansion exists to show, and the chevron appears only when the chip is open, so a
// collapsed strip stays a strip of facts. The collision side is ONE diamond per row, not a chip: the row's pairs are
// counted from the store's own records (`tally`) and said in words by the control's accessible name and title, filled
// while a pair is open and outlined when every one of them is resolved.
//
// THE POPUP IS THE EXISTING CARD, not a second renderer: `reviewBlockHtml` / `collisionBlockHtml` are drawn into a
// body-level panel anchored to the chip, with the report anchor, the next steps, both sides' task names and the two
// ruling presses exactly as they were - only the place changed. Placement is measured from the chip's own rect and
// clamped to the viewport, so neither popup is clipped at 768 wide.
//
// REMEMBERED PER ROW AND PER CARD. `wm.openRowChips` holds "<kind>|<row key>" for the chips the reader opened, and
// only OPENING is remembered - a row nobody has opened starts collapsed. A repaint replaces the row's chip nodes, so
// `paintRowChipPops` re-anchors an open popup onto the new chip and repaints its body only when the record it draws
// actually changed: the row's details being redrawn is not news about the card, and a card that snapped shut on every
// scan would be a card the reader cannot read.
const ROWCHIP_STORE_KEY = "wm.openRowChips";
// Wide enough for the pair card's two sides and its two ruling presses, never wider than the viewport: at 768 the
// panel takes the room the window has and the card inside it wraps rather than being cut off at the edge.
const ROWCHIP_POP_MAX = 560;
let rowChipOpenSet = null;

function rowChipStore() {
  if (rowChipOpenSet) return rowChipOpenSet;
  let raw = "[]";
  try {
    raw = localStorage.getItem(ROWCHIP_STORE_KEY) || "[]";
  } catch {
    /* no storage: every chip starts collapsed, and the expansion simply will not survive a reload */
  }
  rowChipOpenSet = typeof wtRowChips !== "undefined" ? wtRowChips.readOpen(raw) : new Set();
  return rowChipOpenSet;
}

function saveRowChipStore() {
  try {
    localStorage.setItem(ROWCHIP_STORE_KEY, typeof wtRowChips !== "undefined" ? wtRowChips.storeValue(rowChipStore()) : "[]");
  } catch {
    /* no storage: the expansion is this session's, and a reload folds it again */
  }
}

function rowChipIsOpen(kind, key) {
  return typeof wtRowChips !== "undefined" && wtRowChips.isOpen(rowChipStore(), kind, key);
}

function setRowChipOpen(kind, key, on) {
  const open = rowChipIsOpen(kind, key);
  if (open === Boolean(on)) return;
  rowChipOpenSet = typeof wtRowChips !== "undefined" ? wtRowChips.toggle(rowChipStore(), kind, key) : rowChipStore();
  if (!on) rowChipOpenSet.delete(`${kind}|${key}`);
  saveRowChipStore();
}

// The chip's own sentence. It names the gesture, not the card: the card is what the press opens.
function rowChipTitle(kind, row, open) {
  if (kind === "result") {
    const rec = (row && row.review) || {};
    const label = typeof wtRowChips !== "undefined" ? wtRowChips.resultLabel(rec, rec.at ? `${relTime(rec.at)} ago` : "") : "the result";
    return open
      ? `collapse the result - ${label}; the card carries the whole summary, the report and the next steps`
      : `expand the result - ${label}. The card behind this chip carries the whole summary, the docs/reports link and every next step the run named`;
  }
  const live = Array.isArray(row && row.collisions) ? row.collisions : [];
  const history = Array.isArray(row && row.collisionHistory) ? row.collisionHistory : [];
  // HISTORY COUNTS AS RESOLVED, and a row with ONLY history still carries the diamond: the pair is over, and the card
  // behind it is where the reader finds out which landing ended it. Dropping the control would make the collision
  // vanish as if it had never been reported.
  const list = live.concat(history);
  const counts = typeof wtRowChips !== "undefined" ? wtRowChips.tally(list, row && row.project) : { open: 0, resolved: 0 };
  return wtRowChips.collisionDiamondLabel(counts, open);
}

// THE COLLISION DIAMOND, and the ONE control a row with a collision carries. It used to be two things: a violet mark
// per pair (up to three of them) and, further along the line, a chip reading "0 open . 1 resolved". The chip was the
// width the reader complained about, and the second diamond said the same thing again. Now: ONE diamond per row
// whenever the row has any pair at all, filled ◆ while a pair is open and outlined ◇ once every one is resolved, and
// the chip's press moved onto it - so a press opens the card that lists ALL pairs on this worktree, not the first one.
//
// IT IS A REAL BUTTON, not a mark with a click listener: it is keyboard reachable in the row's own tab order, Enter
// and Space activate it for free, it carries `aria-expanded`, and its accessible name (and title) say the state and
// the count in words (`collisionDiamondLabel`), so nothing but the width was given up. The 24x24 box it needs is
// bought with a negative block margin, so the row's one-line height does not move (public/chart.css).
function collisionDiamondHtml(row, key) {
  const live = Array.isArray(row && row.collisions) ? row.collisions : [];
  const history = Array.isArray(row && row.collisionHistory) ? row.collisionHistory : [];
  const list = live.concat(history);
  if (!list.length) return "";
  if (typeof wtRowChips === "undefined") return "";
  const counts = wtRowChips.tally(list, row.project);
  if (!counts.total) return "";
  const open = rowChipIsOpen("collision", key);
  // The bright accent stays the pairs waiting on the READER (the mark's is-reader ink); an open pair with both
  // assistants is the calmer violet. Both are filled diamonds - the fill is what "something is open" means - and only
  // the resolved state changes the SHAPE, so colour is never the only channel.
  const waiting = list.some((rec) => rec && rec.state === "reader" && !wtRowChips.pairResolved(rec));
  const state = counts.open ? (waiting ? "is-waiting" : "is-open") : "is-resolved";
  const say = rowChipTitle("collision", row, open);
  const glyph = counts.open ? "\u25c6" : "\u25c7";
  return `<button type="button" class="collision-mark collision-diamond ${state}" data-rowchip="collision" data-rowchip-key="${esc(key)}" data-collision-diamond="${esc(key)}" aria-expanded="${open ? "true" : "false"}" aria-label="${esc(say)}" title="${esc(say)}"><span class="collision-diamond-glyph" aria-hidden="true">${glyph}</span></button>`;
}

// THE RESULT CHIP. Absent on a row with no delivery, exactly as the amber mark is: nothing to read, nothing drawn.
function resultChipHtml(row, key) {
  const rec = row && row.review;
  if (!rec || !rec.summary) return "";
  if (typeof wtRowChips === "undefined") return "";
  const open = rowChipIsOpen("result", key);
  const label = wtRowChips.resultLabel(rec, rec.at ? `${relTime(rec.at)} ago` : "");
  const awaiting = typeof wtReviewLane !== "undefined" && wtReviewLane ? wtReviewLane.awaiting(row) : !rec.reviewedAt;
  return `<button type="button" class="rowchip result-chip${awaiting ? " is-awaiting" : " is-reviewed"}" data-rowchip="result" data-rowchip-key="${esc(key)}" aria-expanded="${open ? "true" : "false"}" title="${esc(rowChipTitle("result", row, open))}"><span class="rowchip-glyph" aria-hidden="true">\u25a3</span><span class="rowchip-text">${esc(label)}</span>${open ? `<span class="rowchip-chev" aria-hidden="true">\u25be</span>` : ""}</button>`;
}

// The card behind a chip, from the row the board holds now.
function rowChipInner(kind, row, key) {
  return kind === "result" ? reviewBlockHtml(row, key) : collisionBlockHtml(row, key);
}

// What the popup draws, so a repaint only replaces its body when the record it draws moved: `state` and `ruling` on a
// pair, the delivery's own fields on a result. A scan that changed nothing leaves the reader's popup exactly as it is.
function rowChipSig(kind, row) {
  if (!row) return "";
  if (kind === "result") {
    const rec = row.review || {};
    return JSON.stringify([rec.summary, rec.report, rec.next, rec.reviewedAt, rec.at, rec.runId]);
  }
  const list = (Array.isArray(row.collisions) ? row.collisions : []).concat(Array.isArray(row.collisionHistory) ? row.collisionHistory : []);
  return JSON.stringify(
    list.map((rec) => [
      rec.key,
      rec.state,
      rec.ruling ? [rec.ruling.pick, rec.ruling.name, rec.ruling.auto === true, rec.ruling.taskId] : null,
      Array.isArray(rec.stoodDown) ? rec.stoodDown.length : 0,
      Array.isArray(rec.stoodByTask) ? rec.stoodByTask.length : 0,
      rec.canAsk === true,
      // A pair that has been superseded changes what the popup says without changing anything above it, so the landing
      // is part of the signature: the open card repaints to "history" the moment the sweep finds it.
      rec.superseded ? [rec.superseded.commit, rec.superseded.landedAt] : null,
      // The absence verdict, for the same reason: a note the panel settles without a second side must stop reading as
      // an open report the moment the verdict is on the record.
      rec.absent ? [rec.absent.at, rec.absent.upgraded === true] : null,
      rec.resolution ? [rec.resolution.kind, rec.resolution.target] : null,
      rec.evidence ? [rec.evidence.ok === true, Array.isArray(rec.evidence.files) ? rec.evidence.files.length : 0] : null,
      Array.isArray(rec.files) ? rec.files.length : 0,
    ]),
  );
}

function rowChipAnchor(kind, key) {
  return document.querySelector(`[data-rowchip=${JSON.stringify(kind)}][data-rowchip-key=${JSON.stringify(key)}]`);
}

function rowChipPopEl(kind, key) {
  for (const el of document.querySelectorAll(".rowchip-pop")) {
    if (el.dataset.rowchipPop === kind && el.dataset.popKey === key) return el;
  }
  return null;
}

function rowChipPopHtml(kind, key, row) {
  const label = kind === "result" ? "this run's result" : "the collisions on this row";
  return `<div class="rowchip-pop" data-rowchip-pop="${esc(kind)}" data-pop-key="${esc(key)}" role="dialog" aria-label="${esc(label)}">
    <button type="button" class="rowchip-pop-x" data-rowchip-close="${esc(kind)}" data-rowchip-key="${esc(key)}" title="close the card - Escape">\u2715</button>
    <div class="rowchip-pop-body">${rowChipInner(kind, row, key)}</div>
  </div>`;
}

// MEASURED FROM THE CHIP AND CLAMPED TO THE WINDOW. Two things a fixed panel gets wrong by itself: it runs off the
// right edge on a row whose chip is near it, and it runs off the bottom on a row near the end of the board. So the
// width never exceeds the viewport minus a gutter (that is the 768 case), it slides left to fit, and it flips above
// the chip when there is no room below.
function placeRowChipPop(pop, anchor) {
  if (!pop || !anchor || !anchor.isConnected) return;
  const gutter = 10;
  const vw = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 0);
  const vh = Math.max(320, window.innerHeight || 0);
  const width = Math.max(240, Math.min(ROWCHIP_POP_MAX, vw - gutter * 2));
  pop.style.width = `${width}px`;
  pop.style.maxHeight = `${Math.round(vh * 0.7)}px`;
  const rect = anchor.getBoundingClientRect();
  let left = rect.left;
  if (left + width > vw - gutter) left = vw - gutter - width;
  if (left < gutter) left = gutter;
  const height = Math.min(pop.offsetHeight || 0, Math.round(vh * 0.7));
  let top = rect.bottom + 6;
  if (top + height > vh - gutter) top = Math.max(gutter, rect.top - 6 - height);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function rowChipFocusables(pop) {
  if (!pop) return [];
  return [...pop.querySelectorAll("button, a[data-open-file], a[href], [tabindex]:not([tabindex='-1'])")].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );
}

function openRowChipPop(kind, key, { focus = false } = {}) {
  const row = state.rows.get(key);
  const anchor = rowChipAnchor(kind, key);
  if (!row || !anchor) return false;
  let pop = rowChipPopEl(kind, key);
  const sig = rowChipSig(kind, row);
  if (!pop) {
    const holder = document.createElement("div");
    holder.innerHTML = rowChipPopHtml(kind, key, row);
    pop = holder.firstElementChild;
    if (!pop) return false;
    document.body.appendChild(pop);
  } else if (pop._sig !== sig) {
    // The record moved under an open card (a ruling landed, a check was made): the body is redrawn, and the reader's
    // caret is put back on the same control rather than dropped on the document by the node it was standing on. An
    // ACCORDION the reader opened is part of what they were reading, so the sections they had open are reopened on
    // the redrawn body before the caret is placed - otherwise a scan would fold the section under their eyes.
    const at = rowChipFocusables(pop).indexOf(document.activeElement);
    const opened = kind === "collision" ? [...pop.querySelectorAll(".collision-block")].map((blk, i) => [...blk.querySelectorAll(".collision-acc.is-open")].map((sec) => [i, sec.dataset.collisionAcc || ""])) : [];
    const body = pop.querySelector(".rowchip-pop-body");
    if (body) {
      body.innerHTML = rowChipInner(kind, row, key);
      for (const [bi, slug] of opened.flat()) {
        if (!slug) continue;
        const blk = body.querySelectorAll(".collision-block")[bi];
        const sec = blk?.querySelector(`.collision-acc[data-collision-acc="${CSS.escape(slug)}"]`);
        if (sec && sec.querySelector(".collision-acc-head")?.getAttribute("aria-expanded") !== "true") toggleCollisionSection(sec);
      }
    }
    if (at >= 0) {
      const again = rowChipFocusables(pop)[at];
      if (again) {
        try {
          again.focus({ preventScroll: true });
        } catch {
          again.focus();
        }
      }
    }
  }
  pop._sig = sig;
  pop._anchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  placeRowChipPop(pop, anchor);
  if (focus) {
    const first = rowChipFocusables(pop)[0];
    if (first) {
      try {
        first.focus({ preventScroll: true });
      } catch {
        first.focus();
      }
    }
  }
  return true;
}

function closeRowChipPop(kind, key, { focusChip = false } = {}) {
  const pop = rowChipPopEl(kind, key);
  if (pop) pop.remove();
  const anchor = rowChipAnchor(kind, key);
  if (anchor) {
    anchor.setAttribute("aria-expanded", "false");
    const chev = anchor.querySelector(".rowchip-chev");
    if (chev) chev.remove();
    const row = state.rows.get(key);
    if (row) {
      const say = rowChipTitle(kind, row, false);
      anchor.title = say;
      if (anchor.hasAttribute("data-collision-diamond")) anchor.setAttribute("aria-label", say);
    }
  }
  if (focusChip && anchor) {
    try {
      anchor.focus({ preventScroll: true });
    } catch {
      anchor.focus();
    }
  }
}

// The press, and the one place the remembered state changes. One card at a time: opening a chip closes any other
// popup and forgets it, because a reader who has moved to another card has stopped reading the first one.
function toggleRowChip(kind, key) {
  const wasOpen = rowChipIsOpen(kind, key);
  for (const pop of [...document.querySelectorAll(".rowchip-pop")]) {
    if (pop.dataset.rowchipPop === kind && pop.dataset.popKey === key) continue;
    closeRowChipPop(pop.dataset.rowchipPop, pop.dataset.popKey);
    setRowChipOpen(pop.dataset.rowchipPop, pop.dataset.popKey, false);
  }
  setRowChipOpen(kind, key, !wasOpen);
  if (wasOpen) closeRowChipPop(kind, key, { focusChip: true });
  else openRowChipPop(kind, key, { focus: true });
  // The chip's own marks (the ring, `aria-expanded` and the chevron that appears only when it is open) are one
  // painter, the same one a repaint calls, so a press and a rebuild cannot disagree about what an open chip looks like.
  paintRowChipMarkers(key);
  const row = state.rows.get(key);
  const anchor = rowChipAnchor(kind, key);
  if (anchor && row) anchor.title = rowChipTitle(kind, row, !wasOpen);
  return !wasOpen;
}

// The chips on ONE row, repainted in place: the chevron and `aria-expanded` are the whole visual difference, and a
// full board repaint for them would be a repaint that also moved the reader's scroll. The collision diamond takes no
// chevron - it has no text to keep on one line, and a second glyph beside it would spend the width it just gave back -
// so its open state is `aria-expanded` and the ring public/chart.css draws for it, and its sentence is re-said for the
// new state.
function paintRowChipMarkers(key) {
  for (const kind of ["result", "collision"]) {
    const anchor = rowChipAnchor(kind, key);
    if (!anchor) continue;
    const open = rowChipIsOpen(kind, key);
    anchor.setAttribute("aria-expanded", open ? "true" : "false");
    if (anchor.hasAttribute("data-collision-diamond")) {
      const row = state.rows.get(key);
      if (row) {
        const say = rowChipTitle("collision", row, open);
        anchor.title = say;
        anchor.setAttribute("aria-label", say);
      }
      continue;
    }
    const chev = anchor.querySelector(".rowchip-chev");
    if (open && !chev) anchor.insertAdjacentHTML("beforeend", `<span class="rowchip-chev" aria-hidden="true">\u25be</span>`);
    if (!open && chev) chev.remove();
  }
}

// AFTER EVERY REPAINT. A rebuilt row replaces the chip nodes, so an open popup's own anchor is a detached element: it
// is re-anchored onto the row's new chip (and its body repainted only if the record moved), a chip with no popup that
// the store says is open gets one back, and a popup whose row has left the board is closed.
function paintRowChipPops(project = null) {
  const wanted = typeof wtRowChips !== "undefined" ? wtRowChips.entries(rowChipStore()) : [];
  for (const pop of [...document.querySelectorAll(".rowchip-pop")]) {
    const kind = pop.dataset.rowchipPop;
    const key = pop.dataset.popKey;
    const anchor = rowChipAnchor(kind, key);
    const want = wanted.some((w) => w.kind === kind && w.key === key);
    if (!want || !anchor) {
      pop.remove();
      continue;
    }
    if (pop._anchor !== anchor) {
      pop._anchor = anchor;
      anchor.setAttribute("aria-expanded", "true");
      openRowChipPop(kind, key);
      continue;
    }
    if (project) placeRowChipPop(pop, anchor);
  }
  for (const w of wanted) {
    if (rowChipPopEl(w.kind, w.key)) continue;
    const row = state.rows.get(w.key);
    if (!row) continue;
    if (project && row.project !== project) continue;
    if (!rowChipAnchor(w.kind, w.key)) continue;
    openRowChipPop(w.kind, w.key);
  }
}

// ARROWS STEP THE POPUP's own controls, the way a menu's do; Escape closes it and hands the caret back to the chip.
function stepRowChipPop(pop, by) {
  const items = rowChipFocusables(pop);
  if (!items.length) return false;
  const at = items.indexOf(document.activeElement);
  const next = items[(at < 0 ? 0 : at + by + items.length) % items.length];
  if (!next) return false;
  try {
    next.focus({ preventScroll: true });
  } catch {
    next.focus();
  }
  return true;
}

// The wiring, registered here rather than in app.js: these chips are this file's markup, and the handlers read only
// this file's own state and the page's row map. `stopPropagation` matters - the row's name cell has its own presses.
document.addEventListener("click", (e) => {
  const chip = e.target.closest && e.target.closest("[data-rowchip]");
  if (chip && chip.dataset.rowchip) {
    e.preventDefault();
    e.stopPropagation();
    toggleRowChip(chip.dataset.rowchip, chip.dataset.rowchipKey || "");
    return;
  }
  const close = e.target.closest && e.target.closest("[data-rowchip-close]");
  if (close) {
    e.preventDefault();
    e.stopPropagation();
    const kind = close.dataset.rowchipClose;
    const key = close.dataset.rowchipKey || "";
    setRowChipOpen(kind, key, false);
    closeRowChipPop(kind, key, { focusChip: true });
    return;
  }
  // A press inside the open card is the card's own (a ruling, the report anchor, Reviewed): it stays open. A press
  // anywhere else is the reader leaving it, and leaving it is a close - which forgets the open state, so the next
  // repaint cannot bring back a card the reader put away.
  if (document.querySelector(".rowchip-pop") && !(e.target.closest && e.target.closest(".rowchip-pop"))) {
    for (const pop of [...document.querySelectorAll(".rowchip-pop")]) {
      setRowChipOpen(pop.dataset.rowchipPop, pop.dataset.popKey, false);
      closeRowChipPop(pop.dataset.rowchipPop, pop.dataset.popKey);
    }
  }
});

document.addEventListener("keydown", (e) => {
  const pop = e.target.closest && e.target.closest(".rowchip-pop");
  if (pop) {
    const kind = pop.dataset.rowchipPop;
    const key = pop.dataset.popKey || "";
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setRowChipOpen(kind, key, false);
      closeRowChipPop(kind, key, { focusChip: true });
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (stepRowChipPop(pop, e.key === "ArrowDown" ? 1 : -1)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    return;
  }
  const chip = e.target.closest && e.target.closest("[data-rowchip]");
  if (chip && e.key === "Escape" && chip.getAttribute("aria-expanded") === "true") {
    e.preventDefault();
    e.stopPropagation();
    const kind = chip.dataset.rowchip;
    const key = chip.dataset.rowchipKey || "";
    setRowChipOpen(kind, key, false);
    closeRowChipPop(kind, key, { focusChip: true });
  }
});

// The popup is fixed, so it does not travel with its chip: a scroll or a resize re-measures it. A chip that left the
// page takes its card with it.
const rowChipReposition = () => {
  for (const pop of [...document.querySelectorAll(".rowchip-pop")]) {
    if (!pop._anchor || !pop._anchor.isConnected) {
      setRowChipOpen(pop.dataset.rowchipPop, pop.dataset.popKey, false);
      pop.remove();
      continue;
    }
    placeRowChipPop(pop, pop._anchor);
  }
};
document.addEventListener("scroll", rowChipReposition, true);
window.addEventListener("resize", rowChipReposition);
// ---- end the two cards as chips

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
