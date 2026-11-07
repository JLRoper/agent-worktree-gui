// The pager's collapse gesture, driven in a real browser: going up and back down folds the turns you read.
// HARNESS: LIVE GATE — it tracks main, and `npm run verify:turn-fold` is how the repo runs it by name.
//
//   node tools/verify-turn-fold.mjs                       # this checkout
//   node tools/verify-turn-fold.mjs --root <export dir>    # serve a `git archive` of another build
//   node tools/verify-turn-fold.mjs --shots <dir>          # where the screenshots go (default: a temp dir)
//   node tools/verify-turn-fold.mjs --json <file>          # keep the raw ledger
//
// THE CHANGE. Paging moved the window and nothing else: a turn the reader had walked past kept whatever fold it had,
// so going up and back down a seven-turn thread left the newest page exactly as it was — the reader's own reading
// still open. The arrows are now the collapse gesture: every turn on the page just left folds, and the one exception
// is a starred turn's PINNED copy, which sits above the page on every page, was opened by a deliberate click, and is
// closed by that click alone.
//
// WHAT IS DRIVEN (nothing synthetic reaches the page): a throwaway panel of its own (tools/panel-testkit.mjs — spare
// port, own PANEL_CONFIG / HERMES_HOME / jobs.json, API_SERVER_KEY empty), a dead apiServer and the board assistant
// OFF, so no gateway is called at all; a job store seeded with SEVEN settled turns in ONE thread — two pages of five,
// the only condition under which the pager is drawn; the rail opened the way the panel remembers it
// (`wm.assistantOpen`), which paints that thread's card into `#assistant` through `conversationHtml` — the same
// renderer the board uses, not a lookalike. Every press is a real click on the drawn arrow or turn head.
//
// WHAT IT ASSERTS, off the painted card:
//   (1) the card opens on its newest page, "3–7 / 7", with the newest turn open and the other four folded;
//   (2) the older arrow lands on "1–2 / 7" and folds every turn on the page it left (turns 3–7, the open one included);
//   (3) the newer arrow lands back on "3–7 / 7" with EVERY turn folded — up and back down is the gesture;
//   (4) starring turn 7 adds its pinned copy, folded, and opens nothing;
//   (5) a click on that pinned copy opens it, and the pager then leaves it open in both directions while folding the
//       pages it passes — and its own copy in the page stays folded;
//   (6) a second click on the pinned copy closes it, so the pin is still an accordion with the reader's handle on it;
//   (7) every arrow is disabled at its own end, and no press the browser made raised a page error.
//
// THE FAILING-FIRST PROOF is the `--root` flag, on the rule the other gates use — the same harness, the base's own
// server.js, lib/ and public/:
//   mkdir -p "$SCRATCH/main" && git archive origin/main | tar -x -C "$SCRATCH/main"
//   git -C "$SCRATCH/main" init -q -b main && git -C "$SCRATCH/main" add -A && git -C "$SCRATCH/main" commit -qm export
//   node tools/verify-turn-fold.mjs --root "$SCRATCH/main"
// main's arrows fold nothing, so (2) and (3) fail there and this checkout passes. The export needs its own
// one-commit repository because server.js reads `git rev-parse` at boot and dies on a bare export.
//
// Exit codes: 0 held; 1 a check failed; 2 the run did not measure what it claims (no Playwright, no rail, no pager).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-turn-fold-shots")));
const JSON_OUT = opt("--json");
const THREAD = "panel-assistant";
const TURNS = 7;
const CARD = `#assistant .job[data-thread="${THREAD}"]`;

let checks = 0;
let failures = 0;
const out = { tree: TREE, steps: [], notMeasured: [], errors: [] };
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);

// ---- the fixture: seven settled turns of the rail's own conversation -------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-turn-fold-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
const now = Date.now();
// The tree the fixture's card is filed under: derived from the checkout being served, never a path from the machine
// this harness was written on (tools/absolute-paths.mjs refuses one, and a fixture label is not worth an exception).
const seedPath = path.join(TREE, ".worktrees", "turn-fold-fixture-0001").replace(/\\/g, "/");
const jobs = [];
for (let i = 0; i < TURNS; i++) {
  const at = now - (TURNS - i) * 600_000;
  jobs.push({
    id: `tkfold${i + 1}`,
    thread: THREAD,
    turn: i + 1,
    prompt: `fixture turn ${i + 1}`,
    status: "done",
    exitCode: 0,
    startedAt: new Date(at).toISOString(),
    endedAt: new Date(at + 30_000).toISOString(),
    durationMs: 30_000,
    finalMessage: "done",
    cwd: seedPath,
    ownerPath: seedPath,
    worktreePath: seedPath,
    worktree: "turn-fold-fixture-0001",
    lines: [{ kind: "out", text: `turn ${i + 1} output`, lid: i + 1, at: at + 1000 }],
  });
}
writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));

// The kit beside the checkout being SERVED, not beside this file: `--root` has to boot the base's own server.js,
// lib/ and public/ or the comparison would prove nothing.
const { freePort, startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  root: TREE,
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    discoverSeconds: 3600,
    // No gateway: the URL is a dead port and the assistant's own rules are off, so nothing here can start a run.
    assistant: { enabled: false },
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
  },
});

// What the drawn card says: the pager's count and end states, the turns of the page (direct children of the body, so
// the pinned block above them is never counted twice), and the pinned copies. `open` is the absence of `.folded`.
const read = () => {
  const card = document.querySelector('#assistant .job[data-thread="panel-assistant"]');
  if (!card) return null;
  const turnsOf = (root) =>
    [...root.querySelectorAll(":scope > .turn")].map((el) => ({
      id: el.dataset.turn,
      open: !el.classList.contains("folded"),
      compact: el.classList.contains("compact"),
    }));
  const body = card.querySelector(".job-body");
  const older = card.querySelector('button[data-turn-page="older"]');
  const newer = card.querySelector('button[data-turn-page="newer"]');
  return {
    count: card.querySelector(".pager-n")?.textContent?.trim() || null,
    page: body ? turnsOf(body) : [],
    pins: body ? [...body.querySelectorAll(":scope > .pinned-turns")].flatMap(turnsOf) : [],
    olderDisabled: older ? older.disabled : null,
    newerDisabled: newer ? newer.disabled : null,
  };
};

const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("the pager's fold gesture", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

const idsOf = (list) => list.map((t) => t.id).join(",");
const openIds = (list) => list.filter((t) => t.open).map((t) => t.id).join(",") || "(none)";

try {
  console.log(`turn fold gate on ${TREE}`);
  console.log(`  sandbox: ${panel.base} · ${TURNS} seeded turns in ${THREAD} · no gateway · shots ${SHOTS}`);
  mkdirSync(SHOTS, { recursive: true });
  await withBrowser(
    async ({ page, pageErrors }) => {
      const waitFor = async (predicate, arg, label) => {
        await page.waitForFunction(predicate, arg, { timeout: 20_000 }).catch(() => {});
        const state = await page.evaluate(read);
        if (!state) out.notMeasured.push(`${label}: the rail's card was not on the page`);
        return state;
      };
      const waitCount = (want, label) =>
        waitFor((w) => document.querySelector('#assistant .job[data-thread="panel-assistant"] .pager-n')?.textContent?.trim() === w, want, label);

      // The rail is the panel's remembered state, not a press: after a reload it is already open.
      await page.addInitScript(() => {
        try {
          localStorage.setItem("wm.assistantOpen", "1");
        } catch {
          /* a browser with storage off still draws the rail on its own default */
        }
      });
      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`${CARD} .turn-pager`, { timeout: 45_000 });
      await page.waitForTimeout(900);

      const railBox = await page.locator("#assistant").boundingBox().catch(() => null);
      const shot = async (name) => {
        const file = path.join(SHOTS, `${name}.png`);
        await page.screenshot(
          railBox
            ? { path: file, clip: { x: railBox.x, y: railBox.y, width: railBox.width, height: Math.min(railBox.height, 900) } }
            : { path: file },
        );
        note(`screenshot ${file}`);
      };

      // ---- (1) the card opens on its newest page, with its newest turn open -----------------------------------
      let state = await waitFor(() => true, null, "initial");
      if (!state) return;
      out.steps.push({ step: "initial", ...state });
      check(state.count === "3–7 / 7", "the card opens on the newest page of seven turns", JSON.stringify(state.count));
      check(idsOf(state.page) === "tkfold3,tkfold4,tkfold5,tkfold6,tkfold7", "the page is the newest five turns", idsOf(state.page));
      check(openIds(state.page) === "tkfold7", "and only the newest turn is open", openIds(state.page));
      check(state.olderDisabled === false && state.newerDisabled === true, "the newer arrow is disabled on the newest page", `older ${state.olderDisabled} · newer ${state.newerDisabled}`);
      await shot("01-newest-page");

      // ---- (2) up: the page just left folds ------------------------------------------------------------------
      await page.locator(`${CARD} button[data-turn-page="older"]`).click();
      state = await waitCount("1–2 / 7", "older");
      out.steps.push({ step: "older", ...state });
      check(state.count === "1–2 / 7", "the older arrow lands on the oldest page", JSON.stringify(state.count));
      check(idsOf(state.page) === "tkfold1,tkfold2", "the page is turns 1–2", idsOf(state.page));
      check(openIds(state.page) === "(none)", "neither of them is open (neither ever was)", openIds(state.page));
      check(state.olderDisabled === true && state.newerDisabled === false, "the older arrow is disabled on the oldest page", `older ${state.olderDisabled} · newer ${state.newerDisabled}`);
      await shot("02-older-page");

      // ---- (3) down: the page passed through folds, and so the thread ends closed ----------------------------
      await page.locator(`${CARD} button[data-turn-page="newer"]`).click();
      state = await waitCount("3–7 / 7", "newer");
      out.steps.push({ step: "newer", ...state });
      check(state.count === "3–7 / 7", "the newer arrow lands back on the newest page", JSON.stringify(state.count));
      check(idsOf(state.page) === "tkfold3,tkfold4,tkfold5,tkfold6,tkfold7", "showing the newest five turns again", idsOf(state.page));
      check(
        openIds(state.page) === "(none)",
        "EVERY turn is folded: up and back down is the collapse gesture",
        `open: ${openIds(state.page)}`,
      );
      await shot("03-back-down-all-folded");

      // ---- (4) starring adds a PINNED copy, folded, and opens nothing ------------------------------------------
      await page.locator(`${CARD} .job-body > .turn[data-turn="tkfold7"] button[data-star-turn="tkfold7"]`).first().click();
      state = await waitCount("3–7 / 7", "star");
      out.steps.push({ step: "starred", ...state });
      check(idsOf(state.pins) === "tkfold7", "the starred turn is pinned above the page", idsOf(state.pins));
      check(openIds(state.pins) === "(none)", "the pinned copy starts folded — a pin is a reference, not an open turn", openIds(state.pins));
      check(openIds(state.page) === "(none)", "…and starring opened nothing on the page", openIds(state.page));

      // ---- (5) the pin opens on a click, and the gesture leaves it alone --------------------------------------
      await page.locator(`${CARD} .pinned-turns [data-toggle-turn="pin:tkfold7"]`).click();
      state = await waitCount("3–7 / 7", "pin open");
      out.steps.push({ step: "pin-open", ...state });
      check(openIds(state.pins) === "tkfold7", "a click on the pinned copy opens it", openIds(state.pins));
      check(openIds(state.page) === "(none)", "the copy in the page stays folded under its open pin", openIds(state.page));
      await shot("04-pin-open");

      await page.locator(`${CARD} button[data-turn-page="older"]`).click();
      state = await waitCount("1–2 / 7", "pin open / older");
      out.steps.push({ step: "pin-open-older", ...state });
      check(openIds(state.pins) === "tkfold7", "paging up leaves the open pinned copy open", openIds(state.pins));
      check(openIds(state.page) === "(none)", "…and folds the page it left", openIds(state.page));

      await page.locator(`${CARD} button[data-turn-page="newer"]`).click();
      state = await waitCount("3–7 / 7", "pin open / newer");
      out.steps.push({ step: "pin-open-newer", ...state });
      check(openIds(state.pins) === "tkfold7", "paging back down leaves it open too — it never left the screen", openIds(state.pins));
      check(
        openIds(state.page) === "(none)",
        "…while every turn on both pages is folded",
        `open: ${openIds(state.page)}`,
      );
      check(openIds(state.pins) === "tkfold7", "the one body open on the card is the pinned copy the reader opened", openIds(state.pins));
      await shot("05-pin-open-after-both-pages");

      // ---- (6) the reader's click still closes it ------------------------------------------------------------
      await page.locator(`${CARD} .pinned-turns [data-toggle-turn="pin:tkfold7"]`).click();
      state = await waitCount("3–7 / 7", "pin closed");
      out.steps.push({ step: "pin-closed", ...state });
      check(openIds(state.pins) === "(none)", "a second click closes the pinned copy", openIds(state.pins));

      // ---- (7) no arrow press raised a page error ------------------------------------------------------------
      out.errors = (pageErrors || []).slice(0, 3);
      check(out.errors.length === 0, "no page error along the way", out.errors[0] || "clean");
    },
    { viewport: { width: 1600, height: 1000 } },
  );
} finally {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1), "utf8");
for (const f of out.notMeasured) console.log(`  ? ${f}`);
if (out.notMeasured.length) {
  console.log(`RESULT: NOT MEASURED (${out.notMeasured.length} reason(s))`);
  process.exit(2);
}
console.log(failures ? `RESULT: ${failures}/${checks} FAILED` : `RESULT: ALL PASS (${checks} checks)`);
process.exit(failures ? 1 : 0);
