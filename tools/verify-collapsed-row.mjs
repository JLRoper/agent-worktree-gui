// A minimized card's identity line reads LEFT TO RIGHT — cwd, then the session's name, then the card's buttons — and
// the name gives up its tail instead of running under them.
//
//   node tools/verify-collapsed-row.mjs [--shots <dir>]
//
// WHAT THIS GUARDS. The name used to be the last flex item in the head, after `<span class="spacer">`, so the
// spacer right-justified it: it sat hard against the card's own buttons, capped at a fixed 320px, and a long name
// was cut off under them with no way to read the tail. The head is `flex-wrap: wrap`, so at a narrow width the
// name did not even stay on that line — it wrapped to a line of its own, left-aligned under the buttons.
//
// The fix draws the collapsed card's cwd line as the row's identity line: `cwd <path>`, then the name, then the
// buttons, all in one nowrap flex row. The name is the only item that gives up width (it ellipsizes, the path keeps
// a floor, the buttons never shrink), so the row reads in the order a person reads it and the buttons stay clickable.
//
// THE PROPERTIES, measured from the DOM at 1954px and at 1280px with the assistant rail open — the width the reader
// reported it at — each with a deliberately long session name:
//
//   * the cwd line's children are the label, the path, the name, then the card's buttons — in that order;
//   * the name's right edge is left of the first button's left edge, with a real gap;
//   * the name is ONE line (no wrap) and no button's box intersects it;
//   * the cwd path is not squeezed to nothing (a 96px floor) while the name is the one that truncates;
//   * at the narrow width the name IS ellipsized, and its `title` still carries the whole name;
//   * every button keeps a hit area: at least 15px tall and the topmost element at its centre;
//   * a card with no cwd line has nowhere to put them, so it keeps the name and the buttons in its head;
//   * expanding the card puts both back in the head and takes the buttons off the cwd line.
//
// Sandbox only: its own PANEL_CONFIG, port and job store, a dead apiServer so nothing here can reach the live
// gateway, and assistant off. The reader's panel and gateway are never touched.

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
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".collapsed-row-shots");

// ---- the fixture: two settled cards, one with a cwd line and one without -----------------------------------
const NAME = "a deliberately long thread name that has to truncate with an ellipsis in a minimized row";
const WITH_CWD = "wtgui-a-deliberately-long-session-name-for-the-collapsed-row-9f2a1c";
const NO_CWD = "wtgui-a-collapsed-card-with-no-cwd-line-at-all-3d7e41";
const CWD = "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/task-9-in-a-minimized-co-some-long-worktree-name";

const dir = path.join(ROOT, ".worktrees", ".collapsed-row-sandbox");
rmSync(dir, { recursive: true, force: true });
mkdirSync(path.join(dir, "logs"), { recursive: true });
mkdirSync(shotsDir, { recursive: true });

const now = Date.now();
const settled = (id, thread, extra) => ({
  id,
  thread,
  turn: 0,
  prompt: `fixture: ${thread}`,
  status: "done",
  exitCode: 0,
  startedAt: new Date(now - 600_000).toISOString(),
  endedAt: new Date(now - 540_000).toISOString(),
  durationMs: 60_000,
  finalMessage: "done",
  lines: [{ kind: "out", text: "the collapsed row is a handle, and its identity line has to stay readable", lid: 1, at: now - 540_000 }],
  ...extra,
});
writeFileSync(
  path.join(dir, "logs", "jobs.json"),
  JSON.stringify(
    {
      savedAt: new Date(now).toISOString(),
      jobs: [settled("tk9101", WITH_CWD, { cwd: CWD, ownerPath: CWD, worktreePath: CWD }), settled("tk9102", NO_CWD, {})],
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
    const path_ = j.querySelector(".cwd-path");
    const inCwd = [...(cwd ? cwd.querySelectorAll("button") : [])];
    const inHead = [...head.querySelectorAll("button")];
    const first = inCwd[0] || inHead[0] || null;
    const nameR = name ? R(name) : null;
    const hits = (el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { cls: el.className.split(" ")[0], w: Math.round(r.width), h: Math.round(r.height), hit: el === top || el.contains(top) };
    };
    return {
      collapsed: j.classList.contains("collapsed"),
      card: R(j),
      head: R(head),
      cwd: cwd ? R(cwd) : null,
      cwdOrder: cwd
        ? [...cwd.children].map((c) =>
            c.classList.contains("thread-name") ? "thread-name" : c.tagName === "BUTTON" ? "button" : (c.className || c.tagName).split(" ")[0],
          )
        : [],
      name: nameR,
      nameText: name ? name.textContent : null,
      nameScroll: name ? { sw: name.scrollWidth, cw: name.clientWidth } : null,
      nameTitle: name ? name.title : null,
      nameInCwd: Boolean(cwd && name && cwd.contains(name)),
      nameInHead: Boolean(name && head.contains(name)),
      nameEllipsized: name ? name.scrollWidth > name.clientWidth + 1 : null,
      nameOneLine: name ? name.getBoundingClientRect().height <= 20 && name.scrollHeight <= name.clientHeight + 1 : null,
      path: path_ ? { ...R(path_), scrollW: path_.scrollWidth, text: path_.textContent } : null,
      cwdButtons: inCwd.map(R),
      headButtons: inHead.map(R),
      firstButton: first ? R(first) : null,
      firstButtonClass: first ? first.className.split(" ")[0] : null,
      overlaps: nameR ? [...inCwd, ...inHead].map(R).filter((b) => !(nameR.r <= b.l || b.r <= nameR.l || nameR.b <= b.t || b.b <= nameR.t)).length : null,
      hits: [...inCwd, ...inHead].map(hits),
    };
  }, thread);

const lineFails = (f) => {
  const out = [];
  if (f.error) return [f.error];
  if (!f.collapsed) out.push("the card is not collapsed");
  if (!f.nameInCwd) out.push("the name is not on the cwd line");
  if (f.nameInHead) out.push("the name is still in the head");
  const order = f.cwdOrder;
  const iName = order.indexOf("thread-name");
  const iBtn = order.indexOf("button");
  if (!(order[0] === "cwd-label" && order[1] === "cwd-path" && iName === 2 && iBtn === 3)) {
    out.push(`cwd line order is ${order.join(" · ")}`);
  }
  if (!f.name || !f.firstButton) out.push("no name or no button to measure");
  else if (!(f.name.r <= f.firstButton.l - 4)) out.push(`name ends at ${f.name.r}, first button starts at ${f.firstButton.l}`);
  if (f.name && !f.nameOneLine) out.push(`the name is ${f.name.h}px tall — it wrapped`);
  if (f.overlaps) out.push(`${f.overlaps} button box(es) intersect the name`);
  if (!f.path || f.path.w < 96) out.push(`cwd path is ${f.path ? f.path.w : "absent"}px wide`);
  for (const h of f.hits) if (h.h < 15 || !h.hit) out.push(`${h.cls} hit area ${h.w}×${h.h}${h.hit ? "" : " (not the topmost element)"}`);
  return out;
};

const playwright = loadPlaywright();
if (!playwright) {
  console.log(notRun("a minimized card's identity line", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
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
        await page.screenshot(box ? { path: file, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height + 4, 200) } } : { path: file });
        note(`screenshot ${file}`);
      };
      // A known width and a known rail state, booted from scratch: the fold and the rail are localStorage, so a
      // reload is what makes each state the panel's own boot path rather than a leftover.
      const at = async (width, open) => {
        await page.setViewportSize({ width, height: 1080 });
        await page.evaluate(
          ([t, o]) => {
            localStorage.setItem("wm.collapsedJobs", JSON.stringify([t, "wtgui-a-collapsed-card-with-no-cwd-line-at-all-3d7e41"]));
            localStorage.setItem("wm.assistantOpen", o ? "1" : "0");
            localStorage.setItem("wtgui.autoCollect", "0");
          },
          [WITH_CWD, open],
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector(`.job[data-thread="${WITH_CWD}"].collapsed`, { timeout: 60000 });
        if (open) await page.waitForSelector("#assistant", { state: "visible", timeout: 30000 });
        await page.waitForTimeout(900);
        return frame(page, WITH_CWD);
      };

      await openPage(page, panel.base, { selector: `.job[data-thread="${WITH_CWD}"]` });

      // ---- 1954px, the width the reader reported it at ----
      const wide = await at(1954, false);
      const wideBad = lineFails(wide);
      check(wideBad.length === 0, "1954px: cwd, then the name, then the buttons — on one line, clear of each other", wideBad.join(" · ") || `name ${wide.name.w}px ends ${wide.firstButton.l - wide.name.r}px before ${wide.firstButtonClass}`);
      check(wide.name && wide.name.w > 320, "1954px: the name uses the room it has instead of a fixed 320px cap", `${wide.name ? wide.name.w : "?"}px`);
      check(wide.name && !wide.nameEllipsized, "1954px: a name that fits is not truncated", wide.name ? `${wide.nameText}` : "");
      check(wide.path && wide.path.text && wide.path.w >= wide.path.scrollW, "1954px: the whole cwd path is drawn", wide.path ? `${wide.path.w}px of ${wide.path.scrollW}px` : "absent");
      await shot("1954-collapsed");

      // ---- 1280px with the rail open: the reported narrow width ----
      const narrow = await at(1280, true);
      const narrowBad = lineFails(narrow);
      check(narrowBad.length === 0, "1280px, rail open: cwd, then the name, then the buttons — on one line, clear of each other", narrowBad.join(" · ") || `name ${narrow.name.w}px ends ${narrow.firstButton.l - narrow.name.r}px before ${narrow.firstButtonClass}`);
      check(narrow.nameEllipsized === true, "1280px, rail open: the long name truncates with an ellipsis rather than being pushed right", narrow.nameScroll ? `${narrow.nameScroll.cw}px of ${narrow.nameScroll.sw}px of text` : "no name");
      check(narrow.nameTitle === `${NAME} — Hermes thread ${WITH_CWD}`, "1280px, rail open: the tooltip still carries the whole name and the thread", String(narrow.nameTitle));
      check(narrow.path && narrow.path.w >= 150, "1280px, rail open: the cwd path keeps a readable share next to the long name", `path ${narrow.path ? narrow.path.w : "?"}px · name ${narrow.name ? narrow.name.w : "?"}px`);
      await shot("1280-rail-open-collapsed");

      // ---- a card with no cwd line has nowhere to put them, so it keeps them in the head ----
      const noCwd = await page.evaluate((t) => {
        const j = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        if (!j) return { error: "no card" };
        const name = j.querySelector(".thread-name");
        return {
          collapsed: j.classList.contains("collapsed"),
          cwdLine: Boolean(j.querySelector(".job-cwd")),
          nameInHead: Boolean(name && j.querySelector(".job-head").contains(name)),
          headButtons: j.querySelectorAll(".job-head > button").length,
        };
      }, NO_CWD);
      check(noCwd.error === undefined && noCwd.collapsed && !noCwd.cwdLine && noCwd.nameInHead && noCwd.headButtons >= 6, "a collapsed card with no cwd line keeps the name and its buttons in the head", JSON.stringify(noCwd));

      // ---- expanding puts the name and the buttons back in the head ----
      await page.locator(`.job[data-thread="${WITH_CWD}"] .job-head`).click();
      await page.waitForTimeout(700);
      const open = await frame(page, WITH_CWD);
      check(!open.collapsed && open.nameInHead && !open.nameInCwd && open.cwdButtons.length === 0, "expanding the card puts the name and the buttons back in the head", `collapsed ${open.collapsed} · cwd buttons ${open.cwdButtons.length}`);
      check(open.headButtons.length >= 6, "...where the card's controls are all present", `${open.headButtons.length} buttons in the head`);

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
console.log(failures ? "COLLAPSED-ROW-FAILED" : "COLLAPSED-ROW-OK");
process.exit(failures ? 1 : 0);
