#!/usr/bin/env node
// THE INITIATIVES PANE BACKS OFF WHEN ITS READ KEEPS FAILING.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-initiatives-read-backoff.mjs
//   node tools/verify-initiatives-read-backoff.mjs --json <file>
//   node tools/verify-initiatives-read-backoff.mjs --root <export of the base>   # the before arm
//
// THE DEFECT THIS PINS (queue row 279). The pane's stale read is re-armed from its own render
// (`public/assistant.js`, renderAssistantInitiatives) and from a four-second timer, and neither looked at whether the
// last read FAILED: `initReadAt` never moves on a failure, so every render found the document older than the gap and
// started another read, and that read's own `.finally()` repaint started the next one. Row 275's worker counted 114
// GET /api/initiatives inside one sample window with the read forced to fail. The fix gives the failing path an
// exponential wait (8 s, 16 s, 32 s, 60 s ceiling), a visible reason after the first failure, a Refresh that never
// waits, and a successful read that clears the wait.
//
// WHAT THIS GATE MEASURES, on the real route, with the pane the reader opens:
//
//   1. THE SAME INSTRUMENT AS THE FINDING. The pane's own GET /api/initiatives is counted IN THE PAGE'S ROUTE HANDLER,
//      which is how row 275 counted 114. Two arms, one instrument: this tree, and an export of origin/main named with
//      --root (the same `git archive` arm the other initiatives gates use).
//   2. THE FAILURE IS ONE REQUEST A MINUTE, NOT A HUNDRED A WINDOW. The route answers 500 for a fixed window (62 s)
//      and the GETs inside it are counted. The base arm must show the defect (a large count, hundreds over a minute
//      at a 400 ms failure); the fix arm must show the backoff (a handful).
//   3. THE FIRST FAILURE STILL SPEAKS. `read failed: <reason>` is drawn in the meta line, and on the fix arm the same
//      line says why the pane is waiting and names Refresh as the control that does not.
//   4. REFRESH NEVER WAITS. With the pane provably held (the reason line names a wait of 20 s or more, and no GET
//      arrives for 2 s), a press must produce a GET within 2.5 s.
//   5. A RECOVERED READ RESUMES THE NORMAL GAP. The route starts answering again, the pane is read to a healthy
//      state, and a 16 s window must then hold the ordinary four-second cadence - 3 to 6 GETs, none closer than 2 s
//      and none further apart than 6 s - so the backoff was cleared rather than kept for the session. The SAME window
//      is measured BEFORE the failure on both arms, so "the healthy gap is unchanged" is a number, not a promise.
//
// A FAILING READ IS SLOW, NOT INSTANT: the route holds its 500 for 400 ms, the same delay the zero-shift gate uses, so
// the base arm is the retry loop and not a browser spinning as fast as it can. The delay is identical in both arms.
//
// Sandbox only: the fixture's own WAG_HOME under scratch, its own port and its own throwaway repositories (see
// tools/initiatives-fixture.mjs). The reader's live board on 7331 is never touched. Without Playwright the script says
// BROWSER-HALF-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT } from "./panel-testkit.mjs";
import { buildFixture, defaultHome, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "./initiatives-fixture.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ROOT_OF_RUN = path.resolve(arg("--root", ROOT));
const BASE_ARM = ROOT_OF_RUN !== path.resolve(ROOT);
const JSON_OUT = arg("--json", "");
const HOME = path.resolve(arg("--home", defaultHome()));
// The windows. The healthy one is four gaps long; the failing one is longer than the ceiling plus the third backoff,
// so a pane that caps at a minute has to have capped inside it.
const HEALTHY_MS = Number(arg("--healthy-ms", "16000"));
const FAIL_MS = Number(arg("--fail-ms", "62000"));
const QUIET_MS = 2000; // the pane is proved silent for this long before Refresh is pressed
const FAIL_DELAY_MS = 400; // a failing read is slow, not instant - the zero-shift gate's own number
const REFRESH_WAIT_MS = 2500; // a press that does not ask within this is a press that waited
const SETTLE = 1200; // after a press, before the samples settle

// A hang here would otherwise be silent (a browser left open keeps node's loop alive and the log never lands).
const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 420_000);
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
const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);

console.log(`root under test: ${ROOT_OF_RUN}${BASE_ARM ? "  (the BASE arm: no backoff expected)" : "  (the fix arm)"}`);
const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the initiatives read's backoff", "playwright is not installed for this node (see tools/browser.mjs)"));
  process.exit(2);
}

// The fixture: real repositories and worktrees, four initiatives, assistants and queue rows. The pane is measured over
// the REAL route, so the read the gate fails is the one the reader's pane issues.
const fixture = await buildFixture({ home: HOME });
console.log(`fixture home: ${fixture.home}`);
const panel = await startFixturePanel({ home: fixture.home, root: ROOT_OF_RUN });
const base = panel.base;
console.log(`sandbox: ${base}  panel pid: ${panel.pid}`);

const run = {};
try {
  await waitForFixtureRows(base, { timeout: 90_000 });
  await waitForInitiativesView(base, { timeout: 60_000 });

  await withBrowser(
    async ({ page }) => {
      // THE INSTRUMENT, AND IT IS THE FINDING'S. Every GET the page makes to /api/initiatives is counted here, in the
      // route handler, exactly as row 275's worker counted the 114. A press of Refresh, the pane's timer and the
      // render's stale read all arrive through this one handler, so no reader-side path can hide from the count.
      let mode = "pass"; // pass | fail
      let requests = 0;
      let times = [];
      await page.route("**/api/initiatives**", async (route) => {
        const req = route.request();
        if (req.method() !== "GET") return route.continue().catch(() => {});
        requests += 1;
        times.push(Date.now());
        if (mode === "fail") {
          await sleep(FAIL_DELAY_MS);
          return route
            .fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "the store could not be read (forced by tools/verify-initiatives-read-backoff.mjs)" }),
            })
            .catch(() => {});
        }
        return route.continue().catch(() => {});
      });

      const reset = () => {
        requests = 0;
        times = [];
      };
      const readSpan = () =>
        page.evaluate(() => {
          const el = document.querySelector("#as-initiatives .init-read");
          return {
            present: Boolean(el),
            text: el ? String(el.textContent || "") : "",
            inMeta: el ? Boolean(el.closest(".init-meta")) : false,
            cards: document.querySelectorAll("#as-initiatives .init-card").length,
            refresh: Boolean(document.querySelector("#as-initiatives [data-init-refresh]")),
          };
        });

      await page.setViewportSize({ width: 1600, height: 900 });
      await page.addInitScript(() => {
        localStorage.setItem("wm.assistantWidth", "660");
        localStorage.setItem("wm.assistantOpen", "1");
      });
      await openPage(page, base, { selector: "#projects" });
      await page.waitForSelector('#as-tabs [data-as-tab="initiatives"]', { timeout: 30_000 });
      await page.click('#as-tabs [data-as-tab="initiatives"]');
      await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
      await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });
      await page.waitForTimeout(700);

      // ---- 1. the healthy cadence, BEFORE anything fails ------------------------------------------------------------
      reset();
      await sleep(HEALTHY_MS);
      const healthyBefore = { ms: HEALTHY_MS, count: requests, times: times.slice(), gaps: gaps(times) };
      ok(
        "a healthy pane reads at the normal gap before the failure (the path this row must not touch)",
        healthyBefore.count >= 3 && healthyBefore.count <= 6,
        `${healthyBefore.count} GETs in ${HEALTHY_MS}ms, gaps ${healthyBefore.gaps.map((g) => `${round(g / 1000)}s`).join(", ") || "none"}`,
      );

      // ---- 2. the read is forced to fail, and the first failure speaks -----------------------------------------------
      // The counter starts at the moment the failure starts, so the window is the same window in both arms and the
      // first failure is INSIDE it.
      reset();
      const failStart = Date.now();
      mode = "fail";
      await page
        .waitForFunction(
          () => {
            const el = document.querySelector("#as-initiatives .init-read");
            return !!el && /^read failed: /.test(el.textContent || "");
          },
          { timeout: 20_000 },
        )
        .catch(() => {});
      const firstFailure = await readSpan();
      const firstFailureAtMs = Date.now() - failStart;
      ok(
        "the first forced failure still draws `read failed:` in the meta line",
        /^read failed: the store could not be read/.test(firstFailure.text) && firstFailure.inMeta,
        `${JSON.stringify(firstFailure.text).slice(0, 220)} (${firstFailureAtMs}ms into the failing window)`,
      );
      const reason = { text: firstFailure.text, namesWait: /retrying in \d+s/.test(firstFailure.text), namesRefresh: /Refresh reads now/.test(firstFailure.text) };
      if (BASE_ARM) {
        note(`base arm reason line: ${JSON.stringify(reason.text).slice(0, 220)}`);
        ok(
          "the base has no reason line and no wait (the counter-example the fix is measured against)",
          !reason.namesWait && !reason.namesRefresh,
          `namesWait ${reason.namesWait}, namesRefresh ${reason.namesRefresh}`,
        );
      } else {
        ok(
          "after the first failure the same line says WHY the pane is waiting and that Refresh does not wait",
          reason.namesWait && reason.namesRefresh,
          JSON.stringify(reason.text).slice(0, 240),
        );
      }

      // ---- 3. the fixed failing window ------------------------------------------------------------------------------
      // The window is the arm's own FAIL_MS from `failStart`; the count below is GETs against a store that never answers.
      await sleep(Math.max(0, FAIL_MS - (Date.now() - failStart)));
      const failWindow = {
        ms: FAIL_MS,
        count: requests,
        times: times.slice(),
        gaps: gaps(times),
        firstFailureAtMs,
      };
      note(`failing window: ${failWindow.count} GET /api/initiatives in ${FAIL_MS}ms; gaps ${failWindow.gaps.map((g) => `${round(g / 1000)}s`).join(", ") || "none"}`);
      if (BASE_ARM) {
        ok(
          "the base retries with no backoff (a hundred in a window)",
          failWindow.count >= 30,
          `${failWindow.count} GETs in ${FAIL_MS}ms`,
        );
      } else {
        ok(
          "the fix asks a failing store a handful of times, not a hundred in a window",
          failWindow.count >= 3 && failWindow.count <= 5,
          `${failWindow.count} GETs in ${FAIL_MS}ms`,
        );
        const doubled = failWindow.gaps.length >= 2 && failWindow.gaps.every((g, i) => g >= 7000 && (i === 0 || g >= failWindow.gaps[i - 1] * 1.5));
        ok(
          "each retry waits longer than the one before it, and the wait is well above the healthy gap",
          doubled,
          `gaps ${failWindow.gaps.map((g) => `${round(g / 1000)}s`).join(", ")} (healthy gap ${4}s)`,
        );
      }

      // ---- 4. the pane is held, and a press does not wait ------------------------------------------------------------
      const heldNow = await readSpan();
      const waitNamed = Number((/retrying in (\d+)s/.exec(heldNow.text) || [])[1] || 0);
      reset();
      await sleep(QUIET_MS);
      const quiet = { ms: QUIET_MS, count: requests, text: heldNow.text, waitNamed };
      if (BASE_ARM) {
        ok(
          "the base is never quiet: it keeps asking while it waits for an answer (the counter-example)",
          quiet.count > 0,
          `${quiet.count} GETs in ${QUIET_MS}ms with nothing answered`,
        );
      } else {
        ok(
          "the pane is really holding when the press is made (no GET arrives while it waits, and the line names the ceiling)",
          quiet.count === 0 && waitNamed >= 55,
          `${quiet.count} GETs in ${QUIET_MS}ms of waiting; the line names ${waitNamed}s (the 60 s ceiling)`,
        );
      }
      // The press. It is the reader's own control, and on the fix arm it must ask at once whatever the backoff says.
      // The base arm is not judged on this: its press clears the document, and a base pane with no document and an
      // error deliberately stops retrying, so its own behaviour here is the manual "Try again" state, not a cadence.
      reset();
      const pressedAt = Date.now();
      await page.click('#as-initiatives [data-init-refresh]').catch(() => {});
      let refreshAt = 0;
      while (!requests && Date.now() - pressedAt < REFRESH_WAIT_MS) await page.waitForTimeout(40);
      refreshAt = requests ? times[0] - pressedAt : 0;
      await page.waitForTimeout(SETTLE);
      const refresh = { got: requests > 0, latencyMs: refreshAt, count: requests };
      if (BASE_ARM) {
        note(`base arm press: ${refresh.count} GET(s) ${refresh.latencyMs}ms after it (the press is not judged here)`);
      } else {
        ok(
          "Refresh retries at once regardless of the backoff",
          refresh.got && refresh.latencyMs <= REFRESH_WAIT_MS,
          `${refresh.count} GET(s) ${refresh.latencyMs}ms after the press, with the pane naming a ${waitNamed}s wait`,
        );
      }

      // ---- 5. a recovered read resumes the normal gap ---------------------------------------------------------------
      // The store answers again. The press is the reader's own retry; the count after it is the pane's own cadence.
      mode = "pass";
      reset();
      await page.click('#as-initiatives [data-init-refresh]').catch(() => {});
      await page
        .waitForFunction(() => !document.querySelector("#as-initiatives .init-read") && document.querySelectorAll("#as-initiatives .init-card").length > 0, { timeout: 20_000 })
        .catch(() => {});
      await page.waitForTimeout(800);
      const recovered = await readSpan();
      ok(
        "the failure line is gone and the map is back once a read answers",
        !recovered.present && recovered.cards > 0,
        `${recovered.cards} card(s), .init-read present ${recovered.present}`,
      );
      reset();
      await sleep(HEALTHY_MS);
      const healthyAfter = { ms: HEALTHY_MS, count: requests, times: times.slice(), gaps: gaps(times) };
      const maxGap = healthyAfter.gaps.length ? Math.max(...healthyAfter.gaps) : 0;
      const minGap = healthyAfter.gaps.length ? Math.min(...healthyAfter.gaps) : 0;
      ok(
        "a recovered read resumes the normal gap (the backoff is cleared, not kept for the session)",
        healthyAfter.count >= 3 && healthyAfter.count <= 6 && minGap >= 2000 && maxGap <= 6000,
        `${healthyAfter.count} GETs in ${HEALTHY_MS}ms, gaps ${healthyAfter.gaps.map((g) => `${round(g / 1000)}s`).join(", ") || "none"}`,
      );

      Object.assign(run, { healthyBefore, firstFailure, reason, failWindow, quiet, refresh, recovered, healthyAfter });
      return null;
    },
    {
      headless: true,
      viewport: { width: 1600, height: 900 },
      args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
    },
  );
} finally {
  await panel.stop();
  clearTimeout(watchdog);
}

// The report's one-line comparison: both numbers in the same window, from the same instrument. The base arm's window is
// the arm's own run, so it is printed rather than guessed.
console.log(`\nwindow ${FAIL_MS}ms | ${BASE_ARM ? "base" : "fix"}: ${run.failWindow?.count ?? "-"} GET /api/initiatives`);
if (JSON_OUT) {
  mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
  writeFileSync(
    JSON_OUT,
    `${JSON.stringify({ root: ROOT_OF_RUN, baseArm: BASE_ARM, base, failDelayMs: FAIL_DELAY_MS, windowMs: FAIL_MS, ...run, at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  console.log(`raw samples: ${JSON_OUT}`);
}
console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} - ${checks - failures} of ${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
