// A minimized card's identity line: the cwd path (and its run/row chips) read from the left margin, and the session's
// name is the row's right-hand item, flush under the card's controls — the same arrangement the expanded card draws.
//
//   node tools/verify-collapsed-row.mjs [--shots <dir>]
//
// WHAT THIS GUARDS. The name used to be the last flex item in the head, after `<span class="spacer">`, so the spacer
// right-justified it: it sat hard against the card's own buttons, capped at a fixed 320px, and a long name was cut off
// under them. The folded card then moved the name onto its cwd line — and the buttons came with it, so the two states
// read the card differently and the name sat between the path and the cluster. Now the six controls live in the head
// as one `.job-actions` block (both states) and the name is the cwd line's right-justified last item (both states);
// this file pins the folded half: `cwd <path> [run] [row]` from the left, then the name at the right edge, with the
// name the only item that gives up width.
//
// THE PROPERTIES, measured from the DOM at 1954px and at 1280px with the assistant rail open — the width the reader
// reported it at — each with a deliberately long session name:
//
//   * the name is on the cwd line and NOT in the head, and it is that line's last child;
//   * no control is drawn on the cwd line (they are the head's, one row above);
//   * the name's right edge is the cwd line's right edge — it is right-justified, not left after the path;
//   * the name is ONE line (no wrap), no control's box intersects it, and its `title` still carries the whole name;
//   * at 1280px the long name IS ellipsized while the cwd path keeps a readable share;
//   * a card with no cwd line has nowhere to put the name, so it keeps name and all six controls in its head;
//   * expanding the card does NOT move either: the name stays on the cwd line and the controls stay in the head.
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
      controls: inHead.filter((b) => ["btn-pin", "btn-think", "btn-stream", "btn-rename", "btn-max", "btn-clear-thread"].includes(b.className.split(" ")[0])).length,
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
  if (f.cwdButtons.length) out.push(`${f.cwdButtons.length} button(s) still on the cwd line`);
  const order = f.cwdOrder;
  if (order.length && order[order.length - 1] !== "thread-name") {
    out.push(`the cwd line ends with ${order[order.length - 1]}, not the name — order ${order.join(" · ")}`);
  }
  if (!f.name || !f.cwd) out.push("no name or no cwd line to measure");
  else if (f.cwd.r - f.name.r > 4) out.push(`name ends at ${f.name.r}, the cwd line at ${f.cwd.r} — not right-justified`);
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
      check(wideBad.length === 0, "1954px: the cwd line reads left to right and the name is its right-hand item", wideBad.join(" · ") || `order ${wide.cwdOrder.join(" · ")} · name ends at ${wide.name.r}, the line at ${wide.cwd.r}`);
      check(wide.name && wide.name.w > 320, "1954px: the name uses the room it has instead of a fixed 320px cap", `${wide.name ? wide.name.w : "?"}px`);
      check(wide.name && !wide.nameEllipsized, "1954px: a name that fits is not truncated", wide.name ? `${wide.nameText}` : "");
      check(wide.path && wide.path.text && wide.path.w >= wide.path.scrollW, "1954px: the whole cwd path is drawn", wide.path ? `${wide.path.w}px of ${wide.path.scrollW}px` : "absent");
      await shot("1954-collapsed");

      // ---- 1280px with the rail open: the reported narrow width ----
      const narrow = await at(1280, true);
      const narrowBad = lineFails(narrow);
      check(narrowBad.length === 0, "1280px, rail open: the same row, still one line, the name still right-justified", narrowBad.join(" · ") || `order ${narrow.cwdOrder.join(" · ")} · name ${narrow.name.w}px ending at ${narrow.name.r} of ${narrow.cwd.r}`);
      check(narrow.nameEllipsized === true, "1280px, rail open: the long name truncates with an ellipsis rather than being pushed right", narrow.nameScroll ? `${narrow.nameScroll.cw}px of ${narrow.nameScroll.sw}px of text` : "no name");
      check(narrow.nameTitle === `${NAME} — Hermes thread ${WITH_CWD}`, "1280px, rail open: the tooltip still carries the whole name and the thread", String(narrow.nameTitle));
      check(narrow.path && narrow.path.w >= 150, "1280px, rail open: the cwd path keeps a readable share next to the long name", `path ${narrow.path ? narrow.path.w : "?"}px · name ${narrow.name ? narrow.name.w : "?"}px`);
      await shot("1280-rail-open-collapsed");

      // ---- a card with no cwd line has nowhere to put the name, so it keeps name and controls in the head ----
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
        noCwd.error === undefined && noCwd.collapsed && !noCwd.cwdLine && noCwd.nameInHead && noCwd.clusterInHead && noCwd.controls === 6,
        "a collapsed card with no cwd line keeps the name and all six controls in the head",
        JSON.stringify(noCwd),
      );

      // ---- expanding does not move either: the name stays on the cwd line, the controls stay in the head ----
      await page.locator(`.job[data-thread="${WITH_CWD}"] .job-head`).click();
      await page.waitForTimeout(700);
      const open = await frame(page, WITH_CWD);
      check(
        !open.collapsed && open.nameInCwd && !open.nameInHead && open.cwdButtons.length === 0 && open.controls === 6,
        "expanding the card keeps the name on the cwd line and the controls in the head",
        `collapsed ${open.collapsed} · name in cwd ${open.nameInCwd} · cwd buttons ${open.cwdButtons.length} · controls ${open.controls}`,
      );
      check(
        Boolean(open.name && open.cwd) && open.cwd.r - open.name.r <= 4,
        "...with the name still right-justified, so both states read the same",
        open.name && open.cwd ? `cwd right ${open.cwd.r} · name right ${open.name.r}` : "no name or no cwd line",
      );

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
