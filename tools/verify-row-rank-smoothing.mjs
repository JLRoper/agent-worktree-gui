// The row ranking, averaged over a sliding window of liveness events instead of keyed on the newest one, proved
// by driving a panel of its own — and a real browser over it with a scripted, controlled clock.
//
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-row-rank-smoothing.mjs
//
// A worktree row used to take its slot from the moment of its LAST event (a maximum): one console line promoted it
// to the top and the next line demoted it, which is the bounce. The rank is now the row's rate of liveness events
// (events per minute) over a sliding window (`state.rankWindowSeconds`, default 300 s), advanced one adjacent swap
// at a time on the board-reorder clock with hysteresis, so a burst climbs a place a tick, a row with one line
// stays put, and a row that goes quiet slides down as its events age out.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven        the browser half is the whole point: Playwright (headless Chromium) with `page.clock` installed
//                 and PAUSED, so every tick is exactly 5000 ms of fake time apart and the scripted event times are
//                 exact. Events go in through the SAME function the panel uses (`noteEventLife`, reached with a
//                 harness stub for its thread->row lookup); the ranking, the window, the score and the comparator
//                 are the shipped code.
//   driven        (a) a burst climbs across ticks, (b) it slides down as its events age out, (c) one isolated
//                 event moves nothing, (d) equal scores keep a stable path-broken order, (e) the first paint is the
//                 SEEDED order, (f) the window setting changes the smoothing, (g) stabilize holds an open row and
//                 the age column / ring / pulse are unchanged, (h) the same script gives the same order twice and
//                 the ring is capped.
//   inspected     that an event no longer re-orders anything is asserted by driving an event with NO tick after it
//                 and reading the same order; the claim that `orderRows` is no longer called by the ranking is read
//                 off the source (`public/app.js` now calls `applyRowRank`).
//
// Everything runs in a sandbox of its own: a throwaway repo with five hand-cut worktrees whose activity is known
// to the second, a throwaway HERMES_HOME, its own PANEL_CONFIG with its own port, and an apiServer pointed at a
// dead port so nothing anywhere can reach the live gateway. The live panel and gateway are never touched, and the
// whole temp root is deleted at the end.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { ROOT, freePort } from "./panel-testkit.mjs";

// Optional unbuffered trace: with RANK_TRACE=<file> every line is appended and flushed as it is printed, so a run
// killed by a caller's timeout still leaves behind exactly how far it got.
const TRACE = process.env.RANK_TRACE || "";
const TRACE_T0 = Date.now();
if (TRACE) {
  const { appendFileSync: _af } = await import("node:fs");
  const _log = console.log;
  console.log = (...a) => {
    _log(...a);
    try {
      _af(TRACE, `${Date.now() - TRACE_T0}ms ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);
    } catch {
      /* the trace is a courtesy */
    }
  };
}

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
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
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-row-rank-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const shotsDir = path.join(dir, "shots");
const PROJECT = "sandbox-repo";
for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, shotsDir]) mkdirSync(d, { recursive: true });

const commit = (dirPath, message, env) => {
  git(dirPath, ["add", "-A"]);
  return git(dirPath, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], env);
};
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const OLD = { GIT_AUTHOR_DATE: daysAgo(45), GIT_COMMITTER_DATE: daysAgo(45) };
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);

git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
commit(repo, "seed the sandbox repo", OLD);

// Five worktrees. Four are 20 minutes quiet (outside the default 300 s window); ONE is a minute old, and its name
// sorts LAST, so the seeded order can only put it first by MEASURING its activity — a fresh-start or a
// path-ordered ranking would put the root and `alpha-old` first instead. Everything is committed 45 days ago, so
// it is the FILE mtime (lastEdit), not the commit, that the seed measures.
const TREES = ["alpha-old", "bravo-old", "charlie-old", "zeta-recent", "zulu-burst"];
const treePath = (n) => path.join(repo, ".worktrees", n);
for (const n of TREES) {
  git(repo, ["worktree", "add", "-q", "-b", `work/${n}`, treePath(n)]);
  writeFileSync(path.join(treePath(n), "work.txt"), `${n}\n`, "utf8");
  commit(treePath(n), `work in ${n}`, OLD);
}
// ONE tree carries an UNTRACKED file whose mtime is a minute old. That is what the scanner measures as lastEdit
// (a clean tree's lastEdit is only its last commit, 45 days ago), so exactly one row has seeded evidence inside
// the default 300 s window - and its name sorts LAST, so the seeded order cannot be a path order.
const freshNote = path.join(treePath("zeta-recent"), "note.txt");
writeFileSync(freshNote, "worked in a minute ago\n", "utf8");
const aMinuteAgo = minutesAgo(1);
utimesSync(freshNote, aMinuteAgo, aMinuteAgo);

const port = await freePort();
const configPath = path.join(configDir, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [rootDir],
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
      defaultCwd: repo,
      projectsCacheFile: path.join(configDir, "logs", "projects.json"),
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const readConfigFile = () => JSON.parse(readFileSync(configPath, "utf8"));

const base = `http://127.0.0.1:${port}`;
const panelLog = [];
let panel = null;
const startPanel = async () => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  const gone = await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 15_000, what: "the panel to exit" });
  if (!gone && p.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
    await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 8_000, what: "the panel to be gone after taskkill" });
  }
  p.stdout?.destroy();
  p.stderr?.destroy();
  await sleep(300);
};
const api = async (route, body, method) => {
  const res = await fetch(`${base}${route}`, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const rowsOf = async () => (await api("/api/state")).body.projects?.find((p) => p.name === PROJECT)?.worktrees || [];

// ---- the browser half ----------------------------------------------------------------------------
async function browserPhase(pw) {
  const pageErrors = [];
  const consoleErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addInitScript((project) => {
    localStorage.setItem("wm.expandedProjects", JSON.stringify([project]));
  }, PROJECT);
  const page = await context.newPage();
  // Fail a stuck action in seconds rather than at Playwright's 30 s default: even with the trace, a script that
  // dies on one un-actionable click should say so quickly.
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/i.test(m.text())) consoleErrors.push(m.text());
  });

  // A controlled clock: installed and PAUSED before the page's own scripts run, so the reorder interval is armed at
  // an exact fake time and every `fastForward(5000)` is exactly one tick. `Date.now()` in the page is therefore
  // ours, and the scripted event times are exact.
  const T0 = new Date();
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0);
  await page.goto(base, { waitUntil: "domcontentloaded" });

  const ORDER = `tbody[data-tbody="${PROJECT}"] tr.row`;
  const shortOf = (key) => {
    const p = String(key).split("::")[1] || "";
    if (norm(p) === norm(repo)) return "ROOT";
    return p.replace(/\\/g, "/").split("/").pop();
  };
  const domKeys = () => page.$$eval(ORDER, (els) => els.map((e) => e.dataset.key));
  const domOrder = async () => (await domKeys()).map(shortOf);
  const posOf = async (name) => (await domOrder()).indexOf(name);
  const fakeNow = () => page.evaluate(() => Date.now());
  const shot = async (name) => {
    const file = path.join(shotsDir, `${name}.png`);
    await page.screenshot({ path: file }); // viewport only: a full-page capture of a live board times out
    return file;
  };

  // The harness stub for the thread->row lookup: `noteEventLife(thread)` is the real function and this is the only
  // thing substituted, so an "evt:<row key>" thread stamps exactly the row this test means. Count ticks too, so a
  // tick is a counted event and not a guess.
  await page.evaluate(() => {
    window.rowKeyForThread = (t) => (String(t).startsWith("evt:") ? String(t).slice(4) : null);
    window.__ticks = 0;
    const orig = window.tickLivenessRanks;
    window.tickLivenessRanks = (...a) => {
      window.__ticks += 1;
      return orig(...a);
    };
  });

  const tickCount = () => page.evaluate(() => window.__ticks | 0);
  // One tick: 5 s of fake time, which is exactly the reorder clock's period since the clock was paused at install.
  // A fallback of 1 s steps covers any phase drift rather than guessing.
  const tick = async () => {
    const before = await tickCount();
    await page.clock.fastForward(5000);
    if ((await tickCount()) === before) {
      for (let i = 0; i < 5; i++) {
        await page.clock.fastForward(1000);
        if ((await tickCount()) > before) break;
      }
    }
    return fakeNow();
  };
  const fire = async (name, n) => {
    await page.evaluate(
      ([key, count]) => {
        for (let i = 0; i < count; i++) noteEventLife(`evt:${key}`);
      },
      [keyFor(name), n],
    );
  };
  const scoreOf = (name) => page.evaluate((k) => rankScore(lifeRowKey(k), Date.now()), keyFor(name));
  const windowLen = (name) => page.evaluate((k) => (state.eventWindows.get(lifeRowKey(k)) || []).length, keyFor(name));
  const lifeOf = (name) => page.evaluate((k) => { const r = state.rows.get(k); return r ? lifeAt(r) : null; }, keyFor(name));
  const resetRanking = () =>
    page.evaluate(() => {
      state.eventWindows.clear();
      state.rankOrder.clear();
      state.rankSeeded = new Set([...state.rows.keys()]);
      state.rankProjSeeded = new Set([...state.projects.keys()]);
      tickLivenessRanks();
    });
  const setWindow = async (secs) => {
    await openSettingsGroup(page, "display");
    await page.fill("#rank-window", String(secs));
    await page.dispatchEvent("#rank-window", "change");
    await page.click("#btn-settings-close");
  };

  const drawn = await waitFor(async () => (await domKeys()).length >= 6, { what: "the sandbox chart to draw its six rows" });
  if (!drawn) throw new Error("the sandbox chart never drew its rows");
  // The row key for a short name. Read AFTER the first paint: the rows are not in `state.rows` before it.
  const keys = await page.evaluate(() => Object.fromEntries([...state.rows.keys()].map((k) => [k.split("::")[1].replace(/\\/g, "/").split("/").pop(), k])));
  const rootKey = await page.evaluate((rp) => [...state.rows.keys()].find((k) => String(k.split("::")[1]).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === rp) || null, norm(repo));
  const keyFor = (name) => (name === "ROOT" ? rootKey : keys[name]);

  console.log("\n== (e) the first paint is the SEEDED order, not a fresh-start scramble ==");
  const seedRows = await rowsOf();
  const win = await page.evaluate(() => state.rankWindowSeconds);
  check("the window boots on its 300 s default", win, 300);
  // The seed inputs (each row's own recorded life, and whether it falls inside the window) with the window length
  // the seed actually produced, measured in the page.
  const leafOf = (pth) => String(pth || "").replace(/\\/g, "/").split("/").pop();
  const seedMeasure = await page.evaluate(() => ({
    lengths: Object.fromEntries(
      [...state.rows.keys()].map((k) => [k.split("::")[1].replace(/\\/g, "/").split("/").pop(), (state.eventWindows.get(`row:${k}`) || []).length]),
    ),
    drawn: [...document.querySelectorAll('tbody[data-tbody="sandbox-repo"] tr.row')].map((e) => e.dataset.key.split("::")[1].replace(/\\/g, "/").split("/").pop()),
  }));
  const inWin = (v) => {
    const t = Date.parse(v || "");
    return Number.isFinite(t) && Date.now() - t <= win * 1000;
  };
  note(`seed inputs (window ${win}s): ${seedRows.map((r) => `${leafOf(r.path)}{edit:${inWin(r.lastEdit) ? `in (${new Date(Date.parse(r.lastEdit)).toISOString().slice(11, 19)})` : "out"},commit:${inWin(r.lastCommit) ? "in" : "out"}}`).join("  ")}`);
  note(`seeded window lengths: ${JSON.stringify(seedMeasure.lengths)}`);
  const entries = Object.entries(seedMeasure.lengths);
  const maxLen = Math.max(0, ...entries.map(([, n]) => n));
  ok("a row's own recorded life seeded its window inside the 300 s window", maxLen > 0, JSON.stringify(seedMeasure.lengths));
  check("the first paint opens on a row holding the most seeded evidence", seedMeasure.lengths[seedMeasure.drawn[0]] ?? 0, maxLen);
  ok("a row with no evidence inside the window is seeded with nothing", entries.some(([, n]) => n === 0), JSON.stringify(seedMeasure.lengths));
  const pathOrder = [...seedMeasure.drawn].sort((a, b) => a.localeCompare(b));
  ok("...which a path order would NOT do", pathOrder[0] !== seedMeasure.drawn[0], `path order would open on ${pathOrder[0]}`);
  const bootOrder = await domOrder();
  note(`first paint: ${bootOrder.join(" > ")}`);
  note(`screenshot: ${await shot("1-first-paint-seeded")}`);

  console.log("\n== (c) one isolated event on a middle row moves it nowhere ==");
  const midName = "bravo-old";
  const beforeC = await posOf(midName);
  const midLifeBefore = await lifeOf(midName);
  await fire(midName, 1);
  note(`keyFor(${midName}) = ${JSON.stringify(keyFor(midName))}, its row window holds ${await windowLen(midName)}`);
  const orderNoTick = await domOrder();
  check("an event with no tick after it does not re-order anything", orderNoTick, bootOrder);
  await tick();
  const afterC = await posOf(midName);
  check("the isolated event's row keeps its slot after a tick", afterC, beforeC);
  note(`its score is ${(await scoreOf(midName)).toFixed(3)}/min (margin is 1/min) and its recency evidence is unchanged (${midLifeBefore === await lifeOf(midName) ? "same lifeAt" : "CHANGED"})`);

  console.log("\n== (d) two equal-score rows keep a stable, path-broken order ==");
  const lA = await lifeOf("alpha-old");
  const lC = await lifeOf("charlie-old");
  const seqD = [];
  for (let i = 0; i < 4; i++) {
    await tick();
    seqD.push((await domOrder()).filter((n) => n === "alpha-old" || n === "charlie-old").join(">"));
  }
  ok("alpha-old stays above charlie-old across four ticks", new Set(seqD).size === 1 && seqD[0] === "alpha-old>charlie-old", seqD.join(" | "));
  ok("their scores are equal and their recency evidence is equal, so PATH decided", (await scoreOf("alpha-old")) === 0 && (await scoreOf("charlie-old")) === 0 && lA === lC, `alpha score ${await scoreOf("alpha-old")}, charlie score ${await scoreOf("charlie-old")}, lifeAt alpha=${lA} charlie=${lC}`);

  console.log("\n== (a) a burst climbs across successive ticks, and does not take the top on the first ==");
  const b = "zulu-burst";
  const burstStart = await posOf(b);
  ok("the burst row does not start at the top", burstStart > 0, `starts at place ${burstStart + 1}`);
  const orderA = [];
  await fire(b, 10);
  orderA.push({ t: await tick(), order: await domOrder() });
  await fire(b, 10); // 20 events in the two 5 s ticks above == the "20 in 10 s" burst
  orderA.push({ t: await tick(), order: await domOrder() });
  for (let i = 0; i < 5; i++) orderA.push({ t: await tick(), order: await domOrder() });
  for (const [i, rec] of orderA.entries()) note(`tick ${i + 1} @ ${new Date(rec.t).toISOString().slice(11, 23)}  burst at place ${rec.order.indexOf(b) + 1}/${rec.order.length}  ${rec.order.join(" > ")}`);
  ok("the burst row is NOT at the top on the first tick", orderA[0].order.indexOf(b) !== 0, `place ${orderA[0].order.indexOf(b) + 1}`);
  const aPlaces = orderA.map((r) => r.order.indexOf(b));
  ok("it never falls back down once it starts climbing", aPlaces.every((v, i) => i === 0 || v <= aPlaces[i - 1]), aPlaces.join(","));
  const aDeltas = aPlaces.slice(1).map((v, i) => aPlaces[i] - v);
  ok("every productive tick moves it exactly one place (never a leap)", aDeltas.every((d) => d === 0 || d === 1), `deltas ${aDeltas.join(",")}`);
  // A row that leads on a STRICTER TIER (a running panel agent, or any live session) is untouched by this change
  // and applies at once, so the burst can only climb past the rows in its own tier.
  const tierAhead = await page.evaluate((k) => {
    const me = state.rows.get(k);
    return [...state.rows.values()].filter((r) => rowTier(r) < rowTier(me)).length;
  }, keyFor(b));
  ok(`it climbs until only the ${tierAhead} row(s) that lead on tier are above it`, aPlaces.at(-1) === tierAhead, `ended at place ${aPlaces.at(-1) + 1} of ${orderA.at(-1).order.length}; ${tierAhead} row(s) lead on tier (live/running), so the top of its own tier is place ${tierAhead + 1}`);
  note(`screenshot: ${await shot("2-burst-climbed")}`);

  console.log("\n== (b) when the burst stops, the row slides down as its events age out ==");
  // Its own events age out of the 300 s window; the other rows keep a steady 2/min so there is something to be
  // passed BY. Advance the clock one tick at a time (5 s a tick, 330 s in all) and record the burst row's place.
  const others = TREES.filter((n) => n !== b).map((n) => n);
  const places = [];
  let burstTop = null;
  for (let step = 0; step < 66; step++) {
    // a steady 2/min on every other row: one event each every 30 s (six ticks)
    if (step % 6 === 2) for (const n of others) await fire(n, 1);
    await tick();
    const ord = await domOrder();
    places.push({ step, now: await fakeNow(), place: ord.indexOf(b) + 1, order: ord });
    if (burstTop === null && ord.indexOf(b) !== 0) burstTop = places.length - 1;
  }
  for (const p of places.slice(Math.max(0, (burstTop ?? 0) - 3), (burstTop ?? 0) + 6)) {
    note(`tick ${p.step + 1} @ ${new Date(p.now).toISOString().slice(11, 23)}  burst at place ${p.place}/${p.order.length}  ${p.order.join(" > ")}`);
  }
  const last = places.at(-1).place;
  ok("as its events age out the burst row leaves the top", places.at(-1).place > 1, `ended at place ${last}`);
  const afterFirstFall = places.slice(places.findIndex((p) => p.place > 1)).map((p) => p.place);
  ok("and it slides one place at a time rather than dropping instantly", afterFirstFall.every((v, i) => i === 0 || v >= afterFirstFall[i - 1]), `places after the fall: ${afterFirstFall.join(",")}`);
  note(`screenshot: ${await shot("3-burst-aged-out")}`);

  console.log("\n== (f) the window setting changes the smoothing ==");
  await resetRanking();
  const f = "charlie-old";
  await fire(f, 30); // 30 events now, worth 6/min over 300 s ...
  note(`keyFor(${f}) = ${JSON.stringify(keyFor(f))}, its row window holds ${await windowLen(f)} right after the burst`);
  for (let i = 0; i < 26; i++) await tick(); // ... aged by 130 s
  note(`after 130 s of ticks it still holds ${await windowLen(f)} (window ${win}s)`);
  // The ring is pruned by the window on every tick, so the two values are proved in the order that shows both:
  // a LONG window counts the 130-s-old events, a SHORT one has already forgotten them.
  await setWindow(900);
  const score900 = await scoreOf(f);
  const place900 = (await posOf(f)) + 1;
  await setWindow(60);
  const score60 = await scoreOf(f);
  const place60 = (await posOf(f)) + 1;
  check("with a 900 s window the 130-s-old events are inside it", Math.round(score900 * 1000) / 1000, 2);
  check("with a 60 s window the same events are outside it", Math.round(score60 * 1000) / 1000, 0);
  ok("...so the window setting visibly changes the order", place900 !== place60, `place ${place900} with 900 s vs ${place60} with 60 s`);
  note(`screenshot: ${await shot("4-window-900")}`);
  await setWindow(300);

  console.log("\n== (g) stabilize holds an open row; the age column, ring and pulse are unchanged ==");
  await resetRanking();
  const ageBefore = await page.evaluate((k) => {
    const cell = document.querySelector(`td.age[data-key="${CSS.escape(k)}"]`);
    return { num: cell?.querySelector(".age-num")?.textContent, arc: cell?.querySelector(".poll-arc")?.getAttribute("stroke") };
  }, keyFor("alpha-old"));
  const orderBeforeG = await domOrder();
  // open a row and hold it: stabilize is on by default, so a burst must not move anything.
  await page.click(`${ORDER}[data-key="${keyFor("zulu-burst")}"] td.branch`);
  const opened = await page.evaluate(() => [...state.expanded].length > 0);
  ok("a row is open (its agent cards are on the page)", opened);
  await fire("zulu-burst", 30);
  const flashAfterEvent = await page.evaluate((k) => document.querySelector(`#projects tr.row[data-key="${k}"]`)?.className || "", keyFor("zulu-burst"));
  ok("the event pulsed the row green (the flash class is on it)", /flash/.test(flashAfterEvent), `classes "${flashAfterEvent}"`);
  for (let i = 0; i < 4; i++) await tick();
  const heldOrder = await domOrder();
  check("with Stabilize on and a row open, the order is held", heldOrder, orderBeforeG);
  // The age column and the ring repainted on each event: quote them.
  const ageAfter = await page.evaluate((k) => {
    const cell = document.querySelector(`td.age[data-key="${CSS.escape(k)}"]`);
    const row = state.rows.get(k);
    return { num: cell?.querySelector(".age-num")?.textContent, arc: cell?.querySelector(".poll-arc")?.getAttribute("stroke"), lifeAt: eventLifeAt(row), lastAliveAt: row?.lastAliveAt || null };
  }, keyFor("zulu-burst"));
  ok("an event still stamps life on the age cell (the number is the row's own)", typeof ageAfter.num === "string" && ageAfter.num.length > 0, `age cell reads ${ageAfter.num}`);
  ok("...and the ring is still drawn (its stroke is one of the ring colours)", ["var(--dim)", "var(--green)", "var(--amber)", "var(--red)"].includes(ageAfter.arc), `ring stroke ${ageAfter.arc}`);
  note("the green pulse is the same flash/flash-idle class pair on the row, asserted above");
  // Stabilize OFF: the smoothed ranking decides again.
  await page.click("#btn-settings");
  await page.uncheck("#stabilize-reorder");
  await page.click("#btn-settings-close");
  await tick();
  await tick();
  const freeOrder = await domOrder();
  ok("with Stabilize off the smoothed ranking decides again", JSON.stringify(freeOrder) !== JSON.stringify(orderBeforeG), `held ${heldOrder.slice(0, 3).join(">")} ... free ${freeOrder.slice(0, 3).join(">")} ...`);
  await page.click("#btn-settings");
  await page.check("#stabilize-reorder");
  await page.click("#btn-settings-close");
  note(`age cell before ${JSON.stringify(ageBefore)} / after ${JSON.stringify({ num: ageAfter.num, arc: ageAfter.arc })}`);
  note(`screenshot: ${await shot("5-stabilize")}`);

  console.log("\n== (h) the same script twice, and a bounded ring ==");
  await page.click(`${ORDER}[data-key="${keyFor("zulu-burst")}"] td.branch`); // close the row so reordering runs
  await setWindow(3600); // a window longer than the script, so nothing ages during either replay
  const script = [
    { fire: ["alpha-old", 5] },
    { tick: 2 },
    { fire: ["zulu-burst", 12] },
    { tick: 3 },
    { fire: ["charlie-old", 4] },
    { tick: 4 },
    { fire: ["bravo-old", 9] },
    { tick: 5 },
  ];
  const pinnedStart = ["sandbox-repo", "alpha-old", "bravo-old", "charlie-old", "zeta-recent", "zulu-burst"].map((n) => keyFor(n));
  const replay = async () => {
    await resetRanking();
    // Pin the starting order: the live scanner advances lastAliveAt (a recency tie-break) in real time, and that
    // alone can flip two equal-score rows between two runs. What is compared is the scripted sequence.
    await page.evaluate((ord) => {
      state.rankOrder.set("rows:sandbox-repo", ord);
      reorder("sandbox-repo");
    }, pinnedStart);
    const out = [];
    for (const step of script) {
      if (step.fire) await fire(step.fire[0], step.fire[1]);
      if (step.tick) for (let i = 0; i < step.tick; i++) out.push((await tick(), await domOrder()));
    }
    return out;
  };
  const run1 = await replay();
  const run2 = await replay();
  check("the same scripted sequence gives the same order sequence twice", JSON.stringify(run1), JSON.stringify(run2));
  note(`the sequence: ${run1.map((o) => o.map((n) => n[0]).join("")).join(" / ")}`);
  await resetRanking();
  await page.evaluate((k) => {
    const wk = lifeRowKey(k);
    for (let i = 0; i < 5000; i++) pushEventLife(wk, Date.now());
  }, keyFor("zulu-burst"));
  const capped = await windowLen("zulu-burst");
  ok("a flood of 5000 events is capped at the ring's ceiling of 400", capped <= 400 && capped > 0, `ring holds ${capped}`);
  const total = await page.evaluate(() => [...state.eventWindows.values()].reduce((n, a) => n + a.length, 0));
  ok("the whole board's rings stay bounded too", total <= (await page.evaluate(() => state.rows.size)) * 400, `${total} timestamps across ${await page.evaluate(() => state.rows.size)} rows`);
  await setWindow(300);

  check("no uncaught page errors", pageErrors, []);
  ok("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  await browser.close();
  return { shot1: path.join(shotsDir, "1-first-paint-seeded.png"), shot2: path.join(shotsDir, "2-burst-climbed.png") };
}

// ---- run -----------------------------------------------------------------------------------------
try {
  await startPanel();
  const scanned = await waitFor(async () => {
    const r = await rowsOf();
    return r.length >= 6 && r.every((x) => x.lastEdit || x.lastCommit);
  }, { timeoutMs: 120_000, what: "the six rows to be scanned with their activity", stepMs: 700 });
  ok("six rows scanned (five worktrees and the project's own checkout)", scanned, (await rowsOf()).map((r) => r.name).join(" | "));

  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-row-rank-smoothing.mjs");
    failures += 1;
  } else {
    const shots = await browserPhase(pw);
    if (shots?.shot1) note(`screenshots: ${shots.shot1} · ${shots.shot2}`);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  if (!failures) console.log("ROW-RANK-VERIFY-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
    await stopPanel();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  }
}
process.exitCode = failures ? 1 : 0;
