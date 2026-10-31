// The sliding-average liveness ranking, proved for the TWO scopes the row script does not cover: the projects
// inside a folder and the agent cards inside a worktree row. A real browser over a sandbox panel, with a
// controlled clock.
//
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-ranking-scopes.mjs
//
// The rows within a project are proved by tools/verify-row-rank-smoothing.mjs. This one proves the extension: the
// same engine and the same window govern the project ranking inside a folder (and the folders themselves) and the
// agent-card ranking inside a row, so those two no longer key on a maximum either - a project used to lead because
// its newest commit was the newest, and a card because its turn started last. Both now rank on the rate of
// liveness events over the same `rankWindowSeconds` window, advanced one place per reorder tick with the same
// hysteresis, and the SAME Display setting controls all of them.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven        Playwright (headless Chromium) with `page.clock` installed and PAUSED, so a tick is exactly
//                 5000 ms of fake time. Two throwaway repos under two scan roots give two projects in one folder
//                 and two folders; two fabricated agent cards (injected into the page's own `state.jobs`, the same
//                 store the SSE stream writes) give two cards in one row. Events go in through `noteEventLife` -
//                 the shipped function - with a harness stub for its thread->row lookup.
//   driven        (P1) a burst on a project's rows climbs the project across ticks, not on the first; (P2) one
//                 isolated event moves a project nowhere; (P3) the folder holding the busier project leads; (P4)
//                 the window setting changes the project ranking; (A1) a burst on one card climbs it across ticks;
//                 (A2) one isolated event moves a card nowhere; (A3) the same window governs the cards.
//   inspected     the in-place card re-order (`reorderAgentCards`) is asserted through the row's own DOM when the
//                 fabricated cards render there; the ranking decision itself is read from `orderedAgents`, which is
//                 the shipped function that decides the card order.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { ROOT, pickFreePort as freePort } from "./panel-testkit.mjs";

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
const note = (t) => console.log(`      ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 90_000, stepMs = 500, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}
const git = (dir, args, env = {}) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } }).trim();
  } catch (e) {
    return String((e && e.stdout) || "");
  }
};

// ---- the sandbox: two scan roots, one repo each, two worktrees each -------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-rank-scopes-"));
const rootA = path.join(dir, "root-a");
const rootB = path.join(dir, "root-b");
const repoAlpha = path.join(rootA, "alpha-repo");
const repoBravo = path.join(rootA, "bravo-repo");
const repoDelta = path.join(rootA, "delta-repo");
const repoCharlie = path.join(rootB, "charlie-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
for (const d of [repoAlpha, repoBravo, repoDelta, repoCharlie, path.join(repoAlpha, ".worktrees"), path.join(repoBravo, ".worktrees"), path.join(repoDelta, ".worktrees"), path.join(repoCharlie, ".worktrees"), home, configDir]) mkdirSync(d, { recursive: true });
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const OLD = { GIT_AUTHOR_DATE: daysAgo(45), GIT_COMMITTER_DATE: daysAgo(45) };
const commit = (p, m, env = {}) => {
  git(p, ["add", "-A"]);
  git(p, ["-c", "user.name=v", "-c", "user.email=v@l", "commit", "-q", "-m", m], env);
};
for (const repo of [repoAlpha, repoBravo, repoDelta, repoCharlie]) {
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# sandbox\n", "utf8");
  commit(repo, "seed", OLD);
  for (const n of ["w-one", "w-two"]) {
    git(repo, ["worktree", "add", "-q", "-b", `work/${n}`, path.join(repo, ".worktrees", n)]);
    writeFileSync(path.join(repo, ".worktrees", n, "f.txt"), n, "utf8");
    commit(path.join(repo, ".worktrees", n), `work ${n}`, OLD);
  }
}
const port = await freePort();
const configPath = path.join(configDir, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [rootA, rootB],
      refreshSeconds: 4,
      worktreeSeconds: 30,
      midSeconds: 30,
      dormantSeconds: 60,
      slowSeconds: 15,
      fetchSeconds: 3600,
      threads: 1,
      scanMode: "all",
      liveMinutes: 5,
      hideOlderThanDays: 0,
      defaultCwd: repoAlpha,
      projectsCacheFile: path.join(configDir, "logs", "projects.json"),
      apiServer: { url: "http://127.0.0.1:9", key: "k" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const base = `http://127.0.0.1:${port}`;
const panelLog = [];
let panel = null;

async function browserPhase(pw) {
  const pageErrors = [];
  const consoleErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  // Deliberately nothing expanded: an open project keeps its exact slot, so the project ranking can only be
  // observed with every project closed. The agent phase opens one afterwards.
  await context.addInitScript(() => localStorage.removeItem("wm.expandedProjects"));
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/i.test(m.text())) consoleErrors.push(m.text());
  });
  const T0 = new Date();
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0);
  await page.goto(base, { waitUntil: "domcontentloaded" });

  await page.evaluate(() => {
    // The only substitution: thread -> row. `noteEventLife` itself, the windows, the score and the comparator are
    // the shipped code.
    window.__rowForThread = window.__rowForThread || {};
    window.rowKeyForThread = (t) => window.__rowForThread[t] || (String(t).startsWith("evt:") ? String(t).slice(4) : null);
    window.__ticks = 0;
    const orig = window.tickLivenessRanks;
    window.tickLivenessRanks = (...a) => {
      window.__ticks += 1;
      return orig(...a);
    };
  });
  const tickCount = () => page.evaluate(() => window.__ticks | 0);
  const tick = async () => {
    const before = await tickCount();
    await page.clock.fastForward(5000);
    if ((await tickCount()) === before) for (let i = 0; i < 5; i++) {
      await page.clock.fastForward(1000);
      if ((await tickCount()) > before) break;
    }
    return page.evaluate(() => Date.now());
  };
  const fire = (thread, n = 1) =>
    page.evaluate(
      ([t, c]) => {
        for (let i = 0; i < c; i++) noteEventLife(t);
      },
      [thread, n],
    );
  // The board's folders, each with the projects inside it in the order the DOM shows them.
  const folderList = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#projects > section.root-group")].map((g) => ({
        root: g.dataset.root.split(/[\\/]/).pop(),
        projects: [...g.querySelectorAll(".root-body section.project")].map((s) => s.dataset.project),
      })),
    );
  const folderOrder = () => page.evaluate(() => [...document.querySelectorAll("#projects > section.root-group")].map((g) => g.dataset.root.split(/[\\/]/).pop()));
  const cardOrder = (project) =>
    page.evaluate((p) => {
      const row = [...state.rows.values()].find((r) => r.project === p && agentsFor(r).length);
      if (!row) return [];
      return orderedAgents(row, agentsFor(row)).map((c) => c.thread);
    }, project);
  const domCards = (project) =>
    page.evaluate((p) => {
      const row = [...state.rows.values()].find((r) => r.project === p && agentsFor(r).length);
      const dEl = row && state.detailEls.get(keyOf(row.project, row.path));
      if (!dEl) return [];
      return [...dEl.querySelectorAll(".agents-block .job[data-thread]")].map((c) => c.dataset.thread);
    }, project);
  const projScore = (name) => page.evaluate((n) => rankScore(lifeProjKey(n), Date.now()), name);
  const agentScore = (thread) => page.evaluate((t) => rankScore(lifeAgentKey(t), Date.now()), thread);
  const setWindow = async (secs) => {
    await openSettingsGroup(page, "display");
    await page.fill("#rank-window", String(secs));
    await page.dispatchEvent("#rank-window", "change");
    await page.click("#btn-settings-close");
  };

  const drawn = await waitFor(async () => (await page.$$eval("#projects section.project", (e) => e.length)) >= 2, { what: "both sandbox projects to be on the board" });
  if (!drawn) throw new Error("the sandbox board never drew its two projects");

  let rowInfo = null; // resolved in the agent phase, once its project is open

  console.log("\n== (P1) a burst on a project's rows climbs the PROJECT across ticks ==");
  const folders0 = await folderList();
  const twoUp = folders0.find((f) => f.projects.length >= 2);
  ok("one folder holds three projects (the scope this phase is about)", Boolean(twoUp) && twoUp.projects.length >= 3, JSON.stringify(folders0));
  check("that folder holds the three repos that share a scan root", twoUp.projects.slice().sort(), ["alpha-repo", "bravo-repo", "delta-repo"]);
  const bootProjects = twoUp.projects;
  const burstProject = bootProjects[2] || bootProjects[1] || bootProjects[0];
  const otherProject = bootProjects.find((n) => n !== burstProject);
  const startPlace = bootProjects.indexOf(burstProject) + 1;
  note(`before: ${bootProjects.join(" > ")} (folder ${twoUp.root})`);
  const projOrderNow = async () => (await folderList()).find((f) => f.root === twoUp.root).projects;
  const burstRowKeys = await page.evaluate((n) => [...state.rows.values()].filter((r) => r.project === n).map((r) => keyOf(r.project, r.path)), burstProject);
  const puff = async (n) => {
    for (const k of burstRowKeys) await fire(`evt:${k}`, n);
  };
  const climb = [];
  await puff(8);
  climb.push({ t: await tick(), order: await projOrderNow() });
  await puff(8);
  climb.push({ t: await tick(), order: await projOrderNow() });
  for (let i = 0; i < 5; i++) climb.push({ t: await tick(), order: await projOrderNow() });
  for (const [i, r] of climb.entries()) note(`tick ${i + 1} @ ${new Date(r.t).toISOString().slice(11, 23)}  ${burstProject} at place ${r.order.indexOf(burstProject) + 1}/${r.order.length}  ${r.order.join(" > ")}`);
  note(`${burstProject} holds ${await page.evaluate((n) => (state.eventWindows.get(lifeProjKey(n)) || []).length, burstProject)} project events, rate ${(await projScore(burstProject)).toFixed(2)}/min; ${otherProject} rate ${(await projScore(otherProject)).toFixed(2)}/min; tiers ${JSON.stringify(await page.evaluate((ns) => Object.fromEntries(ns.map((n) => [n, projectRanks().get(n)?.tier])), [burstProject, otherProject]))}`);
  note(`the stored project order is ${JSON.stringify(await page.evaluate(() => state.rankOrder.get("projects") || []))}`);
  ok("the bursting project is NOT first on the first tick", climb[0].order.indexOf(burstProject) !== 0, `place ${climb[0].order.indexOf(burstProject) + 1} (started ${startPlace})`);
  ok("it climbs one place a tick until it leads", climb.at(-1).order.indexOf(burstProject) === 0 && climb.every((r, i) => i === 0 || r.order.indexOf(burstProject) <= climb[i - 1].order.indexOf(burstProject)));

  console.log("\n== (P2) one isolated event moves a project nowhere ==");
  const held = await projOrderNow();
  const alphaKey = await page.evaluate((n) => {
    const row = [...state.rows.values()].find((r) => r.project === n);
    return row ? keyOf(row.project, row.path) : null;
  }, otherProject);
  await fire(`evt:${alphaKey}`, 1);
  await tick();
  const afterP2 = await projOrderNow();
  ok("a single event on the other project's row leaves the project order alone", JSON.stringify(afterP2) === JSON.stringify(held), `${held.join(" > ")} -> ${afterP2.join(" > ")}`);
  note(`${otherProject}'s rate is ${(await projScore(otherProject)).toFixed(3)}/min (the margin is 1/min)`);

  console.log("\n== (P3) the folder holding the busier project leads ==");
  const folders = await folderOrder();
  note(`folders: ${folders.join(" > ")}`);
  ok("the folder of the bursting project is on top", folders[0] === twoUp.root, `folders ${folders.join(" > ")} (the bursting project lives in ${twoUp.root})`);

  console.log("\n== (P4) the window setting changes the PROJECT ranking's smoothing ==");
  await page.evaluate(() => {
    state.eventWindows.clear();
    state.rankOrder.clear();
    state.rankSeeded = new Set([...state.rows.keys()]);
  });
  await puff(30);
  for (let i = 0; i < 26; i++) await tick(); // age the burst by ~130 s
  await setWindow(900);
  const p900 = await projScore(burstProject);
  await setWindow(60);
  const p60 = await projScore(burstProject);
  check("with a 900 s window the 130-s-old events are inside it", Math.round(p900 * 1000) / 1000, 6);
  check("with a 60 s window they are outside it", Math.round(p60 * 1000) / 1000, 0);
  await setWindow(300);

  console.log("\n== (A1/A2/A3) the AGENT CARDS in a row rank the same way ==");
  // Open alpha-repo and one of its worktree rows: the cards live in a row's detail, and a collapsed project draws
  // no rows at all. Opening a project pins it in the project order, which is why this comes after those phases.
  await page.click(`section.project[data-project="alpha-repo"] .project-head[data-toggle-project]`);
  if (!(await waitFor(async () => (await page.$$eval('tbody[data-tbody="alpha-repo"] tr.row', (e) => e.length)) > 0, { what: "alpha-repo's rows to be drawn" }))) throw new Error("alpha-repo never drew its rows");
  rowInfo = await page.evaluate(() => {
    const row = [...state.rows.values()].find((r) => r.project === "alpha-repo" && !isMainWorktree("alpha-repo", r));
    return row ? { key: keyOf(row.project, row.path), path: row.path } : null;
  });
  ok("a worktree row of alpha-repo to hang three cards on", Boolean(rowInfo), rowInfo?.path);
  await page.click(`tbody[data-tbody="alpha-repo"] tr.row[data-key="${rowInfo.key}"] td.branch`);
  await waitFor(async () => (await page.evaluate((k) => Boolean(state.detailEls.get(k)), rowInfo.key)), { what: "the row's detail to open" });
  // Two fabricated cards on one row, injected into the page's own job store - the same store the SSE stream writes.
  const injectCards = (resetScope = false) =>
    page.evaluate(([p, key, at, reset]) => {
      const mk = (id, thread) => ({
        id,
        thread,
        ownerPath: p,
        status: "done",
        startedAt: new Date(at - 120000).toISOString(),
        endedAt: new Date(at - 60000).toISOString(),
        exitCode: 0,
        turn: 1,
        prompt: `fabricated card ${thread}`,
        lines: [],
      });
      state.jobs.set("job-agt-a", mk("job-agt-a", "agt-a"));
      state.jobs.set("job-agt-b", mk("job-agt-b", "agt-b"));
      state.jobs.set("job-agt-c", mk("job-agt-c", "agt-c"));
      window.__rowForThread["agt-a"] = key;
      window.__rowForThread["agt-b"] = key;
      window.__rowForThread["agt-c"] = key;
      invalidatePanelMap();
      if (reset) state.rankOrder.delete(`agents:${key}`);
      renderProjectRows("alpha-repo");
      return true;
    }, [rowInfo.path, rowInfo.key, Date.now(), resetScope]);
  const injected = await page.evaluate(([p, key, at]) => {
    const mk = (id, thread) => ({
      id,
      thread,
      ownerPath: p,
      status: "done",
      startedAt: new Date(at - 120000).toISOString(),
      endedAt: new Date(at - 60000).toISOString(),
      exitCode: 0,
      turn: 1,
      prompt: `fabricated card ${thread}`,
      lines: [],
    });
    state.jobs.set("job-agt-a", mk("job-agt-a", "agt-a"));
    state.jobs.set("job-agt-b", mk("job-agt-b", "agt-b"));
    state.jobs.set("job-agt-c", mk("job-agt-c", "agt-c"));
    window.__rowForThread["agt-a"] = key;
    window.__rowForThread["agt-b"] = key;
    window.__rowForThread["agt-c"] = key;
    invalidatePanelMap();
    state.rankOrder.delete(`agents:${key}`);
    renderProjectRows("alpha-repo");
    return true;
  }, [rowInfo.path, rowInfo.key, Date.now()]);
  ok("two cards injected into the row", injected);
  const born = await cardOrder("alpha-repo");
  ok("the row now has all three cards, in their path order to start", JSON.stringify(born), JSON.stringify(["agt-a", "agt-b", "agt-c"]));
  // The order the tick advances and `reorderAgentCards` paints, read from the stored scope (it survives the
  // resync that clears the fabricated jobs).
  const agentsOrder = () => page.evaluate((k) => state.rankOrder.get(`agents:${k}`) || [], rowInfo.key);
  const atick = async () => {
    await injectCards(); // the page's own 30 s safety resync clears state.jobs on this clock
    return tick();
  };

  console.log("\n== (A2) one isolated event moves a card nowhere ==");
  await injectCards(true);
  await atick();
  const aBefore = (await agentsOrder()).indexOf("agt-a");
  await fire("agt-a", 1);
  await atick();
  const aAfter1 = (await agentsOrder()).indexOf("agt-a");
  check("one event leaves the card where it was", aAfter1, aBefore);
  note(`agt-a's rate is ${(await agentScore("agt-a")).toFixed(3)}/min — below the 1/min margin, so it cannot take a slot`);

  console.log("\n== (A1) a burst climbs the card across ticks ==");
  await injectCards(true);
  await atick(); // establish the order with no events yet: agt-a > agt-b > agt-c
  const seq = [];
  await fire("agt-c", 10);
  seq.push({ t: await atick(), order: await agentsOrder() });
  await fire("agt-c", 10);
  seq.push({ t: await atick(), order: await agentsOrder() });
  for (let i = 0; i < 2; i++) seq.push({ t: await atick(), order: await agentsOrder() });
  for (const [i, r] of seq.entries()) note(`tick ${i + 1} @ ${new Date(r.t).toISOString().slice(11, 23)}  the bursting card at place ${r.order.indexOf("agt-c") + 1}/${r.order.length}  ${r.order.join(" > ")}`);
  ok("the bursting card does not start at the top", seq[0].order.indexOf("agt-c") > 0, `place ${seq[0].order.indexOf("agt-c") + 1}`);
  ok("it climbs a place a tick and reaches the top of its row", seq.at(-1).order.indexOf("agt-c") === 0 && seq.every((r, i) => i === 0 || r.order.indexOf("agt-c") <= seq[i - 1].order.indexOf("agt-c")), seq.at(-1).order.join(" > "));
  // The in-place re-order, driven: Stabilize reordering (on by default, with a card open) is exactly what refuses
  // to move cards, so it is switched off first and the shipped applier the tick calls is run with the cards back
  // on the page.
  await page.click("#btn-settings");
  await page.uncheck("#stabilize-reorder");
  await page.click("#btn-settings-close");
  await injectCards();
  await page.evaluate(() => reorderAgentCards("alpha-repo"));
  const dom = await domCards("alpha-repo");
  if (dom.length) ok("the cards in the DOM are re-ordered to the tick's order too", JSON.stringify(dom) === JSON.stringify(seq.at(-1).order), `dom ${JSON.stringify(dom)}`);
  else note("the fabricated cards did not render in the row's DOM, so the in-place re-order was not observed (the ranking decision above is the stored scope order the tick advances, which is what `reorderAgentCards` paints)");
  await page.click("#btn-settings");
  await page.check("#stabilize-reorder");
  await page.click("#btn-settings-close");

  console.log("\n== (A3) the same window governs the card ranking ==");
  await page.evaluate(() => {
    state.eventWindows.clear();
    state.rankOrder.clear();
    state.rankSeeded = new Set([...state.rows.keys()]);
  });
  await fire("agt-c", 30);
  for (let i = 0; i < 26; i++) await tick();
  await setWindow(900);
  const b900 = await agentScore("agt-c");
  await setWindow(60);
  const b60 = await agentScore("agt-c");
  check("900 s: the 130-s-old events are inside the card's window too", Math.round(b900 * 1000) / 1000, 2);
  check("60 s: the same events are outside it", Math.round(b60 * 1000) / 1000, 0);
  await setWindow(300);

  check("no uncaught page errors", pageErrors, []);
  ok("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  await browser.close();
}

try {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}`);
  const scanned = await waitFor(async () => {
    const st = await (await fetch(`${base}/api/state`)).json();
    const withRows = (st.projects || []).filter((p) => (p.worktrees || []).length >= 3);
    return withRows.length >= 4;
  }, { timeoutMs: 180_000, what: "all four projects to be scanned with their worktrees", stepMs: 700 });
  ok("all four sandbox projects scanned with their worktrees", scanned);

  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  if (!failures) console.log("RANK-SCOPES-VERIFY-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-20).join("\n")}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  else {
    if (panel) {
      const p = panel;
      panel = null;
      p.kill();
      const gone = await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 12_000, what: "the panel to exit" });
      if (!gone && p.pid) try {
        execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {}
      p.stdout?.destroy();
      p.stderr?.destroy();
      await sleep(300);
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  }
}
process.exitCode = failures ? 1 : 0;
