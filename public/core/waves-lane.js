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
    const why = gate && gate.why ? String(gate.why) : "";
    const label = `${kind} ${check}`;
    return `<span class="chip wave-gate ${GATE_TONES[state]}" data-wave-gate="${esc(kind)}" data-gate-state="${esc(state)}" title="${esc(`${label}: ${gateWord(gate)}${why ? ` - ${why}` : ""}`)}">${esc(label)} - ${esc(gateWord(gate))}</span>`;
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

  /** One wave: position, title, the derived state word, the current mark, both gates, its template and its members. */
  function waveHtml(wave, currentId = null, esc = defaultEsc) {
    const position = Number(wave && wave.position) > 0 ? Number(wave.position) : null;
    const state = wave && wave.state ? String(wave.state) : "empty";
    const word = wave && wave.stateWord ? String(wave.stateWord) : state;
    const why = wave && wave.stateWhy ? String(wave.stateWhy) : "";
    const members = Array.isArray(wave && wave.members) ? wave.members : [];
    const gates = (wave && wave.gates) || {};
    const current = Boolean(wave && wave.id && currentId && wave.id === currentId);
    const template = wave && wave.template ? String(wave.template) : "";
    const unresolved = Boolean(template) && wave && wave.templateResolved === false;
    const templateLine = template
      ? `<div class="wave-template as-hint" data-wave-template="${esc(template)}" data-template-resolved="${wave.templateResolved === true ? "true" : wave.templateResolved === false ? "false" : "unchecked"}">template <span class="mono">${esc(template)}</span>${unresolved ? " <b class=\"wave-unresolved\">unresolved - the bundle does not hold this id</b>" : wave.templateResolved === true ? " - members that name none inherit it" : ""}</div>`
      : "";
    const memberHtmlAll = members.length
      ? members.map((m) => memberHtml(m, esc)).join("")
      : `<span class="as-hint wave-no-members">no task names this wave yet</span>`;
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
        <span class="chip wave-auto ${wave && wave.auto ? "is-on" : "is-off"}" title="${wave && wave.auto ? "unattended starts are asked for by this wave - but never over the Assistant's own spawn setting, and nothing in this slice acts on it" : "off: this wave never starts a member unattended"}">auto ${wave && wave.auto ? "on" : "off"}</span>
      </div>
      <div class="wave-members">${memberHtmlAll}</div>
    </div>`;
  }

  /**
   * The lane for one initiative, as the card draws it. `waveStatus` is the store's own status (`readable`, `found`,
   * `error`): an unreadable store is SAID rather than drawn as "no waves", because those are different answers.
   *
   * AN INITIATIVE WITH NO WAVES DRAWS NO LANE. The section is the surface for waves, so an initiative that has none
   * leaves the card as it was: "Waves 0 / nothing here yet" on every card would be a box a reader learns to skip, and
   * this slice has no write route to put anything in it. A store that cannot be read, or a record the loader refused,
   * IS drawn, because those are facts a reader has to see.
   */
  function laneHtml(init, waveStatus = null, esc = defaultEsc) {
    const waves = Array.isArray(init && init.waves) ? init.waves : [];
    const skipped = Array.isArray(init && init.waveSkipped) ? init.waveSkipped : [];
    const currentId = init && init.waveCurrentId ? String(init.waveCurrentId) : null;
    const unreadable = Boolean(waveStatus && waveStatus.readable === false);
    if (!waves.length && !skipped.length && !unreadable) return "";
    const rows = waves.length
      ? waves.map((w) => waveHtml(w, currentId, esc)).join("")
      : unreadable
        ? `<div class="as-ask is-bad wave-store-bad" role="alert"><b>The wave store cannot be read, so no wave can be drawn.</b> ${esc(waveStatus.error || "")} The file is left exactly as it is: fix or move it, then refresh.</div>`
        : `<div class="as-hint wave-none" data-wave-none>no waves recorded on this initiative yet - the store is a list a reader authors, and a task joins a wave only by naming its id</div>`;
    const skippedHtml = skipped.length
      ? `<div class="wave-skipped as-hint">${skipped
          .map((row) => `<div class="wave-skip-row" data-wave-skip="${esc(row.initiativeId || "")}">${esc(row.id || "a record")}: ${esc(row.error || "")}</div>`)
          .join("")}</div>`
      : "";
    return `<div class="init-wavefold" data-init-waves="${esc(init && init.id ? init.id : "")}">
      <div class="init-sechead">Waves <span class="chip${waves.length ? "" : " is-zero"}">${waves.length}</span></div>
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
    waveHtml,
    laneHtml,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
