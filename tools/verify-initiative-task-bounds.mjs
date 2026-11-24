#!/usr/bin/env node
// THE INITIATIVE CARD'S TASK ROWS, BOUNDED BY THE CARD - measured on the live page, never read from the source.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiative-task-bounds.mjs [--shots <dir>] [--root <export dir>]
//
// THE DEFECT this gate exists for. The task rows under an initiative's Assistants fold ran past the card's content
// edge into the gutter - the reader's screenshot showed #500/#449/#450 overshooting by about 65px while #431/#335/#329
// stopped at the edge. The mechanism is one CSS rule: `.init-tasks` was `flex: 1 0 100%` with the default
// `min-width: auto`, so as a flex item its automatic minimum size was the MIN-CONTENT width of the cards inside it.
// A compact card's title is one nowrap line, so the list took its width from the longest title: measured 1180.31px
// inside a 463px card, every row 1163.31px wide, and the card itself carrying a 792px horizontal scroll. At a wider
// pane the same rows still measured +369.31px past the card's content edge.
//
// WHAT THIS GATE PROVES, for EVERY row in the fold, at the narrow dock (480px) AND a wide float (1120px, which is
// the other drawing - the card becomes a grid across the 1000px container query), with the three states that used to
// render differently seeded at once:
//
//   1. THE FIXTURE IS THE THREE STATES. A row with a long title, a row with a long thread name, and a row with NO
//      thread at all are on the fold - so a fixture that stopped seeding one of them fails here instead of passing
//      vacuously.
//   2. EVERY ROW IS INSIDE THE CARD. Each row's border-box right edge is at or left of the card's content-box right
//      edge (delta 0 or negative), and no descendant of a row paints past the row's own right edge.
//   3. NO ROW IS WIDER THAN ITS BOX. Every row's `scrollWidth` equals its `clientWidth`, so a row cannot be sized by
//      its own content and scroll its text inside itself.
//   4. THE CARD HAS NO HORIZONTAL SCROLLBAR. The card's `scrollWidth` equals its `clientWidth` at both widths, on
//      every open card in the tab and not only the measured one.
//   5. THE INFORMATION SURVIVES. The long title still reads in full in the DOM and in `title=` and is ellipsized by
//      the one-line rule (it is cut, not dropped); the long thread name still reads in full; the no-thread row still
//      says "no agent yet"; the clock still rides the facts line.
//   6. TWO WIDTHS, TWO DRAWINGS. The card paints as a block in the dock and as a grid in the wide float, so the two
//      measurements are two layouts and not the same one done twice.
//
// Sandbox only: throwaway repos with hand-cut worktrees, its own PANEL_CONFIG and port, an apiServer on a dead port.
// The live panel and gateway are never touched. Without Playwright the script says BROWSER-NOT-RUN and exits 2.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT, freePort, git, startPanel, waitForRow } from "./panel-testkit.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let failures = 0;
let checks = 0;
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

const args = process.argv.slice(2);
const opt = (flag, fallback = null) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const shotsDir = path.resolve(opt("--shots", path.join(os.tmpdir(), "wtgui-initiative-task-bounds-shots")));
const rootArg = opt("--root", null);

// The two states of the card, and the pane width each is measured at. 480 is the docked rail's own width; 1120 puts
// the tab's container over the 1000px query, where the card is a two-column grid.
const DOCKED = 480;
const FLOAT_W = 1120;
const VIEWPORT = 1600;

const LONG_TITLE =
  "Landed PictureViewer PR #7 on master: 20261021_0005_DMR-39015_pictureViewerSso at 1af26850, thirteen commits ahead of the release branch and two behind it, waiting on the review vehicle to close";
const LONG_THREAD = "wtgui-initiatives-draw-the-assistant-s-tasks-under-an-initiative-without-overflowing-the-card";
const BODIES = {
  1: "A long title with a long thread",
  2: "A short title with the same long thread",
  3: "A long title with no thread at all",
  4: "A short title with no thread",
  5: "A normal title with a normal thread",
  6: "A parked row with no thread",
  7: "A done row with a thread",
  8: "A third long title with the long thread again",
};

// ---- the sandbox -------------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-initiative-bounds-"));
const repos = path.join(dir, "repos");
mkdirSync(shotsDir, { recursive: true });
const repo = path.join(repos, "alpha");
mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# alpha\n", "utf8");
git(repo, ["add", "-A"]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "seed the sandbox repo"]);
const trees = {};
for (const name of ["sso-one", "menu-one"]) {
  const where = path.join(repo, ".worktrees", name);
  git(repo, ["worktree", "add", "-q", "-b", `work/${name}`, where]);
  writeFileSync(path.join(where, `${name}.txt`), "sandbox work\n", "utf8");
  git(where, ["add", "-A"]);
  git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", `do the ${name} work`]);
  trees[name] = where;
}

const panel = await startPanel({
  dir,
  root: rootArg ? path.resolve(rootArg) : ROOT,
  port: await freePort(),
  config: {
    refreshSeconds: 3,
    worktreeSeconds: 2,
    midSeconds: 8,
    dormantSeconds: 15,
    slowSeconds: 20,
    fetchSeconds: 3600,
    scanMode: "all",
    defaultCwd: repo,
    projects: [{ name: "alpha", path: repo, remote: "origin", mainBranch: "main" }],
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});

const base = panel.base;
const GET = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const POST = async (p, body) => {
  const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const iso = (ms) => new Date(Date.now() - ms).toISOString();

let shotNo = 0;
const shotName = (slug) => path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);

try {
  console.log(`sandbox: ${base}`);
  console.log(`panel pid: ${panel.pid}`);
  console.log(`shots:   ${shotsDir}`);

  for (const where of Object.values(trees)) await waitForRow(base, "alpha", where, { timeout: 60_000 });
  ok("both trees are rows on the board", true, Object.keys(trees).join(", "));

  const tier = await POST("/api/settings/initiative-tier", { tier: "none" });
  ok("the initiative tier asks nothing, so the setup is not a stream of dock cards", tier.status === 200, `HTTP ${tier.status}`);

  // ---- the queue: eight rows, the three states the brief names, on the trees the initiative carries --------------
  // The sandbox may boot with no assistant record; the queue route's list form says which one exists, and an empty
  // list gets one made the way the reader's own "+ assistant" press makes it.
  let queues = (await GET("/api/assistant/queue")).body?.queues || [];
  if (!queues.length) {
    const made = await POST("/api/assistant/assistants", {});
    ok("the sandbox gets an assistant to own the rows", made.status === 201, `HTTP ${made.status}`);
    queues = (await GET("/api/assistant/queue")).body?.queues || [];
  }
  ok("the panel has an assistant with a queue", queues.length > 0, queues.map((q) => q.assistantId).join(", "));
  const own = String(queues[0]?.assistantId || "assistant-1");
  const queue = (await GET(`/api/assistant/queue?assistantId=${own}`)).body?.queue;
  ok("the queue route names the file it reads", Boolean(queue?.file), slash(queue?.file));
  const task = (id, title, state, thread, where, extra = {}) => ({
    id,
    title,
    state,
    worktree: slash(where),
    project: "alpha",
    thread,
    threads: thread ? [thread] : [],
    createdAt: iso(id * 1000),
    detail: "",
    files: [],
    attempts: 0,
    movedFrom: [],
    ...extra,
  });
  const tasks = [
    task(1, LONG_TITLE, "running", LONG_THREAD, trees["sso-one"], { startedAt: iso(60_000), runId: "run-1" }),
    task(2, BODIES[2], "running", LONG_THREAD, trees["menu-one"], { startedAt: iso(120_000), runId: "run-2" }),
    task(3, LONG_TITLE, "queued", "", trees["sso-one"]),
    task(4, BODIES[4], "queued", "", trees["menu-one"]),
    task(5, BODIES[5], "queued", "wtgui-menu-sso-state-cookie", trees["sso-one"]),
    task(6, BODIES[6], "parked", "", trees["menu-one"], { reason: "waiting on the DBA" }),
    task(7, BODIES[7], "done", "wtgui-node-switch-retry", trees["sso-one"], { doneAt: iso(600_000) }),
    task(8, "Third long title: rotate the Event Hubs certificate without a rollback path, then prove the consumer still reads the retry topic", "queued", LONG_THREAD, trees["menu-one"]),
  ];
  writeFileSync(queue.file, `${JSON.stringify({ version: 1, nextId: 100, tasks }, null, 1)}\n`, "utf8");

  // ---- one initiative carrying both trees -----------------------------------------------------------------------
  const made = await POST("/api/initiatives", { title: "The rows this gate measures" });
  ok("an initiative is created", made.status === 201 && Boolean(made.body?.initiative?.id), `HTTP ${made.status}`);
  const initId = String(made.body?.initiative?.id || "");
  for (const where of Object.values(trees)) {
    const moved = await POST("/api/initiatives/move", { tree: slash(where), initiative: initId, action: "add", by: "reader" });
    ok(`a tree is attached to it (${path.basename(where)})`, moved.status === 200 && moved.body?.changed === true, `HTTP ${moved.status}`);
  }
  const view = (await GET("/api/initiatives")).body;
  const entry = (view.initiatives || []).find((i) => i.id === initId);
  const wire = (entry?.assistants || []).find((a) => a.id === own);
  ok("the wire hands the fold all eight rows", (wire?.taskRows || []).length === 8, `${(wire?.taskRows || []).length} rows`);

  const playwright = loadPlaywright({ root: rootArg ? path.resolve(rootArg) : undefined });
  if (!playwright) {
    console.log(notRun("the bounded task rows", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        const openTab = async () => {
          const open = await page.evaluate(() => {
            const el = document.getElementById("assistant");
            return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
          });
          if (!open) await page.click("#btn-assistant");
          await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
          await page.click('#as-tabs [data-as-tab="initiatives"]');
          await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 15_000 });
        };
        // The reader's own walk: the initiative opens, its Assistants fold opens, the assistant's tasks fold opens,
        // and "Show more" draws the rest of the fold's window.
        const openFold = async () => {
          await openTab();
          const toggle = page.locator(`[data-init-card="${initId}"] [data-init-card-toggle]`);
          await page.waitForSelector(`[data-init-card="${initId}"] [data-init-card-toggle]`, { timeout: 25_000 });
          if ((await toggle.getAttribute("aria-expanded")) !== "true") {
            await toggle.click();
            await page.waitForTimeout(400);
          }
          await page.waitForSelector(`[data-init-card="${initId}"] [data-init-assist-fold]`, { timeout: 25_000 });
          const assists = page.locator(`[data-init-card="${initId}"] [data-init-assist-fold]`);
          if ((await assists.getAttribute("aria-expanded")) !== "true") await assists.click();
          const fold = page.locator(`[data-init-card="${initId}"] [data-init-assistant-row="${own}"] [data-init-task-fold]`);
          await page.waitForSelector(`[data-init-card="${initId}"] [data-init-assistant-row="${own}"] [data-init-task-fold]`, { timeout: 15_000 });
          if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
          await page.waitForFunction(
            ([id, aid, n]) => document.querySelectorAll(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-tasks] .as-task`).length >= n,
            [initId, own, Math.min(6, tasks.length)],
            { timeout: 25_000 },
          );
          const more = page.locator(`[data-init-card="${initId}"] [data-init-assistant-row="${own}"] [data-init-tasks-more]`);
          if (await more.count()) {
            await more.click();
            await page.waitForTimeout(400);
          }
          await page.waitForFunction(
            ([id, aid, n]) => document.querySelectorAll(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-tasks] .as-task`).length === n,
            [initId, own, tasks.length],
            { timeout: 15_000 },
          );
        };
        // ONE READ, every number this gate asserts: the card's content box, every row's edges, every descendant's
        // right edge, each row's own scroll, and the two bits of text the three states differ in.
        const read = async (label) => {
          const out = await page.evaluate(
            ([id, titles, thread]) => {
              const round = (n) => +n.toFixed(2);
              const card = document.querySelector(`[data-init-card="${id}"]`);
              const cs = getComputedStyle(card);
              const cr = card.getBoundingClientRect();
              const contentRight = cr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
              const contentLeft = cr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
              const box = card.querySelector("[data-init-tasks]");
              const rows = [...box.querySelectorAll(".as-task")].map((row) => {
                const r = row.getBoundingClientRect();
                const title = row.querySelector(".as-task-title");
                const threadEl = row.querySelector(".as-task-agent-thread");
                return {
                  id: row.dataset.initTaskCard,
                  right: round(r.right),
                  left: round(r.left),
                  width: round(r.width),
                  deltaRight: round(r.right - contentRight),
                  deltaLeft: round(r.left - contentLeft),
                  scroll: row.scrollWidth - row.clientWidth,
                  kids: [...row.querySelectorAll("*")].filter((n) => {
                    const k = n.getBoundingClientRect();
                    return k.width > 0 && (k.right - r.right > 0.5 || r.left - k.left > 0.5);
                  }).length,
                  titleText: title?.textContent || "",
                  titleAttr: title?.getAttribute("title") || "",
                  titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : false,
                  agent: row.querySelector(".as-task-agent")?.textContent.trim() || "",
                  threadText: threadEl?.textContent || "",
                  when: row.querySelector(".as-task-when")?.textContent.trim() || "",
                  head: [...(row.querySelector(".as-task-head")?.children || [])].map((n) => (n.className || "").split(" ")[0]),
                };
              });
              const open = [...document.querySelectorAll("#as-initiatives .init-card:not(.is-titlecard)")].map((c) => ({
                id: c.dataset.initCard,
                scroll: c.scrollWidth - c.clientWidth,
                width: round(c.getBoundingClientRect().width),
                display: getComputedStyle(c).display,
              }));
              return {
                card: { right: round(cr.right), contentRight: round(contentRight), contentLeft: round(contentLeft), width: round(cr.width), scroll: card.scrollWidth - card.clientWidth, display: cs.display },
                box: { width: round(box.getBoundingClientRect().width), delta: round(box.getBoundingClientRect().right - contentRight), scroll: box.scrollWidth - box.clientWidth },
                rows,
                open,
                wantTitle: titles,
                wantThread: thread,
              };
            },
            [initId, LONG_TITLE, LONG_THREAD],
          );
          return { ...out, label };
        };
        const assertReading = async (r) => {
          note(`${r.label}: card ${r.card.width}px (${r.card.display}), list ${r.box.width}px, ${r.rows.length} rows`);
          ok(`${r.label}: every task row in the fold is drawn`, r.rows.length === 8, `${r.rows.length} of 8`);
          const out = r.rows.filter((x) => x.deltaRight > 0);
          ok(`${r.label}: every row's right edge is at or left of the card's content edge`, out.length === 0, out.length ? out.map((x) => `#${x.id} +${x.deltaRight}px`).join(", ") : r.rows.map((x) => `#${x.id} ${x.deltaRight}`).join(" "));
          ok(`${r.label}: no row starts left of the card's content edge`, r.rows.every((x) => x.deltaLeft >= 0), r.rows.map((x) => `#${x.id} +${x.deltaLeft}`).join(" "));
          ok(`${r.label}: no row is sized by its own content (scrollWidth = clientWidth)`, r.rows.every((x) => x.scroll === 0), r.rows.map((x) => `#${x.id} ${x.scroll}`).join(" "));
          ok(`${r.label}: nothing inside a row paints outside it`, r.rows.every((x) => x.kids === 0), r.rows.map((x) => `#${x.id} ${x.kids}`).join(" "));
          ok(`${r.label}: the card has no horizontal scrollbar`, r.card.scroll === 0, `scrollWidth - clientWidth ${r.card.scroll}`);
          ok(`${r.label}: every open card in the tab has no horizontal scrollbar`, r.open.every((c) => c.scroll === 0), r.open.map((c) => `${c.id || "card"} ${c.scroll}`).join(", "));
          // The three states, each on its own row, and each row keeps everything it says today.
          const long = r.rows.find((x) => x.id === "1");
          const longThread = r.rows.find((x) => x.id === "2");
          const none = r.rows.find((x) => x.id === "3");
          ok(`${r.label}: the long title is still there in full, in the DOM and in title=`, long?.titleText === r.wantTitle && long?.titleAttr === r.wantTitle, `${String(long?.titleText).slice(0, 30)}...`);
          ok(`${r.label}: the long title is ellipsized rather than widening the row`, long?.titleClipped === true, String(long?.titleClipped));
          ok(`${r.label}: the long thread name is still there in full`, longThread?.threadText === r.wantThread, String(longThread?.threadText).slice(0, 30));
          ok(`${r.label}: a row with no thread still says "no agent yet"`, none?.agent === "no agent yet", none?.agent);
          ok(`${r.label}: every row keeps its four-part head`, r.rows.every((x) => JSON.stringify(x.head) === JSON.stringify(["as-task-mark", "mono", "as-task-state", "as-task-title"])), JSON.stringify(r.rows[0]?.head));
          ok(`${r.label}: every row keeps its clock on the facts line`, r.rows.every((x) => / ago$|no time recorded/.test(x.when)), r.rows.map((x) => x.when).join(" | ").slice(0, 60));
        };

        await openPage(page, base, { selector: "section.project" });
        await openFold();
        const docked = await read("docked-480");
        await assertReading(docked);
        ok("the docked pane drew the card as a block", docked.card.display === "block", docked.card.display);
        ok("the docked pane is the 480px rail, not a stunted float", Math.abs(docked.card.width - DOCKED) <= 40, `${docked.card.width}px`);
        await page.screenshot({ path: shotName("docked-480") });

        // The wide drawing: the float at 1120, over the tab's 1000px container query, so the card is a grid.
        await page.evaluate((w) => localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 20, y: 20, w, h: 900 })), FLOAT_W);
        const flip = await POST("/api/settings/general", { dockMode: "floating" });
        ok("the panel is switched to the floating frame", flip.status === 200, `HTTP ${flip.status}`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 45_000 });
        await page.waitForTimeout(800);
        await openFold();
        const wide = await read("floating-1120");
        await assertReading(wide);
        ok("the wide pane drew the card as a grid - a second layout, not the same one twice", wide.card.display === "grid", wide.card.display);
        ok("the two widths really are two widths", wide.card.width - docked.card.width > 300, `${docked.card.width}px then ${wide.card.width}px`);
        await page.screenshot({ path: shotName("floating-1120") });

        ok("no page errors anywhere in the run", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
        ok("no console errors anywhere in the run", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
      },
      { viewport: { width: VIEWPORT, height: 1000 } },
    );
  }
} finally {
  clearTimeout(watchdog);
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}${failures ? "" : " - INITIATIVE-TASK-BOUNDS-OK"}`);
process.exit(failures ? 1 : 0);
