// The agent card's header reads the same folded and open: the six controls (pin, think, stream, rename, max, clear)
// fill the head's top-right corner on one line that cannot wrap, and the session's name is the cwd line's right-hand
// item, flush under them.
//
//   node tools/verify-card-header-layout.mjs [--shots <dir>]
//
// WHAT THIS GUARDS. `conversationHtml` drew `threadNameHtml` and then `cardActionsHtml` as the last two items of
// `.job-head`, and the head is `flex-wrap: wrap` — so a long session name (or a long turn title beside it) pushed the
// controls onto a second visual line, below the head and left of the card's right edge. The name also sat hard
// against the buttons with its tail cut off under them. A minimized card already drew the name on its cwd line, so the
// two states described the same card two different ways.
//
// The layout this pins, in BOTH states:
//
//   * row 1 (`.job-head`) carries the six controls as ONE `.job-actions` block, pinned to the head's right edge with
//     `margin-left: auto`, its own `flex-wrap: nowrap`, and a head that does not wrap it either;
//   * row 2 (`.job-cwd`) carries the session's name as its last item, right-justified with `margin-left: auto`, so
//     its right edge lines up under the controls' right edge;
//   * the name keeps its ellipsis and its `title`, and gives up width before the cwd path does;
//   * no control box intersects the name;
//   * a card with NO cwd line has nowhere else to put the name, so it keeps name and controls together in the head;
//   * clicking the head still folds and unfolds the card.
//
// Measured from the DOM at 1954px and at 1280px with the assistant rail open, each with a deliberately long session
// name and a long turn title — the two things that used to wrap the head. Sandbox only: its own PANEL_CONFIG, port and
// job store, a dead apiServer so nothing here can reach the live gateway, and assistant off.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT, freePort, startPanel } from "./panel-testkit.mjs";

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
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".card-header-shots");

// ---- the fixture: one card with a cwd line, one without, both with a long name ------------------------------
const NAME = "a deliberately long session name that has to right-justify on the cwd row without shoving the controls";
const WITH_CWD = "wtgui-a-deliberately-long-session-name-for-the-card-header-7c4b2e";
const NO_CWD = "wtgui-a-card-with-no-cwd-line-at-all-for-the-header-1a9d63";
const CWD = "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/rearrange-the-agent-card-a-long-worktree-name";
const TITLE = "a long turn title that competes with the controls for the first row of the card";

const dir = path.join(ROOT, ".worktrees", ".card-header-sandbox");
rmSync(dir, { recursive: true, force: true });
mkdirSync(path.join(dir, "logs"), { recursive: true });
mkdirSync(shotsDir, { recursive: true });

const now = Date.now();
const settled = (id, thread, extra) => ({
  id,
  thread,
  turn: 0,
  prompt: `fixture: ${thread}`,
  title: TITLE,
  status: "done",
  exitCode: 0,
  startedAt: new Date(now - 600_000).toISOString(),
  endedAt: new Date(now - 540_000).toISOString(),
  durationMs: 60_000,
  finalMessage: "done",
  lines: [{ kind: "out", text: "the card header is two rows, and each row has one right-hand item", lid: 1, at: now - 540_000 }],
  ...extra,
});
writeFileSync(
  path.join(dir, "logs", "jobs.json"),
  JSON.stringify(
    {
      savedAt: new Date(now).toISOString(),
      jobs: [settled("tk7101", WITH_CWD, { cwd: CWD, ownerPath: CWD, worktreePath: CWD }), settled("tk7102", NO_CWD, {})],
    },
    null,
    1,
  ),
);
// Labels live beside the store, not on the job: `rename` is the panel's own display name.
writeFileSync(path.join(dir, "logs", "labels.json"), JSON.stringify({ [WITH_CWD]: NAME, [NO_CWD]: `${NAME} (no cwd)` }));

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  keep: true,
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
    const head = j.querySelector(".job-head");
    const cwd = j.querySelector(".job-cwd");
    const name = j.querySelector(".thread-name");
    const pathEl = cwd ? cwd.querySelector(".cwd-path") : null;
    const cluster = j.querySelector(".job-actions");
    // The shipped cluster, or — on a base that has none — whatever block the controls are parented in, so a red run
    // reports real numbers instead of dying on a missing node.
    const sel = ["[data-pin-thread]", "[data-think-thread]", "[data-stream-thread]", "[data-rename-thread]", "[data-max-thread]", "[data-clear-thread]"];
    const ctl = sel.map((s) => j.querySelector(s)).filter(Boolean);
    const block = cluster || (ctl[0] ? ctl[0].parentElement : null);
    const ctlR = ctl.map(R);
    const blockR = block ? R(block) : null;
    const spread = ctlR.length >= 2 ? Math.max(...ctlR.map((r) => r.t)) - Math.min(...ctlR.map((r) => r.t)) : null;
    const nameR = name ? R(name) : null;
    const hits = (a, b) => !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
    return {
      collapsed: j.classList.contains("collapsed"),
      head: R(head),
      cwd: cwd ? R(cwd) : null,
      headWrap: getComputedStyle(head).flexWrap,
      hasCluster: Boolean(cluster),
      clusterWrap: cluster ? getComputedStyle(cluster).flexWrap : null,
      block: blockR,
      blockParent: block ? (block.classList.contains("job-actions") ? "job-actions" : `parent:${(block.className || block.tagName).split(" ")[0]}`) : null,
      blockInHead: Boolean(block && head.contains(block)),
      blockInCwd: Boolean(block && cwd && cwd.contains(block)),
      spread,
      controls: ctlR.length,
      controlsClasses: ctl.map((c) => c.className.split(" ")[0]),
      name: nameR,
      nameText: name ? name.textContent : null,
      nameTitle: name ? name.title : null,
      nameInHead: Boolean(name && head.contains(name)),
      nameInCwd: Boolean(name && cwd && cwd.contains(name)),
      nameScroll: name ? { sw: name.scrollWidth, cw: name.clientWidth } : null,
      nameEllipsized: name ? name.scrollWidth > name.clientWidth + 1 : null,
      nameOneLine: name ? name.getBoundingClientRect().height <= 20 && name.scrollHeight <= name.clientHeight + 1 : null,
      nameHitsControls: nameR ? ctlR.filter((b) => hits(nameR, b)).length : null,
      path: pathEl ? { ...R(pathEl), scrollW: pathEl.scrollWidth } : null,
    };
  }, thread);

const EPS = 2;
const inside = (inner, outer, eps = EPS) => Boolean(inner && outer) && inner.t >= outer.t - eps && inner.b <= outer.b + eps;

const stateChecks = (f, tag) => {
  if (f.error) {
    check(false, `${tag}: the card is on the page`, f.error);
    return;
  }
  const { head, cwd, name, block } = f;
  check(f.controls === 6, `${tag}: all six controls are drawn`, `${f.controls} (${f.controlsClasses.join(" ")})`);
  check(f.hasCluster, `${tag}: the controls are ONE .job-actions cluster`, f.hasCluster ? f.blockParent : "no .job-actions block");
  check(f.blockInHead && !f.blockInCwd, `${tag}: the cluster lives in the head, not on the cwd row`, `${f.blockParent} in head ${f.blockInHead}, in cwd ${f.blockInCwd}`);
  check(
    inside(block, head) && head.h <= 34,
    `${tag}: the cluster's top edge sits on the head row`,
    `head ${head.t}-${head.b} (${head.h}px tall) · cluster ${block ? `${block.t}-${block.b}` : "absent"}`,
  );
  check(
    Boolean(block) && head.r - block.r <= 4,
    `${tag}: the cluster occupies the head's top-right corner`,
    block ? `head right ${head.r} · cluster right ${block.r}` : "no cluster",
  );
  check(
    f.clusterWrap === "nowrap" && f.spread !== null && f.spread <= 1 && Boolean(block) && block.h <= 30,
    `${tag}: the cluster cannot wrap — all six controls on one line`,
    `flex-wrap ${f.clusterWrap} · tops spread ${f.spread}px · cluster ${block ? `${block.w}×${block.h}` : "?"}`,
  );
  check(f.nameInCwd && !f.nameInHead, `${tag}: the thread name is on the cwd row, not in the head`, `in cwd ${f.nameInCwd} · in head ${f.nameInHead}`);
  check(
    inside(name, cwd) && Boolean(cwd) && cwd.h <= 22,
    `${tag}: the name's left edge lands on the cwd row`,
    `cwd ${cwd ? `${cwd.t}-${cwd.b} (${cwd.h}px tall)` : "absent"} · name ${name ? `${name.l},${name.t}` : "absent"}`,
  );
  check(
    Boolean(name && cwd) && cwd.r - name.r <= 4,
    `${tag}: the name is right-justified on the cwd row`,
    name && cwd ? `cwd right ${cwd.r} · name right ${name.r}` : "no name or no cwd row",
  );
  check(
    Boolean(name && block) && Math.abs(name.r - block.r) <= 4,
    `${tag}: the name ends under the cluster — both rows share one right edge`,
    name && block ? `name right ${name.r} · cluster right ${block.r}` : "nothing to compare",
  );
  check(f.nameOneLine === true, `${tag}: the name stays one line`, name ? `${name.h}px tall` : "no name");
  check(f.nameHitsControls === 0, `${tag}: no control box intersects the name`, `${f.nameHitsControls} overlap(s)`);
  check(
    Boolean(f.path) && f.path.w >= 96,
    `${tag}: the cwd path keeps a readable share beside the name`,
    f.path ? `${f.path.w}px of ${f.path.scrollW}px` : "no path",
  );
  note(`${tag}: head flex-wrap ${f.headWrap} · cluster right ${block ? block.r : "?"} · name ${name ? `${name.w}px, right ${name.r}` : "?"}`);
};

const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("the agent card's header layout", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
  process.exit(2);
}

try {
  console.log(`sandbox: ${panel.base}`);
  let shots = 0;
  await withBrowser(
    async ({ page, pageErrors }) => {
      const shot = async (name) => {
        const card = page.locator(`.job[data-thread="${WITH_CWD}"]`);
        await card.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(150);
        const box = await card.boundingBox().catch(() => null);
        shots += 1;
        const file = path.join(shotsDir, `${String(shots).padStart(2, "0")}-${name}.png`);
        await page.screenshot(box ? { path: file, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height + 4, 240) } } : { path: file });
        note(`screenshot ${file}`);
      };
      // A known width and a known fold state, booted from scratch: the fold is localStorage, so a reload is what
      // makes each state the panel's own boot path rather than a leftover.
      const at = async (width, folded, open) => {
        await page.setViewportSize({ width, height: 1080 });
        await page.evaluate(
          ([fold, threads, o]) => {
            localStorage.setItem("wm.collapsedJobs", fold ? JSON.stringify(threads) : "[]");
            localStorage.setItem("wm.assistantOpen", o ? "1" : "0");
            localStorage.setItem("wtgui.autoCollect", "0");
          },
          [folded, [WITH_CWD, NO_CWD], open],
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector(`.job[data-thread="${WITH_CWD}"]${folded ? ".collapsed" : ":not(.collapsed)"}`, { timeout: 60000 });
        if (open) await page.waitForSelector("#assistant", { state: "visible", timeout: 30000 });
        await page.waitForTimeout(900);
        return frame(page, WITH_CWD);
      };

      await openPage(page, panel.base, { selector: `.job[data-thread="${WITH_CWD}"]` });

      // ---- expanded, at the wide width ----
      const openWide = await at(1954, false, false);
      stateChecks(openWide, "expanded 1954px");
      await shot("1954-expanded");

      // ---- expanded, at the reported narrow width, rail open ----
      const openNarrow = await at(1280, false, false);
      stateChecks(openNarrow, "expanded 1280px rail");
      check(openNarrow.nameEllipsized === true, "expanded 1280px rail: a long name truncates with an ellipsis", openNarrow.nameScroll ? `${openNarrow.nameScroll.cw}px of ${openNarrow.nameScroll.sw}px` : "no name");
      check(openNarrow.nameTitle === `${NAME} — Hermes thread ${WITH_CWD}`, "expanded 1280px rail: the tooltip still carries the whole name and the thread", String(openNarrow.nameTitle));

      // ---- minimized, same two widths ----
      const foldWide = await at(1954, true, false);
      stateChecks(foldWide, "minimized 1954px");
      check(foldWide.collapsed === true, "minimized 1954px: the card really is folded");
      await shot("1954-minimized");

      const foldNarrow = await at(1280, true, true);
      stateChecks(foldNarrow, "minimized 1280px rail");
      check(foldNarrow.collapsed === true, "minimized 1280px rail: the card really is folded");
      check(foldNarrow.nameEllipsized === true, "minimized 1280px rail: the name truncates with an ellipsis rather than being pushed right", foldNarrow.nameScroll ? `${foldNarrow.nameScroll.cw}px of ${foldNarrow.nameScroll.sw}px` : "no name");
      check(foldNarrow.nameTitle === `${NAME} — Hermes thread ${WITH_CWD}`, "minimized 1280px rail: the tooltip still carries the whole name", String(foldNarrow.nameTitle));
      await shot("1280-rail-minimized");

      // ---- the two states describe the card the same way ----
      const shape = (f) => (f.block && f.name ? `${Math.round(f.block.l)}|${Math.round(f.block.t)}|${Math.round(f.name.r)}` : "?");
      check(shape(openWide) !== "?" && shape(foldWide) !== "?", "both states draw a measurand header", `${shape(openWide)} vs ${shape(foldWide)}`);
      check(
        Boolean(openWide.block && foldWide.block && openWide.name && foldWide.name) &&
          Math.abs(openWide.block.w - foldWide.block.w) <= 1 &&
          Math.abs(openWide.name.r - foldWide.name.r) <= 2,
        "the minimized row keeps the identical arrangement",
        `cluster ${openWide.block ? openWide.block.w : "?"}px vs ${foldWide.block ? foldWide.block.w : "?"}px · name right ${openWide.name ? openWide.name.r : "?"} vs ${foldWide.name ? foldWide.name.r : "?"}`,
      );

      // ---- a card with no cwd line keeps both in the head ----
      const noCwd = await page.evaluate((t) => {
        const j = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        if (!j) return { error: "no card" };
        const head = j.querySelector(".job-head");
        const name = j.querySelector(".thread-name");
        return {
          collapsed: j.classList.contains("collapsed"),
          cwdLine: Boolean(j.querySelector(".job-cwd")),
          nameInHead: Boolean(name && head.contains(name)),
          clusterInHead: Boolean(j.querySelector(".job-actions") && head.contains(j.querySelector(".job-actions"))),
          controls: head.querySelectorAll("button[data-pin-thread], button[data-think-thread], button[data-stream-thread], button[data-rename-thread], button[data-max-thread], button[data-clear-thread]").length,
        };
      }, NO_CWD);
      check(
        noCwd.error === undefined && !noCwd.cwdLine && noCwd.nameInHead && noCwd.clusterInHead && noCwd.controls === 6,
        "a card with no cwd line keeps the name and all six controls together in the head",
        JSON.stringify(noCwd),
      );

      // ---- the head still folds and unfolds the card ----
      await at(1954, false, false);
      await page.locator(`.job[data-thread="${WITH_CWD}"] .job-head`).click();
      await page.waitForTimeout(700);
      const afterFold = await page.evaluate((t) => document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`).classList.contains("collapsed"), WITH_CWD);
      await page.locator(`.job[data-thread="${WITH_CWD}"] .job-head`).click();
      await page.waitForTimeout(700);
      const afterOpen = await page.evaluate((t) => document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`).classList.contains("collapsed"), WITH_CWD);
      check(afterFold === true && afterOpen === false, "clicking the head still folds the card and opens it again", `after click collapsed ${afterFold}, after second click collapsed ${afterOpen}`);

      for (const e of pageErrors || []) check(false, "no page error along the way", e);
    },
    {
      viewport: { width: 1954, height: 1080 },
      initScript: () => localStorage.setItem("wtgui.autoCollect", "0"),
    },
  );
} finally {
  await panel.stop();
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
console.log(failures ? "CARD-HEADER-FAILED" : "CARD-HEADER-OK");
process.exit(failures ? 1 : 0);
