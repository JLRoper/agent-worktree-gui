// The Unattached agents card ships MINIMIZED, and only a reader's own gesture opens it (row 416).
// HARNESS: LIVE GATE - it tracks main, and `npm run verify:fixed-card-default` is how the repo runs it by name.
//
//   node tools/verify-fixed-card-default.mjs [--sandbox <dir>] [--shots <dir>] [--report <file.html>]
//
// The reader's ask: a hard refresh of the tab must not open the "unattached agents" card. It stays minimized on a
// fresh load, and expands only when (a) the reader clicks the card's own head, or (b) the reader follows an explicit
// link to an agent inside it. The card's default is the page's state now (FIXED_DEFAULT_COLLAPSED + wm.fixedChosen),
// not the class the last paint left behind, and a chosen expand survives a reload.
//
// Everything runs in a sandbox of its own: a throwaway repo, a throwaway state directory, its own PANEL_CONFIG and
// port, and an apiServer pointed at a dead port, so the live panel on 7331 and the live gateway are never touched.
// The sandbox is deleted at the end (KEEP_SANDBOX=1 keeps it).
//
// FOUR RENDERED CASES, each read from the DOM and quoted in the report:
//
//   1. a bare load with an empty profile - #agents carries fixed-collapsed, its body is display:none and 0px tall,
//      and #newagent is still open (the other fixed card's default is unchanged);
//   2. a click on the card's head opens it, the choice is written, and a reload comes back open;
//   3. a clear of the stores brings the default back, and a click on the Hot Agent search's row for the unattached
//      agent - the explicit link path - opens the card and lands on the card inside it;
//   4. the card survives the page's own repaint: a live snapshot arrives and the renderer's own renderJobs() /
//      renderConversation() run, with the card still in the state the reader left it (proved open, and proved
//      minimized on a repaint of the bare default).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT, configureRepo, freePort, git, startPanel, waitFor } from "./panel-testkit.mjs";

const args = process.argv.slice(2);
const argOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const dir = path.resolve(argOf("--sandbox") || path.join(os.tmpdir(), "wtgui-fixed-card-sandbox"));
const shotsDir = path.resolve(argOf("--shots") || path.join(dir, "shots"));
const reportPath = argOf("--report") ? path.resolve(argOf("--report")) : null;

let failures = 0;
let checks = 0;
const check = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
  return Boolean(cond);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(dir, { recursive: true, force: true });
mkdirSync(path.join(dir, "logs"), { recursive: true });
mkdirSync(shotsDir, { recursive: true });

// ---- the sandbox repo -------------------------------------------------------------------------------------------
const repos = path.join(dir, "repos");
const repo = path.join(repos, "sandbox-repo");
mkdirSync(repo, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
configureRepo(repo);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "seed the sandbox repo"]);

// One settled turn that NO worktree claims: no ownerPath, a prompt the Hot Agent search can match. That is what
// makes it an unattached agent, and the card under test is its home.
const THREAD = "tk-unattached-416";
const now = Date.now();
writeFileSync(
  path.join(dir, "logs", "jobs.json"),
  JSON.stringify(
    {
      savedAt: new Date(now).toISOString(),
      jobs: [
        {
          id: THREAD,
          thread: THREAD,
          turn: 0,
          prompt: "fixture: the unattached agent the card lists",
          status: "done",
          exitCode: 0,
          startedAt: new Date(now - 600_000).toISOString(),
          endedAt: new Date(now - 540_000).toISOString(),
          durationMs: 60_000,
          finalMessage: "done",
          cwd: repo,
          lines: [{ kind: "out", text: "the unattached card is here so the default has something to hide", lid: 1, at: now - 540_000 }],
        },
      ],
    },
    null,
    1,
  ),
  "utf8",
);

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  keep: Boolean(process.env.KEEP_SANDBOX),
  config: {
    scanRoots: [repos],
    refreshSeconds: 3,
    worktreeSeconds: 3,
    midSeconds: 8,
    dormantSeconds: 15,
    slowSeconds: 20,
    fetchSeconds: 3600,
    liveMinutes: 5,
    defaultCwd: repo,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});
const base = panel.base;

// Every fact the report quotes is read from the rendered page, in one shape, so the four cases are comparable.
const readCard = (page) =>
  page.evaluate((thread) => {
    const sec = document.getElementById("agents");
    const head = sec?.querySelector(".project-head[data-toggle-fixed]");
    const body = document.getElementById("jobs");
    const card = document.querySelector(`.job[data-thread="${thread}"]`);
    const newest = document.getElementById("newagent");
    return {
      at: new Date().toISOString(),
      agents: {
        cls: sec ? sec.className : null,
        collapsed: Boolean(sec && sec.classList.contains("fixed-collapsed")),
        headTitle: head ? head.getAttribute("title") : null,
        chev: head?.querySelector(".chev")?.textContent || null,
        height: sec ? Math.round(sec.getBoundingClientRect().height) : null,
      },
      body: {
        display: body ? getComputedStyle(body).display : null,
        height: body ? Math.round(body.getBoundingClientRect().height) : null,
        cards: document.querySelectorAll("#jobs .job[data-thread]").length,
        cardShown: Boolean(card && card.offsetParent),
        cardHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
      },
      newagent: {
        cls: newest ? newest.className : null,
        collapsed: Boolean(newest && newest.classList.contains("fixed-collapsed")),
        height: newest ? Math.round(newest.getBoundingClientRect().height) : null,
      },
      stored: {
        collapsedFixed: localStorage.getItem("wm.collapsedFixed"),
        fixedChosen: localStorage.getItem("wm.fixedChosen"),
      },
      snapshotAt: typeof state !== "undefined" ? state.lastSnapshotAt : null,
    };
  }, THREAD);

const waitExpanded = (page) => page.waitForFunction(() => !document.getElementById("agents").classList.contains("fixed-collapsed"), null, { timeout: 10_000 });
const waitCollapsed = (page) => page.waitForFunction(() => document.getElementById("agents").classList.contains("fixed-collapsed"), null, { timeout: 10_000 });

const cases = [];

try {
  const engine = loadPlaywright();
  if (!engine) {
    console.log(notRun("the fixed card's default", "no Playwright on this machine - set PANEL_PLAYWRIGHT_ROOT"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ page }) => {
        await openPage(page, base, { selector: "#agents" });
        await page.waitForSelector("#jobs .job[data-thread]", { state: "attached", timeout: 30_000 });

        // ---- case 1: a bare load, empty profile -----------------------------------------------------------------
        console.log("\n== 1. a bare load with no profile: the card is minimized ==");
        const bare = await readCard(page);
        check("#agents carries fixed-collapsed", bare.agents.collapsed === true, bare.agents.cls);
        check("…its body is not painted", bare.body.display === "none" && bare.body.height === 0, `display ${bare.body.display}, ${bare.body.height}px`);
        check("…the card is only its head tall", bare.agents.height > 0 && bare.agents.height < 120, `${bare.agents.height}px`);
        check("…the card inside it is not on screen", bare.body.cardShown === false, `cardShown ${bare.body.cardShown}`);
        check("#newagent keeps its shipped open default", bare.newagent.collapsed === false && bare.newagent.height > bare.agents.height, `${bare.newagent.cls}, ${bare.newagent.height}px`);
        check("the default is the page's state", String(bare.stored.collapsedFixed) === '["agents"]', bare.stored.collapsedFixed);
        check("…with no reader choice recorded", bare.stored.fixedChosen === null, String(bare.stored.fixedChosen));
        await page.screenshot({ path: path.join(shotsDir, "1-bare-load.png") });

        // A repaint of the bare default: the page's own anti-entropy resync (the 30 s clock's path) rebuilds the
        // board from the server, and the shipped renderers paint the unattached list again. No reload.
        const snapA = bare.snapshotAt;
        await page.evaluate(() => resync({ automatic: true }));
        await waitFor(async () => (await page.evaluate(() => state.lastSnapshotAt)) !== snapA, {
          timeoutMs: 20_000,
          what: "the page's own resync to repaint the board",
        });
        await page.evaluate(() => {
          window.WMApp.jobs.renderJobs();
          window.WMApp.jobs.renderConversation("tk-unattached-416");
        });
        await sleep(300);
        const bareRepaint = await readCard(page);
        check("a repaint of the bare default leaves it minimized", bareRepaint.agents.collapsed === true && bareRepaint.body.height === 0, `class ${bareRepaint.agents.cls}, ${bareRepaint.body.height}px`);

        // ---- case 2: the head click, and the reload that keeps it open -------------------------------------------
        console.log("\n== 2. a click on the head expands it, and the choice survives a reload ==");
        await page.click("#agents h2");
        await waitExpanded(page);
        const opened = await readCard(page);
        check("the head click removes fixed-collapsed", opened.agents.collapsed === false, opened.agents.cls);
        check("…the body is painted", opened.body.display !== "none" && opened.body.height > 0, `display ${opened.body.display}, ${opened.body.height}px`);
        check("…the unattached card is on screen", opened.body.cardShown === true && opened.body.cardHeight > 0, `card ${opened.body.cardHeight}px`);
        check("…and the choice is written", JSON.parse(opened.stored.fixedChosen || "[]").includes("agents"), opened.stored.fixedChosen);
        await page.screenshot({ path: path.join(shotsDir, "2-head-click.png") });

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#jobs .job[data-thread]", { state: "attached", timeout: 30_000 });
        await sleep(300);
        const reloaded = await readCard(page);
        check("a reload comes back open, because the reader chose it", reloaded.agents.collapsed === false && reloaded.body.height > 0, `${reloaded.agents.cls}, ${reloaded.body.height}px`);
        cases.push({ name: "2. Head click", fact: opened, extra: "reload", after: reloaded });

        // ---- case 3: the explicit link to an agent inside it ------------------------------------------------------
        console.log("\n== 3. the explicit link path: the Hot Agent search's row for the unattached agent ==");
        await page.evaluate(() => {
          localStorage.removeItem("wm.collapsedFixed");
          localStorage.removeItem("wm.fixedChosen");
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#jobs .job[data-thread]", { state: "attached", timeout: 30_000 });
        await waitCollapsed(page);
        const beforeLink = await readCard(page);
        check("a cleared store comes back minimized", beforeLink.agents.collapsed === true, beforeLink.agents.cls);

        await page.click("#ha-search-open");
        const row = page.locator(`.ha-search-row[data-thread="${THREAD}"]`);
        await row.waitFor({ timeout: 20_000 });
        await row.click();
        await waitExpanded(page);
        await sleep(600);
        const linked = await readCard(page);
        check("the agent link expands the card", linked.agents.collapsed === false, linked.agents.cls);
        check("…the linked card is on screen", linked.body.cardShown === true && linked.body.height > 0, `cardShown ${linked.body.cardShown}, ${linked.body.height}px`);
        check("…and the link did not become a stored fold choice", linked.stored.fixedChosen === null, String(linked.stored.fixedChosen));
        check("…its class comes from the page's state", linked.agents.cls.includes("project") && !linked.agents.cls.includes("fixed-collapsed"), linked.agents.cls);
        await page.screenshot({ path: path.join(shotsDir, "3-agent-link.png") });
        cases.push({ name: "3. Agent link", fact: linked, extra: "before", before: beforeLink });

        // ---- case 4: the page's own repaint ---------------------------------------------------------------------
        console.log("\n== 4. the page repaints itself: the card stays where the reader left it ==");
        const snapB = linked.snapshotAt;
        await page.evaluate(() => resync({ automatic: true }));
        await waitFor(async () => (await page.evaluate(() => state.lastSnapshotAt)) !== snapB, {
          timeoutMs: 20_000,
          what: "the page's own resync to repaint the board",
        });
        await page.evaluate(() => {
          window.WMApp.jobs.renderJobs();
          window.WMApp.jobs.renderConversation("tk-unattached-416");
        });
        await sleep(400);
        const repainted = await readCard(page);
        check("a repaint keeps the linked card expanded", repainted.agents.collapsed === false && repainted.body.height > 0, `class ${repainted.agents.cls}, ${repainted.body.height}px`);
        check("…the card inside it still on screen", repainted.body.cardShown === true, `cardShown ${repainted.body.cardShown}`);
        await page.screenshot({ path: path.join(shotsDir, "4-after-repaint.png") });
        cases.push({ name: "4. After repaint", fact: repainted, extra: "before", before: linked });

        // ---- the four cases, kept whole for the report -----------------------------------------------------------
        cases.unshift({ name: "1. Bare load", fact: bare, extra: "after a repaint", after: bareRepaint });
      },
      { viewport: { width: 1440, height: 900 } },
    );
  }
} catch (e) {
  failures += 1;
  console.log(`FAIL  the harness threw - ${String((e && e.message) || e)}`);
} finally {
  await panel.stop();
}

if (reportPath) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const shot = (name) => {
    const file = path.join(shotsDir, name);
    try {
      return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
    } catch {
      return "";
    }
  };
  const card = (c) => `
    <section class="case">
      <h2>${esc(c.name)}</h2>
      <div class="shots"><img src="${shot(c.name.startsWith("1") ? "1-bare-load.png" : c.name.startsWith("2") ? "2-head-click.png" : c.name.startsWith("3") ? "3-agent-link.png" : "4-after-repaint.png")}" alt="${esc(c.name)} rendered"></div>
      <h3>DOM at the case</h3>
      <pre>${esc(JSON.stringify(c.fact, null, 2))}</pre>
      <h3>${esc(c.extra)}</h3>
      <pre>${esc(JSON.stringify(c.after || c.before || {}, null, 2))}</pre>
    </section>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Unattached agents card - default minimized (row 416)</title>
<style>
  :root { color-scheme: dark; --bg:#14171c; --panel:#1b1f26; --line:#2b313c; --ink:#e6e9ef; --dim:#9aa4b2; --green:#5fd18b; --amber:#e0b25c; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px; background:var(--bg); color:var(--ink); font:14px/1.5 "Segoe UI",system-ui,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 10px; } h3 { font-size:12px; color:var(--dim); text-transform:uppercase; letter-spacing:.06em; margin:14px 0 6px; }
  .sub { color:var(--dim); margin:0 0 22px; }
  .verdict { display:inline-block; padding:2px 9px; border-radius:999px; background:${failures ? "#5a2a2a" : "#20402e"}; color:${failures ? "#f0a0a0" : "var(--green)"}; font-weight:600; }
  .case { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:0 0 18px; }
  .shots img { width:100%; height:auto; border:1px solid var(--line); border-radius:6px; background:#0f1115; }
  pre { margin:0; padding:12px 14px; background:#101318; border:1px solid var(--line); border-radius:6px; overflow:auto; font:12px/1.5 Consolas,"Cascadia Mono",monospace; color:#cfe3d6; }
  .note { color:var(--dim); font-size:12px; margin-top:10px; }
  table { border-collapse:collapse; width:100%; margin:8px 0 0; font-size:12px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  code { color:var(--amber); }
</style></head><body>
<h1>Unattached agents card - default minimized</h1>
<p class="sub">Row 416, measured ${esc(new Date().toISOString())} in headless Chromium at 1440x900 against a sandbox panel. <span class="verdict">${failures ? `${failures} failed of ${checks}` : `all ${checks} checks passed`}</span></p>
<p class="sub">The four cases are the reader's own: a bare load, a click of the card's head, a follow of an explicit link to an agent inside it, and the page's own repaint. Each block quotes the DOM state read at that moment.</p>
${cases.map(card).join("")}
<p class="note">Method: a throwaway repo and panel config, one settled turn with no ownerPath (an unattached agent), the page's own anti-entropy resync plus the shipped renderJobs()/renderConversation() as the repaint, and Playwright for every read. The sandbox and its port are gone when the run ends.</p>
</body></html>`;
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, html, "utf8");
  console.log(`REPORT  ${reportPath}`);
}

console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks`);
if (!checks) {
  console.log("nothing ran");
  process.exit(2);
}
if (failures) process.exit(1);
