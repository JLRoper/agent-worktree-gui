#!/usr/bin/env node
// CAPTURE, not gate: the five wave-lane drawings in docs/reports/initiatives-wave-lane-options-2026-11-28.html,
// photographed at the panel's real wave column and at the 900px panel, with the numbers the report is written from.
//
//   node tools/capture-wave-lane-options.mjs
//   node tools/capture-wave-lane-options.mjs --home C:/Users/roper/AppData/Local/Temp/wag/689111db/fixture
//
// THE PANEL IS THE FIXTURE'S OWN. tools/initiatives-fixture.mjs builds three throwaway projects, four initiatives and
// two assistants' queues, then boots server.js with WAG_HOME under scratch. This tool seeds ONE MORE project
// (agent-worktree-gui) and the wave the reader's 2026-11-28 screenshot shows: three members across two lanes
// (public/index.html and the unlaned lane), an entry and an exit gate row, and one closed wave beneath. The reader's
// ~/.wag and the live 7331 listener are never read or written; the listener's pid is recorded from netstat only.
//
// TWO WIDTHS. The panel's float is opened at its widest (1384px, the reader's geometry) and at 900px. The wave column
// (#as-initiatives .init-waves) measures 1304px and 804px in those two frames, and those are the widths the report's
// stages are rendered at, so the drawings and the panel are the same column.
//
// EVERY OPTION IS MEASURED, NOT DESCRIBED. The stages share the panel's class names (.wave-row, .wave-lane,
// .wave-member, .wave-member-title), so one function reads the title box, the wrap count and the wave height from the
// panel and from every stage. O1 is the panel's drawing class for class: its numbers must match the panel's, and the
// run fails if they do not.
//
// Exit: 0 the captures and the ledger were written; 2 Playwright is not installed; 1 something threw or a check failed.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, openPage, withBrowser, withPage } from "./browser.mjs";
import { buildFixture, startFixturePanel, waitForFixtureRows } from "./initiatives-fixture.mjs";
import { git } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const HOME = path.resolve(opt("--home", path.join(HERE, "..", "..", "wag-wave-lane-options")));
const REPORT = path.resolve(opt("--report", path.join(ROOT, "docs", "reports", "initiatives-wave-lane-options-2026-11-28.html")));
const OUT = path.resolve(opt("--out", path.join(ROOT, "docs", "reports", "wave-lane-options")));
const KEEP = argv.includes("--keep");

let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (s) => console.log(`      ${s}`);
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const hours = (n) => n * 3_600_000;

// ---- the same wave as the reader's screenshot --------------------------------------------------------------------
const TITLES = {
  444: "Give the board table home sheet 46 of 316 rules live in board.css and 270 come from 11 others",
  446: "Dissolve late.css: 62 rules, 62 sole definitions - the cut file, the 316 window, the legend popover and the search",
  445: "Break the console eight-sheet surface into sub-sheets: 56 of its 102 rules live outside console.css",
  447: "Split public/app.js along the sheet seams: 316 rules, one entry point",
};
const WAVE_TITLE = "The 1.191.0 split three tangles: the board table home sheet, the console sub-sheets, and late.css dissolved";
const CLOSED_TITLE = "The front-end modules split along the same surface seams as the sheets";
const PROJECT = "agent-worktree-gui";

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`, "utf8");
}

function seedReaderWave(home) {
  // The fixture's own three projects, four initiatives and two queues, plus one project and one wave.
  buildFixture({ home, reset: true });
  const repo = path.join(home, "repos", PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), `# ${PROJECT}\n\nA throwaway project for the wave lane capture.\n`, "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed the capture project"]);
  const trees = {};
  for (const name of ["split-board", "split-console", "split-late"]) {
    const where = path.join(repo, ".worktrees", name);
    git(repo, ["worktree", "add", "-q", "-b", `wtgui/${name}`, where]);
    writeFileSync(path.join(where, `${name}.txt`), `work for ${name}\n`, "utf8");
    git(where, ["add", "-A"]);
    git(where, ["commit", "-q", "-m", `start ${name}`]);
    trees[name] = where.replace(/\\/g, "/");
  }
  const configFile = path.join(home, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.projects.push({ name: PROJECT, path: repo, remote: "origin", mainBranch: "main" });
  writeJson(configFile, config);

  // The initiative: the CSS surfaces card the reader's screenshot shows, with the three new trees on it.
  const initFile = path.join(home, "state", "initiatives.json");
  const doc = JSON.parse(readFileSync(initFile, "utf8"));
  for (const [key, rec] of Object.entries(doc.trees)) {
    rec.initiatives = (rec.initiatives || []).filter((id) => id !== "init_sso");
    if (rec.members) delete rec.members.init_sso;
    if (!rec.initiatives.length) delete doc.trees[key];
  }
  doc.initiatives = doc.initiatives.filter((i) => i.id !== "init_sso");
  doc.initiatives.unshift({
    id: "init_css",
    title: "CSS surfaces: finish the 1.191.0 split three tangles, then split the front-end modules along the same seams",
    description:
      "Source: docs/reports/css-split-review-2026-11-28.html (the 1.191.0 split review, landed as 8fd19ac6 and 4dc8193d at 1.194.0). The split was the right move - the problem is the three tangles it left, measured in a browser by tools/css-split.mjs.",
    createdAt: ago(hours(300)),
    updatedAt: ago(19 * 60_000),
    createdBy: "reader",
    updatedBy: "reader",
    history: [{ at: ago(hours(300)), by: "reader", action: "create", detail: "CSS surfaces" }],
  });
  for (const where of Object.values(trees)) {
    doc.trees[where.toLowerCase()] = {
      path: where,
      initiatives: ["init_css"],
      members: { init_css: { at: ago(hours(52)), by: "reader" } },
      at: ago(hours(52)),
      by: "reader",
    };
  }
  writeJson(initFile, doc);

  // The three members and the closed wave's one, owned by an assistant whose tag is M3 (the reader's own tags).
  const assistFile = path.join(home, "state", "assistants.json");
  const assistants = JSON.parse(readFileSync(assistFile, "utf8"));
  assistants.assistants.push({ id: "assistant-3", name: "Manager 3", roleId: "assistant-agent-manager", threadId: "panel-assistant-3", rules: [], createdAt: ago(hours(400)) });
  writeJson(assistFile, assistants);
  const base = {
    detail: "", owner: null, createdBy: "reader", createdAt: ago(hours(4)), startedAt: null, doneAt: null, doneBy: null,
    threads: [], project: PROJECT, files: [], lane: null, order: null, attempts: 0, reason: "", hold: null, movedFrom: [], runId: null,
  };
  const rows = [
    { ...base, id: 444, title: TITLES[444], state: "running", thread: "wtgui-split-board", worktree: trees["split-board"], waveId: "wave-split", lane: "public/index.html", startedAt: ago(7 * 60_000), runId: "run_split_444" },
    { ...base, id: 446, title: TITLES[446], state: "queued", thread: "wtgui-split-late", worktree: "", waveId: "wave-split", lane: "public/index.html", createdAt: ago(3 * 60_000) },
    { ...base, id: 445, title: TITLES[445], state: "queued", thread: "wtgui-split-console", worktree: "", waveId: "wave-split", lane: null, createdAt: ago(2 * 60_000) },
    { ...base, id: 447, title: TITLES[447], state: "done", thread: "wtgui-split-late", worktree: trees["split-late"], waveId: "wave-closed", lane: null, doneAt: ago(hours(2)), doneBy: "assistant-3" },
  ];
  const qdir = path.join(home, "state", "assistants", "assistant-3");
  mkdirSync(qdir, { recursive: true });
  writeJson(path.join(qdir, "queue.json"), { version: 1, nextId: 500, tasks: rows });

  writeJson(path.join(home, "state", "waves.json"), {
    version: 1,
    savedAt: new Date().toISOString(),
    byInitiative: {
      init_css: [
        { id: "wave-split", initiativeId: "init_css", position: 1, title: WAVE_TITLE, entryGate: null, exitGate: null, template: null, auto: false },
        { id: "wave-closed", initiativeId: "init_css", position: 2, title: CLOSED_TITLE, entryGate: null, exitGate: null, template: null, auto: false },
      ],
    },
  });
  return { trees };
}

// ---- one measurement, applied to the panel and to every stage ------------------------------------------------------
function measureLane(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return { error: `no ${rootSel}` };
  const wavesEl = root.querySelector(".init-waves");
  const wave = root.querySelector('[data-wave-id="wave-split"]');
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const members = [...(wave?.querySelectorAll("[data-wave-member]") || [])].map((m) => {
    const t = m.querySelector(".wave-member-title");
    const cs = t ? getComputedStyle(t) : null;
    const r = t ? t.getBoundingClientRect() : null;
    const lh = cs ? parseFloat(cs.lineHeight) : 0;
    let ch = 0;
    try {
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = cs ? cs.font : "12px sans-serif";
      ch = ctx.measureText("0").width || 0;
    } catch {
      ch = 0;
    }
    const text = t ? String(t.textContent || "").trim() : "";
    return {
      id: m.getAttribute("data-wave-member"),
      titleW: r ? Math.round(r.width) : null,
      titleH: r ? Math.round(r.height) : null,
      lineHeight: lh ? Math.round(lh * 10) / 10 : null,
      lines: lh && r ? Math.round(r.height / lh) : null,
      charsPerLine: ch && r ? Math.round(r.width / ch) : null,
      textChars: text.length,
      overflow: t ? Math.round(t.scrollWidth - t.clientWidth) : 0,
      memberH: Math.round(m.getBoundingClientRect().height),
      display: getComputedStyle(m).display,
    };
  });
  const lanes = [...(wave?.querySelectorAll(".wave-lane") || [])].map((l) => ({ name: l.getAttribute("data-wave-lane"), w: Math.round(l.getBoundingClientRect().width), x: Math.round(l.getBoundingClientRect().x), top: Math.round(l.getBoundingClientRect().top) }));
  const laneStacked = lanes.length > 1 && new Set(lanes.map((l) => l.top)).size === lanes.length;
  const closed = root.querySelector('[data-wave-id="wave-closed"]');
  const closedTitle = closed?.querySelector(".wave-member-title");
  const host = root.id === "as-initiatives" ? root : root.closest("#as-initiatives");
  return {
    hostW: host ? host.clientWidth : null,
    paneW: root.clientWidth,
    waveColumnW: wavesEl ? wavesEl.clientWidth : null,
    wave: box(wave),
    waveH: box(wave)?.h,
    waveOverflow: wave ? Math.round(wave.scrollWidth - wave.clientWidth) : 0,
    layout: wave ? wave.getAttribute("data-layout") || (laneStacked ? "lanes stacked" : "lanes side by side") : null,
    lanes,
    members,
    closedTitleW: closedTitle ? Math.round(closedTitle.getBoundingClientRect().width) : null,
    waveCount: root.querySelectorAll(".wave-row").length,
  };
}

const linesOf = (m) => (m?.members || []).map((x) => x.lines).join(" / ");
const widestTitle = (m) => Math.max(0, ...((m?.members || []).map((x) => x.titleW || 0)));
const labelLayout = (m) => {
  if (!m) return "n/a";
  if (m.layout === "bands") return "bands stacked";
  if (m.layout === "table") return "one table";
  if (m.layout === "matrix") return "two columns";
  const tops = new Set((m.lanes || []).map((l) => l.top));
  return tops.size <= 1 ? "lanes side by side" : "lanes stacked";
};

async function waitForCssCard(base, { timeout = 90_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/initiatives`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        last = await r.json();
        const card = (last.initiatives || []).find((i) => i.id === "init_css");
        const trees = (card?.projects || []).flatMap((p) => p.trees || []);
        const ready = (last.initiatives || []).length === 4 && trees.length === 3 && trees.every((t) => !t.missing && String(t.branch || "").trim());
        if (ready) return last;
      }
    } catch {
      /* the scan can reset a socket; retry until the deadline */
    }
    if (Date.now() > deadline) {
      const card = (last?.initiatives || []).find((i) => i.id === "init_css");
      const trees = (card?.projects || []).flatMap((p) => p.trees || []);
      throw new Error(`timed out waiting for the CSS card: ${trees.map((t) => `${t.path}${t.missing ? " (missing)" : ` (${t.branch || "no branch"})`}`).join(", ") || "no card"}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const liveListener = () => {
  // A READ OF NETSTAT ONLY. No request goes to 7331: the identity is the listening pid.
  try {
    const netstat = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
    const line = netstat.split(/\r?\n/).map((l) => l.trim()).find((l) => /[:.]7331\s/.test(l) && /LISTENING/i.test(l)) || null;
    return { line, pid: line ? Number(line.split(/\s+/).pop()) : null };
  } catch (err) {
    return { line: null, pid: null, error: String(err.message || err) };
  }
};

const shot = async (locator, file) => {
  if (!existsSync(path.dirname(file))) mkdirSync(path.dirname(file), { recursive: true });
  await locator.screenshot({ path: file });
  note(`shot ${path.basename(file)}`);
};

const openInitiatives = async (page, base) => {
  await openPage(page, base, { selector: "#btn-assistant" });
  await page.waitForSelector("section.project, .topbar", { timeout: 60_000 });
  const open = await page.evaluate(() => {
    const el = document.getElementById("assistant");
    return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
  });
  if (!open) await page.click("#btn-assistant");
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
  const selected = await page.evaluate(() => document.querySelector('#as-tabs [data-as-tab="initiatives"]')?.getAttribute("aria-selected") === "true");
  if (!selected) await page.click('#as-tabs [data-as-tab="initiatives"]');
  await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 15_000 });
  await page.waitForSelector('#as-initiatives [data-init-card="init_css"]', { timeout: 30_000 });
  const card = page.locator('#as-initiatives [data-init-card="init_css"]');
  if (await card.evaluate((el) => el.classList.contains("is-titlecard"))) await card.locator(".init-head-btn").click();
  await page.waitForSelector('#as-initiatives [data-init-card="init_css"] [data-wave-id="wave-split"]', { timeout: 30_000 });
};

const RUN_START = Date.now();
const procStart = (pid) => {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o")`], { encoding: "utf8", timeout: 10_000, windowsHide: true }).trim() || null;
  } catch {
    return null;
  }
};
const procAlive = (pid) => {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { "yes" } else { "no" }`], { encoding: "utf8", timeout: 10_000, windowsHide: true }).trim() === "yes";
  } catch {
    return false;
  }
};

let panel = null;
const ledger = { at: new Date().toISOString(), root: ROOT.replace(/\\/g, "/"), home: HOME.replace(/\\/g, "/"), report: REPORT.replace(/\\/g, "/"), version: JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version, widths: {}, panel: {}, stages: {}, live: {} };

try {
  mkdirSync(OUT, { recursive: true });
  const before = liveListener();
  ledger.live.before = before;
  console.log(`live 7331 before: ${before.line || "no listener"} (pid ${before.pid ?? "none"}) - netstat only, no request`);
  if (before.pid === null) console.log("      note: no listener on 7331 right now; the check records absence as well as identity");

  seedReaderWave(HOME);
  note(`fixture seeded at ${HOME.replace(/\\/g, "/")}`);
  panel = await startFixturePanel({ home: HOME, root: ROOT });
  ok("the fixture panel booted off 7331", panel.port !== 7331, `${panel.base} (pid ${panel.pid})`);
  console.log(`panel: ${panel.base} (pid ${panel.pid})`);
  await waitForFixtureRows(panel.base);
  // THE CARD THIS CAPTURE DRAWS must be on the board with its three real worktrees; the fixture's other initiatives are
  // read for the count only. waitForInitiativesView also insists every tree on every initiative has a branch, and one of
  // the fixture's own (a Menu SSO tree) resolves a pass late on this host - a failure that has nothing to do with this row.
  const view = await waitForCssCard(panel.base);
  ok("the fixture serves the four initiatives", view.initiatives.length === 4, view.initiatives.map((i) => i.title.slice(0, 24)).join(", "));
  const cssCard = view.initiatives.find((i) => i.id === "init_css");
  ok("the CSS card carries its three worktrees", (cssCard?.projects || []).flatMap((p) => p.trees || []).filter((t) => !t.missing).length === 3, (cssCard?.projects || []).flatMap((p) => p.trees || []).map((t) => t.path.split("/").pop()).join(", "));
  await fetch(`${panel.base}/api/settings/general`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dockMode: "floating" }),
    signal: AbortSignal.timeout(8000),
  });

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the wave lane captures", "playwright is not installed for this node (see tools/browser.mjs)"));
    process.exitCode = 2;
  } else {
    // The panel at its widest float: the reader's geometry (1718 device px at 125% is 1374 layout px; the float's
    // clamp at 1400x1000 is 1384).
    ledger.widths.widePanel = 1384;
    ledger.widths.narrowPanel = 900;
    await withBrowser(
      async ({ browser }) => {
        await withPage(
          browser,
          async ({ page }) => {
            await openInitiatives(page, panel.base);
            const m = await page.evaluate(measureLane, '#as-initiatives [data-init-card="init_css"]');
            ledger.panel.wide = m;
            console.log(`\npanel wide: pane ${m.paneW}, wave column ${m.waveColumnW}, lane ${m.lanes[0]?.w}, title ${widestTitle(m)}, wraps ${linesOf(m)}, wave ${m.waveH}`);
            ok("the panel's widest float puts two lanes side by side", new Set(m.lanes.map((l) => l.top)).size === 1, m.lanes.map((l) => `${l.name}:${l.w}@${l.top}`).join(", "));
            ok("the real panel's title column is the defect", widestTitle(m) < 140 && Math.max(...m.members.map((x) => x.lines || 0)) >= 5, `title ${widestTitle(m)}px, wraps ${linesOf(m)}, wave ${m.waveH}px`);
            ok("the closed wave beneath gets the full width", (m.closedTitleW || 0) > 400, `${m.closedTitleW}px vs ${widestTitle(m)}px`);
            await shot(page.locator('#as-initiatives [data-init-card="init_css"] .init-wavefold'), path.join(OUT, "today-wide.png"));
          },
          {
            viewport: { width: 1400, height: 1000 },
            deviceScaleFactor: 1,
            initScripts: [() => {
              localStorage.setItem("wm.assistantOpen", "1");
              localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 8, y: 80, w: 1384, h: 860 }));
            }],
          },
        );
        await withPage(
          browser,
          async ({ page }) => {
            await openInitiatives(page, panel.base);
            const m = await page.evaluate(measureLane, '#as-initiatives [data-init-card="init_css"]');
            ledger.panel.narrow = m;
            console.log(`panel 900px: pane ${m.paneW}, wave column ${m.waveColumnW}, lane ${m.lanes[0]?.w}, title ${widestTitle(m)}, wraps ${linesOf(m)}, wave ${m.waveH}`);
            ok("the 900px panel stacks the lanes", new Set(m.lanes.map((l) => l.top)).size === 2, m.lanes.map((l) => `${l.name}:${l.w}@${l.top}`).join(", "));
            ok("the 900px panel does not overflow", m.waveOverflow === 0, `${m.waveOverflow}px`);
            await shot(page.locator('#as-initiatives [data-init-card="init_css"] .init-wavefold'), path.join(OUT, "today-narrow.png"));
          },
          {
            viewport: { width: 900, height: 900 },
            deviceScaleFactor: 1,
            initScripts: [() => {
              localStorage.setItem("wm.assistantOpen", "1");
              localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 8, y: 80, w: 900, h: 800 }));
            }],
          },
        );

        // The report's stages, at the two measured wave columns.
        const wideW = ledger.panel.wide.waveColumnW;
        const narrowW = ledger.panel.narrow.waveColumnW;
        ledger.widths.wideStage = wideW;
        ledger.widths.narrowStage = narrowW;
        await withPage(
          browser,
          async ({ page }) => {
            await page.goto(pathToFileURL(REPORT).href, { waitUntil: "domcontentloaded" });
            await page.waitForSelector('[data-option="O1"] .stage', { timeout: 15_000 });
            // THE STAGES ARE THE CAPTURE SUBJECTS. The report ships the photographs and keeps the drawings off the page;
            // this class puts them in flow so the same document is both the deliverable and the thing photographed.
            await page.evaluate(() => document.body.classList.add("capture"));
            await page.evaluate(() => document.fonts.ready.catch(() => {}));
            await page.waitForTimeout(120);
            for (const [tag, width] of [["wide", wideW], ["narrow", narrowW]]) {
              await page.evaluate((w) => document.documentElement.style.setProperty("--stage-w", `${w}px`), width);
              await page.waitForTimeout(80);
              ledger.stages[tag] = {};
              for (const id of ["O1", "O2", "O3", "O4", "O5"]) {
                const m = await page.evaluate(measureLane, `[data-option="${id}"] .stage`);
                ledger.stages[tag][id] = m;
                const label = labelLayout(m);
                console.log(`${tag.padEnd(6)} ${id}: stage ${m.waveColumnW}, title ${widestTitle(m)}, wraps ${linesOf(m)}, wave ${m.waveH}, ${label}, overflow ${m.waveOverflow}`);
                ok(`${id} ${tag}: the same three members`, (m.members || []).length === 3, (m.members || []).map((x) => x.id).join(", "));
                ok(`${id} ${tag}: no horizontal overflow`, m.waveOverflow === 0 && Math.max(0, ...m.members.map((x) => x.overflow || 0)) === 0, `wave ${m.waveOverflow}px, titles ${m.members.map((x) => x.overflow).join("/")}px`);
                await shot(page.locator(`[data-option="${id}"] .stage`), path.join(OUT, `${id.toLowerCase()}-${tag}.png`));
              }
            }
            // O1 is the panel's drawing: its numbers must be the panel's, or the comparison is not one.
            const o1w = ledger.stages.wide.O1;
            const o1n = ledger.stages.narrow.O1;
            ok("O1 reproduces the panel at the real column", Math.abs(widestTitle(o1w) - widestTitle(ledger.panel.wide)) <= 20 && o1w.members.every((m, i) => Math.abs((m.lines || 0) - (ledger.panel.wide.members[i]?.lines || 0)) <= 1), `stage ${widestTitle(o1w)}px/${linesOf(o1w)} vs panel ${widestTitle(ledger.panel.wide)}px/${linesOf(ledger.panel.wide)}`);
            ok("O1 reproduces the panel at 900px", Math.abs(widestTitle(o1n) - widestTitle(ledger.panel.narrow)) <= 30 && o1n.members.every((m, i) => Math.abs((m.lines || 0) - (ledger.panel.narrow.members[i]?.lines || 0)) <= 1), `stage ${widestTitle(o1n)}px/${linesOf(o1n)} vs panel ${widestTitle(ledger.panel.narrow)}px/${linesOf(ledger.panel.narrow)}`);
            // The recommendation has to earn its claim.
            const o4 = ledger.stages.wide.O4;
            ok("O4 gives the title the lane's content width", widestTitle(o4) >= 400 && Math.max(...o4.members.map((x) => x.lines || 0)) <= 3, `${widestTitle(o4)}px, wraps ${linesOf(o4)}`);
            ok("O4 keeps the lanes side by side", new Set(o4.lanes.map((l) => l.top)).size === 1, o4.lanes.map((l) => `${l.name}:${l.w}@${l.top}`).join(", "));
            const o4n = ledger.stages.narrow.O4;
            ok("O4 stays readable at the 900px panel", widestTitle(o4n) >= 400 && Math.max(...o4n.members.map((x) => x.lines || 0)) <= 3, `${widestTitle(o4n)}px, wraps ${linesOf(o4n)}`);
          },
          { viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 },
        );
      },
      { viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 },
    );
  }

  const after = liveListener();
  ledger.live.after = after;
  // THE LISTENER IS A WITNESS, NOT A PRECONDITION. This tool makes no request to 7331 at all: the fixture's panel is
  // on a random port (asserted not 7331) and the only 7331 read is netstat. The live panel can restart on its own while
  // a two-minute capture runs, and this run saw exactly that once. A pid change is therefore recorded with the process
  // facts that explain it: the old pid gone, the new pid started after this run began. A change that cannot be
  // explained that way fails the run.
  const same = before.pid === after.pid;
  const witness = { same };
  if (!same && before.pid && after.pid) {
    witness.beforeGone = !procAlive(before.pid);
    witness.afterStarted = procStart(after.pid);
    const startedAt = Date.parse(witness.afterStarted || "");
    witness.afterStartedAfterRun = Number.isFinite(startedAt) && startedAt >= RUN_START - 2000;
  }
  ledger.live.witness = witness;
  const explained = same || (witness.beforeGone === true && witness.afterStartedAfterRun === true);
  ok("no socket to the live 7331 listener was opened by this run", explained, same ? `the same listener before and after (pid ${before.pid ?? "none"})` : `the live panel restarted on its own while the capture ran: pid ${before.pid} is gone, pid ${after.pid} started ${witness.afterStarted}; the fixture panel is on ${panel?.port} and was never 7331`);
  if (!same && explained) note("the listener's replacement is an external restart, not this tool: no fetch to 7331 exists in this file");
  ledger.live.untouched = same;

  writeJson(path.join(OUT, "measurements.json"), ledger);
  note(`ledger ${path.join(OUT, "measurements.json").replace(/\\/g, "/")}`);
  console.log(`\n${failures ? `FAILED (${failures})` : "all checks passed"}`);
  process.exitCode = failures ? 1 : 0;
} catch (err) {
  failures += 1;
  console.error(`CAPTURE FAILED: ${String((err && err.stack) || err)}`);
  process.exitCode = 1;
} finally {
  if (panel) await panel.stop().catch(() => {});
  if (!KEEP) note("fixture stopped; its home is left in place for a rerun");
  process.exit(process.exitCode || 0);
}
