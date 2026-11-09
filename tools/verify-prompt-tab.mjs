#!/usr/bin/env node
// Settings > Prompt, driven in a real Chromium and photographed at the window's default width.
//
//   node tools/verify-prompt-tab.mjs
//   node tools/verify-prompt-tab.mjs --out docs/assets/prompt-tab/prompt-tab.png
//   node tools/verify-prompt-tab.mjs --root <a git archive export>   # shoot another build
//
// WHAT THIS PROVES. The tab is a picture of the prompt the panel would build, so the picture has to agree
// with the route that measured it: three diagrams (the first turn of a session, an ordinary turn, the
// fourth wake), each with the standing sections and the three moving ones, each box labelled with its
// characters and its share, and the plan's caps named. The fixture is a throwaway panel with a charter,
// eight rules, a scratchpad, four watches, five queued tasks and four live worker runs, so no box is
// drawn from an empty store.
//
// THE FRAME is 340 x 1580 CSS px: 340 is the settings window's own default width (.settings in
// public/style.css), which is the width this tab is read at; the height is taller than the 520px
// default only so all three diagrams are in one picture. The screenshot is the window, not the page.
//
// RED PROOF: a tree without the tab has no [data-settings-tab="prompt"] and no #prompt-diagrams; the
// first case says so and exits 1 rather than timing out on a click. A tree WITH the tab but without the
// route answers a 404, and the check for the route's totals fails.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const OUT = path.resolve(opt("--out", path.join(TREE, "docs", "assets", "prompt-tab", "prompt-tab.png")));
const VIEWPORT = { width: 1400, height: 3000 };
// The window's default width (the stylesheet's own `.settings { width: 340px }`), and enough height to
// hold all three diagrams. The height is not the default; the width is.
const RECT = { x: 16, y: 74, w: 340, h: 2300 };

const CHARTER = [
  "# Assistant charter - the long tier",
  "",
  "## Why the panel keeps a charter",
  "A standing rule is one sentence the reader decided once. The reasoning behind it - why a deploy is",
  "DEV only, why a branch cut from master is the only one that gets pushed, what a previous incident",
  "taught about reading a quiet build as a passed one - does not fit in a rule and must survive a",
  "compaction. It rides in full on the first turn of a session, on a byte change and every twentieth",
  "turn; the other turns carry a marker naming its sha.",
  "",
  "## What belongs here",
  "- a precedent: the review that found the real defect was the one that read the branch, not the diff;",
  "- a repository's history: the tree that was deleted while a run still held it, and what that cost;",
  "- an open question, dated: whether a pipeline cap park should wake the reader or the assistant.",
  "",
  "The rules are the answers. This file is the reasoning behind them, and the notes are what the",
  "assistant noticed this week. None of the three repeats another: a frozen copy of a rule here is a",
  "second answer that drifts from the store.",
  "",
  "## How it is pruned",
  "The oldest changelog entries go first when the file passes 20,000 characters. Prose above the",
  "changelog heading is the reader's and is never pruned. An entry written by a turn is dated when it",
  "lands, so a later reader can tell what was known when.",
].join("\n");
const CHARTER_BODY = CHARTER + "\n\n" + Array.from({ length: 110 }, (_, i) =>
  `- entry ${String(i + 1).padStart(3, "0")}: a precedent worth keeping, written down so the next turn does not have to rediscover it, and pruned oldest-first when the cap is reached.`,
).join("\n");

function seed(dir) {
  const logs = path.join(dir, "logs");
  mkdirSync(path.join(logs, "assistants", "assistant-1"), { recursive: true });
  const rule = (n, by, body) => ({ id: `r${n}`, text: body, at: new Date(Date.now() - n * 1000).toISOString(), by });
  const rules = [
    rule(1, "reader", "Deploy only to DEV, and only the WAR whose bundled jars changed. Never PROD."),
    rule(2, "reader", "One turnover branch per feature, cut from master; worker branches are rolled back into it locally and never pushed."),
    rule(3, "reader", "Mark a task done only when its PR reads MERGED."),
    rule(4, "reader", "A quiet test run is not evidence; read the console's exit line before calling it passed."),
    rule(5, "assistant", "A restart is proved by pid, not by a clean process listing: the killed shell can drop out of the table and still be writing."),
    rule(6, "assistant", "The stale-old_string diagnosis is a patch that matched the wrong span; re-read the file before asking for a second patch."),
    rule(7, "assistant", "An empty branch pushes fine and has no diff; report the slices' PRs rather than manufacturing one."),
    rule(8, "assistant", "A SPAWN line is a proposal until the card is clicked; never tell the reader the work has started."),
  ];
  const watches = [
    { id: "w1", thread: "wtgui/landing", title: "the landing PR reads MERGED", state: "watching", minutes: 20 },
    { id: "w2", thread: "wtgui/rules", title: "the project-rules branch is green", state: "watching", minutes: 45 },
    { id: "w3", thread: "wtgui/queue", title: "the queue sweep ends clean", state: "watching", minutes: 30 },
    { id: "w4", thread: "wtgui/board", title: "the fourth wake's board digest is due", state: "watching", minutes: 60 },
  ];
  writeFileSync(
    path.join(logs, "assistant.json"),
    JSON.stringify({
      version: 2,
      settings: { queueDigestSize: 5, queueSweepEveryNWakes: 2, digestSweepEveryNWakes: 4 },
      notes: "The append tax is the thing to watch: a turn carries the queue digest, the board and the charter, and only the queue is worth its bytes every wake.",
      rules,
      watches,
      alerts: [],
      journal: [],
    }),
  );
  writeFileSync(path.join(logs, "assistant-charter.md"), CHARTER_BODY);
  writeFileSync(
    path.join(logs, "assistants", "assistant-1", "queue.json"),
    JSON.stringify({
      version: 1,
      nextId: 6,
      tasks: [
        { id: 1, title: "Read the prompt budget and name the section that moved", state: "queued", createdAt: new Date().toISOString() },
        { id: 2, title: "Land the project-rules branch", state: "queued", createdAt: new Date().toISOString() },
        { id: 3, title: "Check the changelog render against main", state: "queued", createdAt: new Date().toISOString() },
        { id: 4, title: "Sweep the queue for a row nothing will settle", state: "queued", createdAt: new Date().toISOString() },
        { id: 5, title: "Re-read the charter's pruning rule", state: "queued", createdAt: new Date().toISOString() },
      ],
    }),
  );
  // Four live worker runs, so the board's full digest is a real list and its marker is visibly smaller.
  const jobs = Array.from({ length: 4 }, (_, i) => ({
    id: `job-${i + 1}`,
    thread: `wtgui/worker-${i + 1}`,
    status: "running",
    runId: `run-${i + 1}`,
    prompt: `take the ${["prompt budget", "landing", "queue sweep", "changelog"][i]} branch to a done spot`,
    startedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
    lines: [],
  }));
  writeFileSync(path.join(logs, "jobs.json"), JSON.stringify({ jobs }));
}

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the Prompt tab", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-prompt-tab-"));
  seed(dir);
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    await withBrowser(
      async ({ page, pageErrors }) => {
        await page.setViewportSize(VIEWPORT);
        await openPage(page, panel.base, { selector: "#btn-settings" });
        await page.waitForTimeout(300);
        // The window's own store: a fresh visit opens at 340px, and this is the width the shot is taken at.
        await page.evaluate((rect) => localStorage.setItem("wtgui.settingsRect", JSON.stringify(rect)), RECT);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#btn-settings", { timeout: 30_000 });
        await page.waitForTimeout(300);
        await page.click("#btn-settings");
        await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
        const tab = await page.$('[data-settings-tab="prompt"]');
        if (!tab) {
          check(false, "there is no Prompt tab in this build");
          return;
        }
        await page.click('[data-settings-tab="prompt"]');
        await page.waitForSelector('[data-settings-group="prompt"]:not([hidden])', { timeout: 10_000 });
        await page.waitForSelector("#prompt-diagrams .prompt-diagram", { timeout: 10_000 });
        await page.waitForTimeout(250);

        // The route's own answer, read in the page's own origin, is what the boxes must say.
        const route = await page.evaluate(async () => {
          const r = await fetch("/api/settings/prompt-budget");
          return { status: r.status, body: await r.json().catch(() => null) };
        });
        check(route.status === 200 && route.body, "GET /api/settings/prompt-budget answers", `HTTP ${route.status}`);

        const dom = await page.evaluate(() => {
          const panel = document.getElementById("settings");
          const diagramPanel = document.getElementById("settings-panel-prompt");
          const diagrams = [...document.querySelectorAll("#prompt-diagrams .prompt-diagram")];
          const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
          return {
            width: panel.getBoundingClientRect().width,
            diagrams: diagrams.map((d) => ({
              key: d.dataset.promptTurn,
              title: text(d.querySelector(".prompt-diagram-title")),
              total: text(d.querySelector(".prompt-diagram-total")),
              halves: [...d.querySelectorAll(".prompt-half")].map((h) => h.dataset.promptHalf),
              sections: [...d.querySelectorAll(".prompt-section")].map((s) => ({
                key: s.dataset.promptSection,
                name: text(s.querySelector(".prompt-section-name")),
                share: text(s.querySelector(".prompt-section-share")),
                width: s.querySelector(".prompt-fill")?.style.width || "",
                gated: s.classList.contains("is-gated"),
                title: s.getAttribute("title") || "",
              })),
            })),
            controls: diagramPanel.querySelectorAll("input,button,select,textarea").length,
            legend: text(document.getElementById("prompt-budget-legend")),
            summary: text(document.getElementById("prompt-budget-summary")),
            bodyScrolls: (() => {
              const body = document.querySelector("#settings .settings-body");
              return body ? body.scrollHeight > body.clientHeight + 1 : null;
            })(),
          };
        });

        note(`window: ${dom.width}px wide, ${RECT.h}px tall`);
        check(dom.width === RECT.w, `the window is at its default width (${RECT.w}px)`, `${dom.width}px`);
        check(dom.diagrams.length === 3, "three diagrams, one per turn", dom.diagrams.map((d) => d.key).join(", "));
        check(JSON.stringify(dom.diagrams.map((d) => d.key)) === JSON.stringify(["first", "ordinary", "fourth"]), "they are the first turn, an ordinary turn and the fourth wake");
        check(dom.diagrams.every((d) => d.halves.join(",") === "system,turn"), "each diagram is a box inside a box: the prompt holds system text and turn text", dom.diagrams[0]?.halves.join(","));
        check(dom.diagrams.every((d) => d.sections.length === 14), "each turn draws the fourteen sections", dom.diagrams.map((d) => d.sections.length).join(","));
        check(dom.controls === 0, "the tab is read-only: no input, button, select or textarea in it", `${dom.controls} controls`);
        check(/reserved against/i.test(dom.legend) || /Caps the boxes/i.test(dom.legend), "the legend names the caps the boxes are reserved against", dom.legend.slice(0, 80));
        check(dom.summary.includes("first turn") && dom.summary.includes("ordinary") && dom.summary.includes("fourth wake"), "the summary names all three turns", dom.summary.slice(0, 120));

        // The numbers the picture draws are the route's own, not a second table in the page.
        const routeTurns = route.body?.turns || [];
        for (const [i, d] of dom.diagrams.entries()) {
          const rt = routeTurns[i];
          const total = Number(String(d.total).replace(/[^0-9]/g, ""));
          check(rt && total === rt.total, `${d.key}: the diagram's total is the route's total`, `dom ${total} / route ${rt?.total}`);
          const first = d.sections[0];
          check(first && first.share.includes("%"), `${d.key}: every box carries its name and its share`, first?.share || "none");
          const zeros = d.sections.filter((s) => s.width === "0%" || s.width === "0.00%").length;
          check(zeros <= 2, `${d.key}: at most the empty role prompt and the closed gate have no bar`, `${zeros} empty bars`);
        }
        const ordinary = dom.diagrams.find((d) => d.key === "ordinary");
        const gated = ordinary?.sections.find((s) => s.key === "queue");
        check(gated?.gated, "the ordinary turn's queue digest is drawn as a closed gate, not as a section that vanished");
        check(/gate closed/i.test(gated?.share || ""), "and says the gate is closed", gated?.share);
        const fourth = dom.diagrams.find((d) => d.key === "fourth");
        const board = fourth?.sections.find((s) => s.key === "board");
        check(!board?.gated && /full digest/i.test(board?.title || ""), "the fourth wake carries the board's full digest", board?.title || "no board");
        const charterFirst = dom.diagrams[0]?.sections.find((s) => s.key === "charter");
        check(/sent in full/i.test(charterFirst?.title || ""), "the first turn carries the charter in full", charterFirst?.title || "no charter");
        const charterOrdinary = ordinary?.sections.find((s) => s.key === "charter");
        check(/one-line marker/i.test(charterOrdinary?.title || ""), "the ordinary turn carries the charter's marker", charterOrdinary?.title || "no charter");

        // A bar's width is its share of the turn: read the widest and the narrowest, and the sum of a
        // half's widths against its group's share.
        const firstTurn = dom.diagrams[0];
        const charterWidth = parseFloat(firstTurn.sections.find((s) => s.key === "charter")?.width || "0");
        check(charterWidth > 50, "on a first turn the charter is more than half the prompt's width", `${charterWidth.toFixed(1)}%`);

        mkdirSync(path.dirname(OUT), { recursive: true });
        // The shot must show all three diagrams, so the window grows to the body's own content height.
        // Its WIDTH stays the 340px default; only the height is fitted, and the panel's max-height
        // (the viewport minus its edge) caps it.
        const fitted = await page.evaluate(() => {
          const panel = document.getElementById("settings");
          const height = (sel) => panel.querySelector(sel)?.getBoundingClientRect().height || 0;
          const body = panel.querySelector(".settings-body");
          const need = Math.ceil(height(".settings-head") + height(".settings-tabs") + body.scrollHeight + 4);
          const max = window.innerHeight - 16;
          panel.style.height = `${Math.min(need, max)}px`;
          return { need, height: Math.round(panel.getBoundingClientRect().height), width: Math.round(panel.getBoundingClientRect().width) };
        });
        note(`fitted the window to ${fitted.height}px of content (${fitted.need}px needed), still ${fitted.width}px wide`);
        await page.waitForTimeout(120);
        await page.locator("#settings").screenshot({ path: OUT });
        note(`screenshot: ${OUT}`);
        check(fitted.width === RECT.w, "the screenshot keeps the default width", `${fitted.width}px`);
        check(fitted.need <= fitted.height + 1, "the whole tab fits the fitted window", `${fitted.need}px needed, ${fitted.height}px tall`);
        check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));
      },
      { viewport: VIEWPORT, deviceScaleFactor: 2 },
    );
  } finally {
    await panel.stop();
  }
  console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
