// A folded tool output the reader opens does not carry the console with it: the box unfolds under the header that
// was pressed, and the console's reading position does not move. Settings > Agent cards > "Jump to an opened result"
// is the old behaviour (the console follows the growth to its end), and it ships OFF.
//
//   node tools/verify-console-fold-hold.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-console-fold-hold.mjs
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven     a panel of its own on a spare port (never 7331, apiServer pinned at a dead port so nothing here can buy
//              a worker) plus headless Chromium over it, on a card fabricated in the page's own state (state.jobs +
//              state.jobLines, painted by the shipped renderJobs()), so the console under test is a real render with
//              its own max-height and its own scroll box
//   driven     the press: a real mouse click at a point checked with elementFromPoint (Playwright's own click scrolls
//              its target into view, which would move the very thing under test), then the console's scrollTop,
//              scrollHeight and pin state sampled for 1.3 s across several 400 ms sticks
//   driven     both shapes: one row per call (the shipped default) and the tallied run, whose shut result box needs
//              its own head press after the run is opened
//   driven     the handback: the ↓ chip the hold reveals, a real press on it, and a new line drawn afterwards, which
//              follows again
//   driven     the switch: a real press on #follow-opened in the Settings drawer, and the same press on the same card
//              following the growth — the old behaviour, kept behind the switch
//   inspected  that the row is the page's own (Agent cards, unchecked) — the browser half proves the behaviour, this
//              proves the default nobody pressed yet
//
// The browser half needs a Playwright install; without one this prints BROWSER-HALF-NOT-RUN, counts a failure and
// exits non-zero rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeEventSource, loadPlaywright } from "./browser.mjs";
import { freePort, waitFor } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const okv = JSON.stringify(got) === JSON.stringify(want);
  if (!okv) failures += 1;
  console.log(`${okv ? "PASS" : "FAIL"}  ${name}${okv ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the sandbox panel --------------------------------------------------------------------------
const THREAD = "wtgui-probe-fold-hold-6c21b3";
const NL = String.fromCharCode(10);
let dir = null;
let panel = null;
let base = "";
let browserRef = null;

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-fold-hold-"));
  const scanRoot = path.join(dir, "scan-root");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  for (const d of [scanRoot, home, configDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        defaultCwd: scanRoot,
        jobsFile: path.join(configDir, "logs", "jobs.json"),
        assistantFile: path.join(configDir, "logs", "assistant.json"),
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        treeNamesFile: path.join(configDir, "logs", "tree-names.json"),
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
        refreshSeconds: 3600,
        worktreeSeconds: 3600,
        midSeconds: 3600,
        dormantSeconds: 3600,
        slowSeconds: 3600,
        fetchSeconds: 3600,
      },
      null,
      2,
    )}${NL}`,
    "utf8",
  );
  base = `http://127.0.0.1:${port}`;
  const { spawn } = await import("node:child_process");
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const log = [];
  panel.stdout.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}${NL}${log.slice(-15).join(NL)}`);
  return port;
}
async function stopSandbox() {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 10_000, what: "the panel to exit" });
  await sleep(300);
}

// ---- what can only be read off the source --------------------------------------------------------
function sourceChecks() {
  const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const js = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  check(
    "the switch is one row, in the Agent cards group, and it ships unchecked",
    (() => {
      const start = html.indexOf('data-settings-group="cards"');
      const end = html.indexOf('<div class="settings-group', start + 10);
      const cards = start > 0 && end > start ? html.slice(start, end) : "";
      const row = cards.match(/<label class="settings-row[^"]*" for="follow-opened" title="([^"]+)">([\s\S]*?)<\/label>/);
      return { rows: (html.match(/id="follow-opened"/g) || []).length, inCards: Boolean(row), checked: Boolean(row && /type="checkbox"[^>]*checked/.test(row[2])) };
    })(),
    { rows: 1, inCards: true, checked: false },
  );
  const holds = (js.match(/holdConsoleFor\(/g) || []).length;
  ok("every fold press that opens a box goes through the hold", holds >= 8, `${holds} call sites + the definition`);
  ok("the pin is what the hold clears", /state\.outPinned\[pre\.dataset\.out\] = false;/.test(js) && /state\.outScrolls\[pre\.dataset\.out\] = \{ top: pre\.scrollTop, atBottom: false \};/.test(js), "one unpin, one remembered position");
  ok("the default is off when the browser has never stored the key", /localStorage\.getItem\(FOLD_FOLLOW_KEY\) === "1"/.test(js), "only a stored 1 follows the growth");
}

// ---- the fixture --------------------------------------------------------------------------------
// One prose run, then ONE terminal call whose preview is long enough that opening it adds ~500 px to the console —
// a growth no reading of the layout can confuse with a line arriving.
const FIRST_TEXT = "the fold is the last thing the turn did";
const CALL = "🔧 terminal · npm run verify";
const PREVIEW = Array.from({ length: 30 }, (_, i) => `  _      ok ${String(i + 1).padStart(2, "0")} · a result line the reader opened this box to read`);
const LAST_TEXT = "and that is the whole of it";

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await installFakeEventSource(context);
  await context.addInitScript(
    ({ snapshot, call, preview, firstText, lastText }) => {
      const realFetch = window.fetch.bind(window);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (String((opts && opts.method) || "GET").toUpperCase() !== "POST") {
          if (u.includes("/api/state")) return json({ ...snapshot, jobs: [...state.jobs.values()] });
          if (u.includes("/api/tool-results")) return json({ thread: "probe", tool: "terminal", results: [] });
          return realFetch(url, opts);
        }
        return json({ ok: true });
      };
      window.__probe = {};
      // The card, fabricated in the PAGE's state and painted by the shipped renderJobs(): fourteen prose lines, one
      // terminal call, and its preview. `shape` is the reader's Settings answer for the tool tally, read at render
      // time, so it is stored before the paint - the same order a press in Settings uses.
      window.__probe.show = ({ tallied = false } = {}) => {
        const id = "probe-turn";
        try {
          localStorage.setItem("wtgui.toolGroups", tallied ? "1" : "0");
        } catch {
          /* storage may be unavailable */
        }
        const lines = [];
        for (let i = 0; i < 14; i++) lines.push({ kind: "text", text: `line ${i + 1} of the turn's prose — what the agent said, at some length`, lid: `p${i}` });
        lines.push({ kind: "text", text: firstText, lid: "p14" });
        lines.push({ kind: "text", text: lastText, lid: "p15" });
        // The call is the LAST thing the turn did: at the console's newest line its row (and, in the tallied shape,
        // its box's head) is the bottom row of the console, which is where the reader's pointer can reach it.
        lines.push({ kind: "tool", text: call, at: Date.now() - 90_000 });
        lines.push({ kind: "tool-out", text: "  ↳ terminal · 4.10s" });
        for (const t of preview) lines.push({ kind: "tool-out", text: t });
        state.jobs.clear();
        state.jobLines.clear();
        state.toolStore.clear();
        state.toolGroupOpen.clear();
        state.codeBoxOpen.clear();
        state.callFolded.clear();
        state.callOpen.clear();
        state.outPinned = {};
        state.outScrolls = {};
        state.jobsListSig = "";
        state.maximized = null;
        state.jobLines.set(id, lines);
        state.jobs.set(id, {
          id,
          thread: id,
          turn: 1,
          status: "done",
          prompt: "fold hold probe",
          displayPrompt: "fold hold probe",
          cwd: null,
          worktree: false,
          worktreePath: null,
          projectPath: null,
          ownerPath: null,
          branch: null,
          runId: "run_probe",
          startedAt: new Date(Date.now() - 120_000).toISOString(),
          endedAt: new Date(Date.now() - 60_000).toISOString(),
          model: "probe/model",
          lines: [],
          artifacts: [],
          attachments: [],
          subagents: [],
        });
        renderJobs();
        return { consoles: document.querySelectorAll("pre.job-out").length, rows: document.querySelectorAll("pre.job-out .tgrp-row").length, heads: document.querySelectorAll("pre.job-out .code-head").length };
      };
      // The console's own reading: its scroll position, the room it has, and where the control the reader is about to
      // press sits — all in the console's own coordinates, so a page scroll cannot be mistaken for a console move.
      window.__probe.reading = (sel) => {
        const pre = document.querySelector("pre.job-out");
        if (!pre) return { error: "no console" };
        const el = sel ? pre.querySelector(sel) : null;
        const box = pre.getBoundingClientRect();
        return {
          top: Math.round(pre.scrollTop),
          max: Math.round(pre.scrollHeight - pre.clientHeight),
          pinned: consolePinned(pre.dataset.out),
          overflow: pre.scrollHeight > pre.clientHeight + 4,
          controlAt: el ? Math.round(el.getBoundingClientRect().top - box.top) : null,
          controlH: el ? Math.round(el.getBoundingClientRect().height) : null,
          chipShown: !pre.closest(".out-wrap")?.classList.contains("is-at-end"),
          boxOpen: pre.querySelector(".code-body") ? !pre.querySelector(".code-body").hidden : null,
          bodyH: pre.querySelector(".code-body") ? Math.round(pre.querySelector(".code-body").getBoundingClientRect().height) : 0,
          outOpen: pre.querySelector(".tgrp-out") ? !pre.querySelector(".tgrp-out").hidden : null,
        };
      };
      window.__probe.bottom = () => {
        const pre = document.querySelector("pre.job-out");
        pinConsole(pre.dataset.out);
        setScroll(pre, pre.scrollHeight);
        paintToBottom(pre);
        return Math.round(pre.scrollTop);
      };
      // A line the run draws afterwards: the ordinary append path, which follows only a console that is pinned.
      window.__probe.append = (text) => {
        const pre = document.querySelector("pre.job-out");
        appendJobLine({ id: "probe-turn", line: { kind: "cmd", text } });
        return Math.round(pre.scrollTop);
      };
      window.__probe.follow = () => {
        try {
          return localStorage.getItem("wtgui.foldFollow");
        } catch {
          return "threw";
        }
      };
    },
    { snapshot: realSnapshot, call: CALL, preview: PREVIEW, firstText: FIRST_TEXT, lastText: LAST_TEXT },
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await waitFor(async () => page.evaluate(() => typeof window.renderJobs === "function" && typeof window.__probe === "object"), {
    timeoutMs: 30_000,
    what: "the page's own app.js to be up",
  });

  const show = (opts = {}) => page.evaluate((o) => window.__probe.show(o), opts);
  const reading = (sel = null) => page.evaluate((s) => window.__probe.reading(s), sel);
  const bottom = async () => {
    await page.evaluate(() => window.__probe.bottom());
    await sleep(600); // two 400 ms sticks: the console is pinned AND the sweep has already looked at it
  };
  // A real press at a point that is really over the control, re-measured until it is (the console is a scroll box:
  // the control can be scrolled out of the box's own visible area).
  async function press(selector, dx = 14) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const loc = page.locator(selector).first();
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.height > 1 && box.width > 1) {
        const x = box.x + dx;
        const y = box.y + box.height / 2;
        const over = await page.evaluate(([px, py, sel]) => Boolean(document.elementFromPoint(px, py)?.closest(sel)), [x, y, selector]);
        if (over) {
          await page.mouse.click(x, y);
          return true;
        }
      }
      await sleep(120);
    }
    return false;
  }
  // The console sampled across several sticks: every sample of scrollTop, so a move that happens 300 ms later is
  // still caught rather than read as "it did not move".
  async function sample(sel) {
    const out = [];
    for (const ms of [0, 120, 300, 520, 760, 1300]) {
      if (ms) await sleep(ms - out.at(-1).at);
      out.push({ ...(await reading(sel)), at: ms });
    }
    return out;
  }
  const tops = (samples) => [...new Set(samples.map((s) => s.top))];

  // ---- (a) the shipped default: the console holds still -----------------------------------------
  console.log(`${NL}== (a) opening a call's box does not move the console ==`);
  const shown = await show({});
  check("the shipped shape renders one console holding one call's row", shown, { consoles: 1, rows: 1, heads: 1 });
  await page.evaluate(() => document.querySelector(".job")?.scrollIntoView({ block: "center" }));
  await sleep(200);
  await bottom();
  const a0 = await reading("pre.job-out .tgrp-row");
  ok("the console starts on its newest line, following it", a0.pinned === true && a0.top === a0.max && a0.overflow, `top ${a0.top} of ${a0.max}, pinned ${a0.pinned}`);
  ok("the row the reader is about to press is on screen", a0.controlAt != null && a0.controlAt > 0 && a0.controlAt < 230, `at ${a0.controlAt}px inside the console`);
  ok("the press lands on the row", await press("pre.job-out .tgrp-row"), "a real mouse click at a checked point");
  const a1 = await sample("pre.job-out .tgrp-row");
  const aLast = a1.at(-1);
  ok("what the row opened was drawn and did grow the console", aLast.outOpen === true && aLast.boxOpen === true && aLast.max > a0.max + 200, `room ${a0.max} → ${aLast.max}, body ${aLast.bodyH}px`);
  check("the console did not move at any sample across 1.3 s", tops(a1), [a0.top]);
  check("the row that was pressed did not move under the pointer", aLast.controlAt, a0.controlAt);
  ok("the console is no longer following the run, which is what held it", aLast.pinned === false, `pinned ${aLast.pinned}`);
  ok("the ↓ chip is offered, so the reader can hand it back", aLast.chipShown === true, `is-at-end off (top ${aLast.top} of ${aLast.max})`);

  // ---- (b) the handback ---------------------------------------------------------------------------
  console.log(`${NL}== (b) the ↓ chip hands the console back, and new output follows again ==`);
  ok("the ↓ chip is pressed", await press("[data-to-bottom]", 8), "a real click on the chip");
  await sleep(250);
  const b0 = await reading();
  ok("the chip put the console back on its newest line", b0.top === b0.max, `top ${b0.top} of ${b0.max}`);
  ok("…and re-pinned it, so the run is followed again", b0.pinned === true, `pinned ${b0.pinned}`);
  const b1 = await page.evaluate(() => window.__probe.append("a line the run drew after the handback"));
  await sleep(250);
  const b2 = await reading();
  ok("a line drawn afterwards is followed to the end", b2.top === b2.max && b1 <= b2.max, `top ${b2.top} of ${b2.max}`);

  // ---- (c) the tallied run: a shut result box's own head ------------------------------------------
  console.log(`${NL}== (c) the tallied run: its shut result box holds the console too ==`);
  const tallied = await show({ tallied: true });
  ok("the tallied shape renders a run with a shut box in it", tallied.consoles === 1 && tallied.heads >= 1, JSON.stringify(tallied));
  await page.evaluate(() => document.querySelector(".job")?.scrollIntoView({ block: "center" }));
  await sleep(200);
  await bottom();
  const c0 = await reading();
  ok("the run's own N lines button is pressed open", await press("pre.job-out [data-tgrp-more]"), "a real click on the run's button");
  const c1 = await sample("pre.job-out .code-head");
  check("opening the whole run did not move the console either", tops(c1), [c0.top]);
  ok("the run opened, and its result boxes are still shut", c1.at(-1).boxOpen === false, `boxOpen ${c1.at(-1).boxOpen}, room ${c0.max} → ${c1.at(-1).max}`);
  await bottom();
  const c2 = await reading("pre.job-out .code-head");
  ok("a shut result box's head is now pressable", c2.controlAt != null && c2.controlAt > 0 && c2.controlAt < 230, `at ${c2.controlAt}px inside the console`);
  ok("the box's own head is pressed", await press("pre.job-out .code-head"), "a real click on the head");
  const c3 = await sample("pre.job-out .code-head");
  const cLast = c3.at(-1);
  ok("the recorded output was drawn", cLast.boxOpen === true && cLast.bodyH > 200, `body ${cLast.bodyH}px, room ${c2.max} → ${cLast.max}`);
  check("the console did not move on the box's own head either", tops(c3), [c2.top]);
  check("and the head stayed under the pointer", cLast.controlAt, c2.controlAt);

  // ---- (d) the switch: the old behaviour, kept behind it -------------------------------------------
  console.log(`${NL}== (d) Settings > Agent cards > Jump to an opened result ==`);
  await page.evaluate(() => toggleSettings(true));
  await sleep(250);
  const rowText = await page.evaluate(() => {
    const row = document.querySelector('label[for="follow-opened"]');
    return row ? row.innerText.replace(/\s+/g, " ").trim() : "";
  });
  ok("the row is in the drawer and names the behaviour", /Jump to an opened result/.test(rowText), rowText);
  check("it ships unchecked — the hold is the default", await page.evaluate(() => document.querySelector("#follow-opened").checked), false);
  // The groups start folded, so the row is display:none until the reader opens Agent cards — the same two presses a
  // reader makes. Both are scrolls of the drawer's own scroller, never of a console.
  await page.locator('[data-settings-group="cards"]').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(150);
  ok("the Agent cards group is opened", await press('[data-settings-group="cards"]', 40), "a real click on the group's heading");
  await sleep(250);
  await page.locator('label[for="follow-opened"]').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(200);
  ok("the row is on screen", await page.evaluate(() => { const r = document.querySelector('label[for="follow-opened"]').getBoundingClientRect(); return r.height > 4 && r.top > 0 && r.bottom < window.innerHeight; }), "measured in the drawer");
  ok("the reader presses it", await press('label[for="follow-opened"]', 60), "a real click on the row");
  await sleep(200);
  check("the press is saved in this browser", await page.evaluate(() => window.__probe.follow()), "1");
  await page.evaluate(() => toggleSettings(false));
  await sleep(250);
  const d0show = await show({});
  check("the card is drawn again under the new answer", d0show, { consoles: 1, rows: 1, heads: 1 });
  await page.evaluate(() => document.querySelector(".job")?.scrollIntoView({ block: "center" }));
  await sleep(200);
  await bottom();
  const d0 = await reading("pre.job-out .tgrp-row");
  ok("the press that used to jump is pressed again", await press("pre.job-out .tgrp-row"), "a real click on the row");
  const d1 = await sample("pre.job-out .tgrp-row");
  const dLast = d1.at(-1);
  ok("with the switch on the console follows the growth to its end", dLast.top === dLast.max && dLast.max > d0.max + 200, `top ${dLast.top} of ${dLast.max}, was ${d0.top} of ${d0.max}`);
  ok("…which is exactly the slide the switch is for: the pressed row moved up", dLast.controlAt != null && dLast.controlAt < d0.controlAt, `${d0.controlAt}px → ${dLast.controlAt}px inside the console`);
  ok("and the pin was left alone", dLast.pinned === true, `pinned ${dLast.pinned}`);

  // ---- (e) the switch turned back off, and a repaint keeps the reader's place ---------------------
  console.log(`${NL}== (e) the switch off again, then a repaint after a hold puts the reader back ==`);
  await page.evaluate(() => toggleSettings(true));
  await sleep(250);
  await page.locator('label[for="follow-opened"]').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(200);
  ok("the reader turns the switch back off", await press('label[for="follow-opened"]', 60), "a real click on the same row");
  await sleep(200);
  check("the default is back in this browser", await page.evaluate(() => window.__probe.follow()), "0");
  await page.evaluate(() => toggleSettings(false));
  await sleep(250);
  await show({});
  await page.evaluate(() => document.querySelector(".job")?.scrollIntoView({ block: "center" }));
  await sleep(200);
  await bottom();
  const e0 = await reading("pre.job-out .tgrp-row");
  ok("the row is pressed under the shipped default", await press("pre.job-out .tgrp-row"), "a real click on the row");
  await sleep(300);
  const eHeld = await reading();
  // The card is rebuilt from scratch (`#jobs` is re-rendered by the shipped renderJobs), which is a path that
  // restores every console from its remembered position rather than from the old node.
  await page.evaluate(() => {
    state.jobsListSig = "";
    renderJobs();
  });
  await sleep(400);
  const e1 = await reading();
  ok("the card really was rebuilt", e1.max > e0.max + 200, `room ${e0.max} → ${e1.max}`);
  ok("the console came back where the reader left it, not at its end", e1.top === eHeld.top && e1.top < e1.max, `top ${e1.top} of ${e1.max} (held at ${eHeld.top})`);
  ok("…and it is still not following, so the next growth will not take it either", e1.pinned === false, `pinned ${e1.pinned}`);

  check("no page errors in the whole run", pageErrors, []);
  if (process.env.PROBE_DUMP === "1") note(`last reading: ${JSON.stringify(await reading())}`);
  await browser.close();
  browserRef = null;
}

async function main() {
  console.log("== the sandbox ==");
  const port = await startSandbox();
  note(`port ${port} — the live board on 7331 is not touched`);
  check("the sandbox panel is the one that answered", (await fetch(`${base}/api/state`)).ok, true);

  console.log(`${NL}== what can only be read off the source ==`);
  sourceChecks();

  console.log(`${NL}== the browser: a real console, a real press, a real setting ==`);
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-console-fold-hold.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log(`${NL}== summary ==`);
  console.log(`${checks} checks, ${failures} failed`);
  console.log(`${NL}WHAT WAS DRIVEN: a panel of this checkout on a spare port plus headless Chromium over it, on a card`);
  console.log("fabricated in the page's own state and painted by the shipped renderJobs(); real mouse clicks at points");
  console.log("checked with elementFromPoint, on the call's own row, a shut result box's head, the run's N lines button,");
  console.log("the ↓ chip and the Settings row; the console's scrollTop/scrollHeight/pin sampled six times across 1.3 s so");
  console.log("a move that lands on the 400 ms stick is still measured.");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: that the switch is one row in Agent cards, unchecked, and that only a");
  console.log("stored \"1\" turns the follow back on — the browser half proves the behaviour, this proves the default a");
  console.log("reader who never opened Settings gets.");
  if (!failures) console.log("CONSOLE-FOLD-HOLD-OK");
}

main()
  .catch((err) => {
    failures += 1;
    console.log(`${NL}FAIL  the run threw: ${String((err && err.stack) || err)}`);
  })
  .finally(async () => {
    if (browserRef) {
      try {
        await browserRef.close();
      } catch {
        /* already gone */
      }
      browserRef = null;
    }
    await stopSandbox();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch (e) {
        console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
      }
    }
    process.exitCode = failures ? 1 : 0;
  });
