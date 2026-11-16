// The worktree chart draws ONE guide line per depth, and the triangle of a parent sits ON that line: this harness
// measures the painted geometry of a three-level group and refuses a staircase.
//
//   node tools/verify-chart-guides.mjs
//   CHART_GUIDES_SHOTS=docs/assets/chart-guides node tools/verify-chart-guides.mjs
//
// WHAT THIS GUARDS. The chart hangs a tree cut from another one under it (lib/parents.js -> `.is-child` +
// `--child-depth`, public/render-projects.js). Two markers say so: a parent row's fold triangle, and the L a child
// leads with. They are the same column, and the whole tree reads as one line only while three things hold:
//
//   1. the triangle's centre is on the axis the children's L hangs on - not 9px left of it, which is what a fold laid
//      out as a flex item after the tick did;
//   2. each depth is exactly ONE 16px step from its parent's guide, so a depth-1 parent's triangle lands on the axis
//      its own children's L's hang on, and the second tier lines up under the first;
//   3. the L's vertical stroke reaches the row's edges, so the group's line continues through it and through the rows
//      BELOW a grandchild - the line breaks on exactly the deepest rows if a descendant does not carry its ancestors'
//      open lanes.
//
// A glyph cannot hold (1) or (3): a font's stroke starts inside its box and stops above its baseline, which is the
// staircase this file exists to keep out. So the L is drawn (`border-left` + a 1px corner, public/chart.css) and the
// numbers below are the only honest proof that the columns agree.
//
// The group it measures is built, not borrowed: a sandbox repo with a parent, two children cut from it, a grandchild
// cut from the first child, and one ungrouped row at depth 0 to compare the indent against. Nothing outside the
// sandbox is read or written.
//
// HARNESS: LIVE GATE. Exits 0 only when every check passes; a page error or a console error fails the run too.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser } from "./browser.mjs";
import { git, slash, startPanel, waitFor } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SHOTS = process.env.CHART_GUIDES_SHOTS || path.join(os.tmpdir(), "wag-chart-guides");
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = Number(process.env.CHART_GUIDES_SCALE || 2);

// The sheet's own numbers (public/chart.css). Kept here as the contract: the file under test must not be free to
// redefine "aligned" to whatever it happens to paint.
const STEP = 16; // one depth
const GUIDE_LINE = 17; // the row's text line, where a corner turns
const FOLD_BOX = 16;

const PROJECT = "sandbox-guides";
const PARENT = "carry-the-form-a1b2c3";
const STAGE1 = "carry-the-form-stage-1-write-the-draft-111111";
const STAGE2 = "carry-the-form-stage-2-critique-the-draft-222222";
const GRAND = "carry-the-form-stage-1-follow-up-333333";
const PLAIN = "plain-0a1b2c";

let failures = 0;
let checks = 0;
const note = (text) => console.log(`      ${text}`);
function ok(name, cond, detail = "") {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}
// Painted geometry is fractionally rounded by the browser, so "the same column" is a pixel, not an epsilon.
function near(name, got, want, tol = 1, unit = "px") {
  const good = Number.isFinite(got) && Math.abs(got - want) <= tol;
  ok(name, good, `got ${Number.isFinite(got) ? got.toFixed(2) : got}${unit}, want ${want}${unit} +/- ${tol}`);
}

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-chart-guides-"));
  const repos = path.join(dir, "repos");
  const repo = path.join(repos, PROJECT);
  const logs = path.join(dir, "logs");
  const worktrees = path.join(repo, ".worktrees");
  for (const d of [repo, worktrees, path.join(logs, "assistants", "assistant-1"), path.join(dir, "hermes"), path.join(dir, "claude")]) {
    mkdirSync(d, { recursive: true });
  }
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf8");
  writeFileSync(path.join(repo, "README.md"), `# ${PROJECT}\n`, "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed the sandbox"]);

  const treePath = (tail) => path.join(worktrees, tail);
  const cut = (tail, branch, from) => git(repo, ["worktree", "add", "-q", "-b", branch, treePath(tail), from]);
  cut(PARENT, `wtgui/${PARENT}`, "main");
  const parentSha = git(treePath(PARENT), ["rev-parse", "HEAD"]).trim();
  cut(STAGE1, `wtgui/${STAGE1}`, parentSha);
  cut(STAGE2, `wtgui/${STAGE2}`, parentSha);
  cut(GRAND, "work/follow-up", parentSha);
  cut(PLAIN, "work/plain", "main");

  const record = (tail, branch, parent) => ({
    project: PROJECT,
    branch,
    path: slash(treePath(tail)),
    parent,
    parentSha,
    parentRef: parent,
    parentSource: "cut",
    why: "",
    by: "verify-chart-guides",
    at: new Date().toISOString(),
  });
  const parentsFile = path.join(logs, "parents.json");
  writeFileSync(
    parentsFile,
    `${JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      records: [
        record(PARENT, `wtgui/${PARENT}`, "main"),
        record(STAGE1, `wtgui/${STAGE1}`, `wtgui/${PARENT}`),
        record(STAGE2, `wtgui/${STAGE2}`, `wtgui/${PARENT}`),
        record(GRAND, "work/follow-up", `wtgui/${STAGE1}`),
      ],
    })}\n`,
    "utf8",
  );
  return { dir, repos, repo, parentsFile };
}

// Everything the check reads, from the painted DOM: each row's indent, its fold box, its own L, the lanes it carries
// for its ancestors, and where its corner turned.
const READ = (project) => {
  const tbody = document.querySelector(`tbody[data-tbody="${project}"]`);
  if (!tbody) return [];
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: +r.left.toFixed(2), r: +r.right.toFixed(2), t: +r.top.toFixed(2), b: +r.bottom.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
  };
  const rows = [...tbody.children].filter((el) => el.classList.contains("row"));
  return rows.map((tr) => {
    const td = tr.querySelector("td.name");
    const tick = tr.querySelector(".child-tick");
    const fold = tr.querySelector(".btn-row-fold");
    const name = tr.querySelector(".row-name");
    const corner = tick ? getComputedStyle(tick, "::after") : null;
    const stub = td ? getComputedStyle(td, "::after") : null;
    const laneBoxes = [...tr.querySelectorAll(".child-lane")].map((el) => box(el));
    return {
      tail: String(tr.dataset.key || "").split("/").pop(),
      depth: Number(tr.dataset.depth || 0),
      classes: [...tr.classList].join(" "),
      hidden: tr.classList.contains("is-fold-hidden"),
      isChild: tr.classList.contains("is-child"),
      isParent: tr.classList.contains("is-parent"),
      last: tr.classList.contains("is-last-child"),
      folded: tr.classList.contains("is-folded"),
      row: box(td),
      name: box(name),
      fold: box(fold),
      tick: tick ? box(tick) : null,
      foldGlyph: fold ? fold.textContent : null,
      foldExpanded: fold ? fold.getAttribute("aria-expanded") : null,
      corner: corner ? corner.top : null,
      stub: stub && stub.content !== "none" ? { left: stub.left, top: stub.top } : null,
      lanes: laneBoxes.map((b) => b.l),
      laneSpans: laneBoxes.map((b) => [b.t, b.b]),
      padLeft: td ? getComputedStyle(td).paddingLeft : null,
      tickHeight: tick ? getComputedStyle(tick).height : null,
    };
  });
};

async function main() {
  const { dir, repos, repo, parentsFile } = sandbox();
  const panel = await startPanel({
    root: ROOT,
    dir,
    config: {
      scanRoots: [repos],
      scanMode: "all",
      threads: 2,
      worktreeSeconds: 3,
      midSeconds: 10,
      dormantSeconds: 20,
      slowSeconds: 30,
      refreshSeconds: 5,
      fetchSeconds: 3600,
      defaultCwd: repo,
      parentsFile,
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
  });
  const pageErrors = [];
  const consoleErrors = [];
  mkdirSync(SHOTS, { recursive: true });
  try {
    const verdict = await withBrowser(
      async ({ page }) => {
        page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
        page.on("console", (m) => {
          if (m.type() === "error") consoleErrors.push(m.text());
        });
        await page.setViewportSize(VIEWPORT);
        await page.goto(panel.base, { waitUntil: "domcontentloaded" });
        await page.waitForFunction((p) => Boolean(document.querySelector(`tbody[data-tbody="${p}"]`)), PROJECT, { timeout: 40_000 });
        const folded = await page.evaluate((p) => document.querySelector(`section.project[data-project="${p}"]`)?.classList.contains("collapsed"), PROJECT);
        if (folded) await page.click(`.project-head[data-toggle-project="${PROJECT}"]`, { force: true });

        // A scan publishes each row before it has read its git facts, and a row with no branch has no parent edge yet.
        const settled = await waitFor(
          async () => {
            const st = await (await fetch(`${panel.base}/api/state`)).json();
            const rows = (st.projects || []).find((p) => p.name === PROJECT)?.worktrees || [];
            return rows.length >= 6 && rows.every((r) => String(r.branch || "").trim()) ? rows : null;
          },
          { timeoutMs: 120_000, what: "every row of the sandbox read" },
        );
        note(`${settled.length} rows read`);

        const rows = await waitFor(
          async () => {
            const list = await page.evaluate(READ, PROJECT);
            const byTail = (t) => list.find((r) => r.tail === t);
            const want = list.length >= 6 && byTail(PARENT)?.depth === 0 && byTail(STAGE1)?.depth === 1 && byTail(STAGE2)?.depth === 1 && byTail(GRAND)?.depth === 2;
            return want ? list : null;
          },
          { timeoutMs: 90_000, what: "a parent with two child levels drawn" },
        );
        const by = (tail) => rows.find((r) => r.tail === tail);
        const parent = by(PARENT);
        const stage1 = by(STAGE1);
        const stage2 = by(STAGE2);
        const grand = by(GRAND);
        const plain = by(PLAIN);
        for (const r of rows) {
          note(`${r.tail.slice(0, 40).padEnd(41)} d=${r.depth} pad=${r.padLeft} fold=${r.fold ? `${r.fold.l}/${r.fold.w}` : "-"} lane=${r.tick ? r.tick.l : "-"} lanes=[${r.lanes.join(",")}] corner=${r.corner} ${r.classes}`);
        }

        // ---- 1. the triangle stands ON the guide, not beside it ------------------------------------------
        ok("the parent row is the tree's only depth-0 parent", Boolean(parent?.isParent) && parent.depth === 0);
        const parentCentre = parent?.fold ? +((parent.fold.l + parent.fold.r) / 2).toFixed(2) : NaN;
        near("the parent's triangle is centred on the axis its children's L hangs on", parentCentre, stage1?.tick?.l ?? NaN);
        near("and the L a child leads with is that same column", stage1?.tick?.l ?? NaN, stage2?.tick?.l ?? NaN, 0.5);

        // ---- 2. one 16px step per depth, and each parent's triangle on its own children's guide ----------
        near("a depth-1 parent's triangle lands on the depth-2 guide", stage1?.fold ? +((stage1.fold.l + stage1.fold.r) / 2).toFixed(2) : NaN, grand?.tick?.l ?? NaN);
        near("depth 2 is exactly one step past depth 1", (grand?.tick?.l ?? NaN) - (stage1?.tick?.l ?? NaN), STEP);
        near("the indent steps one step per depth", (grand?.name?.l ?? NaN) - (stage1?.name?.l ?? NaN), STEP);
        near("a group's parent row sits in the ungrouped row's column", parent?.name?.l ?? NaN, plain?.name?.l ?? NaN);

        // ---- 3. the stroke continues the line above it ---------------------------------------------------
        // The group's foot is the last child IN THE TABLE, not the last one cut: the chart re-ranks rows as they move, so
        // the gate reads the drawn order instead of assuming the fixture's order (which is otherwise the defect - the
        // corner would land on a row that has a sibling below it).
        const kids = rows.filter((r) => r.depth === 1);
        const foot = kids[kids.length - 1];
        const above = kids[0];
        ok("a grandchild hangs under the first of the group's two children", kids.length === 2 && grand?.depth === 2);
        ok(
          "the child with a sibling below spans its whole row with its L, so the line above it carries on",
          Boolean(above?.tick) && above.tick.t <= above.row.t + 1 && above.tick.b >= above.row.b - 1,
          above?.tick ? `${above.tail.slice(0, 24)} lane ${above.tick.t}-${above.tick.b} against row ${above.row.t}-${above.row.b}` : "no lane",
        );
        near("the corner turns on the row's own text line", above ? Number.parseFloat(String(above.corner)) : NaN, GUIDE_LINE, 1.5);
        ok(
          "the group's foot turns its corner and stops there",
          Boolean(foot?.last) && !above?.last && foot.tick.b <= foot.row.t + GUIDE_LINE + 1.5,
          foot?.tick ? `${foot.tail.slice(0, 24)} lane ${foot.tick.t}-${foot.tick.b}, corner at ${foot.row.t + GUIDE_LINE}` : "no lane",
        );
        ok("the corner the foot turns is a hairline, not a stroke", foot?.tickHeight === `${GUIDE_LINE + 1}px`, `height ${foot?.tickHeight}`);

        // ---- 4. the deeper level, and the lanes that must run THROUGH it ---------------------------------
        ok("the grandchild is the second level, one indent past its parent", grand?.depth === 2 && grand.isChild && !grand.isParent);
        // Whether the deepest row carries its parent's lane follows the drawn order: stage-1 keeps its lane open only
        // while it has a sibling below it. Both directions are a clean line, and the gate pins whichever one the chart
        // drew rather than silently accepting either.
        if (stage1 !== foot) {
          ok(
            "a grandchild inside an open group carries its parent's lane, so the line does not break on the deepest row",
            (grand?.lanes || []).length === 1 && Math.abs(grand.lanes[0] - (stage1?.tick?.l ?? NaN)) <= 0.5,
            `lanes at [${(grand?.lanes || []).join(",")}], the parent's guide is at ${stage1?.tick?.l}`,
          );
          ok(
            "and that lane spans the grandchild's row too",
            Boolean(grand?.laneSpans?.length) && grand.laneSpans[0][0] <= grand.row.t + 1 && grand.laneSpans[0][1] >= grand.row.b - 1,
            `lane ${JSON.stringify(grand?.laneSpans?.[0])} against row ${grand?.row?.t}-${grand?.row?.b}`,
          );
        } else {
          ok("the grandchild's parent is the group's foot, so the lane above it ended at that corner", (grand?.lanes || []).length === 0, `${(grand?.lanes || []).length} lanes`);
          ok("and the grandchild's own L hangs from that parent's triangle", Math.abs((grand?.tick?.l ?? NaN) - (stage1?.fold ? (stage1.fold.l + stage1.fold.r) / 2 : NaN)) <= 1, `lane ${grand?.tick?.l}, triangle ${stage1?.fold ? (stage1.fold.l + stage1.fold.r) / 2 : "-"}`);
        }
        ok("a first-level child carries no ancestor lane", kids.every((k) => (k.lanes || []).length === 0), `${kids.map((k) => k.lanes.length).join(",")} lanes`);

        // ---- 5. the lane out of a parent's own fold ------------------------------------------------------
        ok(
          "a parent row draws the lane its children hang on, from under its triangle",
          Boolean(parent?.stub) && Math.abs(Number.parseFloat(parent.stub.left) + parent.row.l - (parent.fold.l + parent.fold.r) / 2) <= 1,
          parent?.stub ? `stub at ${parent.stub.left} (cell) - triangle centre ${parentCentre}` : "no lane out of the fold",
        );

        // ---- 6. the fold still works, and still has a hit area -------------------------------------------
        const visible = () =>
          page.evaluate((p) => {
            const tbody = document.querySelector(`tbody[data-tbody="${p}"]`);
            return [...tbody.children].filter((el) => el.classList.contains("row") && el.classList.contains("is-child") && !el.classList.contains("is-fold-hidden")).length;
          }, PROJECT);
        const press = () =>
          page.evaluate((p) => {
            const tr = [...document.querySelectorAll(`tbody[data-tbody="${p}"] tr.row`)].find((el) => el.querySelector(".btn-row-fold"));
            tr?.querySelector(".btn-row-fold").click();
            return Boolean(tr);
          }, PROJECT);
        ok("the fold box is at least a 16px square", Boolean(parent?.fold) && parent.fold.w >= FOLD_BOX && parent.fold.h >= FOLD_BOX, parent?.fold ? `${parent.fold.w}x${parent.fold.h}` : "no fold");
        const beforeFold = await visible();
        await press();
        await page.waitForTimeout(250);
        const afterFold = await page.evaluate(READ, PROJECT);
        const hiddenAfter = afterFold.filter((r) => r.isChild && r.hidden).length;
        const parentAfter = afterFold.find((r) => r.tail === PARENT);
        await press();
        await page.waitForTimeout(250);
        const afterOpen = await visible();
        // Two children and the grandchild under the first of them: the fold takes the whole group, not one tier of it.
        ok("pressing the fold puts both child levels out of sight", beforeFold === 3 && hiddenAfter === 3, `${beforeFold} visible, then ${hiddenAfter} hidden`);
        ok("the folded parent stays on screen and says so", Boolean(parentAfter) && !parentAfter.hidden && parentAfter.folded && parentAfter.foldGlyph === "\u25b8", `glyph ${JSON.stringify(parentAfter?.foldGlyph)}`);
        ok("pressing it again brings the group back", afterOpen === 3, `${afterOpen} visible again`);

        // ---- 7. nothing else changed, and nothing was written --------------------------------------------
        ok("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
        ok("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

        // ---- 8. the proof: 1440x900, and a zoomed clip of the group --------------------------------------
        const board = path.join(SHOTS, "board-1440x900.png");
        await page.screenshot({ path: board });
        const clip = await page.evaluate((p) => {
          const rows = [...document.querySelectorAll(`tbody[data-tbody="${p}"] tr.row`)].filter((el) => el.querySelector(".btn-row-fold") || el.classList.contains("is-child"));
          const first = rows[0].getBoundingClientRect();
          const last = rows[rows.length - 1].getBoundingClientRect();
          return { x: 20, y: Math.max(0, first.top - 28), width: 520, height: Math.min(460, last.bottom - first.top + 34) };
        }, PROJECT);
        const zoom = path.join(SHOTS, "group-zoom.png");
        await page.screenshot({ path: zoom, clip });
        note(`screenshots: ${board} (1440x900) - ${zoom} (x${SCALE} clip ${JSON.stringify(clip)})`);
        return { board, zoom };
      },
      { viewport: VIEWPORT, deviceScaleFactor: SCALE },
    );

    console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks`);
    if (failures) process.exitCode = 1;
    note(`proof: ${verdict.zoom}`);
  } finally {
    await panel.stop();
  }
}

main().catch((e) => {
  console.error(`HARNESS-ERROR ${(e && e.stack) || e}`);
  process.exit(1);
});
