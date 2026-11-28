// board/spawn.js - the add-agent bar, the spawn history, the model picker and the spawn recovery,
// cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js is the file six open queue rows claimed at 2026-11-28. This is
// cut 3 of the eight in docs/reports/module-separation-2026-11-28.html, section 5's card for
// public/app.js: "the add-agent bar, the model picker and the spawn recovery". Moved line for line:
// not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   what a tree is called   loadTreeNames, saveTreeNames, isProjectRootRow and treeTitleOf: the
//                           name typed onto a row, and why the row reads that name rather than the
//                           directory the tree was cut from.
//   spawn history           loadSpawnHistory, saveSpawnHistory, rememberSpawnPrompt, recallSpawnPrompt
//                           and recallReply: shell-style recall for the spawn box and the reply box.
//   the run's own controls  CONTINUE_TEXT, continueThread, reattachCard, askComplete, markChipAsked
//                           and probeWorktreeAgents: the settled card's Continue, its re-attach to a
//                           run the gateway still holds, the one check a finished card can queue,
//                           and the probe that wakes every stopped agent in a worktree.
//   the add-agent bar       addAgentBarHtml, swapAddAgentBox, openAddAgent, closeAddAgent,
//                           submitAddAgent: the inline field a row's + opens, and what its Enter
//                           does.
//   the model picker        modelsState, modelOptionHtml, renderModelPicker, loadModels,
//                           syncProjectPicker, selectedProject, updateSpawnNote: the one list every
//                           model field is built from, and the note that says where the run will
//                           happen.
//   the spawn recovery      focusSpawn, formValues, panelAgentsByPath, rowsInBoardOrder, topAgentOf,
//                           jumpToPanelAgent, jumpToAgent, findTurnStar, landOnSpawnedCard,
//                           revealSpawnedAgent and reviveSession: opening the New agent card at the
//                           reader's project, and landing on the card a spawn has just made even
//                           when its first job event is still racing the repaint.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state.spawn, state.spawnTarget, state.addAgent, state.jobs, state.rows, state.projects,
//   state.expanded, state.expandedProjects, state.collapsedRoots, state.collapsedJobs,
//   state.pendingFocus, state.jumpThread
//                          the stores the bar and the recovery keep.
//   apiFetch (core/transport.js), esc, normPath, relTime (core/dom-format.js), ModelMenu
//   (core/model-menu.js), readBox, writeBox, transferBoxModel, growReplyBox (board/paste-chips.js),
//   and public/app.js's own $, showBanner, showNote, renderConversation, renderJobs, repaintAgentState,
//   agentsFor, convLive, turnLive, rootOf, toggleRoot, toggleProject, saveCollapsedRoots,
//   saveCollapsedJobs, applyRootCollapse, applyPendingFocus, programmaticScroll, refreshAnchorBaseline,
//   revealCard, scrollCardUnderBar and aimSpawnAtWorktree.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a
// top-level `function` here is a window property and a top-level `let` here (modelsState) is a
// binding every other script reads by bare name. index.html loads this file before app.js, and the
// file DECLARES ONLY - nothing here reads a `state` field or an app.js binding while it loads - so
// sitting before app.js costs nothing and cannot land in a temporal dead zone. public/app.js
// re-exports these names on window.WMApp.spawn, which is the door public/render-jobs.js,
// public/render-projects.js, public/board-scaffold.js, public/settings.js and public/assistant.js
// already reach for.
//
// WHAT STAYED IN app.js: the inline field's own delegated events (the input, the caret restore, Enter
// and Escape) are load-time wiring and stay with the page's other listeners; they call these
// functions by bare name at event time.
//
// RE-MEASURED FROM 3bb43694. The report's card names 4,965-5,369, 6,892-6,998 and 7,098-7,385. On
// this base those are 3,984-4,388, 5,030-5,148 and 5,247-5,287 with 5,292-5,536. The last two rows
// are one block in the report; here they are split by the "worktrees" section header, which stays
// where it is to head the functions cut 4 takes.

// ---- what a worktree is called on the board -------------------------------------------------
// A tree is cut from the prompt, so its directory name is the prompt: 24 characters, usually mid-word. Hermes names
// the session from the work itself a moment later ("Fix delete worktree button not removing directory"), and that is
// the name the row should read. A name typed onto the row wins over both; the directory name stays visible beside it,
// because that is what is on disk.
function loadTreeNames() {
  try {
    const raw = JSON.parse(localStorage.getItem(TREENAMES_KEY) || "{}");
    const map = new Map();
    for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
      if (typeof v === "string" && v.trim()) map.set(k, v.trim().slice(0, 120));
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveTreeNames() {
  try {
    const out = {};
    for (const [k, v] of state.treeNames) out[k] = v;
    localStorage.setItem(TREENAMES_KEY, JSON.stringify(out));
  } catch {
    /* storage full or blocked: the board keeps showing the name for this session */
  }
}

// The project's own checkout — the directory the project IS, and the parent of every worktree cut from it. Its name
// is the folder's name and nothing else: an agent run in the checkout (a base-checkout run, no tree cut) has a title
// of its own, and letting that title onto this row renames the project on the board after one agent's job.
function isProjectRootRow(row) {
  const root = state.projects.get(row.project)?.path;
  if (!root || !row.path) return false;
  return normPath(root).toLowerCase() === normPath(row.path).toLowerCase();
}

// The name the row shows, in the order the board can trust: the ROUND's own record first, then a name the reader
// typed into THIS browser, then the agent's own title, then the directory - which the caller falls back to when this
// returns "".
//
// The record wins on purpose. A round's trees are named once, at the cut, from the queue task and the stage document:
// the parent is the task's name and a child is "Stage <n>: <stage>" from its own position (lib/round-tree-names.js,
// read off `pipelineRun.round` / `pipelineRun.trees`). A browser-local `wtgui.treenames` map cannot know any of that,
// so every fresh profile used to draw the directory name instead, and two readers saw two different boards for one
// round. A tree the record names paints the record's name; one it names with no display at all paints the directory
// and nothing else. Trees no round cut carry no record, so the map and the agent's title still name everything else.
// The project's own checkout is exempt from all of it - it reads the folder's name.
function treeTitleOf(row) {
  if (isProjectRootRow(row)) return "";
  const round = row.round && typeof row.round === "object" ? row.round : null;
  if (round) return String(round.display || "").trim().slice(0, 120);
  const own = state.treeNames.get(keyOf(row.project, row.path));
  if (own) return own;
  const a = agentsFor(row)[0];
  return String(a?.latest?.title || a?.first?.title || "").trim();
}
// ---- end what a worktree is called on the board

function loadSpawnHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(SPAWN_HISTORY_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.filter((x) => typeof x === "string" && x.trim()).slice(-SPAWN_HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

function saveSpawnHistory() {
  try {
    localStorage.setItem(SPAWN_HISTORY_KEY, JSON.stringify(state.spawnHistory.slice(-SPAWN_HISTORY_MAX)));
  } catch {
    /* private mode / quota: history is a convenience, not state the panel needs */
  }
}

// Remember a prompt that actually spawned. Consecutive duplicates are noise — pressing Spawn twice
// with the same text should not make Up walk the same line twice.
function rememberSpawnPrompt(text) {
  const clean = String(text || "").trim();
  if (!clean) return;
  if (state.spawnHistory[state.spawnHistory.length - 1] !== clean) {
    state.spawnHistory.push(clean);
    if (state.spawnHistory.length > SPAWN_HISTORY_MAX) {
      state.spawnHistory.splice(0, state.spawnHistory.length - SPAWN_HISTORY_MAX);
    }
    saveSpawnHistory();
  }
  state.spawnNav = null;
}

// step +1 = older, -1 = newer. Returns false when there is nothing to recall, so the caller can let
// the arrow key move the caret instead.
function recallSpawnPrompt(step) {
  const box = $("job-prompt");
  const prompts = state.spawnHistory || [];
  if (!prompts.length) return false;
  // Going forward with no walk in progress would just rewrite the same text and swallow the key.
  if (step < 0 && !(state.spawnNav && state.spawnNav.back > 0)) return false;
  // First Up captures what is in the box as the draft; later steps keep that original draft.
  // What the walk started from is read through readBox: a chip in the draft is part of what the reader had.
  const nav = state.spawnNav && state.spawnNav.back > 0 ? state.spawnNav : { back: 0, stash: readBox(box) };
  const back = Math.max(0, Math.min(prompts.length, nav.back + step));
  const value = back === 0 ? nav.stash : prompts[prompts.length - back];
  state.spawnNav = { back, stash: nav.stash };
  // A recalled prompt REPLACES what the box holds, chips included: the recalled text becomes the content,
  // so it goes through the one writer and the previous draft's chip model goes with it.
  writeBox(box, value);
  clearBoxDraft(box);
  setCaretOffset(box, value.length);
  return true;
}

function recallReply(box, step) {
  const thread = box.dataset.reply;
  if (!thread) return;
  // ONE session's list, and the walk is inside it: turnPrompts(thread) is keyed by this box's own thread only, so no
  // step of the walk can land on another session's words. Up starts at the newest entry (back 1) and every further
  // Up goes one entry older; Down comes back toward the draft and stops there.
  const prompts = turnPrompts(thread);
  if (!prompts.length) return;
  const nav = state.replyNav.get(thread) || { back: 0, stash: readBox(box) };
  // `back` counts steps behind the draft: 0 = what you were typing, 1 = newest prompt, 2 = the one
  // before it, and so on.
  const back = Math.max(0, Math.min(prompts.length, nav.back + step));
  const value = back === 0 ? nav.stash : prompts[prompts.length - back];
  // `current` is what the recall put there: it is how the next Up knows the box is showing history rather than
  // the reader's own draft, so it may keep walking instead of only moving the caret.
  state.replyNav.set(thread, { back, stash: nav.stash, current: value });
  // A recalled prompt replaces what the box holds, chips included: the model goes with the draft it made.
  writeBox(box, value);
  clearBoxDraft(box);
  setCaretOffset(box, value.length);
  state.replyDrafts[thread] = value;
}

// What the "▶ continue" button on a stopped card sends. One sentence, on purpose: the agent decides for itself
// whether there is work left, and an agent whose task is done is told plainly that exiting is allowed.
const CONTINUE_TEXT = "Continue if you can, exit if you are done";

// The not-running pill is this: one click sends that nudge and starts the next turn, so a stopped agent can be
// picked up without typing anything. Failures land in the card's own warning line, where a reply failure already
// goes. The button's text is the status, so "starting" is said with the refresh glyph turning, not by replacing the
// word - a pill that reads STARTING… would be claiming a status the panel does not know yet.
async function continueThread(thread, btn = null) {
  if (!thread) return;
  if (btn && btn.isConnected) {
    btn.disabled = true;
    btn.classList.add("is-starting");
  }
  const started = await sendReply(thread, CONTINUE_TEXT);
  // The card's own warning line is easy to miss when the card is folded, so a failed nudge also says it out loud.
  if (!started) showBanner(`could not continue that agent — see the card's reply line for why`);
  // The card is usually rebuilt by the reply, so this node may be gone; only touch it if it is still on the page.
  if (btn && btn.isConnected) {
    btn.disabled = false;
    btn.classList.remove("is-starting");
  }
}

// The re-attach pill's press (the not-running pill on a card this panel has no line to). One card, one question
// (POST /api/jobs/reattach), and the server runs it through reconcileRestored's own decision, so a press and a boot
// can never disagree about what the gateway answered. The card repaints itself from the job events that decision
// emits; what is added here is the sentence for the reader — and, on the answer that settles the card, the press
// then continues the thread, which is the pick-up the reader asked for.
async function reattachCard(btn) {
  const id = btn.dataset.reattachJob || "";
  if (!id) return;
  btn.disabled = true;
  btn.classList.add("is-starting");
  try {
    const res = await apiFetch("/api/jobs/reattach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      showBanner(out.error || `could not ask the gateway about that run (HTTP ${res.status})`);
      return;
    }
    // Forgotten: the card is settled, and there is nothing here left to watch — so the press finishes what it
    // promised. The thread is continued on the spot, exactly as the same pill does on every other stopped card, and
    // the settled card keeps the tree and the PR on its console for whatever the agent cannot remember.
    if (out.action === "gone") {
      showNote(`the gateway has no record of run ${out.runId} — the card is settled, and this agent is being picked up`);
      const thread = btn.closest(".job")?.dataset.thread || "";
      if (thread) await continueThread(thread, null);
      return;
    }
    showNote(
      out.action === "reattached"
        ? `the gateway still has run ${out.runId} — this card is re-attached to it and can steer it again`
        : out.action === "adopted"
          ? `the gateway had already finished run ${out.runId} — its result is on the card`
          : `asked the gateway about run ${out.runId || "this turn"}`,
    );
  } catch (e) {
    showBanner(`could not ask the gateway about that run — ${String((e && e.message) || e)}`);
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove("is-starting");
    }
  }
}

// The COMPLETE chip's press, on a card whose latest turn is `done`. It is deliberately NOT the continue pill: nothing is
// sent to the agent that already finished (it is finished — nudging it is the one thing this press must not do), and the
// panel does not start an assistant turn either, which would talk over a run already in flight. Instead one message is
// QUEUED for the board assistant through the wake queue an alert handed over uses (POST /api/jobs/ask-complete ->
// Assistant.askAboutComplete -> wake), so it lands in the assistant's next turn. The pill says the ask happened; a queue
// that refuses it (an assistant switched off) says WHY on the card, in the place a failed nudge already speaks, and the
// pill is then left as it was rather than claiming a success. The hourly SWEEP budget cannot refuse it: a press is an
// event, and events are never budgeted (`SWEEP_WAKE_RULES` in lib/assistant/config.js).
async function askComplete(btn) {
  const id = btn.dataset.completeAsk || "";
  if (!id) return;
  btn.disabled = true;
  btn.classList.add("is-asking");
  try {
    const res = await apiFetch("/api/jobs/ask-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      showBanner(out.error || `could not queue the check for the assistant (HTTP ${res.status})`);
      return;
    }
    // Already asked and the assistant has not turned yet: the ask IS queued, so the chip says asked — but nothing was
    // queued twice, and the card says so rather than letting a second press look like a second ask.
    if (out.duplicate) {
      markChipAsked(btn);
      showNote(`that check is already in the assistant's queue (asked ${out.at || "just now"}) — nothing was queued twice`);
      return;
    }
    // Refused: the wake queue would not take it. Never claim otherwise — the pill stays as it was and the card says why.
    if (!out.queued) {
      showBanner(out.reason || "the assistant's wake queue refused that ask — nothing was queued");
      return;
    }
    markChipAsked(btn);
    showNote(`queued one check for the board assistant — it is asked to look at ${out.thread || "that"} and say whether it is really complete`);
  } catch (e) {
    showBanner(`could not queue the check for the assistant — ${String((e && e.message) || e)}`);
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove("is-asking");
    }
  }
}

// The chip's own short state change, so the reader can see the press landed without reading the card's footer. No glyph
// either way: the not-running pill's ↻ says "this resumes something", which is exactly what this one does not do.
function markChipAsked(btn) {
  if (!btn || !btn.isConnected) return;
  btn.classList.add("is-asked");
  btn.textContent = "asked";
}

// The green ▶ on a worktree row: ask every agent in that worktree that is NOT running to carry on. One sentence each,
// sent together; a running agent is left alone - a reply to it would queue behind its turn, which is not probing.
async function probeWorktreeAgents(path, btn = null) {
  const mine = agentsByPath().get(normPath(path).toLowerCase()) || [];
  if (!mine.length) {
    showBanner("no agents in this worktree yet — the + under the agents starts one");
    return;
  }
  const stopped = mine.filter((c) => !convLive(c));
  if (!stopped.length) {
    showBanner(`all ${mine.length} agent${mine.length === 1 ? "" : "s"} in this worktree are already running`);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-probing");
  }
  let ok = 0;
  let failed = 0;
  await Promise.all(
    stopped.map(async (c) => {
      if (await sendReply(c.thread, CONTINUE_TEXT)) ok += 1;
      else failed += 1;
    }),
  );
  if (btn && btn.isConnected) {
    btn.disabled = false;
    btn.classList.remove("is-probing");
  }
  showBanner(`probed ${ok} not-running agent${ok === 1 ? "" : "s"} in this worktree${failed ? ` · ${failed} failed to send` : ""}`);
}

// The add-agent control, in both shapes: the green + bar, and the text field it turns into. One builder, because the
// row is rebuilt on every scan and the open field has to come back identical - value, attributes and all.
function addAgentBarHtml({ key = "", path = "", name = "", project = "", value = null }) {
  const attrs = `data-add-agent-key="${esc(key)}" data-add-agent-path="${esc(path)}" data-add-agent-name="${esc(name)}" data-add-agent-project="${esc(project)}"`;
  if (value === null) {
    return `<button type="button" class="btn-add-agent" ${attrs} title="start a Hermes agent in this worktree — click, type the first turn, Enter starts it (it runs here, no new worktree)"><span aria-hidden="true">+</span></button>`;
  }
  return (
    `<div class="add-agent-form">` +
    // A contenteditable host, like the reply box: this field is where a prompt is often pasted in from a
    // document, so a paste that big collapses to a chip here too. It keeps the single-line behaviour it had
    // as an <input> (data-single strips line breaks out of a short paste; Shift+Enter adds none).
    `<div class="add-agent-input chipbox" contenteditable="true" role="textbox" data-single="1" ${attrs} data-chipbox="add:${esc(key)}" spellcheck="false" autocomplete="off" data-form-type="other" data-1p-ignore data-bwignore data-lpignore="true"` +
    ` data-ph="what should this agent do here?  Enter starts it · Esc puts the + back"></div>` +
    `</div>`
  );
}

// Same key in, same key out: the field replaces the bar in place so the row does not change height.
function swapAddAgentBox(key, html) {
  const sel = `[data-add-agent-key="${CSS.escape(key)}"]`;
  const field = document.querySelector(`.add-agent-input${sel}`);
  const form = field?.closest(".add-agent-form") || null;
  const btn = document.querySelector(`.btn-add-agent${sel}`);
  const current = form || btn;
  if (!current) return null;
  current.insertAdjacentHTML("afterend", html);
  const fresh = current.nextElementSibling;
  current.remove();
  return fresh;
}

// Clicking the + does not send the reader to the New agent card any more: it turns the bar into a field here. The
// prompt is handed to that card only on submit, aimed at this worktree with the panel's defaults, and started.
function openAddAgent(btn) {
  const key = btn.dataset.addAgentKey || keyOf(btn.dataset.addAgentProject || "", btn.dataset.addAgentPath || "");
  const a = {
    key,
    path: btn.dataset.addAgentPath || "",
    name: btn.dataset.addAgentName || "",
    project: btn.dataset.addAgentProject || "",
    value: "",
    start: 0,
    end: 0,
    focused: true,
  };
  // One field at a time: an open box on another row becomes a + again.
  const prev = state.addAgent;
  if (prev && prev.key !== key) swapAddAgentBox(prev.key, addAgentBarHtml({ ...prev, value: null }));
  state.addAgent = a;
  const fresh = swapAddAgentBox(key, addAgentBarHtml({ ...a, value: "" }));
  fresh?.querySelector(".add-agent-input")?.focus({ preventScroll: true });
}

// Esc, an empty blur, or a run that has started: the + comes back.
function closeAddAgent() {
  const a = state.addAgent;
  if (!a) return;
  state.addAgent = null;
  swapAddAgentBox(a.key, addAgentBarHtml({ ...a, value: null }));
}

// Enter in the field: hand the prompt to the New agent card, aimed at this worktree, with the panel's defaults, and
// start it there - the card is where a run is built, so the field is a shortcut into that same path rather than a
// second spawn implementation.
async function submitAddAgent(input) {
  const a = state.addAgent;
  if (!a) return;
  const typed = String((input ? readBox(input) : a.value) ?? "").trim();
  if (!typed) {
    input?.focus();
    return;
  }
  // Agents in one worktree share it. Say so once before a second one starts editing the same files; the text stays
  // in the box if the reader says no.
  const mine = agentsByPath().get(normPath(a.path).toLowerCase()) || [];
  if (mine.length) {
    const running = agentsRunning(mine);
    const ok = window.confirm(
      `${mine.length} agent${mine.length === 1 ? " already works" : "s already work"} in ${a.name}` +
        `${running ? ` (${running} running now)` : ""}.\n\n` +
        `They share the same working tree: commits can collide (index.lock), and each sees the other's edits as its own dirty files.\n\n` +
        `Start another agent here anyway?`,
    );
    if (!ok) {
      input?.focus();
      return;
    }
  }
  a.value = typed;
  aimSpawnAtWorktree(a.path, a.name, a.project);
  resetSpawnDefaults();
  const box = $("job-prompt");
  if (box) {
    // The field's text becomes the card's prompt — a pasted block travels as a chip, not as flattened
    // text, so the run still receives every character of it.
    transferBoxModel(`add:${a.key}`, box, typed);
    growReplyBox(box);
  }
  state.addAgent = null;
  swapAddAgentBox(a.key, addAgentBarHtml({ ...a, value: null }));
  await spawnAgent({ promptFocus: false });
  // spawnAgent clears the prompt on success and leaves it on a refusal, which is the only signal it gives back.
  if (String(readBox($("job-prompt")) || "").trim()) {
    const why = String($("spawn-msg")?.textContent || "").trim();
    showBanner(`could not start that agent — ${why || "the New agent card says why"}`);
  }
}

// ---- the model picker -----------------------------------------------------------------------
// A run may name a model; the panel does not choose the provider, so "(default)" is whatever the
// gateway is configured with, and a spawn then sends no model at all. The list comes from
// /api/models, which reads the provider list Hermes itself fetched — not a hardcoded menu.
let modelsState = null;

// The rows themselves are the shared picker's (core/model-menu.js): it walks the catalogue in the
// provider order the page already uses, and it prints each row's price and 0-10 rating from the one
// table /api/models serves. Both model fields build their options with this function, so the board's
// select, the assistant's select and the floating list can never disagree about a row or its price.
// `selected` marks the row inline (the assistant's select is rebuilt from HTML, so it cannot rely on
// setting .value afterwards); `extra` keeps a saved value the catalogue no longer lists visible and checked.
function modelOptionHtml(d, { selected = "", extra = [] } = {}) {
  const out = [];
  let group = null;
  for (const r of ModelMenu.rowsFor(d, { extra })) {
    const sel = r.id === selected ? " selected" : "";
    if (!r.id) {
      out.push(`<option value=""${sel}>${esc(r.name)}</option>`);
      continue;
    }
    if ((r.group || "") !== group) {
      if (group) out.push("</optgroup>");
      group = r.group || "";
      if (group) out.push(`<optgroup label="${esc(group)}">`);
    }
    out.push(`<option value="${esc(r.id)}"${sel}>${esc(ModelMenu.optionText(r))}</option>`);
  }
  if (group) out.push("</optgroup>");
  return out.join("");
}

function renderModelPicker(keep = "") {
  const sel = $("job-model");
  if (!sel) return;
  sel.innerHTML = modelOptionHtml(modelsState);
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  const d = modelsState;
  // Say how old the list is: it is a cache of what the provider advertised, not a live call. The prices
  // and ratings are the panel's own table too, so they date each layer separately — a row with no price
  // is a table that has not been filled, not a model that costs nothing.
  const freshness = d?.fetchedAt ? `list fetched ${relTime(d.fetchedAt)} ago` : "fetched at an unknown time";
  const units = "in/out $ per Mtok · ★ = Artificial Analysis /10";
  const snapshotAt = d?.pricingSnapshotAt ? String(d.pricingSnapshotAt).slice(0, 10) : "";
  const priced = d?.pricedCount
    ? `${d.pricedCount} priced, ${d.ratedCount || 0} rated 0-10 (${units})` +
      (d.pricingAge != null ? `, prices ${relTime(new Date(Date.now() - d.pricingAge * 1000).toISOString())} old` : "") +
      (d.ratedFromSnapshot && snapshotAt ? `, the OpenRouter snapshot of ${snapshotAt} filling the gaps` : "")
    : "no prices yet — Settings → Gateway → Models & prices → Refresh models & prices rebuilds them";
  sel.title = d?.count
    ? `${d.count} model${d.count === 1 ? "" : "s"} available to ${d.provider || "this account"}, ${freshness}` +
      `${d.staleDays > 7 ? " — stale, run: hermes model --refresh" : ""} · ${priced}`
    : "no provider list found in the Hermes home — a run falls back to the gateway's configured model";
  // The floating list is what the reader clicks; the select beneath it is the value and the form's own row.
  ModelMenu.attach(sel, { models: () => modelsState });
}

async function loadModels() {
  const keep = $("job-model")?.value || "";
  try {
    const r = await apiFetch("/api/models");
    modelsState = r.ok ? await r.json() : null;
  } catch {
    modelsState = null;
  }
  renderModelPicker(keep);
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
  // The spawn list is where `empty` is authoritative (it is recomputed on every discovery), and the board
  // keeps its own copy of each project. Mirror it, so a repo that just got its first commit stops looking
  // empty everywhere rather than in the warning only.
  for (const p of projects) {
    const known = state.projects.get(p.name);
    if (known && typeof p.empty === "boolean") known.empty = p.empty;
  }
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
  // The checkbox is "create workspace": ticked means a new tree, unticked means run in the folder as it is.
  const create = $("job-create").checked;
  $("spawn-note").textContent = create
    ? `run · new worktree under ${where}/.worktrees/` +
      (custom ? " · custom location (differs from the selected project)" : ` · project ${p ? p.name : "(none)"}`)
    : `runs IN ${where} (no new worktree${state.spawnTarget ? ` · ${state.spawnTarget}` : ""}); edits land in that tree`;
  // A repo with no commits has no HEAD to branch from, so the panel cannot create a worktree in it.
  const emptyRepo = Boolean(p) && Boolean(p.empty) && (!cwd || cwd === p.path);
  const warn = $("spawn-warn");
  // The one-click fix lives HERE, not only in the message a failed spawn leaves behind: the button is
  // disabled before the spawn is ever attempted, so the refusal never happens and the reader was left
  // with a command to retype by hand.
  warn.innerHTML = emptyRepo
    ? `${esc(`${p.name} has no commits yet (unborn HEAD), so no worktree can be cut from it. `)}` +
      `<button type="button" class="btn-fix-first" data-first-commit="${esc(p.path)}" title="create an empty initial commit in that repository — local only, nothing is pushed">make the first commit</button>`
    : "";
  $("btn-spawn").disabled = emptyRepo;
}

// The green "+": aim the spawn card at that project and put the cursor in the prompt.
function focusSpawn(projectName) {
  revealCard("newagent");
  if (projectName) {
    const p = (state.spawn.projects || []).find((x) => x.name === projectName);
    $("job-project").value = projectName;
    // The green "+" is the "start work here" gesture: point the location field at that project.
    if (p) $("job-cwd").value = p.path;
    // ...and that means a NEW worktree in that project, not the project folder itself.
    $("job-create").checked = true;
    state.spawnTarget = null;
    updateSpawnNote();
  }
  const card = $("newagent");
  card.classList.add("armed");
  setTimeout(() => card.classList.remove("armed"), 1400);
  scrollCardUnderBar(card);
  focusPromptWithoutScrolling();
}

function formValues() {
  return {
    // readBox: a chip in the box is the text it swallowed, in place, and the run must receive all of it.
    prompt: readBox($("job-prompt")),
    // An explicitly edited location wins over the project picker (the server prefers `cwd`).
    cwd: $("job-cwd").value.trim() || undefined,
    // true = run in that directory as-is (an existing worktree), no new worktree created. The checkbox says
    // the opposite ("create workspace"), so this is where the two meet.
    existing: !$("job-create").checked,
    // Does this worktree exist to LAND? Unchecked (the default) is LOCAL ONLY: the brief says so, and the panel's
    // pre-push guard refuses a push and asks the reader instead. Ticked, the brief names the landing step and the
    // tree's guard allows the push — the reader's own opt-in, in the reader's own words.
    landing: $("job-landing")?.checked ? true : undefined,
    project: $("job-project").value || undefined,
    model: $("job-model").value.trim() || undefined,
    reasoningEffort: $("job-reasoning") && !$("job-reasoning").disabled ? $("job-reasoning").value || undefined : undefined,
    budget: Number($("job-budget").value) || undefined,
    maxTurns: Number($("job-maxTurns").value) || undefined,
    // Skills have no Runs API field. Reasoning uses model_options; per-run approve-all is unavailable.
  };
}

function panelAgentsByPath() {
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const map = new Map();
  const add = (p, j) => {
    if (!p) return;
    const k = norm(p);
    const cur = map.get(k) || { running: 0, total: 0, threads: [] };
    cur.total += 1;
    if (turnLive(j)) cur.running += 1;
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
// Clicking a project's panel chip while something is running: open the folder, the project and the row
// that hold the first live agent, then land on that card with the caret in its reply box. Every step is a
// different accordion, and the card does not exist in the DOM until the row is open, so the scroll is
// re-asserted on the next frames rather than measured once too early.
// Order the project's rows the way the board draws them, so "the top agent" is the one the reader would
// hit first scrolling down: an open row keeps its slot, the rest are ranked.
function rowsInBoardOrder(projectName) {
  const rows = [...state.rows.values()].filter((r) => r.project === projectName);
  const dom = [...document.querySelectorAll("tr.row")]
    .filter((el) => String(el.dataset.key || "").startsWith(`${projectName}::`))
    .map((el) => el.dataset.key);
  const pos = new Map(dom.map((k, i) => [k, i]));
  return rows.sort((a, b) => {
    const ka = keyOf(projectName, a.path);
    const kb = keyOf(projectName, b.path);
    const pa = pos.has(ka) ? pos.get(ka) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(kb) ? pos.get(kb) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

// The first card of one row, newest first — the card that sits at the top of that row's agents block.
function topAgentOf(row) {
  const agents = agentsFor(row);
  if (!agents.length) return null;
  const latest = (c) => Number(Date.parse((c.turns || []).at(-1)?.startedAt || 0)) || 0;
  return [...agents].sort((a, b) => latest(b) - latest(a))[0];
}

function jumpToPanelAgent(projectName, { running = false } = {}) {
  let found = null;
  for (const r of rowsInBoardOrder(projectName)) {
    const agents = agentsFor(r);
    const pick = running
      ? agents.find(convLive)
      : topAgentOf(r);
    if (!pick) continue;
    const turn = (pick.turns || []).find(turnLive) || (pick.turns || []).at(-1);
    found = { row: r, thread: pick.thread, turnId: turn ? turn.id : null };
    break;
  }
  if (!found) return;
  const project = state.projects.get(projectName);
  const root = project ? rootOf(project) : null;
  if (root && state.collapsedRoots.has(root)) toggleRoot(root);
  if (!state.expandedProjects.has(projectName)) toggleProject(projectName);
  const key = keyOf(projectName, found.row.path);
  if (!state.expanded.has(key)) document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
  // The live turn shows its console only while it is open — and only while its page is the one on screen, so this
  // also pages a card the reader had walked back through (the module's one "put this turn in front of the reader").
  if (running && found.turnId) {
    const conv = conversations().find((c) => c.thread === found.thread);
    if (conv && wtTurnFold.reveal(state, found.thread, conv.turns, found.turnId).changed) {
      renderConversation(found.thread);
    }
  }
  if (state.collapsedJobs.has(found.thread)) {
    state.collapsedJobs.delete(found.thread);
    saveCollapsedJobs();
    renderConversation(found.thread);
  }
  const land = () => {
    const card = document.querySelector(`.job[data-thread="${CSS.escape(found.thread)}"]`);
    if (!card) return;
    // Center it: a card pinned under the sticky bar is "visible" by the numbers and useless to read.
    programmaticScroll();
    card.scrollIntoView({ block: "center", behavior: "auto" });
    refreshAnchorBaseline();
    state.jumpThread = { thread: found.thread, until: Date.now() + flashRingMs() };
    card.classList.add("jump");
    setTimeout(() => {
      if (state.jumpThread && state.jumpThread.thread === found.thread) state.jumpThread = null;
      // Look the node up again: a running card is rebuilt on every job event, so the node captured here
      // may already be detached, and the class it carries is not part of the render signature.
      document.querySelector(`.job[data-thread="${CSS.escape(found.thread)}"]`)?.classList.remove("jump");
    }, flashRingMs());
    state.pendingFocus = { thread: found.thread, until: Date.now() + 20_000, scrollUntil: Date.now() + 6_000 };
    applyPendingFocus();
  };
  requestAnimationFrame(land);
  setTimeout(land, 120);
  setTimeout(land, 400);
}

function jumpToAgent(thread) {
  if (!thread) return;
  revealCard("agents");
  if (state.collapsedJobs.has(thread)) {
    state.collapsedJobs.delete(thread);
    saveCollapsedJobs();
    renderConversation(thread);
  }
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) {
    programmaticScroll();
    $("jobs").scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  programmaticScroll();
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  refreshAnchorBaseline();
  card.classList.add("jump");
  setTimeout(() => card.classList.remove("jump"), flashRingMs());
  // Remember the target so a repaint (which replaces this node) lands the caret back in it. The jump
  // keeps re-asserting itself for a few seconds: smooth scrolling dies when the card is rebuilt.
  state.pendingFocus = { thread, until: Date.now() + 20_000, scrollUntil: Date.now() + 6_000 };
  applyPendingFocus();
}

// The star of a turn as it appears in the page (not the pinned copy), so a pin/unpin can anchor on it.
function findTurnStar(thread, turnId) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return null;
  const stars = [...card.querySelectorAll(`[data-star-turn="${CSS.escape(turnId)}"]`)];
  return stars.find((b) => !b.closest(".pinned-turns")) || stars[0] || null;
}

// One scroll, once, to the card a spawn just produced; the caret goes there too, but focusing never
// scrolls. Returns false when the card is not painted yet, so the caller can retry.
function landOnSpawnedCard(thread) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return false;
  programmaticScroll();
  card.scrollIntoView({ block: "center", behavior: "auto" });
  refreshAnchorBaseline();
  card.classList.add("jump");
  setTimeout(() => {
    document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)?.classList.remove("jump");
  }, flashRingMs());
  // placed: true - this IS the centring; applyPendingFocus must not do it again on the next repaint.
  state.pendingFocus = { thread, until: Date.now() + 20_000, scrollUntil: Date.now() + 6_000, placed: true };
  applyPendingFocus();
  return true;
}

// After a spawn, follow the agent home: unfold its folder, its project and its worktree row, then
// bring the card into view and flash it. A `-w` spawn has no owner for a few seconds and its row is
// only discovered once the tree exists, so this watches for up to ~30s and then gives up quietly.
function revealSpawnedAgent(job, deadlineMs = 30_000) {
  const started = Date.now();
  const attempt = () => {
    const thread = job?.thread;
    if (!thread) return;
    const live = state.jobs.get(job.id) || job;
    const owner = live.ownerPath;
    const row = owner
      ? [...state.rows.values()].find((r) => normPath(r.path).toLowerCase() === normPath(owner).toLowerCase())
      : null;
    if (!row) {
      if (Date.now() - started > deadlineMs) {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
        if (card) jumpToAgent(thread); // nowhere better to go: show it where it is
        return;
      }
      setTimeout(attempt, 700);
      return;
    }
    const project = state.projects.get(row.project);
    const root = project ? rootOf(project) : "";
    if (root && state.collapsedRoots.has(root)) {
      state.collapsedRoots.delete(root);
      saveCollapsedRoots();
      applyRootCollapse(root);
    }
    if (!state.expandedProjects.has(row.project)) toggleProject(row.project);
    const key = keyOf(row.project, row.path);
    if (!state.expanded.has(key)) {
      document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
    }
    // Sections and rows are built synchronously by the two calls above; wait one frame so layout is
    // settled before scrolling, then land on the card itself. If the card is not painted yet (the run
    // posted back before its first job event arrived), keep trying instead of giving up on frame one
    // — that race is why the jump only sometimes happened.
    requestAnimationFrame(() => {
      // Land on the card where it is: jumpToAgent() falls back to scrolling the Agents panel when the
      // card is not painted yet, and a spawn that was still racing its first job event then jumped
      // somewhere else entirely. Here: only scroll when the card exists, and retry quietly otherwise.
      if (!landOnSpawnedCard(thread) && Date.now() - started < deadlineMs) setTimeout(attempt, 400);
    });
  };
  attempt();
}

// Rebuild the card for a session the gateway still has. The conversation never went anywhere — what
// was lost was the panel's record pointing at it — so this asks the server for one, after which a
// reply runs as another turn on the same session id, exactly like any other agent on the board.
async function reviveSession(btn) {
  const sessionId = btn.dataset.reviveSession;
  const path = btn.dataset.revivePath;
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = "reviving…";
  try {
    const r = await apiFetch("/api/sessions/revive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, path }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // The server already emitted a job event; applying it here too makes the card appear even if
    // this tab's stream happens to be between reconnects.
    if (d.job) updateJob(d.job, { scroll: true });
    await resync();
  } catch (e) {
    const why = String(e.message || e);
    // 409 on this route is not a permission answer: it means the thread already has a card. The row's session
    // list is drawn from the last scan, so a session revived a moment ago (or one whose card lives in the
    // unattached panel, or under another row) is still offered here. Show that card instead of a dead end.
    if (/already (has a card|on the board)/i.test(why)) {
      const existing = [...state.jobs.values()].find((j) => (j.thread || j.id) === sessionId);
      if (existing) {
        btn.disabled = false;
        btn.textContent = was;
        showNote("that session is already on the board — showing its card");
        revealSpawnedAgent(existing);
        return;
      }
    }
    btn.disabled = false;
    btn.textContent = was;
    showBanner(`revive ${sessionId}: ${why}`);
  }
}
