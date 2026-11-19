#!/usr/bin/env node
// THE BRANCH NAME IN THE INITIATIVES TAB, as a link to its page on the remote - the same link the chart draws.
//
// HARNESS: LIVE GATE (real panel, real git repositories, real bare remote, Playwright at 1440x900)
//
//   node tools/verify-initiative-branch-link.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES, and every claim is measured on the running page rather than read out of the source:
//
//   1. THE SAME HREF. One tree's branch is on its remote, so the server resolves a page for it; a second project has
//      no remote at all. The chart's cell and the Initiatives tab's worktree row are read in the same run and their
//      hrefs compared - the brief's one-implementation rule, measured end to end.
//   2. THE LINK IS A LINK. The initiative's branch is an `<a href>` with `target="_blank"`, `rel="noopener"` and the
//      chart's title, resolved through the accessibility tree as a link named after the branch (getByRole), so a
//      screen reader announces it as one; and Tab from the worktree's own name moves focus onto it.
//   3. THE PLAIN BRANCH. The project with no remote renders a chip-shaped span with NO href and the server's reason
//      ("no remote configured") as its title: no dead link, and nothing that looks clickable.
//   4. THE LINK DOES NOT FIGHT THE CARD. Pressing the link opens its page (a popup, which is what target=_blank
//      means) and the initiative is still open: aria-expanded stays true, the worktree rows are still in the DOM, and
//      the very node that was pressed is still connected (a repaint would have replaced it).
//
// Sandbox only: a throwaway bare remote and two throwaway repos under the OS temp directory, its own HERMES_HOME,
// its own PANEL_CONFIG and port, and an apiServer pointed at a dead port. The live panel is never touched. Without
// Playwright the script says BROWSER-NOT-RUN and exits 2 rather than passing a half that never ran.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ---- the sandbox: one linked tree, one project with no remote at all -------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-initiative-branch-link-"));
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(dir, "shots");
mkdirSync(shotsDir, { recursive: true });
const repos = path.join(dir, "repos");
const REMOTE = slash(path.join(dir, "srv", "github.com", "JLRoper", "proof-repo.git"));
const linkedRepo = path.join(repos, "prooflib");
const plainRepo = path.join(repos, "plainlib");
const linkedTree = path.join(linkedRepo, ".worktrees", "proof-linked-aaaaaa");
const plainTree = path.join(plainRepo, ".worktrees", "proof-plain-bbbbbb");
const LINKED_BRANCH = "wtgui/proof-linked-aaaaaa";
const PLAIN_BRANCH = "wtgui/proof-plain-bbbbbb";
const LINKED_PAGE = `https://github.com/JLRoper/proof-repo/tree/${LINKED_BRANCH}`;
const gitEnv = { GIT_TERMINAL_PROMPT: "0" };
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  return git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message], { env: gitEnv });
};

let panel = null;
try {
  mkdirSync(path.dirname(REMOTE), { recursive: true });
  mkdirSync(path.join(linkedRepo, ".worktrees"), { recursive: true });
  mkdirSync(path.join(plainRepo, ".worktrees"), { recursive: true });
  git(path.dirname(REMOTE), ["init", "-q", "--bare", REMOTE]);

  // The linked project: its branch is pushed, so `ls-remote` lists it and the server can build its page.
  git(linkedRepo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(linkedRepo, "README.md"), "# prooflib\n", "utf8");
  commit(linkedRepo, "seed the project");
  git(linkedRepo, ["worktree", "add", "-q", "-b", LINKED_BRANCH, linkedTree]);
  writeFileSync(path.join(linkedTree, "work.txt"), "linked work\n", "utf8");
  commit(linkedTree, "do the linked work");
  git(linkedRepo, ["remote", "add", "origin", REMOTE]);
  git(linkedTree, ["push", "-q", "-u", "origin", LINKED_BRANCH], { env: gitEnv });

  // The plain project: no remote is configured at all, which is the "no resolvable repo" case.
  git(plainRepo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(plainRepo, "README.md"), "# plainlib\n", "utf8");
  commit(plainRepo, "seed the project");
  git(plainRepo, ["worktree", "add", "-q", "-b", PLAIN_BRANCH, plainTree]);
  writeFileSync(path.join(plainTree, "work.txt"), "plain work\n", "utf8");
  commit(plainTree, "do the plain work");

  const port = await freePort();
  // Where the links go: the shipped seed (github + git.sefl.com) under the reader's own file, which maps this one
  // proof project onto github with a repo name. Written BEFORE the panel boots, because a row's `branchUrl` is
  // decorated on its first scan and reads this document then. Nothing here reaches the network - the remote is a
  // directory.
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(
    path.join(dir, "logs", "hosts.json"),
    `${JSON.stringify({ version: 1, hosts: {}, projects: { prooflib: { host: "github", coordinates: { repo: "proof-repo" } } } }, null, 2)}\n`,
    "utf8",
  );
  panel = await startPanel({
    dir,
    port,
    keep: Boolean(shotDirArg),
    config: {
      refreshSeconds: 3,
      worktreeSeconds: 2,
      midSeconds: 8,
      dormantSeconds: 15,
      slowSeconds: 20,
      fetchSeconds: 3600,
      scanMode: "all",
      defaultCwd: linkedRepo,
      projects: [
        { name: "prooflib", path: linkedRepo, remote: "origin", mainBranch: "main" },
        { name: "plainlib", path: plainRepo, mainBranch: "main" },
      ],
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
      // Where the links go: the shipped seed (github + git.sefl.com) under the reader's own file, which maps this
      // one proof project onto github with a repo name. Nothing here reaches the network - the remote is a directory.
      hostsFile: path.join(dir, "logs", "hosts.json"),
      hostsSeedFile: slash(path.join(ROOT, "hosts.seed.json")),
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

  await waitForRow(base, "prooflib", linkedTree, { timeout: 90_000, predicate: (r) => Boolean(r.branchUrl) });
  const linkedRow = await waitForRow(base, "prooflib", linkedTree, { timeout: 90_000, predicate: (r) => Boolean(r.branchUrl) });
  const plainRow = await waitForRow(base, "plainlib", plainTree, { timeout: 90_000, predicate: (r) => r.branch === PLAIN_BRANCH });
  ok("the linked tree's row resolved a page on its remote", linkedRow.branchUrl === LINKED_PAGE, linkedRow.branchUrl);
  check("the project with no remote resolved no page", plainRow.branchUrl, null);
  check("...and says why", plainRow.branchWhy, "no remote configured");

  // The initiative membership is the store's own document (the move flow that writes it is verify-initiatives-tab's
  // subject). Written before the tab is opened, then read back through the route to prove the join carried the fields.
  const storeDoc = {
    savedAt: new Date().toISOString(),
    initiatives: [{ id: "init_proof", title: "SSO migration", description: "the proof's one initiative", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    trees: {
      [slash(linkedTree).toLowerCase()]: { path: slash(linkedTree), initiatives: ["init_proof"], at: new Date().toISOString(), by: "reader" },
      [slash(plainTree).toLowerCase()]: { path: slash(plainTree), initiatives: ["init_proof"], at: new Date().toISOString(), by: "reader" },
    },
  };
  const read = await GET("/api/initiatives");
  const storeFile = read.body.file;
  writeFileSync(storeFile, `${JSON.stringify(storeDoc, null, 2)}\n`, "utf8");
  const got = await waitFor(async () => {
    const d = await GET("/api/initiatives");
    return d.body?.initiatives?.[0]?.treeCount === 2 ? d.body : null;
  }, { timeoutMs: 30_000, what: "the route to read both member trees" });
  ok("the initiatives read carries both member trees", got && got.initiatives[0].treeCount === 2, got ? JSON.stringify(got.initiatives[0].projects.map((p) => [p.name, p.trees.length])) : "no read");
  const viewTrees = (got?.initiatives?.[0]?.projects || []).flatMap((p) => p.trees.map((t) => ({ ...t, project: p.name })));
  const linkedView = viewTrees.find((t) => t.project === "prooflib");
  const plainView = viewTrees.find((t) => t.project === "plainlib");
  check("the tab's data carries the linked tree's page, byte for byte", linkedView?.branchUrl, LINKED_PAGE);
  check("...and the plain tree's null page", plainView?.branchUrl, null);

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the initiative branch link", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ context, page, pageErrors, consoleErrors }) => {
        let shotNo = 0;
        const shot = async (slug, opts = {}) => {
          const file = path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);
          await page.screenshot({ path: file, ...opts });
          note(`shot ${path.basename(file)}`);
          return file;
        };
        const expand = async () => {
          await page.waitForSelector("section.project > .project-head[data-toggle-project]", { state: "visible", timeout: 90_000 });
          for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
            const sec = head.locator("xpath=..");
            if (String((await sec.getAttribute("class")) || "").includes("collapsed")) await head.click();
          }
          await page.waitForSelector("tr.row", { state: "visible", timeout: 60_000 });
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
        const openCard = async () => {
          await page.waitForSelector('#as-initiatives [data-init-card="init_proof"]', { timeout: 20_000 });
          const open = await page.locator('[data-init-card="init_proof"] [data-init-card-toggle]').getAttribute("aria-expanded");
          if (open !== "true") await page.locator('[data-init-card="init_proof"] .init-title').click();
          await page.waitForSelector('[data-init-card="init_proof"] .init-project', { timeout: 15_000 });
          for (const proj of await page.locator('[data-init-card="init_proof"] .init-proj').all()) {
            if ((await proj.getAttribute("aria-expanded")) !== "true") await proj.click();
          }
          await page.waitForSelector('[data-init-card="init_proof"] .init-tree', { timeout: 15_000 });
        };

        // No proof may reach the network: the remote page is answered locally, which is also how the click is caught.
        await context.route("https://github.com/**", (route) =>
          route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>the remote page</title><p>proof remote page</p>" }),
        );

        await openPage(page, base, { selector: "section.project" });
        await expand();

        // ---- the chart's own branch cell, read first so the tab has something to be compared with --------------
        const chart = await page.evaluate((name) => {
          for (const tr of document.querySelectorAll("#projects tr.row")) {
            const span = tr.querySelector(".row-name");
            if (!span || !String(span.getAttribute("title") || "").replace(/\\/g, "/").endsWith(name)) continue;
            const cell = tr.querySelector("td.branch");
            const a = cell ? cell.querySelector("a.branch-link") : null;
            return {
              html: cell ? cell.innerHTML : "",
              href: a ? a.getAttribute("href") : null,
              target: a ? a.getAttribute("target") : null,
              rel: a ? a.getAttribute("rel") : null,
              title: a ? a.getAttribute("title") : null,
              text: a ? a.textContent : null,
            };
          }
          return null;
        }, slash(linkedTree).split("/").pop());
        ok("the chart's branch cell draws the link", chart?.href === LINKED_PAGE, chart ? chart.href : "no row read");
        check("...in a new tab, with noopener", { target: chart?.target, rel: chart?.rel }, { target: "_blank", rel: "noopener" });

        await openTab();
        await openCard();

        // ---- 1. the linked branch -------------------------------------------------------------------------------
        console.log("\n== the branch that has a page ==");
        const linked = page.locator('[data-init-card="init_proof"] [data-init-tree-row]').filter({ has: page.locator("a.init-branch-link") }).first();
        const link = linked.locator("a.init-branch-link");
        check("the initiative's branch is an anchor", await link.count(), 1);
        check("...whose href is the chart's href", await link.getAttribute("href"), chart?.href);
        check("...opened the same way", { target: await link.getAttribute("target"), rel: await link.getAttribute("rel") }, { target: "_blank", rel: "noopener" });
        check("...with the chart's title", await link.getAttribute("title"), chart?.title);
        check("...and the branch as its visible text", await link.textContent(), LINKED_BRANCH);
        // The affordance, measured: the anchor wears the pane's link blue and a pointer, and the plain chip does not.
        const paint = await page.evaluate(() => {
          const card = document.querySelector('[data-init-card="init_proof"]');
          const a = card.querySelector("a.init-branch-link");
          const plain = card.querySelector("span.init-branch");
          return {
            link: a ? getComputedStyle(a).color : null,
            linkCursor: a ? getComputedStyle(a).cursor : null,
            plain: plain ? getComputedStyle(plain).color : null,
            plainCursor: plain ? getComputedStyle(plain).cursor : null,
          };
        });
        check("the link wears the chart's own link colour", paint.link, "rgb(127, 178, 232)");
        check("...and a pointer cursor", paint.linkCursor, "pointer");
        check("the plain branch is the dim chip", paint.plain, "rgb(107, 116, 130)");
        ok("...and does not invite a press", paint.plainCursor !== "pointer", paint.plainCursor);
        const ariaLink = page.locator('[data-init-card="init_proof"]').getByRole("link", { name: LINKED_BRANCH, exact: true });
        check("the accessibility tree resolves it as a link named after the branch", await ariaLink.count(), 1);

        // Keyboard: from the worktree's own name, one Tab lands on the branch link.
        await linked.locator(".init-tree-name").focus();
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => {
          const el = document.activeElement;
          return el ? { tag: el.tagName, cls: el.className, href: el.getAttribute("href") } : null;
        });
        check("Tab from the worktree name reaches the branch link", focused, { tag: "A", cls: "chip init-branch mono init-branch-link", href: LINKED_PAGE });
        // Shot 1 carries the focus ring: the link the reader can reach with the keyboard, beside the chart's own cell.
        await shot("initiative-branch-is-a-link");

        // ---- 2. the plain branch ---------------------------------------------------------------------------------
        console.log("\n== the branch with no repo ==");
        const plainRowEl = page.locator('[data-init-card="init_proof"] [data-init-tree-row]').filter({ hasText: "proof-plain-bbbbbb" }).first();
        // The linked link still holds the focus ring from the Tab proof; blur it so this shot is about the plain chip.
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        const plainBranch = plainRowEl.locator(".init-branch");
        check("the plain tree draws the branch as a span", await plainBranch.evaluate((el) => el.tagName), "SPAN");
        check("...with no href anywhere in it", await plainBranch.evaluate((el) => el.hasAttribute("href") || Boolean(el.querySelector("a"))), false);
        check("...carrying the branch as text", (await plainBranch.textContent()).trim(), PLAIN_BRANCH);
        check("...and the server's reason as its title", await plainBranch.getAttribute("title"), "no remote configured");
        check("no link in the initiative's list points at the plain branch", await page.locator(`[data-init-card="init_proof"] a[href*="proof-plain"]`).count(), 0);
        await shot("initiative-branch-with-no-repo-is-plain");

        // ---- 3. pressing the link follows it and leaves the card open ----------------------------------------------
        console.log("\n== the press follows the link, the card stays open ==");
        const before = await page.locator('[data-init-card="init_proof"] [data-init-card-toggle]').getAttribute("aria-expanded");
        check("the card is open before the press", before, "true");
        await link.evaluate((el) => {
          el.dataset.probe = "pressed-node";
        });
        const [popup] = await Promise.all([context.waitForEvent("page", { timeout: 20_000 }), link.click()]);
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        check("the press opened the remote page in a new tab", popup.url(), LINKED_PAGE);
        await popup.close().catch(() => {});
        const after = await page.evaluate(() => {
          const card = document.querySelector('[data-init-card="init_proof"]');
          const a = card ? card.querySelector("a.init-branch-link") : null;
          return {
            open: card ? card.querySelector("[data-init-card-toggle]")?.getAttribute("aria-expanded") : null,
            trees: card ? card.querySelectorAll(".init-tree").length : 0,
            sameNode: a ? a.dataset.probe === "pressed-node" : false,
          };
        });
        check("the initiative is still open and its rows are still drawn", { open: after.open, trees: after.trees }, { open: "true", trees: 2 });
        ok("...and the node the press landed on was not repainted away", after.sameNode);
        await shot("link-click-leaves-the-card-open");

        // ---- 4. health ------------------------------------------------------------------------------------------
        console.log("\n== health ==");
        check("zero uncaught page errors", pageErrors.length, 0);
        check("zero console errors", consoleErrors.length, 0);
        if (pageErrors.length) note(pageErrors.join(" | "));
        if (consoleErrors.length) note(consoleErrors.join(" | "));
      },
      { viewport: { width: 1440, height: 900 } },
    );
  }
} catch (err) {
  failures += 1;
  console.log(`FAIL  the proof threw: ${String((err && err.stack) || err)}`);
} finally {
  clearTimeout(watchdog);
  if (panel?.stop) await panel.stop().catch(() => {});
  else if (panel?.child) panel.child.kill();
  console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks; shots under ${slash(shotsDir)}`);
  if (shotDirArg && existsSync(dir)) note(`sandbox kept: ${slash(dir)}`);
  process.exit(failures ? 1 : 0);
}
