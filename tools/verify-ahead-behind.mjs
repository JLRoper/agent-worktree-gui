// The Ahead / Behind column, driven end to end: a branch counted against its OWN copy on the remote, in every state.
//
//   node tools/verify-ahead-behind.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-ahead-behind.mjs --out C:/somewhere
//
// WHY. The column used to count against the project's MAIN, so a branch that was fully pushed read "1 / 1" because
// main had moved, and a branch nobody had pushed looked the same as one that was level. It now means what every git
// client means — ↑ not pushed, ↓ not pulled, against the branch's own copy on the remote — and the count against main
// moved into the verdict's tooltip. test/scan-upstream.test.js proves the numbers against real git; this proves what a
// reader SEES, for rows a unit test cannot reach: the page, the board's own fetch, and a remote that stops answering.
//
// WHAT IS DRIVEN: real git repositories under a scratch directory (a bare origin, the project's clone, a second clone
// that stands for "somebody else"), one worktree per state, a real panel booted from server.js against a throwaway
// config (tools/panel-testkit.mjs), and the board loaded in headless Chromium. Nothing is mocked: the board's own
// fetch brings in the other clone's pushes and prunes the deleted branch, and the stale row is a project whose
// `origin` is changed to a path that does not exist AFTER its branch was pushed.
//
// Exit codes: 0 every check passed, 1 a check failed, 2 no Playwright install (BROWSER-HALF-NOT-RUN).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "wtgui-ahead-behind-"));
const S = scratch.replace(/\\/g, "/");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const OUT = args.out || "C:/CodeReviews/agent-worktree-gui/ahead-behind";
mkdirSync(OUT, { recursive: true });
const REPOS = `${S}/repos`;
const ORIGIN = `${S}/srv/proof.git`;
const PROJECT = `${REPOS}/proof`;
const OTHER = `${S}/other`;
const ORIGIN_DEAD = `${S}/srv/proof-dead.git`;
const DEAD = `${REPOS}/proof-dead`;
const NOWHERE = `${S}/srv/nowhere/proof-dead.git`;

const BR = {
  level: "wtgui/ab-level-aaaaaa",
  ahead: "wtgui/ab-ahead-bbbbbb",
  behind: "wtgui/ab-behind-cccccc",
  diverged: "wtgui/ab-diverged-dddddd",
  none: "wtgui/ab-none-eeeeee",
  gone: "wtgui/ab-gone-ffffff",
  untracked: "wtgui/ab-untracked-111111",
  stale: "wtgui/ab-stale-222222",
};
// What the board must settle on for each row before it is read.
const WANT = { level: "level", ahead: "ahead", behind: "behind", diverged: "diverged", none: "none", gone: "gone", untracked: "untracked", stale: "ahead" };

let checks = 0;
let failures = 0;
const ok = (name, cond, detail) => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const say = (line) => console.log(`      ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ID = ["-c", "user.email=proof@localhost", "-c", "user.name=proof", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
const g = (cwd, ...a) =>
  execFileSync("git", ["-C", cwd, ...ID, ...a], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
  }).trim();
let counter = 0;
const commit = (dir, file) => {
  writeFileSync(path.join(dir, file), `${file} ${++counter}\n`);
  g(dir, "add", file);
  g(dir, "commit", "-q", "-m", file);
};
const treeOf = (project, branch) => `${project}/.worktrees/${branch.split("/").pop()}`;

function makeFixture() {
  mkdirSync(REPOS, { recursive: true });
  mkdirSync(`${S}/srv`, { recursive: true });
  for (const [origin, project] of [[ORIGIN, PROJECT], [ORIGIN_DEAD, DEAD]]) {
    g(S, "init", "-q", "--bare", "-b", "main", origin);
    g(S, "clone", "-q", origin, project);
    g(project, "switch", "-q", "-C", "main");
    commit(project, "base.txt");
    g(project, "push", "-q", "-u", "origin", "main");
  }
  g(S, "clone", "-q", ORIGIN, OTHER);
  g(OTHER, "switch", "-q", "-C", "main", "origin/main");

  const cut = (project, branch) => {
    g(project, "worktree", "add", "-q", "-b", branch, treeOf(project, branch), "origin/main");
    commit(treeOf(project, branch), `${branch.split("/").pop()}.txt`);
    return treeOf(project, branch);
  };

  // level: pushed, nothing since
  g(cut(PROJECT, BR.level), "push", "-q", "-u", "origin", BR.level);
  // ahead: pushed, then two commits that are not
  let t = cut(PROJECT, BR.ahead);
  g(t, "push", "-q", "-u", "origin", BR.ahead);
  commit(t, "ahead-1.txt");
  commit(t, "ahead-2.txt");
  // behind: pushed, then somebody else pushes a commit to it (the project has not fetched it yet)
  t = cut(PROJECT, BR.behind);
  g(t, "push", "-q", "-u", "origin", BR.behind);
  g(OTHER, "fetch", "-q", "origin");
  g(OTHER, "switch", "-q", "-C", BR.behind, `origin/${BR.behind}`);
  commit(OTHER, "theirs-behind.txt");
  g(OTHER, "push", "-q", "origin", BR.behind);
  // diverged: the same, and a commit of our own as well
  t = cut(PROJECT, BR.diverged);
  g(t, "push", "-q", "-u", "origin", BR.diverged);
  g(OTHER, "fetch", "-q", "origin");
  g(OTHER, "switch", "-q", "-C", BR.diverged, `origin/${BR.diverged}`);
  commit(OTHER, "theirs-diverged.txt");
  g(OTHER, "push", "-q", "origin", BR.diverged);
  commit(t, "mine-diverged.txt");
  // none: committed, never pushed (its upstream is origin/main, which is not a copy of it)
  cut(PROJECT, BR.none);
  // gone: pushed, then the branch is deleted on the remote (the project has not fetched, so it is not pruned yet)
  g(cut(PROJECT, BR.gone), "push", "-q", "-u", "origin", BR.gone);
  g(OTHER, "push", "-q", "origin", "--delete", BR.gone);
  // untracked: pushed WITHOUT -u, so the remote has it and the tree is not set to track it
  g(cut(PROJECT, BR.untracked), "push", "-q", "origin", `HEAD:refs/heads/${BR.untracked}`);
  // main moves on, so the count against main differs from the count against the branch's own copy
  g(OTHER, "switch", "-q", "main");
  commit(OTHER, "main-moves.txt");
  g(OTHER, "push", "-q", "origin", "main");

  // stale: a project whose branch was pushed, and whose remote stops answering afterwards
  t = cut(DEAD, BR.stale);
  g(t, "push", "-q", "-u", "origin", BR.stale);
  commit(t, "stale-1.txt");
  g(DEAD, "remote", "set-url", "origin", NOWHERE);
}

async function readRows(base) {
  const state = await (await fetch(`${base}/api/state`)).json();
  const rows = {};
  for (const project of state.projects || []) for (const row of project.worktrees || []) if (row.branch) rows[row.branch] = { row, project };
  return rows;
}

// A row is a projection of the last passes: the board's own fetch brings in the other clone's work, so "Refresh now"
// is pressed (the one control a person would use) and the rows are read back until each one has settled on the state
// it is meant to be in.
async function waitForSettled(base, ms = 120_000) {
  const start = Date.now();
  let lastPress = 0;
  let rows = {};
  while (Date.now() - start < ms) {
    if (Date.now() - lastPress > 6000) {
      await fetch(`${base}/api/refresh`, { method: "POST" }).catch(() => {});
      lastPress = Date.now();
    }
    try {
      rows = await readRows(base);
      const settled = Object.entries(WANT).every(([key, state]) => {
        const hit = rows[BR[key]];
        if (!hit || hit.row?.sync?.state !== state) return false;
        if (key === "stale") return hit.row.sync.stale === true && Boolean(String(hit.project?.fetchNote || "").trim());
        return true;
      });
      if (settled) return rows;
    } catch {
      /* the panel is still booting */
    }
    await sleep(400);
  }
  return rows;
}

let panel = null;
let noBrowser = false;
try {
  console.log(`scratch: ${S}`);
  makeFixture();
  panel = await startPanel({
    config: {
      scanRoots: [REPOS],
      projects: [
        { name: "proof", path: PROJECT, remote: "origin", mainBranch: "main" },
        { name: "proof-dead", path: DEAD, remote: "origin", mainBranch: "main" },
      ],
      // Fetch on every pass, so the other clone's pushes and the deleted branch reach the project's refs inside a
      // test's patience, and the dead remote's failure is recorded as the project's fetch note.
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

  const rows = await waitForSettled(panel.base);
  for (const key of Object.keys(BR)) {
    const hit = rows[BR[key]];
    say(`${key.padEnd(9)} sync=${JSON.stringify(hit?.row?.sync && { s: hit.row.sync.state, a: hit.row.sync.ahead, b: hit.row.sync.behind, stale: hit.row.sync.stale })} vs-main=${hit?.row?.ahead}/${hit?.row?.behind} verdict=${hit?.row?.verdict}`);
  }

  // ---- the API half: the server's answer, per state, and that it is NOT the count against main ----
  const at = (key) => rows[BR[key]]?.row || null;
  const pair = (r) => [r?.sync?.ahead, r?.sync?.behind];
  ok("level: counted against its own copy, 0 / 0", at("level")?.sync?.state === "level" && pair(at("level")).join() === "0,0", at("level")?.sync);
  ok("level: its own copy is origin/<branch>", at("level")?.sync?.ref === `origin/${BR.level}`, at("level")?.sync?.ref);
  ok("level: while the count against main is NOT level (1 ahead, 1 behind) — the two are different questions", at("level")?.ahead === 1 && at("level")?.behind === 1, [at("level")?.ahead, at("level")?.behind]);
  ok("ahead: two commits that are not pushed", at("ahead")?.sync?.state === "ahead" && pair(at("ahead")).join() === "2,0", at("ahead")?.sync);
  ok("behind: one commit somebody else pushed, not pulled", at("behind")?.sync?.state === "behind" && pair(at("behind")).join() === "0,1", at("behind")?.sync);
  ok("diverged: one of each", at("diverged")?.sync?.state === "diverged" && pair(at("diverged")).join() === "1,1", at("diverged")?.sync);
  ok("none: never pushed has no counts and no ref", at("none")?.sync?.state === "none" && at("none")?.sync?.ahead === null && at("none")?.sync?.ref === null, at("none")?.sync);
  ok("none: its git upstream is main, which is not counted as its copy", at("none")?.upstream === "origin/main", at("none")?.upstream);
  ok("gone: the remote deleted it and the board's fetch pruned it", at("gone")?.sync?.state === "gone", at("gone")?.sync);
  ok("untracked: the remote has it, the tree does not track it", at("untracked")?.sync?.state === "untracked", at("untracked")?.sync);
  ok("stale: counted, and marked because the project's last fetch failed", at("stale")?.sync?.state === "ahead" && at("stale")?.sync?.stale === true, at("stale")?.sync);
  ok("stale: the sentence quotes the project's fetch note", Boolean(rows[BR.stale]?.project?.fetchNote) && String(at("stale")?.sync?.why || "").includes(String(rows[BR.stale].project.fetchNote).replace(/\s+/g, " ").trim().slice(0, 40)), at("stale")?.sync?.why);
  ok("a healthy project's counts are not marked stale", ["level", "ahead", "behind", "diverged"].every((k) => at(k)?.sync?.stale === false), ["level", "ahead", "behind", "diverged"].map((k) => at(k)?.sync?.stale));

  // ---- the browser half: what the reader sees ----
  const engine = loadPlaywright();
  if (!engine) {
    console.log(notRun("the Ahead / Behind cells", "no Playwright install found — set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright"));
    noBrowser = true;
  } else {
    await withBrowser(
      async ({ page }) => {
        await openPage(page, panel.base, { selector: "section.project [data-toggle-project]" });
        await page.evaluate(() => {
          for (const sec of document.querySelectorAll("section.project.collapsed")) sec.querySelector("[data-toggle-project]")?.click();
        });
        await page.waitForFunction((b) => [...document.querySelectorAll("tr.row")].some((tr) => (tr.querySelector("td.branch")?.textContent || "").includes(b)), BR.level, { timeout: 30_000 });
        const verdicts = Object.fromEntries(Object.entries(BR).map(([k, b]) => [k, String(rows[b]?.row?.verdict || "")]));
        // A repaint can replace a row between settling and reading, so the read is retried until every row has a cell.
        let cells = null;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          cells = await page.evaluate(({ branches, verdicts }) => {
            const out = {};
            for (const [key, br] of Object.entries(branches)) {
              const tr = [...document.querySelectorAll("tr.row")].find((t) => (t.querySelector("td.branch")?.textContent || "").includes(br));
              const ab = tr?.querySelector("span.ab") || null;
              if (!ab) { out[key] = null; continue; }
              const up = ab.querySelector(".ab-up");
              const down = ab.querySelector(".ab-down");
              const dim = ab.querySelector(".dimmer");
              const badge = [...tr.querySelectorAll(".badge")].find((b) => b.textContent.trim().startsWith(verdicts[key].slice(0, 6))) || null;
              out[key] = {
                sync: ab.getAttribute("data-sync"),
                text: ab.textContent.replace(/\s+/g, " ").trim(),
                title: ab.getAttribute("title") || "",
                cls: ab.className,
                dataAhead: ab.getAttribute("data-ahead"),
                dataBehind: ab.getAttribute("data-behind"),
                upColor: up ? getComputedStyle(up).color : null,
                downColor: down ? getComputedStyle(down).color : null,
                dimColor: dim ? getComputedStyle(dim).color : null,
                staleBorder: getComputedStyle(ab).borderBottomStyle,
                hasQ: Boolean(ab.querySelector(".ab-q")),
                verdictText: badge ? badge.textContent.trim() : null,
                verdictTitle: badge ? badge.getAttribute("title") || "" : null,
              };
            }
            const th = [...document.querySelectorAll("th")].find((t) => t.textContent.trim() === "Ahead / Behind");
            out._header = th ? th.getAttribute("title") || "" : null;
            out._legacy = document.querySelectorAll('[data-sync="legacy"]').length;
            out._oldStyle = [...document.querySelectorAll("tr.row span.ab")].filter((s) => /^\d+\s*\/\s*\d+$/.test(s.textContent.trim())).length;
            return out;
          }, { branches: BR, verdicts });
          if (Object.keys(BR).every((k) => cells[k])) break;
          await page.waitForTimeout(400);
        }
        for (const key of Object.keys(BR)) say(`${key.padEnd(9)} "${cells[key]?.text}"  [${cells[key]?.sync}]  ${cells[key]?.cls}`);

        const shot = path.join(OUT, "ahead-behind-column.png");
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            const sec = page.locator("section.project", { hasText: BR.level }).first();
            await sec.scrollIntoViewIfNeeded({ timeout: 5000 });
            await page.waitForTimeout(150);
            await sec.screenshot({ path: shot, animations: "disabled", timeout: 10_000 });
            say(`shot: ${shot}`);
            break;
          } catch (e) {
            if (attempt === 7) say(`could not screenshot the table: ${String((e && e.message) || e)}`);
            else await page.waitForTimeout(300);
          }
        }

        const texts = { level: "↑0 ↓0", ahead: "↑2 ↓0", behind: "↑0 ↓1", diverged: "↑1 ↓1", none: "—", gone: "gone", untracked: "?", stale: "↑1 ↓0?" };
        for (const key of Object.keys(BR)) {
          ok(`${key}: the cell reads "${texts[key]}"`, cells[key]?.text === texts[key], cells[key]?.text);
        }
        for (const key of ["level", "ahead", "behind", "diverged", "none", "gone", "untracked"]) {
          ok(`${key}: the cell says which state it is drawing (data-sync="${WANT[key]}")`, cells[key]?.sync === WANT[key], cells[key]?.sync);
        }
        ok("stale: data-sync is the counted state, with the dotted mark and a ?", cells.stale?.sync === "ahead" && cells.stale?.cls.includes("ab-stale") && cells.stale?.hasQ && cells.stale?.staleBorder === "dotted", { sync: cells.stale?.sync, cls: cells.stale?.cls, border: cells.stale?.staleBorder });
        ok("no healthy row is marked stale", ["level", "ahead", "behind", "diverged"].every((k) => !cells[k]?.cls.includes("ab-stale") && !cells[k]?.hasQ), ["level", "ahead", "behind", "diverged"].map((k) => cells[k]?.cls));
        ok("the counts are on data attributes for anything that reads the page", cells.ahead?.dataAhead === "2" && cells.ahead?.dataBehind === "0" && cells.diverged?.dataAhead === "1" && cells.diverged?.dataBehind === "1", [cells.ahead?.dataAhead, cells.ahead?.dataBehind, cells.diverged?.dataAhead, cells.diverged?.dataBehind]);

        // The side with work to do is lit, the side without is dim, and the two lit colours differ from each other.
        ok("↑ with work is lit warm, ↓ with work is lit blue, and they differ", Boolean(cells.ahead?.upColor) && Boolean(cells.behind?.downColor) && cells.ahead.upColor !== cells.behind.downColor, { up: cells.ahead?.upColor, down: cells.behind?.downColor });
        ok("a side with nothing to do is dim, not lit", cells.level?.dimColor !== cells.ahead?.upColor && cells.level?.dimColor !== cells.behind?.downColor, { dim: cells.level?.dimColor });

        // The tooltip says what the numbers mean, in the server's words, and ends with the count against main.
        ok("ahead: the tooltip says not pushed", /↑2: 2 commits here that origin\/.* does not have yet — not pushed/.test(cells.ahead?.title || ""), cells.ahead?.title);
        ok("behind: the tooltip says not pulled", /↓1: 1 commit on origin\/.* that is not here — not pulled/.test(cells.behind?.title || ""), cells.behind?.title);
        ok("none: the tooltip says it has never been pushed", /never been pushed/.test(cells.none?.title || ""), cells.none?.title);
        ok("gone: the tooltip says the copy was deleted", /no longer exists|deleted on the remote/.test(cells.gone?.title || ""), cells.gone?.title);
        ok("untracked: the tooltip gives the command that makes it count", /git branch -u origin\//.test(cells.untracked?.title || ""), cells.untracked?.title);
        ok("stale: the tooltip says the last fetch failed", /The last fetch failed/.test(cells.stale?.title || ""), cells.stale?.title);
        ok("every tooltip ends with the count against main", Object.keys(BR).every((k) => /Against origin\/main: \d+ commits? here that it does not have, \d+ on it that this branch does not have/.test(cells[k]?.title || "")), Object.keys(BR).map((k) => (cells[k]?.title || "").slice(-70)));

        // The count against main now lives in the verdict.
        ok("the verdict's tooltip carries the count against main (level row: 1 ahead, 1 behind)", String(cells.level?.verdictTitle || "").includes("Against origin/main: 1 ahead, 1 behind."), cells.level?.verdictTitle);
        ok("every row's verdict tooltip carries it", Object.keys(BR).every((k) => /Against origin\/main: \d+ ahead, \d+ behind\./.test(cells[k]?.verdictTitle || "")), Object.keys(BR).map((k) => [k, cells[k]?.verdictText, (cells[k]?.verdictTitle || "").slice(-45)]));

        ok("the column header explains the arrows", /not pushed yet/.test(cells._header || "") && /not pulled/.test(cells._header || ""), cells._header);
        ok("no cell is drawn the old way (\"N / M\" against main)", cells._oldStyle === 0, cells._oldStyle);
        ok("no cell says the server is older than the page", cells._legacy === 0, cells._legacy);
      },
      { playwright: engine, viewport: { width: 1700, height: 1000 } },
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
