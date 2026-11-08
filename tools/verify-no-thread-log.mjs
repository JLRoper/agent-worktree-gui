// HARNESS: LIVE GATE
// The thread's dim log is GONE from the assistant cards, proved on the REAL page: no queue-landed, queue-sent or
// message-sent echo is drawn under any assistant's input box, while the journal entries themselves still exist on
// the server and a queue row filed by ANOTHER assistant still names its filer.
//
//   node tools/verify-no-thread-log.mjs
//
// The claim is about what the page draws, so it is proved by Chromium over a booted panel - never by slicing the
// renderer's string (test/assistant-no-thread-log.test.js pins the source; this pins the page). In order, this gate:
//
//   1. serves the page's own files and reads them: `/assistant.js` carries none of `threadLogRowsHtml`,
//      `paintThreadLog`, `THREAD_LOG_KINDS`, `as-thread-log` or `as-thread-line`, and `/style.css` carries neither
//      rule - so the removal is what the panel serves, not only what the checkout holds;
//   2. seeds the journal with the three kinds lib/assistant.js writes and proves `/api/assistant` still serves them
//      (the entries stay; only their echo under the card is gone);
//   3. files a row into Assistant #1's queue with `by: "assistant-2"` through the route's own POST, so the filer is a
//      real assistant and the row's `createdBy` is the route's write;
//   4. opens every assistant's tab and counts the log's own shapes in the pane and in the document: no
//      `.as-thread-log`, no `.as-thread-line`, no `[data-as-line]`, no `[data-as-thread-log]`, and no line leading
//      with the log's marker - including the intro box a thread with no turn yet draws, which is the case the block
//      was written for;
//   5. opens the Queue sub-tab and reads the filed row: `filed by Assistant #2` is still drawn under its title;
//   6. writes a screenshot of the float when PANEL_VERIFY_SHOT names a path (and the filed row beside it, suffixed
//      `-filed`), fails on any page error, and never touches the live board on 7331 (its listener count is compared).
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT, freePort, waitFor } from "./panel-testkit.mjs";
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

let failures = 0;
let checks = 0;
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
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

// The journal the panel would have written: one landing on Assistant #1's thread, and the Director's own two
// outbound lines on its thread. Newest-first, the order `state()` sends.
const now = Date.now();
const iso = (min) => new Date(now - min * 60_000).toISOString();
const JOURNAL = [
  { at: iso(1), kind: "message-sent", thread: "panel-assistant-2", text: "MESSAGE Assistant #1 | #12 on the docs tree is stale: requeue it — sent" },
  { at: iso(2), kind: "queue-sent", thread: "panel-assistant-2", text: "QUEUE Assistant #1 | #12 fix the stale row on the docs tree — filed" },
  { at: iso(3), kind: "queue-landed", thread: "panel-assistant", text: "#12 fix the stale row on the docs tree — filed in this queue by the Assistant Director" },
  { at: iso(4), kind: "queue", thread: "panel-assistant", text: "#9 a row the panel settled — done by the panel: its PR merged" },
];

let panel = null;
let liveBrowser = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-no-thread-log-"));
  const repos = path.join(dir, "repos");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  const cwdDir = path.join(dir, "panel-cwd");
  const logs = path.join(configDir, "logs");
  for (const d of [repos, home, configDir, logs, cwdDir]) mkdirSync(d, { recursive: true });

  const liveBefore = listenersOn(7331);
  const port = await freePort();
  ok("the sandbox port is not the live one", port !== 7331, `port ${port}`);
  note(`temp root ${dir}`);

  // The journal is read at boot, so it is written before the process starts.
  const assistantFile = path.join(logs, "assistant.json");
  writeFileSync(
    assistantFile,
    `${JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: JOURNAL }, null, 1)}\n`,
    "utf8",
  );

  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [repos],
        refreshSeconds: 30,
        worktreeSeconds: 30,
        midSeconds: 30,
        threads: 1,
        scanMode: "all",
        defaultCwd: cwdDir,
        assistantFile,
        jobsFile: path.join(logs, "jobs.json"),
        projectsCacheFile: path.join(logs, "projects.json"),
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
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
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
        /* Windows can hold a file for a moment; the run's verdict does not depend on the cleanup */
      }
    },
  };
  const up = await waitFor(async () => (await fetch(`${base}/api/health`)).ok, { timeoutMs: 90_000, stepMs: 300, what: "the sandbox panel to answer /api/health" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
  ok("the sandbox is bound on its own port", listenersOn(port) >= 1, `${listenersOn(port)} listener(s) on :${port}`);

  const GET = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const POST = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  console.log("\n== the page the panel serves: the renderer and the rules are gone ==");
  const servedJs = await (await fetch(`${base}/assistant.js`)).text();
  const servedCss = await (await fetch(`${base}/style.css`)).text();
  for (const gone of ["threadLogRowsHtml", "paintThreadLog", "THREAD_LOG_KINDS", "as-thread-log", "as-thread-line"]) {
    ok(`/assistant.js carries no ${gone}`, servedJs.includes(gone) === false, `${servedJs.length} bytes served`);
  }
  for (const rule of [".as-thread-log", ".as-thread-line"]) {
    ok(`/style.css carries no ${rule}`, servedCss.includes(rule) === false, `${servedCss.length} bytes served`);
  }

  console.log("\n== the journal: the entries themselves stay ==");
  const state = await GET("/api/assistant");
  const journal = state.body?.journal || [];
  const kinds = journal.map((j) => j.kind);
  ok("queue-landed, queue-sent and message-sent are still journaled", kinds.includes("queue-landed") && kinds.includes("queue-sent") && kinds.includes("message-sent"), kinds.join(", "));
  ok("and the landing still carries the row id and its title", journal.some((j) => j.kind === "queue-landed" && /^#12 .*filed in this queue/.test(j.text)), journal.find((j) => j.kind === "queue-landed")?.text);

  console.log("\n== the filer: a row Assistant #2 filed into Assistant #1's queue ==");
  const made2 = await POST("/api/assistant/assistants", {});
  ok("a second assistant exists, so the filer is a real one", made2.status === 201, `HTTP ${made2.status}`);
  const made3 = await POST("/api/assistant/assistants", {});
  ok("and a third, which nothing was carried out for", made3.status === 201, `HTTP ${made3.status}`);
  const filed = await POST("/api/assistant/queue", {
    assistantId: "assistant-1",
    action: "add",
    title: "read the other queue's PR",
    detail: "the row Assistant #2 filed",
    by: "assistant-2",
  });
  ok("the route filed it into Assistant #1's queue", filed.status === 200 && filed.body?.task?.id, JSON.stringify(filed.body?.error || filed.body?.task?.title || filed.body));
  check("…naming Assistant #2 as its filer and owning nobody", [filed.body?.task?.createdBy, filed.body?.task?.owner], ["assistant-2", null]);
  const dock = await POST("/api/assistant/profile", { assistantId: "assistant-1", dock: "floating" });
  ok("the float is the frame this gate drives", dock.status === 200, JSON.stringify(dock.body?.dock || dock.body?.error));

  const pw = loadPlaywright();
  if (!pw) throw new Error("BROWSER-HALF-NOT-RUN — no Playwright install; set PANEL_PLAYWRIGHT_ROOT to a dir holding node_modules/playwright");
  const pageErrors = [];
  liveBrowser = await pw.chromium.launch({ headless: true });
  const context = await liveBrowser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-assistant", { state: "visible" });
  await page.click("#btn-assistant");
  await page.waitForSelector("#assistant", { state: "visible" });
  await page.waitForSelector('#as-tabs [data-as-tab="assistant-2"]', { state: "visible" });

  // #1's panes keep the ids the page has always used; a second assistant's are suffixed (paneIdFor).
  const chatPane = (id) => (id === "assistant-1" ? "#as-chat" : `#as-chat-${String(id).replace(/^assistant-/, "")}`);
  const openTab = async (id) => {
    await page.click(`#as-tabs [data-as-tab="${id}"]`);
    // The sub-tab strip is shared: a pane left on Queue keeps Chat hidden, so hand the room back before waiting.
    const chatTab = await page.$('#as-subtabs [data-as-subtab="chat"]');
    if (chatTab) await chatTab.click().catch(() => {});
    await page.waitForSelector(chatPane(id), { state: "visible" });
    await page.waitForTimeout(250);
  };
  // The log's own shapes, counted in the pane and in the whole document: a block that moved out of the pane but
  // stayed in the page would still be a grey line under some input box.
  const logShapes = (selector) =>
    page.evaluate((who) => {
      const pane = document.querySelector(who);
      const shapes = ".as-thread-log, .as-thread-line, [data-as-line], [data-as-thread-log]";
      return {
        pane: pane ? pane.querySelectorAll(shapes).length : -1,
        document: document.querySelectorAll(shapes).length,
        arrows: pane ? (pane.innerText.match(/⇢/g) || []).length : -1,
        text: pane ? pane.innerText.replace(/\s+/g, " ").trim().slice(0, 160) : "",
      };
    }, selector);

  console.log("\n== every assistant's tab: no log under the input box ==");
  for (const id of ["assistant-2", "assistant-1", "assistant-3"]) {
    await openTab(id);
    const shapes = await logShapes(chatPane(id));
    check(`${id}: no log block, line or marker in the pane`, [shapes.pane, shapes.arrows], [0, 0]);
    check(`${id}: and none anywhere in the document`, shapes.document, 0);
    note(`${id} pane reads: ${shapes.text || "(no text)"}`);
  }

  console.log("\n== the row Assistant #2 filed still names it ==");
  await openTab("assistant-1");
  await page.click('#as-subtabs [data-as-subtab="queue"]');
  await page.waitForSelector("#as-queue:not(.hidden)");
  const rowsPainted = await waitFor(() => page.locator("#as-queue .as-task").count().then((n) => (n >= 1 ? n : 0)), {
    timeoutMs: 25_000,
    stepMs: 200,
    what: "the filed row to paint",
  });
  ok("the queue pane paints the filed row", rowsPainted >= 1, `${await page.locator("#as-queue .as-task").count()} row(s)`);
  const row = await page.evaluate(() => {
    const el = document.querySelector('#as-queue .as-task[data-as-qrow="1"]');
    if (!el) return null;
    return {
      title: el.querySelector(".as-task-title")?.textContent?.trim() || "",
      filed: el.querySelector(".as-task-filed")?.innerText?.replace(/\s+/g, " ").trim() || "",
      titleAttr: el.querySelector(".as-task-filed")?.getAttribute("title") || "",
    };
  });
  check("the row's own line names the filer", row?.filed, "filed by Assistant #2");
  ok("…under the row it belongs to", row?.title === "read the other queue's PR", row?.title);
  ok("…and the line says what it means", /who filed this row/i.test(row?.titleAttr || ""), row?.titleAttr);

  const shot = String(process.env.PANEL_VERIFY_SHOT || "").trim();
  if (shot) {
    console.log("\n== the picture ==");
    const filedShot = shot.replace(/\.png$/i, "-filed.png");
    // The float itself, not the whole board: at a 1500 px viewport the rail is a strip on the right, and a reader
    // comparing the row's filer line needs the pane, not the page around it.
    const float = await page.$("#assistant");
    const shoot = async (target, file) => (target ? target.screenshot({ path: file }) : page.screenshot({ path: file }));
    await shoot(float, filedShot);
    ok("the filed row's screenshot was written", existsSync(filedShot), filedShot);
    await openTab("assistant-1");
    await page.waitForSelector(chatPane("assistant-1"), { state: "visible" });
    await shoot(await page.$("#assistant"), shot);
    ok("the card's screenshot was written", existsSync(shot), shot);
  }

  check("no page errors", pageErrors, []);
  ok("the live board on 7331 was not touched", listenersOn(7331) === liveBefore, `${liveBefore} -> ${listenersOn(7331)} listener(s)`);
} catch (err) {
  failures += 1;
  console.log(`FAIL  the gate threw — ${String((err && err.stack) || err)}`);
  if (panel) console.log(panel.log().split(/\r?\n/).slice(-20).join("\n"));
} finally {
  clearTimeout(watchdog);
  try {
    await liveBrowser?.close();
  } catch {
    /* a browser that will not close does not change the verdict */
  }
  try {
    await panel?.stop();
  } catch {
    /* the temp dir is a convenience */
  }
  console.log(`\n${failures ? "FAILED" : "OK"} — ${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}
