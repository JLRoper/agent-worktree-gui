// The header's HOT AGENTS marker: the bolt that is drawn only while an agent is working.
//
// One predicate decides what "hot" means (public/core/hot-mark.js), and four surfaces read it: the button's
// existence, its count, its tooltip and the press that steps to an agent. This file drives the module directly with
// turn records in the shape the store writes, and pins the wiring of each surface by slicing the files that draw
// them - the approach test/review-lane.test.js takes, because a predicate nothing calls is not a marker.
//
// The line this file protects is the one the control exists to read: HOT is not LIVE. A turn parked on a permission
// or a question is live (the panel counts it so, and must), and it is exactly what the red Human count is for. The
// bolt is the other half: an agent burning right now.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
function sliceBetween(source, from, to) {
  const a = source.indexOf(from);
  assert.ok(a >= 0, `${from} is in the file`);
  const b = source.indexOf(to, a + from.length);
  assert.ok(b > a, `${to} follows ${from}`);
  return source.slice(a, b);
}

await import("../public/core/hot-mark.js");
const mark = globalThis.wtHotMark;

const turn = (over = {}) => ({
  id: "t1",
  thread: "thread-1",
  status: "running",
  startedAt: "2026-11-18T10:00:00.000Z",
  approval: null,
  approvalDone: null,
  question: null,
  questionDone: null,
  ...over,
});

// ---- 1. the one predicate -------------------------------------------------------------------------------------

test("a turn is hot while it is working, and not once it has stopped", () => {
  for (const status of ["running", "starting", "waiting", "queued"]) {
    assert.equal(mark.hot(turn({ status })), true, `${status} is an agent's own clock moving`);
  }
  for (const status of ["done", "failed", "cancelled", "interrupted", ""]) {
    assert.equal(mark.hot(turn({ status })), false, `${status} is an agent that has stopped`);
  }
  assert.equal(mark.hot(null), false, "no turn is no agent");
});

test("a turn parked on the reader is NOT hot, whatever its status still says", () => {
  const open = { requestId: "r1", command: "git push", deadline: Date.now() + 60_000 };
  assert.equal(mark.hot(turn({ status: "waiting_for_approval" })), false, "the parked status is not in HOT_STATUS");
  // The status event and the approval event arrive on different frames: the record can read `running` with a park
  // already on it, and counting that as hot is how one question would sit in two counts.
  assert.equal(mark.hot(turn({ status: "running", approval: open })), false, "an open approval is a park");
  assert.equal(mark.hot(turn({ status: "running", question: open })), false, "an open question is a park");
  assert.equal(mark.hot(turn({ status: "running", approval: { ...open, deadline: Date.now() - 1 } })), true, "a window that closed is over: the gateway denied it itself and the run moved on");
});

test("an answered park lets the same turn be hot again, and a record with no deadline counts as open", () => {
  const open = { requestId: "r1", command: "git push" };
  assert.equal(mark.hot(turn({ approval: open })), false, "no readable deadline is open, not closed");
  assert.equal(mark.hot(turn({ approval: { ...open, deadline: Date.now() + 1000 }, approvalDone: { choice: "once" } })), true, "an answered approval is behind the run");
  assert.equal(mark.hot(turn({ question: { ...open, deadline: Date.now() + 1000 }, questionDone: { answer: "a" } })), true);
});

test("HOT_STATUS is a subset of the page's LIVE_STATUS, so the bolt can never call a dead turn hot", () => {
  // Read, not restated: the two lists live in different files and a status added to one has to be considered by the
  // other. The bolt may only ever be narrower than "live".
  const scaffold = read("public/board-scaffold.js");
  const found = scaffold.match(/const LIVE_STATUS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(found, "public/board-scaffold.js still declares LIVE_STATUS");
  const live = [...found[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(live.length >= 5, `LIVE_STATUS parsed: ${JSON.stringify(live)}`);
  for (const status of mark.HOT_STATUS) {
    assert.ok(live.includes(status), `${status} is hot and must also be live`);
  }
  assert.ok(!mark.HOT_STATUS.has("waiting_for_approval"), "the parked status is the red count's, not the amber one");
});

// ---- 2. the agents, and the press's rotation -------------------------------------------------------------------

const conv = (thread, turns) => ({ thread, turns, latest: turns[turns.length - 1], first: turns[0] });

test("one entry per agent, the newest hot turn, in the caller's order", () => {
  const list = mark.agents([
    conv("a", [turn({ id: "a1", status: "done" }), turn({ id: "a2", status: "running", startedAt: "2026-11-18T10:00:02.000Z" })]),
    conv("b", [turn({ id: "b1", status: "done" })]),
    conv("c", [turn({ id: "c1", status: "waiting", startedAt: "2026-11-18T10:00:03.000Z" })]),
  ]);
  assert.deepEqual(list.map((a) => a.key), ["a", "c"], "a stopped agent is not in the list, and order is the caller's");
  assert.equal(list[0].turn.id, "a2", "the entry is read from the newest hot turn of the thread");
  assert.equal(mark.count(list), 2);
  assert.deepEqual(mark.agents([]), []);
  assert.deepEqual(mark.agents(null), []);
});

test("the press walks forward and wraps, and a key that left the list starts again at the first", () => {
  const list = [{ key: "a" }, { key: "b" }, { key: "c" }];
  assert.equal(mark.step(list, null).key, "a", "the first press is the newest agent");
  assert.equal(mark.step(list, "a").key, "b");
  assert.equal(mark.step(list, "c").key, "a", "it wraps past the last one");
  assert.equal(mark.step(list, "gone").key, "a", "an agent that finished hands the press back to the first");
  assert.equal(mark.step([], "a"), null);
});

test("the tooltip names the agents and their trees, and says what the press does", () => {
  const text = mark.title([
    { key: "a", name: "the light", where: "hot-tree" },
    { key: "b", name: "turn-fix" },
  ]);
  assert.match(text, /2 agents working right now/);
  assert.match(text, /the light \(hot-tree\)/, "an agent on a worktree row is named with its tree");
  assert.match(text, /Click to land on the next one/);
  assert.match(text, /red Human count/, "the line between amber and red is said where the reader reads it");
  assert.match(mark.title([]), /nothing is working right now/);
  assert.match(mark.title([{ key: "a", name: "one" }]), /1 agent working right now/, "one agent is singular");
});

// ---- 3. the surfaces that draw it ------------------------------------------------------------------------------

test("the markup is a header control of the same family, immediately before Human", () => {
  const html = read("public/index.html");
  const header = html.match(/<header class="topbar">[\s\S]*?<\/header>/)[0];
  assert.match(header, /<button id="btn-hot" type="button" hidden[ >]/, "it ships hidden: zero is absent, not a dead bolt");
  const at = (needle) => header.indexOf(needle);
  assert.ok(at('id="btn-hot"') > 0, "#btn-hot is in the header");
  assert.ok(at('id="btn-hot"') < at('id="btn-human"'), "the bolt sits before Human in the group");
  assert.ok(at('id="btn-assistant"') < at('id="btn-hot"'), "and after Assistant, in the same row");
  assert.match(header, /<span id="hot-label">⚡ Hot<\/span>/, "one glyph, a space, Title Case - the family's label shape");
  assert.match(header, /<span id="hot-badge" hidden>0<\/span>/, "the count is its own pill, quiet at zero");
  assert.ok(header.includes('src="/core/hot-mark.js"') || html.includes('src="/core/hot-mark.js"'), "the module is loaded by the page");
  assert.ok(html.indexOf('src="/core/review-lane.js"') < html.indexOf('src="/core/hot-mark.js"'), "loaded beside the other lane module, before app.js");
  assert.ok(html.indexOf('src="/core/hot-mark.js"') < html.indexOf('src="/app.js"'), "before app.js, which wires it");
});

test("the button's amber is the panel's amber, not the lock's and not the turnover's", () => {
  const css = read("public/style.css");
  const rule = css.slice(css.indexOf("#btn-hot {"));
  assert.ok(rule.length > 0, "public/style.css styles #btn-hot");
  const block = rule.slice(0, rule.indexOf("#hot-badge") > 0 ? 1200 : 600);
  assert.match(block, /#btn-hot\[hidden\] \{ display: none; \}/, "an explicit rule, or the flex display would beat the hidden attribute");
  assert.match(block, /#btn-hot\.is-hot/, "the amber state is a class, so one rule owns it");
  assert.match(block, /#hot-badge\[hidden\] \{ display: none; \}/);
  assert.doesNotMatch(block, /#ffb454/, "the lock's and the review mark's own amber is not this control's colour");
  assert.doesNotMatch(block, /--violet/, "the turnover mark is blue-violet: not this");
});

test("the painter reads the module, the count and the tooltip, and hides the button at zero", () => {
  const app = read("public/app.js");
  const hotAgents = sliceBetween(app, "function hotAgents()", "function paintHotButton()");
  assert.match(hotAgents, /wtHotMark\.agents\(/, "the list is the module's");
  assert.match(hotAgents, /assistantSessionFor/, "an assistant's own turn is not a board agent");
  assert.match(hotAgents, /humanAgentName\(/, "the name is the one the board already calls that agent");

  const paint = sliceBetween(app, "function paintHotButton()", "function hotStep()");
  assert.match(paint, /wtHotMark\.title\(/, "the tooltip is the module's wording");
  assert.match(paint, /btn\.hidden = list\.length === 0/, "zero is ABSENT: the marker only exists while an agent is hot");
  assert.match(paint, /classList\.toggle\("is-hot"/);
  assert.match(paint, /const sig = /, "the paint is signature-guarded, like the Human count");
  assert.match(paint, /hot-label/);
  assert.match(paint, /hot-badge/);
});

test("the press lands on the next hot agent through the board's own jump", () => {
  const app = read("public/app.js");
  const step = sliceBetween(app, "function hotStep()", '$("btn-hot")?.addEventListener');
  assert.match(step, /wtHotMark\.step\(/, "the rotation arithmetic is the module's");
  assert.match(step, /revealAgentHome\(/, "the landing is the one the dock already uses: unfold, then jump");
  assert.match(step, /paintHotButton\(\)/);
  assert.match(app, /\$\("btn-hot"\)\?\.addEventListener\("click",[\s\S]{0,80}hotStep\(\)/, "the press is bound by id");
});

test("a turn starting or stopping repaints it, on the same seams the Human count uses", () => {
  const scaffold = read("public/board-scaffold.js");
  const repaint = sliceBetween(scaffold, "function repaintAgentState()", "// The project header");
  assert.match(repaint, /paintHotButton\(\)/, "every turn change passes through repaintAgentState");
  const jobs = read("public/render-jobs.js");
  assert.match(jobs, /paintHotButton\(\)/, "a job frame repaints it too");
  const app = read("public/app.js");
  const tick = sliceBetween(app, "function tickApprovals", "setInterval(tickApprovals");
  assert.match(tick, /paintHumanButton\(\)/, "the 1 s clock still repaints Human");
  assert.match(tick, /paintHotButton\(\)/, "and the same clock repaints the bolt: a turn's own clock moves without a job frame");
});
