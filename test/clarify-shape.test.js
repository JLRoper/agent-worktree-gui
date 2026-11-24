// The four-direction shape check (lib/clarify-shape.js) and the three places its verdict travels: the card's record,
// the durable clarify history, and the popup's count.
//
// THE HARD CONSTRAINT, proved here rather than asserted in a comment: the check NEVER blocks a card. Every case that
// reads "short" or "out of order" below also raises the card through the panel's own `clarify.request` seam, answers
// it through `noteAnswered`, and sees it settle exactly as a complete card does. A card that cannot be raised strands
// the run parked on it, so a test that let a bad shape stop one would be a test that shipped the defect.
//
// THE PROOFS, in the brief's order:
//   four kinds          complete, with the kinds named in the order the card offers them
//   two plain choices   short, naming the kinds that are missing
//   out of order        flagged, and still raised, answered and settled
//   the count           moves by exactly one per card that offers four directions, and the page cap never shrinks it
//   a two-choice card   raises, answers and settles end to end, as it did before this landed
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLARIFY_KINDS,
  checkChoices,
  isRecommended,
  kindOf,
  normalizeShape,
  shapeLine,
} from "../lib/clarify-shape.js";
import { createClarifyHistoryRoutes } from "../routes/clarify-history.js";
import { Jobs } from "../lib/jobs.js";
import { sliceBetween } from "../tools/panel-testkit.mjs";
import "../public/core/clarify-history.js";

const Core = globalThis.wtClarifyHistory;
const quiet = () => {};
const iso = (ms) => new Date(ms).toISOString();

const FOUR = [
  "Finish: land this and stop (Recommended)",
  "Deeper: build the seam check",
  "Route: build the answer-to-row bridge",
  "Ask: park the build",
];
const TWO = ["the turn", "the agent"];
const OUT_OF_ORDER = [
  "Deeper: build the seam check",
  "Finish: land this and stop (Recommended)",
  "Route: build the answer-to-row bridge",
  "Ask: park the build",
];

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "clarify-shape-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- the classifier: SHAPE only ------------------------------------------------------------------------------------
test("four kinds read complete, with the directions named in the order the card offers them", () => {
  const shape = checkChoices(FOUR);
  assert.equal(shape.ok, true);
  assert.equal(shape.count, 4);
  assert.deepEqual(shape.kinds, CLARIFY_KINDS);
  assert.deepEqual(shape.missing, []);
  assert.deepEqual(shape.repeated, []);
  assert.equal(shape.recommendedIndex, 0, "the marked choice is the first one");
  assert.equal(shape.ordered, true);
  assert.equal(shape.line, "four directions, in order: Finish, Deeper, Route, Ask");
  // The gateway's marker is a tail on the label and is not part of the kind.
  assert.equal(kindOf(FOUR[0]), "finish");
  assert.equal(isRecommended(FOUR[0]), true);
});

test("two plain choices read short and name every kind that is missing", () => {
  const shape = checkChoices(TWO);
  assert.equal(shape.ok, false);
  assert.equal(shape.count, 2);
  assert.deepEqual(shape.kinds, []);
  assert.deepEqual(shape.missing, CLARIFY_KINDS);
  assert.equal(shape.ordered, true, "with no marker there is nothing to contradict");
  assert.equal(shape.line, "short: none of the 4 directions in 2 choices · missing Finish, Deeper, Route, Ask");
});

test("two choices that carry one kind name the three that are missing", () => {
  const shape = checkChoices(["Finish: land it", "hold it"]);
  assert.equal(shape.ok, false);
  assert.deepEqual(shape.kinds, ["finish"]);
  assert.deepEqual(shape.missing, ["deeper", "route", "ask"]);
  assert.match(shape.line, /^short: 1 of the 4 directions \(Finish\)/);
  assert.match(shape.line, /missing Deeper, Route, Ask/);
});

test("a recommended choice that is not first is flagged out of order, and still classified", () => {
  const shape = checkChoices(OUT_OF_ORDER);
  assert.equal(shape.ok, false, "the rule wants the recommendation first");
  assert.equal(shape.recommendedIndex, 1);
  assert.equal(shape.ordered, false);
  assert.deepEqual(shape.missing, [], "all four kinds are there: this is an ORDER defect, not a missing one");
  assert.match(shape.line, /^four directions, out of order: Deeper, Finish, Route, Ask/);
  assert.match(shape.line, /the recommended choice is not first/);
});

test("a repeated kind is named, and the missing one is still named", () => {
  const shape = checkChoices(["Finish: a", "Finish: b", "Route: c", "Ask: d"]);
  assert.equal(shape.ok, false);
  assert.deepEqual(shape.repeated, ["finish"]);
  assert.deepEqual(shape.missing, ["deeper"]);
  assert.match(shape.line, /Finish appears twice/);
  assert.match(shape.line, /missing Deeper/);
});

test("the classifier is total: nothing it is handed throws, and a non-list is zero choices", () => {
  for (const input of [undefined, null, "Finish: not a list", 42, {}, [null, "", "   ", 7]]) {
    const shape = checkChoices(input);
    assert.equal(typeof shape.line, "string");
    assert.equal(shape.ok, false);
  }
  assert.equal(checkChoices(null).count, 0);
  assert.equal(checkChoices([null, "", "   ", 7]).count, 1, "an empty choice is not a choice; a number is text");
  // A stored verdict from another build is read back with the fields the card and the popup use.
  const read = normalizeShape({ ok: true, count: 4, kinds: CLARIFY_KINDS, missing: [], repeated: [] });
  assert.equal(read.ok, true);
  assert.equal(read.line, "four directions, in order: Finish, Deeper, Route, Ask", "a record without a line still draws");
  assert.equal(normalizeShape(null), null);
  assert.equal(normalizeShape("nope"), null);
});

// ---- the seam: a real Jobs records the shape, and never refuses the card -------------------------------------------
function raise(jobs, { id = "job-1", prompt = "p-1", choices = FOUR, question = "which way next?", at = Date.UTC(2026, 10, 24, 12, 0) } = {}) {
  const j = {
    id,
    runId: `run-${id}`,
    thread: `thread-${id}`,
    status: "running",
    startedAt: iso(at),
    endedAt: null,
    lines: [],
    title: `card ${id}`,
    thread2: null,
  };
  jobs.jobs.set(j.id, j);
  jobs.consume(j, { event: "clarify.request", prompt_id: prompt, question, choices });
  return j;
}

test("the seam stores question.shape, the history records it, and a short card still answers and settles", () => {
  const t = tempDir();
  try {
    const jobs = new Jobs({
      config: { jobsFile: path.join(t.dir, "jobs.json"), clarifyHistoryFile: path.join(t.dir, "clarify-history.json") },
      onLog: quiet,
    });
    const j = raise(jobs);
    assert.ok(j.question, "the card is on the record");
    assert.equal(j.question.shape.ok, true);
    assert.equal(j.question.shape.line, "four directions, in order: Finish, Deeper, Route, Ask");
    const open = jobs.clarifyHistory.list().entries[0];
    assert.equal(open.status, "open");
    assert.equal(open.shape.ok, true, "the history keeps the verdict the card drew");
    assert.equal(open.shape.line, j.question.shape.line);

    // A two-choice card: short, and still raised exactly as before.
    const two = raise(jobs, { id: "job-2", prompt: "p-2", choices: TWO });
    assert.deepEqual(two.question.choices, TWO, "the choices are copied verbatim, never repaired");
    assert.equal(two.question.shape.ok, false);
    assert.match(two.question.shape.line, /missing Finish, Deeper, Route, Ask/);
    jobs.noteAnswered(two, "the turn", { status: "running", by: "reader" });
    assert.equal(two.question, null, "a short card settles exactly like a complete one");
    assert.equal(two.questionDone.answer, "the turn");
    const answered = jobs.clarifyHistory.list().entries.find((e) => e.jobId === "job-2");
    assert.equal(answered.status, "answered");
    assert.equal(answered.answer, "the turn");
    assert.equal(answered.shape.ok, false, "and the record still says what shape it was");

    // An out-of-order card: flagged, and STILL answerable. This is the row's whole safety argument.
    const wrong = raise(jobs, { id: "job-3", prompt: "p-3", choices: OUT_OF_ORDER });
    assert.equal(wrong.question.shape.ordered, false);
    assert.match(wrong.question.shape.line, /the recommended choice is not first/);
    assert.equal(wrong.question.choices.length, 4, "every choice the tool offered is still on the card");
    jobs.noteAnswered(wrong, "Finish: land this and stop (Recommended)", { status: "running", by: "reader" });
    assert.equal(wrong.question, null);
    assert.equal(wrong.questionDone.answer, "Finish: land this and stop (Recommended)");
  } finally {
    t.done();
  }
});

test("the popup's four-direction count moves one per card and ignores the page cap", async () => {
  const t = tempDir();
  try {
    const jobs = new Jobs({
      config: { jobsFile: path.join(t.dir, "jobs.json"), clarifyHistoryFile: path.join(t.dir, "clarify-history.json") },
      onLog: quiet,
    });
    const read = async (limit = null) => {
      const sent = [];
      const route = createClarifyHistoryRoutes({ jobs: { clarifyHistory: jobs.clarifyHistory, list: () => [] }, sendJson: (_r, code, body) => sent.push({ code, body }) });
      const url = new URL(`http://127.0.0.1/api/clarify/history${limit ? `?limit=${limit}` : ""}`);
      await route({ method: "GET", url: url.pathname + url.search }, {}, "/api/clarify/history", url);
      assert.equal(sent[0].code, 200);
      return sent[0].body;
    };

    let body = await read();
    assert.deepEqual(body.fourDirections, { week: 0, weekCards: 0, all: 0, allCards: 0, days: 7 });
    assert.equal(Core.fourDirectionsText(body.fourDirections), "four directions: no card asked this week");

    // The cards are asked NOW: the clarify.request handler stamps the question's arrival itself, so the week window
    // reads the ask's own time and no clock is faked here.
    raise(jobs, { id: "job-10", prompt: "p-10", choices: FOUR });
    body = await read();
    assert.equal(body.fourDirections.week, 1);
    assert.equal(body.fourDirections.weekCards, 1);
    assert.equal(Core.fourDirectionsText(body.fourDirections), "four directions: 1 of 1 card this week");

    raise(jobs, { id: "job-11", prompt: "p-11", choices: FOUR });
    body = await read();
    assert.equal(body.fourDirections.week, 2, "one more four-direction card is one more in the count");

    raise(jobs, { id: "job-12", prompt: "p-12", choices: TWO });
    body = await read();
    assert.equal(body.fourDirections.weekCards, 3, "the denominator counts every card asked in the week");
    assert.equal(body.fourDirections.week, 2, "the numerator counts only the cards that offered four directions");
    assert.equal(Core.fourDirectionsText(body.fourDirections), "four directions: 2 of 3 cards this week");

    // The count is over every kept item, before the popup's render cap.
    body = await read(1);
    assert.equal(body.items.length, 1, "one row drawn");
    assert.equal(body.total, 3, "and the honest total");
    assert.equal(body.fourDirections.week, 2, "the cap must not shrink the habit's denominator");
  } finally {
    t.done();
  }
});

// ---- the card: ONE line, drawn from the shipped questionPrompt -----------------------------------------------------
// The page's own functions run here, sliced out of public/app.js exactly as test/clarify-question-links.test.js does,
// so the strip is proved against the code that draws the card rather than a copy of it.
async function cardHtml(choices) {
  const page = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const dom = readFileSync(new URL("../public/core/dom-format.js", import.meta.url), "utf8");
  const source = [
    sliceBetween(dom, "const esc = (s) =>", "\n// A path as a card"),
    sliceBetween(dom, "const OUT_URL_RE", "\nfunction fmtBytes"),
    sliceBetween(page, "const browserName =", "function paintQLook"),
    sliceBetween(page, "function questionLinks(q) {", "function questionPrompt("),
    sliceBetween(page, "const RECOMMENDED_RE", "// ---- the question box's look (Settings > Display)"),
    sliceBetween(page, 'function questionPrompt(turn, copy = "")', '// "~49m left"'),
  ].join("\n");
  const build = new Function(
    "turnLive", "questionInFlight", "qLookState", "fmtLeft", "questionPicks", "questionDrafts", "questionBrowser",
    `${source}\nreturn { questionPrompt };`,
  );
  const turn = {
    id: "turn-shape",
    thread: "wtgui-clarify-shape",
    status: "running",
    questionDone: false,
    // `shape` is the SHIPPED verdict, the same object lib/jobs.js puts on the record.
    question: { question: "which way next?", choices, requestId: "p-shape", links: [], base: "", shape: checkChoices(choices) },
  };
  return build(() => true, () => null, { typed: true }, () => "10m", new Map(), new Map(), "Google Chrome").questionPrompt(turn);
}

const strip = (html) => {
  const m = /<div class="tq-shape[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1] : null;
};

test("a complete card draws one line naming the four directions in order, over live choices", async () => {
  const html = await cardHtml(FOUR);
  assert.equal((html.match(/class="tq-shape/g) || []).length, 1, "exactly ONE line");
  assert.match(html, /class="tq-shape is-complete"/);
  assert.equal(strip(html), "four directions, in order: Finish, Deeper, Route, Ask");
  assert.equal((html.match(/class="tq-choice"/g) || []).length, 4, "the choices are still drawn");
  assert.doesNotMatch(html, /class="tq-choice[^"]*"[^>]*disabled/, "and none of them is disabled by the verdict");
});

test("two plain choices draw the short line naming what is missing, and both stay answerable", async () => {
  const html = await cardHtml(TWO);
  assert.match(html, /class="tq-shape"/);
  assert.doesNotMatch(html, /is-complete/, "a short card is not painted as complete");
  assert.equal(strip(html), "short: none of the 4 directions in 2 choices · missing Finish, Deeper, Route, Ask");
  assert.equal((html.match(/class="tq-choice"/g) || []).length, 2);
  assert.doesNotMatch(html, /class="tq-choice[^"]*"[^>]*disabled/);
});

test("an out-of-order card says so in its one line, and every choice is still offered", async () => {
  const html = await cardHtml(OUT_OF_ORDER);
  assert.equal(strip(html), "four directions, out of order: Deeper, Finish, Route, Ask · the recommended choice is not first");
  assert.equal((html.match(/class="tq-choice"/g) || []).length, 4);
  assert.doesNotMatch(html, /class="tq-choice[^"]*"[^>]*disabled/);
});

test("a card with no choices draws no strip: it offers no directions to be short of", async () => {
  const html = await cardHtml([]);
  assert.equal(strip(html), null);
});

// ---- the wiring: the strip, the popup line and the styles are shipped together -------------------------------------
test("the card, the popup and the stylesheet carry the shape line", async () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  const pop = readFileSync(new URL("../public/clarify-history.js", import.meta.url), "utf8");
  const core = readFileSync(new URL("../public/core/clarify-history.js", import.meta.url), "utf8");
  assert.match(app, /function questionPrompt\(turn, copy = ""\)[\s\S]*?\$\{questionShape\(q\)\}/, "the strip is drawn inside the card");
  assert.match(app, /function questionShape\(q\)[\s\S]*?tq-shape/);
  assert.match(css, /\.tq-shape \{/);
  assert.match(css, /\.tq-shape\.is-complete/);
  assert.match(pop, /<div class="ch-shapes mono" id="ch-shapes" hidden><\/div>/);
  assert.match(pop, /C\.fourDirectionsText\(summary\)/);
  assert.match(pop, /clarifyHist\.fourDirections = body\.fourDirections/);
  assert.match(css, /\.ch-pop \.ch-shapes \{/);
  assert.match(core, /function fourDirectionsText\(summary\)/);
});
