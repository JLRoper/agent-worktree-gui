// waves-lane.js - the Initiatives tab's wave lane, as pure functions with a test beside them.
//
// WHY THIS IS A MODULE AND NOT A TEMPLATE LITERAL IN THE PAINTER. The lane's three claims are the acceptance for the
// first slice, and each one has a wrong answer that still looks right in a screenshot:
//
//   * THE STATE WORD IS THE READ'S, NOT THE RECORD'S. A wave has no stored state; the lane draws `wave.state`, which
//     lib/waves.js folded on that read. A painter that invented "open" or defaulted a missing state to "ready" would
//     show a wave the server never called ready.
//   * A GATE CHIP NAMES THE CHECK AND WHAT THE LIVE READ SAID. "met", "not met" and "cannot tell" are three answers on
//     purpose: the design keeps "the work is not there" apart from "the panel cannot see it". A chip that drew the
//     check name alone would make an unknown gate look passed.
//   * A MEMBER'S STATE IS THE TASK'S OWN. queued, running, parked and done are the queue's four states; the lane draws
//     them verbatim and never infers one from the wave.
//   * A LANE IS DRAWN ONLY WHEN THE WAVE HOLDS MORE THAN ONE. A wave's lanes are derived on the read
//     (lib/waves.js `waveLanes`); a wave with no lane of its own holds ONE IMPLICIT LANE and is drawn exactly as it
//     was before lanes existed, with no lane block and no new attribute. Two or more lanes are drawn as lanes, because
//     that is the fact the close depends on - and a lane whose read answered cannot tell says so, never "no trees".
//   * THE AUTO SWITCH IS DRAWN AS THE READ ANSWERED IT. `auto` is the wave's own record; `autoOpen` is what the read
//     derived from the wave BEFORE it (lib/waves.js `waveAutoOpens`). A wave whose predecessor has the switch off
//     draws exactly the markup it drew before this row plus, once that predecessor is done, the one sentence a person
//     acts on (`surface`: "W1 done, W2 ready - press to open"): off starts nothing, so the lane owes the reader the
//     press. A wave a switch opened says which wave opened it, and that the panel's settle driver started its first
//     queued card. A switch that is on and did not open says why, with the gate's own word: a cannot-tell predecessor
//     is drawn "cannot tell", never as a wait that looks healthy.
//   * THE CONTROLS AUTHOR A RECORD AND NOTHING ELSE. With a writer in the panel the lane gains one "Add a wave" on
//     the section head and Edit / Up / Down / Delete on a station. They post the seven fields a record has (plus the
//     position a move names), and the answer is the server's own fold, so a control can never paint a state, a lane
//     or a member list into the store. The lane still opens nothing, closes nothing, joins nothing and starts
//     nothing: a wave is authored here, and every word about its state is still computed on the read. The controls
//     are drawn only when the caller says a writer exists (`opts.canWrite`), so the default answer is exactly the
//     read this module drew before them.
//
// Published on globalThis as `wtWavesLane`, loaded as a classic script by public/index.html before assistant.js, and
// imported by test/waves-lane.test.js - the same load contract public/core/initiative-fold.js has. Nothing here
// touches the DOM or reads a document: every function takes plain data and an escape function, and answers a string.
(function (root) {
  "use strict";

  const GATE_WORDS = Object.freeze({ met: "met", unmet: "not met", unknown: "cannot tell", none: "no gate", abandoned: "abandoned" });
  const MEMBER_STATES = Object.freeze(["queued", "running", "parked", "done"]);
  // What a member row may be DRAWN as. The four queue states are lib/assistant/queue.js's; `abandoned` is not a fifth
  // state - it is a person's named decision recorded beside the row (lib/waves.js `waveMember`), and the lane draws it
  // in place of the state word because a row that happens to say `queued` no longer describes work nobody will do.
  const MEMBER_WORDS = Object.freeze([...MEMBER_STATES, "abandoned"]);
  const GATE_TONES = Object.freeze({ met: "is-met", unmet: "is-unmet", unknown: "is-unknown", none: "is-none", abandoned: "is-abandoned" });

  function defaultEsc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** The word a gate's live read answered. Unknown states are drawn as themselves, never as a pass. */
  const gateWord = (gate) => GATE_WORDS[gate && gate.state] || GATE_WORDS.none;

  /** One gate chip: what is checked, what the read answered, and the sentence behind the answer. */
  function gateChipHtml(kind, gate, esc = defaultEsc) {
    const state = gate && GATE_TONES[gate.state] ? gate.state : "none";
    const check = gate && gate.check ? String(gate.check) : "no check";
    // A GATE WITH NOTHING TO READ IT AGAINST is not "no gate": a wave authored a moment ago names its checks and has no
    // member yet, and the chip must say that rather than claim the check was never set.
    const tone = state === "none" && gate && gate.check ? "nothing to check" : null;
    const why = gate && gate.why ? String(gate.why) : "";
    const label = `${kind} ${check}`;
    const word = tone || gateWord(gate);
    return `<span class="chip wave-gate ${GATE_TONES[state]}" data-wave-gate="${esc(kind)}" data-gate-state="${esc(state)}"${tone ? ' data-gate-tone="nothing-to-check"' : ""} title="${esc(`${label}: ${word}${why ? ` - ${why}` : ""}`)}">${esc(label)} - ${esc(word)}</span>`;
  }

  /**
   * The tag the worktree column's owner chip draws ("A3", "M1"), from the same rule public/app.js `ownerTagOf`
   * applies: the number is the one the role label ends in, the letters are that label's initials. It is written a
   * second time here because this script loads before public/app.js and cannot reach into it - and the two chips are
   * one fact ("who owns this"), so they must read the same tag. Kept identical to that rule, minus the em dash it
   * also splits on: this file carries plain hyphens only.
   */
  function ownerTagOf(member) {
    const source = String((member && (member.assistantLabel || member.assistantName)) || "").trim();
    const m = /^(.*?)[\s#]*(\d+)\s*$/.exec(source);
    const words = String(m ? m[1] : source)
      .split(/[\s/-]+/)
      .filter(Boolean);
    const initials = words
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    return `${initials || "A"}${m ? m[2] : ""}`;
  }

  /**
   * One member: its id, its title, its project when it has one, its owner CHIP, the task's own state - or its named
   * abandonment - and the reports chip, with the list behind it when the reader has unfolded it.
   *
   * THE BAR IS A PRESS (row 291, ask 2). `data-wave-open` names the owner and the task, so a press anywhere on the row
   * opens that task in the OWNING assistant's queue through the queue's own opener (`window.__assistantTaskRef`, the
   * one the chart's `#405` anchors and the initiative task cards use). The title is a BUTTON for the keyboard, because
   * a row that is one big `role="button"` would contain three more buttons - the two chips and the title - which is a
   * nesting a screen reader narrates wrong.
   *
   * THE OWNER CHIP (ask 3) is `.owner-tag`: the very class the worktree column's owner cell draws, so the two chips
   * are one look and one fact. It is a button with the id and the title already on it, and its press asks that
   * assistant about this task (`window.__assistantQuestionAbout`).
   *
   * A `<div>`, not the `<span>` this row used to be: it holds block content (the button, the reports list).
   */
  function memberHtml(member, esc = defaultEsc) {
    const abandoned = member && member.abandoned && String(member.abandoned.reason || "").trim() ? String(member.abandoned.reason).trim() : "";
    const state = abandoned ? "abandoned" : MEMBER_STATES.includes(member && member.state) ? member.state : "queued";
    const id = member && member.id != null ? `#${member.id}` : "#";
    const taskId = member && member.id != null ? String(member.id) : "";
    const title = member && member.title ? String(member.title) : "";
    const project = member && member.project ? String(member.project) : "";
    const pipeline = member && member.pipeline ? String(member.pipeline) : "";
    // Who owns the row, from the read (lib/waves.js `waveMember`): a row from a read taken before the owner was
    // carried has none, and then the bar keeps its old markup - no press, no chip - rather than naming a guess.
    const own = String((member && member.assistantId) || "").trim();
    const ownName = String((member && (member.assistantName || member.assistantLabel)) || own).trim();
    const canOpen = Boolean(own && taskId);
    const openAttrs = canOpen ? ` data-wave-open="${esc(own)}" data-wave-task="${esc(taskId)}"` : "";
    const ownerChip = canOpen
      ? `<button type="button" class="owner-tag wave-owner" data-wave-owner="${esc(own)}" data-wave-task="${esc(taskId)}" data-wave-title="${esc(title)}" aria-label="${esc(`${ownerTagOf(member)} - ${ownName} owns task #${taskId}`)}" title="${esc(`${ownName} owns #${taskId} - press to ask it about this task: its chat opens with "I have a question about #${taskId}" and this title already typed, the caret after it, and nothing sent`)}">${esc(ownerTagOf(member))}</button>`
      : "";
    const titleEl = canOpen
      ? `<button type="button" class="wave-member-title wave-open"${openAttrs} title="${esc(`open #${taskId} in ${ownName}'s queue`)}">${esc(title)}</button>`
      : `<span class="wave-member-title">${esc(title)}</span>`;
    const why = [title, project ? `project ${project}` : "", ownName ? `owned by ${ownName}` : "", pipeline ? `pipeline ${pipeline}${member.pipelineFrom === "wave" ? " (the wave's template)" : ""}` : "", abandoned ? `abandoned: ${abandoned}` : ""]
      .filter(Boolean)
      .join(" - ");
    return `<div class="wave-member" data-wave-member="${esc(member && member.id != null ? member.id : "")}" data-member-state="${esc(state)}"${own ? ` data-member-owner="${esc(own)}"` : ""}${abandoned ? ` data-member-abandoned="${esc(abandoned)}"` : ""}${openAttrs} title="${esc(why)}"><b class="wave-member-id">${esc(id)}</b>${titleEl}${project ? `<span class="wave-member-project">${esc(project)}</span>` : ""}${ownerChip}<span class="chip wave-mstate ${MEMBER_WORDS.includes(state) ? `is-${state}` : ""}">${esc(state)}</span>${reportsChipHtml(member, esc)}${reportsListHtml(member, esc)}</div>`;
  }

  // ---- the reports chip: a task's .html reports, listed under its member row ----------------------------------------
  // THE LIST IS DRAWN FROM MODULE STATE, NOT FROM THE DOM. The Initiatives tab repaints on every snapshot, so a list kept
  // only in the page would shut under the reader between two reads; `REPORT_OPEN` is whether a task's list is unfolded
  // and `REPORT_STATE` is the session cache the chip was asked for: one fetch per task, and the same rows after a
  // repaint. Both are per-page state (this script is loaded once), never a store, a cookie or a write.
  //
  // EVERY ANSWER IS DRAWN, INCLUDING THE ONE THAT HAS NOTHING TO OPEN. A task with no report, a read that failed and a
  // declared report whose file is gone each say so in words - a control that can be pressed is never a silent no-op, and
  // a row with no file is never handed a link that would land on a 404.
  const REPORT_STATE = new Map();
  const REPORT_OPEN = new Set();
  const REPORT_STYLE_ID = "wt-waves-report-css";
  const REPORT_LABEL = "reports";

  /** The key both the cache and the open set use: the thread plus the task id, which is what the route is keyed by. */
  const reportKey = (member) => {
    const thread = String((member && member.thread) || "").trim();
    const id = member && member.id != null ? String(member.id) : "";
    return thread && id ? `${thread}|${id}` : "";
  };

  /** "2h ago" for a report's own timestamp, and nothing when it carries none. */
  function agoText(iso) {
    const at = Date.parse(String(iso || ""));
    if (!Number.isFinite(at)) return "";
    const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
  }

  /** What the chip says for one member: the label, the tone and the sentence, from the cache and the open state. */
  function reportsChipState(member) {
    const key = reportKey(member);
    const thread = member && member.thread ? String(member.thread) : "";
    const state = key ? REPORT_STATE.get(key) : null;
    const open = Boolean(key && REPORT_OPEN.has(key));
    const known = state && state.status === "ok" && Array.isArray(state.reports) ? state.reports : null;
    const label = !key ? REPORT_LABEL : known ? (known.length ? `${REPORT_LABEL} ${known.length}` : "no reports") : REPORT_LABEL;
    const tone = known && !known.length ? " is-none" : "";
    const title = !thread
      ? "this task names no thread, so its reports cannot be located - an id alone is per-assistant and would name the wrong row"
      : open
        ? "fold the list back up - Escape closes it too, and every link in it opened in a new tab"
        : "list this task's .html reports: the ones its thread declared at settle, and the ones its tree added under docs/reports - each opens in a new tab";
    return { key, open, known, label, tone, title };
  }

  /** The chip: one per member row, and its label carries what the read answered rather than a count it made up. */
  function reportsChipHtml(member, esc = defaultEsc) {
    const chip = reportsChipState(member);
    const task = member && member.id != null ? String(member.id) : "";
    const thread = member && member.thread ? String(member.thread) : "";
    const project = member && member.project ? String(member.project) : "";
    return `<button type="button" class="chip wave-reports${chip.tone}" data-wave-reports="${esc(chip.key)}" data-task="${esc(task)}" data-thread="${esc(thread)}" data-project="${esc(project)}" aria-expanded="${chip.open ? "true" : "false"}"${chip.key ? "" : " disabled"} title="${esc(chip.title)}">${esc(chip.label)}</button>`;
  }

  /** One report: the title as a link into the view route, and its age, path and source as the meta line. */
  function reportRowHtml(row, esc = defaultEsc) {
    const title = row && (row.title || row.name) ? String(row.title || row.name) : "a report";
    const href = row && row.url ? String(row.url) : "";
    // The meta names the file by the path the reader can recognise - the tree-relative one the view route takes - and
    // falls back to the absolute path only when there is no relative one (a delivery from outside the tree). The whole
    // path is on the link's title either way.
    const where = row && row.rel ? String(row.rel) : row && row.path ? String(row.path) : "";
    const meta = [agoText(row && row.at), where, row && row.source ? `from ${row.source}` : ""].filter(Boolean).join(" - ");
    const link = href
      ? `<a class="wave-report-link" href="${esc(href)}" target="_blank" rel="noopener" title="open ${esc(row.path || title)} in a new tab">${esc(title)}</a>`
      : `<span class="wave-report-link is-dead" title="${esc(row && row.why ? row.why : "this report names no file to open")}">${esc(title)}</span>`;
    const why = !href && row && row.why ? `<div class="as-hint wave-report-why">${esc(row.why)}</div>` : "";
    return `<div class="wave-report-row" data-report-source="${esc(row && row.source ? row.source : "")}">${link}<span class="as-hint wave-report-meta">${esc(meta)}</span>${why}</div>`;
  }

  /** The list under the member row: only while it is unfolded, and always an answer - rows, or the sentence for none. */
  function reportsListHtml(member, esc = defaultEsc) {
    const key = reportKey(member);
    if (!key || !REPORT_OPEN.has(key)) return "";
    const box = (inner) => `<div class="wave-reports-list" data-wave-report-list="${esc(key)}" role="group" aria-label="the .html reports this task left">${inner}</div>`;
    const state = REPORT_STATE.get(key);
    if (!state) return box(`<div class="as-hint wave-report-note">reading this task's reports...</div>`);
    if (state.status === "error") {
      return box(`<div class="as-ask is-bad wave-report-bad" role="alert">the reports read failed: ${esc(state.error || "no answer given")}</div>`);
    }
    const rows = Array.isArray(state.reports) ? state.reports : [];
    if (!rows.length) return box(`<div class="as-hint wave-report-none">no .html report recorded for this task</div>`);
    const missing = state.skipped && state.skipped.length
      ? `<div class="as-hint wave-report-skipped">${esc(state.skipped.map((s) => `${s.source}: ${s.why}`).join(" - "))}</div>`
      : "";
    return box(`${rows.map((row) => reportRowHtml(row, esc)).join("")}${missing}`);
  }

  // ---- the session state, as functions (the click handler and the tests both come through here) ----------------------
  /** Record what the route answered for one task. The chip and the list read this; nothing else writes it. */
  function setReports(key, state) {
    const id = String(key || "");
    if (!id) return null;
    const next = state && typeof state === "object" ? state : { status: "ok", reports: [] };
    REPORT_STATE.set(id, next);
    return next;
  }

  /** Unfold or fold one task's list. `open` defaults to flipping the current state, which is what a press means. */
  function openReports(key) {
    const id = String(key || "");
    if (!id) return false;
    REPORT_OPEN.add(id);
    return true;
  }

  function closeReports(key) {
    const id = String(key || "");
    if (!id) return false;
    REPORT_OPEN.delete(id);
    return true;
  }

  function reportsOpenFor(key) {
    return REPORT_OPEN.has(String(key || ""));
  }

  function reportsFor(key) {
    return REPORT_STATE.get(String(key || "")) || null;
  }

  /** Forget everything this page cached: the next press reads the route again. */
  function resetReports() {
    REPORT_STATE.clear();
    REPORT_OPEN.clear();
  }


  /** One lane: the name it runs under, the state its members fold to, and the read saying what it can be pinned to. */
  function laneRowHtml(lane, esc = defaultEsc) {
    const label = String((lane && (lane.name || lane.label)) || "unlaned");
    const state = MEMBER_STATES.includes(lane && lane.state) ? lane.state : "queued";
    const read = lane && lane.read && typeof lane.read === "object" ? lane.read : null;
    const ok = Boolean(read && read.ok);
    const trees = Array.isArray(lane && lane.trees) ? lane.trees.length : 0;
    const why = read && read.why ? String(read.why) : "";
    const say = ok ? `runs in ${trees} tree${trees === 1 ? "" : "s"}` : why;
    const members = Array.isArray(lane && lane.members) ? lane.members : [];
    return `<div class="wave-lane" data-wave-lane="${esc(label)}" data-lane-state="${esc(state)}" data-lane-read="${ok ? "ok" : "cannot-tell"}" title="${esc(why)}">
        <span class="chip wave-mstate is-${esc(state)}">lane ${esc(label)} - ${esc(state)}</span>
        <span class="as-hint wave-lane-read">${esc(say)}</span>
        <div class="wave-members">${members.map((m) => memberHtml(m, esc)).join("")}</div>
      </div>`;
  }

  /**
   * A wave's lanes, and the sentence when two of them hold one tree. Empty for one lane: a wave with no lane of its
   * own holds the one implicit lane and is drawn as it always was.
   */
  function lanesHtml(wave, esc = defaultEsc) {
    const lanes = Array.isArray(wave && wave.lanes) ? wave.lanes : [];
    if (lanes.length < 2) return "";
    const refused = wave && wave.laneRefused ? String(wave.laneRefused) : "";
    const bad = refused ? `<div class="as-ask is-bad wave-lanes-bad" role="alert"><b>The lanes cannot be isolated, so this wave cannot close.</b> ${esc(refused)}</div>` : "";
    const isolation = wave && wave.laneIsolation ? ` data-lane-isolation="${esc(wave.laneIsolation)}"` : "";
    return `${bad}<div class="wave-lanes" data-wave-lanes="${lanes.length}"${isolation}>${lanes.map((lane) => laneRowHtml(lane, esc)).join("")}</div>`;
  }

  /**
   * The station's own controls: edit the record, move it one place, delete it. The same mini-button language the
   * tree rows use, drawn inline rather than behind a `<details>` menu because every repaint of the tab rebuilds this
   * markup and a menu would shut under the reader every couple of seconds. `index`/`count` are the station's place in
   * the order this read returned, which is what makes Up and Down disable at the ends instead of posting a no-op.
   */
  function waveActionsHtml(wave, initiativeId, index, count, esc = defaultEsc) {
    const key = `${initiativeId}|${wave && wave.id ? wave.id : ""}`;
    const title = wave && wave.title ? String(wave.title) : "this wave";
    const first = index <= 0;
    const last = index >= count - 1;
    return `<div class="wave-actions">
        <button type="button" class="init-mini" data-wave-edit="${esc(key)}" aria-label="edit ${esc(title)}" title="edit this wave's title, its gates, its template and its switch - the record only, never its state">Edit</button>
        <button type="button" class="init-mini" data-wave-up="${esc(key)}"${first ? " disabled" : ""} aria-label="move ${esc(title)} one place earlier" title="${first ? "this is already the first wave" : "move this wave one place earlier - the list is renumbered 1..n in one write"}">Up</button>
        <button type="button" class="init-mini" data-wave-down="${esc(key)}"${last ? " disabled" : ""} aria-label="move ${esc(title)} one place later" title="${last ? "this is already the last wave" : "move this wave one place later - the list is renumbered 1..n in one write"}">Down</button>
        <button type="button" class="init-mini wave-del" data-wave-del="${esc(key)}" aria-label="delete ${esc(title)}" title="delete this wave record - its task rows keep their wave id and read as members of no wave, and your tier decides whether this asks">Delete</button>
      </div>`;
  }

  /** One gate's picker: the closed vocabulary's parameter-free names, or a text box when the caller has no list. */
  function gateFieldHtml(kind, value, baseGate, checks, esc = defaultEsc) {
    const current = String(value || "");
    const label = kind === "entry" ? "Entry gate" : "Exit gate";
    if (!Array.isArray(checks)) {
      return `<label class="wave-field"><span>${esc(label)}</span><input type="text" data-wave-field="${esc(kind)}" value="${esc(current)}" spellcheck="false" maxlength="120" placeholder="no gate"></label>`;
    }
    const list = checks.map((check) => String(check));
    const extra = current && !list.includes(current) ? current : "";
    const params = baseGate && typeof baseGate === "object" ? Object.keys(baseGate).some((key) => key !== "check") : false;
    const options = [`<option value="">no gate</option>`]
      .concat(list.map((check) => `<option value="${esc(check)}"${check === current ? " selected" : ""}>${esc(check)}</option>`))
      .concat(extra ? [`<option value="${esc(extra)}" selected>${esc(extra)}${params ? " (keeps its parameters)" : ""}</option>`] : []);
    return `<label class="wave-field"><span>${esc(label)}</span><select data-wave-field="${esc(kind)}">${options.join("")}</select></label>`;
  }

  /**
   * The one-line form the Add control opens (decision 4: a title typed by the reader, never a made-up "Wave 4"), and
   * the same form Edit opens with the record's own words. `form` is `{ mode, id, title, entry, exit, template, auto,
   * base, error }` - the caller's draft, kept in module state so the tab's repaint cannot erase what is being typed.
   */
  function waveFormHtml(initiativeId, form, checks, esc = defaultEsc) {
    const draft = form && typeof form === "object" ? form : {};
    const editing = draft.mode === "edit";
    const base = draft.base && typeof draft.base === "object" ? draft.base : {};
    const error = draft.error ? `<div class="as-ask is-bad wave-form-error" role="alert">${esc(draft.error)}</div>` : "";
    return `<div class="wave-form" data-wave-form="${esc(initiativeId)}" data-wave-form-mode="${editing ? "edit" : "add"}" data-wave-form-id="${esc(draft.id || "")}">
        <label class="wave-field wave-field-title"><span>Title</span><input type="text" data-wave-field="title" value="${esc(draft.title || "")}" spellcheck="false" maxlength="120" placeholder="one line saying what this wave is"></label>
        ${gateFieldHtml("entry", draft.entry, base.entry, checks, esc)}
        ${gateFieldHtml("exit", draft.exit, base.exit, checks, esc)}
        <label class="wave-field wave-field-template"><span>Template</span><input type="text" data-wave-field="template" value="${esc(draft.template || "")}" spellcheck="false" maxlength="120" placeholder="a bundle pipeline id, or none"></label>
        <label class="wave-switch"><input type="checkbox" data-wave-field="auto"${draft.auto ? " checked" : ""}> auto</label>
        <button type="button" class="primary" data-wave-save="${esc(initiativeId)}">${editing ? "Save wave" : "Create wave"}</button>
        <button type="button" class="init-mini" data-wave-cancel="${esc(initiativeId)}">Cancel</button>
        ${error}
      </div>`;
  }

  /** One wave: position, title, the derived state word, the current mark, both gates, its template and its members. */
  function waveHtml(wave, currentId = null, esc = defaultEsc, opts = {}) {
    const position = Number(wave && wave.position) > 0 ? Number(wave.position) : null;
    const state = wave && wave.state ? String(wave.state) : "empty";
    const word = wave && wave.stateWord ? String(wave.stateWord) : state;
    const why = wave && wave.stateWhy ? String(wave.stateWhy) : "";
    const members = Array.isArray(wave && wave.members) ? wave.members : [];
    const gates = (wave && wave.gates) || {};
    // What the switch on the PREVIOUS wave answered for this one (lib/waves.js `waveAutoOpens`). A predecessor with
    // auto off draws nothing extra: the markup stays exactly the one this lane drew before the switch existed, which
    // is the "absent or false means today's behaviour" rule, measured in test/waves-lane.test.js.
    const autoOpen = wave && wave.autoOpen && typeof wave.autoOpen === "object" ? wave.autoOpen : null;
    const autoFrom = autoOpen && autoOpen.from ? String(autoOpen.from) : "";
    const autoOpened = Boolean(autoOpen && autoOpen.open === true && autoFrom);
    const autoWaiting = Boolean(autoOpen && autoOpen.open !== true && autoOpen.switchOn === true && autoFrom);
    const autoOn = Boolean(wave && wave.auto);
    const autoTitle = autoOn
      ? "on: when this wave closes, the next wave opens and its first queued card is started by the settle that closed this one - never in the background"
      : "off: this wave never opens the next one, however its exit gate reads - a person opens it";
    const autoOpenChip = autoOpened
      ? `<span class="chip wave-auto-open is-on" data-wave-auto-open="true" data-auto-from="${esc(autoFrom)}" title="${esc(String(autoOpen.why || ""))}">opened by ${esc(autoFrom)}</span>`
      : autoWaiting
        ? `<span class="chip wave-auto-open is-wait" data-wave-auto-wait="true" data-auto-from="${esc(autoFrom)}" data-auto-gate="${esc((autoOpen.gate && autoOpen.gate.state) || "none")}" title="${esc(String(autoOpen.why || ""))}">auto wait - ${esc(autoOpen.gate && autoOpen.gate.met === true ? "not closed" : gateWord(autoOpen.gate))}</span>`
        : "";
    // WHAT A PERSON IS OWED when no switch will open this wave (lib/waves.js `autoOpen.surface`): "W1 done, W2 ready -
    // press to open", or a next wave with no cards named plainly. The fold owns the sentence and the lane only draws
    // it, so the chip and the state beside it cannot disagree. No surface means no chip, and the markup is exactly the
    // one this lane drew before the switch existed.
    const surface = autoOpen && autoOpen.surface ? String(autoOpen.surface) : "";
    const surfaceChip = surface
      ? `<span class="chip wave-next is-wait" data-wave-next="${esc(surface)}" title="${esc(String(autoOpen.why || ""))}">${esc(surface)}</span>`
      : "";
    const current = Boolean(wave && wave.id && currentId && wave.id === currentId);
    const template = wave && wave.template ? String(wave.template) : "";
    const unresolved = Boolean(template) && wave && wave.templateResolved === false;
    const templateLine = template
      ? `<div class="wave-template as-hint" data-wave-template="${esc(template)}" data-template-resolved="${wave.templateResolved === true ? "true" : wave.templateResolved === false ? "false" : "unchecked"}">template <span class="mono">${esc(template)}</span>${unresolved ? " <b class=\"wave-unresolved\">unresolved - the bundle does not hold this id</b>" : wave.templateResolved === true ? " - members that name none inherit it" : ""}</div>`
      : "";
    const laneCount = Array.isArray(wave && wave.lanes) ? wave.lanes.length : 0;
    // A JOIN SENTENCE IS OWED ONLY WHEN THE SET CAN ACTUALLY CLOSE. With a refused lane set `lanesHtml` has already
    // drawn "The lanes cannot be isolated, so this wave cannot close", and drawing "closing this wave is ONE commit
    // that names them all" beside it would say the opposite. Two sentences, one truth: the join is conditioned on the
    // refusal being absent (round B 4.3).
    const laneRefused = wave && wave.laneRefused;
    // THE CLOSING NOTE IS A NOTE (the sketch's callout), not a hint line: the count leads, the rule follows, and at a
    // pane that can hold it the note sits beside the lanes it is about. `data-wave-join` keeps the count a machine
    // can read; the words stay the same sentence a reader has always had.
    const joined = laneCount >= 2 && wave && wave.laneJoinOwed && !laneRefused ? `<div class="wave-join" data-wave-join="${laneCount}"><b>${laneCount} lanes</b> <span>closing this wave is ONE commit that names them all</span></div>` : "";
    // THE LANE BLOCK IS NOT A MEMBER. More than one lane draws its members INSIDE their lanes - the lane a member runs
    // in is the fact this read adds, and a flat list beside it would leave the grouping unreadable. The lane set is
    // therefore its OWN row, a sibling of the member row, not a flex item of it (round B 4.3, 6.3): nested, it shrank
    // to its content and two lanes could only stack.
    const lanesRow = laneCount >= 2 ? lanesHtml(wave, esc) : "";
    // THE LANES AND THE NOTE THEY CARRY are one block, so the note can stand beside them where the pane is wide
    // enough for both. A wave with lanes but no owed join (a refused set) keeps the lanes alone: the refusal is
    // already a sentence, and the join would contradict it.
    const closeBlock = lanesRow && joined ? `<div class="wave-close">${lanesRow}${joined}</div>` : `${joined}${lanesRow}`;
    const actions = opts.canWrite ? waveActionsHtml(wave, opts.initiativeId, Number(opts.index) || 0, Number(opts.count) || 0, esc) : "";
    const membersRow =
      laneCount >= 2
        ? ""
        : `<div class="wave-members">${
            members.length ? members.map((m) => memberHtml(m, esc)).join("") : `<span class="as-hint wave-no-members">no task names this wave yet</span>`
          }</div>`;
    return `<div class="wave-row" data-wave-id="${esc(wave && wave.id ? wave.id : "")}" data-wave-state="${esc(state)}"${current ? ' data-wave-current="true"' : ""}>
      <div class="wave-head">
        <span class="wave-pos" title="wave ${esc(position || "?")} of this initiative">${esc(position ? `W${position}` : "W?")}</span>
        <span class="wave-title">${esc(wave && wave.title ? wave.title : "")}</span>
        <span class="chip wave-state is-${esc(state)}" data-wave-state-chip="${esc(state)}" title="${esc(why)}">${esc(word)}</span>
        ${current ? `<span class="chip wave-current" title="the lowest-position wave the stated order makes current: running first, then ready, then not entered">current</span>` : ""}
        ${templateLine}
      </div>
      <div class="wave-gates">
        ${gateChipHtml("entry", gates.entry, esc)}
        ${gateChipHtml("exit", gates.exit, esc)}
        <span class="chip wave-auto ${autoOn ? "is-on" : "is-off"}" title="${esc(autoTitle)}">auto ${autoOn ? "on" : "off"}</span>
        ${autoOpenChip}${surfaceChip}
      </div>
      ${closeBlock}
      ${membersRow}
      ${actions}
    </div>`;
  }

  /**
   * The lane for one initiative, as the card draws it. `waveStatus` is the store's own status (`readable`, `found`,
   * `error`): an unreadable store is SAID rather than drawn as "no waves", because those are different answers.
   *
   * AN INITIATIVE WITH NO WAVES DRAWS NO LANE UNTIL A WRITER EXISTS. The section is the surface for waves, so an
   * initiative that has none leaves the card as it was - "Waves 0 / nothing here yet" on every card would be a box a
   * reader learns to skip. With a writer (`opts.canWrite`) that one case stops being invisible: the section is drawn
   * with its Add control and nothing else, which is the only way to author the first wave. A store that cannot be
   * read, or a record the loader refused, IS drawn, because those are facts a reader has to see.
   *
   * `opts.form` is the open Add/Edit draft for this initiative (`{ mode, id, title, entry, exit, template, auto,
   * base, error }`), `opts.checks` the gate names the server answered, and both are the caller's module state so a
   * repaint cannot erase a half-typed title.
   */
  function laneHtml(init, waveStatus = null, esc = defaultEsc, opts = {}) {
    const waves = Array.isArray(init && init.waves) ? init.waves : [];
    const skipped = Array.isArray(init && init.waveSkipped) ? init.waveSkipped : [];
    const currentId = init && init.waveCurrentId ? String(init.waveCurrentId) : null;
    const unreadable = Boolean(waveStatus && waveStatus.readable === false);
    const canWrite = Boolean(opts && opts.canWrite) && !unreadable;
    const form = canWrite && opts.form && typeof opts.form === "object" ? opts.form : null;
    if (!waves.length && !skipped.length && !unreadable && !canWrite) return "";
    const rows = waves.length
      ? waves
          .map((w, index) => waveHtml(w, currentId, esc, { canWrite, initiativeId: init.id, index, count: waves.length }))
          .join("")
      : unreadable
        ? `<div class="as-ask is-bad wave-store-bad" role="alert"><b>The wave store cannot be read, so no wave can be drawn.</b> ${esc(waveStatus.error || "")} The file is left exactly as it is: fix or move it, then refresh.</div>`
        : `<div class="as-hint wave-none" data-wave-none>no waves recorded on this initiative yet - ${
            canWrite ? "Add a wave puts the first one here, and a task joins it only by naming its id" : "the store is a list a reader authors, and a task joins a wave only by naming its id"
          }</div>`;
    const skippedHtml = skipped.length
      ? `<div class="wave-skipped as-hint">${skipped
          .map((row) => `<div class="wave-skip-row" data-wave-skip="${esc(row.initiativeId || "")}">${esc(row.id || "a record")}: ${esc(row.error || "")}</div>`)
          .join("")}</div>`
      : "";
    // One Add control on the section head, and only while its own form is shut: two ways to open one form would be a
    // control that appears to do nothing.
    const adding = Boolean(form && form.mode === "add");
    const addButton =
      canWrite && !adding
        ? `<button type="button" class="init-mini wave-add" data-wave-add="${esc(init.id)}" title="author a wave on this initiative - a title, both gates, a template and the switch; nothing is opened, closed or started by this, and your tier decides whether it asks">+ Add a wave</button>`
        : "";
    const formHtml = form ? waveFormHtml(init.id, form, opts.checks, esc) : "";
    return `<div class="init-wavefold" data-init-waves="${esc(init && init.id ? init.id : "")}"${canWrite ? ' data-wave-writable="true"' : ""}>
      <div class="init-sechead">Waves <span class="chip${waves.length ? "" : " is-zero"}">${waves.length}</span>${addButton}<span class="as-hint init-wave-note" title="a wave is a read: its state is folded from its members and its gates on this read. This tab AUTHORS waves - and still opens nothing, closes nothing and starts nothing">read from the wave store</span></div>
      ${formHtml}
      <div class="init-waves">${rows}</div>
      ${skippedHtml}
    </div>`;
  }

  // ---- the page half: the stylesheet the list needs, one fetch per task, and the two keys --------------------------
  // THE ONLY RULES THIS CHANGE ADDS, and why they are here rather than in public/style.css: a second live run holds that
  // sheet, so this row could not touch it. The list is a block under a row that is a four-column grid at a wide pane, so
  // it has to span the grid and the row has to gain a fifth column for the chip - two declarations nothing in the shared
  // sheet could give without a second owner. Everything else is the existing `.chip`, `.as-hint`, `.as-ask` and `.mono`.
  const REPORTS_CSS = [
    "#as-initiatives .wave-reports { cursor: pointer; }",
    "#as-initiatives .wave-reports.is-none { color: var(--tab-ink-3); border-style: dashed; }",
    '#as-initiatives .wave-reports[aria-expanded="true"] { border-color: var(--tab-accent); color: var(--tab-accent); }',
    "#as-initiatives .wave-reports-list { display: block; flex-basis: 100%; width: 100%; min-width: 0; margin-top: 2px; padding-top: 4px; border-top: 1px dashed var(--tab-line); }",
    "#as-initiatives .wave-report-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }",
    "#as-initiatives .wave-report-link { font-family: var(--tab-font-ui); overflow-wrap: anywhere; }",
    "#as-initiatives .wave-report-link.is-dead { color: var(--tab-ink-3); text-decoration: line-through; }",
    "#as-initiatives .wave-report-meta, #as-initiatives .wave-report-why, #as-initiatives .wave-report-skipped { overflow-wrap: anywhere; }",
    "@container (min-width: 900px) {",
    // THE COLUMN SET IS public/style.css's (the row is a grid there, one column per fact: id, title, project, owner
    // chip, state, reports). It used to be repeated here because a live run held the shared sheet; it has one owner now.
    "  #as-initiatives .wave-reports-list { grid-column: 1 / -1; }",
    "}",
  ].join("\n");

  /** One member's chip as the DOM reads it back: the three fields the route is keyed by. */
  const memberFromChip = (chip) => {
    const read = (name) => (chip && typeof chip.getAttribute === "function" ? chip.getAttribute(name) || "" : "");
    return { id: read("data-task"), thread: read("data-thread"), project: read("data-project") };
  };

  /**
   * One fetch per task, cached for the session. An error is cached too and is RETRIED on the next press: a read that
   * failed once must not leave a chip that refuses to try again, and the unfolded list says what went wrong until it does.
   */
  async function readReports(member) {
    const key = reportKey(member);
    if (!key) return null;
    const current = REPORT_STATE.get(key);
    if (current && current.status !== "error") return current;
    REPORT_STATE.set(key, { status: "loading", reports: [] });
    try {
      const query = new URLSearchParams({ thread: String(member.thread), task: String(member.id) });
      if (member.project) query.set("project", String(member.project));
      const answer = await root.fetch(`/api/reports?${query.toString()}`, { cache: "no-store", headers: { accept: "application/json" } });
      const body = await answer.json().catch(() => null);
      if (!answer.ok) throw new Error((body && body.error) || `the reports read answered HTTP ${answer.status}`);
      const next = {
        status: "ok",
        reports: Array.isArray(body && body.reports) ? body.reports : [],
        skipped: Array.isArray(body && body.skipped) ? body.skipped : [],
        at: body && body.at ? String(body.at) : null,
      };
      REPORT_STATE.set(key, next);
      return next;
    } catch (err) {
      const next = { status: "error", reports: [], error: String((err && err.message) || err) };
      REPORT_STATE.set(key, next);
      return next;
    }
  }

  /**
   * Repaint one chip and its list IN PLACE. The chip element is kept (its text, tone and aria-expanded are updated) so the
   * reader's focus survives the press; only the list under it is replaced. A later lane repaint draws the same state from
   * the same module, which is what keeps an open list from shutting under the reader.
   */
  function paintMember(chip) {
    if (!chip || !chip.parentNode) return;
    const host = chip.closest ? chip.closest(".wave-member") : null;
    if (!host) return;
    const member = memberFromChip(chip);
    const state = reportsChipState(member);
    chip.textContent = state.label;
    chip.classList.toggle("is-none", Boolean(state.known && !state.known.length));
    chip.setAttribute("aria-expanded", state.open ? "true" : "false");
    chip.setAttribute("title", state.title);
    for (const old of host.querySelectorAll("[data-wave-report-list]")) old.remove();
    const html = reportsListHtml(member);
    if (html) chip.insertAdjacentHTML("afterend", html);
  }

  /** A press: fold an open list back up, or unfold it and read once. */
  async function pressReports(chip) {
    const member = memberFromChip(chip);
    const key = reportKey(member);
    if (!key) return;
    if (REPORT_OPEN.has(key)) {
      REPORT_OPEN.delete(key);
      paintMember(chip);
      return;
    }
    REPORT_OPEN.add(key);
    paintMember(chip); // the unfolded list says "reading..." before the answer lands
    const cached = REPORT_STATE.get(key);
    if (cached && cached.status !== "error") return;
    await readReports(member);
    for (const other of root.document.querySelectorAll("[data-wave-reports]")) {
      if (other.getAttribute("data-wave-reports") === key) paintMember(other);
    }
  }

  function onReportsClick(event) {
    const chip = event.target && event.target.closest ? event.target.closest("[data-wave-reports]") : null;
    if (!chip || chip.disabled) return;
    event.preventDefault();
    void pressReports(chip);
  }

  // ---- the bar's two presses (row 291) -----------------------------------------------------------------------------
  // THE OWNER CHIP AND THE BAR ARE TWO PRESSES ON ONE ELEMENT, so the order here is the whole contract: the chip is
  // answered first and STOPS (it opens a chat and types a sentence, and the bar must not also open a queue behind it);
  // the reports chip and any link keep their own presses; everything else on the bar opens the task. Both openers are
  // published by public/assistant.js (`window.__assistantTaskRef`, `window.__assistantQuestionAbout`), the same way the
  // chart's owner chip reaches `window.__assistantRegarding` - this script owns the markup and knows no composer.
  function onLaneClick(event) {
    const target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    const owner = target.closest("[data-wave-owner]");
    if (owner) {
      event.preventDefault();
      event.stopPropagation();
      const ask = root.__assistantQuestionAbout;
      if (typeof ask === "function") {
        ask({
          assistantId: owner.getAttribute("data-wave-owner") || "",
          taskId: owner.getAttribute("data-wave-task") || "",
          title: owner.getAttribute("data-wave-title") || "",
        });
      }
      return;
    }
    const bar = target.closest("[data-wave-open]");
    if (!bar) return;
    // A control INSIDE the bar keeps its press: the reports chip unfolds a list, and a link opens its own page.
    if (target.closest("[data-wave-reports], a")) return;
    const own = bar.getAttribute("data-wave-open") || "";
    const task = bar.getAttribute("data-wave-task") || "";
    if (!own || !task) return;
    event.preventDefault();
    const open = root.__assistantTaskRef;
    if (typeof open === "function") void open(own, task);
  }

  /** Escape closes what a press opened and hands focus back to the chip that opened it. */
  function onReportsKey(event) {
    if (!event || event.key !== "Escape") return;
    const doc = root.document;
    if (!doc || !doc.querySelectorAll) return;
    const open = [...doc.querySelectorAll('[data-wave-reports][aria-expanded="true"]')];
    if (!open.length) return;
    const host = event.target && event.target.closest ? event.target.closest(".wave-member") : null;
    const here = host ? host.querySelector("[data-wave-reports]") : null;
    for (const chip of open) {
      const key = reportKey(memberFromChip(chip));
      if (key) REPORT_OPEN.delete(key);
      paintMember(chip);
    }
    if (here && typeof here.focus === "function") here.focus();
    event.preventDefault();
    // THE PRESS IS CONSUMED. The rail's own Escape handler closes the whole assistant panel when the caret is inside it
    // (public/assistant.js, "Esc closes the rail only when the caret is in it"), so without this line folding a list
    // would also shut the panel the list was in - the same reason the pipeline window's Escape stops propagation. This
    // listener is registered at load, before assistant.js's, so stopImmediatePropagation reaches it first.
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
  }

  let reportsBound = false;

  /**
   * Install the report stylesheet and the two listeners, once per document, idempotently. This is the only function here
   * that touches the DOM; in node (where test/waves-lane.test.js imports this file) there is no document and it is never
   * called. It installs itself at load: the lane is painted by public/assistant.js, and a chip that waited for that
   * painter to wire it would be a button that does nothing.
   */
  function installReports(options = {}) {
    const doc = options.document || root.document;
    if (!doc || !doc.head || typeof doc.addEventListener !== "function") return false;
    if (!doc.getElementById(REPORT_STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = REPORT_STYLE_ID;
      style.textContent = REPORTS_CSS;
      doc.head.appendChild(style);
    }
    if (reportsBound) return true;
    reportsBound = true;
    doc.addEventListener("click", onReportsClick);
    doc.addEventListener("click", onLaneClick);
    doc.addEventListener("keydown", onReportsKey);
    return true;
  }

  try {
    if (root.document) {
      if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", () => installReports(), { once: true });
      else installReports();
    }
  } catch {
    /* a page that cannot take the installer still gets the markup: the chip is drawn either way */
  }

  root.wtWavesLane = {
    GATE_WORDS,
    GATE_TONES,
    MEMBER_STATES,
    MEMBER_WORDS,
    gateWord,
    gateChipHtml,
    memberHtml,
    // The owner chip's tag, from the worktree column's own rule: a test proves the two chips read the same tag.
    ownerTagOf,
    // The reports chip: its markup, its session state and the installer a page uses. The state functions are public so a
    // test can put a task's answer in the cache and prove what the lane draws from it without a browser or a fetch.
    reportKey,
    agoText,
    reportsChipState,
    reportsChipHtml,
    reportRowHtml,
    reportsListHtml,
    setReports,
    openReports,
    closeReports,
    reportsOpenFor,
    reportsFor,
    resetReports,
    installReports,
    REPORTS_CSS,
    laneRowHtml,
    lanesHtml,
    waveActionsHtml,
    gateFieldHtml,
    waveFormHtml,
    waveHtml,
    laneHtml,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
