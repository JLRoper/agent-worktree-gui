#!/usr/bin/env node
// AN ASSISTANT UNDER AN INITIATIVE, EXPANDED TO THE EXACT TASKS IT IS DOING THERE.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiative-tasks.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES, on the real page at 1440x900, never read out of the source:
//
//   1. COLLAPSED. An assistant's row under an initiative arrives with a real BUTTON, the tab's own caret, a count and
//      `aria-expanded="false"`, and no task rows in the DOM at all.
//   2. EXPANDED. A press opens the list: every queue row on that initiative's trees, one line each, naming its id,
//      its title, its state (queued, running, parked, done), its thread, its run while it is live, and its PR when
//      it has one. Newest activity first - the running row leads because it is working now. The initiative's card
//      is still open behind the list: the fold acts on itself.
//   3. LIVE. With the list open, a running task is moved to done through the queue API. The pane's own read picks it
//      up, and the ROW IS PATCHED WHERE IT STANDS - the element the harness marked before the change is still the
//      element after it (its marker survives), its state chip now reads done, and its run line is gone because a
//      done row is not live. A rebuild from markup would have dropped the marker.
//   4. KEYBOARD AND THE EXISTING FOLDS. The button is reachable and answers Enter and Space; Escape still closes the
//      rail the way it does for every other fold, the fold is still open when the rail comes back, and a press on
//      the card's title still folds the card.
//   5. TWO ASSISTANTS, EACH ITS OWN. Two assistants under one initiative draw two lists; neither holds a row of the
//      other's, and each fold's count is its own.
//   6. TWO INITIATIVES, ONE TREE. A tree attached to two initiatives shows the same task under both - once under
//      each, never twice under one - and a task on a tree no initiative carries appears nowhere on the tab.
//   7. THE HONEST EMPTY LINE. An initiative whose tree has no queue row says "no assistant has worked on these
//      worktrees yet" rather than drawing an empty fold.
//   8. A PR IS DRAWN ONLY WHEN THE ROW HAS ONE. In this sandbox no remote resolves a PR, so every row's PR cell is
//      absent rather than a dead link. The drawn-with-a-page half is a fixture test (test/initiative-tasks.test.js),
//      where a board row's own `prUrl` is handed in - the same field the chart's cell reads.
//   9. HEALTH. Zero page errors, zero console errors, and the rows are the rail's own 11.5px.
//
// Sandbox only: throwaway repos with hand-cut worktrees, its own PANEL_CONFIG and port, and an apiServer pointed at a
// dead port. The live panel and gateway are never touched. Without Playwright the script says BROWSER-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT, freePort, git, startPanel, waitFor, waitForRow } from "./panel-testkit.mjs";

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
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".initiative-tasks-shots");

const gitEnv = { GIT_TERMINAL_PROMPT: "0" };
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  return git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], { env: gitEnv });
};

// ---- the sandbox: one project, five trees, two of them behind two initiatives --------------------
const dir = path.join(ROOT, ".worktrees", ".initiative-tasks-sandbox");
rmSync(dir, { recursive: true, force: true });
const repos = path.join(dir, "repos");
mkdirSync(shotsDir, { recursive: true });
const repo = path.join(repos, "alpha");
mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# alpha\n", "utf8");
commit(repo, "seed the sandbox repo");
const trees = {
  ssoOne: path.join(repo, ".worktrees", "sso-one"),
  ssoTwo: path.join(repo, ".worktrees", "sso-two"),
  menuOne: path.join(repo, ".worktrees", "menu-one"),
  quietOne: path.join(repo, ".worktrees", "quiet-one"),
  nowhere: path.join(repo, ".worktrees", "nowhere"),
};
for (const [name, where] of Object.entries(trees)) {
  git(repo, ["worktree", "add", "-q", "-b", `work/${name}`, where]);
  writeFileSync(path.join(where, `${name}.txt`), "sandbox work\n", "utf8");
  commit(where, `do the ${name} work`);
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
    defaultCwd: repo,
    projects: [{ name: "alpha", path: repo, remote: "origin", mainBranch: "main" }],
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
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();

let shotNo = 0;
const shotName = (slug) => path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);

try {
  console.log(`sandbox: ${base}`);
  console.log(`panel pid: ${panel.pid}`);
  console.log(`shots:   ${shotsDir}`);

  for (const treePath of Object.values(trees)) {
    await waitForRow(base, "alpha", treePath, { timeout: 60_000 });
  }
  ok("all five trees are rows on the board", true, Object.keys(trees).join(", "));

  // The initiative tier is a setting: "none" asks nothing, so the setup below is not a stream of dock cards. The
  // questions themselves are test/initiatives-route.test.js's subject, not this gate's.
  const tier = await POST("/api/settings/initiative-tier", { tier: "none" });
  ok("the initiative tier is set to the level that asks nothing", tier.status === 200 && tier.body?.tier?.id === "none", `HTTP ${tier.status}`);

  // ---- the two assistants and their queues: the rows the folds must show, and one that must not ----------
  const seeded = (await GET("/api/state")).body?.assistant?.assistants?.[0];
  ok("the panel seeds an assistant", Boolean(seeded?.id), seeded?.id || "none");
  const madeSecond = await POST("/api/assistant/assistants", {});
  ok("a second assistant exists, so the two lists have two owners", madeSecond.status === 201, `HTTP ${madeSecond.status}`);
  const secondId = String(madeSecond.body?.assistant?.id || "assistant-2");
  const firstId = String(seeded?.id || "assistant-1");

  const q1 = (await GET(`/api/assistant/queue?assistantId=${firstId}`)).body?.queue;
  const q2 = (await GET(`/api/assistant/queue?assistantId=${secondId}`)).body?.queue;
  ok("both queue routes name the file they read", Boolean(q1?.file) && Boolean(q2?.file), `${slash(q1?.file)} | ${slash(q2?.file)}`);
  writeFileSync(
    q1.file,
    `${JSON.stringify(
      {
        version: 1,
        nextId: 8,
        tasks: [
          { id: 1, title: "Wire the SSO callback", state: "running", worktree: slash(trees.ssoOne), project: "alpha", thread: "wtgui-sso-one", runId: "run-sso-1", startedAt: iso(90_000), createdAt: iso(120_000) },
          { id: 2, title: "Land the Menu login page", state: "done", worktree: slash(trees.menuOne), project: "alpha", thread: "wtgui-menu-one", runId: "run-menu-2", doneAt: iso(2 * 3_600_000) },
          // On a tree NO initiative carries: the tab must not show this row anywhere.
          { id: 3, title: "Nowhere work", state: "queued", worktree: slash(trees.nowhere), project: "alpha", createdAt: iso(30_000) },
        ],
      },
      null,
      1,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    q2.file,
    `${JSON.stringify(
      {
        version: 1,
        nextId: 8,
        tasks: [
          { id: 6, title: "Queue the gateway retry", state: "queued", worktree: slash(trees.ssoTwo), project: "alpha", thread: "wtgui-sso-two", createdAt: iso(20 * 60_000) },
          { id: 5, title: "Wait for the DBA", state: "parked", worktree: slash(trees.menuOne), project: "alpha", thread: "wtgui-menu-one-b", reason: "waiting on the DBA" },
        ],
      },
      null,
      1,
    )}\n`,
    "utf8",
  );

  // ---- three initiatives: A (three trees), B (the shared tree), C (a tree with no tasks) ----------------
  const mk = async (title) => {
    const out = await POST("/api/initiatives", { title });
    ok(`initiative "${title}" is created`, out.status === 201 && Boolean(out.body?.initiative?.id), `HTTP ${out.status}`);
    return out.body.initiative.id;
  };
  const initA = await mk("SSO migration");
  const initB = await mk("Menu cutover");
  const initC = await mk("Quiet initiative");
  for (const [id, treePath] of [
    [initA, trees.ssoOne],
    [initA, trees.ssoTwo],
    [initA, trees.menuOne],
    [initB, trees.menuOne],
    [initC, trees.quietOne],
  ]) {
    const moved = await POST("/api/initiatives/move", { tree: slash(treePath), initiative: id, action: "add", by: "reader" });
    ok(`a tree is attached to its initiative without a question`, moved.status === 200 && moved.body?.changed === true, `HTTP ${moved.status} ${path.basename(treePath)}`);
  }
  const doc = (await GET("/api/initiatives")).body;
  const byId = (id) => (doc.initiatives || []).find((i) => i.id === id);
  check("the document counts two assistants on the initiative with their work", [byId(initA)?.assistantCount, byId(initB)?.assistantCount, byId(initC)?.assistantCount], [2, 2, 0]);
  // The wire's own half of the fold: the rows are on the document, ordered, and the unlinked row is not.
  const a1 = byId(initA).assistants.find((a) => a.id === firstId);
  check("the read hands the page the exact rows, newest activity first", a1.taskRows.map((r) => r.id), [1, 2]);
  ok("…with the running row's run id and thread", a1.taskRows[0].runId === "run-sso-1" && a1.taskRows[0].thread === "wtgui-sso-one", `${a1.taskRows[0].runId} ${a1.taskRows[0].thread}`);
  ok("…and no run id on the done row", a1.taskRows[1].runId === "", JSON.stringify(a1.taskRows[1].runId));
  ok("…and the unlinked row is on no initiative", JSON.stringify(doc).includes("Nowhere work") === false);

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the initiative task folds", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        const shot = async (slug, opts = {}) => {
          const file = shotName(slug);
          await page.screenshot({ path: file, ...opts });
          note(`shot ${path.basename(file)}`);
          return file;
        };
        const paneShot = async (slug) => {
          const box = await page.locator("#as-initiatives").boundingBox();
          const file = shotName(slug);
          await page.screenshot({
            path: file,
            clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(1440 - Math.max(0, box.x - 8), box.width + 16), height: Math.min(900 - Math.max(0, box.y - 8), box.height + 16) },
          });
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
        // A card has to be unfolded and its Assistants fold opened before any assistant row exists: both are the
        // tab's own arrangement, and pressing them is how a reader reaches the row this gate is about.
        const openCard = async (id) => {
          await page.waitForSelector(`[data-init-card="${id}"]`, { timeout: 25_000 });
          const open = await page.locator(`[data-init-card="${id}"] [data-init-card-toggle]`).getAttribute("aria-expanded");
          if (open !== "true") await page.locator(`[data-init-card="${id}"] .init-title`).click();
          await page.waitForSelector(`[data-init-card="${id}"] [data-init-assist-fold]`, { timeout: 15_000 });
          const assists = await page.locator(`[data-init-card="${id}"] [data-init-assist-fold]`).getAttribute("aria-expanded");
          if (assists !== "true") await page.locator(`[data-init-card="${id}"] [data-init-assist-fold]`).click();
        };
        const fold = (id, assistantId) => page.locator(`[data-init-card="${id}"] [data-init-assistant-row="${assistantId}"] [data-init-task-fold]`);
        const listRows = async (id, assistantId) =>
          page.locator(`[data-init-card="${id}"] [data-init-assistant-row="${assistantId}"]`).evaluate((el) => {
            const box = el.querySelector("[data-init-tasks]");
            if (!box) return null;
            return [...box.querySelectorAll(".init-task")].map((r) => ({
              id: r.dataset.initTask,
              state: r.dataset.initTaskState,
              text: r.textContent.replace(/\s+/g, " ").trim(),
              chip: r.querySelector("[data-init-task-chip]")?.textContent.trim() || "",
              title: r.querySelector("[data-init-task-title]")?.textContent.trim() || "",
              thread: r.querySelector("[data-init-task-thread]")?.textContent.trim() || "",
              run: r.querySelector("[data-init-task-run]")?.hidden === true ? "" : r.querySelector("[data-init-task-run]")?.textContent.trim() || "",
              pr: r.querySelector("[data-init-task-pr]")?.hidden === true ? "" : r.querySelector("[data-init-task-pr]")?.textContent.trim() || "",
              when: r.querySelector("[data-init-task-when]")?.textContent.trim() || "",
              font: getComputedStyle(r).fontSize,
            }));
          });
        const cardOpen = async (id) => (await page.locator(`[data-init-card="${id}"] [data-init-card-toggle]`).getAttribute("aria-expanded")) === "true";

        await openPage(page, base, { selector: "section.project" });
        await openTab();
        await openCard(initA);

        // ---- 1. collapsed: a real button, the tab's caret, a count, and no rows ---------------------
        console.log("\n== collapsed ==");
        const collapsed = await page.locator(`[data-init-card="${initA}"]`).evaluate((card) =>
          [...card.querySelectorAll(".init-assist")].map((row) => ({
            id: row.dataset.initAssistantRow,
            tag: row.querySelector("[data-init-task-fold]")?.tagName || "",
            expanded: row.querySelector("[data-init-task-fold]")?.getAttribute("aria-expanded"),
            caret: row.querySelector("[data-init-task-fold] .init-caret")?.textContent || "",
            label: row.querySelector("[data-init-task-fold] .init-proj-name")?.textContent.trim() || "",
            count: row.querySelector("[data-init-task-count]")?.textContent.trim() || "",
            aria: row.querySelector("[data-init-task-fold]")?.getAttribute("aria-label") || "",
            lists: row.querySelectorAll("[data-init-tasks]").length,
            rows: row.querySelectorAll(".init-task").length,
            height: Math.round(row.getBoundingClientRect().height),
          })),
        );
        check("two assistants are shown under the initiative", collapsed.map((r) => r.id), [firstId, secondId]);
        ok("each row's expand control is a real BUTTON", collapsed.every((r) => r.tag === "BUTTON"), collapsed.map((r) => r.tag).join(","));
        ok("…folded, with aria-expanded=false", collapsed.every((r) => r.expanded === "false"), collapsed.map((r) => r.expanded).join(","));
        ok("…wearing the tab's own caret", collapsed.every((r) => r.caret === "▸"), collapsed.map((r) => r.caret).join(""));
        ok("…labelled tasks, with the count beside it", collapsed.every((r) => r.label === "tasks"), collapsed.map((r) => `${r.label} ${r.count}`).join(" | "));
        ok("…and an aria-label that names the assistant", collapsed.every((r) => /show the [12] task/.test(r.aria)), collapsed[0]?.aria || "");
        check("folded, no list and no rows are in the DOM", collapsed.map((r) => [r.lists, r.rows]), [
          [0, 0],
          [0, 0],
        ]);
        await paneShot("collapsed");

        // ---- 2. expanded: the exact rows, named in full ---------------------------------------------
        console.log("\n== expanded ==");
        await fold(initA, firstId).click();
        await page.waitForFunction(
          ([id, aid]) => document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-task-fold]`)?.getAttribute("aria-expanded") === "true",
          [initA, firstId],
          { timeout: 15_000 },
        );
        const expanded = await listRows(initA, firstId);
        check("the list is every queue row on this initiative's trees, newest first", expanded.map((r) => [r.id, r.state]), [
          ["1", "running"],
          ["2", "done"],
        ]);
        ok("each row names its title", expanded[0].title === "Wire the SSO callback" && expanded[1].title === "Land the Menu login page", expanded.map((r) => r.title).join(" | "));
        ok("each row names its state in the reader's word", expanded.map((r) => r.chip).join(",") === "running,done", expanded.map((r) => r.chip).join(","));
        ok("the running row names its thread and its run", expanded[0].thread === "on wtgui-sso-one" && expanded[0].run === "run run-sso-1", `${expanded[0].thread} / ${expanded[0].run}`);
        ok("the done row keeps its thread but draws no run", expanded[1].thread === "on wtgui-menu-one" && expanded[1].run === "", `${expanded[1].thread} / ${JSON.stringify(expanded[1].run)}`);
        ok("each row says when it last moved, or says there is no clock", expanded.every((r) => / ago$|no time recorded/.test(r.when)), expanded.map((r) => r.when).join(" | "));
        ok("no row draws a dead PR link when the board resolved no PR", expanded.every((r) => r.pr === ""), expanded.map((r) => r.pr).join(","));
        ok("the initiative's card is still open behind the list", await cardOpen(initA));
        ok("the rows are the rail's own 11.5px", expanded.every((r) => r.font === "11.5px"), [...new Set(expanded.map((r) => r.font))].join(","));
        ok("the fold's count is the number of rows it opens", (await page.locator(`[data-init-card="${initA}"] [data-init-assistant-row="${firstId}"] [data-init-task-count]`).textContent()) === "2");
        await paneShot("expanded");

        // ---- 3. a live row is patched where it stands ------------------------------------------------
        console.log("\n== live update ==");
        // Mark the running row's element and remember its node identity from inside the page: a rebuild from markup
        // loses the marker, a patch keeps it.
        const marked = await page.evaluate(
          ([id, aid]) => {
            const row = document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-task="1"]`);
            if (!row) return false;
            row.dataset.wagProbe = "kept-across-the-update";
            return true;
          },
          [initA, firstId],
        );
        ok("the running row is marked before the update", marked);
        const moved = await POST("/api/assistant/queue", { assistantId: firstId, action: "state", id: 1, state: "done" });
        ok("the queue API moves the task to done", moved.status === 200, `HTTP ${moved.status}`);
        await waitFor(
          async () =>
            page.evaluate(
              ([id, aid]) => document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-task="1"]`)?.dataset.initTaskState === "done",
              [initA, firstId],
            ),
          { timeoutMs: 25_000, what: "the pane's own read to pick up the done state" },
        );
        const after = await page.evaluate(
          ([id, aid]) => {
            const row = document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-task="1"]`);
            return row
              ? {
                  probe: row.dataset.wagProbe || "",
                  state: row.dataset.initTaskState,
                  chip: row.querySelector("[data-init-task-chip]")?.textContent.trim() || "",
                  run: row.querySelector("[data-init-task-run]")?.hidden === true ? "" : row.querySelector("[data-init-task-run]")?.textContent.trim() || "",
                  when: row.querySelector("[data-init-task-when]")?.textContent.trim() || "",
                }
              : null;
          },
          [initA, firstId],
        );
        check("the live row's state is updated in place", after && { state: after.state, chip: after.chip }, { state: "done", chip: "done" });
        ok("…and it is the SAME element - the marker survived", after?.probe === "kept-across-the-update", after?.probe || "(rebuilt)");
        ok("…its run line is gone, because a done row is not live", after?.run === "", JSON.stringify(after?.run));
        ok("…and its clock was rewritten", / ago$/.test(after?.when || ""), after?.when || "");
        const stillOpen = await fold(initA, firstId).getAttribute("aria-expanded");
        ok("the fold is still open through the update", stillOpen === "true", stillOpen || "");
        await paneShot("live-updated");

        // ---- 4. keyboard, Escape and the title press --------------------------------------------------
        console.log("\n== keyboard, Escape, the title ==");
        await fold(initA, secondId).focus();
        ok("the second assistant's fold takes the keyboard's focus", await page.evaluate(([id, aid]) => document.activeElement?.hasAttribute?.("data-init-task-fold") && document.activeElement.closest(`[data-init-assistant-row="${aid}"]`) !== null && document.activeElement.closest(`[data-init-card="${id}"]`) !== null, [initA, secondId]));
        await page.keyboard.press("Enter");
        await waitFor(async () => (await fold(initA, secondId).getAttribute("aria-expanded")) === "true", { timeoutMs: 8_000, what: "Enter to open the fold" });
        ok("Enter on it opens the list", true);
        await fold(initA, secondId).focus();
        await page.keyboard.press("Space");
        await waitFor(async () => (await fold(initA, secondId).getAttribute("aria-expanded")) === "false", { timeoutMs: 8_000, what: "Space to shut the fold" });
        ok("Space on it shuts the list", true);
        // Escape is the rail's, exactly as it is for a project fold: with the caret inside the rail it closes it, and
        // the fold it was pressed over keeps the state the reader left it in.
        await fold(initA, firstId).focus();
        await page.keyboard.press("Escape");
        await waitFor(async () => page.evaluate(() => document.getElementById("assistant")?.hidden === true), { timeoutMs: 8_000, what: "Escape to close the rail" });
        ok("Escape still closes the rail, the way it does for every other fold", true);
        await openTab();
        await page.waitForSelector(`[data-init-card="${initA}"]`, { timeout: 20_000 });
        const survived = await page.evaluate(
          ([id, aid]) => {
            const card = document.querySelector(`[data-init-card="${id}"]`);
            return {
              card: card?.querySelector("[data-init-card-toggle]")?.getAttribute("aria-expanded"),
              fold: card?.querySelector(`[data-init-assistant-row="${aid}"] [data-init-task-fold]`)?.getAttribute("aria-expanded"),
              rows: card?.querySelectorAll(`[data-init-assistant-row="${aid}"] .init-task`).length || 0,
            };
          },
          [initA, firstId],
        );
        check("with the rail back, the fold is where the reader left it", survived, { card: "true", fold: "true", rows: 2 });
        // The title still folds the card, and the fold state is remembered for the card's next opening.
        await page.locator(`[data-init-card="${initA}"] .init-title`).click();
        await page.waitForFunction((id) => document.querySelector(`[data-init-card="${id}"] [data-init-card-toggle]`)?.getAttribute("aria-expanded") === "false", initA, { timeout: 10_000 });
        ok("a press on the title still folds the card", true);
        await page.locator(`[data-init-card="${initA}"] .init-title`).click();
        await page.waitForSelector(`[data-init-card="${initA}"] [data-init-assist-fold]`, { timeout: 15_000 });
        const reopened = await page.evaluate(
          ([id, aid]) => document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-task-fold]`)?.getAttribute("aria-expanded"),
          [initA, firstId],
        );
        check("…and reopening the card brings the task fold back open", reopened, "true");

        // ---- 5. two assistants, each showing only its own rows ---------------------------------------
        console.log("\n== two assistants, two lists ==");
        if ((await fold(initA, secondId).getAttribute("aria-expanded")) !== "true") await fold(initA, secondId).click();
        await waitFor(async () => (await listRows(initA, secondId))?.length === 2, { timeoutMs: 15_000, what: "the second assistant's list" });
        const mine = (await listRows(initA, firstId)).map((r) => r.title);
        const theirs = (await listRows(initA, secondId)).map((r) => r.title);
        check("the first assistant's list is its own two rows", mine, ["Wire the SSO callback", "Land the Menu login page"]);
        check("the second assistant's list is its own two rows", theirs, ["Queue the gateway retry", "Wait for the DBA"]);
        ok("no row appears in both lists", mine.every((t) => !theirs.includes(t)), [...mine, ...theirs].join(" | "));
        const counts = await page.locator(`[data-init-card="${initA}"]`).evaluate((card) =>
          [...card.querySelectorAll(".init-assist")].map((row) => [row.dataset.initAssistantRow, row.querySelector("[data-init-task-count]")?.textContent.trim()]),
        );
        check("each fold counts its own rows", counts, [
          [firstId, "2"],
          [secondId, "2"],
        ]);
        await paneShot("two-assistants");

        // ---- 6. two initiatives, one tree; and the row no initiative carries -------------------------
        console.log("\n== the shared tree and the unlinked row ==");
        await page.locator(`[data-init-card="${initB}"]`).scrollIntoViewIfNeeded();
        await openCard(initB);
        await fold(initB, firstId).click();
        await waitFor(async () => (await listRows(initB, firstId))?.length === 1, { timeoutMs: 15_000, what: "the second initiative's list" });
        const underB = await listRows(initB, firstId);
        check("the shared tree's task shows under the second initiative too", underB.map((r) => r.title), ["Land the Menu login page"]);
        const underA = (await listRows(initA, firstId)).map((r) => r.title);
        ok("…and it is still under the first, once in each", underA.includes("Land the Menu login page") && underA.filter((t) => t === "Land the Menu login page").length === 1, `${underA.join(" | ")} / ${underB.map((r) => r.title).join(" | ")}`);
        const tabText = await page.locator("#as-initiatives").innerText();
        ok("a task on a tree no initiative carries appears nowhere on the tab", !tabText.includes("Nowhere work"));
        await paneShot("shared-tree");

        // ---- 7. the honest empty line -----------------------------------------------------------------
        console.log("\n== the honest empty line ==");
        await page.locator(`[data-init-card="${initC}"]`).scrollIntoViewIfNeeded();
        await openCard(initC);
        const quiet = await page.locator(`[data-init-card="${initC}"]`).evaluate((card) => ({
          assistants: card.querySelectorAll(".init-assist").length,
          hint: card.querySelector(".init-no-assist")?.textContent.trim() || "",
          folds: card.querySelectorAll("[data-init-task-fold]").length,
        }));
        check("an initiative whose tree has no queue row draws no assistant fold", { assistants: quiet.assistants, folds: quiet.folds }, { assistants: 0, folds: 0 });
        ok("…and says so in words", quiet.hint === "no assistant has worked on these worktrees yet", quiet.hint || "(no line)");
        await paneShot("empty-initiative");

        // ---- 8 and 9. health --------------------------------------------------------------------------
        console.log("\n== health ==");
        check("no page errors", pageErrors.map(String), []);
        check("no console errors", consoleErrors.map(String), []);
        // The page's own document is the one the gate read over HTTP, so a row cannot be on one and not the other.
        const wire = (await GET("/api/initiatives")).body;
        ok("the wire still lists the tasks the page drew", (wire.initiatives.find((i) => i.id === initA)?.assistants.find((a) => a.id === firstId)?.taskRows || []).length === 2);
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
  await panel.stop();
  clearTimeout(watchdog);
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed; shots in ${shotsDir}`);
process.exit(failures === 0 ? 0 : 1);
