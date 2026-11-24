#!/usr/bin/env node
// THE INITIATIVES META LINE DOES NOT MOVE WHILE A READ IS IN FLIGHT.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-init-read-zero-shift.mjs
//   node tools/verify-init-read-zero-shift.mjs --widths 660,340 --json <file>
//   node tools/verify-init-read-zero-shift.mjs --root <export of the base>   # the failing-first arm
//
// THE DEFECT THIS PINS. `.init-meta` is a flex COLUMN with a gap, and the read's own hint used to be drawn INSIDE it
// (`<span class="as-hint init-read">${initLoading ? "reading…" : …}</span>`, public/assistant.js). Expanding an
// initiative repaints the pane, a stale document starts a read in that same render, and the hint therefore entered the
// meta line for as long as the read took: one line box plus the column's 8px gap, pushing every card below it down and
// snapping back when the read landed. Measured before the fix: 16.67 px at a 640 px dock and 16.67 px at a 340 px
// dock. The fix draws NO node at all while a read is in flight, keeps the `read failed: …` line for a real failure,
// and adds `#as-initiatives .init-read:empty { display: none }` as the second lock: an empty span is still a flex item
// in this column and would still cost the gap.
//
// WHAT THIS GATE MEASURES, per dock width, on the pane's own scroller with the first card below the meta line visible:
//
//   1. ZERO HEIGHT. The first card's viewport top, its content offset and the meta line's own height are read at three
//      instants - before the read, while the read is HELD by the network (a route that parks the request until the
//      sample is taken) and after it settles - and all three must be identical. The card is also asserted to be below
//      the meta line and inside the visible box, so "identical" is a measurement of the scene the reader reported.
//   2. THE STRING NEVER ENTERS THE DOM. A MutationObserver over the pane records the pane's text on every callback; it
//      must never see `reading…` between the two other samples. It is proved able to see it first: the gate plants a
//      span holding the string, requires the observer to record it, then removes it and resets the counters.
//   3. THE REFRESH CONTROL MOVES NOTHING EITHER. The Refresh button's rect (top, height) and its `disabled` property
//      are read at the same three instants; a read changes neither.
//   4. THE FAILURE STILL SHOWS ITS TEXT. The route answers 500 (after a 400 ms delay, so the pane is not made to spin),
//      and the meta line must carry `read failed: <the reason>` in `.init-meta`, one line box high - the state the fix
//      must keep exactly as it renders today.
//
// The pre-fix numbers come from the SAME gate run with `--root <export>`: `git archive origin/main | tar -x -C <dir>`
// and point --root at it. On that arm check 1 fails with the 16.67 px shift and check 2 records the string, which is
// what proves this instrument can see the event it reports zero of.
//
// Sandbox only: the fixture's own WAG_HOME under os.tmpdir(), its own port and its own throwaway repositories (see
// tools/initiatives-fixture.mjs). The reader's live board on 7331 is never touched. Without Playwright the script says
// BROWSER-HALF-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT } from "./panel-testkit.mjs";
import { buildFixture, defaultHome, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "./initiatives-fixture.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const WIDTHS = String(arg("--widths", "660,340"))
  .split(",")
  .map((n) => Number(n))
  .filter((n) => Number.isFinite(n) && n > 0);
const ROOT_OF_RUN = path.resolve(arg("--root", ROOT));
const JSON_OUT = arg("--json", "");
const HOME = path.resolve(arg("--home", defaultHome()));
const HOLD_MS = Number(arg("--hold-ms", "1500")); // how long the in-flight sample is taken before the read is let go
const FAIL_DELAY_MS = 400; // a failing read is slow, not instant: an instant 500 makes the pane retry in a tight loop
const SETTLE_TOLERANCE = 0.5; // sub-pixel: a rounding difference is not a move

// A hang here would otherwise be silent (a browser left open keeps node's loop alive and the log never lands).
const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing - see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

let failures = 0;
let checks = 0;
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
const round = (n) => Math.round(Number(n) * 100) / 100;
const same = (a, b) => Math.abs(Number(a) - Number(b)) <= SETTLE_TOLERANCE;

console.log(`root under test: ${ROOT_OF_RUN}`);
const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the initiatives meta line's in-flight layout", "playwright is not installed for this node (see tools/browser.mjs)"));
  process.exit(2);
}

// The fixture: real repositories and worktrees, four initiatives, assistants and queue rows, a wave store. The pane is
// measured over the REAL route, so the read the gate holds is the one the reader's pane issues.
const fixture = await buildFixture({ home: HOME });
console.log(`fixture home: ${fixture.home}`);
const panel = await startFixturePanel({ home: fixture.home, root: ROOT_OF_RUN });
const base = panel.base;
console.log(`sandbox: ${base}  panel pid: ${panel.pid}`);

const runs = [];
try {
  await waitForFixtureRows(base, { timeout: 90_000 });
  await waitForInitiativesView(base, { timeout: 60_000 });

  await withBrowser(
    async ({ page }) => {
      // THE READ IS HELD BY THE NETWORK. "In flight" is not a guess about a timer: the route parks the pane's own GET
      // until this script has taken the sample, and counts what it parked so the gate can fail when nothing was held.
      let mode = "pass"; // pass | hold | fail
      let requests = 0;
      let heldRequests = 0;
      let releaseFn = null;
      await page.route("**/api/initiatives**", async (route) => {
        const req = route.request();
        if (req.method() !== "GET") return route.continue().catch(() => {});
        requests += 1;
        if (mode === "hold") {
          heldRequests += 1;
          await new Promise((res) => {
            releaseFn = res;
          });
          return route.continue().catch(() => {});
        }
        if (mode === "fail") {
          await sleep(FAIL_DELAY_MS);
          return route
            .fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "the store could not be read (forced by tools/verify-init-read-zero-shift.mjs)" }),
            })
            .catch(() => {});
        }
        return route.continue().catch(() => {});
      });

      for (const width of WIDTHS) {
        // A parked request from the PREVIOUS page is cancelled by the navigation; letting it go and zeroing the counters
        // here is what stops "a read was in flight" from being a leftover of the last width.
        if (releaseFn) {
          releaseFn();
          releaseFn = null;
        }
        mode = "pass";
        requests = 0;
        heldRequests = 0;
        await page.setViewportSize({ width: 1600, height: 820 });
        await page.addInitScript((w) => {
          localStorage.setItem("wm.assistantWidth", String(w));
          localStorage.setItem("wm.assistantOpen", "1");
        }, width);
        await openPage(page, base, { selector: "#projects" });
        await page.waitForSelector("#as-tabs [data-as-tab=\"initiatives\"]", { timeout: 30_000 });
        await page.click('#as-tabs [data-as-tab="initiatives"]');
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });
        await page.waitForTimeout(700);

        const scene = await page.evaluate(() => {
          const host = document.getElementById("as-initiatives");
          const body = host.closest(".as-body");
          const scroller = host.scrollHeight > host.clientHeight + 1 ? host : body && body.scrollHeight > body.clientHeight + 1 ? body : host;
          // The reader's place for this proof: the very top of the pane, where the meta line and the first card below
          // it are both on screen - the scene the report's second screenshot marks.
          scroller.scrollTop = 0;
          // The instrument, and its own sensitivity check. Every callback reads the pane's text; a later task that sets
          // the string and removes it again would be missed, so the gate also reads the text at each sampled instant.
          window.__obs = window.__obs || null;
          if (window.__obs) window.__obs.disconnect();
          window.__obsCount = 0;
          window.__obsSeen = [];
          window.__obs = new MutationObserver(() => {
            window.__obsCount += 1;
            const text = host.textContent || "";
            if (text.indexOf("reading…") >= 0) window.__obsSeen.push({ at: Math.round(performance.now()), sample: text.replace(/\s+/g, " ").slice(0, 160) });
          });
          window.__obs.observe(host, { subtree: true, childList: true, characterData: true });
          // The pane's own markup write: one childList record on the HOST (not the subtree), so "the press repainted"
          // is a number rather than an assumption. A press that only patched a node would not count.
          if (window.__writeObs) window.__writeObs.disconnect();
          window.__writes = 0;
          window.__writeObs = new MutationObserver((records) => {
            window.__writes += records.length;
          });
          window.__writeObs.observe(host, { childList: true });
          const tier = host.querySelector(".init-tier");
          const tierBox = tier ? tier.getBoundingClientRect() : null;
          return {
            requestedWidth: Number(localStorage.getItem("wm.assistantWidth")),
            paneWidth: host.clientWidth,
            scroller: scroller === host ? "pane" : "as-body",
            cards: host.querySelectorAll(".init-card").length,
            tierLines: tierBox ? Math.round(tierBox.height / parseFloat(getComputedStyle(tier).lineHeight)) : 0,
            tierHeight: tierBox ? Math.round(tierBox.height * 100) / 100 : 0,
          };
        });
        note(`dock ${width}px -> pane ${scene.paneWidth}px, scroller ${scene.scroller}, ${scene.cards} cards, tier notice ${scene.tierLines} lines (${scene.tierHeight}px)`);

        // SENSITIVITY CHECK: the observer must see the string when it is really there, or its zero means nothing.
        const selfTest = await page.evaluate(() => {
          const host = document.getElementById("as-initiatives");
          const plant = document.createElement("span");
          plant.className = "as-hint init-read";
          plant.id = "as-init-read-selftest";
          plant.textContent = "reading…";
          host.appendChild(plant);
          return true;
        });
        await page
          .waitForFunction(() => (window.__obsSeen || []).length > 0, { timeout: 4000 })
          .catch(() => {});
        const planted = await page.evaluate(() => {
          const seen = (window.__obsSeen || []).length;
          const plant = document.getElementById("as-init-read-selftest");
          if (plant) plant.remove();
          return seen;
        });
        ok(`[${width}px] the observer sees the string when it is planted`, planted > 0 && selfTest, `${planted} callback(s) recorded it`);

        const measure = () =>
          page.evaluate(() => {
            const host = document.getElementById("as-initiatives");
            const body = host.closest(".as-body");
            const scroller = host.scrollHeight > host.clientHeight + 1 ? host : body && body.scrollHeight > body.clientHeight + 1 ? body : host;
            const box = scroller.getBoundingClientRect();
            const meta = host.querySelector(".init-meta");
            const card = host.querySelector(".init-card");
            const cardBox = card ? card.getBoundingClientRect() : null;
            const metaBox = meta ? meta.getBoundingClientRect() : null;
            const btn = host.querySelector("[data-init-refresh]");
            const btnBox = btn ? btn.getBoundingClientRect() : null;
            const span = host.querySelector(".init-read");
            const r2 = (n) => Math.round(Number(n) * 100) / 100;
            return {
              scrollTop: r2(scroller.scrollTop),
              scrollHeight: scroller.scrollHeight,
              clientHeight: scroller.clientHeight,
              cardTop: cardBox ? r2(cardBox.top) : null,
              cardPane: cardBox ? r2(cardBox.top - box.top) : null,
              cardContent: card ? r2(card.getBoundingClientRect().top + scroller.scrollTop - box.top) : null,
              metaBottomPane: metaBox ? r2(metaBox.bottom - box.top) : null,
              metaHeight: metaBox ? r2(metaBox.height) : null,
              readSpans: host.querySelectorAll(".init-read").length,
              readText: span ? String(span.textContent || "") : "",
              readHeight: span ? r2(span.getBoundingClientRect().height) : 0,
              readLine: span ? r2(parseFloat(getComputedStyle(span).lineHeight)) : 0,
              inMeta: span ? Boolean(span.closest(".init-meta")) : false,
              hasString: (host.textContent || "").indexOf("reading…") >= 0,
              refreshTop: btnBox ? r2(btnBox.top) : null,
              refreshHeight: btnBox ? r2(btnBox.height) : null,
              refreshDisabled: btn ? btn.disabled : null,
              obsCount: window.__obsCount,
              obsSeen: (window.__obsSeen || []).length,
              writes: window.__writes || 0,
              expanded: Boolean(host.querySelector(".init-card [data-init-card-toggle][aria-expanded=\"true\"]")),
            };
          });

        // Reset the instrument after the sensitivity check: from here on, any sighting is the pane's own paint.
        await page.evaluate(() => {
          window.__obsCount = 0;
          window.__obsSeen = [];
          window.__writes = 0;
        });

        const A = await measure();
        ok(
          `[${width}px] the scene: the first card is below the meta line, inside the visible box, and the pane has scrollback`,
          A.cardPane !== null &&
            A.metaBottomPane !== null &&
            A.cardPane >= A.metaBottomPane &&
            A.cardPane >= 0 &&
            A.cardPane <= A.clientHeight &&
            A.scrollHeight > A.clientHeight + 1,
          `card top ${A.cardPane}px into a ${A.clientHeight}px box; meta ends at ${A.metaBottomPane}px; content ${A.scrollHeight}px (the box has scrollback)`,
        );

        // Start of the read: the pane's own next GET is parked by the route, so "in flight" is held still for the sample.
        requests = 0;
        heldRequests = 0;
        mode = "hold";
        const holdDeadline = Date.now() + 12_000;
        while (heldRequests === 0 && Date.now() < holdDeadline) await page.waitForTimeout(60);
        ok(`[${width}px] a read was actually in flight`, heldRequests > 0, `${heldRequests} parked request(s), ${requests} GET /api/initiatives so far`);

        // The reader's press: expanding an initiative repaints the pane, which is the render that used to draw the hint.
        const A2 = await measure();
        await page.click("#as-initiatives .init-card [data-init-card-toggle]");
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const B = await measure();
        ok(
          `[${width}px] the press repainted the pane while the read was parked`,
          B.writes > A2.writes && B.expanded && !A2.expanded && releaseFn !== null,
          `markup writes ${A2.writes} -> ${B.writes}, card expanded ${A2.expanded} -> ${B.expanded}, read parked ${releaseFn !== null}`,
        );
        note(`held sample: scrollTop ${A2.scrollTop} -> ${B.scrollTop}, card top ${A2.cardTop} -> ${B.cardTop}`);
        await sleep(Math.max(0, HOLD_MS - 300));
        const B2 = await measure(); // held a second time: the sample is not a single frame's luck

        if (releaseFn) releaseFn();
        releaseFn = null;
        mode = "pass";
        // The read lands: wait for the pane to be out of its loading state and for one more completed response.
        const settleDeadline = Date.now() + 15_000;
        while (Date.now() < settleDeadline && (heldRequests === 0 || requests <= heldRequests)) await page.waitForTimeout(60);
        await page.waitForTimeout(700);
        const C = await measure();

        for (const [label, sample] of [
          ["in flight", B],
          ["still in flight", B2],
          ["after it settles", C],
        ]) {
          ok(
            `[${width}px] ${label}: the first card's top is identical to before the read`,
            same(sample.cardTop, A.cardTop) && same(sample.cardContent, A.cardContent) && same(sample.metaHeight, A.metaHeight),
            `card top ${sample.cardTop} (before ${A.cardTop}, delta ${round(sample.cardTop - A.cardTop)}px); meta ${sample.metaHeight}px (before ${A.metaHeight}px); scrollTop ${sample.scrollTop}`,
          );
          ok(
            `[${width}px] ${label}: the refresh button's rect and disabled state are unchanged`,
            same(sample.refreshTop, A.refreshTop) && same(sample.refreshHeight, A.refreshHeight) && sample.refreshDisabled === A.refreshDisabled,
            `top ${sample.refreshTop}/${A.refreshTop}, height ${sample.refreshHeight}/${A.refreshHeight}, disabled ${sample.refreshDisabled}/${A.refreshDisabled}`,
          );
          ok(
            `[${width}px] ${label}: no read hint node and no \`reading…\` in the DOM`,
            sample.readSpans === 0 && !sample.hasString,
            `${sample.readSpans} .init-read node(s), hasString ${sample.hasString}, readText ${JSON.stringify(sample.readText)}`,
          );
        }
        ok(
          `[${width}px] the MutationObserver never saw \`reading…\` during the read`,
          C.obsSeen === 0,
          `${C.obsCount} callback(s) over the window, ${C.obsSeen} sighting(s)`,
        );

        // THE FAILURE STILL SPEAKS. A failing read must leave `read failed: …` in the meta line, one line high.
        mode = "fail";
        await page
          .waitForFunction(
            () => {
              const el = document.querySelector("#as-initiatives .init-read");
              return !!el && /^read failed: /.test(el.textContent || "");
            },
            { timeout: 15_000 },
          )
          .catch(() => {});
        const D = await measure();
        mode = "pass";
        ok(
          `[${width}px] a forced read failure still renders \`read failed:\` in the meta line`,
          /^read failed: the store could not be read/.test(D.readText),
          JSON.stringify(D.readText),
        );
        ok(
          `[${width}px] the failure line is whole line boxes tall and sits inside .init-meta`,
          D.readSpans === 1 && D.inMeta && D.readLine > 0 && D.readHeight / D.readLine >= 0.99 && Math.abs(D.readHeight / D.readLine - Math.round(D.readHeight / D.readLine)) < 0.08,
          `${D.readHeight}px at a ${D.readLine}px line height (${round(D.readHeight / D.readLine)} line(s)), in .init-meta ${D.inMeta}; meta grew ${round(D.metaHeight - A.metaHeight)}px`,
        );
        // Let the failure clear so the next width starts from a healthy pane.
        await page
          .waitForFunction(() => !document.querySelector("#as-initiatives .init-read"), { timeout: 20_000 })
          .catch(() => {});
        await page.waitForTimeout(300);

        runs.push({ width, scene, A, B, B2, C, D, planted, requests, heldRequests });
      }
      return null;
    },
    {
      headless: true,
      viewport: { width: 1600, height: 820 },
      args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
    },
  );
} finally {
  await panel.stop();
  clearTimeout(watchdog);
}

// The narrow dock is part of the condition, so the gate states that it really wrapped: a "narrow" arm whose tier
// notice stayed on one line would be a wide arm wearing a smaller number.
const narrow = runs.length ? runs[runs.length - 1] : null;
if (narrow) {
  ok(
    `[${narrow.width}px] the narrow dock really wraps the tier notice`,
    narrow.scene.tierLines >= 3,
    `${narrow.scene.tierLines} lines, ${narrow.scene.tierHeight}px, pane ${narrow.scene.paneWidth}px`,
  );
}
const widthsDiffer = runs.length > 1 ? runs[0].scene.paneWidth !== narrow.scene.paneWidth : false;
ok("the proof was taken at more than one pane width", widthsDiffer, runs.map((r) => `${r.width}px dock / ${r.scene.paneWidth}px pane`).join(", "));

if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify({ root: ROOT_OF_RUN, base, runs, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  console.log(`raw samples: ${JSON_OUT}`);
}
console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} - ${checks - failures} of ${checks} checks, ${WIDTHS.length} width(s)`);
process.exit(failures === 0 ? 0 : 1);
