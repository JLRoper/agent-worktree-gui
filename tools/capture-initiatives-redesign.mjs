#!/usr/bin/env node
// CAPTURE, not gate: every section of the assistant panel's Initiatives tab, photographed through the repo's own
// headless Chromium harness, with the numbers the critique is written from.
//
//   node tools/capture-initiatives-redesign.mjs --label before --out docs/reports/initiatives-redesign/before
//   node tools/capture-initiatives-redesign.mjs --label after  --out docs/reports/initiatives-redesign/after
//
// The panel is the fixture's own: `tools/initiatives-fixture.mjs` writes three projects with real git worktrees, four
// initiatives (one empty, one with a missing tree, one with a long multi-paragraph description) and two assistants'
// queues, then boots `server.js` with WAG_HOME under scratch. The reader's `~/.wag` and the live 7331 listener are
// never read or written. `--root` photographs another checkout (a `git archive` of the code before the redesign)
// through the same fixture, which is how a before-and-after pair is made without a second worktree.
//
// Each state writes a PNG and the measurement ledger is written once at the end:
//   01 default list        02 expanded card       03 attach and detach surface
//   04 empty tab           05 long description    06 empty initiative
//   07 narrow 900px        08 float at its widest 09 keyboard focus
//
// Exit: 0 captures written; 2 Playwright is not installed; 1 something threw.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, openPage, withBrowser, withPage } from "./browser.mjs";
import { buildFixture, defaultHome, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "./initiatives-fixture.mjs";
import { measureInteractions, measurePane, scoreInitiatives } from "./initiatives-measure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const LABEL = String(opt("--label", "after"));
const OUT = path.resolve(opt("--out", path.join(HERE, "..", "docs", "reports", "initiatives-redesign", LABEL)));
const HOME = path.resolve(opt("--home", path.join(defaultHome(), LABEL)));
const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const KEEP = argv.includes("--keep");

let failures = 0;
const note = (s) => console.log(`      ${s}`);
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};

const SHOTS = [];
// THE READER'S OWN PANEL, READ AND NEVER TOUCHED. One loopback listener on 7331, its pid, its process start time and
// its health. The capture records this before it boots anything and after it has stopped, and fails if the identity
// changed. Nothing here writes to ~/.wag or to the live process; the requests are GETs to /api/health.
const liveListener = async () => {
  const out = { at: new Date().toISOString(), line: null, pid: null, started: null, health: null };
  try {
    const netstat = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    out.line = netstat.split(/\r?\n/).map((l) => l.trim()).find((l) => /[:.]7331\s/.test(l) && /LISTENING/i.test(l)) || null;
    out.pid = out.line ? Number(out.line.split(/\s+/).pop()) : null;
  } catch (err) {
    out.error = `netstat: ${String(err.message || err)}`;
  }
  if (out.pid) {
    try {
      out.started = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${out.pid}).StartTime.ToUniversalTime().ToString('o')`],
        { encoding: "utf8", timeout: 10_000 },
      ).trim();
    } catch {
      /* a start time is evidence, not a precondition */
    }
  }
  try {
    const r = await fetch("http://127.0.0.1:7331/api/health", { signal: AbortSignal.timeout(4000) });
    out.health = { status: r.status, body: await r.json().catch(() => null) };
  } catch (err) {
    out.health = { error: String(err.message || err) };
  }
  return out;
};
const shot = async (page, slug, { pane = true, clipExtra = null } = {}) => {
  const file = path.join(OUT, `${slug}.png`);
  if (pane) {
    const box = await page.locator("#as-initiatives").boundingBox();
    if (!box) throw new Error(`no #as-initiatives box for ${slug}`);
    const vp = page.viewportSize();
    const x = Math.max(0, Math.floor(box.x));
    const y = Math.max(0, Math.floor(box.y));
    const width = Math.min(vp.width - x, Math.ceil(box.width));
    const height = Math.min(vp.height - y, Math.ceil(box.height));
    await page.screenshot({ path: file, clip: { x, y, width, height } });
  } else {
    await page.screenshot({ path: file });
  }
  SHOTS.push({ label: LABEL, slug, file: file.replace(/\\/g, "/") });
  note(`shot ${path.basename(file)}`);
  return file;
};

// A zoom of the control the keyboard has reached, so the ring is legible at the size the card is read. The clip is
// the same paint as the pane shot, not a re-focus: the active element is where the Tab left it.
const shotAroundFocus = async (page, slug) => {
  const box = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || !el.closest || !el.closest("#as-initiatives")) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, text: String(el.textContent || "").trim().slice(0, 40) };
  });
  if (!box) return null;
  const file = path.join(OUT, `${slug}.png`);
  const pad = 20;
  await page.screenshot({
    path: file,
    clip: { x: Math.max(0, Math.floor(box.x - pad)), y: Math.max(0, Math.floor(box.y - pad)), width: Math.ceil(box.width + pad * 2), height: Math.ceil(box.height + pad * 2) },
  });
  SHOTS.push({ label: LABEL, slug, file: file.replace(/\\/g, "/"), focus: box.text });
  note(`shot ${path.basename(file)} (focus: ${box.text})`);
  return file;
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
  await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });
  // The pane is rebuilt from a read; the first paint after the tab press can be the "reading" line.
  await page.waitForFunction(() => document.querySelectorAll("#as-initiatives .init-card").length >= 4, null, { timeout: 30_000 });
};

const scrollPaneTo = async (page, selector) => {
  await page.evaluate((sel) => {
    const pane = document.getElementById("as-initiatives");
    const target = document.querySelector(sel);
    if (!pane || !target) return;
    const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = Math.max(0, top - 12);
  }, selector);
  await page.waitForTimeout(150);
};

const expandFirstCard = async (page) => {
  const first = page.locator("#as-initiatives .init-card").first();
  const folded = await first.evaluate((el) => el.classList.contains("is-titlecard"));
  if (folded) await first.locator(".init-head-btn").click();
  await page.waitForSelector("#as-initiatives .init-card:not(.is-titlecard) .init-projects", { timeout: 10_000 });
};

const ensureCardOpen = async (page, id) => {
  const card = page.locator(`#as-initiatives [data-init-card="${id}"]`);
  if (!(await card.count())) throw new Error(`no initiative card ${id}`);
  if (await card.evaluate((el) => el.classList.contains("is-titlecard"))) await card.locator(".init-head-btn").click();
  await page.waitForSelector(`#as-initiatives [data-init-card="${id}"] .init-projects`, { timeout: 10_000 });
};

const measureBoth = async (page) => {
  const pane = await measurePane(page);
  const interactions = await measureInteractions(page);
  return { pane, interactions };
};

let panel = null;
try {
  mkdirSync(OUT, { recursive: true });
  console.log(`label: ${LABEL}`);
  console.log(`root:  ${ROOT.replace(/\\/g, "/")}`);
  console.log(`home:  ${HOME.replace(/\\/g, "/")}`);
  console.log(`out:   ${OUT.replace(/\\/g, "/")}`);

  const liveBefore = await liveListener();
  console.log(`live 7331 before: ${liveBefore.line || "no listener"}${liveBefore.started ? ` (started ${liveBefore.started})` : ""}, health ${liveBefore.health?.status ?? "none"}`);

  await buildFixture({ home: HOME, reset: true });
  const panel = await startFixturePanel({ home: HOME, root: ROOT });
  console.log(`panel: ${panel.base} (pid ${panel.pid})`);
  await waitForFixtureRows(panel.base);
  const view = await waitForInitiativesView(panel.base);
  ok("the fixture serves four initiatives over three projects", view.initiatives.length === 4, view.initiatives.map((i) => `${i.title.slice(0, 24)}:${i.treeCount}t/${i.projectCount}p`).join(", "));

  const playwright = loadPlaywright();
  let ledger = null;
  if (!playwright) {
    console.log(notRun("the initiatives captures", "playwright is not installed for this node (see tools/browser.mjs)"));
    process.exitCode = 2;
  } else {
    ledger = await withBrowser(
      async ({ page, browser }) => {
        const ledger = { label: LABEL, root: ROOT.replace(/\\/g, "/"), at: new Date().toISOString(), home: HOME.replace(/\\/g, "/"), live: { before: liveBefore }, shots: SHOTS };
        await openInitiatives(page, panel.base);

        // 1. THE DEFAULT LIST. Every card as it opens: a title card.
        await page.evaluate(() => {
          const pane = document.getElementById("as-initiatives");
          if (pane) pane.scrollTop = 0;
        });
        await shot(page, "01-default-list");
        await shot(page, "01b-default-list-full", { pane: false });

        // 2. AN EXPANDED CARD, with the other cards still folded around it.
        await expandFirstCard(page);
        await shot(page, "02-expanded-card");

        // 3. THE ATTACH AND DETACH SURFACE. A project is opened so a Remove control is on screen, and the add picker is
        //    opened below it, so the question and the take-away are photographed together.
        await page.click("#as-initiatives .init-card:not(.is-titlecard) [data-init-fold]");
        await page.waitForSelector("#as-initiatives .init-trees .init-tree", { timeout: 10_000 });
        await page.click("#as-initiatives .init-card:not(.is-titlecard) [data-init-add]");
        await page.waitForSelector("#as-initiatives [data-init-addform] select", { timeout: 10_000 });
        await scrollPaneTo(page, "#as-initiatives .init-trees");
        await page.waitForTimeout(250);
        await shot(page, "03-attach-detach");

        // The assistants fold is opened before the measurement so the assistant row - a control the rubric names - is
        // painted. It is not part of the attach screenshot: that one is about a tree and a picker.
        await page.click("#as-initiatives .init-card:not(.is-titlecard) [data-init-assist-fold]");
        await page.waitForSelector("#as-initiatives .init-assist-btn", { timeout: 10_000 });

        // 4. THE MEASUREMENTS AT THE READER'S RAIL. This is the state with a tree row, a Remove, a select and the add
        //    button all painted, so every control the rubric names is measurable.
        ledger.docked = await measureBoth(page);

        // 5. A LONG DESCRIPTION, whole. The Kafka card is opened and its description is unfolded if it was folded.
        await ensureCardOpen(page, "init_kafka");
        await page.evaluate(() => {
          const card = document.querySelector('#as-initiatives [data-init-card="init_kafka"]');
          const head = card?.querySelector(".init-desc-head");
          if (head && head.getAttribute("aria-expanded") !== "true") head.click();
        });
        await scrollPaneTo(page, '#as-initiatives [data-init-card="init_kafka"]');
        await page.waitForTimeout(200);
        await shot(page, "05-long-description");

        // 6. THE EMPTY INITIATIVE: a real card with no worktrees behind it.
        await ensureCardOpen(page, "init_sweeper");
        await page.waitForSelector("#as-initiatives [data-init-card=\"init_sweeper\"] .init-no-trees", { timeout: 10_000 });
        await scrollPaneTo(page, '#as-initiatives [data-init-card="init_sweeper"]');
        await page.waitForTimeout(150);
        await shot(page, "06-empty-initiative");

        // 7. KEYBOARD FOCUS on the first title card, reached by Tab rather than focus().
        await page.evaluate(() => {
          const pane = document.getElementById("as-initiatives");
          if (pane) pane.scrollTop = 0;
          document.querySelector("#as-tabs [data-as-tab=\"initiatives\"]")?.focus();
        });
        for (let i = 0; i < 40; i += 1) {
          await page.keyboard.press("Tab");
          if (await page.evaluate(() => Boolean(document.activeElement?.closest?.("#as-initiatives")))) break;
        }
        await page.waitForTimeout(120);
        await shot(page, "09-keyboard-focus");
        await shotAroundFocus(page, "09b-keyboard-focus-ring");

        // 8. THE EMPTY TAB. The store is moved aside for one honest read, the tab is refreshed, and the file is put
        //    back afterwards. The route, not a page fixture, answers `found: false`.
        const file = path.join(HOME, "state", "initiatives.json");
        const parked = `${file}.capture-bak`;
        renameSync(file, parked);
        try {
          await page.click("#as-initiatives [data-init-refresh]");
          await page.waitForSelector("#as-initiatives .init-empty", { timeout: 20_000 });
          await scrollPaneTo(page, "#as-initiatives .init-empty");
          await page.waitForTimeout(200);
          await shot(page, "04-empty-tab");
          ledger.empty = { pane: await measurePane(page) };
        } finally {
          renameSync(parked, file);
          await page.click("#as-initiatives [data-init-refresh]");
          await page.waitForSelector("#as-initiatives .init-card", { timeout: 20_000 });
        }

        // 9. THE FLOAT AT ITS WIDEST. The panel's one frame is switched to floating through its own route, and the
        //    remembered rect is the widest the clamp allows at 1400x1000: 1384px, the window less the two 8px edges.
        const switched = await fetch(`${panel.base}/api/settings/general`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dockMode: "floating" }),
          signal: AbortSignal.timeout(8000),
        });
        ok("the panel switched to the floating frame", switched.ok, `HTTP ${switched.status}`);
        await withPage(
          browser,
          async ({ page: wide }) => {
            await openInitiatives(wide, panel.base);
            await expandFirstCard(wide);
            await wide.click("#as-initiatives .init-card:not(.is-titlecard) [data-init-fold]");
            await wide.waitForSelector("#as-initiatives .init-trees .init-tree", { timeout: 10_000 });
            await wide.click("#as-initiatives .init-card:not(.is-titlecard) [data-init-add]");
            await wide.waitForSelector("#as-initiatives [data-init-addform] select", { timeout: 10_000 });
            const rect = await wide.evaluate(() => {
              const el = document.getElementById("assistant");
              const r = el.getBoundingClientRect();
              const pane = document.getElementById("as-initiatives").getBoundingClientRect();
              return { width: Math.round(r.width), height: Math.round(r.height), paneWidth: Math.round(pane.width) };
            });
            note(`float ${rect.width}x${rect.height}, pane ${rect.paneWidth}px`);
            await shot(wide, "08-float-widest");
            // A second capture of the wide list, folded, so the two-column structure (or its absence) is visible.
            await wide.evaluate(() => {
              const pane = document.getElementById("as-initiatives");
              if (pane) pane.scrollTop = 0;
            });
            await shot(wide, "08b-float-widest-top");
            await wide.click("#as-initiatives .init-card:not(.is-titlecard) [data-init-assist-fold]");
            await wide.waitForSelector("#as-initiatives .init-assist-btn", { timeout: 10_000 });
            ledger.wide = { pane: await measurePane(wide), interactions: await measureInteractions(wide), rect };
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

        // 10. A NARROW WINDOW, around 900px. The rail takes the default 480 and the board keeps its floor.
        await withPage(
          browser,
          async ({ page: narrow }) => {
            await openInitiatives(narrow, panel.base);
            const rail = await narrow.evaluate(() => Math.round(document.getElementById("assistant").getBoundingClientRect().width));
            note(`narrow 900px window, rail ${rail}px`);
            await shot(narrow, "07-narrow-900");
            await expandFirstCard(narrow);
            await shot(narrow, "07b-narrow-900-expanded");
            ledger.narrow = { pane: await measurePane(narrow), rail };
          },
          {
            viewport: { width: 900, height: 900 },
            deviceScaleFactor: 1,
            initScripts: [
              () => {
                localStorage.setItem("wm.assistantOpen", "1");
              },
            ],
          },
        );

        ledger.shots = SHOTS;
        ledger.score = {
          docked: scoreInitiatives(ledger.docked.pane, ledger.docked.interactions, { emptyPane: ledger.empty?.pane, widePane: ledger.wide?.pane }),
          wide: scoreInitiatives(ledger.wide.pane, ledger.wide.interactions, { emptyPane: ledger.empty?.pane, widePane: ledger.wide.pane }),
        };
        const verdict = ledger.score.docked;
        console.log(`\nscore (docked): ${verdict.passed}/${verdict.total} = ${(verdict.score * 100).toFixed(0)}%`);
        for (const c of verdict.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.detail ? `: ${c.detail}` : ""}`);
        const wideScore = ledger.score.wide;
        console.log(`score (wide):   ${wideScore.passed}/${wideScore.total} = ${(wideScore.score * 100).toFixed(0)}%`);
        const principled = [
          ...new Set(wideScore.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`)),
        ];
        if (principled.length) console.log(`wide-only misses: ${principled.join(" | ")}`);
        return ledger;
      },
      {
        viewport: { width: 1400, height: 1000 },
        deviceScaleFactor: 1,
        initScripts: [
          () => {
            localStorage.setItem("wm.assistantOpen", "1");
            localStorage.setItem("wm.assistantWidth", "480");
          },
        ],
      },
    );

    ledger.shots = SHOTS;
    console.log(`panel log: ${panel.log().split("\n").filter(Boolean).slice(-4).join(" || ") || "empty"}`);
  }

  await panel.stop();
  const liveAfter = await liveListener();
  const untouched = Boolean(liveBefore.pid && liveAfter.pid === liveBefore.pid && liveAfter.started === liveBefore.started && liveAfter.health?.status === liveBefore.health?.status);
  console.log(`live 7331 after:  ${liveAfter.line || "no listener"}${liveAfter.started ? ` (started ${liveAfter.started})` : ""}, health ${liveAfter.health?.status ?? "none"}`);
  ok("the reader's 7331 listener is the same process after the sandbox", untouched, `pid ${liveBefore.pid} -> ${liveAfter.pid}`);
  if (ledger) {
    ledger.live = { before: liveBefore, after: liveAfter, untouched };
    const ledgerFile = path.join(OUT, `measurements-${LABEL}.json`);
    writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    console.log(`ledger: ${ledgerFile.replace(/\\/g, "/")}`);
    console.log(`shots:  ${SHOTS.length} in ${OUT.replace(/\\/g, "/")}`);
  }
  console.log(`fixture kept at ${HOME.replace(/\\/g, "/")}`);
  process.exitCode = failures ? 1 : process.exitCode || 0;
} catch (err) {
  failures += 1;
  console.error(`CAPTURE FAILED: ${String((err && err.stack) || err)}`);
  process.exitCode = 1;
} finally {
  if (panel) await panel.stop().catch(() => {});
  // A harness that has written its files is done: an idle keep-alive socket or a Playwright helper must not hold the
  // node process open after the last line (measured: a failed run sat for the full terminal timeout with every
  // screenshot on disk). The exit code is the one set above.
  process.exit(process.exitCode || 0);
}
