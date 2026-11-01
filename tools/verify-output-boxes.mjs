// Every tool output is one folded box, and the lines of a skill type out like prose do — proved in a real browser
// against THIS checkout's public/**.
//
//   node tools/verify-output-boxes.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-output-boxes.mjs
//   WAG_SHOTS=C:/some/dir node tools/verify-output-boxes.mjs     (also write the screenshots there)
//
// WHAT IS DRIVEN
//
//   driven     a panel of its own on a spare port (never 7331: boot through tools/panel-testkit.mjs, apiServer left
//              at no key so nothing here can buy a worker) plus headless Chromium over it, on a card fabricated in
//              the page's own state (state.jobs + state.jobLines, painted by the shipped renderJobs) so every box
//              under test is a real render of real rows
//   driven     (1) every kind of result — a shell transcript, a search, a file read, a patch's diff, a skill, a
//              one-line result — drawn as exactly one box that is folded, with its header line OUTSIDE it
//   driven     (2) a real click opens a box to its full size and a second one folds it; the choice survives a repaint
//              and a burst rebuild; a diff's windows live inside the box and the header says what it adds/removes
//   driven     (3) the one-stream view (🌊) draws the same boxes folded and remembers them the same way, with the
//              card's ROW as the box's opener (one action, one box)
//   driven     (4) opening a long result's own header fetches the whole row into that SAME box, updates its count,
//              and keeps ordinary open/shut state through repaints and burst rebuilds without fetching it twice
//   driven     (5) the live path: `jobline` frames through the page's own EventSource handler. A skill's lines are
//              typed word by word (sampled part-way), data-ltext carries the whole line all along, the words/s and
//              lines/s settings both govern them, and every other tool's lines arrive whole
//
// The browser half needs a Playwright install; without one this prints BROWSER-HALF-NOT-RUN and exits non-zero rather
// than passing a half that never ran.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { startPanel } from "./panel-testkit.mjs";
import { loadPlaywright, notRun } from "./browser.mjs";

const SHOTS = process.env.WAG_SHOTS ? path.resolve(process.env.WAG_SHOTS) : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const check = (name, got, want) => {
  checks += 1;
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failures += 1;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}${same ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the fixture: one turn, one burst, every kind of result ----------------------------------------
const REPO = "C:/ProjectDevelopment/agent-worktree-gui";
const PKG = `${REPO}/package.json`;
const SKILL_BODY = Array.from({ length: 12 }, (_, i) => `${i + 1}. step ${i + 1} of the skill: read the manifest, then change one thing at a time and prove it before the next`);
const GREP_BODY = [
  "docs/using-the-board.md:263:| `UNMERGED (N commits)` | Carries `N` commits that are not on remote main. On a clean tree the badge **is a button** and opens five outcomes for that row |",
  "--- chooser mentions ---",
  "docs/using-the-board.md:297:The chooser's second outcome, **Rebase on `<parent>`**, is the one that starts no agent.",
  "docs/using-the-board.md:332:reads `UNMERGED` forever. The chooser's check outcome answers that.",
  "README.md:12:the chooser",
];
const FILE_BODY = ["{", '  "name": "agent-worktree-gui",', '  "version": "0.20.0",', '  "private": true,', '  "type": "module"', "}", ""];
const DIFF_BODY = [
  `--- a/${PKG}`,
  `+++ b/${PKG}`,
  "@@ -1,6 +1,6 @@",
  " {",
  '-  "name": "agent-worktree-gui",',
  '+  "name": "agent-worktree-gui-x",',
  '   "version": "0.20.0",',
  '-  "private": false,',
  '+  "private": true,',
  '+  "extra": 1,',
  " }",
];
const CALLS = [
  { tool: "terminal", glyph: "💻", arg: 'grep -rn "four outcomes" docs/ README.md + 1 command', header: "  ↳ terminal · 0.42s", body: GREP_BODY },
  { tool: "read_file", glyph: "📖", arg: "package.json", header: "  ↳ read_file · 0.03s", body: FILE_BODY },
  { tool: "patch", glyph: "🔧", arg: PKG, header: "  ↳ patch · 1.20s", body: DIFF_BODY },
  { tool: "skill_view", glyph: "📚", arg: "agent-worktree-gui", header: "  ↳ skill_view · 0.11s", body: SKILL_BODY },
  { tool: "memory", glyph: "🧠", arg: "add", header: "  ↳ memory · 0.01s", body: ["saved"] },
  { tool: "terminal", glyph: "💻", arg: "git status --short", header: "  ↳ terminal · 0.20s", body: [] },
];

const BROWSER_FIXTURE = ({ calls, firstText, lastText }) => {
  const probe = { store: [] };
  window.__probe = probe;
  // The turn, fabricated in the PAGE's own state and painted by the shipped renderJobs().
  probe.lines = () => {
    const lines = [{ kind: "text", text: firstText, lid: "t1" }];
    let lid = 100;
    for (const c of calls) {
      lines.push({ kind: "tool", text: `${c.glyph} ${c.tool}${c.arg ? ` · ${c.arg}` : ""}`, at: Date.now() - 90_000, lid: lid++ });
      lines.push({ kind: "tool-out", text: c.header, lid: lid++ });
      for (const text of c.body) lines.push({ kind: "tool-out", text, lid: lid++ });
    }
    lines.push({ kind: "text", text: lastText, lid: "t2" });
    return lines;
  };
  probe.show = (opts = {}) => {
    const id = opts.id || "probe-turn";
    state.jobs.clear();
    state.jobLines.clear();
    state.toolStore.clear();
    state.toolGroupOpen.clear();
    state.codeBoxOpen.clear();
    state.codeBoxShut.clear();
    state.callFolded.clear();
    state.foldRows.clear();
    state.foldPending?.clear();
    state.toolStorePending.clear();
    state.outPinned = {};
    state.maximized = id;
    state.jobLines.set(id, opts.lines || probe.lines());
    state.jobs.set(id, {
      id,
      thread: id,
      turn: 1,
      status: opts.status || "done",
      prompt: "output boxes probe",
      displayPrompt: "output boxes probe",
      cwd: null,
      worktree: false,
      worktreePath: null,
      projectPath: null,
      ownerPath: null,
      branch: null,
      runId: "run_probe",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      endedAt: opts.status === "running" ? null : new Date(Date.now() - 60_000).toISOString(),
      model: "probe/model",
      lines: [],
      artifacts: [],
      attachments: [],
      subagents: [],
    });
    renderJobs();
    if (opts.openBurst !== false) {
      for (const grp of document.querySelectorAll("pre.job-out .tgrp:not(.tgrp-flat)")) {
        const body = grp.querySelector(".tgrp-body");
        if (body && body.hidden) {
          body.hidden = false;
          rememberToolGroup(grp);
        }
      }
    }
    return document.querySelectorAll("pre.job-out .tgrp").length;
  };
};

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("verify-output-boxes", "no Playwright install found (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const panel = await startPanel({ config: { assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 } } });
  console.log(`      panel ${panel.base} (this checkout's own server.js and public/) — the live board on 7331 is not touched`);
  const browser = await playwright.chromium.launch({ headless: true });
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    await context.addInitScript(BROWSER_FIXTURE, { calls: CALLS, firstText: "looking at the board", lastText: "done" });
    await context.addInitScript(() => {
      // The page's own EventSource handler is what a real run's frames hit: capture the instances so a probe can
      // dispatch `jobline` through it, and keep the board's own sweeps from asking the (absent) gateway anything.
      window.__es = [];
      const Real = window.EventSource;
      window.EventSource = class extends Real {
        constructor(...a) {
          super(...a);
          window.__es.push(this);
        }
      };
      localStorage.setItem("wtgui.autoCollect", "0");
      // The TALLIED tool group: this probe drives the condensed card's group head, whose body is what it opens.
      // (The shipped default is one expandable line per call — Settings > Count tool calls — with no head to click.)
      localStorage.setItem("wtgui.toolGroups", "1");
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await page.goto(panel.base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof renderJobs === "function" && window.__probe, null, { timeout: 30_000 });
    const shot = async (name, selector = "pre.job-out") => {
      if (!SHOTS) return;
      const el = page.locator(selector).first();
      await el.screenshot({ path: path.join(SHOTS, name) });
    };

    // ---- (1) every result is one folded box --------------------------------------------------------------
    console.log("\n== (1) every kind of result is exactly one box, folded ==");
    const groups = await page.evaluate(() => window.__probe.show());
    ok("the card is drawn with its burst", groups >= 1, `${groups} group(s)`);
    const calls = await page.evaluate(() =>
      [...document.querySelectorAll("pre.job-out .call")].map((c) => ({
        head: c.querySelector(".call-head .jl")?.dataset.ltext || "",
        boxes: c.querySelectorAll(".code-box").length,
        folded: [...c.querySelectorAll(".code-box")].every((b) => b.querySelector(".code-body").hidden && b.querySelector(".code-head").getAttribute("aria-expanded") === "false"),
        headerOutside: [...c.querySelectorAll(".jl-tool-out")].filter((j) => /^\s*↳/.test(j.dataset.ltext) && j.closest(".code-box")).length === 0,
        what: c.querySelector(".code-what")?.textContent || "",
        n: c.querySelector(".code-n")?.textContent || "",
        delta: c.querySelector(".code-delta")?.textContent || "",
        hint: c.querySelector(".code-hint")?.textContent || "",
      })),
    );
    console.log(`      ${JSON.stringify(calls.map((c) => [c.what, c.n, c.delta]))}`);
    check("every call that returned output has one box", calls.map((c) => c.boxes), [1, 1, 1, 1, 1, 0]);
    ok("every box is folded and its body hidden", calls.filter((c) => c.boxes).every((c) => c.folded));
    ok("the result's own header line is never inside a box", calls.every((c) => c.headerOutside));
    check("each box names its tool", calls.filter((c) => c.boxes).map((c) => c.what), [
      "terminal output",
      "read_file · package.json",
      "patch · …/ProjectDevelopment/agent-worktree-gui/package.json",
      "skill_view output",
      "memory output",
    ]);
    check("each box counts its lines", calls.filter((c) => c.boxes).map((c) => c.n), ["5 lines", "7 lines", "11 lines", "12 lines", "1 line"]);
    check("a diff says what it adds and removes in its header", calls[2].delta, "+3\u22122");
    ok("a closed box invites the click", calls.filter((c) => c.boxes).every((c) => c.hint === "click to read"));
    await shot("01-folded.png");

    await page.evaluate(() => window.__probe.show());
    // ---- (2) a real click ---------------------------------------------------------------------------------
    console.log("\n== (2) a click opens a box to its full size ==");
    const heads = page.locator("pre.job-out .code-head");
    await heads.nth(0).click();
    let st = await page.evaluate(() => {
      const b = document.querySelector("pre.job-out .code-box");
      const body = b.querySelector(".code-body");
      return {
        open: !body.hidden,
        cls: b.classList.contains("is-open"),
        expanded: b.querySelector(".code-head").getAttribute("aria-expanded"),
        caret: b.querySelector(".code-caret").textContent,
        hint: b.querySelector(".code-hint").textContent,
        rows: [...body.querySelectorAll(".jl")].map((j) => j.textContent),
        full: body.scrollHeight <= body.clientHeight + 1,
        h: Math.round(body.getBoundingClientRect().height),
      };
    });
    ok("the box is open", st.open && st.cls && st.expanded === "true" && st.caret === "▾", JSON.stringify({ caret: st.caret, expanded: st.expanded }));
    check("an open box says it folds", st.hint, "click to fold");
    check("it shows every line of the result, whole", st.rows, [
      ...GREP_BODY,
    ]);
    ok("at its full size: no scroll inside the box", st.full, `${st.h}px`);
    await shot("02-terminal-open.png");
    await heads.nth(2).click();
    await shot("03-diff-open.png");
    const diff = await page.evaluate(() => {
      const b = document.querySelectorAll("pre.job-out .code-box")[2];
      return {
        wins: b.querySelectorAll(".df-win").length,
        winBorder: getComputedStyle(b.querySelector(".df-win")).borderTopWidth,
        frame: getComputedStyle(b).borderTopWidth,
        rows: b.querySelectorAll(".df-row").length,
        outer: [...document.querySelectorAll("pre.job-out .df-win")].filter((w) => !w.closest(".code-box")).length,
        open: !b.querySelector(".code-body").hidden,
      };
    });
    ok("the diff's window is inside the box, which is the only frame", diff.wins === 1 && diff.outer === 0 && diff.frame === "1px" && diff.winBorder === "0px", JSON.stringify(diff));

    // ---- remembered across a repaint and a rebuild --------------------------------------------------------
    const state1 = () =>
      page.evaluate(() => [...document.querySelectorAll("pre.job-out .code-box")].map((b) => !b.querySelector(".code-body").hidden));
    check("two opened, the rest still folded", await state1(), [true, false, true, false, false]);
    await page.evaluate(() => renderJobs());
    check("a repaint keeps them", await state1(), [true, false, true, false, false]);
    await page.evaluate(() => {
      const grp = document.querySelector("pre.job-out .tgrp");
      rebuildToolGroup(grp, { filter: "", open: true });
    });
    check("a burst rebuild keeps them", await state1(), [true, false, true, false, false]);
    await heads.nth(0).click();
    check("a second click folds it", await state1(), [false, false, true, false, false]);
    await page.evaluate(() => renderJobs());
    check("and a repaint keeps it folded", await state1(), [false, false, true, false, false]);

    // ---- (3) the one-stream view -------------------------------------------------------------------------
    console.log("\n== (3) the one-stream view draws the same boxes, folded ==");
    await page.evaluate(() => localStorage.setItem("wtgui.stream.probe-turn", "1"));
    const flat = await page.evaluate(() => {
      window.__probe.show();
      return {
        flat: document.querySelectorAll("pre.job-out .tgrp-flat").length,
        boxes: [...document.querySelectorAll("pre.job-out .code-box")].map((b) => !b.querySelector(".code-body").hidden),
      };
    });
    ok("the card is drawn as a stream", flat.flat > 0, `${flat.flat} flat piece(s)`);
    check("a stream's boxes start folded too", flat.boxes, [false, false, false, false, false]);
    await shot("04-stream-folded.png");
    // In the stream a call is a ROW, and the row is the box's opener: the box behind it is the same console box the
    // condensed view draws, so a press on the row opens it whole — one action, one box — while the header inside it
    // still folds that box on its own (the case (2) above drives). A press on the header alone is not reachable here:
    // the box is behind a shut row.
    const rows = page.locator("pre.job-out .tgrp-call > .tgrp-row");
    ok("the stream draws one row per call", (await rows.count()) === CALLS.length, `${await rows.count()} row(s) for ${CALLS.length} call(s)`);
    await rows.nth(1).click();
    const opened = await page.evaluate(() => {
      const box = document.querySelectorAll("pre.job-out .code-box")[1];
      return { open: box ? !box.querySelector(".code-body").hidden : null, head: box ? box.querySelector(".code-head")?.getAttribute("aria-expanded") : null };
    });
    ok("a row opens the box behind it whole", opened.open === true && opened.head === "true", JSON.stringify(opened));
    await page.evaluate(() => renderJobs());
    check("a stream remembers the box the reader opened", await state1(), [false, true, false, false, false]);
    await page.evaluate(() => localStorage.removeItem("wtgui.stream.probe-turn"));

    // ---- (4) one box, one real header click, and an uncapped row in place -------------------------------
    console.log("\n== (4) a long result opens completely in its original box ==");
    const big = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of a result the card only kept the head of`);
    const fullReads = [];
    const resultRoute = async (route) => {
      const q = new URL(route.request().url()).searchParams;
      if (q.get("thread") !== "probe-turn" || q.get("tool") !== "terminal") return route.continue();
      if (q.get("full") === "1") fullReads.push(Object.fromEntries(q));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ thread: "probe-turn", tool: "terminal", results: [{ text: big.join("\n"), truncated: false }] }),
      });
    };
    await page.route("**/api/tool-results?**", resultRoute);
    await page.evaluate((body) => {
      const lines = [
        { kind: "tool", text: "💻 terminal · cat big.log", at: Date.now() - 5000, lid: 900 },
        { kind: "tool-out", text: "  ↳ terminal · 0.30s", lid: 901 },
        ...body.slice(0, 40).map((text, i) => ({ kind: "tool-out", text, lid: 902 + i })),
        { kind: "tool-out", text: "… 20 lines hidden — click to read", lid: 960, fold: { tool: "terminal", row: 0 } },
      ];
      window.__probe.show({ lines });
      window.__probe.longLines = JSON.stringify(state.jobLines.get("probe-turn"));
      window.__probe.longBox = () => {
        const pre = document.querySelector('pre.job-out[data-out="probe-turn"]');
        const boxes = [...pre.querySelectorAll(".code-box")];
        const b = boxes[0];
        const h = b?.querySelector(".code-head");
        return {
          boxes: boxes.length,
          what: h?.querySelector(".code-what")?.textContent || "",
          n: h?.querySelector(".code-n")?.textContent || "",
          open: b ? !b.querySelector(".code-body").hidden : false,
          expanded: h?.getAttribute("aria-expanded"),
          key: h?.dataset.codeKey || "",
          codeFold: h?.dataset.codeFold || "",
          fetch: h?.dataset.toolFold || "",
          identity: [h?.dataset.foldTurn || "", h?.dataset.foldTool || "", h?.dataset.foldRow || ""],
          inverted: h?.dataset.codeInverted || "",
          rows: [...(b?.querySelectorAll(".code-body .jl") || [])].map((r) => r.dataset.ltext ?? r.textContent),
          output: [...pre.querySelectorAll(".jl[data-ltext]")].filter((r) => r.getClientRects().length > 0).map((r) => r.dataset.ltext),
          footers: pre.querySelectorAll(".fold-read").length,
          externalNotes: [...pre.querySelectorAll(".jl-fold")].filter((r) => !r.closest(".code-box") && !r.hidden).length,
          linesUnchanged: JSON.stringify(state.jobLines.get("probe-turn")) === window.__probe.longLines,
          held: state.foldRows.size,
        };
      };
    }, big);
    const readLong = () => page.evaluate(() => window.__probe.longBox());
    const longHead = page.locator('pre.job-out[data-out="probe-turn"] .code-head').first();
    const beforeLong = await readLong();
    check("a long result starts as one folded box counting retained and total lines", [beforeLong.boxes, beforeLong.open, beforeLong.expanded, beforeLong.n], [1, false, "false", "40 of 60 lines"]);
    check("its header carries both the fetch identity and the ordinary fold control", [beforeLong.identity, beforeLong.fetch, beforeLong.codeFold], [["probe-turn", "terminal", "0"], "1", "1"]);
    ok("the original box has an ordinary non-inverted state key", beforeLong.key !== "" && beforeLong.inverted !== "1");
    check("there is no separate hidden-lines footer or link", [beforeLong.footers, beforeLong.externalNotes], [0, 0]);
    check("nothing is preloaded in the full-row cache", [beforeLong.held, fullReads.length], [0, 0]);
    await longHead.click();
    const loaded = await page.waitForFunction(() => window.__probe.longBox().held === 1, null, { timeout: 4000 }).then(() => true, (e) => {
      if (e.name !== "TimeoutError") throw e;
      return false;
    });
    ok("the first actual header click loaded the full stored row", loaded);
    const whole = await readLong();
    check("one click asks for exactly one uncapped row", fullReads.map((q) => [q.thread, q.tool, q.row, q.full, q.n]), [["probe-turn", "terminal", "0", "1", "1"]]);
    check("the same logical header now opens one 60-line box", [whole.boxes, whole.key, whole.n, whole.open, whole.expanded], [1, beforeLong.key, "60 lines", true, "true"]);
    check("the loaded header keeps its identity but no longer fetches", [whole.identity, whole.fetch, whole.codeFold, whole.inverted], [["probe-turn", "terminal", "0"], "", "1", ""]);
    ok("every full-result line appears exactly once, without a second preview copy", JSON.stringify(whole.rows) === JSON.stringify(big) && big.every((text) => whole.output.filter((t) => t === text).length === 1), `${whole.rows.length} rows for ${big.length} lines`);
    ok("the input jobLines, including the original fold stamp, are byte-for-byte unchanged", whole.linesUnchanged);
    check("there is still no separate footer after loading", [whole.footers, whole.externalNotes], [0, 0]);
    await shot("04b-long-result-open.png");
    await page.evaluate(() => {
      renderJobs();
      const grp = document.querySelector("pre.job-out .tgrp");
      if (grp) rebuildToolGroup(grp, { filter: "", open: true });
    });
    let remembered = await readLong();
    check("a repaint and a DOM-backed burst rebuild preserve the opened original box", [remembered.boxes, remembered.open, remembered.n, remembered.key], [1, true, "60 lines", beforeLong.key]);
    await longHead.click();
    await page.evaluate(() => {
      renderJobs();
      const grp = document.querySelector("pre.job-out .tgrp");
      if (grp) rebuildToolGroup(grp, { filter: "", open: true });
    });
    remembered = await readLong();
    check("shutting that same box is remembered without inverting its state", [remembered.boxes, remembered.open, remembered.expanded, remembered.inverted], [1, false, "false", ""]);
    await longHead.click();
    remembered = await readLong();
    ok("reopening shows the cached full result once", remembered.open && JSON.stringify(remembered.rows) === JSON.stringify(big) && big.every((text) => remembered.output.filter((t) => t === text).length === 1));
    check("close/reopen and rebuilding never repeat the full-row fetch", fullReads.length, 1);
    ok("all the original input lines remain untouched", remembered.linesUnchanged);
    await page.unroute("**/api/tool-results?**", resultRoute);

    ok("no page errors so far", pageErrors.length === 0, JSON.stringify(pageErrors));

    // ---- (5) the live path: a skill is written, every other result arrives whole -----------------------
    console.log("\n== (5) a skill's lines are typed out like prose; other results are drawn whole ==");
    const SKILL_LINES = Array.from({ length: 6 }, (_, i) => `step ${i + 1} read the manifest then change one thing at a time and prove it before the next step is taken here`);
    const live = await page.evaluate(
      ({ skillLines }) => {
        const id = "probe-turn";
        const lines = [
          { kind: "text", text: "loading the skill", lid: "t1" },
          { kind: "tool", text: "📚 skill_view · agent-worktree-gui", at: Date.now(), lid: 700 },
          { kind: "tool-out", text: "  ↳ skill_view · 0.11s", lid: 701 },
        ];
        window.__probe.show({ id, status: "running", lines });
        saveTypeWords(20);
        saveTypeLines(0);
        // Open the box the lines will land in: nothing about typing depends on it, but a reader watching a skill
        // arrive has it open, and the rows are then really on screen.
        const es = window.__es[0];
        const send = (line) => es.dispatchEvent(new MessageEvent("jobline", { data: JSON.stringify({ id, line }) }));
        window.__probe.send = send;
        skillLines.forEach((text, i) => send({ kind: "tool-out", text, lid: 710 + i }));
        const rows = () => [...document.querySelectorAll(`pre.job-out[data-out="${id}"] .code-box .jl[data-lid]`)];
        window.__probe.sample = () => ({
          shown: rows().map((r) => r.textContent.length),
          whole: rows().map((r) => (r.dataset.ltext || "").length),
          boxes: document.querySelectorAll(`pre.job-out[data-out="${id}"] .code-box`).length,
          open: [...document.querySelectorAll(`pre.job-out[data-out="${id}"] .code-box`)].map((b) => !b.querySelector(".code-body").hidden),
          count: document.querySelector(`pre.job-out[data-out="${id}"] .code-n`)?.textContent || "",
        });
        return window.__probe.sample();
      },
      { skillLines: SKILL_LINES },
    );
    const samples = [live];
    for (const wait of [250, 500, 1200, 2500]) {
      await sleep(wait);
      samples.push(await page.evaluate(() => window.__probe.sample()));
    }
    console.log(`      shown/whole at each sample: ${samples.map((s) => `${s.shown.reduce((a, b) => a + b, 0)}/${s.whole.reduce((a, b) => a + b, 0)}`).join("  ")}`);
    const wholeLen = SKILL_LINES.join("").length;
    ok("the box exists as soon as the first line lands, and is folded", live.boxes === 1 && live.open[0] === false, JSON.stringify({ boxes: live.boxes, open: live.open }));
    ok("data-ltext carries the whole line from the first paint", samples.every((s) => s.whole.length === 6 && s.whole.every((w) => w === SKILL_LINES[0].length)), JSON.stringify(live.whole));
    ok("at the first paint the lines are NOT whole yet", live.shown.reduce((a, b) => a + b, 0) < wholeLen / 2, `${live.shown.reduce((a, b) => a + b, 0)} of ${wholeLen} chars`);
    const mids = samples.filter((s) => { const t = s.shown.reduce((a, b) => a + b, 0); return t > 0 && t < wholeLen; });
    ok("part-way samples exist: the words arrive over time", mids.length >= 1, `${mids.length} part-way sample(s)`);
    const totals = samples.map((s) => s.shown.reduce((a, b) => a + b, 0));
    ok("what is shown only ever grows", totals.every((t, i) => i === 0 || t >= totals[i - 1]), JSON.stringify(totals));
    check("and ends as the whole result", samples[samples.length - 1].shown, SKILL_LINES.map((l) => l.length));
    await shot("05-skill-typed.png");

    // another tool's result in the same console arrives whole at once
    const other = await page.evaluate(() => {
      const send = window.__probe.send;
      send({ kind: "tool", text: "💻 terminal · ls", at: Date.now(), lid: 800 });
      send({ kind: "tool-out", text: "  ↳ terminal · 0.01s", lid: 801 });
      const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
      send({ kind: "tool-out", text, lid: 802 });
      const row = document.querySelector('pre.job-out[data-out="probe-turn"] .jl[data-lid="802"]');
      return { shown: row ? row.textContent : null, whole: text };
    });
    check("another tool's result is drawn whole, at once", other.shown, other.whole);

    // lines per second: the gate holds the skill's lines and lets them in at the reader's rate
    const gate = await page.evaluate(() => {
      const id = "probe-turn";
      saveTypeWords(0);
      saveTypeLines(4);
      const rows = () => document.querySelectorAll(`pre.job-out[data-out="${id}"] .jl[data-lid^="9"]`).length;
      window.__probe.rowsAt9 = rows;
      window.__probe.send({ kind: "tool", text: "📚 skills_list", at: Date.now(), lid: 899 });
      window.__probe.send({ kind: "tool-out", text: "  ↳ skills_list · 0.02s", lid: 900 });
      for (let i = 0; i < 8; i++) window.__probe.send({ kind: "tool-out", text: `category ${i}`, lid: 901 + i });
      return { at0: rows(), held: state.typeGate.queued() };
    });
    const gateSamples = [gate.at0];
    for (const wait of [500, 700, 2000]) {
      await sleep(wait);
      gateSamples.push(await page.evaluate(() => window.__probe.rowsAt9()));
    }
    console.log(`      rows in the console at 0/0.5/1.2/3.2 s: ${JSON.stringify(gateSamples)} (8 lines + header at 4 lines/s)`);
    ok("the gate holds the burst at the first paint", gate.held > 0 && gateSamples[0] < 9, JSON.stringify(gate));
    ok("the lines walk in over time: some are in part-way, not all of them", gateSamples[2] > 0 && gateSamples[2] < 9 && gateSamples[1] <= gateSamples[2], JSON.stringify(gateSamples));
    ok("and all of them are in by the end", gateSamples[3] === 9, JSON.stringify(gateSamples));

    // the turn settling releases whatever is still held
    const flush = await page.evaluate(() => {
      const id = "probe-turn";
      saveTypeWords(5);
      saveTypeLines(0);
      window.__probe.send({ kind: "tool", text: "📚 skill_view · another", at: Date.now(), lid: 950 });
      window.__probe.send({ kind: "tool-out", text: "  ↳ skill_view · 0.02s", lid: 951 });
      const text = "one two three four five six seven eight nine ten eleven twelve";
      window.__probe.send({ kind: "tool-out", text, lid: 952 });
      const row = () => document.querySelector(`pre.job-out[data-out="${id}"] .jl[data-lid="952"]`).textContent;
      const before = row();
      window.__probe.send({ kind: "result", text: "run completed", lid: 953 });
      return { before, after: row(), whole: text };
    });
    ok("at 5 words/s a line is far from done at once", flush.before.length < flush.whole.length / 2, JSON.stringify(flush.before));
    check("the turn's end flushes it whole — nothing is left in the buffer", flush.after, flush.whole);

    // a hidden tab shows no flow
    const hidden = await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      saveTypeWords(5);
      window.__probe.send({ kind: "tool", text: "📚 skill_view · hidden", at: Date.now(), lid: 960 });
      window.__probe.send({ kind: "tool-out", text: "  ↳ skill_view · 0.02s", lid: 961 });
      const text = "one two three four five six seven eight nine ten";
      window.__probe.send({ kind: "tool-out", text, lid: 962 });
      const row = document.querySelector('pre.job-out[data-out="probe-turn"] .jl[data-lid="962"]');
      delete document.hidden;
      return { shown: row ? row.textContent : null, whole: text };
    });
    check("a background tab draws a skill whole", hidden.shown, hidden.whole);

    ok("no page errors anywhere in this run", pageErrors.length === 0, JSON.stringify(pageErrors));
  } finally {
    await browser.close().catch(() => {});
    await panel.stop();
  }
  console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
