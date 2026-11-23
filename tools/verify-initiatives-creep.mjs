#!/usr/bin/env node
// THE INITIATIVES PANE HOLDS THE READER'S PLACE WHILE IT REPAINTS.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiatives-creep.mjs [--seconds 60]
//
// WHAT THIS GATE PROVES, and why each check is here:
//
//   The reader's report: the pane creeps UP one line every 5 seconds while they read it. Measured first with
//   tools/measure-initiatives-creep.mjs (60 s at 250 ms, the table pasted into the PR): an UNCHANGED payload lays out
//   identically - scrollTop delta 0 across 15 polls - so the creep is not the stamps re-flowing on their own. It is
//   the poll's own repaint applying a change ABOVE the reader: a task row filed or retired out of an open fold, a
//   stamp that crossed a minute and rewrapped a line. With the scroller left alone, every one of those moves the rows
//   the reader is looking at. That is the mechanism this gate pins, from four sides:
//
//   1. THE POLL RUNS AND NOTHING MOVES. With the pane parked mid-list and the page left alone for 60 s, the pane's
//      own GET /api/initiatives poll is counted from the network: at least 12 of them, and the pane's scrollTop and
//      the reader's card do not move at all across them.
//   2. AN UNCHANGED PAYLOAD IS NOT REPAINTED. A whole-pane rebuild is counted from a childList observer on the pane
//      itself. Fifteen polls must not be fifteen rebuilds: at most one is allowed (a relative stamp that crossed a
//      minute and rewrote a word). Before the fix this was one rebuild per poll.
//   3. A REAL CHANGE STILL LANDS, WITHOUT A MANUAL REFRESH. A fourth wave is written into the fixture's wave store,
//      and the pane's own poll must draw it (`[data-wave-id]`) with no press of Refresh - the poll is the only reason
//      a new wave ever appears, so silencing the repaint is not a fix. And the reader's card must not move while it
//      is drawn.
//   4. THE CHANGE THAT MOVED THEM IS TAKEN OUT. A task is filed on the FIRST initiative (above the reader's view)
//      while the pane is parked below it. The content grows, the scroll follows it, and the card the reader was
//      looking at stays where it was. Before the fix that card moved down by the height of the filed row (53 px
//      measured), which is the reader's creep seen from the other side.
//
// Sandbox only: its own config, port, WAG_HOME and logs, assistant disabled, an apiServer pointed at a dead port.
// The reader's live board on 7331 is never touched. Without Playwright the script says BROWSER-NOT-RUN and exits 2
// rather than passing on a half that never ran.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { buildFixture, defaultHome, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "./initiatives-fixture.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const IDLE_SECONDS = Number(arg("--seconds", "60"));
const IDLE_MS = IDLE_SECONDS * 1000;
const SAMPLE_MS = 250;
const HOME = path.resolve(arg("--home", defaultHome()));

// A hang here would otherwise be silent (a browser left open keeps node's loop alive and the log never lands).
const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 360_000);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 100) / 100;

// The fixture: three projects with real worktrees, four initiatives (one long description, one missing tree), two
// assistants with queue rows in all four states, and a wave store on init_sso. Written into a home under scratch and
// booted on its own port, so the reader's board on 7331 is untouched.
const fixture = await buildFixture({ home: HOME });
console.log(`fixture home: ${fixture.home}`);
const panel = await startFixturePanel({ home: fixture.home });
const base = panel.base;
console.log(`sandbox: ${base}`);
console.log(`panel pid: ${panel.pid}`);

let browser = null;
try {
  await waitForFixtureRows(base, { timeout: 90_000 });
  await waitForInitiativesView(base, { timeout: 60_000 });

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the initiatives pane's idle repaint", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        // The poll is counted from the network: after the fix an idle poll leaves no DOM trace at all, so counting
        // repaints would count the wrong thing.
        let polls = 0;
        page.on("request", (r) => {
          try {
            if (new URL(r.url()).pathname === "/api/initiatives") polls += 1;
          } catch {
            /* a data: URL is not one of ours */
          }
        });

        await openPage(page, base, { selector: "#projects" });
        const open = await page.evaluate(() => {
          const el = document.getElementById("assistant");
          return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
        });
        if (!open) await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
        await page.click('#as-tabs [data-as-tab="initiatives"]');
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });

        // Every card open, every assistant fold open, every task fold open: the state the reader reports the creep in,
        // and the state with the most content above the fold to be moved by.
        const pressAll = async (sel, limit) => {
          for (let guard = 0; guard < limit; guard += 1) {
            const folded = page.locator(`#as-initiatives ${sel}[aria-expanded="false"]`).first();
            if ((await folded.count()) === 0) return guard;
            await folded.click();
          }
          return limit;
        };
        await pressAll(".init-head-btn", 40);
        await pressAll("[data-init-assist-fold]", 30);
        await pressAll("[data-init-task-fold]", 30);
        await page.mouse.move(3, 3); // the pointer out of the pane: no hover rule may re-flow a row under the sample

        // The reader's place: the third card, 20 px inside the pane's top edge. The two cards above it are the content
        // a filed row moves.
        const parked = await page.evaluate(() => {
          const pane = document.getElementById("as-initiatives");
          const cards = [...pane.querySelectorAll(".init-card")];
          const want = cards[2] || null;
          const top = want ? want.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 20 : 0;
          pane.scrollTop = Math.max(0, Math.round(top));
          return { scrollTop: Math.round(pane.scrollTop), cards: cards.length, id: want ? want.getAttribute("data-init-card") : null };
        });
        note(`pane parked on ${parked.id} at scrollTop ${parked.scrollTop}, ${parked.cards} cards on screen`);
        await sleep(500);

        // A whole-pane rebuild is ONE childList record on the pane element itself (innerHTML replacement). The task
        // folds write deeper, inside their own boxes, so they are not counted here.
        await page.evaluate(() => {
          const pane = document.getElementById("as-initiatives");
          window.__creep = { rebuilds: 0 };
          new MutationObserver((records) => {
            for (const r of records) if (r.target === pane) window.__creep.rebuilds += 1;
          }).observe(pane, { childList: true });
        });

        // One read of the pane and the reader's card, from the painted page. Never a computed guess.
        const read = () =>
          page.evaluate((markerId) => {
            const r2 = (n) => Math.round(n * 100) / 100;
            const pane = document.getElementById("as-initiatives");
            const pr = pane.getBoundingClientRect();
            const card = markerId ? pane.querySelector(`.init-card[data-init-card="${markerId}"]`) : null;
            const cr = card ? card.getBoundingClientRect() : null;
            return {
              scrollTop: r2(pane.scrollTop),
              scrollHeight: pane.scrollHeight,
              clientHeight: pane.clientHeight,
              cardVy: cr ? r2(cr.top - pr.top) : null,
              cardCy: cr ? r2(cr.top - pr.top + pane.scrollTop) : null,
              rebuilds: window.__creep.rebuilds,
              waves: pane.querySelectorAll("[data-wave-id]").length,
              rows: pane.querySelectorAll("[data-init-tasks] > *").length,
            };
          }, parked.id);

        // ---- 1. 60 s alone: the poll runs, nothing moves ---------------------------------------------------
        console.log(`\n== 1. ${IDLE_SECONDS}s alone, the pane's own poll the only thing happening ==`);
        const before = await read();
        const rows = [];
        const t0 = Date.now();
        let next = 0;
        for (;;) {
          const at = Date.now() - t0;
          if (at >= next && at <= IDLE_MS) {
            rows.push({ t: at, polls, ...(await read()) });
            next += SAMPLE_MS;
          }
          if (at > IDLE_MS) break;
          await sleep(40);
        }
        const after = rows[rows.length - 1];
        console.log("        t(ms)   top      h      ch   cardVy   cardCy  polls rebuilds");
        for (let i = 0; i < rows.length; i += 8) {
          const r = rows[i];
          console.log(`      ${String(r.t).padStart(6)}  ${String(r.scrollTop).padStart(7)}  ${String(r.scrollHeight).padStart(5)}  ${String(r.clientHeight).padStart(4)}  ${String(r.cardVy).padStart(7)}  ${String(r.cardCy).padStart(6)}  ${String(r.polls).padStart(5)} ${String(r.rebuilds).padStart(8)}`);
        }
        const tops = rows.map((r) => r.scrollTop);
        const cys = rows.map((r) => r.cardVy).filter((v) => v != null);
        const moved = rows.filter((r) => r.scrollTop !== before.scrollTop).length;
        const counted = after.polls;
        const rebuilds = after.rebuilds - before.rebuilds;
        note(`samples ${rows.length} at ${SAMPLE_MS} ms; scrollTop ${before.scrollTop} to ${after.scrollTop}; card ${before.cardVy} to ${after.cardVy}`);
        ok("the pane's own poll ran at least 12 times", counted >= 12, `${counted} GET /api/initiatives polls in the window`);
        check("scrollTop did not move across the idle window", moved, 0);
        check("the pane's content height did not change", after.scrollHeight - before.scrollHeight, 0);
        ok("the card the reader was looking at did not move", cys.length > 0 && Math.max(...cys) - Math.min(...cys) <= 1, `vy ${Math.min(...cys)} to ${Math.max(...cys)}`);
        ok("an unchanged payload is not rebuilt on every poll", rebuilds <= 1, `${rebuilds} whole-pane rebuilds across ${counted} polls (one is allowed: a relative stamp crossing a minute)`);

        // ---- 2. a manual scroll survives three polls -------------------------------------------------------
        console.log("\n== 2. a manual scroll to mid-pane survives three polls ==");
        const scrolled = await page.evaluate(() => {
          const pane = document.getElementById("as-initiatives");
          const max = pane.scrollHeight - pane.clientHeight;
          pane.scrollTop = Math.round(Math.min(max - 20, pane.scrollTop + 260));
          return Math.round(pane.scrollTop);
        });
        await sleep(400);
        const mark = await read();
        const wantPolls = polls + 3;
        const waitFrom = Date.now();
        while (polls < wantPolls && Date.now() - waitFrom < 30_000) await sleep(100);
        const held = await read();
        check("the pane's own poll landed three more times", polls >= wantPolls, true);
        check("the scrollTop the reader left is still there", held.scrollTop, mark.scrollTop);
        check("the card under their eye is still in the same place", held.cardVy, mark.cardVy);
        note(`scrollTop ${scrolled}, card vy ${mark.cardVy}, after ${polls} polls: scrollTop ${held.scrollTop}, card vy ${held.cardVy}`);

        // ---- 3. a real change still lands without a manual refresh ------------------------------------------
        console.log("\n== 3. a new wave lands on the pane's own poll ==");
        const wavesFile = path.join(fixture.home, "state", "waves.json");
        const waveStore = JSON.parse(readFileSync(wavesFile, "utf8"));
        const lane = waveStore.byInitiative.init_sso || [];
        lane.push({
          id: "wave-creep-gate",
          initiativeId: "init_sso",
          position: lane.length + 1,
          title: "A wave filed while the reader is reading",
          entryGate: null,
          exitGate: null,
          template: null,
          auto: false,
        });
        waveStore.byInitiative.init_sso = lane;
        writeFileSync(wavesFile, `${JSON.stringify(waveStore, null, 2)}\n`, "utf8");
        const wavesBefore = mark.waves;
        const waveDeadline = Date.now() + 40_000;
        let drawn = null;
        while (Date.now() < waveDeadline) {
          drawn = await read();
          if ((await page.locator('#as-initiatives [data-wave-id="wave-creep-gate"]').count()) > 0) break;
          await sleep(300);
        }
        const waveCount = await page.locator('#as-initiatives [data-wave-id="wave-creep-gate"]').count();
        ok("the wave the store gained is on the pane, with no Refresh pressed", waveCount === 1, `${waveCount} [data-wave-id="wave-creep-gate"] after ${drawn ? drawn.rebuilds - mark.rebuilds : "?"} rebuild(s)`);
        ok("the pane did repaint for it (the poll is not silenced)", drawn ? drawn.rebuilds - mark.rebuilds >= 1 : false, `${drawn ? drawn.rebuilds - mark.rebuilds : "?"} rebuilds`);
        ok("the reader's card held while it was drawn", drawn ? Math.abs(drawn.cardVy - mark.cardVy) <= 1 : false, `card vy ${mark.cardVy} to ${drawn ? drawn.cardVy : "?"}`);
        note(`waves on the pane ${wavesBefore} to ${drawn ? drawn.waves : "?"}`);

        // ---- 4. a row filed above the reader is taken out of their view -------------------------------------
        console.log("\n== 4. a task filed on the FIRST initiative does not move the reader ==");
        // The pane is parked on the third card, so the first card's open task fold is above the view. A running row is
        // drawn first in that fold's window, so it is certain to be in the painted list.
        const queuesFile = path.join(fixture.home, "state", "assistants", "assistant-1", "queue.json");
        const queue = JSON.parse(readFileSync(queuesFile, "utf8"));
        queue.tasks.unshift({
          id: 9001,
          title: "Filed while the reader was reading the list",
          detail: "",
          state: "running",
          owner: null,
          createdBy: "reader",
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          doneAt: null,
          doneBy: null,
          thread: "wtgui-menu-sso-state-cookie",
          threads: [],
          project: "oauth2-multi",
          worktree: path.join(fixture.home, "repos", "oauth2-multi", ".worktrees", "menu-sso-state-cookie"),
          files: [],
          lane: null,
          order: null,
          attempts: 0,
          reason: "",
          hold: null,
          movedFrom: [],
          runId: "run_creep_gate",
        });
        writeFileSync(queuesFile, `${JSON.stringify(queue, null, 1)}\n`, "utf8");
        const filedFrom = await read();
        const taskDeadline = Date.now() + 40_000;
        let filed = null;
        while (Date.now() < taskDeadline) {
          filed = await read();
          if (filed.scrollHeight - filedFrom.scrollHeight > 8) break;
          await sleep(300);
        }
        const grew = filed ? filed.scrollHeight - filedFrom.scrollHeight : 0;
        ok("the row that was filed is on the pane (the content above the reader grew)", grew > 8, `scrollHeight ${filedFrom.scrollHeight} to ${filed ? filed.scrollHeight : "?"} (+${grew})`);
        ok("the card the reader was looking at did not move", filed ? Math.abs(filed.cardVy - filedFrom.cardVy) <= 1 : false, `card vy ${filedFrom.cardVy} to ${filed ? filed.cardVy : "?"}`);
        const follow = filed ? filed.scrollTop - filedFrom.scrollTop : 0;
        ok("the scroll followed the content instead of the reader moving", Math.abs(follow - grew) <= 3, `scrollTop moved ${follow} for ${grew}px of content`);
        note(`scrollTop ${filedFrom.scrollTop} to ${filed ? filed.scrollTop : "?"}, card content offset ${filedFrom.cardCy} to ${filed ? filed.cardCy : "?"}`);

        // ---- 5. health --------------------------------------------------------------------------------------
        console.log("\n== 5. health ==");
        check("no page errors", pageErrors.length, 0);
        check("no console errors", consoleErrors.length, 0);
      },
      { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    );
  }
} catch (err) {
  failures += 1;
  console.log(`\nERROR  ${(err && err.stack) || err}`);
} finally {
  clearTimeout(watchdog);
  await panel.stop();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log("OK - the Initiatives pane holds the reader's place across its repaints, and still repaints for a change");
  process.exit(0);
}
