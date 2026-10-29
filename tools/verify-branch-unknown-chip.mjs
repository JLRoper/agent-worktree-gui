// The branch cell when the panel could NOT get an answer about the remote: one word — `unverified` — and the
// project's own fetch note behind it.
//
//   node tools/verify-branch-unknown-chip.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-branch-unknown-chip.mjs
//
// WHY. A row whose `remoteBranch` is `unknown` (the remote was unreachable, or the scan had not read it) used to draw
// NO word at all. A branch that is on the remote and one nobody ever pushed looked identical, and the only way to tell
// was to hover the cell and read a sentence that never said why the panel could not ask. The lane C harness pinned the
// chip against the live board; this one drives the state itself, because a live board cannot be made to fail a fetch
// on demand.
//
// WHAT IS DRIVEN: a real panel, booted from server.js against a throwaway config (tools/panel-testkit.mjs), scanning a
// real git repository whose `origin` is a path that does not exist. Git's own fetch fails, `maybeFetch` records the
// failure as the project's `fetchNote`, `ls-remote` answers nothing, and the row is `unknown` — the exact state the
// chip is for. Then the board is loaded in headless Chromium and the cell is read as the reader sees it.
//
// Exit codes: 0 every check passed, 1 a check failed, 2 no Playwright install (BROWSER-HALF-NOT-RUN).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "wtgui-unknown-chip-"));
const S = scratch.replace(/\\/g, "/");
// Where the cell's own picture goes, beside the lane C report: a cell is a thing you look at, and "UNVERIFIED" in a
// screenshot is the claim in the form the reader meets it.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const OUT = args.out || "C:/CodeReviews/agent-worktree-gui/unknown-chip";
mkdirSync(OUT, { recursive: true });
const REPOS = `${S}/repos`;
const PROJECT = `${REPOS}/proof-lost`;
// A remote that resolves to nothing: git cannot reach it, cannot list its heads, and says so in one short sentence.
const DEAD_REMOTE = `${S}/srv/nowhere/proof-lost.git`;
const BRANCH = "wtgui/proof-lost-cccccc";

let checks = 0;
let failures = 0;
const ok = (name, cond, detail) => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const say = (line) => console.log(`      ${line}`);

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" } }).trim();

function makeFixture() {
  mkdirSync(REPOS, { recursive: true });
  git(REPOS, ["init", "-q", "-b", "main", PROJECT]);
  const id = ["-c", "user.email=proof@localhost", "-c", "user.name=proof"];
  git(PROJECT, [...id, "commit", "-q", "--allow-empty", "-m", "the scratch project's only commit"]);
  // The branch a reader would expect to find on the remote, and a remote that will never answer.
  git(PROJECT, ["worktree", "add", "-q", "-b", BRANCH, `${PROJECT}/.worktrees/proof-lost`]);
  git(PROJECT, ["remote", "add", "origin", DEAD_REMOTE]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForUnknown(base, ms = 60_000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const state = await (await fetch(`${base}/api/state`)).json();
      const project = (state.projects || []).find((p) => p.name === "proof-lost") || null;
      const row = (project?.worktrees || []).find((r) => r.branch === BRANCH) || null;
      last = { project, row };
      // The row is unknown AND the project carries the reason — that pair is what the cell is supposed to render.
      if (row?.remoteBranch === "unknown" && String(project?.fetchNote || "").trim()) return last;
    } catch {
      /* the panel is still booting */
    }
    await sleep(300);
  }
  return last;
}

// A row is a projection of the last full pass. The fetch note arrives on a fetch, which is a different tick, so the
// reader's own "Refresh now" is pressed — the one control a person would use — and the row is read back until the
// sentence includes the note. Without this the harness would be testing whichever tick happened to run last.
async function waitForSentence(base, note, ms = 60_000) {
  await fetch(`${base}/api/refresh`, { method: "POST" }).catch(() => {});
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${base}/api/state`)).json();
    const project = (state.projects || []).find((p) => p.name === "proof-lost") || null;
    last = (project?.worktrees || []).find((r) => r.branch === BRANCH) || null;
    if (last && String(last.branchWhy || "").includes(note)) return { project, row: last };
    await sleep(300);
  }
  return { project: null, row: last };
}

let panel = null;
let noBrowser = false;
try {
  console.log(`scratch: ${S}`);
  makeFixture();
  panel = await startPanel({
    config: {
      scanRoots: [REPOS],
      projects: [{ name: "proof-lost", path: PROJECT, remote: "origin", mainBranch: "main" }],
      // Fetch on every pass, so the failure note is on the project inside a test's patience. 20s is git's own
      // timeout in `maybeFetch`; a dead local path fails in milliseconds.
      fetchSeconds: 0,
      remoteCacheSeconds: 1,
      refreshSeconds: 30,
      worktreeSeconds: 5,
      midSeconds: 5,
      dormantSeconds: 5,
      slowSeconds: 5,
      hideOlderThanDays: 0,
    },
  });
  say(`sandbox panel on ${panel.base}`);

  const first = await waitForUnknown(panel.base);
  ok("the row is on the board", Boolean(first?.row), first?.row?.path || null);
  ok("the project's fetch failed", Boolean(String(first?.project?.fetchNote || "").trim()), first?.project?.fetchNote);
  ok("so the remote's answer is `unknown`, not `exists`/`gone`", first?.row?.remoteBranch === "unknown", first?.row?.remoteBranch);

  const note = String(first?.project?.fetchNote || "").trim();
  // The sentence is the part that makes an unknown row read as unverifiable instead of unlinked, so it is read back
  // after a full pass rather than assumed from the row the first tick happened to draw.
  const sentence = await waitForSentence(panel.base, note);
  const row = sentence?.row || first?.row;
  ok("the sentence quotes the project's fetch note", Boolean(note) && String(row?.branchWhy || "").includes(note), row?.branchWhy);
  ok("and the row carries the panel's word for it", row?.branchChip === "unverified", row?.branchChip);
  ok("never the `local` claim", row?.branchLocalOnly === false, row?.branchLocalOnly);
  ok("nothing pretends to be a link", row?.branchUrl === null, row?.branchUrl);
  const engine = loadPlaywright();
  if (!engine) {
    // A half that never ran must not read as a pass: the API half above did run, and this says which half did not.
    console.log(notRun("the unknown branch cell", "no Playwright install found — set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright"));
    noBrowser = true;
  } else {
    await withBrowser(
      async ({ page }) => {
        await openPage(page, panel.base, { selector: "section.project [data-toggle-project]" });
        // A fresh context remembers no fold: open the project the way the reader would.
        await page.evaluate(() => {
          for (const sec of document.querySelectorAll("section.project.collapsed")) sec.querySelector("[data-toggle-project]")?.click();
        });
        await page.waitForFunction((b) => [...document.querySelectorAll("tr.row")].some((tr) => (tr.querySelector("td.branch")?.textContent || "").includes(b)), BRANCH, { timeout: 30_000 });
        const cell = await page.evaluate((b) => {
          const tr = [...document.querySelectorAll("tr.row")].find((t) => (t.querySelector("td.branch")?.textContent || "").includes(b));
          const td = tr?.querySelector("td.branch") || null;
          const chip = td?.querySelector(".branch-local, .branch-unverified") || null;
          const plain = td?.querySelector(".branch-plain") || null;
          const style = chip ? getComputedStyle(chip) : null;
          return {
            html: td ? td.innerHTML.slice(0, 400) : null,
            href: td?.querySelector("a.branch-link")?.getAttribute("href") || null,
            saysLocal: [...(td?.querySelectorAll("span, a") || [])].some((el) => el.textContent.trim().toLowerCase() === "local"),
            chipClass: chip ? chip.className : null,
            chipText: chip ? chip.textContent.trim() : null,
            chipVisible: chip && style ? (style.textTransform === "uppercase" ? chip.textContent.trim().toUpperCase() : chip.textContent.trim()) : null,
            chipColor: style ? style.color : null,
            chipBorder: style ? style.borderTopStyle : null,
            plainTitle: plain?.getAttribute("title") || null,
            chipTitle: chip?.getAttribute("title") || null,
          };
        }, BRANCH);
        say(`rendered cell: ${cell.html}`);
        // The picture, retried the way the lane C harness retries: a board repaint can detach the cell between the
        // read and the shutter.
        const shot = path.join(OUT, "unknown-chip-branch.png");
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            // The row under test, not whichever row is drawn first: this project has two rows and both are unknown.
            const rowLoc = page.locator("tr.row", { hasText: BRANCH }).first();
            await rowLoc.scrollIntoViewIfNeeded({ timeout: 5000 });
            await page.waitForTimeout(120);
            await rowLoc.locator("td.branch").first().screenshot({ path: shot, animations: "disabled", timeout: 8000 });
            say(`shot: ${shot}`);
            break;
          } catch (e) {
            if (attempt === 7) say(`could not screenshot the cell: ${String((e && e.message) || e)}`);
            else await page.waitForTimeout(300);
          }
        }

        ok("the cell is not an anchor", cell.href === null, cell.href);
        ok("a chip is drawn at all", cell.chipText !== null, cell.chipClass);
        ok("and it is the unverified one, not the local one", cell.chipClass === "branch-unverified", cell.chipClass);
        ok("the word reads UNVERIFIED on screen", cell.chipVisible === "UNVERIFIED", cell.chipVisible);
        ok("nothing in the cell says `local`", !cell.saysLocal && cell.chipText !== "local", { saysLocal: cell.saysLocal, chip: cell.chipText });
        ok("the branch name's title quotes the fetch note", String(cell.plainTitle || "").includes(note), cell.plainTitle);
        ok("the chip's title quotes it too", String(cell.chipTitle || "").includes(note), cell.chipTitle);
        ok("the chip is styled apart from a plain word", Boolean(cell.chipColor) && cell.chipColor !== "rgb(85, 96, 110)", { color: cell.chipColor, border: cell.chipBorder });
      },
      { playwright: engine, viewport: { width: 1600, height: 900 } },
    );
  }
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run itself threw: ${String((e && e.stack) || e)}`);
} finally {
  if (panel) await panel.stop().catch(() => {});
  await sleep(200);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failed`);
if (noBrowser) {
  console.log("RESULT: BROWSER-HALF-NOT-RUN (the API half above is the whole result)");
  process.exit(2);
}
console.log(failures ? "RESULT: FAILED" : "RESULT: ALL PASS");
process.exit(failures ? 1 : 0);
