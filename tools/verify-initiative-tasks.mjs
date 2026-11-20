#!/usr/bin/env node
// THE ASSISTANT'S TASKS UNDER AN INITIATIVE, DRAWN WITH THE QUEUE'S OWN CARD.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiative-tasks.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES, on the real page at 1440x900, never read out of the source:
//
//   1. COLLAPSED. An assistant's row under an initiative arrives with a real BUTTON, the tab's own caret, a count and
//      `aria-expanded="false"`, and no cards in the DOM at all.
//   2. THE CARD. A press opens the fold, and what it draws is THE QUEUE'S CARD in its compact, read-only mode: the
//      same `as-task` head - marker, id, state in a word, title - the same classes the queue's own row wears, the
//      agent's thread and the clock on one facts line. It is NOT the plain two-line listing the tab used to draw.
//   3. THE BRIEF IS NOT THE TITLE. The row carries a long `detail` (the brief a worker is handed) and a short title;
//      the card's title text and its whole `title=` are the SHORT TITLE, and the brief appears nowhere on the card.
//   4. NO ACTIONS. The compact card carries zero buttons, links, disclosures and `data-as-qact` presses - read out of
//      the live DOM, not the source. The queue's own card for the same task carries them.
//   5. LIVE, IN PLACE. A running task is moved to done through the queue API. The pane's own read picks it up and the
//      SAME node is refreshed - the marker the harness put on it before the change is still there after it.
//   6. THE PRESS. A press on the compact card opens that task in its REAL queue: the queue sub-tab, the assistant
//      selected, the row inside the pane and flashing. That is the walk the console's #405 anchors and the chart's
//      owner chips take, and it is where the actions live. The head there is the same head, element for element.
//   7. KEYBOARD AND THE EXISTING FOLDS. The fold's button answers Enter and Space, Escape still closes the rail, the
//      fold is still open when the rail comes back, and a press on the card's title still folds the card.
//   8. TWO ASSISTANTS, EACH ITS OWN. Two assistants under one initiative draw two folds; neither holds a card of the
//      other's, and each fold's count is its own.
//   9. TWO INITIATIVES, ONE TREE. A tree attached to two initiatives shows the same task under both - once under
//      each, never twice under one - and a task on a tree no initiative carries appears nowhere on the tab.
//  10. THE HONEST EMPTY LINE. An initiative whose tree has no queue row says "no assistant has worked on these
//      worktrees yet" rather than drawing an empty fold.
//  11. THE FOLD'S WINDOW. With ten rows on the initiative the fold draws six (the states being acted on first), says
//      how many of how many are shown beside one "Show 4 more", and that press draws the rest and retires the line.
//  12. HEALTH. Zero page errors, zero console errors, the cards are the rail's own 11.5px, and the wire's rows and
//      the cards on screen are the same rows.
//
// Sandbox only: throwaway repos with hand-cut worktrees, its own PANEL_CONFIG and port, and an apiServer pointed at a
// dead port. The live panel and gateway are never touched. Without Playwright the script says BROWSER-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The brief a worker is handed for task 1. It must never be the card's title, and must never be drawn on the card.
const BRIEF =
  "Rewrite the callback so the menu login page hands the ticket to the gateway, keep the old servlet path working for one release, and do not touch the header";

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
  ok("a second assistant exists, so the two folds have two owners", madeSecond.status === 201, `HTTP ${madeSecond.status}`);
  const secondId = String(madeSecond.body?.assistant?.id || "assistant-2");
  const firstId = String(seeded?.id || "assistant-1");

  const q1 = (await GET(`/api/assistant/queue?assistantId=${firstId}`)).body?.queue;
  const q2 = (await GET(`/api/assistant/queue?assistantId=${secondId}`)).body?.queue;
  ok("both queue routes name the file they read", Boolean(q1?.file) && Boolean(q2?.file), `${slash(q1?.file)} | ${slash(q2?.file)}`);
  // Task 1 carries a SHORT title and a LONG brief: the card's title can then be held to the title, not the brief.
  writeFileSync(
    q1.file,
    `${JSON.stringify(
      {
        version: 1,
        nextId: 8,
        tasks: [
          { id: 1, title: "Wire the SSO callback", state: "running", worktree: slash(trees.ssoOne), project: "alpha", thread: "wtgui-sso-one", runId: "run-sso-1", startedAt: iso(90_000), createdAt: iso(120_000), detail: BRIEF },
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
    console.log(notRun("the initiative task cards", "playwright is not installed for this node (see tools/browser.mjs)"));
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
        // THE CARDS ONE FOLD HOLDS, read out of the live DOM: what each one says, and what it does NOT carry (buttons,
        // links, disclosures, presses, a drag) - the read-only half is measured, never assumed.
        const listCards = async (id, assistantId) =>
          page.locator(`[data-init-card="${id}"] [data-init-assistant-row="${assistantId}"]`).evaluate((el) => {
            const box = el.querySelector("[data-init-tasks]");
            if (!box) return null;
            return [...box.querySelectorAll(".as-task")].map((card) => {
              const title = card.querySelector(".as-task-title");
              return {
                cls: card.className,
                id: card.dataset.initTaskCard || "",
                own: card.dataset.initTaskOwn || "",
                state: card.dataset.asQstate || "",
                role: card.getAttribute("role") || "",
                tab: card.getAttribute("tabindex") || "",
                text: card.textContent.replace(/\s+/g, " ").trim(),
                word: card.querySelector(".as-task-state")?.textContent.trim() || "",
                title: title?.textContent.trim() || "",
                titleAttr: title?.getAttribute("title") || "",
                headParts: [...(card.querySelector(".as-task-head")?.children || [])].map((n) => (n.className || "").split(" ")[0]),
                thread: card.querySelector(".as-task-agent-thread")?.textContent.trim() || "",
                when: card.querySelector(".as-task-when")?.textContent.trim() || "",
                facts: card.querySelectorAll(".as-task-facts").length,
                actions: card.querySelectorAll("button, a, input, select, textarea, summary, details, [data-as-qact]").length,
                draggable: card.getAttribute("draggable"),
                font: title ? getComputedStyle(title).fontSize : "",
                nowrap: title ? getComputedStyle(title).whiteSpace : "",
              };
            });
          });
        const moreOf = (id, assistantId) => page.locator(`[data-init-card="${id}"] [data-init-assistant-row="${assistantId}"] .init-tasks-more`);
        const cardOpen = async (id) => (await page.locator(`[data-init-card="${id}"] [data-init-card-toggle]`).getAttribute("aria-expanded")) === "true";

        await openPage(page, base, { selector: "section.project" });
        await openTab();
        await openCard(initA);

        // ---- 1. collapsed: a real button, the tab's caret, a count, and no cards ---------------------
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
            cards: row.querySelectorAll(".as-task").length,
          })),
        );
        check("two assistants are shown under the initiative", collapsed.map((r) => r.id), [firstId, secondId]);
        ok("each row's expand control is a real BUTTON", collapsed.every((r) => r.tag === "BUTTON"), collapsed.map((r) => r.tag).join(","));
        ok("…folded, with aria-expanded=false", collapsed.every((r) => r.expanded === "false"), collapsed.map((r) => r.expanded).join(","));
        ok("…wearing the tab's own caret", collapsed.every((r) => r.caret === "▸"), collapsed.map((r) => r.caret).join(""));
        ok("…labelled tasks, with the count beside it", collapsed.every((r) => r.label === "tasks"), collapsed.map((r) => `${r.label} ${r.count}`).join(" | "));
        ok("…and an aria-label that names the assistant", collapsed.every((r) => /show the [12] task/.test(r.aria)), collapsed[0]?.aria || "");
        check("folded, no list and no cards are in the DOM", collapsed.map((r) => [r.lists, r.cards]), [
          [0, 0],
          [0, 0],
        ]);
        await paneShot("collapsed");

        // ---- 2. expanded: THE QUEUE'S CARD, in its compact mode --------------------------------------
        console.log("\n== expanded: the queue's card ==");
        await fold(initA, firstId).click();
        await page.waitForFunction(
          ([id, aid]) => document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-task-fold]`)?.getAttribute("aria-expanded") === "true",
          [initA, firstId],
          { timeout: 15_000 },
        );
        await waitFor(async () => ((await listCards(initA, firstId)) || []).length === 2, { timeoutMs: 15_000, what: "the fold's two cards" });
        const cards = await listCards(initA, firstId);
        check("the fold draws every queue row on this initiative's trees, active states first", cards.map((c) => [c.id, c.state]), [
          ["1", "running"],
          ["2", "done"],
        ]);
        ok("each card is the queue's own card, plus the mode's own class", cards.every((c) => /(^|\s)as-task(\s|$)/.test(c.cls) && /(^|\s)is-compact(\s|$)/.test(c.cls)), cards.map((c) => c.cls).join(" | "));
        ok(
          "the head is the queue's: marker, id, state in a word, title",
          cards.every((c) => JSON.stringify(c.headParts) === JSON.stringify(["as-task-mark", "mono", "as-task-state", "as-task-title"])),
          JSON.stringify(cards[0]?.headParts),
        );
        check("the state is the reader's word", cards.map((c) => c.word), ["running", "done"]);
        ok("each card names its agent (the thread)", cards[0].thread === "wtgui-sso-one" && cards[1].thread === "wtgui-menu-one", cards.map((c) => c.thread).join(" | "));
        ok("each card says when it last moved, or that there is no clock", cards.every((c) => / ago$|no time recorded/.test(c.when)), cards.map((c) => c.when).join(" | "));
        ok("each card carries one facts line and nothing else", cards.every((c) => c.facts === 1), cards.map((c) => c.facts).join(","));
        ok("the cards are a press target, keyboard included", cards.every((c) => c.role === "button" && c.tab === "0"), `${cards[0]?.role}/${cards[0]?.tab}`);
        ok("each card is owned by the assistant whose fold drew it", cards.every((c) => c.own === firstId), cards.map((c) => c.own).join(","));
        ok("the initiative's card is still open behind the fold", await cardOpen(initA));

        // ---- 3. the brief is not the title ------------------------------------------------------------
        console.log("\n== the brief is not the title ==");
        ok("the card's title is the task's TITLE", cards[0].title === "Wire the SSO callback", cards[0].title);
        ok("…and the whole of it rides in title=", cards[0].titleAttr === "Wire the SSO callback", cards[0].titleAttr);
        ok("…the brief is nowhere on the card", cards.every((c) => !c.text.includes(BRIEF.slice(0, 40)) && !c.titleAttr.includes(BRIEF.slice(0, 40))), BRIEF.slice(0, 40));
        ok("…and the title is cut to ONE line by the compact rule, never in code", cards[0].nowrap === "nowrap", cards[0].nowrap);
        ok("the title is the rail's own 11.5px", cards[0].font === "11.5px", cards[0].font);

        // ---- 4. no actions ----------------------------------------------------------------------------
        console.log("\n== no actions ==");
        ok("no compact card carries a button, a link, a disclosure or a press", cards.every((c) => c.actions === 0), cards.map((c) => c.actions).join(","));
        ok("…and none of them is draggable", cards.every((c) => c.draggable !== "true"), cards.map((c) => String(c.draggable)).join(","));
        ok("the fold has no second, plainer listing beside the cards", await page.evaluate(([id, aid]) => document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"]`).querySelectorAll(".init-task").length === 0, [initA, firstId]));
        await paneShot("expanded");

        // ---- 5. live, in place ------------------------------------------------------------------------
        console.log("\n== live update ==");
        // Mark the running card and remember its node identity from inside the page: a rebuild from markup loses the
        // marker, a refresh keeps it.
        const marked = await page.evaluate(
          ([id, aid]) => {
            const card = document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-task-card="1"]`);
            if (!card) return false;
            card.dataset.wagProbe = "kept-across-the-update";
            return true;
          },
          [initA, firstId],
        );
        ok("the running card is marked before the update", marked);
        const movedTask = await POST("/api/assistant/queue", { assistantId: firstId, action: "state", id: 1, state: "done" });
        ok("the queue API moves the task to done", movedTask.status === 200, `HTTP ${movedTask.status}`);
        await waitFor(
          async () =>
            page.evaluate(
              ([id, aid]) => document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-task-card="1"]`)?.dataset.asQstate === "done",
              [initA, firstId],
            ),
          { timeoutMs: 25_000, what: "the pane's own read to pick up the done state" },
        );
        const after = await page.evaluate(
          ([id, aid]) => {
            const card = document.querySelector(`[data-init-card="${id}"] [data-init-assistant-row="${aid}"] [data-init-task-card="1"]`);
            return card
              ? {
                  probe: card.dataset.wagProbe || "",
                  state: card.dataset.asQstate,
                  word: card.querySelector(".as-task-state")?.textContent.trim() || "",
                  cls: card.className,
                  when: card.querySelector(".as-task-when")?.textContent.trim() || "",
                }
              : null;
          },
          [initA, firstId],
        );
        check("the live card's state is updated in place", after && { state: after.state, word: after.word }, { state: "done", word: "done" });
        ok("…and it is the SAME node - the marker survived", after?.probe === "kept-across-the-update", after?.probe || "(rebuilt)");
        ok("…its done class is the queue card's own", /(^|\s)is-done(\s|$)/.test(after?.cls || ""), after?.cls || "");
        ok("…and its clock was rewritten", / ago$/.test(after?.when || ""), after?.when || "");
        const stillOpen = await fold(initA, firstId).getAttribute("aria-expanded");
        ok("the fold is still open through the update", stillOpen === "true", stillOpen || "");
        await paneShot("live-updated");

        // ---- 6. the press opens the task in its REAL queue, and that card carries the actions ----------
        console.log("\n== the press ==");
        // The flash is a ~1s animation on a node the press CREATES, so it can be over before the harness can look.
        // Watch the rail for the class instead: an observer records every queue row that ever wore it.
        await page.evaluate(() => {
          window.__flashed = [];
          const seen = new Set();
          window.__flashObs = new MutationObserver((records) => {
            for (const rec of records) {
              const el = rec.target;
              if (!el?.classList?.contains?.("flash")) continue;
              const id = el.dataset?.asQrow;
              if (!id || seen.has(id)) continue;
              seen.add(id);
              window.__flashed.push(id);
            }
          });
          window.__flashObs.observe(document.getElementById("assistant"), { subtree: true, attributes: true, attributeFilter: ["class"] });
        });
        const compactHeads = (await listCards(initA, firstId)).map((c) => c.headParts);
        await page.locator(`[data-init-card="${initA}"] [data-init-assistant-row="${firstId}"] [data-init-task-card="1"]`).click();
        await page.waitForSelector("#as-queue:not(.hidden)", { timeout: 15_000 });
        await page.waitForSelector('[data-as-qrow="1"]', { timeout: 15_000 });
        ok("the press opens the queue sub-tab", true);
        // The row is flashed and left inside the pane: the same walk `openTaskRef` makes for the console's #405 links.
        await waitFor(async () => page.evaluate(() => (window.__flashed || []).includes("1")), { timeoutMs: 10_000, what: "the row to flash" });
        ok("…flashes the row it opened", await page.evaluate(() => (window.__flashed || []).includes("1")), await page.evaluate(() => JSON.stringify(window.__flashed || [])));
        const inView = await page.evaluate(() => {
          const row = document.querySelector('[data-as-qrow="1"]');
          const pane = document.getElementById("as-queue");
          if (!row || !pane) return null;
          const r = row.getBoundingClientRect();
          return { inPane: pane.contains(row), onScreen: r.top >= 0 && r.bottom <= 900 };
        });
        ok("…and leaves it inside the queue pane, on screen", Boolean(inView?.inPane) && Boolean(inView?.onScreen), JSON.stringify(inView));
        const queueCard = await page.evaluate(() => {
          const row = document.querySelector('[data-as-qrow="1"]');
          if (!row) return null;
          return {
            cls: row.className,
            headParts: [...(row.querySelector(".as-task-head")?.children || [])].map((n) => (n.className || "").split(" ")[0]),
            acts: row.querySelectorAll("[data-as-qact]").length,
            buttons: row.querySelectorAll("button").length,
          };
        });
        check("the queue's card for the same task wears the same head, element for element", queueCard?.headParts, compactHeads[0]);
        ok("…and it is the FULL card: the actions are here, not on the compact one", (queueCard?.acts || 0) > 0 && (queueCard?.buttons || 0) > 0, `${queueCard?.acts} acts, ${queueCard?.buttons} buttons`);
        ok("…a mode the queue's own row never wears", !/(^|\s)is-compact(\s|$)/.test(queueCard?.cls || ""), queueCard?.cls || "");
        await shot("queue-from-the-card");

        // ---- 7. keyboard, Escape and the title press --------------------------------------------------
        console.log("\n== keyboard, Escape, the title ==");
        await openTab();
        await page.waitForSelector(`[data-init-card="${initA}"]`, { timeout: 20_000 });
        await waitFor(async () => ((await listCards(initA, firstId)) || []).length === 2, { timeoutMs: 15_000, what: "the fold's cards to come back" });
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
        await waitFor(async () => ((await listCards(initA, firstId)) || []).length === 2, { timeoutMs: 15_000, what: "the fold's cards to come back" });
        const survived = await page.evaluate(
          ([id, aid]) => {
            const card = document.querySelector(`[data-init-card="${id}"]`);
            return {
              card: card?.querySelector("[data-init-card-toggle]")?.getAttribute("aria-expanded"),
              fold: card?.querySelector(`[data-init-assistant-row="${aid}"] [data-init-task-fold]`)?.getAttribute("aria-expanded"),
              cards: card?.querySelectorAll(`[data-init-assistant-row="${aid}"] .as-task`).length || 0,
            };
          },
          [initA, firstId],
        );
        check("with the rail back, the fold is where the reader left it", survived, { card: "true", fold: "true", cards: 2 });
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

        // ---- 8. two assistants, each showing only its own rows ---------------------------------------
        console.log("\n== two assistants, two folds ==");
        if ((await fold(initA, secondId).getAttribute("aria-expanded")) !== "true") await fold(initA, secondId).click();
        await waitFor(async () => ((await listCards(initA, secondId)) || []).length === 2, { timeoutMs: 15_000, what: "the second assistant's cards" });
        const mine = (await listCards(initA, firstId)).map((c) => c.title);
        const theirs = (await listCards(initA, secondId)).map((c) => c.title);
        check("the first assistant's fold is its own two rows", mine, ["Wire the SSO callback", "Land the Menu login page"]);
        check("the second assistant's fold is its own two rows", theirs, ["Queue the gateway retry", "Wait for the DBA"]);
        ok("no row appears in both folds", mine.every((t) => !theirs.includes(t)), [...mine, ...theirs].join(" | "));
        const counts = await page.locator(`[data-init-card="${initA}"]`).evaluate((card) =>
          [...card.querySelectorAll(".init-assist")].map((row) => [row.dataset.initAssistantRow, row.querySelector("[data-init-task-count]")?.textContent.trim()]),
        );
        check("each fold counts its own rows", counts, [
          [firstId, "2"],
          [secondId, "2"],
        ]);
        await paneShot("two-assistants");

        // ---- 9. two initiatives, one tree; and the row no initiative carries -------------------------
        console.log("\n== the shared tree and the unlinked row ==");
        await page.locator(`[data-init-card="${initB}"]`).scrollIntoViewIfNeeded();
        await openCard(initB);
        await fold(initB, firstId).click();
        await waitFor(async () => ((await listCards(initB, firstId)) || []).length === 1, { timeoutMs: 15_000, what: "the second initiative's cards" });
        const underB = await listCards(initB, firstId);
        check("the shared tree's task shows under the second initiative too", underB.map((c) => c.title), ["Land the Menu login page"]);
        const underA = (await listCards(initA, firstId)).map((c) => c.title);
        ok("…and it is still under the first, once in each", underA.includes("Land the Menu login page") && underA.filter((t) => t === "Land the Menu login page").length === 1, `${underA.join(" | ")} / ${underB.map((c) => c.title).join(" | ")}`);
        const tabText = await page.locator("#as-initiatives").innerText();
        ok("a task on a tree no initiative carries appears nowhere on the tab", !tabText.includes("Nowhere work"));
        await paneShot("shared-tree");

        // ---- 10. the honest empty line ---------------------------------------------------------------
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

        // ---- 11. the fold's window --------------------------------------------------------------------
        console.log("\n== the fold's window ==");
        // Ten rows on the initiative: the fold opens at six, says what it is not showing in numbers it can stand by,
        // and one press draws the rest.
        const qdoc = JSON.parse(readFileSync(q1.file, "utf8"));
        qdoc.tasks.push(
          ...Array.from({ length: 8 }, (_, i) => ({
            id: 20 + i,
            title: `Bulk row ${i + 1}`,
            state: i % 2 === 0 ? "queued" : "done",
            worktree: slash(trees.ssoOne),
            project: "alpha",
            thread: `wtgui-bulk-${i + 1}`,
            createdAt: iso((i + 1) * 60_000),
            ...(i % 2 === 0 ? {} : { doneAt: iso((i + 1) * 60_000) }),
          })),
        );
        writeFileSync(q1.file, `${JSON.stringify(qdoc, null, 1)}\n`, "utf8");
        await page.locator(`[data-init-card="${initA}"]`).scrollIntoViewIfNeeded();
        await waitFor(async () => ((await listCards(initA, firstId)) || []).length === 6, { timeoutMs: 25_000, what: "the fold's six-card window" });
        const windowed = await listCards(initA, firstId);
        check("the fold draws six of the ten rows", [windowed.length, windowed[0].state], [6, "queued"]);
        ok("…the states being acted on first, so no done row leads", windowed.slice(0, 4).every((c) => c.state === "queued"), windowed.map((c) => c.state).join(","));
        const moreLine = await moreOf(initA, firstId).evaluate((el) => ({
          label: el.querySelector("[data-init-tasks-more]")?.textContent.trim() || "",
          left: el.querySelector("[data-init-tasks-left]")?.textContent.trim() || "",
        }));
        ok("…and says how many of how many", moreLine.left === "6 of 10 shown - 4 not shown", moreLine.left);
        ok("…beside one press naming its own step", moreLine.label === "Show 4 more", moreLine.label);
        await paneShot("window");
        await page.locator(`[data-init-card="${initA}"] [data-init-assistant-row="${firstId}"] [data-init-tasks-more]`).click();
        await waitFor(async () => ((await listCards(initA, firstId)) || []).length === 10, { timeoutMs: 15_000, what: "the rest of the fold" });
        ok("the press draws the rest", true);
        ok("…and the line retires when nothing is hidden", (await moreOf(initA, firstId).count()) === 0);
        await paneShot("window-all");

        // ---- 12. health ------------------------------------------------------------------------------
        console.log("\n== health ==");
        check("no page errors", pageErrors.map(String), []);
        check("no console errors", consoleErrors.map(String), []);
        // The page's own document is the one the gate read over HTTP, so a card cannot be on one and not the other.
        const wire = (await GET("/api/initiatives")).body;
        const wireRows = wire.initiatives.find((i) => i.id === initA)?.assistants.find((a) => a.id === firstId)?.taskRows || [];
        const drawn = await listCards(initA, firstId);
        check("the wire's rows and the cards on screen are the same ten", [wireRows.length, drawn.length], [10, 10]);
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
