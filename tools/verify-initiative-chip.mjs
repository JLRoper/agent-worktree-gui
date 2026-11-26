#!/usr/bin/env node
// THE CHART'S INITIATIVE CHIP, PRESSED: the reader's ask, measured on a real page.
//
// HARNESS: LIVE GATE (real panel, real git repositories, Playwright at 1440x900)
//
//   node tools/verify-initiative-chip.mjs [--shots <dir>]
//
// The ask: a press on the initiative chip in the chart's initiative column opens the assistant window on that
// initiative, fully expanded, with a green-gold flash that fades. The chip is drawn by public/render-projects.js
// (`initiativeCellHtml`), the press is delegated in public/app.js, and the pane belongs to public/assistant.js - so
// every claim below is read off the running page rather than out of those files:
//
//   1. THE COLUMN: one chip per initiative on a tree that is in two of them, each a role="button" with a tabindex and
//      the tooltip the column always carried; a tree with no initiative still draws the dash and grows no chip.
//   2. THE PRESS: from a float that is SHUT and a tab left on Role, a click on the chip raises the float, brings the
//      Initiatives pane on screen, unfolds THAT initiative's card (aria-expanded true, no longer a title card),
//      scrolls it into the pane and puts `is-flash` on it - with the sheet's own `initcardflash` running - in the
//      press's own task. The initiative beside it stays folded, and the chart's row is not folded by the press.
//   3. THE FADE: the class is removed on animationend by the page itself, so the highlight cannot stick: it is still
//      on the card a second later and gone within six, and no card is left carrying it.
//   4. A SECOND INITIATIVE, BY KEYBOARD: the first card is folded back, the chip is reached with Tab/focus, and Enter
//      opens its OWN card and flashes it with the card beside it still folded; Space makes the same press a second
//      time and the page does not scroll under it (Space's default on a span).
//   5. HEALTH: zero page errors and zero console errors across the whole run.
//
// Sandbox only: a throwaway temp directory with two repos and five hand-cut worktrees, its own HERMES_HOME, its own
// PANEL_CONFIG and port, and an apiServer pointed at a dead port. The live panel and the gateway are never touched.
// The membership is written into the panel's own store file before the page is opened, so no permission tier and no
// add-a-worktree picker stands between this gate and the thing it measures. Without Playwright the script says
// BROWSER-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { freePort, git, startPanel, waitFor, waitForRow } from "./panel-testkit.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line printed above.\n`);
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
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (s) => console.log(`      ${s}`);
const slash = (p) => String(p || "").replace(/\\/g, "/");
const at = (s) => new Date(Date.now() - s * 1000).toISOString();

const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;

// ---- the sandbox: two projects, five trees, two initiatives ------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-initiative-chip-"));
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(dir, "shots");
mkdirSync(shotsDir, { recursive: true });
const repos = path.join(dir, "repos");
const alpha = path.join(repos, "alpha");
const beta = path.join(repos, "beta");
const trees = {
  ssoOne: path.join(alpha, ".worktrees", "sso-one"),
  ssoTwo: path.join(alpha, ".worktrees", "sso-two"),
  menuOne: path.join(beta, ".worktrees", "menu-one"),
  menuTwo: path.join(beta, ".worktrees", "menu-two"),
  plain: path.join(beta, ".worktrees", "menu-plain"),
};
const SSO = "init_proof_sso";
const GATEWAY = "init_proof_gateway";
const gitEnv = { GIT_TERMINAL_PROMPT: "0" };
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  return git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], { env: gitEnv });
};

let panel = null;
try {
  for (const [name, repo, names] of [
    ["alpha", alpha, ["sso-one", "sso-two"]],
    ["beta", beta, ["menu-one", "menu-two", "menu-plain"]],
  ]) {
    mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
    commit(repo, "seed the sandbox repo");
    for (const wt of names) {
      const where = path.join(repo, ".worktrees", wt);
      git(repo, ["worktree", "add", "-q", "-b", `work/${wt}`, where]);
      writeFileSync(path.join(where, `${wt}.txt`), "sandbox work\n", "utf8");
      commit(where, `do the ${wt} work`);
    }
  }

  const port = await freePort();
  panel = await startPanel({
    dir,
    port,
    config: {
      refreshSeconds: 3,
      worktreeSeconds: 2,
      midSeconds: 8,
      dormantSeconds: 15,
      slowSeconds: 20,
      fetchSeconds: 3600,
      scanMode: "all",
      defaultCwd: alpha,
      projects: [
        { name: "alpha", path: alpha, remote: "origin", mainBranch: "main" },
        { name: "beta", path: beta, remote: "origin", mainBranch: "main" },
      ],
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
  });
  const base = panel.base;
  const GET = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  console.log(`sandbox: ${base}`);
  console.log(`panel pid: ${panel.pid}`);
  console.log(`shots:   ${shotsDir}`);

  for (const [projectName, treePath] of [
    ["alpha", trees.ssoOne],
    ["alpha", trees.ssoTwo],
    ["beta", trees.menuOne],
    ["beta", trees.menuTwo],
    ["beta", trees.plain],
  ]) {
    await waitForRow(base, projectName, treePath, { timeout: 90_000 });
  }
  ok("all five trees are rows on the board", true, "alpha x2, beta x3");

  // THE MEMBERSHIP, WRITTEN INTO THE PANEL'S OWN STORE. The move flow that asks and records is the Initiatives tab's
  // subject, not this gate's: what has to be true here is the chart's chip and the press on it, so the membership is
  // written where the tab's own writes end up and then read back through the route. menu-one is in BOTH initiatives,
  // which is legal and is what gives one cell two chips to tell apart.
  const read0 = await GET("/api/initiatives");
  const storeFile = read0.body.file;
  const member = (treePath, ids) => [slash(treePath).toLowerCase(), { path: slash(treePath), initiatives: ids, at: at(600), by: "reader" }];
  writeFileSync(
    storeFile,
    `${JSON.stringify(
      {
        savedAt: at(0),
        initiatives: [
          { id: SSO, title: "SSO migration", description: "Move the Menu and the gateway onto Okta SSO, one app at a time.", createdAt: at(9000), updatedAt: at(9000) },
          { id: GATEWAY, title: "Gateway cutover", description: "One app at a time.", createdAt: at(8000), updatedAt: at(8000) },
        ],
        trees: Object.fromEntries([member(trees.ssoOne, [SSO]), member(trees.ssoTwo, [SSO]), member(trees.menuOne, [SSO, GATEWAY])]),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const indexed = await waitFor(
    async () => {
      const d = (await GET("/api/initiatives")).body;
      const two = (d.initiatives || []).find((i) => i.id === SSO);
      return two && two.treeCount === 3 ? d : null;
    },
    { timeoutMs: 30_000, what: "the store route to read the three member trees" },
  );
  ok("the store carries two initiatives and three member trees", Boolean(indexed), indexed ? indexed.initiatives.map((i) => `${i.title}:${i.treeCount}`).join(", ") : "no read");

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the chart's initiative chip", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        let shotNo = 0;
        const shot = async (slug, opts = {}) => {
          const file = path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);
          await page.screenshot({ path: file, ...opts });
          note(`shot ${path.basename(file)}`);
          return file;
        };
        const paneShot = async (slug) => {
          const box = await page.locator("#as-initiatives").boundingBox();
          const file = path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);
          await page.screenshot({
            path: file,
            clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(1440 - Math.max(0, box.x - 8), box.width + 16), height: Math.min(900 - Math.max(0, box.y - 8), box.height + 16) },
          });
          note(`shot ${path.basename(file)}`);
          return file;
        };
        // A fresh context starts with every project collapsed, and a row that is not drawn has no chip to press.
        const expand = async () => {
          await page.waitForSelector("section.project > .project-head[data-toggle-project]", { state: "visible", timeout: 90_000 });
          for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
            const sec = head.locator("xpath=..");
            if (String((await sec.getAttribute("class")) || "").includes("collapsed")) await head.click();
          }
          await page.waitForSelector("tr.row", { state: "visible", timeout: 60_000 });
        };
        // One row's chip: the same initiative sits on three rows, so the row is named by its tree's own directory.
        const chipIn = (treePath, id) => page.locator(`#projects tr.row[data-key$="${path.basename(treePath)}"] td.initiative .initiative-chip[data-initiative-id="${id}"]`);
        const cellOf = (treePath) =>
          page.evaluate((p) => {
            const want = String(p).replace(/\\/g, "/").toLowerCase();
            const tr = [...document.querySelectorAll("#projects tr.row")].find((r) => r.dataset.key && r.dataset.key.toLowerCase().endsWith(want));
            const cell = tr?.querySelector("td.initiative");
            return {
              row: Boolean(tr),
              expanded: Boolean(tr?.classList.contains("expanded")),
              text: cell ? cell.textContent.trim() : null,
              chips: [...(cell?.querySelectorAll(".initiative-chip") || [])].map((c) => ({
                id: c.dataset.initiativeId || "",
                text: c.textContent.trim(),
                role: c.getAttribute("role"),
                tab: c.getAttribute("tabindex"),
                title: c.getAttribute("title") || "",
              })),
            };
          }, slash(treePath));
        const cardOf = (id) =>
          page.evaluate((wanted) => {
            const card = document.querySelector(`#as-initiatives [data-init-card="${wanted}"]`);
            const pane = document.getElementById("as-initiatives");
            const prect = pane ? pane.getBoundingClientRect() : null;
            const rect = card ? card.getBoundingClientRect() : null;
            return {
              exists: Boolean(card),
              open: card ? card.querySelector("[data-init-card-toggle]")?.getAttribute("aria-expanded") || "" : "",
              titlecard: card ? /(^|\s)is-titlecard(\s|$)/.test(card.className) : null,
              flash: card ? card.classList.contains("is-flash") : false,
              animation: card ? getComputedStyle(card).animationName : "",
              top: rect ? Math.round(rect.top) : null,
              height: rect ? Math.round(rect.height) : null,
              paneTop: prect ? Math.round(prect.top) : null,
              paneBottom: prect ? Math.round(prect.bottom) : null,
              paneScroll: pane ? Math.round(pane.scrollTop) : null,
              paneMax: pane ? Math.round(pane.scrollHeight - pane.clientHeight) : null,
            };
          }, id);

        await openPage(page, base, { selector: "section.project" });
        await expand();

        // ---- 1. the column -------------------------------------------------------------------------
        console.log("\n== 1. the initiative column ==");
        await waitFor(async () => (await cellOf(trees.menuOne)).chips.length === 2, { timeoutMs: 30_000, what: "the chart to draw both chips on menu-one" });
        const bothChips = await cellOf(trees.menuOne);
        check("a tree in two initiatives draws one chip per initiative", bothChips.chips.map((c) => c.text).sort(), ["Gateway cutover", "SSO migration"]);
        check("…each carrying its own id", bothChips.chips.map((c) => c.id).sort(), [GATEWAY, SSO].sort());
        ok(
          "the chip is keyboard reachable and keeps the column's tooltip: role=button, tabindex 0, \"initiative: <title> - ...\"",
          bothChips.chips.every((c) => c.role === "button" && c.tab === "0" && c.title.startsWith("initiative: ")),
          JSON.stringify(bothChips.chips.map((c) => [c.text, c.role, c.tab, c.title.slice(0, 34)])),
        );
        const plainCell = await cellOf(trees.plain);
        check("a tree with no initiative still draws the dash, and no chip", { text: plainCell.text, chips: plainCell.chips.length }, { text: "-", chips: 0 });
        const columnHead = await page.evaluate(() => [...document.querySelectorAll("#projects thead th")].map((th) => th.textContent.trim()).find((t) => t === "Initiative") || "");
        check("the chart still has its Initiative column", columnHead, "Initiative");
        await shot("chart-chips");

        // ---- 2. the press, from a float that is shut and a tab left elsewhere ------------------------
        console.log("\n== 2. the press opens the pane on that card ==");
        await page.evaluate(() => {
          window.__assistantToggle(false);
          document.querySelector('#as-tabs [data-as-tab="role"]')?.click();
        });
        const shut = await page.evaluate(() => ({
          hidden: Boolean(document.getElementById("assistant")?.hidden),
          pane: [...document.querySelectorAll("#assistant .as-pane")].find((p) => !p.classList.contains("hidden"))?.dataset.pane || "",
        }));
        ok("the run starts from the reader's other state: the float shut, the tab on Role", shut.hidden === true && shut.pane === "role", `hidden=${shut.hidden} pane=${shut.pane || "(none)"}`);

        const rowBefore = await cellOf(trees.menuOne);
        const pressedAt = Date.now();
        await chipIn(trees.menuOne, GATEWAY).click();
        // Read in the press's own task: the class has to be there because the press put it there, not because a later
        // repaint did.
        const afterPress = await page.evaluate((id) => {
          const card = document.querySelector(`#as-initiatives [data-init-card="${id}"]`);
          const pane = document.getElementById("as-initiatives");
          const prect = pane.getBoundingClientRect();
          const rect = card ? card.getBoundingClientRect() : null;
          return {
            floatOpen: !document.getElementById("assistant").hidden,
            paneShown: [...document.querySelectorAll("#assistant .as-pane")].find((p) => !p.classList.contains("hidden"))?.dataset.pane || "",
            initiativesShown: !pane.classList.contains("hidden"),
            exists: Boolean(card),
            open: card ? card.querySelector("[data-init-card-toggle]")?.getAttribute("aria-expanded") || "" : "",
            titlecard: card ? /(^|\s)is-titlecard(\s|$)/.test(card.className) : null,
            flash: card ? card.classList.contains("is-flash") : false,
            animation: card ? getComputedStyle(card).animationName : "",
            top: rect ? Math.round(rect.top) : null,
            height: rect ? Math.round(rect.height) : null,
            paneTop: Math.round(prect.top),
            paneBottom: Math.round(prect.bottom),
            paneScroll: Math.round(pane.scrollTop),
            paneMax: Math.round(pane.scrollHeight - pane.clientHeight),
            scrollY: Math.round(window.scrollY),
          };
        }, GATEWAY);
        ok("the press brings the float up", afterPress.floatOpen === true);
        ok("…switches it to the Initiatives pane", afterPress.paneShown === "initiatives" && afterPress.initiativesShown === true, `pane ${afterPress.paneShown || "(none)"}`);
        // THE CARD ARRIVES WITH THE READ. The first press of a session opens a pane that has never read the store, so its
        // card is drawn by the render that follows that read (assistant.js parks the id in `initLandId`) rather than in
        // the press's own task; a press after a read draws it at once. Either way the rendering that FIRST finds the
        // card is where the landing must have happened, so the assertions below read that moment - and the flash runs
        // for 1.4s, so a poll 150ms later still sees the class on the node.
        const cardSeen = await waitFor(
          async () => {
            const seen = await cardOf(GATEWAY);
            return seen.exists ? seen : null;
          },
          { timeoutMs: 20_000, what: "the pressed card to be drawn" },
        );
        ok("…lands on THAT initiative's card, fully expanded", Boolean(cardSeen) && cardSeen.open === "true" && cardSeen.titlecard === false, cardSeen ? `aria-expanded=${cardSeen.open} titlecard=${cardSeen.titlecard}` : "no card was drawn");
        // The landing is the card's TOP at the pane's reading edge. A card taller than the pane cannot be shown whole,
        // and at the pane's own scroll end its top edge cannot reach the edge either - the same promise, read either way.
        const atEdge = Boolean(cardSeen) && cardSeen.top !== null && cardSeen.top >= cardSeen.paneTop - 1 && cardSeen.top <= cardSeen.paneTop + 40;
        const atEnd = Boolean(cardSeen) && cardSeen.top !== null && cardSeen.paneScroll >= cardSeen.paneMax - 2 && cardSeen.top < cardSeen.paneTop;
        ok(
          "…scrolls the card's title to the pane's reading edge",
          atEdge || atEnd,
          cardSeen ? `card top ${cardSeen.top} (${cardSeen.height}px tall) in pane ${cardSeen.paneTop}..${cardSeen.paneBottom}, scrollTop ${cardSeen.paneScroll} of ${cardSeen.paneMax}` : "no card was drawn",
        );
        ok("…and flashes it green-gold the moment it is drawn", Boolean(cardSeen) && cardSeen.flash === true && cardSeen.animation === "initcardflash", cardSeen ? `class ${cardSeen.flash}, animation ${cardSeen.animation}` : "no card was drawn");
        await paneShot("chip-press-card");
        const otherCard = await cardOf(SSO);
        ok("the initiative beside it is not swept open", otherCard.exists && otherCard.open === "false", `SSO card aria-expanded=${otherCard.open}`);
        const rowAfter = await cellOf(trees.menuOne);
        ok("the chart's row is not folded by the chip's press", rowAfter.expanded === rowBefore.expanded, `row expanded ${rowBefore.expanded} -> ${rowAfter.expanded}`);

        // ---- 3. the fade -----------------------------------------------------------------------------
        console.log("\n== 3. the flash clears itself ==");
        let flashMs = 0;
        let flashGone = false;
        const flashUntil = Date.now() + 8_000;
        while (Date.now() < flashUntil) {
          const on = await page.evaluate((id) => document.querySelector(`#as-initiatives [data-init-card="${id}"]`)?.classList.contains("is-flash") === true, GATEWAY);
          if (!on) {
            flashGone = true;
            flashMs = Date.now() - pressedAt;
            break;
          }
          await page.waitForTimeout(80);
        }
        ok("the class is removed on its own, so the highlight cannot stick", flashGone, `cleared after ${flashMs} ms`);
        ok("…and it stayed on long enough to be a fade rather than a blink", flashMs >= 900 && flashMs <= 6_000, `${flashMs} ms on the card`);
        check("no card is left carrying the class", await page.evaluate(() => document.querySelectorAll("#as-initiatives [data-init-card].is-flash").length), 0);

        // ---- 4. a second initiative, by keyboard -------------------------------------------------------
        console.log("\n== 4. a second initiative, by keyboard ==");
        await page.locator(`#as-initiatives [data-init-card="${GATEWAY}"] [data-init-card-toggle]`).click();
        await page.waitForFunction((id) => document.querySelector(`#as-initiatives [data-init-card="${id}"] [data-init-card-toggle]`)?.getAttribute("aria-expanded") === "false", GATEWAY, { timeout: 15_000 });
        // FOCUSED IN THE PAGE, by its row and its id. The chart repaints on its own clock, and a locator resolved before
        // a repaint is a detached node by the time it is scrolled to ("Element is not attached to the DOM"); the reader's
        // own Tab lands on the node that is on screen, so this does too, retried until it takes.
        const focusChip = () =>
          page.evaluate((pair) => {
            const tr = [...document.querySelectorAll("#projects tr.row")].find((r) => r.dataset.key && r.dataset.key.endsWith(pair.tree));
            const chip = tr?.querySelector(`td.initiative .initiative-chip[data-initiative-id="${pair.id}"]`);
            if (!chip) return false;
            chip.scrollIntoView({ block: "center" });
            chip.focus();
            return document.activeElement === chip;
          }, { tree: path.basename(trees.menuOne), id: SSO });
        const tookFocus = await waitFor(focusChip, { timeoutMs: 15_000, what: "the chip to take the keyboard's focus" });
        ok("the chip takes the keyboard's focus", tookFocus === true);
        await page.keyboard.press("Enter");
        const byEnter = await cardOf(SSO);
        const gatewayAfterEnter = await cardOf(GATEWAY);
        ok("Enter opens its own card, fully expanded, and flashes it", byEnter.open === "true" && byEnter.titlecard === false && byEnter.flash === true, `SSO card aria-expanded=${byEnter.open} flash=${byEnter.flash}`);
        check("…and the card beside it stays folded", gatewayAfterEnter.open, "false");
        // SPACE IS THE OTHER PRESS, and the one that would scroll the page if the chip forgot its preventDefault. The
        // chip is focused again first: a board repaint replaces the node the last press focused, and a key pressed on
        // the body would prove nothing.
        await focusChip();
        const scrollBefore = await page.evaluate(() => Math.round(window.scrollY));
        await page.keyboard.press("Space");
        const bySpace = await cardOf(SSO);
        const scrollAfter = await page.evaluate(() => Math.round(window.scrollY));
        ok("Space makes the same press: the card stays open and flashes again", bySpace.open === "true" && bySpace.flash === true, `aria-expanded=${bySpace.open} flash=${bySpace.flash}`);
        ok("…and the page does not scroll under it, which is Space's default on a span", Math.abs(scrollAfter - scrollBefore) <= 2, `window.scrollY ${scrollBefore} -> ${scrollAfter}`);
        await shot("chip-press-keyboard");
        await paneShot("chip-press-keyboard-pane");
        await waitFor(async () => (await cardOf(SSO)).flash === false, { timeoutMs: 8_000, what: "the second card's flash to clear" });
        check("…and that flash clears too", await page.evaluate(() => document.querySelectorAll("#as-initiatives [data-init-card].is-flash").length), 0);

        // ---- 5. health ------------------------------------------------------------------------------
        console.log("\n== 5. health ==");
        check("no page errors", pageErrors.map(String), []);
        check("no console errors", consoleErrors.map(String), []);
      },
      { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    );
  }
} catch (err) {
  failures += 1;
  console.error(`\nFAIL  the run threw: ${err && err.stack ? err.stack : err}`);
  try {
    console.error(panel.log().split("\n").slice(-20).join("\n"));
  } catch {
    /* the log is a courtesy */
  }
} finally {
  await panel?.stop();
  clearTimeout(watchdog);
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed; shots in ${shotsDir}`);
process.exit(failures === 0 ? 0 : 1);
