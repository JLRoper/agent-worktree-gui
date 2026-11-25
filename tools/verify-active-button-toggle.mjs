// tools/verify-active-button-toggle.mjs - the header's ACTIVE AGENTS control as a GENERAL SETTINGS TOGGLE, driven in
// a real browser at 1440x900.
// HARNESS: LIVE GATE - it tracks main, and `npm run verify:active-button-toggle` is how the repo runs it by name.
//
//   node tools/verify-active-button-toggle.mjs                 # boot a throwaway panel and drive it
//   node tools/verify-active-button-toggle.mjs --root <tree>    # serve a `git archive` of another build (RED PROOF)
//   node tools/verify-active-button-toggle.mjs --shots <dir>    # write the screenshots there (default .shots/)
//
// WHAT IT PROVES. The control that used to be welded to the header is now behind Settings > General > "Show the
// Active agents button in the floating header", and the word it shows is Active:
//
//   1. a reader who never opened the row: the switch is OFF and the header carries NO Active button - not grey, not a
//      zero badge, not a reserved slot;
//   2. turning it ON through that row puts the control back with its new word, its bolt and its count while an agent
//      is working - and the count is only ever the agents working now: an agent parked on a permission is not a
//      working agent, so with every agent parked the control is absent again even though the switch is on (and the
//      removed Human control is proved absent from the page);
//   3. one press still lands: the next working agent's card flashes and the label steps (`Active 1/1`) - the
//      click-through the row promised did not move with the switch;
//   4. turning it OFF takes the control away again while the same agent is still working, and the browser keeps that
//      choice across a reload (it is the same store and the same save path the neighbouring rows use);
//   5. the Hot Agent pen search beside it is untouched: same button, same drawn glyph, same Ctrl+Shift+Q label, with
//      the Active control beside it on and with it off.
//
// HOW THE LIVE AGENTS ARE MADE. The page's own job list is the evidence the control reads, so the harness replaces
// the job list every /api/state answer carries with the seeded records (the same technique tools/verify-hot-mark.mjs
// uses). Nothing is fabricated in the page: the records are the shape lib/jobs.js writes, the page applies them
// through its own applyJobSnapshot path, and it paints from its own clock.
//
// The screenshots are taken at 1440x900, the size the brief names: `active-button-1-off.png` is the header with the
// switch off and one agent working, `active-button-2-on.png` the same page with it on (bolt and count), and
// `active-button-3-off-again.png` after the switch goes back off under the same working agent. Each names the
// 1440x900 size in its own file name.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser, openPage } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const SHOT_DIR = opt("--shots", process.env.PANEL_SHOT_DIR || path.join(HERE, "..", ".shots"));
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), got === want ? String(got) : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (name) => console.log(`\n-- ${name}`);

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN  no Playwright install found - set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
  process.exit(2);
}

// ---- the fixture: job records in the shape lib/jobs.js writes --------------------------------------------------
// A homeless run (`ownerPath: null`, no worktreePath): the board draws it in the unattached agents panel, so the
// whole proof needs no git fixture and no worktree.
const AT = "2026-11-18T10:00:00.000Z";
const job = (over = {}) => ({
  id: over.name,
  thread: over.name,
  status: "running",
  startedAt: AT,
  model: "verify-active-button",
  title: over.title || over.name,
  lines: [],
  turn: 1,
  ownerPath: null,
  worktreePath: null,
  approval: null,
  approvalDone: null,
  question: null,
  questionDone: null,
  ...over,
});
const WORKING = job({ name: "active-one", title: "the renamed control" });
const PARKED = job({
  name: "parked-one",
  title: "a run on a permission",
  status: "waiting_for_approval",
  approval: {
    requestId: "req-parked",
    command: "git push origin HEAD",
    choices: ["once", "deny"],
    at: AT,
    deadline: Date.now() + 5 * 60_000,
  },
});
let fixture = [];

const panel = await startPanel({ root: TREE });
const shots = path.resolve(SHOT_DIR);
mkdirSync(shots, { recursive: true });

const result = await (async () => {
  try {
    return await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        // The fixture, in the one place the page takes a job list: the poll's applySnapshot and a stream snapshot both
        // land in applyJobSnapshot, so wrapping it once covers both and the list can be moved under the page.
        await page.addInitScript(() => {
          window.__activeFixture = { list: [] };
          const wrap = () => {
            if (typeof applyJobSnapshot !== "function" || applyJobSnapshot.__fixture) return false;
            const original = applyJobSnapshot;
            const wrapped = function () {
              return original(window.__activeFixture.list.map((j) => ({ ...j })));
            };
            wrapped.__fixture = true;
            window.applyJobSnapshot = wrapped;
            return true;
          };
          const tick = setInterval(() => {
            if (wrap()) clearInterval(tick);
          }, 30);
          window.addEventListener("load", wrap);
        });
        await page.route("**/api/state*", async (route) => {
          const res = await route.fetch();
          const json = await res.json();
          json.jobs = fixture;
          await route.fulfill({ response: res, json });
        });

        await openPage(page, panel.base, { selector: "header.topbar #btn-review" });

        const seed = async (list) => {
          fixture = list;
          await page.evaluate((next) => {
            window.__activeFixture.list = next;
          }, list);
          await page.evaluate(() => resync());
          await page.waitForTimeout(1400);
        };
        const drawerOpen = () => page.evaluate(() => Boolean(document.getElementById("settings") && !document.getElementById("settings").classList.contains("hidden")));
        const openGeneral = async () => {
          if (!(await drawerOpen())) await page.click("#btn-settings");
          await page.click("#settings-tab-general");
          await page.waitForTimeout(120);
        };
        const closeDrawer = async () => {
          if (await drawerOpen()) await page.click("#btn-settings");
          await page.evaluate(() => document.activeElement?.blur?.());
          await page.waitForTimeout(120);
        };
        const box = () =>
          page.evaluate(() => {
            const el = document.getElementById("general-active-button");
            return { exists: Boolean(el), checked: el ? el.checked : null };
          });
        // The header's own reading of the control: what is in the DOM, what is drawn, and every word on it.
        const mark = () =>
          page.evaluate(() => {
            const btn = document.getElementById("btn-hot");
            const review = document.getElementById("btn-review");
            const pen = document.getElementById("ha-search-open");
            const glyph = pen ? pen.querySelector("svg") : null;
            const r = (el) => {
              const b = el.getBoundingClientRect();
              return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
            };
            const out = {
              inHeader: Boolean(btn && btn.closest("header.topbar .controls")),
              hidden: btn ? btn.hidden : null,
              drawn: Boolean(btn && btn.offsetParent !== null && btn.getBoundingClientRect().width > 0),
              label: document.getElementById("hot-label")?.textContent || "",
              badge: document.getElementById("hot-badge") ? document.getElementById("hot-badge").textContent : "",
              badgeHidden: document.getElementById("hot-badge")?.hidden ?? null,
              aria: btn?.getAttribute("aria-label") || "",
              title: btn?.title || "",
              color: btn ? getComputedStyle(btn).color : "",
              box: btn ? r(btn) : { x: 0, y: 0, w: 0, h: 0 },
              reviewBadge: (() => {
                const b = document.getElementById("review-badge");
                return b && !b.hidden ? b.textContent || "" : "";
              })(),
              humanGone: !document.getElementById("btn-human") && !document.getElementById("human-badge"),
              pen: {
                exists: Boolean(pen),
                drawn: Boolean(pen && pen.offsetParent !== null && pen.getBoundingClientRect().width > 0),
                glyph: Boolean(glyph && glyph.getAttribute("viewBox") === "0 0 16 16" && pen.querySelectorAll("svg rect").length >= 4),
                label: pen?.getAttribute("aria-label") || "",
                title: pen?.title || "",
                box: pen ? r(pen) : { x: 0, y: 0, w: 0, h: 0 },
              },
            };
            return out;
          });
        const shot = async (name) => {
          if (!SHOT_DIR) return;
          await page.screenshot({ path: path.join(shots, name) });
          console.log(`SHOT  ${path.join(shots, name)}`);
        };

        // ---- 1. the default: off, and the header has no such control ---------------------------------------------
        section("a reader who never set it: OFF, and no button in the header");
        await seed([WORKING]);
        await openGeneral();
        eq("the General row exists and is unchecked", await box(), { exists: true, checked: false });
        await closeDrawer();
        let s = await mark();
        ok("there is a hidden control in the header's group", s.inHeader === true, JSON.stringify({ inHeader: s.inHeader }));
        ok("but it is NOT drawn: off is absent, not hidden-but-reserved", s.hidden === true && s.drawn === false, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));
        ok("...with no box on the page either, so nothing is reserving a slot", s.box.w === 0 && s.box.h === 0, JSON.stringify(s.box));
        ok("the removed Human control is absent from the header", s.humanGone === true);
        await shot("active-button-1-off-1440x900.png");
        ok("the proof is taken at 1440x900", (await page.viewportSize()).width === 1440 && (await page.viewportSize()).height === 900);

        // ---- 2. the switch, turned on through its own row --------------------------------------------------------
        section("the row turns it on, and the control comes back with its new word");
        await openGeneral();
        const rowWords = await page.evaluate(() => {
          const el = document.getElementById("general-active-button");
          const row = el?.closest("label.settings-row");
          return { label: (row?.querySelector("span")?.textContent || "").trim(), title: row?.getAttribute("title") || "" };
        });
        ok("the row is named for the control", /^Show the Active agents button in the floating header/.test(rowWords.label), rowWords.label);
        ok("its tooltip says off is the default and names the pen as another control", /OFF by default/.test(rowWords.title) && /DIFFERENT control from the Hot Agent pen search/.test(rowWords.title), rowWords.title.slice(0, 140));
        await page.check("#general-active-button");
        await page.waitForTimeout(200);
        eq("the press stores the browser key", await page.evaluate(() => localStorage.getItem("wtgui.activeButton")), "1");
        await shot("active-button-2-settings-row-1440x900.png");
        await closeDrawer();
        s = await mark();
        ok("the control is drawn again", s.hidden === false && s.drawn === true, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));
        eq("with the new word, the bolt and no counter yet", s.label, "⚡ Active");
        ok("and no title or label still says Hot Agents", !/Hot Agents/.test(s.title) && !/Hot Agents/.test(s.aria), `${s.title.slice(0, 60)} | ${s.aria}`);
        eq("carrying the count of the agent working now", s.badge, "1");
        ok("in the panel's amber", s.color === "rgb(240, 198, 116)", s.color);
        ok("its tooltip names the setting that draws it", /Show the Active agents button in the floating header/.test(s.title), s.title.slice(0, 160));
        await shot("active-button-3-on-header-1440x900.png");
        const head = await page.locator("header.topbar").boundingBox();
        if (SHOT_DIR && head) {
          await page.screenshot({
            path: path.join(shots, "active-button-3b-on-header-crop-1440x900.png"),
            clip: { x: Math.max(0, head.x), y: Math.max(0, head.y), width: Math.min(1440, head.width), height: Math.min(900, head.height) },
          });
          console.log(`SHOT  ${path.join(shots, "active-button-3b-on-header-crop-1440x900.png")}`);
        }

        // ---- 3. the pen search beside it did not move -----------------------------------------------------------
        section("the Hot Agent pen search beside it is untouched");
        ok("the pen search is still drawn, with its drawn glyph", s.pen.exists === true && s.pen.drawn === true && s.pen.glyph === true, JSON.stringify(s.pen));
        ok("it still names its chord", /Ctrl\+Shift\+Q/.test(s.pen.label) && /Ctrl\+Shift\+Q/.test(s.pen.title), s.pen.label);
        eq("and still calls itself the Hot Agent search", s.pen.label, "Hot Agent search (Ctrl+Shift+Q)");
        ok("the Active control sits to its left, as it always did", s.box.x < s.pen.box.x, JSON.stringify({ active: s.box, pen: s.pen.box }));

        // ---- 4. parked agents are never the Active count ---------------------------------------------------------
        section("every agent parked: the control is away even with the switch on");
        await seed([PARKED]);
        s = await mark();
        ok("the parked run is not counted by this control: a parked turn is not working", s.hidden === true && s.drawn === false, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));
        ok("and the Active control is absent: nothing is working", s.hidden === true && s.drawn === false, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));

        // ---- 5. one press still lands ---------------------------------------------------------------------------
        section("one press still lands, with the new word");
        await seed([WORKING]);
        s = await mark();
        eq("the working agent is back on the badge", s.badge, "1");
        await page.locator("#btn-hot").click();
        await page.waitForTimeout(400);
        s = await mark();
        eq("the label steps into the rotation", s.label, "⚡ Active 1/1");
        const landed = await page.evaluate(() => ({
          jumped: [...document.querySelectorAll(".job.jump")].map((el) => el.dataset.thread),
          banner: document.querySelector(".banner")?.textContent || "",
        }));
        ok("the agent's card is flashed", landed.jumped.includes("active-one"), JSON.stringify(landed.jumped));
        ok("the banner names the agent and says Active", /Active agents: 1 agent is working - landing on the renamed control/.test(landed.banner), landed.banner.slice(0, 140));
        await shot("active-button-4-press-1440x900.png");

        // ---- 6. off again, under the same working agent ---------------------------------------------------------
        section("switched off again, with the same agent still working");
        await openGeneral();
        await page.uncheck("#general-active-button");
        await page.waitForTimeout(200);
        eq("the browser holds the off value", await page.evaluate(() => localStorage.getItem("wtgui.activeButton")), "0");
        await closeDrawer();
        s = await mark();
        ok("the control is gone from the header", s.hidden === true && s.drawn === false, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));
        ok("while the agent is still working, so this is the switch and not the work ending", s.badgeHidden === true || s.badge === "1", JSON.stringify({ badge: s.badge, badgeHidden: s.badgeHidden }));
        ok("the pen search is still drawn beside where it was", s.pen.exists === true && s.pen.drawn === true, JSON.stringify(s.pen));
        await shot("active-button-5-off-again-1440x900.png");

        // ---- 7. the choice is the browser's, so a reload keeps it ------------------------------------------------
        section("the choice survives a reload");
        await page.reload();
        await page.waitForSelector("header.topbar #btn-review");
        await page.evaluate((next) => {
          window.__activeFixture.list = next;
        }, [WORKING]);
        await page.evaluate(() => resync());
        await page.waitForTimeout(1600);
        await openGeneral();
        eq("the row is still unchecked after the reload", await box(), { exists: true, checked: false });
        await closeDrawer();
        s = await mark();
        ok("and the header still has no Active button", s.hidden === true && s.drawn === false, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));

        await openGeneral();
        await page.check("#general-active-button");
        await closeDrawer();
        await page.reload();
        await page.waitForSelector("header.topbar #btn-review");
        await page.evaluate((next) => {
          window.__activeFixture.list = next;
        }, [WORKING]);
        await page.evaluate(() => resync());
        await page.waitForTimeout(1600);
        s = await mark();
        ok("a reload with it ON keeps the control, with its word", s.hidden === false && s.drawn === true && s.label === "⚡ Active", JSON.stringify({ hidden: s.hidden, drawn: s.drawn, label: s.label }));

        ok("the page raised no error", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
        ok("the console logged no error", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 200));

        return { notes: "green", checks, failures };
      },
      { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    );
  } finally {
    await panel.stop();
  }
})();

const run = { ...result, failures };
// The record beside the shots is committed, so it names the files and the size and nothing about this machine: an
// absolute path here is a folder that exists on exactly one host (tools/absolute-paths.mjs refuses the push), and the
// sandbox's port is gone with the run.
if (SHOT_DIR) {
  const shotsRun = {
    harness: "tools/verify-active-button-toggle.mjs",
    viewport: "1440x900",
    shots: [
      "active-button-1-off-1440x900.png",
      "active-button-2-settings-row-1440x900.png",
      "active-button-3-on-header-1440x900.png",
      "active-button-3b-on-header-crop-1440x900.png",
      "active-button-4-press-1440x900.png",
      "active-button-5-off-again-1440x900.png",
    ],
    checks,
    failures,
    at: new Date().toISOString(),
  };
  writeFileSync(path.join(shots, "run.json"), JSON.stringify(shotsRun, null, 1));
}
console.log(`\n${checks - failures} of ${checks} checks passed${SHOT_DIR ? `; shots in ${shots}` : ""}`);
process.exit(failures ? 1 : 0);
