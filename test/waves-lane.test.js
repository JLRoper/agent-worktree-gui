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
  assert.match(lane.waveHtml(wave(), null), /wave-auto is-off" title="off: this wave never starts a member unattended">auto off</);
  assert.match(lane.waveHtml(wave({ auto: true }), null), /wave-auto is-on/);
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
