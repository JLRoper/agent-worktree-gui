// tools/verify-hot-mark.mjs - the header's HOT AGENTS bolt, driven in a real browser against a real panel.
// HARNESS: LIVE GATE - it tracks main, and `npm run verify:hot-mark` is how the repo runs it by name.
//
//   node tools/verify-hot-mark.mjs                       # boot a throwaway panel and drive it
//   node tools/verify-hot-mark.mjs --root <tree>          # serve a `git archive` of another build (RED PROOF)
//   node tools/verify-hot-mark.mjs --shots <dir>          # write the screenshots there (default .shots/)
//
// WHAT IT PROVES. The bolt is a HEADER CONTROL and it is DRAWN ONLY WHILE AN AGENT IS WORKING:
//
//   0. the control is behind Settings > General > "Show the Active agents button in the floating header" and ships
//      OFF, so this gate turns it ON through that row first - the default and the off/on proof are the subject of
//      tools/verify-active-button-toggle.mjs;
//   1. with nothing running it is not in the header at all - not grey, not a zero badge, absent;
//   2. an agent PARKED on a permission is not hot (it is live, and the red Human count beside it owns it), so the
//      bolt stays away while Human reads 1 - the two controls never count the same agent;
//   3. one working agent draws it, amber, beside Human, the same height and on the same row: the family's own
//      hit area, with the count on its badge and the agent named in its tooltip;
//   4. two working agents are two on the badge and both named in the tooltip;
//   5. a press lands on the next one - the card flashes and the label steps (`Hot 1/2`), a second press on the other;
//   6. the work ending takes the bolt away again, and the header is back to Human alone.
//
// HOW THE LIVE AGENTS ARE MADE. The page's own job list is the evidence the bolt reads, so the harness replaces the
// job list every /api/state answer carries with the seeded records (the same technique tools/verify-focus-mode.mjs
// uses, and for the same reason: a check that says "exactly one agent" has to be about the fixture and nothing else).
// Nothing is fabricated in the page: the records are the shape lib/jobs.js writes, and the page applies them through
// its own applySnapshot -> applyJobSnapshot path, then paints from its own clock.
//
// The screenshots are taken at 1440x900, the size the brief names: `hot-mark-header-1440x900.png` is the header with
// Human and the bolt together, `hot-mark-press-1440x900.png` the page after the press.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// A homeless run (`ownerPath: null`, no worktreePath): the board draws it in the unattached agents panel, which is
// where a job with no row is drawn, so the whole proof needs no git fixture and no worktree.
const AT = "2026-11-18T10:00:00.000Z";
const job = (over = {}) => ({
  id: over.name,
  thread: over.name,
  status: "running",
  startedAt: AT,
  model: "verify-hot-mark",
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
const HOT_ONE = job({ name: "hot-one", title: "the lightning bolt" });
const HOT_TWO = job({ name: "hot-two", title: "the header job" });
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
const DONE_ONE = job({ name: "hot-one", title: "the lightning bolt", status: "done" });
const DONE_TWO = job({ name: "hot-two", title: "the header job", status: "done" });

// The page's read of the fixture: every list it applies is this one (see the init script below).
let fixture = [];

const panel = await startPanel({ root: TREE });
const shots = path.resolve(SHOT_DIR);
mkdirSync(shots, { recursive: true });

const result = await (async () => {
  try {
    return await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        // The fixture, in the one place the page takes a job list: the poll's applySnapshot and a stream snapshot
        // both land in applyJobSnapshot, so wrapping it once covers both and the list can be moved under the page.
        await page.addInitScript(() => {
          window.__hotMarkFixture = { list: [] };
          const wrap = () => {
            if (typeof applyJobSnapshot !== "function" || applyJobSnapshot.__fixture) return false;
            const original = applyJobSnapshot;
            const wrapped = function () {
              return original(window.__hotMarkFixture.list.map((j) => ({ ...j })));
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

        await openPage(page, panel.base, { selector: "header.topbar #btn-human" });

        // Put a list under the page and wait for it to be applied and painted. `resync` is the page's own snapshot
        // read, and the paint arrives on its own 1 s clock (the same one that keeps the Human count honest), which is
        // what makes this a proof of the real wiring rather than of a function the harness called.
        const seed = async (list) => {
          fixture = list;
          await page.evaluate((next) => {
            window.__hotMarkFixture.list = next;
          }, list);
          await page.evaluate(() => resync());
          await page.waitForTimeout(1400);
        };
        const headerState = () =>
          page.evaluate(() => {
            const bar = document.querySelector("header.topbar");
            const human = document.querySelector("#btn-human");
            if (!bar || !human) return { missing: true };
            const hbox = human.getBoundingClientRect();
            return { missing: false, headerHeight: Math.round(bar.getBoundingClientRect().height), humanBox: { x: Math.round(hbox.x), y: Math.round(hbox.y), w: Math.round(hbox.width), h: Math.round(hbox.height) } };
          });
        const hotState = () =>
          page.evaluate(() => {
            const btn = document.querySelector("#btn-hot");
            const human = document.querySelector("#btn-human");
            const pen = document.querySelector("#ha-search-open");
            const rect = (el) => {
              const b = el.getBoundingClientRect();
              return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
            };
            const recipe = (style) => ({
              pad: style.padding,
              border: style.borderTopWidth,
              radius: style.borderTopLeftRadius,
              font: style.fontFamily.slice(0, 24) + "/" + style.fontSize,
              gap: style.columnGap,
            });
            const out = {
              exists: Boolean(btn),
              hidden: btn ? btn.hidden : null,
              drawn: false,
              label: "",
              badge: "",
              badgeHidden: null,
              isHot: false,
              aria: "",
              title: "",
              color: "",
              background: "",
              border: "",
              recipe: null,
              humanRecipe: human ? recipe(getComputedStyle(human)) : null,
              box: { x: 0, y: 0, w: 0, h: 0 },
              humanBox: human ? rect(human) : { x: 0, y: 0, w: 0, h: 0 },
              penBox: pen ? rect(pen) : { x: 0, y: 0, w: 0, h: 0 },
              humanBadge: (() => {
                const b = human && document.querySelector("#human-badge");
                return b && !b.hidden ? b.textContent || "" : "";
              })(),
              inControls: Boolean(btn && btn.closest("header.topbar .controls")),
              inRow: Boolean(btn && btn.closest("tr.row, tr.detail")),
              key: (() => {
                try {
                  return state.hot.key;
                } catch {
                  return null;
                }
              })(),
            };
            // On a build WITHOUT the marker there is no button to read: every field stays at its absent value, so the
            // gate reports its failures and a count instead of throwing on the first undefined.
            if (!btn || !human) return out;
            const box = btn.getBoundingClientRect();
            const cs = getComputedStyle(btn);
            return {
              ...out,
              drawn: btn.offsetParent !== null && box.width > 0 && box.height > 0,
              label: document.querySelector("#hot-label")?.textContent || "",
              badge: document.querySelector("#hot-badge")?.textContent || "",
              badgeHidden: document.querySelector("#hot-badge")?.hidden ?? null,
              isHot: btn.classList.contains("is-hot"),
              aria: btn.getAttribute("aria-label") || "",
              title: btn.title || "",
              color: cs.color,
              background: cs.backgroundColor,
              border: cs.borderTopColor,
              recipe: recipe(cs),
              box: rect(btn),
            };
          });

        // ---- 0. the switch that decides whether the header carries it at all --------------------------------------
        // The control is a SETTINGS row now and ships OFF, so this gate turns it on through the row a reader uses.
        // The default, the absent-with-it-off state, and the off-and-on round trip are the subject of
        // tools/verify-active-button-toggle.mjs; here the row is opened only to let the marker exist, and every check
        // below is about the marker itself.
        section("the switch, turned on through its own Settings row");
        const drawerOpen = () => page.evaluate(() => Boolean(document.getElementById("settings") && !document.getElementById("settings").classList.contains("hidden")));
        if (!(await drawerOpen())) await page.click("#btn-settings");
        await page.click("#settings-tab-general");
        const switchRow = await page.evaluate(() => {
          const box = document.getElementById("general-active-button");
          return {
            exists: Boolean(box),
            checked: box ? box.checked : null,
            label: (box?.closest("label.settings-row")?.querySelector("span")?.textContent || "").trim(),
            inGeneral: Boolean(box && box.closest("#settings-panel-general")),
          };
        });
        ok("Settings > General carries the row", switchRow.exists === true && switchRow.inGeneral === true, JSON.stringify(switchRow));
        ok("...named for the Header control", /^Show the Active agents button in the floating header/.test(switchRow.label), switchRow.label);
        eq("...and it ships OFF for a reader who never set it", switchRow.checked, false);
        await page.check("#general-active-button");
        await page.waitForTimeout(150);
        eq("the press stores the browser key", await page.evaluate(() => localStorage.getItem("wtgui.activeButton")), "1");
        if (await drawerOpen()) await page.click("#btn-settings");
        await page.evaluate(() => document.activeElement?.blur?.());

        // ---- 1. nothing is hot ----------------------------------------------------------------------------------
        section("nothing is hot");
        await seed([]);
        const head = await headerState();
        ok("the header is drawn, with Human on it", !head.missing && head.humanBox.w > 0 && head.headerHeight > 0, JSON.stringify(head));
        let s = await hotState();
        ok("the page has the marker at all", s.exists === true);
        ok("#btn-human is there and quiet", s.humanBadge === "", `human badge ${JSON.stringify(s.humanBadge)}`);
        ok("the bolt is NOT in the header at all", s.hidden === true && s.drawn === false, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));
        ok("...and it says why, for anything that reads it", /nothing is working right now/.test(s.title), s.title.slice(0, 80));
        // A build with no marker at all (the RED proof: `--root` an export of main before this landed) stops here
        // rather than throwing on the first absent element: the count above is the gate's answer, and the rest of the
        // sections need a button to measure.
        if (!s.exists) {
          ok("the sections that measure it are reachable", false, "no #btn-hot in this build");
          return { base: panel.base, port: panel.port, notes: "no #btn-hot in this build" };
        }

        // ---- 2. a parked agent is live, and is Human's -----------------------------------------------------------
        section("an agent parked on a permission is not hot");
        await seed([PARKED]);
        s = await hotState();
        ok("the parked run raises the red Human count", s.humanBadge === "1", `human badge ${JSON.stringify(s.humanBadge)}`);
        ok("the bolt stays away: a parked agent is the red count's, not the amber one", s.hidden === true && s.drawn === false, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));

        // ---- 3. a working agent draws the bolt -------------------------------------------------------------------
        section("one working agent");
        await seed([HOT_ONE]);
        s = await hotState();
        ok("the bolt is drawn", s.hidden === false && s.drawn === true, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));
        ok("...in the header's control group, not on a row", s.inControls === true && s.inRow === false);
        eq("...labelled as the family's controls are, with the word Active", s.label, "⚡ Active");
        eq("...carrying the count on its badge", s.badge, "1");
        ok("...with the amber state class on", s.isHot === true);
        eq("Human stays quiet beside it: a working agent is not a question", s.humanBadge, "");
        ok("its colour is the panel's amber, not the lock's or the review mark's", s.color === "rgb(240, 198, 116)", `color ${s.color}`);
        ok("its background is the amber surface", s.background === "rgb(42, 35, 18)", `background ${s.background}`);
        ok("its border is the amber edge", s.border === "rgb(77, 61, 18)", `border ${s.border}`);
        ok("the same hit-area recipe as Human: padding, border, radius, font, gap", JSON.stringify(s.recipe) === JSON.stringify(s.humanRecipe), JSON.stringify({ bolt: s.recipe, human: s.humanRecipe }));
        // The bolt's badge is drawn and Human's is not here, and the badge is 17px in a 16px line: Human's own button
        // grows by that pixel the moment it counts something, which is why this is "within a pixel" and the
        // both-badges case below is "exactly".
        ok("the same height as Human, to the pixel its hidden badge accounts for", Math.abs(s.box.h - s.humanBox.h) <= 1, `bolt ${s.box.h} vs human ${s.humanBox.h}`);
        ok("on the same row as Human", Math.abs(s.box.y + s.box.h / 2 - (s.humanBox.y + s.humanBox.h / 2)) <= 1, JSON.stringify({ bolt: s.box, human: s.humanBox }));
        ok("immediately beside it, in the flex gap", s.box.x < s.penBox.x && s.penBox.x - (s.box.x + s.box.w) <= 12, `gap ${s.penBox.x - (s.box.x + s.box.w)}px`);
        ok("its tooltip names the agent and says what the press does", /the lightning bolt/.test(s.title) && /Click to land on the next one/.test(s.title), s.title.slice(0, 120));
        ok("its aria-label counts the agents", /1 working right now/.test(s.aria), s.aria);

        if (SHOT_DIR) {
          await page.screenshot({ path: path.join(shots, "hot-mark-header-1440x900.png") });
          const box = await page.locator("header.topbar").boundingBox();
          await page.screenshot({
            path: path.join(shots, "hot-mark-header-crop-1440x900.png"),
            clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(1440, box.width), height: Math.min(900, box.height) },
          });
        }
        ok("the viewport the proof is taken at is 1440x900", (await page.viewportSize()).width === 1440 && (await page.viewportSize()).height === 900);

        // ---- 4. two working agents -------------------------------------------------------------------------------
        section("two working agents");
        await seed([HOT_ONE, HOT_TWO]);
        s = await hotState();
        eq("the badge counts them", s.badge, "2");
        ok("the tooltip names both", /the lightning bolt/.test(s.title) && /the header job/.test(s.title), s.title.slice(0, 160));
        ok("...and says two agents", /2 agents working right now/.test(s.title));

        // ---- 5. the press lands on the next one -------------------------------------------------------------------
        section("the press");
        await page.locator("#btn-hot").click();
        await page.waitForTimeout(400);
        s = await hotState();
        eq("the label steps into the rotation", s.label, "⚡ Active 1/2");
        eq("the rotation remembers the agent", s.key, "hot-one");
        const landed = await page.evaluate(() => ({
          jumped: [...document.querySelectorAll(".job.jump")].map((el) => el.dataset.thread),
          banner: document.querySelector(".banner")?.textContent || "",
        }));
        ok("the agent's card is flashed", landed.jumped.includes("hot-one"), JSON.stringify(landed.jumped));
        ok("the banner says which agent it landed on", /landing on the lightning bolt/.test(landed.banner), landed.banner.slice(0, 120));
        if (SHOT_DIR) await page.screenshot({ path: path.join(shots, "hot-mark-press-1440x900.png") });

        await page.locator("#btn-hot").click();
        await page.waitForTimeout(400);
        s = await hotState();
        eq("a second press steps to the other agent", s.label, "⚡ Active 2/2");
        eq("...and remembers that one", s.key, "hot-two");

        // ---- 6. the work ends, the bolt goes ---------------------------------------------------------------------
        section("the work ends");
        await seed([DONE_ONE, DONE_TWO]);
        s = await hotState();
        ok("the bolt is gone again", s.hidden === true && s.drawn === false, JSON.stringify({ hidden: s.hidden, drawn: s.drawn }));

        await seed([PARKED, HOT_TWO]);
        s = await hotState();
        eq("a parked run beside a working one is still only Human's", s.humanBadge, "1");
        eq("...and the bolt counts the working agent alone", s.badge, "1");
        eq("with both badges drawn the two buttons are the same box, exactly", [s.box.h, s.box.y], [s.humanBox.h, s.humanBox.y]);

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
    harness: "tools/verify-hot-mark.mjs",
    viewport: "1440x900",
    shots: ["hot-mark-header-1440x900.png", "hot-mark-header-crop-1440x900.png", "hot-mark-press-1440x900.png"],
    checks,
    failures,
    at: new Date().toISOString(),
  };
  writeFileSync(path.join(shots, "run.json"), JSON.stringify(shotsRun, null, 1));
}
console.log(`\n${checks - failures} of ${checks} checks passed${SHOT_DIR ? `; shots in ${shots}` : ""}`);
process.exit(failures ? 1 : 0);
