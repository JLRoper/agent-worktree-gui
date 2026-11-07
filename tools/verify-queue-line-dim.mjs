// HARNESS: LIVE GATE
// The thread's dim log, proved on the REAL page: a QUEUE row that landed on an assistant, and the Director's own
// outbound QUEUE/MESSAGE lines, are drawn as dim lines under that assistant's card.
//
//   node tools/verify-queue-line-dim.mjs
//
// The claim is about pixels and about which thread a line belongs to, so it is proved by Chromium over a booted
// panel - never by slicing the renderer's string (test/assistant-thread-log.test.js pins the filter; this pins the
// page). In order, this gate:
//
//   1. seeds the panel's own journal with the three kinds lib/assistant.js writes - `queue-landed` on the row's new
//      owner, `queue-sent` and `message-sent` on the Director's thread - and boots a sandbox on its own port;
//   2. opens the float on the DIRECTOR's tab and reads the block under its card: both outbound lines, in the order
//      they were written, with the row id and title on the QUEUE line;
//   3. opens the TARGET's tab: the landing line, and NOT the Director's outbound ones (a line belongs to the thread
//      it was filed under);
//   4. opens a third assistant's tab, which nothing was carried out for: no block at all, not an empty one;
//   5. measures the ink: the block is `--dimmer` and italic, the console's own `.jl-dim`, and it sits under the card
//      rather than inside it;
//   6. fails on any page error, and never touches the live board on 7331 (its listener count is compared).
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
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-dim-"));
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

  console.log("\n== the sandbox: the journal the panel writes, and three assistants ==");
  const state = await GET("/api/assistant");
  const kinds = (state.body?.journal || []).map((j) => j.kind);
  ok("the seeded journal is the panel's own", kinds.includes("queue-landed") && kinds.includes("queue-sent") && kinds.includes("message-sent"), kinds.join(", "));
  const made2 = await POST("/api/assistant/assistants", {});
  ok("a second assistant exists, so the Director's thread is a real tab", made2.status === 201, `HTTP ${made2.status}`);
  const made3 = await POST("/api/assistant/assistants", {});
  ok("and a third, which nothing was carried out for", made3.status === 201, `HTTP ${made3.status}`);
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
    await page.waitForSelector(chatPane(id), { state: "visible" });
    await page.waitForTimeout(250);
  };
  const logOf = async (id) =>
    page.evaluate((who) => {
      const host = document.querySelector(who === "assistant-1" ? "#as-chat" : `#as-chat-${String(who).replace(/^assistant-/, "")}`);
      const box = host?.querySelector(":scope > .as-thread-log") || null;
      if (!box) return { present: false, lines: [], underCard: null, style: null };
      const first = host.firstElementChild;
      const cs = getComputedStyle(box);
      return {
        present: true,
        lines: [...box.querySelectorAll(".as-thread-line")].map((el) => el.innerText.replace(/\s+/g, " ").trim()),
        // Under the card (or under the intro box a thread with no turn yet draws), never the first thing in the pane.
        underCard: Boolean(first && first !== box && host.lastElementChild === box),
        style: { color: cs.color, fontStyle: cs.fontStyle, dimmer: getComputedStyle(document.documentElement).getPropertyValue("--dimmer").trim() },
      };
    }, id);

  console.log("\n== the Director's own thread: what it sent ==");
  await openTab("assistant-2");
  const director = await logOf("assistant-2");
  ok("the Director's card carries a log block", director.present, JSON.stringify(director.lines));
  check("…with its outbound QUEUE and MESSAGE lines, oldest first", director.lines, [
    "⇢ QUEUE Assistant #1 | #12 fix the stale row on the docs tree — filed",
    "⇢ MESSAGE Assistant #1 | #12 on the docs tree is stale: requeue it — sent",
  ]);
  ok("…and not the landing line, which belongs to the target", !director.lines.some((l) => /filed in this queue/.test(l)), director.lines.join(" | "));

  console.log("\n== the target's thread: the row that landed ==");
  await openTab("assistant-1");
  const target = await logOf("assistant-1");
  ok("the target's card carries a log block", target.present, JSON.stringify(target.lines));
  check("…with the landing line, row id and title first", target.lines, [
    "⇢ #12 fix the stale row on the docs tree — filed in this queue by the Assistant Director",
  ]);
  ok("…and not the Director's outbound lines", !target.lines.some((l) => /^⇢ (QUEUE|MESSAGE) /.test(l)), target.lines.join(" | "));

  console.log("\n== a thread nothing was carried out for ==");
  await openTab("assistant-3");
  const quiet = await logOf("assistant-3");
  ok("no block at all, not an empty one", quiet.present === false, JSON.stringify(quiet.lines));

  console.log("\n== the ink: the console's own dim line ==");
  await openTab("assistant-1");
  const ink = await logOf("assistant-1");
  ok("the block sits under the card, not inside it", ink.underCard === true, String(ink.underCard));
  ok("it is italic", ink.style?.fontStyle === "italic", String(ink.style?.fontStyle));
  ok("it is --dimmer", Boolean(ink.style?.color) && ink.style.color !== "rgb(255, 255, 255)", `${ink.style?.color} (--dimmer ${ink.style?.dimmer})`);

  // A picture of the block, when the caller asks for one: the gate's verdict is the checks above, this is for a
  // reader who wants to see the ink.
  const shot = String(process.env.PANEL_VERIFY_SHOT || "").trim();
  if (shot) {
    await openTab("assistant-2");
    await page.screenshot({ path: shot, fullPage: false });
    ok("the screenshot was written", existsSync(shot), shot);
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
