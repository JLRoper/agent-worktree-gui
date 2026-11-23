// The lane's markup, as strings: position, members, gate state, and the three answers a gate chip must keep apart.
//
// This file is the unit half of the lane acceptance. A pane that is 1440 or 768 wide is a CSS question proved by the
// capture gate (tools/verify-waves-lane.mjs); what CAN be proved here is that the markup carries what the pane has to
// show and nothing it must not:
//
//   * every member row carries the TASK'S OWN state, and a member with no state reads queued rather than a guess;
//   * a gate chip carries the check, the live answer and the sentence, and "met", "not met", "cannot tell" and
//     "no gate" are four different chips - the design keeps blindness apart from failure;
//   * the derived state word is drawn from the read, so a wave the read called `running` cannot be drawn `ready`;
//   * a wave with no member says so instead of drawing a green nothing;
//   * an unreadable store is SAID, not drawn as "no waves".
import assert from "node:assert/strict";
import test from "node:test";

import "../public/core/waves-lane.js";

const lane = globalThis.wtWavesLane;

const wave = (over = {}) => ({
  id: "wave_01",
  initiativeId: "init_a",
  position: 1,
  title: "The read path",
  template: null,
  templateResolved: null,
  auto: false,
  entryGate: null,
  exitGate: { check: "pr-merged" },
  gates: {
    entry: { check: null, state: "none", met: false, cannotTell: false, why: "no entry gate - this wave opens by hand" },
    exit: { check: "pr-merged", state: "unknown", met: false, cannotTell: true, why: "#1 names no pull request, so merging cannot be confirmed" },
  },
  state: "running",
  stateWord: "running",
  stateWhy: "#1 is running",
  members: [
    { id: 4, title: "the record", project: "agent-worktree-gui", state: "running", pipeline: null, pipelineFrom: null },
    { id: 5, title: "the fold", project: "agent-worktree-gui", state: "done", pipeline: null, pipelineFrom: null },
  ],
  ...over,
});

test("the module publishes the lane and its four gate words", () => {
  assert.equal(typeof lane.laneHtml, "function");
  assert.deepEqual(lane.GATE_WORDS, { met: "met", unmet: "not met", unknown: "cannot tell", none: "no gate", abandoned: "abandoned" });
});

test("a member row carries the task's own state, its id and its project", () => {
  const html = lane.waveHtml(wave(), null);
  assert.match(html, /data-wave-member="4"[^>]*data-member-state="running"/);
  assert.match(html, /data-wave-member="5"[^>]*data-member-state="done"/);
  assert.match(html, /wave-member-id">#4</);
  assert.match(html, /the record/);
  assert.match(html, /agent-worktree-gui/);
  assert.match(html, /wave-mstate is-running">running</);
  assert.match(html, /wave-mstate is-done">done</);
});

test("a member with no state reads queued, never a silent guess", () => {
  const html = lane.waveHtml(wave({ members: [{ id: 9, title: "x", state: undefined }] }), null);
  assert.match(html, /data-member-state="queued"/);
});

test("the derived state word is the read's, and it is on the row", () => {
  const html = lane.waveHtml(wave({ state: "running", stateWord: "running" }), null);
  assert.match(html, /data-wave-state="running"/);
  assert.match(html, /data-wave-state-chip="running"/);
  assert.match(html, />running</);
  // A read that called a wave blocked cannot be drawn as ready: the word is the read's field, not a default.
  const blocked = lane.waveHtml(wave({ state: "blocked", stateWord: "blocked" }), null);
  assert.match(blocked, /data-wave-state="blocked"/);
  assert.doesNotMatch(blocked, /is-ready/);
});

test("a met, an unmet, an unknown and a missing gate are four different chips", () => {
  const gates = (state) => ({ entry: { check: "clean", state, met: state === "met", cannotTell: state === "unknown", why: `why ${state}` }, exit: null });
  const met = lane.waveHtml(wave({ gates: gates("met") }), null);
  const unmet = lane.waveHtml(wave({ gates: gates("unmet") }), null);
  const unknown = lane.waveHtml(wave({ gates: gates("unknown") }), null);
  const none = lane.waveHtml(wave({ gates: gates("none") }), null);
  assert.match(met, /data-gate-state="met"/);
  assert.match(met, /- met</);
  assert.match(unmet, /data-gate-state="unmet"/);
  assert.match(unmet, /- not met</);
  assert.match(unknown, /data-gate-state="unknown"/);
  assert.match(unknown, /- cannot tell</);
  assert.match(none, /data-gate-state="none"/);
  assert.match(none, /- no gate</);
  // The sentence behind the answer rides the title, so a chip is never a bare word.
  assert.match(met, /title="entry clean: met - why met"/);
});

test("both gates are drawn, and a wave with no entry gate says so", () => {
  const html = lane.waveHtml(wave(), null);
  assert.match(html, /data-wave-gate="entry"/);
  assert.match(html, /data-wave-gate="exit"/);
  assert.match(html, /entry no check - no gate/);
  assert.match(html, /exit pr-merged - cannot tell/);
});

test("the auto chip is drawn off by default, and on only when the record says true", () => {
  assert.match(lane.waveHtml(wave(), null), /wave-auto is-off" title="off: this wave never opens the next one, however its exit gate reads - a person opens it">auto off</);
  assert.match(lane.waveHtml(wave({ auto: true }), null), /wave-auto is-on" title="on: the next wave opens by itself once the exit gate of this wave reads met/);
});

test("a predecessor with the switch off adds nothing to the markup: default-off draws exactly as before", () => {
  const plain = wave();
  const readBack = wave({ autoOpen: { open: false, by: "hand", from: "wave_00", switchOn: false, gate: null, why: "wave_00 has auto off" } });
  assert.equal(lane.waveHtml(readBack, null), lane.waveHtml(plain, null), "the switch-off answer draws no chip at all");
  assert.doesNotMatch(lane.waveHtml(readBack, null), /wave-auto-open/);
});

test("a wave a switch opened says which wave opened it, and the sentence rides the title", () => {
  const html = lane.waveHtml(
    wave({
      auto: false,
      autoOpen: {
        open: true,
        by: "auto",
        from: "wave_01",
        switchOn: true,
        gate: { state: "met", met: true },
        why: "wave_01 has auto on and its exit gate reads met (origin/main holds the content), so wave_02 opened by itself on this read - nothing was started",
      },
    }),
    null,
  );
  assert.match(html, /data-wave-auto-open="true" data-auto-from="wave_01"/);
  assert.match(html, />opened by wave_01</);
  assert.match(html, /title="wave_01 has auto on and its exit gate reads met/);
  assert.match(html, /nothing was started/);
  // The opened wave's OWN switch is still its record's: off here, and the lane says so beside the open.
  assert.match(html, /wave-auto is-off/);
});

test("a switch that is on and did not open says why, with the gate's own word", () => {
  const blocked = lane.waveHtml(
    wave({
      autoOpen: {
        open: false,
        by: "hand",
        from: "wave_01",
        switchOn: true,
        gate: { state: "unknown", cannotTell: true },
        why: "wave_01 has auto on, but its exit gate cannot be read: wave_02 stays shut - the member names no pull request",
      },
    }),
    null,
  );
  assert.match(blocked, /data-wave-auto-wait="true" data-auto-from="wave_01" data-auto-gate="unknown"/);
  assert.match(blocked, />auto wait - cannot tell</);
  assert.match(blocked, /names no pull request/);
  assert.doesNotMatch(blocked, /data-wave-auto-open/);
  assert.doesNotMatch(blocked, /wave-auto-open is-on/);

  // A met gate under a wave that has not closed is not "met" on this chip: the gate passed, the wave did not close,
  // and a chip that said "auto wait - met" would read as if the open were being held for no reason.
  const notClosed = lane.waveHtml(
    wave({
      autoOpen: {
        open: false,
        by: "hand",
        from: "wave_01",
        switchOn: true,
        gate: { state: "met", met: true },
        why: "wave_01 has auto on and its exit gate reads met, but wave_01 still reads running: #2 is running - a successor never opens under a wave that has not closed",
      },
    }),
    null,
  );
  assert.match(notClosed, /data-auto-gate="met"/);
  assert.match(notClosed, />auto wait - not closed</);
  assert.doesNotMatch(notClosed, /data-wave-auto-open/);
});

test("a template is drawn with its resolution, and an unresolved one says so", () => {
  const unresolved = lane.waveHtml(wave({ template: "poc-to-uat", templateResolved: false }), null);
  assert.match(unresolved, /data-wave-template="poc-to-uat" data-template-resolved="false"/);
  assert.match(unresolved, /unresolved - the bundle does not hold this id/);
  const fine = lane.waveHtml(wave({ template: "poc-to-uat", templateResolved: true }), null);
  assert.match(fine, /data-template-resolved="true"/);
  assert.doesNotMatch(fine, /unresolved/);
  assert.doesNotMatch(lane.waveHtml(wave(), null), /wave-template/);
});

test("a wave with no member says so instead of drawing a green nothing", () => {
  const html = lane.waveHtml(wave({ members: [], state: "empty", stateWord: "no members" }), null);
  assert.match(html, /no task names this wave yet/);
  assert.match(html, /no members/);
});

test("the current wave is marked, and only the one the read named", () => {
  assert.match(lane.waveHtml(wave(), "wave_01"), /data-wave-current="true"/);
  assert.doesNotMatch(lane.waveHtml(wave(), "wave_02"), /data-wave-current/);
});

test("a lane of two waves draws both in the order given, with a count", () => {
  const html = lane.laneHtml({ id: "init_a", waves: [wave(), wave({ id: "wave_02", position: 2, title: "Next" })], waveCurrentId: "wave_01" }, null);
  assert.match(html, /data-init-waves="init_a"/);
  assert.match(html, /Waves <span class="chip">2<\/span>/);
  assert.ok(html.indexOf("wave_01") < html.indexOf("wave_02"));
  assert.match(html, />Next</);
});

test("an initiative with no waves draws no lane at all, so the card is as it was", () => {
  assert.equal(lane.laneHtml({ id: "init_a", waves: [] }, { readable: true, found: true }), "");
  assert.equal(lane.laneHtml({ id: "init_a", waves: [], waveSkipped: [] }, null), "");
});

test("an unreadable store is said as unreadable, never as nothing at all", () => {
  const html = lane.laneHtml({ id: "init_a", waves: [] }, { readable: false, found: true, error: "Unexpected token } in JSON" });
  assert.match(html, /wave-store-bad/);
  assert.match(html, /cannot be read/);
  assert.match(html, /The file is left exactly as it is/);
  assert.doesNotMatch(html, /data-wave-none/);
});

test("a refused record is drawn beside the lane with its sentence", () => {
  const html = lane.laneHtml(
    { id: "init_a", waves: [wave()], waveSkipped: [{ id: "wave_09", initiativeId: "init_a", error: "repeats position 1" }] },
    { readable: true },
  );
  assert.match(html, /data-wave-skip="init_a"/);
  assert.match(html, /wave_09: repeats position 1/);
});

test("every wave id, title and member title is escaped", () => {
  const html = lane.waveHtml(
    wave({
      id: "w<1>",
      title: '<img src=x onerror="alert(1)">',
      members: [{ id: 1, title: "</span><script>bad()</script>", state: "queued" }],
    }),
    null,
  );
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;\/span&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});

test("a member abandoned with a NAMED reason is drawn abandoned, with the reason, not as its stale state word", () => {
  // The row's own state is `queued`; the person's decision is what the lane must draw.
  const html = lane.memberHtml({ id: 6, title: "the retired feed", project: "agent-worktree-gui", state: "queued", abandoned: { reason: "the upstream feed was retired", by: "roper" } });
  assert.match(html, /data-member-state="abandoned"/);
  assert.match(html, /data-member-abandoned="the upstream feed was retired"/);
  assert.match(html, /is-abandoned/);
  assert.match(html, /abandoned: the upstream feed was retired/);
  assert.doesNotMatch(html, /data-member-state="queued"/);
  // A member abandoned WITHOUT a reason is not an abandonment at all: the lane draws the row's state, and the gate
  // (not the lane) is what refuses it.
  const bare = lane.memberHtml({ id: 7, title: "no reason", state: "queued", abandoned: { reason: "  " } });
  assert.match(bare, /data-member-state="queued"/);
  assert.doesNotMatch(bare, /is-abandoned/);
});

test("the abandoned gate answer is a chip of its own, not drawn as met or as cannot tell", () => {
  const w = wave({
    state: "abandoned",
    stateWord: "abandoned",
    gates: { entry: { check: null, state: "none", met: false, cannotTell: false, why: "no entry gate" }, exit: { check: "pr-merged", state: "abandoned", met: false, cannotTell: false, clamped: true, why: "#2 was abandoned: the feed was retired" } },
  });
  const html = lane.waveHtml(w);
  assert.match(html, /data-gate-state="abandoned"/);
  assert.match(html, /#2 was abandoned: the feed was retired/);
  assert.doesNotMatch(html, /data-gate-state="met"/);
});

test("the lane set is the wave's own row, not a flex item of the member strip", () => {
  const twoLanes = lane.waveHtml(
    wave({
      lanes: [
        { name: "cookie", state: "running", read: { ok: true }, trees: [{}], members: [{ id: 11, title: "the cookie lane", state: "running" }] },
        { name: "login", state: "queued", read: { ok: true }, trees: [{}], members: [{ id: 13, title: "the login lane", state: "queued" }] },
      ],
      laneJoinOwed: true,
    }),
    null,
  );
  // Two lanes are a block of their own inside the wave row...
  assert.match(twoLanes, /<div class="wave-lanes" data-wave-lanes="2">/);
  // ...and NOT nested in the member strip: nested, the block was a flex item and shrank to its content, so the two
  // lanes could only ever stack, however wide the pane was.
  assert.doesNotMatch(twoLanes, /<div class="wave-members">\s*<div class="wave-lanes"/);
  // The flat member row is not drawn beside the lanes either: one member list per wave, or the grouping reads twice.
  assert.equal((twoLanes.match(/<div class="wave-members">/g) || []).length, 2, "one member list per lane, none beside them");
  // A wave with no lanes keeps exactly the member strip it always drew.
  const flat = lane.waveHtml(wave(), null);
  assert.match(flat, /<div class="wave-members">/);
  assert.doesNotMatch(flat, /wave-lanes/);
});

test("the closing note is a note: the count leads, and the lanes and the note are one block", () => {
  const lanes = [
    { name: "cookie", state: "running", read: { ok: true }, trees: [{}], members: [{ id: 11, title: "the cookie lane", state: "running" }] },
    { name: "login", state: "queued", read: { ok: true }, trees: [{}], members: [{ id: 13, title: "the login lane", state: "queued" }] },
  ];
  const html = lane.waveHtml(wave({ lanes, laneJoinOwed: true }), null);
  // One block holds the lanes and the note, so a wide pane can stand the note beside them (the sketch's callout).
  assert.match(html, /<div class="wave-close"><div class="wave-lanes" data-wave-lanes="2">/);
  // The count is a lead line of its own, not a prefix inside the sentence: the sketch draws "2 lanes" bold above it.
  assert.match(html, /<div class="wave-join" data-wave-join="2"><b>2 lanes<\/b> <span>closing this wave is ONE commit that names them all<\/span><\/div>/);
  // A refused set keeps its lanes and draws no note at all - the two sentences would contradict each other.
  const refused = lane.waveHtml(wave({ lanes, laneJoinOwed: true, laneRefused: "both lanes hold tree x" }), null);
  assert.match(refused, /wave-lanes" data-wave-lanes="2"/);
  assert.doesNotMatch(refused, /wave-close/);
  assert.doesNotMatch(refused, /data-wave-join/);
});

test("a lane set that cannot be isolated does not also promise a one-commit close", () => {
  const lanes = [
    { name: "a", state: "running", read: { ok: true }, trees: [{}], members: [] },
    { name: "b", state: "queued", read: { ok: false, why: "both lanes hold the same tree" }, trees: [], members: [] },
  ];
  const refused = lane.waveHtml(wave({ lanes, laneJoinOwed: true, laneRefused: "cookie and login both hold tree x" }), null);
  assert.match(refused, /The lanes cannot be isolated, so this wave cannot close/);
  assert.match(refused, /cookie and login both hold tree x/);
  // The join sentence would contradict the refusal, so it is not owed while the set is refused.
  assert.doesNotMatch(refused, /data-wave-join/);
  assert.doesNotMatch(refused, /ONE commit/);
  const joined = lane.waveHtml(wave({ lanes, laneJoinOwed: true }), null);
  assert.match(joined, /data-wave-join="2"/);
  assert.match(joined, /ONE commit that names them all/);
});

test("the wave section head says the lane is a read, and keeps its count where it was", () => {
  const html = lane.laneHtml({ id: "init_a", waves: [wave()] }, { readable: true, found: true });
  // The count is the same chip a test already pinned; the sentence beside it is the tab's own statement that no
  // press here writes a wave (round B 6.3).
  assert.match(html, /Waves <span class="chip">1<\/span>/);
  assert.match(html, /read from the wave store/);
});

// ---- the controls a writer adds ------------------------------------------------------------------------------------
// The lane is the same string whether or not a writer exists; the controls are drawn only when the caller says one does
// (`opts.canWrite`), so the read this module drew before them is still the default answer.
test("with no writer a card with no waves draws nothing, and with one it draws its Add control and no form", () => {
  const bare = lane.laneHtml({ id: "init_a", waves: [] }, { readable: true, found: true });
  assert.equal(bare, "");
  const writable = lane.laneHtml({ id: "init_a", waves: [] }, { readable: true, found: true }, undefined, { canWrite: true });
  assert.match(writable, /data-wave-add="init_a"/);
  assert.match(writable, /\+ Add a wave/);
  assert.match(writable, /no waves recorded on this initiative yet/);
  // DECISION 4: the press opens the form, it does not create a default-titled wave.
  assert.doesNotMatch(writable, /data-wave-form=/);
  assert.doesNotMatch(writable, /Wave 1|Untitled/);
});

test("the Add form is a title and both gates, empty, with Create and Cancel", () => {
  const html = lane.laneHtml({ id: "init_a", waves: [] }, { readable: true, found: true }, undefined, {
    canWrite: true,
    checks: ["clean", "pr-merged"],
    form: { mode: "add", title: "", entry: "", exit: "", template: "", auto: false, base: {}, error: "" },
  });
  assert.match(html, /data-wave-form="init_a"/);
  assert.match(html, /data-wave-form-mode="add"/);
  assert.match(html, /data-wave-field="title"[^>]*value=""/);
  assert.match(html, /data-wave-field="entry"/);
  assert.match(html, /data-wave-field="exit"/);
  assert.match(html, /data-wave-field="template"/);
  assert.match(html, /data-wave-field="auto"/);
  assert.match(html, /data-wave-save="init_a">Create wave</);
  assert.match(html, /data-wave-cancel="init_a"/);
  // The pickers offer the server's checks and the "no gate" answer; nothing else.
  assert.match(html, /<option value="clean">clean<\/option>/);
  assert.match(html, /<option value="pr-merged">pr-merged<\/option>/);
  assert.match(html, /<option value="">no gate<\/option>/);
  // While the form is open, the Add control that opened it is not drawn a second time.
  assert.doesNotMatch(html, /data-wave-add=/);
  // THE FORM IS A RECORD'S FIELDS AND NOTHING ELSE: no state, no lane, no member.
  const fields = [...html.matchAll(/data-wave-field="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(fields)].sort(), ["auto", "entry", "exit", "template", "title"]);
});

test("the Edit form carries the record's words, and a gate with parameters is kept rather than dropped", () => {
  const html = lane.laneHtml({ id: "init_a", waves: [wave()] }, { readable: true, found: true }, undefined, {
    canWrite: true,
    checks: ["clean", "pr-merged"],
    form: {
      mode: "edit",
      id: "wave_01",
      title: "The read path",
      entry: "",
      exit: "file-exists",
      template: "bundle.deploy",
      auto: true,
      base: { entry: null, exit: { check: "file-exists", path: "docs/design.md" } },
      error: "the title cannot be empty",
    },
  });
  assert.match(html, /data-wave-form-mode="edit"/);
  assert.match(html, /data-wave-form-id="wave_01"/);
  assert.match(html, /data-wave-field="title"[^>]*value="The read path"/);
  assert.match(html, /data-wave-field="template"[^>]*value="bundle.deploy"/);
  assert.match(html, /data-wave-field="auto" checked/);
  assert.match(html, /Save wave/);
  // A check outside the picker's list is drawn selected WITH its parameters kept, not silently reset to "no gate".
  assert.match(html, /<option value="file-exists" selected>file-exists \(keeps its parameters\)<\/option>/);
  assert.match(html, /wave-form-error[^>]*>the title cannot be empty</);
});

test("a station carries Edit, Up, Down and Delete, and the ends are disabled rather than posting a no-op", () => {
  const first = lane.laneHtml({ id: "init_a", waves: [wave()] }, { readable: true, found: true }, undefined, { canWrite: true });
  assert.match(first, /data-wave-edit="init_a\|wave_01"/);
  assert.match(first, /data-wave-up="init_a\|wave_01"[^>]*disabled/);
  assert.match(first, /data-wave-down="init_a\|wave_01"[^>]*disabled/);
  assert.match(first, /data-wave-del="init_a\|wave_01"/);
  // Two waves: the first can go down, the second can go up, and only the ends are shut.
  const two = lane.laneHtml(
    { id: "init_a", waves: [wave(), wave({ id: "wave_02", position: 2, title: "The write path" })] },
    { readable: true, found: true },
    undefined,
    { canWrite: true },
  );
  const firstBlock = two.slice(0, two.indexOf("wave_02"));
  assert.match(firstBlock, /data-wave-down="init_a\|wave_01"(?![^>]*disabled)/);
  assert.match(two, /data-wave-up="init_a\|wave_02"(?![^>]*disabled)/);
});

test("with no writer a station carries none of the controls", () => {
  const html = lane.laneHtml({ id: "init_a", waves: [wave()] }, { readable: true, found: true });
  assert.doesNotMatch(html, /data-wave-edit=/);
  assert.doesNotMatch(html, /data-wave-del=/);
  assert.doesNotMatch(html, /data-wave-add=/);
});

test("the section head says the tab AUTHORS waves and still starts nothing", () => {
  const html = lane.laneHtml({ id: "init_a", waves: [wave()] }, { readable: true, found: true }, undefined, { canWrite: true });
  assert.match(html, /This tab AUTHORS waves/);
  assert.match(html, /still opens nothing, closes nothing and starts nothing/);
  assert.doesNotMatch(html, /has no write route/);
});

test("an unreadable store draws no Add control, because there is nothing to add to", () => {
  const html = lane.laneHtml({ id: "init_a", waves: [] }, { readable: false, found: true, error: "boom" }, undefined, { canWrite: true });
  assert.match(html, /The wave store cannot be read/);
  assert.doesNotMatch(html, /data-wave-add=/);
});

// ---- the reports chip ----------------------------------------------------------------------------------------------
// The reader's ask: a chip on a task row that lists the .html reports the agents on that task left, and opens one in a
// new tab of the browser it was clicked in. What the MARKUP must carry is proved here (the route is
// test/reports-route.test.js's, the paint is tools/verify-wave-reports.mjs's):
//
//   * the chip names the task, its thread and its project, because those three are what the route is keyed by;
//   * the list is drawn only while it is unfolded, and every link is a NEW TAB (`target="_blank" rel="noopener"`);
//   * an answer with nothing to open is words, never a silent no-op or a link to a file that is not there.
const reportMember = (over = {}) => ({ id: 4, title: "the record", project: "agent-worktree-gui", state: "running", thread: "t-a", ...over });

test("every member row draws the reports chip, with the three fields the route is keyed by", () => {
  lane.resetReports();
  const html = lane.memberHtml(reportMember());
  assert.match(html, /<button type="button" class="chip wave-reports" data-wave-reports="t-a\|4" data-task="4" data-thread="t-a" data-project="agent-worktree-gui" aria-expanded="false"/);
  assert.match(html, />reports<\/button>/);
  // Closed, it draws no list at all - the chip is the whole markup until the reader presses it.
  assert.doesNotMatch(html, /data-wave-report-list/);
});

test("a task with no thread still draws the chip, disabled, and says why it cannot answer", () => {
  lane.resetReports();
  const html = lane.memberHtml(reportMember({ thread: null }));
  assert.match(html, /data-wave-reports=""[^>]*disabled/);
  assert.match(html, /this task names no thread, so its reports cannot be located/);
});

test("unfolded, the list is one new-tab link per report, and the chip carries the count", () => {
  lane.resetReports();
  const key = lane.reportKey(reportMember());
  lane.setReports(key, {
    status: "ok",
    reports: [
      { name: "a.html", path: "docs/reports/a.html", rel: "docs/reports/a.html", title: "The first report", at: new Date().toISOString(), source: "deliverable", url: "/api/reports/view?thread=t-a&task=4&path=docs%2Freports%2Fa.html" },
      { name: "b.html", path: "docs/reports/b.html", rel: "docs/reports/b.html", title: "The second report", at: new Date().toISOString(), source: "tree", url: "/api/reports/view?thread=t-a&task=4&path=docs%2Freports%2Fb.html" },
    ],
  });
  lane.openReports(key);
  const closed = lane.memberHtml(reportMember());
  // The count is on the chip even before the list is drawn again by a repaint.
  assert.match(closed, /aria-expanded="true"/);
  assert.match(closed, />reports 2<\/button>/);
  const html = lane.reportsListHtml(reportMember());
  assert.match(html, /data-wave-report-list="t-a\|4"/);
  assert.match(html, /<a class="wave-report-link" href="\/api\/reports\/view\?thread=t-a&amp;task=4&amp;path=docs%2Freports%2Fa\.html" target="_blank" rel="noopener"/);
  assert.match(html, /The first report/);
  assert.match(html, /The second report/);
  assert.match(html, /docs\/reports\/a\.html/);
  // Both links are new tabs; the reader asked for one and the list must not decide otherwise for a nested path.
  assert.equal([...html.matchAll(/<a /g)].length, 2);
  assert.equal([...html.matchAll(/target="_blank"/g)].length, 2);
  assert.equal([...html.matchAll(/rel="noopener"/g)].length, 2);
});

test("an answer with no report is said in words, not drawn as an empty list", () => {
  lane.resetReports();
  const key = lane.reportKey(reportMember());
  lane.setReports(key, { status: "ok", reports: [] });
  lane.openReports(key);
  const html = lane.memberHtml(reportMember());
  assert.match(html, />no reports<\/button>/);
  assert.match(html, /no \.html report recorded for this task/);
});

test("a report with no file is named with its reason and given no link", () => {
  lane.resetReports();
  const key = lane.reportKey(reportMember());
  lane.setReports(key, {
    status: "ok",
    reports: [{ name: "gone.html", path: "docs/reports/gone.html", rel: null, title: "The gone report", at: null, source: "deliverable", url: null, why: "the delivered file is gone" }],
  });
  lane.openReports(key);
  const html = lane.reportsListHtml(reportMember());
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /The gone report/);
  assert.match(html, /the delivered file is gone/);
});

test("a failed read is an alert in the list, never a silent empty one", () => {
  lane.resetReports();
  const key = lane.reportKey(reportMember());
  lane.setReports(key, { status: "error", reports: [], error: "HTTP 500" });
  lane.openReports(key);
  const html = lane.reportsListHtml(reportMember());
  assert.match(html, /role="alert"/);
  assert.match(html, /the reports read failed: HTTP 500/);
});

test("the chip's state is per task, and closing one leaves the other's answer cached", () => {
  lane.resetReports();
  const one = lane.reportKey(reportMember({ id: 4 }));
  const two = lane.reportKey(reportMember({ id: 5 }));
  assert.notEqual(one, two);
  lane.setReports(one, { status: "ok", reports: [{ name: "a.html", title: "A", url: "/x", at: null, source: "tree", path: "a", rel: "a" }] });
  lane.openReports(one);
  lane.closeReports(one);
  assert.equal(lane.reportsOpenFor(one), false);
  assert.equal(lane.reportsFor(one).reports.length, 1, "the answer survives the fold, so the next press is not a second read");
  assert.equal(lane.reportsFor(two), null);
  const html = lane.memberHtml(reportMember({ id: 5 }));
  assert.match(html, />reports<\/button>/, "a task nobody read yet says reports, not another task's count");
});
