#!/usr/bin/env node
// THE INITIATIVE PERMISSION TIER, DRIVEN AT 1440x900: the same press asked or not asked, four times.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiative-tier.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES. The unit tests pin the decision and the record; this file pins what a reader sees and what the
// store does when the SAME action is taken at each of the four levels, on the real page, in a sandbox of its own:
//
//   1. THE SETTINGS ROW. Settings, Board carries one select with exactly the four levels in the reader's words, it
//      opens on the level in force, its sentence says the level decides only whether the question is asked and that
//      every change is recorded with its actor and time. Choosing a level writes config.json (initiativePermissions),
//      so the choice survives a restart and applies to every browser and every worker.
//   2. THE SAME ACTION AT EVERY LEVEL. Attaching a worktree to an initiative is one press of the card's own form. At
//      "ask me for everything" it parks a card in the dock that names the tree and the initiative and the store does
//      not move; at "ask me only to remove things", "ask me only to remove trees I attached myself" and "need no
//      permission at all" it is made at once with no card at all. The card's shape is the same shared permission box
//      (once/deny), and it grants no remote write.
//   3. THE THIRD LEVEL'S OWN CASE. A tree the reader attached comes out without a question; the same tree, the same
//      reader press, asks when an ASSISTANT attached it - the case that could only be guessed at before the record.
//   4. THE HISTORY FOLD. Behind the initiative there is an accordion that opens on a press, and every row names its
//      actor and its time: the reader's press reads "you", an assistant's reads its id, and both are in one list - the
//      record a removal is judged against, written at every level, including the levels that never ask.
//   5. AN ASSISTANT'S CHANGE IN THAT HISTORY, while the page is open: a worker-role POST (by: "scout") that edits an
//      initiative appears as the newest row after the tab's own Refresh, with its actor and its time.
//   6. HEALTH: zero page errors and zero console errors over the whole run.
//
// Sandbox only: its own throwaway repos, HERMES_HOME, PANEL_CONFIG and port, and an apiServer pointed at a dead port.
// The live panel and gateway are never touched. Without Playwright the script says BROWSER-NOT-RUN and exits 2 rather
// than passing on a half that never ran.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, openSettingsGroup, withBrowser } from "./browser.mjs";
import { ROOT, freePort, git, startPanel, waitFor } from "./panel-testkit.mjs";

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

const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".initiative-tier-shots");

const gitEnv = { GIT_TERMINAL_PROMPT: "0" };
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  return git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], { env: gitEnv });
};

const dir = path.join(ROOT, ".worktrees", ".initiative-tier-sandbox");
rmSync(dir, { recursive: true, force: true });
const repos = path.join(dir, "repos");
mkdirSync(repos, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
const project = path.join(repos, "alpha");
mkdirSync(path.join(project, ".worktrees"), { recursive: true });
git(project, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(project, "README.md"), "# alpha\n", "utf8");
commit(project, "seed the sandbox repo");
// Four trees, one per level's press: the SAME action has to be taken four times without the first one changing the
// tree the next one is about.
const TREE_NAMES = ["tree-one", "tree-two", "tree-three", "tree-four"];
const treePath = (name) => path.join(project, ".worktrees", name);
for (const name of TREE_NAMES) {
  git(project, ["worktree", "add", "-q", "-b", `work/${name}`, treePath(name)]);
  writeFileSync(path.join(treePath(name), `${name}.txt`), "sandbox work\n", "utf8");
  commit(treePath(name), `do the ${name} work`);
}

const port = await freePort();
const panel = await startPanel({
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
    defaultCwd: project,
    projects: [{ name: "alpha", path: project, remote: "origin", mainBranch: "main" }],
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});
const base = panel.base;
const GET = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const POST = async (p, body) => {
  const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const store = async () => (await GET("/api/initiatives")).body;
const readConfig = () => JSON.parse(readFileSync(panel.configPath, "utf8"));
const pendingCards = async () => (await GET("/api/state")).body.remoteWrites?.pending || [];

let shotIndex = 0;
const shotName = (slug) => {
  shotIndex += 1;
  return path.join(shotsDir, `${String(shotIndex).padStart(2, "0")}-${slug}.png`);
};

console.log(`sandbox: ${slash(dir)}`);
console.log(`shots:   ${slash(shotsDir)}`);

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a killed panel's files on Windows; the OS temp is throwaway */
  }
});

let pageErrorsOut = [];
let consoleErrorsOut = [];
const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the initiative permission tier", "playwright is not installed for this node (see tools/browser.mjs)"));
  failures += 1;
} else {
  await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      const shot = async (slug) => {
        const file = shotName(slug);
        await page.screenshot({ path: file });
        note(`shot ${path.basename(file)}`);
        return file;
      };
      const openTab = async () => {
        const open = await page.evaluate(() => {
          const el = document.getElementById("assistant");
          return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
        });
        if (!open) await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
        await page.click('#as-tabs [data-as-tab="initiatives"]');
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 15_000 });
      };
      const refreshTab = async () => {
        await page.click("[data-init-refresh]");
        await waitFor(async () => (await store()).initiatives !== undefined, { what: "the tab to re-read the store" });
      };
      // The level is changed with the reader's own control: open Settings, Board, choose from the select, and wait for
      // the panel's config file to take it. Nothing here writes config.json directly.
      const setLevel = async (tier) => {
        await openSettingsGroup(page, "board");
        await page.waitForSelector("#initiative-tier", { state: "visible", timeout: 10_000 });
        await page.selectOption("#initiative-tier", tier);
        await page.dispatchEvent("#initiative-tier", "change");
        await waitFor(() => readConfig().initiativePermissions === tier, { what: `config.json to take ${tier}` });
        await page.click("#btn-settings-close");
        await page.waitForSelector("#settings.hidden, #settings[hidden]", { timeout: 10_000 }).catch(() => {});
      };
      const createInitiative = async (title) => {
        await page.locator("#as-initiatives [data-init-new]").first().click();
        await page.fill("#as-init-new-title", title);
        await page.fill("#as-init-new-desc", `${title}, in the sandbox.`);
        await page.click("[data-init-create]");
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 15_000 });
        const made = (await store()).initiatives.find((i) => i.title === title);
        if (!made) throw new Error(`the initiative ${title} was not created`);
        return made.id;
      };
      // One press of the card's own Add form. The primary button is chosen by position, not by its word, because the
      // word IS one of the things the level changes ("Ask to add" at the strict level, "Attach" at the others).
      const openCard = async (id) => {
        const toggle = page.locator(`[data-init-card="${id}"] [data-init-card-toggle]`).first();
        if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
        await page.waitForSelector(`[data-init-card="${id}"] [data-init-add]`, { timeout: 15_000 });
      };
      const openTrees = async (id) => {
        await openCard(id);
        // A project is its own fold: the tree rows only exist once it is open, so the Remove control is only reachable
        // through the reader's own two presses.
        for (const btn of await page.locator(`[data-init-card="${id}"] [data-init-fold]`).all()) {
          if ((await btn.getAttribute("aria-expanded")) === "false") await btn.click();
        }
        await page.waitForSelector(`[data-init-card="${id}"] .init-tree`, { timeout: 15_000 });
      };
      const attachViaCard = async (id, tree) => {
        await page.locator(`[data-init-card="${id}"]`).scrollIntoViewIfNeeded();
        // The card opens as its title card, so the Add control only exists once the card is unfolded. Pressing the
        // title is the reader's own path to it.
        await openCard(id);
        await page.locator(`[data-init-card="${id}"] [data-init-add]`).click();
        await page.waitForSelector(`[data-init-card="${id}"] [data-init-addform]`, { timeout: 15_000 });
        await page.selectOption(`[data-init-card="${id}"] [data-init-field="addTree"]`, { label: tree });
        await page.locator(`[data-init-card="${id}"] .init-addform .primary`).click();
        // TWO ENDINGS, and the card's own note is not one of them: the note appears the instant the note is written,
        // while the dock's card arrives with the next state poll. So wait for the two facts that differ - a card in
        // the dock, or the tree counted - and read the card only after one of them is true.
        const ending = await waitFor(async () => {
          if ((await page.locator("#approvals [data-remote-write]").count()) > 0) return "asked";
          const init = (await store()).initiatives.find((i) => i.id === id);
          return init && init.treeCount > 0 ? "done" : false;
        }, { what: `the press on ${tree} to ask or land` });
        if (!ending) return 0;
        return ending === "asked" ? page.locator("#approvals [data-remote-write]").count() : 0;
      };
      const treeCountOf = async (id) => (await store()).initiatives.find((i) => i.id === id)?.treeCount;
      const historyOf = async (id) => (await store()).initiatives.find((i) => i.id === id)?.history || [];

      await openPage(page, base, { selector: "section.project" });
      await page.waitForSelector("section.project > .project-head[data-toggle-project]", { state: "visible", timeout: 90_000 });
      for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
        const sec = head.locator("xpath=..");
        if (String((await sec.getAttribute("class")) || "").includes("collapsed")) await head.click();
      }
      await page.waitForSelector("tr.row", { state: "visible", timeout: 60_000 });
      await openTab();

      // ---- 1. the settings row -------------------------------------------------------------------------------
      console.log("\n== the settings row ==");
      await openSettingsGroup(page, "board");
      await page.waitForSelector("#initiative-tier", { state: "visible", timeout: 10_000 });
      const options = await page.locator("#initiative-tier option").evaluateAll((els) => els.map((el) => [el.value, el.textContent.trim()]));
      check("the select offers exactly the four levels, strictest first", options, [
        ["all", "ask me for everything"],
        ["remove", "ask me only to remove things"],
        ["own", "ask me only to remove trees I attached myself"],
        ["none", "need no permission at all"],
      ]);
      check("it opens on the level in force", await page.inputValue("#initiative-tier"), "all");
      const previewAll = await page.textContent("#initiative-tier-preview");
      ok(
        "its sentence says the card does not change and every change is recorded",
        /card itself never changes/.test(previewAll) && /history with its actor and time/.test(previewAll) && /every assistant's/.test(previewAll),
        previewAll,
      );
      await shot("settings-row-all");

      await setLevel("none");
      await openSettingsGroup(page, "board");
      check("choosing a level writes config.json", readConfig().initiativePermissions, "none");
      const previewNone = await page.textContent("#initiative-tier-preview");
      ok("the row says the chosen level in the reader's words", /need no permission at all/.test(previewNone), previewNone);
      await shot("settings-row-none");
      await page.click("#btn-settings-close");
      await refreshTab();
      const tierLine = await page.locator("#as-initiatives [data-init-tier]").getAttribute("data-init-tier");
      check("the Initiatives tab draws the level the routes are reading", tierLine, "none");

      // ---- 2. the same press at every level -------------------------------------------------------------------
      console.log("\n== the same press at every level ==");
      const ownId = await createInitiative("Own trees only");
      const removeId = await createInitiative("Remove only");
      const allId = await createInitiative("Everything asks");
      const noneId = await createInitiative("No questions");

      // (a) ask me for everything: the press parks a card and the store does not move.
      await setLevel("all");
      await refreshTab();
      const allCards = await attachViaCard(allId, TREE_NAMES[0]);
      ok("at ask-me-for-everything the press parks a card in the dock", allCards === 1, `${allCards} card(s)`);
      const cardText = await page.locator("#approvals [data-remote-write]").first().innerText();
      ok("the card names the tree and the initiative", /tree-one/.test(cardText) && /Everything asks/.test(cardText), cardText.split("\n")[0]);
      check("the store did not move", await treeCountOf(allId), 0);
      const pendingAll = (await pendingCards()).find((p) => p.kind === "initiative");
      check("the card grants no remote write", pendingAll?.grants, false);
      check("the card's choices are once and deny", pendingAll?.allowed, ["once", "deny"]);
      await shot("card-at-all");
      await page.locator('#approvals [data-remote-write] [data-choice="deny"]').first().click();
      await waitFor(async () => (await pendingCards()).length === 0, { what: "the card to close on deny" });
      check("deny leaves the tree unattached", await treeCountOf(allId), 0);

      // (b) ask me only to remove things: an attach is free.
      await setLevel("remove");
      await refreshTab();
      const removeCards = await attachViaCard(removeId, TREE_NAMES[1]);
      check("at ask-me-only-to-remove-things the same press asks nothing", removeCards, 0);
      check("…and the tree is attached", await treeCountOf(removeId), 1);
      const removeFirst = (await historyOf(removeId))[0];
      check("…and the history records it with its actor", [removeFirst.action, removeFirst.by], ["attach", "reader"]);
      ok("…and its time", !Number.isNaN(Date.parse(removeFirst.at)), removeFirst.at);

      // (c) own: the reader's own attach is free, and the assistant's tree is not the reader's to remove silently.
      await setLevel("own");
      await refreshTab();
      const ownCards = await attachViaCard(ownId, TREE_NAMES[2]);
      check("at ask-me-only-what-I-attached my own attach asks nothing", ownCards, 0);
      const assistant = await POST("/api/initiatives/move", { tree: treePath(TREE_NAMES[3]), initiative: ownId, action: "add", by: "scout" });
      check("a worker-role attach is recorded too, with its own actor", [assistant.status, (await historyOf(ownId))[0].by], [200, "scout"]);
      await refreshTab();
      await openTrees(ownId);
      await page.locator(`[data-init-card="${ownId}"] .init-tree`, { hasText: TREE_NAMES[3] }).locator("[data-init-move]").click();
      await waitFor(async () => (await pendingCards()).some((p) => p.kind === "initiative"), { what: "the reader's removal of the assistant's tree to ask" });
      const askText = await page.locator("#approvals [data-remote-write]").first().innerText();
      ok("removing a tree an assistant attached asks, at the level that exists for it", /tree-four/.test(askText), askText.split("\n")[0]);
      check("nothing moved while the question waits", await treeCountOf(ownId), 2);
      await page.locator('#approvals [data-remote-write] [data-choice="deny"]').first().click();
      await waitFor(async () => (await pendingCards()).length === 0, { what: "the card to close" });

      // (d) need no permission at all: the same press, made at once, still recorded.
      await setLevel("none");
      await refreshTab();
      const noneCards = await attachViaCard(noneId, TREE_NAMES[0]);
      check("at need-no-permission the same press asks nothing", noneCards, 0);
      check("…and the tree is attached", await treeCountOf(noneId), 1);
      const noneFirst = (await historyOf(noneId))[0];
      check("…and it is in the history with its actor, at the level that never asks", [noneFirst.action, noneFirst.by], ["attach", "reader"]);

      // ---- 3. the history fold ----------------------------------------------------------------------------------
      console.log("\n== the history fold ==");
      await openCard(ownId);
      await page.waitForSelector(`[data-init-card="${ownId}"] [data-init-history-fold]`, { timeout: 15_000 });
      const folded = await page.locator(`[data-init-card="${ownId}"] [data-init-history-fold]`).getAttribute("aria-expanded");
      check("the history is an accordion, folded until it is pressed", folded, "false");
      await page.locator(`[data-init-card="${ownId}"] [data-init-history-fold]`).click();
      await page.waitForSelector(`[data-init-card="${ownId}"] .init-history`, { timeout: 15_000 });
      const rows = await page.locator(`[data-init-card="${ownId}"] [data-init-hist-row]`).evaluateAll((els) =>
        els.map((el) => ({
          actor: el.getAttribute("data-init-hist-actor") || "",
          when: el.querySelector(".init-hist-when")?.textContent?.trim() || "",
          text: el.textContent.replace(/\s+/g, " ").trim(),
        })),
      );
      ok("every row names its actor", rows.length >= 3 && rows.every((r) => r.actor.length > 0), `${rows.length} rows`);
      ok("every row names its time", rows.every((r) => /\bago\b/.test(r.when)), JSON.stringify(rows.map((r) => r.when)));
      ok("the reader's press reads as you", rows.some((r) => r.actor === "you" && /attached tree-three/.test(r.text)), JSON.stringify(rows.map((r) => r.text)));
      ok("the assistant's press reads as the assistant", rows.some((r) => r.actor === "scout" && /attached tree-four/.test(r.text)), JSON.stringify(rows.map((r) => r.text)));
      // The card itself, not the window: the dock sits over the rail's lower half, and a shot a reader cannot read the
      // rows out of is not evidence of the rows. The receipts are cleared first with the dock's own control - they are
      // 90-second notices about presses this run already proved, not part of what the shot is about.
      for (const clear of await page.locator('#approvals [data-rw-clear]').all()) await clear.click();
      await page.locator(`[data-init-card="${ownId}"]`).screenshot({ path: shotName("history-fold") });
      note(`shot ${String(shotIndex).padStart(2, "0")}-history-fold.png (the card)`);

      // ---- 4. an assistant's change, while the page is open -----------------------------------------------------
      console.log("\n== a worker-role change in the history ==");
      const edit = await POST("/api/initiatives/update", { id: ownId, title: "Own trees only, renamed by a worker", by: "scout" });
      check("the worker's edit landed", edit.status, 200);
      await refreshTab();
      await openCard(ownId);
      const histBtn = page.locator(`[data-init-card="${ownId}"] [data-init-history-fold]`).first();
      if ((await histBtn.getAttribute("aria-expanded")) === "false") await histBtn.click();
      await page.waitForSelector(`[data-init-card="${ownId}"] .init-history`, { timeout: 15_000 });
      const newest = await page.locator(`[data-init-card="${ownId}"] [data-init-hist-row]`).first().evaluate((el) => ({
        actor: el.getAttribute("data-init-hist-actor") || "",
        when: el.querySelector(".init-hist-when")?.textContent?.trim() || "",
        text: el.textContent.replace(/\s+/g, " ").trim(),
      }));
      check("the newest row is the assistant's edit", [newest.actor, /edited the title/.test(newest.text)], ["scout", true]);
      ok("…with its time", /\bago\b/.test(newest.when), newest.when);
      for (const clear of await page.locator('#approvals [data-rw-clear]').all()) await clear.click();
      await page.locator(`[data-init-card="${ownId}"]`).screenshot({ path: shotName("history-fold-worker-change") });
      note(`shot ${String(shotIndex).padStart(2, "0")}-history-fold-worker-change.png (the card)`);

      // ---- 5. health ------------------------------------------------------------------------------------------
      pageErrorsOut = pageErrors;
      consoleErrorsOut = consoleErrors;
    },
    { viewport: { width: 1440, height: 900 } },
  );
}

if (playwright) {
  console.log("\n== health ==");
  check("zero page errors", pageErrorsOut.length, 0);
  check("zero console errors", consoleErrorsOut.length, 0);
  if (pageErrorsOut.length) note(pageErrorsOut.slice(0, 5).join("\n"));
  if (consoleErrorsOut.length) note(consoleErrorsOut.slice(0, 5).join("\n"));
}

try {
  await panel.stop();
} catch {
  /* already down */
}
clearTimeout(watchdog);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} - ${checks} checks, shots in ${slash(shotsDir)}`);
if (playwright && !existsSync(shotsDir)) note("no screenshots were written");
process.exit(failures === 0 ? 0 : playwright ? 1 : 2);
