#!/usr/bin/env node
// HARNESS: LIVE GATE (the shipped renderer and stylesheets, Playwright at 1160 and 420 px)
// tools/verify-queue-agents.mjs - EVERY AGENT ON ITS OWN LINE inside the queue card's facts block.
//
//   node tools/verify-queue-agents.mjs
//   node tools/verify-queue-agents.mjs --root <export dir>   # measure a `git archive` of another build
//   node tools/verify-queue-agents.mjs --shots <dir>         # the cards as PNGs
//   node tools/verify-queue-agents.mjs --json <file>         # the raw ledger of boxes
//
// THE DEFECT. `div.as-task-facts` is `display: flex; flex-wrap: wrap` with a `2px 8px` gap, and the full card
// joined its agent rows straight into it (`list.map(queueAgentHtml).join("")`). Each `div.as-task-agent` was
// therefore a flex CHILD, so two agents laid out side by side, and the column gap between them read as the
// separator between two agents instead of the line break between them. A reader photographed exactly that on a
// card carrying an EXITED thread and a RUNNING one.
//
// THE FIX THIS GATE PINS. The agent rows sit in one block of their own inside the facts line: a column with no
// horizontal indent (the facts line already carries the 18 px, and `.as-task-agents`' 19 px belongs to the
// Initiatives pane, so that container is not the one to reuse), each agent div full width, and the meta line
// (project, PR) keeping its own inline row after them. One agent is the degenerate case of the same rule and
// must measure the same as it did before: one line, natural width, meta beside it.
//
// WHAT IS MEASURED, off rendered boxes rather than off the source (the renderer is the page's own code, sliced
// out of public/queue-cards.js exactly as test/assistant-queue-ui.test.js slices it, and the stylesheet is
// public/style.css as it ships):
//
//   two threads    the two .as-task-agent boxes share one left edge and one full width; their top offsets are
//                  a whole line apart; the meta text starts on the line below the second agent.
//   three threads  the third stacks too: three left-equal boxes, three increasing tops, meta under the third.
//   one thread     unchanged: one agent box, natural width (not stretched), on the facts block's own top, with
//                  the meta text still sharing its line.
//   pipeline       the chip is a block of its own under the facts line, a sibling of it, never inside it.
//   provenance     each agent line carries the project and the landed verdict of the tree THAT thread ran in, read
//                  back through the queue's own `threadTrees`/`decorateTasks` path; a thread with no recorded tree
//                  draws nothing, and the task-level meta line steps aside when the agent lines carry it.
//   compact card   the Initiatives pane's single-thread line is one line and has no wrapper of its own.
//
// The page is synthetic on purpose (no panel, no queue file, no port): the card markup comes from the shipped
// renderer, the four stylesheets are the ones public/index.html loads in its own order, and the boxes are
// Chromium's, so nothing else can be blamed for a layout answer.
//
// EXIT CODES: 0 every box held; 1 a check failed; 2 the browser half did not run (no Playwright), which is never
// a pass.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";
import { sliceRegion } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
// `--root <dir>` measures another build (a `git archive` of the base commit, say) with the same fixtures, which is
// how the before and the after of a layout claim are read the same way.
const ROOT = path.resolve(opt("--root") || path.resolve(HERE, ".."));
const SHOTS = opt("--shots");
const JSON_OUT = opt("--json");
// The width the reader photographed: wide enough that two agent rows FIT side by side, which is the state the
// defect needs. A gate run at 360 px would pass on wrapping alone and prove nothing.
const WIDE = 1160;
// The narrow pane a real assistant column gives the card, where the stacking must still hold.
const NARROW = 420;

let checks = 0;
let failures = 0;
const ledger = { cases: {}, notes: [] };
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (text) => {
  ledger.notes.push(text);
  console.log(`      ${text}`);
};
const round = (n) => Math.round(n * 100) / 100;

// ---- the renderer, sliced out of the shipped file ------------------------------------------------------------
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function cardsFromSource() {
  const src = readFileSync(path.join(ROOT, "public", "queue-cards.js"), "utf8");
  const region = sliceRegion(src, "the queue sub-tab");
  return new Function(
    "esc",
    "assistantIds",
    "sessionById",
    "assistantThreadName",
    "relTime",
    `${region}\nreturn { taskCardHtml };`,
  )(
    esc,
    () => ["assistant-1", "assistant-2"],
    (id) => ({ id, name: `Assistant ${id}` }),
    (thread) => thread,
    () => "2m",
  );
}

// ---- the fixtures: one queue row per thread count, all on the reader's own project ---------------------------
const PROJECT = "agent-worktree-gui";
const THREAD = (n) => `wtgui-queue-card-agent-${n}-7b3e42`;
const TWO = [THREAD("one"), THREAD("two")];
const THREE = [THREAD("one"), THREAD("two"), THREAD("three")];
const ONE = [THREAD("one")];
const PROV_A = THREAD("prov-a");
const PROV_B = THREAD("prov-b");
const PROV_NONE = THREAD("prov-none");
const TREE_A = `${PROJECT}/.worktrees/queue-card-agents-371`;
const TREE_B = `poc-guidelines/.worktrees/poc-guidelines-cut-4f11aa`;

const task = (id, threads, extra = {}) => ({
  id,
  title: "the agent rows stack one per line inside the facts block",
  state: "running",
  thread: threads[0],
  threads,
  project: PROJECT,
  worktree: `${PROJECT}/.worktrees/queue-card-agents-${id}`,
  files: ["public/queue-cards.js", "public/style.css"],
  attempts: 2,
  ...extra,
});

// The board rows the queue's read decorates against. The four plain cards each point at their own tree; the
// provenance card's two recorded agents ran in DIFFERENT projects, which is the whole reason the fact belongs on the
// agent's line rather than on the task's meta line. `prov-none` has no recorded tree, so its line must stay bare.
const ROWS = [
  ...[371, 372, 373, 374].map((id) => ({ path: `${PROJECT}/.worktrees/queue-card-agents-${id}`, project: PROJECT, verdict: "NO COMMITS" })),
  { path: TREE_A, project: PROJECT, verdict: "UNMERGED (2 commits)", branchKind: "research", branchKindLabel: "research tree" },
  { path: TREE_B, project: "poc-guidelines", verdict: "MERGED (3 commits)", pr: { number: 373, state: "OPEN" }, branchKind: "turnover", branchKindLabel: "turnover branch" },
];

const jobsFor = (threads, statuses) => new Map(threads.map((th, i) => [th, { status: statuses[i] || "running" }]));

// Two threads is the photographed case: the first run failed (EXITED, with its re-attach press) and the second
// is going (RUNNING). Three threads adds one more to prove the rule is a column and not a pair. `provenance` is the
// per-agent case: two recorded trees in two projects, and one thread nobody recorded a tree for.
const FIXTURES = {
  two: { task: task(371, TWO), jobs: jobsFor(TWO, ["failed", "running"]) },
  three: { task: task(372, THREE), jobs: jobsFor(THREE, ["failed", "running", "done"]) },
  one: { task: task(373, ONE), jobs: jobsFor(ONE, ["running"]) },
  compact: { task: task(374, ONE), jobs: jobsFor(ONE, ["running"]) },
  provenance: {
    task: task(375, [PROV_A, PROV_B, PROV_NONE], {
      project: PROJECT,
      worktree: TREE_A,
      threadTrees: { [PROV_A]: { path: TREE_A, project: PROJECT }, [PROV_B]: { path: TREE_B, project: "poc-guidelines" } },
    }),
    jobs: jobsFor([PROV_A, PROV_B, PROV_NONE], ["done", "running", "failed"]),
  },
};

// ---- the page: the shipped stylesheets, the shipped markup, nothing else --------------------------------------
// The order public/index.html loads them, because that order is the cascade the page really paints.
const SHEETS = ["style.css", "chart.css", "core/pipeline-card.css", "core/task-card.css"];

function pageHtml(renderer, decorated) {
  const css = SHEETS.map((rel) => readFileSync(path.join(ROOT, "public", rel), "utf8")).join("\n");
  const card = (mode) => renderer.taskCardHtml(decorated[mode], mode === "compact" ? "compact" : "full", {
    own: "assistant-1",
    jobs: FIXTURES[mode].jobs,
    byId: new Map(),
    alerts: [],
  });
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style>
<style>
  /* The two panes the cards really live in, at a known width so every number below is comparable run to run.
     The Initiatives pane is wide enough for the compact card's own single line, which is the state this gate
     pins: at 520 px the WHOLE line already wraps in the shipped build, and a wrap is not what "unchanged" is
     about. */
  #qpane { width: ${WIDE}px; }
  #qpane-narrow { width: ${NARROW}px; }
  #inits { width: 760px; }
</style></head>
<body>
  <div id="qpane" class="as-group as-qpane">${card("two")}${card("three")}${card("one")}${card("provenance")}</div>
  <div id="qpane-narrow" class="as-group as-qpane">${card("two")}</div>
  <div id="as-initiatives"><div class="init-tasks" id="inits">${card("compact")}</div></div>
</body></html>`;
}

// ---- the measurement, in the page ---------------------------------------------------------------------------
function measureInPage() {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const read = (paneSel, cardSel) => {
    const pane = document.querySelector(paneSel);
    const card = pane.querySelector(cardSel);
    if (!card) return null;
    const facts = card.querySelector(".as-task-facts");
    const agents = [...facts.querySelectorAll(".as-task-agent")];
    // A row forced to the full width still has a CONTENT width: its children's own widths plus the row's gaps,
    // taken without the auto margins that push a pill to the right edge. That is what says the two rows would
    // have fitted side by side and the stack is a rule rather than a wrap.
    const agentBox = (el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const kids = [...el.children];
      const gap = parseFloat(style.columnGap) || 0;
      const contentWidth = kids.reduce((sum, ch) => sum + ch.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
      // How far the state pill sits from the row it belongs to: the row is full width now, and a pill pushed to the
      // far edge of a wide card would describe a thread hundreds of pixels away from it.
      const pill = el.querySelector(".pill");
      const pillAt = pill ? kids.indexOf(pill) : -1;
      const prev = pillAt > 0 ? kids[pillAt - 1] : null;
      const pillGap = pill && prev ? pill.getBoundingClientRect().left - prev.getBoundingClientRect().right : null;
      // The per-agent provenance sentence, if this line carries one, and the band it draws in.
      const whereEl = el.querySelector(".as-task-agent-where");
      const whereRect = whereEl ? whereEl.getBoundingClientRect() : null;
      return {
        ...rect(el),
        contentWidth,
        pillGap,
        pillText: pill ? pill.textContent.trim() : "",
        where: whereEl ? whereEl.textContent.trim() : null,
        whereTop: whereRect ? whereRect.top : null,
        whereBottom: whereRect ? whereRect.bottom : null,
      };
    };
    const meta = facts.querySelector(".as-task-meta");
    // The pipeline chip: is it a block of its own, a SIBLING of the facts line, or still a child of it?
    const pipeline = card.querySelector(".as-task-pipeline-row");
    const pipelineInFacts = facts.querySelector(".as-task-pipeline");
    const when = facts.querySelector(".as-task-when");
    const parent = agents[0] ? agents[0].parentElement : null;
    const style = parent ? getComputedStyle(parent) : null;
    return {
      card: rect(card),
      facts: rect(facts),
      agents: agents.map(agentBox),
      meta: meta ? rect(meta) : null,
      pipeline: pipeline ? { ...rect(pipeline), parentIsBody: pipeline.parentElement === card.querySelector(".as-task-body"), afterFacts: pipeline.previousElementSibling === facts, kids: [...pipeline.children].map((ch) => ({ cls: String(ch.className), h: ch.getBoundingClientRect().height, w: ch.getBoundingClientRect().width })) } : null,
      pipelineInFacts: Boolean(pipelineInFacts),
      pipelineText: pipeline ? pipeline.textContent.trim() : "",
      when: when ? rect(when) : null,
      metaText: meta ? meta.textContent.trim() : "",
      // The block the agents share: who it is, and the computed properties the ask names.
      block: parent
        ? {
            shell: parent.classList.contains("as-task-facts"),
            parentIsFacts: parent !== facts && parent.parentElement === facts,
            isFacts: parent === facts,
            display: style.display,
            direction: style.flexDirection,
            marginLeft: style.marginLeft,
            marginTop: style.marginTop,
            gap: style.gap,
            count: agents.length,
          }
        : null,
    };
  };
  return {
    two: read("#qpane", '[data-as-qrow="371"]'),
    three: read("#qpane", '[data-as-qrow="372"]'),
    one: read("#qpane", '[data-as-qrow="373"]'),
    provenance: read("#qpane", '[data-as-qrow="375"]'),
    narrow: read("#qpane-narrow", '[data-as-qrow="371"]'),
    compact: read("#as-initiatives", '[data-as-qrow="374"]'),
  };
}

// ---- the run -----------------------------------------------------------------------------------------------
const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the queue card's agent rows", "no Playwright install found (set PANEL_PLAYWRIGHT_ROOT)"));
  process.exit(2);
}

const renderer = cardsFromSource();
// THE READ'S OWN DECORATION, not a hand-built `row`: the queue pane renders whatever `decorateTasks` attached to
// the task (lib/assistant/queue.js), so the fixtures go through it too. `isLive` is true here because this gate is
// about layout - a fixture that reads STALE would be making the liveness gate's claim, not this one.
const { decorateTasks } = await import(pathToFileURL(path.join(ROOT, "lib", "assistant", "queue.js")).href);
const normPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const rowsByPath = new Map(ROWS.map((r) => [normPath(r.path), r]));
const rowFor = (t) => rowsByPath.get(normPath(t?.worktree)) || null;
const decorated = Object.fromEntries(
  Object.entries(FIXTURES).map(([mode, f]) => [mode, decorateTasks([f.task], { rowFor, isLive: () => true, jobs: null })[0]]),
);
const html = pageHtml(renderer, decorated);

await withBrowser(async ({ page, pageErrors, consoleErrors }) => {
  await page.setContent(html, { waitUntil: "load" });
  const measured = await page.evaluate(measureInPage);
  ledger.cases = measured;

  for (const name of Object.keys(measured)) {
    const c = measured[name];
    if (!c) {
      check(false, `${name}: the card rendered`, "no .as-task in the pane");
      return;
    }
    note(
      `${name}: ${c.agents.length} agent row(s), facts ${round(c.facts.width)} px wide, ` +
        `tops ${c.agents.map((a) => round(a.top - c.card.top)).join(" / ")} px from the card top, ` +
        `lefts ${c.agents.map((a) => round(a.left)).join(" / ")}`,
    );
  }

  const two = measured.two;
  const three = measured.three;
  const one = measured.one;
  const narrow = measured.narrow;
  const compact = measured.compact;

  // ---- the two-thread card: stacked, left-equal, full width, meta after them --------------------------------
  check(two.agents.length === 2, "two threads draw two agent rows", `${two.agents.length}`);
  if (two.agents.length === 2) {
    const [a, b] = two.agents;
    check(Math.abs(a.left - b.left) <= 0.5, "two agents share one left edge", `${round(a.left)} vs ${round(b.left)}`);
    check(
      b.top - a.top >= a.height - 0.5,
      "two agents are a whole line apart",
      `tops ${round(a.top)} / ${round(b.top)}, row ${round(a.height)} px`,
    );
    check(
      Math.abs(a.width - two.facts.width) <= 0.5 && Math.abs(b.width - two.facts.width) <= 0.5,
      "each agent div is the full width of the facts block",
      `${round(a.width)} / ${round(b.width)} vs facts ${round(two.facts.width)}`,
    );
    check(Math.abs(a.left - two.facts.left) <= 0.5, "no horizontal indent on the agent block", `${round(a.left)} vs ${round(two.facts.left)}`);
    check(Boolean(two.meta), "the meta line is on the two-thread card");
    if (two.meta) {
      check(two.meta.top >= b.bottom - 0.5, "the meta text draws below the last agent", `meta top ${round(two.meta.top)}, agent bottom ${round(b.bottom)}`);
      check(two.meta.top > b.top + 0.5, "the meta text is not on the agents' line", `${round(two.meta.top)} > ${round(b.top)}`);
      check(/project agent-worktree-gui/.test(two.metaText), "the meta line still names the project", JSON.stringify(two.metaText));
      check(Math.abs(two.meta.left - two.facts.left) <= 0.5, "the meta keeps the facts line's own indent", `${round(two.meta.left)}`);
    }
    check(
      Boolean(two.block) && two.block.parentIsFacts && !two.block.isFacts,
      "the two agents share one block of their own, a child of the facts line",
      JSON.stringify(two.block),
    );
    check(two.block?.display === "flex" && two.block?.direction === "column", "that block is a column", JSON.stringify(two.block));
    check(two.block?.marginLeft === "0px", "that block carries no horizontal indent of its own", two.block?.marginLeft);
    // Each pill names its own thread's run. A full-width row with the pill's own `margin-left: auto` would put the
    // EXITED chip at the card's far edge, far from the thread it describes, so the row must stay a packed line.
    check(
      two.agents.every((a) => a.pillGap != null && a.pillGap <= 12),
      "each state pill stays beside its own thread",
      two.agents.map((a) => `${a.pillText} ${round(a.pillGap)} px from the row before it`).join(" | "),
    );
    // 265 + 262 + an 8 px gap is nowhere near 976: the two rows WOULD sit side by side as flex siblings, so a
    // stack here is the rule working, not the pane being too narrow.
    check(
      two.agents[0].contentWidth + two.agents[1].contentWidth + 8 <= two.facts.width,
      "the two rows would still fit side by side, so the stack is deliberate and not a wrap",
      `contents ~${round(two.agents[0].contentWidth)} + ${round(two.agents[1].contentWidth)} px in a ${round(two.facts.width)} px line`,
    );
  }

  // ---- the pipeline chip is a task-level row of its own ------------------------------------------------------
  const pipelineChecks = (name, c) => {
    check(Boolean(c.pipeline) && c.pipeline.parentIsBody === true && c.pipeline.afterFacts === true, `${name}: the pipeline chip is a row of its own, a sibling of the facts block`, JSON.stringify(c.pipeline));
    check(c.pipelineInFacts === false, `${name}: the facts block no longer holds the pipeline chip`, `${c.pipelineInFacts}`);
    check(
      Boolean(c.pipeline) && Boolean(c.meta) && c.pipeline.top >= c.meta.bottom - 0.5,
      `${name}: the pipeline row draws under the meta line`,
      c.pipeline && c.meta ? `pipeline top ${round(c.pipeline.top)}, meta bottom ${round(c.meta.bottom)}` : "no pipeline or meta",
    );
  };
  pipelineChecks("two threads", two);
  pipelineChecks("three threads", three);
  check(Boolean(one.pipeline) && one.pipeline.top >= one.facts.bottom - 0.5, "one thread: the pipeline row draws under the facts block", one.pipeline ? `pipeline top ${round(one.pipeline.top)}, facts bottom ${round(one.facts.bottom)}` : "no pipeline");
  check(/assistant decides/.test(two.pipelineText || ""), "the pipeline row carries the task's own answer", JSON.stringify(two.pipelineText || ""));

  // ---- whose project, whose landing: the per-agent line ------------------------------------------------------
  const prov = measured.provenance;
  check(prov.agents.length === 3, "the provenance card draws three agent rows", `${prov.agents.length}`);
  if (prov.agents.length === 3) {
    const [a, b, c] = prov.agents;
    check(
      /project agent-worktree-gui/.test(a.where || "") && /UNMERGED \(2 commits\)/.test(a.where || ""),
      "the first agent's line names its own project and landing",
      JSON.stringify(a.where),
    );
    check(
      /project poc-guidelines/.test(b.where || "") && /MERGED \(3 commits\)/.test(b.where || "") && /PR #373 open/.test(b.where || ""),
      "the second agent's line names ITS project, its landing and its PR",
      JSON.stringify(b.where),
    );
    check(Boolean(a.where) && a.where !== b.where, "the two agent lines do not repeat one project");
    check(c.where === null, "an agent whose tree was never recorded draws nothing extra", JSON.stringify(c.where));
    check(prov.meta === null, "the task-level meta line steps aside when the agent lines carry it", prov.meta ? "meta still drawn" : "absent");
    check(Math.abs(a.left - b.left) <= 0.5 && Math.abs(a.left - c.left) <= 0.5, "the provenance lines share one left edge", `${round(a.left)} / ${round(b.left)} / ${round(c.left)}`);
    check(b.top - a.top >= a.height - 0.5 && c.top - b.top >= b.height - 0.5, "and still stack one per line", `tops ${round(a.top)} / ${round(b.top)} / ${round(c.top)}`);
    check(a.whereTop !== null && a.whereTop >= a.top - 0.5 && a.whereTop < a.bottom, "the sentence draws on the agent's own line", a.whereTop === null ? "no sentence" : `${round(a.whereTop)} in ${round(a.top)}-${round(a.bottom)}`);
    check(Boolean(prov.pipeline) && prov.pipeline.top >= prov.facts.bottom - 0.5, "the pipeline row stays below the facts block", prov.pipeline ? `pipeline top ${round(prov.pipeline.top)}, facts bottom ${round(prov.facts.bottom)}` : "no pipeline");
  }

  // ---- a third agent stacks too -----------------------------------------------------------------------------
  check(three.agents.length === 3, "three threads draw three agent rows", `${three.agents.length}`);
  if (three.agents.length === 3) {
    const [a, b, c] = three.agents;
    check(Math.abs(a.left - b.left) <= 0.5 && Math.abs(a.left - c.left) <= 0.5, "three agents share one left edge", `${round(a.left)} / ${round(b.left)} / ${round(c.left)}`);
    check(b.top - a.top >= a.height - 0.5 && c.top - b.top >= b.height - 0.5, "the third agent stacks under the second", `tops ${round(a.top)} / ${round(b.top)} / ${round(c.top)}`);
    check(Boolean(three.meta) && three.meta.top >= c.bottom - 0.5, "the meta text draws below the third agent", three.meta ? `meta top ${round(three.meta.top)}, agent bottom ${round(c.bottom)}` : "no meta");
    check(
      Math.abs(three.agents[0].top - three.card.top - (two.agents[0].top - two.card.top)) <= 0.5,
      "the first agent starts on the card's own line in both cards",
      `${round(three.agents[0].top - three.card.top)} vs ${round(two.agents[0].top - two.card.top)} px below the card top`,
    );
  }

  // ---- one agent is unchanged --------------------------------------------------------------------------------
  check(one.agents.length === 1, "one thread draws one agent row", `${one.agents.length}`);
  if (one.agents.length === 1 && two.agents.length === 2) {
    const a = one.agents[0];
    check(Math.abs(a.left - one.facts.left) <= 0.5, "the single agent sits on the facts block's left edge", `${round(a.left)} vs ${round(one.facts.left)}`);
    check(Math.abs(a.top - one.facts.top) <= 0.5, "the single agent starts on the facts block's own top", `${round(a.top)} vs ${round(one.facts.top)}`);
    check(Math.abs(a.height - two.agents[0].height) <= 0.5, "the single agent's row is the same height as before (one line)", `${round(a.height)} vs ${round(two.agents[0].height)}`);
    check(a.width < one.facts.width - 10, "the single agent keeps its natural width, not a stretched one", `${round(a.width)} of ${round(one.facts.width)}`);
    // The meta span is a flex row of its own and is centred against the agent line, so "shares the line" is an
    // OVERLAP of the two bands, not an equal top.
    check(
      Boolean(one.meta) && one.meta.top < a.bottom && one.meta.bottom > a.top,
      "the single agent's meta text still shares its line",
      one.meta ? `meta ${round(one.meta.top)}-${round(one.meta.bottom)}, agent ${round(a.top)}-${round(a.bottom)}` : "no meta",
    );
  }

  // ---- the narrow pane: the stack does not depend on width ---------------------------------------------------
  check(narrow.agents.length === 2, "the narrow pane draws both agents", `${narrow.agents?.length}`);
  if (narrow.agents.length === 2) {
    check(Math.abs(narrow.agents[0].left - narrow.agents[1].left) <= 0.5, "the narrow pane keeps one left edge", `${round(narrow.agents[0].left)} / ${round(narrow.agents[1].left)}`);
    check(narrow.agents[1].top - narrow.agents[0].top >= narrow.agents[0].height - 0.5, "the narrow pane still stacks the agents", `tops ${round(narrow.agents[0].top)} / ${round(narrow.agents[1].top)}`);
  }

  // ---- the compact card's single-thread line is untouched -----------------------------------------------------
  check(compact.agents.length === 1, "the compact card draws its one thread", `${compact.agents.length}`);
  if (compact.agents.length === 1) {
    const a = compact.agents[0];
    check(compact.block?.isFacts === true, "the compact card has no wrapper of its own", JSON.stringify(compact.block));
    check(compact.facts.height <= a.height + 1, "the compact card's facts line is still one line", `facts ${round(compact.facts.height)} px, agent ${round(a.height)} px`);
    check(Math.abs(a.left - compact.facts.left) <= 0.5, "the compact agent sits on the facts block's left edge", `${round(a.left)}`);
    check(
      Boolean(compact.when) && compact.when.top < a.bottom && compact.when.bottom > a.top,
      "the compact card's time stays on the agent's line",
      compact.when ? `when ${round(compact.when.top)}-${round(compact.when.bottom)}, agent ${round(a.top)}-${round(a.bottom)}` : "no when",
    );
  }

  check(pageErrors.length === 0, "no page errors", pageErrors.join(" | "));
  check(consoleErrors.length === 0, "no console errors", consoleErrors.join(" | "));

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    for (const [name, sel] of [
      ["two-agents", "#qpane .as-task:nth-child(1)"],
      ["three-agents", "#qpane .as-task:nth-child(2)"],
      ["one-agent", "#qpane .as-task:nth-child(3)"],
      ["provenance", "#qpane .as-task:nth-child(4)"],
      ["compact", "#inits .as-task"],
    ]) {
      const el = await page.$(sel);
      if (el) await el.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    }
    console.log(`      shots: ${SHOTS}`);
  }
});

if (JSON_OUT) {
  mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify(ledger, null, 2));
  console.log(`      ledger: ${JSON_OUT}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
