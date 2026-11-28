// board/worktrees.js - the tree list, the delete, the rename, the cut and the kind, cut out of
// public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js is the file six open queue rows claimed at 2026-11-28. This is
// cut 4 of the eight in docs/reports/module-separation-2026-11-28.html, section 5's card for
// public/app.js: "the tree list, delete, rename, cut, child tree and kind". Moved line for line: not
// one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   the tree list          TREE_LIST_ORDER_HOLD_MS, TREE_LIST_ORDER_SETTLE_MS, rowOrderHold,
//                          paintTreeListChips, applyTreeList and treeListComplete: what the server
//                          says about the list this snapshot carries (cached, pending, complete), the
//                          chip that says so, and the hold that keeps a cached list in the order it
//                          was painted in.
//   the row's own lookups  rowForOwner, isPendingScanConv, isHomelessConv, homelessConversations and
//                          pendingScanConversations: which conversation a row is, and the two kinds of
//                          card that have no row to sit under.
//   removing a worktree    worktreeOptionsHtml, deletableWithoutAsking, showWorktreeConfirm, scanTick,
//                          waitForScanPass and confirmDeleteWorktree: the ✕, its confirm, and the wait
//                          for the scan that proves the tree is gone.
//   the reader's lock      toggleWorktreeLock, rowConfirmSent and answerRowConfirm: one press, one
//                          scope, and the row's own answer.
//   naming a tree by hand  renameWorktreePrompt: the ✎, its prompt, and the request that renames the
//                          directory as well as the row.
//   the child tree         childPresses, cutDialog, closeCutDialog, cutDialogHtml, openCutDialog,
//                          cutSubmit and cutChildTree: the + that cuts a tree from the ROW's branch,
//                          the dialog that asks which kind and where it starts, and the cut itself.
//   the kind's lift        kindConfirmEls, kindConfirmOf, closeKindConfirm, showKindConfirm and
//                          confirmKindLift: the R or I that lifts a local-only kind, its confirm, and
//                          the one request that records it.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state.treeList, state.rows, state.jobs, state.projects, state.treeNames, state.expanded,
//   state.expandedProjects, state.collapsedRoots
//                          the stores the list and the row actions keep.
//   apiFetch (core/transport.js), esc, keyOf, normPath, relTime, tailPath (core/dom-format.js),
//   and public/app.js's own $, showBanner, showNote, renderProjectRows, renderJobs, resync,
//   refreshChipCount, paintRowChips, repaintAgentState, rootOf, toggleProject, jumpToAgent,
//   markChipAsked, agentNameOf, rowKeyForThread, loadTreeNames, saveTreeNames and
//   saveCollapsedRoots.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a
// top-level `function` here is a window property and a top-level `const`/`let` (childPresses,
// cutDialog, rowConfirmSent, kindConfirmEls) are bindings every other script reads by bare name.
// index.html loads this file before app.js, and the file DECLARES ONLY - nothing here reads a `state`
// field or an app.js binding while it loads - so sitting before app.js costs nothing and cannot land
// in a temporal dead zone. public/app.js re-exports these names on window.WMApp.worktrees, which is
// the door public/render-projects.js, public/render-jobs.js, public/settings.js and
// public/core/sse.js already reach for.
//
// WHAT STAYED IN app.js: the delegated press handlers that open the dialog and the lift (the row's +,
// the R and the I). They are load-time wiring, so they stay with the page's other listeners and call
// these functions by bare name at press time.
//
// RE-MEASURED FROM 3bb43694. The report's card names 7,442-7,813 and 7,847-8,092. On this base those
// are 4,802-5,173 (the list through the rename) and 5,175-5,453 (the child tree and the kind's lift).
// The report's second row started at cutDialogHtml and would have left the section's own header,
// `childPresses` and closeCutDialog behind; the cut takes the whole section instead, which is the same
// code with its two bindings. The list's own state and its chip (4,765-4,821) are taken as well, so the
// "worktrees" section header moves with the code it heads and app.js keeps none of it.

// ---------------- worktrees ----------------
// The tree list and the state it keeps, moved here whole: lib/tree-cache.js is the server half.
// THE TREE LIST'S OWN STATE, page side (lib/tree-cache.js is the server half). `state.treeList` is what the server says
// about the list this snapshot carries:
//
//   cached        the rows are the last successful scan's, served while this process reads them again
//   cachedTrees   how many are still placeholders (the flag is this count > 0)
//   at            when that scan read them
//   completedAt   the moment a scan enumerated every project's tree list in this process - null before the first one
//
// Two things hang off it. The CHIP says the list is the cached one, so a row's "…" verdict is explained rather than
// mistrusted. The ORDER HOLD keeps every row in the slot it was painted in until the scan that replaces the cached rows
// has landed and settled: the replacement is the same rows read again, so a re-rank mid-scan would be the jump the
// cache exists to remove. The hold is bounded on both sides - 30s while the cached list is served (a scan that never
// lands must not freeze the board), then five minutes after the last cached row is replaced: a board read cold on a slow
// network finishes its first pass well after a ten-second beat, and the reader who watched the file paint must not see
// the order they arrived at re-rank itself while they are still reading it. It is never extended again once settled, so
// the board does return to ranking by activity.
const TREE_LIST_ORDER_HOLD_MS = 30_000;
const TREE_LIST_ORDER_SETTLE_MS = 5 * 60_000;

function rowOrderHold() {
  // The list being served from the file IS the reason to hold: every row on screen came from the cache, and the scan
  // that replaces them is those same rows read again. A deadline alone got this wrong - the page learns "still cached"
  // from a snapshot every few seconds, which is not a clock that can keep a thirty-second deadline alive, so a cold
  // first pass outlived the hold and re-ranked the board under a reader who was still on the first screen.
  if (state.treeList && state.treeList.cached) return true;
  if (!state.rowOrderHoldUntil) return false;
  if (Date.now() < state.rowOrderHoldUntil) return true;
  state.rowOrderHoldUntil = 0;
  state.rowOrderHoldSettled = false;
  return false;
}

// The header chip: one place, outside the board, that says the list is cached and when it was read. It is painted from
// the server's own flag, never from a guess the page makes about a row.
function paintTreeListChips() {
  const el = $("chip-trees");
  if (!el) return;
  const t = state.treeList;
  const cached = Boolean(t && t.cached);
  el.hidden = !cached;
  if (!cached) {
    el.textContent = "";
    el.title = "";
    return;
  }
  const n = Math.max(0, Number(t.cachedTrees) || 0);
  const count = Math.max(n, Number(t.count) || 0);
  el.textContent = `tree list cached${t.at ? ` · read ${relTime(t.at)} ago` : ""}`;
  el.title =
    `the tree list was read at ${t.at || "an unknown time"} and is being served while this process reads it again; ` +
    `${n} of ${count} rows are still the cached ones` +
    (t.completedAt ? "" : ", and no scan has completed yet - no agent is unattached on the strength of a scan that has not finished") +
    ". Each row is replaced in place as its own read lands.";
}

function applyTreeList(t, { completed = null } = {}) {
  if (!t || typeof t !== "object") return;
  const pendingBefore = pendingScanConversations().length;
  const prev = state.treeList || {};
  state.treeList = { ...prev, ...t };
  const now = Date.now();
  if (state.treeList.cached) {
    // The cached list is being served: hold the order it was painted in. A later snapshot re-states the flag, so the
    // deadline moves with it while the list is genuinely still cached - and only until the scan replaces it.
    if (!state.rowOrderHoldSettled) state.rowOrderHoldUntil = Math.max(state.rowOrderHoldUntil || 0, now + TREE_LIST_ORDER_HOLD_MS);
  } else if (prev.cached && !state.rowOrderHoldSettled) {
    // The last cached row has been replaced. Hold the painted order a little longer, so the scan's own frames land
    // under the reader rather than re-ranking the board under their pointer, then rank normally again.
    state.rowOrderHoldUntil = now + TREE_LIST_ORDER_SETTLE_MS;
    state.rowOrderHoldSettled = true;
  }
  paintTreeListChips();
  if (completed) {
    // A completed scan is what may move a card to the unattached list, and what ends the "waiting for the scan" group:
    // the unattached panel is the place that answers both, and each open row's card block answers the second. Repaint
    // those and nothing else - this event carries no rows. A board that had nothing waiting is left alone entirely, so
    // an ordinary pass costs no repaint.
    if (pendingBefore) {
      renderJobs();
      for (const [key, dEl] of state.detailEls) {
        const row = state.rows.get(key);
        if (!row) continue;
        // The detail is what holds a row's cards, and the agent block is part of its signature: clearing it forces the
        // ONE rebuild that moves a card from "waiting" into its row, with the card itself carried across (placeRow).
        dEl.dataset.dsig = "";
        placeRow(row.project, row, { flash: false });
      }
    }
    paintAgentBadges();
  }
}

// THE ROW RULE, page side. A card's owner is the tree it named; the page may say that tree is gone only once a scan has
// actually completed. Until then an owner the list does not carry is UNKNOWN - the list is still arriving, or it is the
// cached one being replaced - and an agent is never drawn as unattached because a scan was slow. This is the client half
// of lib/tree-cache.js: the server serves the last successful tree list, the page refuses to draw a conclusion the list
// has not given it.
// ---- tree list row rule -------------------------------------------------
function treeListComplete() {
  return Boolean(state.treeList && state.treeList.completedAt);
}

function rowForOwner(owner) {
  if (!owner) return null;
  const k = normPath(owner).toLowerCase();
  for (const r of state.rows.values()) if (normPath(r.path).toLowerCase() === k) return r;
  return null;
}

// A card whose tree the list has not named yet, before any scan has completed: not unattached, pending. Its own group
// in the unattached panel says so in words (renderJobs), so the reader never reads "waiting" as "no tree".
function isPendingScanConv(conv) {
  if (assistantSessionFor(conv?.thread)) return false;
  const owner = conv.latest.ownerPath || conv.first.ownerPath || null;
  if (!owner) return false; // no owner at all: genuinely unattached, scan or no scan
  if (treeListComplete()) return false; // a completed scan is the right to judge
  return !rowForOwner(owner);
}

function isHomelessConv(conv) {
  // The assistant is not a homeless worker even though it has no worktree: its card belongs to the floating
  // panel, and listing it in the Agents section as well would put two copies of one thread on the page.
  if (assistantSessionFor(conv?.thread)) return false;
  const owner = conv.latest.ownerPath || conv.first.ownerPath || null;
  if (!owner) return true;
  if (rowForOwner(owner)) return false;
  // THE RULE: before a completed scan, an owner the list does not name is unknown, not unattached (see treeListComplete).
  return treeListComplete();
}

function homelessConversations() {
  // Unattached = no owner, or an owner the last COMPLETED scan did not list (project-root runs, or a worktree that has
  // since been removed). Without this such an agent would fall off the screen.
  return conversations().filter(isHomelessConv);
}

function pendingScanConversations() {
  return conversations().filter(isPendingScanConv);
}
// ---- end tree list row rule ---------------------------------------------

// The worktrees an agent can be attached to, grouped project-first for a readable picker.
function worktreeOptionsHtml() {
  const rows = [...state.rows.values()].sort(
    (a, b) => String(a.project).localeCompare(String(b.project)) || String(a.name).localeCompare(String(b.name)),
  );
  return rows
    .map((r) => `<option value="${esc(r.path)}">${esc(r.project)} · ${esc(r.name)}${r.branch ? ` (${esc(r.branch)})` : ""}</option>`)
    .join("");
}

// ---- removing a worktree ---------------------------------------------------------------------
// A worktree whose work is already in main and which has nothing uncommitted is housekeeping: its ✕
// deletes it without the in-place question, because there is nothing in that folder main does not
// already have. Everything else keeps the question — unmerged commits, a stale verdict (the cheap pass
// only knows what it last saw), any modified or untracked file, and the main branch itself, which is
// never deleted from this table (the project's own checkout has no ✕ at all).
function deletableWithoutAsking(key) {
  const row = state.rows.get(key);
  if (!row) return false;
  // A locked row never deletes straight through, whatever its verdict says: the lock is the reader's, and a delete
  // that skipped the question is exactly the click the lock exists to stop.
  if (row.lock?.locked) return false;
  if (row.verdictStale) return false;
  if (row.dirty || row.untracked) return false;
  const verdict = String(row.verdict || "");
  // A row standing on ITS base - the main branch, or an environment branch of a project with several - is not
  // offered for deletion: the tree is the landing point, not work that has landed.
  if (verdict === "ON MAIN" || verdict === "ON BASE") return false;
  if (row.baseBranch && row.branch && row.branch === row.baseBranch) return false;
  const mainBranch = state.projects.get(row.project)?.mainBranch;
  if (row.branch && mainBranch && row.branch === mainBranch) return false;
  return verdict.startsWith("MERGED");
}

// The red ✕ opens an inline confirmation row under the tree: the question says where the files go
// (Recycle Bin) rather than just "delete?", and nothing happens until the second click. The exception is
// a merged, clean worktree, whose ✕ goes straight through (see deletableWithoutAsking).
function showWorktreeConfirm(key) {
  for (const el of document.querySelectorAll("tr.row-confirm")) el.remove();
  state.confirmEls.clear();
  const rowEl = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  const row = state.rows.get(key);
  if (!rowEl || !row) return;
  // THE LOCK: the question is replaced by the refusal, in the same place the Delete button would have been. It is
  // loud on purpose — the sentence names the lock and says where to remove it — and there is no Delete button to
  // press, because a button that always fails is worse than no button. The server refuses the same call with the
  // same words (409), so a script or an agent that never saw this row is refused too.
  if (row.lock?.locked) {
    const held = document.createElement("tr");
    held.className = "row-confirm row-locked";
    held.dataset.confirmRow = key;
    held.innerHTML = `<td colspan="${wtColspan()}">
        <div class="row-confirm-cell">
          <span class="rc-msg"><span class="rc-lock">${"\u{1F512}"} locked</span> <b>${esc(row.name)}</b> <span class="dimmer">cannot be deleted:</span> ${esc(row.lock.reason || "this worktree is locked by the reader")}</span>
          <span class="rc-actions"><button class="btn-del-no" type="button" data-del-tree-no="${esc(key)}">Close</button></span>
        </div>
      </td>`;
    rowEl.after(held);
    state.confirmEls.set(key, held);
    markUnder(held, key);
    showBanner(`🔒 ${row.lock.reason || "this worktree is locked — unlock it in the row first"}`);
    return;
  }
  const confirm = document.createElement("tr");
  confirm.className = "row-confirm";
  confirm.dataset.confirmRow = key;
  // One cell across every column, not a message cell plus the narrow actions column: the table is laid out at a
  // fixed width, so the 3% actions column could not hold two buttons and they were pushed past the card's edge,
  // where `.project`'s overflow clipped them and nothing could be clicked.
  // The flex layout lives on a div INSIDE the cell: a td with `display:flex` stops being a table cell and loses
  // its colspan, which collapsed this row to its content width instead of the card's.
  confirm.innerHTML = `<td colspan="${wtColspan()}">
      <div class="row-confirm-cell">
        <span class="rc-msg"><span class="dimmer">Remove worktree</span> <b>${esc(row.name)}</b> <span class="dimmer">on</span> <span class="mono">${esc(row.branch || "—")}</span><span class="dimmer">? Its files go to the Recycle Bin (recoverable there) and git's record of it is pruned.</span></span>
        <span class="rc-actions"><button class="btn-del-no" type="button" data-del-tree-no="${esc(key)}">Cancel</button><button class="btn-del-yes" type="button" data-del-tree-yes="${esc(key)}">Delete</button></span>
      </div>
    </td>`;
  state.confirmEls.set(key, confirm);
  rowEl.after(confirm);
  markUnder(confirm, key);
}

// The scanner runs on its own clock, so the board only knows a worktree is gone once a pass has been
// round it. Waiting for the counter to move is what stops a row reappearing from a pass that began
// before the delete.
async function scanTick() {
  try {
    const s = await apiFetch("/api/stats").then((r) => r.json());
    return Number(s?.scheduler?.ticks) || 0;
  } catch {
    return null;
  }
}

async function waitForScanPass(baseline, { timeoutMs = 25000 } = {}) {
  if (baseline === null) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 700));
    const now = await scanTick();
    if (now !== null && now > baseline) return true;
  }
  return false;
}

async function confirmDeleteWorktree(key) {
  const [project, ...rest] = key.split("::");
  const target = rest.join("::");
  const confirmEl = document.querySelector(`tr.row-confirm[data-confirm-row="${CSS.escape(key)}"]`);
  const yes = confirmEl?.querySelector("[data-del-tree-yes]");
  const rowEl = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  const cross = rowEl?.querySelector("[data-del-tree]");
  // The request is fire-and-forget, so the click has to look REGISTERED: the x greys out and stops
  // accepting clicks, the confirmation keeps its "deleting…" label, and both stay that way until the
  // scan has caught up.
  if (cross) {
    cross.disabled = true;
    cross.classList.add("pending");
    cross.title = "deleting this worktree — waiting for the next scan";
  }
  if (yes) {
    yes.disabled = true;
    yes.textContent = "deleting…";
  }
  const baseline = await scanTick();
  try {
    const r = await apiFetch("/api/worktree/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, path: target }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      showBanner(`delete worktree: ${d.error || `HTTP ${r.status}`}`);
      if (cross) {
        cross.disabled = false;
        cross.classList.remove("pending");
        cross.title = "remove this worktree — its files go to the Recycle Bin and git's record of it is pruned";
      }
      if (yes) {
        yes.disabled = false;
        yes.textContent = "Delete";
      }
      return;
    }
    if (yes) yes.textContent = "waiting for the scan…";
    // Everything the board must wait for: the scanner finishing a pass that saw the worktree already
    // gone. Only then is the row dropped here — before it, a pass that started earlier can still put
    // the row back on screen for a folder that no longer exists.
    await waitForScanPass(baseline);
    confirmEl?.remove();
    state.confirmEls.delete(key);
    // Drop it here too: the server broadcasts a `drop`, but a tab whose stream hiccuped would keep a
    // row for a worktree that is gone, and this is the tab that asked for the deletion.
    removeRow(project, d.rowPath || target);
    showBanner(
      d.alreadyGone
        ? `worktree row removed — the folder was already gone (${d.name || target})`
        : d.dirLeft
          ? `worktree removed (${d.name || target}) — its files and git record are gone, but ${
              d.panelHolds ? "this panel was started from that folder; restart it to release the folder" : "another process still holds the folder"
            } — the panel will delete the empty folder as soon as it is released`
          : d.recycled
            ? `worktree removed to the Recycle Bin (${d.name || target})${d.branch ? ` on ${d.branch}` : ""}`
            : `worktree deleted (${d.name || target})${d.branch ? ` on ${d.branch}` : ""} — the Recycle Bin declined it, so the files are gone permanently`,
    );
  } catch (e) {
    showBanner(`delete worktree: ${e.message}`);
    if (cross) {
      cross.disabled = false;
      cross.classList.remove("pending");
    }
    if (yes) {
      yes.disabled = false;
      yes.textContent = "Delete";
    }
  }
}

// ---- the reader's lock: one press, one scope -----------------------------------------------
// `scope` is "tree" (this worktree) or "branch" (the branch it is on, and every worktree cut from it later). The
// server owns the answer: it writes logs/locks.json, broadcasts a snapshot, and returns the state it now holds, so the
// button paints what is true rather than what was hoped for. A refusal is a banner, never a silent no-op.
async function toggleWorktreeLock(scope, key) {
  const row = state.rows.get(key);
  if (!row) return;
  const btn = document.querySelector(`[data-lock-scope="${scope}"][data-lock-tree="${CSS.escape(key)}"]`);
  if (btn) btn.disabled = true;
  try {
    const r = await apiFetch("/api/worktree/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: row.project, path: row.path, branch: row.branch || null, scope }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      showBanner(`lock: ${d.error || `HTTP ${r.status}`}`);
      return;
    }
    showBanner(d.say || (d.locked ? "locked" : "unlocked"));
    // The snapshot the write broadcast repaints this tab too, but a tab whose stream hiccuped would keep the old
    // emoji: re-read once so the row this reader is looking at is right either way.
    await resync();
  } catch (e) {
    showBanner(`lock: ${e.message}`);
  } finally {
    const again = document.querySelector(`[data-lock-scope="${scope}"][data-lock-tree="${CSS.escape(key)}"]`);
    if (again) again.disabled = false;
  }
}

// Cancel/Delete in the confirmation row are consequential, and they sit in a table the board re-ranks
// under the cursor: a repaint between the press and the release replaces the button, the browser delivers
// no click at all, and the reader reports "the delete does nothing" while both buttons are enabled and on
// top. Both answers are therefore read on pointerup (the element under the cursor at release) and this
// short guard makes the click that sometimes still follows a no-op.
const rowConfirmSent = new Map(); // `${key}|${action}` -> when it was answered

function answerRowConfirm(action, key) {
  if (!key) return;
  const id = `${key}|${action}`;
  const at = rowConfirmSent.get(id);
  if (at && Date.now() - at < 4000) return;
  rowConfirmSent.set(id, Date.now());
  if (rowConfirmSent.size > 40) {
    const cut = Date.now() - 60000;
    for (const [k, when] of rowConfirmSent) if (when < cut) rowConfirmSent.delete(k);
  }
  if (action === "yes") {
    void confirmDeleteWorktree(key);
    return;
  }
  const el = state.confirmEls.get(key) || document.querySelector(`tr.row-confirm[data-confirm-row="${CSS.escape(key)}"]`);
  el?.remove();
  state.confirmEls.delete(key);
}

// ---- naming a tree by hand (the ✎) -----------------------------------------------------------
// A worktree carries the name of the prompt that cut it - 24 characters, usually mid-word - while the agent names
// itself from what the work turned out to be a moment later. This puts a name on the row (at once, in this browser)
// and asks the server to do the git half: the branch, and the directory when nothing is holding it open.
async function renameWorktreePrompt(btn) {
  const project = btn.dataset.renameProject || "";
  const path = btn.dataset.renamePath || "";
  const current = btn.dataset.renameName || String(path).split(/[\\/]/).filter(Boolean).pop() || "";
  const suggested = String(btn.dataset.renameSuggest || "").trim() || current;
  const name = window.prompt(
    `name this worktree\n\ndirectory: ${current}\nbranch and directory name:`,
    suggested,
  );
  if (name === null) return;
  const clean = name.trim();
  if (!clean) return;
  const rowKey = btn.dataset.renameTree || keyOf(project, path);
  // The board shows the new name immediately; the git half is best-effort and reports back below.
  state.treeNames.set(rowKey, clean);
  saveTreeNames();
  if ($("projects")) renderProjectRows(project);
  btn.disabled = true;
  try {
    const r = await apiFetch(
      "/api/worktree/rename",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, path, name: clean, by: "the reader (✎ by hand)", how: `named by hand from the row${suggested && suggested !== clean ? ` (offered “${suggested}”)` : ""}` }) },
      { timeoutMs: 120000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // A moved directory is a moved row: the key, the open state and the name follow it.
    if (d.path && d.path !== path) {
      state.treeNames.delete(rowKey);
      state.treeNames.set(keyOf(project, d.path), clean);
      if (state.expanded.delete(rowKey)) state.expanded.add(keyOf(project, d.path));
      saveTreeNames();
    }
    showBanner(
      d.unchanged
        ? `“${clean}” — already its name`
        : `“${clean}” · branch ${d.branch || "unchanged"}${d.moved === false ? ` — the directory keeps its old name` : ""}`,
    );
    await resync();
  } catch (err) {
    showBanner(`named it “${clean}” here — the git half failed: ${err.message}`);
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

// ---- a child worktree off this row's branch -------------------------------------------------
// The roll-up's other half, and the only thing this control does: it cuts a tree from the ROW's branch, never from the
// project checkout. `⇥ → Roll into <parent>` merges a child into the branch it was cut from, INSIDE that branch's own
// worktree — so the parent has to be a worktree branch, and until this existed the panel could only cut children of
// main, the one target a roll may never use. Nothing is started in the new tree: it lands on the board as a row.
//
// The name is asked for in the page's own prompt (the ✎ uses the same one) and it is OPTIONAL — an empty answer means
// "name it after the branch it was cut from", which is what the server does with no name. The -<hex6> tag is always
// the server's: it is the tree's identity through every later rename.
const childPresses = new Map(); // row key -> when its + was last taken, so a double click is one tree

// ---- the cut dialog: WHICH KIND of tree this child is, and WHERE it starts --------------------------------
// A cut records what kind of tree it made (lib/branch-kind.js): a research tree or an implementation tree. Turnover
// is NOT offered - that kind is the feature CONTAINER itself, never a child (a child of a turnover branch is research
// or implementation by its brief). The kinds come from the server, so the page carries no second vocabulary.
//
// The PARENT is the second question, and only a row standing on main has a real choice: the feature's turnover branch
// is preselected (research prefers it), with main still offered as the top-level alternative. A row on a turnover
// branch cuts from it; a row on any other tree cuts a nested child from its own branch. The server answers the list
// (`/api/branch-kinds?project=&parent=`) and refuses a parent that is none of those.
let cutDialog = null; // { el, key, project, path, parent }

function closeCutDialog() {
  if (!cutDialog) return;
  try {
    cutDialog.el.remove();
  } catch {
    /* already gone with a repaint */
  }
  cutDialog = null;
}

function cutDialogHtml(choices, { parent, parents = [], question = "", name = "", note = "" }) {
  const offered = String(parent).split("/").filter(Boolean).pop().replace(/-[0-9a-f]{6}$/i, "");
  const options = (choices || [])
    .map(
      (c) =>
        `<label class="cut-kind" title="${esc(c.label)}"><input type="radio" name="cut-kind" value="${esc(c.value)}" /> <strong>${esc(c.value)}</strong><span>${esc(c.label)}</span></label>`,
    )
    .join("");
  // ONE parent is a statement; two or more are the reader's choice, preselected from the server's answer.
  const rows = (parents || []).filter((p) => p && p.branch);
  const parentHtml =
    rows.length > 1
      ? `<div class="cut-kinds cut-parents" role="radiogroup" aria-label="where the cut starts"><span class="cut-note">from</span>` +
        rows
          .map(
            (p) =>
              `<label class="cut-kind" title="${esc(p.label || p.branch)}"><input type="radio" name="cut-parent" value="${esc(p.branch)}"${p.preselected ? " checked" : ""} /> <span>${esc(p.label || p.branch)}</span></label>`,
          )
          .join("") +
        `</div>`
      : `<div class="cut-note">from ${esc(parent)}${rows[0]?.role === "turnover" ? " - the feature's turnover branch" : ""}.</div>`;
  const tail = question
    ? "nothing has been cut. choose one of the two kinds and press Cut."
    : `its branch: wtgui/&lt;name&gt;-&lt;tag&gt;, cut from the branch above. nothing is started in it and nothing is pushed. leave the kind unchosen and the panel decides: the brief reads as research (answer only) or implementation (merges into its turnover branch locally, never pushes) - and the cut always goes ahead. An implementation asked for with main as its parent first cuts the feature's turnover tree, then cuts this child from it.`;
  return (
    `<div class="cut-head">${question ? esc(question) : `cut a child worktree off ${esc(parent)}`}</div>` +
    parentHtml +
    `<div class="cut-kinds">${options || `<span class="cut-note">reading the two kinds…</span>`}</div>` +
    `<label class="cut-row">name <input class="cut-name" type="text" value="${esc(name)}" placeholder="(empty = ${esc(offered)})" /></label>` +
    `<div class="cut-note">${note ? `${esc(note)} ` : ""}${esc(tail)}</div>` +
    `<div class="cut-actions"><button type="button" class="mc-choice cut-go">Cut</button><button type="button" class="mc-choice cut-cancel">Cancel</button></div>`
  );
}

function openCutDialog({ project, path, parent, key, choices, parents = [], name = "", question = "", note = "" }) {
  closeCutDialog();
  const el = document.createElement("div");
  el.className = "cut-dialog";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "which kind of tree this cut is, and where it starts");
  el.innerHTML = cutDialogHtml(choices, { parent, parents, question, name, note });
  document.body.appendChild(el);
  el.style.left = `${Math.max(8, Math.round((window.innerWidth - el.offsetWidth) / 2))}px`;
  el.style.top = `${Math.max(8, Math.round((window.innerHeight - el.offsetHeight) / 2))}px`;
  cutDialog = { el, project, path, parent, key };
  el.querySelector(".cut-cancel")?.addEventListener("click", closeCutDialog);
  el.querySelector(".cut-go")?.addEventListener("click", () => cutSubmit(cutDialog));
}

async function cutSubmit(dialog) {
  if (!dialog) return;
  const el = dialog.el;
  const name = String(el.querySelector(".cut-name")?.value || "").trim();
  const chosen = el.querySelector('input[name="cut-kind"]:checked')?.value || "";
  // The parent the reader left selected; one row means no radios and the row's own branch stands.
  const parent = String(el.querySelector('input[name="cut-parent"]:checked')?.value || dialog.parent || "").trim();
  const go = el.querySelector(".cut-go");
  if (go) {
    go.disabled = true;
    go.classList.add("is-starting");
  }
  try {
    const r = await apiFetch(
      "/api/worktree/child",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: dialog.project, path: dialog.path, name, kind: chosen || undefined, parent: parent || undefined }),
      },
      { timeoutMs: 120000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    childPresses.set(dialog.key, Date.now());
    closeCutDialog();
    if (d.asked) {
      // The project's turnover policy parks the feature's container on the permission card. Allowing it cuts the
      // container AND this child; nothing is cut until the reader answers.
      showBanner(`${d.project}: the feature's turnover branch ${d.branch} waits on your permission card - allowing it cuts the container and the ${d.kind || "implementation"} tree`);
      await resync();
      return;
    }
    const cut = d.container
      ? `cut ${d.branch} from ${d.parent} as ${d.kind || "a tree"}, and its feature container ${d.container.branch} from ${d.container.parent}`
      : `cut ${d.branch} from ${d.parent} as a ${d.kind || "tree"}${d.localOnly ? " (local only)" : ""}`;
    showBanner(`${cut} - ${d.name || d.branch} is a row now`);
    await resync();
  } catch (err) {
    showBanner(`could not cut a child of ${dialog.parent}: ${String((err && err.message) || err)}`);
    if (go?.isConnected) {
      go.disabled = false;
      go.classList.remove("is-starting");
    }
  }
}

async function cutChildTree(btn) {
  const project = btn.dataset.childProject || "";
  const path = btn.dataset.childPath || "";
  const parent = btn.dataset.childBranch || "";
  const key = btn.dataset.childTree || keyOf(project, path);
  // One press, one tree. A second child of the same branch is a second press - a double click is not.
  if (Date.now() - (childPresses.get(key) || 0) < 3000) return;
  let choices = [];
  let parents = [];
  try {
    const q = new URLSearchParams({ project, parent });
    const r = await apiFetch(`/api/branch-kinds?${q.toString()}`, { method: "GET" }, { timeoutMs: 15000 });
    const d = await r.json().catch(() => ({}));
    choices = Array.isArray(d.choices) ? d.choices : [];
    parents = Array.isArray(d.parents) ? d.parents : [];
  } catch {
    choices = [];
    parents = [];
  }
  openCutDialog({ project, path, parent, key, choices, parents });
}
// ---- end a child worktree off this row's branch

// ---- lifting a local-only kind: the R or I on the row, its confirm, and the one request ---------------------
// THE MISSING CONTROL. A cut records what kind of tree it made (lib/branch-kind.js): a research or implementation
// tree is local only and its push meets a refusal until the reader lifts it; a turnover tree is the feature
// container and has a destination already, so it has no local-only kind to lift.
// Both facts were already written, read by the push rule and answerable by POST /api/worktree/kind-lift - and the
// route had NO control in the page at all, so finishing a landing on a research tree meant opening
// ~/.wag/state/branch-parents.json or hand-calling the API.
//
// The R in the row's Kind column is that control (`kindMarkHtml`, public/render-projects.js). It opens an inline
// confirm in the same shape as the delete question, because a lift changes what a later push is allowed to do. The
// confirm says the one thing it does - the tree's push stops meeting the research refusal - and the answer is written
// on the record, so a restart keeps it. Nothing is pushed here and no branch moves.
const kindConfirmEls = new Map(); // row key -> the inline <tr> that is asking

function kindConfirmOf(key) {
  return (
    kindConfirmEls.get(key) ||
    document.querySelector(`tr.row-kind-confirm[data-kind-confirm="${CSS.escape(key)}"]`) ||
    null
  );
}

function closeKindConfirm(key, { focusTrigger = false } = {}) {
  const el = kindConfirmOf(key);
  el?.remove();
  kindConfirmEls.delete(key);
  if (!focusTrigger) return;
  const trigger = document.querySelector(`[data-kind-lift="${CSS.escape(key)}"]`);
  if (trigger?.isConnected) trigger.focus();
}

function showKindConfirm(key, trigger = null) {
  const row = state.rows.get(key);
  // The question is inserted under the table the press came from: the board and the assistant's Worktrees tab draw
  // the same row builder, and a confirm under the WRONG copy of the row is a question about a table the reader is
  // not looking at.
  const rowEl = (trigger && typeof trigger.closest === "function" && trigger.closest("tr.row")) || document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  if (!row || !rowEl) return;
  const kind = String(row.branchKind || "").toLowerCase();
  // BOTH LOCAL KINDS LIFT, and only those: a turnover tree is the feature container, so it has no local-only kind.
  if (kind !== "research" && kind !== "implementation") return;
  if (row.branchKindLifted === true) return;
  closeKindConfirm(key);
  const el = document.createElement("tr");
  el.className = "row-confirm row-kind-confirm";
  el.dataset.kindConfirm = key;
  // The question names the tree it is about at the moment it is asked. The request reads THESE, not the row's live
  // fields, so a repaint or a rename between the press and the answer cannot lift a different tree than the one the
  // reader was looking at.
  el.dataset.kindPath = row.path;
  el.dataset.kindBranch = row.branch || "";
  el.innerHTML = `<td colspan="${wtColspan()}">
      <div class="row-confirm-cell">
        <span class="rc-msg"><span class="rc-kind">Lift the ${esc(kind)} kind</span> on <b>${esc(row.name || row.branch || key)}</b><span class="dimmer">?</span> The tree's push stops being parked on the permission card: the kind stays ${esc(kind)} and the record keeps lifted: true, so a restart keeps it. Nothing is pushed and no branch moves.</span>
        <span class="rc-actions"><button class="btn-del-no" type="button" data-kind-lift-no="${esc(key)}">Cancel</button><button class="btn-refresh-yes" type="button" data-kind-lift-yes="${esc(key)}">Lift</button></span>
      </div>
    </td>`;
  rowEl.after(el);
  kindConfirmEls.set(key, el);
  markUnder(el, key);
  // The keyboard lands on the question, not on the action: a reader who pressed Enter to OPEN the confirm does not
  // get the lift by pressing Enter again, and Cancel is where Escape would leave them.
  el.querySelector("[data-kind-lift-no]")?.focus();
  el.addEventListener("focusin", () => {
    el.dataset.focused = "1";
  });
  el.addEventListener("focusout", (ev) => {
    if (!el.contains(ev.relatedTarget)) delete el.dataset.focused;
  });
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closeKindConfirm(key, { focusTrigger: true });
  });
  return el;
}

async function confirmKindLift(key, btn = null) {
  const row = state.rows.get(key);
  const el = kindConfirmOf(key);
  if (!row) return;
  const msg = el?.querySelector(".rc-msg");
  const yes = btn && btn.isConnected ? btn : el?.querySelector("[data-kind-lift-yes]");
  // What the question was asked about, bound when it opened (`showKindConfirm`). Falling back to the row keeps a
  // question drawn before this attribute existed answerable.
  const targetPath = String(el?.dataset.kindPath || row.path || "");
  const targetBranch = el?.dataset.kindBranch !== undefined ? String(el.dataset.kindBranch) : String(row.branch || "");
  if (yes) {
    yes.disabled = true;
    yes.textContent = "lifting...";
  }
  const ask = async () => {
    const r = await apiFetch(
      "/api/worktree/kind-lift",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: targetPath, branch: targetBranch }) },
      { timeoutMs: 20000 },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(String(d.error || `HTTP ${r.status}`));
    return d;
  };
  const refuse = (why) => {
    if (msg) {
      msg.querySelectorAll(".rc-refusal").forEach((n) => n.remove());
      msg.insertAdjacentHTML("beforeend", ` <span class="rc-refusal">${esc(why)}</span>`);
    }
    showBanner(`lift refused: ${why}`);
    if (yes && yes.isConnected) {
      yes.disabled = false;
      yes.textContent = "Lift";
    }
  };
  try {
    const d = await ask();
    closeKindConfirm(key);
    const kind = String(d?.branchKind || row.branchKind || "").toLowerCase();
    const label = kind === "research" ? "research tree" : kind === "implementation" ? "implementation tree" : "tree";
    // The row first, the note second: the note is what the reader checks the row against, so it must not start its
    // four seconds while the snapshot is still landing. A resync that fails does not turn a written lift into a
    // refusal - the record is the truth and the next frame will draw it.
    await resync().catch(() => {});
    showNote(`${label} on ${row.name || row.branch || key} is lifted - its push now meets the ordinary controls, and the record keeps it`);
  } catch (err) {
    refuse(String((err && err.message) || err));
  }
}
// ---- end the kind's lift
