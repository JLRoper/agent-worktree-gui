#!/usr/bin/env node
// WHAT THE INITIATIVES PANE DOES WHILE THE READER LEAVES IT ALONE.
//
// HARNESS: MEASUREMENT (not a gate - tools/verify-initiatives-creep.mjs is the gate)
//
//   node tools/measure-initiatives-creep.mjs [--seconds 60] [--interval 250] [--json <file>]
//   node tools/measure-initiatives-creep.mjs --url http://127.0.0.1:7331 [--seconds 60]
//
// The reader's report: the pane creeps UP one line every 5 seconds. This samples the pane at a fixed interval and
// prints one row per sample, so the mechanism is read off numbers rather than argued from the source:
//
//   t       ms since the first sample
//   top     the pane's own scrollTop, rounded to 0.01
//   h       the pane's scrollHeight - the content's height
//   ch      the pane's clientHeight
//   markVy  the viewport y of the marker row (the LAST initiative card), relative to the pane's top
//   markCy  the marker's CONTENT coordinate: markVy + top. A constant content coordinate with a falling top is the
//           scroller moving; a falling content coordinate with a constant top is the content above it re-flowing
//           shorter. Those are the two different bugs, told apart by these two columns.
//   c1..c3  the painted heights of the first three cards - the content above the fold. A card that changes height
//           between samples, while `top` holds, is the re-flow.
//   cl, cd  mutations inside the pane since the previous sample: childList (a repaint of a node) and characterData
//           (a stamp rewritten in place)
//   edit    the first 'edited ... ago' stamp on the pane, which is what changes between two polls of an idle store
//
// ANCHOR PROBE. The mutation observer records the pane's scrollTop and scrollHeight in the same microtask the
// display is mutated in, so "the renderer reset the scroller" is a number in this table and not an inference: a
// repaint that leaves scrollTop where it was and a repaint after which it reads 0 are different lines below.
//
// TWO MODES. With `--url` it samples an ALREADY RUNNING panel (read-only: it presses the Initiatives tab, unfolds
// cards in its own tab and scrolls its own pane; no store is written). Without it, tools/initiatives-fixture.mjs
// writes the three stores (initiatives, assistants, queues and the wave store) into a home under scratch and boots
// server.js against it, so nothing here touches the reader's board on 7331.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { buildFixture, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "./initiatives-fixture.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const SECONDS = Number(arg("--seconds", "60"));
const INTERVAL = Number(arg("--interval", "250"));
const JSON_OUT = arg("--json", "");
const URL_ARG = arg("--url", "");
const HOME = path.resolve(arg("--home", path.join(process.env.TEMP || process.env.TMPDIR || ".", "wag", "initiatives-creep-measure")));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let panel = null;
let base = URL_ARG;
if (!URL_ARG) {
  const fixture = await buildFixture({ home: HOME });
  console.log(`fixture home: ${fixture.home}`);
  panel = await startFixturePanel({ home: fixture.home });
  base = panel.base;
}
console.log(`panel: ${base}`);

let browserUp = false;
try {
  if (!URL_ARG) {
    await waitForFixtureRows(base, { timeout: 90_000 });
    await waitForInitiativesView(base, { timeout: 60_000 });
  }

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the initiatives pane's idle behaviour", "playwright is not installed for this node (see tools/browser.mjs)"));
    process.exit(2);
  }
  browserUp = true;
  await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      // The poll itself: the pane's own read of GET /api/initiatives is the beat this measurement is about, so it is
      // counted from the network rather than inferred from a repaint (after the fix an idle poll repaints nothing).
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

      // Unfold every card, so the pane has more content than it can show and there is content above the fold to
      // re-flow. The reader reports the creep on the unfolded list; a title-card-only pane may fit and cannot creep.
      for (let guard = 0; guard < 60; guard += 1) {
        const folded = page.locator('#as-initiatives .init-head-btn[aria-expanded="false"]').first();
        if ((await folded.count()) === 0) break;
        await folded.click();
      }
      // And the assistant folds, where the per-assistant counts and the 'worked ... ago' stamps sit.
      for (let guard = 0; guard < 30; guard += 1) {
        const folded = page.locator('#as-initiatives [data-init-assist-fold][aria-expanded="false"]').first();
        if ((await folded.count()) === 0) break;
        await folded.click();
      }
      await sleep(600);

      const marker = await page.evaluate(() => {
        const cards = [...document.querySelectorAll("#as-initiatives .init-card")];
        const el = cards[cards.length - 1] || null;
        return el ? el.getAttribute("data-init-card") : null;
      });

      // Mid-pane, with the pointer parked outside the pane so no hover rule can re-flow a row under the sample.
      const box = await page.locator("#as-initiatives").boundingBox();
      await page.mouse.move(Math.max(0, box.x - 40), Math.max(0, box.y + 20));
      await page.evaluate(() => {
        const pane = document.getElementById("as-initiatives");
        pane.scrollTop = Math.round((pane.scrollHeight - pane.clientHeight) / 2);
      });
      await sleep(400);

      // The anchor probe: every mutation of the pane records what the scroller reads in the same microtask. A
      // whole-pane rebuild is a childList record whose target IS the pane (an innerHTML write); records deeper than
      // that are the task folds being patched in place, which is a different thing and is counted separately.
      await page.evaluate(() => {
        const pane = document.getElementById("as-initiatives");
        window.__creep = { cl: 0, cd: 0, after: [], rb: 0 };
        new MutationObserver((records) => {
          let cl = 0;
          let cd = 0;
          for (const r of records) {
            if (r.type === "characterData") cd += 1;
            else if (r.type === "childList") {
              cl += 1;
              if (r.target === pane) window.__creep.rb += 1;
            }
          }
          window.__creep.cl += cl;
          window.__creep.cd += cd;
          window.__creep.after.push({ cl, cd, top: Math.round(pane.scrollTop * 100) / 100, h: pane.scrollHeight });
          if (window.__creep.after.length > 400) window.__creep.after.shift();
        }).observe(pane, { childList: true, subtree: true, characterData: true });
      });

      const sample = () =>
        page.evaluate((markerId) => {
          const pane = document.getElementById("as-initiatives");
          const pr = pane.getBoundingClientRect();
          const mark = markerId ? pane.querySelector(`[data-init-card="${markerId}"]`) : null;
          const mr = mark ? mark.getBoundingClientRect() : null;
          const cl = window.__creep.cl;
          const cd = window.__creep.cd;
          const after = window.__creep.after.splice(0);
          window.__creep.cl = 0;
          window.__creep.cd = 0;
          const cards = [...pane.querySelectorAll(".init-card")].slice(0, 3).map((c) => Math.round(c.getBoundingClientRect().height * 100) / 100);
          const edit = pane.querySelector(".init-card .init-meta.as-hint");
          const cs = getComputedStyle(pane);
          return {
            top: Math.round(pane.scrollTop * 100) / 100,
            h: pane.scrollHeight,
            ch: pane.clientHeight,
            markVy: mr ? Math.round((mr.top - pr.top) * 100) / 100 : null,
            markCy: mr ? Math.round((mr.top - pr.top + pane.scrollTop) * 100) / 100 : null,
            cards,
            cl,
            cd,
            after,
            edit: edit ? edit.textContent.trim() : "",
            anchor: cs.overflowAnchor,
            rb: window.__creep.rb,
          };
        }, marker);

      const t0 = Date.now();
      const rows = [];
      const count = Math.ceil((SECONDS * 1000) / INTERVAL);
      for (let i = 0; i <= count; i += 1) {
        const at = Date.now() - t0;
        const s = await sample();
        rows.push({ t: at, polls, ...s });
        await sleep(Math.max(0, INTERVAL - (Date.now() - t0 - at)));
      }

      console.log("");
      console.log("  t(ms)   top      h      ch   markVy   markCy      c1      c2      c3  polls rb cd  edited");
      console.log("  " + "-".repeat(104));
      for (const r of rows) {
        console.log(
          `  ${String(r.t).padStart(6)}  ${String(r.top).padStart(7)}  ${String(r.h).padStart(5)}  ${String(r.ch).padStart(4)}  ${String(r.markVy).padStart(7)}  ${String(r.markCy).padStart(7)}  ${String(r.cards[0] ?? "").padStart(6)}  ${String(r.cards[1] ?? "").padStart(6)}  ${String(r.cards[2] ?? "").padStart(6)}  ${String(r.polls).padStart(5)} ${String(r.rb).padStart(2)} ${String(r.cd).padStart(2)}  ${r.edit}`,
        );
      }
      const first = rows[0];
      const last = rows[rows.length - 1];
      const tops = rows.map((r) => r.top);
      const mutSamples = rows.filter((r) => r.cl > 0 || r.cd > 0).length;
      const moved = rows.filter((r) => r.top !== first.top).length;
      console.log("");
      console.log(`samples: ${rows.length} over ${Math.round((last.t - first.t) / 1000)}s at ${INTERVAL}ms`);
      console.log(`overflow-anchor: ${first.anchor}; pane ${first.ch}px client, ${first.h}px content`);
      console.log(`scrollTop: first ${first.top}, last ${last.top}, delta ${Math.round((last.top - first.top) * 100) / 100}, min ${Math.min(...tops)}, max ${Math.max(...tops)}`);
      console.log(`scrollHeight: first ${first.h}, last ${last.h}, delta ${last.h - first.h}`);
      console.log(`marker content coordinate: first ${first.markCy}, last ${last.markCy}, delta ${Math.round((last.markCy - first.markCy) * 100) / 100}`);
      console.log(`samples where scrollTop differed from the first: ${moved} of ${rows.length}`);
      console.log(`GET /api/initiatives polls seen: ${last.polls}`);
      console.log(`whole-pane rebuilds: ${last.rb}`);
      console.log(`samples that saw a pane mutation: ${mutSamples} of ${rows.length}`);
      const beats = rows.filter((r) => r.cl > 0 || r.cd > 0).map((r) => r.t);
      console.log(`repaints at ms: ${beats.join(", ")}`);
      const afterTops = rows.flatMap((r) => r.after).filter((a) => a.cl > 0);
      console.log(`repaint-time scrollTop readings: ${afterTops.map((a) => a.top).slice(0, 24).join(", ")}${afterTops.length > 24 ? " ..." : ""}`);
      console.log(`repaint-time scrollHeight readings: ${[...new Set(afterTops.map((a) => a.h))].slice(0, 12).join(", ")}`);
      console.log(`page errors: ${pageErrors.length}, console errors: ${consoleErrors.length}`);

      if (JSON_OUT) {
        const out = path.resolve(JSON_OUT);
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, `${JSON.stringify({ base, seconds: SECONDS, interval: INTERVAL, rows, pageErrors, consoleErrors }, null, 2)}\n`, "utf8");
        console.log(`wrote ${out}`);
      }
      return rows;
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
} finally {
  if (panel) await panel.stop();
  if (!browserUp) console.log("no browser was started");
  process.exit(0);
}
