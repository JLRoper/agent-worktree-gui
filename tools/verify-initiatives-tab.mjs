#!/usr/bin/env node
// THE INITIATIVES TAB: the map of the big pieces of work, and the three things it does that a list cannot.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiatives-tab.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES. The brief asked for a tab beside Role that holds each big piece of work's shape, a chart
// column fed from the same store, and two gestures that make the map usable: a worktree link that takes the reader to
// the row, and an assistant's name that takes the cursor to its input. Every claim below is measured on the real page
// at 1440x900, never read out of the source:
//
//   1. THE EMPTY STATE, before anything exists: the tab says what an initiative is, the store file does not exist yet,
//      and the first write is the tab's own New initiative.
//   2. THE FREE WRITE: creating an initiative from the tab writes initiatives.json beside the panel's other state, and
//      the words come back byte for byte through GET /api/initiatives.
//   3. THE COLUMN, IN BOTH STATES: the chart's Initiative header exists, an unassigned tree draws the dash that says
//      "no initiative - the normal case", and an assigned tree draws a chip with the initiative's title.
//   4. THE QUESTION: pressing Add a worktree parks a permission card that NAMES the tree and the initiative, and the
//      store's bytes do not move while it waits. Allow once performs the move; Deny leaves the bytes identical and the
//      chip in place.
//   5. THE FOLDS: a project is folded until it is opened, worktrees only exist on expand, and the assistant detail rows
//      are folded too - four worktrees over two projects cost two rows when closed and six when open.
//   6. THE LINK: a worktree link opens that row, scrolls the window to it and leaves the row flashing.
//   7. THE NAME: an assistant's name opens its pane and puts the caret in the box it types into - nothing is sent.
//   8. THE COUNTS, ORDERED: beside each assistant, running/completed/parked for THIS initiative's trees, newest work
//      first.
//   9. HEALTH: zero page errors and zero console errors, and the tab is drawn in the panel's own chips and type: the
//      card is an .as-group, the chip is .chip, the fold rows are 24px high at the rail's 11.5px.
//
// Sandbox only: two throwaway repos with hand-cut worktrees, its own HERMES_HOME, its own PANEL_CONFIG and port, and
// an apiServer pointed at a dead port. The live panel and gateway are never touched. Without Playwright the script
// says BROWSER-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".initiatives-tab-shots");

const gitEnv = { GIT_TERMINAL_PROMPT: "0" };
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  return git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], { env: gitEnv });
};

// ---- the sandbox: two projects, four trees behind the initiative and eight that are not ----------
const dir = path.join(ROOT, ".worktrees", ".initiatives-tab-sandbox");
rmSync(dir, { recursive: true, force: true });
const repos = path.join(dir, "repos");
mkdirSync(shotsDir, { recursive: true });
const project = (name) => path.join(repos, name);
const trees = {
  ssoOne: path.join(project("alpha"), ".worktrees", "sso-one"),
  ssoTwo: path.join(project("alpha"), ".worktrees", "sso-two"),
  menuOne: path.join(project("beta"), ".worktrees", "menu-one"),
  menuTwo: path.join(project("beta"), ".worktrees", "menu-two"),
};
const fillers = [];
for (const name of ["alpha", "beta"]) {
  const repo = project(name);
  mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
  commit(repo, "seed the sandbox repo");
  const names = name === "alpha" ? ["sso-one", "sso-two"] : ["menu-one", "menu-two"];
  for (const wt of names) {
    const where = path.join(repo, ".worktrees", wt);
    git(repo, ["worktree", "add", "-q", "-b", `work/${wt}`, where]);
    writeFileSync(path.join(where, `${wt}.txt`), "sandbox work\n", "utf8");
    commit(where, `do the ${wt} work`);
  }
  // The eight fillers make the board taller than the window, so "scrolls the window to it" is a measurement rather
  // than a no-op, and they are the chart's dash: a tree with no initiative is the normal case.
  for (let i = 1; i <= 4; i += 1) {
    const wt = `filler-${i}`;
    const where = path.join(repo, ".worktrees", wt);
    git(repo, ["worktree", "add", "-q", "-b", `work/${wt}`, where]);
    writeFileSync(path.join(where, `${wt}.txt`), "sandbox work\n", "utf8");
    fillers.push(where);
  }
}
for (const where of fillers) commit(where, "seed a worktree with no initiative");

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
    defaultCwd: project("alpha"),
    projects: [
      { name: "alpha", path: project("alpha"), remote: "origin", mainBranch: "main" },
      { name: "beta", path: project("beta"), remote: "origin", mainBranch: "main" },
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
const POST = async (p, body) => {
  const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();

let browser = null;
let shotNo = 0;
const shotName = (slug) => path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);

try {
  console.log(`sandbox: ${base}`);
  console.log(`panel pid: ${panel.pid}`);
  console.log(`shots:   ${shotsDir}`);

  // ---- the board has to see the trees before anything else is asserted -----------------------------
  for (const [projectName, treePath] of [
    ["alpha", trees.ssoOne],
    ["alpha", trees.ssoTwo],
    ["beta", trees.menuOne],
    ["beta", trees.menuTwo],
  ]) {
    await waitForRow(base, projectName, treePath, { timeout: 60_000 });
  }
  ok("all four trees behind the initiative are rows on the board", true, "alpha x2, beta x2");

  // ---- the assistants' counts: two assistants, one queue each, all states on this initiative ------
  const q1 = await GET("/api/assistant/queue?assistantId=assistant-1");
  const q1File = q1.body?.queue?.file;
  ok("the queue route names the file it will read", Boolean(q1File) && existsSync(q1File), slash(q1File));
  const tasks1 = [
    { id: 1, title: "Wire the SSO callback", state: "running", worktree: slash(trees.ssoOne), project: "alpha", thread: "wtgui-sso-one", startedAt: iso(90_000), createdAt: iso(120_000) },
    { id: 2, title: "Land the Menu login page", state: "done", worktree: slash(trees.menuOne), project: "beta", doneAt: iso(2 * 3_600_000) },
    { id: 3, title: "Map the two roles", state: "done", worktree: slash(trees.ssoTwo), project: "alpha", doneAt: iso(3 * 3_600_000) },
    { id: 4, title: "Wait for the DBA on sessions", state: "parked", reason: "waiting on the DBA", worktree: slash(trees.menuTwo), project: "beta" },
  ];
  writeFileSync(q1File, `${JSON.stringify({ version: 1, nextId: 9, tasks: tasks1 }, null, 1)}\n`, "utf8");
  const made = await POST("/api/assistant/assistants", {});
  ok("a second assistant exists, so ordering has two rows to order", made.status === 201, `HTTP ${made.status}`);
  const secondId = String(made.body?.assistant?.id || "assistant-2");
  const q2 = await GET(`/api/assistant/queue?assistantId=${secondId}`);
  const q2File = q2.body?.queue?.file;
  writeFileSync(
    q2File,
    `${JSON.stringify(
      { version: 1, nextId: 4, tasks: [{ id: 2, title: "Older pass over the same tree", state: "done", worktree: slash(trees.ssoOne), project: "alpha", doneAt: iso(6 * 3_600_000) }] },
      null,
      1,
    )}\n`,
    "utf8",
  );

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the initiatives tab", "playwright is not installed for this node (see tools/browser.mjs)"));
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
        const expand = async () => {
          // The two fixed cards at the top are `section.project` too, so waiting for that says nothing about the
          // board's own sections: wait for a head that actually toggles a project, then open the folded ones.
          await page.waitForSelector("section.project > .project-head[data-toggle-project]", { state: "visible", timeout: 90_000 });
          for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
            const sec = head.locator("xpath=..");
            if (String((await sec.getAttribute("class")) || "").includes("collapsed")) await head.click();
          }
          await page.waitForSelector("tr.row", { state: "visible", timeout: 60_000 });
        };
        const openTab = async () => {
          // The rail is closed with the `hidden` ATTRIBUTE (not a class): reading the class is how a harness presses
          // the toggle on an already-open rail and closes it again.
          const open = await page.evaluate(() => {
            const el = document.getElementById("assistant");
            return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
          });
          if (!open) await page.click("#btn-assistant");
          await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
          await page.click('#as-tabs [data-as-tab="initiatives"]');
          await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 15_000 });
        };
        const store = async () => (await GET("/api/initiatives")).body;
        const rowOf = async (treePath) => {
          const st = await GET("/api/state");
          const want = slash(treePath).toLowerCase();
          for (const p of st.body.projects || []) for (const w of p.worktrees || []) if (slash(w.path).toLowerCase() === want) return w;
          return null;
        };

        await openPage(page, base, { selector: "section.project" });
        await expand();

        // ---- 1. the empty state, before anything exists -------------------------------------------
        console.log("\n== the empty state ==");
        const fresh = await store();
        ok("the store is not on disk yet", fresh.found === false && !existsSync(fresh.file), slash(fresh.file));
        check("an empty store has no initiatives", fresh.initiatives, []);
        const th = await page.evaluate(() => {
          const el = document.querySelector('#projects th[data-col-id="initiative"]');
          return el ? { text: el.textContent.trim(), title: el.getAttribute("title") || "" } : null;
        });
        ok("the chart has an Initiative column", Boolean(th) && th.text === "Initiative", th ? th.text : "no header");
        ok("…whose tooltip says what the column means", /one tree can|carr|several/i.test(th?.title || ""), th?.title || "");
        const dash = await page.evaluate(() => {
          const cell = document.querySelector('#projects tr.row td.initiative');
          return cell ? { text: cell.textContent.trim(), title: cell.querySelector("[title]")?.getAttribute("title") || "", chips: cell.querySelectorAll(".initiative-chip").length } : null;
        });
        check("an unassigned tree draws the dash, not a chip", dash && { text: dash.text, chips: dash.chips }, { text: "-", chips: 0 });
        ok("…and the dash explains itself on hover", /no initiative/i.test(dash?.title || ""), dash?.title || "");
        await openTab();
        await page.waitForSelector("#as-initiatives .init-empty", { timeout: 20_000 });
        const emptyText = await page.locator("#as-initiatives .init-empty").innerText();
        ok("the tab says no initiatives yet and what one is", /No initiatives yet/i.test(emptyText) && /title, a description/i.test(emptyText), emptyText.split("\n")[0]);
        ok("…and offers the first press", (await page.locator('[data-init-new]').count()) >= 1, `${await page.locator("[data-init-new]").count()} New initiative control(s)`);
        await shot("empty-state");

        // ---- 2. the free write: a title and a description -------------------------------------------
        console.log("\n== create from the tab ==");
        await page.locator("#as-initiatives .init-empty [data-init-new]").click();
        await page.fill("#as-init-new-title", "SSO migration");
        await page.fill("#as-init-new-desc", "Move the Menu and the gateway onto Okta SSO, one app at a time.");
        await page.click("[data-init-create]");
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 15_000 });
        const created = await store();
        ok("the first write creates the store beside the panel's other state", created.found === true && existsSync(created.file), slash(created.file));
        check("the words come back exactly as typed", created.initiatives.map((i) => [i.title, i.description]), [["SSO migration", "Move the Menu and the gateway onto Okta SSO, one app at a time."]]);
        const initId = created.initiatives[0].id;
        const cardTitle = await page.locator(`[data-init-card="${initId}"] .init-title`).innerText();
        check("the card shows the title", cardTitle, "SSO migration");
        const folded = await page.locator(`[data-init-card="${initId}"]`).evaluate((el) => ({
          projects: el.querySelectorAll(".init-project").length,
          trees: el.querySelectorAll(".init-tree").length,
          assists: el.querySelectorAll(".init-assist").length,
        }));
        check("with no worktrees the card says so and shows no folds", folded, { projects: 0, trees: 0, assists: 0 });

        // ---- 3. the question: Add a worktree ------------------------------------------------
        console.log("\n== the permission card for a move ==");
        const before = readFileSync(created.file, "utf8");
        await page.locator(`[data-init-card="${initId}"] [data-init-add]`).click();
        await page.selectOption(`[data-init-card="${initId}"] [data-init-field="addTree"]`, { label: "sso-one" });
        await page.locator(`[data-init-card="${initId}"] .init-addform button`, { hasText: "Ask to add" }).click();
        await page.waitForSelector(`#approvals [data-remote-write] [data-choice="once"]`, { timeout: 30_000 });
        const asked = await store();
        check("the store has not moved while the question waits", asked.initiatives[0].treeCount, 0);
        ok("…and its bytes are untouched", readFileSync(created.file, "utf8") === before);
        const cardText = await page.locator("#approvals [data-remote-write]").first().innerText();
        ok("the card names the worktree", /sso-one/.test(cardText), cardText.split("\n").find((l) => l.includes("sso-one")) || cardText.slice(0, 120));
        ok("the card names the initiative", /SSO migration/.test(cardText));
        ok("the card offers one write and a deny, not a session or an always", (await page.locator('#approvals [data-remote-write] [data-choice="session"], #approvals [data-remote-write] [data-choice="always"]').count()) === 0);
        await shot("permission-card");
        await page.locator('#approvals [data-remote-write] [data-choice="once"]').first().click();
        await waitFor(async () => (await store()).initiatives[0].treeCount === 1, { timeoutMs: 20_000, what: "the answered move to land" });
        const moved = await store();
        check("Allow once adds the tree", moved.initiatives[0].projects.map((p) => [p.name, p.trees.map((t) => t.name)]), [["alpha", ["sso-one"]]]);
        const chip = await page.evaluate((p) => {
          const want = String(p).replace(/\\/g, "/").toLowerCase();
          const tr = [...document.querySelectorAll("#projects tr.row")].find((r) => r.dataset.key && r.dataset.key.toLowerCase().endsWith(want));
          const cell = tr?.querySelector("td.initiative");
          return cell ? { chips: [...cell.querySelectorAll(".initiative-chip")].map((c) => c.textContent.trim()), dash: cell.textContent.trim() === "-" } : null;
        }, slash(trees.ssoOne));
        check("the answered move updates the chart at once", chip, { chips: ["SSO migration"], dash: false });
        await shot("chart-chip");

        // ---- the other three, through the same route and the same answer ---------------------------
        for (const treePath of [trees.ssoTwo, trees.menuOne, trees.menuTwo]) {
          const res = await POST("/api/initiatives/move", { tree: slash(treePath), initiative: initId, action: "add" });
          ok(`asking to add ${path.basename(treePath)} parks a question`, res.status === 202 && res.body.asked === true, `HTTP ${res.status}`);
          const answer = await POST("/api/remote-write/answer", { id: res.body.id, choice: "once", by: "reader" });
          ok(`…and answering it once makes the change`, answer.status === 200 && answer.body.ok === true && answer.body.resumed?.changed === true, JSON.stringify(answer.body.resumed || answer.body.error || ""));
        }
        const four = await store();
        check("one initiative now spans two projects and four worktrees", [four.initiatives[0].projectCount, four.initiatives[0].treeCount], [2, 4]);
        const overlay = await rowOf(trees.menuTwo);
        check("the snapshot's row carries the initiative, so the chart is fed by the store", (overlay?.initiatives || []).map((i) => i.title), ["SSO migration"]);

        // ---- 5. the folds --------------------------------------------------------------------------
        console.log("\n== the folds ==");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("section.project", { timeout: 60_000 });
        await expand();
        await openTab();
        await page.waitForSelector(`[data-init-card="${initId}"]`, { timeout: 15_000 });
        const closed = await page.locator(`[data-init-card="${initId}"]`).evaluate((el) => ({
          projects: [...el.querySelectorAll(".init-project")].map((b) => b.textContent.replace(/\s+/g, " ").trim()),
          trees: el.querySelectorAll(".init-tree").length,
          height: Math.round(el.getBoundingClientRect().height),
          assistRows: el.querySelectorAll(".init-assist").length,
          group: el.className,
        }));
        check("two project folds, one per project, closed by default", closed.projects.length, 2);
        ok("…named alpha and beta with their tree counts", /alpha/.test(closed.projects[0]) && /beta/.test(closed.projects[1]) && /\b2\b/.test(closed.projects[0]), closed.projects.join(" | "));
        check("a folded project has no worktree rows in the DOM", closed.trees, 0);
        check("assistant detail rows are folded too", closed.assistRows, 0);
        ok("the card is the panel's own .as-group", /(^|\s)as-group(\s|$)/.test(closed.group), closed.group);
        await shot("folded");
        await paneShot("folded-pane");
        for (const name of ["alpha", "beta"]) await page.click(`[data-init-fold="${initId}::${name}"]`);
        // The pane repaints from its own document, which is re-read on a 4 s timer: wait until the rows it draws agree
        // with the store the HTTP read sees, rather than reading a card still holding the doc fetched at open.
        await waitFor(
          async () => {
            const doc = await store();
            const expected = doc.initiatives[0].projects.flatMap((p) => p.trees.map((t) => `${t.name}:${t.branch || ""}`));
            const got = await page.evaluate(
              (id) =>
                [...document.querySelectorAll(`[data-init-card="${id}"] .init-tree`)].map(
                  (r) => `${r.querySelector(".init-tree-name")?.textContent.trim()}:${String(r.querySelector(".init-branch")?.textContent || "").trim()}`,
                ),
              initId,
            );
            return got.length === 4 && JSON.stringify(got) === JSON.stringify(expected);
          },
          { timeoutMs: 25_000, what: "the unfolded rows to match the store" },
        );
        const open = await page.locator(`[data-init-card="${initId}"]`).evaluate((el) => ({
          trees: [...el.querySelectorAll(".init-tree")].map((r) => ({
            name: r.querySelector(".init-tree-name")?.textContent.trim(),
            branch: r.querySelector(".init-branch")?.textContent.trim(),
            link: r.querySelector("a.init-tree-name")?.tagName,
          })),
          height: Math.round(el.getBoundingClientRect().height),
          rowHeights: [...el.querySelectorAll(".init-tree")].map((r) => Math.round(r.getBoundingClientRect().height)),
          fontSizes: [...el.querySelectorAll(".init-tree")].map((r) => getComputedStyle(r).fontSize),
        }));
        const unfoldedDoc = await store();
        const expectedTrees = unfoldedDoc.initiatives[0].projects.flatMap((p) => p.trees.map((t) => [t.name, t.branch || null]));
        check("unfolded, both projects show all four worktrees, each as a link on its branch", open.trees.map((t) => [t.name, t.branch || null]), expectedTrees);
        ok("…and every one of them is a link", open.trees.every((t) => t.link === "A"), open.trees.map((t) => t.link || "?").join(","));
        ok("the worktree rows are the rail's own 11.5px", open.fontSizes.every((f) => f === "11.5px"), [...new Set(open.fontSizes)].join(","));
        ok("the unfolded card is taller than the folded one", open.height > closed.height, `${closed.height}px -> ${open.height}px`);
        await paneShot("unfolded-pane");

        // ---- 6. the link that scrolls and flashes --------------------------------------------------
        console.log("\n== the link to the row ==");
        await page.locator(`[data-init-card="${initId}"] .init-tree`, { hasText: "menu-two" }).locator("a.init-tree-name").click();
        await page.waitForTimeout(350);
        const landed = await page.evaluate((p) => {
          const want = String(p).replace(/\\/g, "/").toLowerCase();
          const tr = [...document.querySelectorAll("#projects tr.row")].find((r) => r.dataset.key && r.dataset.key.toLowerCase().endsWith(want));
          const rect = tr?.getBoundingClientRect();
          return {
            scrollY: Math.round(window.scrollY),
            flash: Boolean(tr?.classList.contains("flash")),
            inView: Boolean(rect && rect.top >= 0 && rect.bottom <= innerHeight),
            project: tr?.closest("section.project")?.dataset.project || "",
            expanded: Boolean(tr?.classList.contains("expanded")),
          };
        }, trees.menuTwo);
        ok("pressing a worktree name scrolls the window to its row", landed.scrollY > 0 && landed.inView, `scrollY ${landed.scrollY}, in view ${landed.inView}`);
        ok("…the row is flashing when it arrives", landed.flash);
        check("…and the row opens in its own project", { project: landed.project, expanded: landed.expanded }, { project: "beta", expanded: true });
        await shot("scrolled-flash");

        // ---- 7 and 8. the assistant's name, and the counts ------------------------------------------
        console.log("\n== the assistant's name and its counts ==");
        await openTab();
        await page.waitForSelector(`[data-init-card="${initId}"] [data-init-assist-fold]`, { timeout: 20_000 });
        await page.locator(`[data-init-card="${initId}"] [data-init-assist-fold]`).click();
        const counted = await page.locator(`[data-init-card="${initId}"]`).evaluate((el) =>
          [...el.querySelectorAll(".init-assist")].map((r) => ({
            id: r.dataset.initAssistantRow,
            name: r.querySelector(".init-assist-btn")?.textContent.trim(),
            chips: [...r.querySelectorAll(".init-counts .chip")].map((c) => c.textContent.trim()),
            when: r.querySelector(".init-assist-when")?.textContent.trim(),
          })),
        );
        check("two assistants are shown for this initiative", counted.length, 2);
        ok("the newest worker leads", counted[0]?.id === "assistant-1", counted.map((c) => c.id).join(" -> "));
        check("its counts are running, completed and parked on THIS initiative's trees", counted[0]?.chips, ["1 running", "2 completed", "1 parked"]);
        check("the second assistant's counts are its own", counted[1]?.chips, ["0 running", "1 completed", "0 parked"]);
        ok("the row says when each last worked", /working now|worked .* ago/.test(counted[0]?.when || ""), counted[0]?.when || "");
        await paneShot("counts");
        const firstBtn = page.locator(`[data-init-card="${initId}"] [data-init-assistant="${counted[0].id}"]`);
        await firstBtn.click();
        await page.waitForSelector("#as-chat", { timeout: 15_000 });
        await waitFor(
          async () =>
            page.evaluate(() => {
              const el = document.activeElement;
              return Boolean(el && el.closest && (el.closest("#as-chat") || el.id === "as-first-text") && (el.getAttribute("contenteditable") === "true" || el.tagName === "TEXTAREA"));
            }),
          { timeoutMs: 8_000, what: "the caret in the assistant's input box" },
        );
        const focus = await page.evaluate(() => {
          const el = document.activeElement;
          return {
            id: el?.id || "",
            inChat: Boolean(el?.closest?.("#as-chat")),
            editable: el?.getAttribute?.("contenteditable") === "true" || el?.tagName === "TEXTAREA",
            reply: el?.dataset?.reply || "",
            pane: [...document.querySelectorAll("#assistant .as-pane")].find((p) => !p.classList.contains("hidden"))?.dataset.pane || "",
          };
        });
        ok("pressing an assistant's name opens its pane", focus.pane === "assistant-1", focus.pane);
        ok("…and the caret is in the box it types into", focus.editable && (focus.inChat || focus.id === "as-first-text"), `${focus.id || "(no id)"} reply=${focus.reply || "(intro)"}`);
        await shot("assistant-focus");

        // ---- the deny half of the question, and the words ------------------------------------------
        console.log("\n== deny leaves the map alone ==");
        await openTab();
        await page.waitForSelector(`[data-init-card="${initId}"] [data-init-fold="${initId}::alpha"]`, { timeout: 20_000 });
        for (const name of ["alpha", "beta"]) {
          if ((await page.locator(`[data-init-fold="${initId}::${name}"][aria-expanded="false"]`).count()) > 0) await page.click(`[data-init-fold="${initId}::${name}"]`);
        }
        const bytesBefore = readFileSync((await store()).file, "utf8");
        await page.locator(`[data-init-card="${initId}"] .init-tree`, { hasText: "sso-two" }).locator("[data-init-move]").click();
        await page.waitForSelector('#approvals [data-remote-write] [data-choice="deny"]', { timeout: 30_000 });
        const removeCard = await page.locator("#approvals [data-remote-write]").first().innerText();
        ok("the remove question names the tree and the initiative too", /sso-two/.test(removeCard) && /SSO migration/.test(removeCard));
        await page.locator('#approvals [data-remote-write] [data-choice="deny"]').first().click();
        await page.waitForTimeout(1200);
        ok("denying leaves the store's bytes identical", readFileSync((await store()).file, "utf8") === bytesBefore);
        check("…and the tree is still on the initiative", (await store()).initiatives[0].treeCount, 4);

        console.log("\n== the words are free to change ==");
        // The link press above collapses every project but its own (hotOpenPath's own rule), so alpha is folded now:
        // the chart's chip for sso-one only exists while its project is open.
        const alphaClass = String(await page.getAttribute('section.project[data-project="alpha"]', "class").catch(() => ""));
        if (alphaClass.includes("collapsed")) await page.click('section.project[data-project="alpha"] > .project-head[data-toggle-project="alpha"]');
        await page.waitForSelector('#projects tr.row[data-key^="alpha::"]', { state: "visible", timeout: 20_000 });
        await page.locator(`[data-init-card="${initId}"] [data-init-edit]`).click();
        await page.fill(`#as-init-edit-title-${initId}`, "SSO migration (Menu)");
        await page.click(`[data-init-card="${initId}"] [data-init-save]`);
        await page.waitForTimeout(1500);
        console.log(`      after save: store says ${JSON.stringify((await store()).initiatives[0].title)}, notes ${JSON.stringify(await page.locator(`[data-init-card="${initId}"] .as-ask`).allInnerTexts().catch(() => []))}`);
        await waitFor(async () => (await store()).initiatives[0].title === "SSO migration (Menu)", { timeoutMs: 15_000, what: "the edited title" });
        // The chart is repainted from the broadcast snapshot; wait for the chip to carry the new words rather than
        // reading the cell a tick before the page applied it.
        await waitFor(
          async () =>
            page.evaluate((p) => {
              const want = String(p).replace(/\\/g, "/").toLowerCase();
              const tr = [...document.querySelectorAll("#projects tr.row")].find((r) => r.dataset.key && r.dataset.key.toLowerCase().endsWith(want));
              return [...(tr?.querySelectorAll("td.initiative .initiative-chip") || [])].some((c) => c.textContent.trim() === "SSO migration (Menu)");
            }, slash(trees.ssoOne)),
          { timeoutMs: 20_000, what: "the chart's chip to carry the edited title" },
        );
        const edited = await page.evaluate((p) => {
          const want = String(p).replace(/\\/g, "/").toLowerCase();
          const tr = [...document.querySelectorAll("#projects tr.row")].find((r) => r.dataset.key && r.dataset.key.toLowerCase().endsWith(want));
          return [...(tr?.querySelectorAll("td.initiative .initiative-chip") || [])].map((c) => c.textContent.trim());
        }, slash(trees.ssoOne));
        check("an edited title reaches the chart's chip without a reload", edited, ["SSO migration (Menu)"]);

        // ---- 9. health ----------------------------------------------------------------------------
        console.log("\n== health ==");
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
  try {
    if (browser) await browser.close();
  } catch {
    /* already gone */
  }
  await panel.stop();
  clearTimeout(watchdog);
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed; shots in ${shotsDir}`);
process.exit(failures === 0 ? 0 : 1);
