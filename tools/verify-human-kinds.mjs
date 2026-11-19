// tools/verify-human-kinds.mjs - the Human button's FOUR SWITCHES, driven in a real browser against a real panel.
// HARNESS: LIVE GATE - it tracks main, and `npm run verify:human-kinds` is how the repo runs it by name.
//
//   node tools/verify-human-kinds.mjs                     # boot a throwaway panel and drive it
//   node tools/verify-human-kinds.mjs --root <tree>        # serve a `git archive` of another build (RED PROOF)
//   node tools/verify-human-kinds.mjs --shots <dir>        # write the screenshots there (default .shots/)
//
// WHAT IT PROVES. Settings > Human carries four switches - Permissions, Clarify questions, Review items, Collisions -
// and the button in the header counts, names and steps exactly the kinds that are on:
//
//   1. all four on, one of each of the three kinds this fixture can seed pending: the badge reads 3 and H steps
//      permissions, then clarify, then review; the fourth switch is on with nothing pending, so it is counted but
//      never named;
//   2. review items off: the badge drops to 2, the title and the aria-label stop naming review, and H steps the two
//      blocking kinds and nothing else;
//   3. permissions off as well: the badge is 1, the split is the clarify question alone, and H lands on it;
//   4. every kind off - collisions included: no badge, a label with no counter, an aria-label that says every kind is
//      off, and H inert - the key opens nothing and says nothing;
//   5. the switches are BROWSER settings: a reload keeps the four of them where the reader left them;
//   6. review items alone, after that reload: the badge is 1 and H steps the one review row, so a single kind is a
//      rotation of its own.
//
// A collision WITH something in it - the markers, the badge, the H landing and the ruling - is proved against two real
// trees in tools/verify-collisions.mjs: this fixture could not seed a live pair without a second worktree, and a
// synthetic one would prove the switch against a row the board does not have.
//
// HOW THE THREE KINDS ARE MADE. The review row is REAL: a git fixture with one worktree, and a delivery recorded
// through the panel's own settle seam (`Jobs.harvestReview` -> lib/review-inbox.js), so the row the button counts is
// the row the board draws. The permission and the clarify question are the page's own job list - the same technique
// tools/verify-hot-mark.mjs uses - seeded through `applyJobSnapshot`, which is where a poll and a stream snapshot both
// land, so the page applies them through its own path and paints from its own clock.
//
// The screenshots are taken at 1440x900, the size the brief names: `human-kinds-header-1440x900.png` is the header
// with the badge at 3, and `human-kinds-settings-1440x900.png` is the Settings group as it renders.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser, openPage } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { Jobs } from "../lib/jobs.js";
import { ReviewInbox } from "../lib/review-inbox.js";

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

// ---- the fixture: a real repo with one worktree carrying a delivery ----------------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-human-kinds-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "kinds-proj");
const git = (args, cwd = repo) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "gate", GIT_AUTHOR_EMAIL: "gate@local", GIT_COMMITTER_NAME: "gate", GIT_COMMITTER_EMAIL: "gate@local" },
  });
mkdirSync(repo, { recursive: true });
git(["init", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# kinds fixture\n");
git(["add", "-A"]);
git(["commit", "-m", "fixture"]);
const TREE_ONE = path.join(repo, ".worktrees", "result-one-ab12cd").replace(/\\/g, "/");
git(["worktree", "add", "-b", "wtgui/result-one-ab12cd", TREE_ONE]);

const STORE = path.join(dir, "logs", "reviews.json");
const store = new ReviewInbox({ file: STORE, log: (m) => console.log(`      store: ${m}`) });
const harness = Object.create(Jobs.prototype);
harness.reviewInbox = store;
harness.push = () => {};
const saved = harness.harvestReview(
  {
    id: "runkinds1",
    thread: "kinds-thread-one",
    project: "kinds-proj",
    status: "done",
    endedAt: "2026-11-18T09:00:00.000Z",
    finalMessage: ["The lane is built and the result is on its row.", "", "The report is docs/reports/kinds.html", "", "## Next steps", "- open the report"].join("\n"),
  },
  { path: TREE_ONE },
);
ok("the settle seam recorded one delivery, awaiting a check", saved?.saved === true && store.count() === 1, `saved ${saved?.saved}, entries ${store.count()}`);

// ---- the two parked runs, in the shape lib/jobs.js writes --------------------------------------------------------
const AT = "2026-11-18T10:00:00.000Z";
const job = (over = {}) => ({
  id: over.name,
  thread: over.name,
  status: "running",
  startedAt: AT,
  model: "verify-human-kinds",
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
const PERMISSION = job({
  name: "gate-permission",
  title: "a run stopped on a command",
  status: "waiting_for_approval",
  approval: { requestId: "req-perm", command: "git push origin HEAD", choices: ["once", "deny"], at: AT, deadline: Date.now() + 30 * 60_000 },
});
const QUESTION = job({
  name: "gate-question",
  title: "a run waiting on a decision",
  status: "waiting",
  startedAt: "2026-11-18T10:05:00.000Z",
  question: { requestId: "req-ask", question: "Which base should this branch use?", choices: ["main", "develop"], at: AT, deadline: Date.now() + 30 * 60_000 },
});
let fixture = [];

const panel = await startPanel({ root: TREE, dir, keep: true, config: { reviewsFile: STORE, assistant: { enabled: false } } });
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);
const shots = path.resolve(SHOT_DIR);
mkdirSync(shots, { recursive: true });

const result = await (async () => {
  try {
    return await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        // The fixture, in the one place the page takes a job list (the technique tools/verify-hot-mark.mjs uses).
        await page.addInitScript(() => {
          window.__humanKindsFixture = { list: [] };
          const wrap = () => {
            if (typeof applyJobSnapshot !== "function" || applyJobSnapshot.__fixture) return false;
            const original = applyJobSnapshot;
            const wrapped = function () {
              return original(window.__humanKindsFixture.list.map((j) => ({ ...j })));
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

        const seed = async (list) => {
          fixture = list;
          await page.evaluate((next) => {
            window.__humanKindsFixture.list = next;
          }, list);
          await page.evaluate(() => resync());
          await page.waitForTimeout(1400);
        };

        const human = () =>
          page.evaluate(() => {
            const btn = document.getElementById("btn-human");
            const badge = document.getElementById("human-badge");
            const label = document.getElementById("human-label");
            const preview = document.getElementById("human-kinds-preview");
            let list = null;
            let kinds = null;
            let key = null;
            let at = null;
            try {
              list = humanQuestions().map((q) => ({ kind: q.kind, key: q.key }));
              kinds = { ...humanKinds() };
              key = state.human.key;
              at = state.human.at;
            } catch (err) {
              list = [{ error: String(err && err.message ? err.message : err) }];
            }
            return {
              label: (label?.textContent || "").trim(),
              badge: (badge?.textContent || "").trim(),
              badgeHidden: badge ? badge.hidden : null,
              aria: btn?.getAttribute("aria-label") || "",
              title: btn?.title || "",
              hasQuestions: btn ? btn.classList.contains("has-questions") : null,
              kinds,
              key,
              at,
              list,
              preview: (preview?.textContent || "").trim(),
              boxes: ["permissions", "clarify", "review", "collisions"].map((k) => {
                const box = document.getElementById(`human-kind-${k}`);
                return box ? box.checked : null;
              }),
            };
          });

        // H belongs to the reader when a text field holds the caret, so the settings' own checkbox is blurred first:
        // this is a press on the board, not a key typed into a row.
        const pressH = async () => {
          await page.evaluate(() => document.activeElement?.blur?.());
          await page.keyboard.press("h");
          await page.waitForTimeout(220);
          return human();
        };

        // The drawer, open on the Human tab, whether or not it was already open: pressing #btn-settings toggles it.
        const openHumanSettings = async () => {
          const open = await page.evaluate(() => {
            const el = document.getElementById("settings");
            return Boolean(el && !el.classList.contains("hidden"));
          });
          if (!open) await page.click("#btn-settings");
          await page.click("#settings-tab-human");
        };

        await seed([PERMISSION, QUESTION]);
        // The board folds a project by default, so the ROWS are the page's state, not its DOM: `state.rows` is what
        // the snapshot placed and what `humanQuestions` reads, and a row the reader has not unfolded still counts.
        await page.waitForFunction(
          () => {
            try {
              return state.rows.size > 0;
            } catch {
              return false;
            }
          },
          null,
          { timeout: 60_000 },
        );

        // ---- 1. all four on ------------------------------------------------------------------------------
        section("all four on, one of each of the three that can be seeded pending");
        const all = await human();
        eq("the switches default to on", all.kinds, { permissions: true, clarify: true, review: true, collisions: true });
        eq("the tab's boxes are all ticked", all.boxes, [true, true, true, true]);
        eq("the list holds the three kinds that are pending, in the rotation's order", all.list.map((q) => q.kind), ["approval", "question", "review"]);
        eq("the badge is 3", all.badge, "3");
        ok("the badge is drawn and the button is lit", all.badgeHidden === false && all.hasQuestions === true);
        ok("the aria-label splits it three ways", /^Human — 3 waiting on you: 1 permission, 1 clarify question, 1 to review$/.test(all.aria), all.aria);
        ok("the title splits it three ways too", /^Human — 3 waiting on you: 1 permission, 1 clarify question, 1 to review/.test(all.title), all.title.slice(0, 90));
        ok("a reader who never opened the setting is told nothing about switches", !/switched off/.test(all.title) && !/switched off/.test(all.aria));
        await page.screenshot({ path: path.join(shots, "human-kinds-header-1440x900.png") });
        console.log(`SHOT  ${path.join(shots, "human-kinds-header-1440x900.png")}`);

        const step1 = await pressH();
        eq("H steps the permission first", [step1.key?.split(":")[0], step1.label], ["approval", "🙋 Human 1/3"]);
        const step2 = await pressH();
        eq("then the clarify question", [step2.key?.split(":")[0], step2.label], ["question", "🙋 Human 2/3"]);
        const step3 = await pressH();
        eq("then the row to review", [step3.key?.split(":")[0], step3.label], ["review", "🙋 Human 3/3"]);

        // ---- 2. the settings group -----------------------------------------------------------------------
        section("Settings > Human");
        await page.click("#btn-settings");
        await page.click("#settings-tab-human");
        await page.waitForSelector("#human-kind-permissions", { state: "visible", timeout: 10_000 });
        const group = await page.evaluate(() => {
          const panelEl = document.getElementById("settings-panel-human");
          const rows = [...(panelEl?.querySelectorAll("label.settings-row") || [])].map((el) => ({
            text: (el.querySelector("span")?.textContent || "").trim(),
            for: el.getAttribute("for"),
            checked: el.querySelector('input[type="checkbox"]')?.checked,
          }));
          return { visible: Boolean(panelEl && !panelEl.hidden), heading: (panelEl?.querySelector(".settings-row span")?.textContent || "").trim(), rows };
        });
        ok("the group has a tab of its own and is on screen", group.visible === true, JSON.stringify(group.rows.map((r) => r.text)));
        eq("it names its four switches, each labelled and ticked", group.rows.map((r) => [r.text.replace(/\s*ⓘ$/, ""), r.for, r.checked]), [
          ["Permissions", "human-kind-permissions", true],
          ["Clarify questions", "human-kind-clarify", true],
          ["Review items", "human-kind-review", true],
          ["Collisions", "human-kind-collisions", true],
        ]);
        eq("the line under them says all four are counted", (await human()).preview, "all four counted - badge, title and H");
        await page.locator("#settings-panel-human").screenshot({ path: path.join(shots, "human-kinds-settings-group-1440x900.png") });
        await page.screenshot({ path: path.join(shots, "human-kinds-settings-1440x900.png") });
        console.log(`SHOT  ${path.join(shots, "human-kinds-settings-group-1440x900.png")}`);
        console.log(`SHOT  ${path.join(shots, "human-kinds-settings-1440x900.png")}`);

        // ---- 3. review items off -------------------------------------------------------------------------
        section("review items off");
        await page.click("#human-kind-review");
        await page.waitForTimeout(240);
        const noReview = await human();
        eq("the switch is off", [noReview.kinds.review, noReview.boxes], [false, [true, true, false, true]]);
        eq("the badge drops to 2", noReview.badge, "2");
        eq("the review row is out of the rotation", noReview.list.map((q) => q.kind), ["approval", "question"]);
        eq("the aria-label never names review", noReview.aria, "Human — 2 waiting on you: 1 permission, 1 clarify question. Review items are switched off in Settings (Ctrl+,, Human).");
        ok("…and the title neither", !/to review/.test(noReview.title) && /Review items are switched off in Settings/.test(noReview.title), noReview.title.slice(0, 120));
        eq("the line under the switches follows them", noReview.preview, "permissions and clarify questions and collisions counted - review items off");
        const r1 = await pressH();
        eq("H steps the permission", [r1.key?.split(":")[0], r1.label], ["approval", "🙋 Human 1/2"]);
        const r2 = await pressH();
        eq("then the clarify question, and wraps back to the permission", [r2.key?.split(":")[0], r2.label], ["question", "🙋 Human 2/2"]);
        const r3 = await pressH();
        eq("…so the review row is skipped", [r3.key?.split(":")[0], r3.label], ["approval", "🙋 Human 1/2"]);

        // ---- 4. permissions off as well ------------------------------------------------------------------
        section("permissions off as well");
        await page.click("#human-kind-permissions");
        await page.waitForTimeout(240);
        const noPerms = await human();
        eq("the switch is off", [noPerms.kinds.permissions, noPerms.boxes], [false, [false, true, false, true]]);
        eq("the badge drops to 1", noPerms.badge, "1");
        eq("the split is the clarify question alone", noPerms.aria.split(": ")[1], "1 clarify question. Permissions and review items are switched off in Settings (Ctrl+,, Human).");
        ok("…and no permission is named anywhere in it", !/permission,/.test(noPerms.aria) && !/1 permission/.test(noPerms.aria), noPerms.aria);
        const p1 = await pressH();
        eq("H lands on the one question left", [p1.key?.split(":")[0], p1.label], ["question", "🙋 Human 1/1"]);

        // ---- 5. every kind off: the button is quiet and H is inert ---------------------------------------
        section("every kind off");
        await page.click("#human-kind-clarify");
        await page.click("#human-kind-collisions");
        await page.waitForTimeout(240);
        const quiet = await human();
        eq("all four are off", quiet.kinds, { permissions: false, clarify: false, review: false, collisions: false });
        eq("no badge at all", [quiet.badgeHidden, quiet.hasQuestions, quiet.label], [true, false, "🙋 Human"]);
        eq("the rotation is empty", quiet.list, []);
        ok("the aria-label says the kinds are off, not that the board is clear", /every kind of this button is switched off in Settings/.test(quiet.aria), quiet.aria);
        eq("the line under the switches says so too", quiet.preview, "every kind off - no badge, and H does nothing");
        // The previous press's flash lasts 1.9 s: let it go, so "the key left nothing flashed" is about this press.
        await page.waitForTimeout(2100);
        const bannerBefore = await page.evaluate(() => (document.getElementById("banner-text")?.textContent || "").trim());
        const inert = await pressH();
        eq("H opens nothing", [inert.key, inert.at, inert.label], [null, -1, "🙋 Human"]);
        const bannerAfter = await page.evaluate(() => (document.getElementById("banner-text")?.textContent || "").trim());
        eq("…and says nothing about a board it is not reading", bannerAfter, bannerBefore);
        ok("nothing on the page is left flashed by the key", (await page.evaluate(() => document.querySelectorAll(".human-flash").length)) === 0);
        await page.screenshot({ path: path.join(shots, "human-kinds-quiet-1440x900.png") });
        console.log(`SHOT  ${path.join(shots, "human-kinds-quiet-1440x900.png")}`);

        // ---- 6. a browser setting: the reload keeps it ---------------------------------------------------
        section("the reload keeps the switches");
        await page.reload({ waitUntil: "domcontentloaded" });
        await seed([PERMISSION, QUESTION]);
        // The board folds a project by default, so the ROWS are the page's state, not its DOM: `state.rows` is what
        // the snapshot placed and what `humanQuestions` reads, and a row the reader has not unfolded still counts.
        await page.waitForFunction(
          () => {
            try {
              return state.rows.size > 0;
            } catch {
              return false;
            }
          },
          null,
          { timeout: 60_000 },
        );
        const afterReload = await human();
        eq("the four switches are where the reader left them", afterReload.kinds, { permissions: false, clarify: false, review: false, collisions: false });
        eq("…and so are the boxes", afterReload.boxes, [false, false, false, false]);
        eq("the button is still quiet", [afterReload.badgeHidden, afterReload.list.length], [true, 0]);

        // ---- 7. one kind back on: a rotation of its own ---------------------------------------------------
        section("review items alone");
        await page.click("#btn-settings");
        await page.click("#settings-tab-human");
        await page.waitForSelector("#human-kind-review", { state: "visible", timeout: 10_000 });
        await page.click("#human-kind-review");
        await page.waitForTimeout(300);
        const onlyReview = await human();
        eq("the switch is on", [onlyReview.kinds.review, onlyReview.boxes], [true, [false, false, true, false]]);
        eq("the badge counts the review row alone", [onlyReview.badge, onlyReview.list.map((q) => q.kind)], ["1", ["review"]]);
        eq("the split names one kind", onlyReview.aria.split(": ")[1], "1 to review. Permissions, clarify questions and collisions are switched off in Settings (Ctrl+,, Human).");
        const solo = await pressH();
        eq("H steps into it", [solo.key?.split(":")[0], solo.label], ["review", "🙋 Human 1/1"]);

        ok("no page error", pageErrors.length === 0, pageErrors.join(" | "));
        ok("no console error", consoleErrors.length === 0, consoleErrors.join(" | "));
        return failures;
      },
      { viewport: { width: 1440, height: 900 } },
    );
  } catch (err) {
    console.log(`FAIL  the harness itself: ${err && err.stack ? err.stack : err}`);
    failures += 1;
    return failures;
  }
})();

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
