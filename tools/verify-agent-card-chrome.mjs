// A card names the PROJECT its tree belongs to — not the bare word "worktree" — and the run id rides the cwd
// line beside the path instead of costing a row of its own.
//
//   node tools/verify-agent-card-chrome.mjs
//
// WHAT THIS GUARDS, both read off the painted card rather than the source:
//
//   1. the head's meta line used to read `worktree task-24-tidy-the-agent-c-0320bb`. Every card on that row is
//      a worktree, so the word spent the line on something the reader already knew and hid the one fact the row
//      does not carry: which repository the tree was cut from. It now reads `agent-worktree-gui
//      task-24-tidy-the-agent-c-0320bb`, derived from the path's repository directory — the segment above
//      `.worktrees` — and falls back to the bare word only when no project resolves from the path.
//   2. the run id (`run 993496a0`) sat at the end of that meta line. The head is `flex-wrap: wrap`, so at a
//      card's real width the id wrapped onto a line of its own: eight characters of bookkeeping costing a row
//      of chrome. It is now a `.cwd-run` on the cwd line, immediately right of `.cwd-path` — one line, beside
//      the path it belongs to — and it is gone from the head entirely.
//
// The two fixture cards are chosen to pin the fallback as well as the happy path: one tree under a project's
// `.worktrees/`, one directory cut by hand with no `.worktrees` segment anywhere in the path.
//
// Sandbox only: its own job store in a temp dir, its own port and PANEL_CONFIG, a dead apiServer so nothing
// here can reach the live gateway, and the assistant off. The reader's panel is never touched.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { freePort, startPanel } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);
const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : null;

// ---- the fixture: one card in a project's tree, one in a tree nobody's project owns ------------------------
const PROJECT = "agent-worktree-gui";
const TREE_THREAD = "wtgui-a-card-under-a-project-tree-7b3e42";
const TREE_NAME = "task-24-tidy-the-agent-c-0320bb";
const TREE_PATH = `C:/ProjectDevelopment/${PROJECT}/.worktrees/${TREE_NAME}`;
const LOOSE_THREAD = "wtgui-a-card-in-a-hand-cut-tree-2f9a1c";
const LOOSE_NAME = "hand-cut-tree-4d0b71";
const LOOSE_PATH = `C:/Scratch/${LOOSE_NAME}`;
const RUN_ID = "run_993496a0c4f1d2e8";
const RUN_SHORT = "993496a0";
const RUN2_ID = "run_1a2b3c4d5e6f7a90";
const RUN2_SHORT = "1a2b3c4d";

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-agent-card-chrome-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });

const now = Date.now();
const settled = (id, thread, extra) => ({
  id,
  thread,
  turn: 1,
  prompt: `fixture: ${thread}`,
  status: "done",
  exitCode: 0,
  startedAt: new Date(now - 900_000).toISOString(),
  endedAt: new Date(now - 840_000).toISOString(),
  durationMs: 60_000,
  finalMessage: "done",
  lines: [{ kind: "out", text: "a card's chrome names where the work happens", lid: 1, at: now - 840_000 }],
  ...extra,
});
writeFileSync(
  path.join(dir, "logs", "jobs.json"),
  JSON.stringify(
    {
      savedAt: new Date(now).toISOString(),
      jobs: [
        settled("tk9201", TREE_THREAD, {
          cwd: TREE_PATH,
          ownerPath: TREE_PATH,
          worktreePath: TREE_PATH,
          worktree: TREE_NAME,
          runId: RUN_ID,
        }),
        settled("tk9202", LOOSE_THREAD, {
          cwd: LOOSE_PATH,
          ownerPath: LOOSE_PATH,
          worktreePath: LOOSE_PATH,
          worktree: LOOSE_NAME,
          runId: RUN2_ID,
        }),
      ],
    },
    null,
    1,
  ),
);

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    discoverSeconds: 3600,
    assistant: { enabled: false },
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
  },
});

// ---- what the page actually paints -------------------------------------------------------------------------
const frame = (page, thread) =>
  page.evaluate((t) => {
    const j = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
    if (!j) return { error: "no card" };
    const R = (el) => {
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const flat = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : null);
    const head = j.querySelector(".job-head");
    const cwd = j.querySelector(".job-cwd");
    const metaEl = head.querySelector(":scope > span.mono.dim");
    const pathEl = cwd ? cwd.querySelector(".cwd-path") : null;
    const runEl = cwd ? cwd.querySelector(".cwd-run") : null;
    return {
      meta: flat(metaEl),
      headText: flat(head),
      cwdText: flat(cwd),
      cardText: flat(j),
      cwdTitle: cwd ? cwd.title : null,
      cwdOrder: cwd ? [...cwd.children].map((c) => (c.className || c.tagName).split(" ")[0]) : [],
      cwd: cwd ? R(cwd) : null,
      path: pathEl ? { ...R(pathEl), text: pathEl.textContent } : null,
      run: runEl ? { ...R(runEl), text: runEl.textContent, title: runEl.title } : null,
    };
  }, thread);

const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the agent card's project name and run id", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
  process.exit(2);
}

try {
  console.log(`sandbox: ${panel.base}`);
  await withBrowser(async ({ page, pageErrors }) => {
    await openPage(page, panel.base, { selector: `.job[data-thread="${TREE_THREAD}"]` });
    await page.waitForSelector(`.job[data-thread="${LOOSE_THREAD}"]`, { timeout: 30000 });
    await page.waitForTimeout(600);

    // ---- the derivation itself, on the path the brief names ----
    const derived = await page.evaluate(() => {
      // Guarded so a base WITHOUT the helper reports a full ledger of FAILs rather than dying on line one.
      const f = typeof projectOfTree === "function" ? projectOfTree : () => "(missing)";
      return {
        present: typeof projectOfTree === "function",
        plain: f("C:/ProjectDevelopment/agent-worktree-gui/.worktrees/foo-1234"),
        slashed: f("C:\\ProjectDevelopment\\agent-worktree-gui\\.worktrees\\foo-1234"),
        trailing: f("C:/ProjectDevelopment/agent-worktree-gui/.worktrees/foo-1234/"),
        checkout: f("C:/ProjectDevelopment/agent-worktree-gui"),
        handCut: f("C:/Scratch/hand-cut-tree-4d0b71"),
        bare: f(""),
      };
    });
    check(derived.present === true, "the page carries the project-of-a-tree derivation", derived.present ? "projectOfTree" : "projectOfTree is not defined on this build");
    check(
      derived.plain === PROJECT && derived.slashed === PROJECT && derived.trailing === PROJECT,
      "the project is the repository directory above .worktrees",
      `C:/ProjectDevelopment/agent-worktree-gui/.worktrees/foo-1234 -> ${JSON.stringify(derived.plain)} (backslashes ${JSON.stringify(derived.slashed)}, trailing slash ${JSON.stringify(derived.trailing)})`,
    );
    check(
      derived.checkout === "" && derived.handCut === "" && derived.bare === "",
      "a path with no .worktrees resolves no project",
      `checkout ${JSON.stringify(derived.checkout)} · hand-cut ${JSON.stringify(derived.handCut)} · empty ${JSON.stringify(derived.bare)}`,
    );

    // ---- 1. the card in a project's tree names the project ----
    const tree = await frame(page, TREE_THREAD);
    check(tree.error === undefined, "the tree card is on the page", tree.error || "painted");
    if (!tree.error) {
      note(`meta: ${tree.meta}`);
      check(
        Boolean(tree.meta) && tree.meta.includes(`${PROJECT} ${TREE_NAME}`),
        "the card's meta line names the PROJECT the tree was cut from",
        String(tree.meta),
      );
      check(
        Boolean(tree.meta) && !new RegExp(`(^|·\\s*)worktree\\s+${TREE_NAME}`).test(tree.meta),
        "...where the bare word 'worktree' used to stand, and the word is gone from that line",
        String(tree.meta),
      );
      check(
        tree.cwdTitle === `working directory: ${TREE_PATH}\nworktree: ${TREE_NAME}`,
        "the cwd line's tooltip still carries the full path and the tree name",
        JSON.stringify(tree.cwdTitle),
      );
    }

    // ---- 2. the run id sits on the cwd line, beside the path ----
    if (!tree.error) {
      const order = tree.cwdOrder;
      const at = order.indexOf("cwd-run");
      check(
        Boolean(tree.run) && tree.run.text === `run ${RUN_SHORT}`,
        "the run id is on the cwd line",
        tree.run ? JSON.stringify(tree.run.text) : `cwd line children: ${order.join(" · ")}`,
      );
      check(
        at === 2 && order[0] === "cwd-label" && order[1] === "cwd-path",
        "...immediately beside the path, not at the far end of the line",
        order.join(" · "),
      );
      check(
        Boolean(tree.headText) && !tree.headText.includes(RUN_SHORT),
        "...and it is gone from the head, so it no longer costs a row of its own",
        String(tree.headText),
      );
      check(
        tree.run && tree.path && tree.run.l >= tree.path.r && tree.run.t < tree.path.b && tree.run.b > tree.path.t,
        "...drawn to the right of the path and on the same line as it",
        tree.run && tree.path ? `path ends ${tree.path.r}px · run ${tree.run.l}-${tree.run.r}px, rows ${tree.path.t}-${tree.path.b} / ${tree.run.t}-${tree.run.b}` : "no path and run to measure",
      );
      check(
        tree.cwd && tree.cwd.h <= 22,
        "...without making the cwd line two rows tall",
        tree.cwd ? `${tree.cwd.h}px` : "no cwd line",
      );
      const seen = (tree.cardText || "").match(new RegExp(RUN_SHORT, "g")) || [];
      check(seen.length === 1, "the run id is drawn exactly once on the card", `${seen.length} occurrence(s)`);
      check(Boolean(tree.run && /the gateway run this card is attached to/.test(tree.run.title)), "the run chip's tooltip says what the id is", tree.run ? tree.run.title : "absent");
    }

    // ---- 3. a tree no project owns keeps the bare word ----
    const loose = await frame(page, LOOSE_THREAD);
    check(loose.error === undefined, "the hand-cut tree card is on the page", loose.error || "painted");
    if (!loose.error) {
      note(`meta: ${loose.meta}`);
      check(
        Boolean(loose.meta) && loose.meta.includes(`worktree ${LOOSE_NAME}`),
        "a tree path that resolves no project keeps the bare word",
        String(loose.meta),
      );
      check(
        Boolean(loose.meta) && !loose.meta.includes(`Scratch ${LOOSE_NAME}`),
        "...and invents no project name for it",
        String(loose.meta),
      );
      check(
        Boolean(loose.run) && loose.run.text === `run ${RUN2_SHORT}` && !loose.headText.includes(RUN2_SHORT),
        "its run id rides the cwd line too",
        loose.run ? `${JSON.stringify(loose.run.text)} · head ${JSON.stringify(loose.headText)}` : "no run chip",
      );
    }

    for (const e of pageErrors || []) check(false, "no page error along the way", e);

    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      for (const [name, thread] of [["project-tree", TREE_THREAD], ["hand-cut", LOOSE_THREAD]]) {
        const card = page.locator(`.job[data-thread="${thread}"]`);
        await card.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(120);
        const box = await card.boundingBox().catch(() => null);
        const file = path.join(shotsDir, `agent-card-${name}.png`);
        await page.screenshot(box ? { path: file, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 200) } } : { path: file });
        note(`screenshot ${file}`);
      }
    }
  });
} finally {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
console.log(failures ? "AGENT-CARD-CHROME-FAILED" : "AGENT-CARD-CHROME-OK");
process.exit(failures ? 1 : 0);
