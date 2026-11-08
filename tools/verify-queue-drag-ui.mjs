// The queue pane's drag, the way a PERSON does it: a real mouse press, travel and release on a card, in the rail and in
// the float, with a queue that does not fit the pane.
//
//   node tools/verify-queue-drag-ui.mjs
//
// tools/verify-queue-drag.mjs already proves the model and a drag between two cards that are both on screen at
// 1280x1400. This gate is the reader's half of the same feature, and it exists because that half was advertised and
// not delivered: nine queued cards in the 480 px rail are taller than the pane, so the card a reader drags cannot be
// put where the pointer is — the pane never scrolls while the gesture is live, the pointer stops at the scroller's
// edge, and the drop lands at whatever visible midpoint it last crossed. The reader's report ("it does not drag and
// drop like the UI advertises") is that, measured.
//
// What this gate drives, in order:
//
//   1. the rail: the docked 480 px column at a 1600x900 window, with NINE queued cards whose block is taller than the
//      pane — the condition the drag has to survive, asserted as numbers before anything is dragged;
//   2. the gesture that already works: #5 dragged above #2, one reorder carrying the whole list, the route reading it
//      back, and no card opened;
//   3. the gesture that did not work: #4 dragged to the pane's bottom edge and HELD there, as a reader does when the
//      place they want is below the fold. The pane must scroll under the pointer and #4 must land LAST of the queued
//      block. On the tree this gate was written against the pointer stops at the edge and #4 lands a row or two down;
//   4. the order after that drop survives a page reload AND a read of /api/assistant/queue;
//   5. a queued card held on #2 dropped above it is refused, says ONE line naming the holder, sends no write, leaves
//      the panes' order unchanged, and the line is inside the window the reader is looking at;
//   6. the same bottom-edge drag in the FLOATING frame at 1600 — the other shape the brief names, with its own
//      scroller whose bottom edge sits above the window's.
//
// The gate is meant to be RED on the tree it replaces (a `git archive` of main): check 3 fails there — the pointer
// cannot pass the scroller's edge, so #4 lands a row or two down instead of last — and check 6 fails with it. The red
// run is quoted in the commit and the PR.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { freePort, ROOT, waitFor } from "./panel-testkit.mjs";
import { loadPlaywright } from "./browser.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
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

const outDir = process.env.QUEUE_DRAG_UI_OUT || path.join(tmpdir(), "wtgui-queue-drag-ui");
mkdirSync(outDir, { recursive: true });

// The window the brief names, and the rail the panel draws by default in it (DOCK_DEFAULT = 480).
const VIEW = { width: 1600, height: 900 };
const RAIL_W = 480;

const at = new Date("2026-11-02T09:00:00.000Z").toISOString();
// Nine queued rows (#2..#10) so the QUEUED BLOCK alone is taller than the rail's pane, one running row above them, one
// parked and one done below, and #3 held on #2 — the row a drop above #2 has to be refused for, close enough to the
// top that both cards are on screen at once and the refusal is not a scrolling test.
const seed = () => [
  { id: 1, title: "the run carrying it", state: "running", owner: "assistant-1", createdBy: "reader", createdAt: at, startedAt: at, thread: "seed-thread-live", threads: ["seed-thread-live"], files: [] },
  ...[2, 4, 5, 6, 7, 8, 9, 10].map((id) => ({
    id,
    title: `queued work ${id}`,
    state: "queued",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    thread: `seed-thread-${id}`,
    threads: [`seed-thread-${id}`],
    files: [],
  })),
  {
    id: 3,
    title: "held behind the second",
    state: "queued",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    thread: "seed-thread-3",
    threads: ["seed-thread-3"],
    files: [],
    hold: { kind: "task", value: "2", since: "2026-11-02T09:05:00.000Z" },
    reason: "waiting on #2",
  },
  { id: 11, title: "parked for a decision", state: "parked", owner: "assistant-1", createdBy: "reader", createdAt: at, thread: "seed-thread-11", threads: ["seed-thread-11"], files: [], reason: "needs a decision" },
  { id: 12, title: "already finished", state: "done", owner: "assistant-1", createdBy: "reader", createdAt: at, doneAt: at, doneBy: "reader", thread: "seed-thread-12", threads: ["seed-thread-12"], files: [] },
];
const IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const QUEUED = [2, 3, 4, 5, 6, 7, 8, 9, 10];

// The two moves this gate asserts, as functions of the order before the drag — the advertised meaning of a drop, not a
// hand-typed list that could hide an arithmetic slip.
const moveAbove = (order, moving, target) => {
  const rest = order.filter((id) => id !== moving);
  rest.splice(rest.indexOf(target), 0, moving);
  return rest;
};
const moveToEndOfQueued = (order, moving) => {
  const rest = order.filter((id) => id !== moving);
  const lastQueued = [...rest].reverse().find((id) => QUEUED.includes(id));
  if (lastQueued === undefined) return rest;
  rest.splice(rest.indexOf(lastQueued) + 1, 0, moving);
  return rest;
};

let panel = null;
let liveBrowser = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-drag-ui-"));
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
  // The order the ROUTE reads back, which is the order the pane draws.
  const routeOrder = async () => {
    const q = await view();
    const rows = Array.isArray(q?.tasks) ? q.tasks.slice() : [];
    const bucket = { running: 0, queued: 1, parked: 2, done: 3 };
    const num = (t) => (Number.isFinite(Number(t.order)) && Number(t.order) > 0 ? Number(t.order) : Number(t.id));
    return rows.sort((a, b) => (bucket[a.state] ?? 9) - (bucket[b.state] ?? 9) || num(a) - num(b) || Number(a.id) - Number(b.id)).map((t) => Number(t.id));
  };
  const boot = await view();
  ok("Assistant #1's queue is found at boot", boot?.found === true, JSON.stringify({ found: boot?.found, error: boot?.error }));
  const queueFile = boot?.file || "";
  ok("…and names a queue.json on disk", existsSync(queueFile), slash(queueFile));
  writeFileSync(queueFile, `${JSON.stringify({ version: 1, nextId: 13, tasks: seed() }, null, 2)}\n`, "utf8");
  check("the route reads the seed in id order", await routeOrder(), IDS);

  // ---- 1-6. the pane, in a real browser ---------------------------------------------------------------
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the drag was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<a dir holding node_modules/playwright>");
    failures += 1;
  } else {
    const pageErrors = [];
    const posts = [];
    liveBrowser = await pw.chromium.launch({ headless: true });
    const context = await liveBrowser.newContext({ viewport: VIEW });
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
      // The pane remembers it was open across a reload: pressing the button would CLOSE it, so wait for it instead.
      if (!(await page.locator("#assistant").isVisible())) await page.locator("#btn-assistant").click();
      await page.waitForSelector("#assistant", { state: "visible" });
      await page.waitForSelector('#as-tabs [data-as-tab="assistant-1"]');
      if (!(await page.locator("#as-queue").isVisible()) && (await page.locator("#as-subtabs").isVisible())) {
        await page.click('#as-subtabs [data-as-subtab="queue"]');
      }
      await page.waitForSelector("#as-queue:not(.hidden)");
      await page.waitForFunction(() => document.querySelectorAll("#as-queue .as-task").length === 12, null, { timeout: 25_000 });
    };
    const ids = () => page.evaluate(() => [...document.querySelectorAll("#as-queue .as-task")].map((c) => Number(c.dataset.asQrow)));
    const cardBox = (id) =>
      page.evaluate((id) => {
        const el = document.querySelector(`#as-queue .as-task[data-as-qrow="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom };
      }, id);
    // The element the queue actually scrolls in — the same walk the pane's own gesture has to make. `.as-body` in the
    // rail and in the float; the document when nothing else is a scroller.
    const scrollerBox = () =>
      page.evaluate(() => {
        const pane = document.querySelector('[data-subpane="queue"]');
        let s = null;
        for (let n = pane; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) {
            s = n;
            break;
          }
        }
        if (!s) s = document.scrollingElement;
        const r = s.getBoundingClientRect();
        return { scrollTop: s.scrollTop, scrollH: s.scrollHeight, clientH: s.clientHeight, top: r.top, bottom: r.bottom, tag: `${s.tagName}.${s.className}` };
      });
    const setScroll = (top) =>
      page.evaluate((top) => {
        const pane = document.querySelector('[data-subpane="queue"]');
        let s = null;
        for (let n = pane; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) {
            s = n;
            break;
          }
        }
        (s || document.scrollingElement).scrollTop = top;
      }, top);
    const showCard = (id) =>
      page.evaluate((id) => {
        document.querySelector(`#as-queue .as-task[data-as-qrow="${id}"]`)?.scrollIntoView({ block: "start" });
      }, id);
    const frame = () =>
      page.evaluate(() => {
        const el = document.getElementById("assistant");
        const r = el.getBoundingClientRect();
        return { cls: el.className, w: Math.round(r.width), floating: el.classList.contains("is-floating") };
      });

    // One gesture, three points: the press on the card's head, a short travel that must lift it, and the place the
    // pointer ends. `hold` keeps the pointer at the last point for a while (the reader waiting for the list to scroll)
    // while nudging it a pixel at a time — a held mouse still moves, and both a move-driven and a frame-driven scroller
    // have to see the gesture there.
    const dragGesture = async ({ fromId, toY, hold = 0 }) => {
      const from = await cardBox(fromId);
      if (!from) throw new Error(`no card #${fromId}`);
      const sx = Math.round(from.x + Math.min(90, from.w * 0.35));
      const sy = Math.round(from.y + 14);
      const y = Math.round(Math.max(2, Math.min(VIEW.height - 3, toY)));
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx, sy + 9, { steps: 3 });
      const lifted = await page.evaluate((id) => document.querySelector(`#as-queue .as-task[data-as-qrow="${id}"]`)?.classList.contains("is-dragging"), fromId);
      await page.mouse.move(sx, y, { steps: 16 });
      const heldScroll = [];
      const started = Date.now();
      while (Date.now() - started < hold) {
        await page.mouse.move(sx, y - 1, { steps: 1 });
        await page.mouse.move(sx, y, { steps: 1 });
        await page.waitForTimeout(90);
        heldScroll.push((await scrollerBox()).scrollTop);
      }
      const beforeUp = { ids: await ids(), scroll: await scrollerBox() };
      await page.mouse.up();
      await page.waitForTimeout(450);
      return { from, sx, sy, y, lifted, heldScroll, beforeUp, after: await ids() };
    };

    // ---- 1. the rail, and the queue that does not fit it -------------------------------------------
    console.log("\n== the 480 px rail: nine queued cards, more than the pane can show ==");
    await openQueue({ fresh: true });
    const shape = await frame();
    check("the frame is the docked rail", [shape.floating, shape.w], [false, RAIL_W]);
    await setScroll(0);
    const sc0 = await scrollerBox();
    const firstQueued = await cardBox(2);
    const lastQueued = await cardBox(10);
    const span = Math.round(lastQueued.bottom - firstQueued.top);
    note(`the pane's scroller is ${sc0.tag}: visible ${sc0.clientH}px of ${sc0.scrollH}px; the queued block is ${span}px tall`);
    const painted = await page.evaluate(() =>
      [...document.querySelectorAll("#as-queue .as-task")].map((el) => ({
        id: Number(el.dataset.asQrow),
        draggable: el.classList.contains("is-draggable"),
        hold: el.querySelector(".as-task-hold")?.dataset.asQhold || null,
      })),
    );
    check("only the NINE queued cards are draggable", painted.filter((c) => c.draggable).map((c) => c.id), QUEUED);
    check("only the holding card wears a hold badge, and it names #2", painted.filter((c) => c.hold).map((c) => [c.id, c.hold]), [[3, "2"]]);
    ok("the queued block is TALLER than the pane — the condition the drag has to survive", span > sc0.clientH, `${span}px of queued cards against ${sc0.clientH}px of pane`);
    await page.screenshot({ path: path.join(outDir, "rail-painted.png") });

    // ---- 2. the gesture that already works ---------------------------------------------------------
    console.log("\n== a drag between two cards that are both on screen ==");
    const beforeBasic = reorders();
    const order0 = await ids();
    const wantBasic = moveAbove(order0, 5, 2);
    await showCard(2);
    const basic = await dragGesture({ fromId: 5, toY: (await cardBox(2)).y + 4 });
    const basicOk = await waitFor(async () => (await ids()).join() === wantBasic.join(), { timeoutMs: 8_000, stepMs: 150, what: "the pane to paint #5 above #2" });
    ok("the pressed card LIFTS while the pointer travels", basic.lifted === true);
    ok("dragging #5 above #2 lands it there", basicOk, basic.after.join(","));
    check("…with exactly one reorder carrying the whole list", posts.slice(beforeBasic).map((p) => p.action), ["reorder"]);
    check("…the list the pane draws", posts.slice(beforeBasic).at(-1)?.ids, wantBasic);
    check("…and the server holds that order", await routeOrder(), wantBasic);
    ok("the drag did not open a card — the pane is still the queue", await page.locator("#as-queue").isVisible());

    // ---- 3. the gesture that did not: dragging to a place below the fold ----------------------------
    console.log("\n== a drag to the pane's bottom edge, held there ==");
    const beforeEdge = reorders();
    const order1 = await ids();
    const wantEdge = moveToEndOfQueued(order1, 4);
    await showCard(2);
    const edge = await scrollerBox();
    const edgeDrag = await dragGesture({ fromId: 4, toY: edge.bottom - 5, hold: 1_800 });
    const scrolled = edgeDrag.beforeUp.scroll.scrollTop;
    note(`the pointer stopped at y=${edgeDrag.y}; the pane was at scrollTop ${Math.round(edge.scrollTop)} and is at ${Math.round(scrolled)} when released`);
    note(`the pane painted ${edgeDrag.beforeUp.ids.join(",")} before the release; scrollTop during the hold: ${edgeDrag.heldScroll.map((n) => Math.round(n)).join(" -> ")}`);
    ok(
      "holding at the pane's bottom edge SCROLLS the pane under the pointer",
      scrolled > edge.scrollTop + 8,
      `scrollTop ${Math.round(scrolled)} of ${edgeDrag.beforeUp.scroll.scrollH - edgeDrag.beforeUp.scroll.clientH} reachable`,
    );
    const edgeOk = await waitFor(async () => (await ids()).join() === wantEdge.join(), { timeoutMs: 8_000, stepMs: 150, what: "the pane to paint #4 last of the queued block" });
    ok("a card dragged to the pane's bottom edge lands LAST of the queued block", edgeOk, `${edgeDrag.after.join(",")} (wanted ${wantEdge.join(",")})`);
    check("…it still sent exactly one reorder, carrying the whole list", posts.slice(beforeEdge).map((p) => p.action), ["reorder"]);
    check("…and the server holds that order", await routeOrder(), wantEdge);
    await page.screenshot({ path: path.join(outDir, "rail-bottom-edge.png") });

    // ---- 4. the order survives a reload and a route read -------------------------------------------
    console.log("\n== the order persists ==");
    await page.reload({ waitUntil: "domcontentloaded" });
    await openQueue();
    const afterReload = await waitFor(async () => (await ids()).join() === wantEdge.join(), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "the reloaded pane to paint the dragged order",
    });
    ok("the dragged order is still there after a page reload", afterReload, (await ids()).join(","));
    check("…and the route reads the same order back", await routeOrder(), wantEdge);

    // ---- 5. the held drop, refused where the reader can read the reason ------------------------------
    console.log("\n== the blocked drop ==");
    const heldOrder = await ids();
    const beforeBlocked = reorders();
    await showCard(2);
    // #3 holds on #2 and sits right below it: dragging it above #2 is the drop the hold forbids, and both cards are on
    // screen, so this is the rule being tested and not the scroller.
    const heldDrop = await dragGesture({ fromId: 3, toY: (await cardBox(2)).y + 4 });
    await page.waitForTimeout(300);
    check("a blocked drop snaps back to the order the pane had", await ids(), heldOrder);
    const noteLine = ((await page.locator("#as-queue .as-qdrop").textContent().catch(() => "")) || "").trim();
    ok("…says ONE line naming the holding row", /^#3 is held by #2\b/.test(noteLine), noteLine || "(no line)");
    const noteSeen = await page.evaluate(() => {
      const el = document.querySelector("#as-queue .as-qdrop");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
    });
    ok("…and the line is inside the window the reader is looking at", Boolean(noteSeen && noteSeen.top >= 0 && noteSeen.bottom <= noteSeen.vh), JSON.stringify(noteSeen));
    ok("…sends no write at all (the pane refuses before the request)", reorders() === beforeBlocked, `${reorders() - beforeBlocked} reorder(s) sent`);
    check("…and leaves the server's queue exactly as it was", await routeOrder(), heldOrder);
    note(`held drop pressed #3 at y=${heldDrop.sy} and released at y=${heldDrop.y}`);
    await page.screenshot({ path: path.join(outDir, "rail-blocked.png") });

    // ---- 6. the float, at 1600, with its own scroller ------------------------------------------------
    console.log("\n== the floating frame at 1600: the same bottom-edge drag ==");
    const flip = await fetch(`${base}/api/settings/general`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dockMode: "floating" }),
    });
    ok("the panel is switched to the floating frame", flip.status === 200, `HTTP ${flip.status}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openQueue();
    const floatShape = await frame();
    check("the frame is the float", [floatShape.floating, floatShape.w], [true, Math.round(VIEW.width * 0.42)]);
    const order2 = await ids();
    const wantFloat = moveToEndOfQueued(order2, 6);
    await showCard(2);
    const floatEdge = await scrollerBox();
    const beforeFloat = reorders();
    const floatDrag = await dragGesture({ fromId: 6, toY: floatEdge.bottom - 5, hold: 1_800 });
    const floatScrolled = floatDrag.beforeUp.scroll.scrollTop;
    note(`the pointer stopped at y=${floatDrag.y}; the pane was at scrollTop ${Math.round(floatEdge.scrollTop)} and is at ${Math.round(floatScrolled)} when released`);
    ok(
      "holding at the float pane's bottom edge SCROLLS it under the pointer",
      floatScrolled > floatEdge.scrollTop + 8,
      `scrollTop ${Math.round(floatScrolled)} of ${floatDrag.beforeUp.scroll.scrollH - floatDrag.beforeUp.scroll.clientH} reachable`,
    );
    const floatOk = await waitFor(async () => (await ids()).join() === wantFloat.join(), { timeoutMs: 8_000, stepMs: 150, what: "the pane to paint #6 last of the queued block" });
    ok("…and #6 lands below every queued row it was dragged past", floatOk, `${floatDrag.after.join(",")} (wanted ${wantFloat.join(",")})`);
    check("…one reorder, and the server reads it back", [posts.slice(beforeFloat).map((p) => p.action), await routeOrder()], [["reorder"], wantFloat]);
    await page.screenshot({ path: path.join(outDir, "float-bottom-edge.png") });

    check("no page errors", pageErrors, []);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log(`screenshots in ${slash(outDir)}`);
  console.log(failures ? "RESULT: FAIL" : "RESULT: PASS  QUEUE-DRAG-UI-OK");
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
