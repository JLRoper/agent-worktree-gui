// The chart still draws a turnover container with its children under it, from any checkout.
// HARNESS: LIVE GATE
//
//   node tools/verify-chart-turnover-cut.mjs
//   node tools/verify-chart-turnover-cut.mjs --root <a git archive of an earlier commit>
//   node tools/verify-chart-turnover-cut.mjs --shots <a folder>
//
// WHY THIS EXISTS. Row 530 cut public/render-projects.js into three modules (public/board/
// project-order.js, project-row.js, row-order.js) as pure moves. The file draws the board's project
// chart, and row 406 had just changed what a container row is: every turnover branch a project names
// is a row of its own, and a child attaches under it only when the cut book records the parent. A
// pure move must not disturb that picture, so this gate renders it - a real panel, a real browser -
// and asserts the shape: the checkout, an unrecorded tree at the top level, the container row (kind T,
// is-turnover-container), and two recorded children one indent under it, each with one L marker.
//
// `--root` is the failing-first half: a `git archive` of the commit before the cut runs this same
// gate and must pass too, which is what makes the comparison a comparison rather than a snapshot.
// The fixture is the one test/turnover-container-rows.test.js builds: the container is a branch and
// nothing else (no worktree stands on it), which is the shape the chart has to draw.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPlaywright } from "./browser.mjs";
import { ROOT, configureRepo, git, startPanel, waitFor } from "./panel-testkit.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const PANEL_ROOT = path.resolve(opt("--root", ROOT));
const SHOTS = path.resolve(opt("--shots", path.join(ROOT, "ledger", "verify", "chart-turnover-cut")));

const PROJECT = "turnover-demo";
const TURNOVER = "20261126_1800_TASK-406_the-complete-brief";
const CHECKOUT = PROJECT;
const ORPHAN = "orphan-child-cccc33";
const FIRST = "the-first-child-aaaa11";
const SECOND = "the-second-child-bbbb22";

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

const sandbox = mkdtempSync(path.join(tmpdir(), "wag-chart-turnover-cut-"));
const repos = path.join(sandbox, "repos");
const repo = path.join(repos, PROJECT);
mkdirSync(repo, { recursive: true });
git(repo, "init", "-q", "-b", "main");
writeFileSync(path.join(repo, "seed.txt"), "the container's base\n", "utf8");
git(repo, "add", "-A");
git(repo, "commit", "-qm", "seed the repository");
configureRepo(repo);
git(repo, "branch", TURNOVER, "main");
const children = {};
for (const [name, tag] of [[FIRST.replace(/-[0-9a-f]{6}$/, ""), "aaaa11"], [SECOND.replace(/-[0-9a-f]{6}$/, ""), "bbbb22"]]) {
  const branch = `wtgui/${name}-${tag}`;
  const tree = path.join(repo, ".worktrees", `${name}-${tag}`);
  git(repo, "worktree", "add", "-q", "-b", branch, tree, TURNOVER);
  children[name] = { branch, tree, tag };
}
git(repo, "worktree", "add", "-q", "-b", `wtgui/${ORPHAN}`, path.join(repo, ".worktrees", ORPHAN), TURNOVER);

const bookFile = path.join(sandbox, "branch-parents.json");
const at = new Date().toISOString();
const book = {};
for (const rec of Object.values(children)) {
  book[`tag:${rec.tag}`] = { parent: TURNOVER, branch: rec.branch, tree: rec.tree.replace(/\\/g, "/"), kind: "research", at };
}
writeFileSync(bookFile, `${JSON.stringify(book, null, 2)}\n`, "utf8");

const panel = await startPanel({
  root: PANEL_ROOT,
  dir: path.join(sandbox, "panel"),
  config: {
    scanRoots: [repos.replace(/\\/g, "/")],
    projects: [{ name: PROJECT, path: repo.replace(/\\/g, "/"), mainBranch: "main", turnoverBranches: [{ branch: TURNOVER, key: "task 406" }], turnoverPolicy: "free" }],
    branchParentsFile: bookFile,
    assistant: { enabled: false },
    worktreeSeconds: 5,
    midSeconds: 10,
    dormantSeconds: 20,
    slowSeconds: 30,
  },
});

const playwright = loadPlaywright();
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN: no Playwright install found; set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
  await panel.stop();
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(2);
}

let rows = [];
try {
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1760, height: 1000 } });
    // The reader's own fold is what draws a project's rows; the gate opens this one before the boot.
    await page.addInitScript((p) => localStorage.setItem("wm.expandedProjects", JSON.stringify([p])), PROJECT);
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((p) => Boolean(document.querySelector(`tbody[data-tbody="${p}"]`)), PROJECT, { timeout: 40_000 });
    const readRows = () =>
      page.evaluate((p) => {
        const tbody = document.querySelector(`tbody[data-tbody="${p}"]`);
        if (!tbody) return [];
        return [...tbody.children]
          .filter((el) => el.classList.contains("row"))
          .map((tr) => {
            const name = tr.querySelector("td.name .row-name");
            return {
              key: tr.dataset.key || "",
              depth: Number(tr.dataset.depth || 0),
              parentKey: tr.dataset.parentKey || null,
              ticks: tr.querySelectorAll("td.name .row-lead .child-tick").length,
              label: name ? name.textContent.trim() : "",
              kind: (tr.querySelector("td.kind") || {}).textContent?.trim() || "",
              classes: [...tr.classList],
            };
          });
      }, PROJECT);
    rows = await waitFor(async () => {
      const list = await readRows();
      // The first paint puts every row at the top level; the grouping pass that attaches the children
      // runs on the next frame, so the shape - not the row count - is what this waits for.
      const container = list.find((r) => r.classes.includes("is-turnover-container"));
      const attached = container && list.some((r) => r.depth === 1 && (r.parentKey || "").endsWith(container.key.split("::").pop()));
      return list.length >= 5 && container?.classes.includes("is-parent") && attached ? list : null;
    }, { timeoutMs: 90_000, what: "the chart to paint the checkout, the container and its children under it" });

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      const tbody = await page.$(`tbody[data-tbody="${PROJECT}"]`);
      if (tbody) await tbody.screenshot({ path: path.join(SHOTS, "chart.png") });
    }
    const errors = await page.evaluate(() => (globalThis.__pageErrors || []).slice());
    ok("the page raised no errors", errors.length === 0, JSON.stringify(errors));
  } finally {
    await browser.close();
  }
} finally {
  await panel.stop();
  rmSync(sandbox, { recursive: true, force: true });
}

const byLabel = (label) => rows.find((r) => r.label === label) || null;
const own = (r) => r.key.split("::").pop();
const tail = (key) => (key || "").split("::").pop().split("/").pop();

const container = rows.find((r) => r.classes.includes("is-turnover-container")) || null;
ok("the chart drew the checkout, the container and its children", rows.length >= 5, `${rows.length} rows`);
ok("the checkout is a top-level row", byLabel(CHECKOUT)?.depth === 0 && byLabel(CHECKOUT)?.parentKey === null, JSON.stringify(byLabel(CHECKOUT)));
ok("an unrecorded tree hangs under nobody and stays at the top level", byLabel(ORPHAN)?.depth === 0 && byLabel(ORPHAN)?.parentKey === null, JSON.stringify(byLabel(ORPHAN)));
ok("the turnover branch has a row of its own, at the top level", Boolean(container) && container.depth === 0, container ? `${container.label}` : "no is-turnover-container row");
ok("the container's kind column reads T", container?.kind === "T", container ? JSON.stringify(container.kind) : "no container");
ok("the container draws the fold a parent gets", Boolean(container?.classes.includes("is-parent")), container ? container.classes.join(" ") : "no container");
for (const label of [FIRST, SECOND]) {
  const child = byLabel(label);
  ok(`${label} hangs one indent under the container`, child?.depth === 1 && tail(child?.parentKey) === tail(container?.key), child ? `depth ${child.depth}, parent ${tail(child?.parentKey)}` : "no row");
  ok(`${label} draws one grouped-branch marker`, child?.ticks === 1, child ? `${child.ticks} marker(s)` : "no row");
}

console.log(`\nchart: ${rows.map((r) => `${"  ".repeat(r.depth)}${r.label} [depth ${r.depth}, ${r.ticks} L, kind ${r.kind || "-"}]`).join(" · ")}`);
console.log(`panel root: ${PANEL_ROOT}`);
console.log(failures ? `RESULT: FAIL ${failures} of ${checks}` : `RESULT: PASS ${checks} checks`);
process.exit(failures ? 1 : 0);
