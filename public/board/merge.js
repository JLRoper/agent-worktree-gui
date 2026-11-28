// board/merge.js - the merge control, the chooser and the row's own cells, cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js is the file six open queue rows claimed at 2026-11-28. This is
// cut 5 of the eight in docs/reports/module-separation-2026-11-28.html, section 5's card for
// public/app.js: "the verdict, the merge chooser, start-merge, and the row cells". Moved line for
// line: not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   the merge control      mergeInFlight, mergePress, mergeAgentLabel, checkAgentLabel,
//                          baseBranchOf, rebaseTargetOf and verdictHtml: the UNMERGED chip, the
//                          label that says a merge agent is already working that tree, the base a
//                          rebase lands on, and the verdict badge the chip sits in.
//   the chooser            mergeParentOf, mergeChooserTitle, mergeChooser, closeMergeChooser,
//                          openMergeChooser, chooseMergeOutcome and startMerge: the two ways a row
//                          can land (rebase onto the target, or merge into the parent) and the one
//                          press that starts an agent to do it.
//   the row's cells        prMatchNote, baseChipHtml, branchCellHtml, vsMainLine,
//                          aheadBehindCellHtml, prCellHtml, ownerNameOf, ownerLabelOf, ownerRoleOf,
//                          ownerTagOf, ownerCellHtml and ownerDetailHtml: the branch cell and its
//                          local-only chip, the per-row base chip, the ahead/behind cell, the PR
//                          cell with the note that says how the PR was matched, and the owner tag
//                          and detail.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state.projects, state.jobs, state.rows   the stores the control and the cells read.
//   apiFetch (core/transport.js), esc, fmtAgo, relTime, normPath (core/dom-format.js),
//   wtBranchLink (core/branch-link.js), agentsFor and agentNameOf (board-scaffold.js), and
//   public/app.js's own $, showBanner, showNote, verdictClass, renderProjectRows, refreshChips,
//   paintRowChips, jumpToAgent, rootOf, rowKeyForThread and the row's own refresh helpers.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a
// top-level `function` here is a window property and a top-level `const`/`let` (mergeInFlight,
// mergePress, mergeChooser) are bindings every other script reads by bare name. index.html loads this
// file before app.js, and the file DECLARES ONLY - nothing here reads a `state` field or an app.js
// binding while it loads - so sitting before app.js costs nothing and cannot land in a temporal dead
// zone. public/app.js re-exports these names on window.WMApp.merge, which is the door
// public/render-projects.js, public/board-scaffold.js and public/core/branch-link.js already reach for.
//
// WHAT STAYED IN app.js: the delegated presses that open the chooser and start a merge, and the row's
// click handler that treats an `<a>` like a button. They are load-time wiring and call these functions
// by bare name at press time.
//
// RE-MEASURED FROM 3bb43694. The report's card names 8,138-8,453 and 8,510-8,689. On this base those
// are 4,766-5,124 and 5,126-5,366. The first row began at verdictHtml and would have left the chip's
// own labels and the base helpers behind; the cut takes the whole merge control and chooser, which is
// the same code plus the four functions that name its two targets. The second row began at
// baseChipHtml, which would have split the branch cell's own comment block away from branchCellHtml;
// the cut takes prMatchNote and the comment blocks with the cells they describe.

// ---- merge control: the UNMERGED chip ------------------------------------------------------
// A row that carries commits main does not have is the one row with an action worth taking, so that chip is a button:
// one click starts an agent IN that worktree whose whole job is to land the branch (the script is lib/merge-prompt.js
// on the server). The button exists only while the tree is clean — a merge agent commits what it finds, so a
// half-finished tree would land somebody else's work — and while no merge agent is already working that tree. Both
// facts are re-read from git by the route, so a stale board cannot start one by accident.
const mergeInFlight = new Map();
// The chip a press started on, so a release that lands on a rebuilt one still starts the same merge.
let mergePress = null;

function mergeAgentLabel(row) {
  for (const a of agentsFor(row) || []) {
    const label = String(a?.latest?.label || a?.first?.label || "");
    if (!label.startsWith("MERGING into ")) continue;
    if (convLive(a)) return label;
  }
  return null;
}

// The same question for the chooser's fourth outcome: a CHECKING agent already reading this tree. The route refuses a
// second one, so the button is drawn disabled with the reason in its tooltip rather than looking like a dead control.
function checkAgentLabel(row) {
  for (const a of agentsFor(row) || []) {
    const label = String(a?.latest?.label || a?.first?.label || "");
    if (!label.startsWith("CHECKING ")) continue;
    if (convLive(a)) return label;
  }
  return null;
}

function baseBranchOf(row) {
  return String(state.projects.get(row.project)?.mainBranch || "").trim() || "main";
}

// Where a rebase of this row lands, in the page's own words: the recorded parent when there is a local one, otherwise
// the ref the board already measures the branch against (origin/<main>). It is a LABEL, not the decision — the route
// picks the target by proof and its answer names the ref it actually used, because a base ref that sits behind the
// local main branch falls back to that branch and says so.
function rebaseTargetOf(row, parent) {
  if (parent.local) return parent.parent;
  return String(row?.baseRef || "").trim() || parent.main;
}

function verdictHtml(row) {
  const verdict = String(row.verdict || "");
  const cls = `badge ${verdictClass(verdict)}${row.verdictStale ? " stale" : ""}${row.cached ? " cached" : ""}`;
  const text = esc(row.verdict);
  // A CACHED row (lib/tree-cache.js) has not been read in this process: its verdict is the unknown one on purpose, and
  // the tooltip says where the row came from and when, so "…" reads as "not read yet" rather than as a failure.
  const cached = row.cached
    ? `cached from the last successful scan${row.cachedAt ? ` (read ${relTime(row.cachedAt)} ago)` : ""} at ${row.head || "an unknown commit"} — the fresh scan has not reached this tree yet; its own read replaces this row in place`
    : "";
  // A STALE row's badge carries the reason its tree is not on disk and the moment it was last seen there
  // (lib/store.js markStale): "last seen <when> at <path> - <reason>". That is the whole point of keeping the row
  // instead of letting its agents fall into the unattached list.
  const staleLine = String(row.stale?.line || "");
  // A RELEASED row's badge carries the REASON its path stopped being a tree (lib/own-tree.js), because the counts
  // beside it are empty by construction: the tooltip is the only place the reader can find out that this is a folder
  // left behind, and which checkout git would answer for there.
  const released = String(row.released?.why || "");
  // The count against the row's OWN base lives HERE now (lib/base-branches.js: origin/main for most projects, or the
  // row's environment branch), because the Ahead / Behind column counts the branch against its own copy on the
  // remote. Every title below ends with it, and a plain badge, which had no title at all, carries it alone.
  // Inline, not a helper: this region is read out of the page on its own (tools/verify-merge-chip.mjs).
  const vs =
    row.baseRef && row.ahead !== null && row.ahead !== undefined
      ? `Against ${row.baseRef}: ${Number(row.ahead) || 0} ahead, ${Number(row.behind) || 0} behind.`
      : "";
  const withVs = (t) => (vs ? `${t} — ${vs}` : t);
  // Every other verdict is a statement; only UNMERGED has an action behind it.
  if (!verdict.startsWith("UNMERGED")) {
    const title = staleLine || cached || released || vs;
    return `<span class="${cls}"${title ? ` title="${esc(title)}"` : ""}>${text}</span>`;
  }
  const key = keyOf(row.project, row.path);
  const attrs =
    `data-merge-start="${esc(key)}" data-merge-project="${esc(row.project)}" data-merge-path="${esc(row.path)}"` +
    ` data-merge-branch="${esc(row.branch || "")}" data-merge-label="${esc(row.verdict)}"`;
  const merging = mergeAgentLabel(row);
  if (merging) {
    return `<button type="button" class="${cls} merge-start is-merging" ${attrs} disabled title="${esc(
      withVs(`${merging} is working this tree now — its card is under this row`),
    )}">${text}</button>`;
  }
  const dirty = Number(row.dirty) || 0;
  const untracked = Number(row.untracked) || 0;
  if (dirty || untracked) {
    // Not a dead button: the chip stays a statement and its tooltip says what would make it an action, so a click
    // can never start a merge over uncommitted work.
    return `<span class="${cls}" title="${esc(
      withVs(`this is merged by an agent, not by hand: ${dirty} modified and ${untracked} untracked file(s) are somebody's unfinished work — commit or stash them and the button appears`),
    )}">${text}</span>`;
  }
  const base = baseBranchOf(row);
  const parent = mergeParentOf(row);
  return `<button type="button" class="${cls} merge-start" ${attrs} title="${esc(
    withVs(mergeChooserTitle(row, parent)),
  )}">${text}<span class="merge-glyph" aria-hidden="true">\u21e5</span></button>`;
}
// ---- end merge control

// ---- the UNMERGED chip's chooser ---------------------------------------------------------------
// The chip used to start a merge agent on the press. It now opens five outcomes and starts NOTHING until one of them
// is clicked, because "land this" is not one decision: a child cut from a turnover branch belongs ON that branch (a
// roll-up, done in the parent's own worktree), a child that has nowhere local to go belongs on a PR, a child whose
// parent is master or unknown is a question for the reader, and a child that may ALREADY be on main needs somebody to
// say so from the content — the commit count cannot, because a squash merge leaves the branch ahead forever.
//
// The fifth is the CATCH-UP, and the only one that is not an agent: a rebase of this branch onto its parent's newest
// commit, run by the server as one git command (lib/rebase.js). It writes this branch and nothing else, so it needs
// no run, no gateway, no permission box — and it is what makes a later roll a fast-forward instead of a merge commit.
//
// That last outcome is the one that acts on the far side: its agent reads only, and a LANDED: YES is what makes the
// panel move the worktree to the Recycle Bin (the server's own sweep, through the ✕'s act). The button says so.
//
// `parent` is the branch this tree was cut from and `parentSource` says how sure that is: "cut" (the panel watched it),
// "backfilled" (guessed from a shared ticket id in the branch name) or "unknown". Only a "cut" record may drive a
// write, so a backfilled parent is SHOWN and the roll button is disabled with the reason in the popover.
function mergeParentOf(row) {
  const main = baseBranchOf(row);
  const parent = String(row?.parent || "").trim();
  const source = String(row?.parentSource || "unknown");
  const isMain = !parent || parent === main || /^(master|main|trunk|develop)$/i.test(parent);
  // "Local branch" excludes master/main: rolling into those is what the merge agent and the PR path are for.
  const local = Boolean(parent) && !isMain;
  return {
    parent: parent || null,
    sha: row?.parentSha || null,
    source,
    main,
    isMain,
    local,
    // A roll-up writes INSIDE the parent's worktree. Only a recorded cut may do that, never a guess.
    rollable: local && source === "cut",
  };
}

function mergeChooserTitle(row, parent) {
  // The fourth outcome, worded once so every branch of the tooltip says the same thing about what it costs: an agent
  // reads the base for this branch's own change, and when it is there the panel deletes the tree.
  const check = `have an agent check whether the change is already on ${parent.main} (if it is, this worktree goes to the Recycle Bin)`;
  if (parent.rollable) {
    return `choose what happens to ${row.branch || "this branch"}: roll it into ${parent.parent} (fast-forward or merge, inside that branch's own worktree), ` +
      `rebase it onto ${parent.parent}'s newest commit (one git command, nothing but this branch written), open a PR, ${check}, or ask where it should go — nothing happens until you pick one`;
  }
  if (parent.local) {
    return `${row.branch || "this branch"} looks like it belongs on ${parent.parent}, but that parent is a ${parent.source} guess — ` +
      `the panel will not merge on a guess: rebase it onto ${parent.parent}'s newest commit (that writes only this branch), open a PR, ${check}, or say where it should go`;
  }
  return `choose what happens to ${row.branch || "this branch"}: rebase it onto ${rebaseTargetOf(row, parent)}'s newest commit, open a PR, ${check}, or ask where it should go — ` +
    `its parent is ${parent.parent ? `${parent.parent} (a main branch)` : "unknown"}, which is never a roll-up target`;
}

let mergeChooser = null; // { key, el, at }

function closeMergeChooser() {
  if (!mergeChooser) return;
  try {
    mergeChooser.el.remove();
  } catch {
    /* already gone with a repaint */
  }
  mergeChooser = null;
}

// The popover. Appended to the body and positioned against the chip, so a table repaint under it cannot take it out —
// and so the reader can still read the choice while the row it belongs to re-ranks.
function openMergeChooser(key) {
  const row = state.rows.get(key);
  if (!row) return;
  closeMergeChooser();
  const parent = mergeParentOf(row);
  const chip = document.querySelector(`[data-merge-start="${CSS.escape(key)}"]`);
  const notes = [];
  if (parent.rollable) notes.push(`fast-forward or merge inside ${parent.parent}'s own worktree — never the main branch`);
  else if (parent.local) notes.push(`${parent.parent} is a ${parent.source} guess, so rolling is refused: a guess may not drive a merge`);
  else if (parent.parent) notes.push(`${parent.parent} is a main branch — the turnover destination is a PR, not a roll`);
  else notes.push(`no parent was recorded for this tree, and the panel will not invent one`);
  // A branch with its own copy on the remote is about to have that copy's shas rewritten, so the note says so before
  // the press rather than letting the Ahead / Behind column read like a breakage afterwards.
  const publishedRef = String(row?.sync?.ref || "").trim();
  const btn = (choice, label, extra = "", disabled = false, title = "") =>
    `<button type="button" class="mc-choice${extra}" data-merge-choice="${choice}" data-mc-key="${esc(key)}"${disabled ? " disabled" : ""}${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`;
  // A check agent already reading this tree: one at a time, and the button says who rather than going quietly dead.
  const checkLive = checkAgentLabel(row);
  const el = document.createElement("div");
  el.className = "merge-chooser";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "what should happen to this branch");
  el.dataset.mcKey = key;
  el.innerHTML =
    `<div class="mc-head">${esc(row.branch || "this branch")}${parent.parent ? ` <span class="mc-from">cut from ${esc(parent.parent)}${parent.sha ? ` @ ${esc(String(parent.sha).slice(0, 8))}` : ""}${parent.source === "cut" ? "" : ` · ${esc(parent.source)}`}</span>` : ""}</div>` +
    (parent.rollable
      ? btn("roll", `Roll into ${parent.parent}`, " is-roll")
      : btn("roll", parent.parent ? `Roll into ${parent.parent}` : "Roll into its parent", " is-roll", true)) +
    // The rebase is the one outcome that is a plain git command rather than a run, so it says so: no agent, no
    // gateway, no bill. It sits beside the roll because catching the child up is what turns that roll into a
    // fast-forward instead of a merge commit in the parent.
    btn("rebase", `Rebase on ${rebaseTargetOf(row, parent)}`, " is-rebase") +
    btn("pr", "Open a PR", " is-pr") +
    // The fourth outcome, and the only one that can delete the tree: it says so on the popover's own note line, because
    // "check whether it landed" sounds read-only and half of it is not.
    btn("check", `Check whether it is on ${parent.main}`, " is-check", Boolean(checkLive),
      checkLive ? `${checkLive} is already reading this tree — one check at a time` : `start an agent that reads ${parent.main} for this branch's own change; if the change is there, this worktree goes to the Recycle Bin`) +
    btn("ask", "Where should this go?", " is-ask") +
    `<div class="mc-note">${esc(notes.join(" · "))}</div>` +
    // The rebase's own note: what it writes, and the two facts a reader would otherwise discover the hard way — the
    // shas of this branch change, and a copy already on the remote then needs a force-push. A conflict is not a
    // half-rebased tree here; it is an abort.
    `<div class="mc-note mc-note-rebase">${esc(
      `rebase replays this branch's own commits onto ${rebaseTargetOf(row, parent)}'s newest commit and rewrites their shas${publishedRef ? ` — its copy on ${publishedRef} will then need a force-push` : ""}; no agent, nothing else is written, and a conflict aborts leaving the tree exactly as it was`,
    )}</div>` +
    `<div class="mc-note mc-note-check">${esc(
      `the check reads ${parent.main} against this branch's own change and writes nothing to either branch — but if the change is already there it moves this worktree to the Recycle Bin (unlocked and clean only)${checkLive ? ` · ${checkLive} is reading it now` : ""}`,
    )}</div>`;
  document.body.appendChild(el);
  const rect = chip ? chip.getBoundingClientRect() : null;
  if (rect) {
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8));
    const top = rect.bottom + 6 + el.offsetHeight > window.innerHeight ? Math.max(8, rect.top - el.offsetHeight - 6) : rect.bottom + 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
  mergeChooser = { key, el, at: Date.now() };
}

// One click, one outcome. Nothing here runs on the press that opened the chooser.
async function chooseMergeOutcome(what, key) {
  const row = state.rows.get(key);
  if (!row) return;
  const parent = mergeParentOf(row);
  if (what === "pr") {
    // The existing path, unchanged: the merge agent does the landing (and the PR) exactly as it always has.
    return startMerge({ key, project: row.project, path: row.path, label: row.verdict || "" });
  }
  if (what === "rebase") {
    // The one outcome that is a git command rather than a run. The route re-reads the tree from git, picks the target
    // by proof, replays this branch and nothing else, and answers 409 with the colliding paths (already aborted) when
    // it conflicts — so there is nothing to confirm here beyond the choice the reader just made in the popover.
    try {
      const r = await apiFetch(
        "/api/worktree/rebase",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: row.project, path: row.path }) },
        { timeoutMs: 180000 },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showBanner(
        `rebased ${d.branch || row.branch || "the branch"} onto ${d.target} (${d.fromShort} → ${d.toShort}, ${d.replayed} commit${d.replayed === 1 ? "" : "s"} replayed)` +
          (d.published ? ` — its copy on the remote will need a force-push` : ""),
      );
      await resync();
    } catch (e) {
      showBanner(`could not rebase ${row.branch || "the branch"} — ${String(e.message || e)}`);
    }
    return;
  }
  if (what === "ask") {
    try {
      const r = await apiFetch(
        "/api/worktree/parent-question",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: row.project, path: row.path, branch: row.branch || null, note: parent.rollable ? `asked instead of rolling into ${parent.parent}` : "no parent the panel may write to", by: "the reader (chip)" }) },
        { timeoutMs: 30000 },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showBanner(`asked where ${row.branch || "this tree"} should go — recorded, nothing was started`);
    } catch (e) {
      showBanner(`could not record the question — ${String(e.message || e)}`);
    }
    return;
  }
  if (what === "check") {
    // Read-only on both branches, and the panel acts on the answer itself: the run is lib/verify-prompt.js, and a
    // LANDED: YES is what makes the server move this tree to the Recycle Bin (lib/worktree-remove.js). So there is
    // nothing here to confirm beyond the choice the reader already made in the popover.
    try {
      const r = await apiFetch(
        "/api/worktree/verify-landed",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: row.project, path: row.path }) },
        { timeoutMs: 120000 },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showBanner(`${d.label || "CHECKING"} started · ${d.branch || "branch"} against ${d.baseRef || d.base || "the base"} — the tree is deleted only if the answer is yes`);
      if (d.job) {
        updateJob(d.job, { scroll: false });
        revealSpawnedAgent(d.job);
      }
      await resync();
    } catch (e) {
      showBanner(`could not start the check — ${String(e.message || e)}`);
    }
    return;
  }
  if (what !== "roll") return;
  const inFlight = mergeInFlight.get(key) || 0;
  if (Date.now() - inFlight < 15000) return;
  mergeInFlight.set(key, Date.now());
  try {
    const r = await apiFetch(
      "/api/worktree/rollup",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: row.project, path: row.path, parent: parent.parent, branch: row.branch || null, confirm: true }) },
      { timeoutMs: 120000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    showBanner(`rolled ${row.branch || "the branch"} into ${d.parentBranch || parent.parent} (${d.method || "merge"}${d.sha ? ` ${d.sha}` : ""})`);
    await resync();
  } catch (e) {
    mergeInFlight.delete(key);
    showBanner(`could not roll ${row.branch || "the branch"} into ${parent.parent} — ${String(e.message || e)}`);
  }
}

// One click, and the agent is the server's business: this only says where. A repaint can replace the button between
// press and release (the board rebuilds the table on every scan), so the click is taken at pointerup in the delegated
// handler and the request is keyed on the row, not on the node.
async function startMerge(target) {
  // A target, not a button: the chooser has no chip to read the row's facts from (the chip may be a rebuilt node, or
  // gone), and the row key is what names the request either way.
  const path = String(target?.path || "");
  const project = String(target?.project || "");
  if (!path) return;
  const key = target?.key || keyOf(project, path);
  if (Date.now() - (mergeInFlight.get(key) || 0) < 15000) return;
  mergeInFlight.set(key, Date.now());
  const label = String(target?.label || "");
  const btn = target?.btn && target.btn.isConnected ? target.btn : null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-starting");
    btn.textContent = "starting…";
  }
  try {
    const r = await apiFetch(
      "/api/worktree/merge",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, path }) },
      { timeoutMs: 120000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    showBanner(`${d.label || "MERGING"} started · ${d.branch || "branch"} → ${d.base || "base"}${d.job?.id ? ` · ${d.job.id}` : ""}`);
    if (d.job) {
      updateJob(d.job, { scroll: false });
      revealSpawnedAgent(d.job);
    }
    await resync();
  } catch (e) {
    mergeInFlight.delete(key);
    showBanner(`could not start the merge — ${String(e.message || e)}`);
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove("is-starting");
      btn.textContent = label;
    }
  }
}

// Why this row is showing that PR. The panel renames a worktree's branch after the thread slug, so a chip found
// by the tree's tag has to say so — otherwise it cannot be told apart from one found by the branch's own name,
// and that difference is the whole point of the tag route (a branch switched inside one tree gets no chip).
function prMatchNote(pr) {
  if (pr?.matched === "tag") return " · matched by the worktree tag: the panel renamed this branch, and it still carries that PR's commit";
  if (pr?.matched === "upstream") return " · matched by the branch's upstream ref, which this branch still tracks";
  return "";
}

// ---- the branch cell: a link only when the remote actually has that branch ----------------------------
// The URL is built by the SERVER (`row.branchUrl`, from the project's own remote through `githubRepo()` in
// lib/projects.js) and from git's own answer to "does the remote have this branch" — so it is null unless a page
// is certain to exist, and this renders a link or plain text, never a guess. The cell's `mono branch` class and
// its column sizing are untouched, and the row's own click handler already steps aside for an `<a>` (it treats
// `a` like a button), so the link opens the remote page and nothing else.
//
// A branch with no copy on the remote says why in its title AND carries one dim word. That word is the answer to
// the question the chart was asked to answer at a glance — which trees exist on the remote and which are local
// only — and it is the SERVER's answer (`row.branchChip`, written by decorate from the remote's own head list),
// never one re-derived here. Two words, because there are two different claims: `local` is the remote's own denial,
// and `unverified` is the panel admitting it could not tell (the remote was unreachable, or the scan had not read
// the branch yet). The second is not a weaker `local` — a row wearing nothing at all looked identical to one that was
// never pushed, which is the bug: the reader had to open a tooltip to learn the branch was probably on the remote.
// A project without a remote has every branch local, and the title says that instead of marking each row.
// ---- branch cell: the link, and the local chip
//
// The base chip below is the per-row half of lib/base-branches.js: a project whose environments are long-lived branches
// (fleet-kafka: dev, qa, uat, prod and no main) measures each tree against ITS OWN base, and the reader has to be
// able to see which one without opening the verdict's tooltip. It is drawn only when the row's base is NOT the
// project's single base - a board of ordinary `origin/main` rows stays as quiet as it was - and a row whose own base
// is missing keeps the chip with a `?` so the NO BASE REF verdict names the ref that is missing. The arrow is CSS, so
// the cell's copy value (data-copy-value, the branch itself) never grows it.
function baseChipHtml(row) {
  const ref = String(row.baseRef || "").trim();
  if (!ref) return "";
  const source = String(row.baseSource || "");
  if (source === "default" && !row.baseMissing) return "";
  const env = String(row.baseEnv || "").trim();
  const why = row.baseMissing
    ? `no base ref for this row: ${ref} does not exist in this checkout, so this row alone reads NO BASE REF`
    : source === "parent"
      ? `this row is measured against ${ref} - the branch this tree was cut from${env ? ` (the ${env} environment)` : ""}`
      : `this row is measured against ${ref} - the ${env ? `${env} environment` : "environment"} carried by this tree or its branch name`;
  const label = row.baseMissing ? `${ref}?` : ref;
  return ` <span class="branch-base${row.baseMissing ? " is-missing" : ""}" data-base-ref="${esc(ref)}" data-base-source="${esc(source)}" title="${esc(why)}">${esc(label)}</span>`;
}

// THE NAME ITSELF comes from public/core/branch-link.js: one renderer, shared with the Initiatives tab's worktree
// list, so the anchor (href, target, rel, title) cannot drift between the two surfaces. It draws an `<a>` when the
// SERVER resolved a page for this branch and a plain `<span>` when it did not - the fallback is the renderer's, so a
// tree with no resolvable repo reads as a branch name with no dead link. What stays here is the chart's own
// vocabulary: the one chip that says why there is no link, and the base ref the row is measured against.
//
// `branchChip` is decorate's; the `branchLocalOnly` fallback keeps a row drawn from an older payload's field honest.
// A row with no branch at all carries no word: there is nothing for `local` or `unverified` to be about.
function branchCellHtml(row) {
  const name = wtBranchLink.branchNameHtml({
    branch: row.branch,
    url: row.branchUrl,
    linkFrom: row.branchLinkFrom,
    why: row.branchWhy,
    remoteBranch: row.remoteBranch,
  });
  const why = row.branchWhy || (row.remoteBranch === "n/a" ? "no remote configured" : "not read yet - the remote has not been asked about this branch");
  const chip = row.branch ? row.branchChip || (row.branchLocalOnly === true ? "local" : null) : null;
  const chipHtml =
    chip === "local"
      ? `<span class="branch-local" title="${esc(why)}">local</span>`
      : chip === "unverified"
        ? `<span class="branch-unverified" title="${esc(why)}">unverified</span>`
        : "";
  return `${name}${chipHtml ? ` ${chipHtml}` : ""}${baseChipHtml(row)}`;
}
// ---- end branch cell

// ---- ahead / behind cell: the branch against its OWN copy on the remote -------------------------------------------
// ↑ is work that is not pushed, ↓ is work that is not pulled — what `git status` and every git client mean by "ahead /
// behind". The count is the SERVER's answer (`row.sync`, lib/sync-state.js, derived from the fresh `status` read of
// every scan); the page draws it and picks no word of its own. `row.ahead` / `row.behind` are the count against the
// project's main — a different question, "is this work in main?" — and they live in the verdict and in this cell's
// tooltip, not in the cell.
//
//   level / ahead / behind / diverged   ↑N ↓M, the side with work to do lit, a side with none dim
//   gone       the branch's copy was deleted on the remote
//   untracked  the remote has a branch of this name, but this tree does not track it
//   none       no copy on the remote: never pushed
//   stale      the project's last fetch FAILED, so the counts are as of the last fetch that worked: dotted, with a `?`
//
// A page newer than the server that feeds it (the board serves public/ fresh while a process keeps the code it started
// with) gets rows with no `row.sync`: the old numbers are drawn, labelled for what they count, with the one sentence
// that says how to get the real ones.
function vsMainLine(row) {
  if (!row || row.ahead === null || row.ahead === undefined || !row.baseRef) return "";
  const a = Number(row.ahead) || 0;
  const b = Number(row.behind) || 0;
  return `Against ${row.baseRef}: ${a} commit${a === 1 ? "" : "s"} here that it does not have, ${b} on it that this branch does not have (the verdict is built from this).`;
}

function aheadBehindCellHtml(row) {
  const main = vsMainLine(row);
  const s = row?.sync;
  if (!s) {
    const body =
      row?.ahead === null || row?.ahead === undefined
        ? "—"
        : `<span class="${row.ahead ? "dirty" : "dimmer"}">${row.ahead}</span> / ${row.behind ?? "—"}`;
    const why = `${main ? `${main} ` : ""}This board's server is older than this page, so it cannot count against the branch's own copy on the remote yet — restart the board.`;
    return `<span class="ab ab-legacy" data-sync="legacy" title="${esc(why)}">${body}</span>`;
  }
  const dim = (t) => `<span class="dimmer">${t}</span>`;
  const up = (n) => `<span class="dirty ab-up">↑${n}</span>`;
  const down = (n) => `<span class="ab-down">↓${n}</span>`;
  let body;
  switch (s.state) {
    case "level":
      body = `${dim("↑0")} ${dim("↓0")}`;
      break;
    case "ahead":
      body = `${up(s.ahead)} ${dim("↓0")}`;
      break;
    case "behind":
      body = `${dim("↑0")} ${down(s.behind)}`;
      break;
    case "diverged":
      body = `${up(s.ahead)} ${down(s.behind)}`;
      break;
    case "gone":
      body = dim("gone");
      break;
    case "untracked":
      body = dim("?");
      break;
    default:
      body = dim("—");
  }
  const counted = ["level", "ahead", "behind", "diverged"].includes(s.state);
  const stale = counted && Boolean(s.stale);
  const title = [s.why, main].filter(Boolean).join(" ");
  const data = counted ? ` data-ahead="${esc(s.ahead)}" data-behind="${esc(s.behind)}"` : "";
  return `<span class="ab${stale ? " ab-stale" : ""}" data-sync="${esc(s.state)}"${data} title="${esc(title)}">${body}${stale ? `<span class="ab-q" aria-label="stale">?</span>` : ""}</span>`;
}
// ---- end ahead / behind cell

// ---- pr cell: the number and the state, or the one word `none` ----------------------------------------------
// The PR cell: the number and state are the server's (row.pr), and the PAGE is the project's host record — `row.prUrl`
// is built by the same template as the branch cell, so `.../pull-requests/12` and `.../pull/12` both come out right
// without this file knowing which host it is looking at. No URL (an unmapped project, or a host whose pull template
// cannot be filled): the same chip, plain, with the reason in its title. Never an `<a>` around a guessed page.
//
// No PR is one word: `none`. A row whose branch had been deleted from the remote used to read `none · branch gone`
// here, but the branch column one cell to the left already answers that — plain text instead of the blue link, with
// the `local` chip and the reason in its tooltip — so the second half only widened this column with a word the reader
// had read in the cell beside it. This cell answers one question, "which PR is this row's", and `none` is the whole
// answer. `test/pr-cell-none.test.js` holds it to the one word on every `remoteBranch` state.
function prCellHtml(row) {
  if (!row.pr) return `<span class="dimmer">none</span>`;
  // A CLOSED or SUPERSEDED PR is not this row's PR: there is no page to open and no merge to stand behind,
  // so the cell reads the one word `none` exactly as it does for a branch with nothing at all. The server
  // stops handing these over too (lib/project.js `prFor`); this is the page's own half of the same rule, so
  // a row already written with a dead PR cannot draw one either.
  const state = String(row.pr.state || "").toUpperCase();
  if (state !== "OPEN" && state !== "MERGED") return `<span class="dimmer">none</span>`;
  const cls = state === "OPEN" ? "pr-open" : "pr-merged";
  const text = `#${row.pr.number} ${row.pr.state}`;
  const why = row.prUrl ? "" : row.prWhy ? ` · no PR page: ${row.prWhy}` : "";
  const title = `${row.pr.title || ""}${prMatchNote(row.pr)}${why}`;
  if (row.prUrl) {
    return `<a class="pr-link ${cls}" href="${esc(row.prUrl)}" target="_blank" rel="noopener" title="${esc(`${text} — open this PR${why}`)}">${esc(text)}</a>`;
  }
  return `<span class="${cls}" title="${esc(title)}">${esc(text)}</span>`;
}
// ---- end pr cell

// ---- owner cell: the assistant's compact tag, and its name and role in the tooltip -----------------------------
// The owner column answers "whose is this tree" in one glyph pair instead of one name: M1 is Manager 1, M2 is
// Manager 2, A1 is Assistant #1. A cell is one word wide and twelve columns do not fit a name like "Assistant #2"
// twice over, so the cell carries the TAG and the tooltip carries the sentence — the assistant's own name, the
// numbered role label the server resolved, and the display-only reminder. The row's detail keeps the long form
// ("Controlled by: Assistant #1 — Manager") for the reader who wants it spelled out.
//
// The default owner IS Assistant #1, so a row with no `assistant` at all (an older payload, a hand-built row) still
// draws a tag rather than an empty cell or a dash: a column of dashes hides the fact that nothing there is unowned.
// The fallback sentence — the stored owner is no longer on the board — travels in the tooltip and in the detail's
// bullet, because a cell is one tag wide. Nothing in the wake path reads any of this.
//
// The class is `owner`, NOT `assistant`: `.assistant` is the rail's own rule (a sticky flex column 480px wide), and
// a `<td class="assistant">` inherited every line of it — a 480px column, a sticky cell, a left border and the rail's
// background painted into the middle of the chart. The tag class is `owner-tag` for the same reason.
const ownerNameOf = (row) => String(row?.assistant?.name || "").trim() || "Assistant #1";
const ownerLabelOf = (row) => String(row?.assistant?.label || "").trim();
const ownerRoleOf = (row) => String(row?.assistant?.role || "").trim();

// "Manager 1" → "M1", "Code Reviewer 2" → "CR2", "Assistant #1" → "A1". The number comes from the numbered ROLE
// LABEL (the server resolves it from the role the owner runs), and the letters are its initials, so a renamed role
// renames the tag without a write. A row the server could not label falls back to its own name, which always ends in
// the assistant's number.
function ownerTagOf(row) {
  const label = ownerLabelOf(row);
  const name = ownerNameOf(row);
  const source = label || name;
  const m = /^(.*?)[\s#]*(\d+)\s*$/.exec(source);
  const words = String(m ? m[1] : source)
    .split(/[\s/—-]+/)
    .filter(Boolean);
  const initials = words
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return `${initials || "A"}${m ? m[2] : ""}`;
}

function ownerCellHtml(row) {
  const name = ownerNameOf(row);
  const label = ownerLabelOf(row);
  const tag = ownerTagOf(row);
  const seat = `${tag} — ${name}${label ? ` (${label})` : ""} owns this worktree`;
  const title = row?.assistant?.fallback
    ? `${seat} — ${row.assistant.fallback}`
    : `${seat}. Display only: it does not change who wakes or runs.`;
  // The chip is the way INTO that assistant's chat: pressing it opens the chat with "Regarding <project> <worktree>
  // <branch>: " already started, the caret at the end, and sends nothing. It is a BUTTON, not a span, so a keyboard
  // reaches it and Enter presses it - and the chart's row-folding listener already steps over buttons, so a press
  // here never folds the row it sits in. The four fields are drawn onto the chip rather than looked up at press
  // time, so the sentence carries exactly the words the row shows.
  const own = String(row?.assistant?.id || "").trim();
  if (!own) return `<td class="owner nowrap" title="${esc(title)}"><span class="owner-tag" aria-label="${esc(name)}">${esc(tag)}</span></td>`;
  const what = `Press to open ${name}'s chat, started with this worktree and branch named.`;
  return (
    `<td class="owner nowrap" title="${esc(`${title} ${what}`)}">` +
    `<button type="button" class="owner-tag" aria-label="${esc(name)}"` +
    ` data-owner-assistant="${esc(own)}" data-owner-project="${esc(row.project || "")}"` +
    ` data-owner-worktree="${esc(row.name || "")}" data-owner-branch="${esc(row.branch || "")}">${esc(tag)}</button></td>`
  );
}
function ownerDetailHtml(row) {
  const role = ownerRoleOf(row);
  const fallback = row?.assistant?.fallback ? `<span class="owner-fallback"> — ${esc(row.assistant.fallback)}</span>` : "";
  return `<li class="git-owner" title="the assistant that owns this worktree — its own name, then the role it runs; display only: it does not change who wakes or runs">Controlled by: ${esc(ownerNameOf(row))}${role ? ` — ${esc(role)}` : ""}${fallback}</li>`;
}
// ---- end owner cell
