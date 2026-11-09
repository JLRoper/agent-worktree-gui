// The task pipeline window's client half — the dialog the Queue row opens.
//
// The renderer and the controller are the page's own code, sliced out of public/assistant.js and driven against the
// model lib/pipeline-window.js actually produces, so the markup is tested against the answer the route really sends.
// What this pins:
//
//   - a task on a pipeline draws EVERY stage in order, with the current one marked, its `position of count` beside it,
//     the artifact each stage produces, and the gate that ended the stage before — evidence, not an index;
//   - the current stage's row carries the moment it began and an elapsed span the tick can advance, fed from the
//     model's own stored-stamp number; `pipeWindowElapsedAt` proves the arithmetic with a FIXED clock, including the
//     hour the panel was closed;
//   - a task with no pipeline says it is on the DEFAULT path (the assistant decides), and lists no stages;
//   - an unresolved record says UNRESOLVED, prints the reason, marks no stage current, and says it is not falling back
//     to the default path;
//   - the row itself carries the opener: a press per task that names what the record says — and a task with no
//     assignment still gets one, because the window it opens is where "the assistant decides" is explained;
//   - the dialog is a real modal by behaviour: it takes focus when it opens, Escape closes it and hands focus back to
//     the row it came from, and Tab cycles inside it rather than reaching the page behind.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseBundle } from "../lib/pipeline-bundle.js";
import { buildTaskPipelineWindow } from "../lib/pipeline-window.js";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
};

// The painted text: tags stripped and the entities `esc` writes decoded, the way the browser reads them back.
const plain = (html) =>
  String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const cards = readFileSync(new URL("../public/queue-cards.js", import.meta.url), "utf8");
const windowRegion = sliceRegion(assistant, "the task pipeline window");
const queueRegion = sliceRegion(cards, "the queue sub-tab");

const buildWindow = () =>
  new Function("esc", "fmtDur", `${windowRegion}\nreturn { pipelineWindowHtml, pipeWindowStageOptions, pipeWindowAssignHtml, pipeWindowElapsedAt, pipeWindowElapsedText, pipeWindowShow, pipeWindowClose, pipeWindowKey, pipeWindowTick, pipeWindowState };`)(esc, fmtDur);

const buildQueue = () =>
  new Function("esc", "assistantIds", "sessionById", "assistantThreadName", `${queueRegion}\nreturn { queueTaskHtml };`)(
    esc,
    () => ["assistant-1"],
    (id) => ({ id, name: `Assistant ${id}` }),
    (t) => t,
  );

const stage = (n, title) => ({
  id: `S${n}`,
  title: title || `Stage ${n}`,
  prompt: `Do stage ${n}.`,
  artifact: { id: `artifact-${n}`, path: `out/${n}.json`, schema: "out/1", writer: `worker-${n}` },
});

const bundle = () =>
  parseBundle({
    bundleVersion: 1,
    name: "poc-to-uat",
    pipelines: [
      {
        id: "poc-to-uat",
        title: "POC to UAT",
        stages: [stage(1, "Gather the ask"), stage(2, "Scope it"), stage(3, "Shape the contract"), stage(4, "Build it"), stage(5, "Hand it over")],
        gates: [{ id: "g2", name: "contract signed", after: "S2", artifact: "artifact-2", decider: "reader", decision: { id: "d2", path: "decisions/2.json", schema: "decision/1", writer: "gate-2", outcomes: ["go", "no-go"] } }],
        handoffs: [
          { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
          { id: "h2", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
          { id: "h3", from: "S3", to: "S4", artifact: "artifact-3", kind: "sequence" },
          { id: "h4", from: "S4", to: "S5", artifact: "artifact-4", kind: "sequence" },
        ],
      },
    ],
  });

const NOW = new Date("2026-11-03T15:00:00.000Z");
const model = (run) =>
  buildTaskPipelineWindow(
    { id: 7, title: "carry the contract", state: "running", ...(run === undefined ? { pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } } : { pipelineRun: run }) },
    { source: bundle(), now: NOW },
  );

test("every stage is drawn in order, the current one marked, with its position of N and its artifact", () => {
  const { pipelineWindowHtml } = buildWindow();
  const html = pipelineWindowHtml(model());
  const text = plain(html);
  for (const name of ["Gather the ask", "Scope it", "Shape the contract", "Build it", "Hand it over"]) {
    assert.ok(text.includes(name), `the stage named ${name} is drawn`);
  }
  // Order is the bundle's, and it is the DOM's order too — not a sorted or reversed copy.
  const ids = [...html.matchAll(/data-pipew-stage="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["S1", "S2", "S3", "S4", "S5"]);
  // Exactly one current stage, and it is the record's.
  const current = [...html.matchAll(/class="pipew-stage is-current"[^>]*data-pipew-stage="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(current, ["S3"]);
  assert.match(html, /data-pipew-phase="before"[^>]*>|data-pipew-phase="after"/);
  // The evidence, in words: position of count, the name, the artifact it produces.
  assert.ok(text.includes("3 of 5"), "the current stage says where it sits in the sequence");
  assert.ok(text.includes("out/1.json") && text.includes("out/5.json"), "each stage names the artifact it produces");
  assert.ok(text.includes("2 of 5") && text.includes("5 of 5"), "every stage carries its own position");
});

test("the gate that ended the previous stage is named, with the artifact its decision is written to", () => {
  const { pipelineWindowHtml } = buildWindow();
  const text = plain(pipelineWindowHtml(model()));
  assert.ok(text.includes("contract signed"), "the gate's name is drawn");
  assert.ok(text.includes("decisions/2.json"), "the decision artifact is drawn");
  assert.ok(text.includes("go, no-go"), "the outcomes it can be read back as are drawn");
  assert.ok(/ended the stage before/i.test(text), "the line says what the gate did");
  // And it is attached to S2 (the stage it follows), not to the current stage.
  const s2 = htmlStage(pipelineWindowHtml(model()), "S2");
  assert.ok(s2.includes("contract signed"), "the gate sits on the stage it ended");
  const s3 = htmlStage(pipelineWindowHtml(model()), "S3");
  assert.ok(!s3.includes("contract signed"), "the current stage does not wear the previous stage's gate");
});

function htmlStage(html, id) {
  const at = html.indexOf(`data-pipew-stage="${id}"`);
  if (at < 0) return "";
  const end = html.indexOf("</li>", at);
  return html.slice(at, end < 0 ? html.length : end);
}

test("the current stage carries the moment it began and an elapsed span the tick can advance", () => {
  const { pipelineWindowHtml, pipeWindowElapsedAt, pipeWindowElapsedText } = buildWindow();
  const html = pipelineWindowHtml(model());
  assert.match(html, /data-pipew-elapsed/);
  assert.match(html, /data-pipew-ms="9000000"/, "the stored-stamp number the model computed");
  assert.match(html, /data-pipew-at="\d+"/, "the instant it was computed at");
  const s3 = htmlStage(html, "S3");
  assert.ok(s3.includes("data-pipew-elapsed"), "the elapsed span sits on the current stage's row");
  assert.ok(/12:30/.test(s3) || s3.includes("2026"), "the stamp the stage began is in the row");

  // A FIXED clock: nine seconds after it opened, and one hour after it opened. Nothing here waits.
  const at = NOW.getTime();
  assert.equal(pipeWindowElapsedAt(9_000_000, at, at + 9_000), 9_009_000);
  assert.equal(pipeWindowElapsedAt(9_000_000, at, at + 3_600_000), 12_600_000, "an hour open is an hour more in stage");
  assert.equal(pipeWindowElapsedText(12_600_000), "3h30m00s");
  assert.equal(pipeWindowElapsedText(9_000_000), "2h30m00s");
  // A clock that went backwards does not take time away from the stage.
  assert.equal(pipeWindowElapsedAt(9_000_000, at, at - 5_000), 9_000_000);
});

test("the row's own clock is drawn from createdAt, beside the stage's clock and never instead of it", () => {
  const { pipelineWindowHtml } = buildWindow();
  // Filed at 10:00 and in its stage since 12:30, read at 15:00: the row is five hours old, the stage two and a half.
  const task = {
    id: 7,
    title: "carry the contract",
    state: "running",
    createdAt: "2026-11-03T10:00:00.000Z",
    pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" },
  };
  const html = pipelineWindowHtml(buildTaskPipelineWindow(task, { source: bundle(), now: NOW }));
  assert.match(html, /data-pipew-rowclock="18000000"/, "five hours, as the model computed it");
  const text = plain(html);
  assert.ok(text.includes("on this row 5h00m00s"), `the row's age is painted: ${text.slice(0, 200)}`);
  assert.ok(text.includes("in this stage 2h30m00s"), "and the stage's span is still beside it");

  // `startedAt` is the CURRENT run's stamp and every stage move clears it, so it must not move the row's clock: the
  // same row with a start one minute before the clock still reads five hours.
  const withStart = { ...task, startedAt: "2026-11-03T14:59:00.000Z" };
  const same = pipelineWindowHtml(buildTaskPipelineWindow(withStart, { source: bundle(), now: NOW }));
  assert.match(same, /data-pipew-rowclock="18000000"/, "startedAt is per-stage and never the row's clock");

  // A record with no readable createdAt draws no row clock at all, rather than a zero that reads as "just filed".
  const noStamp = { ...task, createdAt: null };
  const bare = pipelineWindowHtml(buildTaskPipelineWindow(noStamp, { source: bundle(), now: NOW }));
  assert.doesNotMatch(bare, /data-pipew-rowclock/);
});

test("a task with no pipeline says it is on the default path, and lists no stages", () => {
  const { pipelineWindowHtml } = buildWindow();
  for (const record of [
    { id: 7, title: "carry the contract", pipelineRun: null },
    { id: 7, title: "carry the contract" },
  ]) {
    const html = pipelineWindowHtml(buildTaskPipelineWindow(record, { source: bundle(), now: NOW }));
    const text = plain(html);
    assert.match(text, /default path/i, JSON.stringify(record.pipelineRun));
    assert.match(text, /assistant decides/i);
    assert.doesNotMatch(html, /data-pipew-stage/, "there is no sequence to draw");
    assert.doesNotMatch(text, /unresolved/i);
  }
});

test("an unresolved record says so, prints the reason, and marks no stage current", () => {
  const { pipelineWindowHtml } = buildWindow();
  const html = pipelineWindowHtml(model({ pipeline: "poc-to-uat", stage: "S9", enteredAt: "2026-11-03T12:30:00.000Z" }));
  const text = plain(html);
  assert.match(text, /unresolved/i);
  assert.ok(text.includes('"S9"'), "the reason names the stage the record asked for");
  assert.ok(text.includes("S1, S2, S3, S4, S5"), "the reason names the order the pipeline holds");
  assert.ok(!/class="pipew-stage is-current"/.test(html), "nothing is marked current");
  assert.ok(text.includes("Gather the ask"), "the sequence it still has is drawn, unplaced");
  assert.match(text, /not falling back|never treated as|does not fall back/i, "the window says it is not the default path");
});

test("a bundle that was refused is drawn as the reason, not as a broken task", () => {
  const { pipelineWindowHtml } = buildWindow();
  const html = pipelineWindowHtml(buildTaskPipelineWindow({ id: 7, title: "t", pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } }, { source: parseBundle("{"), now: NOW }));
  const text = plain(html);
  assert.match(text, /unresolved/i);
  assert.match(text, /not JSON/);
});

test("every string the model carries is escaped into the markup", () => {
  const { pipelineWindowHtml } = buildWindow();
  const m = model();
  m.stages[2].title = '<script>alert("x")</script>';
  m.current.title = '<script>alert("x")</script>';
  const html = pipelineWindowHtml(m);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("opening takes focus, Escape closes and hands it back to the row, and Tab cycles inside", () => {
  const { pipeWindowShow, pipeWindowClose, pipeWindowKey, pipeWindowState } = buildWindow();
  const focused = [];
  const opener = { isConnected: true, focus: () => focused.push("opener") };
  const card = { innerHTML: "", tabIndex: -1, dataset: {}, focus: () => focused.push("card"), querySelectorAll: () => [first, last] };
  const first = { focus: () => focused.push("first") };
  const last = { focus: () => focused.push("last") };
  const host = { hidden: true };
  const body = { classList: { added: [], add(c) { this.added.push(c); }, remove(c) { this.added = this.added.filter((x) => x !== c); } } };
  const doc = { getElementById: (id) => (id === "pipew" ? host : id === "pipew-card" ? card : null), body, activeElement: first, querySelector: () => null };

  pipeWindowShow({ doc, model: model(), opener });
  assert.equal(host.hidden, false, "the dialog is shown");
  assert.match(card.innerHTML, /data-pipew-stage="S3"/, "the model is drawn into it");
  assert.equal(card.dataset.pipewMode, "pipeline", "the element says which state it is in");
  assert.deepEqual(focused, ["card"], "the dialog takes the caret");
  assert.ok(body.classList.added.includes("pipew-open"), "the page behind is locked");
  assert.equal(pipeWindowState.opener, opener, "the row it came from is remembered");

  // Escape closes, and the caret goes back to the row.
  focused.length = 0;
  const escape = { key: "Escape", prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  assert.equal(pipeWindowKey(escape, { doc }), true);
  assert.equal(escape.prevented, true, "Escape does not also close the rail behind it");
  assert.equal(escape.stopped, true);
  assert.equal(host.hidden, true, "the dialog is closed");
  assert.equal(card.innerHTML, "", "and holds nothing to tab into");
  assert.deepEqual(focused, ["opener"], "focus returns to the row it came from");
  assert.ok(!body.classList.added.includes("pipew-open"), "the page behind is unlocked");
  assert.equal(pipeWindowClose({ doc }), false, "closing an already-closed window is a no-op");
});

test("Tab wraps inside the dialog instead of reaching the page behind it", () => {
  const { pipeWindowShow, pipeWindowKey } = buildWindow();
  const focused = [];
  const first = { focus: () => focused.push("first") };
  const last = { focus: () => focused.push("last") };
  const card = { innerHTML: "", dataset: {}, focus: () => {}, querySelectorAll: () => [first, last] };
  const host = { hidden: true };
  const doc = { getElementById: (id) => (id === "pipew" ? host : id === "pipew-card" ? card : null), body: { classList: { add() {}, remove() {} } }, activeElement: last, querySelector: () => null };
  pipeWindowShow({ doc, model: model(), opener: null });

  const tab = (shiftKey) => ({ key: "Tab", shiftKey, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} });
  const forward = tab(false);
  assert.equal(pipeWindowKey(forward, { doc }), true, "Tab on the last item wraps");
  assert.equal(forward.prevented, true);
  assert.deepEqual(focused, ["first"]);

  doc.activeElement = first;
  const back = tab(true);
  assert.equal(pipeWindowKey(back, { doc }), true, "Shift+Tab on the first item wraps");
  assert.deepEqual(focused, ["first", "last"]);

  doc.activeElement = first;
  const middle = tab(false);
  assert.equal(pipeWindowKey(middle, { doc }), false, "a Tab in the middle is the browser's own move");
  assert.equal(middle.prevented, false);
});

test("an elapsed the server could not compute is drawn as unknown, and the tick does not invent one", () => {
  const { pipelineWindowHtml, pipeWindowTick } = buildWindow();
  // The stage is known and marked; only the stored stamp is bad, so the row keeps its mark and says "—".
  const m = buildTaskPipelineWindow(
    { id: 7, title: "carry the contract", pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03 12:30:00" } },
    { source: bundle(), now: NOW },
  );
  const html = pipelineWindowHtml(m);
  assert.match(html, /data-pipew-elapsed data-pipew-ms="" data-pipew-at="\d+">—</);
  const el = { dataset: { pipewMs: "", pipewAt: String(NOW.getTime()) }, textContent: "—" };
  const doc = { querySelector: () => el };
  assert.equal(pipeWindowTick(doc), null, "no base, no advance");
  assert.equal(el.textContent, "—", "the word stays unknown instead of counting up from the open");
});

test("the row carries the opener, naming what the record says, and a task with no assignment still gets one", () => {
  const { queueTaskHtml } = buildQueue();
  const base = { id: 7, title: "carry the contract", state: "queued", files: [] };

  const onPipeline = queueTaskHtml("assistant-1", { ...base, pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-03T12:30:00.000Z" } }, new Map());
  assert.match(onPipeline, /<button[^>]*class="as-task-pipe"[^>]*data-as-qpipe="7"/);
  assert.match(onPipeline, /data-as-qown="assistant-1"/);
  assert.match(onPipeline, /pipeline poc-to-uat · S3/);
  assert.match(onPipeline, /title="[^"]*open the pipeline window/);

  const none = queueTaskHtml("assistant-1", { ...base, pipelineRun: null }, new Map());
  assert.match(none, /data-as-qpipe="7"/, "a task on the default path still opens its window");
  assert.match(none, /assistant decides/, "the row says which choice is in force, in the assistant's own words");

  const broken = queueTaskHtml("assistant-1", { ...base, pipelineRun: "poc-to-uat" }, new Map());
  assert.match(broken, /data-as-qpipe="7"/);
  assert.match(broken, /unreadable/, "a record that is not an assignment says so on the row");

  const escaped = queueTaskHtml("assistant-1", { ...base, pipelineRun: { pipeline: '"><script>', stage: "S3" } }, new Map());
  assert.doesNotMatch(escaped, /<script>/);
});

// ---- putting a task on a pipeline, from the window --------------------------------------------------
// The window is the only place the stage list is already drawn, so it is where the choice belongs: a
// reader looking at "this task is on the default path" can put it on a pipeline without leaving the
// screen that told them so. The control draws the CATALOGUE the server read (ids, names, positions) and
// writes through the queue's own route; it never assumes a bundle is there, because the panel must stay
// honest when one is not.
const catalogue = () => ({
  ok: true,
  code: null,
  reason: null,
  file: "C:/state/pipeline-bundle.json",
  name: "poc-to-uat",
  pipelines: [
    { id: "poc-to-uat", title: "POC to UAT", stages: [{ id: "S1", title: "Gather the ask", position: 1 }, { id: "S2", title: "Scope it", position: 2 }, { id: "S3", title: "Shape the contract", position: 3 }, { id: "S4", title: "Build it", position: 4 }, { id: "S5", title: "Hand it over", position: 5 }] },
    { id: "triage", title: "Triage", stages: [{ id: "T1", title: "Read it", position: 1 }, { id: "T2", title: "Place it", position: 2 }] },
  ],
});

test("a task on the default path is offered a pipeline and a starting stage, from the bundle's catalogue", () => {
  const { pipelineWindowHtml } = buildWindow();
  const html = pipelineWindowHtml(model(null), catalogue());
  assert.match(html, /data-pipew-assign/, "the control is drawn in the default-path window");
  assert.match(html, /<select[^>]*data-pipew-pipe/, "a pipeline is chosen by name, not typed as an id");
  assert.match(html, /<select[^>]*data-pipew-stage/, "and a starting stage is chosen explicitly");
  assert.match(html, /data-pipew-apply/, "one press writes the choice");
  assert.doesNotMatch(html, /data-pipew-clear/, "there is nothing to clear on a task that has no pipeline");
  for (const name of ["POC to UAT", "Triage"]) assert.ok(plain(html).includes(name), `the catalogue's ${name} is offered`);
  // The stage select is the FIRST pipeline's stages until another is chosen — the same list the rows above draw.
  const options = [...html.matchAll(/<option value="(S\d)"/g)].map((m) => m[1]);
  assert.deepEqual(options, ["S1", "S2", "S3", "S4", "S5"]);
});

test("a task already on a pipeline offers the move and the way back to the assistant-decides default", () => {
  const { pipelineWindowHtml } = buildWindow();
  const html = pipelineWindowHtml(model(), catalogue());
  assert.match(html, /<option value="poc-to-uat" selected/, "the pipeline in force is the one selected");
  assert.match(html, /<option value="S3" selected/, "the stage in force is the one selected");
  assert.match(html, /data-pipew-apply/, "the move is one press");
  assert.match(html, /data-pipew-clear/, "and clearing is its own press, never a side effect of the move");
  assert.match(plain(html), /back to the assistant/i, "the clear button says where it puts the task");
});

test("choosing another pipeline redraws the stage list from that pipeline, and keeps the chosen stage", () => {
  const { pipeWindowStageOptions } = buildWindow();
  const options = pipeWindowStageOptions(catalogue(), "triage", "T2");
  assert.deepEqual([...options.matchAll(/value="(T\d)"/g)].map((m) => m[1]), ["T1", "T2"]);
  assert.match(options, /<option value="T2" selected/);
  // A stage id the chosen pipeline does not hold is not silently kept: the first stage is selected instead.
  const fallback = pipeWindowStageOptions(catalogue(), "triage", "S3");
  assert.match(fallback, /<option value="T1" selected/);
});

test("with no bundle, the window says why the choice cannot be offered — and still says the default path", () => {
  const { pipelineWindowHtml } = buildWindow();
  const missing = {
    ok: false,
    code: "missing",
    reason: "C:/state/pipeline-bundle.json: there is no bundle at that path",
    where: null,
    file: "C:/state/pipeline-bundle.json",
    name: null,
    pipelines: [],
  };
  const html = pipelineWindowHtml(model(null), missing);
  const text = plain(html);
  assert.match(text, /default path/i, "the task's own answer is unchanged");
  assert.match(text, /no bundle at that path/, "the refusal is printed rather than hidden");
  assert.match(text, /pipeline-bundle\.json/, "it names the file that is not there");
  assert.doesNotMatch(html, /data-pipew-apply/, "nothing can be assigned against a bundle that is not there");
  assert.doesNotMatch(html, /data-pipew-clear/);
});

test("while the catalogue is still being read, the control says so and offers nothing pressable", () => {
  const { pipelineWindowHtml } = buildWindow();
  const html = pipelineWindowHtml(model(null), null);
  assert.match(plain(html), /reading the pipelines/i);
  assert.doesNotMatch(html, /data-pipew-apply/);
});

test("an unresolved record can be repaired by assigning a pipeline, and the control says that is what it does", () => {
  const { pipelineWindowHtml } = buildWindow();
  const html = pipelineWindowHtml(model({ pipeline: "gone-to-uat", stage: "S1", enteredAt: "2026-11-03T12:30:00.000Z" }), catalogue());
  assert.match(html, /data-pipew-assign/, "the broken record still has a way out");
  assert.match(plain(html), /replaces? (this|the) record|replac/i, "it says the assignment replaces the record");
  assert.match(html, /<option value="poc-to-uat" selected/, "and defaults to a pipeline the bundle DOES hold, not the broken one");
  assert.match(html, /data-pipew-apply/);
});

// The stage row is a three-column grid: the ordinal, the title, the position. Every line UNDER the title must be told
// to span the two wide columns, or the row's own placement cursor drops it into the 18 px ordinal column — where its
// text is 18 px wide and paints across the line beside it. That is the defect the block shipped with: the visit line
// and the decision line were the only two children the placement rule did not name, so "visit 1 · gui-improve/
// baseline#1" and "in this stage 41m41s since …" both landed on one line, interleaving as "visin this stage …".
test("every line under the current stage's title is placed on its own row, not auto-placed into the ordinal column", () => {
  const { pipelineWindowHtml } = buildWindow();
  // Two records, so the row is drawn with EVERY child it can hold: a stage-run decision (the decision line), a visit
  // (the visit line) and a gate after the stage (the gate line). `pipew-since`/`pipew-warn` are painted INSIDE the
  // elapsed line, so they are inline text and not grid children.
  const rowFor = (run) =>
    htmlStage(pipelineWindowHtml(buildTaskPipelineWindow({ id: 7, title: "carry the contract", state: "running", pipelineRun: run }, { source: bundle(), now: NOW })), run.stage);
  const decided = rowFor({
    pipeline: "poc-to-uat",
    stage: "S3",
    enteredAt: "2026-11-03T12:30:00.000Z",
    visits: { S3: 1 },
    stageRuns: [{ id: "poc-to-uat/S3#1", stage: "S3", visit: 1, decision: { reason: "the loop asked for another pass", code: "again" } }],
  });
  const gated = rowFor({ pipeline: "poc-to-uat", stage: "S2", enteredAt: "2026-11-03T12:30:00.000Z", visits: { S2: 1 } });
  const INLINE = new Set(["pipew-since", "pipew-warn"]);
  const children = [...new Set([...`${decided}${gated}`.matchAll(/<span class="(pipew-[a-z-]+)/g)].map((m) => m[1]))].filter((c) => !INLINE.has(c));
  // The head trio is the one line that is MEANT to be three cells: 1 · Baseline · 1 of 5.
  const HEAD = new Set(["pipew-n", "pipew-name", "pipew-pos"]);
  assert.deepEqual(
    [...children].sort(),
    ["pipew-artifact", "pipew-decision", "pipew-gate", "pipew-live", "pipew-n", "pipew-name", "pipew-phase", "pipew-pos", "pipew-visit"],
    "the row's children are the nine the stylesheet has to place",
  );

  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  // The rule that gives a child its own line: a selector list carrying `grid-column: 2 / -1`.
  const placed = new Set();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|;)\s*grid-column:\s*2\s*\/\s*-1\s*(;|$)/.test(rule[2])) continue;
    for (const name of rule[1].matchAll(/\.(pipew-[a-z-]+)/g)) placed.add(name[1]);
  }
  const loose = children.filter((name) => !HEAD.has(name) && !placed.has(name));
  assert.deepEqual(loose, [], "a child the grid rule does not name is auto-placed into the ordinal column and paints over the line beside it");
  // Named explicitly, because these two are the ones that shipped unplaced.
  assert.ok(placed.has("pipew-visit"), "the visit line spans the row like every other line under the title");
  assert.ok(placed.has("pipew-decision"), "the decision line does too");
  for (const name of HEAD) assert.ok(!placed.has(name), `${name} stays in the head line, where the title sits beside it`);
});
