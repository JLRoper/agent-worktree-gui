// tools/capture-kind-column.mjs - the before/after photograph set for the Kind column, from ONE harness.
//
//   node tools/capture-kind-column.mjs --tag after --out docs/assets/branch-kind-column
//
// WHY IT EXISTS. The regression this branch repairs was a picture: PR #821 put the kind letter ahead of the verdict
// badge and the verdict cell clipped the words (an R chip where ON MAIN and MERGED used to be). A comparison across
// two commits is only honest if the fixture, the panel config and the camera are the SAME on both sides - so this
// script takes a `--tag` and serves whatever tree it is run from. The old page comes from `git archive <base>` in a
// scratch directory with this file copied into its tools/, and the new page from this checkout; nothing else differs.
//
// WHAT IT TAKES, at 1440x900 AND at 768 wide, as an element shot of the row itself:
//   research row      R, unlifted (a real button)
//   turnover row      T, a statement
//   MERGED row        a landed tree whose badge reads MERGED, and whose record is research - the pair that clipped
//   lifted row        the research row after the reader's own Lift press, R with a tick
//
// It also PRINTS the verdict cell's text and the kind cell's HTML at both widths, so the report can cite what the
// picture shows instead of describing it. It asserts nothing: the gate is tools/verify-branch-kind.mjs.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright } from "./browser.mjs";
import { startPanel, waitFor, waitForState } from "./panel-testkit.mjs";
import { buildKindFixture } from "./kind-fixture.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const TAG = opt("--tag", process.env.PANEL_SHOT_TAG || "shot");
const OUT = path.resolve(process.cwd(), opt("--out", process.env.PANEL_SHOTS_DIR || ".shots/kind-column"));
mkdirSync(OUT, { recursive: true });

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-NOT-RUN  the Kind column was not photographed.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/capture-kind-column.mjs");
  process.exit(2);
}

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-kind-shots-"));
const fx = buildKindFixture(dir);
const panel = await startPanel({
  dir,
  config: {
    branchParentsFile: fx.bookFile,
    sameRepoScan: true,
    scanMode: "all",
    defaultCwd: fx.repo,
    worktreeSeconds: 2,
    midSeconds: 8,
    dormantSeconds: 15,
    slowSeconds: 20,
    fetchSeconds: 3600,
    threads: 1,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});
console.log(`panel on ${panel.base} (${TAG})`);

let shots = 0;
const shoot = async (page, label, suffix) => {
  const row = page.locator(`#projects tr.row[data-key*="${suffix}"]`);
  const badgeSel = `#projects tr.row[data-key*="${suffix}"] td.verdict .badge`;
  for (const [w, h] of [[1440, 900], [768, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    // The badge is re-read on the panel's own schedule, and a row can drop back to the cached "..." between polls. Ask
    // for the WORDS, then ask AGAIN half a second later: a picture is only worth taking when the same words are still
    // on screen after the panel has had a chance to repaint.
    const whole = () => page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const t = el?.textContent?.trim() || "";
      return Boolean(t) && !t.includes("…") && !el.classList.contains("stale");
    }, badgeSel);
    let badgeWhole = false;
    for (let attempt = 0; attempt < 4 && !badgeWhole; attempt += 1) {
      const seen = await waitFor(whole, { timeoutMs: 15_000, stepMs: 250, what: `the ${label} badge's words` }).catch(() => false);
      if (!seen) continue;
      await page.waitForTimeout(500);
      badgeWhole = await whole();
    }
    if (!badgeWhole) console.log(`      WARN  the ${label} badge was still the cached "..." at ${w}; the shot shows the cache`);
    await page.waitForTimeout(100);
    shots += 1;
    const file = path.join(OUT, `${TAG}-${String(shots).padStart(2, "0")}-${label}-${w}x${h}.png`);
    await row.screenshot({ path: file });
    const said = await page.evaluate((sel) => {
      const tr = document.querySelector(sel);
      if (!tr) return null;
      return {
        verdict: tr.querySelector("td.verdict")?.textContent.trim() || "",
        verdictHtml: tr.querySelector("td.verdict")?.innerHTML || "",
        verdictWidth: Math.round(tr.querySelector("td.verdict")?.getBoundingClientRect().width || 0),
        badgeWidth: Math.round(tr.querySelector("td.verdict .badge")?.getBoundingClientRect().width || 0),
        kindCell: Boolean(tr.querySelector("td.kind")),
        kind: tr.querySelector("td.kind")?.innerHTML || "",
      };
    }, `#projects tr.row[data-key*="${suffix}"]`);
    console.log(`shot ${file}`);
    console.log(`      at ${w}: verdict="${said?.verdict}" badgeWhole=${badgeWhole} verdictWidth=${said?.verdictWidth} badgeWidth=${said?.badgeWidth} kindCell=${said?.kindCell ? JSON.stringify(said.kind) : "(no td.kind on this page)"} verdictHtml=${JSON.stringify(said?.verdictHtml)}`);
    if (process.env.PANEL_SHOT_WIDTHS) {
      const cols = await page.evaluate((sel) => {
        const t = document.querySelector(sel)?.closest("table");
        if (!t) return null;
        const scroll = t.closest(".wt-scroll") || t.parentElement;
        return { card: Math.round(scroll?.clientWidth || 0), table: Math.round(t.getBoundingClientRect().width || 0), cols: [...t.tHead.rows[0].cells].map((th) => `${th.dataset.colId}=${Math.round(th.getBoundingClientRect().width)}`) };
      }, `#projects tr.row[data-key*="${suffix}"]`);
      console.log(`      widths at ${w}: ${JSON.stringify(cols)}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};

let browser = null;
try {
  const snap = await waitForState(panel.base, (s) => (s.projects || []).flatMap((p) => p.worktrees || []).length >= 5, "the five rows");
  const landed = (snap.projects || []).flatMap((p) => p.worktrees || []).find((r) => r.path.replace(/\\/g, "/").toLowerCase().endsWith(fx.suffixes.landed));
  console.log(`      the landed row's verdict on the wire: ${JSON.stringify(landed?.verdict)}`);
  browser = await pw.chromium.launch({ headless: true }).catch(async (err) => {
    if (!/Executable doesn't exist|headless[_-]shell/i.test(String((err && err.message) || err))) throw err;
    return pw.chromium.launch({ headless: true, channel: "chromium" });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await waitFor(async () => (await page.locator("section.project[data-project]").count()) > 0, { timeoutMs: 60_000, what: "the project on the board" });
  for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
    const section = head.locator("xpath=..");
    const cls = await section.getAttribute("class");
    if (cls && cls.includes("collapsed")) await head.click();
  }
  await page.waitForSelector("tr.row[data-key]", { timeout: 30_000 });
  await waitFor(async () => (await page.locator("tr.row[data-key]").count()) >= 5, { timeoutMs: 30_000, what: "five rows on the board" });
  // A row served from the cached tree list reads "..." until its own read lands. The WORDS are the subject of these
  // pictures, so wait for the BADGE (not the cell, which also carries the kind mark) before the shutter.
  const settled = await waitFor(
    async () =>
      page.evaluate(
        ([a, b]) => {
          const badge = (sel) => document.querySelector(sel)?.textContent.trim() || "";
          const whole = (t) => Boolean(t) && !t.includes("…");
          return whole(badge(a)) && whole(badge(b));
        },
        [
          `#projects tr.row[data-key*="${fx.suffixes.research}"] td.verdict .badge`,
          `#projects tr.row[data-key*="${fx.suffixes.landed}"] td.verdict .badge`,
          `#projects tr.row[data-key*="${fx.suffixes.child}"] td.verdict .badge`,
        ],
      ),
    { timeoutMs: 30_000, what: "the rows' verdicts on screen" },
  );
  console.log(`      the verdicts were read before the shutter: ${settled}`);

  await shoot(page, "research-row", fx.suffixes.research);
  await shoot(page, "turnover-row", fx.suffixes.child);
  await shoot(page, "landed-merged-row", fx.suffixes.landed);
  // The lift, through the reader's own press. The control is in whichever cell the served tree puts it in; the
  // attribute is the same on both sides of the regression, which is what lets this one script shoot both. A tree that
  // predates the control (before #821 there was no kind on the row at all) has nothing to lift, and says so rather
  // than failing the run.
  const liftable = (await page.locator(`tr.row[data-key*="${fx.suffixes.research}"] [data-kind-lift]`).count()) > 0;
  if (!liftable) {
    console.log("      no [data-kind-lift] on this tree: it predates the kind mark, so the lifted row is not shot");
  } else {
    await page.locator(`tr.row[data-key*="${fx.suffixes.research}"] [data-kind-lift]`).click();
    await page.waitForSelector("tr.row-kind-confirm");
    await page.locator("[data-kind-lift-yes]").click();
    const lifted = await waitFor(
      async () => page.evaluate((sel) => Boolean(document.querySelector(`${sel} .kind-mark.is-lifted`)), `tr.row[data-key*="${fx.suffixes.research}"]`),
      { timeoutMs: 20_000, what: "the row to draw R with a tick" },
    );
    console.log(`      the lift ${lifted ? "landed" : "did not land"} on this tree`);
    await shoot(page, "lifted-row", fx.suffixes.research);
  }
  await page.close();
} finally {
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  try {
    await panel.stop();
  } catch {
    /* already gone */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
console.log(`${shots} shots in ${OUT}`);
