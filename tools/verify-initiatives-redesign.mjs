#!/usr/bin/env node
// THE INITIATIVES REDESIGN, BEFORE AND AFTER: one deterministic gate over the tab's measured formatting.
//
//   node tools/verify-initiatives-redesign.mjs [--home <dir>] [--json <file>]
//
// WHAT THIS GATE PROVES. The brief asked for the Initiatives tab before and after a redesign, judged by numbers rather
// than by opinion. The redesign is scored on sixteen checks - type scale, contrast, the 4px spacing grid, control
// heights, chip fit, one reading edge, line length, the empty tab, the focus ring, hover, pressed, Enter on a fold,
// and whether a keyboard focus survives the pane's own four-second repaint. The "before" column is not recomputed from
// a copy of the old stylesheet at run time: it is the recorded measurement of the tree at 1.142.2, kept in
// tools/initiatives-redesign-baseline.json, and this gate fails if the current tree does not beat it.
//
// Two things this gate deliberately does NOT do: it never reads ~/.wag, and it never touches the reader's panel on
// port 7331. The fixture writes its own state under a scratch home, boots server.js on a free port, and the listener
// on 7331 is recorded before and after with its pid and health response.
//
// Exit codes: 0 green, 1 the after tree is not better than the baseline (or a check failed), 2 Playwright is missing so
// the measured half did not run at all.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, openPage, withBrowser, withPage } from "./browser.mjs";
import { buildFixture, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "./initiatives-fixture.mjs";
import { measureInteractions, measurePane, scoreInitiatives } from "./initiatives-measure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const HOME = path.resolve(opt("--home", path.join(os.tmpdir(), `wag-initiatives-gate-${process.pid}`)));
const JSON_OUT = path.resolve(opt("--json", path.join(ROOT, "docs", "reports", "initiatives-redesign", "gate.json")));
const BASELINE = path.join(HERE, "initiatives-redesign-baseline.json");
const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing.\n`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (s) => console.log(`      ${s}`);
const slash = (p) => String(p || "").replace(/\\/g, "/");

// The reader's panel, read only. A Windows host is this panel's home; elsewhere the health line stands alone.
async function liveListener() {
  let line = null;
  let pid = null;
  if (process.platform === "win32") {
    try {
      line = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 8000 })
        .split(/\r?\n/)
        .find((l) => /:7331\s+\S+\s+LISTENING/i.test(l)) || null;
      if (line) pid = Number(line.trim().split(/\s+/).pop()) || null;
    } catch {
      /* netstat is best effort */
    }
  }
  let health = null;
  for (let attempt = 0; attempt < 3 && !health; attempt += 1) {
    try {
      const r = await fetch("http://127.0.0.1:7331/api/health", { signal: AbortSignal.timeout(2500) });
      health = { status: r.status };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  return { line: line?.trim() || null, pid, health };
}

// The page steps, shared with the capture: open the assistant, press Initiatives, wait for the real route's cards.
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
  await page.waitForFunction(() => document.querySelectorAll("#as-initiatives .init-card").length >= 4, null, { timeout: 30_000 });
};

const expandFirstCard = async (page) => {
  const first = page.locator("#as-initiatives .init-card").first();
  if (await first.evaluate((el) => el.classList.contains("is-titlecard"))) await first.locator(".init-head-btn").click();
  await page.waitForSelector("#as-initiatives .init-card:not(.is-titlecard) .init-projects", { timeout: 10_000 });
};

// A named card, opened. The docked contrast sample needs the lane, and the lane is drawn only inside an open card:
// the fixture's first card (Kafka) has no waves, while Menu SSO carries the fixture's three. Opening the first card
// and measuring would keep the sample exactly where the review found it - outside the lane it was meant to read.
const expandCard = async (page, id) => {
  const head = page.locator(`#as-initiatives [data-init-card-toggle="${id}"]`);
  if (!(await head.count())) return false;
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await page.waitForSelector("#as-initiatives .wave-gate", { timeout: 10_000 });
  return true;
};

const openSurface = async (page) => {
  await expandFirstCard(page);
  await page.click("#as-initiatives .init-card:not(.is-titlecard) [data-init-fold]");
  await page.waitForSelector("#as-initiatives .init-trees .init-tree", { timeout: 10_000 });
  await page.click("#as-initiatives .init-card:not(.is-titlecard) [data-init-add]");
  await page.waitForSelector("#as-initiatives [data-init-addform] select", { timeout: 10_000 });
  const assist = await page.evaluate(() => {
    const fold = document.querySelector("#as-initiatives .init-card:not(.is-titlecard) [data-init-assist-fold]");
    if (fold && fold.getAttribute("aria-expanded") !== "true") fold.click();
    return Boolean(fold);
  });
  if (assist) await page.waitForSelector("#as-initiatives .init-assist-btn", { timeout: 10_000 }).catch(() => {});
};

const packageDeps = () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return {
    version: pkg.version,
    dependencies: Object.keys(pkg.dependencies || {}).length,
    devDependencies: Object.keys(pkg.devDependencies || {}).length,
    optionalDependencies: Object.keys(pkg.optionalDependencies || {}).length,
  };
};

const dashScan = () => {
  const tracked = ["public/assistant.js", "public/style.css"];
  const fresh = ["tools/initiatives-fixture.mjs", "tools/initiatives-measure.mjs", "tools/capture-initiatives-redesign.mjs", "tools/verify-initiatives-redesign.mjs"];
  const hits = [];
  const add = (rel, lineNo, text) => {
    if (text.includes("\u2014") || text.includes("\u2013")) hits.push(`${rel}:${lineNo}`);
  };
  for (const rel of fresh) {
    const file = path.join(ROOT, rel);
    if (!existsSync(file)) continue;
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => add(rel, i + 1, line));
  }
  // The two edited files carry old em dashes in comments that this change never touched. Only the ADDED lines are
  // judged: the working tree while the change is uncommitted, the commit itself once it has landed on the branch.
  let diff = "";
  try {
    const dirty = execFileSync("git", ["status", "--porcelain", "--", ...tracked], { cwd: ROOT, encoding: "utf8", timeout: 8000 }).trim();
    diff = execFileSync("git", dirty ? ["diff", "-U0", "--", ...tracked] : ["diff", "-U0", "HEAD^", "HEAD", "--", ...tracked], { cwd: ROOT, encoding: "utf8", timeout: 8000 });
  } catch {
    diff = "";
  }
  let rel = null;
  let lineNo = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      rel = line.slice(6);
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /\+\d+/.exec(line);
      lineNo = m ? Number(m[0].slice(1)) : 0;
      continue;
    }
    if (!rel) continue;
    if (line.startsWith("+")) {
      add(rel, lineNo, line);
      lineNo += 1;
    } else if (line.startsWith(" ")) {
      lineNo += 1;
    }
  }
  return hits;
};

let panel = null;
let result = null;
try {
  mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  const deps = packageDeps();
  ok("package.json still has zero dependencies", deps.dependencies + deps.devDependencies + deps.optionalDependencies === 0, `version ${deps.version}, dependencies ${deps.dependencies}, devDependencies ${deps.devDependencies}`);
  const dashes = dashScan();
  ok("the touched files use plain hyphens, never an em or en dash", dashes.length === 0, dashes.join(", ") || "none found");

  const liveBefore = await liveListener();
  console.log(`live 7331 before: ${liveBefore.line || "no listener"}, health ${liveBefore.health?.status ?? "none"}`);

  await buildFixture({ home: HOME, reset: true });
  panel = await startFixturePanel({ home: HOME, root: ROOT });
  console.log(`sandbox: ${panel.base} (pid ${panel.pid}), WAG_HOME ${slash(HOME)}`);
  await waitForFixtureRows(panel.base);
  const view = await waitForInitiativesView(panel.base);
  ok("the fixture serves four initiatives, one of them empty", view.initiatives.length === 4 && view.initiatives.some((i) => i.treeCount === 0), view.initiatives.map((i) => `${i.title.slice(0, 22)}:${i.treeCount}t/${i.projectCount}p`).join(", "));

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the initiatives redesign gate", "playwright is not installed for this node (see tools/browser.mjs)"));
    process.exitCode = 2;
  } else {
    result = await withBrowser(async ({ page, browser, pageErrors, consoleErrors }) => {
      const out = { at: new Date().toISOString(), version: deps.version, home: slash(HOME), live: { before: liveBefore } };
      await openInitiatives(page, panel.base);
      await openSurface(page);
      // ...and the card that carries the fixture's waves, so the docked sample enters the lane as well as the folded
      // rows. A false here is not fatal to the run: the contrast-sample check fails and says so.
      const laneOpen = await expandCard(page, "init_sso");
      out.docked = { laneOpen, pane: await measurePane(page), interactions: await measureInteractions(page) };

      // THE EMPTY TAB: the store is moved aside for one read, then put back. The route answers `found: false`; no
      // markup is faked.
      const file = path.join(HOME, "state", "initiatives.json");
      const parked = `${file}.gate-bak`;
      renameSync(file, parked);
      try {
        await page.click("#as-initiatives [data-init-refresh]");
        await page.waitForSelector("#as-initiatives .init-empty", { timeout: 20_000 });
        out.empty = { pane: await measurePane(page) };
      } finally {
        renameSync(parked, file);
        await page.click("#as-initiatives [data-init-refresh]");
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 20_000 });
      }

      // THE NARROW WINDOW, around 900px: the rail is half the window, and the pane must not scroll sideways.
      await page.setViewportSize({ width: 900, height: 900 });
      await page.waitForTimeout(300);
      await openInitiatives(page, panel.base);
      await expandFirstCard(page);
      out.narrow = await page.evaluate(() => {
        const pane = document.getElementById("as-initiatives");
        const card = pane.querySelector(".init-card:not(.is-titlecard)");
        const right = pane.getBoundingClientRect().right;
        const over = [...pane.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > right + 1).length;
        return { width: Math.round(pane.clientWidth), scrollWidth: pane.scrollWidth, clientWidth: pane.clientWidth, overflowing: over, cardWidth: card ? Math.round(card.getBoundingClientRect().width) : null };
      });
      await page.setViewportSize({ width: 1440, height: 900 });

      // THE WIDE FLOAT: the second column is deliberate, so this run is about line length and the assistant row, not
      // the one-column left edge. The panel is switched through its own route.
      const switched = await fetch(`${panel.base}/api/settings/general`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dockMode: "floating" }),
        signal: AbortSignal.timeout(8000),
      });
      ok("the panel switched to the floating frame through its own route", switched.ok, `HTTP ${switched.status}`);
      await withPage(
        browser,
        async ({ page: wide }) => {
          await openInitiatives(wide, panel.base);
          await openSurface(wide);
          await expandCard(wide, "init_sso");
          out.wide = { pane: await measurePane(wide), interactions: await measureInteractions(wide) };
        },
        {
          viewport: { width: 1400, height: 1000 },
          deviceScaleFactor: 1,
          initScripts: [
            () => {
              localStorage.setItem("wm.assistantOpen", "1");
              localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 8, y: 80, w: 1384, h: 860 }));
            },
          ],
        },
      );
      await fetch(`${panel.base}/api/settings/general`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dockMode: "docked" }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});

      out.pageErrors = pageErrors.slice();
      out.consoleErrors = consoleErrors.slice();
      return out;
    });

    const after = scoreInitiatives(result.docked.pane, result.docked.interactions, { emptyPane: result.empty.pane, widePane: result.wide.pane });
    const wide = scoreInitiatives(result.wide.pane, result.wide.interactions, { emptyPane: result.empty.pane, widePane: result.wide.pane });
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    const beforeById = new Map(baseline.checks.map((c) => [c.id, c]));

    console.log(`\nscore (docked): ${after.passed}/${after.total} = ${(after.score * 100).toFixed(0)}%   before ${baseline.passed}/${baseline.total} = ${((baseline.passed / baseline.total) * 100).toFixed(0)}%`);
    for (const c of after.checks) {
      const was = beforeById.get(c.id);
      const delta = was ? `${was.ok ? "PASS" : "FAIL"} -> ${c.ok ? "PASS" : "FAIL"}` : "new";
      console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label} [${delta}]${c.detail ? `: ${c.detail}` : ""}`);
    }

    ok("the redesign passes every docked check", after.passed === after.total, `${after.passed}/${after.total}`);
    ok("the redesign scores strictly better than the recorded before", after.passed > baseline.passed, `${baseline.passed} -> ${after.passed}`);
    const regressed = [...beforeById.values()].filter((c) => c.ok && !after.checks.find((a) => a.id === c.id)?.ok).map((c) => c.id);
    ok("no check that passed before regressed", regressed.length === 0, regressed.join(", ") || "none");

    const wideMisses = wide.checks.filter((c) => !c.ok);
    const wideAllowed = new Set(["alignment"]);
    const wideReal = wideMisses.filter((c) => !wideAllowed.has(c.id));
    ok("the wide float keeps every check except the deliberate second column", wideReal.length === 0, wideMisses.map((c) => c.id).join(", ") || "none");
    const line = result.wide.pane?.lineLength?.charsPerLine ?? null;
    note(`wide: ${wide.passed}/${wide.total}, line length ${line ?? "?"} ch`);

    ok("the 900px window does not scroll the pane sideways", result.narrow.scrollWidth <= result.narrow.clientWidth + 1, `pane ${result.narrow.width}px, scrollWidth ${result.narrow.scrollWidth}, ${result.narrow.overflowing} element(s) past its right edge`);
    ok("zero page errors and zero console errors", result.pageErrors.length === 0 && result.consoleErrors.length === 0, `${result.pageErrors.length} page, ${result.consoleErrors.length} console`);

    const liveAfter = await liveListener();
    console.log(`live 7331 after:  ${liveAfter.line || "no listener"}, health ${liveAfter.health?.status ?? "none"}`);
    ok("the reader's 7331 listener is the same process after the sandbox", liveBefore.pid === liveAfter.pid, `pid ${liveBefore.pid ?? "none"} -> ${liveAfter.pid ?? "none"}, health ${liveBefore.health?.status ?? "none"} -> ${liveAfter.health?.status ?? "none"}`);

    const record = {
      at: result.at,
      version: result.version,
      home: result.home,
      baseline: { passed: baseline.passed, total: baseline.total, source: baseline.source },
      after: { passed: after.passed, total: after.total, score: after.score, checks: after.checks },
      wide: { passed: wide.passed, total: wide.total, misses: wideMisses.map((c) => c.id) },
      narrow: result.narrow,
      live: { before: liveBefore, after: liveAfter, untouched: liveBefore.pid === liveAfter.pid },
      pageErrors: result.pageErrors,
      consoleErrors: result.consoleErrors,
    };
    writeFileSync(JSON_OUT, JSON.stringify(record, null, 2) + "\n");
    console.log(`ledger: ${slash(JSON_OUT)}`);
  }
} finally {
  await panel?.stop?.();
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* a busy file is not a failed gate */
  }
  clearTimeout(watchdog);
}

if (process.exitCode === 2) process.exit(2);
console.log(failures === 0 ? `\nGATE GREEN: ${checks - failures}/${checks} claims` : `\nGATE RED: ${failures} of ${checks} claims failed`);
process.exit(process.exitCode || (failures ? 1 : 0));
