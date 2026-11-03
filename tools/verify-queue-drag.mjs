// The queue pane's drag: a card moved to a new place PERSISTS, a held card snaps back with one line, and a plain
// click still opens its agent.
//
//   node tools/verify-queue-drag.mjs
//
// Brief (queue row #72): reorder the cards by dragging, blocked where a hold blocks. The three things that can only be
// proved outside the unit tests are the ones this gate drives, in order:
//
//   1. the model and the route, without a browser: `reorder` takes the full ordered id list, writes it in one
//      document, and reads back in that order; a list that crosses a state bucket, names a stranger, or puts a queued
//      row above the row it holds for is refused with a sentence — and leaves queue.json byte-identical;
//   2. a panel of its own (a throwaway data directory, a scanned repo, a free port) with a SEEDED queue file written
//      straight to disk: one running row, four queued ones (the last of them holding on the first), a parked one and a
//      done one. Only the queued cards are draggable, and only the holding card wears a hold badge;
//   3. the real pane in headless Chromium: a POINTER drag of a queued card above another lands in the new order, the
//      same order comes back from `/api/assistant/queue`, it survives a page RELOAD and the pane's own Refresh, and
//      the drag itself never opened a card;
//   4. the blocked drop: dragging the holding card above the row it holds for snaps back to the order it had, says
//      one line naming that row, sends no write, and leaves the server's queue exactly as it was;
//   5. the click: a plain press-and-release on a card body still leaves the queue pane for its agent — the opener the
//      drag had to learn not to swallow.
//
// This gate is meant to be RED on the tree it replaces: main has no `order`, no reorder action and no draggable cards,
// so the route check is the first to fail and every browser check that reads a card's drag state fails with it. The
// red run is quoted in the commit and the PR.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { freePort, ROOT, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright } from "./browser.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 240_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const slash = (p) => String(p || "").replace(/\\/g, "/");
const dragFailure = (e) => `drag failed: ${String((e && e.message) || e)}`;

const outDir = process.env.QUEUE_DRAG_OUT || path.join(tmpdir(), "wtgui-queue-drag");
mkdirSync(outDir, { recursive: true });

const at = new Date("2026-11-02T09:00:00.000Z").toISOString();
// The seed, in the order the pane draws it with NO stored order: bucket (running, queued, parked, done) then id.
// #2 carries the SECOND assistant's own thread — that is the card the click half opens, and the one the blocked drop
// has to stay behind. #5 holds on it, so it may never be dragged above #2.
const seed = (clickThread) => [
  { id: 1, title: "the run carrying it", state: "running", owner: "assistant-1", createdBy: "reader", createdAt: at, startedAt: at, thread: "seed-thread-live", threads: ["seed-thread-live"], files: [] },
  { id: 2, title: "the card a click opens", state: "queued", owner: "assistant-1", createdBy: "reader", createdAt: at, thread: clickThread, threads: [clickThread], files: [] },
  { id: 3, title: "second in line", state: "queued", owner: "assistant-1", createdBy: "reader", createdAt: at, thread: "seed-thread-3", threads: ["seed-thread-3"], files: [] },
  { id: 4, title: "third in line", state: "queued", owner: "assistant-1", createdBy: "reader", createdAt: at, thread: "seed-thread-4", threads: ["seed-thread-4"], files: [] },
  {
    id: 5,
    title: "held behind the second",
    state: "queued",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    thread: "seed-thread-5",
    threads: ["seed-thread-5"],
    files: [],
    hold: { kind: "task", value: "2", since: "2026-11-02T09:05:00.000Z" },
    reason: "waiting on #2",
  },
  { id: 6, title: "parked for a decision", state: "parked", owner: "assistant-1", createdBy: "reader", createdAt: at, thread: "seed-thread-6", threads: ["seed-thread-6"], files: [], reason: "needs a decision" },
  { id: 7, title: "already finished", state: "done", owner: "assistant-1", createdBy: "reader", createdAt: at, doneAt: at, doneBy: "reader", thread: "seed-thread-7", threads: ["seed-thread-7"], files: [] },
];

const IDS = [1, 2, 3, 4, 5, 6, 7];

let panel = null;
let liveBrowser = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-drag-"));
  const repos = path.join(dir, "repos");
  mkdirSync(repos, { recursive: true });
  const port = await freePort();
  ok("the sandbox port is not the live one", port !== 7331, `port ${port}`);
  note(`temp root ${dir}`);

  const configPath = path.join(dir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [repos],
        refreshSeconds: 4,
        worktreeSeconds: 2,
        midSeconds: 8,
        threads: 1,
        scanMode: "all",
        defaultCwd: path.join(dir, "panel-cwd"),
        projectsCacheFile: path.join(dir, "logs", "projects.json"),
        // A dead port and a switched-off sentry: this gate is a store, a route and a pane, and nothing here may wake a
        // model or write the reader's store.
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const base = `http://127.0.0.1:${port}`;
  const panelLog = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: path.join(dir, "hermes"), PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel = {
    base,
    port,
    dir,
    log: () => panelLog.join("\n"),
    stop: async () => {
      child.kill();
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 15_000, stepMs: 200, what: "the panel to exit" });
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* Windows can still hold a file for a moment; the verdict does not depend on the cleanup */
      }
    },
  };
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, {
    timeoutMs: 90_000,
    stepMs: 300,
    what: "the sandbox panel to answer /api/state",
  });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
  note(`panel ${base}`);

  const view = async () => (await (await fetch(`${base}/api/assistant/queue?assistantId=assistant-1`)).json()).queue || null;
  const post = async (body) => {
    const r = await fetch(`${base}/api/assistant/queue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  // The order the ROUTE reads back, which is the order the pane draws.
  const routeOrder = async () => {
    const q = await view();
    const rows = Array.isArray(q?.tasks) ? q.tasks.slice() : [];
    const bucket = { running: 0, queued: 1, parked: 2, done: 3 };
    const num = (t) => (Number.isFinite(Number(t.order)) && Number(t.order) > 0 ? Number(t.order) : Number(t.id));
    return rows.sort((a, b) => (bucket[a.state] ?? 9) - (bucket[b.state] ?? 9) || num(a) - num(b) || Number(a.id) - Number(b.id)).map((t) => Number(t.id));
  };

  // ---- 1. the model and the route, before a browser is involved ---------------------------------
  console.log("\n== the model: one list, one write, and the refusals ==");
  // A second assistant, so the click half has a session thread to open and the queue has two panes to tell apart.
  const made = await fetch(`${base}/api/assistant/assistants`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok("a second assistant exists", made.status === 201, `HTTP ${made.status}`);
  const assistantState = await (await fetch(`${base}/api/assistant`)).json();
  const second = (assistantState.assistant?.assistants || assistantState.assistants || []).find((a) => a.id !== "assistant-1") || null;
  const clickThread = String(second?.threadId || "panel-assistant-2");
  note(`the click card carries ${clickThread}`);

  const boot = await view();
  ok("Assistant #1's queue is found at boot", boot?.found === true, JSON.stringify({ found: boot?.found, error: boot?.error }));
  const queueFile = boot?.file || "";
  ok("…and names a queue.json on disk", existsSync(queueFile), slash(queueFile));
  writeFileSync(queueFile, `${JSON.stringify({ version: 1, nextId: 8, tasks: seed(clickThread) }, null, 2)}\n`, "utf8");
  const seeded = await view();
  check("the route reads the seed: seven tasks, one per state bucket plus four queued", seeded?.tasks?.map((t) => [t.id, t.state]), [
    [1, "running"],
    [2, "queued"],
    [3, "queued"],
    [4, "queued"],
    [5, "queued"],
    [6, "parked"],
    [7, "done"],
  ]);
  ok("no seeded row carries an order, so the pane draws the id order it always did", (seeded?.tasks || []).every((t) => t.order == null));
  check("…and the route's own order is the id order", await routeOrder(), IDS);

  const moved = await post({ assistantId: "assistant-1", action: "reorder", ids: [1, 4, 3, 2, 5, 6, 7] });
  ok("the reorder action is accepted (main has no such action)", moved.status === 200 && moved.body?.ok === true, `HTTP ${moved.status} ${JSON.stringify(moved.body?.error || "")}`);
  check("…and the route reads the new order straight back", await routeOrder(), [1, 4, 3, 2, 5, 6, 7]);
  const doc = JSON.parse(readFileSync(queueFile, "utf8"));
  check(
    "…because every listed row carries its position in the one document",
    doc.tasks.map((t) => [t.id, t.order]),
    [
      [1, 1],
      [2, 4],
      [3, 3],
      [4, 2],
      [5, 5],
      [6, 6],
      [7, 7],
    ],
  );

  const heldBefore = readFileSync(queueFile, "utf8");
  const blockedWrite = await post({ assistantId: "assistant-1", action: "reorder", ids: [1, 5, 4, 3, 2, 6, 7] });
  ok("a queued row above the row it holds for is REFUSED", blockedWrite.status === 400, `HTTP ${blockedWrite.status}`);
  ok("…with a sentence naming both rows", /#5 is held by #2/.test(String(blockedWrite.body?.error || "")), String(blockedWrite.body?.error || "(none)"));
  ok("…and queue.json is byte-identical (nothing half-applied)", readFileSync(queueFile, "utf8") === heldBefore);

  const crossed = await post({ assistantId: "assistant-1", action: "reorder", ids: [2, 1, 3, 4, 5, 6, 7] });
  ok("a list that crosses a state bucket is refused", crossed.status === 400 && /#1 is running/.test(String(crossed.body?.error || "")), `HTTP ${crossed.status} ${String(crossed.body?.error || "")}`);
  const stranger = await post({ assistantId: "assistant-1", action: "reorder", ids: [1, 99] });
  ok("an id that is not in this queue is refused", stranger.status === 400 && /no task #99/.test(String(stranger.body?.error || "")), `HTTP ${stranger.status} ${String(stranger.body?.error || "")}`);
  ok("…and neither refusal touched the file", readFileSync(queueFile, "utf8") === heldBefore);

  // Put the board back in id order for the browser half, so a drag has somewhere to go: the pane is drawn from this.
  const reset = await post({ assistantId: "assistant-1", action: "reorder", ids: IDS });
  ok("the board is reset to the id order for the drag", reset.status === 200 && (await routeOrder()).join() === IDS.join(), `HTTP ${reset.status}`);

  // ---- 2. the pane, in a browser ------------------------------------------------------------------
  console.log("\n== the pane, in a real browser ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the drag was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<a dir holding node_modules/playwright>");
    failures += 1;
  } else {
    const pageErrors = [];
    const posts = [];
    liveBrowser = await pw.chromium.launch({ headless: true });
    const context = await liveBrowser.newContext({ viewport: { width: 1280, height: 1400 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    page.on("request", (r) => {
      if (r.method() !== "POST" || !r.url().includes("/api/assistant/queue")) return;
      try {
        posts.push(JSON.parse(r.postData() || "{}"));
      } catch {
        posts.push({ action: "(unparseable)" });
      }
    });
    const reorders = () => posts.filter((p) => p.action === "reorder").length;

    const openQueue = async ({ fresh = false } = {}) => {
      if (fresh) await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#job-prompt", { state: "visible", timeout: 25_000 });
      // The float remembers it was open across a reload: pressing the button would CLOSE it, so wait for it instead.
      if (!(await page.locator("#assistant").isVisible())) await page.locator("#btn-assistant").click();
      await page.waitForSelector("#assistant", { state: "visible" });
      await page.waitForSelector('#as-tabs [data-as-tab="assistant-1"]');
      if (!(await page.locator("#as-queue").isVisible())) {
        if (await page.locator("#as-subtabs").isVisible()) await page.click('#as-subtabs [data-as-subtab="queue"]');
      }
      await page.waitForSelector("#as-queue:not(.hidden)");
    };
    const cards = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#as-queue .as-task")].map((el) => ({
          id: Number(el.dataset.asQrow),
          state: el.dataset.asQstate,
          own: el.dataset.asQown,
          draggable: el.classList.contains("is-draggable"),
          hold: el.querySelector(".as-task-hold")?.dataset.asQhold || null,
          holdText: (el.querySelector(".as-task-hold")?.textContent || "").trim(),
        })),
      );
    const ids = async () => (await cards()).map((c) => c.id);

    await openQueue({ fresh: true });
    const rowsReady = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === 7), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "the seven seeded cards to paint",
    });
    ok("the pane paints one card per task", rowsReady, `${await page.locator("#as-queue .as-task").count()} card(s)`);
    check("…in the bucket-then-id order", await ids(), IDS);

    const painted = await cards();
    check("only the four QUEUED cards are draggable", painted.filter((c) => c.draggable).map((c) => c.id), [2, 3, 4, 5]);
    ok("…and every card says which queue it belongs to", painted.every((c) => c.own === "assistant-1"), JSON.stringify(painted.map((c) => c.own)));
    check("only the holding card wears a hold badge, and it names #2", painted.filter((c) => c.hold).map((c) => [c.id, c.hold, c.holdText]), [
      [5, "2", "held by #2"],
    ]);

    // ---- 3. the drag that lands ------------------------------------------------------------------
    console.log("\n== a drag that lands ==");
    const before = reorders();
    const dragCard = async (fromId, toId) => {
      // A pointer drag cannot travel to a box outside the window: scroll the pane so BOTH cards sit in it first, then
      // measure both in ONE read — the pane is repainted by the board poll, and an element handle held across two
      // awaits can be detached by the time the second one resolves ("Element is not attached to the DOM").
      const boxes = await page.evaluate(
        ([a, b]) => {
          for (const id of [a, b]) document.querySelector(`#as-queue .as-task[data-as-qrow="${id}"]`)?.scrollIntoView({ block: "nearest" });
          const box = (id) => {
            const el = document.querySelector(`#as-queue .as-task[data-as-qrow="${id}"] .as-task-body`);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          return { from: box(a), to: box(b) };
        },
        [fromId, toId],
      );
      const from = boxes.from;
      const to = boxes.to;
      if (!from || !to) throw new Error(`no box for #${fromId} or #${toId}`);
      const x = Math.round(from.x + from.width / 2);
      await page.mouse.move(x, Math.round(from.y + 14));
      await page.mouse.down();
      // Cross the 4 px threshold first, then travel to just inside the target's top edge — above its midpoint is the
      // half that decides the drop.
      await page.mouse.move(x, Math.round(from.y + 14) - 14, { steps: 3 });
      await page.mouse.move(x, Math.round(to.y + 4), { steps: 16 });
      await page.mouse.up();
    };
    let dragError = "";
    try {
      await dragCard(4, 2);
    } catch (e) {
      dragError = dragFailure(e);
      failures += 1;
      checks += 1;
      console.log(`FAIL  the pointer drag ran — ${dragError}`);
    }
    const landed = await waitFor(async () => (await ids()).join() === [1, 4, 2, 3, 5, 6, 7].join(), {
      timeoutMs: 10_000,
      stepMs: 150,
      what: "the pane to paint #4 above #2",
    });
    ok("dragging #4 above #2 leaves the pane in that order", landed, (await ids()).join(","));
    check("…and it sent exactly one reorder, carrying the whole list", posts.slice(before).map((p) => p.action), ["reorder"]);
    check("…with the list the pane draws", posts.slice(before).at(-1)?.ids, [1, 4, 2, 3, 5, 6, 7]);
    check("…and the server holds that order", await routeOrder(), [1, 4, 2, 3, 5, 6, 7]);
    ok("the drag did NOT open a card — the pane is still the queue", await page.locator("#as-queue").isVisible());
    await page.screenshot({ path: path.join(outDir, "queue-drag-after.png") });
    note(`screenshot ${slash(path.join(outDir, "queue-drag-after.png"))}`);

    // ---- 4. it survives a reload and a Refresh ----------------------------------------------------
    console.log("\n== the order persists ==");
    await page.reload({ waitUntil: "domcontentloaded" });
    await openQueue();
    const afterReload = await waitFor(async () => (await ids()).join() === [1, 4, 2, 3, 5, 6, 7].join(), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "the reloaded pane to paint the dragged order",
    });
    ok("the dragged order is still there after a page reload", afterReload, (await ids()).join(","));
    // The pane's own Refresh reads the file again: an order that lived only in the page would not survive it.
    await page.click('#as-queue [data-as-qact="reload"]');
    const afterRefresh = await waitFor(async () => (await ids()).join() === [1, 4, 2, 3, 5, 6, 7].join(), {
      timeoutMs: 10_000,
      stepMs: 150,
      what: "the refreshed pane to keep the dragged order",
    });
    ok("…and after the pane's own Refresh", afterRefresh, (await ids()).join(","));

    // ---- 5. the blocked drop ---------------------------------------------------------------------
    console.log("\n== the blocked drop ==");
    const heldOrder = await ids();
    const beforeBlocked = reorders();
    let blockedError = "";
    try {
      // #5 holds on #2, which now sits last of the queued block: dragging #5 above it is the drop the hold forbids.
      await dragCard(5, 2);
    } catch (e) {
      blockedError = dragFailure(e);
      failures += 1;
      checks += 1;
      console.log(`FAIL  the blocked pointer drag ran — ${blockedError}`);
    }
    await page.waitForTimeout(400);
    check("a blocked drop snaps back to the order the pane had", await ids(), heldOrder);
    const noteLine = (await page.locator("#as-queue .as-qdrop").textContent().catch(() => "")) || "";
    ok("…says ONE line naming the holding row", /^#5 is held by #2\b/.test(noteLine.trim()), noteLine.trim() || "(no line)");
    ok("…sends no write at all (the pane refuses before the request)", reorders() === beforeBlocked, `${reorders() - beforeBlocked} reorder(s) sent`);
    check("…and leaves the server's queue exactly as it was", await routeOrder(), heldOrder);
    ok("…with the badge still on #5 alone", (await cards()).filter((c) => c.hold).map((c) => `${c.id}:${c.hold}`), ["5:2"]);
    await page.screenshot({ path: path.join(outDir, "queue-drag-blocked.png") });
    note(`screenshot ${slash(path.join(outDir, "queue-drag-blocked.png"))}`);

    // ---- 6. a plain click still opens its agent ---------------------------------------------------
    console.log("\n== a plain click ==");
    const clickBox = await page.locator('#as-queue .as-task[data-as-qrow="2"] .as-task-body').boundingBox();
    if (clickBox) await page.mouse.click(Math.round(clickBox.x + clickBox.width / 2), Math.round(clickBox.y + 14));
    const left = await waitFor(async () => !(await page.locator("#as-queue").isVisible()), {
      timeoutMs: 8_000,
      stepMs: 150,
      what: "the card body's opener to leave the queue pane",
    });
    ok("a plain click on a card body still opens its agent (the pane left for the chat)", left);
    ok("…and no drag was started by it", reorders() === beforeBlocked, `${reorders() - beforeBlocked} reorder(s) sent`);
    check("no page errors", pageErrors, []);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log(`screenshots in ${slash(outDir)}`);
  console.log(failures ? "RESULT: FAIL" : "RESULT: PASS  QUEUE-DRAG-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panel) console.log(`--- panel log (tail)\n${String(panel.log()).split(/\r?\n/).slice(-25).join("\n")}`);
  console.log(`\n${checks} checks, ${failures} failed`);
  console.log("RESULT: FAIL");
} finally {
  if (liveBrowser) {
    try {
      await liveBrowser.close();
    } catch {
      /* already gone */
    }
    liveBrowser = null;
  }
  if (panel) {
    if (process.env.VERIFY_KEEP === "1") console.log(`VERIFY_KEEP=1 — leaving ${panel.dir} in place`);
    else await panel.stop();
  }
  clearTimeout(watchdog);
}
process.exitCode = failures ? 1 : 0;
