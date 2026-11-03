// The collapse cascade, proved by driving a panel of its own — and a real browser over it.
//
//   node tools/verify-collapse-cascade.mjs [--shots <dir>]
//
// A parent collapsed and left alone used to keep the cards under it exactly as they were: the container's fold is
// written down (wm.collapsedRoots, wm.expandedProjects, state.expanded, wm.collapsedFixed) but the cards' folds are
// their own set (wm.collapsedJobs), and nothing related the two. A project left closed for a while came back as a wall
// of open transcripts. Now a parent collapsed for `collapseAfterSeconds` (config.json, default 30, 0 disables) writes
// every card under it into `wm.collapsedJobs`, so the next expand draws them minimized — and they stay minimized
// through a reload, because that set is what the renderer reads on load. The clock is the parent's own: collapsing it
// again restarts it, opening it before the time is up cancels it, and opening it never takes a child out of the set.
//
// Everything below happens in a sandbox of its own: a throwaway repo with one hand-cut worktree, a throwaway
// HERMES_HOME, its own PANEL_CONFIG with its own port and logs, and an apiServer pointed at a dead port so nothing
// anywhere can reach the live gateway. The live panel on 7331 and the live gateway on 8642 are never touched, and the
// whole temp root is deleted at the end.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven   the default: a config.json with no such key boots on 30 (and still has no key — the default is not written)
//   driven   the setting: POST /api/settings/collapse-after rewrites that ONE key (every other key compared byte for
//            byte around it), the answer and /api/config agree, an unreadable value falls back to the default rather
//            than to "off", and an absurd one is clamped
//   driven   the browser (Playwright, headless Chromium), both ways:
//              * the cascade — collapse the project, wait past the number, expand: both cards are minimized, and the
//                persisted set names both threads;
//              * it survives a reload — the cards come back minimized from localStorage, not from memory;
//              * the no-op — collapse, expand before the number, wait past it: both cards are still open and the set
//                is empty;
//              * an early expand cancels the clock even when the wait outlives it;
//              * a folder's section (whose DOM survives a collapse) comes back with its cards minimized too;
//              * 0 in the Settings field turns the whole thing off;
//              * the field reads and writes the number, and a reload comes back on it.
//   inspected  nothing: every claim above is measured from the page, the store or config.json.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, openSettingsGroup, withBrowser } from "./browser.mjs";
import { ROOT, configureRepo, freePort, git, startPanel, waitFor } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const note = (text) => console.log(`      ${text}`);
const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---- the sandbox -------------------------------------------------------------------------------------------------
const dir = path.join(ROOT, ".worktrees", ".collapse-cascade-sandbox");
rmSync(dir, { recursive: true, force: true });
mkdirSync(path.join(dir, "logs"), { recursive: true });
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".collapse-cascade-shots");
mkdirSync(shotsDir, { recursive: true });
const repos = path.join(dir, "repos");
const repo = path.join(repos, "sandbox-repo");
const tree = path.join(repo, ".worktrees", "tree-one");
const PROJECT = "sandbox-repo";
mkdirSync(tree, { recursive: true });

git(repo, ["init", "-q", "-b", "main"]);
configureRepo(repo);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "seed the sandbox repo"]);
git(repo, ["worktree", "add", "-q", "-b", "work/tree-one", tree]);
writeFileSync(path.join(tree, "work.txt"), "the worktree the cards run in\n", "utf8");
git(tree, ["add", "-A"]);
git(tree, ["commit", "-q", "-m", "do the work"]);

// Two settled cards in that one worktree: the parent (the project) has two descendants to write.
const now = Date.now();
const settled = (id, extra) => ({
  id,
  thread: id,
  turn: 0,
  prompt: `fixture: ${id}`,
  status: "done",
  exitCode: 0,
  startedAt: new Date(now - 900_000).toISOString(),
  endedAt: new Date(now - 840_000).toISOString(),
  durationMs: 60_000,
  finalMessage: "done",
  cwd: tree,
  ownerPath: tree,
  worktreePath: tree,
  lines: [{ kind: "out", text: `the card ${id} is here so the cascade has something to fold`, lid: 1, at: now - 840_000 }],
  ...extra,
});
const THREADS = ["tk-cascade-a", "tk-cascade-b"];
writeFileSync(
  path.join(dir, "logs", "jobs.json"),
  JSON.stringify({ savedAt: new Date(now).toISOString(), jobs: THREADS.map((id) => settled(id)) }, null, 1),
  "utf8",
);

const port = await freePort();
// Deliberately NO collapseAfterSeconds key: the default the panel applies is part of what is proved.
const panel = await startPanel({
  dir,
  port,
  keep: true,
  config: {
    scanRoots: [repos],
    refreshSeconds: 4,
    worktreeSeconds: 2,
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
const readConfigFile = () => JSON.parse(readFileSync(panel.configPath, "utf8"));
const post = async (route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const getConfig = async () => (await fetch(`${base}/api/config`)).json();

try {
  // ---- 1. the default -----------------------------------------------------------------------------------------
  console.log("\n== the default: 30 s, and a config with no key keeps no key ==");
  const boot = await getConfig();
  check("a config.json with no collapseAfterSeconds boots on 30", boot.collapseAfterSeconds === 30, JSON.stringify(boot.collapseAfterSeconds));
  check("…and the file still has no such key (a default is not written)", !("collapseAfterSeconds" in readConfigFile()));

  // ---- 2. the setting -----------------------------------------------------------------------------------------
  console.log("\n== the setting: one key rewritten, the answer and /api/config agree ==");
  const before = readFileSync(panel.configPath, "utf8");
  const set2 = await post("/api/settings/collapse-after", { seconds: 2 });
  check("POST /api/settings/collapse-after answers 200", set2.status === 200, String(set2.status));
  check("…with the number it stored", set2.body.seconds === 2, JSON.stringify(set2.body.seconds));
  check("…and /api/config agrees", (await getConfig()).collapseAfterSeconds === 2);
  const after = readFileSync(panel.configPath, "utf8");
  const strip = (text) =>
    String(text)
      .replace(/,\r?\n(\s*)"collapseAfterSeconds":\s*-?\d+\r?\n/, "\n")
      .replace(/^\s*"collapseAfterSeconds":\s*-?\d+,?\r?\n/m, "");
  check("config.json gained exactly that one key", strip(after).trimEnd() === strip(before).trimEnd() && /"collapseAfterSeconds":\s*2/.test(after));

  const typo = await post("/api/settings/collapse-after", { seconds: "nonsense" });
  check("an unreadable value falls back to the default, not to off", typo.body.seconds === 30, JSON.stringify(typo.body.seconds));
  const absurd = await post("/api/settings/collapse-after", { seconds: 99999 });
  check("an absurd value is clamped", absurd.body.seconds === 3600, JSON.stringify(absurd.body.seconds));
  const negative = await post("/api/settings/collapse-after", { seconds: -5 });
  check("a negative value is a typo and falls back to the default", negative.body.seconds === 30, JSON.stringify(negative.body.seconds));

  const back = await post("/api/settings/collapse-after", { seconds: 2 });
  check("the number can be set back to 2 for the browser half", back.body.seconds === 2, JSON.stringify(back.body.seconds));

  // ---- 3. the browser -----------------------------------------------------------------------------------------
  console.log("\n== the browser: the cascade, the no-op, and the reload ==");
  const engine = loadPlaywright();
  if (!engine) {
    console.log(notRun("the collapse cascade", "no Playwright on this machine — set PANEL_PLAYWRIGHT_ROOT"));
    failures += 1;
  } else {
    const rowKey = `${PROJECT}::${tree.replace(/\\/g, "/")}`;
    const projectHead = `[data-toggle-project="${PROJECT}"]`;
    const rowSel = `tr.row[data-key="${rowKey}"]`;
    const rootHead = "[data-toggle-root]";
    const cardSel = (thread) => `.job[data-thread="${thread}"]`;

    const cardState = (page) =>
      page.evaluate(() => {
        const out = {};
        for (const id of ["tk-cascade-a", "tk-cascade-b"]) {
          const el = document.querySelector(`.job[data-thread="${id}"]`);
          out[id] = el ? { collapsed: el.classList.contains("collapsed"), shown: Boolean(el.offsetParent) } : null;
        }
        return { cards: out, set: JSON.parse(localStorage.getItem("wm.collapsedJobs") || "[]") };
      });

    const openBoard = async (page) => {
      // The project starts collapsed. Open it, then the row, and wait for both cards to be drawn in the agents block.
      await page.waitForSelector(projectHead, { timeout: 30_000 });
      if (await page.evaluate((s) => document.querySelector(s).closest("section.project").classList.contains("collapsed"), projectHead)) {
        await page.click(projectHead);
      }
      await page.waitForSelector(rowSel, { timeout: 20_000 }).catch(async (e) => {
        const keys = await page.evaluate(() => [...document.querySelectorAll("tr.row")].map((r) => r.dataset.key));
        throw new Error(`${e.message}\n      rows on the board: ${JSON.stringify(keys)}`);
      });
      if (!(await page.evaluate((s) => document.querySelector(s).classList.contains("expanded"), rowSel))) await page.click(rowSel);
      await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 2, ".agents-block .job[data-thread]");
    };
    const expandCards = async (page) => {
      for (const id of THREADS) {
        const open = await page.evaluate((s) => {
          const el = document.querySelector(s);
          return el ? !el.classList.contains("collapsed") : false;
        }, cardSel(id));
        if (!open) await page.click(`${cardSel(id)} .job-head`);
      }
    };
    const collapsedCount = async (page) =>
      page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => el.classList.contains("collapsed")).length, ".agents-block .job[data-thread]");

    const verdict = await withBrowser(
      async ({ page }) => {
        await openPage(page, base, { selector: "section.project" });
        await openBoard(page);
        await expandCards(page);
        check("the fixture draws both cards, expanded", (await collapsedCount(page)) === 0, `${await collapsedCount(page)} minimized`);
        await page.screenshot({ path: path.join(shotsDir, "1-both-open.png") });

        // (a) the cascade: the PROJECT is the parent.
        await page.click(projectHead); // collapse
        await sleep(2_500);
        await page.click(projectHead); // expand
        await page.waitForSelector(".agents-block .job[data-thread]", { timeout: 20_000 });
        const cascaded = await cardState(page);
        check("after 2 s collapsed, expanding the project draws both cards minimized", (await collapsedCount(page)) === 2, JSON.stringify(cascaded.cards));
        check(
          "…and the persisted set is what says so",
          THREADS.every((t) => cascaded.set.includes(t)),
          JSON.stringify(cascaded.set),
        );
        await page.screenshot({ path: path.join(shotsDir, "2-after-cascade.png") });

        // (b) the reload: the set the renderer reads on load.
        await page.reload({ waitUntil: "domcontentloaded" });
        await openBoard(page);
        const reloaded = await cardState(page);
        check("a reload comes back with both cards still minimized", (await collapsedCount(page)) === 2, JSON.stringify(reloaded.cards));

        // (c) the no-op: an expand before the number is up leaves the cards alone.
        await expandCards(page);
        check("the cards can be opened again", (await collapsedCount(page)) === 0);
        await page.click(projectHead); // collapse
        await sleep(600);
        await page.click(projectHead); // expand
        await page.waitForSelector(".agents-block .job[data-thread]", { timeout: 20_000 });
        const noop = await cardState(page);
        check("an expand before the number is up leaves both cards open", (await collapsedCount(page)) === 0, JSON.stringify(noop.cards));
        check("…and writes nothing into the persisted set", noop.set.length === 0, JSON.stringify(noop.set));

        // (d) the early expand cancels the clock, even when the wait outlives it.
        await page.click(projectHead); // collapse
        await sleep(600);
        await page.click(projectHead); // expand
        await page.waitForSelector(".agents-block .job[data-thread]", { timeout: 20_000 });
        await sleep(3_000); // well past the 2 s clock
        check("a cancelled clock never fires, even after its time", (await collapsedCount(page)) === 0, `${await collapsedCount(page)} minimized`);

        // (e) a folder's section keeps its DOM through a collapse — the path that has to rebuild from the set.
        await page.click(rootHead); // collapse the folder
        await sleep(2_500);
        await page.click(rootHead); // expand
        await page.waitForSelector(".agents-block .job[data-thread]", { timeout: 20_000 });
        const folder = await cardState(page);
        check("a collapsed folder comes back with its cards minimized", (await collapsedCount(page)) === 2, JSON.stringify(folder.cards));

        // (f) 0 in the Settings field turns the cascade off.
        await expandCards(page);
        await openSettingsGroup(page, "board");
        await page.fill("#collapse-after", "0");
        await page.dispatchEvent("#collapse-after", "change");
        await waitFor(async () => (await getConfig()).collapseAfterSeconds === 0, { timeoutMs: 10_000, what: "config.json to say 0" });
        check("the Settings field writes 0 to config.json", (await getConfig()).collapseAfterSeconds === 0);
        await page.click("#btn-settings-close");
        await page.click(projectHead); // collapse
        await sleep(2_500);
        await page.click(projectHead); // expand
        await page.waitForSelector(".agents-block .job[data-thread]", { timeout: 20_000 });
        const off = await cardState(page);
        check("0 disables the cascade: the cards are still open", (await collapsedCount(page)) === 0, JSON.stringify(off.cards));
        check("…and nothing was written", off.set.length === 0, JSON.stringify(off.set));

        // (g) the field reads the stored number back after a reload.
        await page.reload({ waitUntil: "domcontentloaded" });
        await openSettingsGroup(page, "board");
        const fieldValue = await page.inputValue("#collapse-after");
        check("the field reads the stored number after a reload", fieldValue === "0", fieldValue);
        await page.screenshot({ path: path.join(shotsDir, "3-setting-zero.png") });

        return 0;
      },
      { viewport: { width: 1760, height: 1000 } },
    ).catch((e) => {
      failures += 1;
      console.log(`FAIL  the browser half threw — ${String((e && e.message) || e)}`);
      return 1;
    });
    void verdict;
  }
} catch (e) {
  failures += 1;
  console.log(`FAIL  the harness threw — ${String((e && e.message) || e)}`);
} finally {
  await panel.stop();
  if (!process.env.KEEP_SANDBOX) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks`);
if (!checks) {
  console.log("nothing ran");
  process.exit(2);
}
process.exit(failures ? 1 : 0);
