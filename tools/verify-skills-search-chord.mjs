// HARNESS: LIVE GATE - tracks main; run it by name with `npm run verify:skills-search-chord`.
//
// Ctrl+Shift+S, driven by the KEYBOARD ALONE, in headless Chromium at 1440x900.
//
// WHAT IT PROVES, in the order a reader meets it:
//
//   0. IT SWITCHES A WINDOW THAT IS ALREADY OPEN. Settings on Display, nothing typed, one press: the Skills tab is
//      selected and `document.activeElement` is the tab's own bar. The browser's Save-As never opens (the keydown is
//      defaultPrevented, read from a listener registered after the page's own).
//   1. IT OPENS A CLOSED WINDOW, FROM A BOARD ROW. Settings dismissed, the caret on the board, one press: the window
//      is on screen, on Skills, with the caret in the bar.
//   2. IT OPENS FROM A RUN'S CONSOLE, and from the assistant's queue pane - two more hosts that are not the board.
//   3. THE BAR IS THE ONE FILTER. Typing `kafka` leaves exactly one skill row visible, the row whose name carries it;
//      the box in the window's head holds the SAME text (one query, two controls, no second opinion); the Skills tab
//      badge counts 1.
//   4. ESCAPE CLEARS AND KEEPS THE CARET. All four rows are back, the bar is empty and still focused, and Settings is
//      still open - the first Escape was about what was typed.
//   5. NO HITS SAYS SO. A word no skill carries leaves zero rows and one plain sentence naming the word.
//   6. IT DOES NOTHING IN A COMPOSER. With the caret in the assistant's own contenteditable, the chord leaves
//      Settings shut and the caret where it was; a capital S typed there lands in the composer, not in a search bar.
//   7. THE OTHER TWO CHORDS STILL WORK: Ctrl+Shift+A opens the assistant, Ctrl+Shift+Q opens the Hot Agent search
//      with its own box focused.
//
// HOW TO RUN:  node tools/verify-skills-search-chord.mjs
//              node tools/verify-skills-search-chord.mjs --out <dir>   (defaults to docs/assets/skills-search-chord)
//              node tools/verify-skills-search-chord.mjs --keep         (leave the sandbox store behind)
//
// The skills inventory is the one thing stubbed: `page.route` answers /api/settings/skills with a four-skill fixture
// so the filter's counts are a fact of this file and not of whatever is installed on the machine. Everything else -
// the server, the board, the job card, the assistant pane - is the real page.
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, configureRepo, createVerifier, git, ran, startPanel } from "./panel-testkit.mjs";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const keep = argv.includes("--keep");
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "skills-search-chord"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-skills-search-chord-sandbox"));
mkdirSync(outDir, { recursive: true });
mkdirSync(dir, { recursive: true });

const PROJECT = "skills-project";
const repo = path.join(dir, "repos", PROJECT);
mkdirSync(repo, { recursive: true });
if (!ran(repo, "rev-parse", "--git-dir")) {
  git(repo, "init", "-q", "-b", "main");
  configureRepo(repo, { name: "Skills Chord Verify" });
  writeFileSync(path.join(repo, "README.md"), "# skills chord\n", "utf8");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "the skills chord fixture");
}

// ---- the one job card, so a run's CONSOLE is a place the chord can be pressed from -----------------------------
const tree = { path: repo, branch: "main", exists: true, pending: false };
const job = {
  id: "skills-chord-run",
  thread: "wtgui-skills-chord",
  turn: 1,
  title: "skills chord fixture",
  status: "done",
  startedAt: new Date(Date.UTC(2026, 10, 24, 9, 0, 0)).toISOString(),
  endedAt: new Date(Date.UTC(2026, 10, 24, 9, 1, 0)).toISOString(),
  prompt: "draw a console the chord can be pressed from",
  projectPath: repo,
  ownerPath: repo,
  tree,
  branch: "main",
  assistant: false,
  reply: false,
  origin: null,
  lines: [{ kind: "text", text: "console line one - a run's own output, and not a text field" }],
};
mkdirSync(path.join(dir, "logs"), { recursive: true });
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ version: 3, savedAt: new Date().toISOString(), jobs: [job] }, null, 1), "utf8");
writeFileSync(
  path.join(dir, "logs", "assistants.json"),
  JSON.stringify({ version: 2, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant" }] }, null, 1),
  "utf8",
);

// ---- the skills inventory the tab filters, as a fixture --------------------------------------------------------
// The fixture's own folder, under this run's sandbox: the row tooltips name a path that exists for this run and for
// nobody else, which is the same rule the absolute-path gate holds every landing to.
const fixtureRoot = path.join(dir, "skills");
const skill = (source, sourceLabel, name, description, category) => ({
  source,
  sourceLabel,
  name,
  description,
  category,
  rel: `${category}/${name}/SKILL.md`,
  path: path.join(fixtureRoot, source, category, name, "SKILL.md").split("\\").join("/"),
  served: true,
  isLink: false,
});
const SKILLS = {
  checkedAt: new Date().toISOString(),
  sources: [
    { key: "alpha", label: "Alpha profile", kind: "profile", path: path.join(fixtureRoot, "alpha").split("\\").join("/"), status: "ok", target: null, isLink: false },
    { key: "beta", label: "Beta project", kind: "project", path: path.join(fixtureRoot, "beta").split("\\").join("/"), status: "ok", target: null, isLink: false },
  ],
  skills: [
    skill("alpha", "Alpha profile", "alpha-deploy", "ship the alpha build to dev", "ship"),
    skill("alpha", "Alpha profile", "alpha-audit", "audit a branch before it lands", "review"),
    skill("beta", "Beta project", "beta-kafka", "read kafka topics and their offsets", "data"),
    skill("beta", "Beta project", "beta-review", "review a pull request end to end", "review"),
  ],
  counts: { rows: 4, sources: 2, duplicates: 0, served: 4, unserved: 0, gatewayOnly: 0 },
  gateway: { ok: true, url: "http://stub.invalid", count: 4, reason: null },
};

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no playwright on this machine, so nothing was checked in a page");
  process.exit(2);
}

const v = createVerifier();
const record = { checks: [], screenshots: [], steps: [] };
const panel = await startPanel({ root: ROOT, dir, keep });
console.log(`panel: ${panel.base} (sandbox ${dir})`);

try {
  await withBrowser(
    async ({ page }) => {
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));
      const shoot = async (name) => {
        const file = path.join(outDir, `${name}-1440x900.png`);
        await page.screenshot({ path: file });
        record.screenshots.push(path.relative(ROOT, file).split("\\").join("/"));
      };
      // The keydown is read AFTER the page's own handlers (registered later on the same window), so `prevented`
      // says what the page did with the key rather than what the browser would have.
      const watchChord = () =>
        page.evaluate(() => {
          window.__chordLog = [];
          window.addEventListener("keydown", (e) => {
            if (e.ctrlKey && e.shiftKey && (e.key === "s" || e.key === "S" || e.code === "KeyS")) {
              window.__chordLog.push({ prevented: e.defaultPrevented, repeat: e.repeat, key: e.key, code: e.code, target: e.target?.id || e.target?.className || e.target?.tagName });
            }
          });
        });
      const state = () =>
        page.evaluate(() => {
          const panel = document.getElementById("settings");
          const bar = document.getElementById("skills-search");
          const tab = document.getElementById("settings-tab-skills");
          const rows = [...document.querySelectorAll("#settings-panel-skills .settings-row.skills-skill")];
          const visible = rows.filter((n) => n.getClientRects().length > 0 && !n.classList.contains("search-hidden"));
          const none = document.getElementById("skills-no-hits");
          return {
            settingsOpen: Boolean(panel) && !panel.classList.contains("hidden"),
            tab: tab ? tab.getAttribute("aria-selected") : null,
            selectedTab: document.querySelector("#settings-tabs [data-settings-tab][aria-selected=\"true\"]")?.dataset.settingsTab ?? null,
            skillsPanelShown: Boolean(document.getElementById("settings-panel-skills")) && !document.getElementById("settings-panel-skills").hidden,
            active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
            activeEditable: Boolean(document.activeElement && document.activeElement.isContentEditable),
            barValue: bar ? bar.value : null,
            barPlaceholder: bar ? bar.getAttribute("placeholder") : null,
            headValue: document.getElementById("settings-search")?.value ?? null,
            rows: rows.length,
            visible: visible.map((n) => n.dataset.skill),
            noneHidden: none ? none.hidden : null,
            noneText: none ? none.textContent : null,
            skillsBadge: tab ? tab.querySelector(".settings-tab-count")?.textContent ?? null : null,
            assistantOpen: !document.getElementById("assistant")?.hidden,
            hotOpen: !document.getElementById("ha-search-pop")?.hidden,
            hotFocus: document.activeElement?.id === "ha-search-q",
          };
        });
      const chord = async () => {
        await page.keyboard.press("Control+Shift+s");
        // The window is static markup, but the tab paint and the focus happen in the handler's own turn; one frame
        // is enough, and a longer settle keeps the read off the paint that follows a tab switch.
        await page.waitForTimeout(120);
      };
      const settle = async () => {
        await page.waitForTimeout(350);
        return state();
      };

      await page.route("**/api/settings/skills", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SKILLS) }),
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#projects section.project", { timeout: 30000 });
      // A fresh context opens every project folded; the board row the chord is pressed from is inside it.
      await page.click("#projects .project-head[data-toggle-project]");
      await page.waitForSelector("#projects tr.row", { timeout: 30000 });
      await watchChord();

      // ---- 0. a window already open on another tab ---------------------------------------------------------
      await page.click("#btn-settings");
      await page.waitForSelector("#settings:not(.hidden)", { timeout: 10000 });
      await page.click("#settings-tab-display");
      await page.waitForSelector("#settings-tab-display[aria-selected=\"true\"]", { timeout: 10000 });
      await page.waitForTimeout(200);
      const before = await state();
      v.ok("the window starts on Display, as pressed", before.selectedTab === "display" && before.settingsOpen === true, JSON.stringify({ tab: before.selectedTab, open: before.settingsOpen }));
      await chord();
      const switched = await state();
      v.ok("one press selects Skills", switched.selectedTab === "skills" && switched.tab === "true", JSON.stringify({ tab: switched.selectedTab, skills: switched.tab }));
      v.ok("and shows the Skills panel", switched.skillsPanelShown === true, `shown ${switched.skillsPanelShown}`);
      v.ok("the caret is the tab's own bar", switched.active === "skills-search", `activeElement ${switched.active}`);
      v.ok("the bar's placeholder names what it searches", /name/.test(switched.barPlaceholder || "") && /description/.test(switched.barPlaceholder || ""), JSON.stringify(switched.barPlaceholder));
      const log = await page.evaluate(() => window.__chordLog || []);
      v.ok("the press is swallowed, so the browser's Save-As never opens", log.length >= 1 && log[log.length - 1].prevented === true, JSON.stringify(log));
      record.steps.push({ step: "switch-tab", ...switched, log });
      await shoot("00-switched-to-skills");

      // ---- 1. a closed window, from a board row ------------------------------------------------------------
      await page.keyboard.press("Escape"); // an empty bar hands Esc back: the window closes as it always did
      await page.waitForFunction(() => document.getElementById("settings").classList.contains("hidden"), null, { timeout: 10000 });
      const shut = await state();
      v.ok("Escape on an empty bar closes the window, as before", shut.settingsOpen === false, `open ${shut.settingsOpen}`);
      await page.click("#projects tr.row td.name .row-name");
      const onRow = await page.evaluate(() => document.activeElement?.tagName || null);
      v.ok("the caret is on the board, not in a field", onRow !== "INPUT" && onRow !== "TEXTAREA", `activeElement ${onRow}`);
      await chord();
      const fromRow = await settle();
      v.ok("the press opens the window from a board row", fromRow.settingsOpen === true, `open ${fromRow.settingsOpen}`);
      v.ok("on the Skills tab", fromRow.selectedTab === "skills" && fromRow.tab === "true", `tab ${fromRow.tab}`);
      v.ok("with the caret in the bar", fromRow.active === "skills-search", `activeElement ${fromRow.active}`);
      v.ok("and every skill row is painted", fromRow.visible.length === 4, JSON.stringify(fromRow.visible));
      record.steps.push({ step: "board-row", ...fromRow });
      await shoot("01-opened-from-a-board-row");

      // ---- 2. a HELD chord lands one bar, not one per repeat -------------------------------------------------
      // The caret is in the bar from the press above, and a field is exactly where the chord is inert - so the
      // repeat is proved from the tab button beside it, which is not a text host.
      await page.focus("#settings-tab-skills");
      await page.evaluate(() => {
        window.__openCalls = 0;
        const real = window.__openSkillsSearch;
        window.__openSkillsSearch = (...args) => {
          window.__openCalls += 1;
          return real(...args);
        };
      });
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.down("s");
      await page.waitForTimeout(150);
      await page.keyboard.down("s"); // the key is already down: this keydown carries autoRepeat
      await page.waitForTimeout(150);
      await page.keyboard.up("s");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      const repeats = await page.evaluate(() => ({ calls: window.__openCalls, log: window.__chordLog.map((x) => x.repeat) }));
      v.ok("a held chord opens once: the repeat is refused", repeats.calls === 1 && repeats.log.includes(true), JSON.stringify(repeats));
      // ...and the caret is back in the bar for the filter checks, by the chord rather than by a programmatic focus.
      await page.keyboard.press("Control+Shift+s");
      await page.waitForTimeout(120);

      // ---- 3. the bar is the ONE filter --------------------------------------------------------------------
      await page.keyboard.type("kafka", { delay: 25 });
      const typed = await settle();
      v.ok("typing filters the list to the one skill carrying it", JSON.stringify(typed.visible) === JSON.stringify(["beta-kafka"]), JSON.stringify(typed.visible));
      v.ok("the window's own search box holds the same text", typed.headValue === "kafka", JSON.stringify(typed.headValue));
      v.ok("the bar still holds the caret and the text", typed.barValue === "kafka" && typed.active === "skills-search", JSON.stringify({ value: typed.barValue, active: typed.active }));
      v.ok("the Skills tab counts the one match", typed.skillsBadge === "1", JSON.stringify(typed.skillsBadge));
      v.ok("the bar is never hidden by the filter it drives", await page.evaluate(() => document.querySelector(".skills-search-row")?.getClientRects().length > 0), "the bar is chrome, not a row");
      record.steps.push({ step: "typed", ...typed });
      await shoot("02-typed-kafka");

      // ---- 3. Escape clears and keeps the caret ------------------------------------------------------------
      await page.keyboard.press("Escape");
      const cleared = await settle();
      v.ok("the first Escape clears the bar", cleared.barValue === "", JSON.stringify(cleared.barValue));
      v.ok("and the one query with it", cleared.headValue === "", JSON.stringify(cleared.headValue));
      v.ok("every row is back", cleared.visible.length === 4, JSON.stringify(cleared.visible));
      v.ok("the caret stays in the bar", cleared.active === "skills-search", `activeElement ${cleared.active}`);
      v.ok("Settings is still open", cleared.settingsOpen === true, `open ${cleared.settingsOpen}`);
      record.steps.push({ step: "escape", ...cleared });
      await shoot("03-escape-cleared");

      // ---- 4. no hits says so ------------------------------------------------------------------------------
      await page.keyboard.type("zzzz", { delay: 20 });
      const none = await settle();
      v.ok("a word no skill carries leaves no visible row", none.visible.length === 0, JSON.stringify(none.visible));
      v.ok("and says so in a sentence naming it", none.noneHidden === false && /no skill matches/.test(none.noneText || "") && /zzzz/.test(none.noneText || ""), JSON.stringify({ hidden: none.noneHidden, text: none.noneText }));
      v.ok("the tab badge reads zero rather than nothing", none.skillsBadge === "0", JSON.stringify(none.skillsBadge));
      record.steps.push({ step: "no-hits", ...none });
      await shoot("04-no-hits");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);

      // ---- 5. a run's console ------------------------------------------------------------------------------
      await page.keyboard.press("Escape"); // an empty bar again: close Settings, then open the card's console
      await page.waitForFunction(() => document.getElementById("settings").classList.contains("hidden"), null, { timeout: 10000 });
      const openRow = await page.$("#projects [data-open-row]");
      if (openRow) await openRow.click();
      await page.waitForSelector("#projects .job .job-body", { timeout: 15000 });
      await page.click("#projects .job .job-body");
      const inConsole = await page.evaluate(() => document.activeElement?.tagName || null);
      v.ok("the caret is in the console, not in a field", inConsole !== "INPUT" && inConsole !== "TEXTAREA", `activeElement ${inConsole}`);
      await chord();
      const fromConsole = await settle();
      v.ok("the press opens Skills from a run's console", fromConsole.settingsOpen === true && fromConsole.selectedTab === "skills" && fromConsole.tab === "true", JSON.stringify({ open: fromConsole.settingsOpen, tab: fromConsole.tab }));
      v.ok("with the caret in the bar", fromConsole.active === "skills-search", `activeElement ${fromConsole.active}`);
      record.steps.push({ step: "console", ...fromConsole });
      await shoot("05-opened-from-a-console");

      // ---- 6. the assistant's queue pane --------------------------------------------------------------------
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.getElementById("settings").classList.contains("hidden"), null, { timeout: 10000 });
      await page.keyboard.press("Control+Shift+a");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 10000 });
      await page.click("#as-subtabs [data-as-subtab=\"queue\"]").catch(() => {});
      await page.waitForSelector("#as-queue:not(.hidden)", { timeout: 10000 });
      await page.click("#as-queue");
      const inQueue = await page.evaluate(() => document.activeElement?.tagName || null);
      v.ok("the caret is in the queue pane, not in a field", inQueue !== "INPUT" && inQueue !== "TEXTAREA", `activeElement ${inQueue}`);
      await chord();
      const fromQueue = await settle();
      v.ok("the press opens Skills from the queue pane", fromQueue.settingsOpen === true && fromQueue.selectedTab === "skills" && fromQueue.tab === "true", JSON.stringify({ open: fromQueue.settingsOpen, tab: fromQueue.tab }));
      v.ok("with the caret in the bar", fromQueue.active === "skills-search", `activeElement ${fromQueue.active}`);
      v.ok("the assistant pane is left open behind it", fromQueue.assistantOpen === true, `assistant ${fromQueue.assistantOpen}`);
      record.steps.push({ step: "queue", ...fromQueue });
      await shoot("06-opened-from-the-queue");

      // ---- 7. the chord does NOTHING while the caret is in a composer ---------------------------------------
      await page.keyboard.press("Escape"); // an empty bar: close Settings
      await page.waitForFunction(() => document.getElementById("settings").classList.contains("hidden"), null, { timeout: 10000 });
      await page.click("#as-subtabs [data-as-subtab=\"chat\"]").catch(() => {});
      await page.waitForSelector("#as-chat", { timeout: 10000 });
      const composer = await page.$("#as-chat .chipbox[contenteditable=\"true\"]");
      v.ok("the assistant's composer is there to type into", Boolean(composer), "a contenteditable chipbox");
      const composerId = await page.evaluate(() => document.querySelector("#as-chat .chipbox[contenteditable=\"true\"]")?.id || null);
      if (composer) await composer.click();
      await page.keyboard.type("S", { delay: 30 }); // the capital S the brief is about
      const typedInComposer = await page.evaluate(() => ({
        active: document.activeElement?.className || document.activeElement?.tagName,
        text: document.activeElement?.textContent || "",
      }));
      v.ok("a capital S typed in the composer lands in the composer", /S/.test(typedInComposer.text), JSON.stringify(typedInComposer));
      await chord();
      const guarded = await settle();
      v.ok("the chord does not open Settings from a composer", guarded.settingsOpen === false, `open ${guarded.settingsOpen}`);
      v.ok("and it does not move the caret", guarded.active === composerId && guarded.activeEditable === true, JSON.stringify({ active: guarded.active, composer: composerId, editable: guarded.activeEditable }));
      const afterGuard = await page.evaluate(() => document.activeElement?.textContent || "");
      v.ok("nothing else was typed into the composer either", afterGuard.trim() === "S", JSON.stringify(afterGuard));
      record.steps.push({ step: "composer-guard", ...guarded });
      await shoot("07-composer-guard");

      // ---- 8. the other two chords are unchanged ------------------------------------------------------------
      await page.keyboard.press("Control+Shift+a");
      await page.waitForTimeout(200);
      let other = await state();
      v.ok("Ctrl+Shift+A still toggles the assistant", other.assistantOpen === false, `assistant ${other.assistantOpen}`);
      await page.keyboard.press("Control+Shift+a");
      await page.waitForTimeout(200);
      other = await state();
      v.ok("and back on again", other.assistantOpen === true, `assistant ${other.assistantOpen}`);
      await page.keyboard.press("Control+Shift+q");
      await page.waitForSelector("#ha-search-pop:not([hidden])", { timeout: 15000 });
      other = await settle();
      v.ok("Ctrl+Shift+Q still opens the Hot Agent search", other.hotOpen === true, `open ${other.hotOpen}`);
      v.ok("with its own box focused, not the skills bar", other.hotFocus === true && other.active !== "skills-search", JSON.stringify({ focus: other.hotFocus, active: other.active }));
      record.steps.push({ step: "other-chords", ...other });
      await shoot("08-other-chords");
      await page.keyboard.press("Escape");

      v.ok("no page error was raised", errors.length === 0, errors.slice(0, 3).join(" | "));
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
} finally {
  await panel.stop();
}

record.checks = { total: v.checks, failures: v.failures };
writeFileSync(path.join(outDir, "run.json"), JSON.stringify(record, null, 1), "utf8");
console.log(`${v.checks - v.failures}/${v.checks} checks passed  (${record.screenshots.length} screenshots in ${outDir})`);
process.exit(v.failures === 0 ? 0 : 1);
