// The Queue sub-tab as a column of CARDS, and the "unowned" label gone.
//
//   node tools/verify-queue-cards.mjs
//
// Brief (queue row #71): the pane renders cards, and "unowned" is gone. What this gate drives, in order:
//
//   1. a panel of its own (tools/panel-testkit.mjs: throwaway data directory, a scanned repo, a free port) with a
//      SEEDED queue file written straight to disk — a running task with two agents, a queued task whose files clash
//      with it, a parked task with no owner (the record that used to paint "unowned") and a done one;
//   2. the real pane in headless Chromium, at 1280 then 340 wide: every row renders as a card (a surface, a
//      non-zero border-radius, a visible gap to the next card), the actions row sits at the card's bottom edge, and
//      every fact the row carried before is still on it — the head (#id, title, state mark), one sub-row per agent
//      with its thread and pill, the tree/files meta line, the stale/skipped/parked notes, and every glyph with its
//      title= and aria-label=;
//   3. the row body still carries data-as-qopen (equal to the row's current thread) and every glyph keeps
//      data-as-qact, so the click behaviour is untouched.
//
// Screenshots land in QUEUE_CARDS_OUT (default: a directory under the OS temp) at 1280 and 340 wide.
//
// This gate is meant to be RED on the tree it replaces: the base row is a bordered bullet with border-radius 0, no
// card surface, no body wrapper and an owner label that says "unowned" when the task has no owner. The red run is
// quoted in the commit and the PR — see the landing note.
import { execSync, spawn } from "node:child_process";
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
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

const outDir = process.env.QUEUE_CARDS_OUT || path.join(tmpdir(), "wtgui-queue-cards");
mkdirSync(outDir, { recursive: true });

// The seed: one task per state, with the fields the row draws. Task 1's two threads are one CURRENT run and one
// earlier one, task 2's files clash with task 1's (the SKIPPED note), and task 3 has NO owner — the record that used
// to print the label this brief deletes. Every task has an agent, so every row draws a pill.
const at = new Date("2026-11-02T09:00:00.000Z").toISOString();
const TASKS = [
  {
    id: 1,
    title: "Land the queue cards",
    detail: "the card skin, and the deleted label",
    state: "running",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    startedAt: at,
    thread: "seed-thread-before",
    threads: ["seed-thread-before", "seed-thread-live"],
    worktree: "C:/dev/agent-worktree-gui/.worktrees/queue-cards-seed",
    files: ["public/assistant.js", "public/style.css", "tools/verify-queue-cards.mjs", "test/assistant-queue-ui.test.js", "package.json"],
    attempts: 2,
  },
  {
    id: 2,
    title: "Tighten the meta line",
    state: "queued",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    thread: "seed-thread-queued",
    threads: ["seed-thread-queued"],
    files: ["public/assistant.js"],
  },
  {
    id: 3,
    title: "Park on the DBA's verify",
    state: "parked",
    owner: null,
    createdBy: "reader",
    createdAt: at,
    thread: "seed-thread-parked",
    threads: ["seed-thread-parked"],
    reason: "waiting on the DBA's verify",
  },
  {
    id: 4,
    title: "Ship the removed label",
    state: "done",
    owner: "assistant-1",
    createdBy: "reader",
    createdAt: at,
    doneAt: at,
    doneBy: "reader",
    thread: "seed-thread-done",
    threads: ["seed-thread-done"],
  },
];

let panel = null;
let liveBrowser = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-cards-"));
  const repos = path.join(dir, "repos");
  mkdirSync(repos, { recursive: true });

  const liveBefore = listenersOn(7331);
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
        // A dead port and a switched-off sentry: this gate is a store and a pane, and nothing here may wake a model.
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
  note(`panel ${base} (live board 7331 untouched: ${liveBefore} listener(s) before)`);
  ok("the sandbox is bound on its own port", listenersOn(port) >= 1, `${listenersOn(port)} listener(s) on :${port}`);

  // The boot's branch-parents walk only logs a line when it HAS branches to learn, and an empty sandbox has none. The
  // route reads below are the liveness proof instead: a blocked event loop cannot answer them.
  note("the sandbox is answering its routes (no branch-parents line expected in an empty scan root)");

  // ---- the seeded queue file ---------------------------------------------------------------------
  console.log("\n== the store: a seeded queue file, read by the real route ==");
  const view = async () => (await (await fetch(`${base}/api/assistant/queue?assistantId=assistant-1`)).json()).queue || null;
  const before = await view();
  ok("Assistant #1's queue is found at boot", before?.found === true, JSON.stringify({ found: before?.found, error: before?.error }));
  const queueFile = before?.file || "";
  ok("…and names a queue.json on disk", existsSync(queueFile), slash(queueFile));
  writeFileSync(queueFile, `${JSON.stringify({ version: 1, nextId: 5, tasks: TASKS }, null, 2)}\n`, "utf8");
  const seeded = await view();
  check("the route reads the seed: four tasks, one per state", seeded?.tasks?.map((t) => [t.id, t.state]), [[1, "running"], [2, "queued"], [3, "parked"], [4, "done"]]);
  ok("…the running task is stale (no live run behind its thread), so the row has a note to draw", seeded?.tasks?.find((t) => t.id === 1)?.stale === true, String(seeded?.tasks?.find((t) => t.id === 1)?.staleWhy || ""));
  ok("…the queued task is skipped against it, so the row has its reason", /files in use by #1/.test(seeded?.tasks?.find((t) => t.id === 2)?.skipped || ""), seeded?.tasks?.find((t) => t.id === 2)?.skipped || "(none)");
  // A second assistant, so the row's ➡️ Move control (and its title/aria-label) is part of "every glyph".
  const made = await fetch(`${base}/api/assistant/assistants`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok("a second assistant exists, so every row draws its Move glyph", made.status === 201, `HTTP ${made.status}`);

  // The source half of "unowned appears nowhere": a label deleted from the renderer cannot come back silently.
  const assistantSrc = readFileSync(path.join(ROOT, "public/assistant.js"), "utf8");
  const styleSrc = readFileSync(path.join(ROOT, "public/style.css"), "utf8");
  ok("public/assistant.js carries no \"unowned\" string", !assistantSrc.includes("unowned"));
  ok("public/style.css no longer has an .as-task-owner rule", !styleSrc.includes(".as-task-owner"));

  // ---- the pane, in a browser --------------------------------------------------------------------
  console.log("\n== the pane, in a real browser ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the card skin was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<a dir holding node_modules/playwright>");
    failures += 1;
  } else {
    const pageErrors = [];
    liveBrowser = await pw.chromium.launch({ headless: true });
    const context = await liveBrowser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 25_000 });
    await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "visible" });
    await page.waitForSelector('#as-tabs [data-as-tab="assistant-1"]');
    await page.waitForSelector("#as-subtabs", { state: "visible" });
    await page.click('#as-subtabs [data-as-subtab="queue"]');
    await page.waitForSelector("#as-queue:not(.hidden)");

    const rowsReady = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === 4), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "the four seeded cards to paint",
    });
    ok("the pane paints one card per task", rowsReady, `${await page.locator("#as-queue .as-task").count()} card(s)`);
    if (!rowsReady) note(`pane text: ${(await page.locator("#as-queue").innerText()).replace(/\s+/g, " ").slice(0, 700)}`);

    const snap = () =>
      page.evaluate(() => {
        const host = document.querySelector("#as-queue");
        const rows = [...host.querySelectorAll(".as-task")];
        const groupBg = getComputedStyle(host.querySelector(".as-group") || host).backgroundColor;
        const r2 = (n) => Math.round(n * 10) / 10;
        return {
          html: host.innerHTML,
          text: host.innerText,
          bodyText: document.body.innerText,
          groupBg,
          rows: rows.map((el) => {
            const cs = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            const body = el.querySelector(".as-task-body");
            const actions = el.querySelector(".as-task-actions");
            const act = actions ? actions.getBoundingClientRect() : null;
            return {
              id: el.dataset.asQrow,
              qthread: el.dataset.asQthread,
              radius: Number.parseFloat(cs.borderTopLeftRadius) || 0,
              bg: cs.backgroundColor,
              display: cs.display,
              border: Number.parseFloat(cs.borderTopWidth) || 0,
              top: r2(box.top),
              bottom: r2(box.bottom),
              opacity: cs.opacity,
              bodyOpen: body && body.hasAttribute("data-as-qopen") ? body.dataset.asQopen : null,
              headId: el.querySelector(".as-task-head .mono")?.textContent.trim() || "",
              mark: el.querySelector(".as-task-mark")?.textContent.trim() || "",
              title: el.querySelector(".as-task-title")?.textContent.trim() || "",
              meta: (el.querySelector(".as-task-meta")?.textContent || "").replace(/\s+/g, " ").trim(),
              note: (el.querySelector(".as-task-note")?.textContent || "").replace(/\s+/g, " ").trim(),
              agents: [...el.querySelectorAll(".as-task-agent[data-as-qopen]")].map((a) => ({
                thread: a.querySelector(".as-task-agent-thread")?.textContent.trim() || "",
                label: a.querySelector(".as-task-agent-label")?.textContent.trim() || "",
                pill: (a.querySelector(".pill")?.textContent || "").trim(),
                pillClass: a.querySelector(".pill")?.className || "",
              })),
              placeholder: Boolean(el.querySelector(".as-task-agent.is-none")),
              glyphs: [...el.querySelectorAll(".as-task-actions [data-as-qact], .as-task-actions [data-as-qmove-open]")].map((b) => ({
                act: b.dataset.asQact || "move",
                text: b.textContent.trim(),
                title: b.getAttribute("title") || "",
                aria: b.getAttribute("aria-label") || "",
              })),
              actionsLast: el.lastElementChild === actions,
              actionsGapToBottom: act ? r2(box.bottom - act.bottom) : null,
              headBottom: el.querySelector(".as-task-head") ? r2(el.querySelector(".as-task-head").getBoundingClientRect().bottom) : null,
              actionsTop: act ? r2(act.top) : null,
            };
          }),
        };
      });

    const wide = await snap();
    check("the cards are the four seeded tasks, in state order", wide.rows.map((r) => [r.id, r.title]), [
      ["1", "Land the queue cards"],
      ["2", "Tighten the meta line"],
      ["3", "Park on the DBA's verify"],
      ["4", "Ship the removed label"],
    ]);

    // (a) the deleted label ------------------------------------------------------------------------
    ok("\"unowned\" appears nowhere in the pane's markup", !wide.html.toLowerCase().includes("unowned"));
    ok("…nor in the pane's visible text", !wide.text.toLowerCase().includes("unowned"));
    ok("…nor anywhere on the page", !wide.bodyText.toLowerCase().includes("unowned"));

    // (b) every row is a card ----------------------------------------------------------------------
    ok("every row computes a non-zero border-radius", wide.rows.every((r) => r.radius > 0), JSON.stringify(wide.rows.map((r) => r.radius)));
    ok("…a surface of its own, not the group's background", wide.rows.every((r) => r.bg !== "rgba(0, 0, 0, 0)" && r.bg !== wide.groupBg), JSON.stringify({ row: wide.rows[0]?.bg, group: wide.groupBg }));
    ok("…a border, so the surface reads as a card", wide.rows.every((r) => r.border > 0), JSON.stringify(wide.rows.map((r) => r.border)));
    ok("…laid out as a column so the actions can anchor", wide.rows.every((r) => r.display === "flex"), JSON.stringify([...new Set(wide.rows.map((r) => r.display))]));
    const gaps = wide.rows.slice(1).map((r, i) => Math.round((r.top - wide.rows[i].bottom) * 10) / 10);
    ok("…and a visible gap between consecutive cards", gaps.every((g) => g >= 4), JSON.stringify(gaps));

    // the actions row, at the bottom ---------------------------------------------------------------
    ok("the actions row is the card's last child on every row", wide.rows.every((r) => r.actionsLast));
    ok("…and sits at the card's bottom edge", wide.rows.every((r) => r.actionsGapToBottom !== null && r.actionsGapToBottom >= 0 && r.actionsGapToBottom <= 14), JSON.stringify(wide.rows.map((r) => r.actionsGapToBottom)));
    ok("…below the head, not under it", wide.rows.every((r) => r.actionsTop > r.headBottom), JSON.stringify(wide.rows.map((r) => [r.headBottom, r.actionsTop])));

    // the facts the row carried before -------------------------------------------------------------
    check("the head still carries #id, title and the state mark", wide.rows.map((r) => [r.headId, r.mark]), [
      ["#1", "●"],
      ["#2", "○"],
      ["#3", "⏸"],
      ["#4", "✓"],
    ]);
    check("one sub-row per agent, with its thread", wide.rows.map((r) => r.agents.map((a) => a.thread)), [
      ["seed-thread-before", "seed-thread-live"],
      ["seed-thread-queued"],
      ["seed-thread-parked"],
      ["seed-thread-done"],
    ]);
    ok("…each agent wearing a pill with a word and the card's own class", wide.rows.every((r) => r.agents.length && r.agents.every((a) => a.pill && /\bpill\b/.test(a.pillClass))), JSON.stringify(wide.rows.map((r) => r.agents.map((a) => [a.pill, a.pillClass]))));
    ok("no row fell back to the no-agent placeholder", wide.rows.every((r) => !r.placeholder));
    ok("the meta line still names the tree and the files", /tree .*queue-cards-seed/.test(wide.rows[0]?.meta || "") && /files public\/assistant\.js, public\/style\.css/.test(wide.rows[0]?.meta || ""), wide.rows[0]?.meta);
    ok("…and truncates a long file list rather than growing the card", /… · /.test(wide.rows[0]?.meta || ""), wide.rows[0]?.meta);
    ok("the running row says STALE with its why", /^STALE — that thread has no live run/.test(wide.rows[0]?.note || ""), wide.rows[0]?.note);
    ok("the queued row says SKIPPED with the clash", /^SKIPPED — files in use by #1/.test(wide.rows[1]?.note || ""), wide.rows[1]?.note);
    ok("the parked row says parked with its reason", /^parked — waiting on the DBA's verify$/.test(wide.rows[2]?.note || ""), wide.rows[2]?.note);
    ok("the done row is still greyed in place", wide.rows[3]?.opacity !== "1", `opacity ${wide.rows[3]?.opacity}`);
    ok("every glyph is drawn with its title= and aria-label=", wide.rows.every((r) => r.glyphs.length >= 5 && r.glyphs.every((g) => g.title && g.aria && g.text)), JSON.stringify(wide.rows[0]?.glyphs.map((g) => [g.act, g.text, g.aria])));
    ok("…including the ➡️ Move control", wide.rows.every((r) => r.glyphs.some((g) => g.act === "move" && g.aria === "Move")));

    // (d) the row body keeps its opener, and every glyph its action --------------------------------
    ok("every row's body still carries data-as-qopen", wide.rows.every((r) => r.bodyOpen === r.qthread && Boolean(r.qthread)), JSON.stringify(wide.rows.map((r) => [r.qthread, r.bodyOpen])));
    ok("…and every glyph still carries data-as-qact (Move keeps its own opener)", wide.rows.every((r) => r.glyphs.filter((g) => g.act !== "move").every((g) => ["running", "queued", "parked", "done", "delete", "reassign"].includes(g.act))));

    await page.screenshot({ path: path.join(outDir, "queue-cards-1280.png") });
    note(`screenshot ${slash(path.join(outDir, "queue-cards-1280.png"))}`);

    // ---- 340 wide: the same cards, still cards -------------------------------------------------
    // A reload AND a reopen at 340: the float's rect is clamped to the WINDOW when it opens, so a 1280 window narrowed
    // to 340 restores a 480-wide window hanging off the right edge. Closing and opening it at 340 is what a reader on
    // a narrow window does, and it is the state the screenshot should show. The float remembers it was open, so the
    // first press closes it and the second reopens it at the clamped width.
    console.log("\n== 340 wide ==");
    await page.setViewportSize({ width: 340, height: 900 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#assistant", { state: "visible", timeout: 25_000 });
    if (await page.locator("#assistant").isVisible()) await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "hidden", timeout: 10_000 }).catch(() => {});
    await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "visible", timeout: 10_000 });
    const narrowHead = await page.evaluate(() => ({ win: innerWidth, rail: Math.round(document.getElementById("assistant").getBoundingClientRect().width) }));
    note(`at ${narrowHead.win}px the assistant rail is ${narrowHead.rail}px`);
    if (!(await page.locator("#as-queue").isVisible())) {
      await page.waitForSelector("#as-subtabs", { state: "visible" });
      await page.click('#as-subtabs [data-as-subtab="queue"]');
    }
    await page.waitForSelector("#as-queue:not(.hidden)", { timeout: 25_000 });
    const narrowReady = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => n === 4), {
      timeoutMs: 20_000,
      stepMs: 200,
      what: "the four cards to paint at 340 wide",
    });
    ok("the narrow window paints all four cards again", narrowReady, `${await page.locator("#as-queue .as-task").count()} card(s)`);
    await page.locator("#as-queue .as-task").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(250);
    const narrow = await snap();
    ok("the narrow pane still paints all four cards", narrow.rows.length === 4, `${narrow.rows.length} card(s)`);
    ok("…each still a card with a non-zero radius", narrow.rows.every((r) => r.radius > 0), JSON.stringify(narrow.rows.map((r) => r.radius)));
    ok("…still with visible spacing between them", narrow.rows.slice(1).every((r, i) => r.top - narrow.rows[i].bottom >= 4), JSON.stringify(narrow.rows.slice(1).map((r, i) => Math.round((r.top - narrow.rows[i].bottom) * 10) / 10)));
    ok("…still with its agent pill and glyphs", narrow.rows.every((r) => r.agents.every((a) => a.pill) && r.glyphs.length >= 5));
    ok("\"unowned\" is still nowhere at 340", !narrow.html.toLowerCase().includes("unowned"));
    await page.screenshot({ path: path.join(outDir, "queue-cards-340.png") });
    note(`screenshot ${slash(path.join(outDir, "queue-cards-340.png"))}`);
    check("no page errors", pageErrors, []);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log(`screenshots in ${slash(outDir)}`);
  console.log(failures ? "RESULT: FAIL" : "RESULT: PASS  QUEUE-CARDS-OK");
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
