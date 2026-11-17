#!/usr/bin/env node
// Settings > Prompt, driven in a real Chromium and photographed at 1440 x 900.
//
//   node tools/verify-prompt-tab.mjs
//   node tools/verify-prompt-tab.mjs --out docs/assets/prompt-tab   # a different folder for the shots
//   node tools/verify-prompt-tab.mjs --root <a git archive export>   # shoot another build
//
// WHAT THIS PROVES. The tab is now a page of documentation, so the checks are about what a reader can
// find rather than only about what a box is labelled: a plain-words key for system text and turn text
// with the consequence drawn out (nothing that moves rides in the system half; a change at the head
// costs the prefix cache), a table of contents whose four anchors resolve and move the pane, every tab
// word defined once in alphabetical order with the box it describes marked beside it, the three charts
// KEPT and placed beside the text that explains them, and the worker briefs section that did not exist
// before (eight paragraphs, each with when it attaches and the lib/jobs.js constant it comes from,
// REPORT_BRIEF among them).
//
// THE FRAME is 1440 x 900 CSS px. The viewport is the size the shots are taken at; the settings pane is
// widened to 960 so the tab's two-column layouts engage (the stylesheet's container query is 620px of
// PANE, not of browser), and the pane is 820 tall inside the 900. Two of the shots are of blocks, so the
// pane's own scroll is left where the block is.
//
// RED PROOF: a tree without the tab has no [data-settings-tab="prompt"] and the first case says so and
// exits 1 rather than timing out on a click. A tree WITH the tab but with the OLD single-row panel has no
// #prompt-key and no [data-brief], so the key and briefs cases fail; a tree with the tab and the key but
// no charts fails the diagram cases. Nothing here passes on an empty page: every case names an element.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const OUTDIR = path.resolve(opt("--out", path.join(TREE, "docs", "assets", "prompt-tab")));
const VIEWPORT = { width: 1440, height: 900 };
// The pane: 960 wide is past the 620px container query, so every two-column layout in the tab is on;
// 820 tall leaves the head and tabs inside the 900px frame.
const RECT = { x: 16, y: 40, w: 960, h: 820 };
// The terms the page defines, in the order the page must print them: alphabetical, which is the order a
// reader who does not know the words can use.
const TERMS = [
  "board digest",
  "budget",
  "charter",
  "over-cap behaviour",
  "queue digest",
  "resend every N",
  "section, and its order",
  "standing briefing",
];
// The briefs, with the constant each one comes from and whether it attaches on every tree run.
const BRIEFS = [
  { marker: "RELEASE", constant: "RELEASE_BRIEF", everyTurn: false },
  { marker: "DELIVER", constant: "DELIVER_BRIEF", everyTurn: true },
  { marker: "CLARIFY_LINKS", constant: "CLARIFY_LINKS_BRIEF", everyTurn: true },
  { marker: "REPORT", constant: "REPORT_BRIEF", everyTurn: true },
  { marker: "TERMINAL", constant: "TERMINAL_BRIEF", everyTurn: true },
  { marker: "GIT", constant: "GIT_BRIEF", everyTurn: true },
  { marker: "PAGE", constant: "PAGE_BRIEF", everyTurn: true },
  { marker: "TESTING", constant: "TESTING_BRIEF", everyTurn: false },
];

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
        // The pane's own store: a fresh visit opens at 340px, and the shot is taken in a widened pane.
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
          const group = document.getElementById("settings-panel-prompt");
          const body = panel.querySelector(".settings-body");
          const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
          const diagrams = [...document.querySelectorAll("#prompt-diagrams .prompt-diagram")];
          const defs = [...group.querySelectorAll(".prompt-def")];
          const briefs = [...group.querySelectorAll(".prompt-brief")];
          const toc = [...document.querySelectorAll("#prompt-toc a")];
          const boxOf = (el) => (el ? el.getBoundingClientRect() : null);
          return {
            width: Math.round(panel.getBoundingClientRect().width),
            height: Math.round(panel.getBoundingClientRect().height),
            // The key: two cards, named, and the two consequence blocks.
            key: [...group.querySelectorAll(".prompt-key-card")].map((c) => ({
              half: c.dataset.promptHalf,
              name: text(c.querySelector(".prompt-key-name")),
              says: text(c.querySelector("p:last-child")),
            })),
            keyWhy: text(document.getElementById("prompt-key-why")),
            keyFollows: [...(document.getElementById("prompt-key-follows")?.querySelectorAll("li") || [])].map(text),
            defs: defs.map((d) => ({
              term: d.dataset.promptTerm,
              head: text(d.querySelector(".prompt-def-term")),
              says: text(d.querySelector(".prompt-def-says")),
              chip: text(d.querySelector(".prompt-box-chip")),
              chipBox: d.querySelector(".prompt-box-chip")?.dataset.promptBox || "",
            })),
            briefs: briefs.map((b) => ({
              marker: b.dataset.brief,
              constant: b.dataset.briefConstant,
              when: text(b.querySelector(".prompt-brief-when")),
              says: text(b.querySelector(".prompt-brief-says")),
              from: text(b.querySelector(".prompt-brief-from")),
            })),
            briefsIntro: text(document.querySelector("#prompt-briefs + .prompt-doc-note")),
            toc: toc.map((a) => ({ href: a.getAttribute("href"), label: text(a), resolves: Boolean(document.getElementById(a.getAttribute("href").slice(1))) })),
            // The charts beside their text: the note's left edge is to the RIGHT of the picture's right edge.
            beside: diagrams.map((d) => {
              const pic = d.querySelector(".prompt-box");
              const side = d.querySelector(".prompt-diagram-side");
              return {
                key: d.dataset.promptTurn,
                sideRightOfPicture: Boolean(pic && side && boxOf(side).left >= boxOf(pic).right - 1),
                note: text(side?.querySelector(".prompt-diagram-note")),
                why: text(side?.querySelector(".prompt-diagram-why")),
              };
            }),
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
            controls: group.querySelectorAll("input,button,select,textarea").length,
            legend: text(document.getElementById("prompt-budget-legend")),
            summary: text(document.getElementById("prompt-budget-summary")),
            scrolls: body ? body.scrollHeight > body.clientHeight + 1 : null,
            bodyBox: boxOf(body),
            briefsTop: boxOf(document.getElementById("prompt-briefs"))?.top ?? null,
          };
        });

        note(`pane: ${dom.width} x ${dom.height} in a ${VIEWPORT.width} x ${VIEWPORT.height} frame`);
        check(dom.width === RECT.w && dom.height === RECT.h, `the pane is ${RECT.w} x ${RECT.h}`, `${dom.width} x ${dom.height}`);
        check(dom.controls === 0, "the tab is read-only: no input, button, select or textarea in it", `${dom.controls} controls`);

        // ---- the key -----------------------------------------------------------------------------
        check(dom.key.length === 2, "the key is two cards", `${dom.key.length}`);
        const system = dom.key.find((k) => k.half === "system");
        const turn = dom.key.find((k) => k.half === "turn");
        check(system?.name === "System text" && turn?.name === "Turn text", "the two halves are named system text and turn text", `${system?.name} / ${turn?.name}`);
        check(/standing half/i.test(system?.says || ""), "system text is defined as the standing half of the prompt", system?.says.slice(0, 70));
        check(/instructions/i.test(system?.says || "") && /prefix cache/i.test(system?.says || ""), "and it says both what it is sent as and what the prefix cache reuses", system?.says.slice(0, 90));
        check(/moves every turn/i.test(turn?.says || ""), "turn text is defined as the half that moves every turn", turn?.says.slice(0, 70));
        check(
          ["board tail", "queue digest", "charter"].every((w) => (turn?.says || "").includes(w)),
          "and it names what rides in it: the board tail, the queue digest and the charter",
          turn?.says.slice(0, 120),
        );
        check(/prefix cache/i.test(dom.keyWhy) && /first that moved/i.test(dom.keyWhy), "the page says why the split exists, in prefix-cache terms", dom.keyWhy.slice(0, 80));
        check(
          dom.keyFollows.some((li) => /nothing that moves/i.test(li)) &&
            dom.keyFollows.some((li) => /costs the prefix cache/i.test(li)),
          "and what follows from it: nothing that moves in the system half, a change at the head costs the cache",
          dom.keyFollows.join(" | ").slice(0, 140),
        );

        // ---- the table of contents ---------------------------------------------------------------
        check(dom.toc.length === 4, "the table of contents has four entries", `${dom.toc.length}`);
        check(dom.toc.every((t) => t.resolves), "every anchor resolves to a heading on the page", dom.toc.map((t) => t.href).join(", "));
        const before = await page.evaluate(() => document.querySelector("#settings .settings-body").scrollTop);
        await page.click("#prompt-toc a[href='#prompt-briefs']");
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => {
          const body = document.querySelector("#settings .settings-body");
          const head = document.getElementById("prompt-briefs");
          return { scrollTop: body.scrollTop, top: head.getBoundingClientRect().top - body.getBoundingClientRect().top };
        });
        check(after.scrollTop > before, "pressing an entry moves the pane", `${before} -> ${after.scrollTop}`);
        check(after.top >= -2 && after.top < 40, "and lands the section at the top of the pane", `${after.top.toFixed(1)}px below the pane's top`);

        // ---- the definitions ---------------------------------------------------------------------
        check(dom.defs.length === TERMS.length, `the page defines ${TERMS.length} words`, `${dom.defs.length}`);
        check(
          JSON.stringify(dom.defs.map((d) => (d.term || "").toLowerCase())) === JSON.stringify(TERMS.map((t) => t.toLowerCase())),
          "in alphabetical order",
          dom.defs.map((d) => d.term).join(" | "),
        );
        check(dom.defs.every((d) => d.says.length > 40), "every definition is a sentence, not a label", `${Math.min(...dom.defs.map((d) => d.says.length))} chars at the shortest`);
        check(dom.defs.every((d) => d.chip && d.chipBox), "every definition is marked with the box it describes", dom.defs.map((d) => d.chip).join(" | ").slice(0, 120));
        check(
          dom.defs.filter((d) => d.chipBox === "system").length === 1 && dom.defs.filter((d) => d.chipBox === "turn").length === 6,
          "one word describes system text and six describe turn text",
          dom.defs.map((d) => `${d.term}=${d.chipBox}`).join(", "),
        );
        const charter = dom.defs.find((d) => d.term === "charter");
        check(/CHARTER_MAX_CHARS/.test(charter?.says || "") && /20,000/.test(charter?.says || ""), "the charter's definition names its real cap", charter?.says.slice(0, 70));
        const resend = dom.defs.find((d) => d.term === "resend every N");
        check(/CHARTER_RESEND_EVERY/.test(resend?.says || "") && /20 turns/.test(resend?.says || ""), "and the resend-every-N definition names its constant and its value", resend?.says.slice(0, 70));
        const queue = dom.defs.find((d) => d.term === "queue digest");
        check(/queueDigestSize/.test(queue?.says || "") && /5 by default, 20 at most/.test(queue?.says || ""), "the queue digest names its size and its gate", queue?.says.slice(0, 70));
        const budget = dom.defs.find((d) => d.term === "budget");
        check(/briefingBudgetChars/.test(budget?.says || "") && /40,000/.test(budget?.says || ""), "the budget names the setting and its ceiling", budget?.says.slice(0, 70));

        // ---- the charts, kept --------------------------------------------------------------------
        check(dom.diagrams.length === 3, "three diagrams, one per turn", dom.diagrams.map((d) => d.key).join(", "));
        check(JSON.stringify(dom.diagrams.map((d) => d.key)) === JSON.stringify(["first", "ordinary", "fourth"]), "they are the first turn, an ordinary turn and the fourth wake");
        check(dom.diagrams.every((d) => d.halves.join(",") === "system,turn"), "each diagram is a box inside a box: the prompt holds system text and turn text", dom.diagrams[0]?.halves.join(","));
        check(dom.diagrams.every((d) => d.sections.length === 15), "each turn draws every box: twelve standing and the three that move", dom.diagrams.map((d) => d.sections.length).join(", "));
        check(
          JSON.stringify(dom.diagrams[0].sections.map((s) => s.key)) ===
            JSON.stringify(["identity", "role", "prompt", "directive", "rest", "projects", "rules", "landing", "notes", "watches", "grammar", "close", "queue", "board", "charter"]),
          "in the builder's order: the twelve standing boxes, then the queue, the board and the charter",
          dom.diagrams[0].sections.map((s) => s.key).join(", "),
        );
        check(/reserved against/i.test(dom.legend) || /Caps the boxes/i.test(dom.legend), "the legend names the caps the boxes are reserved against", dom.legend.slice(0, 80));
        check(dom.summary.includes("first turn") && dom.summary.includes("ordinary") && dom.summary.includes("fourth wake"), "the summary names all three turns", dom.summary.slice(0, 120));
        check(dom.beside.every((b) => b.sideRightOfPicture), "each chart sits beside the text that explains it", dom.beside.map((b) => `${b.key}:${b.sideRightOfPicture}`).join(", "));
        check(dom.beside.every((b) => b.note.length > 20 && b.why.length > 40), "and that text is a note and a reason, not a caption", dom.beside.map((b) => `${b.key}:${b.why.length}`).join(", "));

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
        check(!board?.gated && /tail/i.test(board?.title || ""), "the board rides every turn as one tail message", board?.title || "no board");
        const charterFirst = dom.diagrams[0]?.sections.find((s) => s.key === "charter");
        check(/sent in full/i.test(charterFirst?.title || ""), "the first turn carries the charter in full", charterFirst?.title || "no charter");
        const charterOrdinary = ordinary?.sections.find((s) => s.key === "charter");
        check(/one-line marker/i.test(charterOrdinary?.title || ""), "the ordinary turn carries the charter's marker", charterOrdinary?.title || "no charter");
        const firstTurn = dom.diagrams[0];
        const charterWidth = parseFloat(firstTurn.sections.find((s) => s.key === "charter")?.width || "0");
        check(charterWidth > 50, "on a first turn the charter is more than half the prompt's width", `${charterWidth.toFixed(1)}%`);

        // ---- the worker briefs -------------------------------------------------------------------
        check(dom.briefs.length === BRIEFS.length, `the briefs section has ${BRIEFS.length} entries`, `${dom.briefs.length}`);
        check(
          JSON.stringify(dom.briefs.map((b) => b.marker)) === JSON.stringify(BRIEFS.map((b) => b.marker)),
          "in the order they arrive in a worker's prompt",
          dom.briefs.map((b) => b.marker).join(", "),
        );
        check(
          dom.briefs.every((b, i) => b.constant === BRIEFS[i].constant),
          "each entry names the lib/jobs.js constant it comes from",
          dom.briefs.map((b) => b.constant).join(", "),
        );
        check(dom.briefs.every((b) => b.when.length > 8 && /tree run|every turn/i.test(b.when)), "each entry says when it attaches", dom.briefs.map((b) => b.when).join(" | ").slice(0, 140));
        check(
          dom.briefs.filter((b) => /every turn/.test(b.when)).length === 6 &&
            dom.briefs.filter((b) => !/every turn/.test(b.when)).length === 2,
          "six attach on every tree run and two only where the tree allows it",
          dom.briefs.map((b) => `${b.marker}:${/every turn/.test(b.when) ? "every" : "conditional"}`).join(", "),
        );
        check(dom.briefs.every((b) => b.says.length > 40), "every brief says what it asks for", `${Math.min(...dom.briefs.map((b) => b.says.length))} chars at the shortest`);
        const report = dom.briefs.find((b) => b.marker === "REPORT");
        check(/1\.111\.1/.test(report?.from || ""), "REPORT is marked as the paragraph that landed in 1.111.1", report?.from);
        check(/docs\/worker-brief-report-cards\.md/.test(report?.from || ""), "and points at the report it was proved in", report?.from);
        const git = dom.briefs.find((b) => b.marker === "GIT");
        check(/docs\/worker-brief-git-remotes\.md/.test(git?.from || ""), "GIT points at worker-brief-git-remotes rather than restating it", git?.from);
        const terminal = dom.briefs.find((b) => b.marker === "TERMINAL");
        check(/docs\/reports\/terminal-call-latency-2026-11-11\.html/.test(terminal?.from || ""), "TERMINAL points at the terminal-call-rules report", terminal?.from);
        const testing = dom.briefs.find((b) => b.marker === "TESTING");
        check(/test:changed/.test(testing?.says || "") && /package\.json/.test(testing?.from || ""), "TESTING says which scripts it needs and which tree carries them", `${testing?.says.slice(0, 60)} / ${testing?.from.slice(0, 60)}`);
        // A pointer that names a file the tree does not carry is worse than no pointer: every `docs/...` path on the
        // page is read back off it and checked against the disk.
        const pageText = `${dom.keyWhy} ${dom.defs.map((d) => d.says).join(" ")} ${dom.briefs.map((b) => `${b.says} ${b.from}`).join(" ")}`;
        const pointers = [...new Set((pageText.match(/docs\/[A-Za-z0-9._/-]+/g) || []).map((p) => p.replace(/\.+$/, "")))];
        check(pointers.length >= 3, "the page points at the docs its claims rest on", pointers.join(", "));
        const missing = pointers.filter((p) => !existsSync(path.join(TREE, p)));
        check(missing.length === 0, "and every one of those files is in the tree", missing.length ? `missing: ${missing.join(", ")}` : pointers.join(", "));
        check(/tree run is a run in a worktree/i.test(dom.briefsIntro), "the section defines what a tree run is before using the phrase", dom.briefsIntro.slice(0, 80));

        // ---- the shots ---------------------------------------------------------------------------
        mkdirSync(OUTDIR, { recursive: true });
        await page.evaluate(() => {
          document.querySelector("#settings .settings-body").scrollTop = 0;
          document.getElementById("prompt-toc").scrollIntoView({ block: "start" });
        });
        await page.waitForTimeout(150);
        const keyClip = await page.evaluate(() => {
          const group = document.getElementById("settings-panel-prompt");
          const panel = document.getElementById("settings");
          const top = document.getElementById("prompt-toc").getBoundingClientRect().top;
          const bottom = document.getElementById("prompt-key-follows").getBoundingClientRect().bottom;
          const box = panel.getBoundingClientRect();
          return {
            x: box.left + 1,
            y: Math.max(0, top - 8),
            width: box.width - 2,
            height: bottom - top + 16,
            overflow: group.scrollWidth - group.clientWidth,
          };
        });
        check(keyClip.overflow <= 1, "the page does not scroll sideways", `${keyClip.overflow}px of overflow`);
        const keyOut = path.join(OUTDIR, "prompt-tab-key.png");
        await page.screenshot({ path: keyOut, clip: keyClip });
        note(`screenshot: ${keyOut}`);
        check(keyClip.height > 300 && keyClip.height < VIEWPORT.height, "the key fits one 900px frame", `${Math.round(keyClip.height)}px tall`);

        const defOut = path.join(OUTDIR, "prompt-tab-definition.png");
        await page.locator('.prompt-def[data-prompt-term="charter"]').screenshot({ path: defOut });
        note(`screenshot: ${defOut}`);
        const defBox = await page.locator('.prompt-def[data-prompt-term="charter"]').boundingBox();
        check(defBox && defBox.width > 700, "the definition shot is a row of the two-column page, not a squeezed box", `${Math.round(defBox?.width || 0)}px wide`);

        // The briefs section is 900px tall on its own, so it is two frames: the heading and the first four
        // entries, then the last four. The split is at a brief's boundary, not at a scrollbar, so neither
        // frame repeats a line of the other.
        await page.evaluate(() => document.getElementById("prompt-briefs").scrollIntoView({ block: "start" }));
        await page.waitForTimeout(250);
        const briefsGeo = await page.evaluate(() => {
          const panel = document.getElementById("settings").getBoundingClientRect();
          const box = (el) => el.getBoundingClientRect();
          const brief = (name) => box(document.querySelector(`[data-brief="${name}"]`));
          return {
            left: panel.left + 1,
            width: panel.width - 2,
            viewport: window.innerHeight,
            head: box(document.getElementById("prompt-briefs")).top,
            reportBottom: brief("REPORT").bottom,
          };
        });
        const briefsOutA = path.join(OUTDIR, "prompt-tab-briefs-1.png");
        await page.screenshot({
          path: briefsOutA,
          clip: { x: briefsGeo.left, y: briefsGeo.head - 8, width: briefsGeo.width, height: briefsGeo.reportBottom - briefsGeo.head + 16 },
        });
        note(`screenshot: ${briefsOutA}`);
        check(briefsGeo.reportBottom + 8 <= briefsGeo.viewport, "the first half of the briefs fits one 900px frame", `${Math.round(briefsGeo.reportBottom)}px of ${briefsGeo.viewport}px`);
        await page.evaluate(() => document.querySelector('[data-brief="TERMINAL"]').scrollIntoView({ block: "start" }));
        await page.waitForTimeout(200);
        const tailGeo = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const panel = document.getElementById("settings").getBoundingClientRect();
          return {
            left: panel.left + 1,
            width: panel.width - 2,
            viewport: window.innerHeight,
            top: box(document.querySelector('[data-brief="TERMINAL"]')).top,
            bottom: box([...document.querySelectorAll(".prompt-brief")].pop()).bottom,
          };
        });
        const briefsOutB = path.join(OUTDIR, "prompt-tab-briefs-2.png");
        await page.screenshot({
          path: briefsOutB,
          clip: { x: tailGeo.left, y: tailGeo.top - 4, width: tailGeo.width, height: tailGeo.bottom - tailGeo.top + 8 },
        });
        note(`screenshot: ${briefsOutB}`);
        check(tailGeo.bottom + 4 <= tailGeo.viewport, "and its last four do too", `${Math.round(tailGeo.bottom)}px of ${tailGeo.viewport}px`);

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
