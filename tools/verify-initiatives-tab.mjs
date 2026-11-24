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
// at 1440x900 - except claim 9, which is measured at the two narrow docks - never read out of the source:
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
//   5. THE FOLDS: a card starts as its TITLE CARD - a title, a two-line preview of the description and the counts -
//      and a press anywhere on the title unfolds it. Inside an open card the description is CLAMPED to three lines
//      (row 295, ask 2) with the whole text still in the DOM, and its show more / show less control - a button, so it
//      gives Enter or Space - lifts the clamp; the card's own state is not touched by it. A project is folded
//      until it is opened, worktrees only exist on expand, and the assistant detail rows are folded too. The preview
//      is two line boxes of the card's own prose, cut on a word boundary, with three dots only when there is more
//      text than those two lines.
//   6. THE LINK: a worktree link acts on itself - it opens that row, scrolls the window to it and leaves the row
//      flashing - and the initiative's card is still open behind it.
//   7. THE NAME: an assistant's name opens its pane and puts the caret in the box it types into - nothing is sent.
//   8. THE COUNTS, ORDERED: beside each assistant, queued/running/completed/parked for THIS initiative's trees,
//      newest work first, all four drawn always - a zero is a chip, not an absence - so the strip never shifts.
//   9. THE TOOLBAR AT THE NARROW DOCK: the four actions read New initiative, Refresh, About, Compact rows - in that
//      order, which is also the keyboard order - and they share one row in the 347px pane a 768 window draws and the
//      239px pane a 480 window draws. The density control shortens to Density and then to Aa, and the primary to New,
//      rather than letting Refresh orphan onto a second row; the short forms keep the full names in aria-label.
//  10. HEALTH: zero page errors and zero console errors, and the tab is drawn in the panel's own chips and type: the
//      card is an .as-group, the chip is .chip, and the type follows the tab's five steps (title 15.5, body 12.5,
//      meta 11.5, chip 10.5).
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

  // THE LEVEL THE FREE-WRITE HALF NEEDS. The panel's default is "all" (every create, edit, attach and detach asks),
  // so the first write from the tab parks a question and this gate could never reach its own free create. "remove"
  // asks only a detach, which is the level the deny half below is about; the attach half sets "all" for itself.
  const bootTier = await POST("/api/settings/initiative-tier", { tier: "remove" });
  ok("the tier is set to removals only, so creating is free", bootTier.status === 200 && bootTier.body?.initiativeTier === "remove", `HTTP ${bootTier.status} ${bootTier.body?.initiativeTier || ""}`);

  // ---- the assistants' counts: two assistants, one queue each, all states on this initiative ------
  const q1 = await GET("/api/assistant/queue?assistantId=assistant-1");
  const q1File = q1.body?.queue?.file;
  ok("the queue route names the file it will read", Boolean(q1File) && existsSync(q1File), slash(q1File));
  const tasks1 = [
    { id: 1, title: "Wire the SSO callback", state: "running", worktree: slash(trees.ssoOne), project: "alpha", thread: "wtgui-sso-one", startedAt: iso(90_000), createdAt: iso(120_000) },
    { id: 2, title: "Land the Menu login page", state: "done", worktree: slash(trees.menuOne), project: "beta", doneAt: iso(2 * 3_600_000) },
    { id: 3, title: "Map the two roles", state: "done", worktree: slash(trees.ssoTwo), project: "alpha", doneAt: iso(3 * 3_600_000) },
    { id: 4, title: "Wait for the DBA on sessions", state: "parked", reason: "waiting on the DBA", worktree: slash(trees.menuTwo), project: "beta" },
    // Filed and not started: the first chip of the strip, counted by the same read as the other three.
    { id: 5, title: "Queue the gateway retry", state: "queued", worktree: slash(trees.ssoTwo), project: "alpha", createdAt: iso(30_000) },
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
        // Three paragraphs, the first long enough to run past two lines at the rail's width: the preview has to cut
        // inside it, and the expanded description has to show the breaks the reader typed.
        const descWords = [
          "Move the Menu and the gateway onto Okta SSO, one app at a time, so a cutover that goes wrong is one app and one toggle away from the way it works today.",
          "The Menu is the last surface still on LDAP, and the gateway carries the sessions the Menu reads. Both go through the same Okta org, so cutting over one app at a time keeps the blast radius small and the rollback a single toggle.",
          "Done when a reader signs in to the Menu through Okta and the gateway still answers its own callers.",
        ].join("\n\n");
        await page.fill("#as-init-new-desc", descWords);
        await page.click("[data-init-create]");
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 15_000 });
        const created = await store();
        ok("the first write creates the store beside the panel's other state", created.found === true && existsSync(created.file), slash(created.file));
        check("the words come back exactly as typed", created.initiatives.map((i) => [i.title, i.description]), [["SSO migration", descWords]]);
        const initId = created.initiatives[0].id;
        const cardTitle = await page.locator(`[data-init-card="${initId}"] .init-title`).innerText();
        check("the card shows the title", cardTitle, "SSO migration");
        const firstDraw = await page.locator(`[data-init-card="${initId}"]`).evaluate((el) => ({
          titlecard: /is-titlecard/.test(el.className),
          projects: el.querySelectorAll(".init-project").length,
          desc: el.querySelector(".init-desc")?.textContent || "",
          head: el.querySelector("[data-init-card-toggle]")?.getAttribute("aria-expanded"),
        }));
        ok("a new card arrives as its title card: the title, a fold control saying so, and no body", firstDraw.titlecard && firstDraw.head === "false" && firstDraw.projects === 0, `titlecard=${firstDraw.titlecard} aria-expanded=${firstDraw.head}`);
        ok("…with the description's preview already drawn", firstDraw.desc.startsWith("Move the Menu and the gateway onto Okta SSO"), firstDraw.desc.slice(0, 60));
        // Unfold it: the body of a card with no worktrees says so, and shows no folds. Every step below needs the
        // body in the DOM, which is the point of the fold.
        await page.locator(`[data-init-card="${initId}"] .init-title`).click();
        await page.waitForSelector(`[data-init-card="${initId}"] .init-no-trees`, { timeout: 15_000 });
        const folded = await page.locator(`[data-init-card="${initId}"]`).evaluate((el) => ({
          projects: el.querySelectorAll(".init-project").length,
          trees: el.querySelectorAll(".init-tree").length,
          assists: el.querySelectorAll(".init-assist").length,
        }));
        check("with no worktrees the card says so and shows no folds", folded, { projects: 0, trees: 0, assists: 0 });

        // ---- 3. the question: Add a worktree ------------------------------------------------
        // THE LEVEL EACH HALF NEEDS. The gate's two claims - a create made at once, and an attach that parks a
        // question - are not one of the four levels: "all" asks a create too, "remove" asks only a detach. (The
        // product's default is "all", which is why this gate could no longer reach its free write.) So the gate sets
        // the level each half needs through the same settings route the reader's select writes: "remove" for the free
        // create above, "all" for the four attaches here, "remove" again once they have landed.
        console.log("\n== the permission card for a move ==");
        const askAll = await POST("/api/settings/initiative-tier", { tier: "all" });
        ok("the tier is set to ask about every change", askAll.status === 200, `HTTP ${askAll.status} ${askAll.body?.initiativeTier || ""}`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("section.project", { timeout: 60_000 });
        await expand();
        await openTab();
        await page.waitForSelector(`[data-init-card="${initId}"]`, { timeout: 20_000 });
        await page.locator(`[data-init-card="${initId}"] .init-head-btn`).click();
        await page.waitForSelector(`[data-init-card="${initId}"] [data-init-add]`, { timeout: 20_000 });
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
        const chipCell = async () =>
          page.evaluate((p) => {
            const want = String(p).replace(/\\/g, "/").toLowerCase();
            const tr = [...document.querySelectorAll("#projects tr.row")].find((r) => r.dataset.key && r.dataset.key.toLowerCase().endsWith(want));
            const cell = tr?.querySelector("td.initiative");
            return cell ? { chips: [...cell.querySelectorAll(".initiative-chip")].map((c) => c.textContent.trim()), dash: cell.textContent.trim() === "-" } : null;
          }, slash(trees.ssoOne));
        // The chart cell is repainted from the broadcast snapshot, so wait for it to carry the chip rather than
        // reading the cell a tick before the page applied it - the same race the edited-title check below guards.
        await waitFor(async () => Boolean((await chipCell())?.chips?.length), { timeoutMs: 15_000, what: "the chart's chip after the answered move" });
        const chip = await chipCell();
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
        // Back to "remove": a detach still asks (the deny half below), while the second create and the edit further
        // down are made at once, which is what those checks are about.
        const askRemovals = await POST("/api/settings/initiative-tier", { tier: "remove" });
        ok("the tier is set back to removals only", askRemovals.status === 200, `HTTP ${askRemovals.status} ${askRemovals.body?.initiativeTier || ""}`);

        // ---- 5. the folds --------------------------------------------------------------------------
        // TWO FOLDS, TWO STATES. The card starts as its title card (title, preview, counts) and a press anywhere on
        // the title unfolds it; the description then folds on its own inside the open card. The card's own state and
        // the description's are kept apart, so every claim below reads both aria-expanded attributes and both
        // drawings, and the screenshots show each state of each fold.
        console.log("\n== the folds ==");
        // One read of the card, the way a reader sees it: both fold headers' state, what the description draws (its
        // line boxes, its dots) and how much of the body is in the DOM.
        const cardState = async () =>
          page.locator(`[data-init-card="${initId}"]`).evaluate((el) => {
            const head = el.querySelector("[data-init-card-toggle]");
            const dhead = el.querySelector("[data-init-desc-fold]");
            const desc = el.querySelector("[data-init-desc-body]");
            const dots = desc?.querySelector(".init-dots");
            const cs = desc ? getComputedStyle(desc) : null;
            let lines = 0;
            if (desc) {
              const range = document.createRange();
              range.selectNodeContents(desc);
              lines = new Set([...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => Math.round(r.top))).size;
            }
            return {
              group: el.className,
              open: head?.getAttribute("aria-expanded") === "true",
              headTag: head?.tagName || "",
              headText: head?.textContent.replace(/\s+/g, " ").trim() || "",
              // THE CARET ITSELF. A glyph element carrying its text, and the computed size/colour it is painted at - so
              // the gate asserts a drawn open caret, not "the head does not end with the folded one".
              caret: head?.querySelector(".init-caret")?.textContent || "",
              caretOpen: Boolean(head?.querySelector(".init-caret.is-open")),
              caretFs: head?.querySelector(".init-caret") ? getComputedStyle(head.querySelector(".init-caret")).fontSize : "",
              descOpen: dhead?.getAttribute("aria-expanded") === "true",
              hasDescHeader: Boolean(dhead),
              descHeadTag: dhead?.tagName || "",
              // THE CLAMP (row 295, ask 2): whether the control is drawn at all, what it says, and whether the body is
              // the clamped drawing. `text` is the body's own textContent, so "the whole text is still in the DOM" is
              // read from the DOM and not from the store.
              descMore: dhead?.textContent.replace(/\s+/g, " ").trim() || "",
              descMoreHidden: dhead ? dhead.hidden : null,
              descMoreBox: dhead ? Math.round(dhead.getBoundingClientRect().height) : 0,
              descClamped: Boolean(desc?.classList.contains("is-clamped")),
              descHeight: desc ? Math.round(desc.getBoundingClientRect().height) : 0,
              descLineHeight: desc ? Math.round(parseFloat(getComputedStyle(desc).lineHeight) || 0) : 0,
              projects: el.querySelectorAll(".init-project").length,
              trees: el.querySelectorAll(".init-tree").length,
              assistRows: el.querySelectorAll(".init-assist").length,
              edit: el.querySelectorAll("[data-init-edit]").length,
              dots: dots?.textContent || "",
              text: desc?.textContent || "",
              lines,
              font: cs?.fontSize || "",
              white: cs?.whiteSpace || "",
              height: Math.round(el.getBoundingClientRect().height),
            };
          });
        const waitDesc = async (want) =>
          page.waitForFunction(
            ([id, open]) => document.querySelector(`[data-init-card="${id}"] [data-init-desc-fold]`)?.getAttribute("aria-expanded") === open,
            [initId, want ? "true" : "false"],
            { timeout: 15_000 },
          );
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("section.project", { timeout: 60_000 });
        await expand();
        await openTab();
        await page.waitForSelector(`[data-init-card="${initId}"]`, { timeout: 15_000 });
        const storeDesc = (await store()).initiatives[0].description;
        const titleCard = await cardState();
        ok("a card starts as its title card", /(^|\s)is-titlecard(\s|$)/.test(titleCard.group), titleCard.group);
        ok("…whose title is the fold's own button, saying it is folded", titleCard.headTag === "BUTTON" && titleCard.open === false && titleCard.headText.startsWith("SSO migration") && titleCard.caret === "▸" && !titleCard.caretOpen, `${titleCard.headTag} aria-expanded=${titleCard.open} caret=${JSON.stringify(titleCard.caret)} ${titleCard.headText}`);
        check("…with the body behind the fold: no project folds, no worktree rows, no Edit", { projects: titleCard.projects, trees: titleCard.trees, edit: titleCard.edit }, { projects: 0, trees: 0, edit: 0 });
        check("the collapsed card shows the description's first two lines", titleCard.lines, 2);
        check("…and no header to fold: a title card has nothing inside it to fold", titleCard.hasDescHeader, false);
        ok("…ending with three dots because there is more text", titleCard.dots === "...", JSON.stringify(titleCard.text.slice(-40)));
        const previewText = titleCard.text.replace(/\.\.\.$/, "");
        ok(
          "…cut on a word boundary, never mid-word",
          storeDesc.startsWith(previewText) && /^\s/.test(storeDesc.slice(previewText.length)),
          JSON.stringify(storeDesc.slice(Math.max(0, previewText.length - 14), previewText.length + 14)),
        );
        ok("the preview is the rail's own prose at the body step, pre-wrapped so its breaks survive", titleCard.font === "12.5px" && titleCard.white === "pre-wrap", `${titleCard.font} ${titleCard.white}`);
        await shot("title-card-preview");
        await paneShot("title-card-preview-pane");

        // A press on the TITLE WORDS, not on the chevron: the whole title card is the control.
        await page.locator(`[data-init-card="${initId}"] .init-title`).click();
        await page.waitForSelector(`[data-init-card="${initId}"] .init-project`, { timeout: 15_000 });
        const opened = await cardState();
        ok("a press on the title card unfolds it, and the open head draws the open caret", opened.open === true && opened.caret === "▾" && opened.caretOpen === true && opened.headText.endsWith("▾") && opened.caretFs === "11px", `aria-expanded=${opened.open} caret=${JSON.stringify(opened.caret)} ${opened.caretFs} ${opened.headText}`);
        check("…its body is drawn: two project folds, no worktree rows yet, Edit present", { projects: opened.projects, trees: opened.trees, edit: opened.edit }, { projects: 2, trees: 0, edit: 1 });
        // ROW 295, ASK 2: an expanded card opens CLAMPED, with show more drawn because this description overflows.
        ok(
          "…and the description is clamped to three lines, its show more control drawn because it overflows",
          opened.descOpen === false && opened.descClamped === true && opened.descHeight === opened.descLineHeight * 3 && opened.descMore === "show more" && opened.descMoreHidden === false && opened.descMoreBox > 0 && opened.dots === "",
          `clamped=${opened.descClamped} ${opened.descHeight}px / ${opened.descLineHeight}px per line, control ${JSON.stringify(opened.descMore)} hidden=${opened.descMoreHidden} ${opened.descMoreBox}px`,
        );
        check("…and THE WHOLE TEXT IS STILL IN THE DOM, not a cut copy of it", opened.text, storeDesc);
        ok("…which is more lines than the preview drew", opened.lines > titleCard.lines, `${titleCard.lines} -> ${opened.lines} line boxes drawn`);
        await paneShot("card-open-description-clamped");
        await shot("card-open-description-clamped-page");

        // ---- show more: the clamp lifts, the card stays open -----------------------------------------
        await page.locator(`[data-init-card="${initId}"] [data-init-desc-fold]`).click();
        await waitDesc(true);
        const descWhole = await cardState();
        ok("pressing show more lifts only the clamp", descWhole.open === true && descWhole.descOpen === true && descWhole.descClamped === false, `card ${descWhole.open}, description whole ${descWhole.descOpen}, clamped ${descWhole.descClamped}`);
        check("…the card's body is still drawn", descWhole.projects, 2);
        ok("…the whole description is drawn, and the control now says show less", descWhole.descHeight > descWhole.descLineHeight * 3 && descWhole.descMore === "show less" && descWhole.descMoreHidden === false, `${descWhole.descHeight}px drawn, control ${JSON.stringify(descWhole.descMore)}`);
        check("…and it is the store's text, breaks and all, before and after", [opened.text, descWhole.text], [storeDesc, storeDesc]);
        await paneShot("card-open-description-whole");

        await page.locator(`[data-init-card="${initId}"] [data-init-desc-fold]`).click();
        await waitDesc(false);
        const descReclamped = await cardState();
        ok("pressing show less clamps it again, and the card is still open", descReclamped.descOpen === false && descReclamped.descClamped === true && descReclamped.open === true && descReclamped.descMore === "show more", `desc ${descReclamped.descOpen}, card ${descReclamped.open}`);
        await paneShot("card-open-description-reclamped");

        // ---- a keyboard-only toggle: the control is a button, so Enter and Space are the browser's -----------------
        await page.locator(`[data-init-card="${initId}"] [data-init-desc-fold]`).focus();
        const focusedBefore = await page.evaluate(() => document.activeElement?.hasAttribute?.("data-init-desc-fold") || false);
        ok("the description's show more control takes the keyboard's focus", focusedBefore);
        await page.keyboard.press("Enter");
        await waitDesc(true);
        const byEnter = await cardState();
        ok("Enter on it lifts the clamp, and leaves the card open", byEnter.descOpen === true && byEnter.descClamped === false && byEnter.open === true, `desc ${byEnter.descOpen}, card ${byEnter.open}`);
        await page.locator(`[data-init-card="${initId}"] [data-init-desc-fold]`).focus();
        await page.keyboard.press("Space");
        await waitDesc(false);
        const bySpace = await cardState();
        ok("Space on it clamps it again, and the card is still open", bySpace.descOpen === false && bySpace.descClamped === true && bySpace.open === true, `desc ${bySpace.descOpen}, card ${bySpace.open}`);
        await paneShot("keyboard-toggle");
        await page.locator(`[data-init-card="${initId}"] [data-init-card-toggle]`).focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction((id) => document.querySelector(`[data-init-card="${id}"] [data-init-card-toggle]`)?.getAttribute("aria-expanded") === "false", initId, { timeout: 15_000 });
        const cardByKeyboard = await cardState();
        ok("Enter on the title card folds the initiative too", cardByKeyboard.open === false && /is-titlecard/.test(cardByKeyboard.group));

        // ---- one open state per initiative, remembered while the tab is open -------------------------
        await page.locator(`[data-init-card="${initId}"] .init-title`).click();
        await page.waitForSelector(`[data-init-card="${initId}"] .init-project`, { timeout: 15_000 });
        const remembered = await cardState();
        ok("reopening the card remembers the clamp, which is the default it starts on", remembered.open === true && remembered.descOpen === false && remembered.descClamped === true && remembered.descHeight === remembered.descLineHeight * 3, `card ${remembered.open}, description whole ${remembered.descOpen}, drawn ${remembered.descHeight}px = ${remembered.descLineHeight * 3}px of clamp`);

        // ---- the folds inside the open card ----------------------------------------------------------
        check("two project folds, one per project, closed by default", remembered.projects, 2);
        const projectTexts = await page.locator(`[data-init-card="${initId}"] .init-project`).allInnerTexts();
        ok("…named alpha and beta with their tree counts", /alpha/.test(projectTexts[0]) && /beta/.test(projectTexts[1]) && /\b2\b/.test(projectTexts[0]), projectTexts.map((t) => t.replace(/\s+/g, " ")).join(" | "));
        check("a folded project has no worktree rows in the DOM", remembered.trees, 0);
        check("assistant detail rows are folded too", remembered.assistRows, 0);
        ok("the card is the panel's own .as-group", /(^|\s)as-group(\s|$)/.test(remembered.group), remembered.group);
        await shot("card-open-projects-folded");
        await paneShot("card-open-projects-folded-pane");
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
        ok("the worktree rows are at the body step, 12.5px", open.fontSizes.every((f) => f === "12.5px"), [...new Set(open.fontSizes)].join(","));
        ok("the unfolded card is taller than the title card", open.height > titleCard.height, `${titleCard.height}px -> ${open.height}px`);
        await paneShot("unfolded-pane");

        // ---- a description that fits its two lines gets no dots at all ------------------------------
        // The other half of the preview rule: the dots mean "there is more", so a short description must not carry
        // them. Created after the reads above, through the same route the tab's own form uses, so it cannot disturb
        // the counts and words those assertions took.
        const shortMade = await POST("/api/initiatives", { title: "Gateway cutover", description: "One app at a time.", by: "reader" });
        ok("a second initiative, with a description short enough to fit two lines", shortMade.status === 201 && Boolean(shortMade.body?.initiative?.id), `HTTP ${shortMade.status}`);
        const shortId = shortMade.body.initiative.id;
        await page.waitForSelector(`[data-init-card="${shortId}"]`, { timeout: 25_000 });
        await page.locator(`[data-init-card="${shortId}"]`).scrollIntoViewIfNeeded();
        const shortCard = await page.locator(`[data-init-card="${shortId}"]`).evaluate((el) => {
          const desc = el.querySelector(".init-desc");
          const range = document.createRange();
          range.selectNodeContents(desc);
          const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => Math.round(r.top))).size;
          return { text: desc.textContent, dots: el.querySelector(".init-dots")?.textContent || "", lines };
        });
        check("a short description is drawn whole, with no dots", { text: shortCard.text, dots: shortCard.dots, lines: shortCard.lines }, { text: "One app at a time.", dots: "", lines: 1 });
        await paneShot("short-description-no-dots");
        // The clamp types no dots of its own: the browser draws the ellipsis on the third line, and the body keeps the
        // whole text (row 295, ask 2). So "the long one beside it" is still clamped, and carries no `.init-dots` span.
        const longAgain = await cardState();
        check("…and the long one beside it is still clamped, with no typed dots", { dots: longAgain.dots, clamped: longAgain.descClamped }, { dots: "", clamped: true });

        // ---- 6. the link that scrolls and flashes --------------------------------------------------
        console.log("\n== the link to the row ==");
        await page.locator(`[data-init-card="${initId}"] .init-tree`, { hasText: "menu-two" }).locator("a.init-tree-name").click();
        // The row is repainted as its project expands, so the flash lands on the row that repaint draws: wait for it
        // rather than sampling at a fixed tick (the flash is ~0.9 s, and a repaint a tick later drops it).
        await waitFor(
          async () =>
            page.evaluate((p) => {
              const want = String(p).replace(/\\/g, "/").toLowerCase();
              const tr = [...document.querySelectorAll("#projects tr.row")].find((r) => r.dataset.key && r.dataset.key.toLowerCase().endsWith(want));
              return Boolean(tr?.classList.contains("flash"));
            }, trees.menuTwo),
          { timeoutMs: 8_000, what: "the row's flash after the link press" },
        );
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
        // The link acts on itself and the card keeps its state: a press inside an open card must not fold the
        // initiative out from under the reader who followed its worktree.
        const afterLink = await cardState();
        ok("…and the initiative's card is still open behind it", afterLink.open === true && afterLink.projects === 2, `card ${afterLink.open}, project folds ${afterLink.projects}`);
        await shot("scrolled-flash");
        await paneShot("scrolled-flash-pane");

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
        // Four chips, always four, in the order a task moves through: queued first because it is the state before
        // running. This assistant has work in all four, so the strip reads as a count of four buckets.
        check("its counts are queued, running, completed and parked on THIS initiative's trees", counted[0]?.chips, ["1 queued", "1 running", "2 completed", "1 parked"]);
        check("the second assistant's counts are its own - and its zeros are chips too", counted[1]?.chips, ["0 queued", "0 running", "1 completed", "0 parked"]);
        const stripOf = async (id) =>
          page.locator(`[data-init-card="${initId}"] [data-init-assistant-row="${id}"]`).evaluate((el) => ({
            chips: [...el.querySelectorAll(".init-counts .chip")].map((c) => ({
              text: c.textContent.trim(),
              zero: c.classList.contains("is-zero"),
              tone: [...c.classList].filter((x) => x !== "chip" && x !== "is-zero"),
            })),
          }));
        const zeroRow = await stripOf(counted[1].id);
        const liveRow = await stripOf(counted[0].id);
        check("a zero count is drawn, dimmed, not left out", zeroRow.chips.map((c) => c.zero), [true, true, false, true]);
        ok("…the strip is four chips on both rows", zeroRow.chips.length === 4 && liveRow.chips.length === 4, `${liveRow.chips.length} and ${zeroRow.chips.length}`);
        ok("…and no fourth colour: queued quiet, running good, parked warn", JSON.stringify(liveRow.chips.map((c) => c.tone)) === JSON.stringify([[], ["good"], [], ["warn"]]), JSON.stringify(liveRow.chips.map((c) => c.tone)));
        ok("the row says when each last worked", /working now|worked .* ago/.test(counted[0]?.when || ""), counted[0]?.when || "");
        await paneShot("chip-strip");
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
        // By id, not by index: the store lists the most recently touched initiative first, and there are two now.
        check("…and the tree is still on the initiative", (await store()).initiatives.find((i) => i.id === initId)?.treeCount, 4);

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
        await waitFor(async () => (await store()).initiatives.find((i) => i.id === initId)?.title === "SSO migration (Menu)", { timeoutMs: 15_000, what: "the edited title" });
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

        // ---- 9. the toolbar at the narrow dock -------------------------------------------------------
        console.log("\n== 9. the four actions, in order, on one row at 347 and 239 ==");
        // The dock is the state the review measured: at a 768 window the rail is 347px wide, at 480 it is 239px. The
        // frame is switched through the panel's own route and the page is reopened, because the dock is read at boot.
        const docked = await fetch(`${base}/api/settings/general`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dockMode: "docked" }),
          signal: AbortSignal.timeout(8000),
        });
        ok("the panel switched to the docked frame through its own route", docked.ok, `HTTP ${docked.status}`);
        await openPage(page, base, { selector: "section.project" });
        const toolbarAt = async (width) => {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForTimeout(250);
          await openTab();
          await page.waitForSelector("#as-initiatives .init-actions button", { timeout: 20_000 });
          return page.evaluate(() => {
            const pane = document.getElementById("as-initiatives");
            const buttons = [...pane.querySelectorAll(".init-actions button")].filter((b) => !b.hidden);
            const key = (b) => (b.hasAttribute("data-init-new") ? "new" : b.hasAttribute("data-init-refresh") ? "refresh" : b.hasAttribute("data-init-about") ? "about" : b.hasAttribute("data-init-density") ? "density" : "?");
            // The label the reader actually reads: the span the container query has not hidden.
            const label = (b) => [...b.querySelectorAll(".init-lbl, .init-lbl-sm, .init-lbl-xs")].filter((s) => s.getClientRects().length).map((s) => s.textContent).join("").trim() || b.textContent.trim();
            const actions = pane.querySelector(".init-actions");
            return {
              pane: pane.clientWidth,
              order: buttons.map(key),
              labels: buttons.map(label),
              names: buttons.map((b) => b.getAttribute("aria-label") || b.textContent.trim()),
              rows: [...new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top)))].length,
              heights: [...new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().height)))],
              widestRight: Math.round(Math.max(...buttons.map((b) => b.getBoundingClientRect().right))),
              paneRight: Math.round(pane.getBoundingClientRect().right),
              overflow: actions.scrollWidth - actions.clientWidth,
            };
          });
        };
        const wide = await toolbarAt(768);
        check("at a 768 window the pane is 347px, the width the review measured", wide.pane, 347);
        check("the four actions read New initiative, Refresh, About, Compact rows in that order", wide.order, ["new", "refresh", "about", "density"]);
        check("the four share one row at 347px", wide.rows, 1);
        check("the density control says Density when the pane is 347px", wide.labels, ["New initiative", "Refresh", "About", "Density"]);
        ok("nothing runs past the pane's right edge at 347px", wide.widestRight <= wide.paneRight && wide.overflow <= 0, `widest right ${wide.widestRight} of ${wide.paneRight}, actions overflow ${wide.overflow}`);
        ok("the visible short forms still announce the full names", wide.names[0] === "New initiative" && wide.names[3] === "Density - compact rows", wide.names.join(" | "));
        const narrow = await toolbarAt(480);
        check("at a 480 window the pane is 239px, the width the review measured", narrow.pane, 239);
        check("the same four, in the same order, at 239px", narrow.order, ["new", "refresh", "about", "density"]);
        check("the four share one row at 239px", narrow.rows, 1);
        check("the primary says New and the density toggle says Aa at 239px", narrow.labels, ["New", "Refresh", "About", "Aa"]);
        ok("nothing runs past the pane's right edge at 239px", narrow.widestRight <= narrow.paneRight && narrow.overflow <= 0, `widest right ${narrow.widestRight} of ${narrow.paneRight}, actions overflow ${narrow.overflow}`);
        check("every control keeps its 30px height at both widths", [...new Set([...wide.heights, ...narrow.heights])], [30]);

        // ---- 10. health ----------------------------------------------------------------------------
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
