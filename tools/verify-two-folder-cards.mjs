// Two scan folders, two cards — proved by driving a panel of its own, in a real browser.
//
//   node tools/verify-two-folder-cards.mjs [--shots <dir>]
//
// WHAT THIS GUARDS. `scanRoots` is the setting the board is literally made of: every git repo under these folders is
// a project, and every configured folder is its own card. Discovery tags each project with the root it was FOUND
// under (lib/projects.js), `rootOf()` files it under that folder's card, and `rootSection()` draws one accordion per
// folder. This script is the reader's half of that promise, on a panel with TWO real folders:
//
//   1. the board draws exactly TWO folder cards, one per configured root, and nothing else — no stray card, no
//      third group, no project filed under a folder it is not in;
//   2. each card NAMES its folder in its own head ("C:\CodeReviews\" and the temp folder's path), and each card's
//      body holds exactly that folder's projects (68 repos under C:/CodeReviews, 1 under the created folder), the
//      two sets disjoint and together the whole board;
//   3. each card folds and unfolds INDEPENDENTLY: pressing one head collapses that card only — the other stays open,
//      its body unmoved and its chevron still ▾ — and the four presses (fold A, fold B, unfold A, unfold B) leave
//      `wm.collapsedRoots` naming exactly the card that is folded at each step;
//   4. with BOTH cards folded, both heads are still on screen and hit-testable: a folded card is a head, and a head
//      is not something the other card's fold may push away or hide;
//   5. with the WINDOW fully collapsed (1879×157, the size in the report's screenshot, the two fixed agent cards
//      folded the way the reader leaves them), both folder cards are still visible — drawn, inside the window
//      horizontally, neither display:none nor covered — and each can be scrolled fully into view.
//
// WHAT IS DRIVEN, AND WHAT IS NOT. A real `server.js` is booted on a free port over its own PANEL_CONFIG,
// HERMES_HOME and projects cache — never the live panel on 7331 and never the repo's config.json, whose hash this
// script reads before and after to show it was not written. The first root is the real C:/CodeReviews/ folder; the
// second is created in this run's temp directory and holds one git repo, so nothing outside the test is needed for
// it. Nothing is stubbed: the board is the panel's own scan, its own state and its own renderer.
//
// A FAILING CHECK IS THE FINDING, NOT A TEST TO RE-AIM. Every number below is a painted rect from the page; if the
// panel disagrees, the panel is what the report is about. The script never weakens a check to get a green run: the
// last one — both folder heads on screen at once in a 1879×157 window — is the strict reading of "with the window
// fully collapsed both cards are still visible", and a red there is a defect in the panel's chrome above the board,
// not a fixture to adjust.
//
// The browser half needs a Playwright install; point PANEL_PLAYWRIGHT_ROOT at one (a directory holding
// node_modules/playwright, or the package itself). Without one the script says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage } from "./browser.mjs";
import { ROOT, freePort, git, startPanel } from "./panel-testkit.mjs";

// A hang would otherwise be silent (a browser left open keeps node's loop alive and the log never lands).
const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 600_000);
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
  return pass;
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
  return Boolean(cond);
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 250, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return got;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}

const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

// The board's own spelling of a folder: forward slashes, no trailing one. This is the contract `data-root` carries
// (app.js `normPath`), written here rather than imported so the card is checked against the folder that was
// configured, not against the page's own idea of it.
const rootKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
// …and the label the head paints for it: a drive path reads back with backslashes and a trailing separator.
const rootLabel = (p) => {
  const r = rootKey(p);
  return /^[A-Za-z]:\//.test(r) ? `${r.replace(/\//g, "\\")}\\` : `${r}/`;
};

const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = path.resolve(shotDirArg || path.join(os.tmpdir(), "wtgui-two-folder-cards-shots"));
mkdirSync(shotsDir, { recursive: true });

// ---- the sandbox ---------------------------------------------------------------------------------
// The first root is the machine's real review folder; the second is made here so the test owns everything about it.
const FIRST_ROOT = "C:/CodeReviews/";
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-two-folders-"));
const secondRoot = path.join(dir, "second-root");
const secondRepo = path.join(secondRoot, "second-repo");
mkdirSync(secondRepo, { recursive: true });

git(secondRepo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(secondRepo, "README.md"), "# second-repo — the repo the test's own folder holds\n", "utf8");
git(secondRepo, ["add", "."]);
git(secondRepo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);

console.log("== the two folders ==");
note(`folder 1 (real): ${FIRST_ROOT}`);
note(`folder 2 (made here): ${secondRoot}`);
note(`temp root: ${dir}`);

// The precondition that makes the first card meaningful: the folder is there and holds several git repos. If it is
// not, that is a failed fixture and the run says so rather than drawing an empty card and calling it proved.
const reposUnder = (folder) => {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(folder, d.name, ".git")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
};
const diskRepos = reposUnder(FIRST_ROOT);
ok("the first folder exists on this machine", existsSync(FIRST_ROOT), FIRST_ROOT);
ok("…and holds several git repos (the card has something to hold)", diskRepos.length >= 2, `${diskRepos.length} repos`);
check("the second folder holds exactly the one repo this test made", reposUnder(secondRoot), ["second-repo"]);

// ---- the panel ------------------------------------------------------------------------------------
const liveBefore = listenersOn(7331);
const liveConfigPath = path.join(ROOT, "config.json");
const liveConfigHash = existsSync(liveConfigPath) ? createHash("sha256").update(readFileSync(liveConfigPath)).digest("hex") : "(absent)";

const port = await freePort();
ok("the panel's port is not the live one", port !== 7331 && port !== 8642, `port ${port}`);

const panel = await startPanel({
  dir,
  port,
  config: {
    scanRoots: [FIRST_ROOT, secondRoot],
    scanMode: "all",
    defaultCwd: secondRepo,
    // Nothing re-scans while the cards are being driven: the fold test reads the board the boot painted.
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    discoverSeconds: 3600,
    // A dead port on purpose: nothing in this test may reach the live gateway.
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});

const base = panel.base;
let liveBrowser = null;
try {
  console.log("\n== the sandbox ==");
  note(`panel ${base} (live board 7331 untouched: ${liveBefore} listener(s) before)`);
  const stored = JSON.parse(readFileSync(panel.configPath, "utf8"));
  ok("the panel booted its OWN config, in the temp directory", panel.configPath.startsWith(dir) && !panel.configPath.startsWith(ROOT), panel.configPath);
  check("…whose scanRoots are the two folders and nothing else", stored.scanRoots.map(rootKey), [rootKey(FIRST_ROOT), rootKey(secondRoot)]);
  check("…and whose port is the one this run reserved", stored.port, port);

  // The board the run reads: both folders discovered, every project tagged with the folder it was found under.
  const t0 = Date.now();
  const state = await waitFor(
    async () => {
      const s = await (await fetch(`${base}/api/state`)).json();
      const keys = new Set((s.projects || []).map((p) => rootKey(p.root)));
      return keys.has(rootKey(FIRST_ROOT)) && keys.has(rootKey(secondRoot)) ? s : false;
    },
    { timeoutMs: 300_000, what: "both folders to be scanned" },
  );
  ok("both folders were scanned by the panel itself", Boolean(state), `${state ? state.projects.length : 0} projects after ${Date.now() - t0}ms`);
  check("the state's own scanRoots are the two folders", (state.scanRoots || []).map(rootKey), [rootKey(FIRST_ROOT), rootKey(secondRoot)]);

  const byRoot = (s) => {
    const out = {};
    for (const p of s.projects || []) {
      const k = rootKey(p.root);
      (out[k] = out[k] || []).push(p.name);
    }
    for (const k of Object.keys(out)) out[k].sort();
    return out;
  };
  const perRoot = byRoot(state);
  const firstNames = perRoot[rootKey(FIRST_ROOT)] || [];
  const secondNames = perRoot[rootKey(secondRoot)] || [];
  note(`folder 1 holds ${firstNames.length} project(s); folder 2 holds ${secondNames.length}`);
  check("the created folder's one repo is on the board, tagged with that folder", secondNames, ["second-repo"]);
  ok("the real folder's projects are tagged with it, not with the other one", firstNames.length >= 2 && !firstNames.includes("second-repo"), `${firstNames.length} projects`);
  ok("the two folders' project sets are disjoint", firstNames.every((n) => !secondNames.includes(n)), `${firstNames.length} + ${secondNames.length} of ${state.projects.length}`);

  // ---- the browser half --------------------------------------------------------------------------
  const pw = loadPlaywright();
  if (!pw) {
    console.log(notRun("two scan folders as two cards", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    failures += 1;
  } else {
    liveBrowser = await pw.chromium.launch({ headless: true });
    const context = await liveBrowser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon/i.test(m.text())) pageErrors.push(`console.error: ${m.text()}`);
    });
    const shot = async (name) => {
      const file = path.join(shotsDir, name);
      await page.screenshot({ path: file });
      note(`screenshot ${file} (${statSync(file).size} bytes)`);
      return file;
    };
    // Every read below is a painted box or a text node from the page, never a value parsed out of the source.
    const readCards = () =>
      page.evaluate(() => {
        const round = (n) => Math.round(n * 10) / 10;
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { left: round(r.left), right: round(r.right), top: round(r.top), bottom: round(r.bottom), width: round(r.width), height: round(r.height) };
        };
        return [...document.querySelectorAll("#projects > section.root-group")].map((el) => {
          const head = el.querySelector(":scope > .root-head");
          const body = el.querySelector(":scope > .root-body");
          const cs = getComputedStyle(el);
          const headCs = head ? getComputedStyle(head) : null;
          return {
            root: el.dataset.root || "",
            name: head?.querySelector("h2")?.textContent?.trim() || "",
            chev: head?.querySelector(".chev")?.textContent || "",
            collapsed: el.classList.contains("collapsed"),
            chips: [...el.querySelectorAll(":scope > .root-head .chip")].map((c) => c.textContent.trim()),
            projects: [...el.querySelectorAll(":scope > .root-body section.project")].map((s) => s.dataset.project),
            display: cs.display,
            visibility: cs.visibility,
            head: head ? { ...box(head), display: headCs.display, visibility: headCs.visibility } : null,
            body: body ? { ...box(body), display: getComputedStyle(body).display } : null,
            ...box(el),
          };
        });
      });
    const cardOf = (cards, root) => cards.find((c) => rootKey(c.root) === rootKey(root));
    const folds = async () => {
      const raw = await page.evaluate(() => localStorage.getItem("wm.collapsedRoots"));
      return raw == null ? null : JSON.parse(raw).map(rootKey).sort();
    };
    const clickHead = async (root) => {
      const sel = `#projects > section.root-group[data-root=${JSON.stringify(rootKey(root))}] > .root-head`;
      await page.locator(sel).click();
      await sleep(350);
    };

    console.log("\n== the board, drawn from the panel's own scan ==");
    await openPage(page, base, { selector: "section.root-group" });
    ok(
      "the board drew its folder cards",
      await waitFor(async () => (await readCards()).length >= 2, { timeoutMs: 60_000, what: "the second folder card" }),
    );
    let cards = await readCards();
    const roots = cards.map((c) => rootKey(c.root));
    check("exactly TWO cards, one per configured folder", roots.slice().sort(), [rootKey(FIRST_ROOT), rootKey(secondRoot)].sort());
    ok("…with no third folder card for a stray project", cards.length === 2, `${cards.length} cards`);

    const A = cardOf(cards, FIRST_ROOT);
    const B = cardOf(cards, secondRoot);
    ok("the real folder has its own card", Boolean(A), A?.root);
    ok("the created folder has its own card", Boolean(B), B?.root);
    if (!A || !B) throw new Error("the board did not draw both folder cards — the checks below cannot run");

    check("the first card NAMES its folder", A.name, rootLabel(FIRST_ROOT));
    check("the second card NAMES its folder", B.name, rootLabel(secondRoot));
    ok("…and each head says what it holds", A.chips.length > 0 && B.chips.length > 0, `${JSON.stringify(A.chips)} / ${JSON.stringify(B.chips)}`);
    check("the first card holds exactly its folder's projects", A.projects.slice().sort(), firstNames);
    check("the second card holds exactly its folder's projects", B.projects.slice().sort(), ["second-repo"]);
    ok(
      "every project on the board stands under its own folder's card",
      state.projects.every((p) => (cardOf(cards, p.root)?.projects || []).includes(p.name)),
      `${state.projects.length} projects accounted for`,
    );
    check("the two cards together are the whole board", [...A.projects, ...B.projects].sort(), (state.projects || []).map((p) => p.name).sort());
    ok("both cards start open, each with a body that paints", !A.collapsed && !B.collapsed && A.body?.height > 0 && B.body?.height > 0, `${A.body?.height}px / ${B.body?.height}px`);
    await shot("01-two-cards.png");

    // ---- each card folds and unfolds on its own ---------------------------------------------------
    console.log("\n== each card folds on its own ==");
    const startA = { height: A.height, body: A.body.height };
    const startB = { height: B.height, body: B.body.height };

    await clickHead(FIRST_ROOT);
    cards = await readCards();
    let a = cardOf(cards, FIRST_ROOT);
    let b = cardOf(cards, secondRoot);
    ok("pressing the first card's head folds THAT card", a.collapsed && a.body.display === "none", `class "${a.collapsed ? "collapsed" : "open"}", body ${a.body.display}`);
    ok("…it shrinks to its head (the projects are really gone)", a.height <= a.head.height + 8 && a.height < startA.height - 40, `${startA.height}px → ${a.height}px (head ${a.head.height}px)`);
    check("…its chevron points right", a.chev, "\u25b8");
    ok("…and the second card is untouched: still open, same body", !b.collapsed && b.body.display !== "none" && Math.abs(b.body.height - startB.body) <= 1, `open, body ${startB.body}px → ${b.body.height}px`);
    check("…its chevron still points down", b.chev, "\u25be");
    check("…and the fold record names the first folder only", await folds(), [rootKey(FIRST_ROOT)]);
    await shot("02-first-card-folded.png");

    await clickHead(secondRoot);
    cards = await readCards();
    a = cardOf(cards, FIRST_ROOT);
    b = cardOf(cards, secondRoot);
    ok("pressing the second card's head folds it too, without opening the first", b.collapsed && a.collapsed);
    check("…and the fold record names both folders", await folds(), [rootKey(FIRST_ROOT), rootKey(secondRoot)].sort());
    check("…each card's own head keeps naming its folder while folded", cards.map((c) => c.name).sort(), [rootLabel(FIRST_ROOT), rootLabel(secondRoot)].sort());

    // Both heads, both still on screen: a folded card is a head, and neither fold may push the other away.
    const bothFolded = await page.evaluate(() => {
      const heads = [...document.querySelectorAll("#projects > section.root-group > .root-head")].map((h) => {
        const r = h.getBoundingClientRect();
        return { root: h.closest("section.root-group").dataset.root, top: Math.round(r.top), bottom: Math.round(r.bottom) };
      });
      return { vh: innerHeight, heads, scrollY: Math.round(scrollY) };
    });
    ok(
      "with BOTH cards folded, both heads are on screen",
      bothFolded.heads.length === 2 && bothFolded.heads.every((h) => h.top >= 0 && h.bottom <= bothFolded.vh + 1),
      bothFolded.heads.map((h) => `${h.root} ${h.top}-${h.bottom} of ${bothFolded.vh}`).join(" · "),
    );
    await shot("03-both-cards-folded.png");

    await clickHead(FIRST_ROOT);
    cards = await readCards();
    a = cardOf(cards, FIRST_ROOT);
    b = cardOf(cards, secondRoot);
    ok("unfolding the first card opens it and leaves the second folded", !a.collapsed && b.collapsed, `first ${a.collapsed ? "folded" : "open"}, second ${b.collapsed ? "folded" : "open"}`);
    check("…its projects are back", a.projects.slice().sort(), firstNames);
    check("…and the fold record names the second folder only", await folds(), [rootKey(secondRoot)]);

    await clickHead(secondRoot);
    cards = await readCards();
    a = cardOf(cards, FIRST_ROOT);
    b = cardOf(cards, secondRoot);
    ok("unfolding the second card opens it too — both are open again", !a.collapsed && !b.collapsed);
    ok(
      "…with nothing lost: both bodies paint and hold their own projects",
      a.body.height > 0 && b.body.height > 0 && a.projects.length === firstNames.length && b.projects.join() === "second-repo",
      `${a.projects.length} + ${b.projects.length} projects`,
    );
    check("…and the fold record is empty", await folds(), []);

    // ---- the window, fully collapsed ---------------------------------------------------------------
    // The reader's own worst case: the window squashed to its smallest height (the size of the screenshot this
    // change was asked against), with the two fixed agent cards folded the way they are left. Both folder cards must
    // still be visible: drawn, inside the window horizontally, and with a head the reader can see without hunting.
    console.log("\n== the window, fully collapsed ==");
    await page.setViewportSize({ width: 1879, height: 157 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitFor(async () => (await readCards()).length >= 2, { timeoutMs: 60_000, what: "both cards after the reload" });
    await sleep(400);
    // Fold the two fixed cards (the agent cards above the board), each through its own head.
    for (const id of ["newagent", "agents"]) {
      const sel = `.project-head[data-toggle-fixed="${id}"]`;
      if ((await page.locator(sel).count()) === 0) continue;
      const sec = page.locator(`section.project:has(> ${sel})`).first();
      const cls = (await sec.getAttribute("class")) || "";
      if (!cls.includes("fixed-collapsed")) await page.locator(sel).click();
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    const win = await page.evaluate(() => {
      const round = (n) => Math.round(n * 10) / 10;
      const main = document.querySelector("main");
      const boardTop = document.querySelector("#projects")?.getBoundingClientRect().top;
      return {
        vw: innerWidth,
        vh: innerHeight,
        clientW: document.documentElement.clientWidth,
        clientH: document.documentElement.clientHeight,
        scrollY: Math.round(scrollY),
        pageScrollH: document.documentElement.scrollHeight,
        boardTop: boardTop == null ? null : round(boardTop),
        header: round(document.querySelector("header")?.getBoundingClientRect().height || 0),
        above: ["newagent", "agents"].map((id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { id, top: round(r.top), height: round(r.height), folded: el.classList.contains("fixed-collapsed") };
        }),
        main: { left: round(main.getBoundingClientRect().left), right: round(main.getBoundingClientRect().right), scrollW: main.scrollWidth, clientW: main.clientWidth },
        cards: [...document.querySelectorAll("#projects > section.root-group")].map((el) => {
          const h = el.querySelector(":scope > .root-head").getBoundingClientRect();
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            root: el.dataset.root,
            name: el.querySelector(":scope > .root-head h2")?.textContent?.trim() || "",
            display: cs.display,
            visibility: cs.visibility,
            left: round(r.left),
            right: round(r.right),
            top: round(r.top),
            width: round(r.width),
            height: round(r.height),
            headTop: round(h.top),
            headBottom: round(h.bottom),
            headLeft: round(h.left),
            headRight: round(h.right),
            onScreen: h.bottom > 0 && h.top < innerHeight,
            fullyOnScreen: h.top >= 0 && h.bottom <= innerHeight + 1,
          };
        }),
      };
    });
    note(`window ${win.vw}×${win.vh}; header ${win.header}px; page ${win.pageScrollH}px tall; main ${win.main.clientW}px wide / ${win.main.scrollW}px of content`);
    note(`above the board: ${win.above.filter(Boolean).map((a) => `#${a.id} ${a.height}px${a.folded ? " (folded)" : ""}`).join(" · ")}; #projects starts at y=${win.boardTop}`);
    for (const c of win.cards) note(`card ${c.name}: ${c.width}×${c.height} at (${c.left}, ${c.top}); head ${c.headTop}-${c.headBottom}`);

    check("the board still draws both cards in the collapsed window", win.cards.map((c) => rootKey(c.root)).sort(), [rootKey(FIRST_ROOT), rootKey(secondRoot)].sort());
    ok(
      "neither card is hidden (display/visibility/zero-sized)",
      win.cards.every((c) => c.display !== "none" && c.visibility !== "hidden" && c.width > 100 && c.height > 0),
      win.cards.map((c) => `${c.display}/${c.visibility} ${c.width}×${c.height}`).join(" · "),
    );
    ok(
      "both cards are inside the window horizontally (neither pushed off to the side)",
      win.cards.every((c) => c.left >= -1 && c.right <= win.clientW + 1),
      win.cards.map((c) => `${c.left}..${c.right} of ${win.clientW}`).join(" · "),
    );
    // The claim the collapsed window is really about: the two heads are on screen TOGETHER, without scrolling the
    // reader into the board. A card below the window's own height is pushed off-screen, whatever its display says.
    ok(
      "BOTH folder heads are on screen at once, without scrolling",
      win.cards.length === 2 && win.cards.every((c) => c.fullyOnScreen),
      win.cards.map((c) => `${c.name}: head ${c.headTop}-${c.headBottom} of a ${win.vh}px window`).join(" · "),
    );
    await shot("04-collapsed-window.png");

    // …and each one is reachable and hit-testable when it is brought into view, so "not visible" is not being read
    // from a card that is merely covered or clipped.
    const reached = [];
    for (const c of win.cards) {
      const sel = `#projects > section.root-group[data-root=${JSON.stringify(rootKey(c.root))}] > .root-head`;
      await page.locator(sel).evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
      await sleep(250);
      reached.push(
        await page.evaluate((s) => {
          const head = document.querySelector(s);
          const r = head.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const hit = document.elementFromPoint(cx, cy);
          const header = document.querySelector("header")?.getBoundingClientRect();
          return {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            vh: innerHeight,
            insideViewport: r.top >= 0 && r.bottom <= innerHeight + 1,
            hitOwnCard: Boolean(hit && hit.closest("section.root-group") === head.closest("section.root-group")),
            hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className || "").trim().split(/\s+/).join(".")}` : null,
            headerBottom: header ? Math.round(header.bottom) : 0,
            underHeader: header ? r.top < header.bottom - 1 : false,
          };
        }, sel),
      );
    }
    ok(
      "each card can be brought fully into the viewport and is the element under its own head",
      reached.every((r) => r.insideViewport && r.hitOwnCard && !r.underHeader),
      reached.map((r) => `${r.top}-${r.bottom} of ${r.vh}, hit ${r.hit}${r.underHeader ? ", under the header" : ""}`).join(" · "),
    );
    await shot("05-collapsed-window-scrolled.png");

    check("no page errors", pageErrors, []);
    await context.close();
  }

  console.log("\n== the live panel and the live config ==");
  check("the live board's listener count is unchanged by this run", listenersOn(7331), liveBefore);
  const liveAfter = existsSync(liveConfigPath) ? createHash("sha256").update(readFileSync(liveConfigPath)).digest("hex") : "(absent)";
  check("the repo's own config.json was never written", liveAfter, liveConfigHash);
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panel?.log) console.log(`--- panel log (tail)\n${String(panel.log()).split(/\r?\n/).slice(-25).join("\n")}`);
} finally {
  if (liveBrowser) {
    try {
      await liveBrowser.close();
    } catch {
      /* already gone */
    }
    liveBrowser = null;
  }
  try {
    await panel.stop();
  } catch {
    /* already gone */
  }
  if (process.env.VERIFY_KEEP === "1") console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  else {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  }
  clearTimeout(watchdog);
}

console.log("\n== summary ==");
console.log(`${checks} checks, ${failures} failed`);
console.log("\nWHAT WAS DRIVEN: a real server.js on its own free port over its own PANEL_CONFIG, HERMES_HOME and projects");
console.log("cache (the live 7331 listener count identical across the run, the repo's config.json hash unchanged), scanning");
console.log("the real C:/CodeReviews/ and a folder this run made in its temp directory; then headless Chromium over that");
console.log("board — the two cards counted and named, each card's projects checked against the server's own tagged scan,");
console.log("the four fold/unfold presses read from the page and from wm.collapsedRoots, both folded heads, and the");
console.log("window squashed to 1879x157 with both cards measured.");
if (!failures) console.log("TWO-FOLDER-CARDS-OK");
process.exitCode = failures ? 1 : 0;
