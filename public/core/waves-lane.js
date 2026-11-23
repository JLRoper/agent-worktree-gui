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
//     draws exactly the markup it drew before this row - nothing extra - and a wave a switch opened says which wave
//     opened it, in a sentence that also says nothing was started. A switch that is on and did not open says why,
//     with the gate's own word: a cannot-tell predecessor is drawn "cannot tell", never as a wait that looks healthy.
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

  /** One member: its id, its title, its project when it has one, and the task's own state - or its named abandonment. */
  function memberHtml(member, esc = defaultEsc) {
    const abandoned = member && member.abandoned && String(member.abandoned.reason || "").trim() ? String(member.abandoned.reason).trim() : "";
    const state = abandoned ? "abandoned" : MEMBER_STATES.includes(member && member.state) ? member.state : "queued";
    const id = member && member.id != null ? `#${member.id}` : "#";
    const project = member && member.project ? String(member.project) : "";
    const pipeline = member && member.pipeline ? String(member.pipeline) : "";
    const why = [
      member && member.title ? String(member.title) : "",
      project ? `project ${project}` : "",
      pipeline ? `pipeline ${pipeline}${member.pipelineFrom === "wave" ? " (the wave's template)" : ""}` : "",
      abandoned ? `abandoned: ${abandoned}` : "",
    ]
      .filter(Boolean)
      .join(" - ");
    return `<span class="wave-member" data-wave-member="${esc(member && member.id != null ? member.id : "")}" data-member-state="${esc(state)}"${abandoned ? ` data-member-abandoned="${esc(abandoned)}"` : ""} title="${esc(why)}"><b class="wave-member-id">${esc(id)}</b><span class="wave-member-title">${esc(member && member.title ? member.title : "")}</span>${project ? `<span class="wave-member-project">${esc(project)}</span>` : ""}<span class="chip wave-mstate ${MEMBER_WORDS.includes(state) ? `is-${state}` : ""}">${esc(state)}</span></span>`;
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
      ? "on: the next wave opens by itself once the exit gate of this wave reads met on a live read - on the next read, never in the background, and nothing is started"
      : "off: this wave never opens the next one, however its exit gate reads - a person opens it";
    const autoOpenChip = autoOpened
      ? `<span class="chip wave-auto-open is-on" data-wave-auto-open="true" data-auto-from="${esc(autoFrom)}" title="${esc(String(autoOpen.why || ""))}">opened by ${esc(autoFrom)}</span>`
      : autoWaiting
        ? `<span class="chip wave-auto-open is-wait" data-wave-auto-wait="true" data-auto-from="${esc(autoFrom)}" data-auto-gate="${esc((autoOpen.gate && autoOpen.gate.state) || "none")}" title="${esc(String(autoOpen.why || ""))}">auto wait - ${esc(autoOpen.gate && autoOpen.gate.met === true ? "not closed" : gateWord(autoOpen.gate))}</span>`
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
        ${autoOpenChip}
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

  root.wtWavesLane = {
    GATE_WORDS,
    GATE_TONES,
    MEMBER_STATES,
    MEMBER_WORDS,
    gateWord,
    gateChipHtml,
    memberHtml,
    laneRowHtml,
    lanesHtml,
    waveActionsHtml,
    gateFieldHtml,
    waveFormHtml,
    waveHtml,
    laneHtml,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
