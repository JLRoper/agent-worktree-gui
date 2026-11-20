// tools/verify-collision-card-fixes.mjs - the collision card's two fixes, driven in a real browser against a real
// panel, on a fixture that is REAL git. HARNESS: LIVE GATE.
//
//   node tools/verify-collision-card-fixes.mjs --root <tree> --label before --expect broken
//   node tools/verify-collision-card-fixes.mjs --root <tree> --label after  --expect fixed
//
// WHAT IT PROVES, at 1440x900, with a SECOND panel on a free port (the one on 7331 is never touched):
//
//   FIX ONE, the counterpart is resolved, not printed:
//     * a note naming its OWN tree draws "same tree, not a collision", one side, and NO ruling press;
//     * a note naming a queue row (#12) resolves to that row's worktree, and the card prints the MEASURED paths both
//       branches changed against their merge base (lib/collision-merge.js probeSharedFiles), with the two presses;
//     * a note against a tree that shares no changed path draws "no shared file" and NO press, even though git
//       answered (an empty set is evidence, not a failure).
//
//   FIX TWO, the report is stamped and compared with the landing:
//     * the branch a report named has landed in main in a commit dated AFTER the report, so the pair is dropped from
//       the LIVE lane, kept in HISTORY, and the card names the superseding commit; it offers no press.
//
// `--expect broken` asserts the OLD behaviour instead (presses on a same-tree card, a landed pair still live), which is
// how the before-shot is a red proof rather than a screenshot somebody asked us to trust.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, openPage, withBrowser } from "./browser.mjs";
import { configureRepo, git, startPanel, waitFor } from "./panel-testkit.mjs";
import { Jobs } from "../lib/jobs.js";
import { CollisionBook } from "../lib/collisions.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const LABEL = opt("--label", "after");
const EXPECT = opt("--expect", "fixed");
const ROOT = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(HERE, "..", "docs", "reports", "collision-card-fixes")));

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (name) => console.log(`\n-- ${name}`);

const playwright = loadPlaywright({ root: ROOT });
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN  no Playwright install found - set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
  process.exit(2);
}

// ---- the fixture: one project, four worktrees, real commits on real branches ---------------------------------------
const DIR = mkdtempSync(path.join(os.tmpdir(), "wtgui-collision-card-"));
const REPOS = path.join(DIR, "repos");
const REPO = path.join(REPOS, "card-proj");
const tree = (name) => path.join(REPO, ".worktrees", name).replace(/\\/g, "/");
const SELF = tree("card-self");
const MATE = tree("card-mate");
const LANDED = tree("card-landed");
const SOLO = tree("card-solo");
// The report the sweep compares against, and the landing that came after it. Both are fixture data: the landing's
// commit is dated LATER than the report so the comparison is decided by the stamps, not by the clock on this machine.
const REPORT_AT = "2026-03-03T09:00:00.000Z";
const LANDED_AT = "2026-03-03T09:10:00.000Z";

mkdirSync(REPO, { recursive: true });
git(REPO, ["init", "-b", "main"]);
configureRepo(REPO);
mkdirSync(path.join(REPO, "lib"), { recursive: true });
writeFileSync(path.join(REPO, "README.md"), "# collision card fixture\n");
writeFileSync(path.join(REPO, "lib", "shared.js"), "export const shared = 0;\n");
git(REPO, ["add", "-A"]);
git(REPO, ["commit", "-m", "fixture"]);

for (const [name, branch] of [
  ["card-self", "wtgui/card-self"],
  ["card-mate", "wtgui/card-mate"],
  ["card-landed", "wtgui/card-landed"],
  ["card-solo", "wtgui/card-solo"],
]) {
  git(REPO, ["worktree", "add", "-b", branch, tree(name)]);
}
// SELF and MATE both change lib/shared.js against the merge base; SELF also touches a file of its own.
writeFileSync(path.join(SELF, "lib", "shared.js"), "export const shared = 'self';\n");
writeFileSync(path.join(SELF, "lib", "only-self.js"), "export const mine = true;\n");
git(SELF, ["add", "-A"]);
git(SELF, ["commit", "-m", "self changes shared"]);
writeFileSync(path.join(MATE, "lib", "shared.js"), "export const shared = 'mate';\n");
git(MATE, ["add", "-A"]);
git(MATE, ["commit", "-m", "mate changes shared"]);
writeFileSync(path.join(LANDED, "lib", "landed.js"), "export const landed = true;\n");
git(LANDED, ["add", "-A"]);
git(LANDED, ["commit", "-m", "work that lands"]);
// SOLO shares nothing with SELF: its only changed path is its own.
writeFileSync(path.join(SOLO, "lib", "solo.js"), "export const solo = true;\n");
git(SOLO, ["add", "-A"]);
git(SOLO, ["commit", "-m", "solo work"]);
// The landing: card-landed into main, with a commit dated after the report.
git(REPO, ["merge", "--no-ff", "-m", "land card-landed", "wtgui/card-landed"], {
  env: { GIT_AUTHOR_DATE: LANDED_AT, GIT_COMMITTER_DATE: LANDED_AT },
});
const LANDING_SHA = git(REPO, ["rev-parse", "HEAD"]);
const tips = Object.fromEntries(
  [["self", SELF], ["mate", MATE], ["landed", LANDED], ["solo", SOLO]].map(([name, dir]) => [name, git(dir, ["rev-parse", "HEAD"])]),
);

// ---- the records, through the real harvest seam --------------------------------------------------------------------
const ROWS = [
  { project: "card-proj", path: SELF, branch: "wtgui/card-self", name: "card-self", head: tips.self, live: true },
  { project: "card-proj", path: MATE, branch: "wtgui/card-mate", name: "card-mate", head: tips.mate, live: true },
  { project: "card-proj", path: LANDED, branch: "wtgui/card-landed", name: "card-landed", head: tips.landed, live: true },
  { project: "card-proj", path: SOLO, branch: "wtgui/card-solo", name: "card-solo", head: tips.solo, live: true },
];
const QUEUES = [
  {
    assistantId: "assistant-1",
    assistant: "One",
    tasks: [
      { id: 12, title: "the mate work", state: "running", worktree: MATE, thread: "card-mate-thread" },
      { id: 13, title: "the self work", state: "running", worktree: SELF, thread: "card-self-thread" },
      { id: 14, title: "the landed work", state: "running", worktree: LANDED, thread: "card-landed-thread" },
      { id: 15, title: "the solo work", state: "running", worktree: SOLO, thread: "card-solo-thread" },
    ],
  },
];
const BOOK_FILE = path.join(DIR, "logs", "collisions.json");
const book = new CollisionBook({ file: BOOK_FILE });
const harness = Object.create(Jobs.prototype);
harness.collisions = book;
harness.push = () => {};
harness.getRows = () => ROWS;
harness.collisionContext = () => ({ rows: ROWS, queues: QUEUES });

const harvest = (runId, finalMessage) =>
  harness.harvestCollisions(
    { id: runId, thread: `${runId}-thread`, project: "card-proj", status: "done", finalMessage },
    { path: SELF, branch: "wtgui/card-self", head: tips.self },
  );
const same = harvest("run-same", ["Done.", "", "COLLISION card-self | I may be standing in my own way"].join("\n"));
const byId = harvest("run-id", ["Done.", "", "COLLISION #12 | we are both rewriting lib/shared.js"].join("\n"));
const solo = harvest("run-solo", ["Done.", "", "COLLISION card-solo | I think this one is near my files"].join("\n"));
ok("the three notes were read and filed", [same?.noted, byId?.noted, solo?.noted].every((n) => n === 1), JSON.stringify([same, byId, solo]));
// The landed report is stamped BEFORE the landing: the sweep is what compares the two, so the report's own moment has
// to be a stated fact rather than whatever the fixture's clock said.
const landedNote = book.recordNote({
  project: "card-proj",
  treePath: SELF,
  branch: "wtgui/card-self",
  head: tips.self,
  target: "card-landed",
  text: "we both touch the landing path",
  rows: ROWS,
  queues: QUEUES,
  at: REPORT_AT,
});
eq("the landed report is a live pair before the panel boots", landedNote.record.resolve.kind, "tree");
const SAME_KEY = book.forTree(SELF).find((v) => v.resolution.kind === "same-tree").key;
const MATE_KEY = book.forTree(SELF).find((v) => v.resolution.kind === "tree" && v.other?.path === MATE).key;
const SOLO_KEY = book.forTree(SELF).find((v) => v.resolution.kind === "tree" && v.other?.path === SOLO).key;
const LANDED_KEY = landedNote.record.key;
console.log(`      fixture  ${REPO}`);
console.log(`      landing  ${LANDING_SHA.slice(0, 12)} at ${LANDED_AT} (report ${REPORT_AT})`);

const panel = await startPanel({ root: ROOT, dir: DIR, config: { collisionsFile: BOOK_FILE, assistant: { enabled: false } } });
console.log(`      panel    ${panel.base}  (second instance, throwaway dir; 7331 untouched)`);
mkdirSync(SHOTS, { recursive: true });

const verdict = await (async () => {
  try {
    return await withBrowser(
      async ({ page, pageErrors, consoleErrors }) => {
        const rowsLoaded = () =>
          page.waitForFunction(() => {
            try {
              return state.rows && state.rows.size >= 4;
            } catch {
              return false;
            }
          }, null, { timeout: 90_000 });
        const swept = () =>
          page.evaluate(async () => {
            const r = await fetch("/api/collisions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ op: "sweep" }),
            });
            return r.json();
          });
        const records = async () => {
          const r = await fetch(`${panel.base}/api/collisions`);
          return (await r.json()).records || [];
        };
        // The sweep only measures a record once, and only after the scan has written the row's tip: ask it until the
        // evidence and the supersession are actually on the record, the same way the 10s clock would.
        // The page first: the sweep is asked for in-page, and a relative fetch has no base until the panel is open.
        await openPage(page, panel.base, { selector: "header.topbar #btn-human" });
        await rowsLoaded();
        let seen = null;
        let settled = false;
        for (let i = 0; i < 100 && !settled; i += 1) {
          await swept();
          const now = await records();
          const mate = now.find((r) => r.key === MATE_KEY);
          const landed = now.find((r) => r.key === LANDED_KEY);
          const soloRec = now.find((r) => r.key === SOLO_KEY);
          const sameRec = now.find((r) => r.key === SAME_KEY);
          seen = {
            records: now.length,
            mate: mate ? [mate.state, mate.evidence?.ok, (mate.evidence?.files || []).length] : null,
            landed: landed ? [landed.state, landed.superseded?.commit?.slice(0, 12)] : null,
            solo: soloRec ? [soloRec.state, soloRec.evidence?.ok] : null,
            same: sameRec ? [sameRec.state, sameRec.resolve?.kind] : null,
          };
          settled = Boolean(mate?.evidence?.ok === true && landed?.state === "superseded" && soloRec?.evidence?.ok === true && sameRec);
          if (!settled) await new Promise((r) => setTimeout(r, 500));
        }
        ok(
          EXPECT === "fixed"
            ? "the sweep measured and superseded without a reader press"
            : "BROKEN: the old sweep neither measured nor superseded anything",
          EXPECT === "fixed" ? settled === true : settled === false,
          JSON.stringify(seen),
        );

        await page.evaluate(() => renderAll());
        await page.waitForTimeout(300);

        // Open the row's detail and its collision chip, then read the cards THE PAGE DREW. The open is its own step:
        // a second click on an already-expanded chip would CLOSE the card the next read wants.
        const openCard = async (treePath) => {
          const opened = await page.evaluate((p) => {
            const row = [...state.rows.values()].find((r) => r.path === p);
            if (!row) return { error: "no row" };
            hotOpenPath(row);
            const key = `${row.project}::${row.path}`;
            let chip = document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="collision"]`);
            if (!chip) {
              renderAll();
              chip = document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="collision"]`);
            }
            if (!chip) return { error: "no chip" };
            if (chip.getAttribute("aria-expanded") !== "true") chip.click();
            return { key };
          }, treePath);
          if (opened.error) return opened;
          await page.waitForSelector(".rowchip-pop .collision-block", { timeout: 15_000 }).catch(() => null);
          return opened;
        };
        const readPop = async () =>
          page.evaluate(() => {
            const pop = [...document.querySelectorAll(".rowchip-pop")].find((el) => el.dataset.rowchipPop === "collision");
            if (!pop) return { error: "no popup", blocks: [] };
            const blocks = [...pop.querySelectorAll(".collision-block")].map((el) => {
              const q = (sel) => el.querySelector(sel);
              return {
                key: el.dataset.collisionKey,
                lane: el.dataset.collisionLane,
                state: (q(".collision-state")?.textContent || "").trim(),
                sides: [...el.querySelectorAll(".collision-side")].map((s) => ({
                  role: s.dataset.collisionSide,
                  name: (s.querySelector(".collision-side-name")?.textContent || "").trim(),
                  task: (s.querySelector("[data-collision-task]")?.textContent || "").replace(/\s+/g, " ").trim(),
                })),
                chips: [...el.querySelectorAll(".collision-chip")].map((c) => c.textContent.trim()),
                none: (q(".collision-none")?.textContent || "").trim(),
                measured: (q(".collision-measured")?.textContent || "").trim(),
                peer: (q(".collision-peer")?.textContent || "").replace(/\s+/g, " ").trim(),
                superseded: el.querySelector("[data-collision-superseded]")?.getAttribute("data-collision-superseded") || null,
                supersededSay: (q(".collision-superseded")?.textContent || "").replace(/\s+/g, " ").trim(),
                picks: [...el.querySelectorAll("[data-collision-pick]")].map((b) => b.getAttribute("data-collision-pick")),
                ask: Boolean(el.querySelector("[data-collision-ask]")),
                text: (el.textContent || "").replace(/\s+/g, " ").trim(),
              };
            });
            const chip = document.querySelector("tr.row[data-key] [data-rowchip=\"collision\"][aria-expanded=\"true\"]");
            return {
              chipLabel: (chip?.querySelector(".rowchip-text")?.textContent || "").trim(),
              chipTitle: chip?.getAttribute("title") || "",
              historyHead: (pop.querySelector(".collision-history-head")?.textContent || "").trim(),
              blocks,
            };
          });
        const readCards = async (treePath) => {
          const opened = await openCard(treePath);
          if (opened.error) return { error: opened.error, blocks: [] };
          return readPop();
        };

        section(`the same-tree card (${LABEL})`);
        const sameCard = await readCards(SELF);
        const sameBlock = (sameCard.blocks || []).find((b) => b.key === SAME_KEY) || null;
        ok("the same-tree note has a card at all", Boolean(sameBlock), sameCard.error || `${sameCard.blocks?.length} block(s)`);
        if (sameBlock) {
          if (EXPECT === "fixed") {
            ok("it says the counterpart is this same tree", /same tree, not a collision/.test(sameBlock.state), sameBlock.state);
            ok("it says there is no second side", /There is no second side and nothing to order/.test(sameBlock.peer), sameBlock.peer.slice(0, 140));
            eq("it draws ONE side, the row's own", sameBlock.sides.map((s) => s.role), ["a"]);
            eq("it offers no ruling press", sameBlock.picks, []);
            eq("and no bring-it-to-me", sameBlock.ask, false);
            ok("it prints no evidence line, because there is no second branch to measure", !/no shared file/.test(sameBlock.none), sameBlock.none || "(none)");
            ok("…and no stood-down line, because there is no pair to stand down", !/stood down/.test(sameBlock.text), sameBlock.text.slice(0, 160));
          } else {
            ok("BROKEN: the board's own row was reported as no row at all", /no row on this board answers to card-self/.test(sameBlock.peer), sameBlock.peer.slice(0, 140));
            ok("BROKEN: nothing said it was the same tree", !/same tree/.test(sameBlock.state), sameBlock.state);
            eq("BROKEN: the old card offered both presses anyway", sameBlock.picks.filter((x) => x === "a" || x === "b").length, 2);
            ok("BROKEN: with no measured evidence", sameBlock.chips.length === 0, JSON.stringify(sameBlock.chips));
          }
        }
        await page.evaluate(() => {
          const pop = [...document.querySelectorAll(".rowchip-pop")].find((el) => el.dataset.rowchipPop === "collision");
          pop?.scrollIntoView?.();
        });
        await page.screenshot({ path: path.join(SHOTS, `${LABEL}-same-tree.png`) });
        console.log(`SHOT  ${path.join(SHOTS, `${LABEL}-same-tree.png`)}`);

        section(`the measured counterpart (${LABEL})`);
        const mateCard = await readCards(SELF);
        const mateBlock = (mateCard.blocks || []).find((b) => b.key === MATE_KEY) || null;
        ok("the #12 note resolved to card-mate's card", Boolean(mateBlock), mateCard.error || `${mateCard.blocks?.length} block(s)`);
        if (mateBlock) {
          if (EXPECT === "fixed") {
            eq("the paths printed are the ones BOTH branches changed", mateBlock.chips, ["lib/shared.js"]);
            ok("the card says git measured them against a merge base", /merge base [0-9a-f]{7,}/.test(mateBlock.measured), mateBlock.measured);
          } else {
            ok("BROKEN: no path was measured; the old card could not print one", !/merge base/.test(mateBlock.measured || ""), mateBlock.measured || "(none)");
            ok("BROKEN: whatever it printed came from the scan, not from a merge base", !/merge base/.test(mateBlock.text), mateBlock.text.slice(0, 120));
          }
          ok("the relation sentence counts the shared file", /both trees touch 1 shared file/.test(mateBlock.text), mateBlock.text.slice(0, 160));
          eq("the resolved side names the queue row standing in it", mateBlock.sides.map((s) => s.task).filter(Boolean).length, 2);
          eq(
            EXPECT === "fixed" ? "two presses, because there are two trees and measured paths" : "BROKEN: two presses on an unmeasured pair",
            mateBlock.picks.filter((x) => x === "a" || x === "b").length,
            2,
          );
        }
        await page.screenshot({ path: path.join(SHOTS, `${LABEL}-measured.png`) });
        console.log(`SHOT  ${path.join(SHOTS, `${LABEL}-measured.png`)}`);

        section(`the empty overlap (${LABEL})`);
        const soloCard = await readCards(SELF);
        const soloBlock = (soloCard.blocks || []).find((b) => b.key === SOLO_KEY) || null;
        ok("the solo note has a card", Boolean(soloBlock), soloCard.error || `${soloCard.blocks?.length} block(s)`);
        if (soloBlock) {
          eq("no files are printed", soloBlock.chips, []);
          if (EXPECT === "fixed") {
            ok("it says no shared file", /no shared file/.test(soloBlock.none), soloBlock.none);
            ok("…and names the measurement rather than a worker's sentence", /nothing in common against their merge base/.test(soloBlock.none), soloBlock.none);
            eq("no press is offered on an empty set", soloBlock.picks, []);
          } else {
            ok("BROKEN: the old card called the worker's sentence the evidence", /no shared file is named/.test(soloBlock.none), soloBlock.none);
            eq("BROKEN: and offered both presses on an empty set", soloBlock.picks.filter((x) => x === "a" || x === "b").length, 2);
          }
        }

        section(`the landed report (${LABEL})`);
        const landedCard = await readCards(SELF);
        // The card on main had no lane attribute at all: everything it drew was a live card, which is the defect.
        const landedLive = (landedCard.blocks || []).find((b) => b.key === LANDED_KEY && b.lane !== "history") || null;
        const landedPast = (landedCard.blocks || []).find((b) => b.key === LANDED_KEY && b.lane === "history") || null;
        if (EXPECT === "fixed") {
          eq("the landed pair is gone from the live lane", landedLive, null);
          ok("it is kept in history", Boolean(landedPast), landedCard.historyHead || "no history section");
          ok("the history heading says a landing ended it", /a landing ended this pair/.test(landedCard.historyHead || ""), landedCard.historyHead);
          if (landedPast) {
            eq("the card names the superseding commit", landedPast.superseded, LANDING_SHA);
            ok("…in the state line", new RegExp(`superseded by ${LANDING_SHA.slice(0, 12)}`).test(landedPast.state), landedPast.state);
            ok("…and says the landing came after the report", /after this report/.test(landedPast.supersededSay), landedPast.supersededSay);
            eq("history offers no press", landedPast.picks, []);
          }
          ok("the chip counts one open pair and three settled", /^1 open · 3 resolved$/.test(landedCard.chipLabel), landedCard.chipLabel);
        } else {
          ok("BROKEN: the landed pair was still in the live lane", Boolean(landedLive), landedCard.error || `${landedCard.blocks?.length} block(s)`);
          eq("BROKEN: with no history section", landedPast, null);
          ok("BROKEN: and nothing on it named a landing", !(landedCard.blocks || []).some((b) => /superseded by/.test(b.state)), (landedCard.blocks || []).map((b) => b.state).join(" | "));
          if (landedLive) eq("BROKEN: and two presses on a pair that is already in main", landedLive.picks.filter((x) => x === "a" || x === "b").length, 2);
          ok("BROKEN: every pair counts open, including the one already landed", /^4 open · 0 resolved$/.test(landedCard.chipLabel), landedCard.chipLabel);
        }
        // The landed card can sit below the popup's fold. A taller window lets the whole popup lay out without its own
        // scroll, so one PNG carries every card on this row; the frame shot then scrolls the landed block to the top.
        await page.setViewportSize({ width: 1440, height: 1500 });
        await page.waitForTimeout(300);
        await page.locator(".rowchip-pop").screenshot({ path: path.join(SHOTS, `${LABEL}-cards.png`) }).catch(() => {});
        console.log(`SHOT  ${path.join(SHOTS, `${LABEL}-cards.png`)}`);
        const landedSelector = EXPECT === "fixed" ? `[data-collision-key="${LANDED_KEY}"][data-collision-lane="history"]` : `[data-collision-key="${LANDED_KEY}"]`;
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          const pop = el?.closest(".rowchip-pop");
          if (!el || !pop) return;
          const delta = el.getBoundingClientRect().top - pop.getBoundingClientRect().top;
          pop.scrollTop = Math.max(0, pop.scrollTop + delta - 8);
        }, landedSelector);
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(SHOTS, `${LABEL}-landed.png`) });
        console.log(`SHOT  ${path.join(SHOTS, `${LABEL}-landed.png`)}`);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(200);
        await page.evaluate(() => renderAll());
        await page.screenshot({ path: path.join(SHOTS, `${LABEL}-board.png`), fullPage: true });
        console.log(`SHOT  ${path.join(SHOTS, `${LABEL}-board.png`)}`);

        ok("no page error", pageErrors.length === 0, pageErrors.join(" | "));
        ok("no console error", consoleErrors.length === 0, consoleErrors.join(" | "));
        return failures;
      },
      { viewport: { width: 1440, height: 900 } },
    );
  } catch (err) {
    console.log(`FAIL  the harness itself: ${err && err.stack ? err.stack : err}`);
    failures += 1;
    return failures;
  }
})();

await panel.stop();
console.log(`\n${verdict ? "FAILED" : "OK"}  ${checks - verdict}/${checks} checks passed  (${LABEL}, expected ${EXPECT})`);
process.exit(verdict ? 1 : 0);
