// project-row.js - cut 2 of the three in public/render-projects.js: the row, and what hangs under it.
//
// Cut 2 of the three in the card for public/render-projects.js, entry 6 of the order of work in
// docs/reports/module-separation-2026-11-28.html (row 530). It is a move, not a rewrite: lines
// 562-1378 of the base file are below, verbatim, and no body was rewritten and no call site touched.
//
// WHAT IS HERE. The turnover container: TURNOVER_ROW_PREFIX, turnoverRowPath, isTurnoverRowPath,
// turnoverBranchNames, turnoverKeyOf, isTurnoverBranchRow, turnoverPlaceholderRow, applyTurnoverRows
// and dropTurnoverPlaceholder - every turnover branch a project names is a row of its own, standing on
// its worktree or on a placeholder. The parent line: isBaseRefName, chartParentKeyOf, parentGapOf,
// turnoverKeptKeys and turnoverKeepsRow read which row a tree hangs under and why a mark says it cannot.
// The grouping: childTreeOf, groupCtxOf and nestRowKeys, then foldTitle, foldButtonHtml,
// paintFoldButton, paintRowGroup, paintLanes with laneSignatures, paintUnder, markUnder,
// syncChildGroups and toggleChildFold, the one fold that only hides. The row itself: initiativeCellHtml
// and rowHtml, the template every cell is written into. The kind column: KIND_MARK, kindMarkHtml,
// TURNOVER_ROW_SAY, TURNOVER_START_ROW_SAY, turnoverRowMarkHtml and parentGapHtml. The reviewed chip:
// reviewChipShown and reviewRowMarkHtml.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: every
// top-level `function` here is a window property, every `const` a binding another script reads by bare
// name. This file DECLARES ONLY - TURNOVER_ROW_PREFIX, KIND_MARK, the two SAY strings and laneSignatures
// are literal initialisers - so being loaded before render-projects.js and app.js costs nothing.
// public/render-projects.js keeps the header and the record of this surface, and app.js re-exports the
// names on window.WMApp.projects.


// ---- children under their parent ---------------------------------------------------------------
// Every turnover branch a project NAMES is a container, and the chart draws it as a row of its own: the worktree
// standing on that branch when there is one, and a row of its own when nothing stands there yet. Its children are the
// trees cut from it, and the chart hangs them under it, one indent in, with the fold that puts the group out of sight.
//
// FIVE RULES KEEP THE PICTURE HONEST, and the first two are the container's:
//   • THE ATTACHMENT IS READ FROM THE CUT BOOK, through the server's `row.parentLine` (lib/parent-line.js, whose
//     RECORDED case goes through lib/worktrees.js `recordedParentFor` and nothing else). Only `kind: "recorded"`
//     attaches. A RECONSTRUCTED parent (a reflog, a shared ticket) and an UNKNOWN one attach NOWHERE - a guess drawn
//     as a group is a picture the reader cannot tell from a record - and the row says so with the ∅ mark
//     (`parentGapHtml`), whose tooltip carries the parent line's own reason. A row with no parent line at all (an
//     older snapshot, a fixture) falls back to `row.parent` ONLY when `row.parentSource` is "cut", which is the same
//     "the panel watched this cut" fact the book carries; a backfilled guess never attaches.
//   • A CONTAINER ROW HAS NOTHING ABOVE IT, and a container is never held back by the chart's top N: its children hang
//     under it, so a held container would leave its own children floating at the top level. `turnoverKeepsRow` is
//     the answer the chart's split asks (public/charts.js).
//   • a child hangs under its parent only while the PARENT IS ON THE CHART. The chart's top-N can hold a parent back
//     while its child ranks higher; the child then keeps its own row at the top level rather than hanging under a
//     row that is not drawn or disappearing with it.
//   • a record can point in a circle (two backfilled guesses). The loop is broken where it closes: the row that would
//     be its own ancestor is drawn at the top level, because a row cannot hang under itself.
//   • MAIN IS NEVER A ROW'S PARENT. The checkout's own row IS main, so a tree cut from main is its SIBLING, not its
//     child: the round's frozen parent tree is that case, and every stage tree of the round hangs under the parent
//     tree instead. A book written before the cut stopped recording `main` (lib/jobs.js `round: true`) still names
//     it, and refusing the edge here is what draws the sibling picture for that board without a migration - the same
//     rule lib/parents.js has always applied to a roll-up target.
//   • A ROUND'S OWN RECORD NAMES ITS CHILDREN. `row.round.parentPath` is read from the queue task that cut the tree
//     (lib/round-tree-names.js), the same record the row's NAME comes from. The branch edge arrives only with a
//     scanned row, so a board that has just booted drew every name and no group until each row's scan landed - and a
//     stage tree the parent book never recorded had no group at all. The record is exact (the panel cut the tree), so
//     it wins over a scanned branch edge; the same "parent must be a drawn row of this project" rule still applies.

// A synthetic container row's path. It starts with a prefix no directory can, so nothing that takes a row's path to
// the filesystem can mistake it for a tree; the branch half is the row's identity, because the row IS the branch.
const TURNOVER_ROW_PREFIX = "turnover:";
const turnoverRowPath = (branch) => `${TURNOVER_ROW_PREFIX}${String(branch || "").trim()}`;
const isTurnoverRowPath = (p) => String(p || "").startsWith(TURNOVER_ROW_PREFIX);

// Every turnover branch the project names, lowercased -> its own spelling. The list is `project.turnoverBranches`
// (lib/project-turnover.js `turnoverBranchesOf`, merged onto the record by lib/projects.js), and the old single key
// `turnoverBranch` is read as one entry, so a record written before the list existed still draws its container.
function turnoverBranchNames(project) {
  const p = state.projects?.get?.(project);
  const out = new Map();
  const add = (entry) => {
    const name = String(entry && typeof entry === "object" ? entry.branch || "" : entry || "").trim();
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), name);
  };
  for (const entry of Array.isArray(p?.turnoverBranches) ? p.turnoverBranches : []) add(entry);
  add(p?.turnoverBranch);
  return out;
}

// The feature key a named turnover branch carries, when the project's list records one. Used by the start press, so
// the container it makes is filed under the same key the branch already has.
function turnoverKeyOf(project, branch) {
  const p = state.projects?.get?.(project);
  const want = String(branch || "").trim().toLowerCase();
  for (const entry of Array.isArray(p?.turnoverBranches) ? p.turnoverBranches : []) {
    const name = String(entry && typeof entry === "object" ? entry.branch || "" : entry || "").trim();
    if (name.toLowerCase() === want) return String((entry && typeof entry === "object" && entry.key) || "");
  }
  return "";
}

// Is this row the container of a turnover branch? The project's own record is the first answer; the row's kind is the
// second, because a tree whose branch was renamed after its cut keeps its turnover record and is still the container.
function isTurnoverBranchRow(row) {
  const branch = String(row?.branch || "").trim();
  if (!branch) return false;
  if (turnoverBranchNames(row.project).has(branch.toLowerCase())) return true;
  return String(row?.branchKind || "").trim() === "turnover";
}

// A turnover branch with no worktree gets a row of its own so the chart can hang its children under it. It is NOT a
// worktree: `placeholder` says nothing may be read, renamed, locked, deleted or started IN it, and the one control it
// carries is the press that makes it one (`btn-start-turnover`, POST /api/worktree/turnover-start).
function turnoverPlaceholderRow(project, branch) {
  const key = turnoverKeyOf(project, branch);
  return {
    project,
    path: turnoverRowPath(branch),
    name: branch,
    branch,
    branchKind: "turnover",
    branchKindLabel: "turnover tree",
    branchKindParent: null,
    placeholder: true,
    turnoverBranch: branch,
    turnoverKey: key || null,
    parent: null,
    parentSource: "unknown",
  };
}

// Put the project's turnover containers on the board as rows. A branch a worktree already stands on is that row -
// nothing is synthesized for it - and a branch the project has stopped naming loses its placeholder.
function applyTurnoverRows(project) {
  const name = String(project || "").trim();
  if (!name) return [];
  const branches = turnoverBranchNames(name);
  const standing = new Set();
  for (const r of state.rows.values()) {
    if (r.project !== name || r.placeholder) continue;
    const b = String(r.branch || "").trim().toLowerCase();
    if (b) standing.add(b);
  }
  const out = [];
  for (const [lower, branch] of branches) {
    if (standing.has(lower)) continue;
    const key = keyOf(name, turnoverRowPath(branch));
    const row = state.rows.get(key) || turnoverPlaceholderRow(name, branch);
    state.rows.set(key, row);
    out.push(row);
  }
  // Two removals, in one pass: a placeholder whose branch now has a real row, and one the project no longer names.
  for (const [k, r] of [...state.rows]) {
    if (r.project !== name || !r.placeholder) continue;
    const lower = String(r.branch || "").toLowerCase();
    if (standing.has(lower) || !branches.has(lower)) {
      state.rowEls?.get(k)?.remove();
      state.rowEls?.delete(k);
      state.detailEls?.get(k)?.remove();
      state.detailEls?.delete(k);
      state.rows.delete(k);
      state.foldedParents?.delete(k);
    }
  }
  return out;
}

// The same answer for ONE arriving row: if it now stands on a branch the chart was drawing as a placeholder, the
// placeholder is gone before the row is painted. Called by placeRow, so a scan tick and a snapshot cannot disagree.
function dropTurnoverPlaceholder(project, branch) {
  const spelling = String(branch || "").trim();
  if (!spelling || !turnoverBranchNames(project).has(spelling.toLowerCase())) return false;
  const key = keyOf(project, turnoverRowPath(spelling));
  if (!state.rows.get(key)?.placeholder) return false;
  state.rows.delete(key);
  state.rowEls?.get(key)?.remove();
  state.rowEls?.delete(key);
  state.detailEls?.get(key)?.remove();
  state.detailEls?.delete(key);
  state.foldedParents?.delete(key);
  return true;
}

// Is a ref name one of the project's bases? main/master/trunk/develop and the project's own mainBranch; a
// remote-tracking `origin/<base>` counts too, because a round is cut from origin/main and that is still the base.
function isBaseRefName(ref, mainBranch) {
  const name = String(ref || "").trim().toLowerCase();
  if (!name) return false;
  const names = new Set(["main", "master", "trunk", "develop"]);
  if (mainBranch) names.add(String(mainBranch).trim().toLowerCase());
  return names.has(name) || names.has(name.replace(/^origin\//, ""));
}

// The key of the row this one hangs under, or null. THE ONE RULE, in the order the facts are trusted:
//   1. a container row is the top of its own group;
//   2. a round child's edge is the record's own (the panel cut it for this round);
//   3. the cut book, through the row's `parentLine` - only `recorded` attaches;
//   4. no parent line at all: only a `parentSource: "cut"` edge attaches, never a backfilled guess.
function chartParentKeyOf(row, { byBranch, byPath, mainBranch }) {
  if (!row) return null;
  if (row.placeholder || isTurnoverBranchRow(row)) return null;
  const key = keyOf(row.project, row.path);
  const roundParent = row.round && typeof row.round === "object" ? normPath(row.round.parentPath || "").toLowerCase() : "";
  if (roundParent) {
    const pk = byPath.get(roundParent);
    return pk && pk !== key ? pk : null;
  }
  const line = row.parentLine && typeof row.parentLine === "object" ? row.parentLine : null;
  if (line) {
    if (line.kind !== "recorded") return null;
    const par = String(line.parent || "").trim();
    if (!par || par === String(row.branch || "").trim() || isBaseRefName(par, mainBranch)) return null;
    return byBranch.get(par) || null;
  }
  const par = String(row.parent || "").trim();
  if (!par || par === String(row.branch || "").trim() || isBaseRefName(par, mainBranch)) return null;
  if (String(row.parentSource || "").trim().toLowerCase() !== "cut") return null;
  return byBranch.get(par) || null;
}

// WHY A ROW ATTACHES NOWHERE. The chart draws the ∅ mark beside the name of a child whose parent the book cannot
// name, and this is the one sentence that mark carries. It answers only for a row the chart did NOT attach: a
// recorded parent that is drawn, a base, a container and a row with no record at all carry no gap.
function parentGapOf(row, tree = null) {
  if (!row || row.placeholder) return null;
  const key = keyOf(row.project, row.path);
  const groups = tree || childTreeOf(row.project);
  if (groups.parentOf.get(key)) return null;
  const line = row.parentLine && typeof row.parentLine === "object" ? row.parentLine : null;
  if (line) {
    if (line.kind === "reconstructed") {
      return {
        why: "attaches nowhere - its parent was reconstructed, not recorded",
        title: `${line.text} - a reconstruction is not a record, so the chart does not hang this tree under a guess`,
      };
    }
    if (line.kind === "unknown") {
      return {
        why: "attaches nowhere - the cut book cannot name its parent",
        title: `${line.text} - with no recorded parent there is nothing this tree can hang under`,
      };
    }
    if (line.kind === "recorded") {
      const par = String(line.parent || "").trim();
      if (!par) return null;
      return {
        why: `attaches nowhere - cut from ${par}, which has no row on this chart`,
        title: `the cut book records ${par} as its parent, and no row of this project stands on ${par} - the tree is drawn at the top level rather than under a row that is not there`,
      };
    }
    return null;
  }
  const par = String(row.parent || "").trim();
  if (par && String(row.parentSource || "").trim().toLowerCase() === "backfilled") {
    return {
      why: `attaches nowhere - ${par} was reconstructed, not recorded`,
      title: "the parent book guessed this parent; a guess is not a record, so the chart does not hang the tree under it",
    };
  }
  return null;
}

// A container, and every row under it, is drawn whatever the chart's top N says: the container is the shape of the
// group, and a held container would leave its own children floating at the top level. Built from ONE childTreeOf per
// call, so a caller that needs the whole set (the chart's split) does not build the tree once per row.
function turnoverKeptKeys(project) {
  const containers = new Set();
  for (const [k, r] of state.rows) {
    if (r.project !== project) continue;
    if (r.placeholder || isTurnoverBranchRow(r)) containers.add(k);
  }
  if (!containers.size) return containers;
  const kept = new Set(containers);
  const tree = childTreeOf(project);
  for (const k of tree.parentOf.keys()) {
    const seen = new Set([k]);
    for (let cur = tree.parentOf.get(k); cur; cur = tree.parentOf.get(cur)) {
      if (seen.has(cur)) break;
      seen.add(cur);
      if (containers.has(cur)) {
        kept.add(k);
        break;
      }
    }
  }
  return kept;
}

// The same answer for one row, for a caller that already holds the row.
function turnoverKeepsRow(row) {
  if (!row) return false;
  return turnoverKeptKeys(row.project).has(keyOf(row.project, row.path));
}

function childTreeOf(project) {
  const byBranch = new Map();
  const byPath = new Map();
  for (const r of state.rows.values()) {
    if (r.project !== project) continue;
    const k = keyOf(project, r.path);
    const p = normPath(r.path).toLowerCase();
    if (p && !isTurnoverRowPath(r.path) && !byPath.has(p)) byPath.set(p, k);
    const b = String(r.branch || "").trim();
    if (!b) continue;
    if (!byBranch.has(b)) byBranch.set(b, k);
  }
  // The project's own main branch, and the names every project calls it. `state.projects` carries `mainBranch` from
  // the scan (a repo whose main is `dev` says so); the four literal names are the floor under a project the page has
  // not seen yet.
  const mainBranch = String(state.projects?.get?.(project)?.mainBranch || "").trim();
  const parentOf = new Map();
  for (const r of state.rows.values()) {
    if (r.project !== project) continue;
    const k = keyOf(project, r.path);
    const pk = chartParentKeyOf(r, { byBranch, byPath, mainBranch });
    if (pk && pk !== k) parentOf.set(k, pk);
  }
  for (const k of [...parentOf.keys()]) {
    const seen = new Set([k]);
    for (let cur = parentOf.get(k); cur; cur = parentOf.get(cur)) {
      if (seen.has(cur)) {
        parentOf.delete(k);
        break;
      }
      seen.add(cur);
    }
  }
  const childrenOf = new Map();
  for (const [k, pk] of parentOf) {
    const kids = childrenOf.get(pk) || [];
    kids.push(k);
    childrenOf.set(pk, kids);
  }
  return { parentOf, childrenOf };
}

// What one row needs to know about its place: the row it hangs under (only while that row is drawn), how deep it is,
// how many of its own children are drawn, whether the reader has folded IT, and whether an ancestor is folded — the
// last one is what makes a rebuild come back folded instead of re-opening a group on the reader.
//
// The DEPTH counts the rows that are DRAWN above this one, never the records: the chart's top-N can hold a grandparent
// back while its child and grandchild are both on the chart, and a depth read off the records would step the grandchild
// in twice under a parent drawn at 0. A row that hangs under nothing is depth 0, a GROUP PARENT included, which is
// what puts its name in the same column as an ungrouped sibling's. The painter writes that number onto every row and
// public/chart.css turns it into the one indent rule the whole chart shares.
function groupCtxOf(tree, key, drawn = null) {
  const onChart = (k) => !drawn || drawn.has(k);
  const pk = tree.parentOf.get(key) || null;
  const parentKey = pk && onChart(pk) ? pk : null;
  let depth = 0;
  let hidden = false;
  for (let cur = parentKey; cur && onChart(cur); cur = tree.parentOf.get(cur)) {
    depth += 1;
    if (state.foldedParents.has(cur)) hidden = true;
  }
  return {
    parentKey,
    depth,
    childCount: (tree.childrenOf.get(key) || []).filter(onChart).length,
    folded: state.foldedParents.has(key),
    hidden,
  };
}

// The drawing order with every child moved directly under its parent — the one list both renderProjectRows() and
// reorder() paint from, so a scan tick and a full rebuild cannot disagree about where a child sits. A key whose
// parent is not in the list keeps its own place: that is the top-N case, and also a row of another project.
function nestRowKeys(parentOf, keys) {
  const inList = new Set(keys);
  const kidsOf = new Map();
  for (const k of keys) {
    const pk = parentOf.get(k);
    if (!pk || !inList.has(pk)) continue;
    const kids = kidsOf.get(pk) || [];
    kids.push(k);
    kidsOf.set(pk, kids);
  }
  const out = [];
  const seen = new Set();
  const emit = (k) => {
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
    for (const c of kidsOf.get(k) || []) emit(c);
  };
  for (const k of keys) if (!inList.has(parentOf.get(k))) emit(k);
  for (const k of keys) emit(k);
  return out;
}

function foldTitle(row, count, folded) {
  const what = `${count} worktree${count === 1 ? "" : "s"} cut from ${row.branch || "this tree"}`;
  return folded
    ? `show the ${what} — each keeps its own chips, actions and open panel; the fold only put them out of sight`
    : `hide the ${what} — folded one indent in under this row; nothing is removed and every open panel stays open behind the fold`;
}

function foldButtonHtml(key, row, ctx) {
  const n = ctx.childCount;
  return `<button class="btn-row-fold${ctx.folded ? " is-folded" : ""}" type="button" data-fold-tree="${esc(key)}" aria-expanded="${
    ctx.folded ? "false" : "true"
  }" aria-label="${ctx.folded ? "show" : "hide"} the ${n} worktree${n === 1 ? "" : "s"} cut from ${esc(row.branch || "this tree")}" title="${esc(
    foldTitle(row, n, ctx.folded),
  )}">${ctx.folded ? "\u25b8" : "\u25be"}</button>`;
}

// Paint the fold control in place — the node is kept, never replaced, because the button is what the pointer and the
// keyboard are on when it flips.
function paintFoldButton(btn, key, row, ctx) {
  const n = ctx.childCount;
  const glyph = ctx.folded ? "\u25b8" : "\u25be";
  if (btn.textContent !== glyph) btn.textContent = glyph;
  if (btn.getAttribute("aria-expanded") !== (ctx.folded ? "false" : "true")) {
    btn.setAttribute("aria-expanded", ctx.folded ? "false" : "true");
  }
  const label = `${ctx.folded ? "show" : "hide"} the ${n} worktree${n === 1 ? "" : "s"} cut from ${row.branch || "this tree"}`;
  if (btn.getAttribute("aria-label") !== label) btn.setAttribute("aria-label", label);
  const title = foldTitle(row, n, ctx.folded);
  if (btn.title !== title) btn.title = title;
  btn.classList.toggle("is-folded", ctx.folded);
}

// Everything the grouping draws for ONE row: its child/parent classes, the indent, the fold control, and the lane
// that says "cut from the row above". The lead slot is filled in place so a re-rank or a scan tick never rebuilds a
// control the reader is pointing at.
//
// `place` is the DRAWN order's answer, never the records': the last child of a group closes its lane, and a re-rank
// can hand that place to another row, so syncChildGroups works it out from the table it is painting.
//   lastChild  this row is the last drawn child of its parent, so its L stops at the corner.
//   lanes      the depths of the ancestors whose own lanes stay open through this row, because that ancestor has a
//              later sibling below it: a grandchild hangs inside its parent's group, and the group's guide has to run
//              past it or the line breaks on exactly the rows that are deepest.
function paintRowGroup(tr, row, key, ctx, place = {}) {
  const child = Boolean(ctx.parentKey);
  tr.classList.toggle("is-child", child);
  tr.classList.toggle("is-parent", ctx.childCount > 0);
  // Hidden because an ANCESTOR is folded. The row itself stays in the document: folding is a class, not a removal,
  // which is what lets an open console, a half-typed reply and a scroll position survive it.
  tr.classList.toggle("is-fold-hidden", ctx.hidden);
  // Folded itself: the lane out of its own fold has nothing under it to continue into, so the sheet draws none.
  tr.classList.toggle("is-folded", ctx.folded);
  // The group's foot: the last DRAWN child of its parent. Its L turns the corner and stops there.
  tr.classList.toggle("is-last-child", child && Boolean(place.lastChild));
  // The depth is written for EVERY row, a group parent included: 0 is a real answer (it is what keeps the parent in an
  // ungrouped sibling's column) and one rule in public/chart.css reads it off every row, so the indent can no longer
  // depend on which markers a row happens to carry.
  const depth = String(ctx.depth);
  if (tr.dataset.depth !== depth) tr.dataset.depth = depth;
  if (tr.style.getPropertyValue("--child-depth") !== depth) tr.style.setProperty("--child-depth", depth);
  if (child) {
    if (tr.dataset.parentKey !== ctx.parentKey) tr.dataset.parentKey = ctx.parentKey;
  } else if (tr.hasAttribute("data-parent-key")) {
    tr.removeAttribute("data-parent-key");
  }
  const lead = tr.querySelector("td.name .row-lead");
  if (!lead) return;
  let tick = lead.querySelector(".child-tick");
  if (child && !tick) {
    // An EMPTY span on purpose: the L is drawn by public/chart.css as a border, so its vertical stroke stands exactly
    // on the guide axis and reaches the row's edges. The └ glyph it used to carry could do neither - a glyph's stroke
    // starts inside its box and stops above its baseline - which is what put the guide a few pixels right of the
    // parent's triangle and left every depth stepping away from the one above it.
    lead.insertAdjacentHTML("afterbegin", '<span class="child-tick" aria-hidden="true"></span>');
    tick = lead.querySelector(".child-tick");
  } else if (!child && tick) {
    tick.remove();
  }
  let btn = lead.querySelector(".btn-row-fold");
  if (ctx.childCount && !btn) {
    lead.insertAdjacentHTML("beforeend", foldButtonHtml(key, row, ctx));
    btn = lead.querySelector(".btn-row-fold");
  } else if (!ctx.childCount && btn) {
    btn.remove();
    btn = null;
  }
  if (btn) paintFoldButton(btn, key, row, ctx);
  paintLanes(lead, child ? place.lanes || [] : []);
}

// The lanes of the ancestors that are still open above a row. They are kept in place like the tick: only re-drawn when
// the set of depths moves, so a scan tick that repaints every row does not churn the DOM under the reader.
const laneSignatures = new WeakMap();
function paintLanes(lead, lanes) {
  if (!lead || typeof lead.querySelectorAll !== "function") return;
  const sig = lanes.join(",");
  if (laneSignatures.get(lead) === sig) return;
  laneSignatures.set(lead, sig);
  for (const el of lead.querySelectorAll(".child-lane")) el.remove();
  if (!lanes.length) return;
  lead.insertAdjacentHTML(
    "afterbegin",
    lanes.map((depth) => `<span class="child-lane" aria-hidden="true" style="--lane-depth:${Number(depth)}"></span>`).join(""),
  );
}

// The nodes painted UNDER a row — its detail, a question it is asking, the ⟳'s offer — say which row they hang from
// and hide with it. Everything here carries `data-parent-key`, so one selector finds a whole group.
function paintUnder(el, ctx) {
  if (!el) return;
  if (ctx.parentKey) el.dataset.parentKey = ctx.parentKey;
  else if (el.hasAttribute("data-parent-key")) el.removeAttribute("data-parent-key");
  el.classList.toggle("is-fold-hidden", ctx.hidden);
}

function markUnder(el, key) {
  const project = state.rows.get(key)?.project;
  if (!el || !project) return el;
  paintUnder(el, groupCtxOf(childTreeOf(project), key));
  return el;
}

// One pass over a project's drawn rows, so a rebuild, a single-row repaint and a re-rank cannot each draw a
// different picture of the same tree.
function syncChildGroups(project) {
  const tbody = state.tbodyEls.get(project);
  if (!tbody || !tbody.isConnected) return;
  const tree = childTreeOf(project);
  const rows = [...tbody.children].filter((el) => el.classList.contains("row"));
  const drawn = new Set(rows.map((el) => el.dataset.key));
  const offers = new Map([...tbody.querySelectorAll("tr.refresh-offer")].map((el) => [el.dataset.refreshOffer, el]));
  // The place of each row in the table, in one pass: the last child of a parent closes the group's lane, and "last"
  // is the DRAWN order's answer. A re-rank moves a child, so reading it off the records would leave the corner on a
  // row that is no longer the group's foot.
  const ctxOf = new Map(rows.map((el) => [el.dataset.key, groupCtxOf(tree, el.dataset.key, drawn)]));
  const lastChildOf = new Map();
  for (const el of rows) {
    const ctx = ctxOf.get(el.dataset.key);
    if (ctx && ctx.parentKey) lastChildOf.set(ctx.parentKey, el.dataset.key);
  }
  // The lanes that stay open above a row: its ancestors' own lanes, each one only while that ancestor has a later
  // sibling below it. A depth-0 row has no lane of its own, and a row's own lane is drawn by its tick, not here.
  const laneDepthsOf = (key) => {
    const out = [];
    for (let cur = ctxOf.get(key)?.parentKey; cur; cur = ctxOf.get(cur)?.parentKey || null) {
      const up = ctxOf.get(cur);
      if (!up || !up.depth) continue;
      if (up.parentKey && lastChildOf.get(up.parentKey) !== cur) out.push(up.depth);
    }
    return out.sort((a, b) => a - b);
  };
  for (const tr of rows) {
    const key = tr.dataset.key;
    const row = state.rows.get(key);
    if (!row) continue;
    const ctx = ctxOf.get(key);
    paintRowGroup(tr, row, key, ctx, {
      lastChild: Boolean(ctx.parentKey) && lastChildOf.get(ctx.parentKey) === key,
      lanes: ctx.parentKey ? laneDepthsOf(key) : [],
    });
    for (const el of [state.detailEls.get(key), state.confirmEls.get(key), offers.get(key)]) paintUnder(el, ctx);
  }
}

// Fold or unfold one parent. It writes nothing but the reader's own book: the children are hidden where they stand,
// so their chips, their open panel and anything typed into it are exactly where they were when the fold opens again.
function toggleChildFold(key) {
  const row = state.rows.get(key);
  if (!row) return;
  if (state.foldedParents.has(key)) state.foldedParents.delete(key);
  else state.foldedParents.add(key);
  saveFoldedParents();
  syncChildGroups(row.project);
}
// ---- end children under their parent

// The initiative column: the big pieces of work a tree is behind, as chips. Absence is the normal case and is drawn as
// a dash with the reason in its tooltip, not as a scolding zero. More than one chip is legal: an initiative is a way to
// hold a piece of work together across projects, and two pieces of work can share a tree. The value comes from the
// side store keyed by tree path (lib/initiatives.js), overlaid by the server, so nothing here has to survive a scan.
// THE CHIP IS PRESSABLE, AND THE KEYBOARD REACHES IT. public/app.js delegates the press (a click, or Enter and Space
// on the focused chip) and public/assistant.js publishes the opener: the float on its Initiatives tab, that card
// unfolded, scrolled to and flashed. So the chip is a role="button" with a tabindex and nothing else changes - it is
// still one chip per initiative, still ellipsised to the cell's one line, and a tree with none still draws the dash
// below rather than an empty box.
function initiativeCellHtml(row) {
  const list = Array.isArray(row?.initiatives) ? row.initiatives.filter((i) => i && i.title) : [];
  if (!list.length) {
    return `<td class="initiative"><span class="dim" title="no initiative - the normal case: nothing enforces one, and a tree with none behaves exactly as it always did. An initiative is a big piece of work that can span several projects and several assistants; add this tree in the Initiatives tab beside Role.">-</span></td>`;
  }
  const chips = list
    .map(
      (i) =>
        `<span class="chip initiative-chip" role="button" tabindex="0" data-initiative-id="${esc(i.id)}" title="initiative: ${esc(i.title)} - the Initiatives tab beside Role holds the whole piece of work">${esc(i.title)}</span>`,
    )
    .join("");
  return `<td class="initiative">${chips}</td>`;
}

function rowHtml(row, forceOwner = false) {
  const isOpen = rowDrawsOpen(keyOf(row.project, row.path));
  // A CONTAINER WITH NO WORKTREE. It is a chart row for a turnover BRANCH, not a tree: every control that acts on a
  // path is suppressed, the counts say nothing rather than "clean", and the one control it carries is the press that
  // makes it a worktree (`btn-start-turnover`, POST /api/worktree/turnover-start). The server's `placeholder` flag is
  // the only source for this - a real row standing on a turnover branch is an ordinary row with an ordinary ✕.
  const container = row.placeholder === true;
  // A row whose path is no longer a tree of its own (lib/scan.js's RELEASED row) has no counts to show: "clean" would
  // be a claim about a worktree that is not there, so the cell says — with the reason in its tooltip.
  const releasedWhy = row.released ? String(row.released.why || "this path is not a worktree any more") : "";
  const dirty = container
    ? `<span class="dim" title="this row is the turnover BRANCH, not a worktree: there is nothing to read here until it is started">—</span>`
    : releasedWhy
      ? `<span class="dim" title="${esc(releasedWhy)}">—</span>`
      : row.dirty || row.untracked
        ? `<span class="dirty">${row.dirty}</span>${row.untracked ? ` <span class="dimmer">+${row.untracked}?</span>` : ""}`
        : `<span class="clean">clean</span>`;
  const pr = container ? "" : prCellHtml(row);
  const badge = container
    ? `<span class="dim" title="a turnover branch drawn as its own row: children are cut from it and merge back into it, and no worktree stands on it yet">container</span>`
    : verdictHtml(row);
  // The project's own checkout is not a worktree anyone may delete or rename from here: it keeps the folder's name.
  const isProjectRoot = isProjectRootRow(row);
  // The start press, in the row's own words: what it starts and what it refuses are both in the tooltip, because a
  // control that silently refuses is the same as one that does nothing.
  const startTurnoverBtn = container
    ? `<button class="btn-start-turnover" type="button" data-start-turnover="${esc(row.branch)}" data-start-project="${esc(row.project)}" data-start-key="${esc(row.turnoverKey || "")}" title="start this turnover container: put a worktree on ${esc(row.branch)} so its children can be rolled into it and reconciled. It cuts no commit and no branch, starts no agent, pushes nothing, opens no pull request and lands nothing. It refuses a branch this project does not name as a turnover branch, and it refuses when git cannot put a worktree on this one - the error says which.">start</button>`
    : "";

  // A tree is named from the prompt, cut at 24 characters; the agent names itself better a moment later. The button
  // offers that name first and takes anything the reader types. The branch column already carries the real name, so
  // the row does not repeat it here.
  const shownTitle = treeTitleOf(row);
  const shownName = shownTitle || row.name;
  const suggestName = shownTitle || "";
  // Who gave this tree the name it has, and when — the panel's own record (lib/tree-names.js), the one fact about
  // naming that git does not hold. It is what makes "the panel will not rename this again by itself" visible.
  const namedLine = String(row.named?.line || "").trim();
  // A title the panel's own naming looked at and DECLINED (it promised a PR, a commit, a merge). The tree keeps
  // the name it was cut with, and the row says why rather than looking like a naming that never arrived.
  const offerLine = String(row.nameOffer?.line || "").trim();
  const renameBtn = isProjectRoot || container
    ? ""
    : `<button class="btn-row-rename" data-rename-tree="${esc(keyOf(row.project, row.path))}" data-rename-project="${esc(row.project)}" data-rename-path="${esc(row.path)}" data-rename-name="${esc(row.name)}" data-rename-suggest="${esc(suggestName)}" title="name this worktree by hand — renames its branch, and the directory when nothing is holding it${suggestName ? ` (offered: “${esc(suggestName)}”)` : ""}${namedLine ? ` · ${esc(namedLine)}` : ""}${offerLine ? ` · ${esc(offerLine)}` : ""}">\u270e</button>`;
  // ＋ cuts a CHILD worktree off this row's own branch (POST /api/worktree/child). It sits to the left of the ⟳
  // deliberately: the three controls read as one sentence down the row — make another tree from this branch, re-read
  // this one, remove this one. A row with no branch (a detached HEAD) has nothing to cut from, and the project's own
  // checkout is not a worktree, so neither draws it. The glyph is the ASCII plus on purpose: the mono stack this cell
  // is set in has no ⑂/⤷ on Windows, and a control that renders as nothing is worse than a plain one.
  const childBtn = isProjectRoot || container || !row.branch
    ? ""
    : `<button class="btn-child-tree" data-child-tree="${esc(keyOf(row.project, row.path))}" data-child-project="${esc(row.project)}" data-child-path="${esc(row.path)}" data-child-branch="${esc(row.branch)}" type="button" title="cut a child worktree off ${esc(row.branch)} — a new tree on a new branch cut from this one, on its own row below; nothing is started in it and nothing is pushed, and it is what the child's UNMERGED chip rolls back into ${esc(row.branch)}">+</button>`;
  // One ✕ per row, and whether it needs the question at all: merged + clean deletes straight away.
  const delKey = keyOf(row.project, row.path);
  const delDirect = !isProjectRoot && deletableWithoutAsking(delKey);
  const lock = row.lock || null;
  const lockKeyAttr = esc(keyOf(row.project, row.path));
  // The reader's lock, as an emoji on the row itself (lib/locks.js). TWO toggles, because the two scopes are a real
  // difference: the padlock beside the name is THIS worktree, the one in the branch cell is the BRANCH — and the
  // branch one keeps protecting trees cut from it later, which is the whole point of locking a turnover branch. Each
  // shows its own bit truthfully, so a tree protected only by its branch reads 🔓 beside the name and 🔒 beside the
  // branch, and neither can be mistaken for the other. A locked row also carries `is-locked` on the <tr>, so the
  // state is visible without reading a tooltip.
  const treeLocked = Boolean(lock?.tree);
  // The branch's NAME lives in `lock.branch`; the boolean lives in `lock.branchLocked`. Reading the name as a truthy
  // lock made every row with a branch draw as a locked branch.
  const branchLockedByBranch = Boolean(lock?.branchLocked);
  const lockTitle = treeLocked
    ? `${lock.line || "🔒 this worktree is locked"} — click to unlock it. Nothing may delete it while it is locked.`
    : branchLockedByBranch
      ? `this worktree is not locked itself, but ${lock.branch ? `branch ${lock.branch}` : "its branch"} is (see the 🔒 in the branch cell) — click to lock this worktree as well`
      : "lock this worktree — a locked worktree can never be deleted: not by this row's ✕, not by a merge agent, not by any route";
  const treeLockBtn = container
    ? ""
    : `<button class="btn-row-lock${treeLocked ? " is-locked" : ""}" type="button" data-lock-scope="tree" data-lock-tree="${lockKeyAttr}"
    title="${esc(lockTitle)}" aria-pressed="${treeLocked ? "true" : "false"}" aria-label="lock this worktree">${treeLocked ? "\u{1F512}" : "\u{1F513}"}</button>`;
  const branchLockTitle = branchLockedByBranch
    ? `${lock.line || "🔒 this branch is locked"} — click to unlock it. Every worktree on ${lock.branch || "this branch"}, now and later, is protected while it is locked.`
    : "lock this BRANCH — protects this worktree and every worktree created on the branch later (a turnover branch stays protected as trees come and go)";
  const branchLockBtn = isProjectRoot || container
    ? ""
    : `<button class="btn-row-lock btn-branch-lock${branchLockedByBranch ? " is-locked" : ""}" type="button" data-lock-scope="branch" data-lock-tree="${lockKeyAttr}"
      title="${esc(branchLockTitle)}" aria-pressed="${branchLockedByBranch ? "true" : "false"}" aria-label="lock this branch">${branchLockedByBranch ? "\u{1F512}" : "\u{1F513}"}</button>`;
  // Whether this row stands ON the project's turnover branch. Read here, beside the lock, because the two are the two
  // things a row says about what may be done with the tree: the lock says "nothing deletes this", the turnover mark
  // says "children are cut from here at will". A tree can carry either, both or neither, so neither reads the other.
  const onTurnoverBranch = isTurnoverBranchRow(row);
  // One cell per column, keyed by the column's id (CHART_COLUMNS), so the row and the header cannot disagree about
  // which cell is which: a hidden column is simply not in `cells`, and the row is the shown set in table order. The
  // life and next-read cells carry their own <td> (both are painted in place every second), which is why `life` and
  // `nextread` are read, not wrapped.
  const cells = {
    // The whole name as well as the drawn one: the name can be ellipsised (`td.name .row-name`, chart.css line 113),
    // and the copy handler (public/core/copy-full-value.js) answers a copy OR a highlight inside the cell with this
    // value instead of the fragment the selection covers. It is NOT `data-copy`, which is the console's block-lift
    // attribute and would grow a ⧉ button inside the cell.
    //
    // The row's RESULT chip is deliberately not in this line any more: it is the `reviewedExtra` cell below, a column
    // of its own beside the name. Two review chips in the name line pushed the name into an ellipsis on every row that
    // carried both; the amber mark and its press stay here, and the chip that prints the summary, the age and
    // "reviewed" moved out. The collision side is ONE diamond button in this line - it replaced both the per-pair
    // marks and the counts chip that used to sit after them, so the width those two spent is the name's again.
    name: `<td class="name" data-copy-value="${esc(shownName)}"><div class="name-line"><span class="row-lead"></span>${container ? "" : `<button class="btn-row-agent" data-agent-path="${esc(row.path)}" data-agent-name="${esc(row.name)}" data-agent-project="${esc(row.project)}"
      title="probe every NOT-RUNNING agent in this worktree — sends 'Continue if you can, exit if you are done' to each of them (the + under the agents starts a new one)">\u25b6</button>`}<span class="row-name${onTurnoverBranch ? " is-turnover" : ""}"${onTurnoverBranch ? ' style="color:var(--blue)"' : ""} title="${esc(container ? `${row.branch} - one of this project's turnover branches, drawn as its own row because no worktree stands on it yet; press start to make the container tree` : row.path)}">${esc(shownName)}</span>${renameBtn}${treeLockBtn}${turnoverRowMarkHtml(row)}${parentGapHtml(row)}${container ? "" : collisionDiamondHtml(row, delKey)}${container ? "" : reviewRowMarkHtml(row)}${container ? "" : agentBadgeHtml(row)}</div></td>`,
    // THE SECOND REVIEW CHIP, in a cell of its own (CHART_COLUMNS `reviewedExtra`). Off means the whole column is
    // absent - header, cell and colspan - so there is no empty cell to leave behind; the amber mark in the name line
    // is a different chip with its own switch. A row with no delivery draws the chart's usual dash, never a blank.
    reviewedExtra: `<td class="reviewed-extra">${container ? `<span class="dimmer">—</span>` : resultChipHtml(row, delKey) || `<span class="dimmer">—</span>`}</td>`,
    // Same rule for the branch, whose whole column is one ellipsis (chart.css line 83). The cell also holds the
    // remote link, a `local` chip and the branch's padlock, so the value is the branch itself, never the cell's text.
    branch: `<td class="mono branch" data-copy-value="${esc(row.branch || "")}">${branchCellHtml(row)}${branchLockBtn}</td>`,
    // The owner column: the assistant's NAME from the owner cell region above — never the raw id, never the role
    // label and never a dash. OFF by default: lib/chart-columns.js `DEFAULT_HIDDEN_COLUMNS`, applied when the reader
    // has no stored list.
    assistant: ownerCellHtml(row),
    initiative: initiativeCellHtml(row),
    tip: `<td class="mono dim nowrap">${esc(row.head || "—")}</td>`,
    ahead: `<td class="mono nowrap">${container ? `<span class="dimmer" title="this row is the turnover branch, not a worktree: it has no copy on the remote to count against">—</span>` : aheadBehindCellHtml(row)}</td>`,
    cherry: `<td class="mono dim nowrap">${container ? `<span class="dimmer" title="this row is the turnover branch, not a worktree: nothing has been cherry-read here">—</span>` : `+${row.cherryPlus ?? 0}/−${row.cherryMinus ?? 0}`}</td>`,
    pr: `<td class="pr">${pr}</td>`,
    dirty: `<td class="mono nowrap">${dirty}</td>`,
    life: container ? `<td class="age nowrap"><span class="age-line"><span class="age-num dimmer" title="this row is a turnover branch, not a worktree - no agent has ever run in it">branch row</span></span></td>` : lifeCellHtml(row),
    nextread: container ? `<td class="nextread nowrap"><span class="dimmer" title="nothing to read: this row is the branch, not a worktree - start it, then the container tree is read like any other row">—</span></td>` : nextReadCellHtml(row),
    verdict: `<td class="verdict">${badge}</td>`,
    // THE KIND revisited: the mark is in `kind`, a cell of its own to the LEFT of the verdict, because in the verdict
    // cell it clipped the words the reader needs (the badge is what says ON MAIN or MERGED). Empty is the honest
    // answer for a row with no record: the column says "nothing recorded", and no letter is invented for it.
    kind: `<td class="kind">${kindMarkHtml(row)}</td>`,
    actions: `<td class="row-actions">${container ? startTurnoverBtn : isProjectRoot ? "" : `${childBtn}<button class="btn-refresh-tree" data-refresh-tree="${esc(delKey)}" type="button" title="reconcile this one worktree — re-read its git state (dirty, ahead/behind, cherry, verdict, PR), then check its TODO list against what the tree now contains (a proposal, nothing closed) and its description, re-derived only if it has gone stale; every action is journalled under the row">\u27f3</button><button class="btn-del-tree${delDirect ? " is-direct" : ""}" data-del-tree="${esc(delKey)}" title="${delDirect ? "this worktree is merged and clean — deletes it straight away, its files go to the Recycle Bin and git's record is pruned" : "remove this worktree — asks first; its files go to the Recycle Bin and git's record of it is pruned"}">✕</button>`}</td>`,
  };
  // The lane is read through `typeof`: a scope without it reads as "no delivery" instead of throwing. The amber left
  // edge is part of the reviewed chip, so it goes when the chip's switch is off: a row still banded amber beside a
  // name line with no mark would be the chart half-hiding the thing the reader switched off.
  const reviewOn = reviewChipShown();
  return `<tr class="row${isOpen ? " expanded" : ""}${lock ? " is-locked" : ""}${container ? " is-turnover-container" : ""}${reviewOn && !container && typeof wtReviewLane !== "undefined" && wtReviewLane.awaiting(row) ? " has-review" : ""}${!container && typeof wtReviewLane !== "undefined" && wtReviewLane.awaitingCollisions(row).length ? " has-collision" : ""}" data-key="${esc(keyOf(row.project, row.path))}">
    ${shownColumns(forceOwner).map((i) => cells[CHART_COLUMNS[i].id]).join("\n    ")}
  </tr>`;
}

// ---- the kind a cut recorded, in a column of its own ------------------------------------------
// WHAT KIND OF TREE THIS IS, drawn from the record the cut wrote (lib/branch-kind.js, branch-parents.json) and the
// server stamps on the row (`branchKind`, `branchKindLabel`, `branchKindLifted`, `branchKindParent`).
//
// IT IS ONE LETTER, IN THE `kind` COLUMN (CHART_COLUMNS), immediately to the LEFT of the verdict. The name line
// already carries the row's own controls and marks, and the landing before this one had to move a review chip into a
// cell of its own because two chips squeezed the name out. This answers that with the smallest thing that can be
// read: T for the turnover tree (the feature container), R for a research tree, a title and an aria-label that spell
// the kind out, and the chart's legend decoding the pair.
//
// IT IS NOT IN THE VERDICT CELL, and a source comment that says it belongs there is what shipped the defect this
// column repairs: the letter led the badge, and the verdict cell clipped the words the reader needs (his screenshot
// showed an R chip where ON MAIN and MERGED used to be). The verdict cell is the badge alone; the kind is what the
// verdict's landing question MEETS - a research tree's push is refused until the reader lifts it - so the two sit
// side by side and neither can clip the other. The column is one more switch in Settings > Board > Chart columns,
// ON by default, and off means the whole cell is absent rather than an empty one.
//
// T is a STATEMENT: a turnover tree is the feature container - research and implementation trees are cut from it, and
// an implementation tree's work merges back into it locally. R and I are BUTTONS while the record is unlifted:
// pressing one opens the inline confirm (public/app.js `showKindConfirm`) that lifts the local-only kind through POST
// /api/worktree/kind-lift. The lift does NOT rewrite the record, but the cell names what the tree BEHAVES AS: an
// upgraded R or I reads T, and its tooltip says the kind it was - "was an implementation tree, upgraded by the reader;
// it behaves as a turnover tree". A tree with no record draws nothing at all, and the cell stays empty.
const KIND_MARK = { turnover: "T", research: "R", implementation: "I" };

function kindMarkHtml(row) {
  const kind = String(row?.branchKind || "").toLowerCase();
  const mark = KIND_MARK[kind];
  if (!mark) return "";
  const label = String(row.branchKindLabel || (kind === "research" ? "research tree" : kind === "implementation" ? "implementation tree" : "turnover tree"));
  const parent = String(row.branchKindParent || "").trim() || (kind === "turnover" ? "the project's base" : "the project's main parent");
  if (kind === "turnover") {
    const says = `${label} - the feature container${parent ? ` (cut from ${parent})` : ""}: research and implementation trees are cut from it, and an implementation tree's work merges back into it locally. How the turnover tree itself lands is the project's own rule, and its push meets the ordinary controls.`;
    return `<span class="kind-mark kind-turnover" role="img" aria-label="${esc(label)}" title="${esc(says)}">${mark}</span>`;
  }
  // BOTH LOCAL KINDS LIFT THE SAME WAY. The kind is what the cut recorded; the lift is the reader's per-tree grant
  // that makes a push meet the ordinary controls, and it is written on the same record. Research and implementation
  // differ in what they DO with the work (release it, or merge it locally), not in how the lift works.
  //
  // AND THE CELL NAMES WHAT AN UPGRADED TREE BEHAVES AS, which is a turnover tree: it reads T, never its old letter
  // with a tick. The record still says research or implementation - the tooltip is where that survives, because the
  // column answers the landing question the row is judged on, and T is the honest answer to it. The lifted green
  // (chart.css `.kind-mark.is-lifted`) is what still separates an upgraded T from one the cut itself recorded.
  if (row.branchKindLifted === true) {
    const was = kind === "research" ? "a research tree" : "an implementation tree";
    const says = `cut from ${parent}; was ${was}, upgraded by the reader; it behaves as a turnover tree, and its push meets the ordinary controls.`;
    return `<span class="kind-mark kind-turnover is-lifted" role="img" aria-label="${esc(`${label}, upgraded by the reader - it behaves as a turnover tree`)}" title="${esc(says)}">T</span>`;
  }
  const says =
    kind === "research"
      ? `${label} - cut from ${parent}, local only: it commits, is copied out and released, and never merges or pushes until you lift it. Press to lift: the kind stays research, the record keeps your answer, and nothing is pushed and no branch moves.`
      : `${label} - cut from ${parent}, local only: its work merges into its turnover branch, or into main only on your grant, and a push parks on the permission card. Press to lift: the kind stays implementation, the record keeps your answer, and nothing is pushed and no branch moves.`;
  return `<button class="kind-mark kind-${kind}" type="button" data-kind-lift="${esc(keyOf(row.project, row.path))}" aria-label="${esc(`${label}, local only - press to lift`)}" title="${esc(says)}">${mark}</button>`;
}

// The row's turnover mark, drawn beside the lock. `turnoverFor` (public/board-scaffold.js) is the branch the project's
// head chip edits and the value a cut for that project starts from, so a row standing ON it is where child worktrees
// are cut from at will - and where this project's work rolls back into. It is NOT the lock and never borrows its
// state: the lock is the reader's "nothing may delete this", and a tree may be on the turnover branch, locked, both or
// neither.
//
// The row says it twice on purpose. The name is drawn blue at a glance (inline, so it wins over the locked row's amber
// name without moving that rule); the marker is the half a reader who cannot see blue still has - a shape of its own,
// plus the same sentence in its tooltip and its aria-label.
const TURNOVER_ROW_SAY = "the turnover branch for this project - assistants may cut child worktrees from it at will";
const TURNOVER_START_ROW_SAY =
  "a turnover branch this project names, drawn as its own container row: children are cut from it and merge back into it, and no worktree stands on it yet";

function turnoverRowMarkHtml(row) {
  if (!isTurnoverBranchRow(row)) return "";
  const say = row.placeholder ? TURNOVER_START_ROW_SAY : TURNOVER_ROW_SAY;
  return `<span class="turnover-mark" role="img" aria-label="${esc(say)}" title="${esc(say)}">\u21c4</span>`;
}

// THE ∅ MARK: a tree the chart did not hang under a parent, with the reason in a tooltip. It is drawn from
// `parentGapOf` (the grouping region), which answers only when the cut book cannot give the chart a parent it can
// trust - a reconstruction, an unknown, or a recorded parent with no row on this chart. A tree cut from the base, a
// container and a plain row carry nothing: silence there is the truth, not a gap.
function parentGapHtml(row, tree = null) {
  const gap = parentGapOf(row, tree);
  if (!gap) return "";
  return `<span class="parent-gap" role="img" aria-label="${esc(gap.why)}" title="${esc(gap.title)}">\u2205</span>`;
}

// ---- reviewed chip: the amber mark, its press, and the switch that takes both away -----------------
// THE AMBER REVIEW MARK, and the one press that clears it. A row is marked while its last run left something to
// check (lib/review-inbox.js), and the mark means exactly that: "this row has a result you have not looked at".
//
// IT IS NOT THE OTHER TWO. The yellow 🔒 beside it is the reader's lock ("nothing may delete this tree"), and the
// blue ⇄ is the turnover branch ("children are cut from here"). Neither reads the other's state and neither borrows
// the other's shape or colour: this one is an amber ▣ (a filled square, the shape of a box to tick), its own class,
// its own tooltip, and its own aria-label. A row can carry it with either, both or neither.
//
// The button sits on the row rather than inside the card on purpose: the lane's promise is that a finished result
// cannot be forgotten, and a control that costs a click to reveal is a control the reader skips. It is also the
// element the Human rotation lands on, so H then Enter clears one without a mouse.
//
// Whether the reader's Reviewed chip is drawn at all. The switch lives with the chart's columns (Settings > Board >
// Chart columns), the same stored list, so the one answer is `chartChipShown("reviewed")` in public/charts.js. Read
// through `typeof` so a harness that slices this file without charts.js still draws a row: a chip nobody has switched
// off is the default, exactly as every chart toggle starts ON.
function reviewChipShown() {
  return typeof chartChipShown === "function" ? chartChipShown("reviewed") : true;
}

function reviewRowMarkHtml(row) {
  // Switched off means the element is NOT EMITTED: no span, no button, no placeholder. Hiding it with a class would
  // leave the name line's gap behind and make the chart lie about what it is drawing.
  if (!reviewChipShown()) return "";
  const rec = row?.review;
  if (!rec || !rec.summary) return "";
  const awaiting = typeof wtReviewLane !== "undefined" && wtReviewLane ? wtReviewLane.awaiting(row) : !rec.reviewedAt;
  if (!awaiting) return "";
  const say = typeof wtReviewLane !== "undefined" && wtReviewLane ? wtReviewLane.markerTitle(row) : `result to review - ${rec.summary}`;
  const press = "mark this result reviewed - it leaves the review lane and the header count, and the card stays here with what the run left";
  return `<span class="review-mark" role="img" aria-label="${esc(say)}" title="${esc(say)}">\u25a3</span><button class="btn-review-done" type="button" data-review-done="${esc(keyOf(row.project, row.path))}" data-review-project="${esc(row.project)}" data-review-path="${esc(row.path)}" title="${esc(press)}">\u2713 Reviewed</button>`;
}
// ---- end reviewed chip

// THE VIOLET COLLISION DIAMOND, drawn by public/board-scaffold.js `collisionDiamondHtml`. A row carries ONE of them
// while any pair of live trees in its project is touching the same work (lib/collisions.js), and it is the button the
// pair card sits behind: the per-pair marks and the "0 open . 1 resolved" counts chip that used to share this line
// were the width the reader asked back. The state and the count are in the button's own name and title, so the
// distinction the chip carried is still there - spoken instead of drawn.

