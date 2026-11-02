// The folder header's "+" row, second action: NEW LOCAL PROJECT.
//
//   node tools/verify-new-project.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-new-project.mjs
//
// WHY. The green + beside a folder has always opened one form ("Clone via ssh"). A reader who wants a
// brand-new repository in that folder had nowhere to say so, and `git init` by hand leaves them at an
// unborn HEAD — which this panel reads as NO BASE REF and refuses to spawn from. So the row carries a
// second action, and the gate proves it end to end: a real panel booted from server.js against a
// throwaway config, the folder header pressed in headless Chromium, a name typed, the button pressed,
// and the project landing on the board with no page reload.
//
// WHAT IS DRIVEN:
//   1. ONE FORM, TWO ACTIONS. The clone button still reads "Clone via ssh" and the new one sits beside
//      it in the same `[data-clone-form]`, so the discoverable path that worked before is untouched.
//   2. THE "+" OPENS IT and puts the cursor in the name box.
//   3. THE THREE REFUSALS, each through the shipped handler and into the same `data-clone-msg` span:
//      a bad name (400), a folder that already exists (409), and a root that is not a scanRoot (400 —
//      typed into the button's own root, the shape a stale page has after config.json was edited).
//      Each one leaves the name box focusable and focused, so the fix is where the error is.
//   4. THE LANDING. `created → …` in the row, and `section.project[data-project]` on the board with
//      the window's own marker still alive — a reload would wipe it, so the project arrived by the
//      route's refresh + snapshot, not by the reader pressing F5.
//   5. THE BASE REF. git's own answers on the new checkout: HEAD on `main`, exactly ONE commit, a
//      README in it, and a clean tree — never an unborn HEAD.
//
// Exit codes: 0 every check passed, 1 a check failed, 2 no Playwright install (BROWSER-HALF-NOT-RUN).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "wtgui-new-project-"));
const S = scratch.replace(/\\/g, "/");
const REPOS = path.join(scratch, "repos");
const NAME = "board-project";
const TAKEN = "taken";

let checks = 0;
let failures = 0;
let noBrowser = false;
const ok = (name, cond, detail) => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  return Boolean(cond);
};
const say = (line) => console.log(`      ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
  }).trim();
const ran = (cwd, args) => {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
};

let panel = null;
try {
  mkdirSync(REPOS, { recursive: true });
  // A folder accordion only exists for a folder that HOLDS a project (`renderAll` groups the board by
  // project, and an empty scan root draws no header), so the sandbox starts with one real project —
  // the same board a reader pressing + is looking at.
  const seed = path.join(REPOS, "seed-project");
  mkdirSync(seed, { recursive: true });
  const id = ["-c", "user.email=verify@localhost", "-c", "user.name=verify", "-c", "commit.gpgsign=false"];
  execFileSync("git", ["-C", seed, ...id, "init", "-q", "-b", "main"], { windowsHide: true });
  writeFileSync(path.join(seed, "seed.txt"), "the folder's existing project\n", "utf8");
  execFileSync("git", ["-C", seed, ...id, "add", "-A"], { windowsHide: true });
  execFileSync("git", ["-C", seed, ...id, "commit", "-q", "-m", "seed"], { windowsHide: true });
  // A folder that is already there is the 409's fixture, and it must stay untouched: `git init` on
  // top of somebody's checkout is silent and unrecoverable.
  mkdirSync(path.join(REPOS, TAKEN), { recursive: true });
  writeFileSync(path.join(REPOS, TAKEN, "keep.txt"), "not mine to init\n", "utf8");
  const OUTSIDE = path.join(scratch, "outside");

  panel = await startPanel({
    config: {
      scanRoots: [REPOS],
      worktreeSeconds: 2,
      midSeconds: 2,
      dormantSeconds: 2,
      slowSeconds: 5,
    },
  });
  say(`sandbox panel on ${panel.base} scanning ${S}/repos`);

  // ---- 0. the refusals over HTTP, before a browser is involved -----------------------------------
  // The page half drives the same three refusals through the shipped handler; this half is what still
  // runs on a box with no Chromium, and it pins the STATUS the page turns into a sentence.
  const http = async (body) => {
    const r = await fetch(`${panel.base}/api/project/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const badName = await http({ root: REPOS, name: "../escape" });
  ok("HTTP: a traversal name is a 400", badName.status === 400 && /not a project name/.test(badName.json?.error || ""), badName.json?.error);
  ok("HTTP: and it made no folder", !existsSync(path.join(scratch, "escape")));
  const takenHttp = await http({ root: REPOS, name: TAKEN });
  ok("HTTP: an existing folder is a 409", takenHttp.status === 409 && /already exists/.test(takenHttp.json?.error || ""), takenHttp.json?.error);
  ok("HTTP: the existing folder was not inited", !ran(path.join(REPOS, TAKEN), ["rev-parse", "--git-dir"]));
  const outsideHttp = await http({ root: OUTSIDE, name: "outside-proj" });
  ok("HTTP: a root outside scanRoots is a 400", outsideHttp.status === 400 && /root must be one of scanRoots/.test(outsideHttp.json?.error || ""), outsideHttp.json?.error);
  ok("HTTP: and that root wrote nothing", !existsSync(path.join(OUTSIDE, "outside-proj")));

  // ---- the browser half ---------------------------------------------------------------------------
  const engine = loadPlaywright();
  if (!engine) {
    console.log(notRun("the folder's New local project action", "no Playwright install found — set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright"));
    noBrowser = true;
  } else {
    await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        await openPage(page, panel.base, { selector: `[data-root-clone]` });

        // The row: the clone exactly as it was, the new action beside it, both inside ONE form.
        const row = await page.evaluate(() => {
          const form = document.querySelector("[data-clone-form]");
          const clone = form?.querySelector("[data-clone-go]");
          const made = form?.querySelector("[data-project-new]");
          return {
            hasForm: Boolean(form),
            cloneText: clone?.textContent?.trim() || null,
            newText: made?.textContent?.trim() || null,
            newTitle: made?.getAttribute("title") || null,
          };
        });
        if (
          !ok("the folder row offers the new action", row.hasForm && Boolean(row.newText), row.hasForm ? row.newText : "no [data-clone-form]")
        ) {
          // Without the control there is nothing to drive; the base (0.62.2) is red here by design.
          say("stopping the page half: this build has no [data-project-new] to press");
          return;
        }
        ok("the clone beside it is unchanged", row.cloneText === "Clone via ssh", row.cloneText);
        ok("its tooltip says what it makes", /new local git project/i.test(row.newTitle || ""), row.newTitle);

        // 2. the "+" opens the row and puts the cursor in the name box.
        await page.click("[data-root-clone]");
        await sleep(150);
        const opened = await page.evaluate(() => {
          const form = document.querySelector("[data-clone-form]");
          const input = form?.querySelector("[data-clone-input]");
          return { hidden: Boolean(form?.hidden), focused: document.activeElement === input };
        });
        ok("the + opens the form", opened.hidden === false);
        ok("and the name box has the cursor", opened.focused === true);

        const readRow = () =>
          page.evaluate(() => {
            const form = document.querySelector("[data-clone-form]");
            const span = form?.querySelector("[data-clone-msg]");
            const input = form?.querySelector("[data-clone-input]");
            return {
              text: String(span?.textContent || "").trim(),
              err: Boolean(span?.classList.contains("clone-err")),
              focused: document.activeElement === input,
              inputDisabled: Boolean(input?.disabled),
            };
          });
        const waitMsg = async (needle, ms = 30_000) => {
          await page
            .waitForFunction(
              (want) => String(document.querySelector("[data-clone-form] [data-clone-msg]")?.textContent || "").includes(want),
              needle,
              { timeout: ms },
            )
            .catch(() => null);
          return readRow();
        };
        const press = async (name) => {
          await page.fill("[data-clone-input]", name);
          await page.click("[data-project-new]");
        };

        // 3a. a bad name: 400, in the row, with the box still the place to fix it.
        await press("bad name!");
        const bad = await waitMsg("not a project name");
        ok("a bad name reports into the row's message", /not a project name/.test(bad.text), bad.text.slice(0, 120));
        ok("and it is drawn as an error", bad.err === true);
        ok("the name box stays focusable, with the cursor in it", bad.inputDisabled === false && bad.focused === true, bad);

        // 3b. a folder that already exists: 409.
        await press(TAKEN);
        const taken = await waitMsg("already exists");
        ok("an existing folder reports `already exists` in the row", /already exists/.test(taken.text), taken.text.slice(0, 160));
        ok("and it is drawn as an error", taken.err === true);
        ok("the box is still the place to fix it", taken.inputDisabled === false && taken.focused === true);
        ok("the existing folder is untouched", !ran(path.join(REPOS, TAKEN), ["rev-parse", "--git-dir"]) && existsSync(path.join(REPOS, TAKEN, "keep.txt")));

        // 3c. a root that is no longer a scanRoot: 400. This is a stale page — the folder was a root
        // when it was drawn — so the button's own root is what carries the refusal.
        await page.evaluate((p) => {
          const btn = document.querySelector("[data-project-new]");
          if (btn) btn.dataset.projectNew = p;
        }, OUTSIDE.replace(/\\/g, "/"));
        await press("outside-proj");
        const outsideMsg = await waitMsg("root must be one of scanRoots");
        ok("a root outside scanRoots reports in the row", /root must be one of scanRoots/.test(outsideMsg.text), outsideMsg.text.slice(0, 160));
        ok("and it is drawn as an error", outsideMsg.err === true);
        ok("the box is still the place to fix it", outsideMsg.inputDisabled === false && outsideMsg.focused === true);
        ok("nothing was written outside the scan root", !existsSync(path.join(OUTSIDE, "outside-proj")));
        // Back to a root the panel knows, so the success below is the shipped path and not the probe's.
        await page.evaluate(() => {
          const form = document.querySelector("[data-clone-form]");
          const btn = form?.querySelector("[data-project-new]");
          if (btn) btn.dataset.projectNew = form.dataset.cloneForm;
        });

        // 4. the press. A marker on `window` proves the board was not reloaded to show the result.
        await page.evaluate(() => {
          window.__verifyBoot = "alive";
        });
        await press(NAME);
        const made = await waitMsg("created →", 60_000);
        ok("the row reports the project it made", /created →/.test(made.text), made.text.slice(0, 200));
        ok("and the message is not drawn as an error", made.err === false);

        const landed = await page
          .waitForFunction((name) => Boolean(document.querySelector(`section.project[data-project="${name}"]`)), NAME, { timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
        ok("the project is on the board", landed === true, landed ? NAME : "no section.project for the new name");
        ok("with no page reload", (await page.evaluate(() => window.__verifyBoot)) === "alive");

        // The project's own row, on main — expanded the way a reader opens a minimized project.
        await page.evaluate((name) => {
          const sec = document.querySelector(`section.project[data-project="${name}"]`);
          if (sec?.classList.contains("collapsed")) sec.querySelector("[data-toggle-project]")?.click();
        }, NAME);
        await page
          .waitForFunction(
            (name) => {
              const tr = document.querySelector(`section.project[data-project="${name}"] tr.row`);
              return (tr?.querySelector("td.branch .branch-plain")?.textContent || "").trim() === "main";
            },
            NAME,
            { timeout: 30_000 },
          )
          .catch(() => null);
        const drawn = await page.evaluate((name) => {
          const sec = document.querySelector(`section.project[data-project="${name}"]`);
          const tr = sec?.querySelector("tr.row");
          return {
            branch: tr?.querySelector("td.branch .branch-plain")?.textContent?.trim() || null,
            text: tr ? tr.innerText.replace(/\s+/g, " ").trim().slice(0, 300) : null,
          };
        }, NAME);
        ok("its row draws the branch as main", drawn.branch === "main", drawn.branch || "no branch cell");
        ok("the row never reads NO BASE REF", !/NO BASE REF/i.test(drawn.text || ""), drawn.text);

        // 5. git's own answers on the checkout the route made.
        const dest = path.join(REPOS, NAME);
        ok("the project folder is a git repository", existsSync(path.join(dest, ".git")));
        ok("HEAD is on main", git(dest, ["rev-parse", "--abbrev-ref", "HEAD"]) === "main");
        ok("refs/heads/main exists", ran(dest, ["rev-parse", "--verify", "refs/heads/main"]));
        ok("there is exactly ONE commit", git(dest, ["rev-list", "--count", "HEAD"]) === "1", git(dest, ["rev-list", "--count", "HEAD"]));
        ok("the one commit carries the README", /README\.md/.test(git(dest, ["log", "--oneline", "--name-only", "HEAD"])));
        ok("and the tree is clean", git(dest, ["status", "--porcelain"]) === "");

        // The three refusals above are DELIBERATE 400s and a 409, so the browser logs them as failed
        // resource loads. That noise is expected; an uncaught page error is not.
        const unexpected = consoleErrors.filter((line) => !/Failed to load resource: the server responded with a status of (400|409)/.test(line));
        ok("the page threw nothing", pageErrors.length === 0, pageErrors);
        ok("and logged nothing but the refusals this gate drove", unexpected.length === 0, unexpected);
      },
      { playwright: engine, viewport: { width: 1600, height: 1000 } },
    );
  }
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run itself threw: ${String((e && e.stack) || e)}`);
} finally {
  if (panel) await panel.stop().catch(() => {});
  await sleep(200);
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  console.log(`\n${checks} checks, ${failures} failed`);
  if (noBrowser) console.log("RESULT: BROWSER-HALF-NOT-RUN (the HTTP half above is the whole result)");
  else console.log(failures ? "RESULT: FAILED" : "RESULT: ALL PASS");
  process.exit(noBrowser ? 2 : failures ? 1 : 0);
}
